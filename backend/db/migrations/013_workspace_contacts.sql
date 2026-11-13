-- Migration 013: Workspace Contacts Table
-- Supports 1-Click Gmail to Filtered routing and Workspace-Specific Deduplicated CSV Contact Imports

CREATE TABLE IF NOT EXISTS workspace_contacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  workspace_name TEXT,
  panel_type TEXT NOT NULL, -- 'filtered' | 'workspace_csv'
  email TEXT NOT NULL,
  customer_name TEXT,
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT uq_workspace_panel_email UNIQUE (workspace_id, panel_type, email)
);

-- Foreign key to workspaces if workspaces table exists
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'workspaces') THEN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_workspace_contacts_workspace') THEN
      ALTER TABLE workspace_contacts
      ADD CONSTRAINT fk_workspace_contacts_workspace
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;
    END IF;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_workspace_contacts_lookup ON workspace_contacts (workspace_id, panel_type);
CREATE INDEX IF NOT EXISTS idx_workspace_contacts_email ON workspace_contacts (LOWER(email));
