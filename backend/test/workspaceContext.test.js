const test = require('node:test');
const assert = require('node:assert/strict');

const {
  chunkDocumentPages,
  extractChunkEntities,
  isStructuredSheetDocument,
  listDocumentsForBusiness,
  clearDocumentsForBusiness,
} = require('../src/services/documentIngestionService');
const {
  inferSemanticRole,
  inferNestedStructure,
  normalizeProfileType,
  choosePrimaryIdentifier,
  redactSampleRows,
} = require('../src/services/workspaceTableMetadataService');
const {
  enforceOperationalIntentPrecedence,
} = require('../src/services/workspaceIntentRouter');
const { loadTableRowsForSchema } = require('../src/services/crossRagService');
const {
  validateReadPlan,
  executeReadQuery,
} = require('../src/services/workspaceReadService');
const {
  formatWorkspaceSupportContext,
} = require('../src/services/promptBuilderService');
const { setPool } = require('../db');
const { callGeminiModelWithSchema } = require('../src/services/geminiService');
const {
  explicitlyRequestsNotifications,
  executeWorkspaceOperation,
} = require('../src/services/socraticOperationsService');
const {
  isBasicTableQueryCandidate,
  isBasicTableMutationCandidate,
  resolveSingleTableTarget,
} = require('../src/services/fastTableQueryService');
const { buildSheetQueryPrompt } = require('../src/services/sheetQueryPromptBuilder');

test('document chunks retain source wording and add dynamic retrieval breadcrumbs', () => {
  const body =
    'If transit exceeds 48 hours from scheduled dispatch, a 10% voucher applies to Category B orders. Applies to: Category B orders.';
  const [chunk] = chunkDocumentPages(
    [
      {
        page_number: 1,
        text: `Fulfillment SLA Policy\n2. DELAYED SHIPMENTS\n${body}`,
      },
    ],
    {
      docId: 'doc-1',
      businessId: 'workspace-1',
      filename: 'fulfillment.pdf',
    }
  );

  assert.ok(chunk);
  assert.equal(chunk.raw_text.includes(body), true);
  assert.match(chunk.breadcrumb_header, /Document: Fulfillment SLA Policy/);
  assert.match(chunk.breadcrumb_header, /Section: 2\. DELAYED SHIPMENTS/);
  assert.match(chunk.breadcrumb_header, /Applies to:/);
  assert.match(chunk.breadcrumb_header, /48 hours/);
  assert.match(chunk.breadcrumb_header, /10%/);
  assert.match(chunk.breadcrumb_header, /Category B/);
  assert.equal(chunk.enriched_text, `${chunk.breadcrumb_header}\n${chunk.raw_text}`);
  assert.deepEqual(chunk.extracted_entities, extractChunkEntities(body));
  assert.match(chunk.locator, /Page 1 \/ Chunk 1/);
});

test('document chunks retain heading hierarchy and do not duplicate section records', () => {
  const chunks = chunkDocumentPages(
    [
      {
        page_number: 1,
        text: [
          '# Operations Manual',
          '## 3. Allocation Rules',
          'Allocate priority orders first.',
          '## 4. Notification Rules',
          'Notify buyers only after approval.',
        ].join('\n'),
      },
    ],
    {
      docId: 'doc-2',
      businessId: 'workspace-2',
      filename: 'operations.md',
    }
  );

  assert.equal(chunks.length, 3);
  assert.deepEqual(
    chunks.map((chunk) => chunk.section_title),
    [
      'Operations Manual',
      'Operations Manual > 3. Allocation Rules',
      'Operations Manual > 4. Notification Rules',
    ]
  );
  assert.equal(chunks[1].raw_text.includes('Notify buyers'), false);
});

