CREATE TABLE IF NOT EXISTS workspace_documents (
  doc_id UUID PRIMARY KEY,
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  filename VARCHAR(255) NOT NULL,
  mime_type VARCHAR(100),
  page_count INTEGER NOT NULL DEFAULT 1,
  chunk_count INTEGER NOT NULL DEFAULT 0,
  full_text TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS workspace_document_chunks (
  chunk_id UUID PRIMARY KEY,
  doc_id UUID NOT NULL REFERENCES workspace_documents(doc_id) ON DELETE CASCADE,
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  filename VARCHAR(255) NOT NULL,
  page_number INTEGER NOT NULL DEFAULT 1,
  chunk_index INTEGER NOT NULL DEFAULT 0,
  section_title VARCHAR(255),
  raw_text TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS socratic_workflows (
  workflow_id UUID PRIMARY KEY,
  business_id UUID REFERENCES businesses(id) ON DELETE CASCADE,
  status VARCHAR(64) NOT NULL,
  prompt TEXT NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_workspace_documents_business_created
  ON workspace_documents (business_id, created_at);

CREATE INDEX IF NOT EXISTS idx_workspace_documents_business_filename
  ON workspace_documents (business_id, LOWER(filename));

CREATE INDEX IF NOT EXISTS idx_workspace_chunks_business_page
  ON workspace_document_chunks (business_id, filename, page_number, chunk_index);

CREATE INDEX IF NOT EXISTS idx_socratic_workflows_business_updated
  ON socratic_workflows (business_id, updated_at DESC);
