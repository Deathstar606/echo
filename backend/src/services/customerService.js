const { query } = require('../../db');
const AppError = require('../utils/AppError');
const { normalizeEmail } = require('../middleware/validate');

/**
 * Finds a customer by business_id and normalized email address.
 *
 * @param {string} businessId
 * @param {string} email
 */
async function findCustomerByBusinessAndEmail(businessId, email) {
  const normalizedEmail = normalizeEmail(email);
  const result = await query(
    `
      SELECT id, business_id, customer_name, email, external_customer_id, created_at, updated_at
      FROM customers
      WHERE business_id = $1 AND email = $2;
    `,
    [businessId, normalizedEmail]
  );

  return result.rowCount > 0 ? result.rows[0] : null;
}

/**
 * Creates a new customer belonging to the specified business.
 * Prevents duplicate customers within a business by normalizing email addresses.
 *
 * @param {object} params
 * @param {string} params.businessId - UUID of the business
 * @param {string} params.customerName - Required customer full name
 * @param {string} params.email - Required customer email address
 * @param {string | null} [params.externalCustomerId=null] - Optional external identifier
 */
async function createCustomer({
  businessId,
  customerName,
  email,
  externalCustomerId = null,
}) {
  const trimmedName = String(customerName).trim();
  const normalizedEmail = normalizeEmail(email);

  const existing = await findCustomerByBusinessAndEmail(
    businessId,
    normalizedEmail
  );
  if (existing) {
    throw new AppError(
      `A customer with email "${normalizedEmail}" already exists for this business.`,
      409
    );
  }

  try {
    const result = await query(
      `
        INSERT INTO customers (
          business_id,
          customer_name,
          email,
          external_customer_id,
          created_at,
          updated_at
        )
        VALUES ($1, $2, $3, $4, NOW(), NOW())
        RETURNING id, business_id, customer_name, email, external_customer_id, created_at, updated_at;
      `,
      [businessId, trimmedName, normalizedEmail, externalCustomerId]
    );

    return result.rows[0];
  } catch (error) {
    if (error && error.code === '23505') {
      throw new AppError(
        `A customer with email "${normalizedEmail}" already exists for this business.`,
        409
      );
    }
    throw error;
  }
}

/**
 * Finds a customer by UUID.
 *
 * @param {string} customerId - UUID of the customer
 */
async function findCustomerById(customerId) {
  const result = await query(
    `
      SELECT id, business_id, customer_name, email, external_customer_id, created_at, updated_at
      FROM customers
      WHERE id = $1;
    `,
    [customerId]
  );

  return result.rowCount > 0 ? result.rows[0] : null;
}

/**
 * Retrieves all eligible customers (with non-empty customer_name and email)
 * belonging strictly to the specified business.
 *
 * @param {string} businessId
 */
async function getEligibleCustomersForBusiness(businessId) {
  const result = await query(
    `
      SELECT id, business_id, customer_name, email, external_customer_id, created_at, updated_at
      FROM customers
      WHERE business_id = $1
        AND customer_name IS NOT NULL
        AND char_length(btrim(customer_name)) > 0
        AND email IS NOT NULL
        AND char_length(btrim(email)) > 0
      ORDER BY created_at ASC, id ASC;
    `,
    [businessId]
  );

  return result.rows;
}

/**
 * Counts eligible customers (with non-empty customer_name and email) for a business.
 *
 * @param {string} businessId
 * @returns {Promise<number>}
 */
async function countEligibleCustomersForBusiness(businessId) {
  const result = await query(
    `
      SELECT COUNT(*)::int AS count
      FROM customers
      WHERE business_id = $1
        AND customer_name IS NOT NULL
        AND char_length(btrim(customer_name)) > 0
        AND email IS NOT NULL
        AND char_length(btrim(email)) > 0;
    `,
    [businessId]
  );

  return Number(result.rows[0]?.count || 0);
}

/**
 * Retrieves eligible customers for a business filtered by validated announcement target criteria.
 * Uses strictly parameterized SQL against the customers table.
 *
 * @param {string} businessId
 * @param {object | null | undefined} targetCriteria
 * @returns {Promise<Array<object>>}
 */
async function getCustomersMatchingAnnouncementCriteria(
  businessId,
  targetCriteria = null
) {
  if (
    !targetCriteria ||
    typeof targetCriteria !== 'object' ||
    !Array.isArray(targetCriteria.filters) ||
    targetCriteria.filters.length === 0
  ) {
    return getEligibleCustomersForBusiness(businessId);
  }

  const allowedFields = new Set([
    'created_at',
    'email',
    'customer_name',
    'external_customer_id',
  ]);
  const params = [businessId];
  const whereClauses = [
    'business_id = $1',
    'customer_name IS NOT NULL',
    'char_length(btrim(customer_name)) > 0',
    'email IS NOT NULL',
    'char_length(btrim(email)) > 0',
  ];

  for (const filter of targetCriteria.filters) {
    if (!filter || typeof filter !== 'object') continue;
    const field = String(filter.field || '').trim().toLowerCase();
    const operator = String(filter.operator || '').trim().toLowerCase();
    const value = filter.value;

    if (!allowedFields.has(field)) {
      throw new AppError(
        `Invalid customer filter field "${field}" in announcement target criteria.`,
        400
      );
    }

    if (field === 'created_at') {
      if (operator === 'greater_than') {
        params.push(String(value).trim());
        whereClauses.push(`created_at > $${params.length}`);
      } else if (operator === 'greater_than_or_equal') {
        params.push(String(value).trim());
        whereClauses.push(`created_at >= $${params.length}`);
      } else if (operator === 'less_than') {
        params.push(String(value).trim());
        whereClauses.push(`created_at < $${params.length}`);
      } else if (operator === 'less_than_or_equal') {
        params.push(String(value).trim());
        whereClauses.push(`created_at <= $${params.length}`);
      } else if (operator === 'equals') {
        params.push(String(value).trim());
        whereClauses.push(`created_at::date = $${params.length}::date`);
      } else if (
        operator === 'between' &&
        Array.isArray(value) &&
        value.length === 2
      ) {
        params.push(String(value[0]).trim());
        const p1 = params.length;
        params.push(String(value[1]).trim());
        const p2 = params.length;
        whereClauses.push(`created_at BETWEEN $${p1} AND $${p2}`);
      } else {
        throw new AppError(
          `Unsupported operator "${operator}" for customer created_at filter.`,
          400
        );
      }
    } else {
      if (operator === 'equals') {
        params.push(String(value).trim());
        whereClauses.push(`LOWER(${field}) = LOWER($${params.length})`);
      } else if (operator === 'contains') {
        params.push(`%${String(value).trim()}%`);
        whereClauses.push(`${field} ILIKE $${params.length}`);
      } else if (operator === 'ends_with') {
        params.push(`%${String(value).trim()}`);
        whereClauses.push(`${field} ILIKE $${params.length}`);
      } else {
        throw new AppError(
          `Unsupported operator "${operator}" for customer ${field} filter.`,
          400
        );
      }
    }
  }

  const result = await query(
    `
      SELECT id, business_id, customer_name, email, external_customer_id, created_at, updated_at
      FROM customers
      WHERE ${whereClauses.join('\n        AND ')}
      ORDER BY created_at ASC, id ASC;
    `,
    params
  );

  return result.rows;
}

module.exports = {
  createCustomer,
  findCustomerById,
  findCustomerByBusinessAndEmail,
  getEligibleCustomersForBusiness,
  countEligibleCustomersForBusiness,
  getCustomersMatchingAnnouncementCriteria,
};
