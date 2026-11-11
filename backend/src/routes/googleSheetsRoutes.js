const express = require('express');
const { findBusinessOrThrow } = require('../controllers/businessController');
const {
  listGoogleSpreadsheets,
  importGoogleSheetToPostgres,
  getSyncedSheetsMetadata,
} = require('../services/googleSheetsSyncService');
const router = express.Router();

// GET /api/google/sheets/list
router.get('/list', async (req, res, next) => {
  try {
    const businessId = req.query.workspaceId || req.query.workspace_id || req.query.businessId || req.query.business_id || '';
    const requestUserId = req.headers['x-user-id'] || req.query.userId || req.query.user_id || null;
    if (businessId && requestUserId) {
      await findBusinessOrThrow(String(businessId), requestUserId);
    }
    const spreadsheets = await listGoogleSpreadsheets(businessId || requestUserId || '');
    return res.json({ success: true, count: spreadsheets.length, files: spreadsheets });
  } catch (err) {
    return next(err);
  }
});

// POST /api/google/sheets/import
router.post('/import', async (req, res, next) => {
  try {
    const body = req.body || {};
    const businessId =
      body.workspaceId ||
      body.workspace_id ||
      body.businessId ||
      body.business_id ||
      req.query.workspaceId ||
      req.query.workspace_id ||
      req.query.businessId ||
      req.query.business_id ||
      '';
    const requestUserId = req.headers['x-user-id'] || body.userId || body.user_id || req.query.userId || null;
    if (businessId && requestUserId) {
      await findBusinessOrThrow(String(businessId), requestUserId);
    }
    const { spreadsheetId, sheetTabName, customEntityName } = body;
    const result = await importGoogleSheetToPostgres(businessId, {
      spreadsheetId,
      sheetTabName,
      customEntityName,
    });
    return res.json(result);
  } catch (err) {
    return next(err);
  }
});

// GET /api/google/sheets/synced
router.get('/synced', async (req, res, next) => {
  try {
    const businessId = req.query.workspaceId || req.query.workspace_id || req.query.businessId || req.query.business_id || '';
    const requestUserId = req.headers['x-user-id'] || req.query.userId || req.query.user_id || null;
    if (businessId && requestUserId) {
      await findBusinessOrThrow(String(businessId), requestUserId);
    }
    const sheets = await getSyncedSheetsMetadata(businessId);
    return res.json({ success: true, sheets });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
