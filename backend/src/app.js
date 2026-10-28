const express = require('express');
const helmet = require('helmet');
const morgan = require('morgan');
const env = require('./config/env');
const healthRoutes = require('./routes/healthRoutes');
const businessRoutes = require('./routes/businessRoutes');
const sheetRoutes = require('./routes/sheetRoutes');
const { notFoundHandler, errorHandler } = require('./middleware/errorHandler');

const app = express();

// Security headers
app.use(
  helmet({
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  })
);

// Enable CORS for frontend client workspace
app.use((req, res, next) => {
  const origin = req.headers.origin || '*';
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader(
    'Access-Control-Allow-Methods',
    'GET, POST, PATCH, PUT, DELETE, OPTIONS'
  );
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, Authorization, Accept, X-Requested-With'
  );
  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }
  return next();
});

// Request logging (disabled during automated test runs to keep output clean)
if (env.nodeEnv !== 'test') {
  app.use(morgan('dev'));
}

// Parse JSON request bodies
app.use(express.json({ limit: '100kb' }));

// Sanitize request URL by trimming accidental trailing whitespace or %20
app.use((req, res, next) => {
  if (typeof req.url === 'string') {
    const [pathname, search] = req.url.split('?');
    const trimmedPath = pathname.replace(/(?:%20|\s)+$/g, '');
    if (trimmedPath !== pathname) {
      req.url = search !== undefined ? `${trimmedPath}?${search}` : trimmedPath;
    }
  }
  next();
});

// Routes
app.use('/', healthRoutes);
app.use('/api/businesses', businessRoutes);
app.use('/api/sheets', sheetRoutes);

// 404 and centralized error handling
app.use(notFoundHandler);
app.use(errorHandler);

module.exports = app;
