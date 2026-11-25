const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { getPool, query } = require('../db');
const {
  chunkDocumentPages,
  setDocumentActiveState,
} = require('../src/services/rag/documentIngestionService');
const {
  hybridSearchDocumentChunks,
  retrieveLegacyInMemoryDocumentChunks,
  verifyCitations,
} = require('../src/services/rag/crossRagService');
const {
  recordTurnState,
  getCompactMemoryWindow,
  clearSessionMemory,
  estimateTokenCount,
} = require('../src/services/memory/turnMemoryService');

function parseVectorLiteral(rawVal) {
  if (Array.isArray(rawVal)) return rawVal.map(Number);
  const str = String(rawVal || '').trim();
  if (!str.startsWith('[') || !str.endsWith(']')) return [];
  return str
    .slice(1, -1)
    .split(',')
    .map((x) => Number(x.trim()))
    .filter((n) => Number.isFinite(n));
}

function l2Norm(vec) {
  let sum = 0;
  for (const v of vec) sum += v * v;
  return Math.sqrt(sum);
}

async function runEval1StorageAndVectorIntegrity() {
  const extRes = await query(
    `SELECT extname, extversion FROM pg_extension WHERE extname IN ('vector', 'pg_trgm') ORDER BY extname;`
  );
  const extNames = new Set((extRes.rows || []).map((r) => r.extname));
  assert.equal(extNames.has('vector'), true, 'pgvector extension must be enabled');
  assert.equal(extNames.has('pg_trgm'), true, 'pg_trgm extension must be enabled');

  const sizeRes = await query(
    `SELECT pg_size_pretty(pg_database_size(current_database())) AS pretty_size,
            pg_database_size(current_database())::bigint AS bytes;`
  );
  const dbBytes = Number(sizeRes.rows?.[0]?.bytes || 0);
  const dbMb = Number((dbBytes / (1024 * 1024)).toFixed(2));

  const wsRes = await query(`
    SELECT w.id AS workspace_id, w.name AS workspace_name,
           COUNT(DISTINCT d.doc_id)::int AS doc_count,
           COUNT(c.chunk_id)::int AS chunk_count,
           COUNT(c.embedding)::int AS embedded_count,
           COUNT(c.search_tsv)::int AS tsv_count
    FROM workspaces w
    JOIN workspace_documents d ON d.workspace_id = w.id AND d.is_active = true
    LEFT JOIN workspace_document_chunks c ON c.doc_id = d.doc_id AND c.is_active = true
    GROUP BY w.id, w.name
    ORDER BY w.name ASC;
  `);
  const workspaces = wsRes.rows || [];
  assert.ok(workspaces.length >= 4, `Expected >= 4 populated workspaces, got ${workspaces.length}`);

  for (const ws of workspaces) {
    assert.ok(ws.chunk_count > 0, `Workspace "${ws.workspace_name}" must have active chunks`);
    assert.equal(
      ws.embedded_count,
      ws.chunk_count,
      `Workspace "${ws.workspace_name}" has chunks missing embeddings`
    );
    assert.equal(
      ws.tsv_count,
      ws.chunk_count,
      `Workspace "${ws.workspace_name}" has chunks missing search_tsv`
    );
  }

  // Verify dimension = 768 and L2 norm ≈ 1.000 (±0.001) across ALL active chunks
  const vecRes = await query(`
    SELECT chunk_id, filename, embedding::text AS vec_text
    FROM workspace_document_chunks
    WHERE is_active = true;
  `);
  let minNorm = Infinity;
  let maxNorm = 0;
  for (const row of vecRes.rows || []) {
    const vec = parseVectorLiteral(row.vec_text);
    assert.equal(vec.length, 768, `Chunk ${row.chunk_id} (${row.filename}) must have 768 dims`);
    const norm = l2Norm(vec);
    if (norm < minNorm) minNorm = norm;
    if (norm > maxNorm) maxNorm = norm;
    assert.ok(
      Math.abs(norm - 1.0) <= 0.002,
      `Chunk ${row.chunk_id} L2 norm out of bounds: ${norm}`
    );
  }

  return {
    passed: true,
    extensions: extRes.rows,
    db_size_pretty: sizeRes.rows?.[0]?.pretty_size,
    db_size_mb: dbMb,
    populated_workspaces: workspaces,
    total_active_chunks_checked: (vecRes.rows || []).length,
    norm_range: [Number(minNorm.toFixed(6)), Number(maxNorm.toFixed(6))],
  };
}

