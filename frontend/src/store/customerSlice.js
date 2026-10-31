import { createSlice, createAsyncThunk } from '@reduxjs/toolkit';
import {
  registerCustomer,
  fetchCustomerConversationHistory,
  createCustomerConversation,
  sendCustomerMessage,
} from '../services/api';
import { STORAGE_KEYS } from '../config/constants';

function getStoredCustomerId() {
  try {
    return localStorage.getItem(STORAGE_KEYS.CUSTOMER_ID) || null;
  } catch {
    return null;
  }
}

function getStoredConversationId() {
  try {
    return localStorage.getItem(STORAGE_KEYS.CONVERSATION_ID) || null;
  } catch {
    return null;
  }
}

function getStoredCustomerProfile() {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.CUSTOMER_PROFILE);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/**
 * Thunk: Register a new customer for BUSINESS_ID.
 * Stores the returned customer_id in localStorage and opens the one-time ID modal.
 */
export const registerNewCustomer = createAsyncThunk(
  'customer/registerNewCustomer',
  async ({ customerName, email, externalCustomerId }, { rejectWithValue }) => {
    try {
      const response = await registerCustomer({
        customerName,
        email,
        externalCustomerId,
      });
      const generatedId = response.customer_id || response.id;
      const profile = {
        customer_name: response.customer_name,
        email: response.email,
        external_customer_id: response.external_customer_id || null,
      };

      try {
        localStorage.setItem(STORAGE_KEYS.CUSTOMER_ID, generatedId);
        localStorage.setItem(
          STORAGE_KEYS.CUSTOMER_PROFILE,
          JSON.stringify(profile)
        );
        localStorage.removeItem(STORAGE_KEYS.CONVERSATION_ID);
      } catch {
        // Ignore storage quota errors
      }

      return {
        customerId: generatedId,
        profile,
      };
    } catch (err) {
      return rejectWithValue({
        message: err.message || 'Failed to register customer.',
        status: err.status || 0,
        isDuplicateEmail: err.status === 409,
      });
    }
  }
);

/**
 * Thunk: Validate customer_id against BUSINESS_ID and load existing conversation
 * history via POST /api/businesses/{BUSINESS_ID}/conversations/history.
 * If valid customer has no conversation yet, creates one via POST /conversations.
 */
export const loginAndLoadCustomerConversation = createAsyncThunk(
  'customer/loginAndLoadCustomerConversation',
  async (customerIdInput, { rejectWithValue }) => {
    const trimmedId = String(customerIdInput || '').trim();
    if (!trimmedId) {
      return rejectWithValue({
        message: 'Please enter a valid Customer ID.',
        status: 400,
      });
    }

    try {
      // Step 1: Validate customer and retrieve conversation history
      const historyData = await fetchCustomerConversationHistory(trimmedId);
      const verifiedCustomerId = historyData.customer_id || trimmedId;
      const profile = historyData.customer
        ? {
            customer_name: historyData.customer.customer_name,
            email: historyData.customer.email,
            external_customer_id:
              historyData.customer.external_customer_id || null,
          }
        : null;

      let conversationId = null;
      let conversationStatus = 'open';
      let messages = [];

      if (historyData.has_conversation && historyData.conversation) {
        // Existing conversation found — use its history instead of creating a duplicate
        conversationId =
          historyData.conversation_id || historyData.conversation.id;
        conversationStatus = historyData.conversation.status || 'open';
        messages = Array.isArray(historyData.messages)
          ? historyData.messages
          : Array.isArray(historyData.conversation.messages)
            ? historyData.conversation.messages
            : [];
      } else {
        // Customer is valid for this business but has no conversation yet.
        // A conversation is ONLY created when the customer actually sends their first message.
        conversationId = null;
        conversationStatus = 'open';
        messages = [];
      }

      try {
        localStorage.setItem(STORAGE_KEYS.CUSTOMER_ID, verifiedCustomerId);
        if (profile) {
          localStorage.setItem(
            STORAGE_KEYS.CUSTOMER_PROFILE,
            JSON.stringify(profile)
          );
        }
        if (conversationId) {
          localStorage.setItem(STORAGE_KEYS.CONVERSATION_ID, conversationId);
        } else {
          localStorage.removeItem(STORAGE_KEYS.CONVERSATION_ID);
        }
      } catch {
        // Ignore localStorage write errors
      }

      return {
        customerId: verifiedCustomerId,
        profile,
        conversationId,
        conversationStatus,
        messages,
      };
    } catch (err) {
      return rejectWithValue({
        message:
          err.message ||
          'Could not verify Customer ID for this business. Please check your ID and try again.',
        status: err.status || 0,
      });
    }
  }
);

