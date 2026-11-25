const express = require('express');
const { query } = require('../../db');
const {
  getUserWorkspaces,
  hasWorkspaceAccess,
  shareWorkspaceWithUser,
  getWorkspaceShares,
  revokeWorkspaceShare,
  createWorkspaceForUser,
  updateWorkspaceName,
} = require('../services/operations/authService');
const {
  getDocumentChunks,
  updateDocument,
  deleteDocument,
} = require('../controllers/workspaceController');
const AppError = require('../utils/AppError');
const router = express.Router();

// GET /api/workspaces?userId=...
router.get('/', async (req, res, next) => {
  try {
    const userId =
      req.query.userId ||
      req.query.user_id ||
      req.headers['x-user-id'] ||
      null;
    if (!userId || !String(userId).trim()) {
      return res.json({ success: true, count: 0, workspaces: [] });
    }
    const workspaces = await getUserWorkspaces(String(userId).trim());
    return res.json({ success: true, count: workspaces.length, workspaces });
  } catch (err) {
    return next(err);
  }
});

// POST /api/workspaces
router.post('/', async (req, res, next) => {
  try {
    const { name, userId, user_id } = req.body || {};
    const targetUserId = userId || user_id || req.headers['x-user-id'];
    if (!targetUserId) {
      throw new AppError('userId is required to create a workspace.', 400);
    }
    const ws = await createWorkspaceForUser({ name, userId: String(targetUserId).trim() });
    return res.status(201).json({ success: true, workspace: ws });
  } catch (err) {
    return next(err);
  }
});

// GET /api/workspaces/:workspaceId
router.get('/:workspaceId', async (req, res, next) => {
  try {
    const { workspaceId } = req.params;
    const requestUserId =
      req.query.userId ||
      req.query.user_id ||
      req.headers['x-user-id'] ||
      null;
    const result = await query(
      'SELECT id, user_id, name, created_at FROM workspaces WHERE id = $1;',
      [workspaceId]
    );
    if (result.rowCount === 0) {
      throw new AppError(`Workspace with ID "${workspaceId}" was not found.`, 404);
    }
    const workspace = result.rows[0];
    if (
      requestUserId &&
      workspace.user_id &&
      workspace.user_id !== String(requestUserId).trim()
    ) {
      const allowed = await hasWorkspaceAccess(workspaceId, requestUserId);
      if (!allowed) {
        throw new AppError('Access denied: you do not have permission to access this workspace.', 403);
      }
    }
    return res.json({ success: true, workspace });
  } catch (err) {
    return next(err);
  }
});

// GET /api/workspaces/:workspaceId/shares
// Lists the workspace owner and shared collaborators
router.get('/:workspaceId/shares', async (req, res, next) => {
  try {
    const { workspaceId } = req.params;
    const requesterUserId =
      req.headers['x-user-id'] || req.query.userId || req.query.user_id || null;
    const data = await getWorkspaceShares(workspaceId, requesterUserId);
    return res.json({ success: true, ...data });
  } catch (err) {
    return next(err);
  }
});

// POST /api/workspaces/:workspaceId/share
// Shares an existing workspace (along with its files and tables) to another user by email or userId
router.post('/:workspaceId/share', async (req, res, next) => {
  try {
    const { workspaceId } = req.params;
    const { userId, user_id, email, role } = req.body || {};
    const targetUserId = userId || user_id || '';
    const requesterUserId =
      req.headers['x-user-id'] ||
      req.query?.userId ||
      req.query?.user_id ||
      req.body?.requesterUserId ||
      null;
    const share = await shareWorkspaceWithUser({
      workspaceId,
      userId: targetUserId,
      email: email || '',
      role,
      requesterUserId,
    });
    return res.status(200).json({ success: true, share });
  } catch (err) {
    return next(err);
  }
});

// DELETE /api/workspaces/:workspaceId/shares/:targetUserId
router.delete('/:workspaceId/shares/:targetUserId', async (req, res, next) => {
  try {
    const { workspaceId, targetUserId } = req.params;
    const requesterUserId =
      req.headers['x-user-id'] || req.query?.userId || req.query?.user_id || null;
    const result = await revokeWorkspaceShare({
      workspaceId,
      targetUserId,
      requesterUserId,
    });
    return res.json({ success: true, ...result });
  } catch (err) {
    return next(err);
  }
});

// DELETE /api/workspaces/:workspaceId/share/:targetUserId (alias)
router.delete('/:workspaceId/share/:targetUserId', async (req, res, next) => {
  try {
    const { workspaceId, targetUserId } = req.params;
    const requesterUserId =
      req.headers['x-user-id'] || req.query?.userId || req.query?.user_id || null;
    const result = await revokeWorkspaceShare({
      workspaceId,
      targetUserId,
      requesterUserId,
    });
    return res.json({ success: true, ...result });
  } catch (err) {
    return next(err);
  }
});

// PATCH /api/workspaces/:workspaceId
// Renames an existing workspace
router.patch('/:workspaceId', async (req, res, next) => {
  try {
    const { workspaceId } = req.params;
    const { name } = req.body || {};
    const requestUserId =
      req.headers['x-user-id'] ||
      req.query?.userId ||
      req.query?.user_id ||
      req.body?.userId ||
      req.body?.user_id ||
      null;
    const workspace = await updateWorkspaceName({
      workspaceId,
      name,
      userId: requestUserId,
    });
    return res.json({ success: true, workspace });
  } catch (err) {
    return next(err);
  }
});

// PUT /api/workspaces/:workspaceId (alias)
router.put('/:workspaceId', async (req, res, next) => {
  try {
    const { workspaceId } = req.params;
    const { name } = req.body || {};
    const requestUserId =
      req.headers['x-user-id'] ||
      req.query?.userId ||
      req.query?.user_id ||
      req.body?.userId ||
      req.body?.user_id ||
      null;
    const workspace = await updateWorkspaceName({
      workspaceId,
      name,
      userId: requestUserId,
    });
    return res.json({ success: true, workspace });
  } catch (err) {
    return next(err);
  }
});

// GET /api/workspaces/:workspaceId/documents/:docIdentifier/chunks
router.get('/:workspaceId/documents/:docIdentifier/chunks', getDocumentChunks);

// PATCH /api/workspaces/:workspaceId/documents/:docIdentifier
router.patch('/:workspaceId/documents/:docIdentifier', updateDocument);

// DELETE /api/workspaces/:workspaceId/documents/:docIdentifier
router.delete('/:workspaceId/documents/:docIdentifier', deleteDocument);

module.exports = router;
