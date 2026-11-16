import { createSlice, createAsyncThunk } from '@reduxjs/toolkit';
import {
  fetchBusinessSheets,
  fetchSheetRows,
  querySheet,
  mutateSheet,
  uploadSheetCsv,
  addSheetRow,
  updateSheetRowsApi,
  deleteSheetTable,
} from '../services/api';
import { getActiveBusinessId } from '../config/constants';
import {
  getCachedWorkspaceContext,
  setCachedWorkspaceTables,
  patchCachedTableRows,
  removeCachedTableEntity,
  runDeduplicatedWorkspaceRequest,
} from '../services/workspaceContextCache';

/**
 * Thunk: Discover and load all spreadsheet tables that belong to the active businessId.
 * GET /api/sheets/tables?businessId={BUSINESS_ID}
 * Supports L1/L2 cache hit when not forced, plus request deduplication and silent SWR.
 * @type {any}
 */
export const loadBusinessSheets = createAsyncThunk(
  'sheets/loadBusinessSheets',
  async (arg = null, { rejectWithValue }) => {
    try {
      const options =
        typeof arg === 'string'
          ? { preferredEntity: arg }
          : arg && typeof arg === 'object'
            ? arg
            : {};
      const preferredEntity = options.preferredEntity || null;
      const forceRefresh = Boolean(options.forceRefresh);
      const businessId =
        options.businessId !== undefined
          ? String(options.businessId || '').trim()
          : getActiveBusinessId();

      if (!businessId) {
        return {
          businessId: '',
          tables: [],
          preferredEntity: null,
          fromCache: false,
        };
      }

      if (!forceRefresh) {
        const cached = getCachedWorkspaceContext(businessId);
        if (cached?.freshness?.tablesFresh && Array.isArray(cached.snapshot?.tables)) {
          const cleanPref = preferredEntity
            ? String(preferredEntity).trim()
            : cached.snapshot.lastActiveEntity || null;
          return {
            businessId,
            tables: cached.snapshot.tables,
            rowsByEntity: cached.snapshot.rowsByEntity || undefined,
            preferredEntity: cleanPref,
            fromCache: true,
          };
        }
      }

      const data = await runDeduplicatedWorkspaceRequest(
        'businessSheets',
        businessId,
        () => fetchBusinessSheets(businessId),
        { force: forceRefresh }
      );
      const tables = Array.isArray(data?.tables) ? data.tables : [];
      const resolvedBizId = data?.business_id || businessId;
      const cleanPreferred = preferredEntity ? String(preferredEntity).trim() : null;

      setCachedWorkspaceTables(resolvedBizId, {
        tables,
        lastActiveEntity: cleanPreferred || undefined,
      });

      return {
        businessId: resolvedBizId,
        tables,
        preferredEntity: cleanPreferred,
        fromCache: false,
      };
    } catch (err) {
      return rejectWithValue({
        message: err.message || 'Failed to load business sheets.',
      });
    }
  }
);

/**
 * Thunk: Fetch full active inventory sheet from PostgreSQL.
 * GET /api/sheets/{entity}?businessId={BUSINESS_ID}
 * @type {any}
 */
export const loadSheetRows = createAsyncThunk(
  'sheets/loadSheetRows',
  async (entityArg, { getState, dispatch, rejectWithValue }) => {
    try {
      const isObjArg = Boolean(entityArg && typeof entityArg === 'object');
      const rawEntity = isObjArg ? entityArg.entity : entityArg;
      const forceRefresh = isObjArg ? Boolean(entityArg.forceRefresh) : false;
      const targetBiz =
        isObjArg && entityArg.businessId
          ? String(entityArg.businessId).trim()
          : getState().sheets?.businessId || getActiveBusinessId();

      const targetEntity = String(
        rawEntity || getState().sheets?.activeEntity || ''
      ).trim();
      if (!targetEntity) {
        const res = await dispatch(
          loadBusinessSheets({ businessId: targetBiz, forceRefresh })
        ).unwrap();
        return {
          isBusinessDiscovery: true,
          ...res,
        };
      }

      const data = await runDeduplicatedWorkspaceRequest(
        `sheetRows:${targetEntity}`,
        targetBiz,
        () => fetchSheetRows(targetEntity, targetBiz),
        { force: forceRefresh }
      );
      return {
        isBusinessDiscovery: false,
        businessId: targetBiz,
        entity: data?.entity || targetEntity,
        displayName: data?.displayName || targetEntity,
        columns: Array.isArray(data?.columns) ? data.columns : [],
        rows: Array.isArray(data?.rows) ? data.rows : [],
      };
    } catch (err) {
      return rejectWithValue({
        message: err.message || 'Failed to load sheet records.',
      });
    }
  }
);

/**
 * Thunk: Execute Natural-Language Sheet Query.
 * POST /api/businesses/{BUSINESS_ID}/sheets/query
 * @type {any}
 */
