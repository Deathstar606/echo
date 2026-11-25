const crypto = require('node:crypto');
const { query } = require('../../../db');
const AppError = require('../../utils/AppError');

const DEMO_USER_ID = '10000000-0000-4000-8000-000000000001';
const DEMO_USER_EMAIL = 'demo@maxitext.studio';
const DEMO_USER_NAME = 'MaxiText Demo Account';

/**
 * Updates the display name of an existing workspace.
 *
 * @param {{ workspaceId: string, name: string, userId?: string | null }} param0
 * @returns {Promise<object>}
 */
/**
 * Checks whether a user owns or has shared access to a workspace.
 * Falls back cleanly if workspace_shares does not exist in older schemas/mocks.
 *
 * @param {string} workspaceId
 * @param {string} userId
 * @returns {Promise<boolean>}
 */
async function hasWorkspaceAccess(workspaceId, userId) {
  const cleanWsId = String(workspaceId || '').trim();
  const cleanUserId = String(userId || '').trim();
  if (!cleanWsId || !cleanUserId) return false;

  const ownerRes = await query(
    'SELECT user_id FROM workspaces WHERE id = $1 LIMIT 1;',
    [cleanWsId]
  );
  if (ownerRes.rowCount === 0) return false;
  if (!ownerRes.rows[0].user_id || ownerRes.rows[0].user_id === cleanUserId) {
    return true;
  }

  try {
    const shareRes = await query(
      'SELECT 1 FROM workspace_shares WHERE workspace_id = $1 AND user_id = $2 LIMIT 1;',
      [cleanWsId, cleanUserId]
    );
    return shareRes.rowCount > 0;
  } catch {
    return false;
  }
}

let ensureSharesPromise = null;
async function ensureWorkspaceSharesTable() {
  if (!ensureSharesPromise) {
    ensureSharesPromise = query(`
      CREATE TABLE IF NOT EXISTS workspace_shares (
        workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        role VARCHAR(32) NOT NULL DEFAULT 'editor',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (workspace_id, user_id)
      );
    `).catch(() => {
      ensureSharesPromise = null;
    });
  }
  await ensureSharesPromise;
}

const VALID_SHARE_ROLES = new Set(['viewer', 'editor', 'owner']);

/**
 * Grants a user shared access to an existing workspace (along with its files and tables).
 * Accepts either target `userId` (UUID) or `email`.
 *
 * @param {{ workspaceId: string, userId?: string, email?: string, role?: string, requesterUserId?: string | null }} param0
 * @returns {Promise<{ workspace_id: string, user_id: string, name: string, email: string, role: string, created_at: string }>}
 */
