const env = require('../config/env');
const AppError = require('../utils/AppError');
const { isValidUuid } = require('../middleware/validate');
const { findBusinessOrThrow } = require('./businessController');
const {
  ALLOWED_SENDER_TYPES,
  createConversation,
  getConversationWithMessages,
  getRecentConversationMessages,
  addMessageToConversation,
  updateConversationStatus,
} = require('../services/conversationService');
const {
  retrieveRelevantContextForBusiness,
} = require('../services/contextRetrievalService');
const { buildContextualPrompt } = require('../services/promptBuilderService');
const { generateAiSupportResponse } = require('../services/geminiService');

const MAX_MESSAGE_LENGTH = 5000;

function formatMessageResponse(msg) {
  return {
    id: msg.id,
    conversation_id: msg.conversation_id,
    sender_type: msg.sender_type,
    content: msg.content,
    created_at: msg.created_at,
  };
}

function formatConversationResponse(conversation, messages = undefined) {
  const payload = {
    id: conversation.id,
    business_id: conversation.business_id,
    customer_id: conversation.customer_id,
    status: conversation.status,
    created_at: conversation.created_at,
    updated_at: conversation.updated_at,
  };

  if (Array.isArray(messages)) {
    payload.messages = messages.map(formatMessageResponse);
  }

  return payload;
}

function validateAndNormalizeMessageText(body, fieldLabel = 'message') {
  const rawText =
    body && body.message !== undefined
      ? body.message
      : body && body.reply !== undefined
        ? body.reply
        : body && body.content !== undefined
          ? body.content
          : undefined;

  if (typeof rawText !== 'string' || !rawText.trim()) {
    throw new AppError(
      `Message "${fieldLabel}" is required and must be a non-empty string.`,
      400
    );
  }

  const trimmed = rawText.trim();
  if (trimmed.length > MAX_MESSAGE_LENGTH) {
    throw new AppError(
      `Message "${fieldLabel}" must not exceed ${MAX_MESSAGE_LENGTH} characters.`,
      400
    );
  }

  return trimmed;
}

function resolveSenderType(body, defaultSenderType = 'customer') {
  if (!body) {
    return defaultSenderType;
  }

  const rawSenderType =
    body.sender_type !== undefined ? body.sender_type : body.senderType;

  if (rawSenderType === undefined || rawSenderType === null) {
    return defaultSenderType;
  }

  if (typeof rawSenderType !== 'string' || !rawSenderType.trim()) {
    throw new AppError(
      'Invalid "sender_type". Allowed values are "customer" and "agent".',
      400
    );
  }

  const normalized = rawSenderType.trim().toLowerCase();
  if (!ALLOWED_SENDER_TYPES.has(normalized)) {
    throw new AppError(
      'Invalid "sender_type". Allowed values are "customer" and "agent".',
      400
    );
  }

  return normalized;
}

/**
 * POST /api/businesses/:businessId/conversations
 * Creates a new conversation for a customer belonging to that business.
 */
async function createBusinessConversation(req, res, next) {
  try {
    const { businessId } = req.params;
    const body = req.body || {};

    const rawCustomerId =
      body.customer_id !== undefined ? body.customer_id : body.customerId;

    if (!rawCustomerId || typeof rawCustomerId !== 'string') {
      throw new AppError(
        '"customerId" (or "customer_id") is required and must be a valid UUID.',
        400
      );
    }

    if (!isValidUuid(rawCustomerId)) {
      throw new AppError(
        'Invalid "customerId" (or "customer_id"). Must be a valid UUID.',
        400
      );
    }

    const customerId = rawCustomerId.trim();
    const status = body.status !== undefined ? body.status : 'open';

    // Confirm business exists
    const business = await findBusinessOrThrow(businessId);

    const conversation = await createConversation({
      businessId: business.id,
      customerId,
      status,
    });

    return res.status(201).json(formatConversationResponse(conversation, []));
  } catch (error) {
    return next(error);
  }
}

/**
 * GET /api/businesses/:businessId/conversations/:conversationId
 * Returns conversation metadata and its message history in chronological order.
 */
async function getBusinessConversation(req, res, next) {
  try {
    const { businessId, conversationId } = req.params;

    // Confirm business exists
    const business = await findBusinessOrThrow(businessId);

    const { conversation, messages } = await getConversationWithMessages(
      business.id,
      conversationId
    );

    return res
      .status(200)
      .json(formatConversationResponse(conversation, messages));
  } catch (error) {
    return next(error);
  }
}

/**
 * PATCH /api/businesses/:businessId/conversations/:conversationId
 * Updates conversation status ('open' or 'closed').
 */
