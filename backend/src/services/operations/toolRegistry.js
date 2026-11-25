const { query } = require('../../../db');
const AppError = require('../../utils/AppError');
const { ToolPayloadSchemas } = require('../llm/schemas');
const {
  hybridSearchDocumentChunks,
  resolveRowIdentifier,
  resolveRowIdentifierInfo,
  buildDocumentCitation,
  buildTableRowCitation,
} = require('../rag/crossRagService');
const { classifyTableColumns } = require('../rag/queryRouterService');
const {
  discoverTableSchema,
  findColumnDef,
  quoteIdentifier,
  normalizeEntityName,
} = require('../sheets/sheetSchemaService');
const {
  validateReadPlan,
  executeReadQuery,
  executeDependentLookupQuery,
  joinAndEvaluateCrossTableComparisons,
} = require('./workspaceReadService');
const { coerceValueForColumn } = require('../../utils/columnCoercion');
const { buildHighlightedRows } = require('../sheets/fastTableQueryService');

const ALL_TOOL_DEFINITIONS = Object.freeze([
  {
    name: 'search_docs',
    description:
      'Search active workspace documents (policies, SOPs, manifests) via Hybrid RRF vector+lexical search.',
    parameters: {
      query: 'string',
      expanded_queries: 'string[] (optional)',
      doc_types: "('policy'|'sop'|'manifest'|'faq'|'catalog'|'general')[] | null (optional)",
      top_k: 'integer <= 8 (optional)',
    },
  },
  {
    name: 'query_tables_with_lookup',
    description:
      'Execute deterministic SQL read queries, Option B two-stage anchor-to-lookup joins, and cross-table arithmetic/threshold evaluations.',
    parameters: {
      table_queries: "[{ query_id: 'q_1', table_name: string, filters: [{ field: string, operator: 'equals'|'not_equals'|'contains'|'in'|'greater_than'|'greater_than_or_equal'|'less_than'|'less_than_or_equal'|'between', value: string }], filter_logic?: 'AND'|'OR', order_by?: [{ field: string, direction: 'asc'|'desc' }], limit?: number }]",
      dependent_lookups: "[{ lookup_id: 'lookup_1', source_query_id: 'q_1', source_join_column: string, target_table: string, target_join_column: string, fallback_source_join_column?: string, fallback_target_join_column?: string, match_mode?: 'exact'|'case_insensitive'|'normalized_string' }] (optional)",
      cross_table_comparisons: "[{ left_source: string, left_column: string, operator: '-'|'+'|'*'|'/', right_source: string, right_column: string, result_alias: string, threshold_filter?: { op: '<'|'<='|'>'|'>='|'=='|'!=', value?: number, column?: string } }] (optional)",
    },
  },
  {
    name: 'propose_table_mutations',
    description:
      'Stage 1 ONLY (never executes SQL): validate row updates against PostgreSQL schema/types and policy reserve rules, producing before->after preview diffs.',
    parameters: {
      mutations: "[{ table_name: string, operation: 'update', row_identifier: 'string (MUST use exact _row_id / anchor_row_id / lookup_row_id from observation)', updates: { [columnName]: newValue }, reason?: string }]",
      policy_rule_applied: '{ target_table: string, numeric_column: string, min_reserve_threshold?: number, threshold_column?: string, citation_chunk_id?: string, waive_reserve?: boolean } (optional)',
    },
  },
  {
    name: 'draft_emails',
    description:
      'Stage 1 ONLY (never sends SMTP): draft personalized emails from verified workspace recipient directories, enforcing audience_scope isolation and dual-outcome coverage.',
    parameters: {
      audience_scope: "'primary_customers_only'|'internal_stakeholders_only'|'both_customers_and_internal'",
      recipients: "[{ email: string, name?: string, record_id?: string, outcome_type: 'fulfilled'|'unfulfilled'|'notification'|'escalation', subject: string, body: string, applied_rule?: string }]",
    },
  },
  {
    name: 'ask_socratic_clarification',
    description:
      'Halt loop and ask operator to resolve genuine policy conflicts or ambiguity with concrete option cards.',
    parameters: {
      conflict_summary: 'string',
      affected_rows_count: 'integer',
      conflicting_rows_count: 'integer',
      socratic_questions: '[{ question_id, question_text, options: [{ option_id, label, rule_interpretation }] }]',
      citations: 'array (optional)',
    },
  },
]);

function getToolDefinitionsForEntity(requestEntity = 'user') {
  const normalized = String(requestEntity || 'user').trim().toLowerCase();
  if (normalized === 'customer') {
    return ALL_TOOL_DEFINITIONS.filter((t) =>
      ['search_docs', 'query_tables_with_lookup'].includes(t.name)
    );
  }
  return ALL_TOOL_DEFINITIONS;
}

const INTERNAL_STAKEHOLDER_EMAIL_RE =
  /(?:hub_?lead|warehouse_?lead|lead_?email|coordinator|staff_?email|nurse_?email|unit_?contact|internal_?email|roster)/i;

const CUSTOMER_AUDIENCE_EMAIL_RE =
  /(?:customer|buyer|client|account|retailer|stockist|physician|doctor|attending|referring|patient|recipient)/i;

function isInternalStakeholderTable(tableCtx) {
  const emailCol = String(tableCtx?.columnRoles?.emailCol || '');
  const tableName = String(tableCtx?.tableName || '');
  if (INTERNAL_STAKEHOLDER_EMAIL_RE.test(emailCol)) return true;
  if (
    /(?:warehouse|inventory|batches|roster|hospital_units|units|catalog|products)/i.test(tableName) &&
    !CUSTOMER_AUDIENCE_EMAIL_RE.test(emailCol)
  ) {
    return true;
  }
  return false;
}

function expandAudienceTokens(tokens = []) {
  const groups = [
    ['customer', 'customers', 'buyer', 'buyers', 'client', 'clients', 'account', 'accounts', 'order', 'orders', 'backorder', 'backorders', 'stockist', 'retailer'],
    ['lead', 'leads', 'hub', 'hubs', 'warehouse', 'manager', 'managers', 'supervisor', 'internal'],
    ['physician', 'physicians', 'doctor', 'doctors', 'attending', 'referring', 'provider'],
    ['unit', 'units', 'coordinator', 'coordinators', 'charge', 'nurse', 'nurses', 'staff', 'roster'],
  ];
  const expanded = new Set();
  for (const raw of tokens) {
    const clean = String(raw || '').trim().toLowerCase();
    if (!clean) continue;
    expanded.add(clean);
    for (const group of groups) {
      if (group.includes(clean)) {
        for (const syn of group) expanded.add(syn);
      }
    }
  }
  return expanded;
}

/**
 * Shared audience recipient table selector preventing internal stakeholder columns
 * (e.g. Hub_Lead_Email, unit contact_email) from leaking into customer notifications.
 */
