-- Migration 009: User-Centric Multi-Tenant Architecture
-- 1. Renames customers to users, adds password, email uniqueness, drops business_id/external_customer_id
-- 2. Renames businesses to workspaces, adds user_id foreign key, links all existing workspaces to Google account
-- 3. Updates google_auth_tokens to reference user_id
-- 4. Updates workspace_documents and workspace_document_chunks with workspace_id, user_id, workspace_document_id
-- 5. Adds workspace_id columns to dynamic tables and metadata tables

-- ==============================================================================
-- 1. Clean up & Transform customers -> users
-- ==============================================================================

-- Drop constraints referencing customers
ALTER TABLE IF EXISTS conversations DROP CONSTRAINT IF EXISTS fk_conversations_customer_business CASCADE;
ALTER TABLE IF EXISTS conversations DROP CONSTRAINT IF EXISTS conversations_customer_id_fkey CASCADE;
ALTER TABLE IF EXISTS announcement_recipients DROP CONSTRAINT IF EXISTS announcement_recipients_customer_id_fkey CASCADE;
ALTER TABLE IF EXISTS customers DROP CONSTRAINT IF EXISTS uq_customers_business_email CASCADE;
ALTER TABLE IF EXISTS customers DROP CONSTRAINT IF EXISTS uq_customers_id_business_id CASCADE;
ALTER TABLE IF EXISTS customers DROP CONSTRAINT IF EXISTS customers_business_id_fkey CASCADE;

-- Ensure table is renamed to users if not already renamed
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'customers') THEN
    ALTER TABLE customers RENAME TO users;
  END IF;
END $$;

-- Adjust columns in users table
DO $$
BEGIN
  -- Rename customer_name to name if exists
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'customer_name') THEN
    ALTER TABLE users RENAME COLUMN customer_name TO name;
  END IF;
END $$;

ALTER TABLE users ADD COLUMN IF NOT EXISTS password VARCHAR(255);
ALTER TABLE users DROP COLUMN IF EXISTS external_customer_id;
ALTER TABLE users DROP COLUMN IF EXISTS business_id;

-- Ensure email unique constraint on users
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uq_users_email') THEN
    ALTER TABLE users ADD CONSTRAINT uq_users_email UNIQUE (email);
  END IF;
END $$;

-- Upsert the Google account user (dsfardin606@gmail.com)
INSERT INTO users (id, name, email, created_at, updated_at)
VALUES (
  '48244777-c7a4-4e30-be4b-fe1104e443b8',
  'Fardin Mridul',
  'dsfardin606@gmail.com',
  NOW(),
  NOW()
)
ON CONFLICT (email) DO UPDATE SET
  name = EXCLUDED.name,
  updated_at = NOW();

-- Set password for the email/password user cd9d3fcf-e923-4996-9cf4-c0d5bc403480 (Echo2026!Secure)
UPDATE users
SET password = 'eadba86089841164e6122fa247176aa1:bbbacd623d915ed8d806def8f806b1ff742b61cc5759699de5e3e6a6e0c52e02f83820ebfc22710a4a919bd76b280e34a0376228fa7c38f8765ec001d88dc900'
WHERE id = 'cd9d3fcf-e923-4996-9cf4-c0d5bc403480';

-- Re-link conversations and announcements to users table
ALTER TABLE conversations ADD CONSTRAINT fk_conversations_user FOREIGN KEY (customer_id) REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE announcement_recipients ADD CONSTRAINT fk_announcement_recipients_user FOREIGN KEY (customer_id) REFERENCES users(id) ON DELETE SET NULL;

-- ==============================================================================
-- 2. Transform businesses -> workspaces
-- ==============================================================================

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'businesses') THEN
    ALTER TABLE businesses RENAME TO workspaces;
  END IF;
END $$;

ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES users(id) ON DELETE CASCADE;

-- Assign all existing workspaces to the Google account dsfardin606@gmail.com (id: 48244777-c7a4-4e30-be4b-fe1104e443b8)
UPDATE workspaces
SET user_id = '48244777-c7a4-4e30-be4b-fe1104e443b8'
WHERE user_id IS NULL OR user_id != '48244777-c7a4-4e30-be4b-fe1104e443b8';

ALTER TABLE workspaces ALTER COLUMN user_id SET NOT NULL;

-- ==============================================================================
-- 3. Transform google_auth_tokens to reference user_id
-- ==============================================================================

