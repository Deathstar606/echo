const crypto = require('node:crypto');
const { query, withTransaction } = require('../../db');
const AppError = require('../utils/AppError');
const {
  findColumnDef,
  quoteIdentifier,
  parseCleanNumber,
  coerceBooleanValue,
} = require('./sheetSchemaService');
const { sendIndividualEmail } = require('./emailService');
const {
  generateStructuredJsonWithRetry,
} = require('./geminiService');
const {
  routeWorkspaceIntent,
} = require('./workspaceIntentRouter');
const {
  executeMultiHopQuery,
} = require('./queryRouterService');
const {
  resolveRowIdentifier,
  resolveRowIdentifierInfo,
  buildDocumentCitation,
  buildTableRowCitation,
} = require('./crossRagService');
const {
  generateCrossSourceReadAnswer,
} = require('./workspaceReadService');
const {
  tryExecuteFastTableQuery,
} = require('./fastTableQueryService');
const {
  invalidateWorkspaceMetadataCache,
} = require('./workspaceTableMetadataService');

/**
 * In-memory registry of active and completed Socratic operational workflows:
 * workflow_id -> workflow state object
 */
const WORKFLOW_STORE = new Map();

/**
 * In-memory ledger of dispatched operational emails keyed by workflow_id
 * for auditability and automated test verification.
 */
const DISPATCHED_EMAILS_BY_WORKFLOW = new Map();

const SOCRATIC_ANALYSIS_SCHEMA = {
  type: 'OBJECT',
  properties: {
    dataset_compatible: {
      type: 'BOOLEAN',
      description:
        'True if TARGET_TABLE_ROWS and TARGET_TABLE_SCHEMA match the domain/identifiers governed by the documents and request; false if the table belongs to an unrelated domain or lacks mandatory batch/item identifiers required by the documents.',
    },
    affected_row_ids: {
      type: 'ARRAY',
      items: { type: 'STRING' },
      description:
        'Exact _row_id values of ALL rows in TARGET_TABLE_ROWS targeted by the operational directive/memo/manifest BEFORE excluding governance conflicts (MUST be the full qualifying superset containing BOTH clean eligible rows AND policy-conflicting rows; empty array if dataset_compatible is false or zero rows qualify).',
    },
    conflicting_row_ids: {
      type: 'ARRAY',
      items: { type: 'STRING' },
      description:
        'Exact subset of affected_row_ids that trigger a policy conflict, cap, price floor, arrears credit freeze, payment-rail settlement exception, inventory/supply deficit, voucher-stacking conflict, or multi-cohort ambiguity.',
    },
    has_conflict: {
      type: 'BOOLEAN',
      description:
        'True whenever any policy conflict, cap, freeze, payment-rail exception, supply deficit, stacking ambiguity, missing parameter, or dataset incompatibility requires operator selection before mutating data.',
    },
    conflict_summary: {
      type: 'STRING',
      description:
        'Clear, grounded operational summary citing exact document rules, thresholds, counts, and conflicting _row_id values.',
    },
    socratic_questions: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          question_id: { type: 'STRING' },
          question_text: { type: 'STRING' },
          options: {
            type: 'ARRAY',
            items: {
              type: 'OBJECT',
              properties: {
                option_id: { type: 'STRING' },
                label: { type: 'STRING' },
                rule_interpretation: {
                  type: 'STRING',
                  description:
                    'Complete operational specification of which qualifying rows to update, exact MODIFIABLE_COLUMNS names and post-update target values (MUST include at least one column update whose new value differs from the current value in TARGET_TABLE_ROWS, such as transitioning a status/classification column to the policy target label and/or updating numeric/flag columns), and email notification rules.',
                },
              },
              required: ['option_id', 'label', 'rule_interpretation'],
            },
          },
        },
        required: ['question_id', 'question_text', 'options'],
      },
    },
  },
  required: [
    'dataset_compatible',
    'affected_row_ids',
    'conflicting_row_ids',
    'has_conflict',
    'conflict_summary',
    'socratic_questions',
  ],
};

const PREVIEW_COMPILATION_SCHEMA = {
  type: 'OBJECT',
  properties: {
    mutations: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          table_name: {
            type: 'STRING',
            description:
              'Exact target table name from TARGET_TABLES (optional for single-table workflows; required when multiple tables are involved).',
          },
          row_identifier: {
            type: 'STRING',
            description: 'Exact _row_id of the row to modify from CANDIDATE_ROWS.',
          },
          updates: {
            type: 'ARRAY',
            items: {
              type: 'OBJECT',
              properties: {
                column: {
                  type: 'STRING',
                  description:
                    'Exact modifiable column name from MODIFIABLE_COLUMNS for that row table.',
                },
                new_value: {
                  type: 'STRING',
                  description:
                    'Post-update target value serialized as a string (e.g. "45", "30", "10000", "true", "Gold - Credit Frozen", "Partial", or valid JSON string "{\\"M\\":2,\\"L\\":3,\\"XL\\":3,\\"XXL\\":2}" for nested JSON map columns).',
                },
              },
              required: ['column', 'new_value'],
            },
          },
        },
        required: ['row_identifier', 'updates'],
      },
    },
    emails: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          recipient_email: {
            type: 'STRING',
            description: 'Exact email address from ALLOWED_RECIPIENTS.',
          },
          customer_identifier: {
            type: 'STRING',
            description:
              'Recipient display identifier (e.g., "Sarah Jenkins (ACC-1001)" or "Fardin Rahman").',
          },
          subject: { type: 'STRING' },
          body: { type: 'STRING' },
          applied_rule: {
            type: 'STRING',
            description: 'Concise summary of the policy rule applied for this recipient.',
          },
          row_identifier: {
            type: 'STRING',
            description:
              'Associated _row_id for row-level notifications, or "catalog_broadcast" for buyer-list announcements.',
          },
        },
        required: [
          'recipient_email',
          'customer_identifier',
          'subject',
          'body',
          'applied_rule',
          'row_identifier',
        ],
      },
    },
  },
  required: ['mutations', 'emails'],
};

let workflowTableInitialized = false;

