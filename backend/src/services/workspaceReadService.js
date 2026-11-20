const { query } = require('../../db');
const AppError = require('../utils/AppError');
const { generateStructuredJsonWithRetry } = require('./geminiService');
const { discoverWorkspaceSources } = require('./queryRouterService');
const {
  buildDocumentCitation,
  buildTableRowCitation,
  resolveRowIdentifier,
} = require('./crossRagService');
const { retrieveHybridDocumentChunks } = require('./crossRagService');
const { findColumnDef, normalizeEntityName, quoteIdentifier, validateFilter, validateSort } = require('./sheetSchemaService');
const {
  normalizeConversationHistory,
  getLatestActiveContext,
  hasFollowUpReference,
  hasExplicitScopeReset,
  formatConversationHistoryForPrompt,
  resolveIdentifierFilterForIds,
} = require('../utils/conversationHistory');
const { serializeTableForPrompt } = require('../utils/schemaPromptSerializer');
const {
  buildDeterministicQuerySummary,
  buildHighlightedRows,
} = require('./fastTableQueryService');

const READ_PLAN_SCHEMA = {
  type: 'OBJECT',
  properties: {
    table_queries: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          table_name: { type: 'STRING' },
          filters: {
            type: 'ARRAY',
            items: {
              type: 'OBJECT',
              properties: {
                field: { type: 'STRING' },
                operator: {
                  type: 'STRING',
                  enum: [
                    'equals',
                    'not_equals',
                    'contains',
                    'not_contains',
                    'starts_with',
                    'ends_with',
                    'in',
                    'greater_than',
                    'greater_than_or_equal',
                    'less_than',
                    'less_than_or_equal',
                    'between',
                    'relative_days_ago',
                    'this_month',
                  ],
                },
                value: { type: 'STRING' },
              },
              required: ['field', 'operator', 'value'],
            },
          },
          calculation_filters: {
            type: 'ARRAY',
            items: {
              type: 'OBJECT',
              properties: {
                operation: { type: 'STRING', enum: ['add', 'subtract', 'multiply', 'divide'] },
                fields: { type: 'ARRAY', items: { type: 'STRING' } },
                operator: {
                  type: 'STRING',
                  enum: [
                    'equals',
                    'not_equals',
                    'greater_than',
                    'greater_than_or_equal',
                    'less_than',
                    'less_than_or_equal',
                    'between',
                  ],
                },
                value: { type: 'STRING' },
              },
              required: ['operation', 'fields', 'operator', 'value'],
            },
          },
          filter_logic: { type: 'STRING', enum: ['AND', 'OR'] },
          sort: {
            type: 'ARRAY',
            items: {
              type: 'OBJECT',
              properties: {
                field: { type: 'STRING' },
                direction: { type: 'STRING', enum: ['asc', 'desc'] },
              },
              required: ['field', 'direction'],
            },
          },
          limit: { type: 'INTEGER' },
          aggregates: {
            type: 'ARRAY',
            items: {
              type: 'OBJECT',
              properties: {
                operation: { type: 'STRING', enum: ['count', 'sum', 'average', 'min', 'max'] },
                field: { type: 'STRING' },
              },
              required: ['operation'],
            },
          },
          calculations: {
            type: 'ARRAY',
            items: {
              type: 'OBJECT',
              properties: {
                operation: { type: 'STRING', enum: ['add', 'subtract', 'multiply', 'divide'] },
                fields: { type: 'ARRAY', items: { type: 'STRING' } },
                aggregate: { type: 'STRING', enum: ['count', 'sum', 'average', 'min', 'max'] },
              },
              required: ['operation', 'fields'],
            },
          },
        },
        required: ['table_name'],
      },
    },
  },
  required: ['table_queries'],
};

function getTenantColumns(schema) {
  return Object.values(schema.columns || {}).filter((column) =>
    ['business_id', 'workspace_id'].includes(
      String(column.exactName || '').toLowerCase()
    )
  );
}

function numericColumn(schema, name) {
  const found = findColumnDef(schema, name);
  if (!found || !['number', 'integer'].includes(found.colDef.type)) {
    throw new AppError(`Read calculation requires a numeric column; "${name}" is not one.`, 400);
  }
  return found.exactName;
}

function buildArithmeticExpression(schema, calculation) {
  const fields = Array.isArray(calculation.fields) ? calculation.fields : [];
  if (fields.length < 2 || fields.length > 6) {
    throw new AppError('A row calculation requires between 2 and 6 numeric columns.', 400);
  }
  const columns = fields.map((field) => quoteIdentifier(numericColumn(schema, field)));
  const operation = calculation.operation;
  if (!['add', 'subtract', 'multiply', 'divide'].includes(operation)) {
    throw new AppError(`Unsupported read calculation "${operation}".`, 400);
  }
  const operator = { add: '+', subtract: '-', multiply: '*', divide: '/' }[operation];
  const expression = columns.reduce(
    (result, column, index) =>
      index === 0
        ? column
        : operation === 'divide'
          ? `(${result} / NULLIF(${column}, 0))`
          : `(${result} ${operator} ${column})`,
    ''
  );
  return expression;
}

