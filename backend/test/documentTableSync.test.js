const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { setPool } = require('../db');
const {
  ingestDocument,
  clearDocumentsForBusiness,
} = require('../src/services/documentIngestionService');
const {
  invalidateWorkspaceMetadataCache,
} = require('../src/services/workspaceTableMetadataService');
const {
  setWorkspaceGeminiGenerator,
} = require('../src/services/geminiService');
const {
  executeWorkspaceOperation,
  confirmWorkspaceOperation,
  clearWorkflowStoreGlobal,
} = require('../src/services/socraticOperationsService');
const {
  promptReferencesWorkspaceDocument,
  tryRouteBasicTableMutation,
} = require('../src/services/fastTableQueryService');
const {
  enforceOperationalIntentPrecedence,
} = require('../src/services/workspaceIntentRouter');
const { confirmOperation } = require('../src/controllers/workspaceController');

function createDynamicSyncMockPool({
  workspaceId,
  schemasByTable,
  rowsByTable,
}) {
  const metadataByTable = {};
  for (const [tblName, cols] of Object.entries(schemasByTable)) {
    const dataCols = cols.filter(
      (c) => !['id', 'business_id', 'workspace_id', 'created_at', 'updated_at'].includes(c.column_name)
    );
    metadataByTable[tblName] = {
      workspace_id: workspaceId,
      table_name: tblName,
      source_filename: `${tblName}.csv`,
      row_count: String((rowsByTable[tblName] || []).length),
      primary_key_column: cols.find((c) => c.pk)?.column_name || dataCols[0]?.column_name || 'id',
      email_column: cols.find((c) => /email/i.test(c.column_name))?.column_name || null,
      table_summary: `Mock table ${tblName}`,
      columns_profile: dataCols.map((c) => ({
        column_name: c.column_name,
        normalized_type: c.type || 'string',
        categorical_values: c.categorical_values || [],
      })),
    };
  }

  const runQuery = async (sql, params = []) => {
    const raw = String(sql || '').trim();
    const norm = raw.replace(/\s+/g, ' ').replace(/"/g, '').toUpperCase();

    if (/^(?:BEGIN|COMMIT|ROLLBACK|CREATE |ALTER |TRUNCATE )/.test(norm)) {
      return { rows: [], rowCount: 0 };
    }

    if (norm.includes('FROM INFORMATION_SCHEMA.COLUMNS')) {
      const tblParam = String(params[0] || '').toLowerCase();
      const cols = schemasByTable[tblParam] || [];
      return {
        rows: cols.map((c) => ({
          column_name: c.column_name,
          data_type: c.data_type || 'character varying',
          udt_name: c.udt_name || 'varchar',
          is_nullable: c.is_nullable || 'YES',
        })),
        rowCount: cols.length,
      };
    }

    if (norm.includes('FROM WORKSPACE_TABLE_METADATA')) {
      return {
        rows: Object.values(metadataByTable).map((m) => ({
          ...m,
          row_count: String((rowsByTable[m.table_name] || []).length),
        })),
        rowCount: Object.keys(metadataByTable).length,
      };
    }

    if (norm.startsWith('INSERT INTO WORKSPACE_TABLE_METADATA')) {
      const tblParam = String(params[1] || '').toLowerCase();
      if (metadataByTable[tblParam]) {
        metadataByTable[tblParam].row_count = String(
          params[3] ?? (rowsByTable[tblParam] || []).length
        );
      }
      return { rows: [metadataByTable[tblParam]].filter(Boolean), rowCount: 1 };
    }

    if (norm.includes('FROM WORKSPACE_DOCUMENTS') || norm.includes('FROM WORKSPACE_DOCUMENT_CHUNKS')) {
      return { rows: [], rowCount: 0 };
    }

    if (norm.includes('SOCRATIC_WORKFLOWS')) {
      return { rows: [], rowCount: 0 };
    }

    if (norm.includes('FROM WORKSPACES') || norm.includes('FROM BUSINESSES')) {
      const targetId = params[0] || workspaceId;
      if (String(targetId) === String(workspaceId)) {
        return {
          rows: [{ id: workspaceId, name: 'Mock Workspace', user_id: null, created_at: new Date().toISOString() }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    }

    const countMatch = raw.match(/SELECT\s+COUNT\(\*\)::int\s+AS\s+cnt\s+FROM\s+"?([a-z0-9_]+)"?/i);
    if (countMatch) {
      const tbl = countMatch[1].toLowerCase();
      const cnt = (rowsByTable[tbl] || []).filter(
        (r) => !params[0] || r.business_id === params[0] || r.workspace_id === params[0]
      ).length;
      return { rows: [{ cnt }], rowCount: 1 };
    }

    const selMatch = raw.match(/SELECT\s+\*\s+FROM\s+"?([a-z0-9_]+)"?/i);
    if (selMatch) {
      const tbl = selMatch[1].toLowerCase();
      const biz = params[0];
      const rows = (rowsByTable[tbl] || []).filter(
        (r) => !biz || r.business_id === biz || r.workspace_id === biz
      );
      return { rows: rows.map((r) => ({ ...r })), rowCount: rows.length };
    }

    if (norm.startsWith('SELECT DISTINCT')) {
      return { rows: [], rowCount: 0 };
    }

    const insMatch = raw.match(/INSERT\s+INTO\s+"?([a-z0-9_]+)"?\s*\(([^)]+)\)\s*VALUES\s*\(([^)]+)\)/i);
    if (insMatch) {
      const tbl = insMatch[1].toLowerCase();
      const colList = insMatch[2]
        .split(',')
        .map((c) => c.trim().replace(/^["']|["']$/g, ''));
      const valExprs = insMatch[3].split(',').map((v) => v.trim());
      const newRow = { id: crypto.randomUUID() };
      colList.forEach((col, i) => {
        const expr = valExprs[i] || '';
        const pMatch = expr.match(/^\$(\d+)/);
        if (pMatch) {
          newRow[col] = params[Number(pMatch[1]) - 1];
        } else if (/^NOW\(\)$/i.test(expr)) {
          newRow[col] = new Date().toISOString();
        }
      });
      if (!rowsByTable[tbl]) rowsByTable[tbl] = [];
      rowsByTable[tbl].push(newRow);
      return { rows: [{ ...newRow }], rowCount: 1 };
    }

    const updMatch = raw.match(
      /UPDATE\s+"?([a-z0-9_]+)"?\s+SET\s+([\s\S]+?)\s+WHERE\s+([\s\S]+?)(?:\s+RETURNING\s+\*)?;?$/i
    );
    if (updMatch) {
      const tbl = updMatch[1].toLowerCase();
      const setStr = updMatch[2];
      const bizId = params[0];
      const targetId = params[params.length - 1];
      const tableRows = rowsByTable[tbl] || [];
      const pkCol = metadataByTable[tbl]?.primary_key_column;
      const target = tableRows.find(
        (r) =>
          (r.business_id === bizId || r.workspace_id === bizId) &&
          (String(r.id) === String(targetId) || (pkCol && String(r[pkCol]) === String(targetId)))
      );
      if (!target) return { rows: [], rowCount: 0 };

      for (const assign of setStr.split(',')) {
        const m = assign.trim().match(/^"?([a-z0-9_]+)"?\s*=\s*(.+)$/i);
        if (!m) continue;
        const col = m[1];
        const rhs = m[2].trim();
        const pM = rhs.match(/^\$(\d+)/);
        if (pM) target[col] = params[Number(pM[1]) - 1];
        else if (/^NOW\(\)$/i.test(rhs)) target[col] = new Date().toISOString();
      }
      return { rows: [{ ...target }], rowCount: 1 };
    }

    const delMatch = raw.match(/DELETE\s+FROM\s+"?([a-z0-9_]+)"?\s+WHERE\s+([\s\S]+?);?$/i);
    if (delMatch) {
      const tbl = delMatch[1].toLowerCase();
      const bizId = params[0];
      const targetId = params[1];
      const tableRows = rowsByTable[tbl] || [];
      const pkCol = metadataByTable[tbl]?.primary_key_column;
      const beforeLen = tableRows.length;
      rowsByTable[tbl] = tableRows.filter(
        (r) =>
          !(
            (r.business_id === bizId || r.workspace_id === bizId) &&
            (String(r.id) === String(targetId) || (pkCol && String(r[pkCol]) === String(targetId)))
          )
      );
      return { rows: [], rowCount: beforeLen - rowsByTable[tbl].length };
    }

    return { rows: [], rowCount: 0 };
  };

  return {
    query: runQuery,
    connect: async () => ({
      query: runQuery,
      release: () => {},
    }),
  };
}

function baseSysCols() {
  return [
    { column_name: 'id', udt_name: 'uuid', is_nullable: 'NO' },
    { column_name: 'business_id', udt_name: 'uuid', is_nullable: 'NO' },
    { column_name: 'workspace_id', udt_name: 'uuid', is_nullable: 'YES' },
    { column_name: 'created_at', udt_name: 'timestamptz', is_nullable: 'NO' },
    { column_name: 'updated_at', udt_name: 'timestamptz', is_nullable: 'NO' },
  ];
}

test('1. E-commerce backorders + multi-page Order_Manifest: detects missing column, rejects unpopulated confirm, and commits edited rows', async () => {
  const wsId = 'ws-ecom-sync-1';
  const rowsByTable = {
    backorders_dataset: [
      {
        id: 'row-existing-1',
        business_id: wsId,
        workspace_id: wsId,
        backorder_id: 'BO-2022',
        order_date: '2026-11-07',
        buyer_company: 'Solstice Menswear Co.',
        buyer_name: 'Elena Rostova',
        buyer_email: 'erostova@solsticemenswear.io',
        buyer_tier: 'Standard',
        sku_code: 'VL-SHIRT-OXF',
        product_name: 'Oxford Mandarin Collar Shirt',
        quantity_requested: 10,
        quantity_allocated: 0,
        fulfillment_status: 'Shipped',
      },
    ],
  };

  const schemasByTable = {
    backorders_dataset: [
      ...baseSysCols(),
      { column_name: 'backorder_id', udt_name: 'varchar', is_nullable: 'YES', pk: true },
      { column_name: 'order_date', udt_name: 'date', data_type: 'date', is_nullable: 'YES' },
      { column_name: 'buyer_company', udt_name: 'varchar', is_nullable: 'YES' },
      { column_name: 'buyer_name', udt_name: 'varchar', is_nullable: 'YES' },
      { column_name: 'buyer_email', udt_name: 'varchar', is_nullable: 'YES' },
      { column_name: 'buyer_tier', udt_name: 'varchar', is_nullable: 'YES', categorical_values: ['Priority', 'Standard'] },
      { column_name: 'sku_code', udt_name: 'varchar', is_nullable: 'YES' },
      { column_name: 'product_name', udt_name: 'varchar', is_nullable: 'YES' },
      { column_name: 'quantity_requested', udt_name: 'int8', is_nullable: 'YES' },
      { column_name: 'quantity_allocated', udt_name: 'int8', is_nullable: 'YES' },
      { column_name: 'fulfillment_status', udt_name: 'varchar', is_nullable: 'YES', categorical_values: ['Pending', 'Fulfilled', 'Shipped', 'On Hold'] },
    ],
  };

  setPool(createDynamicSyncMockPool({ workspaceId: wsId, schemasByTable, rowsByTable }));
  await clearWorkflowStoreGlobal();

  await ingestDocument({
    businessId: wsId,
    filename: 'Order_Manifest.pdf',
    mimeType: 'application/pdf',
    customPages: [
      {
        page_number: 1,
        text: 'Order 1: BO-2023 | 2026-11-18 | Northbridge Apparel Co. | Claire Bennett | cbennett@northbridge.example | Priority | VL-POLO-BLK | Classic Short-Sleeve Polo | Qty: 14 | Pending\nOrder 2: BO-2024 | 2026-11-19 | Kensington Clothiers | Arthur Pendelton | apendelton@kensington.example | Standard | VL-KNIT-MER | Merino Knit Pullover | Qty: 10 | Pending',
      },
      {
        page_number: 2,
        text: 'Order 3: BO-2025 | 2026-11-20 | Bayview Sartorial | Maya Patel | mpatel@bayview.example | Priority | VL-SHIRT-OXF | Oxford Mandarin Collar Shirt | Qty: 12 | Pending\nOrder 4: BO-2026 | 2026-11-21 | Cascade Menswear | Julian Morales | jmorales@cascade.example | Standard | VL-POLO-HEN | Pima Cotton Henley | Qty: 8 | Pending',
      },
    ],
  });

  let sawBothPages = false;
  setWorkspaceGeminiGenerator(async (promptText, options) => {
    if (options?.stage === 'route_and_plan') {
      return {
        intent: 'document_table_sync',
        entity: 'backorders_dataset',
        target_entities: ['backorders_dataset'],
        document_grounded: true,
        table_queries: [],
      };
    }
    if (options?.stage === 'document_table_sync') {
      sawBothPages = promptText.includes('BO-2023') && promptText.includes('BO-2026');
      return {
        document_relevant: true,
        inferred_operation: 'create',
        summary: 'Extracted 4 incoming orders (BO-2023..BO-2026) from Order_Manifest.pdf.',
        operations: [
          {
            operation: 'create',
            target_row_identifier: 'BO-2023',
            fields: [
              { column: 'backorder_id', value: 'BO-2023' },
              { column: 'order_date', value: '2026-11-18' },
              { column: 'buyer_company', value: 'Northbridge Apparel Co.' },
              { column: 'buyer_name', value: 'Claire Bennett' },
              { column: 'buyer_email', value: 'cbennett@northbridge.example' },
              { column: 'buyer_tier', value: 'Priority' },
              { column: 'sku_code', value: 'VL-POLO-BLK' },
              { column: 'product_name', value: 'Classic Short-Sleeve Polo' },
              { column: 'quantity_requested', value: '14' },
              { column: 'fulfillment_status', value: 'Pending' },
            ],
            source_locator: 'Order_Manifest.pdf Page 1',
            reason: 'New order request',
          },
          {
            operation: 'create',
            target_row_identifier: 'BO-2024',
            fields: [
              { column: 'backorder_id', value: 'BO-2024' },
              { column: 'order_date', value: '2026-11-19' },
              { column: 'buyer_company', value: 'Kensington Clothiers' },
              { column: 'buyer_name', value: 'Arthur Pendelton' },
              { column: 'buyer_email', value: 'apendelton@kensington.example' },
              { column: 'buyer_tier', value: 'Standard' },
              { column: 'sku_code', value: 'VL-KNIT-MER' },
              { column: 'product_name', value: 'Merino Knit Pullover' },
              { column: 'quantity_requested', value: '10' },
              { column: 'fulfillment_status', value: 'Pending' },
            ],
            source_locator: 'Order_Manifest.pdf Page 1',
            reason: 'New order request',
          },
          {
            operation: 'create',
            target_row_identifier: 'BO-2025',
            fields: [
              { column: 'backorder_id', value: 'BO-2025' },
              { column: 'order_date', value: '2026-11-20' },
              { column: 'buyer_company', value: 'Bayview Sartorial' },
              { column: 'buyer_name', value: 'Maya Patel' },
              { column: 'buyer_email', value: 'mpatel@bayview.example' },
              { column: 'buyer_tier', value: 'Priority' },
              { column: 'sku_code', value: 'VL-SHIRT-OXF' },
              { column: 'product_name', value: 'Oxford Mandarin Collar Shirt' },
              { column: 'quantity_requested', value: '12' },
              { column: 'fulfillment_status', value: 'Pending' },
            ],
            source_locator: 'Order_Manifest.pdf Page 2',
            reason: 'New order request',
          },
          {
            operation: 'create',
            target_row_identifier: 'BO-2026',
            fields: [
              { column: 'backorder_id', value: 'BO-2026' },
              { column: 'order_date', value: '2026-11-21' },
              { column: 'buyer_company', value: 'Cascade Menswear' },
              { column: 'buyer_name', value: 'Julian Morales' },
              { column: 'buyer_email', value: 'jmorales@cascade.example' },
              { column: 'buyer_tier', value: 'Standard' },
              { column: 'sku_code', value: 'VL-POLO-HEN' },
              { column: 'product_name', value: 'Pima Cotton Henley' },
              { column: 'quantity_requested', value: '8' },
              { column: 'fulfillment_status', value: 'Pending' },
            ],
            source_locator: 'Order_Manifest.pdf Page 2',
            reason: 'New order request',
          },
        ],
      };
    }
    throw new Error(`Unexpected stage: ${options?.stage}`);
  });

  try {
    const planRes = await executeWorkspaceOperation({
      businessId: wsId,
      entity: 'backorders_dataset',
      prompt: 'add all the orders from the order manifest to the current table',
    });

    assert.equal(sawBothPages, true, 'All pages/chunks from Order_Manifest.pdf must be inspected');
    assert.equal(planRes.status, 'PREVIEW_READY');
    assert.equal(planRes.workflow_type, 'document_table_sync');
    assert.equal(planRes.target_entity, 'backorders_dataset');
    assert.equal(planRes.requires_field_completion, true);
    assert.deepEqual(planRes.missing_columns, ['quantity_allocated']);
    assert.equal(planRes.mutations_preview.length, 4);

    await assert.rejects(
      () =>
        confirmWorkspaceOperation({
          workflowId: planRes.workflow_id,
          businessId: wsId,
          confirm: true,
        }),
      (err) => err.statusCode === 400 && /quantity_allocated/i.test(err.message)
    );

    const editedMutations = planRes.mutations_preview.map((m) => ({
      row_index: m.row_index,
      row_identifier: m.row_identifier,
      operation: m.operation,
      include: true,
      after: { ...m.after, quantity_allocated: 0 },
    }));

    const execRes = await confirmWorkspaceOperation({
      workflowId: planRes.workflow_id,
      businessId: wsId,
      confirm: true,
      editedMutations,
    });

    assert.equal(execRes.status, 'EXECUTED');
    assert.equal(execRes.created_rows_count, 4);
    assert.equal(execRes.updated_rows_count, 4);
    assert.equal(rowsByTable.backorders_dataset.length, 5);
    assert.equal(rowsByTable.backorders_dataset[4].quantity_allocated, 0);
    assert.equal(rowsByTable.backorders_dataset[4].backorder_id, 'BO-2026');
  } finally {
    setWorkspaceGeminiGenerator(null);
    setPool(null);
    await clearDocumentsForBusiness(wsId);
    invalidateWorkspaceMetadataCache(wsId);
  }
});

test('2. Unrelated domain (employee_roster + Q4_Hires_Memo.pdf) works dynamically without hardcoding', async () => {
  const wsId = 'ws-hr-sync-2';
  const rowsByTable = {
    employee_roster: [
      {
        id: 'emp-uuid-1',
        business_id: wsId,
        workspace_id: wsId,
        emp_id: 'E-100',
        full_name: 'Nadia Karim',
        department: 'Engineering',
        start_date: '2026-01-15',
        salary: 95000,
      },
    ],
  };

  const schemasByTable = {
    employee_roster: [
      ...baseSysCols(),
      { column_name: 'emp_id', udt_name: 'varchar', is_nullable: 'NO', pk: true },
      { column_name: 'full_name', udt_name: 'varchar', is_nullable: 'NO' },
      { column_name: 'department', udt_name: 'varchar', is_nullable: 'YES' },
      { column_name: 'start_date', udt_name: 'date', data_type: 'date', is_nullable: 'YES' },
      { column_name: 'salary', udt_name: 'numeric', is_nullable: 'YES' },
    ],
  };

  setPool(createDynamicSyncMockPool({ workspaceId: wsId, schemasByTable, rowsByTable }));
  await clearWorkflowStoreGlobal();

  await ingestDocument({
    businessId: wsId,
    filename: 'Q4_Hires_Memo.pdf',
    mimeType: 'application/pdf',
    customPages: [
      {
        page_number: 1,
        text: 'Onboarding Q4: E-101 Tariq Hasan joined Product on 2026-11-01 at 88000.\nE-102 Elena Varga joined Finance on 2026-11-10 at 92000.',
      },
    ],
  });

  setWorkspaceGeminiGenerator(async (promptText, options) => {
    if (options?.stage === 'route_and_plan') {
      return {
        intent: 'document_table_sync',
        entity: 'employee_roster',
        target_entities: ['employee_roster'],
        document_grounded: true,
        table_queries: [],
      };
    }
    if (options?.stage === 'document_table_sync') {
      assert.match(promptText, /Q4_Hires_Memo\.pdf/);
      assert.match(promptText, /ACTIVE_TABLE: "employee_roster"/);
      return {
        document_relevant: true,
        inferred_operation: 'create',
        summary: 'Found 2 new hires in Q4_Hires_Memo.pdf.',
        operations: [
          {
            operation: 'create',
            target_row_identifier: 'E-101',
            fields: [
              { column: 'emp_id', value: 'E-101' },
              { column: 'full_name', value: 'Tariq Hasan' },
              { column: 'department', value: 'Product' },
              { column: 'start_date', value: '2026-11-01' },
              { column: 'salary', value: '88000' },
            ],
            source_locator: 'Q4_Hires_Memo.pdf Page 1',
            reason: 'New hire record',
          },
          {
            operation: 'create',
            target_row_identifier: 'E-102',
            fields: [
              { column: 'emp_id', value: 'E-102' },
              { column: 'full_name', value: 'Elena Varga' },
              { column: 'department', value: 'Finance' },
              { column: 'start_date', value: '2026-11-10' },
              { column: 'salary', value: '92000' },
            ],
            source_locator: 'Q4_Hires_Memo.pdf Page 1',
            reason: 'New hire record',
          },
        ],
      };
    }
    throw new Error(`Unexpected stage: ${options?.stage}`);
  });

  try {
    const planRes = await executeWorkspaceOperation({
      businessId: wsId,
      entity: 'employee_roster',
      prompt: 'Import all new hires from Q4 Hires Memo into this table.',
    });

    assert.equal(planRes.status, 'PREVIEW_READY');
    assert.equal(planRes.requires_field_completion, false);
    assert.deepEqual(planRes.missing_columns, []);
    assert.equal(planRes.mutations_preview.length, 2);

    const execRes = await confirmWorkspaceOperation({
      workflowId: planRes.workflow_id,
      businessId: wsId,
      confirm: true,
    });
    assert.equal(execRes.status, 'EXECUTED');
    assert.equal(execRes.created_rows_count, 2);
    assert.equal(rowsByTable.employee_roster.length, 3);
    assert.equal(rowsByTable.employee_roster[2].salary, 92000);
  } finally {
    setWorkspaceGeminiGenerator(null);
    setPool(null);
    await clearDocumentsForBusiness(wsId);
    invalidateWorkspaceMetadataCache(wsId);
  }
});

test('3 & 4. Supports delete and mixed (create + update + delete) strictly scoped to active table while leaving other tables untouched', async () => {
  const wsId = 'ws-logistics-3';
  const rowsByTable = {
    shipments: [
      {
        id: 'shp-row-1',
        business_id: wsId,
        workspace_id: wsId,
        shipment_code: 'SHP-101',
        carrier: 'DHL',
        status: 'Scheduled',
      },
      {
        id: 'shp-row-2',
        business_id: wsId,
        workspace_id: wsId,
        shipment_code: 'SHP-102',
        carrier: 'FedEx',
        status: 'Pending',
      },
    ],
    products: [
      {
        id: 'prod-untouched-1',
        business_id: wsId,
        workspace_id: wsId,
        name: 'Winter Parka',
        price: 150,
      },
    ],
  };

  const schemasByTable = {
    shipments: [
      ...baseSysCols(),
      { column_name: 'shipment_code', udt_name: 'varchar', is_nullable: 'NO', pk: true },
      { column_name: 'carrier', udt_name: 'varchar', is_nullable: 'YES' },
      { column_name: 'status', udt_name: 'varchar', is_nullable: 'YES' },
    ],
    products: [
      ...baseSysCols(),
      { column_name: 'name', udt_name: 'varchar', is_nullable: 'NO', pk: true },
      { column_name: 'price', udt_name: 'numeric', is_nullable: 'NO' },
    ],
  };

  setPool(createDynamicSyncMockPool({ workspaceId: wsId, schemasByTable, rowsByTable }));
  await clearWorkflowStoreGlobal();

  await ingestDocument({
    businessId: wsId,
    filename: 'Dispatch_Amendments.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from(
      'Cancel SHP-101 completely. Update SHP-102 status to Dispatched. Add SHP-103 via UPS with status In Transit.',
      'utf8'
    ),
  });

  setWorkspaceGeminiGenerator(async (_prompt, options) => {
    if (options?.stage === 'route_and_plan') {
      return {
        intent: 'document_table_sync',
        entity: 'shipments',
        target_entities: ['shipments'],
        document_grounded: true,
        table_queries: [],
      };
    }
    return {
      document_relevant: true,
      inferred_operation: 'mixed',
      summary: 'Mixed amendments in Dispatch_Amendments.txt.',
      operations: [
        {
          operation: 'delete',
          target_row_identifier: 'SHP-101',
          fields: [],
          source_locator: 'Dispatch_Amendments.txt Page 1',
          reason: 'Shipment cancelled',
        },
        {
          operation: 'update',
          target_row_identifier: 'SHP-102',
          fields: [{ column: 'status', value: 'Dispatched' }],
          source_locator: 'Dispatch_Amendments.txt Page 1',
          reason: 'Status changed to Dispatched',
        },
        {
          operation: 'create',
          target_row_identifier: 'SHP-103',
          fields: [
            { column: 'shipment_code', value: 'SHP-103' },
            { column: 'carrier', value: 'UPS' },
            { column: 'status', value: 'In Transit' },
          ],
          source_locator: 'Dispatch_Amendments.txt Page 1',
          reason: 'New dispatch entry',
        },
      ],
    };
  });

  try {
    const planRes = await executeWorkspaceOperation({
      businessId: wsId,
      entity: 'shipments',
      prompt: 'Apply the changes from Dispatch Amendments to the active table.',
    });

    assert.equal(planRes.status, 'PREVIEW_READY');
    assert.equal(planRes.operation_mode, 'mixed');
    assert.equal(planRes.target_entity, 'shipments');
    assert.equal(planRes.mutations_preview[0].operation, 'delete');
    assert.equal(planRes.mutations_preview[0].before.carrier, 'DHL');
    assert.equal(planRes.mutations_preview[1].operation, 'update');
    assert.equal(planRes.mutations_preview[1].before.carrier, 'FedEx');
    assert.equal(planRes.mutations_preview[2].operation, 'create');

    const execRes = await confirmWorkspaceOperation({
      workflowId: planRes.workflow_id,
      businessId: wsId,
      confirm: true,
    });

    assert.equal(execRes.status, 'EXECUTED');
    assert.equal(execRes.created_rows_count, 1);
    assert.equal(execRes.modified_rows_count, 1);
    assert.equal(execRes.deleted_rows_count, 1);
    assert.equal(rowsByTable.shipments.length, 2);
    assert.equal(rowsByTable.shipments.some((r) => r.shipment_code === 'SHP-101'), false);
    assert.equal(
      rowsByTable.shipments.find((r) => r.shipment_code === 'SHP-102')?.status,
      'Dispatched'
    );
    assert.equal(
      rowsByTable.shipments.find((r) => r.shipment_code === 'SHP-103')?.carrier,
      'UPS'
    );
    assert.equal(rowsByTable.products.length, 1);
    assert.equal(rowsByTable.products[0].price, 150);
  } finally {
    setWorkspaceGeminiGenerator(null);
    setPool(null);
    await clearDocumentsForBusiness(wsId);
    invalidateWorkspaceMetadataCache(wsId);
  }
});

test('5. Cancel workflow leaves DB untouched; duplicate PK warns & unchecks by default; required NOT NULL enforces input', async () => {
  const wsId = 'ws-guard-5';
  const rowsByTable = {
    vouchers: [
      {
        id: 'v-1',
        business_id: wsId,
        workspace_id: wsId,
        voucher_code: 'VCH-001',
        amount: 25,
        region: 'US',
      },
    ],
  };

  const schemasByTable = {
    vouchers: [
      ...baseSysCols(),
      { column_name: 'voucher_code', udt_name: 'varchar', is_nullable: 'NO', pk: true },
      { column_name: 'amount', udt_name: 'int8', is_nullable: 'NO' },
      { column_name: 'region', udt_name: 'varchar', is_nullable: 'YES' },
    ],
  };

  setPool(createDynamicSyncMockPool({ workspaceId: wsId, schemasByTable, rowsByTable }));
  await clearWorkflowStoreGlobal();

  await ingestDocument({
    businessId: wsId,
    filename: 'New_Vouchers.pdf',
    mimeType: 'application/pdf',
    customPages: [
      {
        page_number: 1,
        text: 'VCH-001 (existing duplicate, 25), VCH-002 (new, region missing, amount missing)',
      },
    ],
  });

  setWorkspaceGeminiGenerator(async (_prompt, options) => {
    if (options?.stage === 'route_and_plan') {
      return {
        intent: 'document_table_sync',
        entity: 'vouchers',
        target_entities: ['vouchers'],
        document_grounded: true,
        table_queries: [],
      };
    }
    return {
      document_relevant: true,
      inferred_operation: 'create',
      summary: 'Extracted VCH-001 and VCH-002.',
      operations: [
        {
          operation: 'create',
          target_row_identifier: 'VCH-001',
          fields: [
            { column: 'voucher_code', value: 'VCH-001' },
            { column: 'amount', value: '25' },
            { column: 'region', value: 'US' },
          ],
          source_locator: 'New_Vouchers.pdf Page 1',
          reason: 'Voucher entry',
        },
        {
          operation: 'create',
          target_row_identifier: 'VCH-002',
          fields: [{ column: 'voucher_code', value: 'VCH-002' }],
          source_locator: 'New_Vouchers.pdf Page 1',
          reason: 'New voucher missing amount and region',
        },
      ],
    };
  });

  try {
    const planRes = await executeWorkspaceOperation({
      businessId: wsId,
      entity: 'vouchers',
      prompt: 'Add all entries from New Vouchers to this table.',
    });

    assert.equal(planRes.status, 'PREVIEW_READY');
    assert.ok(planRes.mutations_preview[0].duplicate_warning);
    assert.equal(planRes.mutations_preview[0].include, false);
    assert.equal(planRes.mutations_preview[1].include, true);
    assert.deepEqual(planRes.missing_columns, ['amount', 'region']);

    await assert.rejects(
      () =>
        confirmWorkspaceOperation({
          workflowId: planRes.workflow_id,
          businessId: wsId,
          confirm: true,
          allowPartialNullable: true,
        }),
      (err) => err.statusCode === 400 && /amount/i.test(err.message)
    );

    // Nullable column omission succeeds once required fields (`amount`) are supplied and allowPartialNullable is true
    const partialRes = await executeWorkspaceOperation({
      businessId: wsId,
      entity: 'vouchers',
      prompt: 'Add all entries from New Vouchers to this table.',
    });
    const partialConfirm = await confirmWorkspaceOperation({
      workflowId: partialRes.workflow_id,
      businessId: wsId,
      confirm: true,
      allowPartialNullable: true,
      editedMutations: [
        { row_index: 0, include: false },
        {
          row_index: 1,
          include: true,
          after: { voucher_code: 'VCH-002', amount: 50, region: null },
        },
      ],
    });
    assert.equal(partialConfirm.status, 'EXECUTED');
    assert.equal(rowsByTable.vouchers.length, 2);

    // Controller cancel stops a workflow cleanly without DB changes
    let ctrlStatus = 0;
    let ctrlJson = null;
    await confirmOperation(
      {
        params: { workspaceId: wsId },
        query: {},
        headers: {},
        body: { workflow_id: planRes.workflow_id, action: 'cancel' },
      },
      {
        status(code) {
          ctrlStatus = code;
          return this;
        },
        json(payload) {
          ctrlJson = payload;
          return payload;
        },
      },
      (err) => {
        if (err) throw err;
      }
    );

    assert.equal(ctrlStatus, 200);
    assert.equal(ctrlJson.status, 'CANCELLED');
    assert.equal(rowsByTable.vouchers.length, 2);

    await assert.rejects(
      () =>
        confirmWorkspaceOperation({
          workflowId: planRes.workflow_id,
          businessId: wsId,
          confirm: true,
        }),
      (err) => err.statusCode === 409
    );
  } finally {
    setWorkspaceGeminiGenerator(null);
    setPool(null);
    await clearDocumentsForBusiness(wsId);
    invalidateWorkspaceMetadataCache(wsId);
  }
});

test('6. Non-regression: promptReferencesWorkspaceDocument & intent precedence distinguish doc sync from plain sheet mutations and emails', async () => {
  const sampleDocs = [{ doc_id: 'd1', filename: 'Q4_Hires_Memo.pdf' }];

  assert.equal(
    promptReferencesWorkspaceDocument('Increase discount by 5% for all luxury shirts.', sampleDocs),
    false
  );
  assert.equal(
    promptReferencesWorkspaceDocument('Add employees from Q4 Hires Memo', sampleDocs),
    true
  );
  assert.equal(
    promptReferencesWorkspaceDocument('Remove rows listed in the uploaded file', []),
    true
  );

  setWorkspaceGeminiGenerator(null);
  const wsId = 'ws-route-guard-6';
  await ingestDocument({
    businessId: wsId,
    filename: 'Supplier_Rate_Sheet.pdf',
    mimeType: 'application/pdf',
    customPages: [{ page_number: 1, text: 'Rate changes: SKU-1 price 90.' }],
  });
  setPool({
    async query(sql) {
      if (String(sql).includes('FROM workspace_table_metadata')) {
        return { rows: [{ table_name: 'products', columns_profile: [] }] };
      }
      return { rows: [] };
    },
  });

  try {
    const bypassCheck = await tryRouteBasicTableMutation({
      businessId: wsId,
      entity: 'products',
      prompt: 'Update prices in this table from Supplier Rate Sheet.',
    });
    assert.equal(bypassCheck, null);

    const preserved = enforceOperationalIntentPrecedence(
      { intent: 'document_table_sync', entity: 'backorders_dataset' },
      'add all orders from Order_Manifest.pdf to the current table',
      [{ hybrid_score: 12 }],
      null,
      [{ filename: 'Order_Manifest.pdf' }],
      'backorders_dataset'
    );
    assert.equal(preserved.intent, 'document_table_sync');

    const upgradedEmail = enforceOperationalIntentPrecedence(
      { intent: 'document_table_sync', entity: 'orders' },
      'update orders from Delay_Notice.pdf and email customers',
      [{ hybrid_score: 12 }],
      null,
      [{ filename: 'Delay_Notice.pdf' }],
      'orders'
    );
    assert.equal(upgradedEmail.intent, 'cross_document_operation');
  } finally {
    setPool(null);
    await clearDocumentsForBusiness(wsId);
  }
});
