import { API_BASE_URL, getActiveBusinessId, getLoggedInUser } from '../config/constants';
import type {
  DynamicSheetRow,
  SheetQueryResult,
  ClarificationResponse,
  MutationPlan,
  MutationPreviewResponse,
  MutationExecutionResponse,
  CustomerRegistrationRequest,
  CustomerRegistrationResponse,
  AnnouncementDraftResponse,
  AnnouncementSendResponse,
  AnnouncementHistoryItem,
  ApiErrorDetail,
  WorkspaceDocument,
  WorkspaceOperationResponse,
  ClarificationRequiredPayload,
  PreviewReadyPayload,
  ExecutedPayload,
  Citation,
  BusinessSheetTableInfo,
  BusinessSheetsListResponse,
  ConversationHistoryTurn,
} from '../../../shared/types/contracts';

export type { ConversationHistoryTurn };

/**
 * Custom API Error preserving HTTP status codes and backend error payloads.
 */
export class ApiError<TDetails = ApiErrorDetail[] | unknown> extends Error {
  public status: number;
  public details: TDetails | null;

  constructor(message: string, status: number, details: TDetails | null = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.details = details;
  }
}

/**
 * Normalizes the base URL and endpoint so duplicate `/api/api` prefixes cannot occur.
 */
export function buildApiUrl(endpoint: string): string {
  const base = String(API_BASE_URL || 'http://localhost:3000').replace(/\/+$/, '');
  if (base.endsWith('/api') && endpoint.startsWith('/api/')) {
    return `${base}${endpoint.slice(4)}`;
  }
  return `${base}${endpoint}`;
}

/**
 * Shared HTTP client helper for communicating with the Node.js backend.
 * Handles JSON serialization, response parsing, and actionable error messages.
 */
async function request<T = unknown>(endpoint: string, options: RequestInit = {}): Promise<T> {
  const url = buildApiUrl(endpoint);
  const currentUserId = getLoggedInUser()?.id;
  const isFormData = typeof FormData !== 'undefined' && options.body instanceof FormData;
  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...(options.body && !isFormData ? { 'Content-Type': 'application/json' } : {}),
    ...(currentUserId ? { 'X-User-Id': String(currentUserId) } : {}),
    ...((options.headers as Record<string, string>) || {}),
  };

  let response: Response;
  try {
    response = await fetch(url, {
      ...options,
      headers,
    });
  } catch (networkErr: unknown) {
    const errMsg = networkErr instanceof Error ? networkErr.message : null;
    throw new ApiError(
      'Unable to reach the MaxiText backend at http://localhost:3000. Please verify the backend server is running.',
      0,
      errMsg
    );
  }

  const contentType = response.headers.get('content-type') || '';
  let data: any = null;

  if (contentType.includes('application/json')) {
    try {
      data = await response.json();
    } catch {
      data = null;
    }
  } else {
    const text = await response.text().catch(() => '');
    data = { message: text };
  }

  if (!response.ok) {
    const errorMessage =
      (data && (data.error || data.message)) ||
      `Request failed with status ${response.status}`;
    throw new ApiError(errorMessage, response.status, data?.details || null);
  }

  return data as T;
}

/**
 * Health check for the top header status indicator.
 */
export async function checkBackendHealth(): Promise<{ status: string; service?: string }> {
  return request<{ status: string; service?: string }>('/api/health', { method: 'GET' });
}

/**
 * Business Account Management APIs
 */
export async function createBusinessApi(
  name: string
): Promise<{ id: string; name: string; created_at: string }> {
  return request<{ id: string; name: string; created_at: string }>('/api/businesses', {
    method: 'POST',
    body: JSON.stringify({ name: String(name || '').trim() }),
  });
}

export async function getBusinessApi(
  businessId: string
): Promise<{ id: string; name: string; created_at: string }> {
  const targetId = String(businessId || '').trim();
  return request<{ id: string; name: string; created_at: string }>(
    `/api/businesses/${encodeURIComponent(targetId)}`,
    {
      method: 'GET',
    }
  );
}

/**
 * 3A. Customer Registration
 * POST /api/businesses/{businessId}/customers
 * Omits external_customer_id when it is empty.
 */
export async function registerCustomer({
  customerName,
  email,
  externalCustomerId,
  businessId,
}: CustomerRegistrationRequest): Promise<CustomerRegistrationResponse> {
  const targetBiz = (businessId && String(businessId).trim()) || getActiveBusinessId();
  const payload: Record<string, string> = {
    customer_name: String(customerName || '').trim(),
    email: String(email || '').trim(),
  };

  if (
    typeof externalCustomerId === 'string' &&
    externalCustomerId.trim().length > 0
  ) {
    payload.external_customer_id = externalCustomerId.trim();
  }

  return request<CustomerRegistrationResponse>(
    `/api/businesses/${encodeURIComponent(targetBiz)}/customers`,
    {
      method: 'POST',
      body: JSON.stringify(payload),
    }
  );
}

/**
 * 3B & 3C. Existing Customer Login & Conversation History Lookup
 * POST /api/businesses/{businessId}/conversations/history
 */
