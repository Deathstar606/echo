-- Migration 014: Shared Demo Account & Ownership Migration
-- 1. Create canonical shared Demo Account accessible to everyone clicking "Try Now".
-- 2. Migrate all existing workspaces, workspace_documents, workspace_document_chunks,
--    and linked google_auth_tokens from legacy user_id ('48244777-c7a4-4e30-be4b-fe1104e443b8')
--    to the shared Demo Account ('10000000-0000-4000-8000-000000000001') without reuploading files.

BEGIN;

INSERT INTO users (id, name, email, password, created_at, updated_at)
VALUES (
  '10000000-0000-4000-8000-000000000001',
  'MaxiText Demo Account',
  'demo@maxitext.studio',
  '6d45ecd126dbac73beeea20c9ae88a0a:256c34afd43c1a112c70eab9c8b59ef19e4fac770e710d7b58e4d742ba2ac14e631c8a1b99fd2878f30df0a5a5a29f50bf97fccb1f286a4bcb52eacf3d7e6f91',
  NOW(),
  NOW()
)
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  email = EXCLUDED.email,
  updated_at = NOW();

-- Migrate all workspaces owned by legacy primary user to the Demo Account
UPDATE workspaces
SET user_id = '10000000-0000-4000-8000-000000000001'
WHERE user_id = '48244777-c7a4-4e30-be4b-fe1104e443b8';

-- Migrate all workspace_documents owned by legacy user or inside migrated workspaces
UPDATE workspace_documents
SET user_id = '10000000-0000-4000-8000-000000000001',
    updated_at = NOW()
WHERE user_id = '48244777-c7a4-4e30-be4b-fe1104e443b8'
   OR (
     workspace_id IN (
       SELECT id FROM workspaces WHERE user_id = '10000000-0000-4000-8000-000000000001'
     )
     AND user_id IS NULL
   );

-- Migrate all workspace_document_chunks owned by legacy user or inside migrated workspaces
UPDATE workspace_document_chunks
SET user_id = '10000000-0000-4000-8000-000000000001'
WHERE user_id = '48244777-c7a4-4e30-be4b-fe1104e443b8'
   OR (
     workspace_id IN (
       SELECT id FROM workspaces WHERE user_id = '10000000-0000-4000-8000-000000000001'
     )
     AND user_id IS NULL
   );

-- Transfer Google OAuth link token row to the Demo Account if not already present
UPDATE google_auth_tokens
SET user_id = '10000000-0000-4000-8000-000000000001',
    updated_at = NOW()
WHERE user_id = '48244777-c7a4-4e30-be4b-fe1104e443b8'
  AND NOT EXISTS (
    SELECT 1 FROM google_auth_tokens g2
    WHERE g2.user_id = '10000000-0000-4000-8000-000000000001'
  );

COMMIT;
