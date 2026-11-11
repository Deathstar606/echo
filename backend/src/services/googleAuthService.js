const { google } = require('googleapis');
const env = require('../config/env');
const { query } = require('../../db');
const AppError = require('../utils/AppError');
const { upsertGoogleUser } = require('./authService');

const GOOGLE_SCOPES = [
  'openid',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/documents.readonly',
  'https://www.googleapis.com/auth/drive.readonly',
];

/**
 * Creates a raw Google OAuth2 Client configured from application environment.
 * @returns {import('googleapis').Auth.OAuth2Client}
 */
function createOAuth2Client() {
  const fallbackRedirect = `http://localhost:${env.port || 3000}/api/auth/google/callback`;
  return new google.auth.OAuth2(
    env.googleClientId || process.env.GOOGLE_CLIENT_ID || '',
    env.googleClientSecret || process.env.GOOGLE_CLIENT_SECRET || '',
    env.googleRedirectUri || process.env.GOOGLE_REDIRECT_URI || fallbackRedirect
  );
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Helper to resolve user_id from either a direct userId or a workspaceId.
 *
 * @param {string} [id]
 * @returns {Promise<string | null>}
 */
async function resolveUserId(id) {
  if (!id || typeof id !== 'string') return null;
  const trimmed = id.trim();
  if (!UUID_RE.test(trimmed)) return null;

  // First check if id is a user_id
  const userCheck = await query('SELECT id FROM users WHERE id = $1 LIMIT 1;', [trimmed]);
  if (userCheck.rowCount > 0) return trimmed;

  // Next check if id is a workspace_id
  const wsCheck = await query('SELECT user_id FROM workspaces WHERE id = $1 LIMIT 1;', [trimmed]);
  if (wsCheck.rowCount > 0 && wsCheck.rows[0].user_id) {
    return wsCheck.rows[0].user_id;
  }

  return null;
}

/**
 * Encodes OAuth2 state payload (supporting both login and account-linking flows).
 * @param {string | { mode?: 'login' | 'link', userId?: string, workspaceId?: string, tab?: string, origin?: string, identifier?: string }} stateInput
 * @returns {string}
 */
function encodeOAuthState(stateInput) {
  if (!stateInput) return '';
  if (typeof stateInput === 'string') return stateInput;
  try {
    return Buffer.from(JSON.stringify(stateInput), 'utf8').toString('base64url');
  } catch {
    return stateInput.userId || stateInput.workspaceId || stateInput.identifier || '';
  }
}

/**
 * Decodes OAuth2 state parameter returned by Google callback.
 * @param {string} [rawState]
 * @returns {{ mode?: string, userId?: string, workspaceId?: string, tab?: string, origin?: string, identifier?: string }}
 */
function decodeOAuthState(rawState) {
  if (!rawState || typeof rawState !== 'string') return {};
  const trimmed = rawState.trim();
  if (UUID_RE.test(trimmed)) {
    return { mode: 'login', identifier: trimmed };
  }
  try {
    const parsed = JSON.parse(Buffer.from(trimmed, 'base64url').toString('utf8'));
    if (parsed && typeof parsed === 'object') {
      return parsed;
    }
  } catch {
    // Fallback to raw identifier string
  }
  return { identifier: trimmed };
}

/**
 * Generates an OAuth 2.0 authorization URL for user consent.
 * @param {string | { mode?: 'login' | 'link', userId?: string, workspaceId?: string, tab?: string, origin?: string, identifier?: string }} [stateOrIdentifier]
 * @returns {string}
 */
function getAuthUrl(stateOrIdentifier) {
  const oauth2Client = createOAuth2Client();
  const state = encodeOAuthState(stateOrIdentifier);
  return oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: GOOGLE_SCOPES,
    state,
  });
}

/**
 * Exchanges the OAuth 2.0 authorization code for tokens and retrieves user profile.
 * Persists credentials to PostgreSQL google_auth_tokens linked to user_id.
 * Supports:
 * - mode: 'link' -> attaches Google token to the currently signed-in Echo user without switching accounts
 * - mode: 'login' -> finds or creates user by Google email and logs them in
 *
 * @param {string} code
 * @param {string} [rawState]
 * @returns {Promise<{ user: object, tokens: object, googleProfile: object, mode: string, stateData: object }>}
 */
