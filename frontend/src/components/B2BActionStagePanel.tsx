import React, { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import {
  Sparkles,
  CheckCircle2,
  ArrowRight,
  Mail,
  Table2,
  ShieldAlert,
  HelpCircle,
  Check,
  RotateCcw,
  FileText,
  AlertTriangle,
} from 'lucide-react';
import type {
  Citation,
  ClarificationRequiredPayload,
  DocumentSyncColumnSchema,
  ExecutedPayload,
  PreviewReadyPayload,
  SocraticOption,
  SocraticQuestion,
  WorkspaceEmailPreview,
  WorkspaceMutationDiff,
} from '../../../shared/types/contracts';
import type { WorkflowStatus } from '../hooks/useB2BOperationsWorkflow';
import CitationBadges from './CitationBadges';

interface B2BActionStagePanelProps {
  workflowStatus: WorkflowStatus;
  activeEntity: string;
  isBusy: boolean;
  clarificationData: ClarificationRequiredPayload | null;
  selectedOptionsMap: Record<string, string>;
  previewData: PreviewReadyPayload | null;
  editedEmails?: WorkspaceEmailPreview[];
  editedMutations?: WorkspaceMutationDiff[];
  allowPartialNullable?: boolean;
  executedData: ExecutedPayload | null;
  onSelectSocraticOption: (questionId: string, optionId: string) => void;
  onResolveSocratic: () => void;
  onUpdateEmailDraft?: (
    index: number,
    patch: { subject?: string; body?: string }
  ) => void;
  onApplyTemplateToAllEmails?: (template: {
    subject?: string;
    body?: string;
  }) => void;
  onRestoreOriginalEmails?: () => void;
  onUpdateMutationCell?: (rowIndex: number, column: string, value: string) => void;
  onFillMissingColumn?: (column: string, value: string) => void;
  onToggleMutationRow?: (rowIndex: number, include: boolean) => void;
  onToggleAllowPartialNullable?: (allow: boolean) => void;
  onConfirmOperation: () => void;
  onCancelOperation?: () => void;
  onBackToClarification: () => void;
  onResetWorkflow: () => void;
  onSelectCitation?: (citation: Citation) => void;
}

export default function B2BActionStagePanel({
  workflowStatus,
  activeEntity,
  isBusy,
  clarificationData,
  selectedOptionsMap,
  previewData,
  editedEmails,
  editedMutations,
  allowPartialNullable = false,
  executedData,
  onSelectSocraticOption,
  onResolveSocratic,
  onUpdateEmailDraft,
  onApplyTemplateToAllEmails,
  onRestoreOriginalEmails,
  onUpdateMutationCell,
  onFillMissingColumn,
  onToggleMutationRow,
  onToggleAllowPartialNullable,
  onConfirmOperation,
  onCancelOperation,
  onBackToClarification,
  onResetWorkflow,
  onSelectCitation,
}: B2BActionStagePanelProps): React.ReactElement | null {
  const [previewTab, setPreviewTab] = useState<'mutations' | 'emails'>('mutations');
  const [selectedEmailTab, setSelectedEmailTab] = useState<'all' | number>(0);
  const [templateSubject, setTemplateSubject] = useState('');
  const [templateBody, setTemplateBody] = useState('');
  const [quickFillValues, setQuickFillValues] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!previewData) {
      setTemplateSubject('');
      setTemplateBody('');
      setQuickFillValues({});
      return;
    }
    const hasMutations = (previewData.mutations_preview?.length || 0) > 0;
    const hasEmails = (previewData.emails_preview?.length || 0) > 0;
    setPreviewTab(!hasMutations && hasEmails ? 'emails' : 'mutations');
    setSelectedEmailTab(0);
    setQuickFillValues({});
    const firstEmail = previewData.emails_preview?.[0];
    setTemplateSubject(
      previewData.email_draft_template?.subject || firstEmail?.subject || ''
    );
    setTemplateBody(
      previewData.email_draft_template?.body || firstEmail?.body || ''
    );
  }, [previewData?.workflow_id]);

  if (
    workflowStatus === 'clarification' &&
    clarificationData
  ) {
    return (
      <motion.section
        aria-label="Socratic conflict clarification panel"
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        className="socratic-conflict-gate-card b2b-stage-panel"
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: '12px',
          padding: '16px 18px',
          backgroundColor: 'var(--bg-panel)',
          borderRadius: '10px',
          border: '2px solid #f59e0b',
          boxShadow: '0 4px 12px rgba(245, 158, 11, 0.1)',
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
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '5px',
              padding: '3px 10px',
              borderRadius: '999px',
              fontSize: '11px',
              fontWeight: 800,
              backgroundColor: 'var(--status-warning-bg)',
              color: 'var(--status-warning)',
              border: '1px solid #fcd34d',
            }}
          >
            <ShieldAlert size={13} />
            ACTION PAUSED • CLARIFICATION REQUIRED
          </span>

          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
            <span
              style={{
                padding: '2px 8px',
                borderRadius: '999px',
                fontSize: '11px',
                fontWeight: 700,
                backgroundColor: 'var(--status-error-bg)',
                color: 'var(--status-error)',
                border: '1px solid rgba(248, 113, 113, 0.38)',
              }}
            >
              {clarificationData.conflicting_rows_count} Policy Conflict(s)
            </span>
            <span
              style={{
                padding: '2px 8px',
                borderRadius: '999px',
                fontSize: '11px',
                fontWeight: 700,
                backgroundColor: 'var(--accent-lavender-bg)',
                color: 'var(--primary-indigo-text)',
                border: '1px solid var(--accent-lavender-border)',
              }}
            >
              {clarificationData.affected_rows_count} Affected Row(s)
            </span>
          </div>
        </div>

        <div
          style={{
            padding: '10px 12px',
            backgroundColor: 'var(--status-warning-bg)',
            borderRadius: '8px',
            border: '1px solid rgba(251, 191, 36, 0.38)',
            fontSize: '12.5px',
            lineHeight: 1.5,
            color: 'var(--status-warning)',
          }}
        >
          <strong>Conflict Summary:</strong> {clarificationData.conflict_summary}
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          {clarificationData.socratic_questions.map((q: SocraticQuestion) => (
            <div key={q.question_id} style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <label
                style={{
                  fontSize: '12.5px',
                  fontWeight: 700,
                  color: 'var(--text-primary)',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                }}
              >
                <HelpCircle size={14} color="var(--primary-indigo)" />
                {q.question_text}
              </label>

              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
                  gap: '8px',
                }}
              >
                {q.options.map((opt: SocraticOption) => {
                  const isSelected = selectedOptionsMap[q.question_id] === opt.option_id;
                  return (
                    <button
                      key={opt.option_id}
                      type="button"
                      style={{
                        textAlign: 'left',
                        padding: '10px 12px',
                        borderRadius: '8px',
                        border: `1.5px solid ${isSelected ? 'var(--primary-indigo)' : 'var(--border-warm)'}`,
                        backgroundColor: isSelected ? 'var(--accent-lavender-bg)' : 'var(--bg-card)',
                        cursor: 'pointer',
                        display: 'flex',
                        alignItems: 'flex-start',
                        gap: '10px',
                        transition: 'all 0.15s ease',
                      }}
                      onClick={() => onSelectSocraticOption(q.question_id, opt.option_id)}
                    >
                      <div
                        style={{
                          width: '18px',
                          height: '18px',
                          borderRadius: '50%',
                          border: `2px solid ${isSelected ? 'var(--primary-indigo)' : 'var(--border-warm-strong)'}`,
                          backgroundColor: isSelected ? 'var(--primary-indigo)' : 'var(--bg-subtle-warm)',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          flexShrink: 0,
                          marginTop: '2px',
                        }}
                      >
                        {isSelected && <Check size={11} color="#ffffff" />}
                      </div>

                      <div style={{ flex: 1 }}>
                        <div style={{ fontSize: '12.5px', fontWeight: 700, color: 'var(--text-primary)' }}>
                          {opt.label}
                        </div>
                        <div style={{ fontSize: '11.5px', color: 'var(--text-secondary)', marginTop: '2px' }}>
                          {opt.rule_interpretation}
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>

        <CitationBadges
          citations={clarificationData.citations}
          onSelectCitation={onSelectCitation}
        />

        <div style={{ display: 'flex', gap: '8px', marginTop: '4px', flexWrap: 'wrap' }}>
          <button
            type="button"
            className="btn-primary-indigo"
            style={{ flex: 1, minWidth: '220px', padding: '10px 16px', fontSize: '12.5px' }}
            disabled={isBusy}
            onClick={onResolveSocratic}
          >
            Resolve Conflict &amp; Generate Preview
          </button>

          <button
            type="button"
            className="btn-warm-outlined"
            style={{ padding: '8px 14px', fontSize: '12px' }}
            onClick={onResetWorkflow}
          >
            Cancel
          </button>
        </div>
      </motion.section>
    );
  }

  if (workflowStatus === 'preview' && previewData) {
    const isDocumentSync = previewData.workflow_type === 'document_table_sync';
    const activeMutations =
      isDocumentSync && editedMutations && editedMutations.length > 0
        ? editedMutations
        : previewData.mutations_preview || [];
    const syncColumns: DocumentSyncColumnSchema[] =
      Array.isArray(previewData.table_columns) && previewData.table_columns.length > 0
        ? previewData.table_columns
        : [];
    const colMetaByName = new Map(syncColumns.map((c) => [c.name, c]));
    const includedMutations = activeMutations.filter((m) => m.include !== false);

    const missingRequiredSet = new Set<string>();
    const missingNullableSet = new Set<string>();
    if (isDocumentSync) {
      for (const mut of includedMutations) {
        for (const colName of mut.missing_fields || []) {
          if (colMetaByName.get(colName)?.required) missingRequiredSet.add(colName);
          else missingNullableSet.add(colName);
        }
      }
    }
    const orderedColNames =
      syncColumns.length > 0
        ? syncColumns.map((c) => c.name)
        : Array.from(
            new Set(
              activeMutations.flatMap((m) => [
                ...Object.keys(m.after || {}),
                ...Object.keys(m.before || {}),
              ])
            )
          );
    const allMissingColumns = orderedColNames.filter(
      (c) => missingRequiredSet.has(c) || missingNullableSet.has(c)
    );
    const hasUnresolvedMissing =
      isDocumentSync &&
      (missingRequiredSet.size > 0 || (missingNullableSet.size > 0 && !allowPartialNullable));

    const activeEmails =
      editedEmails && editedEmails.length > 0
        ? editedEmails
        : previewData.emails_preview || [];
    const originalEmails = previewData.emails_preview || [];
    const hasCustomEdits =
      activeEmails.length > 0 &&
      originalEmails.length === activeEmails.length &&
      activeEmails.some(
        (item, idx) =>
          item.subject !== originalEmails[idx]?.subject ||
          item.body !== originalEmails[idx]?.body
      );
    const hasBlankDraft =
      activeEmails.length > 0 &&
      activeEmails.some((item) => !item.subject?.trim() || !item.body?.trim());
    const activeEmailIndex =
      typeof selectedEmailTab === 'number' && selectedEmailTab < activeEmails.length
        ? selectedEmailTab
        : 0;
    const currentEmail = activeEmails[activeEmailIndex];
    const hasMutations = activeMutations.length > 0;

    const handleRestoreDrafts = () => {
      onRestoreOriginalEmails?.();
      const firstOrig = previewData.emails_preview?.[0];
      setTemplateSubject(
        previewData.email_draft_template?.subject || firstOrig?.subject || ''
      );
      setTemplateBody(
        previewData.email_draft_template?.body || firstOrig?.body || ''
      );
    };

    const renderSyncCellInput = (
      rowIdx: number,
      colName: string,
      rawValue: unknown,
      isMissingCell: boolean
    ) => {
      const colSchema = colMetaByName.get(colName);
      const colType = colSchema?.type || 'string';
      const strVal =
        rawValue === null || rawValue === undefined ? '' : String(rawValue);
      const baseInputStyle: React.CSSProperties = {
        width: '100%',
        minWidth: colType === 'integer' || colType === 'number' ? '82px' : '118px',
        padding: '4px 7px',
        fontSize: '11.5px',
        borderRadius: '5px',
        border: isMissingCell
          ? '1.5px solid #f59e0b'
          : '1px solid var(--border-subtle)',
        backgroundColor: isMissingCell
          ? 'var(--status-warning-bg)'
          : 'var(--bg-card)',
        color: 'var(--text-primary)',
        fontFamily: 'inherit',
      };

      if (colType === 'boolean') {
        return (
          <select
            aria-label={`${colName} row ${rowIdx + 1}`}
            value={strVal}
            onChange={(e) => onUpdateMutationCell?.(rowIdx, colName, e.target.value)}
            style={baseInputStyle}
          >
            <option value="">-- select --</option>
            <option value="true">true</option>
            <option value="false">false</option>
          </select>
        );
      }

      const listId =
        colSchema?.representative_values && colSchema.representative_values.length > 0
          ? `sync-col-hints-${previewData.workflow_id}-${colName}`
          : undefined;
      const placeholder = isMissingCell
        ? colSchema?.required
          ? 'Required'
          : 'Missing...'
        : '';

      return (
        <input
          type={
            colType === 'integer' || colType === 'number'
              ? 'number'
              : colType === 'date'
                ? 'date'
                : 'text'
          }
          step={colType === 'integer' ? '1' : colType === 'number' ? 'any' : undefined}
          list={listId}
          aria-label={`${colName} row ${rowIdx + 1}`}
          value={strVal}
          placeholder={placeholder}
          onChange={(e) => onUpdateMutationCell?.(rowIdx, colName, e.target.value)}
          style={baseInputStyle}
        />
      );
    };

    return (
      <motion.section
        aria-label="Stage 1 B2B action preview"
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        className="stage1-preview-card b2b-stage-panel"
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: '12px',
          padding: '16px 18px',
          backgroundColor: 'var(--bg-card)',
          borderRadius: '10px',
          border: isDocumentSync && allMissingColumns.length > 0
            ? '2px solid #f59e0b'
            : '2px solid var(--primary-indigo)',
          boxShadow: '0 4px 14px rgba(57, 70, 211, 0.12)',
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
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '5px',
              padding: '3px 10px',
              borderRadius: '999px',
              fontSize: '11px',
              fontWeight: 800,
              backgroundColor: 'var(--accent-lavender-bg)',
              color: 'var(--primary-indigo-text)',
              border: '1px solid var(--accent-lavender-border)',
            }}
          >
            <Sparkles size={13} />
            {isDocumentSync
              ? `DOCUMENT SYNC PREVIEW • ${String(previewData.operation_mode || 'READY').toUpperCase()}`
              : 'STAGE 1 ACTION PREVIEW • READY'}
          </span>

          {!isDocumentSync && (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                backgroundColor: 'var(--bg-subtle-warm)',
                borderRadius: '8px',
                padding: '2px',
                gap: '2px',
              }}
            >
              <button
                type="button"
                style={{
                  padding: '5px 12px',
                  borderRadius: '6px',
                  fontSize: '12px',
                  fontWeight: previewTab === 'mutations' ? 700 : 500,
                  backgroundColor: previewTab === 'mutations' ? 'var(--primary-indigo)' : 'transparent',
                  color: previewTab === 'mutations' ? '#ffffff' : 'var(--text-secondary)',
                  boxShadow: previewTab === 'mutations' ? '0 2px 6px rgba(88, 26, 255, 0.25)' : 'none',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '5px',
                }}
                onClick={() => setPreviewTab('mutations')}
              >
                <Table2 size={13} />
                <span>DB Rows ({activeMutations.length})</span>
              </button>

              <button
                type="button"
                style={{
                  padding: '5px 12px',
                  borderRadius: '6px',
                  fontSize: '12px',
                  fontWeight: previewTab === 'emails' ? 700 : 500,
                  backgroundColor: previewTab === 'emails' ? 'var(--primary-indigo)' : 'transparent',
                  color: previewTab === 'emails' ? '#ffffff' : 'var(--text-secondary)',
                  boxShadow: previewTab === 'emails' ? '0 2px 6px rgba(88, 26, 255, 0.25)' : 'none',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '5px',
                }}
                onClick={() => setPreviewTab('emails')}
              >
                <Mail size={13} />
                <span>Emails ({previewData.emails_preview?.length || 0})</span>
              </button>
            </div>
          )}
        </div>

        {(previewTab === 'mutations' || isDocumentSync) && isDocumentSync && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                flexWrap: 'wrap',
                gap: '8px',
                fontSize: '12px',
                color: 'var(--text-secondary)',
              }}
            >
              <div>
                Target Active Table:{' '}
                <code style={{ fontWeight: 700 }}>{previewData.target_entity || activeEntity}</code>
                {' • '}
                <span>{includedMutations.length} of {activeMutations.length} row(s) selected</span>
              </div>
              {Array.isArray(previewData.source_documents) && previewData.source_documents.length > 0 && (
                <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                  {previewData.source_documents.map((doc) => (
                    <span
                      key={doc.doc_id}
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: '4px',
                        padding: '2px 8px',
                        borderRadius: '999px',
                        fontSize: '11px',
                        fontWeight: 600,
                        backgroundColor: 'var(--bg-subtle-warm)',
                        border: '1px solid var(--border-warm)',
                        color: 'var(--text-primary)',
                      }}
                    >
                      <FileText size={11} />
                      {doc.filename}
                    </span>
                  ))}
                </div>
              )}
            </div>

            {allMissingColumns.length > 0 && (
              <div
                role="alert"
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '8px',
                  padding: '10px 12px',
                  borderRadius: '8px',
                  backgroundColor: 'var(--status-warning-bg)',
                  border: '1px solid #f59e0b',
                  fontSize: '12px',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontWeight: 700, color: 'var(--status-warning)' }}>
                  <AlertTriangle size={15} />
                  <span>
                    Missing Information from Document: {allMissingColumns.join(', ')}
                  </span>
                </div>
                <div style={{ color: 'var(--text-primary)', lineHeight: 1.4 }}>
                  The document does not include values for the highlighted column(s) above. Enter
                  values per row below or quick-fill a column on the fly, or stop/cancel the table
                  update.
                </div>

                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center' }}>
                  {allMissingColumns.map((col) => {
                    const colSchema = colMetaByName.get(col);
                    const val = quickFillValues[col] ?? '';
                    return (
                      <div
                        key={col}
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: '5px',
                          backgroundColor: 'var(--bg-card)',
                          padding: '4px 6px',
                          borderRadius: '6px',
                          border: '1px solid var(--border-warm)',
                        }}
                      >
                        <span style={{ fontSize: '11px', fontWeight: 700 }}>{col}:</span>
                        <input
                          type={
                            colSchema?.type === 'integer' || colSchema?.type === 'number'
                              ? 'number'
                              : colSchema?.type === 'date'
                                ? 'date'
                                : 'text'
                          }
                          step={colSchema?.type === 'integer' ? '1' : colSchema?.type === 'number' ? 'any' : undefined}
                          placeholder="Value for all..."
                          value={val}
                          onChange={(e) =>
                            setQuickFillValues((prev) => ({ ...prev, [col]: e.target.value }))
                          }
                          style={{
                            width: '110px',
                            padding: '3px 6px',
                            fontSize: '11.5px',
                            borderRadius: '4px',
                            border: '1px solid var(--border-subtle)',
                            backgroundColor: 'var(--bg-panel)',
                            color: 'var(--text-primary)',
                          }}
                        />
                        <button
                          type="button"
                          className="btn-warm-outlined"
                          style={{ padding: '3px 8px', fontSize: '11px', fontWeight: 700 }}
                          disabled={!val.trim()}
                          onClick={() => onFillMissingColumn?.(col, val)}
                        >
                          Fill all
                        </button>
                      </div>
                    );
                  })}
                </div>

                {missingRequiredSet.size === 0 && missingNullableSet.size > 0 && (
                  <label
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: '6px',
                      fontSize: '11.5px',
                      color: 'var(--text-secondary)',
                      cursor: 'pointer',
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={Boolean(allowPartialNullable)}
                      onChange={(e) => onToggleAllowPartialNullable?.(e.target.checked)}
                    />
                    <span>Leave remaining empty nullable column(s) blank / table default</span>
                  </label>
                )}
              </div>
            )}

            {/* Datalists for low-cardinality categorical column autocomplete */}
            {syncColumns
              .filter((c) => Array.isArray(c.representative_values) && c.representative_values.length > 0)
              .map((c) => (
                <datalist
                  key={c.name}
                  id={`sync-col-hints-${previewData.workflow_id}-${c.name}`}
                >
                  {c.representative_values!.map((v) => (
                    <option key={v} value={v} />
                  ))}
                </datalist>
              ))}

            <div
              style={{
                overflowX: 'auto',
                maxHeight: '340px',
                borderRadius: '8px',
                border: '1px solid var(--border-warm)',
                backgroundColor: 'var(--bg-panel)',
              }}
            >
              <table
                style={{
                  width: '100%',
                  borderCollapse: 'collapse',
                  fontSize: '11.5px',
                  textAlign: 'left',
                }}
              >
                <thead>
                  <tr
                    style={{
                      backgroundColor: 'var(--bg-subtle-warm)',
                      borderBottom: '1px solid var(--border-warm)',
                      position: 'sticky',
                      top: 0,
                      zIndex: 1,
                    }}
                  >
                    <th style={{ padding: '7px 8px', whiteSpace: 'nowrap' }}>Apply</th>
                    <th style={{ padding: '7px 8px', whiteSpace: 'nowrap' }}>Action</th>
                    {orderedColNames.map((col) => {
                      const isMissing = allMissingColumns.includes(col);
                      return (
                        <th
                          key={col}
                          style={{
                            padding: '7px 8px',
                            whiteSpace: 'nowrap',
                            color: isMissing ? 'var(--status-warning)' : 'var(--text-secondary)',
                          }}
                        >
                          {col}
                          {colMetaByName.get(col)?.required ? ' *' : ''}
                        </th>
                      );
                    })}
                  </tr>
                </thead>
                <tbody>
                  {activeMutations.map((mut, idx) => {
                    const rowIdx = mut.row_index ?? idx;
                    const op = mut.operation || 'create';
                    const isIncluded = mut.include !== false;
                    const rowMissingSet = new Set(mut.missing_fields || []);
                    const badgeStyle =
                      op === 'delete'
                        ? { bg: 'var(--status-error-bg)', color: '#dc2626', label: '- DELETE' }
                        : op === 'update'
                          ? { bg: 'var(--accent-lavender-bg)', color: 'var(--primary-indigo-text)', label: '~ UPDATE' }
                          : { bg: 'var(--status-success-bg)', color: '#16a34a', label: '+ ADD' };

                    return (
                      <tr
                        key={`${mut.row_identifier || idx}-${rowIdx}`}
                        style={{
                          borderBottom: '1px solid var(--border-subtle)',
                          opacity: isIncluded ? 1 : 0.52,
                          backgroundColor:
                            op === 'delete' && isIncluded
                              ? 'rgba(220, 38, 38, 0.04)'
                              : 'transparent',
                        }}
                      >
                        <td style={{ padding: '6px 8px', verticalAlign: 'top' }}>
                          <input
                            type="checkbox"
                            aria-label={`Include row ${mut.row_identifier || rowIdx + 1}`}
                            checked={isIncluded}
                            onChange={(e) => onToggleMutationRow?.(rowIdx, e.target.checked)}
                          />
                        </td>
                        <td style={{ padding: '6px 8px', whiteSpace: 'nowrap', verticalAlign: 'top' }}>
                          <span
                            style={{
                              display: 'inline-block',
                              padding: '2px 7px',
                              borderRadius: '999px',
                              fontSize: '10px',
                              fontWeight: 800,
                              backgroundColor: badgeStyle.bg,
                              color: badgeStyle.color,
                            }}
                          >
                            {badgeStyle.label}
                          </span>
                          {(mut.duplicate_warning || mut.unmatched_warning) && (
                            <div
                              style={{
                                marginTop: '3px',
                                fontSize: '10px',
                                color: '#d97706',
                                maxWidth: '140px',
                                whiteSpace: 'normal',
                                lineHeight: 1.25,
                              }}
                            >
                              {mut.duplicate_warning || mut.unmatched_warning}
                            </div>
                          )}
                        </td>
                        {orderedColNames.map((col) => {
                          if (op === 'delete') {
                            const val = mut.before?.[col];
                            return (
                              <td
                                key={col}
                                style={{ padding: '6px 8px', color: '#dc2626', textDecoration: 'line-through' }}
                              >
                                {val === null || val === undefined || val === '' ? '—' : String(val)}
                              </td>
                            );
                          }
                          if (op === 'update') {
                            const isTargeted =
                              mut.after && Object.prototype.hasOwnProperty.call(mut.after, col);
                            if (!isTargeted) {
                              const unchanged = mut.before?.[col];
                              return (
                                <td key={col} style={{ padding: '6px 8px', color: 'var(--text-muted)' }}>
                                  {unchanged === null || unchanged === undefined || unchanged === ''
                                    ? '—'
                                    : String(unchanged)}
                                </td>
                              );
                            }
                            return (
                              <td key={col} style={{ padding: '6px 8px', verticalAlign: 'top' }}>
                                {mut.before?.[col] !== undefined && (
                                  <div style={{ fontSize: '10px', color: '#dc2626', textDecoration: 'line-through', marginBottom: '2px' }}>
                                    {String(mut.before[col] ?? '—')}
                                  </div>
                                )}
                                {renderSyncCellInput(
                                  rowIdx,
                                  col,
                                  mut.after?.[col],
                                  isIncluded && rowMissingSet.has(col)
                                )}
                              </td>
                            );
                          }
                          // op === 'create'
                          return (
                            <td key={col} style={{ padding: '6px 8px', verticalAlign: 'top' }}>
                              {renderSyncCellInput(
                                rowIdx,
                                col,
                                mut.after?.[col],
                                isIncluded && rowMissingSet.has(col)
                              )}
                            </td>
                          );
                        })}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {previewTab === 'mutations' && !isDocumentSync && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            <div style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
              Proposed modifications for {previewData.mutations_preview?.length || 0} row(s) in{' '}
              <code>{previewData.mutations_preview?.[0]?.table_name || activeEntity}</code>. Affected
              rows are highlighted live in the data table below.
            </div>

            <div
              style={{
                maxHeight: '260px',
                overflowY: 'auto',
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(290px, 1fr))',
                gap: '8px',
                paddingRight: '2px',
              }}
            >
              {(previewData.mutations_preview || []).map((mut, idx) => (
                <div
                  key={`${mut.row_identifier}-${idx}`}
                  style={{
                    padding: '10px 12px',
                    borderRadius: '8px',
                    backgroundColor: 'var(--bg-panel)',
                    border: '1px solid var(--border-warm)',
                    fontSize: '12px',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '6px',
                  }}
                >
                  <div style={{ fontWeight: 700, color: 'var(--primary-indigo-text)' }}>
                    Row Identifier: {mut.row_identifier}
                  </div>

                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                    {Object.keys(mut.after || {}).map((col) => (
                      <div
                        key={col}
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: '4px',
                          backgroundColor: 'var(--bg-card)',
                          padding: '3px 7px',
                          borderRadius: '5px',
                          border: '1px solid var(--border-subtle)',
                          flexWrap: 'wrap',
                        }}
                      >
                        <span style={{ fontWeight: 600, color: 'var(--text-secondary)' }}>{col}:</span>
                        <del
                          style={{
                            color: '#dc2626',
                            backgroundColor: 'var(--status-error-bg)',
                            padding: '1px 5px',
                            borderRadius: '4px',
                          }}
                        >
                          {String(mut.before?.[col] ?? '—')}
                        </del>
                        <ArrowRight size={11} color="var(--text-muted)" />
                        <strong
                          style={{
                            color: '#16a34a',
                            backgroundColor: 'var(--status-success-bg)',
                            padding: '1px 5px',
                            borderRadius: '4px',
                          }}
                        >
                          {String(mut.after?.[col])}
                        </strong>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {!isDocumentSync && previewTab === 'emails' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: '8px',
                flexWrap: 'wrap',
              }}
            >
              <div style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
                {activeEmails.length} customer notification email(s) queued for individual
                dispatch. Select a recipient below to review or edit before confirming.
              </div>

              {hasCustomEdits && onRestoreOriginalEmails && (
                <button
                  type="button"
                  onClick={handleRestoreDrafts}
                  style={{
                    fontSize: '11.5px',
                    fontWeight: 600,
                    color: 'var(--primary-indigo)',
                    backgroundColor: 'var(--bg-card)',
                    border: '1px solid var(--border-warm)',
                    borderRadius: '6px',
                    padding: '4px 9px',
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '4px',
                    cursor: 'pointer',
                  }}
                >
                  <RotateCcw size={12} />
                  <span>Restore Original</span>
                </button>
              )}
            </div>

            {activeEmails.length === 0 ? (
              <div
                style={{
                  padding: '12px',
                  borderRadius: '8px',
                  backgroundColor: 'var(--bg-panel)',
                  border: '1px solid var(--border-warm)',
                  fontSize: '12px',
                  color: 'var(--text-secondary)',
                }}
              >
                No emails are queued for this operation.
              </div>
            ) : (
              <div
                style={{
                  borderRadius: '10px',
                  border: '1px solid var(--border-warm)',
                  backgroundColor: 'var(--bg-subtle-warm)',
                  padding: '12px',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '10px',
                }}
              >
                {/* Recipient Switcher Pills */}
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px',
                    flexWrap: 'wrap',
                  }}
                >
                  {activeEmails.map((email, idx) => {
                    const isSelected = selectedEmailTab === idx;
                    return (
                      <button
                        key={`${email.recipient_email}-${idx}`}
                        type="button"
                        onClick={() => setSelectedEmailTab(idx)}
                        title={`${email.customer_identifier} (${email.recipient_email})`}
                        style={{
                          fontSize: '11.5px',
                          fontWeight: isSelected ? 700 : 500,
                          padding: '4px 10px',
                          borderRadius: '999px',
                          border: `1px solid ${
                            isSelected ? 'var(--primary-indigo)' : 'var(--border-warm)'
                          }`,
                          backgroundColor: isSelected
                            ? 'var(--primary-indigo)'
                            : 'var(--bg-subtle-warm)',
                          color: isSelected ? '#ffffff' : 'var(--text-primary)',
                          cursor: 'pointer',
                          maxWidth: '240px',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {email.customer_identifier || email.recipient_email}
                      </button>
                    );
                  })}

                  {activeEmails.length > 1 && onApplyTemplateToAllEmails && (
                    <button
                      type="button"
                      onClick={() => setSelectedEmailTab('all')}
                      style={{
                        fontSize: '11.5px',
                        fontWeight: selectedEmailTab === 'all' ? 700 : 600,
                        padding: '4px 10px',
                        borderRadius: '999px',
                        border: `1px solid ${
                          selectedEmailTab === 'all'
                            ? 'var(--primary-indigo)'
                            : 'var(--accent-lavender-border)'
                        }`,
                        backgroundColor:
                          selectedEmailTab === 'all'
                            ? 'var(--primary-indigo)'
                            : 'var(--accent-lavender-bg)',
                        color:
                          selectedEmailTab === 'all'
                            ? '#ffffff'
                            : 'var(--primary-indigo-text)',
                        cursor: 'pointer',
                      }}
                    >
                      All ({activeEmails.length}) Template
                    </button>
                  )}
                </div>

                {/* Single Clean Email Editor Card */}
                {selectedEmailTab === 'all' && activeEmails.length > 1 ? (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                    <div
                      style={{
                        fontSize: '11.5px',
                        color: 'var(--primary-indigo-text)',
                        backgroundColor: 'var(--accent-lavender-bg)',
                        border: '1px solid var(--accent-lavender-border)',
                        padding: '6px 10px',
                        borderRadius: '6px',
                      }}
                    >
                      Editing all {activeEmails.length} drafts together. Use{' '}
                      <code>{'{{customer_name}}'}</code> to personalize each greeting.
                    </div>

                    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                      <label
                        style={{
                          fontSize: '11px',
                          fontWeight: 700,
                          color: 'var(--text-secondary)',
                        }}
                      >
                        Subject (All Recipients)
                      </label>
                      <input
                        type="text"
                        aria-label="Master email subject"
                        placeholder="Email Subject"
                        value={templateSubject}
                        onChange={(e) => {
                          const nextSubject = e.target.value;
                          setTemplateSubject(nextSubject);
                          onApplyTemplateToAllEmails?.({
                            subject: nextSubject,
                            body: templateBody,
                          });
                        }}
                        style={{
                          width: '100%',
                          padding: '7px 10px',
                          fontSize: '12.5px',
                          fontWeight: 600,
                          borderRadius: '6px',
                          border: '1px solid var(--border-warm)',
                          backgroundColor: 'var(--bg-card)',
                          color: 'var(--text-primary)',
                        }}
                      />
                    </div>

                    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                      <label
                        style={{
                          fontSize: '11px',
                          fontWeight: 700,
                          color: 'var(--text-secondary)',
                        }}
                      >
                        Message Body (All Recipients)
                      </label>
                      <textarea
                        rows={6}
                        aria-label="Master email body"
                        placeholder="Email body..."
                        value={templateBody}
                        onChange={(e) => {
                          const nextBody = e.target.value;
                          setTemplateBody(nextBody);
                          onApplyTemplateToAllEmails?.({
                            subject: templateSubject,
                            body: nextBody,
                          });
                        }}
                        style={{
                          width: '100%',
                          padding: '9px 10px',
                          fontSize: '12.5px',
                          lineHeight: 1.5,
                          borderRadius: '6px',
                          border: '1px solid var(--border-warm)',
                          backgroundColor: 'var(--bg-card)',
                          color: 'var(--text-primary)',
                          resize: 'vertical',
                          fontFamily: 'inherit',
                        }}
                      />
                    </div>
                  </div>
                ) : (
                  currentEmail && (
                    <div
                      style={{
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '8px',
                        padding: '10px 12px',
                        borderRadius: '8px',
                        backgroundColor: 'var(--bg-card)',
                        border: '1px solid var(--border-subtle)',
                      }}
                    >
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: '6px',
                          flexWrap: 'wrap',
                          fontSize: '12px',
                          color: 'var(--text-primary)',
                          paddingBottom: '6px',
                          borderBottom: '1px solid var(--border-subtle)',
                        }}
                      >
                        <Mail size={14} color="var(--primary-indigo)" />
                        <span style={{ fontWeight: 700 }}>
                          {currentEmail.customer_identifier}
                        </span>
                        <span style={{ color: 'var(--text-secondary)' }}>
                          &lt;{currentEmail.recipient_email}&gt;
                        </span>
                      </div>

                      {currentEmail.metadata?.applied_rule && (
                        <div
                          style={{
                            fontSize: '11.5px',
                            padding: '5px 9px',
                            borderRadius: '5px',
                            backgroundColor: 'var(--status-warning-bg)',
                            color: 'var(--status-warning)',
                            border: '1px solid rgba(251, 191, 36, 0.38)',
                          }}
                        >
                          <strong>Rule Applied:</strong> {currentEmail.metadata.applied_rule}
                        </div>
                      )}

                      <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                        <label
                          style={{
                            fontSize: '11px',
                            fontWeight: 700,
                            color: 'var(--text-secondary)',
                          }}
                        >
                          Subject
                        </label>
                        {onUpdateEmailDraft ? (
                          <input
                            type="text"
                            aria-label="Email subject"
                            value={currentEmail.subject}
                            onChange={(e) =>
                              onUpdateEmailDraft(activeEmailIndex, {
                                subject: e.target.value,
                              })
                            }
                            style={{
                              width: '100%',
                              padding: '7px 10px',
                              fontSize: '12.5px',
                              fontWeight: 600,
                              borderRadius: '6px',
                              border: '1px solid var(--border-warm)',
                              backgroundColor: 'var(--bg-card)',
                              color: 'var(--text-primary)',
                            }}
                          />
                        ) : (
                          <div style={{ fontSize: '12.5px', fontWeight: 600 }}>
                            {currentEmail.subject}
                          </div>
                        )}
                      </div>

                      <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                        <label
                          style={{
                            fontSize: '11px',
                            fontWeight: 700,
                            color: 'var(--text-secondary)',
                          }}
                        >
                          Message Body
                        </label>
                        {onUpdateEmailDraft ? (
                          <textarea
                            rows={6}
                            aria-label="Email message body"
                            value={currentEmail.body}
                            onChange={(e) =>
                              onUpdateEmailDraft(activeEmailIndex, {
                                body: e.target.value,
                              })
                            }
                            style={{
                              width: '100%',
                              padding: '9px 10px',
                              fontSize: '12.5px',
                              lineHeight: 1.5,
                              borderRadius: '6px',
                              border: '1px solid var(--border-warm)',
                              backgroundColor: 'var(--bg-card)',
                              color: 'var(--text-primary)',
                              resize: 'vertical',
                              fontFamily: 'inherit',
                            }}
                          />
                        ) : (
                          <div
                            style={{
                              whiteSpace: 'pre-wrap',
                              fontSize: '12.5px',
                              lineHeight: 1.5,
                              backgroundColor: 'var(--bg-subtle-warm)',
                              padding: '10px',
                              borderRadius: '6px',
                              border: '1px solid var(--border-light)',
                              color: 'var(--text-primary)',
                            }}
                          >
                            {currentEmail.body}
                          </div>
                        )}
                      </div>
                    </div>
                  )
                )}
              </div>
            )}
          </div>
        )}

        <CitationBadges
          citations={previewData.citations}
          onSelectCitation={onSelectCitation}
        />

        <div style={{ display: 'flex', gap: '8px', marginTop: '4px', flexWrap: 'wrap' }}>
          <button
            type="button"
            className="btn-primary-indigo"
            style={{ flex: 1, minWidth: '220px', padding: '10px 16px', fontSize: '12.5px' }}
            disabled={
              isBusy ||
              (isDocumentSync
                ? includedMutations.length === 0 || hasUnresolvedMissing
                : hasBlankDraft)
            }
            onClick={onConfirmOperation}
          >
            {isDocumentSync
              ? `Confirm & Apply to Active Table (${includedMutations.length} row${includedMutations.length === 1 ? '' : 's'})`
              : !hasMutations && activeEmails.length > 0
                ? `Confirm & Send (${activeEmails.length} Email${activeEmails.length === 1 ? '' : 's'})`
                : 'Approve All & Execute (Stage 2 Confirm)'}
          </button>

          {!isDocumentSync && clarificationData && (
            <button
              type="button"
              className="btn-warm-outlined"
              style={{ padding: '8px 14px', fontSize: '12px' }}
              onClick={onBackToClarification}
            >
              Adjust Resolution
            </button>
          )}

          <button
            type="button"
            className="btn-warm-outlined"
            style={{ padding: '8px 14px', fontSize: '12px' }}
            disabled={isBusy}
            onClick={isDocumentSync && onCancelOperation ? onCancelOperation : onResetWorkflow}
          >
            {isDocumentSync ? 'Stop / Cancel Update' : 'Cancel'}
          </button>
        </div>
      </motion.section>
    );
  }

  if (workflowStatus === 'executed' && executedData) {
    const isDocSyncExecuted =
      executedData.created_rows_count !== undefined ||
      executedData.deleted_rows_count !== undefined ||
      executedData.modified_rows_count !== undefined;

    return (
      <motion.section
        aria-label="Execution receipt"
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        className="execution-receipt-card b2b-stage-panel"
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: '12px',
          padding: '16px 18px',
          backgroundColor: 'var(--status-success-bg)',
          borderRadius: '10px',
          border: '2px solid #16a34a',
          boxShadow: '0 4px 14px rgba(22, 163, 74, 0.12)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '8px' }}>
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '6px',
              padding: '3px 10px',
              borderRadius: '999px',
              fontSize: '11.5px',
              fontWeight: 800,
              backgroundColor: 'var(--status-success-bg)',
              color: 'var(--status-success)',
              border: '1px solid rgba(52, 211, 153, 0.45)',
            }}
          >
            <CheckCircle2 size={14} />
            EXECUTION CONFIRMED &amp; ATOMICALLY COMMITTED
          </span>

          <button
            type="button"
            className="btn-warm-outlined"
            style={{ padding: '3px 10px', fontSize: '11.5px' }}
            onClick={onResetWorkflow}
          >
            Dismiss
          </button>
        </div>

        {isDocSyncExecuted ? (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
              gap: '10px',
            }}
          >
            {[
              { label: 'Rows Added', value: executedData.created_rows_count ?? 0, color: '#16a34a' },
              { label: 'Rows Updated', value: executedData.modified_rows_count ?? 0, color: 'var(--primary-indigo)' },
              { label: 'Rows Deleted', value: executedData.deleted_rows_count ?? 0, color: '#dc2626' },
            ].map((tile) => (
              <div
                key={tile.label}
                style={{
                  padding: '10px',
                  backgroundColor: 'var(--bg-card)',
                  borderRadius: '8px',
                  border: '1px solid rgba(52, 211, 153, 0.35)',
                  textAlign: 'center',
                }}
              >
                <div style={{ fontSize: '20px', fontWeight: 800, color: tile.color }}>
                  {tile.value}
                </div>
                <div style={{ fontSize: '11.5px', color: 'var(--text-secondary)', fontWeight: 600 }}>
                  {tile.label}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
              gap: '10px',
            }}
          >
            <div
              style={{
                padding: '10px',
                backgroundColor: 'var(--bg-card)',
                borderRadius: '8px',
                border: '1px solid rgba(52, 211, 153, 0.35)',
                textAlign: 'center',
              }}
            >
              <div style={{ fontSize: '20px', fontWeight: 800, color: '#16a34a' }}>
                {executedData.updated_rows_count}
              </div>
              <div style={{ fontSize: '11.5px', color: 'var(--text-secondary)', fontWeight: 600 }}>
                DB Rows Updated
              </div>
            </div>

            <div
              style={{
                padding: '10px',
                backgroundColor: 'var(--bg-card)',
                borderRadius: '8px',
                border: '1px solid rgba(52, 211, 153, 0.35)',
                textAlign: 'center',
              }}
            >
              <div style={{ fontSize: '20px', fontWeight: 800, color: '#16a34a' }}>
                {executedData.dispatched_emails_count}
              </div>
              <div style={{ fontSize: '11.5px', color: 'var(--text-secondary)', fontWeight: 600 }}>
                Customer Emails Sent
              </div>
            </div>
          </div>
        )}

        <div style={{ fontSize: '12.5px', color: 'var(--status-success)', lineHeight: 1.45 }}>
          {isDocSyncExecuted
            ? `All approved changes to "${executedData.target_entity || activeEntity}" have been atomically committed to PostgreSQL. The live spreadsheet data table has been automatically refreshed.`
            : 'All row mutations have been committed to PostgreSQL and customer email notifications have been dispatched. The live spreadsheet data table has been automatically refreshed.'}
        </div>

        <CitationBadges
          citations={executedData.citations}
          onSelectCitation={onSelectCitation}
        />
      </motion.section>
    );
  }

  return null;
}
