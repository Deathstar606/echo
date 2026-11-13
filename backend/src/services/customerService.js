const { query } = require('../../db');
const AppError = require('../utils/AppError');
const { normalizeEmail } = require('../middleware/validate');
const crypto = require('node:crypto');

/**
 * Finds a customer / user by email address.
 *
 * @param {string} businessId
 * @param {string} email
 */
async function findCustomerByBusinessAndEmail(businessId, email) {
  const normalizedEmail = normalizeEmail(email);
  const result = await query(
    `
      SELECT id, name AS customer_name, name, email, created_at, updated_at
      FROM users
      WHERE LOWER(email) = $1;
    `,
    [normalizedEmail]
  );

  return result.rowCount > 0 ? result.rows[0] : null;
}

/**
 * Creates or updates a customer in the users table.
 *
 * @param {object} params
 * @param {string} params.businessId - UUID of the workspace
 * @param {string} params.customerName - Required customer full name
 * @param {string} params.email - Required customer email address
 * @param {string | null} [params.externalCustomerId=null]
 */
async function createCustomer({
  businessId,
  customerName,
  email,
  externalCustomerId = null,
}) {
  const trimmedName = String(customerName).trim();
  const normalizedEmail = normalizeEmail(email);

  const id = crypto.randomUUID();
  try {
    const result = await query(
      `
        INSERT INTO users (
          id,
          name,
          email,
          created_at,
          updated_at
        )
        VALUES ($1, $2, $3, NOW(), NOW())
        RETURNING id, name AS customer_name, name, email, created_at, updated_at;
      `,
      [id, trimmedName, normalizedEmail]
    );

    return result.rows[0];
  } catch (error) {
    if (error && error.code === '23505') {
      throw new AppError(
        `A customer with email "${normalizedEmail}" already exists.`,
        409
      );
    }
    throw error;
  }
}

/**
 * Finds a customer / user by UUID.
 *
 * @param {string} customerId - UUID of the user
 */
async function findCustomerById(customerId) {
  const result = await query(
    `
      SELECT id, name AS customer_name, name, email, created_at, updated_at
      FROM users
      WHERE id = $1;
    `,
    [customerId]
  );

  return result.rowCount > 0 ? result.rows[0] : null;
}

/**
 * Retrieves all eligible users with non-empty name and email.
 *
 * @param {string} [businessId]
 */
async function getEligibleCustomersForBusiness(businessId) {
  const result = await query(
    `
      SELECT id, name AS customer_name, name, email, created_at, updated_at
      FROM users
      WHERE name IS NOT NULL
        AND char_length(btrim(name)) > 0
        AND email IS NOT NULL
        AND char_length(btrim(email)) > 0
      ORDER BY created_at ASC, id ASC;
    `
  );

  return result.rows;
}

/**
 * Counts eligible users.
 *
 * @param {string} [businessId]
 * @returns {Promise<number>}
 */
async function countEligibleCustomersForBusiness(businessId) {
  const result = await query(
    `
      SELECT COUNT(*)::int AS count
      FROM users
      WHERE name IS NOT NULL
        AND char_length(btrim(name)) > 0
        AND email IS NOT NULL
        AND char_length(btrim(email)) > 0;
    `
  );

  return Number(result.rows[0]?.count || 0);
}

/**
 * Retrieves eligible customers filtered by announcement target criteria.
 */
async function getFilteredCustomersForBusiness(businessId, targetCriteria = {}) {
  const customers = await getEligibleCustomersForBusiness(businessId);
  if (!targetCriteria || Object.keys(targetCriteria).length === 0) {
    return customers;
  }

  const {
    tags = [],
    exclude_tags = [],
    min_spend = null,
    max_spend = null,
    regions = [],
  } = targetCriteria;

  return customers.filter((customer) => {
    if (regions.length > 0 && customer.region && !regions.includes(customer.region)) {
      return false;
    }
    return true;
  });
}

/**
 * Retrieves eligible users matching validated announcement targeting criteria
 * (registration date created_at, email, customer_name).
 *
 * @param {string} businessId
 * @param {{ status?: string, scope?: string, filters?: Array<{ field: string, operator: string, value: any }> }} [targeting]
 * @returns {Promise<Array<object>>}
 */
