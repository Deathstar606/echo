/**
 * MaxiText AI Studio — Shared Domain Contracts & API Interfaces
 *
 * Reusable type definitions shared between backend and frontend services.
 * Supports dynamic, schema-agnostic inventory tables with flexible column definitions.
 */

// =============================================================================
// 1. Dynamic Sheet Rows & Column Metadata
// =============================================================================

/**
 * Flexible record representation for dynamic sheet rows across multiple businesses.
 * Does NOT enforce rigid fields (such as 'name' or 'price') to support arbitrary CSV schemas.
 */
export type DynamicSheetRow = Record<string, unknown> & {
  id?: string;
  business_id?: string;
  created_at?: string;
  updated_at?: string;
};

/**
 * Supported data types for dynamically discovered spreadsheet columns.
 */
export type SheetColumnType =
  | 'string'
  | 'number'
  | 'integer'
  | 'numeric'
  | 'boolean'
  | 'date'
  | 'timestamp'
  | 'uuid'
  | 'json'
  | 'map';

/**
 * Metadata definition for a single column in an active sheet.
 */
export interface SheetColumnDef {
  exactName: string;
  type: SheetColumnType;
  required?: boolean;
  readonly?: boolean;
  queryable?: boolean;
  modifiable?: boolean;
  sortable?: boolean;
  operators?: QueryOperator[];
  allowedValues?: string[];
  description?: string;
  virtual?: boolean;
  nestedMap?: boolean;
  nestedStructure?: Record<string, string>;
  storageType?: string;
}

/**
 * Schema definition describing an active business spreadsheet entity.
 */
export interface SheetSchema {
  entity: string;
  tableName: string;
  displayName: string;
  columns: Record<string, SheetColumnDef>;
  representativeValues?: Record<string, unknown[]>;
  searchableColumns?: string[];
  primaryKey?: string;
}

// =============================================================================
// 2. Query Operations, Filters & Responses
// =============================================================================

export type NumericOperator =
  | 'equals'
  | 'not_equals'
  | 'greater_than'
  | 'greater_than_or_equal'
  | 'less_than'
  | 'less_than_or_equal'
  | 'between';

export type StringOperator =
  | 'equals'
  | 'not_equals'
  | 'contains'
  | 'not_contains'
  | 'starts_with'
  | 'ends_with'
  | 'in';

export type BooleanOperator = 'equals' | 'not_equals';

export type DateOperator =
  | 'equals'
  | 'not_equals'
  | 'greater_than'
  | 'greater_than_or_equal'
  | 'less_than'
  | 'less_than_or_equal'
  | 'between'
  | 'relative_days_ago'
  | 'this_month';

export type QueryOperator =
  | NumericOperator
  | StringOperator
  | BooleanOperator
  | DateOperator;

/**
 * Filter clause targeting a specific column or nested attribute.
 */
export interface QueryFilter {
  column: string;
  operator: QueryOperator;
  value: unknown;
  nested_key?: string;
  raw_column?: string;
  is_nested?: boolean;
}

export type SortDirection = 'asc' | 'desc';

export interface QuerySort {
  column: string;
  direction: SortDirection;
}

export interface ConversationHistoryTurn {
  turn_index: number;
  user_prompt: string;
  resolved_intent: string;
  target_table?: string | null;
  matched_row_ids?: string[];
  applied_filter_summary?: string;
  assistant_response_summary: string;
}

export interface SheetQueryRequest {
  entity?: string;
  message: string;
  conversation_history?: ConversationHistoryTurn[];
}

/**
 * Successful result of a read-only spreadsheet query.
 */
export interface SheetQueryResult {
  status: 'ok';
  message: string;
  answer?: string;
  entity: string;
  operation: 'filter';
  filter_logic?: 'AND' | 'OR';
  count: number;
  rows: DynamicSheetRow[];
  matched_ids: string[];
  highlighted_rows?: Array<{
    table_name: string;
    row_identifier: string;
    row_data: DynamicSheetRow;
  }>;
  filters: QueryFilter[];
  sort: QuerySort[];
  limit: number | null;
  promptUsed?: string;
  business_id?: string;
}

/**
 * Clarification response when a user's instruction is ambiguous or lacks required context.
 */
export interface ClarificationResponse {
  status: 'clarification_needed';
  message: string;
  suggestions?: string[];
  entity: string;
  operation: null;
  filters?: QueryFilter[];
  sort?: QuerySort[];
  limit?: null;
  affected_count?: 0;
  target_rows?: [];
  business_id?: string;
}

// =============================================================================
// 3. Mutation Operations, Plans & Responses
// =============================================================================

export type MutationOperation =
  | 'update'
  | 'update_many'
  | 'delete'
  | 'create';

export type MutationUpdateAction =
  | 'set'
  | 'add'
  | 'subtract'
  | 'multiply';

