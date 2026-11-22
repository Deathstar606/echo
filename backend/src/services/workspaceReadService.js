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
const {
  serializeTableForPrompt,
  SCHEMA_TRUTH_PRECEDENCE_RULE,
} = require('../utils/schemaPromptSerializer');
const {
  buildDeterministicQuerySummary,
  buildHighlightedRows,
} = require('./fastTableQueryService');

const SORT_ITEM_SCHEMA = {
  type: 'OBJECT',
  properties: {
    field: { type: 'STRING' },
    direction: { type: 'STRING', enum: ['asc', 'desc'] },
  },
  required: ['field', 'direction'],
};

const READ_PLAN_SCHEMA = {
  type: 'OBJECT',
  properties: {
    table_queries: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          query_id: { type: 'STRING' },
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
            items: SORT_ITEM_SCHEMA,
          },
          order_by: {
            type: 'ARRAY',
            items: SORT_ITEM_SCHEMA,
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
    dependent_lookups: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          lookup_id: { type: 'STRING' },
          source_query_id: { type: 'STRING' },
          source_join_column: { type: 'STRING' },
          target_table: { type: 'STRING' },
          target_join_column: { type: 'STRING' },
          fallback_source_join_column: { type: 'STRING' },
          fallback_target_join_column: { type: 'STRING' },
          match_mode: {
            type: 'STRING',
            enum: ['exact', 'case_insensitive', 'normalized_string'],
          },
        },
        required: ['source_query_id', 'source_join_column', 'target_table', 'target_join_column'],
      },
    },
    cross_table_comparisons: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          left_source: { type: 'STRING' },
          left_column: { type: 'STRING' },
          operator: { type: 'STRING', enum: ['-', '+', '*', '/'] },
          right_source: { type: 'STRING' },
          right_column: { type: 'STRING' },
          result_alias: { type: 'STRING' },
          threshold_filter: {
            type: 'OBJECT',
            properties: {
              op: { type: 'STRING', enum: ['<', '<=', '>', '>=', '==', '!='] },
              value: { type: 'NUMBER' },
            },
            required: ['op', 'value'],
          },
        },
        required: ['left_source', 'left_column', 'operator', 'right_source', 'right_column', 'result_alias'],
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

const CROSS_TABLE_OPERATOR_MAP = {
  '-': '-',
  subtract: '-',
  minus: '-',
  '+': '+',
  add: '+',
  plus: '+',
  '*': '*',
  multiply: '*',
  '/': '/',
  divide: '/',
};

const THRESHOLD_OP_MAP = {
  '<': '<',
  less_than: '<',
  '<=': '<=',
  less_than_or_equal: '<=',
  '>': '>',
  greater_than: '>',
  '>=': '>=',
  greater_than_or_equal: '>=',
  '==': '==',
  '=': '==',
  equals: '==',
  '!=': '!=',
  '<>': '!=',
  not_equals: '!=',
};

const VALID_MATCH_MODES = new Set(['exact', 'case_insensitive', 'normalized_string']);

