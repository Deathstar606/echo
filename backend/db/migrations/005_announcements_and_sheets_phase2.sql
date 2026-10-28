-- Phase 6 Migration: Complete Announcements (NL Audience Targeting & History) and Seed Default Sheets
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

-- 3. Seed sample products for default business if the products sheet is currently empty
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM products WHERE business_id = '684a8863-5094-4c8b-9b15-c50c06335b7f'
  ) THEN
    INSERT INTO products (business_id, name, description, price, stock, category, size, color, created_at, updated_at)
    VALUES
      ('684a8863-5094-4c8b-9b15-c50c06335b7f', 'Trail Rain Jacket', 'Waterproof and lightweight shell jacket with taped seams', 129.99, 0, 'Outerwear', 'XL', 'Red', '2026-10-20T00:00:00Z', NOW()),
      ('684a8863-5094-4c8b-9b15-c50c06335b7f', 'Trail Rain Jacket', 'Waterproof and lightweight shell jacket with taped seams', 129.99, 14, 'Outerwear', 'M', 'Blue', '2026-10-20T00:00:00Z', NOW()),
      ('684a8863-5094-4c8b-9b15-c50c06335b7f', 'Summit Hiking Boots', 'Waterproof leather boots with ankle support', 179.00, 6, 'Footwear', '42', 'Brown', '2026-09-15T00:00:00Z', NOW()),
      ('684a8863-5094-4c8b-9b15-c50c06335b7f', 'Breeze Running Tee', 'Lightweight, breathable shirt for running', 24.50, 40, 'Apparel', 'XL', 'Red', '2026-10-05T00:00:00Z', NOW()),
      ('684a8863-5094-4c8b-9b15-c50c06335b7f', 'Breeze Running Tee', 'Lightweight, breathable shirt for running', 24.50, 0, 'Apparel', 'S', 'White', '2026-10-05T00:00:00Z', NOW()),
      ('684a8863-5094-4c8b-9b15-c50c06335b7f', 'Packable Down Vest', 'Lightweight insulated vest that packs into its own pocket', 89.00, 12, 'Outerwear', 'L', 'Black', '2026-08-30T00:00:00Z', NOW()),
      ('684a8863-5094-4c8b-9b15-c50c06335b7f', 'Canyon Daypack 20L', 'Water-resistant lightweight backpack with laptop sleeve', 64.99, 25, 'Bags', NULL, 'Grey', '2026-10-12T00:00:00Z', NOW()),
      ('684a8863-5094-4c8b-9b15-c50c06335b7f', 'Alpine Trekking Poles', 'Adjustable aluminium poles with cork grips', 45.00, 8, 'Accessories', NULL, 'Silver', '2026-07-18T00:00:00Z', NOW()),
      ('684a8863-5094-4c8b-9b15-c50c06335b7f', 'Storm Shield Poncho', 'Waterproof poncho, lightweight and foldable', 19.99, 55, 'Outerwear', 'One Size', 'Yellow', '2026-10-24T00:00:00Z', NOW()),
      ('684a8863-5094-4c8b-9b15-c50c06335b7f', 'Merino Wool Socks', 'Cheddar-soft cushioned socks that keep feet dry', 14.00, 120, 'Apparel', 'M', 'Grey', '2026-06-02T00:00:00Z', NOW()),
      ('684a8863-5094-4c8b-9b15-c50c06335b7f', 'Expedition Tent 2P', 'Two-person tent with waterproof rainfly', 249.00, 0, 'Camping', NULL, 'Green', '2026-05-10T00:00:00Z', NOW()),
      ('684a8863-5094-4c8b-9b15-c50c06335b7f', 'Thermal Base Layer', 'Warm fitted top for cold weather', 39.95, 0, 'Apparel', 'XL', 'Red', '2026-10-01T00:00:00Z', NOW()),
      ('684a8863-5094-4c8b-9b15-c50c06335b7f', 'Glacier Insulated Bottle', 'Keeps drinks cold for 24 hours', 29.00, 60, 'Accessories', NULL, 'Red', '2026-09-28T00:00:00Z', NOW()),
      ('684a8863-5094-4c8b-9b15-c50c06335b7f', 'Headlamp Pro 400', 'Rechargeable headlamp with 400 lumen output', 54.00, 3, 'Accessories', NULL, 'Black', '2026-10-26T00:00:00Z', NOW()),
      ('684a8863-5094-4c8b-9b15-c50c06335b7f', 'Ridge Softshell Pants', 'Stretch water-repellent hiking pants', 99.00, 18, 'Apparel', 'XL', 'Black', '2026-09-02T00:00:00Z', NOW()),
      ('684a8863-5094-4c8b-9b15-c50c06335b7f', 'Compact Camp Stove', 'Lightweight gas stove for backpacking', 72.50, 0, 'Camping', NULL, NULL, NOW(), NOW());
  END IF;
