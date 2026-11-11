const crypto = require('node:crypto');
const { google } = require('googleapis');
const { getAuthenticatedClient } = require('./googleAuthService');
const { query } = require('../../db');
const { quoteIdentifier } = require('./sheetSchemaService');
const {
  createOrRegisterDynamicTableFromCsv,
  parseAndValidateSheetCsv,
  importSheetRecordsToDatabase,
} = require('./sheetCsvImportService');
const AppError = require('../utils/AppError');

const SYSTEM_COLUMNS_TO_SKIP = new Set([
  'id',
  'business_id',
  'workspace_id',
  'user_id',
  'workspace_document_id',
  '_google_row_index',
  'created_at',
  'updated_at',
]);

function normalizeSyncColKey(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function formatA1SheetTab(tabName) {
  const safe = String(tabName || 'Sheet1').replace(/'/g, "''");
  return `'${safe}'`;
}

function findColumnLetter(colMap, colName) {
  if (!colMap || !colName) return null;
  if (colMap[colName]) return colMap[colName];
  const lowerKey = String(colName).toLowerCase();
  const exactCi = Object.keys(colMap).find((k) => k.toLowerCase() === lowerKey);
  if (exactCi) return colMap[exactCi];
  const normKey = normalizeSyncColKey(colName);
  if (!normKey) return null;
  const normMatch = Object.keys(colMap).find((k) => normalizeSyncColKey(k) === normKey);
  return normMatch ? colMap[normMatch] : null;
}

function findRowValue(rowObj, colName) {
  if (!rowObj || !colName) return '';
  if (rowObj[colName] !== undefined) return rowObj[colName];
  const lowerKey = String(colName).toLowerCase();
  const ciKey = Object.keys(rowObj).find((k) => k.toLowerCase() === lowerKey);
  if (ciKey) return rowObj[ciKey];
  const normKey = normalizeSyncColKey(colName);
  const normObjKey = Object.keys(rowObj).find((k) => normalizeSyncColKey(k) === normKey);
  return normObjKey ? rowObj[normObjKey] : '';
}

function mapGoogleSheetsError(err, spreadsheetId) {
  if (err instanceof AppError || err?.isOperational) {
    return err;
  }
  const gData = err?.response?.data;
  const gError = gData?.error;
  const rawMsg =
    (typeof gError === 'string' && gData?.error_description) ||
    (typeof gError === 'string' && gError) ||
    gError?.message ||
    err?.message ||
    'Failed to access Google Spreadsheet.';
  const rawStatus = Number(err?.status ?? err?.response?.status ?? gError?.code ?? err?.code);

  if (/invalid_grant/i.test(rawMsg) || rawStatus === 401) {
    return new AppError(
      'Google authentication has expired or was revoked. Please sign in with Google again.',
      401
    );
  }
  if (rawStatus === 403 || /permission|insufficient|accessNotConfigured/i.test(rawMsg)) {
    return new AppError(
      `Google Sheets permission denied for "${spreadsheetId}": ${rawMsg}`,
      403
    );
  }
  if (rawStatus === 404 || /not found/i.test(rawMsg)) {
    return new AppError(
      `Google Spreadsheet "${spreadsheetId}" was not found or your connected Google account does not have access to it.`,
      404
    );
  }
  if (/not supported for this document|failed_precondition/i.test(rawMsg) || rawStatus === 400) {
    return new AppError(
      `Unable to read Google Spreadsheet "${spreadsheetId}": ${rawMsg}. Ensure the link points to a native Google Sheet (not a Google Doc or CSV binary).`,
      400
    );
  }
  return new AppError(
    rawMsg,
    Number.isInteger(rawStatus) && rawStatus >= 400 && rawStatus <= 599 ? rawStatus : 502
  );
}

const MAX_GOOGLE_SHEETS_PER_BUSINESS = 5;
const MAX_SHEET_BYTES = 2 * 1024 * 1024; // 2 MB
const MAX_SHEET_ROWS = 2000;
const MAX_SHEET_COLS = 40;

/**
 * Converts a 0-based column index to spreadsheet letter notation (e.g. 0 -> 'A', 25 -> 'Z', 26 -> 'AA').
 * @param {number} colIndex
 * @returns {string}
 */
function columnIndexToLetter(colIndex) {
  let temp = colIndex;
  let letter = '';
  while (temp >= 0) {
    letter = String.fromCharCode((temp % 26) + 65) + letter;
    temp = Math.floor(temp / 26) - 1;
  }
  return letter;
}

/**
 * Formats a 2D array of rows into a standards-compliant CSV string.
 * @param {Array<Array<any>>} rows
 * @returns {string}
 */
function format2dArrayToCsv(rows) {
  return rows
    .map((row) =>
      row
        .map((cell) => {
          if (cell === null || cell === undefined) return '';
          let str = String(cell);
          if (typeof cell === 'object') {
            try {
              str = JSON.stringify(cell);
            } catch {
              str = String(cell);
            }
          }
          if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
            return `"${str.replace(/"/g, '""')}"`;
          }
          return str;
        })
        .join(',')
    )
    .join('\n');
}

/**
 * Lists spreadsheets accessible in Google Drive.
 *
 * @param {string} [businessId]
 * @returns {Promise<Array<object>>}
 */
async function listGoogleSpreadsheets(businessId) {
  try {
    const auth = await getAuthenticatedClient(businessId);
    const drive = google.drive({ version: 'v3', auth });

    const res = await drive.files.list({
      q: "mimeType='application/vnd.google-apps.spreadsheet' and trashed=false",
      fields: 'files(id, name, size, modifiedTime, webViewLink)',
      pageSize: 30,
    });

    return res.data.files || [];
  } catch (err) {
    console.warn('[GoogleSheets] Could not list Drive spreadsheets (Drive API scope or service not enabled):', err.message);
    return [];
  }
}

function extractGoogleSpreadsheetId(input) {
  if (!input || typeof input !== 'string') return '';
  const trimmed = input.trim();
  const match = trimmed.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  if (match) return match[1];
  return trimmed;
}

/**
 * Imports a Google Sheet directly into PostgreSQL, registering a dynamic relational table
 * and establishing A1 row-index sync metadata.
 *
 * @param {string} businessId
 * @param {object} options
 * @param {string} options.spreadsheetId
 * @param {string} [options.sheetTabName]
 * @param {string} [options.customEntityName]
 * @returns {Promise<object>}
 */
async function importGoogleSheetToPostgres(businessId, options = {}) {
  const spreadsheetId = extractGoogleSpreadsheetId(options.spreadsheetId);
  const { sheetTabName, customEntityName } = options;

  if (!businessId) {
    throw new AppError('businessId is required to import a Google Sheet.', 400);
  }
  if (!spreadsheetId) {
    throw new AppError('A valid Google Spreadsheet ID or URL is required.', 400);
  }

  // 1. Enforce 5-Sheet Cap
  const countRes = await query(
    'SELECT COUNT(*)::int AS cnt FROM google_sheet_sync_metadata WHERE business_id = $1 OR workspace_id = $1;',
    [businessId]
  );
  const activeCount = Number(countRes.rows?.[0]?.cnt || 0);

  // Check if we are updating an already registered spreadsheet for this business
  const existingSheet = await query(
    'SELECT table_name FROM google_sheet_sync_metadata WHERE (business_id = $1 OR workspace_id = $1) AND google_spreadsheet_id = $2;',
    [businessId, spreadsheetId]
  );

  if (activeCount >= MAX_GOOGLE_SHEETS_PER_BUSINESS && existingSheet.rows.length === 0) {
    throw new AppError(
      'Maximum limit of 5 Google Sheets reached. Please remove an existing sheet before importing a new one.',
      400
    );
  }

  const auth = await getAuthenticatedClient(businessId);
  const sheets = google.sheets({ version: 'v4', auth });

  // 2. Fetch Spreadsheet Metadata & Tabs
  let metaRes;
  try {
    metaRes = await sheets.spreadsheets.get({ spreadsheetId });
  } catch (err) {
    throw mapGoogleSheetsError(err, spreadsheetId);
  }
  const sheetList = metaRes.data.sheets || [];
  if (sheetList.length === 0) {
    throw new AppError('The requested Google Spreadsheet has no sheets/tabs.', 400);
  }

  const targetSheet = sheetTabName
    ? sheetList.find((s) => s.properties?.title === sheetTabName) || sheetList[0]
    : sheetList[0];

  const resolvedTabName = targetSheet.properties?.title || 'Sheet1';
  const gridProps = targetSheet.properties?.gridProperties || {};

  // Check grid dimensions before fetching if metadata declares them
  if (gridProps.rowCount && gridProps.rowCount > MAX_SHEET_ROWS) {
    throw new AppError(
      `Sheet exceeds row limit: ${gridProps.rowCount} rows declared (max ${MAX_SHEET_ROWS}).`,
      400
    );
  }
  if (gridProps.columnCount && gridProps.columnCount > MAX_SHEET_COLS) {
    throw new AppError(
      `Sheet exceeds column limit: ${gridProps.columnCount} columns declared (max ${MAX_SHEET_COLS}).`,
      400
    );
  }

  // 3. Fetch 2D Values
  let valuesRes;
  try {
    valuesRes = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: formatA1SheetTab(resolvedTabName),
    });
  } catch (err) {
    throw mapGoogleSheetsError(err, spreadsheetId);
  }

  const rawRows = valuesRes.data.values || [];
  if (rawRows.length === 0) {
    throw new AppError(`The selected sheet tab "${resolvedTabName}" contains no data rows.`, 400);
  }

  if (rawRows.length > MAX_SHEET_ROWS) {
    throw new AppError(
      `Sheet exceeds row limit: ${rawRows.length} rows (max ${MAX_SHEET_ROWS}).`,
      400
    );
  }

  const headerRow = rawRows[0] || [];
  if (headerRow.length > MAX_SHEET_COLS) {
    throw new AppError(
      `Sheet exceeds column limit: ${headerRow.length} columns (max ${MAX_SHEET_COLS}).`,
      400
    );
  }

  // Map header columns to spreadsheet letters (0 -> 'A', 1 -> 'B'...)
  const columnLetterMap = {};
  headerRow.forEach((h, idx) => {
    const colName = String(h || '').trim();
    if (colName) {
      columnLetterMap[colName] = columnIndexToLetter(idx);
    }
  });

  // 4. Convert 2D Values to CSV Buffer
  const csvText = format2dArrayToCsv(rawRows);
  const csvBuffer = Buffer.from(csvText, 'utf8');

  if (csvBuffer.length > MAX_SHEET_BYTES) {
    throw new AppError(
      `Sheet size exceeds 2 MB limit: ${(csvBuffer.length / (1024 * 1024)).toFixed(2)} MB.`,
      400
    );
  }

  // 5. Determine Entity Name & Register Dynamic PostgreSQL Table
  const rawSpreadsheetTitle = metaRes.data.properties?.title || 'google_sheet';
  const defaultEntity = customEntityName
    ? customEntityName
    : rawSpreadsheetTitle
        .toLowerCase()
        .replace(/[^a-z0-9_]/g, '_')
        .replace(/^_+|_+$/g, '');

  const entityName = defaultEntity || 'google_sheet_data';

  // Build relational schema and table in PostgreSQL
  const schema = await createOrRegisterDynamicTableFromCsv(entityName, csvBuffer, businessId);

  // Parse and validate rows
  const { validRecords } = parseAndValidateSheetCsv(csvBuffer, schema, { mode: 'replace' });

  // Attach exact 1-based cloud row index (Row 1 is headers; valid data records start at Row 2)
  validRecords.forEach((record, index) => {
    record._google_row_index = index + 2;
  });

  // Ensure _google_row_index column exists on the physical PostgreSQL table
  try {
    await query(
      `ALTER TABLE "${schema.tableName}" ADD COLUMN IF NOT EXISTS "_google_row_index" INT;`
    );
  } catch (alterErr) {
    // Column might already exist
  }

  // Import records to PostgreSQL
  const importedCount = await importSheetRecordsToDatabase(businessId, schema, validRecords, {
    mode: 'replace',
    sourceFilename: `${rawSpreadsheetTitle}.csv`,
  });

  // Register in workspace_documents
  const sheetDocId = crypto.randomUUID();
  let persistedDocId = null;
  try {
    const wsOwner = await query('SELECT user_id FROM workspaces WHERE id = $1;', [businessId]);
    if (wsOwner.rowCount > 0) {
      const userId = wsOwner.rows[0].user_id || null;
      await query(
        `INSERT INTO workspace_documents (doc_id, workspace_id, user_id, filename, mime_type, page_count, chunk_count, full_text)
         VALUES ($1, $2, $3, $4, 'application/vnd.google-apps.spreadsheet', 1, $5, $6)
         ON CONFLICT (doc_id) DO NOTHING;`,
        [sheetDocId, businessId, userId, rawSpreadsheetTitle, importedCount, `Google Sheet for table ${schema.tableName}`]
      );
      persistedDocId = sheetDocId;
    }
  } catch (docErr) {
    console.warn('[GoogleSheetsSync] Could not register workspace_documents row:', docErr.message);
  }

  // 6. Persist Google Sync Metadata in PostgreSQL
  await query(
    `INSERT INTO google_sheet_sync_metadata (
      business_id, workspace_id, workspace_document_id, table_name, google_spreadsheet_id, google_sheet_tab_name, column_letter_map, row_count, last_synced_at
    ) VALUES ($1, $1, $2, $3, $4, $5, $6, $7, NOW())
    ON CONFLICT (business_id, table_name) DO UPDATE SET
      workspace_id = EXCLUDED.workspace_id,
      workspace_document_id = EXCLUDED.workspace_document_id,
      google_spreadsheet_id = EXCLUDED.google_spreadsheet_id,
      google_sheet_tab_name = EXCLUDED.google_sheet_tab_name,
      column_letter_map = EXCLUDED.column_letter_map,
      row_count = EXCLUDED.row_count,
      last_synced_at = NOW();`,
    [
      businessId,
      persistedDocId,
      schema.tableName,
      spreadsheetId,
      resolvedTabName,
      JSON.stringify(columnLetterMap),
      importedCount,
    ]
  );

  return {
    success: true,
    workspace_document_id: persistedDocId || sheetDocId,
    doc_id: persistedDocId || sheetDocId,
    entity: schema.entity,
    tableName: schema.tableName,
    displayName: schema.displayName,
    spreadsheetId,
    sheetTabName: resolvedTabName,
    rowCount: importedCount,
    columnCount: Object.keys(columnLetterMap).length,
  };
}

