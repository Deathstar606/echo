const multer = require('multer');
const AppError = require('../utils/AppError');
const {
  getWorkspaceContacts,
  addFilteredContactOneClick,
  removeWorkspaceContact,
  importWorkspaceCustomerCsv,
} = require('../services/workspaceContactsService');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
});

async function listContacts(req, res, next) {
  try {
    const workspaceId = req.params.workspaceId || req.params.businessId;
    if (!workspaceId) {
      throw new AppError('workspaceId is required', 400);
    }
    const data = await getWorkspaceContacts(workspaceId);
    return res.status(200).json(data);
  } catch (err) {
    return next(err);
  }
}

async function addFilteredOneClick(req, res, next) {
  try {
    const workspaceId = req.params.workspaceId || req.params.businessId;
    if (!workspaceId) {
      throw new AppError('workspaceId is required', 400);
    }
    const { email, customer_name, customerName, metadata } = req.body || {};
    const contact = await addFilteredContactOneClick(workspaceId, {
      email,
      customer_name: customer_name || customerName,
      metadata,
    });
    return res.status(201).json({
      success: true,
      action: 'added',
      contact,
    });
  } catch (err) {
    return next(err);
  }
}

async function deleteContact(req, res, next) {
  try {
    const workspaceId = req.params.workspaceId || req.params.businessId;
    if (!workspaceId) {
      throw new AppError('workspaceId is required', 400);
    }
    const email = req.query.email || req.body?.email;
    const panel_type = req.query.panel_type || req.body?.panel_type || 'filtered';
    const id = req.query.id || req.body?.id;
    const deleted = await removeWorkspaceContact(workspaceId, { email, panel_type, id });
    return res.status(200).json({
      success: true,
      deleted,
    });
  } catch (err) {
    return next(err);
  }
}

async function uploadCsv(req, res, next) {
  try {
    const workspaceId = req.params.workspaceId || req.params.businessId;
    if (!workspaceId) {
      throw new AppError('workspaceId is required', 400);
    }

    let csvBufferOrString = null;
    if (req.file && req.file.buffer) {
      csvBufferOrString = req.file.buffer;
    } else if (req.body && (req.body.csvContent || req.body.fileContent || req.body.csv)) {
      csvBufferOrString = req.body.csvContent || req.body.fileContent || req.body.csv;
    } else if (typeof req.body === 'string' && req.body.trim()) {
      csvBufferOrString = req.body;
    }

    if (!csvBufferOrString) {
      const err = new AppError("The uploaded CSV file must contain an 'email' column.", 400);
      err.code = 'INVALID_CSV_SCHEMA';
      throw err;
    }

    const result = await importWorkspaceCustomerCsv(workspaceId, csvBufferOrString);
    return res.status(200).json(result);
  } catch (err) {
    return next(err);
  }
}

module.exports = {
  uploadMiddleware: upload.single('file'),
  listContacts,
  addFilteredOneClick,
  deleteContact,
  uploadCsv,
};
