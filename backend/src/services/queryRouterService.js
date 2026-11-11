const { query } = require('../../db');
const {
  discoverTableSchema,
  normalizeEntityName,
  quoteIdentifier,
} = require('./sheetSchemaService');
const {
  getCandidateSheetSchemas,
  detectConversationalIntent,
  tokenize,
} = require('./contextRetrievalService');
const {
  listDocumentsForBusiness,
  getChunksForBusiness,
} = require('./documentIngestionService');
const {
  retrieveHybridDocumentChunks,
  buildDocumentCitation,
  buildTableRowCitation,
  resolveRowIdentifier,
} = require('./crossRagService');
const {
  listWorkspaceTableMetadata,
} = require('./workspaceTableMetadataService');

const SYSTEM_TABLES = new Set([
  'businesses',
  'workspaces',
  'users',
  'context_entries',
  'customers',
  'conversations',
  'messages',
  'announcements',
  'announcement_deliveries',
  'announcement_recipients',
  'schema_migrations',
  'sheet_pending_modifications',
  'workspace_documents',
  'workspace_document_chunks',
  'workspace_table_metadata',
  'socratic_workflows',
  'google_auth_tokens',
  'google_sheet_sync_metadata',
  'sheet_Active_Metadata',
  'sheet_active_metadata',
]);

/**
 * Dynamically classifies the semantic role of each column in a table schema
 * using column name tokens and sample values (100% schema-agnostic).
 *
 * @param {object} schema
 * @param {Array<object>} sampleRows
 * @returns {object}
 */
function classifyTableColumns(schema, sampleRows = []) {
  const cols = schema && schema.columns ? Object.values(schema.columns) : [];
  const roles = {
    identifierCol: null,
    emailCol: null,
    customerNameCol: null,
    statusCol: null,
    durationOrDelayCol: null,
    voucherOrDiscountFlagCol: null,
    discountNumericCol: null,
    subtotalCol: null,
    totalAmountCol: null,
    unitPriceCol: null,
    locationOrHubCols: [],
    itemNameCol: null,
    itemCodeCol: null,
    allColumns: [],
  };

  for (const colDef of cols) {
    const exactName = colDef.exactName || colDef.name;
    if (!exactName) continue;
    const lower = exactName.toLowerCase();
    if (
      [
        'id',
        'business_id',
        'workspace_id',
        'user_id',
        'workspace_document_id',
        '_google_row_index',
        'created_at',
        'updated_at',
      ].includes(lower)
    ) {
      continue;
    }

    roles.allColumns.push({
      exactName,
      lower,
      type: colDef.type || 'string',
    });

    if (
      !roles.identifierCol &&
      /(?:^|_)(?:order_id|id|code|sku|reference|ref|ticket_id|invoice_id)(?:$|_)/i.test(
        lower
      )
    ) {
      roles.identifierCol = exactName;
    }

    if (!roles.emailCol && /email|e_mail|mail/i.test(lower)) {
      roles.emailCol = exactName;
    }

    if (
      !roles.customerNameCol &&
      /(?:customer|client|recipient|buyer|user|guest).*(?:name)|^(?:customer|full_name|recipient)$/i.test(
        lower
      )
    ) {
      roles.customerNameCol = exactName;
    }

    if (!roles.statusCol && /status|state|stage|phase|condition/i.test(lower)) {
      roles.statusCol = exactName;
    }

    if (
      !roles.durationOrDelayCol &&
      /delay|hour|duration|elapsed|wait|late|overdue|days|lead_time/i.test(
        lower
      ) &&
      (colDef.type === 'number' || colDef.type === 'integer')
    ) {
      roles.durationOrDelayCol = exactName;
    }

    if (
      !roles.voucherOrDiscountFlagCol &&
      /voucher|coupon|credit|compensated|issued|promo|sla_voucher|discount/i.test(
        lower
      ) &&
      colDef.type === 'boolean'
    ) {
      roles.voucherOrDiscountFlagCol = exactName;
    }

    if (
      !roles.discountNumericCol &&
      /discount|voucher|credit|rebate|deduction/i.test(lower) &&
      (colDef.type === 'number' || colDef.type === 'integer')
    ) {
      roles.discountNumericCol = exactName;
    }

    if (!roles.subtotalCol && /subtotal|sub_total|merchandise|net_amount/i.test(lower)) {
      roles.subtotalCol = exactName;
    }

    if (
      !roles.totalAmountCol &&
      /(?:^|_)(?:total|total_amount|grand_total|amount|order_total)(?:$|_)/i.test(
        lower
      ) &&
      !/subtotal/i.test(lower)
    ) {
      roles.totalAmountCol = exactName;
    }

    if (!roles.unitPriceCol && /(?:^|_)(?:price|unit_price|rate|cost)(?:$|_)/i.test(lower)) {
      roles.unitPriceCol = exactName;
    }

    if (/hub|city|location|warehouse|depot|region|branch|port|zone/i.test(lower)) {
      roles.locationOrHubCols.push(exactName);
    }

    if (
      !roles.itemNameCol &&
      /(?:item|product|service|good).*(?:name|title)|^(?:name|title|product)$/i.test(
        lower
      )
    ) {
      roles.itemNameCol = exactName;
    }

    if (!roles.itemCodeCol && /sku|item_code|product_code|model|part_no/i.test(lower)) {
      roles.itemCodeCol = exactName;
    }
  }

  // Fallback email detection from sample values if column name was non-standard
  if (!roles.emailCol && sampleRows.length > 0) {
    for (const col of roles.allColumns) {
      const hasEmail = sampleRows.some((r) =>
        /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(r[col.exactName] ?? '').trim())
      );
      if (hasEmail) {
        roles.emailCol = col.exactName;
        break;
      }
    }
  }

  return roles;
}

