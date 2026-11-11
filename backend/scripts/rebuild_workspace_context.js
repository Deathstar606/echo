const fs = require('node:fs');
const path = require('node:path');
const { getPool } = require('../db');
const { quoteIdentifier } = require('../src/services/sheetSchemaService');
const {
  createOrRegisterDynamicTableFromCsv,
  parseAndValidateSheetCsv,
  importSheetRecordsToDatabase,
} = require('../src/services/sheetCsvImportService');
const {
  clearDocumentsForBusiness,
  ingestDocumentFromPath,
} = require('../src/services/documentIngestionService');

const REPOSITORY_ROOT = path.resolve(__dirname, '..', '..');
const MIGRATION_FILE = '012_workspace_context_catalog.sql';
const TARGET_WORKSPACES = [
  {
    id: '11111111-2222-3333-4444-555555555555',
    name: 'Echo Demo Operations Workspace',
    folder: 'Echo Demo Operations Workstation',
    csv: [{ entity: 'orders', filename: 'Commercial Orders Dataset.csv' }],
    pdfs: ['QA_Batch_Recall.pdf', 'Refund_Compliance_SOP.pdf'],
  },
  {
    id: '684a8863-5094-4c8b-9b15-c50c06335b7f',
    name: 'Veloura Apparel',
    folder: 'Veloura Apparel',
    csv: [
      { entity: 'products', filename: 'products.csv' },
      { entity: 'backorders_dataset', filename: 'backorders_dataset.csv' },
    ],
    pdfs: ['Allocation Priority Policy.pdf', 'Port Receiving Manifest.pdf'],
  },
  {
    id: 'd47544a4-6e80-41bb-9ddf-e694c714b4fe',
    name: 'Veloura Wholesale B2B Accounts Workspace',
    folder: 'Veloura Wholesale B2B Accounts Workspace',
    csv: [{ entity: 'wholesale_accunts_dataset', filename: 'wholesale_accunts_dataset.csv' }],
    pdfs: ['Finance Credit Control Policy.pdf', 'Q4 VIP Expansion Brief.pdf'],
  },
  {
    id: '52e50e84-197e-41f0-ba30-4bdeeabafa5e',
    name: 'Hospital Management Demo Workspace',
    folder: 'Hospital Management Workspace',
    csv: [{ entity: 'hospital_units', filename: 'hospital_units.csv' }],
    pdfs: ['Hospital Bed Allocation Policy.pdf'],
  },
];
const REMOVE_WORKSPACE = {
  id: '85e867c3-496b-4758-a4d9-bfba5a140254',
  name: 'Nexus Commercial Logistics',
};
const SYSTEM_TABLES = new Set(['workspaces']);

function getAssetPath(workspace, filename) {
  return path.join(REPOSITORY_ROOT, 'demo-workspaces', workspace.folder, filename);
}

async function loadWorkspaces(pool) {
  const result = await pool.query(
    `SELECT id, name FROM workspaces WHERE id = ANY($1::uuid[]) ORDER BY id;`,
    [
      [
        ...TARGET_WORKSPACES.map((workspace) => workspace.id),
        REMOVE_WORKSPACE.id,
      ],
    ]
  );
  return result.rows || [];
}

function validateWorkspaceIdentities(rows) {
  const byId = new Map(rows.map((workspace) => [workspace.id, workspace.name]));
  for (const workspace of TARGET_WORKSPACES) {
    if (byId.get(workspace.id) !== workspace.name) {
      throw new Error(
        `Workspace identity check failed for ${workspace.id}; expected "${workspace.name}", found "${byId.get(workspace.id) || 'missing'}".`
      );
    }
  }
  if (byId.get(REMOVE_WORKSPACE.id) !== REMOVE_WORKSPACE.name) {
    throw new Error(
      `Removal identity check failed for ${REMOVE_WORKSPACE.id}; expected "${REMOVE_WORKSPACE.name}", found "${byId.get(REMOVE_WORKSPACE.id) || 'missing'}".`
    );
  }
}

function validateAssets() {
  const assets = [];
  for (const workspace of TARGET_WORKSPACES) {
    for (const source of workspace.csv) {
      const filePath = getAssetPath(workspace, source.filename);
      if (!fs.existsSync(filePath)) {
        throw new Error(`Required workspace source is missing: ${filePath}`);
      }
      assets.push({ type: 'csv', workspace_id: workspace.id, ...source, filePath });
    }
    for (const filename of workspace.pdfs) {
      const filePath = getAssetPath(workspace, filename);
      if (!fs.existsSync(filePath)) {
        throw new Error(`Required workspace source is missing: ${filePath}`);
      }
      assets.push({ type: 'pdf', workspace_id: workspace.id, filename, filePath });
    }
  }
  return assets;
}