async function ensureWorkflowTableExists() {
  if (workflowTableInitialized) return;
  try {
    await query(`
      CREATE TABLE IF NOT EXISTS socratic_workflows (
        workflow_id UUID PRIMARY KEY,
        business_id UUID,
        status VARCHAR(64) NOT NULL,
        prompt TEXT NOT NULL,
        payload JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    workflowTableInitialized = true;
  } catch {
    // Fallback to in-memory WORKFLOW_STORE if DB DDL is unavailable
  }
}

async function saveWorkflowState(workflow) {
  WORKFLOW_STORE.set(workflow.workflow_id, workflow);
  await ensureWorkflowTableExists();
  try {
    await query(
      `
        INSERT INTO socratic_workflows (workflow_id, business_id, status, prompt, payload, updated_at)
        VALUES ($1, $2, $3, $4, $5::jsonb, NOW())
        ON CONFLICT (workflow_id)
        DO UPDATE SET
          status = EXCLUDED.status,
          payload = EXCLUDED.payload,
          updated_at = NOW();
      `,
      [
        workflow.workflow_id,
        workflow.business_id || null,
        workflow.status,
        workflow.prompt || '',
        JSON.stringify(workflow),
      ]
    );
  } catch {
    // In-memory store remains authoritative
  }
}

async function loadWorkflowState(workflowId) {
  if (!workflowId) return null;
  if (WORKFLOW_STORE.has(workflowId)) {
    return WORKFLOW_STORE.get(workflowId);
  }
  await ensureWorkflowTableExists();
  try {
    const res = await query(
      `SELECT payload FROM socratic_workflows WHERE workflow_id = $1 LIMIT 1;`,
      [workflowId]
    );
    if (res.rows && res.rows[0] && res.rows[0].payload) {
      const wf =
        typeof res.rows[0].payload === 'string'
          ? JSON.parse(res.rows[0].payload)
          : res.rows[0].payload;
      WORKFLOW_STORE.set(workflowId, wf);
      return wf;
    }
  } catch {
    // Ignore DB lookup failure
  }
  return null;
}

async function clearWorkflowStoreGlobal() {
  WORKFLOW_STORE.clear();
  DISPATCHED_EMAILS_BY_WORKFLOW.clear();
  try {
    await query(`TRUNCATE TABLE socratic_workflows RESTART IDENTITY CASCADE;`);
  } catch {
    try {
      await query(`DELETE FROM socratic_workflows;`);
    } catch {
      // Ignore on mock pools
    }
  }
}

/**
 * Computes sum of numeric values inside a nested JSON map column (e.g., per-size stock map).
 *
 * @param {any} rawMapVal
 * @returns {number | null}
 */
function sumNestedMapValues(rawMapVal) {
  if (!rawMapVal) return null;
  try {
    const parsed =
      typeof rawMapVal === 'string' ? JSON.parse(rawMapVal) : rawMapVal;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    let sum = 0;
    let hasNumeric = false;
    for (const v of Object.values(parsed)) {
      const n = Number(v);
      if (Number.isFinite(n)) {
        sum += n;
        hasNumeric = true;
      }
    }
    return hasNumeric ? sum : null;
  } catch {
    return null;
  }
}

/**
 * Projects a table's schema and rows into a compact, token-efficient, 100% schema-agnostic
 * representation for LLM reasoning (truncating only long prose fields while preserving
 * all IDs, numbers, booleans, categories, tiers, statuses, dates, emails, and JSON maps).
 *
 * @param {object} targetTable
 * @returns {{ schemaColumns: Array<object>, modifiableColumns: Array<object>, projectedRows: Array<object>, rowLookup: Map<string, object> }}
 */
function projectTableForLlm(targetTable) {
  if (!targetTable || !targetTable.schema) {
    return {
      schemaColumns: [],
      modifiableColumns: [],
      projectedRows: [],
      rowLookup: new Map(),
    };
  }

  const { schema, rows = [] } = targetTable;
  const allColDefs = Object.values(schema.columns || {});
  const nestedMapCol = allColDefs.find((c) => c.nestedMap);

  const schemaColumns = [];
  const modifiableColumns = [];

  for (const colDef of allColDefs) {
    const exactName = colDef.exactName;
    if (!exactName) continue;
    const lower = exactName.toLowerCase();
    if ([
      'id',
      'business_id',
      'workspace_id',
      'user_id',
      'workspace_document_id',
      '_google_row_index',
      'created_at',
      'updated_at',
    ].includes(lower)) {
      continue;
    }
    const isModifiable = Boolean(colDef.modifiable && !colDef.virtual);
    const descriptor = {
      name: exactName,
      type: colDef.type || 'string',
      modifiable: isModifiable,
      ...(colDef.virtual ? { virtual_computed: true } : {}),
      ...(colDef.nestedMap
        ? {
            nested_map_json: true,
            nested_value_type: colDef.nestedValueType || 'integer',
          }
        : {}),
      ...(colDef.min !== undefined ? { min: colDef.min } : {}),
      ...(colDef.max !== undefined ? { max: colDef.max } : {}),
      ...(colDef.description ? { description: colDef.description } : {}),
    };
    schemaColumns.push(descriptor);
    if (isModifiable) {
      modifiableColumns.push(descriptor);
    }
  }

  const projectedRows = [];
  const rowLookup = new Map();

  rows.slice(0, 200).forEach((row, idx) => {
    const { identifier, column: identifierCol } = resolveRowIdentifierInfo(
      row,
      idx + 1
    );
    const entry = { _row_id: identifier };

    const computedMapSum = nestedMapCol
      ? sumNestedMapValues(row[nestedMapCol.exactName])
      : null;

    for (const colDesc of schemaColumns) {
      const colName = colDesc.name;
      const lower = colName.toLowerCase();
      if (lower === 'images' || lower === 'image_url') {
        continue;
      }

      let val = row[colName];
      if (colDesc.virtual_computed && computedMapSum !== null) {
        const existingNum = Number(val);
        if (!Number.isFinite(existingNum) || existingNum === 0) {
          val = computedMapSum;
        }
      }

      if (val === undefined || val === null) {
        entry[colName] = null;
      } else if (colDesc.type === 'number' || colDesc.type === 'integer') {
        const n = Number(val);
        entry[colName] = Number.isFinite(n) ? n : val;
      } else if (colDesc.type === 'boolean') {
        if (typeof val === 'boolean') {
          entry[colName] = val;
        } else {
          entry[colName] =
            String(val).trim().toLowerCase() === 'true' ||
            String(val).trim() === '1';
        }
      } else {
        const str =
          typeof val === 'object' ? JSON.stringify(val) : String(val).trim();
        const isStructuredJson =
          (str.startsWith('{') && str.endsWith('}')) ||
          (str.startsWith('[') && str.endsWith(']'));
        const isIdentityOrEmail =
          colName === identifierCol ||
          str.includes('@') ||
          /(?:id|sku|code|name|tier|status|category|batch|method|city|hub|region|date)/i.test(
            lower
          );
        entry[colName] =
          !isStructuredJson && !isIdentityOrEmail && str.length > 140
            ? `${str.slice(0, 140)}...`
            : str;
      }
    }

    projectedRows.push(entry);
    const lookupRecord = {
      row,
      identifier,
      identifierCol: identifierCol || 'id',
      projected: entry,
    };
    rowLookup.set(identifier, lookupRecord);
    rowLookup.set(identifier.toLowerCase(), lookupRecord);
  });

  return {
    schemaColumns,
    modifiableColumns,
    projectedRows,
    rowLookup,
  };
}

/**
 * Coerces a raw LLM-proposed column value into the exact JavaScript/PostgreSQL type
 * defined on `colDef`, throwing an AppError if invalid so self-correction can fix it.
 *
 * @param {object} colDef
 * @param {string} colName
 * @param {any} rawValue
 * @returns {any}
 */
function coerceValueForColumn(colDef, colName, rawValue) {
  const colType = colDef.type || 'string';
  const isIntStorage =
    colType === 'integer' ||
    String(colDef.storageType || '').toLowerCase().includes('int');

  if (isIntStorage) {
    const n = parseCleanNumber(rawValue);
    if (!Number.isFinite(n)) {
      throw new AppError(
        `Column "${colName}" requires a numeric/integer value, received "${rawValue}".`,
        400
      );
    }
    const rounded = Math.round(n);
    if (colDef.min !== undefined && rounded < colDef.min) {
      throw new AppError(
        `Column "${colName}" value ${rounded} is below minimum ${colDef.min}.`,
        400
      );
    }
    if (colDef.max !== undefined && rounded > colDef.max) {
      throw new AppError(
        `Column "${colName}" value ${rounded} exceeds maximum ${colDef.max}.`,
        400
      );
    }
    return rounded;
  }

  if (colType === 'number') {
    const n = parseCleanNumber(rawValue);
    if (!Number.isFinite(n)) {
      throw new AppError(
        `Column "${colName}" requires a numeric value, received "${rawValue}".`,
        400
      );
    }
    const rounded = Math.round(n * 100) / 100;
    if (colDef.min !== undefined && rounded < colDef.min) {
      throw new AppError(
        `Column "${colName}" value ${rounded} is below minimum ${colDef.min}.`,
        400
      );
    }
    if (colDef.max !== undefined && rounded > colDef.max) {
      throw new AppError(
        `Column "${colName}" value ${rounded} exceeds maximum ${colDef.max}.`,
        400
      );
    }
    return rounded;
  }

  if (colType === 'boolean') {
    const coerced = coerceBooleanValue(rawValue);
    if (typeof coerced !== 'boolean') {
      throw new AppError(
        `Column "${colName}" requires a boolean ("true" or "false"), received "${rawValue}".`,
        400
      );
    }
    return coerced;
  }

  if (colDef.nestedMap || colType === 'json') {
    let parsedObj = rawValue;
    if (typeof rawValue === 'string') {
      const trimmed = rawValue.trim();
      if (!trimmed.startsWith('{')) {
        throw new AppError(
          `Column "${colName}" is a nested JSON map column and requires a valid JSON object string (e.g. "{\\"M\\":2,\\"L\\":3}"), received "${rawValue}".`,
          400
        );
      }
      try {
        parsedObj = JSON.parse(trimmed);
      } catch {
        throw new AppError(
          `Column "${colName}" contains invalid JSON: "${rawValue}".`,
          400
        );
      }
    }
    if (!parsedObj || typeof parsedObj !== 'object' || Array.isArray(parsedObj)) {
      throw new AppError(
        `Column "${colName}" must be a JSON object mapping keys to numeric quantities.`,
        400
      );
    }
    const normalizedObj = {};
    for (const [k, v] of Object.entries(parsedObj)) {
      if (!/^[a-z0-9_-]+$/i.test(k)) {
        throw new AppError(`Invalid nested map key "${k}" on column "${colName}".`, 400);
      }
      const num = parseCleanNumber(v);
      if (!Number.isFinite(num) || num < 0) {
        throw new AppError(
          `Nested map value for "${colName}.${k}" must be a non-negative number, received "${v}".`,
          400
        );
      }
      normalizedObj[k] =
        colDef.nestedValueType === 'integer'
          ? Math.round(num)
          : Math.round(num * 100) / 100;
    }
    return JSON.stringify(normalizedObj);
  }

  return String(rawValue ?? '').trim();
}

/**
 * Returns true when the user instruction explicitly asks to email or notify recipients,
 * supporting multi-word modifiers, compound roles, proper names, and literal email addresses
 * while ignoring negated notification clauses and plain column/field lookups.
 *
 * @param {string} prompt
 * @returns {boolean}
 */
function explicitlyRequestsNotifications(prompt) {
  const rawText = String(prompt || '');
  if (!rawText.trim()) return false;

  const negTarget =
    '(?:(?:the|all|each|any|affected)\\s+){0,3}(?:customers?|buyers?|clients?|recipients?|vendors?|suppliers?|leads?|managers?|account\\s+managers?|contacts?|contact_emails?|users?|patients?|staff|charge\\s+nurses?|nurses?|coordinators?|them|everyone)';
  const negClauseItem = `(?:(?:send(?:ing)?|draft(?:ing)?|dispatch(?:ing)?)\\s+)?(?:any\\s+)?(?:e-?mail(?:ing|s)?|notif(?:ying|ications?|y)|messag(?:ing|es|e)|alerts?)\\b(?:\\s+(?:to\\s+)?${negTarget})?`;
  const text = rawText.replace(
    new RegExp(
      `\\b(?:do\\s+not|don't|never|without|avoid|skip)\\s+${negClauseItem}(?:\\s*(?:,|\\/|\\bor\\b|\\bnor\\b)\\s*${negClauseItem})*`,
      'gi'
    ),
    ' '
  );

  const recipientNounPattern =
    /(?:customers?|buyers?|clients?|recipients?|vendors?|suppliers?|leads?|coordinators?|account\s+managers?|managers?|contacts?|contact_emails?|users?|patients?|staff|charge\s+nurses?|nurses?|teams?|members?|accounts?|them|everyone)/i;

  const actionBeforeRecipient = new RegExp(
    `\\b(?:e-?mail(?:ing)?|notify(?:ing)?|messag(?:e|ing)|alert(?:ing)?)\\s+(?:[a-z0-9_'-]+\\s+){0,5}${recipientNounPattern.source}\\b`,
    'i'
  );

  const actionBeforeEmailAddress =
    /\b(?:e-?mail(?:ing)?|notify(?:ing)?|messag(?:e|ing)|alert(?:ing)?|send(?:ing)?\b[^.?!;\n]{0,60}\bto)\s+[^\s,;]+@[^\s,;]+\.[^\s,;]+/i;

  const actionBeforeProperName =
    /\b(?:[Ee]-?[Mm]ail(?:ing)?|[Nn]otify(?:ing)?|[Mm]essag(?:e|ing)|[Aa]lert(?:ing)?)\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,3}\b/;

  const sendEmailPhrase =
    /\b(?:send(?:ing)?|draft(?:ing)?|dispatch(?:ing)?|deliver(?:ing)?)\s+(?:an?\s+)?(?:[a-z0-9_'-]+\s+){0,4}(?:e-?mails?|notifications?|messages?|alerts?)\b/i;

  const viaEmailPhrase = /\b(?:by|via)\s+e-?mail\b/i;

  return (
    actionBeforeRecipient.test(text) ||
    actionBeforeEmailAddress.test(text) ||
    actionBeforeProperName.test(text) ||
    sendEmailPhrase.test(text) ||
    viaEmailPhrase.test(text)
  );
}

/**
 * Normalizes a live database column value to the column's canonical JS type for accurate diff checks.
 *
 * @param {object} colDef
 * @param {any} rawLiveVal
 * @returns {any}
 */
function normalizeLiveBeforeValue(colDef, rawLiveVal) {
  if (rawLiveVal === undefined || rawLiveVal === null) return null;
  if (typeof rawLiveVal === 'object') {
    return JSON.stringify(rawLiveVal);
  }
  const colType = colDef.type || 'string';
  const isIntStorage =
    colType === 'integer' ||
    String(colDef.storageType || '').toLowerCase().includes('int');

  if (isIntStorage) {
    const n = Number(rawLiveVal);
    return Number.isFinite(n) ? Math.round(n) : rawLiveVal;
  }
  if (colType === 'number') {
    const n = Number(rawLiveVal);
    return Number.isFinite(n) ? Math.round(n * 100) / 100 : rawLiveVal;
  }
  if (colType === 'boolean') {
    if (typeof rawLiveVal === 'boolean') return rawLiveVal;
    const s = String(rawLiveVal).trim().toLowerCase();
    if (s === 'true' || s === '1') return true;
    if (s === 'false' || s === '0') return false;
    return Boolean(rawLiveVal);
  }
  return String(rawLiveVal);
}

function valuesAreEqual(colDef, beforeVal, afterVal) {
  if (beforeVal === afterVal) return true;
  if (beforeVal === null || afterVal === null) return false;
  if (colDef.nestedMap || colDef.type === 'json') {
    try {
      const bObj = typeof beforeVal === 'string' ? JSON.parse(beforeVal) : beforeVal;
      const aObj = typeof afterVal === 'string' ? JSON.parse(afterVal) : afterVal;
      if (
        bObj &&
        aObj &&
        typeof bObj === 'object' &&
        typeof aObj === 'object' &&
        !Array.isArray(bObj) &&
        !Array.isArray(aObj)
      ) {
        const bKeys = Object.keys(bObj).sort();
        const aKeys = Object.keys(aObj).sort();
        if (bKeys.length !== aKeys.length) return false;
        return bKeys.every(
          (k, idx) => k === aKeys[idx] && Number(bObj[k]) === Number(aObj[k])
        );
      }
    } catch {
      // Fall through to string comparison
    }
  }
  if (colDef.type === 'number' || colDef.type === 'integer') {
    return Number(beforeVal) === Number(afterVal);
  }
  if (colDef.type === 'boolean') {
    return Boolean(beforeVal) === Boolean(afterVal);
  }
  return String(beforeVal).trim() === String(afterVal).trim();
}

function getTargetTablesFromMultiHop(multiHopResult) {
  const list = multiHopResult?.hop2?.targetTables;
  if (Array.isArray(list) && list.length > 0) {
    return list;
  }
  return multiHopResult?.hop2?.targetTable
    ? [multiHopResult.hop2.targetTable]
    : [];
}

function buildMultiTableRecipientDirectory(targetTables, workspaceCustomers = []) {
  const allowedByLowerEmail = new Map();
  const recipients = [];
  let rowLevelCount = 0;

  for (const tbl of targetTables || []) {
    if (!tbl || !Array.isArray(tbl.rows)) continue;
    const emailCol = tbl.columnRoles?.emailCol || null;
    if (!emailCol) continue;
    tbl.rows.forEach((row, idx) => {
      const email = String(row[emailCol] ?? '').trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return;
      const rowId = resolveRowIdentifier(row, idx + 1);
      const contactCols = Object.entries(row)
        .filter(([k, v]) => {
          const l = k.toLowerCase();
          return (
            v !== null &&
            v !== undefined &&
            String(v).trim() !== '' &&
            /(?:manager|contact|customer|buyer|company|recipient|client|partner)/i.test(
              l
            ) &&
            l !== emailCol.toLowerCase()
          );
        })
        .reduce((acc, [k, v]) => {
          acc[k] = String(v).trim();
          return acc;
        }, {});

      const rec = {
        table_name: tbl.tableName,
        row_id: rowId,
        email,
        contacts: contactCols,
      };
      recipients.push(rec);
      rowLevelCount += 1;
      if (!allowedByLowerEmail.has(email.toLowerCase())) {
        allowedByLowerEmail.set(email.toLowerCase(), rec);
      }
    });
  }

  if (rowLevelCount > 0) {
    return { mode: 'row_level', recipients, allowedByLowerEmail };
  }

  return buildRecipientDirectory(null, workspaceCustomers);
}

/**
 * Builds the allowed email directory for a workspace operation:
 * - Uses row-level email column(s) when present on `targetTable`.
 * - Otherwise falls back to `workspaceCustomers` (registered buyers/customers for `businessId`).
 *
 * @param {object} targetTable
 * @param {Array<object>} workspaceCustomers
 * @returns {{ mode: 'row_level' | 'workspace_customers' | 'none', recipients: Array<object>, allowedByLowerEmail: Map<string, object> }}
 */
function buildRecipientDirectory(targetTable, workspaceCustomers = []) {
  const allowedByLowerEmail = new Map();
  const recipients = [];

  if (targetTable && Array.isArray(targetTable.rows)) {
    const emailCol = targetTable.columnRoles?.emailCol || null;
    if (emailCol) {
      targetTable.rows.forEach((row, idx) => {
        const email = String(row[emailCol] ?? '').trim();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return;
        const rowId = resolveRowIdentifier(row, idx + 1);
        const contactCols = Object.entries(row)
          .filter(([k, v]) => {
            const l = k.toLowerCase();
            return (
              v !== null &&
              v !== undefined &&
              String(v).trim() !== '' &&
              /(?:manager|contact|customer|buyer|company|recipient|client|partner)/i.test(
                l
              ) &&
              l !== emailCol.toLowerCase()
            );
          })
          .reduce((acc, [k, v]) => {
            acc[k] = String(v).trim();
            return acc;
          }, {});

        const rec = {
          row_id: rowId,
          email,
          contacts: contactCols,
        };
        recipients.push(rec);
        if (!allowedByLowerEmail.has(email.toLowerCase())) {
          allowedByLowerEmail.set(email.toLowerCase(), rec);
        }
      });

      if (recipients.length > 0) {
        return { mode: 'row_level', recipients, allowedByLowerEmail };
      }
    }
  }

  if (Array.isArray(workspaceCustomers) && workspaceCustomers.length > 0) {
    for (const c of workspaceCustomers) {
      const email = String(c.email || '').trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) continue;
      const rec = {
        buyer_name: c.name || 'Valued Buyer',
        email,
      };
      recipients.push(rec);
      if (!allowedByLowerEmail.has(email.toLowerCase())) {
        allowedByLowerEmail.set(email.toLowerCase(), rec);
      }
    }
    if (recipients.length > 0) {
      return { mode: 'workspace_customers', recipients, allowedByLowerEmail };
    }
  }

  return { mode: 'none', recipients: [], allowedByLowerEmail };
}

/**
 * Generalized Stage A: Analyzes retrieved policy/directive documents against the target
 * table's schema and rows using structured Gemini reasoning + deterministic validation.
 *
 * @param {object} multiHopResult
 * @param {string} prompt
 * @returns {Promise<object>}
 */
async function analyzeCrossDocumentOperation(multiHopResult, prompt) {
  const targetTables = getTargetTablesFromMultiHop(multiHopResult);
  const targetTable = targetTables[0] || null;
  const retrievedChunks = multiHopResult?.retrievedChunks || [];
  const workspaceCustomers = multiHopResult?.workspaceCustomers || [];

  if (!targetTable) {
    return {
      datasetCompatible: false,
      affectedRowIds: [],
      conflictingRowIds: [],
      hasConflict: true,
      conflictSummary:
        'No matching target table or records were found in this business workspace. Please upload or select the target dataset first.',
      affectedRowsCount: 0,
      conflictingRowsCount: 0,
      socraticQuestions: [
        {
          question_id: 'missing_target_dataset',
          question_text:
            'No matching dataset was found in this workspace. How would you like to proceed?',
          options: [
            {
              option_id: 'cancel_operation',
              label: 'Cancel operation until target dataset is uploaded',
              rule_interpretation: 'Abort safely: mutate 0 database rows and dispatch 0 emails.',
            },
          ],
        },
      ],
    };
  }

  if (retrievedChunks.length === 0) {
    return {
      datasetCompatible: true,
      affectedRowIds: [],
      conflictingRowIds: [],
      hasConflict: true,
      conflictSummary:
        'No policy or directive documents are currently indexed in this workspace to govern this cross-document operation.',
      affectedRowsCount: 0,
      conflictingRowsCount: 0,
      socraticQuestions: [
        {
          question_id: 'missing_policy_documents',
          question_text:
            'No governing policy documents were found in this workspace. How would you like to proceed?',
          options: [
            {
              option_id: 'cancel_operation',
              label: 'Cancel operation until policy documents are uploaded',
              rule_interpretation: 'Abort safely: mutate 0 database rows and dispatch 0 emails.',
            },
          ],
        },
      ],
    };
  }

  const isMultiTable = targetTables.length > 1;
  const projectedTableContexts = targetTables.map((tbl) => ({
    table: tbl,
    ...projectTableForLlm(tbl),
  }));
  const primaryCtx = projectedTableContexts[0];
  const schemaColumns = primaryCtx.schemaColumns;
  const modifiableColumns = isMultiTable
    ? projectedTableContexts.flatMap((ctx) =>
        ctx.modifiableColumns.map((c) => ({
          table_name: ctx.table.tableName,
          ...c,
        }))
      )
    : primaryCtx.modifiableColumns;
  const projectedRows = isMultiTable
    ? projectedTableContexts.flatMap((ctx) =>
        ctx.projectedRows.map((row) => ({
          _table_name: ctx.table.tableName,
          ...row,
        }))
      )
    : primaryCtx.projectedRows;

  const findRowMatchAcrossTables = (rawKey) => {
    const key = String(rawKey ?? '').trim();
    if (!key) return null;
    if (key.includes('::')) {
      const [tblPart, idPart] = key.split('::');
      const ctx = projectedTableContexts.find(
        (c) => c.table.tableName.toLowerCase() === tblPart.trim().toLowerCase()
      );
      if (ctx) {
        const hit = ctx.rowLookup.get(idPart.trim()) || ctx.rowLookup.get(idPart.trim().toLowerCase());
        if (hit) return { ...hit, tableName: ctx.table.tableName };
      }
    }
    for (const ctx of projectedTableContexts) {
      const hit = ctx.rowLookup.get(key) || ctx.rowLookup.get(key.toLowerCase());
      if (hit) return { ...hit, tableName: ctx.table.tableName };
    }
    return null;
  };

  const recipientDir = buildMultiTableRecipientDirectory(
    targetTables,
    workspaceCustomers
  );

  const docsPayload = retrievedChunks.map((c) => ({
    filename: c.filename,
    page: c.page_number,
    section: c.section_title || undefined,
    content: c.raw_text,
  }));

  const multiTableGuidance = isMultiTable
    ? `\nMULTI-TABLE OPERATION CONTEXT (${targetTables.length} tables involved: ${targetTables.map((t) => t.tableName).join(', ')}):
- TARGET_TABLE_ROWS contains rows from multiple tables, tagged with "_table_name" and "_row_id".
- Include qualifying "_row_id" values from EVERY involved table (for example, BOTH matching open backorder rows AND matching catalog product rows) in "affected_row_ids".
- When updating stock on a table that has a non-modifiable "virtual_computed: true" summary column (such as "total_stock") alongside a modifiable JSON map column with "nested_map_json: true" (such as "size"), specify updates ONLY to the modifiable JSON map column ("size") as a valid JSON object string (never the virtual column).
- In every option's "rule_interpretation", state exact per-table, per-row column targets and numeric/JSON values for EACH involved table.\n`
    : '';

  const schemaSectionText = isMultiTable
    ? `WORKSPACE_TABLE_NAMES: ${JSON.stringify(targetTables.map((t) => t.tableName))}
TARGET_TABLES_SCHEMAS:
${JSON.stringify(
  projectedTableContexts.map((ctx) => ({
    table_name: ctx.table.tableName,
    columns: ctx.schemaColumns,
    modifiable_columns: ctx.modifiableColumns.map((c) => c.name),
  }))
)}`
    : `WORKSPACE_TABLE_NAME: ${targetTable.tableName}
TARGET_TABLE_SCHEMA:
${JSON.stringify(schemaColumns)}

MODIFIABLE_COLUMNS:
${JSON.stringify(primaryCtx.modifiableColumns.map((c) => c.name))}`;

  const analysisPrompt = `You are a precision B2B Autonomous Operations & Governance Compliance Analyst.
Evaluate the USER INSTRUCTION by cross-referencing ALL UPLOADED DOCUMENTS against TARGET_TABLE_SCHEMA and TARGET_TABLE_ROWS.

STRICT EVALUATION PROTOCOL (ZERO HARDCODING — DERIVE ALL RULES SOLELY FROM THE DOCUMENTS & TABLE):
1. DATASET COMPATIBILITY ("dataset_compatible"):
   - Verify whether TARGET_TABLE_ROWS and TARGET_TABLE_SCHEMA actually contain the domain entities, SKUs, categories, tiers, or batch/lot identifiers targeted by the UPLOADED DOCUMENTS.
   - If the documents mandate filtering by specific batch codes, product lines, or columns that are completely absent from TARGET_TABLE_SCHEMA and TARGET_TABLE_ROWS (e.g., a hardware batch recall applied to an unrelated merchandise table with zero matching items or batch columns), set "dataset_compatible": false, "affected_row_ids": [], "conflicting_row_ids": [], and "has_conflict": true. Explain the exact mismatch in "conflict_summary" and provide selectable options in "socratic_questions" (including "cancel_operation" to safely leave unrelated rows untouched).

2. ELIGIBILITY FILTERING ("affected_row_ids"):
   - Carefully evaluate every row in TARGET_TABLE_ROWS against the target scope of the operational directive/memo/manifest/recall (e.g., eligible categories, current tier, SKU codes, recalled batch IDs, open/pending/delayed status, spend thresholds, delay thresholds, or active inventory stock).
   - Treat eligibility and governance as separate steps: rows that fail any mandatory eligibility condition MUST be excluded from "affected_row_ids" and "conflicting_row_ids". An ineligible row is not a policy conflict; only evaluate governance conflicts for rows that first qualify.
   - For numeric or arithmetic eligibility conditions, calculate each expression from the exact named columns and current row values before deciding. Do not substitute a similarly named field or include a row whose calculated value fails any required threshold.
   - SUPERSET RULE: "affected_row_ids" MUST contain ALL qualifying rows targeted by the directive/memo/manifest BEFORE applying governance caps, freezes, or exclusions — meaning rows that hit a policy cap, price floor, overdue arrears freeze, payment-rail exception, or supply deficit MUST STILL BE INCLUDED in "affected_row_ids" (and ALSO listed in "conflicting_row_ids") so the operator can choose whether to cap, freeze, prorate, or exclude them!
   - When an operational advisory or delay/disruption notice projects delays onto currently active/processing rows at specified hubs, ports, or regions that push them beyond a policy SLA threshold, include already-breached rows (and, if applicable to the instruction, notice-impacted active/processing rows) in "affected_row_ids".
   - Note on stock/inventory maps & parenthetical inclusions: if a virtual stock summary column is present alongside a JSON size/stock map, check both individual stock and any aggregate category stock rule ("or all active stocked rows within those categories if aggregate stock exceeds thresholds"), and include all stocked rows in the eligible categories (especially items explicitly named as included examples in the directive).
   - Exclude rows that are outside the target categories/tiers/batches/SKUs, below hard individual eligibility thresholds (like annual spend minimums), explicitly listed as excluded categories/items, or already in a completed state when the directive targets undelivered/processing/pending orders (note: post-shipment safety/quality recalls apply to shipped, delivered, and processing orders unless the instruction/SOP specifically restricts to undelivered/processing/pending orders).
   - Every element in "affected_row_ids" MUST be an exact "_row_id" string from TARGET_TABLE_ROWS.

3. GOVERNANCE CONFLICTS, DEFICITS & EXCEPTION GATES ("conflicting_row_ids", "has_conflict", "socratic_questions"):
   - Check all qualifying "affected_row_ids" against BOTH explicit policy gates AND implicit data-vs-policy conflicts:
     a) Explicit Policy Gates: ceiling/discount caps, net price floors, arrears/overdue balance credit prohibitions, payment-rail settlement exceptions (e.g., Cash on Delivery vs. prepaid gateway), storefront safety buffer deficits, or supply/allocation deficits (where total requested units across eligible open rows exceed net passed/available units).
     b) Implicit Data-vs-Policy Conflicts (MUST ALSO trigger "has_conflict": true even if the PDF does not list named options!):
        - Duplicate / Stacking Compensation Conflict: One or more qualifying rows ALREADY have an active voucher/compensation/discount flag set to true or an existing promo discount > 0, making it ambiguous whether to cap/avoid duplicate compensation or stack it.
        - Dual-Cohort Scope Ambiguity: One document is a forward-looking delay/disruption notice affecting currently scheduled/processing rows at impacted locations while other rows have already breached the numeric threshold, making cohort scope ambiguous.
   - Distinguish a satisfied policy prerequisite from a conflict: when a policy permits an action only after a condition (such as explicit operator authorization or a notification request), verify whether the USER_INSTRUCTION already satisfies that condition. If it does, follow the policy without creating a Socratic conflict. A request to draft/preview a notification is not, by itself, a conflict with a policy that allows notification when requested; final dispatch remains subject to the normal confirmation step.
   - If ANY explicit or implicit conflict, cap breach, arrears prohibition, payment-rail exception, duplicate-voucher flag, dual-cohort ambiguity, or supply/buffer deficit exists:
     * Set "has_conflict": true.
     * Set "conflicting_row_ids" to the exact subset of "affected_row_ids" that trigger the conflict, existing voucher/discount flag, freeze, cap, payment exception, high-value/retention protection rule, or deficit (MUST be non-empty whenever qualifying rows have a conflict).
     * Write a precise "conflict_summary" naming the conflicting rules, exact numbers/thresholds, and affected "_row_id"s.
     * Construct "socratic_questions" (1 clear governance question): if the uploaded documents define explicit options matching this workflow (e.g., Option 1 / Option 2 or Option A / Option B), mirror those EXACT options; otherwise synthesize 2 to 3 distinct, policy-grounded resolution options.
     * ACTIONABLE OPTIONS MANDATE: Before writing each option's "rule_interpretation", inspect the current column values of TARGET_TABLE_ROWS! If a boolean flag (such as voucher/compensation issued) is ALREADY true on qualifying rows, check which OTHER modifiable columns have NOT yet been updated to match the policy (for example, a dispatch/order/account status column still holding an old label like "Delayed" instead of the policy's formal classification label like "SLA-Breached", or an unadjusted total/discount column, or unflagged rows in an advisory-impacted cohort). Every non-cancel option MUST explicitly name at least one modifiable column and target value that DIFFERS from the current values in TARGET_TABLE_ROWS — NEVER write an option that leaves all columns unchanged!
     * CRITICAL: Inside each option's "rule_interpretation", write a complete, unambiguous mathematical & operational specification: state EXACTLY which qualifying cohorts/rows are updated vs. excluded, the EXACT formula or target values for each modifiable column (including target status labels, caps, floors, freezes, prorating percentages, FIFO date ordering, or storefront buffer allocations), and the EXACT email notification rule (including whether workspace registered buyers are emailed when the table has no email column, or whether certain rows are excluded from promotional emails).
   - Only set "has_conflict": false (with "socratic_questions": []) when dataset_compatible is true, affected_row_ids is non-empty, and ZERO explicit or implicit policy/data conflicts exist.
${multiTableGuidance}
${schemaSectionText}

RECIPIENT_DIRECTORY_SUMMARY:
${JSON.stringify({
  mode: recipientDir.mode,
  available_recipient_count: recipientDir.recipients.length,
})}

UPLOADED_DOCUMENTS:
${JSON.stringify(docsPayload, null, 2)}

TARGET_TABLE_ROWS (${projectedRows.length} rows):
${JSON.stringify(projectedRows)}

USER_INSTRUCTION:
${prompt}`;

  const validated = await generateStructuredJsonWithRetry(
    analysisPrompt,
    (parsed) => {
      if (!parsed || typeof parsed !== 'object') {
        throw new Error('Response must be a JSON object.');
      }

      const datasetCompatible = Boolean(parsed.dataset_compatible);
      const seenAffected = new Set();
      const affectedRowIds = [];
      if (datasetCompatible) {
        for (const rawId of Array.isArray(parsed.affected_row_ids)
          ? parsed.affected_row_ids
          : []) {
          const match = findRowMatchAcrossTables(rawId);
          const uniqueKey = match ? `${match.tableName}::${match.identifier}` : null;
          if (match && !seenAffected.has(uniqueKey)) {
            seenAffected.add(uniqueKey);
            affectedRowIds.push(match.identifier);
          }
        }
      }

      const seenConflicting = new Set();
      const conflictingRowIds = [];
      if (datasetCompatible) {
        for (const rawId of Array.isArray(parsed.conflicting_row_ids)
          ? parsed.conflicting_row_ids
          : []) {
          const match = findRowMatchAcrossTables(rawId);
          const uniqueKey = match ? `${match.tableName}::${match.identifier}` : null;
          if (match && !seenConflicting.has(uniqueKey)) {
            if (!seenAffected.has(uniqueKey)) {
              seenAffected.add(uniqueKey);
              affectedRowIds.push(match.identifier);
            }
            seenConflicting.add(uniqueKey);
            conflictingRowIds.push(match.identifier);
          }
        }
      }

      let hasConflict = Boolean(parsed.has_conflict);
      if (!datasetCompatible || affectedRowIds.length === 0 || conflictingRowIds.length > 0) {
        hasConflict = true;
      }

      let conflictSummary = String(parsed.conflict_summary || '').trim();
      if (hasConflict && !conflictSummary) {
        conflictSummary = !datasetCompatible
          ? `The uploaded documents target records or batch identifiers that do not exist in table "${targetTable.tableName}".`
          : affectedRowIds.length === 0
            ? `Zero rows in "${targetTable.tableName}" matched the eligibility rules in the uploaded documents.`
            : `A policy governance conflict was detected across ${conflictingRowIds.length || affectedRowIds.length} record(s) in "${targetTable.tableName}".`;
      }

      let socraticQuestions = Array.isArray(parsed.socratic_questions)
        ? parsed.socratic_questions
            .map((q, qIdx) => {
              const options = (Array.isArray(q?.options) ? q.options : [])
                .filter(
                  (o) =>
                    o &&
                    String(o.option_id || '').trim() &&
                    String(o.label || '').trim()
                )
                .map((o) => ({
                  option_id: String(o.option_id).trim(),
                  label: String(o.label).trim(),
                  rule_interpretation:
                    String(o.rule_interpretation || o.label).trim(),
                }));
              return {
                question_id:
                  String(q?.question_id || '').trim() ||
                  `governance_resolution_${qIdx + 1}`,
                question_text:
                  String(q?.question_text || '').trim() ||
                  'Select an authorized resolution rule to proceed:',
                options,
              };
            })
            .filter((q) => q.question_text)
        : [];

      // Zero-Deadlock Guarantee: every CLARIFICATION_REQUIRED state MUST provide >= 1 selectable option
      if (hasConflict) {
        if (socraticQuestions.length === 0) {
          socraticQuestions = [
            {
              question_id: 'governance_resolution_1',
              question_text:
                'How should this policy discrepancy or dataset constraint be resolved?',
              options: [
                {
                  option_id: 'cancel_operation',
                  label: 'Cancel operation without modifying records',
                  rule_interpretation:
                    'Abort safely: mutate 0 database rows and dispatch 0 emails.',
                },
              ],
            },
          ];
        } else {
          socraticQuestions = socraticQuestions.map((q) => {
            if (q.options.length === 0) {
              return {
                ...q,
                options: [
                  {
                    option_id: 'cancel_operation',
                    label: 'Cancel operation without modifying records',
                    rule_interpretation:
                      'Abort safely: mutate 0 database rows and dispatch 0 emails.',
                  },
                ],
              };
            }
            return q;
          });
        }
      } else {
        socraticQuestions = [];
      }

      return {
        datasetCompatible,
        affectedRowIds,
        conflictingRowIds,
        hasConflict,
        conflictSummary: hasConflict ? conflictSummary : null,
        affectedRowsCount: affectedRowIds.length,
        conflictingRowsCount: conflictingRowIds.length,
        socraticQuestions,
      };
    },
    {
      maxRetries: 2,
      responseSchema: SOCRATIC_ANALYSIS_SCHEMA,
      stage: 'socratic_analysis',
    }
  );

  return validated;
}

/**
 * Builds grounded cross-source citations from retrieved document chunks and relevant table rows.
 *
 * @param {object} multiHopResult
 * @param {string[]} prioritizedRowIds
 * @returns {Array<object>}
 */
function buildCrossSourceCitations(multiHopResult, prioritizedRowIds = []) {
  const citations = [];
  const seenDocPages = new Set();

  for (const chunk of multiHopResult?.retrievedChunks || []) {
    const key = `${chunk.filename}::${chunk.page_number}`;
    if (seenDocPages.has(key)) continue;
    seenDocPages.add(key);
    citations.push(buildDocumentCitation(chunk));
  }

  const targetTables = getTargetTablesFromMultiHop(multiHopResult);
  for (const targetTable of targetTables) {
    if (!targetTable || !Array.isArray(targetTable.rows) || targetTable.rows.length === 0) {
      continue;
    }
    const { rowLookup } = projectTableForLlm(targetTable);
    const citedRows = [];
    const seenIds = new Set();

    for (const rid of prioritizedRowIds) {
      const match = rowLookup.get(rid) || rowLookup.get(String(rid).toLowerCase());
      if (match && !seenIds.has(match.identifier)) {
        seenIds.add(match.identifier);
        citedRows.push(match.row);
      }
      if (citedRows.length >= 8) break;
    }

    if (citedRows.length === 0) {
      for (const row of targetTable.rows.slice(0, 3)) {
        citedRows.push(row);
      }
    }

    citedRows.forEach((row, idx) => {
      citations.push(buildTableRowCitation(targetTable.tableName, row, idx + 1));
    });
  }

  return citations;
}

/**
 * Legacy synchronous wrapper retained for export compatibility if called directly.
 */
function evaluateSocraticConflicts(multiHopResult, prompt) {
  const targetTable = multiHopResult?.hop2?.targetTable;
  if (!targetTable) {
    return {
      hasConflict: true,
      conflictSummary:
        'No matching target table or records were found in the workspace for this operation.',
      affectedRowsCount: 0,
      conflictingRowsCount: 0,
      socraticQuestions: [
        {
          question_id: 'missing_target_dataset',
          question_text: 'Which dataset should be targeted?',
          options: [
            {
              option_id: 'cancel_operation',
              label: 'Cancel operation until dataset is uploaded',
              rule_interpretation: 'Do not mutate any rows.',
            },
          ],
        },
      ],
    };
  }
  return {
    hasConflict: false,
    conflictSummary: null,
    affectedRowsCount: multiHopResult?.hop2?.combinedCandidateRows?.length || 0,
    conflictingRowsCount: 0,
    socraticQuestions: [],
  };
}

/**
 * Normalizes caller-supplied `selected_options` from Turn 2 into a canonical option_id string.
 *
 * @param {any} selectedOptions
 * @param {Array<object>} socraticQuestions
 * @returns {{ optionId: string, optionMeta: object }}
 */
function resolveSelectedOption(selectedOptions, socraticQuestions = []) {
  const allOptions = [];
  for (const q of socraticQuestions) {
    for (const opt of q.options || []) {
      allOptions.push(opt);
    }
  }

  let rawChoice = null;
  if (typeof selectedOptions === 'string' && selectedOptions.trim()) {
    rawChoice = selectedOptions.trim();
  } else if (Array.isArray(selectedOptions) && selectedOptions.length > 0) {
    const first = selectedOptions[0];
    rawChoice =
      typeof first === 'string'
        ? first.trim()
        : first?.option_id || first?.id || first?.value || null;
  } else if (selectedOptions && typeof selectedOptions === 'object') {
    if (typeof selectedOptions.option_id === 'string') {
      rawChoice = selectedOptions.option_id.trim();
    } else {
      const vals = Object.values(selectedOptions);
      if (vals.length > 0 && typeof vals[0] === 'string') {
        rawChoice = vals[0].trim();
      }
    }
  }

  if (rawChoice) {
    const exactMatch = allOptions.find(
      (o) =>
        o.option_id.toLowerCase() === rawChoice.toLowerCase() ||
        o.label.toLowerCase() === rawChoice.toLowerCase()
    );
    if (exactMatch) {
      return { optionId: exactMatch.option_id, optionMeta: exactMatch };
    }
  }

  if (!rawChoice && allOptions.length === 1) {
    return { optionId: allOptions[0].option_id, optionMeta: allOptions[0] };
  }
  throw new AppError(
    'Select one of the clarification options before preparing a preview.',
    400
  );
}

/**
 * Generalized Stage B: Compiles exact row-level mutations and personalized email previews
 * for the operator's selected Socratic option, strictly validated against the live PostgreSQL
 * schema, live `before` row values, and verified workspace email recipients.
 *
 * @param {object} workflow
 * @param {string} optionId
 * @param {object} optionMeta
 * @returns {Promise<{ mutationsPreview: Array<object>, emailsPreview: Array<object> }>}
 */
async function compileResolutionPreview(workflow, optionId, optionMeta) {
  const normalizedOptionId = String(optionId || '').trim().toLowerCase();
  const ruleInterpLower = String(optionMeta?.rule_interpretation || '')
    .trim()
    .toLowerCase();

  if (
    normalizedOptionId === 'cancel_operation' ||
    normalizedOptionId === 'abort_operation' ||
    normalizedOptionId.startsWith('cancel_') ||
    normalizedOptionId.startsWith('abort_') ||
    /\babort\s+safely|\bmutate\s+0\s+database\s+rows|\bdo\s+not\s+mutate\s+any\b/.test(
      ruleInterpLower
    )
  ) {
    return { mutationsPreview: [], emailsPreview: [] };
  }

  const multiHopResult = workflow?.multiHopResult;
  const targetTables = getTargetTablesFromMultiHop(multiHopResult);
  const primaryTable = targetTables[0] || null;
  if (!primaryTable) {
    return { mutationsPreview: [], emailsPreview: [] };
  }

  const isMultiTable = targetTables.length > 1;
  const tableContextsByLowerName = new Map();
  const projectedTableContexts = targetTables.map((tbl) => {
    const projected = projectTableForLlm(tbl);
    const ctx = {
      table: tbl,
      tableName: tbl.tableName,
      schema: tbl.schema,
      ...projected,
    };
    tableContextsByLowerName.set(tbl.tableName.toLowerCase(), ctx);
    return ctx;
  });

  const primaryCtx = projectedTableContexts[0];
  const recipientDir = buildMultiTableRecipientDirectory(
    targetTables,
    multiHopResult?.workspaceCustomers || []
  );

  const affectedIdsSet = new Set(workflow?.analysis?.affectedRowIds || []);
  const conflictingIdsSet = new Set(workflow?.analysis?.conflictingRowIds || []);

  if (
    workflow?.analysis &&
    (workflow.analysis.datasetCompatible === false || affectedIdsSet.size === 0)
  ) {
    return { mutationsPreview: [], emailsPreview: [] };
  }

  let candidateProjectedRows = [];
  if (isMultiTable) {
    for (const ctx of projectedTableContexts) {
      let tableCandidates =
        affectedIdsSet.size > 0
          ? ctx.projectedRows.filter((r) => affectedIdsSet.has(r._row_id))
          : ctx.projectedRows.slice(0, 40);

      // Failsafe for secondary tables: if Stage A omitted a secondary table's rows,
      // still supply its matching or full candidate rows so multi-table compilation cannot miss them.
      if (tableCandidates.length === 0) {
        tableCandidates = ctx.projectedRows.slice(0, 40);
      }

      for (const r of tableCandidates) {
        candidateProjectedRows.push({
          _table_name: ctx.tableName,
          ...r,
          _had_conflict: conflictingIdsSet.has(r._row_id),
        });
      }
    }
  } else {
    candidateProjectedRows =
      affectedIdsSet.size > 0
        ? primaryCtx.projectedRows
            .filter((r) => affectedIdsSet.has(r._row_id))
            .map((r) => ({
              ...r,
              _had_conflict: conflictingIdsSet.has(r._row_id),
            }))
        : primaryCtx.projectedRows.slice(0, 60);
  }

  if (candidateProjectedRows.length === 0) {
    return { mutationsPreview: [], emailsPreview: [] };
  }

  // Filter recipient directory to candidate rows when in row_level mode so prompt stays compact
  const relevantRecipients =
    recipientDir.mode === 'row_level' && affectedIdsSet.size > 0
      ? recipientDir.recipients.filter((rec) => affectedIdsSet.has(rec.row_id))
      : recipientDir.recipients;

  const docsPayload = (multiHopResult?.retrievedChunks || []).slice(0, 8).map((c) => ({
    filename: c.filename,
    page: c.page_number,
    content: c.raw_text,
  }));

  const multiTableCompileRules = isMultiTable
    ? `\n   - MULTI-TABLE MUTATIONS: Because TARGET_TABLES includes multiple tables (${targetTables.map((t) => t.tableName).join(', ')}), EVERY entry in "mutations" MUST set "table_name" to the exact "_table_name" of that row's table, validate "column" against that table's modifiable_columns ONLY, and compile all required updates across EVERY affected table.
   - NESTED JSON MAP COLUMNS: When updating a column with "nested_map_json: true" (for example, "size" on "products"), NEVER target a non-modifiable "virtual_computed: true" summary column (such as "total_stock"); serialize "new_value" as a valid JSON object string (for example, "{\\"M\\":2,\\"L\\":3,\\"XL\\":3,\\"XXL\\":2}") whose values are non-negative integers summing to the target stock.`
    : '';

  const tablesSectionText = isMultiTable
    ? `TARGET_TABLES:
${JSON.stringify(
  projectedTableContexts.map((ctx) => ({
    table_name: ctx.tableName,
    modifiable_columns: ctx.modifiableColumns,
  }))
)}`
    : `TABLE_NAME: ${primaryTable.tableName}
MODIFIABLE_COLUMNS:
${JSON.stringify(primaryCtx.modifiableColumns)}`;

  const compilePrompt = `You are a deterministic B2B Database Mutation & Notification Compiler.
Compile the exact row updates and email notifications required to execute the SELECTED_SOCRATIC_OPTION for the USER_INSTRUCTION, strictly adhering to UPLOADED_DOCUMENTS, MODIFIABLE_COLUMNS, CANDIDATE_ROWS, and ALLOWED_RECIPIENTS.

STRICT COMPILATION RULES:
1. ROW SELECTION & EXACT ARITHMETIC:
   - Mutate ONLY the rows in CANDIDATE_ROWS that should be modified under SELECTED_SOCRATIC_OPTION.
   - If SELECTED_SOCRATIC_OPTION excludes a subset of rows (for example, excluding "luxury shirt" rows from markdown, or excluding uncompensated/breached cohorts), DO NOT include those excluded rows in "mutations" (and follow the option's rule on whether excluded items/rows are omitted from emails).
   - Ensure every included row receives ALL required status/classification transitions AND numeric/flag updates mandated by UPLOADED_DOCUMENTS and SELECTED_SOCRATIC_OPTION. In particular, even if SELECTED_SOCRATIC_OPTION preserves idempotency on an already-true boolean flag or freezes/preserves a credit limit, check whether an Account Status, Order/Dispatch Status, Refund Status, or JSON stock map must be updated to match the option rules!
   - Compute exact arithmetic on each row's current values:
     * Percentage-point increases (e.g., "+20% added to current discount" on 25 -> "45"; capped at 30% ceiling -> "30").
     * Percentage multipliers (e.g., "+25% credit limit" -> current * 1.25; "-25% credit limit cut" -> current * 0.75; "10% subtotal voucher deducted" -> current_total - (subtotal * 0.10)).
     * Proportional prorating vs. FIFO oldest-first (by order_date ascending) unit allocations vs. storefront buffer preservation: verify the sum of allocated units across backorder rows + remaining storefront stock matches exact manifest & policy numbers!
     * Exact status/tier/batch strings as written in the policy documents (e.g., "Gold", "Gold - Credit Frozen", "Pending Arrears", "Credit Hold", "Retention Grace (14-Day)", "Fulfilled", "Partial", "Backordered", "SLA-Breached", "Recalled - QA Hold", "Refunded", "Pending Payout Verification", "B-501", "Expedited", "Ready for Expedited Dispatch", "Replacement Swapped (B-501)").${multiTableCompileRules}

2. SCHEMA CONFORMANCE:
   - Every "column" in "updates" MUST be an exact column name from that table's modifiable_columns. Never invent columns or update read-only/virtual columns.
   - Serialize "new_value" as a clean string (e.g. "45", "10000", "true", "Partial") without currency symbols or "%" signs on numeric columns (and valid JSON object string on "nested_map_json: true" columns).
   - Include only columns whose value actually changes on that row.

3. EMAIL NOTIFICATIONS:
   - Check whether USER_INSTRUCTION or UPLOADED_DOCUMENTS request emailing/notifying buyers, customers, or account contacts/managers.
   - Every "recipient_email" MUST come strictly from ALLOWED_RECIPIENTS (never invent email addresses).
   - If RECIPIENT_MODE is "row_level": address the specific contact person on each notified row by their actual name (e.g., if an account_manager or buyer_name or Customer_Name column exists alongside company_name or Order_ID, greet the person by name and reference their company/order/account ID, exact updated values, and policy terms/credits/document IDs).
   - If RECIPIENT_MODE is "workspace_customers" (e.g., catalog-wide price/discount update on a products table without row-level emails): generate one personalized announcement email per buyer in ALLOWED_RECIPIENTS listing ONLY the products actually updated under SELECTED_SOCRATIC_OPTION, their new discount percentages, and final net prices.
   - If ALLOWED_RECIPIENTS is empty or no notifications were requested, return "emails": [].

${tablesSectionText}

RECIPIENT_MODE: ${recipientDir.mode}
ALLOWED_RECIPIENTS:
${JSON.stringify(relevantRecipients)}

SELECTED_SOCRATIC_OPTION:
${JSON.stringify({
  option_id: optionId,
  label: optionMeta?.label || optionId,
  rule_interpretation: optionMeta?.rule_interpretation || '',
})}

USER_INSTRUCTION:
${workflow.prompt || ''}

UPLOADED_DOCUMENTS:
${JSON.stringify(docsPayload, null, 2)}

CANDIDATE_ROWS:
${JSON.stringify(candidateProjectedRows)}`;

  const compiled = await generateStructuredJsonWithRetry(
    compilePrompt,
    (parsed) => {
      if (!parsed || typeof parsed !== 'object') {
        throw new Error('Compiled preview must be a JSON object.');
      }

      const rawMutations = Array.isArray(parsed.mutations) ? parsed.mutations : [];
      const rawEmails = Array.isArray(parsed.emails) ? parsed.emails : [];

      const mutationsPreview = [];
      const seenMutatedRows = new Set();

      for (const item of rawMutations) {
        const rawTableName = String(item?.table_name ?? '').trim();
        const rawId = String(item?.row_identifier ?? '').trim();

        let resolvedCtx = rawTableName
          ? tableContextsByLowerName.get(rawTableName.toLowerCase()) || null
          : null;
        if (rawTableName && !resolvedCtx) {
          throw new Error(
            `Unknown table_name "${rawTableName}". Valid table names: ${projectedTableContexts.map((c) => c.tableName).join(', ')}.`
          );
        }

        let match = resolvedCtx
          ? resolvedCtx.rowLookup.get(rawId) ||
            resolvedCtx.rowLookup.get(rawId.toLowerCase())
          : null;

        if (!resolvedCtx) {
          for (const ctx of projectedTableContexts) {
            const candidateHit =
              ctx.rowLookup.get(rawId) || ctx.rowLookup.get(rawId.toLowerCase());
            if (candidateHit) {
              resolvedCtx = ctx;
              match = candidateHit;
              break;
            }
          }
        }

        if (!resolvedCtx || !match) {
          throw new Error(
            `Unknown row_identifier "${rawId}"${rawTableName ? ` in table "${rawTableName}"` : ''}. Use only exact _row_id values from CANDIDATE_ROWS.`
          );
        }

        const dedupKey = `${resolvedCtx.tableName.toLowerCase()}::${match.identifier}`;
        if (seenMutatedRows.has(dedupKey)) {
          continue;
        }

        const before = {};
        const after = {};
        const updatesList = Array.isArray(item.updates) ? item.updates : [];

        for (const upd of updatesList) {
          const requestedCol = String(upd?.column ?? '').trim();
          if (!requestedCol) continue;

          const colResolved = findColumnDef(resolvedCtx.schema, requestedCol);
          if (
            !colResolved ||
            !colResolved.colDef.modifiable ||
            colResolved.colDef.virtual
          ) {
            throw new Error(
              `Column "${requestedCol}" is not a modifiable column on table "${resolvedCtx.tableName}". Allowed modifiable columns: ${resolvedCtx.modifiableColumns.map((c) => c.name).join(', ')}.`
            );
          }

          const exactCol = colResolved.exactName;
          const coercedAfter = coerceValueForColumn(
            colResolved.colDef,
            exactCol,
            upd.new_value
          );
          const liveBefore = normalizeLiveBeforeValue(
            colResolved.colDef,
            match.row[exactCol]
          );

          if (!valuesAreEqual(colResolved.colDef, liveBefore, coercedAfter)) {
            before[exactCol] = liveBefore;
            after[exactCol] = coercedAfter;
          }
        }

        if (Object.keys(after).length > 0) {
          seenMutatedRows.add(dedupKey);
          mutationsPreview.push({
            table_name: resolvedCtx.tableName,
            row_identifier: match.identifier,
            _internal_id: match.row.id || null,
            _identifier_col: match.identifierCol || 'id',
            before,
            after,
          });
        }
      }

      if (
        mutationsPreview.length === 0 &&
        candidateProjectedRows.length > 0 &&
        !/\b0\s+rows|\bno\s+rows|\bwithout\s+modifying|\bleave\s+all\s+rows\s+unchanged/i.test(
          ruleInterpLower
        )
      ) {
        const availColsDesc = projectedTableContexts
          .map(
            (c) =>
              `${c.tableName}(${c.modifiableColumns.map((col) => col.name).join(', ')})`
          )
          .join('; ');
        throw new Error(
          `Compiled mutations produced 0 net column changes because either "mutations" was empty or every proposed new_value already matched the existing column value in CANDIDATE_ROWS. Even when preserving idempotency on an already-true flag or credit limit, you MUST return non-empty "mutations" updating at least one modifiable column (${availColsDesc}) whose post-update value differs from CANDIDATE_ROWS.`
        );
      }

      const emailsPreview = [];
      const promptRequestsNotifications = explicitlyRequestsNotifications(
        workflow?.prompt
      );
      for (const mail of rawEmails) {
        if (!promptRequestsNotifications) continue;
        const rawEmail = String(mail?.recipient_email ?? '').trim();
        if (!rawEmail) continue;
        const allowedRec = recipientDir.allowedByLowerEmail.get(
          rawEmail.toLowerCase()
        );
        if (!allowedRec) {
          throw new Error(
            `Recipient email "${rawEmail}" is not in ALLOWED_RECIPIENTS. Use only verified workspace email addresses.`
          );
        }
        const subject = String(mail?.subject ?? '').trim();
        const body = String(mail?.body ?? '').trim();
        if (!subject || !body) {
          throw new Error('Every email draft must include a non-empty subject and body.');
        }

        emailsPreview.push({
          recipient_email: allowedRec.email,
          customer_identifier:
            String(mail?.customer_identifier ?? '').trim() ||
            allowedRec.buyer_name ||
            allowedRec.row_id ||
            allowedRec.email,
          subject,
          body,
          metadata: {
            applied_rule:
              String(mail?.applied_rule ?? '').trim() ||
              optionMeta?.rule_interpretation ||
              optionMeta?.label ||
              optionId,
            row_identifier:
              String(mail?.row_identifier ?? '').trim() ||
              allowedRec.row_id ||
              'catalog_broadcast',
            option_id: optionId,
          },
        });
      }

      const expectedUpdatedTables = new Set(
        candidateProjectedRows
          .filter((row) => row._table_name && affectedIdsSet.has(row._row_id))
          .map((row) => row._table_name)
      );
      const compiledUpdatedTables = new Set(
        mutationsPreview.map((mutation) => mutation.table_name)
      );
      const omittedTables = [...expectedUpdatedTables].filter(
        (tableName) => !compiledUpdatedTables.has(tableName)
      );
      if (omittedTables.length > 0) {
        throw new Error(
          `The selected operation identifies affected rows in these tables, but the preview omitted their updates: ${omittedTables.join(', ')}. Include the required changes for every intended table or explicitly mark its rows as unchanged in the selected option.`
        );
      }

      if (promptRequestsNotifications && recipientDir.mode === 'row_level') {
        const mutatedRowIds = new Set(
          mutationsPreview.map((mutation) => String(mutation.row_identifier))
        );
        const requiredEmails = recipientDir.recipients
          .filter((recipient) => mutatedRowIds.has(String(recipient.row_id)))
          .map((recipient) => recipient.email.toLowerCase());
        const includedEmails = new Set(
          emailsPreview.map((email) => email.recipient_email.toLowerCase())
        );
        const omittedEmails = requiredEmails.filter(
          (email) => !includedEmails.has(email)
        );
        if (omittedEmails.length > 0) {
          throw new Error(
            `The requested notification preview omitted recipients associated with changed rows: ${omittedEmails.join(', ')}. Include their drafts or explicitly exclude those rows from notification in the selected option.`
          );
        }
      }

      return { mutationsPreview, emailsPreview };
    },
    {
      maxRetries: 2,
      responseSchema: PREVIEW_COMPILATION_SCHEMA,
      stage: 'preview_compilation',
    }
  );

  return compiled;
}

/**
 * Retained export alias delegating to `compileResolutionPreview`.
 */
async function buildPreviewFromResolution(workflow, optionId, optionMeta) {
  return compileResolutionPreview(workflow, optionId, optionMeta);
}

/**
 * Entry point for Phase 2 Socratic Operations Engine (`POST /api/workspace/execute`).
 * Evaluates a natural language instruction across unstructured documents and structured tables.
 * Returns `CLARIFICATION_REQUIRED` if conflicts exist, or `PREVIEW_READY` if zero conflicts exist.
 *
 * @param {object} params
 * @param {string} params.businessId
 * @param {string} params.prompt
 * @param {string} [params.entity]
 * @param {Array<object>} [params.history]
 * @returns {Promise<object>}
 */
async function executeWorkspaceOperation({
  businessId,
  prompt,
  entity = null,
  history = [],
}) {
  if (!businessId) {
    throw new AppError('A business ID is required to execute a workspace operation.', 400);
  }
  if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
    throw new AppError('Prompt is required to execute a workspace operation.', 400);
  }

  const fastQueryResult = await tryExecuteFastTableQuery({
    businessId,
    prompt,
    entity,
    history,
  });
  if (fastQueryResult) {
    return fastQueryResult;
  }

  const routed = await routeWorkspaceIntent({
    businessId,
    prompt,
    entity,
    history,
  });

  if (routed.intent === 'cross_source_read') {
    const result = await generateCrossSourceReadAnswer({
      businessId,
      prompt,
      targetEntities: routed.target_entities || [],
    });
    return {
      status: 'CONVERSATIONAL',
      conversational: true,
      intent: 'cross_source_read',
      message: result.message,
      answer: result.answer,
      rows: result.rows,
      highlighted_rows: result.highlighted_rows,
      citations: result.citations,
    };
  }

  if (routed.intent === 'sheet_query' || routed.intent === 'sheet_mutation') {
    return {
      status: routed.intent === 'sheet_query' ? 'SHEET_QUERY' : 'SHEET_MUTATION',
      intent: routed.intent,
      entity: routed.entity,
      prompt,
      message:
        routed.intent === 'sheet_query'
          ? 'Running this request through the spreadsheet query workflow.'
          : 'Preparing a validated spreadsheet mutation preview.',
      citations: [],
    };
  }

  if (routed.intent === 'document_question' || routed.intent === 'conversation') {
    return {
      status: 'CONVERSATIONAL',
      conversational: true,
      intent: routed.intent,
      message:
        routed.answer ||
        'I could not find enough grounded information to answer that. Please clarify what you would like to know.',
      citations: routed.citations,
    };
  }

  if (routed.intent === 'clarification_needed') {
    return {
      status: 'CONVERSATIONAL',
      conversational: true,
      intent: 'clarification_needed',
      message:
        routed.clarification ||
        'Please clarify which workspace data or action you mean.',
      citations: routed.citations,
    };
  }

  const conversationContext = (Array.isArray(history) ? history : [])
    .slice(-8)
    .map((turn) => `${turn.role === 'assistant' ? 'Assistant' : 'User'}: ${turn.content}`)
    .join('\n');
  const effectivePrompt = conversationContext
    ? `RECENT CONVERSATION:\n${conversationContext}\n\nLATEST USER REQUEST:\n${prompt}`
    : prompt;

  // Authoritatively propagate Gemini's resolved target table(s) (`routed.entity` / `routed.target_entities`)
  const authoritativeEntity = routed.entity || entity || null;
  const authoritativeEntities =
    Array.isArray(routed.target_entities) && routed.target_entities.length > 0
      ? routed.target_entities
      : authoritativeEntity
        ? [authoritativeEntity]
        : [];
  const multiHopResult = await executeMultiHopQuery(businessId, effectivePrompt, {
    targetEntity: authoritativeEntity,
    targetEntities: authoritativeEntities,
  });

  if (multiHopResult.conversational) {
    return {
      status: 'CONVERSATIONAL',
      conversational: true,
      intent: multiHopResult.intent,
      message:
        'Hello! I can help you analyze policy documents, cross-reference operational tables, resolve Socratic policy conflicts, and preview or execute batch updates and notifications.',
      citations: [],
    };
  }

  const workflowId = crypto.randomUUID();
  const analysis = await analyzeCrossDocumentOperation(multiHopResult, effectivePrompt);
  const prioritizedCitationRowIds = [
    ...(analysis.conflictingRowIds || []),
    ...(analysis.affectedRowIds || []),
  ];
  const citations = buildCrossSourceCitations(
    multiHopResult,
    prioritizedCitationRowIds
  );
  multiHopResult.citations = citations;

  if (analysis.hasConflict) {
    const workflow = {
      workflow_id: workflowId,
      business_id: businessId,
      status: 'CLARIFICATION_REQUIRED',
      prompt,
      target_entity: multiHopResult?.hop2?.targetTable?.tableName || authoritativeEntity,
      conflict_summary: analysis.conflictSummary,
      affected_rows_count: analysis.affectedRowsCount,
      conflicting_rows_count: analysis.conflictingRowsCount,
      socratic_questions: analysis.socraticQuestions,
      analysis,
      citations,
      multiHopResult,
    };

    await saveWorkflowState(workflow);

    return {
      status: 'CLARIFICATION_REQUIRED',
      workflow_id: workflowId,
      conflict_summary: analysis.conflictSummary,
      affected_rows_count: analysis.affectedRowsCount,
      conflicting_rows_count: analysis.conflictingRowsCount,
      socratic_questions: analysis.socraticQuestions,
      citations,
    };
  }

  // Zero conflicts -> compile deterministic preview immediately (STATE 2: PREVIEW_READY)
  const optionId = 'apply_policy';
  const optionMeta = {
    label: 'Apply policy rules to qualifying records',
    rule_interpretation:
      'Apply all retrieved document directives and policy rules directly to the qualifying records.',
  };
  const { mutationsPreview, emailsPreview } = await compileResolutionPreview(
    { prompt, analysis, multiHopResult },
    optionId,
    optionMeta
  );

  const publicMutationsPreview = mutationsPreview.map(
    ({ table_name, row_identifier, before, after }) => ({
      table_name,
      row_identifier,
      before,
      after,
    })
  );

  const workflow = {
    workflow_id: workflowId,
    business_id: businessId,
    status: 'PREVIEW_READY',
    prompt,
    target_entity: multiHopResult?.hop2?.targetTable?.tableName || authoritativeEntity,
    selected_option_id: optionId,
    mutations_preview: mutationsPreview,
    emails_preview: emailsPreview,
    analysis,
    citations,
    multiHopResult,
  };

  await saveWorkflowState(workflow);

  return {
    status: 'PREVIEW_READY',
    workflow_id: workflowId,
    mutations_preview: publicMutationsPreview,
    emails_preview: emailsPreview,
    citations,
  };
}

