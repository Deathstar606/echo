import React, { useRef, useState, useEffect } from 'react';
import {
  FileSpreadsheet,
  FileText,
  Upload,
  PlusCircle,
  Layers,
  Database,
  CheckCircle2,
  AlertCircle,
  FileUp,
  ExternalLink,
  Loader2,
  X,
  FileCheck,
  Link2,
  Trash2,
} from 'lucide-react';
import type { WorkspaceDocument } from '../../../shared/types/contracts';
import {
  listGoogleDocsApi,
  importGoogleDocApi,
  getGoogleAuthStatusApi,
  getGoogleAuthUrlApi,
  type GoogleDriveFile,
} from '../services/api';
import { getActiveBusinessId, getLoggedInUser, isDemoUserAccount } from '../config/constants';

interface KnowledgeSourceBarProps {
  activeBusinessId?: string;
  activeEntity: string;
  activeDisplayName: string;
  activeFileName: string;
  tableList: Array<{ entity: string; displayName: string; rowCount: number }>;
  onSelectTable: (entity: string) => void;
  onRemoveTable?: (entity: string) => Promise<void> | void;
  onUploadCsv: (file: File) => void;
  onOpenAddRow: () => void;
  onOpenImportGoogleSheet: () => void;
  onRefreshTable: () => void;
  documents: WorkspaceDocument[];
  onUploadDocument: (file: File) => void;
  onSelectDocument?: (doc: WorkspaceDocument) => void;
  onRemoveDocument?: (doc: WorkspaceDocument) => Promise<void> | void;
  onLoadDemoScenario?: () => void;
  isSeedingDemo?: boolean;
  isUploadingDoc: boolean;
  isBusy: boolean;
  onRefreshDocuments?: () => void;
  syncedTables?: Array<{ entity: string; google_spreadsheet_id?: string; last_synced_at?: string }>;
}

function extractGoogleDocId(input: string): string {
  const match = input.match(/\/d\/([a-zA-Z0-9-_]+)/);
  if (match) return match[1];
  return input.trim();
}

