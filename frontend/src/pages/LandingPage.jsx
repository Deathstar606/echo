import React from 'react';
import { Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import {
  MessageSquare,
  LayoutDashboard,
  ArrowRight,
  Sparkles,
  ShieldCheck,
  Database,
} from 'lucide-react';
import { BUSINESS_ID } from '../config/constants';

export default function LandingPage() {
  return (
    <motion.div
      className="customer-portal-container"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.22 }}
    >
      <div
        className="portal-card"
        style={{
          textAlign: 'center',
          padding: '36px 28px',
          alignItems: 'center',
          background:
            'linear-gradient(180deg, #faf7f2 0%, #f3ece0 100%)',
        }}
      >
        <span className="beta-pill" style={{ marginBottom: '4px' }}>
          MAXITEXT AI STUDIO WORKSPACE PROTOTYPE
        </span>
        <h1
          style={{
            fontFamily: "'Plus Jakarta Sans', sans-serif",
            fontSize: '28px',
            fontWeight: 800,
            maxWidth: '680px',
            lineHeight: 1.25,
          }}
        >
          Intelligent Customer Inquiry &amp; AI Workspace Copilot
        </h1>
        <p
          style={{
            fontSize: '14.5px',
            color: 'var(--text-secondary)',
            maxWidth: '620px',
          }}
        >
          Explore the end-to-end customer-to-company inquiry workflow powered by
          contextual AI draft generation, strict privacy isolation, and live
          conversation state synchronization.
        </p>

        <div
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '8px',
            padding: '6px 14px',
            borderRadius: '999px',
            backgroundColor: '#ffffff',
            border: '1px solid var(--border-warm)',
            fontSize: '12px',
            color: 'var(--text-secondary)',
          }}
        >
          <ShieldCheck size={14} color="var(--primary-indigo)" />
          <span>Active Business ID:</span>
          <code style={{ fontWeight: 700, color: 'var(--text-primary)' }}>
            {BUSINESS_ID}
          </code>
        </div>
      </div>

      <div className="customer-auth-grid">
        {/* Card 1: Customer Panel */}
        <div className="portal-card">
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <div
              style={{
                width: 44,
                height: 44,
                borderRadius: '10px',
                backgroundColor: 'var(--accent-lavender-bg)',
                color: 'var(--primary-indigo)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <MessageSquare size={22} />
            </div>
            <div>
              <span
                style={{
                  fontSize: '11px',
                  fontWeight: 700,
                  color: 'var(--primary-indigo)',
                  textTransform: 'uppercase',
                }}
              >
                Route: /customer
              </span>
              <h2 style={{ fontSize: '18px', fontWeight: 800 }}>
                1. Customer Inquiry Panel
              </h2>
            </div>
          </div>

          <p style={{ fontSize: '13.5px', color: 'var(--text-secondary)' }}>
            Customer-facing portal for registering a new one-time Customer ID,
            returning with a saved Customer ID, submitting support inquiries, and
            viewing live replies from the support team.
          </p>

          <ul
            style={{
              paddingLeft: '18px',
              fontSize: '12.5px',
              color: 'var(--text-secondary)',
              display: 'flex',
              flexDirection: 'column',
              gap: '5px',
            }}
          >
            <li>One-time Customer ID registration popup with clipboard copy</li>
            <li>Duplicate email protection without exposing existing IDs</li>
            <li>Privacy-enforced messaging (AI drafts never exposed to customers)</li>
          </ul>

          <Link
            to="/customer"
            className="btn-primary-indigo"
            style={{ textDecoration: 'none', marginTop: 'auto' }}
          >
            Open Customer Panel
            <ArrowRight size={16} />
          </Link>
        </div>

        {/* Card 2: Company Inquiry Panel */}
        <div className="portal-card">
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <div
              style={{
                width: 44,
                height: 44,
                borderRadius: '10px',
                backgroundColor: 'var(--bg-button-warm)',
                border: '1px solid var(--border-warm-strong)',
                color: 'var(--text-primary)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <LayoutDashboard size={22} />
            </div>
            <div>
              <span
                style={{
                  fontSize: '11px',
                  fontWeight: 700,
                  color: 'var(--status-warning)',
                  textTransform: 'uppercase',
                }}
              >
                Route: /company
              </span>
              <h2 style={{ fontSize: '18px', fontWeight: 800 }}>
                2. Company Inquiry &amp; Copilot Panel
              </h2>
            </div>
          </div>

          <p style={{ fontSize: '13.5px', color: 'var(--text-secondary)' }}>
            Company-facing workspace matching the MaxiText AI Studio wireframe.
            Review customer conversations in the inbox, inspect AI-suggested
            responses in the Copilot panel, edit and send approved replies.
          </p>

          <ul
            style={{
              paddingLeft: '18px',
              fontSize: '12.5px',
              color: 'var(--text-secondary)',
              display: 'flex',
              flexDirection: 'column',
              gap: '5px',
            }}
          >
            <li>
              <Sparkles size={12} style={{ display: 'inline', marginRight: 4 }} />
              Server-side AI suggested reply review, editing &amp; explicit approval
            </li>
            <li>
              <Database size={12} style={{ display: 'inline', marginRight: 4 }} />
              Includes Announcement Composer &amp; Sheet Management prototype panels
            </li>
          </ul>

          <Link
            to="/company"
            className="btn-primary-indigo"
            style={{ textDecoration: 'none', marginTop: 'auto' }}
          >
            Open Company Inquiry Panel
            <ArrowRight size={16} />
          </Link>
        </div>
      </div>
    </motion.div>
  );
}
