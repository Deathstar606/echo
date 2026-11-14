-- Migration 016: Multi-User Workspace Sharing Table & Grants
-- Enables sharing workspaces (along with all documents, chunks, dynamic tables, contacts, and threads)
-- across multiple user accounts without duplicating primary-key workspace IDs.

BEGIN;

CREATE TABLE IF NOT EXISTS workspace_shares (
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role VARCHAR(32) NOT NULL DEFAULT 'editor',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workspace_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_workspace_shares_user_id
  ON workspace_shares (user_id);

-- Ensure target user exists cleanly if not already present
INSERT INTO users (id, name, email, created_at, updated_at)
VALUES (
  '48244777-c7a4-4e30-be4b-fe1104e443b8',
  'Fardin Mridul',
  'dsfardin606@gmail.com',
  NOW(),
  NOW()
)
ON CONFLICT DO NOTHING;

-- Share the two target workspaces (and all their files/tables) with user 48244777-c7a4-4e30-be4b-fe1104e443b8
INSERT INTO workspace_shares (workspace_id, user_id, role, created_at)
SELECT w.id, u.id, 'owner', NOW()
FROM workspaces w
JOIN users u ON u.id = '48244777-c7a4-4e30-be4b-fe1104e443b8'
WHERE w.id IN (
  '684a8863-5094-4c8b-9b15-c50c06335b7f',
  '11111111-2222-3333-4444-555555555555'
)
ON CONFLICT (workspace_id, user_id) DO NOTHING;

COMMIT;