export async function fetchCustomerConversationHistory(
  customerId: string,
  businessId?: string
): Promise<any> {
  const targetBiz = (businessId && String(businessId).trim()) || getActiveBusinessId();
  return request(`/api/businesses/${encodeURIComponent(targetBiz)}/conversations/history`, {
    method: 'POST',
    body: JSON.stringify({
      customer_id: String(customerId || '').trim(),
    }),
  });
}

/**
 * 3C. Create New Customer Conversation
 * POST /api/businesses/{businessId}/conversations
 */
export async function createCustomerConversation(
  customerId: string,
  businessId?: string
): Promise<any> {
  const targetBiz = (businessId && String(businessId).trim()) || getActiveBusinessId();
  return request(`/api/businesses/${encodeURIComponent(targetBiz)}/conversations`, {
    method: 'POST',
    body: JSON.stringify({
      customer_id: String(customerId || '').trim(),
    }),
  });
}

/**
 * 3D. Send Customer Message
 * POST /api/businesses/{businessId}/conversations/{conversation_id}/messages
 * Returns ONLY customer-safe message data. AI suggestion is saved server-side.
 */
export async function sendCustomerMessage(
  conversationId: string,
  message: string,
  businessId?: string
): Promise<any> {
  const targetBiz = (businessId && String(businessId).trim()) || getActiveBusinessId();
  return request(
    `/api/businesses/${encodeURIComponent(targetBiz)}/conversations/${encodeURIComponent(
      conversationId
    )}/messages`,
    {
      method: 'POST',
      body: JSON.stringify({
        message: String(message || '').trim(),
      }),
    }
  );
}

/**
 * 4A. Fetch All Business Conversations (Company Inquiry Panel Inbox)
 * GET /api/businesses/{businessId}/conversations
 */
export async function fetchCompanyConversations(businessId?: string): Promise<any> {
  const targetBiz = (businessId && String(businessId).trim()) || getActiveBusinessId();
  return request(`/api/businesses/${encodeURIComponent(targetBiz)}/conversations`, {
    method: 'GET',
  });
}

/**
 * 4A & 4B. Fetch Single Conversation with Full History & AI Suggestion (Company View)
 * GET /api/businesses/{businessId}/conversations/{conversation_id}
 */
export async function fetchCompanyConversationDetail(
  conversationId: string,
  businessId?: string
): Promise<any> {
  const targetBiz = (businessId && String(businessId).trim()) || getActiveBusinessId();
  return request(
    `/api/businesses/${encodeURIComponent(targetBiz)}/conversations/${encodeURIComponent(
      conversationId
    )}`,
    {
      method: 'GET',
    }
  );
}

/**
 * 4C. Send Company Approved Reply
 * POST /api/businesses/{businessId}/conversations/{conversation_id}/replies
 */
export async function sendCompanyReply(
  conversationId: string,
  message: string,
  businessId?: string
): Promise<any> {
  const targetBiz = (businessId && String(businessId).trim()) || getActiveBusinessId();
  return request(
    `/api/businesses/${encodeURIComponent(targetBiz)}/conversations/${encodeURIComponent(
      conversationId
    )}/replies`,
    {
      method: 'POST',
      body: JSON.stringify({
        message: String(message || '').trim(),
      }),
    }
  );
}

/**
 * Generate a workspace-grounded reply draft for the latest customer message.
 * The returned draft is not sent until the user explicitly sends it.
 */
export async function generateCompanyReplyDraft(
  conversationId: string,
  businessId?: string
): Promise<any> {
  const targetBiz = (businessId && String(businessId).trim()) || getActiveBusinessId();
  return request(
    `/api/businesses/${encodeURIComponent(targetBiz)}/conversations/${encodeURIComponent(
      conversationId
    )}/reply-draft`,
    {
      method: 'POST',
      body: JSON.stringify({ entity: 'customer' }),
    }
  );
}

/**
 * Phase 2 — 1A. Fetch Announcement History
 * GET /api/businesses/{businessId}/announcements
 */
export async function fetchAnnouncementHistory(
  businessId?: string
): Promise<{ announcements: AnnouncementHistoryItem[] }> {
  const targetBiz = (businessId && String(businessId).trim()) || getActiveBusinessId();
  return request<{ announcements: AnnouncementHistoryItem[] }>(
    `/api/businesses/${encodeURIComponent(targetBiz)}/announcements`,
    {
      method: 'GET',
    }
  );
}

/**
 * Phase 2 — 1B. Generate AI Announcement Draft & Natural-Language Recipient Targeting
 * POST /api/businesses/{businessId}/announcements/draft
 */
export async function draftAnnouncement(
  announcementText: string,
  businessId?: string
): Promise<AnnouncementDraftResponse> {
  const targetBiz = (businessId && String(businessId).trim()) || getActiveBusinessId();
  return request<AnnouncementDraftResponse>(
    `/api/businesses/${encodeURIComponent(targetBiz)}/announcements/draft`,
    {
      method: 'POST',
      body: JSON.stringify({
        announcement: String(announcementText || '').trim(),
      }),
    }
  );
}

/**
 * Phase 2 — 1C. Confirm & Send Announcement
 * POST /api/businesses/{businessId}/announcements/{announcementId}/send
 */
