import React, { useRef, useState, useEffect } from 'react';
import {
  FileSpreadsheet,
  FileText,
  Upload,
  PlusCircle,
  Sparkles,
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
} from 'lucide-react';
import type { WorkspaceDocument } from '../../../shared/types/contracts';
import {
  listGoogleDocsApi,
  importGoogleDocApi,
  getGoogleAuthStatusApi,
  getGoogleAuthUrlApi,
  type GoogleDriveFile,
} from '../services/api';
import { getActiveBusinessId, getLoggedInUser } from '../config/constants';

interface KnowledgeSourceBarProps {
  activeBusinessId?: string;
  activeEntity: string;
  activeDisplayName: string;
  activeFileName: string;
  tableList: Array<{ entity: string; displayName: string; rowCount: number }>;
  onSelectTable: (entity: string) => void;
  onUploadCsv: (file: File) => void;
  onOpenAddRow: () => void;
  onOpenImportGoogleSheet: () => void;
  onRefreshTable: () => void;
  documents: WorkspaceDocument[];
  onUploadDocument: (file: File) => void;
  onSelectDocument?: (doc: WorkspaceDocument) => void;
  onLoadDemoScenario: () => void;
  isSeedingDemo: boolean;
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
  onUploadCsv,
  onOpenAddRow,
  onOpenImportGoogleSheet,
  documents,
  onUploadDocument,
  onSelectDocument,
  onLoadDemoScenario,
  isSeedingDemo,
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

