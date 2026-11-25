const { query } = require('../../../db');

const WORKFLOW_STORE = new Map();
const DISPATCHED_EMAILS_BY_WORKFLOW = new Map();

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
  const serialized = JSON.stringify(workflow);
  void (async () => {
    try {
      await ensureWorkflowTableExists();
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
          serialized,
        ]
      );
    } catch {
      // In-memory store remains authoritative
    }
  })();
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

module.exports = {
  WORKFLOW_STORE,
  DISPATCHED_EMAILS_BY_WORKFLOW,
  ensureWorkflowTableExists,
  saveWorkflowState,
  loadWorkflowState,
  clearWorkflowStoreGlobal,
};
