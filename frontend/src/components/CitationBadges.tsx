import React, { useState } from 'react';
import { FileText, Table2, ExternalLink } from 'lucide-react';
import type { Citation } from '../../../shared/types/contracts';

interface CitationBadgesProps {
  citations?: Citation[];
  onSelectCitation?: (citation: Citation) => void;
  maxDisplay?: number;
  className?: string;
}

export default function CitationBadges({
  citations = [],
  onSelectCitation,
  maxDisplay = 6,
  className = '',
}: CitationBadgesProps): React.ReactElement | null {
  const [expanded, setExpanded] = useState(false);

  if (!Array.isArray(citations) || citations.length === 0) {
    return null;
  }

  const displayed = expanded ? citations : citations.slice(0, maxDisplay);
  const remaining = Math.max(0, citations.length - displayed.length);

  return (
    <div
      className={`citation-badges-cluster ${className}`}
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: '6px',
        marginTop: '6px',
      }}
    >
      <span
        style={{
          fontSize: '11px',
          fontWeight: 700,
          color: 'var(--text-secondary)',
          textTransform: 'uppercase',
          letterSpacing: '0.04em',
        }}
      >
        Provenance:
      </span>

      {displayed.map((citation, idx) => {
        const isDoc = citation.source_type === 'document';
        const sourceLabel = citation.source_name || (isDoc ? 'Policy Document' : 'Database Table');
        const locatorLabel = citation.locator || (isDoc ? 'Page 1' : 'Row');

        return (
          <button
            key={`${citation.source_name}-${citation.locator}-${idx}`}
            type="button"
            className="citation-badge-pill"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '5px',
              padding: '3px 8px',
              borderRadius: '999px',
              fontSize: '11px',
              fontWeight: 600,
              backgroundColor: isDoc ? 'var(--accent-lavender-bg)' : 'var(--status-success-bg)',
              color: isDoc ? '#c4b5fd' : '#6ee7b7',
              border: `1px solid ${isDoc ? 'var(--accent-lavender-border)' : 'rgba(52, 211, 153, 0.38)'}`,
              cursor: onSelectCitation ? 'pointer' : 'default',
              transition: 'all 0.15s ease',
            }}
            onClick={() => onSelectCitation?.(citation)}
            title={`Click to inspect grounded excerpt from ${sourceLabel} (${locatorLabel})`}
          >
            {isDoc ? <FileText size={12} /> : <Table2 size={12} />}
            <span>
              {sourceLabel} • {locatorLabel}
            </span>
            {onSelectCitation && <ExternalLink size={10} style={{ opacity: 0.65 }} />}
          </button>
        );
      })}

      {(remaining > 0 || (expanded && citations.length > maxDisplay)) && (
        <button
          type="button"
          onClick={() => setExpanded((prev) => !prev)}
          style={{
            fontSize: '11px',
            color: 'var(--primary-indigo-text)',
            fontWeight: 600,
            backgroundColor: 'var(--bg-subtle-warm)',
            border: '1px solid var(--border-warm)',
            borderRadius: '999px',
            padding: '2px 8px',
            cursor: 'pointer',
          }}
        >
          {expanded ? 'Show less' : `+${remaining} more`}
        </button>
      )}
    </div>
  );
}
