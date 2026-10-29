const { query } = require('../../db');
const { getSchema } = require('./sheetSchemaService');

/**
 * Deterministic, catalog-driven product name resolution.
 *
 * Product names are arbitrary user data (any language, punctuation, casing, trailing
 * periods, apostrophes, hyphens, etc.). Neither the LLM nor the SQL layer should require
 * the user to type a name byte-for-byte. This module resolves `name` filters produced by
 * the interpreter against the business's live catalog before SQL is built:
 *
 *   1. Normalized exact match  (case-, punctuation-, and trailing-period-insensitive)
 *   2. Unique token containment (all words the user typed appear in exactly one product
 *                               name, or exactly one full product name appears inside
 *                               what the user typed)
 *   3. Otherwise → clarification with real "did you mean" suggestions computed from the
 *      business's catalog (never from hardcoded data).
 *
 * No product names are hardcoded anywhere in this module.
 */

const NAME_EQUALITY_OPERATORS = new Set(['equals', 'not_equals']);
const NAME_SUBSTRING_OPERATORS = new Set(['contains', 'not_contains', 'starts_with', 'ends_with']);

/**
 * Normalizes a product name for comparison: Unicode-folds, lowercases, strips diacritics,
 * removes apostrophes (so "Men's" == "Mens"), converts any other punctuation to spaces,
 * and collapses whitespace.
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
 * Character-bigram Dice similarity (0..1) on normalized strings, used only to rank
 * "did you mean" suggestions.
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
 * Loads the distinct product names (and categories) for a business.
 *
 * @param {string} businessId
 * @param {string} [entity='products']
 * @returns {Promise<Array<{ name: string, category: string | null }>>}
 */
async function loadCatalogNames(businessId, entity = 'products') {
  const schema = getSchema(entity);
  const result = await query(
    `SELECT name, category FROM ${schema.tableName} WHERE business_id = $1 ORDER BY name ASC;`,
    [businessId]
  );
  return result.rows.map((r) => ({
    name: r.name,
    category: r.category ?? null,
  }));
}

/**
 * Builds a reusable index over catalog names.
 *
 * @param {Array<{ name: string }>} catalog
 */
