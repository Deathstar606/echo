import React, { useEffect, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
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
  Wand2,
  Save,
  Trash2,
  RefreshCw,
  Loader2,
  Edit3,
  AlertTriangle,
  Lock,
} from 'lucide-react';
import {
  loadSheetRows,
  runSheetQuery,
  previewSheetMutation,
  applySheetMutation,
  generateNewSheetDraft,
  saveGeneratedDraftToDb,
  importSheetCsvFile,
  setActiveSheetEntity,
  setSheetNlPrompt,
  clearSheetFiltersAndFeedback,
  discardMutationPreview,
  discardGeneratedDraft,
} from '../store/sheetSlice';

const PRODUCT_COLUMNS = [
  'name',
  'description',
  'price',
  'stock',
  'category',
  'size',
  'color',
];

const SERVICE_COLUMNS = [
  'name',
  'description',
  'rate',
  'availability',
  'size',
  'available_from',
];

const SAMPLE_PROMPTS_BY_ENTITY = {
  products: [
    {
      type: 'query',
      label: 'Out of stock products',
      text: 'List products that are out of stock.',
    },
    {
      type: 'query',
      label: 'Price above 100',
      text: 'Show me products with a price above 100.',
    },
    {
      type: 'query',
      label: 'Red products in size XL',
      text: 'Find red products in size XL.',
    },
    {
      type: 'query',
      label: 'Waterproof & lightweight',
      text: 'Find products matching this description: waterproof and lightweight.',
    },
    {
      type: 'mutation',
      label: 'Change Trail Rain Jacket price to 150',
      text: 'Change the price of Trail Rain Jacket to 150.',
    },
    {
      type: 'mutation',
      label: 'Set Trail Rain Jacket stock to zero',
      text: 'Set the stock of Trail Rain Jacket to zero.',
    },
  ],
  services: [
    {
      type: 'query',
      label: 'Unavailable services',
      text: 'Show unavailable services.',
    },
    {
      type: 'query',
      label: 'Rate below 100',
      text: 'Find services with a rate below 100.',
    },
    {
      type: 'query',
      label: 'Home renovation services',
      text: 'Find services related to home renovation.',
    },
    {
      type: 'mutation',
      label: 'Set Kitchen Remodel to unavailable',
      text: 'Update the availability of Kitchen Remodel Consultation to unavailable.',
    },
    {
      type: 'mutation',
      label: 'Set Interior Painting to available',
      text: 'Update the availability of Interior Painting to available.',
    },
  ],
};

function looksLikeMutationInstruction(text) {
  const lower = String(text || '').trim().toLowerCase();
  return /^(?:change|update|set|modify|increase|decrease|mark|make|delete|remove)\b|\b(?:change\s+the|update\s+the|set\s+the)\b/.test(
    lower
  );
}

function formatCellValue(col, value) {
  if (value === null || value === undefined || value === '') {
    return '—';
  }
  if (col === 'price' || col === 'rate') {
    const num = Number(value);
    return Number.isFinite(num) ? `$${num.toFixed(2)}` : String(value);
  }
  if (col === 'available_from') {
    return String(value).slice(0, 10);
  }
  return String(value);
}

