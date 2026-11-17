const env = require('../config/env');
const AppError = require('../utils/AppError');

const GEMINI_API_BASE_URL =
  'https://generativelanguage.googleapis.com/v1beta/models';

const SUPPORT_RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    category: {
      type: 'STRING',
      description: 'Classification category of the customer message',
    },
    suggestions: {
      type: 'ARRAY',
      description:
        'Singular reply suggestion array containing exactly 1 polite, concise suggested response for a human support agent',
      items: { type: 'STRING' },
    },
    missing_information: {
      type: 'ARRAY',
      description:
        'Any important information unavailable from the supplied context',
      items: { type: 'STRING' },
    },
  },
  required: ['category', 'suggestions', 'missing_information'],
};

const ANNOUNCEMENT_DRAFT_SCHEMA = {
  type: 'OBJECT',
  properties: {
    subject: {
      type: 'STRING',
      description: 'Concise, professional email subject line',
    },
    body: {
      type: 'STRING',
      description:
        'Professional email body personalized with {{customer_name}}',
    },
  },
  required: ['subject', 'body'],
};

let customGenerator = null;
let customAnnouncementGenerator = null;
let customSheetGenerator = null;
let customWorkspaceGenerator = null;

/**
 * Allows overriding the customer-support Gemini generator function (e.g. for offline unit testing).
 *
 * @param {Function | null} fn
 */
function setGeminiGenerator(fn) {
  customGenerator = fn;
}

/**
 * Allows overriding the announcement Gemini generator function (e.g. for offline unit testing).
 *
 * @param {Function | null} fn
 */
function setAnnouncementGeminiGenerator(fn) {
  customAnnouncementGenerator = fn;
}

/**
 * Allows overriding the sheet natural-language query generator function (e.g. for offline unit testing).
 *
 * @param {Function | null} fn
 */
function setSheetGeminiGenerator(fn) {
  customSheetGenerator = fn;
}

function hasCustomSheetGeminiGenerator() {
  return typeof customSheetGenerator === 'function';
}

/**
 * Allows overriding the workspace multi-hop RAG / Socratic generator function (e.g. for offline unit testing).
 *
 * @param {Function | null} fn
 */
function setWorkspaceGeminiGenerator(fn) {
  customWorkspaceGenerator = fn;
}

/**
 * Returns true when an explicit workspace Gemini test stub has been registered.
 *
 * @returns {boolean}
 */
function hasCustomWorkspaceGeminiGenerator() {
  return typeof customWorkspaceGenerator === 'function';
}

function parseJsonFromGemini(rawOutput) {
  if (rawOutput && typeof rawOutput === 'object') {
    return rawOutput;
  }

  if (typeof rawOutput === 'string') {
    const cleaned = rawOutput
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim();
    try {
      return JSON.parse(cleaned);
    } catch {
      throw new AppError(
        'Failed to parse JSON response from Gemini AI Studio.',
        502
      );
    }
  }

  throw new AppError(
    'Invalid response payload returned by Gemini AI Studio.',
    502
  );
}

/**
 * Validates and normalizes the raw JSON response from Gemini for customer support so that it
 * strictly conforms to the predefined rules and guarantees a singular suggestion.
 *
 * @param {string | object} rawOutput
 * @returns {{ category: string, suggestions: string[], missing_information: string[] }}
 */
function normalizeAndValidateAiResponse(rawOutput) {
  const parsed = parseJsonFromGemini(rawOutput);

  const category =
    typeof parsed.category === 'string' && parsed.category.trim()
      ? parsed.category.trim()
      : 'general_inquiry';

  let rawSuggestions = [];
  if (Array.isArray(parsed.suggestions)) {
    rawSuggestions = parsed.suggestions;
  } else if (typeof parsed.suggestion === 'string') {
    rawSuggestions = [parsed.suggestion];
  } else if (typeof parsed.suggestions === 'string') {
    rawSuggestions = [parsed.suggestions];
  }

  const validSuggestions = rawSuggestions
    .filter((item) => typeof item === 'string' && item.trim().length > 0)
    .map((item) => item.trim());

  if (validSuggestions.length === 0) {
    throw new AppError(
      'Gemini AI Studio returned an empty suggestions array.',
      502
    );
  }

  // Enforce singular suggestion rule: always keep exactly 1 suggestion
  const singularSuggestions = [validSuggestions[0]];

  const missingInformation = Array.isArray(parsed.missing_information)
    ? parsed.missing_information
        .filter((item) => typeof item === 'string' && item.trim().length > 0)
        .map((item) => item.trim())
    : [];

  return {
    category,
    suggestions: singularSuggestions,
    missing_information: missingInformation,
  };
}

