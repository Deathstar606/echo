const { query, withTransaction } = require('../../db');
const env = require('../config/env');
const AppError = require('../utils/AppError');
const { findCustomerById } = require('./customerService');

const ALLOWED_CONVERSATION_STATUSES = new Set(['open', 'closed']);
const ALLOWED_SENDER_TYPES = new Set(['customer', 'agent']);

function parseMissingInfo(rawVal) {
  if (Array.isArray(rawVal)) {
    return rawVal;
  }
  if (typeof rawVal === 'string' && rawVal.trim()) {
    try {
      const parsed = JSON.parse(rawVal);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

/**
 * Creates a new conversation for a customer belonging to the specified business.
 * Enforces business ownership in both application logic and database constraints.
 *
 * @param {object} params
 * @param {string} params.businessId
 * @param {string} params.customerId
 * @param {string} [params.status='open']
 */
async function createConversation({ businessId, customerId, status = 'open' }) {
  const normalizedStatus = String(status).trim().toLowerCase();
  if (!ALLOWED_CONVERSATION_STATUSES.has(normalizedStatus)) {
    throw new AppError(
      'Invalid conversation "status". Allowed values are "open" and "closed".',
      400
    );
  }

  const customer = await findCustomerById(customerId);
  if (!customer) {
    throw new AppError(`Customer with ID "${customerId}" was not found.`, 404);
  }

  if (customer.business_id !== businessId) {
    throw new AppError(
      'Customer does not belong to the specified business.',
      400
    );
  }

  const result = await query(
    `
      INSERT INTO conversations (business_id, customer_id, status)
      VALUES ($1, $2, $3)
      RETURNING id, business_id, customer_id, status, created_at, updated_at;
    `,
    [businessId, customerId, normalizedStatus]
  );

  return result.rows[0];
}

/**
 * Fetches a conversation by ID and verifies it belongs to the specified business.
 *
 * @param {string} businessId
 * @param {string} conversationId
 */
async function findConversationForBusinessOrThrow(businessId, conversationId) {
  const result = await query(
    `
      SELECT id, business_id, customer_id, status, ai_draft_reply, ai_draft_category, ai_draft_missing_info, ai_draft_message_id, ai_draft_updated_at, created_at, updated_at
      FROM conversations
      WHERE id = $1 AND business_id = $2;
    `,
    [conversationId, businessId]
  );

  if (result.rowCount === 0) {
    throw new AppError(
      `Conversation with ID "${conversationId}" was not found for this business.`,
      404
    );
  }

  return result.rows[0];
}

/**
 * Retrieves a conversation's metadata, customer details, and full message history
 * in chronological order (including AI suggestion fields for the company view).
 *
 * @param {string} businessId
 * @param {string} conversationId
 */
async function getConversationWithMessages(businessId, conversationId) {
  const conversation = await findConversationForBusinessOrThrow(
    businessId,
    conversationId
  );

  const customer = await findCustomerById(conversation.customer_id);

  const messagesResult = await query(
    `
      SELECT id, conversation_id, sender_type, content, ai_suggestion, ai_category, ai_missing_info, created_at
      FROM messages
      WHERE conversation_id = $1
      ORDER BY created_at ASC, id ASC;
    `,
    [conversation.id]
  );

  const messages = messagesResult.rows.map((m) => ({
    ...m,
    ai_missing_info: parseMissingInfo(m.ai_missing_info),
  }));

  return {
    conversation: {
      ...conversation,
      ai_draft_missing_info: parseMissingInfo(conversation.ai_draft_missing_info),
    },
    customer,
    messages,
  };
}

/**
 * Validates that a customer exists and belongs to the specified business, and returns
 * their existing conversation and chronological customer-safe messages if available.
 *
 * @param {string} businessId
 * @param {string} customerId
 */
async function findCustomerConversationWithMessages(businessId, customerId) {
  const customer = await findCustomerById(customerId);
  if (!customer) {
    throw new AppError(`Customer with ID "${customerId}" was not found.`, 404);
  }

  if (customer.business_id !== businessId) {
    throw new AppError(
      'Customer does not belong to the specified business.',
      400
    );
  }

  const convResult = await query(
    `
      SELECT id, business_id, customer_id, status, created_at, updated_at
      FROM conversations
      WHERE business_id = $1 AND customer_id = $2
      ORDER BY updated_at DESC, created_at DESC, id DESC;
    `,
    [businessId, customerId]
  );

  if (convResult.rowCount === 0) {
    return {
      customer,
      conversation: null,
      messages: [],
    };
  }

  // Prefer an open conversation if one exists, otherwise return the most recently active one
  const openConv = convResult.rows.find((c) => c.status === 'open');
  const conversation = openConv || convResult.rows[0];

  const messagesResult = await query(
    `
      SELECT id, conversation_id, sender_type, content, created_at
      FROM messages
      WHERE conversation_id = $1
      ORDER BY created_at ASC, id ASC;
    `,
    [conversation.id]
  );

  return {
    customer,
    conversation,
    messages: messagesResult.rows,
  };
}

/**
 * Lists all conversations belonging strictly to the specified business,
 * enriched with customer details, messages, and any AI-generated draft suggestion.
 *
 * @param {string} businessId
 */
async function listConversationsForBusiness(businessId) {
  const convResult = await query(
    `
      SELECT id, business_id, customer_id, status, ai_draft_reply, ai_draft_category, ai_draft_missing_info, ai_draft_message_id, ai_draft_updated_at, created_at, updated_at
      FROM conversations
      WHERE business_id = $1
      ORDER BY updated_at DESC, created_at DESC, id DESC;
    `,
    [businessId]
  );

  const enriched = [];

  for (const conv of convResult.rows) {
    const customer = await findCustomerById(conv.customer_id);
    const messagesResult = await query(
      `
        SELECT id, conversation_id, sender_type, content, ai_suggestion, ai_category, ai_missing_info, created_at
        FROM messages
        WHERE conversation_id = $1
        ORDER BY created_at ASC, id ASC;
      `,
      [conv.id]
    );

    const messages = messagesResult.rows.map((m) => ({
      ...m,
      ai_missing_info: parseMissingInfo(m.ai_missing_info),
    }));

    enriched.push({
      conversation: {
        ...conv,
        ai_draft_missing_info: parseMissingInfo(conv.ai_draft_missing_info),
      },
      customer,
      messages,
    });
  }

  return enriched;
}

/**
 * Persists an AI-generated reply suggestion server-side on both the triggering
 * customer message and the conversation draft columns.
 *
 * @param {object} params
 * @param {string} params.businessId
 * @param {string} params.conversationId
 * @param {string} params.messageId
 * @param {string} params.suggestion
 * @param {string} params.category
 * @param {string[]} params.missingInformation
 */
async function saveAiSuggestionForMessageAndConversation({
  businessId,
  conversationId,
  messageId,
  suggestion,
  category,
  missingInformation = [],
}) {
  const missingJson = JSON.stringify(
    Array.isArray(missingInformation) ? missingInformation : []
  );

  await query(
    `
      UPDATE messages
      SET ai_suggestion = $2, ai_category = $3, ai_missing_info = $4::jsonb
      WHERE id = $1;
    `,
    [messageId, suggestion, category, missingJson]
  );

  await query(
    `
      UPDATE conversations
      SET ai_draft_reply = $3,
          ai_draft_category = $4,
          ai_draft_missing_info = $5::jsonb,
          ai_draft_message_id = $6,
          ai_draft_updated_at = NOW()
      WHERE id = $1 AND business_id = $2;
    `,
    [conversationId, businessId, suggestion, category, missingJson, messageId]
  );
}

/**
 * Retrieves the latest N messages for a conversation efficiently (selected in reverse
 * chronological order and returned in ascending chronological order).
 *
 * @param {string} conversationId
 * @param {number} [limit]
 */
async function getRecentConversationMessages(
  conversationId,
  limit = env.conversationHistoryLimit
) {
  const result = await query(
    `
      SELECT id, conversation_id, sender_type, content, created_at
      FROM (
        SELECT id, conversation_id, sender_type, content, created_at
        FROM messages
        WHERE conversation_id = $1
        ORDER BY created_at DESC, id DESC
        LIMIT $2
      ) AS recent_messages
      ORDER BY created_at ASC, id ASC;
    `,
    [conversationId, limit]
  );

  return result.rows;
}

/**
 * Saves an incoming message and updates the conversation's updated_at timestamp
 * atomically inside a database transaction. Rejects messages for closed conversations.
 * When senderType === 'agent', clears the active pending AI draft on the conversation.
 *
 * @param {object} params
 * @param {string} params.businessId
 * @param {string} params.conversationId
 * @param {'customer' | 'agent'} [params.senderType='customer']
 * @param {string} params.content
 */
async function addMessageToConversation({
  businessId,
  conversationId,
  senderType = 'customer',
  content,
}) {
  if (!ALLOWED_SENDER_TYPES.has(senderType)) {
    throw new AppError(
      'Invalid "sender_type". Allowed values are "customer" and "agent".',
      400
    );
  }

  return withTransaction(async (client) => {
    const convResult = await client.query(
      `
        SELECT id, business_id, customer_id, status, created_at, updated_at
        FROM conversations
        WHERE id = $1 AND business_id = $2
        FOR UPDATE;
      `,
      [conversationId, businessId]
    );

    if (convResult.rowCount === 0) {
      throw new AppError(
        `Conversation with ID "${conversationId}" was not found for this business.`,
        404
      );
    }

    const conversation = convResult.rows[0];
    if (conversation.status !== 'open') {
      throw new AppError(
        'Cannot add messages to a closed conversation.',
        400
      );
    }

    const msgResult = await client.query(
      `
        INSERT INTO messages (conversation_id, sender_type, content)
        VALUES ($1, $2, $3)
        RETURNING id, conversation_id, sender_type, content, created_at;
      `,
      [conversationId, senderType, content]
    );

    const updatedConvResult = await client.query(
      `
        UPDATE conversations
        SET updated_at = NOW()
        WHERE id = $1 AND business_id = $2
        RETURNING id, business_id, customer_id, status, created_at, updated_at;
      `,
      [conversationId, businessId]
    );

    if (senderType === 'agent') {
      await client.query(
        `
          UPDATE conversations
          SET ai_draft_reply = NULL,
              ai_draft_category = NULL,
              ai_draft_missing_info = NULL,
              ai_draft_message_id = NULL,
              ai_draft_updated_at = NOW()
          WHERE id = $1 AND business_id = $2;
        `,
        [conversationId, businessId]
      );
    }

    return {
      conversation: updatedConvResult.rows[0],
      message: msgResult.rows[0],
    };
  });
}

/**
 * Updates the status ('open' or 'closed') of a conversation belonging to a business.
 *
 * @param {string} businessId
 * @param {string} conversationId
 * @param {string} status
 */
async function updateConversationStatus(businessId, conversationId, status) {
  const normalizedStatus = String(status || '').trim().toLowerCase();
  if (!ALLOWED_CONVERSATION_STATUSES.has(normalizedStatus)) {
    throw new AppError(
      'Invalid conversation "status". Allowed values are "open" and "closed".',
      400
    );
  }

  const result = await query(
    `
      UPDATE conversations
      SET status = $3, updated_at = NOW()
      WHERE id = $1 AND business_id = $2
      RETURNING id, business_id, customer_id, status, created_at, updated_at;
    `,
    [conversationId, businessId, normalizedStatus]
  );

  if (result.rowCount === 0) {
    throw new AppError(
      `Conversation with ID "${conversationId}" was not found for this business.`,
      404
    );
  }

  return result.rows[0];
}

module.exports = {
  ALLOWED_CONVERSATION_STATUSES,
  ALLOWED_SENDER_TYPES,
  createConversation,
  findConversationForBusinessOrThrow,
  getConversationWithMessages,
  findCustomerConversationWithMessages,
  listConversationsForBusiness,
  saveAiSuggestionForMessageAndConversation,
  getRecentConversationMessages,
  addMessageToConversation,
  updateConversationStatus,
};
