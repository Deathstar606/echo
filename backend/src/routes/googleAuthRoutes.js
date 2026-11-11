const express = require('express');
const {
  decodeOAuthState,
  getAuthUrl,
  handleAuthCallback,
  getAuthStatus,
  disconnectGoogleAuth,
} = require('../services/googleAuthService');
const router = express.Router();

function resolveIdentifier(req) {
  return (
    req.query.userId ||
    req.query.user_id ||
    req.headers['x-user-id'] ||
    req.query.workspaceId ||
    req.query.workspace_id ||
    req.query.businessId ||
    req.query.business_id ||
    req.body?.userId ||
    req.body?.user_id ||
    req.body?.workspaceId ||
    req.body?.workspace_id ||
    req.body?.businessId ||
    req.body?.business_id ||
    ''
  );
}

function resolveFrontendOrigin(req, stateData = null) {
  if (stateData?.origin && /^https?:\/\/[^/]+$/i.test(String(stateData.origin).trim())) {
    return String(stateData.origin).trim().replace(/\/+$/, '');
  }
  const explicit = process.env.FRONTEND_URL || req.headers.origin;
  if (explicit) {
    return String(explicit).replace(/\/+$/, '');
  }
  if (req.headers.referer) {
    try {
      const parsed = new URL(req.headers.referer);
      if (!/accounts\.google\./i.test(parsed.hostname)) {
        return parsed.origin;
      }
    } catch {
      // Ignore malformed referer
    }
  }
  return 'http://localhost:5173';
}

// GET /api/auth/google/url
router.get('/url', (req, res, next) => {
  try {
    const mode = req.query.mode === 'link' ? 'link' : 'login';
    const userId =
      req.query.userId ||
      req.query.user_id ||
      req.headers['x-user-id'] ||
      '';
    const workspaceId =
      req.query.workspaceId ||
      req.query.workspace_id ||
      req.query.businessId ||
      req.query.business_id ||
      '';
    const tab = req.query.tab ? String(req.query.tab).trim() : '';
    const origin =
      (req.query.origin && /^https?:\/\/[^/]+$/i.test(String(req.query.origin).trim())
        ? String(req.query.origin).trim()
        : '') || resolveFrontendOrigin(req);

    const url =
      mode === 'link' && userId
        ? getAuthUrl({ mode: 'link', userId: String(userId).trim(), workspaceId, tab, origin })
        : getAuthUrl({ mode: 'login', identifier: resolveIdentifier(req), workspaceId, tab, origin });

    return res.json({ success: true, url });
  } catch (err) {
    return next(err);
  }
});

// GET /api/auth/google/callback?code=...&state=...
router.get('/callback', async (req, res) => {
  const rawState = typeof req.query.state === 'string' ? req.query.state : '';
  const initialStateData = decodeOAuthState(rawState);
  const initialOrigin = resolveFrontendOrigin(req, initialStateData);

  if (req.query.error) {
    const errorMsg = req.query.error_description || req.query.error || 'Google authentication was cancelled.';
    const tabParam = initialStateData.tab ? `&tab=${encodeURIComponent(initialStateData.tab)}` : '';
    return res.redirect(
      `${initialOrigin}/company?google_auth_error=${encodeURIComponent(String(errorMsg))}${tabParam}`
    );
  }

  try {
    const code = req.query.code;
    const { user, googleProfile, mode, stateData } = await handleAuthCallback(code, rawState);
    const origin = resolveFrontendOrigin(req, stateData);

    if (mode === 'link') {
      const tabParam = `&tab=${encodeURIComponent(stateData?.tab || 'sheets')}`;
      const wsParam = stateData?.workspaceId
        ? `&workspace_id=${encodeURIComponent(stateData.workspaceId)}`
        : '';
      return res.redirect(
        `${origin}/company?google_linked=success&user_id=${encodeURIComponent(user.id)}&google_email=${encodeURIComponent(googleProfile.email)}${tabParam}${wsParam}`
      );
    }

    // Redirect user back to frontend with user info
    return res.redirect(
      `${origin}/company?google_auth=success&user_id=${encodeURIComponent(user.id)}&email=${encodeURIComponent(user.email)}&name=${encodeURIComponent(user.name)}`
    );
  } catch (err) {
    const origin = initialOrigin;
    const gMsg =
      err?.response?.data?.error_description ||
      err?.response?.data?.error?.message ||
      err?.message ||
      'Google authentication failed.';
    const tabParam = initialStateData.tab ? `&tab=${encodeURIComponent(initialStateData.tab)}` : '';
    return res.redirect(
      `${origin}/company?google_auth_error=${encodeURIComponent(String(gMsg))}${tabParam}`
    );
  }
});

// GET /api/auth/google/status
router.get('/status', async (req, res, next) => {
  try {
    const identifier = resolveIdentifier(req);
    const status = await getAuthStatus(identifier);
    return res.json({ success: true, ...status });
  } catch (err) {
    return next(err);
  }
});

// POST /api/auth/google/logout
router.post('/logout', async (req, res, next) => {
  try {
    const identifier = resolveIdentifier(req);
    await disconnectGoogleAuth(identifier);
    return res.json({ success: true, connected: false, user: null });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
