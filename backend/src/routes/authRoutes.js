const express = require('express');
const {
  loginUser,
  registerUser,
  loginDemoUser,
  getUserWorkspaces,
} = require('../services/authService');
const { query } = require('../../db');
const router = express.Router();

// POST /api/auth/demo
router.post('/demo', async (req, res, next) => {
  try {
    const result = await loginDemoUser();
    return res.json({ success: true, ...result });
  } catch (err) {
    return next(err);
  }
});

// POST /api/auth/login
router.post('/login', async (req, res, next) => {
  try {
    const { email, password } = req.body || {};
    const result = await loginUser({ email, password });
    return res.json({ success: true, ...result });
  } catch (err) {
    return next(err);
  }
});

// POST /api/auth/register
router.post('/register', async (req, res, next) => {
  try {
    const { name, email, password } = req.body || {};
    const result = await registerUser({ name, email, password });
    return res.status(201).json({ success: true, ...result });
  } catch (err) {
    return next(err);
  }
});

// GET /api/auth/me?userId=...
router.get('/me', async (req, res, next) => {
  try {
    const userId = req.query.userId || req.headers['x-user-id'] || null;
    if (!userId) {
      return res.status(401).json({ success: false, error: 'User is not authenticated.' });
    }

    const userRes = await query('SELECT id, name, email, created_at FROM users WHERE id = $1;', [userId]);
    if (userRes.rowCount === 0) {
      return res.status(404).json({ success: false, error: 'User account not found.' });
    }

    const user = userRes.rows[0];
    const workspaces = await getUserWorkspaces(user.id);
    return res.json({ success: true, user, workspaces });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
