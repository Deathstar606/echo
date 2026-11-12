import React, { useEffect, useState, useMemo } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { motion, AnimatePresence } from 'framer-motion';
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
  ArrowRightLeft,
  ExternalLink,
  Cloud,
  Link2,
} from 'lucide-react';

import type {
  DynamicSheetRow,
  MutationDiffItem,
  MutationPlan,
  Citation,
  WorkspaceDocument,
  WorkspaceMutationDiff,
  ConversationHistoryTurn,
} from '../../../shared/types/contracts';

import {
  loadBusinessSheets,
  loadSheetRows,
  runSheetQuery,
  previewSheetMutation,
  applySheetMutation,
  importSheetCsvFile,
  appendSheetCsvFile,
  insertSingleSheetRow,
  setSheetNlPrompt,
  applySheetQueryPayload,
  clearSheetFiltersAndFeedback,
  discardMutationPreview,
  clearRowInsertState,
  setActiveSheetEntity,
  resetSheetWorkspaceState,
} from '../store/sheetSlice';

import { getActiveBusinessId, getLoggedInUser } from '../config/constants';

import {
  fetchWorkspaceDocuments,
  uploadWorkspaceDocument,
  seedWorkspaceDemo,
  listGoogleSpreadsheetsApi,
  importGoogleSheetApi,
  getSyncedGoogleSheetsApi,
  getGoogleAuthStatusApi,
  getGoogleAuthUrlApi,
  type GoogleDriveFile,
} from '../services/api';

import KnowledgeSourceBar from './KnowledgeSourceBar';
import SocraticOperationsWorkbench from './SocraticOperationsWorkbench';
import CitationInspectorModal from './CitationInspectorModal';

interface SamplePrompt {
  type: 'query' | 'mutation';
  label: string;
  text: string;
}

interface SheetSliceState {
  businessId?: string | null;
  activeEntity: string;
  activeDisplayName: string;
  activeFileName: string;
  activeColumns: string[];
  availableTables?: Array<{
    entity: string;
    tableName?: string;
    displayName: string;
    fileName?: string;
    columns?: string[];
    rowCount: number;
  }>;
  rowsByEntity: Record<string, DynamicSheetRow[]>;
  sheetLoadStatus: 'idle' | 'loading' | 'succeeded' | 'failed';
  sheetLoadError: string | null;
  nlPrompt: string;
  queryStatus: 'idle' | 'loading' | 'succeeded' | 'failed';
  queryError: string | null;
  queryResult: {
    status?: string;
    count?: number;
    promptUsed?: string;
    matchedIds?: string[];
    message?: string;
    rows?: DynamicSheetRow[];
  } | null;
  mutationPreviewStatus: 'idle' | 'loading' | 'succeeded' | 'failed';
  mutationPreviewError: string | null;
  mutationPreview: {
    status: string;
    message?: string;
    entity?: string;
    operation?: string;
    affected_count?: number;
    preview_hash?: string;
    confirmation_required?: boolean;
    promptUsed?: string;
    approved_mutation?: MutationPlan;
    proposed_changes?: Record<string, unknown>;
    target_rows?: DynamicSheetRow[];
    diff?: MutationDiffItem[];
  } | null;
  mutationApplyStatus: 'idle' | 'loading' | 'succeeded' | 'failed';
  mutationApplyError: string | null;
  mutationApplySuccessMessage: string | null;
  csvUploadStatus: 'idle' | 'loading' | 'succeeded' | 'failed';
  csvUploadMessage: string | null;
  csvUploadError: string | null;
  csvAppendStatus: 'idle' | 'loading' | 'succeeded' | 'failed';
  csvAppendMessage: string | null;
  csvAppendError: string | null;
  rowInsertStatus: 'idle' | 'loading' | 'succeeded' | 'failed';
  rowInsertMessage: string | null;
  rowInsertError: string | null;
}

const PRODUCT_COLUMNS: string[] = [
  'name',
  'category',
  'price',
  'discount',
  'best',
  'ordered',
  'color',
  'size',
  'description',
  'images',
];

const BASE_SAMPLE_PROMPTS: SamplePrompt[] = [
  {
    type: 'query',
    label: 'Best-selling products',
    text: 'Show all best-selling products.',
  },
  {
    type: 'query',
    label: 'Black shirts under 1500',
    text: 'Find products available in Black with price below 1500.',
  },
  {
    type: 'query',
    label: 'Products with orders > 0',
    text: 'List products with ordered count greater than 0.',
  },
  {
    type: 'query',
    label: 'Luxury shirts',
    text: 'Show products in the luxury shirt category.',
  },
  {
    type: 'mutation',
    label: 'Increase summer shirts discount by 5%',
    text: 'Increase the discount of all summer shirts by 5%.',
  },
  {
    type: 'mutation',
    label: 'Reduce price by 200 where discount >= 25%',
    text: 'Reduce the price of products with a discount of 25% or more by 200.',
  },
];

const ELECTRONICS_SAMPLE_PROMPTS: SamplePrompt[] = [
  {
    type: 'query',
    label: 'Laptops in Dhaka warehouse',
    text: 'Show all products in warehouse Dhaka.',
  },
  {
    type: 'query',
    label: 'Dell laptops < 1500',
    text: 'Find Dell laptops with Current_Price below 1500.',
  },
  {
    type: 'query',
    label: 'Low stock items',
    text: 'Show products with Stock_Qty below 10.',
  },
  {
    type: 'mutation',
    label: 'Increase Dell laptops price by $50',
    text: 'Increase the Current_Price of Dell laptops by $50.',
  },
  {
    type: 'mutation',
    label: 'Increase stock of Asus ROG by 5',
    text: 'Increase the Stock_Qty of Asus ROG Strix G16 by 5.',
  },
];

const GROCERY_SAMPLE_PROMPTS: SamplePrompt[] = [
  {
    type: 'query',
    label: 'Products from Acme',
    text: 'Show all products from supplier Acme.',
  },
  {
    type: 'query',
    label: 'Items in Dhaka warehouse',
    text: 'List items in warehouse Dhaka.',
  },
  {
    type: 'mutation',
    label: 'Reduce NorthStar cost by 5%',
    text: 'Reduce the unit cost of products from supplier NorthStar by 5%.',
  },
  {
    type: 'mutation',
    label: 'Increase Dhaka quantity by 15',
    text: 'Increase the quantity of products in warehouse Dhaka by 15 units.',
  },
];

function looksLikeMutationInstruction(text: string): boolean {
  const lower = String(text || '')
    .trim()
    .toLowerCase();
  return /^(?:change|update|set|modify|increase|decrease|reduce|raise|lower|mark|make|delete|remove|drop|erase|clear|insert|add|create|append)\b|\b(?:change\s+the|update\s+the|set\s+the|delete\s+the|remove\s+the|insert\s+a|add\s+a|create\s+a)\b/.test(
    lower
  );
}

function formatCellValue(col: string, value: unknown): string {
  if (value === null || value === undefined || value === '') {
    return '—';
  }
  const lowerCol = String(col).toLowerCase();

  if (typeof value === 'boolean' || lowerCol === 'best') {
    return value === true || String(value).toLowerCase() === 'true'
      ? 'True'
      : 'False';
  }

  if (
    lowerCol.includes('price') ||
    lowerCol.includes('cost') ||
    lowerCol.includes('rate')
  ) {
    const num = Number(value);
    return Number.isFinite(num) ? `${num}` : String(value);
  }

  if (
    lowerCol.includes('discount') ||
    lowerCol.includes('percentage') ||
    lowerCol.includes('pct')
  ) {
    const num = Number(value);
    return Number.isFinite(num) ? `${num}%` : String(value);
  }

  if (
    lowerCol.includes('qty') ||
    lowerCol.includes('quantity') ||
    lowerCol.includes('level') ||
    lowerCol.includes('ordered') ||
    lowerCol.includes('months')
  ) {
    const num = Number(value);
    return Number.isFinite(num) ? `${num}` : String(value);
  }

  if (lowerCol.includes('date') || lowerCol.includes('time')) {
    const d = String(value).slice(0, 10);
    return d || String(value);
  }

  if (lowerCol === 'size') {
    const raw = String(value);
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        return Object.entries(parsed)
          .map(([k, v]) => `${k}: ${v}`)
          .join(', ');
      }
    } catch {
      // Fall through
    }
    return raw;
  }

  if (lowerCol.includes('desc')) {
    const str = String(value).replace(/\s+/g, ' ').trim();
    return str.length > 90 ? `${str.slice(0, 90)}...` : str;
  }

  if (lowerCol.includes('image')) {
    const urls = String(value)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (urls.length === 0) return '—';
    return `${urls.length} image(s)`;
  }

  return String(value);
}

function formatMutationValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

function getMutationRecordLabel(
  diff: MutationDiffItem,
  targetRows: DynamicSheetRow[],
  index: number
): string {
  const targetRow = targetRows.find(
    (row) => String(row.id ?? '') === String(diff.id ?? '')
  );
  const labelField = Object.keys(targetRow || {}).find((field) =>
    /(?:^|_)(?:name|title|label)$/i.test(field)
  );
  const labelValue = labelField ? targetRow?.[labelField] : undefined;

  if (diff.name && diff.name !== diff.id) return diff.name;
  if (labelValue !== null && labelValue !== undefined && String(labelValue).trim()) {
    return String(labelValue);
  }
  return diff.id || `Row ${index + 1}`;
}

