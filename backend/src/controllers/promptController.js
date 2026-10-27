const AppError = require('../utils/AppError');
const { findBusinessOrThrow } = require('./businessController');
const {
  retrieveRelevantContextForBusiness,
} = require('../services/contextRetrievalService');
const { buildContextualPrompt } = require('../services/promptBuilderService');

const MAX_MESSAGE_LENGTH = 5000;

/**
 * POST /api/businesses/:businessId/prompt
 * Retrieves relevant context records for the business and returns the constructed prompt as text/plain.
 */
async function generateBusinessPrompt(req, res, next) {
  try {
    const { businessId } = req.params;
    const rawMessage = req.body ? req.body.message : undefined;

    if (typeof rawMessage !== 'string' || !rawMessage.trim()) {
      throw new AppError(
        'Customer "message" is required and must be a non-empty string.',
        400
      );
    }

    const customerMessage = rawMessage.trim();
    if (customerMessage.length > MAX_MESSAGE_LENGTH) {
      throw new AppError(
        `Customer "message" must not exceed ${MAX_MESSAGE_LENGTH} characters.`,
        400
      );
    }

    // 1. Verify that the business exists
    const business = await findBusinessOrThrow(businessId);

    // 2. Retrieve relevant context records using deterministic keyword scoring
    const relevantRecords = await retrieveRelevantContextForBusiness(
      business.id,
      customerMessage
    );

    // 3. Construct the dynamic prompt string
    const promptText = buildContextualPrompt({
      business,
      relevantRecords,
      customerMessage,
    });

    // 4. Return only the assembled prompt as text/plain
    return res
      .status(200)
      .set('Content-Type', 'text/plain; charset=utf-8')
      .send(promptText);
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  generateBusinessPrompt,
};