async function getTenantTables(pool) {
  const result = await pool.query(
    `SELECT table_name, column_name
     FROM information_schema.columns
     WHERE table_schema = 'public'
       AND LOWER(column_name) IN ('business_id', 'workspace_id')
     ORDER BY table_name, column_name;`
  );
  const tables = new Map();
  for (const row of result.rows || []) {
    if (SYSTEM_TABLES.has(String(row.table_name).toLowerCase())) continue;
    const columns = tables.get(row.table_name) || new Set();
    columns.add(String(row.column_name));
    tables.set(row.table_name, columns);
  }
  return tables;
}

function buildTenantPredicate(columns) {
  const names = new Map(
    [...columns].map((column) => [column.toLowerCase(), column])
  );
  const businessColumn = names.get('business_id');
  const workspaceColumn = names.get('workspace_id');
  if (businessColumn && workspaceColumn) {
    return `(${quoteIdentifier(businessColumn)} = $1 OR ${quoteIdentifier(workspaceColumn)} = $1)`;
  }
  return `${quoteIdentifier(businessColumn || workspaceColumn)} = $1`;
}

async function captureTenantCounts(pool, workspaceIds) {
  const tables = await getTenantTables(pool);
  const counts = new Map();
  for (const [tableName, columns] of tables) {
    for (const workspaceId of workspaceIds) {
      const result = await pool.query(
        `SELECT COUNT(*)::bigint AS row_count
         FROM ${quoteIdentifier(tableName)}
         WHERE ${buildTenantPredicate(columns)};`,
        [workspaceId]
      );
      const count = Number(result.rows?.[0]?.row_count || 0);
      if (count > 0) counts.set(`${workspaceId}:${tableName}`, count);
    }
  }
  return counts;
}

function assertNoDependentRemovalRows(counts) {
  const dependentRows = [...counts.entries()].filter(([key]) =>
    key.startsWith(`${REMOVE_WORKSPACE.id}:`)
  );
  if (dependentRows.length > 0) {
    throw new Error(
      `Refusing to delete Nexus because tenant-scoped rows still exist: ${dependentRows.map(([key, count]) => `${key.split(':')[1]}=${count}`).join(', ')}.`
    );
  }
}

function assertPreservedWorkspaceCounts(before, after, protectedWorkspaceIds) {
  const keys = new Set([...before.keys(), ...after.keys()]);
  const differences = [];
  for (const key of keys) {
    if (protectedWorkspaceIds.has(key.split(':')[0])) continue;
    const previous = before.get(key) || 0;
    const current = after.get(key) || 0;
    if (previous !== current) differences.push(`${key}: ${previous} -> ${current}`);
  }
  if (differences.length > 0) {
    throw new Error(
      `Workspace isolation verification failed; unrelated tenant counts changed: ${differences.join(', ')}.`
    );
  }
}