function extractSpreadsheetId(input: string): string {
  const match = input.match(/\/d\/([a-zA-Z0-9-_]+)/);
  if (match) return match[1];
  return input.trim();
}

const SYSTEM_COLUMNS = new Set([
  'id',
  'business_id',
  'workspace_id',
  'user_id',
  'workspace_document_id',
  '_google_row_index',
  'created_at',
  'updated_at',
]);

export default function SheetManagementPanel(): React.ReactElement {
  const dispatch = useDispatch<any>();
  const [clientAppendError, setClientAppendError] = useState<string | null>(null);

  const [activeBusinessId, setActiveBusinessId] = useState<string>(() =>
    getActiveBusinessId()
  );

  const {
    activeEntity = '',
    activeDisplayName = '',
    activeFileName = '',
    activeColumns = [],
    availableTables = [],
    rowsByEntity = {},
    sheetLoadStatus,
    sheetLoadError,
    nlPrompt = '',
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
  } = useSelector((state: { sheets: SheetSliceState }) => state.sheets);

  const [isAddRowModalOpen, setIsAddRowModalOpen] = useState<boolean>(false);
  const [newRowData, setNewRowData] = useState<Record<string, string>>({});
  const [addRowError, setAddRowError] = useState<string | null>(null);
  const [addRowSuccessToast, setAddRowSuccessToast] = useState<string | null>(null);

  // Cross-Document RAG & Socratic Operations state
  const [documents, setDocuments] = useState<WorkspaceDocument[]>([]);
  const [isUploadingDoc, setIsUploadingDoc] = useState<boolean>(false);
  const [isSeedingDemo, setIsSeedingDemo] = useState<boolean>(false);
  const [activeCitation, setActiveCitation] = useState<Citation | null>(null);
  const [flashHighlightedLocator, setFlashHighlightedLocator] = useState<string | null>(null);
  const [pendingMutations, setPendingMutations] = useState<WorkspaceMutationDiff[]>([]);

  // Google Sheets 2-Way Sync & Import state
  const [syncedSheets, setSyncedSheets] = useState<
    Array<{
      table_name: string;
      google_spreadsheet_id: string;
      google_sheet_tab_name: string;
      row_count: number;
      last_synced_at: string;
    }>
  >([]);
  const [showImportSheetModal, setShowImportSheetModal] = useState<boolean>(false);
  const [googleSpreadsheetsList, setGoogleSpreadsheetsList] = useState<GoogleDriveFile[]>([]);
  const [selectedSpreadsheetId, setSelectedSpreadsheetId] = useState<string>('');
  const [customSpreadsheetInput, setCustomSpreadsheetInput] = useState<string>('');
  const [sheetTabNameInput, setSheetTabNameInput] = useState<string>('Sheet1');
  const [customEntityInput, setCustomEntityInput] = useState<string>('');
  const [sheetsListLoading, setSheetsListLoading] = useState<boolean>(false);
  const [checkingSheetGoogleAuth, setCheckingSheetGoogleAuth] = useState<boolean>(false);
  const [isSheetGoogleConnected, setIsSheetGoogleConnected] = useState<boolean>(false);
  const [connectingSheetGoogle, setConnectingSheetGoogle] = useState<boolean>(false);
  const [importingSheet, setImportingSheet] = useState<boolean>(false);
  const [importSheetError, setImportSheetError] = useState<string | null>(null);
  const [isManualSyncing, setIsManualSyncing] = useState<boolean>(false);

  const loadDocuments = async (targetBizId = activeBusinessId) => {
    if (!targetBizId) {
      setDocuments([]);
      return;
    }
    try {
      const res = await fetchWorkspaceDocuments(targetBizId);
      if (Array.isArray(res?.documents)) {
        setDocuments(res.documents);
      }
    } catch {
      // Best effort load
    }
  };

  const loadSyncedSheets = async (targetBizId = activeBusinessId) => {
    if (!targetBizId) {
      setSyncedSheets([]);
      return;
    }
    try {
      const sheets = await getSyncedGoogleSheetsApi(targetBizId);
      setSyncedSheets(sheets);
    } catch {
      // Best effort load
    }
  };

  // Subscribe to workspace switching and auth changes
  useEffect(() => {
    const handleWorkspaceOrAuthSync = () => {
      const nextBizId = getActiveBusinessId();
      setActiveBusinessId((prev) => {
        if (prev !== nextBizId) {
          dispatch(resetSheetWorkspaceState());
          setDocuments([]);
          setSyncedSheets([]);
          setPendingMutations([]);
          setActiveCitation(null);
          setClientAppendError(null);
          setAddRowError(null);
          setAddRowSuccessToast(null);
          setShowImportSheetModal(false);
          setGoogleSpreadsheetsList([]);
          setSelectedSpreadsheetId('');
          setCustomSpreadsheetInput('');
          setImportSheetError(null);
          setIsAddRowModalOpen(false);
        }
        return nextBizId;
      });
    };

    window.addEventListener('workspaceChanged', handleWorkspaceOrAuthSync);
    window.addEventListener('authChanged', handleWorkspaceOrAuthSync);
    return () => {
      window.removeEventListener('workspaceChanged', handleWorkspaceOrAuthSync);
      window.removeEventListener('authChanged', handleWorkspaceOrAuthSync);
    };
  }, [dispatch]);

  // Discover and load only the tables, documents, and synced sheets belonging to active businessId
  useEffect(() => {
    if (!activeBusinessId) {
      dispatch(resetSheetWorkspaceState());
      setDocuments([]);
      setSyncedSheets([]);
      return;
    }
    dispatch(loadBusinessSheets({ businessId: activeBusinessId }));
    loadDocuments(activeBusinessId);
    loadSyncedSheets(activeBusinessId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dispatch, activeBusinessId]);

  const handleOpenImportSheetModal = async () => {
    if (!activeBusinessId) {
      setClientAppendError('Please create or select a workspace first.');
      return;
    }
    setShowImportSheetModal(true);
    setImportSheetError(null);
    setGoogleSpreadsheetsList([]);

    const currentUser = getLoggedInUser();
    const statusTarget = currentUser?.id || activeBusinessId;

    setCheckingSheetGoogleAuth(true);
    setIsSheetGoogleConnected(false);
    try {
      const authStatus = await getGoogleAuthStatusApi(statusTarget);
      if (!authStatus?.connected) {
        setIsSheetGoogleConnected(false);
        return;
      }

      setIsSheetGoogleConnected(true);
      setSheetsListLoading(true);
      try {
        const files = await listGoogleSpreadsheetsApi(activeBusinessId);
        setGoogleSpreadsheetsList(files);
        if (files.length > 0) {
          setSelectedSpreadsheetId((prev) =>
            prev && files.some((f) => f.id === prev) ? prev : files[0].id
          );
        }
      } catch {
        // Graceful fallback: Drive listing is optional. User can paste Spreadsheet URL/ID directly.
        setGoogleSpreadsheetsList([]);
      } finally {
        setSheetsListLoading(false);
      }
    } catch {
      setIsSheetGoogleConnected(false);
    } finally {
      setCheckingSheetGoogleAuth(false);
    }
  };

  const handleConnectGoogleForSheets = async () => {
    const currentUser = getLoggedInUser();
    setConnectingSheetGoogle(true);
    setImportSheetError(null);
    try {
      const url = await getGoogleAuthUrlApi(currentUser?.id || activeBusinessId, {
        mode: currentUser?.id ? 'link' : 'login',
        userId: currentUser?.id,
        workspaceId: activeBusinessId,
        tab: 'sheets',
      });
      window.location.href = url;
    } catch (err: any) {
      setImportSheetError(err?.message || 'Failed to initiate Google account connection.');
      setConnectingSheetGoogle(false);
    }
  };

  const selectedImportTargetId = useMemo(
    () => extractSpreadsheetId(customSpreadsheetInput.trim() || selectedSpreadsheetId),
    [customSpreadsheetInput, selectedSpreadsheetId]
  );

  const isReSyncingExistingSheet = useMemo(
    () =>
      Boolean(selectedImportTargetId) &&
      syncedSheets.some((s) => s.google_spreadsheet_id === selectedImportTargetId),
    [selectedImportTargetId, syncedSheets]
  );

  const handleImportGoogleSheetSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeBusinessId) {
      setImportSheetError('No active workspace selected.');
      return;
    }
    const targetId = extractSpreadsheetId(customSpreadsheetInput.trim() || selectedSpreadsheetId);
    if (!targetId) {
      setImportSheetError('Please select a Google Sheet or enter a valid Spreadsheet ID or URL.');
      return;
    }

    const isUpdatingSyncedSheet = syncedSheets.some(
      (s) => s.google_spreadsheet_id === targetId
    );
    if (syncedSheets.length >= 5 && !isUpdatingSyncedSheet) {
      setImportSheetError(
        'Workspace limit reached: Maximum 5 Google Sheets can be actively synced per workspace. Please disconnect an existing synced sheet before importing a new one.'
      );
      return;
    }

    setImportingSheet(true);
    setImportSheetError(null);
    try {
      const res = await importGoogleSheetApi({
        spreadsheetId: targetId,
        sheetTabName: sheetTabNameInput.trim() || 'Sheet1',
        customEntityName: customEntityInput.trim() || undefined,
        businessId: activeBusinessId,
      });

      await dispatch(loadBusinessSheets({ preferredEntity: res.entity, businessId: activeBusinessId }));
      await loadSyncedSheets(activeBusinessId);
      setShowImportSheetModal(false);
      setAddRowSuccessToast(
        `Successfully imported & synced "${res.entity}" from Google Sheets (${res.rowCount} rows).`
      );
      setTimeout(() => setAddRowSuccessToast(null), 5000);
    } catch (err: any) {
      setImportSheetError(err?.message || 'Failed to import Google Sheet.');
    } finally {
      setImportingSheet(false);
    }
  };

  const handleManualSyncGoogleSheet = async () => {
    if (!activeEntity || !activeBusinessId) return;
    const meta = syncedSheets.find(
      (s) => s.table_name.toLowerCase() === activeEntity.toLowerCase()
    );
    if (!meta) return;

    setIsManualSyncing(true);
    try {
      const res = await importGoogleSheetApi({
        spreadsheetId: meta.google_spreadsheet_id,
        sheetTabName: meta.google_sheet_tab_name,
        customEntityName: meta.table_name,
        businessId: activeBusinessId,
      });
      await dispatch(loadSheetRows(activeEntity));
      await loadSyncedSheets(activeBusinessId);
      setAddRowSuccessToast(
        `Successfully synchronized "${activeEntity}" with Google Sheets (${res.rowCount} rows).`
      );
      setTimeout(() => setAddRowSuccessToast(null), 4000);
    } catch (err: any) {
      setAddRowError(err?.message || 'Failed to sync with Google Sheet.');
    } finally {
      setIsManualSyncing(false);
    }
  };

  const currentSyncedMetadata = useMemo(() => {
    if (!activeEntity) return null;
    return (
      syncedSheets.find(
        (s) => s.table_name.toLowerCase() === activeEntity.toLowerCase()
      ) || null
    );
  }, [activeEntity, syncedSheets]);

  const activeRows: DynamicSheetRow[] = activeEntity
    ? rowsByEntity[activeEntity] || []
    : [];

  // Determine dynamic table columns from the active sheet (excluding internal system fields)
  const displayedColumns: string[] = useMemo(() => {
    if (!activeEntity) {
      return [];
    }
    if (Array.isArray(activeColumns) && activeColumns.length > 0) {
      const filtered = activeColumns.filter(
        (k) => !SYSTEM_COLUMNS.has(k.toLowerCase())
      );
      if (filtered.length > 0) return filtered;
    }
    if (activeRows.length > 0) {
      const keys = Object.keys(activeRows[0]).filter(
        (k) => !SYSTEM_COLUMNS.has(k.toLowerCase())
      );
      if (keys.length > 0) return keys;
    }
    if (activeEntity === 'electronics_inventory') {
      return [
        'Product_Name',
        'Brand_Name',
        'Model',
        'Current_Price',
        'Stock_Qty',
        'Warehouse',
        'Reorder_Level',
        'Warranty_Months',
      ];
    }
    if (activeEntity === 'grocery_inventory') {
      return [
        'Item_Name',
        'Supplier',
        'Unit_Cost',
        'Selling_Price',
        'Expiry_Date',
        'Batch_No',
        'Quantity',
        'Warehouse_Location',
        'Stock',
      ];
    }
    if (activeEntity === 'products') {
      return PRODUCT_COLUMNS;
    }
    return [];
  }, [activeRows, activeColumns, activeEntity]);

  // Dynamic table list strictly restricted to tables belonging to the active business
  const tableList = useMemo(() => {
    const list: Array<{ entity: string; displayName: string; rowCount: number }> = [];
    const seen = new Set<string>();

    for (const tbl of availableTables) {
      if (!tbl || !tbl.entity) continue;
      const key = tbl.entity.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const rows = rowsByEntity[tbl.entity];
      list.push({
        entity: tbl.entity,
        displayName:
          tbl.entity === 'orders'
            ? 'Commercial Orders'
            : tbl.displayName || tbl.entity,
        rowCount: Array.isArray(rows) ? rows.length : (tbl.rowCount ?? 0),
      });
    }

    for (const [key, rows] of Object.entries(rowsByEntity)) {
      if (!seen.has(key.toLowerCase()) && Array.isArray(rows) && rows.length > 0) {
        seen.add(key.toLowerCase());
        list.push({
          entity: key,
          displayName:
            key === 'orders'
              ? 'Commercial Orders'
              : key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
          rowCount: rows.length,
        });
      }
    }

    return list;
  }, [availableTables, rowsByEntity]);

  // 1-Click Demo Scenario Loader
  const handleLoadDemoScenario = async () => {
    if (!activeBusinessId) {
      setClientAppendError('Please create or select a workspace first.');
      return;
    }
    setIsSeedingDemo(true);
    setClientAppendError(null);
    try {
      const res = await seedWorkspaceDemo(activeBusinessId);
      await loadDocuments(activeBusinessId);
      await dispatch(
        loadBusinessSheets({ preferredEntity: 'orders', businessId: activeBusinessId })
      );
      dispatch(
        setSheetNlPrompt(
          'Check which orders in our spreadsheet are affected by this shipment delay, update their status, and notify those customers per our SLA policy.'
        )
      );
      setAddRowSuccessToast(res?.message || 'Demo scenario loaded: Commercial Orders & SLA policies ready.');
      setTimeout(() => setAddRowSuccessToast(null), 5000);
    } catch (err: any) {
      setClientAppendError(err?.message || 'Failed to load demo scenario.');
    } finally {
      setIsSeedingDemo(false);
    }
  };

  // Upload an unstructured policy/notice document (.pdf, .md, .txt)
  const handleUploadDocument = async (file: File) => {
    if (!activeBusinessId) {
      setClientAppendError('Please create or select a workspace first.');
      return;
    }
    setIsUploadingDoc(true);
    setClientAppendError(null);
    try {
      await uploadWorkspaceDocument(file, activeBusinessId);
      await loadDocuments(activeBusinessId);
      setAddRowSuccessToast(`Successfully ingested and indexed "${file.name}".`);
      setTimeout(() => setAddRowSuccessToast(null), 4000);
    } catch (err: any) {
      setClientAppendError(err?.message || 'Failed to upload document.');
    } finally {
      setIsUploadingDoc(false);
    }
  };

  // Dynamic sample prompts according to active entity and workspace sources
  const samplePrompts: SamplePrompt[] = useMemo(() => {
    const multiHopB2BPrompt: SamplePrompt = {
      type: 'mutation',
      label: 'Cross-Reference Delay Notice & SLA',
      text: 'Check which orders in our spreadsheet are affected by this shipment delay, update their status, and notify those customers per our SLA policy.',
    };

    let base = [multiHopB2BPrompt, ...BASE_SAMPLE_PROMPTS];
    if (activeEntity === 'orders') {
      base = [
        multiHopB2BPrompt,
        {
          type: 'mutation',
          label: 'Apply 10% SLA Vouchers to Delayed Orders',
          text: 'Apply the 10% merchandise subtotal SLA store credit voucher to all delayed orders exceeding 48 hours.',
        },
        {
          type: 'query',
          label: 'Orders in Dhaka Central hub',
          text: 'Show all orders fulfilled from Dhaka Central hub.',
        },
        {
          type: 'query',
          label: 'Delayed orders > 48h',
          text: 'Find all orders with Delay_Hours greater than 48.',
        },
      ];
    } else if (activeEntity === 'electronics_inventory') {
      base = [multiHopB2BPrompt, ...ELECTRONICS_SAMPLE_PROMPTS];
    } else if (activeEntity === 'grocery_inventory') {
      base = [multiHopB2BPrompt, ...GROCERY_SAMPLE_PROMPTS];
    }

    if (activeRows.length > 0) {
      const first = activeRows[0];
      const itemName = (first.name || first.Product_Name || first.Item_Name || first.Order_ID) as string | undefined;
      if (itemName) {
        if (first.size) {
          return [
            ...base,
            {
              type: 'mutation',
              label: `Increase ${itemName} (XL & M) stock by 2`,
              text: `Increase stock of product ${itemName} for sizes XL and M by 2.`,
            },
          ];
        }
        if (first.Current_Price !== undefined) {
          return [
            ...base,
            {
              type: 'mutation',
              label: `Increase price of ${itemName} by 20`,
              text: `Increase the Current_Price of ${itemName} by 20.`,
            },
          ];
        }
        if (first.Selling_Price !== undefined) {
          return [
            ...base,
            {
              type: 'mutation',
              label: `Increase price of ${itemName} by 10`,
              text: `Increase the Selling_Price of ${itemName} by 10.`,
            },
          ];
        }
      }
    }
    return base;
  }, [activeEntity, activeRows]);

  const matchedIdsSet = useMemo(
    () => new Set(Array.isArray(queryResult?.matchedIds) ? queryResult.matchedIds : []),
    [queryResult?.matchedIds]
  );
  const isQueryFilterActive = Boolean(
    queryResult &&
    queryResult.status !== 'clarification_needed' &&
    Array.isArray(queryResult.matchedIds)
  );
  const hasActiveQueryFilter = isQueryFilterActive;

  // When a natural-language query is active, show ONLY the rows that match the query
  const displayedRows: DynamicSheetRow[] = useMemo(() => {
    if (!isQueryFilterActive) {
      return activeRows;
    }
    if (Array.isArray(queryResult?.rows) && queryResult.rows.length > 0) {
      return queryResult.rows;
    }
    return activeRows.filter((row) => row.id && matchedIdsSet.has(row.id as string));
  }, [activeRows, isQueryFilterActive, queryResult, matchedIdsSet]);

  // Run Natural-Language Query
  const handleRunQuery = async (
    customText?: string,
    conversationHistory: ConversationHistoryTurn[] = []
  ) => {
    const text = (
      typeof customText === 'string' ? customText : nlPrompt
    ).trim();
    if (!text || queryStatus === 'loading') return;

    await dispatch(
      runSheetQuery({
        entity: activeEntity,
        message: text,
        conversation_history: conversationHistory.slice(-5),
      })
    );
  };

  // Run Stage 1 Mutation Preview (confirm: false)
  const handleRunMutationPreview = async (
    customText?: string,
    conversationHistory: ConversationHistoryTurn[] = []
  ) => {
    const text = (
      typeof customText === 'string' ? customText : nlPrompt
    ).trim();
    if (!text || mutationPreviewStatus === 'loading') return;

    await dispatch(
      previewSheetMutation({
        entity: activeEntity,
        message: text,
        conversation_history: conversationHistory.slice(-5),
      })
    );
  };

  // Unified instruction handler (dynamically routes query vs. mutation preview)
  const handleRunInstruction = async (customText?: string) => {
    const text = (
      typeof customText === 'string' ? customText : nlPrompt
    ).trim();
    if (!text) return;

    if (looksLikeMutationInstruction(text)) {
      await handleRunMutationPreview(text);
    } else {
      await handleRunQuery(text);
    }
  };

  const handleRoutedSheetInstruction = async (
    intent: 'sheet_query' | 'sheet_mutation',
    entity: string,
    text: string,
    conversationHistory: ConversationHistoryTurn[] = []
  ): Promise<{
    message: string;
    entity: string;
    matched_row_ids: string[];
    applied_filter_summary: string;
    status: string;
  }> => {
    dispatch(setActiveSheetEntity(entity));
    const slicedHistory = Array.isArray(conversationHistory)
      ? conversationHistory.slice(-5)
      : [];

    if (intent === 'sheet_query') {
      const result = await dispatch(
        runSheetQuery({
          entity,
          message: text,
          conversation_history: slicedHistory,
        })
      ).unwrap();
      const matchedIds = Array.isArray(result.highlighted_rows) && result.highlighted_rows.length > 0
        ? result.highlighted_rows.map((h: any) => String(h.row_identifier || '').trim()).filter(Boolean)
        : Array.isArray(result.matched_ids) && result.matched_ids.length > 0
          ? result.matched_ids.map((id: any) => String(id).trim()).filter(Boolean)
          : Array.isArray(result.rows)
            ? result.rows.map((r: any) => String(r?.id || '').trim()).filter(Boolean)
            : [];
      const filterList = Array.isArray(result.filters)
        ? result.filters
        : Array.isArray(result.interpretedQuery?.filters)
          ? result.interpretedQuery.filters
          : [];
      const filterSummary = filterList
        .map((f: any) => `${f.field || f.column} ${f.operator} ${JSON.stringify(f.value)}`)
        .join(` ${result.filter_logic || result.interpretedQuery?.filter_logic || 'AND'} `);

      if (result.status === 'clarification_needed') {
        return {
          message: result.message || 'Please clarify the spreadsheet query.',
          entity,
          matched_row_ids: [],
          applied_filter_summary: '',
          status: result.status,
        };
      }
      return {
        message:
          result.answer ||
          result.message ||
          `Query complete: found ${result.count} matching row(s) in ${entity}. The rows are shown in the spreadsheet results.`,
        entity: result.entity || entity,
        matched_row_ids: matchedIds,
        applied_filter_summary: filterSummary,
        status: result.status || 'ok',
      };
    }

    const result = await dispatch(
      previewSheetMutation({
        entity,
        message: text,
        conversation_history: slicedHistory,
      })
    ).unwrap();
    if (result.status === 'clarification_needed') {
      return {
        message: result.message || 'Please clarify the requested spreadsheet update.',
        entity: result.entity || entity,
        matched_row_ids: [],
        applied_filter_summary: '',
        status: result.status,
      };
    }
    if (result.status === 'not_found') {
      return {
        message: result.message || `No matching rows were found in ${entity}.`,
        entity: result.entity || entity,
        matched_row_ids: [],
        applied_filter_summary: '',
        status: result.status,
      };
    }
    const diffIds = Array.isArray(result.diff)
      ? result.diff.map((d: any) => String(d.row_identifier || d.id || '').trim()).filter(Boolean)
      : Array.isArray(result.target_rows)
        ? result.target_rows.map((r: any) => String(r?.id || '').trim()).filter(Boolean)
        : [];
    return {
      message: `Mutation preview ready: ${result.affected_count} row(s) in ${entity} are affected. Review the diff and confirm it in the spreadsheet panel.`,
      entity: result.entity || entity,
      matched_row_ids: diffIds,
      applied_filter_summary: '',
      status: result.status || 'preview',
    };
  };

  // Unified form submit (auto-detects query vs mutation intent)
  const handlePrimaryPromptSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    await handleRunInstruction(nlPrompt);
  };

  // Stage 2: Confirm & Apply Mutation (confirm: true)
  const handleConfirmMutation = async () => {
    if (
      !mutationPreview ||
      mutationPreview.status !== 'preview' ||
      mutationApplyStatus === 'loading'
    ) {
      return;
    }

    const messageToConfirm = mutationPreview.promptUsed || nlPrompt.trim();
    await dispatch(
      applySheetMutation({
        entity: mutationPreview.entity || activeEntity,
        message: messageToConfirm,
        mutation: mutationPreview.approved_mutation,
        expectedPreviewHash: mutationPreview.preview_hash,
      })
    );
  };

  // "Upload CSV" (Replaces sheet records or loads a new sheet structure)
  const handleCsvFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setClientAppendError(null);

    await dispatch(
      importSheetCsvFile({
        entity: '',
        file,
      })
    );
    e.target.value = '';
  };

  // "Add Rows" (Appends new rows to existing active CSV sheet with strict column validation)
  const handleAppendRowsUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setClientAppendError(null);

    // Client-side pre-validation: check that new rows have the same columns as active sheet
    try {
      const text = await file.slice(0, 4096).text();
      const firstLine = text.split(/\r?\n/)[0] || '';
      const uploadedHeaders = firstLine
        .split(',')
        .map((h) => h.replace(/^["']|["']$/g, '').trim().toLowerCase())
        .filter(Boolean);

      const missingCols = displayedColumns.filter(
        (col) => !uploadedHeaders.includes(col.toLowerCase())
      );

      if (missingCols.length > 0) {
        setClientAppendError(
          `Invalid CSV headers for append. Uploaded row columns do not match active sheet (${activeDisplayName || activeEntity}). Missing column(s): ${missingCols.join(
            ', '
          )}. Expected columns: ${displayedColumns.join(', ')}.`
        );
        e.target.value = '';
        return;
      }
    } catch {
      // If client-side slice fails, continue to server-side validation
    }

    await dispatch(
      appendSheetCsvFile({
        entity: activeEntity,
        file,
      })
    );
    e.target.value = '';
  };

  const handleOpenAddRowModal = () => {
    const initialValues: Record<string, string> = {};
    for (const col of displayedColumns) {
      initialValues[col] = col.toLowerCase() === 'best' ? 'false' : '';
    }
    setNewRowData(initialValues);
    setAddRowError(null);
    dispatch(clearRowInsertState());
    setIsAddRowModalOpen(true);
  };

  const handleRowFieldChange = (col: string, value: string) => {
    setNewRowData((prev) => ({
      ...prev,
      [col]: value,
    }));
  };

  const handleAddRowSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setAddRowError(null);

    const hasValues = Object.entries(newRowData).some(
      ([_, val]) => String(val ?? '').trim() !== ''
    );
    if (!hasValues) {
      setAddRowError('Please enter at least one column value.');
      return;
    }

    try {
      const res = await dispatch(
        insertSingleSheetRow({ entity: activeEntity, row: newRowData })
      ).unwrap();
      setIsAddRowModalOpen(false);
      setAddRowSuccessToast(res?.message || 'Row added successfully.');
      setTimeout(() => setAddRowSuccessToast(null), 4000);
    } catch (err: any) {
      setAddRowError(err?.message || 'Failed to add row to active sheet.');
    }
  };

  const isBusy =
    sheetLoadStatus === 'loading' ||
    queryStatus === 'loading' ||
    mutationPreviewStatus === 'loading' ||
    mutationApplyStatus === 'loading' ||
    csvUploadStatus === 'loading' ||
    csvAppendStatus === 'loading' ||
    rowInsertStatus === 'loading';

  const pendingMutationMap = useMemo(() => {
    const map = new Map<string, WorkspaceMutationDiff>();
    for (const m of pendingMutations) {
      if (m.id !== undefined && m.id !== null) {
        map.set(String(m.id).toLowerCase(), m);
      }
      if (m.row_identifier !== undefined && m.row_identifier !== null) {
        map.set(String(m.row_identifier).toLowerCase(), m);
      }
      if ((m as any).order_id) {
        map.set(String((m as any).order_id).toLowerCase(), m);
      }
      if ((m as any).Order_ID) {
        map.set(String((m as any).Order_ID).toLowerCase(), m);
      }
      if (m.name) {
        map.set(String(m.name).toLowerCase(), m);
      }
    }
    return map;
  }, [pendingMutations]);

  return (
    <motion.div
      className="sheet-management-workspace"
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2 }}
    >
      {/* Multi-Source Knowledge & Table Bar (Spanning across full workspace grid) */}
      <div style={{ gridColumn: '1 / -1', width: '100%' }}>
        <KnowledgeSourceBar
          activeBusinessId={activeBusinessId}
          activeEntity={activeEntity}
          activeDisplayName={activeDisplayName}
          activeFileName={activeFileName}
          tableList={tableList}
          onSelectTable={(entity) => {
            dispatch(setActiveSheetEntity(entity));
            dispatch(loadSheetRows(entity));
          }}
          onUploadCsv={(file) => {
            setClientAppendError(null);
            dispatch(importSheetCsvFile({ entity: '', file }));
          }}
          onOpenAddRow={handleOpenAddRowModal}
          onOpenImportGoogleSheet={handleOpenImportSheetModal}
          onRefreshTable={() => {
            if (activeEntity) {
              dispatch(loadSheetRows(activeEntity));
            } else {
              dispatch(loadBusinessSheets({ businessId: activeBusinessId }));
            }
            loadSyncedSheets(activeBusinessId);
          }}
          documents={documents}
          onUploadDocument={handleUploadDocument}
          onSelectDocument={(doc) => {
            setActiveCitation({
              source_type: 'document',
              source_id: doc.doc_id,
              source_name: doc.filename,
              locator: `Doc: ${doc.filename}`,
              excerpt:
                doc.excerpt ||
                `Document ${doc.filename} indexed (${doc.chunk_count || doc.total_chunks || 1} chunk(s)).`,
            });
          }}
          onLoadDemoScenario={handleLoadDemoScenario}
          isSeedingDemo={isSeedingDemo}
          isUploadingDoc={isUploadingDoc}
          isBusy={isBusy}
          onRefreshDocuments={() => loadDocuments(activeBusinessId)}
          syncedTables={syncedSheets.map((s) => ({
            entity: s.table_name,
            google_spreadsheet_id: s.google_spreadsheet_id,
            last_synced_at: s.last_synced_at,
          }))}
        />
      </div>

      {/* Left Main Card: Live Universal Spreadsheet Area */}
      <div
        className="portal-card sheet-panel-card sheet-table-card"
        style={{ padding: 0, overflow: 'hidden', gap: 0, borderRadius: '14px' }}
      >
        <div className="sheet-card-body">
          {/* Show All Rows banner when filter is active */}
          {isQueryFilterActive && (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'flex-end',
              }}
            >
              <button
                type="button"
                className="btn-warm-outlined"
                style={{
                  fontSize: '12px',
                  padding: '4px 10px',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '6px',
                }}
                onClick={() => dispatch(clearSheetFiltersAndFeedback())}
              >
                <RotateCcw size={13} />
                Show All Rows ({activeRows.length})
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

          {mutationPreviewStatus === 'loading' && (
            <div className="alert-banner" role="status">
              <Loader2 size={16} className="spin" style={{ flexShrink: 0 }} />
              <span>Preparing a safe spreadsheet mutation preview…</span>
            </div>
          )}

          {mutationPreviewError && (
            <div className="alert-banner error" role="alert">
              <AlertCircle size={16} style={{ flexShrink: 0 }} />
              <span>{mutationPreviewError}</span>
            </div>
          )}

          {mutationPreview?.status === 'clarification_needed' && (
            <div
              className="alert-banner"
              role="alert"
              style={{
                backgroundColor: '#fffbeb',
                borderColor: '#f59e0b',
                color: '#92400e',
                alignItems: 'flex-start',
              }}
            >
              <AlertTriangle size={16} style={{ flexShrink: 0, marginTop: 1 }} />
              <div style={{ flex: 1 }}>
                <strong>More information is needed before any change can be previewed.</strong>
                <div style={{ marginTop: 4 }}>
                  {mutationPreview.message ||
                    'Please clarify the target records, field, or requested value.'}
                </div>
              </div>
              <button
                type="button"
                className="btn-warm-outlined"
                onClick={() => dispatch(discardMutationPreview())}
                aria-label="Dismiss clarification"
              >
                <X size={14} />
              </button>
            </div>
          )}

          {mutationPreview?.status === 'not_found' && (
            <div className="alert-banner" role="status">
              <Info size={16} style={{ flexShrink: 0 }} />
              <span>
                {mutationPreview.message ||
                  'No records matched the requested update. No changes were made.'}
              </span>
            </div>
          )}

          {mutationPreview?.status === 'preview' && (
            <section
              aria-label="Spreadsheet mutation preview"
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 12,
                padding: 16,
                background: '#fff',
                border: '2px solid var(--primary-indigo)',
                borderRadius: 10,
                boxShadow: '0 4px 14px rgba(57, 70, 211, 0.12)',
              }}
            >
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 10,
                  flexWrap: 'wrap',
                }}
              >
                <div>
                  <strong style={{ color: 'var(--primary-indigo-dark)' }}>
                    Mutation preview — confirmation required
                  </strong>
                  <div style={{ marginTop: 4, fontSize: 12, color: 'var(--text-secondary)' }}>
                    {mutationPreview.message ||
                      `${mutationPreview.affected_count || 0} row(s) will be affected.`}{' '}
                    Table: <code>{mutationPreview.entity || activeEntity}</code>
                  </div>
                </div>
                <button
                  type="button"
                  className="btn-warm-outlined"
                  onClick={() => dispatch(discardMutationPreview())}
                  aria-label="Discard mutation preview"
                >
                  <X size={14} />
                  Discard
                </button>
              </div>

              <div style={{ maxHeight: 340, overflow: 'auto' }}>
                {(mutationPreview.diff || []).length === 0 ? (
                  <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                    {mutationPreview.operation === 'delete'
                      ? 'The listed records will be deleted after confirmation.'
                      : 'No row-level differences were returned. Review the operation summary before confirming.'}
                  </div>
                ) : (
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                    <thead>
                      <tr>
                        <th style={{ textAlign: 'left', padding: '7px 8px' }}>Record</th>
                        <th style={{ textAlign: 'left', padding: '7px 8px' }}>Field</th>
                        <th style={{ textAlign: 'left', padding: '7px 8px' }}>Current value</th>
                        <th style={{ textAlign: 'left', padding: '7px 8px' }}>Proposed value</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(mutationPreview.diff || []).flatMap((row, rowIndex) => {
                        const changes = Object.entries(row.changes || {});
                        const recordLabel = getMutationRecordLabel(
                          row,
                          mutationPreview.target_rows || [],
                          rowIndex
                        );
                        if (changes.length === 0) {
                          return [
                            <tr key={`${row.id || rowIndex}-summary`}>
                              <td style={{ padding: '7px 8px' }}>
                                {recordLabel}
                              </td>
                              <td colSpan={3} style={{ padding: '7px 8px' }}>
                                {mutationPreview.operation === 'delete'
                                  ? 'Will be deleted'
                                  : 'New record'}
                              </td>
                            </tr>,
                          ];
                        }
                        return changes.map(([field, change]) => (
                          <tr key={`${row.id || rowIndex}-${field}`}>
                            <td style={{ padding: '7px 8px', verticalAlign: 'top' }}>
                              {recordLabel}
                            </td>
                            <td style={{ padding: '7px 8px', verticalAlign: 'top' }}>
                              <code>{field}</code>
                            </td>
                            <td style={{ padding: '7px 8px', verticalAlign: 'top' }}>
                              {formatMutationValue(
                                change.before !== undefined
                                  ? change.before
                                  : change.current !== undefined
                                    ? change.current
                                    : row.before?.[field]
                              )}
                            </td>
                            <td
                              style={{
                                padding: '7px 8px',
                                verticalAlign: 'top',
                                color: '#15803d',
                                fontWeight: 700,
                              }}
                            >
                              {formatMutationValue(
                                change.after !== undefined
                                  ? change.after
                                  : change.proposed !== undefined
                                    ? change.proposed
                                    : row.after?.[field]
                              )}
                            </td>
                          </tr>
                        ));
                      })}
                    </tbody>
                  </table>
                )}
              </div>

              <div
                style={{
                  display: 'flex',
                  justifyContent: 'flex-end',
                  gap: 8,
                  borderTop: '1px solid var(--border-warm)',
                  paddingTop: 10,
                }}
              >
                <button
                  type="button"
                  className="btn-primary-indigo"
                  disabled={
                    !mutationPreview.approved_mutation ||
                    mutationApplyStatus === 'loading'
                  }
                  onClick={handleConfirmMutation}
                >
                  {mutationApplyStatus === 'loading' ? (
                    <>
                      <Loader2 size={14} className="spin" />
                      Applying…
                    </>
                  ) : (
                    'Confirm & Apply'
                  )}
                </button>
              </div>
            </section>
          )}

          {/* Query / Match Status Bar */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              flexWrap: 'wrap',
              gap: '8px',
              padding: '10px 14px',
              backgroundColor:
                queryResult?.status === 'clarification_needed'
                  ? '#fffbeb'
                  : queryResult && queryResult.count === 0
                    ? '#fef2f2'
                    : isQueryFilterActive
                      ? '#eff6ff'
                      : 'var(--bg-subtle-warm)',
              borderRadius: '8px',
              border:
                queryResult?.status === 'clarification_needed'
                  ? '1px solid #f59e0b'
                  : queryResult && queryResult.count === 0
                    ? '1px solid #fecaca'
                    : isQueryFilterActive
                      ? '1px solid #bfdbfe'
                      : '1px solid var(--border-warm)',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
              <SlidersHorizontal size={15} color="var(--primary-indigo)" />
              <span style={{ fontWeight: 600, fontSize: '13px' }}>
                {!activeEntity
                  ? 'No table loaded in the current workspace yet.'
                  : !queryResult
                    ? `Showing all ${activeRows.length} record(s) from ${activeDisplayName || activeEntity} (${activeFileName || `${activeEntity}.csv`}).`
                    : queryResult.status === 'clarification_needed'
                      ? `Clarification Needed: ${queryResult.message}`
                      : queryResult.count === 0
                        ? `0 records matched "${queryResult.promptUsed}".`
                        : `Showing ${displayedRows.length} matching record(s) for "${queryResult.promptUsed}".`}
              </span>
              {Boolean(activeEntity) && (
                <span className="sheet-scroll-hint-pill">
                  <ArrowRightLeft size={11} />
                  Scroll table horizontally (↔)
                </span>
              )}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
              {currentSyncedMetadata && (
                <div
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '6px',
                    padding: '3px 9px',
                    borderRadius: '999px',
                    backgroundColor: '#ecfdf5',
                    border: '1px solid #10b981',
                    color: '#065f46',
                    fontSize: '11px',
                    fontWeight: 600,
                  }}
                  title={`2-Way Synced with Google Sheet: ${currentSyncedMetadata.google_spreadsheet_id} (Tab: ${currentSyncedMetadata.google_sheet_tab_name})`}
                >
                  <Cloud size={12} color="#059669" />
                  <span>Google Sheet Synced</span>
                  <button
                    type="button"
                    onClick={handleManualSyncGoogleSheet}
                    disabled={isManualSyncing}
                    style={{
                      background: 'none',
                      border: 'none',
                      cursor: 'pointer',
                      color: '#059669',
                      display: 'inline-flex',
                      alignItems: 'center',
                      padding: '0 2px',
                    }}
                    title="Manually pull latest changes from Google Sheet"
                  >
                    <RefreshCw size={11} className={isManualSyncing ? 'spin' : ''} />
                  </button>
                </div>
              )}
              <span
                style={{
                  fontSize: '12px',
                  color: isQueryFilterActive ? 'var(--primary-indigo)' : 'var(--text-secondary)',
                  fontWeight: 600,
                }}
              >
                {isQueryFilterActive
                  ? `Showing ${displayedRows.length} of ${activeRows.length} rows`
                  : `Total Rows: ${activeRows.length}`}
              </span>
              {Boolean(activeEntity) && (
                <button
                  type="button"
                  className="icon-action-btn"
                  disabled={sheetLoadStatus === 'loading'}
                  onClick={() => dispatch(loadSheetRows(activeEntity))}
                  title={`Refresh ${activeDisplayName || activeEntity} sheet from database`}
                >
                  <RefreshCw
                    size={14}
                    className={sheetLoadStatus === 'loading' ? 'spin' : ''}
                  />
                </button>
              )}
              {isQueryFilterActive && (
                <button
                  type="button"
                  className="btn-warm-outlined"
                  style={{
                    fontSize: '11px',
                    padding: '2px 8px',
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '4px',
                  }}
                  onClick={() => dispatch(clearSheetFiltersAndFeedback())}
                >
                  <RotateCcw size={11} />
                  Show All Rows
                </button>
              )}
            </div>
          </div>

          {/* Universal Spreadsheet Table */}
          <div className="sheet-table-wrap">
            {sheetLoadStatus === 'loading' && activeRows.length === 0 ? (
              <div
                style={{
                  padding: '48px 20px',
                  textAlign: 'center',
                  color: 'var(--text-secondary)',
                  fontSize: '13.5px',
                }}
              >
                <Loader2
                  size={22}
                  className="spin"
                  style={{ margin: '0 auto 8px auto' }}
                />
                <div>
                  Loading{' '}
                  {activeEntity
                    ? `${activeDisplayName || activeEntity} records...`
                    : 'tables for current workspace...'}
                </div>
              </div>
            ) : !activeEntity ? (
              <div
                style={{
                  padding: '48px 20px',
                  textAlign: 'center',
                  color: 'var(--text-secondary)',
                  fontSize: '13.5px',
                }}
              >
                <div
                  style={{
                    fontWeight: 600,
                    color: 'var(--text-primary)',
                    marginBottom: '6px',
                    fontSize: '14px',
                  }}
                >
                  No CSV or Table in This Workspace Yet
                </div>
                <div>
                  Import a <strong>Google Sheet</strong>, click <strong>Upload CSV</strong> in the Structured Tables section above, or click <strong>Load Demo Scenario</strong> to seed demo data.
                </div>
              </div>
            ) : displayedRows.length === 0 ? (
              <div
                style={{
                  padding: '48px 20px',
                  textAlign: 'center',
                  color: 'var(--text-secondary)',
                  fontSize: '13.5px',
                }}
              >
                {isQueryFilterActive ? (
                  <div>
                    <div
                      style={{
                        fontWeight: 600,
                        color: 'var(--text-primary)',
                        marginBottom: '6px',
                        fontSize: '14px',
                      }}
                    >
                      No matching records found
                    </div>
                    <div>
                      0 records matched &ldquo;{queryResult?.promptUsed}&rdquo;.
                    </div>
                    <button
                      type="button"
                      className="btn-warm-outlined"
                      style={{
                        marginTop: '12px',
                        fontSize: '12px',
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: '6px',
                      }}
                      onClick={() => dispatch(clearSheetFiltersAndFeedback())}
                    >
                      <RotateCcw size={13} />
                      Show All Records ({activeRows.length})
                    </button>
                  </div>
                ) : (
                  <div>
                    No records found in {activeDisplayName || activeEntity}. Click{' '}
                    <strong>Upload CSV</strong> above to import your sheet.
                  </div>
                )}
              </div>
            ) : (
              <table className="sheet-table">
                <thead>
                  <tr>
                    <th style={{ width: '54px' }}>#</th>
                    {displayedColumns.map((col) => (
                      <th key={col}>{col.replace(/_/g, ' ')}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {displayedRows.map((row, idx) => {
                    const rowId =
                      row.id !== undefined && row.id !== null
                        ? String(row.id).toLowerCase()
                        : undefined;
                    const rowOrderId =
                      row.Order_ID || (row as any).order_id
                        ? String(row.Order_ID || (row as any).order_id).toLowerCase()
                        : undefined;
                    const rowName =
                      row.name || (row as any).Product_Name || (row as any).Item_Name
                        ? String(row.name || (row as any).Product_Name || (row as any).Item_Name).toLowerCase()
                        : undefined;

                    const mutationDiff =
                      (rowId ? pendingMutationMap.get(rowId) : undefined) ??
                      (rowOrderId ? pendingMutationMap.get(rowOrderId) : undefined) ??
                      (rowName ? pendingMutationMap.get(rowName) : undefined);

                    const isPendingMutation = Boolean(mutationDiff);

                    const isFlashHighlighted = Boolean(
                      flashHighlightedLocator &&
                        ((rowOrderId && flashHighlightedLocator.toLowerCase().includes(rowOrderId)) ||
                          (rowId && flashHighlightedLocator.toLowerCase().includes(rowId)) ||
                          (rowName && flashHighlightedLocator.toLowerCase().includes(rowName)) ||
                          Object.values(row).some(
                            (v) =>
                              v !== null &&
                              v !== undefined &&
                              typeof v !== 'object' &&
                              String(v).trim().length >= 3 &&
                              flashHighlightedLocator.toLowerCase().includes(String(v).toLowerCase())
                          ))
                    );

                    const isHighlighted =
                      isQueryFilterActive ||
                      (rowId ? matchedIdsSet.has(rowId) : false);

                    const rowClassNames = [
                      isHighlighted ? 'highlighted-row' : '',
                      isPendingMutation ? 'pending-mutation-row' : '',
                      isFlashHighlighted ? 'flash-highlighted-row' : '',
                    ]
                      .filter(Boolean)
                      .join(' ');

                    return (
                      <tr
                        key={rowId || rowOrderId || idx}
                        className={rowClassNames}
                      >
                        <td style={{ fontWeight: 700, whiteSpace: 'nowrap' }}>
                          <span>{idx + 1}</span>
                          {isHighlighted && (
                            <span
                              style={{
                                marginLeft: '6px',
                                display: 'inline-block',
                                padding: '1px 6px',
                                borderRadius: '999px',
                                backgroundColor: 'var(--primary-indigo)',
                                color: '#ffffff',
                                fontSize: '9.5px',
                                fontWeight: 700,
                              }}
                            >
                              MATCH
                            </span>
                          )}
                          {isPendingMutation && (
                            <span
                              style={{
                                marginLeft: '6px',
                                display: 'inline-block',
                                padding: '1px 6px',
                                borderRadius: '999px',
                                backgroundColor: '#f59e0b',
                                color: '#ffffff',
                                fontSize: '9.5px',
                                fontWeight: 700,
                              }}
                              title="Proposed modification pending confirmation"
                            >
                              PROPOSED
                            </span>
                          )}
                        </td>
                        {displayedColumns.map((col) => {
                          const colChanges = (mutationDiff?.changes as any)?.[col];
                          const proposedVal =
                            mutationDiff?.after && (mutationDiff.after as any)[col] !== undefined
                              ? (mutationDiff.after as any)[col]
                              : colChanges?.proposed;
                          const currentVal =
                            colChanges?.current !== undefined
                              ? colChanges.current
                              : (mutationDiff?.before as any)?.[col] ?? row[col];

                          const hasCellDiff =
                            isPendingMutation &&
                            proposedVal !== undefined &&
                            String(proposedVal) !== String(row[col]);

                          if (hasCellDiff) {
                            return (
                              <td
                                key={col}
                                style={{
                                  backgroundColor: 'rgba(245, 158, 11, 0.08)',
                                }}
                              >
                                <div
                                  style={{
                                    display: 'inline-flex',
                                    alignItems: 'center',
                                    gap: '5px',
                                    flexWrap: 'wrap',
                                  }}
                                >
                                  <del
                                    style={{
                                      color: '#dc2626',
                                      fontSize: '11px',
                                      opacity: 0.85,
                                    }}
                                  >
                                    {formatCellValue(col, currentVal)}
                                  </del>
                                  <ArrowRight size={11} color="var(--primary-indigo)" />
                                  <strong
                                    style={{
                                      color: '#16a34a',
                                      fontSize: '12.5px',
                                      fontWeight: 700,
                                    }}
                                  >
                                    {formatCellValue(col, proposedVal)}
                                  </strong>
                                </div>
                              </td>
                            );
                          }

                          return (
                            <td
                              key={col}
                              title={
                                row[col] !== null && row[col] !== undefined
                                  ? String(row[col])
                                  : ''
                              }
                            >
                              {formatCellValue(col, row[col])}
                            </td>
                          );
                        })}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>

      {/* Right Column: Socratic Operations Workbench */}
      <SocraticOperationsWorkbench
        activeBusinessId={activeBusinessId}
        activeEntity={activeEntity}
        activeDisplayName={activeDisplayName}
        onRefreshTable={() =>
          activeEntity
            ? dispatch(loadSheetRows(activeEntity))
            : dispatch(loadBusinessSheets({ businessId: activeBusinessId }))
        }
        onMutationsPreviewChange={(mutations) => setPendingMutations(mutations)}
        onSelectCitation={(citation) => setActiveCitation(citation)}
        isBusy={isBusy}
        nlPrompt={nlPrompt}
        onPromptChange={(prompt) => dispatch(setSheetNlPrompt(prompt))}
        samplePrompts={samplePrompts}
        onRunSheetInstruction={handleRoutedSheetInstruction}
        onApplySheetQueryResult={(payload) =>
          dispatch(applySheetQueryPayload(payload))
        }
        onResetWorkspace={() => {
          dispatch(clearSheetFiltersAndFeedback());
          dispatch(discardMutationPreview());
          setPendingMutations([]);
        }}
      />

      {/* Citation Inspector Modal */}
      <CitationInspectorModal
        citation={activeCitation}
        onClose={() => setActiveCitation(null)}
        onHighlightRow={(locator) => {
          setFlashHighlightedLocator(locator);
          setActiveCitation(null);
          setTimeout(() => setFlashHighlightedLocator(null), 3500);
        }}
      />

      {/* Dynamic Add Row Modal for Current Active Table */}
      <AnimatePresence>
        {isAddRowModalOpen && (
          <motion.div
            className="modal-backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2, ease: 'easeOut' }}
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
                maxWidth: '560px',
                maxHeight: '88vh',
                display: 'flex',
                flexDirection: 'column',
              }}
            >
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  marginBottom: '4px',
                }}
              >
                <div
                  style={{ display: 'flex', alignItems: 'center', gap: '8px' }}
                >
                  <div
                    className="brand-logo-box"
                    style={{ width: 28, height: 28, fontSize: 14 }}
                  >
                    +
                  </div>
                  <div>
                    <h3
                      style={{ fontSize: '15.5px', fontWeight: 700, margin: 0 }}
                    >
                      Add New Row
                    </h3>
                    <span
                      style={{
                        fontSize: '11.5px',
                        color: 'var(--text-secondary)',
                      }}
                    >
                      Active Table:{' '}
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
                  fontSize: '12px',
                  color: 'var(--text-secondary)',
                  margin: '0 0 10px 0',
                  lineHeight: 1.4,
                }}
              >
                Enter column information for the current active table. Column
                fields are dynamically loaded based on the schema of{' '}
                <code>{activeDisplayName || activeEntity}</code>.
              </p>

              {addRowError && (
                <div
                  className="alert-banner error"
                  style={{ fontSize: '12px', padding: '8px 12px' }}
                >
                  <AlertCircle size={14} style={{ flexShrink: 0 }} />
                  <span>{addRowError}</span>
                </div>
              )}

              <form
                onSubmit={handleAddRowSubmit}
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '12px',
                  overflowY: 'auto',
                  paddingRight: '4px',
                  maxHeight: 'calc(88vh - 180px)',
                }}
              >
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
                    gap: '12px',
                  }}
                >
                  {displayedColumns.map((col) => {
                    const lower = col.toLowerCase();
                    const isBoolean =
                      lower === 'best' ||
                      lower.endsWith('_bool') ||
                      lower === 'stock';
                    const isNumeric =
                      lower.includes('price') ||
                      lower.includes('discount') ||
                      lower.includes('cost') ||
                      lower.includes('ordered') ||
                      lower.includes('qty') ||
                      lower.includes('months') ||
                      lower.includes('warranty');
                    const isLongText = lower === 'description';

                    return (
                      <div
                        key={col}
                        style={{
                          display: 'flex',
                          flexDirection: 'column',
                          gap: '4px',
                          gridColumn: isLongText ? '1 / -1' : 'auto',
                        }}
                      >
                        <label
                          style={{
                            fontSize: '12px',
                            fontWeight: 600,
                            color: 'var(--text-primary)',
                            textTransform: 'capitalize',
                          }}
                        >
                          {col.replace(/_/g, ' ')}
                        </label>
                        {isBoolean ? (
                          <select
                            className="form-input"
                            value={newRowData[col] ?? 'false'}
                            onChange={(e) =>
                              handleRowFieldChange(col, e.target.value)
                            }
                            style={{ fontSize: '12.5px', padding: '7px 10px' }}
                          >
                            <option value="false">false</option>
                            <option value="true">true</option>
                          </select>
                        ) : isLongText ? (
                          <textarea
                            rows={2}
                            className="form-input"
                            value={newRowData[col] ?? ''}
                            placeholder={`Enter ${col.replace(/_/g, ' ')}...`}
                            onChange={(e) =>
                              handleRowFieldChange(col, e.target.value)
                            }
                            style={{
                              fontSize: '12.5px',
                              padding: '7px 10px',
                              resize: 'vertical',
                            }}
                          />
                        ) : (
                          <input
                            type={isNumeric ? 'number' : 'text'}
                            step={isNumeric ? 'any' : undefined}
                            className="form-input"
                            value={newRowData[col] ?? ''}
                            placeholder={`Enter ${col.replace(/_/g, ' ')}...`}
                            onChange={(e) =>
                              handleRowFieldChange(col, e.target.value)
                            }
                            style={{ fontSize: '12.5px', padding: '7px 10px' }}
                          />
                        )}
                      </div>
                    );
                  })}
                </div>

                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'flex-end',
                    gap: '8px',
                    marginTop: '8px',
                    paddingTop: '12px',
                    borderTop: '1px solid var(--border-warm)',
                  }}
                >
                  <button
                    type="button"
                    className="btn-warm-outlined"
                    onClick={() => setIsAddRowModalOpen(false)}
                    disabled={rowInsertStatus === 'loading'}
                    style={{ fontSize: '12.5px', padding: '7px 14px' }}
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    className="btn-primary-indigo"
                    disabled={rowInsertStatus === 'loading'}
                    style={{ fontSize: '12.5px', padding: '7px 16px' }}
                  >
                    {rowInsertStatus === 'loading' ? (
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

        {/* Google Sheets Import Modal */}
        {showImportSheetModal && (
          <motion.div
            className="modal-backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => setShowImportSheetModal(false)}
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
          >
            <motion.div
              className="modal-box"
              initial={{ scale: 0.95, opacity: 0, y: 10 }}
              animate={{ scale: 1, opacity: 1, y: 0 }}
              exit={{ scale: 0.95, opacity: 0, y: 10 }}
              onClick={(e) => e.stopPropagation()}
              style={{
                backgroundColor: '#ffffff',
                borderRadius: '14px',
                boxShadow: '0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 8px 10px -6px rgba(0, 0, 0, 0.1)',
                width: '100%',
                maxWidth: '540px',
                padding: '24px',
                display: 'flex',
                flexDirection: 'column',
                gap: '14px',
              }}
            >
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  borderBottom: '1px solid var(--border-warm)',
                  paddingBottom: '12px',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <div
                    style={{
                      width: 28,
                      height: 28,
                      borderRadius: 6,
                      backgroundColor: '#ecfdf5',
                      border: '1px solid #10b981',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    <FileSpreadsheet size={16} color="#059669" />
                  </div>
                  <div>
                    <h3 style={{ fontSize: '15px', fontWeight: 700, margin: 0, color: 'var(--text-primary)' }}>
                      Import Google Sheet (2-Way Sync)
                    </h3>
                    <span style={{ fontSize: '11.5px', color: 'var(--text-secondary)' }}>
                      {syncedSheets.length} / 5 Google Sheets connected
                    </span>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setShowImportSheetModal(false)}
                  style={{
                    background: 'none',
                    border: 'none',
                    cursor: 'pointer',
                    color: 'var(--text-secondary)',
                  }}
                  aria-label="Close modal"
                >
                  <X size={17} />
                </button>
              </div>

              {checkingSheetGoogleAuth ? (
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
              ) : !isSheetGoogleConnected ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
                  <div
                    style={{
                      padding: '14px',
                      borderRadius: '10px',
                      backgroundColor: '#ecfdf5',
                      border: '1px solid #a7f3d0',
                      color: '#065f46',
                      fontSize: '13px',
                      lineHeight: 1.5,
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '6px',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: '7px', fontWeight: 700 }}>
                      <Link2 size={16} color="#059669" />
                      <span>Connect Google Account Required</span>
                    </div>
                    <span>
                      You are currently signed in with email and password without a linked Google account. Please connect your Google account first to browse and sync Google Sheets.
                    </span>
                  </div>

                  {importSheetError && (
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
                      <span>{importSheetError}</span>
                    </div>
                  )}

                  <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', paddingTop: '6px' }}>
                    <button
                      type="button"
                      className="btn-warm-outlined"
                      style={{ fontSize: '12.5px', padding: '7px 14px' }}
                      onClick={() => setShowImportSheetModal(false)}
                      disabled={connectingSheetGoogle}
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
                        backgroundColor: '#059669',
                        borderColor: '#047857',
                      }}
                      onClick={handleConnectGoogleForSheets}
                      disabled={connectingSheetGoogle}
                    >
                      {connectingSheetGoogle ? (
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
                  <p style={{ margin: 0, fontSize: '12px', color: 'var(--text-secondary)', lineHeight: 1.45 }}>
                    Connect a Google Sheet into this workspace. Imported sheets create relational PostgreSQL tables for ultra-fast queries, and any confirmed updates in the workspace automatically write back to the live Google Sheet in real time.
                  </p>

                  {syncedSheets.length >= 5 && !isReSyncingExistingSheet && (
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '8px',
                        padding: '8px 12px',
                        borderRadius: '8px',
                        backgroundColor: '#fffbeb',
                        border: '1px solid #fde68a',
                        color: '#92400e',
                        fontSize: '11.5px',
                      }}
                    >
                      <AlertTriangle size={15} style={{ flexShrink: 0 }} />
                      <span>
                        <strong>Sheet Limit Reached:</strong> This workspace has reached the maximum cap of 5 active Google Sheets. Select an already synced sheet to re-sync, or remove one first.
                      </span>
                    </div>
                  )}

                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '6px',
                      padding: '6px 10px',
                      borderRadius: '8px',
                      backgroundColor: 'var(--accent-lavender-bg)',
                      border: '1px solid var(--accent-lavender-border)',
                      fontSize: '11px',
                      color: 'var(--text-secondary)',
                    }}
                  >
                    <Info size={13} color="var(--primary-indigo)" style={{ flexShrink: 0 }} />
                    <span>
                      <strong>Safety limits:</strong> Max 2 MB, 2,000 rows, 40 columns per sheet.
                    </span>
                  </div>

                  {sheetsListLoading ? (
                    <div
                      style={{
                        padding: '20px',
                        textAlign: 'center',
                        fontSize: '12.5px',
                        color: 'var(--text-secondary)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        gap: '8px',
                      }}
                    >
                      <Loader2 size={15} className="spin" />
                      <span>Discovering spreadsheets from Google Drive...</span>
                    </div>
                  ) : googleSpreadsheetsList.length > 0 ? (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                      <label style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-primary)' }}>
                        Select from your Google Drive:
                      </label>
                      <select
                        className="form-input"
                        value={selectedSpreadsheetId}
                        onChange={(e) => {
                          setSelectedSpreadsheetId(e.target.value);
                          setCustomSpreadsheetInput('');
                        }}
                        style={{ fontSize: '12.5px', padding: '7px 10px' }}
                      >
                        {googleSpreadsheetsList.map((f) => (
                          <option key={f.id} value={f.id}>
                            {f.name} {f.modifiedTime ? `(Updated ${new Date(f.modifiedTime).toLocaleDateString()})` : ''}
                          </option>
                        ))}
                      </select>
                    </div>
                  ) : null}

                  <form onSubmit={handleImportGoogleSheetSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                      <label style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-primary)' }}>
                        Or enter Spreadsheet URL / ID:
                      </label>
                      <input
                        type="text"
                        className="form-input"
                        placeholder="https://docs.google.com/spreadsheets/d/1BxiMVs.../edit"
                        value={customSpreadsheetInput}
                        onChange={(e) => setCustomSpreadsheetInput(e.target.value)}
                        style={{ fontSize: '12.5px', padding: '7px 10px' }}
                      />
                    </div>

                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                        <label style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-primary)' }}>
                          Sheet Tab Name:
                        </label>
                        <input
                          type="text"
                          className="form-input"
                          placeholder="e.g. Sheet1"
                          value={sheetTabNameInput}
                          onChange={(e) => setSheetTabNameInput(e.target.value)}
                          style={{ fontSize: '12.5px', padding: '7px 10px' }}
                        />
                      </div>

                      <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                        <label style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-primary)' }}>
                          Entity Name (Optional):
                        </label>
                        <input
                          type="text"
                          className="form-input"
                          placeholder="e.g. wholesale_inventory"
                          value={customEntityInput}
                          onChange={(e) => setCustomEntityInput(e.target.value)}
                          style={{ fontSize: '12.5px', padding: '7px 10px' }}
                        />
                      </div>
                    </div>

                    {importSheetError && (
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
                        <span>{importSheetError}</span>
                      </div>
                    )}

                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'flex-end',
                        gap: '8px',
                        marginTop: '8px',
                        paddingTop: '12px',
                        borderTop: '1px solid var(--border-warm)',
                      }}
                    >
                      <button
                        type="button"
                        className="btn-warm-outlined"
                        style={{ fontSize: '12.5px', padding: '7px 14px' }}
                        onClick={() => setShowImportSheetModal(false)}
                        disabled={importingSheet}
                      >
                        Cancel
                      </button>
                      <button
                        type="submit"
                        className="btn-primary-indigo"
                        style={{
                          fontSize: '12.5px',
                          padding: '7px 16px',
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: '6px',
                          backgroundColor: '#059669',
                          borderColor: '#047857',
                        }}
                        disabled={
                          importingSheet ||
                          (syncedSheets.length >= 5 && !isReSyncingExistingSheet) ||
                          (!selectedSpreadsheetId && !customSpreadsheetInput.trim())
                        }
                      >
                        {importingSheet ? (
                          <>
                            <Loader2 size={13} className="spin" />
                            <span>Connecting &amp; Ingesting...</span>
                          </>
                        ) : (
                          <>
                            <ExternalLink size={14} />
                            <span>Import &amp; Connect Sync</span>
                          </>
                        )}
                      </button>
                    </div>
                  </form>
                </>
              )}
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}