/**
 * Turn 2: Resolves a `CLARIFICATION_REQUIRED` workflow using the user's selected Socratic option(s)
 * and transitions the workflow to `PREVIEW_READY`.
 *
 * @param {object} params
 * @param {string} params.workflowId
 * @param {any} params.selectedOptions
 * @param {string} [params.businessId]
 * @returns {Promise<object>}
 */
async function resolveSocraticWorkflow({
  workflowId,
  selectedOptions,
  businessId = null,
}) {
  if (!workflowId) {
    throw new AppError('workflow_id is required to resolve Socratic conflict.', 400);
  }

  const workflow = await loadWorkflowState(workflowId);
  if (!workflow) {
    throw new AppError(`Workflow "${workflowId}" was not found.`, 404);
  }
  if (businessId && workflow.business_id !== businessId) {
    throw new AppError(`Workflow "${workflowId}" was not found.`, 404);
  }
  if (workflow.status !== 'CLARIFICATION_REQUIRED') {
    throw new AppError('Only a workflow awaiting clarification can be resolved.', 409);
  }

  const { optionId, optionMeta } = resolveSelectedOption(
    selectedOptions,
    workflow.socratic_questions || []
  );

  const { mutationsPreview, emailsPreview } = await compileResolutionPreview(
    workflow,
    optionId,
    optionMeta
  );

  const mutatedRowIds = mutationsPreview.map((m) => m.row_identifier);
  const updatedCitations = buildCrossSourceCitations(
    workflow.multiHopResult,
    mutatedRowIds
  );

  workflow.status = 'PREVIEW_READY';
  workflow.selected_option_id = optionId;
  workflow.selected_options = selectedOptions;
  workflow.mutations_preview = mutationsPreview;
  workflow.emails_preview = emailsPreview;
  workflow.citations = updatedCitations;

  await saveWorkflowState(workflow);

  const publicMutationsPreview = mutationsPreview.map(
    ({ table_name, row_identifier, before, after }) => ({
      table_name,
      row_identifier,
      before,
      after,
    })
  );

  return {
    status: 'PREVIEW_READY',
    workflow_id: workflow.workflow_id,
    mutations_preview: publicMutationsPreview,
    emails_preview: emailsPreview,
    citations: updatedCitations,
  };
}

