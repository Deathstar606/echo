import React from 'react';
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
  if (!Array.isArray(citations) || citations.length === 0) {
    return null;
  }

  const displayed = citations.slice(0, maxDisplay);
  const remaining = citations.length - maxDisplay;

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
              backgroundColor: isDoc ? '#eff6ff' : '#f0fdf4',
              color: isDoc ? '#1e40af' : '#166534',
              border: `1px solid ${isDoc ? '#bfdbfe' : '#bbf7d0'}`,
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

      {remaining > 0 && (
        <span
          style={{
            fontSize: '11px',
            color: 'var(--text-secondary)',
            fontWeight: 600,
          }}
        >
          +{remaining} more
        </span>
      )}
    </div>
  );
}
