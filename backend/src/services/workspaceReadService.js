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
const { findColumnDef, quoteIdentifier, validateFilter, validateSort } = require('./sheetSchemaService');

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

async function generateCrossSourceReadAnswer({ businessId, prompt, targetEntities = [] }) {
  const { tables } = await discoverWorkspaceSources(businessId, {
    targetEntities,
    includeRows: false,
  });
  const chunks = await retrieveHybridDocumentChunks(businessId, prompt, {
    topK: 10,
  });
  if (tables.length === 0 && chunks.length === 0) {
    return {
      message: 'No matching workspace table or document source was found. Please select or upload the relevant source.',
      answer: 'No matching workspace table or document source was found. Please select or upload the relevant source.',
      rows: [],
      highlighted_rows: [],
      citations: [],
    };
  }

  const planPrompt = `Create a read-only query plan for the latest user request using only these active workspace sources.
Return structured JSON only. Never return SQL.
- Select only tables needed to answer the request.
- Use exact column names and supported filter operators from the schema.
- Apply document-derived eligibility criteria as filters and use AND/OR only as requested by the documents or user.
- If the request asks multiple distinct sub-questions or cohorts on the same table (for example, specific unit IDs plus a department cohort, or breaching POs plus in-transit/sea rows linked to backorders), emit separate entries in table_queries or combine criteria with filter_logic: "OR" so no requested cohort is dropped.
- Filter strictly on selection conditions, never on display attributes (for example, when asked which products have discount >= 35% with their Best-Seller flag, filter ONLY discount >= 35, not best = true).
- Numeric summaries must use aggregates; row formulas must list exact numeric columns and an arithmetic operation. Derived numeric thresholds (for example, column A minus column B >= a policy threshold) must be emitted as calculation_filters so PostgreSQL applies them before returning rows.
- Do not infer fields absent from the schemas. If no safe query can be formed, return an empty table_queries array.
- A query with no filters is allowed only when the user explicitly asks for a full-table listing or a whole-table aggregate.

ACTIVE TABLE SCHEMAS:
${JSON.stringify(tables.map((table) => ({
    table_name: table.tableName,
    row_count: table.rowCount,
    columns: Object.values(table.schema.columns || {}).map((column) => ({
      name: column.exactName,
      type: column.type,
      queryable: Boolean(column.queryable),
      description: column.description || undefined,
      representative_values: table.schema.representativeValues?.[column.exactName]?.slice(0, 5),
    })),
  })))}

RELEVANT DOCUMENT PASSAGES:
${JSON.stringify(chunks.map((chunk) => ({
    filename: chunk.filename,
    section: chunk.section_title,
    breadcrumb: chunk.breadcrumb_header,
    text: String(chunk.raw_text || '').slice(0, 1500),
  })))}

LATEST USER REQUEST:
${prompt}`;

  const plan = await generateStructuredJsonWithRetry(
    planPrompt,
    (parsed) => validateReadPlan(parsed, tables, prompt, chunks),
    { maxRetries: 1, responseSchema: READ_PLAN_SCHEMA, stage: 'cross_source_read_plan' }
  );
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
    const execution = await executeReadQuery(businessId, tablePlan);
    results.push({
      table_name: tablePlan.table.tableName,
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

  const highlightedRows = results.flatMap((result) =>
    result.rows.slice(0, 100).map((row, index) => ({
      table_name: result.table_name,
      row_identifier: resolveRowIdentifier(row, index + 1),
      row_data: row,
    }))
  );
  const rowCitations = results.flatMap((result) =>
    result.rows.slice(0, 8).map((row, index) =>
      buildTableRowCitation(result.table_name, row, index + 1)
    )
  );
  const currentDateIso = new Date().toISOString().slice(0, 10);
  const synthesisPrompt = `Answer the user's read-only workspace question using only the verified query output and retrieved document passages.
Never propose or execute mutations. Do not invent missing facts. Use exact counts, values, units, and negative signs from the SQL results. Explain uncertainty when the retrieved data cannot answer.
Check EVERY row in VERIFIED SQL OUTPUT against EVERY sub-question and policy rule (comparing date columns such as last_payment_date against CURRENT_DATE for > 90 day dormancy checks, and linking SKUs/items across tables) before stating any category is empty.
Return JSON only with one concise "answer" string.

CURRENT_DATE (UTC): ${currentDateIso}

USER QUESTION:
${prompt}

VERIFIED SQL OUTPUT:
${JSON.stringify(results.map((result) => ({
    table_name: result.table_name,
    row_count: result.row_count,
    aggregates: result.aggregates,
    calculations: result.calculations,
    rows: result.rows.slice(0, 30),
  })))}

RELEVANT DOCUMENT PASSAGES:
${JSON.stringify(chunks.slice(0, 10).map((chunk) => ({
    filename: chunk.filename,
    locator: chunk.locator,
    text: String(chunk.raw_text || '').slice(0, 1200),
  })))}`;
  const answer = await generateStructuredJsonWithRetry(
    synthesisPrompt,
    (parsed) => {
      const text = String(parsed?.answer || '').trim();
      if (!text) throw new AppError('The read answer was empty.', 502);
      return text;
    },
    {
      maxRetries: 1,
      responseSchema: {
        type: 'OBJECT',
        properties: { answer: { type: 'STRING' } },
        required: ['answer'],
      },
      stage: 'cross_source_read_synthesis',
    }
  );
  return {
    message: answer,
    answer,
    rows: highlightedRows.map((entry) => ({ table_name: entry.table_name, ...entry.row_data })),
    highlighted_rows: highlightedRows,
    citations: [
      ...chunks.slice(0, 8).map(buildDocumentCitation),
      ...rowCitations,
    ],
  };
}

module.exports = {
  READ_PLAN_SCHEMA,
  validateReadPlan,
  buildArithmeticExpression,
  extractDocumentArithmeticFilters,
  executeReadQuery,
  generateCrossSourceReadAnswer,
};
