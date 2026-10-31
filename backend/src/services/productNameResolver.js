const { query } = require('../../db');
const { getSchema, findColumnDef } = require('./sheetSchemaService');

/**
 * Deterministic, catalog-driven product/item name resolution.
 *
 * Resolves product/item name filters produced by the interpreter against the business's
 * live catalog before SQL is built:
 *   1. Normalized exact match (case-, punctuation-, and trailing-period-insensitive)
 *   2. Unique token containment (all words the user typed appear in exactly one product
 *      name, or exactly one full product name appears inside what the user typed)
 *   3. Otherwise → clarification with real "did you mean" suggestions computed from the
 *      business's catalog (never from hardcoded data).
 */

const NAME_EQUALITY_OPERATORS = new Set(['equals', 'not_equals']);
const NAME_SUBSTRING_OPERATORS = new Set(['contains', 'not_contains', 'starts_with', 'ends_with']);

/**
 * Normalizes a product/item name for comparison.
 *
 * @param {string} value
 * @returns {string}
 */
function normalizeProductName(value) {
  return String(value ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/['\u2018\u2019\u02bc`]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/**
 * @param {string} normalized
 * @returns {string[]}
 */
function tokenize(normalized) {
  return normalized ? normalized.split(' ').filter(Boolean) : [];
}

/**
 * Character-bigram Dice similarity (0..1) on normalized strings.
 */
function diceSimilarity(a, b) {
  const x = a.replace(/\s+/g, '');
  const y = b.replace(/\s+/g, '');
  if (!x.length || !y.length) return 0;
  if (x === y) return 1;
  if (x.length < 2 || y.length < 2) return 0;
  const bigrams = new Map();
  for (let i = 0; i < x.length - 1; i += 1) {
    const bg = x.slice(i, i + 2);
    bigrams.set(bg, (bigrams.get(bg) || 0) + 1);
  }
  let overlap = 0;
  for (let i = 0; i < y.length - 1; i += 1) {
    const bg = y.slice(i, i + 2);
    const count = bigrams.get(bg) || 0;
    if (count > 0) {
      bigrams.set(bg, count - 1);
      overlap += 1;
    }
  }
  return (2 * overlap) / (x.length - 1 + (y.length - 1));
}

/**
 * Loads distinct product/item names (and category/brand) for a business.
 *
 * @param {string} businessId
 * @param {string} [entity='products']
 * @returns {Promise<Array<{ name: string, category: string | null }>>}
 */
async function loadCatalogNames(businessId, entity = 'products') {
  const schema = getSchema(entity);
  const nameColDef =
    schema.columns.name ||
    schema.columns.product_name ||
    schema.columns.product_model ||
    schema.columns.item_name ||
    schema.columns.title ||
    schema.columns.model ||
    Object.values(schema.columns).find(
      (c) => c.modifiable && c.type === 'string' && /name|model|item|title/i.test(c.exactName)
    ) ||
    Object.values(schema.columns).find((c) => c.modifiable && c.type === 'string');

  if (!nameColDef) return [];
  const exactNameCol = nameColDef.exactName || 'name';

  const catColDef =
    schema.columns.category ||
    schema.columns.brand_name ||
    schema.columns.vendor ||
    schema.columns.supplier ||
    Object.values(schema.columns).find(
      (c) =>
        c.modifiable &&
        c.type === 'string' &&
        /category|brand|vendor|supplier/i.test(c.exactName)
    );
  const exactCatCol = catColDef ? catColDef.exactName : null;

  const selectCols = exactCatCol
    ? `"${exactNameCol}", "${exactCatCol}"`
    : `"${exactNameCol}"`;

  try {
    const safeTableName = String(schema.tableName || 'products').replace(/[^a-z0-9_]/gi, '_');
    const result = await query(
      `SELECT ${selectCols} FROM "${safeTableName}" WHERE business_id = $1 ORDER BY "${exactNameCol}" ASC;`,
      [businessId]
    );
    return result.rows.map((r) => ({
      name: r[exactNameCol] ?? r[exactNameCol.toLowerCase()] ?? r.name,
      category: exactCatCol
        ? (r[exactCatCol] ?? r[exactCatCol.toLowerCase()] ?? r.category ?? null)
        : null,
    }));
  } catch {
    return [];
  }
}

/**
 * Builds a reusable index over catalog names.
 *
 * @param {Array<{ name: string }>} catalog
 */
function buildNameIndex(catalog) {
  const entries = [];
  const seen = new Set();
  for (const item of catalog || []) {
    const name = item?.name;
    if (typeof name !== 'string' || !name.trim() || seen.has(name)) continue;
    seen.add(name);
    const normalized = normalizeProductName(name);
    entries.push({ name, normalized, tokens: new Set(tokenize(normalized)) });
  }
  return entries;
}

/**
 * Returns up to `limit` closest catalog names for suggestions.
 */
function suggestNames(index, rawValue, limit = 3) {
  const normalized = normalizeProductName(rawValue);
  const queryTokens = tokenize(normalized);
  return index
    .map((e) => {
      const tokenHits = queryTokens.filter((t) => e.tokens.has(t)).length;
      const tokenScore = queryTokens.length ? tokenHits / queryTokens.length : 0;
      return { name: e.name, score: 0.6 * diceSimilarity(normalized, e.normalized) + 0.4 * tokenScore };
    })
    .filter((s) => s.score > 0.3)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => s.name);
}

/**
 * Resolves a user/LLM-provided product name to the exact stored catalog name(s).
 *
 * @param {Array} index - result of buildNameIndex
 * @param {string} rawValue
 * @returns {{ status: 'resolved', names: string[], strategy: string }
 *          | { status: 'ambiguous', candidates: string[] }
 *          | { status: 'not_found', suggestions: string[] }}
 */
function resolveProductName(index, rawValue) {
  const rawClean = String(rawValue ?? '').trim();
  if (!rawClean) {
    return { status: 'not_found', suggestions: [] };
  }

  // 1. Byte-for-byte exact match
  const byteExact = index.find((e) => e.name === rawClean);
  if (byteExact) {
    return { status: 'resolved', names: [byteExact.name], strategy: 'exact' };
  }

  // 2. Normalized exact match
  const normQuery = normalizeProductName(rawClean);
  const normExact = index.filter((e) => e.normalized === normQuery);
  if (normExact.length === 1) {
    return { status: 'resolved', names: [normExact[0].name], strategy: 'normalized_exact' };
  }
  if (normExact.length > 1) {
    return { status: 'ambiguous', candidates: normExact.map((e) => e.name) };
  }

  // 3. Normalized containment (query inside catalog name or vice-versa)
  const queryTokens = tokenize(normQuery);
  const substringMatches = index.filter(
    (e) => e.normalized.includes(normQuery) || (normQuery.length >= 4 && normQuery.includes(e.normalized))
  );

  if (substringMatches.length === 1) {
    return { status: 'resolved', names: [substringMatches[0].name], strategy: 'normalized_substring' };
  }

  // 4. Token subset matching (e.g. "Granular Texture Turtleneck Shirt" vs "Granular Texture Turtleneck Shirt for Men")
  if (queryTokens.length >= 2) {
    const tokenSubsetMatches = index.filter((e) => {
      const matchCount = queryTokens.filter((t) => e.tokens.has(t)).length;
      return matchCount === queryTokens.length || (e.tokens.size >= 2 && matchCount === e.tokens.size);
    });
    if (tokenSubsetMatches.length === 1) {
      return { status: 'resolved', names: [tokenSubsetMatches[0].name], strategy: 'token_subset' };
    }
    if (tokenSubsetMatches.length > 1) {
      const suggestions = suggestNames(index, rawClean, 3);
      return { status: 'ambiguous', candidates: tokenSubsetMatches.map((e) => e.name), suggestions };
    }
  }

  if (substringMatches.length > 1) {
    const suggestions = suggestNames(index, rawClean, 3);
    return { status: 'ambiguous', candidates: substringMatches.map((e) => e.name), suggestions };
  }

  const suggestions = suggestNames(index, rawClean, 3);
  return { status: 'not_found', suggestions };
}

/**
 * Resolves name filters produced by the LLM against the business's live catalog.
 *
 * @param {object} params
 * @param {string} params.businessId
 * @param {Array<object>} params.filters
 * @param {string} [params.entity='products']
 * @param {Array} [params.catalog]
 * @returns {Promise<{ status: 'ok', filters: Array, resolutions: Array }
 *                  | { status: 'clarification_needed', message: string, suggestions: string[] }>}
 */
async function resolveNameFilters({ businessId, filters, entity = 'products', catalog }) {
  const list = Array.isArray(filters) ? filters : [];
  const schema = getSchema(entity);

  // Identify if any filter targets a name-like column
  const nameColDef =
    schema.columns.name ||
    schema.columns.product_name ||
    schema.columns.item_name ||
    schema.columns.title;
  const exactNameCol = nameColDef ? nameColDef.exactName || 'name' : null;

  const hasNameFilter = list.some((f) => {
    if (!f || typeof f.value !== 'string') return false;
    const fLower = String(f.field || '').toLowerCase();
    return (
      fLower === 'name' ||
      fLower === 'product_name' ||
      fLower === 'item_name' ||
      (exactNameCol && fLower === exactNameCol.toLowerCase())
    );
  });

  if (!hasNameFilter) {
    return { status: 'ok', filters: list, resolutions: [] };
  }

  const catalogRows = catalog || (await loadCatalogNames(businessId, entity));
  const index = buildNameIndex(catalogRows);

  // If no catalog names in DB for this business/table, keep filters verbatim
  if (index.length === 0) {
    return { status: 'ok', filters: list, resolutions: [] };
  }

  const resolvedFilters = [];
  const resolutions = [];

  for (const filter of list) {
    const fieldLower = String(filter?.field || '').toLowerCase();
    const isTargetNameCol =
      fieldLower === 'name' ||
      fieldLower === 'product_name' ||
      fieldLower === 'item_name' ||
      (exactNameCol && fieldLower === exactNameCol.toLowerCase());

    if (!isTargetNameCol || typeof filter.value !== 'string') {
      resolvedFilters.push(filter);
      continue;
    }

    const targetFieldName = exactNameCol || filter.field;
    const operator = filter.operator;

    if (NAME_EQUALITY_OPERATORS.has(operator)) {
      const outcome = resolveProductName(index, filter.value);
      if (outcome.status === 'resolved') {
        resolutions.push({ requested: filter.value, resolved: outcome.names, strategy: outcome.strategy });
        if (outcome.names.length === 1) {
          resolvedFilters.push({ ...filter, field: targetFieldName, value: outcome.names[0] });
        } else if (operator === 'equals') {
          resolvedFilters.push({ field: targetFieldName, operator: 'in', value: outcome.names });
        } else {
          for (const n of outcome.names) {
            resolvedFilters.push({ field: targetFieldName, operator: 'not_equals', value: n });
          }
        }
        continue;
      }

      if (operator === 'not_equals') {
        resolvedFilters.push({ ...filter, field: targetFieldName });
        continue;
      }

      if (outcome.status === 'ambiguous') {
        return {
          status: 'clarification_needed',
          message: `The name "${filter.value}" matches multiple records: ${outcome.candidates
            .map((c) => `"${c}"`)
            .join(', ')}. Which one did you mean?`,
          suggestions: outcome.candidates,
        };
      }

      const suggestionText = outcome.suggestions.length
        ? ` Did you mean ${outcome.suggestions.map((s) => `"${s}"`).join(' or ')}?`
        : '';
      return {
        status: 'clarification_needed',
        message: `No record matching "${filter.value}" exists in this catalog.${suggestionText}`,
        suggestions: outcome.suggestions,
      };
    }

    if (NAME_SUBSTRING_OPERATORS.has(operator)) {
      const needle = normalizeProductName(filter.value);
      if (!needle) {
        resolvedFilters.push({ ...filter, field: targetFieldName });
        continue;
      }
      const test = (e) => {
        if (operator === 'starts_with') return e.normalized.startsWith(needle);
        if (operator === 'ends_with') return e.normalized.endsWith(needle);
        return e.normalized.includes(needle);
      };
      const matched = index.filter(test).map((e) => e.name);

      if (operator === 'not_contains') {
        if (matched.length === 0) {
          resolvedFilters.push({ ...filter, field: targetFieldName });
        } else {
          for (const n of matched) {
            resolvedFilters.push({ field: targetFieldName, operator: 'not_equals', value: n });
          }
        }
        continue;
      }

      if (matched.length > 0) {
        resolutions.push({ requested: filter.value, resolved: matched, strategy: `normalized_${operator}` });
        resolvedFilters.push(
          matched.length === 1
            ? { field: targetFieldName, operator: 'equals', value: matched[0] }
            : { field: targetFieldName, operator: 'in', value: matched }
        );
      } else {
        resolvedFilters.push({ ...filter, field: targetFieldName });
      }
      continue;
    }

    resolvedFilters.push({ ...filter, field: targetFieldName });
  }

  return { status: 'ok', filters: resolvedFilters, resolutions };
}

module.exports = {
  normalizeProductName,
  loadCatalogNames,
  buildNameIndex,
  resolveProductName,
  resolveNameFilters,
};
