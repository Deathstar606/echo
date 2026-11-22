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
  listWorkspaceTableMetadataCached,
  invalidateWorkspaceMetadataCache,
} = require('../src/services/workspaceTableMetadataService');
const {
  discoverTableSchema,
  getOperatorsForType,
} = require('../src/services/sheetSchemaService');
const {
  serializeTableForPrompt,
  SCHEMA_TRUTH_PRECEDENCE_RULE,
} = require('../src/utils/schemaPromptSerializer');
const {
  enforceOperationalIntentPrecedence,
  isUnambiguousCrossSourceReadCandidate,
  formatWorkspaceSources,
} = require('../src/services/workspaceIntentRouter');
const { loadTableRowsForSchema } = require('../src/services/crossRagService');
const {
  selectRelevantTablesForRead,
  selectPassagesForRead,
  validateReadPlan,
  executeReadQuery,
  executeDependentLookupQuery,
  joinAndEvaluateCrossTableComparisons,
} = require('../src/services/workspaceReadService');
const {
  formatWorkspaceSupportContext,
} = require('../src/services/promptBuilderService');
const { setPool } = require('../db');
const env = require('../src/config/env');
const {
  callGeminiModelWithSchema,
  generateStructuredJsonWithRetry,
  setWorkspaceGeminiGenerator,
} = require('../src/services/geminiService');
const {
  explicitlyRequestsNotifications,
  requestsFullAudienceNotification,
  requiresConditionalPolicyEvaluation,
  findSecondaryTablesReferencedByMetadata,
  shouldUseSingleTableDirectEmailFastPath,
  compileResolutionPreview,
  executeWorkspaceOperation,
} = require('../src/services/socraticOperationsService');
const {
  isBasicTableQueryCandidate,
  isBasicTableMutationCandidate,
  promptSpansMultipleWorkspaceTables,
  requiresRelationalOrColumnComparison,
  resolveSingleTableTarget,
  arePromptConceptsCoveredByTable,
  tryExecuteFastTableQuery,
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

test('isUnambiguousCrossSourceReadCandidate handles underscore PDF filenames while guarding clarification replies', () => {
  const tables = [
    { tableName: 'raised_by_society_beanies_catalog', displayName: 'Raised By Society Beanies Catalog' },
  ];
  const docs = [{ filename: 'Raised_By_Society_Refund_Policy.pdf' }];
  const chunks = [{ filename: 'Raised_By_Society_Refund_Policy.pdf', hybrid_score: 6.5 }];

  assert.equal(
    isUnambiguousCrossSourceReadCandidate(
      'Which wool Short Beanies priced at 45 have fewer than 16 units in stock, and according to Raised_By_Society_Refund_Policy.pdf, what is the free shipping threshold?',
      tables,
      chunks,
      docs,
      { pendingClarification: null }
    ),
    true
  );

  // Never hijack an active clarification turn or action command
  assert.equal(
    isUnambiguousCrossSourceReadCandidate(
      'Which ones need update according to Raised_By_Society_Refund_Policy.pdf?',
      tables,
      chunks,
      docs,
      { pendingClarification: { baseIntent: 'SHEET_MUTATION' } }
    ),
    false
  );
  assert.equal(
    isUnambiguousCrossSourceReadCandidate(
      'Find delayed orders and issue vouchers per Raised_By_Society_Refund_Policy.pdf',
      tables,
      chunks,
      docs,
      null
    ),
    false
  );
});

test('selectRelevantTablesForRead prunes unrelated tables while preserving document-referenced multi-table joins', () => {
  const hospitalUnits = {
    tableName: 'hospital_units',
    displayName: 'Hospital Units',
    schema: {
      columns: {
        unit_id: { exactName: 'unit_id' },
        staffing_gap: { exactName: 'staffing_gap' },
        surge_status: { exactName: 'surge_status' },
      },
      representativeValues: { surge_status: ['Normal', 'High Occupancy'] },
    },
  };
  const floatRoster = {
    tableName: 'nursing_float_roster',
    displayName: 'Nursing Float Roster',
    schema: {
      columns: { nurse_id: { exactName: 'nurse_id' }, availability_status: { exactName: 'availability_status' } },
      representativeValues: {},
    },
  };
  const dengue = {
    tableName: 'dengue_prediction_dataset',
    displayName: 'Dengue Prediction Dataset',
    schema: {
      columns: { month: { exactName: 'month' }, temp: { exactName: 'temp' }, infected: { exactName: 'infected' } },
      representativeValues: {},
    },
  };

  // Document excerpt mentions nursing_float_roster implicitly; dengue has 0 overlap and must be pruned
  const kept = selectRelevantTablesForRead(
    [dengue, hospitalUnits, floatRoster],
    'Which hospital units have a staffing_gap or surge_status risk under the Bed Policy?',
    [
      {
        filename: 'Hospital Bed Allocation Policy.pdf',
        hybrid_score: 5.2,
        raw_text: 'Assign nurses from nursing_float_roster when staffing_gap exceeds 1.',
      },
    ],
    null
  );
  assert.deepEqual(
    kept.map((t) => t.tableName),
    ['hospital_units', 'nursing_float_roster']
  );
});

test('selectPassagesForRead filters zero-score chunks when positive matches exist and retains page diversity', () => {
  const chunks = [
    { filename: 'Policy.pdf', page_number: 1, chunk_index: 0, hybrid_score: 8, raw_text: 'Page 1 rule' },
    { filename: 'Policy.pdf', page_number: 1, chunk_index: 1, hybrid_score: 5, raw_text: 'Page 1 detail' },
    { filename: 'Policy.pdf', page_number: 2, chunk_index: 2, hybrid_score: 4, raw_text: 'Page 2 addendum' },
    { filename: 'Other.pdf', page_number: 1, chunk_index: 0, hybrid_score: 0, raw_text: 'Irrelevant noise' },
  ];

  const selected = selectPassagesForRead(chunks, { maxChunks: 3, maxChars: 200 });
  assert.equal(selected.length, 3);
  assert.equal(selected.some((p) => p.text === 'Irrelevant noise'), false);
  assert.equal(selected.some((p) => p.page === 2), true);

  // Generic prompt fallback when all scores are 0
  const allZero = [
    { filename: 'Policy.pdf', page_number: 1, chunk_index: 0, hybrid_score: 0, raw_text: 'Fallback chunk' },
  ];
  assert.equal(selectPassagesForRead(allZero, { maxChunks: 3, maxChars: 200 }).length, 1);
});

test('duck-typed BoundPool cache caches metadata and schemas and clears on invalidation', async () => {
  const wsId = '00000000-0000-4000-8000-000000000901';
  let queryCount = 0;
  const boundPoolLike = {
    async connect() {
      return { query: async () => ({ rows: [] }), release() {} };
    },
    async query(sql) {
      queryCount += 1;
      if (/FROM workspace_table_metadata/i.test(sql)) {
        return {
          rows: [
            {
              table_name: 'orders',
              primary_key_column: 'order_id',
              columns_profile: [
                { column_name: 'order_id', data_type: 'text', semantic_role: 'identifier', categorical_values: ['ORD-1'] },
                { column_name: 'status', data_type: 'text', semantic_role: 'status_flag', categorical_values: ['Pending', 'Shipped'] },
              ],
            },
          ],
        };
      }
      if (/FROM information_schema\.columns/i.test(sql)) {
        return {
          rows: [
            { column_name: 'business_id', data_type: 'uuid', udt_name: 'uuid', is_nullable: 'NO' },
            { column_name: 'order_id', data_type: 'text', udt_name: 'text', is_nullable: 'NO' },
            { column_name: 'status', data_type: 'text', udt_name: 'text', is_nullable: 'YES' },
          ],
        };
      }
      return { rows: [] };
    },
  };
  Object.defineProperty(boundPoolLike.constructor, 'name', { value: 'BoundPool', configurable: true });
  setPool(boundPoolLike);
  try {
    const firstMeta = await listWorkspaceTableMetadataCached(wsId);
    const secondMeta = await listWorkspaceTableMetadataCached(wsId);
    assert.equal(firstMeta.length, 1);
    assert.equal(secondMeta.length, 1);
    assert.equal(queryCount, 1);

    await discoverTableSchema('orders', wsId, { prefetchedMetadata: firstMeta[0] });
    await discoverTableSchema('orders', wsId);
    assert.equal(queryCount, 2);

    invalidateWorkspaceMetadataCache(wsId);
    await listWorkspaceTableMetadataCached(wsId);
    assert.equal(queryCount, 3);
  } finally {
    setPool(null);
  }
});

test('serializeTableForPrompt strips prose, JSON blobs, UUIDs, and system columns while keeping compact enums', () => {
  const serialized = serializeTableForPrompt({
    tableName: 'products',
    displayName: 'Products',
    rowCount: 20,
    metadata: {
      table_summary: 'Products catalog summary',
      primary_key_column: 'id',
      email_column: 'vendor_email',
      columns_profile: [
        {
          column_name: 'id',
          data_type: 'text',
          semantic_role: 'identifier',
          categorical_values: ['045daf64-e2b4-4068-bce0-97dfdfb34ab9'],
        },
        {
          column_name: 'description',
          data_type: 'text',
          semantic_role: 'descriptive_text',
          categorical_values: ['A'.repeat(180)],
        },
        {
          column_name: 'size',
          data_type: 'jsonb',
          semantic_role: 'json_map',
          categorical_values: ['{"L": 4, "M": 2}'],
          nested_structure: { observed_keys: [{ name: 'M' }, { name: 'L' }] },
        },
        {
          column_name: 'category',
          data_type: 'text',
          semantic_role: 'descriptive_text',
          categorical_values: ['luxury shirt', 'A'.repeat(75)],
        },
        {
          column_name: 'price',
          data_type: 'numeric',
          semantic_role: 'financial_metric',
          categorical_values: ['990', '4990'],
          numeric_stats: { min: 990, max: 4990 },
        },
        { column_name: 'vendor_email', data_type: 'text', semantic_role: 'email', categorical_values: ['a@b.test'] },
        { column_name: 'created_at', data_type: 'date', semantic_role: 'descriptive_text', categorical_values: ['2026-11-12 17:04:26+00'] },
      ],
    },
    schema: {
      columns: {
        id: { exactName: 'id', type: 'uuid', modifiable: false, queryable: true },
        business_id: { exactName: 'business_id', type: 'uuid', modifiable: false, queryable: true },
        created_at: { exactName: 'created_at', type: 'date', modifiable: false, queryable: true },
        description: { exactName: 'description', type: 'string', modifiable: true, queryable: true },
        size: { exactName: 'size', type: 'json', modifiable: true, queryable: true },
        category: { exactName: 'category', type: 'string', modifiable: true, queryable: true },
        price: { exactName: 'price', type: 'number', modifiable: true, queryable: true },
        vendor_email: { exactName: 'vendor_email', type: 'string', modifiable: true, queryable: true },
      },
    },
  });

  const colNames = serialized.columns.map((c) => c.name);
  assert.equal(colNames.includes('business_id'), false);
  assert.equal(colNames.includes('created_at'), false);
  assert.equal(colNames.includes('id'), true);
  assert.equal(serialized.columns.find((c) => c.name === 'id').examples, undefined);
  assert.equal(serialized.columns.find((c) => c.name === 'description').values, undefined);
  const sizeCol = serialized.columns.find((c) => c.name === 'size');
  assert.equal(sizeCol.values, undefined);
  assert.deepEqual(sizeCol.nested_keys, ['M', 'L']);
  const catCol = serialized.columns.find((c) => c.name === 'category');
  assert.equal(catCol.values[0], 'luxury shirt');
  assert.equal(catCol.values[1].length, 50);
  assert.deepEqual(serialized.columns.find((c) => c.name === 'price').range, [990, 4990]);
  assert.equal(serialized.columns.find((c) => c.name === 'vendor_email').values, undefined);
  assert.equal(serialized.primary_key, 'id');
  assert.equal(serialized.email_column, 'vendor_email');
});

test('scoring fix eliminates orders double-count tie and coverage gate routes conceptual words to route_and_plan', () => {
  const velouraMeta = [
    {
      table_name: 'products',
      columns_profile: [{ column_name: 'category', categorical_values: ['polo', 'shirt'] }],
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
        { column_name: 'po_status', categorical_values: ['In Transit - Sea'] },
      ],
    },
  ];

  const target = resolveSingleTableTarget(
    'Find all the priority orders that have been delayed',
    'backorders_dataset',
    velouraMeta
  );
  assert.equal(target?.meta.table_name, 'backorders_dataset');

  assert.equal(
    arePromptConceptsCoveredByTable('show orders with buyer tier priority and already shipped', velouraMeta[1]),
    true
  );
  assert.equal(
    arePromptConceptsCoveredByTable('Find all the priority orders that have been delayed', velouraMeta[1]),
    false
  );
  assert.equal(
    arePromptConceptsCoveredByTable('Find all orders delayed more than 48 hours', {
      table_name: 'orders',
      columns_profile: [{ column_name: 'delay_hours', categorical_values: [] }],
    }),
    true
  );
});