async function shareWorkspaceWithUser({
  workspaceId,
  userId = '',
  email = '',
  role = 'editor',
  requesterUserId = null,
}) {
  const cleanWsId = String(workspaceId || '').trim();
  const cleanUserId = String(userId || '').trim();
  const cleanEmail = String(email || '').trim().toLowerCase();
  const cleanRole = VALID_SHARE_ROLES.has(String(role || '').trim().toLowerCase())
    ? String(role).trim().toLowerCase()
    : 'editor';

  if (!cleanWsId) {
    throw new AppError('A valid workspaceId is required.', 400);
  }
  if (!cleanUserId && !cleanEmail) {
    throw new AppError('Please provide a user email or userId to share with.', 400);
  }

  await ensureWorkspaceSharesTable();

  const wsCheck = await query(
    'SELECT id, user_id, name, created_at FROM workspaces WHERE id = $1 LIMIT 1;',
    [cleanWsId]
  );
  if (wsCheck.rowCount === 0) {
    throw new AppError(`Workspace with ID "${cleanWsId}" was not found.`, 404);
  }
  const workspace = wsCheck.rows[0];

  if (requesterUserId) {
    const allowed = await hasWorkspaceAccess(cleanWsId, requesterUserId);
    if (!allowed) {
      throw new AppError(
        'Access denied: you do not have permission to share this workspace.',
        403
      );
    }
  }

  // Look up target user by UUID (if userId looks like a UUID or was provided) or email
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  let userCheck;
  if (cleanUserId && UUID_RE.test(cleanUserId)) {
    userCheck = await query(
      'SELECT id, name, email FROM users WHERE id = $1 LIMIT 1;',
      [cleanUserId]
    );
  } else {
    const emailLookup = cleanEmail || cleanUserId.toLowerCase();
    userCheck = await query(
      'SELECT id, name, email FROM users WHERE LOWER(email) = $1 LIMIT 1;',
      [emailLookup]
    );
  }

  if (!userCheck || userCheck.rowCount === 0) {
    const label = cleanEmail || cleanUserId;
    throw new AppError(
      `No registered MaxiText account found for "${label}". The user must sign in or register first.`,
      404
    );
  }

  const targetUser = userCheck.rows[0];
  if (
    targetUser.id === DEMO_USER_ID ||
    String(targetUser.email || '').toLowerCase() === DEMO_USER_EMAIL.toLowerCase()
  ) {
    throw new AppError(
      'Cannot share a private workspace with the public Demo Account.',
      400
    );
  }

  if (workspace.user_id && workspace.user_id === targetUser.id) {
    return {
      workspace_id: cleanWsId,
      user_id: targetUser.id,
      name: targetUser.name,
      email: targetUser.email,
      role: 'owner',
      created_at: workspace.created_at,
    };
  }

  const shareRes = await query(
    `INSERT INTO workspace_shares (workspace_id, user_id, role, created_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (workspace_id, user_id) DO UPDATE SET role = EXCLUDED.role
     RETURNING workspace_id, user_id, role, created_at;`,
    [cleanWsId, targetUser.id, cleanRole]
  );

  return {
    ...shareRes.rows[0],
    name: targetUser.name,
    email: targetUser.email,
  };
}

/**
 * Lists the workspace owner and all users with shared access to a workspace.
 *
 * @param {string} workspaceId
 * @param {string | null} [requesterUserId]
 * @returns {Promise<{ owner: object | null, shares: Array<object> }>}
 */
async function getWorkspaceShares(workspaceId, requesterUserId = null) {
  const cleanWsId = String(workspaceId || '').trim();
  if (!cleanWsId) {
    throw new AppError('A valid workspaceId is required.', 400);
  }

  await ensureWorkspaceSharesTable();

  const wsRes = await query(
    `SELECT w.id, w.name, w.user_id, w.created_at, u.name AS owner_name, u.email AS owner_email
     FROM workspaces w
     LEFT JOIN users u ON u.id = w.user_id
     WHERE w.id = $1
     LIMIT 1;`,
    [cleanWsId]
  );
  if (wsRes.rowCount === 0) {
    throw new AppError(`Workspace with ID "${cleanWsId}" was not found.`, 404);
  }

  if (requesterUserId) {
    const allowed = await hasWorkspaceAccess(cleanWsId, requesterUserId);
    if (!allowed) {
      throw new AppError(
        'Access denied: you do not have permission to view members of this workspace.',
        403
      );
    }
  }

  const wsRow = wsRes.rows[0];
  const owner = wsRow.user_id
    ? {
        user_id: wsRow.user_id,
        name: wsRow.owner_name || 'Workspace Owner',
        email: wsRow.owner_email || '',
        role: 'owner',
        created_at: wsRow.created_at,
      }
    : null;

  const sharesRes = await query(
    `SELECT ws.workspace_id, ws.user_id, u.name, u.email, ws.role, ws.created_at
     FROM workspace_shares ws
     JOIN users u ON u.id = ws.user_id
     WHERE ws.workspace_id = $1
       AND ($2::uuid IS NULL OR ws.user_id <> $2::uuid)
     ORDER BY ws.created_at ASC;`,
    [cleanWsId, wsRow.user_id || null]
  );

  return {
    owner,
    shares: sharesRes.rows || [],
  };
}

/**
 * Revokes a user's shared access to a workspace.
 *
 * @param {{ workspaceId: string, targetUserId: string, requesterUserId?: string | null }} param0
 */
