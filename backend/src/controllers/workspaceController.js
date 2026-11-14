const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');
const { query } = require('../../db');
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
    const editedEmails = Array.isArray(req.body?.edited_emails)
      ? req.body.edited_emails
      : Array.isArray(req.body?.editedEmails)
        ? req.body.editedEmails
        : null;

    const result = await confirmWorkspaceOperation({
      workflowId,
      businessId,
      confirm,
      dryRun,
      editedEmails,
    });

    return res.status(200).json(result);
  } catch (err) {
    return next(err);
  }
}

/**
 * GET /api/workspaces/:workspaceId/documents/:docIdentifier/chunks
 * Flexible lookup by doc_id (UUID) or filename.
 * Fetches parent document metadata and all chunks ordered by chunk_index ASC.
 * Aggregates all_extracted_entities across all chunks.
 */
async function getDocumentChunks(req, res, next) {
  try {
    const businessId = await requireBusinessId(req);
    const rawIdentifier = req.params.docIdentifier || req.params.docId;
    if (!rawIdentifier || !String(rawIdentifier).trim()) {
      throw new AppError('Document identifier (ID or filename) is required.', 400);
    }

    const docIdentifier = decodeURIComponent(String(rawIdentifier).trim());
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const isUuid = UUID_RE.test(docIdentifier);

    let docRow = null;

    // 1. Fetch parent document from workspace_documents
    try {
      let docQuery;
      let docParams;
      if (isUuid) {
        docQuery = `
          SELECT doc_id, workspace_id, filename, mime_type, page_count, chunk_count, created_at, updated_at
          FROM workspace_documents
          WHERE workspace_id = $1 AND (doc_id = $2 OR LOWER(filename) = LOWER($3))
          LIMIT 1;
        `;
        docParams = [businessId, docIdentifier, docIdentifier];
      } else {
        docQuery = `
          SELECT doc_id, workspace_id, filename, mime_type, page_count, chunk_count, created_at, updated_at
          FROM workspace_documents
          WHERE workspace_id = $1 AND (LOWER(filename) = LOWER($2) OR LOWER(filename) = LOWER($3))
          LIMIT 1;
        `;
        const baseName = path.basename(docIdentifier);
        docParams = [businessId, docIdentifier, baseName];
      }

      const docRes = await query(docQuery, docParams);
      if (docRes?.rows?.length > 0) {
        docRow = docRes.rows[0];
      }
    } catch (dbErr) {
      console.warn('[getDocumentChunks] DB query error on workspace_documents:', dbErr.message);
    }

    // Fallback to in-memory documents if DB returned nothing
    if (!docRow) {
      const memDocs = await listDocumentsForBusiness(businessId);
      const matchedMem = memDocs.find(
        (d) =>
          String(d.doc_id || d.id || '') === docIdentifier ||
          d.filename.toLowerCase() === docIdentifier.toLowerCase() ||
          path.basename(d.filename).toLowerCase() === path.basename(docIdentifier).toLowerCase()
      );
      if (matchedMem) {
        docRow = {
          doc_id: matchedMem.doc_id || matchedMem.id,
          workspace_id: businessId,
          filename: matchedMem.filename,
          mime_type: matchedMem.mime_type,
          page_count: matchedMem.page_count,
          chunk_count: matchedMem.chunk_count,
          created_at: matchedMem.created_at,
        };
      }
    }

    if (!docRow) {
      throw new AppError(`Document "${docIdentifier}" was not found in this workspace.`, 404);
    }

    const docId = docRow.doc_id;
    const resolvedFilename = docRow.filename;

    // 2. Fetch chunks from workspace_document_chunks
    let chunkRows = [];
    try {
      const chunksRes = await query(
        `SELECT chunk_id, doc_id, workspace_document_id, workspace_id, filename, chunk_index, locator, breadcrumb_header, raw_text, enriched_text, extracted_entities
         FROM workspace_document_chunks
         WHERE workspace_id = $1 AND (doc_id = $2 OR workspace_document_id = $2 OR LOWER(filename) = LOWER($3))
         ORDER BY chunk_index ASC;`,
        [businessId, docId, resolvedFilename]
      );
      if (chunksRes?.rows?.length > 0) {
        chunkRows = chunksRes.rows;
      }
    } catch (dbErr) {
      console.warn('[getDocumentChunks] DB query error on workspace_document_chunks:', dbErr.message);
    }

    // Fallback to in-memory chunks if DB returned nothing
    if (chunkRows.length === 0) {
      const memChunks = await getChunksForBusiness(businessId);
      chunkRows = memChunks
        .filter(
          (c) =>
            String(c.doc_id || c.workspace_document_id || '') === String(docId) ||
            c.filename.toLowerCase() === resolvedFilename.toLowerCase()
        )
        .sort((a, b) => (a.chunk_index ?? 0) - (b.chunk_index ?? 0));
    }

    // 3. Aggregate a deduplicated array of all_extracted_entities across all chunks
    const entitySet = new Set();
    const formattedChunks = chunkRows.map((c, index) => {
      let entities = [];
      if (Array.isArray(c.extracted_entities)) {
        entities = c.extracted_entities;
      } else if (typeof c.extracted_entities === 'string') {
        try {
          const parsed = JSON.parse(c.extracted_entities);
          if (Array.isArray(parsed)) entities = parsed;
        } catch {
          entities = [];
        }
      }

      for (const ent of entities) {
        if (ent && typeof ent === 'string' && ent.trim()) {
          entitySet.add(ent.trim());
        }
      }

      return {
        id: c.chunk_id || `chunk-${c.chunk_index ?? index}`,
        chunk_index: c.chunk_index !== undefined ? Number(c.chunk_index) : index,
        locator: c.locator || `Page ${c.page_number || 1} / Chunk ${index + 1}`,
        breadcrumb_header: c.breadcrumb_header || null,
        raw_text: c.raw_text || '',
        enriched_text: c.enriched_text || null,
        extracted_entities: entities,
      };
    });

    const allExtractedEntities = Array.from(entitySet);

    return res.status(200).json({
      document: {
        id: docRow.doc_id,
        workspace_id: docRow.workspace_id || businessId,
        filename: docRow.filename,
        total_chunks: formattedChunks.length || docRow.chunk_count || 0,
        all_extracted_entities: allExtractedEntities,
        created_at: docRow.created_at,
      },
      chunks: formattedChunks,
    });
  } catch (err) {
    return next(err);
  }
}