test('enforceOperationalIntentPrecedence keeps ungrounded single-table sheet_query on 1-call path', () => {
  const chunks = [{ filename: 'Allocation Priority Policy.pdf', hybrid_score: 34.3 }];
  const singleTableRouted = {
    intent: 'sheet_query',
    entity: 'backorders_dataset',
    target_entities: ['backorders_dataset'],
    document_grounded: false,
  };
  assert.equal(
    enforceOperationalIntentPrecedence(
      singleTableRouted,
      'Find all the priority orders that have been delayed',
      chunks
    ).intent,
    'sheet_query'
  );
  assert.equal(
    enforceOperationalIntentPrecedence(
      { ...singleTableRouted, document_grounded: true },
      'Find all the priority orders that have been delayed',
      chunks
    ).intent,
    'cross_source_read'
  );
  assert.equal(
    enforceOperationalIntentPrecedence(
      { ...singleTableRouted, target_entities: ['backorders_dataset', 'supplier_purchase_orders'] },
      'Find delayed orders linked to supplier purchase orders',
      chunks
    ).intent,
    'cross_source_read'
  );
});

test('unified route_and_plan runs sheet_query in 1 LLM call and cross_source_read in 2 LLM calls', async () => {
  const wsId = '00000000-0000-4000-8000-000000000902';
  let llmCalls = 0;
  setPool({
    async query(sql) {
      if (/FROM workspace_table_metadata/i.test(sql)) {
        return {
          rows: [
            {
              table_name: 'backorders_dataset',
              row_count: 2,
              primary_key_column: 'backorder_id',
              columns_profile: [
                { column_name: 'backorder_id', data_type: 'text', semantic_role: 'identifier', categorical_values: ['BO-1'] },
                { column_name: 'buyer_tier', data_type: 'text', semantic_role: 'descriptive_text', categorical_values: ['Priority', 'Standard'] },
                { column_name: 'fulfillment_status', data_type: 'text', semantic_role: 'status_flag', categorical_values: ['Pending', 'On Hold', 'Shipped'] },
              ],
            },
          ],
        };
      }
      if (/FROM information_schema\.columns/i.test(sql)) {
        return {
          rows: [
            { column_name: 'business_id', data_type: 'uuid', udt_name: 'uuid', is_nullable: 'NO' },
            { column_name: 'backorder_id', data_type: 'text', udt_name: 'text', is_nullable: 'NO' },
            { column_name: 'buyer_tier', data_type: 'text', udt_name: 'text', is_nullable: 'YES' },
            { column_name: 'fulfillment_status', data_type: 'text', udt_name: 'text', is_nullable: 'YES' },
          ],
        };
      }
      if (/FROM "backorders_dataset"/i.test(sql)) {
        return {
          rows: [
            {
              _row_count: '1',
              _rows: [{ business_id: wsId, backorder_id: 'BO-2001', buyer_tier: 'Priority', fulfillment_status: 'Pending' }],
            },
          ],
        };
      }
      return { rows: [] };
    },
  });

  try {
    llmCalls = 0;
    setWorkspaceGeminiGenerator(async (_promptText, { stage }) => {
      llmCalls += 1;
      assert.equal(stage, 'route_and_plan');
      return JSON.stringify({
        intent: 'sheet_query',
        entity: 'backorders_dataset',
        target_entities: ['backorders_dataset'],
        document_grounded: false,
        interpretation_note: 'Mapped delayed priority orders to Priority tier with Pending or On Hold status.',
        table_queries: [
          {
            table_name: 'backorders_dataset',
            filters: [
              { field: 'buyer_tier', operator: 'equals', value: 'Priority' },
              { field: 'fulfillment_status', operator: 'in', value: '["Pending","On Hold"]' },
            ],
            filter_logic: 'AND',
          },
        ],
      });
    });
    const sheetRes = await executeWorkspaceOperation({
      businessId: wsId,
      prompt: 'Find all the priority orders that have been delayed',
      entity: 'backorders_dataset',
    });
    assert.equal(llmCalls, 1);
    assert.equal(sheetRes.status, 'SHEET_QUERY');
    assert.equal(sheetRes.rows.length, 1);
    assert.match(sheetRes.answer, /Pending or On Hold/);

    llmCalls = 0;
    setWorkspaceGeminiGenerator(async (_promptText, { stage }) => {
      llmCalls += 1;
      if (stage === 'route_and_plan') {
        return JSON.stringify({
          intent: 'cross_source_read',
          entity: 'backorders_dataset',
          target_entities: ['backorders_dataset'],
          document_grounded: true,
          interpretation_note: 'Checked Pending and On Hold orders.',
          table_queries: [
            {
              table_name: 'backorders_dataset',
              filters: [{ field: 'fulfillment_status', operator: 'in', value: '["Pending","On Hold"]' }],
              filter_logic: 'AND',
            },
          ],
        });
      }
      assert.equal(stage, 'cross_source_read_synthesis');
      return JSON.stringify({
        answer: 'BO-2001 is Pending under priority allocation rules.',
        matched_row_ids: ['BO-2001'],
      });
    });
    const readRes = await executeWorkspaceOperation({
      businessId: wsId,
      prompt: 'Find all delayed priority orders per allocation rules',
      entity: 'backorders_dataset',
    });
    assert.equal(llmCalls, 2);
    assert.equal(readRes.status, 'CONVERSATIONAL');
    assert.equal(readRes.intent, 'cross_source_read');
    assert.equal(readRes.rows.length, 1);
  } finally {
    setWorkspaceGeminiGenerator(null);
    setPool(null);
  }
});