async function revokeWorkspaceShare({ workspaceId, targetUserId, requesterUserId = null }) {
  const cleanWsId = String(workspaceId || '').trim();
  const cleanTargetId = String(targetUserId || '').trim();
  if (!cleanWsId || !cleanTargetId) {
    throw new AppError('workspaceId and targetUserId are required.', 400);
  }

  await ensureWorkspaceSharesTable();

  const wsRes = await query(
    'SELECT id, user_id FROM workspaces WHERE id = $1 LIMIT 1;',
    [cleanWsId]
  );
  if (wsRes.rowCount === 0) {
    throw new AppError(`Workspace with ID "${cleanWsId}" was not found.`, 404);
  }
  if (wsRes.rows[0].user_id === cleanTargetId) {
    throw new AppError('Cannot remove the original owner of the workspace.', 400);
  }

  if (requesterUserId) {
    const allowed = await hasWorkspaceAccess(cleanWsId, requesterUserId);
    if (!allowed) {
      throw new AppError(
        'Access denied: you do not have permission to manage sharing for this workspace.',
        403
      );
    }
  }

  await query(
    'DELETE FROM workspace_shares WHERE workspace_id = $1 AND user_id = $2;',
    [cleanWsId, cleanTargetId]
  );

  return { workspace_id: cleanWsId, user_id: cleanTargetId, removed: true };
}

async function updateWorkspaceName({ workspaceId, name, userId = null }) {
  const cleanWsId = String(workspaceId || '').trim();
  const trimmedName = String(name || '').trim();

  if (!cleanWsId) {
    throw new AppError('A valid workspace ID is required.', 400);
  }
  if (!trimmedName) {
    throw new AppError('Workspace "name" is required and cannot be empty.', 400);
  }
  if (trimmedName.length > 255) {
    throw new AppError('Workspace "name" must not exceed 255 characters.', 400);
  }

  const existingRes = await query(
    'SELECT id, user_id, name, created_at FROM workspaces WHERE id = $1 LIMIT 1;',
    [cleanWsId]
  );
  if (existingRes.rowCount === 0) {
    throw new AppError(`Workspace with ID "${cleanWsId}" was not found.`, 404);
  }

  const current = existingRes.rows[0];
  if (userId && current.user_id && current.user_id !== String(userId).trim()) {
    const allowed = await hasWorkspaceAccess(cleanWsId, userId);
    if (!allowed) {
      throw new AppError('Access denied: you do not have permission to modify this workspace.', 403);
    }
  }

  const updateRes = await query(
    `UPDATE workspaces
     SET name = $1
     WHERE id = $2
     RETURNING id, user_id, name, created_at;`,
    [trimmedName, cleanWsId]
  );

  return updateRes.rows[0];
}

/**
 * Derives a salted scrypt hash from a plaintext password.
 * Format: <salt_hex>:<hash_hex>
 *
 * @param {string} password
 * @returns {string}
 */
