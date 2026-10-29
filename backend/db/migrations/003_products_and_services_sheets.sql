-- Phase 4 Migration: Single Products Spreadsheet Table for Natural Language Querying & Manipulation
-- Removes legacy services and legacy products tables and creates the updated products table.

-- 1. Ensure the default business exists
INSERT INTO businesses (id, name, created_at)
VALUES ('684a8863-5094-4c8b-9b15-c50c06335b7f', 'Veloura Apparel', NOW())
ON CONFLICT (id) DO UPDATE SET name = 'Veloura Apparel';

-- 2. Remove legacy services table and any legacy products table using the old schema
DROP TABLE IF EXISTS services CASCADE;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'products'
      AND column_name = 'stock'
  ) THEN
    DROP TABLE products CASCADE;
  END IF;
END $$;

-- 3. Products table matching products.csv (name, category, description, best, color, discount, ordered, images, size, price)
CREATE TABLE IF NOT EXISTS products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL CHECK (char_length(btrim(name)) > 0),
  category VARCHAR(100),
  description TEXT,
  best BOOLEAN NOT NULL DEFAULT FALSE,
  color TEXT,
  discount NUMERIC(10, 2) NOT NULL DEFAULT 0 CHECK (discount >= 0),
  ordered INTEGER NOT NULL DEFAULT 0 CHECK (ordered >= 0),
  images TEXT,
  size TEXT,
  price NUMERIC(10, 2) NOT NULL DEFAULT 0.00 CHECK (price >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_products_business_id ON products(business_id);
CREATE INDEX IF NOT EXISTS idx_products_name ON products(name);
CREATE INDEX IF NOT EXISTS idx_products_category ON products(category);
CREATE INDEX IF NOT EXISTS idx_products_best ON products(best);
CREATE INDEX IF NOT EXISTS idx_products_color ON products(color);
CREATE INDEX IF NOT EXISTS idx_products_discount ON products(discount);
CREATE INDEX IF NOT EXISTS idx_products_ordered ON products(ordered);
CREATE INDEX IF NOT EXISTS idx_products_price ON products(price);
CREATE INDEX IF NOT EXISTS idx_products_created_at ON products(created_at DESC);
