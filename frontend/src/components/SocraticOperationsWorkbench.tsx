import React, { useEffect, useRef } from "react";
import {
  AlertCircle,
  Lightbulb,
  Loader2,
  RotateCcw,
  Send,
  Sparkles,
  X,
} from "lucide-react";
import type {
  ConversationChatMessage,
  WorkflowStatus,
} from "../hooks/useB2BOperationsWorkflow";

interface SocraticOperationsWorkbenchProps {
  activeEntity: string;
  activeDisplayName: string;
  workflowStatus: WorkflowStatus;
  executingStep: string;
  workflowError: string | null;
  conversationHistory: ConversationChatMessage[];
  isBusy: boolean;
  nlPrompt: string;
  onPromptChange: (prompt: string) => void;
  samplePrompts?: Array<{ label: string; text: string }>;
  onExecuteOperation: (customPrompt?: string) => void;
  onDismissError: () => void;
  onResetWorkflow: () => void;
  workbenchRef?: React.RefObject<HTMLElement | null>;
  composerTextareaRef?: React.RefObject<HTMLTextAreaElement | null>;
}

export default function SocraticOperationsWorkbench({
  activeEntity,
  activeDisplayName,
  workflowStatus,
  executingStep,
  workflowError,
  conversationHistory,
  isBusy,
  nlPrompt,
  onPromptChange,
  onExecuteOperation,
  onDismissError,
  onResetWorkflow,
  workbenchRef,
  composerTextareaRef,
}: SocraticOperationsWorkbenchProps): React.ReactElement {
  const threadEndRef = useRef<HTMLDivElement | null>(null);
  const internalTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const textareaRef = composerTextareaRef || internalTextareaRef;

  useEffect(() => {
    if (conversationHistory.length > 0 || workflowStatus === "executing") {
      threadEndRef.current?.scrollIntoView({
        behavior: "smooth",
        block: "end",
      });
    }
  }, [conversationHistory.length, workflowStatus]);

  const handleSubmit = (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!nlPrompt.trim() || isBusy || workflowStatus === "executing") return;
    onExecuteOperation();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const isEmptyThread =
    conversationHistory.length === 0 && workflowStatus === "idle";
  const showResetButton =
    conversationHistory.length > 0 || workflowStatus !== "idle";

  return (
    <aside
      ref={workbenchRef}
      aria-label="B2B Autonomous Operations Copilot"
      className="copilot-side-card socratic-operations-workbench b2b-chat-panel"
    >
      {/* Compact Header */}
      <div className="copilot-header b2b-chat-header">
        <div className="copilot-title" style={{ minWidth: 0 }}>
          <Sparkles size={16} color="#d97706" style={{ flexShrink: 0 }} />
          <span style={{ lineHeight: 1.25 }}>B2B Operations Copilot</span>
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "6px",
            flexShrink: 0,
          }}
        >
          {(activeDisplayName || activeEntity) && (
            <span
              className="liquid-glass-pill"
              style={{
                fontSize: "10.5px",
                fontWeight: 700,
                color: "var(--primary-indigo)",
                padding: "2px 8px",
                borderRadius: "999px",
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
                padding: "4px 8px",
                fontSize: "11px",
                display: "inline-flex",
                alignItems: "center",
                gap: "4px",
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
        className={`b2b-chat-thread ${isEmptyThread ? "is-empty" : ""}`}
        role="log"
        aria-live="polite"
      >
        {isEmptyThread ? (
          <div
            className="b2b-chat-tips-card"
            role="note"
            aria-label="Prompting tips"
          >
            <div className="b2b-chat-tips-header">
              <Lightbulb size={13} color="#581AFF" style={{ flexShrink: 0 }} />
              <span>Prompting Tips</span>
            </div>
            <ul className="b2b-chat-tips-list">
              <li>
                <strong>Be specific:</strong> Reference exact column names, IDs,
                or values (e.g.{" "}
                <em>
                  &ldquo;Show orders where Dispatch_Status is Delayed&rdquo;
                </em>
                ).
              </li>
              <li>
                <strong>State clear edits:</strong> Include the filter condition
                and target change (e.g.{" "}
                <em>&ldquo;Set discount to 10% for price &gt; 1500&rdquo;</em>).
              </li>
              <li>
                <strong>See matching rows:</strong> If you want to see all rows
                that match a certain criteria type (e.g.{" "}
                <em>&ldquo;Show matching rows&rdquo;</em>).
              </li>
              <li>
                <strong>Combine docs &amp; sheets:</strong> Ask to cross-check
                an uploaded SLA or policy doc before staging emails or updates.
              </li>
            </ul>
          </div>
        ) : (
          conversationHistory.map((turn) => {
            const isUser = turn.role === "user";
            return (
              <div
                key={turn.id}
                className={`b2b-chat-row ${isUser ? "is-user" : "is-assistant"}`}
              >
                {!isUser && (
                  <div
                    className="b2b-chat-avatar is-assistant"
                    aria-hidden="true"
                  >
                    <Sparkles size={13} />
                  </div>
                )}

                <div
                  className={`b2b-chat-bubble ${isUser ? "is-user" : "is-assistant"}`}
                >
                  <div className="b2b-chat-bubble-text">{turn.content}</div>
                  {!isUser && turn.stageSummary && (
                    <div
                      className={`b2b-chat-stage-pill is-${turn.stageHint || "conversational"}`}
                    >
                      {turn.stageSummary}
                    </div>
                  )}
                </div>
              </div>
            );
          })
        )}

        {workflowStatus === "executing" && (
          <div className="b2b-chat-row is-assistant">
            <div className="b2b-chat-avatar is-assistant" aria-hidden="true">
              <Loader2 size={13} className="animate-spin" />
            </div>
            <div className="b2b-chat-bubble is-assistant is-thinking">
              <div
                style={{
                  fontSize: "12px",
                  fontWeight: 600,
                  color: "var(--primary-indigo-text)",
                }}
              >
                Evaluating operation...
              </div>
              <div
                style={{
                  fontSize: "11.5px",
                  color: "var(--text-secondary)",
                  marginTop: "2px",
                }}
              >
                {executingStep || "Processing request..."}
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
            fontSize: "12px",
            padding: "8px 10px",
            margin: "0 14px 8px 14px",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "flex-start",
              gap: "8px",
              minWidth: 0,
            }}
          >
            <AlertCircle
              size={15}
              style={{ flexShrink: 0, marginTop: "1px" }}
            />
            <span style={{ wordBreak: "break-word" }}>{workflowError}</span>
          </div>
          <button
            type="button"
            onClick={onDismissError}
            aria-label="Dismiss error"
            style={{ color: "inherit", padding: "2px", flexShrink: 0 }}
          >
            <X size={13} />
          </button>
        </div>
      )}

      {/* Chat Composer Box */}
      <form className="b2b-chat-composer" onSubmit={handleSubmit}>
        <div className="b2b-chat-composer-box">
          <textarea
            ref={textareaRef}
            className="b2b-chat-textarea"
            rows={4}
            style={{ minHeight: "96px" }}
            placeholder="Message B2B Operations Copilot... (Enter to send)"
            value={nlPrompt}
            onChange={(e) => onPromptChange(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={isBusy || workflowStatus === "executing"}
          />

          <div className="b2b-chat-composer-actions">
            <span style={{ fontSize: "11px", color: "var(--text-muted)" }}>
              Enter to send • Shift+Enter for new line
            </span>

            <button
              type="submit"
              className="btn-primary-indigo b2b-chat-send-btn"
              disabled={
                !nlPrompt.trim() || isBusy || workflowStatus === "executing"
              }
              title="Run AI Instruction"
            >
              {workflowStatus === "executing" ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <Send size={14} />
              )}
              <span>Send</span>
            </button>
          </div>
        </div>
      </form>
    </aside>
  );
}