/**
 * Step 1: Dynamically discovers all active database tables and indexed unstructured documents
 * for the given workspace / business.
 *
 * @param {string} businessId
 * @param {object} [options]
 * @param {string} [options.targetEntity]
 * @param {boolean} [options.includeRows=true]
 * @returns {Promise<{ tables: Array<object>, documents: Array<object> }>}
 */
async function discoverWorkspaceSources(businessId, options = {}) {
  const allTableMetadata = await listWorkspaceTableMetadata(businessId);
  const requestedTargets = (Array.isArray(options.targetEntities) ? options.targetEntities : [])
    .map((name) => normalizeEntityName(String(name || '').replace(/\.(csv|xlsx?|tsv)$/i, '')))
    .filter(Boolean);
  const tableMetadata = requestedTargets.length > 0
    ? allTableMetadata.filter((metadata) =>
        requestedTargets.includes(normalizeEntityName(metadata.table_name))
      )
    : allTableMetadata;
  const candidateSchemas = [];
  if (tableMetadata.length > 0) {
    for (const metadata of tableMetadata) {
      const schema = await discoverTableSchema(metadata.table_name, businessId);
      if (!schema) continue;
      const representativeValues = {};
      for (const column of metadata.columns_profile || []) {
        if (column.semantic_role === 'email') continue;
        if (Array.isArray(column.categorical_values) && column.categorical_values.length > 0) {
          representativeValues[column.column_name] = column.categorical_values.slice(0, 25);
        }
      }
      schema.representativeValues = {
        ...(schema.representativeValues || {}),
        ...representativeValues,
      };
      schema.workspaceMetadata = metadata;
      candidateSchemas.push(schema);
    }
    const profiledTables = new Set(
      tableMetadata.map((metadata) => String(metadata.table_name).toLowerCase())
    );
    const scopedTables = await query(
      `SELECT table_name
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND LOWER(column_name) IN ('business_id', 'workspace_id')
       GROUP BY table_name
       ORDER BY table_name;`
    );
    for (const row of scopedTables.rows || []) {
      const tableName = String(row.table_name || '');
      const lowerName = tableName.toLowerCase();
      if (
        !tableName ||
        SYSTEM_TABLES.has(lowerName) ||
        profiledTables.has(lowerName) ||
        (requestedTargets.length > 0 &&
          !requestedTargets.includes(normalizeEntityName(tableName)))
      ) {
        continue;
      }
      const schema = await discoverTableSchema(tableName, businessId);
      if (schema) candidateSchemas.push(schema);
    }
  } else {
    candidateSchemas.push(...(await getCandidateSheetSchemas(businessId)));
  }
  const schemaMap = new Map();

  for (const s of candidateSchemas) {
    if (s && s.tableName) {
      schemaMap.set(s.tableName.toLowerCase(), s);
    }
  }

  if (options.targetEntity) {
    const normTarget = normalizeEntityName(options.targetEntity);
    if (!schemaMap.has(normTarget)) {
      try {
        const discovered = await discoverTableSchema(normTarget, businessId);
        if (discovered && discovered.tableName) {
          schemaMap.set(discovered.tableName.toLowerCase(), discovered);
        }
      } catch {
        // Ignore if target entity does not exist yet
      }
    }
  }

  // Before the metadata catalog is populated, discover legacy dynamic CSV tables.
  if (tableMetadata.length === 0) {
    try {
      const pgTablesRes = await query(
      `
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_type = 'BASE TABLE'
        ORDER BY table_name ASC;
      `
      );
      for (const row of pgTablesRes.rows || []) {
        const tName = String(row.table_name || '').trim();
        const lower = tName.toLowerCase();
        if (!tName || SYSTEM_TABLES.has(lower) || schemaMap.has(lower)) {
          continue;
        }
        try {
          const discovered = await discoverTableSchema(tName, businessId);
          if (discovered && discovered.tableName) {
            schemaMap.set(lower, discovered);
          }
        } catch {
          // Ignore non-sheet tables
        }
      }
    } catch {
      // Fallback if mock DB pool is active
    }
  }

  const tables = [];
  let emptyTargetFallback = null;
  const normRequestedTarget = options.targetEntity
    ? normalizeEntityName(options.targetEntity).toLowerCase()
    : null;

  for (const [lowerKey, schema] of schemaMap.entries()) {
    const metadata = tableMetadata.find(
      (item) => String(item.table_name).toLowerCase() === lowerKey
    ) || schema.workspaceMetadata || null;
    const businessIdColumn = Object.values(schema.columns || {}).find(
      (column) => String(column.exactName || '').toLowerCase() === 'business_id'
    );
    const workspaceIdColumn = Object.values(schema.columns || {}).find(
      (column) => String(column.exactName || '').toLowerCase() === 'workspace_id'
    );
    if (!businessIdColumn && !workspaceIdColumn) {
      continue;
    }

    let rows = [];
    let rowCount = metadata ? Number(metadata.row_count) : 0;
    if (options.includeRows === false) {
      rows = metadata && Array.isArray(metadata.sample_rows)
        ? metadata.sample_rows
        : [];
      if (!metadata) {
        const tenantColumns = [businessIdColumn, workspaceIdColumn].filter(Boolean);
        const whereClause =
          tenantColumns.length === 2
            ? `(${quoteIdentifier(tenantColumns[0].exactName)} = $1 OR ${quoteIdentifier(tenantColumns[1].exactName)} = $1)`
            : `${quoteIdentifier(tenantColumns[0].exactName)} = $1`;
        const countResult = await query(
          `SELECT COUNT(*)::bigint AS row_count FROM ${quoteIdentifier(schema.tableName)} WHERE ${whereClause};`,
          [businessId]
        );
        rowCount = Number(countResult.rows?.[0]?.row_count || 0);
      }
    } else {
      try {
      const bizColSql = businessIdColumn
        ? businessIdColumn.exactName === 'business_id'
          ? 'business_id'
          : quoteIdentifier(businessIdColumn.exactName)
        : null;
      const wsColSql = workspaceIdColumn
        ? workspaceIdColumn.exactName === 'workspace_id'
          ? 'workspace_id'
          : quoteIdentifier(workspaceIdColumn.exactName)
        : null;
      const wsWhereClause =
        bizColSql && wsColSql
          ? `(${bizColSql} = $1 OR ${wsColSql} = $1)`
          : bizColSql
            ? `${bizColSql} = $1`
            : `${wsColSql} = $1`;
      const idColDef = schema.columns?.id;
      const orderSql = idColDef
        ? ` ORDER BY ${
            idColDef.exactName === 'id' ? 'id' : quoteIdentifier(idColDef.exactName)
          } ASC`
        : '';
      const res = await query(
        `SELECT * FROM ${quoteIdentifier(schema.tableName)} WHERE ${wsWhereClause}${orderSql} LIMIT 500;`,
        [businessId]
      );
      rows = res && Array.isArray(res.rows) ? res.rows : [];
      if (!metadata) rowCount = rows.length;
      } catch {
        rows = [];
        if (!metadata) rowCount = 0;
      }
    }

    const columnRoles = classifyTableColumns(schema, rows.slice(0, 10));
    const entry = {
      tableName: schema.tableName,
      displayName: schema.displayName || schema.tableName,
      schema,
      columnRoles,
      rowCount,
      metadata,
      rows: options.includeRows === false ? [] : rows,
    };

    if (entry.rowCount > 0) {
      tables.push(entry);
    } else if (normRequestedTarget && lowerKey === normRequestedTarget) {
      emptyTargetFallback = entry;
    }
  }

  if (tables.length === 0 && options.allowEmptyTarget && emptyTargetFallback) {
    tables.push(emptyTargetFallback);
  }

  const documents = await listDocumentsForBusiness(businessId);
  return { tables, documents };
}

