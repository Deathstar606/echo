const { query } = require('../../db');
const {
  extractQueryKeywords,
  scoreContextEntry,
  scoreSheetRow,
  getCandidateSheetSchemas,
  selectRelevantBusinessSheets,
  detectConversationalIntent,
} = require('./contextRetrievalService');
const {
  buildTextVector,
  tokenizeDocumentText,
  getChunksForBusiness,
} = require('./documentIngestionService');
const { normalizeProductRow } = require('./sheetQueryService');
const {
  discoverTableSchema,
  quoteIdentifier,
} = require('./sheetSchemaService');
const {
  listWorkspaceTableMetadata,
} = require('./workspaceTableMetadataService');

const SYSTEM_TABLES = new Set([
  'businesses',
  'workspaces',
  'users',
  'context_entries',
  'customers',
  'conversations',
  'messages',
  'announcements',
  'announcement_deliveries',
  'announcement_recipients',
  'schema_migrations',
  'sheet_pending_modifications',
  'workspace_table_metadata',
  'workspace_documents',
  'workspace_document_chunks',
  'socratic_workflows',
  'google_auth_tokens',
  'google_sheet_sync_metadata',
]);

/**
 * Computes cosine similarity between two sparse normalized vectors.
 *
 * @param {Record<string, number>} vecA
 * @param {Record<string, number>} vecB
 * @returns {number}
 */
function cosineSimilarity(vecA, vecB) {
  if (!vecA || !vecB) return 0;
  let dot = 0;
  const keysA = Object.keys(vecA);
  for (const k of keysA) {
    if (vecB[k] !== undefined) {
      dot += vecA[k] * vecB[k];
    }
  }
  return dot;
}

/**
 * Computes BM25 score for a document chunk against query tokens given corpus IDF statistics.
 *
 * @param {string[]} queryTokens
 * @param {string[]} chunkTokens
 * @param {Map<string, number>} docFreqMap
 * @param {number} totalChunks
 * @param {number} avgChunkLen
 * @returns {number}
 */
function computeBm25Score(
  queryTokens,
  chunkTokens,
  docFreqMap,
  totalChunks,
  avgChunkLen
) {
  if (!queryTokens.length || !chunkTokens.length || totalChunks === 0) return 0;
  const k1 = 1.5;
  const b = 0.75;
  const tfMap = new Map();
  for (const t of chunkTokens) {
    tfMap.set(t, (tfMap.get(t) || 0) + 1);
  }

  let score = 0;
  const dl = chunkTokens.length;
  for (const qt of queryTokens) {
    const tf = tfMap.get(qt) || 0;
    if (tf === 0) continue;
    const df = docFreqMap.get(qt) || 1;
    const idf = Math.log(1 + (totalChunks - df + 0.5) / (df + 0.5));
    const denom = tf + k1 * (1 - b + b * (dl / Math.max(1, avgChunkLen)));
    score += idf * ((tf * (k1 + 1)) / denom);
  }
  return score;
}

/**
 * Formats a document chunk into the standardized Cross-Source Citation object.
 *
 * @param {object} chunk
 * @returns {{ source_type: 'document', source_name: string, locator: string, excerpt: string }}
 */
function buildDocumentCitation(chunk) {
  const pageNum = chunk.page_number || 1;
  const chunkIdx =
    chunk.chunk_index !== undefined ? `, Chunk ${chunk.chunk_index + 1}` : '';
  const excerpt = String(chunk.raw_text || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 320);

  return {
    source_type: 'document',
    source_name: chunk.filename || 'document',
    locator: chunk.locator || `Page ${pageNum}${chunkIdx}`,
    breadcrumb_header: chunk.breadcrumb_header || null,
    excerpt,
  };
}

/**
 * Resolves both the primary human-readable row locator AND its source column name
 * for any arbitrary database table row.
 *
 * @param {object} row
 * @param {number} [fallbackIdx=1]
 * @returns {{ identifier: string, column: string | null }}
 */
