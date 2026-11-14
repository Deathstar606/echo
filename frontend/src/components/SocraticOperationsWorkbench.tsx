import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  Check,
  Loader2,
  Mail,
  RotateCcw,
  Send,
  Sparkles,
  X,
} from 'lucide-react';
import type {
  PreviewReadyPayload,
  WorkspaceEmailPreview,
} from '../../../shared/types/contracts';
import type {
  ConversationChatMessage,
  WorkflowStatus,
} from '../hooks/useB2BOperationsWorkflow';

interface SocraticOperationsWorkbenchProps {
  activeEntity: string;
  activeDisplayName: string;
  workflowStatus: WorkflowStatus;
  executingStep: string;
  workflowError: string | null;
  conversationHistory: ConversationChatMessage[];
  previewData?: PreviewReadyPayload | null;
  editedEmails?: WorkspaceEmailPreview[];
  isBusy: boolean;
  nlPrompt: string;
  onPromptChange: (prompt: string) => void;
  samplePrompts: Array<{ label: string; text: string }>;
  onExecuteOperation: (customPrompt?: string) => void;
  onUpdateEmailDraft?: (
    index: number,
    patch: { subject?: string; body?: string }
  ) => void;
  onApplyTemplateToAllEmails?: (template: {
    subject?: string;
    body?: string;
  }) => void;
  onRestoreOriginalEmails?: () => void;
  onConfirmOperation?: () => void;
  onDismissError: () => void;
  onResetWorkflow: () => void;
}