/**
 * Thunk: Quietly refresh the active customer's conversation history so incoming
 * company replies appear automatically or on manual refresh.
 */
export const refreshCustomerConversation = createAsyncThunk(
  'customer/refreshCustomerConversation',
  async (_, { getState, rejectWithValue }) => {
    const { customerId } = getState().customer;
    if (!customerId) {
      return rejectWithValue({ message: 'No active customer session.' });
    }

    try {
      const historyData = await fetchCustomerConversationHistory(customerId);
      if (!historyData.has_conversation || !historyData.conversation) {
        return {
          messages: [],
          conversationStatus: 'open',
        };
      }

      return {
        conversationId:
          historyData.conversation_id || historyData.conversation.id,
        conversationStatus: historyData.conversation.status || 'open',
        messages: Array.isArray(historyData.messages)
          ? historyData.messages
          : [],
      };
    } catch (err) {
      return rejectWithValue({
        message: err.message || 'Failed to refresh conversation.',
      });
    }
  }
);

/**
 * Thunk: Send a customer message via POST /api/businesses/{BUSINESS_ID}/conversations/{conversation_id}/messages.
 * If the conversation has not been created yet (first message from new customer), lazily creates it first!
 */
export const submitCustomerMessage = createAsyncThunk(
  'customer/submitCustomerMessage',
  async ({ conversationId, message }, { getState, rejectWithValue }) => {
    try {
      let activeConversationId = conversationId;

      // Lazy conversation creation: conversation is created ONLY when customer sends their first message!
      if (!activeConversationId) {
        const { customerId } = getState().customer;
        if (!customerId) {
          return rejectWithValue({
            message: 'No active customer session found. Please log in first.',
          });
        }
        const newConv = await createCustomerConversation(customerId);
        activeConversationId = newConv.conversation_id || newConv.id;
        try {
          localStorage.setItem(STORAGE_KEYS.CONVERSATION_ID, activeConversationId);
        } catch {
          // Ignore storage write error
        }
      }

      const response = await sendCustomerMessage(activeConversationId, message);
      const savedMsg = response.message || {
        id: response.id,
        conversation_id: response.conversation_id || activeConversationId,
        sender_type: 'customer',
        content: response.content || message,
        created_at: response.created_at || new Date().toISOString(),
      };
      return {
        ...savedMsg,
        conversationId: activeConversationId,
      };
    } catch (err) {
      return rejectWithValue({
        message:
          err.message || 'Failed to send your message. Please try again.',
        status: err.status || 0,
      });
    }
  }
);

const initialState = {
  customerId: getStoredCustomerId(),
  customerProfile: getStoredCustomerProfile(),
  conversationId: getStoredConversationId(),
  conversationStatus: 'open',
  messages: [],
  isSessionActive: false,

  // One-time ID reveal popup state (never revealed again once dismissed)
  newlyGeneratedCustomerId: null,
  showOneTimeIdModal: false,

  // Registration state
  registerStatus: 'idle',
  registerError: null,
  isDuplicateEmail: false,

  // Login / history lookup state
  loginStatus: 'idle',
  loginError: null,

  // Messaging state
  sendMessageStatus: 'idle',
  sendMessageError: null,
};

