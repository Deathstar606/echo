/**
 * MaxiText AI Studio — Backend Sheet Query & Mutation Runtime Validation Service
 *
 * Provides strict runtime type guards and assertion validators for untrusted
 * user and Gemini LLM payloads without blind casting (`as ...`).
 */

import type {
  DynamicSheetRow,
  SheetColumnDef,
  SheetSchema,
  QueryOperator,
  NumericOperator,
  StringOperator,
  BooleanOperator,
  DateOperator,
  QueryFilter,
  QuerySort,
  SortDirection,
  SheetQueryRequest,
  MutationOperation,
  MutationUpdateAction,
  MutationFilterLogic,
  MutationTransformation,
  MutationPlan,
  SheetMutationRequest,
  RawGeminiSheetInterpretation,
  ClarificationResponse,
} from '../../../shared/types/contracts';

// =============================================================================
// Primitive & Type Guards
// =============================================================================

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isString(value: unknown): value is string {
  return typeof value === 'string';
}

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function isBoolean(value: unknown): value is boolean {
  return typeof value === 'boolean';
}

const NUMERIC_OPERATORS = new Set<NumericOperator>([
  'equals',
  'not_equals',
  'greater_than',
  'greater_than_or_equal',
  'less_than',
  'less_than_or_equal',
  'between',
]);

const STRING_OPERATORS = new Set<StringOperator>([
  'equals',
  'not_equals',
  'contains',
  'not_contains',
  'starts_with',
  'ends_with',
  'in',
]);

const BOOLEAN_OPERATORS = new Set<BooleanOperator>(['equals', 'not_equals']);

const DATE_OPERATORS = new Set<DateOperator>([
  'equals',
  'not_equals',
  'greater_than',
  'greater_than_or_equal',
  'less_than',
  'less_than_or_equal',
  'between',
  'relative_days_ago',
  'this_month',
]);

export function isQueryOperator(op: unknown): op is QueryOperator {
  if (!isString(op)) return false;
  return (
    NUMERIC_OPERATORS.has(op as NumericOperator) ||
    STRING_OPERATORS.has(op as StringOperator) ||
    BOOLEAN_OPERATORS.has(op as BooleanOperator) ||
    DATE_OPERATORS.has(op as DateOperator)
  );
}

const MUTATION_OPERATIONS = new Set<MutationOperation>([
  'update',
  'update_many',
  'delete',
  'create',
]);

export function normalizeMutationOperationAlias(op: unknown): string {
  if (!isString(op)) return '';
  const lower = op.trim().toLowerCase();
  if (
    lower === 'insert' ||
    lower === 'insert_many' ||
    lower === 'add' ||
    lower === 'add_row' ||
    lower === 'add_rows' ||
    lower === 'create_many'
  ) {
    return 'create';
  }
  if (
    lower === 'remove' ||
    lower === 'delete_many' ||
    lower === 'remove_many' ||
    lower === 'drop_row' ||
    lower === 'drop_rows'
  ) {
    return 'delete';
  }
  return lower;
}

export function isMutationOperation(op: unknown): op is MutationOperation {
  const normalized = normalizeMutationOperationAlias(op);
  return MUTATION_OPERATIONS.has(normalized as MutationOperation);
}

const MUTATION_UPDATE_ACTIONS = new Set<MutationUpdateAction>([
  'set',
  'add',
  'subtract',
  'multiply',
]);

export function isMutationUpdateAction(action: unknown): action is MutationUpdateAction {
  return isString(action) && MUTATION_UPDATE_ACTIONS.has(action as MutationUpdateAction);
}

export function isMutationFilterLogic(logic: unknown): logic is MutationFilterLogic {
  return logic === 'AND' || logic === 'OR';
}

export function isSortDirection(dir: unknown): dir is SortDirection {
  return dir === 'asc' || dir === 'desc';
}

// =============================================================================
// Validation & Parsing Functions (Untrusted input -> Strongly Typed Output)
// =============================================================================

/**
 * Validates and normalizes an untrusted query filter clause.
 */
