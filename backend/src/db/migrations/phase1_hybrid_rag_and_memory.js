const { getPool } = require('../../../db');

const MIGRATION_KEY = 'phase1_hybrid_rag_and_memory.js';

/**
 * Applies backward-compatible Phase 1 PostgreSQL extensions, columns,
 * memory-safe indexes (for Aiven 1 GB RAM free tier), and workspace_turn_memory.
 *
 * 100% idempotent and non-destructive: never drops tables, renames columns,
 * or alters existing column types.
 *
 * @param {import('pg').Pool | null} [customPool=null]
 */
async function runPhase1Migration(customPool = null) {
  const pool = customPool || getPool();
  const isMockPool =
    !pool ||
    typeof pool.query !== 'function' ||
    typeof pool.connect !== 'function';
  if (isMockPool) {
    return { skipped: true, reason: 'non_pg_or_mock_pool' };
  }

  // 1. Enable pgvector and pg_trgm extensions
  await pool.query('CREATE EXTENSION IF NOT EXISTS vector;');
  await pool.query('CREATE EXTENSION IF NOT EXISTS pg_trgm;');

  // 2. Detect halfvec support (pgvector >= 0.7) vs vector(768) fallback
  const halfvecCheck = await pool.query(
    "SELECT 1 FROM pg_type WHERE typname = 'halfvec' LIMIT 1;"
  );
  const supportsHalfvec = Array.isArray(halfvecCheck.rows) && halfvecCheck.rows.length > 0;
  const vectorColumnType = supportsHalfvec ? 'halfvec(768)' : 'vector(768)';
  const vectorIndexOps = supportsHalfvec ? 'halfvec_cosine_ops' : 'vector_cosine_ops';

  // 3. Backward-compatible columns on workspace_documents
  await pool.query(`
    ALTER TABLE workspace_documents
      ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT true,
      ADD COLUMN IF NOT EXISTS doc_type TEXT NOT NULL DEFAULT 'general';
  `);

  // 4. Backward-compatible columns on workspace_document_chunks
  await pool.query(`
    ALTER TABLE workspace_document_chunks
      ADD COLUMN IF NOT EXISTS embedding ${vectorColumnType},
      ADD COLUMN IF NOT EXISTS search_tsv tsvector,
      ADD COLUMN IF NOT EXISTS section_title TEXT,
      ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT true,
      ADD COLUMN IF NOT EXISTS doc_type TEXT NOT NULL DEFAULT 'general',
      ADD COLUMN IF NOT EXISTS token_count INTEGER DEFAULT 0,
      ADD COLUMN IF NOT EXISTS overlap_chars INTEGER DEFAULT 0;
  `);

  // 5. Memory-safe indexes (Aiven 1 GB RAM / 1 GB disk tuned)
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_chunks_ws_active_type
      ON workspace_document_chunks (workspace_id, is_active, doc_type);
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_chunks_search_tsv
      ON workspace_document_chunks USING GIN (search_tsv);
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_chunks_enriched_trgm
      ON workspace_document_chunks USING GIN (enriched_text gin_trgm_ops);
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_chunks_embedding_hnsw
      ON workspace_document_chunks USING hnsw (embedding ${vectorIndexOps})
      WITH (m = 8, ef_construction = 32);
  `);

  // 6. Compact 5-Turn State Memory table
  await pool.query(`
    CREATE TABLE IF NOT EXISTS workspace_turn_memory (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      workspace_id UUID NOT NULL,
      session_id TEXT NOT NULL,
      turn_number INTEGER NOT NULL,
      entity TEXT NOT NULL DEFAULT 'user',
      user_intent_summary TEXT NOT NULL,
      action_taken TEXT NOT NULL,
      touched_tables JSONB NOT NULL DEFAULT '[]'::jsonb,
      touched_row_keys JSONB NOT NULL DEFAULT '[]'::jsonb,
      touched_doc_citations JSONB NOT NULL DEFAULT '[]'::jsonb,
      outcome_summary TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_turn_memory_ws_session_created
      ON workspace_turn_memory (workspace_id, session_id, created_at DESC);
  `);

  // 7. Record migration idempotently
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename VARCHAR(255) PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await pool.query(
    'INSERT INTO schema_migrations (filename) VALUES ($1) ON CONFLICT (filename) DO NOTHING;',
    [MIGRATION_KEY]
  );

  return {
    skipped: false,
    supportsHalfvec,
    vectorColumnType,
    vectorIndexOps,
  };
}

if (require.main === module) {
  const pool = getPool();
  runPhase1Migration(pool)
    .then((summary) => {
      console.log('[Phase1Migration] Completed:', JSON.stringify(summary));
    })
    .catch((err) => {
      console.error('[Phase1Migration] Failed:', err.message);
      process.exitCode = 1;
    })
    .finally(async () => {
      try {
        await pool.end();
      } catch {
        // Ignore pool close errors
      }
    });
}

module.exports = {
  MIGRATION_KEY,
  runPhase1Migration,
};
