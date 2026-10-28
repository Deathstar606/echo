import { API_BASE_URL, BUSINESS_ID } from '../config/constants';

/**
 * Custom API Error preserving HTTP status codes and backend error payloads.
 */
export class ApiError extends Error {
  constructor(message, status, details = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.details = details;
  }
}

/**
 * Shared HTTP client helper for communicating with the Node.js backend.
 * Handles JSON serialization, response parsing, and actionable error messages.
 */
async function request(endpoint, options = {}) {
  const url = `${API_BASE_URL}${endpoint}`;
  const headers = {
    Accept: 'application/json',
    ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    ...(options.headers || {}),
  };

  let response;
  try {
    response = await fetch(url, {
      ...options,
      headers,
    });
  } catch (networkErr) {
    throw new ApiError(
      'Unable to reach the MaxiText backend at http://localhost:3000. Please verify the backend server is running.',
      0,
      networkErr?.message || null
    );
  }

  const contentType = response.headers.get('content-type') || '';
  let data = null;

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

  return data;
}

/**
 * Health check for the top header status indicator.
 */
export async function checkBackendHealth() {
  return request('/api/health', { method: 'GET' });
}

/**
 * 3A. Customer Registration
 * POST /api/businesses/{BUSINESS_ID}/customers
 * Omits external_customer_id when it is empty.
 */