function selectAudienceRecipientTables(targetTables = [], promptText = '', explicitScope = null) {
  const tablesWithEmail = (targetTables || []).filter(
    (tbl) => tbl && Array.isArray(tbl.rows) && tbl.columnRoles?.emailCol
  );
  if (tablesWithEmail.length === 0) return [];

  if (explicitScope === 'primary_customers_only') {
    const externalOnly = tablesWithEmail.filter((tbl) => !isInternalStakeholderTable(tbl));
    if (externalOnly.length > 0) return externalOnly;
  } else if (explicitScope === 'internal_stakeholders_only') {
    const internalOnly = tablesWithEmail.filter((tbl) => isInternalStakeholderTable(tbl));
    if (internalOnly.length > 0) return internalOnly;
  } else if (explicitScope === 'both_customers_and_internal') {
    return tablesWithEmail;
  }

  if (tablesWithEmail.length === 1) {
    return tablesWithEmail;
  }

  const rawPrompt = String(promptText || '').trim();
  const notifClauses = [
    ...rawPrompt.matchAll(
      /\b(?:send\s+(?:an?\s+)?e?-?mails?|e?-?mail|notify(?:ing)?|inform(?:ing)?|alert(?:ing)?)\b[^.;\n]{0,120}/gi
    ),
  ].map((m) => m[0].toLowerCase());
  const clauseText =
    notifClauses.length > 0 ? notifClauses.join(' ') : rawPrompt.toLowerCase();

  // Check explicit customer-only notification clause before scoring general prompt text
  const clauseHasInternal =
    /\b(?:hub\s*lead|warehouse\s*lead|coordinator|nurs(?:e|ing)\s*(?:lead|staff|roster)|unit\s*contact|internal\s*(?:team|staff|lead))\b/i.test(
      clauseText
    );
  const clauseHasCustomer =
    /\b(?:customer|buyer|client|account|stockist|retailer|physician|doctor|attending|referring|patient|recipient|every\s+order|affected\s+(?:orders?|accounts?|buyers?|customers?))\b/i.test(
      clauseText
    );
  const clauseHasBoth = /\b(?:both|all\s+(?:parties|teams|contacts|audiences))\b/i.test(
    clauseText
  );
  if (clauseHasCustomer && !clauseHasInternal && !clauseHasBoth) {
    const externalOnly = tablesWithEmail.filter((tbl) => !isInternalStakeholderTable(tbl));
    if (externalOnly.length > 0) return externalOnly;
  }

  const scored = tablesWithEmail.map((tbl, idx) => {
    const emailColTokens = String(tbl.columnRoles?.emailCol || '')
      .toLowerCase()
      .split(/[^a-z0-9]+/);
    const schemaCols = Object.values(tbl.schema?.columns || {})
      .map((c) => String(c?.exactName || '').toLowerCase())
      .filter((n) =>
        /(?:customer|buyer|client|manager|physician|doctor|attending|referring|lead|coordinator|vendor|supplier|retailer)/i.test(
          n
        )
      )
      .flatMap((n) => n.split(/[^a-z0-9]+/));
    const tableTokens = String(tbl.tableName || '')
      .toLowerCase()
      .split(/[^a-z0-9]+/);

    const roleSet = expandAudienceTokens([...emailColTokens, ...schemaCols]);
    const tableSet = expandAudienceTokens(tableTokens);

    let score = 0;
    for (const tok of roleSet) {
      if (new RegExp(`\\b${tok.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\\b`, 'i').test(clauseText)) {
        score += 10;
      }
    }
    for (const tok of tableSet) {
      if (new RegExp(`\\b${tok.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\\b`, 'i').test(clauseText)) {
        score += 4;
      }
    }
    return { tbl, idx, score };
  });

  scored.sort((a, b) => b.score - a.score || a.idx - b.idx);
  const topScore = scored[0].score;
  const bothRequested =
    clauseHasBoth ||
    scored.filter((s) => s.score >= 10 && !isInternalStakeholderTable(s.tbl)).length > 1 ||
    (clauseHasInternal && clauseHasCustomer);

  if (topScore > 0 && bothRequested) {
    return scored.filter((s) => s.score > 0).map((s) => s.tbl);
  }
  return [scored[0].tbl];
}

/**
 * Shared reserve/buffer extractor fixed for multi-number workspaces:
 * scores chunks by domain/table relevance instead of failing whenever multiple unrelated
 * numbers appear in different policy PDFs (e.g., Refund $10,000 vs Hub reserve 10 units).
 */
function extractSecondaryReserveRule(
  secondaryCtx,
  retrievedChunks = [],
  promptText = '',
  optionMeta = {}
) {
  const combinedControlText = `${String(promptText || '')}\n${String(optionMeta?.rule_interpretation || '')}`;
  if (
    optionMeta?.waive_reserve === true ||
    /\b(?:ignore|override|waive|bypass|disregard|skip)\s+(?:the\s+)?(?:mandatory\s+)?(?:safety\s+|reserve\s+|hub\s+|minimum\s+|clean[-\s]?bed\s+|credit\s+)?(?:buffer|reserve|limit)\b/i.test(
      combinedControlText
    )
  ) {
    return null;
  }

  const bufferCol = (secondaryCtx?.schemaColumns || []).find(
    (col) =>
      ['integer', 'number'].includes(col.type) &&
      /(?:safety_?buffer|reserve_?buffer|min(?:imum)?_?(?:buffer|reserve|stock|balance|limit)|buffer_?limit|reorder_?point)/i.test(
        col.name
      )
  );
  if (bufferCol) {
    return { mode: 'column', columnName: bufferCol.name };
  }

  const mentionsReserveLimit = /\b(?:buffer|reserve|minimum|surge|credit\s+limit|clean[-\s]?bed)\b/i.test(
    combinedControlText
  );
  if (!mentionsReserveLimit || !Array.isArray(retrievedChunks) || retrievedChunks.length === 0) {
    return null;
  }

  const stockCols = (secondaryCtx?.modifiableColumns || [])
    .filter((c) => ['integer', 'number', 'json'].includes(c.type))
    .map((c) => c.name);
  const colRegexPart = stockCols
    .map((n) => n.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&'))
    .join('|');

  const patterns = [
    /(?:mandatory|minimum)\s+(?:minimum\s+)?(?:reserve|safety|surge|credit)?\s*(?:buffer|limit|margin|cushion)?\s*(?:of\s*)?\$?(\d+(?:,\d{3})*(?:\.\d+)?)\b/gi,
    /(?:retain|maintain|preserve|keep|leave)\s+(?:at\s+least|a\s+minimum\s+(?:of\s+)?)\$?(\d+(?:,\d{3})*(?:\.\d+)?)\s+(?:sanitized\s+|unencumbered\s+|ready\s+)?(?:units?|clean_beds|beds|usd|in\s+(?:unencumbered\s+)?(?:credit\s+)?reserve|(?:safety\s+)?buffer)/gi,
    /\$?(\d+(?:,\d{3})*(?:\.\d+)?)\s*[- ]?(?:unit|bed|clean[-\s]?bed)\s+(?:hub\s+|surge\s+|safety\s+)?(?:reserve|buffer)\b/gi,
  ];
  if (colRegexPart) {
    patterns.push(
      new RegExp(
        `\\b(?:${colRegexPart})\\b\\s*-\\s*[a-zA-Z0-9_]+\\s*>=\\s*\\$?(\\d+(?:,\\d{3})*(?:\\.\\d+)?)`,
        'gi'
      )
    );
  }

  const tableTokens = String(secondaryCtx?.tableName || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3);
  const colTokens = stockCols
    .flatMap((c) => String(c).toLowerCase().split(/[^a-z0-9]+/))
    .filter((t) => t.length >= 3);

  const candidates = [];
  for (const chunk of retrievedChunks) {
    const fname = String(chunk?.filename || '').toLowerCase();
    const txt = String(chunk?.raw_text || '');
    const lowerTxt = `${fname}\n${txt}`.toLowerCase();

    let relevance = 0;
    if (/(?:reserve|buffer|allocation|bed_allocation|credit_reserve)/i.test(fname)) {
      relevance += 6;
    }
    if (/refund|compensation|sla\s+credit/i.test(fname) && !/refund/i.test(String(secondaryCtx?.tableName || ''))) {
      relevance -= 5;
    }
    for (const tok of [...tableTokens, ...colTokens]) {
      if (lowerTxt.includes(tok)) relevance += 2;
    }
    if (/\b(?:reserve|safety\s+buffer|clean[-\s]?bed|available_stock)\b/i.test(lowerTxt)) {
      relevance += 3;
    }

    for (const rx of patterns) {
      rx.lastIndex = 0;
      let m;
      while ((m = rx.exec(txt)) !== null) {
        const val = Number(String(m[1]).replace(/,/g, ''));
        if (Number.isFinite(val) && val > 0) {
          candidates.push({ val, relevance });
        }
      }
    }
  }

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.relevance - a.relevance);
  const topRel = candidates[0].relevance;
  const topVals = new Set(candidates.filter((c) => c.relevance === topRel).map((c) => c.val));
  if (topVals.size === 1) {
    return { mode: 'constant', minReserve: [...topVals][0] };
  }
  const uniqueAll = new Set(candidates.map((c) => c.val));
  if (uniqueAll.size === 1) {
    return { mode: 'constant', minReserve: [...uniqueAll][0] };
  }
  return { mode: 'constant', minReserve: candidates[0].val };
}

