import React, { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
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
  Info,
} from 'lucide-react';
import {
  loadCompanyConversations,
  selectAndLoadConversation,
  generateConversationReplyDraft,
  submitCompanyReply,
  setActiveConversationImmediate,
  updateAiSuggestionDraft,
  resetAiSuggestionDraftToOriginal,
  clearCompanyReplyError,
  clearReplyGenerationError,
  setExternalAiSuggestion,
  loadAnnouncementHistory,
  createAnnouncementDraft,
  confirmAndSendAnnouncement,
  updateAnnouncementDraftFields,
  clearAnnouncementDraft,
  clearAnnouncementSendResult,
  resetCompanyWorkspaceState,
} from '../store/companySlice';
import {
  fetchGmailInboxApi,
  sendGmailReplyApi,
  generateGmailReplyDraftApi,
  getGoogleAuthUrlApi,
} from '../services/api';
import { getActiveBusinessId, getLoggedInUser } from '../config/constants';
import SheetManagementPanel from '../components/SheetManagementPanel';
import CitationBadges from '../components/CitationBadges';
import CitationInspectorModal from '../components/CitationInspectorModal';

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
    replyGenerationStatus,
    replyGenerationError,
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
  const location = useLocation();
  const navigate = useNavigate();
  const [activeTab, setActiveTab] = useState(() => {
    const t = new URLSearchParams(window.location.search).get('tab');
    return t === 'sheets' ? 'sheets' : 'inquiry';
  });
  const [currentUser, setCurrentUser] = useState(() => getLoggedInUser());
  const [activeBusinessId, setActiveBusinessId] = useState(() => getActiveBusinessId());

  // Inbox filter state (All vs Unread Only)
  const [filterUnreadOnly, setFilterUnreadOnly] = useState(false);

  // Bottom reply composer state (preserved on error)
  const [replyInput, setReplyInput] = useState('');

  // Primary Gmail Inbox Integration State
  const [inboxSource, setInboxSource] = useState('workspace'); // 'workspace' | 'gmail'
  const [gmailMessages, setGmailMessages] = useState([]);
  const [activeGmailMessage, setActiveGmailMessage] = useState(null);
  const [gmailLoading, setGmailLoading] = useState(false);
  const [gmailError, setGmailError] = useState(null);
  const [gmailSending, setGmailSending] = useState(false);
  const [gmailSendToast, setGmailSendToast] = useState(null);
  const [gmailRepliesByThread, setGmailRepliesByThread] = useState({});
  const [generatingGmailAiDraft, setGeneratingGmailAiDraft] = useState(false);

  // Natural-Language Announcement Prompt State (No manual Some/All toggle)
  const [announcementPrompt, setAnnouncementPrompt] = useState(
    'Send an announcement about up to 45% off our luxury polo and shirt collection to users who registered after 2026-01-01.'
  );
  const [showAnnouncementHistoryModal, setShowAnnouncementHistoryModal] =
    useState(false);
  const [callPlaceholderNotice, setCallPlaceholderNotice] = useState(null);
  const [activeInquiryCitation, setActiveInquiryCitation] = useState(null);

  const threadEndRef = useRef(null);
  const replyInputRef = useRef(null);

  const loadGmailInbox = async (silent = false, targetBizId = activeBusinessId) => {
    if (!targetBizId) return;
    if (!silent) setGmailLoading(true);
    setGmailError(null);
    try {
      const messages = await fetchGmailInboxApi(targetBizId);
      setGmailMessages(messages);
      if (messages.length > 0 && !activeGmailMessage) {
        handleSelectGmailMessage(messages[0], targetBizId);
      }
    } catch (err) {
      setGmailError(
        err?.message || 'Failed to load Gmail messages. Please connect Google Account.'
      );
    } finally {
      if (!silent) setGmailLoading(false);
    }
  };

  const handleSwitchToGmail = () => {
    setInboxSource('gmail');
    if (gmailMessages.length === 0) {
      loadGmailInbox(false, activeBusinessId);
    }
  };

  const handleSelectGmailMessage = async (msg, targetBizId = activeBusinessId) => {
    setActiveGmailMessage(msg);
    setGeneratingGmailAiDraft(true);
    try {
      const aiRes = await generateGmailReplyDraftApi(
        {
          messageText: msg.bodyText || msg.snippet,
          senderName: msg.fromName,
          subject: msg.subject,
        },
        targetBizId
      );

      dispatch(
        setExternalAiSuggestion({
          draftText: aiRes.draftText || '',
          meta: {
            originalSuggestion: aiRes.draftText || '',
            category: aiRes.category || 'customer_inquiry',
            missingInformation: aiRes.contextNote ? [aiRes.contextNote] : [],
            sourceMessageContent: msg.bodyText || msg.snippet,
            citations: aiRes.citations || [],
          },
        })
      );
    } catch {
      const fallback = `Hi ${msg.fromName || 'there'},\n\nThank you for reaching out. We have received your inquiry regarding "${msg.subject}". Our operations team is currently reviewing the details and will update you shortly.\n\nBest regards,\nCustomer Support Team`;
      dispatch(
        setExternalAiSuggestion({
          draftText: fallback,
          meta: {
            originalSuggestion: fallback,
            category: 'general_inquiry',
            sourceMessageContent: msg.bodyText || msg.snippet,
          },
        })
      );
    } finally {
      setGeneratingGmailAiDraft(false);
    }
  };

  const handleSendGmailReply = async (replyText) => {
    const text = (replyText || '').trim();
    if (!text || !activeGmailMessage || gmailSending || !activeBusinessId) return;

    setGmailSending(true);
    setGmailError(null);
    try {
      const subject = activeGmailMessage.subject.toLowerCase().startsWith('re:')
        ? activeGmailMessage.subject
        : `Re: ${activeGmailMessage.subject}`;

      await sendGmailReplyApi(
        {
          threadId: activeGmailMessage.threadId,
          to: activeGmailMessage.fromEmail,
          subject,
          inReplyTo: activeGmailMessage.messageId,
          references: activeGmailMessage.references || activeGmailMessage.messageId,
          bodyText: text,
          businessId: activeBusinessId,
        },
        activeBusinessId
      );

      const sentReply = {
        id: `reply-${Date.now()}`,
        content: text,
        created_at: new Date().toISOString(),
        sender_type: 'agent',
      };

      setGmailRepliesByThread((prev) => ({
        ...prev,
        [activeGmailMessage.threadId]: [
          ...(prev[activeGmailMessage.threadId] || []),
          sentReply,
        ],
      }));

      setReplyInput('');
      setGmailSendToast(`Reply successfully sent to ${activeGmailMessage.fromEmail}`);
      setTimeout(() => setGmailSendToast(null), 5000);
    } catch (err) {
      setGmailError(err?.message || 'Failed to send Gmail reply.');
    } finally {
      setGmailSending(false);
    }
  };

  // Respect ?tab=sheets query param or switchCompanyTab events (e.g., returning from Google OAuth link flow)
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const tabParam = params.get('tab');
    if (tabParam === 'sheets' || tabParam === 'inquiry') {
      setActiveTab(tabParam);
    }
  }, [location.search]);

  useEffect(() => {
    const handleSwitchTab = (e) => {
      if (e?.detail === 'sheets' || e?.detail === 'inquiry') {
        setActiveTab(e.detail);
      }
    };
    window.addEventListener('switchCompanyTab', handleSwitchTab);
    return () => window.removeEventListener('switchCompanyTab', handleSwitchTab);
  }, []);

  // Subscribe to workspace switching and auth changes
  useEffect(() => {
    const handleWorkspaceOrAuthSync = () => {
      setCurrentUser(getLoggedInUser());
      const nextBizId = getActiveBusinessId();
      setActiveBusinessId((prev) => {
        if (prev !== nextBizId) {
          dispatch(resetCompanyWorkspaceState());
          setGmailMessages([]);
          setActiveGmailMessage(null);
          setGmailError(null);
          setGmailRepliesByThread({});
          setGmailSendToast(null);
          setReplyInput('');
          setActiveInquiryCitation(null);
        }
        return nextBizId;
      });
    };

    window.addEventListener('workspaceChanged', handleWorkspaceOrAuthSync);
    window.addEventListener('authChanged', handleWorkspaceOrAuthSync);
    return () => {
      window.removeEventListener('workspaceChanged', handleWorkspaceOrAuthSync);
      window.removeEventListener('authChanged', handleWorkspaceOrAuthSync);
    };
  }, [dispatch]);

  // Initial load + periodic background polling for new customer inquiries scoped to signed-in user's activeBusinessId
  useEffect(() => {
    if (!currentUser?.id || !activeBusinessId) {
      return undefined;
    }

    dispatch(loadCompanyConversations({ silent: false, businessId: activeBusinessId }));
    dispatch(loadAnnouncementHistory(activeBusinessId));

    const interval = setInterval(() => {
      dispatch(loadCompanyConversations({ silent: true, businessId: activeBusinessId }));
    }, 4000);

    return () => {
      clearInterval(interval);
    };
  }, [dispatch, currentUser?.id, activeBusinessId]);

  // Scroll to bottom when conversation changes or new messages arrive
  useEffect(() => {
    if (activeTab === 'inquiry' && threadEndRef.current) {
      threadEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [
    activeConversationId,
    activeConversation?.messages?.length,
    activeGmailMessage?.id,
    gmailRepliesByThread,
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
    if (!text) return;

    if (inboxSource === 'gmail') {
      await handleSendGmailReply(text);
      return;
    }

    if (!activeConversationId || sendReplyStatus === 'loading') return;

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
    if (!text) return;

    if (inboxSource === 'gmail') {
      await handleSendGmailReply(text);
      return;
    }

    if (!activeConversationId || sendReplyStatus === 'loading') return;

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

  const handleGenerateCustomerReply = async () => {
    if (
      !activeConversationId ||
      !activeBusinessId ||
      replyGenerationStatus === 'loading'
    ) {
      return;
    }

    dispatch(clearReplyGenerationError());
    await dispatch(
      generateConversationReplyDraft({
        conversationId: activeConversationId,
        businessId: activeBusinessId,
      })
    );
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
    inboxSource === 'gmail'
      ? activeGmailMessage?.fromName || activeGmailMessage?.fromEmail || (activeGmailMessage ? 'Customer' : '')
      : activeConversation?.customer_name ||
        activeConversation?.customer?.customer_name ||
        (activeConversation ? 'Unnamed Customer' : '');

  const activeCustomerEmail =
    inboxSource === 'gmail'
      ? activeGmailMessage?.fromEmail || ''
      : activeConversation?.customer_email ||
        activeConversation?.customer?.email ||
        '';

  const activeMessages = Array.isArray(activeConversation?.messages)
    ? activeConversation.messages
    : [];
  const latestConversationMessage =
    activeMessages.length > 0 ? activeMessages[activeMessages.length - 1] : null;
  const canGenerateCustomerReply =
    inboxSource === 'workspace' &&
    Boolean(activeConversation) &&
    activeConversation?.status === 'open' &&
    latestConversationMessage?.sender_type === 'customer';

  const isClarificationNeeded =
    announcementDraft?.status === 'clarification_needed' ||
    Boolean(announcementDraft?.clarification_needed);

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', width: '100%', minWidth: 0 }}>
      {/* Top Navigation Tabs (Matches Wireframe: 1. [Active] Customer Inquiry | 2. Sheet Management) */}
      <div className="workspace-nav-bar">
        <button
          type="button"
          className={`workspace-tab-btn ${
            activeTab === 'inquiry' ? 'active' : ''
          }`}
          onClick={() => setActiveTab('inquiry')}
        >
          {activeTab === 'inquiry' && (
            <motion.div
              layoutId="active-workspace-tab-indicator"
              className="liquid-glass-tab-slider-indigo"
              transition={{
                type: 'spring',
                stiffness: 420,
                damping: 32,
              }}
            />
          )}
          <span className="workspace-tab-label">
            <span>
              1. {activeTab === 'inquiry' ? '[Active] ' : ''}
            </span>
            <Download size={15} color="var(--primary-indigo)" />
            <span>Customer Inquiry</span>
          </span>
        </button>

        <button
          type="button"
          className={`workspace-tab-btn ${
            activeTab === 'sheets' ? 'active' : ''
          }`}
          onClick={() => setActiveTab('sheets')}
        >
          {activeTab === 'sheets' && (
            <motion.div
              layoutId="active-workspace-tab-indicator"
              className="liquid-glass-tab-slider-indigo"
              transition={{
                type: 'spring',
                stiffness: 420,
                damping: 32,
              }}
            />
          )}
          <span className="workspace-tab-label">
            <span>
              2. {activeTab === 'sheets' ? '[Active] ' : ''}
            </span>
            <BarChart3 size={15} color="#16a34a" />
            <span>Operations &amp; Sheet Management</span>
          </span>
        </button>
      </div>

      {/* Tab Content */}
      {!currentUser?.id ? (
        <div
          className="portal-card"
          style={{
            maxWidth: '560px',
            margin: '56px auto',
            padding: '34px 26px',
            textAlign: 'center',
            alignItems: 'center',
            gap: '14px',
            borderRadius: '14px',
          }}
        >
          <Inbox size={34} color="var(--primary-indigo)" />
          <h2 style={{ fontSize: '19px', fontWeight: 800, margin: 0 }}>
            Sign In to Access Your Workspaces
          </h2>
          <p style={{ fontSize: '13.5px', color: 'var(--text-secondary)', margin: 0, lineHeight: 1.55 }}>
            Your workspaces, spreadsheets, and customer inquiries are private to your account. Please sign in with your email and password or Google to continue.
          </p>
          <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', justifyContent: 'center', marginTop: '6px' }}>
            <button
              type="button"
              className="btn-primary-indigo"
              style={{ padding: '9px 18px', fontSize: '13px' }}
              onClick={() => navigate('/')}
            >
              Go to Sign In Page
            </button>
            <button
              type="button"
              className="btn-warm-outlined"
              style={{ padding: '9px 18px', fontSize: '13px' }}
              onClick={async () => {
                try {
                  const url = await getGoogleAuthUrlApi('');
                  window.location.href = url;
                } catch (err) {
                  setGmailError(err?.message || 'Unable to start Google Sign-In.');
                }
              }}
            >
              Continue with Google
            </button>
          </div>
        </div>
      ) : !activeBusinessId ? (
        <div
          className="portal-card"
          style={{
            maxWidth: '560px',
            margin: '48px auto',
            padding: '32px 24px',
            textAlign: 'center',
            alignItems: 'center',
            gap: '12px',
          }}
        >
          <Inbox size={32} color="var(--primary-indigo)" />
          <h2 style={{ fontSize: '18px', fontWeight: 700, margin: 0 }}>
            No Workspace Selected Yet
          </h2>
          <p style={{ fontSize: '13.5px', color: 'var(--text-secondary)', margin: 0, lineHeight: 1.5 }}>
            Your account does not have an active workspace yet. Create a new workspace to manage spreadsheets, RAG policy documents, and customer inquiries.
          </p>
          <button
            type="button"
            className="btn-primary-indigo"
            style={{ marginTop: '6px', padding: '9px 18px', fontSize: '13px' }}
            onClick={() => window.dispatchEvent(new Event('openCreateWorkspaceModal'))}
          >
            Create New Workspace
          </button>
        </div>
      ) : activeTab === 'sheets' ? (
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
                {/* Inbox Source Tabs: Workspace vs Primary Gmail Inbox */}
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '1fr 1fr',
                    gap: '4px',
                    padding: '8px 10px',
                    backgroundColor: 'var(--bg-panel)',
                    borderBottom: '1px solid var(--border-warm)',
                  }}
                >
                  <button
                    type="button"
                    onClick={() => setInboxSource('workspace')}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: '5px',
                      padding: '6px 8px',
                      borderRadius: '6px',
                      fontSize: '11.5px',
                      fontWeight: inboxSource === 'workspace' ? 700 : 500,
                      backgroundColor:
                        inboxSource === 'workspace'
                          ? 'var(--primary-indigo)'
                          : 'transparent',
                      color:
                        inboxSource === 'workspace'
                          ? '#ffffff'
                          : 'var(--text-secondary)',
                      border: 'none',
                      cursor: 'pointer',
                      transition: 'all 0.15s ease',
                    }}
                  >
                    <MessageCircle size={13} />
                    <span>Workspace</span>
                    <span
                      style={{
                        padding: '1px 5px',
                        borderRadius: '999px',
                        fontSize: '10px',
                        fontWeight: 700,
                        backgroundColor:
                          inboxSource === 'workspace'
                            ? 'rgba(255, 255, 255, 0.25)'
                            : 'var(--bg-subtle-warm)',
                        color:
                          inboxSource === 'workspace'
                            ? '#ffffff'
                            : 'var(--text-secondary)',
                      }}
                    >
                      {displayedConversations.length}
                    </span>
                  </button>

                  <button
                    type="button"
                    onClick={handleSwitchToGmail}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: '5px',
                      padding: '6px 8px',
                      borderRadius: '6px',
                      fontSize: '11.5px',
                      fontWeight: inboxSource === 'gmail' ? 700 : 500,
                      backgroundColor:
                        inboxSource === 'gmail' ? '#ea4335' : 'transparent',
                      color:
                        inboxSource === 'gmail'
                          ? '#ffffff'
                          : 'var(--text-secondary)',
                      border: 'none',
                      cursor: 'pointer',
                      transition: 'all 0.15s ease',
                    }}
                  >
                    <Mail size={13} />
                    <span>Gmail</span>
                    {gmailMessages.length > 0 && (
                      <span
                        style={{
                          padding: '1px 5px',
                          borderRadius: '999px',
                          fontSize: '10px',
                          fontWeight: 700,
                          backgroundColor:
                            inboxSource === 'gmail'
                              ? 'rgba(255, 255, 255, 0.25)'
                              : 'var(--bg-subtle-warm)',
                          color:
                            inboxSource === 'gmail'
                              ? '#ffffff'
                              : 'var(--text-secondary)',
                        }}
                      >
                        {gmailMessages.length}
                      </span>
                    )}
                  </button>
                </div>

                <div className="inbox-header">
                  <span className="inbox-header-title">
                    {inboxSource === 'gmail'
                      ? 'Primary Gmail Inbox'
                      : 'Workspace Inbox'}{' '}
                    {inboxSource === 'workspace' && conversations.length > 0 && (
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
                    {inboxSource === 'gmail' && gmailMessages.length > 0 && (
                      <span
                        style={{
                          fontSize: '12px',
                          fontWeight: 500,
                          color: 'var(--text-secondary)',
                        }}
                      >
                        ({gmailMessages.length})
                      </span>
                    )}
                  </span>

                  <div className="inbox-header-actions">
                    {inboxSource === 'workspace' && (
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
                    )}
                    <button
                      type="button"
                      className="icon-action-btn"
                      onClick={() =>
                        inboxSource === 'gmail'
                          ? loadGmailInbox(false)
                          : dispatch(loadCompanyConversations({ silent: false }))
                      }
                      title="Refresh inbox"
                    >
                      <RefreshCw
                        size={15}
                        className={
                          (inboxSource === 'gmail' ? gmailLoading : inboxStatus === 'loading')
                            ? 'spin'
                            : ''
                        }
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

                {/* Inbox List: Either Workspace Inquiries or Gmail Messages */}
                <div className="inbox-list">
                  {inboxSource === 'gmail' ? (
                    gmailLoading && gmailMessages.length === 0 ? (
                      <div
                        style={{
                          padding: '32px 16px',
                          textAlign: 'center',
                          color: 'var(--text-secondary)',
                          fontSize: '13px',
                          display: 'flex',
                          flexDirection: 'column',
                          alignItems: 'center',
                          gap: '8px',
                        }}
                      >
                        <Loader2 size={16} className="spin" />
                        <span>Loading Primary Gmail messages...</span>
                      </div>
                    ) : gmailError && gmailMessages.length === 0 ? (
                      <div style={{ padding: '16px' }}>
                        <div className="alert-banner error">
                          <AlertCircle size={15} style={{ flexShrink: 0 }} />
                          <div>
                            <div>{gmailError}</div>
                            <button
                              type="button"
                              className="btn-warm-outlined"
                              style={{ marginTop: 8, padding: '4px 10px', fontSize: 12 }}
                              onClick={() => loadGmailInbox(false)}
                            >
                              Retry
                            </button>
                          </div>
                        </div>
                      </div>
                    ) : gmailMessages.length === 0 ? (
                      <div
                        style={{
                          padding: '36px 18px',
                          textAlign: 'center',
                          color: 'var(--text-secondary)',
                        }}
                      >
                        <Mail
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
                          No Gmail Messages
                        </div>
                        <p style={{ fontSize: '12px' }}>
                          No messages found in your Primary Gmail inbox.
                        </p>
                      </div>
                    ) : (
                      gmailMessages.map((msg) => {
                        const isSelected = activeGmailMessage?.id === msg.id;
                        return (
                          <button
                            key={msg.id}
                            type="button"
                            className={`inbox-item ${isSelected ? 'active' : ''}`}
                            onClick={() => handleSelectGmailMessage(msg)}
                          >
                            <div
                              className="avatar-circle"
                              style={{ backgroundColor: '#fee2e2', color: '#b91c1c' }}
                            >
                              <Mail size={16} />
                            </div>

                            <div className="inbox-item-content">
                              <div className="inbox-item-top">
                                <span
                                  className="inbox-customer-name"
                                  style={{ maxWidth: '140px', overflow: 'hidden', textOverflow: 'ellipsis' }}
                                >
                                  {msg.fromName || msg.fromEmail}
                                </span>
                                <span className="inbox-time">
                                  {formatInboxTime(msg.date)}
                                </span>
                              </div>

                              <div
                                style={{
                                  fontSize: '12px',
                                  fontWeight: 600,
                                  color: 'var(--text-primary)',
                                  marginBottom: 2,
                                  overflow: 'hidden',
                                  textOverflow: 'ellipsis',
                                  whiteSpace: 'nowrap',
                                }}
                              >
                                {msg.subject || '(No subject)'}
                              </div>

                              <div className="inbox-item-bottom">
                                <span className="inbox-snippet">{msg.snippet}</span>
                              </div>
                            </div>
                          </button>
                        );
                      })
                    )
                  ) : inboxStatus === 'loading' && conversations.length === 0 ? (
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

              {/* Center Sub-Column: Active Conversation Thread / Gmail Thread */}
              <div className="thread-column">
                {inboxSource === 'gmail' ? (
                  !activeGmailMessage ? (
                    <div
                      style={{
                        margin: 'auto',
                        textAlign: 'center',
                        padding: '32px',
                        color: 'var(--text-secondary)',
                      }}
                    >
                      <Mail
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
                        Select a Gmail Thread
                      </div>
                      <p style={{ fontSize: '13px', marginTop: 4 }}>
                        Choose an email from the left inbox to review customer inquiries and generate context-aware AI replies.
                      </p>
                    </div>
                  ) : (
                    <>
                      {/* Gmail Thread Header */}
                      <div className="thread-header">
                        <div className="thread-customer-info">
                          <div
                            className="avatar-circle"
                            style={{ backgroundColor: '#fee2e2', color: '#b91c1c' }}
                          >
                            <Mail size={18} />
                          </div>
                          <div>
                            <div
                              className="thread-customer-name"
                              style={{ display: 'flex', alignItems: 'center', gap: '8px' }}
                            >
                              <span>{activeGmailMessage.subject || '(No Subject)'}</span>
                              <span
                                style={{
                                  fontSize: '10px',
                                  fontWeight: 700,
                                  padding: '2px 6px',
                                  borderRadius: '4px',
                                  backgroundColor: '#fee2e2',
                                  color: '#b91c1c',
                                }}
                              >
                                GMAIL PRIMARY
                              </span>
                            </div>
                            <div className="thread-customer-sub">
                              From: <strong>{activeGmailMessage.fromName}</strong> &lt;{activeGmailMessage.fromEmail}&gt; · {formatDateTime(activeGmailMessage.date)}
                            </div>
                          </div>
                        </div>
                      </div>

                      {/* Toast notification */}
                      {gmailSendToast && (
                        <div
                          style={{
                            padding: '8px 16px',
                            backgroundColor: '#f0fdf4',
                            borderBottom: '1px solid #bbf7d0',
                            color: '#15803d',
                            fontSize: '12px',
                            display: 'flex',
                            alignItems: 'center',
                            gap: '6px',
                          }}
                        >
                          <CheckCircle2 size={14} />
                          <span>{gmailSendToast}</span>
                        </div>
                      )}

                      {/* Gmail Thread Messages Scroll */}
                      <div className="thread-messages-scroll">
                        {/* Original Customer Email Bubble */}
                        <motion.div
                          initial={{ opacity: 0, y: 5 }}
                          animate={{ opacity: 1, y: 0 }}
                          className="msg-row customer"
                        >
                          <div
                            className="avatar-circle small"
                            style={{ backgroundColor: '#fee2e2', color: '#b91c1c' }}
                          >
                            <Mail size={14} />
                          </div>
                          <div
                            className="msg-bubble"
                            style={{
                              maxWidth: '85%',
                              backgroundColor: '#ffffff',
                              border: '1px solid var(--border-warm)',
                              boxShadow: '0 1px 3px rgba(0, 0, 0, 0.05)',
                              color: 'var(--text-primary)',
                            }}
                          >
                            <div
                              style={{
                                fontWeight: 600,
                                fontSize: '12.5px',
                                marginBottom: 4,
                                color: 'var(--primary-indigo)',
                              }}
                            >
                              {activeGmailMessage.fromName} &lt;{activeGmailMessage.fromEmail}&gt;
                            </div>
                            <div
                              style={{
                                whiteSpace: 'pre-wrap',
                                lineHeight: 1.5,
                                fontSize: '13px',
                              }}
                            >
                              {activeGmailMessage.bodyText || activeGmailMessage.snippet}
                            </div>
                            <span className="msg-timestamp">
                              {formatDateTime(activeGmailMessage.date)}
                            </span>
                          </div>
                        </motion.div>

                        {/* Sent Replies in this session */}
                        {(gmailRepliesByThread[activeGmailMessage.threadId] || []).map((rep) => (
                          <motion.div
                            key={rep.id}
                            initial={{ opacity: 0, y: 5 }}
                            animate={{ opacity: 1, y: 0 }}
                            className="msg-row agent"
                          >
                            <div className="msg-bubble">
                              <div style={{ whiteSpace: 'pre-wrap', lineHeight: 1.5 }}>
                                {rep.content}
                              </div>
                              <span className="msg-timestamp">
                                {formatInboxTime(rep.created_at)} · Sent via Gmail
                              </span>
                            </div>
                          </motion.div>
                        ))}

                        <div ref={threadEndRef} />
                      </div>

                      {/* Reply Error Notice */}
                      {gmailError && (
                        <div
                          style={{
                            padding: '0 16px 8px 16px',
                            backgroundColor: 'var(--bg-panel)',
                          }}
                        >
                          <div className="alert-banner error">
                            <AlertCircle size={15} style={{ flexShrink: 0 }} />
                            <span>{gmailError}</span>
                          </div>
                        </div>
                      )}

                      {/* Bottom Gmail Reply Composer */}
                      <form className="thread-composer-bar" onSubmit={handleBottomReplySubmit}>
                        <div className="composer-input-wrap">
                          <Mail size={17} color="var(--text-muted)" />
                          <input
                            ref={replyInputRef}
                            type="text"
                            className="composer-input"
                            placeholder={`Reply to ${activeGmailMessage.fromName || activeGmailMessage.fromEmail} via Gmail...`}
                            value={replyInput}
                            onChange={(e) => setReplyInput(e.target.value)}
                            disabled={gmailSending}
                          />
                        </div>

                        <button
                          type="submit"
                          className="composer-send-btn"
                          disabled={!replyInput.trim() || gmailSending}
                          title="Send email reply via Gmail"
                        >
                          {gmailSending ? (
                            <Loader2 size={16} className="spin" />
                          ) : (
                            <Send size={17} />
                          )}
                        </button>
                      </form>
                    </>
                  )
                ) : !activeConversation ? (
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
                    <div
                      style={{
                        marginTop: '14px',
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: '6px',
                        padding: '6px 12px',
                        borderRadius: '6px',
                        backgroundColor: 'var(--accent-lavender-bg)',
                        border: '1px solid var(--accent-lavender-border)',
                        fontSize: '11.5px',
                        color: 'var(--text-secondary)',
                      }}
                    >
                      <Info size={13} color="var(--primary-indigo)" style={{ flexShrink: 0 }} />
                      <span>
                        Customer support chat assistant only has knowledge of the base <code>products.csv</code> catalog.
                      </span>
                    </div>
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

                    {/* Notice: Customer support chat only has knowledge of base products.csv */}
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '8px',
                        padding: '8px 16px',
                        backgroundColor: 'var(--accent-lavender-bg)',
                        borderBottom: '1px solid var(--border-warm)',
                        fontSize: '11.5px',
                        color: 'var(--text-secondary)',
                        lineHeight: 1.4,
                      }}
                    >
                      <Info size={14} color="var(--primary-indigo)" style={{ flexShrink: 0 }} />
                      <span>
                        <strong>Customer Support Scope:</strong> Customer support chat only has knowledge of the base <code>products.csv</code> catalog.
                      </span>
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
                {inboxSource === 'workspace' && activeConversation && (
                  <button
                    type="button"
                    className="btn-warm-outlined"
                    style={{ padding: '5px 8px', fontSize: '11px' }}
                    disabled={
                      !canGenerateCustomerReply ||
                      replyGenerationStatus === 'loading'
                    }
                    onClick={handleGenerateCustomerReply}
                    title={
                      canGenerateCustomerReply
                        ? 'Generate a draft using only this workspace and conversation'
                        : 'A new customer message is required to generate a reply'
                    }
                  >
                    {replyGenerationStatus === 'loading' ? (
                      <>
                        <Loader2 size={12} className="spin" />
                        Generating...
                      </>
                    ) : (
                      <>
                        <Sparkles size={12} />
                        {aiSuggestionDraft ? 'Regenerate Message' : 'Generate Message'}
                      </>
                    )}
                  </button>
                )}
              </div>

              {inboxSource === 'workspace' && replyGenerationError && (
                <div
                  role="alert"
                  style={{
                    fontSize: '12px',
                    color: 'var(--status-error)',
                    backgroundColor: 'var(--status-error-bg)',
                    padding: '7px 9px',
                    borderRadius: '6px',
                  }}
                >
                  {replyGenerationError}
                </div>
              )}

              {inboxSource === 'gmail' && !activeGmailMessage ? (
                <div style={{ fontSize: '12.5px', color: 'var(--text-secondary)' }}>
                  Select an email from your Primary Gmail inbox to inspect its AI-generated reply suggestion.
                </div>
              ) : inboxSource === 'gmail' && generatingGmailAiDraft ? (
                <div
                  style={{
                    fontSize: '12.5px',
                    color: 'var(--text-secondary)',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px',
                    padding: '16px 0',
                  }}
                >
                  <Loader2 size={15} className="spin" color="var(--primary-indigo)" />
                  <span>Generating verified RAG reply suggestion...</span>
                </div>
              ) : inboxSource === 'workspace' && !activeConversation ? (
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

                  {Array.isArray(aiSuggestionMeta?.citations) &&
                    aiSuggestionMeta.citations.length > 0 && (
                      <div style={{ marginTop: '2px', marginBottom: '2px' }}>
                        <div
                          style={{
                            fontSize: '11px',
                            fontWeight: 600,
                            color: 'var(--text-secondary)',
                            marginBottom: '4px',
                          }}
                        >
                          Verified Knowledge Sources:
                        </div>
                        <CitationBadges
                          citations={aiSuggestionMeta.citations}
                          onSelectCitation={(c) => setActiveInquiryCitation(c)}
                        />
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
                      disabled={sendReplyStatus === 'loading' || gmailSending}
                    />
                  </div>

                  <div className="ai-suggestion-actions">
                    <button
                      type="button"
                      className="btn-primary-indigo"
                      style={{ flex: 1, padding: '8px 12px', fontSize: '12.5px' }}
                      disabled={
                        !aiSuggestionDraft.trim() ||
                        sendReplyStatus === 'loading' ||
                        gmailSending
                      }
                      onClick={handleSendApprovedAiSuggestion}
                    >
                      {sendReplyStatus === 'loading' || gmailSending ? (
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
                    No reply draft yet. Select <strong>Generate Message</strong> to
                    create an editable response using only this workspace&apos;s
                    files and the recent conversation.
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
                  className="ai-suggestion-box liquid-glass-card"
                  style={{
                    padding: '12px',
                    gap: '8px',
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

                  {Array.isArray(announcementDraft?.citations) &&
                    announcementDraft.citations.length > 0 && (
                      <div style={{ marginTop: '2px', marginBottom: '2px' }}>
                        <div
                          style={{
                            fontSize: '11px',
                            fontWeight: 600,
                            color: 'var(--text-secondary)',
                            marginBottom: '4px',
                          }}
                        >
                          Verified Knowledge Sources:
                        </div>
                        <CitationBadges
                          citations={announcementDraft.citations}
                          onSelectCitation={(c) => setActiveInquiryCitation(c)}
                        />
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
            transition={{ duration: 0.2, ease: "easeOut" }}
            onClick={() => setShowAnnouncementHistoryModal(false)}
          >
            <motion.div
              className="modal-card liquid-glass-modal"
              style={{
                maxWidth: '680px',
                maxHeight: '85vh',
                overflow: 'hidden',
                display: 'flex',
                flexDirection: 'column',
              }}
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 8 }}
              transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
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
                        className="liquid-glass-card"
                        style={{
                          padding: '12px 14px',
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

      {/* Citation Inspector Modal */}
      <CitationInspectorModal
        citation={activeInquiryCitation}
        onClose={() => setActiveInquiryCitation(null)}
      />
    </div>
  );
}
