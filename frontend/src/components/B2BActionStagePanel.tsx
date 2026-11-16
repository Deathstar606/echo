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
} from 'lucide-react';
import type {
  Citation,
  ClarificationRequiredPayload,
  ExecutedPayload,
  PreviewReadyPayload,
  SocraticOption,
  SocraticQuestion,
  WorkspaceEmailPreview,
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
  onConfirmOperation: () => void;
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
  executedData,
  onSelectSocraticOption,
  onResolveSocratic,
  onUpdateEmailDraft,
  onApplyTemplateToAllEmails,
  onRestoreOriginalEmails,
  onConfirmOperation,
  onBackToClarification,
  onResetWorkflow,
  onSelectCitation,
}: B2BActionStagePanelProps): React.ReactElement | null {
  const [previewTab, setPreviewTab] = useState<'mutations' | 'emails'>('mutations');
  const [selectedEmailTab, setSelectedEmailTab] = useState<'all' | number>(0);
  const [templateSubject, setTemplateSubject] = useState('');
  const [templateBody, setTemplateBody] = useState('');

  useEffect(() => {
    if (!previewData) {
      setTemplateSubject('');
      setTemplateBody('');
      return;
    }
    const hasMutations = (previewData.mutations_preview?.length || 0) > 0;
    const hasEmails = (previewData.emails_preview?.length || 0) > 0;
    setPreviewTab(!hasMutations && hasEmails ? 'emails' : 'mutations');
    setSelectedEmailTab(0);
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
          backgroundColor: '#fffdfa',
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
              backgroundColor: '#fef3c7',
              color: '#92400e',
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

        <div
          style={{
            padding: '10px 12px',
            backgroundColor: '#fffbeb',
            borderRadius: '8px',
            border: '1px solid #fde68a',
            fontSize: '12.5px',
            lineHeight: 1.5,
            color: '#92400e',
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
                        backgroundColor: isSelected ? 'var(--accent-lavender-bg)' : '#ffffff',
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
    const hasMutations = (previewData.mutations_preview?.length || 0) > 0;

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
          backgroundColor: '#ffffff',
          borderRadius: '10px',
          border: '2px solid var(--primary-indigo)',
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
              color: 'var(--primary-indigo-dark)',
              border: '1px solid var(--accent-lavender-border)',
            }}
          >
            <Sparkles size={13} />
            STAGE 1 ACTION PREVIEW • READY
          </span>

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
                backgroundColor: previewTab === 'mutations' ? '#ffffff' : 'transparent',
                color: previewTab === 'mutations' ? 'var(--primary-indigo)' : 'var(--text-secondary)',
                boxShadow: previewTab === 'mutations' ? '0 1px 3px rgba(0,0,0,0.08)' : 'none',
                display: 'inline-flex',
                alignItems: 'center',
                gap: '5px',
              }}
              onClick={() => setPreviewTab('mutations')}
            >
              <Table2 size={13} />
              <span>DB Rows ({previewData.mutations_preview?.length || 0})</span>
            </button>

            <button
              type="button"
              style={{
                padding: '5px 12px',
                borderRadius: '6px',
                fontSize: '12px',
                fontWeight: previewTab === 'emails' ? 700 : 500,
                backgroundColor: previewTab === 'emails' ? '#ffffff' : 'transparent',
                color: previewTab === 'emails' ? 'var(--primary-indigo)' : 'var(--text-secondary)',
                boxShadow: previewTab === 'emails' ? '0 1px 3px rgba(0,0,0,0.08)' : 'none',
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
        </div>

        {previewTab === 'mutations' && (
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
                  <div style={{ fontWeight: 700, color: 'var(--primary-indigo-dark)' }}>
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
                          backgroundColor: '#ffffff',
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

        {previewTab === 'emails' && (
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
                    backgroundColor: '#ffffff',
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
                  backgroundColor: '#f8fafc',
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
                            : '#ffffff',
                          color: isSelected ? '#ffffff' : 'var(--text-secondary)',
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
                            : 'var(--border-warm)'
                        }`,
                        backgroundColor:
                          selectedEmailTab === 'all'
                            ? 'var(--primary-indigo)'
                            : '#eef2ff',
                        color:
                          selectedEmailTab === 'all'
                            ? '#ffffff'
                            : 'var(--primary-indigo-dark)',
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
                        color: 'var(--primary-indigo-dark)',
                        backgroundColor: '#eef2ff',
                        border: '1px solid #c7d2fe',
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
                          backgroundColor: '#ffffff',
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
                          backgroundColor: '#ffffff',
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
                        backgroundColor: '#ffffff',
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
                            backgroundColor: '#fef3c7',
                            color: '#92400e',
                            border: '1px solid #fde68a',
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
                              backgroundColor: '#ffffff',
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
                              backgroundColor: '#ffffff',
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
                              backgroundColor: '#f8fafc',
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
            disabled={isBusy || hasBlankDraft}
            onClick={onConfirmOperation}
          >
            {!hasMutations && activeEmails.length > 0
              ? `Confirm & Send (${activeEmails.length} Email${activeEmails.length === 1 ? '' : 's'})`
              : 'Approve All & Execute (Stage 2 Confirm)'}
          </button>

          {clarificationData && (
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
            onClick={onResetWorkflow}
          >
            Cancel
          </button>
        </div>
      </motion.section>
    );
  }

  if (workflowStatus === 'executed' && executedData) {
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
          backgroundColor: '#f0fdf4',
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
            style={{ padding: '3px 10px', fontSize: '11.5px' }}
            onClick={onResetWorkflow}
          >
            Dismiss
          </button>
        </div>

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

        <div style={{ fontSize: '12.5px', color: '#166534', lineHeight: 1.45 }}>
          All row mutations have been committed to PostgreSQL and customer email notifications have
          been dispatched. The live spreadsheet data table has been automatically refreshed.
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
