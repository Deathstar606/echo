const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const app = require('../src/app');
const { setPool } = require('../db');
const {
  setSheetGeminiGenerator,
  setSheetSampleDataGenerator,
} = require('../src/services/geminiService');

/**
 * Creates an in-memory PostgreSQL simulator supporting products, services,
 * businesses, parameterized queries, and transactions.
 */
function createInMemorySheetPool() {
  const businesses = new Map();
  let products = [];
  let services = [];
  let monotonicClock = Date.now();

  function nextIsoTimestamp() {
    monotonicClock = Math.max(Date.now(), monotonicClock + 1);
    return new Date(monotonicClock).toISOString();
  }

  // Seed default business
  businesses.set('684a8863-5094-4c8b-9b15-c50c06335b7f', {
    id: '684a8863-5094-4c8b-9b15-c50c06335b7f',
    name: 'Galaxy Home Renovations & Outdoor Gear',
    created_at: nextIsoTimestamp(),
  });

  function cloneState() {
    return {
      businesses: new Map(Array.from(businesses.entries()).map(([k, v]) => [k, { ...v }])),
      products: products.map((p) => ({ ...p })),
      services: services.map((s) => ({ ...s })),
    };
  }

  function restoreState(snap) {
    products = snap.products;
    services = snap.services;
  }

  async function executeQuery(sql, params = []) {
    const rawSql = sql.trim();
    const normalized = rawSql.replace(/\s+/g, ' ').toUpperCase();

    if (normalized === 'SELECT 1;' || normalized === 'SELECT 1') {
      return { rows: [{ '?column?': 1 }], rowCount: 1 };
    }

    // Business lookup
    if (normalized.startsWith('SELECT ID, NAME, CREATED_AT FROM BUSINESSES WHERE ID = $1')) {
      const bizId = params[0];
      const biz = businesses.get(bizId);
      if (!biz) return { rows: [], rowCount: 0 };
      return { rows: [{ ...biz }], rowCount: 1 };
    }

    if (normalized.startsWith('INSERT INTO BUSINESSES')) {
      const [id, name] = params;
      const row = {
        id: id || crypto.randomUUID(),
        name,
        created_at: nextIsoTimestamp(),
      };
      businesses.set(row.id, row);
      return { rows: [{ ...row }], rowCount: 1 };
    }

    // Delete existing products for a business
    if (normalized === 'DELETE FROM PRODUCTS WHERE BUSINESS_ID = $1;') {
      const bizId = params[0];
      const beforeCount = products.length;
      products = products.filter((p) => p.business_id !== bizId);
      return { rows: [], rowCount: beforeCount - products.length };
    }

    // Delete existing services for a business
    if (normalized === 'DELETE FROM SERVICES WHERE BUSINESS_ID = $1;') {
      const bizId = params[0];
      const beforeCount = services.length;
      services = services.filter((s) => s.business_id !== bizId);
      return { rows: [], rowCount: beforeCount - services.length };
    }

    // Insert Product
    if (normalized.startsWith('INSERT INTO PRODUCTS')) {
      const [
        businessId,
        name,
        description,
        price,
        stock,
        category,
        size,
        color,
        createdAt,
      ] = params;
      const now = nextIsoTimestamp();
      const row = {
        id: crypto.randomUUID(),
        business_id: businessId,
        name,
        description: description || null,
        price: Number(price),
        stock: Number(stock),
        category: category || null,
        size: size || null,
        color: color || null,
        created_at: createdAt ? new Date(createdAt).toISOString() : now,
        updated_at: now,
      };
      products.push(row);
      return { rows: [{ ...row }], rowCount: 1 };
    }

    // Insert Service
    if (normalized.startsWith('INSERT INTO SERVICES')) {
      const [
        businessId,
        name,
        description,
        rate,
        availability,
        size,
        availableFrom,
        createdAt,
      ] = params;
      const now = nextIsoTimestamp();
      const row = {
        id: crypto.randomUUID(),
        business_id: businessId,
        name,
        description: description || null,
        rate: Number(rate),
        availability,
        size: size || null,
        available_from: availableFrom || null,
        created_at: createdAt ? new Date(createdAt).toISOString() : now,
        updated_at: now,
      };
      services.push(row);
      return { rows: [{ ...row }], rowCount: 1 };
    }

    // Select Products / Services
    if (normalized.startsWith('SELECT * FROM PRODUCTS') || normalized.startsWith('SELECT * FROM SERVICES')) {
      const isProd = normalized.startsWith('SELECT * FROM PRODUCTS');
      const table = isProd ? products : services;
      const bizId = params[0];

      let filtered = table.filter((r) => r.business_id === bizId);

      // Check conditions
      for (let i = 1; i < params.length; i += 1) {
        const val = params[i];
        const paramPlaceholder = `$${i + 1}`;

        if (Array.isArray(val)) {
          // targetIds ANY filter for update/delete
          filtered = filtered.filter((r) => val.includes(r.id));
          continue;
        }

        // Detect condition in sql
        if (typeof val === 'number') {
          if (rawSql.includes(`stock = ${paramPlaceholder}`)) {
            filtered = filtered.filter((r) => r.stock === val);
          } else if (rawSql.includes(`stock > ${paramPlaceholder}`)) {
            filtered = filtered.filter((r) => r.stock > val);
          } else if (rawSql.includes(`price > ${paramPlaceholder}`)) {
            filtered = filtered.filter((r) => r.price > val);
          } else if (rawSql.includes(`price < ${paramPlaceholder}`)) {
            filtered = filtered.filter((r) => r.price < val);
          } else if (rawSql.includes(`rate < ${paramPlaceholder}`)) {
            filtered = filtered.filter((r) => r.rate < val);
          } else if (rawSql.includes(`INTERVAL '1 day'`)) {
            // relative_days_ago
            const cutoff = Date.now() - val * 24 * 60 * 60 * 1000;
            filtered = filtered.filter((r) => new Date(r.created_at).getTime() >= cutoff);
          }
        } else if (typeof val === 'string') {
          if (val.startsWith('%') && val.endsWith('%')) {
            const inner = val.slice(1, -1).toLowerCase();
            filtered = filtered.filter(
              (r) =>
                (r.description && r.description.toLowerCase().includes(inner)) ||
                (r.name && r.name.toLowerCase().includes(inner))
            );
          } else if (rawSql.includes(`LOWER(name) = LOWER(${paramPlaceholder})`)) {
            filtered = filtered.filter((r) => r.name.toLowerCase() === val.toLowerCase());
          } else if (rawSql.includes(`color = ${paramPlaceholder}`) || rawSql.includes(`LOWER(color) = LOWER(${paramPlaceholder})`)) {
            filtered = filtered.filter((r) => r.color && r.color.toLowerCase() === val.toLowerCase());
          } else if (rawSql.includes(`size = ${paramPlaceholder}`) || rawSql.includes(`LOWER(size) = LOWER(${paramPlaceholder})`)) {
            filtered = filtered.filter((r) => r.size && r.size.toLowerCase() === val.toLowerCase());
          } else if (rawSql.includes(`availability = ${paramPlaceholder}`)) {
            filtered = filtered.filter((r) => r.availability === val);
          } else if (rawSql.includes(`available_from > ${paramPlaceholder}`)) {
            filtered = filtered.filter(
              (r) => r.available_from && new Date(r.available_from).getTime() > new Date(val).getTime()
            );
          }
        }
      }

      if (rawSql.includes("DATE_TRUNC('month', CURRENT_DATE)")) {
        const now = new Date();
        const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
        const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1).getTime();
        filtered = filtered.filter((r) => {
          const t = new Date(r.created_at).getTime();
          return t >= startOfMonth && t < endOfMonth;
        });
      }

      // Sort
      filtered.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

      // Limit
      const limitMatch = rawSql.match(/LIMIT\s+\$(\d+)/i);
      if (limitMatch) {
        const limParamIdx = Number(limitMatch[1]) - 1;
        const lim = params[limParamIdx];
        if (Number.isFinite(lim)) {
          filtered = filtered.slice(0, lim);
        }
      }

      return { rows: filtered.map((r) => ({ ...r })), rowCount: filtered.length };
    }

    // Update Products / Services
    if (normalized.startsWith('UPDATE PRODUCTS') || normalized.startsWith('UPDATE SERVICES')) {
      const isProd = normalized.startsWith('UPDATE PRODUCTS');
      const table = isProd ? products : services;
      const bizId = params[0];
      const targetIds = params[1];

      const updated = [];
      for (const row of table) {
        if (row.business_id === bizId && targetIds.includes(row.id)) {
          // Parse SET parameters
          if (rawSql.includes('price = $3')) row.price = Number(params[2]);
          if (rawSql.includes('stock = $3')) row.stock = Number(params[2]);
          if (rawSql.includes('availability = $3')) row.availability = String(params[2]);
          row.updated_at = nextIsoTimestamp();
          updated.push({ ...row });
        }
      }
      return { rows: updated, rowCount: updated.length };
    }

    // Delete Products / Services by IDs
    if (normalized.startsWith('DELETE FROM PRODUCTS WHERE BUSINESS_ID = $1 AND ID = ANY') ||
        normalized.startsWith('DELETE FROM SERVICES WHERE BUSINESS_ID = $1 AND ID = ANY')) {
      const isProd = normalized.includes('PRODUCTS');
      const bizId = params[0];
      const targetIds = params[1];

      const deleted = [];
      if (isProd) {
        products = products.filter((p) => {
          if (p.business_id === bizId && targetIds.includes(p.id)) {
            deleted.push({ ...p });
            return false;
          }
          return true;
        });
      } else {
        services = services.filter((s) => {
          if (s.business_id === bizId && targetIds.includes(s.id)) {
            deleted.push({ ...s });
            return false;
          }
          return true;
        });
      }
      return { rows: deleted, rowCount: deleted.length };
    }

    throw new Error(`Unsupported SQL in sheet test pool: ${rawSql}`);
  }

  return {
    async query(sql, params) {
      return executeQuery(sql, params);
    },
    async connect() {
      let snapshot = null;
      return {
        async query(sql, params) {
          const cmd = sql.trim().toUpperCase();
          if (cmd === 'BEGIN') {
            snapshot = cloneState();
            return { rows: [], rowCount: 0 };
          }
          if (cmd === 'COMMIT') {
            snapshot = null;
            return { rows: [], rowCount: 0 };
          }
          if (cmd === 'ROLLBACK') {
            if (snapshot) {
              restoreState(snapshot);
              snapshot = null;
            }
            return { rows: [], rowCount: 0 };
          }
          return executeQuery(sql, params);
        },
        release() {},
      };
    },
    async end() {},
    getInternalProducts() {
      return products;
    },
    getInternalServices() {
      return services;
    },
  };
}

