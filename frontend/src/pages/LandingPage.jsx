import React, { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { motion, AnimatePresence } from "framer-motion";
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
  FileSpreadsheet,
  FileText,
  GitBranch,
  Play,
  PlayCircle,
  Layers,
  Cloud,
  Code2,
  Globe,
  ExternalLink,
  Check,
} from "lucide-react";
import {
  getActiveWorkspaceId,
  getActiveWorkspaceName,
  setActiveWorkspace,
  clearActiveWorkspace,
  setLoggedInUser,
  getLoggedInUser,
} from "../config/constants";
import {
  loginApi,
  registerApi,
  demoLoginApi,
  getGoogleAuthUrlApi,
} from "../services/api";
import logoImg from "../assets/logo.png";

// =============================================================================
// Landing Page Placeholders (Easy to update later)
// =============================================================================

/**
 * YouTube product walkthrough URL embedded on the home screen.
 */
const YOUTUBE_TUTORIAL_URL = "https://youtu.be/LTYa9HEe8Ps?si=4UUWmJKFomZKBN-B";

/**
 * Developer / maintainer credentials displayed in the landing footer.
 */
const DEVELOPER_INFO = {
  name: "Fardin Rahman",
  role: "Developer & Creator",
  organization: "Echo B2B Assistant",
  email: "dsfardin606@gmail.com",
  portfolioUrl: "https://deathstar606.github.io/PortFolio/",
};

const CORE_CAPABILITIES = [
  {
    id: "inquiry-triage",
    title: "Customer Inquiry Studio",
    tag: "Support & Gmail",
    description:
      "Manage Gmail threads and customer tickets with policy-grounded AI reply drafts.",
    icon: Mail,
    accentClass: "is-indigo",
  },
  {
    id: "sheet-copilot",
    title: "Natural-Language Sheets",
    tag: "Data Copilot",
    description:
      "Filter rows and stage updates in plain English with live table highlighting.",
    icon: FileSpreadsheet,
    accentClass: "is-blue",
  },
  {
    id: "cross-doc-rag",
    title: "Cross-Document RAG",
    tag: "Provenance",
    description:
      "Cross-reference PDFs, Docs, and tables with clickable source citations.",
    icon: FileText,
    accentClass: "is-teal",
  },
  {
    id: "socratic-gate",
    title: "Socratic Resolution Gate",
    tag: "Governance",
    description:
      "Pauses for human clarification whenever rules conflict or scope is unclear.",
    icon: GitBranch,
    accentClass: "is-amber",
  },
  {
    id: "stage-preview",
    title: "Stage 1 Diff Previews",
    tag: "Safe Writes",
    description:
      "Inspect Before/After table diffs and email drafts before atomic execution.",
    icon: ShieldCheck,
    accentClass: "is-emerald",
  },
  {
    id: "google-bulk",
    title: "Google Workspace Sync",
    tag: "Integrations",
    description:
      "Import Google Sheets and Docs via OAuth and run targeted campaigns.",
    icon: Cloud,
    accentClass: "is-violet",
  },
];

const WORKFLOW_STEPS = [
  {
    step: "01",
    title: "Connect Sources",
    description:
      "Link Gmail, upload CSVs or Google Sheets, and index SLA docs.",
  },
  {
    step: "02",
    title: "Prompt & Clarify",
    description:
      "Ask in natural language; resolve policy conflicts interactively.",
  },
  {
    step: "03",
    title: "Inspect Stage 1 Diffs",
    description: "Review matched rows, table changes, emails, and citations.",
  },
  {
    step: "04",
    title: "Approve & Execute",
    description: "Commit verified updates and send emails with audit trails.",
  },
];

const HERO_PILLARS = [
  { value: "Stage 1 -> Stage 2", label: "Preview diffs before commit" },
  { value: "5-Turn Memory", label: "Context-aware table queries" },
  { value: "Full Provenance", label: "Row & document citations" },
];