function extractDocumentArithmeticFilters(schema, documentChunks) {
  const numericColumns = Object.values(schema.columns || {}).filter((column) =>
    ['number', 'integer'].includes(column.type)
  );
  const comparisons = [
    { pattern: '>=|greater\\s+than\\s+or\\s+equal\\s+to|at\\s+least|no\\s+less\\s+than', operator: 'greater_than_or_equal' },
    { pattern: '<=|less\\s+than\\s+or\\s+equal\\s+to|at\\s+most|no\\s+more\\s+than', operator: 'less_than_or_equal' },
    { pattern: '>|greater\\s+than|exceeds|more\\s+than', operator: 'greater_than' },
    { pattern: '<|less\\s+than|below|fewer\\s+than', operator: 'less_than' },
    { pattern: '=|equals?|equal\\s+to', operator: 'equals' },
  ];
  const results = [];
  for (const first of numericColumns) {
    for (const second of numericColumns) {
      if (first === second) continue;
      const firstName = String(first.exactName).split(/[_\s]+/).filter(Boolean).join('[\\s_-]+');
      const secondName = String(second.exactName).split(/[_\s]+/).filter(Boolean).join('[\\s_-]+');
      const expressionPattern = `\\b${firstName}\\b\\s*(?:-|minus|difference\\s+between)\\s*\\b${secondName}\\b`;
      for (const comparison of comparisons) {
        const pattern = new RegExp(
          `${expressionPattern}\\s*\\)?\\s*(?:is|are)?\\s*(?:${comparison.pattern})\\s*(-?\\d+(?:\\.\\d+)?)\\b`,
          'i'
        );
        for (const chunk of documentChunks) {
          const text = String(chunk.raw_text || '');
          const match = pattern.exec(text);
          if (!match) continue;
          const expression = buildArithmeticExpression(schema, {
            operation: 'subtract',
            fields: [first.exactName, second.exactName],
          });
          results.push({
            expression,
            operator: comparison.operator,
            value: Number(match[1]),
          });
        }
      }
    }
  }
  return results.filter((filter, index) =>
    results.findIndex((candidate) =>
      candidate.expression === filter.expression &&
      candidate.operator === filter.operator &&
      candidate.value === filter.value
    ) === index
  );
}

function validateReadPlan(rawPlan, tables, userPrompt = '', documentChunks = []) {
  if (!rawPlan || !Array.isArray(rawPlan.table_queries)) {
    throw new AppError('The read planner did not return a table query plan.', 502);
  }
  const byName = new Map(tables.map((table) => [table.tableName.toLowerCase(), table]));
  const plans = rawPlan.table_queries.map((rawQuery) => {
    const tableName = String(rawQuery?.table_name || '').trim();
    const table = byName.get(tableName.toLowerCase());
    if (!table) {
      throw new AppError(`Read planner referenced an unavailable table "${tableName}".`, 502);
    }
    if (getTenantColumns(table.schema).length === 0) {
      throw new AppError(`Table "${tableName}" is not scoped to a business workspace.`, 400);
    }
    const filters = (Array.isArray(rawQuery.filters) ? rawQuery.filters : [])
      .map((filter) => {
        let value = filter?.value;
        if (typeof value === 'string' && ['in', 'between'].includes(String(filter.operator).toLowerCase())) {
          try {
            value = JSON.parse(value);
          } catch {
            value = value.split(',').map((part) => part.trim()).filter(Boolean);
          }
        }
        return validateFilter(table.schema, { ...filter, value });
      });
    const calculationFilters = (
      Array.isArray(rawQuery.calculation_filters) ? rawQuery.calculation_filters : []
    ).map((item) => {
      const expression = buildArithmeticExpression(table.schema, item);
      let value = item.value;
      if (item.operator === 'between' && typeof value === 'string') {
        try {
          value = JSON.parse(value);
        } catch {
          value = value.split(',').map((part) => part.trim());
        }
      }
      if (item.operator === 'between') {
        if (!Array.isArray(value) || value.length !== 2 || value.some((n) => !Number.isFinite(Number(n)))) {
          throw new AppError('A calculated between filter requires two numeric bounds.', 400);
        }
        value = value.map(Number);
      } else {
        value = Number(value);
        if (!Number.isFinite(value)) {
          throw new AppError('A calculated filter requires a numeric comparison value.', 400);
        }
      }
      return { expression, operator: String(item.operator), value };
    });
    const explicitWholeTableRequest =
      /\b(?:all\s+(?:rows|records|entries)|entire\s+(?:table|dataset)|whole\s+(?:table|dataset)|overall|across\s+(?:all\s+(?:rows|records|entries)|all\s+(?:\w+\s+){0,2}tables?))\b/i.test(
        userPrompt
      );
    if (
      filters.length === 0 &&
      calculationFilters.length === 0 &&
      !explicitWholeTableRequest
    ) {
      throw new AppError(
        `A read query over "${tableName}" must include document- or user-grounded filters unless the user explicitly requests a whole-table result.`,
        400
      );
    }
    const filterLogic = String(rawQuery.filter_logic || 'AND').toUpperCase() === 'OR'
      ? 'OR'
      : 'AND';
    const sort = validateSort(table.schema, Array.isArray(rawQuery.sort) ? rawQuery.sort : []);
    const limit = Number.isInteger(rawQuery.limit)
      ? Math.max(1, Math.min(200, rawQuery.limit))
      : 100;
    const aggregates = (Array.isArray(rawQuery.aggregates) ? rawQuery.aggregates : []).map((item) => {
      const operation = String(item?.operation || '').toLowerCase();
      if (!['count', 'sum', 'average', 'min', 'max'].includes(operation)) {
        throw new AppError(`Unsupported aggregate operation "${operation}".`, 400);
      }
      const field = item.field
        ? operation === 'count'
          ? findColumnDef(table.schema, item.field)?.exactName
          : numericColumn(table.schema, item.field)
        : null;
      if (item.field && !field) {
        throw new AppError(`Aggregate field "${item.field}" is not in the active schema.`, 400);
      }
      if (operation !== 'count' && !field) {
        throw new AppError(`Aggregate "${operation}" requires a numeric column.`, 400);
      }
      return { operation, field };
    });
    const calculations = (Array.isArray(rawQuery.calculations) ? rawQuery.calculations : []).map((item) => {
      const expression = buildArithmeticExpression(table.schema, item);
      const aggregate = item.aggregate ? String(item.aggregate).toLowerCase() : null;
      if (aggregate && !['count', 'sum', 'average', 'min', 'max'].includes(aggregate)) {
        throw new AppError(`Unsupported calculation aggregate "${aggregate}".`, 400);
      }
      return {
        expression,
        aggregate,
        operation: String(item.operation).toLowerCase(),
        fields: item.fields.map((field) => numericColumn(table.schema, field)),
      };
    });
    return {
      table,
      filters,
      calculationFilters,
      filterLogic,
      sort,
      limit,
      aggregates,
      calculations,
    };
  });
  const eligibilityKeywordRegex =
    /\b(?:eligib(?:le|ility)|qualif(?:y|ies|ied)|satisf(?:y|ies|ied)|meet(?:s|ing)?|surge\s+ready|readiness)\b/i;
  const promptClauses = String(userPrompt || '')
    .split(/[.;\n]+|\b(?:and|then|while)\b/i)
    .map((part) => part.trim())
    .filter(Boolean);
  const eligibilityClauses = promptClauses.filter((clause) =>
    eligibilityKeywordRegex.test(clause)
  );
  const extractTableTokens = (tbl) =>
    new Set(
      [
        ...String(tbl?.tableName || '').toLowerCase().split(/[^a-z0-9]+/),
        ...Object.values(tbl?.schema?.columns || {}).flatMap((col) =>
          String(col.exactName || '').toLowerCase().split(/[^a-z0-9]+/)
        ),
      ].filter((tok) => tok.length >= 3 && !['the', 'and', 'for', 'with'].includes(tok))
    );
  const clauseMentionsTable = (clause, tbl) => {
    const tokens = extractTableTokens(tbl);
    return [...tokens].some((tok) => new RegExp(`\\b${tok}s?\\b`, 'i').test(clause));
  };
  const shouldApplyDocumentEligibilityToPlan = (plan) => {
    if (eligibilityClauses.length === 0) return false;
    if (
      plan.aggregates.length > 0 ||
      plan.calculations.length > 0 ||
      plan.filterLogic === 'OR' ||
      plan.filters.some((filter) => /(?:^|_)id$/i.test(String(filter.field || '')))
    ) {
      return false;
    }
    return eligibilityClauses.some((clause) => {
      if (clauseMentionsTable(clause, plan.table)) return true;
      const otherTablesMentioned = tables.some(
        (other) =>
          other.tableName !== plan.table.tableName && clauseMentionsTable(clause, other)
      );
      return !otherTablesMentioned;
    });
  };
  for (const plan of plans) {
    if (!shouldApplyDocumentEligibilityToPlan(plan)) continue;
    const extractedFilters = extractDocumentArithmeticFilters(
      plan.table.schema,
      documentChunks
    );
    for (const extracted of extractedFilters) {
      const alreadyPresent = plan.calculationFilters.some(
        (filter) =>
          filter.expression === extracted.expression &&
          filter.operator === extracted.operator &&
          Number(filter.value) === extracted.value
      );
      if (!alreadyPresent) plan.calculationFilters.push(extracted);
    }
  }
  const requiresDerivedEligibilityFilter =
    /\b(?:minus|difference\s+between|subtract(?:ed|ing)?|remaining|net\s+(?:amount|quantity|capacity))\b/i.test(
      userPrompt
    ) &&
    /\b(?:qualif(?:y|ies|ied)|eligib(?:le|ility)|satisf(?:y|ies|ied)|meet(?:s|ing)?|exclu(?:de|des|ding)|below|threshold|minimum|at\s+least|greater\s+than)\b/i.test(
      userPrompt
    );
  if (
    requiresDerivedEligibilityFilter &&
    !plans.some((plan) => plan.calculationFilters.length > 0)
  ) {
    throw new AppError(
      'This request requires an arithmetic eligibility condition. Include the document-derived calculation in calculation_filters before returning rows.',
      502
    );
  }
  return plans;
}

