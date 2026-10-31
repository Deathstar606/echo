const express = require('express');
const { uploadSingleCsv } = require('../middleware/uploadMiddleware');
const {
  uploadProducts,
  getProductsList,
  querySpreadsheet,
  mutateSpreadsheet,
} = require('../controllers/sheetController');

const router = express.Router({ mergeParams: true });

// Specific products endpoints for backward compatibility
router.post('/products/upload', uploadSingleCsv, uploadProducts);
router.post('/products/append', uploadSingleCsv, (req, res, next) => {
  req.query.mode = 'append';
  return uploadProducts(req, res, next);
});
router.get('/products', getProductsList);

// Default endpoints
router.post('/upload', uploadSingleCsv, uploadProducts);
router.post('/append', uploadSingleCsv, (req, res, next) => {
  req.query.mode = 'append';
  return uploadProducts(req, res, next);
});
router.get('/', getProductsList);

// Universal natural-language query endpoint
router.post('/query', querySpreadsheet);

// Universal mutation endpoints (with preview on confirm=false, execute on confirm=true)
router.post('/mutate', mutateSpreadsheet);
router.post('/mutation', mutateSpreadsheet);

// Universal entity-scoped endpoints
router.post('/:entity/upload', uploadSingleCsv, uploadProducts);
router.post('/:entity/append', uploadSingleCsv, (req, res, next) => {
  req.query.mode = 'append';
  return uploadProducts(req, res, next);
});
router.get('/:entity', getProductsList);
router.post('/:entity/query', querySpreadsheet);
router.post('/:entity/mutate', mutateSpreadsheet);
router.post('/:entity/mutation', mutateSpreadsheet);

module.exports = router;
