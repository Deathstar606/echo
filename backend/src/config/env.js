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

const env = {
  nodeEnv: process.env.NODE_ENV || 'development',
  host: process.env.HOST || 'localhost',
  port: parsePositiveInt(process.env.PORT, 3000),
  databaseUrl: process.env.DATABASE_URL || '',
  dbSsl: buildSslConfig(),
  maxUploadSizeBytes: parsePositiveInt(
    process.env.MAX_UPLOAD_SIZE_BYTES,
    2 * 1024 * 1024 // 2 MB default
  ),
  promptTopK: parsePositiveInt(process.env.PROMPT_TOP_K, 5),
  conversationHistoryLimit: parsePositiveInt(
    process.env.CONVERSATION_HISTORY_LIMIT,
    20
  ),
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
    : 'gemini-3.5-flash-lite',
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
};

module.exports = env;
