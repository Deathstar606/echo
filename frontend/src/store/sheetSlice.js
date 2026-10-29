import { createSlice, createAsyncThunk } from '@reduxjs/toolkit';
import {
  fetchSheetRows,
  querySheet,
  mutateSheet,
  uploadSheetCsv,
} from '../services/api';

/**
 * Thunk: Fetch full Products sheet from PostgreSQL.
 * GET /api/sheets/products?businessId={BUSINESS_ID}
 */
export const loadSheetRows = createAsyncThunk(
  'sheets/loadSheetRows',
  async (_entity = 'products', { rejectWithValue }) => {
    try {
      const data = await fetchSheetRows('products');
      return {
        entity: 'products',
        rows: Array.isArray(data?.rows) ? data.rows : [],
      };
    } catch (err) {
      return rejectWithValue({
        message: err.message || 'Failed to load products sheet records.',
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
  async ({ entity = 'products', message }, { rejectWithValue }) => {
    try {
      const data = await querySheet({ entity: 'products', message });
      return {
        ...data,
        entity: 'products',
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
  async ({ entity = 'products', message }, { rejectWithValue }) => {
    try {
      const data = await mutateSheet({
        entity: 'products',
        message,
        confirm: false,
      });
      return {
        ...data,
        entity: 'products',
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
  async ({ entity = 'products', message }, { dispatch, rejectWithValue }) => {
    try {
      const data = await mutateSheet({
        entity: 'products',
        message,
        confirm: true,
      });
      // Refresh the products sheet from the database after confirmed mutation
      await dispatch(loadSheetRows('products'));
      return {
        ...data,
        entity: 'products',
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
 * Thunk: Upload CSV file to replace Products sheet.
 */
export const importSheetCsvFile = createAsyncThunk(
  'sheets/importSheetCsvFile',
  async ({ file }, { dispatch, rejectWithValue }) => {
    try {
      const data = await uploadSheetCsv('products', file);
      await dispatch(loadSheetRows('products'));
      return {
        ...data,
        entity: 'products',
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
};

const sheetSlice = createSlice({
  name: 'sheets',
  initialState,
  reducers: {
    setActiveSheetEntity(state) {
      state.activeEntity = 'products';
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
    },
    discardMutationPreview(state) {
      state.mutationPreview = null;
      state.mutationPreviewError = null;
      state.mutationPreviewStatus = 'idle';
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
        const { rows } = action.payload;
        state.rowsByEntity.products = rows;
      })
      .addCase(loadSheetRows.rejected, (state, action) => {
        state.sheetLoadStatus = 'failed';
        state.sheetLoadError =
          action.payload?.message || 'Failed to load products sheet records.';
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
          entity: 'products',
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

        // Also highlight target rows in the spreadsheet table!
        if (Array.isArray(payload.target_rows)) {
          const targetIds = payload.target_rows.map((r) => r.id).filter(Boolean);
          state.queryResult = {
            status:
              payload.status === 'clarification_needed'
                ? 'clarification_needed'
                : 'mutation_preview',
            entity: 'products',
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
            entity: 'products',
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

      // CSV Upload
      .addCase(importSheetCsvFile.pending, (state) => {
        state.csvUploadStatus = 'loading';
        state.csvUploadError = null;
        state.csvUploadMessage = null;
      })
      .addCase(importSheetCsvFile.fulfilled, (state, action) => {
        state.csvUploadStatus = 'succeeded';
        const { imported_count, source_file } = action.payload;
        state.csvUploadMessage = `Imported ${imported_count} product record(s) from "${source_file}".`;
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
} = sheetSlice.actions;

export default sheetSlice.reducer;