export const runSheetQuery = createAsyncThunk(
  'sheets/runSheetQuery',
  async (
    { entity, message, conversation_history = [], conversationHistory },
    { getState, rejectWithValue }
  ) => {
    try {
      const targetEntity =
        entity || getState().sheets?.activeEntity || 'products';
      const historyPayload = Array.isArray(conversation_history) && conversation_history.length > 0
        ? conversation_history.slice(-5)
        : Array.isArray(conversationHistory)
          ? conversationHistory.slice(-5)
          : [];
      const data = await querySheet({
        entity: targetEntity,
        message,
        conversation_history: historyPayload,
      });
      return {
        ...data,
        entity: targetEntity,
        promptUsed: message,
      };
    } catch (err) {
      return rejectWithValue({
        message: err.message || 'Failed to execute natural-language sheet query.',
      });
    }
  }
);

/**
 * Thunk: Stage 1 — Preview Sheet Mutation (confirm: false).
 * POST /api/sheets/mutation
 * @type {any}
 */
export const previewSheetMutation = createAsyncThunk(
  'sheets/previewSheetMutation',
  async (
    { entity, message, conversation_history = [], conversationHistory },
    { getState, rejectWithValue }
  ) => {
    try {
      const targetEntity =
        entity || getState().sheets?.activeEntity || 'products';
      const historyPayload = Array.isArray(conversation_history) && conversation_history.length > 0
        ? conversation_history.slice(-5)
        : Array.isArray(conversationHistory)
          ? conversationHistory.slice(-5)
          : [];
      const data = await mutateSheet({
        entity: targetEntity,
        message,
        confirm: false,
        conversation_history: historyPayload,
      });
      return {
        ...data,
        entity: targetEntity,
        promptUsed: message,
      };
    } catch (err) {
      return rejectWithValue({
        message: err.message || 'Failed to preview proposed sheet modification.',
      });
    }
  }
);

/**
 * Thunk: Stage 2 — Confirm & Apply Sheet Mutation (confirm: true).
 * POST /api/sheets/mutation
 * @type {any}
 */
export const applySheetMutation = createAsyncThunk(
  'sheets/applySheetMutation',
  async (
    {
      entity,
      message,
      mutation,
      expectedPreviewHash,
      conversation_history = [],
      conversationHistory,
    },
    { getState, rejectWithValue }
  ) => {
    try {
      const targetEntity =
        entity || getState().sheets?.activeEntity || 'products';
      const targetBiz =
        getState().sheets?.businessId || getActiveBusinessId();
      const historyPayload = Array.isArray(conversation_history) && conversation_history.length > 0
        ? conversation_history.slice(-5)
        : Array.isArray(conversationHistory)
          ? conversationHistory.slice(-5)
          : [];
      const data = await mutateSheet({
        entity: targetEntity,
        message,
        confirm: true,
        mutation,
        expectedPreviewHash,
        conversation_history: historyPayload,
      }, targetBiz);
      return {
        ...data,
        businessId: targetBiz,
        entity: targetEntity,
        promptUsed: message,
      };
    } catch (err) {
      return rejectWithValue({
        message: err.message || 'Failed to apply confirmed sheet modification.',
      });
    }
  }
);

/**
 * Thunk: Upload CSV file to replace records in the active sheet or create a new sheet for the business.
 * @type {any}
 */
export const importSheetCsvFile = createAsyncThunk(
  'sheets/importSheetCsvFile',
  async ({ file, entity }, { getState, dispatch, rejectWithValue }) => {
    try {
      const targetEntity = entity ? String(entity).trim() : '';
      const targetBiz =
        getState().sheets?.businessId || getActiveBusinessId();
      const data = await uploadSheetCsv(targetEntity, file, 'replace', targetBiz);
      const activeEntity = data.entity || targetEntity;
      await dispatch(
        loadBusinessSheets({
          preferredEntity: activeEntity,
          businessId: targetBiz,
          forceRefresh: true,
        })
      );
      return {
        ...data,
        entity: activeEntity,
      };
    } catch (err) {
      return rejectWithValue({
        message: err.message || 'Failed to upload CSV file.',
      });
    }
  }
);

/**
 * Thunk: Append new rows to the active sheet from CSV ("Add Rows").
 * @type {any}
 */
export const appendSheetCsvFile = createAsyncThunk(
  'sheets/appendSheetCsvFile',
  async ({ file, entity }, { getState, dispatch, rejectWithValue }) => {
    try {
      const targetEntity =
        entity || getState().sheets?.activeEntity || '';
      const targetBiz =
        getState().sheets?.businessId || getActiveBusinessId();
      const data = await uploadSheetCsv(targetEntity, file, 'append', targetBiz);
      const activeEntity = data.entity || targetEntity;
      await dispatch(
        loadBusinessSheets({
          preferredEntity: activeEntity,
          businessId: targetBiz,
          forceRefresh: true,
        })
      );
      return {
        ...data,
        entity: activeEntity,
      };
    } catch (err) {
      return rejectWithValue({
        message: err.message || 'Failed to append CSV rows.',
      });
    }
  }
);

/**
 * Thunk: Insert a single new row with dynamic columns into the active table.
 * @type {any}
 */
