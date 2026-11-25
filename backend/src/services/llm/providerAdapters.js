const env = require('../../config/env');
const AppError = require('../../utils/AppError');
const { callGeminiModelWithMetadata } = require('./geminiService');

/**
 * Strips `<think>...</think>` blocks and markdown code fences.
 * When `expectJson` is true, isolates the JSON object/array substring if wrapped in prose.
 *
 * @param {string} rawText
 * @param {boolean} [expectJson=false]
 * @returns {string}
 */
function sanitizeModelOutputText(rawText, expectJson = false) {
  let cleaned = String(rawText ?? '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .trim();

  cleaned = cleaned
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  if (!expectJson || !cleaned) {
    return cleaned;
  }

  try {
    JSON.parse(cleaned);
    return cleaned;
  } catch {
    const firstBrace = cleaned.indexOf('{');
    const lastBrace = cleaned.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      const candidate = cleaned.slice(firstBrace, lastBrace + 1);
      try {
        JSON.parse(candidate);
        return candidate;
      } catch {
        // Fall through
      }
    }

    const firstBracket = cleaned.indexOf('[');
    const lastBracket = cleaned.lastIndexOf(']');
    if (firstBracket !== -1 && lastBracket > firstBracket) {
      const candidate = cleaned.slice(firstBracket, lastBracket + 1);
      try {
        JSON.parse(candidate);
        return candidate;
      } catch {
        // Fall through
      }
    }
    return cleaned;
  }
}

/**
 * Extracts assistant text across OpenAI-compatible string or content-part arrays,
 * falling back cleanly to `reasoning_content` / `text` only when `content` is empty.
 *
 * @param {object | null | undefined} choice
 * @returns {string}
 */
function extractAssistantText(choice) {
  const content = choice?.message?.content;
  if (typeof content === 'string' && content.trim().length > 0) {
    return content;
  }

  if (Array.isArray(content)) {
    const joined = content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part.text === 'string') return part.text;
        return '';
      })
      .filter(Boolean)
      .join('\n')
      .trim();
    if (joined) {
      return joined;
    }
  }

  const reasoningContent = choice?.message?.reasoning_content;
  if (typeof reasoningContent === 'string' && reasoningContent.trim().length > 0) {
    const strippedReasoning = reasoningContent
      .replace(/<think>[\s\S]*?<\/think>/gi, '')
      .trim();
    // Only trust reasoning_content when it contains a parseable JSON payload (never prose).
    if (strippedReasoning) {
      const first = strippedReasoning.indexOf('{');
      const last = strippedReasoning.lastIndexOf('}');
      if (first !== -1 && last > first) {
        const candidate = strippedReasoning.slice(first, last + 1);
        try {
          JSON.parse(candidate);
          return candidate;
        } catch {
          // not JSON; ignore
        }
      }
    }
  }

  if (typeof choice?.text === 'string' && choice.text.trim().length > 0) {
    return choice.text;
  }

  return typeof content === 'string' ? content : '';
}

function parseDurationTokenMs(rawValue) {
  if (rawValue === undefined || rawValue === null) return null;
  const trimmed = String(rawValue).trim();
  if (!trimmed) return null;

  if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
    return Math.round(Number(trimmed) * 1000);
  }

  let totalMs = 0;
  let matched = false;
  const regex = /(\d+(?:\.\d+)?)\s*(ms|s|m|h)/gi;
  let m;
  while ((m = regex.exec(trimmed)) !== null) {
    matched = true;
    const num = Number(m[1]);
    const unit = m[2].toLowerCase();
    if (unit === 'ms') totalMs += num;
    else if (unit === 's') totalMs += num * 1000;
    else if (unit === 'm') totalMs += num * 60000;
    else if (unit === 'h') totalMs += num * 3600000;
  }
  if (matched && Number.isFinite(totalMs) && totalMs > 0) {
    return Math.round(totalMs);
  }

  const parsedDate = Date.parse(trimmed);
  if (Number.isFinite(parsedDate)) {
    const delta = parsedDate - Date.now();
    if (delta > 0) return Math.round(delta);
  }

  return null;
}

/**
 * Parses `retry-after`, `x-ratelimit-reset-requests`, or `x-ratelimit-reset-tokens` headers.
 * Clamped to [1000, 300000] ms.
 *
 * @param {Headers | Record<string, string> | null | undefined} headers
 * @param {number} [defaultMs]
 * @returns {number}
 */
