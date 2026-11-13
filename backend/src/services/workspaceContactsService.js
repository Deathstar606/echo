const { parse } = require('csv-parse/sync');
const { query } = require('../../db');
const AppError = require('../utils/AppError');
const { normalizeEmail, isValidEmail } = require('../middleware/validate');

/**
 * Finds workspace name by id.
 */
async function getWorkspaceName(workspaceId) {
  try {
    const res = await query('SELECT name FROM workspaces WHERE id = $1 LIMIT 1;', [workspaceId]);
    if (res.rowCount > 0 && res.rows[0].name) {
      return res.rows[0].name;
    }
  } catch {
    // fallback
  }
  return 'Workspace Customer Base';
}

/**
 * Retrieves all contacts for a given workspace, separated by panel_type.
 */
async function getWorkspaceContacts(workspaceId) {
  const wsName = await getWorkspaceName(workspaceId);

  const res = await query(
    `SELECT id, workspace_id, workspace_name, panel_type, email, customer_name, metadata, created_at, updated_at
     FROM workspace_contacts
     WHERE workspace_id = $1
     ORDER BY updated_at DESC, created_at DESC;`,
    [workspaceId]
  );

  const filtered_contacts = [];
  const workspace_csv_contacts = [];

  for (const row of res.rows) {
    if (row.panel_type === 'filtered') {
      filtered_contacts.push(row);
    } else if (row.panel_type === 'workspace_csv') {
      workspace_csv_contacts.push(row);
    }
  }

  return {
    workspace_id: workspaceId,
    workspace_name: wsName,
    panel_name: wsName,
    filtered_contacts,
    filtered_count: filtered_contacts.length,
    workspace_csv_contacts,
    workspace_csv_count: workspace_csv_contacts.length,
    has_csv_panel: workspace_csv_contacts.length > 0,
  };
}

/**
 * 1-Click addition of a contact into the 'filtered' panel.
 */
async function addFilteredContactOneClick(workspaceId, { email, customer_name = null, metadata = {} }) {
  if (!email || typeof email !== 'string') {
    throw new AppError('A valid email address is required.', 400);
  }

  const normalized = normalizeEmail(email);
  if (!isValidEmail(normalized)) {
    throw new AppError(`Invalid email format: "${email}".`, 400);
  }

  const wsName = await getWorkspaceName(workspaceId);
  const cleanName = customer_name && typeof customer_name === 'string' ? customer_name.trim() : null;
  const safeMeta = typeof metadata === 'object' && metadata !== null ? metadata : {};

  const res = await query(
    `INSERT INTO workspace_contacts (
       workspace_id,
       workspace_name,
       panel_type,
       email,
       customer_name,
       metadata,
       created_at,
       updated_at
     ) VALUES ($1, $2, 'filtered', $3, $4, $5, NOW(), NOW())
     ON CONFLICT (workspace_id, panel_type, email)
     DO UPDATE SET
       customer_name = COALESCE(EXCLUDED.customer_name, workspace_contacts.customer_name),
       metadata = workspace_contacts.metadata || EXCLUDED.metadata,
       updated_at = NOW()
     RETURNING *;`,
    [workspaceId, wsName, normalized, cleanName, JSON.stringify(safeMeta)]
  );

  return res.rows[0];
}

/**
 * Removes a contact from a workspace panel.
 */
async function removeWorkspaceContact(workspaceId, { email, panel_type = 'filtered', id = null }) {
  if (id) {
    const res = await query(
      `DELETE FROM workspace_contacts WHERE id = $1 AND workspace_id = $2 RETURNING *;`,
      [id, workspaceId]
    );
    return res.rows[0] || null;
  }

  if (!email) {
    throw new AppError('Email is required to remove contact.', 400);
  }

  const normalized = normalizeEmail(email);
  const res = await query(
    `DELETE FROM workspace_contacts
     WHERE workspace_id = $1 AND panel_type = $2 AND LOWER(email) = $3
     RETURNING *;`,
    [workspaceId, panel_type, normalized]
  );
  return res.rows[0] || null;
}

/**
 * Imports bulk customer contacts from CSV into the active workspace's 'workspace_csv' panel.
 * Enforces mandatory 'email' column in CSV header.
 * Automatically deduplicates / merges duplicate emails.
 * Never adds contacts to 'filtered'.
 */
