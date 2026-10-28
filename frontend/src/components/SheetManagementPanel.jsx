import React, { useState } from 'react';
import { motion } from 'framer-motion';
import {
  FileSpreadsheet,
  Upload,
  Sparkles,
  Search,
  AlertCircle,
  CheckCircle2,
  SlidersHorizontal,
  ArrowRight,
  RotateCcw,
} from 'lucide-react';
import { DEMO_SHEETS } from '../config/constants';

export default function SheetManagementPanel() {
  const [selectedSheetKey, setSelectedSheetKey] = useState('products');
  const [nlInstruction, setNlInstruction] = useState(
    'List products that are out of stock.'
  );
  const [uploadedFileName, setUploadedFileName] = useState(null);
  const [previewState, setPreviewState] = useState({
    type: 'query',
    summary:
      'Showing 2 matching rows from local demo sheet where stock = 0.',
    matchedIds: ['prd-1', 'prd-6'],
    proposedDiff: null,
  });
  const [demoNotice, setDemoNotice] = useState(null);

  const currentSheet = DEMO_SHEETS[selectedSheetKey];

  const handleSelectSheet = (key) => {
    setSelectedSheetKey(key);
    setDemoNotice(null);
    const defaultPrompt = DEMO_SHEETS[key].samplePrompts[0];
    setNlInstruction(defaultPrompt);
    runSimulatedPreview(key, defaultPrompt);
  };

  const handleSimulatedUpload = (e) => {
    const file = e.target.files?.[0];
    if (file) {
      setUploadedFileName(file.name);
      setDemoNotice(
        `Loaded "${file.name}" into local visual prototype preview (BETA / DEMO mode — no live backend mutation executed).`
      );
    }
  };

  const runSimulatedPreview = (sheetKey, promptText) => {
    const lower = String(promptText || '').toLowerCase();
    const sheet = DEMO_SHEETS[sheetKey];

    if (
      lower.includes('change') ||
      lower.includes('update') ||
      lower.includes('set')
    ) {
      if (sheetKey === 'products') {
        setPreviewState({
          type: 'mutation',
          summary:
            'Two-Phase Mutation Preview (DEMO): Proposed price update on "Trail Rain Jacket" rows.',
          matchedIds: ['prd-1', 'prd-2'],
          proposedDiff: {
            targetLabel: 'Trail Rain Jacket (2 rows)',
            field: 'price',
            before: '$129.99',
            after: '$150.00',
          },
        });
      } else {
        setPreviewState({
          type: 'mutation',
          summary:
            'Two-Phase Mutation Preview (DEMO): Proposed availability update on "Interior Painting".',
          matchedIds: ['srv-3'],
          proposedDiff: {
            targetLabel: 'Interior Painting (1 row)',
            field: 'availability',
            before: 'unavailable',
            after: 'available',
          },
        });
      }
      return;
    }

    if (sheetKey === 'products') {
      if (lower.includes('out of stock') || lower.includes('zero')) {
        setPreviewState({
          type: 'query',
          summary:
            'Query Preview (DEMO): Matched 2 rows where stock = 0.',
          matchedIds: ['prd-1', 'prd-6'],
          proposedDiff: null,
        });
      } else if (lower.includes('red') || lower.includes('xl')) {
        setPreviewState({
          type: 'query',
          summary:
            'Query Preview (DEMO): Matched 2 rows with color = "Red" and size = "XL".',
          matchedIds: ['prd-1', 'prd-4'],
          proposedDiff: null,
        });
      } else {
        setPreviewState({
          type: 'query',
          summary: `Query Preview (DEMO): Showing all ${sheet.rows.length} rows in ${sheet.name}.`,
          matchedIds: sheet.rows.map((r) => r.id),
          proposedDiff: null,
        });
      }
    } else {
      if (lower.includes('unavailable')) {
        setPreviewState({
          type: 'query',
          summary:
            'Query Preview (DEMO): Matched 2 services where availability = "unavailable".',
          matchedIds: ['srv-3', 'srv-5'],
          proposedDiff: null,
        });
      } else if (lower.includes('below 100')) {
        setPreviewState({
          type: 'query',
          summary:
            'Query Preview (DEMO): Matched 3 services with rate < $100.00.',
          matchedIds: ['srv-2', 'srv-3', 'srv-4'],
          proposedDiff: null,
        });
      } else {
        setPreviewState({
          type: 'query',
          summary: `Query Preview (DEMO): Showing all ${sheet.rows.length} rows in ${sheet.name}.`,
          matchedIds: sheet.rows.map((r) => r.id),
          proposedDiff: null,
        });
      }
    }
  };

  const handleRunPreviewSubmit = (e) => {
    e.preventDefault();
    setDemoNotice(null);
    runSimulatedPreview(selectedSheetKey, nlInstruction);
  };

  const handleApplyPlaceholderMutation = () => {
    setDemoNotice(
      'Prototype Placeholder: In this frontend pass, Sheet Management is a visual demonstration using locally loaded demo data. No database records were mutated.'
    );
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2 }}
      style={{
        maxWidth: '1600px',
        width: '100%',
        margin: '0 auto',
        padding: '16px 24px 28px 24px',
        display: 'grid',
        gridTemplateColumns: 'minmax(0, 2.15fr) minmax(320px, 1fr)',
        gap: '16px',
      }}
    >
      {/* Left Main Card: Demo Sheet Viewer & Row Preview */}
      <div className="portal-card" style={{ padding: 0, overflow: 'hidden', gap: 0 }}>
        <div className="inquiry-card-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
            <FileSpreadsheet size={18} color="var(--primary-indigo)" />
            <span className="inquiry-card-title">
              Natural-Language Sheet Management
            </span>
            <span className="beta-pill">DEMO / BETA PLACEHOLDER</span>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <label
              className="btn-warm-outlined"
              style={{ cursor: 'pointer', fontSize: '12.5px', padding: '6px 12px' }}
            >
              <Upload size={14} />
              Upload Local Demo CSV
              <input
                type="file"
                accept=".csv"
                onChange={handleSimulatedUpload}
                style={{ display: 'none' }}
              />
            </label>
          </div>
        </div>

        <div style={{ padding: '18px 20px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
          <div className="alert-banner info">
            <AlertCircle size={17} style={{ flexShrink: 0, marginTop: 1 }} />
            <div>
              <strong>Visual Direction Prototype (Local Demo Data Only)</strong>
              <div style={{ fontSize: '12px', marginTop: 2 }}>
                This panel demonstrates how MaxiText ingests local CSV spreadsheets
                (Products &amp; Services) for natural-language filtering and two-phase
                modification previews. It uses locally bundled demo data and does not
                claim external Google Sheets API integration.
              </div>
            </div>
          </div>

          {demoNotice && (
            <div className="alert-banner warning">
              <CheckCircle2 size={16} style={{ flexShrink: 0, marginTop: 1 }} />
              <span>{demoNotice}</span>
            </div>
          )}

          {/* Dataset Selector Bar */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              flexWrap: 'wrap',
              gap: '12px',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
              <span style={{ fontWeight: 600, fontSize: '13px' }}>
                Active Demo Sheet:
              </span>
              <div className="target-toggle-group">
                <button
                  type="button"
                  className={`target-toggle-btn ${
                    selectedSheetKey === 'products' ? 'active' : ''
                  }`}
                  onClick={() => handleSelectSheet('products')}
                >
                  📦 Products Sheet (sample-products.csv)
                </button>
                <button
                  type="button"
                  className={`target-toggle-btn ${
                    selectedSheetKey === 'services' ? 'active' : ''
                  }`}
                  onClick={() => handleSelectSheet('services')}
                >
                  🛠️ Services Sheet (sample-services.csv)
                </button>
              </div>
            </div>

            {uploadedFileName && (
              <span
                style={{
                  fontSize: '12px',
                  color: 'var(--primary-indigo-dark)',
                  fontWeight: 600,
                }}
              >
                Selected File: {uploadedFileName}
              </span>
            )}
          </div>

          {/* Preview Summary Banner */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '10px 14px',
              backgroundColor: 'var(--bg-subtle-warm)',
              borderRadius: '8px',
              border: '1px solid var(--border-warm)',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <SlidersHorizontal size={15} color="var(--primary-indigo)" />
              <span style={{ fontWeight: 600, fontSize: '13px' }}>
                {previewState.summary}
              </span>
            </div>
            <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
              Highlighted Matches: {previewState.matchedIds.length} of{' '}
              {currentSheet.rows.length} rows
            </span>
          </div>

          {/* Tabular Data View */}
          <div className="sheet-table-wrap">
            <table className="sheet-table">
              <thead>
                <tr>
                  <th>Match</th>
                  {currentSheet.columns.map((col) => (
                    <th key={col}>{col.replace('_', ' ')}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {currentSheet.rows.map((row) => {
                  const isMatched = previewState.matchedIds.includes(row.id);
                  return (
                    <tr
                      key={row.id}
                      className={isMatched ? 'highlighted-row' : ''}
                    >
                      <td>
                        {isMatched ? (
                          <span
                            style={{
                              display: 'inline-block',
                              padding: '2px 7px',
                              borderRadius: '999px',
                              backgroundColor: 'var(--primary-indigo)',
                              color: '#fff',
                              fontSize: '10.5px',
                              fontWeight: 700,
                            }}
                          >
                            MATCH
                          </span>
                        ) : (
                          <span style={{ color: 'var(--text-muted)', fontSize: '11px' }}>
                            —
                          </span>
                        )}
                      </td>
                      {currentSheet.columns.map((col) => (
                        <td key={col}>
                          {col === 'price' || col === 'rate'
                            ? `$${Number(row[col]).toFixed(2)}`
                            : String(row[col] ?? '—')}
                        </td>
                      ))}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* Right Column: Natural Language Query & Two-Phase Modification Preview */}
      <div className="copilot-side-card">
        <div className="copilot-header">
          <div className="copilot-title">
            <Sparkles size={16} color="#d97706" />
            <span>Sheet AI Copilot</span>
          </div>
          <span className="beta-pill">DEMO</span>
        </div>

        <form
          onSubmit={handleRunPreviewSubmit}
          style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}
        >
          <label className="copilot-field-label">
            Natural-Language Instruction (Query or Modify)
          </label>
          <textarea
            className="announcement-prompt-textarea"
            value={nlInstruction}
            onChange={(e) => setNlInstruction(e.target.value)}
            placeholder="e.g., List products that are out of stock, or Change the price of Trail Rain Jacket to 150..."
          />

          <div style={{ display: 'flex', gap: '8px' }}>
            <button
              type="submit"
              className="btn-primary-indigo"
              style={{ flex: 1 }}
            >
              <Search size={15} />
              Preview Matching Rows
            </button>
            <button
              type="button"
              className="btn-warm-outlined"
              onClick={() =>
                runSimulatedPreview(selectedSheetKey, 'Show all rows')
              }
              title="Reset filter"
            >
              <RotateCcw size={14} />
            </button>
          </div>
        </form>

        {/* Quick Sample Prompts */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <span
            style={{
              fontSize: '12px',
              fontWeight: 600,
              color: 'var(--text-secondary)',
            }}
          >
            Try Sample Instructions:
          </span>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
            {currentSheet.samplePrompts.map((sample) => (
              <button
                key={sample}
                type="button"
                className="btn-warm-outlined"
                style={{
                  fontSize: '11.5px',
                  padding: '5px 10px',
                  textAlign: 'left',
                }}
                onClick={() => {
                  setNlInstruction(sample);
                  runSimulatedPreview(selectedSheetKey, sample);
                }}
              >
                {sample}
              </button>
            ))}
          </div>
        </div>

        {/* Proposed Modification Review Card */}
        <div className="announcement-section">
          <div className="announcement-title-row">
            <span className="copilot-field-label">
              Proposed Modification Review
            </span>
            <span
              style={{
                fontSize: '11px',
                fontWeight: 700,
                color: 'var(--status-warning)',
              }}
            >
              TWO-PHASE SAFEGUARD
            </span>
          </div>

          {previewState.proposedDiff ? (
            <div
              className="ai-suggestion-box"
              style={{ backgroundColor: '#fffbeb', borderColor: '#f59e0b' }}
            >
              <div style={{ fontSize: '12.5px', fontWeight: 700 }}>
                Target: {previewState.proposedDiff.targetLabel}
              </div>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '10px',
                  padding: '8px 10px',
                  backgroundColor: '#ffffff',
                  borderRadius: '6px',
                  border: '1px solid #fde68a',
                  fontSize: '12.5px',
                }}
              >
                <span>
                  <strong>{previewState.proposedDiff.field}:</strong>{' '}
                  <del style={{ color: '#dc2626' }}>
                    {previewState.proposedDiff.before}
                  </del>
                </span>
                <ArrowRight size={14} />
                <strong style={{ color: '#16a34a' }}>
                  {previewState.proposedDiff.after}
                </strong>
              </div>
              <button
                type="button"
                className="btn-primary-indigo"
                onClick={handleApplyPlaceholderMutation}
              >
                Confirm &amp; Apply Modification (DEMO)
              </button>
            </div>
          ) : (
            <div className="announcement-preview-box">
              Select or enter a modification instruction (e.g.,{' '}
              <em>&ldquo;Change the price of Trail Rain Jacket to 150&rdquo;</em>)
              to preview before/after row changes prior to confirmation.
            </div>
          )}
        </div>
      </div>
    </motion.div>
  );
}
