const AppError = require('../utils/AppError');

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const EMAIL_REGEX =
  /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;

function isValidUuid(value) {
  return typeof value === 'string' && UUID_REGEX.test(value.trim());
}

/**
 * Normalizes an email address by trimming surrounding whitespace and lowercasing.
 *
 * @param {string} email
 * @returns {string}
 */
function normalizeEmail(email) {
  if (typeof email !== 'string') {
    return '';
  }
  return email.trim().toLowerCase();
}

/**
 * Validates whether a string is a syntactically valid email address.
 *
 * @param {string} email
 * @returns {boolean}
 */
function isValidEmail(email) {
  const normalized = normalizeEmail(email);
  if (!normalized || normalized.length > 320 || normalized.includes('..')) {
    return false;
  }
  return EMAIL_REGEX.test(normalized);
}

/**
 * Express middleware that validates :businessId route parameter is a valid UUID.
 */
function validateBusinessIdParam(req, res, next) {
  const { businessId } = req.params;

  if (!isValidUuid(businessId)) {
    return next(
      new AppError(
        'Invalid businessId parameter. Must be a valid UUID.',
        400
      )
    );
  }

  req.params.businessId = businessId.trim();
  return next();
}

/**
 * Express middleware that validates :conversationId route parameter is a valid UUID.
 */
function validateConversationIdParam(req, res, next) {
  const { conversationId } = req.params;

  if (!isValidUuid(conversationId)) {
    return next(
      new AppError(
        'Invalid conversationId parameter. Must be a valid UUID.',
        400
      )
    );
  }

  req.params.conversationId = conversationId.trim();
  return next();
}

/**
 * Express middleware that validates :announcementId route parameter is a valid UUID.
 */
function validateAnnouncementIdParam(req, res, next) {
  const { announcementId } = req.params;

  if (!isValidUuid(announcementId)) {
    return next(
      new AppError(
        'Invalid announcementId parameter. Must be a valid UUID.',
        400
      )
    );
  }

  req.params.announcementId = announcementId.trim();
  return next();
}

module.exports = {
  isValidUuid,
  normalizeEmail,
  isValidEmail,
  validateBusinessIdParam,
  validateConversationIdParam,
  validateAnnouncementIdParam,
};
