import { createSlice, createAsyncThunk } from '@reduxjs/toolkit';
import {
  fetchCompanyConversations,
  fetchCompanyConversationDetail,
  sendCompanyReply,
} from '../services/api';

/**
 * Helper to extract AI suggestion details from a company conversation object.
 */
function extractAiSuggestionState(conv) {
  if (!conv) {
    return {
      draftText: '',
      meta: null,
    };
  }

  const aiSug = conv.ai_suggestion || null;
  const draftReply =
    conv.ai_draft_reply || (aiSug && aiSug.suggestion) || '';

  if (!draftReply && !aiSug) {
    return {
      draftText: '',
      meta: null,
    };
  }

  return {
    draftText: draftReply,
    meta: {
      originalSuggestion: draftReply,
      category: (aiSug && aiSug.category) || 'general_inquiry',
      missingInformation: Array.isArray(aiSug?.missing_information)
        ? aiSug.missing_information
        : [],
      sourceMessageId: aiSug?.source_message_id || null,
      sourceMessageContent: aiSug?.source_message_content || null,
      updatedAt: aiSug?.updated_at || conv.updated_at || null,
    },
  };
}

/**
 * Thunk: Fetch all conversations for BUSINESS_ID.
 */
export const loadCompanyConversations = createAsyncThunk(
  'company/loadCompanyConversations',
  async ({ silent = false } = {}, { rejectWithValue }) => {
    try {
      const data = await fetchCompanyConversations();
      return {
        conversations: Array.isArray(data.conversations)
          ? data.conversations
          : [],
        silent,
      };
    } catch (err) {
      return rejectWithValue({
        message:
          err.message || 'Failed to fetch customer conversations for inbox.',
        silent,
      });
    }
  }
);

/**
 * Thunk: Select a conversation in the inbox and fetch its latest full detail & AI draft.
 */
export const selectAndLoadConversation = createAsyncThunk(
  'company/selectAndLoadConversation',
  async (conversationId, { rejectWithValue }) => {
    try {
      const detail = await fetchCompanyConversationDetail(conversationId);
      return detail;
    } catch (err) {
      return rejectWithValue({
        message:
          err.message || 'Failed to load the selected conversation thread.',
      });
    }
  }
);

/**
 * Thunk: Send an approved company response via POST /api/businesses/{BUSINESS_ID}/conversations/{conversation_id}/replies.
 */
export const submitCompanyReply = createAsyncThunk(
  'company/submitCompanyReply',
  async ({ conversationId, message }, { dispatch, rejectWithValue }) => {
    try {
      const response = await sendCompanyReply(conversationId, message);
      const savedReply = response.message || {
        id: response.id,
        conversation_id: response.conversation_id || conversationId,
        sender_type: 'agent',
        content: response.content || message,
        created_at: response.created_at || new Date().toISOString(),
      };

      // Refresh inbox list in background so previews and unread counts stay in sync
      dispatch(loadCompanyConversations({ silent: true }));

      return {
        conversationId,
        savedReply,
      };
    } catch (err) {
      return rejectWithValue({
        message:
          err.message ||
          'Failed to send company reply. Your draft has been preserved.',
      });
    }
  }
);

const initialState = {
  conversations: [],
  activeConversationId: null,
  activeConversation: null,

  // AI Workspace Copilot state for the active conversation
  aiSuggestionDraft: '',
  aiSuggestionMeta: null,
  isSuggestionEdited: false,

  // Loading & Error states
  inboxStatus: 'idle',
  inboxError: null,
  threadStatus: 'idle',
  threadError: null,
  sendReplyStatus: 'idle',
  sendReplyError: null,
};