function addComputedColumns(sql, calculations) {
  if (calculations.length === 0) return sql;
  const selectAdditions = calculations.map(
    (calculation, index) => `${calculation.expression} AS ${quoteIdentifier(`_calculation_${index + 1}`)}`
  );
  return sql.replace(/^SELECT \*/i, `SELECT *, ${selectAdditions.join(', ')}`);
}

async function executeReadQuery(businessId, plan) {
  const { table, filters, calculationFilters = [], filterLogic, sort, limit } = plan;
  const tenantColumns = getTenantColumns(table.schema);
  const sqlParams = [businessId];
  const tenantPredicate = tenantColumns.length > 1
    ? `(${tenantColumns.map((column) => `${quoteIdentifier(column.exactName)} = $1`).join(' OR ')})`
    : `${quoteIdentifier(tenantColumns[0].exactName)} = $1`;
  const conditions = [];
  const stringOperators = {
    equals: '=',
    not_equals: '<>',
    greater_than: '>',
    greater_than_or_equal: '>=',
    less_than: '<',
    less_than_or_equal: '<=',
  };
  const filterClauses = filters.map((filter) => {
    if (filter.nested_field && filter.nested_key) {
      const nestedColumn = findColumnDef(table.schema, filter.nested_field);
      if (!nestedColumn) {
        throw new AppError(`Unknown nested-map column "${filter.nested_field}".`, 400);
      }
      sqlParams.push(filter.nested_key);
      const keyParam = `$${sqlParams.length}`;
      const nestedValue = `(${quoteIdentifier(nestedColumn.exactName)}::jsonb ->> ${keyParam})`;
      const valueExpr = `(CASE WHEN ${nestedValue} ~ '^-?[0-9]+([.][0-9]+)?$' THEN ${nestedValue}::numeric ELSE NULL END)`;
      const operator = stringOperators[filter.operator];
      if (!operator) throw new AppError(`Unsupported nested-map operator "${filter.operator}".`, 400);
      sqlParams.push(filter.value);
      return `${valueExpr} ${operator} $${sqlParams.length}`;
    }
    const field = findColumnDef(table.schema, filter.field);
    if (!field) throw new AppError(`Unknown validated filter column "${filter.field}".`, 400);
    const columnSql = quoteIdentifier(field.exactName);
    const type = field.colDef.type;
    if (filter.operator === 'in') {
      sqlParams.push(filter.value);
      return `${columnSql}::text = ANY($${sqlParams.length}::text[])`;
    }
    if (filter.operator === 'contains' || filter.operator === 'not_contains' || filter.operator === 'starts_with' || filter.operator === 'ends_with') {
      const value = String(filter.value);
      const pattern = filter.operator === 'starts_with' ? `${value}%`
        : filter.operator === 'ends_with' ? `%${value}`
          : `%${value}%`;
      sqlParams.push(pattern);
      return `${columnSql} ${filter.operator === 'not_contains' ? 'NOT ILIKE' : 'ILIKE'} $${sqlParams.length}`;
    }
    if (filter.operator === 'relative_days_ago') {
      sqlParams.push(filter.value);
      return `${columnSql} >= (NOW() - ($${sqlParams.length}::integer * INTERVAL '1 day'))`;
    }
    if (filter.operator === 'this_month') {
      return `${columnSql} >= DATE_TRUNC('month', CURRENT_DATE) AND ${columnSql} < (DATE_TRUNC('month', CURRENT_DATE) + INTERVAL '1 month')`;
    }
    if (filter.operator === 'between') {
      sqlParams.push(filter.value[0]);
      const first = `$${sqlParams.length}`;
      sqlParams.push(filter.value[1]);
      const second = `$${sqlParams.length}`;
      const cast = type === 'date' ? '::date' : '';
      return `${columnSql} BETWEEN ${first}${cast} AND ${second}${cast}`;
    }
    const operator = stringOperators[filter.operator];
    if (!operator) throw new AppError(`Unsupported read filter operator "${filter.operator}".`, 400);
    sqlParams.push(filter.value);
    const parameter = `$${sqlParams.length}${type === 'date' ? '::date' : ''}`;
    return type === 'string' && filter.operator === 'equals'
      ? `LOWER(${columnSql}) = LOWER(${parameter})`
      : `${columnSql} ${operator} ${parameter}`;
  });
  const calculatedFilterClauses = calculationFilters.map((filter) => {
    const operator = stringOperators[filter.operator];
    if (operator) {
      sqlParams.push(filter.value);
      return `${filter.expression} ${operator} $${sqlParams.length}`;
    }
    if (filter.operator === 'between') {
      sqlParams.push(filter.value[0]);
      const first = `$${sqlParams.length}`;
      sqlParams.push(filter.value[1]);
      const second = `$${sqlParams.length}`;
      return `${filter.expression} BETWEEN ${first} AND ${second}`;
    }
    throw new AppError(`Unsupported calculated filter operator "${filter.operator}".`, 400);
  });
  if (filterClauses.length) {
    conditions.push(`(${filterClauses.join(` ${filterLogic} `)})`);
  }
  conditions.push(...calculatedFilterClauses.map((clause) => `(${clause})`));
  const whereSql = [tenantPredicate, ...conditions].join(' AND ');
  const orderSql = sort.length
    ? ` ORDER BY ${sort.map((item) => `${quoteIdentifier(findColumnDef(table.schema, item.field).exactName)} ${item.direction.toUpperCase()}`).join(', ')}`
    : '';
  const scopedSql = `SELECT * FROM ${quoteIdentifier(table.tableName)} WHERE ${whereSql}`;
  const aggregateExpressions = [
    'COUNT(*)::bigint AS "_row_count"',
    ...plan.aggregates.map((item, index) => {
      if (item.operation === 'count') {
        return `COUNT(${item.field ? quoteIdentifier(item.field) : '*'})::bigint AS ${quoteIdentifier(`_aggregate_${index + 1}`)}`;
      }
      const fn = item.operation === 'average' ? 'AVG' : item.operation.toUpperCase();
      return `${fn}(${quoteIdentifier(item.field)}) AS ${quoteIdentifier(`_aggregate_${index + 1}`)}`;
    }),
    ...plan.calculations.flatMap((item, index) => {
      if (!item.aggregate) return [];
      const fn = item.aggregate === 'count'
        ? 'COUNT'
        : item.aggregate === 'average'
          ? 'AVG'
          : item.aggregate.toUpperCase();
      return [`${fn}(${item.expression}) AS ${quoteIdentifier(`_calculation_aggregate_${index + 1}`)}`];
    }),
  ];
  const pageSql = addComputedColumns(
    `SELECT * FROM "_scoped_rows"${orderSql} LIMIT $${sqlParams.length + 1}`,
    plan.calculations
  );
  const sql = `
    WITH "_scoped_rows" AS (${scopedSql}),
         "_page" AS (${pageSql})
    SELECT
      ${[
        'COUNT(*)::bigint AS "_row_count"',
        `COALESCE((SELECT jsonb_agg(to_jsonb("_page")) FROM "_page"), '[]'::jsonb) AS "_rows"`,
        ...aggregateExpressions.slice(1),
      ].join(',\n      ')}
    FROM "_scoped_rows"
    LIMIT 1
  `;
  const result = await query(sql, [...sqlParams, limit]);
  const summary = result.rows?.[0] || {};
  return {
    rows: summary._rows || [],
    summary,
  };
}

