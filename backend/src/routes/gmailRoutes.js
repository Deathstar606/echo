const express = require('express');
const { findBusinessOrThrow } = require('../controllers/businessController');
const {
  fetchPrimaryInboxMessages,
  sendGmailThreadReply,
} = require('../services/gmailService');
const router = express.Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function resolveIdentifier(req) {
  const body = req.body || {};
  return (
    req.query.userId ||
    req.query.user_id ||
    req.query.workspaceId ||
    req.query.workspace_id ||
    req.query.businessId ||
    req.query.business_id ||
    body.userId ||
    body.user_id ||
    body.workspaceId ||
    body.workspace_id ||
    body.businessId ||
    body.business_id ||
    ''
  );
}

function resolveWorkspaceIdOnly(req) {
  const body = req.body || {};
  return (
    req.query.workspaceId ||
    req.query.workspace_id ||
    req.query.businessId ||
    req.query.business_id ||
    body.workspaceId ||
    body.workspace_id ||
    body.businessId ||
    body.business_id ||
    ''
  );
}

// GET /api/google/gmail/inbox?businessId=...&maxResults=...
router.get('/inbox', async (req, res, next) => {
  try {
    const wsId = resolveWorkspaceIdOnly(req);
    const requestUserId = req.headers['x-user-id'] || req.query.userId || req.query.user_id || null;
    if (wsId && UUID_RE.test(String(wsId)) && requestUserId) {
      await findBusinessOrThrow(String(wsId), requestUserId);
    }
    const businessId = resolveIdentifier(req);
    const maxResults = req.query.maxResults ? Number.parseInt(req.query.maxResults, 10) : 20;
    const messages = await fetchPrimaryInboxMessages(businessId, { maxResults });
    return res.json({ success: true, count: messages.length, messages });
  } catch (err) {
    return next(err);
  }
});

// POST /api/google/gmail/reply
router.post('/reply', async (req, res, next) => {
  try {
    const body = req.body || {};
    const wsId = resolveWorkspaceIdOnly(req);
    const requestUserId = req.headers['x-user-id'] || body.userId || body.user_id || req.query.userId || null;
    if (wsId && UUID_RE.test(String(wsId)) && requestUserId) {
      await findBusinessOrThrow(String(wsId), requestUserId);
    }
    const businessId = resolveIdentifier(req);
    const { threadId, to, subject, inReplyTo, references, bodyText } = body;
    const result = await sendGmailThreadReply(businessId, {
      threadId,
      to,
      subject,
      inReplyTo,
      references,
      bodyText,
    });
    return res.json(result);
  } catch (err) {
    return next(err);
  }
});

// POST /api/google/gmail/suggest-reply
router.post('/suggest-reply', async (req, res, next) => {
  try {
    const body = req.body || {};
    const wsId = resolveWorkspaceIdOnly(req);
    const requestUserId = req.headers['x-user-id'] || body.userId || body.user_id || req.query.userId || null;
    if (wsId && UUID_RE.test(String(wsId)) && requestUserId) {
      await findBusinessOrThrow(String(wsId), requestUserId);
    }
    const businessId = resolveIdentifier(req);
    const { messageText, senderName, subject } = body;
    const { generateAiDraftForGmailMessage } = require('../services/gmailService');
    const result = await generateAiDraftForGmailMessage(businessId, {
      messageText,
      senderName,
      subject,
    });
    return res.json(result);
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