test('Gemini fallback enforces strict 3-model ceiling on upstream 503', async () => {
  const originalFetch = global.fetch;
  const originalKey = env.geminiApiKey;
  const attemptedModels = [];
  env.geminiApiKey = 'test-key';
  global.fetch = async (url) => {
    const match = String(url).match(/\/models\/([^:/?]+)/);
    attemptedModels.push(match ? match[1] : 'unknown');
    return {
      ok: false,
      status: 503,
      async json() {
        return { error: { message: 'High demand' } };
      },
    };
  };
  try {
    await assert.rejects(
      () =>
        generateStructuredJsonWithRetry('return json', null, {
          stage: 'route_and_plan',
          maxRetries: 0,
        }),
      /High demand/
    );
    assert.equal(attemptedModels.length, 3);
    assert.deepEqual(attemptedModels, [
      'gemini-3.5-flash-lite',
      'gemini-3.5-flash',
      'gemini-3.1-flash-lite',
    ]);
  } finally {
    global.fetch = originalFetch;
    env.geminiApiKey = originalKey;
  }
});

test('Option B two-stage read validates dependent_lookups, relaxes bounded/anchor guards, and evaluates cross-table math deterministically', async () => {
  const wsId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const requestsTable = {
    tableName: 'transfer_requests',
    rowCount: 12,
    schema: {
      tableName: 'transfer_requests',
      primaryKey: 'req_id',
      columns: {
        workspace_id: { exactName: 'workspace_id', type: 'string', queryable: false },
        req_id: { exactName: 'req_id', type: 'string', queryable: true },
        ward_code: { exactName: 'ward_code', type: 'string', queryable: true },
        ward_name: { exactName: 'ward_name', type: 'string', queryable: true },
        beds_requested: { exactName: 'beds_requested', type: 'integer', queryable: true },
        created_at: { exactName: 'created_at', type: 'date', queryable: true },
      },
    },
  };
  const wardsTable = {
    tableName: 'hospital_units',
    rowCount: 10,
    schema: {
      tableName: 'hospital_units',
      primaryKey: 'unit_code',
      columns: {
        workspace_id: { exactName: 'workspace_id', type: 'string', queryable: false },
        unit_code: { exactName: 'unit_code', type: 'string', queryable: true },
        unit_name: { exactName: 'unit_name', type: 'string', queryable: true },
        available_beds: { exactName: 'available_beds', type: 'integer', queryable: true },
      },
    },
  };

  // Unfiltered anchor query is allowed when referenced by dependent_lookups or using order_by + limit
  const plans = validateReadPlan(
    {
      table_queries: [
        {
          query_id: 'anchor_1',
          table_name: 'transfer_requests',
          order_by: [{ field: 'created_at', direction: 'desc' }],
          limit: 3,
        },
      ],
      dependent_lookups: [
        {
          lookup_id: 'lookup_1',
          source_query_id: 'anchor_1',
          source_join_column: 'ward_code',
          target_table: 'hospital_units',
          target_join_column: 'unit_code',
          fallback_source_join_column: 'ward_name',
          fallback_target_join_column: 'unit_name',
          match_mode: 'case_insensitive',
        },
      ],
      cross_table_comparisons: [
        {
          left_source: 'lookup_1',
          left_column: 'available_beds',
          operator: '-',
          right_source: 'anchor_1',
          right_column: 'beds_requested',
          result_alias: 'beds_remaining',
          threshold_filter: { op: '<', value: 5 },
        },
      ],
    },
    [requestsTable, wardsTable],
    'Cross-check the latest 3 transfer requests against hospital units and show wards falling below 5 reserve beds.'
  );

  assert.equal(plans.length, 1);
  assert.equal(plans.dependentLookups.length, 1);
  assert.equal(plans.crossTableComparisons.length, 1);
  assert.equal(plans.crossTableComparisons[0].resultAlias, 'beds_remaining');

  const anchorRows = [
    { req_id: 'REQ-1', ward_code: 'ICU-A', ward_name: 'Cardiac ICU', beds_requested: 4 },
    { req_id: 'REQ-2', ward_code: 'MISSING', ward_name: 'Neuro Ward', beds_requested: 6 },
    { req_id: 'REQ-3', ward_code: 'PCU-C', ward_name: 'Step-Down', beds_requested: 2 },
  ];

  const sqlCalls = [];
  setPool({
    async query(sql, params) {
      sqlCalls.push({ sql, params });
      if (sql.includes('"unit_code"')) {
        return {
          rows: [
            { unit_code: 'ICU-A', unit_name: 'Cardiac ICU', available_beds: 12 },
            { unit_code: 'PCU-C', unit_name: 'Step-Down', available_beds: 5 },
          ],
        };
      }
      if (sql.includes('"unit_name"')) {
        return {
          rows: [
            { unit_code: 'NEURO-B', unit_name: 'Neuro Ward', available_beds: 8 },
          ],
        };
      }
      return { rows: [] };
    },
  });

  try {
    const lookupExec = await executeDependentLookupQuery(
      wsId,
      plans.dependentLookups[0],
      anchorRows
    );
    assert.equal(lookupExec.usedFallback, true);
    assert.equal(lookupExec.rows.length, 3);
    assert.equal(sqlCalls.length, 2);

    const anchorResultsById = new Map([
      ['anchor_1', { table_name: 'transfer_requests', schema: requestsTable.schema, rows: anchorRows }],
    ]);
    const lookupResultsById = new Map([
      ['lookup_1', { table_name: 'hospital_units', schema: wardsTable.schema, rows: lookupExec.rows }],
    ]);
    const joined = joinAndEvaluateCrossTableComparisons({
      anchorResultsById,
      lookupResultsById,
      dependentLookups: plans.dependentLookups,
      crossTableComparisons: plans.crossTableComparisons,
    });

    assert.equal(joined.pairedRecords.length, 3);
    assert.equal(joined.matchedPairedRecords.length, 2);
    const matchedUnits = joined.matchedPairedRecords.map((r) => r.lookupMatches[0].rowIdentifier).sort();
    assert.deepEqual(matchedUnits, ['NEURO-B', 'PCU-C']);
    assert.equal(joined.pairedRecords.find((r) => r.anchorRowIdentifier === 'REQ-1').computed.beds_remaining, 8);
    assert.equal(joined.pairedRecords.find((r) => r.anchorRowIdentifier === 'REQ-2').computed.beds_remaining, 2);
    assert.equal(joined.pairedRecords.find((r) => r.anchorRowIdentifier === 'REQ-3').computed.beds_remaining, 3);
  } finally {
    setPool(null);
  }
});

