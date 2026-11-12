import { createSlice, createAsyncThunk } from '@reduxjs/toolkit';
import {
  fetchBusinessSheets,
  fetchSheetRows,
  querySheet,
  mutateSheet,
  uploadSheetCsv,
  addSheetRow,
} from '../services/api';
import { getActiveBusinessId } from '../config/constants';

/**
 * Thunk: Discover and load all spreadsheet tables that belong to the active businessId.
 * GET /api/sheets/tables?businessId={BUSINESS_ID}
 * @type {any}
 */
export const loadBusinessSheets = createAsyncThunk(
  'sheets/loadBusinessSheets',
  async (arg = null, { rejectWithValue }) => {
    try {
      const preferredEntity =
        typeof arg === 'string'
          ? arg
          : arg && typeof arg === 'object'
            ? arg.preferredEntity
            : null;
      const businessId =
        arg && typeof arg === 'object' && arg.businessId !== undefined
          ? String(arg.businessId || '').trim()
          : getActiveBusinessId();

      if (!businessId) {
        return {
          businessId: '',
          tables: [],
          preferredEntity: null,
        };
      }

      const data = await fetchBusinessSheets(businessId);
      const tables = Array.isArray(data?.tables) ? data.tables : [];
      return {
        businessId: data?.business_id || businessId,
        tables,
        preferredEntity: preferredEntity ? String(preferredEntity).trim() : null,
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
      const targetEntity = String(
        entityArg || getState().sheets?.activeEntity || ''
      ).trim();
      if (!targetEntity) {
        const res = await dispatch(loadBusinessSheets()).unwrap();
        return {
          isBusinessDiscovery: true,
          ...res,
        };
      }
      const data = await fetchSheetRows(targetEntity);
      return {
        isBusinessDiscovery: false,
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
      });
      return {
        ...data,
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
  async ({ file, entity }, { dispatch, rejectWithValue }) => {
    try {
      const targetEntity = entity ? String(entity).trim() : '';
      const data = await uploadSheetCsv(targetEntity, file, 'replace');
      const activeEntity = data.entity || targetEntity;
      await dispatch(loadBusinessSheets(activeEntity));
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
      const data = await uploadSheetCsv(targetEntity, file, 'append');
      const activeEntity = data.entity || targetEntity;
      await dispatch(loadBusinessSheets(activeEntity));
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
      const data = await addSheetRow(targetEntity, row);
      const activeEntity = data.entity || targetEntity;
      if (!Array.isArray(data.rows)) {
        await dispatch(loadSheetRows(activeEntity));
      }
      return {
        ...data,
        entity: activeEntity,
      };
    } catch (err) {
      return rejectWithValue({
        message: err.message || 'Failed to add row to sheet.',
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
  },
  extraReducers: (builder) => {
    builder
      // Load Business Sheets (Discovers only tables belonging to active businessId)
      .addCase(loadBusinessSheets.pending, (state) => {
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
      })
      .addCase(loadBusinessSheets.fulfilled, (state, action) => {
        state.sheetLoadStatus = 'succeeded';
        state.businessId = action.payload.businessId;
        const tables = Array.isArray(action.payload.tables)
          ? action.payload.tables
          : [];

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
          nextRowsByEntity[t.entity] = Array.isArray(t.rows) ? t.rows : [];
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
        state.sheetLoadStatus = 'failed';
        state.sheetLoadError =
          action.payload?.message || 'Failed to load business sheets.';
      })

      // Load Sheet Rows
      .addCase(loadSheetRows.pending, (state) => {
        state.sheetLoadStatus = 'loading';
        state.sheetLoadError = null;
      })
      .addCase(loadSheetRows.fulfilled, (state, action) => {
        state.sheetLoadStatus = 'succeeded';
        if (action.payload?.isBusinessDiscovery) {
          return;
        }
        const { entity, displayName, columns, rows } = action.payload;
        if (!entity) return;
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
        }
      })
      .addCase(insertSingleSheetRow.rejected, (state, action) => {
        state.rowInsertStatus = 'failed';
        state.rowInsertError =
          action.payload?.message || 'Failed to add row to sheet.';
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
} = sheetSlice.actions;

export default sheetSlice.reducer;