const READ_OP_ALIAS_MAP = {
  '=': 'equals',
  '==': 'equals',
  eq: 'equals',
  equals: 'equals',
  '!=': 'not_equals',
  '<>': 'not_equals',
  ne: 'not_equals',
  not_equals: 'not_equals',
  '>': 'greater_than',
  gt: 'greater_than',
  greater_than: 'greater_than',
  '>=': 'greater_than_or_equal',
  gte: 'greater_than_or_equal',
  greater_than_or_equal: 'greater_than_or_equal',
  '<': 'less_than',
  lt: 'less_than',
  less_than: 'less_than',
  '<=': 'less_than_or_equal',
  lte: 'less_than_or_equal',
  less_than_or_equal: 'less_than_or_equal',
  like: 'contains',
  ilike: 'contains',
  contains: 'contains',
  not_contains: 'not_contains',
  starts_with: 'starts_with',
  ends_with: 'ends_with',
  in: 'in',
  between: 'between',
  relative_days_ago: 'relative_days_ago',
  this_month: 'this_month',
};

function normalizeReadArgsForPlanner(rawArgs, tables = []) {
  const tableQueries = (rawArgs.table_queries || []).map((tq, idx) => {
    const matchedTable = (tables || []).find(
      (t) =>
        String(t.tableName || '').toLowerCase() === String(tq.table_name || '').trim().toLowerCase() ||
        String(t.displayName || '').toLowerCase() === String(tq.table_name || '').trim().toLowerCase()
    );
    const filters = (tq.filters || []).map((f) => {
      const opKey = String(f.operator || 'equals').trim().toLowerCase();
      const op = READ_OP_ALIAS_MAP[opKey] || f.operator;
      let val = f.value;
      if (op === 'in' && Array.isArray(val)) {
        val = JSON.stringify(val);
      } else if (op === 'between' && Array.isArray(val)) {
        val = JSON.stringify(val);
      } else if (val !== null && val !== undefined && typeof val !== 'string') {
        val = String(val);
      }
      return {
        field: f.field,
        operator: op,
        value: val ?? '',
      };
    });

    const rawSortList = (Array.isArray(tq.order_by) && tq.order_by.length > 0
      ? tq.order_by
      : Array.isArray(tq.sort)
        ? tq.sort
        : []
    ).map((s) => ({
      field: s.field,
      direction: String(s.direction || 'asc').toLowerCase() === 'desc' ? 'desc' : 'asc',
    }));

    // Ensure bounded ReAct table inspection never gets blocked on unfiltered reads over small tables
    const hasDependentLookups =
      Array.isArray(rawArgs.dependent_lookups) && rawArgs.dependent_lookups.length > 0;
    let effectiveSort = rawSortList;
    let effectiveLimit = tq.limit ?? undefined;
    if (
      filters.length === 0 &&
      (!tq.calculation_filters || tq.calculation_filters.length === 0) &&
      !hasDependentLookups &&
      effectiveSort.length === 0 &&
      matchedTable?.schema
    ) {
      const sortableCols = Object.values(matchedTable.schema.columns || {}).filter(
        (c) =>
          c.sortable !== false &&
          c.queryable !== false &&
          !['id', 'business_id', 'workspace_id', 'user_id', 'created_at', 'updated_at'].includes(
            String(c.exactName || '').toLowerCase()
          )
      );
      const pkCandidate = matchedTable.schema.primaryKey || matchedTable.metadata?.primary_key_column;
      const validPk = sortableCols.find(
        (c) => pkCandidate && c.exactName.toLowerCase() === String(pkCandidate).toLowerCase()
      );
      const sortCol = (validPk || sortableCols[0])?.exactName || null;
      if (sortCol) {
        effectiveSort = [{ field: sortCol, direction: 'asc' }];
        effectiveLimit = effectiveLimit || 100;
      }
    }

    return {
      query_id: tq.query_id || `q_${idx + 1}`,
      table_name: matchedTable?.tableName || tq.table_name,
      filters,
      calculation_filters: Array.isArray(tq.calculation_filters) ? tq.calculation_filters : [],
      filter_logic: String(tq.filter_logic || 'AND').toUpperCase() === 'OR' ? 'OR' : 'AND',
      order_by: effectiveSort,
      sort: effectiveSort,
      limit: effectiveLimit,
      aggregates: Array.isArray(tq.aggregates) ? tq.aggregates : [],
      calculations: Array.isArray(tq.calculations) ? tq.calculations : [],
    };
  });

  const dependentLookups = (rawArgs.dependent_lookups || []).map((dl, idx) => {
    const fallbackSrcQueryId = tableQueries[0]?.query_id || 'q_1';
    const srcQuery = tableQueries.find(
      (tq) => String(tq.query_id).toLowerCase() === String(dl.source_query_id || fallbackSrcQueryId).toLowerCase()
    ) || tableQueries[0];
    const matchedSrcTable = (tables || []).find(
      (t) =>
        String(t.tableName || '').toLowerCase() === String(srcQuery?.table_name || '').trim().toLowerCase() ||
        String(t.displayName || '').toLowerCase() === String(srcQuery?.table_name || '').trim().toLowerCase()
    );
    const matchedTarget = (tables || []).find(
      (t) =>
        String(t.tableName || '').toLowerCase() === String(dl.target_table || '').trim().toLowerCase() ||
        String(t.displayName || '').toLowerCase() === String(dl.target_table || '').trim().toLowerCase()
    );

    let srcJoin = dl.source_join_column;
    let tgtJoin = dl.target_join_column;
    const fbSrc = dl.fallback_source_join_column || '';
    const fbTgt = dl.fallback_target_join_column || '';

    if (matchedSrcTable?.schema && matchedTarget?.schema) {
      const hasPrimarySrc = Boolean(findColumnDef(matchedSrcTable.schema, srcJoin));
      const hasPrimaryTgt = Boolean(findColumnDef(matchedTarget.schema, tgtJoin));
      if (!hasPrimarySrc || !hasPrimaryTgt) {
        if (fbSrc && fbTgt && findColumnDef(matchedSrcTable.schema, fbSrc) && findColumnDef(matchedTarget.schema, fbTgt)) {
          srcJoin = fbSrc;
          tgtJoin = fbTgt;
        } else {
          // Schema-agnostic shared name/key column matching when model hallucinates a join key on target table
          const srcCols = Object.values(matchedSrcTable.schema.columns || {}).map((c) => c.exactName);
          const tgtCols = Object.values(matchedTarget.schema.columns || {}).map((c) => c.exactName);
          const namePairSrc = srcCols.find((c) => /(?:^|_)(?:name|title)$/i.test(c));
          const namePairTgt = tgtCols.find((c) => /(?:^|_)(?:name|title)$/i.test(c));
          if (namePairSrc && namePairTgt) {
            srcJoin = namePairSrc;
            tgtJoin = namePairTgt;
          }
        }
      }
    }

    return {
      lookup_id: dl.lookup_id || `lookup_${idx + 1}`,
      source_query_id: dl.source_query_id || fallbackSrcQueryId,
      source_join_column: srcJoin,
      target_table: matchedTarget?.tableName || dl.target_table,
      target_join_column: tgtJoin,
      fallback_source_join_column: fbSrc,
      fallback_target_join_column: fbTgt,
      match_mode: dl.match_mode || 'case_insensitive',
    };
  });

  // Map table names in left_source/right_source cleanly to lookup_id or query_id when the model passes table names
  const sourceAliasToId = new Map();
  for (const tq of tableQueries) {
    sourceAliasToId.set(String(tq.query_id).toLowerCase(), tq.query_id);
    sourceAliasToId.set(String(tq.table_name).toLowerCase(), tq.query_id);
  }
  for (const dl of dependentLookups) {
    sourceAliasToId.set(String(dl.lookup_id).toLowerCase(), dl.lookup_id);
    sourceAliasToId.set(String(dl.target_table).toLowerCase(), dl.lookup_id);
  }

  const crossTableComparisons = (rawArgs.cross_table_comparisons || []).map((cmp, idx) => {
    let tf = cmp.threshold_filter || undefined;
    if (tf && typeof tf === 'object') {
      const numVal =
        tf.value !== null && tf.value !== undefined && tf.value !== ''
          ? Number(tf.value)
          : undefined;
      tf = {
        op: tf.op,
        ...(Number.isFinite(numVal) ? { value: numVal } : {}),
        ...(tf.column ? { column: tf.column } : {}),
        ...(tf.source ? { source: sourceAliasToId.get(String(tf.source).trim().toLowerCase()) || tf.source } : {}),
      };
    }
    const leftMapped = sourceAliasToId.get(String(cmp.left_source || '').trim().toLowerCase()) || cmp.left_source;
    const rightMapped = sourceAliasToId.get(String(cmp.right_source || '').trim().toLowerCase()) || cmp.right_source;
    return {
      ...cmp,
      left_source: leftMapped,
      right_source: rightMapped,
      result_alias: cmp.result_alias || `comparison_${idx + 1}`,
      threshold_filter: tf,
    };
  });

  return {
    table_queries: tableQueries,
    dependent_lookups: dependentLookups,
    cross_table_comparisons: crossTableComparisons,
  };
}

