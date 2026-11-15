import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

function createMemoryStorage() {
  const store = new Map();
  let failOnceOnSet = false;
  return {
    _store: store,
    setFailOnceOnSet(flag) {
      failOnceOnSet = flag;
    },
    get length() {
      return store.size;
    },
    clear() {
      store.clear();
    },
    getItem(key) {
      return store.has(key) ? store.get(key) : null;
    },
    setItem(key, value) {
      if (failOnceOnSet && key.startsWith('maxitext_ws_ctx_v1:') && !key.endsWith(':index')) {
        failOnceOnSet = false;
        const err = new Error('QuotaExceededError');
        err.name = 'QuotaExceededError';
        throw err;
      }
      store.set(String(key), String(value));
    },
    removeItem(key) {
      store.delete(String(key));
    },
    key(index) {
      return Array.from(store.keys())[index] ?? null;
    },
  };
}

let mockStorage = createMemoryStorage();
globalThis.localStorage = mockStorage;

const cache = await import('../src/services/workspaceContextCache.ts');

describe('workspaceContextCache (L1 + L2 localStorage)', () => {
  beforeEach(() => {
    mockStorage = createMemoryStorage();
    globalThis.localStorage = mockStorage;
    cache.clearAllL1Cache();
  });

  afterEach(() => {
    cache.clearAllL1Cache();
  });

  it('hydrates from L1 within session and falls back to L2 localStorage after simulated page reload', () => {
    const tables = [
      {
        entity: 'orders',
        tableName: 'orders',
        displayName: 'Commercial Orders',
        fileName: 'orders.csv',
        columns: ['Order_ID', 'Status', 'Total'],
        rowCount: 2,
        rows: [
          { id: '1', Order_ID: 'ORD-1', Status: 'Delayed', Total: 120 },
          { id: '2', Order_ID: 'ORD-2', Status: 'Shipped', Total: 240 },
        ],
      },
    ];
    const docs = [
      {
        doc_id: 'doc-1',
        filename: 'SLA_Policy.pdf',
        page_count: 3,
        chunk_count: 12,
      },
    ];
    const synced = [
      {
        table_name: 'orders',
        google_spreadsheet_id: 'sheet-abc',
        google_sheet_tab_name: 'Sheet1',
        row_count: 2,
        last_synced_at: '2026-11-16T00:00:00.000Z',
      },
    ];

    cache.setCachedWorkspaceTables('ws-1', { tables, lastActiveEntity: 'orders' }, 'user-a');
    cache.setCachedWorkspaceDocuments('ws-1', docs, 'user-a');
    cache.setCachedWorkspaceSyncedSheets('ws-1', synced, 'user-a');

    const l1Hit = cache.getCachedWorkspaceContext('ws-1', 'user-a');
    assert.ok(l1Hit);
    assert.equal(l1Hit.source, 'l1');
    assert.equal(l1Hit.freshness.tablesFresh, true);
    assert.equal(l1Hit.freshness.documentsFresh, true);
    assert.equal(l1Hit.freshness.syncedSheetsFresh, true);
    assert.equal(l1Hit.snapshot.rowsByEntity.orders.length, 2);

    // Simulate full browser reload (L1 cleared, L2 localStorage intact)
    cache.clearAllL1Cache();

    const l2Hit = cache.getCachedWorkspaceContext('ws-1', 'user-a');
    assert.ok(l2Hit);
    assert.equal(l2Hit.source, 'l2');
    assert.equal(l2Hit.freshness.tablesFresh, true);
    assert.equal(l2Hit.snapshot.tables.length, 1);
    assert.equal(l2Hit.snapshot.rowsByEntity.orders.length, 2);
    assert.equal(l2Hit.snapshot.documents[0].filename, 'SLA_Policy.pdf');
    assert.equal(l2Hit.snapshot.syncedSheets[0].google_spreadsheet_id, 'sheet-abc');
    assert.equal(l2Hit.snapshot.lastActiveEntity, 'orders');

    // Subsequent read in same session hits L1 now
    const promotedHit = cache.getCachedWorkspaceContext('ws-1', 'user-a');
    assert.equal(promotedHit.source, 'l1');
  });

  it('isolates cached data strictly by userId and clears only signing-out user caches', () => {
    cache.setCachedWorkspaceDocuments(
      'ws-shared',
      [{ doc_id: 'd-a', filename: 'UserA_Secret.pdf', page_count: 1, chunk_count: 2 }],
      'user-a'
    );
    cache.setCachedWorkspaceDocuments(
      'ws-shared',
      [{ doc_id: 'd-b', filename: 'UserB_Secret.pdf', page_count: 1, chunk_count: 3 }],
      'user-b'
    );

    const aCtx = cache.getCachedWorkspaceContext('ws-shared', 'user-a');
    const bCtx = cache.getCachedWorkspaceContext('ws-shared', 'user-b');
    assert.equal(aCtx.snapshot.documents[0].filename, 'UserA_Secret.pdf');
    assert.equal(bCtx.snapshot.documents[0].filename, 'UserB_Secret.pdf');

    cache.clearUserWorkspaceCache('user-a');
    assert.equal(cache.getCachedWorkspaceContext('ws-shared', 'user-a'), null);

    cache.clearAllL1Cache();
    const bAfter = cache.getCachedWorkspaceContext('ws-shared', 'user-b');
    assert.ok(bAfter);
    assert.equal(bAfter.snapshot.documents[0].filename, 'UserB_Secret.pdf');
  });

  it('distinguishes usable SWR cache vs fresh TTL and expires past maxAgeMs', () => {
    cache.setCachedWorkspaceDocuments(
      'ws-ttl',
      [{ doc_id: 'd-1', filename: 'Policy.md', page_count: 1, chunk_count: 1 }],
      'user-a'
    );

    const staleButUsable = cache.getCachedWorkspaceContext('ws-ttl', 'user-a', {
      freshTtlMs: -1,
      maxAgeMs: 60_000,
    });
    assert.ok(staleButUsable);
    assert.equal(staleButUsable.freshness.documentsUsable, true);
    assert.equal(staleButUsable.freshness.documentsFresh, false);

    const expired = cache.getCachedWorkspaceContext('ws-ttl', 'user-a', {
      freshTtlMs: 0,
      maxAgeMs: -1,
    });
    assert.equal(expired, null);
  });

  it('keeps full rows in L1, compacts oversized tables in L2 with truncation flag, and preserves auth storage keys', () => {
    mockStorage.setItem('maxitext_user_profile', JSON.stringify({ id: 'user-a', name: 'Tester' }));

    const hugeRows = Array.from({ length: 1800 }, (_, i) => ({
      id: `row-${i}`,
      sku: `SKU-${i}`,
      notes: 'Long operational metadata description for capacity stress test '.repeat(5),
    }));
    const tables = [
      {
        entity: 'large_inventory',
        tableName: 'large_inventory',
        displayName: 'Large Inventory',
        fileName: 'large_inventory.csv',
        columns: ['sku', 'notes'],
        rowCount: hugeRows.length,
        rows: hugeRows,
      },
    ];

    cache.setCachedWorkspaceTables('ws-huge', { tables }, 'user-a');

    // L1 has 100% of rows and is fresh
    const l1Hit = cache.getCachedWorkspaceContext('ws-huge', 'user-a');
    assert.equal(l1Hit.snapshot.rowsByEntity.large_inventory.length, 1800);
    assert.equal(l1Hit.freshness.tablesFresh, true);

    // Clear L1 to inspect compacted L2 snapshot
    cache.clearAllL1Cache();
    const l2Hit = cache.getCachedWorkspaceContext('ws-huge', 'user-a');
    assert.ok(l2Hit);
    assert.equal(l2Hit.snapshot.rowsTruncatedInL2, true);
    // Truncated L2 payload hydrates UI immediately AND triggers background SWR refresh
    assert.equal(l2Hit.freshness.tablesUsable, true);
    assert.equal(l2Hit.freshness.tablesFresh, false);
    assert.ok(l2Hit.snapshot.rowsByEntity.large_inventory.length <= 100);
    assert.equal(l2Hit.snapshot.tables[0].rowCount, 1800);

    // Auth key must never be evicted even under quota failures
    cache.setCachedWorkspaceTables('ws-small-1', { tables: [{ ...tables[0], rows: hugeRows.slice(0, 5), rowCount: 5 }] }, 'user-a');
    mockStorage.setFailOnceOnSet(true);
    cache.setCachedWorkspaceTables('ws-small-2', { tables: [{ ...tables[0], rows: hugeRows.slice(0, 5), rowCount: 5 }] }, 'user-a');
    assert.ok(mockStorage.getItem('maxitext_user_profile'));
  });

  it('writes through table patches, table deletions, and document + chunk cache evictions', () => {
    cache.setCachedWorkspaceTables(
      'ws-mut',
      {
        tables: [
          {
            entity: 'orders',
            tableName: 'orders',
            displayName: 'Orders',
            fileName: 'orders.csv',
            columns: ['Order_ID', 'Status'],
            rowCount: 1,
            rows: [{ id: 'o1', Order_ID: '101', Status: 'Pending' }],
          },
          {
            entity: 'products',
            tableName: 'products',
            displayName: 'Products',
            fileName: 'products.csv',
            columns: ['name'],
            rowCount: 1,
            rows: [{ id: 'p1', name: 'Jacket' }],
          },
        ],
      },
      'user-a'
    );
    cache.setCachedWorkspaceSyncedSheets(
      'ws-mut',
      [
        {
          table_name: 'orders',
          google_spreadsheet_id: 'g-1',
          google_sheet_tab_name: 'Sheet1',
          row_count: 1,
          last_synced_at: '2026-11-16T00:00:00.000Z',
        },
      ],
      'user-a'
    );
    cache.setCachedWorkspaceDocuments(
      'ws-mut',
      [{ doc_id: 'doc-uuid-1', filename: 'Receiving Manifest.pdf', page_count: 2, chunk_count: 4 }],
      'user-a'
    );
    cache.setCachedDocumentChunks(
      'ws-mut',
      'doc-uuid-1',
      {
        document: {
          id: 'doc-uuid-1',
          workspace_id: 'ws-mut',
          filename: 'Receiving Manifest.pdf',
          total_chunks: 1,
          all_extracted_entities: ['SKU-99'],
        },
        chunks: [
          {
            id: 'c1',
            chunk_index: 0,
            locator: 'Page 1 / Chunk 1',
            breadcrumb_header: '[Doc: Receiving Manifest]',
            raw_text: 'Sample clause text',
            extracted_entities: ['SKU-99'],
          },
        ],
      },
      'user-a'
    );

    // Patch table rows
    cache.patchCachedTableRows(
      'ws-mut',
      'orders',
      [
        { id: 'o1', Order_ID: '101', Status: 'Updated' },
        { id: 'o2', Order_ID: '102', Status: 'New' },
      ],
      undefined,
      'user-a'
    );
    let ctx = cache.getCachedWorkspaceContext('ws-mut', 'user-a');
    assert.equal(ctx.snapshot.rowsByEntity.orders.length, 2);
    assert.equal(
      ctx.snapshot.tables.find((t) => t.entity === 'orders').rowCount,
      2
    );

    // Chunks hit by BOTH UUID and case-insensitive filename (including across L2 reload)
    assert.ok(cache.getCachedDocumentChunks('ws-mut', 'doc-uuid-1', 'user-a'));
    assert.ok(cache.getCachedDocumentChunks('ws-mut', 'receiving manifest.pdf', 'user-a'));
    cache.clearAllL1Cache();
    assert.ok(cache.getCachedDocumentChunks('ws-mut', 'Receiving Manifest.pdf', 'user-a'));

    // Removing document evicts both doc entry & chunk entry
    cache.removeCachedDocument('ws-mut', 'Receiving Manifest.pdf', 'user-a');
    ctx = cache.getCachedWorkspaceContext('ws-mut', 'user-a');
    assert.equal(ctx.snapshot.documents.length, 0);
    assert.equal(cache.getCachedDocumentChunks('ws-mut', 'doc-uuid-1', 'user-a'), null);
    assert.equal(
      cache.getCachedDocumentChunks('ws-mut', 'Receiving Manifest.pdf', 'user-a'),
      null
    );

    // Removing table also prunes syncedSheets entry and updates lastActiveEntity
    cache.removeCachedTableEntity('ws-mut', 'orders', 'user-a');
    ctx = cache.getCachedWorkspaceContext('ws-mut', 'user-a');
    assert.equal(ctx.snapshot.tables.length, 1);
    assert.equal(ctx.snapshot.tables[0].entity, 'products');
    assert.equal(ctx.snapshot.syncedSheets.length, 0);
  });

  it('deduplicates concurrent in-flight requests per channel + workspace unless forced', async () => {
    let calls = 0;
    const delayedFetch = () =>
      new Promise((resolve) => {
        calls += 1;
        setTimeout(() => resolve({ count: calls }), 20);
      });

    const [r1, r2] = await Promise.all([
      cache.runDeduplicatedWorkspaceRequest('businessSheets', 'ws-dedup', delayedFetch, {
        userId: 'user-a',
      }),
      cache.runDeduplicatedWorkspaceRequest('businessSheets', 'ws-dedup', delayedFetch, {
        userId: 'user-a',
      }),
    ]);

    assert.equal(calls, 1);
    assert.deepEqual(r1, r2);

    const forced = await cache.runDeduplicatedWorkspaceRequest(
      'businessSheets',
      'ws-dedup',
      delayedFetch,
      { force: true, userId: 'user-a' }
    );
    assert.equal(calls, 2);
    assert.equal(forced.count, 2);
  });
});
