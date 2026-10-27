const { query, withTransaction } = require('../../db');
const env = require('../config/env');
const AppError = require('../utils/AppError');
const { findCustomerById } = require('./customerService');

const ALLOWED_CONVERSATION_STATUSES = new Set(['open', 'closed']);
const ALLOWED_SENDER_TYPES = new Set(['customer', 'agent']);

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
      SELECT id, business_id, customer_id, status, created_at, updated_at
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
 * Retrieves a conversation's metadata and its full message history in chronological order.
 *
 * @param {string} businessId
 * @param {string} conversationId
 */
async function getConversationWithMessages(businessId, conversationId) {
  const conversation = await findConversationForBusinessOrThrow(
    businessId,
    conversationId
  );

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
    conversation,
    messages: messagesResult.rows,
  };
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
  getRecentConversationMessages,
  addMessageToConversation,
  updateConversationStatus,
};
