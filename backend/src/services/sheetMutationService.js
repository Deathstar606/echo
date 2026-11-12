const crypto = require('node:crypto');
const { withTransaction, query } = require('../../db');
const {
  getSchema,
  discoverTableSchema,
  ensureTableExists,
  findColumnDef,
  quoteIdentifier,
  validateFilter,
  validateMutation,
} = require('./sheetSchemaService');
const {
  normalizeConversationHistory,
  getLatestActiveContext,
  hasFollowUpReference,
  hasExplicitScopeReset,
  resolveIdentifierFilterForIds,
} = require('../utils/conversationHistory');
const {
  buildParameterizedSelectQuery,
  normalizeProductRow,
} = require('./sheetQueryService');
const { resolveNameFilters } = require('./catalogNameResolver');
const AppError = require('../utils/AppError');
const {
  refreshWorkspaceTableMetadata,
} = require('./workspaceTableMetadataService');

/**
 * Resolves product/item name target filters of a validated mutation against the business's
 * live catalog.
 *
 * @param {object} validated - Output of validateMutation
 * @param {string} businessId
 * @param {object} schema
 * @returns {Promise<{ validated: object, name_resolutions: Array } | { clarification: object }>}
 */
async function resolveMutationTargetNames(validated, businessId, schema) {
  const resolution = await resolveNameFilters({
    businessId,
    entity: schema.entity,
    filters: validated.target_filters,
  });

  if (resolution.status === 'clarification_needed') {
    return {
      clarification: {
        status: 'clarification_needed',
        message: resolution.message,
        suggestions: resolution.suggestions,
        entity: schema.entity,
        operation: null,
        affected_count: 0,
        target_rows: [],
      },
    };
  }

  return {
    validated: { ...validated, target_filters: resolution.filters },
    name_resolutions: resolution.resolutions,
  };
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function hasExplicitWholeTableScope(prompt, schema) {
  const normalizedPrompt = String(prompt || '')
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const collectionPattern =
    /\b(?:all|every|each)\s+(?:of\s+)?(?:the\s+)?(?:rows?|records?|entries|items?|products?|orders?|customers?|accounts?)\b|\b(?:the\s+)?(?:entire|whole)\s+(?:table|sheet|dataset|inventory)\b/i;
  const allRowsInTablePattern =
    /\b(?:all|every|each)\s+(?:of\s+)?(?:the\s+)?(?:rows?|records?|entries|items?)\s+in\s+(?:(?:the|this|current)\s+)?(?:entire\s+|whole\s+)?(?:table|sheet|dataset|inventory)\b/i;
  if (!normalizedPrompt) return false;
  if (allRowsInTablePattern.test(normalizedPrompt)) return true;
  const entityNames = [
    schema.tableName,
    schema.entity,
    schema.displayName,
  ]
    .filter(Boolean)
    .map((name) =>
      String(name)
        .toLowerCase()
        .replace(/[_-]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
    )
    .filter((name, index, names) => name && names.indexOf(name) === index);

  const candidates = [
    ...entityNames,
    ...entityNames
      .map((name) => name.replace(/\b(?:inventory|dataset|table|sheet)\b/g, '').trim())
      .filter(Boolean),
  ].filter((name, index, names) => name && names.indexOf(name) === index);

  for (const name of candidates) {
    const match = new RegExp(
      `\\b(?:all|every|each)\\s+(?:of\\s+)?(?:the\\s+)?${escapeRegExp(name)}\\b`,
      'i'
    ).exec(normalizedPrompt);
    if (!match) continue;

    const remainder = normalizedPrompt.slice(match.index + match[0].length);
    if (
      /^\s+in\s+(?:(?:the|this|current)\s+)?(?:entire\s+|whole\s+)?(?:table|sheet|dataset|inventory)\b/i.test(
        remainder
      )
    ) {
      return true;
    }
    if (
      !/^\s+(?:with|where|from|in|whose|that|which|matching|having|priced|costing|under|over|above|below|not)\b/i.test(
        remainder
      )
    ) {
      return true;
    }
  }

  const genericMatch = collectionPattern.exec(normalizedPrompt);
  if (!genericMatch) return false;
  const remainder = normalizedPrompt.slice(
    genericMatch.index + genericMatch[0].length
  );
  return !/^\s+(?:with|where|from|in|whose|that|which|matching|having|priced|costing|under|over|above|below|not)\b/i.test(
    remainder
  );
}

function getMutationScopeClarification(validated, sourcePrompt, schema) {
  if (
    typeof sourcePrompt !== 'string' ||
    !sourcePrompt.trim() ||
    !['update', 'update_many', 'delete'].includes(validated.operation) ||
    validated.target_filters.length > 0 ||
    !validated.match_all ||
    hasExplicitWholeTableScope(sourcePrompt, schema)
  ) {
    return null;
  }

  return {
    status: 'clarification_needed',
    message:
      `I cannot safely preview this change because it targets every row in "${schema.displayName || schema.tableName}", but your request does not clearly ask for a whole-table operation. Specify which records to change, or explicitly say to apply it to all rows in this table.`,
    entity: schema.entity,
    operation: null,
    affected_count: 0,
    target_rows: [],
  };
}

/**
 * Evaluates a validated list of update transformations against a single normalized row
 * according to the active table schema.
 *
 * @param {object} row - Normalized row
 * @param {Array<object>} validatedUpdates - Validated transformation objects
 * @param {object} schema - Active table schema definition
 * @returns {{ id: string, name: string, before: object, after: object, changes: object, updatedRow: object }}
 */
function computeRowUpdates(row, validatedUpdates, schema) {
  const normalizedRow = normalizeProductRow(row, schema);
  const nextRow = { ...normalizedRow };
  const before = {};
  const after = {};
  const changes = {};
  const originalMaps = new Map();

  const rowName =
    normalizedRow.name ||
    normalizedRow.Product_Name ||
    normalizedRow.product_name ||
    normalizedRow.Product_Model ||
    normalizedRow.product_model ||
    normalizedRow.Item_Name ||
    normalizedRow.item_name ||
    normalizedRow.title ||
    normalizedRow.Model ||
    normalizedRow.model ||
    normalizedRow.id;

  const parsedMaps = new Map();

  for (const u of validatedUpdates) {
    const nestedField = u.nested_field || (u.size_key ? 'size' : null);
    if (nestedField) {
      const mapMatch = findColumnDef(schema, nestedField);
      if (!mapMatch) {
        throw new AppError(`Nested map column "${nestedField}" no longer exists.`, 400);
      }
      const exactMapField = mapMatch.exactName;
      const originalMap = normalizedRow[exactMapField] ?? normalizedRow[nestedField];
      let mapValue = parsedMaps.get(exactMapField);
      if (!mapValue) {
        let parsed;
        if (originalMap === null || originalMap === undefined || originalMap === '') {
          parsed = {};
        } else if (typeof originalMap === 'string') {
          try {
            parsed = JSON.parse(originalMap);
          } catch {
            throw new AppError(
              `Cannot modify "${exactMapField}" on item "${rowName}" because its stored value is not valid JSON.`,
              400
            );
          }
        } else {
          parsed = originalMap;
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new AppError(
            `Cannot modify "${exactMapField}" on item "${rowName}" because its stored value is not a JSON object.`,
            400
          );
        }
        mapValue = { ...parsed };
        originalMaps.set(exactMapField, { ...parsed });
        parsedMaps.set(exactMapField, mapValue);
      }

      const existingValuesOperation = u.action.endsWith('_existing_values');
      const baseAction = existingValuesOperation
        ? u.action.replace(/_existing_values$/, '').replace(/_to$/, '')
        : u.action;
      const keys = existingValuesOperation
        ? Object.keys(mapValue)
        : [u.nested_key || u.size_key];
      const updatedEntries = [];

      for (const rawKey of keys) {
        const key = existingValuesOperation
          ? rawKey
          : Object.keys(mapValue).find(
              (candidate) =>
                candidate === rawKey ||
                (exactMapField.toLowerCase() === 'size' &&
                  candidate.toUpperCase() === String(rawKey).toUpperCase())
            ) || rawKey;
        const keyExists = Object.prototype.hasOwnProperty.call(mapValue, key);
        if (!keyExists && (existingValuesOperation || u.key_policy === 'existing_keys_only')) {
          continue;
        }

        const currentValue = keyExists ? mapValue[key] : 0;
        const currentNumber =
          typeof currentValue === 'number' ||
          (typeof currentValue === 'string' && currentValue.trim() !== '')
            ? Number(currentValue)
            : Number.NaN;
        if (keyExists && !Number.isFinite(currentNumber)) {
          if (existingValuesOperation) continue;
          throw new AppError(
            `Cannot modify "${exactMapField}.${key}" on item "${rowName}" because its value is not numeric.`,
            400
          );
        }
        const current = keyExists ? currentNumber : 0;
        let proposed = current;
        if (baseAction === 'set') {
          proposed = u.value;
        } else if (baseAction === 'add') {
          proposed =
            u.unit === 'percentage'
              ? current * (1 + u.value / 100)
              : current + u.value;
        } else if (baseAction === 'subtract') {
          proposed =
            u.unit === 'percentage'
              ? current * (1 - u.value / 100)
              : current - u.value;
        } else if (baseAction === 'multiply') {
          proposed = current * u.value;
        }
        proposed =
          mapMatch.colDef.nestedValueType === 'integer'
            ? Math.round(proposed)
            : Number(proposed.toFixed(2));
        if (!Number.isFinite(proposed) || proposed < 0) {
          throw new AppError(
            `Value for "${exactMapField}.${key}" on item "${rowName}" cannot become negative or non-numeric.`,
            400
          );
        }
        mapValue[key] = proposed;
        updatedEntries.push({
          key,
          current: keyExists ? currentValue : undefined,
          proposed,
        });
      }

      const nextMapValue =
        typeof originalMap === 'string' ? JSON.stringify(mapValue) : mapValue;
      nextRow[exactMapField] = nextMapValue;
      if (exactMapField !== nestedField) nextRow[nestedField] = nextMapValue;

      if (existingValuesOperation) {
        if (!Object.prototype.hasOwnProperty.call(before, exactMapField)) {
          before[exactMapField] = originalMap;
        }
        after[exactMapField] = nextMapValue;
        changes[exactMapField] = { current: originalMap, proposed: nextMapValue };
      } else {
        const entry = updatedEntries[0];
        if (entry) {
          const nestedName = `${exactMapField}.${entry.key}`;
          if (!Object.prototype.hasOwnProperty.call(before, nestedName)) {
            const originalMapValue = originalMaps.get(exactMapField) || {};
            const originalKey = Object.keys(originalMapValue).find(
              (candidate) =>
                candidate === entry.key ||
                (exactMapField.toLowerCase() === 'size' &&
                  candidate.toUpperCase() === entry.key.toUpperCase())
            );
            before[nestedName] =
              originalKey === undefined ? undefined : originalMapValue[originalKey];
          }
          after[nestedName] = entry.proposed;
          changes[nestedName] = {
            current: before[nestedName],
            proposed: entry.proposed,
          };
        }
        if (!Object.prototype.hasOwnProperty.call(before, exactMapField)) {
          before[exactMapField] = originalMap;
        }
        after[exactMapField] = nextMapValue;
        changes[exactMapField] = { current: originalMap, proposed: nextMapValue };
      }
      continue;
    }

    // 2. Standard column transformation
    const colName = u.field;
    const match = findColumnDef(schema, colName);
    const colDef = match ? match.colDef : { type: 'string' };
    const exactCol = match ? match.exactName : colName;

    const currentVal =
      nextRow[exactCol] !== undefined
        ? nextRow[exactCol]
        : (nextRow[colName] !== undefined ? nextRow[colName] : nextRow[exactCol.toLowerCase()]);

    let proposedVal = currentVal;

    if (u.action === 'set') {
      proposedVal = u.value;
    } else {
      const baseNum = Number(currentVal ?? 0);
      if (!Number.isFinite(baseNum)) {
        throw new AppError(
          `Cannot perform arithmetic "${u.action}" on "${exactCol}" for item "${rowName}" because current value is not numeric.`,
          400
        );
      }

      let rawResult = baseNum;
      if (u.action === 'add') {
        rawResult =
          u.unit === 'percentage'
            ? baseNum * (1 + u.value / 100)
            : baseNum + u.value;
      } else if (u.action === 'subtract') {
        rawResult =
          u.unit === 'percentage'
            ? baseNum * (1 - u.value / 100)
            : baseNum - u.value;
      } else if (u.action === 'multiply') {
        rawResult = baseNum * u.value;
      }

      if (!Number.isFinite(rawResult)) {
        throw new AppError(
          `Arithmetic operation "${u.action}" on "${exactCol}" produced an invalid number.`,
          400
        );
      }

      proposedVal =
        colDef.type === 'integer'
          ? Math.round(rawResult)
          : Number(rawResult.toFixed(2));
    }

    if (colDef.type === 'number' || colDef.type === 'integer') {
      if (colDef.min !== undefined && proposedVal < colDef.min) {
        throw new AppError(
          `Invalid ${exactCol} transformation on item "${rowName}": resulting ${exactCol} would be ${proposedVal}, which is below minimum allowed value ${colDef.min}.`,
          400
        );
      }
      if (colDef.max !== undefined && proposedVal > colDef.max) {
        throw new AppError(
          `Invalid ${exactCol} transformation on item "${rowName}": resulting ${exactCol} would be ${proposedVal}, which exceeds maximum allowed value ${colDef.max}.`,
          400
        );
      }
    }

    nextRow[exactCol] = proposedVal;
    if (colName !== exactCol) {
      nextRow[colName] = proposedVal;
    }
    before[exactCol] = currentVal;
    after[exactCol] = proposedVal;
    changes[exactCol] = {
      current: currentVal,
      proposed: proposedVal,
    };
  }

  return {
    id: normalizedRow.id,
    name: rowName,
    before,
    after,
    changes,
    updatedRow: nextRow,
  };
}

/**
 * Computes a deterministic SHA-256 preview hash over the target rows and their before/after values
 * so stale previews can be detected on confirmation.
 *
 * @param {Array<object>} diffPreview
 * @returns {string}
 */
function resolveDisplayRowName(row, fallback = 'Record') {
  if (!row || typeof row !== 'object') return fallback;
  return (
    row.name ||
    row.Product_Name ||
    row.product_name ||
    row.Product_Model ||
    row.product_model ||
    row.Item_Name ||
    row.item_name ||
    row.Service_Name ||
    row.service_name ||
    row.Cake_Name ||
    row.cake_name ||
    row.title ||
    row.Model ||
    row.model ||
    row.id ||
    fallback
  );
}

function buildCreateDiffPreview(rowsToInsert) {
  return rowsToInsert.map((rowObj, idx) => {
    const changes = {};
    for (const [k, v] of Object.entries(rowObj)) {
      changes[k] = {
        current: null,
        proposed: v,
        before: null,
        after: v,
      };
    }
    return {
      id: `new-row-${idx + 1}`,
      name: String(resolveDisplayRowName(rowObj, `New Row ${idx + 1}`)),
      before: {},
      after: { ...rowObj },
      changes,
    };
  });
}

function createApprovedMutation(validated) {
  const approved = {
    entity: validated.entity,
    operation: validated.operation,
    filter_logic: validated.filter_logic,
    match_all: validated.match_all,
    target_filters: validated.target_filters,
    updates: validated.updates,
  };
  if (validated.operation === 'create') {
    approved.changes = validated.changes;
    if (Array.isArray(validated.rows) && validated.rows.length > 0) {
      approved.rows = validated.rows;
    }
  }
  return approved;
}

function computePreviewHash(diffPreview, validatedMutation = null) {
  const canonical = [...diffPreview]
    .sort((a, b) => String(a.id).localeCompare(String(b.id)))
    .map((d) => ({
      id: d.id,
      before: d.before,
      after: d.after,
    }));
  const plan = validatedMutation
    ? {
        operation: validatedMutation.operation,
        filter_logic: validatedMutation.filter_logic,
        match_all: validatedMutation.match_all,
        target_filters: validatedMutation.target_filters,
        updates: validatedMutation.updates,
        changes: validatedMutation.operation === 'create' ? validatedMutation.changes : undefined,
        rows: validatedMutation.operation === 'create' ? validatedMutation.rows : undefined,
      }
    : null;
  return crypto
    .createHash('sha256')
    .update(JSON.stringify({ rows: canonical, plan }))
    .digest('hex');
}

/**
 * Builds the parameterized SQL UPDATE statement for validated transformations across any schema.
 *
 * @param {object} params
 * @param {object} params.schema
 * @param {string} params.businessId
 * @param {string[]} params.targetIds
 * @param {Array<object>} params.validatedUpdates
 * @param {Array<object>} params.diffPreview
 * @returns {{ updateSql: string, updateParams: any[] }}
 */
function buildParameterizedUpdateStatement({
  schema,
  businessId,
  targetIds,
  validatedUpdates,
  diffPreview,
}) {
  const setClauses = [];
  const updateParams = [businessId, targetIds];

  const nestedUpdates = validatedUpdates.filter((u) => Boolean(u.nested_field || u.size_key));
  const nonSizeUpdates = validatedUpdates.filter((u) => !u.nested_field && !u.size_key);

  const colOccurrences = new Map();
  for (const u of nonSizeUpdates) {
    colOccurrences.set(u.field, (colOccurrences.get(u.field) || 0) + 1);
  }

  const processedCols = new Set();

  for (const u of nonSizeUpdates) {
    const col = u.field;
    if (processedCols.has(col)) continue;
    processedCols.add(col);

    if (
      colOccurrences.get(col) > 1 ||
      nestedUpdates.some((u) => (u.nested_field || 'size') === col)
    ) {
      continue;
    }

    const match = findColumnDef(schema, col);
    const colDef = match ? match.colDef : { type: 'string' };
    const exactCol = match ? match.exactName : col;
    const colSql = quoteIdentifier(exactCol);

    updateParams.push(u.value);
    const paramRef = `$${updateParams.length}`;

    if (u.action === 'set') {
      setClauses.push(`${colSql} = ${paramRef}`);
    } else if (u.action === 'add') {
      if (u.unit === 'percentage') {
        if (colDef.type === 'integer') {
          setClauses.push(
            `${colSql} = ROUND(${colSql} * (1 + (${paramRef}::numeric / 100.0)))::integer`
          );
        } else {
          setClauses.push(
            `${colSql} = ROUND((${colSql} * (1 + (${paramRef}::numeric / 100.0)))::numeric, 2)`
          );
        }
      } else if (colDef.type === 'integer') {
        setClauses.push(`${colSql} = ${colSql} + ${paramRef}::integer`);
      } else {
        setClauses.push(
          `${colSql} = ROUND((${colSql} + ${paramRef}::numeric)::numeric, 2)`
        );
      }
    } else if (u.action === 'subtract') {
      if (u.unit === 'percentage') {
        if (colDef.type === 'integer') {
          setClauses.push(
            `${colSql} = ROUND(${colSql} * (1 - (${paramRef}::numeric / 100.0)))::integer`
          );
        } else {
          setClauses.push(
            `${colSql} = ROUND((${colSql} * (1 - (${paramRef}::numeric / 100.0)))::numeric, 2)`
          );
        }
      } else if (colDef.type === 'integer') {
        setClauses.push(`${colSql} = ${colSql} - ${paramRef}::integer`);
      } else {
        setClauses.push(
          `${colSql} = ROUND((${colSql} - ${paramRef}::numeric)::numeric, 2)`
        );
      }
    } else if (u.action === 'multiply') {
      if (colDef.type === 'integer') {
        setClauses.push(`${colSql} = ROUND(${colSql} * ${paramRef}::numeric)::integer`);
      } else {
        setClauses.push(
          `${colSql} = ROUND((${colSql} * ${paramRef}::numeric)::numeric, 2)`
        );
      }
    }
  }

  // Handle columns updated multiple times in same request
  for (const [col, count] of colOccurrences.entries()) {
    if (count > 1 && col !== 'size') {
      const match = findColumnDef(schema, col);
      const exactCol = match ? match.exactName : col;
      const caseParts = [];
      for (const d of diffPreview) {
        updateParams.push(d.id);
        const idParam = `$${updateParams.length}`;
        updateParams.push(d.after[col] ?? d.after[exactCol]);
        const valParam = `$${updateParams.length}`;
        caseParts.push(`WHEN ${idParam}::uuid THEN ${valParam}`);
      }
      setClauses.push(`${quoteIdentifier(exactCol)} = CASE id ${caseParts.join(' ')} END`);
    }
  }

  for (const nestedField of new Set(nestedUpdates.map((u) => u.nested_field || 'size'))) {
    const mapMatch = findColumnDef(schema, nestedField);
    if (!mapMatch) {
      throw new AppError(`Unknown nested map column "${nestedField}".`, 400);
    }
    const exactField = mapMatch.exactName;
    const caseParts = [];
    for (const d of diffPreview) {
      updateParams.push(d.id);
      const idParam = `$${updateParams.length}`;
      updateParams.push(d.after[exactField]);
      const valueParam = `$${updateParams.length}`;
      const isJsonStorage =
        mapMatch.colDef.type === 'json' ||
        ['json', 'jsonb'].includes(
          String(mapMatch.colDef.storageType || '').toLowerCase()
        );
      caseParts.push(
        `WHEN ${idParam}::uuid THEN ${isJsonStorage ? `${valueParam}::jsonb` : valueParam}`
      );
    }
    setClauses.push(
      `${quoteIdentifier(exactField)} = CASE id ${caseParts.join(' ')} END`
    );
  }

  if (schema.columns.updated_at) {
    setClauses.push(
      `${quoteIdentifier(schema.columns.updated_at.exactName || 'updated_at')} = NOW()`
    );
  }

  const safeTableName = quoteIdentifier(schema.tableName || 'products');
  const whereBizSql = schema.columns?.workspace_id
    ? '(business_id = $1 OR workspace_id = $1)'
    : 'business_id = $1';

  const updateSql = `
    UPDATE ${safeTableName}
    SET ${setClauses.join(', ')}
    WHERE ${whereBizSql} AND id = ANY($2::uuid[])
    RETURNING *;
  `;

  return { updateSql: updateSql.trim(), updateParams };
}

/**
 * Previews a proposed mutation without executing changes in the database.
 *
 * @param {object} params
 * @param {string | object} [params.entity='products']
 * @param {string} params.businessId
 * @param {object} params.mutationJson
 * @returns {Promise<object>} Preview summary
 */
async function applyContextualScopeInheritance(
  validatedRaw,
  sourcePrompt,
  schema,
  businessId,
  conversationHistory = []
) {
  if (
    !validatedRaw ||
    !['update', 'update_many', 'delete'].includes(validatedRaw.operation) ||
    hasExplicitScopeReset(sourcePrompt)
  ) {
    return validatedRaw;
  }

  const normalizedHistory = normalizeConversationHistory(conversationHistory);
  if (normalizedHistory.length === 0) {
    return validatedRaw;
  }

  const activeCtx = getLatestActiveContext(
    normalizedHistory,
    schema.tableName || schema.entity
  );
  if (!activeCtx.matchedRowIds || activeCtx.matchedRowIds.length === 0) {
    return validatedRaw;
  }

  const isUnscopedImplicit =
    validatedRaw.target_filters.length === 0 &&
    validatedRaw.match_all &&
    !hasExplicitWholeTableScope(sourcePrompt, schema);

  const isFollowUpNarrowing =
    hasFollowUpReference(sourcePrompt) &&
    validatedRaw.filter_logic === 'AND' &&
    !hasExplicitWholeTableScope(sourcePrompt, schema);

  if (!isUnscopedImplicit && !isFollowUpNarrowing) {
    return validatedRaw;
  }

  const idFilter = await resolveIdentifierFilterForIds(
    schema,
    businessId,
    activeCtx.matchedRowIds,
    query,
    quoteIdentifier
  );
  if (!idFilter) {
    return validatedRaw;
  }

  const validatedIdFilter = validateFilter(schema, idFilter);
  const existingFilters = Array.isArray(validatedRaw.target_filters)
    ? validatedRaw.target_filters
    : [];
  if (
    existingFilters.some(
      (f) => String(f.field || '').toLowerCase() === validatedIdFilter.field.toLowerCase()
    )
  ) {
    return validatedRaw;
  }

  return {
    ...validatedRaw,
    match_all: false,
    target_filters: [...existingFilters, validatedIdFilter],
    inherited_scope: {
      from_turn_index: activeCtx.fromTurnIndex,
      matched_row_ids: activeCtx.matchedRowIds,
    },
  };
}

async function previewMutation({
  entity = 'products',
  businessId,
  mutationJson,
  sourcePrompt,
  conversationHistory = [],
}) {
  if (!businessId) {
    throw new AppError('Business ID is required to preview a mutation.', 400);
  }

  const schema = await discoverTableSchema(entity, businessId);
  await ensureTableExists(schema);

  if (mutationJson.status === 'clarification_needed') {
    return {
      status: 'clarification_needed',
      message: mutationJson.message,
      entity: schema.entity,
      operation: null,
      affected_count: 0,
      target_rows: [],
    };
  }

  const validatedRaw = await applyContextualScopeInheritance(
    validateMutation(schema, mutationJson),
    sourcePrompt,
    schema,
    businessId,
    conversationHistory
  );
  const scopeClarification = getMutationScopeClarification(
    validatedRaw,
    sourcePrompt,
    schema
  );
  if (scopeClarification) return scopeClarification;

  if (validatedRaw.operation === 'create') {
    const rowsToInsert =
      Array.isArray(validatedRaw.rows) && validatedRaw.rows.length > 0
        ? validatedRaw.rows
        : [validatedRaw.changes];
    const createDiff = buildCreateDiffPreview(rowsToInsert);
    const approvedMutation = createApprovedMutation(validatedRaw);
    return {
      status: 'preview',
      operation: 'create',
      entity: schema.entity,
      confirmation_required: true,
      message: `Ready to insert ${rowsToInsert.length} new ${schema.entity} record(s). Submit with "confirm": true to execute.`,
      proposed_changes: validatedRaw.changes,
      proposed_rows: rowsToInsert,
      proposed_updates: validatedRaw.updates,
      approved_mutation: approvedMutation,
      preview_hash: computePreviewHash(createDiff, validatedRaw),
      affected_count: rowsToInsert.length,
      target_rows: rowsToInsert,
      diff: createDiff,
    };
  }

  const nameResolution = await resolveMutationTargetNames(
    validatedRaw,
    businessId,
    schema
  );
  if (nameResolution.clarification) {
    return nameResolution.clarification;
  }
  const { validated, name_resolutions: nameResolutions } = nameResolution;

  // Find target records matching the mutation filters
  const { sql, params: sqlParams } = buildParameterizedSelectQuery({
    entity: schema,
    businessId,
    filters: validated.target_filters,
    filterLogic: validated.filter_logic,
  });

  const selectResult = await query(sql, sqlParams);
  const targetRows = selectResult.rows.map((r) => normalizeProductRow(r, schema));

  if (targetRows.length === 0) {
    return {
      status: 'not_found',
      operation: validated.operation,
      entity: schema.entity,
      message: `No matching ${schema.entity} found for the specified target criteria.`,
      affected_count: 0,
      target_rows: [],
    };
  }

  if (validated.operation === 'update' || validated.operation === 'update_many') {
    const diffPreview = targetRows.map((row) => {
      const computed = computeRowUpdates(row, validated.updates, schema);
      return {
        id: computed.id,
        name: computed.name,
        changes: computed.changes,
        before: computed.before,
        after: computed.after,
      };
    });

    const approvedMutation = createApprovedMutation(validated);
    const previewHash = computePreviewHash(diffPreview, validated);

    return {
      status: 'preview',
      operation: validated.operation,
      entity: schema.entity,
      confirmation_required: true,
      message: `Found ${targetRows.length} record(s) matching criteria. Submit with "confirm": true to apply proposed changes.`,
      affected_count: targetRows.length,
      target_rows: targetRows,
      proposed_changes: validated.changes,
      proposed_updates: validated.updates,
      approved_mutation: approvedMutation,
      filter_logic: validated.filter_logic,
      match_all: validated.match_all,
      target_filters: validated.target_filters,
      name_resolutions: nameResolutions,
      preview_hash: previewHash,
      diff: diffPreview,
    };
  }

  if (validated.operation === 'delete') {
    const deleteDiff = targetRows.map((row, idx) => ({
      id: row.id,
      name: String(resolveDisplayRowName(row, `Row ${idx + 1}`)),
      before: row,
      after: null,
      changes: {},
    }));
    return {
      status: 'preview',
      operation: 'delete',
      entity: schema.entity,
      confirmation_required: true,
      message: `Warning: This will permanently delete ${targetRows.length} record(s). Submit with "confirm": true to execute deletion.`,
      affected_count: targetRows.length,
      target_rows: targetRows,
      approved_mutation: createApprovedMutation(validated),
      preview_hash: computePreviewHash(deleteDiff, validated),
      target_filters: validated.target_filters,
      name_resolutions: nameResolutions,
      diff: deleteDiff,
    };
  }

  throw new AppError(`Unknown mutation operation "${validated.operation}".`, 400);
}

/**
 * Executes a confirmed mutation against PostgreSQL inside a transaction for any active schema.
 *
 * @param {object} params
 * @param {string | object} [params.entity='products']
 * @param {string} params.businessId
 * @param {object} params.mutationJson
 * @param {boolean} [params.confirm=false]
 * @param {string} [params.expectedPreviewHash]
 * @returns {Promise<object>}
 */
async function executeMutation({
  entity = 'products',
  businessId,
  mutationJson,
  confirm = false,
  expectedPreviewHash,
  sourcePrompt,
  conversationHistory = [],
}) {
  if (!businessId) {
    throw new AppError('Business ID is required to execute a mutation.', 400);
  }

  const schema = await discoverTableSchema(entity, businessId);

  // If not confirmed, return preview
  if (confirm !== true) {
    return previewMutation({
      entity: schema,
      businessId,
      mutationJson,
      sourcePrompt,
      conversationHistory,
    });
  }

  await ensureTableExists(schema);

  if (mutationJson.status === 'clarification_needed') {
    return {
      status: 'clarification_needed',
      message: mutationJson.message,
      entity: schema.entity,
      operation: null,
      affected_count: 0,
    };
  }

  const validatedRaw = await applyContextualScopeInheritance(
    validateMutation(schema, mutationJson),
    sourcePrompt,
    schema,
    businessId,
    conversationHistory
  );
  const scopeClarification = getMutationScopeClarification(
    validatedRaw,
    sourcePrompt,
    schema
  );
  if (scopeClarification) return scopeClarification;
  const hashToVerify =
    expectedPreviewHash ||
    mutationJson.expected_preview_hash ||
    mutationJson.preview_hash ||
    null;

  let validated = validatedRaw;
  if (validatedRaw.operation !== 'create') {
    const nameResolution = await resolveMutationTargetNames(
      validatedRaw,
      businessId,
      schema
    );
    if (nameResolution.clarification) {
      return nameResolution.clarification;
    }
    validated = nameResolution.validated;
  }

  return withTransaction(async (client) => {
    // 1. Create operation (supports single-row and multi-row inserts)
    if (validated.operation === 'create') {
      const rowsToInsert =
        Array.isArray(validated.rows) && validated.rows.length > 0
          ? validated.rows
          : [validated.changes];
      const createDiff = buildCreateDiffPreview(rowsToInsert);

      if (hashToVerify && computePreviewHash(createDiff, validated) !== hashToVerify) {
        throw new AppError(
          'Mutation plan differs from the approved preview. Please preview the mutation again before confirming.',
          409
        );
      }

      const safeTableName = quoteIdentifier(schema.tableName || 'products');
      const createdRows = [];

      for (const rowChanges of rowsToInsert) {
        const keys = Object.keys(rowChanges || {});
        if (keys.length === 0) {
          throw new AppError('Cannot create record with empty fields.', 400);
        }

        const cols = ['"business_id"'];
        const placeholders = ['$1'];
        const values = [businessId];

        if (schema.columns?.workspace_id) {
          cols.push('"workspace_id"');
          values.push(businessId);
          placeholders.push(`$${values.length}`);
        }

        keys.forEach((k) => {
          const match = findColumnDef(schema, k);
          const exactCol = match ? match.exactName : k;
          if (exactCol.toLowerCase() === 'business_id' || exactCol.toLowerCase() === 'workspace_id') {
            return;
          }
          cols.push(quoteIdentifier(exactCol));
          values.push(rowChanges[k]);
          const parameter = `$${values.length}`;
          const jsonStorage =
            match &&
            (match.colDef.type === 'json' ||
              ['json', 'jsonb'].includes(
                String(match.colDef.storageType || '').toLowerCase()
              ));
          placeholders.push(jsonStorage ? `${parameter}::jsonb` : parameter);
        });

        if (schema.columns.created_at) {
          cols.push('"created_at"');
          placeholders.push('NOW()');
        }
        if (schema.columns.updated_at) {
          cols.push('"updated_at"');
          placeholders.push('NOW()');
        }

        const insertSql = `
          INSERT INTO ${safeTableName} (${cols.join(', ')})
          VALUES (${placeholders.join(', ')})
          RETURNING *;
        `;
        const res = await client.query(insertSql, values);
        if (res.rows[0]) {
          createdRows.push(normalizeProductRow(res.rows[0], schema));
        }
      }

      await refreshWorkspaceTableMetadata({
        client,
        workspaceId: businessId,
        tableName: schema.tableName,
      });

      // Write-back sync to Google Sheets if this is a synced Google Sheet
      try {
        const { syncMutationsToGoogleSheet } = require('./googleSheetsSyncService');
        await syncMutationsToGoogleSheet(
          businessId,
          schema.tableName,
          createdRows.map((row) => ({ ...row, operation: 'create', _internal_id: row.id }))
        );
      } catch (gSyncErr) {
        console.warn('[ExecuteMutation] Google Sheets sync error:', gSyncErr.message);
      }

      return {
        status: 'success',
        operation: 'create',
        entity: schema.entity,
        affected_count: createdRows.length,
        created_row: createdRows[0] || null,
        created_rows: createdRows,
        updated_rows: createdRows,
        diff: createDiff,
        message: `Successfully created ${createdRows.length} new ${schema.entity} record(s).`,
      };
    }

    // 2. Identify target rows inside transaction with FOR UPDATE lock
    const { sql: selectSql, params: selectParams } =
      buildParameterizedSelectQuery({
        entity: schema,
        businessId,
        filters: validated.target_filters,
        filterLogic: validated.filter_logic,
      });

    const targetRes = await client.query(
      `${selectSql} FOR UPDATE`,
      selectParams
    );
    const targetRows = targetRes.rows.map((r) => normalizeProductRow(r, schema));

    if (targetRows.length === 0) {
      return {
        status: 'not_found',
        operation: validated.operation,
        entity: schema.entity,
        message: `No matching ${schema.entity} found for the specified target criteria.`,
        affected_count: 0,
      };
    }

    const targetIds = targetRows.map((r) => r.id);

    // 3. Update / Update_Many operation
    if (validated.operation === 'update' || validated.operation === 'update_many') {
      const diffPreview = targetRows.map((row) => {
        const computed = computeRowUpdates(row, validated.updates, schema);
        return {
          id: computed.id,
          name: computed.name,
          changes: computed.changes,
          before: computed.before,
          after: computed.after,
        };
      });

      if (hashToVerify) {
        const currentHash = computePreviewHash(diffPreview, validated);
        if (currentHash !== hashToVerify) {
          throw new AppError(
            'Stale preview detected: target records were modified since the preview was generated. Please preview the mutation again before confirming.',
            409
          );
        }
      }

      const { updateSql, updateParams } = buildParameterizedUpdateStatement({
        schema,
        businessId,
        targetIds,
        validatedUpdates: validated.updates,
        diffPreview,
      });

      const updateRes = await client.query(updateSql, updateParams);
      const updatedRows = updateRes.rows.map((r) => normalizeProductRow(r, schema));
      await refreshWorkspaceTableMetadata({
        client,
        workspaceId: businessId,
        tableName: schema.tableName,
      });

      // Post-update invariant checks
      for (const updatedRow of updatedRows) {
        for (const updateDef of validated.updates) {
          const colMatch = findColumnDef(schema, updateDef.field);
          if (colMatch && (colMatch.colDef.type === 'number' || colMatch.colDef.type === 'integer')) {
            const exactCol = colMatch.exactName;
            const val = updatedRow[exactCol] ?? updatedRow[exactCol.toLowerCase()];
            if (val !== undefined && val !== null) {
              if (colMatch.colDef.min !== undefined && val < colMatch.colDef.min) {
                throw new AppError(
                  `Post-update constraint violation: ${exactCol} (${val}) is below minimum allowed ${colMatch.colDef.min}.`,
                  400
                );
              }
              if (colMatch.colDef.max !== undefined && val > colMatch.colDef.max) {
                throw new AppError(
                  `Post-update constraint violation: ${exactCol} (${val}) exceeds maximum allowed ${colMatch.colDef.max}.`,
                  400
                );
              }
            }
          }
        }
      }

      // Write-back sync to Google Sheets if this is a synced Google Sheet
      try {
        const { syncMutationsToGoogleSheet } = require('./googleSheetsSyncService');
        await syncMutationsToGoogleSheet(
          businessId,
          schema.tableName,
          updatedRows.map((row) => ({ ...row, _internal_id: row.id }))
        );
      } catch (gSyncErr) {
        console.warn('[ExecuteMutation] Google Sheets sync error:', gSyncErr.message);
      }

      return {
        status: 'success',
        operation: validated.operation,
        entity: schema.entity,
        affected_count: updatedRows.length,
        updated_rows: updatedRows,
        diff: diffPreview,
        message: `Successfully updated ${updatedRows.length} ${schema.entity} record(s).`,
      };
    }

    // 4. Delete operation
    if (validated.operation === 'delete') {
      if (hashToVerify) {
        const deleteDiff = targetRows.map((row) => ({
          id: row.id,
          before: row,
          after: null,
        }));
        const currentHash = computePreviewHash(deleteDiff, validated);
        if (currentHash !== hashToVerify) {
          throw new AppError(
            'Stale preview or mutation plan detected. Please preview the deletion again before confirming.',
            409
          );
        }
      }
      const safeTableName = quoteIdentifier(schema.tableName || 'products');
      const delWhereBizSql = schema.columns?.workspace_id
        ? '(business_id = $1 OR workspace_id = $1)'
        : 'business_id = $1';
      const deleteSql = `
        DELETE FROM ${safeTableName}
        WHERE ${delWhereBizSql} AND id = ANY($2::uuid[])
        RETURNING *;
      `;
      const deleteRes = await client.query(deleteSql, [businessId, targetIds]);
      await refreshWorkspaceTableMetadata({
        client,
        workspaceId: businessId,
        tableName: schema.tableName,
      });

      return {
        status: 'success',
        operation: 'delete',
        entity: schema.entity,
        affected_count: deleteRes.rows.length,
        deleted_rows: deleteRes.rows.map((r) => normalizeProductRow(r, schema)),
        message: `Successfully deleted ${deleteRes.rows.length} ${schema.entity} record(s).`,
      };
    }

    throw new AppError(
      `Unsupported mutation operation "${validated.operation}".`,
      400
    );
  });
}

module.exports = {
  computeRowUpdates,
  computePreviewHash,
  buildParameterizedUpdateStatement,
  previewMutation,
  executeMutation,
};
