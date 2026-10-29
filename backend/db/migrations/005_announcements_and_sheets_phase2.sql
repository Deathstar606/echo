-- Phase 6 Migration: Announcements (NL Audience Targeting & History)
-- 1. Extend announcements table with validated recipient targeting criteria & description
ALTER TABLE announcements
  ADD COLUMN IF NOT EXISTS target_criteria JSONB NOT NULL DEFAULT '{"scope":"all","filters":[]}'::jsonb,
  ADD COLUMN IF NOT EXISTS audience_description TEXT NOT NULL DEFAULT 'All eligible customers';

-- 2. Seed sample customers with varied registration dates (created_at) for default business if not present
INSERT INTO customers (business_id, customer_name, email, external_customer_id, created_at, updated_at)
VALUES
  ('684a8863-5094-4c8b-9b15-c50c06335b7f', 'Fardin Rahman', 'dsfardin606@gmail.com', 'CUST-1001', '2026-02-15T10:00:00Z', '2026-02-15T10:00:00Z'),
  ('684a8863-5094-4c8b-9b15-c50c06335b7f', 'Fardinand Magline', 'fardinmridulcactus14202005@gmail.com', 'CUST-1002', '2026-03-10T14:30:00Z', '2026-03-10T14:30:00Z'),
  ('684a8863-5094-4c8b-9b15-c50c06335b7f', 'Elena Vance', 'elena.vance@example.com', 'CUST-1003', '2025-11-20T09:15:00Z', '2025-11-20T09:15:00Z'),
  ('684a8863-5094-4c8b-9b15-c50c06335b7f', 'Marcus Sterling', 'marcus.sterling@example.com', 'CUST-1004', '2025-12-05T16:45:00Z', '2025-12-05T16:45:00Z'),
  ('684a8863-5094-4c8b-9b15-c50c06335b7f', 'Sophia Chen', 'sophia.chen@example.com', 'CUST-1005', '2026-06-01T11:20:00Z', '2026-06-01T11:20:00Z')
ON CONFLICT (business_id, email) DO NOTHING;