function selectRelevantTablesForRead(
  tables = [],
  prompt = '',
  chunks = [],
  activeTargetTable = null
) {
  if (!Array.isArray(tables) || tables.length <= 1) {
    return tables;
  }

  const promptLower = String(prompt || '').toLowerCase();
  const positiveChunks = (chunks || []).filter((c) => Number(c.hybrid_score) > 0);
  const evidencePool = positiveChunks.length > 0 ? positiveChunks : (chunks || []).slice(0, 4);
  const chunkTextLower = evidencePool
    .map((c) => `${c.filename || ''}\n${c.section_title || ''}\n${String(c.raw_text || '').slice(0, 600)}`)
    .join('\n')
    .toLowerCase();

  const genericTableTokens = new Set([
    'dataset',
    'data',
    'table',
    'sheet',
    'management',
    'csv',
  ]);
  const skipCols = new Set([
    'id',
    'business_id',
    'workspace_id',
    'user_id',
    'created_at',
    'updated_at',
    '_google_row_index',
  ]);

  const scored = tables.map((table) => {
    const tName = String(table.tableName || '').toLowerCase();
    const dName = String(table.displayName || '').toLowerCase();
    let score = 0;

    if (
      activeTargetTable &&
      normalizeEntityName(activeTargetTable) === normalizeEntityName(tName)
    ) {
      score += 3;
    }

    const spacedT = tName.replace(/_/g, ' ');
    if (
      (tName && promptLower.includes(tName)) ||
      (spacedT && promptLower.includes(spacedT)) ||
      (dName && dName.length >= 4 && promptLower.includes(dName))
    ) {
      score += 10;
    } else if (
      (tName && chunkTextLower.includes(tName)) ||
      (spacedT && chunkTextLower.includes(spacedT))
    ) {
      score += 5;
    }

    const nameTokens = [...new Set([...tName.split(/[^a-z0-9]+/), ...dName.split(/[^a-z0-9]+/)])]
      .filter((tok) => tok.length >= 3 && !genericTableTokens.has(tok));
    for (const tok of nameTokens) {
      const variants = [tok, tok.endsWith('s') && tok.length > 3 ? tok.slice(0, -1) : `${tok}s`];
      if (variants.some((v) => promptLower.includes(v))) {
        score += 4;
      } else if (variants.some((v) => chunkTextLower.includes(v))) {
        score += 2;
      }
    }

    for (const col of Object.values(table.schema?.columns || {})) {
      const colName = String(col.exactName || '').toLowerCase();
      if (!colName || skipCols.has(colName)) continue;
      const spacedCol = colName.replace(/_/g, ' ');
      if (promptLower.includes(colName) || (spacedCol !== colName && promptLower.includes(spacedCol))) {
        score += 3;
      } else if (
        chunkTextLower.includes(colName) ||
        (spacedCol !== colName && chunkTextLower.includes(spacedCol))
      ) {
        score += 1;
      }

      const repVals = table.schema?.representativeValues?.[col.exactName];
      if (Array.isArray(repVals)) {
        for (const val of repVals.slice(0, 12)) {
          const vStr = String(val ?? '').trim().toLowerCase();
          if (vStr.length >= 3 && promptLower.includes(vStr)) {
            score += 2;
            break;
          }
        }
      }
    }

    return { table, score };
  });

  const relevant = scored.filter((item) => item.score > 0).map((item) => item.table);
  return relevant.length > 0 ? relevant : tables;
}

