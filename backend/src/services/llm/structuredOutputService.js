const AppError = require('../../utils/AppError');
const { invokeLLM } = require('./llmGatewayService');
const {
  DEFAULT_MAX_INPUT_TOKENS,
  enforceTokenBudget,
  estimateTokens,
} = require('./tokenBudgetService');

let providerOverride = null;

/**
 * Allows injecting an explicit provider callback for offline unit tests (e.g., Phase 2 Evals).
 *
 * @param {Function | null} fn
 */
function setStructuredLLMProviderOverride(fn) {
  providerOverride = typeof fn === 'function' ? fn : null;
}

/**
 * Strips `<think>` blocks / markdown code fences and extracts a valid JSON object or array substring.
 *
 * @param {string | object} rawOutput
 * @returns {any}
 */
function extractAndParseJson(rawOutput) {
  if (rawOutput && typeof rawOutput === 'object') {
    return rawOutput;
  }
  const rawStr = String(rawOutput ?? '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .trim();
  if (!rawStr) {
    throw new Error('Provider returned an empty response when JSON was expected.');
  }

  const stripped = rawStr
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  try {
    return JSON.parse(stripped);
  } catch (directErr) {
    const firstBrace = stripped.indexOf('{');
    const lastBrace = stripped.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      try {
        return JSON.parse(stripped.slice(firstBrace, lastBrace + 1));
      } catch {
        // Fall through
      }
    }
    const firstBracket = stripped.indexOf('[');
    const lastBracket = stripped.lastIndexOf(']');
    if (firstBracket !== -1 && lastBracket > firstBracket) {
      try {
        return JSON.parse(stripped.slice(firstBracket, lastBracket + 1));
      } catch {
        // Fall through
      }
    }
    throw new Error(`Malformed JSON output: ${directErr.message}`);
  }
}

function formatZodIssues(issues = []) {
  return (Array.isArray(issues) ? issues : []).map((issue) => ({
    path: Array.isArray(issue.path) && issue.path.length > 0 ? issue.path.join('.') : '<root>',
    message: issue.message || 'Invalid value',
    code: issue.code || 'invalid',
  }));
}

function isGatewayTransportFailure(err) {
  return Boolean(
    err?.code === 'LLM_GATEWAY_EXHAUSTED' ||
      err?.statusCode === 503 ||
      err?.upstreamStatus ||
      err?.code === 'GEMINI_TIMEOUT' ||
      err?.code === 'GEMINI_NETWORK_ERROR' ||
      err?.code === 'LLM_TIMEOUT' ||
      err?.code === 'LLM_NETWORK_ERROR'
  );
}

function buildZodSchemaHint(zodSchema) {
  try {
    const { z } = require('zod');
    if (typeof z.toJSONSchema !== 'function') return null;
    const js = z.toJSONSchema(zodSchema, { unrepresentable: 'any', io: 'input' });
    const strip = (node) => {
      if (Array.isArray(node)) return node.map(strip);
      if (!node || typeof node !== 'object') return node;
      const out = {};
      for (const [k, v] of Object.entries(node)) {
        if (k === '$schema' || k === 'additionalProperties' || k === 'description') continue;
        out[k] = strip(v);
      }
      return out;
    };
    return strip(js);
  } catch {
    return null;
  }
}

async function callUnderlyingProvider({
  systemPrompt,
  userPrompt,
  jsonSchema,
  schemaHint = null,
  modelTier,
  stage,
  thinkingBudget,
  timeoutMs,
  providerFn,
  isRepair = false,
  excludeCandidates = [],
}) {
  const fn = providerFn || providerOverride;
  if (typeof fn === 'function') {
    const raw = await fn({
      systemPrompt,
      userPrompt,
      jsonSchema,
      schemaHint,
      modelTier,
      stage,
      isRepair,
    });
    return {
      isOverride: true,
      text: raw,
      gatewayMeta: null,
    };
  }

  const effectiveStage =
    stage ||
    (modelTier === 'fast' ? 'react_step' : 'socratic_analysis');
  const effectiveThinkingBudget = Number.isInteger(thinkingBudget)
    ? thinkingBudget
    : modelTier === 'reasoning'
      ? 128
      : 0;

  const gwRes = await invokeLLM({
    tier: modelTier === 'reasoning' ? 'reasoning' : 'fast',
    systemPrompt,
    userPrompt,
    expectJson: true,
    jsonSchema: jsonSchema || null,
    temperature: 0.1,
    operationName: isRepair ? `${effectiveStage}_repair` : effectiveStage,
    timeoutMs: timeoutMs || undefined,
    thinkingBudget: effectiveThinkingBudget,
    excludeCandidates,
    schemaHint,
  });

  return {
    isOverride: false,
    text: gwRes.text,
    gatewayMeta: {
      provider: gwRes.provider,
      model: gwRes.model,
      candidateKey: gwRes.candidateKey,
      tier: gwRes.tier,
      fallbackUsed: gwRes.fallbackUsed,
      inputTokens: gwRes.usage?.inputTokens || 0,
      outputTokens: gwRes.usage?.outputTokens || 0,
      cachedTokens: gwRes.usage?.cachedTokens || 0,
    },
  };
}

