const env = require('../../config/env');
const AppError = require('../../utils/AppError');
const {
  callOpenAICompatible,
  callGeminiFallback,
  modelHealthRegistry,
  getGatewayHealthSnapshot,
  resetGatewayHealth,
} = require('./providerAdapters');

const MAX_DIAGNOSTICS_BUFFER = 50;
const recentDiagnostics = [];
let adapterOverrides = null;

/**
 * Allows injecting deterministic mock adapters for Phase 3 failover drills.
 *
 * @param {{ callOpenAICompatible?: Function, callGeminiFallback?: Function } | null} overrides
 */
function setAdapterOverrides(overrides) {
  adapterOverrides =
    overrides && typeof overrides === 'object' ? overrides : null;
}

function recordDiagnostic(entry) {
  recentDiagnostics.push({
    timestamp: new Date().toISOString(),
    ...entry,
  });
  if (recentDiagnostics.length > MAX_DIAGNOSTICS_BUFFER) {
    recentDiagnostics.splice(0, recentDiagnostics.length - MAX_DIAGNOSTICS_BUFFER);
  }
}

function getRecentLLMDiagnostics(limit = MAX_DIAGNOSTICS_BUFFER) {
  const n = Number.isFinite(Number(limit)) && Number(limit) > 0
    ? Math.min(MAX_DIAGNOSTICS_BUFFER, Math.round(Number(limit)))
    : MAX_DIAGNOSTICS_BUFFER;
  return recentDiagnostics.slice(-n);
}

function clearRecentLLMDiagnostics() {
  recentDiagnostics.length = 0;
}

function candidateKey(candidate) {
  return `${candidate.provider}:${candidate.model}`;
}

function buildGroqCandidate(model, defaultMaxTokens, defaultTimeoutMs) {
  if (!env.groqApiKey || !env.groqBaseUrl || !model) return null;
  return {
    provider: 'groq',
    model,
    baseUrl: env.groqBaseUrl,
    apiKey: env.groqApiKey,
    defaultMaxTokens,
    defaultTimeoutMs,
  };
}

function buildCloudflareCandidate(model, defaultMaxTokens, defaultTimeoutMs) {
  if (!env.cloudflareApiKey || !env.cloudflareBaseUrl || !model) return null;
  return {
    provider: 'cloudflare',
    model,
    baseUrl: env.cloudflareBaseUrl,
    apiKey: env.cloudflareApiKey,
    defaultMaxTokens,
    defaultTimeoutMs,
  };
}

function buildGeminiCandidate(defaultMaxTokens, defaultTimeoutMs) {
  const model = env.geminiModel || 'gemini-3.5-flash';
  if (!env.geminiApiKey || !model) return null;
  return {
    provider: 'gemini',
    model,
    apiKey: env.geminiApiKey,
    defaultMaxTokens,
    defaultTimeoutMs,
  };
}

/**
 * Dynamically constructs the ordered 2-tier failover waterfall from `.env` config:
 * - fast:      Groq Fast -> Cloudflare Fast -> Gemini
 * - reasoning: Groq Reasoning Primary -> Groq Reasoning Backup -> Cloudflare Reasoning -> Gemini
 *
 * @param {'fast' | 'reasoning'} [tier='fast']
 * @returns {Array<object>}
 */
function getTierWaterfall(tier = 'fast') {
  const normalizedTier = tier === 'reasoning' ? 'reasoning' : 'fast';
  const rawList =
    normalizedTier === 'reasoning'
      ? [
          buildGroqCandidate(env.groqReasoningModel, 3072, 22000),
          buildGroqCandidate(env.groqReasoningBackupModel, 3072, 22000),
          buildCloudflareCandidate(env.cloudflareReasoningModel, 4096, 25000),
          buildGeminiCandidate(3072, 25000),
        ]
      : [
          buildGroqCandidate(env.groqFastModel, 1536, 12000),
          buildCloudflareCandidate(env.cloudflareFastModel, 1536, 18000),
          // Cross-tier overflow so TPM bursts / deprecated slots never exhaust the fast tier.
          buildGroqCandidate(env.groqReasoningBackupModel, 3072, 20000),
          buildCloudflareCandidate(env.cloudflareReasoningModel, 4096, 25000),
          buildGroqCandidate(env.groqReasoningModel, 3072, 20000),
          buildGeminiCandidate(1536, 18000),
        ];

  const deduped = [];
  const seen = new Set();
  for (const item of rawList) {
    if (!item) continue;
    const key = candidateKey(item);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push({ ...item, key });
  }

  const override = String(env.llmProviderOverride || '').trim().toLowerCase();
  if (override && ['groq', 'cloudflare', 'gemini'].includes(override)) {
    const filtered = deduped.filter((item) => item.provider === override);
    if (filtered.length > 0) {
      return filtered;
    }
  }

  return deduped;
}

