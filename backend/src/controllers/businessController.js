const crypto = require('node:crypto');
const { query } = require('../../db');
const AppError = require('../utils/AppError');
const { DEMO_USER_ID } = require('../services/authService');
const { updateWorkspaceName } = require('../services/authService');

/**
 * Fetches a workspace (business) by UUID or throws a 404 AppError if not found.
 *
 * @param {string} workspaceId
 * @returns {Promise<{ id: string, name: string, created_at: string, user_id?: string }>}
 */
async function findBusinessOrThrow(workspaceId, requestUserId = null) {
  const result = await query(
    `
      SELECT id, name, user_id, created_at
      FROM workspaces
      WHERE id = $1;
    `,
    [workspaceId]
  );

  if (result.rowCount === 0) {
    throw new AppError(`Workspace/Business with ID "${workspaceId}" was not found.`, 404);
  }

  const workspace = result.rows[0];
  if (
    requestUserId &&
    workspace.user_id &&
    workspace.user_id !== String(requestUserId).trim()
  ) {
    throw new AppError(
      'Access denied: you do not have permission to access this workspace.',
      403
    );
  }

  return workspace;
}

/**
 * POST /api/businesses
 * Creates a new business / workspace and returns its generated UUID.
 */
async function createBusiness(req, res, next) {
  try {
    const rawName = req.body ? req.body.name : undefined;
    const rawUserId = req.body ? (req.body.user_id || req.body.userId) : null;

    if (typeof rawName !== 'string' || !rawName.trim()) {
      throw new AppError(
        'Business/Workspace "name" is required and must be a non-empty string.',
        400
      );
    }

    const name = rawName.trim();
    if (name.length > 255) {
      throw new AppError(
        'Business/Workspace "name" must not exceed 255 characters.',
        400
      );
    }

    let targetUserId = rawUserId;
    if (!targetUserId) {
      // Default to shared demo / primary user if none provided
      const firstUserRes = await query('SELECT id FROM users ORDER BY created_at ASC LIMIT 1;');
      targetUserId = firstUserRes.rows[0]?.id || DEMO_USER_ID;
    }

    const id = crypto.randomUUID();
    const result = await query(
      `
        INSERT INTO workspaces (id, name, user_id, created_at)
        VALUES ($1, $2, $3, NOW())
        RETURNING id, name, user_id, created_at;
      `,
      [id, name, targetUserId]
    );

    const createdBusiness = result.rows[0];

    return res.status(201).json({
      id: createdBusiness.id,
      name: createdBusiness.name,
      user_id: createdBusiness.user_id,
      created_at: createdBusiness.created_at,
    });
  } catch (error) {
    return next(error);
  }
}

/**
 * GET /api/businesses/:businessId
 * Retrieves business details (id, name, created_at) by businessId.
 */
async function getBusiness(req, res, next) {
  try {
    const { businessId } = req.params;
    const requestUserId =
      req.headers['x-user-id'] ||
      req.query?.userId ||
      req.query?.user_id ||
      null;
    const business = await findBusinessOrThrow(businessId, requestUserId);
    return res.status(200).json({
      id: business.id,
      name: business.name,
      user_id: business.user_id,
      created_at: business.created_at,
    });
  } catch (error) {
    return next(error);
  }
}

/**
 * PATCH /api/businesses/:businessId
 * PUT /api/businesses/:businessId
 * Updates/renames business workspace details.
 */
async function updateBusiness(req, res, next) {
  try {
    const businessId = req.params.businessId || req.params.workspaceId;
    const { name } = req.body || {};
    const requestUserId =
      req.headers['x-user-id'] ||
      req.query?.userId ||
      req.query?.user_id ||
      req.body?.userId ||
      req.body?.user_id ||
      null;
    const updated = await updateWorkspaceName({
      workspaceId: businessId,
      name,
      userId: requestUserId,
    });
    return res.status(200).json({
      success: true,
      id: updated.id,
      name: updated.name,
      user_id: updated.user_id,
      created_at: updated.created_at,
      workspace: updated,
    });
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  findBusinessOrThrow,
  createBusiness,
  getBusiness,
  updateBusiness,
};
