import React, { useEffect, useRef, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { AnimatePresence, motion } from 'framer-motion';
import {
  UserPlus,
  KeyRound,
  Copy,
  Check,
  ShieldAlert,
  ArrowRight,
  Send,
  RefreshCw,
  LogOut,
  MessageCircle,
  User,
  Headphones,
  AlertCircle,
  CheckCircle2,
  Loader2,
} from 'lucide-react';
import {
  registerNewCustomer,
  loginAndLoadCustomerConversation,
  refreshCustomerConversation,
  submitCustomerMessage,
  dismissOneTimeIdModal,
  clearCustomerErrors,
  exitCustomerConversationView,
} from '../store/customerSlice';
import { STORAGE_KEYS } from '../config/constants';

function formatMessageTime(isoString) {
  if (!isoString) return '';
  try {
    const d = new Date(isoString);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

export default function CustomerPortal() {
  const dispatch = useDispatch();
  const {
    customerId,
    customerProfile,
    conversationId,
    conversationStatus,
    messages,
    isSessionActive,
    newlyGeneratedCustomerId,
    showOneTimeIdModal,
    registerStatus,
    registerError,
    isDuplicateEmail,
    loginStatus,
    loginError,
    sendMessageStatus,
    sendMessageError,
  } = useSelector((state) => state.customer);

  // Registration Form State
  const [customerName, setCustomerName] = useState('');
  const [email, setEmail] = useState('');
  const [externalCustomerId, setExternalCustomerId] = useState('');
  const [formValidationError, setFormValidationError] = useState(null);

  // Existing Customer ID Login Form State
  const [existingIdInput, setExistingIdInput] = useState('');
  const [loginValidationError, setLoginValidationError] = useState(null);

  // Copy feedback for one-time modal
  const [copiedId, setCopiedId] = useState(false);

  // Message Composer State (preserved if sending fails)
  const [draftMessage, setDraftMessage] = useState('');
  const [pendingMessagePreview, setPendingMessagePreview] = useState(null);

  const existingIdInputRef = useRef(null);
  const messagesEndRef = useRef(null);

  // Restore active conversation on page reload if both customerId and conversationId exist in localStorage
  useEffect(() => {
    const savedCustId = localStorage.getItem(STORAGE_KEYS.CUSTOMER_ID);
    const savedConvId = localStorage.getItem(STORAGE_KEYS.CONVERSATION_ID);
    if (
      savedCustId &&
      savedConvId &&
      !isSessionActive &&
      !showOneTimeIdModal &&
      loginStatus === 'idle'
    ) {
      dispatch(loginAndLoadCustomerConversation(savedCustId));
    }
  }, [dispatch, isSessionActive, showOneTimeIdModal, loginStatus]);

  // Auto-scroll message history when new messages arrive
  useEffect(() => {
    if (isSessionActive && messagesEndRef.current) {
      messagesEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages.length, pendingMessagePreview, isSessionActive]);

  // Poll conversation history every 4s while session is active so company replies appear live
  useEffect(() => {
    if (!isSessionActive || !customerId) return undefined;

    const timer = setInterval(() => {
      dispatch(refreshCustomerConversation());
    }, 4000);

    return () => clearInterval(timer);
  }, [dispatch, isSessionActive, customerId]);

  const handleRegisterSubmit = async (e) => {
    e.preventDefault();
    setFormValidationError(null);
    dispatch(clearCustomerErrors());

    const trimmedName = customerName.trim();
    const trimmedEmail = email.trim();

    if (!trimmedName) {
      setFormValidationError('Please enter your full name.');
      return;
    }

    if (!trimmedEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)) {
      setFormValidationError('Please provide a valid email address.');
      return;
    }

    const resultAction = await dispatch(
      registerNewCustomer({
        customerName: trimmedName,
        email: trimmedEmail,
        externalCustomerId: externalCustomerId.trim(),
      })
    );

    if (registerNewCustomer.fulfilled.match(resultAction)) {
      setCustomerName('');
      setEmail('');
      setExternalCustomerId('');
      setCopiedId(false);
    }
  };

  const handleCopyOneTimeId = async () => {
    if (!newlyGeneratedCustomerId) return;
    try {
      await navigator.clipboard.writeText(newlyGeneratedCustomerId);
      setCopiedId(true);
      setTimeout(() => setCopiedId(false), 2500);
    } catch {
      // Fallback copy
      const textArea = document.createElement('textarea');
      textArea.value = newlyGeneratedCustomerId;
      document.body.appendChild(textArea);
      textArea.select();
      document.execCommand('copy');
      document.body.removeChild(textArea);
      setCopiedId(true);
    }
  };

  const handleContinueFromOneTimeModal = async () => {
    const idToUse = newlyGeneratedCustomerId || customerId;
    dispatch(dismissOneTimeIdModal());
    if (idToUse) {
      await dispatch(loginAndLoadCustomerConversation(idToUse));
    }
  };

  const handleExistingLoginSubmit = async (e) => {
    e.preventDefault();
    setLoginValidationError(null);
    dispatch(clearCustomerErrors());

    const trimmed = existingIdInput.trim();
    if (!trimmed) {
      setLoginValidationError(
        'Please enter your saved Customer ID to continue.'
      );
      return;
    }

    const uuidPattern =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    if (!uuidPattern.test(trimmed)) {
      setLoginValidationError(
        'Customer ID must be a valid UUID (e.g., xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx).'
      );
      return;
    }

    await dispatch(loginAndLoadCustomerConversation(trimmed));
  };

  const handleContinueWithStoredBrowserId = async () => {
    setLoginValidationError(null);
    dispatch(clearCustomerErrors());
    const stored = localStorage.getItem(STORAGE_KEYS.CUSTOMER_ID);
    if (!stored) {
      setLoginValidationError(
        'No saved Customer ID was found in browser localStorage.'
      );
      return;
    }
    await dispatch(loginAndLoadCustomerConversation(stored));
  };

  const handleSendMessage = async (e) => {
    e.preventDefault();
    const text = draftMessage.trim();
    if (!text || (!conversationId && !customerId) || sendMessageStatus === 'loading') return;

    setPendingMessagePreview(text);
    const resultAction = await dispatch(
      submitCustomerMessage({
        conversationId,
        message: text,
      })
    );

    setPendingMessagePreview(null);
    if (submitCustomerMessage.fulfilled.match(resultAction)) {
      setDraftMessage('');
    }
    // If rejected, draftMessage is preserved so the customer never loses their message!
  };

  const hasSavedBrowserId = Boolean(
    typeof window !== 'undefined' &&
      localStorage.getItem(STORAGE_KEYS.CUSTOMER_ID)
  );

  return (
    <div className="customer-portal-container">
      {/* Page Banner */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          gap: '12px',
          paddingBottom: '8px',
          borderBottom: '1px solid var(--border-warm)',
        }}
      >
        <div>
          <h1
            style={{
              fontFamily: "'Plus Jakarta Sans', sans-serif",
              fontSize: '21px',
              fontWeight: 800,
              color: 'var(--text-primary)',
            }}
          >
            MaxiText Customer Support Portal
          </h1>
          <p style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>
            Register for a Customer ID or continue an existing inquiry thread
            with our support team.
          </p>
        </div>

        {isSessionActive && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <button
              type="button"
              className="btn-warm-outlined"
              onClick={() => dispatch(refreshCustomerConversation())}
              title="Refresh conversation messages"
            >
              <RefreshCw size={14} />
              Refresh
            </button>
            <button
              type="button"
              className="btn-warm-outlined"
              onClick={() => {
                setExistingIdInput('');
                dispatch(exitCustomerConversationView());
              }}
            >
              <LogOut size={14} />
              Switch Customer
            </button>
          </div>
        )}
      </div>

      {/* Mode 1: Registration & Existing Customer Login */}
      {!isSessionActive ? (
        <motion.div
          className="customer-auth-grid"
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.2 }}
        >
          {/* Card A: Customer Registration */}
          <div className="portal-card">
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <div
                style={{
                  width: 38,
                  height: 38,
                  borderRadius: '10px',
                  backgroundColor: 'var(--accent-lavender-bg)',
                  color: 'var(--primary-indigo)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <UserPlus size={20} />
              </div>
              <div>
                <h2 style={{ fontSize: '16.5px', fontWeight: 700 }}>
                  New Customer Registration
                </h2>
                <p style={{ fontSize: '12.5px', color: 'var(--text-secondary)' }}>
                  Create a unique Customer ID to start a support inquiry
                </p>
              </div>
            </div>

            {formValidationError && (
              <div className="alert-banner error">
                <AlertCircle size={16} style={{ flexShrink: 0, marginTop: 1 }} />
                <span>{formValidationError}</span>
              </div>
            )}

            {registerError && (
              <div
                className={`alert-banner ${
                  isDuplicateEmail ? 'warning' : 'error'
                }`}
              >
                <AlertCircle size={16} style={{ flexShrink: 0, marginTop: 1 }} />
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <span>
                    {isDuplicateEmail
                      ? 'This email address is already registered with this business. For security, existing Customer IDs are not disclosed. Please continue using your previously saved Customer ID.'
                      : registerError}
                  </span>
                  {isDuplicateEmail && (
                    <button
                      type="button"
                      className="btn-warm-outlined"
                      style={{ alignSelf: 'flex-start', padding: '5px 10px', fontSize: '12px' }}
                      onClick={() => existingIdInputRef.current?.focus()}
                    >
                      Use Existing Customer ID <ArrowRight size={13} />
                    </button>
                  )}
                </div>
              </div>
            )}

            <form
              onSubmit={handleRegisterSubmit}
              style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}
              noValidate
            >
              <div className="form-group">
                <label className="form-label" htmlFor="reg-customer-name">
                  Customer Name <span style={{ color: '#dc2626' }}>*</span>
                </label>
                <input
                  id="reg-customer-name"
                  type="text"
                  className="form-input"
                  placeholder="e.g., Jane Smith"
                  value={customerName}
                  onChange={(e) => setCustomerName(e.target.value)}
                  disabled={registerStatus === 'loading'}
                  required
                />
              </div>

              <div className="form-group">
                <label className="form-label" htmlFor="reg-customer-email">
                  Email Address <span style={{ color: '#dc2626' }}>*</span>
                </label>
                <input
                  id="reg-customer-email"
                  type="email"
                  className="form-input"
                  placeholder="e.g., jane.smith@example.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  disabled={registerStatus === 'loading'}
                  required
                />
              </div>

              <div className="form-group">
                <label className="form-label" htmlFor="reg-external-id">
                  External Customer ID{' '}
                  <span style={{ fontWeight: 400, color: 'var(--text-muted)' }}>
                    (Optional)
                  </span>
                </label>
                <input
                  id="reg-external-id"
                  type="text"
                  className="form-input"
                  placeholder="Optional reference (e.g., ACCT-1042)"
                  value={externalCustomerId}
                  onChange={(e) => setExternalCustomerId(e.target.value)}
                  disabled={registerStatus === 'loading'}
                />
              </div>

              <button
                type="submit"
                className="btn-primary-indigo"
                disabled={registerStatus === 'loading'}
                style={{ marginTop: '4px' }}
              >
                {registerStatus === 'loading' ? (
                  <>
                    <Loader2 size={16} className="spin" />
                    Creating Customer ID...
                  </>
                ) : (
                  <>
                    <UserPlus size={16} />
                    Create Customer ID
                  </>
                )}
              </button>
            </form>
          </div>

          {/* Card B: Continue with Existing Customer ID */}
          <div className="portal-card">
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <div
                style={{
                  width: 38,
                  height: 38,
                  borderRadius: '10px',
                  backgroundColor: 'var(--bg-button-warm)',
                  border: '1px solid var(--border-warm-strong)',
                  color: 'var(--text-primary)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <KeyRound size={19} />
              </div>
              <div>
                <h2 style={{ fontSize: '16.5px', fontWeight: 700 }}>
                  Continue with Existing Customer ID
                </h2>
                <p style={{ fontSize: '12.5px', color: 'var(--text-secondary)' }}>
                  Enter your saved Customer ID to view and resume your conversation
                </p>
              </div>
            </div>

            {loginValidationError && (
              <div className="alert-banner error">
                <AlertCircle size={16} style={{ flexShrink: 0, marginTop: 1 }} />
                <span>{loginValidationError}</span>
              </div>
            )}

            {loginError && (
              <div className="alert-banner error">
                <AlertCircle size={16} style={{ flexShrink: 0, marginTop: 1 }} />
                <span>{loginError}</span>
              </div>
            )}

            <form
              onSubmit={handleExistingLoginSubmit}
              style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}
              noValidate
            >
              <div className="form-group">
                <label className="form-label" htmlFor="login-customer-id">
                  Your Saved Customer ID <span style={{ color: '#dc2626' }}>*</span>
                </label>
                <input
                  ref={existingIdInputRef}
                  id="login-customer-id"
                  type="text"
                  className="form-input"
                  placeholder="Paste your Customer UUID..."
                  value={existingIdInput}
                  onChange={(e) => setExistingIdInput(e.target.value)}
                  disabled={loginStatus === 'loading'}
                />
              </div>

              <button
                type="submit"
                className="btn-primary-indigo"
                disabled={loginStatus === 'loading'}
              >
                {loginStatus === 'loading' ? (
                  <>
                    <Loader2 size={16} />
                    Verifying &amp; Loading History...
                  </>
                ) : (
                  <>
                    Continue with Customer ID
                    <ArrowRight size={16} />
                  </>
                )}
              </button>
            </form>

            {hasSavedBrowserId && (
              <div
                style={{
                  marginTop: '6px',
                  paddingTop: '14px',
                  borderTop: '1px solid var(--border-warm)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '8px',
                }}
              >
                <div style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
                  A previously saved Customer session was detected in this browser
                  {customerProfile?.customer_name
                    ? ` (${customerProfile.customer_name})`
                    : ''}
                  :
                </div>
                <button
                  type="button"
                  className="btn-warm-outlined"
                  disabled={loginStatus === 'loading'}
                  onClick={handleContinueWithStoredBrowserId}
                >
                  <CheckCircle2 size={15} color="var(--status-success)" />
                  Resume Saved Browser Session
                </button>
              </div>
            )}
          </div>
        </motion.div>
      ) : (
        /* Mode 2: Active Customer Conversation Interface */
        <motion.div
          className="inquiry-main-card"
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.22 }}
          style={{ minHeight: '560px', maxHeight: 'calc(100vh - 200px)' }}
        >
          {/* Conversation Header */}
          <div className="thread-header">
            <div className="thread-customer-info">
              <div className="avatar-circle">
                <User size={18} />
              </div>
              <div>
                <div className="thread-customer-name">
                  {customerProfile?.customer_name || 'Verified Customer'}
                </div>
                <div className="thread-customer-sub">
                  {customerProfile?.email
                    ? `${customerProfile.email} · `
                    : ''}
                  Connected to MaxiText Support
                </div>
              </div>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <span
                style={{
                  padding: '3px 10px',
                  borderRadius: '999px',
                  fontSize: '11.5px',
                  fontWeight: 700,
                  backgroundColor:
                    conversationStatus === 'open'
                      ? 'var(--status-success-bg)'
                      : 'var(--status-error-bg)',
                  color:
                    conversationStatus === 'open'
                      ? 'var(--status-success)'
                      : 'var(--status-error)',
                  textTransform: 'uppercase',
                }}
              >
                {conversationStatus || 'open'}
              </span>
            </div>
          </div>

          {/* Messages Scroll Area */}
          <div className="thread-messages-scroll">
            {messages.length === 0 && !pendingMessagePreview ? (
              <div
                style={{
                  margin: 'auto',
                  textAlign: 'center',
                  maxWidth: '420px',
                  padding: '32px 16px',
                  color: 'var(--text-secondary)',
                }}
              >
                <div
                  style={{
                    width: 48,
                    height: 48,
                    borderRadius: '50%',
                    backgroundColor: 'var(--accent-lavender-bg)',
                    color: 'var(--primary-indigo)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    margin: '0 auto 12px auto',
                  }}
                >
                  <MessageCircle size={24} />
                </div>
                <h3
                  style={{
                    fontSize: '15.5px',
                    fontWeight: 700,
                    color: 'var(--text-primary)',
                    marginBottom: '6px',
                  }}
                >
                  Start Your Support Inquiry
                </h3>
                <p style={{ fontSize: '13px' }}>
                  Send a message below to reach our support team. Your conversation
                  history will be saved automatically.
                </p>
              </div>
            ) : (
              messages.map((msg) => {
                const isCustomer = msg.sender_type === 'customer';
                return (
                  <motion.div
                    key={msg.id}
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.16 }}
                    className={`msg-row ${isCustomer ? 'agent' : 'customer'}`}
                  >
                    <div className="avatar-circle small">
                      {isCustomer ? <User size={14} /> : <Headphones size={14} />}
                    </div>
                    <div className="msg-bubble">
                      <div
                        style={{
                          fontSize: '11px',
                          fontWeight: 700,
                          marginBottom: 3,
                          opacity: 0.85,
                        }}
                      >
                        {isCustomer
                          ? customerProfile?.customer_name || 'You'
                          : 'MaxiText Support Team'}
                      </div>
                      <div>{msg.content}</div>
                      <span className="msg-timestamp">
                        {formatMessageTime(msg.created_at)}
                      </span>
                    </div>
                  </motion.div>
                );
              })
            )}

            {/* Pending Message State while submitting */}
            {pendingMessagePreview && (
              <div className="msg-row agent" style={{ opacity: 0.65 }}>
                <div className="avatar-circle small">
                  <User size={14} />
                </div>
                <div className="msg-bubble">
                  <div>{pendingMessagePreview}</div>
                  <span className="msg-timestamp">Sending message...</span>
                </div>
              </div>
            )}

            <div ref={messagesEndRef} />
          </div>

          {/* Error Banner if sending failed (draft preserved) */}
          {sendMessageError && (
            <div style={{ padding: '0 16px 8px 16px', backgroundColor: 'var(--bg-panel)' }}>
              <div className="alert-banner error">
                <AlertCircle size={16} style={{ flexShrink: 0, marginTop: 1 }} />
                <span>
                  {sendMessageError} Your message draft has been preserved below so
                  you can retry.
                </span>
              </div>
            </div>
          )}

          {/* Customer Message Input Composer */}
          <form className="thread-composer-bar" onSubmit={handleSendMessage}>
            <div className="composer-input-wrap">
              <MessageCircle size={17} color="var(--text-muted)" />
              <input
                type="text"
                className="composer-input"
                placeholder={
                  conversationStatus === 'closed'
                    ? 'This conversation is closed.'
                    : 'Type your inquiry message...'
                }
                value={draftMessage}
                onChange={(e) => setDraftMessage(e.target.value)}
                disabled={
                  sendMessageStatus === 'loading' ||
                  conversationStatus === 'closed'
                }
              />
            </div>

            <button
              type="submit"
              className="composer-send-btn"
              disabled={
                !draftMessage.trim() ||
                sendMessageStatus === 'loading' ||
                conversationStatus === 'closed'
              }
              title="Send message"
            >
              <Send size={17} />
            </button>
          </form>
        </motion.div>
      )}

      {/* One-Time Customer ID Reveal Modal */}
      <AnimatePresence>
        {showOneTimeIdModal && newlyGeneratedCustomerId && (
          <motion.div
            className="modal-backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          >
            <motion.div
              className="modal-card"
              initial={{ opacity: 0, scale: 0.94, y: 12 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.94, y: 12 }}
              transition={{ duration: 0.2 }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                <div
                  style={{
                    width: 42,
                    height: 42,
                    borderRadius: '10px',
                    backgroundColor: 'var(--status-warning-bg)',
                    color: 'var(--status-warning)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    flexShrink: 0,
                  }}
                >
                  <ShieldAlert size={22} />
                </div>
                <div>
                  <h3 style={{ fontSize: '17px', fontWeight: 800 }}>
                    Save Your Customer ID Now
                  </h3>
                  <p style={{ fontSize: '12.5px', color: 'var(--text-secondary)' }}>
                    One-time security reveal for{' '}
                    <strong>{customerProfile?.customer_name}</strong>
                  </p>
                </div>
              </div>

              <div className="alert-banner warning">
                <AlertCircle size={17} style={{ flexShrink: 0, marginTop: 1 }} />
                <div>
                  <strong>Important — Shown Only Once:</strong> This Customer ID will{' '}
                  <u>only be revealed once</u> and must be saved. Once you close
                  this popup, the ID will never be displayed again.
                </div>
              </div>

              <div className="form-group">
                <label className="form-label">Your Unique Customer ID</label>
                <div className="id-display-box">
                  <span data-testid="one-time-customer-id">
                    {newlyGeneratedCustomerId}
                  </span>
                  <button
                    type="button"
                    className="btn-warm-outlined"
                    onClick={handleCopyOneTimeId}
                    style={{ padding: '6px 12px', fontSize: '12px', flexShrink: 0 }}
                  >
                    {copiedId ? (
                      <>
                        <Check size={14} color="var(--status-success)" />
                        Copied!
                      </>
                    ) : (
                      <>
                        <Copy size={14} />
                        Copy ID
                      </>
                    )}
                  </button>
                </div>
              </div>

              <p style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
                We have also stored this ID in your browser&apos;s{' '}
                <code>localStorage</code> for convenience on this device. Please
                copy it to a safe place if you need to sign in later.
              </p>

              <button
                type="button"
                className="btn-primary-indigo"
                onClick={handleContinueFromOneTimeModal}
                style={{ width: '100%', padding: '11px 18px' }}
              >
                I Have Saved My Customer ID — Continue to Conversation
                <ArrowRight size={16} />
              </button>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