function parseRetryAfterMs(headers, defaultMs = env.llmDefaultCooldownMs || 60000) {
  const getHeader = (name) => {
    if (!headers) return null;
    if (typeof headers.get === 'function') {
      return headers.get(name);
    }
    const lower = name.toLowerCase();
    for (const [k, v] of Object.entries(headers)) {
      if (k.toLowerCase() === lower) return v;
    }
    return null;
  };

  const candidates = [
    getHeader('retry-after'),
    getHeader('x-ratelimit-reset-requests'),
    getHeader('x-ratelimit-reset-tokens'),
  ];

  for (const val of candidates) {
    const parsed = parseDurationTokenMs(val);
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.min(300000, Math.max(1000, parsed));
    }
  }

  const fallback = Number(defaultMs) || 60000;
  return Math.min(300000, Math.max(1000, fallback));
}

function buildProviderHttpError({ provider, model, status, message, headers }) {
  const retryAfterMs =
    status === 429
      ? parseRetryAfterMs(headers, env.llmDefaultCooldownMs || 60000)
      : status >= 500
        ? 20000
        : status === 401 || status === 403 || status === 404
          ? 300000
          : 15000;

  const err = new AppError(
    `[${provider}:${model}] HTTP ${status}: ${message || 'Upstream request failed'}`,
    502
  );
  err.provider = provider;
  err.model = model;
  err.upstreamStatus = status;
  err.retryAfterMs = retryAfterMs;

  if (status === 429) {
    err.code = 'RATE_LIMITED';
    err.retryable = true;
  } else if (status === 401 || status === 403 || status === 404 || status === 410) {
    err.code = 'AUTH_OR_CONFIG_ERROR';
    err.retryable = true;
    err.retryAfterMs = 300000;
  } else if (status >= 500) {
    err.code = 'UPSTREAM_SERVER_ERROR';
    err.retryable = true;
  } else {
    err.code = 'UPSTREAM_BAD_REQUEST';
    err.retryable = true;
  }

  return err;
}

