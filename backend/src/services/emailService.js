const nodemailer = require('nodemailer');
const env = require('../config/env');
const AppError = require('../utils/AppError');

let customTransporter = null;
let cachedSmtpTransporter = null;

/**
 * Allows injecting a mock or test Nodemailer transporter (e.g. for automated tests).
 * Passing null resets to the default environment-configured transporter.
 *
 * @param {object | null} transporter
 */
function setMailTransporter(transporter) {
  customTransporter = transporter;
}

/**
 * Escapes HTML special characters to prevent HTML injection if HTML bodies are used.
 *
 * @param {string} unsafeText
 * @returns {string}
 */
function escapeHtml(unsafeText) {
  if (typeof unsafeText !== 'string') {
    return '';
  }
  return unsafeText
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Replaces every occurrence of {{customer_name}} with the recipient's actual name.
 *
 * @param {string} bodyTemplate
 * @param {string} customerName
 * @returns {string}
 */
function personalizeAnnouncementBody(bodyTemplate, customerName) {
  const safeName = String(customerName ?? '').trim();
  return String(bodyTemplate ?? '').replace(
    /\{\{\s*customer_name\s*\}\}/g,
    safeName
  );
}

/**
 * Validates that required SMTP environment variables are present and not left as example placeholders.
 * Never logs or exposes credentials in error messages.
 */
function validateSmtpConfig() {
  if (customTransporter || env.smtpTestMode) {
    return;
  }

  const missingVars = [];
  if (!env.smtpHost) missingVars.push('SMTP_HOST');
  if (!env.smtpPort) missingVars.push('SMTP_PORT');
  if (
    !env.smtpUser ||
    env.smtpUser.toLowerCase() === 'your-email@gmail.com'
  ) {
    missingVars.push('SMTP_USER');
  }
  if (
    !env.smtpPass ||
    env.smtpPass.toLowerCase() === 'your-gmail-app-password'
  ) {
    missingVars.push('SMTP_PASS');
  }
  if (
    !env.mailFrom ||
    env.mailFrom.toLowerCase() === 'your-email@gmail.com'
  ) {
    missingVars.push('MAIL_FROM');
  }

  if (missingVars.length > 0) {
    throw new AppError(
      `SMTP configuration is incomplete. Please configure valid values for: ${missingVars.join(', ')} (or set SMTP_TEST_MODE=true for local non-delivery testing).`,
      500
    );
  }
}

/**
 * Returns the active Nodemailer transporter (custom/mock, local JSON test transport, or configured Gmail SMTP).
 */
function getMailTransporter() {
  if (customTransporter) {
    return customTransporter;
  }

  if (env.smtpTestMode) {
    return nodemailer.createTransport({
      jsonTransport: true,
    });
  }

  validateSmtpConfig();

  if (cachedSmtpTransporter) {
    return cachedSmtpTransporter;
  }

  const isImplicitTls =
    Number(env.smtpPort) === 465 ? true : Boolean(env.smtpSecure);

  cachedSmtpTransporter = nodemailer.createTransport({
    host: env.smtpHost,
    port: Number(env.smtpPort),
    secure: isImplicitTls,
    // When using port 587 (STARTTLS), enforce TLS upgrade
    requireTLS: !isImplicitTls,
    auth: {
      user: env.smtpUser,
      pass: env.smtpPass,
    },
  });

  return cachedSmtpTransporter;
}

const STRICT_EMAIL_REGEX =
  /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;

/**
 * Validates whether a recipient email address has a valid syntactic format.
 *
 * @param {string} email
 * @returns {boolean}
 */
function isValidDeliverableEmail(email) {
  if (typeof email !== 'string') return false;
  const trimmed = email.trim();
  if (!trimmed || trimmed.length > 320 || trimmed.includes('..')) {
    return false;
  }
  return STRICT_EMAIL_REGEX.test(trimmed);
}

/**
 * Sends a single individually personalized email to one recipient.
 * Never uses CC or BCC so recipient addresses are strictly isolated.
 *
 * @param {object} params
 * @param {string} params.to - Single recipient email address
 * @param {string} params.subject - Sanitized email subject line
 * @param {string} params.text - Personalized plain-text email body
 */
async function sendIndividualEmail({ to, subject, text }) {
  const recipientEmail = String(to ?? '').trim();
  if (!isValidDeliverableEmail(recipientEmail)) {
    throw new Error(
      `Invalid email address "${recipientEmail || '(empty)'}" — delivery rejected.`
    );
  }

  const transporter = getMailTransporter();
  const fromAddress = env.mailFrom || env.smtpUser || 'no-reply@example.test';

  const mailOptions = {
    from: fromAddress,
    to: recipientEmail,
    subject: String(subject).replace(/[\r\n]+/g, ' ').trim(),
    text: String(text),
  };

  const info = await transporter.sendMail(mailOptions);

  if (Array.isArray(info?.rejected) && info.rejected.length > 0) {
    throw new Error(
      `Delivery rejected by mail server for ${info.rejected.join(', ')}${info.response ? ` (${info.response})` : ''}`
    );
  }

  return info;
}

module.exports = {
  setMailTransporter,
  escapeHtml,
  personalizeAnnouncementBody,
  validateSmtpConfig,
  getMailTransporter,
  isValidDeliverableEmail,
  sendIndividualEmail,
};
