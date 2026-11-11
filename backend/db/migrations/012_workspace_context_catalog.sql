CREATE TABLE IF NOT EXISTS workspace_table_metadata (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  table_name TEXT NOT NULL,
  source_filename TEXT NOT NULL,
  row_count BIGINT NOT NULL DEFAULT 0,
  primary_key_column TEXT,
  email_column TEXT,
  columns_profile JSONB NOT NULL DEFAULT '[]'::jsonb,
  sample_rows JSONB NOT NULL DEFAULT '[]'::jsonb,
  table_summary TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, table_name)
);

CREATE INDEX IF NOT EXISTS idx_workspace_table_metadata_workspace
  ON workspace_table_metadata (workspace_id);

CREATE INDEX IF NOT EXISTS idx_workspace_table_metadata_workspace_table
  ON workspace_table_metadata (workspace_id, table_name);

ALTER TABLE workspace_document_chunks
  ADD COLUMN IF NOT EXISTS locator TEXT,
  ADD COLUMN IF NOT EXISTS breadcrumb_header TEXT,
  ADD COLUMN IF NOT EXISTS enriched_text TEXT,
  ADD COLUMN IF NOT EXISTS extracted_entities JSONB NOT NULL DEFAULT '[]'::jsonb;

UPDATE workspace_document_chunks
SET locator = CONCAT('Page ', page_number, ' / Chunk ', chunk_index + 1),
    enriched_text = COALESCE(enriched_text, raw_text)
WHERE locator IS NULL OR enriched_text IS NULL;

CREATE INDEX IF NOT EXISTS idx_workspace_chunks_entities
  ON workspace_document_chunks USING GIN (extracted_entities);