test('post-router gate blocks multi-table or conditional policy prompts from single-table email shortcut while preserving pure 1-table emails', () => {
  const metadataRows = [
    {
      table_name: 'transfer_requests',
      columns_profile: [
        { column_name: 'req_id', data_type: 'text' },
        { column_name: 'beds_requested', data_type: 'integer' },
        { column_name: 'coordinator_email', data_type: 'text' },
      ],
    },
    {
      table_name: 'hospital_units',
      columns_profile: [
        { column_name: 'unit_code', data_type: 'text' },
        { column_name: 'available_beds', data_type: 'integer', numeric_stats: { min: 0, max: 30 } },
      ],
    },
  ];

  // Dynamic metadata detection finds secondary table without hardcoding
  const secTables = findSecondaryTablesReferencedByMetadata(
    'allocate transfers where enough beds are available and notify all coordinators',
    'transfer_requests',
    metadataRows,
    []
  );
  assert.deepEqual(secTables, ['hospital_units']);

  // Conditional policy / buffer limit prompt blocked from single-table shortcut
  assert.equal(
    requiresConditionalPolicyEvaluation(
      'allocate requests where enough capacity is available and notify all 4 contacts about what we can fulfill and cannot due to our buffer limit'
    ),
    true
  );
  assert.equal(
    shouldUseSingleTableDirectEmailFastPath({
      prompt:
        'allocate requests where enough beds are available and email all 4 coordinators about what we can approve and cannot due to our buffer limit',
      routed: { entity: 'transfer_requests', target_entities: ['transfer_requests'], document_grounded: false },
      authoritativeEntities: ['transfer_requests'],
      metadataRows,
      normalizedHistory: [],
    }),
    false
  );

  // Pure unconditional single-table email prompt is allowed
  assert.equal(
    shouldUseSingleTableDirectEmailFastPath({
      prompt: 'send a reminder email to coordinator@example.test about REQ-1',
      routed: { entity: 'transfer_requests', target_entities: ['transfer_requests'], document_grounded: false },
      authoritativeEntities: ['transfer_requests'],
      metadataRows,
      normalizedHistory: [],
    }),
    true
  );

  // enforceOperationalIntentPrecedence preserves cross_document_operation for multi-table / email actions
  const preserved = enforceOperationalIntentPrecedence(
    {
      intent: 'cross_document_operation',
      entity: 'transfer_requests',
      target_entities: ['transfer_requests', 'hospital_units'],
      document_grounded: true,
    },
    'allocate requests where enough beds are available and email all 4 coordinators',
    [],
    null,
    [],
    'transfer_requests'
  );
  assert.equal(preserved.intent, 'cross_document_operation');
});