export async function sendAnnouncement(
  announcementId: string,
  { subject, body }: { subject?: string; body?: string } = {},
  businessId?: string
): Promise<AnnouncementSendResponse> {
  const targetBiz = (businessId && String(businessId).trim()) || getActiveBusinessId();
  const payload: Record<string, unknown> = {
    confirm: true,
  };
  if (typeof subject === 'string' && subject.trim()) {
    payload.subject = subject.trim();
  }
  if (typeof body === 'string' && body.trim()) {
    payload.body = body.trim();
  }

  return request<AnnouncementSendResponse>(
    `/api/businesses/${encodeURIComponent(targetBiz)}/announcements/${encodeURIComponent(
      announcementId
    )}/send`,
    {
      method: 'POST',
      body: JSON.stringify(payload),
    }
  );
}

export interface SheetRowsResponse<TRow extends DynamicSheetRow = DynamicSheetRow> {
  status: string;
  entity: string;
  count: number;
  rows: TRow[];
  columns?: string[];
  tableName?: string;
  displayName?: string;
}

/**
 * Discovers all spreadsheet tables that actually belong to the active businessId.
 * GET /api/sheets/tables?businessId={businessId}
 */
export async function fetchBusinessSheets<TRow extends DynamicSheetRow = DynamicSheetRow>(
  businessId?: string
): Promise<BusinessSheetsListResponse<TRow>> {
  const targetBiz = (businessId && String(businessId).trim()) || getActiveBusinessId();
  return request<BusinessSheetsListResponse<TRow>>(
    `/api/sheets/tables?businessId=${encodeURIComponent(targetBiz)}`,
    {
      method: 'GET',
    }
  );
}

/**
 * Phase 2 — 2A. Fetch Sheet Rows for any active inventory sheet (products, electronics, grocery, etc.)
 * GET /api/sheets/{entity}?businessId={businessId}
 */
export async function fetchSheetRows<TRow extends DynamicSheetRow = DynamicSheetRow>(
  entity: string = 'products',
  businessId?: string
): Promise<SheetRowsResponse<TRow>> {
  const target = String(entity || 'products').trim();
  const targetBiz = (businessId && String(businessId).trim()) || getActiveBusinessId();
  return request<SheetRowsResponse<TRow>>(
    `/api/sheets/${encodeURIComponent(target)}?businessId=${encodeURIComponent(
      targetBiz
    )}`,
    {
      method: 'GET',
    }
  );
}

export interface QuerySheetParams {
  entity?: string;
  message: string;
  conversation_history?: ConversationHistoryTurn[];
}

/**
 * Phase 2 — 2B. Natural-Language Sheet Query
 * POST /api/businesses/{businessId}/sheets/query
 */
export async function querySheet(
  { entity = 'products', message, conversation_history = [] }: QuerySheetParams,
  businessId?: string
): Promise<SheetQueryResult | ClarificationResponse> {
  const targetBiz = (businessId && String(businessId).trim()) || getActiveBusinessId();
  const slicedHistory = Array.isArray(conversation_history)
    ? conversation_history.slice(-5)
    : [];
  return request<SheetQueryResult | ClarificationResponse>(
    `/api/businesses/${encodeURIComponent(targetBiz)}/sheets/query`,
    {
      method: 'POST',
      body: JSON.stringify({
        entity: String(entity || 'products').trim(),
        message: String(message || '').trim(),
        ...(slicedHistory.length > 0 ? { conversation_history: slicedHistory } : {}),
      }),
    }
  );
}

export interface MutateSheetParams {
  entity?: string;
  message?: string;
  confirm?: boolean;
  mutation?: MutationPlan;
  expectedPreviewHash?: string;
  conversation_history?: ConversationHistoryTurn[];
}

/**
 * Phase 2 — 2C. Two-Stage Sheet Mutation (Stage 1 Preview: confirm=false, Stage 2 Apply: confirm=true)
 * POST /api/sheets/mutation
 */
export async function mutateSheet({
  entity = 'products',
  message,
  confirm = false,
  mutation,
  expectedPreviewHash,
  conversation_history = [],
}: MutateSheetParams, businessId?: string): Promise<MutationPreviewResponse | MutationExecutionResponse | ClarificationResponse> {
  const targetBiz = (businessId && String(businessId).trim()) || getActiveBusinessId();
  const slicedHistory = Array.isArray(conversation_history)
    ? conversation_history.slice(-5)
    : [];
  return request<MutationPreviewResponse | MutationExecutionResponse | ClarificationResponse>(
    `/api/sheets/mutation?businessId=${encodeURIComponent(targetBiz)}`,
    {
      method: 'POST',
      body: JSON.stringify({
        business_id: targetBiz,
        entity: String(entity || 'products').trim(),
        message: String(message || '').trim(),
        confirm: Boolean(confirm),
        ...(slicedHistory.length > 0 ? { conversation_history: slicedHistory } : {}),
        ...(mutation ? { mutation } : {}),
        ...(expectedPreviewHash
          ? { expected_preview_hash: expectedPreviewHash }
          : {}),
      }),
    }
  );
}