async function updateBusinessConversationStatus(req, res, next) {
  try {
    const { businessId, conversationId } = req.params;
    const status = req.body ? req.body.status : undefined;

    if (typeof status !== 'string' || !status.trim()) {
      throw new AppError(
        'Conversation "status" is required ("open" or "closed").',
        400
      );
    }

    const business = await findBusinessOrThrow(businessId);
    const updated = await updateConversationStatus(
      business.id,
      conversationId,
      status
    );

    return res.status(200).json(formatConversationResponse(updated));
  } catch (error) {
    return next(error);
  }
}

/**
 * POST /api/businesses/:businessId/conversations/:conversationId/messages
 * - When sender_type is 'customer' (or omitted):
 *   Saves the incoming customer message, retrieves recent chronological conversation history
 *   (bounded to the latest 20 messages) and relevant business context, and returns the
 *   assembled prompt as text/plain (200 OK).
 * - When sender_type is 'agent':
 *   Saves the agent/user reply directly to the database without generating an AI prompt
 *   and returns the persisted message record as JSON (201 Created).
 */
async function postCustomerMessageAndGeneratePrompt(req, res, next) {
  try {
    const { businessId, conversationId } = req.params;
    const senderType = resolveSenderType(req.body, 'customer');
    const messageText = validateAndNormalizeMessageText(req.body, 'message');

    // 1. Validate that the business exists
    const business = await findBusinessOrThrow(businessId);

    // 2. Confirm conversation ownership, reject closed conversations, save message,
    //    and update conversations.updated_at atomically in a transaction
    const { message: savedMessage } = await addMessageToConversation({
      businessId: business.id,
      conversationId,
      senderType,
      content: messageText,
    });

    // If this message is an agent/user reply (AI-generated, edited, or manual),
    // save it directly to the conversation and do NOT generate a new AI prompt.
    if (senderType === 'agent') {
      return res.status(201).json(formatMessageResponse(savedMessage));
    }

    // 3. Retrieve recent messages (bounded to the latest 20 messages) in chronological order
    const recentMessages = await getRecentConversationMessages(
      conversationId,
      env.conversationHistoryLimit
    );

    // Exclude the just-saved current message from prior history block so it is not duplicated
    const conversationHistory = recentMessages.filter(
      (msg) => msg.id !== savedMessage.id
    );

    // 4. Retrieve relevant business context scoped to this business (considering conversation context)
    const contextSearchText = [
      ...conversationHistory
        .filter((msg) => msg.sender_type === 'customer')
        .map((msg) => msg.content),
      messageText,
    ].join(' ');

    const relevantRecords = await retrieveRelevantContextForBusiness(
      business.id,
      contextSearchText
    );

    // 5. Construct the dynamic prompt with conversation history, latest message, and business context
    const promptText = buildContextualPrompt({
      business,
      relevantRecords,
      customerMessage: messageText,
      conversationHistory,
    });

    // Optional debug mode: ?format=prompt returns the raw prompt string
    if (req.query && req.query.format === 'prompt') {
      return res
        .status(200)
        .set('Content-Type', 'text/plain; charset=utf-8')
        .send(promptText);
    }

    // 6. Send the constructed prompt to Google AI Studio (Gemini) and return the actual AI response
    const aiResponse = await generateAiSupportResponse(promptText);

    return res.status(200).json(aiResponse);
  } catch (error) {
    return next(error);
  }
}

/**
 * POST /api/businesses/:businessId/conversations/:conversationId/replies
 * Dedicated endpoint for saving a support user / agent reply (whether AI-generated,
 * AI-generated and user-edited, or written manually) directly into the conversation
 * history with sender_type = 'agent', without generating an AI prompt.
 */
async function postAgentReplyToConversation(req, res, next) {
  try {
    const { businessId, conversationId } = req.params;
    const replyText = validateAndNormalizeMessageText(req.body, 'message');

    // 1. Validate that the business exists
    const business = await findBusinessOrThrow(businessId);

    // 2. Confirm conversation ownership, reject closed conversations, save agent reply,
    //    and update conversations.updated_at atomically in a transaction
    const { message: savedMessage } = await addMessageToConversation({
      businessId: business.id,
      conversationId,
      senderType: 'agent',
      content: replyText,
    });

    // 3. Return the persisted agent message directly without generating a prompt
    return res.status(201).json(formatMessageResponse(savedMessage));
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  createBusinessConversation,
  getBusinessConversation,
  updateBusinessConversationStatus,
  postCustomerMessageAndGeneratePrompt,
  postAgentReplyToConversation,
};
