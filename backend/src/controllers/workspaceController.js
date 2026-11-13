const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');
const AppError = require('../utils/AppError');
const { findBusinessOrThrow } = require('./businessController');
const {
  ingestDocument,
  listDocumentsForBusiness,
  getChunksForBusiness,
  deleteDocumentById,
  clearDocumentsForBusiness,
} = require('../services/documentIngestionService');
const { normalizeEntityName } = require('../services/sheetSchemaService');
const {
  detectEntityFromCsv,
  createOrRegisterDynamicTableFromCsv,
  parseAndValidateSheetCsv,
  importSheetRecordsToDatabase,
} = require('../services/sheetCsvImportService');
const {
  executeWorkspaceOperation,
  resolveSocraticWorkflow,
  confirmWorkspaceOperation,
} = require('../services/socraticOperationsService');
const {
  generateWorkspaceCustomerReply,
} = require('../services/workspaceReplyService');
const {
  normalizeConversationHistory,
} = require('../utils/conversationHistory');

function resolveBusinessIdFromReq(req) {
  return (
    req.params?.workspaceId ||
    req.body?.workspace_id ||
    req.body?.workspaceId ||
    req.query?.workspace_id ||
    req.query?.workspaceId ||
    req.params?.businessId ||
    req.body?.business_id ||
    req.body?.businessId ||
    req.query?.business_id ||
    req.query?.businessId ||
    null
  );
}

async function requireBusinessId(req) {
  const businessId = resolveBusinessIdFromReq(req);
  if (!businessId) {
    throw new AppError('A valid workspace_id or business_id is required for workspace operations.', 400);
  }
  const requestUserId =
    req.headers['x-user-id'] ||
    req.query?.userId ||
    req.query?.user_id ||
    req.body?.userId ||
    req.body?.user_id ||
    null;
  await findBusinessOrThrow(String(businessId), requestUserId);
  return String(businessId);
}

/**
 * POST /api/workspace/demo/seed
 * Ingests all demo assets from ./backend/demo (or .backend/demo):
 * - Fulfillment SLA Policy.pdf
 * - Supplier Delay Notice.pdf
 * - Commercial Orders Dataset.csv (into table "orders")
 */
async function seedDemoWorkspace(req, res, next) {
  try {
    const businessId = await requireBusinessId(req);
    const demoDirs = [
      path.resolve(__dirname, '../../demo'),
      path.resolve(__dirname, '../../../backend/demo'),
      path.resolve(__dirname, '../../../.backend/demo'),
    ];

    let foundDemoDir = null;
    for (const d of demoDirs) {
      if (fs.existsSync(d) && fs.statSync(d).isDirectory()) {
        foundDemoDir = d;
        break;
      }
    }

    if (!foundDemoDir) {
      throw new AppError('Demo assets directory was not found.', 404);
    }

    let assetDir = foundDemoDir;
    let demoFiles = fs.readdirSync(assetDir).filter((f) => {
      const full = path.join(assetDir, f);
      return fs.statSync(full).isFile();
    });
    if (
      !demoFiles.some((f) => /\.(?:pdf|csv|md|txt)$/i.test(f)) &&
      fs.existsSync(path.join(foundDemoDir, 'scenario_0'))
    ) {
      assetDir = path.join(foundDemoDir, 'scenario_0');
      demoFiles = fs.readdirSync(assetDir).filter((f) => {
        const full = path.join(assetDir, f);
        return fs.statSync(full).isFile();
      });
    }

    await clearDocumentsForBusiness(businessId);

    const ingestedDocuments = [];
    const importedTables = [];

    for (const file of demoFiles) {
      const fullPath = path.join(assetDir, file);
      const ext = path.extname(file).toLowerCase();
      const buffer = fs.readFileSync(fullPath);

      if (ext === '.csv') {
        const schema = await createOrRegisterDynamicTableFromCsv(
          'orders',
          buffer,
          businessId
        );
        const { validRecords, totalRows } = parseAndValidateSheetCsv(
          buffer,
          schema,
          { mode: 'replace' }
        );
        const importedCount = await importSheetRecordsToDatabase(
          businessId,
          schema,
          validRecords,
          { mode: 'replace', sourceFilename: file }
        );
        importedTables.push({
          table_name: schema.tableName,
          filename: file,
          total_rows: totalRows,
          imported_rows: importedCount,
        });
      } else if (ext === '.pdf' || ext === '.md' || ext === '.txt') {
        const docRecord = await ingestDocument({
          businessId,
          filename: file,
          buffer,
        });
        ingestedDocuments.push({
          doc_id: docRecord.doc_id,
          filename: docRecord.filename,
          page_count: docRecord.page_count,
          chunk_count: docRecord.chunk_count,
        });
      }
    }

    return res.status(200).json({
      status: 'success',
      message: 'Demo workspace successfully seeded with orders and policy documents.',
      documents: ingestedDocuments,
      tables: importedTables,
    });
  } catch (err) {
    return next(err);
  }
}