export const insertSingleSheetRow = createAsyncThunk(
  'sheets/insertSingleSheetRow',
  async ({ entity, row }, { getState, dispatch, rejectWithValue }) => {
    try {
      const targetEntity =
        entity || getState().sheets?.activeEntity || '';
      const targetBiz =
        getState().sheets?.businessId || getActiveBusinessId();
      const data = await addSheetRow(targetEntity, row, targetBiz);
      const activeEntity = data.entity || targetEntity;
      if (!Array.isArray(data.rows)) {
        await dispatch(
          loadSheetRows({
            entity: activeEntity,
            businessId: targetBiz,
            forceRefresh: true,
          })
        );
      }
      return {
        ...data,
        businessId: targetBiz,
        entity: activeEntity,
      };
    } catch (err) {
      return rejectWithValue({
        message: err.message || 'Failed to add row to sheet.',
      });
    }
  }
);

/**
 * Thunk: Save manual inline spreadsheet cell edits into PostgreSQL.
 * PATCH /api/sheets/{entity}/rows
 * @type {any}
 */
export const saveManualSheetEdits = createAsyncThunk(
  'sheets/saveManualSheetEdits',
  async ({ entity, edits }, { getState, rejectWithValue }) => {
    try {
      const targetEntity = entity || getState().sheets?.activeEntity || '';
      const targetBiz = getState().sheets?.businessId || getActiveBusinessId();
      const data = await updateSheetRowsApi(targetEntity, edits, targetBiz);
      return {
        ...data,
        businessId: targetBiz,
        entity: data.entity || targetEntity,
      };
    } catch (err) {
      return rejectWithValue({
        message: err.message || 'Failed to save spreadsheet edits.',
      });
    }
  }
);

/**
 * Thunk: Remove a sheet/table and its database entries for the active workspace.
 * @type {any}
 */
export const removeSheetTable = createAsyncThunk(
  'sheets/removeSheetTable',
  async ({ entity, businessId } = {}, { getState, dispatch, rejectWithValue }) => {
    try {
      const targetEntity = String(
        entity || getState().sheets?.activeEntity || ''
      ).trim();
      const targetBiz = String(businessId || getActiveBusinessId() || '').trim();
      if (!targetEntity || !targetBiz) {
        throw new Error('Sheet entity and workspace ID are required.');
      }
      const data = await deleteSheetTable(targetEntity, targetBiz);
      const removedEntity = data.entity || targetEntity;
      removeCachedTableEntity(targetBiz, removedEntity);
      await dispatch(
        loadBusinessSheets({
          businessId: targetBiz,
          forceRefresh: true,
        })
      );
      return {
        ...data,
        entity: removedEntity,
      };
    } catch (err) {
      return rejectWithValue({
        message: err.message || 'Failed to remove sheet.',
      });
    }
  }
);

const initialState = {
  businessId: null,
  activeEntity: '',
  activeDisplayName: '',
  activeFileName: '',
  activeColumns: [],
  availableTables: [],
  rowsByEntity: {},
  sheetLoadStatus: 'idle',
  sheetLoadError: null,

  nlPrompt: '',

  // Natural-Language Query state
  queryStatus: 'idle',
  queryError: null,
  queryResult: null,

  // Two-Stage Mutation state
  mutationPreviewStatus: 'idle',
  mutationPreviewError: null,
  mutationPreview: null,

  mutationApplyStatus: 'idle',
  mutationApplyError: null,
  mutationApplySuccessMessage: null,

  csvUploadStatus: 'idle',
  csvUploadMessage: null,
  csvUploadError: null,

  csvAppendStatus: 'idle',
  csvAppendMessage: null,
  csvAppendError: null,

  // Dynamic Row Insert state
  rowInsertStatus: 'idle',
  rowInsertMessage: null,
  rowInsertError: null,

  // Sheet Delete state
  sheetDeleteStatus: 'idle',
  sheetDeleteError: null,
};