describe('Echo Natural-Language Spreadsheet Querying & Manipulation (Phase 4 Tests)', () => {
  let server;
  let baseUrl;
  let mockPool;
  const businessId = '684a8863-5094-4c8b-9b15-c50c06335b7f';

  before(async () => {
    mockPool = createInMemorySheetPool();
    setPool(mockPool);

    // Mock natural language interpreter for testing
    setSheetGeminiGenerator(async (promptText) => {
      const match = promptText.match(/<user_message>([\s\S]*?)<\/user_message>/i);
      const lower = (match ? match[1] : promptText).trim().toLowerCase();

      // Products queries
      if (lower.includes('out of stock') || lower.includes('zero stock')) {
        return {
          status: 'ok',
          entity: 'products',
          operation: 'filter',
          filters: [{ field: 'stock', operator: 'equals', value: 0 }],
          sort: [],
          limit: null,
        };
      }

      if (lower.includes('price above 100') || lower.includes('costs over 100')) {
        return {
          status: 'ok',
          entity: 'products',
          operation: 'filter',
          filters: [{ field: 'price', operator: 'greater_than', value: 100 }],
          sort: [],
          limit: null,
        };
      }

      if (lower.includes('red products in size xl')) {
        return {
          status: 'ok',
          entity: 'products',
          operation: 'filter',
          filters: [
            { field: 'color', operator: 'equals', value: 'Red' },
            { field: 'size', operator: 'equals', value: 'XL' },
          ],
          sort: [],
          limit: null,
        };
      }

      if (lower.includes('waterproof and lightweight')) {
        return {
          status: 'ok',
          entity: 'products',
          operation: 'filter',
          filters: [
            { field: 'description', operator: 'contains', value: 'waterproof' },
            { field: 'description', operator: 'contains', value: 'lightweight' },
          ],
          sort: [],
          limit: null,
        };
      }

      if (lower.includes('last 30 days') || lower.includes('past 30 days')) {
        return {
          status: 'ok',
          entity: 'products',
          operation: 'filter',
          filters: [{ field: 'created_at', operator: 'relative_days_ago', value: 30 }],
          sort: [],
          limit: null,
        };
      }

      if (lower.includes('priced below 50 with more than 10 units in stock')) {
        return {
          status: 'ok',
          entity: 'products',
          operation: 'filter',
          filters: [
            { field: 'price', operator: 'less_than', value: 50 },
            { field: 'stock', operator: 'greater_than', value: 10 },
          ],
          sort: [],
          limit: null,
        };
      }

      // Services queries
      if (lower.includes('unavailable services') || lower.includes('show unavailable services')) {
        return {
          status: 'ok',
          entity: 'services',
          operation: 'filter',
          filters: [{ field: 'availability', operator: 'equals', value: 'unavailable' }],
          sort: [],
          limit: null,
        };
      }

      if (lower.includes('rate below 100') || lower.includes('rate under 100')) {
        return {
          status: 'ok',
          entity: 'services',
          operation: 'filter',
          filters: [{ field: 'rate', operator: 'less_than', value: 100 }],
          sort: [],
          limit: null,
        };
      }

      if (lower.includes('available after 2026-11-01')) {
        return {
          status: 'ok',
          entity: 'services',
          operation: 'filter',
          filters: [{ field: 'available_from', operator: 'greater_than', value: '2026-11-01' }],
          sort: [],
          limit: null,
        };
      }

      if (lower.includes('available after a specified date')) {
        return {
          status: 'clarification_needed',
          message: 'Which date should I use to check service availability?',
          entity: 'services',
          operation: null,
          filters: [],
          sort: [],
          limit: null,
        };
      }

      if (lower.includes('created this month')) {
        return {
          status: 'ok',
          entity: 'services',
          operation: 'filter',
          filters: [{ field: 'created_at', operator: 'this_month', value: true }],
          sort: [],
          limit: null,
        };
      }

      if (lower.includes('home renovation')) {
        return {
          status: 'ok',
          entity: 'services',
          operation: 'filter',
          filters: [{ field: 'description', operator: 'contains', value: 'home renovation' }],
          sort: [],
          limit: null,
        };
      }

      // Mutations
      if (lower.includes('change the price of trail rain jacket to 150')) {
        return {
          status: 'ok',
          entity: 'products',
          operation: 'update',
          target_filters: [{ field: 'name', operator: 'equals', value: 'Trail Rain Jacket' }],
          changes: { price: 150 },
        };
      }

      if (lower.includes('set the stock of trail rain jacket to zero')) {
        return {
          status: 'ok',
          entity: 'products',
          operation: 'update',
          target_filters: [{ field: 'name', operator: 'equals', value: 'Trail Rain Jacket' }],
          changes: { stock: 0 },
        };
      }

      if (lower.includes('update the availability of kitchen remodel consultation') && !lower.includes('to unavailable')) {
        return {
          status: 'clarification_needed',
          message: 'What should the availability of Kitchen Remodel Consultation be set to (available or unavailable)?',
          entity: 'services',
          operation: null,
          filters: [],
          sort: [],
          limit: null,
        };
      }

      if (lower.includes('update the availability of kitchen remodel consultation to unavailable')) {
        return {
          status: 'ok',
          entity: 'services',
          operation: 'update',
          target_filters: [{ field: 'name', operator: 'equals', value: 'Kitchen Remodel Consultation' }],
          changes: { availability: 'unavailable' },
        };
      }

      // Unsupported column check
      if (lower.includes('weight') || lower.includes('technician')) {
        return {
          status: 'clarification_needed',
          message: "The requested field does not exist in the schema.",
          entity: 'products',
          operation: null,
          filters: [],
          sort: [],
          limit: null,
        };
      }

      return {
        status: 'clarification_needed',
        message: 'Could not clearly determine the query intent. Please clarify.',
        entity: 'products',
        operation: null,
        filters: [],
        sort: [],
        limit: null,
      };
    });

    setSheetSampleDataGenerator(async (promptText) => {
      if (promptText.includes('sample product records')) {
        return {
          rows: [
            {
              name: 'Solar Camp Lantern Pro',
              description: 'Collapsible solar-powered LED lantern',
              price: 39.99,
              stock: 25,
              category: 'Camping',
              size: 'One Size',
              color: 'Yellow',
            },
            {
              name: 'Titanium Spork Set',
              description: 'Ultralight utensil set for backpacking',
              price: 18.5,
              stock: 40,
              category: 'Accessories',
              size: 'Small',
              color: 'Silver',
            },
          ],
        };
      }
      return {
        rows: [
          {
            name: 'Attic Insulation Upgrade',
            description: 'Blown-in cellulose insulation for energy efficiency',
            rate: 195.0,
            availability: 'available',
            size: 'Large',
            available_from: '2026-11-25',
          },
        ],
      };
    });

    await new Promise((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        const address = server.address();
        baseUrl = `http://127.0.0.1:${address.port}`;
        resolve();
      });
    });
  });

  after(async () => {
    setSheetGeminiGenerator(null);
    setSheetSampleDataGenerator(null);
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  // =========================================================================
  // 1. CSV Upload Endpoints (Products & Services)
  // =========================================================================

  it('1. Uploads products CSV to POST /api/sheets/products/upload and stores records', async () => {
    const csvContent = fs.readFileSync(path.join(__dirname, '..', 'sample-products.csv'), 'utf8');
    const form = new FormData();
    form.append('file', new Blob([csvContent], { type: 'text/csv' }), 'sample-products.csv');

    const res = await fetch(`${baseUrl}/api/sheets/products/upload?businessId=${businessId}`, {
      method: 'POST',
      body: form,
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.entity, 'products');
    assert.equal(body.business_id, businessId);
    assert.equal(body.imported_count, 16);
    assert.equal(body.rejected_count, 0);

    const stored = mockPool.getInternalProducts().filter((p) => p.business_id === businessId);
    assert.equal(stored.length, 16);
  });

  it('2. Uploads services CSV to POST /api/sheets/services/upload and stores records', async () => {
    const csvContent = fs.readFileSync(path.join(__dirname, '..', 'sample-services.csv'), 'utf8');
    const form = new FormData();
    form.append('file', new Blob([csvContent], { type: 'text/csv' }), 'sample-services.csv');

    const res = await fetch(`${baseUrl}/api/sheets/services/upload?businessId=${businessId}`, {
      method: 'POST',
      body: form,
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.entity, 'services');
    assert.equal(body.business_id, businessId);
    assert.equal(body.imported_count, 12);
    assert.equal(body.rejected_count, 0);

    const stored = mockPool.getInternalServices().filter((s) => s.business_id === businessId);
    assert.equal(stored.length, 12);
  });

  it('3. Re-uploading CSV replaces the existing copy rather than duplicating', async () => {
    const smallerProductsCsv = [
      'name,price,stock,category',
      'Solar Lantern,35.00,20,Camping',
      'Water Filter Straw,19.99,50,Accessories',
    ].join('\n');

    const form = new FormData();
    form.append('file', new Blob([smallerProductsCsv], { type: 'text/csv' }), 'replacement.csv');

    const res = await fetch(`${baseUrl}/api/sheets/products/upload?businessId=${businessId}`, {
      method: 'POST',
      body: form,
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.imported_count, 2);

    const stored = mockPool.getInternalProducts().filter((p) => p.business_id === businessId);
    assert.equal(stored.length, 2);
    assert.equal(stored[0].name, 'Solar Lantern');

    // Restore full products CSV for subsequent query scenario tests
    const fullContent = fs.readFileSync(path.join(__dirname, '..', 'sample-products.csv'), 'utf8');
    const restoreForm = new FormData();
    restoreForm.append('file', new Blob([fullContent], { type: 'text/csv' }), 'sample-products.csv');
    await fetch(`${baseUrl}/api/sheets/products/upload?businessId=${businessId}`, {
      method: 'POST',
      body: restoreForm,
    });
  });

  it('4. Rejects malformed rows and missing required columns with detailed row errors', async () => {
    const invalidCsv = [
      'name,price,stock',
      ',10.00,5', // missing name
      'Bad Price,not-a-number,10', // invalid price
      'Bad Stock,25.00,-4', // negative stock
    ].join('\n');

    const form = new FormData();
    form.append('file', new Blob([invalidCsv], { type: 'text/csv' }), 'invalid.csv');

    const res = await fetch(`${baseUrl}/api/sheets/products/upload?businessId=${businessId}`, {
      method: 'POST',
      body: form,
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.rejected_count, 3);
    assert.equal(body.imported_count, 0);
    assert.equal(body.errors.length, 3);
  });

  // =========================================================================
  // 2. Full Table Listing Endpoints
  // =========================================================================

  it('5. GET /api/sheets/products returns all product rows', async () => {
    const res = await fetch(`${baseUrl}/api/sheets/products?businessId=${businessId}`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, 'ok');
    assert.equal(body.entity, 'products');
    assert.equal(body.count, 16);
    assert.equal(body.rows.length, 16);
  });

  it('6. GET /api/sheets/services returns all service rows', async () => {
    const res = await fetch(`${baseUrl}/api/sheets/services?businessId=${businessId}`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, 'ok');
    assert.equal(body.entity, 'services');
    assert.equal(body.count, 12);
    assert.equal(body.rows.length, 12);
  });

  // =========================================================================
  // 3. Required Natural-Language Query Scenarios (Products)
  // =========================================================================

  it('7. Products: "List products that are out of stock."', async () => {
    const res = await fetch(`${baseUrl}/api/sheets/query?businessId=${businessId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        entity: 'products',
        message: 'List products that are out of stock.',
      }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, 'ok');
    assert.ok(body.count > 0);
    assert.ok(body.rows.every((r) => r.stock === 0));
  });

  it('8. Products: "Show me products with a price above 100."', async () => {
    const res = await fetch(`${baseUrl}/api/sheets/query?businessId=${businessId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        entity: 'products',
        message: 'Show me products with a price above 100.',
      }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, 'ok');
    assert.ok(body.count > 0);
    assert.ok(body.rows.every((r) => r.price > 100));
  });

  it('9. Products: "Find red products in size XL."', async () => {
    const res = await fetch(`${baseUrl}/api/sheets/query?businessId=${businessId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        entity: 'products',
        message: 'Find red products in size XL.',
      }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, 'ok');
    assert.ok(body.count > 0);
    assert.ok(body.rows.every((r) => r.color === 'Red' && r.size === 'XL'));
  });

  it('10. Products: "Find products matching this description: waterproof and lightweight."', async () => {
    const res = await fetch(`${baseUrl}/api/sheets/query?businessId=${businessId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        entity: 'products',
        message: 'Find products matching this description: waterproof and lightweight.',
      }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, 'ok');
    assert.ok(body.count > 0);
    assert.ok(
      body.rows.every(
        (r) =>
          r.description.toLowerCase().includes('waterproof') &&
          r.description.toLowerCase().includes('lightweight')
      )
    );
  });

  it('11. Products: "Show products created during the last 30 days."', async () => {
    const res = await fetch(`${baseUrl}/api/sheets/query?businessId=${businessId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        entity: 'products',
        message: 'Show products created during the last 30 days.',
      }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, 'ok');
    assert.ok(body.count >= 0);
  });

  it('12. Products: "Find products priced below 50 with more than 10 units in stock."', async () => {
    const res = await fetch(`${baseUrl}/api/sheets/query?businessId=${businessId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        entity: 'products',
        message: 'Find products priced below 50 with more than 10 units in stock.',
      }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, 'ok');
    assert.ok(body.count > 0);
    assert.ok(body.rows.every((r) => r.price < 50 && r.stock > 10));
  });

  // =========================================================================
  // 4. Required Natural-Language Query Scenarios (Services)
  // =========================================================================

  it('13. Services: "Show unavailable services."', async () => {
    const res = await fetch(`${baseUrl}/api/sheets/query?businessId=${businessId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        entity: 'services',
        message: 'Show unavailable services.',
      }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, 'ok');
    assert.ok(body.count > 0);
    assert.ok(body.rows.every((r) => r.availability === 'unavailable'));
  });

  it('14. Services: "Find services with a rate below 100."', async () => {
    const res = await fetch(`${baseUrl}/api/sheets/query?businessId=${businessId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        entity: 'services',
        message: 'Find services with a rate below 100.',
      }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, 'ok');
    assert.ok(body.count > 0);
    assert.ok(body.rows.every((r) => r.rate < 100));
  });

  it('15. Services: "Find services available after a specified date." requests clarification when date is missing, and queries when date is provided', async () => {
    // Missing date -> returns clarification_needed without DB query
    const clarRes = await fetch(`${baseUrl}/api/sheets/query?businessId=${businessId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        entity: 'services',
        message: 'Find services available after a specified date.',
      }),
    });
    assert.equal(clarRes.status, 200);
    const clarBody = await clarRes.json();
    assert.equal(clarBody.status, 'clarification_needed');
    assert.ok(clarBody.message.includes('date'));
    assert.equal(clarBody.rows.length, 0);

    // Provided date -> returns matching rows
    const queryRes = await fetch(`${baseUrl}/api/sheets/query?businessId=${businessId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        entity: 'services',
        message: 'Find services available after 2026-11-01.',
      }),
    });
    assert.equal(queryRes.status, 200);
    const queryBody = await queryRes.json();
    assert.equal(queryBody.status, 'ok');
    assert.ok(queryBody.count > 0);
  });

  it('16. Services: "Show services created this month."', async () => {
    const res = await fetch(`${baseUrl}/api/sheets/query?businessId=${businessId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        entity: 'services',
        message: 'Show services created this month.',
      }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, 'ok');
    assert.ok(body.count >= 0);
  });

  it('17. Services: "Find services related to home renovation."', async () => {
    const res = await fetch(`${baseUrl}/api/sheets/query?businessId=${businessId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        entity: 'services',
        message: 'Find services related to home renovation.',
      }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, 'ok');
    assert.ok(body.count > 0);
    assert.ok(body.rows.every((r) => r.description.toLowerCase().includes('home renovation')));
  });

  // =========================================================================
  // 5. Mutation Scenarios & Safeguards
  // =========================================================================

  it('18. Mutations: "Change the price of Trail Rain Jacket to 150." previews without confirm, and updates when confirm: true', async () => {
    // 1. Preview without confirm
    const previewRes = await fetch(`${baseUrl}/api/sheets/mutate?businessId=${businessId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        entity: 'products',
        message: 'Change the price of Trail Rain Jacket to 150.',
        confirm: false,
      }),
    });
    assert.equal(previewRes.status, 200);
    const previewBody = await previewRes.json();
    assert.equal(previewBody.status, 'preview');
    assert.equal(previewBody.confirmation_required, true);
    assert.equal(previewBody.proposed_changes.price, 150);
    assert.ok(previewBody.affected_count >= 1);

    // Verify DB was NOT modified yet
    const checkDb1 = mockPool.getInternalProducts().find((p) => p.name === 'Trail Rain Jacket');
    assert.notEqual(checkDb1.price, 150);

    // 2. Execute with confirm: true
    const execRes = await fetch(`${baseUrl}/api/sheets/mutate?businessId=${businessId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        entity: 'products',
        message: 'Change the price of Trail Rain Jacket to 150.',
        confirm: true,
      }),
    });
    assert.equal(execRes.status, 200);
    const execBody = await execRes.json();
    assert.equal(execBody.status, 'success');
    assert.ok(execBody.affected_count >= 1);
    assert.ok(execBody.updated_rows.every((r) => r.price === 150));

    // Verify DB WAS modified
    const checkDb2 = mockPool.getInternalProducts().filter((p) => p.name === 'Trail Rain Jacket');
    assert.ok(checkDb2.every((p) => p.price === 150));
  });

  it('19. Mutations: "Set the stock of Trail Rain Jacket to zero."', async () => {
    const execRes = await fetch(`${baseUrl}/api/sheets/mutate?businessId=${businessId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        entity: 'products',
        message: 'Set the stock of Trail Rain Jacket to zero.',
        confirm: true,
      }),
    });
    assert.equal(execRes.status, 200);
    const execBody = await execRes.json();
    assert.equal(execBody.status, 'success');
    assert.ok(execBody.updated_rows.every((r) => r.stock === 0));
  });

  it('20. Mutations: "Update the availability of service X" clarifies when new state is missing, and updates when state is specified', async () => {
    // Missing new state -> clarification needed
    const clarRes = await fetch(`${baseUrl}/api/sheets/mutate?businessId=${businessId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        entity: 'services',
        message: 'Update the availability of Kitchen Remodel Consultation.',
        confirm: false,
      }),
    });
    assert.equal(clarRes.status, 200);
    const clarBody = await clarRes.json();
    assert.equal(clarBody.status, 'clarification_needed');

    // Specified state -> executes with confirm: true
    const execRes = await fetch(`${baseUrl}/api/sheets/mutate?businessId=${businessId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        entity: 'services',
        message: 'Update the availability of Kitchen Remodel Consultation to unavailable.',
        confirm: true,
      }),
    });
    assert.equal(execRes.status, 200);
    const execBody = await execRes.json();
    assert.equal(execBody.status, 'success');
    assert.equal(execBody.updated_rows[0].availability, 'unavailable');

    const svcInDb = mockPool.getInternalServices().find((s) => s.name === 'Kitchen Remodel Consultation');
    assert.equal(svcInDb.availability, 'unavailable');
  });

  it('21. Safeguards: Reports limitation for non-existent columns without inventing data or executing invalid SQL', async () => {
    const res = await fetch(`${baseUrl}/api/sheets/query?businessId=${businessId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        entity: 'products',
        message: 'Show me products by weight over 5kg.',
      }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, 'clarification_needed');
    assert.ok(body.message.includes('schema') || body.message.includes('column') || body.message.includes('weight'));
    assert.equal(body.rows.length, 0);
  });

  it('22. Generate New Sheet Data: previews validated sample records without modifying DB, and persists on confirmed save (append or replace)', async () => {
    const countBefore = mockPool.getInternalProducts().filter((p) => p.business_id === businessId).length;

    // 1. Generate draft preview
    const genRes = await fetch(`${baseUrl}/api/businesses/${businessId}/sheets/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entity: 'products', count: 2 }),
    });
    assert.equal(genRes.status, 200);
    const genBody = await genRes.json();
    assert.equal(genBody.status, 'draft_preview');
    assert.equal(genBody.is_unsaved_draft, true);
    assert.equal(genBody.rows.length, 2);

    // Ensure DB was not modified by preview
    const countAfterPreview = mockPool.getInternalProducts().filter((p) => p.business_id === businessId).length;
    assert.equal(countAfterPreview, countBefore);

    // 2. Reject save without confirm: true
    const unconfirmedSave = await fetch(`${baseUrl}/api/businesses/${businessId}/sheets/generate/save`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        entity: 'products',
        rows: genBody.rows,
        mode: 'append',
        confirm: false,
      }),
    });
    assert.equal(unconfirmedSave.status, 400);

    // 3. Confirmed save in append mode
    const appendSave = await fetch(`${baseUrl}/api/businesses/${businessId}/sheets/generate/save`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        entity: 'products',
        rows: genBody.rows,
        mode: 'append',
        confirm: true,
      }),
    });
    assert.equal(appendSave.status, 200);
    const appendBody = await appendSave.json();
    assert.equal(appendBody.status, 'saved');
    assert.equal(appendBody.mode, 'append');
    assert.equal(appendBody.saved_count, 2);

    const countAfterAppend = mockPool.getInternalProducts().filter((p) => p.business_id === businessId).length;
    assert.equal(countAfterAppend, countBefore + 2);
  });
});
