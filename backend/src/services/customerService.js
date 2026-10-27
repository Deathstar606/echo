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

module.exports = {
  createCustomer,
  findCustomerById,
  findCustomerByBusinessAndEmail,
  getEligibleCustomersForBusiness,
  countEligibleCustomersForBusiness,
};