export default function KnowledgeSourceBar({
  activeBusinessId: activeBusinessIdProp,
  activeEntity,
  tableList,
  onSelectTable,
  onRemoveTable,
  onUploadCsv,
  onOpenAddRow,
  onOpenImportGoogleSheet,
  documents,
  onUploadDocument,
  onSelectDocument,
  onRemoveDocument,
  isUploadingDoc,
  isBusy,
  onRefreshDocuments,
  syncedTables = [],
}: KnowledgeSourceBarProps): React.ReactElement {
  const csvInputRef = useRef<HTMLInputElement>(null);
  const docInputRef = useRef<HTMLInputElement>(null);
  const resolvedBusinessId = activeBusinessIdProp || getActiveBusinessId();

  // Google Doc Import Modal State
  const [showGoogleDocModal, setShowGoogleDocModal] = useState(false);
  const [googleDocsList, setGoogleDocsList] = useState<GoogleDriveFile[]>([]);
  const [selectedDocId, setSelectedDocId] = useState('');
  const [customDocInput, setCustomDocInput] = useState('');
  const [docsLoading, setDocsLoading] = useState(false);
  const [checkingDocGoogleAuth, setCheckingDocGoogleAuth] = useState(false);
  const [isDocGoogleConnected, setIsDocGoogleConnected] = useState(false);
  const [connectingDocGoogle, setConnectingDocGoogle] = useState(false);
  const [importingDoc, setImportingDoc] = useState(false);
  const [docImportError, setDocImportError] = useState<string | null>(null);
  const [docImportSuccess, setDocImportSuccess] = useState<string | null>(null);

  const [pendingRemoval, setPendingRemoval] = useState<
    | { kind: 'table'; entity: string; label: string; rowCount: number }
    | { kind: 'doc'; doc: WorkspaceDocument; label: string; chunkCount: number }
    | null
  >(null);
  const [isRemovingSource, setIsRemovingSource] = useState(false);
  const [removeSourceError, setRemoveSourceError] = useState<string | null>(null);

  // Reset modals cleanly whenever active workspace changes
  useEffect(() => {
    setShowGoogleDocModal(false);
    setGoogleDocsList([]);
    setSelectedDocId('');
    setCustomDocInput('');
    setDocImportError(null);
    setDocImportSuccess(null);
    setPendingRemoval(null);
    setRemoveSourceError(null);
  }, [resolvedBusinessId]);

  const syncedTableMap = React.useMemo(() => {
    const map = new Map<string, { google_spreadsheet_id?: string; last_synced_at?: string }>();
    for (const s of syncedTables) {
      if (s.entity) {
        map.set(s.entity.toLowerCase(), s);
      }
    }
    return map;
  }, [syncedTables]);

  const policyDocuments = React.useMemo(() => {
    const sheetMimes = new Set([
      'application/vnd.google-apps.spreadsheet',
      'text/csv',
      'application/csv',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ]);
    return documents.filter((doc) => {
      const mime = String((doc as any).mime_type || '').trim().toLowerCase();
      if (sheetMimes.has(mime)) return false;
      const fname = String(doc.filename || '').trim().toLowerCase();
      return !fname.endsWith('.csv');
    });
  }, [documents]);

  const handleOpenGoogleDocModal = async () => {
    setShowGoogleDocModal(true);
    setDocImportError(null);
    setDocImportSuccess(null);
    setGoogleDocsList([]);

    const currentUser = getLoggedInUser();
    if (isDemoUserAccount(currentUser)) {
      setIsDocGoogleConnected(false);
      setCheckingDocGoogleAuth(false);
      return;
    }
    const statusTarget = currentUser?.id || resolvedBusinessId;

    setCheckingDocGoogleAuth(true);
    setIsDocGoogleConnected(false);
    try {
      const authStatus = await getGoogleAuthStatusApi(statusTarget);
      if (!authStatus?.connected) {
        setIsDocGoogleConnected(false);
        return;
      }

      setIsDocGoogleConnected(true);
      setDocsLoading(true);
      try {
        const files = await listGoogleDocsApi(resolvedBusinessId);
        setGoogleDocsList(files);
        if (files.length > 0) {
          setSelectedDocId((prev) =>
            prev && files.some((f) => f.id === prev) ? prev : files[0].id
          );
        }
      } catch {
        // Graceful fallback: Drive listing is optional. User can paste Doc URL/ID directly.
        setGoogleDocsList([]);
      } finally {
        setDocsLoading(false);
      }
    } catch {
      setIsDocGoogleConnected(false);
    } finally {
      setCheckingDocGoogleAuth(false);
    }
  };

  const handleConnectGoogleForDocs = async () => {
    const currentUser = getLoggedInUser();
    const isDemo = isDemoUserAccount(currentUser);
    setConnectingDocGoogle(true);
    setDocImportError(null);
    try {
      const url = !isDemo && currentUser?.id
        ? await getGoogleAuthUrlApi(currentUser.id, {
            mode: 'link',
            userId: currentUser.id,
            workspaceId: resolvedBusinessId,
            tab: 'sheets',
          })
        : await getGoogleAuthUrlApi('');
      window.location.href = url;
    } catch (err: any) {
      setDocImportError(err?.message || 'Failed to initiate Google account connection.');
      setConnectingDocGoogle(false);
    }
  };

  const handleImportGoogleDoc = async () => {
    const targetId = extractGoogleDocId(customDocInput.trim() || selectedDocId);
    if (!targetId) {
      setDocImportError('Please select a Google Doc or enter a valid Document ID or URL.');
      return;
    }

    setImportingDoc(true);
    setDocImportError(null);
    try {
      const res = await importGoogleDocApi(targetId, resolvedBusinessId);
      setDocImportSuccess(
        `Successfully imported "${res.filename}" (${res.page_count} page(s), ${res.chunk_count} chunk(s)).`
      );
      if (onRefreshDocuments) {
        onRefreshDocuments();
      }
      setTimeout(() => {
        setShowGoogleDocModal(false);
        setDocImportSuccess(null);
      }, 1500);
    } catch (err: any) {
      if (err?.status === 401 || /no google workspace account/i.test(err?.message || '')) {
        setIsDocGoogleConnected(false);
      }
      setDocImportError(err?.message || 'Failed to import and index Google Doc.');
    } finally {
      setImportingDoc(false);
    }
  };

  const handleCsvChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      onUploadCsv(file);
      e.target.value = '';
    }
  };

  const handleDocChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      onUploadDocument(file);
      e.target.value = '';
    }
  };

  return (
    <div className="knowledge-source-bar-wrapper ksb-shell">
      {/* Top Bar: Title, Resource Summary & Demo Scenario Loader */}
      <div className="ksb-topbar">
        <div className="ksb-title-group">
          <div className="ksb-icon-badge" aria-hidden="true">
            <Layers size={15} />
          </div>
          <div className="ksb-title-meta">
            <span className="ksb-title-text">Workspace Knowledge Sources</span>
            <span className="ksb-summary-pill">
              {tableList.length} Table{tableList.length === 1 ? '' : 's'} · {policyDocuments.length} Policy Doc{policyDocuments.length === 1 ? '' : 's'}
            </span>
          </div>
        </div>
      </div>

      {/* Unified Split Panes: Structured Tables & Policy Documents */}
      <div className="ksb-split-grid">
        {/* Pane 1: Structured Relational Tables (CSV/DB) */}
        <section className="ksb-pane" aria-label="Structured tables">
          <div className="ksb-pane-header">
            <div className="ksb-pane-title">
              <span className="ksb-pane-dot is-indigo" aria-hidden="true">
                <Database size={12} />
              </span>
              <span>Structured Tables</span>
              <span className="ksb-pane-subtag">CSV / DB</span>
            </div>

            <div className="ksb-actions-group">
              <button
                type="button"
                className="ksb-action-btn is-emerald"
                onClick={onOpenImportGoogleSheet}
                disabled={isBusy}
                title="Import and 2-way sync a Google Sheet into this workspace"
              >
                <ExternalLink size={11.5} />
                <span>Import Sheet</span>
              </button>

              <input
                ref={csvInputRef}
                type="file"
                accept=".csv"
                style={{ display: 'none' }}
                onChange={handleCsvChange}
              />
              <button
                type="button"
                className="ksb-action-btn"
                onClick={() => csvInputRef.current?.click()}
                disabled={isBusy}
                title="Upload CSV to replace or create table"
              >
                <Upload size={11.5} />
                <span>Upload CSV</span>
              </button>

              <button
                type="button"
                className="ksb-action-btn is-indigo"
                onClick={onOpenAddRow}
                disabled={isBusy || !activeEntity}
                title={
                  activeEntity
                    ? 'Add new row to active table'
                    : 'Upload or select a CSV table first'
                }
              >
                <PlusCircle size={11.5} />
                <span>Add Row</span>
              </button>
            </div>
          </div>

          <div className="ksb-pills-row">
            {tableList.length === 0 ? (
              <span className="ksb-empty-hint">
                No tables in this workspace yet. Import a Google Sheet, upload a CSV, or load the demo scenario.
              </span>
            ) : (
              tableList.map((t) => {
                const isActive =
                  Boolean(activeEntity) &&
                  t.entity.toLowerCase() === activeEntity.toLowerCase();
                const isSynced = syncedTableMap.has(t.entity.toLowerCase());
                return (
                  <div
                    key={t.entity}
                    className={`ksb-source-pill ksb-table-pill ${isActive ? 'is-active' : ''}`}
                  >
                    <button
                      type="button"
                      className="ksb-pill-main-btn"
                      onClick={() => onSelectTable(t.entity)}
                      title={`Switch to table "${t.displayName}" (${t.rowCount} rows)${isSynced ? ' [Synced with Google Sheets]' : ''}`}
                    >
                      <FileSpreadsheet size={13} className="ksb-pill-icon" />
                      <span className="ksb-pill-label">{t.displayName}</span>
                      {isSynced && (
                        <span
                          className={`ksb-pill-subbadge ${isActive ? 'is-active' : 'is-synced'}`}
                          title="2-Way Synced with Google Sheets"
                        >
                          Sheets
                        </span>
                      )}
                      <span className={`ksb-pill-count ${isActive ? 'is-active' : ''}`}>
                        {t.rowCount}
                      </span>
                    </button>
                    {onRemoveTable && (
                      <button
                        type="button"
                        className={`ksb-pill-remove-btn ${isActive ? 'is-active' : ''}`}
                        disabled={isBusy || isRemovingSource}
                        onClick={() => {
                          setRemoveSourceError(null);
                          setPendingRemoval({
                            kind: 'table',
                            entity: t.entity,
                            label: t.displayName || t.entity,
                            rowCount: t.rowCount,
                          });
                        }}
                        title={`Remove "${t.displayName}" from workspace database`}
                        aria-label={`Remove sheet ${t.displayName}`}
                      >
                        <Trash2 size={11} />
                      </button>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </section>

        {/* Pane 2: Unstructured Knowledge Documents (PDF/TXT/MD/GDOC) */}
        <section className="ksb-pane" aria-label="Policy and notice documents">
          <div className="ksb-pane-header">
            <div className="ksb-pane-title">
              <span className="ksb-pane-dot is-blue" aria-hidden="true">
                <FileText size={12} />
              </span>
              <span>Policy &amp; Notice Docs</span>
              <span className="ksb-pane-subtag">PDF / MD / GDOC</span>
            </div>

            <div className="ksb-actions-group">
              <button
                type="button"
                className="ksb-action-btn is-blue"
                onClick={handleOpenGoogleDocModal}
                disabled={isBusy}
                title="Import and index a document from Google Docs"
              >
                <ExternalLink size={11.5} />
                <span>Import Doc</span>
              </button>

              <input
                ref={docInputRef}
                type="file"
                accept=".pdf,.md,.markdown,.txt"
                style={{ display: 'none' }}
                onChange={handleDocChange}
              />
              <button
                type="button"
                className="ksb-action-btn"
                onClick={() => docInputRef.current?.click()}
                disabled={isUploadingDoc || isBusy}
                title="Upload an unstructured business document (.pdf, .md, .txt)"
              >
                <FileUp size={11.5} />
                <span>{isUploadingDoc ? 'Ingesting...' : 'Upload Doc'}</span>
              </button>
            </div>
          </div>

          <div className="ksb-pills-row">
            {policyDocuments.length === 0 ? (
              <span className="ksb-empty-hint">
                No policy docs loaded yet. Upload a PDF/MD, import a Google Doc, or load the demo scenario.
              </span>
            ) : (
              policyDocuments.map((doc) => {
                const isGDoc =
                  doc.filename.endsWith('.gdoc') ||
                  (doc as any).mime_type === 'application/vnd.google-apps.document';
                return (
                  <div
                    key={doc.doc_id || doc.filename}
                    className={`ksb-source-pill ksb-doc-pill ${isGDoc ? 'is-gdoc' : ''} ${onSelectDocument ? 'is-clickable' : ''}`}
                  >
                    <button
                      type="button"
                      className="ksb-pill-main-btn"
                      onClick={() => onSelectDocument?.(doc)}
                      title={`Indexed document "${doc.filename}" (${doc.page_count} page(s), ${doc.chunk_count} chunk(s))${isGDoc ? ' [Google Docs RAG Ingested]' : ''}`}
                    >
                      <FileText size={13} className="ksb-pill-icon" />
                      <span className="ksb-pill-label ksb-doc-name">{doc.filename}</span>
                      {isGDoc && <span className="ksb-pill-gdoc-tag">GDOC</span>}
                      <span className="ksb-pill-count is-doc">{doc.chunk_count} chunks</span>
                    </button>
                    {onRemoveDocument && doc.doc_id && (
                      <button
                        type="button"
                        className="ksb-pill-remove-btn is-doc"
                        disabled={isBusy || isRemovingSource}
                        onClick={() => {
                          setRemoveSourceError(null);
                          setPendingRemoval({
                            kind: 'doc',
                            doc,
                            label: doc.filename,
                            chunkCount: Number(doc.chunk_count || 0),
                          });
                        }}
                        title={`Remove "${doc.filename}" and all indexed chunks`}
                        aria-label={`Remove document ${doc.filename}`}
                      >
                        <Trash2 size={11} />
                      </button>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </section>
      </div>

      {/* Google Docs Import Modal */}
      {showGoogleDocModal && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            backgroundColor: 'rgba(15, 23, 42, 0.45)',
            backdropFilter: 'blur(3px)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 9999,
            padding: '16px',
          }}
          onClick={() => setShowGoogleDocModal(false)}
        >
          <div
            style={{
              backgroundColor: '#ffffff',
              borderRadius: '14px',
              boxShadow: '0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 8px 10px -6px rgba(0, 0, 0, 0.1)',
              width: '100%',
              maxWidth: '520px',
              padding: '22px',
              display: 'flex',
              flexDirection: 'column',
              gap: '14px',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                borderBottom: '1px solid var(--border-warm)',
                paddingBottom: '10px',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <FileText size={18} color="#2563eb" />
                <h3 style={{ margin: 0, fontSize: '15px', fontWeight: 700, color: 'var(--text-primary)' }}>
                  Import Google Doc into Knowledge Base
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setShowGoogleDocModal(false)}
                style={{
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  color: 'var(--text-secondary)',
                }}
              >
                <X size={18} />
              </button>
            </div>

            {checkingDocGoogleAuth ? (
              <div
                style={{
                  padding: '28px 16px',
                  textAlign: 'center',
                  fontSize: '13px',
                  color: 'var(--text-secondary)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: '8px',
                }}
              >
                <Loader2 size={16} className="spin" />
                <span>Checking Google Workspace account connection...</span>
              </div>
            ) : !isDocGoogleConnected ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
                <div
                  style={{
                    padding: '14px',
                    borderRadius: '10px',
                    backgroundColor: '#eff6ff',
                    border: '1px solid #bfdbfe',
                    color: '#1e3a8a',
                    fontSize: '13px',
                    lineHeight: 1.5,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '6px',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '7px', fontWeight: 700 }}>
                    <Link2 size={16} color="#2563eb" />
                    <span>Connect Google Account Required</span>
                  </div>
                  <span>
                    You are currently signed in with email and password without a linked Google account. Please connect your Google account first to access and import documents from Google Docs.
                  </span>
                </div>

                {docImportError && (
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '8px',
                      padding: '8px 12px',
                      borderRadius: '8px',
                      backgroundColor: '#fef2f2',
                      border: '1px solid #fecaca',
                      color: '#b91c1c',
                      fontSize: '12px',
                    }}
                  >
                    <AlertCircle size={15} style={{ flexShrink: 0 }} />
                    <span>{docImportError}</span>
                  </div>
                )}

                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
                  <button
                    type="button"
                    className="btn-warm-outlined"
                    style={{ fontSize: '12.5px', padding: '7px 14px' }}
                    onClick={() => setShowGoogleDocModal(false)}
                    disabled={connectingDocGoogle}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="btn-primary-indigo"
                    style={{
                      fontSize: '12.5px',
                      padding: '7px 16px',
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: '8px',
                    }}
                    onClick={handleConnectGoogleForDocs}
                    disabled={connectingDocGoogle}
                  >
                    {connectingDocGoogle ? (
                      <>
                        <Loader2 size={14} className="spin" />
                        <span>Redirecting to Google...</span>
                      </>
                    ) : (
                      <>
                        <Link2 size={14} />
                        <span>Connect Google Account</span>
                      </>
                    )}
                  </button>
                </div>
              </div>
            ) : (
              <>
                <p style={{ margin: 0, fontSize: '12.5px', color: 'var(--text-secondary)', lineHeight: 1.5 }}>
                  Select a Google Doc from your connected Google Drive, or paste a Google Docs URL / ID below. The document will be structurally parsed, chunked, and indexed into your RAG knowledge base.
                </p>

                {docsLoading ? (
                  <div
                    style={{
                      padding: '24px',
                      textAlign: 'center',
                      fontSize: '13px',
                      color: 'var(--text-secondary)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: '8px',
                    }}
                  >
                    <Loader2 size={16} className="spin" />
                    <span>Loading your Google Docs...</span>
                  </div>
                ) : googleDocsList.length > 0 ? (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                    <label style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-primary)' }}>
                      Choose from your Google Drive:
                    </label>
                    <select
                      value={selectedDocId}
                      onChange={(e) => {
                        setSelectedDocId(e.target.value);
                        setCustomDocInput('');
                      }}
                      style={{
                        padding: '8px 12px',
                        borderRadius: '8px',
                        border: '1px solid var(--border-warm)',
                        fontSize: '13px',
                        backgroundColor: '#ffffff',
                      }}
                    >
                      {googleDocsList.map((f) => (
                        <option key={f.id} value={f.id}>
                          {f.name} {f.modifiedTime ? `(Updated ${new Date(f.modifiedTime).toLocaleDateString()})` : ''}
                        </option>
                      ))}
                    </select>
                  </div>
                ) : null}

                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                  <label style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-primary)' }}>
                    Or enter Google Doc URL or ID:
                  </label>
                  <input
                    type="text"
                    placeholder="https://docs.google.com/document/d/1BxiMVs.../edit"
                    value={customDocInput}
                    onChange={(e) => setCustomDocInput(e.target.value)}
                    style={{
                      padding: '8px 12px',
                      borderRadius: '8px',
                      border: '1px solid var(--border-warm)',
                      fontSize: '13px',
                    }}
                  />
                </div>

                {docImportError && (
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '8px',
                      padding: '8px 12px',
                      borderRadius: '8px',
                      backgroundColor: '#fef2f2',
                      border: '1px solid #fecaca',
                      color: '#b91c1c',
                      fontSize: '12px',
                    }}
                  >
                    <AlertCircle size={15} style={{ flexShrink: 0 }} />
                    <span>{docImportError}</span>
                  </div>
                )}

                {docImportSuccess && (
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '8px',
                      padding: '8px 12px',
                      borderRadius: '8px',
                      backgroundColor: '#f0fdf4',
                      border: '1px solid #bbf7d0',
                      color: '#15803d',
                      fontSize: '12px',
                    }}
                  >
                    <CheckCircle2 size={15} style={{ flexShrink: 0 }} />
                    <span>{docImportSuccess}</span>
                  </div>
                )}

                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'flex-end',
                    gap: '8px',
                    marginTop: '6px',
                  }}
                >
                  <button
                    type="button"
                    className="btn-warm-outlined"
                    style={{ fontSize: '12.5px', padding: '6px 14px' }}
                    onClick={() => setShowGoogleDocModal(false)}
                    disabled={importingDoc}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="btn-primary-indigo"
                    style={{
                      fontSize: '12.5px',
                      padding: '6px 16px',
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: '6px',
                    }}
                    onClick={handleImportGoogleDoc}
                    disabled={importingDoc || (!selectedDocId && !customDocInput.trim())}
                  >
                    {importingDoc ? (
                      <>
                        <Loader2 size={14} className="spin" />
                        <span>Parsing &amp; Ingesting...</span>
                      </>
                    ) : (
                      <>
                        <FileCheck size={14} />
                        <span>Import to RAG</span>
                      </>
                    )}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* Remove Knowledge Source Confirmation Modal */}
      {pendingRemoval && (
        <div
          className="modal-backdrop"
          style={{ zIndex: 9999 }}
          onClick={() => {
            if (!isRemovingSource) setPendingRemoval(null);
          }}
        >
          <div
            className="modal-card liquid-glass-modal"
            style={{ maxWidth: '450px', gap: '14px', borderRadius: '16px' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <div
                  style={{
                    width: 34,
                    height: 34,
                    borderRadius: '10px',
                    backgroundColor: '#fef2f2',
                    color: '#dc2626',
                    border: '1px solid #fecaca',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    flexShrink: 0,
                  }}
                >
                  <Trash2 size={16} />
                </div>
                <div>
                  <h3 style={{ margin: 0, fontSize: '15.5px', fontWeight: 700, color: '#0f172a' }}>
                    {pendingRemoval.kind === 'table'
                      ? 'Remove Sheet From Workspace'
                      : 'Remove Document & Chunks'}
                  </h3>
                  <p style={{ margin: 0, fontSize: '12px', color: 'var(--text-secondary)' }}>
                    Permanent cleanup for this workspace context
                  </p>
                </div>
              </div>
              <button
                type="button"
                className="icon-action-btn"
                disabled={isRemovingSource}
                onClick={() => setPendingRemoval(null)}
                aria-label="Close removal dialog"
              >
                <X size={16} />
              </button>
            </div>

            <div
              style={{
                padding: '11px 13px',
                borderRadius: '10px',
                backgroundColor: '#faf7f2',
                border: '1px solid var(--border-warm)',
                fontSize: '12.5px',
                lineHeight: 1.5,
                color: '#334155',
              }}
            >
              {pendingRemoval.kind === 'table' ? (
                <>
                  This will remove sheet <strong>{pendingRemoval.label}</strong> (
                  <strong>{pendingRemoval.rowCount}</strong> database row(s)), its workspace table
                  metadata, and any Google Sheet sync entry for this workspace.
                </>
              ) : (
                <>
                  This will remove <strong>{pendingRemoval.label}</strong> from workspace documents
                  and delete all <strong>{pendingRemoval.chunkCount}</strong> indexed document
                  chunk(s) belonging to it.
                </>
              )}
            </div>

            {removeSourceError && (
              <div className="alert-banner error" style={{ fontSize: '12px' }}>
                <AlertCircle size={14} style={{ flexShrink: 0 }} />
                <span>{removeSourceError}</span>
              </div>
            )}

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
              <button
                type="button"
                className="btn-warm-outlined"
                style={{ fontSize: '12.5px', padding: '6px 14px' }}
                disabled={isRemovingSource}
                onClick={() => setPendingRemoval(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                style={{
                  fontSize: '12.5px',
                  padding: '6px 16px',
                  borderRadius: '10px',
                  border: '1px solid #dc2626',
                  backgroundColor: '#dc2626',
                  color: '#ffffff',
                  fontWeight: 600,
                  cursor: isRemovingSource ? 'not-allowed' : 'pointer',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '6px',
                  opacity: isRemovingSource ? 0.7 : 1,
                }}
                disabled={isRemovingSource}
                onClick={async () => {
                  setIsRemovingSource(true);
                  setRemoveSourceError(null);
                  try {
                    if (pendingRemoval.kind === 'table' && onRemoveTable) {
                      await onRemoveTable(pendingRemoval.entity);
                    } else if (pendingRemoval.kind === 'doc' && onRemoveDocument) {
                      await onRemoveDocument(pendingRemoval.doc);
                    }
                    setPendingRemoval(null);
                  } catch (err: any) {
                    setRemoveSourceError(err?.message || 'Failed to remove context source.');
                  } finally {
                    setIsRemovingSource(false);
                  }
                }}
              >
                {isRemovingSource ? (
                  <>
                    <Loader2 size={13.5} className="spin" />
                    <span>Removing...</span>
                  </>
                ) : (
                  <>
                    <Trash2 size={13.5} />
                    <span>Remove</span>
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
