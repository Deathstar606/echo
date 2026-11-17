ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS ai_draft_citations JSONB NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS ai_citations JSONB NOT NULL DEFAULT '[]'::jsonb;