function selectPassagesForRead(
  chunks = [],
  { maxChunks = 6, maxChars = 750 } = {}
) {
  if (!Array.isArray(chunks) || chunks.length === 0) return [];
  const positive = chunks.filter((c) => Number(c.hybrid_score) > 0);
  const pool = positive.length > 0 ? positive : chunks;

  const selected = [];
  const seenKeys = new Set();
  const seenPages = new Set();
  for (const chunk of pool) {
    if (selected.length >= maxChunks) break;
    const pageKey = `${chunk.filename || 'doc'}::${chunk.page_number || 1}`;
    const chunkKey = `${pageKey}::${chunk.chunk_index ?? selected.length}`;
    if (!seenPages.has(pageKey)) {
      seenPages.add(pageKey);
      seenKeys.add(chunkKey);
      selected.push(chunk);
    }
  }
  for (const chunk of pool) {
    if (selected.length >= maxChunks) break;
    const pageKey = `${chunk.filename || 'doc'}::${chunk.page_number || 1}`;
    const chunkKey = `${pageKey}::${chunk.chunk_index ?? 0}`;
    if (!seenKeys.has(chunkKey)) {
      seenKeys.add(chunkKey);
      selected.push(chunk);
    }
  }

  return selected.map((chunk) => ({
    filename: chunk.filename,
    page: chunk.page_number,
    section: chunk.section_title || undefined,
    locator: chunk.locator || undefined,
    text: String(chunk.raw_text || '').slice(0, maxChars),
  }));
}

async function applyFollowUpIdChaining(
  tablePlan,
  businessId,
  prompt,
  normalizedHistory,
  activeCtx
) {
  const shouldChainPriorIds =
    normalizedHistory.length > 0 &&
    Array.isArray(activeCtx?.matchedRowIds) &&
    activeCtx.matchedRowIds.length > 0 &&
    hasFollowUpReference(prompt) &&
    !hasExplicitScopeReset(prompt);
  const logic = String(tablePlan.filterLogic || tablePlan.filter_logic || 'AND').toUpperCase();
  if (
    !shouldChainPriorIds ||
    logic !== 'AND' ||
    (activeCtx.activeTargetTable &&
      tablePlan.table.tableName.toLowerCase() !== activeCtx.activeTargetTable.toLowerCase())
  ) {
    return;
  }
  const idFilter = await resolveIdentifierFilterForIds(
    tablePlan.table.schema,
    businessId,
    activeCtx.matchedRowIds,
    query,
    quoteIdentifier
  );
  if (
    idFilter &&
    !tablePlan.filters.some(
      (f) => String(f.field || '').toLowerCase() === idFilter.field.toLowerCase()
    )
  ) {
    tablePlan.filters.push(validateFilter(tablePlan.table.schema, idFilter));
  }
}

