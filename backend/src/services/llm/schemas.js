const { z } = require('zod');

const INTENT_LANES = [
  'CONVERSATIONAL',
  'CROSS_SOURCE_READ',
  'SINGLE_TABLE_MUTATION',
  'DOCUMENT_TABLE_SYNC',
  'AGENTIC_OPERATION',
];

const AUDIENCE_SCOPES = [
  'none',
  'primary_customers_only',
  'internal_stakeholders_only',
  'both_customers_and_internal',
];

const DOC_TYPES = ['policy', 'sop', 'manifest', 'faq', 'catalog', 'general'];

const TOOL_NAMES = [
  'search_docs',
  'query_tables_with_lookup',
  'propose_table_mutations',
  'draft_emails',
  'ask_socratic_clarification',
];

const IntentAndExpansionSchema = z.object({
  intent: z.enum(INTENT_LANES),
  confidence: z.number().min(0).max(1),
  primary_table: z.string().nullable().optional(),
  target_tables: z.array(z.string()).optional().default([]),
  expanded_queries: z.array(z.string().min(2)).min(1).max(3),
  doc_types: z.array(z.enum(DOC_TYPES)).nullable().optional(),
  requires_multi_table: z.boolean(),
  requests_email: z.boolean(),
  target_audience_scope: z.enum(AUDIENCE_SCOPES),
  conversational_reply: z.string().optional(),
});

const SearchDocsArgsSchema = z.object({
  query: z.string().min(1),
  expanded_queries: z.array(z.string().min(1)).max(5).optional().default([]),
  doc_types: z.array(z.enum(DOC_TYPES)).nullable().optional(),
  top_k: z.number().int().min(1).max(8).optional().default(6),
});

const QueryFilterSchema = z.object({
  field: z.string().min(1),
  operator: z.string().min(1),
  value: z.any().nullable().optional(),
});

const SortEntrySchema = z.object({
  field: z.string().min(1),
  direction: z.enum(['asc', 'desc', 'ASC', 'DESC']).nullable().optional().default('asc'),
});

const TableQuerySchema = z.object({
  query_id: z.string().nullable().optional(),
  table_name: z.string().min(1),
  filters: z.array(QueryFilterSchema).nullable().optional().default([]),
  calculation_filters: z.array(z.any()).nullable().optional().default([]),
  filter_logic: z.enum(['AND', 'OR', 'and', 'or']).nullable().optional().default('AND'),
  order_by: z.array(SortEntrySchema).nullable().optional().default([]),
  sort: z.array(SortEntrySchema).nullable().optional().default([]),
  limit: z.number().int().min(1).max(500).nullable().optional(),
  aggregates: z.array(z.any()).nullable().optional().default([]),
  calculations: z.array(z.any()).nullable().optional().default([]),
});

const DependentLookupSchema = z.object({
  lookup_id: z.string().nullable().optional().default('lookup_1'),
  source_query_id: z.string().nullable().optional(),
  source_join_column: z.string().min(1),
  target_table: z.string().min(1),
  target_join_column: z.string().min(1),
  fallback_source_join_column: z.string().nullable().optional(),
  fallback_target_join_column: z.string().nullable().optional(),
  match_mode: z.enum(['exact', 'case_insensitive', 'normalized_string']).nullable().optional().default('case_insensitive'),
});

const CrossTableComparisonSchema = z.object({
  left_source: z.string().min(1),
  left_column: z.string().min(1),
  operator: z.string().min(1),
  right_source: z.string().min(1),
  right_column: z.string().min(1),
  result_alias: z.string().nullable().optional().default('comparison_result'),
  threshold_filter: z
    .object({
      op: z.string().min(1),
      value: z.union([z.number(), z.string()]).nullable().optional(),
      column: z.string().nullable().optional(),
      source: z.string().nullable().optional(),
    })
    .nullable()
    .optional(),
});

const QueryTablesWithLookupArgsSchema = z.object({
  table_queries: z.array(TableQuerySchema).min(1),
  dependent_lookups: z.array(DependentLookupSchema).nullable().optional().default([]),
  cross_table_comparisons: z.array(CrossTableComparisonSchema).nullable().optional().default([]),
});

