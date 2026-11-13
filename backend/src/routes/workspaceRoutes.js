const express = require('express');
const { uploadWorkspaceFiles } = require('../middleware/uploadMiddleware');
const {
  uploadDocuments,
  getDocuments,
  deleteDocument,
  clearDocuments,
  seedDemoWorkspace,
  executeOperation,
  resolveSocratic,
  confirmOperation,
} = require('../controllers/workspaceController');

const router = express.Router({ mergeParams: true });

router.post('/documents/upload', uploadWorkspaceFiles, uploadDocuments);
router.get('/documents', getDocuments);
router.delete('/documents/:docId', deleteDocument);
router.delete('/documents', clearDocuments);
router.post('/demo/seed', seedDemoWorkspace);
router.post('/execute', executeOperation);
router.post('/resolve-socratic', resolveSocratic);
router.post('/confirm-operation', confirmOperation);

module.exports = router;