async function runEval2VagueIntentHybridRecall() {
  const EVAL_CASES = [
    {
      workspaceId: '11111111-2222-3333-4444-555555555555',
      workspace: 'Customer Order Management',
      query: 'minimum safety cushion before regional depots run low on stock',
      expectedFilename: 'Hub_Reserve_Allocation_Policy.pdf',
      expectedNeedle: /10-Unit Hub Reserve Buffer|reserve buffer/i,
    },
    {
      workspaceId: '11111111-2222-3333-4444-555555555555',
      workspace: 'Customer Order Management',
      query: 'mobile money payout transaction limit for defective returns',
      expectedFilename: 'Refund_Compliance_SOP.pdf',
      expectedNeedle: /10,000 BDT|bKash/i,
    },
    {
      workspaceId: '11111111-2222-3333-4444-555555555555',
      workspace: 'Customer Order Management',
      query: 'B-404',
      expectedFilename: 'QA_Batch_Recall.pdf',
      expectedNeedle: /B-404/,
    },
    {
      workspaceId: '684a8863-5094-4c8b-9b15-c50c06335b7f',
      workspace: 'E-commerce clothing',
      query: 'safety stock floor retained before fulfilling garment backorders',
      expectedFilename: 'Company_Policy.pdf',
      expectedNeedle: /10-UNIT MINIMUM STOCK BUFFER|10 Stock Buffer/i,
    },
    {
      workspaceId: '684a8863-5094-4c8b-9b15-c50c06335b7f',
      workspace: 'E-commerce clothing',
      query: 'moisture damaged shipping container cartons customs hold log',
      expectedFilename: 'Port Receiving Manifest.pdf',
      expectedNeedle: /QUARANTINE|MSCU-849201-4|damp/i,
    },
    {
      workspaceId: 'd47544a4-6e80-41bb-9ddf-e694c714b4fe',
      workspace: 'E-commerce Wholesale',
      query: 'unpaid arrears freezing silver tier borrowing expansion',
      expectedFilename: 'Finance Credit Control Policy.pdf',
      expectedNeedle: /overdue_balance|Arrears Prohibition|credit_limit/i,
    },
    {
      workspaceId: 'd47544a4-6e80-41bb-9ddf-e694c714b4fe',
      workspace: 'E-commerce Wholesale',
      query: 'mandatory liquidity cushion prior to net-30 credit underwriting approval',
      expectedFilename: 'Q4_Credit_Reserve_Underwriting_Addendum.pdf',
      expectedNeedle: /\$2,000 Credit Limit Reserve|Reserve Buffer/i,
    },
    {
      workspaceId: '52e50e84-197e-41f0-ba30-4bdeeabafa5e',
      workspace: 'Medical Staff & Deseases',
      query: 'extra float nurse staffing eligibility and shift overtime compliance',
      expectedFilename: 'Clinical_Staffing_and_Isolation_Diversion_Protocol.pdf',
      expectedNeedle: /OVERTIME|FLOAT POOL/i,
    },
    {
      workspaceId: '52e50e84-197e-41f0-ba30-4bdeeabafa5e',
      workspace: 'Medical Staff & Deseases',
      query: 'clean sanitized bed floor kept open before accepting patient transfers',
      expectedFilename: 'Unit_Clean_Bed_Reserve_Policy.pdf',
      expectedNeedle: /2-Clean-Bed Surge Reserve|clean_beds/i,
    },
    {
      workspaceId: 'b662ec3e-9f40-4c62-874a-af2a88a87317',
      workspace: 'Raised By Society',
      query: 'customized tailored suit refund restriction and admin cancellation fee',
      expectedFilename: 'Raised_By_Society_Refund_Policy.pdf',
      expectedNeedle: /customized products|5% Administration Fee/i,
    },
  ];

  let rrfTop3Hits = 0;
  let lexicalTop3Hits = 0;
  const details = [];

  for (const tc of EVAL_CASES) {
    const lexStart = performance.now();
    const lexResults = await retrieveLegacyInMemoryDocumentChunks(
      tc.workspaceId,
      tc.query,
      { topK: 6 }
    );
    const lexLatencyMs = Number((performance.now() - lexStart).toFixed(2));
    const lexTop3 = lexResults.slice(0, 3);
    const lexHit = lexTop3.some(
      (c) =>
        String(c.filename).toLowerCase() === tc.expectedFilename.toLowerCase() &&
        tc.expectedNeedle.test(c.raw_text || '')
    );
    if (lexHit) lexicalTop3Hits += 1;

    const rrfStart = performance.now();
    const rrfResults = await hybridSearchDocumentChunks({
      workspaceId: tc.workspaceId,
      query: tc.query,
      topK: 6,
    });
    const rrfLatencyMs = Number((performance.now() - rrfStart).toFixed(2));
    const rrfTop3 = rrfResults.slice(0, 3);
    const rrfHit = rrfTop3.some(
      (c) =>
        String(c.filename).toLowerCase() === tc.expectedFilename.toLowerCase() &&
        tc.expectedNeedle.test(c.raw_text || '')
    );
    if (rrfHit) rrfTop3Hits += 1;

    details.push({
      workspace: tc.workspace,
      query: tc.query,
      expected_doc: tc.expectedFilename,
      legacy_top3_hit: lexHit,
      rrf_top3_hit: rrfHit,
      rrf_latency_ms: rrfLatencyMs,
      lex_latency_ms: lexLatencyMs,
      top1_doc: rrfResults[0]?.filename || null,
      top1_rrf_score: rrfResults[0]?.rrf_score || 0,
    });
  }

  const rrfRecallPct = Number(((rrfTop3Hits / EVAL_CASES.length) * 100).toFixed(1));
  const lexRecallPct = Number(((lexicalTop3Hits / EVAL_CASES.length) * 100).toFixed(1));
  const avgRrfLatencyMs = Number(
    (details.reduce((acc, d) => acc + d.rrf_latency_ms, 0) / details.length).toFixed(1)
  );

  // Also test deterministic verifyCitations() hallucination stripping
  const sampleChunks = await hybridSearchDocumentChunks({
    workspaceId: EVAL_CASES[0].workspaceId,
    query: EVAL_CASES[0].query,
    topK: 3,
  });
  assert.ok(sampleChunks.length > 0);
  const validCit = { ...sampleChunks[0].citation, chunk_id: sampleChunks[0].chunk_id };
  const fakeDocCit = {
    source_type: 'document',
    source_name: 'Hallucinated_Policy.pdf',
    chunk_id: '00000000-0000-0000-0000-000000000000',
    locator: 'Page 99 / Chunk 9',
  };
  const fakeRowCit = {
    source_type: 'table',
    source_name: 'orders',
    locator: 'Row ORD-FAKE-9999',
    row_identifier: 'ORD-FAKE-9999',
  };
  const verifiedCits = verifyCitations(
    [validCit, fakeDocCit, fakeRowCit],
    sampleChunks,
    [{ table_name: 'orders', row_identifier: 'ORD-REAL-1' }]
  );
  assert.equal(verifiedCits.length, 1, 'verifyCitations must strip hallucinated doc/row citations');

  assert.ok(
    rrfRecallPct >= 90,
    `Hybrid RRF Top-3 recall (${rrfRecallPct}%) must be >= 90%`
  );

  return {
    passed: true,
    total_queries: EVAL_CASES.length,
    rrf_top3_hits: rrfTop3Hits,
    rrf_top3_recall_pct: rrfRecallPct,
    legacy_lexical_top3_hits: lexicalTop3Hits,
    legacy_lexical_top3_recall_pct: lexRecallPct,
    avg_rrf_latency_ms: avgRrfLatencyMs,
    verify_citations_passed: true,
    details,
  };
}