function compactRowForToolObservation(row, idx = 1, schema = null, explicitRowId = null) {
  if (!row || typeof row !== 'object') return row;
  const skip = new Set([
    'id',
    'business_id',
    'workspace_id',
    'user_id',
    'workspace_document_id',
    '_google_row_index',
    'created_at',
    'updated_at',
    'images',
    'image_url',
    'product_url',
    'url',
  ]);
  const out = {
    _row_id: explicitRowId || resolveRowIdentifier(row, idx, schema),
  };
  for (const [k, v] of Object.entries(row)) {
    const lower = k.toLowerCase();
    if (skip.has(lower)) continue;
    if (v === null || v === undefined) continue;
    if (typeof v === 'string') {
      const clean = v.replace(/\s+/g, ' ').trim();
      if (!clean) continue;
      if (/^(?:description|notes?|comments?|summary|details)$/i.test(lower)) {
        out[k] = clean.length > 70 ? `${clean.slice(0, 67)}...` : clean;
      } else {
        out[k] = clean.length > 140 ? `${clean.slice(0, 137)}...` : clean;
      }
    } else {
      out[k] = v;
    }
  }
  return out;
}

function redactRowForCustomer(row) {
  if (!row || typeof row !== 'object') return row;
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    const lower = k.toLowerCase();
    if (
      [
        'id',
        'business_id',
        'workspace_id',
        'user_id',
        'workspace_document_id',
        '_google_row_index',
        'created_at',
        'updated_at',
      ].includes(lower)
    ) {
      continue;
    }
    if (
      /(?:cost|margin|profit|wholesale_cost|hub_?lead|lead_?email|staff_?email|coordinator|nurse_?email|unit_?contact|internal)/i.test(
        lower
      )
    ) {
      continue;
    }
    out[k] = v;
  }
  return out;
}

function filterRowsForCustomerContext(rows = [], schema, tableName, customerContext = {}) {
  const roles = classifyTableColumns(schema, rows);
  const custEmail = String(customerContext?.customer_email || '').trim().toLowerCase();
  const refId = String(customerContext?.reference_id || '').trim().toLowerCase();
  const custName = String(customerContext?.customer_name || '').trim().toLowerCase();

  const isPrivateRecordTable =
    Boolean(roles.emailCol || roles.customerNameCol) ||
    /(?:orders?|backorders?|invoices?|receivables|accounts?|preorders?|transfers?|customers?|tickets?)/i.test(
      tableName
    );

  if (!isPrivateRecordTable) {
    // Public catalog/product table — keep rows but redact sensitive cost/internal cols
    return rows.map((r) => redactRowForCustomer(r));
  }

  if (!custEmail && !refId && !custName) {
    return [];
  }

  const matched = rows.filter((row) => {
    const rowEmail = roles.emailCol
      ? String(row[roles.emailCol] ?? '').trim().toLowerCase()
      : '';
    if (custEmail && rowEmail) {
      if (rowEmail === custEmail) return true;
    }
    if (refId) {
      const idVals = Object.entries(row)
        .filter(([k]) => /(?:^id$|_id$|_code$|ref|reference|order|account|invoice|number)/i.test(k))
        .map(([, v]) => String(v ?? '').trim().toLowerCase());
      if (idVals.includes(refId)) return true;
    }
    if (custName && !custEmail && roles.customerNameCol) {
      const rowName = String(row[roles.customerNameCol] ?? '').trim().toLowerCase();
      if (rowName && (rowName === custName || rowName.includes(custName))) {
        return true;
      }
    }
    return false;
  });

  return matched.map((r) => redactRowForCustomer(r));
}

async function ensureTableLoadedWithRows(businessId, tableName, context) {
  const lowerKey = String(tableName || '').trim().toLowerCase();
  if (context.loadedTablesByName.has(lowerKey)) {
    return context.loadedTablesByName.get(lowerKey);
  }

  const matchedMetaTable = (context.tables || []).find(
    (t) =>
      String(t.tableName || '').toLowerCase() === lowerKey ||
      String(t.displayName || '').toLowerCase() === lowerKey ||
      normalizeEntityName(t.tableName).toLowerCase() === normalizeEntityName(tableName).toLowerCase()
  );
  const resolvedName = matchedMetaTable?.tableName || tableName;
  const schema =
    matchedMetaTable?.schema ||
    (await discoverTableSchema(resolvedName, businessId, {
      useCache: true,
      skipSampleQuery: true,
    }));
  if (!schema) {
    throw new AppError(`Table "${tableName}" does not exist in this workspace.`, 400);
  }

  const bizColExact = schema.columns.business_id?.exactName || 'business_id';
  const bizColSql =
    bizColExact === 'business_id' ? 'business_id' : quoteIdentifier(bizColExact);
  const whereBiz = schema.columns?.workspace_id
    ? `(${bizColSql} = $1 OR workspace_id = $1)`
    : `${bizColSql} = $1`;
  const sql = `SELECT * FROM ${quoteIdentifier(schema.tableName)} WHERE ${whereBiz} LIMIT 300;`;
  const res = await query(sql, [businessId]);
  const rows = Array.isArray(res?.rows) ? res.rows : [];
  const columnRoles = classifyTableColumns(schema, rows);
  const entry = {
    tableName: schema.tableName,
    displayName: matchedMetaTable?.displayName || schema.displayName || schema.tableName,
    schema,
    rows,
    columnRoles,
    metadata: matchedMetaTable?.metadata || null,
  };
  context.loadedTablesByName.set(schema.tableName.toLowerCase(), entry);
  context.loadedTablesByName.set(lowerKey, entry);
  return entry;
}

