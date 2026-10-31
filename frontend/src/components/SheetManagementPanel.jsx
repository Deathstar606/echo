import React, { useEffect, useState, useMemo } from "react";
import { useDispatch, useSelector } from "react-redux";
import { motion, AnimatePresence } from "framer-motion";
import {
  FileSpreadsheet,
  Upload,
  PlusCircle,
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
  Info,
  X,
} from "lucide-react";
import {
  loadSheetRows,
  runSheetQuery,
  previewSheetMutation,
  applySheetMutation,
  importSheetCsvFile,
  appendSheetCsvFile,
  insertSingleSheetRow,
  setSheetNlPrompt,
  clearSheetFiltersAndFeedback,
  discardMutationPreview,
  clearRowInsertState,
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

const BASE_SAMPLE_PROMPTS = [
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
    label: "Increase summer shirts discount by 5%",
    text: "Increase the discount of all summer shirts by 5%.",
  },
  {
    type: "mutation",
    label: "Reduce price by 200 where discount >= 25%",
    text: "Reduce the price of products with a discount of 25% or more by 200.",
  },
];

const ELECTRONICS_SAMPLE_PROMPTS = [
  {
    type: "query",
    label: "Laptops in Dhaka warehouse",
    text: "Show all products in warehouse Dhaka.",
  },
  {
    type: "query",
    label: "Dell laptops < 1500",
    text: "Find Dell laptops with Current_Price below 1500.",
  },
  {
    type: "query",
    label: "Low stock items",
    text: "Show products with Stock_Qty below 10.",
  },
  {
    type: "mutation",
    label: "Increase Dell laptops price by $50",
    text: "Increase the Current_Price of Dell laptops by $50.",
  },
  {
    type: "mutation",
    label: "Increase stock of Asus ROG by 5",
    text: "Increase the Stock_Qty of Asus ROG Strix G16 by 5.",
  },
];