export default function SheetManagementPanel() {
  const dispatch = useDispatch();
  const {
    activeEntity,
    rowsByEntity,
    sheetLoadStatus,
    sheetLoadError,
    nlPrompt,
    queryStatus,
    queryError,
    queryResult,
    mutationPreviewStatus,
    mutationPreviewError,
    mutationPreview,
    mutationApplyStatus,
    mutationApplyError,
    mutationApplySuccessMessage,
    generatedDraftByEntity,
    generateStatus,
    generateError,
    saveGeneratedStatus,
    saveGeneratedError,
    saveGeneratedSuccessMessage,
    csvUploadStatus,
    csvUploadMessage,
    csvUploadError,
  } = useSelector((state) => state.sheets);

  // Save mode for generated draft data ('append' | 'replace')
  const [saveMode, setSaveMode] = useState('append');
  const [confirmOverwriteChecked, setConfirmOverwriteChecked] = useState(false);

  // Load both sheets on mount so tab counts are populated immediately
  useEffect(() => {
    dispatch(loadSheetRows('products'));
    dispatch(loadSheetRows('services'));
  }, [dispatch]);

  const activeRows = rowsByEntity[activeEntity] || [];
  const activeColumns =
    activeEntity === 'services' ? SERVICE_COLUMNS : PRODUCT_COLUMNS;
  const activeGeneratedDraft = generatedDraftByEntity[activeEntity] || null;
  const isUnsavedDraftActive = Boolean(activeGeneratedDraft);

  const matchedIdsSet = new Set(
    Array.isArray(queryResult?.matchedIds) ? queryResult.matchedIds : []
  );
  const hasActiveQueryFilter = Boolean(queryResult);

  const handleSwitchEntity = (entity) => {
    dispatch(setActiveSheetEntity(entity));
    setSaveMode('append');
    setConfirmOverwriteChecked(false);
  };

  // Run Natural-Language Query
  const handleRunQuery = async (customText) => {
    if (isUnsavedDraftActive) return;
    const text = (typeof customText === 'string' ? customText : nlPrompt).trim();
    if (!text || queryStatus === 'loading') return;

    await dispatch(
      runSheetQuery({
        entity: activeEntity,
        message: text,
      })
    );
  };

  // Run Stage 1 Mutation Preview (confirm: false)
  const handleRunMutationPreview = async (customText) => {
    if (isUnsavedDraftActive) return;
    const text = (typeof customText === 'string' ? customText : nlPrompt).trim();
    if (!text || mutationPreviewStatus === 'loading') return;

    await dispatch(
      previewSheetMutation({
        entity: activeEntity,
        message: text,
      })
    );
  };

  // Unified form submit (auto-detects query vs mutation intent)
  const handlePrimaryPromptSubmit = async (e) => {
    e.preventDefault();
    if (isUnsavedDraftActive) return;
    const text = nlPrompt.trim();
    if (!text) return;

    if (looksLikeMutationInstruction(text)) {
      await handleRunMutationPreview(text);
    } else {
      await handleRunQuery(text);
    }
  };

  // Stage 2: Confirm & Apply Mutation (confirm: true)
  const handleConfirmMutation = async () => {
    if (
      !mutationPreview ||
      mutationPreview.status !== 'preview' ||
      mutationApplyStatus === 'loading'
    ) {
      return;
    }

    const messageToConfirm = mutationPreview.promptUsed || nlPrompt.trim();
    await dispatch(
      applySheetMutation({
        entity: activeEntity,
        message: messageToConfirm,
      })
    );
  };

  // Generate New Sheet Data (Unsaved Draft Preview)
  const handleGenerateNewData = async () => {
    if (generateStatus === 'loading' || saveGeneratedStatus === 'loading') {
      return;
    }
    setSaveMode('append');
    setConfirmOverwriteChecked(false);
    await dispatch(
      generateNewSheetDraft({
        entity: activeEntity,
        count: 5,
      })
    );
  };

  // Save Generated Sheet Data to DB
  const handleSaveGeneratedData = async () => {
    if (
      !activeGeneratedDraft ||
      !Array.isArray(activeGeneratedDraft.rows) ||
      activeGeneratedDraft.rows.length === 0 ||
      saveGeneratedStatus === 'loading'
    ) {
      return;
    }

    if (saveMode === 'replace' && !confirmOverwriteChecked) {
      return;
    }

    await dispatch(
      saveGeneratedDraftToDb({
        entity: activeEntity,
        rows: activeGeneratedDraft.rows,
        mode: saveMode,
      })
    );
    setConfirmOverwriteChecked(false);
  };

  // CSV Upload Handler
  const handleCsvFileUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    await dispatch(
      importSheetCsvFile({
        entity: activeEntity,
        file,
      })
    );
    e.target.value = '';
  };

  const isBusy =
    sheetLoadStatus === 'loading' ||
    queryStatus === 'loading' ||
    mutationPreviewStatus === 'loading' ||
    mutationApplyStatus === 'loading' ||
    generateStatus === 'loading' ||
    saveGeneratedStatus === 'loading';

  // Rows displayed in the left table: either the unsaved generated draft rows (when active) or the live database rows
  const tableRowsToRender = isUnsavedDraftActive
    ? activeGeneratedDraft.rows
    : activeRows;

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
        gridTemplateColumns: 'minmax(0, 2.2fr) minmax(350px, 1fr)',
        gap: '16px',
      }}
    >
      {/* Left Main Card: Live Products & Services Spreadsheet Area */}
      <div
        className="portal-card"
        style={{ padding: 0, overflow: 'hidden', gap: 0 }}
      >
        <div className="inquiry-card-header">
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '10px',
              flexWrap: 'wrap',
            }}
          >
            <FileSpreadsheet size={18} color="var(--primary-indigo)" />
            <span className="inquiry-card-title">
              Sheet Management ({activeEntity === 'products' ? 'Products' : 'Services'})
            </span>
            {isUnsavedDraftActive && (
              <span
                style={{
                  padding: '2px 9px',
                  borderRadius: '999px',
                  fontSize: '11px',
                  fontWeight: 700,
                  backgroundColor: '#fef3c7',
                  color: '#92400e',
                  border: '1px solid #f59e0b',
                }}
              >
                UNSAVED GENERATED DRAFT PREVIEW
              </span>
            )}
          </div>

          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              flexWrap: 'wrap',
            }}
          >
            <button
              type="button"
              className="btn-warm-outlined"
              style={{
                fontSize: '12.5px',
                padding: '6px 12px',
                borderColor: 'var(--primary-indigo)',
                color: 'var(--primary-indigo-dark)',
                fontWeight: 700,
              }}
              disabled={generateStatus === 'loading' || saveGeneratedStatus === 'loading'}
              onClick={handleGenerateNewData}
            >
              {generateStatus === 'loading' ? (
                <>
                  <Loader2 size={14} className="spin" />
                  Generating Sample Data...
                </>
              ) : (
                <>
                  <Wand2 size={14} />
                  Generate New Sheet Data
                </>
              )}
            </button>

            <label
              className="btn-warm-outlined"
              style={{
                cursor: isUnsavedDraftActive ? 'not-allowed' : 'pointer',
                opacity: isUnsavedDraftActive ? 0.6 : 1,
                fontSize: '12.5px',
                padding: '6px 12px',
              }}
              title="Upload a CSV file to replace the active sheet"
            >
              <Upload size={14} />
              {csvUploadStatus === 'loading' ? 'Uploading...' : 'Import CSV'}
              <input
                type="file"
                accept=".csv"
                disabled={isUnsavedDraftActive || csvUploadStatus === 'loading'}
                onChange={handleCsvFileUpload}
                style={{ display: 'none' }}
              />
            </label>

            <button
              type="button"
              className="icon-action-btn"
              disabled={sheetLoadStatus === 'loading' || isUnsavedDraftActive}
              onClick={() => dispatch(loadSheetRows(activeEntity))}
              title="Refresh sheet from database"
            >
              <RefreshCw
                size={15}
                className={sheetLoadStatus === 'loading' ? 'spin' : ''}
              />
            </button>
          </div>
        </div>

        <div
          style={{
            padding: '18px 20px',
            display: 'flex',
            flexDirection: 'column',
            gap: '14px',
          }}
        >
          {/* Sheet Tabs: Products vs Services */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              flexWrap: 'wrap',
              gap: '12px',
            }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '10px',
                flexWrap: 'wrap',
              }}
            >
              <span style={{ fontWeight: 600, fontSize: '13px' }}>
                Active Sheet:
              </span>
              <div className="target-toggle-group">
                <button
                  type="button"
                  className={`target-toggle-btn ${
                    activeEntity === 'products' ? 'active' : ''
                  }`}
                  onClick={() => handleSwitchEntity('products')}
                >
                  📦 Products ({rowsByEntity.products.length})
                </button>
                <button
                  type="button"
                  className={`target-toggle-btn ${
                    activeEntity === 'services' ? 'active' : ''
                  }`}
                  onClick={() => handleSwitchEntity('services')}
                >
                  🛠️ Services ({rowsByEntity.services.length})
                </button>
              </div>
            </div>

            {hasActiveQueryFilter && !isUnsavedDraftActive && (
              <button
                type="button"
                className="btn-warm-outlined"
                style={{ fontSize: '12px', padding: '4px 10px' }}
                onClick={() => dispatch(clearSheetFiltersAndFeedback())}
              >
                <RotateCcw size={13} />
                Clear Row Highlights ({matchedIdsSet.size} matched)
              </button>
            )}
          </div>

          {/* Unsaved Generated Sheet Data Draft Banner & Controls */}
          {isUnsavedDraftActive && (
            <div
              style={{
                padding: '14px 16px',
                borderRadius: '10px',
                backgroundColor: '#fffbeb',
                border: '1.5px solid #f59e0b',
                display: 'flex',
                flexDirection: 'column',
                gap: '10px',
              }}
            >
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  flexWrap: 'wrap',
                  gap: '8px',
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px',
                    fontWeight: 700,
                    fontSize: '13.5px',
                    color: '#92400e',
                  }}
                >
                  <Wand2 size={16} />
                  <span>
                    Unsaved AI-Generated {activeEntity === 'products' ? 'Products' : 'Services'} Draft ({activeGeneratedDraft.rows.length} schema-validated records)
                  </span>
                </div>
                <span style={{ fontSize: '11.5px', color: '#b45309', fontWeight: 600 }}>
                  Natural-language queries &amp; mutations are disabled until you save or discard this draft.
                </span>
              </div>

              {/* Save Mode Selection (Append vs Replace Explanation) */}
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '6px',
                  padding: '10px 12px',
                  backgroundColor: '#ffffff',
                  borderRadius: '8px',
                  border: '1px solid #fde68a',
                  fontSize: '12.5px',
                }}
              >
                <div style={{ fontWeight: 700, color: 'var(--text-primary)' }}>
                  Choose How to Save Generated Records:
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '16px' }}>
                  <label
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: '6px',
                      cursor: 'pointer',
                      fontWeight: saveMode === 'append' ? 700 : 500,
                    }}
                  >
                    <input
                      type="radio"
                      name="sheet-save-mode"
                      checked={saveMode === 'append'}
                      onChange={() => {
                        setSaveMode('append');
                        setConfirmOverwriteChecked(false);
                      }}
                    />
                    <span>
                      <strong>Append Records (Recommended):</strong> Adds these{' '}
                      {activeGeneratedDraft.rows.length} new records to your existing{' '}
                      {activeRows.length} {activeEntity} without deleting current data.
                    </span>
                  </label>

                  <label
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: '6px',
                      cursor: 'pointer',
                      fontWeight: saveMode === 'replace' ? 700 : 500,
                      color: saveMode === 'replace' ? '#b91c1c' : 'inherit',
                    }}
                  >
                    <input
                      type="radio"
                      name="sheet-save-mode"
                      checked={saveMode === 'replace'}
                      onChange={() => setSaveMode('replace')}
                    />
                    <span>
                      <strong>Replace Existing Sheet:</strong> Overwrites all{' '}
                      {activeRows.length} current {activeEntity} records with these{' '}
                      {activeGeneratedDraft.rows.length} generated records.
                    </span>
                  </label>
                </div>

                {saveMode === 'replace' && (
                  <label
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: '6px',
                      marginTop: '4px',
                      color: '#b91c1c',
                      fontWeight: 600,
                      cursor: 'pointer',
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={confirmOverwriteChecked}
                      onChange={(e) =>
                        setConfirmOverwriteChecked(e.target.checked)
                      }
                    />
                    <span>
                      I confirm that I want to overwrite and replace the existing{' '}
                      {activeRows.length} {activeEntity} record(s) in the database.
                    </span>
                  </label>
                )}
              </div>

              {saveGeneratedError && (
                <div className="alert-banner error" style={{ fontSize: '12px' }}>
                  <AlertCircle size={15} style={{ flexShrink: 0 }} />
                  <span>{saveGeneratedError}</span>
                </div>
              )}

              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
                <button
                  type="button"
                  className="btn-primary-indigo"
                  disabled={
                    saveGeneratedStatus === 'loading' ||
                    generateStatus === 'loading' ||
                    (saveMode === 'replace' && !confirmOverwriteChecked)
                  }
                  onClick={handleSaveGeneratedData}
                >
                  {saveGeneratedStatus === 'loading' ? (
                    <>
                      <Loader2 size={14} className="spin" />
                      Saving to Database...
                    </>
                  ) : (
                    <>
                      <Save size={14} />
                      Save Generated Data ({saveMode === 'replace' ? 'Replace All' : 'Append'})
                    </>
                  )}
                </button>

                <button
                  type="button"
                  className="btn-warm-outlined"
                  disabled={
                    generateStatus === 'loading' ||
                    saveGeneratedStatus === 'loading'
                  }
                  onClick={handleGenerateNewData}
                >
                  <RefreshCw
                    size={14}
                    className={generateStatus === 'loading' ? 'spin' : ''}
                  />
                  Regenerate
                </button>

                <button
                  type="button"
                  className="btn-warm-outlined"
                  style={{ color: '#dc2626', borderColor: '#fca5a5' }}
                  disabled={saveGeneratedStatus === 'loading'}
                  onClick={() => dispatch(discardGeneratedDraft(activeEntity))}
                >
                  <Trash2 size={14} />
                  Discard Draft
                </button>
              </div>
            </div>
          )}

          {/* Status & Feedback Banners */}
          {sheetLoadError && (
            <div className="alert-banner error">
              <AlertCircle size={16} style={{ flexShrink: 0 }} />
              <span>{sheetLoadError}</span>
            </div>
          )}

          {generateError && (
            <div className="alert-banner error">
              <AlertCircle size={16} style={{ flexShrink: 0 }} />
              <span>{generateError}</span>
            </div>
          )}

          {csvUploadError && (
            <div className="alert-banner error">
              <AlertCircle size={16} style={{ flexShrink: 0 }} />
              <span>{csvUploadError}</span>
            </div>
          )}

          {csvUploadMessage && (
            <div className="alert-banner success">
              <CheckCircle2 size={16} style={{ flexShrink: 0 }} />
              <span>{csvUploadMessage}</span>
            </div>
          )}

          {saveGeneratedSuccessMessage && (
            <div className="alert-banner success">
              <CheckCircle2 size={16} style={{ flexShrink: 0 }} />
              <span>{saveGeneratedSuccessMessage}</span>
            </div>
          )}

          {mutationApplySuccessMessage && (
            <div className="alert-banner success">
              <CheckCircle2 size={16} style={{ flexShrink: 0 }} />
              <span>{mutationApplySuccessMessage}</span>
            </div>
          )}

          {/* Query / Match Status Bar */}
          {!isUnsavedDraftActive && (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                flexWrap: 'wrap',
                gap: '8px',
                padding: '10px 14px',
                backgroundColor:
                  queryResult?.status === 'clarification_needed'
                    ? '#fffbeb'
                    : queryResult && queryResult.count === 0
                      ? '#fef2f2'
                      : 'var(--bg-subtle-warm)',
                borderRadius: '8px',
                border:
                  queryResult?.status === 'clarification_needed'
                    ? '1px solid #f59e0b'
                    : queryResult && queryResult.count === 0
                      ? '1px solid #fecaca'
                      : '1px solid var(--border-warm)',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <SlidersHorizontal size={15} color="var(--primary-indigo)" />
                <span style={{ fontWeight: 600, fontSize: '13px' }}>
                  {!queryResult
                    ? `Showing all ${activeRows.length} ${activeEntity} record(s) from database.`
                    : queryResult.status === 'clarification_needed'
                      ? `Clarification Needed: ${queryResult.message}`
                      : queryResult.count === 0
                        ? `0 records matched "${queryResult.promptUsed}". Full sheet remains visible below.`
                        : `Highlighted ${queryResult.count} matching record(s) for "${queryResult.promptUsed}".`}
                </span>
              </div>
              <span style={{ fontSize: '12px', color: 'var(--text-secondary)', fontWeight: 600 }}>
                {queryResult
                  ? `Matched: ${matchedIdsSet.size} of ${activeRows.length} rows`
                  : `Total Rows: ${activeRows.length}`}
              </span>
            </div>
          )}

          {/* Spreadsheet Table */}
          <div className="sheet-table-wrap">
            {sheetLoadStatus === 'loading' && tableRowsToRender.length === 0 ? (
              <div
                style={{
                  padding: '48px 20px',
                  textAlign: 'center',
                  color: 'var(--text-secondary)',
                  fontSize: '13.5px',
                }}
              >
                <Loader2
                  size={22}
                  className="spin"
                  style={{ margin: '0 auto 8px auto' }}
                />
                <div>Loading {activeEntity} records from PostgreSQL...</div>
              </div>
            ) : tableRowsToRender.length === 0 ? (
              <div
                style={{
                  padding: '48px 20px',
                  textAlign: 'center',
                  color: 'var(--text-secondary)',
                  fontSize: '13.5px',
                }}
              >
                No {activeEntity} records found for this business. Click{' '}
                <strong>Generate New Sheet Data</strong> or{' '}
                <strong>Import CSV</strong> above to populate records.
              </div>
            ) : (
              <table className="sheet-table">
                <thead>
                  <tr>
                    <th style={{ width: '54px' }}>#</th>
                    {activeColumns.map((col) => (
                      <th key={col}>{col.replace(/_/g, ' ')}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {tableRowsToRender.map((row, idx) => {
                    const isHighlighted =
                      !isUnsavedDraftActive && matchedIdsSet.has(row.id);
                    return (
                      <tr
                        key={row.id || idx}
                        className={isHighlighted ? 'highlighted-row' : ''}
                      >
                        <td style={{ fontWeight: 700, whiteSpace: 'nowrap' }}>
                          <span>{idx + 1}</span>
                          {isHighlighted && (
                            <span
                              style={{
                                marginLeft: '6px',
                                display: 'inline-block',
                                padding: '1px 6px',
                                borderRadius: '999px',
                                backgroundColor: 'var(--primary-indigo)',
                                color: '#ffffff',
                                fontSize: '9.5px',
                                fontWeight: 700,
                              }}
                            >
                              MATCH
                            </span>
                          )}
                          {isUnsavedDraftActive && (
                            <span
                              style={{
                                marginLeft: '6px',
                                display: 'inline-block',
                                padding: '1px 6px',
                                borderRadius: '999px',
                                backgroundColor: '#d97706',
                                color: '#ffffff',
                                fontSize: '9.5px',
                                fontWeight: 700,
                              }}
                            >
                              DRAFT
                            </span>
                          )}
                        </td>
                        {activeColumns.map((col) => (
                          <td key={col}>{formatCellValue(col, row[col])}</td>
                        ))}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>

      {/* Right Column: MaxiText AI Workspace Copilot (Query & Two-Stage Mutation) */}
      <div className="copilot-side-card">
        <div className="copilot-header">
          <div className="copilot-title">
            <Sparkles size={16} color="#d97706" />
            <span>AI Workspace Copilot</span>
          </div>
          <span
            style={{
              fontSize: '10.5px',
              fontWeight: 700,
              color: 'var(--primary-indigo)',
              backgroundColor: 'var(--accent-lavender-bg)',
              padding: '2px 8px',
              borderRadius: '999px',
            }}
          >
            {activeEntity.toUpperCase()}
          </span>
        </div>

        {/* Disabled Notice while Unsaved Draft is Active */}
        {isUnsavedDraftActive && (
          <div
            className="alert-banner warning"
            style={{
              fontSize: '12px',
              display: 'flex',
              alignItems: 'flex-start',
              gap: '8px',
            }}
          >
            <Lock size={16} style={{ flexShrink: 0, marginTop: 1 }} />
            <div>
              <strong>Unsaved Generated Draft Active</strong>
              <div style={{ marginTop: 2 }}>
                Natural-language querying and sheet mutations are disabled while
                previewing unsaved generated data. Please{' '}
                <strong>Save Generated Data</strong> or <strong>Discard Draft</strong>{' '}
                first.
              </div>
            </div>
          </div>
        )}

        <form
          onSubmit={handlePrimaryPromptSubmit}
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: '10px',
            opacity: isUnsavedDraftActive ? 0.55 : 1,
          }}
        >
          <label className="copilot-field-label" htmlFor="sheet-nl-prompt-input">
            Natural-Language Query or Mutation Instruction
          </label>
          <textarea
            id="sheet-nl-prompt-input"
            className="announcement-prompt-textarea"
            value={nlPrompt}
            onChange={(e) => dispatch(setSheetNlPrompt(e.target.value))}
            disabled={isUnsavedDraftActive || isBusy}
            placeholder={
              activeEntity === 'products'
                ? 'e.g. "List products that are out of stock." or "Change the price of Trail Rain Jacket to 150."'
                : 'e.g. "Show unavailable services." or "Update the availability of Kitchen Remodel Consultation to unavailable."'
            }
          />

          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            <button
              type="button"
              className="btn-primary-indigo"
              style={{ flex: 1, minWidth: '140px', padding: '9px 12px' }}
              disabled={isUnsavedDraftActive || !nlPrompt.trim() || isBusy}
              onClick={() => handleRunQuery(nlPrompt)}
            >
              {queryStatus === 'loading' ? (
                <>
                  <Loader2 size={14} className="spin" />
                  Querying...
                </>
              ) : (
                <>
                  <Search size={14} />
                  Query Sheet
                </>
              )}
            </button>

            <button
              type="button"
              className="btn-warm-outlined"
              style={{
                flex: 1,
                minWidth: '150px',
                padding: '9px 12px',
                borderColor: '#d97706',
                color: '#92400e',
                fontWeight: 700,
              }}
              disabled={isUnsavedDraftActive || !nlPrompt.trim() || isBusy}
              onClick={() => handleRunMutationPreview(nlPrompt)}
            >
              {mutationPreviewStatus === 'loading' ? (
                <>
                  <Loader2 size={14} className="spin" />
                  Previewing...
                </>
              ) : (
                <>
                  <Edit3 size={14} />
                  Preview Mutation
                </>
              )}
            </button>
          </div>
        </form>

        {queryError && (
          <div className="alert-banner error" style={{ fontSize: '12px' }}>
            <AlertCircle size={15} style={{ flexShrink: 0 }} />
            <span>{queryError}</span>
          </div>
        )}

        {mutationPreviewError && (
          <div className="alert-banner error" style={{ fontSize: '12px' }}>
            <AlertCircle size={15} style={{ flexShrink: 0 }} />
            <span>{mutationPreviewError}</span>
          </div>
        )}

        {/* Quick Sample Prompts */}
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: '7px',
            opacity: isUnsavedDraftActive ? 0.5 : 1,
          }}
        >
          <span
            style={{
              fontSize: '12px',
              fontWeight: 600,
              color: 'var(--text-secondary)',
            }}
          >
            Quick Sample Prompts ({activeEntity}):
          </span>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
            {(SAMPLE_PROMPTS_BY_ENTITY[activeEntity] || []).map((sample) => (
              <button
                key={sample.text}
                type="button"
                className="btn-warm-outlined"
                style={{
                  fontSize: '11.5px',
                  padding: '4px 9px',
                  textAlign: 'left',
                  borderColor:
                    sample.type === 'mutation'
                      ? '#fcd34d'
                      : 'var(--border-warm-strong)',
                }}
                disabled={isUnsavedDraftActive || isBusy}
                onClick={() => {
                  dispatch(setSheetNlPrompt(sample.text));
                  if (sample.type === 'mutation') {
                    handleRunMutationPreview(sample.text);
                  } else {
                    handleRunQuery(sample.text);
                  }
                }}
              >
                {sample.type === 'mutation' ? '✏️ ' : '🔍 '}
                {sample.label}
              </button>
            ))}
          </div>
        </div>

        {/* Two-Stage Sheet Mutation Preview & Confirmation Panel */}
        <div className="announcement-section">
          <div className="announcement-title-row">
            <span className="copilot-field-label">
              Two-Stage Modification Safeguard
            </span>
            <span
              style={{
                fontSize: '10.5px',
                fontWeight: 700,
                color: 'var(--status-warning)',
              }}
            >
              STAGE 1 PREVIEW → STAGE 2 CONFIRM
            </span>
          </div>

          {mutationPreview &&
          mutationPreview.status === 'clarification_needed' ? (
            <div
              className="alert-banner warning"
              style={{
                flexDirection: 'column',
                alignItems: 'flex-start',
                gap: '6px',
                fontSize: '12px',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontWeight: 700 }}>
                <AlertTriangle size={15} />
                <span>Clarification Needed Before Modifying</span>
              </div>
              <div>{mutationPreview.message}</div>
            </div>
          ) : mutationPreview && mutationPreview.status === 'no_match' ? (
            <div className="alert-banner warning" style={{ fontSize: '12px' }}>
              <AlertCircle size={15} style={{ flexShrink: 0 }} />
              <span>
                {mutationPreview.message ||
                  'No matching records found for the requested modification.'}
              </span>
            </div>
          ) : mutationPreview && mutationPreview.status === 'preview' ? (
            <div
              className="ai-suggestion-box"
              style={{
                backgroundColor: '#fffbeb',
                borderColor: '#f59e0b',
                gap: '10px',
              }}
            >
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                }}
              >
                <span style={{ fontSize: '12.5px', fontWeight: 700, color: '#92400e' }}>
                  Stage 1 Preview ({mutationPreview.operation?.toUpperCase()})
                </span>
                <span
                  style={{
                    fontSize: '11px',
                    fontWeight: 700,
                    padding: '2px 8px',
                    borderRadius: '999px',
                    backgroundColor: '#fef3c7',
                    color: '#b45309',
                  }}
                >
                  {mutationPreview.affected_count} Row(s) Affected
                </span>
              </div>

              <div style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
                {mutationPreview.message}
              </div>

              {/* Proposed Before/After Diff Per Row */}
              {Array.isArray(mutationPreview.diff) &&
                mutationPreview.diff.length > 0 && (
                  <div
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '6px',
                      maxHeight: '190px',
                      overflowY: 'auto',
                    }}
                  >
                    {mutationPreview.diff.map((rowDiff, i) => {
                      const changedFields = Object.keys(
                        mutationPreview.proposed_changes || {}
                      );
                      return (
                        <div
                          key={rowDiff.id || i}
                          style={{
                            padding: '8px 10px',
                            backgroundColor: '#ffffff',
                            borderRadius: '6px',
                            border: '1px solid #fde68a',
                            fontSize: '12px',
                          }}
                        >
                          <div style={{ fontWeight: 700, marginBottom: '4px' }}>
                            {rowDiff.name}
                          </div>
                          {changedFields.map((field) => (
                            <div
                              key={field}
                              style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: '8px',
                                flexWrap: 'wrap',
                              }}
                            >
                              <span style={{ fontWeight: 600 }}>{field}:</span>
                              <del style={{ color: '#dc2626' }}>
                                {formatCellValue(field, rowDiff.before?.[field])}
                              </del>
                              <ArrowRight size={13} />
                              <strong style={{ color: '#16a34a' }}>
                                {formatCellValue(field, rowDiff.after?.[field])}
                              </strong>
                            </div>
                          ))}
                        </div>
                      );
                    })}
                  </div>
                )}

              {mutationApplyError && (
                <div className="alert-banner error" style={{ fontSize: '12px' }}>
                  <AlertCircle size={14} style={{ flexShrink: 0 }} />
                  <span>{mutationApplyError}</span>
                </div>
              )}

              <div style={{ display: 'flex', gap: '8px' }}>
                <button
                  type="button"
                  className="btn-primary-indigo"
                  style={{ flex: 1 }}
                  disabled={mutationApplyStatus === 'loading' || isUnsavedDraftActive}
                  onClick={handleConfirmMutation}
                >
                  {mutationApplyStatus === 'loading' ? (
                    <>
                      <Loader2 size={14} className="spin" />
                      Applying Update...
                    </>
                  ) : (
                    <>
                      <CheckCircle2 size={14} />
                      Confirm &amp; Apply to Database
                    </>
                  )}
                </button>

                <button
                  type="button"
                  className="btn-warm-outlined"
                  disabled={mutationApplyStatus === 'loading'}
                  onClick={() => dispatch(discardMutationPreview())}
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <div className="announcement-preview-box">
              Enter a modification instruction above and click{' '}
              <strong>Preview Mutation</strong> (e.g.,{' '}
              <em>&ldquo;Change the price of Trail Rain Jacket to 150.&rdquo;</em>)
              to inspect exact before/after changes prior to database confirmation.
            </div>
          )}
        </div>
      </div>
    </motion.div>
  );
}