async function applyContextMigration(pool) {
  const exists = await pool.query(
    `SELECT 1 FROM schema_migrations WHERE filename = $1 LIMIT 1;`,
    [MIGRATION_FILE]
  );
  if (exists.rows?.length) return false;

  const migrationPath = path.join(__dirname, '..', 'db', 'migrations', MIGRATION_FILE);
  const migrationSql = fs.readFileSync(migrationPath, 'utf8');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(migrationSql);
    await client.query(
      `INSERT INTO schema_migrations (filename) VALUES ($1)
       ON CONFLICT (filename) DO NOTHING;`,
      [MIGRATION_FILE]
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  return true;
}

async function importWorkspaceCsv(workspace, source) {
  const filePath = getAssetPath(workspace, source.filename);
  const buffer = fs.readFileSync(filePath);
  const schema = await createOrRegisterDynamicTableFromCsv(
    source.entity,
    buffer,
    workspace.id
  );
  const parsed = parseAndValidateSheetCsv(buffer, schema, { mode: 'replace' });
  if (parsed.totalRows === 0 || parsed.validRecords.length === 0) {
    throw new Error(`${source.filename} contains no valid data rows.`);
  }
  if (parsed.rejectedRows.length > 0) {
    throw new Error(
      `${source.filename} has ${parsed.rejectedRows.length} rejected rows; refusing to replace existing data.`
    );
  }
  await importSheetRecordsToDatabase(workspace.id, schema, parsed.validRecords, {
    mode: 'replace',
    sourceFilename: source.filename,
  });
  return {
    workspace_id: workspace.id,
    table_name: schema.tableName,
    source_filename: source.filename,
    imported_rows: parsed.validRecords.length,
  };
}

async function ingestWorkspaceDocuments(workspace) {
  await clearDocumentsForBusiness(workspace.id);
  const results = [];
  for (const filename of workspace.pdfs) {
    const document = await ingestDocumentFromPath(
      workspace.id,
      getAssetPath(workspace, filename)
    );
    if (!document.chunks?.length) {
      throw new Error(`${filename} produced no document chunks.`);
    }
    results.push({
      workspace_id: workspace.id,
      filename,
      page_count: document.page_count,
      chunk_count: document.chunk_count,
    });
  }
  return results;
}

async function deleteConfirmedEmptyWorkspace(pool) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      `DELETE FROM workspaces
       WHERE id = $1 AND name = $2
       RETURNING id;`,
      [REMOVE_WORKSPACE.id, REMOVE_WORKSPACE.name]
    );
    if (result.rowCount !== 1) {
      throw new Error('Nexus workspace deletion did not match exactly one row.');
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function verifyWorkspaceRebuild(pool) {
  const expectedTableCount = TARGET_WORKSPACES.reduce(
    (total, workspace) => total + workspace.csv.length,
    0
  );
  const expectedDocumentCount = TARGET_WORKSPACES.reduce(
    (total, workspace) => total + workspace.pdfs.length,
    0
  );
  const profileResult = await pool.query(
    `SELECT workspace_id, table_name, source_filename, row_count,
            columns_profile, sample_rows
     FROM workspace_table_metadata
     WHERE workspace_id = ANY($1::uuid[])
     ORDER BY workspace_id, table_name;`,
    [TARGET_WORKSPACES.map((workspace) => workspace.id)]
  );
  if (profileResult.rows.length !== expectedTableCount) {
    throw new Error(
      `Expected ${expectedTableCount} workspace table profiles, found ${profileResult.rows.length}.`
    );
  }

  const documentResult = await pool.query(
    `SELECT workspace_id, filename, page_count, chunk_count
     FROM workspace_documents
     WHERE workspace_id = ANY($1::uuid[])
     ORDER BY workspace_id, filename;`,
    [TARGET_WORKSPACES.map((workspace) => workspace.id)]
  );
  if (documentResult.rows.length !== expectedDocumentCount) {
    throw new Error(
      `Expected ${expectedDocumentCount} workspace documents, found ${documentResult.rows.length}.`
    );
  }
  if (documentResult.rows.some((document) => Number(document.chunk_count) < 1)) {
    throw new Error('At least one ingested workspace document has no chunks.');
  }

  const missingBreadcrumbs = await pool.query(
    `SELECT COUNT(*)::int AS count
     FROM workspace_document_chunks
     WHERE workspace_id = ANY($1::uuid[])
       AND (breadcrumb_header IS NULL OR enriched_text IS NULL OR locator IS NULL);`,
    [TARGET_WORKSPACES.map((workspace) => workspace.id)]
  );
  if (Number(missingBreadcrumbs.rows?.[0]?.count || 0) !== 0) {
    throw new Error('Some rebuilt document chunks are missing contextual metadata.');
  }
  return {
    profiles: profileResult.rows,
    documents: documentResult.rows,
  };
}

async function main() {
  const apply = process.argv.includes('--apply');
  const assets = validateAssets();
  const pool = getPool();
  try {
    const workspaces = await loadWorkspaces(pool);
    validateWorkspaceIdentities(workspaces);
    const workspaceIds = workspaces.map((workspace) => workspace.id);
    const baselineCounts = await captureTenantCounts(pool, workspaceIds);
    assertNoDependentRemovalRows(baselineCounts);

    console.log(
      JSON.stringify(
        {
          mode: apply ? 'apply' : 'dry-run',
          target_workspaces: TARGET_WORKSPACES.map(({ id, name, folder }) => ({
            id,
            name,
            source_folder: folder,
          })),
          workspace_to_remove: REMOVE_WORKSPACE,
          sources: assets.map(({ type, workspace_id, entity, filename }) => ({
            type,
            workspace_id,
            entity,
            filename,
          })),
          existing_tenant_row_counts: Object.fromEntries(baselineCounts),
          note: 'The Risedual Documents folder is not included.',
        },
        null,
        2
      )
    );

    if (!apply) return;

    const migrationApplied = await applyContextMigration(pool);
    const importedTables = [];
    const ingestedDocuments = [];
    for (const workspace of TARGET_WORKSPACES) {
      for (const source of workspace.csv) {
        importedTables.push(await importWorkspaceCsv(workspace, source));
      }
      ingestedDocuments.push(...(await ingestWorkspaceDocuments(workspace)));
    }

    const verified = await verifyWorkspaceRebuild(pool);
    const refreshedCounts = await captureTenantCounts(
      pool,
      workspaceIds.filter((id) => id !== REMOVE_WORKSPACE.id)
    );
    assertPreservedWorkspaceCounts(
      baselineCounts,
      refreshedCounts,
      new Set(TARGET_WORKSPACES.map((workspace) => workspace.id))
    );

    await deleteConfirmedEmptyWorkspace(pool);
    console.log(
      JSON.stringify(
        {
          status: 'complete',
          migration_applied: migrationApplied,
          imported_tables: importedTables,
          ingested_documents: ingestedDocuments,
          verification: verified,
          removed_workspace: REMOVE_WORKSPACE,
          unrelated_workspace_counts_preserved: true,
        },
        null,
        2
      )
    );
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(`[WorkspaceRebuild] ${error.message}`);
  process.exitCode = 1;
});