function normalizeMutationUpdates(updates, schema) {
  const normalized = [];
  if (Array.isArray(updates)) {
    for (const item of updates) {
      normalized.push({ column: item.column, rawValue: item.new_value });
    }
  } else if (updates && typeof updates === 'object') {
    for (const [k, v] of Object.entries(updates)) {
      normalized.push({ column: k, rawValue: v });
    }
  }
  return normalized.map((u) => {
    const col = findColumnDef(schema, u.column);
    if (!col || !col.colDef.modifiable || col.colDef.virtual) {
      throw new AppError(
        `Column "${u.column}" is invalid or read-only on table "${schema.tableName}".`,
        400
      );
    }
    const coerced = coerceValueForColumn(col.colDef, col.exactName, u.rawValue);
    return {
      exactName: col.exactName,
      colDef: col.colDef,
      coercedValue: coerced,
    };
  });
}

function serializePreviewDiffValue(val, colDef) {
  if (val === null || val === undefined) return val;
  if (
    (colDef?.nestedMap ||
      colDef?.type === 'json' ||
      String(colDef?.storageType || '').toLowerCase().includes('json')) &&
    typeof val === 'object'
  ) {
    return JSON.stringify(val);
  }
  if (typeof val === 'object') {
    return JSON.stringify(val);
  }
  return val;
}

function findMatchingLiveRow(rows = [], schema, rowIdentifier) {
  const target = String(rowIdentifier || '').trim().toLowerCase();
  if (!target) return null;
  const targetNorm = target.replace(/[^a-z0-9]+/g, '');

  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    const info = resolveRowIdentifierInfo(row, i + 1, schema);
    if (info.identifier.toLowerCase() === target) {
      return { row, rowInfo: info };
    }
    if (row.id !== undefined && String(row.id).trim().toLowerCase() === target) {
      return { row, rowInfo: info };
    }
    for (const [k, v] of Object.entries(row)) {
      if (
        /(?:^id$|_id$|_code$|sku|order|account|invoice|unit_id|preorder|name|title|item)/i.test(k) &&
        String(v ?? '').trim().toLowerCase() === target
      ) {
        return {
          row,
          rowInfo: {
            identifier: String(v).trim(),
            column: info.column || k,
          },
        };
      }
    }
  }

  // Normalized alphanumeric fallback for apostrophes / spacing punctuation on item names & codes
  if (targetNorm.length >= 3) {
    for (let i = 0; i < rows.length; i += 1) {
      const row = rows[i];
      const info = resolveRowIdentifierInfo(row, i + 1, schema);
      if (info.identifier.toLowerCase().replace(/[^a-z0-9]+/g, '') === targetNorm) {
        return { row, rowInfo: info };
      }
      for (const [k, v] of Object.entries(row)) {
        if (/(?:^id$|_id$|_code$|sku|order|account|invoice|unit_id|preorder|name|title|item)/i.test(k)) {
          const valNorm = String(v ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');
          if (valNorm === targetNorm) {
            return {
              row,
              rowInfo: {
                identifier: info.identifier || String(v).trim(),
                column: info.column || k,
              },
            };
          }
        }
      }
    }
  }

  // Schema-agnostic hyphenated-code substring fallback (e.g., VL-POLO-BLK mentioned inside catalog prose)
  if (/^[a-z0-9]+(?:-[a-z0-9]+)+$/i.test(target)) {
    const escaped = target.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&');
    const codeRx = new RegExp(`\\b${escaped}\\b`, 'i');
    const codeMatches = [];
    for (let i = 0; i < rows.length; i += 1) {
      const row = rows[i];
      if (Object.values(row).some((v) => typeof v === 'string' && codeRx.test(v))) {
        codeMatches.push({ row, rowInfo: resolveRowIdentifierInfo(row, i + 1, schema) });
      }
    }
    if (codeMatches.length === 1) {
      return codeMatches[0];
    }
  }
  return null;
}

function preprocessRawToolArgs(toolName, rawArgs) {
  if (!rawArgs || typeof rawArgs !== 'object') {
    return rawArgs || {};
  }
  if (toolName === 'search_docs') {
    const queryList = Array.isArray(rawArgs.queries)
      ? rawArgs.queries.map((q) => String(q || '').trim()).filter(Boolean)
      : [];
    const primaryQuery =
      String(rawArgs.query || rawArgs.search_query || rawArgs.q || queryList[0] || '').trim();
    const expanded = Array.isArray(rawArgs.expanded_queries)
      ? rawArgs.expanded_queries
      : queryList.slice(1);
    return {
      ...rawArgs,
      query: primaryQuery,
      expanded_queries: expanded,
    };
  }
  if (toolName !== 'query_tables_with_lookup') {
    return rawArgs;
  }

  const normalizeFilterList = (rawFilters) => {
    if (!rawFilters) return [];
    if (!Array.isArray(rawFilters) && typeof rawFilters === 'object') {
      return Object.entries(rawFilters).map(([k, v]) => ({
        field: k,
        operator: Array.isArray(v) ? 'in' : 'equals',
        value: v,
      }));
    }
    if (!Array.isArray(rawFilters)) return [];
    return rawFilters
      .map((f) => {
        if (!f || typeof f !== 'object') return null;
        const field = f.field || f.column || f.col || f.name || f.key || '';
        const operator = f.operator || f.op || 'equals';
        const value = f.value !== undefined ? f.value : f.val !== undefined ? f.val : f.values;
        return field ? { field: String(field), operator: String(operator), value } : null;
      })
      .filter(Boolean);
  };

  const VALID_MODES = new Set(['exact', 'case_insensitive', 'normalized_string']);
  const normalizeSort = (rawSort) => {
    if (!rawSort) return [];
    const arr = Array.isArray(rawSort) ? rawSort : [rawSort];
    return arr
      .filter((s) => s && typeof s === 'object' && (s.field || s.column))
      .map((s) => ({
        field: String(s.field || s.column),
        direction: String(s.direction || s.dir || 'asc').toLowerCase() === 'desc' ? 'desc' : 'asc',
      }));
  };

  const parseThresholdFilter = (tf) => {
    if (!tf) return undefined;
    if (typeof tf === 'string') {
      const m = tf.trim().match(/^(<=|>=|==|!=|<|>)\s*(-?\d+(?:\.\d+)?)$/);
      if (m) return { op: m[1], value: Number(m[2]) };
      return undefined;
    }
    return tf;
  };

  return {
    ...rawArgs,
    table_queries: (Array.isArray(rawArgs.table_queries) ? rawArgs.table_queries : []).map((tq) => ({
      ...tq,
      table_name: tq?.table_name || tq?.table || tq?.entity || '',
      filters: normalizeFilterList(tq?.filters),
      order_by: normalizeSort(tq?.order_by),
      sort: normalizeSort(tq?.sort),
    })),
    dependent_lookups: (Array.isArray(rawArgs.dependent_lookups) ? rawArgs.dependent_lookups : []).map((dl) => {
      const mode = String(dl?.match_mode || 'case_insensitive').trim().toLowerCase();
      return {
        ...dl,
        match_mode: VALID_MODES.has(mode) ? mode : 'case_insensitive',
      };
    }),
    cross_table_comparisons: (
      Array.isArray(rawArgs.cross_table_comparisons) ? rawArgs.cross_table_comparisons : []
    ).map((cmp) => ({
      ...cmp,
      threshold_filter: parseThresholdFilter(cmp?.threshold_filter),
    })),
  };
}

/**
 * Executes one schema-agnostic tool call with strict Zod validation and zero direct DB writes/sends.
 *
 * @param {string} toolName
 * @param {object} rawArgs
 * @param {object} context
 */
