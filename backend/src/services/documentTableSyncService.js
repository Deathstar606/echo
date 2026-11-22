const crypto = require('node:crypto');
const { query, withTransaction } = require('../../db');
const AppError = require('../utils/AppError');
const {
  discoverTableSchema,
  findColumnDef,
  quoteIdentifier,
} = require('./sheetSchemaService');
const {
  listDocumentsForBusiness,
  getChunksForBusiness,
} = require('./documentIngestionService');
const {
  retrieveHybridDocumentChunks,
  resolveRowIdentifierInfo,
  buildDocumentCitation,
  buildTableRowCitation,
} = require('./crossRagService');
const {
  generateStructuredJsonWithRetry,
} = require('./geminiService');
const {
  listWorkspaceTableMetadataCached,
  refreshWorkspaceTableMetadata,
  invalidateWorkspaceMetadataCache,
} = require('./workspaceTableMetadataService');
const {
  normalizeConversationHistory,
  formatConversationHistoryForPrompt,
} = require('../utils/conversationHistory');
const { coerceValueForColumn } = require('../utils/columnCoercion');
const { normalizeProductRow } = require('./sheetQueryService');

const MAX_DOC_SYNC_CHUNKS = 40;
const MAX_DOC_SYNC_CHARS = 28000;
const MAX_EXISTING_ROWS_CONTEXT = 250;

const SYSTEM_COLUMN_NAMES = new Set([
  'id',
  'business_id',
  'workspace_id',
  'user_id',
  'workspace_document_id',
  '_google_row_index',
  'created_at',
  'updated_at',
]);

const LONG_PROSE_COLUMNS = new Set([
  'description',
  'notes',
  'comments',
  'summary',
  'full_text',
  'raw_text',
  'body',
  'images',
  'image_url',
  'product_url',
  'url',
]);

const FILENAME_STOP_TOKENS = new Set([
  'pdf',
  'txt',
  'csv',
  'doc',
  'docx',
  'file',
  'document',
  'the',
  'and',
  'for',
  'with',
  'from',
]);

const DOCUMENT_TABLE_SYNC_SCHEMA = {
  type: 'OBJECT',
  properties: {
    document_relevant: {
      type: 'BOOLEAN',
      description:
        'True if SOURCE_DOCUMENT_CHUNKS contain structured or semi-structured record data relevant to updating/adding/deleting rows in ACTIVE_TABLE.',
    },
    inferred_operation: {
      type: 'STRING',
      enum: ['create', 'update', 'delete', 'mixed', 'none'],
      description: 'Overall mutation mode requested for the active table.',
    },
    summary: {
      type: 'STRING',
      description: 'Brief 1-sentence factual summary of what was found in the document(s).',
    },
    operations: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          operation: {
            type: 'STRING',
            enum: ['create', 'update', 'delete'],
          },
          target_row_identifier: {
            type: 'STRING',
            description:
              'For update/delete: exact _row_id from EXISTING_ACTIVE_TABLE_ROWS (or primary key value if clear). For create: primary identifier value extracted from the document, or "New Row #N".',
          },
          fields: {
            type: 'ARRAY',
            items: {
              type: 'OBJECT',
              properties: {
                column: {
                  type: 'STRING',
                  description: 'Exact column name from ACTIVE_TABLE_MODIFIABLE_COLUMNS.',
                },
                value: {
                  type: 'STRING',
                  nullable: true,
                  description:
                    'Value explicitly found in SOURCE_DOCUMENT_CHUNKS or USER_REQUEST, serialized cleanly as string, OR null if NOT present in the source document.',
                },
              },
              required: ['column'],
            },
          },
          source_locator: {
            type: 'STRING',
            description: 'Document filename / page / entry reference where this record appears.',
          },
          reason: {
            type: 'STRING',
            description: 'Short explanation of why this add/update/delete operation is proposed.',
          },
        },
        required: [
          'operation',
          'target_row_identifier',
          'fields',
          'source_locator',
          'reason',
        ],
      },
    },
  },
  required: ['document_relevant', 'inferred_operation', 'summary', 'operations'],
};

function isNullishOrBlankValue(val) {
  if (val === null || val === undefined) return true;
  const s = String(val).trim();
  if (!s) return true;
  return /^(?:null|undefined|n\/a|none|unknown|<missing>)$/i.test(s);
}

/**
 * Resolves the relevant uploaded workspace document(s) and loads ALL chunks belonging
 * to them in chronological page/chunk order so multi-page entries are never dropped.
 */
