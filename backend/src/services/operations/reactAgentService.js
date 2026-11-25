const crypto = require('node:crypto');
const { buildCacheOrderedPrompt } = require('../llm/promptTemplates');
const { invokeStructuredLLM } = require('../llm/structuredOutputService');
const { ReActStepSchema } = require('../llm/schemas');
const { verifyCitations, buildDocumentCitation, buildTableRowCitation, resolveRowIdentifier } = require('../rag/crossRagService');
const { recordTurnState } = require('../memory/turnMemoryService');
const { saveWorkflowState } = require('./socraticWorkflowStore');
const {
  getToolDefinitionsForEntity,
  executeToolCall,
  ensureTableLoadedWithRows,
} = require('./toolRegistry');
const { classifyTableColumns } = require('../rag/queryRouterService');

const MAX_REACT_STEPS = 3;
const HARD_REACT_STEP_CEILING = 4;

function sanitizeCustomerResponseText(text = '', tables = []) {
  let clean = String(text || '');
  if (!clean) return clean;

  // Strip internal table names (e.g., backorders_dataset, workspace_table_metadata)
  const forbiddenTableNames = [
    'workspace_table_metadata',
    'workspace_documents',
    'workspace_document_chunks',
    'workspace_turn_memory',
    'socratic_workflows',
    ...(Array.isArray(tables) ? tables.map((t) => String(t.tableName || '')) : []),
  ].filter((name) => name && name.length >= 4);

  for (const tbl of forbiddenTableNames) {
    const rx = new RegExp(`\\b${tbl.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\\b`, 'gi');
    clean = clean.replace(rx, 'our records');
  }

  // Mask accidental internal hub/lead/staff/coordinator emails
  clean = clean.replace(
    /\b[a-z0-9._%+-]*(?:hub[._-]?lead|warehouse[._-]?lead|coordinator|unit[._-]?contact|staff|ops[._-]?lead)[a-z0-9._%+-]*@[a-z0-9.-]+\.[a-z]{2,}\b/gi,
    'our fulfillment team'
  );

  return clean.replace(/\s{2,}/g, ' ').trim();
}

function buildVerifiedCitationsList(claimedCitations = [], observedChunks = [], observedRows = [], requestEntity = 'user') {
  const rawClaimed = Array.isArray(claimedCitations) ? [...claimedCitations] : [];

  // Always include deterministic grounded citations if model omitted them or cited filenames cleanly
  if (rawClaimed.length === 0) {
    for (const c of (observedChunks || []).slice(0, 6)) {
      rawClaimed.push({
        source_type: 'document',
        chunk_id: c.chunk_id || c.id,
        source_name: c.filename,
        locator: c.locator || `Page ${c.page_number || 1}`,
        excerpt: String(c.raw_text || '').slice(0, 280),
      });
    }
    if (requestEntity !== 'customer') {
      const seenRowKeys = new Set();
      for (const r of (observedRows || []).slice(0, 8)) {
        const key = `${r.table_name}::${r.row_identifier}`.toLowerCase();
        if (seenRowKeys.has(key)) continue;
        seenRowKeys.add(key);
        rawClaimed.push(buildTableRowCitation(r.table_name, r.row, 1));
      }
    }
  }

  const verified = verifyCitations(rawClaimed, observedChunks, observedRows);
  if (verified.length > 0) {
    return verified;
  }

  // Fallback strictly to actually observed grounded sources (still checked by verifyCitations)
  const groundedFallback = [
    ...(observedChunks || []).slice(0, 6).map((c) => ({
      ...buildDocumentCitation(c),
      chunk_id: c.chunk_id || c.id,
    })),
    ...(requestEntity === 'customer'
      ? []
      : (observedRows || []).slice(0, 6).map((r) => buildTableRowCitation(r.table_name, r.row, 1))),
  ];
  return verifyCitations(groundedFallback, observedChunks, observedRows);
}