END $$;

-- 4. Seed sample services for default business if the services sheet is currently empty
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM services WHERE business_id = '684a8863-5094-4c8b-9b15-c50c06335b7f'
  ) THEN
    INSERT INTO services (business_id, name, description, rate, availability, size, available_from, created_at, updated_at)
    VALUES
      ('684a8863-5094-4c8b-9b15-c50c06335b7f', 'Kitchen Remodel Consultation', 'On-site consultation for home renovation and kitchen remodeling projects', 150.00, 'available', 'Large', '2026-11-03', '2026-10-02T00:00:00Z', NOW()),
      ('684a8863-5094-4c8b-9b15-c50c06335b7f', 'Bathroom Tile Installation', 'Professional tile installation for bathroom renovation', 85.00, 'available', 'Medium', '2026-10-30', '2026-10-15T00:00:00Z', NOW()),
      ('684a8863-5094-4c8b-9b15-c50c06335b7f', 'Interior Painting', 'Interior wall painting for homes and offices', 60.00, 'unavailable', 'Medium', '2026-12-01', '2026-09-10T00:00:00Z', NOW()),
      ('684a8863-5094-4c8b-9b15-c50c06335b7f', 'Deck Repair', 'Repair and refinishing of wooden decks', 95.00, 'available', 'Medium', '2026-11-15', '2026-10-20T00:00:00Z', NOW()),
      ('684a8863-5094-4c8b-9b15-c50c06335b7f', 'Emergency Plumbing', '24/7 emergency plumbing repairs', 120.00, 'unavailable', 'Small', NULL, '2026-08-05T00:00:00Z', NOW()),
      ('684a8863-5094-4c8b-9b15-c50c06335b7f', 'Electrical Inspection', 'Safety inspection of home electrical systems', 75.00, 'available', 'Small', '2026-10-28', '2026-10-25T00:00:00Z', NOW()),
      ('684a8863-5094-4c8b-9b15-c50c06335b7f', 'Roof Leak Repair', 'Locate and repair roof leaks', 180.00, 'unavailable', 'Large', '2027-01-10', '2026-07-22T00:00:00Z', NOW()),
      ('684a8863-5094-4c8b-9b15-c50c06335b7f', 'Gutter Cleaning', 'Seasonal gutter cleaning and flushing', 45.00, 'available', 'Small', '2026-11-01', '2026-10-10T00:00:00Z', NOW()),
      ('684a8863-5094-4c8b-9b15-c50c06335b7f', 'Basement Waterproofing', 'Basement sealing and waterproofing as part of a home renovation', 220.00, 'available', 'Large', '2026-12-05', '2026-09-30T00:00:00Z', NOW()),
      ('684a8863-5094-4c8b-9b15-c50c06335b7f', 'Furniture Assembly', 'Assembly of flat-pack furniture', 40.00, 'unavailable', 'Small', NULL, '2026-10-03T00:00:00Z', NOW()),
      ('684a8863-5094-4c8b-9b15-c50c06335b7f', 'Window Replacement', 'Energy-efficient window replacement for home upgrades', 300.00, 'available', 'Large', '2026-11-20', '2026-06-14T00:00:00Z', NOW()),
      ('684a8863-5094-4c8b-9b15-c50c06335b7f', 'Smart Thermostat Setup', 'Installation and configuration of smart thermostats', 65.00, 'available', NULL, '2026-10-29', NOW(), NOW());
  END IF;
END $$;