/**
 * DELETE /api/workspace/documents/:docIdentifier
 * DELETE /api/workspaces/:workspaceId/documents/:docIdentifier
 * Deletes a single indexed unstructured document and all of its chunks for the active workspace.
 * Accepts either UUID doc_id OR filename.
 */
async function deleteDocument(req, res, next) {
  try {
    const businessId = await requireBusinessId(req);
    const rawIdentifier = req.params.docIdentifier || req.params.docId;
    if (!rawIdentifier || !String(rawIdentifier).trim()) {
      throw new AppError('Document identifier (ID or filename) is required.', 400);
    }
    const docIdentifier = decodeURIComponent(String(rawIdentifier).trim());
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    let targetDocId = docIdentifier;
    let targetFilename = docIdentifier;

    if (!UUID_RE.test(docIdentifier)) {
      try {
        const found = await query(
          `SELECT doc_id, filename FROM workspace_documents WHERE workspace_id = $1 AND LOWER(filename) = LOWER($2) LIMIT 1;`,
          [businessId, docIdentifier]
        );
        if (found?.rows?.length > 0) {
          targetDocId = found.rows[0].doc_id;
          targetFilename = found.rows[0].filename;
        }
      } catch (err) {
        console.warn('[deleteDocument] Error finding doc by filename in PostgreSQL:', err.message);
      }
    }

    const deleted = await deleteDocumentById({ businessId, docId: targetDocId });
    return res.status(200).json({
      status: 'success',
      message: `Removed document "${deleted.filename || targetFilename || deleted.doc_id}" and ${deleted.deleted_chunks} chunk(s).`,
      business_id: businessId,
      doc_id: deleted.doc_id || targetDocId,
      filename: deleted.filename || targetFilename,
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
  getDocumentChunks,
  deleteDocument,
  clearDocuments,
  seedDemoWorkspace,
  executeOperation,
  resolveSocratic,
  confirmOperation,
};
