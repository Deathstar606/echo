import React, { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import {
  Plug,
  Building2,
  X,
  Copy,
  Check,
  KeyRound,
  AlertCircle,
  Loader2,
  LogOut,
  Plus,
  ChevronDown,
  Link2,
} from 'lucide-react';
import {
  checkBackendHealth,
  getGoogleAuthStatusApi,
  getGoogleAuthUrlApi,
  getUserWorkspacesApi,
  createWorkspaceApi,
} from '../services/api';
import {
  getActiveWorkspaceId,
  getActiveWorkspaceName,
  setActiveWorkspace,
  clearActiveWorkspace,
  getLoggedInUser,
  setLoggedInUser,
} from '../config/constants';

function GoogleGLogo({ size = 15 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M23.745 12.27c0-.7-.06-1.4-.19-2.07H12v4.51h6.6c-.29 1.52-1.14 2.82-2.4 3.68v3.05h3.88c2.27-2.09 3.66-5.17 3.66-9.17z"
      />
      <path
        fill="#34A853"
        d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.88-3.05c-1.08.72-2.45 1.16-4.05 1.16-3.12 0-5.77-2.1-6.72-4.93H1.25v3.15C3.26 21.36 7.34 24 12 24z"
      />
      <path
        fill="#FBBC05"
        d="M5.28 14.27c-.25-.72-.38-1.49-.38-2.27s.13-1.55.38-2.27V6.58H1.25C.45 8.18 0 9.99 0 12s.45 3.82 1.25 5.42l4.03-3.15z"
      />
      <path
        fill="#EA4335"
        d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42C17.95 1.19 15.24 0 12 0 7.34 0 3.26 2.64 1.25 6.58l4.03 3.15c.95-2.83 3.6-4.98 6.72-4.98z"
      />
    </svg>
  );
}

export default function TopHeader() {
  const location = useLocation();
  const navigate = useNavigate();
  const [apiConnected, setApiConnected] = useState(true);

  const [currentUser, setCurrentUser] = useState(() => getLoggedInUser());
  const [currentWsId, setCurrentWsId] = useState(() => getActiveWorkspaceId());
  const [currentWsName, setCurrentWsName] = useState(() => getActiveWorkspaceName());

  const [userWorkspaces, setUserWorkspaces] = useState([]);
  const [showWsDropdown, setShowWsDropdown] = useState(false);
  const [showCreateWsModal, setShowCreateWsModal] = useState(false);
  const [newWsName, setNewWsName] = useState('');
  const [isCreatingWs, setIsCreatingWs] = useState(false);
  const [createWsError, setCreateWsError] = useState(null);

  const [googleAuth, setGoogleAuth] = useState({ connected: false, user: null, loading: true });
  const [googleAuthErrorBanner, setGoogleAuthErrorBanner] = useState(null);
  const [googleLinkedNotice, setGoogleLinkedNotice] = useState(null);
  const [showUserDropdown, setShowUserDropdown] = useState(false);
  const [copiedId, setCopiedId] = useState(false);

  // Listen to global authChanged / workspaceChanged / openCreateWorkspaceModal events
  useEffect(() => {
    const handleAuthSync = () => {
      setCurrentUser(getLoggedInUser());
      setCurrentWsId(getActiveWorkspaceId());
      setCurrentWsName(getActiveWorkspaceName());
    };
    const handleWorkspaceSync = () => {
      setCurrentWsId(getActiveWorkspaceId());
      setCurrentWsName(getActiveWorkspaceName());
    };
    const handleOpenCreateModal = () => {
      if (!getLoggedInUser()?.id) {
        navigate('/');
        return;
      }
      setCreateWsError(null);
      setShowWsDropdown(false);
      setShowCreateWsModal(true);
    };

    window.addEventListener('authChanged', handleAuthSync);
    window.addEventListener('workspaceChanged', handleWorkspaceSync);
    window.addEventListener('openCreateWorkspaceModal', handleOpenCreateModal);
    return () => {
      window.removeEventListener('authChanged', handleAuthSync);
      window.removeEventListener('workspaceChanged', handleWorkspaceSync);
      window.removeEventListener('openCreateWorkspaceModal', handleOpenCreateModal);
    };
  }, [navigate]);

  // Handle Google OAuth login & Google account-linking callbacks
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    if (params.get('google_auth') === 'success') {
      const googleUserId = params.get('user_id');
      const googleEmail = params.get('email');
      const googleName = params.get('name');
      if (googleUserId) {
        const profile = { id: googleUserId, email: googleEmail, name: googleName };
        setLoggedInUser(profile);
        setCurrentUser(profile);
        setGoogleAuthErrorBanner(null);
        window.dispatchEvent(new Event('authChanged'));
      }
      navigate(location.pathname, { replace: true });
    } else if (params.get('google_linked') === 'success') {
      const linkedEmail = params.get('google_email');
      const requestedTab = params.get('tab');
      setGoogleAuthErrorBanner(null);
      setGoogleLinkedNotice(
        linkedEmail
          ? `Google account (${linkedEmail}) linked! You can now import Google Sheets & Docs.`
          : 'Google account linked! You can now import Google Sheets & Docs.'
      );
      if (requestedTab) {
        window.dispatchEvent(new CustomEvent('switchCompanyTab', { detail: requestedTab }));
      }
      window.dispatchEvent(new Event('authChanged'));
      const cleanUrl = requestedTab
        ? `${location.pathname}?tab=${encodeURIComponent(requestedTab)}`
        : location.pathname;
      navigate(cleanUrl, { replace: true });
    } else if (params.get('google_auth_error') && location.pathname !== '/') {
      setGoogleAuthErrorBanner(params.get('google_auth_error'));
      const requestedTab = params.get('tab');
      const cleanUrl = requestedTab
        ? `${location.pathname}?tab=${encodeURIComponent(requestedTab)}`
        : location.pathname;
      navigate(cleanUrl, { replace: true });
    }
  }, [location.search, navigate, location.pathname]);

  // Strict Workspace Visibility: load workspaces ONLY for the signed-in user ID
  useEffect(() => {
    let mounted = true;

    async function syncUserWorkspaces() {
      if (!currentUser?.id) {
        if (!mounted) return;
        setUserWorkspaces([]);
        clearActiveWorkspace(true);
        setCurrentWsId('');
        setCurrentWsName('');
        setShowWsDropdown(false);
        window.dispatchEvent(new Event('workspaceChanged'));
        return;
      }

      try {
        const list = await getUserWorkspacesApi(currentUser.id);
        if (!mounted || !Array.isArray(list)) return;

        setUserWorkspaces(list);
        const storedWsId = getActiveWorkspaceId();

        if (list.length > 0) {
          const matched = list.find((w) => w.id === storedWsId);
          if (!matched) {
            setActiveWorkspace(list[0].id, list[0].name);
            setCurrentWsId(list[0].id);
            setCurrentWsName(list[0].name);
            window.dispatchEvent(new Event('workspaceChanged'));
          } else {
            setActiveWorkspace(matched.id, matched.name);
            setCurrentWsId(matched.id);
            setCurrentWsName(matched.name);
          }
        } else {
          clearActiveWorkspace(true);
          setCurrentWsId('');
          setCurrentWsName('No Workspace Selected');
          if (storedWsId) {
            window.dispatchEvent(new Event('workspaceChanged'));
          }
        }
      } catch {
        // Keep current state cleanly on transient network issue
      }
    }

    syncUserWorkspaces();
    return () => {
      mounted = false;
    };
  }, [currentUser?.id]);

  // Check Google Auth Status strictly for signed-in user (also re-checks on authChanged)
  useEffect(() => {
    let mounted = true;
    async function checkGoogleStatus() {
      if (!currentUser?.id) {
        if (mounted) {
          setGoogleAuth({ connected: false, user: null, loading: false });
        }
        return;
      }

      try {
        const res = await getGoogleAuthStatusApi(currentUser.id);
        if (mounted) {
          setGoogleAuth({
            connected: Boolean(res.connected),
            user: res.user || null,
            loading: false,
          });
        }
      } catch {
        if (mounted) {
          setGoogleAuth({ connected: false, user: null, loading: false });
        }
      }
    }

    checkGoogleStatus();
    window.addEventListener('authChanged', checkGoogleStatus);
    return () => {
      mounted = false;
      window.removeEventListener('authChanged', checkGoogleStatus);
    };
  }, [currentUser?.id]);

  // Health check polling
  useEffect(() => {
    let mounted = true;
    async function verifyHealth() {
      try {
        await checkBackendHealth();
        if (mounted) setApiConnected(true);
      } catch {
        if (mounted) setApiConnected(false);
      }
    }
    verifyHealth();
    const interval = setInterval(verifyHealth, 15000);
    return () => {
      mounted = false;
      clearInterval(interval);
    };
  }, []);

  const handleSelectWorkspace = (ws) => {
    setActiveWorkspace(ws.id, ws.name);
    setCurrentWsId(ws.id);
    setCurrentWsName(ws.name);
    setShowWsDropdown(false);
    window.dispatchEvent(new Event('workspaceChanged'));
  };

  const handleCreateWorkspace = async (e) => {
    e.preventDefault();
    setCreateWsError(null);
    const trimmed = newWsName.trim();
    if (!trimmed) {
      setCreateWsError('Please enter a workspace name.');
      return;
    }

    if (!currentUser?.id) {
      setCreateWsError('Please sign in first before creating a new workspace.');
      return;
    }

    setIsCreatingWs(true);
    try {
      const created = await createWorkspaceApi({ name: trimmed, userId: currentUser.id });
      setUserWorkspaces((prev) => [...prev, created]);
      setActiveWorkspace(created.id, created.name);
      setCurrentWsId(created.id);
      setCurrentWsName(created.name);
      setNewWsName('');
      setShowCreateWsModal(false);
      setShowWsDropdown(false);
      window.dispatchEvent(new Event('workspaceChanged'));
    } catch (err) {
      setCreateWsError(err?.message || 'Failed to create workspace.');
    } finally {
      setIsCreatingWs(false);
    }
  };

  const handleGoogleSignInOrLink = async (linkMode = false) => {
    try {
      const url = linkMode && currentUser?.id
        ? await getGoogleAuthUrlApi(currentUser.id, {
            mode: 'link',
            userId: currentUser.id,
            workspaceId: currentWsId,
          })
        : await getGoogleAuthUrlApi('');
      window.location.href = url;
    } catch (err) {
      setGoogleAuthErrorBanner(err?.message || 'Could not start Google authentication.');
    }
  };

  const handleSignOut = () => {
    setLoggedInUser(null);
    clearActiveWorkspace(true);
    setCurrentUser(null);
    setUserWorkspaces([]);
    setCurrentWsId('');
    setCurrentWsName('');
    setGoogleAuth({ connected: false, user: null, loading: false });
    setShowUserDropdown(false);
    setShowWsDropdown(false);
    window.dispatchEvent(new Event('authChanged'));
    window.dispatchEvent(new Event('workspaceChanged'));
    navigate('/');
  };

  const handleCopyId = async () => {
    if (!currentWsId) return;
    try {
      await navigator.clipboard.writeText(currentWsId);
      setCopiedId(true);
      setTimeout(() => setCopiedId(false), 2000);
    } catch {
      // Fallback
    }
  };

  const effectiveUser = currentUser?.id
    ? {
        ...currentUser,
        picture:
          currentUser.picture ||
          (googleAuth.connected ? googleAuth.user?.picture || null : null),
      }
    : null;
  const userInitials = (effectiveUser?.name || 'User')
    .split(' ')
    .map((n) => n[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();

  return (
    <>
      <header className="top-header">
        {/* Left Cluster: Brand & Workspace Selector (Workspace Switcher ONLY visible when signed in) */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '14px', flexWrap: 'wrap' }}>
          <Link to="/" className="brand-cluster">
            <div className="brand-logo-box">M</div>
            <div className="brand-text-stack">
              <span className="brand-title">MaxiText AI Studio</span>
              <span className="brand-subtitle">Autonomous B2B Operations</span>
            </div>
          </Link>

          {effectiveUser && (
            <>
              <span className="header-divider" aria-hidden="true">/</span>

              <div style={{ position: 'relative' }}>
                <button
                  type="button"
                  onClick={() => {
                    setShowUserDropdown(false);
                    setShowWsDropdown((prev) => !prev);
                  }}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '8px',
                    padding: '6px 12px',
                    borderRadius: '10px',
                    fontSize: '12.5px',
                    fontWeight: 700,
                    color: 'var(--text-primary)',
                    backgroundColor: '#ffffff',
                    border: '1px solid var(--border-warm)',
                    boxShadow: 'var(--shadow-card)',
                    cursor: 'pointer',
                  }}
                >
                  <Building2 size={14} color="var(--primary-indigo)" />
                  <span
                    style={{
                      maxWidth: '210px',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {currentWsName || 'No Workspace Selected'}
                  </span>
                  <ChevronDown size={14} color="var(--text-muted)" />
                </button>

                {showWsDropdown && (
                  <div
                    style={{
                      position: 'absolute',
                      top: 'calc(100% + 6px)',
                      left: 0,
                      backgroundColor: '#ffffff',
                      border: '1px solid var(--border-warm)',
                      borderRadius: '12px',
                      boxShadow: '0 12px 30px rgba(0,0,0,0.12)',
                      minWidth: '280px',
                      maxWidth: '340px',
                      zIndex: 100,
                      padding: '8px',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '4px',
                    }}
                  >
                    <div
                      style={{
                        fontSize: '11px',
                        fontWeight: 700,
                        color: 'var(--text-secondary)',
                        textTransform: 'uppercase',
                        letterSpacing: '0.05em',
                        padding: '4px 8px',
                      }}
                    >
                      Your Workspaces ({userWorkspaces.length})
                    </div>

                    {userWorkspaces.length === 0 ? (
                      <div
                        style={{
                          padding: '10px',
                          fontSize: '12px',
                          color: 'var(--text-secondary)',
                          fontStyle: 'italic',
                        }}
                      >
                        No workspaces found for your account yet.
                      </div>
                    ) : (
                      <div
                        style={{
                          maxHeight: '220px',
                          overflowY: 'auto',
                          display: 'flex',
                          flexDirection: 'column',
                          gap: '2px',
                        }}
                      >
                        {userWorkspaces.map((ws) => (
                          <button
                            key={ws.id}
                            type="button"
                            onClick={() => handleSelectWorkspace(ws)}
                            style={{
                              textAlign: 'left',
                              padding: '8px 10px',
                              borderRadius: '8px',
                              backgroundColor:
                                ws.id === currentWsId
                                  ? 'var(--accent-lavender-bg)'
                                  : 'transparent',
                              border: 'none',
                              cursor: 'pointer',
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'space-between',
                              gap: '6px',
                            }}
                          >
                            <div
                              style={{
                                display: 'flex',
                                flexDirection: 'column',
                                gap: '2px',
                                overflow: 'hidden',
                              }}
                            >
                              <span
                                style={{
                                  fontSize: '12.5px',
                                  fontWeight: ws.id === currentWsId ? 700 : 500,
                                  color: 'var(--text-primary)',
                                }}
                              >
                                {ws.name}
                              </span>
                              <code style={{ fontSize: '10.5px', color: 'var(--text-muted)' }}>
                                {ws.id.slice(0, 18)}...
                              </code>
                            </div>
                            {ws.id === currentWsId && (
                              <Check size={14} color="var(--primary-indigo)" />
                            )}
                          </button>
                        ))}
                      </div>
                    )}

                    <div
                      style={{
                        height: '1px',
                        backgroundColor: 'var(--border-warm)',
                        margin: '4px 0',
                      }}
                    />

                    <button
                      type="button"
                      onClick={() => {
                        setShowWsDropdown(false);
                        setShowCreateWsModal(true);
                      }}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '6px',
                        padding: '8px 10px',
                        borderRadius: '8px',
                        backgroundColor: '#f8fafc',
                        border: '1px dashed var(--border-warm-strong)',
                        cursor: 'pointer',
                        fontSize: '12px',
                        fontWeight: 600,
                        color: 'var(--primary-indigo)',
                        justifyContent: 'center',
                      }}
                    >
                      <Plus size={14} />
                      Create New Workspace
                    </button>
                  </div>
                )}
              </div>
            </>
          )}
        </div>

        {/* Right Cluster: API Status & User Account / Auth Controls */}
        <div className="header-right-cluster">
          <div
            className="api-status-indicator"
            title={
              apiConnected
                ? 'Connected to Echo Node.js Backend'
                : 'Backend Unreachable'
            }
          >
            <Plug
              size={14}
              style={{
                color: apiConnected ? '#2b3440' : '#dc2626',
                transform: 'rotate(45deg)',
              }}
            />
            <span className={`api-status-dot ${apiConnected ? '' : 'offline'}`} />
            <span>{apiConnected ? 'API Connected' : 'API Offline'}</span>
          </div>

          {effectiveUser ? (
            <div style={{ position: 'relative' }}>
              <button
                type="button"
                onClick={() => {
                  setShowWsDropdown(false);
                  setShowUserDropdown((prev) => !prev);
                }}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '8px',
                  padding: '4px 12px 4px 6px',
                  borderRadius: '999px',
                  backgroundColor: '#ffffff',
                  border: '1px solid var(--border-warm)',
                  boxShadow: 'var(--shadow-card)',
                  cursor: 'pointer',
                }}
              >
                {effectiveUser.picture ? (
                  <img
                    src={effectiveUser.picture}
                    alt={effectiveUser.name}
                    referrerPolicy="no-referrer"
                    style={{
                      width: 28,
                      height: 28,
                      borderRadius: '50%',
                      objectFit: 'cover',
                      border: '1.5px solid #10b981',
                    }}
                  />
                ) : (
                  <div
                    style={{
                      width: 28,
                      height: 28,
                      borderRadius: '50%',
                      backgroundColor: 'var(--primary-indigo)',
                      color: '#ffffff',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontSize: '11px',
                      fontWeight: 700,
                    }}
                  >
                    {userInitials}
                  </div>
                )}
                <div
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'flex-start',
                    textAlign: 'left',
                    lineHeight: 1.15,
                  }}
                >
                  <span style={{ fontSize: '12.5px', fontWeight: 700, color: '#1e293b' }}>
                    {effectiveUser.name}
                  </span>
                  <span
                    style={{
                      fontSize: '10px',
                      color: googleAuth.connected ? '#059669' : '#64748b',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '4px',
                      fontWeight: 600,
                    }}
                  >
                    <span
                      style={{
                        width: 6,
                        height: 6,
                        borderRadius: '50%',
                        backgroundColor: googleAuth.connected ? '#10b981' : '#94a3b8',
                      }}
                    />
                    {googleAuth.connected ? 'Google Connected' : 'Email Signed In'}
                  </span>
                </div>
                <ChevronDown size={13} color="var(--text-muted)" />
              </button>

              {showUserDropdown && (
                <div
                  style={{
                    position: 'absolute',
                    top: 'calc(100% + 6px)',
                    right: 0,
                    backgroundColor: '#ffffff',
                    border: '1px solid var(--border-warm)',
                    borderRadius: '12px',
                    boxShadow: '0 12px 30px rgba(0,0,0,0.12)',
                    padding: '12px',
                    minWidth: '250px',
                    zIndex: 100,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '10px',
                  }}
                >
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                    <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                      Signed in as:
                    </span>
                    <strong style={{ fontSize: '13px', color: 'var(--text-primary)' }}>
                      {effectiveUser.name}
                    </strong>
                    <span
                      style={{
                        fontSize: '11.5px',
                        color: 'var(--text-secondary)',
                        wordBreak: 'break-all',
                      }}
                    >
                      {effectiveUser.email}
                    </span>
                  </div>

                  <div style={{ height: '1px', backgroundColor: 'var(--border-warm)' }} />

                  {!googleAuth.connected && (
                    <button
                      type="button"
                      onClick={() => handleGoogleSignInOrLink(true)}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        gap: '7px',
                        padding: '7px 10px',
                        borderRadius: '8px',
                        backgroundColor: '#eff6ff',
                        border: '1px solid #bfdbfe',
                        fontSize: '12px',
                        fontWeight: 600,
                        color: '#1d4ed8',
                        cursor: 'pointer',
                      }}
                    >
                      <Link2 size={13} />
                      Connect Google Account
                    </button>
                  )}

                  {currentWsId && (
                    <button
                      type="button"
                      onClick={handleCopyId}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '6px',
                        padding: '7px 10px',
                        borderRadius: '8px',
                        backgroundColor: '#f8fafc',
                        border: '1px solid var(--border-warm)',
                        fontSize: '11.5px',
                        color: 'var(--text-secondary)',
                        cursor: 'pointer',
                      }}
                    >
                      {copiedId ? <Check size={12} color="#16a34a" /> : <Copy size={12} />}
                      {copiedId ? 'Copied Workspace ID!' : 'Copy Active Workspace ID'}
                    </button>
                  )}

                  <button
                    type="button"
                    onClick={handleSignOut}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '6px',
                      padding: '7px 10px',
                      fontSize: '12px',
                      color: '#dc2626',
                      border: '1px solid #fee2e2',
                      backgroundColor: '#fef2f2',
                      borderRadius: '8px',
                      cursor: 'pointer',
                      fontWeight: 600,
                    }}
                  >
                    <LogOut size={13} />
                    Sign Out
                  </button>
                </div>
              )}
            </div>
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <Link
                to="/"
                className="btn-warm-outlined"
                style={{
                  textDecoration: 'none',
                  padding: '6px 14px',
                  borderRadius: '999px',
                  fontSize: '12.5px',
                }}
              >
                <KeyRound size={13} />
                Sign In
              </Link>
              <button
                type="button"
                className="header-google-btn"
                onClick={() => handleGoogleSignInOrLink(false)}
                title="Sign in with Google"
              >
                <GoogleGLogo size={14} />
                Sign in with Google
              </button>
            </div>
          )}
        </div>
      </header>

      {googleLinkedNotice && (
        <div
          style={{
            margin: '10px 24px 0 24px',
            padding: '9px 14px',
            borderRadius: '10px',
            backgroundColor: '#ecfdf5',
            border: '1px solid #a7f3d0',
            color: '#065f46',
            fontSize: '12.5px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '8px',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Check size={15} color="#059669" style={{ flexShrink: 0 }} />
            <span>{googleLinkedNotice}</span>
          </div>
          <button
            type="button"
            onClick={() => setGoogleLinkedNotice(null)}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#065f46' }}
            aria-label="Dismiss notice"
          >
            <X size={15} />
          </button>
        </div>
      )}

      {googleAuthErrorBanner && (
        <div
          style={{
            margin: '10px 24px 0 24px',
            padding: '9px 14px',
            borderRadius: '10px',
            backgroundColor: '#fef2f2',
            border: '1px solid #fecaca',
            color: '#b91c1c',
            fontSize: '12.5px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '8px',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <AlertCircle size={15} style={{ flexShrink: 0 }} />
            <span>Google Sign-In error: {googleAuthErrorBanner}</span>
          </div>
          <button
            type="button"
            onClick={() => setGoogleAuthErrorBanner(null)}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#b91c1c' }}
            aria-label="Dismiss Google sign-in error"
          >
            <X size={15} />
          </button>
        </div>
      )}

      {/* Create New Workspace Modal */}
      <AnimatePresence>
        {showCreateWsModal && (
          <motion.div
            className="modal-backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => setShowCreateWsModal(false)}
          >
            <motion.div
              className="modal-card liquid-glass-modal"
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 8 }}
              onClick={(e) => e.stopPropagation()}
              style={{ maxWidth: '480px', gap: '14px', borderRadius: '16px' }}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
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
                    }}
                  >
                    <Building2 size={18} />
                  </div>
                  <div>
                    <h3 style={{ fontSize: '16px', fontWeight: 700, margin: 0 }}>
                      Create New Workspace
                    </h3>
                    <p style={{ fontSize: '12px', color: 'var(--text-secondary)', margin: 0 }}>
                      Add an isolated workspace for inventory, documents, and workflows
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  className="icon-action-btn"
                  onClick={() => setShowCreateWsModal(false)}
                >
                  <X size={18} />
                </button>
              </div>

              {createWsError && (
                <div className="alert-banner error" style={{ fontSize: '12px' }}>
                  <AlertCircle size={14} style={{ flexShrink: 0 }} />
                  <span>{createWsError}</span>
                </div>
              )}

              <form onSubmit={handleCreateWorkspace} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
                <div className="form-group">
                  <label className="form-label" htmlFor="new-ws-name">
                    Workspace Organization Name <span style={{ color: '#dc2626' }}>*</span>
                  </label>
                  <input
                    id="new-ws-name"
                    type="text"
                    className="form-input"
                    value={newWsName}
                    onChange={(e) => setNewWsName(e.target.value)}
                    placeholder="e.g., Nexus Commercial Logistics, Acme Supply Co."
                    disabled={isCreatingWs}
                    required
                  />
                </div>

                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px' }}>
                  <button
                    type="button"
                    className="btn-warm-outlined"
                    onClick={() => setShowCreateWsModal(false)}
                    disabled={isCreatingWs}
                    style={{ fontSize: '12.5px', padding: '6px 14px' }}
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    className="btn-primary-indigo"
                    disabled={isCreatingWs || !newWsName.trim()}
                    style={{ fontSize: '12.5px', padding: '6px 16px' }}
                  >
                    {isCreatingWs ? (
                      <>
                        <Loader2 size={14} className="spin" />
                        Creating...
                      </>
                    ) : (
                      'Create Workspace'
                    )}
                  </button>
                </div>
              </form>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