function isValidJsonText(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return false;
  try {
    JSON.parse(raw);
    return true;
  } catch {
    return false;
  }
}

async function executeCandidateCall(candidate, params) {
  const invokeOpenAI =
    adapterOverrides?.callOpenAICompatible || callOpenAICompatible;
  const invokeGemini =
    adapterOverrides?.callGeminiFallback || callGeminiFallback;

  const effectiveMaxTokens =
    Number.isFinite(Number(params.maxTokens)) && Number(params.maxTokens) > 0
      ? Math.round(Number(params.maxTokens))
      : candidate.defaultMaxTokens;
  const effectiveTimeoutMs =
    Number.isFinite(Number(params.timeoutMs)) && Number(params.timeoutMs) > 0
      ? Math.round(Number(params.timeoutMs))
      : candidate.defaultTimeoutMs;

  if (candidate.provider === 'gemini') {
    return invokeGemini({
      model: candidate.model,
      apiKey: candidate.apiKey,
      systemPrompt: params.systemPrompt,
      userPrompt: params.userPrompt,
      expectJson: params.expectJson,
      jsonSchema: params.jsonSchema,
      temperature: params.temperature,
      maxTokens: effectiveMaxTokens,
      timeoutMs: effectiveTimeoutMs,
      thinkingBudget: params.thinkingBudget,
    });
  }

  return invokeOpenAI({
    provider: candidate.provider,
    baseUrl: candidate.baseUrl,
    apiKey: candidate.apiKey,
    model: candidate.model,
    systemPrompt: params.systemPrompt,
    userPrompt: params.userPrompt,
    expectJson: params.expectJson,
    // Non-Gemini endpoints have no native responseSchema: fall back to a Zod-derived hint.
    jsonSchema: params.jsonSchema || params.schemaHint || null,
    temperature: params.temperature,
    maxTokens: effectiveMaxTokens,
    timeoutMs: effectiveTimeoutMs,
  });
}

function recordCandidateFailure(key, err) {
  const status = err?.upstreamStatus;
  const code = err?.code;
  if (status === 429 || code === 'RATE_LIMITED') {
    modelHealthRegistry.markRateLimited(key, err?.retryAfterMs);
    return;
  }
  if (
    status === 401 ||
    status === 403 ||
    status === 404 ||
    status === 410 ||
    code === 'AUTH_OR_CONFIG_ERROR'
  ) {
    modelHealthRegistry.markAuthOrConfigFailure(key, status, err?.message);
    return;
  }
  modelHealthRegistry.markTransientFailure(key, status || code, err?.message);
}

/**
 * Multi-provider 2-tier LLM Gateway executing:
 * Groq -> Cloudflare Workers AI -> Google Gemini with automatic circuit breaking,
 * cooldown management, KV-cache friendly prompt ordering, and rolling diagnostics.
 *
 * @param {object} params
 * @returns {Promise<{
 *   text: string,
 *   provider: string,
 *   model: string,
 *   candidateKey: string,
 *   tier: string,
 *   fallbackUsed: boolean,
 *   attemptedCandidates: Array<{ key: string, status: string, reason?: string }>,
 *   usage: { inputTokens: number, outputTokens: number, cachedTokens: number },
 *   durationMs: number
 * }>}
 */