const MutationItemSchema = z.object({
  table_name: z.string().min(1),
  operation: z.enum(['update', 'create', 'delete']).nullable().optional().default('update'),
  row_identifier: z.string().min(1),
  updates: z.union([
    z.record(z.string(), z.any()),
    z.array(z.object({ column: z.string().min(1), new_value: z.any() })).min(1),
  ]),
  reason: z.string().nullable().optional(),
});

const PolicyRuleAppliedSchema = z.object({
  target_table: z.string().min(1),
  numeric_column: z.string().min(1),
  min_reserve_threshold: z.number().min(0).nullable().optional(),
  threshold_column: z.string().nullable().optional(),
  citation_chunk_id: z.string().nullable().optional(),
  waive_reserve: z.boolean().nullable().optional().default(false),
});

const ProposeTableMutationsArgsSchema = z.object({
  mutations: z.array(MutationItemSchema).min(1),
  policy_rule_applied: PolicyRuleAppliedSchema.nullable().optional(),
});

const DraftEmailRecipientSchema = z.object({
  email: z.string().email(),
  name: z.string().nullable().optional(),
  record_id: z.string().nullable().optional(),
  outcome_type: z.enum(['fulfilled', 'unfulfilled', 'notification', 'escalation']),
  subject: z.string().min(1),
  body: z.string().min(1),
  applied_rule: z.string().nullable().optional(),
});

const DraftEmailsArgsSchema = z.object({
  audience_scope: z.enum([
    'primary_customers_only',
    'internal_stakeholders_only',
    'both_customers_and_internal',
  ]),
  recipients: z.array(DraftEmailRecipientSchema).min(1),
});

const SocraticOptionSchema = z.object({
  option_id: z.string().min(1),
  label: z.string().min(1),
  rule_interpretation: z.string().min(1),
  execution_blueprint: z.any().nullable().optional(),
});

const SocraticQuestionSchema = z.object({
  question_id: z.string().min(1),
  question_text: z.string().min(1),
  options: z.array(SocraticOptionSchema).min(1),
});

const AskSocraticClarificationArgsSchema = z.object({
  conflict_summary: z.string().min(1),
  affected_rows_count: z.number().int().min(0).nullable().optional().default(0),
  conflicting_rows_count: z.number().int().min(0).nullable().optional().default(0),
  socratic_questions: z.array(SocraticQuestionSchema).min(1),
  citations: z.array(z.any()).nullable().optional().default([]),
});

const ToolPayloadSchemas = Object.freeze({
  search_docs: SearchDocsArgsSchema,
  query_tables_with_lookup: QueryTablesWithLookupArgsSchema,
  propose_table_mutations: ProposeTableMutationsArgsSchema,
  draft_emails: DraftEmailsArgsSchema,
  ask_socratic_clarification: AskSocraticClarificationArgsSchema,
});

const ReActToolCallEntrySchema = z.object({
  tool_name: z.enum(TOOL_NAMES),
  tool_args: z.any(),
});

const ReActFinalPayloadSchema = z.object({
  answer: z.string().nullable().optional(),
  category: z.string().nullable().optional(),
  missing_information: z.array(z.string()).nullable().optional().default([]),
  highlighted_row_ids: z.array(z.string()).nullable().optional().default([]),
  citations: z.array(z.any()).nullable().optional().default([]),
});

const ReActStepSchema = z.object({
  thought: z.string().min(1),
  action: z.enum(['call_tool', 'final_answer', 'socratic_pause', 'preview_ready']),
  tool_name: z.enum(TOOL_NAMES).nullable().optional(),
  tool_args: z.any().nullable().optional(),
  tool_calls: z.array(ReActToolCallEntrySchema).nullable().optional(),
  final_payload: ReActFinalPayloadSchema.nullable().optional(),
});

module.exports = {
  INTENT_LANES,
  AUDIENCE_SCOPES,
  DOC_TYPES,
  TOOL_NAMES,
  IntentAndExpansionSchema,
  ToolPayloadSchemas,
  ReActStepSchema,
};
