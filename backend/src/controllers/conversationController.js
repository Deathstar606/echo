const AppError = require('../utils/AppError');
const { isValidUuid } = require('../middleware/validate');
const { findBusinessOrThrow } = require('./businessController');
const {
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
} = require('../services/conversationService');
const {
  generateWorkspaceCustomerReply,
} = require('../services/workspaceReplyService');

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

  const latestCustomerMessage =
    latestMessage && latestMessage.sender_type === 'customer'
      ? latestMessage
      : null;
  const latestCustomerMsgWithSuggestion =
    latestCustomerMessage?.ai_suggestion ? latestCustomerMessage : null;

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
 * Saves a customer or agent message without triggering reply generation.
 */
async function postConversationMessage(req, res, next) {
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

    const formatted = formatCustomerMessageResponse(savedMessage);
    return res.status(201).json({
      ...formatted,
      message: formatted,
    });
  } catch (error) {
    return next(error);
  }
}

/**
 * POST /api/businesses/:businessId/conversations/:conversationId/reply-draft
 * Generates and stores an editable reply using only the active workspace's
 * relevant documents and sheet rows. It never sends or persists an agent message.
 */
async function generateConversationReplyDraft(req, res, next) {
  try {
    const { businessId, conversationId } = req.params;
    const requestUserId =
      req.headers['x-user-id'] ||
      req.query?.userId ||
      req.query?.user_id ||
      req.body?.userId ||
      req.body?.user_id ||
      null;
    if (!requestUserId) {
      throw new AppError('A logged-in user is required to generate a workspace reply.', 401);
    }

    const business = await findBusinessOrThrow(businessId, requestUserId);
    const conversation = await findConversationForBusinessOrThrow(
      business.id,
      conversationId
    );
    if (conversation.status !== 'open') {
      throw new AppError('Cannot generate a reply for a closed conversation.', 400);
    }

    const recentMessages = await getRecentConversationMessages(
      conversationId,
      6
    );
    const latestMessage = recentMessages[recentMessages.length - 1];
    if (!latestMessage || latestMessage.sender_type !== 'customer') {
      throw new AppError(
        'There is no unanswered customer message to generate a reply for.',
        409
      );
    }

    const conversationHistory = recentMessages.slice(0, -1).slice(-5);
    const { aiResponse, suggestion } = await generateWorkspaceCustomerReply({
      workspace: business,
      customerMessage: latestMessage.content,
      customerContext: {
        customer_name: conversation.customer_name || conversation.customerName,
        reference_id: conversation.reference_id || conversation.referenceId,
        inquiry_id: conversation.id,
      },
      conversationHistory,
    });

    await saveAiSuggestionForMessageAndConversation({
      businessId: business.id,
      conversationId,
      messageId: latestMessage.id,
      suggestion,
      category: aiResponse.category,
      missingInformation: aiResponse.missing_information,
    });

    return res.status(200).json({
      conversation_id: conversationId,
      source_message_id: latestMessage.id,
      source_message_content: latestMessage.content,
      ai_draft_reply: suggestion,
      ai_suggestion: {
        suggestion,
        category: aiResponse.category,
        missing_information: aiResponse.missing_information,
        source_message_id: latestMessage.id,
        source_message_content: latestMessage.content,
        updated_at: new Date().toISOString(),
      },
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
  postConversationMessage,
  generateConversationReplyDraft,
  postAgentReplyToConversation,
};