async function invokeLLM({
  tier = 'fast',
  systemPrompt = '',
  userPrompt = '',
  expectJson = false,
  jsonSchema = null,
  temperature = 0.1,
  maxTokens = null,
  operationName = 'llm_call',
  timeoutMs = null,
  thinkingBudget = null,
  excludeCandidates = [],
  schemaHint = null,
}) {
  const normalizedTier = tier === 'reasoning' ? 'reasoning' : 'fast';
  const baseWaterfall = getTierWaterfall(normalizedTier);
  const excludeSet = new Set(
    Array.isArray(excludeCandidates) ? excludeCandidates.filter(Boolean) : []
  );
  const eligible = baseWaterfall.filter((c) => !excludeSet.has(c.key));
  const waterfall = eligible.length > 0 ? eligible : baseWaterfall;

  if (waterfall.length === 0) {
    throw new AppError(
      'No LLM providers are configured. Set GROQ_API_KEY, CLOUDFLARE_API_KEY, or GEMINI_API_KEY in .env.',
      500
    );
  }

  const available = waterfall.filter((c) => modelHealthRegistry.isAvailable(c.key));
  const coolingDown = waterfall.filter(
    (c) => !modelHealthRegistry.isAvailable(c.key)
  );

  let orderedCandidates;
  let skippedCooldownCount = coolingDown.length;
  if (available.length > 0) {
    // Only try healthy candidates while any are healthy; fall back to earliest cooling-down
    // candidate if all healthy candidates fail in this call.
    const sortedCool = [...coolingDown].sort(
      (a, b) =>
        modelHealthRegistry.getCooldownUntil(a.key) -
        modelHealthRegistry.getCooldownUntil(b.key)
    );
    orderedCandidates = [...available, ...sortedCool];
  } else {
    // Deadlock guard: every model is cooling down; order by earliest cooldown expiry.
    orderedCandidates = [...coolingDown].sort(
      (a, b) =>
        modelHealthRegistry.getCooldownUntil(a.key) -
        modelHealthRegistry.getCooldownUntil(b.key)
    );
    skippedCooldownCount = 0;
  }

  const attemptedCandidates = [];
  let lastError = null;

  for (let i = 0; i < orderedCandidates.length; i += 1) {
    const candidate = orderedCandidates[i];
    const callStart = Date.now();
    try {
      const response = await executeCandidateCall(candidate, {
        systemPrompt,
        userPrompt,
        expectJson,
        jsonSchema,
        temperature,
        maxTokens,
        timeoutMs,
        thinkingBudget,
        schemaHint,
      });

      const text = String(response?.text ?? '').trim();
      if (!text) {
        const emptyErr = new AppError(
          `[${candidate.key}] Returned an empty response.`,
          502
        );
        emptyErr.code = 'INVALID_JSON_OUTPUT';
        emptyErr.provider = candidate.provider;
        emptyErr.model = candidate.model;
        emptyErr.retryable = true;
        throw emptyErr;
      }

      if (expectJson && !isValidJsonText(text)) {
        const jsonErr = new AppError(
          `[${candidate.key}] Returned non-JSON output when expectJson=true.`,
          502
        );
        jsonErr.code = 'INVALID_JSON_OUTPUT';
        jsonErr.provider = candidate.provider;
        jsonErr.model = candidate.model;
        jsonErr.retryable = true;
        throw jsonErr;
      }

      modelHealthRegistry.markSuccess(candidate.key);
      attemptedCandidates.push({ key: candidate.key, status: 'ok' });

      const durationMs = Date.now() - callStart;
      const usage = {
        inputTokens: Number(response?.usage?.inputTokens) || 0,
        outputTokens: Number(response?.usage?.outputTokens) || 0,
        cachedTokens: Number(response?.usage?.cachedTokens) || 0,
      };
      const primaryKey = waterfall[0]?.key || candidate.key;
      const fallbackUsed =
        candidate.key !== primaryKey ||
        i > 0 ||
        (available.length > 0 && skippedCooldownCount > 0 && i === 0 && candidate.key !== primaryKey);

      console.info(
        `[LLMGateway] op=${operationName} tier=${normalizedTier} provider=${candidate.provider} model=${candidate.model} fallback=${fallbackUsed} in=${usage.inputTokens} cached=${usage.cachedTokens} out=${usage.outputTokens} ms=${durationMs}`
      );

      recordDiagnostic({
        operationName,
        tier: normalizedTier,
        provider: candidate.provider,
        model: candidate.model,
        fallbackUsed,
        attemptedCandidates: attemptedCandidates.map((a) => `${a.key}:${a.status}`),
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cachedTokens: usage.cachedTokens,
        durationMs,
        status: 'ok',
      });

      return {
        text,
        provider: candidate.provider,
        model: candidate.model,
        candidateKey: candidate.key,
        tier: normalizedTier,
        fallbackUsed,
        attemptedCandidates,
        usage,
        durationMs,
      };
    } catch (err) {
      lastError = err;
      recordCandidateFailure(candidate.key, err);
      const reason = String(err?.code || err?.upstreamStatus || err?.message || 'error');
      attemptedCandidates.push({
        key: candidate.key,
        status: 'failed',
        reason: String(err?.message || reason).slice(0, 180),
      });

      const nextCandidate = orderedCandidates[i + 1];
      console.warn(
        `[LLMGateway][Failover] op=${operationName} tier=${normalizedTier} failed=${candidate.key} reason=${reason} next=${nextCandidate ? nextCandidate.key : 'none'}`
      );
    }
  }

  recordDiagnostic({
    operationName,
    tier: normalizedTier,
    provider: 'none',
    model: 'none',
    fallbackUsed: true,
    attemptedCandidates: attemptedCandidates.map((a) => `${a.key}:${a.status}`),
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    durationMs: 0,
    status: 'exhausted',
    error: String(lastError?.message || 'All providers exhausted').slice(0, 200),
  });

  const exhaustedErr = new AppError(
    `All configured LLM providers failed for operation "${operationName}" (${normalizedTier} tier). Last error: ${lastError?.message || 'unknown error'}`,
    503
  );
  exhaustedErr.code = 'LLM_GATEWAY_EXHAUSTED';
  exhaustedErr.attemptedCandidates = attemptedCandidates;
  throw exhaustedErr;
}

module.exports = {
  invokeLLM,
  getTierWaterfall,
  getGatewayHealthSnapshot,
  resetGatewayHealth,
  getRecentLLMDiagnostics,
  clearRecentLLMDiagnostics,
  setAdapterOverrides,
};