async function generateCrossSourceReadAnswer({
  businessId,
  prompt,
  targetEntities = [],
  conversationHistory = [],
  prefetchedTables = null,
  prefetchedChunks = null,
  prefetchedMetadata = null,
  preferredEntity = null,
  prevalidatedPlan = null,
  interpretationNote = '',
}) {
  const normalizedHistory = normalizeConversationHistory(conversationHistory);
  const activeCtx = getLatestActiveContext(
    normalizedHistory,
    Array.isArray(targetEntities) && targetEntities.length > 0 ? targetEntities[0] : null
  );
  const effectiveTargetEntities =
    Array.isArray(targetEntities) && targetEntities.length > 0
      ? targetEntities
      : activeCtx.activeTargetTable
        ? [activeCtx.activeTargetTable]
        : [];
  const chunks =
    Array.isArray(prefetchedChunks) && prefetchedChunks.length > 0
      ? prefetchedChunks
      : await retrieveHybridDocumentChunks(businessId, prompt, {
          topK: 8,
        });
  let tables = [];
  if (Array.isArray(prefetchedTables) && prefetchedTables.length > 0) {
    if (effectiveTargetEntities.length > 0) {
      const normalizedTargets = effectiveTargetEntities.map((t) =>
        normalizeEntityName(String(t || '').replace(/\.(csv|xlsx?|tsv)$/i, '')).toLowerCase()
      );
      const filtered = prefetchedTables.filter((t) =>
        normalizedTargets.includes(normalizeEntityName(t.tableName).toLowerCase())
      );
      tables = filtered.length > 0 ? filtered : prefetchedTables;
    } else {
      tables = selectRelevantTablesForRead(
        prefetchedTables,
        prompt,
        chunks,
        activeCtx.activeTargetTable || null
      );
    }
  } else {
    const discovered = await discoverWorkspaceSources(businessId, {
      targetEntities: effectiveTargetEntities,
      includeRows: false,
      prefetchedMetadata,
    });
    tables =
      effectiveTargetEntities.length > 0
        ? discovered.tables
        : selectRelevantTablesForRead(
            discovered.tables,
            prompt,
            chunks,
            activeCtx.activeTargetTable || null
          );
  }
  if (tables.length === 0 && chunks.length === 0) {
    return {
      message: 'No matching workspace table or document source was found. Please select or upload the relevant source.',
      answer: 'No matching workspace table or document source was found. Please select or upload the relevant source.',
      rows: [],
      highlighted_rows: [],
      citations: [],
    };
  }

  const currentDateIso = new Date().toISOString().slice(0, 10);
  const formattedHistory = formatConversationHistoryForPrompt(normalizedHistory);
  const historySection = formattedHistory
    ? `\nCONVERSATION CONTEXT (last ${normalizedHistory.length} turn(s); prior active table: ${activeCtx.activeTargetTable || 'none'}; prior matched_row_ids: ${JSON.stringify((activeCtx.matchedRowIds || []).slice(0, 40))}; prior filter summary: ${JSON.stringify(activeCtx.appliedFilterSummary || '')}):\n${formattedHistory}\n- FOLLOW-UP CHAINING RULE: If LATEST USER REQUEST uses pronouns/narrowing cues ("those", "them", "these", "of those", "only the ones...") referring to prior results on ${activeCtx.activeTargetTable || 'a prior table'}, chain the prior active filters/matched_row_ids with any new filter conditions.\n`
    : '';

  const compactSchemas = tables.map((table) => {
    const { table: tableNameKey, ...rest } = serializeTableForPrompt(table, {
      includeMutability: false,
    });
    return {
      table_name: tableNameKey,
      ...rest,
    };
  });
  const planPassages = selectPassagesForRead(chunks, { maxChunks: 6, maxChars: 800 });
  const hasPrevalidatedPlan =
    Array.isArray(prevalidatedPlan) && prevalidatedPlan.length > 0;
  const synthesisPassages = selectPassagesForRead(
    chunks,
    hasPrevalidatedPlan
      ? { maxChunks: 5, maxChars: 650 }
      : { maxChunks: 8, maxChars: 850 }
  );

  let plan = hasPrevalidatedPlan ? prevalidatedPlan : null;
  if (!plan) {
    const planPrompt = `Create a read-only query plan for the latest user request using only these active workspace sources.
Return structured JSON only. Never return SQL.
CURRENT_DATE (UTC): ${currentDateIso}
- Select only tables needed to answer the request.
- Use exact column names and supported filter operators from the schema.
- If the user uses conceptual, colloquial, or status-adjacent terms that do not match an exact column name, inspect all column names, summary, range, and categorical values in ACTIVE TABLE SCHEMAS to infer the closest valid column(s) and enum value(s) on the first attempt—never invent non-existent column names.
- Apply document-derived eligibility criteria as filters and use AND/OR only as requested by the documents or user.
- DOCUMENT-ENUMERATED CODES / EXCLUSIONS RULE: When the documents list specific batch codes, SKUs, unit IDs, or identifiers as qualifying/recalled (check ALL pages/addendums in RELEVANT DOCUMENT PASSAGES) and exclude others, filter explicitly on those qualifying codes (e.g., "in" filter) rather than running an unfiltered full-table scan.
- DATE / DORMANCY DIRECTION RULE: When checking "inactive for > N days", "no payment in N+ days", or "older than N days" against CURRENT_DATE (${currentDateIso}), a date column MUST be EARLIER (use "less_than_or_equal" or "less_than" with YYYY-MM-DD = CURRENT_DATE minus N days, never "greater_than").
- If the request asks multiple distinct sub-questions or cohorts on the same table (for example, specific unit IDs plus a department cohort, or breaching POs plus in-transit/sea rows linked to backorders), emit separate entries in table_queries or combine criteria with filter_logic: "OR" so no requested cohort is dropped.
- Filter strictly on selection conditions, never on display attributes (for example, when asked which products have discount >= 35% with their Best-Seller flag, filter ONLY discount >= 35, not best = true).
- Numeric summaries must use aggregates; row formulas must list exact numeric columns and an arithmetic operation. Derived numeric thresholds (for example, column A minus column B >= a policy threshold) must be emitted as calculation_filters so PostgreSQL applies them before returning rows.
- Do not infer fields absent from the schemas. If no safe query can be formed, return an empty table_queries array.
- A query with no filters is allowed only when the user explicitly asks for a full-table listing or a whole-table aggregate.
- Return ONLY JSON with key "table_queries": array of { "table_name": string, "filters": [{ "field": string, "operator": "equals"|"not_equals"|"contains"|"not_contains"|"starts_with"|"ends_with"|"in"|"greater_than"|"greater_than_or_equal"|"less_than"|"less_than_or_equal"|"between"|"relative_days_ago"|"this_month", "value": string }], "calculation_filters": [{ "operation": "add"|"subtract"|"multiply"|"divide", "fields": [string, string], "operator": "greater_than"|"greater_than_or_equal"|"less_than"|"less_than_or_equal"|"equals"|"not_equals"|"between", "value": string }], "filter_logic": "AND"|"OR", "sort": [{ "field": string, "direction": "asc"|"desc" }], "limit": number, "aggregates": [{ "operation": "count"|"sum"|"average"|"min"|"max", "field": string }], "calculations": [{ "operation": "add"|"subtract"|"multiply"|"divide", "fields": [string, string], "aggregate": "count"|"sum"|"average"|"min"|"max" }] }.

ACTIVE TABLE SCHEMAS:
${JSON.stringify(compactSchemas)}

RELEVANT DOCUMENT PASSAGES:
${JSON.stringify(planPassages)}
${historySection}
LATEST USER REQUEST:
${prompt}`;

    plan = await generateStructuredJsonWithRetry(
      planPrompt,
      (parsed) => validateReadPlan(parsed, tables, prompt, chunks),
      { maxRetries: 1, responseSchema: null, stage: 'cross_source_read_plan' }
    );
  }
  if (plan.length === 0 && tables.length > 0) {
    return {
      message: 'I could not safely translate this question into a query over the active workspace columns. Please clarify the table or criteria.',
      answer: 'I could not safely translate this question into a query over the active workspace columns. Please clarify the table or criteria.',
      rows: [],
      highlighted_rows: [],
      citations: chunks.slice(0, 8).map(buildDocumentCitation),
    };
  }

  const results = [];
  for (const tablePlan of plan) {
    await applyFollowUpIdChaining(
      tablePlan,
      businessId,
      prompt,
      normalizedHistory,
      activeCtx
    );
    const execution = await executeReadQuery(businessId, tablePlan);
    results.push({
      table_name: tablePlan.table.tableName,
      schema: tablePlan.table.schema,
      rows: execution.rows,
      row_count: execution.summary._row_count,
      aggregates: tablePlan.aggregates.map((aggregate, index) => ({
        operation: aggregate.operation,
        field: aggregate.field,
        value: execution.summary[`_aggregate_${index + 1}`],
      })),
      calculations: tablePlan.calculations.map((calculation, index) => ({
        operation: calculation.operation,
        fields: calculation.fields,
        row_values: execution.rows.slice(0, 30).map((row) => row[`_calculation_${index + 1}`]),
        aggregate: calculation.aggregate
          ? {
              operation: calculation.aggregate,
              value: execution.summary[`_calculation_aggregate_${index + 1}`],
            }
          : null,
      })),
    });
  }

  const referencedTextLower = [
    prompt,
    ...planPassages.map((p) => `${p.section || ''} ${p.text || ''}`),
  ]
    .join('\n')
    .toLowerCase();

  const compactRowForSynthesis = (row, idx, schema) => {
    const out = { _row_id: resolveRowIdentifier(row, idx + 1, schema) };
    const skipCols = new Set([
      'business_id',
      'workspace_id',
      'user_id',
      'workspace_document_id',
      'created_at',
      'updated_at',
      'images',
      '_google_row_index',
    ]);
    const verboseCols = new Set([
      'description',
      'notes',
      'comments',
      'summary',
      'product_url',
      'url',
      'image_url',
    ]);
    for (const [k, v] of Object.entries(row || {})) {
      const lower = k.toLowerCase();
      if (skipCols.has(lower)) continue;
      if (v === null || v === undefined) continue;
      if (typeof v === 'string') {
        const trimmed = v.trim();
        if (!trimmed) continue;
        if (verboseCols.has(lower) && !referencedTextLower.includes(lower)) {
          if (lower.includes('url')) continue;
          if (trimmed.length > 60) {
            out[k] = `${trimmed.slice(0, 57)}...`;
            continue;
          }
        }
        out[k] = trimmed.length > 160 ? `${trimmed.slice(0, 157)}...` : trimmed;
      } else {
        out[k] = v;
      }
    }
    return out;
  };

  let highlightedRows = results.flatMap((result) =>
    result.rows.slice(0, 100).map((row, index) => ({
      table_name: result.table_name,
      schema: result.schema,
      row_identifier: resolveRowIdentifier(row, index + 1, result.schema),
      row_data: row,
    }))
  );
  const synthesisSqlOutput = results.map((result) => ({
    table_name: result.table_name,
    row_count: result.row_count,
    aggregates: result.aggregates,
    calculations: result.calculations,
    rows: result.rows.slice(0, 30).map((row, index) => compactRowForSynthesis(row, index, result.schema)),
  }));
  const synthesisPrompt = `Answer the user's read-only workspace question using only the verified query output and retrieved document passages.
Never propose or execute mutations. Do not invent missing facts. Use exact counts, values, units, and negative signs from the SQL results. Explain uncertainty when the retrieved data cannot answer.
Check EVERY row in VERIFIED SQL OUTPUT against EVERY sub-question and policy rule (comparing date columns such as last_payment_date against CURRENT_DATE for > 90 day dormancy checks, checking exclusions/addendums, and linking SKUs/items across tables) before stating any category is empty.
Return JSON with:
1. "answer": concise grounded factual answer.
2. "matched_row_ids": array of exact "_row_id" strings from VERIFIED SQL OUTPUT whose rows ACTUALLY qualify and satisfy the user question and ALL governing document criteria (return [] if zero rows qualify or if excluded; never include rejected or merely contextual rows).

CURRENT_DATE (UTC): ${currentDateIso}
${interpretationNote ? `\nMAPPING NOTE FROM PLANNER: ${interpretationNote}` : ''}

USER QUESTION:
${prompt}

VERIFIED SQL OUTPUT:
${JSON.stringify(synthesisSqlOutput)}

RELEVANT DOCUMENT PASSAGES:
${JSON.stringify(synthesisPassages)}`;
  const synthesisResult = await generateStructuredJsonWithRetry(
    synthesisPrompt,
    (parsed) => {
      const text = String(parsed?.answer || '').trim();
      if (!text) throw new AppError('The read answer was empty.', 502);
      const rawMatchedIds = Array.isArray(parsed?.matched_row_ids) ? parsed.matched_row_ids : null;
      return { answer: text, matchedRowIds: rawMatchedIds };
    },
    {
      maxRetries: 1,
      responseSchema: null,
      stage: 'cross_source_read_synthesis',
    }
  );
  const answer = synthesisResult.answer;
  if (Array.isArray(synthesisResult.matchedRowIds)) {
    const allowedNormalized = new Set(
      synthesisResult.matchedRowIds
        .map((id) => String(id || '').trim().toLowerCase())
        .filter(Boolean)
    );
    highlightedRows = highlightedRows.filter((entry) =>
      allowedNormalized.has(String(entry.row_identifier || '').trim().toLowerCase())
    );
  }
  const dedupedHighlightedRows = [];
  const seenRowKeys = new Set();
  for (const entry of highlightedRows) {
    const key = `${String(entry.table_name || '').toLowerCase()}::${String(entry.row_identifier || '').trim().toLowerCase()}`;
    if (!seenRowKeys.has(key)) {
      seenRowKeys.add(key);
      dedupedHighlightedRows.push(entry);
    }
  }
  highlightedRows = dedupedHighlightedRows;
  if (preferredEntity && highlightedRows.length > 1) {
    const normalizedPreferred = normalizeEntityName(
      String(preferredEntity).replace(/\.(csv|xlsx?|tsv)$/i, '')
    ).toLowerCase();
    highlightedRows = [
      ...highlightedRows.filter(
        (entry) => normalizeEntityName(entry.table_name).toLowerCase() === normalizedPreferred
      ),
      ...highlightedRows.filter(
        (entry) => normalizeEntityName(entry.table_name).toLowerCase() !== normalizedPreferred
      ),
    ];
  }
  const cleanHighlightedRows = highlightedRows.map(({ table_name, row_identifier, row_data }) => ({
    table_name,
    row_identifier,
    row_data,
  }));
  const rowCitations = cleanHighlightedRows
    .slice(0, 8)
    .map((entry, index) => buildTableRowCitation(entry.table_name, entry.row_data, index + 1));
  return {
    message: answer,
    answer,
    rows: cleanHighlightedRows.map((entry) => ({ table_name: entry.table_name, ...entry.row_data })),
    highlighted_rows: cleanHighlightedRows,
    citations: [
      ...chunks.slice(0, 8).map(buildDocumentCitation),
      ...rowCitations,
    ],
  };
}

