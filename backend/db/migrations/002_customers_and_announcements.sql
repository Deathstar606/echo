-- Phase 3 Migration: Customer Management Enhancement & Bulk Email Announcements
-- Safe, non-destructive migration that preserves all existing records.

-- 1. Safely extend customers table with customer_name, email, and updated_at
ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS customer_name VARCHAR(255),
  ADD COLUMN IF NOT EXISTS email VARCHAR(320),
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- Normalize any pre-existing non-null email values to lowercase trimmed strings
UPDATE customers
SET email = lower(btrim(email))
WHERE email IS NOT NULL AND email <> lower(btrim(email));

-- Add unique constraint (business_id, email) if not already present.
-- In PostgreSQL, standard UNIQUE allows multiple NULLs for legacy records
-- while strictly preventing duplicate non-null emails within the same business.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'uq_customers_business_email'
  ) THEN
    ALTER TABLE customers
      ADD CONSTRAINT uq_customers_business_email UNIQUE (business_id, email);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_customers_business_email
  ON customers (business_id, email)
  WHERE email IS NOT NULL;

-- 2. Announcements table for storing AI-generated drafts and campaign state
CREATE TABLE IF NOT EXISTS announcements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  announcement_prompt TEXT NOT NULL CHECK (char_length(btrim(announcement_prompt)) > 0),
  subject VARCHAR(255) NOT NULL CHECK (char_length(btrim(subject)) > 0),
  body TEXT NOT NULL CHECK (char_length(btrim(body)) > 0),
  status VARCHAR(30) NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'sending', 'sent', 'partially_sent', 'failed')),
  total_recipients INTEGER NOT NULL DEFAULT 0,
  sent_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_announcements_business_id
  ON announcements (business_id, created_at DESC);

-- 3. Announcement recipients table for per-recipient delivery tracking
CREATE TABLE IF NOT EXISTS announcement_recipients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  announcement_id UUID NOT NULL REFERENCES announcements(id) ON DELETE CASCADE,
  customer_id UUID REFERENCES customers(id) ON DELETE SET NULL,
  customer_name VARCHAR(255) NOT NULL,
  email VARCHAR(320) NOT NULL,
  status VARCHAR(20) NOT NULL CHECK (status IN ('sent', 'failed')),
  error_message TEXT,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_announcement_recipients_announcement_email UNIQUE (announcement_id, email)
);

CREATE INDEX IF NOT EXISTS idx_announcement_recipients_announcement_id
  ON announcement_recipients (announcement_id);