/**
 * CSV Upload & Append for Universal Inventory Sheets
 * POST /api/sheets/{entity}/upload?businessId={businessId}[&mode=append]
 */
export async function uploadSheetCsv(
  entity: string | File,
  file?: File,
  mode: 'replace' | 'append' = 'replace',
  businessId?: string
): Promise<any> {
  let targetEntity = '';
  let actualFile: File;
  const targetMode = mode;
  const targetBiz = (businessId && String(businessId).trim()) || getActiveBusinessId();

  if (entity instanceof File) {
    actualFile = entity;
    targetEntity = '';
  } else if (entity && typeof entity === 'object' && 'name' in entity && !file) {
    actualFile = entity as File;
    targetEntity = '';
  } else {
    targetEntity = String(entity || '').trim();
    actualFile = file as File;
  }

  const formData = new FormData();
  formData.append('file', actualFile);
  if (targetMode === 'append') {
    formData.append('mode', 'append');
  }

  const pathPrefix = targetEntity
    ? `/api/sheets/${encodeURIComponent(targetEntity)}/upload`
    : '/api/sheets/upload';
  const url = buildApiUrl(
    `${pathPrefix}?businessId=${encodeURIComponent(targetBiz)}${
      targetMode === 'append' ? '&mode=append' : ''
    }`
  );

  let response: Response;
  const currentUserId = getLoggedInUser()?.id;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: currentUserId ? { 'X-User-Id': String(currentUserId) } : undefined,
      body: formData,
    });
  } catch (networkErr: unknown) {
    const errMsg = networkErr instanceof Error ? networkErr.message : null;
    throw new ApiError(
      'Unable to reach the MaxiText backend at http://localhost:3000.',
      0,
      errMsg
    );
  }

  const data = await response.json().catch(() => null);
  if (!response.ok) {
    throw new ApiError(
      (data && (data.error || data.message)) ||
        `CSV ${targetMode === 'append' ? 'append' : 'upload'} failed with status ${response.status}`,
      response.status,
      data
    );
  }
  return data;
}

/**
 * Appends new rows to the active sheet
 */
export async function appendSheetCsv(entity: string, file: File, businessId?: string): Promise<any> {
  return uploadSheetCsv(entity, file, 'append', businessId);
}

export interface AddRowResponse {
  status: string;
  message: string;
  row?: DynamicSheetRow;
}

/**
 * Inserts a single new row with dynamic columns into the active table in PostgreSQL.
 * POST /api/sheets/{entity}/row?businessId={businessId}
 */
export async function addSheetRow(
  entity: string = 'products',
  row: Record<string, unknown> = {},
  businessId?: string
): Promise<AddRowResponse> {
  const targetEntity = String(entity || 'products').trim();
  const targetBiz = (businessId && String(businessId).trim()) || getActiveBusinessId();
  return request<AddRowResponse>(
    `/api/sheets/${encodeURIComponent(targetEntity)}/row?businessId=${encodeURIComponent(
      targetBiz
    )}`,
    {
      method: 'POST',
      body: JSON.stringify({ row }),
    }
  );
}

/**
 * Deletes all database rows and metadata entries for a workspace sheet/table.
 * DELETE /api/sheets/{entity}?businessId={businessId}
 */
export async function deleteSheetTable(
  entity: string,
  businessId?: string
): Promise<{
  status: string;
  message: string;
  business_id: string;
  entity: string;
  table_name: string;
  deleted_rows: number;
  dropped_table: boolean;
}> {
  const targetEntity = String(entity || '').trim();
  const targetBiz = (businessId && String(businessId).trim()) || getActiveBusinessId();
  return request(
    `/api/sheets/${encodeURIComponent(targetEntity)}?businessId=${encodeURIComponent(targetBiz)}`,
    { method: 'DELETE' }
  );
}

// =============================================================================
// Phase 1, Phase 2, Phase 3: Cross-Document RAG & Socratic Operations APIs
// =============================================================================

export interface WorkspaceDocumentsResponse {
  status: string;
  documents: WorkspaceDocument[];
}

/**
 * Fetches all indexed unstructured documents for the workspace.
 * GET /api/workspace/documents?business_id={businessId}
 */
export async function fetchWorkspaceDocuments(
  businessId: string = getActiveBusinessId()
): Promise<WorkspaceDocumentsResponse> {
  return request<WorkspaceDocumentsResponse>(
    `/api/workspace/documents?business_id=${encodeURIComponent(businessId)}`,
    { method: 'GET' }
  );
}

/**
 * Deletes a workspace document and all of its semantic chunks.
 * DELETE /api/workspace/documents/{docId}?business_id={businessId}
 */
export async function deleteWorkspaceDocument(
  docId: string,
  businessId: string = getActiveBusinessId()
): Promise<{
  status: string;
  message: string;
  business_id: string;
  doc_id: string;
  filename?: string | null;
  deleted_chunks: number;
}> {
  return request(
    `/api/workspace/documents/${encodeURIComponent(docId)}?business_id=${encodeURIComponent(
      businessId
    )}`,
    { method: 'DELETE' }
  );
}

