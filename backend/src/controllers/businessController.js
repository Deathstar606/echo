const crypto = require('node:crypto');
const { query } = require('../../db');
const AppError = require('../utils/AppError');

/**
 * Fetches a business by UUID or throws a 404 AppError if not found.
 *
 * @param {string} businessId
 * @returns {Promise<{ id: string, name: string, created_at: string }>}
 */
async function findBusinessOrThrow(businessId) {
  const result = await query(
    `
      SELECT id, name, created_at
      FROM businesses
      WHERE id = $1;
    `,
    [businessId]
  );

  if (result.rowCount === 0) {
    throw new AppError(`Business with ID "${businessId}" was not found.`, 404);
  }

  return result.rows[0];
}

/**
 * POST /api/businesses
 * Creates a new business and returns its generated UUID.
 */
async function createBusiness(req, res, next) {
  try {
    const rawName = req.body ? req.body.name : undefined;

    if (typeof rawName !== 'string' || !rawName.trim()) {
      throw new AppError(
        'Business "name" is required and must be a non-empty string.',
        400
      );
    }

    const name = rawName.trim();
    if (name.length > 255) {
      throw new AppError(
        'Business "name" must not exceed 255 characters.',
        400
      );
    }

    const id = crypto.randomUUID();
    const result = await query(
      `
        INSERT INTO businesses (id, name)
        VALUES ($1, $2)
        RETURNING id, name, created_at;
      `,
      [id, name]
    );

    const createdBusiness = result.rows[0];

    return res.status(201).json({
      id: createdBusiness.id,
      name: createdBusiness.name,
      created_at: createdBusiness.created_at,
    });
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  findBusinessOrThrow,
  createBusiness,
};