/**
 * POST /api/workspace/documents/upload
 * Ingests one or more uploaded documents (.pdf, .md, .txt, or .csv) into the workspace.
 */
async function uploadDocuments(req, res, next) {
  try {
    const businessId = await requireBusinessId(req);
    const files =
      Array.isArray(req.files) && req.files.length > 0
        ? req.files
        : req.file
          ? [req.file]
          : [];

    if (files.length === 0) {
      throw new AppError('No document file was uploaded.', 400);
    }

    const replaceAllFlag =
      req.query?.replace_all === 'true' ||
      req.body?.replace_all === true ||
      req.body?.replace_all === 'true';
    if (replaceAllFlag) {
      await clearDocumentsForBusiness(businessId);
    }

    const ingestedDocuments = [];
    const importedTables = [];

    for (const file of files) {
      const ext = path.extname(file.originalname || '').toLowerCase();
      if (ext === '.csv') {
        const rawBaseName = normalizeEntityName(
          path.basename(String(file.originalname || ''), ext)
        );
        const fallbackTableName =
          rawBaseName &&
          !['sheet', 'file', 'data', 'upload', 'sample', 'export'].includes(
            rawBaseName
          )
            ? rawBaseName
            : 'uploaded_sheet';
        const targetEntity =
          req.body?.entity ||
          req.body?.table_name ||
          detectEntityFromCsv(file.buffer, file.originalname, fallbackTableName);
        const schema = await createOrRegisterDynamicTableFromCsv(
          targetEntity,
          file.buffer,
          businessId
        );
        const { validRecords, totalRows } = parseAndValidateSheetCsv(
          file.buffer,
          schema,
          { mode: 'replace' }
        );
        const importedCount = await importSheetRecordsToDatabase(
          businessId,
          schema,
          validRecords,
          { mode: 'replace', sourceFilename: file.originalname }
        );
        importedTables.push({
          table_name: schema.tableName,
          filename: file.originalname,
          total_rows: totalRows,
          imported_rows: importedCount,
        });
      } else {
        const docRecord = await ingestDocument({
          businessId,
          filename: file.originalname,
          buffer: file.buffer,
          mimeType: file.mimetype,
        });
        ingestedDocuments.push({
          workspace_document_id: docRecord.doc_id,
          doc_id: docRecord.doc_id,
          filename: docRecord.filename,
          page_count: docRecord.page_count,
          chunk_count: docRecord.chunk_count,
        });
      }
    }

    return res.status(201).json({
      status: 'success',
      documents: ingestedDocuments,
      tables: importedTables,
    });
  } catch (err) {
    return next(err);
  }
}

/**
 * GET /api/workspace/documents
 * Lists all indexed unstructured documents for the business workspace.
 */
async function getDocuments(req, res, next) {
  try {
    const businessId = await requireBusinessId(req);
    const documents = await listDocumentsForBusiness(businessId);
    await getChunksForBusiness(businessId);
    return res.status(200).json({
      status: 'success',
      documents: documents.map((document) => ({
        doc_id: document.doc_id,
        filename: document.filename,
        mime_type: document.mime_type,
        page_count: document.page_count,
        chunk_count: document.chunk_count,
        created_at: document.created_at,
      })),
    });
  } catch (err) {
    return next(err);
  }
}

/**
 * POST /api/workspace/execute
 * Executes the Cross-Document Hybrid RAG + Socratic Conflict Gate pipeline.
 */