export async function registerCustomer({
  customerName,
  email,
  externalCustomerId,
}) {
  const payload = {
    customer_name: String(customerName || '').trim(),
    email: String(email || '').trim(),
  };

  if (
    typeof externalCustomerId === 'string' &&
    externalCustomerId.trim().length > 0
  ) {
    payload.external_customer_id = externalCustomerId.trim();
  }

  return request(`/api/businesses/${BUSINESS_ID}/customers`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

/**
 * 3B & 3C. Existing Customer Login & Conversation History Lookup
 * POST /api/businesses/{BUSINESS_ID}/conversations/history
 */
export async function fetchCustomerConversationHistory(customerId) {
  return request(`/api/businesses/${BUSINESS_ID}/conversations/history`, {
    method: 'POST',
    body: JSON.stringify({
      customer_id: String(customerId || '').trim(),
    }),
  });
}

/**
 * 3C. Create New Customer Conversation
 * POST /api/businesses/{BUSINESS_ID}/conversations
 */
export async function createCustomerConversation(customerId) {
  return request(`/api/businesses/${BUSINESS_ID}/conversations`, {
    method: 'POST',
    body: JSON.stringify({
      customer_id: String(customerId || '').trim(),
    }),
  });
}

/**
 * 3D. Send Customer Message
 * POST /api/businesses/{BUSINESS_ID}/conversations/{conversation_id}/messages
 * Returns ONLY customer-safe message data. AI suggestion is saved server-side.
 */
export async function sendCustomerMessage(conversationId, message) {
  return request(
    `/api/businesses/${BUSINESS_ID}/conversations/${encodeURIComponent(
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
 * GET /api/businesses/{BUSINESS_ID}/conversations
 */
export async function fetchCompanyConversations() {
  return request(`/api/businesses/${BUSINESS_ID}/conversations`, {
    method: 'GET',
  });
}

/**
 * 4A & 4B. Fetch Single Conversation with Full History & AI Suggestion (Company View)
 * GET /api/businesses/{BUSINESS_ID}/conversations/{conversation_id}
 */
export async function fetchCompanyConversationDetail(conversationId) {
  return request(
    `/api/businesses/${BUSINESS_ID}/conversations/${encodeURIComponent(
      conversationId
    )}`,
    {
      method: 'GET',
    }
  );
}

/**
 * 4C. Send Company Approved Reply
 * POST /api/businesses/{BUSINESS_ID}/conversations/{conversation_id}/replies
 */
export async function sendCompanyReply(conversationId, message) {
  return request(
    `/api/businesses/${BUSINESS_ID}/conversations/${encodeURIComponent(
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
 * Phase 2 — 1A. Fetch Announcement History
 * GET /api/businesses/{BUSINESS_ID}/announcements
 */
export async function fetchAnnouncementHistory() {
  return request(`/api/businesses/${BUSINESS_ID}/announcements`, {
    method: 'GET',
  });
}

/**
 * Phase 2 — 1B. Generate AI Announcement Draft & Natural-Language Recipient Targeting
 * POST /api/businesses/{BUSINESS_ID}/announcements/draft
 */
export async function draftAnnouncement(announcementText) {
  return request(`/api/businesses/${BUSINESS_ID}/announcements/draft`, {
    method: 'POST',
    body: JSON.stringify({
      announcement: String(announcementText || '').trim(),
    }),
  });
}

/**
 * Phase 2 — 1C. Confirm & Send Announcement
 * POST /api/businesses/{BUSINESS_ID}/announcements/{announcementId}/send
 */
export async function sendAnnouncement(
  announcementId,
  { subject, body } = {}
) {
  const payload = {
    confirm: true,
  };
  if (typeof subject === 'string' && subject.trim()) {
    payload.subject = subject.trim();
  }
  if (typeof body === 'string' && body.trim()) {
    payload.body = body.trim();
  }

  return request(
    `/api/businesses/${BUSINESS_ID}/announcements/${encodeURIComponent(
      announcementId
    )}/send`,
    {
      method: 'POST',
      body: JSON.stringify(payload),
    }
  );
}

/**
 * Phase 2 — 2A. Fetch Products Sheet
 * GET /api/sheets/products?businessId={BUSINESS_ID}
 */
export async function fetchProductsSheet() {
  return request(
    `/api/sheets/products?businessId=${encodeURIComponent(BUSINESS_ID)}`,
    {
      method: 'GET',
    }
  );
}

/**
 * Phase 2 — 2A. Fetch Services Sheet
 * GET /api/sheets/services?businessId={BUSINESS_ID}
 */
export async function fetchServicesSheet() {
  return request(
    `/api/sheets/services?businessId=${encodeURIComponent(BUSINESS_ID)}`,
    {
      method: 'GET',
    }
  );
}

/**
 * Phase 2 — 2A. Fetch Sheet Rows by Entity ('products' | 'services')
 */
export async function fetchSheetRows(entity) {
  const normalized =
    String(entity || '').toLowerCase() === 'services' ? 'services' : 'products';
  return normalized === 'services'
    ? fetchServicesSheet()
    : fetchProductsSheet();
}

/**
 * Phase 2 — 2B. Natural-Language Sheet Query
 * POST /api/businesses/{BUSINESS_ID}/sheets/query
 */
export async function querySheet({ entity, message }) {
  return request(`/api/businesses/${BUSINESS_ID}/sheets/query`, {
    method: 'POST',
    body: JSON.stringify({
      entity: String(entity || '').trim(),
      message: String(message || '').trim(),
    }),
  });
}

/**
 * Phase 2 — 2C. Two-Stage Sheet Mutation (Stage 1 Preview: confirm=false, Stage 2 Apply: confirm=true)
 * POST /api/sheets/mutation
 */
export async function mutateSheet({ entity, message, confirm = false }) {
  return request(
    `/api/sheets/mutation?businessId=${encodeURIComponent(BUSINESS_ID)}`,
    {
      method: 'POST',
      body: JSON.stringify({
        business_id: BUSINESS_ID,
        entity: String(entity || '').trim(),
        message: String(message || '').trim(),
        confirm: Boolean(confirm),
      }),
    }
  );
}

/**
 * Phase 2 — 2D. Generate New Sheet Data (Unsaved Draft Preview)
 * POST /api/businesses/{BUSINESS_ID}/sheets/generate
 */
export async function generateSheetData({
  entity,
  count = 5,
  prompt = '',
}) {
  return request(`/api/businesses/${BUSINESS_ID}/sheets/generate`, {
    method: 'POST',
    body: JSON.stringify({
      entity: String(entity || '').trim(),
      count: Number(count) || 5,
      prompt: String(prompt || '').trim(),
    }),
  });
}

/**
 * Phase 2 — 2D. Save Generated Sheet Data (Confirmed Append or Replace)
 * POST /api/businesses/{BUSINESS_ID}/sheets/generate/save
 */
export async function saveGeneratedSheetData({
  entity,
  rows,
  mode = 'append',
  confirm = true,
}) {
  return request(`/api/businesses/${BUSINESS_ID}/sheets/generate/save`, {
    method: 'POST',
    body: JSON.stringify({
      entity: String(entity || '').trim(),
      rows: Array.isArray(rows) ? rows : [],
      mode: mode === 'replace' ? 'replace' : 'append',
      confirm: Boolean(confirm),
    }),
  });
}

/**
 * Optional CSV Upload for Products or Services
 * POST /api/sheets/{entity}/upload?businessId={BUSINESS_ID}
 */
export async function uploadSheetCsv(entity, file) {
  const normalized =
    String(entity || '').toLowerCase() === 'services' ? 'services' : 'products';
  const formData = new FormData();
  formData.append('file', file);

  const url = `${API_BASE_URL}/api/sheets/${normalized}/upload?businessId=${encodeURIComponent(
    BUSINESS_ID
  )}`;

  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      body: formData,
    });
  } catch (networkErr) {
    throw new ApiError(
      'Unable to reach the MaxiText backend at http://localhost:3000.',
      0,
      networkErr?.message || null
    );
  }

  const data = await response.json().catch(() => null);
  if (!response.ok) {
    throw new ApiError(
      (data && (data.error || data.message)) ||
        `CSV upload failed with status ${response.status}`,
      response.status,
      data
    );
  }
  return data;
}
