const express = require('express');
const { uploadSingleCsv } = require('../middleware/uploadMiddleware');
const {
  uploadProducts,
  uploadServices,
  getProductsList,
  getServicesList,
  querySpreadsheet,
  mutateSpreadsheet,
  generateSheetData,
  saveGeneratedSheetData,
} = require('../controllers/sheetController');

const router = express.Router({ mergeParams: true });

// Two separate CSV upload endpoints
router.post('/products/upload', uploadSingleCsv, uploadProducts);
router.post('/services/upload', uploadSingleCsv, uploadServices);

// Table listings
router.get('/products', getProductsList);
router.get('/services', getServicesList);

// Natural-language query endpoint
router.post('/query', querySpreadsheet);

// Mutation endpoints (with preview on confirm=false, execute on confirm=true)
router.post('/mutate', mutateSpreadsheet);
router.post('/mutation', mutateSpreadsheet);

// AI sample sheet data generation & confirmed save endpoints
router.post('/generate', generateSheetData);
router.post('/generate/save', saveGeneratedSheetData);

module.exports = router;
