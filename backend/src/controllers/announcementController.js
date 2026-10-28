const AppError = require('../utils/AppError');
const { findBusinessOrThrow } = require('./businessController');
const {
  getCustomersMatchingAnnouncementCriteria,
} = require('../services/customerService');
const {
  buildAnnouncementDraftPrompt,
  extractAndValidateAudienceTargeting,
} = require('../services/announcementPromptBuilderService');
const { generateAiAnnouncementDraft } = require('../services/geminiService');
const {
  saveAnnouncementDraft,
  listAnnouncementsForBusiness,
  sendAnnouncementCampaign,
} = require('../services/announcementService');

const MAX_ANNOUNCEMENT_LENGTH = 5000;
const MAX_SUBJECT_LENGTH = 255;
const MAX_BODY_LENGTH = 20000;

/**
 * GET /api/businesses/:businessId/announcements
 * Returns previous announcements for the business with creation date, content,
 * subject, sending status, interpreted audience, and successful/failed recipient counts.
 */
async function listBusinessAnnouncements(req, res, next) {
  try {
    const { businessId } = req.params;
    const business = await findBusinessOrThrow(businessId);
    const announcements = await listAnnouncementsForBusiness(business.id);

    return res.status(200).json({
      business_id: business.id,
      count: announcements.length,
      announcements,
    });
  } catch (error) {
    return next(error);
  }
}

/**
 * POST /api/businesses/:businessId/announcements/draft
 * Generates an AI email announcement draft (subject + body with {{customer_name}})
 * and interprets natural-language recipient targeting criteria.
 * If audience criteria are ambiguous or unsupported, requests clarification without silently
 * falling back to all customers.
 */
async function draftBusinessAnnouncement(req, res, next) {
  try {
    const { businessId } = req.params;
    const rawAnnouncement = req.body ? req.body.announcement : undefined;

    if (typeof rawAnnouncement !== 'string' || !rawAnnouncement.trim()) {
      throw new AppError(
        '"announcement" is required and must be a non-empty string.',
        400
      );
    }

    const announcementText = rawAnnouncement.trim();
    if (announcementText.length > MAX_ANNOUNCEMENT_LENGTH) {
      throw new AppError(
        `"announcement" must not exceed ${MAX_ANNOUNCEMENT_LENGTH} characters.`,
        400
      );
    }

    // 1. Validate that the business exists
    const business = await findBusinessOrThrow(businessId);

    // 2. Construct dedicated announcement-generation + audience-targeting prompt
    const promptText = buildAnnouncementDraftPrompt({
      business,
      announcementText,
    });

    // 3. Generate professional email subject, body, and audience targeting via Gemini
    const draft = await generateAiAnnouncementDraft(promptText);

    // 4. Validate and normalize audience targeting criteria (never allow raw SQL or silent fallback on ambiguity)
    const targeting = extractAndValidateAudienceTargeting(
      announcementText,
      draft.audience_targeting
    );

    if (targeting.status === 'clarification_needed') {
      return res.status(200).json({
        id: null,
        business_id: business.id,
        announcement_prompt: announcementText,
        subject: draft.subject,
        body: draft.body,
        status: 'clarification_needed',
        clarification_needed: true,
        message: targeting.clarification_message,
        audience_description: targeting.audience_description,
        target_criteria: targeting,
        recipient_count: 0,
        matching_recipients_preview: [],
      });
    }

    // 5. Apply recipient filters on the backend using database data
    const matchingCustomers = await getCustomersMatchingAnnouncementCriteria(
      business.id,
      targeting
    );
    const recipientCount = matchingCustomers.length;

    // 6. Persist draft in PostgreSQL with validated target_criteria
    const savedAnnouncement = await saveAnnouncementDraft({
      businessId: business.id,
      announcementPrompt: announcementText,
      subject: draft.subject,
      body: draft.body,
      recipientCount,
      targetCriteria: targeting,
      audienceDescription: targeting.audience_description,
    });

    const parsedSavedCriteria =
      typeof savedAnnouncement.target_criteria === 'string'
        ? JSON.parse(savedAnnouncement.target_criteria)
        : savedAnnouncement.target_criteria || targeting;

    // 7. Return saved draft details and interpreted audience for frontend review
    return res.status(201).json({
      id: savedAnnouncement.id,
      business_id: savedAnnouncement.business_id,
      announcement_prompt: savedAnnouncement.announcement_prompt,
      subject: savedAnnouncement.subject,
      body: savedAnnouncement.body,
      status: savedAnnouncement.status,
      audience_description:
        savedAnnouncement.audience_description || targeting.audience_description,
      target_criteria: parsedSavedCriteria,
      recipient_count: Number(savedAnnouncement.total_recipients),
      matching_recipients_preview: matchingCustomers.map((c) => ({
        id: c.id,
        customer_name: c.customer_name,
        email: c.email,
        created_at: c.created_at,
      })),
      created_at: savedAnnouncement.created_at,
      updated_at: savedAnnouncement.updated_at,
    });
  } catch (error) {
    return next(error);
  }
}