const GROCERY_SAMPLE_PROMPTS = [
  {
    type: "query",
    label: "Products from Acme",
    text: "Show all products from supplier Acme.",
  },
  {
    type: "query",
    label: "Items in Dhaka warehouse",
    text: "List items in warehouse Dhaka.",
  },
  {
    type: "mutation",
    label: "Reduce NorthStar cost by 5%",
    text: "Reduce the unit cost of products from supplier NorthStar by 5%.",
  },
  {
    type: "mutation",
    label: "Increase Dhaka quantity by 15",
    text: "Increase the quantity of products in warehouse Dhaka by 15 units.",
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
  const lowerCol = String(col).toLowerCase();

  if (typeof value === "boolean" || lowerCol === "best") {
    return value === true || String(value).toLowerCase() === "true"
      ? "True"
      : "False";
  }

  if (
    lowerCol.includes("price") ||
    lowerCol.includes("cost") ||
    lowerCol.includes("rate")
  ) {
    const num = Number(value);
    return Number.isFinite(num) ? `${num}` : String(value);
  }

  if (
    lowerCol.includes("discount") ||
    lowerCol.includes("percentage") ||
    lowerCol.includes("pct")
  ) {
    const num = Number(value);
    return Number.isFinite(num) ? `${num}%` : String(value);
  }

  if (
    lowerCol.includes("qty") ||
    lowerCol.includes("quantity") ||
    lowerCol.includes("level") ||
    lowerCol.includes("ordered") ||
    lowerCol.includes("months")
  ) {
    const num = Number(value);
    return Number.isFinite(num) ? `${num}` : String(value);
  }

  if (lowerCol.includes("date") || lowerCol.includes("time")) {
    const d = String(value).slice(0, 10);
    return d || String(value);
  }

  if (lowerCol === "size") {
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

  if (lowerCol.includes("desc")) {
    const str = String(value).replace(/\s+/g, " ").trim();
    return str.length > 90 ? `${str.slice(0, 90)}...` : str;
  }

  if (lowerCol.includes("image")) {
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
  const [clientAppendError, setClientAppendError] = useState(null);

  const {
    activeEntity = "products",
    activeDisplayName = "Products",
    activeFileName = "products.csv",
    activeColumns = [],
    rowsByEntity = {},
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
    csvAppendStatus,
    csvAppendMessage,
    csvAppendError,
    rowInsertStatus,
    rowInsertMessage,
    rowInsertError,
  } = useSelector((state) => state.sheets);

  const [isAddRowModalOpen, setIsAddRowModalOpen] = useState(false);
  const [newRowData, setNewRowData] = useState({});
  const [addRowError, setAddRowError] = useState(null);
  const [addRowSuccessToast, setAddRowSuccessToast] = useState(null);

  // Load active sheet on mount
  useEffect(() => {
    dispatch(loadSheetRows(activeEntity));
  }, [dispatch, activeEntity]);

  const activeRows = rowsByEntity[activeEntity] || [];

  // Determine dynamic table columns from the active sheet
  const displayedColumns = useMemo(() => {
    if (Array.isArray(activeColumns) && activeColumns.length > 0) {
      return activeColumns;
    }
    if (activeRows.length > 0) {
      const keys = Object.keys(activeRows[0]).filter(
        (k) =>
          !["id", "business_id", "created_at", "updated_at"].includes(
            k.toLowerCase(),
          ),
      );
      if (keys.length > 0) return keys;
    }
    if (activeEntity === "electronics_inventory") {
      return [
        "Product_Name",
        "Brand_Name",
        "Model",
        "Current_Price",
        "Stock_Qty",
        "Warehouse",
        "Reorder_Level",
        "Warranty_Months",
      ];
    }
    if (activeEntity === "grocery_inventory") {
      return [
        "Item_Name",
        "Supplier",
        "Unit_Cost",
        "Selling_Price",
        "Expiry_Date",
        "Batch_No",
        "Quantity",
        "Warehouse_Location",
        "Stock",
      ];
    }
    return PRODUCT_COLUMNS;
  }, [activeRows, activeColumns, activeEntity]);

  // Dynamic sample prompts according to active entity
  const samplePrompts = useMemo(() => {
    let base = BASE_SAMPLE_PROMPTS;
    if (activeEntity === "electronics_inventory") {
      base = ELECTRONICS_SAMPLE_PROMPTS;
    } else if (activeEntity === "grocery_inventory") {
      base = GROCERY_SAMPLE_PROMPTS;
    }

    if (activeRows.length > 0) {
      const first = activeRows[0];
      const itemName = first.name || first.Product_Name || first.Item_Name;
      if (itemName) {
        if (first.size) {
          return [
            ...base,
            {
              type: "mutation",
              label: `Increase ${itemName} (XL & M) stock by 2`,
              text: `Increase stock of product ${itemName} for sizes XL and M by 2.`,
            },
          ];
        }
        if (first.Current_Price !== undefined) {
          return [
            ...base,
            {
              type: "mutation",
              label: `Increase price of ${itemName} by 20`,
              text: `Increase the Current_Price of ${itemName} by 20.`,
            },
          ];
        }
        if (first.Selling_Price !== undefined) {
          return [
            ...base,
            {
              type: "mutation",
              label: `Increase price of ${itemName} by 10`,
              text: `Increase the Selling_Price of ${itemName} by 10.`,
            },
          ];
        }
      }
    }
    return base;
  }, [activeEntity, activeRows]);

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
        entity: activeEntity,
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
        entity: activeEntity,
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
        entity: activeEntity,
        message: messageToConfirm,
      }),
    );
  };

  // "Upload CSV" (Replaces sheet records or loads a new sheet structure)
  const handleCsvFileUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setClientAppendError(null);

    await dispatch(
      importSheetCsvFile({
        entity: activeEntity,
        file,
      }),
    );
    e.target.value = "";
  };

  // "Add Rows" (Appends new rows to existing active CSV sheet with strict column validation)
  const handleAppendRowsUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setClientAppendError(null);

    // Client-side pre-validation: check that new rows have the same columns as active sheet
    try {
      const text = await file.slice(0, 4096).text();
      const firstLine = text.split(/\r?\n/)[0] || "";
      const uploadedHeaders = firstLine
        .split(",")
        .map((h) => h.replace(/^["']|["']$/g, "").trim().toLowerCase())
        .filter(Boolean);

      const missingCols = displayedColumns.filter(
        (col) => !uploadedHeaders.includes(col.toLowerCase()),
      );

      if (missingCols.length > 0) {
        setClientAppendError(
          `Invalid CSV headers for append. Uploaded row columns do not match active sheet (${activeDisplayName || activeEntity}). Missing column(s): ${missingCols.join(
            ", ",
          )}. Expected columns: ${displayedColumns.join(", ")}.`,
        );
        e.target.value = "";
        return;
      }
    } catch {
      // If client-side slice fails, continue to server-side validation
    }

    await dispatch(
      appendSheetCsvFile({
        entity: activeEntity,
        file,
      }),
    );
    e.target.value = "";
  };

  const handleOpenAddRowModal = () => {
    const initialValues = {};
    for (const col of displayedColumns) {
      initialValues[col] = col.toLowerCase() === "best" ? "false" : "";
    }
    setNewRowData(initialValues);
    setAddRowError(null);
    dispatch(clearRowInsertState());
    setIsAddRowModalOpen(true);
  };

  const handleRowFieldChange = (col, value) => {
    setNewRowData((prev) => ({
      ...prev,
      [col]: value,
    }));
  };

  const handleAddRowSubmit = async (e) => {
    e.preventDefault();
    setAddRowError(null);

    const hasValues = Object.entries(newRowData).some(
      ([_, val]) => String(val ?? "").trim() !== "",
    );
    if (!hasValues) {
      setAddRowError("Please enter at least one column value.");
      return;
    }

    try {
      const res = await dispatch(
        insertSingleSheetRow({ entity: activeEntity, row: newRowData }),
      ).unwrap();
      setIsAddRowModalOpen(false);
      setAddRowSuccessToast(res?.message || "Row added successfully.");
      setTimeout(() => setAddRowSuccessToast(null), 4000);
    } catch (err) {
      setAddRowError(err?.message || "Failed to add row to active sheet.");
    }
  };

  const isBusy =
    sheetLoadStatus === "loading" ||
    queryStatus === "loading" ||
    mutationPreviewStatus === "loading" ||
    mutationApplyStatus === "loading" ||
    csvUploadStatus === "loading" ||
    csvAppendStatus === "loading" ||
    rowInsertStatus === "loading";

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
      {/* Left Main Card: Live Universal Spreadsheet Area */}
      <div
        className="portal-card"
        style={{ padding: 0, overflow: "hidden", gap: 0 }}
      >
        <div className="inquiry-card-header">
          <div
            className="liquid-glass-pill"
            style={{
              padding: "4px 10px",
              borderRadius: "8px",
              gap: "8px",
            }}
          >
            <FileSpreadsheet size={16} color="var(--primary-indigo)" />
            <span className="inquiry-card-title" style={{ fontSize: "13.5px" }}>
              {activeFileName || `${activeEntity}.csv`}
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
            {/* Upload CSV Button */}
            <label
              className="btn-warm-outlined"
              style={{
                cursor: "pointer",
                fontSize: "12.5px",
                padding: "6px 12px",
              }}
              title="Upload a CSV file to replace records or switch active sheet"
            >
              <Upload size={14} />
              {csvUploadStatus === "loading" ? "Uploading..." : "Upload CSV"}
              <input
                type="file"
                accept=".csv"
                disabled={isBusy}
                onChange={handleCsvFileUpload}
                style={{ display: "none" }}
              />
            </label>

            {/* Add Row Button (Dynamic columns for current active table) */}
            <button
              type="button"
              className="btn-warm-outlined"
              style={{
                cursor: "pointer",
                fontSize: "12.5px",
                padding: "6px 12px",
                borderColor: "var(--primary-indigo)",
                color: "var(--primary-indigo)",
                fontWeight: 600,
              }}
              disabled={isBusy}
              onClick={handleOpenAddRowModal}
              title={`Add a new row with dynamic columns to the active sheet (${activeDisplayName || activeEntity})`}
            >
              <PlusCircle size={14} />
              Add Row
            </button>

            {/* Refresh Sheet */}
            <button
              type="button"
              className="icon-action-btn"
              disabled={sheetLoadStatus === "loading"}
              onClick={() => dispatch(loadSheetRows(activeEntity))}
              title={`Refresh ${activeDisplayName || activeEntity} sheet from database`}
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
          {/* Clear Row Highlights when active filter is applied */}
          {hasActiveQueryFilter && (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "flex-end",
              }}
            >
              <button
                type="button"
                className="btn-warm-outlined"
                style={{ fontSize: "12px", padding: "4px 10px" }}
                onClick={() => dispatch(clearSheetFiltersAndFeedback())}
              >
                <RotateCcw size={13} />
                Clear Row Highlights ({matchedIdsSet.size} matched)
              </button>
            </div>
          )}

          {/* Status & Feedback Banners */}
          {sheetLoadError && (
            <div className="alert-banner error">
              <AlertCircle size={16} style={{ flexShrink: 0 }} />
              <span>{sheetLoadError}</span>
            </div>
          )}

          {clientAppendError && (
            <div className="alert-banner error">
              <AlertCircle size={16} style={{ flexShrink: 0 }} />
              <span>{clientAppendError}</span>
            </div>
          )}

          {csvUploadError && (
            <div className="alert-banner error">
              <AlertCircle size={16} style={{ flexShrink: 0 }} />
              <span>{csvUploadError}</span>
            </div>
          )}

          {csvAppendError && (
            <div className="alert-banner error">
              <AlertCircle size={16} style={{ flexShrink: 0 }} />
              <span>{csvAppendError}</span>
            </div>
          )}

          {csvUploadMessage && (
            <div className="alert-banner success">
              <CheckCircle2 size={16} style={{ flexShrink: 0 }} />
              <span>{csvUploadMessage}</span>
            </div>
          )}

          {csvAppendMessage && (
            <div className="alert-banner success">
              <CheckCircle2 size={16} style={{ flexShrink: 0 }} />
              <span>{csvAppendMessage}</span>
            </div>
          )}

          {mutationApplySuccessMessage && (
            <div className="alert-banner success">
              <CheckCircle2 size={16} style={{ flexShrink: 0 }} />
              <span>{mutationApplySuccessMessage}</span>
            </div>
          )}

          {addRowSuccessToast && (
            <div className="alert-banner success">
              <CheckCircle2 size={16} style={{ flexShrink: 0 }} />
              <span>{addRowSuccessToast}</span>
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
                  ? `Showing all ${activeRows.length} record(s) from ${activeDisplayName || activeEntity}.`
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

          {/* Universal Spreadsheet Table */}
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
                <div>Loading {activeDisplayName || activeEntity} records...</div>
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
                No records found in {activeDisplayName || activeEntity}. Click{" "}
                <strong>Upload CSV</strong> above to import your sheet.
              </div>
            ) : (
              <table className="sheet-table">
                <thead>
                  <tr>
                    <th style={{ width: "54px" }}>#</th>
                    {displayedColumns.map((col) => (
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
                        {displayedColumns.map((col) => (
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
            placeholder={
              activeEntity === "electronics_inventory"
                ? 'e.g. "Show laptops in warehouse Dhaka." or "Increase Current_Price of Dell laptops by $50."'
                : activeEntity === "grocery_inventory"
                  ? 'e.g. "Show items from supplier Acme." or "Reduce Unit_Cost of NorthStar products by 5%."'
                  : 'e.g. "Show all best-selling products." or "Increase the discount of all summer shirts by 5%."'
            }
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
            Quick Sample Suggestions:
          </span>

          {/* User Notice: Suggestions are only for base products.csv */}
          <div
            style={{
              display: "flex",
              alignItems: "flex-start",
              gap: "6px",
              padding: "7px 10px",
              backgroundColor: "rgba(217, 119, 6, 0.08)",
              border: "1px solid rgba(217, 119, 6, 0.28)",
              borderRadius: "6px",
              fontSize: "11.5px",
              color: "#92400e",
              lineHeight: 1.4,
            }}
          >
            <Info size={13} style={{ flexShrink: 0, marginTop: "2px" }} />
            <span>
              <strong>Notice:</strong> These sample suggestions and queries are only for the base <code>products.csv</code> catalog.
            </span>
          </div>

          <div style={{ display: "flex", flexWrap: "wrap", gap: "6px" }}>
            {samplePrompts.map((sample) => (
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
                      const displayTitle =
                        rowDiff.name ||
                        rowDiff.Product_Name ||
                        rowDiff.Item_Name ||
                        rowDiff.id ||
                        `Row ${i + 1}`;
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
                            {displayTitle}
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
                &ldquo;Increase the discount of all summer shirts by 5%.&rdquo;
              </em>
              ) to inspect exact before/after changes prior to database
              confirmation.
            </div>
          )}
        </div>
      </div>

      {/* Dynamic Add Row Modal for Current Active Table */}
      <AnimatePresence>
        {isAddRowModalOpen && (
          <motion.div
            className="modal-backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2, ease: "easeOut" }}
            onClick={() => setIsAddRowModalOpen(false)}
          >
            <motion.div
              className="modal-card liquid-glass-modal"
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 8 }}
              transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
              onClick={(e) => e.stopPropagation()}
              style={{
                maxWidth: "560px",
                maxHeight: "88vh",
                display: "flex",
                flexDirection: "column",
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  marginBottom: "4px",
                }}
              >
                <div
                  style={{ display: "flex", alignItems: "center", gap: "8px" }}
                >
                  <div
                    className="brand-logo-box"
                    style={{ width: 28, height: 28, fontSize: 14 }}
                  >
                    +
                  </div>
                  <div>
                    <h3
                      style={{ fontSize: "15.5px", fontWeight: 700, margin: 0 }}
                    >
                      Add New Row
                    </h3>
                    <span
                      style={{
                        fontSize: "11.5px",
                        color: "var(--text-secondary)",
                      }}
                    >
                      Active Table:{" "}
                      <strong>{activeDisplayName || activeEntity}</strong> (
                      {activeFileName || `${activeEntity}.csv`})
                    </span>
                  </div>
                </div>
                <button
                  type="button"
                  className="icon-action-btn"
                  onClick={() => setIsAddRowModalOpen(false)}
                  aria-label="Close modal"
                >
                  <X size={17} />
                </button>
              </div>

              <p
                style={{
                  fontSize: "12px",
                  color: "var(--text-secondary)",
                  margin: "0 0 10px 0",
                  lineHeight: 1.4,
                }}
              >
                Enter column information for the current active table. Column
                fields are dynamically loaded based on the schema of{" "}
                <code>{activeDisplayName || activeEntity}</code>.
              </p>

              {addRowError && (
                <div
                  className="alert-banner error"
                  style={{ fontSize: "12px", padding: "8px 12px" }}
                >
                  <AlertCircle size={14} style={{ flexShrink: 0 }} />
                  <span>{addRowError}</span>
                </div>
              )}

              <form
                onSubmit={handleAddRowSubmit}
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: "12px",
                  overflowY: "auto",
                  paddingRight: "4px",
                  maxHeight: "calc(88vh - 180px)",
                }}
              >
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
                    gap: "12px",
                  }}
                >
                  {displayedColumns.map((col) => {
                    const lower = col.toLowerCase();
                    const isBoolean =
                      lower === "best" ||
                      lower.endsWith("_bool") ||
                      lower === "stock";
                    const isNumeric =
                      lower.includes("price") ||
                      lower.includes("discount") ||
                      lower.includes("cost") ||
                      lower.includes("ordered") ||
                      lower.includes("qty") ||
                      lower.includes("months") ||
                      lower.includes("warranty");
                    const isLongText = lower === "description";

                    return (
                      <div
                        key={col}
                        style={{
                          display: "flex",
                          flexDirection: "column",
                          gap: "4px",
                          gridColumn: isLongText ? "1 / -1" : "auto",
                        }}
                      >
                        <label
                          style={{
                            fontSize: "12px",
                            fontWeight: 600,
                            color: "var(--text-primary)",
                            textTransform: "capitalize",
                          }}
                        >
                          {col.replace(/_/g, " ")}
                        </label>
                        {isBoolean ? (
                          <select
                            className="form-input"
                            value={newRowData[col] ?? "false"}
                            onChange={(e) =>
                              handleRowFieldChange(col, e.target.value)
                            }
                            style={{ fontSize: "12.5px", padding: "7px 10px" }}
                          >
                            <option value="false">false</option>
                            <option value="true">true</option>
                          </select>
                        ) : isLongText ? (
                          <textarea
                            rows={2}
                            className="form-input"
                            value={newRowData[col] ?? ""}
                            placeholder={`Enter ${col.replace(/_/g, " ")}...`}
                            onChange={(e) =>
                              handleRowFieldChange(col, e.target.value)
                            }
                            style={{
                              fontSize: "12.5px",
                              padding: "7px 10px",
                              resize: "vertical",
                            }}
                          />
                        ) : (
                          <input
                            type={isNumeric ? "number" : "text"}
                            step={isNumeric ? "any" : undefined}
                            className="form-input"
                            value={newRowData[col] ?? ""}
                            placeholder={`Enter ${col.replace(/_/g, " ")}...`}
                            onChange={(e) =>
                              handleRowFieldChange(col, e.target.value)
                            }
                            style={{ fontSize: "12.5px", padding: "7px 10px" }}
                          />
                        )}
                      </div>
                    );
                  })}
                </div>

                <div
                  style={{
                    display: "flex",
                    justifyContent: "flex-end",
                    gap: "8px",
                    marginTop: "8px",
                    paddingTop: "12px",
                    borderTop: "1px solid var(--border-warm)",
                  }}
                >
                  <button
                    type="button"
                    className="btn-warm-outlined"
                    onClick={() => setIsAddRowModalOpen(false)}
                    disabled={rowInsertStatus === "loading"}
                    style={{ fontSize: "12.5px", padding: "7px 14px" }}
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    className="btn-primary-indigo"
                    disabled={rowInsertStatus === "loading"}
                    style={{ fontSize: "12.5px", padding: "7px 16px" }}
                  >
                    {rowInsertStatus === "loading" ? (
                      <>
                        <Loader2 size={13} className="spin" />
                        Adding Row...
                      </>
                    ) : (
                      <>
                        <PlusCircle size={14} />
                        Add Row
                      </>
                    )}
                  </button>
                </div>
              </form>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}
