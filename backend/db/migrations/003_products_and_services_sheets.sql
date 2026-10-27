-- Phase 4 Migration: Products and Services Spreadsheet Tables for Natural Language Querying & Manipulation
-- Safe, idempotent migration script.

-- 1. Ensure the default demo business exists
INSERT INTO businesses (id, name, created_at)
VALUES ('684a8863-5094-4c8b-9b15-c50c06335b7f', 'Default Demo Business', NOW())
ON CONFLICT (id) DO NOTHING;

-- 2. Products table
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

-- 3. Services table
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