export interface DocumentInspectionChunk {
  id: string;
  chunk_index: number;
  locator: string;
  breadcrumb_header: string | null;
  raw_text: string;
  enriched_text?: string | null;
  extracted_entities: string[];
}

export interface DocumentInspectionMetadata {
  id: string;
  workspace_id: string;
  filename: string;
  total_chunks: number;
  all_extracted_entities: string[];
  created_at?: string;
}

export interface DocumentInspectionResponse {
  document: DocumentInspectionMetadata;
  chunks: DocumentInspectionChunk[];
}

/**
 * Fetches all chunks and extracted entities for a specific workspace document.
 * Flexible lookup: works with either docId (UUID) or filename.
 * GET /api/workspaces/{workspaceId}/documents/{docIdentifier}/chunks
 */
export async function fetchDocumentChunks(
  workspaceId: string,
  docIdentifier: string
): Promise<DocumentInspectionResponse> {
  const targetPath = workspaceId
    ? `/api/workspaces/${encodeURIComponent(workspaceId)}/documents/${encodeURIComponent(docIdentifier)}/chunks`
    : `/api/workspace/documents/${encodeURIComponent(docIdentifier)}/chunks`;
  return request<DocumentInspectionResponse>(targetPath, { method: 'GET' });
}

/**
 * Deletes a workspace document and its semantic chunks by docIdentifier (UUID or filename).
 * DELETE /api/workspaces/{workspaceId}/documents/{docIdentifier}
 */
export async function deleteWorkspaceDocumentByIdentifier(
  workspaceId: string,
  docIdentifier: string
): Promise<{ status: string; message: string; deleted_chunks?: number }> {
  const targetPath = workspaceId
    ? `/api/workspaces/${encodeURIComponent(workspaceId)}/documents/${encodeURIComponent(docIdentifier)}`
    : `/api/workspace/documents/${encodeURIComponent(docIdentifier)}`;
  return request(targetPath, { method: 'DELETE' });
}

/**
 * Ingests an unstructured document (.pdf, .md, .txt) or CSV into the workspace.
 * POST /api/workspace/documents/upload?business_id={businessId}
 */
export async function uploadWorkspaceDocument(
  file: File,
  businessId: string = getActiveBusinessId()
): Promise<{ status: string; documents?: WorkspaceDocument[]; tables?: unknown[] }> {
  const formData = new FormData();
  formData.append('file', file);
  formData.append('business_id', businessId);

  const url = buildApiUrl(
    `/api/workspace/documents/upload?business_id=${encodeURIComponent(businessId)}`
  );

  let response: Response;
  const currentUserId = getLoggedInUser()?.id;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: currentUserId ? { 'X-User-Id': String(currentUserId) } : undefined,
      body: formData,
    });
  } catch (networkErr: unknown) {
    const errMsg = networkErr instanceof Error ? networkErr.message : null;
    throw new ApiError(
      'Unable to reach backend to upload document.',
      0,
      errMsg
    );
  }

  const data = await response.json().catch(() => null);
  if (!response.ok) {
    throw new ApiError(
      (data && (data.error || data.message)) ||
        `Document upload failed with status ${response.status}`,
      response.status,
      data
    );
  }
  return data;
}

/**
 * 1-Click Demo Workspace Loader:
 * Seeds the workspace with the official demo scenario assets (orders.csv + SLA & Supplier notice PDFs).
 * POST /api/workspace/demo/seed
 */
export async function seedWorkspaceDemo(
  businessId: string = getActiveBusinessId()
): Promise<{
  status: string;
  message: string;
  documents: WorkspaceDocument[];
  tables: Array<{ table_name: string; filename: string; total_rows: number; imported_rows: number }>;
}> {
  return request(`/api/workspace/demo/seed`, {
    method: 'POST',
    body: JSON.stringify({ business_id: businessId }),
  });
}

export interface ExecuteWorkspaceOperationParams {
  prompt: string;
  entity?: string | null;
  table_name?: string | null;
  customer_context?: {
    customer_name?: string;
    customer_email?: string;
    reference_id?: string;
    inquiry_id?: string;
  };
  businessId?: string;
  history?: Array<ConversationHistoryTurn | { role: 'user' | 'assistant'; content: string }>;
  conversation_history?: ConversationHistoryTurn[];
}

/**
 * Executes multi-hop query router & Socratic conflict gate.
 * Returns CLARIFICATION_REQUIRED, PREVIEW_READY, or CONVERSATIONAL.
 * POST /api/workspace/execute
 */
export async function executeWorkspaceOperationApi({
  prompt,
  entity,
  table_name,
  customer_context,
  history = [],
  conversation_history,
  businessId = getActiveBusinessId(),
}: ExecuteWorkspaceOperationParams): Promise<WorkspaceOperationResponse> {
  const isExplicitEntity = entity === 'user' || entity === 'customer';
  const legacyTable = isExplicitEntity ? null : entity;
  const rawHistory = Array.isArray(conversation_history)
    ? conversation_history
    : Array.isArray(history)
      ? history
      : [];
  const slicedHistory = rawHistory.slice(-5);
  return request<WorkspaceOperationResponse>('/api/workspace/execute', {
    method: 'POST',
    body: JSON.stringify({
      business_id: businessId,
      prompt: String(prompt || '').trim(),
      entity: isExplicitEntity ? entity : 'user',
      conversation_history: slicedHistory,
      history: slicedHistory,
      ...((table_name || legacyTable)
        ? { table_name: String(table_name || legacyTable).trim() }
        : {}),
      ...(customer_context ? { customer_context } : {}),
    }),
  });
}