const companySlice = createSlice({
  name: 'company',
  initialState,
  reducers: {
    setActiveConversationImmediate(state, action) {
      const convId = action.payload;
      state.activeConversationId = convId;
      state.sendReplyError = null;
      state.threadError = null;

      const found = state.conversations.find((c) => c.id === convId);
      if (found) {
        state.activeConversation = found;
        const { draftText, meta } = extractAiSuggestionState(found);
        state.aiSuggestionDraft = draftText;
        state.aiSuggestionMeta = meta;
        state.isSuggestionEdited = false;
      }
    },
    updateAiSuggestionDraft(state, action) {
      state.aiSuggestionDraft = action.payload;
      const orig = state.aiSuggestionMeta?.originalSuggestion || '';
      state.isSuggestionEdited = action.payload !== orig;
    },
    resetAiSuggestionDraftToOriginal(state) {
      if (state.aiSuggestionMeta?.originalSuggestion) {
        state.aiSuggestionDraft = state.aiSuggestionMeta.originalSuggestion;
        state.isSuggestionEdited = false;
      }
    },
    clearCompanyReplyError(state) {
      state.sendReplyError = null;
    },
  },
  extraReducers: (builder) => {
    builder
      // Load Conversations List
      .addCase(loadCompanyConversations.pending, (state, action) => {
        if (!action.meta.arg?.silent) {
          state.inboxStatus = 'loading';
          state.inboxError = null;
        }
      })
      .addCase(loadCompanyConversations.fulfilled, (state, action) => {
        state.inboxStatus = 'succeeded';
        state.inboxError = null;
        const list = action.payload.conversations;
        state.conversations = list;

        // If no conversation is selected yet, auto-select the most recent one
        if (!state.activeConversationId && list.length > 0) {
          const first = list[0];
          state.activeConversationId = first.id;
          state.activeConversation = first;
          const { draftText, meta } = extractAiSuggestionState(first);
          state.aiSuggestionDraft = draftText;
          state.aiSuggestionMeta = meta;
          state.isSuggestionEdited = false;
        } else if (state.activeConversationId) {
          // Keep activeConversation synchronized with latest messages/AI suggestions
          const updatedActive = list.find(
            (c) => c.id === state.activeConversationId
          );
          if (updatedActive) {
            const prevDraftOrig =
              state.aiSuggestionMeta?.originalSuggestion || '';
            state.activeConversation = updatedActive;
            const { draftText, meta } = extractAiSuggestionState(updatedActive);
            state.aiSuggestionMeta = meta;
            // Only overwrite the user's editable Copilot draft if a new AI suggestion arrived
            // or if the user hasn't manually edited the current draft
            if (!state.isSuggestionEdited || draftText !== prevDraftOrig) {
              state.aiSuggestionDraft = draftText;
              state.isSuggestionEdited = false;
            }
          }
        }
      })
      .addCase(loadCompanyConversations.rejected, (state, action) => {
        if (!action.payload?.silent) {
          state.inboxStatus = 'failed';
          state.inboxError = action.payload?.message || 'Failed to load inbox.';
        }
      })

      // Select & Load Conversation Detail
      .addCase(selectAndLoadConversation.pending, (state, action) => {
        state.threadStatus = 'loading';
        state.threadError = null;
        state.activeConversationId = action.meta.arg;
      })
      .addCase(selectAndLoadConversation.fulfilled, (state, action) => {
        state.threadStatus = 'succeeded';
        const detail = action.payload;
        state.activeConversationId = detail.id;
        state.activeConversation = detail;

        const idx = state.conversations.findIndex((c) => c.id === detail.id);
        if (idx !== -1) {
          state.conversations[idx] = detail;
        } else {
          state.conversations.unshift(detail);
        }

        const { draftText, meta } = extractAiSuggestionState(detail);
        state.aiSuggestionDraft = draftText;
        state.aiSuggestionMeta = meta;
        state.isSuggestionEdited = false;
      })
      .addCase(selectAndLoadConversation.rejected, (state, action) => {
        state.threadStatus = 'failed';
        state.threadError =
          action.payload?.message || 'Failed to load conversation.';
      })

      // Submit Company Reply
      .addCase(submitCompanyReply.pending, (state) => {
        state.sendReplyStatus = 'loading';
        state.sendReplyError = null;
      })
      .addCase(submitCompanyReply.fulfilled, (state, action) => {
        state.sendReplyStatus = 'succeeded';
        const { conversationId, savedReply } = action.payload;

        if (
          state.activeConversation &&
          state.activeConversation.id === conversationId
        ) {
          const exists = state.activeConversation.messages.some(
            (m) => m.id === savedReply.id
          );
          if (!exists) {
            state.activeConversation.messages.push(savedReply);
          }
          state.activeConversation.latest_message = savedReply;
          state.activeConversation.latest_message_preview = savedReply.content;
          state.activeConversation.latest_activity_at = savedReply.created_at;
          state.activeConversation.unread_count = 0;
          state.activeConversation.needs_reply = false;
          state.activeConversation.ai_draft_reply = null;
          state.activeConversation.ai_suggestion = null;
        }

        const convInList = state.conversations.find(
          (c) => c.id === conversationId
        );
        if (convInList) {
          const existsInList = convInList.messages?.some(
            (m) => m.id === savedReply.id
          );
          if (Array.isArray(convInList.messages) && !existsInList) {
            convInList.messages.push(savedReply);
          }
          convInList.latest_message = savedReply;
          convInList.latest_message_preview = savedReply.content;
          convInList.latest_activity_at = savedReply.created_at;
          convInList.unread_count = 0;
          convInList.needs_reply = false;
          convInList.ai_draft_reply = null;
          convInList.ai_suggestion = null;
        }

        // Clear the active AI draft once the reply has been sent
        state.aiSuggestionDraft = '';
        state.aiSuggestionMeta = null;
        state.isSuggestionEdited = false;
      })
      .addCase(submitCompanyReply.rejected, (state, action) => {
        state.sendReplyStatus = 'failed';
        state.sendReplyError =
          action.payload?.message || 'Failed to send reply.';
      });
  },
});

export const {
  setActiveConversationImmediate,
  updateAiSuggestionDraft,
  resetAiSuggestionDraftToOriginal,
  clearCompanyReplyError,
} = companySlice.actions;

export default companySlice.reducer;
