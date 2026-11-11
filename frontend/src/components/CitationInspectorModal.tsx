import React from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { FileText, Table2, X, Eye, BookOpen, Quote } from 'lucide-react';
import type { Citation } from '../../../shared/types/contracts';

interface CitationInspectorModalProps {
  citation: Citation | null;
  onClose: () => void;
  onHighlightRow?: (locator: string) => void;
}

export default function CitationInspectorModal({
  citation,
  onClose,
  onHighlightRow,
}: CitationInspectorModalProps): React.ReactElement | null {
  if (!citation) return null;

  const isDoc = citation.source_type === 'document';

  return (
    <AnimatePresence>
      <motion.div
        className="modal-backdrop"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.18 }}
        onClick={onClose}
        style={{ zIndex: 1100 }}
      >
        <motion.div
          className="modal-card liquid-glass-modal"
          initial={{ opacity: 0, scale: 0.96, y: 10 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.96, y: 8 }}
          transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
          onClick={(e) => e.stopPropagation()}
          style={{
            maxWidth: '560px',
            width: '92%',
            backgroundColor: '#ffffff',
            borderRadius: '12px',
            border: '1px solid var(--border-warm)',
            boxShadow: 'var(--shadow-modal)',
            padding: '20px',
            display: 'flex',
            flexDirection: 'column',
            gap: '14px',
          }}
        >
          {/* Header */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              borderBottom: '1px solid var(--border-subtle)',
              paddingBottom: '12px',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <div
                style={{
                  width: '32px',
                  height: '32px',
                  borderRadius: '8px',
                  backgroundColor: isDoc ? '#eff6ff' : '#f0fdf4',
                  color: isDoc ? 'var(--primary-indigo)' : '#16a34a',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  border: `1px solid ${isDoc ? '#bfdbfe' : '#bbf7d0'}`,
                }}
              >
                {isDoc ? <FileText size={18} /> : <Table2 size={18} />}
              </div>
              <div>
                <h3 style={{ fontSize: '15px', fontWeight: 700, margin: 0, color: 'var(--text-primary)' }}>
                  Provenance &amp; Citation Inspector
                </h3>
                <span style={{ fontSize: '11.5px', color: 'var(--text-secondary)' }}>
                  {isDoc ? 'Unstructured Policy / Advisory Document' : 'Structured Relational Database Table'}
                </span>
              </div>
            </div>

            <button
              type="button"
              className="icon-action-btn"
              onClick={onClose}
              aria-label="Close inspector"
            >
              <X size={18} />
            </button>
          </div>

          {/* Meta Tags */}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center' }}>
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '5px',
                padding: '3px 10px',
                borderRadius: '999px',
                fontSize: '12px',
                fontWeight: 700,
                backgroundColor: isDoc ? '#eff6ff' : '#f0fdf4',
                color: isDoc ? '#1e40af' : '#166534',
                border: `1px solid ${isDoc ? '#bfdbfe' : '#bbf7d0'}`,
              }}
            >
              {isDoc ? <BookOpen size={13} /> : <Table2 size={13} />}
              {citation.source_name}
            </span>

            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '4px',
                padding: '3px 10px',
                borderRadius: '999px',
                fontSize: '12px',
                fontWeight: 600,
                backgroundColor: 'var(--bg-subtle-warm)',
                color: 'var(--text-secondary)',
                border: '1px solid var(--border-warm)',
              }}
            >
              Locator: <strong>{citation.locator}</strong>
            </span>
          </div>

          {/* Grounded Excerpt Box */}
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: '6px',
            }}
          >
            <label
              style={{
                fontSize: '11.5px',
                fontWeight: 700,
                color: 'var(--text-secondary)',
                textTransform: 'uppercase',
                letterSpacing: '0.04em',
                display: 'flex',
                alignItems: 'center',
                gap: '4px',
              }}
            >
              <Quote size={12} />
              Grounded Source Excerpt
            </label>

            <div
              style={{
                padding: '14px',
                borderRadius: '8px',
                backgroundColor: 'var(--bg-panel)',
                border: '1px solid var(--border-warm)',
                fontSize: '12.5px',
                lineHeight: 1.55,
                color: 'var(--text-primary)',
                fontStyle: isDoc ? 'italic' : 'normal',
                whiteSpace: 'pre-wrap',
                maxHeight: '260px',
                overflowY: 'auto',
              }}
            >
              {citation.excerpt || 'No raw excerpt text available for this citation.'}
            </div>
          </div>

          {/* Actions */}
          <div
            style={{
              display: 'flex',
              justifyContent: 'flex-end',
              gap: '8px',
              paddingTop: '6px',
              borderTop: '1px solid var(--border-subtle)',
            }}
          >
            {!isDoc && onHighlightRow && (
              <button
                type="button"
                className="btn-warm-outlined"
                style={{
                  fontSize: '12px',
                  padding: '6px 12px',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '6px',
                  borderColor: 'var(--primary-indigo)',
                  color: 'var(--primary-indigo)',
                }}
                onClick={() => {
                  onHighlightRow(citation.locator);
                  onClose();
                }}
              >
                <Eye size={13} />
                Highlight in Spreadsheet Table
              </button>
            )}

            <button
              type="button"
              className="btn-primary-indigo"
              style={{ fontSize: '12px', padding: '6px 16px' }}
              onClick={onClose}
            >
              Close
            </button>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}