export type MutationFilterLogic = 'AND' | 'OR';

/**
 * A single transformation modifying a specific column or nested map attribute.
 */
export interface MutationTransformation {
  column: string;
  action: MutationUpdateAction;
  value: unknown;
  unit?: string;
  nested_key?: string;
  field?: string;
  expression?: string;
}

/**
 * Normalized mutation plan produced by Gemini or validated client input.
 */
export interface MutationPlan {
  entity?: string;
  operation: MutationOperation;
  filter_logic: MutationFilterLogic;
  match_all: boolean;
  target_filters: QueryFilter[];
  updates: MutationTransformation[];
  changes?: Record<string, unknown>;
  rows?: Array<Record<string, unknown>>;
  description?: string;
}

/**
 * Client request to mutate a spreadsheet (Stage 1 Preview or Stage 2 Confirm).
 */
export interface SheetMutationRequest {
  business_id?: string;
  entity?: string;
  message?: string;
  confirm?: boolean;
  mutation?: MutationPlan;
  expected_preview_hash?: string;
  preview_hash?: string;
}

/**
 * Individual row diff item for visual Before vs. After inspection.
 */
export interface MutationDiffItem {
  id: string;
  name: string;
  before: Record<string, unknown>;
  after: Record<string, unknown> | null;
  changes: Record<string, { before?: unknown; after?: unknown; current?: unknown; proposed?: unknown }>;
}

/**
 * Stage 1: Preview response returned when confirm=false.
 */
export interface MutationPreviewResponse {
  status: 'preview';
  message: string;
  entity: string;
  operation: MutationOperation;
  preview_hash: string;
  affected_count: number;
  diff: MutationDiffItem[];
  expires_at?: string;
  confirmation_required?: boolean;
  proposed_changes?: Record<string, unknown>;
  proposed_rows?: Array<Record<string, unknown>>;
  target_rows?: DynamicSheetRow[];
  approved_mutation?: MutationPlan;
  business_id?: string;
}

/**
 * Stage 2: Execution response returned when confirm=true.
 */
export interface MutationExecutionResponse {
  status: 'applied' | 'ok' | 'success';
  message: string;
  entity: string;
  operation: MutationOperation;
  affected_count: number;
  updated_rows?: DynamicSheetRow[];
  created_row?: DynamicSheetRow;
  created_rows?: DynamicSheetRow[];
  deleted_rows?: DynamicSheetRow[];
  business_id?: string;
}

// =============================================================================
// 4. Gemini AI Studio Prompt & Response Contracts
// =============================================================================

/**
 * Untrusted payload shape returned by Google AI Studio Gemini for sheet query interpretation.
 */
export interface RawGeminiSheetInterpretation {
  status?: string;
  message?: string;
  operation?: string;
  entity?: string;
  filter_logic?: string;
  logical_operator?: string;
  match_all?: boolean;
  filters?: unknown[];
  target_filters?: unknown[];
  sort?: unknown[];
  limit?: unknown;
  updates?: unknown[];
  changes?: Record<string, unknown>;
  row?: Record<string, unknown>;
  record?: Record<string, unknown>;
  rows?: unknown[];
  records?: unknown[];
}

/**
 * Interpreted query or mutation result after strict validation.
 */
export type InterpretedSheetAction =
  | {
      status: 'ok';
      message: string;
      entity: string;
      operation: 'filter';
      filter_logic: 'AND' | 'OR';
      filters: QueryFilter[];
      sort: QuerySort[];
      limit: number | null;
    }
  | {
      status: 'ok';
      message: string;
      entity: string;
      operation: MutationOperation;
      filter_logic: MutationFilterLogic;
      match_all: boolean;
      target_filters: QueryFilter[];
      updates: MutationTransformation[];
      changes: Record<string, unknown>;
      rows?: Array<Record<string, unknown>>;
    }
  | ClarificationResponse;

// =============================================================================
// 5. Customer & Announcement API Contracts
// =============================================================================

export interface CustomerRegistrationRequest {
  customerName: string;
  email: string;
  externalCustomerId?: string;
  businessId?: string;
}

export interface CustomerRegistrationResponse {
  customer_id: string;
  customer_name: string;
  email: string;
  business_id: string;
  created_at: string;
}

export interface AnnouncementDraftRequest {
  prompt: string;
}

export interface AnnouncementDraftResponse {
  status: 'draft' | 'clarification_needed';
  id?: string;
  subject?: string;
  body?: string;
  recipient_count?: number;
  audience_criteria?: Record<string, unknown>;
  message?: string;
}

export interface AnnouncementSendRequest {
  confirm: boolean;
}

export interface AnnouncementSendResponse {
  status: 'sent';
  message: string;
  successful_count: number;
  failed_count: number;
  failed_recipients?: Array<{ email: string; reason: string }>;
}

