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
app.use(helmet());

// Request logging (disabled during automated test runs to keep output clean)
if (env.nodeEnv !== 'test') {
  app.use(morgan('dev'));
}

// Parse JSON request bodies
app.use(express.json({ limit: '100kb' }));

// Routes
app.use('/', healthRoutes);
app.use('/api/businesses', businessRoutes);
app.use('/api/sheets', sheetRoutes);

// 404 and centralized error handling
app.use(notFoundHandler);
app.use(errorHandler);

module.exports = app;