  // Reset Google Doc modal state cleanly whenever active workspace changes
  useEffect(() => {
    setShowGoogleDocModal(false);
    setGoogleDocsList([]);
    setSelectedDocId('');
    setCustomDocInput('');
    setDocImportError(null);
    setDocImportSuccess(null);
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

  const handleOpenGoogleDocModal = async () => {
    setShowGoogleDocModal(true);
    setDocImportError(null);
    setDocImportSuccess(null);
    setGoogleDocsList([]);

    const currentUser = getLoggedInUser();
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
    setConnectingDocGoogle(true);
    setDocImportError(null);
    try {
      const url = await getGoogleAuthUrlApi(currentUser?.id || resolvedBusinessId, {
        mode: currentUser?.id ? 'link' : 'login',
        userId: currentUser?.id,
        workspaceId: resolvedBusinessId,
        tab: 'sheets',
      });
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
    <div
      className="knowledge-source-bar-wrapper"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: '12px',
        padding: '16px 20px',
        backgroundColor: 'var(--bg-panel)',
        border: '1px solid var(--border-warm)',
        borderRadius: '14px',
        boxShadow: 'var(--shadow-card)',
      }}
    >
      {/* Top Row: Workspace Status & 1-Click Demo Loader */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          gap: '10px',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '7px',
              fontSize: '13.5px',
              fontWeight: 800,
              color: 'var(--text-primary)',
            }}
          >
            <Layers size={16} color="var(--primary-indigo)" />
            <span>Workspace Knowledge Sources</span>
          </div>

          <span
            style={{
              padding: '3px 10px',
              borderRadius: '999px',
              fontSize: '11px',
              fontWeight: 700,
              backgroundColor: 'var(--bg-subtle-warm)',
              color: 'var(--text-secondary)',
              border: '1px solid var(--border-warm)',
            }}
          >
            {tableList.length} Table{tableList.length === 1 ? '' : 's'} · {documents.length} Policy Doc{documents.length === 1 ? '' : 's'}
          </span>
        </div>

        {/* 1-Click Demo Workspace Loader Button */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <button
            type="button"
            className="btn-warm-outlined"
            style={{
              fontSize: '12px',
              fontWeight: 700,
              padding: '6px 13px',
              borderRadius: '10px',
              backgroundColor: '#fffbeb',
              borderColor: '#f59e0b',
              color: '#92400e',
              display: 'inline-flex',
              alignItems: 'center',
              gap: '6px',
              boxShadow: '0 1px 3px rgba(245, 158, 11, 0.15)',
            }}
            disabled={isSeedingDemo || isBusy}
            onClick={onLoadDemoScenario}
            title="Load the 60-second B2B demo scenario (Commercial Orders + SLA Policy + Supplier Notice)"
          >
            <Sparkles size={14} color="#d97706" className={isSeedingDemo ? 'spin' : ''} />
            <span>{isSeedingDemo ? 'Loading Demo Scenario...' : 'Load Demo Scenario'}</span>
          </button>
        </div>
      </div>

      {/* Second Row: Structured Tables Section & Unstructured Documents Section */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))',
          gap: '14px',
          alignItems: 'stretch',
        }}
      >
        {/* Section 1: Structured Relational Tables (CSV/DB) */}
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: '8px',
            padding: '12px 14px',
            backgroundColor: '#ffffff',
            borderRadius: '12px',
            border: '1px solid var(--border-warm)',
            boxShadow: '0 1px 4px rgba(45, 38, 28, 0.04)',
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              flexWrap: 'wrap',
              gap: '8px',
              fontSize: '11.5px',
              fontWeight: 700,
              color: 'var(--text-secondary)',
              textTransform: 'uppercase',
              letterSpacing: '0.03em',
            }}
          >
            <span style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
              <Database size={13} color="var(--primary-indigo)" />
              Structured Tables (CSV/DB)
            </span>

            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
              {/* Import Google Sheet Button */}
              <button
                type="button"
                className="btn-warm-outlined"
                style={{
                  fontSize: '11px',
                  padding: '3px 9px',
                  borderRadius: '8px',
                  borderColor: '#10b981',
                  color: '#047857',
                  backgroundColor: '#ecfdf5',
                }}
                onClick={onOpenImportGoogleSheet}
                disabled={isBusy}
                title="Import and 2-way sync a Google Sheet into this workspace"
              >
                <ExternalLink size={11} />
                Import Google Sheet
              </button>

              {/* Upload CSV hidden input */}
              <input
                ref={csvInputRef}
                type="file"
                accept=".csv"
                style={{ display: 'none' }}
                onChange={handleCsvChange}
              />
              <button
                type="button"
                className="btn-warm-outlined"
                style={{ fontSize: '11px', padding: '3px 9px', borderRadius: '8px' }}
                onClick={() => csvInputRef.current?.click()}
                disabled={isBusy}
                title="Upload CSV to replace or create table"
              >
                <Upload size={11} />
                Upload CSV
              </button>

              <button
                type="button"
                className="btn-warm-outlined"
                style={{
                  fontSize: '11px',
                  padding: '3px 9px',
                  borderRadius: '8px',
                  borderColor: 'var(--primary-indigo)',
                  color: 'var(--primary-indigo)',
                }}
                onClick={onOpenAddRow}
                disabled={isBusy || !activeEntity}
                title={
                  activeEntity
                    ? 'Add new row to active table'
                    : 'Upload or select a CSV table first'
                }
              >
                <PlusCircle size={11} />
                Add Row
              </button>
            </div>
          </div>

          {/* Table Pills */}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
            {tableList.length === 0 ? (
              <span
                style={{
                  fontSize: '11.5px',
                  color: 'var(--text-secondary)',
                  fontStyle: 'italic',
                }}
              >
                No tables in this workspace yet. Import a Google Sheet, upload a CSV, or click &ldquo;Load Demo Scenario&rdquo;.
              </span>
            ) : (
              tableList.map((t) => {
                const isActive =
                  Boolean(activeEntity) &&
                  t.entity.toLowerCase() === activeEntity.toLowerCase();
                const isSynced = syncedTableMap.has(t.entity.toLowerCase());
                return (
                  <button
                    key={t.entity}
                    type="button"
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: '5px',
                      padding: '4px 10px',
                      borderRadius: '999px',
                      fontSize: '12px',
                      fontWeight: isActive ? 700 : 500,
                      backgroundColor: isActive ? 'var(--primary-indigo)' : 'var(--bg-panel)',
                      color: isActive ? '#ffffff' : 'var(--text-primary)',
                      border: `1px solid ${isActive ? 'var(--primary-indigo-dark)' : 'var(--border-warm)'}`,
                      cursor: 'pointer',
                      transition: 'all 0.15s ease',
                    }}
                    onClick={() => onSelectTable(t.entity)}
                    title={`Switch to table "${t.displayName}" (${t.rowCount} rows)${isSynced ? ' [Synced with Google Sheets]' : ''}`}
                  >
                    <FileSpreadsheet size={13} />
                    <span>{t.displayName}</span>
                    {isSynced && (
                      <span
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: '2px',
                          padding: '1px 5px',
                          borderRadius: '999px',
                          fontSize: '9.5px',
                          fontWeight: 700,
                          backgroundColor: isActive ? '#064e3b' : '#ecfdf5',
                          color: isActive ? '#a7f3d0' : '#059669',
                          border: '1px solid #10b981',
                        }}
                        title="2-Way Synced with Google Sheets"
                      >
                        Sheets
                      </span>
                    )}
                    <span
                      style={{
                        padding: '1px 5px',
                        borderRadius: '999px',
                        fontSize: '10.5px',
                        fontWeight: 700,
                        backgroundColor: isActive
                          ? 'rgba(255,255,255,0.25)'
                          : 'var(--bg-subtle-warm)',
                        color: isActive ? '#ffffff' : 'var(--text-secondary)',
                      }}
                    >
                      {t.rowCount}
                    </span>
                  </button>
                );
              })
            )}
          </div>
        </div>

        {/* Section 2: Unstructured Knowledge Documents (PDF/TXT/MD/GDOC) */}
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: '8px',
            padding: '12px 14px',
            backgroundColor: '#ffffff',
            borderRadius: '12px',
            border: '1px solid var(--border-warm)',
            boxShadow: '0 1px 4px rgba(45, 38, 28, 0.04)',
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              flexWrap: 'wrap',
              gap: '8px',
              fontSize: '11.5px',
              fontWeight: 700,
              color: 'var(--text-secondary)',
              textTransform: 'uppercase',
              letterSpacing: '0.03em',
            }}
          >
            <span style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
              <FileText size={13} color="#2563eb" />
              Policy &amp; Notice Documents (PDF/MD/GDOC)
            </span>

            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              {/* Google Docs Import Button */}
              <button
                type="button"
                className="btn-warm-outlined"
                style={{
                  fontSize: '11px',
                  padding: '3px 9px',
                  borderRadius: '8px',
                  borderColor: '#2563eb',
                  color: '#1d4ed8',
                  backgroundColor: '#eff6ff',
                }}
                onClick={handleOpenGoogleDocModal}
                disabled={isBusy}
                title="Import and index a document from Google Docs"
              >
                <ExternalLink size={11} />
                Import Google Doc
              </button>

              {/* Upload Document input */}
              <input
                ref={docInputRef}
                type="file"
                accept=".pdf,.md,.markdown,.txt"
                style={{ display: 'none' }}
                onChange={handleDocChange}
              />
              <button
                type="button"
                className="btn-warm-outlined"
                style={{
                  fontSize: '11px',
                  padding: '3px 9px',
                  borderRadius: '8px',
                  borderColor: '#2563eb',
                  color: '#1d4ed8',
                }}
                onClick={() => docInputRef.current?.click()}
                disabled={isUploadingDoc || isBusy}
                title="Upload an unstructured business document (.pdf, .md, .txt)"
              >
                <FileUp size={11} />
                {isUploadingDoc ? 'Ingesting...' : 'Upload Doc'}
              </button>
            </div>
          </div>

          {/* Document Pills */}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
            {documents.length === 0 ? (
              <span style={{ fontSize: '11.5px', color: 'var(--text-secondary)', fontStyle: 'italic' }}>
                No policy docs loaded yet. Click &ldquo;Load Demo Scenario&rdquo;, upload a PDF, or import a Google Doc.
              </span>
            ) : (
              documents.map((doc) => {
                const isGDoc =
                  doc.filename.endsWith('.gdoc') ||
                  (doc as any).mime_type === 'application/vnd.google-apps.document';
                return (
                  <button
                    key={doc.doc_id || doc.filename}
                    type="button"
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: '5px',
                      padding: '4px 10px',
                      borderRadius: '999px',
                      fontSize: '12px',
                      fontWeight: 600,
                      backgroundColor: isGDoc ? '#e0e7ff' : '#eff6ff',
                      color: isGDoc ? '#3730a3' : '#1e40af',
                      border: `1px solid ${isGDoc ? '#818cf8' : '#bfdbfe'}`,
                      cursor: onSelectDocument ? 'pointer' : 'default',
                      transition: 'all 0.15s ease',
                    }}
                    onClick={() => onSelectDocument?.(doc)}
                    title={`Indexed document "${doc.filename}" (${doc.page_count} page(s), ${doc.chunk_count} chunk(s))${isGDoc ? ' [Google Docs RAG Ingested]' : ''}`}
                  >
                    <FileText size={13} color={isGDoc ? '#4f46e5' : '#2563eb'} />
                    <span style={{ maxWidth: '200px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {doc.filename}
                    </span>
                    {isGDoc && (
                      <span
                        style={{
                          padding: '1px 4px',
                          borderRadius: '4px',
                          fontSize: '9px',
                          fontWeight: 700,
                          backgroundColor: '#4338ca',
                          color: '#ffffff',
                        }}
                      >
                        GDOC
                      </span>
                    )}
                    <span
                      style={{
                        padding: '1px 5px',
                        borderRadius: '999px',
                        fontSize: '10px',
                        fontWeight: 700,
                        backgroundColor: isGDoc ? '#c7d2fe' : '#dbeafe',
                        color: isGDoc ? '#3730a3' : '#1e40af',
                      }}
                    >
                      {doc.chunk_count} chunks
                    </span>
                  </button>
                );
              })
            )}
          </div>
        </div>
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
    </div>
  );
}