function resolveRowIdentifierInfo(row, fallbackIdx = 1) {
  if (!row || typeof row !== 'object') {
    return { identifier: `Row ${fallbackIdx}`, column: null };
  }

  // 1. Primary record ID / reference number columns (excluding batch_id / sku which may repeat across rows)
  const ignoredSystemCols = new Set([
    'id',
    'business_id',
    'workspace_id',
    'user_id',
    'workspace_document_id',
    '_google_row_index',
    'created_at',
    'updated_at',
  ]);
  for (const [k, v] of Object.entries(row)) {
    const lower = k.toLowerCase();
    if (
      !ignoredSystemCols.has(lower) &&
      !lower.includes('batch') &&
      /(?:^|_)(?:order_id|account_id|backorder_id|customer_id|invoice_id|ticket_id|shipment_id|record_id|row_id|id|ref|reference|number|no)(?:$|_)/i.test(
        lower
      ) &&
      v !== null &&
      v !== undefined &&
      String(v).trim() !== ''
    ) {
      return { identifier: String(v).trim(), column: k };
    }
  }

  // 2. SKU / product code columns
  for (const [k, v] of Object.entries(row)) {
    const lower = k.toLowerCase();
    if (
      !lower.includes('batch') &&
      /(?:^|_)(?:sku|code|item_sku|sku_code|product_code)(?:$|_)/i.test(lower) &&
      v !== null &&
      v !== undefined &&
      String(v).trim() !== ''
    ) {
      return { identifier: String(v).trim(), column: k };
    }
  }

  // 3. Human-readable name / title columns (e.g., products.name)
  for (const [k, v] of Object.entries(row)) {
    const lower = k.toLowerCase();
    if (
      /name|title|model|item/i.test(lower) &&
      v !== null &&
      v !== undefined &&
      String(v).trim() !== ''
    ) {
      return { identifier: String(v).trim(), column: k };
    }
  }

  if (row.id) {
    return { identifier: String(row.id), column: 'id' };
  }
  return { identifier: `Row ${fallbackIdx}`, column: null };
}

/**
 * Resolves the primary human-readable row locator for any arbitrary database table row.
 *
 * @param {object} row
 * @param {number} [fallbackIdx=1]
 * @returns {string}
 */
function resolveRowIdentifier(row, fallbackIdx = 1) {
  return resolveRowIdentifierInfo(row, fallbackIdx).identifier;
}

/**
 * Formats a database table row into the standardized Cross-Source Citation object.
 *
 * @param {string} tableName
 * @param {object} row
 * @param {number} [idx=1]
 * @returns {{ source_type: 'table', source_name: string, locator: string, excerpt: string }}
 */
