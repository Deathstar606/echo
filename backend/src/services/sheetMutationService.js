const crypto = require('node:crypto');
const { withTransaction, query } = require('../../db');
const { getSchema, validateMutation } = require('./sheetSchemaService');
const {
  buildParameterizedSelectQuery,
  normalizeProductRow,
} = require('./sheetQueryService');
const { resolveNameFilters } = require('./productNameResolver');
const AppError = require('../utils/AppError');

/**
 * Resolves `name` target filters of a validated mutation against the business's live catalog
 * (punctuation/case/whitespace-insensitive, partial-name aware). Returns either the validated
 * mutation with exact stored names substituted, or a clarification response.
 *
 * @param {object} validated - Output of validateMutation
 * @param {string} businessId
 * @param {string} entity
 * @returns {Promise<{ validated: object, name_resolutions: Array } | { clarification: object }>}
 */
async function resolveMutationTargetNames(validated, businessId, entity) {
  const resolution = await resolveNameFilters({
    businessId,
    entity,
    filters: validated.target_filters,
  });

  if (resolution.status === 'clarification_needed') {
    return {
      clarification: {
        status: 'clarification_needed',
        message: resolution.message,
        suggestions: resolution.suggestions,
        entity,
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

/**
 * Evaluates a validated list of update transformations against a single normalized product row.
 * Enforces all field-level constraints (e.g. discount 0..100, price >= 0, ordered >= 0, size stock >= 0).
 *
 * @param {object} row - Normalized product row
 * @param {Array<object>} validatedUpdates - Validated transformation objects
 * @param {object} schema - Entity schema definition
 * @returns {{ id: string, name: string, before: object, after: object, changes: object, updatedRow: object }}
 */
function computeRowUpdates(row, validatedUpdates, schema) {
  const normalizedRow = normalizeProductRow(row);
  const nextRow = { ...normalizedRow };
  const before = {};
  const after = {};
  const changes = {};

  let parsedSizeObj = null;

  for (const u of validatedUpdates) {
    // 1. Nested size.<KEY> transformation
    if (u.size_key) {
      const sizeKey = u.size_key;
      if (!parsedSizeObj) {
        if (!nextRow.size || typeof nextRow.size !== 'string') {
          parsedSizeObj = {};
        } else {
          try {
            parsedSizeObj = JSON.parse(nextRow.size);
          } catch {
            throw new AppError(
              `Cannot modify size "${sizeKey}" on product "${normalizedRow.name}" because its stored size value is not valid JSON.`,
              400
            );
          }
        }
        if (
          !parsedSizeObj ||
          typeof parsedSizeObj !== 'object' ||
          Array.isArray(parsedSizeObj)
        ) {
          throw new AppError(
            `Cannot modify size "${sizeKey}" on product "${normalizedRow.name}" because its stored size value is not a JSON object.`,
            400
          );
        }
        parsedSizeObj = { ...parsedSizeObj };
      }

      const initialSizeStock = (() => {
        try {
          const origObj = normalizedRow.size ? JSON.parse(normalizedRow.size) : {};
          const n = Number(origObj[sizeKey]);
          return Number.isFinite(n) ? Math.round(n) : 0;
        } catch {
          return 0;
        }
      })();

      const currentStock = Number.isFinite(Number(parsedSizeObj[sizeKey]))
        ? Math.round(Number(parsedSizeObj[sizeKey]))
        : 0;

      let rawNewStock = currentStock;
      if (u.action === 'set') {
        rawNewStock = u.value;
      } else if (u.action === 'add') {
        rawNewStock =
          u.unit === 'percentage'
            ? currentStock * (1 + u.value / 100)
            : currentStock + u.value;
      } else if (u.action === 'subtract') {
        rawNewStock =
          u.unit === 'percentage'
            ? currentStock * (1 - u.value / 100)
            : currentStock - u.value;
      } else if (u.action === 'multiply') {
        rawNewStock = currentStock * u.value;
      }

      const proposedStock = Math.round(rawNewStock);
      if (!Number.isFinite(proposedStock) || proposedStock < 0) {
        throw new AppError(
          `Stock count for size "${sizeKey}" on product "${normalizedRow.name}" cannot become negative (current: ${currentStock}, proposed: ${proposedStock}).`,
          400
        );
      }

      parsedSizeObj[sizeKey] = proposedStock;
      const newSizeJson = JSON.stringify(parsedSizeObj);
      nextRow.size = newSizeJson;

      before[u.field] = initialSizeStock;
      after[u.field] = proposedStock;
      changes[u.field] = {
        current: initialSizeStock,
        proposed: proposedStock,
      };

      before.size = normalizedRow.size;
      after.size = newSizeJson;
      changes.size = {
        current: normalizedRow.size,
        proposed: newSizeJson,
      };
      continue;
    }

    // 2. Standard column transformation
    const colName = u.field;
    const colDef = schema.columns[colName];
    const currentVal = nextRow[colName];
    let proposedVal = currentVal;

    if (u.action === 'set') {
      proposedVal = u.value;
    } else {
      const baseNum = Number(currentVal ?? 0);
      if (!Number.isFinite(baseNum)) {
        throw new AppError(
          `Cannot perform arithmetic "${u.action}" on "${colName}" for product "${normalizedRow.name}" because current value is not numeric.`,
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
          `Arithmetic operation "${u.action}" on "${colName}" produced an invalid number.`,
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
          `Invalid ${colName} transformation on product "${normalizedRow.name}": resulting ${colName} would be ${proposedVal}, which is below minimum allowed value ${colDef.min}.`,
          400
        );
      }
      if (colDef.max !== undefined && proposedVal > colDef.max) {
        throw new AppError(
          `Invalid ${colName} transformation on product "${normalizedRow.name}": resulting ${colName} would be ${proposedVal}, which exceeds maximum allowed value ${colDef.max}.`,
          400
        );
      }
    }

    nextRow[colName] = proposedVal;
    before[colName] = normalizedRow[colName];
    after[colName] = proposedVal;
    changes[colName] = {
      current: normalizedRow[colName],
      proposed: proposedVal,
    };
  }

  return {
    id: normalizedRow.id,
    name: normalizedRow.name,
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
function computePreviewHash(diffPreview) {
  const canonical = [...diffPreview]
    .sort((a, b) => String(a.id).localeCompare(String(b.id)))
    .map((d) => ({
      id: d.id,
      before: d.before,
      after: d.after,
    }));
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(canonical))
    .digest('hex');
}

/**
 * Builds the parameterized SQL UPDATE statement for validated transformations.
 * Uses database-side arithmetic expressions for numeric columns (`price`, `discount`, `ordered`)
 * and parameterized CASE expressions for locked JSON `size` updates.
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

  // Separate nested size updates from direct column updates
  const hasNestedSizeUpdates = validatedUpdates.some((u) => Boolean(u.size_key));
  const nonSizeUpdates = validatedUpdates.filter((u) => !u.size_key);

  // Count how many times each standard column appears in nonSizeUpdates
  const colOccurrences = new Map();
  for (const u of nonSizeUpdates) {
    colOccurrences.set(u.field, (colOccurrences.get(u.field) || 0) + 1);
  }

  const processedCols = new Set();

  for (const u of nonSizeUpdates) {
    const col = u.field;
    if (processedCols.has(col)) continue;
    processedCols.add(col);

    // If a column is updated multiple times in the same mutation or is 'size' alongside nested size updates,
    // use the precomputed locked values
    if (colOccurrences.get(col) > 1 || (col === 'size' && hasNestedSizeUpdates)) {
      continue;
    }

    const colDef = schema.columns[col];
    updateParams.push(u.value);
    const paramRef = `$${updateParams.length}`;

    if (u.action === 'set') {
      setClauses.push(`${col} = ${paramRef}`);
    } else if (u.action === 'add') {
      if (u.unit === 'percentage') {
        if (colDef.type === 'integer') {
          setClauses.push(
            `${col} = ROUND(${col} * (1 + (${paramRef}::numeric / 100.0)))::integer`
          );
        } else {
          setClauses.push(
            `${col} = ROUND((${col} * (1 + (${paramRef}::numeric / 100.0)))::numeric, 2)`
          );
        }
      } else if (colDef.type === 'integer') {
        setClauses.push(`${col} = ${col} + ${paramRef}::integer`);
      } else {
        setClauses.push(
          `${col} = ROUND((${col} + ${paramRef}::numeric)::numeric, 2)`
        );
      }
    } else if (u.action === 'subtract') {
      if (u.unit === 'percentage') {
        if (colDef.type === 'integer') {
          setClauses.push(
            `${col} = ROUND(${col} * (1 - (${paramRef}::numeric / 100.0)))::integer`
          );
        } else {
          setClauses.push(
            `${col} = ROUND((${col} * (1 - (${paramRef}::numeric / 100.0)))::numeric, 2)`
          );
        }
      } else if (colDef.type === 'integer') {
        setClauses.push(`${col} = ${col} - ${paramRef}::integer`);
      } else {
        setClauses.push(
          `${col} = ROUND((${col} - ${paramRef}::numeric)::numeric, 2)`
        );
      }
    } else if (u.action === 'multiply') {
      if (colDef.type === 'integer') {
        setClauses.push(`${col} = ROUND(${col} * ${paramRef}::numeric)::integer`);
      } else {
        setClauses.push(
          `${col} = ROUND((${col} * ${paramRef}::numeric)::numeric, 2)`
        );
      }
    }
  }

  // Handle columns that were updated multiple times in the same request
  for (const [col, count] of colOccurrences.entries()) {
    if (count > 1 && col !== 'size') {
      const caseParts = [];
      for (const d of diffPreview) {
        updateParams.push(d.id);
        const idParam = `$${updateParams.length}`;
        updateParams.push(d.after[col]);
        const valParam = `$${updateParams.length}`;
        caseParts.push(`WHEN ${idParam}::uuid THEN ${valParam}`);
      }
      setClauses.push(`${col} = CASE id ${caseParts.join(' ')} END`);
    }
  }

  // Handle nested size.<KEY> updates
  if (hasNestedSizeUpdates) {
    const distinctAfterSizes = new Set(diffPreview.map((d) => d.after.size));
    if (distinctAfterSizes.size === 1) {
      updateParams.push(diffPreview[0].after.size);
      setClauses.push(`size = $${updateParams.length}`);
    } else {
      const caseParts = [];
      for (const d of diffPreview) {
        updateParams.push(d.id);
        const idParam = `$${updateParams.length}`;
        updateParams.push(d.after.size);
        const valParam = `$${updateParams.length}`;
        caseParts.push(`WHEN ${idParam}::uuid THEN ${valParam}`);
      }
      setClauses.push(`size = CASE id ${caseParts.join(' ')} END`);
    }
  }

  setClauses.push('updated_at = NOW()');

  const updateSql = `
    UPDATE ${schema.tableName}
    SET ${setClauses.join(', ')}
    WHERE business_id = $1 AND id = ANY($2::uuid[])
    RETURNING *;
  `;

  return { updateSql: updateSql.trim(), updateParams };
}

/**
 * Previews a proposed mutation without executing changes in the database.
 * Identifies target records, evaluates arithmetic and nested size transformations,
 * validates post-update domain constraints, and returns before/after diffs.
 *
 * @param {object} params
 * @param {string} [params.entity='products'] - Must resolve to 'products'
 * @param {string} params.businessId - UUID of the business
 * @param {object} params.mutationJson - Validated or interpreted mutation JSON
 * @returns {Promise<object>} Preview summary
 */
async function previewMutation({
  entity = 'products',
  businessId,
  mutationJson,
}) {
  if (!businessId) {
    throw new AppError('Business ID is required to preview a mutation.', 400);
  }

  const schema = getSchema(entity);

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

  const validatedRaw = validateMutation(schema.entity, mutationJson);

  if (validatedRaw.operation === 'create') {
    return {
      status: 'preview',
      operation: 'create',
      entity: schema.entity,
      confirmation_required: true,
      message: `Ready to create new ${schema.entity} record. Submit with "confirm": true to execute.`,
      proposed_changes: validatedRaw.changes,
      proposed_updates: validatedRaw.updates,
      affected_count: 1,
      target_rows: [],
    };
  }

  const nameResolution = await resolveMutationTargetNames(
    validatedRaw,
    businessId,
    schema.entity
  );
  if (nameResolution.clarification) {
    return nameResolution.clarification;
  }
  const { validated, name_resolutions: nameResolutions } = nameResolution;

  // Find target records matching the mutation filters
  const { sql, params: sqlParams } = buildParameterizedSelectQuery({
    entity: schema.entity,
    businessId,
    filters: validated.target_filters,
    filterLogic: validated.filter_logic,
  });

  const selectResult = await query(sql, sqlParams);
  const targetRows = selectResult.rows.map(normalizeProductRow);

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

    const previewHash = computePreviewHash(diffPreview);

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
      filter_logic: validated.filter_logic,
      match_all: validated.match_all,
      target_filters: validated.target_filters,
      name_resolutions: nameResolutions,
      preview_hash: previewHash,
      diff: diffPreview,
    };
  }

  if (validated.operation === 'delete') {
    return {
      status: 'preview',
      operation: 'delete',
      entity: schema.entity,
      confirmation_required: true,
      message: `Warning: This will permanently delete ${targetRows.length} record(s). Submit with "confirm": true to execute deletion.`,
      affected_count: targetRows.length,
      target_rows: targetRows,
      target_filters: validated.target_filters,
      name_resolutions: nameResolutions,
    };
  }

  throw new AppError(`Unknown mutation operation "${validated.operation}".`, 400);
}

/**
 * Executes a confirmed mutation against PostgreSQL inside a transaction.
 * If confirm !== true, returns the preview response instead.
 *
 * @param {object} params
 * @param {string} [params.entity='products'] - Must resolve to 'products'
 * @param {string} params.businessId - UUID of the business
 * @param {object} params.mutationJson - Mutation description
 * @param {boolean} [params.confirm=false] - Explicit user confirmation flag
 * @param {string} [params.expectedPreviewHash] - Optional hash from previewMutation to detect stale previews
 * @returns {Promise<object>}
 */
async function executeMutation({
  entity = 'products',
  businessId,
  mutationJson,
  confirm = false,
  expectedPreviewHash,
}) {
  if (!businessId) {
    throw new AppError('Business ID is required to execute a mutation.', 400);
  }

  const schema = getSchema(entity);

  // If not confirmed, return preview
  if (confirm !== true) {
    return previewMutation({ entity: schema.entity, businessId, mutationJson });
  }

  if (mutationJson.status === 'clarification_needed') {
    return {
      status: 'clarification_needed',
      message: mutationJson.message,
      entity: schema.entity,
      operation: null,
      affected_count: 0,
    };
  }

  const validatedRaw = validateMutation(schema.entity, mutationJson);
  const hashToVerify =
    expectedPreviewHash ||
    mutationJson.expected_preview_hash ||
    mutationJson.preview_hash ||
    null;

  // Resolve product names against the live catalog before opening the transaction
  let validated = validatedRaw;
  if (validatedRaw.operation !== 'create') {
    const nameResolution = await resolveMutationTargetNames(
      validatedRaw,
      businessId,
      schema.entity
    );
    if (nameResolution.clarification) {
      return nameResolution.clarification;
    }
    validated = nameResolution.validated;
  }

  return withTransaction(async (client) => {
    // 1. Create operation
    if (validated.operation === 'create') {
      const keys = Object.keys(validated.changes);
      if (keys.length === 0) {
        throw new AppError('Cannot create record with empty fields.', 400);
      }
      if (!validated.changes.name) {
        throw new AppError('Product "name" is required to create a new product.', 400);
      }
      if (
        validated.changes.price === undefined ||
        validated.changes.price === null
      ) {
        throw new AppError('Product "price" is required to create a new product.', 400);
      }

      const cols = ['business_id', ...keys, 'created_at', 'updated_at'];
      const placeholders = ['$1'];
      const values = [businessId];

      keys.forEach((k, idx) => {
        placeholders.push(`$${idx + 2}`);
        values.push(validated.changes[k]);
      });
      placeholders.push('NOW()', 'NOW()');

      const insertSql = `
        INSERT INTO ${schema.tableName} (${cols.join(', ')})
        VALUES (${placeholders.join(', ')})
        RETURNING *;
      `;
      const res = await client.query(insertSql, values);
      return {
        status: 'success',
        operation: 'create',
        entity: schema.entity,
        affected_count: 1,
        created_row: normalizeProductRow(res.rows[0]),
        message: `Successfully created new ${schema.entity} record.`,
      };
    }

    // 2. Identify target rows inside transaction with FOR UPDATE lock
    const { sql: selectSql, params: selectParams } =
      buildParameterizedSelectQuery({
        entity: schema.entity,
        businessId,
        filters: validated.target_filters,
        filterLogic: validated.filter_logic,
      });

    const targetRes = await client.query(
      `${selectSql} FOR UPDATE`,
      selectParams
    );
    const targetRows = targetRes.rows.map(normalizeProductRow);

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
      // Evaluate transformations and verify post-update constraints on the locked rows
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
        const currentHash = computePreviewHash(diffPreview);
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
      const updatedRows = updateRes.rows.map(normalizeProductRow);

      // Post-update invariant check on returned rows
      for (const updatedRow of updatedRows) {
        if (
          updatedRow.discount !== undefined &&
          (updatedRow.discount < 0 || updatedRow.discount > 100)
        ) {
          throw new AppError(
            `Post-update constraint violation: discount (${updatedRow.discount}) out of range 0..100.`,
            400
          );
        }
        if (updatedRow.price !== undefined && updatedRow.price < 0) {
          throw new AppError(
            `Post-update constraint violation: price (${updatedRow.price}) cannot be negative.`,
            400
          );
        }
        if (updatedRow.ordered !== undefined && updatedRow.ordered < 0) {
          throw new AppError(
            `Post-update constraint violation: ordered (${updatedRow.ordered}) cannot be negative.`,
            400
          );
        }
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
      const deleteSql = `
        DELETE FROM ${schema.tableName}
        WHERE business_id = $1 AND id = ANY($2::uuid[])
        RETURNING *;
      `;
      const deleteRes = await client.query(deleteSql, [businessId, targetIds]);

      return {
        status: 'success',
        operation: 'delete',
        entity: schema.entity,
        affected_count: deleteRes.rows.length,
        deleted_rows: deleteRes.rows.map(normalizeProductRow),
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
