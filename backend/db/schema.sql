-- Echo Customer-Support Assistant (Phase 1 & Phase 2)
-- PostgreSQL Schema Setup Script

CREATE TABLE IF NOT EXISTS businesses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL CHECK (char_length(btrim(name)) > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS context_entries (
  id BIGSERIAL PRIMARY KEY,
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  category VARCHAR(100) NOT NULL CHECK (char_length(btrim(category)) > 0),
  title VARCHAR(255) NOT NULL CHECK (char_length(btrim(title)) > 0),
  content TEXT NOT NULL CHECK (char_length(btrim(content)) > 0),
  source_file VARCHAR(255) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_context_entries_business_category_title UNIQUE (business_id, category, title)
);

CREATE INDEX IF NOT EXISTS idx_context_entries_business_id
  ON context_entries (business_id);

-- Phase 2: Persistent Multi-Turn Customer Conversations

CREATE TABLE IF NOT EXISTS customers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  customer_name VARCHAR(255),
  email VARCHAR(320),
  external_customer_id VARCHAR(255),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_customers_id_business_id UNIQUE (id, business_id),
  CONSTRAINT uq_customers_business_email UNIQUE (business_id, email)
);

-- Safe migration for existing databases where customers table already exists
ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS customer_name VARCHAR(255),
  ADD COLUMN IF NOT EXISTS email VARCHAR(320),
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'uq_customers_business_email'
  ) THEN
    ALTER TABLE customers
      ADD CONSTRAINT uq_customers_business_email UNIQUE (business_id, email);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_customers_business_id
  ON customers (business_id);

CREATE INDEX IF NOT EXISTS idx_customers_business_email
  ON customers (business_id, email)
  WHERE email IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_customers_business_external_id
  ON customers (business_id, external_customer_id)
  WHERE external_customer_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  status VARCHAR(20) NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  ai_draft_reply TEXT,
  ai_draft_category VARCHAR(100),
  ai_draft_missing_info JSONB,
  ai_draft_message_id UUID,
  ai_draft_updated_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT fk_conversations_customer_business
    FOREIGN KEY (customer_id, business_id)
    REFERENCES customers(id, business_id)
    ON DELETE CASCADE
);

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS ai_draft_reply TEXT,
  ADD COLUMN IF NOT EXISTS ai_draft_category VARCHAR(100),
  ADD COLUMN IF NOT EXISTS ai_draft_missing_info JSONB,
  ADD COLUMN IF NOT EXISTS ai_draft_message_id UUID,
  ADD COLUMN IF NOT EXISTS ai_draft_updated_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_conversations_business_id
  ON conversations (business_id);

CREATE INDEX IF NOT EXISTS idx_conversations_business_customer_id
  ON conversations (business_id, customer_id);

CREATE TABLE IF NOT EXISTS messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_type VARCHAR(20) NOT NULL CHECK (sender_type IN ('customer', 'agent')),
  content TEXT NOT NULL CHECK (char_length(btrim(content)) > 0),
  ai_suggestion TEXT,
  ai_category VARCHAR(100),
  ai_missing_info JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS ai_suggestion TEXT,
  ADD COLUMN IF NOT EXISTS ai_category VARCHAR(100),
  ADD COLUMN IF NOT EXISTS ai_missing_info JSONB;

CREATE INDEX IF NOT EXISTS idx_messages_conversation_created_at
  ON messages (conversation_id, created_at ASC, id ASC);

-- Phase 3: Bulk Email Announcements & Per-Recipient Delivery Tracking

CREATE TABLE IF NOT EXISTS announcements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  announcement_prompt TEXT NOT NULL CHECK (char_length(btrim(announcement_prompt)) > 0),
  subject VARCHAR(255) NOT NULL CHECK (char_length(btrim(subject)) > 0),
  body TEXT NOT NULL CHECK (char_length(btrim(body)) > 0),
  target_criteria JSONB NOT NULL DEFAULT '{"scope":"all","filters":[]}'::jsonb,
  audience_description TEXT NOT NULL DEFAULT 'All eligible customers',
  status VARCHAR(30) NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'sending', 'sent', 'partially_sent', 'failed')),
  total_recipients INTEGER NOT NULL DEFAULT 0,
  sent_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE announcements
  ADD COLUMN IF NOT EXISTS target_criteria JSONB NOT NULL DEFAULT '{"scope":"all","filters":[]}'::jsonb,
  ADD COLUMN IF NOT EXISTS audience_description TEXT NOT NULL DEFAULT 'All eligible customers';

CREATE INDEX IF NOT EXISTS idx_announcements_business_id
  ON announcements (business_id, created_at DESC);

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

-- Phase 4: Spreadsheet Products and Services for Natural Language Querying & Manipulation

CREATE TABLE IF NOT EXISTS products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL CHECK (char_length(btrim(name)) > 0),
  description TEXT,
  price NUMERIC(10, 2) NOT NULL DEFAULT 0.00 CHECK (price >= 0),
  stock INTEGER NOT NULL DEFAULT 0 CHECK (stock >= 0),
  category VARCHAR(100),
  size VARCHAR(50),
  color VARCHAR(50),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_products_business_id ON products(business_id);
CREATE INDEX IF NOT EXISTS idx_products_name ON products(name);
CREATE INDEX IF NOT EXISTS idx_products_price ON products(price);
CREATE INDEX IF NOT EXISTS idx_products_stock ON products(stock);
CREATE INDEX IF NOT EXISTS idx_products_category ON products(category);
CREATE INDEX IF NOT EXISTS idx_products_size ON products(size);
CREATE INDEX IF NOT EXISTS idx_products_color ON products(color);
CREATE INDEX IF NOT EXISTS idx_products_created_at ON products(created_at DESC);

CREATE TABLE IF NOT EXISTS services (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL CHECK (char_length(btrim(name)) > 0),
  description TEXT,
  rate NUMERIC(10, 2) NOT NULL DEFAULT 0.00 CHECK (rate >= 0),
  availability VARCHAR(50) NOT NULL DEFAULT 'available' CHECK (availability IN ('available', 'unavailable')),
  size VARCHAR(50),
  available_from DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_services_business_id ON services(business_id);
CREATE INDEX IF NOT EXISTS idx_services_name ON services(name);
CREATE INDEX IF NOT EXISTS idx_services_rate ON services(rate);
CREATE INDEX IF NOT EXISTS idx_services_availability ON services(availability);
CREATE INDEX IF NOT EXISTS idx_services_size ON services(size);
CREATE INDEX IF NOT EXISTS idx_services_available_from ON services(available_from);
CREATE INDEX IF NOT EXISTS idx_services_created_at ON services(created_at DESC);