/**
 * Turn 3: Confirms and executes a `PREVIEW_READY` workflow (`POST /api/workspace/confirm-operation`).
 * Atomically updates all rows in PostgreSQL and dispatches personalized emails.
 *
 * @param {object} params
 * @param {string} params.workflowId
 * @param {string} params.businessId
 * @param {boolean} params.confirm
 * @param {boolean} [params.dryRun=false]
 * @returns {Promise<object>}
 */
async function confirmWorkspaceOperation({
  workflowId,
  businessId,
  confirm,
  dryRun = false,
}) {
  if (!workflowId) {
    throw new AppError('workflow_id is required to confirm operation.', 400);
  }
  if (confirm !== true) {
    throw new AppError(
      'Confirmation flag "confirm: true" is required to execute mutations.',
      400
    );
  }

  const workflow = await loadWorkflowState(workflowId);
  if (!workflow) {
    throw new AppError(`Workflow "${workflowId}" was not found.`, 404);
  }
  if (!businessId || workflow.business_id !== businessId) {
    throw new AppError(`Workflow "${workflowId}" was not found.`, 404);
  }
  if (workflow.status !== 'PREVIEW_READY') {
    throw new AppError('Only an approved preview can be executed.', 409);
  }

  const mutationsPreview = workflow.mutations_preview || [];
  const emailsPreview = workflow.emails_preview || [];

  let updatedRowsCount = 0;

  if (mutationsPreview.length > 0) {
    await withTransaction(async (client) => {
      const targetTablesList = getTargetTablesFromMultiHop(workflow.multiHopResult);
      for (const mut of mutationsPreview) {
        const matchedTable = targetTablesList.find(
          (t) =>
            String(t.schema?.tableName || t.tableName).toLowerCase() ===
            String(mut.table_name).toLowerCase()
        );
        const schema = matchedTable?.schema;
        if (!schema) {
          throw new AppError(
            `The approved preview references an unknown table "${mut.table_name}".`,
            409
          );
        }
        const safeTable = quoteIdentifier(schema.tableName || matchedTable.tableName);
        const afterObj = mut.after || {};
        const afterEntries = Object.entries(afterObj);
        if (afterEntries.length === 0) continue;

        const setClauses = [];
        const values = [workflow.business_id];

        for (const [colName, newVal] of afterEntries) {
          const column = findColumnDef(schema, colName);
          if (!column || !column.colDef.modifiable || column.colDef.virtual) {
            throw new AppError(
              `The approved preview references an invalid or read-only field "${colName}".`,
              409
            );
          }
          const coercedVal = coerceValueForColumn(
            column.colDef,
            column.exactName,
            newVal
          );
          values.push(coercedVal);
          const storageType = String(column.colDef.storageType || '').toLowerCase();
          const valueCast =
            storageType === 'jsonb' || storageType === 'json'
              ? `::${storageType === 'json' ? 'json' : 'jsonb'}`
              : '';
          setClauses.push(
            `${quoteIdentifier(column.exactName)} = $${values.length}${valueCast}`
          );
        }

        const bizColExact = schema.columns.business_id?.exactName || 'business_id';
        const bizColSql =
          bizColExact === 'business_id' ? 'business_id' : quoteIdentifier(bizColExact);
        const whereBizSql = schema.columns?.workspace_id
          ? `(${bizColSql} = $1 OR workspace_id = $1)`
          : `${bizColSql} = $1`;

        let rowUpdated = false;
        if (mut._internal_id && schema.columns.id) {
          const idColumn = schema.columns.id;
          const idParams = [...values, mut._internal_id];
          const sqlById = `UPDATE ${safeTable} SET ${setClauses.join(', ')} WHERE ${whereBizSql} AND ${quoteIdentifier(idColumn.exactName)} = $${idParams.length};`;
          const resById = await client.query(sqlById, idParams);
          if (resById && resById.rowCount > 0) {
            updatedRowsCount += resById.rowCount;
            rowUpdated = true;
          }
        }

        if (!rowUpdated && mut._identifier_col && mut.row_identifier !== undefined) {
          const identifierColumn = findColumnDef(schema, mut._identifier_col);
          if (!identifierColumn) {
            throw new AppError('The approved preview references an invalid row identifier.', 409);
          }
          const identParams = [...values, String(mut.row_identifier)];
          const sqlByIdent = `UPDATE ${safeTable} SET ${setClauses.join(', ')} WHERE ${whereBizSql} AND ${quoteIdentifier(identifierColumn.exactName)}::text = $${identParams.length};`;
          const resByIdent = await client.query(sqlByIdent, identParams);
          if (resByIdent && resByIdent.rowCount > 0) {
            updatedRowsCount += resByIdent.rowCount;
            rowUpdated = true;
          }
        }
        if (!rowUpdated) {
          throw new AppError(
            `The approved row "${mut.row_identifier}" no longer exists in this business workspace.`,
            409
          );
        }
      }
    });

    invalidateWorkspaceMetadataCache(workflow.business_id);

    // Write-back sync to Google Sheets if any mutated table is a tracked Google Sheet
    try {
      const { syncMutationsToGoogleSheet } = require('./googleSheetsSyncService');
      const tableMap = new Map();
      for (const m of mutationsPreview) {
        const tbl = m.table_name || m.tableName;
        if (!tableMap.has(tbl)) tableMap.set(tbl, []);
        tableMap.get(tbl).push(m);
      }
      for (const [tbl, muts] of tableMap.entries()) {
        await syncMutationsToGoogleSheet(workflow.business_id, tbl, muts);
      }
    } catch (gSyncErr) {
      console.warn('[ConfirmWorkspaceOperation] Google Sheets write-back error:', gSyncErr.message);
    }
  }

  const dispatchedEmails = [];
  for (const emailItem of emailsPreview) {
    const payload = {
      to: emailItem.recipient_email,
      customer_identifier: emailItem.customer_identifier,
      subject: emailItem.subject,
      text: emailItem.body,
      metadata: emailItem.metadata || {},
      dispatched_at: new Date().toISOString(),
      delivery_mode: dryRun ? 'dry_run' : 'smtp_or_test_transport',
    };

    if (!dryRun) {
      try {
        const info = await sendIndividualEmail({
          to: emailItem.recipient_email,
          subject: emailItem.subject,
          text: emailItem.body,
        });
        payload.message_id = info?.messageId || null;
      } catch {
        payload.delivery_mode = 'recorded_fallback';
      }
    }

    dispatchedEmails.push(payload);
  }

  DISPATCHED_EMAILS_BY_WORKFLOW.set(workflowId, dispatchedEmails);

  workflow.status = 'EXECUTED';
  workflow.updated_rows_count = updatedRowsCount;
  workflow.dispatched_emails_count = dispatchedEmails.length;
  workflow.dispatched_emails = dispatchedEmails;
  await saveWorkflowState(workflow);

  return {
    status: 'EXECUTED',
    workflow_id: workflowId,
    updated_rows_count: updatedRowsCount,
    dispatched_emails_count: dispatchedEmails.length,
    dispatched_emails: dispatchedEmails,
    citations: workflow.citations || [],
  };
}

/**
 * Returns the recorded email dispatches for a given workflow_id.
 *
 * @param {string} workflowId
 * @returns {Array<object>}
 */
function getDispatchedWorkspaceEmails(workflowId) {
  return DISPATCHED_EMAILS_BY_WORKFLOW.get(workflowId) || [];
}

module.exports = {
  analyzeCrossDocumentOperation,
  compileResolutionPreview,
  evaluateSocraticConflicts,
  explicitlyRequestsNotifications,
  resolveSelectedOption,
  buildPreviewFromResolution,
  executeWorkspaceOperation,
  resolveSocraticWorkflow,
  confirmWorkspaceOperation,
  getDispatchedWorkspaceEmails,
  loadWorkflowState,
  clearWorkflowStoreGlobal,
};
