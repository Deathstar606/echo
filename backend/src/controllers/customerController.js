const AppError = require('../utils/AppError');
const { normalizeEmail, isValidEmail } = require('../middleware/validate');
const { findBusinessOrThrow } = require('./businessController');
const { createCustomer } = require('../services/customerService');

/**
 * POST /api/businesses/:businessId/customers
 * Creates an individual customer belonging to the specified business.
 * Requires customer_name and email; keeps external_customer_id optional.
 */
async function createBusinessCustomer(req, res, next) {
  try {
    const { businessId } = req.params;
    const body = req.body || {};

    const rawCustomerName =
      body.customer_name !== undefined ? body.customer_name : body.customerName;
    const rawEmail = body.email;
    const rawExternalId =
      body.external_customer_id !== undefined
        ? body.external_customer_id
        : body.externalCustomerId;

    if (typeof rawCustomerName !== 'string' || !rawCustomerName.trim()) {
      throw new AppError(
        '"customer_name" is required and must be a non-empty string.',
        400
      );
    }

    const customerName = rawCustomerName.trim();
    if (customerName.length > 255) {
      throw new AppError(
        '"customer_name" must not exceed 255 characters.',
        400
      );
    }

    if (typeof rawEmail !== 'string' || !rawEmail.trim()) {
      throw new AppError(
        '"email" is required and must be a non-empty string.',
        400
      );
    }

    const normalizedEmail = normalizeEmail(rawEmail);
    if (!isValidEmail(normalizedEmail)) {
      throw new AppError(
        'Invalid "email" format. Please provide a valid email address.',
        400
      );
    }

    let externalCustomerId = null;

    if (rawExternalId !== undefined && rawExternalId !== null) {
      if (typeof rawExternalId !== 'string') {
        throw new AppError(
          '"external_customer_id" must be a string when provided.',
          400
        );
      }

      const trimmedExt = rawExternalId.trim();
      if (trimmedExt.length > 255) {
        throw new AppError(
          '"external_customer_id" must not exceed 255 characters.',
          400
        );
      }

      externalCustomerId = trimmedExt || null;
    }

    // Verify that the business exists
    const business = await findBusinessOrThrow(businessId);

    const customer = await createCustomer({
      businessId: business.id,
      customerName,
      email: normalizedEmail,
      externalCustomerId,
    });

    return res.status(201).json({
      id: customer.id,
      customer_id: customer.id,
      business_id: customer.business_id ?? business.id,
      customer_name: customer.customer_name,
      email: customer.email,
      external_customer_id: customer.external_customer_id ?? externalCustomerId ?? null,
      created_at: customer.created_at,
      updated_at: customer.updated_at,
    });
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  createBusinessCustomer,
};
