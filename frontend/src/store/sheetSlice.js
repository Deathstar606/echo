import { createSlice, createAsyncThunk } from '@reduxjs/toolkit';
import {
  fetchSheetRows,
  querySheet,
  mutateSheet,
  uploadSheetCsv,
  addSheetRow,
} from '../services/api';

/**
 * Thunk: Fetch full active inventory sheet from PostgreSQL.
 * GET /api/sheets/{entity}?businessId={BUSINESS_ID}
 */
export const loadSheetRows = createAsyncThunk(
  'sheets/loadSheetRows',
  async (entityArg, { getState, rejectWithValue }) => {
    try {
      const targetEntity =
        entityArg || getState().sheets?.activeEntity || 'products';
      const data = await fetchSheetRows(targetEntity);
      return {
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
 */
export const runSheetQuery = createAsyncThunk(
  'sheets/runSheetQuery',
  async ({ entity, message }, { getState, rejectWithValue }) => {
    try {
      const targetEntity =
        entity || getState().sheets?.activeEntity || 'products';
      const data = await querySheet({ entity: targetEntity, message });
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
 */
export const previewSheetMutation = createAsyncThunk(
  'sheets/previewSheetMutation',
  async ({ entity, message }, { getState, rejectWithValue }) => {
    try {
      const targetEntity =
        entity || getState().sheets?.activeEntity || 'products';
      const data = await mutateSheet({
        entity: targetEntity,
        message,
        confirm: false,
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
 */
export const applySheetMutation = createAsyncThunk(
  'sheets/applySheetMutation',
  async ({ entity, message }, { getState, dispatch, rejectWithValue }) => {
    try {
      const targetEntity =
        entity || getState().sheets?.activeEntity || 'products';
      const data = await mutateSheet({
        entity: targetEntity,
        message,
        confirm: true,
      });
      // Refresh the active sheet from the database after confirmed mutation
      await dispatch(loadSheetRows(targetEntity));
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
 * Thunk: Upload CSV file to replace records in the active sheet.
 */
export const importSheetCsvFile = createAsyncThunk(
  'sheets/importSheetCsvFile',
  async ({ file, entity }, { getState, dispatch, rejectWithValue }) => {
    try {
      const targetEntity =
        entity || getState().sheets?.activeEntity || 'products';
      const data = await uploadSheetCsv(targetEntity, file, 'replace');
      const activeEntity = data.entity || targetEntity;
      await dispatch(loadSheetRows(activeEntity));
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
 */
export const appendSheetCsvFile = createAsyncThunk(
  'sheets/appendSheetCsvFile',
  async ({ file, entity }, { getState, dispatch, rejectWithValue }) => {
    try {
      const targetEntity =
        entity || getState().sheets?.activeEntity || 'products';
      const data = await uploadSheetCsv(targetEntity, file, 'append');
      const activeEntity = data.entity || targetEntity;
      await dispatch(loadSheetRows(activeEntity));
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
 */
export const insertSingleSheetRow = createAsyncThunk(
  'sheets/insertSingleSheetRow',
  async ({ entity, row }, { getState, dispatch, rejectWithValue }) => {
    try {
      const targetEntity =
        entity || getState().sheets?.activeEntity || 'products';
      const data = await addSheetRow(targetEntity, row);
      const activeEntity = data.entity || targetEntity;
      await dispatch(loadSheetRows(activeEntity));
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
  activeEntity: 'products',
  activeDisplayName: 'Products',
  activeFileName: 'products.csv',
  activeColumns: [],
  rowsByEntity: {
    products: [],
  },
  sheetLoadStatus: 'idle',
  sheetLoadError: null,

  nlPrompt: 'Show all best-selling products.',

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
      const entity = action.payload || 'products';
      state.activeEntity = entity;
      state.activeFileName = `${entity}.csv`;
    },
    setSheetNlPrompt(state, action) {
      state.nlPrompt = action.payload;
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
  },
  extraReducers: (builder) => {
    builder
      // Load Sheet Rows
      .addCase(loadSheetRows.pending, (state) => {
        state.sheetLoadStatus = 'loading';
        state.sheetLoadError = null;
      })
      .addCase(loadSheetRows.fulfilled, (state, action) => {
        state.sheetLoadStatus = 'succeeded';
        const { entity, displayName, columns, rows } = action.payload;
        state.activeEntity = entity;
        if (displayName) state.activeDisplayName = displayName;
        if (Array.isArray(columns) && columns.length > 0) {
          state.activeColumns = columns;
        }
        state.rowsByEntity[entity] = rows;
        if (!state.activeFileName) {
          state.activeFileName = `${entity}.csv`;
        }
      })
      .addCase(loadSheetRows.rejected, (state, action) => {
        state.sheetLoadStatus = 'failed';
        state.sheetLoadError =
          action.payload?.message || 'Failed to load sheet records.';
      })

      // Natural-Language Query
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
          action.payload?.message || 'Failed to execute query.';
      })

      // Stage 1: Preview Mutation (confirm = false)
      .addCase(previewSheetMutation.pending, (state) => {
        state.mutationPreviewStatus = 'loading';
        state.mutationPreviewError = null;
        state.mutationApplyError = null;
        state.mutationApplySuccessMessage = null;
      })
      .addCase(previewSheetMutation.fulfilled, (state, action) => {
        state.mutationPreviewStatus = 'succeeded';
        const payload = action.payload;
        state.mutationPreview = payload;

        if (Array.isArray(payload.target_rows)) {
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
        const updatedRows = Array.isArray(payload.updated_rows)
          ? payload.updated_rows
          : [];
        const updatedIds = updatedRows.map((r) => r.id).filter(Boolean);

        state.mutationPreview = null;
        state.mutationApplySuccessMessage =
          payload.message ||
          `Successfully updated ${
            payload.affected_count || updatedIds.length
          } record(s).`;

        if (updatedIds.length > 0) {
          state.queryResult = {
            status: 'ok',
            entity: payload.entity || state.activeEntity,
            promptUsed: payload.promptUsed,
            matchedIds: updatedIds,
            count: updatedIds.length,
            message: state.mutationApplySuccessMessage,
            rows: updatedRows,
          };
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
  clearSheetFiltersAndFeedback,
  discardMutationPreview,
  clearRowInsertState,
} = sheetSlice.actions;

export default sheetSlice.reducer;