async function importWorkspaceCustomerCsv(workspaceId, csvInput) {
  if (!csvInput) {
    const err = new AppError("The uploaded CSV file must contain an 'email' column.", 400);
    err.code = 'INVALID_CSV_SCHEMA';
    throw err;
  }

  let rawRows;
  try {
    rawRows = parse(csvInput, {
      bom: true,
      skip_empty_lines: true,
      columns: true,
      trim: true,
    });
  } catch (parseErr) {
    const err = new AppError(`Malformed CSV format: ${parseErr.message}`, 400);
    err.code = 'INVALID_CSV_SCHEMA';
    throw err;
  }

  if (!Array.isArray(rawRows) || rawRows.length === 0) {
    const err = new AppError("The uploaded CSV file must contain an 'email' column.", 400);
    err.code = 'INVALID_CSV_SCHEMA';
    throw err;
  }

  // Check headers for 'email' column (case-insensitive)
  const sampleRow = rawRows[0];
  const keys = Object.keys(sampleRow);
  const emailKey = keys.find((k) => {
    const cleaned = k.toLowerCase().replace(/[-_\s]/g, '');
    return (
      cleaned === 'email' ||
      cleaned === 'emailid' ||
      cleaned === 'emailaddress' ||
      cleaned === 'mail' ||
      cleaned === 'useremail'
    );
  });

  if (!emailKey) {
    const err = new AppError("The uploaded CSV file must contain an 'email' column.", 400);
    err.code = 'INVALID_CSV_SCHEMA';
    throw err;
  }

  // Detect name column if present
  const nameKey = keys.find((k) => {
    const cleaned = k.toLowerCase().replace(/[-_\s]/g, '');
    return (
      cleaned === 'name' ||
      cleaned === 'customername' ||
      cleaned === 'fullname' ||
      cleaned === 'contactname' ||
      cleaned === 'customer' ||
      cleaned === 'username'
    );
  });

  // Deduplicate within the CSV file in-memory
  const dedupedMap = new Map();
  let duplicatesMerged = 0;

  for (const row of rawRows) {
    const rawEmail = row[emailKey];
    if (!rawEmail || typeof rawEmail !== 'string') continue;
    const normalized = normalizeEmail(rawEmail);
    if (!isValidEmail(normalized)) continue;

    const rawName = nameKey ? String(row[nameKey] || '').trim() : '';

    // Collect non-email/name metadata attributes
    const metadata = {};
    for (const [k, v] of Object.entries(row)) {
      if (k === emailKey) continue;
      if (k === nameKey) continue;
      if (v !== undefined && v !== null && String(v).trim()) {
        metadata[k] = v;
      }
    }

    if (dedupedMap.has(normalized)) {
      duplicatesMerged += 1;
      const existing = dedupedMap.get(normalized);
      if (!existing.customer_name && rawName) {
        existing.customer_name = rawName;
      }
      existing.metadata = { ...existing.metadata, ...metadata };
    } else {
      dedupedMap.set(normalized, {
        email: normalized,
        customer_name: rawName || null,
        metadata,
      });
    }
  }

  if (dedupedMap.size === 0) {
    const err = new AppError("No valid rows with valid email addresses found in the uploaded CSV.", 400);
    err.code = 'INVALID_CSV_SCHEMA';
    throw err;
  }

  const wsName = await getWorkspaceName(workspaceId);

  // Upsert into workspace_contacts under panel_type = 'workspace_csv'
  for (const contact of dedupedMap.values()) {
    await query(
      `INSERT INTO workspace_contacts (
         workspace_id,
         workspace_name,
         panel_type,
         email,
         customer_name,
         metadata,
         created_at,
         updated_at
       ) VALUES ($1, $2, 'workspace_csv', $3, $4, $5, NOW(), NOW())
       ON CONFLICT (workspace_id, panel_type, email)
       DO UPDATE SET
         customer_name = COALESCE(EXCLUDED.customer_name, workspace_contacts.customer_name),
         metadata = workspace_contacts.metadata || EXCLUDED.metadata,
         updated_at = NOW();`,
      [workspaceId, wsName, contact.email, contact.customer_name, JSON.stringify(contact.metadata)]
    );
  }

  // Count total in workspace_csv panel
  const countRes = await query(
    `SELECT COUNT(*)::int AS count
     FROM workspace_contacts
     WHERE workspace_id = $1 AND panel_type = 'workspace_csv';`,
    [workspaceId]
  );
  const totalWorkspaceContacts = countRes.rows[0]?.count || 0;

  return {
    success: true,
    workspace_id: workspaceId,
    workspace_name: wsName,
    panel_name: wsName,
    panel_type: 'workspace_csv',
    imported_count: dedupedMap.size,
    duplicates_merged: duplicatesMerged,
    total_workspace_contacts: totalWorkspaceContacts,
  };
}

module.exports = {
  getWorkspaceName,
  getWorkspaceContacts,
  addFilteredContactOneClick,
  removeWorkspaceContact,
  importWorkspaceCustomerCsv,
};