function buildTableRowCitation(tableName, row, idx = 1) {
  const rowId = resolveRowIdentifier(row, idx);
  const kvPairs = Object.entries(row || {})
    .filter(
      ([k, v]) =>
        ![
          'id',
          'business_id',
          'workspace_id',
          'user_id',
          'workspace_document_id',
          '_google_row_index',
          'created_at',
          'updated_at',
        ].includes(k.toLowerCase()) &&
        !/(?:email|e_mail|phone|mobile|address)/i.test(k) &&
        v !== null &&
        v !== undefined &&
        String(v).trim() !== ''
    )
    .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`);

  return {
    source_type: 'table',
    source_name: tableName,
    locator: `Row ${rowId}`,
    excerpt: kvPairs.join(', ').slice(0, 320),
  };
}

/**
 * Retrieves and ranks unstructured document chunks using Hybrid Scoring:
 * Lexical/Synonym/Stemmer score + BM25 score + Dense/N-Gram Vector Cosine Similarity.
 *
 * @param {string} businessId
 * @param {string} queryText
 * @param {{ topK?: number, includeAllIfOperational?: boolean }} [options]
 * @returns {Promise<Array<object>>}
 */
async function retrieveHybridDocumentChunks(
  businessId,
  queryText,
  options = {}
) {
  const topK = options.topK || 8;
  const chunks = await getChunksForBusiness(businessId);
  if (!chunks || chunks.length === 0) return [];

  const queryKeywords = extractQueryKeywords(queryText);
  const queryTokens = tokenizeDocumentText(queryText);
  const queryVector = buildTextVector(queryText);

  // Compute corpus document frequencies for BM25
  const docFreqMap = new Map();
  let totalTokens = 0;
  for (const chunk of chunks) {
    const cTokens = chunk.tokens || tokenizeDocumentText(chunk.raw_text);
    totalTokens += cTokens.length;
    const unique = new Set(cTokens);
    for (const t of unique) {
      docFreqMap.set(t, (docFreqMap.get(t) || 0) + 1);
    }
  }
  const avgChunkLen = chunks.length > 0 ? totalTokens / chunks.length : 1;

  const scored = [];
  for (const chunk of chunks) {
    const retrievalText =
      chunk.enriched_text || `${chunk.breadcrumb_header || ''}\n${chunk.raw_text || ''}`;
    const lexicalScore = scoreContextEntry(
      {
        category: chunk.filename,
        title: chunk.section_title || chunk.filename,
        content: retrievalText,
      },
      queryKeywords
    );

    const cTokens = chunk.tokens || tokenizeDocumentText(retrievalText);
    const cVec = chunk.tf_vector || buildTextVector(retrievalText);
    const bm25Score = computeBm25Score(
      queryTokens,
      cTokens,
      docFreqMap,
      chunks.length,
      avgChunkLen
    );
    const vectorSim = cosineSimilarity(queryVector, cVec);

    // Hybrid combination: lexical/synonym + BM25 + dense vector similarity
    const entityText = Array.isArray(chunk.extracted_entities)
      ? chunk.extracted_entities.join(' ').toLowerCase()
      : '';
    const entityScore = entityText
      ? queryTokens.reduce((score, token) => score + (entityText.includes(token) ? 2 : 0), 0)
      : 0;
    const hybridScore = Number(
      (lexicalScore * 1.2 + bm25Score * 1.5 + vectorSim * 10 + entityScore).toFixed(4)
    );

    if (hybridScore > 0 || options.includeAllIfOperational) {
      scored.push({
        ...chunk,
        lexical_score: lexicalScore,
        bm25_score: Number(bm25Score.toFixed(4)),
        vector_similarity: Number(vectorSim.toFixed(4)),
        hybrid_score: hybridScore,
        citation: buildDocumentCitation(chunk),
      });
    }
  }

  scored.sort((a, b) => {
    if (b.hybrid_score !== a.hybrid_score) {
      return b.hybrid_score - a.hybrid_score;
    }
    return a.chunk_index - b.chunk_index;
  });

  return scored.slice(0, topK);
}

/**
 * Loads all rows from a business's active table schema safely.
 *
 * @param {string} businessId
 * @param {object} schema
 * @param {{ metadata?: object, queryText?: string, limit?: number }} [options]
 * @returns {Promise<Array<object>>}
 */
async function loadTableRowsForSchema(businessId, schema, options = {}) {
  if (!schema) return [];
  const safeTableName = String(schema.tableName || schema.entity);
  const profile = Array.isArray(options.metadata?.columns_profile)
    ? options.metadata.columns_profile
    : [];
  const searchableColumns = profile
    .filter((column) => !['email'].includes(column.semantic_role))
    .map((column) => column.column_name)
    .filter((name) => typeof name === 'string');
  const identifierTokens = [
    ...(String(options.queryText || '').match(/\b[A-Z0-9]+(?:[-_][A-Z0-9]+)+\b/gi) || []),
    ...(Array.isArray(options.identifierValues) ? options.identifierValues : []),
  ]
    .map((value) => String(value || '').trim())
    .filter((value) => /^[A-Z0-9]+(?:[-_][A-Z0-9]+)+$/i.test(value))
    .filter((value, index, values) => values.findIndex((candidate) => candidate.toLowerCase() === value.toLowerCase()) === index)
    .slice(0, 20);
  const values = [businessId];
  const predicates = [];
  const customerEmail = String(options.customerEmail || '').trim();
  if (customerEmail) {
    const emailColumns = profile
      .filter((column) => column.semantic_role === 'email')
      .map((column) => column.column_name)
      .filter((name) => typeof name === 'string');
    for (const column of emailColumns) {
      values.push(customerEmail);
      predicates.push(
        `${quoteIdentifier(column)}::text ILIKE $${values.length}`
      );
    }
  }
  const identifierColumns = profile
    .filter((column) => column.semantic_role === 'identifier')
    .map((column) => column.column_name);
  const codeColumns = identifierColumns.length > 0 ? identifierColumns : searchableColumns;
  if (identifierTokens.length > 0 && !customerEmail && codeColumns.length > 0) {
    for (const token of identifierTokens.slice(0, 8)) {
      const parameter = `$${values.length + 1}`;
      values.push(token);
      predicates.push(
        `(${codeColumns.map((column) => `${quoteIdentifier(column)}::text ILIKE ${parameter}`).join(' OR ')})`
      );
    }
  } else if (!customerEmail && searchableColumns.length > 0) {
    const userTerms = extractQueryKeywords(options.queryText || '')
      .map((keyword) => keyword.raw)
      .filter((keyword) => keyword.length >= 3)
      .slice(0, 4);
    const documentTerms = extractQueryKeywords(options.documentText || '')
      .map((keyword) => keyword.raw)
      .filter((keyword) => keyword.length >= 3)
      .slice(0, 20);
    const terms = [...new Set([...userTerms, ...documentTerms])].slice(0, 8);
    for (const term of terms) {
      const parameter = `$${values.length + 1}`;
      values.push(`%${term}%`);
      predicates.push(
        `(${searchableColumns.map((column) => `${quoteIdentifier(column)}::text ILIKE ${parameter}`).join(' OR ')})`
      );
    }
  }
  const rowFilter = predicates.length > 0
    ? ` AND (${predicates.join(' OR ')})`
    : '';
  const maximumRows = Math.max(1, Math.min(250, Number(options.limit) || 200));
  try {
    const schemaColumns = Object.values(schema.columns || {});
    const businessColumn = schemaColumns.find(
      (column) => String(column.exactName || '').toLowerCase() === 'business_id'
    );
    const workspaceColumn = schemaColumns.find(
      (column) => String(column.exactName || '').toLowerCase() === 'workspace_id'
    );
    const whereBizSql =
      businessColumn && workspaceColumn
        ? `(${quoteIdentifier(businessColumn.exactName)} = $1 OR ${quoteIdentifier(workspaceColumn.exactName)} = $1)`
        : workspaceColumn
          ? `${quoteIdentifier(workspaceColumn.exactName)} = $1`
          : `${quoteIdentifier(businessColumn?.exactName || 'business_id')} = $1`;
    const res = await query(
      `SELECT * FROM ${quoteIdentifier(safeTableName)} WHERE ${whereBizSql}${rowFilter} LIMIT ${maximumRows};`,
      values
    );
    if (res && Array.isArray(res.rows) && res.rows.length > 0) {
      return res.rows.map((r) => normalizeProductRow(r, schema));
    }
    if (identifierTokens.length > 0) {
      const fallback = await query(
        `SELECT * FROM ${quoteIdentifier(safeTableName)} WHERE ${whereBizSql} LIMIT ${maximumRows};`,
        [businessId]
      );
      if (Array.isArray(fallback.rows)) {
        return fallback.rows.map((row) => normalizeProductRow(row, schema));
      }
    }
  } catch {
    // Fallback to empty if table doesn't exist yet
  }
  return [];
}

/**
 * Performs cross-document hybrid RAG across unstructured documents and structured tables.
 * Includes graceful conversational fallback for 1-word greetings or generic conversational prompts.
 *
 * @param {object} params
 * @param {string} params.businessId
 * @param {string} params.queryText
 * @param {number} [params.topK=8]
 * @returns {Promise<object>}
 */
async function retrieveCrossDocumentContext({
  businessId,
  queryText,
  topK = 8,
  customerContext = {},
}) {
  const convCheck = detectConversationalIntent(queryText);
  if (convCheck.isConversational) {
    return {
      status: 'conversational',
      conversational_intent: true,
      intent: convCheck.intent,
      message: convCheck.suggestedReply,
      document_chunks: [],
      table_rows: [],
      citations: [],
    };
  }

  const queryKeywords = extractQueryKeywords(queryText);
  const queryVector = buildTextVector(queryText);

  // 1. Retrieve hybrid-scored unstructured document chunks
  const documentChunks = await retrieveHybridDocumentChunks(
    businessId,
    queryText,
    {
      topK,
      includeAllIfOperational: true,
    }
  );
  const documentIdentifiers = [
    ...new Set(
      documentChunks
        .flatMap((chunk) => Array.isArray(chunk.extracted_entities) ? chunk.extracted_entities : [])
        .map((value) => String(value || '').trim())
        .filter((value) => /^[A-Z0-9]+(?:[-_][A-Z0-9]+)+$/i.test(value))
    ),
  ].slice(0, 20);

  // 2. Discover candidate schemas & score structured table rows
  const tableMetadata = await listWorkspaceTableMetadata(businessId);
  const metadataByTable = new Map(
    tableMetadata.map((metadata) => [String(metadata.table_name).toLowerCase(), metadata])
  );
  const candidateSchemas = [];
  for (const metadata of tableMetadata) {
    const schema = await discoverTableSchema(metadata.table_name, businessId);
    if (!schema) continue;
    const representatives = {};
    for (const column of metadata.columns_profile || []) {
      if (column.semantic_role === 'email') continue;
      const values = Array.isArray(column.categorical_values)
        ? column.categorical_values
        : [];
      if (values.length > 0) representatives[column.column_name] = values.slice(0, 25);
    }
    schema.representativeValues = {
      ...(schema.representativeValues || {}),
      ...representatives,
    };
    candidateSchemas.push(schema);
  }
  const profiledTables = new Set(
    tableMetadata.map((metadata) => String(metadata.table_name).toLowerCase())
  );
  const tableNames = await query(
    `SELECT table_name
     FROM information_schema.columns
     WHERE table_schema = 'public'
       AND LOWER(column_name) IN ('business_id', 'workspace_id')
     GROUP BY table_name
     ORDER BY table_name;`
  );
  for (const row of tableNames.rows || []) {
    const tableName = String(row.table_name || '');
    if (
      !tableName ||
      SYSTEM_TABLES.has(tableName.toLowerCase()) ||
      profiledTables.has(tableName.toLowerCase())
    ) {
      continue;
    }
    const schema = await discoverTableSchema(tableName, businessId);
    if (schema) candidateSchemas.push(schema);
  }
  if (candidateSchemas.length === 0) {
    candidateSchemas.push(...getCandidateSheetSchemas());
  }
  let selectedSheets = selectRelevantBusinessSheets(
    candidateSchemas,
    queryKeywords
  );
  if (selectedSheets.length === 0 && candidateSchemas.length > 0) {
    selectedSheets = candidateSchemas.map((schema) => ({
      schema,
      sheetScore: 1,
    }));
  }

  const matchedTableRows = [];
  const documentText = documentChunks
    .map((chunk) => `${chunk.breadcrumb_header || ''}\n${chunk.raw_text || ''}`)
    .join('\n')
    .slice(0, 12000);
  const documentKeywords = extractQueryKeywords(documentText).slice(0, 40);
  const rowScoringKeywords = [
    ...queryKeywords,
    ...documentKeywords.filter(
      (documentKeyword) =>
        !queryKeywords.some((queryKeyword) => queryKeyword.raw === documentKeyword.raw)
    ),
  ];
  for (const { schema, sheetScore } of selectedSheets) {
    const metadata = metadataByTable.get(
      String(schema.tableName || schema.entity).toLowerCase()
    );
    const rows = await loadTableRowsForSchema(businessId, schema, {
      metadata,
      queryText,
      documentText,
      identifierValues: documentIdentifiers,
      customerEmail: customerContext.customer_email,
    });
    rows.forEach((row, idx) => {
      const lexScore = scoreSheetRow(row, schema, rowScoringKeywords, sheetScore);
      const rowText = Object.entries(row)
        .filter(
          ([k]) =>
            ![
              'id',
              'business_id',
              'workspace_id',
              'user_id',
              'workspace_document_id',
              '_google_row_index',
              'created_at',
              'updated_at',
            ].includes(k.toLowerCase())
        )
        .map(([k, v]) => `${k} ${v}`)
        .join(' ');
      const vecSim = cosineSimilarity(queryVector, buildTextVector(rowText));
      const hybridScore = Number((lexScore + vecSim * 8).toFixed(4));
      if (hybridScore > 0) {
        matchedTableRows.push({
          table_name: schema.tableName || schema.entity,
          entity: schema.entity,
          schema,
          row,
          row_identifier: resolveRowIdentifier(row, idx + 1),
          hybrid_score: hybridScore,
          citation: buildTableRowCitation(
            schema.tableName || schema.entity,
            row,
            idx + 1
          ),
        });
      }
    });
  }

  matchedTableRows.sort((a, b) => b.hybrid_score - a.hybrid_score);
  const topTableRows = matchedTableRows.slice(0, topK);

  const citations = [
    ...documentChunks.map((c) => c.citation),
    ...topTableRows.map((r) => r.citation),
  ];

  return {
    status: 'ok',
    conversational_intent: false,
    document_chunks: documentChunks,
    table_rows: topTableRows,
    citations,
  };
}

module.exports = {
  cosineSimilarity,
  computeBm25Score,
  buildDocumentCitation,
  resolveRowIdentifierInfo,
  resolveRowIdentifier,
  buildTableRowCitation,
  retrieveHybridDocumentChunks,
  loadTableRowsForSchema,
  retrieveCrossDocumentContext,
};
