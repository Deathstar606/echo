-- 008_google_workspace_integration.sql
-- Google OAuth2 Tokens, Connected Profiles & Google Sheet 2-Way Sync Tracking

CREATE TABLE IF NOT EXISTS google_auth_tokens (
  business_id UUID PRIMARY KEY REFERENCES businesses(id) ON DELETE CASCADE,
  email VARCHAR(255) NOT NULL,
  name VARCHAR(255),
  picture TEXT,
  access_token TEXT,
  refresh_token TEXT,
  expiry_date BIGINT,
  is_env_connected BOOLEAN DEFAULT FALSE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS google_sheet_sync_metadata (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  table_name VARCHAR(128) NOT NULL,
  google_spreadsheet_id VARCHAR(255) NOT NULL,
  google_sheet_tab_name VARCHAR(255) NOT NULL,
  column_letter_map JSONB NOT NULL DEFAULT '{}'::jsonb,
  row_count INT NOT NULL DEFAULT 0,
  last_synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_biz_table_google UNIQUE (business_id, table_name)
);

CREATE INDEX IF NOT EXISTS idx_google_sync_lookup 
ON google_sheet_sync_metadata(business_id, table_name);
