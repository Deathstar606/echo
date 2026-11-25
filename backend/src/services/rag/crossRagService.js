const { query } = require('../../../db');
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
  getChunkVectorColumnType,
} = require('./documentIngestionService');
const {
  embedQuery,
  isLivePostgresPool,
} = require('./embeddingService');
const { normalizeProductRow } = require('../sheets/sheetQueryService');
const {
  discoverTableSchema,
  quoteIdentifier,
} = require('../sheets/sheetSchemaService');
const {
  listWorkspaceTableMetadataCached,
} = require('../sheets/workspaceTableMetadataService');

const BM25_CORPUS_CACHE = new WeakMap();

const SEARCH_CONVERSATIONAL_STOP = new Set([
  'checking', 'compare', 'against', 'between', 'regarding', 'currently',
  'available', 'looking', 'something', 'wanted', 'received', 'please',
  'hello', 'support', 'would', 'could', 'should', 'thank', 'thanks',
  'another', 'everything', 'because', 'within', 'without', 'provide',
]);

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
  'workspace_turn_memory',
  'socratic_workflows',
  'google_auth_tokens',
  'google_sheet_sync_metadata',
  'workspace_contacts',
  'sheet_active_metadata',
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
function resolveRowIdentifierInfo(row, fallbackIdx = 1, schema = null) {
  if (!row || typeof row !== 'object') {
    return { identifier: `Row ${fallbackIdx}`, column: null };
  }
  const systemCols = new Set([
    'business_id',
    'workspace_id',
    'user_id',
    'workspace_document_id',
    'created_at',
    'updated_at',
  ]);
  const explicitPk =
    schema && typeof schema.primaryKey === 'string' && schema.primaryKey.trim()
      ? schema.primaryKey.trim()
      : null;
  if (explicitPk && explicitPk.toLowerCase() !== 'id' && !systemCols.has(explicitPk.toLowerCase())) {
    const matchedPkCol = Object.keys(row).find(
      (k) => k.toLowerCase() === explicitPk.toLowerCase()
    );
    if (
      matchedPkCol &&
      row[matchedPkCol] !== null &&
      row[matchedPkCol] !== undefined &&
      String(row[matchedPkCol]).trim() !== ''
    ) {
      return { identifier: String(row[matchedPkCol]).trim(), column: matchedPkCol };
    }
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
    const isGenericBatchGrouping =
      lower === 'batch' ||
      lower === 'batch_id' ||
      lower === 'batch_code' ||
      lower === 'batch_no' ||
      lower === 'batch_number';
    if (
      !ignoredSystemCols.has(lower) &&
      !isGenericBatchGrouping &&
      /(?:^|_)(?:batch_record_id|order_id|account_id|backorder_id|customer_id|invoice_id|ticket_id|shipment_id|unit_id|nurse_id|po_id|record_id|row_id|id|ref|reference|number|no)(?:$|_)/i.test(
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
function resolveRowIdentifier(row, fallbackIdx = 1, schema = null) {
  return resolveRowIdentifierInfo(row, fallbackIdx, schema).identifier;
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
    excerpt: kvPairs.join(', ').slice(0, 600),
  };
}

function buildLexicalBoosterTokens(queryText, expandedQueries = []) {
  const combined = [queryText, ...(Array.isArray(expandedQueries) ? expandedQueries : [])]
    .filter((s) => typeof s === 'string' && s.trim())
    .join(' ');
  const kws = extractQueryKeywords(combined);
  const terms = new Set();
  for (const kw of kws) {
    if (/^[a-z0-9]{2,}$/i.test(kw.raw)) {
      terms.add(kw.raw.toLowerCase());
    }
    if (Array.isArray(kw.synonyms)) {
      for (const syn of kw.synonyms.slice(0, 2)) {
        if (/^[a-z0-9]{2,}$/i.test(syn)) {
          terms.add(syn.toLowerCase());
        }
      }
    }
  }
  const codeMatches = String(combined || '').match(/\b[A-Za-z0-9]+(?:[-_][A-Za-z0-9]+)+\b/g) || [];
  const codePatterns = [...new Set(codeMatches.map((c) => `%${c}%`))].slice(0, 10);
  const orTsQuery = terms.size > 0 ? Array.from(terms).slice(0, 20).join(' | ') : null;
  return { orTsQuery, codePatterns };
}

/**
 * In-memory legacy lexical + BM25 + TF-vector fallback ranker used when running
 * against unit-test mock pools or when no PostgreSQL RRF rows match.
 */
async function retrieveLegacyInMemoryDocumentChunks(
  businessId,
  queryText,
  options = {}
) {
  const topK = options.topK || 8;
  const docTypesFilter =
    Array.isArray(options.docTypes) && options.docTypes.length > 0
      ? new Set(options.docTypes.map((d) => String(d).toLowerCase()))
      : null;
  const allChunks = await getChunksForBusiness(businessId);
  const chunks = (allChunks || []).filter(
    (c) =>
      c.is_active !== false &&
      (!docTypesFilter || docTypesFilter.has(String(c.doc_type || 'general').toLowerCase()))
  );
  if (chunks.length === 0) return [];

  const queryKeywords = extractQueryKeywords(queryText);
  const queryTokens = tokenizeDocumentText(queryText);
  const queryVector = buildTextVector(queryText);

  let corpusStats = BM25_CORPUS_CACHE.get(chunks);
  if (!corpusStats) {
    const docFreqMap = new Map();
    let totalTokens = 0;
    const chunkEntries = [];
    for (const chunk of chunks) {
      const retrievalText =
        chunk.enriched_text || `${chunk.breadcrumb_header || ''}\n${chunk.raw_text || ''}`;
      const cTokens = chunk.tokens || tokenizeDocumentText(retrievalText);
      const cVec = chunk.tf_vector || buildTextVector(retrievalText);
      totalTokens += cTokens.length;
      const unique = new Set(cTokens);
      for (const t of unique) {
        docFreqMap.set(t, (docFreqMap.get(t) || 0) + 1);
      }
      chunkEntries.push({ retrievalText, cTokens, cVec });
    }
    corpusStats = {
      docFreqMap,
      avgChunkLen: chunks.length > 0 ? totalTokens / chunks.length : 1,
      chunkEntries,
    };
    BM25_CORPUS_CACHE.set(chunks, corpusStats);
  }
  const { docFreqMap, avgChunkLen, chunkEntries } = corpusStats;

  const scored = [];
  for (let i = 0; i < chunks.length; i += 1) {
    const chunk = chunks[i];
    const { retrievalText, cTokens, cVec } = chunkEntries[i];
    const lexicalScore = scoreContextEntry(
      {
        category: chunk.filename,
        title: chunk.section_title || chunk.filename,
        content: retrievalText,
      },
      queryKeywords
    );
    const bm25Score = computeBm25Score(
      queryTokens,
      cTokens,
      docFreqMap,
      chunks.length,
      avgChunkLen
    );
    const vectorSim = cosineSimilarity(queryVector, cVec);

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
        rrf_score: Number((hybridScore > 0 ? 1 / 61 : 0).toFixed(6)),
        vec_rank: null,
        lex_rank: i + 1,
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

  if (scored.length <= topK) {
    return scored;
  }

  const selected = [];
  const selectedIds = new Set();
  const seenBuckets = new Set();
  const topScore = scored[0]?.hybrid_score || 0;
  const minDiverseScore = topScore > 0 ? topScore * 0.2 : -Infinity;
  const diversityPool = scored.slice(0, Math.max(topK * 3, 24));

  for (const chunk of diversityPool) {
    if (selected.length >= topK) break;
    if ((chunk.hybrid_score || 0) < minDiverseScore) continue;
    const bucket = `${chunk.filename || 'doc'}::${chunk.page_number || 1}`;
    if (!seenBuckets.has(bucket)) {
      seenBuckets.add(bucket);
      selected.push(chunk);
      selectedIds.add(chunk.chunk_id ?? chunk.id ?? `${bucket}::${chunk.chunk_index}`);
    }
  }

  for (const chunk of scored) {
    if (selected.length >= topK) break;
    const key = chunk.chunk_id ?? chunk.id ?? `${chunk.filename || 'doc'}::${chunk.page_number || 1}::${chunk.chunk_index}`;
    if (!selectedIds.has(key)) {
      selectedIds.add(key);
      selected.push(chunk);
    }
  }

  return selected;
}

/**
 * Single-pass PostgreSQL Hybrid Reciprocal Rank Fusion (RRF) search combining:
 * - Hard workspace_id + is_active=true (+ optional doc_type) pre-filter
 * - Branch A: Semantic pgvector cosine similarity (halfvec(768) / vector(768), Top-20)
 * - Branch B: PostgreSQL tsvector ts_rank_cd + pg_trgm word_similarity + exact code match (Top-20)
 * - RRF(k=60): 1/(60 + vec_rank) + 1/(60 + lex_rank)
 *
 * Gracefully degrades to Branch B-only if embeddings are unreachable, and to in-memory
 * legacy scoring when running against unit-test mock pools.
 *
 * @param {{
 *   workspaceId: string,
 *   query: string,
 *   expandedQueries?: string[],
 *   docTypes?: string[] | null,
 *   topK?: number
 * }} params
 */
async function hybridSearchDocumentChunks({
  workspaceId,
  query: rawQuery,
  expandedQueries = [],
  docTypes = null,
  topK = 6,
}) {
  const cleanWs = String(workspaceId || '').trim();
  const cleanQuery = String(rawQuery || '').trim();
  const safeTopK = Math.max(1, Math.min(30, Number(topK) || 6));
  const cleanDocTypes =
    Array.isArray(docTypes) && docTypes.length > 0
      ? docTypes.map((d) => String(d).trim().toLowerCase()).filter(Boolean)
      : null;

  if (!cleanWs || !cleanQuery) return [];

  if (!isLivePostgresPool()) {
    return retrieveLegacyInMemoryDocumentChunks(
      cleanWs,
      [cleanQuery, ...(expandedQueries || [])].join(' '),
      { topK: safeTopK, docTypes: cleanDocTypes }
    );
  }

  try {
    const vecType = await getChunkVectorColumnType();
    if (!vecType) {
      return retrieveLegacyInMemoryDocumentChunks(cleanWs, cleanQuery, {
        topK: safeTopK,
        docTypes: cleanDocTypes,
      });
    }

    const vecCast = vecType === 'halfvec' ? '::halfvec(768)' : '::vector(768)';
    const { orTsQuery, codePatterns } = buildLexicalBoosterTokens(cleanQuery, expandedQueries);
    const queryEmb = await embedQuery(cleanQuery);
    const queryVecLiteral = queryEmb?.ok && queryEmb.literal ? queryEmb.literal : null;

    if (queryVecLiteral) {
      const sql = `
        WITH vec_candidates AS (
          SELECT chunk_id,
                 ROW_NUMBER() OVER (ORDER BY embedding <=> $3${vecCast} ASC, chunk_index ASC)::int AS vec_rank,
                 (1.0 - (embedding <=> $3${vecCast}))::float8 AS vec_similarity
          FROM workspace_document_chunks
          WHERE workspace_id = $1
            AND is_active = true
            AND ($2::text[] IS NULL OR doc_type = ANY($2::text[]))
            AND embedding IS NOT NULL
          ORDER BY embedding <=> $3${vecCast} ASC, chunk_index ASC
          LIMIT 20
        ),
        lex_candidates AS (
          SELECT chunk_id,
                 ROW_NUMBER() OVER (ORDER BY lex_raw_score DESC, chunk_index ASC)::int AS lex_rank,
                 lex_raw_score
          FROM (
            SELECT chunk_id,
                   chunk_index,
                   (
                     COALESCE(ts_rank_cd(COALESCE(search_tsv, to_tsvector('english', COALESCE(enriched_text, raw_text))), websearch_to_tsquery('english', $4)), 0) * 2.5
                     + CASE WHEN $5::text IS NOT NULL THEN COALESCE(ts_rank_cd(COALESCE(search_tsv, to_tsvector('english', COALESCE(enriched_text, raw_text))), to_tsquery('english', $5)), 0) * 1.4 ELSE 0 END
                     + COALESCE(word_similarity($4, COALESCE(enriched_text, raw_text)), 0) * 1.6
                     + CASE WHEN COALESCE(array_length($6::text[], 1), 0) > 0 AND COALESCE(enriched_text, raw_text) ILIKE ANY($6::text[]) THEN 0.75 ELSE 0 END
                   )::float8 AS lex_raw_score
            FROM workspace_document_chunks
            WHERE workspace_id = $1
              AND is_active = true
              AND ($2::text[] IS NULL OR doc_type = ANY($2::text[]))
          ) sub
          WHERE lex_raw_score > 0.02
          ORDER BY lex_raw_score DESC, chunk_index ASC
          LIMIT 20
        ),
        fused AS (
          SELECT COALESCE(v.chunk_id, l.chunk_id) AS chunk_id,
                 v.vec_rank,
                 l.lex_rank,
                 v.vec_similarity,
                 l.lex_raw_score,
                 (COALESCE(1.0 / (60.0 + v.vec_rank), 0.0) + COALESCE(1.0 / (60.0 + l.lex_rank), 0.0))::float8 AS rrf_score
          FROM vec_candidates v
          FULL OUTER JOIN lex_candidates l ON v.chunk_id = l.chunk_id
        )
        SELECT c.chunk_id, c.doc_id, COALESCE(c.workspace_document_id, c.doc_id) AS workspace_document_id,
               c.workspace_id, c.workspace_id AS business_id, c.filename, c.page_number, c.chunk_index,
               c.section_title, c.locator, c.breadcrumb_header, c.raw_text, c.enriched_text,
               c.extracted_entities, c.doc_type, c.is_active, c.token_count, c.overlap_chars,
               f.vec_rank, f.lex_rank, f.vec_similarity, f.lex_raw_score, f.rrf_score
        FROM fused f
        JOIN workspace_document_chunks c ON c.chunk_id = f.chunk_id
        ORDER BY f.rrf_score DESC, COALESCE(f.vec_rank, 999) ASC, COALESCE(f.lex_rank, 999) ASC
        LIMIT $7;
      `;
      const res = await query(sql, [
        cleanWs,
        cleanDocTypes,
        queryVecLiteral,
        cleanQuery,
        orTsQuery,
        codePatterns,
        safeTopK,
      ]);
      if (Array.isArray(res?.rows)) {
        return res.rows.map((r) => ({
          ...r,
          rrf_score: Number(Number(r.rrf_score || 0).toFixed(6)),
          vec_rank: r.vec_rank !== null ? Number(r.vec_rank) : null,
          lex_rank: r.lex_rank !== null ? Number(r.lex_rank) : null,
          vector_similarity: r.vec_similarity !== null ? Number(Number(r.vec_similarity).toFixed(4)) : 0,
          hybrid_score: Number((Number(r.rrf_score || 0) * 100).toFixed(4)),
          citation: buildDocumentCitation(r),
        }));
      }
    } else {
      // Graceful Branch B-only SQL degradation when embedding API is unreachable
      const lexOnlySql = `
        WITH lex_candidates AS (
          SELECT chunk_id,
                 ROW_NUMBER() OVER (ORDER BY lex_raw_score DESC, chunk_index ASC)::int AS lex_rank,
                 lex_raw_score
          FROM (
            SELECT chunk_id,
                   chunk_index,
                   (
                     COALESCE(ts_rank_cd(COALESCE(search_tsv, to_tsvector('english', COALESCE(enriched_text, raw_text))), websearch_to_tsquery('english', $3)), 0) * 2.5
                     + CASE WHEN $4::text IS NOT NULL THEN COALESCE(ts_rank_cd(COALESCE(search_tsv, to_tsvector('english', COALESCE(enriched_text, raw_text))), to_tsquery('english', $4)), 0) * 1.4 ELSE 0 END
                     + COALESCE(word_similarity($3, COALESCE(enriched_text, raw_text)), 0) * 1.6
                     + CASE WHEN COALESCE(array_length($5::text[], 1), 0) > 0 AND COALESCE(enriched_text, raw_text) ILIKE ANY($5::text[]) THEN 0.75 ELSE 0 END
                   )::float8 AS lex_raw_score
            FROM workspace_document_chunks
            WHERE workspace_id = $1
              AND is_active = true
              AND ($2::text[] IS NULL OR doc_type = ANY($2::text[]))
          ) sub
          WHERE lex_raw_score > 0.02
          ORDER BY lex_raw_score DESC, chunk_index ASC
          LIMIT 20
        )
        SELECT c.chunk_id, c.doc_id, COALESCE(c.workspace_document_id, c.doc_id) AS workspace_document_id,
               c.workspace_id, c.workspace_id AS business_id, c.filename, c.page_number, c.chunk_index,
               c.section_title, c.locator, c.breadcrumb_header, c.raw_text, c.enriched_text,
               c.extracted_entities, c.doc_type, c.is_active, c.token_count, c.overlap_chars,
               NULL::int AS vec_rank, l.lex_rank, l.lex_raw_score,
               (1.0 / (60.0 + l.lex_rank))::float8 AS rrf_score
        FROM lex_candidates l
        JOIN workspace_document_chunks c ON c.chunk_id = l.chunk_id
        ORDER BY l.lex_rank ASC
        LIMIT $6;
      `;
      const res = await query(lexOnlySql, [
        cleanWs,
        cleanDocTypes,
        cleanQuery,
        orTsQuery,
        codePatterns,
        safeTopK,
      ]);
      if (Array.isArray(res?.rows)) {
        return res.rows.map((r) => ({
          ...r,
          rrf_score: Number(Number(r.rrf_score || 0).toFixed(6)),
          vec_rank: null,
          lex_rank: Number(r.lex_rank),
          hybrid_score: Number((Number(r.rrf_score || 0) * 100).toFixed(4)),
          citation: buildDocumentCitation(r),
        }));
      }
    }
  } catch (err) {
    console.warn('[HybridSearch] Falling back to in-memory chunk retrieval:', err.message);
  }

  return retrieveLegacyInMemoryDocumentChunks(cleanWs, cleanQuery, {
    topK: safeTopK,
    docTypes: cleanDocTypes,
  });
}

/**
 * Retrieves and ranks unstructured document chunks using Hybrid RRF Search on PostgreSQL
 * (with automatic in-memory fallback on unit-test mock pools).
 *
 * @param {string} businessId
 * @param {string} queryText
 * @param {{ topK?: number, includeAllIfOperational?: boolean, docTypes?: string[] | null, expandedQueries?: string[] }} [options]
 * @returns {Promise<Array<object>>}
 */
async function retrieveHybridDocumentChunks(
  businessId,
  queryText,
  options = {}
) {
  const topK = options.topK || 8;
  if (isLivePostgresPool()) {
    const rrfResults = await hybridSearchDocumentChunks({
      workspaceId: businessId,
      query: queryText,
      expandedQueries: options.expandedQueries || [],
      docTypes: options.docTypes || null,
      topK,
    });
    if (rrfResults.length > 0 || !options.includeAllIfOperational) {
      return rrfResults;
    }
  }
  return retrieveLegacyInMemoryDocumentChunks(businessId, queryText, options);
}

/**
 * Deterministically verifies claimed citations against actual retrieved chunks and table rows,
 * stripping any hallucinated chunk_id, filename, or row identifier not present in retrieved sets.
 *
 * @param {Array<object|string>} claimedCitations
 * @param {Array<object>} [retrievedChunks=[]]
 * @param {Array<object>} [retrievedRows=[]]
 * @returns {Array<object|string>}
 */
function verifyCitations(claimedCitations, retrievedChunks = [], retrievedRows = []) {
  if (!Array.isArray(claimedCitations) || claimedCitations.length === 0) {
    return [];
  }

  const validChunkIds = new Set();
  const validFilenames = new Set();
  const validDocLocators = new Set();
  const validDocPages = new Set();

  for (const chunk of Array.isArray(retrievedChunks) ? retrievedChunks : []) {
    if (!chunk || chunk.is_active === false) continue;
    const cid = String(chunk.chunk_id || chunk.id || '').trim().toLowerCase();
    if (cid) validChunkIds.add(cid);
    const fname = String(chunk.filename || chunk.source_name || '').trim().toLowerCase();
    if (fname) {
      validFilenames.add(fname);
      if (chunk.locator) {
        validDocLocators.add(`${fname}::${String(chunk.locator).trim().toLowerCase()}`);
      }
      if (chunk.page_number !== undefined && chunk.page_number !== null) {
        validDocPages.add(`${fname}::${Number(chunk.page_number)}`);
      }
    }
  }

  const validRowIds = new Set();
  const validTableRowPairs = new Set();
  for (const item of Array.isArray(retrievedRows) ? retrievedRows : []) {
    if (!item || typeof item !== 'object') continue;
    const tbl = String(item.table_name || item.source_name || item.entity || '')
      .trim()
      .toLowerCase();
    const rowObj = item.row && typeof item.row === 'object' ? item.row : item;
    const candidateIds = [
      item.row_identifier,
      item.identifier,
      rowObj?.id,
      resolveRowIdentifier(rowObj, 1, item.schema || null),
    ]
      .map((v) => String(v || '').trim().toLowerCase())
      .filter(Boolean);

    for (const rid of candidateIds) {
      validRowIds.add(rid);
      if (tbl) {
        validTableRowPairs.add(`${tbl}::${rid}`);
        validTableRowPairs.add(`${tbl}::row ${rid}`);
      }
    }
  }

  return claimedCitations.filter((claim) => {
    if (!claim) return false;
    if (typeof claim === 'string') {
      const clean = claim.trim().toLowerCase();
      return validChunkIds.has(clean) || validRowIds.has(clean) || validFilenames.has(clean);
    }
    if (typeof claim !== 'object') return false;

    const sourceType = String(claim.source_type || '').trim().toLowerCase();
    if (sourceType === 'table' || claim.row_identifier) {
      const tbl = String(claim.source_name || claim.table_name || '').trim().toLowerCase();
      const loc = String(claim.locator || '').trim().toLowerCase();
      const explicitRid = String(claim.row_identifier || loc.replace(/^row\s+/i, '')).trim().toLowerCase();
      if (!explicitRid) return false;
      if (tbl && validTableRowPairs.size > 0) {
        return validTableRowPairs.has(`${tbl}::${explicitRid}`) || validTableRowPairs.has(`${tbl}::${loc}`);
      }
      return validRowIds.has(explicitRid);
    }

    const cid = String(claim.chunk_id || '').trim().toLowerCase();
    if (cid) {
      if (!validChunkIds.has(cid)) return false;
    }

    const fname = String(claim.source_name || claim.filename || '').trim().toLowerCase();
    if (!fname) return Boolean(cid && validChunkIds.has(cid));
    if (!validFilenames.has(fname)) return false;

    const loc = String(claim.locator || '').trim().toLowerCase();
    if (loc) {
      if (validDocLocators.has(`${fname}::${loc}`)) return true;
      const pageMatch = loc.match(/\bpage\s+(\d+)\b/i);
      if (pageMatch && validDocPages.size > 0) {
        return validDocPages.has(`${fname}::${Number(pageMatch[1])}`);
      }
      // If chunk_id wasn't given and locator was altered/hallucinated outside retrieved locators, reject
      return Boolean(cid && validChunkIds.has(cid));
    }

    return true;
  });
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
  const userTerms = extractQueryKeywords(options.queryText || '')
    .map((keyword) => keyword.raw)
    .filter((keyword) => keyword.length >= 3 && !SEARCH_CONVERSATIONAL_STOP.has(keyword))
    .slice(0, 16);
  if (identifierTokens.length > 0 && !customerEmail && codeColumns.length > 0) {
    for (const token of identifierTokens.slice(0, 8)) {
      const parameter = `$${values.length + 1}`;
      values.push(token);
      predicates.push(
        `(${codeColumns.map((column) => `${quoteIdentifier(column)}::text ILIKE ${parameter}`).join(' OR ')})`
      );
    }
  }
  if (!customerEmail && searchableColumns.length > 0) {
    const documentTerms =
      identifierTokens.length > 0
        ? []
        : extractQueryKeywords(options.documentText || '')
            .map((keyword) => keyword.raw)
            .filter((keyword) => keyword.length >= 3 && !SEARCH_CONVERSATIONAL_STOP.has(keyword))
            .slice(0, 12);
    const terms = [...new Set([...userTerms, ...documentTerms])].slice(0, 18);
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
  rowTopK = null,
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
  const tableMetadata = await listWorkspaceTableMetadataCached(businessId);
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
  const queryLower = String(queryText || '').toLowerCase();
  const documentText = documentChunks
    .map((chunk) => `${chunk.breadcrumb_header || ''}\n${chunk.raw_text || ''}`)
    .join('\n')
    .slice(0, 12000);
  const documentKeywords = extractQueryKeywords(documentText).slice(0, 40);
  const docOnlyKeywords = documentKeywords.filter(
    (documentKeyword) =>
      !queryKeywords.some((queryKeyword) => queryKeyword.raw === documentKeyword.raw)
  );
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
      const userLexScore = scoreSheetRow(row, schema, queryKeywords, sheetScore);
      const docLexScore =
        docOnlyKeywords.length > 0
          ? scoreSheetRow(row, schema, docOnlyKeywords, 0) * 0.25
          : 0;
      const rowIdentifier = resolveRowIdentifier(row, idx + 1, schema);
      let exactEntityBoost = 0;
      const candidatePhrases = [
        rowIdentifier,
        row.product_name,
        row.name,
        row.unit_name,
        row.item_name,
        row.Item_Name,
        row.sku_id,
        row.sku_code,
        row.company_name,
      ]
        .map((v) => String(v || '').trim().toLowerCase())
        .filter((v) => v.length >= 4);
      for (const phrase of new Set(candidatePhrases)) {
        if (queryLower.includes(phrase)) {
          exactEntityBoost += 25;
        }
      }
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
      const hybridScore = Number(
        (userLexScore + docLexScore + exactEntityBoost + vecSim * 8).toFixed(4)
      );
      if (hybridScore > 0) {
        matchedTableRows.push({
          table_name: schema.tableName || schema.entity,
          entity: schema.entity,
          schema,
          row,
          row_identifier: rowIdentifier,
          hybrid_score: hybridScore,
          exact_entity_match: exactEntityBoost > 0,
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
  const maxRows = Math.max(1, Number(rowTopK) || topK);
  const topRowScore = matchedTableRows[0]?.hybrid_score || 0;
  const prunedTableRows =
    matchedTableRows.length <= 2
      ? matchedTableRows
      : matchedTableRows.filter(
          (item, index) =>
            index < 2 ||
            item.exact_entity_match ||
            item.hybrid_score >= topRowScore * 0.55
        );
  const topTableRows = prunedTableRows.slice(0, maxRows);

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
  retrieveLegacyInMemoryDocumentChunks,
  hybridSearchDocumentChunks,
  retrieveHybridDocumentChunks,
  verifyCitations,
  loadTableRowsForSchema,
  retrieveCrossDocumentContext,
};