/**
 * Validates and normalizes the raw JSON response from Gemini for email announcement drafting.
 * Ensures both subject and body are non-empty and that {{customer_name}} is included.
 *
 * @param {string | object} rawOutput
 * @returns {{ subject: string, body: string }}
 */
function normalizeAndValidateAnnouncementDraft(rawOutput) {
  const parsed = parseJsonFromGemini(rawOutput);

  const rawSubject =
    typeof parsed.subject === 'string'
      ? parsed.subject.replace(/[\r\n]+/g, ' ').trim()
      : '';
  let rawBody = typeof parsed.body === 'string' ? parsed.body.trim() : '';

  if (!rawSubject) {
    throw new AppError(
      'Gemini AI Studio returned an empty announcement subject.',
      502
    );
  }

  if (!rawBody) {
    throw new AppError(
      'Gemini AI Studio returned an empty announcement body.',
      502
    );
  }

  // Ensure the exact {{customer_name}} placeholder is present
  if (!/\{\{\s*customer_name\s*\}\}/.test(rawBody)) {
    rawBody = `Hello {{customer_name}},\n\n${rawBody}`;
  } else {
    rawBody = rawBody.replace(/\{\{\s*customer_name\s*\}\}/g, '{{customer_name}}');
  }

  return {
    subject: rawSubject.slice(0, 255),
    body: rawBody,
    audience_targeting:
      parsed.audience_targeting && typeof parsed.audience_targeting === 'object'
        ? parsed.audience_targeting
        : null,
  };
}

/**
 * Calls a single Gemini model endpoint via Google AI Studio REST API with a specified schema.
 *
 * @param {string} modelName
 * @param {string} apiKey
 * @param {string} promptText
 * @param {object} responseSchema
 * @returns {Promise<string>}
 */