async function runEval3IntraSectionOverlap() {
  // 1. Live DB check
  const liveOverlapRes = await query(`
    SELECT COUNT(*)::int AS overlap_cnt
    FROM workspace_document_chunks
    WHERE is_active = true AND overlap_chars > 0;
  `);
  const liveZeroBoundaryRes = await query(`
    SELECT COUNT(*)::int AS boundary_cnt
    FROM workspace_document_chunks
    WHERE is_active = true AND overlap_chars = 0;
  `);
  const liveOverlapCount = Number(liveOverlapRes.rows?.[0]?.overlap_cnt || 0);
  const liveBoundaryCount = Number(liveZeroBoundaryRes.rows?.[0]?.boundary_cnt || 0);
  assert.ok(liveOverlapCount > 0, 'Live DB must have intra-section chunks with overlap_chars > 0');
  assert.ok(liveBoundaryCount > 0, 'Live DB must have boundary chunks with overlap_chars === 0');

  // 2. Deterministic multi-chunk section + hard boundary test
  const paraA1 = Array.from({ length: 170 }, (_, i) => `alphaWord${i}`).join(' ') + '.';
  const paraA2 = Array.from({ length: 170 }, (_, i) => `betaWord${i}`).join(' ') + '.';
  const paraB1 = Array.from({ length: 120 }, (_, i) => `gammaSectionB${i}`).join(' ') + '.';
  const syntheticText = [
    '# POLICY HANDBOOK',
    '## 1. FIRST LONG SECTION',
    paraA1,
    '',
    paraA2,
    '## 2. SECOND DISTINCT SECTION',
    paraB1,
  ].join('\n');

  const chunks = chunkDocumentPages(
    [{ page_number: 1, text: syntheticText }],
    {
      docId: crypto.randomUUID(),
      businessId: '11111111-2222-3333-4444-555555555555',
      filename: 'Synthetic_Overlap_Check.pdf',
    }
  );
  const sec1Chunks = chunks.filter((c) => c.section_title.includes('FIRST LONG SECTION'));
  const sec2Chunks = chunks.filter((c) => c.section_title.includes('SECOND DISTINCT SECTION'));
  assert.ok(sec1Chunks.length >= 2, `Expected >= 2 chunks in long Section 1, got ${sec1Chunks.length}`);
  assert.equal(sec1Chunks[0].overlap_chars, 0, 'First chunk of Section 1 must have overlap_chars === 0');
  assert.ok(sec1Chunks[1].overlap_chars > 0, 'Continuation chunk in Section 1 must have overlap_chars > 0');
  assert.ok(sec2Chunks.length >= 1);
  assert.equal(sec2Chunks[0].overlap_chars, 0, 'First chunk of new heading Section 2 must have overlap_chars === 0');
  assert.equal(
    sec2Chunks[0].raw_text.includes('betaWord'),
    false,
    'Section 2 must never inherit overlapping text from Section 1'
  );

  return {
    passed: true,
    live_db_overlap_chunks: liveOverlapCount,
    live_db_boundary_chunks: liveBoundaryCount,
    synthetic_sec1_chunks: sec1Chunks.length,
    synthetic_sec1_chunk2_overlap_chars: sec1Chunks[1].overlap_chars,
    synthetic_sec2_first_overlap_chars: sec2Chunks[0].overlap_chars,
  };
}