test('metadata profiling normalizes types, detects semantic roles, and redacts contact sample values', () => {
  assert.equal(normalizeProfileType({ data_type: 'USER-DEFINED', udt_name: 'jsonb' }), 'jsonb');
  assert.equal(normalizeProfileType({ data_type: 'numeric', udt_name: 'numeric' }), 'numeric');
  assert.equal(
    inferSemanticRole({ column_name: 'contact_email', data_type: 'text', udt_name: 'text' }),
    'email'
  );
  assert.equal(
    inferSemanticRole({ column_name: 'available_units', data_type: 'integer', udt_name: 'int4' }),
    'quantity'
  );
  assert.deepEqual(
    inferNestedStructure(['{"M":3,"L":7}', '{"M":2,"XXL":5}']),
    {
      type: 'object_map',
      sampled_row_count: 2,
      observed_keys: [
        { name: 'M', observed_in_sample_count: 2, value_types: ['number'], nested_structure: null },
        { name: 'L', observed_in_sample_count: 1, value_types: ['number'], nested_structure: null },
        { name: 'XXL', observed_in_sample_count: 1, value_types: ['number'], nested_structure: null },
      ],
    }
  );
  assert.equal(
    choosePrimaryIdentifier(
      [{ column_name: 'account_id' }, { column_name: 'id' }],
      ['id'],
      { account_id: { distinct_count: 2 } },
      2
    ),
    'account_id'
  );
  assert.deepEqual(
    redactSampleRows(
      [{ account_id: 'ACC-1', company_name: 'Example Co', contact_email: 'person@example.test' }],
      'contact_email'
    ),
    [{ account_id: 'ACC-1', company_name: 'Example Co' }]
  );
});

test('search-led prompts with write directives cannot be downgraded to read-only queries', () => {
  const routed = { intent: 'sheet_query', entity: 'orders' };
  assert.equal(
    enforceOperationalIntentPrecedence(
      routed,
      'Find delayed orders and update their status per the recall policy.',
      [{ hybrid_score: 12 }]
    ).intent,
    'cross_document_operation'
  );
  assert.equal(
    enforceOperationalIntentPrecedence(
      routed,
      'Find all luxury shirts and list their prices.',
      []
    ).intent,
    'sheet_query'
  );
});

test('workspace reply context excludes contact details from retrieved table rows', () => {
  const context = formatWorkspaceSupportContext({
    table_rows: [
      {
        table_name: 'hospital_units',
        row_identifier: 'UNIT-1',
        row: {
          unit_name: 'Intensive Care',
          contact_email: 'nurse@example.test',
          staffed_beds: 8,
        },
      },
    ],
  });

  assert.match(context, /Intensive Care/);
  assert.match(context, /staffed_beds: 8/);
  assert.doesNotMatch(context, /nurse@example\.test/);
});

test('policy identifiers that are absent from row keys do not suppress relevant table rows', async () => {
  const calls = [];
  const schema = {
    entity: 'accounts',
    tableName: 'accounts',
    columns: {
      account_id: { exactName: 'Account_ID', type: 'string' },
      overdue_balance: { exactName: 'Overdue_Balance', type: 'number' },
      current_tier: { exactName: 'Current_Tier', type: 'string' },
    },
  };
  const expectedRows = [
    { business_id: 'workspace-1', Account_ID: 'ACC-1004', Overdue_Balance: 1850, Current_Tier: 'Silver' },
  ];
  setPool({
    async query(sql, values) {
      calls.push({ sql, values });
      return { rows: calls.length === 1 ? [] : expectedRows, rowCount: calls.length === 1 ? 0 : 1 };
    },
  });
  try {
    const rows = await loadTableRowsForSchema('workspace-1', schema, {
      metadata: {
        columns_profile: [
          { column_name: 'Account_ID', semantic_role: 'identifier' },
          { column_name: 'Overdue_Balance', semantic_role: 'financial_metric' },
          { column_name: 'Current_Tier', semantic_role: 'descriptive_text' },
        ],
      },
      queryText: 'Apply FIN-POL-008 to accounts with overdue balances',
      identifierValues: ['ACC-1004'],
    });

    assert.equal(calls.length, 2);
    assert.match(calls[0].sql, /ILIKE/);
    assert.match(calls[0].sql, /Account_ID/);
    assert.ok(calls[0].values.includes('FIN-POL-008'));
    assert.ok(calls[0].values.includes('ACC-1004'));
    assert.doesNotMatch(calls[1].sql, /ILIKE/);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].Account_ID, 'ACC-1004');
  } finally {
    setPool(null);
  }
});

test('analytical requests route read-only unless the user issues an explicit action', () => {
  assert.equal(
    enforceOperationalIntentPrecedence(
      { intent: 'cross_document_operation' },
      'Which orders need a batch swap under the recall policy?',
      [{ hybrid_score: 9 }]
    ).intent,
    'cross_source_read'
  );
  assert.equal(
    enforceOperationalIntentPrecedence(
      { intent: 'cross_source_read' },
      'Find recalled orders and update their shipping status per the recall policy.',
      [{ hybrid_score: 9 }]
    ).intent,
    'cross_document_operation'
  );
});