async function buildMultiHopCompatibleState(businessId, routerResult, context) {
  const targetNames =
    Array.isArray(routerResult?.target_tables) && routerResult.target_tables.length > 0
      ? routerResult.target_tables
      : routerResult?.primary_table
        ? [routerResult.primary_table]
        : [];

  for (const name of targetNames) {
    await ensureTableLoadedWithRows(businessId, name, context).catch(() => {});
  }
  const targetTables = [];
  const seen = new Set();
  for (const entry of context.loadedTablesByName.values()) {
    if (!entry?.tableName) continue;
    const k = entry.tableName.toLowerCase();
    if (!seen.has(k)) {
      seen.add(k);
      targetTables.push(entry);
    }
  }

  return {
    hop1: {
      retrievedChunks: context.observedChunks,
    },
    hop2: {
      targetTable: targetTables[0] || null,
      targetTables,
    },
    workspaceCustomers: [],
  };
}

function buildStepInstruction({
  step,
  maxSteps,
  routerResult,
  requestEntity,
  customerContext,
  hasObservedRows = false,
  mutationsStagedCount = 0,
  forceSynthesis = false,
}) {
  const isOperation = routerResult?.intent === 'AGENTIC_OPERATION' && requestEntity !== 'customer';
  const currentDateIso = new Date().toISOString().slice(0, 10);
  const schemaHint =
    'OUTPUT JSON SHAPE: { "thought": string, "action": "call_tool"|"final_answer"|"socratic_pause"|"preview_ready", "tool_calls"?: [{ "tool_name": string, "tool_args": object }], "final_payload"?: { "answer": string, "category"?: string, "highlighted_row_ids"?: string[], "citations"?: [{ "source_type": "document"|"table", "chunk_id"?: string, "source_name": string, "locator"?: string, "row_identifier"?: string }] } }';

  if (forceSynthesis) {
    return `FINAL SYNTHESIS STEP (Tool calling disabled; CURRENT_DATE UTC: ${currentDateIso}):
Synthesize your final grounded JSON response now strictly using the observed RRF chunks and PostgreSQL tool results above.
${schemaHint}
Return action="final_answer" with final_payload.answer, highlighted_row_ids, and verified citations.`;
  }

  if (requestEntity === 'customer') {
    return `REACT STEP ${step}/${maxSteps} (CUSTOMER CARE MODE — READ-ONLY; CURRENT_DATE UTC: ${currentDateIso}):
Customer Context: ${JSON.stringify(customerContext || {})}
- Expanded Search Hints: ${JSON.stringify(routerResult?.expanded_queries || [])}
- Step 1: Call query_tables_with_lookup (and search_docs in parallel only if needed beyond the RRF chunks already provided) to verify this customer's records and policy terms.
- Step 2+: Return action="final_answer" with a polite, helpful customer-care message in final_payload.answer and verified document citations.
- STRICT ISOLATION: NEVER mention internal table names, raw column names, internal staff emails, or mutate any data.
${schemaHint}`;
  }

  if (isOperation) {
    const stepGuidance = mutationsStagedCount > 0
      ? `1. STAGE 1 MUTATIONS ARE ALREADY VALIDATED & STAGED (${mutationsStagedCount} row mutation(s) ok=true) — DO NOT re-call query_tables_with_lookup or propose_table_mutations! Only call draft_emails now covering ALL evaluated recipients (including any missing_records shown in Step ${step - 1} above).`
      : !hasObservedRows
        ? '1. Step 1: Call query_tables_with_lookup with dependent_lookups across BOTH anchor AND secondary tables first so you have live stock/unit numbers, real recipient emails, and exact _row_id values for EVERY table you plan to mutate.'
        : '1. Live table rows are ALREADY in TOOL & POSTGRESQL OBSERVATIONS above — DO NOT call query_tables_with_lookup again unless a needed table is missing!';
    return `REACT STEP ${step}/${maxSteps} (AGENTIC OPERATION MODE; CURRENT_DATE UTC: ${currentDateIso}):
Audience Scope Required by Router: "${routerResult?.target_audience_scope || 'none'}"
Expanded Search Hints: ${JSON.stringify(routerResult?.expanded_queries || [])}
INSTRUCTIONS:
${stepGuidance}
2. Emit BOTH "propose_table_mutations" AND "draft_emails" together inside "tool_calls": [...] in ONE step once you have the live rows:
   - Pass explicit policy_rule_applied { target_table, numeric_column, min_reserve_threshold, citation_chunk_id } to propose_table_mutations.
   - Pre-filter secondary-table deductions so ONLY eligible rows keeping (before - deducted >= min_reserve_threshold) are deducted; DO NOT propose deductions that breach the reserve buffer unless explicitly waived by the user.
   - Update ALL affected tables requested (e.g., both primary order/backorder status AND secondary stock/unit deduction).
   - When emailing all buyers/customers/affected parties, call draft_emails covering ALL evaluated recipients (both fulfilled AND unfulfilled/held outcomes), strictly keeping audience_scope="${routerResult?.target_audience_scope || 'primary_customers_only'}" so internal hub/staff emails are excluded unless explicitly requested.
3. NEVER emit action="preview_ready" before propose_table_mutations returns ok=true. Emit action="preview_ready" ONLY after Stage 1 mutations/emails are staged (or ask_socratic_clarification / action="socratic_pause" on genuine conflict).
${schemaHint}`;
  }

  return `REACT STEP ${step}/${maxSteps} (CROSS-SOURCE READ MODE — READ-ONLY; CURRENT_DATE UTC: ${currentDateIso}):
Expanded Search Hints: ${JSON.stringify(routerResult?.expanded_queries || [])}
INSTRUCTIONS:
1. ${hasObservedRows ? 'Live rows are already in TOOL & POSTGRESQL OBSERVATIONS above; synthesize your answer now.' : 'Inspect COMPACT 5-TURN MEMORY and HYBRID RRF CHUNKS already retrieved above. If you need structured rows or cross-table comparison (Option B dependent_lookups + cross_table_comparisons), call query_tables_with_lookup (optionally paired with search_docs via "tool_calls").'}
2. Once you have the exact PostgreSQL rows/comparisons, return action="final_answer" with a concise, factual answer in final_payload.answer, highlighted_row_ids, and verified citations. Never invent data or propose mutations.
${schemaHint}`;
}