async function resolveSourceDocumentsForSync(
  businessId,
  prompt,
  activeTableName,
  modifiableColumns = []
) {
  const documents = (await listDocumentsForBusiness(businessId).catch(() => [])) || [];
  if (documents.length === 0) {
    return { sourceDocuments: [], sourceChunks: [] };
  }

  const normPrompt = String(prompt || '')
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ');
  const promptLower = String(prompt || '').toLowerCase();

  // Pass 1: Dynamic filename / normalized stem matching (works for any arbitrary uploaded filename)
  const scoredDocs = documents.map((doc) => {
    const rawName = String(doc.filename || '').trim();
    const rawLower = rawName.toLowerCase();
    const stem = rawLower.replace(/\.[^.]+$/, '');
    const spacedStem = stem.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
    let score = 0;

    if (rawLower && promptLower.includes(rawLower)) {
      score += 120;
    } else if (spacedStem.length >= 4 && normPrompt.includes(spacedStem)) {
      score += 100;
    } else {
      const stemTokens = spacedStem
        .split(/[^a-z0-9]+/)
        .filter((t) => t.length >= 3 && !FILENAME_STOP_TOKENS.has(t));
      if (stemTokens.length > 0) {
        const matched = stemTokens.filter((tok) =>
          new RegExp(`\\b${tok.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(normPrompt)
        );
        if (matched.length > 0 && matched.length / stemTokens.length >= 0.5) {
          score += 50 * (matched.length / stemTokens.length);
        }
      }
    }

    return { doc, score };
  });

  scoredDocs.sort((a, b) => b.score - a.score);
  const topExplicitScore = scoredDocs[0]?.score || 0;
  let selectedDocs = [];

  if (topExplicitScore >= 40) {
    selectedDocs = scoredDocs
      .filter((entry) => entry.score >= Math.max(40, topExplicitScore * 0.8))
      .slice(0, 2)
      .map((entry) => entry.doc);
  }

  let hybridFallbackChunks = [];
  if (selectedDocs.length === 0) {
    const colNames = modifiableColumns.map((c) => c.name).slice(0, 12).join(' ');
    const semanticQuery = `${prompt} ${activeTableName || ''} ${colNames}`.trim();
    hybridFallbackChunks =
      (await retrieveHybridDocumentChunks(businessId, semanticQuery, {
        topK: 16,
        includeAllIfOperational: true,
      }).catch(() => [])) || [];

    const docScoreMap = new Map();
    for (const chunk of hybridFallbackChunks) {
      const hs = Number(chunk.hybrid_score || 0);
      if (hs <= 0) continue;
      const key = String(chunk.doc_id || chunk.filename || '').toLowerCase();
      if (!key) continue;
      docScoreMap.set(key, (docScoreMap.get(key) || 0) + hs);
    }

    if (docScoreMap.size > 0) {
      const sortedDocScores = [...docScoreMap.entries()].sort((a, b) => b[1] - a[1]);
      const bestScore = sortedDocScores[0][1];
      const allowedKeys = new Set(
        sortedDocScores
          .filter(([, s]) => s >= bestScore * 0.65)
          .slice(0, 2)
          .map(([k]) => k)
      );
      selectedDocs = documents.filter(
        (d) =>
          allowedKeys.has(String(d.doc_id || '').toLowerCase()) ||
          allowedKeys.has(String(d.filename || '').toLowerCase())
      );
    }
  }

  if (selectedDocs.length === 0 && documents.length === 1) {
    selectedDocs = [documents[0]];
  }

  if (selectedDocs.length === 0) {
    return { sourceDocuments: [], sourceChunks: [] };
  }

  const selectedDocIds = new Set(
    selectedDocs.map((d) => String(d.doc_id || '').toLowerCase()).filter(Boolean)
  );
  const selectedNames = new Set(
    selectedDocs.map((d) => String(d.filename || '').toLowerCase()).filter(Boolean)
  );

  const allChunks = (await getChunksForBusiness(businessId).catch(() => [])) || [];
  let matchingChunks = allChunks
    .filter((c) => {
      const cid = String(c.doc_id || c.workspace_document_id || '').toLowerCase();
      const cname = String(c.filename || '').toLowerCase();
      return (cid && selectedDocIds.has(cid)) || (cname && selectedNames.has(cname));
    })
    .sort((a, b) => {
      const pageDiff = Number(a.page_number || 1) - Number(b.page_number || 1);
      if (pageDiff !== 0) return pageDiff;
      return Number(a.chunk_index || 0) - Number(b.chunk_index || 0);
    });

  if (matchingChunks.length === 0 && hybridFallbackChunks.length > 0) {
    matchingChunks = hybridFallbackChunks.filter((c) => {
      const cid = String(c.doc_id || c.workspace_document_id || '').toLowerCase();
      const cname = String(c.filename || '').toLowerCase();
      return (cid && selectedDocIds.has(cid)) || (cname && selectedNames.has(cname));
    });
  }

  const boundedChunks = [];
  let accumulatedChars = 0;
  for (const chunk of matchingChunks) {
    if (boundedChunks.length >= MAX_DOC_SYNC_CHUNKS) break;
    const rawLen = String(chunk.raw_text || '').length;
    if (boundedChunks.length > 0 && accumulatedChars + rawLen > MAX_DOC_SYNC_CHARS) {
      break;
    }
    boundedChunks.push(chunk);
    accumulatedChars += rawLen;
  }

  return {
    sourceDocuments: selectedDocs.map((d) => ({
      doc_id: d.doc_id,
      filename: d.filename,
      page_count: Number(d.page_count || 1),
      chunk_count: Number(d.chunk_count || 0),
    })),
    sourceChunks: boundedChunks,
  };
}

/**
 * Loads ONLY the currently active table schema, modifiable column metadata,
 * detected business primary key column, and compact tenant-scoped live rows.
 */
async function buildActiveTableSyncContext(businessId, activeTableName, metadataRows = null) {
  const cleanActive = String(activeTableName || '').trim();
  if (!cleanActive) {
    return {
      errorResponse: {
        status: 'CONVERSATIONAL',
        conversational: true,
        intent: 'clarification_needed',
        message:
          'Please select an active table in the spreadsheet viewer before syncing records from a document.',
        citations: [],
      },
    };
  }

  const resolvedMeta = Array.isArray(metadataRows)
    ? metadataRows
    : (await listWorkspaceTableMetadataCached(businessId).catch(() => [])) || [];

  const matchedMeta =
    resolvedMeta.find(
      (m) => String(m.table_name || '').toLowerCase() === cleanActive.toLowerCase()
    ) || null;

  const schema = await discoverTableSchema(cleanActive, businessId, {
    useCache: true,
    prefetchedMetadata: matchedMeta,
    skipSampleQuery: true,
  });

  const profileByCol = new Map();
  if (Array.isArray(matchedMeta?.columns_profile)) {
    for (const p of matchedMeta.columns_profile) {
      if (p?.column_name) {
        profileByCol.set(String(p.column_name).toLowerCase(), p);
      }
    }
  }

  const modifiableColumns = [];
  for (const [key, def] of Object.entries(schema.columns || {})) {
    const exactName = String(def?.exactName || key);
    const lower = exactName.toLowerCase();
    if (SYSTEM_COLUMN_NAMES.has(lower)) continue;
    if (def?.readonly || def?.virtual) continue;

    const prof = profileByCol.get(lower);
    const repSource =
      Array.isArray(prof?.categorical_values) && prof.categorical_values.length > 0
        ? prof.categorical_values
        : Array.isArray(schema.representativeValues?.[key])
          ? schema.representativeValues[key]
          : [];
    const representativeValues = repSource
      .map((v) => String(v ?? '').trim())
      .filter((v) => v && v.length <= 50 && !/^\s*[{[]/.test(v))
      .slice(0, 15);

    modifiableColumns.push({
      key,
      name: exactName,
      type: def.type || 'string',
      required: Boolean(def.required),
      nullable: !def.required,
      storage_type: String(def.storageType || def.type || 'varchar'),
      description: def.description ? String(def.description) : undefined,
      representative_values: representativeValues,
      colDef: def,
    });
  }

  if (modifiableColumns.length === 0) {
    return {
      errorResponse: {
        status: 'CONVERSATIONAL',
        conversational: true,
        intent: 'clarification_needed',
        message: `Table "${schema.tableName}" does not have any modifiable columns to update.`,
        citations: [],
      },
    };
  }

  const bizColExact = schema.columns?.business_id?.exactName || 'business_id';
  const bizSql = quoteIdentifier(bizColExact);
  const whereClause = schema.columns?.workspace_id
    ? `(${bizSql} = $1 OR ${quoteIdentifier(schema.columns.workspace_id.exactName)} = $1)`
    : `${bizSql} = $1`;
  const idSql = schema.columns?.id ? quoteIdentifier(schema.columns.id.exactName) : null;
  const orderSql = idSql ? ` ORDER BY ${idSql} ASC` : '';

  const rowsRes = await query(
    `SELECT * FROM ${quoteIdentifier(schema.tableName)} WHERE ${whereClause}${orderSql} LIMIT ${MAX_EXISTING_ROWS_CONTEXT};`,
    [businessId]
  );
  const liveRows = (rowsRes?.rows || []).map((r) => normalizeProductRow(r, schema));

  let primaryKeyColumn = matchedMeta?.primary_key_column || schema.primaryKey || null;
  if (primaryKeyColumn && SYSTEM_COLUMN_NAMES.has(String(primaryKeyColumn).toLowerCase())) {
    primaryKeyColumn = null;
  }
  if (!primaryKeyColumn && liveRows.length > 0) {
    const info = resolveRowIdentifierInfo(liveRows[0], 1, schema);
    if (info.column && !SYSTEM_COLUMN_NAMES.has(String(info.column).toLowerCase())) {
      primaryKeyColumn = info.column;
    }
  }
  if (!primaryKeyColumn) {
    const codeOrNameCol = modifiableColumns.find((c) =>
      /(?:^|_)(?:id|code|sku|key|number|no|name|title|email)$/i.test(c.name)
    );
    primaryKeyColumn = codeOrNameCol ? codeOrNameCol.name : modifiableColumns[0].name;
  }

  return {
    schema,
    matchedMeta,
    modifiableColumns,
    primaryKeyColumn,
    liveRows,
  };
}

function buildCompactRowSnapshot(row, idx, schema) {
  const { identifier } = resolveRowIdentifierInfo(row, idx + 1, schema);
  const compact = { _row_id: identifier };
  for (const [k, v] of Object.entries(row || {})) {
    const lower = k.toLowerCase();
    if (SYSTEM_COLUMN_NAMES.has(lower)) continue;
    if (v === null || v === undefined || v === '') continue;
    let serialized = typeof v === 'object' ? JSON.stringify(v) : String(v);
    if (LONG_PROSE_COLUMNS.has(lower) && serialized.length > 60) {
      serialized = `${serialized.slice(0, 57)}...`;
    } else if (serialized.length > 90) {
      serialized = `${serialized.slice(0, 87)}...`;
    }
    compact[k] = serialized;
  }
  return compact;
}

/**
 * Performs a single structured Gemini extraction from the matched document chunks
 * against ONLY the active table schema and existing rows.
 */
async function extractDocumentTableOperations({
  prompt,
  schema,
  modifiableColumns,
  primaryKeyColumn,
  liveRows,
  sourceDocuments,
  sourceChunks,
  history = [],
}) {
  const compactColumns = modifiableColumns.map((col) => ({
    column: col.name,
    type: col.type,
    required_in_sql: col.required,
    description: col.description || undefined,
    sample_values: col.representative_values.length > 0 ? col.representative_values : undefined,
  }));

  const compactRows = liveRows
    .slice(0, MAX_EXISTING_ROWS_CONTEXT)
    .map((row, idx) => buildCompactRowSnapshot(row, idx, schema));

  const chunkPayload = sourceChunks.map((c) => ({
    filename: c.filename,
    page: c.page_number || 1,
    section: c.section_title || undefined,
    locator: c.locator || undefined,
    content: c.raw_text || '',
  }));

  const normalizedHistory = normalizeConversationHistory(history);
  const formattedHistory = formatConversationHistoryForPrompt(normalizedHistory);

  const extractionPrompt = `Extract structured row operations (create, update, or delete) for the ACTIVE TABLE using ONLY the uploaded document chunks and the user's request.

ACTIVE_TABLE: "${schema.tableName}"
PRIMARY_KEY_COLUMN: "${primaryKeyColumn || ''}"
ACTIVE_TABLE_MODIFIABLE_COLUMNS:
${JSON.stringify(compactColumns)}

EXISTING_ACTIVE_TABLE_ROWS (current DB rows, identified by _row_id):
${JSON.stringify(compactRows)}

SOURCE_DOCUMENTS:
${JSON.stringify(sourceDocuments.map((d) => d.filename))}

SOURCE_DOCUMENT_CHUNKS (ALL pages/sections in order):
${JSON.stringify(chunkPayload)}

RECENT CONVERSATION:
${formattedHistory || '[]'}

USER_REQUEST:
${String(prompt || '').trim()}

STRICT RULES:
1. Target ONLY ACTIVE_TABLE ("${schema.tableName}") and use ONLY exact column names from ACTIVE_TABLE_MODIFIABLE_COLUMNS. Never invent columns or target other tables.
2. Process EVERY matching entry across ALL chunks/pages in SOURCE_DOCUMENT_CHUNKS — never stop after page 1.
3. Choose operation per entry strictly according to the document content and USER_REQUEST:
   - "create": add new row(s) described in the document that are not simply updating existing rows.
   - "update": modify column(s) of existing row(s) in EXISTING_ACTIVE_TABLE_ROWS matched by exact _row_id.
   - "delete": remove existing row(s) from EXISTING_ACTIVE_TABLE_ROWS matched by exact _row_id.
4. CRITICAL ANTI-HALLUCINATION RULE: Include ONLY field values explicitly stated in SOURCE_DOCUMENT_CHUNKS or explicitly specified in USER_REQUEST. If a modifiable column's value is NOT explicitly stated in the document for a row, set "value": null or omit that field completely — NEVER guess, infer, calculate unstated defaults, or invent placeholder values like "0", "Unknown", or today's date unless explicitly instructed by USER_REQUEST or written in the document.
5. Normalize explicit calendar dates to YYYY-MM-DD when clearly stated in the document.
6. For "update" or "delete", set "target_row_identifier" to the exact _row_id from EXISTING_ACTIVE_TABLE_ROWS. For "create", set "target_row_identifier" to the record's extracted PRIMARY_KEY_COLUMN value (or "New Row #N" if absent).
7. If SOURCE_DOCUMENT_CHUNKS contain no actionable records relevant to ACTIVE_TABLE, set "document_relevant": false, "inferred_operation": "none", "operations": [].`;

  return generateStructuredJsonWithRetry(
    extractionPrompt,
    (parsed) => {
      if (!parsed || typeof parsed !== 'object') {
        throw new AppError('Document sync extractor returned an invalid response object.', 502);
      }
      if (!Array.isArray(parsed.operations)) {
        throw new AppError('Document sync extractor omitted the operations array.', 502);
      }
      return parsed;
    },
    {
      responseSchema: DOCUMENT_TABLE_SYNC_SCHEMA,
      maxRetries: 1,
      stage: 'document_table_sync',
    }
  );
}

/**
 * Deterministically validates extracted operations against live schema & live rows:
 * audits missing columns without guessing values, detects duplicate primary keys on inserts,
 * and resolves exact database row references for updates and deletes.
 */
function auditAndBuildSyncPreview({
  extracted,
  schema,
  modifiableColumns,
  primaryKeyColumn,
  liveRows,
  sourceDocuments,
  sourceChunks,
  prompt,
}) {
  const docCitations = [];
  const seenChunkLocators = new Set();
  for (const chunk of sourceChunks) {
    const c = buildDocumentCitation(chunk);
    const key = `${c.source_name}|${c.locator}`;
    if (!seenChunkLocators.has(key)) {
      seenChunkLocators.add(key);
      docCitations.push(c);
    }
  }

  if (
    !extracted?.document_relevant ||
    !Array.isArray(extracted.operations) ||
    extracted.operations.length === 0
  ) {
    const docNames = sourceDocuments.map((d) => d.filename).join(', ') || 'workspace documents';
    return {
      workflow: null,
      response: {
        status: 'CONVERSATIONAL',
        conversational: true,
        intent: 'document_table_sync',
        message:
          extracted?.summary ||
          `I checked ${docNames}, but found no records matching the columns of "${schema.tableName}". No table changes were proposed.`,
        citations: docCitations.slice(0, 8),
      },
    };
  }

  // Index existing active-table rows for O(1) duplicate & match lookup
  const rowByRowId = new Map();
  const rowByDbId = new Map();
  const rowByPkValue = new Map();

  liveRows.forEach((row, idx) => {
    const { identifier, column } = resolveRowIdentifierInfo(row, idx + 1, schema);
    if (identifier) {
      rowByRowId.set(String(identifier).trim().toLowerCase(), {
        row,
        identifier,
        column,
        idx,
      });
    }
    if (row.id !== undefined && row.id !== null) {
      rowByDbId.set(String(row.id).trim().toLowerCase(), {
        row,
        identifier: identifier || String(row.id),
        column: column || 'id',
        idx,
      });
    }
    if (primaryKeyColumn) {
      const pkVal = row[primaryKeyColumn];
      if (pkVal !== undefined && pkVal !== null && String(pkVal).trim() !== '') {
        rowByPkValue.set(String(pkVal).trim().toLowerCase(), {
          row,
          identifier: String(pkVal).trim(),
          column: primaryKeyColumn,
          idx,
        });
      }
    }
  });

  const colMetaMap = new Map(
    modifiableColumns.map((c) => [c.name.toLowerCase(), c])
  );

  const matchExistingRow = (targetIdent, fieldsMap = {}) => {
    const candidates = [targetIdent];
    if (primaryKeyColumn && fieldsMap[primaryKeyColumn] !== undefined && fieldsMap[primaryKeyColumn] !== null) {
      candidates.push(fieldsMap[primaryKeyColumn]);
    }
    for (const cand of candidates) {
      const key = String(cand ?? '').trim().toLowerCase();
      if (!key) continue;
      if (rowByRowId.has(key)) return rowByRowId.get(key);
      if (rowByPkValue.has(key)) return rowByPkValue.get(key);
      if (rowByDbId.has(key)) return rowByDbId.get(key);
    }
    return null;
  };

  const mutationsPreview = [];
  const tableCitations = [];
  const seenRowCitations = new Set();

  extracted.operations.forEach((rawOp, idx) => {
    const opType = ['create', 'update', 'delete'].includes(String(rawOp?.operation || '').toLowerCase())
      ? String(rawOp.operation).toLowerCase()
      : 'create';

    const mappedFields = {};
    const fieldCoercionErrors = {};

    for (const f of Array.isArray(rawOp?.fields) ? rawOp.fields : []) {
      const found = findColumnDef(schema, String(f?.column || '').trim());
      if (!found) continue;
      const exactCol = found.exactName;
      if (SYSTEM_COLUMN_NAMES.has(exactCol.toLowerCase())) continue;
      if (!colMetaMap.has(exactCol.toLowerCase())) continue;

      if (isNullishOrBlankValue(f?.value)) {
        mappedFields[exactCol] = null;
        continue;
      }

      try {
        mappedFields[exactCol] = coerceValueForColumn(found.colDef, exactCol, f.value);
      } catch (err) {
        mappedFields[exactCol] = String(f.value).trim();
        fieldCoercionErrors[exactCol] = err.message;
      }
    }

    if (opType === 'create') {
      const after = {};
      const missingFields = [];
      for (const col of modifiableColumns) {
        const val = Object.prototype.hasOwnProperty.call(mappedFields, col.name)
          ? mappedFields[col.name]
          : null;
        after[col.name] = val === undefined ? null : val;
        if (val === null || val === undefined || String(val).trim() === '') {
          missingFields.push(col.name);
        }
      }

      const pkVal = primaryKeyColumn ? after[primaryKeyColumn] : null;
      const rowIdent =
        pkVal !== null && pkVal !== undefined && String(pkVal).trim() !== ''
          ? String(pkVal).trim()
          : String(rawOp?.target_row_identifier || '').trim() || `New Row #${idx + 1}`;

      const existingMatch = pkVal
        ? matchExistingRow(String(pkVal), after)
        : null;
      const duplicateWarning = existingMatch
        ? `A row with ${primaryKeyColumn || 'key'} = "${rowIdent}" already exists in ${schema.tableName}.`
        : null;

      mutationsPreview.push({
        table_name: schema.tableName,
        operation: 'create',
        row_index: idx,
        row_identifier: rowIdent,
        before: {},
        after,
        missing_fields: missingFields,
        field_errors: Object.keys(fieldCoercionErrors).length > 0 ? fieldCoercionErrors : undefined,
        duplicate_warning: duplicateWarning,
        unmatched_warning: null,
        source_locator: rawOp?.source_locator || null,
        reason: rawOp?.reason || 'Extracted new record from document.',
        include: !duplicateWarning,
      });
      return;
    }

    if (opType === 'update') {
      const matched = matchExistingRow(rawOp?.target_row_identifier, mappedFields);
      if (!matched) {
        mutationsPreview.push({
          table_name: schema.tableName,
          operation: 'update',
          row_index: idx,
          row_identifier: String(rawOp?.target_row_identifier || `Unmatched #${idx + 1}`),
          before: {},
          after: mappedFields,
          missing_fields: [],
          duplicate_warning: null,
          unmatched_warning: `No matching row "${rawOp?.target_row_identifier || ''}" found in ${schema.tableName}.`,
          source_locator: rawOp?.source_locator || null,
          reason: rawOp?.reason || 'Proposed row update from document.',
          include: false,
        });
        return;
      }

      const before = {};
      for (const col of modifiableColumns) {
        if (matched.row[col.name] !== undefined) {
          before[col.name] = matched.row[col.name];
        }
      }
      const after = {};
      const missingFields = [];

      for (const [colName, proposedVal] of Object.entries(mappedFields)) {
        if (!Object.prototype.hasOwnProperty.call(before, colName)) {
          before[colName] = matched.row[colName] ?? null;
        }
        after[colName] = proposedVal;
        if (proposedVal === null || proposedVal === undefined || String(proposedVal).trim() === '') {
          missingFields.push(colName);
        }
      }

      if (!seenRowCitations.has(matched.identifier)) {
        seenRowCitations.add(matched.identifier);
        tableCitations.push(buildTableRowCitation(schema.tableName, matched.row, matched.idx + 1));
      }

      mutationsPreview.push({
        table_name: schema.tableName,
        operation: 'update',
        row_index: idx,
        row_identifier: matched.identifier,
        _internal_id: matched.row.id || null,
        _identifier_col: matched.column || null,
        before,
        after,
        missing_fields: missingFields,
        field_errors: Object.keys(fieldCoercionErrors).length > 0 ? fieldCoercionErrors : undefined,
        duplicate_warning: null,
        unmatched_warning: null,
        source_locator: rawOp?.source_locator || null,
        reason: rawOp?.reason || 'Proposed row update from document.',
        include: Object.keys(after).length > 0,
      });
      return;
    }

    // opType === 'delete'
    const matched = matchExistingRow(rawOp?.target_row_identifier, mappedFields);
    if (!matched) {
      mutationsPreview.push({
        table_name: schema.tableName,
        operation: 'delete',
        row_index: idx,
        row_identifier: String(rawOp?.target_row_identifier || `Unmatched #${idx + 1}`),
        before: mappedFields,
        after: {},
        missing_fields: [],
        duplicate_warning: null,
        unmatched_warning: `No matching row "${rawOp?.target_row_identifier || ''}" found in ${schema.tableName}.`,
        source_locator: rawOp?.source_locator || null,
        reason: rawOp?.reason || 'Proposed row deletion from document.',
        include: false,
      });
      return;
    }

    const before = {};
    for (const col of modifiableColumns) {
      if (matched.row[col.name] !== undefined) {
        before[col.name] = matched.row[col.name];
      }
    }

    if (!seenRowCitations.has(matched.identifier)) {
      seenRowCitations.add(matched.identifier);
      tableCitations.push(buildTableRowCitation(schema.tableName, matched.row, matched.idx + 1));
    }

    mutationsPreview.push({
      table_name: schema.tableName,
      operation: 'delete',
      row_index: idx,
      row_identifier: matched.identifier,
      _internal_id: matched.row.id || null,
      _identifier_col: matched.column || null,
      before,
      after: {},
      missing_fields: [],
      duplicate_warning: null,
      unmatched_warning: null,
      source_locator: rawOp?.source_locator || null,
      reason: rawOp?.reason || 'Proposed row deletion from document.',
      include: true,
    });
  });

  // Compute deduplicated missing columns across all included operations
  const missingColSet = new Set();
  for (const mut of mutationsPreview) {
    if (mut.include === false) continue;
    for (const colName of mut.missing_fields || []) {
      missingColSet.add(colName);
    }
  }
  const missingColumns = modifiableColumns
    .map((c) => c.name)
    .filter((name) => missingColSet.has(name));

  const requiresFieldCompletion = missingColumns.length > 0;
  const opTypesPresent = new Set(mutationsPreview.map((m) => m.operation));
  const operationMode =
    opTypesPresent.size > 1 ? 'mixed' : [...opTypesPresent][0] || 'create';

  const createCount = mutationsPreview.filter((m) => m.operation === 'create').length;
  const updateCount = mutationsPreview.filter((m) => m.operation === 'update').length;
  const deleteCount = mutationsPreview.filter((m) => m.operation === 'delete').length;
  const countParts = [];
  if (createCount > 0) countParts.push(`${createCount} row addition(s)`);
  if (updateCount > 0) countParts.push(`${updateCount} row update(s)`);
  if (deleteCount > 0) countParts.push(`${deleteCount} row deletion(s)`);

  const docLabel = sourceDocuments.map((d) => d.filename).join(', ');
  const summaryPrefix = `Prepared ${countParts.join(', ')} for "${schema.tableName}" from ${docLabel}.`;
  const duplicateCount = mutationsPreview.filter((m) => Boolean(m.duplicate_warning)).length;
  const duplicateNote =
    duplicateCount > 0
      ? ` ${duplicateCount} duplicate record(s) already exist in "${schema.tableName}" and were unchecked by default.`
      : '';

  const message = requiresFieldCompletion
    ? `${summaryPrefix}${duplicateNote} Missing from document: ${missingColumns.join(', ')}. Please enter values for the empty column(s) in the preview panel on the fly, or stop/cancel the table update.`
    : `${summaryPrefix}${duplicateNote} Review the proposed rows in the preview panel and confirm to apply.`;

  const tableColumns = modifiableColumns.map((c) => ({
    name: c.name,
    type: c.type,
    required: c.required,
    nullable: c.nullable,
    storage_type: c.storage_type,
    description: c.description,
    representative_values: c.representative_values,
  }));

  const citations = [...docCitations, ...tableCitations].slice(0, 14);
  const workflowId = crypto.randomUUID();

  const publicMutationsPreview = mutationsPreview.map(
    ({ _internal_id, _identifier_col, ...publicFields }) => publicFields
  );

  const workflow = {
    workflow_id: workflowId,
    workflow_type: 'document_table_sync',
    operation_mode: operationMode,
    business_id: null, // assigned by planDocumentTableSync
    status: 'PREVIEW_READY',
    prompt,
    target_entity: schema.tableName,
    requires_field_completion: requiresFieldCompletion,
    missing_columns: missingColumns,
    table_columns: tableColumns,
    source_documents: sourceDocuments,
    mutations_preview: mutationsPreview,
    emails_preview: [],
    citations,
  };

  return {
    workflow,
    response: {
      status: 'PREVIEW_READY',
      workflow_id: workflowId,
      workflow_type: 'document_table_sync',
      operation_mode: operationMode,
      target_entity: schema.tableName,
      matched_row_ids: publicMutationsPreview.map((m) => String(m.row_identifier)).filter(Boolean),
      requires_field_completion: requiresFieldCompletion,
      missing_columns: missingColumns,
      table_columns: tableColumns,
      source_documents: sourceDocuments,
      mutations_preview: publicMutationsPreview,
      emails_preview: [],
      citations,
      message,
    },
  };
}

/**
 * Orchestrates planning of a document-to-active-table CRUD preview.
 */
async function planDocumentTableSync({
  businessId,
  prompt,
  activeEntity = null,
  history = [],
  metadataRows = null,
}) {
  const tableCtx = await buildActiveTableSyncContext(businessId, activeEntity, metadataRows);
  if (tableCtx.errorResponse) {
    return { workflow: null, response: tableCtx.errorResponse };
  }

  const { schema, modifiableColumns, primaryKeyColumn, liveRows } = tableCtx;
  const { sourceDocuments, sourceChunks } = await resolveSourceDocumentsForSync(
    businessId,
    prompt,
    schema.tableName,
    modifiableColumns
  );

  if (sourceDocuments.length === 0 || sourceChunks.length === 0) {
    return {
      workflow: null,
      response: {
        status: 'CONVERSATIONAL',
        conversational: true,
        intent: 'document_table_sync',
        message:
          'No relevant uploaded workspace document chunks were found to update this table. Upload a document containing the source records first.',
        citations: [],
      },
    };
  }

  const extracted = await extractDocumentTableOperations({
    prompt,
    schema,
    modifiableColumns,
    primaryKeyColumn,
    liveRows,
    sourceDocuments,
    sourceChunks,
    history,
  });

  const planned = auditAndBuildSyncPreview({
    extracted,
    schema,
    modifiableColumns,
    primaryKeyColumn,
    liveRows,
    sourceDocuments,
    sourceChunks,
    prompt,
  });

  if (planned.workflow) {
    planned.workflow.business_id = businessId;
  }

  return planned;
}

/**
 * Executes a confirmed `document_table_sync` workflow atomically inside PostgreSQL,
 * strictly targeting ONLY `workflow.target_entity` (the active table) and validating/coercing
 * all inline user edits or on-the-fly missing field completions.
 */
async function executeDocumentTableSyncConfirm({
  workflow,
  businessId,
  editedMutations = null,
  allowPartialNullable = false,
}) {
  const targetTable = workflow?.target_entity;
  if (!targetTable) {
    throw new AppError('Document sync workflow does not specify a target active table.', 400);
  }

  const schema = await discoverTableSchema(targetTable, businessId, {
    useCache: false,
    skipSampleQuery: true,
  });

  const originalPreview = Array.isArray(workflow.mutations_preview)
    ? workflow.mutations_preview
    : [];
  if (originalPreview.length === 0) {
    throw new AppError('This workflow contains no row operations to execute.', 400);
  }

  // Index user-submitted edits safely onto original preview slots only
  const editsByIndex = new Map();
  const editsByIdentifier = new Map();
  if (Array.isArray(editedMutations)) {
    editedMutations.forEach((item, idx) => {
      if (!item || typeof item !== 'object') return;
      if (item.row_index !== undefined && item.row_index !== null) {
        editsByIndex.set(Number(item.row_index), item);
      } else if (item.row_identifier !== undefined && item.row_identifier !== null) {
        editsByIdentifier.set(String(item.row_identifier).trim().toLowerCase(), item);
      } else {
        editsByIndex.set(idx, item);
      }
    });
  }

  const modifiableColList = Object.entries(schema.columns || {})
    .filter(([key, def]) => {
      const exact = String(def?.exactName || key).toLowerCase();
      return !SYSTEM_COLUMN_NAMES.has(exact) && !def?.readonly && !def?.virtual;
    })
    .map(([, def]) => def);

  const opsToApply = [];
  const unresolvedErrors = [];

  for (let i = 0; i < originalPreview.length; i += 1) {
    const orig = originalPreview[i];
    const rowIdx = orig.row_index !== undefined ? Number(orig.row_index) : i;
    const matchedEdit =
      editsByIndex.get(rowIdx) ||
      editsByIdentifier.get(String(orig.row_identifier || '').trim().toLowerCase()) ||
      null;

    const included =
      matchedEdit && matchedEdit.include !== undefined
        ? Boolean(matchedEdit.include)
        : orig.include !== false;
    if (!included) continue;

    const opType = orig.operation || 'create';

    if (opType === 'delete') {
      if (!orig._internal_id && !(orig._identifier_col && orig.row_identifier)) {
        unresolvedErrors.push(
          `Row "${orig.row_identifier}" could not be matched to an existing record in ${schema.tableName} for deletion.`
        );
        continue;
      }
      opsToApply.push({
        operation: 'delete',
        orig,
        row_identifier: orig.row_identifier,
        _internal_id: orig._internal_id || null,
        _identifier_col: orig._identifier_col || null,
      });
      continue;
    }

    const baseAfter = { ...(orig.after || {}) };
    if (matchedEdit?.after && typeof matchedEdit.after === 'object') {
      for (const [k, v] of Object.entries(matchedEdit.after)) {
        const found = findColumnDef(schema, k);
        if (!found) continue;
        const exactCol = found.exactName;
        if (SYSTEM_COLUMN_NAMES.has(exactCol.toLowerCase()) || found.colDef.readonly || found.colDef.virtual) {
          continue;
        }
        baseAfter[exactCol] = v;
      }
    }

    if (opType === 'create') {
      const coercedRow = {};
      const rowMissingRequired = [];
      const rowMissingNullable = [];

      for (const colDef of modifiableColList) {
        const colName = colDef.exactName;
        const rawVal = Object.prototype.hasOwnProperty.call(baseAfter, colName)
          ? baseAfter[colName]
          : null;

        if (isNullishOrBlankValue(rawVal)) {
          if (colDef.required) {
            rowMissingRequired.push(colName);
          } else {
            rowMissingNullable.push(colName);
          }
          continue;
        }

        try {
          coercedRow[colName] = coerceValueForColumn(colDef, colName, rawVal);
        } catch (err) {
          unresolvedErrors.push(`Row "${orig.row_identifier}" -> ${err.message}`);
        }
      }

      if (rowMissingRequired.length > 0) {
        unresolvedErrors.push(
          `Row "${orig.row_identifier}" is missing required field(s): ${rowMissingRequired.join(', ')}.`
        );
      } else if (!allowPartialNullable && rowMissingNullable.length > 0) {
        unresolvedErrors.push(
          `Row "${orig.row_identifier}" still has empty column(s): ${rowMissingNullable.join(', ')}. Enter values on the fly or allow nullable blanks.`
        );
      }

      if (Object.keys(coercedRow).length === 0) {
        unresolvedErrors.push(`Row "${orig.row_identifier}" has no populated column values to insert.`);
      }

      opsToApply.push({
        operation: 'create',
        orig,
        row_identifier: orig.row_identifier,
        valuesMap: coercedRow,
      });
      continue;
    }

    // opType === 'update'
    if (!orig._internal_id && !(orig._identifier_col && orig.row_identifier)) {
      unresolvedErrors.push(
        `Row "${orig.row_identifier}" could not be matched to an existing record in ${schema.tableName} for update.`
      );
      continue;
    }

    const coercedUpdates = {};
    for (const [k, rawVal] of Object.entries(baseAfter)) {
      const found = findColumnDef(schema, k);
      if (!found || SYSTEM_COLUMN_NAMES.has(found.exactName.toLowerCase()) || found.colDef.readonly || found.colDef.virtual) {
        continue;
      }
      const colName = found.exactName;
      if (isNullishOrBlankValue(rawVal)) {
        if (found.colDef.required) {
          unresolvedErrors.push(`Row "${orig.row_identifier}" -> required field "${colName}" cannot be empty.`);
        } else if (!allowPartialNullable && (orig.missing_fields || []).includes(colName)) {
          unresolvedErrors.push(`Row "${orig.row_identifier}" still has empty field "${colName}".`);
        } else if (allowPartialNullable) {
          coercedUpdates[colName] = null;
        }
        continue;
      }
      try {
        coercedUpdates[colName] = coerceValueForColumn(found.colDef, colName, rawVal);
      } catch (err) {
        unresolvedErrors.push(`Row "${orig.row_identifier}" -> ${err.message}`);
      }
    }

    if (Object.keys(coercedUpdates).length === 0) {
      unresolvedErrors.push(`Row "${orig.row_identifier}" has no valid column updates to apply.`);
    }

    opsToApply.push({
      operation: 'update',
      orig,
      row_identifier: orig.row_identifier,
      _internal_id: orig._internal_id || null,
      _identifier_col: orig._identifier_col || null,
      valuesMap: coercedUpdates,
    });
  }

  if (opsToApply.length === 0) {
    throw new AppError(
      'No rows are selected to apply. Include at least one row or stop/cancel the update.',
      400
    );
  }

  if (unresolvedErrors.length > 0) {
    throw new AppError(unresolvedErrors.slice(0, 4).join(' '), 400);
  }

  const safeTable = quoteIdentifier(schema.tableName);
  const bizColExact = schema.columns?.business_id?.exactName || 'business_id';
  const bizSql = quoteIdentifier(bizColExact);
  const whereBizSql = schema.columns?.workspace_id
    ? `(${bizSql} = $1 OR ${quoteIdentifier(schema.columns.workspace_id.exactName)} = $1)`
    : `${bizSql} = $1`;

  let createdCount = 0;
  let updatedCount = 0;
  let deletedCount = 0;
  const googleSyncMutations = [];

  await withTransaction(async (client) => {
    for (const op of opsToApply) {
      if (op.operation === 'create') {
        const cols = [bizSql];
        const placeholders = ['$1'];
        const params = [businessId];

        if (schema.columns?.workspace_id) {
          cols.push(quoteIdentifier(schema.columns.workspace_id.exactName));
          params.push(businessId);
          placeholders.push(`$${params.length}`);
        }

        for (const [colName, colVal] of Object.entries(op.valuesMap)) {
          const match = findColumnDef(schema, colName);
          const exactCol = match ? match.exactName : colName;
          cols.push(quoteIdentifier(exactCol));
          params.push(colVal);
          const pRef = `$${params.length}`;
          const storageType = String(match?.colDef?.storageType || '').toLowerCase();
          const isJsonCol =
            match?.colDef?.type === 'json' ||
            storageType === 'json' ||
            storageType === 'jsonb';
          placeholders.push(isJsonCol ? `${pRef}::jsonb` : pRef);
        }

        if (schema.columns?.created_at) {
          cols.push(quoteIdentifier(schema.columns.created_at.exactName));
          placeholders.push('NOW()');
        }
        if (schema.columns?.updated_at) {
          cols.push(quoteIdentifier(schema.columns.updated_at.exactName));
          placeholders.push('NOW()');
        }

        const insertSql = `
          INSERT INTO ${safeTable} (${cols.join(', ')})
          VALUES (${placeholders.join(', ')})
          RETURNING *;
        `;
        const res = await client.query(insertSql, params);
        createdCount += 1;
        const insertedRow = res?.rows?.[0] || op.valuesMap;
        googleSyncMutations.push({
          operation: 'create',
          _internal_id: insertedRow?.id || null,
          after: insertedRow,
        });
        continue;
      }

      if (op.operation === 'update') {
        const setClauses = [];
        const params = [businessId];

        for (const [colName, colVal] of Object.entries(op.valuesMap)) {
          const match = findColumnDef(schema, colName);
          const exactCol = match ? match.exactName : colName;
          params.push(colVal);
          const pRef = `$${params.length}`;
          const storageType = String(match?.colDef?.storageType || '').toLowerCase();
          const isJsonCol =
            match?.colDef?.type === 'json' ||
            storageType === 'json' ||
            storageType === 'jsonb';
          setClauses.push(`${quoteIdentifier(exactCol)} = ${pRef}${isJsonCol ? '::jsonb' : ''}`);
        }

        if (schema.columns?.updated_at) {
          setClauses.push(`${quoteIdentifier(schema.columns.updated_at.exactName)} = NOW()`);
        }

        let resUpdate = null;
        if (op._internal_id && schema.columns?.id) {
          params.push(op._internal_id);
          const sqlById = `UPDATE ${safeTable} SET ${setClauses.join(', ')} WHERE ${whereBizSql} AND ${quoteIdentifier(schema.columns.id.exactName)} = $${params.length} RETURNING *;`;
          resUpdate = await client.query(sqlById, params);
        } else if (op._identifier_col) {
          const idColDef = findColumnDef(schema, op._identifier_col);
          if (!idColDef) {
            throw new AppError(`Invalid identifier column "${op._identifier_col}".`, 409);
          }
          params.push(String(op.row_identifier));
          const sqlByIdent = `UPDATE ${safeTable} SET ${setClauses.join(', ')} WHERE ${whereBizSql} AND ${quoteIdentifier(idColDef.exactName)}::text = $${params.length} RETURNING *;`;
          resUpdate = await client.query(sqlByIdent, params);
        }

        if (!resUpdate || resUpdate.rowCount === 0) {
          throw new AppError(
            `Target row "${op.row_identifier}" no longer exists in "${schema.tableName}".`,
            409
          );
        }

        updatedCount += resUpdate.rowCount || 1;
        googleSyncMutations.push({
          operation: 'update',
          _internal_id: op._internal_id || resUpdate.rows?.[0]?.id || null,
          _identifier_col: op._identifier_col,
          row_identifier: op.row_identifier,
          after: op.valuesMap,
        });
        continue;
      }

      if (op.operation === 'delete') {
        let resDelete = null;
        if (op._internal_id && schema.columns?.id) {
          const sqlDelId = `DELETE FROM ${safeTable} WHERE ${whereBizSql} AND ${quoteIdentifier(schema.columns.id.exactName)} = $2;`;
          resDelete = await client.query(sqlDelId, [businessId, op._internal_id]);
        } else if (op._identifier_col) {
          const idColDef = findColumnDef(schema, op._identifier_col);
          if (!idColDef) {
            throw new AppError(`Invalid identifier column "${op._identifier_col}".`, 409);
          }
          const sqlDelIdent = `DELETE FROM ${safeTable} WHERE ${whereBizSql} AND ${quoteIdentifier(idColDef.exactName)}::text = $2;`;
          resDelete = await client.query(sqlDelIdent, [businessId, String(op.row_identifier)]);
        }

        if (!resDelete || resDelete.rowCount === 0) {
          throw new AppError(
            `Target row "${op.row_identifier}" no longer exists in "${schema.tableName}".`,
            409
          );
        }
        deletedCount += resDelete.rowCount || 1;
      }
    }

    await refreshWorkspaceTableMetadata({
      client,
      workspaceId: businessId,
      tableName: schema.tableName,
    });
  });

  invalidateWorkspaceMetadataCache(businessId);

  if (schema.columns?._google_row_index && googleSyncMutations.length > 0) {
    try {
      const { syncMutationsToGoogleSheet } = require('./googleSheetsSyncService');
      await syncMutationsToGoogleSheet(businessId, schema.tableName, googleSyncMutations);
    } catch (gSyncErr) {
      console.warn('[DocumentTableSync] Google Sheets sync error:', gSyncErr.message);
    }
  }

  return {
    target_entity: schema.tableName,
    created_rows_count: createdCount,
    updated_rows_count: updatedCount,
    deleted_rows_count: deletedCount,
    affected_rows_count: createdCount + updatedCount + deletedCount,
  };
}

module.exports = {
  resolveSourceDocumentsForSync,
  buildActiveTableSyncContext,
  extractDocumentTableOperations,
  auditAndBuildSyncPreview,
  planDocumentTableSync,
  executeDocumentTableSyncConfirm,
};