test('read-plan SQL scopes tenants, parameterizes values, and computes arithmetic in PostgreSQL', async () => {
  const calls = [];
  const table = {
    tableName: 'hospital_units',
    schema: {
      entity: 'hospital_units',
      tableName: 'hospital_units',
      columns: {
        business_id: { exactName: 'business_id', type: 'uuid', queryable: false, operators: [] },
        status: {
          exactName: 'Unit_Status',
          type: 'string',
          queryable: true,
          operators: ['equals', 'not_equals', 'contains', 'not_contains', 'starts_with', 'ends_with', 'in'],
        },
        department: {
          exactName: 'Department',
          type: 'string',
          queryable: true,
          operators: ['equals', 'not_equals', 'contains', 'not_contains', 'starts_with', 'ends_with', 'in'],
        },
        staffed_beds: {
          exactName: 'Staffed_Beds',
          type: 'integer',
          queryable: true,
          operators: ['equals', 'not_equals', 'greater_than', 'greater_than_or_equal', 'less_than', 'less_than_or_equal', 'between'],
        },
        occupied_beds: {
          exactName: 'Occupied_Beds',
          type: 'integer',
          queryable: true,
          operators: ['equals', 'not_equals', 'greater_than', 'greater_than_or_equal', 'less_than', 'less_than_or_equal', 'between'],
        },
      },
    },
  };
  assert.throws(
    () =>
      validateReadPlan(
        {
          table_queries: [
            {
              table_name: 'hospital_units',
              filters: [
                { field: 'Department', operator: 'equals', value: 'ICU' },
              ],
            },
          ],
        },
        [table],
        'Which ICU units qualify? Calculate staffed beds minus occupied beds and exclude units below the threshold.'
      ),
    /requires an arithmetic eligibility condition/
  );
  const [documentDerivedPlan] = validateReadPlan(
    {
      table_queries: [
        {
          table_name: 'hospital_units',
          filters: [
            { field: 'Department', operator: 'equals', value: 'ICU' },
          ],
        },
      ],
    },
    [table],
    'Which ICU units satisfy the surge-ready rule?',
    [{ raw_text: 'A unit is eligible when staffed_beds - occupied_beds >= 2.' }]
  );
  assert.equal(documentDerivedPlan.calculationFilters.length, 1);
  assert.equal(documentDerivedPlan.calculationFilters[0].operator, 'greater_than_or_equal');
  assert.equal(documentDerivedPlan.calculationFilters[0].value, 2);

  const [plan] = validateReadPlan(
    {
      table_queries: [
        {
          table_name: 'hospital_units',
          filters: [
            {
              field: 'Unit_Status',
              operator: 'equals',
              value: "Processing' OR 1=1 --",
            },
            {
              field: 'Department',
              operator: 'equals',
              value: 'ICU',
            },
          ],
          filter_logic: 'OR',
          calculation_filters: [
            {
              operation: 'subtract',
              fields: ['Staffed_Beds', 'Occupied_Beds'],
              operator: 'greater_than_or_equal',
              value: '2',
            },
          ],
          sort: [{ field: 'Staffed_Beds', direction: 'desc' }],
          limit: 25,
          aggregates: [{ operation: 'count' }],
          calculations: [
            {
              operation: 'subtract',
              fields: ['Staffed_Beds', 'Occupied_Beds'],
              aggregate: 'sum',
            },
          ],
        },
      ],
    },
    [table],
    'Which units are processing and what is their total bed difference?'
  );
  setPool({
    async query(sql, values) {
      calls.push({ sql, values });
      return {
        rows: [
          {
            _row_count: '1',
            _aggregate_1: '1',
            _calculation_aggregate_1: '2',
            _rows: [
              {
                unit_id: 'HICU-01',
                Staffed_Beds: 20,
                Occupied_Beds: 18,
                _calculation_1: 2,
              },
            ],
          },
        ],
      };
    },
  });
  try {
    const result = await executeReadQuery('workspace-1', plan);
    assert.equal(calls.length, 1);
    assert.match(calls[0].sql, /"business_id" = \$1/);
    assert.match(calls[0].sql, /LOWER\("Unit_Status"\) = LOWER\(\$2\)/);
    assert.match(calls[0].sql, /LOWER\("Unit_Status"\) = LOWER\(\$2\) OR LOWER\("Department"\) = LOWER\(\$3\)/);
    assert.match(calls[0].sql, /AND \(\("Staffed_Beds" - "Occupied_Beds"\) >= \$4\)\)/);
    assert.doesNotMatch(calls[0].sql, /Processing' OR 1=1/);
    assert.ok(calls[0].values.includes("Processing' OR 1=1 --"));
    assert.equal(result.rows[0]._calculation_1, 2);
    assert.equal(result.summary._calculation_aggregate_1, '2');
  } finally {
    setPool(null);
  }
});