export interface ResolveWorkspaceSocraticParams {
  workflowId: string;
  selectedOptions: unknown;
  businessId?: string;
}

/**
 * Turn 2: Resolves a CLARIFICATION_REQUIRED workflow using user-selected Socratic options.
 * Returns PREVIEW_READY contract.
 * POST /api/workspace/resolve-socratic
 */
export async function resolveWorkspaceSocraticApi({
  workflowId,
  selectedOptions,
  businessId = getActiveBusinessId(),
}: ResolveWorkspaceSocraticParams): Promise<PreviewReadyPayload> {
  return request<PreviewReadyPayload>('/api/workspace/resolve-socratic', {
    method: 'POST',
    body: JSON.stringify({
      business_id: businessId,
      workflow_id: workflowId,
      selected_options: selectedOptions,
    }),
  });
}

export interface ConfirmWorkspaceOperationParams {
  workflowId: string;
  confirm?: boolean;
  dryRun?: boolean;
  businessId?: string;
  editedEmails?: Array<{
    customer_identifier: string;
    recipient_email: string;
    subject: string;
    body: string;
    metadata?: Record<string, any>;
  }>;
}

/**
 * Turn 3: Confirms and executes a PREVIEW_READY workflow, atomically updating DB rows and dispatching emails.
 * Returns EXECUTED contract.
 * POST /api/workspace/confirm-operation
 */
export async function confirmWorkspaceOperationApi({
  workflowId,
  confirm = true,
  dryRun = false,
  businessId = getActiveBusinessId(),
  editedEmails,
}: ConfirmWorkspaceOperationParams): Promise<ExecutedPayload> {
  return request<ExecutedPayload>('/api/workspace/confirm-operation', {
    method: 'POST',
    body: JSON.stringify({
      workflow_id: workflowId,
      business_id: businessId,
      confirm: Boolean(confirm),
      dry_run: Boolean(dryRun),
      ...(Array.isArray(editedEmails) ? { edited_emails: editedEmails } : {}),
    }),
  });
}

// =============================================================================
// Google Workspace Integration API Services (OAuth2, Gmail, Sheets, Docs)
// =============================================================================

export interface GoogleUserProfile {
  email: string;
  name: string;
  picture: string | null;
  isEnvConnected?: boolean;
}

export interface GoogleAuthStatusResponse {
  success: boolean;
  connected: boolean;
  user: GoogleUserProfile | null;
}

export async function getGoogleAuthUrlApi(
  identifier?: string,
  options?: {
    mode?: 'login' | 'link';
    userId?: string;
    workspaceId?: string;
    tab?: string;
  }
): Promise<string> {
  const params = new URLSearchParams();
  const mode = options?.mode || 'login';
  const currentUser = getLoggedInUser();
  const resolvedId =
    identifier !== undefined ? String(identifier).trim() : getActiveBusinessId();

  if (mode === 'link') {
    params.set('mode', 'link');
    const linkUserId = options?.userId || currentUser?.id || '';
    if (linkUserId) params.set('userId', String(linkUserId).trim());
    const wsId = options?.workspaceId || resolvedId || getActiveBusinessId();
    if (wsId) params.set('workspaceId', String(wsId).trim());
    if (options?.tab) params.set('tab', options.tab);
  } else if (resolvedId) {
    params.set('businessId', resolvedId);
  }

  if (typeof window !== 'undefined' && window.location?.origin) {
    params.set('origin', window.location.origin);
  }

  const qs = params.toString() ? `?${params.toString()}` : '';
  const res = await request<{ success: boolean; url: string }>(
    `/api/auth/google/url${qs}`
  );
  return res.url;
}

export async function getGoogleAuthStatusApi(identifier?: string): Promise<GoogleAuthStatusResponse> {
  const currentUser = getLoggedInUser();
  const resolved =
    identifier !== undefined
      ? String(identifier).trim()
      : currentUser?.id || getActiveBusinessId();
  if (!resolved) {
    return { success: true, connected: false, user: null };
  }
  const params = new URLSearchParams();
  params.set('userId', currentUser?.id || resolved);
  params.set('businessId', resolved);
  return request<GoogleAuthStatusResponse>(
    `/api/auth/google/status?${params.toString()}`
  );
}

export async function logoutGoogleAuthApi(businessId = getActiveBusinessId()): Promise<GoogleAuthStatusResponse> {
  return request<GoogleAuthStatusResponse>('/api/auth/google/logout', {
    method: 'POST',
    body: JSON.stringify({ businessId }),
  });
}

export interface GmailMessage {
  id: string;
  threadId: string;
  subject: string;
  fromName: string;
  fromEmail: string;
  toEmail: string;
  date: string;
  snippet: string;
  bodyText: string;
  bodyHtml?: string;
  messageId?: string;
  references?: string;
  inReplyTo?: string;
  isGmail: true;
}