/**
 * Automatically synchronizes modified rows back to Google Sheets using A1 notation batch updates.
 * Safe no-op if the mutated table is not a synced Google Sheet.
 *
 * @param {string} businessId
 * @param {string} tableName
 * @param {Array<object>} mutations - List of row mutations or updated row objects
 */
async function syncMutationsToGoogleSheet(businessId, tableName, mutations = []) {
  if (!businessId || !tableName || !Array.isArray(mutations) || mutations.length === 0) {
    return;
  }

  // Check if table is tracked as a Google Sheet
  const metaRes = await query(
    `SELECT google_spreadsheet_id, google_sheet_tab_name, column_letter_map
     FROM google_sheet_sync_metadata
     WHERE (business_id = $1 OR workspace_id = $1) AND LOWER(table_name) = LOWER($2)
     LIMIT 1;`,
    [businessId, tableName]
  );

  if (!metaRes.rows || metaRes.rows.length === 0) {
    return; // Not a synced Google Sheet, skip cleanly
  }

  const {
    google_spreadsheet_id: spreadsheetId,
    google_sheet_tab_name: sheetTabName,
    column_letter_map: columnLetterMap,
  } = metaRes.rows[0];

  const colMap = typeof columnLetterMap === 'string'
    ? JSON.parse(columnLetterMap)
    : (columnLetterMap || {});
  const a1Tab = formatA1SheetTab(sheetTabName);
  const safeTableName = quoteIdentifier(tableName);

  try {
    const auth = await getAuthenticatedClient(businessId);
    const sheets = google.sheets({ version: 'v4', auth });

    const valueRanges = [];
    const rowsToAppend = [];

    for (const item of mutations) {
      const isCreateOp = item.operation === 'create';
      let rowIndex = item._google_row_index ?? item.after?._google_row_index ?? null;
      const lookupId = item._internal_id || (!isCreateOp ? item.id : null);
      const lookupCol = item._identifier_col || null;
      const lookupIdent = item.row_identifier ?? null;

      if (!rowIndex && !isCreateOp && (lookupId || (lookupCol && lookupIdent !== null))) {
        try {
          if (lookupId) {
            const idxRes = await query(
              `SELECT "_google_row_index" FROM ${safeTableName} WHERE id = $1 LIMIT 1;`,
              [lookupId]
            );
            rowIndex = idxRes.rows?.[0]?._google_row_index ?? null;
          } else if (lookupCol && lookupIdent !== null) {
            const idxRes = await query(
              `SELECT "_google_row_index" FROM ${safeTableName} WHERE (business_id = $1 OR workspace_id = $1) AND ${quoteIdentifier(lookupCol)}::text = $2 LIMIT 1;`,
              [businessId, String(lookupIdent)]
            );
            rowIndex = idxRes.rows?.[0]?._google_row_index ?? null;
          }
        } catch {
          // Ignore if _google_row_index lookup fails
        }
      }

      const afterValues = item.after || item.changes || item;

      if (rowIndex && Number(rowIndex) >= 2) {
        const numericRowIndex = Number(rowIndex);
        // Row exists in Google Sheet, update changed cells
        for (const [colName, newVal] of Object.entries(afterValues)) {
          if (SYSTEM_COLUMNS_TO_SKIP.has(colName.toLowerCase())) continue;

          const letter = findColumnLetter(colMap, colName);
          if (letter) {
            let serializedVal = newVal;
            if (newVal === null || newVal === undefined) {
              serializedVal = '';
            } else if (typeof newVal === 'object') {
              try {
                serializedVal = JSON.stringify(newVal);
              } catch {
                serializedVal = String(newVal);
              }
            } else {
              serializedVal = String(newVal);
            }

            valueRanges.push({
              range: `${a1Tab}!${letter}${numericRowIndex}`,
              values: [[serializedVal]],
            });
          }
        }
      } else if (isCreateOp || (!item._internal_id && !item._identifier_col && !item.after && !item.changes)) {
        // New row creation (append to end of sheet)
        const orderedRow = [];
        const sortedEntries = Object.entries(colMap).sort((a, b) => a[1].localeCompare(b[1]));
        for (const [colName] of sortedEntries) {
          const val = findRowValue(afterValues, colName);
          if (val === null || val === undefined) {
            orderedRow.push('');
          } else {
            orderedRow.push(typeof val === 'object' ? JSON.stringify(val) : String(val));
          }
        }
        if (orderedRow.length > 0) {
          rowsToAppend.push({ values: orderedRow, internalId: item._internal_id || item.id || null });
        }
      }
    }

    // Execute batch update for existing rows
    if (valueRanges.length > 0) {
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId,
        requestBody: {
          valueInputOption: 'USER_ENTERED',
          data: valueRanges,
        },
      });
    }

    // Execute append for newly inserted rows
    if (rowsToAppend.length > 0) {
      const appendRes = await sheets.spreadsheets.values.append({
        spreadsheetId,
        range: a1Tab,
        valueInputOption: 'USER_ENTERED',
        requestBody: {
          values: rowsToAppend.map((r) => r.values),
        },
      });
      const updatedRange = appendRes.data?.updates?.updatedRange || '';
      const rangeMatch = updatedRange.match(/![A-Z]+(\d+)(?::[A-Z]+(\d+))?/i);
      if (rangeMatch) {
        const startRow = Number.parseInt(rangeMatch[1], 10);
        if (Number.isFinite(startRow)) {
          for (let i = 0; i < rowsToAppend.length; i += 1) {
            const targetId = rowsToAppend[i].internalId;
            if (targetId) {
              try {
                await query(
                  `UPDATE ${safeTableName} SET "_google_row_index" = $1 WHERE id = $2;`,
                  [startRow + i, targetId]
                );
              } catch {
                // Ignore if _google_row_index write-back fails
              }
            }
          }
        }
      }
    }

    // Update sync timestamp
    await query(
      `UPDATE google_sheet_sync_metadata SET last_synced_at = NOW() WHERE (business_id = $1 OR workspace_id = $1) AND LOWER(table_name) = LOWER($2);`,
      [businessId, tableName]
    );
  } catch (syncErr) {
    console.warn(`[GoogleSheetsSync] Write-back sync failed for table "${tableName}":`, syncErr.message);
  }
}

/**
 * Returns synchronization status and metadata for all Google Sheets in a workspace.
 * @param {string} businessId
 * @returns {Promise<Array<object>>}
 */
async function getSyncedSheetsMetadata(businessId) {
  if (!businessId) return [];
  const res = await query(
    `SELECT table_name, google_spreadsheet_id, google_sheet_tab_name, row_count, last_synced_at
     FROM google_sheet_sync_metadata
     WHERE business_id = $1 OR workspace_id = $1
     ORDER BY last_synced_at DESC;`,
    [businessId]
  );
  return res.rows || [];
}

module.exports = {
  listGoogleSpreadsheets,
  importGoogleSheetToPostgres,
  syncMutationsToGoogleSheet,
  getSyncedSheetsMetadata,
  MAX_GOOGLE_SHEETS_PER_BUSINESS,
};