function buildMetaSummary({
  budgeted,
  startedAt,
  repaired,
  attempts,
  gatewayMeta,
  repairEstimatedTokens,
  extra = {},
}) {
  return {
    estimatedTokens: budgeted.estimatedTokens,
    ...(Number.isFinite(repairEstimatedTokens) ? { repairEstimatedTokens } : {}),
    trimmed: budgeted.trimmed,
    trimLog: budgeted.trimLog,
    repaired,
    attempts,
    durationMs: Date.now() - startedAt,
    ...(gatewayMeta || {}),
    ...extra,
  };
}

function validateParsedPayload(rawOutput, zodSchema) {
  const parsed = extractAndParseJson(rawOutput);
  const checked = zodSchema.safeParse(parsed);
  if (checked.success) {
    return { ok: true, data: checked.data };
  }
  const issues = formatZodIssues(checked.error.issues);
  return {
    ok: false,
    issues,
    errorText: `Schema validation failed: ${JSON.stringify(issues)}`,
    rawText: typeof rawOutput === 'string' ? rawOutput : JSON.stringify(rawOutput),
  };
}

/**
 * Provider-agnostic structured LLM caller backed by the 2-tier multi-provider gateway:
 * - Cache-ordered token budget enforcement (<= maxInputTokens)
 * - Strict Zod validation (json_object / responseSchema / think & fence stripping)
 * - Max 1 targeted self-repair retry sending ONLY malformed JSON + zodError.issues
 * - Optional 1 cross-provider failover retry (live gateway only) if repair still fails
 *
 * @param {object} params
 */