ALTER TABLE google_auth_tokens DROP CONSTRAINT IF EXISTS google_auth_tokens_business_id_fkey;
ALTER TABLE google_auth_tokens DROP CONSTRAINT IF EXISTS google_auth_tokens_pkey;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'google_auth_tokens' AND column_name = 'business_id') THEN
    ALTER TABLE google_auth_tokens RENAME COLUMN business_id TO user_id;
  END IF;
END $$;

-- Ensure user_id in google_auth_tokens points to 48244777-c7a4-4e30-be4b-fe1104e443b8
UPDATE google_auth_tokens
SET user_id = '48244777-c7a4-4e30-be4b-fe1104e443b8'
WHERE email = 'dsfardin606@gmail.com';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'google_auth_tokens_pkey') THEN
    ALTER TABLE google_auth_tokens ADD CONSTRAINT google_auth_tokens_pkey PRIMARY KEY (user_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_google_auth_tokens_user') THEN
    ALTER TABLE google_auth_tokens ADD CONSTRAINT fk_google_auth_tokens_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
  END IF;
END $$;

-- ==============================================================================
-- 4. Transform workspace_documents & workspace_document_chunks
-- ==============================================================================

-- workspace_documents
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'workspace_documents' AND column_name = 'business_id') THEN
    ALTER TABLE workspace_documents RENAME COLUMN business_id TO workspace_id;
  END IF;
END $$;

ALTER TABLE workspace_documents ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES users(id) ON DELETE CASCADE;

-- Backfill user_id from workspaces
UPDATE workspace_documents d
SET user_id = w.user_id
FROM workspaces w
WHERE d.workspace_id = w.id AND d.user_id IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_workspace_documents_workspace') THEN
    ALTER TABLE workspace_documents ADD CONSTRAINT fk_workspace_documents_workspace FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;
  END IF;
END $$;

-- workspace_document_chunks
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'workspace_document_chunks' AND column_name = 'business_id') THEN
    ALTER TABLE workspace_document_chunks RENAME COLUMN business_id TO workspace_id;
  END IF;
END $$;

ALTER TABLE workspace_document_chunks ADD COLUMN IF NOT EXISTS workspace_document_id UUID;
UPDATE workspace_document_chunks SET workspace_document_id = doc_id WHERE workspace_document_id IS NULL;

ALTER TABLE workspace_document_chunks ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES users(id) ON DELETE CASCADE;

-- Backfill user_id from workspace_documents
UPDATE workspace_document_chunks c
SET user_id = d.user_id
FROM workspace_documents d
WHERE c.workspace_document_id = d.doc_id AND c.user_id IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_chunks_workspace') THEN
    ALTER TABLE workspace_document_chunks ADD CONSTRAINT fk_chunks_workspace FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_chunks_workspace_doc') THEN
    ALTER TABLE workspace_document_chunks ADD CONSTRAINT fk_chunks_workspace_doc FOREIGN KEY (workspace_document_id) REFERENCES workspace_documents(doc_id) ON DELETE CASCADE;
  END IF;
END $$;

-- ==============================================================================
-- 5. Add workspace_id to Dynamic & Metadata Tables
-- ==============================================================================

ALTER TABLE google_sheet_sync_metadata ADD COLUMN IF NOT EXISTS workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE;
UPDATE google_sheet_sync_metadata SET workspace_id = business_id WHERE workspace_id IS NULL;
ALTER TABLE google_sheet_sync_metadata ADD COLUMN IF NOT EXISTS workspace_document_id UUID REFERENCES workspace_documents(doc_id) ON DELETE SET NULL;

DO $$
DECLARE
  t text;
  tbls text[] := ARRAY['orders', 'products', 'backorders_dataset', 'wholesale_accunts_dataset', 'hospital_units', 'electronics_inventory', 'context_entries', 'conversations', 'announcements', 'socratic_workflows'];
BEGIN
  FOREACH t IN ARRAY tbls
  LOOP
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = t) THEN
      EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS workspace_id UUID;', t);
      IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = t AND column_name = 'business_id') THEN
        EXECUTE format('UPDATE %I SET workspace_id = business_id WHERE workspace_id IS NULL;', t);
      END IF;
      EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I (workspace_id);', 'idx_' || t || '_workspace_id', t);
    END IF;
  END LOOP;
END $$;