async function handleAuthCallback(code, rawState) {
  if (!code) {
    throw new AppError('Authorization code is missing from OAuth callback.', 400);
  }
  const stateData = decodeOAuthState(rawState);
  const oauth2Client = createOAuth2Client();
  const { tokens } = await oauth2Client.getToken(code);
  oauth2Client.setCredentials(tokens);

  const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
  const { data: profile } = await oauth2.userinfo.get();

  const googleProfile = {
    email: profile.email || '',
    name: profile.name || profile.email || 'Google User',
    picture: profile.picture || null,
  };

  let user = null;
  let mode = stateData.mode === 'link' ? 'link' : 'login';

  if (mode === 'link' && stateData.userId && UUID_RE.test(String(stateData.userId))) {
    const existingRes = await query(
      'SELECT id, name, email, created_at FROM users WHERE id = $1 LIMIT 1;',
      [String(stateData.userId)]
    );
    if (existingRes.rowCount > 0) {
      user = existingRes.rows[0];
    } else {
      mode = 'login';
    }
  }

  if (!user) {
    // Standard Google Sign-In flow: find or create user record for Google account
    const upserted = await upsertGoogleUser(googleProfile);
    user = upserted.user;
    mode = 'login';
  }

  const targetUserId = user.id;

  await query(
    `INSERT INTO google_auth_tokens (
      user_id, email, name, picture, access_token, refresh_token, expiry_date, is_env_connected, updated_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, false, NOW())
    ON CONFLICT (user_id) DO UPDATE SET
      email = EXCLUDED.email,
      name = EXCLUDED.name,
      picture = EXCLUDED.picture,
      access_token = COALESCE(EXCLUDED.access_token, google_auth_tokens.access_token),
      refresh_token = COALESCE(EXCLUDED.refresh_token, google_auth_tokens.refresh_token),
      expiry_date = COALESCE(EXCLUDED.expiry_date, google_auth_tokens.expiry_date),
      is_env_connected = false,
      updated_at = NOW();`,
    [
      targetUserId,
      googleProfile.email,
      googleProfile.name,
      googleProfile.picture,
      tokens.access_token || null,
      tokens.refresh_token || null,
      tokens.expiry_date ? String(tokens.expiry_date) : null,
    ]
  );

  return { user, tokens, googleProfile, mode, stateData };
}

// In-memory cache for .env profile lookup to avoid repeated network calls
let envProfileCache = null;
let envProfileCacheTime = 0;

/**
 * Fetches user profile using the environment GOOGLE_REFRESH_TOKEN.
 * @returns {Promise<object | null>}
 */
async function getEnvUserProfile() {
  const refreshToken = env.googleRefreshToken || process.env.GOOGLE_REFRESH_TOKEN;
  if (!refreshToken || !env.googleClientId || !env.googleClientSecret) {
    return null;
  }

  if (envProfileCache && Date.now() - envProfileCacheTime < 300000) {
    return envProfileCache;
  }

  try {
    const oauth2Client = createOAuth2Client();
    oauth2Client.setCredentials({ refresh_token: refreshToken });
    const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
    const { data: profile } = await oauth2.userinfo.get();
    envProfileCache = {
      email: profile.email || '',
      name: profile.name || profile.email || 'Google Connected User',
      picture: profile.picture || null,
      isEnvConnected: true,
    };
    envProfileCacheTime = Date.now();
    return envProfileCache;
  } catch (err) {
    console.warn('[GoogleAuth] Could not fetch profile from GOOGLE_REFRESH_TOKEN:', err.message);
    return {
      email: 'connected-service@google.com',
      name: 'Google Connected Account',
      picture: null,
      isEnvConnected: true,
    };
  }
}

/**
 * Returns connection status and connected Google user profile.
 * Resolves by user_id or workspaceId.
 *
 * @param {string} [identifier] - userId or workspaceId
 * @returns {Promise<{ connected: boolean, user: object | null }>}
 */