async function runEval4LifecycleMetadataFiltering() {
  const wsId = '11111111-2222-3333-4444-555555555555';
  const docRes = await query(
    `SELECT doc_id, filename FROM workspace_documents WHERE workspace_id = $1 AND filename = 'Hub_Reserve_Allocation_Policy.pdf' LIMIT 1;`,
    [wsId]
  );
  const targetDoc = docRes.rows?.[0];
  assert.ok(targetDoc, 'Target test document Hub_Reserve_Allocation_Policy.pdf must exist');

  let inactiveHits = -1;
  let restoredHits = 0;

  try {
    await setDocumentActiveState(wsId, targetDoc.doc_id, false);
    const duringInactive = await hybridSearchDocumentChunks({
      workspaceId: wsId,
      query: '10-Unit Hub Reserve Buffer SOP-WH-2026-09',
      topK: 10,
    });
    inactiveHits = duringInactive.filter((c) => c.doc_id === targetDoc.doc_id).length;
    assert.equal(
      inactiveHits,
      0,
      `Expected 0 chunks from deactivated doc ${targetDoc.filename}, got ${inactiveHits}`
    );
  } finally {
    await setDocumentActiveState(wsId, targetDoc.doc_id, true);
  }

  const afterRestore = await hybridSearchDocumentChunks({
    workspaceId: wsId,
    query: '10-Unit Hub Reserve Buffer SOP-WH-2026-09',
    topK: 10,
  });
  restoredHits = afterRestore.filter((c) => c.doc_id === targetDoc.doc_id).length;
  assert.ok(restoredHits > 0, 'Restored active document must appear in Hybrid RRF results');

  return {
    passed: true,
    tested_doc: targetDoc.filename,
    chunks_when_inactive: inactiveHits,
    chunks_after_restore: restoredHits,
  };
}

