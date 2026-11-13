import { useEffect, useState } from 'react';
import type {
  ClarificationRequiredPayload,
  ConversationHistoryTurn,
  ConversationalPayload,
  ExecutedPayload,
  PreviewReadyPayload,
  RoutedSheetInstruction,
  WorkspaceMutationDiff,
} from '../../../shared/types/contracts';
import {
  confirmWorkspaceOperationApi,
  executeWorkspaceOperationApi,
  resolveWorkspaceSocraticApi,
} from '../services/api';

export interface RoutedSheetInstructionResult {
  message: string;
  entity: string;
  matched_row_ids: string[];
  applied_filter_summary: string;
  status: string;
}

export type WorkflowStatus =
  | 'idle'
  | 'executing'
  | 'clarification'
  | 'preview'
  | 'executed'
  | 'conversational';

export interface ConversationChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  stageHint?: 'clarification' | 'preview' | 'executed' | 'conversational' | 'error';
  stageSummary?: string;
}

export interface UseB2BOperationsWorkflowOptions {
  activeBusinessId?: string;
  activeEntity: string;
  isBusy: boolean;
  nlPrompt: string;
  onPromptChange: (prompt: string) => void;
  onRefreshTable: () => void;
  onMutationsPreviewChange?: (mutations: WorkspaceMutationDiff[]) => void;
  onRunSheetInstruction: (
    intent: RoutedSheetInstruction['intent'],
    entity: string,
    prompt: string,
    conversationHistory?: ConversationHistoryTurn[]
  ) => Promise<RoutedSheetInstructionResult | string>;
  onApplySheetQueryResult?: (payload: RoutedSheetInstruction) => void;
  onResetWorkspace?: () => void;
}

function summarizeInterpretedFilters(interpretedQuery: any): string {
  const filters = Array.isArray(interpretedQuery?.filters)
    ? interpretedQuery.filters
    : [];
  if (filters.length === 0) return '';
  const logic = String(interpretedQuery?.filter_logic || 'AND').toUpperCase();
  return filters
    .map((f: any) => `${f.field || f.column} ${f.operator} ${JSON.stringify(f.value)}`)
    .join(` ${logic} `);
}

function createMessageId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