async function invokeStructuredLLM({
  systemPrompt = '',
  userPrompt = '',
  promptBlocks = null,
  zodSchema,
  jsonSchema = null,
  modelTier = 'fast',
  maxInputTokens = DEFAULT_MAX_INPUT_TOKENS,
  stage = null,
  thinkingBudget = null,
  timeoutMs = null,
  providerFn = null,
}) {
  if (!zodSchema || typeof zodSchema.safeParse !== 'function') {
    throw new AppError('invokeStructuredLLM requires a valid zodSchema.', 500);
  }

  const blocks =
    Array.isArray(promptBlocks) && promptBlocks.length > 0
      ? promptBlocks
      : [
          ...(systemPrompt
            ? [
                {
                  id: 'system_prompt',
                  role: 'static',
                  kind: 'system',
                  protected: true,
                  content: String(systemPrompt),
                },
              ]
            : []),
          {
            id: 'user_prompt',
            role: 'dynamic',
            kind: 'user_prompt',
            protected: true,
            content: String(userPrompt || ''),
          },
        ];

  const budgeted = enforceTokenBudget(blocks, maxInputTokens);
  const schemaHint = jsonSchema ? null : buildZodSchemaHint(zodSchema);
  const startedAt = Date.now();
  const isCustomProvider =
    typeof (providerFn || providerOverride) === 'function';

  let attempt1Result;
  let attempt1Error = null;
  let rawTextForRepair = '';
  let issueListForRepair = [];

  try {
    attempt1Result = await callUnderlyingProvider({
      systemPrompt: budgeted.systemPrompt,
      userPrompt: budgeted.userPrompt,
      jsonSchema,
      schemaHint,
      modelTier,
      stage,
      thinkingBudget,
      timeoutMs,
      providerFn,
      isRepair: false,
    });

    const validation1 = validateParsedPayload(attempt1Result.text, zodSchema);
    if (validation1.ok) {
      return {
        data: validation1.data,
        meta: buildMetaSummary({
          budgeted,
          startedAt,
          repaired: false,
          attempts: 1,
          gatewayMeta: attempt1Result.gatewayMeta,
        }),
      };
    }

    attempt1Error = validation1.errorText;
    rawTextForRepair = validation1.rawText;
    issueListForRepair = validation1.issues;
  } catch (err) {
    if (isGatewayTransportFailure(err)) {
      throw err;
    }
    attempt1Error = err?.message || 'Invalid JSON response';
    rawTextForRepair =
      typeof attempt1Result?.text === 'string'
        ? attempt1Result.text
        : JSON.stringify(attempt1Result?.text ?? '');
    issueListForRepair = [
      { path: '<json>', message: attempt1Error, code: 'invalid_json' },
    ];
  }

  // Max 1 targeted self-repair call containing ONLY the malformed JSON and exact Zod issues
  const repairSystemPrompt =
    'You are a strict JSON schema repair utility. Fix ONLY the provided JSON to satisfy the exact schema validation issues. Return ONLY valid JSON.';
  const repairUserPrompt = `MALFORMED_OUTPUT:\n${String(rawTextForRepair || '').slice(0, 2500)}\n\nVALIDATION_ISSUES:\n${JSON.stringify(issueListForRepair)}\n\nReturn the repaired JSON object only.`;

  let repairIssues = issueListForRepair;
  try {
    const attempt2Result = await callUnderlyingProvider({
      systemPrompt: repairSystemPrompt,
      userPrompt: repairUserPrompt,
      jsonSchema,
      schemaHint,
      modelTier: 'fast',
      stage: stage || 'react_step',
      thinkingBudget: 0,
      timeoutMs: 15000,
      providerFn,
      isRepair: true,
    });

    const validation2 = validateParsedPayload(attempt2Result.text, zodSchema);
    if (validation2.ok) {
      return {
        data: validation2.data,
        meta: buildMetaSummary({
          budgeted,
          startedAt,
          repaired: true,
          attempts: 2,
          gatewayMeta: attempt2Result.gatewayMeta || attempt1Result?.gatewayMeta,
          repairEstimatedTokens:
            estimateTokens(repairSystemPrompt) + estimateTokens(repairUserPrompt),
        }),
      };
    }
    repairIssues = validation2.issues;
  } catch (repairErr) {
    if (isGatewayTransportFailure(repairErr)) {
      throw repairErr;
    }
    repairIssues = [
      {
        path: '<json>',
        message: repairErr?.message || 'Repair parse failed',
        code: 'invalid_json',
      },
    ];
  }

  // Cross-provider failover retry (live gateway only, never in offline unit overrides):
  // exclude the candidate that produced invalid schema on attempt 1 so another model runs fresh.
  const firstCandidateKey = attempt1Result?.gatewayMeta?.candidateKey;
  if (!isCustomProvider && firstCandidateKey) {
    try {
      const attempt3Result = await callUnderlyingProvider({
        systemPrompt: budgeted.systemPrompt,
        userPrompt: budgeted.userPrompt,
        jsonSchema,
        schemaHint,
        modelTier,
        stage,
        thinkingBudget,
        timeoutMs,
        providerFn: null,
        isRepair: false,
        excludeCandidates: [firstCandidateKey],
      });
      const validation3 = validateParsedPayload(attempt3Result.text, zodSchema);
      if (validation3.ok) {
        return {
          data: validation3.data,
          meta: buildMetaSummary({
            budgeted,
            startedAt,
            repaired: false,
            attempts: 3,
            gatewayMeta: attempt3Result.gatewayMeta,
            extra: { fallbackUsed: true, crossProviderRetry: true },
          }),
        };
      }
      repairIssues = validation3.issues;
    } catch (crossErr) {
      if (isGatewayTransportFailure(crossErr)) {
        throw crossErr;
      }
    }
  }

  throw new AppError(
    `Structured LLM output failed validation after repair${!isCustomProvider && firstCandidateKey ? ' and cross-provider retry' : ''}: ${JSON.stringify(repairIssues)} (${attempt1Error})`,
    502
  );
}

module.exports = {
  invokeStructuredLLM,
  extractAndParseJson,
  formatZodIssues,
  setStructuredLLMProviderOverride,
};