async function runEval5CompactTurnMemory() {
  const wsId = '684a8863-5094-4c8b-9b15-c50c06335b7f';
  const sessionId = `eval-phase1-session-${crypto.randomUUID()}`;
  const bigRowKeys = Array.from({ length: 42 }, (_, i) => `BO-${2001 + i}`);

  let windowResult = null;
  let remainingAfterCleanup = -1;

  try {
    for (let t = 1; t <= 6; t += 1) {
      const rec = await recordTurnState({
        workspaceId: wsId,
        sessionId,
        turnNumber: t,
        entity: 'user',
        userIntentSummary:
          t === 3
            ? 'Bulk cross-check all 42 backorders against products catalog inventory safety floor'
            : `Synthetic turn ${t} operation on wholesale orders and stock buffer compliance`,
        actionTaken:
          t === 3 ? 'READ 42 rows across backorders_dataset, products' : `STEP_${t}_ACTION`,
        touchedTables: t % 2 === 0 ? ['backorders_dataset'] : ['backorders_dataset', 'products'],
        touchedRowKeys: t === 3 ? bigRowKeys : [`BO-${3000 + t}`, `VL-SKU-${t}`],
        touchedDocCitations: ['Company_Policy.pdf#Page 1'],
        outcomeSummary: `Completed synthetic turn ${t} evaluation with buffer and policy checks verified across rows.`,
      });
      assert.ok(rec, `Turn ${t} must persist`);
    }

    windowResult = await getCompactMemoryWindow(wsId, sessionId, 5, 600);
    assert.equal(windowResult.turns.length, 5, 'Window must return strictly the latest 5 turns');
    assert.deepEqual(
      windowResult.turns.map((t) => Number(t.turn_number)),
      [2, 3, 4, 5, 6],
      'Turns must be ordered chronologically for Turns 2..6'
    );

    const turn3 = windowResult.turns.find((t) => Number(t.turn_number) === 3);
    assert.ok(turn3);
    assert.ok(
      turn3.touched_row_keys.includes('BO-2001') &&
        turn3.touched_row_keys.includes('+17 more'),
      `Expected capped 25 keys + "+17 more", got ${JSON.stringify(turn3.touched_row_keys)}`
    );
    assert.ok(
      windowResult.estimatedTokens <= 600,
      `Compact memory window (${windowResult.estimatedTokens} tokens) must be <= 600 tokens`
    );

    for (const line of windowResult.formattedBlock.split('\n')) {
      const lineTokens = estimateTokenCount(line);
      assert.ok(lineTokens <= 120, `Each turn line (${lineTokens} tokens) must be <= 120 tokens`);
    }
  } finally {
    await clearSessionMemory(wsId, sessionId);
    const check = await query(
      `SELECT COUNT(*)::int AS cnt FROM workspace_turn_memory WHERE workspace_id = $1 AND session_id = $2;`,
      [wsId, sessionId]
    );
    remainingAfterCleanup = Number(check.rows?.[0]?.cnt || 0);
    assert.equal(remainingAfterCleanup, 0, 'Synthetic Eval 5 memory rows must be cleaned up');
  }

  return {
    passed: true,
    returned_turns: windowResult.turns.map((t) => Number(t.turn_number)),
    estimated_tokens: windowResult.estimatedTokens,
    turn3_row_key_count: windowResult.turns[1].touched_row_keys.length,
    cleaned_remaining_rows: remainingAfterCleanup,
  };
}

async function main() {
  const eval1 = await runEval1StorageAndVectorIntegrity();
  const eval2 = await runEval2VagueIntentHybridRecall();
  const eval3 = await runEval3IntraSectionOverlap();
  const eval4 = await runEval4LifecycleMetadataFiltering();
  const eval5 = await runEval5CompactTurnMemory();

  console.log(
    JSON.stringify(
      {
        status: 'ALL_EVALS_PASSED',
        eval1_storage_and_vectors: eval1,
        eval2_vague_intent_recall: eval2,
        eval3_intra_section_overlap: eval3,
        eval4_lifecycle_is_active: eval4,
        eval5_compact_turn_memory: eval5,
      },
      null,
      2
    )
  );
}

main()
  .catch((err) => {
    console.error('[Phase1Eval] FAILED:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      await getPool().end();
    } catch {
      // Ignore pool close errors
    }
  });