async function getAuthStatus(identifier) {
  const hasExplicitIdentifier = Boolean(identifier && String(identifier).trim());
  const targetUserId = await resolveUserId(identifier);

  if (targetUserId) {
    try {
      const res = await query(
        'SELECT email, name, picture, is_env_connected, updated_at FROM google_auth_tokens WHERE user_id = $1 LIMIT 1;',
        [targetUserId]
      );
      if (res.rows && res.rows.length > 0) {
        const row = res.rows[0];
        return {
          connected: true,
          user: {
            email: row.email,
            name: row.name,
            picture: row.picture,
            isEnvConnected: Boolean(row.is_env_connected),
          },
        };
      }
    } catch (dbErr) {
      console.warn('[GoogleAuth] DB query error on getAuthStatus:', dbErr.message);
    }
  }

  // Only check .env fallback when no explicit identifier was provided
  if (!hasExplicitIdentifier) {
    const envUser = await getEnvUserProfile();
    if (envUser) {
      return {
        connected: true,
        user: envUser,
      };
    }
  }

  return { connected: false, user: null };
}

/**
 * Resolves an authenticated Google OAuth2 Client.
 * Prioritizes database-persisted user tokens, then falls back to GOOGLE_REFRESH_TOKEN.
 *
 * @param {string} [identifier] - userId or workspaceId
 * @returns {Promise<import('googleapis').Auth.OAuth2Client>}
 */
async function getAuthenticatedClient(identifier) {
  const oauth2Client = createOAuth2Client();
  const hasExplicitIdentifier = Boolean(identifier && String(identifier).trim());
  const targetUserId = await resolveUserId(identifier);

  if (targetUserId) {
    try {
      const res = await query(
        'SELECT access_token, refresh_token, expiry_date FROM google_auth_tokens WHERE user_id = $1 LIMIT 1;',
        [targetUserId]
      );
      if (res.rows && res.rows.length > 0) {
        const { access_token, refresh_token, expiry_date } = res.rows[0];
        if (access_token || refresh_token) {
          oauth2Client.setCredentials({
            access_token,
            refresh_token,
            expiry_date: expiry_date ? Number(expiry_date) : undefined,
          });

          // Save refreshed tokens automatically
          oauth2Client.on('tokens', async (newTokens) => {
            try {
              await query(
                `UPDATE google_auth_tokens SET
                  access_token = COALESCE($1, access_token),
                  refresh_token = COALESCE($2, refresh_token),
                  expiry_date = COALESCE($3, expiry_date),
                  updated_at = NOW()
                WHERE user_id = $4;`,
                [
                  newTokens.access_token || null,
                  newTokens.refresh_token || null,
                  newTokens.expiry_date ? String(newTokens.expiry_date) : null,
                  targetUserId,
                ]
              );
            } catch (updateErr) {
              console.warn('[GoogleAuth] Failed to update refreshed tokens:', updateErr.message);
            }
          });

          return oauth2Client;
        }
      }
    } catch (dbErr) {
      console.warn('[GoogleAuth] Failed to load token from DB:', dbErr.message);
    }
  }

  // Only fall back to .env refresh token when no explicit user/workspace identifier was supplied
  if (!hasExplicitIdentifier) {
    const envRefreshToken = env.googleRefreshToken || process.env.GOOGLE_REFRESH_TOKEN;
    if (envRefreshToken) {
      oauth2Client.setCredentials({
        refresh_token: envRefreshToken,
      });
      return oauth2Client;
    }
  }

  throw new AppError(
    'No Google Workspace account is currently connected for this user. Please connect your Google account first.',
    401
  );
}

/**
 * Disconnects Google account tokens from database for the specified user or workspace owner.
 *
 * @param {string} [identifier] - userId or workspaceId
 */
async function disconnectGoogleAuth(identifier) {
  const targetUserId = await resolveUserId(identifier);
  if (targetUserId) {
    await query('DELETE FROM google_auth_tokens WHERE user_id = $1;', [targetUserId]);
  }
  envProfileCache = null;
  envProfileCacheTime = 0;
}

module.exports = {
  createOAuth2Client,
  decodeOAuthState,
  encodeOAuthState,
  getAuthUrl,
  handleAuthCallback,
  getAuthStatus,
  getAuthenticatedClient,
  disconnectGoogleAuth,
};