/**
 * Loads registered customer/buyer email recipients scoped strictly to `businessId`
 * from the `customers` table for workspace operations where the target table itself
 * contains no inline email column (e.g., product catalog markdown announcements).
 *
 * @param {string} businessId
 * @returns {Promise<Array<{ id: string, name: string, email: string }>>}
 */
async function loadWorkspaceCustomerRecipients(businessId) {
  if (!businessId) return [];
  try {
    const res = await query(
      `SELECT users.id, users.name AS customer_name, users.email
       FROM users
       INNER JOIN workspaces ON workspaces.user_id = users.id
       WHERE workspaces.id = $1
         AND users.email IS NOT NULL AND char_length(btrim(users.email)) > 0
       ORDER BY users.created_at ASC
       LIMIT 200;`,
      [businessId]
    );
    return (res?.rows || [])
      .map((r) => ({
        id: String(r.id || ''),
        name: String(r.customer_name || '').trim() || 'Valued Buyer',
        email: String(r.email || '').trim(),
      }))
      .filter((r) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(r.email));
  } catch {
    return [];
  }
}

/**
 * HOP_1: Extracts structured rules, numeric thresholds, compensation percentages,
 * status classifications, and referenced entity values from retrieved document chunks.
 *
 * @param {Array<object>} retrievedChunks
 * @param {Array<object>} tables
 * @param {string} prompt
 * @returns {object}
 */
