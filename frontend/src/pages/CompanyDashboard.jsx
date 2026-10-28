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
} from 'lucide-react';
import {
  loadCompanyConversations,
  selectAndLoadConversation,
  submitCompanyReply,
  setActiveConversationImmediate,
  updateAiSuggestionDraft,
  resetAiSuggestionDraftToOriginal,
  clearCompanyReplyError,
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
  } = useSelector((state) => state.company);

  // Top Tab Navigation State ('inquiry' | 'sheets')
  const [activeTab, setActiveTab] = useState('inquiry');

  // Inbox filter state (All vs Unread Only)
  const [filterUnreadOnly, setFilterUnreadOnly] = useState(false);

  // Bottom reply composer state (preserved on error)
  const [replyInput, setReplyInput] = useState('');

  // Announcement Prototype Placeholder State
  const [announcementTarget, setAnnouncementTarget] = useState('some');
  const [announcementPrompt, setAnnouncementPrompt] = useState(
    'Write an announcement reminding everyone about our upcoming holiday hours on Friday, asking them to send queries before 3 PM.'
  );
  const [announcementFeedback, setAnnouncementFeedback] = useState(null);
  const [showAnnouncementHistoryModal, setShowAnnouncementHistoryModal] =
    useState(false);
  const [callPlaceholderNotice, setCallPlaceholderNotice] = useState(null);

  const threadEndRef = useRef(null);
  const replyInputRef = useRef(null);

  // Initial load + periodic background polling for new customer inquiries
  useEffect(() => {
    dispatch(loadCompanyConversations({ silent: false }));

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
    // If failed, replyInput stays intact so the agent can retry!
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

  const handlePlaceholderAnnouncementSend = () => {
    setAnnouncementFeedback(
      `Prototype Placeholder (${
        announcementTarget === 'all' ? 'All Customers' : 'Some Customers'
      }): Bulk announcement composer is a visual demonstration in this workspace pass. No live emails were dispatched.`
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

  // Build dynamic preview text for the Announcement Box prototype
  const computedAnnouncementPreview = announcementPrompt.trim()
    ? announcementPrompt.toLowerCase().includes('holiday') ||
      announcementPrompt.toLowerCase().includes('friday')
      ? '🗓️ Holiday Notice: We are closing early this Friday at 3 PM! Please submit any urgent requests...'
      : `📣 Draft Preview (${
          announcementTarget === 'all' ? 'All Customers' : 'Selected Segment'
        }): ${announcementPrompt.slice(0, 125)}${
          announcementPrompt.length > 125 ? '...' : ''
        }`
    : 'Enter a natural-language campaign prompt above to preview the AI-generated announcement.';

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
          <span
            className="beta-pill"
            style={{ padding: '1px 7px', fontSize: '9.5px' }}
          >
            DEMO
          </span>
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
                onClick={() => setShowAnnouncementHistoryModal(true)}
              >
                <Megaphone size={14} />
                Announcement History
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
                          <Loader2 size={14} />
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
                  {/* Allow reloading the most recent historical suggestion if one exists */}
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

            {/* 2. Announcement Box (Wireframe Match — Prototype Placeholder) */}
            <div className="announcement-section">
              <div className="announcement-title-row">
                <div className="announcement-heading">
                  <Megaphone size={15} color="#dc2626" />
                  <span>Announcement Box</span>
                </div>
                <span
                  className="beta-pill"
                  style={{ fontSize: '9.5px', padding: '2px 7px' }}
                >
                  PROTOTYPE
                </span>
              </div>

              <div className="form-group">
                <span
                  style={{
                    fontSize: '12.5px',
                    color: 'var(--text-secondary)',
                    fontWeight: 500,
                  }}
                >
                  Target
                </span>
                <div className="target-toggle-group">
                  <button
                    type="button"
                    className={`target-toggle-btn ${
                      announcementTarget === 'some' ? 'active' : ''
                    }`}
                    onClick={() => {
                      setAnnouncementTarget('some');
                      setAnnouncementFeedback(null);
                    }}
                  >
                    Some Customers
                  </button>
                  <button
                    type="button"
                    className={`target-toggle-btn ${
                      announcementTarget === 'all' ? 'active' : ''
                    }`}
                    onClick={() => {
                      setAnnouncementTarget('all');
                      setAnnouncementFeedback(null);
                    }}
                  >
                    All Customers
                  </button>
                </div>
              </div>

              <div className="form-group">
                <label
                  className="copilot-field-label"
                  htmlFor="bulk-announcement-prompt"
                >
                  Bulk Announcement Prompt (NL)
                </label>
                <textarea
                  id="bulk-announcement-prompt"
                  className="announcement-prompt-textarea"
                  value={announcementPrompt}
                  onChange={(e) => {
                    setAnnouncementPrompt(e.target.value);
                    setAnnouncementFeedback(null);
                  }}
                  placeholder="Describe the announcement campaign in natural language..."
                />
              </div>

              <div className="form-group">
                <span className="copilot-field-label">
                  AI-Generated Preview
                </span>
                <div className="announcement-preview-box">
                  {computedAnnouncementPreview}
                </div>
              </div>

              {announcementFeedback && (
                <div className="alert-banner info" style={{ fontSize: '12px' }}>
                  <CheckCircle2 size={15} style={{ flexShrink: 0, marginTop: 1 }} />
                  <span>{announcementFeedback}</span>
                </div>
              )}

              <button
                type="button"
                className="btn-primary-indigo"
                style={{ width: '100%', padding: '10px 16px' }}
                onClick={handlePlaceholderAnnouncementSend}
              >
                <Rocket size={15} />
                Send Announcement
              </button>
            </div>
          </aside>
        </motion.main>
      )}

      {/* Announcement History Prototype Modal */}
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
                  <span className="beta-pill">PROTOTYPE</span>
                </div>
                <button
                  type="button"
                  className="icon-action-btn"
                  onClick={() => setShowAnnouncementHistoryModal(false)}
                >
                  <X size={18} />
                </button>
              </div>

              <div className="alert-banner info">
                <AlertCircle size={16} style={{ flexShrink: 0, marginTop: 1 }} />
                <span>
                  Announcement history is a visual placeholder in this prototype
                  pass. Sample campaign previews are shown below.
                </span>
              </div>

              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '10px',
                }}
              >
                <div
                  style={{
                    padding: '12px',
                    borderRadius: '8px',
                    backgroundColor: 'var(--bg-subtle-warm)',
                    border: '1px solid var(--border-warm)',
                  }}
                >
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      fontWeight: 700,
                      fontSize: '13px',
                    }}
                  >
                    <span>🗓️ Holiday Notice: Friday Early Closing</span>
                    <span style={{ color: 'var(--primary-indigo)', fontSize: '11.5px' }}>
                      DEMO PREVIEW
                    </span>
                  </div>
                  <p
                    style={{
                      fontSize: '12px',
                      color: 'var(--text-secondary)',
                      marginTop: 4,
                    }}
                  >
                    Target: Some Customers · &ldquo;We are closing early this Friday
                    at 3 PM! Please submit any urgent requests...&rdquo;
                  </p>
                </div>
              </div>

              <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                <button
                  type="button"
                  className="btn-warm-outlined"
                  onClick={() => setShowAnnouncementHistoryModal(false)}
                >
                  Close Preview
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
