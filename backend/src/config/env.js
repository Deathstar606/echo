const path = require('node:path');
const fs = require('node:fs');
const dotenv = require('dotenv');

// Load .env from backend root regardless of current working directory
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

function parseBoolean(value, defaultValue = false) {
  if (value === undefined || value === null || value === '') {
    return defaultValue;
  }
  const normalized = String(value).trim().toLowerCase();
  if (['true', '1', 'yes', 'on', 'require'].includes(normalized)) {
    return true;
  }
  if (['false', '0', 'no', 'off', 'disable'].includes(normalized)) {
    return false;
  }
  return defaultValue;
}

function parsePositiveInt(value, defaultValue) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultValue;
}

function buildSslConfig() {
  const sslEnabled = parseBoolean(process.env.DB_SSL, false);
  if (!sslEnabled) {
    return false;
  }

  const rejectUnauthorized = parseBoolean(
    process.env.DB_SSL_REJECT_UNAUTHORIZED,
    false
  );

  const sslConfig = { rejectUnauthorized };

  const caPath = process.env.DB_SSL_CA_PATH
    ? process.env.DB_SSL_CA_PATH.trim()
    : '';
  if (caPath) {
    const resolvedCaPath = path.resolve(process.cwd(), caPath);
    if (fs.existsSync(resolvedCaPath)) {
      sslConfig.ca = fs.readFileSync(resolvedCaPath, 'utf8');
    }
  }

  return sslConfig;
}

function trimTrailingSlash(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

/**
 * Expands runtime ${CLOUDFLARE_ACCOUNT_ID} / $CLOUDFLARE_ACCOUNT_ID placeholders and
 * builds a normalized Cloudflare Workers AI OpenAI-compatible base URL.
 *
 * @param {string} rawUrl
 * @param {string} accountId
 * @returns {string}
 */
function resolveCloudflareBaseUrl(rawUrl, accountId) {
  const cleanAccountId = String(accountId || '').trim();
  const raw = String(rawUrl || '').trim();
  let resolved = raw;

  if (resolved) {
    resolved = resolved
      .replace(/\$\{CLOUDFLARE_ACCOUNT_ID\}/g, cleanAccountId)
      .replace(/\$CLOUDFLARE_ACCOUNT_ID\b/g, cleanAccountId);
  } else if (cleanAccountId) {
    resolved = `https://api.cloudflare.com/client/v4/accounts/${cleanAccountId}/ai/v1`;
  }

  resolved = trimTrailingSlash(resolved);
  if (!resolved || resolved.includes('${')) {
    return '';
  }
  return resolved;
}

const cloudflareAccountId = process.env.CLOUDFLARE_ACCOUNT_ID
  ? process.env.CLOUDFLARE_ACCOUNT_ID.trim()
  : '';

const env = {
  nodeEnv: process.env.NODE_ENV || 'development',
  host: process.env.HOST || 'localhost',
  port: parsePositiveInt(process.env.PORT, 3000),
  databaseUrl: process.env.DATABASE_URL || '',
  dbSsl: buildSslConfig(),
  pgPoolMax: Math.min(6, parsePositiveInt(process.env.PG_POOL_MAX, 6)),
  maxUploadSizeBytes: parsePositiveInt(
    process.env.MAX_UPLOAD_SIZE_BYTES,
    2 * 1024 * 1024 // 2 MB default
  ),
  promptTopK: parsePositiveInt(process.env.PROMPT_TOP_K, 5),
  conversationHistoryLimit: parsePositiveInt(
    process.env.CONVERSATION_HISTORY_LIMIT,
    20
  ),
  groqApiKey: process.env.GROQ_API_KEY
    ? process.env.GROQ_API_KEY.trim()
    : '',
  groqBaseUrl: trimTrailingSlash(
    process.env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1'
  ),
  groqFastModel: process.env.GROQ_FAST_MODEL
    ? process.env.GROQ_FAST_MODEL.trim()
    : 'openai/gpt-oss-20b',
  groqReasoningModel: process.env.GROQ_REASONING_MODEL
    ? process.env.GROQ_REASONING_MODEL.trim()
    : 'openai/gpt-oss-120b',
  groqReasoningBackupModel: process.env.GROQ_REASONING_BACKUP_MODEL
    ? process.env.GROQ_REASONING_BACKUP_MODEL.trim()
    : 'qwen/qwen3.8-27b',
  cloudflareAccountId,
  cloudflareApiKey: process.env.CLOUDFLARE_API_KEY
    ? process.env.CLOUDFLARE_API_KEY.trim()
    : '',
  cloudflareBaseUrl: resolveCloudflareBaseUrl(
    process.env.CLOUDFLARE_BASE_URL,
    cloudflareAccountId
  ),
  cloudflareFastModel: process.env.CLOUDFLARE_FAST_MODEL
    ? process.env.CLOUDFLARE_FAST_MODEL.trim()
    : '@cf/qwen/qwen3-30b-a3b-fp8',
  cloudflareReasoningModel: process.env.CLOUDFLARE_REASONING_MODEL
    ? process.env.CLOUDFLARE_REASONING_MODEL.trim()
    : '@cf/openai/gpt-oss-120b',
  geminiApiKey: process.env.GEMINI_API_KEY
    ? process.env.GEMINI_API_KEY.trim()
    : '',
  geminiProjectName: process.env.GEMINI_PROJECT_NAME
    ? process.env.GEMINI_PROJECT_NAME.trim()
    : '',
  geminiProjectNumber: process.env.GEMINI_PROJECT_NUMBER
    ? process.env.GEMINI_PROJECT_NUMBER.trim()
    : '',
  geminiModel: process.env.GEMINI_MODEL
    ? process.env.GEMINI_MODEL.trim()
    : 'gemini-3.5-flash',
  llmTimeoutMs: parsePositiveInt(process.env.LLM_TIMEOUT_MS, 18000),
  llmDefaultCooldownMs: parsePositiveInt(
    process.env.LLM_DEFAULT_COOLDOWN_MS,
    60000
  ),
  llmProviderOverride: process.env.LLM_PROVIDER_OVERRIDE
    ? process.env.LLM_PROVIDER_OVERRIDE.trim().toLowerCase()
    : '',
  resolveCloudflareBaseUrl,
  smtpHost: process.env.SMTP_HOST
    ? process.env.SMTP_HOST.trim()
    : 'smtp.gmail.com',
  smtpPort: parsePositiveInt(process.env.SMTP_PORT, 465),
  smtpSecure: parseBoolean(process.env.SMTP_SECURE, true),
  smtpUser: process.env.SMTP_USER ? process.env.SMTP_USER.trim() : '',
  smtpPass: process.env.SMTP_PASS ? process.env.SMTP_PASS.trim() : '',
  mailFrom: process.env.MAIL_FROM
    ? process.env.MAIL_FROM.trim()
    : process.env.SMTP_USER
      ? process.env.SMTP_USER.trim()
      : '',
  smtpTestMode: parseBoolean(process.env.SMTP_TEST_MODE, false),
  googleClientId: process.env.GOOGLE_CLIENT_ID ? process.env.GOOGLE_CLIENT_ID.trim() : '',
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET ? process.env.GOOGLE_CLIENT_SECRET.trim() : '',
  googleRedirectUri: process.env.GOOGLE_REDIRECT_URI ? process.env.GOOGLE_REDIRECT_URI.trim() : 'http://localhost:3000/api/auth/google/callback',
  googleRefreshToken: process.env.GOOGLE_REFRESH_TOKEN ? process.env.GOOGLE_REFRESH_TOKEN.trim() : '',
};

module.exports = env;
