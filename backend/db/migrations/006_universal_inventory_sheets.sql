-- Migration 006: Universal Inventory Sheets (Electronics and Grocery Inventory)
-- Adds demo inventory tables with diverse schemas to support universal inventory management.

-- 1. Electronics Inventory
CREATE TABLE IF NOT EXISTS electronics_inventory (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  product_name VARCHAR(255) NOT NULL,
  brand_name VARCHAR(100),
  model VARCHAR(100),
  current_price NUMERIC(10, 2) NOT NULL DEFAULT 0.00 CHECK (current_price >= 0),
  stock_qty INTEGER NOT NULL DEFAULT 0 CHECK (stock_qty >= 0),
  warehouse VARCHAR(100),
  reorder_level INTEGER NOT NULL DEFAULT 0 CHECK (reorder_level >= 0),
  warranty_months INTEGER NOT NULL DEFAULT 12 CHECK (warranty_months >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_electronics_business_id ON electronics_inventory(business_id);
CREATE INDEX IF NOT EXISTS idx_electronics_brand_name ON electronics_inventory(brand_name);
CREATE INDEX IF NOT EXISTS idx_electronics_warehouse ON electronics_inventory(warehouse);
CREATE INDEX IF NOT EXISTS idx_electronics_current_price ON electronics_inventory(current_price);
CREATE INDEX IF NOT EXISTS idx_electronics_stock_qty ON electronics_inventory(stock_qty);

-- 2. Grocery Inventory
CREATE TABLE IF NOT EXISTS grocery_inventory (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  item_name VARCHAR(255) NOT NULL,
  supplier VARCHAR(100),
  unit_cost NUMERIC(10, 2) NOT NULL DEFAULT 0.00 CHECK (unit_cost >= 0),
  selling_price NUMERIC(10, 2) NOT NULL DEFAULT 0.00 CHECK (selling_price >= 0),
  expiry_date DATE,
  batch_no VARCHAR(100),
  quantity INTEGER NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  warehouse_location VARCHAR(100),
  status VARCHAR(50) DEFAULT 'in_stock',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_grocery_business_id ON grocery_inventory(business_id);
CREATE INDEX IF NOT EXISTS idx_grocery_supplier ON grocery_inventory(supplier);
CREATE INDEX IF NOT EXISTS idx_grocery_expiry_date ON grocery_inventory(expiry_date);
CREATE INDEX IF NOT EXISTS idx_grocery_selling_price ON grocery_inventory(selling_price);
CREATE INDEX IF NOT EXISTS idx_grocery_warehouse_loc ON grocery_inventory(warehouse_location);
