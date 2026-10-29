import React, { useEffect } from "react";
import { useDispatch, useSelector } from "react-redux";
import { motion } from "framer-motion";
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
  RefreshCw,
  Loader2,
  Edit3,
  AlertTriangle,
} from "lucide-react";
import {
  loadSheetRows,
  runSheetQuery,
  previewSheetMutation,
  applySheetMutation,
  importSheetCsvFile,
  setSheetNlPrompt,
  clearSheetFiltersAndFeedback,
  discardMutationPreview,
} from "../store/sheetSlice";

const PRODUCT_COLUMNS = [
  "name",
  "category",
  "price",
  "discount",
  "best",
  "ordered",
  "color",
  "size",
  "description",
  "images",
];

const SAMPLE_PROMPTS = [
  {
    type: "query",
    label: "Best-selling products",
    text: "Show all best-selling products.",
  },
  {
    type: "query",
    label: "Black shirts under 1500",
    text: "Find products available in Black with price below 1500.",
  },
  {
    type: "query",
    label: "Products with orders > 0",
    text: "List products with ordered count greater than 0.",
  },
  {
    type: "query",
    label: "Luxury shirts",
    text: "Show products in the luxury shirt category.",
  },
  {
    type: "mutation",
    label: "Set OpenWeave Shirt price to 1450",
    text: "Change the price of OpenWeave Shirt to 1450.",
  },
  {
    type: "mutation",
    label: "Set Palm Breeze Shirt discount to 35%",
    text: "Set the discount of Palm Breeze Shirt to 35.",
  },
];

function looksLikeMutationInstruction(text) {
  const lower = String(text || "")
    .trim()
    .toLowerCase();
  return /^(?:change|update|set|modify|increase|decrease|mark|make|delete|remove)\b|\b(?:change\s+the|update\s+the|set\s+the)\b/.test(
    lower,
  );
}

function formatCellValue(col, value) {
  if (value === null || value === undefined || value === "") {
    return "—";
  }
  if (col === "price") {
    const num = Number(value);
    return Number.isFinite(num) ? `${num}` : String(value);
  }
  if (col === "discount") {
    const num = Number(value);
    return Number.isFinite(num) ? `${num}%` : String(value);
  }
  if (col === "best") {
    return value === true || String(value).toLowerCase() === "true"
      ? "True"
      : "False";
  }
  if (col === "size") {
    const raw = String(value);
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        return Object.entries(parsed)
          .map(([k, v]) => `${k}: ${v}`)
          .join(", ");
      }
    } catch {
      // Fall through
    }
    return raw;
  }
  if (col === "description") {
    const str = String(value).replace(/\s+/g, " ").trim();
    return str.length > 90 ? `${str.slice(0, 90)}...` : str;
  }
  if (col === "images") {
    const urls = String(value)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (urls.length === 0) return "—";
    return `${urls.length} image(s)`;
  }
  return String(value);
}