async function executeOperation(req, res, next) {
  try {
    const businessId = await requireBusinessId(req);
    const prompt =
      req.body?.prompt ||
      req.body?.instruction ||
      req.body?.query ||
      req.body?.message ||
      '';
    const requestEntity = String(req.body?.entity || 'user').trim().toLowerCase();
    const tableEntity =
      req.body?.table_name ||
      req.body?.active_table ||
      (['user', 'customer'].includes(requestEntity) ? null : req.body?.entity) ||
      null;

    const normalizedHistory = normalizeConversationHistory(
      req.body?.conversation_history ?? req.body?.history
    );

    if (requestEntity === 'customer') {
      const { aiResponse, suggestion, retrievedContext } =
        await generateWorkspaceCustomerReply({
          workspace: await findBusinessOrThrow(businessId),
          customerMessage: prompt,
          customerContext: req.body?.customer_context || {},
          conversationHistory: normalizedHistory,
        });
      return res.status(200).json({
        status: 'CONVERSATIONAL',
        conversational: true,
        intent: 'customer_reply',
        message: suggestion,
        answer: suggestion,
        suggestedReply: suggestion,
        category: aiResponse.category,
        missing_information: aiResponse.missing_information,
        citations: retrievedContext?.citations || [],
      });
    }

    const result = await executeWorkspaceOperation({
      businessId,
      prompt,
      entity: tableEntity,
      history: normalizedHistory,
    });

    return res.status(200).json(result);
  } catch (err) {
    return next(err);
  }
}

/**
 * POST /api/workspace/resolve-socratic
 * Resolves a CLARIFICATION_REQUIRED workflow with the user's selected Socratic option(s),
 * returning the PREVIEW_READY contract.
 */
async function resolveSocratic(req, res, next) {
  try {
    const businessId = await requireBusinessId(req);
    const workflowId = req.body?.workflow_id || req.body?.workflowId;
    const selectedOptions =
      req.body?.selected_options ??
      req.body?.selectedOptions ??
      req.body?.option_id ??
      req.body?.optionId ??
      null;

    const result = await resolveSocraticWorkflow({
      workflowId,
      selectedOptions,
      businessId,
    });

    return res.status(200).json(result);
  } catch (err) {
    return next(err);
  }
}

/**
 * POST /api/workspace/confirm-operation
 * Confirms a PREVIEW_READY workflow, atomically executing DB row mutations and email dispatches.
 */
async function confirmOperation(req, res, next) {
  try {
    const businessId = await requireBusinessId(req);
    const workflowId = req.body?.workflow_id || req.body?.workflowId;
    const confirm = Boolean(req.body?.confirm);
    const dryRun = Boolean(req.body?.dry_run ?? req.body?.dryRun ?? false);

    const result = await confirmWorkspaceOperation({
      workflowId,
      businessId,
      confirm,
      dryRun,
    });

    return res.status(200).json(result);
  } catch (err) {
    return next(err);
  }
}

/**
 * DELETE /api/workspace/documents/:docId
 * Deletes a single indexed unstructured document and all of its chunks for the active workspace.
 */
async function deleteDocument(req, res, next) {
  try {
    const businessId = await requireBusinessId(req);
    const { docId } = req.params;
    const deleted = await deleteDocumentById({ businessId, docId });
    return res.status(200).json({
      status: 'success',
      message: `Removed document "${deleted.filename || deleted.doc_id}" and ${deleted.deleted_chunks} chunk(s).`,
      business_id: businessId,
      doc_id: deleted.doc_id,
      filename: deleted.filename,
      deleted_chunks: deleted.deleted_chunks,
    });
  } catch (err) {
    return next(err);
  }
}

/**
 * DELETE /api/workspace/documents
 * Clears all indexed unstructured documents for the active business workspace.
 */
async function clearDocuments(req, res, next) {
  try {
    const businessId = await requireBusinessId(req);
    await clearDocumentsForBusiness(businessId);
    return res.status(200).json({
      status: 'success',
      message: 'Cleared all workspace documents for business.',
      business_id: businessId,
    });
  } catch (err) {
    return next(err);
  }
}

module.exports = {
  uploadDocuments,
  getDocuments,
  deleteDocument,
  clearDocuments,
  seedDemoWorkspace,
  executeOperation,
  resolveSocratic,
  confirmOperation,
};