export interface AnnouncementHistoryItem {
  id: string;
  subject: string;
  body: string;
  status: string;
  recipient_count: number;
  successful_count: number;
  failed_count: number;
  created_at: string;
}

// =============================================================================
// 6. Generic API Error Contract
// =============================================================================

export interface ApiErrorDetail {
  field?: string;
  message: string;
  code?: string;
}

export interface ApiErrorResponse {
  error: string;
  message: string;
  status?: number;
  details?: ApiErrorDetail[] | unknown;
}

// =============================================================================
// 7. Cross-Document Hybrid RAG & Socratic Operations Contracts (#2 & #3)
// =============================================================================

export interface Citation {
  source_type: 'document' | 'table';
  source_name: string;
  locator: string;
  excerpt: string;
  source_id?: string;
}

export interface WorkspaceDocument {
  doc_id: string;
  filename: string;
  mime_type?: string;
  page_count: number;
  chunk_count: number;
  total_chunks?: number;
  excerpt?: string;
  created_at?: string;
}

export interface SocraticOption {
  option_id: string;
  label: string;
  rule_interpretation: string;
}

export interface SocraticQuestion {
  question_id: string;
  question_text: string;
  options: SocraticOption[];
}

export interface WorkspaceMutationDiff {
  table_name?: string;
  row_identifier?: string | number;
  id?: string | number;
  name?: string;
  order_id?: string;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  changes?: Record<string, { current: unknown; proposed: unknown }>;
  [key: string]: unknown;
}

export interface WorkspaceEmailPreview {
  recipient_email: string;
  customer_identifier: string;
  subject: string;
  body: string;
  metadata?: {
    applied_rule?: string;
    row_identifier?: string | number;
    voucher_amount?: number;
    option_id?: string;
  };
}

export interface ClarificationRequiredPayload {
  status: 'CLARIFICATION_REQUIRED';
  workflow_id: string;
  target_entity?: string;
  matched_row_ids?: string[];
  conflict_summary: string;
  affected_rows_count: number;
  conflicting_rows_count: number;
  socratic_questions: SocraticQuestion[];
  citations: Citation[];
}

export interface PreviewReadyPayload {
  status: 'PREVIEW_READY';
  workflow_id: string;
  target_entity?: string;
  matched_row_ids?: string[];
  mutations_preview: WorkspaceMutationDiff[];
  emails_preview: WorkspaceEmailPreview[];
  citations: Citation[];
  rows?: Record<string, any>[];
  highlighted_rows?: Array<{
    table_name: string;
    row_identifier: string;
    row_data: Record<string, any>;
  }>;
  message?: string;
  email_draft_template?: {
    subject: string;
    body: string;
  };
}

export interface ExecutedPayload {
  status: 'EXECUTED';
  workflow_id: string;
  updated_rows_count: number;
  dispatched_emails_count: number;
  dispatched_emails?: Array<{
    to: string;
    customer_identifier: string;
    subject: string;
    text: string;
    metadata?: Record<string, unknown>;
    dispatched_at: string;
    delivery_mode: string;
  }>;
  citations: Citation[];
}

export interface ConversationalPayload {
  status: 'CONVERSATIONAL';
  conversational: true;
  intent: string;
  message: string;
  citations: Citation[];
  answer?: string;
  highlighted_rows?: Array<{
    table_name: string;
    row_identifier: string;
    row_data: DynamicSheetRow;
  }>;
  rows?: Array<DynamicSheetRow & { table_name: string }>;
}

export interface RoutedSheetInstruction {
  status: 'SHEET_QUERY' | 'SHEET_MUTATION';
  intent: 'sheet_query' | 'sheet_mutation';
  entity: string;
  prompt: string;
  message: string;
  answer?: string;
  count?: number;
  rows?: DynamicSheetRow[];
  matched_ids?: string[];
  highlighted_rows?: Array<{
    table_name: string;
    row_identifier: string;
    row_data: DynamicSheetRow;
  }>;
  interpretedQuery?: Record<string, unknown> | null;
  fast_path?: boolean;
  citations: Citation[];
}

export interface BusinessSheetTableInfo<TRow = DynamicSheetRow> {
  entity: string;
  tableName: string;
  displayName: string;
  fileName: string;
  columns: string[];
  rowCount: number;
  rows: TRow[];
}

export interface BusinessSheetsListResponse<TRow = DynamicSheetRow> {
  status: 'ok';
  business_id: string;
  tables: BusinessSheetTableInfo<TRow>[];
  count: number;
}

export type WorkspaceOperationResponse =
  | ConversationalPayload
  | RoutedSheetInstruction
  | ClarificationRequiredPayload
  | PreviewReadyPayload
  | ExecutedPayload;
