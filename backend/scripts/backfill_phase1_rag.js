const fs = require('node:fs');
const path = require('node:path');
const { getPool, withTransaction } = require('../db');
const { runPhase1Migration } = require('../src/db/migrations/phase1_hybrid_rag_and_memory');
const {
  deriveDocumentTitle,
  inferDocType,
  extractPagesFromPdf,
  chunkDocumentPages,
  getChunkVectorColumnType,
  persistChunksToDb,
} = require('../src/services/rag/documentIngestionService');
const {
  embedDocuments,
} = require('../src/services/rag/embeddingService');

const REPOSITORY_ROOT = path.resolve(__dirname, '..', '..');
const DEMO_WORKSPACES_DIR = path.join(REPOSITORY_ROOT, 'demo-workspaces');

function indexDiskPdfs(rootDir) {
  const byLowerName = new Map();
  if (!fs.existsSync(rootDir)) return byLowerName;
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        // Prefer non-residual folders if duplicate names exist
        walk(full);
      } else if (/\.pdf$/i.test(ent.name)) {
        const key = ent.name.toLowerCase();
        const isResidual = full.toLowerCase().includes('risedual');
        if (!byLowerName.has(key) || !isResidual) {
          byLowerName.set(key, full);
        }
      }
    }
  };
  walk(rootDir);
  return byLowerName;
}

async function backfillAllPopulatedWorkspaces() {
  const pool = getPool();
  await runPhase1Migration(pool);

  const vecType = await getChunkVectorColumnType();
  if (!vecType) {
    throw new Error('Vector column type (halfvec/vector) is missing on workspace_document_chunks.');
  }

  const diskPdfs = indexDiskPdfs(DEMO_WORKSPACES_DIR);

  const docsRes = await pool.query(`
    SELECT d.doc_id, d.workspace_id, d.user_id, d.filename, d.mime_type,
           d.page_count, d.chunk_count, d.full_text, COALESCE(d.is_active, true) AS is_active,
           w.name AS workspace_name,
           COUNT(c.chunk_id)::int AS db_chunks,
           COUNT(c.embedding)::int AS embedded_chunks
    FROM workspace_documents d
    JOIN workspaces w ON w.id = d.workspace_id
    LEFT JOIN workspace_document_chunks c ON c.doc_id = d.doc_id
    WHERE LOWER(COALESCE(d.mime_type, '')) NOT IN (
      'application/vnd.google-apps.spreadsheet',
      'text/csv',
      'application/csv',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    )
    AND LOWER(COALESCE(d.filename, '')) NOT LIKE '%.csv'
    GROUP BY d.doc_id, d.workspace_id, d.user_id, d.filename, d.mime_type,
             d.page_count, d.chunk_count, d.full_text, d.is_active, w.name
    ORDER BY w.name ASC, d.filename ASC;
  `);

  const forceAll = process.argv.includes('--force');
  const docs = docsRes.rows || [];
  const summary = [];

  for (const doc of docs) {
    if (!forceAll && doc.db_chunks > 0 && doc.embedded_chunks === doc.db_chunks) {
      summary.push({
        workspace_id: doc.workspace_id,
        workspace: doc.workspace_name,
        filename: doc.filename,
        chunks: doc.db_chunks,
        embedded: doc.embedded_chunks,
        status: 'already_embedded',
      });
      continue;
    }
    const pdfPath = diskPdfs.get(String(doc.filename || '').toLowerCase()) || null;
    let pages = [];
    if (pdfPath && fs.existsSync(pdfPath)) {
      pages = await extractPagesFromPdf(fs.readFileSync(pdfPath));
    }
    if (pages.length === 0 && doc.full_text && String(doc.full_text).trim()) {
      const formFeedPages = String(doc.full_text)
        .split(/\f+/)
        .map((t) => t.trim())
        .filter(Boolean);
      if (formFeedPages.length > 1) {
        pages = formFeedPages.map((text, idx) => ({ page_number: idx + 1, text }));
      } else {
        pages = [{ page_number: 1, text: String(doc.full_text).trim() }];
      }
    }

    if (pages.length === 0) {
      summary.push({
        workspace: doc.workspace_name,
        filename: doc.filename,
        status: 'skipped_empty_text',
      });
      continue;
    }

    const docTitle = deriveDocumentTitle(doc.filename, pages);
    const fullText = pages.map((p) => p.text).join('\n\n');
    const docType = inferDocType(doc.filename, docTitle, fullText);
    const chunks = chunkDocumentPages(pages, {
      docId: doc.doc_id,
      businessId: doc.workspace_id,
      filename: doc.filename,
      docType,
      isActive: doc.is_active !== false,
    });

    const embRes = await embedDocuments(
      chunks.map((c) => c.enriched_text),
      { taskType: 'RETRIEVAL_DOCUMENT' }
    );
    if (!embRes.ok) {
      throw new Error(
        `Embedding backfill failed for ${doc.filename}: ${embRes.fallbackReason || 'unknown error'}`
      );
    }

    chunks.forEach((chunk, idx) => {
      chunk.embedding_vector = embRes.vectors[idx];
      chunk.embedding_literal = embRes.literals[idx];
    });

    await withTransaction(async (client) => {
      const execQuery = (sql, params) => client.query(sql, params);
      await execQuery(
        `UPDATE workspace_documents
         SET page_count = $1, chunk_count = $2, full_text = $3, doc_type = $4, is_active = $5, updated_at = NOW()
         WHERE doc_id = $6 AND workspace_id = $7;`,
        [
          pages.length,
          chunks.length,
          fullText,
          docType,
          doc.is_active !== false,
          doc.doc_id,
          doc.workspace_id,
        ]
      );
      await execQuery(
        `DELETE FROM workspace_document_chunks
         WHERE workspace_id = $1 AND (doc_id = $2 OR workspace_document_id = $2);`,
        [doc.workspace_id, doc.doc_id]
      );
      await persistChunksToDb(execQuery, chunks, {
        businessId: doc.workspace_id,
        resolvedUserId: doc.user_id || null,
        resolvedDocId: doc.doc_id,
        vecType,
      });
    });

    const overlapCount = chunks.filter((c) => c.overlap_chars > 0).length;
    summary.push({
      workspace_id: doc.workspace_id,
      workspace: doc.workspace_name,
      filename: doc.filename,
      doc_type: docType,
      pages: pages.length,
      chunks: chunks.length,
      embedded: chunks.filter((c) => Boolean(c.embedding_literal)).length,
      with_overlap: overlapCount,
      source: pdfPath ? 'disk_pdf' : 'db_full_text',
    });
  }

  return {
    total_documents: docs.length,
    vector_type: vecType,
    documents: summary,
  };
}

if (require.main === module) {
  backfillAllPopulatedWorkspaces()
    .then((res) => {
      console.log(JSON.stringify(res, null, 2));
    })
    .catch((err) => {
      console.error('[BackfillPhase1RAG] Error:', err.message);
      process.exitCode = 1;
    })
    .finally(async () => {
      try {
        await getPool().end();
      } catch {
        // Ignore pool close errors
      }
    });
}

module.exports = { backfillAllPopulatedWorkspaces };