test('decoupled email audience tracks mutated and evaluated_unmutated records and guarantees 100% full-audience coverage', async () => {
  assert.equal(
    requestsFullAudienceNotification(
      'allocate requests and send an email to all 4 designated customers notifying them about the ones we can fulfill and the ones we cannot due to our buffer limit'
    ),
    true
  );
  assert.equal(
    requestsFullAudienceNotification('List all open requests with contact emails.'),
    false
  );
  assert.match(SCHEMA_TRUTH_PRECEDENCE_RULE, /authoritative ground truth/i);

  const primaryTable = {
    tableName: 'requests',
    schema: {
      tableName: 'requests',
      primaryKey: 'req_id',
      columns: {
        req_id: { exactName: 'req_id', type: 'string', modifiable: false, queryable: true },
        contact_name: { exactName: 'contact_name', type: 'string', modifiable: false, queryable: true },
        contact_email: { exactName: 'contact_email', type: 'string', modifiable: false, queryable: true },
        qty_requested: { exactName: 'qty_requested', type: 'integer', modifiable: false, queryable: true },
        qty_allocated: { exactName: 'qty_allocated', type: 'integer', modifiable: true, queryable: true },
        status: { exactName: 'status', type: 'string', modifiable: true, queryable: true },
      },
    },
    columnRoles: { emailCol: 'contact_email', customerNameCol: 'contact_name' },
    rows: [
      { id: '1', req_id: 'R-1', contact_name: 'Alice', contact_email: 'alice@example.test', qty_requested: 5, qty_allocated: 0, status: 'Pending' },
      { id: '2', req_id: 'R-2', contact_name: 'Bob', contact_email: 'bob@example.test', qty_requested: 12, qty_allocated: 0, status: 'Pending' },
    ],
  };

  let attempts = 0;
  setWorkspaceGeminiGenerator(async () => {
    attempts += 1;
    // Simulate LLM initially drafting only for the mutated row R-1 (attempt 1), then both (attempt 2)
    if (attempts === 1) {
      return JSON.stringify({
        mutations: [
          {
            table_name: 'requests',
            row_identifier: 'R-1',
            updates: [
              { column: 'qty_allocated', new_value: '5' },
              { column: 'status', new_value: 'Fulfilled' },
            ],
          },
        ],
        emails: [
          {
            recipient_email: 'alice@example.test',
            customer_identifier: 'Alice (R-1)',
            subject: 'R-1 Fulfilled',
            body: 'Your request R-1 has been allocated.',
            row_identifier: 'R-1',
          },
        ],
      });
    }
    return JSON.stringify({
      mutations: [
        {
          table_name: 'requests',
          row_identifier: 'R-1',
          updates: [
            { column: 'qty_allocated', new_value: '5' },
            { column: 'status', new_value: 'Fulfilled' },
          ],
        },
      ],
      emails: [
        {
          recipient_email: 'alice@example.test',
          customer_identifier: 'Alice (R-1)',
          subject: 'R-1 Fulfilled',
          body: 'Your request R-1 has been allocated.',
          row_identifier: 'R-1',
        },
        {
          recipient_email: 'bob@example.test',
          customer_identifier: 'Bob (R-2)',
          subject: 'R-2 Unable to Fulfill',
          body: 'Your request R-2 could not be fulfilled due to our buffer limit.',
          row_identifier: 'R-2',
        },
      ],
    });
  });

  try {
    const compiled = await compileResolutionPreview(
      {
        prompt:
          'allocate requests where enough stock is available and send an email to all designated customers notifying them about the requests we can fulfill and the requests we cannot due to our buffer limit',
        analysis: {
          datasetCompatible: true,
          affectedRowIds: ['R-1', 'R-2'],
          conflictingRowIds: [],
        },
        multiHopResult: {
          hop2: { targetTable: primaryTable, targetTables: [primaryTable] },
          retrievedChunks: [],
          workspaceCustomers: [],
        },
      },
      'apply_policy',
      { label: 'Apply policy', rule_interpretation: 'Allocate R-1, keep R-2 pending, notify both.' }
    );

    assert.equal(attempts, 2);
    assert.equal(compiled.mutationsPreview.length, 1);
    assert.equal(compiled.mutationsPreview[0].row_identifier, 'R-1');
    assert.equal(compiled.emailsPreview.length, 2);
    assert.deepEqual(
      compiled.emailsPreview.map((e) => e.recipient_email).sort(),
      ['alice@example.test', 'bob@example.test']
    );
  } finally {
    setWorkspaceGeminiGenerator(null);
  }
});

