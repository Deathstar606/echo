import React, { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useDispatch, useSelector } from 'react-redux';
import { AnimatePresence, motion } from 'framer-motion';
import {
  Download,
  BarChart3,
  Plus,
  History,
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
  Filter,
  Upload,
  Hash,
  UserPlus,
  Check,
  Layers,
  PhoneCall,
  Building2,
  FileSpreadsheet,
  Trash2,
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
  fetchWorkspaceContactsApi,
  addFilteredContactOneClickApi,
  removeWorkspaceContactApi,
  uploadWorkspaceContactsCsvApi,
} from '../services/api';
import {
  getActiveBusinessId,
  getActiveWorkspaceName,
  getLoggedInUser,
} from '../config/constants';
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
  const [activeWorkspaceName, setActiveWorkspaceName] = useState(
    () => getActiveWorkspaceName() || 'Workspace Customer Base'
  );

  // Inbox filter state (All vs Unread Only)
  const [filterUnreadOnly, setFilterUnreadOnly] = useState(false);

  // Bottom reply composer state (preserved on error)
  const [replyInput, setReplyInput] = useState('');

  // Channel Tabs: 'filtered' | 'gmail' | 'slack' | 'toleto'
  const [inboxSource, setInboxSource] = useState('filtered');

  // Workspace Contacts (Filtered & Workspace CSV upload modal)
  const [workspaceContacts, setWorkspaceContacts] = useState({
    filtered_contacts: [],
    filtered_count: 0,
    workspace_csv_contacts: [],
    workspace_csv_count: 0,
    has_csv_panel: false,
    panel_name: 'Workspace Customer Base',
  });
  const [contactsLoading, setContactsLoading] = useState(false);
  const [activeFilteredContact, setActiveFilteredContact] = useState(null);
  const [contactUploadError, setContactUploadError] = useState(null);
  const [contactUploadSuccess, setContactUploadSuccess] = useState(null);
  const [isUploadingContactCsv, setIsUploadingContactCsv] = useState(false);
  const [showUploadContactsModal, setShowUploadContactsModal] = useState(false);
  const [selectedContactCsvFile, setSelectedContactCsvFile] = useState(null);
  const [oneClickFilteringStatus, setOneClickFilteringStatus] = useState({});

  // Slack Demo State
  const [slackDemoMessages, setSlackDemoMessages] = useState([
    {
      id: 'slack-1',
      sender: 'sarah.jenkins@enterprise-corp.com',
      name: 'Sarah Jenkins (Enterprise VIP)',
      time: '10:42 AM',
      channel: '#customer-support',
      text: 'Hello team, what is your standard turnaround SLA for bulk orders over 500 units, and can we request custom labeling?',
      aiReply:
        'Per our Enterprise Fulfillment SLA policy, orders exceeding 500 units are prioritized with 48-hour dispatched fulfillment and complimentary custom brand labeling. Our operations desk can coordinate directly with packaging.',
      citations: [
        {
          source_file: 'enterprise_sla_policy.pdf',
          page_or_sheet: 'Page 2',
          section_header: 'Bulk Order SLA',
        },
      ],
    },
    {
      id: 'slack-2',
      sender: 'mark.watson@globalretail.io',
      name: 'Mark Watson',
      time: '09:15 AM',
      channel: '#general-help',
      text: 'Do you offer net-30 invoicing terms for wholesale accounts registered in the EU?',
      aiReply:
        'Yes, verified wholesale accounts are eligible for net-30 terms upon completing commercial credit verification through the MaxiText finance portal.',
      citations: [
        {
          source_file: 'wholesale_credit_terms.md',
          section_header: 'Invoicing Terms',
        },
      ],
    },
  ]);
  const [activeSlackMessage, setActiveSlackMessage] = useState(null);

  // Toleto Demo State
  const [toletoDemoMessages, setToletoDemoMessages] = useState([
    {
      id: 'toleto-1',
      sender: '+1 (555) 349-2091',
      name: 'Elena Rostova',
      time: '11:05 AM',
      channel: 'WhatsApp VIP',
      text: 'Hi, I received tracking number #TRK-9821 but haven’t seen an update since yesterday. Can you check status?',
      aiReply:
        'Hello Elena, tracking #TRK-9821 is currently in transit with regional hub courier and is scheduled for end-of-day delivery by 6:00 PM.',
      citations: [
        {
          source_file: 'courier_dispatch_log.csv',
          page_or_sheet: 'Dispatches',
          section_header: 'Row 48',
        },
      ],
    },
  ]);
  const [activeToletoMessage, setActiveToletoMessage] = useState(null);

  // Primary Gmail Inbox Integration State
  const [gmailMessages, setGmailMessages] = useState([]);
  const [activeGmailMessage, setActiveGmailMessage] = useState(null);
  const [gmailLoading, setGmailLoading] = useState(false);
  const [gmailError, setGmailError] = useState(null);
  const [gmailSending, setGmailSending] = useState(false);
  const [gmailSendToast, setGmailSendToast] = useState(null);
  const [gmailRepliesByThread, setGmailRepliesByThread] = useState({});
  const [generatingGmailAiDraft, setGeneratingGmailAiDraft] = useState(false);
  const [gmailAiDraftsById, setGmailAiDraftsById] = useState({});
  const [gmailDraftError, setGmailDraftError] = useState(null);

  // Natural-Language Bulk Send Prompt State (No manual Some/All toggle)
  const [announcementPrompt, setAnnouncementPrompt] = useState(
    'Bulk send an exclusive update to our workspace customer base.'
  );
  const [showAnnouncementHistoryModal, setShowAnnouncementHistoryModal] =
    useState(false);
  const [callPlaceholderNotice, setCallPlaceholderNotice] = useState(null);
  const [activeInquiryCitation, setActiveInquiryCitation] = useState(null);

  const threadEndRef = useRef(null);
  const replyInputRef = useRef(null);
  const activeGmailMessageIdRef = useRef(null);

  const loadWorkspaceContacts = async (targetWsId = activeBusinessId) => {
    if (!targetWsId) return;
    setContactsLoading(true);
    try {
      const data = await fetchWorkspaceContactsApi(targetWsId);
      setWorkspaceContacts(data);
      if (data.panel_name) {
        setActiveWorkspaceName(data.panel_name);
      }
      if (data.filtered_contacts?.length > 0 && !activeFilteredContact) {
        setActiveFilteredContact(data.filtered_contacts[0]);
      }
    } catch {
      // ignore
    } finally {
      setContactsLoading(false);
    }
  };

  const handleOneClickSendToFiltered = async (msg) => {
    if (!msg || !activeBusinessId) return;
    const email = (msg.fromEmail || '').toLowerCase().trim();
    setOneClickFilteringStatus((prev) => ({
      ...prev,
      [msg.id]: true,
      [email]: true,
    }));
    try {
      await addFilteredContactOneClickApi(activeBusinessId, {
        email: msg.fromEmail,
        customer_name: msg.fromName,
        metadata: {
          threadId: msg.threadId,
          messageId: msg.id,
          subject: msg.subject,
          snippet: msg.snippet,
          date: msg.date || msg.internalDate,
        },
      });
      await loadWorkspaceContacts(activeBusinessId);
    } catch (err) {
      setOneClickFilteringStatus((prev) => {
        const next = { ...prev };
        delete next[msg.id];
        delete next[email];
        return next;
      });
      alert(err?.message || 'Failed to add contact to Filtered.');
    }
  };

  const isFiltered = (msg) => {
    if (!msg) return false;
    if (oneClickFilteringStatus[msg.id]) return true;
    const email = (msg.fromEmail || '').toLowerCase().trim();
    if (email && oneClickFilteringStatus[email]) return true;
    return workspaceContacts.filtered_contacts?.some(
      (c) => (c.email || '').toLowerCase().trim() === email
    );
  };

  const handleOpenUploadContactsModal = () => {
    setContactUploadError(null);
    setContactUploadSuccess(null);
    setSelectedContactCsvFile(null);
    setShowUploadContactsModal(true);
  };

  const handleCsvContactUpload = async (file) => {
    if (!file || !activeBusinessId) return;
    setIsUploadingContactCsv(true);
    setContactUploadError(null);
    setContactUploadSuccess(null);
    try {
      const res = await uploadWorkspaceContactsCsvApi(activeBusinessId, file);
      setContactUploadSuccess(
        `Successfully imported ${res.imported_count} contact(s) (${res.duplicates_merged} duplicate(s) merged) into ${res.panel_name || activeWorkspaceName}.`
      );
      setSelectedContactCsvFile(null);
      await loadWorkspaceContacts(activeBusinessId);
    } catch (err) {
      setContactUploadError(
        err?.message || "The uploaded CSV file must contain an 'email' column."
      );
    } finally {
      setIsUploadingContactCsv(false);
    }
  };

  const handleRemoveFilteredContact = async (contact) => {
    if (!contact || !activeBusinessId) return;
    try {
      await removeWorkspaceContactApi(activeBusinessId, {
        id: contact.id,
        panel_type: 'filtered',
      });
      if (activeFilteredContact?.id === contact.id) {
        setActiveFilteredContact(null);
      }
      await loadWorkspaceContacts(activeBusinessId);
    } catch (err) {
      alert(err?.message || 'Failed to remove contact from Filtered.');
    }
  };

  const loadGmailInbox = async (silent = false, targetBizId = activeBusinessId) => {
    if (!targetBizId) return;
    if (!silent) setGmailLoading(true);
    setGmailError(null);
    try {
      const messages = await fetchGmailInboxApi(targetBizId);
      setGmailMessages(messages);
      if (messages.length > 0 && !activeGmailMessage) {
        handleSelectGmailMessage(messages[0]);
      }
    } catch (err) {
      setGmailError(
        err?.message || 'Failed to load Gmail messages. Please connect Google Account.'
      );
    } finally {
      if (!silent) setGmailLoading(false);
    }
  };

  const handleSwitchToWorkspace = () => {
    setInboxSource('workspace');
    setGmailDraftError(null);
    if (activeConversationId) {
      dispatch(setActiveConversationImmediate(activeConversationId));
    } else {
      dispatch(setExternalAiSuggestion({ draftText: '', meta: null }));
    }
  };

  const handleSwitchToGmail = () => {
    setInboxSource('gmail');
    setGmailDraftError(null);
    if (gmailMessages.length === 0) {
      activeGmailMessageIdRef.current = null;
      dispatch(setExternalAiSuggestion({ draftText: '', meta: null }));
      loadGmailInbox(false, activeBusinessId);
    } else if (activeGmailMessage && gmailAiDraftsById[activeGmailMessage.id]) {
      dispatch(setExternalAiSuggestion(gmailAiDraftsById[activeGmailMessage.id]));
    } else {
      dispatch(setExternalAiSuggestion({ draftText: '', meta: null }));
    }
  };

  const handleSelectGmailMessage = (msg) => {
    setActiveGmailMessage(msg);
    activeGmailMessageIdRef.current = msg?.id || null;
    setGmailDraftError(null);
    const cachedDraft = msg?.id ? gmailAiDraftsById[msg.id] : null;
    if (cachedDraft) {
      dispatch(setExternalAiSuggestion(cachedDraft));
    } else {
      dispatch(setExternalAiSuggestion({ draftText: '', meta: null }));
    }
  };

  const handleGenerateGmailReply = async () => {
    if (!activeGmailMessage || !activeBusinessId || generatingGmailAiDraft) {
      return;
    }

    const targetMsg = activeGmailMessage;
    const targetBizId = activeBusinessId;
    setGeneratingGmailAiDraft(true);
    setGmailDraftError(null);

    try {
      const aiRes = await generateGmailReplyDraftApi(
        {
          messageText: targetMsg.bodyText || targetMsg.snippet,
          senderName: targetMsg.fromName,
          subject: targetMsg.subject,
        },
        targetBizId
      );

      const suggestionPayload = {
        draftText: aiRes.draftText || '',
        meta: {
          originalSuggestion: aiRes.draftText || '',
          category: aiRes.category || 'customer_inquiry',
          missingInformation: aiRes.contextNote ? [aiRes.contextNote] : [],
          sourceMessageContent: targetMsg.bodyText || targetMsg.snippet,
          citations: aiRes.citations || [],
        },
      };

      setGmailAiDraftsById((prev) => ({
        ...prev,
        [targetMsg.id]: suggestionPayload,
      }));

      if (activeGmailMessageIdRef.current === targetMsg.id) {
        dispatch(setExternalAiSuggestion(suggestionPayload));
      }
    } catch (err) {
      setGmailDraftError(
        err?.message || 'Failed to generate AI response for this message.'
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
      setActiveWorkspaceName(getActiveWorkspaceName() || 'Workspace Customer Base');
      setActiveBusinessId((prev) => {
        if (prev !== nextBizId) {
          dispatch(resetCompanyWorkspaceState());
          setGmailMessages([]);
          setActiveGmailMessage(null);
          activeGmailMessageIdRef.current = null;
          setGmailAiDraftsById({});
          setGmailDraftError(null);
          setGeneratingGmailAiDraft(false);
          setGmailError(null);
          setGmailRepliesByThread({});
          setGmailSendToast(null);
          setReplyInput('');
          setActiveInquiryCitation(null);
          setShowUploadContactsModal(false);
          setSelectedContactCsvFile(null);
          setContactUploadError(null);
          setContactUploadSuccess(null);
          loadWorkspaceContacts(nextBizId);
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
    loadWorkspaceContacts(activeBusinessId);

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
      {/* Top Navigation Tabs */}
      <div className="workspace-nav-bar">
        <div className="workspace-tabs-track" role="tablist" aria-label="Workspace Views">
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'inquiry'}
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
              <Download
                size={15}
                color={activeTab === 'inquiry' ? 'var(--primary-indigo)' : 'var(--text-secondary)'}
              />
              <span>Customer Inquiry</span>
            </span>
          </button>

          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'sheets'}
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
              <BarChart3
                size={15}
                color={activeTab === 'sheets' ? '#16a34a' : 'var(--text-secondary)'}
              />
              <span>Operations &amp; Sheet Management</span>
            </span>
          </button>
        </div>
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
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <h1 className="inquiry-card-title">Customer Inquiry Panel</h1>
                <button
                  type="button"
                  className="inquiry-add-contacts-btn"
                  onClick={handleOpenUploadContactsModal}
                  title="Upload workspace customer contacts CSV"
                  aria-label="Upload workspace customer contacts CSV"
                >
                  <Plus size={12} strokeWidth={2.4} />
                </button>
              </div>
            </div>

            <div className="inquiry-split-body">
              {/* Left Sub-Column: Inbox */}
              <aside className="inbox-column">
                {/* Channel Selector: Filtered, Gmail, Slack (Demo), Toleto (Demo) */}
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '4px',
                    padding: '8px 10px',
                    backgroundColor: 'var(--bg-panel)',
                    borderBottom: '1px solid var(--border-warm)',
                    overflowX: 'auto',
                  }}
                >
                  {/* 1. Filtered */}
                  <button
                    type="button"
                    onClick={() => {
                      setInboxSource('filtered');
                      setGmailDraftError(null);
                    }}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: '4px',
                      padding: '6px 8px',
                      borderRadius: '6px',
                      fontSize: '11px',
                      fontWeight: inboxSource === 'filtered' ? 700 : 500,
                      backgroundColor:
                        inboxSource === 'filtered'
                          ? 'var(--primary-indigo)'
                          : 'transparent',
                      color:
                        inboxSource === 'filtered'
                          ? '#ffffff'
                          : 'var(--text-secondary)',
                      border: 'none',
                      cursor: 'pointer',
                      whiteSpace: 'nowrap',
                      flexShrink: 0,
                    }}
                    title="Exclusively for 1-click curated Gmail contacts"
                  >
                    <Filter size={12} />
                    <span>Filtered</span>
                    <span
                      style={{
                        padding: '1px 5px',
                        borderRadius: '999px',
                        fontSize: '9.5px',
                        fontWeight: 700,
                        backgroundColor:
                          inboxSource === 'filtered'
                            ? 'rgba(255, 255, 255, 0.25)'
                            : 'var(--bg-subtle-warm)',
                        color:
                          inboxSource === 'filtered'
                            ? '#ffffff'
                            : 'var(--text-secondary)',
                      }}
                    >
                      {workspaceContacts.filtered_count || 0}
                    </span>
                  </button>

                  {/* 2. Gmail */}
                  <button
                    type="button"
                    onClick={() => {
                      handleSwitchToGmail();
                    }}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: '4px',
                      padding: '6px 8px',
                      borderRadius: '6px',
                      fontSize: '11px',
                      fontWeight: inboxSource === 'gmail' ? 700 : 500,
                      backgroundColor:
                        inboxSource === 'gmail' ? '#ea4335' : 'transparent',
                      color:
                        inboxSource === 'gmail'
                          ? '#ffffff'
                          : 'var(--text-secondary)',
                      border: 'none',
                      cursor: 'pointer',
                      whiteSpace: 'nowrap',
                      flexShrink: 0,
                    }}
                  >
                    <Mail size={12} />
                    <span>Gmail</span>
                    {gmailMessages.length > 0 && (
                      <span
                        style={{
                          padding: '1px 5px',
                          borderRadius: '999px',
                          fontSize: '9.5px',
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

                  {/* 4. Slack (Demo) */}
                  <button
                    type="button"
                    onClick={() => {
                      setInboxSource('slack');
                      if (!activeSlackMessage && slackDemoMessages.length > 0) {
                        setActiveSlackMessage(slackDemoMessages[0]);
                      }
                    }}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: '4px',
                      padding: '6px 8px',
                      borderRadius: '6px',
                      fontSize: '11px',
                      fontWeight: inboxSource === 'slack' ? 700 : 500,
                      backgroundColor:
                        inboxSource === 'slack' ? '#4a154b' : 'transparent',
                      color:
                        inboxSource === 'slack'
                          ? '#ffffff'
                          : 'var(--text-secondary)',
                      border: 'none',
                      cursor: 'pointer',
                      whiteSpace: 'nowrap',
                      flexShrink: 0,
                    }}
                  >
                    <Hash size={12} />
                    <span>Slack</span>
                    <span
                      style={{
                        padding: '1px 4px',
                        borderRadius: '4px',
                        fontSize: '9px',
                        fontWeight: 700,
                        backgroundColor:
                          inboxSource === 'slack'
                            ? 'rgba(255, 255, 255, 0.25)'
                            : '#f1f5f9',
                        color:
                          inboxSource === 'slack' ? '#ffffff' : '#475569',
                      }}
                    >
                      Demo
                    </span>
                  </button>

                  {/* 5. Toleto (Demo) */}
                  <button
                    type="button"
                    onClick={() => {
                      setInboxSource('toleto');
                      if (!activeToletoMessage && toletoDemoMessages.length > 0) {
                        setActiveToletoMessage(toletoDemoMessages[0]);
                      }
                    }}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: '4px',
                      padding: '6px 8px',
                      borderRadius: '6px',
                      fontSize: '11px',
                      fontWeight: inboxSource === 'toleto' ? 700 : 500,
                      backgroundColor:
                        inboxSource === 'toleto' ? '#d97706' : 'transparent',
                      color:
                        inboxSource === 'toleto'
                          ? '#ffffff'
                          : 'var(--text-secondary)',
                      border: 'none',
                      cursor: 'pointer',
                      whiteSpace: 'nowrap',
                      flexShrink: 0,
                    }}
                  >
                    <PhoneCall size={12} />
                    <span>Toleto</span>
                    <span
                      style={{
                        padding: '1px 4px',
                        borderRadius: '4px',
                        fontSize: '9px',
                        fontWeight: 700,
                        backgroundColor:
                          inboxSource === 'toleto'
                            ? 'rgba(255, 255, 255, 0.25)'
                            : '#fef3c7',
                        color:
                          inboxSource === 'toleto' ? '#ffffff' : '#92400e',
                      }}
                    >
                      Demo
                    </span>
                  </button>
                </div>

                <div className="inbox-header">
                  <span className="inbox-header-title" style={{ fontSize: '13px' }}>
                    {inboxSource === 'filtered' && (
                      <>
                        Filtered Contacts{' '}
                        <span style={{ fontSize: '11.5px', color: 'var(--text-secondary)' }}>
                          ({workspaceContacts.filtered_count || 0})
                        </span>
                      </>
                    )}
                    {inboxSource === 'gmail' && (
                      <>
                        Primary Gmail Inbox{' '}
                        {gmailMessages.length > 0 && (
                          <span style={{ fontSize: '11.5px', color: 'var(--text-secondary)' }}>
                            ({gmailMessages.length})
                          </span>
                        )}
                      </>
                    )}
                    {inboxSource === 'slack' && 'Slack Enterprise Sync'}
                    {inboxSource === 'toleto' && 'Toleto Omnichannel Gateway'}
                  </span>

                  <div className="inbox-header-actions">
                    <button
                      type="button"
                      className="icon-action-btn"
                      onClick={() => {
                        if (inboxSource === 'gmail') {
                          loadGmailInbox(false);
                        } else if (inboxSource === 'filtered') {
                          loadWorkspaceContacts(activeBusinessId);
                        } else {
                          dispatch(loadCompanyConversations({ silent: false }));
                        }
                      }}
                      title="Refresh inbox"
                    >
                      <RefreshCw
                        size={15}
                        className={
                          (inboxSource === 'gmail'
                            ? gmailLoading
                            : contactsLoading)
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

                {/* Inbox List */}
                <div className="inbox-list">
                  {/* Channel 1: Filtered Contacts */}
                  {inboxSource === 'filtered' && (
                    contactsLoading && workspaceContacts.filtered_contacts.length === 0 ? (
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
                        <span>Loading Filtered contacts...</span>
                      </div>
                    ) : workspaceContacts.filtered_contacts.length === 0 ? (
                      <div
                        style={{
                          padding: '36px 18px',
                          textAlign: 'center',
                          color: 'var(--text-secondary)',
                        }}
                      >
                        <Filter
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
                          No Curated Contacts in Filtered
                        </div>
                        <p style={{ fontSize: '12px', lineHeight: 1.5 }}>
                          Click <strong>+ Add to Filtered</strong> inside an opened email in the Gmail tab to curate high-priority customer contacts here.
                        </p>
                      </div>
                    ) : (
                      workspaceContacts.filtered_contacts.map((contact) => {
                        const isSelected = activeFilteredContact?.id === contact.id;
                        return (
                          <button
                            key={contact.id}
                            type="button"
                            className={`inbox-item ${isSelected ? 'active' : ''}`}
                            onClick={() => setActiveFilteredContact(contact)}
                          >
                            <div
                              className="avatar-circle"
                              style={{
                                backgroundColor: 'var(--accent-lavender-bg)',
                                color: 'var(--primary-indigo-dark)',
                              }}
                            >
                              <Filter size={15} />
                            </div>

                            <div className="inbox-item-content">
                              <div className="inbox-item-top">
                                <span
                                  className="inbox-customer-name"
                                  style={{
                                    maxWidth: '140px',
                                    overflow: 'hidden',
                                    textOverflow: 'ellipsis',
                                  }}
                                >
                                  {contact.customer_name || contact.email}
                                </span>
                                <span className="inbox-time">
                                  {formatInboxTime(contact.created_at)}
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
                                {contact.metadata?.subject || contact.email}
                              </div>

                              <div className="inbox-item-bottom">
                                <span className="inbox-snippet">
                                  {contact.metadata?.snippet || contact.email}
                                </span>
                              </div>
                            </div>
                          </button>
                        );
                      })
                    )
                  )}

                  {/* Channel 2: Gmail */}
                  {inboxSource === 'gmail' && (
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
                          <div
                            key={msg.id}
                            className={`inbox-item ${isSelected ? 'active' : ''}`}
                            onClick={() => handleSelectGmailMessage(msg)}
                            style={{ cursor: 'pointer', display: 'flex', position: 'relative' }}
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
                                <span className="inbox-snippet">
                                  {msg.snippet}
                                </span>
                              </div>
                            </div>
                          </div>
                        );
                      })
                    )
                  )}

                  {/* Channel 4: Slack (Demo) */}
                  {inboxSource === 'slack' && (
                    slackDemoMessages.map((item) => {
                      const isSelected = activeSlackMessage?.id === item.id;
                      return (
                        <button
                          key={item.id}
                          type="button"
                          className={`inbox-item ${isSelected ? 'active' : ''}`}
                          onClick={() => setActiveSlackMessage(item)}
                        >
                          <div
                            className="avatar-circle"
                            style={{ backgroundColor: '#f3e8ff', color: '#6b21a8' }}
                          >
                            <Hash size={16} />
                          </div>

                          <div className="inbox-item-content">
                            <div className="inbox-item-top">
                              <span className="inbox-customer-name">
                                {item.name}
                              </span>
                              <span className="inbox-time">{item.time}</span>
                            </div>

                            <div
                              style={{
                                fontSize: '11.5px',
                                fontWeight: 700,
                                color: '#6b21a8',
                                marginBottom: 2,
                              }}
                            >
                              {item.channel}
                            </div>

                            <div className="inbox-item-bottom">
                              <span className="inbox-snippet">{item.text}</span>
                            </div>
                          </div>
                        </button>
                      );
                    })
                  )}

                  {/* Channel 5: Toleto (Demo) */}
                  {inboxSource === 'toleto' && (
                    toletoDemoMessages.map((item) => {
                      const isSelected = activeToletoMessage?.id === item.id;
                      return (
                        <button
                          key={item.id}
                          type="button"
                          className={`inbox-item ${isSelected ? 'active' : ''}`}
                          onClick={() => setActiveToletoMessage(item)}
                        >
                          <div
                            className="avatar-circle"
                            style={{ backgroundColor: '#fef3c7', color: '#92400e' }}
                          >
                            <PhoneCall size={16} />
                          </div>

                          <div className="inbox-item-content">
                            <div className="inbox-item-top">
                              <span className="inbox-customer-name">
                                {item.name}
                              </span>
                              <span className="inbox-time">{item.time}</span>
                            </div>

                            <div
                              style={{
                                fontSize: '11.5px',
                                fontWeight: 700,
                                color: '#92400e',
                                marginBottom: 2,
                              }}
                            >
                              {item.channel}
                            </div>

                            <div className="inbox-item-bottom">
                              <span className="inbox-snippet">{item.text}</span>
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
                      <div className="thread-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
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

                        <div>
                          {isFiltered(activeGmailMessage) ? (
                            <span
                              style={{
                                display: 'inline-flex',
                                alignItems: 'center',
                                gap: '4px',
                                padding: '4px 10px',
                                borderRadius: '999px',
                                fontSize: '11.5px',
                                fontWeight: 700,
                                backgroundColor: '#e6f4ea',
                                color: '#137333',
                                border: '1px solid #bbf7d0',
                              }}
                            >
                              <Check size={13} /> In Filtered
                            </span>
                          ) : (
                            <button
                              type="button"
                              className="btn-warm-outlined"
                              style={{
                                display: 'inline-flex',
                                alignItems: 'center',
                                gap: '4px',
                                fontSize: '11.5px',
                                padding: '4px 10px',
                                borderRadius: '6px',
                                fontWeight: 600,
                                color: 'var(--primary-indigo-dark)',
                                borderColor: 'var(--primary-indigo)',
                              }}
                              onClick={() => handleOneClickSendToFiltered(activeGmailMessage)}
                              title="Add this contact to Filtered section"
                            >
                              <UserPlus size={13} /> + Add to Filtered
                            </button>
                          )}
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
                ) : inboxSource === 'filtered' ? (
                  !activeFilteredContact ? (
                    <div
                      style={{
                        margin: 'auto',
                        textAlign: 'center',
                        padding: '32px',
                        color: 'var(--text-secondary)',
                      }}
                    >
                      <Filter
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
                        Select a Filtered Contact
                      </div>
                      <p style={{ fontSize: '13px', marginTop: 4 }}>
                        Choose a curated contact from the left list to review their inquiry and draft replies.
                      </p>
                    </div>
                  ) : (
                    <>
                      {/* Filtered Contact Header */}
                      <div className="thread-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <div className="thread-customer-info">
                          <div
                            className="avatar-circle"
                            style={{
                              backgroundColor: 'var(--accent-lavender-bg)',
                              color: 'var(--primary-indigo-dark)',
                            }}
                          >
                            <Filter size={18} />
                          </div>
                          <div>
                            <div className="thread-customer-name" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                              <span>{activeFilteredContact.customer_name || activeFilteredContact.email}</span>
                              <span
                                style={{
                                  fontSize: '10px',
                                  fontWeight: 700,
                                  padding: '2px 6px',
                                  borderRadius: '4px',
                                  backgroundColor: 'var(--accent-lavender-bg)',
                                  color: 'var(--primary-indigo-dark)',
                                  border: '1px solid var(--accent-lavender-border)',
                                }}
                              >
                                FILTERED CONTACT
                              </span>
                            </div>
                            <div className="thread-customer-sub">
                              Email: <strong>{activeFilteredContact.email}</strong> · Filtered on {formatDateTime(activeFilteredContact.created_at)}
                            </div>
                          </div>
                        </div>

                        <button
                          type="button"
                          className="btn-warm-outlined"
                          style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: '4px',
                            fontSize: '11px',
                            padding: '4px 8px',
                            color: '#b91c1c',
                            borderColor: '#fca5a5',
                          }}
                          onClick={() => handleRemoveFilteredContact(activeFilteredContact)}
                          title="Remove contact from Filtered"
                        >
                          <Trash2 size={13} />
                          <span>Remove</span>
                        </button>
                      </div>

                      <div className="thread-messages-scroll" style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
                        {/* Original Inbound Inquiry Card */}
                        <div
                          className="liquid-glass-card"
                          style={{
                            padding: '14px',
                            borderRadius: '8px',
                            border: '1px solid var(--border-warm)',
                            display: 'flex',
                            flexDirection: 'column',
                            gap: '6px',
                          }}
                        >
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                            <span style={{ fontSize: '12.5px', fontWeight: 700, color: 'var(--primary-indigo)' }}>
                              {activeFilteredContact.metadata?.subject || '(No Subject)'}
                            </span>
                            <span style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>
                              {formatDateTime(activeFilteredContact.metadata?.date || activeFilteredContact.created_at)}
                            </span>
                          </div>
                          <p style={{ fontSize: '12.5px', margin: 0, lineHeight: 1.5, color: 'var(--text-primary)' }}>
                            {activeFilteredContact.metadata?.snippet || 'Curated contact from primary Gmail inbox.'}
                          </p>
                        </div>

                        {/* Priority notice */}
                        <div
                          style={{
                            padding: '10px 14px',
                            backgroundColor: 'var(--accent-lavender-bg)',
                            borderRadius: '6px',
                            border: '1px solid var(--accent-lavender-border)',
                            fontSize: '11.5px',
                            color: 'var(--text-secondary)',
                            display: 'flex',
                            alignItems: 'center',
                            gap: '8px',
                          }}
                        >
                          <Sparkles size={14} color="var(--primary-indigo)" style={{ flexShrink: 0 }} />
                          <span>
                            This contact was 1-click curated into your workspace's high-priority review queue. Use the AI Workspace Copilot to draft a reply with verified citations.
                          </span>
                        </div>
                      </div>

                      {/* Filtered Reply Composer */}
                      <form
                        className="thread-composer-bar"
                        onSubmit={(e) => {
                          e.preventDefault();
                          if (replyInput.trim()) {
                            setGmailSendToast(`Reply queued for ${activeFilteredContact.email}`);
                            setReplyInput('');
                            setTimeout(() => setGmailSendToast(null), 5000);
                          }
                        }}
                      >
                        <div className="composer-input-wrap">
                          <Mail size={17} color="var(--text-muted)" />
                          <input
                            ref={replyInputRef}
                            type="text"
                            className="composer-input"
                            placeholder={`Reply to ${activeFilteredContact.customer_name || activeFilteredContact.email}...`}
                            value={replyInput}
                            onChange={(e) => setReplyInput(e.target.value)}
                          />
                        </div>

                        <button
                          type="submit"
                          className="composer-send-btn"
                          disabled={!replyInput.trim()}
                          title="Send reply"
                        >
                          <Send size={17} />
                        </button>
                      </form>
                    </>
                  )
                ) : inboxSource === 'slack' ? (
                  !activeSlackMessage ? (
                    <div style={{ margin: 'auto', textAlign: 'center', padding: '32px', color: 'var(--text-secondary)' }}>
                      <Hash size={32} style={{ margin: '0 auto 10px auto', opacity: 0.5 }} />
                      <div style={{ fontSize: '15px', fontWeight: 700, color: 'var(--text-primary)' }}>
                        Select a Slack Channel Thread
                      </div>
                      <p style={{ fontSize: '13px', marginTop: 4 }}>
                        Interactive demo for Slack enterprise workspace integration.
                      </p>
                    </div>
                  ) : (
                    <>
                      <div className="thread-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <div className="thread-customer-info">
                          <div className="avatar-circle" style={{ backgroundColor: '#f3e8ff', color: '#6b21a8' }}>
                            <Hash size={18} />
                          </div>
                          <div>
                            <div className="thread-customer-name">
                              <span>{activeSlackMessage.channel} · {activeSlackMessage.name}</span>
                            </div>
                            <div className="thread-customer-sub">
                              {activeSlackMessage.sender} · {activeSlackMessage.time}
                            </div>
                          </div>
                        </div>
                        <span
                          style={{
                            fontSize: '11px',
                            fontWeight: 700,
                            padding: '3px 8px',
                            borderRadius: '4px',
                            backgroundColor: '#f3e8ff',
                            color: '#6b21a8',
                          }}
                        >
                          SLACK DEMO
                        </span>
                      </div>

                      <div className="thread-messages-scroll" style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
                        {/* Customer Question Bubble */}
                        <div className="msg-row customer">
                          <div className="avatar-circle small" style={{ backgroundColor: '#f3e8ff', color: '#6b21a8' }}>
                            <Hash size={14} />
                          </div>
                          <div className="msg-bubble" style={{ maxWidth: '85%' }}>
                            <div style={{ fontWeight: 600, fontSize: '12px', marginBottom: 3, color: '#6b21a8' }}>
                              {activeSlackMessage.name}
                            </div>
                            <div style={{ fontSize: '12.5px', lineHeight: 1.45 }}>{activeSlackMessage.text}</div>
                            <span className="msg-timestamp">{activeSlackMessage.time}</span>
                          </div>
                        </div>

                        {/* MaxiText AI Copilot Answer Bubble */}
                        <div className="msg-row agent">
                          <div className="msg-bubble" style={{ maxWidth: '85%', backgroundColor: '#f5f3ff', borderColor: '#ddd6fe' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '5px', fontWeight: 700, fontSize: '12px', color: 'var(--primary-indigo-dark)', marginBottom: 4 }}>
                              <Sparkles size={12} />
                              <span>MaxiText AI Copilot Response</span>
                            </div>
                            <div style={{ fontSize: '12.5px', lineHeight: 1.45 }}>{activeSlackMessage.aiReply}</div>
                            {activeSlackMessage.citations && activeSlackMessage.citations.length > 0 && (
                              <div style={{ marginTop: '8px' }}>
                                <CitationBadges
                                  citations={activeSlackMessage.citations}
                                  onSelectCitation={(c) => setActiveInquiryCitation(c)}
                                />
                              </div>
                            )}
                          </div>
                        </div>
                      </div>

                      <div className="thread-composer-bar">
                        <input
                          type="text"
                          className="composer-input"
                          disabled
                          placeholder="Slack interactive simulation mode active..."
                          value=""
                        />
                        <button
                          type="button"
                          className="btn-warm-outlined"
                          style={{ fontSize: '11.5px', padding: '6px 12px' }}
                          onClick={() => {
                            alert('Slack Enterprise Connect is active in demo mode for this workspace.');
                          }}
                        >
                          Simulate Question
                        </button>
                      </div>
                    </>
                  )
                ) : inboxSource === 'toleto' ? (
                  !activeToletoMessage ? (
                    <div style={{ margin: 'auto', textAlign: 'center', padding: '32px', color: 'var(--text-secondary)' }}>
                      <PhoneCall size={32} style={{ margin: '0 auto 10px auto', opacity: 0.5 }} />
                      <div style={{ fontSize: '15px', fontWeight: 700, color: 'var(--text-primary)' }}>
                        Select a Toleto Inbound Thread
                      </div>
                      <p style={{ fontSize: '13px', marginTop: 4 }}>
                        Interactive demo for Toleto WhatsApp and SMS gateway.
                      </p>
                    </div>
                  ) : (
                    <>
                      <div className="thread-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <div className="thread-customer-info">
                          <div className="avatar-circle" style={{ backgroundColor: '#fef3c7', color: '#92400e' }}>
                            <PhoneCall size={18} />
                          </div>
                          <div>
                            <div className="thread-customer-name">
                              <span>{activeToletoMessage.name} ({activeToletoMessage.channel})</span>
                            </div>
                            <div className="thread-customer-sub">
                              {activeToletoMessage.sender} · {activeToletoMessage.time}
                            </div>
                          </div>
                        </div>
                        <span
                          style={{
                            fontSize: '11px',
                            fontWeight: 700,
                            padding: '3px 8px',
                            borderRadius: '4px',
                            backgroundColor: '#fef3c7',
                            color: '#92400e',
                          }}
                        >
                          TOLETO DEMO
                        </span>
                      </div>

                      <div className="thread-messages-scroll" style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
                        {/* Customer Question Bubble */}
                        <div className="msg-row customer">
                          <div className="avatar-circle small" style={{ backgroundColor: '#fef3c7', color: '#92400e' }}>
                            <PhoneCall size={14} />
                          </div>
                          <div className="msg-bubble" style={{ maxWidth: '85%' }}>
                            <div style={{ fontWeight: 600, fontSize: '12px', marginBottom: 3, color: '#92400e' }}>
                              {activeToletoMessage.name}
                            </div>
                            <div style={{ fontSize: '12.5px', lineHeight: 1.45 }}>{activeToletoMessage.text}</div>
                            <span className="msg-timestamp">{activeToletoMessage.time}</span>
                          </div>
                        </div>

                        {/* MaxiText AI Copilot Answer Bubble */}
                        <div className="msg-row agent">
                          <div className="msg-bubble" style={{ maxWidth: '85%', backgroundColor: '#fffbeb', borderColor: '#fde68a' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '5px', fontWeight: 700, fontSize: '12px', color: '#92400e', marginBottom: 4 }}>
                              <Sparkles size={12} />
                              <span>MaxiText AI Copilot Auto-Response</span>
                            </div>
                            <div style={{ fontSize: '12.5px', lineHeight: 1.45 }}>{activeToletoMessage.aiReply}</div>
                            {activeToletoMessage.citations && activeToletoMessage.citations.length > 0 && (
                              <div style={{ marginTop: '8px' }}>
                                <CitationBadges
                                  citations={activeToletoMessage.citations}
                                  onSelectCitation={(c) => setActiveInquiryCitation(c)}
                                />
                              </div>
                            )}
                          </div>
                        </div>
                      </div>

                      <div className="thread-composer-bar">
                        <input
                          type="text"
                          className="composer-input"
                          disabled
                          placeholder="Toleto omnichannel gateway simulation mode active..."
                          value=""
                        />
                        <button
                          type="button"
                          className="btn-warm-outlined"
                          style={{ fontSize: '11.5px', padding: '6px 12px' }}
                          onClick={() => {
                            alert('Toleto Omnichannel Gateway is active in interactive demo mode.');
                          }}
                        >
                          Simulate WhatsApp Inbound
                        </button>
                      </div>
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
              </div>

              {((inboxSource === 'workspace' && replyGenerationError) ||
                (inboxSource === 'gmail' && gmailDraftError)) && (
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
                  {inboxSource === 'gmail' ? gmailDraftError : replyGenerationError}
                </div>
              )}

              {inboxSource === 'gmail' && !activeGmailMessage ? (
                <div style={{ fontSize: '12.5px', color: 'var(--text-secondary)' }}>
                  Select an email from your Primary Gmail inbox, then click{' '}
                  <strong>Generate Response</strong> to draft a reply for review.
                </div>
              ) : (inboxSource === 'gmail' && generatingGmailAiDraft) ||
                (inboxSource === 'workspace' &&
                  replyGenerationStatus === 'loading' &&
                  !aiSuggestionDraft &&
                  !aiSuggestionMeta) ? (
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
                  Select a customer conversation in the inbox, then click{' '}
                  <strong>Generate Response</strong> to draft a reply for review.
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
                    gap: '10px',
                  }}
                >
                  <div>
                    No reply draft yet. Click <strong>Generate Response</strong> to
                    create an editable response using only this workspace&apos;s
                    knowledge sources and message context.
                  </div>
                  <button
                    type="button"
                    className="btn-primary-indigo"
                    style={{ width: '100%', padding: '9px 12px', fontSize: '12.5px' }}
                    disabled={
                      inboxSource === 'gmail'
                        ? !activeGmailMessage || generatingGmailAiDraft || !activeBusinessId
                        : !canGenerateCustomerReply || replyGenerationStatus === 'loading'
                    }
                    onClick={
                      inboxSource === 'gmail'
                        ? handleGenerateGmailReply
                        : handleGenerateCustomerReply
                    }
                  >
                    <Sparkles size={14} />
                    Generate Response
                  </button>
                  {inboxSource === 'workspace' &&
                    activeMessages.some((m) => m.ai_suggestion) && (
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

            {/* 2. Bulk Send Box — Natural-Language Recipient Targeting & Live Sending */}
            <div className="announcement-section">
              <div className="announcement-title-row">
                <div className="announcement-heading">
                  <Send size={15} color="var(--primary-indigo)" />
                  <span>Bulk Send Box</span>
                </div>
                <button
                  type="button"
                  className="bulk-history-trigger-btn"
                  onClick={handleOpenAnnouncementHistory}
                  title="View Bulk Send History"
                >
                  <History size={13} />
                  <span>Bulk Send History</span>
                  {announcementHistory.length > 0 && (
                    <span className="bulk-history-count-pill">
                      {announcementHistory.length}
                    </span>
                  )}
                </button>
              </div>

              <div className="form-group">
                <label
                  className="copilot-field-label"
                  htmlFor="bulk-announcement-prompt"
                >
                  Bulk Send Prompt (Natural-Language Content &amp; Audience)
                </label>

                {/* Audience Quick-Targeting Chips */}
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '5px', marginBottom: '8px' }}>
                  <button
                    type="button"
                    className="btn-warm-outlined"
                    style={{
                      fontSize: '10.5px',
                      padding: '3px 8px',
                      borderRadius: '999px',
                      fontWeight: 600,
                      backgroundColor: announcementPrompt.toLowerCase().includes('workspace customer base')
                        ? 'var(--accent-lavender-bg)'
                        : 'transparent',
                      borderColor: announcementPrompt.toLowerCase().includes('workspace customer base')
                        ? 'var(--primary-indigo)'
                        : 'var(--border-warm)',
                    }}
                    onClick={() => {
                      setAnnouncementPrompt(
                        `Bulk send an exclusive update to our ${activeWorkspaceName} workspace customer base.`
                      );
                      dispatch(clearAnnouncementDraft());
                      dispatch(clearAnnouncementSendResult());
                    }}
                  >
                    <Users size={11} style={{ marginRight: 3 }} />
                    {activeWorkspaceName} Base ({workspaceContacts.workspace_csv_count || 0})
                  </button>

                  <button
                    type="button"
                    className="btn-warm-outlined"
                    style={{
                      fontSize: '10.5px',
                      padding: '3px 8px',
                      borderRadius: '999px',
                      fontWeight: 600,
                      backgroundColor: announcementPrompt.toLowerCase().includes('filtered contacts')
                        ? 'var(--accent-lavender-bg)'
                        : 'transparent',
                      borderColor: announcementPrompt.toLowerCase().includes('filtered contacts')
                        ? 'var(--primary-indigo)'
                        : 'var(--border-warm)',
                    }}
                    onClick={() => {
                      setAnnouncementPrompt(
                        'Bulk send a personalized update to our filtered contacts.'
                      );
                      dispatch(clearAnnouncementDraft());
                      dispatch(clearAnnouncementSendResult());
                    }}
                  >
                    <Filter size={11} style={{ marginRight: 3 }} />
                    Filtered Contacts ({workspaceContacts.filtered_count || 0})
                  </button>

                  <button
                    type="button"
                    className="btn-warm-outlined"
                    style={{
                      fontSize: '10.5px',
                      padding: '3px 8px',
                      borderRadius: '999px',
                      fontWeight: 600,
                    }}
                    onClick={() => {
                      setAnnouncementPrompt(
                        'Bulk send an announcement to all users who registered after 2026-01-01.'
                      );
                      dispatch(clearAnnouncementDraft());
                      dispatch(clearAnnouncementSendResult());
                    }}
                  >
                    All Registered Users
                  </button>
                </div>

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
                  placeholder='e.g. "Bulk send a 20% discount offer to our workspace customer base."'
                />
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
                    Draft &amp; Preview Bulk Send
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
                        Executing Bulk Send to {announcementDraft.recipient_count} Recipient(s)...
                      </>
                    ) : (
                      <>
                        <Rocket size={15} />
                        Confirm &amp; Execute Bulk Send to {announcementDraft.recipient_count}{' '}
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
                        Bulk Send Execution Summary ({announcementSendResult.status})
                      </span>
                    </div>
                    <span style={{ fontSize: '11px', opacity: 0.9 }}>
                      {formatDateTime(announcementSendResult.sent_at)}
                    </span>
                  </div>

                  <div style={{ display: 'flex', gap: '12px', fontSize: '11.5px', marginTop: 2 }}>
                    <span>
                      Total Targeted: <strong>{announcementSendResult.total_recipients}</strong>
                    </span>
                    <span style={{ color: 'var(--status-success)' }}>
                      Sent: <strong>{announcementSendResult.sent_count}</strong>
                    </span>
                    {announcementSendResult.failed_count > 0 && (
                      <span style={{ color: 'var(--status-error)' }}>
                        Failed: <strong>{announcementSendResult.failed_count}</strong>
                      </span>
                    )}
                  </div>
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
                  <Send size={18} color="var(--primary-indigo)" />
                  <h3 style={{ fontSize: '16px', fontWeight: 700 }}>
                    Bulk Send History
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
                    title="Refresh bulk send history"
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
                    Loading bulk send history...
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
                    No bulk send campaigns have been drafted or sent for this workspace yet.
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
                              {ann.subject || 'Untitled Bulk Send'}
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

      {/* Upload Workspace Contacts CSV Modal */}
      <AnimatePresence>
        {showUploadContactsModal && (
          <motion.div
            className="modal-backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2, ease: 'easeOut' }}
            onClick={() => !isUploadingContactCsv && setShowUploadContactsModal(false)}
          >
            <motion.div
              className="modal-card liquid-glass-modal"
              style={{
                maxWidth: '490px',
                gap: '14px',
                borderRadius: '16px',
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
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                  <div
                    style={{
                      width: 34,
                      height: 34,
                      borderRadius: '10px',
                      backgroundColor: 'var(--accent-lavender-bg)',
                      color: 'var(--primary-indigo)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      flexShrink: 0,
                    }}
                  >
                    <Users size={18} />
                  </div>
                  <div>
                    <h3 style={{ fontSize: '16px', fontWeight: 700, margin: 0 }}>
                      Upload Workspace Contacts CSV
                    </h3>
                    <p style={{ fontSize: '12px', color: 'var(--text-secondary)', margin: 0 }}>
                      {activeWorkspaceName} · {workspaceContacts.workspace_csv_count || 0} contact(s) saved
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  className="icon-action-btn"
                  onClick={() => setShowUploadContactsModal(false)}
                  disabled={isUploadingContactCsv}
                  aria-label="Close upload contacts modal"
                >
                  <X size={18} />
                </button>
              </div>

              <div className="alert-banner info" style={{ fontSize: '12px' }}>
                <Info size={15} style={{ flexShrink: 0, marginTop: 1 }} />
                <div>
                  Your CSV file must include <strong>name</strong> and{' '}
                  <strong>email id</strong> (or <strong>email</strong>) columns. Duplicate
                  email addresses are automatically merged for{' '}
                  <strong>{activeWorkspaceName}</strong>.
                </div>
              </div>

              {contactUploadError && (
                <div className="alert-banner error" style={{ fontSize: '12px' }}>
                  <AlertCircle size={15} style={{ flexShrink: 0, marginTop: 1 }} />
                  <span>{contactUploadError}</span>
                </div>
              )}

              {contactUploadSuccess && (
                <div className="alert-banner success" style={{ fontSize: '12px' }}>
                  <CheckCircle2 size={15} style={{ flexShrink: 0, marginTop: 1 }} />
                  <span>{contactUploadSuccess}</span>
                </div>
              )}

              <label
                className={`csv-upload-dropzone ${selectedContactCsvFile ? 'has-file' : ''}`}
              >
                <Upload size={22} color="var(--primary-indigo)" />
                {selectedContactCsvFile ? (
                  <>
                    <div
                      style={{
                        fontSize: '13px',
                        fontWeight: 700,
                        color: 'var(--text-primary)',
                        wordBreak: 'break-word',
                      }}
                    >
                      {selectedContactCsvFile.name}
                    </div>
                    <div style={{ fontSize: '11.5px', color: 'var(--text-secondary)' }}>
                      {(selectedContactCsvFile.size / 1024).toFixed(1)} KB · Click to choose a different CSV
                    </div>
                  </>
                ) : (
                  <>
                    <div
                      style={{
                        fontSize: '13px',
                        fontWeight: 600,
                        color: 'var(--text-primary)',
                      }}
                    >
                      Click to select a CSV file
                    </div>
                    <div style={{ fontSize: '11.5px', color: 'var(--text-secondary)' }}>
                      Accepted format: <code>.csv</code> with <strong>name</strong> and{' '}
                      <strong>email id</strong> columns
                    </div>
                  </>
                )}
                <input
                  type="file"
                  accept=".csv"
                  style={{ display: 'none' }}
                  disabled={isUploadingContactCsv}
                  onChange={(e) => {
                    const file = e.target.files?.[0] || null;
                    setSelectedContactCsvFile(file);
                    setContactUploadError(null);
                    setContactUploadSuccess(null);
                    e.target.value = '';
                  }}
                />
              </label>

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px' }}>
                <button
                  type="button"
                  className="btn-warm-outlined"
                  onClick={() => setShowUploadContactsModal(false)}
                  disabled={isUploadingContactCsv}
                  style={{ fontSize: '12.5px', padding: '6px 14px' }}
                >
                  Close
                </button>
                <button
                  type="button"
                  className="btn-primary-indigo"
                  disabled={!selectedContactCsvFile || isUploadingContactCsv}
                  onClick={() => handleCsvContactUpload(selectedContactCsvFile)}
                  style={{ fontSize: '12.5px', padding: '6px 16px' }}
                >
                  {isUploadingContactCsv ? (
                    <>
                      <Loader2 size={14} className="spin" />
                      Uploading...
                    </>
                  ) : (
                    <>
                      <Upload size={14} />
                      Upload Contacts CSV
                    </>
                  )}
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
