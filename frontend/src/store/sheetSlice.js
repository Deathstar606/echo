import { createSlice, createAsyncThunk } from '@reduxjs/toolkit';
import {
  fetchSheetRows,
  querySheet,
  mutateSheet,
  generateSheetData,
  saveGeneratedSheetData,
  uploadSheetCsv,
} from '../services/api';

/**
 * Thunk: Fetch full Products or Services sheet from PostgreSQL.
 * GET /api/sheets/{entity}?businessId={BUSINESS_ID}
 */
export const loadSheetRows = createAsyncThunk(
  'sheets/loadSheetRows',
  async (entity, { rejectWithValue }) => {
    try {
      const normalized =
        String(entity || '').toLowerCase() === 'services'
          ? 'services'
          : 'products';
      const data = await fetchSheetRows(normalized);
      return {
        entity: normalized,
        rows: Array.isArray(data?.rows) ? data.rows : [],
      };
    } catch (err) {
      return rejectWithValue({
        message: err.message || `Failed to load ${entity} sheet records.`,
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
  async ({ entity, message }, { rejectWithValue }) => {
    try {
      const data = await querySheet({ entity, message });
      return {
        ...data,
        entity,
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
  async ({ entity, message }, { rejectWithValue }) => {
    try {
      const data = await mutateSheet({
        entity,
        message,
        confirm: false,
      });
      return {
        ...data,
        entity,
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
  async ({ entity, message }, { dispatch, rejectWithValue }) => {
    try {
      const data = await mutateSheet({
        entity,
        message,
        confirm: true,
      });
      // Refresh the active sheet from the database after confirmed mutation
      await dispatch(loadSheetRows(entity));
      return {
        ...data,
        entity,
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
 * Thunk: Generate New Sample Sheet Data (Unsaved Draft Preview).
 * POST /api/businesses/{BUSINESS_ID}/sheets/generate
 */
export const generateNewSheetDraft = createAsyncThunk(
  'sheets/generateNewSheetDraft',
  async ({ entity, count = 5, prompt = '' }, { rejectWithValue }) => {
    try {
      const data = await generateSheetData({ entity, count, prompt });
      return {
        entity,
        rows: Array.isArray(data?.rows) ? data.rows : [],
        count: Number(data?.count || data?.rows?.length || 0),
      };
    } catch (err) {
      return rejectWithValue({
        message:
          err.message || `Failed to generate sample ${entity} sheet records.`,
      });
    }
  }
);

/**
 * Thunk: Save Generated Sheet Data to PostgreSQL (Append or Replace with confirm: true).
 * POST /api/businesses/{BUSINESS_ID}/sheets/generate/save
 */
export const saveGeneratedDraftToDb = createAsyncThunk(
  'sheets/saveGeneratedDraftToDb',
  async ({ entity, rows, mode = 'append' }, { dispatch, rejectWithValue }) => {
    try {
      const data = await saveGeneratedSheetData({
        entity,
        rows,
        mode,
        confirm: true,
      });
      // Refresh sheet from database after saving generated records
      await dispatch(loadSheetRows(entity));
      return {
        ...data,
        entity,
        mode,
      };
    } catch (err) {
      return rejectWithValue({
        message:
          err.message || `Failed to save generated ${entity} records to database.`,
      });
    }
  }
);

/**
 * Thunk: Upload CSV file to replace Products or Services sheet.
 */
export const importSheetCsvFile = createAsyncThunk(
  'sheets/importSheetCsvFile',
  async ({ entity, file }, { dispatch, rejectWithValue }) => {
    try {
      const data = await uploadSheetCsv(entity, file);
      await dispatch(loadSheetRows(entity));
      return {
        ...data,
        entity,
      };
    } catch (err) {
      return rejectWithValue({
        message: err.message || 'Failed to upload CSV file.',
      });
    }
  }
);

const initialState = {
  activeEntity: 'products',
  rowsByEntity: {
    products: [],
    services: [],
  },
  sheetLoadStatus: 'idle',
  sheetLoadError: null,

  nlPrompt: 'List products that are out of stock.',

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

  // Generate New Sheet Data (Unsaved Draft) state
  generatedDraftByEntity: {
    products: null,
    services: null,
  },
  generateStatus: 'idle',
  generateError: null,
  saveGeneratedStatus: 'idle',
  saveGeneratedError: null,
  saveGeneratedSuccessMessage: null,

  csvUploadStatus: 'idle',
  csvUploadMessage: null,
  csvUploadError: null,
};

const sheetSlice = createSlice({
  name: 'sheets',
  initialState,
  reducers: {
    setActiveSheetEntity(state, action) {
      const nextEntity =
        action.payload === 'services' ? 'services' : 'products';
      if (state.activeEntity !== nextEntity) {
        state.activeEntity = nextEntity;
        state.queryResult = null;
        state.queryError = null;
        state.mutationPreview = null;
        state.mutationPreviewError = null;
        state.mutationApplyError = null;
        state.mutationApplySuccessMessage = null;
        state.generateError = null;
        state.saveGeneratedError = null;
        state.saveGeneratedSuccessMessage = null;
        state.csvUploadMessage = null;
        state.csvUploadError = null;
        state.nlPrompt =
          nextEntity === 'services'
            ? 'Show unavailable services.'
            : 'List products that are out of stock.';
      }
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
      state.saveGeneratedSuccessMessage = null;
      state.csvUploadMessage = null;
      state.csvUploadError = null;
    },
    discardMutationPreview(state) {
      state.mutationPreview = null;
      state.mutationPreviewError = null;
      state.mutationPreviewStatus = 'idle';
    },
    discardGeneratedDraft(state, action) {
      const targetEntity = action.payload || state.activeEntity;
      state.generatedDraftByEntity[targetEntity] = null;
      state.generateStatus = 'idle';
      state.generateError = null;
      state.saveGeneratedError = null;
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
        const { entity, rows } = action.payload;
        state.rowsByEntity[entity] = rows;
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
        state.saveGeneratedSuccessMessage = null;
      })
      .addCase(runSheetQuery.fulfilled, (state, action) => {
        state.queryStatus = 'succeeded';
        const payload = action.payload;
        const rows = Array.isArray(payload.rows) ? payload.rows : [];
        const matchedIds = rows.map((r) => r.id).filter(Boolean);

        state.queryResult = {
          status: payload.status || 'ok',
          entity: payload.entity,
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
        state.saveGeneratedSuccessMessage = null;
      })
      .addCase(previewSheetMutation.fulfilled, (state, action) => {
        state.mutationPreviewStatus = 'succeeded';
        const payload = action.payload;
        state.mutationPreview = payload;

        // Also highlight target rows in the spreadsheet table!
        if (Array.isArray(payload.target_rows)) {
          const targetIds = payload.target_rows.map((r) => r.id).filter(Boolean);
          state.queryResult = {
            status: payload.status === 'clarification_needed' ? 'clarification_needed' : 'mutation_preview',
            entity: payload.entity,
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
          `Successfully updated ${payload.affected_count || updatedIds.length} record(s).`;

        if (updatedIds.length > 0) {
          state.queryResult = {
            status: 'ok',
            entity: payload.entity,
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

      // Generate New Sheet Draft
      .addCase(generateNewSheetDraft.pending, (state) => {
        state.generateStatus = 'loading';
        state.generateError = null;
        state.saveGeneratedError = null;
        state.saveGeneratedSuccessMessage = null;
        state.mutationApplySuccessMessage = null;
      })
      .addCase(generateNewSheetDraft.fulfilled, (state, action) => {
        state.generateStatus = 'succeeded';
        const { entity, rows, count } = action.payload;
        state.generatedDraftByEntity[entity] = {
          rows,
          count,
          generatedAt: new Date().toISOString(),
        };
      })
      .addCase(generateNewSheetDraft.rejected, (state, action) => {
        state.generateStatus = 'failed';
        state.generateError =
          action.payload?.message || 'Failed to generate sample sheet data.';
      })

      // Save Generated Draft
      .addCase(saveGeneratedDraftToDb.pending, (state) => {
        state.saveGeneratedStatus = 'loading';
        state.saveGeneratedError = null;
      })
      .addCase(saveGeneratedDraftToDb.fulfilled, (state, action) => {
        state.saveGeneratedStatus = 'succeeded';
        const { entity, saved_count, mode, rows } = action.payload;
        state.generatedDraftByEntity[entity] = null;
        state.saveGeneratedSuccessMessage = `Saved ${saved_count} generated ${entity} record(s) (${mode === 'replace' ? 'replaced existing sheet records' : 'appended to sheet'}).`;
        if (Array.isArray(rows) && rows.length > 0) {
          state.queryResult = {
            status: 'ok',
            entity,
            promptUsed: 'Saved AI-generated sample records',
            matchedIds: rows.map((r) => r.id).filter(Boolean),
            count: rows.length,
            message: state.saveGeneratedSuccessMessage,
            rows,
          };
        }
      })
      .addCase(saveGeneratedDraftToDb.rejected, (state, action) => {
        state.saveGeneratedStatus = 'failed';
        state.saveGeneratedError =
          action.payload?.message || 'Failed to save generated records.';
      })

      // CSV Upload
      .addCase(importSheetCsvFile.pending, (state) => {
        state.csvUploadStatus = 'loading';
        state.csvUploadError = null;
        state.csvUploadMessage = null;
      })
      .addCase(importSheetCsvFile.fulfilled, (state, action) => {
        state.csvUploadStatus = 'succeeded';
        const { imported_count, entity, source_file } = action.payload;
        state.csvUploadMessage = `Imported ${imported_count} ${entity} record(s) from "${source_file}".`;
        state.queryResult = null;
        state.mutationPreview = null;
      })
      .addCase(importSheetCsvFile.rejected, (state, action) => {
        state.csvUploadStatus = 'failed';
        state.csvUploadError =
          action.payload?.message || 'Failed to import CSV file.';
      });
  },
});

export const {
  setActiveSheetEntity,
  setSheetNlPrompt,
  clearSheetFiltersAndFeedback,
  discardMutationPreview,
  discardGeneratedDraft,
} = sheetSlice.actions;

export default sheetSlice.reducer;