test('cross-table and relational sufficiency queries bypass tryExecuteFastTableQuery in 0ms while single-table fast path remains intact', async () => {
  const velouraMeta = [
    {
      table_name: 'products',
      columns_profile: [
        { column_name: 'name', data_type: 'text', categorical_values: [] },
        { column_name: 'category', data_type: 'text', categorical_values: ['polo', 'shirt'] },
        { column_name: 'stock', data_type: 'integer', numeric_stats: { min: 8, max: 42 } },
      ],
    },
    {
      table_name: 'backorders_dataset',
      columns_profile: [
        { column_name: 'backorder_id', data_type: 'text', categorical_values: [] },
        { column_name: 'product_name', data_type: 'text', categorical_values: [] },
        { column_name: 'buyer_tier', data_type: 'text', categorical_values: ['Priority', 'Standard'] },
        { column_name: 'quantity_requested', data_type: 'integer', numeric_stats: { min: 5, max: 20 } },
        { column_name: 'quantity_allocated', data_type: 'integer', numeric_stats: { min: 0, max: 20 } },
        { column_name: 'fulfillment_status', data_type: 'text', categorical_values: ['Pending', 'Fulfilled', 'Shipped', 'On Hold'] },
      ],
    },
  ];
  const turn1History = [
    {
      turn_index: 1,
      user_prompt: 'Add all the orders from order manifest to the active table',
      resolved_intent: 'CROSS_DOCUMENT_OPERATION',
      target_table: 'backorders_dataset',
      matched_row_ids: ['BO-2023', 'BO-2024', 'BO-2025', 'BO-2026'],
      assistant_response_summary: 'Committed document sync to backorders_dataset: added 4 row(s) (BO-2023, BO-2024, BO-2025, BO-2026).',
    },
  ];

  const tracedPrompt = 'check if any product is below stock to fullfil the order';

  // 1. Exact traced cross-table prompt is caught by multi-table span, relational sufficiency, and coverage gates
  assert.equal(
    promptSpansMultipleWorkspaceTables(tracedPrompt, velouraMeta, turn1History, 'backorders_dataset'),
    true
  );
  assert.equal(
    requiresRelationalOrColumnComparison(tracedPrompt, velouraMeta[1]),
    true
  );
  assert.equal(
    resolveSingleTableTarget(tracedPrompt, 'backorders_dataset', velouraMeta, turn1History),
    null
  );
  assert.equal(
    arePromptConceptsCoveredByTable(tracedPrompt, velouraMeta[1], turn1History, velouraMeta),
    false
  );
  const fastResult = await tryExecuteFastTableQuery({
    businessId: '684a8863-5094-4c8b-9b15-c50c06335b7f',
    prompt: tracedPrompt,
    entity: 'backorders_dataset',
    history: turn1History,
    metadataRows: velouraMeta,
  });
  assert.equal(fastResult, null);

  // 2. Unrelated domain (healthcare transfer_requests + hospital_units) also bypasses fast path in 0ms
  const hospitalMeta = [
    {
      table_name: 'transfer_requests',
      columns_profile: [
        { column_name: 'req_id', data_type: 'text' },
        { column_name: 'beds_requested', data_type: 'integer' },
      ],
    },
    {
      table_name: 'hospital_units',
      columns_profile: [
        { column_name: 'unit_code', data_type: 'text' },
        { column_name: 'available_beds', data_type: 'integer' },
      ],
    },
  ];
  const hospitalPrompt = 'check if any unit is below available beds to accommodate the transfer';
  assert.equal(
    promptSpansMultipleWorkspaceTables(hospitalPrompt, hospitalMeta, [], 'transfer_requests'),
    true
  );
  assert.equal(
    requiresRelationalOrColumnComparison(hospitalPrompt, hospitalMeta[0]),
    true
  );
  assert.equal(
    resolveSingleTableTarget(hospitalPrompt, 'transfer_requests', hospitalMeta, []),
    null
  );

  // 3. Genuine single-table queries & single-table follow-ups remain on the fast path
  assert.equal(
    promptSpansMultipleWorkspaceTables('show orders with buyer tier priority and already shipped', velouraMeta, [], 'backorders_dataset'),
    false
  );
  assert.equal(
    resolveSingleTableTarget('show orders with buyer tier priority and already shipped', 'backorders_dataset', velouraMeta, [])?.meta.table_name,
    'backorders_dataset'
  );
  assert.equal(
    arePromptConceptsCoveredByTable('of those, only pendingorders'.replace('pendingorders', 'pending'), velouraMeta[1], turn1History, velouraMeta),
    true
  );
});