export function validateQueryFilter(input: unknown): QueryFilter {
  if (!isObject(input)) {
    throw new Error('Filter must be a valid JSON object.');
  }

  // Accept 'column' or 'field'
  const colVal = input.column ?? input.field;
  if (!isNonEmptyString(colVal)) {
    throw new Error('Filter must specify a non-empty column or field name.');
  }

  const operator = input.operator;
  if (!isQueryOperator(operator)) {
    throw new Error(`Unsupported or invalid filter operator: ${String(operator)}.`);
  }

  const result: QueryFilter = {
    column: colVal.trim(),
    operator,
    value: input.value,
  };

  if (isNonEmptyString(input.nested_key)) {
    result.nested_key = input.nested_key.trim();
  }
  if (isNonEmptyString(input.raw_column)) {
    result.raw_column = input.raw_column.trim();
  }
  if (isBoolean(input.is_nested)) {
    result.is_nested = input.is_nested;
  }

  return result;
}

/**
 * Validates and normalizes an untrusted query sort clause.
 */
export function validateQuerySort(input: unknown): QuerySort {
  if (!isObject(input)) {
    throw new Error('Sort clause must be a valid JSON object.');
  }

  const colVal = input.column ?? input.field;
  if (!isNonEmptyString(colVal)) {
    throw new Error('Sort clause must specify a non-empty column or field name.');
  }

  const rawDir = isString(input.direction) ? input.direction.toLowerCase() : 'asc';
  const direction: SortDirection = isSortDirection(rawDir) ? rawDir : 'asc';

  return {
    column: colVal.trim(),
    direction,
  };
}

/**
 * Validates and normalizes an untrusted mutation update action.
 * Supports 'set', 'add', 'subtract', 'multiply'.
 */
export function validateMutationTransformation(input: unknown): MutationTransformation {
  if (!isObject(input)) {
    throw new Error('Mutation update transformation must be an object.');
  }

  const colVal = input.column ?? input.field;
  if (!isNonEmptyString(colVal)) {
    throw new Error('Mutation update must target a non-empty column or field name.');
  }

  const rawAction = isString(input.action) ? input.action.toLowerCase() : '';
  if (!isMutationUpdateAction(rawAction)) {
    throw new Error(
      `Unsupported mutation action "${String(input.action)}". Supported actions: set, add, subtract, multiply.`
    );
  }

  if (input.value === undefined) {
    throw new Error(`Mutation update for "${colVal}" must provide a target value.`);
  }

  const transformation: MutationTransformation = {
    column: colVal.trim(),
    action: rawAction,
    value: input.value,
  };

  if (isNonEmptyString(input.unit)) {
    transformation.unit = input.unit.trim();
  }
  if (isNonEmptyString(input.nested_key)) {
    transformation.nested_key = input.nested_key.trim();
  }
  if (isNonEmptyString(input.field)) {
    transformation.field = input.field.trim();
  }
  if (isNonEmptyString(input.expression)) {
    transformation.expression = input.expression.trim();
  }

  return transformation;
}

/**
 * Validates and normalizes an untrusted mutation plan.
 */
export function validateMutationPlan(input: unknown): MutationPlan {
  if (!isObject(input)) {
    throw new Error('Mutation plan must be an object.');
  }

  const rawOp = normalizeMutationOperationAlias(input.operation);
  if (!isMutationOperation(rawOp)) {
    throw new Error(
      `Invalid mutation operation "${String(input.operation)}". Expected update, update_many, delete, or create.`
    );
  }

  const rawLogic = isString(input.filter_logic)
    ? input.filter_logic.toUpperCase()
    : isString(input.logical_operator)
      ? input.logical_operator.toUpperCase()
      : 'AND';
  const filterLogic: MutationFilterLogic = rawLogic === 'OR' ? 'OR' : 'AND';

  const matchAll = Boolean(input.match_all);

  // Validate target filters
  const rawFilters = Array.isArray(input.target_filters)
    ? input.target_filters
    : Array.isArray(input.filters)
      ? input.filters
      : [];
  const targetFilters = rawFilters.map((f) => validateQueryFilter(f));

  // Validate updates
  const rawUpdates = Array.isArray(input.updates) ? input.updates : [];
  const updates = rawUpdates.map((u) => validateMutationTransformation(u));

  const plan: MutationPlan = {
    operation: rawOp,
    filter_logic: filterLogic,
    match_all: matchAll,
    target_filters: targetFilters,
    updates,
  };

  if (isNonEmptyString(input.entity)) {
    plan.entity = input.entity.trim();
  }
  if (isObject(input.changes)) {
    plan.changes = input.changes;
  } else if (isObject(input.row)) {
    plan.changes = input.row;
  } else if (isObject(input.record)) {
    plan.changes = input.record;
  }
  const rawRows = Array.isArray(input.rows)
    ? input.rows
    : Array.isArray(input.records)
      ? input.records
      : null;
  if (rawRows) {
    plan.rows = rawRows.filter((r): r is Record<string, unknown> => isObject(r));
  }
  if (isNonEmptyString(input.description)) {
    plan.description = input.description.trim();
  }

  return plan;
}