function extractHop1RulesAndEntities(retrievedChunks, tables, prompt) {
  const combinedDocText = retrievedChunks
    .map((c) => c.raw_text || '')
    .join('\n');
  const combinedPromptAndDocs = `${prompt || ''}\n${combinedDocText}`;

  // 1. Extract numeric hour/day thresholds (e.g., "exceeds 48 hours", "exceeds forty-eight (48) hours", "> 48h")
  let thresholdHours = null;
  const explicitExceedsMatch =
    combinedPromptAndDocs.match(
      /(?:exceeding|exceeds?)\s+(?:[a-z-\s]+\(\s*)?(\d+(?:\.\d+)?)\s*\)?\s*(?:hours?|hrs?|h\b)/i
    ) ||
    combinedPromptAndDocs.match(
      /(\d+(?:\.\d+)?)\s*-\s*hour\s+(?:fulfillment\s+)?sla/i
    ) ||
    combinedPromptAndDocs.match(
      /(?:greater\s+than|beyond|>|>=)\s*(\d+(?:\.\d+)?)\s*(?:hours?|hrs?|h\b)/i
    );
  if (explicitExceedsMatch) {
    thresholdHours = Number(explicitExceedsMatch[1]);
  }

  // Extract delay extension range in business days or hours from notice documents (e.g., "3 to 5 business days")
  let projectedDelayDaysRange = null;
  let projectedAdditionalHoursMin = null;
  const dayRangeMatch = combinedDocText.match(
    /(\d+)\s*(?:to|-|–)\s*(\d+)\s*(?:business\s+)?days?/i
  );
  if (dayRangeMatch) {
    const minDays = Number(dayRangeMatch[1]);
    const maxDays = Number(dayRangeMatch[2]);
    projectedDelayDaysRange = { minDays, maxDays };
    projectedAdditionalHoursMin = minDays * 24;
  }

  // 2. Extract compensation percentage and base column hint (e.g. "10% promotional store credit voucher ... merchandise subtotal")
  let compensationPercent = null;
  const percentMatch = combinedPromptAndDocs.match(
    /(\d+(?:\.\d+)?)\s*%\s*(?:promotional\s+)?(?:store\s+credit|voucher|discount|credit|compensation|rebate|refund)?/i
  );
  if (percentMatch) {
    compensationPercent = Number(percentMatch[1]);
  }

  const appliesToSubtotal = /subtotal|merchandise\s+subtotal|excluding\s+shipping/i.test(
    combinedDocText
  );

  // 3. Extract policy classification label (e.g. "SLA-Breached")
  let policyClassificationLabel = null;
  const classMatch = combinedDocText.match(
    /classified\s+as\s+["'“”]?([A-Za-z0-9_-]+)["'“”]?/i
  );
  if (classMatch) {
    policyClassificationLabel = classMatch[1];
  }

  // 4. Cross-reference document text against actual distinct values in each table's columns
  // so any mentioned hubs, cities, SKUs, or statuses are dynamically bound without hardcoding.
  const matchedTableEntities = {};
  for (const tableInfo of tables) {
    const { tableName, rows, columnRoles } = tableInfo;
    const matchedLocations = new Set();
    const matchedSkus = new Set();
    const matchedStatusesInPrompt = new Set();
    const matchedStatusesInDocs = new Set();

    for (const row of rows) {
      // Check location/hub columns
      for (const locCol of columnRoles.locationOrHubCols) {
        const val = String(row[locCol] ?? '').trim();
        if (!val) continue;
        const valLower = val.toLowerCase();
        // Check if full location or its primary city/hub token appears in document chunks
        const primaryTokens = val
          .split(/[\s,/-]+/)
          .map((t) => t.trim())
          .filter(
            (t) =>
              t.length >= 4 &&
              !['central', 'port', 'depot', 'hub', 'zone', 'branch', 'north', 'south', 'east', 'west'].includes(
                t.toLowerCase()
              )
          );

        const mentionedInDocs =
          combinedDocText.toLowerCase().includes(valLower) ||
          primaryTokens.some((tok) =>
            new RegExp(`\\b${tok.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(
              combinedDocText
            )
          );
        if (mentionedInDocs) {
          matchedLocations.add(val);
        }
      }

      // Check SKU / item code column
      if (columnRoles.itemCodeCol) {
        const skuVal = String(row[columnRoles.itemCodeCol] ?? '').trim();
        if (
          skuVal &&
          combinedPromptAndDocs.toLowerCase().includes(skuVal.toLowerCase())
        ) {
          matchedSkus.add(skuVal);
        }
      }

      // Check status column values against prompt and documents
      if (columnRoles.statusCol) {
        const statusVal = String(row[columnRoles.statusCol] ?? '').trim();
        if (statusVal) {
          const sLower = statusVal.toLowerCase();
          if (String(prompt || '').toLowerCase().includes(sLower)) {
            matchedStatusesInPrompt.add(statusVal);
          }
          if (combinedDocText.toLowerCase().includes(sLower)) {
            matchedStatusesInDocs.add(statusVal);
          }
        }
      }
    }

    matchedTableEntities[tableName] = {
      matchedLocations: Array.from(matchedLocations),
      matchedSkus: Array.from(matchedSkus),
      matchedStatusesInPrompt: Array.from(matchedStatusesInPrompt),
      matchedStatusesInDocs: Array.from(matchedStatusesInDocs),
    };
  }

  // Detect whether a notice document refers to orders "scheduled for standard dispatch" (i.e., Processing / in-progress orders)
  const mentionsScheduledDispatch =
    /scheduled\s+for\s+(?:standard\s+)?dispatch|current\s+operational\s+cycle|in-transit\s+and\s+staged/i.test(
      combinedDocText
    );

  return {
    thresholdHours,
    projectedDelayDaysRange,
    projectedAdditionalHoursMin,
    compensationPercent,
    appliesToSubtotal,
    policyClassificationLabel,
    mentionsScheduledDispatch,
    matchedTableEntities,
  };
}

/**
 * HOP_2: Resolves extracted HOP_1 entities & policy rules against the discovered database tables
 * to identify candidate rows, cohorts, and policy/data conflicts.
 *
 * @param {Array<object>} tables
 * @param {object} hop1
 * @param {string} prompt
 * @returns {object}
 */
function executeHop2RelationalResolution(
  tables,
  hop1,
  prompt,
  targetEntity = null,
  targetEntities = null
) {
  if (!Array.isArray(tables) || tables.length === 0) {
    return {
      targetTable: null,
      targetTables: [],
      thresholdCohortRows: [],
      noticeScheduledCohortRows: [],
      combinedCandidateRows: [],
      conflictingRows: [],
      nonConflictingRows: [],
    };
  }

  // Authoritatively lock onto targetEntity when provided by Gemini intent router or caller
  const explicitMatch = targetEntity
    ? tables.find(
        (t) =>
          t.tableName.toLowerCase() === String(targetEntity).trim().toLowerCase()
      )
    : null;

  // Rank tables by relevance to prompt + HOP_1 entities ONLY when no authoritative targetEntity matched
  const promptTokens = tokenize(prompt || '');
  let bestTable = explicitMatch || tables[0];
  let bestScore = -1;

  if (!explicitMatch) {
    for (const t of tables) {
      let score = 0;
      const tNameLower = t.tableName.toLowerCase();
      if (String(prompt || '').toLowerCase().includes(tNameLower)) {
        score += 10;
      }
      for (const col of t.columnRoles.allColumns) {
        if (promptTokens.some((pt) => col.lower.includes(pt))) {
          score += 3;
        }
      }
      const entityMatches = hop1.matchedTableEntities[t.tableName];
      if (entityMatches) {
        score += entityMatches.matchedLocations.length * 2;
        score += entityMatches.matchedSkus.length * 3;
      }
      if (t.columnRoles.durationOrDelayCol) score += 2;
      if (
        t.columnRoles.voucherOrDiscountFlagCol ||
        t.columnRoles.discountNumericCol
      ) {
        score += 2;
      }
      if (score > bestScore) {
        bestScore = score;
        bestTable = t;
      }
    }
  }

  // Resolve full ordered list of involved tables (multi-table support, primary table first)
  const targetTables = [];
  const seenTargetTables = new Set();
  const pushTargetTable = (tbl) => {
    if (tbl && !seenTargetTables.has(tbl.tableName.toLowerCase())) {
      seenTargetTables.add(tbl.tableName.toLowerCase());
      targetTables.push(tbl);
    }
  };
  pushTargetTable(bestTable);
  if (Array.isArray(targetEntities)) {
    for (const reqEntity of targetEntities) {
      const matched = tables.find(
        (t) =>
          t.tableName.toLowerCase() === String(reqEntity || '').trim().toLowerCase()
      );
      pushTargetTable(matched);
    }
  }

  const { rows, columnRoles, tableName } = bestTable;
  const entityInfo = hop1.matchedTableEntities[tableName] || {
    matchedLocations: [],
    matchedSkus: [],
  };

  const delayCol = columnRoles.durationOrDelayCol;
  const statusCol = columnRoles.statusCol;
  const voucherFlagCol = columnRoles.voucherOrDiscountFlagCol;
  const discountNumCol = columnRoles.discountNumericCol;

  // Cohort 1: Rows that currently exceed the numeric threshold (e.g. Delay_Hours > 48)
  // and/or currently have a "Delayed" status in the table.
  const thresholdCohortRows = [];
  // Cohort 2: Rows that are currently in "Processing" / scheduled for dispatch at the hubs/locations
  // identified in the Supplier Delay Notice (where the 3-5 day / 72-120h delay breaches the 48h SLA).
  const noticeScheduledCohortRows = [];

  for (const row of rows) {
    const statusVal = statusCol ? String(row[statusCol] ?? '').trim() : '';
    const statusLower = statusVal.toLowerCase();
    const delayVal = delayCol !== null ? Number(row[delayCol]) : Number.NaN;

    const exceedsThreshold =
      hop1.thresholdHours !== null &&
      Number.isFinite(delayVal) &&
      delayVal > hop1.thresholdHours;

    const isCurrentlyDelayed =
      statusLower === 'delayed' ||
      statusLower === 'sla-breached' ||
      statusLower === 'overdue' ||
      (exceedsThreshold && statusLower !== 'delivered' && statusLower !== 'shipped');

    if (isCurrentlyDelayed && (hop1.thresholdHours === null || exceedsThreshold)) {
      thresholdCohortRows.push(row);
      continue;
    }

    // Check if row is scheduled for dispatch ("Processing" / "Pending") and impacted by the notice
    const isProcessingOrScheduled =
      statusLower === 'processing' ||
      statusLower === 'pending' ||
      statusLower === 'staged';

    if (isProcessingOrScheduled) {
      const matchesLocation =
        entityInfo.matchedLocations.length === 0 ||
        columnRoles.locationOrHubCols.some((locCol) =>
          entityInfo.matchedLocations.includes(String(row[locCol] ?? '').trim())
        );
      if (matchesLocation) {
        noticeScheduledCohortRows.push(row);
      }
    }
  }

  // Helper to check if a row already has an active voucher/discount (creating a stacking vs. capping/skip conflict)
  const hasExistingCompensation = (row) => {
    if (voucherFlagCol) {
      const v = row[voucherFlagCol];
      if (
        v === true ||
        String(v ?? '')
          .trim()
          .toLowerCase() === 'true' ||
        String(v ?? '').trim() === '1'
      ) {
        return true;
      }
    }
    if (discountNumCol) {
      const d = Number(row[discountNumCol]);
      if (Number.isFinite(d) && d > 0) {
        return true;
      }
    }
    return false;
  };

  // Combine candidate rows (preserving order and uniqueness)
  const seenIds = new Set();
  const combinedCandidateRows = [];
  for (const r of [...thresholdCohortRows, ...noticeScheduledCohortRows]) {
    const rid = resolveRowIdentifier(r);
    if (!seenIds.has(rid)) {
      seenIds.add(rid);
      combinedCandidateRows.push(r);
    }
  }

  // If neither cohort matched (e.g., generic table without delay/status columns), fall back to matching rows by prompt tokens
  if (combinedCandidateRows.length === 0 && rows.length > 0) {
    for (const r of rows) {
      const serialized = JSON.stringify(r).toLowerCase();
      if (promptTokens.some((tok) => tok.length >= 3 && serialized.includes(tok))) {
        combinedCandidateRows.push(r);
      }
    }
  }

  const conflictingRows = combinedCandidateRows.filter(hasExistingCompensation);
  const nonConflictingRows = combinedCandidateRows.filter(
    (r) => !hasExistingCompensation(r)
  );

  return {
    targetTable: bestTable,
    targetTables,
    thresholdCohortRows,
    noticeScheduledCohortRows,
    combinedCandidateRows,
    conflictingRows,
    nonConflictingRows,
    hasExistingCompensation,
  };
}

/**
 * Executes the 3-step Multi-Hop Cross-Document Query Router:
 * Step 1: Schema & Source Discovery
 * Step 2: HOP_1 (Unstructured -> Structured) + HOP_2 (Relational Resolution)
 * Step 3: Cross-Source Provenance & Normalized Citations
 *
 * @param {string} businessId
 * @param {string} prompt
 * @param {object} [options]
 * @returns {Promise<object>}
 */
async function executeMultiHopQuery(businessId, prompt, options = {}) {
  const conversationalCheck = detectConversationalIntent(prompt);
  if (conversationalCheck.isConversational) {
    return {
      conversational: true,
      intent: conversationalCheck.intent,
      hop1: null,
      hop2: null,
      citations: [],
    };
  }

  // Step 1: Discover active tables and unstructured documents
  const { tables, documents } = await discoverWorkspaceSources(
    businessId,
    {
      ...options,
      includeRows: true,
    }
  );
  const workspaceCustomers = await loadWorkspaceCustomerRecipients(businessId);

  // Step 2A (HOP_1): Retrieve relevant unstructured document chunks & extract policy rules/entities
  const retrievedChunks = await retrieveHybridDocumentChunks(
    businessId,
    prompt,
    {
      topK: Math.min(8, Math.max(1, Number(options.topKDocuments) || 8)),
      includeAllIfOperational: true,
    }
  );

  const hop1 = extractHop1RulesAndEntities(retrievedChunks, tables, prompt);

  // Step 2B (HOP_2): Bind extracted rules/entities to target relational table(s)
  const hop2 = executeHop2RelationalResolution(
    tables,
    hop1,
    prompt,
    options.targetEntity || null,
    options.targetEntities || null
  );

  // Step 3: Build normalized Cross-Source Provenance & Citations array
  const citations = [];
  const seenDocPage = new Set();

  for (const chunk of retrievedChunks) {
    const key = `${chunk.filename}::${chunk.page_number}`;
    if (seenDocPage.has(key)) continue;
    seenDocPage.add(key);
    citations.push(buildDocumentCitation(chunk));
  }

  const citedTables =
    Array.isArray(hop2.targetTables) && hop2.targetTables.length > 0
      ? hop2.targetTables
      : hop2.targetTable
        ? [hop2.targetTable]
        : [];
  for (const tbl of citedTables) {
    const isPrimary = hop2.targetTable && tbl.tableName === hop2.targetTable.tableName;
    const sampleCitedRows = isPrimary
      ? hop2.thresholdCohortRows.length > 0
        ? [
            ...hop2.thresholdCohortRows.slice(0, 5),
            ...hop2.noticeScheduledCohortRows.slice(0, 3),
          ]
        : hop2.combinedCandidateRows.slice(0, 5)
      : (tbl.rows || []).slice(0, 3);

    const seenRowLocators = new Set();
    for (const row of sampleCitedRows) {
      const citation = buildTableRowCitation(tbl.tableName, row);
      if (!seenRowLocators.has(citation.locator)) {
        seenRowLocators.add(citation.locator);
        citations.push(citation);
      }
    }
  }

  return {
    conversational: false,
    intent: 'cross_document_operation',
    tables,
    documents,
    workspaceCustomers,
    retrievedChunks,
    hop1,
    hop2,
    citations,
  };
}

module.exports = {
  classifyTableColumns,
  discoverWorkspaceSources,
  loadWorkspaceCustomerRecipients,
  extractHop1RulesAndEntities,
  executeHop2RelationalResolution,
  executeMultiHopQuery,
};
