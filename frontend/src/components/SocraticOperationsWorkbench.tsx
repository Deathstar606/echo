import React, { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Sparkles,
  AlertTriangle,
  CheckCircle2,
  AlertCircle,
  Loader2,
  ArrowRight,
  RotateCcw,
  Mail,
  Table2,
  ShieldAlert,
  Send,
  HelpCircle,
  Check,
  ChevronDown,
  ChevronUp,
  Inbox,
  FileText,
} from 'lucide-react';
import type {
  Citation,
  WorkspaceOperationResponse,
  ClarificationRequiredPayload,
  PreviewReadyPayload,
  ExecutedPayload,
  ConversationalPayload,
  WorkspaceMutationDiff,
  WorkspaceEmailPreview,
  SocraticQuestion,
  SocraticOption,
  RoutedSheetInstruction,
} from '../../../shared/types/contracts';
import CitationBadges from './CitationBadges';
import {
  executeWorkspaceOperationApi,
  resolveWorkspaceSocraticApi,
  confirmWorkspaceOperationApi,
} from '../services/api';

interface SocraticOperationsWorkbenchProps {
  activeBusinessId?: string;
  activeEntity: string;
  activeDisplayName: string;
  onRefreshTable: () => void;
  onMutationsPreviewChange?: (mutations: WorkspaceMutationDiff[]) => void;
  onSelectCitation?: (citation: Citation) => void;
  isBusy: boolean;
  nlPrompt: string;
  onPromptChange: (prompt: string) => void;
  samplePrompts: Array<{ label: string; text: string }>;
  onRunSheetInstruction: (
    intent: RoutedSheetInstruction['intent'],
    entity: string,
    prompt: string
  ) => Promise<string>;
  onApplySheetQueryResult?: (payload: RoutedSheetInstruction) => void;
}