function buildFinalReadResult({
  answer,
  category = 'cross_source_read',
  missingInformation = [],
  highlightedRowIds = [],
  claimedCitations = [],
  context,
  routerResult,
  requestEntity,
  stepsTaken,
  effectiveMaxSteps,
  tokenReadings,
  startedAt,
  toolTrace,
}) {
  const safeAnswer =
    requestEntity === 'customer'
      ? sanitizeCustomerResponseText(answer, routerResult?.tables || [])
      : String(answer || '').trim();

  const verifiedCitations = buildVerifiedCitationsList(
    claimedCitations,
    context.observedChunks,
    context.observedRows,
    requestEntity
  );

  const uniqueRows = [];
  const seenRowKeys = new Set();
  for (const r of context.observedRows) {
    const key = `${r.table_name}::${r.row_identifier}`.toLowerCase();
    if (!seenRowKeys.has(key)) {
      seenRowKeys.add(key);
      uniqueRows.push(r.row);
    }
  }

  const resolvedHighlighted =
    Array.isArray(highlightedRowIds) && highlightedRowIds.length > 0
      ? highlightedRowIds.map((id) => {
          const cleanId = String(id ?? '').trim();
          const matchedObs = context.observedRows.find(
            (r) => String(r.row_identifier || '').trim().toLowerCase() === cleanId.toLowerCase()
          );
          return matchedObs
            ? { table_name: matchedObs.table_name, row_identifier: matchedObs.row_identifier }
            : { row_identifier: cleanId };
        })
      : context.observedRows.slice(0, 20).map((r) => ({
          table_name: r.table_name,
          row_identifier: r.row_identifier,
        }));

  // Ensure every verified table citation is also reflected in highlighted_rows
  const hlKeySet = new Set(
    resolvedHighlighted.map((h) => `${h.table_name || ''}::${h.row_identifier || ''}`.toLowerCase())
  );
  for (const cit of verifiedCitations) {
    if (cit && typeof cit === 'object' && (cit.source_type === 'table' || cit.row_identifier)) {
      const rid = String(cit.row_identifier || String(cit.locator || '').replace(/^row\s+/i, '')).trim();
      const tbl = String(cit.source_name || cit.table_name || '').trim();
      const matchedObs = context.observedRows.find(
        (r) =>
          String(r.row_identifier || '').trim().toLowerCase() === rid.toLowerCase() &&
          (!tbl || String(r.table_name || '').trim().toLowerCase() === tbl.toLowerCase())
      );
      if (matchedObs) {
        const key = `${matchedObs.table_name}::${matchedObs.row_identifier}`.toLowerCase();
        if (!hlKeySet.has(key)) {
          hlKeySet.add(key);
          resolvedHighlighted.push({
            table_name: matchedObs.table_name,
            row_identifier: matchedObs.row_identifier,
          });
        }
      }
    }
  }

  const avgTokens =
    tokenReadings.length > 0
      ? Math.round(tokenReadings.reduce((a, b) => a + b, 0) / tokenReadings.length)
      : 0;

  return {
    status: 'CONVERSATIONAL',
    conversational: true,
    intent: requestEntity === 'customer' ? 'customer_reply' : 'cross_source_read',
    message: safeAnswer,
    answer: safeAnswer,
    category,
    missing_information: Array.isArray(missingInformation) ? missingInformation : [],
    rows: requestEntity === 'customer' ? [] : uniqueRows.slice(0, 40),
    highlighted_rows: requestEntity === 'customer' ? [] : resolvedHighlighted,
    matched_row_ids: resolvedHighlighted.map((h) => h.row_identifier).filter(Boolean),
    citations: verifiedCitations,
    react_telemetry: {
      steps_taken: stepsTaken,
      max_steps: effectiveMaxSteps,
      estimated_input_tokens_per_call: tokenReadings,
      avg_estimated_input_tokens: avgTokens,
      duration_ms: Date.now() - startedAt,
      tool_trace: toolTrace,
      expanded_queries: routerResult?.expanded_queries || [],
    },
  };
}

