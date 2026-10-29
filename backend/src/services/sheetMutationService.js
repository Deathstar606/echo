const { withTransaction, query } = require('../../db');
const { getSchema, validateMutation } = require('./sheetSchemaService');
const {
  buildParameterizedSelectQuery,
  normalizeProductRow,
} = require('./sheetQueryService');
const AppError = require('../utils/AppError');

/**
 * Previews a proposed mutation without executing changes in the database.
 * Identifies target records and previews before/after changes.
 *
 * @param {object} params
 * @param {string} [params.entity='products'] - Must resolve to 'products'
 * @param {string} params.businessId - UUID of the business
 * @param {object} params.mutationJson - Validated or interpreted mutation JSON
 * @returns {Promise<object>} Preview summary
 */
async function previewMutation({ entity = 'products', businessId, mutationJson }) {
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

  const validated = validateMutation(schema.entity, mutationJson);

  if (validated.operation === 'create') {
    return {
      status: 'preview',
      operation: 'create',
      entity: schema.entity,
      confirmation_required: true,
      message: `Ready to create new ${schema.entity} record. Submit with "confirm": true to execute.`,
      proposed_changes: validated.changes,
      affected_count: 1,
      target_rows: [],
    };
  }

  // Find target records matching the mutation filters
  const { sql, params: sqlParams } = buildParameterizedSelectQuery({
    entity: schema.entity,
    businessId,
    filters: validated.target_filters,
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

  if (validated.operation === 'update') {
    const diffPreview = targetRows.map((row) => {
      const diff = {};
      const before = {};
      const after = {};
      for (const [k, newVal] of Object.entries(validated.changes)) {
        diff[k] = {
          current: row[k],
          proposed: newVal,
        };
        before[k] = row[k];
        after[k] = newVal;
      }
      return {
        id: row.id,
        name: row.name,
        changes: diff,
        before,
        after,
      };
    });

    return {
      status: 'preview',
      operation: 'update',
      entity: schema.entity,
      confirmation_required: true,
      message: `Found ${targetRows.length} record(s) matching criteria. Submit with "confirm": true to apply proposed changes.`,
      affected_count: targetRows.length,
      target_rows: targetRows,
      proposed_changes: validated.changes,
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
 * @returns {Promise<object>}
 */
async function executeMutation({
  entity = 'products',
  businessId,
  mutationJson,
  confirm = false,
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

  const validated = validateMutation(schema.entity, mutationJson);

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
      if (validated.changes.price === undefined || validated.changes.price === null) {
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

    // 2. Identify target rows inside transaction with FOR UPDATE
    const { sql: selectSql, params: selectParams } = buildParameterizedSelectQuery({
      entity: schema.entity,
      businessId,
      filters: validated.target_filters,
    });

    const targetRes = await client.query(`${selectSql} FOR UPDATE`, selectParams);
    const targetRows = targetRes.rows;

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

    // 3. Update operation
    if (validated.operation === 'update') {
      const setClauses = [];
      const updateParams = [businessId, targetIds];

      for (const [key, val] of Object.entries(validated.changes)) {
        updateParams.push(val);
        setClauses.push(`${key} = $${updateParams.length}`);
      }
      setClauses.push('updated_at = NOW()');

      const updateSql = `
        UPDATE ${schema.tableName}
        SET ${setClauses.join(', ')}
        WHERE business_id = $1 AND id = ANY($2::uuid[])
        RETURNING *;
      `;

      const updateRes = await client.query(updateSql, updateParams);

      return {
        status: 'success',
        operation: 'update',
        entity: schema.entity,
        affected_count: updateRes.rows.length,
        updated_rows: updateRes.rows.map(normalizeProductRow),
        message: `Successfully updated ${updateRes.rows.length} ${schema.entity} record(s).`,
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

    throw new AppError(`Unsupported mutation operation "${validated.operation}".`, 400);
  });
}

module.exports = {
  previewMutation,
  executeMutation,
};
