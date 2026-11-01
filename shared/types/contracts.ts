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

export interface SheetQueryRequest {
  entity?: string;
  message: string;
}

/**
 * Successful result of a read-only spreadsheet query.
 */
export interface SheetQueryResult {
  status: 'ok';
  message: string;
  entity: string;
  operation: 'filter';
  filter_logic?: 'AND' | 'OR';
  count: number;
  rows: DynamicSheetRow[];
  matched_ids: string[];
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
  operation: MutationOperation;
  filter_logic: MutationFilterLogic;
  match_all: boolean;
  target_filters: QueryFilter[];
  updates: MutationTransformation[];
  changes?: Record<string, unknown>;
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
  after: Record<string, unknown>;
  changes: Record<string, { before: unknown; after: unknown }>;
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
  expires_at: string;
  business_id?: string;
}

/**
 * Stage 2: Execution response returned when confirm=true.
 */
export interface MutationExecutionResponse {
  status: 'applied' | 'ok';
  message: string;
  entity: string;
  operation: MutationOperation;
  affected_count: number;
  updated_rows: DynamicSheetRow[];
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
    }
  | ClarificationResponse;

// =============================================================================
// 5. Customer & Announcement API Contracts
// =============================================================================

export interface CustomerRegistrationRequest {
  customerName: string;
  email: string;
  externalCustomerId?: string;
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