export default function SocraticOperationsWorkbench({
  activeEntity,
  activeDisplayName,
  workflowStatus,
  executingStep,
  workflowError,
  conversationHistory,
  previewData,
  editedEmails,
  isBusy,
  nlPrompt,
  onPromptChange,
  samplePrompts,
  onExecuteOperation,
  onUpdateEmailDraft,
  onApplyTemplateToAllEmails,
  onRestoreOriginalEmails,
  onConfirmOperation,
  onDismissError,
  onResetWorkflow,
}: SocraticOperationsWorkbenchProps): React.ReactElement {
  const threadEndRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [selectedTab, setSelectedTab] = useState<'all' | number>(0);
  const [templateSubject, setTemplateSubject] = useState('');
  const [templateBody, setTemplateBody] = useState('');

  const emailsToEdit = useMemo(
    () =>
      editedEmails && editedEmails.length > 0
        ? editedEmails
        : previewData?.emails_preview || [],
    [editedEmails, previewData]
  );

  useEffect(() => {
    setSelectedTab(0);
    if (previewData) {
      const firstEmail = previewData.emails_preview?.[0];
      setTemplateSubject(
        previewData.email_draft_template?.subject || firstEmail?.subject || ''
      );
      setTemplateBody(
        previewData.email_draft_template?.body || firstEmail?.body || ''
      );
    } else {
      setTemplateSubject('');
      setTemplateBody('');
    }
  }, [previewData?.workflow_id]);

  useEffect(() => {
    if (
      conversationHistory.length > 0 ||
      workflowStatus === 'executing' ||
      workflowStatus === 'preview'
    ) {
      threadEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }
  }, [conversationHistory.length, workflowStatus, emailsToEdit.length]);

  const originalEmails = previewData?.emails_preview || [];
  const hasCustomEdits =
    emailsToEdit.length > 0 &&
    originalEmails.length === emailsToEdit.length &&
    emailsToEdit.some(
      (item, idx) =>
        item.subject !== originalEmails[idx]?.subject ||
        item.body !== originalEmails[idx]?.body
    );
  const hasBlankDraft = emailsToEdit.some(
    (item) => !item.subject?.trim() || !item.body?.trim()
  );
  const activeEmailIndex =
    typeof selectedTab === 'number' && selectedTab < emailsToEdit.length
      ? selectedTab
      : 0;
  const currentEmail = emailsToEdit[activeEmailIndex];
  const hasMutations = (previewData?.mutations_preview?.length || 0) > 0;

  const handleRestoreDrafts = () => {
    onRestoreOriginalEmails?.();
    if (previewData) {
      const firstOrig = previewData.emails_preview?.[0];
      setTemplateSubject(
        previewData.email_draft_template?.subject || firstOrig?.subject || ''
      );
      setTemplateBody(
        previewData.email_draft_template?.body || firstOrig?.body || ''
      );
    }
  };

  const handleSubmit = (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!nlPrompt.trim() || isBusy || workflowStatus === 'executing') return;
    onExecuteOperation();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const handlePickSample = (text: string) => {
    onPromptChange(text);
    textareaRef.current?.focus();
  };

  const isEmptyThread = conversationHistory.length === 0 && workflowStatus === 'idle';
  const showResetButton = conversationHistory.length > 0 || workflowStatus !== 'idle';

  return (
    <aside
      aria-label="B2B Autonomous Operations Copilot"
      className="copilot-side-card socratic-operations-workbench b2b-chat-panel"
    >
      {/* Compact Header */}
      <div className="copilot-header b2b-chat-header">
        <div className="copilot-title" style={{ minWidth: 0 }}>
          <Sparkles size={16} color="#d97706" style={{ flexShrink: 0 }} />
          <span style={{ lineHeight: 1.25 }}>B2B Operations Copilot</span>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexShrink: 0 }}>
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

          {showResetButton && (
            <button
              type="button"
              className="btn-warm-outlined"
              onClick={onResetWorkflow}
              title="Reset conversation & table filters"
              style={{
                padding: '4px 8px',
                fontSize: '11px',
                display: 'inline-flex',
                alignItems: 'center',
                gap: '4px',
              }}
            >
              <RotateCcw size={12} />
              <span>Reset</span>
            </button>
          )}
        </div>
      </div>

      {/* Scrollable ChatGPT / Gemini Conversation Thread */}
      <div
        className={`b2b-chat-thread ${isEmptyThread ? 'is-empty' : ''}`}
        role="log"
        aria-live="polite"
      >
        {isEmptyThread ? (
          <div className="b2b-chat-welcome-banner">
            <div className="b2b-chat-avatar is-assistant" aria-hidden="true">
              <Sparkles size={13} />
            </div>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: '12.5px', fontWeight: 700, color: 'var(--text-primary)' }}>
                Ready to query sheets &amp; coordinate B2B actions
              </div>
              <div style={{ fontSize: '11.5px', color: 'var(--text-secondary)', lineHeight: 1.4, marginTop: '2px' }}>
                Ask about rows, cross-check SLA/policy docs, or propose row updates and customer emails.
              </div>
            </div>
          </div>
        ) : (
          conversationHistory.map((turn) => {
            const isUser = turn.role === 'user';
            return (
              <div
                key={turn.id}
                className={`b2b-chat-row ${isUser ? 'is-user' : 'is-assistant'}`}
              >
                {!isUser && (
                  <div className="b2b-chat-avatar is-assistant" aria-hidden="true">
                    <Sparkles size={13} />
                  </div>
                )}

                <div className={`b2b-chat-bubble ${isUser ? 'is-user' : 'is-assistant'}`}>
                  <div className="b2b-chat-bubble-text">{turn.content}</div>
                  {!isUser && turn.stageSummary && (
                    <div className={`b2b-chat-stage-pill is-${turn.stageHint || 'conversational'}`}>
                      {turn.stageSummary}
                    </div>
                  )}
                </div>
              </div>
            );
          })
        )}

        {workflowStatus === 'executing' && (
          <div className="b2b-chat-row is-assistant">
            <div className="b2b-chat-avatar is-assistant" aria-hidden="true">
              <Loader2 size={13} className="animate-spin" />
            </div>
            <div className="b2b-chat-bubble is-assistant is-thinking">
              <div style={{ fontSize: '12px', fontWeight: 600, color: 'var(--primary-indigo-dark)' }}>
                Evaluating operation...
              </div>
              <div style={{ fontSize: '11.5px', color: 'var(--text-secondary)', marginTop: '2px' }}>
                {executingStep || 'Processing request...'}
              </div>
            </div>
          </div>
        )}

        <div ref={threadEndRef} />
      </div>

      {/* Concise Error Banner */}
      {workflowError && (
        <div
          className="alert-banner error"
          style={{
            fontSize: '12px',
            padding: '8px 10px',
            margin: '0 14px 8px 14px',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: '8px', minWidth: 0 }}>
            <AlertCircle size={15} style={{ flexShrink: 0, marginTop: '1px' }} />
            <span style={{ wordBreak: 'break-word' }}>{workflowError}</span>
          </div>
          <button
            type="button"
            onClick={onDismissError}
            aria-label="Dismiss error"
            style={{ color: 'inherit', padding: '2px', flexShrink: 0 }}
          >
            <X size={13} />
          </button>
        </div>
      )}

      {/* Inline Editable Email Draft Box for Chat-Triggered Email Previews */}
      {workflowStatus === 'preview' && emailsToEdit.length > 0 && (
        <section
          aria-label="Editable email draft preview"
          style={{
            margin: '0 14px 10px 14px',
            padding: '12px',
            borderRadius: '10px',
            border: '1.5px solid var(--primary-indigo)',
            backgroundColor: '#f8fafc',
            display: 'flex',
            flexDirection: 'column',
            gap: '8px',
            maxHeight: '340px',
            overflowY: 'auto',
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: '6px',
              flexWrap: 'wrap',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <Mail size={14} color="var(--primary-indigo)" />
              <span
                style={{
                  fontSize: '12px',
                  fontWeight: 700,
                  color: 'var(--primary-indigo-dark)',
                }}
              >
                Email Draft ({emailsToEdit.length} Recipient
                {emailsToEdit.length === 1 ? '' : 's'})
              </span>
              {hasMutations && (
                <span
                  style={{
                    fontSize: '10.5px',
                    fontWeight: 700,
                    padding: '1px 6px',
                    borderRadius: '999px',
                    backgroundColor: '#fef3c7',
                    color: '#92400e',
                  }}
                >
                  +{previewData?.mutations_preview?.length} DB Update(s)
                </span>
              )}
            </div>

            {hasCustomEdits && onRestoreOriginalEmails && (
              <button
                type="button"
                onClick={handleRestoreDrafts}
                style={{
                  fontSize: '11px',
                  fontWeight: 600,
                  color: 'var(--primary-indigo)',
                  backgroundColor: '#ffffff',
                  border: '1px solid var(--border-warm)',
                  borderRadius: '6px',
                  padding: '2px 7px',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '4px',
                  cursor: 'pointer',
                }}
              >
                <RotateCcw size={11} />
                <span>Restore Original</span>
              </button>
            )}
          </div>

          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '4px',
              overflowX: 'auto',
              paddingBottom: '2px',
            }}
          >
            {emailsToEdit.map((email, idx) => {
              const isSelected = selectedTab === idx;
              return (
                <button
                  key={`${email.recipient_email}-${idx}`}
                  type="button"
                  onClick={() => setSelectedTab(idx)}
                  title={`${email.customer_identifier} (${email.recipient_email})`}
                  style={{
                    flexShrink: 0,
                    fontSize: '11px',
                    fontWeight: isSelected ? 700 : 500,
                    padding: '3px 8px',
                    borderRadius: '999px',
                    border: `1px solid ${
                      isSelected ? 'var(--primary-indigo)' : 'var(--border-warm)'
                    }`,
                    backgroundColor: isSelected
                      ? 'var(--primary-indigo)'
                      : '#ffffff',
                    color: isSelected ? '#ffffff' : 'var(--text-secondary)',
                    cursor: 'pointer',
                    maxWidth: '165px',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {email.customer_identifier || email.recipient_email}
                </button>
              );
            })}

            {emailsToEdit.length > 1 && onApplyTemplateToAllEmails && (
              <button
                type="button"
                onClick={() => setSelectedTab('all')}
                style={{
                  flexShrink: 0,
                  fontSize: '11px',
                  fontWeight: selectedTab === 'all' ? 700 : 600,
                  padding: '3px 8px',
                  borderRadius: '999px',
                  border: `1px solid ${
                    selectedTab === 'all'
                      ? 'var(--primary-indigo)'
                      : 'var(--border-warm)'
                  }`,
                  backgroundColor:
                    selectedTab === 'all'
                      ? 'var(--primary-indigo)'
                      : '#eef2ff',
                  color:
                    selectedTab === 'all'
                      ? '#ffffff'
                      : 'var(--primary-indigo-dark)',
                  cursor: 'pointer',
                }}
              >
                All ({emailsToEdit.length}) Template
              </button>
            )}
          </div>

          {selectedTab === 'all' && emailsToEdit.length > 1 ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <div
                style={{
                  fontSize: '11px',
                  color: 'var(--text-secondary)',
                  backgroundColor: '#eef2ff',
                  padding: '4px 8px',
                  borderRadius: '6px',
                }}
              >
                Editing all {emailsToEdit.length} drafts together. Use{' '}
                <code>{'{{customer_name}}'}</code> to personalize each greeting.
              </div>

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
                  padding: '6px 8px',
                  fontSize: '12px',
                  fontWeight: 600,
                  borderRadius: '6px',
                  border: '1px solid var(--border-warm)',
                  backgroundColor: '#ffffff',
                }}
              />

              <textarea
                rows={4}
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
                  padding: '7px 8px',
                  fontSize: '12px',
                  lineHeight: 1.45,
                  borderRadius: '6px',
                  border: '1px solid var(--border-warm)',
                  backgroundColor: '#ffffff',
                  resize: 'vertical',
                  fontFamily: 'inherit',
                }}
              />
            </div>
          ) : (
            currentEmail && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                <div
                  style={{
                    fontSize: '11px',
                    color: 'var(--text-secondary)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: '6px',
                  }}
                >
                  <span
                    style={{
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    <strong>To:</strong> {currentEmail.customer_identifier} &lt;
                    {currentEmail.recipient_email}&gt;
                  </span>
                </div>

                <input
                  type="text"
                  aria-label="Email subject"
                  placeholder="Email Subject"
                  value={currentEmail.subject}
                  onChange={(e) =>
                    onUpdateEmailDraft?.(activeEmailIndex, {
                      subject: e.target.value,
                    })
                  }
                  style={{
                    width: '100%',
                    padding: '6px 8px',
                    fontSize: '12px',
                    fontWeight: 600,
                    borderRadius: '6px',
                    border: '1px solid var(--border-warm)',
                    backgroundColor: '#ffffff',
                  }}
                />

                <textarea
                  rows={4}
                  aria-label="Email message body"
                  placeholder="Email message body..."
                  value={currentEmail.body}
                  onChange={(e) =>
                    onUpdateEmailDraft?.(activeEmailIndex, {
                      body: e.target.value,
                    })
                  }
                  style={{
                    width: '100%',
                    padding: '7px 8px',
                    fontSize: '12px',
                    lineHeight: 1.45,
                    borderRadius: '6px',
                    border: '1px solid var(--border-warm)',
                    backgroundColor: '#ffffff',
                    resize: 'vertical',
                    fontFamily: 'inherit',
                  }}
                />
              </div>
            )
          )}

          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              marginTop: '2px',
            }}
          >
            <button
              type="button"
              className="btn-primary-indigo"
              disabled={isBusy || hasBlankDraft}
              onClick={() => onConfirmOperation?.()}
              style={{
                flex: 1,
                padding: '7px 10px',
                fontSize: '12px',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '5px',
              }}
            >
              <Check size={13} />
              <span>
                {hasMutations
                  ? `Confirm Updates & Send (${emailsToEdit.length})`
                  : `Confirm & Send (${emailsToEdit.length})`}
              </span>
            </button>

            <button
              type="button"
              className="btn-warm-outlined"
              disabled={isBusy}
              onClick={onResetWorkflow}
              style={{
                padding: '7px 10px',
                fontSize: '12px',
              }}
            >
              Cancel
            </button>
          </div>
        </section>
      )}

      {/* Chat Composer Box */}
      <form className="b2b-chat-composer" onSubmit={handleSubmit}>
        <div className="b2b-chat-composer-box">
          <textarea
            ref={textareaRef}
            className="b2b-chat-textarea"
            rows={2}
            placeholder="Message B2B Operations Copilot... (Enter to send)"
            value={nlPrompt}
            onChange={(e) => onPromptChange(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={isBusy || workflowStatus === 'executing'}
          />

          <div className="b2b-chat-composer-actions">
            <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
              Enter to send • Shift+Enter for new line
            </span>

            <button
              type="submit"
              className="btn-primary-indigo b2b-chat-send-btn"
              disabled={!nlPrompt.trim() || isBusy || workflowStatus === 'executing'}
              title="Run AI Instruction"
            >
              {workflowStatus === 'executing' ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <Send size={14} />
              )}
              <span>Send</span>
            </button>
          </div>
        </div>
      </form>

      {/* Quick Sample Suggestions always neatly below the chat box */}
      {samplePrompts.length > 0 && (
        <div className="b2b-chat-suggestions-footer">
          <div className="b2b-chat-suggestions-label">Quick Suggestions</div>
          <div className="b2b-chat-suggestions-chips">
            {samplePrompts.map((sample) => (
              <button
                key={sample.label}
                type="button"
                className="b2b-chat-sample-chip"
                onClick={() => handlePickSample(sample.text)}
                title={sample.text}
              >
                {sample.label}
              </button>
            ))}
          </div>
        </div>
      )}
    </aside>
  );
}
