import React, { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import {
  Plug,
  Building2,
  UserCheck,
  ShieldCheck,
  X,
  CheckCircle2,
  MessageSquare,
  LayoutDashboard,
} from 'lucide-react';
import { checkBackendHealth } from '../services/api';
import { BUSINESS_ID, API_BASE_URL } from '../config/constants';

export default function TopHeader() {
  const location = useLocation();
  const [apiConnected, setApiConnected] = useState(true);
  const [showBusinessModal, setShowBusinessModal] = useState(false);

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

  const isCustomerRoute = location.pathname.startsWith('/customer');
  const isCompanyRoute = location.pathname.startsWith('/company');

  return (
    <>
      <header className="top-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: '20px', flexWrap: 'wrap' }}>
          <Link to="/" className="brand-cluster">
            <div className="brand-logo-box">M</div>
            <span className="brand-title">MaxiText</span>
            <span className="beta-pill">AI STUDIO (BETA)</span>
          </Link>

          <nav className="mode-switcher-pills" aria-label="Interface Switcher">
            <Link
              to="/customer"
              className={`mode-switch-link ${isCustomerRoute ? 'active' : ''}`}
            >
              {isCustomerRoute && (
                <motion.div
                  layoutId="active-mode-switch-indicator"
                  className="liquid-glass-tab-slider"
                  transition={{
                    type: 'spring',
                    stiffness: 420,
                    damping: 32,
                  }}
                />
              )}
              <span className="mode-switch-label">
                <MessageSquare size={14} />
                Customer Panel
              </span>
            </Link>
            <Link
              to="/company"
              className={`mode-switch-link ${isCompanyRoute ? 'active' : ''}`}
            >
              {isCompanyRoute && (
                <motion.div
                  layoutId="active-mode-switch-indicator"
                  className="liquid-glass-tab-slider"
                  transition={{
                    type: 'spring',
                    stiffness: 420,
                    damping: 32,
                  }}
                />
              )}
              <span className="mode-switch-label">
                <LayoutDashboard size={14} />
                Company Inquiry Panel
              </span>
            </Link>
          </nav>
        </div>

        <div className="header-right-cluster">
          <div
            className="api-status-indicator"
            title={`Backend API: ${API_BASE_URL}`}
          >
            <Plug
              size={15}
              style={{
                color: apiConnected ? '#2b3440' : '#dc2626',
                transform: 'rotate(45deg)',
              }}
            />
            <span
              className={`api-status-dot ${apiConnected ? '' : 'offline'}`}
            />
            <span>
              {apiConnected
                ? 'Connected to AI Studio API'
                : 'Backend Offline (port 3000)'}
            </span>
          </div>

          <button
            type="button"
            className="btn-warm-outlined"
            onClick={() => setShowBusinessModal(true)}
          >
            <Building2 size={14} />
            Sign in Business
          </button>
        </div>
      </header>

      <AnimatePresence>
        {showBusinessModal && (
          <motion.div
            className="modal-backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2, ease: "easeOut" }}
            onClick={() => setShowBusinessModal(false)}
          >
            <motion.div
              className="modal-card liquid-glass-modal"
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
                  <div className="brand-logo-box" style={{ width: 32, height: 32, fontSize: 16 }}>
                    M
                  </div>
                  <div>
                    <h3 style={{ fontSize: '16px', fontWeight: 700 }}>
                      Business Workspace Identity
                    </h3>
                    <p style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
                      MaxiText AI Studio Prototype Session
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  className="icon-action-btn"
                  onClick={() => setShowBusinessModal(false)}
                  aria-label="Close modal"
                >
                  <X size={18} />
                </button>
              </div>

              <div className="alert-banner success">
                <CheckCircle2 size={18} style={{ flexShrink: 0, marginTop: 1 }} />
                <div>
                  <strong>Authenticated Workspace Active</strong>
                  <div style={{ fontSize: '12px', marginTop: 2 }}>
                    All customer and company API calls are scoped to the configured
                    MaxiText business profile.
                  </div>
                </div>
              </div>

              <div className="form-group">
                <label className="form-label">
                  Active Hardcoded Business ID (BUSINESS_ID)
                </label>
                <div className="id-display-box">
                  <span>{BUSINESS_ID}</span>
                  <ShieldCheck size={16} color="var(--primary-indigo)" />
                </div>
              </div>

              <div
                className="liquid-glass-card"
                style={{
                  padding: '12px 14px',
                  borderRadius: '8px',
                  fontSize: '12.5px',
                  color: 'var(--text-secondary)',
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px',
                    fontWeight: 600,
                    color: 'var(--text-primary)',
                    marginBottom: '4px',
                  }}
                >
                  <UserCheck size={14} />
                  Workspace Isolation Active
                </div>
                Every customer registration, conversation lookup, message submission,
                and AI draft suggestion strictly filters by this Business ID on the
                Node.js &amp; PostgreSQL backend.
              </div>

              <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                <button
                  type="button"
                  className="btn-primary-indigo"
                  onClick={() => setShowBusinessModal(false)}
                >
                  Continue in Workspace
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
