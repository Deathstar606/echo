const express = require('express');
const { uploadSingleCsv } = require('../middleware/uploadMiddleware');
const {
  uploadProducts,
  getProductsList,
  querySpreadsheet,
  mutateSpreadsheet,
} = require('../controllers/sheetController');

const router = express.Router({ mergeParams: true });

// Products CSV upload endpoint
router.post('/products/upload', uploadSingleCsv, uploadProducts);
router.post('/upload', uploadSingleCsv, uploadProducts);

// Products sheet listing endpoint
router.get('/products', getProductsList);
router.get('/', getProductsList);

// Natural-language query endpoint
router.post('/query', querySpreadsheet);

// Mutation endpoints (with preview on confirm=false, execute on confirm=true)
router.post('/mutate', mutateSpreadsheet);
router.post('/mutation', mutateSpreadsheet);

module.exports = router;