export default function SheetManagementPanel() {
  const dispatch = useDispatch();
  const {
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
    csvUploadStatus,
    csvUploadMessage,
    csvUploadError,
  } = useSelector((state) => state.sheets);

  // Load products sheet on mount
  useEffect(() => {
    dispatch(loadSheetRows("products"));
  }, [dispatch]);

  const activeRows = rowsByEntity.products || [];

  const matchedIdsSet = new Set(
    Array.isArray(queryResult?.matchedIds) ? queryResult.matchedIds : [],
  );
  const hasActiveQueryFilter = Boolean(queryResult);

  // Run Natural-Language Query
  const handleRunQuery = async (customText) => {
    const text = (
      typeof customText === "string" ? customText : nlPrompt
    ).trim();
    if (!text || queryStatus === "loading") return;

    await dispatch(
      runSheetQuery({
        entity: "products",
        message: text,
      }),
    );
  };

  // Run Stage 1 Mutation Preview (confirm: false)
  const handleRunMutationPreview = async (customText) => {
    const text = (
      typeof customText === "string" ? customText : nlPrompt
    ).trim();
    if (!text || mutationPreviewStatus === "loading") return;

    await dispatch(
      previewSheetMutation({
        entity: "products",
        message: text,
      }),
    );
  };

  // Unified form submit (auto-detects query vs mutation intent)
  const handlePrimaryPromptSubmit = async (e) => {
    e.preventDefault();
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
      mutationPreview.status !== "preview" ||
      mutationApplyStatus === "loading"
    ) {
      return;
    }

    const messageToConfirm = mutationPreview.promptUsed || nlPrompt.trim();
    await dispatch(
      applySheetMutation({
        entity: "products",
        message: messageToConfirm,
      }),
    );
  };

  // CSV Upload Handler
  const handleCsvFileUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    await dispatch(
      importSheetCsvFile({
        entity: "products",
        file,
      }),
    );
    e.target.value = "";
  };

  const isBusy =
    sheetLoadStatus === "loading" ||
    queryStatus === "loading" ||
    mutationPreviewStatus === "loading" ||
    mutationApplyStatus === "loading";

  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2 }}
      style={{
        maxWidth: "1600px",
        width: "100%",
        margin: "0 auto",
        padding: "16px 24px 28px 24px",
        display: "grid",
        gridTemplateColumns: "minmax(0, 2.2fr) minmax(350px, 1fr)",
        gap: "16px",
      }}
    >
      {/* Left Main Card: Live Products Spreadsheet Area */}
      <div
        className="portal-card"
        style={{ padding: 0, overflow: "hidden", gap: 0 }}
      >
        <div className="inquiry-card-header">
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "10px",
              flexWrap: "wrap",
            }}
          >
            <FileSpreadsheet size={18} color="var(--primary-indigo)" />
            <span className="inquiry-card-title">
              Product Catalog Sheet (products.csv)
            </span>
          </div>

          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "8px",
              flexWrap: "wrap",
            }}
          >
            <label
              className="btn-warm-outlined"
              style={{
                cursor: "pointer",
                fontSize: "12.5px",
                padding: "6px 12px",
              }}
              title="Upload a products.csv file to replace the product catalog"
            >
              <Upload size={14} />
              {csvUploadStatus === "loading"
                ? "Uploading..."
                : "Upload products.csv"}
              <input
                type="file"
                accept=".csv"
                disabled={csvUploadStatus === "loading"}
                onChange={handleCsvFileUpload}
                style={{ display: "none" }}
              />
            </label>

            <button
              type="button"
              className="icon-action-btn"
              disabled={sheetLoadStatus === "loading"}
              onClick={() => dispatch(loadSheetRows("products"))}
              title="Refresh products sheet from database"
            >
              <RefreshCw
                size={15}
                className={sheetLoadStatus === "loading" ? "spin" : ""}
              />
            </button>
          </div>
        </div>

        <div
          style={{
            padding: "18px 20px",
            display: "flex",
            flexDirection: "column",
            gap: "14px",
          }}
        >
          {/* Sheet Header Info */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              flexWrap: "wrap",
              gap: "12px",
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: "10px",
                flexWrap: "wrap",
              }}
            >
              <span style={{ fontWeight: 600, fontSize: "13px" }}>
                Active Sheet:
              </span>
              <span
                className="target-toggle-btn active"
                style={{ cursor: "default" }}
              >
                📦 Products ({activeRows.length})
              </span>
            </div>

            {hasActiveQueryFilter && (
              <button
                type="button"
                className="btn-warm-outlined"
                style={{ fontSize: "12px", padding: "4px 10px" }}
                onClick={() => dispatch(clearSheetFiltersAndFeedback())}
              >
                <RotateCcw size={13} />
                Clear Row Highlights ({matchedIdsSet.size} matched)
              </button>
            )}
          </div>

          {/* Status & Feedback Banners */}
          {sheetLoadError && (
            <div className="alert-banner error">
              <AlertCircle size={16} style={{ flexShrink: 0 }} />
              <span>{sheetLoadError}</span>
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

          {mutationApplySuccessMessage && (
            <div className="alert-banner success">
              <CheckCircle2 size={16} style={{ flexShrink: 0 }} />
              <span>{mutationApplySuccessMessage}</span>
            </div>
          )}

          {/* Query / Match Status Bar */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              flexWrap: "wrap",
              gap: "8px",
              padding: "10px 14px",
              backgroundColor:
                queryResult?.status === "clarification_needed"
                  ? "#fffbeb"
                  : queryResult && queryResult.count === 0
                    ? "#fef2f2"
                    : "var(--bg-subtle-warm)",
              borderRadius: "8px",
              border:
                queryResult?.status === "clarification_needed"
                  ? "1px solid #f59e0b"
                  : queryResult && queryResult.count === 0
                    ? "1px solid #fecaca"
                    : "1px solid var(--border-warm)",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <SlidersHorizontal size={15} color="var(--primary-indigo)" />
              <span style={{ fontWeight: 600, fontSize: "13px" }}>
                {!queryResult
                  ? `Showing all ${activeRows.length} product record(s) from database.`
                  : queryResult.status === "clarification_needed"
                    ? `Clarification Needed: ${queryResult.message}`
                    : queryResult.count === 0
                      ? `0 records matched "${queryResult.promptUsed}". Full sheet remains visible below.`
                      : `Highlighted ${queryResult.count} matching record(s) for "${queryResult.promptUsed}".`}
              </span>
            </div>
            <span
              style={{
                fontSize: "12px",
                color: "var(--text-secondary)",
                fontWeight: 600,
              }}
            >
              {queryResult
                ? `Matched: ${matchedIdsSet.size} of ${activeRows.length} rows`
                : `Total Rows: ${activeRows.length}`}
            </span>
          </div>

          {/* Spreadsheet Table */}
          <div className="sheet-table-wrap">
            {sheetLoadStatus === "loading" && activeRows.length === 0 ? (
              <div
                style={{
                  padding: "48px 20px",
                  textAlign: "center",
                  color: "var(--text-secondary)",
                  fontSize: "13.5px",
                }}
              >
                <Loader2
                  size={22}
                  className="spin"
                  style={{ margin: "0 auto 8px auto" }}
                />
                <div>Loading product records from PostgreSQL...</div>
              </div>
            ) : activeRows.length === 0 ? (
              <div
                style={{
                  padding: "48px 20px",
                  textAlign: "center",
                  color: "var(--text-secondary)",
                  fontSize: "13.5px",
                }}
              >
                No product records found for this business. Click{" "}
                <strong>Upload products.csv</strong> above to import your
                catalog.
              </div>
            ) : (
              <table className="sheet-table">
                <thead>
                  <tr>
                    <th style={{ width: "54px" }}>#</th>
                    {PRODUCT_COLUMNS.map((col) => (
                      <th key={col}>{col.replace(/_/g, " ")}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {activeRows.map((row, idx) => {
                    const isHighlighted = matchedIdsSet.has(row.id);
                    return (
                      <tr
                        key={row.id || idx}
                        className={isHighlighted ? "highlighted-row" : ""}
                      >
                        <td style={{ fontWeight: 700, whiteSpace: "nowrap" }}>
                          <span>{idx + 1}</span>
                          {isHighlighted && (
                            <span
                              style={{
                                marginLeft: "6px",
                                display: "inline-block",
                                padding: "1px 6px",
                                borderRadius: "999px",
                                backgroundColor: "var(--primary-indigo)",
                                color: "#ffffff",
                                fontSize: "9.5px",
                                fontWeight: 700,
                              }}
                            >
                              MATCH
                            </span>
                          )}
                        </td>
                        {PRODUCT_COLUMNS.map((col) => (
                          <td
                            key={col}
                            title={
                              row[col] !== null && row[col] !== undefined
                                ? String(row[col])
                                : ""
                            }
                          >
                            {formatCellValue(col, row[col])}
                          </td>
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
            <span>AI Workspace</span>
          </div>
          <span
            style={{
              fontSize: "10.5px",
              fontWeight: 700,
              color: "var(--primary-indigo)",
              backgroundColor: "var(--accent-lavender-bg)",
              padding: "2px 8px",
              borderRadius: "999px",
            }}
          >
            PRODUCTS
          </span>
        </div>

        <form
          onSubmit={handlePrimaryPromptSubmit}
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "10px",
          }}
        >
          <label
            className="copilot-field-label"
            htmlFor="sheet-nl-prompt-input"
          >
            Natural-Language Query or Mutation Instruction
          </label>
          <textarea
            id="sheet-nl-prompt-input"
            className="announcement-prompt-textarea"
            value={nlPrompt}
            onChange={(e) => dispatch(setSheetNlPrompt(e.target.value))}
            disabled={isBusy}
            placeholder='e.g. "Show all best-selling products." or "Change the price of OpenWeave Shirt to 1450."'
          />

          <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
            <button
              type="button"
              className="btn-primary-indigo"
              style={{ flex: 1, minWidth: "140px", padding: "9px 12px" }}
              disabled={!nlPrompt.trim() || isBusy}
              onClick={() => handleRunQuery(nlPrompt)}
            >
              {queryStatus === "loading" ? (
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
                minWidth: "150px",
                padding: "9px 12px",
                borderColor: "#d97706",
                color: "#92400e",
                fontWeight: 700,
              }}
              disabled={!nlPrompt.trim() || isBusy}
              onClick={() => handleRunMutationPreview(nlPrompt)}
            >
              {mutationPreviewStatus === "loading" ? (
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
          <div className="alert-banner error" style={{ fontSize: "12px" }}>
            <AlertCircle size={15} style={{ flexShrink: 0 }} />
            <span>{queryError}</span>
          </div>
        )}

        {mutationPreviewError && (
          <div className="alert-banner error" style={{ fontSize: "12px" }}>
            <AlertCircle size={15} style={{ flexShrink: 0 }} />
            <span>{mutationPreviewError}</span>
          </div>
        )}

        {/* Quick Sample Prompts */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "7px",
          }}
        >
          <span
            style={{
              fontSize: "12px",
              fontWeight: 600,
              color: "var(--text-secondary)",
            }}
          >
            Quick Sample Prompts (products.csv):
          </span>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "6px" }}>
            {SAMPLE_PROMPTS.map((sample) => (
              <button
                key={sample.text}
                type="button"
                className="btn-warm-outlined"
                style={{
                  fontSize: "11.5px",
                  padding: "4px 9px",
                  textAlign: "left",
                  borderColor:
                    sample.type === "mutation"
                      ? "#fcd34d"
                      : "var(--border-warm-strong)",
                }}
                disabled={isBusy}
                onClick={() => {
                  dispatch(setSheetNlPrompt(sample.text));
                  if (sample.type === "mutation") {
                    handleRunMutationPreview(sample.text);
                  } else {
                    handleRunQuery(sample.text);
                  }
                }}
              >
                {sample.type === "mutation" ? "✏️ " : "🔍 "}
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
                fontSize: "10.5px",
                fontWeight: 700,
                color: "var(--status-warning)",
              }}
            >
              STAGE 1 PREVIEW → STAGE 2 CONFIRM
            </span>
          </div>

          {mutationPreview &&
          mutationPreview.status === "clarification_needed" ? (
            <div
              className="alert-banner warning"
              style={{
                flexDirection: "column",
                alignItems: "flex-start",
                gap: "6px",
                fontSize: "12px",
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "6px",
                  fontWeight: 700,
                }}
              >
                <AlertTriangle size={15} />
                <span>Clarification Needed Before Modifying</span>
              </div>
              <div>{mutationPreview.message}</div>
            </div>
          ) : mutationPreview &&
            (mutationPreview.status === "no_match" ||
              mutationPreview.status === "not_found") ? (
            <div className="alert-banner warning" style={{ fontSize: "12px" }}>
              <AlertCircle size={15} style={{ flexShrink: 0 }} />
              <span>
                {mutationPreview.message ||
                  "No matching records found for the requested modification."}
              </span>
            </div>
          ) : mutationPreview && mutationPreview.status === "preview" ? (
            <div
              className="ai-suggestion-box"
              style={{
                backgroundColor: "#fffbeb",
                borderColor: "#f59e0b",
                gap: "10px",
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                }}
              >
                <span
                  style={{
                    fontSize: "12.5px",
                    fontWeight: 700,
                    color: "#92400e",
                  }}
                >
                  Stage 1 Preview ({mutationPreview.operation?.toUpperCase()})
                </span>
                <span
                  style={{
                    fontSize: "11px",
                    fontWeight: 700,
                    padding: "2px 8px",
                    borderRadius: "999px",
                    backgroundColor: "#fef3c7",
                    color: "#b45309",
                  }}
                >
                  {mutationPreview.affected_count} Row(s) Affected
                </span>
              </div>

              <div style={{ fontSize: "12px", color: "var(--text-secondary)" }}>
                {mutationPreview.message}
              </div>

              {/* Proposed Before/After Diff Per Row */}
              {Array.isArray(mutationPreview.diff) &&
                mutationPreview.diff.length > 0 && (
                  <div
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      gap: "6px",
                      maxHeight: "190px",
                      overflowY: "auto",
                    }}
                  >
                    {mutationPreview.diff.map((rowDiff, i) => {
                      const changedFields = Object.keys(
                        mutationPreview.proposed_changes || {},
                      );
                      return (
                        <div
                          key={rowDiff.id || i}
                          style={{
                            padding: "8px 10px",
                            backgroundColor: "#ffffff",
                            borderRadius: "6px",
                            border: "1px solid #fde68a",
                            fontSize: "12px",
                          }}
                        >
                          <div style={{ fontWeight: 700, marginBottom: "4px" }}>
                            {rowDiff.name}
                          </div>
                          {changedFields.map((field) => {
                            const beforeVal =
                              rowDiff.before?.[field] ??
                              rowDiff.changes?.[field]?.current;
                            const afterVal =
                              rowDiff.after?.[field] ??
                              rowDiff.changes?.[field]?.proposed;
                            return (
                              <div
                                key={field}
                                style={{
                                  display: "flex",
                                  alignItems: "center",
                                  gap: "8px",
                                  flexWrap: "wrap",
                                }}
                              >
                                <span style={{ fontWeight: 600 }}>{field}:</span>
                                <del style={{ color: "#dc2626" }}>
                                  {formatCellValue(field, beforeVal)}
                                </del>
                                <ArrowRight size={13} />
                                <strong style={{ color: "#16a34a" }}>
                                  {formatCellValue(field, afterVal)}
                                </strong>
                              </div>
                            );
                          })}
                        </div>
                      );
                    })}
                  </div>
                )}

              {mutationApplyError && (
                <div
                  className="alert-banner error"
                  style={{ fontSize: "12px" }}
                >
                  <AlertCircle size={14} style={{ flexShrink: 0 }} />
                  <span>{mutationApplyError}</span>
                </div>
              )}

              <div style={{ display: "flex", gap: "8px" }}>
                <button
                  type="button"
                  className="btn-primary-indigo"
                  style={{ flex: 1 }}
                  disabled={mutationApplyStatus === "loading"}
                  onClick={handleConfirmMutation}
                >
                  {mutationApplyStatus === "loading" ? (
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
                  disabled={mutationApplyStatus === "loading"}
                  onClick={() => dispatch(discardMutationPreview())}
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <div className="announcement-preview-box">
              Enter a modification instruction above and click{" "}
              <strong>Preview Mutation</strong> (e.g.,{" "}
              <em>
                &ldquo;Change the price of OpenWeave Shirt to 1450.&rdquo;
              </em>
              ) to inspect exact before/after changes prior to database
              confirmation.
            </div>
          )}
        </div>
      </div>
    </motion.div>
  );
}