/**
 * Bounded ReAct Orchestrator (max 3 steps, hard ceiling 4).
 * Uses cache-ordered prompts (<=4500 tokens), Zod structured outputs with 1 self-repair retry,
 * parallel read-only tool dispatch, and strict Stage 1 HITL boundaries.
 *
 * @param {object} params
 */
async function runBoundedReActLoop({
  businessId,
  prompt,
  entity = null,
  requestEntity = 'user',
  customerContext = {},
  routerResult,
  sessionId = null,
  maxSteps = MAX_REACT_STEPS,
  providerFn = null,
}) {
  const startedAt = Date.now();
  const normalizedEntity =
    String(requestEntity || 'user').trim().toLowerCase() === 'customer'
      ? 'customer'
      : 'user';
  const effectiveMaxSteps = Math.max(
    1,
    Math.min(HARD_REACT_STEP_CEILING, Number(maxSteps) || MAX_REACT_STEPS)
  );

  const context = {
    businessId,
    prompt,
    entity: entity || routerResult?.primary_table || null,
    requestEntity: normalizedEntity,
    customerContext,
    targetAudienceScope: routerResult?.target_audience_scope || 'none',
    tables: routerResult?.tables || [],
    observedChunks: [...(routerResult?.prefetchedChunks || [])],
    observedRows: [],
    loadedTablesByName: new Map(),
    proposedMutations: [],
    draftedEmails: [],
    socraticClarification: null,
  };

  const toolDefinitions = getToolDefinitionsForEntity(normalizedEntity);
  const memoryTurns = routerResult?.memoryWindow?.turns || [];
  const observations = [];
  const tokenReadings = [];
  const toolTrace = [];
  let stepsTaken = 0;

  if (routerResult?.telemetry?.estimatedTokens) {
    tokenReadings.push(routerResult.telemetry.estimatedTokens);
  }

  for (let step = 1; step <= effectiveMaxSteps; step += 1) {
    stepsTaken = step;
    const promptObj = buildCacheOrderedPrompt({
      entity: normalizedEntity,
      toolDefinitions,
      tables: context.tables,
      memoryTurns,
      rrfChunks: context.observedChunks.slice(0, 6),
      sqlObservations: observations,
      userPrompt: prompt,
      extraInstruction: buildStepInstruction({
        step,
        maxSteps: effectiveMaxSteps,
        routerResult,
        requestEntity: normalizedEntity,
        customerContext,
        hasObservedRows: context.observedRows.length > 0,
        mutationsStagedCount: context.proposedMutations.length,
      }),
    });

    const { data: stepData, meta } = await invokeStructuredLLM({
      promptBlocks: promptObj.blocks,
      zodSchema: ReActStepSchema,
      modelTier:
        routerResult?.intent === 'AGENTIC_OPERATION' || step > 1
          ? 'reasoning'
          : 'fast',
      stage: step === 1 ? 'react_step' : 'socratic_analysis',
      maxInputTokens: 4500,
      providerFn,
    });
    if (Number.isFinite(meta?.estimatedTokens)) {
      tokenReadings.push(meta.estimatedTokens);
    }

    // Execute requested tool call(s)
    const requestedCalls =
      Array.isArray(stepData.tool_calls) && stepData.tool_calls.length > 0
        ? stepData.tool_calls
        : stepData.tool_name
          ? [{ tool_name: stepData.tool_name, tool_args: stepData.tool_args || {} }]
          : [];

    if (stepData.action === 'call_tool' && requestedCalls.length > 0) {
      const allReadOnly = requestedCalls.every((c) =>
        ['search_docs', 'query_tables_with_lookup'].includes(c.tool_name)
      );

      let stepResults = [];
      if (allReadOnly && requestedCalls.length > 1) {
        stepResults = await Promise.all(
          requestedCalls.map((c) => executeToolCall(c.tool_name, c.tool_args, context))
        );
      } else {
        for (const c of requestedCalls) {
          const res = await executeToolCall(c.tool_name, c.tool_args, context);
          stepResults.push(res);
          if (context.socraticClarification) break;
        }
      }

      for (let i = 0; i < requestedCalls.length; i += 1) {
        toolTrace.push({
          step,
          tool_name: requestedCalls[i].tool_name,
          ok: Boolean(stepResults[i]?.ok),
        });
        if (!stepResults[i]?.ok) {
          console.warn(`[ReAct Step ${step}] tool=${requestedCalls[i].tool_name} failed:`, stepResults[i]?.error || '');
        }
      }
      observations.push({
        step,
        thought: stepData.thought,
        results: stepResults,
      });

      if (context.socraticClarification) {
        break;
      }
      // Fast completion: once Stage 1 mutations (+ emails if requested) succeed cleanly, compile PREVIEW_READY immediately
      if (
        routerResult?.intent === 'AGENTIC_OPERATION' &&
        stepResults.every((r) => r.ok !== false) &&
        context.proposedMutations.length > 0 &&
        (!routerResult.requests_email || context.draftedEmails.length > 0)
      ) {
        break;
      }
      // If on the final allowed step the agent just completed mutation + email staging cleanly, stop and compile preview!
      if (
        step === effectiveMaxSteps &&
        (context.proposedMutations.length > 0 || context.draftedEmails.length > 0) &&
        stepResults.every((r) => r.ok !== false)
      ) {
        break;
      }
      continue;
    }

    // Handle terminal Socratic pause emitted directly
    if (stepData.action === 'socratic_pause' && context.socraticClarification) {
      break;
    }

    // Handle terminal PREVIEW_READY emitted directly
    if (
      stepData.action === 'preview_ready' &&
      (context.proposedMutations.length > 0 || context.draftedEmails.length > 0)
    ) {
      break;
    }
    if (stepData.action === 'preview_ready') {
      console.warn(`[ReAct Step ${step}] Premature preview_ready without staged mutations/emails; forcing tool follow-up or synthesis.`);
      if (step < effectiveMaxSteps) {
        observations.push({
          step,
          thought: stepData.thought,
          results: [{ ok: false, error: 'You must call propose_table_mutations (and draft_emails if emails requested) BEFORE emitting action="preview_ready".' }],
        });
        continue;
      }
    }

    // Operational requests must stage mutations/emails (HITL preview) rather than narrate changes.
    // Nudge once; if the model still answers directly, fall through to the normal final answer.
    if (
      stepData.action === 'final_answer' &&
      routerResult?.intent === 'AGENTIC_OPERATION' &&
      normalizedEntity !== 'customer' &&
      context.proposedMutations.length === 0 &&
      context.draftedEmails.length === 0 &&
      !context.socraticClarification &&
      !context._finalAnswerNudged &&
      step < effectiveMaxSteps
    ) {
      context._finalAnswerNudged = true;
      observations.push({
        step,
        thought: stepData.thought,
        results: [
          {
            ok: false,
            error:
              'This is an operational request: do NOT narrate changes in final_answer. Call propose_table_mutations (and draft_emails if emails were requested) in tool_calls so the changes are staged for user approval, or ask_socratic_clarification if a rule is ambiguous.',
          },
        ],
      });
      continue;
    }

    // Handle terminal final_answer
    if (stepData.action === 'final_answer' && stepData.final_payload?.answer) {
      const readRes = buildFinalReadResult({
        answer: stepData.final_payload.answer,
        category: stepData.final_payload.category || routerResult?.intent || 'cross_source_read',
        missingInformation: stepData.final_payload.missing_information || [],
        highlightedRowIds: stepData.final_payload.highlighted_row_ids || [],
        claimedCitations: stepData.final_payload.citations || [],
        context,
        routerResult,
        requestEntity: normalizedEntity,
        stepsTaken,
        effectiveMaxSteps,
        tokenReadings,
        startedAt,
        toolTrace,
      });

      await recordTurnState({
        workspaceId: businessId,
        sessionId,
        entity: normalizedEntity,
        userIntentSummary: prompt,
        actionTaken:
          normalizedEntity === 'customer'
            ? `CUSTOMER_REPLY (${readRes.category})`
            : 'READ cross_source_read',
        touchedTables: [
          ...new Set(context.observedRows.map((r) => r.table_name).filter(Boolean)),
        ],
        touchedRowKeys: readRes.matched_row_ids,
        touchedDocCitations: context.observedChunks
          .slice(0, 6)
          .map((c) => `${c.filename}#p${c.page_number || 1}`),
        outcomeSummary: readRes.answer,
      }).catch(() => {});

      return readRes;
    }

    // Fallback termination if model issued terminal action prematurely
    break;
  }

  // Handle CLARIFICATION_REQUIRED (Stage 1 Socratic Pause)
  if (context.socraticClarification && normalizedEntity !== 'customer') {
    const workflowId = crypto.randomUUID();
    const multiHopResult = await buildMultiHopCompatibleState(businessId, routerResult, context);
    const verifiedCitations = buildVerifiedCitationsList(
      context.socraticClarification.citations,
      context.observedChunks,
      context.observedRows,
      normalizedEntity
    );
    const avgTokens =
      tokenReadings.length > 0
        ? Math.round(tokenReadings.reduce((a, b) => a + b, 0) / tokenReadings.length)
        : 0;

    const workflow = {
      workflow_id: workflowId,
      business_id: businessId,
      session_id: sessionId || null,
      status: 'CLARIFICATION_REQUIRED',
      prompt,
      target_entity:
        multiHopResult.hop2.targetTable?.tableName || context.entity,
      conflict_summary: context.socraticClarification.conflict_summary,
      affected_rows_count: context.socraticClarification.affected_rows_count,
      conflicting_rows_count: context.socraticClarification.conflicting_rows_count,
      socratic_questions: context.socraticClarification.socratic_questions,
      citations: verifiedCitations,
      multiHopResult,
    };
    await saveWorkflowState(workflow);

    const clarifRes = {
      status: 'CLARIFICATION_REQUIRED',
      workflow_id: workflowId,
      target_entity: workflow.target_entity,
      matched_row_ids: context.observedRows
        .map((r) => r.row_identifier)
        .filter(Boolean)
        .slice(0, 25),
      conflict_summary: workflow.conflict_summary,
      affected_rows_count: workflow.affected_rows_count,
      conflicting_rows_count: workflow.conflicting_rows_count,
      socratic_questions: workflow.socratic_questions,
      citations: verifiedCitations,
      react_telemetry: {
        steps_taken: stepsTaken,
        max_steps: effectiveMaxSteps,
        estimated_input_tokens_per_call: tokenReadings,
        avg_estimated_input_tokens: avgTokens,
        duration_ms: Date.now() - startedAt,
        tool_trace: toolTrace,
        expanded_queries: routerResult?.expanded_queries || [],
      },
    };

    await recordTurnState({
      workspaceId: businessId,
      sessionId,
      entity: normalizedEntity,
      userIntentSummary: prompt,
      actionTaken: 'SOCRATIC_PAUSE',
      touchedTables: routerResult?.target_tables || [],
      touchedRowKeys: clarifRes.matched_row_ids,
      touchedDocCitations: context.observedChunks
        .slice(0, 6)
        .map((c) => `${c.filename}#p${c.page_number || 1}`),
      outcomeSummary: workflow.conflict_summary,
    }).catch(() => {});

    return clarifRes;
  }

  // Handle PREVIEW_READY (Stage 1 HITL Approval Gate)
  if (
    (context.proposedMutations.length > 0 || context.draftedEmails.length > 0) &&
    normalizedEntity !== 'customer'
  ) {
    const workflowId = crypto.randomUUID();
    const multiHopResult = await buildMultiHopCompatibleState(businessId, routerResult, context);
    const publicMutationsPreview = context.proposedMutations.map(
      ({ table_name, row_identifier, before, after }) => ({
        table_name,
        row_identifier,
        before,
        after,
      })
    );
    const verifiedCitations = buildVerifiedCitationsList(
      [],
      context.observedChunks,
      context.observedRows,
      normalizedEntity
    );
    const avgTokens =
      tokenReadings.length > 0
        ? Math.round(tokenReadings.reduce((a, b) => a + b, 0) / tokenReadings.length)
        : 0;

    const workflow = {
      workflow_id: workflowId,
      business_id: businessId,
      session_id: sessionId || null,
      status: 'PREVIEW_READY',
      prompt,
      target_entity:
        multiHopResult.hop2.targetTable?.tableName ||
        publicMutationsPreview[0]?.table_name ||
        context.entity,
      selected_option_id: 'apply_policy',
      mutations_preview: context.proposedMutations,
      emails_preview: context.draftedEmails,
      citations: verifiedCitations,
      multiHopResult,
    };
    await saveWorkflowState(workflow);

    const previewRes = {
      status: 'PREVIEW_READY',
      workflow_id: workflowId,
      target_entity: workflow.target_entity,
      matched_row_ids: publicMutationsPreview
        .map((m) => m.row_identifier)
        .filter(Boolean),
      mutations_preview: publicMutationsPreview,
      emails_preview: context.draftedEmails,
      citations: verifiedCitations,
      react_telemetry: {
        steps_taken: stepsTaken,
        max_steps: effectiveMaxSteps,
        estimated_input_tokens_per_call: tokenReadings,
        avg_estimated_input_tokens: avgTokens,
        duration_ms: Date.now() - startedAt,
        tool_trace: toolTrace,
        expanded_queries: routerResult?.expanded_queries || [],
      },
    };

    await recordTurnState({
      workspaceId: businessId,
      sessionId,
      entity: normalizedEntity,
      userIntentSummary: prompt,
      actionTaken: 'PREVIEW_READY',
      touchedTables: [
        ...new Set(context.proposedMutations.map((m) => m.table_name).filter(Boolean)),
      ],
      touchedRowKeys: previewRes.matched_row_ids,
      touchedDocCitations: context.observedChunks
        .slice(0, 6)
        .map((c) => `${c.filename}#p${c.page_number || 1}`),
      outcomeSummary: `Staged ${publicMutationsPreview.length} mutation(s), ${context.draftedEmails.length} email(s)`,
    }).catch(() => {});

    return previewRes;
  }

  // Force-Termination Safety: execute 1 final synthesis call summarizing findings
  const synthPromptObj = buildCacheOrderedPrompt({
    entity: normalizedEntity,
    toolDefinitions: null,
    tables: context.tables,
    memoryTurns,
    rrfChunks: context.observedChunks.slice(0, 6),
    sqlObservations: observations,
    userPrompt: prompt,
    extraInstruction: buildStepInstruction({
      step: stepsTaken,
      maxSteps: effectiveMaxSteps,
      routerResult,
      requestEntity: normalizedEntity,
      customerContext,
      forceSynthesis: true,
    }),
  });

  const { data: synthData, meta: synthMeta } = await invokeStructuredLLM({
    promptBlocks: synthPromptObj.blocks,
    zodSchema: ReActStepSchema,
    modelTier: 'fast',
    stage: 'react_step',
    maxInputTokens: 4500,
    providerFn,
  });
  if (Number.isFinite(synthMeta?.estimatedTokens)) {
    tokenReadings.push(synthMeta.estimatedTokens);
  }

  const finalAnswerText =
    synthData?.final_payload?.answer ||
    synthData?.thought ||
    'I reviewed the workspace documents and records, but could not complete the operation automatically. Please refine your request.';

  const finalReadRes = buildFinalReadResult({
    answer: finalAnswerText,
    category: synthData?.final_payload?.category || routerResult?.intent || 'cross_source_read',
    missingInformation: synthData?.final_payload?.missing_information || [],
    highlightedRowIds: synthData?.final_payload?.highlighted_row_ids || [],
    claimedCitations: synthData?.final_payload?.citations || [],
    context,
    routerResult,
    requestEntity: normalizedEntity,
    stepsTaken,
    effectiveMaxSteps,
    tokenReadings,
    startedAt,
    toolTrace,
  });

  await recordTurnState({
    workspaceId: businessId,
    sessionId,
    entity: normalizedEntity,
    userIntentSummary: prompt,
    actionTaken:
      normalizedEntity === 'customer'
        ? `CUSTOMER_REPLY (${finalReadRes.category})`
        : 'READ cross_source_read',
    touchedTables: [
      ...new Set(context.observedRows.map((r) => r.table_name).filter(Boolean)),
    ],
    touchedRowKeys: finalReadRes.matched_row_ids,
    touchedDocCitations: context.observedChunks
      .slice(0, 6)
      .map((c) => `${c.filename}#p${c.page_number || 1}`),
    outcomeSummary: finalReadRes.answer,
  }).catch(() => {});

  return finalReadRes;
}

module.exports = {
  MAX_REACT_STEPS,
  HARD_REACT_STEP_CEILING,
  runBoundedReActLoop,
  sanitizeCustomerResponseText,
  buildVerifiedCitationsList,
};