async function callGeminiModelWithSchema(
  modelName,
  apiKey,
  promptText,
  responseSchema,
  options = {}
) {
  const normalizedModel = modelName.replace(/^models\//, '');
  const url = `${GEMINI_API_BASE_URL}/${normalizedModel}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const generationConfig = {
    temperature: 0.1,
    responseMimeType: 'application/json',
  };
  if (responseSchema) {
    generationConfig.responseSchema = responseSchema;
  }
  const isLiteModel = normalizedModel.toLowerCase().includes('lite');
  const thinkingBudget = Number.isInteger(options?.thinkingBudget)
    ? options.thinkingBudget
    : 0;
  const timeoutMs =
    Number.isFinite(Number(options?.timeoutMs)) && Number(options.timeoutMs) > 0
      ? Number(options.timeoutMs)
      : 25000;
  if (!isLiteModel && thinkingBudget >= 0) {
    generationConfig.thinkingConfig = { thinkingBudget };
  }

  const requestBody = JSON.stringify({
    contents: [
      {
        role: 'user',
        parts: [{ text: promptText }],
      },
    ],
    generationConfig,
  });
  const requestStartedAt = Date.now();
  let response = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: requestBody,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      // Retry instant socket/network glitches once on the same model,
      // but let timeouts fall straight through to model fallback without doubling wait time.
      if (attempt === 0 && error instanceof TypeError) {
        await new Promise((resolve) => setTimeout(resolve, 350));
        continue;
      }
      const message =
        error?.name === 'TimeoutError' || error?.name === 'AbortError'
          ? `Gemini request timed out after ${Math.round(timeoutMs / 1000)} seconds.`
          : `Gemini network request failed: ${error?.message || 'unknown network error'}`;
      const networkError = new AppError(message, 502);
      networkError.code = error?.name === 'TimeoutError' || error?.name === 'AbortError'
        ? 'GEMINI_TIMEOUT'
        : 'GEMINI_NETWORK_ERROR';
      throw networkError;
    }
    break;
  }

  let data;
  try {
    data = await response.json();
  } catch (error) {
    if (error?.name === 'AbortError' || error?.name === 'TimeoutError') {
      const timeoutError = new AppError('Gemini request timed out after 25 seconds.', 502);
      timeoutError.code = 'GEMINI_TIMEOUT';
      throw timeoutError;
    }
    data = null;
  }

  if (!response.ok) {
    const apiErrMessage =
      data && data.error && data.error.message
        ? data.error.message
        : `Gemini API request failed with status ${response.status}`;
    const err = new AppError(`Gemini AI error: ${apiErrMessage}`, 502);
    err.upstreamStatus = response.status;
    throw err;
  }

  const promptTokenCount = data?.usageMetadata?.promptTokenCount;
  const candidatesTokenCount = data?.usageMetadata?.candidatesTokenCount ?? 0;
  const thoughtsTokenCount = data?.usageMetadata?.thoughtsTokenCount ?? 0;
  if (Number.isFinite(promptTokenCount)) {
    console.info(
      `[Gemini] model=${normalizedModel} prompt_tokens=${promptTokenCount} output_tokens=${candidatesTokenCount} thoughts_tokens=${thoughtsTokenCount} duration_ms=${Date.now() - requestStartedAt}`
    );
  } else {
    console.info(
      `[Gemini] model=${normalizedModel} prompt_tokens=unavailable duration_ms=${Date.now() - requestStartedAt}`
    );
  }

  const parts = data?.candidates?.[0]?.content?.parts || [];
  const textPart = parts.find(
    (part) => typeof part.text === 'string' && !part.thought
  );
  const rawText = textPart ? textPart.text : parts[0]?.text;

  if (!rawText) {
    throw new AppError(
      'Gemini AI Studio returned no content candidates.',
      502
    );
  }

  return rawText;
}

const unavailableModels = new Set();
const modelCooldownUntil = new Map();
const FAST_STAGE_SET = new Set([
  'intent_routing',
  'cross_source_read_plan',
  'cross_source_read_synthesis',
]);

function buildCandidateModelsForStage(stage, preferredModel) {
  const fullCandidates = [
    preferredModel || 'gemini-3.5-flash',
    'gemini-3.5-flash',
  ];
  // Prioritize fast yet high-accuracy 3.5-flash-lite first on lightweight stages,
  // falling back to 3.5-flash -> 3.1-flash-lite before 3.8-flash (which often 503s slowly).
  const ordered = FAST_STAGE_SET.has(stage)
    ? ['gemini-3.5-flash-lite', ...fullCandidates, 'gemini-3.1-flash-lite', 'gemini-3.8-flash']
    : [...fullCandidates, 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-3.8-flash'];
  return Array.from(new Set(ordered)).filter((m) => !unavailableModels.has(m));
}

/**
 * Executes a prompt against the configured Gemini model with automatic fallback on transient errors.
 *
 * @param {string} promptText
 * @param {object} responseSchema
 * @returns {Promise<string>}
 */
async function executeGeminiWithFallback(promptText, responseSchema, options = {}) {
  const apiKey = env.geminiApiKey;
  if (!apiKey) {
    throw new AppError(
      'Gemini API configuration error: GEMINI_API_KEY is not set in environment variables.',
      500
    );
  }

  const allCandidates = buildCandidateModelsForStage(options?.stage, env.geminiModel);

  const now = Date.now();
  const readyCandidates = allCandidates.filter(
    (m) => (modelCooldownUntil.get(m) || 0) <= now
  );
  // Try ready models first; if all ready models fail transiently and other non-429 cooled models exist,
  // allow one safety-net pass through cooled-down models before failing the user request.
  const cooledNonRateLimited = allCandidates.filter(
    (m) =>
      !readyCandidates.includes(m) &&
      (modelCooldownUntil.get(m) || 0) - now <= 20000
  );
  const candidateModels =
    readyCandidates.length > 0
      ? [...readyCandidates, ...cooledNonRateLimited]
      : allCandidates;

  let lastError = null;
  for (const modelName of candidateModels) {
    try {
      return await callGeminiModelWithSchema(
        modelName,
        apiKey,
        promptText,
        responseSchema,
        options
      );
    } catch (error) {
      lastError = error;
      if (error.upstreamStatus === 404) {
        unavailableModels.add(modelName);
        continue;
      }
      if (
        error.upstreamStatus === 503 ||
        error.upstreamStatus === 429 ||
        error.code === 'GEMINI_TIMEOUT'
      ) {
        const cooldownMs = error.upstreamStatus === 429 ? 45000 : 15000;
        modelCooldownUntil.set(modelName, Date.now() + cooldownMs);
        continue;
      }
      throw error;
    }
  }

  throw lastError;
}

/**
 * Sends the constructed contextual customer-support prompt to Google AI Studio (Gemini)
 * and returns the validated, singular JSON response.
 *
 * @param {string} promptText
 * @returns {Promise<{ category: string, suggestions: string[], missing_information: string[] }>}
 */
async function generateAiSupportResponse(promptText) {
  if (typeof customGenerator === 'function') {
    const customOutput = await customGenerator(promptText);
    return normalizeAndValidateAiResponse(customOutput);
  }

  const rawText = await executeGeminiWithFallback(
    promptText,
    SUPPORT_RESPONSE_SCHEMA
  );
  return normalizeAndValidateAiResponse(rawText);
}

/**
 * Sends the constructed announcement-drafting prompt to Google AI Studio (Gemini)
 * and returns the validated { subject, body } draft.
 *
 * @param {string} promptText
 * @returns {Promise<{ subject: string, body: string }>}
 */
async function generateAiAnnouncementDraft(promptText) {
  if (typeof customAnnouncementGenerator === 'function') {
    const customOutput = await customAnnouncementGenerator(promptText);
    return normalizeAndValidateAnnouncementDraft(customOutput);
  }

  const rawText = await executeGeminiWithFallback(promptText, null);
  return normalizeAndValidateAnnouncementDraft(rawText);
}

/**
 * Sends the natural-language sheet query interpretation prompt to Google AI Studio (Gemini)
 * and returns the parsed JSON object.
 *
 * @param {string} promptText
 * @param {object | null} [responseSchema=null]
 * @returns {Promise<object>}
 */
async function generateAiSheetInterpretation(promptText, responseSchema = null) {
  if (typeof customSheetGenerator === 'function') {
    const customOutput = await customSheetGenerator(promptText);
    return parseJsonFromGemini(customOutput);
  }

  const rawText = await executeGeminiWithFallback(promptText, responseSchema);
  return parseJsonFromGemini(rawText);
}

/**
 * Generates structured JSON output from Gemini with strict schema validation
 * and automatic self-correction retry (default max 2 retries).
 *
 * @param {string} promptText
 * @param {(parsed: object) => object} [validatorFn]
 * @param {object} [options]
 * @param {number} [options.maxRetries=2]
 * @param {object | null} [options.responseSchema=null]
 * @returns {Promise<object>}
 */
async function generateStructuredJsonWithRetry(
  promptText,
  validatorFn = null,
  options = {}
) {
  const maxRetries = Number.isInteger(options.maxRetries)
    ? Math.max(0, options.maxRetries)
    : 2;
  const responseSchema = options.responseSchema || null;
  const stage = String(options.stage || 'default');
  const defaultThinkingBudget =
    stage === 'socratic_analysis' || stage === 'preview_compilation' ? 256 : 0;
  const thinkingBudget = Number.isInteger(options.thinkingBudget)
    ? options.thinkingBudget
    : defaultThinkingBudget;
  const timeoutMs =
    Number.isFinite(Number(options.timeoutMs)) && Number(options.timeoutMs) > 0
      ? Number(options.timeoutMs)
      : FAST_STAGE_SET.has(stage)
        ? 8500
        : 25000;

  let currentPrompt = String(promptText ?? '');
  let lastValidationError = null;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      let rawOutput;
      if (typeof customWorkspaceGenerator === 'function') {
        rawOutput = await customWorkspaceGenerator(currentPrompt, {
          attempt,
          responseSchema,
          stage,
        });
      } else {
        rawOutput = await executeGeminiWithFallback(
          currentPrompt,
          responseSchema,
          { thinkingBudget, stage, timeoutMs }
        );
      }

      const parsed = parseJsonFromGemini(rawOutput);
      if (typeof validatorFn === 'function') {
        return validatorFn(parsed);
      }
      return parsed;
    } catch (error) {
      lastValidationError = error;
      const isTransportFailure = Boolean(
        error?.upstreamStatus ||
          error?.code === 'GEMINI_TIMEOUT' ||
          error?.code === 'GEMINI_NETWORK_ERROR'
      );
      if (isTransportFailure || attempt >= maxRetries) {
        break;
      }

      const errorMessage =
        error && error.message ? error.message : 'Invalid JSON structure';
      currentPrompt = `${promptText}\n\n[SELF-CORRECTION RETRY ${attempt + 1}/${maxRetries}]\nYour previous output failed validation with the following error: "${errorMessage}".\nPlease fix the JSON output immediately and return ONLY a valid JSON object matching the required schema.`;
    }
  }

  throw lastValidationError;
}

module.exports = {
  setGeminiGenerator,
  setAnnouncementGeminiGenerator,
  setSheetGeminiGenerator,
  hasCustomSheetGeminiGenerator,
  setWorkspaceGeminiGenerator,
  hasCustomWorkspaceGeminiGenerator,
  callGeminiModelWithSchema,
  parseJsonFromGemini,
  normalizeAndValidateAiResponse,
  normalizeAndValidateAnnouncementDraft,
  generateAiSupportResponse,
  generateAiAnnouncementDraft,
  generateAiSheetInterpretation,
  generateStructuredJsonWithRetry,
};
