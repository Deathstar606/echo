import React, { useEffect, useRef, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { AnimatePresence, motion } from 'framer-motion';
import {
  Download,
  BarChart3,
  Megaphone,
  Mail,
  SquarePen,
  Phone,
  Video,
  MessageCircle,
  Send,
  Sparkles,
  Rocket,
  User,
  RefreshCw,
  CheckCircle2,
  AlertCircle,
  RotateCcw,
  CornerDownLeft,
  X,
  Inbox,
  Loader2,
  Users,
  Calendar,
  AlertTriangle,
} from 'lucide-react';
import {
  loadCompanyConversations,
  selectAndLoadConversation,
  submitCompanyReply,
  setActiveConversationImmediate,
  updateAiSuggestionDraft,
  resetAiSuggestionDraftToOriginal,
  clearCompanyReplyError,
  loadAnnouncementHistory,
  createAnnouncementDraft,
  confirmAndSendAnnouncement,
  updateAnnouncementDraftFields,
  clearAnnouncementDraft,
  clearAnnouncementSendResult,
} from '../store/companySlice';
import SheetManagementPanel from '../components/SheetManagementPanel';

function formatInboxTime(isoString) {
  if (!isoString) return '';
  try {
    const d = new Date(isoString);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

function formatDateTime(isoString) {
  if (!isoString) return '—';
  try {
    const d = new Date(isoString);
    return d.toLocaleString([], {
      year: 'numeric',
      month: 'short',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return String(isoString);
  }
}

const SAMPLE_ANNOUNCEMENT_PROMPTS = [
  {
    label: 'All Users (25% Off Seasonal Collection)',
    text: 'Send an announcement about a 25% discount on our seasonal collection to all users.',
  },
  {
    label: 'Registered After 2026-01-01',
    text: 'Send an announcement about up to 45% off our luxury polo and shirt collection to users who registered after 2026-01-01.',
  },
];

export default function CompanyDashboard() {
  const dispatch = useDispatch();
  const {
    conversations,
    activeConversationId,
    activeConversation,
    aiSuggestionDraft,
    aiSuggestionMeta,
    isSuggestionEdited,
    inboxStatus,
    inboxError,
    threadStatus,
    threadError,
    sendReplyStatus,
    sendReplyError,
    announcementHistory,
    announcementHistoryStatus,
    announcementHistoryError,
    announcementDraft,
    announcementDraftStatus,
    announcementDraftError,
    announcementSendStatus,
    announcementSendError,
    announcementSendResult,
  } = useSelector((state) => state.company);

  // Top Tab Navigation State ('inquiry' | 'sheets')
  const [activeTab, setActiveTab] = useState('inquiry');

  // Inbox filter state (All vs Unread Only)
  const [filterUnreadOnly, setFilterUnreadOnly] = useState(false);

  // Bottom reply composer state (preserved on error)
  const [replyInput, setReplyInput] = useState('');

  // Natural-Language Announcement Prompt State (No manual Some/All toggle)
  const [announcementPrompt, setAnnouncementPrompt] = useState(
    'Send an announcement about up to 45% off our luxury polo and shirt collection to users who registered after 2026-01-01.'
  );
  const [showAnnouncementHistoryModal, setShowAnnouncementHistoryModal] =
    useState(false);
  const [callPlaceholderNotice, setCallPlaceholderNotice] = useState(null);

  const threadEndRef = useRef(null);
  const replyInputRef = useRef(null);

  // Initial load + periodic background polling for new customer inquiries
  useEffect(() => {
    dispatch(loadCompanyConversations({ silent: false }));
    dispatch(loadAnnouncementHistory());

    const interval = setInterval(() => {
      dispatch(loadCompanyConversations({ silent: true }));
    }, 4000);

    return () => clearInterval(interval);
  }, [dispatch]);

  // Scroll to bottom when conversation changes or new messages arrive
  useEffect(() => {
    if (activeTab === 'inquiry' && threadEndRef.current) {
      threadEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [
    activeConversationId,
    activeConversation?.messages?.length,
    activeTab,
  ]);

  const handleSelectConversation = (convId) => {
    dispatch(setActiveConversationImmediate(convId));
    dispatch(selectAndLoadConversation(convId));
  };

  // Send reply from bottom composer bar
  const handleBottomReplySubmit = async (e) => {
    e.preventDefault();
    const text = replyInput.trim();
    if (!text || !activeConversationId || sendReplyStatus === 'loading') return;

    dispatch(clearCompanyReplyError());
    const resultAction = await dispatch(
      submitCompanyReply({
        conversationId: activeConversationId,
        message: text,
      })
    );

    if (submitCompanyReply.fulfilled.match(resultAction)) {
      setReplyInput('');
    }
  };

  // Send approved (or edited) AI suggestion directly from Copilot panel
  const handleSendApprovedAiSuggestion = async () => {
    const text = aiSuggestionDraft.trim();
    if (!text || !activeConversationId || sendReplyStatus === 'loading') return;

    dispatch(clearCompanyReplyError());
    await dispatch(
      submitCompanyReply({
        conversationId: activeConversationId,
        message: text,
      })
    );
  };

  // Load AI suggestion into bottom reply bar for manual editing
  const handleCopySuggestionToComposer = () => {
    if (!aiSuggestionDraft.trim()) return;
    setReplyInput(aiSuggestionDraft);
    replyInputRef.current?.focus();
  };

  // Open Announcement History modal and fetch fresh history from backend
  const handleOpenAnnouncementHistory = () => {
    setShowAnnouncementHistoryModal(true);
    dispatch(loadAnnouncementHistory());
  };

  // Generate AI Announcement Draft & Interpret Natural-Language Audience Criteria
  const handleDraftAnnouncement = async (e) => {
    if (e) e.preventDefault();
    const text = announcementPrompt.trim();
    if (!text || announcementDraftStatus === 'loading') return;

    dispatch(clearAnnouncementSendResult());
    await dispatch(createAnnouncementDraft(text));
  };

  // Confirm & Send Announcement Campaign ({ confirm: true })
  const handleConfirmSendAnnouncement = async () => {
    if (
      !announcementDraft ||
      !announcementDraft.id ||
      announcementDraft.status === 'clarification_needed' ||
      announcementDraft.clarification_needed ||
      announcementSendStatus === 'loading'
    ) {
      return;
    }

    await dispatch(
      confirmAndSendAnnouncement({
        announcementId: announcementDraft.id,
        subject: announcementDraft.subject,
        body: announcementDraft.body,
      })
    );
  };

  const displayedConversations = filterUnreadOnly
    ? conversations.filter((c) => (c.unread_count || 0) > 0)
    : conversations;

  const activeCustomerName =
    activeConversation?.customer_name ||
    activeConversation?.customer?.customer_name ||
    (activeConversation ? 'Unnamed Customer' : '');

  const activeCustomerEmail =
    activeConversation?.customer_email ||
    activeConversation?.customer?.email ||
    '';

  const activeMessages = Array.isArray(activeConversation?.messages)
    ? activeConversation.messages
    : [];

  const isClarificationNeeded =
    announcementDraft?.status === 'clarification_needed' ||
    Boolean(announcementDraft?.clarification_needed);

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
      {/* Top Navigation Tabs (Matches Wireframe: 1. [Active] Customer Inquiry | 2. Sheet Management) */}
      <div className="workspace-nav-bar">
        <button
          type="button"
          className={`workspace-tab-btn ${
            activeTab === 'inquiry' ? 'active' : ''
          }`}
          onClick={() => setActiveTab('inquiry')}
        >
          <span>
            1. {activeTab === 'inquiry' ? '[Active] ' : ''}
          </span>
          <Download size={15} color="var(--primary-indigo)" />
          <span>Customer Inquiry</span>
        </button>

        <button
          type="button"
          className={`workspace-tab-btn ${
            activeTab === 'sheets' ? 'active' : ''
          }`}
          onClick={() => setActiveTab('sheets')}
        >
          <span>
            2. {activeTab === 'sheets' ? '[Active] ' : ''}
          </span>
          <BarChart3 size={15} color="#16a34a" />
          <span>Sheet Management</span>
        </button>
      </div>

      {/* Tab Content */}
      {activeTab === 'sheets' ? (
        <SheetManagementPanel />
      ) : (
        <motion.main
          className="company-workspace-main"
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.2 }}
        >
          {/* Left & Center Card: Customer Inquiry Panel */}
          <section className="inquiry-main-card">
            <div className="inquiry-card-header">
              <h1 className="inquiry-card-title">Customer Inquiry Panel</h1>

              <button
                type="button"
                className="btn-warm-outlined"
                onClick={handleOpenAnnouncementHistory}
              >
                <Megaphone size={14} />
                Announcement History
                {announcementHistory.length > 0 && (
                  <span
                    style={{
                      marginLeft: 4,
                      padding: '1px 6px',
                      borderRadius: '999px',
                      backgroundColor: 'var(--accent-lavender-bg)',
                      color: 'var(--primary-indigo-dark)',
                      fontSize: '11px',
                      fontWeight: 700,
                    }}
                  >
                    {announcementHistory.length}
                  </span>
                )}
              </button>
            </div>

            <div className="inquiry-split-body">
              {/* Left Sub-Column: Inbox */}
              <aside className="inbox-column">
                <div className="inbox-header">
                  <span className="inbox-header-title">
                    Inbox{' '}
                    {conversations.length > 0 && (
                      <span
                        style={{
                          fontSize: '12px',
                          fontWeight: 500,
                          color: 'var(--text-secondary)',
                        }}
                      >
                        ({displayedConversations.length})
                      </span>
                    )}
                  </span>

                  <div className="inbox-header-actions">
                    <button
                      type="button"
                      className={`icon-action-btn ${
                        filterUnreadOnly ? 'active' : ''
                      }`}
                      onClick={() => setFilterUnreadOnly((prev) => !prev)}
                      title={
                        filterUnreadOnly
                          ? 'Showing unread conversations only (click to show all)'
                          : 'Filter unread inquiries'
                      }
                    >
                      <Mail size={16} />
                    </button>
                    <button
                      type="button"
                      className="icon-action-btn"
                      onClick={() =>
                        dispatch(loadCompanyConversations({ silent: false }))
                      }
                      title="Refresh inbox"
                    >
                      <RefreshCw
                        size={15}
                        className={inboxStatus === 'loading' ? 'spin' : ''}
                      />
                    </button>
                    <button
                      type="button"
                      className="icon-action-btn"
                      onClick={() => replyInputRef.current?.focus()}
                      title="Focus reply composer"
                    >
                      <SquarePen size={16} />
                    </button>
                  </div>
                </div>

                {/* Inbox Conversation List */}
                <div className="inbox-list">
                  {inboxStatus === 'loading' && conversations.length === 0 ? (
                    <div
                      style={{
                        padding: '32px 16px',
                        textAlign: 'center',
                        color: 'var(--text-secondary)',
                        fontSize: '13px',
                      }}
                    >
                      Loading customer conversations...
                    </div>
                  ) : inboxError && conversations.length === 0 ? (
                    <div style={{ padding: '16px' }}>
                      <div className="alert-banner error">
                        <AlertCircle size={15} style={{ flexShrink: 0 }} />
                        <div>
                          <div>{inboxError}</div>
                          <button
                            type="button"
                            className="btn-warm-outlined"
                            style={{ marginTop: 8, padding: '4px 10px', fontSize: 12 }}
                            onClick={() =>
                              dispatch(loadCompanyConversations({ silent: false }))
                            }
                          >
                            Retry
                          </button>
                        </div>
                      </div>
                    </div>
                  ) : displayedConversations.length === 0 ? (
                    <div
                      style={{
                        padding: '36px 18px',
                        textAlign: 'center',
                        color: 'var(--text-secondary)',
                      }}
                    >
                      <Inbox
                        size={28}
                        style={{ margin: '0 auto 8px auto', opacity: 0.55 }}
                      />
                      <div
                        style={{
                          fontWeight: 600,
                          color: 'var(--text-primary)',
                          marginBottom: 4,
                        }}
                      >
                        {filterUnreadOnly
                          ? 'No Unread Conversations'
                          : 'Inbox is Empty'}
                      </div>
                      <p style={{ fontSize: '12px' }}>
                        {filterUnreadOnly
                          ? 'All customer inquiries have been answered.'
                          : 'Customer inquiries submitted from the /customer panel will appear here automatically.'}
                      </p>
                    </div>
                  ) : (
                    displayedConversations.map((conv) => {
                      const isSelected = conv.id === activeConversationId;
                      const displayName =
                        conv.customer_name ||
                        conv.customer?.customer_name ||
                        'Unnamed Customer';
                      const snippet =
                        conv.latest_message_preview ||
                        conv.customer_email ||
                        'No messages yet';
                      const unread = conv.unread_count || 0;

                      return (
                        <button
                          key={conv.id}
                          type="button"
                          className={`inbox-item ${isSelected ? 'active' : ''}`}
                          onClick={() => handleSelectConversation(conv.id)}
                        >
                          <div className="avatar-circle">
                            <User size={18} />
                          </div>

                          <div className="inbox-item-content">
                            <div className="inbox-item-top">
                              <span className="inbox-customer-name">
                                {displayName}
                              </span>
                              <span className="inbox-time">
                                {formatInboxTime(conv.latest_activity_at)}
                              </span>
                            </div>

                            <div className="inbox-item-bottom">
                              <span className="inbox-snippet">{snippet}</span>
                              {unread > 0 && (
                                <span
                                  className="unread-badge"
                                  title={`${unread} unanswered customer message(s)`}
                                >
                                  {unread}
                                </span>
                              )}
                            </div>
                          </div>
                        </button>
                      );
                    })
                  )}
                </div>
              </aside>

              {/* Center Sub-Column: Active Conversation Thread */}
              <div className="thread-column">
                {!activeConversation ? (
                  <div
                    style={{
                      margin: 'auto',
                      textAlign: 'center',
                      padding: '32px',
                      color: 'var(--text-secondary)',
                    }}
                  >
                    <MessageCircle
                      size={32}
                      style={{ margin: '0 auto 10px auto', opacity: 0.5 }}
                    />
                    <div
                      style={{
                        fontSize: '15px',
                        fontWeight: 700,
                        color: 'var(--text-primary)',
                      }}
                    >
                      Select a Conversation
                    </div>
                    <p style={{ fontSize: '13px', marginTop: 4 }}>
                      Choose a customer thread from the left inbox to review
                      messages and AI-suggested responses.
                    </p>
                  </div>
                ) : (
                  <>
                    {/* Thread Header */}
                    <div className="thread-header">
                      <div className="thread-customer-info">
                        <div className="avatar-circle">
                          <User size={18} />
                        </div>
                        <div>
                          <div className="thread-customer-name">
                            {activeCustomerName}
                          </div>
                          {activeCustomerEmail && (
                            <div className="thread-customer-sub">
                              {activeCustomerEmail}
                            </div>
                          )}
                        </div>
                      </div>

                      <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                        <button
                          type="button"
                          className="icon-action-btn"
                          onClick={() =>
                            setCallPlaceholderNotice(
                              'Voice & video calling controls are visual UI placeholders in this workspace prototype.'
                            )
                          }
                          title="Voice call (UI placeholder)"
                        >
                          <Phone size={16} />
                        </button>
                        <button
                          type="button"
                          className="icon-action-btn"
                          onClick={() =>
                            setCallPlaceholderNotice(
                              'Voice & video calling controls are visual UI placeholders in this workspace prototype.'
                            )
                          }
                          title="Video call (UI placeholder)"
                        >
                          <Video size={16} />
                        </button>
                      </div>
                    </div>

                    {callPlaceholderNotice && (
                      <div
                        style={{
                          padding: '6px 14px',
                          backgroundColor: 'var(--accent-lavender-bg)',
                          borderBottom: '1px solid var(--accent-lavender-border)',
                          fontSize: '12px',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                        }}
                      >
                        <span>{callPlaceholderNotice}</span>
                        <button
                          type="button"
                          onClick={() => setCallPlaceholderNotice(null)}
                          style={{ fontWeight: 700, padding: '0 4px' }}
                        >
                          ×
                        </button>
                      </div>
                    )}

                    {threadError && (
                      <div style={{ padding: '10px 16px' }}>
                        <div className="alert-banner error">
                          <AlertCircle size={15} />
                          <span>{threadError}</span>
                        </div>
                      </div>
                    )}

                    {/* Chronological Message History */}
                    <div className="thread-messages-scroll">
                      {threadStatus === 'loading' &&
                      activeMessages.length === 0 ? (
                        <div
                          style={{
                            margin: 'auto',
                            color: 'var(--text-secondary)',
                            fontSize: '13px',
                          }}
                        >
                          Loading message history...
                        </div>
                      ) : activeMessages.length === 0 ? (
                        <div
                          style={{
                            margin: 'auto',
                            textAlign: 'center',
                            color: 'var(--text-secondary)',
                            fontSize: '13px',
                          }}
                        >
                          No messages in this conversation yet.
                        </div>
                      ) : (
                        activeMessages.map((msg) => {
                          const isCustomer = msg.sender_type === 'customer';
                          return (
                            <motion.div
                              key={msg.id}
                              initial={{ opacity: 0, y: 5 }}
                              animate={{ opacity: 1, y: 0 }}
                              transition={{ duration: 0.15 }}
                              className={`msg-row ${
                                isCustomer ? 'customer' : 'agent'
                              }`}
                            >
                              {isCustomer && (
                                <div className="avatar-circle small">
                                  <User size={14} />
                                </div>
                              )}
                              <div className="msg-bubble">
                                <div>{msg.content}</div>
                                <span className="msg-timestamp">
                                  {formatInboxTime(msg.created_at)}
                                </span>
                              </div>
                            </motion.div>
                          );
                        })
                      )}
                      <div ref={threadEndRef} />
                    </div>

                    {/* Reply Error Notice (preserves draft) */}
                    {sendReplyError && (
                      <div
                        style={{
                          padding: '0 16px 8px 16px',
                          backgroundColor: 'var(--bg-panel)',
                        }}
                      >
                        <div className="alert-banner error">
                          <AlertCircle size={15} style={{ flexShrink: 0 }} />
                          <span>{sendReplyError}</span>
                        </div>
                      </div>
                    )}

                    {/* Bottom Message Input Bar (Matches Wireframe) */}
                    <form
                      className="thread-composer-bar"
                      onSubmit={handleBottomReplySubmit}
                    >
                      <div className="composer-input-wrap">
                        <MessageCircle size={17} color="var(--text-muted)" />
                        <input
                          ref={replyInputRef}
                          type="text"
                          className="composer-input"
                          placeholder="Type a message to reply..."
                          value={replyInput}
                          onChange={(e) => setReplyInput(e.target.value)}
                          disabled={sendReplyStatus === 'loading'}
                        />
                      </div>

                      <button
                        type="submit"
                        className="composer-send-btn"
                        disabled={
                          !replyInput.trim() || sendReplyStatus === 'loading'
                        }
                        title="Send reply to customer"
                      >
                        <Send size={17} />
                      </button>
                    </form>
                  </>
                )}
              </div>
            </div>
          </section>

          {/* Right-Hand Panel: MaxiText AI Workspace Copilot */}
          <aside className="copilot-side-card">
            <div className="copilot-header">
              <div className="copilot-title">
                <Sparkles size={16} color="#d97706" />
                <span>MaxiText AI Workspace Copilot</span>
              </div>
            </div>

            {/* 1. AI Suggested Response Panel (Active Inquiry Draft) */}
            <div className="ai-suggestion-box">
              <div className="ai-suggestion-header">
                <span className="ai-badge">
                  <Sparkles size={11} />
                  AI Suggested Reply (Draft)
                </span>
                {aiSuggestionMeta?.category && (
                  <span className="ai-category-tag">
                    {aiSuggestionMeta.category.replace(/_/g, ' ')}
                  </span>
                )}
              </div>

              {!activeConversation ? (
                <div style={{ fontSize: '12.5px', color: 'var(--text-secondary)' }}>
                  Select a customer conversation in the inbox to inspect its
                  AI-generated reply suggestion.
                </div>
              ) : aiSuggestionDraft || aiSuggestionMeta ? (
                <>
                  {aiSuggestionMeta?.sourceMessageContent && (
                    <div className="ai-source-inquiry">
                      <div
                        style={{
                          fontWeight: 700,
                          fontSize: '11px',
                          color: 'var(--primary-indigo-dark)',
                          marginBottom: 2,
                        }}
                      >
                        Customer Inquiry ({activeCustomerName}):
                      </div>
                      <div>&ldquo;{aiSuggestionMeta.sourceMessageContent}&rdquo;</div>
                    </div>
                  )}

                  {Array.isArray(aiSuggestionMeta?.missingInformation) &&
                    aiSuggestionMeta.missingInformation.length > 0 && (
                      <div
                        style={{
                          fontSize: '11.5px',
                          color: 'var(--status-warning)',
                          backgroundColor: 'var(--status-warning-bg)',
                          padding: '6px 9px',
                          borderRadius: '6px',
                          border: '1px solid #fcd34d',
                        }}
                      >
                        <strong>Context Note:</strong>{' '}
                        {aiSuggestionMeta.missingInformation.join('; ')}
                      </div>
                    )}

                  <div className="form-group">
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                      }}
                    >
                      <label
                        className="form-label"
                        htmlFor="copilot-ai-draft-textarea"
                        style={{ fontSize: '12px' }}
                      >
                        Review &amp; Edit Suggested Response:
                      </label>
                      {isSuggestionEdited && (
                        <button
                          type="button"
                          onClick={() =>
                            dispatch(resetAiSuggestionDraftToOriginal())
                          }
                          style={{
                            fontSize: '11px',
                            color: 'var(--primary-indigo)',
                            fontWeight: 600,
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: 3,
                          }}
                        >
                          <RotateCcw size={11} />
                          Restore Original
                        </button>
                      )}
                    </div>

                    <textarea
                      id="copilot-ai-draft-textarea"
                      className="ai-draft-textarea"
                      value={aiSuggestionDraft}
                      onChange={(e) =>
                        dispatch(updateAiSuggestionDraft(e.target.value))
                      }
                      placeholder="Edit the AI-suggested reply or write your own..."
                      disabled={sendReplyStatus === 'loading'}
                    />
                  </div>

                  <div className="ai-suggestion-actions">
                    <button
                      type="button"
                      className="btn-primary-indigo"
                      style={{ flex: 1, padding: '8px 12px', fontSize: '12.5px' }}
                      disabled={
                        !aiSuggestionDraft.trim() ||
                        sendReplyStatus === 'loading'
                      }
                      onClick={handleSendApprovedAiSuggestion}
                    >
                      {sendReplyStatus === 'loading' ? (
                        <>
                          <Loader2 size={14} className="spin" />
                          Sending...
                        </>
                      ) : (
                        <>
                          <Send size={13} />
                          Send Approved Response
                        </>
                      )}
                    </button>

                    <button
                      type="button"
                      className="btn-warm-outlined"
                      style={{ padding: '7px 10px', fontSize: '12px' }}
                      onClick={handleCopySuggestionToComposer}
                      title="Load into bottom reply input bar"
                    >
                      <CornerDownLeft size={13} />
                      To Reply Box
                    </button>
                  </div>
                </>
              ) : (
                <div
                  style={{
                    fontSize: '12.5px',
                    color: 'var(--text-secondary)',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '6px',
                  }}
                >
                  <div>
                    No pending AI draft for this thread. When the customer sends a
                    new message, MaxiText AI Studio automatically generates a
                    context-aware draft suggestion here.
                  </div>
                  {activeMessages.some((m) => m.ai_suggestion) && (
                    <button
                      type="button"
                      className="btn-warm-outlined"
                      style={{ alignSelf: 'flex-start', fontSize: '11.5px', padding: '5px 10px' }}
                      onClick={() => {
                        const lastWithSug = [...activeMessages]
                          .reverse()
                          .find((m) => m.ai_suggestion);
                        if (lastWithSug) {
                          dispatch(
                            updateAiSuggestionDraft(lastWithSug.ai_suggestion)
                          );
                        }
                      }}
                    >
                      Load Previous AI Suggestion
                    </button>
                  )}
                </div>
              )}
            </div>

            {/* 2. Announcement Box — Natural-Language Recipient Targeting & Live Sending */}
            <div className="announcement-section">
              <div className="announcement-title-row">
                <div className="announcement-heading">
                  <Megaphone size={15} color="#dc2626" />
                  <span>Announcement Box</span>
                </div>
                <span
                  style={{
                    fontSize: '10.5px',
                    fontWeight: 700,
                    color: 'var(--primary-indigo)',
                    backgroundColor: 'var(--accent-lavender-bg)',
                    padding: '2px 8px',
                    borderRadius: '999px',
                    border: '1px solid var(--accent-lavender-border)',
                  }}
                >
                  NL AUDIENCE TARGETING
                </span>
              </div>

              <div className="form-group">
                <label
                  className="copilot-field-label"
                  htmlFor="bulk-announcement-prompt"
                >
                  Bulk Announcement Prompt (Natural-Language Content &amp; Audience)
                </label>
                <textarea
                  id="bulk-announcement-prompt"
                  className="announcement-prompt-textarea"
                  value={announcementPrompt}
                  onChange={(e) => {
                    setAnnouncementPrompt(e.target.value);
                  }}
                  disabled={
                    announcementDraftStatus === 'loading' ||
                    announcementSendStatus === 'loading'
                  }
                  placeholder='e.g. "Send an announcement about a flat 10% discount on all services to users who registered after 2026-01-01."'
                />
                <div
                  style={{
                    display: 'flex',
                    flexWrap: 'wrap',
                    gap: '5px',
                    marginTop: '4px',
                  }}
                >
                  {SAMPLE_ANNOUNCEMENT_PROMPTS.map((item) => (
                    <button
                      key={item.label}
                      type="button"
                      className="btn-warm-outlined"
                      style={{
                        fontSize: '11px',
                        padding: '3px 8px',
                      }}
                      disabled={
                        announcementDraftStatus === 'loading' ||
                        announcementSendStatus === 'loading'
                      }
                      onClick={() => {
                        setAnnouncementPrompt(item.text);
                        dispatch(clearAnnouncementDraft());
                        dispatch(clearAnnouncementSendResult());
                      }}
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
              </div>

              <button
                type="button"
                className="btn-warm-outlined"
                style={{
                  width: '100%',
                  justifyContent: 'center',
                  padding: '8px 12px',
                  fontWeight: 700,
                  borderColor: 'var(--primary-indigo)',
                  color: 'var(--primary-indigo-dark)',
                }}
                disabled={
                  !announcementPrompt.trim() ||
                  announcementDraftStatus === 'loading' ||
                  announcementSendStatus === 'loading'
                }
                onClick={handleDraftAnnouncement}
              >
                {announcementDraftStatus === 'loading' ? (
                  <>
                    <Loader2 size={14} className="spin" />
                    Interpreting Audience &amp; Drafting...
                  </>
                ) : (
                  <>
                    <Sparkles size={14} />
                    Draft &amp; Preview Target Audience
                  </>
                )}
              </button>

              {announcementDraftError && (
                <div className="alert-banner error" style={{ fontSize: '12px' }}>
                  <AlertCircle size={15} style={{ flexShrink: 0, marginTop: 1 }} />
                  <span>{announcementDraftError}</span>
                </div>
              )}

              {/* Ambiguous / Invalid Audience Clarification Alert */}
              {announcementDraft && isClarificationNeeded && (
                <div
                  className="alert-banner warning"
                  style={{
                    fontSize: '12px',
                    flexDirection: 'column',
                    alignItems: 'flex-start',
                    gap: '6px',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontWeight: 700 }}>
                    <AlertTriangle size={15} />
                    <span>Audience Clarification Required (Send Blocked)</span>
                  </div>
                  <div>{announcementDraft.message}</div>
                  <div style={{ fontSize: '11px', opacity: 0.9 }}>
                    Interpreted Criteria:{' '}
                    <strong>{announcementDraft.audience_description}</strong> ·
                    Matching Recipients: <strong>0</strong>
                  </div>
                </div>
              )}

              {/* Valid Draft & Interpreted Audience Preview */}
              {announcementDraft && !isClarificationNeeded && (
                <div
                  className="ai-suggestion-box"
                  style={{
                    padding: '12px',
                    gap: '8px',
                    backgroundColor: '#f8fafc',
                    borderColor: 'var(--accent-lavender-border)',
                  }}
                >
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      flexWrap: 'wrap',
                      gap: '6px',
                      paddingBottom: '6px',
                      borderBottom: '1px solid var(--border-warm)',
                    }}
                  >
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '6px',
                        fontSize: '12px',
                        fontWeight: 700,
                        color: 'var(--primary-indigo-dark)',
                      }}
                    >
                      <Users size={14} />
                      <span>
                        Target: {announcementDraft.audience_description}
                      </span>
                    </div>
                    <span
                      style={{
                        padding: '2px 8px',
                        borderRadius: '999px',
                        fontSize: '11px',
                        fontWeight: 700,
                        backgroundColor:
                          announcementDraft.recipient_count > 0
                            ? 'var(--status-success-bg)'
                            : 'var(--status-error-bg)',
                        color:
                          announcementDraft.recipient_count > 0
                            ? 'var(--status-success)'
                            : 'var(--status-error)',
                      }}
                    >
                      {announcementDraft.recipient_count} Recipient
                      {announcementDraft.recipient_count === 1 ? '' : 's'}
                    </span>
                  </div>

                  {Array.isArray(announcementDraft.matching_recipients_preview) &&
                    announcementDraft.matching_recipients_preview.length > 0 && (
                      <div style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>
                        <strong>Matched:</strong>{' '}
                        {announcementDraft.matching_recipients_preview
                          .map((r) => `${r.customer_name} (${r.email})`)
                          .join(', ')}
                      </div>
                    )}

                  <div className="form-group">
                    <label
                      className="form-label"
                      htmlFor="announcement-draft-subject"
                      style={{ fontSize: '11.5px' }}
                    >
                      Subject Line:
                    </label>
                    <input
                      id="announcement-draft-subject"
                      type="text"
                      className="form-input"
                      style={{ padding: '6px 10px', fontSize: '12.5px' }}
                      value={announcementDraft.subject || ''}
                      onChange={(e) =>
                        dispatch(
                          updateAnnouncementDraftFields({
                            subject: e.target.value,
                          })
                        )
                      }
                      disabled={announcementSendStatus === 'loading'}
                    />
                  </div>

                  <div className="form-group">
                    <label
                      className="form-label"
                      htmlFor="announcement-draft-body"
                      style={{ fontSize: '11.5px' }}
                    >
                      Email Body (personalized with {'{{customer_name}}'}):
                    </label>
                    <textarea
                      id="announcement-draft-body"
                      className="ai-draft-textarea"
                      style={{ minHeight: '92px', fontSize: '12px' }}
                      value={announcementDraft.body || ''}
                      onChange={(e) =>
                        dispatch(
                          updateAnnouncementDraftFields({
                            body: e.target.value,
                          })
                        )
                      }
                      disabled={announcementSendStatus === 'loading'}
                    />
                  </div>

                  {announcementSendError && (
                    <div className="alert-banner error" style={{ fontSize: '12px' }}>
                      <AlertCircle size={14} style={{ flexShrink: 0 }} />
                      <span>{announcementSendError}</span>
                    </div>
                  )}

                  <button
                    type="button"
                    className="btn-primary-indigo"
                    style={{ width: '100%', padding: '9px 14px' }}
                    disabled={
                      announcementSendStatus === 'loading' ||
                      announcementDraft.recipient_count === 0 ||
                      !announcementDraft.subject?.trim() ||
                      !announcementDraft.body?.trim()
                    }
                    onClick={handleConfirmSendAnnouncement}
                  >
                    {announcementSendStatus === 'loading' ? (
                      <>
                        <Loader2 size={15} className="spin" />
                        Sending to {announcementDraft.recipient_count} Recipient(s)...
                      </>
                    ) : (
                      <>
                        <Rocket size={15} />
                        Confirm &amp; Send to {announcementDraft.recipient_count}{' '}
                        Recipient{announcementDraft.recipient_count === 1 ? '' : 's'}
                      </>
                    )}
                  </button>
                </div>
              )}

              {/* Post-Send Delivery Summary */}
              {announcementSendResult && (
                <div
                  className={`alert-banner ${
                    announcementSendResult.failed_count > 0 ? 'warning' : 'success'
                  }`}
                  style={{
                    flexDirection: 'column',
                    alignItems: 'flex-start',
                    gap: '6px',
                    fontSize: '12px',
                  }}
                >
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      width: '100%',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontWeight: 700 }}>
                      <CheckCircle2 size={15} />
                      <span>
                        Announcement Delivery Summary ({announcementSendResult.status})
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={() => dispatch(clearAnnouncementSendResult())}
                      style={{ fontSize: '11px', fontWeight: 700 }}
                    >
                      ×
                    </button>
                  </div>

                  <div>
                    <strong>Audience:</strong>{' '}
                    {announcementSendResult.audience_description || 'Targeted recipients'}
                  </div>

                  <div style={{ display: 'flex', gap: '12px', fontWeight: 600 }}>
                    <span style={{ color: 'var(--status-success)' }}>
                      ✓ Successful Sends: {announcementSendResult.sent_count}
                    </span>
                    <span
                      style={{
                        color:
                          announcementSendResult.failed_count > 0
                            ? 'var(--status-error)'
                            : 'var(--text-secondary)',
                      }}
                    >
                      ✕ Failed Sends: {announcementSendResult.failed_count}
                    </span>
                  </div>

                  {Array.isArray(announcementSendResult.failed_recipients) &&
                    announcementSendResult.failed_recipients.length > 0 && (
                      <div
                        style={{
                          width: '100%',
                          marginTop: '4px',
                          padding: '6px 8px',
                          borderRadius: '6px',
                          backgroundColor: '#fef2f2',
                          border: '1px solid #fecaca',
                          color: '#991b1b',
                        }}
                      >
                        <div style={{ fontWeight: 700, marginBottom: '2px' }}>
                          Failed Recipients &amp; Reasons:
                        </div>
                        {announcementSendResult.failed_recipients.map((fr, idx) => (
                          <div key={fr.id || idx} style={{ fontSize: '11.5px' }}>
                            • <strong>{fr.customer_name}</strong> ({fr.email}):{' '}
                            {fr.reason || fr.error_message || 'Delivery failed'}
                          </div>
                        ))}
                      </div>
                    )}
                </div>
              )}
            </div>
          </aside>
        </motion.main>
      )}

      {/* Announcement History Modal (Live Backend Integration) */}
      <AnimatePresence>
        {showAnnouncementHistoryModal && (
          <motion.div
            className="modal-backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => setShowAnnouncementHistoryModal(false)}
          >
            <motion.div
              className="modal-card"
              style={{ maxWidth: '680px', maxHeight: '85vh', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}
              initial={{ opacity: 0, scale: 0.95, y: 10 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 10 }}
              transition={{ duration: 0.18 }}
              onClick={(e) => e.stopPropagation()}
            >
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <Megaphone size={18} color="var(--primary-indigo)" />
                  <h3 style={{ fontSize: '16px', fontWeight: 700 }}>
                    Announcement History
                  </h3>
                  <span
                    style={{
                      fontSize: '11.5px',
                      fontWeight: 600,
                      color: 'var(--text-secondary)',
                    }}
                  >
                    ({announcementHistory.length} total)
                  </span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <button
                    type="button"
                    className="icon-action-btn"
                    onClick={() => dispatch(loadAnnouncementHistory())}
                    title="Refresh announcement history"
                  >
                    <RefreshCw
                      size={15}
                      className={
                        announcementHistoryStatus === 'loading' ? 'spin' : ''
                      }
                    />
                  </button>
                  <button
                    type="button"
                    className="icon-action-btn"
                    onClick={() => setShowAnnouncementHistoryModal(false)}
                  >
                    <X size={18} />
                  </button>
                </div>
              </div>

              {announcementHistoryError && (
                <div className="alert-banner error">
                  <AlertCircle size={16} style={{ flexShrink: 0 }} />
                  <span>{announcementHistoryError}</span>
                </div>
              )}

              <div
                style={{
                  flex: 1,
                  overflowY: 'auto',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '10px',
                  paddingRight: '4px',
                }}
              >
                {announcementHistoryStatus === 'loading' &&
                announcementHistory.length === 0 ? (
                  <div
                    style={{
                      padding: '32px',
                      textAlign: 'center',
                      color: 'var(--text-secondary)',
                      fontSize: '13px',
                    }}
                  >
                    Loading announcement history...
                  </div>
                ) : announcementHistory.length === 0 ? (
                  <div
                    style={{
                      padding: '32px',
                      textAlign: 'center',
                      color: 'var(--text-secondary)',
                      fontSize: '13px',
                      backgroundColor: 'var(--bg-subtle-warm)',
                      borderRadius: '8px',
                      border: '1px solid var(--border-warm)',
                    }}
                  >
                    No announcements have been drafted or sent for this business yet.
                  </div>
                ) : (
                  announcementHistory.map((ann) => {
                    const isSent =
                      ann.status === 'sent' || ann.status === 'partially_sent';
                    return (
                      <div
                        key={ann.id}
                        style={{
                          padding: '12px 14px',
                          borderRadius: '8px',
                          backgroundColor: 'var(--bg-subtle-warm)',
                          border: '1px solid var(--border-warm)',
                          display: 'flex',
                          flexDirection: 'column',
                          gap: '6px',
                        }}
                      >
                        <div
                          style={{
                            display: 'flex',
                            justifyContent: 'space-between',
                            alignItems: 'flex-start',
                            gap: '10px',
                            flexWrap: 'wrap',
                          }}
                        >
                          <div>
                            <div
                              style={{
                                fontWeight: 700,
                                fontSize: '13.5px',
                                color: 'var(--text-primary)',
                              }}
                            >
                              {ann.subject || 'Untitled Announcement'}
                            </div>
                            <div
                              style={{
                                fontSize: '11.5px',
                                color: 'var(--text-secondary)',
                                display: 'flex',
                                alignItems: 'center',
                                gap: '8px',
                                marginTop: '2px',
                              }}
                            >
                              <span
                                style={{
                                  display: 'inline-flex',
                                  alignItems: 'center',
                                  gap: '4px',
                                }}
                              >
                                <Calendar size={11} />
                                {formatDateTime(ann.sent_at || ann.created_at)}
                              </span>
                              <span>·</span>
                              <span>
                                Audience:{' '}
                                <strong>
                                  {ann.audience_description ||
                                    'All registered customers'}
                                </strong>
                              </span>
                            </div>
                          </div>

                          <div
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              gap: '6px',
                            }}
                          >
                            {/* Recipient Count Badge beside each entry */}
                            <span
                              style={{
                                padding: '3px 9px',
                                borderRadius: '999px',
                                fontSize: '11.5px',
                                fontWeight: 700,
                                backgroundColor: isSent
                                  ? 'var(--status-success-bg)'
                                  : 'var(--accent-lavender-bg)',
                                color: isSent
                                  ? 'var(--status-success)'
                                  : 'var(--primary-indigo-dark)',
                                border: '1px solid rgba(99,102,241,0.2)',
                              }}
                            >
                              {ann.status === 'draft'
                                ? `${ann.recipient_count ?? ann.total_recipients ?? 0} Target Recipients`
                                : `${ann.sent_count ?? 0} Sent${
                                    ann.failed_count > 0
                                      ? ` (${ann.failed_count} Failed)`
                                      : ''
                                  }`}
                            </span>

                            <span
                              style={{
                                padding: '2px 7px',
                                borderRadius: '999px',
                                fontSize: '10.5px',
                                fontWeight: 700,
                                textTransform: 'uppercase',
                                backgroundColor:
                                  ann.status === 'sent'
                                    ? '#dcfce7'
                                    : ann.status === 'partially_sent'
                                      ? '#fef3c7'
                                      : ann.status === 'failed'
                                        ? '#fee2e2'
                                        : '#e0e7ff',
                                color:
                                  ann.status === 'sent'
                                    ? '#166534'
                                    : ann.status === 'partially_sent'
                                      ? '#92400e'
                                      : ann.status === 'failed'
                                        ? '#991b1b'
                                        : '#3730a3',
                              }}
                            >
                              {ann.status}
                            </span>
                          </div>
                        </div>

                        <div
                          style={{
                            fontSize: '12px',
                            color: 'var(--text-primary)',
                            whiteSpace: 'pre-wrap',
                            backgroundColor: '#ffffff',
                            padding: '8px 10px',
                            borderRadius: '6px',
                            border: '1px solid var(--border-light)',
                          }}
                        >
                          {ann.body || ann.content}
                        </div>

                        {Array.isArray(ann.failed_recipients) &&
                          ann.failed_recipients.length > 0 && (
                            <div
                              style={{
                                fontSize: '11.5px',
                                color: '#991b1b',
                                backgroundColor: '#fef2f2',
                                padding: '6px 8px',
                                borderRadius: '6px',
                                border: '1px solid #fecaca',
                              }}
                            >
                              <strong>Failed Deliveries:</strong>{' '}
                              {ann.failed_recipients
                                .map(
                                  (fr) =>
                                    `${fr.customer_name} (${fr.email}: ${fr.reason || fr.error_message})`
                                )
                                .join('; ')}
                            </div>
                          )}
                      </div>
                    );
                  })
                )}
              </div>

              <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                <button
                  type="button"
                  className="btn-warm-outlined"
                  onClick={() => setShowAnnouncementHistoryModal(false)}
                >
                  Close
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