const customerSlice = createSlice({
  name: 'customer',
  initialState,
  reducers: {
    dismissOneTimeIdModal(state) {
      state.showOneTimeIdModal = false;
      state.newlyGeneratedCustomerId = null;
    },
    clearCustomerErrors(state) {
      state.registerError = null;
      state.isDuplicateEmail = false;
      state.loginError = null;
      state.sendMessageError = null;
    },
    exitCustomerConversationView(state) {
      state.isSessionActive = false;
      state.newlyGeneratedCustomerId = null;
      state.showOneTimeIdModal = false;
      state.loginError = null;
      state.registerError = null;
      state.isDuplicateEmail = false;
      state.sendMessageError = null;
      try {
        localStorage.removeItem(STORAGE_KEYS.CONVERSATION_ID);
      } catch {
        // Ignore
      }
    },
  },
  extraReducers: (builder) => {
    builder
      // Register Customer
      .addCase(registerNewCustomer.pending, (state) => {
        state.registerStatus = 'loading';
        state.registerError = null;
        state.isDuplicateEmail = false;
      })
      .addCase(registerNewCustomer.fulfilled, (state, action) => {
        state.registerStatus = 'succeeded';
        state.customerId = action.payload.customerId;
        state.customerProfile = action.payload.profile;
        state.newlyGeneratedCustomerId = action.payload.customerId;
        state.showOneTimeIdModal = true;
        state.conversationId = null;
        state.messages = [];
      })
      .addCase(registerNewCustomer.rejected, (state, action) => {
        state.registerStatus = 'failed';
        state.registerError =
          action.payload?.message || 'Registration failed.';
        state.isDuplicateEmail = Boolean(action.payload?.isDuplicateEmail);
      })

      // Login & Load Conversation History
      .addCase(loginAndLoadCustomerConversation.pending, (state) => {
        state.loginStatus = 'loading';
        state.loginError = null;
      })
      .addCase(loginAndLoadCustomerConversation.fulfilled, (state, action) => {
        state.loginStatus = 'succeeded';
        state.customerId = action.payload.customerId;
        if (action.payload.profile) {
          state.customerProfile = action.payload.profile;
        }
        state.conversationId = action.payload.conversationId;
        state.conversationStatus = action.payload.conversationStatus;
        state.messages = action.payload.messages;
        state.isSessionActive = true;
        // Ensure one-time ID is never lingered after entering conversation
        state.showOneTimeIdModal = false;
        state.newlyGeneratedCustomerId = null;
      })
      .addCase(loginAndLoadCustomerConversation.rejected, (state, action) => {
        state.loginStatus = 'failed';
        state.loginError =
          action.payload?.message || 'Failed to load conversation history.';
        state.isSessionActive = false;
      })

      // Quiet Refresh
      .addCase(refreshCustomerConversation.fulfilled, (state, action) => {
        if (action.payload.conversationId) {
          state.conversationId = action.payload.conversationId;
        }
        state.conversationStatus = action.payload.conversationStatus;
        state.messages = action.payload.messages;
      })

      // Submit Customer Message
      .addCase(submitCustomerMessage.pending, (state) => {
        state.sendMessageStatus = 'loading';
        state.sendMessageError = null;
      })
      .addCase(submitCustomerMessage.fulfilled, (state, action) => {
        state.sendMessageStatus = 'succeeded';
        const newMsg = action.payload;
        if (newMsg?.conversationId) {
          state.conversationId = newMsg.conversationId;
        }
        const exists = state.messages.some((m) => m.id === newMsg.id);
        if (!exists) {
          state.messages.push(newMsg);
        }
      })
      .addCase(submitCustomerMessage.rejected, (state, action) => {
        state.sendMessageStatus = 'failed';
        state.sendMessageError =
          action.payload?.message || 'Failed to send message.';
      });
  },
});

export const {
  dismissOneTimeIdModal,
  clearCustomerErrors,
  exitCustomerConversationView,
} = customerSlice.actions;

export default customerSlice.reducer;
