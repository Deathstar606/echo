const crypto = require('node:crypto');
const { query } = require('../../db');
const AppError = require('../utils/AppError');

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
  const res = await query(
    'SELECT id, user_id, name, created_at FROM workspaces WHERE user_id = $1 ORDER BY created_at ASC;',
    [userId.trim()]
  );
  return res.rows || [];
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

module.exports = {
  hashPassword,
  verifyPassword,
  getUserWorkspaces,
  createWorkspaceForUser,
  loginUser,
  registerUser,
  upsertGoogleUser,
};