test('validateReadPlan auto-normalizes same-table column-to-column numeric filters into SQL calculationFilters', () => {
  const ordersTable = {
    tableName: 'backorders_dataset',
    rowCount: 25,
    schema: {
      tableName: 'backorders_dataset',
      primaryKey: 'backorder_id',
      columns: {
        workspace_id: { exactName: 'workspace_id', type: 'string', queryable: false },
        backorder_id: { exactName: 'backorder_id', type: 'string', queryable: true },
        quantity_requested: { exactName: 'quantity_requested', type: 'integer', queryable: true },
        quantity_allocated: { exactName: 'quantity_allocated', type: 'integer', queryable: true },
      },
    },
  };

  const [plan] = validateReadPlan(
    {
      table_queries: [
        {
          table_name: 'backorders_dataset',
          filters: [
            {
              field: 'quantity_allocated',
              operator: 'less_than',
              value: 'quantity_requested',
            },
          ],
        },
      ],
    },
    [ordersTable],
    'Show orders where quantity_allocated is less than quantity_requested'
  );

  assert.equal(plan.filters.length, 0);
  assert.equal(plan.calculationFilters.length, 1);
  assert.deepEqual(plan.calculationFilters[0], {
    expression: '("quantity_allocated"::numeric - "quantity_requested"::numeric)',
    operator: 'less_than',
    value: 0,
  });
});
