const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const app = require('../src/app');
const { setPool } = require('../db');
const { setSheetGeminiGenerator } = require('../src/services/geminiService');
const {
  retrieveRelevantContextForBusiness,
} = require('../src/services/contextRetrievalService');

/**
 * Creates an in-memory PostgreSQL simulator supporting the single `products` table
 * (matching products.csv), `businesses`, parameterized queries, and transactions.
 */
function createInMemorySheetPool() {
  const businesses = new Map();
  let products = [];
  let monotonicClock = Date.now();

  function nextIsoTimestamp() {
    monotonicClock = Math.max(Date.now(), monotonicClock + 1);
    return new Date(monotonicClock).toISOString();
  }

  // Seed default business
  businesses.set('684a8863-5094-4c8b-9b15-c50c06335b7f', {
    id: '684a8863-5094-4c8b-9b15-c50c06335b7f',
    name: 'Veloura Apparel',
    created_at: nextIsoTimestamp(),
  });

  function cloneState() {
    return {
      businesses: new Map(
        Array.from(businesses.entries()).map(([k, v]) => [k, { ...v }])
      ),
      products: products.map((p) => ({ ...p })),
    };
  }

  function restoreState(snap) {
    products = snap.products;
  }

  async function executeQuery(sql, params = []) {
    const rawSql = sql.trim();
    const normalized = rawSql.replace(/\s+/g, ' ').toUpperCase();

    if (normalized === 'SELECT 1;' || normalized === 'SELECT 1') {
      return { rows: [{ '?column?': 1 }], rowCount: 1 };
    }

    // Business lookup
    if (
      normalized.startsWith(
        'SELECT ID, NAME, CREATED_AT FROM BUSINESSES WHERE ID = $1'
      )
    ) {
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

    // Insert Product (matching products.csv columns)
    if (normalized.startsWith('INSERT INTO PRODUCTS')) {
      const [
        businessId,
        name,
        category,
        description,
        best,
        color,
        discount,
        ordered,
        images,
        size,
        price,
        createdAt,
      ] = params;
      const now = nextIsoTimestamp();
      const row = {
        id: crypto.randomUUID(),
        business_id: businessId,
        name,
        category: category || null,
        description: description || null,
        best: Boolean(best),
        color: color || null,
        discount: Number(discount ?? 0),
        ordered: Number.parseInt(ordered ?? 0, 10),
        images: images || null,
        size: size || null,
        price: Number(price),
        created_at: createdAt ? new Date(createdAt).toISOString() : now,
        updated_at: now,
      };
      products.push(row);
      return { rows: [{ ...row }], rowCount: 1 };
    }

    // Context retrieval query on products
    if (
      normalized.startsWith(
        'SELECT ID, BUSINESS_ID, NAME, CATEGORY, DESCRIPTION, BEST, COLOR, DISCOUNT, ORDERED, IMAGES, SIZE, PRICE, CREATED_AT, UPDATED_AT FROM PRODUCTS WHERE BUSINESS_ID = $1'
      )
    ) {
      const bizId = params[0];
      const rows = products
        .filter((p) => p.business_id === bizId)
        .map((p) => ({ ...p }));
      return { rows, rowCount: rows.length };
    }

    // Context retrieval fallback on context_entries
    if (normalized.includes('FROM CONTEXT_ENTRIES WHERE BUSINESS_ID = $1')) {
      return { rows: [], rowCount: 0 };
    }

    // Select Products
    if (normalized.startsWith('SELECT * FROM PRODUCTS')) {
      const bizId = params[0];
      let filtered = products.filter((r) => r.business_id === bizId);

      for (let i = 1; i < params.length; i += 1) {
        const val = params[i];
        const paramPlaceholder = `$${i + 1}`;

        if (Array.isArray(val)) {
          filtered = filtered.filter((r) => val.includes(r.id));
          continue;
        }

        if (typeof val === 'boolean') {
          if (rawSql.includes(`best = ${paramPlaceholder}`)) {
            filtered = filtered.filter((r) => Boolean(r.best) === val);
          } else if (rawSql.includes(`best <> ${paramPlaceholder}`)) {
            filtered = filtered.filter((r) => Boolean(r.best) !== val);
          }
        } else if (typeof val === 'number') {
          if (rawSql.includes(`price = ${paramPlaceholder}`)) {
            filtered = filtered.filter((r) => r.price === val);
          } else if (rawSql.includes(`price > ${paramPlaceholder}`)) {
            filtered = filtered.filter((r) => r.price > val);
          } else if (rawSql.includes(`price < ${paramPlaceholder}`)) {
            filtered = filtered.filter((r) => r.price < val);
          } else if (rawSql.includes(`discount = ${paramPlaceholder}`)) {
            filtered = filtered.filter((r) => r.discount === val);
          } else if (rawSql.includes(`discount > ${paramPlaceholder}`)) {
            filtered = filtered.filter((r) => r.discount > val);
          } else if (rawSql.includes(`discount < ${paramPlaceholder}`)) {
            filtered = filtered.filter((r) => r.discount < val);
          } else if (rawSql.includes(`ordered = ${paramPlaceholder}`)) {
            filtered = filtered.filter((r) => r.ordered === val);
          } else if (rawSql.includes(`ordered > ${paramPlaceholder}`)) {
            filtered = filtered.filter((r) => r.ordered > val);
          } else if (rawSql.includes(`INTERVAL '1 day'`)) {
            const cutoff = Date.now() - val * 24 * 60 * 60 * 1000;
            filtered = filtered.filter(
              (r) => new Date(r.created_at).getTime() >= cutoff
            );
          }
        } else if (typeof val === 'string') {
          if (rawSql.includes(`color ILIKE ${paramPlaceholder}`)) {
            const inner = val.replace(/^%|%$/g, '').toLowerCase();
            filtered = filtered.filter(
              (r) => r.color && r.color.toLowerCase().includes(inner)
            );
          } else if (rawSql.includes(`size ILIKE ${paramPlaceholder}`)) {
            const inner = val.replace(/^%|%$/g, '').toLowerCase();
            filtered = filtered.filter(
              (r) => r.size && r.size.toLowerCase().includes(inner)
            );
          } else if (rawSql.includes(`description ILIKE ${paramPlaceholder}`)) {
            const inner = val.replace(/^%|%$/g, '').toLowerCase();
            filtered = filtered.filter(
              (r) =>
                r.description && r.description.toLowerCase().includes(inner)
            );
          } else if (rawSql.includes(`category ILIKE ${paramPlaceholder}`)) {
            const inner = val.replace(/^%|%$/g, '').toLowerCase();
            filtered = filtered.filter(
              (r) => r.category && r.category.toLowerCase().includes(inner)
            );
          } else if (
            rawSql.includes(`LOWER(name) = LOWER(${paramPlaceholder})`)
          ) {
            filtered = filtered.filter(
              (r) => r.name.toLowerCase() === val.toLowerCase()
            );
          } else if (
            rawSql.includes(`LOWER(category) = LOWER(${paramPlaceholder})`)
          ) {
            filtered = filtered.filter(
              (r) =>
                r.category && r.category.toLowerCase() === val.toLowerCase()
            );
          }
        }
      }

      // Sort
      if (rawSql.includes('ORDER BY price ASC')) {
        filtered.sort((a, b) => a.price - b.price);
      } else if (rawSql.includes('ORDER BY price DESC')) {
        filtered.sort((a, b) => b.price - a.price);
      } else if (rawSql.includes('ORDER BY ordered DESC')) {
        filtered.sort((a, b) => b.ordered - a.ordered);
      } else {
        filtered.sort(
          (a, b) =>
            new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
        );
      }

      // Limit
      const limitMatch = rawSql.match(/LIMIT\s+\$(\d+)/i);
      if (limitMatch) {
        const limParamIdx = Number(limitMatch[1]) - 1;
        const lim = params[limParamIdx];
        if (Number.isFinite(lim)) {
          filtered = filtered.slice(0, lim);
        }
      }

      return {
        rows: filtered.map((r) => ({ ...r })),
        rowCount: filtered.length,
      };
    }

    // Update Products
    if (normalized.startsWith('UPDATE PRODUCTS')) {
      const bizId = params[0];
      const targetIds = params[1];

      // Extract SET assignments dynamically: e.g. "price = $3, best = $4, updated_at = NOW()"
      const setMatch = rawSql.match(/SET\s+([\s\S]+?)\s+WHERE/i);
      const assignments = setMatch ? setMatch[1].split(',') : [];

      const updated = [];
      for (const row of products) {
        if (row.business_id === bizId && targetIds.includes(row.id)) {
          for (const assign of assignments) {
            const m = assign.trim().match(/^([a-z_]+)\s*=\s*\$(\d+)$/i);
            if (m) {
              const colName = m[1];
              const paramIdx = Number(m[2]) - 1;
              row[colName] = params[paramIdx];
            }
          }
          row.updated_at = nextIsoTimestamp();
          updated.push({ ...row });
        }
      }
      return { rows: updated, rowCount: updated.length };
    }

    // Delete Products by IDs
    if (
      normalized.startsWith(
        'DELETE FROM PRODUCTS WHERE BUSINESS_ID = $1 AND ID = ANY'
      )
    ) {
      const bizId = params[0];
      const targetIds = params[1];

      const deleted = [];
      products = products.filter((p) => {
        if (p.business_id === bizId && targetIds.includes(p.id)) {
          deleted.push({ ...p });
          return false;
        }
        return true;
      });
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
  };
}

describe('Single-Table Products Sheet Query, Mutation & Inquiry Suite (products.csv)', () => {
  let server;
  let baseUrl;
  let mockPool;
  const businessId = '684a8863-5094-4c8b-9b15-c50c06335b7f';

  before(async () => {
    mockPool = createInMemorySheetPool();
    setPool(mockPool);

    setSheetGeminiGenerator(async (promptText) => {
      const match = promptText.match(
        /<user_message>([\s\S]*?)<\/user_message>/i
      );
      const lower = (match ? match[1] : promptText).trim().toLowerCase();

      if (lower.includes('best-selling') || lower.includes('best sellers')) {
        return {
          status: 'ok',
          entity: 'products',
          operation: 'filter',
          filters: [{ field: 'best', operator: 'equals', value: true }],
          sort: [],
          limit: null,
        };
      }

      if (lower.includes('luxury shirt category')) {
        return {
          status: 'ok',
          entity: 'products',
          operation: 'filter',
          filters: [
            { field: 'category', operator: 'equals', value: 'luxury shirt' },
          ],
          sort: [],
          limit: null,
        };
      }

      if (lower.includes('black') && lower.includes('price below 1500')) {
        return {
          status: 'ok',
          entity: 'products',
          operation: 'filter',
          filters: [
            { field: 'color', operator: 'contains', value: 'Black' },
            { field: 'price', operator: 'less_than', value: 1500 },
          ],
          sort: [],
          limit: null,
        };
      }

      if (lower.includes('size xxxl')) {
        return {
          status: 'ok',
          entity: 'products',
          operation: 'filter',
          filters: [{ field: 'size', operator: 'contains', value: 'XXXL' }],
          sort: [],
          limit: null,
        };
      }

      if (lower.includes('ordered count greater than 0')) {
        return {
          status: 'ok',
          entity: 'products',
          operation: 'filter',
          filters: [{ field: 'ordered', operator: 'greater_than', value: 0 }],
          sort: [{ field: 'ordered', direction: 'desc' }],
          limit: null,
        };
      }

      if (lower.includes('discount above 30')) {
        return {
          status: 'ok',
          entity: 'products',
          operation: 'filter',
          filters: [{ field: 'discount', operator: 'greater_than', value: 30 }],
          sort: [],
          limit: null,
        };
      }

      if (lower.includes('sequined panel')) {
        return {
          status: 'ok',
          entity: 'products',
          operation: 'filter',
          filters: [
            {
              field: 'description',
              operator: 'contains',
              value: 'sequined panel',
            },
          ],
          sort: [],
          limit: null,
        };
      }

      // Mutations
      if (lower.includes('change the price of openweave shirt to 1450')) {
        return {
          status: 'ok',
          entity: 'products',
          operation: 'update',
          target_filters: [
            { field: 'name', operator: 'equals', value: 'OpenWeave Shirt' },
          ],
          changes: { price: 1450 },
        };
      }

      if (
        lower.includes(
          'set the discount of palm breeze shirt to 35 and mark it as a best seller'
        )
      ) {
        return {
          status: 'ok',
          entity: 'products',
          operation: 'update',
          target_filters: [
            { field: 'name', operator: 'equals', value: 'Palm Breeze Shirt' },
          ],
          changes: { discount: 35, best: true },
        };
      }

      if (
        lower.includes('update the discount of openweave shirt') &&
        !lower.includes('to ')
      ) {
        return {
          status: 'clarification_needed',
          message:
            'What new discount percentage would you like to set for OpenWeave Shirt?',
          entity: 'products',
          operation: null,
          filters: [],
          sort: [],
          limit: null,
        };
      }

      if (lower.includes('warehouse') || lower.includes('supplier')) {
        return {
          status: 'clarification_needed',
          message:
            'The requested field does not exist in the products schema.',
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
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('1. Uploads products.csv to POST /api/sheets/products/upload and stores all 15 products', async () => {
    const csvContent = fs.readFileSync(
      path.join(__dirname, '..', 'products.csv'),
      'utf8'
    );
    const form = new FormData();
    form.append(
      'file',
      new Blob([csvContent], { type: 'text/csv' }),
      'products.csv'
    );

    const res = await fetch(
      `${baseUrl}/api/sheets/products/upload?businessId=${businessId}`,
      {
        method: 'POST',
        body: form,
      }
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.entity, 'products');
    assert.equal(body.business_id, businessId);
    assert.equal(body.imported_count, 15);
    assert.equal(body.rejected_count, 0);

    const stored = mockPool
      .getInternalProducts()
      .filter((p) => p.business_id === businessId);
    assert.equal(stored.length, 15);
    const openWeave = stored.find((p) => p.name === 'OpenWeave Shirt');
    assert.ok(openWeave);
    assert.equal(openWeave.category, 'shirt');
    assert.equal(openWeave.best, true);
    assert.equal(openWeave.price, 2290);
    assert.equal(openWeave.discount, 25);
    assert.equal(openWeave.ordered, 0);
  });

  it('2. Re-uploading products CSV replaces existing rows cleanly without duplicates', async () => {
    const replacementCsv = [
      'name,category,description,best,color,discount,ordered,images,size,price',
      'Linen Breeze Shirt,summer shirt,Lightweight linen shirt,True,"White, Navy",20,3,https://example.test/1.jpg,"{""M"":5,""L"":5}",1400',
      'Classic Oxford Shirt,full shirt,Formal cotton oxford shirt,False,Blue,15,1,https://example.test/2.jpg,"{""L"":3,""XL"":4}",1600',
    ].join('\n');

    const form = new FormData();
    form.append(
      'file',
      new Blob([replacementCsv], { type: 'text/csv' }),
      'replacement.csv'
    );

    const res = await fetch(
      `${baseUrl}/api/sheets/products/upload?businessId=${businessId}`,
      {
        method: 'POST',
        body: form,
      }
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.imported_count, 2);

    const stored = mockPool
      .getInternalProducts()
      .filter((p) => p.business_id === businessId);
    assert.equal(stored.length, 2);

    // Restore full products.csv for subsequent tests
    const fullContent = fs.readFileSync(
      path.join(__dirname, '..', 'products.csv'),
      'utf8'
    );
    const restoreForm = new FormData();
    restoreForm.append(
      'file',
      new Blob([fullContent], { type: 'text/csv' }),
      'products.csv'
    );
    await fetch(
      `${baseUrl}/api/sheets/products/upload?businessId=${businessId}`,
      {
        method: 'POST',
        body: restoreForm,
      }
    );
  });

  it('3. Rejects malformed rows and invalid numeric fields with row-level errors', async () => {
    const invalidCsv = [
      'name,price,discount,ordered',
      ',1200,25,0', // missing name
      'Bad Price Shirt,not-a-number,25,0', // invalid price
      'Bad Discount Shirt,1200,150,0', // discount > 100
    ].join('\n');

    const form = new FormData();
    form.append(
      'file',
      new Blob([invalidCsv], { type: 'text/csv' }),
      'invalid.csv'
    );

    const res = await fetch(
      `${baseUrl}/api/sheets/products/upload?businessId=${businessId}`,
      {
        method: 'POST',
        body: form,
      }
    );
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.rejected_count, 3);
    assert.equal(body.imported_count, 0);
  });

  it('4. GET /api/sheets/products returns all 15 products with normalized types', async () => {
    const res = await fetch(
      `${baseUrl}/api/sheets/products?businessId=${businessId}`
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, 'ok');
    assert.equal(body.entity, 'products');
    assert.equal(body.count, 15);
    assert.equal(body.rows.length, 15);
  });

  it('5. Removed services and sheet-generation endpoints return 404 or 400', async () => {
    const servicesRes = await fetch(
      `${baseUrl}/api/sheets/services?businessId=${businessId}`
    );
    assert.equal(servicesRes.status, 404);

    const genRes = await fetch(
      `${baseUrl}/api/businesses/${businessId}/sheets/generate`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entity: 'products', count: 5 }),
      }
    );
    assert.equal(genRes.status, 404);

    const queryServicesEntityRes = await fetch(
      `${baseUrl}/api/sheets/query?businessId=${businessId}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          entity: 'services',
          message: 'Show unavailable services.',
        }),
      }
    );
    assert.equal(queryServicesEntityRes.status, 400);
  });

  it('6. Query: "Show all best-selling products." returns the 7 best-seller products', async () => {
    const res = await fetch(
      `${baseUrl}/api/sheets/query?businessId=${businessId}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          entity: 'products',
          message: 'Show all best-selling products.',
        }),
      }
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, 'ok');
    assert.equal(body.count, 7);
    assert.ok(body.rows.every((r) => r.best === true));
  });

  it('7. Query: "Show products in the luxury shirt category." returns PleatWave Shirt and Sparkle fusion Shirt', async () => {
    const res = await fetch(
      `${baseUrl}/api/sheets/query?businessId=${businessId}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          entity: 'products',
          message: 'Show products in the luxury shirt category.',
        }),
      }
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, 'ok');
    assert.equal(body.count, 2);
    assert.ok(body.rows.every((r) => r.category === 'luxury shirt'));
  });

  it('8. Query: "Find products available in Black with price below 1500." matches comma-separated colors and price', async () => {
    const res = await fetch(
      `${baseUrl}/api/sheets/query?businessId=${businessId}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          entity: 'products',
          message: 'Find products available in Black with price below 1500.',
        }),
      }
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, 'ok');
    assert.ok(body.count > 0);
    assert.ok(
      body.rows.every(
        (r) => r.color.toLowerCase().includes('black') && r.price < 1500
      )
    );
  });

  it('9. Query: "Find products available in size XXXL." matches JSON size key XXXL', async () => {
    const res = await fetch(
      `${baseUrl}/api/sheets/query?businessId=${businessId}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          entity: 'products',
          message: 'Find products available in size XXXL.',
        }),
      }
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, 'ok');
    assert.equal(body.count, 1);
    assert.equal(body.rows[0].name, 'OpenWeave Shirt');
  });

  it('10. Query: "List products with ordered count greater than 0." and "Find products with a discount above 30%."', async () => {
    const orderedRes = await fetch(
      `${baseUrl}/api/sheets/query?businessId=${businessId}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          entity: 'products',
          message: 'List products with ordered count greater than 0.',
        }),
      }
    );
    assert.equal(orderedRes.status, 200);
    const orderedBody = await orderedRes.json();
    assert.equal(orderedBody.status, 'ok');
    assert.equal(orderedBody.count, 5);
    assert.ok(orderedBody.rows.every((r) => r.ordered > 0));

    const discountRes = await fetch(
      `${baseUrl}/api/sheets/query?businessId=${businessId}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          entity: 'products',
          message: 'Find products with a discount above 30%.',
        }),
      }
    );
    assert.equal(discountRes.status, 200);
    const discountBody = await discountRes.json();
    assert.equal(discountBody.status, 'ok');
    assert.equal(discountBody.count, 1);
    assert.equal(discountBody.rows[0].name, 'Granular Texture Polo Shirt');
    assert.equal(discountBody.rows[0].discount, 45);
  });

  it('11. Query: "Find products with a sequined panel." searches product descriptions', async () => {
    const res = await fetch(
      `${baseUrl}/api/sheets/query?businessId=${businessId}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          entity: 'products',
          message: 'Find products with a sequined panel.',
        }),
      }
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, 'ok');
    assert.equal(body.count, 1);
    assert.equal(body.rows[0].name, 'Sparkle fusion Shirt');
  });

  it('12. Mutation: Two-phase preview (confirm: false) and execution (confirm: true) on OpenWeave Shirt and Palm Breeze Shirt', async () => {
    // Stage 1: Preview
    const previewRes = await fetch(
      `${baseUrl}/api/sheets/mutation?businessId=${businessId}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          entity: 'products',
          message: 'Change the price of OpenWeave Shirt to 1450.',
          confirm: false,
        }),
      }
    );
    assert.equal(previewRes.status, 200);
    const previewBody = await previewRes.json();
    assert.equal(previewBody.status, 'preview');
    assert.equal(previewBody.affected_count, 1);
    assert.equal(previewBody.diff[0].before.price, 2290);
    assert.equal(previewBody.diff[0].after.price, 1450);

    // Stage 2: Execute
    const execRes = await fetch(
      `${baseUrl}/api/sheets/mutation?businessId=${businessId}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          entity: 'products',
          message: 'Change the price of OpenWeave Shirt to 1450.',
          confirm: true,
        }),
      }
    );
    assert.equal(execRes.status, 200);
    const execBody = await execRes.json();
    assert.equal(execBody.status, 'success');
    assert.equal(execBody.updated_rows[0].price, 1450);

    // Multi-field update on Palm Breeze Shirt
    const multiRes = await fetch(
      `${baseUrl}/api/sheets/mutation?businessId=${businessId}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          entity: 'products',
          message:
            'Set the discount of Palm Breeze Shirt to 35 and mark it as a best seller.',
          confirm: true,
        }),
      }
    );
    assert.equal(multiRes.status, 200);
    const multiBody = await multiRes.json();
    assert.equal(multiBody.status, 'success');
    assert.equal(multiBody.updated_rows[0].discount, 35);
    assert.equal(multiBody.updated_rows[0].best, true);
  });

  it('13. Clarification needed for missing mutation value or unsupported schema column', async () => {
    const missingValRes = await fetch(
      `${baseUrl}/api/sheets/mutation?businessId=${businessId}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          entity: 'products',
          message: 'Update the discount of OpenWeave Shirt.',
          confirm: false,
        }),
      }
    );
    assert.equal(missingValRes.status, 200);
    const missingValBody = await missingValRes.json();
    assert.equal(missingValBody.status, 'clarification_needed');

    const unsupportedColRes = await fetch(
      `${baseUrl}/api/sheets/query?businessId=${businessId}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          entity: 'products',
          message: 'Find products by warehouse location.',
        }),
      }
    );
    assert.equal(unsupportedColRes.status, 200);
    const unsupportedColBody = await unsupportedColRes.json();
    assert.equal(unsupportedColBody.status, 'clarification_needed');
  });

  it('14. Customer inquiry context retrieval pulls matching product details directly from products.csv table', async () => {
    const relevant = await retrieveRelevantContextForBusiness(
      businessId,
      'Hi, how much is the OpenWeave Shirt and what colors and sizes does it come in?'
    );
    assert.ok(relevant.length > 0);
    assert.equal(relevant[0].title, 'OpenWeave Shirt');
    assert.equal(relevant[0].source_file, 'products.csv');
    assert.ok(relevant[0].content.includes('Price: 1450'));
    assert.ok(relevant[0].content.includes('open-weave pattern'));
  });
});
