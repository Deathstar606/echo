const env = require('../config/env');
const AppError = require('../utils/AppError');
const { isValidUuid } = require('../middleware/validate');
const { findBusinessOrThrow } = require('./businessController');
const {
  ALLOWED_SENDER_TYPES,
  createConversation,
  getConversationWithMessages,
  findCustomerConversationWithMessages,
  listConversationsForBusiness,
  saveAiSuggestionForMessageAndConversation,
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

/**
 * Customer-safe message formatter: never includes AI suggestion or internal metadata.
 */
function formatCustomerMessageResponse(msg) {
  return {
    id: msg.id,
    conversation_id: msg.conversation_id,
    sender_type: msg.sender_type,
    content: msg.content,
    created_at: msg.created_at,
  };
}

/**
 * Company-facing message formatter: includes AI suggestion metadata associated with incoming messages.
 */
function formatCompanyMessageResponse(msg) {
  return {
    id: msg.id,
    conversation_id: msg.conversation_id,
    sender_type: msg.sender_type,
    content: msg.content,
    created_at: msg.created_at,
    ai_suggestion: msg.ai_suggestion || null,
    ai_category: msg.ai_category || null,
    ai_missing_info: Array.isArray(msg.ai_missing_info)
      ? msg.ai_missing_info
      : [],
  };
}

/**
 * Customer-safe conversation formatter: strips all AI draft fields.
 */
function formatCustomerConversationResponse(conversation, messages = undefined) {
  const payload = {
    id: conversation.id,
    conversation_id: conversation.id,
    business_id: conversation.business_id,
    customer_id: conversation.customer_id,
    status: conversation.status,
    created_at: conversation.created_at,
    updated_at: conversation.updated_at,
  };

  if (Array.isArray(messages)) {
    payload.messages = messages.map(formatCustomerMessageResponse);
  }

  return payload;
}

/**
 * Company-facing conversation formatter: includes customer info, chronological messages,
 * unread count, latest message preview, and active AI-generated draft suggestion.
 */
function formatCompanyConversationResponse({
  conversation,
  customer = null,
  messages = [],
}) {
  const formattedMessages = Array.isArray(messages)
    ? messages.map(formatCompanyMessageResponse)
    : [];

  const latestMessage =
    formattedMessages.length > 0
      ? formattedMessages[formattedMessages.length - 1]
      : null;

  // Count trailing customer messages since the last agent reply
  let unreadCount = 0;
  for (let i = formattedMessages.length - 1; i >= 0; i -= 1) {
    if (formattedMessages[i].sender_type === 'customer') {
      unreadCount += 1;
    } else {
      break;
    }
  }

  const latestCustomerMsgWithSuggestion = [...formattedMessages]
    .reverse()
    .find((m) => m.sender_type === 'customer' && m.ai_suggestion);

  const activeDraftReply =
    conversation.ai_draft_reply ||
    (unreadCount > 0 && latestCustomerMsgWithSuggestion
      ? latestCustomerMsgWithSuggestion.ai_suggestion
      : null);

  const activeDraftCategory =
    conversation.ai_draft_category ||
    (latestCustomerMsgWithSuggestion
      ? latestCustomerMsgWithSuggestion.ai_category
      : null);

  const activeDraftMissingInfo =
    Array.isArray(conversation.ai_draft_missing_info) &&
    conversation.ai_draft_missing_info.length > 0
      ? conversation.ai_draft_missing_info
      : latestCustomerMsgWithSuggestion
        ? latestCustomerMsgWithSuggestion.ai_missing_info
        : [];

  const sourceMessage =
    formattedMessages.find((m) => m.id === conversation.ai_draft_message_id) ||
    latestCustomerMsgWithSuggestion ||
    (latestMessage && latestMessage.sender_type === 'customer'
      ? latestMessage
      : null);

  const aiSuggestionObj = activeDraftReply
    ? {
        suggestion: activeDraftReply,
        category: activeDraftCategory || 'general_inquiry',
        missing_information: activeDraftMissingInfo,
        source_message_id: sourceMessage ? sourceMessage.id : null,
        source_message_content: sourceMessage ? sourceMessage.content : null,
        updated_at:
          conversation.ai_draft_updated_at || conversation.updated_at || null,
      }
    : null;

  return {
    id: conversation.id,
    conversation_id: conversation.id,
    business_id: conversation.business_id,
    customer_id: conversation.customer_id,
    status: conversation.status,
    created_at: conversation.created_at,
    updated_at: conversation.updated_at,
    customer: customer
      ? {
          id: customer.id,
          customer_name: customer.customer_name || null,
          email: customer.email || null,
          external_customer_id: customer.external_customer_id || null,
        }
      : null,
    customer_name: customer && customer.customer_name ? customer.customer_name : null,
    customer_email: customer && customer.email ? customer.email : null,
    external_customer_id:
      customer && customer.external_customer_id
        ? customer.external_customer_id
        : null,
    latest_message: latestMessage,
    latest_message_preview: latestMessage ? latestMessage.content : '',
    latest_activity_at: latestMessage
      ? latestMessage.created_at
      : conversation.updated_at,
    unread_count: unreadCount,
    needs_reply: unreadCount > 0,
    ai_draft_reply: activeDraftReply,
    ai_suggestion: aiSuggestionObj,
    messages: formattedMessages,
  };
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

function buildFallbackSupportSuggestion(business, relevantRecords, messageText) {
  const topRecord = Array.isArray(relevantRecords) && relevantRecords.length > 0
    ? relevantRecords[0]
    : null;

  if (topRecord) {
    return {
      category: topRecord.category || 'general_inquiry',
      suggestions: [
        `Thank you for reaching out to ${business.name}. Regarding ${topRecord.title.toLowerCase()}: ${topRecord.content} Please let us know how you would like to proceed.`,
      ],
      missing_information: [],
    };
  }

  return {
    category: 'general_inquiry',
    suggestions: [
      `Thank you for contacting ${business.name}. We have received your inquiry ("${messageText.slice(0, 80)}${messageText.length > 80 ? '...' : ''}") and a team member is reviewing your account details now. How can we best assist you today?`,
    ],
    missing_information: ['Account or booking reference if applicable'],
  };
}

/**
 * GET /api/businesses/:businessId/conversations
 * Lists all conversations belonging strictly to the specified business,
 * including customer info, messages, and any AI-generated draft suggestion.
 */
async function listBusinessConversations(req, res, next) {
  try {
    const { businessId } = req.params;

    const business = await findBusinessOrThrow(businessId);
    const records = await listConversationsForBusiness(business.id);
    const conversations = records.map(formatCompanyConversationResponse);

    return res.status(200).json({
      business_id: business.id,
      total_conversations: conversations.length,
      conversations,
    });
  } catch (error) {
    return next(error);
  }
}

/**
 * POST /api/businesses/:businessId/conversations/history
 * Validates customer against the specified business and returns their existing
 * conversation and customer-safe message history, if available.
 */
async function getCustomerConversationHistory(req, res, next) {
  try {
    const { businessId } = req.params;
    const body = req.body || {};

    const rawCustomerId =
      body.customer_id !== undefined ? body.customer_id : body.customerId;

    if (!rawCustomerId || typeof rawCustomerId !== 'string') {
      throw new AppError(
        '"customer_id" is required and must be a valid UUID.',
        400
      );
    }

    if (!isValidUuid(rawCustomerId)) {
      throw new AppError(
        'Invalid "customer_id". Must be a valid UUID.',
        400
      );
    }

    const customerId = rawCustomerId.trim();

    // Confirm business exists
    const business = await findBusinessOrThrow(businessId);

    const { customer, conversation, messages } =
      await findCustomerConversationWithMessages(business.id, customerId);

    const customerPayload = {
      id: customer.id,
      customer_id: customer.id,
      business_id: customer.business_id,
      customer_name: customer.customer_name,
      email: customer.email,
      external_customer_id: customer.external_customer_id,
    };

    if (!conversation) {
      return res.status(200).json({
        customer_valid: true,
        has_conversation: false,
        message: 'Customer verified. No existing conversation found for this business.',
        business_id: business.id,
        customer_id: customer.id,
        customer: customerPayload,
        conversation_id: null,
        conversation: null,
        messages: [],
      });
    }

    const formattedConv = formatCustomerConversationResponse(
      conversation,
      messages
    );

    return res.status(200).json({
      customer_valid: true,
      has_conversation: true,
      business_id: business.id,
      customer_id: customer.id,
      customer: customerPayload,
      conversation_id: conversation.id,
      conversation: formattedConv,
      messages: formattedConv.messages,
    });
  } catch (error) {
    return next(error);
  }
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

    return res
      .status(201)
      .json(formatCustomerConversationResponse(conversation, []));
  } catch (error) {
    return next(error);
  }
}

/**
 * GET /api/businesses/:businessId/conversations/:conversationId
 * Returns conversation metadata, customer info, chronological message history,
 * and any AI-generated draft suggestion for the company view.
 */
async function getBusinessConversation(req, res, next) {
  try {
    const { businessId, conversationId } = req.params;

    // Confirm business exists
    const business = await findBusinessOrThrow(businessId);

    const { conversation, customer, messages } =
      await getConversationWithMessages(business.id, conversationId);

    return res.status(200).json(
      formatCompanyConversationResponse({
        conversation,
        customer,
        messages,
      })
    );
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

    return res.status(200).json(formatCustomerConversationResponse(updated));
  } catch (error) {
    return next(error);
  }
}

/**
 * POST /api/businesses/:businessId/conversations/:conversationId/messages
 * - When sender_type is 'customer' (or omitted):
 *   Saves the incoming customer message, retrieves recent chronological conversation history
 *   (bounded to the latest 20 messages) and relevant business context, generates the AI
 *   suggested response, saves the AI suggestion server-side for the company interface,
 *   and returns ONLY the customer-safe message record (never exposing the AI suggestion
 *   in the customer API response).
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
      return res.status(201).json(formatCustomerMessageResponse(savedMessage));
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

    // 6. Generate the AI suggested response and persist it server-side for the company panel
    let aiResponse;
    try {
      aiResponse = await generateAiSupportResponse(promptText);
    } catch (aiError) {
      // If upstream Gemini fails during live usage, fall back to a contextual draft
      // so the customer's message submission still succeeds cleanly.
      aiResponse = buildFallbackSupportSuggestion(
        business,
        relevantRecords,
        messageText
      );
    }

    const suggestionText =
      Array.isArray(aiResponse.suggestions) && aiResponse.suggestions.length > 0
        ? aiResponse.suggestions[0]
        : '';

    if (suggestionText) {
      await saveAiSuggestionForMessageAndConversation({
        businessId: business.id,
        conversationId,
        messageId: savedMessage.id,
        suggestion: suggestionText,
        category: aiResponse.category || 'general_inquiry',
        missingInformation: aiResponse.missing_information || [],
      });
    }

    // 7. Return ONLY customer-safe message data (never expose AI suggestion to the customer)
    const customerSafeMessage = formatCustomerMessageResponse(savedMessage);
    return res.status(201).json({
      ...customerSafeMessage,
      message: customerSafeMessage,
    });
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
    //    clear active AI draft, and update conversations.updated_at atomically in a transaction
    const { message: savedMessage } = await addMessageToConversation({
      businessId: business.id,
      conversationId,
      senderType: 'agent',
      content: replyText,
    });

    // 3. Return the persisted agent message directly without generating a prompt
    const formatted = formatCustomerMessageResponse(savedMessage);
    return res.status(201).json({
      ...formatted,
      message: formatted,
    });
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  listBusinessConversations,
  getCustomerConversationHistory,
  createBusinessConversation,
  getBusinessConversation,
  updateBusinessConversationStatus,
  postCustomerMessageAndGeneratePrompt,
  postAgentReplyToConversation,
};
