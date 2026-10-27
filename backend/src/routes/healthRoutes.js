const express = require('express');
const { query } = require('../../db');

const router = express.Router();

async function healthCheckHandler(req, res) {
  const response = {
    status: 'ok',
    service: 'echo-support-assistant-backend',
    timestamp: new Date().toISOString(),
  };

  if (req.query.db === 'true') {
    try {
      await query('SELECT 1;');
      response.database = 'connected';
    } catch (err) {
      response.status = 'degraded';
      response.database = 'disconnected';
      return res.status(503).json(response);
    }
  }

  return res.status(200).json(response);
}

router.get('/health', healthCheckHandler);
router.get('/api/health', healthCheckHandler);

module.exports = router;