function validateReadPlan(rawPlan, tables, userPrompt = '', documentChunks = []) {
  if (!rawPlan || !Array.isArray(rawPlan.table_queries)) {
    throw new AppError('The read planner did not return a table query plan.', 502);
  }
  const byName = new Map(tables.map((table) => [table.tableName.toLowerCase(), table]));
  const rawLookups = Array.isArray(rawPlan.dependent_lookups) ? rawPlan.dependent_lookups : [];
  const rawComparisons = Array.isArray(rawPlan.cross_table_comparisons)
    ? rawPlan.cross_table_comparisons
    : [];
  const referencedAnchorIds = new Set(
    rawLookups
      .map((item) => String(item?.source_query_id || '').trim().toLowerCase())
      .filter(Boolean)
  );
  const isMultiTablePlan = rawPlan.table_queries.length > 1 || rawLookups.length > 0;

  const plans = rawPlan.table_queries.map((rawQuery, queryIndex) => {
    const tableName = String(rawQuery?.table_name || '').trim();
    const table = byName.get(tableName.toLowerCase());
    if (!table) {
      throw new AppError(`Read planner referenced an unavailable table "${tableName}".`, 502);
    }
    if (getTenantColumns(table.schema).length === 0) {
      throw new AppError(`Table "${tableName}" is not scoped to a business workspace.`, 400);
    }
    const queryId =
      String(rawQuery?.query_id || '').trim() || `q_${queryIndex + 1}`;
    const promotedCalculationFilters = [];
    const filters = [];
    for (const filter of Array.isArray(rawQuery.filters) ? rawQuery.filters : []) {
      let value = filter?.value;
      const opLower = String(filter?.operator || '').trim().toLowerCase();
      if (typeof value === 'string' && ['in', 'between'].includes(opLower)) {
        try {
          value = JSON.parse(value);
        } catch {
          value = value.split(',').map((part) => part.trim()).filter(Boolean);
        }
      }
      // Auto-normalize same-table column-to-column numeric comparisons (e.g., field: "col_a",
      // operator: "less_than", value: "col_b") into SQL calculationFilters: (col_a - col_b) <op> 0.
      if (
        typeof value === 'string' &&
        [
          'equals',
          'not_equals',
          'greater_than',
          'greater_than_or_equal',
          'less_than',
          'less_than_or_equal',
        ].includes(opLower)
      ) {
        const leftDef = findColumnDef(table.schema, String(filter?.field || '').trim());
        const rightDef = findColumnDef(table.schema, value.trim());
        if (
          leftDef &&
          rightDef &&
          leftDef.exactName !== rightDef.exactName &&
          ['number', 'integer'].includes(leftDef.colDef.type) &&
          ['number', 'integer'].includes(rightDef.colDef.type)
        ) {
          promotedCalculationFilters.push({
            expression: `(${quoteIdentifier(leftDef.exactName)}::numeric - ${quoteIdentifier(rightDef.exactName)}::numeric)`,
            operator: opLower,
            value: 0,
          });
          continue;
        }
      }
      filters.push(validateFilter(table.schema, { ...filter, value }));
    }
    const calculationFilters = [
      ...promotedCalculationFilters,
      ...(Array.isArray(rawQuery.calculation_filters) ? rawQuery.calculation_filters : []).map(
        (item) => {
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
    }),
    ];
    const rawSortList =
      Array.isArray(rawQuery.order_by) && rawQuery.order_by.length > 0
        ? rawQuery.order_by
        : Array.isArray(rawQuery.sort)
          ? rawQuery.sort
          : [];
    const sort = validateSort(table.schema, rawSortList);
    const parsedLimit =
      rawQuery.limit !== undefined && rawQuery.limit !== null && rawQuery.limit !== ''
        ? Number(rawQuery.limit)
        : null;
    const hasExplicitBoundedLimit =
      parsedLimit !== null && Number.isInteger(parsedLimit) && parsedLimit >= 1 && parsedLimit <= 200;
    const limit = hasExplicitBoundedLimit ? parsedLimit : 100;

    const explicitWholeTableRequest =
      /\b(?:all\s+(?:rows|records|entries)|entire\s+(?:table|dataset)|whole\s+(?:table|dataset)|overall|across\s+(?:all\s+(?:rows|records|entries)|all\s+(?:\w+\s+){0,2}tables?))\b/i.test(
        userPrompt
      );
    const isReferencedByLookup = referencedAnchorIds.has(queryId.toLowerCase());
    const knownRowCount = Number.isFinite(Number(table.rowCount))
      ? Number(table.rowCount)
      : Number.isFinite(Number(table.metadata?.row_count))
        ? Number(table.metadata.row_count)
        : null;
    const isSmallCrossTableScan =
      isMultiTablePlan && knownRowCount !== null && knownRowCount <= 200;
    const isOrderedBoundedFetch = sort.length > 0 && hasExplicitBoundedLimit;

    if (
      filters.length === 0 &&
      calculationFilters.length === 0 &&
      !explicitWholeTableRequest &&
      !isReferencedByLookup &&
      !isSmallCrossTableScan &&
      !isOrderedBoundedFetch
    ) {
      throw new AppError(
        `A read query over "${tableName}" must include document- or user-grounded filters unless the user explicitly requests a whole-table result.`,
        400
      );
    }
    const filterLogic = String(rawQuery.filter_logic || 'AND').toUpperCase() === 'OR'
      ? 'OR'
      : 'AND';
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
      queryId,
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

  const sourceTableById = new Map();
  for (const planItem of plans) {
    sourceTableById.set(planItem.queryId.toLowerCase(), {
      sourceId: planItem.queryId,
      table: planItem.table,
    });
  }

  const validatedLookups = rawLookups.map((rawLookup, lookupIndex) => {
    const lookupId =
      String(rawLookup?.lookup_id || '').trim() || `lookup_${lookupIndex + 1}`;
    const rawSourceQueryId = String(rawLookup?.source_query_id || '').trim();
    let sourceEntry = sourceTableById.get(rawSourceQueryId.toLowerCase()) || null;
    if (!sourceEntry && plans.length === 1 && !rawSourceQueryId) {
      sourceEntry = sourceTableById.get(plans[0].queryId.toLowerCase());
    }
    if (!sourceEntry) {
      throw new AppError(
        `Dependent lookup "${lookupId}" references unknown source_query_id "${rawSourceQueryId}". Valid query_ids: ${plans.map((p) => p.queryId).join(', ')}.`,
        400
      );
    }

    const targetTableName = String(rawLookup?.target_table || '').trim();
    const targetTable = byName.get(targetTableName.toLowerCase());
    if (!targetTable) {
      throw new AppError(
        `Dependent lookup "${lookupId}" referenced an unavailable target_table "${targetTableName}".`,
        502
      );
    }
    if (getTenantColumns(targetTable.schema).length === 0) {
      throw new AppError(
        `Lookup table "${targetTableName}" is not scoped to a business workspace.`,
        400
      );
    }

    const srcColDef = findColumnDef(
      sourceEntry.table.schema,
      String(rawLookup?.source_join_column || '').trim()
    );
    if (!srcColDef) {
      throw new AppError(
        `Dependent lookup "${lookupId}" references unknown source_join_column "${rawLookup?.source_join_column}" on "${sourceEntry.table.tableName}".`,
        400
      );
    }

    const tgtColDef = findColumnDef(
      targetTable.schema,
      String(rawLookup?.target_join_column || '').trim()
    );
    if (!tgtColDef) {
      throw new AppError(
        `Dependent lookup "${lookupId}" references unknown target_join_column "${rawLookup?.target_join_column}" on "${targetTable.tableName}".`,
        400
      );
    }

    let fallbackSourceJoinColumn = null;
    let fallbackTargetJoinColumn = null;
    const rawFallbackSrc = String(rawLookup?.fallback_source_join_column || '').trim();
    const rawFallbackTgt = String(rawLookup?.fallback_target_join_column || '').trim();
    if (rawFallbackSrc && rawFallbackTgt) {
      const fbSrcDef = findColumnDef(sourceEntry.table.schema, rawFallbackSrc);
      const fbTgtDef = findColumnDef(targetTable.schema, rawFallbackTgt);
      if (fbSrcDef && fbTgtDef) {
        fallbackSourceJoinColumn = fbSrcDef.exactName;
        fallbackTargetJoinColumn = fbTgtDef.exactName;
      }
    }

    const rawMode = String(rawLookup?.match_mode || 'case_insensitive')
      .trim()
      .toLowerCase();
    const matchMode = VALID_MATCH_MODES.has(rawMode) ? rawMode : 'case_insensitive';

    sourceTableById.set(lookupId.toLowerCase(), {
      sourceId: lookupId,
      table: targetTable,
    });

    return {
      lookupId,
      sourceQueryId: sourceEntry.sourceId,
      sourceTable: sourceEntry.table,
      sourceJoinColumn: srcColDef.exactName,
      targetTable,
      targetJoinColumn: tgtColDef.exactName,
      fallbackSourceJoinColumn,
      fallbackTargetJoinColumn,
      matchMode,
    };
  });

  const validatedComparisons = rawComparisons.map((rawComp, compIndex) => {
    const rawLeftSource = String(rawComp?.left_source || '').trim();
    const rawRightSource = String(rawComp?.right_source || '').trim();
    const leftSourceEntry = sourceTableById.get(rawLeftSource.toLowerCase());
    const rightSourceEntry = sourceTableById.get(rawRightSource.toLowerCase());
    if (!leftSourceEntry) {
      throw new AppError(
        `Cross-table comparison references unknown left_source "${rawLeftSource}".`,
        400
      );
    }
    if (!rightSourceEntry) {
      throw new AppError(
        `Cross-table comparison references unknown right_source "${rawRightSource}".`,
        400
      );
    }

    const leftColumn = numericColumn(
      leftSourceEntry.table.schema,
      String(rawComp?.left_column || '').trim()
    );
    const rightColumn = numericColumn(
      rightSourceEntry.table.schema,
      String(rawComp?.right_column || '').trim()
    );

    const rawOp = String(rawComp?.operator || '').trim().toLowerCase();
    const operator = CROSS_TABLE_OPERATOR_MAP[rawOp];
    if (!operator) {
      throw new AppError(
        `Unsupported cross-table comparison operator "${rawComp?.operator}".`,
        400
      );
    }

    const rawAlias = String(rawComp?.result_alias || '')
      .trim()
      .replace(/[^a-zA-Z0-9_]+/g, '_')
      .replace(/^_+|_+$/g, '');
    const resultAlias = rawAlias || `comparison_${compIndex + 1}`;

    let thresholdFilter = null;
    if (rawComp?.threshold_filter && typeof rawComp.threshold_filter === 'object') {
      const rawTfOp = String(rawComp.threshold_filter.op || '').trim().toLowerCase();
      const op = THRESHOLD_OP_MAP[rawTfOp];
      const value = Number(rawComp.threshold_filter.value);
      if (!op || !Number.isFinite(value)) {
        throw new AppError(
          `Invalid threshold_filter on cross-table comparison "${resultAlias}".`,
          400
        );
      }
      thresholdFilter = { op, value };
    }

    return {
      leftSource: leftSourceEntry.sourceId,
      leftColumn,
      operator,
      rightSource: rightSourceEntry.sourceId,
      rightColumn,
      resultAlias,
      thresholdFilter,
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
  const hasCrossTableThreshold = validatedComparisons.some((c) => Boolean(c.thresholdFilter));
  if (
    requiresDerivedEligibilityFilter &&
    !plans.some((plan) => plan.calculationFilters.length > 0) &&
    !hasCrossTableThreshold
  ) {
    throw new AppError(
      'This request requires an arithmetic eligibility condition. Include the document-derived calculation in calculation_filters or cross_table_comparisons before returning rows.',
      502
    );
  }

  plans.dependentLookups = validatedLookups;
  plans.crossTableComparisons = validatedComparisons;
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

function normalizeJoinKey(rawValue, matchMode = 'case_insensitive') {
  if (rawValue === null || rawValue === undefined) return '';
  const str = String(rawValue);
  if (matchMode === 'exact') {
    return str;
  }
  if (matchMode === 'normalized_string') {
    return str.trim().toLowerCase().replace(/\s+/g, ' ');
  }
  return str.trim().toLowerCase();
}

function evaluateCrossTableArithmetic(leftVal, operator, rightVal) {
  if (!Number.isFinite(leftVal) || !Number.isFinite(rightVal)) {
    return null;
  }
  let raw = null;
  if (operator === '-') raw = leftVal - rightVal;
  else if (operator === '+') raw = leftVal + rightVal;
  else if (operator === '*') raw = leftVal * rightVal;
  else if (operator === '/') {
    if (rightVal === 0) return null;
    raw = leftVal / rightVal;
  }
  if (raw === null || !Number.isFinite(raw)) return null;
  return Number.isInteger(raw) ? raw : Number(raw.toFixed(6));
}

function evaluateCrossTableThreshold(value, op, threshold) {
  if (!Number.isFinite(value) || !Number.isFinite(threshold)) {
    return false;
  }
  switch (op) {
    case '<':
      return value < threshold;
    case '<=':
      return value <= threshold;
    case '>':
      return value > threshold;
    case '>=':
      return value >= threshold;
    case '==':
      return value === threshold;
    case '!=':
      return value !== threshold;
    default:
      return false;
  }
}

async function runParameterizedKeyLookup(businessId, targetTable, targetColumn, keys, matchMode) {
  if (!Array.isArray(keys) || keys.length === 0) {
    return [];
  }
  const tenantColumns = getTenantColumns(targetTable.schema);
  const tenantPredicate =
    tenantColumns.length > 1
      ? `(${tenantColumns.map((column) => `${quoteIdentifier(column.exactName)} = $1`).join(' OR ')})`
      : `${quoteIdentifier(tenantColumns[0].exactName)} = $1`;
  const targetColSql = quoteIdentifier(targetColumn);
  let matchSql;
  if (matchMode === 'exact') {
    matchSql = `${targetColSql}::text = ANY($2::text[])`;
  } else if (matchMode === 'normalized_string') {
    matchSql = `REGEXP_REPLACE(LOWER(TRIM(${targetColSql}::text)), '\\s+', ' ', 'g') = ANY($2::text[])`;
  } else {
    matchSql = `LOWER(TRIM(${targetColSql}::text)) = ANY($2::text[])`;
  }
  const sql = `SELECT * FROM ${quoteIdentifier(targetTable.tableName)} WHERE ${tenantPredicate} AND ${matchSql};`;
  const res = await query(sql, [businessId, keys]);
  return Array.isArray(res?.rows) ? res.rows : [];
}

const INTERNAL_NON_BUSINESS_JOIN_COLS = new Set([
  'id',
  'business_id',
  'workspace_id',
  'user_id',
  'workspace_document_id',
  'created_at',
  'updated_at',
  '_google_row_index',
  'images',
  'image_url',
  'product_url',
  'url',
  'description',
  'notes',
  'comments',
]);

/**
 * Dynamically ranks candidate fallback join column pairs between two table schemas
 * when the primary join key yields unmatched anchor rows (e.g., if a planner picked
 * an internal UUID `id` column instead of a business key/name/code column).
 * Strictly metadata- and schema-driven; zero hardcoded domain names.
 */
function inferDynamicFallbackJoinPairs(
  sourceTable,
  targetTable,
  excludeSourceCol = '',
  excludeTargetCol = ''
) {
  const srcCols = Object.values(sourceTable?.schema?.columns || {}).filter((c) => {
    const lower = String(c?.exactName || '').toLowerCase();
    return (
      lower &&
      !INTERNAL_NON_BUSINESS_JOIN_COLS.has(lower) &&
      ['string', 'integer'].includes(c.type)
    );
  });
  const tgtCols = Object.values(targetTable?.schema?.columns || {}).filter((c) => {
    const lower = String(c?.exactName || '').toLowerCase();
    return (
      lower &&
      !INTERNAL_NON_BUSINESS_JOIN_COLS.has(lower) &&
      ['string', 'integer'].includes(c.type)
    );
  });
  const targetPkLower = String(
    targetTable?.metadata?.primary_key_column || targetTable?.schema?.primaryKey || ''
  )
    .trim()
    .toLowerCase();
  const targetTableStem = String(targetTable?.tableName || '')
    .toLowerCase()
    .replace(/s$/, '');

  const candidates = [];
  for (const sCol of srcCols) {
    const sLower = sCol.exactName.toLowerCase();
    const sTokens = sLower.split(/[^a-z0-9]+/).filter(Boolean);
    for (const tCol of tgtCols) {
      const tLower = tCol.exactName.toLowerCase();
      if (
        sLower === String(excludeSourceCol || '').toLowerCase() &&
        tLower === String(excludeTargetCol || '').toLowerCase()
      ) {
        continue;
      }
      if (sCol.type !== tCol.type) continue;

      let score = 0;
      if (sLower === tLower) score += 12;
      if (sLower.endsWith(`_${tLower}`) || tLower.endsWith(`_${sLower}`)) score += 10;
      if (targetTableStem.length >= 3 && sLower.includes(targetTableStem)) {
        score += 6;
      }
      if (targetPkLower && tLower === targetPkLower) {
        score += 4;
      }
      const tTokens = tLower.split(/[^a-z0-9]+/).filter(Boolean);
      const sharedSemanticTokens = sTokens.filter(
        (tok) => tok.length >= 3 && tTokens.includes(tok)
      );
      score += sharedSemanticTokens.length * 4;

      if (score >= 8) {
        candidates.push({
          sourceColumn: sCol.exactName,
          targetColumn: tCol.exactName,
          score,
        });
      }
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates.slice(0, 3);
}

/**
 * Option B Stage 2: Deterministic parameterized dependent lookup against target_table
 * using unique non-null join keys extracted from Stage 1 anchor rows.
 */
async function executeDependentLookupQuery(businessId, lookup, anchorRows = []) {
  if (!Array.isArray(anchorRows) || anchorRows.length === 0) {
    return { rows: [], matchMode: lookup.matchMode, usedFallback: false, fallbackPairsUsed: [] };
  }
  const primaryKeySet = new Set();
  for (const row of anchorRows) {
    const raw = row?.[lookup.sourceJoinColumn];
    const key = normalizeJoinKey(raw, lookup.matchMode);
    if (key) primaryKeySet.add(key);
  }
  const primaryKeys = [...primaryKeySet];
  const primaryRows = await runParameterizedKeyLookup(
    businessId,
    lookup.targetTable,
    lookup.targetJoinColumn,
    primaryKeys,
    lookup.matchMode
  );

  const matchedAnchorIndices = new Set();
  const matchedPrimaryKeys = new Set(
    primaryRows
      .map((row) => normalizeJoinKey(row?.[lookup.targetJoinColumn], lookup.matchMode))
      .filter(Boolean)
  );
  anchorRows.forEach((row, idx) => {
    const k = normalizeJoinKey(row?.[lookup.sourceJoinColumn], lookup.matchMode);
    if (k && matchedPrimaryKeys.has(k)) matchedAnchorIndices.add(idx);
  });

  const mergedRows = [...primaryRows];
  const seenRowIds = new Set(
    mergedRows.map((r, i) => String(r?.id || resolveRowIdentifier(r, i + 1, lookup.targetTable.schema)))
  );
  let usedFallback = false;
  const fallbackPairsUsed = [];

  const candidateFallbackPairs = [];
  if (lookup.fallbackSourceJoinColumn && lookup.fallbackTargetJoinColumn) {
    candidateFallbackPairs.push({
      sourceColumn: lookup.fallbackSourceJoinColumn,
      targetColumn: lookup.fallbackTargetJoinColumn,
    });
  }
  if (matchedAnchorIndices.size < anchorRows.length) {
    const inferred = inferDynamicFallbackJoinPairs(
      lookup.sourceTable,
      lookup.targetTable,
      lookup.sourceJoinColumn,
      lookup.targetJoinColumn
    );
    for (const pair of inferred) {
      const dup = candidateFallbackPairs.some(
        (existing) =>
          existing.sourceColumn.toLowerCase() === pair.sourceColumn.toLowerCase() &&
          existing.targetColumn.toLowerCase() === pair.targetColumn.toLowerCase()
      );
      if (!dup) candidateFallbackPairs.push(pair);
    }
  }

  for (const pair of candidateFallbackPairs) {
    if (matchedAnchorIndices.size >= anchorRows.length) break;
    const unmatchedRows = anchorRows.filter((_row, idx) => !matchedAnchorIndices.has(idx));
    const fallbackKeySet = new Set();
    for (const row of unmatchedRows) {
      const fbKey = normalizeJoinKey(row?.[pair.sourceColumn], lookup.matchMode);
      if (fbKey) fallbackKeySet.add(fbKey);
    }
    if (fallbackKeySet.size === 0) continue;
    const fallbackRows = await runParameterizedKeyLookup(
      businessId,
      lookup.targetTable,
      pair.targetColumn,
      [...fallbackKeySet],
      lookup.matchMode
    );
    if (fallbackRows.length > 0) {
      usedFallback = true;
      fallbackPairsUsed.push(pair);
      const matchedFbKeys = new Set(
        fallbackRows
          .map((row) => normalizeJoinKey(row?.[pair.targetColumn], lookup.matchMode))
          .filter(Boolean)
      );
      anchorRows.forEach((row, idx) => {
        if (matchedAnchorIndices.has(idx)) return;
        const k = normalizeJoinKey(row?.[pair.sourceColumn], lookup.matchMode);
        if (k && matchedFbKeys.has(k)) matchedAnchorIndices.add(idx);
      });
      for (let i = 0; i < fallbackRows.length; i += 1) {
        const fbRow = fallbackRows[i];
        const idKey = String(
          fbRow?.id || resolveRowIdentifier(fbRow, i + 1, lookup.targetTable.schema)
        );
        if (!seenRowIds.has(idKey)) {
          seenRowIds.add(idKey);
          mergedRows.push(fbRow);
        }
      }
    }
  }

  return {
    rows: mergedRows,
    matchMode: lookup.matchMode,
    usedFallback,
    fallbackPairsUsed,
  };
}

/**
 * Option B Stage 3: Deterministic in-memory join between anchor and lookup rows,
 * evaluating cross_table_comparisons arithmetic and threshold_filter predicates in JS.
 */
function joinAndEvaluateCrossTableComparisons({
  anchorResultsById,
  lookupResultsById,
  dependentLookups = [],
  crossTableComparisons = [],
}) {
  if (!Array.isArray(dependentLookups) || dependentLookups.length === 0) {
    return {
      pairedRecords: [],
      matchedPairedRecords: [],
      hasThresholdFilters: false,
    };
  }

  const lookupsByAnchorId = new Map();
  for (const lookup of dependentLookups) {
    const key = lookup.sourceQueryId;
    if (!lookupsByAnchorId.has(key)) lookupsByAnchorId.set(key, []);
    lookupsByAnchorId.get(key).push(lookup);
  }

  const pairedRecords = [];
  for (const [anchorQueryId, anchorLookups] of lookupsByAnchorId.entries()) {
    const anchorResult = anchorResultsById.get(anchorQueryId);
    if (!anchorResult || !Array.isArray(anchorResult.rows)) continue;

    // Pre-index each lookup's fetched rows by primary and all active fallback join pairs
    const indexedLookups = anchorLookups.map((lookup) => {
      const lookupRes = lookupResultsById.get(lookup.lookupId);
      const lookupRows = Array.isArray(lookupRes?.rows) ? lookupRes.rows : [];
      const fallbackPairs = [];
      if (lookup.fallbackSourceJoinColumn && lookup.fallbackTargetJoinColumn) {
        fallbackPairs.push({
          sourceColumn: lookup.fallbackSourceJoinColumn,
          targetColumn: lookup.fallbackTargetJoinColumn,
        });
      }
      for (const dynPair of lookupRes?.fallback_pairs_used || lookupRes?.fallbackPairsUsed || []) {
        const dup = fallbackPairs.some(
          (p) =>
            p.sourceColumn.toLowerCase() === dynPair.sourceColumn.toLowerCase() &&
            p.targetColumn.toLowerCase() === dynPair.targetColumn.toLowerCase()
        );
        if (!dup) fallbackPairs.push(dynPair);
      }

      const byPrimaryKey = new Map();
      const byFallbackMaps = fallbackPairs.map((pair) => ({ pair, map: new Map() }));

      for (let i = 0; i < lookupRows.length; i += 1) {
        const lRow = lookupRows[i];
        const lEntry = {
          row: lRow,
          rowIdentifier: resolveRowIdentifier(lRow, i + 1, lookup.targetTable.schema),
        };
        const pKey = normalizeJoinKey(lRow?.[lookup.targetJoinColumn], lookup.matchMode);
        if (pKey) {
          if (!byPrimaryKey.has(pKey)) byPrimaryKey.set(pKey, []);
          byPrimaryKey.get(pKey).push(lEntry);
        }
        for (const fb of byFallbackMaps) {
          const fbKey = normalizeJoinKey(lRow?.[fb.pair.targetColumn], lookup.matchMode);
          if (fbKey) {
            if (!fb.map.has(fbKey)) fb.map.set(fbKey, []);
            fb.map.get(fbKey).push(lEntry);
          }
        }
      }
      return { lookup, byPrimaryKey, byFallbackMaps };
    });

    for (let aIdx = 0; aIdx < anchorResult.rows.length; aIdx += 1) {
      const anchorRow = anchorResult.rows[aIdx];
      const anchorRowIdentifier = resolveRowIdentifier(anchorRow, aIdx + 1, anchorResult.schema);

      // Start Cartesian expansion across lookups on this anchor (usually 1-to-1)
      let combos = [
        {
          sources: { [anchorQueryId]: anchorRow },
          lookupMatches: [],
        },
      ];

      for (const { lookup, byPrimaryKey, byFallbackMaps } of indexedLookups) {
        const pKey = normalizeJoinKey(anchorRow?.[lookup.sourceJoinColumn], lookup.matchMode);
        let hits = pKey ? byPrimaryKey.get(pKey) || [] : [];
        if (hits.length === 0) {
          for (const fb of byFallbackMaps) {
            const fbKey = normalizeJoinKey(anchorRow?.[fb.pair.sourceColumn], lookup.matchMode);
            const fbHits = fbKey ? fb.map.get(fbKey) || [] : [];
            if (fbHits.length > 0) {
              hits = fbHits;
              break;
            }
          }
        }
        if (hits.length === 0) {
          combos = combos.map((combo) => ({
            sources: { ...combo.sources, [lookup.lookupId]: null },
            lookupMatches: [
              ...combo.lookupMatches,
              {
                lookupId: lookup.lookupId,
                tableName: lookup.targetTable.tableName,
                schema: lookup.targetTable.schema,
                rowIdentifier: null,
                row: null,
              },
            ],
          }));
        } else {
          const nextCombos = [];
          for (const combo of combos) {
            for (const hit of hits) {
              nextCombos.push({
                sources: { ...combo.sources, [lookup.lookupId]: hit.row },
                lookupMatches: [
                  ...combo.lookupMatches,
                  {
                    lookupId: lookup.lookupId,
                    tableName: lookup.targetTable.tableName,
                    schema: lookup.targetTable.schema,
                    rowIdentifier: hit.rowIdentifier,
                    row: hit.row,
                  },
                ],
              });
            }
          }
          combos = nextCombos;
        }
      }

      for (const combo of combos) {
        const computed = {};
        const evaluations = [];
        let passesAllThresholds = true;

        for (const comp of crossTableComparisons) {
          if (
            !Object.prototype.hasOwnProperty.call(combo.sources, comp.leftSource) &&
            !Object.prototype.hasOwnProperty.call(combo.sources, comp.rightSource)
          ) {
            continue;
          }
          const leftRow = combo.sources[comp.leftSource];
          const rightRow = combo.sources[comp.rightSource];
          const leftRaw = leftRow?.[comp.leftColumn];
          const rightRaw = rightRow?.[comp.rightColumn];
          const leftVal =
            leftRaw !== null && leftRaw !== undefined && leftRaw !== '' ? Number(leftRaw) : Number.NaN;
          const rightVal =
            rightRaw !== null && rightRaw !== undefined && rightRaw !== '' ? Number(rightRaw) : Number.NaN;
          const computedVal = evaluateCrossTableArithmetic(leftVal, comp.operator, rightVal);
          computed[comp.resultAlias] = computedVal;

          let passed = true;
          if (comp.thresholdFilter) {
            passed =
              computedVal !== null &&
              evaluateCrossTableThreshold(
                computedVal,
                comp.thresholdFilter.op,
                comp.thresholdFilter.value
              );
            if (!passed) passesAllThresholds = false;
          }
          evaluations.push({
            alias: comp.resultAlias,
            expression: `${comp.leftSource}.${comp.leftColumn} ${comp.operator} ${comp.rightSource}.${comp.rightColumn}`,
            left_value: Number.isFinite(leftVal) ? leftVal : null,
            right_value: Number.isFinite(rightVal) ? rightVal : null,
            value: computedVal,
            threshold_filter: comp.thresholdFilter || null,
            passed,
          });
        }

        pairedRecords.push({
          anchorQueryId,
          anchorTableName: anchorResult.table_name,
          anchorSchema: anchorResult.schema,
          anchorRowIdentifier,
          anchorRow,
          lookupMatches: combo.lookupMatches,
          computed,
          evaluations,
          passesAllThresholds,
        });
      }
    }
  }

  const hasThresholdFilters = crossTableComparisons.some((c) => Boolean(c.thresholdFilter));
  const matchedPairedRecords = hasThresholdFilters
    ? pairedRecords.filter((rec) => rec.passesAllThresholds)
    : pairedRecords;

  return {
    pairedRecords,
    matchedPairedRecords,
    hasThresholdFilters,
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
  const hasCrossTableCue =
    /\b(?:cross[- ]?check|cross[- ]?reference|compare|comparing|against|versus|vs\.?|match(?:ed|ing)?\s+with|reconcile|with\s+the\s+(?:\d+\s+)?(?:new|recent|added|latest|pending|open|active))\b/i.test(
      String(prompt || '')
    );
  let tables = [];
  if (Array.isArray(prefetchedTables) && prefetchedTables.length > 0) {
    if (effectiveTargetEntities.length > 0) {
      const normalizedTargets = effectiveTargetEntities.map((t) =>
        normalizeEntityName(String(t || '').replace(/\.(csv|xlsx?|tsv)$/i, '')).toLowerCase()
      );
      const filtered = prefetchedTables.filter((t) =>
        normalizedTargets.includes(normalizeEntityName(t.tableName).toLowerCase())
      );
      if (hasCrossTableCue && filtered.length < prefetchedTables.length) {
        const extraRelevant = selectRelevantTablesForRead(
          prefetchedTables,
          prompt,
          chunks,
          activeCtx.activeTargetTable || null
        );
        const seen = new Set(filtered.map((t) => t.tableName.toLowerCase()));
        tables = [...filtered];
        for (const t of extraRelevant) {
          if (!seen.has(t.tableName.toLowerCase())) {
            seen.add(t.tableName.toLowerCase());
            tables.push(t);
          }
        }
      } else {
        tables = filtered.length > 0 ? filtered : prefetchedTables;
      }
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
      targetEntities: hasCrossTableCue ? [] : effectiveTargetEntities,
      includeRows: false,
      prefetchedMetadata,
    });
    tables =
      !hasCrossTableCue && effectiveTargetEntities.length > 0
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
    ? `\nCONVERSATION CONTEXT (last ${normalizedHistory.length} turn(s); prior active table: ${activeCtx.activeTargetTable || 'none'}; prior matched_row_ids: ${JSON.stringify((activeCtx.matchedRowIds || []).slice(0, 40))}; prior filter summary: ${JSON.stringify(activeCtx.appliedFilterSummary || '')}):\n${formattedHistory}\n- FOLLOW-UP CHAINING RULE: If LATEST USER REQUEST uses pronouns/narrowing cues ("those", "them", "these", "of those", "only the ones...", "the N new/added ...") referring to prior results on ${activeCtx.activeTargetTable || 'a prior table'}, chain the prior active filters/matched_row_ids with any new filter conditions.\n`
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
      ? { maxChunks: 6, maxChars: 700 }
      : { maxChunks: 8, maxChars: 850 }
  );

  let plan = hasPrevalidatedPlan ? prevalidatedPlan : null;
  if (!plan) {
    const planPrompt = `Create a read-only query plan for the latest user request using only these active workspace sources.
Return structured JSON only. Never return SQL.
CURRENT_DATE (UTC): ${currentDateIso}
- ${SCHEMA_TRUTH_PRECEDENCE_RULE}
- Select only tables needed to answer the request.
- Use exact column names and supported filter operators from the schema.
- If the user uses conceptual, colloquial, or status-adjacent terms that do not match an exact column name, inspect all column names, summary, range, and categorical values in ACTIVE TABLE SCHEMAS to infer the closest valid column(s) and enum value(s) on the first attempt—never invent non-existent column names.
- TWO-STAGE CROSS-TABLE READ RULE (MANDATORY WHEN COMPARING OR JOINING TWO TABLES): Whenever the question cross-checks, compares, or evaluates sufficiency/arithmetic/thresholds between columns in Table A (anchor, e.g., newly added/open requests or orders, including singular/collective follow-up phrasings like "to fulfill the order", "the orders", "those") and Table B (lookup, e.g., catalog/inventory/capacity), DO NOT reduce the query to a static single-table filter! Instead:
  1. Emit the anchor query in "table_queries" with a "query_id" (e.g., "anchor_1"). If CONVERSATION CONTEXT has prior matched_row_ids on Table A (such as rows just added or filtered in the previous turn) and the user refers to "the order(s)"/"those"/"the new records", filter Table A's primary key on prior matched_row_ids with operator "in"; if no prior matched_row_ids exist, select the open/pending rows or use "order_by" + "limit".
  2. Emit a "dependent_lookups" entry linking "source_query_id" ("anchor_1") via "source_join_column" to "target_table" and "target_join_column" (with "match_mode": "case_insensitive" or "normalized_string", and optional "fallback_source_join_column"/"fallback_target_join_column").
  3. Emit a "cross_table_comparisons" entry computing the exact cross-table math (e.g., left_source: "lookup_1", left_column: <live inventory col>, operator: "-", right_source: "anchor_1", right_column: <live requested col>, result_alias: "remaining_after_request", threshold_filter: { "op": "<", "value": <policy minimum threshold> }).
- Apply document-derived eligibility criteria as filters and use AND/OR only as requested by the documents or user.
- DOCUMENT-ENUMERATED CODES / EXCLUSIONS RULE: When the documents list specific batch codes, SKUs, unit IDs, or identifiers as qualifying/recalled (check ALL pages/addendums in RELEVANT DOCUMENT PASSAGES) and exclude others, filter explicitly on those qualifying codes (e.g., "in" filter) rather than running an unfiltered full-table scan.
- DATE / DORMANCY DIRECTION RULE: When checking "inactive for > N days", "no payment in N+ days", or "older than N days" against CURRENT_DATE (${currentDateIso}), a date column MUST be EARLIER (use "less_than_or_equal" or "less_than" with YYYY-MM-DD = CURRENT_DATE minus N days, never "greater_than").
- If the request asks multiple distinct sub-questions or cohorts on the same table (for example, specific unit IDs plus a department cohort, or breaching POs plus in-transit/sea rows linked to backorders), emit separate entries in table_queries or combine criteria with filter_logic: "OR" so no requested cohort is dropped.
- Filter strictly on selection conditions, never on display attributes (for example, when asked which products have discount >= 35% with their Best-Seller flag, filter ONLY discount >= 35, not best = true).
- Numeric summaries must use aggregates; same-table row formulas must list exact numeric columns and an arithmetic operation in calculation_filters; cross-table row formulas MUST be emitted in cross_table_comparisons.
- Do not infer fields absent from the schemas. If no safe query can be formed, return an empty table_queries array.
- A single-table query with no filters is allowed only when the user explicitly asks for a full-table listing/aggregate, uses order_by + limit, or serves as an anchor for dependent_lookups.
- Return ONLY JSON with:
  - "table_queries": array of { "query_id": string, "table_name": string, "filters": [{ "field": string, "operator": "equals"|"not_equals"|"contains"|"not_contains"|"starts_with"|"ends_with"|"in"|"greater_than"|"greater_than_or_equal"|"less_than"|"less_than_or_equal"|"between"|"relative_days_ago"|"this_month", "value": string }], "calculation_filters": [{ "operation": "add"|"subtract"|"multiply"|"divide", "fields": [string, string], "operator": "greater_than"|"greater_than_or_equal"|"less_than"|"less_than_or_equal"|"equals"|"not_equals"|"between", "value": string }], "filter_logic": "AND"|"OR", "order_by": [{ "field": string, "direction": "asc"|"desc" }], "sort": [{ "field": string, "direction": "asc"|"desc" }], "limit": number, "aggregates": [{ "operation": "count"|"sum"|"average"|"min"|"max", "field": string }], "calculations": [{ "operation": "add"|"subtract"|"multiply"|"divide", "fields": [string, string], "aggregate": "count"|"sum"|"average"|"min"|"max" }] }
  - "dependent_lookups" (optional, for cross-table joins): array of { "lookup_id": string, "source_query_id": string, "source_join_column": string, "target_table": string, "target_join_column": string, "fallback_source_join_column": string, "fallback_target_join_column": string, "match_mode": "exact"|"case_insensitive"|"normalized_string" }
  - "cross_table_comparisons" (optional, for cross-table arithmetic/thresholds): array of { "left_source": string, "left_column": string, "operator": "-"|"+"|"*"|"/", "right_source": string, "right_column": string, "result_alias": string, "threshold_filter": { "op": "<"|"<="|">"|">="|"=="|"!=", "value": number } }.

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

  // Stage 1: Parameterized Anchor Fetch
  const results = [];
  const anchorResultsById = new Map();
  for (let i = 0; i < plan.length; i += 1) {
    const tablePlan = plan[i];
    await applyFollowUpIdChaining(
      tablePlan,
      businessId,
      prompt,
      normalizedHistory,
      activeCtx
    );
    const execution = await executeReadQuery(businessId, tablePlan);
    const queryId = tablePlan.queryId || `q_${i + 1}`;
    const resultEntry = {
      query_id: queryId,
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
    };
    results.push(resultEntry);
    anchorResultsById.set(queryId, resultEntry);
  }

  // Stage 2: Parameterized Dependent Lookup Fetch (Option B)
  const dependentLookups = Array.isArray(plan.dependentLookups)
    ? plan.dependentLookups
    : [];
  const crossTableComparisons = Array.isArray(plan.crossTableComparisons)
    ? plan.crossTableComparisons
    : [];
  const lookupResultsById = new Map();
  for (const lookup of dependentLookups) {
    const anchorRes = anchorResultsById.get(lookup.sourceQueryId);
    const lookupExec = await executeDependentLookupQuery(
      businessId,
      lookup,
      anchorRes?.rows || []
    );
    lookupResultsById.set(lookup.lookupId, {
      lookup_id: lookup.lookupId,
      table_name: lookup.targetTable.tableName,
      schema: lookup.targetTable.schema,
      rows: lookupExec.rows,
      used_fallback: lookupExec.usedFallback,
      fallback_pairs_used: lookupExec.fallbackPairsUsed || [],
    });
  }

  // Stage 3: Deterministic In-Memory Join & Cross-Table Math (Option B)
  const crossTableEval =
    dependentLookups.length > 0
      ? joinAndEvaluateCrossTableComparisons({
          anchorResultsById,
          lookupResultsById,
          dependentLookups,
          crossTableComparisons,
        })
      : null;

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

  let highlightedRows = [];
  let synthesisSqlOutput;

  if (crossTableEval && dependentLookups.length > 0) {
    const serializePair = (rec, idx) => ({
      anchor_table: rec.anchorTableName,
      anchor_row_id: rec.anchorRowIdentifier,
      anchor: compactRowForSynthesis(rec.anchorRow, idx, rec.anchorSchema),
      lookups: rec.lookupMatches.map((lm, lIdx) => ({
        lookup_id: lm.lookupId,
        table_name: lm.tableName,
        _row_id: lm.rowIdentifier,
        row: lm.row ? compactRowForSynthesis(lm.row, lIdx, lm.schema) : null,
      })),
      computed: rec.computed,
      evaluations: rec.evaluations,
      passes_threshold: rec.passesAllThresholds,
    });

    const highlightSourceRecords =
      crossTableEval.matchedPairedRecords.length > 0
        ? [
            ...crossTableEval.matchedPairedRecords,
            ...crossTableEval.pairedRecords.filter((r) => !r.passesAllThresholds),
          ]
        : crossTableEval.pairedRecords;
    for (const rec of highlightSourceRecords) {
      for (const lm of rec.lookupMatches) {
        if (lm.row && lm.rowIdentifier) {
          highlightedRows.push({
            table_name: lm.tableName,
            schema: lm.schema,
            row_identifier: lm.rowIdentifier,
            row_data: lm.row,
          });
        }
      }
      if (rec.anchorRow && rec.anchorRowIdentifier) {
        highlightedRows.push({
          table_name: rec.anchorTableName,
          schema: rec.anchorSchema,
          row_identifier: rec.anchorRowIdentifier,
          row_data: rec.anchorRow,
        });
      }
    }

    synthesisSqlOutput = {
      two_stage_cross_table: true,
      matched_pairs_count: crossTableEval.matchedPairedRecords.length,
      total_evaluated_pairs_count: crossTableEval.pairedRecords.length,
      matched_pairs: crossTableEval.matchedPairedRecords
        .slice(0, 30)
        .map((rec, idx) => serializePair(rec, idx)),
      all_evaluated_pairs: crossTableEval.pairedRecords
        .slice(0, 30)
        .map((rec, idx) => serializePair(rec, idx)),
    };
  } else {
    highlightedRows = results.flatMap((result) =>
      result.rows.slice(0, 100).map((row, index) => ({
        table_name: result.table_name,
        schema: result.schema,
        row_identifier: resolveRowIdentifier(row, index + 1, result.schema),
        row_data: row,
      }))
    );
    synthesisSqlOutput = results.map((result) => ({
      table_name: result.table_name,
      row_count: result.row_count,
      aggregates: result.aggregates,
      calculations: result.calculations,
      rows: result.rows
        .slice(0, 30)
        .map((row, index) => compactRowForSynthesis(row, index, result.schema)),
    }));
  }

  // Dynamically detect if the user explicitly asked to display a specific involved table
  // (e.g. "show the <table_noun> that ...") when multiple tables were joined in Option B.
  let requestedDisplayTable = null;
  if (crossTableEval && dependentLookups.length > 0) {
    const involvedTableMap = new Map();
    for (const r of results) {
      involvedTableMap.set(r.table_name.toLowerCase(), r.table_name);
    }
    for (const l of dependentLookups) {
      involvedTableMap.set(l.targetTable.tableName.toLowerCase(), l.targetTable.tableName);
    }
    const displayClauseMatches = [
      ...String(prompt || '').matchAll(
        /\b(?:show|list|display|return|find|identify|check(?:\s+if|\s+whether)?|which|what)\s+(?:all\s+|the\s+|every\s+|any\s+)?([a-z0-9_\s-]{3,40})/gi
      ),
    ];
    for (const match of displayClauseMatches) {
      const clauseLower = String(match[1] || '').toLowerCase();
      for (const [, tblName] of involvedTableMap.entries()) {
        const tLower = tblName.toLowerCase();
        const tStem = tLower.replace(/_/g, ' ').replace(/s$/, '');
        const tokens = tLower
          .split(/[^a-z0-9]+/)
          .filter((tok) => tok.length >= 4 && !['dataset', 'table', 'sheet', 'data'].includes(tok));
        if (
          clauseLower.includes(tLower) ||
          (tStem.length >= 4 && clauseLower.includes(tStem)) ||
          tokens.some((tok) => {
            const singular = tok.endsWith('s') && tok.length > 4 ? tok.slice(0, -1) : tok;
            return new RegExp(`\\b${singular}s?\\b`, 'i').test(clauseLower);
          })
        ) {
          requestedDisplayTable = tblName;
          break;
        }
      }
      if (requestedDisplayTable) break;
    }
  }

  const synthesisPrompt = `Answer the user's read-only workspace question using only the verified query output and retrieved document passages.
${SCHEMA_TRUTH_PRECEDENCE_RULE}
Never propose or execute mutations. Do not invent missing facts. Use exact counts, values, units, and negative signs from the SQL results. Explain uncertainty when the retrieved data cannot answer.
Check EVERY row in VERIFIED SQL OUTPUT against EVERY sub-question and policy rule (comparing date columns such as last_payment_date against CURRENT_DATE for > 90 day dormancy checks, checking exclusions/addendums, and linking SKUs/items across tables) before stating any category is empty.
${crossTableEval ? `CROSS-TABLE TWO-STAGE RESULTS: VERIFIED SQL OUTPUT contains deterministically joined pairs ("matched_pairs" and "all_evaluated_pairs") with exact live values from both tables and pre-computed arithmetic in "computed" / "evaluations". Rely strictly on these deterministic calculations (do NOT re-estimate or substitute stale numbers from PDFs). Check EVERY pair in "all_evaluated_pairs" against BOTH the user question AND ALL policy thresholds/minimum buffers in RELEVANT DOCUMENT PASSAGES (for example, if a policy mandates keeping a minimum safety buffer N on hand, flag every pair whose computed remaining value falls below N even if a planner threshold used 0). In "matched_row_ids", return ONLY the exact "_row_id" values of the qualifying records from ${requestedDisplayTable ? `table "${requestedDisplayTable}"` : 'the table the user asked to show'}.` : ''}
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
    let filteredHighlights = highlightedRows.filter((entry) =>
      allowedNormalized.has(String(entry.row_identifier || '').trim().toLowerCase())
    );
    // If Option B joined two tables and synthesis returned anchor IDs while the user asked to
    // display the paired lookup table (e.g. "show the products..."), deterministically resolve
    // the paired rows from requestedDisplayTable so the right table is shown in the UI.
    if (
      crossTableEval &&
      requestedDisplayTable &&
      filteredHighlights.length > 0 &&
      !filteredHighlights.some(
        (entry) => entry.table_name.toLowerCase() === requestedDisplayTable.toLowerCase()
      )
    ) {
      const pairedTargetRows = [];
      for (const rec of crossTableEval.pairedRecords) {
        const anchorMatched = allowedNormalized.has(
          String(rec.anchorRowIdentifier || '').trim().toLowerCase()
        );
        const anyLookupMatched = rec.lookupMatches.some(
          (lm) =>
            lm.rowIdentifier &&
            allowedNormalized.has(String(lm.rowIdentifier).trim().toLowerCase())
        );
        if (!anchorMatched && !anyLookupMatched) continue;
        if (rec.anchorTableName.toLowerCase() === requestedDisplayTable.toLowerCase()) {
          pairedTargetRows.push({
            table_name: rec.anchorTableName,
            schema: rec.anchorSchema,
            row_identifier: rec.anchorRowIdentifier,
            row_data: rec.anchorRow,
          });
        }
        for (const lm of rec.lookupMatches) {
          if (
            lm.row &&
            lm.rowIdentifier &&
            lm.tableName.toLowerCase() === requestedDisplayTable.toLowerCase()
          ) {
            pairedTargetRows.push({
              table_name: lm.tableName,
              schema: lm.schema,
              row_identifier: lm.rowIdentifier,
              row_data: lm.row,
            });
          }
        }
      }
      if (pairedTargetRows.length > 0) {
        filteredHighlights = pairedTargetRows;
      }
    }
    highlightedRows = filteredHighlights;
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
    ...(crossTableEval
      ? {
          cross_table_execution: {
            mode: 'two_stage_dependent_lookup',
            lookups_count: dependentLookups.length,
            comparisons_count: crossTableComparisons.length,
            total_evaluated_pairs: crossTableEval.pairedRecords.length,
            matched_pairs: crossTableEval.matchedPairedRecords.length,
          },
        }
      : {}),
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
  executeDependentLookupQuery,
  joinAndEvaluateCrossTableComparisons,
  executePreplannedSheetQuery,
  generateCrossSourceReadAnswer,
};
