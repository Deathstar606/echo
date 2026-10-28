-- Phase 5 Migration: AI Draft Suggestion Persistence & Default Business Context
-- Stores AI-generated reply suggestions server-side on messages and conversations
-- so that customer-facing endpoints never expose AI drafts while company-facing
-- endpoints can retrieve and review them.

-- 1. Ensure the hardcoded default business exists
INSERT INTO businesses (id, name, created_at)
VALUES ('684a8863-5094-4c8b-9b15-c50c06335b7f', 'MaxiText Demo Business', NOW())
ON CONFLICT (id) DO NOTHING;

-- 2. Seed initial sample business context for the default business if not present
INSERT INTO context_entries (business_id, category, title, content, source_file)
VALUES
  ('684a8863-5094-4c8b-9b15-c50c06335b7f', 'company_info', 'Company Overview', 'We provide home renovation, remodeling, billing assistance, and consultation services.', 'sample-context.csv'),
  ('684a8863-5094-4c8b-9b15-c50c06335b7f', 'refund_policy', 'Refund Eligibility', 'Customers may request a refund within 7 days if the service has not started.', 'sample-context.csv'),
  ('684a8863-5094-4c8b-9b15-c50c06335b7f', 'cancellation_policy', 'Appointment Cancellation', 'Customers should cancel or reschedule at least 24 hours before their appointment.', 'sample-context.csv'),
  ('684a8863-5094-4c8b-9b15-c50c06335b7f', 'billing_policy', 'Overdue Balance Extensions', 'Customers requesting an extension on an overdue balance may receive a 3-day grace extension upon inquiry.', 'sample-context.csv'),
  ('684a8863-5094-4c8b-9b15-c50c06335b7f', 'support_process', 'Human Support', 'Escalate unresolved disputes to a human support representative.', 'sample-context.csv')
ON CONFLICT (business_id, category, title) DO NOTHING;

-- 3. Safely extend conversations table with server-side AI draft fields
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS ai_draft_reply TEXT,
  ADD COLUMN IF NOT EXISTS ai_draft_category VARCHAR(100),
  ADD COLUMN IF NOT EXISTS ai_draft_missing_info JSONB,
  ADD COLUMN IF NOT EXISTS ai_draft_message_id UUID,
  ADD COLUMN IF NOT EXISTS ai_draft_updated_at TIMESTAMPTZ;

-- 4. Safely extend messages table with per-message AI suggestion fields
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS ai_suggestion TEXT,
  ADD COLUMN IF NOT EXISTS ai_category VARCHAR(100),
  ADD COLUMN IF NOT EXISTS ai_missing_info JSONB;