test('read planner refuses unfiltered queries unless a whole-table result was requested', () => {
  const table = {
    tableName: 'accounts',
    schema: {
      entity: 'accounts',
      tableName: 'accounts',
      columns: {
        business_id: { exactName: 'business_id', type: 'uuid', queryable: false, operators: [] },
      },
    },
  };
  assert.throws(
    () => validateReadPlan({ table_queries: [{ table_name: 'accounts' }] }, [table], 'Which accounts are overdue?'),
    /must include document- or user-grounded filters/
  );
});

test('Gemini requests retry one transient network failure and enforce a bounded timeout signal', async () => {
  const originalFetch = global.fetch;
  let attempts = 0;
  global.fetch = async (_url, options) => {
    attempts += 1;
    assert.ok(options.signal);
    if (attempts === 1) throw new TypeError('connection reset');
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          candidates: [{ content: { parts: [{ text: '{"answer":"ok"}' }] } }],
        };
      },
    };
  };
  try {
    const result = await callGeminiModelWithSchema(
      'test-model',
      'test-key',
      'return json',
      null
    );
    assert.equal(result, '{"answer":"ok"}');
    assert.equal(attempts, 2);
  } finally {
    global.fetch = originalFetch;
  }
});

test('explicitlyRequestsNotifications detects multi-modifier, role, proper-name, and email targets without false positives', () => {
  const positivePrompts = [
    'email all affected customers their updated fulfillment details.',
    'email the affected customers and Dhaka/Chittagong hub leads.',
    'email the affected backorder buyers.',
    'email each vendor contact_email with their QC failure tally.',
    'email all qualifying Account Managers.',
    'email all affected Account Managers.',
    'email Arthur Pendelton and Haruto Sato.',
    'email the affected charge nurses and nursing coordinator.',
    'email charge.pcu@example.test, charge.ed@example.test, and nursing.ops@example.test.',
    'Send personalized notification emails via email to affected accounts.',
  ];
  for (const prompt of positivePrompts) {
    assert.equal(explicitlyRequestsNotifications(prompt), true, prompt);
  }

  const negativePrompts = [
    "In orders, update Shipping_Tier to 'Priority Cold-Chain' for Order_ID ORD-2026-1028.",
    'List overdue accounts showing contact_email and overdue_balance.',
    'Update contact_email for ACC-1001 to ops@example.test.',
    'Swap defective orders to B-501 and do not email customers.',
    'Update PO statuses without notifying buyers or sending emails.',
  ];
  for (const prompt of negativePrompts) {
    assert.equal(explicitlyRequestsNotifications(prompt), false, prompt);
  }
});

