const express = require('express');
const { findBusinessOrThrow } = require('../controllers/businessController');
const {
  listGoogleDocs,
  importGoogleDocToRAG,
} = require('../services/googleDocsParserService');
const router = express.Router();

// GET /api/google/docs/list
router.get('/list', async (req, res, next) => {
  try {
    const businessId = req.query.workspaceId || req.query.workspace_id || req.query.businessId || req.query.business_id || '';
    const requestUserId = req.headers['x-user-id'] || req.query.userId || req.query.user_id || null;
    if (businessId && requestUserId) {
      await findBusinessOrThrow(String(businessId), requestUserId);
    }
    const docs = await listGoogleDocs(businessId || requestUserId || '');
    return res.json({ success: true, count: docs.length, files: docs });
  } catch (err) {
    return next(err);
  }
});

// POST /api/google/docs/import
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
    const documentId = body.documentId;
    const result = await importGoogleDocToRAG(businessId, documentId);
    return res.json(result);
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