function normalizeSchemaNodeForPrompt(node) {
  if (!node || typeof node !== 'object') return node;
  if (Array.isArray(node)) {
    return node.map((item) => normalizeSchemaNodeForPrompt(item));
  }
  const out = {};
  for (const [k, v] of Object.entries(node)) {
    if (k === 'type' && typeof v === 'string') {
      out.type = v.toLowerCase();
    } else if (k === 'description' && typeof v === 'string') {
      out.description = v.length > 180 ? `${v.slice(0, 177)}...` : v;
    } else if (v && typeof v === 'object') {
      out[k] = normalizeSchemaNodeForPrompt(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function formatSchemaInstructionForPrompt(jsonSchema) {
  if (!jsonSchema || typeof jsonSchema !== 'object') return '';
  try {
    const compact = JSON.stringify(normalizeSchemaNodeForPrompt(jsonSchema));
    return `\n\nSTRICT_OUTPUT_JSON_SCHEMA (you MUST follow every exact property name, nesting, array shape, enum, and required key):\n${compact}`;
  } catch {
    return '';
  }
}

function buildTransportError({ provider, model, error, timeoutMs }) {
  const isTimeout =
    error?.name === 'TimeoutError' || error?.name === 'AbortError';
  const err = new AppError(
    isTimeout
      ? `[${provider}:${model}] Request timed out after ${Math.round(timeoutMs / 1000)}s.`
      : `[${provider}:${model}] Network error: ${error?.message || 'unknown error'}`,
    502
  );
  err.provider = provider;
  err.model = model;
  err.code = isTimeout ? 'LLM_TIMEOUT' : 'LLM_NETWORK_ERROR';
  err.retryable = true;
  err.retryAfterMs = 20000;
  return err;
}

/**
 * Invokes an OpenAI-compatible `/chat/completions` endpoint (Groq, Cloudflare Workers AI).
 * Places static `systemPrompt` first to maximize KV prompt caching and sets explicit `max_tokens`.
 *
 * @param {object} params
 * @returns {Promise<{ text: string, provider: string, model: string, usage: { inputTokens: number, outputTokens: number, cachedTokens: number } }>}
 */
async function callOpenAICompatible({
  provider,
  baseUrl,
  apiKey,
  model,
  systemPrompt = '',
  userPrompt = '',
  expectJson = false,
  jsonSchema = null, // Reserved for future schema-strict endpoints; we enforce via prompt + Zod
  temperature = 0.1,
  maxTokens = 2048,
  timeoutMs = env.llmTimeoutMs || 18000,
}) {
  void jsonSchema;
  if (!baseUrl || !apiKey || !model) {
    const cfgErr = new AppError(
      `Provider "${provider}" is missing required baseUrl, apiKey, or model configuration.`,
      500
    );
    cfgErr.provider = provider;
    cfgErr.model = model || 'unconfigured';
    cfgErr.code = 'AUTH_OR_CONFIG_ERROR';
    cfgErr.upstreamStatus = 401;
    cfgErr.retryable = true;
    throw cfgErr;
  }

  const endpoint = `${String(baseUrl).replace(/\/+$/, '')}/chat/completions`;
  let effectiveSystemPrompt = String(systemPrompt || '').trim();
  const effectiveUserPrompt = String(userPrompt || '').trim();

  if (expectJson && jsonSchema && typeof jsonSchema === 'object') {
    const schemaInstruction = formatSchemaInstructionForPrompt(jsonSchema);
    if (schemaInstruction) {
      effectiveSystemPrompt = `${effectiveSystemPrompt}${schemaInstruction}`.trim();
    }
  }

  // Groq & OpenAI return HTTP 400 if response_format=json_object is passed without "json" in messages.
  if (
    expectJson &&
    !/json/i.test(effectiveSystemPrompt) &&
    !/json/i.test(effectiveUserPrompt)
  ) {
    effectiveSystemPrompt = effectiveSystemPrompt
      ? `${effectiveSystemPrompt}\nRespond with a valid JSON object only.`
      : 'Respond with a valid JSON object only.';
  }

  const messages = [];
  if (effectiveSystemPrompt) {
    messages.push({ role: 'system', content: effectiveSystemPrompt });
  }
  messages.push({ role: 'user', content: effectiveUserPrompt });

  const resolvedMaxTokens =
    Number.isFinite(Number(maxTokens)) && Number(maxTokens) > 0
      ? Math.round(Number(maxTokens))
      : 2048;
  const resolvedTemperature = Number.isFinite(Number(temperature))
    ? Number(temperature)
    : 0.1;
  const resolvedTimeoutMs =
    Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0
      ? Math.round(Number(timeoutMs))
      : env.llmTimeoutMs || 18000;

  let includeResponseFormat = Boolean(expectJson);
  // gpt-oss reasoning models burn max_tokens on chain-of-thought; low effort keeps answers
  // inside the budget and cuts latency/tokens. Dropped automatically if the endpoint rejects it.
  let includeReasoningEffort = /gpt-oss/i.test(String(model));

  for (let compatAttempt = 0; compatAttempt < 3; compatAttempt += 1) {
    const bodyObj = {
      model,
      messages,
      temperature: resolvedTemperature,
      max_tokens: resolvedMaxTokens,
    };
    if (includeResponseFormat) {
      bodyObj.response_format = { type: 'json_object' };
    }
    if (includeReasoningEffort) {
      bodyObj.reasoning_effort = 'low';
    }

    let response;
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(bodyObj),
        signal: AbortSignal.timeout(resolvedTimeoutMs),
      });
    } catch (networkErr) {
      throw buildTransportError({
        provider,
        model,
        error: networkErr,
        timeoutMs: resolvedTimeoutMs,
      });
    }

    let data = null;
    try {
      data = await response.json();
    } catch {
      data = null;
    }

    if (!response.ok) {
      const apiMsg =
        data?.error?.message ||
        data?.errors?.[0]?.message ||
        data?.message ||
        `Request failed with status ${response.status}`;

      if (response.status === 400 && includeReasoningEffort && /reasoning/i.test(apiMsg)) {
        includeReasoningEffort = false;
        continue;
      }
      if (
        response.status === 400 &&
        includeResponseFormat &&
        /(response_format|json_object|json_schema|not supported|unsupported|failed to generate json|json_validate_failed)/i.test(
          apiMsg
        )
      ) {
        includeResponseFormat = false;
        continue;
      }

      throw buildProviderHttpError({
        provider,
        model,
        status: response.status,
        message: apiMsg,
        headers: response.headers,
      });
    }

    const rawAssistantText = extractAssistantText(data?.choices?.[0]);
    const sanitizedText = sanitizeModelOutputText(rawAssistantText, expectJson);

    if (!sanitizedText) {
      // Some reasoning endpoints return empty content under low effort / json mode: retry same model leaner.
      if (includeReasoningEffort && compatAttempt < 2) {
        includeReasoningEffort = false;
        continue;
      }
      if (includeResponseFormat && compatAttempt < 2) {
        includeResponseFormat = false;
        continue;
      }
      const ch = data?.choices?.[0];
      const emptyErr = new AppError(
        `[${provider}:${model}] Empty content (finish_reason=${ch?.finish_reason}, reasoning_len=${String(ch?.message?.reasoning_content || ch?.message?.reasoning || '').length}, completion_tokens=${data?.usage?.completion_tokens}, max_tokens=${resolvedMaxTokens}).`,
        502
      );
      emptyErr.provider = provider;
      emptyErr.model = model;
      emptyErr.code = 'INVALID_JSON_OUTPUT';
      emptyErr.retryable = true;
      throw emptyErr;
    }
    if (data?.choices?.[0]?.finish_reason === 'length' && expectJson) {
      let complete = true;
      try {
        JSON.parse(sanitizedText);
      } catch {
        complete = false;
      }
      if (!complete) {
        const truncErr = new AppError(
          `[${provider}:${model}] Output truncated at max_tokens=${resolvedMaxTokens} before completing JSON.`,
          502
        );
        truncErr.provider = provider;
        truncErr.model = model;
        truncErr.code = 'INVALID_JSON_OUTPUT';
        truncErr.retryable = true;
        throw truncErr;
      }
    }

    const inputTokens = Number(data?.usage?.prompt_tokens) || 0;
    const outputTokens = Number(data?.usage?.completion_tokens) || 0;
    const cachedTokens =
      Number(data?.usage?.prompt_tokens_details?.cached_tokens) || 0;

    return {
      text: sanitizedText,
      provider,
      model,
      usage: {
        inputTokens,
        outputTokens,
        cachedTokens,
      },
    };
  }

  throw buildProviderHttpError({
    provider,
    model,
    status: 502,
    message: 'Exhausted OpenAI-compatible retries',
    headers: null,
  });
}

/**
 * Invokes Google Gemini as the tertiary fallback adapter.
 *
 * @param {object} params
 * @returns {Promise<{ text: string, provider: string, model: string, usage: { inputTokens: number, outputTokens: number, cachedTokens: number } }>}
 */
async function callGeminiFallback({
  model = env.geminiModel || 'gemini-3.5-flash',
  apiKey = env.geminiApiKey,
  systemPrompt = '',
  userPrompt = '',
  expectJson = false,
  jsonSchema = null,
  temperature = 0.1,
  maxTokens = 2048,
  timeoutMs = env.llmTimeoutMs || 18000,
  thinkingBudget = 0,
}) {
  if (!apiKey) {
    const cfgErr = new AppError('GEMINI_API_KEY is not configured.', 500);
    cfgErr.provider = 'gemini';
    cfgErr.model = model;
    cfgErr.code = 'AUTH_OR_CONFIG_ERROR';
    cfgErr.upstreamStatus = 401;
    cfgErr.retryable = true;
    throw cfgErr;
  }

  try {
    const result = await callGeminiModelWithMetadata(
      model,
      apiKey,
      String(userPrompt || ''),
      expectJson ? jsonSchema : null,
      {
        systemInstruction: systemPrompt,
        expectJson,
        temperature,
        maxTokens,
        timeoutMs,
        thinkingBudget: Number.isInteger(thinkingBudget) ? thinkingBudget : 0,
      }
    );

    return {
      text: sanitizeModelOutputText(result.text, expectJson),
      provider: 'gemini',
      model,
      usage: {
        inputTokens: Number(result?.usage?.inputTokens) || 0,
        outputTokens: Number(result?.usage?.outputTokens) || 0,
        cachedTokens: Number(result?.usage?.cachedTokens) || 0,
      },
    };
  } catch (err) {
    err.provider = 'gemini';
    err.model = model;
    if (err.code === 'GEMINI_TIMEOUT') {
      err.code = 'LLM_TIMEOUT';
      err.retryAfterMs = 20000;
    } else if (err.code === 'GEMINI_NETWORK_ERROR') {
      err.code = 'LLM_NETWORK_ERROR';
      err.retryAfterMs = 20000;
    } else if (err.upstreamStatus === 429) {
      err.code = 'RATE_LIMITED';
      err.retryAfterMs = 45000;
    } else if ([401, 403, 404, 410].includes(err.upstreamStatus)) {
      err.code = 'AUTH_OR_CONFIG_ERROR';
      err.retryAfterMs = 300000;
    } else {
      err.retryAfterMs = 20000;
    }
    err.retryable = true;
    throw err;
  }
}

/**
 * In-memory per-model circuit breaker tracking cooldowns, consecutive failures,
 * and deadlock prevention when all candidates are cooling down.
 */
class ModelHealthRegistry {
  constructor() {
    this.states = new Map();
  }

  _ensure(key) {
    if (!this.states.has(key)) {
      this.states.set(key, {
        cooldownUntil: 0,
        consecutiveFailures: 0,
        lastStatus: null,
        lastError: null,
        lastSuccessAt: null,
        totalRequests: 0,
        totalFailures: 0,
      });
    }
    return this.states.get(key);
  }

  isAvailable(key) {
    const entry = this.states.get(key);
    if (!entry) return true;
    return Date.now() >= entry.cooldownUntil;
  }

  markRateLimited(key, retryAfterMs) {
    const entry = this._ensure(key);
    const ms = Math.min(
      300000,
      Math.max(1000, Number(retryAfterMs) || env.llmDefaultCooldownMs || 60000)
    );
    entry.cooldownUntil = Date.now() + ms;
    entry.consecutiveFailures += 1;
    entry.totalRequests += 1;
    entry.totalFailures += 1;
    entry.lastStatus = 429;
    entry.lastError = `Rate limited (${ms}ms cooldown)`;
  }

  markTransientFailure(key, status, message) {
    const entry = this._ensure(key);
    entry.cooldownUntil = Date.now() + 20000;
    entry.consecutiveFailures += 1;
    entry.totalRequests += 1;
    entry.totalFailures += 1;
    entry.lastStatus = status || 'TRANSIENT';
    entry.lastError = String(message || 'Transient upstream error').slice(0, 240);
  }

  markAuthOrConfigFailure(key, status, message) {
    const entry = this._ensure(key);
    entry.cooldownUntil = Date.now() + (status === 410 ? 1800000 : 300000);
    entry.consecutiveFailures += 1;
    entry.totalRequests += 1;
    entry.totalFailures += 1;
    entry.lastStatus = status || 401;
    entry.lastError = String(message || 'Auth or model configuration error').slice(0, 240);
  }

  markSuccess(key) {
    const entry = this._ensure(key);
    entry.cooldownUntil = 0;
    entry.consecutiveFailures = 0;
    entry.totalRequests += 1;
    entry.lastStatus = 200;
    entry.lastError = null;
    entry.lastSuccessAt = new Date().toISOString();
  }

  /**
   * Deadlock guard: when all candidates are in cooldown, returns candidates sorted
   * by earliest cooldown expiry ascending so requests still attempt the freshest one.
   *
   * @param {string[]} keys
   * @returns {string | null}
   */
  getEarliestCooldownCandidate(keys = []) {
    if (!Array.isArray(keys) || keys.length === 0) return null;
    const sorted = [...keys].sort((a, b) => {
      const aUntil = this.states.get(a)?.cooldownUntil || 0;
      const bUntil = this.states.get(b)?.cooldownUntil || 0;
      return aUntil - bUntil;
    });
    return sorted[0] || null;
  }

  getCooldownUntil(key) {
    return this.states.get(key)?.cooldownUntil || 0;
  }

  getGatewayHealthSnapshot() {
    const now = Date.now();
    const snapshot = {};
    for (const [key, entry] of this.states.entries()) {
      snapshot[key] = {
        ...entry,
        available: now >= entry.cooldownUntil,
        remainingCooldownMs: Math.max(0, entry.cooldownUntil - now),
      };
    }
    return snapshot;
  }

  resetGatewayHealth() {
    this.states.clear();
  }
}

const modelHealthRegistry = new ModelHealthRegistry();

module.exports = {
  sanitizeModelOutputText,
  extractAssistantText,
  parseRetryAfterMs,
  callOpenAICompatible,
  callGeminiFallback,
  ModelHealthRegistry,
  modelHealthRegistry,
  getGatewayHealthSnapshot: () => modelHealthRegistry.getGatewayHealthSnapshot(),
  resetGatewayHealth: () => modelHealthRegistry.resetGatewayHealth(),
};