function buildNameIndex(catalog) {
  const entries = [];
  const seen = new Set();
  for (const item of catalog) {
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
  const normalized = normalizeProductName(rawValue);
  if (!normalized) {
    return { status: 'not_found', suggestions: [] };
  }

  // 1. Normalized exact match (punctuation / case / whitespace / apostrophe insensitive)
  const exact = index.filter((e) => e.normalized === normalized);
  if (exact.length > 0) {
    return { status: 'resolved', names: exact.map((e) => e.name), strategy: 'normalized_exact' };
  }

  const queryTokens = tokenize(normalized);

  // 2a. Every word the user typed appears in the product name (user typed a shorter form)
  const userSubsetOfProduct = index.filter((e) => queryTokens.every((t) => e.tokens.has(t)));
  if (userSubsetOfProduct.length === 1) {
    return { status: 'resolved', names: [userSubsetOfProduct[0].name], strategy: 'token_subset' };
  }

  // 2b. The full product name appears inside what the user typed (user added extra words).
  //     Prefer the longest such product name so "X Shirt for Men" beats "X Shirt".
  const productInsideUser = index
    .filter((e) => e.tokens.size > 0 && [...e.tokens].every((t) => queryTokens.includes(t)))
    .sort((a, b) => b.tokens.size - a.tokens.size);
  if (
    productInsideUser.length === 1 ||
    (productInsideUser.length > 1 && productInsideUser[0].tokens.size > productInsideUser[1].tokens.size)
  ) {
    return { status: 'resolved', names: [productInsideUser[0].name], strategy: 'token_superset' };
  }

  if (userSubsetOfProduct.length > 1) {
    return { status: 'ambiguous', candidates: userSubsetOfProduct.map((e) => e.name).slice(0, 8) };
  }

  return { status: 'not_found', suggestions: suggestNames(index, rawValue) };
}

/**
 * Resolves all `name` filters in a filter list against the business's live catalog.
 *
 * - equals / not_equals: replaced with the exact stored name (or `in` / `not_in`-style
 *   expansion if several stored names normalize identically).
 * - contains / starts_with / ends_with / not_contains: evaluated with normalized matching
 *   and rewritten to an exact `in` list of stored names when that finds matches the raw
 *   SQL ILIKE would miss because of punctuation differences.
 *
 * @param {object} params
 * @param {string} params.businessId
 * @param {Array<{ field: string, operator: string, value: any }>} params.filters
 * @param {string} [params.entity='products']
 * @param {Array} [params.catalog] - optional preloaded catalog (for tests/batching)
 * @returns {Promise<{ status: 'ok', filters: Array, resolutions: Array }
 *                  | { status: 'clarification_needed', message: string, suggestions: string[] }>}
 */
async function resolveNameFilters({ businessId, filters, entity = 'products', catalog }) {
  const list = Array.isArray(filters) ? filters : [];
  const hasNameFilter = list.some(
    (f) => f && String(f.field || '').toLowerCase() === 'name' && typeof f.value === 'string'
  );
  if (!hasNameFilter) {
    return { status: 'ok', filters: list, resolutions: [] };
  }

  const index = buildNameIndex(catalog || (await loadCatalogNames(businessId, entity)));
  const resolvedFilters = [];
  const resolutions = [];

  for (const filter of list) {
    const field = String(filter?.field || '').toLowerCase();
    if (field !== 'name' || typeof filter.value !== 'string') {
      resolvedFilters.push(filter);
      continue;
    }

    const operator = filter.operator;

    if (NAME_EQUALITY_OPERATORS.has(operator)) {
      const outcome = resolveProductName(index, filter.value);
      if (outcome.status === 'resolved') {
        resolutions.push({ requested: filter.value, resolved: outcome.names, strategy: outcome.strategy });
        if (outcome.names.length === 1) {
          resolvedFilters.push({ ...filter, value: outcome.names[0] });
        } else if (operator === 'equals') {
          resolvedFilters.push({ field: 'name', operator: 'in', value: outcome.names });
        } else {
          for (const n of outcome.names) {
            resolvedFilters.push({ field: 'name', operator: 'not_equals', value: n });
          }
        }
        continue;
      }

      if (operator === 'not_equals') {
        // Excluding a product that does not exist excludes nothing; keep the filter as-is.
        resolvedFilters.push(filter);
        continue;
      }

      if (outcome.status === 'ambiguous') {
        return {
          status: 'clarification_needed',
          message: `The product name "${filter.value}" matches multiple products: ${outcome.candidates
            .map((c) => `"${c}"`)
            .join(', ')}. Which product did you mean?`,
          suggestions: outcome.candidates,
        };
      }

      const suggestionText = outcome.suggestions.length
        ? ` Did you mean ${outcome.suggestions.map((s) => `"${s}"`).join(' or ')}?`
        : '';
      return {
        status: 'clarification_needed',
        message: `No product named "${filter.value}" exists in this business's catalog.${suggestionText}`,
        suggestions: outcome.suggestions,
      };
    }

    if (NAME_SUBSTRING_OPERATORS.has(operator)) {
      const needle = normalizeProductName(filter.value);
      if (!needle) {
        resolvedFilters.push(filter);
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
          resolvedFilters.push(filter);
        } else {
          for (const n of matched) {
            resolvedFilters.push({ field: 'name', operator: 'not_equals', value: n });
          }
        }
        continue;
      }

      if (matched.length > 0) {
        resolutions.push({ requested: filter.value, resolved: matched, strategy: `normalized_${operator}` });
        resolvedFilters.push(
          matched.length === 1
            ? { field: 'name', operator: 'equals', value: matched[0] }
            : { field: 'name', operator: 'in', value: matched }
        );
      } else {
        resolvedFilters.push(filter);
      }
      continue;
    }

    resolvedFilters.push(filter);
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