async function getCustomersMatchingAnnouncementCriteria(businessId, targeting = {}) {
  // Check for workspace_contacts source (Filtered vs Workspace CSV panel)
  if (targeting?.source === 'workspace_contacts' || targeting?.panel_type) {
    const panelType =
      targeting.panel_type ||
      (targeting.scope === 'filtered_contacts' ? 'filtered' : 'workspace_csv');
    const res = await query(
      `SELECT id, customer_name, customer_name AS name, email, created_at, updated_at
       FROM workspace_contacts
       WHERE workspace_id = $1 AND panel_type = $2
       ORDER BY updated_at DESC, created_at DESC;`,
      [businessId, panelType]
    );
    return res.rows;
  }

  const filters = Array.isArray(targeting?.filters) ? targeting.filters : [];
  if (!targeting || targeting.scope === 'all' || filters.length === 0) {
    return getEligibleCustomersForBusiness(businessId);
  }

  const clauses = [
    'name IS NOT NULL',
    'char_length(btrim(name)) > 0',
    'email IS NOT NULL',
    'char_length(btrim(email)) > 0',
  ];
  const params = [];

  for (const f of filters) {
    const field = String(f?.field || '').trim().toLowerCase();
    const operator = String(f?.operator || '').trim().toLowerCase();
    const value = f?.value;

    if (field === 'external_customer_id') {
      // Dropped in user-centric users table; return empty set safely
      return [];
    }

    if (field === 'created_at') {
      if (operator === 'between' && Array.isArray(value) && value.length === 2) {
        const startVal = String(value[0]).trim();
        const rawEnd = String(value[1]).trim();
        const endVal = /^\d{4}-\d{2}-\d{2}$/.test(rawEnd) ? `${rawEnd}T23:59:59.999Z` : rawEnd;
        params.push(startVal);
        const p1 = `$${params.length}`;
        params.push(endVal);
        const p2 = `$${params.length}`;
        clauses.push(`created_at >= ${p1}`);
        clauses.push(`created_at <= ${p2}`);
      } else {
        const valStr = String(value ?? '').trim();
        params.push(valStr);
        const ph = `$${params.length}`;
        if (operator === 'greater_than') {
          clauses.push(`created_at > ${ph}`);
        } else if (operator === 'greater_than_or_equal') {
          clauses.push(`created_at >= ${ph}`);
        } else if (operator === 'less_than') {
          clauses.push(`created_at < ${ph}`);
        } else if (operator === 'less_than_or_equal') {
          clauses.push(`created_at <= ${ph}`);
        } else if (operator === 'equals') {
          clauses.push(`created_at::date = ${ph}::date`);
        }
      }
      continue;
    }

    if (field === 'email') {
      const valStr = String(value ?? '').trim();
      if (operator === 'equals') {
        params.push(valStr.toLowerCase());
        clauses.push(`LOWER(email) = $${params.length}`);
      } else if (operator === 'ends_with') {
        params.push(`%${valStr}`);
        clauses.push(`email ILIKE $${params.length}`);
      } else {
        params.push(`%${valStr}%`);
        clauses.push(`email ILIKE $${params.length}`);
      }
      continue;
    }

    if (field === 'customer_name' || field === 'name') {
      const valStr = String(value ?? '').trim();
      if (operator === 'equals') {
        params.push(valStr.toLowerCase());
        clauses.push(`LOWER(name) = $${params.length}`);
      } else if (operator === 'ends_with') {
        params.push(`%${valStr}`);
        clauses.push(`name ILIKE $${params.length}`);
      } else {
        params.push(`%${valStr}%`);
        clauses.push(`name ILIKE $${params.length}`);
      }
    }
  }

  const result = await query(
    `
      SELECT id, name AS customer_name, name, email, created_at, updated_at
      FROM users
      WHERE ${clauses.join(' AND ')}
      ORDER BY created_at ASC, id ASC;
    `,
    params
  );

  return result.rows;
}

/**
 * Counts eligible customers matching target criteria.
 */
async function countFilteredCustomersForBusiness(businessId, targetCriteria = {}) {
  const filtered = await getFilteredCustomersForBusiness(businessId, targetCriteria);
  return filtered.length;
}

module.exports = {
  findCustomerByBusinessAndEmail,
  createCustomer,
  findCustomerById,
  getEligibleCustomersForBusiness,
  countEligibleCustomersForBusiness,
  getFilteredCustomersForBusiness,
  countFilteredCustomersForBusiness,
  getCustomersMatchingAnnouncementCriteria,
};