test('read-plan does not inject surge arithmetic filters onto unrelated aggregate/unit queries when another table says eligible', () => {
  const hospitalUnits = {
    tableName: 'hospital_units',
    schema: {
      entity: 'hospital_units',
      tableName: 'hospital_units',
      columns: {
        business_id: { exactName: 'business_id', type: 'uuid', queryable: false, operators: [] },
        unit_id: { exactName: 'unit_id', type: 'string', queryable: true, operators: ['equals', 'in'] },
        department: { exactName: 'department', type: 'string', queryable: true, operators: ['equals', 'in'] },
        staffed_beds: { exactName: 'staffed_beds', type: 'integer', queryable: true, operators: ['greater_than_or_equal'] },
        occupied_beds: { exactName: 'occupied_beds', type: 'integer', queryable: true, operators: ['greater_than_or_equal'] },
      },
    },
  };
  const floatRoster = {
    tableName: 'nursing_float_roster',
    schema: {
      entity: 'nursing_float_roster',
      tableName: 'nursing_float_roster',
      columns: {
        business_id: { exactName: 'business_id', type: 'uuid', queryable: false, operators: [] },
        nurse_id: { exactName: 'nurse_id', type: 'string', queryable: true, operators: ['equals'] },
        availability_status: { exactName: 'availability_status', type: 'string', queryable: true, operators: ['equals'] },
      },
    },
  };
  const plans = validateReadPlan(
    {
      table_queries: [
        {
          table_name: 'hospital_units',
          filters: [{ field: 'department', operator: 'in', value: '["ICU","Emergency","Infectious Disease"]' }],
        },
        {
          table_name: 'nursing_float_roster',
          filters: [{ field: 'availability_status', operator: 'equals', value: 'Available' }],
        },
      ],
    },
    [hospitalUnits, floatRoster],
    'Compute combined Adult ICU clean_beds total and list Available float nurses eligible without overtime restrictions.',
    [{ raw_text: 'A unit is eligible when staffed_beds - occupied_beds >= 2.' }]
  );
  assert.equal(plans[0].calculationFilters.length, 0);
  assert.equal(plans[1].calculationFilters.length, 0);
});

test('fast table query classifier admits single-table read queries and rejects B2B/policy/mutation prompts', () => {
  const fastQueries = [
    'show products with discount higher than 25% and priced higher than 1300',
    'show all luxury shirts with stock lower than 5',
    'show orders with buyer tier priority and already shipped',
    'Show all Silver tier accounts in wholesale_accunts_dataset in Europe or APAC with overdue_balance = 0 and annual_spend >= 8000, sorted by annual_spend descending.',
  ];
  for (const prompt of fastQueries) {
    assert.equal(isBasicTableQueryCandidate(prompt), true, prompt);
  }

  const b2bOrMutationPrompts = [
    'List all Delayed orders in orders.csv sorted by Delay_Hours descending where Delay_Hours >= 48 and SLA_Voucher_Issued is False, and cross-check QA_Batch_Recall and warehouse_inventory_batches.csv.',
    'Which purchase orders breach the >= 95.0% AQL threshold in Veloura_Wholesale_Returns_and_Vendor_Defect_SLA.pdf?',
    'According to Allocation Priority Policy.pdf, what are the Core-Size Reserve rules?',
    'In orders, update Shipping_Tier to Priority Cold-Chain for ORD-2026-1028.',
    'Find all undelivered Processing orders containing B-404 and email all affected customers.',
    'Hello!',
  ];
  for (const prompt of b2bOrMutationPrompts) {
    assert.equal(isBasicTableQueryCandidate(prompt), false, prompt);
  }
});

test('basic mutation classifier accepts direct table changes but preserves RAG and conversation routes', () => {
  for (const prompt of [
    'Increase discount by 5% for all luxury shirts.',
    'Set best to true for products ordered at least twice.',
    'Reduce price by 200 for items with a discount of 25% or more.',
  ]) {
    assert.equal(isBasicTableMutationCandidate(prompt), true, prompt);
  }

  for (const prompt of [
    'According to the Allocation Priority Policy, update backorder allocations.',
    'Update orders based on the supplier delay notice and email customers.',
    'Update products based on orders in the backorders dataset.',
    'Reconcile backorders against products and update remaining stock.',
    'Show products with discount above 25%.',
  ]) {
    assert.equal(isBasicTableMutationCandidate(prompt), false, prompt);
  }
  assert.equal(
    isBasicTableMutationCandidate('Increase the discount to 10% for those.', [
      { role: 'user', content: 'Show luxury shirts.' },
    ]),
    false
  );
});

test('workspace operation routes a table-local mutation before RAG', async () => {
  const calls = [];
  setPool({
    async query(sql, values) {
      calls.push({ sql, values });
      return {
        rows: [
          {
            table_name: 'products',
            columns_profile: [
              { column_name: 'category', categorical_values: ['luxury shirt', 'polo'] },
              { column_name: 'discount', categorical_values: [] },
            ],
          },
        ],
      };
    },
  });
  try {
    const result = await executeWorkspaceOperation({
      businessId: 'workspace-1',
      entity: 'products',
      prompt: 'Increase discount by 5% for all luxury shirts.',
    });
    assert.equal(result.status, 'SHEET_MUTATION');
    assert.equal(result.entity, 'products');
    assert.equal(result.fast_path, true);
    assert.equal(calls.length, 1);
    assert.match(calls[0].sql, /FROM workspace_table_metadata/i);
  } finally {
    setPool(null);
  }
});

