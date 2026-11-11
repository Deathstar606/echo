import React, { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Building2,
  KeyRound,
  UserPlus,
  ArrowRight,
  ShieldCheck,
  CheckCircle2,
  AlertCircle,
  Loader2,
  Mail,
  Lock,
  User,
  Sparkles,
  LayoutDashboard,
  MessageSquare,
} from 'lucide-react';
import {
  getActiveWorkspaceId,
  getActiveWorkspaceName,
  setActiveWorkspace,
  clearActiveWorkspace,
  setLoggedInUser,
  getLoggedInUser,
} from '../config/constants';
import { loginApi, registerApi, getGoogleAuthUrlApi } from '../services/api';

export default function LandingPage() {
  const navigate = useNavigate();
  const location = useLocation();

  const [activeWsId, setActiveWsId] = useState(getActiveWorkspaceId());
  const [activeWsName, setActiveWsName] = useState(getActiveWorkspaceName());
  const [currentUser, setCurrentUserState] = useState(getLoggedInUser());

  const [authMode, setAuthMode] = useState('login'); // 'login' | 'register'
  const [emailInput, setEmailInput] = useState('');
  const [passwordInput, setPasswordInput] = useState('');
  const [nameInput, setNameInput] = useState('');

  const [isLoading, setIsLoading] = useState(false);
  const [isGoogleLoading, setIsGoogleLoading] = useState(false);
  const [authError, setAuthError] = useState(null);
  const [authSuccessMessage, setAuthSuccessMessage] = useState(null);

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const gErr = params.get('google_auth_error');
    if (gErr) {
      setAuthError(gErr);
      navigate(location.pathname, { replace: true });
    }
  }, [location.search, location.pathname, navigate]);

  useEffect(() => {
    const syncState = () => {
      setCurrentUserState(getLoggedInUser());
      setActiveWsId(getActiveWorkspaceId());
      setActiveWsName(getActiveWorkspaceName());
    };
    window.addEventListener('authChanged', syncState);
    window.addEventListener('workspaceChanged', syncState);
    return () => {
      window.removeEventListener('authChanged', syncState);
      window.removeEventListener('workspaceChanged', syncState);
    };
  }, []);

  // Email + Password Sign In
  const handleLoginSubmit = async (e) => {
    e.preventDefault();
    setAuthError(null);
    setAuthSuccessMessage(null);

    const email = emailInput.trim();
    const pass = passwordInput;
    if (!email || !pass) {
      setAuthError('Please enter both your email address and password.');
      return;
    }

    setIsLoading(true);
    try {
      const res = await loginApi({ email, password: pass });
      setLoggedInUser(res.user);
      setCurrentUserState(res.user);

      if (res.workspaces && res.workspaces.length > 0) {
        const primaryWs = res.workspaces[0];
        setActiveWorkspace(primaryWs.id, primaryWs.name);
        setActiveWsId(primaryWs.id);
        setActiveWsName(primaryWs.name);
      } else {
        clearActiveWorkspace(true);
        setActiveWsId('');
        setActiveWsName('No Workspace Selected');
      }

      window.dispatchEvent(new Event('authChanged'));
      window.dispatchEvent(new Event('workspaceChanged'));

      setAuthSuccessMessage(`Welcome back, ${res.user.name}! Redirecting...`);
      setTimeout(() => {
        navigate('/company');
      }, 700);
    } catch (err) {
      setAuthError(err?.message || 'Login failed. Please check your credentials.');
    } finally {
      setIsLoading(false);
    }
  };

  // User Account Registration
  const handleRegisterSubmit = async (e) => {
    e.preventDefault();
    setAuthError(null);
    setAuthSuccessMessage(null);

    const name = nameInput.trim();
    const email = emailInput.trim();
    const pass = passwordInput;

    if (!name || !email || !pass) {
      setAuthError('Please fill out all fields to register.');
      return;
    }

    setIsLoading(true);
    try {
      const res = await registerApi({ name, email, password: pass });
      setLoggedInUser(res.user);
      setCurrentUserState(res.user);

      if (res.workspaces && res.workspaces.length > 0) {
        const primaryWs = res.workspaces[0];
        setActiveWorkspace(primaryWs.id, primaryWs.name);
        setActiveWsId(primaryWs.id);
        setActiveWsName(primaryWs.name);
      } else {
        clearActiveWorkspace(true);
        setActiveWsId('');
        setActiveWsName('No Workspace Selected');
      }

      window.dispatchEvent(new Event('authChanged'));
      window.dispatchEvent(new Event('workspaceChanged'));

      setAuthSuccessMessage(`Account created for ${res.user.name}! Provisioning workspace...`);
      setTimeout(() => {
        navigate('/company');
      }, 800);
    } catch (err) {
      setAuthError(err?.message || 'Registration failed.');
    } finally {
      setIsLoading(false);
    }
  };

  // Sign In with Google
  const handleGoogleSignIn = async () => {
    setAuthError(null);
    setIsGoogleLoading(true);
    try {
      const url = await getGoogleAuthUrlApi('');
      if (url) {
        window.location.href = url;
      } else {
        throw new Error('Could not obtain Google authentication URL.');
      }
    } catch (err) {
      setAuthError(err?.message || 'Failed to initiate Google sign-in.');
      setIsGoogleLoading(false);
    }
  };

  return (
    <motion.div
      className="customer-portal-container"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.22 }}
      style={{ maxWidth: '980px', margin: '0 auto', display: 'flex', flexDirection: 'column', gap: '20px' }}
    >
      {/* Hero Banner */}
      <div
        className="portal-card"
        style={{
          textAlign: 'center',
          padding: '32px 24px',
          alignItems: 'center',
          background: 'linear-gradient(180deg, #faf7f2 0%, #f3ece0 100%)',
        }}
      >
        <span className="beta-pill" style={{ marginBottom: '6px' }}>
          MAXITEXT AI STUDIO • AUTONOMOUS B2B OPERATIONS
        </span>
        <h1
          style={{
            fontFamily: "'Plus Jakarta Sans', sans-serif",
            fontSize: '27px',
            fontWeight: 800,
            maxWidth: '720px',
            lineHeight: 1.25,
            color: 'var(--text-primary)',
          }}
        >
          Sign in to Your Echo Workspace Account
        </h1>
        <p
          style={{
            fontSize: '14px',
            color: 'var(--text-secondary)',
            maxWidth: '640px',
            lineHeight: 1.5,
          }}
        >
          Access your workspaces, company inquiry inbox, real-time spreadsheet intelligence, cross-document RAG,
          and Socratic conflict resolution gate by logging in or connecting with Google.
        </p>

        {/* Active Workspace Indicator Bar (only shown when signed in) */}
        <div
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '10px',
            padding: '7px 16px',
            borderRadius: '999px',
            backgroundColor: '#ffffff',
            border: '1px solid var(--border-warm)',
            fontSize: '12.5px',
            color: 'var(--text-secondary)',
            flexWrap: 'wrap',
            justifyContent: 'center',
            boxShadow: 'var(--shadow-card)',
          }}
        >
          {currentUser?.id ? (
            activeWsId ? (
              <>
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <Building2 size={15} color="var(--primary-indigo)" />
                  <span>Active Workspace:</span>
                  <strong style={{ color: 'var(--text-primary)' }}>{activeWsName}</strong>
                </div>
                <span style={{ color: 'var(--border-warm-strong)' }}>•</span>
                <code style={{ fontSize: '12px', fontWeight: 700, color: 'var(--primary-indigo)' }}>
                  {activeWsId}
                </code>
                <Link
                  to="/company"
                  className="btn-primary-indigo"
                  style={{
                    padding: '4px 12px',
                    fontSize: '11.5px',
                    borderRadius: '999px',
                    textDecoration: 'none',
                    marginLeft: '4px',
                  }}
                >
                  Launch Dashboard
                  <ArrowRight size={12} />
                </Link>
              </>
            ) : (
              <>
                <User size={15} color="var(--primary-indigo)" />
                <span>
                  Signed in as <strong style={{ color: 'var(--text-primary)' }}>{currentUser.name}</strong> • No workspace created yet
                </span>
                <Link
                  to="/company"
                  className="btn-primary-indigo"
                  style={{
                    padding: '4px 12px',
                    fontSize: '11.5px',
                    borderRadius: '999px',
                    textDecoration: 'none',
                    marginLeft: '4px',
                  }}
                >
                  Open Dashboard
                  <ArrowRight size={12} />
                </Link>
              </>
            )
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <ShieldCheck size={15} color="var(--primary-indigo)" />
              <span>Sign in with your account or Google below to access your private workspaces</span>
            </div>
          )}
        </div>
      </div>

      {/* Main Authentication Card */}
      <div className="portal-card" style={{ padding: '28px 24px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
        {/* Tab Toggle: Sign In vs Create Account */}
        <div
          style={{
            display: 'flex',
            borderBottom: '1px solid var(--border-warm)',
            paddingBottom: '4px',
            gap: '12px',
          }}
        >
          <button
            type="button"
            onClick={() => {
              setAuthMode('login');
              setAuthError(null);
              setAuthSuccessMessage(null);
            }}
            style={{
              background: 'none',
              border: 'none',
              padding: '8px 16px',
              fontSize: '14px',
              fontWeight: 700,
              cursor: 'pointer',
              color: authMode === 'login' ? 'var(--primary-indigo)' : 'var(--text-secondary)',
              borderBottom: authMode === 'login' ? '2px solid var(--primary-indigo)' : '2px solid transparent',
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
            }}
          >
            <KeyRound size={15} />
            Sign In with Email
          </button>
          <button
            type="button"
            onClick={() => {
              setAuthMode('register');
              setAuthError(null);
              setAuthSuccessMessage(null);
            }}
            style={{
              background: 'none',
              border: 'none',
              padding: '8px 16px',
              fontSize: '14px',
              fontWeight: 700,
              cursor: 'pointer',
              color: authMode === 'register' ? 'var(--primary-indigo)' : 'var(--text-secondary)',
              borderBottom: authMode === 'register' ? '2px solid var(--primary-indigo)' : '2px solid transparent',
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
            }}
          >
            <UserPlus size={15} />
            Create Account
          </button>
        </div>

        {/* Feedback Messages */}
        <AnimatePresence>
          {authError && (
            <motion.div
              initial={{ opacity: 0, y: -6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              className="error-banner"
              style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px' }}
            >
              <AlertCircle size={16} />
              <span>{authError}</span>
            </motion.div>
          )}
          {authSuccessMessage && (
            <motion.div
              initial={{ opacity: 0, y: -6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                fontSize: '13px',
                padding: '10px 14px',
                borderRadius: '8px',
                backgroundColor: '#ecfdf5',
                color: '#065f46',
                border: '1px solid #a7f3d0',
              }}
            >
              <CheckCircle2 size={16} color="#059669" />
              <span>{authSuccessMessage}</span>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Sign In with Google Option (Always Available) */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '4px' }}>
          <button
            type="button"
            onClick={handleGoogleSignIn}
            disabled={isGoogleLoading || isLoading}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '10px',
              padding: '10px 16px',
              borderRadius: '8px',
              border: '1px solid var(--border-warm-strong)',
              backgroundColor: '#ffffff',
              color: 'var(--text-primary)',
              fontSize: '13.5px',
              fontWeight: 600,
              cursor: 'pointer',
              boxShadow: '0 1px 2px rgba(0,0,0,0.05)',
              transition: 'background-color 0.15s ease',
            }}
          >
            {isGoogleLoading ? (
              <>
                <Loader2 size={16} className="spin" />
                Connecting to Google...
              </>
            ) : (
              <>
                <svg width="18" height="18" viewBox="0 0 24 24">
                  <path
                    fill="#4285F4"
                    d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
                  />
                  <path
                    fill="#34A853"
                    d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                  />
                  <path
                    fill="#FBBC05"
                    d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z"
                  />
                  <path
                    fill="#EA4335"
                    d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z"
                  />
                </svg>
                Continue with Google
              </>
            )}
          </button>

          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', margin: '8px 0' }}>
            <div style={{ flex: 1, height: '1px', backgroundColor: 'var(--border-warm)' }} />
            <span style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 600 }}>OR</span>
            <div style={{ flex: 1, height: '1px', backgroundColor: 'var(--border-warm)' }} />
          </div>
        </div>

        {/* Tab 1: Email + Password Login Form */}
        {authMode === 'login' && (
          <form onSubmit={handleLoginSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
            <div className="form-group">
              <label className="form-label" htmlFor="email-input">
                Email Address <span style={{ color: '#dc2626' }}>*</span>
              </label>
              <div style={{ position: 'relative' }}>
                <input
                  id="email-input"
                  type="email"
                  className="form-input"
                  value={emailInput}
                  onChange={(e) => setEmailInput(e.target.value)}
                  placeholder="name@example.com"
                  disabled={isLoading}
                  required
                  style={{ paddingLeft: '32px' }}
                />
                <Mail
                  size={14}
                  color="var(--text-muted)"
                  style={{ position: 'absolute', left: '10px', top: '50%', transform: 'translateY(-50%)' }}
                />
              </div>
            </div>

            <div className="form-group">
              <label className="form-label" htmlFor="password-input">
                Password <span style={{ color: '#dc2626' }}>*</span>
              </label>
              <div style={{ position: 'relative' }}>
                <input
                  id="password-input"
                  type="password"
                  className="form-input"
                  value={passwordInput}
                  onChange={(e) => setPasswordInput(e.target.value)}
                  placeholder="••••••••"
                  disabled={isLoading}
                  required
                  style={{ paddingLeft: '32px' }}
                />
                <Lock
                  size={14}
                  color="var(--text-muted)"
                  style={{ position: 'absolute', left: '10px', top: '50%', transform: 'translateY(-50%)' }}
                />
              </div>
            </div>

            <button
              type="submit"
              className="btn-primary-indigo"
              disabled={isLoading || !emailInput.trim() || !passwordInput}
              style={{ padding: '10px 16px', fontSize: '13.5px', marginTop: '4px' }}
            >
              {isLoading ? (
                <>
                  <Loader2 size={16} className="spin" />
                  Authenticating...
                </>
              ) : (
                <>
                  <KeyRound size={15} />
                  Sign In &amp; Open Workspace
                  <ArrowRight size={15} />
                </>
              )}
            </button>
          </form>
        )}

        {/* Tab 2: Create Account Form */}
        {authMode === 'register' && (
          <form onSubmit={handleRegisterSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
            <div className="form-group">
              <label className="form-label" htmlFor="name-input">
                Full Name <span style={{ color: '#dc2626' }}>*</span>
              </label>
              <div style={{ position: 'relative' }}>
                <input
                  id="name-input"
                  type="text"
                  className="form-input"
                  value={nameInput}
                  onChange={(e) => setNameInput(e.target.value)}
                  placeholder="e.g., Alex Johnson"
                  disabled={isLoading}
                  required
                  style={{ paddingLeft: '32px' }}
                />
                <User
                  size={14}
                  color="var(--text-muted)"
                  style={{ position: 'absolute', left: '10px', top: '50%', transform: 'translateY(-50%)' }}
                />
              </div>
            </div>

            <div className="form-group">
              <label className="form-label" htmlFor="reg-email-input">
                Email Address <span style={{ color: '#dc2626' }}>*</span>
              </label>
              <div style={{ position: 'relative' }}>
                <input
                  id="reg-email-input"
                  type="email"
                  className="form-input"
                  value={emailInput}
                  onChange={(e) => setEmailInput(e.target.value)}
                  placeholder="name@example.com"
                  disabled={isLoading}
                  required
                  style={{ paddingLeft: '32px' }}
                />
                <Mail
                  size={14}
                  color="var(--text-muted)"
                  style={{ position: 'absolute', left: '10px', top: '50%', transform: 'translateY(-50%)' }}
                />
              </div>
            </div>

            <div className="form-group">
              <label className="form-label" htmlFor="reg-password-input">
                Password (minimum 6 characters) <span style={{ color: '#dc2626' }}>*</span>
              </label>
              <div style={{ position: 'relative' }}>
                <input
                  id="reg-password-input"
                  type="password"
                  className="form-input"
                  value={passwordInput}
                  onChange={(e) => setPasswordInput(e.target.value)}
                  placeholder="••••••••"
                  disabled={isLoading}
                  required
                  style={{ paddingLeft: '32px' }}
                />
                <Lock
                  size={14}
                  color="var(--text-muted)"
                  style={{ position: 'absolute', left: '10px', top: '50%', transform: 'translateY(-50%)' }}
                />
              </div>
            </div>

            <button
              type="submit"
              className="btn-primary-indigo"
              disabled={isLoading || !nameInput.trim() || !emailInput.trim() || !passwordInput}
              style={{ padding: '10px 16px', fontSize: '13.5px', marginTop: '4px' }}
            >
              {isLoading ? (
                <>
                  <Loader2 size={16} className="spin" />
                  Creating Account...
                </>
              ) : (
                <>
                  <UserPlus size={15} />
                  Register &amp; Create Workspace
                  <ArrowRight size={15} />
                </>
              )}
            </button>
          </form>
        )}
      </div>

      {/* Role Navigation Cards */}
      <div className="customer-auth-grid">
        {/* Card 1: Customer Inquiry Portal */}
        <div className="portal-card">
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <div
              style={{
                width: 42,
                height: 42,
                borderRadius: '10px',
                backgroundColor: 'var(--accent-lavender-bg)',
                color: 'var(--primary-indigo)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <MessageSquare size={20} />
            </div>
            <div>
              <span
                style={{
                  fontSize: '11px',
                  fontWeight: 700,
                  color: 'var(--primary-indigo)',
                  textTransform: 'uppercase',
                  letterSpacing: '0.05em',
                }}
              >
                External Customer Experience
              </span>
              <h2
                style={{
                  fontFamily: "'Plus Jakarta Sans', sans-serif",
                  fontSize: '17px',
                  fontWeight: 700,
                  margin: '2px 0 0',
                }}
              >
                Customer Inquiry Portal
              </h2>
            </div>
          </div>
          <p style={{ fontSize: '13px', color: 'var(--text-secondary)', lineHeight: 1.5, margin: '8px 0 14px' }}>
            Browse inventory catalog, submit customer support tickets, and experience real-time conversational assistance.
          </p>
          <div style={{ marginTop: 'auto', display: 'flex', justifyContent: 'flex-end' }}>
            <Link
              to="/portal"
              className="btn-warm-outlined"
              style={{ textDecoration: 'none', padding: '8px 16px', fontSize: '13px' }}
            >
              Open Customer Portal
              <ArrowRight size={14} />
            </Link>
          </div>
        </div>

        {/* Card 2: Company Operations Dashboard */}
        <div className="portal-card">
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <div
              style={{
                width: 42,
                height: 42,
                borderRadius: '10px',
                backgroundColor: '#ecfdf5',
                color: '#059669',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <LayoutDashboard size={20} />
            </div>
            <div>
              <span
                style={{
                  fontSize: '11px',
                  fontWeight: 700,
                  color: '#059669',
                  textTransform: 'uppercase',
                  letterSpacing: '0.05em',
                }}
              >
                Internal Operations
              </span>
              <h2
                style={{
                  fontFamily: "'Plus Jakarta Sans', sans-serif",
                  fontSize: '17px',
                  fontWeight: 700,
                  margin: '2px 0 0',
                }}
              >
                Company Operations Dashboard
              </h2>
            </div>
          </div>
          <p style={{ fontSize: '13px', color: 'var(--text-secondary)', lineHeight: 1.5, margin: '8px 0 14px' }}>
            Manage inventory spreadsheets, RAG documents, primary Gmail inbox, and autonomous Socratic workflows.
          </p>
          <div style={{ marginTop: 'auto', display: 'flex', justifyContent: 'flex-end' }}>
            <Link
              to="/company"
              className="btn-primary-indigo"
              style={{ textDecoration: 'none', padding: '8px 16px', fontSize: '13px' }}
            >
              Launch Dashboard
              <ArrowRight size={14} />
            </Link>
          </div>
        </div>
      </div>
    </motion.div>
  );
}