async function executeToolCall(toolName, rawArgs, context) {
  const schema = ToolPayloadSchemas[toolName];
  if (!schema) {
    return { ok: false, tool_name: toolName, error: `Unknown tool "${toolName}".` };
  }

  if (
    context.requestEntity === 'customer' &&
    !['search_docs', 'query_tables_with_lookup'].includes(toolName)
  ) {
    return {
      ok: false,
      tool_name: toolName,
      error: `Tool "${toolName}" is strictly forbidden in customer persona mode (read-only only).`,
    };
  }

  const preprocessedArgs = preprocessRawToolArgs(toolName, rawArgs);
  const parsed = schema.safeParse(preprocessedArgs);
  if (!parsed.success) {
    console.warn(`[ReAct Tool Zod Reject] ${toolName}:`, JSON.stringify(parsed.error.issues));
    return {
      ok: false,
      tool_name: toolName,
      error: 'Invalid tool arguments',
      issues: parsed.error.issues.map((i) => ({
        path: i.path.join('.'),
        message: i.message,
      })),
    };
  }
  const args = parsed.data;

  // 1. search_docs
  if (toolName === 'search_docs') {
    const topK = Math.min(8, Math.max(1, args.top_k || 6));
    let chunks = await hybridSearchDocumentChunks({
      workspaceId: context.businessId,
      query: args.query,
      expandedQueries: args.expanded_queries || [],
      docTypes: args.doc_types || null,
      topK,
    });
    if (args.doc_types && chunks.length < 2) {
      const unfiltered = await hybridSearchDocumentChunks({
        workspaceId: context.businessId,
        query: args.query,
        expandedQueries: args.expanded_queries || [],
        docTypes: null,
        topK,
      });
      if (unfiltered.length > chunks.length) chunks = unfiltered;
    }

    const existingIds = new Set(
      context.observedChunks.map((c) => String(c.chunk_id || c.id || '').toLowerCase())
    );
    for (const c of chunks) {
      const cid = String(c.chunk_id || c.id || '').toLowerCase();
      if (!existingIds.has(cid)) {
        existingIds.add(cid);
        context.observedChunks.push(c);
      }
    }

    return {
      ok: true,
      tool_name: 'search_docs',
      chunks: chunks.map((c, idx) => ({
        chunk_id: c.chunk_id || c.id || `chunk-${idx + 1}`,
        filename: c.filename,
        locator: c.locator || `Page ${c.page_number || 1}`,
        doc_type: c.doc_type || 'general',
        breadcrumb_header: c.breadcrumb_header || null,
        raw_text: String(c.raw_text || '').slice(0, 750),
      })),
    };
  }

  // 2. query_tables_with_lookup (Option B)
  if (toolName === 'query_tables_with_lookup') {
    try {
      const normalizedPlan = normalizeReadArgsForPlanner(args, context.tables);
      const validatedPlan = validateReadPlan(
        normalizedPlan,
        context.tables,
        context.prompt,
        context.observedChunks
      );

      if (!Array.isArray(validatedPlan) || validatedPlan.length === 0) {
        return {
          ok: false,
          tool_name: 'query_tables_with_lookup',
          error: 'No valid query plan could be built from those table/column names. Check WORKSPACE TABLE METADATA exact names.',
        };
      }

      const queryResults = [];
      const anchorResultsById = new Map();
      const highlighted = [];

      for (let i = 0; i < validatedPlan.length; i += 1) {
        const tablePlan = validatedPlan[i];
        const exec = await executeReadQuery(context.businessId, tablePlan);
        const queryId = tablePlan.queryId || `q_${i + 1}`;
        const rawRows = Array.isArray(exec.rows) ? exec.rows : [];
        const scopedRows =
          context.requestEntity === 'customer'
            ? filterRowsForCustomerContext(
                rawRows,
                tablePlan.table.schema,
                tablePlan.table.tableName,
                context.customerContext
              )
            : rawRows;

        const entry = {
          query_id: queryId,
          table_name: tablePlan.table.tableName,
          row_count: scopedRows.length,
          rows: scopedRows.slice(0, 25).map((r, rIdx) => compactRowForToolObservation(r, rIdx + 1, tablePlan.table.schema)),
          ...(Object.keys(exec.summary || {}).length > 0 ? { summary: exec.summary } : {}),
        };
        queryResults.push(entry);
        anchorResultsById.set(queryId, {
          query_id: queryId,
          table_name: tablePlan.table.tableName,
          schema: tablePlan.table.schema,
          rows: scopedRows,
        });

        for (let rIdx = 0; rIdx < scopedRows.length; rIdx += 1) {
          const row = scopedRows[rIdx];
          const rid = resolveRowIdentifier(row, rIdx + 1, tablePlan.table.schema);
          context.observedRows.push({
            table_name: tablePlan.table.tableName,
            row_identifier: rid,
            schema: tablePlan.table.schema,
            row,
          });
        }
        if (scopedRows.length > 0 && context.requestEntity !== 'customer') {
          highlighted.push(
            ...buildHighlightedRows(
              tablePlan.table.schema.entity || tablePlan.table.tableName,
              scopedRows.slice(0, 20)
            )
          );
        }
      }

      const dependentLookups = Array.isArray(validatedPlan.dependentLookups)
        ? validatedPlan.dependentLookups
        : [];
      const crossTableComparisons = Array.isArray(validatedPlan.crossTableComparisons)
        ? validatedPlan.crossTableComparisons
        : [];

      const lookupResults = [];
      const lookupResultsById = new Map();
      for (const lookup of dependentLookups) {
        const anchorRes = anchorResultsById.get(lookup.sourceQueryId);
        const lookupExec = await executeDependentLookupQuery(
          context.businessId,
          lookup,
          anchorRes?.rows || []
        );
        const rawLookupRows = Array.isArray(lookupExec.rows) ? lookupExec.rows : [];
        const scopedLookupRows =
          context.requestEntity === 'customer'
            ? filterRowsForCustomerContext(
                rawLookupRows,
                lookup.targetTable.schema,
                lookup.targetTable.tableName,
                context.customerContext
              )
            : rawLookupRows;

        const lookupEntry = {
          lookup_id: lookup.lookupId,
          table_name: lookup.targetTable.tableName,
          row_count: scopedLookupRows.length,
          rows: scopedLookupRows.slice(0, 25).map((r, lIdx) => compactRowForToolObservation(r, lIdx + 1, lookup.targetTable.schema)),
          used_fallback: lookupExec.usedFallback,
        };
        lookupResults.push(lookupEntry);
        lookupResultsById.set(lookup.lookupId, {
          lookup_id: lookup.lookupId,
          table_name: lookup.targetTable.tableName,
          schema: lookup.targetTable.schema,
          rows: scopedLookupRows,
        });

        for (let lIdx = 0; lIdx < scopedLookupRows.length; lIdx += 1) {
          const lRow = scopedLookupRows[lIdx];
          const rid = resolveRowIdentifier(lRow, lIdx + 1, lookup.targetTable.schema);
          context.observedRows.push({
            table_name: lookup.targetTable.tableName,
            row_identifier: rid,
            schema: lookup.targetTable.schema,
            row: lRow,
          });
        }
      }

      let crossTableEval = null;
      if (dependentLookups.length > 0 && context.requestEntity !== 'customer') {
        crossTableEval = joinAndEvaluateCrossTableComparisons({
          anchorResultsById,
          lookupResultsById,
          dependentLookups,
          crossTableComparisons,
        });
      }

      const compactPairs = crossTableEval
        ? (crossTableEval.pairs || []).slice(0, 20).map((p, pIdx) => ({
            anchor_table: p.anchorTableName,
            anchor_row_id: p.anchorRowIdentifier,
            lookup_table: p.lookupTableName,
            lookup_row_id: p.lookupRowIdentifier,
            computed: p.computedValues,
            threshold_breached: p.thresholdBreached,
            anchor_row: compactRowForToolObservation(p.anchorRow, pIdx + 1, null, p.anchorRowIdentifier),
            lookup_row: compactRowForToolObservation(p.lookupRow, pIdx + 1, null, p.lookupRowIdentifier),
          }))
        : null;

      return {
        ok: true,
        tool_name: 'query_tables_with_lookup',
        // When cross_table_evaluation.pairs already carries every joined anchor+lookup row, keep query_results/lookup_results summary-only to save >50% prompt tokens
        query_results: compactPairs
          ? queryResults.map(({ query_id, table_name, row_count, summary }) => ({
              query_id,
              table_name,
              row_count,
              ...(summary ? { summary } : {}),
            }))
          : queryResults,
        lookup_results: compactPairs
          ? lookupResults.map(({ lookup_id, table_name, row_count }) => ({
              lookup_id,
              table_name,
              row_count,
            }))
          : lookupResults,
        cross_table_evaluation: compactPairs
          ? {
              total_joined: crossTableEval.totalJoined,
              unmatched_count: crossTableEval.unmatchedCount,
              breaching_count: crossTableEval.breachingCount,
              compliant_count: crossTableEval.compliantCount,
              pairs: compactPairs,
            }
          : null,
      };
    } catch (err) {
      console.warn(`[ReAct Tool Error] query_tables_with_lookup:`, err?.message);
      return {
        ok: false,
        tool_name: 'query_tables_with_lookup',
        error: err?.message || 'Failed to execute query_tables_with_lookup',
      };
    }
  }

  // 3. propose_table_mutations (Stage 1 Diff Builder — NEVER writes SQL)
  if (toolName === 'propose_table_mutations') {
    try {
      const staged = [];
      const violations = [];
      const rule = args.policy_rule_applied || null;

      if (rule?.citation_chunk_id && context.observedChunks.length > 0) {
        const cited = context.observedChunks.find(
          (c) =>
            String(c.chunk_id || c.id || '').toLowerCase() ===
            String(rule.citation_chunk_id).trim().toLowerCase()
        );
        if (!cited) {
          return {
            ok: false,
            tool_name: 'propose_table_mutations',
            error: `Unverified citation_chunk_id "${rule.citation_chunk_id}". Use a valid chunk_id from search_docs or retrieved RRF chunks.`,
          };
        }
      }

      for (const mut of args.mutations) {
        if (mut.operation !== 'update') {
          return {
            ok: false,
            tool_name: 'propose_table_mutations',
            error: `Operation "${mut.operation}" is not supported in multi-table allocation; use "update" or ask Socratic clarification.`,
          };
        }
        const tableCtx = await ensureTableLoadedWithRows(
          context.businessId,
          mut.table_name,
          context
        );
        const match = findMatchingLiveRow(tableCtx.rows, tableCtx.schema, mut.row_identifier);
        if (!match) {
          const validIds = tableCtx.rows
            .slice(0, 25)
            .map((r, idx) => resolveRowIdentifier(r, idx + 1, tableCtx.schema))
            .filter(Boolean);
          return {
            ok: false,
            tool_name: 'propose_table_mutations',
            error: `Row "${mut.row_identifier}" not found in table "${tableCtx.tableName}". Use exact _row_id from this list: ${JSON.stringify(validIds)}.`,
          };
        }

        const coercedFields = normalizeMutationUpdates(mut.updates, tableCtx.schema);
        const beforeObj = {};
        const afterObj = {};
        for (const fieldSpec of coercedFields) {
          beforeObj[fieldSpec.exactName] = serializePreviewDiffValue(
            match.row[fieldSpec.exactName],
            fieldSpec.colDef
          );
          afterObj[fieldSpec.exactName] = fieldSpec.coercedValue;
        }

        // Dynamic reserve enforcement on deducted numeric columns
        const schemaColumns = Object.values(tableCtx.schema.columns || {}).map((c) => ({
          name: c.exactName,
          type: c.type,
        }));
        const modifiableColumns = schemaColumns;
        const secondaryReserveRule = extractSecondaryReserveRule(
          { tableName: tableCtx.tableName, schemaColumns, modifiableColumns },
          context.observedChunks,
          context.prompt,
          { waive_reserve: Boolean(rule?.waive_reserve) }
        );

        const ruleMatchesThisTable =
          rule &&
          normalizeEntityName(rule.target_table).toLowerCase() ===
            normalizeEntityName(tableCtx.tableName).toLowerCase();

        for (const fieldSpec of coercedFields) {
          if (!['integer', 'number'].includes(fieldSpec.colDef.type)) continue;
          const oldNum = Number(match.row[fieldSpec.exactName]);
          const newNum = Number(fieldSpec.coercedValue);
          if (!Number.isFinite(oldNum) || !Number.isFinite(newNum) || newNum >= oldNum) {
            continue;
          }

          let minReserve = null;
          if (!rule?.waive_reserve) {
            if (
              ruleMatchesThisTable &&
              (!rule.numeric_column ||
                rule.numeric_column.toLowerCase() === fieldSpec.exactName.toLowerCase())
            ) {
              if (rule.threshold_column) {
                const colVal = Number(match.row[rule.threshold_column]);
                if (Number.isFinite(colVal)) minReserve = colVal;
              } else if (Number.isFinite(Number(rule.min_reserve_threshold))) {
                minReserve = Number(rule.min_reserve_threshold);
              }
            } else if (secondaryReserveRule?.mode === 'column') {
              const colVal = Number(match.row[secondaryReserveRule.columnName]);
              if (Number.isFinite(colVal)) minReserve = colVal;
            } else if (
              secondaryReserveRule?.mode === 'constant' &&
              /(?:stock|available|qty|quantity|clean_beds|beds|credit|balance|units)/i.test(
                fieldSpec.exactName
              )
            ) {
              minReserve = secondaryReserveRule.minReserve;
            }
          }

          if (minReserve !== null && newNum < minReserve) {
            violations.push({
              table_name: tableCtx.tableName,
              row_identifier: match.rowInfo.identifier,
              column: fieldSpec.exactName,
              before: oldNum,
              attempted_after: newNum,
              min_reserve_threshold: minReserve,
              reason: `Deduction leaves ${newNum} in "${tableCtx.tableName}.${fieldSpec.exactName}", below mandatory reserve ${minReserve}.`,
            });
          }
        }

        staged.push({
          table_name: tableCtx.tableName,
          row_identifier: match.rowInfo.identifier,
          _internal_id: match.row.id || null,
          _identifier_col: match.rowInfo.column || tableCtx.schema.primaryKey || 'id',
          before: beforeObj,
          after: afterObj,
          reason: mut.reason || null,
        });

        context.observedRows.push({
          table_name: tableCtx.tableName,
          row_identifier: match.rowInfo.identifier,
          schema: tableCtx.schema,
          row: match.row,
        });
      }

      if (violations.length > 0) {
        console.warn(`[ReAct Tool Reserve Violation] propose_table_mutations:`, JSON.stringify(violations));
        return {
          ok: false,
          tool_name: 'propose_table_mutations',
          error: 'POLICY_RESERVE_VIOLATION',
          violations,
          message:
            'Proposed deduction(s) violate the mandatory reserve threshold. Exclude over-allocating rows from propose_table_mutations (keeping only compliant allocations where after >= reserve), or invoke ask_socratic_clarification.',
        };
      }

      context.proposedMutations = staged;
      return {
        ok: true,
        tool_name: 'propose_table_mutations',
        staged_count: staged.length,
        mutations_preview: staged.map(({ table_name, row_identifier, before, after }) => ({
          table_name,
          row_identifier,
          before,
          after,
        })),
      };
    } catch (err) {
      console.warn(`[ReAct Tool Error] propose_table_mutations:`, err?.message);
      return {
        ok: false,
        tool_name: 'propose_table_mutations',
        error: err?.message || 'Failed to validate proposed mutations',
      };
    }
  }

  // 4. draft_emails (Stage 1 Draft Builder — NEVER calls sendIndividualEmail)
  if (toolName === 'draft_emails') {
    try {
      const effectiveAudienceScope =
        context.targetAudienceScope === 'primary_customers_only'
          ? 'primary_customers_only'
          : args.audience_scope;

      for (const t of context.tables || []) {
        await ensureTableLoadedWithRows(context.businessId, t.tableName, context);
      }
      const uniqueLoadedTables = [];
      const seenT = new Set();
      for (const entry of context.loadedTablesByName.values()) {
        if (!entry?.tableName) continue;
        const k = entry.tableName.toLowerCase();
        if (!seenT.has(k)) {
          seenT.add(k);
          uniqueLoadedTables.push(entry);
        }
      }

      const audienceTables = selectAudienceRecipientTables(
        uniqueLoadedTables,
        context.prompt,
        effectiveAudienceScope
      );

      const allowedByEmail = new Map();
      for (const tbl of audienceTables) {
        const emailCol = tbl.columnRoles?.emailCol;
        if (!emailCol) continue;
        tbl.rows.forEach((row, idx) => {
          const emailVal = String(row[emailCol] ?? '').trim();
          if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailVal)) return;
          const rid = resolveRowIdentifier(row, idx + 1, tbl.schema);
          if (!allowedByEmail.has(emailVal.toLowerCase())) {
            allowedByEmail.set(emailVal.toLowerCase(), {
              table_name: tbl.tableName,
              email_col: emailCol,
              row_identifier: rid,
              email: emailVal,
            });
          }
        });
      }

      const blockedEmails = [];
      const drafted = [];
      for (const rec of args.recipients) {
        const lowerEmail = String(rec.email || '').trim().toLowerCase();
        const allowed = allowedByEmail.get(lowerEmail);
        if (!allowed) {
          blockedEmails.push({
            email: rec.email,
            reason:
              effectiveAudienceScope === 'primary_customers_only'
                ? 'Blocked: address is not in the primary external customer/buyer recipient directory (internal stakeholder emails excluded).'
                : 'Blocked: address not found in active workspace allowed recipients.',
          });
          continue;
        }
        drafted.push({
          recipient_email: allowed.email,
          customer_identifier: rec.name
            ? rec.record_id
              ? `${rec.name} (${rec.record_id})`
              : rec.name
            : rec.record_id || allowed.row_identifier,
          subject: rec.subject.slice(0, 255),
          body: rec.body,
          applied_rule:
            rec.applied_rule ||
            `Outcome: ${rec.outcome_type} under verified workspace policy`,
          metadata: {
            row_identifier: rec.record_id || allowed.row_identifier,
            table_name: allowed.table_name,
            outcome_type: rec.outcome_type,
            audience_scope: effectiveAudienceScope,
          },
        });
      }

      if (drafted.length === 0) {
        console.warn(
          '[ReAct Tool Error] draft_emails NO_ALLOWED_RECIPIENTS_MATCHED:',
          JSON.stringify({
            scope: effectiveAudienceScope,
            audienceTables: audienceTables.map((t) => ({ table: t.tableName, emailCol: t.columnRoles?.emailCol, rows: t.rows?.length })),
            blocked: blockedEmails,
          })
        );
        return {
          ok: false,
          tool_name: 'draft_emails',
          error: 'NO_ALLOWED_RECIPIENTS_MATCHED',
          blocked: blockedEmails,
          allowed_recipients_hint: [...allowedByEmail.values()].slice(0, 12).map((a) => ({
            email: a.email,
            record_id: a.row_identifier,
            table_name: a.table_name,
          })),
        };
      }

      // Enforce decoupled dual-outcome audience coverage when full-audience notification is requested
      const asksFullAudience =
        /\b(?:all\s+(?:\d+\s+)?(?:customers?|buyers?|clients?|accounts?|orders?|affected|recipients?|patients?|physicians?)|every\s+(?:customer|buyer|client|account|order|affected|recipient|physician)|each\s+(?:customer|buyer|client|account|order|recipient)|whether\s+(?:fulfilled|approved|cleared|eligible)\s+or\s+(?:not|remain|unfulfilled|backordered|on\s+hold|deferred))\b/i.test(
          String(context.prompt || '')
        );
      if (asksFullAudience && effectiveAudienceScope !== 'internal_stakeholders_only') {
        const audienceTableNames = new Set(
          audienceTables.map((t) => String(t.tableName || '').toLowerCase())
        );
        const evaluatedExternalRecords = [];
        const seenEvalKeys = new Set();
        for (const obsRow of context.observedRows || []) {
          const tblLower = String(obsRow.table_name || '').toLowerCase();
          if (!audienceTableNames.has(tblLower)) continue;
          const tblObj = audienceTables.find((t) => String(t.tableName || '').toLowerCase() === tblLower);
          const eCol = tblObj?.columnRoles?.emailCol;
          if (!eCol) continue;
          const emailStr = String(obsRow.row?.[eCol] ?? '').trim();
          if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailStr)) continue;
          const evalKey = `${tblLower}::${String(obsRow.row_identifier || '').toLowerCase()}`;
          if (!seenEvalKeys.has(evalKey)) {
            seenEvalKeys.add(evalKey);
            evaluatedExternalRecords.push({
              record_id: obsRow.row_identifier,
              table_name: obsRow.table_name,
              email: emailStr,
              name:
                obsRow.row?.[tblObj?.columnRoles?.customerNameCol] ||
                obsRow.row?.Customer_Name ||
                obsRow.row?.buyer_name ||
                undefined,
            });
          }
        }

        const draftedEmailsLower = new Set(
          drafted.map((d) => String(d.recipient_email || '').trim().toLowerCase())
        );
        const missingRecords = evaluatedExternalRecords.filter(
          (er) => !draftedEmailsLower.has(er.email.toLowerCase())
        );
        if (evaluatedExternalRecords.length > drafted.length && missingRecords.length > 0 && evaluatedExternalRecords.length <= 15) {
          context.draftedEmails = drafted;
          return {
            ok: false,
            tool_name: 'draft_emails',
            error: 'INCOMPLETE_DUAL_OUTCOME_AUDIENCE',
            message: `Full-audience dual-outcome notification was requested, so you MUST include ALL ${evaluatedExternalRecords.length} evaluated external records (both fulfilled AND unfulfilled/backordered/held outcomes). Call draft_emails again with ALL ${evaluatedExternalRecords.length} recipients including these missing evaluated_unmutated_records.`,
            missing_records: missingRecords,
            already_drafted_emails: drafted.map((d) => d.recipient_email),
          };
        }
      }

      context.draftedEmails = drafted;
      return {
        ok: true,
        tool_name: 'draft_emails',
        drafted_count: drafted.length,
        blocked_count: blockedEmails.length,
        blocked: blockedEmails,
      };
    } catch (err) {
      return {
        ok: false,
        tool_name: 'draft_emails',
        error: err?.message || 'Failed to draft emails',
      };
    }
  }

  // 5. ask_socratic_clarification
  if (toolName === 'ask_socratic_clarification') {
    context.socraticClarification = {
      conflict_summary: args.conflict_summary,
      affected_rows_count: args.affected_rows_count || 0,
      conflicting_rows_count: args.conflicting_rows_count || 0,
      socratic_questions: args.socratic_questions,
      citations: args.citations || [],
    };
    return {
      ok: true,
      tool_name: 'ask_socratic_clarification',
      status: 'CLARIFICATION_REQUIRED',
    };
  }

  return { ok: false, tool_name: toolName, error: `Unhandled tool "${toolName}".` };
}

module.exports = {
  ALL_TOOL_DEFINITIONS,
  getToolDefinitionsForEntity,
  executeToolCall,
  selectAudienceRecipientTables,
  extractSecondaryReserveRule,
  isInternalStakeholderTable,
  buildDocumentCitation,
  buildTableRowCitation,
  ensureTableLoadedWithRows,
};
