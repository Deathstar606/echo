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