/**
 * POST /api/businesses/:businessId/announcements/:announcementId/send
 * Validates confirmation ({ "confirm": true }), uses saved announcement subject/body
 * (or optional edited overrides) and saved validated recipient criteria from PostgreSQL,
 * sends individual emails sequentially, records per-recipient delivery outcomes,
 * prevents duplicate campaign sends, and returns a detailed send summary.
 */
async function sendBusinessAnnouncement(req, res, next) {
  try {
    const { businessId, announcementId } = req.params;
    const body = req.body || {};

    if (body.confirm !== true) {
      throw new AppError(
        'Explicit confirmation ("confirm": true) is required to send a bulk announcement.',
        400
      );
    }

    let sanitizedSubject = null;
    if (body.subject !== undefined && body.subject !== null) {
      if (typeof body.subject !== 'string' || !body.subject.trim()) {
        throw new AppError(
          '"subject" must be a non-empty string when provided.',
          400
        );
      }
      sanitizedSubject = body.subject.replace(/[\r\n]+/g, ' ').trim();
      if (sanitizedSubject.length > MAX_SUBJECT_LENGTH) {
        throw new AppError(
          `"subject" must not exceed ${MAX_SUBJECT_LENGTH} characters.`,
          400
        );
      }
    }

    let trimmedBody = null;
    if (body.body !== undefined && body.body !== null) {
      if (typeof body.body !== 'string' || !body.body.trim()) {
        throw new AppError(
          '"body" must be a non-empty string when provided.',
          400
        );
      }
      trimmedBody = body.body.trim();
      if (trimmedBody.length > MAX_BODY_LENGTH) {
        throw new AppError(
          `"body" must not exceed ${MAX_BODY_LENGTH} characters.`,
          400
        );
      }
    }

    // 1. Validate that the business exists
    const business = await findBusinessOrThrow(businessId);

    // 2. Execute campaign send with idempotency lock and per-recipient tracking
    const { announcement, recipients } = await sendAnnouncementCampaign({
      businessId: business.id,
      announcementId,
      subject: sanitizedSubject,
      body: trimmedBody,
    });

    const formattedRecipients = recipients.map((r) => ({
      id: r.id,
      customer_id: r.customer_id,
      customer_name: r.customer_name,
      email: r.email,
      status: r.status,
      error_message: r.error_message,
      sent_at: r.sent_at,
    }));

    const failedRecipients = formattedRecipients
      .filter((r) => r.status === 'failed')
      .map((r) => ({
        id: r.id,
        customer_id: r.customer_id,
        customer_name: r.customer_name,
        email: r.email,
        reason: r.error_message || 'Delivery failed',
        error_message: r.error_message || 'Delivery failed',
        sent_at: r.sent_at,
      }));

    return res.status(200).json({
      announcement_id: announcement.id,
      business_id: announcement.business_id,
      subject: announcement.subject,
      body: announcement.body,
      audience_description:
        announcement.audience_description || 'All registered customers',
      target_criteria:
        typeof announcement.target_criteria === 'string'
          ? JSON.parse(announcement.target_criteria)
          : announcement.target_criteria,
      status: announcement.status,
      recipient_count: Number(announcement.total_recipients),
      sent_count: Number(announcement.sent_count),
      failed_count: Number(announcement.failed_count),
      sent_at: announcement.sent_at,
      recipients: formattedRecipients,
      failed_recipients: failedRecipients,
    });
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  listBusinessAnnouncements,
  draftBusinessAnnouncement,
  sendBusinessAnnouncement,
};