/**
 * Validates the raw JSON output from Google AI Studio Gemini before domain normalization.
 */
export function validateRawGeminiInterpretation(input: unknown): RawGeminiSheetInterpretation {
  if (!isObject(input)) {
    return {
      status: 'clarification_needed',
      message: 'LLM returned a non-object response.',
    };
  }

  const result: RawGeminiSheetInterpretation = {};

  if (isString(input.status)) result.status = input.status;
  if (isString(input.message)) result.message = input.message;
  if (isString(input.operation)) result.operation = input.operation;
  if (isString(input.entity)) result.entity = input.entity;
  if (isString(input.filter_logic)) result.filter_logic = input.filter_logic;
  if (isString(input.logical_operator)) result.logical_operator = input.logical_operator;
  if (isBoolean(input.match_all)) result.match_all = input.match_all;

  if (Array.isArray(input.filters)) result.filters = input.filters;
  if (Array.isArray(input.target_filters)) result.target_filters = input.target_filters;
  if (Array.isArray(input.sort)) result.sort = input.sort;
  if (input.limit !== undefined) result.limit = input.limit;
  if (Array.isArray(input.updates)) result.updates = input.updates;
  if (isObject(input.changes)) result.changes = input.changes;
  if (isObject(input.row)) result.row = input.row;
  if (isObject(input.record)) result.record = input.record;
  if (Array.isArray(input.rows)) result.rows = input.rows;
  if (Array.isArray(input.records)) result.records = input.records;

  return result;
}

/**
 * Validates untrusted client request for POST /api/sheets/query.
 */
export function validateSheetQueryRequest(input: unknown): SheetQueryRequest {
  if (!isObject(input)) {
    throw new Error('Request body must be a JSON object.');
  }

  if (!isNonEmptyString(input.message)) {
    throw new Error('Message is required and must be a non-empty string.');
  }

  const request: SheetQueryRequest = {
    message: input.message.trim(),
  };

  if (isNonEmptyString(input.entity)) {
    request.entity = input.entity.trim();
  }

  return request;
}

/**
 * Validates untrusted client request for POST /api/sheets/mutate.
 */
export function validateSheetMutationRequest(input: unknown): SheetMutationRequest {
  if (!isObject(input)) {
    throw new Error('Request body must be a JSON object.');
  }

  const request: SheetMutationRequest = {};

  if (isNonEmptyString(input.business_id)) {
    request.business_id = input.business_id.trim();
  }
  if (isNonEmptyString(input.entity)) {
    request.entity = input.entity.trim();
  }
  if (isNonEmptyString(input.message)) {
    request.message = input.message.trim();
  }
  if (isBoolean(input.confirm)) {
    request.confirm = input.confirm;
  }
  if (input.mutation !== undefined) {
    request.mutation = validateMutationPlan(input.mutation);
  }
  if (isNonEmptyString(input.expected_preview_hash)) {
    request.expected_preview_hash = input.expected_preview_hash.trim();
  }
  if (isNonEmptyString(input.preview_hash)) {
    request.preview_hash = input.preview_hash.trim();
  }

  return request;
}

// Re-export contract types for convenient single-import consumption in backend services
export type {
  DynamicSheetRow,
  SheetColumnDef,
  SheetSchema,
  QueryOperator,
  QueryFilter,
  QuerySort,
  SheetQueryRequest,
  MutationOperation,
  MutationUpdateAction,
  MutationFilterLogic,
  MutationTransformation,
  MutationPlan,
  SheetMutationRequest,
  RawGeminiSheetInterpretation,
  ClarificationResponse,
};