const sheetSlice = createSlice({
  name: 'sheets',
  initialState,
  reducers: {
    setActiveSheetEntity(state, action) {
      const entity = String(action.payload || '').trim();
      state.activeEntity = entity;
      if (!entity) {
        state.activeDisplayName = '';
        state.activeFileName = '';
        state.activeColumns = [];
      } else {
        const matched = state.availableTables.find(
          (t) => t.entity.toLowerCase() === entity.toLowerCase()
        );
        state.activeDisplayName =
          matched?.displayName ||
          entity.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
        state.activeFileName = matched?.fileName || `${entity}.csv`;
        if (matched && Array.isArray(matched.columns) && matched.columns.length > 0) {
          state.activeColumns = matched.columns;
        }
      }
      state.queryResult = null;
      state.queryError = null;
      state.queryStatus = 'idle';
    },
    setSheetNlPrompt(state, action) {
      state.nlPrompt = action.payload;
    },
    applySheetQueryPayload(state, action) {
      const payload = action.payload || {};
      const entity = String(payload.entity || state.activeEntity || '').trim();
      if (entity && entity.toLowerCase() !== String(state.activeEntity || '').toLowerCase()) {
        state.activeEntity = entity;
        const matched = state.availableTables.find(
          (t) => t.entity.toLowerCase() === entity.toLowerCase()
        );
        state.activeDisplayName =
          matched?.displayName ||
          entity.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
        state.activeFileName = matched?.fileName || `${entity}.csv`;
        if (matched && Array.isArray(matched.columns) && matched.columns.length > 0) {
          state.activeColumns = matched.columns;
        }
      }
      const rows = Array.isArray(payload.rows) ? payload.rows : [];
      const matchedIds = rows.map((r) => r.id).filter(Boolean);
      state.queryStatus = 'succeeded';
      state.queryError = null;
      state.mutationPreview = null;
      state.mutationPreviewError = null;
      state.mutationApplySuccessMessage = null;
      state.queryResult = {
        status: 'ok',
        entity: entity || state.activeEntity,
        promptUsed: payload.promptUsed || payload.prompt || '',
        matchedIds,
        count: Number(payload.count ?? rows.length),
        message: payload.answer || payload.message || null,
        interpretedQuery: payload.interpretedQuery || null,
        rows,
      };
    },
    clearSheetFiltersAndFeedback(state) {
      state.queryResult = null;
      state.queryError = null;
      state.queryStatus = 'idle';
      state.mutationPreview = null;
      state.mutationPreviewError = null;
      state.mutationPreviewStatus = 'idle';
      state.mutationApplyError = null;
      state.mutationApplySuccessMessage = null;
      state.csvUploadMessage = null;
      state.csvUploadError = null;
      state.csvAppendMessage = null;
      state.csvAppendError = null;
    },
    discardMutationPreview(state) {
      state.mutationPreview = null;
      state.mutationPreviewError = null;
      state.mutationPreviewStatus = 'idle';
    },
    clearRowInsertState(state) {
      state.rowInsertStatus = 'idle';
      state.rowInsertError = null;
      state.rowInsertMessage = null;
    },
    resetSheetWorkspaceState() {
      return { ...initialState };
    },
    hydrateWorkspaceTablesFromCache(state, action) {
      const payload = action.payload || {};
      const targetBizId = String(payload.businessId || '').trim();
      const tables = Array.isArray(payload.tables) ? payload.tables : [];
      const providedRowsByEntity =
        payload.rowsByEntity && typeof payload.rowsByEntity === 'object'
          ? payload.rowsByEntity
          : null;

      state.businessId = targetBizId || state.businessId;
      state.sheetLoadStatus = 'succeeded';
      state.sheetLoadError = null;
      state.availableTables = tables.map((t) => ({
        entity: t.entity,
        tableName: t.tableName || t.entity,
        displayName: t.displayName || t.entity,
        fileName: t.fileName || `${t.entity}.csv`,
        columns: Array.isArray(t.columns) ? t.columns : [],
        rowCount:
          typeof t.rowCount === 'number'
            ? t.rowCount
            : Array.isArray(t.rows)
              ? t.rows.length
              : 0,
      }));

      const nextRowsByEntity = {};
      for (const t of tables) {
        if (Array.isArray(t.rows) && t.rows.length > 0) {
          nextRowsByEntity[t.entity] = t.rows;
        } else if (
          providedRowsByEntity &&
          Array.isArray(providedRowsByEntity[t.entity])
        ) {
          nextRowsByEntity[t.entity] = providedRowsByEntity[t.entity];
        } else {
          nextRowsByEntity[t.entity] = Array.isArray(t.rows) ? t.rows : [];
        }
      }
      state.rowsByEntity = nextRowsByEntity;

      if (tables.length === 0) {
        state.activeEntity = '';
        state.activeDisplayName = '';
        state.activeFileName = '';
        state.activeColumns = [];
      } else {
        const preferred = payload.preferredEntity || state.activeEntity;
        const chosenTable =
          (preferred &&
            tables.find(
              (t) => t.entity.toLowerCase() === String(preferred).toLowerCase()
            )) ||
          tables[0];
        state.activeEntity = chosenTable.entity;
        state.activeDisplayName = chosenTable.displayName || chosenTable.entity;
        state.activeFileName =
          chosenTable.fileName || `${chosenTable.entity}.csv`;
        state.activeColumns = Array.isArray(chosenTable.columns)
          ? chosenTable.columns
          : [];
      }

      state.queryResult = null;
      state.queryError = null;
      state.queryStatus = 'idle';
      state.mutationPreview = null;
      state.mutationPreviewError = null;
      state.mutationPreviewStatus = 'idle';
      state.mutationApplyError = null;
      state.mutationApplySuccessMessage = null;
    },
  },
  extraReducers: (builder) => {
    builder
      // Load Business Sheets (Discovers only tables belonging to active businessId)
      .addCase(loadBusinessSheets.pending, (state, action) => {
        const isSilent = Boolean(action.meta?.arg?.silent);
        if (!isSilent) {
          state.sheetLoadStatus = 'loading';
          state.sheetLoadError = null;
          const currentBizId = getActiveBusinessId();
          if (state.businessId && state.businessId !== currentBizId) {
            state.businessId = currentBizId;
            state.availableTables = [];
            state.rowsByEntity = {};
            state.activeEntity = '';
            state.activeDisplayName = '';
            state.activeFileName = '';
            state.activeColumns = [];
            state.queryResult = null;
            state.mutationPreview = null;
          }
        }
      })
      .addCase(loadBusinessSheets.fulfilled, (state, action) => {
        const activeBizId = getActiveBusinessId();
        if (
          activeBizId &&
          action.payload?.businessId &&
          action.payload.businessId !== activeBizId
        ) {
          return;
        }
        state.sheetLoadStatus = 'succeeded';
        state.businessId = action.payload.businessId;
        const tables = Array.isArray(action.payload.tables)
          ? action.payload.tables
          : [];
        const cachedRowsMap =
          action.payload.rowsByEntity && typeof action.payload.rowsByEntity === 'object'
            ? action.payload.rowsByEntity
            : null;

        state.availableTables = tables.map((t) => ({
          entity: t.entity,
          tableName: t.tableName || t.entity,
          displayName: t.displayName || t.entity,
          fileName: t.fileName || `${t.entity}.csv`,
          columns: Array.isArray(t.columns) ? t.columns : [],
          rowCount:
            typeof t.rowCount === 'number'
              ? t.rowCount
              : Array.isArray(t.rows)
                ? t.rows.length
                : 0,
        }));

        const nextRowsByEntity = {};
        for (const t of tables) {
          if (Array.isArray(t.rows) && t.rows.length > 0) {
            nextRowsByEntity[t.entity] = t.rows;
          } else if (cachedRowsMap && Array.isArray(cachedRowsMap[t.entity])) {
            nextRowsByEntity[t.entity] = cachedRowsMap[t.entity];
          } else {
            nextRowsByEntity[t.entity] = Array.isArray(t.rows) ? t.rows : [];
          }
        }
        state.rowsByEntity = nextRowsByEntity;

        if (tables.length === 0) {
          state.activeEntity = '';
          state.activeDisplayName = '';
          state.activeFileName = '';
          state.activeColumns = [];
          state.queryResult = null;
          state.mutationPreview = null;
        } else {
          const preferred =
            action.payload.preferredEntity || state.activeEntity;
          const chosenTable =
            (preferred &&
              tables.find(
                (t) => t.entity.toLowerCase() === preferred.toLowerCase()
              )) ||
            tables[0];
          state.activeEntity = chosenTable.entity;
          state.activeDisplayName =
            chosenTable.displayName || chosenTable.entity;
          state.activeFileName =
            chosenTable.fileName || `${chosenTable.entity}.csv`;
          state.activeColumns = Array.isArray(chosenTable.columns)
            ? chosenTable.columns
            : [];
        }
      })
      .addCase(loadBusinessSheets.rejected, (state, action) => {
        const isSilent = Boolean(action.meta?.arg?.silent);
        if (isSilent && state.availableTables.length > 0) {
          return;
        }
        state.sheetLoadStatus = 'failed';
        state.sheetLoadError =
          action.payload?.message || 'Failed to load business sheets.';
      })

      // Load Sheet Rows
      .addCase(loadSheetRows.pending, (state, action) => {
        const isSilent = Boolean(
          action.meta?.arg &&
            typeof action.meta.arg === 'object' &&
            action.meta.arg.silent
        );
        if (!isSilent) {
          state.sheetLoadStatus = 'loading';
          state.sheetLoadError = null;
        }
      })
      .addCase(loadSheetRows.fulfilled, (state, action) => {
        if (action.payload?.isBusinessDiscovery) {
          state.sheetLoadStatus = 'succeeded';
          return;
        }
        const { businessId, entity, displayName, columns, rows } = action.payload;
        if (!entity) {
          state.sheetLoadStatus = 'succeeded';
          return;
        }
        const resolvedBizId = businessId || state.businessId || getActiveBusinessId();
        if (resolvedBizId) {
          patchCachedTableRows(resolvedBizId, entity, rows, {
            displayName,
            columns,
          });
        }
        const activeBizId = getActiveBusinessId();
        if (activeBizId && resolvedBizId && resolvedBizId !== activeBizId) {
          return;
        }
        state.sheetLoadStatus = 'succeeded';
        state.activeEntity = entity;
        if (displayName) state.activeDisplayName = displayName;
        if (Array.isArray(columns) && columns.length > 0) {
          state.activeColumns = columns;
        }
        state.rowsByEntity[entity] = rows;
        state.activeFileName = `${entity}.csv`;

        const existingIdx = state.availableTables.findIndex(
          (t) => t.entity.toLowerCase() === entity.toLowerCase()
        );
        if (existingIdx >= 0) {
          state.availableTables[existingIdx] = {
            ...state.availableTables[existingIdx],
            displayName:
              displayName || state.availableTables[existingIdx].displayName,
            columns:
              Array.isArray(columns) && columns.length > 0
                ? columns
                : state.availableTables[existingIdx].columns,
            rowCount: Array.isArray(rows) ? rows.length : 0,
          };
        } else if (Array.isArray(rows) && rows.length > 0) {
          state.availableTables.push({
            entity,
            tableName: entity,
            displayName: displayName || entity,
            fileName: `${entity}.csv`,
            columns: Array.isArray(columns) ? columns : [],
            rowCount: rows.length,
          });
        }
      })
      .addCase(loadSheetRows.rejected, (state, action) => {
        const isSilent = Boolean(
          action.meta?.arg &&
            typeof action.meta.arg === 'object' &&
            action.meta.arg.silent
        );
        if (isSilent && state.availableTables.length > 0) {
          return;
        }
        state.sheetLoadStatus = 'failed';
        state.sheetLoadError =
          action.payload?.message || 'Failed to load sheet records.';
      })

      // Natural-Language Query (or auto-detected Mutation Preview)
      .addCase(runSheetQuery.pending, (state) => {
        state.queryStatus = 'loading';
        state.queryError = null;
        state.mutationPreview = null;
        state.mutationPreviewError = null;
        state.mutationApplySuccessMessage = null;
      })
      .addCase(runSheetQuery.fulfilled, (state, action) => {
        state.queryStatus = 'succeeded';
        const payload = action.payload;

        const isMutationPayload =
          payload.status === 'preview' ||
          payload.status === 'not_found' ||
          ['update', 'update_many', 'create', 'delete'].includes(payload.operation);

        if (isMutationPayload) {
          state.mutationPreviewStatus = 'succeeded';
          state.mutationPreview = payload;
          if (payload.operation === 'create') {
            state.queryResult = null;
          } else if (Array.isArray(payload.target_rows)) {
            const targetIds = payload.target_rows
              .map((r) => r.id)
              .filter(Boolean);
            state.queryResult = {
              status:
                payload.status === 'clarification_needed'
                  ? 'clarification_needed'
                  : 'mutation_preview',
              entity: payload.entity || state.activeEntity,
              promptUsed: payload.promptUsed,
              matchedIds: targetIds,
              count: targetIds.length,
              message: payload.message || null,
              rows: payload.target_rows,
            };
          }
          return;
        }

        const rows = Array.isArray(payload.rows) ? payload.rows : [];
        const matchedIds = rows.map((r) => r.id).filter(Boolean);

        state.queryResult = {
          status: payload.status || 'ok',
          entity: payload.entity || state.activeEntity,
          promptUsed: payload.promptUsed,
          matchedIds,
          count: Number(payload.count ?? matchedIds.length),
          message: payload.message || null,
          interpretedQuery: payload.interpretedQuery || null,
          rows,
        };
      })
      .addCase(runSheetQuery.rejected, (state, action) => {
        state.queryStatus = 'failed';
        state.queryError =
          action.payload?.message || 'Failed to execute instruction.';
      })

      // Stage 1: Preview Mutation (confirm = false, or auto-detected Query)
      .addCase(previewSheetMutation.pending, (state) => {
        state.mutationPreviewStatus = 'loading';
        state.mutationPreviewError = null;
        state.mutationApplyError = null;
        state.mutationApplySuccessMessage = null;
        state.mutationPreview = null;
      })
      .addCase(previewSheetMutation.fulfilled, (state, action) => {
        state.mutationPreviewStatus = 'succeeded';
        const payload = action.payload;

        if (payload.operation === 'filter' && Array.isArray(payload.rows)) {
          state.mutationPreview = null;
          const rows = payload.rows;
          const matchedIds = rows.map((r) => r.id).filter(Boolean);
          state.queryResult = {
            status: payload.status || 'ok',
            entity: payload.entity || state.activeEntity,
            promptUsed: payload.promptUsed,
            matchedIds,
            count: Number(payload.count ?? matchedIds.length),
            message: payload.message || null,
            interpretedQuery: payload.interpretedQuery || null,
            rows,
          };
          return;
        }

        state.mutationPreview = payload;

        if (payload.operation === 'create') {
          state.queryResult = null;
        } else if (Array.isArray(payload.target_rows)) {
          const targetIds = payload.target_rows
            .map((r) => r.id)
            .filter(Boolean);
          state.queryResult = {
            status:
              payload.status === 'clarification_needed'
                ? 'clarification_needed'
                : 'mutation_preview',
            entity: payload.entity || state.activeEntity,
            promptUsed: payload.promptUsed,
            matchedIds: targetIds,
            count: targetIds.length,
            message: payload.message || null,
            rows: payload.target_rows,
          };
        }
      })
      .addCase(previewSheetMutation.rejected, (state, action) => {
        state.mutationPreviewStatus = 'failed';
        state.mutationPreviewError =
          action.payload?.message || 'Failed to preview modification.';
      })

      // Stage 2: Apply Confirmed Mutation (confirm = true)
      .addCase(applySheetMutation.pending, (state) => {
        state.mutationApplyStatus = 'loading';
        state.mutationApplyError = null;
      })
      .addCase(applySheetMutation.fulfilled, (state, action) => {
        state.mutationApplyStatus = 'succeeded';
        const payload = action.payload;
        const createdRows = Array.isArray(payload.created_rows)
          ? payload.created_rows
          : payload.created_row
            ? [payload.created_row]
            : [];
        const updatedRows = Array.isArray(payload.updated_rows)
          ? payload.updated_rows
          : createdRows;
        const deletedRows = Array.isArray(payload.deleted_rows)
          ? payload.deleted_rows
          : [];
        const updatedIds = updatedRows.map((r) => r.id).filter(Boolean);

        state.mutationPreview = null;
        state.mutationApplySuccessMessage =
          payload.message ||
          `Successfully applied modification (${
            payload.affected_count || updatedIds.length || deletedRows.length
          } record(s) affected).`;

        const targetEntity = payload.entity || state.activeEntity;
        const currentRows = Array.isArray(state.rowsByEntity[targetEntity])
          ? state.rowsByEntity[targetEntity]
          : [];

        if (payload.operation === 'delete') {
          const deletedIds = new Set(
            deletedRows.map((r) => r.id).filter(Boolean)
          );
          if (deletedIds.size > 0) {
            state.rowsByEntity[targetEntity] = currentRows.filter(
              (row) => !deletedIds.has(row.id)
            );
          }
          state.queryResult = null;
        } else if (payload.operation === 'create' && createdRows.length > 0) {
          const createdIds = new Set(
            createdRows.map((r) => r.id).filter(Boolean)
          );
          state.rowsByEntity[targetEntity] = [
            ...createdRows,
            ...currentRows.filter((row) => !createdIds.has(row.id)),
          ];
          state.queryResult = {
            status: 'ok',
            entity: targetEntity,
            promptUsed: payload.promptUsed,
            matchedIds: updatedIds,
            count: createdRows.length,
            message: payload.message || null,
            rows: createdRows,
          };
        } else if (updatedRows.length > 0) {
          const updatedMap = new Map(updatedRows.map((r) => [r.id, r]));
          state.rowsByEntity[targetEntity] = currentRows.map((row) =>
            updatedMap.has(row.id) ? updatedMap.get(row.id) : row
          );
          state.queryResult = {
            status: 'ok',
            entity: targetEntity,
            promptUsed: payload.promptUsed,
            matchedIds: updatedIds,
            count: updatedRows.length,
            message: payload.message || null,
            rows: updatedRows,
          };
        } else {
          state.queryResult = null;
        }

        const syncedRows = state.rowsByEntity[targetEntity];
        const mutatedBizId =
          payload.businessId || state.businessId || getActiveBusinessId();
        if (targetEntity && Array.isArray(syncedRows)) {
          const tblIdx = state.availableTables.findIndex(
            (t) => t.entity.toLowerCase() === targetEntity.toLowerCase()
          );
          if (tblIdx >= 0) {
            state.availableTables[tblIdx] = {
              ...state.availableTables[tblIdx],
              rowCount: syncedRows.length,
            };
          }
          if (mutatedBizId) {
            patchCachedTableRows(mutatedBizId, targetEntity, syncedRows);
          }
        }
      })
      .addCase(applySheetMutation.rejected, (state, action) => {
        state.mutationApplyStatus = 'failed';
        state.mutationApplyError =
          action.payload?.message || 'Failed to apply modification.';
      })

      // CSV Upload (Replace)
      .addCase(importSheetCsvFile.pending, (state) => {
        state.csvUploadStatus = 'loading';
        state.csvUploadError = null;
        state.csvUploadMessage = null;
        state.csvAppendMessage = null;
        state.csvAppendError = null;
      })
      .addCase(importSheetCsvFile.fulfilled, (state, action) => {
        state.csvUploadStatus = 'succeeded';
        const { imported_count, source_file, displayName, entity, columns } =
          action.payload;
        state.activeEntity = entity || state.activeEntity;
        if (displayName) state.activeDisplayName = displayName;
        if (Array.isArray(columns) && columns.length > 0) {
          state.activeColumns = columns;
        }
        const resolvedFileName =
          source_file ||
          action.meta?.arg?.file?.name ||
          `${entity || state.activeEntity}.csv`;
        state.activeFileName = resolvedFileName;
        state.csvUploadMessage =
          action.payload.message ||
          `Imported ${imported_count} record(s) into ${
            displayName || entity
          } from "${resolvedFileName}".`;
        state.queryResult = null;
        state.mutationPreview = null;
      })
      .addCase(importSheetCsvFile.rejected, (state, action) => {
        state.csvUploadStatus = 'failed';
        state.csvUploadError =
          action.payload?.message || 'Failed to import CSV file.';
      })

      // CSV Append ("Add Rows")
      .addCase(appendSheetCsvFile.pending, (state) => {
        state.csvAppendStatus = 'loading';
        state.csvAppendError = null;
        state.csvAppendMessage = null;
        state.csvUploadMessage = null;
        state.csvUploadError = null;
      })
      .addCase(appendSheetCsvFile.fulfilled, (state, action) => {
        state.csvAppendStatus = 'succeeded';
        const { imported_count, source_file, displayName, entity, columns } =
          action.payload;
        if (displayName) state.activeDisplayName = displayName;
        if (Array.isArray(columns) && columns.length > 0) {
          state.activeColumns = columns;
        }
        const resolvedFileName =
          source_file ||
          action.meta?.arg?.file?.name ||
          state.activeFileName;
        state.activeFileName = resolvedFileName;
        state.csvAppendMessage =
          action.payload.message ||
          `Appended ${imported_count} row(s) to ${
            displayName || entity
          } from "${resolvedFileName}".`;
      })
      .addCase(appendSheetCsvFile.rejected, (state, action) => {
        state.csvAppendStatus = 'failed';
        state.csvAppendError =
          action.payload?.message || 'Failed to append CSV rows.';
      })

      // Dynamic Single Row Insert
      .addCase(insertSingleSheetRow.pending, (state) => {
        state.rowInsertStatus = 'loading';
        state.rowInsertError = null;
        state.rowInsertMessage = null;
      })
      .addCase(insertSingleSheetRow.fulfilled, (state, action) => {
        state.rowInsertStatus = 'succeeded';
        state.rowInsertMessage =
          action.payload?.message || 'Row added successfully.';
        if (action.payload?.displayName) {
          state.activeDisplayName = action.payload.displayName;
        }
        const targetEntity = action.payload?.entity || state.activeEntity;
        if (Array.isArray(action.payload?.rows)) {
          state.rowsByEntity[targetEntity] = action.payload.rows;
          const tblIdx = state.availableTables.findIndex(
            (t) => t.entity.toLowerCase() === String(targetEntity || '').toLowerCase()
          );
          if (tblIdx >= 0) {
            state.availableTables[tblIdx] = {
              ...state.availableTables[tblIdx],
              rowCount: action.payload.rows.length,
            };
          }
          const targetBizId =
            action.payload?.businessId || state.businessId || getActiveBusinessId();
          if (targetBizId && targetEntity) {
            patchCachedTableRows(targetBizId, targetEntity, action.payload.rows);
          }
        }
      })
      .addCase(insertSingleSheetRow.rejected, (state, action) => {
        state.rowInsertStatus = 'failed';
        state.rowInsertError =
          action.payload?.message || 'Failed to add row to sheet.';
      })

      // Manual Inline Spreadsheet Edits Save
      .addCase(saveManualSheetEdits.fulfilled, (state, action) => {
        const targetEntity = action.payload?.entity || state.activeEntity;
        const updatedRows = Array.isArray(action.payload?.updated_rows)
          ? action.payload.updated_rows
          : [];
        const updatedById = new Map(updatedRows.map((r) => [String(r.id), r]));

        if (Array.isArray(action.payload?.rows)) {
          state.rowsByEntity[targetEntity] = action.payload.rows;
        } else if (updatedById.size > 0 && Array.isArray(state.rowsByEntity[targetEntity])) {
          state.rowsByEntity[targetEntity] = state.rowsByEntity[targetEntity].map((row) =>
            updatedById.has(String(row.id)) ? updatedById.get(String(row.id)) : row
          );
        }

        if (
          state.queryResult &&
          Array.isArray(state.queryResult.rows) &&
          updatedById.size > 0
        ) {
          state.queryResult.rows = state.queryResult.rows.map((row) =>
            updatedById.has(String(row.id)) ? updatedById.get(String(row.id)) : row
          );
        }

        const nextRows = state.rowsByEntity[targetEntity];
        const targetBizId =
          action.payload?.businessId || state.businessId || getActiveBusinessId();
        if (targetBizId && targetEntity && Array.isArray(nextRows)) {
          patchCachedTableRows(targetBizId, targetEntity, nextRows);
        }
      })

      // Remove Sheet Table
      .addCase(removeSheetTable.pending, (state) => {
        state.sheetDeleteStatus = 'loading';
        state.sheetDeleteError = null;
      })
      .addCase(removeSheetTable.fulfilled, (state, action) => {
        state.sheetDeleteStatus = 'succeeded';
        const removedEntity = String(action.payload?.entity || '').trim().toLowerCase();
        if (removedEntity) {
          delete state.rowsByEntity[removedEntity];
          if (String(state.activeEntity || '').toLowerCase() === removedEntity) {
            state.queryResult = null;
            state.queryError = null;
            state.mutationPreview = null;
            state.mutationPreviewError = null;
            state.mutationApplySuccessMessage = null;
          }
        }
      })
      .addCase(removeSheetTable.rejected, (state, action) => {
        state.sheetDeleteStatus = 'failed';
        state.sheetDeleteError =
          action.payload?.message || 'Failed to remove sheet.';
      });
  },
});

export const {
  setActiveSheetEntity,
  setSheetNlPrompt,
  applySheetQueryPayload,
  clearSheetFiltersAndFeedback,
  discardMutationPreview,
  clearRowInsertState,
  resetSheetWorkspaceState,
  hydrateWorkspaceTablesFromCache,
} = sheetSlice.actions;

export default sheetSlice.reducer;
