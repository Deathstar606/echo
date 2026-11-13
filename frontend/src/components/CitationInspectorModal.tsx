import React, { useState, useEffect, useRef, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  FileText,
  Table2,
  X,
  Eye,
  BookOpen,
  Quote,
  Search,
  Copy,
  Check,
  Sparkles,
  Trash2,
  Tag,
  Loader2,
  AlertCircle,
} from 'lucide-react';
import type { Citation } from '../../../shared/types/contracts';
import {
  fetchDocumentChunks,
  deleteWorkspaceDocumentByIdentifier,
} from '../services/api';
import { getActiveWorkspaceId, getActiveBusinessId } from '../config/constants';

export interface ChunkItem {
  id: string;
  chunk_index: number;
  locator: string;
  breadcrumb_header: string | null;
  raw_text: string;
  enriched_text?: string | null;
  extracted_entities: string[];
}

export interface DocumentMetadata {
  id: string;
  workspace_id: string;
  filename: string;
  total_chunks: number;
  all_extracted_entities: string[];
  created_at?: string;
}

interface CitationInspectorModalProps {
  citation: Citation | null;
  workspaceId?: string;
  onClose: () => void;
  onHighlightRow?: (locator: string) => void;
  onAskAboutSection?: (prompt: string) => void;
  onDocumentDeleted?: (deletedDocIdOrFilename: string) => void;
}

function highlightMatches(text: string, query: string): React.ReactNode {
  if (!query || !query.trim() || !text) return text;
  const trimmed = query.trim();
  const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`(${escaped})`, 'gi');
  const parts = text.split(regex);
  if (parts.length === 1) return text;
  return parts.map((part, i) =>
    regex.test(part) ? (
      <mark
        key={i}
        style={{
          backgroundColor: '#fef08a',
          color: '#854d0e',
          borderRadius: '2px',
          padding: '0 2px',
          fontWeight: 600,
        }}
      >
        {part}
      </mark>
    ) : (
      part
    )
  );
}

function parseTableExcerpt(excerpt: string): Array<{ key: string; value: string }> {
  if (!excerpt || !excerpt.trim()) return [];
  const trimmed = excerpt.trim();

  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    try {
      const obj = JSON.parse(trimmed);
      return Object.entries(obj).map(([k, v]) => ({
        key: k,
        value: typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v ?? ''),
      }));
    } catch {
      // Fall through to line/kv parsing
    }
  }

  const lines = trimmed.includes('\n')
    ? trimmed.split('\n')
    : trimmed.split(/,\s*(?=[a-zA-Z0-9_]+[=:])|,\s*/);
  const pairs: Array<{ key: string; value: string }> = [];

  for (const line of lines) {
    const eqIdx = line.indexOf('=');
    const colIdx = line.indexOf(':');
    let splitIdx = -1;
    if (eqIdx !== -1 && (colIdx === -1 || eqIdx < colIdx)) {
      splitIdx = eqIdx;
    } else if (colIdx !== -1) {
      splitIdx = colIdx;
    }

    if (splitIdx !== -1) {
      const k = line.slice(0, splitIdx).trim();
      const v = line.slice(splitIdx + 1).trim();
      if (k) pairs.push({ key: k, value: v });
    } else if (line.trim()) {
      pairs.push({ key: 'Field', value: line.trim() });
    }
  }

  return pairs;
}

function sanitizeEntities(entities: string[]): string[] {
  if (!Array.isArray(entities)) return [];
  const cleaned = entities
    .map((e) => (typeof e === 'string' ? e.trim() : ''))
    .filter((e) => {
      if (!e) return false;
      // Filter out raw comparison fragments like ">= 10000", "< 10000", "> 0", "25%"
      if (/^[<>=!]+\s*\$?\d+/.test(e)) return false;
      if (/^\d+%$/.test(e)) return false;
      return true;
    });

  const unique = Array.from(new Set(cleaned));

  // Sort so alphanumeric IDs (e.g. ACC-1001, DIR-COM-2026-Q4, FIN-POL-008) come first
  return unique.sort((a, b) => {
    const aHasCode = /[A-Za-z]+[-_0-9]/.test(a);
    const bHasCode = /[A-Za-z]+[-_0-9]/.test(b);
    if (aHasCode && !bHasCode) return -1;
    if (!aHasCode && bHasCode) return 1;
    return a.localeCompare(b);
  });
}