export async function fetchGmailInboxApi(
  businessId = getActiveBusinessId(),
  maxResults = 20
): Promise<GmailMessage[]> {
  const res = await request<{ success: boolean; count: number; messages: GmailMessage[] }>(
    `/api/google/gmail/inbox?businessId=${encodeURIComponent(businessId)}&maxResults=${maxResults}`
  );
  return res.messages || [];
}

export interface SendGmailReplyPayload {
  threadId: string;
  to: string;
  subject: string;
  inReplyTo?: string;
  references?: string;
  bodyText: string;
  businessId?: string;
}

export async function sendGmailReplyApi(
  payload: SendGmailReplyPayload,
  businessId = getActiveBusinessId()
): Promise<{ success: boolean; messageId: string; threadId: string }> {
  return request<{ success: boolean; messageId: string; threadId: string }>(
    '/api/google/gmail/reply',
    {
      method: 'POST',
      body: JSON.stringify({
        ...payload,
        businessId: payload.businessId || businessId,
      }),
    }
  );
}

export async function generateGmailReplyDraftApi(
  payload: { messageText: string; senderName?: string; subject?: string },
  businessId = getActiveBusinessId()
): Promise<{ success: boolean; draftText: string; category?: string; contextNote?: string; citations?: any[] }> {
  return request<{ success: boolean; draftText: string; category?: string; contextNote?: string; citations?: any[] }>(
    '/api/google/gmail/suggest-reply',
    {
      method: 'POST',
      body: JSON.stringify({
        ...payload,
        businessId,
      }),
    }
  );
}

export interface GoogleDriveFile {
  id: string;
  name: string;
  size?: string;
  modifiedTime?: string;
  webViewLink?: string;
}

export async function listGoogleSpreadsheetsApi(
  businessId = getActiveBusinessId()
): Promise<GoogleDriveFile[]> {
  const res = await request<{ success: boolean; files: GoogleDriveFile[] }>(
    `/api/google/sheets/list?businessId=${encodeURIComponent(businessId)}`
  );
  return res.files || [];
}

export interface ImportGoogleSheetParams {
  spreadsheetId: string;
  sheetTabName?: string;
  customEntityName?: string;
  businessId?: string;
}

export async function importGoogleSheetApi(
  params: ImportGoogleSheetParams,
  businessId = getActiveBusinessId()
): Promise<{ success: boolean; entity: string; tableName: string; rowCount: number }> {
  return request<{ success: boolean; entity: string; tableName: string; rowCount: number }>(
    '/api/google/sheets/import',
    {
      method: 'POST',
      body: JSON.stringify({
        ...params,
        businessId: params.businessId || businessId,
      }),
    }
  );
}

export async function getSyncedGoogleSheetsApi(
  businessId = getActiveBusinessId()
): Promise<Array<{ table_name: string; google_spreadsheet_id: string; google_sheet_tab_name: string; row_count: number; last_synced_at: string }>> {
  const res = await request<{ success: boolean; sheets: Array<{ table_name: string; google_spreadsheet_id: string; google_sheet_tab_name: string; row_count: number; last_synced_at: string }> }>(
    `/api/google/sheets/synced?businessId=${encodeURIComponent(businessId)}`
  );
  return res.sheets || [];
}

export async function listGoogleDocsApi(
  businessId = getActiveBusinessId()
): Promise<GoogleDriveFile[]> {
  const res = await request<{ success: boolean; files: GoogleDriveFile[] }>(
    `/api/google/docs/list?businessId=${encodeURIComponent(businessId)}`
  );
  return res.files || [];
}

export async function importGoogleDocApi(
  documentId: string,
  businessId = getActiveBusinessId()
): Promise<{ success: boolean; doc_id: string; filename: string; page_count: number; chunk_count: number }> {
  return request<{ success: boolean; doc_id: string; filename: string; page_count: number; chunk_count: number }>(
    '/api/google/docs/import',
    {
      method: 'POST',
      body: JSON.stringify({
        documentId,
        businessId,
      }),
    }
  );
}

// ============================================================================
// User-Centric Authentication & Workspaces APIs
// ============================================================================

export interface UserProfile {
  id: string;
  name: string;
  email: string;
  created_at?: string;
}

export interface WorkspaceItem {
  id: string;
  user_id?: string;
  name: string;
  created_at?: string;
}

export async function demoLoginApi(): Promise<{
  success: boolean;
  user: UserProfile;
  workspaces: WorkspaceItem[];
}> {
  return request<{ success: boolean; user: UserProfile; workspaces: WorkspaceItem[] }>(
    '/api/auth/demo',
    { method: 'POST' }
  );
}

export async function loginApi(credentials: {
  email: string;
  password: string;
}): Promise<{ success: boolean; user: UserProfile; workspaces: WorkspaceItem[] }> {
  return request<{ success: boolean; user: UserProfile; workspaces: WorkspaceItem[] }>(
    '/api/auth/login',
    {
      method: 'POST',
      body: JSON.stringify(credentials),
    }
  );
}