function extractYouTubeEmbedUrl(rawUrl) {
  const trimmed = String(rawUrl || "").trim();
  if (!trimmed) return "";
  if (trimmed.includes("youtube.com/embed/")) return trimmed;

  try {
    const parsed = new URL(trimmed);
    if (parsed.hostname.includes("youtu.be")) {
      const id = parsed.pathname.replace(/^\//, "").split("/")[0];
      return id ? `https://www.youtube.com/embed/${id}` : "";
    }
    const videoId = parsed.searchParams.get("v");
    if (videoId) {
      return `https://www.youtube.com/embed/${videoId}`;
    }
  } catch {
    return "";
  }
  return "";
}

const fadeUpVariant = {
  hidden: { opacity: 0, y: 18 },
  visible: (custom = 0) => ({
    opacity: 1,
    y: 0,
    transition: {
      duration: 0.42,
      delay: custom * 0.06,
      ease: [0.22, 1, 0.36, 1],
    },
  }),
};

export default function LandingPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const authSectionRef = useRef(null);
  const emailFieldRef = useRef(null);

  const [activeWsId, setActiveWsId] = useState(getActiveWorkspaceId());
  const [activeWsName, setActiveWsName] = useState(getActiveWorkspaceName());
  const [currentUser, setCurrentUserState] = useState(getLoggedInUser());

  const [authMode, setAuthMode] = useState("login"); // 'login' | 'register'
  const [emailInput, setEmailInput] = useState("");
  const [passwordInput, setPasswordInput] = useState("");
  const [nameInput, setNameInput] = useState("");

  const [isLoading, setIsLoading] = useState(false);
  const [isDemoLoading, setIsDemoLoading] = useState(false);
  const [isGoogleLoading, setIsGoogleLoading] = useState(false);
  const [authError, setAuthError] = useState(null);
  const [authSuccessMessage, setAuthSuccessMessage] = useState(null);

  const embedUrl = extractYouTubeEmbedUrl(YOUTUBE_TUTORIAL_URL);

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const gErr = params.get("google_auth_error");
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
    window.addEventListener("authChanged", syncState);
    window.addEventListener("workspaceChanged", syncState);
    return () => {
      window.removeEventListener("authChanged", syncState);
      window.removeEventListener("workspaceChanged", syncState);
    };
  }, []);

  // Instant Shared Demo Account Sign-In ("Try Now")
  const handleTryDemo = async () => {
    setAuthError(null);
    setAuthSuccessMessage(null);
    setIsDemoLoading(true);
    try {
      const res = await demoLoginApi();
      setLoggedInUser(res.user);
      setCurrentUserState(res.user);

      if (res.workspaces && res.workspaces.length > 0) {
        const primaryWs = res.workspaces[0];
        setActiveWorkspace(primaryWs.id, primaryWs.name);
        setActiveWsId(primaryWs.id);
        setActiveWsName(primaryWs.name);
      } else {
        clearActiveWorkspace(true);
        setActiveWsId("");
        setActiveWsName("No Workspace Selected");
      }

      window.dispatchEvent(new Event("authChanged"));
      window.dispatchEvent(new Event("workspaceChanged"));
      navigate("/company");
    } catch (err) {
      setAuthError(
        err?.message || "Unable to launch the shared demo workspace right now.",
      );
      authSectionRef.current?.scrollIntoView({
        behavior: "smooth",
        block: "center",
      });
    } finally {
      setIsDemoLoading(false);
    }
  };

  // Email + Password Sign In
  const handleLoginSubmit = async (e) => {
    e.preventDefault();
    setAuthError(null);
    setAuthSuccessMessage(null);

    const email = emailInput.trim();
    const pass = passwordInput;
    if (!email || !pass) {
      setAuthError("Please enter both your email address and password.");
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
        setActiveWsId("");
        setActiveWsName("No Workspace Selected");
      }

      window.dispatchEvent(new Event("authChanged"));
      window.dispatchEvent(new Event("workspaceChanged"));

      setAuthSuccessMessage(`Welcome back, ${res.user.name}! Redirecting...`);
      setTimeout(() => {
        navigate("/company");
      }, 700);
    } catch (err) {
      setAuthError(
        err?.message || "Login failed. Please check your credentials.",
      );
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
      setAuthError("Please fill out all fields to register.");
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
        setActiveWsId("");
        setActiveWsName("No Workspace Selected");
      }

      window.dispatchEvent(new Event("authChanged"));
      window.dispatchEvent(new Event("workspaceChanged"));

      setAuthSuccessMessage(
        `Account created for ${res.user.name}! Provisioning workspace...`,
      );
      setTimeout(() => {
        navigate("/company");
      }, 800);
    } catch (err) {
      setAuthError(err?.message || "Registration failed.");
    } finally {
      setIsLoading(false);
    }
  };

  // Sign In with Google
  const handleGoogleSignIn = async () => {
    setAuthError(null);
    setIsGoogleLoading(true);
    try {
      const url = await getGoogleAuthUrlApi("");
      if (url) {
        window.location.href = url;
      } else {
        throw new Error("Could not obtain Google authentication URL.");
      }
    } catch (err) {
      setAuthError(err?.message || "Failed to initiate Google sign-in.");
      setIsGoogleLoading(false);
    }
  };

  const scrollToSection = (sectionId) => {
    const el = document.getElementById(sectionId);
    el?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <div className="landing-page-shell">
      {/* Subtle Ambient Decorative Glow */}
      <div className="landing-hero-backdrop" aria-hidden="true" />

      <main className="landing-main-container">
        {/* =================================================================
            SECTION 1: HERO & INTEGRATED WORKSPACE SIGN-IN
            ================================================================= */}
        <section id="hero" className="landing-hero-section">
          <div className="landing-hero-grid">
            {/* Left Column: Editorial Hero Copy & Proof Pillars */}
            <motion.div
              className="landing-hero-copy"
              initial="hidden"
              animate="visible"
              variants={fadeUpVariant}
              custom={0}
            >
              <h1 className="landing-hero-title">
                Turn support queues &amp; company data into{" "}
                <span className="landing-hero-accent">
                  verified B2B action.
                </span>
              </h1>

              <p className="landing-hero-subtitle">
                Unite Gmail threads, live spreadsheets, and policy docs with
                human-approved Stage 1 diffs before committing.
              </p>

              {/* Active Session Status Bar (Shown only when user is signed in) */}
              {currentUser?.id && (
                <motion.div
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="landing-active-session-bar"
                >
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "8px",
                      minWidth: 0,
                    }}
                  >
                    {activeWsId ? (
                      <>
                        <Building2 size={15} color="var(--primary-indigo)" />
                        <span
                          style={{
                            fontSize: "12.5px",
                            color: "var(--text-secondary)",
                          }}
                        >
                          Active Workspace:{" "}
                          <strong style={{ color: "var(--text-primary)" }}>
                            {activeWsName}
                          </strong>
                        </span>
                      </>
                    ) : (
                      <>
                        <User size={15} color="var(--primary-indigo)" />
                        <span
                          style={{
                            fontSize: "12.5px",
                            color: "var(--text-secondary)",
                          }}
                        >
                          Signed in as{" "}
                          <strong style={{ color: "var(--text-primary)" }}>
                            {currentUser.name}
                          </strong>
                        </span>
                      </>
                    )}
                  </div>
                  <button
                    type="button"
                    className="btn-primary-indigo"
                    onClick={() => navigate("/company")}
                    style={{
                      padding: "6px 14px",
                      fontSize: "12px",
                      borderRadius: "999px",
                      flexShrink: 0,
                    }}
                  >
                    <span>Continue to Studio</span>
                    <ArrowRight size={13} />
                  </button>
                </motion.div>
              )}

              {/* Hero CTAs */}
              <div className="landing-hero-actions">
                {!currentUser?.id && (
                  <button
                    type="button"
                    className="btn-primary-indigo landing-cta-primary"
                    onClick={handleTryDemo}
                    disabled={isDemoLoading}
                  >
                    {isDemoLoading ? (
                      <>
                        <Loader2 size={15} className="animate-spin" />
                        <span>Opening Demo Workspace...</span>
                      </>
                    ) : (
                      <>
                        <span>Try Now</span>
                        <ArrowRight size={15} />
                      </>
                    )}
                  </button>
                )}

                <button
                  type="button"
                  className="btn-warm-outlined landing-cta-secondary"
                  onClick={() => scrollToSection("tutorial")}
                >
                  <PlayCircle size={16} color="var(--primary-indigo)" />
                  <span>Walkthrough</span>
                </button>
              </div>

              {/* Trust & Architecture Highlights */}
              <div className="landing-proof-metrics">
                {HERO_PILLARS.map((item) => (
                  <div key={item.value} className="landing-proof-item">
                    <div className="landing-proof-value">{item.value}</div>
                    <div className="landing-proof-label">{item.label}</div>
                  </div>
                ))}
              </div>
            </motion.div>

            {/* Right Column: Production Auth Card */}
            <motion.div
              ref={authSectionRef}
              id="auth-panel"
              className="landing-auth-card"
              initial="hidden"
              animate="visible"
              variants={fadeUpVariant}
              custom={1.5}
            >
              <div className="landing-auth-header">
                <div>
                  <h2 className="landing-auth-title">
                    Access Echo B2B Assistant
                  </h2>
                  <p className="landing-auth-caption">
                    Sign in or provision a private workspace for your operations
                    team.
                  </p>
                </div>
                <span
                  className="landing-security-chip"
                  title="Workspace-scoped access control"
                >
                  <ShieldCheck size={13} />
                  <span>Private</span>
                </span>
              </div>

              {/* Segmented Mode Tabs */}
              <div
                className="landing-auth-tabs"
                role="tablist"
                aria-label="Authentication mode"
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={authMode === "login"}
                  className={`landing-auth-tab-btn ${authMode === "login" ? "is-active" : ""}`}
                  onClick={() => {
                    setAuthMode("login");
                    setAuthError(null);
                    setAuthSuccessMessage(null);
                  }}
                >
                  <KeyRound size={14} />
                  <span>Sign In</span>
                </button>

                <button
                  type="button"
                  role="tab"
                  aria-selected={authMode === "register"}
                  className={`landing-auth-tab-btn ${authMode === "register" ? "is-active" : ""}`}
                  onClick={() => {
                    setAuthMode("register");
                    setAuthError(null);
                    setAuthSuccessMessage(null);
                  }}
                >
                  <UserPlus size={14} />
                  <span>Create Account</span>
                </button>
              </div>

              {/* Feedback Banners */}
              <AnimatePresence>
                {authError && (
                  <motion.div
                    initial={{ opacity: 0, y: -6 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -6 }}
                    className="error-banner"
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "8px",
                      fontSize: "12.5px",
                    }}
                  >
                    <AlertCircle size={15} style={{ flexShrink: 0 }} />
                    <span>{authError}</span>
                  </motion.div>
                )}
                {authSuccessMessage && (
                  <motion.div
                    initial={{ opacity: 0, y: -6 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -6 }}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "8px",
                      fontSize: "12.5px",
                      padding: "10px 12px",
                      borderRadius: "8px",
                      backgroundColor: "var(--status-success-bg)",
                      color: "var(--status-success)",
                      border: "1px solid rgba(52, 211, 153, 0.35)",
                    }}
                  >
                    <CheckCircle2
                      size={15}
                      color="#059669"
                      style={{ flexShrink: 0 }}
                    />
                    <span>{authSuccessMessage}</span>
                  </motion.div>
                )}
              </AnimatePresence>

              {/* Google OAuth Sign In */}
              <button
                type="button"
                className="landing-google-oauth-btn"
                onClick={handleGoogleSignIn}
                disabled={isGoogleLoading || isLoading}
              >
                {isGoogleLoading ? (
                  <>
                    <Loader2 size={16} className="spin" />
                    <span>Connecting to Google...</span>
                  </>
                ) : (
                  <>
                    <svg
                      width="17"
                      height="17"
                      viewBox="0 0 24 24"
                      aria-hidden="true"
                    >
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
                        d="M5.28 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z"
                      />
                      <path
                        fill="#EA4335"
                        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z"
                      />
                    </svg>
                    <span>Continue with Google</span>
                  </>
                )}
              </button>

              <div className="landing-auth-divider">
                <span />
                <span>OR USE WORK EMAIL</span>
                <span />
              </div>

              {authMode === "login" ? (
                <form
                  onSubmit={handleLoginSubmit}
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: "12px",
                  }}
                >
                  <div className="form-group">
                    <label className="form-label" htmlFor="email-input">
                      Email Address <span style={{ color: "#dc2626" }}>*</span>
                    </label>
                    <div className="landing-input-wrap">
                      <Mail size={14} className="landing-input-icon" />
                      <input
                        ref={emailFieldRef}
                        id="email-input"
                        type="email"
                        className="form-input landing-form-input"
                        value={emailInput}
                        onChange={(e) => setEmailInput(e.target.value)}
                        placeholder="name@company.com"
                        disabled={isLoading}
                        required
                      />
                    </div>
                  </div>

                  <div className="form-group">
                    <label className="form-label" htmlFor="password-input">
                      Password <span style={{ color: "#dc2626" }}>*</span>
                    </label>
                    <div className="landing-input-wrap">
                      <Lock size={14} className="landing-input-icon" />
                      <input
                        id="password-input"
                        type="password"
                        className="form-input landing-form-input"
                        value={passwordInput}
                        onChange={(e) => setPasswordInput(e.target.value)}
                        placeholder="Enter your password"
                        disabled={isLoading}
                        required
                      />
                    </div>
                  </div>

                  <button
                    type="submit"
                    className="btn-primary-indigo landing-auth-submit"
                    disabled={isLoading || !emailInput.trim() || !passwordInput}
                  >
                    {isLoading ? (
                      <>
                        <Loader2 size={16} className="spin" />
                        <span>Authenticating...</span>
                      </>
                    ) : (
                      <>
                        <KeyRound size={15} />
                        <span>Sign In to Workspace</span>
                        <ArrowRight size={15} />
                      </>
                    )}
                  </button>
                </form>
              ) : (
                <form
                  onSubmit={handleRegisterSubmit}
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: "12px",
                  }}
                >
                  <div className="form-group">
                    <label className="form-label" htmlFor="name-input">
                      Full Name <span style={{ color: "#dc2626" }}>*</span>
                    </label>
                    <div className="landing-input-wrap">
                      <User size={14} className="landing-input-icon" />
                      <input
                        id="name-input"
                        type="text"
                        className="form-input landing-form-input"
                        value={nameInput}
                        onChange={(e) => setNameInput(e.target.value)}
                        placeholder="Alex Johnson"
                        disabled={isLoading}
                        required
                      />
                    </div>
                  </div>

                  <div className="form-group">
                    <label className="form-label" htmlFor="reg-email-input">
                      Work Email <span style={{ color: "#dc2626" }}>*</span>
                    </label>
                    <div className="landing-input-wrap">
                      <Mail size={14} className="landing-input-icon" />
                      <input
                        ref={emailFieldRef}
                        id="reg-email-input"
                        type="email"
                        className="form-input landing-form-input"
                        value={emailInput}
                        onChange={(e) => setEmailInput(e.target.value)}
                        placeholder="alex@company.com"
                        disabled={isLoading}
                        required
                      />
                    </div>
                  </div>

                  <div className="form-group">
                    <label className="form-label" htmlFor="reg-password-input">
                      Password (min. 6 characters){" "}
                      <span style={{ color: "#dc2626" }}>*</span>
                    </label>
                    <div className="landing-input-wrap">
                      <Lock size={14} className="landing-input-icon" />
                      <input
                        id="reg-password-input"
                        type="password"
                        className="form-input landing-form-input"
                        value={passwordInput}
                        onChange={(e) => setPasswordInput(e.target.value)}
                        placeholder="Create a secure password"
                        disabled={isLoading}
                        required
                      />
                    </div>
                  </div>

                  <button
                    type="submit"
                    className="btn-primary-indigo landing-auth-submit"
                    disabled={
                      isLoading ||
                      !nameInput.trim() ||
                      !emailInput.trim() ||
                      !passwordInput
                    }
                  >
                    {isLoading ? (
                      <>
                        <Loader2 size={16} className="spin" />
                        <span>Provisioning Workspace...</span>
                      </>
                    ) : (
                      <>
                        <UserPlus size={15} />
                        <span>Register &amp; Launch Studio</span>
                        <ArrowRight size={15} />
                      </>
                    )}
                  </button>
                </form>
              )}
            </motion.div>
          </div>
        </section>

        {/* =================================================================
            SECTION 2: CORE FUNCTIONALITIES
            ================================================================= */}
        <section id="capabilities" className="landing-section">
          <motion.div
            className="landing-section-header"
            initial="hidden"
            whileInView="visible"
            viewport={{ once: true, amount: 0.25 }}
            variants={fadeUpVariant}
          >
            <h2 className="landing-section-title">
              Built for verified B2B execution
            </h2>
            <p className="landing-section-subtitle">
              Grounded answers, policy citations, and human-approved updates in
              one workspace.
            </p>
          </motion.div>

          <div className="landing-capabilities-grid">
            {CORE_CAPABILITIES.map((feature, index) => {
              const IconComponent = feature.icon;
              return (
                <motion.article
                  key={feature.id}
                  className="landing-capability-card"
                  initial="hidden"
                  whileInView="visible"
                  viewport={{ once: true, amount: 0.15 }}
                  variants={fadeUpVariant}
                  custom={index * 0.5}
                  whileHover={{ y: -4, transition: { duration: 0.18 } }}
                >
                  <div className="landing-capability-top">
                    <div
                      className={`landing-capability-icon ${feature.accentClass}`}
                    >
                      <IconComponent size={19} />
                    </div>
                    <span className="landing-capability-tag">
                      {feature.tag}
                    </span>
                  </div>
                  <h3 className="landing-capability-title">{feature.title}</h3>
                  <p className="landing-capability-desc">
                    {feature.description}
                  </p>
                </motion.article>
              );
            })}
          </div>
        </section>

        {/* =================================================================
            SECTION 3: 4-STEP PIPELINE
            ================================================================= */}
        <section id="workflow" className="landing-section">
          <motion.div
            className="landing-pipeline-surface"
            initial="hidden"
            whileInView="visible"
            viewport={{ once: true, amount: 0.15 }}
            variants={fadeUpVariant}
          >
            <div
              className="landing-section-header"
              style={{ marginBottom: "26px" }}
            >
              <span className="landing-section-eyebrow">WORKFLOW</span>
              <h2 className="landing-section-title">
                From prompt to audited commit in four steps
              </h2>
            </div>

            <div className="landing-pipeline-grid">
              {WORKFLOW_STEPS.map((item, idx) => (
                <motion.div
                  key={item.step}
                  className="landing-pipeline-card"
                  initial="hidden"
                  whileInView="visible"
                  viewport={{ once: true, amount: 0.2 }}
                  variants={fadeUpVariant}
                  custom={idx * 0.7}
                >
                  <div className="landing-pipeline-step-row">
                    <span className="landing-pipeline-number">{item.step}</span>
                    {idx < WORKFLOW_STEPS.length - 1 && (
                      <ArrowRight
                        size={14}
                        className="landing-pipeline-arrow"
                        aria-hidden="true"
                      />
                    )}
                  </div>
                  <h3 className="landing-pipeline-title">{item.title}</h3>
                  <p className="landing-pipeline-desc">{item.description}</p>
                </motion.div>
              ))}
            </div>
          </motion.div>
        </section>

        {/* =================================================================
            SECTION 4: VIDEO WALKTHROUGH
            ================================================================= */}
        <section id="tutorial" className="landing-section">
          <motion.div
            className="landing-tutorial-card"
            initial="hidden"
            whileInView="visible"
            viewport={{ once: true, amount: 0.15 }}
            variants={fadeUpVariant}
          >
            <div className="landing-tutorial-grid">
              {/* Left: Video Player */}
              <div className="landing-tutorial-stage-wrap">
                {embedUrl ? (
                  <div className="landing-video-frame">
                    <iframe
                      src={embedUrl}
                      title="Echo B2B Assistant Product Walkthrough"
                      allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                      allowFullScreen
                    />
                  </div>
                ) : (
                  <div className="landing-video-placeholder">
                    <div
                      className="landing-video-grid-overlay"
                      aria-hidden="true"
                    />
                    <div className="landing-video-topbar">
                      <span className="landing-video-dot is-red" />
                      <span className="landing-video-dot is-amber" />
                      <span className="landing-video-dot is-green" />
                      <span className="landing-video-url-bar">
                        youtube.com / echo-b2b-assistant-walkthrough
                      </span>
                    </div>

                    <div className="landing-video-center">
                      <motion.div
                        className="landing-video-play-ring"
                        animate={{ scale: [1, 1.07, 1] }}
                        transition={{
                          duration: 2.6,
                          repeat: Infinity,
                          ease: "easeInOut",
                        }}
                      >
                        <div className="landing-video-play-circle">
                          <Play
                            size={24}
                            fill="#ffffff"
                            color="#ffffff"
                            style={{ marginLeft: 3 }}
                          />
                        </div>
                      </motion.div>

                      <div className="landing-video-placeholder-title">
                        Product Walkthrough
                      </div>
                      <p className="landing-video-placeholder-caption">
                        Guided video walkthrough of Echo B2B Assistant.
                      </p>

                      <div className="landing-youtube-link-pill">
                        <PlayCircle size={14} color="#dc2626" />
                        <span>YouTube Walkthrough</span>
                      </div>
                    </div>
                  </div>
                )}
              </div>

              {/* Right: Walkthrough Overview */}
              <div className="landing-tutorial-details">
                <span className="landing-section-eyebrow">WALKTHROUGH</span>
                <h2 className="landing-tutorial-heading">
                  See multi-source triage live
                </h2>
                <p className="landing-tutorial-copy">
                  Quick tour of workspace setup, natural-language sheet queries,
                  policy citations, and Stage 1 diff previews.
                </p>

                <div className="landing-tutorial-cta-row">
                  <a
                    href={YOUTUBE_TUTORIAL_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="btn-primary-indigo"
                    style={{
                      textDecoration: "none",
                      padding: "9px 16px",
                      fontSize: "13px",
                    }}
                  >
                    <PlayCircle size={15} />
                    <span>Watch on YouTube</span>
                    <ExternalLink size={13} />
                  </a>
                </div>
              </div>
            </div>
          </motion.div>
        </section>
      </main>

      {/* =================================================================
          LANDING-PAGE-ONLY FOOTER + DEVELOPER CREDENTIALS
          ================================================================= */}
      <footer className="landing-footer">
        <div className="landing-footer-inner">
          <div className="landing-footer-grid">
            {/* Column 1: Service Provider Identity */}
            <div className="landing-footer-brand-col">
              <div className="landing-footer-brand-row">
                <img
                  src={logoImg}
                  alt="Echo B2B Assistant"
                  style={{
                    width: 34,
                    height: 34,
                    borderRadius: "9px",
                    objectFit: "cover",
                    flexShrink: 0,
                  }}
                />
                <div>
                  <div className="landing-footer-brand-name">
                    Echo B2B Assistant
                  </div>
                  <div className="landing-footer-brand-sub">
                    Autonomous B2B Operations
                  </div>
                </div>
              </div>
              <p className="landing-footer-desc">
                Human-governed AI workspace uniting email triage, spreadsheets,
                and policy docs.
              </p>
            </div>

            {/* Column 2: Navigation */}
            <div className="landing-footer-col">
              <h4 className="landing-footer-heading">Platform</h4>
              <ul className="landing-footer-links">
                <li>
                  <button type="button" onClick={() => scrollToSection("hero")}>
                    Overview &amp; Sign In
                  </button>
                </li>
                <li>
                  <button
                    type="button"
                    onClick={() => scrollToSection("capabilities")}
                  >
                    Capabilities
                  </button>
                </li>
                <li>
                  <button
                    type="button"
                    onClick={() => scrollToSection("workflow")}
                  >
                    Workflow
                  </button>
                </li>
                <li>
                  <button
                    type="button"
                    onClick={() => scrollToSection("tutorial")}
                  >
                    Walkthrough
                  </button>
                </li>
              </ul>
            </div>

            {/* Column 3: Developer Credentials & Issue Reporting */}
            <div id="developer-info" className="landing-footer-dev-card">
              <div className="landing-footer-dev-header">
                <span className="landing-footer-dev-badge">
                  <Code2 size={12} />
                  <span>Developer &amp; Support</span>
                </span>
                <Layers size={14} color="#818cf8" />
              </div>

              <div className="landing-footer-dev-body">
                <div className="landing-footer-dev-name">
                  {DEVELOPER_INFO.name}
                </div>
                <div className="landing-footer-dev-role">
                  {DEVELOPER_INFO.role} • {DEVELOPER_INFO.organization}
                </div>

                <div className="landing-footer-dev-meta">
                  <div>
                    <Mail size={12} style={{ flexShrink: 0 }} />
                    <a
                      href={`mailto:${DEVELOPER_INFO.email}`}
                      className="landing-footer-dev-link"
                    >
                      {DEVELOPER_INFO.email}
                    </a>
                  </div>
                  <div>
                    <Globe size={12} style={{ flexShrink: 0 }} />
                    <a
                      href={DEVELOPER_INFO.portfolioUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="landing-footer-dev-link"
                    >
                      {DEVELOPER_INFO.portfolioUrl}
                    </a>
                  </div>
                </div>

                <p className="landing-footer-report-note">
                  Notice a bug or unexpected behavior? Please report the issue
                  directly using the developer credentials above.
                </p>

                <div className="landing-footer-dev-links">
                  <a
                    href={`mailto:${DEVELOPER_INFO.email}?subject=${encodeURIComponent("Echo B2B Assistant - Issue Report")}`}
                    className="landing-dev-chip"
                  >
                    <Mail size={11} />
                    <span>Report Issue ({DEVELOPER_INFO.email})</span>
                  </a>

                  <a
                    href={DEVELOPER_INFO.portfolioUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="landing-dev-chip is-secondary"
                  >
                    <ExternalLink size={11} />
                    <span>Portfolio</span>
                  </a>
                </div>
              </div>
            </div>
          </div>

          <div className="landing-footer-bottom">
            <span>
              &copy; {new Date().getFullYear()} Echo B2B Assistant. Built by{" "}
              {DEVELOPER_INFO.name}.
            </span>
            <span className="landing-footer-status">
              <Check size={12} color="#34d399" />
              <span>Workspace Ready</span>
            </span>
          </div>
        </div>
      </footer>
    </div>
  );
}