export default function CitationInspectorModal({
  citation,
  workspaceId,
  onClose,
  onHighlightRow,
  onAskAboutSection,
  onDocumentDeleted,
}: CitationInspectorModalProps): React.ReactElement | null {
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [documentMeta, setDocumentMeta] = useState<DocumentMetadata | null>(null);
  const [chunks, setChunks] = useState<ChunkItem[]>([]);
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [selectedEntity, setSelectedEntity] = useState<string | null>(null);
  const [showAllEntities, setShowAllEntities] = useState<boolean>(false);
  const [copiedChunkId, setCopiedChunkId] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<boolean>(false);
  const [isDeleting, setIsDeleting] = useState<boolean>(false);

  const citedChunkRef = useRef<HTMLDivElement | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);

  const isDoc = citation?.source_type === 'document';
  const hasCitationFocus = Boolean(
    citation?.locator && !citation.locator.startsWith('Doc:')
  );

  const sanitizedEntities = useMemo(() => {
    return sanitizeEntities(documentMeta?.all_extracted_entities || []);
  }, [documentMeta?.all_extracted_entities]);

  // Load full document & chunk inspection data when viewing a document
  useEffect(() => {
    if (!citation || !isDoc) {
      setChunks([]);
      setDocumentMeta(null);
      setLoading(false);
      setError(null);
      return;
    }

    const docIdentifier = citation.source_id || citation.source_name;
    if (!docIdentifier) {
      setLoading(false);
      return;
    }

    let isMounted = true;
    setLoading(true);
    setError(null);
    setSearchQuery('');
    setSelectedEntity(null);
    setConfirmDelete(false);

    const effectiveWorkspaceId =
      workspaceId || getActiveWorkspaceId() || getActiveBusinessId() || '';

    fetchDocumentChunks(effectiveWorkspaceId, docIdentifier)
      .then((data) => {
        if (!isMounted) return;
        setDocumentMeta(data.document || null);
        setChunks(Array.isArray(data.chunks) ? data.chunks : []);
        setLoading(false);
      })
      .catch((err) => {
        if (!isMounted) return;
        console.warn('[CitationInspectorModal] Failed to load full document chunks:', err);
        setError(err.message || 'Could not fetch document chunks.');
        setLoading(false);
      });

    return () => {
      isMounted = false;
    };
  }, [citation, isDoc, workspaceId]);

  // Smooth scroll to cited chunk once chunks are loaded
  useEffect(() => {
    if (!loading && chunks.length > 0 && citedChunkRef.current) {
      const timer = setTimeout(() => {
        citedChunkRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }, 180);
      return () => clearTimeout(timer);
    }
  }, [loading, chunks]);

  // Filtered chunks based on in-document search and selected entity
  const filteredChunks = useMemo(() => {
    return chunks.filter((chunk) => {
      if (selectedEntity) {
        const matchesEntity =
          Array.isArray(chunk.extracted_entities) &&
          chunk.extracted_entities.includes(selectedEntity);
        if (!matchesEntity) return false;
      }

      if (searchQuery.trim()) {
        const queryLower = searchQuery.trim().toLowerCase();
        const inRaw = chunk.raw_text.toLowerCase().includes(queryLower);
        const inHeader = (chunk.breadcrumb_header || '').toLowerCase().includes(queryLower);
        const inLoc = (chunk.locator || '').toLowerCase().includes(queryLower);
        if (!inRaw && !inHeader && !inLoc) return false;
      }

      return true;
    });
  }, [chunks, searchQuery, selectedEntity]);

  const handleCopyChunk = async (chunkId: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedChunkId(chunkId);
      setTimeout(() => setCopiedChunkId(null), 2000);
    } catch {
      // Fallback
    }
  };

  const handleDeleteDocument = async () => {
    if (!citation) return;
    const docIdentifier = citation.source_id || citation.source_name;
    if (!docIdentifier) return;

    try {
      setIsDeleting(true);
      const effectiveWorkspaceId =
        workspaceId || getActiveWorkspaceId() || getActiveBusinessId() || '';
      await deleteWorkspaceDocumentByIdentifier(effectiveWorkspaceId, docIdentifier);
      setIsDeleting(false);
      setConfirmDelete(false);
      onDocumentDeleted?.(docIdentifier);
      onClose();
    } catch (err: any) {
      setIsDeleting(false);
      alert(`Could not remove document: ${err.message || 'Unknown error'}`);
    }
  };

  if (!citation) return null;

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
            maxWidth: isDoc ? '840px' : '620px',
            width: '94%',
            maxHeight: '90vh',
            backgroundColor: '#ffffff',
            borderRadius: '14px',
            border: '1px solid var(--border-warm)',
            boxShadow: 'var(--shadow-modal)',
            padding: '22px',
            display: 'flex',
            flexDirection: 'column',
            gap: '14px',
            overflow: 'hidden',
          }}
        >
          {/* 4.1 Upgraded Modal Header & Metadata Bar */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              borderBottom: '1px solid var(--border-subtle)',
              paddingBottom: '14px',
              gap: '12px',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', minWidth: 0 }}>
              <div
                style={{
                  width: '36px',
                  height: '36px',
                  borderRadius: '10px',
                  backgroundColor: isDoc ? '#eff6ff' : '#f0fdf4',
                  color: isDoc ? 'var(--primary-indigo)' : '#16a34a',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  border: `1px solid ${isDoc ? '#bfdbfe' : '#bbf7d0'}`,
                  flexShrink: 0,
                }}
              >
                {isDoc ? <FileText size={20} /> : <Table2 size={20} />}
              </div>
              <div style={{ minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                  <h3
                    style={{
                      fontSize: '16px',
                      fontWeight: 700,
                      margin: 0,
                      color: 'var(--text-primary)',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {isDoc ? documentMeta?.filename || citation.source_name : citation.source_name}
                  </h3>
                  {isDoc && (
                    <span
                      style={{
                        padding: '2px 8px',
                        borderRadius: '999px',
                        fontSize: '11px',
                        fontWeight: 700,
                        backgroundColor: '#eff6ff',
                        color: 'var(--primary-indigo)',
                        border: '1px solid #bfdbfe',
                      }}
                    >
                      {documentMeta?.total_chunks || chunks.length || citation.excerpt?.match(/(\d+)\s*chunk/i)?.[1] || 1}{' '}
                      Indexed Chunks
                    </span>
                  )}
                  {isDoc && (
                    <span
                      style={{
                        padding: '2px 8px',
                        borderRadius: '999px',
                        fontSize: '11px',
                        fontWeight: 600,
                        backgroundColor: hasCitationFocus ? '#fef3c7' : '#f1f5f9',
                        color: hasCitationFocus ? '#92400e' : '#475569',
                        border: `1px solid ${hasCitationFocus ? '#fde68a' : '#e2e8f0'}`,
                      }}
                    >
                      {hasCitationFocus ? '★ Citation Focus' : 'Full Document View'}
                    </span>
                  )}
                </div>
                <span style={{ fontSize: '11.5px', color: 'var(--text-secondary)' }}>
                  {isDoc
                    ? 'Unstructured Policy / Knowledge Document • Grounded RAG Source'
                    : 'Structured Relational Database Table • Verified Row Record'}
                </span>
              </div>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0 }}>
              {isDoc && (
                <>
                  {confirmDelete ? (
                    <div
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: '6px',
                        padding: '4px 8px',
                        borderRadius: '8px',
                        backgroundColor: '#fef2f2',
                        border: '1px solid #fecaca',
                      }}
                    >
                      <span style={{ fontSize: '11px', color: '#b91c1c', fontWeight: 600 }}>
                        Remove doc?
                      </span>
                      <button
                        type="button"
                        className="btn-warm-outlined"
                        style={{ fontSize: '11px', padding: '2px 6px', height: '24px' }}
                        onClick={() => setConfirmDelete(false)}
                        disabled={isDeleting}
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        style={{
                          fontSize: '11px',
                          padding: '2px 8px',
                          height: '24px',
                          backgroundColor: '#dc2626',
                          color: '#ffffff',
                          borderRadius: '6px',
                          border: 'none',
                          cursor: 'pointer',
                          fontWeight: 600,
                        }}
                        onClick={handleDeleteDocument}
                        disabled={isDeleting}
                      >
                        {isDeleting ? 'Removing...' : 'Confirm'}
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      className="btn-warm-outlined"
                      style={{
                        fontSize: '11.5px',
                        padding: '4px 10px',
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: '5px',
                        color: '#dc2626',
                        borderColor: '#fca5a5',
                      }}
                      onClick={() => setConfirmDelete(true)}
                      title="Remove this document from the workspace"
                    >
                      <Trash2 size={13} />
                      <span>Remove Doc</span>
                    </button>
                  )}
                </>
              )}

              <button
                type="button"
                className="icon-action-btn"
                onClick={onClose}
                aria-label="Close inspector"
              >
                <X size={18} />
              </button>
            </div>
          </div>

          {/* Beta Preview Notice Header */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '9px 13px',
              borderRadius: '9px',
              backgroundColor: '#fffbeb',
              border: '1px solid #fef3c7',
              boxShadow: '0 1px 2px rgba(245, 158, 11, 0.05)',
              gap: '12px',
              flexShrink: 0,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0, flex: 1 }}>
              <span
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '4px',
                  padding: '2px 7px',
                  borderRadius: '5px',
                  fontSize: '10.5px',
                  fontWeight: 800,
                  letterSpacing: '0.04em',
                  backgroundColor: '#f59e0b',
                  color: '#ffffff',
                  textTransform: 'uppercase',
                  flexShrink: 0,
                }}
              >
                <Sparkles size={11} />
                Beta Preview
              </span>
              <span
                style={{
                  fontSize: '11.5px',
                  color: '#92400e',
                  fontWeight: 500,
                  minWidth: 0,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                <strong>Work in Progress:</strong> Document chunk inspection, semantic entity filtering, and provenance tracking are actively being enhanced.
              </span>
            </div>
            <span
              style={{
                fontSize: '10.5px',
                fontWeight: 600,
                color: '#b45309',
                padding: '2px 8px',
                borderRadius: '999px',
                backgroundColor: '#fef3c7',
                border: '1px solid #fde68a',
                flexShrink: 0,
              }}
            >
              MaxiText AI Studio
            </span>
          </div>

          {/* DOCUMENT MODE (SCENARIOS A & B) */}
          {isDoc ? (
            <>
              {/* 4.2 Interactive Search & Extracted Entity Filter Bar */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                <div style={{ position: 'relative', width: '100%' }}>
                  <Search
                    size={15}
                    style={{
                      position: 'absolute',
                      left: '12px',
                      top: '50%',
                      transform: 'translateY(-50%)',
                      color: '#94a3b8',
                      pointerEvents: 'none',
                    }}
                  />
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="Search clauses, SKUs, codes, or sections in this document..."
                    style={{
                      width: '100%',
                      padding: '8px 34px 8px 34px',
                      fontSize: '12.5px',
                      borderRadius: '8px',
                      border: '1px solid var(--border-warm)',
                      backgroundColor: 'var(--bg-panel)',
                      outline: 'none',
                      color: 'var(--text-primary)',
                      boxSizing: 'border-box',
                    }}
                  />
                  {searchQuery && (
                    <button
                      type="button"
                      onClick={() => setSearchQuery('')}
                      style={{
                        position: 'absolute',
                        right: '10px',
                        top: '50%',
                        transform: 'translateY(-50%)',
                        background: 'none',
                        border: 'none',
                        color: '#94a3b8',
                        cursor: 'pointer',
                        padding: 0,
                      }}
                    >
                      <X size={14} />
                    </button>
                  )}
                </div>

                {/* Extracted Entities Chips Row */}
                {sanitizedEntities.length > 0 && (
                  <div
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '5px',
                      padding: '7px 10px',
                      borderRadius: '8px',
                      backgroundColor: '#f8fafc',
                      border: '1px solid var(--border-subtle)',
                      flexShrink: 0,
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                      <span
                        style={{
                          fontSize: '11px',
                          fontWeight: 700,
                          color: 'var(--text-secondary)',
                          display: 'flex',
                          alignItems: 'center',
                          gap: '4px',
                        }}
                      >
                        <Tag size={12} />
                        Extracted Entities &amp; Identifiers ({sanitizedEntities.length})
                      </span>
                      {selectedEntity && (
                        <button
                          type="button"
                          onClick={() => setSelectedEntity(null)}
                          style={{
                            fontSize: '10.5px',
                            color: 'var(--primary-indigo)',
                            background: 'none',
                            border: 'none',
                            cursor: 'pointer',
                            padding: 0,
                            textDecoration: 'underline',
                          }}
                        >
                          Clear entity filter ({selectedEntity})
                        </button>
                      )}
                    </div>
                    <div
                      style={{
                        display: 'flex',
                        flexWrap: 'wrap',
                        gap: '5px',
                        maxHeight: showAllEntities ? '140px' : '46px',
                        overflowY: 'auto',
                      }}
                    >
                      {(showAllEntities
                        ? sanitizedEntities
                        : sanitizedEntities.slice(0, 16)
                      ).map((entity) => {
                        const isSelected = selectedEntity === entity;
                        return (
                          <button
                            key={entity}
                            type="button"
                            onClick={() => setSelectedEntity(isSelected ? null : entity)}
                            style={{
                              padding: '2px 8px',
                              borderRadius: '999px',
                              fontSize: '10.5px',
                              fontWeight: 600,
                              backgroundColor: isSelected ? 'var(--primary-indigo)' : '#ffffff',
                              color: isSelected ? '#ffffff' : 'var(--text-secondary)',
                              border: `1px solid ${isSelected ? 'var(--primary-indigo)' : 'var(--border-warm)'}`,
                              cursor: 'pointer',
                              transition: 'all 0.15s ease',
                            }}
                          >
                            {entity}
                          </button>
                        );
                      })}
                      {sanitizedEntities.length > 16 && (
                        <button
                          type="button"
                          onClick={() => setShowAllEntities(!showAllEntities)}
                          style={{
                            padding: '2px 8px',
                            borderRadius: '999px',
                            fontSize: '10px',
                            fontWeight: 600,
                            backgroundColor: '#e2e8f0',
                            color: '#475569',
                            border: 'none',
                            cursor: 'pointer',
                          }}
                        >
                          {showAllEntities
                            ? 'Show less'
                            : `+${sanitizedEntities.length - 16} more`}
                        </button>
                      )}
                    </div>
                  </div>
                )}
              </div>

              {/* 4.3 Scrollable Contextual Breadcrumb Chunk Explorer */}
              <div
                ref={scrollContainerRef}
                style={{
                  flex: '1 1 auto',
                  overflowY: 'auto',
                  minHeight: '260px',
                  maxHeight: '52vh',
                  paddingRight: '6px',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '12px',
                }}
              >
                {loading ? (
                  <div
                    style={{
                      padding: '40px 20px',
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: '10px',
                      color: 'var(--text-secondary)',
                      fontSize: '13px',
                    }}
                  >
                    <Loader2 size={24} className="spin-slow" style={{ color: 'var(--primary-indigo)' }} />
                    <span>Loading document sections &amp; breadcrumbs...</span>
                  </div>
                ) : filteredChunks.length > 0 ? (
                  filteredChunks.map((chunk) => {
                    const isCited = Boolean(
                      citation &&
                        citation.locator &&
                        !citation.locator.startsWith('Doc:') &&
                        (chunk.locator.toLowerCase() === citation.locator.toLowerCase() ||
                          chunk.locator.toLowerCase().includes(citation.locator.toLowerCase()) ||
                          (citation.locator.includes('Chunk') && chunk.locator.includes(citation.locator)) ||
                          (citation.excerpt &&
                            citation.excerpt.length > 25 &&
                            chunk.raw_text.includes(citation.excerpt.slice(0, 35))))
                    );

                    return (
                      <div
                        key={chunk.id || chunk.chunk_index}
                        ref={isCited ? citedChunkRef : undefined}
                        style={{
                          borderRadius: '10px',
                          border: isCited ? '2px solid #059669' : '1px solid var(--border-warm)',
                          backgroundColor: isCited ? '#f0fdf4' : '#ffffff',
                          boxShadow: isCited
                            ? '0 0 0 3px rgba(16, 185, 129, 0.15)'
                            : '0 1px 3px rgba(0,0,0,0.03)',
                          overflow: 'hidden',
                          transition: 'all 0.2s ease',
                          flexShrink: 0,
                          display: 'flex',
                          flexDirection: 'column',
                        }}
                      >
                        {/* Chunk Card Top Bar */}
                        <div
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            padding: '8px 12px',
                            backgroundColor: isCited ? '#ecfdf5' : '#f8fafc',
                            borderBottom: isCited ? '1px solid #a7f3d0' : '1px solid var(--border-subtle)',
                            fontSize: '12px',
                            gap: '10px',
                            flexShrink: 0,
                          }}
                        >
                          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0, flex: 1 }}>
                            <span
                              style={{
                                padding: '2px 8px',
                                borderRadius: '6px',
                                fontWeight: 700,
                                fontSize: '11px',
                                backgroundColor: isCited ? '#10b981' : '#e2e8f0',
                                color: isCited ? '#ffffff' : '#334155',
                                flexShrink: 0,
                              }}
                            >
                              Chunk #{chunk.chunk_index + 1}
                            </span>
                            <span
                              title={chunk.locator}
                              style={{
                                fontWeight: 600,
                                color: 'var(--text-secondary)',
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                whiteSpace: 'nowrap',
                                minWidth: 0,
                              }}
                            >
                              {chunk.locator}
                            </span>
                            {isCited && (
                              <span
                                style={{
                                  display: 'inline-flex',
                                  alignItems: 'center',
                                  gap: '3px',
                                  padding: '2px 8px',
                                  borderRadius: '999px',
                                  fontSize: '11px',
                                  fontWeight: 700,
                                  backgroundColor: '#dcfce7',
                                  color: '#15803d',
                                  border: '1px solid #86efac',
                                  flexShrink: 0,
                                }}
                              >
                                ★ Cited in AI Response
                              </span>
                            )}
                          </div>

                          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexShrink: 0 }}>
                            <button
                              type="button"
                              className="btn-warm-outlined"
                              style={{
                                fontSize: '11px',
                                padding: '3px 9px',
                                display: 'inline-flex',
                                alignItems: 'center',
                                gap: '4px',
                                height: '26px',
                                whiteSpace: 'nowrap',
                              }}
                              onClick={() => handleCopyChunk(chunk.id, chunk.raw_text)}
                              title="Copy raw text from this chunk"
                            >
                              {copiedChunkId === chunk.id ? (
                                <>
                                  <Check size={12} style={{ color: '#16a34a' }} />
                                  <span style={{ color: '#16a34a', fontWeight: 600 }}>Copied!</span>
                                </>
                              ) : (
                                <>
                                  <Copy size={12} />
                                  <span>Copy</span>
                                </>
                              )}
                            </button>

                            {onAskAboutSection && (
                              <button
                                type="button"
                                className="btn-primary-indigo"
                                style={{
                                  fontSize: '11px',
                                  padding: '3px 10px',
                                  display: 'inline-flex',
                                  alignItems: 'center',
                                  gap: '4px',
                                  height: '26px',
                                  whiteSpace: 'nowrap',
                                }}
                                onClick={() => {
                                  const docName =
                                    documentMeta?.filename || citation?.source_name || 'Document';
                                  onAskAboutSection(`Regarding ${docName} (${chunk.locator}): `);
                                  onClose();
                                }}
                                title="Prompt workspace copilot about this specific section"
                              >
                                <Sparkles size={12} />
                                <span>Ask About This Section</span>
                              </button>
                            )}
                          </div>
                        </div>

                        {/* Contextual Breadcrumb Banner */}
                        {chunk.breadcrumb_header && (
                          <div
                            style={{
                              padding: '7px 12px',
                              backgroundColor: '#f1f5f9',
                              color: '#334155',
                              fontSize: '11.5px',
                              fontFamily: 'monospace, sans-serif',
                              borderLeft: '3px solid var(--primary-indigo)',
                              borderBottom: '1px solid #e2e8f0',
                              lineHeight: 1.5,
                              whiteSpace: 'pre-wrap',
                              wordBreak: 'break-word',
                              display: 'flex',
                              alignItems: 'flex-start',
                              gap: '6px',
                              flexShrink: 0,
                            }}
                          >
                            <BookOpen size={13} style={{ color: 'var(--primary-indigo)', flexShrink: 0, marginTop: '2px' }} />
                            <div style={{ flex: 1, minWidth: 0 }}>
                              {highlightMatches(chunk.breadcrumb_header, searchQuery)}
                            </div>
                          </div>
                        )}

                        {/* Grounded Raw Text Body */}
                        <div
                          style={{
                            padding: '12px 14px',
                            backgroundColor: isCited ? '#f9fefb' : '#faf8f5',
                            fontSize: '12.5px',
                            lineHeight: 1.65,
                            color: 'var(--text-primary)',
                            whiteSpace: 'pre-wrap',
                            wordBreak: 'break-word',
                            flexShrink: 0,
                          }}
                        >
                          {highlightMatches(chunk.raw_text, searchQuery)}
                        </div>

                        {/* Entities list on chunk */}
                        {chunk.extracted_entities && chunk.extracted_entities.length > 0 && (
                          <div
                            style={{
                              padding: '6px 12px',
                              backgroundColor: '#ffffff',
                              borderTop: '1px solid #f1f5f9',
                              display: 'flex',
                              flexWrap: 'wrap',
                              gap: '4px',
                              alignItems: 'center',
                              flexShrink: 0,
                            }}
                          >
                            <span style={{ fontSize: '10.5px', color: '#94a3b8', fontWeight: 600 }}>
                              Entities:
                            </span>
                            {chunk.extracted_entities.map((ent, idx) => (
                              <span
                                key={ent + idx}
                                style={{
                                  fontSize: '10.5px',
                                  padding: '1px 6px',
                                  borderRadius: '4px',
                                  backgroundColor: selectedEntity === ent ? '#e0e7ff' : '#f1f5f9',
                                  color: selectedEntity === ent ? 'var(--primary-indigo)' : '#475569',
                                  fontWeight: 600,
                                  cursor: 'pointer',
                                }}
                                onClick={() => setSelectedEntity(selectedEntity === ent ? null : ent)}
                                title={`Filter by entity: ${ent}`}
                              >
                                {ent}
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })
                ) : (
                  <div
                    style={{
                      padding: '30px 20px',
                      textAlign: 'center',
                      color: 'var(--text-secondary)',
                      fontSize: '13px',
                    }}
                  >
                    {error ? (
                      <div
                        style={{
                          display: 'flex',
                          flexDirection: 'column',
                          gap: '12px',
                          alignItems: 'center',
                        }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', color: '#dc2626' }}>
                          <AlertCircle size={16} />
                          <span>{error}</span>
                        </div>
                        {citation.excerpt && (
                          <div
                            style={{
                              textAlign: 'left',
                              width: '100%',
                              padding: '12px',
                              borderRadius: '8px',
                              backgroundColor: '#faf8f5',
                              border: '1px solid var(--border-warm)',
                              whiteSpace: 'pre-wrap',
                            }}
                          >
                            <div style={{ fontSize: '11px', fontWeight: 700, marginBottom: '6px' }}>
                              Available Citation Excerpt:
                            </div>
                            {citation.excerpt}
                          </div>
                        )}
                      </div>
                    ) : (
                      <span>No chunks matching the specified search or entity filter.</span>
                    )}
                  </div>
                )}
              </div>
            </>
          ) : (
            /* TABLE MODE (SCENARIO C) */
            <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
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
                    backgroundColor: '#f0fdf4',
                    color: '#166534',
                    border: '1px solid #bbf7d0',
                  }}
                >
                  <Table2 size={13} />
                  Table: {citation.source_name}
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

              {/* Formatted Key-Value Grid */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
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
                  Grounded Table Row Record Data
                </label>

                {(() => {
                  const pairs = parseTableExcerpt(citation.excerpt);
                  if (pairs.length > 0) {
                    return (
                      <div
                        style={{
                          borderRadius: '8px',
                          border: '1px solid var(--border-warm)',
                          overflow: 'hidden',
                          maxHeight: '360px',
                          overflowY: 'auto',
                        }}
                      >
                        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12.5px' }}>
                          <thead>
                            <tr
                              style={{
                                backgroundColor: '#f8fafc',
                                borderBottom: '1px solid var(--border-warm)',
                              }}
                            >
                              <th
                                style={{
                                  textAlign: 'left',
                                  padding: '8px 12px',
                                  fontWeight: 700,
                                  color: '#475569',
                                  width: '38%',
                                }}
                              >
                                Column / Attribute
                              </th>
                              <th
                                style={{
                                  textAlign: 'left',
                                  padding: '8px 12px',
                                  fontWeight: 700,
                                  color: '#475569',
                                }}
                              >
                                Record Value
                              </th>
                            </tr>
                          </thead>
                          <tbody>
                            {pairs.map(({ key, value }, i) => (
                              <tr
                                key={key + i}
                                style={{
                                  backgroundColor: i % 2 === 0 ? '#ffffff' : '#faf8f5',
                                  borderBottom:
                                    i < pairs.length - 1 ? '1px solid #f1f5f9' : 'none',
                                }}
                              >
                                <td
                                  style={{
                                    padding: '8px 12px',
                                    fontWeight: 600,
                                    color: 'var(--text-primary)',
                                  }}
                                >
                                  {key}
                                </td>
                                <td
                                  style={{
                                    padding: '8px 12px',
                                    color: '#1e293b',
                                    fontFamily: 'monospace, sans-serif',
                                  }}
                                >
                                  {value}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    );
                  }

                  return (
                    <div
                      style={{
                        padding: '14px',
                        borderRadius: '8px',
                        backgroundColor: 'var(--bg-panel)',
                        border: '1px solid var(--border-warm)',
                        fontSize: '12.5px',
                        lineHeight: 1.55,
                        color: 'var(--text-primary)',
                        whiteSpace: 'pre-wrap',
                      }}
                    >
                      {citation.excerpt || 'No raw row excerpt available.'}
                    </div>
                  );
                })()}
              </div>
            </div>
          )}

          {/* Modal Footer Actions */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              paddingTop: '8px',
              borderTop: '1px solid var(--border-subtle)',
            }}
          >
            <div style={{ fontSize: '11.5px', color: 'var(--text-secondary)' }}>
              {isDoc && documentMeta ? (
                <span>
                  Showing {filteredChunks.length} of {documentMeta.total_chunks} chunk(s)
                </span>
              ) : null}
            </div>

            <div style={{ display: 'flex', gap: '8px' }}>
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
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}