function hashPassword(password) {
  if (!password || typeof password !== 'string') {
    throw new AppError('Password must be a non-empty string.', 400);
  }
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

/**
 * Validates a plaintext password against a stored salted scrypt hash.
 * Also tolerates direct plaintext equality for test convenience.
 *
 * @param {string} password
 * @param {string} storedHash
 * @returns {boolean}
 */
function verifyPassword(password, storedHash) {
  if (!password || !storedHash) return false;
  if (password === storedHash) return true;

  const parts = String(storedHash).split(':');
  if (parts.length !== 2) return false;

  const [salt, expectedHash] = parts;
  try {
    const derivedHash = crypto.scryptSync(password, salt, 64).toString('hex');
    return crypto.timingSafeEqual(
      Buffer.from(derivedHash, 'hex'),
      Buffer.from(expectedHash, 'hex')
    );
  } catch {
    return false;
  }
}

/**
 * Retrieves all workspaces belonging to a user ID.
 * If user has no workspaces, returns empty array.
 *
 * @param {string} [userId]
 * @returns {Promise<Array<object>>}
 */
async function getUserWorkspaces(userId) {
  if (!userId || typeof userId !== 'string' || !userId.trim()) {
    return [];
  }
  const cleanUserId = userId.trim();
  try {
    const res = await query(
      `SELECT DISTINCT
         w.id,
         w.user_id,
         w.name,
         w.created_at,
         (w.user_id IS NOT NULL AND w.user_id <> $1) AS is_shared,
         COALESCE(ws.role, CASE WHEN w.user_id = $1 THEN 'owner' ELSE 'editor' END) AS share_role,
         u_owner.name AS owner_name,
         u_owner.email AS owner_email
       FROM workspaces w
       LEFT JOIN workspace_shares ws
         ON ws.workspace_id = w.id AND ws.user_id = $1
       LEFT JOIN users u_owner
         ON u_owner.id = w.user_id
       WHERE w.user_id = $1 OR ws.user_id = $1
       ORDER BY w.created_at ASC;`,
      [cleanUserId]
    );
    return res.rows || [];
  } catch {
    const res = await query(
      'SELECT id, user_id, name, created_at FROM workspaces WHERE user_id = $1 ORDER BY created_at ASC;',
      [cleanUserId]
    );
    return res.rows || [];
  }
}

/**
 * Creates a new workspace belonging to a specific user.
 *
 * @param {{ name: string, userId: string }} param0
 * @returns {Promise<object>}
 */
async function createWorkspaceForUser({ name, userId }) {
  const trimmedName = String(name || '').trim();
  if (!trimmedName) {
    throw new AppError('Workspace "name" is required and cannot be empty.', 400);
  }
  if (!userId) {
    throw new AppError('A valid "userId" is required to create a workspace.', 400);
  }

  const id = crypto.randomUUID();
  const res = await query(
    `INSERT INTO workspaces (id, user_id, name, created_at)
     VALUES ($1, $2, $3, NOW())
     RETURNING id, user_id, name, created_at;`,
    [id, userId, trimmedName]
  );

  return res.rows[0];
}

/**
 * Authenticates a user with email and password.
 * Returns user profile and their workspaces.
 *
 * @param {{ email: string, password: string }} credentials
 * @returns {Promise<{ user: object, workspaces: Array<object> }>}
 */
async function loginUser({ email, password }) {
  const cleanEmail = String(email || '').trim().toLowerCase();
  const cleanPass = String(password || '');

  if (!cleanEmail) {
    throw new AppError('Email is required.', 400);
  }
  if (!cleanPass) {
    throw new AppError('Password is required.', 400);
  }

  const res = await query(
    'SELECT id, name, email, password, created_at FROM users WHERE LOWER(email) = $1;',
    [cleanEmail]
  );

  if (res.rowCount === 0) {
    throw new AppError('No account found with this email address.', 401);
  }

  const user = res.rows[0];
  if (!user.password) {
    throw new AppError(
      'This account is registered via Google Sign-In. Please click "Sign in with Google" to access your account.',
      401
    );
  }

  const isValid = verifyPassword(cleanPass, user.password);
  if (!isValid) {
    throw new AppError('Invalid email or password.', 401);
  }

  // Fetch workspaces
  const workspaces = await getUserWorkspaces(user.id);

  return {
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      created_at: user.created_at,
    },
    workspaces,
  };
}

/**
 * Registers a new user with email, name, and password.
 * Automatically provisions an initial workspace for the user.
 *
 * @param {{ name: string, email: string, password: string }} details
 * @returns {Promise<{ user: object, workspaces: Array<object> }>}
 */
async function registerUser({ name, email, password }) {
  const cleanName = String(name || '').trim();
  const cleanEmail = String(email || '').trim().toLowerCase();
  const cleanPass = String(password || '');

  if (!cleanName) {
    throw new AppError('Full name is required.', 400);
  }
  if (!cleanEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
    throw new AppError('A valid email address is required.', 400);
  }
  if (!cleanPass || cleanPass.length < 6) {
    throw new AppError('Password must be at least 6 characters in length.', 400);
  }

  const existing = await query('SELECT id FROM users WHERE LOWER(email) = $1;', [cleanEmail]);
  if (existing.rowCount > 0) {
    throw new AppError('An account with this email address already exists. Please sign in.', 409);
  }

  const id = crypto.randomUUID();
  const hashedPassword = hashPassword(cleanPass);

  const userRes = await query(
    `INSERT INTO users (id, name, email, password, created_at, updated_at)
     VALUES ($1, $2, $3, $4, NOW(), NOW())
     RETURNING id, name, email, created_at;`,
    [id, cleanName, cleanEmail, hashedPassword]
  );
  const newUser = userRes.rows[0];

  // Auto-provision default workspace
  const workspaceName = `${cleanName}'s Workspace`;
  const defaultWs = await createWorkspaceForUser({ name: workspaceName, userId: newUser.id });

  return {
    user: newUser,
    workspaces: [defaultWs],
  };
}