export function useB2BOperationsWorkflow({
  activeBusinessId,
  activeEntity,
  isBusy,
  nlPrompt,
  onPromptChange,
  onRefreshTable,
  onMutationsPreviewChange,
  onRunSheetInstruction,
  onApplySheetQueryResult,
  onResetWorkspace,
}: UseB2BOperationsWorkflowOptions) {
  const [workflowStatus, setWorkflowStatus] = useState<WorkflowStatus>('idle');
  const [executingStep, setExecutingStep] = useState<string>('');
  const [workflowError, setWorkflowError] = useState<string | null>(null);

  const [currentWorkflowId, setCurrentWorkflowId] = useState<string | null>(null);
  const [clarificationData, setClarificationData] =
    useState<ClarificationRequiredPayload | null>(null);
  const [selectedOptionsMap, setSelectedOptionsMap] = useState<Record<string, string>>({});
  const [previewData, setPreviewData] = useState<PreviewReadyPayload | null>(null);
  const [executedData, setExecutedData] = useState<ExecutedPayload | null>(null);
  const [conversationalData, setConversationalData] =
    useState<ConversationalPayload | null>(null);
  const [conversationHistory, setConversationHistory] = useState<ConversationChatMessage[]>(
    []
  );
  const [structuredHistory, setStructuredHistory] = useState<ConversationHistoryTurn[]>([]);

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
    setStructuredHistory([]);
    onMutationsPreviewChange?.([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeBusinessId]);

  const handleSelectSocraticOption = (questionId: string, optionId: string) => {
    setSelectedOptionsMap((prev) => ({
      ...prev,
      [questionId]: optionId,
    }));
  };

  // Turn 1..N: Run AI Instruction with 5-turn sliding conversational memory
  const handleExecuteOperation = async (customPrompt?: string) => {
    const promptToRun = (
      typeof customPrompt === 'string' ? customPrompt : nlPrompt
    ).trim();
    if (!promptToRun || isBusy || workflowStatus === 'executing') return;

    const windowHistory = structuredHistory.slice(-5);

    setWorkflowError(null);
    setWorkflowStatus('executing');
    setExecutingStep('Discovering sources & evaluating multi-hop policy constraints...');
    setClarificationData(null);
    setPreviewData(null);
    setExecutedData(null);
    setConversationalData(null);
    onPromptChange('');

    setConversationHistory((previous) => [
      ...previous,
      {
        id: createMessageId('user'),
        role: 'user',
        content: promptToRun,
      },
    ]);

    try {
      const res = await executeWorkspaceOperationApi({
        prompt: promptToRun,
        entity: 'user',
        table_name: activeEntity,
        conversation_history: windowHistory,
        history: windowHistory,
        businessId: activeBusinessId,
      });

      let routedMessage = '';
      let turnIntent = String(res.status || 'UNKNOWN');
      let turnTable: string | null = activeEntity || null;
      let turnMatchedIds: string[] = [];
      let turnFilterSummary = '';
      let stageHint: ConversationChatMessage['stageHint'] = 'conversational';
      let stageSummary: string | undefined;

      if (res.status === 'SHEET_QUERY' && Array.isArray(res.rows)) {
        onApplySheetQueryResult?.(res);
        routedMessage = res.answer || res.message;
        turnIntent = 'SHEET_QUERY';
        turnTable = res.entity || activeEntity || null;
        turnMatchedIds =
          Array.isArray(res.highlighted_rows) && res.highlighted_rows.length > 0
            ? res.highlighted_rows.map((h) => String(h.row_identifier || '').trim()).filter(Boolean)
            : Array.isArray(res.matched_ids) && res.matched_ids.length > 0
              ? res.matched_ids.map((id) => String(id).trim()).filter(Boolean)
              : res.rows.map((r) => String(r?.id || '').trim()).filter(Boolean);
        turnFilterSummary = summarizeInterpretedFilters(res.interpretedQuery);

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
        stageSummary = `${res.rows.length} matched row(s) shown in table`;
      } else if (res.status === 'SHEET_QUERY' || res.status === 'SHEET_MUTATION') {
        const routedResult = await onRunSheetInstruction(
          res.intent,
          res.entity,
          promptToRun,
          windowHistory
        );
        if (typeof routedResult === 'string') {
          routedMessage = routedResult;
          turnTable = res.entity || activeEntity || null;
        } else {
          routedMessage = routedResult.message;
          turnTable = routedResult.entity || res.entity || activeEntity || null;
          turnMatchedIds = routedResult.matched_row_ids || [];
          turnFilterSummary = routedResult.applied_filter_summary || '';
        }
        turnIntent = res.status;
        setConversationalData({
          status: 'CONVERSATIONAL',
          conversational: true,
          intent: res.intent,
          message: routedMessage || res.message,
          citations: res.citations || [],
        });
        setWorkflowStatus('conversational');
        if (res.status !== 'SHEET_MUTATION') {
          onMutationsPreviewChange?.([]);
        }
      } else if (res.status === 'CONVERSATIONAL') {
        turnIntent =
          res.intent === 'cross_source_read'
            ? 'CROSS_SOURCE_READ'
            : String(res.intent || 'CONVERSATIONAL').toUpperCase();
        turnTable =
          res.highlighted_rows?.[0]?.table_name ||
          res.rows?.[0]?.table_name ||
          activeEntity ||
          null;
        turnMatchedIds =
          Array.isArray(res.highlighted_rows) && res.highlighted_rows.length > 0
            ? res.highlighted_rows.map((h) => String(h.row_identifier || '').trim()).filter(Boolean)
            : Array.isArray(res.rows)
              ? res.rows.map((r) => String(r?.id || '').trim()).filter(Boolean)
              : [];
        setConversationalData(res);
        setWorkflowStatus('conversational');
        onMutationsPreviewChange?.([]);
      } else if (res.status === 'CLARIFICATION_REQUIRED') {
        turnIntent = 'CROSS_DOCUMENT_OPERATION';
        turnTable = res.target_entity || activeEntity || null;
        turnMatchedIds = Array.isArray(res.matched_row_ids) ? res.matched_row_ids : [];
        setCurrentWorkflowId(res.workflow_id);
        setClarificationData(res);
        const initialOptions: Record<string, string> = {};
        for (const q of res.socratic_questions) {
          if (q.options && q.options.length > 0) {
            initialOptions[q.question_id] = q.options[0].option_id;
          }
        }
        setSelectedOptionsMap(initialOptions);
        setWorkflowStatus('clarification');
        onMutationsPreviewChange?.([]);
        stageHint = 'clarification';
        stageSummary = `${res.conflicting_rows_count} conflict(s) • Opened in main panel`;
      } else if (res.status === 'PREVIEW_READY') {
        turnIntent = 'CROSS_DOCUMENT_OPERATION';
        turnTable =
          res.target_entity ||
          res.mutations_preview?.[0]?.table_name ||
          activeEntity ||
          null;
        turnMatchedIds =
          Array.isArray(res.matched_row_ids) && res.matched_row_ids.length > 0
            ? res.matched_row_ids
            : (res.mutations_preview || [])
                .map((m) => String(m.row_identifier || '').trim())
                .filter(Boolean);
        setCurrentWorkflowId(res.workflow_id);
        setPreviewData(res);
        setWorkflowStatus('preview');
        onMutationsPreviewChange?.(res.mutations_preview || []);
        stageHint = 'preview';
        stageSummary = `${res.mutations_preview?.length || 0} DB row(s), ${res.emails_preview?.length || 0} email(s) • Review in main panel`;
      }

      const structuredSummaryText =
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

      const chatBubbleMessage =
        res.status === 'CLARIFICATION_REQUIRED'
          ? `${res.conflict_summary}\n\nPlease select your preferred policy resolution in the Clarification panel on the left.`
          : res.status === 'PREVIEW_READY'
            ? `Prepared a Stage 1 action preview (${res.mutations_preview?.length || 0} row mutation(s) and ${res.emails_preview?.length || 0} email draft(s)). Review and approve it in the main panel.`
            : structuredSummaryText;

      setConversationHistory((previous) => [
        ...previous,
        {
          id: createMessageId('assistant'),
          role: 'assistant',
          content: chatBubbleMessage,
          stageHint,
          stageSummary,
        },
      ]);

      setStructuredHistory((previous) => {
        const nextIndex =
          previous.length > 0
            ? Number(previous[previous.length - 1].turn_index || previous.length) + 1
            : 1;
        const entry: ConversationHistoryTurn = {
          turn_index: nextIndex,
          user_prompt: promptToRun,
          resolved_intent: turnIntent,
          target_table: turnTable,
          matched_row_ids: turnMatchedIds,
          applied_filter_summary: turnFilterSummary,
          assistant_response_summary: String(structuredSummaryText || '').slice(0, 600),
        };
        return [...previous, entry].slice(-5);
      });
    } catch (err: any) {
      const errorText = err?.message || 'Failed to execute cross-document instruction.';
      setWorkflowError(errorText);
      setConversationHistory((previous) => [
        ...previous,
        {
          id: createMessageId('error'),
          role: 'assistant',
          content: errorText,
          stageHint: 'error',
          stageSummary: 'Execution failed',
        },
      ]);
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
              (option) => selectedOptionsMap[question.question_id] === option.option_id
            )
            .map((option) => option.label)
        )
        .join('; ');

      setConversationHistory((previous) => [
        ...previous,
        ...(selectedLabels
          ? [
              {
                id: createMessageId('user'),
                role: 'user' as const,
                content: `Selected resolution: ${selectedLabels}`,
              },
            ]
          : []),
        {
          id: createMessageId('assistant'),
          role: 'assistant',
          content: `Prepared Stage 1 action preview (${res.mutations_preview?.length || 0} row mutation(s), ${res.emails_preview?.length || 0} email(s)) in the main panel.`,
          stageHint: 'preview',
          stageSummary: `${res.mutations_preview?.length || 0} DB row(s), ${res.emails_preview?.length || 0} email(s) • Ready for review`,
        },
      ]);

      setStructuredHistory((previous) => {
        if (previous.length === 0) return previous;
        const next = [...previous];
        const last = { ...next[next.length - 1] };
        const previewIds = (res.mutations_preview || [])
          .map((m) => String(m.row_identifier || '').trim())
          .filter(Boolean);
        last.target_table =
          res.target_entity ||
          res.mutations_preview?.[0]?.table_name ||
          last.target_table ||
          null;
        if (previewIds.length > 0) {
          last.matched_row_ids = previewIds;
        }
        last.assistant_response_summary = selectedLabels
          ? `Selected "${selectedLabels}" -> prepared preview for ${previewIds.length} row(s).`
          : `Prepared the action preview for ${previewIds.length} row(s).`;
        next[next.length - 1] = last;
        return next.slice(-5);
      });
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
          id: createMessageId('assistant'),
          role: 'assistant',
          content: `Completed the approved operation: updated ${res.updated_rows_count} row(s) and queued ${res.dispatched_emails_count} email(s).`,
          stageHint: 'executed',
          stageSummary: `Committed • ${res.updated_rows_count} rows, ${res.dispatched_emails_count} emails`,
        },
      ]);

      setStructuredHistory((previous) => {
        if (previous.length === 0) return previous;
        const next = [...previous];
        const last = { ...next[next.length - 1] };
        last.assistant_response_summary = `Completed the approved operation: updated ${res.updated_rows_count} rows and queued ${res.dispatched_emails_count} emails.`;
        next[next.length - 1] = last;
        return next.slice(-5);
      });

      // Auto-refresh the live database table so updated rows display immediately
      onRefreshTable();
    } catch (err: any) {
      setWorkflowError(err?.message || 'Failed to confirm and execute operation.');
      setWorkflowStatus('preview');
    }
  };

  const handleBackToClarification = () => {
    if (clarificationData) {
      setWorkflowStatus('clarification');
    }
  };

  const handleDismissError = () => {
    setWorkflowError(null);
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
    setStructuredHistory([]);
    onPromptChange('');
    onMutationsPreviewChange?.([]);
    onResetWorkspace?.();
  };

  return {
    workflowStatus,
    executingStep,
    workflowError,
    clarificationData,
    selectedOptionsMap,
    previewData,
    executedData,
    conversationalData,
    conversationHistory,
    handleSelectSocraticOption,
    handleExecuteOperation,
    handleResolveSocratic,
    handleConfirmOperation,
    handleBackToClarification,
    handleDismissError,
    handleResetWorkflow,
  };
}