test('compact sheet interpretation prompt preserves dynamic schema while reducing static prompt size', () => {
  const schema = {
    entity: 'patients',
    tableName: 'patients',
    primaryKey: 'Patient_ID',
    columns: {
      patient_id: { exactName: 'Patient_ID', type: 'string', queryable: true, modifiable: false },
      bmi: { exactName: 'BMI', type: 'number', queryable: true, modifiable: true },
      status: { exactName: 'Care_Status', type: 'string', queryable: true, modifiable: true },
      notes: { exactName: 'Clinical_Notes', type: 'string', queryable: true, modifiable: true },
    },
    representativeValues: {
      Care_Status: ['Active', 'Monitoring'],
    },
  };
  const args = {
    entity: schema.entity,
    schema,
    message: 'Find patients with BMI higher than 40.',
    isMutation: false,
  };
  const compact = buildSheetQueryPrompt({ ...args, compactPrompt: true });
  const full = buildSheetQueryPrompt(args);
  assert.ok(compact.length < full.length);
  assert.match(compact, /Patient_ID \(string\)/);
  assert.match(compact, /BMI \(number\)/);
  assert.match(compact, /Care_Status \(string\)/);
  assert.match(compact, /greater_than_or_equal/);
  assert.match(compact, /clarification_needed/);
});

test('compact mutation prompt preserves existing-key and confirmation-scope safeguards', () => {
  const schema = {
    entity: 'inventory',
    tableName: 'inventory',
    primaryKey: 'Product_ID',
    columns: {
      product_id: { exactName: 'Product_ID', type: 'string', queryable: true, modifiable: false },
      stock: { exactName: 'Stock', type: 'integer', queryable: true, modifiable: true },
      size: {
        exactName: 'Size',
        type: 'json',
        queryable: true,
        modifiable: true,
        nestedMap: true,
        nestedStructure: { M: 'integer', L: 'integer' },
      },
    },
    representativeValues: { Stock: [3, 5, 8] },
  };
  const args = {
    entity: schema.entity,
    schema,
    message: 'Add 10 to all existing size values for luxury shirts.',
    isMutation: true,
  };
  const compact = buildSheetQueryPrompt({ ...args, compactPrompt: true });
  const full = buildSheetQueryPrompt(args);
  assert.ok(compact.length < full.length);
  assert.match(compact, /Size \(json\)/);
  assert.match(compact, /existing_keys_only/);
  assert.match(compact, /never create missing keys/i);
  assert.match(compact, /match_all:true only on an explicit request/i);
  assert.match(compact, /clarification_needed/);
});

test('resolveSingleTableTarget selects the matching workspace table using adjacent metadata even when activeEntity differs', () => {
  const velouraMetadata = [
    {
      table_name: 'products',
      columns_profile: [
        { column_name: 'name', categorical_values: [] },
        { column_name: 'category', categorical_values: ['luxury shirt', 'polo', 'shirt'] },
        { column_name: 'discount', categorical_values: [] },
        { column_name: 'price', categorical_values: [] },
        { column_name: 'size', categorical_values: [], nested_structure: { observed_keys: [{ name: 'M' }, { name: 'L' }] } },
      ],
    },
    {
      table_name: 'backorders_dataset',
      columns_profile: [
        { column_name: 'backorder_id', categorical_values: [] },
        { column_name: 'buyer_tier', categorical_values: ['Priority', 'Standard'] },
        { column_name: 'fulfillment_status', categorical_values: ['Pending', 'Fulfilled', 'Shipped', 'On Hold'] },
      ],
    },
    {
      table_name: 'supplier_purchase_orders',
      columns_profile: [
        { column_name: 'po_id', categorical_values: [] },
        { column_name: 'qc_pass_rate_pct', categorical_values: [] },
        { column_name: 'po_status', categorical_values: ['In Transit - Sea', 'Cleared Air-Freight'] },
      ],
    },
  ];

  assert.equal(
    resolveSingleTableTarget(
      'show products with discount higher than 25% and priced higher than 1300',
      'products',
      velouraMetadata
    )?.meta.table_name,
    'products'
  );
  assert.equal(
    resolveSingleTableTarget(
      'show all luxury shirts with stock lower than 5',
      'backorders_dataset',
      velouraMetadata
    )?.meta.table_name,
    'products'
  );
  assert.equal(
    resolveSingleTableTarget(
      'show orders with buyer tier priority and already shipped',
      'products',
      velouraMetadata
    )?.meta.table_name,
    'backorders_dataset'
  );
  // External table reference outside active workspace returns null (bails out safely)
  assert.equal(
    resolveSingleTableTarget(
      'show all accounts in wholesale_accunts_dataset with overdue_balance > 0',
      'products',
      velouraMetadata
    ),
    null
  );
  // Column names ending in _units must not be mistaken for external table names
  assert.equal(
    resolveSingleTableTarget(
      'show warehouse inventory batches at Dhaka Central with Available_Units greater than 50',
      'orders',
      [
        {
          table_name: 'orders',
          columns_profile: [{ column_name: 'Fulfillment_Hub', categorical_values: ['Dhaka Central'] }],
        },
        {
          table_name: 'warehouse_inventory_batches',
          columns_profile: [
            { column_name: 'Fulfillment_Hub', categorical_values: ['Dhaka Central'] },
            { column_name: 'Available_Units', categorical_values: [] },
          ],
        },
      ]
    )?.meta.table_name,
    'warehouse_inventory_batches'
  );
});

