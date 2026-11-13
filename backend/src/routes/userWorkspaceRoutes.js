const express = require('express');
const { query } = require('../../db');
const {
  getUserWorkspaces,
  createWorkspaceForUser,
  updateWorkspaceName,
} = require('../services/authService');
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
      throw new AppError('Access denied: you do not have permission to access this workspace.', 403);
    }
    return res.json({ success: true, workspace });
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

module.exports = router;