/**
 * Executes a single-table read plan already validated during unified `route_and_plan`,
 * completing SQL execution and deterministic response formatting in 0 extra LLM calls (1 LLM call total).
 *
 * @param {object} params
 * @returns {Promise<object>}
 */
async function executePreplannedSheetQuery({
  businessId,
  prompt,
  plan = [],
  interpretationNote = '',
  conversationHistory = [],
}) {
  const tablePlan = Array.isArray(plan) ? plan[0] : plan;
  if (!tablePlan?.table) {
    throw new AppError('Invalid preplanned single-table query.', 400);
  }
  const normalizedHistory = normalizeConversationHistory(conversationHistory);
  const activeCtx = getLatestActiveContext(normalizedHistory, tablePlan.table.tableName);
  await applyFollowUpIdChaining(
    tablePlan,
    businessId,
    prompt,
    normalizedHistory,
    activeCtx
  );

  const execution = await executeReadQuery(businessId, tablePlan);
  const rows = Array.isArray(execution.rows) ? execution.rows : [];
  const tableName = tablePlan.table.tableName;
  const schema = tablePlan.table.schema;

  const highlightedRows = buildHighlightedRows(tableName, rows).map((entry, idx) => ({
    ...entry,
    row_identifier: resolveRowIdentifier(entry.row_data, idx + 1, schema),
  }));

  const interpretedSummary = {
    filters: tablePlan.filters,
    filter_logic: tablePlan.filterLogic,
  };
  const baseSummary = buildDeterministicQuerySummary({
    prompt: String(prompt || '').trim(),
    tableName,
    interpreted: interpretedSummary,
    rows,
    schema,
  });

  const metricParts = [];
  for (let i = 0; i < (tablePlan.aggregates || []).length; i += 1) {
    const agg = tablePlan.aggregates[i];
    const val = execution.summary?.[`_aggregate_${i + 1}`];
    if (val !== undefined && val !== null) {
      metricParts.push(`${agg.operation}(${agg.field || '*'}) = ${val}`);
    }
  }
  for (let i = 0; i < (tablePlan.calculations || []).length; i += 1) {
    const calc = tablePlan.calculations[i];
    if (calc.aggregate) {
      const val = execution.summary?.[`_calculation_aggregate_${i + 1}`];
      if (val !== undefined && val !== null) {
        metricParts.push(`${calc.aggregate}(${calc.operation}(${calc.fields.join(', ')})) = ${val}`);
      }
    }
  }

  const note = String(interpretationNote || '').trim();
  const metricSuffix = metricParts.length > 0 ? ` [${metricParts.join('; ')}]` : '';
  const answer = note
    ? `${note} ${baseSummary}${metricSuffix}`
    : `${baseSummary}${metricSuffix}`;

  const appliedFilterParts = [
    ...tablePlan.filters.map((f) => `${f.field} ${f.operator} ${JSON.stringify(f.value)}`),
    ...(tablePlan.calculationFilters || []).map(
      (cf) => `${cf.expression} ${cf.operator} ${JSON.stringify(cf.value)}`
    ),
  ];
  const appliedFilterSummary = appliedFilterParts.join(` ${tablePlan.filterLogic || 'AND'} `);

  return {
    status: 'SHEET_QUERY',
    query_status: 'ok',
    intent: 'sheet_query',
    entity: schema.entity || tableName,
    prompt,
    message: answer,
    answer,
    count: rows.length,
    rows,
    matched_ids: highlightedRows.map((h) => h.row_identifier),
    highlighted_rows: highlightedRows,
    interpretedQuery: {
      entity: schema.entity || tableName,
      operation: 'filter',
      filter_logic: tablePlan.filterLogic || 'AND',
      filters: tablePlan.filters,
      sort: tablePlan.sort || [],
      limit: tablePlan.limit || null,
    },
    applied_filter_summary: appliedFilterSummary,
    fast_path: false,
    citations: rows.slice(0, 8).map((row, idx) =>
      buildTableRowCitation(tableName, row, idx + 1)
    ),
  };
}

module.exports = {
  READ_PLAN_SCHEMA,
  selectRelevantTablesForRead,
  selectPassagesForRead,
  validateReadPlan,
  buildArithmeticExpression,
  extractDocumentArithmeticFilters,
  executeReadQuery,
  executePreplannedSheetQuery,
  generateCrossSourceReadAnswer,
};