export default function SocraticOperationsWorkbench({
  activeBusinessId,
  activeEntity,
  activeDisplayName,
  onRefreshTable,
  onMutationsPreviewChange,
  onSelectCitation,
  isBusy,
  nlPrompt,
  onPromptChange,
  samplePrompts,
  onRunSheetInstruction,
  onApplySheetQueryResult,
}: SocraticOperationsWorkbenchProps): React.ReactElement {
  // Workflow state machine: 'idle' | 'executing' | 'clarification' | 'preview' | 'executed' | 'conversational'
  const [workflowStatus, setWorkflowStatus] = useState<
    'idle' | 'executing' | 'clarification' | 'preview' | 'executed' | 'conversational'
  >('idle');
  const [executingStep, setExecutingStep] = useState<string>('');
  const [workflowError, setWorkflowError] = useState<string | null>(null);

  // Workflow payloads
  const [currentWorkflowId, setCurrentWorkflowId] = useState<string | null>(null);
  const [clarificationData, setClarificationData] =
    useState<ClarificationRequiredPayload | null>(null);
  const [selectedOptionsMap, setSelectedOptionsMap] = useState<Record<string, string>>({});
  const [previewData, setPreviewData] = useState<PreviewReadyPayload | null>(null);
  const [executedData, setExecutedData] = useState<ExecutedPayload | null>(null);
  const [conversationalData, setConversationalData] =
    useState<ConversationalPayload | null>(null);
  const [conversationHistory, setConversationHistory] = useState<
    Array<{ role: 'user' | 'assistant'; content: string }>
  >([]);

  // Preview sub-tab ('mutations' | 'emails')
  const [previewTab, setPreviewTab] = useState<'mutations' | 'emails'>('mutations');
  const [expandedEmailIndex, setExpandedEmailIndex] = useState<number | null>(0);

  // Reset workflow state whenever workspace changes so previous workspace's workflow never leaks
  useEffect(() => {
    setWorkflowStatus('idle');
    setCurrentWorkflowId(null);
    setClarificationData(null);
    setSelectedOptionsMap({});
    setPreviewData(null);
    setExecutedData(null);
    setConversationalData(null);
    setWorkflowError(null);
    setConversationHistory([]);
    onMutationsPreviewChange?.([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeBusinessId]);

  // Turn 1: Run AI Instruction
  const handleExecuteOperation = async (customPrompt?: string) => {
    const promptToRun = (
      typeof customPrompt === 'string' ? customPrompt : nlPrompt
    ).trim();
    if (!promptToRun || isBusy || workflowStatus === 'executing') return;

    setWorkflowError(null);
    setWorkflowStatus('executing');
    setExecutingStep('Discovering sources & evaluating multi-hop policy constraints...');

    try {
      const res = await executeWorkspaceOperationApi({
        prompt: promptToRun,
        entity: 'user',
        table_name: activeEntity,
        history: conversationHistory,
        businessId: activeBusinessId,
      });

      let routedMessage = '';
      if (res.status === 'SHEET_QUERY' && Array.isArray(res.rows)) {
        onApplySheetQueryResult?.(res);
        routedMessage = res.answer || res.message;
        setConversationalData({
          status: 'CONVERSATIONAL',
          conversational: true,
          intent: res.intent,
          message: routedMessage,
          answer: routedMessage,
          rows: res.rows.map((row) => ({ table_name: res.entity, ...row })),
          highlighted_rows: res.highlighted_rows,
          citations: res.citations || [],
        });
        setWorkflowStatus('conversational');
        onMutationsPreviewChange?.([]);
      } else if (res.status === 'SHEET_QUERY' || res.status === 'SHEET_MUTATION') {
        routedMessage = await onRunSheetInstruction(
          res.intent,
          res.entity,
          promptToRun
        );
        setConversationalData({
          status: 'CONVERSATIONAL',
          conversational: true,
          intent: res.intent,
          message: routedMessage || res.message,
          citations: res.citations || [],
        });
        setWorkflowStatus('conversational');
        onMutationsPreviewChange?.([]);
      } else if (res.status === 'CONVERSATIONAL') {
        setConversationalData(res);
        setWorkflowStatus('conversational');
        onMutationsPreviewChange?.([]);
      } else if (res.status === 'CLARIFICATION_REQUIRED') {
        setCurrentWorkflowId(res.workflow_id);
        setClarificationData(res);
        // Pre-select first option for each question
        const initialOptions: Record<string, string> = {};
        for (const q of res.socratic_questions) {
          if (q.options && q.options.length > 0) {
            initialOptions[q.question_id] = q.options[0].option_id;
          }
        }
        setSelectedOptionsMap(initialOptions);
        setWorkflowStatus('clarification');
        onMutationsPreviewChange?.([]);
      } else if (res.status === 'PREVIEW_READY') {
        setCurrentWorkflowId(res.workflow_id);
        setPreviewData(res);
        setWorkflowStatus('preview');
        onMutationsPreviewChange?.(res.mutations_preview || []);
      }

      const assistantMessage =
        res.status === 'CONVERSATIONAL'
          ? res.message
          : res.status === 'SHEET_QUERY' || res.status === 'SHEET_MUTATION'
            ? routedMessage || res.message
            : res.status === 'CLARIFICATION_REQUIRED'
              ? [
                  res.conflict_summary,
                  ...res.socratic_questions.flatMap((question) => [
                    question.question_text,
                    ...question.options.map((option) => option.label),
                  ]),
                ].join('\n')
              : 'Prepared a preview of the requested actions.';
      setConversationHistory((previous) => [
        ...previous,
        { role: 'user', content: promptToRun },
        { role: 'assistant', content: assistantMessage },
      ]);
    } catch (err: any) {
      setWorkflowError(err?.message || 'Failed to execute cross-document instruction.');
      setWorkflowStatus('idle');
    }
  };

  // Turn 2: Resolve Socratic Conflict
  const handleResolveSocratic = async () => {
    if (!currentWorkflowId || !clarificationData) return;

    setWorkflowError(null);
    setWorkflowStatus('executing');
    setExecutingStep('Applying selected Socratic resolution & compiling action preview...');

    try {
      const res = await resolveWorkspaceSocraticApi({
        workflowId: currentWorkflowId,
        selectedOptions: selectedOptionsMap,
        businessId: activeBusinessId,
      });

      setPreviewData(res);
      setWorkflowStatus('preview');
      onMutationsPreviewChange?.(res.mutations_preview || []);
      const selectedLabels = clarificationData?.socratic_questions
        .flatMap((question) =>
          question.options
            .filter(
              (option) =>
                selectedOptionsMap[question.question_id] === option.option_id
            )
            .map((option) => option.label)
        )
        .join('; ');
      setConversationHistory((previous) => [
        ...previous,
        ...(selectedLabels
          ? [{ role: 'user' as const, content: `Selected: ${selectedLabels}` }]
          : []),
        {
          role: 'assistant',
          content: 'Prepared the action preview using the selected clarification.',
        },
      ]);
    } catch (err: any) {
      setWorkflowError(err?.message || 'Failed to resolve Socratic conflict.');
      setWorkflowStatus('clarification');
    }
  };

  // Turn 3: Confirm & Apply Operation (Stage 2 Confirm)
  const handleConfirmOperation = async () => {
    if (!currentWorkflowId || !previewData) return;

    setWorkflowError(null);
    setWorkflowStatus('executing');
    setExecutingStep('Atomically committing database row mutations & dispatching emails...');

    try {
      const res = await confirmWorkspaceOperationApi({
        workflowId: currentWorkflowId,
        confirm: true,
        dryRun: false,
        businessId: activeBusinessId,
      });

      setExecutedData(res);
      setWorkflowStatus('executed');
      onMutationsPreviewChange?.([]);
      setConversationHistory((previous) => [
        ...previous,
        {
          role: 'assistant',
          content: `Completed the approved operation: updated ${res.updated_rows_count} rows and queued ${res.dispatched_emails_count} emails.`,
        },
      ]);

      // Auto-refresh the live database table so updated rows display immediately
      onRefreshTable();
    } catch (err: any) {
      setWorkflowError(err?.message || 'Failed to confirm and execute operation.');
      setWorkflowStatus('preview');
    }
  };

  // Reset workflow back to idle
  const handleResetWorkflow = () => {
    setWorkflowStatus('idle');
    setCurrentWorkflowId(null);
    setClarificationData(null);
    setSelectedOptionsMap({});
    setPreviewData(null);
    setExecutedData(null);
    setConversationalData(null);
    setWorkflowError(null);
    setConversationHistory([]);
    onPromptChange('');
    onMutationsPreviewChange?.([]);
  };

  return (
    <div
      className="copilot-side-card socratic-operations-workbench"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: '12px',
      }}
    >
      {/* Copilot Header */}
      <div className="copilot-header">
        <div className="copilot-title">
          <Sparkles size={16} color="#d97706" />
          <span>B2B Autonomous Operations Copilot</span>
        </div>
        {(activeDisplayName || activeEntity) && (
          <span
            className="liquid-glass-pill"
            style={{
              fontSize: '10.5px',
              fontWeight: 700,
              color: 'var(--primary-indigo)',
              padding: '2px 8px',
              borderRadius: '999px',
            }}
          >
            {(activeDisplayName || activeEntity).toUpperCase()}
          </span>
        )}
      </div>

      {/* 4.1 Input & Generalized B2B Command Bar */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          handleExecuteOperation();
        }}
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: '8px',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <label
            className="copilot-field-label"
            htmlFor="socratic-nl-prompt-input"
            style={{ margin: 0 }}
          >
            Autonomous Operations Command Bar
          </label>
          <span
            style={{
              fontSize: '11px',
              fontWeight: 700,
              color: 'var(--primary-indigo)',
              backgroundColor: 'var(--accent-lavender-bg)',
              padding: '2px 8px',
              borderRadius: '999px',
            }}
          >
            CROSS-DOCUMENT RAG (#2) &amp; SOCRATIC (#3)
          </span>
        </div>

        <textarea
          id="socratic-nl-prompt-input"
          className="announcement-prompt-textarea"
          value={nlPrompt}
          onChange={(e) => onPromptChange(e.target.value)}
          disabled={workflowStatus === 'executing'}
          rows={3}
          placeholder='e.g. "Check which orders in our spreadsheet are affected by this shipment delay, update their status, and notify those customers per our SLA policy."'
        />

        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
          <button
            type="submit"
            className="btn-primary-indigo"
            style={{ flex: 1, padding: '10px 14px', fontSize: '13px' }}
            disabled={!nlPrompt.trim() || workflowStatus === 'executing'}
          >
            {workflowStatus === 'executing' ? (
              <>
                <Loader2 size={15} className="spin" />
                <span>Processing...</span>
              </>
            ) : (
              <>
                <Sparkles size={15} />
                <span>Run AI Instruction</span>
              </>
            )}
          </button>

          {workflowStatus !== 'idle' && (
            <button
              type="button"
              className="btn-warm-outlined"
              style={{ padding: '8px 12px', fontSize: '12px' }}
              onClick={handleResetWorkflow}
              title="Reset operations workbench"
            >
              <RotateCcw size={13} />
              Reset
            </button>
          )}
        </div>
      </form>

      {/* Loading Progression Indicator */}
      {workflowStatus === 'executing' && (
        <motion.div
          initial={{ opacity: 0, y: -4 }}
          animate={{ opacity: 1, y: 0 }}
          className="alert-banner"
          style={{
            backgroundColor: '#eff6ff',
            borderColor: '#bfdbfe',
            color: '#1e40af',
            fontSize: '12px',
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
          }}
        >
          <Loader2 size={15} className="spin" color="var(--primary-indigo)" />
          <span>{executingStep || 'Executing cross-document reasoning graph...'}</span>
        </motion.div>
      )}

      {/* Workflow Error Banner */}
      {workflowError && (
        <div className="alert-banner error" style={{ fontSize: '12px' }}>
          <AlertCircle size={15} style={{ flexShrink: 0 }} />
          <span>{workflowError}</span>
        </div>
      )}

      {/* Quick Sample Suggestions Chips */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
        <span style={{ fontSize: '11.5px', fontWeight: 600, color: 'var(--text-secondary)' }}>
          Quick Sample Suggestions:
        </span>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
          {samplePrompts.map((sample) => (
            <button
              key={sample.label}
              type="button"
              className="btn-warm-outlined"
              style={{
                fontSize: '11px',
                padding: '4px 8px',
                textAlign: 'left',
                borderColor: sample.label.includes('Cross-Reference') || sample.label.includes('SLA')
                  ? '#f59e0b'
                  : 'var(--border-warm)',
                backgroundColor: sample.label.includes('Cross-Reference') || sample.label.includes('SLA')
                  ? '#fffbeb'
                  : undefined,
              }}
              disabled={workflowStatus === 'executing'}
              onClick={() => {
                onPromptChange(sample.text);
                handleExecuteOperation(sample.text);
              }}
            >
              {sample.label.includes('Cross-Reference') || sample.label.includes('SLA')
                ? '⚡ '
                : '🔍 '}
              {sample.label}
            </button>
          ))}
        </div>
      </div>

      {/* Conversational Fallback Card */}
      {workflowStatus === 'conversational' && conversationalData && (
        <motion.div
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          className="ai-suggestion-box"
          style={{
            backgroundColor: '#f8fafc',
            borderColor: '#cbd5e1',
            padding: '12px 14px',
            fontSize: '12.5px',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontWeight: 700, color: '#334155' }}>
            <Sparkles size={14} color="var(--primary-indigo)" />
            <span>AI Assistant</span>
          </div>
          <div style={{ marginTop: '4px', lineHeight: 1.5 }}>
            {conversationalData.message}
          </div>
          {Array.isArray(conversationalData.rows) && conversationalData.rows.length > 0 ? (() => {
            const ignoredKeys = new Set([
              'id',
              'business_id',
              'workspace_id',
              'user_id',
              'workspace_document_id',
              '_google_row_index',
              'created_at',
              'updated_at',
              'images',
              'description',
              'table_name',
            ]);
            const previewCols = Object.keys(conversationalData.rows[0] || {})
              .filter((k) => !ignoredKeys.has(k.toLowerCase()))
              .slice(0, 6);
            return (
              <div
                style={{
                  marginTop: '10px',
                  border: '1px solid #cbd5e1',
                  borderRadius: '8px',
                  background: '#ffffff',
                  overflowX: 'auto',
                  maxHeight: '210px',
                }}
              >
                <div
                  style={{
                    padding: '6px 10px',
                    fontSize: '11px',
                    fontWeight: 700,
                    color: '#334155',
                    borderBottom: '1px solid #e2e8f0',
                    background: '#f1f5f9',
                  }}
                >
                  Matched Rows ({conversationalData.rows.length})
                </div>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '11.5px' }}>
                  <thead>
                    <tr>
                      {previewCols.map((col) => (
                        <th
                          key={col}
                          style={{
                            textAlign: 'left',
                            padding: '5px 8px',
                            borderBottom: '1px solid #e2e8f0',
                            color: '#475569',
                            fontWeight: 600,
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {col}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {conversationalData.rows.slice(0, 15).map((row, idx) => (
                      <tr key={idx} style={{ borderBottom: '1px solid #f1f5f9' }}>
                        {previewCols.map((col) => {
                          const raw = row[col];
                          const text =
                            raw === null || raw === undefined
                              ? '—'
                              : typeof raw === 'object'
                                ? JSON.stringify(raw)
                                : String(raw);
                          return (
                            <td key={col} style={{ padding: '5px 8px', color: '#0f172a', whiteSpace: 'nowrap' }}>
                              {text.length > 42 ? `${text.slice(0, 39)}...` : text}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          })() : null}
          {conversationalData.highlighted_rows?.length ? (
            <div style={{ marginTop: '10px', display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
              {conversationalData.highlighted_rows.slice(0, 20).map((row, index) => (
                <button
                  type="button"
                  key={`${row.table_name}:${row.row_identifier}:${index}`}
                  onClick={() => {
                    const citation = conversationalData.citations.find(
                      (item) =>
                        item.source_type === 'table' &&
                        item.source_name === row.table_name &&
                        item.locator.includes(String(row.row_identifier))
                    );
                    if (citation) onSelectCitation?.(citation);
                  }}
                  style={{
                    border: '1px solid #c7d2fe',
                    borderRadius: '999px',
                    padding: '4px 8px',
                    background: '#eef2ff',
                    color: '#3730a3',
                    cursor: 'pointer',
                    fontSize: '11px',
                  }}
                  title={`Open source row from ${row.table_name}`}
                >
                  {row.table_name}: {row.row_identifier}
                </button>
              ))}
            </div>
          ) : null}
          <CitationBadges
            citations={conversationalData.citations || []}
            onSelectCitation={onSelectCitation}
          />
        </motion.div>
      )}

      {conversationHistory.length > 0 && (
        <div
          aria-label="Current conversation"
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: '8px',
            maxHeight: '280px',
            overflowY: 'auto',
            padding: '10px',
            border: '1px solid var(--border-warm)',
            borderRadius: '10px',
            background: '#fff',
          }}
        >
          {conversationHistory.map((turn, index) => (
            <div
              key={`${index}-${turn.role}`}
              style={{
                alignSelf: turn.role === 'user' ? 'flex-end' : 'flex-start',
                maxWidth: '92%',
                padding: '8px 10px',
                borderRadius: '9px',
                background:
                  turn.role === 'user' ? 'var(--accent-lavender-bg)' : '#f8fafc',
                fontSize: '12px',
                lineHeight: 1.45,
                whiteSpace: 'pre-wrap',
              }}
            >
              <strong>{turn.role === 'user' ? 'You' : 'Assistant'}</strong>
              <div>{turn.content}</div>
            </div>
          ))}
        </div>
      )}

      {/* =========================================================================
          4.2 STATE 1: CLARIFICATION_REQUIRED (Interactive Socratic Gate Card)
          ========================================================================= */}
      {workflowStatus === 'clarification' && clarificationData && (
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          className="socratic-conflict-gate-card"
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: '12px',
            padding: '16px',
            backgroundColor: '#fffdfa',
            borderRadius: '10px',
            border: '2px solid #f59e0b',
            boxShadow: '0 4px 12px rgba(245, 158, 11, 0.1)',
          }}
        >
          {/* Header Badge */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              flexWrap: 'wrap',
              gap: '8px',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <span
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '5px',
                  padding: '3px 10px',
                  borderRadius: '999px',
                  fontSize: '11px',
                  fontWeight: 800,
                  backgroundColor: '#fef3c7',
                  color: '#92400e',
                  border: '1px solid #fcd34d',
                }}
              >
                <ShieldAlert size={13} />
                ACTION PAUSED • CLARIFICATION REQUIRED
              </span>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <span
                style={{
                  padding: '2px 8px',
                  borderRadius: '999px',
                  fontSize: '11px',
                  fontWeight: 700,
                  backgroundColor: '#fee2e2',
                  color: '#991b1b',
                  border: '1px solid #fecaca',
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
                  backgroundColor: '#eff6ff',
                  color: '#1e40af',
                  border: '1px solid #bfdbfe',
                }}
              >
                {clarificationData.affected_rows_count} Affected Row(s)
              </span>
            </div>
          </div>

          {/* Conflict Explanation Callout */}
          <div
            style={{
              padding: '10px 12px',
              backgroundColor: '#fffbeb',
              borderRadius: '8px',
              border: '1px solid #fde68a',
              fontSize: '12px',
              lineHeight: 1.5,
              color: '#92400e',
            }}
          >
            <strong>Conflict Summary:</strong> {clarificationData.conflict_summary}
          </div>

          {/* Interactive Question Selectors */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            {clarificationData.socratic_questions.map((q: SocraticQuestion) => (
              <div key={q.question_id} style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                <label
                  style={{
                    fontSize: '12px',
                    fontWeight: 700,
                    color: 'var(--text-primary)',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '5px',
                  }}
                >
                  <HelpCircle size={14} color="var(--primary-indigo)" />
                  {q.question_text}
                </label>

                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
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
                          backgroundColor: isSelected ? 'var(--accent-lavender-bg)' : '#ffffff',
                          cursor: 'pointer',
                          display: 'flex',
                          alignItems: 'flex-start',
                          gap: '10px',
                          transition: 'all 0.15s ease',
                        }}
                        onClick={() =>
                          setSelectedOptionsMap((prev) => ({
                            ...prev,
                            [q.question_id]: opt.option_id,
                          }))
                        }
                      >
                        <div
                          style={{
                            width: '18px',
                            height: '18px',
                            borderRadius: '50%',
                            border: `2px solid ${isSelected ? 'var(--primary-indigo)' : 'var(--border-warm-strong)'}`,
                            backgroundColor: isSelected ? 'var(--primary-indigo)' : '#ffffff',
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
                          <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-primary)' }}>
                            {opt.label}
                          </div>
                          <div style={{ fontSize: '11px', color: 'var(--text-secondary)', marginTop: '2px' }}>
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

          {/* Inline Citations */}
          <CitationBadges
            citations={clarificationData.citations}
            onSelectCitation={onSelectCitation}
          />

          {/* Socratic Submission Control */}
          <div style={{ display: 'flex', gap: '8px', marginTop: '4px' }}>
            <button
              type="button"
              className="btn-primary-indigo"
              style={{ flex: 1, padding: '10px 14px', fontSize: '12.5px' }}
              disabled={isBusy}
              onClick={handleResolveSocratic}
            >
              Resolve Conflict &amp; Generate Preview
            </button>

            <button
              type="button"
              className="btn-warm-outlined"
              style={{ padding: '8px 12px', fontSize: '12px' }}
              onClick={handleResetWorkflow}
            >
              Cancel
            </button>
          </div>
        </motion.div>
      )}

      {/* =========================================================================
          4.3 STATE 2: PREVIEW_READY (Stage 1 Unified Mutation + Email Preview)
          ========================================================================= */}
      {workflowStatus === 'preview' && previewData && (
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          className="stage1-preview-card"
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: '12px',
            padding: '16px',
            backgroundColor: '#ffffff',
            borderRadius: '10px',
            border: '2px solid var(--primary-indigo)',
            boxShadow: '0 4px 14px rgba(57, 70, 211, 0.12)',
          }}
        >
          {/* Header */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              flexWrap: 'wrap',
              gap: '8px',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
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
                  color: 'var(--primary-indigo-dark)',
                  border: '1px solid var(--accent-lavender-border)',
                }}
              >
                <Sparkles size={13} />
                STAGE 1 ACTION PREVIEW • READY
              </span>
            </div>

            {/* Sub-Tabs: Mutations vs Emails */}
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
                  padding: '4px 10px',
                  borderRadius: '6px',
                  fontSize: '11.5px',
                  fontWeight: previewTab === 'mutations' ? 700 : 500,
                  backgroundColor: previewTab === 'mutations' ? '#ffffff' : 'transparent',
                  color: previewTab === 'mutations' ? 'var(--primary-indigo)' : 'var(--text-secondary)',
                  boxShadow: previewTab === 'mutations' ? '0 1px 3px rgba(0,0,0,0.08)' : 'none',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '4px',
                }}
                onClick={() => setPreviewTab('mutations')}
              >
                <Table2 size={13} />
                <span>DB Rows ({previewData.mutations_preview?.length || 0})</span>
              </button>

              <button
                type="button"
                style={{
                  padding: '4px 10px',
                  borderRadius: '6px',
                  fontSize: '11.5px',
                  fontWeight: previewTab === 'emails' ? 700 : 500,
                  backgroundColor: previewTab === 'emails' ? '#ffffff' : 'transparent',
                  color: previewTab === 'emails' ? 'var(--primary-indigo)' : 'var(--text-secondary)',
                  boxShadow: previewTab === 'emails' ? '0 1px 3px rgba(0,0,0,0.08)' : 'none',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '4px',
                }}
                onClick={() => setPreviewTab('emails')}
              >
                <Mail size={13} />
                <span>Emails ({previewData.emails_preview?.length || 0})</span>
              </button>
            </div>
          </div>

          {/* Sub-Tab 1: Database Row Mutations Diff Table */}
          {previewTab === 'mutations' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <div style={{ fontSize: '11.5px', color: 'var(--text-secondary)' }}>
                Proposed modifications for {previewData.mutations_preview?.length || 0} row(s) in{' '}
                <code>{previewData.mutations_preview?.[0]?.table_name || activeEntity}</code>. Affected rows are highlighted live in the data table.
              </div>

              <div
                style={{
                  maxHeight: '220px',
                  overflowY: 'auto',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '6px',
                  paddingRight: '2px',
                }}
              >
                {(previewData.mutations_preview || []).map((mut, idx) => (
                  <div
                    key={`${mut.row_identifier}-${idx}`}
                    style={{
                      padding: '8px 10px',
                      borderRadius: '6px',
                      backgroundColor: 'var(--bg-panel)',
                      border: '1px solid var(--border-warm)',
                      fontSize: '12px',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '4px',
                    }}
                  >
                    <div style={{ fontWeight: 700, color: 'var(--primary-indigo-dark)' }}>
                      Row Identifier: {mut.row_identifier}
                    </div>

                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
                      {Object.keys(mut.after || {}).map((col) => (
                        <div
                          key={col}
                          style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: '4px',
                            backgroundColor: '#ffffff',
                            padding: '2px 6px',
                            borderRadius: '4px',
                            border: '1px solid var(--border-subtle)',
                          }}
                        >
                          <span style={{ fontWeight: 600, color: 'var(--text-secondary)' }}>{col}:</span>
                          <del
                            style={{
                              color: '#dc2626',
                              backgroundColor: '#fee2e2',
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
                              backgroundColor: '#dcfce7',
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

          {/* Sub-Tab 2: Queued Customer Notifications Preview */}
          {previewTab === 'emails' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <div style={{ fontSize: '11.5px', color: 'var(--text-secondary)' }}>
                {previewData.emails_preview?.length || 0} customer notification email(s) queued for individual dispatch.
              </div>

              <div
                style={{
                  maxHeight: '220px',
                  overflowY: 'auto',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '6px',
                  paddingRight: '2px',
                }}
              >
                {(previewData.emails_preview || []).map((email, idx) => {
                  const isExpanded = expandedEmailIndex === idx;
                  return (
                    <div
                      key={`${email.recipient_email}-${idx}`}
                      style={{
                        borderRadius: '6px',
                        backgroundColor: '#ffffff',
                        border: '1px solid var(--border-warm)',
                        overflow: 'hidden',
                        fontSize: '12px',
                      }}
                    >
                      <button
                        type="button"
                        style={{
                          width: '100%',
                          textAlign: 'left',
                          padding: '8px 10px',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          backgroundColor: isExpanded ? 'var(--bg-subtle-warm)' : '#ffffff',
                          cursor: 'pointer',
                        }}
                        onClick={() => setExpandedEmailIndex(isExpanded ? null : idx)}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                          <Mail size={13} color="var(--primary-indigo)" />
                          <span style={{ fontWeight: 700 }}>{email.customer_identifier}</span>
                          <span style={{ color: 'var(--text-secondary)', fontSize: '11px' }}>
                            ({email.recipient_email})
                          </span>
                        </div>
                        {isExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                      </button>

                      {isExpanded && (
                        <div
                          style={{
                            padding: '10px',
                            backgroundColor: 'var(--bg-panel)',
                            borderTop: '1px solid var(--border-subtle)',
                            display: 'flex',
                            flexDirection: 'column',
                            gap: '6px',
                          }}
                        >
                          <div>
                            <strong>Subject:</strong> {email.subject}
                          </div>

                          {email.metadata?.applied_rule && (
                            <div
                              style={{
                                fontSize: '11px',
                                padding: '3px 8px',
                                borderRadius: '4px',
                                backgroundColor: '#fef3c7',
                                color: '#92400e',
                                border: '1px solid #fde68a',
                              }}
                            >
                              <strong>Rule Applied:</strong> {email.metadata.applied_rule}
                            </div>
                          )}

                          <div
                            style={{
                              whiteSpace: 'pre-wrap',
                              fontSize: '11.5px',
                              lineHeight: 1.45,
                              backgroundColor: '#ffffff',
                              padding: '8px',
                              borderRadius: '4px',
                              border: '1px solid var(--border-light)',
                              color: 'var(--text-primary)',
                            }}
                          >
                            {email.body}
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Citations */}
          <CitationBadges
            citations={previewData.citations}
            onSelectCitation={onSelectCitation}
          />

          {/* Confirmation Controls */}
          <div style={{ display: 'flex', gap: '8px', marginTop: '4px' }}>
            <button
              type="button"
              className="btn-primary-indigo"
              style={{ flex: 1, padding: '10px 14px', fontSize: '12.5px' }}
              disabled={isBusy}
              onClick={handleConfirmOperation}
            >
              Approve All &amp; Execute (Stage 2 Confirm)
            </button>

            {clarificationData && (
              <button
                type="button"
                className="btn-warm-outlined"
                style={{ padding: '8px 12px', fontSize: '12px' }}
                onClick={() => setWorkflowStatus('clarification')}
              >
                Adjust Resolution
              </button>
            )}

            <button
              type="button"
              className="btn-warm-outlined"
              style={{ padding: '8px 12px', fontSize: '12px' }}
              onClick={handleResetWorkflow}
            >
              Cancel
            </button>
          </div>
        </motion.div>
      )}

      {/* =========================================================================
          4.4 STATE 3: EXECUTED (Live Commit Receipt Card)
          ========================================================================= */}
      {workflowStatus === 'executed' && executedData && (
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          className="execution-receipt-card"
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: '12px',
            padding: '16px',
            backgroundColor: '#f0fdf4',
            borderRadius: '10px',
            border: '2px solid #16a34a',
            boxShadow: '0 4px 14px rgba(22, 163, 74, 0.12)',
          }}
        >
          {/* Header */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '6px',
                padding: '3px 10px',
                borderRadius: '999px',
                fontSize: '11.5px',
                fontWeight: 800,
                backgroundColor: '#dcfce7',
                color: '#166534',
                border: '1px solid #86efac',
              }}
            >
              <CheckCircle2 size={14} />
              EXECUTION CONFIRMED &amp; ATOMICALLY COMMITTED
            </span>

            <button
              type="button"
              className="btn-warm-outlined"
              style={{ padding: '2px 8px', fontSize: '11px' }}
              onClick={handleResetWorkflow}
            >
              Dismiss
            </button>
          </div>

          {/* Counts */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '1fr 1fr',
              gap: '10px',
            }}
          >
            <div
              style={{
                padding: '10px',
                backgroundColor: '#ffffff',
                borderRadius: '8px',
                border: '1px solid #bbf7d0',
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
                backgroundColor: '#ffffff',
                borderRadius: '8px',
                border: '1px solid #bbf7d0',
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

          <div style={{ fontSize: '12px', color: '#166534', lineHeight: 1.45 }}>
            All row mutations have been committed to PostgreSQL and customer email notifications have been dispatched. The live spreadsheet data table has been automatically refreshed.
          </div>

          {/* Citations */}
          <CitationBadges
            citations={executedData.citations}
            onSelectCitation={onSelectCitation}
          />

          <button
            type="button"
            className="btn-primary-indigo"
            style={{ padding: '9px 14px', fontSize: '12px', marginTop: '4px' }}
            onClick={handleResetWorkflow}
          >
            Run Another Operation
          </button>
        </motion.div>
      )}
    </div>
  );
}
