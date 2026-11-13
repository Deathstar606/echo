const express = require('express');
const {
  uploadMiddleware,
  listContacts,
  addFilteredOneClick,
  deleteContact,
  uploadCsv,
} = require('../controllers/workspaceContactsController');

const router = express.Router({ mergeParams: true });

// GET /api/workspaces/:workspaceId/contacts or /api/businesses/:businessId/contacts
router.get('/', listContacts);

// POST /api/workspaces/:workspaceId/contacts/filtered-one-click
router.post('/filtered-one-click', addFilteredOneClick);

// DELETE /api/workspaces/:workspaceId/contacts
router.delete('/', deleteContact);

// POST /api/workspaces/:workspaceId/contacts/upload-csv
router.post('/upload-csv', uploadMiddleware, uploadCsv);

module.exports = router;
