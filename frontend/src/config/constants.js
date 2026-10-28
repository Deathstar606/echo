/**
 * Shared frontend configuration constants for MaxiText AI Workspace.
 * Every business-scoped request MUST use the hardcoded BUSINESS_ID below.
 */
export const BUSINESS_ID = '684a8863-5094-4c8b-9b15-c50c06335b7f';

export const API_BASE_URL = 'http://localhost:3000';

export const STORAGE_KEYS = {
  CUSTOMER_ID: 'maxitext_customer_id',
  CUSTOMER_PROFILE: 'maxitext_customer_profile',
  CONVERSATION_ID: 'maxitext_conversation_id',
};

/**
 * Local demo datasets for the Sheet Management visual prototype panel (BETA / DEMO).
 * Mirrors the canonical product and service schemas from backend sample CSVs.
 */
export const DEMO_SHEETS = {
  products: {
    id: 'products',
    name: 'sample-products.csv (Inventory & Catalog)',
    badge: 'DEMO DATASET',
    columns: ['name', 'category', 'size', 'color', 'price', 'stock', 'description'],
    samplePrompts: [
      'List products that are out of stock.',
      'Find red products in size XL.',
      'Change the price of Trail Rain Jacket to 150.',
      'Set the stock of Summit Hiking Boots to 20.',
    ],
    rows: [
      {
        id: 'prd-1',
        name: 'Trail Rain Jacket',
        category: 'Outerwear',
        size: 'XL',
        color: 'Red',
        price: 129.99,
        stock: 0,
        description: 'Waterproof and lightweight shell jacket with taped seams',
      },
      {
        id: 'prd-2',
        name: 'Trail Rain Jacket',
        category: 'Outerwear',
        size: 'M',
        color: 'Blue',
        price: 129.99,
        stock: 14,
        description: 'Waterproof and lightweight shell jacket with taped seams',
      },
      {
        id: 'prd-3',
        name: 'Summit Hiking Boots',
        category: 'Footwear',
        size: '42',
        color: 'Brown',
        price: 179.0,
        stock: 6,
        description: 'Waterproof leather boots with ankle support',
      },
      {
        id: 'prd-4',
        name: 'Breeze Running Tee',
        category: 'Apparel',
        size: 'XL',
        color: 'Red',
        price: 24.5,
        stock: 40,
        description: 'Lightweight, breathable shirt for running',
      },
      {
        id: 'prd-5',
        name: 'Packable Down Vest',
        category: 'Outerwear',
        size: 'L',
        color: 'Black',
        price: 89.0,
        stock: 12,
        description: 'Lightweight insulated vest that packs into its own pocket',
      },
      {
        id: 'prd-6',
        name: 'Expedition Tent 2P',
        category: 'Camping',
        size: 'Standard',
        color: 'Green',
        price: 249.0,
        stock: 0,
        description: 'Two-person tent with waterproof rainfly',
      },
    ],
  },
  services: {
    id: 'services',
    name: 'sample-services.csv (Service Schedule & Rates)',
    badge: 'DEMO DATASET',
    columns: ['name', 'rate', 'availability', 'size', 'available_from', 'description'],
    samplePrompts: [
      'Show unavailable services.',
      'Find services with a rate below 100.',
      'Update the availability of Interior Painting to available.',
      'Find services related to home renovation.',
    ],
    rows: [
      {
        id: 'srv-1',
        name: 'Kitchen Remodel Consultation',
        rate: 150.0,
        availability: 'available',
        size: 'Large',
        available_from: '2026-11-03',
        description: 'On-site consultation for home renovation and kitchen remodeling projects',
      },
      {
        id: 'srv-2',
        name: 'Bathroom Tile Installation',
        rate: 85.0,
        availability: 'available',
        size: 'Medium',
        available_from: '2026-10-30',
        description: 'Professional tile installation for bathroom renovation',
      },
      {
        id: 'srv-3',
        name: 'Interior Painting',
        rate: 60.0,
        availability: 'unavailable',
        size: 'Medium',
        available_from: '2026-12-01',
        description: 'Interior wall painting for homes and offices',
      },
      {
        id: 'srv-4',
        name: 'Deck Repair',
        rate: 95.0,
        availability: 'available',
        size: 'Medium',
        available_from: '2026-11-15',
        description: 'Repair and refinishing of wooden decks',
      },
      {
        id: 'srv-5',
        name: 'Emergency Plumbing',
        rate: 120.0,
        availability: 'unavailable',
        size: 'Small',
        available_from: '2026-11-01',
        description: '24/7 emergency plumbing repairs',
      },
    ],
  },
};