test('listDocumentsForBusiness excludes Google Sheets and CSV metadata entries from policy docs', async () => {
  const wsId = '00000000-0000-4000-8000-000000000768';
  await clearDocumentsForBusiness(wsId);

  assert.equal(
    isStructuredSheetDocument({
      filename: 'diabetes',
      mime_type: 'application/vnd.google-apps.spreadsheet',
      chunk_count: 768,
      full_text: 'Google Sheet for table diabetes',
    }),
    true
  );
  assert.equal(
    isStructuredSheetDocument({
      filename: 'orders.csv',
      mime_type: 'text/csv',
      chunk_count: 32,
      full_text: 'CSV sheet for table orders',
    }),
    true
  );
  assert.equal(
    isStructuredSheetDocument({
      filename: 'Hospital Bed Allocation Policy.pdf',
      mime_type: 'application/pdf',
      chunk_count: 11,
      full_text: 'Policy content...',
    }),
    false
  );
  assert.equal(
    isStructuredSheetDocument({
      filename: 'Ops_Notice.gdoc',
      mime_type: 'application/vnd.google-apps.document',
      chunk_count: 4,
      full_text: 'Google Doc notice...',
    }),
    false
  );

  const mockQueries = [];
  setPool({
    async query(sql, params) {
      mockQueries.push({ sql, params });
      if (/DELETE FROM workspace_documents/i.test(sql)) {
        return { rowCount: 1, rows: [] };
      }
      if (/SELECT[\s\S]*FROM workspace_documents/i.test(sql)) {
        return {
          rowCount: 3,
          rows: [
            {
              doc_id: 'sheet-doc-768',
              filename: 'diabetes',
              mime_type: 'application/vnd.google-apps.spreadsheet',
              chunk_count: 768,
              full_text: 'Google Sheet for table diabetes',
            },
            {
              doc_id: 'policy-1',
              filename: 'Hospital Bed Allocation Policy.pdf',
              mime_type: 'application/pdf',
              chunk_count: 11,
              full_text: 'Allocation rules',
            },
            {
              doc_id: 'gdoc-1',
              filename: 'Shift_Brief.gdoc',
              mime_type: 'application/vnd.google-apps.document',
              chunk_count: 5,
              full_text: 'Shift brief',
            },
          ],
        };
      }
      return { rowCount: 0, rows: [] };
    },
  });

  try {
    const docs = await listDocumentsForBusiness(wsId);
    assert.deepEqual(
      docs.map((d) => d.filename),
      ['Hospital Bed Allocation Policy.pdf', 'Shift_Brief.gdoc']
    );
    assert.ok(
      mockQueries.some((q) => /DELETE FROM workspace_documents/i.test(q.sql)),
      'Expected cleanup query for legacy structured sheet rows in workspace_documents'
    );
  } finally {
    await clearDocumentsForBusiness(wsId);
    setPool(null);
  }
});
