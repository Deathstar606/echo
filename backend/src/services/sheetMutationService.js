const crypto = require('node:crypto');
const { withTransaction, query } = require('../../db');
const {
  getSchema,
  discoverTableSchema,
  ensureTableExists,
  findColumnDef,
  validateMutation,
} = require('./sheetSchemaService');
const {
  buildParameterizedSelectQuery,
  normalizeProductRow,
} = require('./sheetQueryService');
const { resolveNameFilters } = require('./productNameResolver');
const AppError = require('../utils/AppError');

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

  let parsedSizeObj = null;

  for (const u of validatedUpdates) {
    // 1. Nested size.<KEY> transformation for tables with size JSON
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
              `Cannot modify size "${sizeKey}" on item "${rowName}" because its stored size value is not valid JSON.`,
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
            `Cannot modify size "${sizeKey}" on item "${rowName}" because its stored size value is not a JSON object.`,
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
          `Stock count for size "${sizeKey}" on item "${rowName}" cannot become negative (current: ${currentStock}, proposed: ${proposedStock}).`,
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

  const hasNestedSizeUpdates = validatedUpdates.some((u) => Boolean(u.size_key));
  const nonSizeUpdates = validatedUpdates.filter((u) => !u.size_key);

  const colOccurrences = new Map();
  for (const u of nonSizeUpdates) {
    colOccurrences.set(u.field, (colOccurrences.get(u.field) || 0) + 1);
  }

  const processedCols = new Set();

  for (const u of nonSizeUpdates) {
    const col = u.field;
    if (processedCols.has(col)) continue;
    processedCols.add(col);

    if (colOccurrences.get(col) > 1 || (col === 'size' && hasNestedSizeUpdates)) {
      continue;
    }

    const match = findColumnDef(schema, col);
    const colDef = match ? match.colDef : { type: 'string' };
    const exactCol = match ? match.exactName : col;
    const colSql = `"${exactCol}"`;

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
      setClauses.push(`"${exactCol}" = CASE id ${caseParts.join(' ')} END`);
    }
  }

  // Handle nested size.<KEY> updates
  if (hasNestedSizeUpdates) {
    const distinctAfterSizes = new Set(diffPreview.map((d) => d.after.size));
    if (distinctAfterSizes.size === 1) {
      updateParams.push(diffPreview[0].after.size);
      setClauses.push(`"size" = $${updateParams.length}`);
    } else {
      const caseParts = [];
      for (const d of diffPreview) {
        updateParams.push(d.id);
        const idParam = `$${updateParams.length}`;
        updateParams.push(d.after.size);
        const valParam = `$${updateParams.length}`;
        caseParts.push(`WHEN ${idParam}::uuid THEN ${valParam}`);
      }
      setClauses.push(`"size" = CASE id ${caseParts.join(' ')} END`);
    }
  }

  if (schema.columns.updated_at) {
    setClauses.push('"updated_at" = NOW()');
  }

  const safeTableName = String(schema.tableName || 'products').replace(/[^a-z0-9_]/gi, '_');

  const updateSql = `
    UPDATE "${safeTableName}"
    SET ${setClauses.join(', ')}
    WHERE business_id = $1 AND id = ANY($2::uuid[])
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
async function previewMutation({
  entity = 'products',
  businessId,
  mutationJson,
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

  const validatedRaw = validateMutation(schema, mutationJson);

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
}) {
  if (!businessId) {
    throw new AppError('Business ID is required to execute a mutation.', 400);
  }

  const schema = await discoverTableSchema(entity, businessId);
  await ensureTableExists(schema);

  // If not confirmed, return preview
  if (confirm !== true) {
    return previewMutation({ entity: schema, businessId, mutationJson });
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

  const validatedRaw = validateMutation(schema, mutationJson);
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
    // 1. Create operation
    if (validated.operation === 'create') {
      const keys = Object.keys(validated.changes);
      if (keys.length === 0) {
        throw new AppError('Cannot create record with empty fields.', 400);
      }

      const safeTableName = String(schema.tableName || 'products').replace(/[^a-z0-9_]/gi, '_');
      const cols = ['"business_id"'];
      const placeholders = ['$1'];
      const values = [businessId];

      keys.forEach((k, idx) => {
        const match = findColumnDef(schema, k);
        const exactCol = match ? match.exactName : k;
        cols.push(`"${exactCol}"`);
        placeholders.push(`$${idx + 2}`);
        values.push(validated.changes[k]);
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
        INSERT INTO "${safeTableName}" (${cols.join(', ')})
        VALUES (${placeholders.join(', ')})
        RETURNING *;
      `;
      const res = await client.query(insertSql, values);
      return {
        status: 'success',
        operation: 'create',
        entity: schema.entity,
        affected_count: 1,
        created_row: normalizeProductRow(res.rows[0], schema),
        message: `Successfully created new ${schema.entity} record.`,
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
      const updatedRows = updateRes.rows.map((r) => normalizeProductRow(r, schema));

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
      const safeTableName = String(schema.tableName || 'products').replace(/[^a-z0-9_]/gi, '_');
      const deleteSql = `
        DELETE FROM "${safeTableName}"
        WHERE business_id = $1 AND id = ANY($2::uuid[])
        RETURNING *;
      `;
      const deleteRes = await client.query(deleteSql, [businessId, targetIds]);

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