export async function registerApi(details: {
  name: string;
  email: string;
  password: string;
}): Promise<{ success: boolean; user: UserProfile; workspaces: WorkspaceItem[] }> {
  return request<{ success: boolean; user: UserProfile; workspaces: WorkspaceItem[] }>(
    '/api/auth/register',
    {
      method: 'POST',
      body: JSON.stringify(details),
    }
  );
}

export async function getCurrentUserApi(userId?: string): Promise<{
  success: boolean;
  user: UserProfile;
  workspaces: WorkspaceItem[];
}> {
  const url = userId ? `/api/auth/me?userId=${encodeURIComponent(userId)}` : '/api/auth/me';
  return request<{ success: boolean; user: UserProfile; workspaces: WorkspaceItem[] }>(url);
}

export async function getUserWorkspacesApi(userId?: string): Promise<WorkspaceItem[]> {
  if (!userId || !String(userId).trim()) {
    return [];
  }
  const url = `/api/workspaces?userId=${encodeURIComponent(String(userId).trim())}`;
  const res = await request<{ success: boolean; workspaces: WorkspaceItem[] }>(url);
  return res.workspaces || [];
}

export async function createWorkspaceApi(payload: {
  name: string;
  userId: string;
}): Promise<WorkspaceItem> {
  const res = await request<{ success: boolean; workspace: WorkspaceItem }>('/api/workspaces', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  return res.workspace;
}

export async function renameWorkspaceApi(
  workspaceId: string,
  name: string
): Promise<WorkspaceItem> {
  const res = await request<{ success: boolean; workspace: WorkspaceItem }>(
    `/api/workspaces/${encodeURIComponent(workspaceId)}`,
    {
      method: 'PATCH',
      body: JSON.stringify({ name }),
    }
  );
  return res.workspace;
}

export async function getWorkspaceApi(workspaceId: string): Promise<WorkspaceItem> {
  const currentUserId = getLoggedInUser()?.id;
  const qs = currentUserId ? `?userId=${encodeURIComponent(currentUserId)}` : '';
  const res = await request<{ success: boolean; workspace: WorkspaceItem }>(
    `/api/workspaces/${encodeURIComponent(workspaceId)}${qs}`
  );
  return res.workspace;
}

// ============================================================================
// Workspace Contacts & Deduplicated CSV Imports
// ============================================================================

export interface WorkspaceContact {
  id: string;
  workspace_id: string;
  workspace_name?: string;
  panel_type: 'filtered' | 'workspace_csv';
  email: string;
  customer_name?: string | null;
  metadata?: Record<string, any>;
  created_at: string;
  updated_at: string;
}

export interface WorkspaceContactsResponse {
  workspace_id: string;
  workspace_name: string;
  panel_name: string;
  filtered_contacts: WorkspaceContact[];
  filtered_count: number;
  workspace_csv_contacts: WorkspaceContact[];
  workspace_csv_count: number;
  has_csv_panel: boolean;
}

export interface WorkspaceContactCsvUploadResult {
  success: boolean;
  workspace_id: string;
  workspace_name: string;
  panel_name: string;
  panel_type: 'workspace_csv';
  imported_count: number;
  duplicates_merged: number;
  total_workspace_contacts: number;
}

export async function fetchWorkspaceContactsApi(
  workspaceId: string
): Promise<WorkspaceContactsResponse> {
  return request<WorkspaceContactsResponse>(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/contacts`
  );
}

export async function addFilteredContactOneClickApi(
  workspaceId: string,
  payload: {
    email: string;
    customer_name?: string | null;
    metadata?: Record<string, any>;
  }
): Promise<{ success: boolean; action: string; contact: WorkspaceContact }> {
  return request<{ success: boolean; action: string; contact: WorkspaceContact }>(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/contacts/filtered-one-click`,
    {
      method: 'POST',
      body: JSON.stringify(payload),
    }
  );
}

export async function removeWorkspaceContactApi(
  workspaceId: string,
  params: {
    email?: string;
    panel_type?: 'filtered' | 'workspace_csv';
    id?: string;
  }
): Promise<{ success: boolean; deleted: WorkspaceContact | null }> {
  const q = new URLSearchParams();
  if (params.email) q.set('email', params.email);
  if (params.panel_type) q.set('panel_type', params.panel_type);
  if (params.id) q.set('id', params.id);
  return request<{ success: boolean; deleted: WorkspaceContact | null }>(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/contacts?${q.toString()}`,
    {
      method: 'DELETE',
    }
  );
}

export async function uploadWorkspaceContactsCsvApi(
  workspaceId: string,
  input: File | Blob | string
): Promise<WorkspaceContactCsvUploadResult> {
  if (typeof input === 'string') {
    return request<WorkspaceContactCsvUploadResult>(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/contacts/upload-csv`,
      {
        method: 'POST',
        body: JSON.stringify({ csvContent: input }),
      }
    );
  }

  const formData = new FormData();
  formData.append('file', input, input instanceof File ? input.name : 'contacts.csv');
  return request<WorkspaceContactCsvUploadResult>(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/contacts/upload-csv`,
    {
      method: 'POST',
      body: formData,
    }
  );
}