/**
 * Finds or upserts a user authenticated via Google OAuth.
 * If user has no workspaces, provisions an initial workspace.
 *
 * @param {{ email: string, name: string, picture?: string }} profile
 * @returns {Promise<{ user: object, workspaces: Array<object> }>}
 */
async function upsertGoogleUser({ email, name, picture = null }) {
  const cleanEmail = String(email || '').trim().toLowerCase();
  const cleanName = String(name || email || 'Google User').trim();

  let userRes = await query('SELECT id, name, email, created_at FROM users WHERE LOWER(email) = $1;', [cleanEmail]);
  let user;

  if (userRes.rowCount === 0) {
    const id = crypto.randomUUID();
    const insertRes = await query(
      `INSERT INTO users (id, name, email, created_at, updated_at)
       VALUES ($1, $2, $3, NOW(), NOW())
       RETURNING id, name, email, created_at;`,
      [id, cleanName, cleanEmail]
    );
    user = insertRes.rows[0];
  } else {
    user = userRes.rows[0];
  }

  let workspaces = await getUserWorkspaces(user.id);
  if (workspaces.length === 0) {
    const defaultWs = await createWorkspaceForUser({
      name: `${cleanName}'s Workspace`,
      userId: user.id,
    });
    workspaces = [defaultWs];
  }

  return { user, workspaces };
}

/**
 * Ensures the shared demo user account exists and returns it.
 *
 * @returns {Promise<{ id: string, name: string, email: string, created_at: string }>}
 */
async function ensureDemoAccount() {
  const existingRes = await query(
    `SELECT id, name, email, created_at
     FROM users
     WHERE id = $1 OR LOWER(email) = $2
     ORDER BY (id = $1) DESC
     LIMIT 1;`,
    [DEMO_USER_ID, DEMO_USER_EMAIL]
  );

  if (existingRes.rowCount > 0) {
    return existingRes.rows[0];
  }

  const hashedPassword = hashPassword('DemoWorkspace2026!');
  const insertRes = await query(
    `INSERT INTO users (id, name, email, password, created_at, updated_at)
     VALUES ($1, $2, $3, $4, NOW(), NOW())
     ON CONFLICT (id) DO NOTHING
     RETURNING id, name, email, created_at;`,
    [DEMO_USER_ID, DEMO_USER_NAME, DEMO_USER_EMAIL, hashedPassword]
  );

  if (insertRes.rowCount > 0) {
    return insertRes.rows[0];
  }

  const fallbackRes = await query(
    `SELECT id, name, email, created_at
     FROM users
     WHERE id = $1 OR LOWER(email) = $2
     LIMIT 1;`,
    [DEMO_USER_ID, DEMO_USER_EMAIL]
  );
  return fallbackRes.rows[0];
}

/**
 * Signs any visitor into the shared demo account and returns all its workspaces.
 *
 * @returns {Promise<{ user: object, workspaces: Array<object> }>}
 */
async function loginDemoUser() {
  const user = await ensureDemoAccount();
  let workspaces = await getUserWorkspaces(user.id);
  if (workspaces.length === 0) {
    const defaultWs = await createWorkspaceForUser({
      name: 'Demo Operations Workspace',
      userId: user.id,
    });
    workspaces = [defaultWs];
  }
  return { user, workspaces };
}

module.exports = {
  DEMO_USER_ID,
  DEMO_USER_EMAIL,
  DEMO_USER_NAME,
  hashPassword,
  verifyPassword,
  getUserWorkspaces,
  hasWorkspaceAccess,
  shareWorkspaceWithUser,
  getWorkspaceShares,
  revokeWorkspaceShare,
  createWorkspaceForUser,
  updateWorkspaceName,
  loginUser,
  registerUser,
  upsertGoogleUser,
  ensureDemoAccount,
  loginDemoUser,
};
