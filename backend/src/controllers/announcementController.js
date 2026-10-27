const AppError = require('../utils/AppError');
const { findBusinessOrThrow } = require('./businessController');
const {
  countEligibleCustomersForBusiness,
} = require('../services/customerService');
const {
  buildAnnouncementDraftPrompt,
} = require('../services/announcementPromptBuilderService');
const { generateAiAnnouncementDraft } = require('../services/geminiService');
const {
  saveAnnouncementDraft,
  sendAnnouncementCampaign,
} = require('../services/announcementService');

const MAX_ANNOUNCEMENT_LENGTH = 5000;
const MAX_SUBJECT_LENGTH = 255;
const MAX_BODY_LENGTH = 20000;

/**
 * POST /api/businesses/:businessId/announcements/draft
 * Generates an AI email announcement draft (subject + body with {{customer_name}}),
 * saves it in PostgreSQL with status = 'draft', and returns it with recipient_count.
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

    // 2. Retrieve eligible customer count for this business
    const recipientCount = await countEligibleCustomersForBusiness(business.id);

    // 3. Construct dedicated announcement-generation prompt
    const promptText = buildAnnouncementDraftPrompt({
      business,
      announcementText,
    });

    // 4. Generate professional email subject & body via Google AI Studio
    const draft = await generateAiAnnouncementDraft(promptText);

    // 5. Persist draft in PostgreSQL
    const savedAnnouncement = await saveAnnouncementDraft({
      businessId: business.id,
      announcementPrompt: announcementText,
      subject: draft.subject,
      body: draft.body,
      recipientCount,
    });

    // 6. Return saved draft details for frontend review/editing
    return res.status(201).json({
      id: savedAnnouncement.id,
      business_id: savedAnnouncement.business_id,
      announcement_prompt: savedAnnouncement.announcement_prompt,
      subject: savedAnnouncement.subject,
      body: savedAnnouncement.body,
      status: savedAnnouncement.status,
      recipient_count: Number(savedAnnouncement.total_recipients),
      created_at: savedAnnouncement.created_at,
      updated_at: savedAnnouncement.updated_at,
    });
  } catch (error) {
    return next(error);
  }
}

/**
 * POST /api/businesses/:businessId/announcements/:announcementId/send
 * Validates confirmation and edited subject/body, personalizes {{customer_name}}
 * per eligible customer, sends individual emails sequentially, records per-recipient
 * delivery outcomes, prevents duplicate campaign sends, and returns a send summary.
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

    if (typeof body.subject !== 'string' || !body.subject.trim()) {
      throw new AppError(
        '"subject" is required and must be a non-empty string.',
        400
      );
    }

    const sanitizedSubject = body.subject.replace(/[\r\n]+/g, ' ').trim();
    if (sanitizedSubject.length > MAX_SUBJECT_LENGTH) {
      throw new AppError(
        `"subject" must not exceed ${MAX_SUBJECT_LENGTH} characters.`,
        400
      );
    }

    if (typeof body.body !== 'string' || !body.body.trim()) {
      throw new AppError(
        '"body" is required and must be a non-empty string.',
        400
      );
    }

    const trimmedBody = body.body.trim();
    if (trimmedBody.length > MAX_BODY_LENGTH) {
      throw new AppError(
        `"body" must not exceed ${MAX_BODY_LENGTH} characters.`,
        400
      );
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

    return res.status(200).json({
      announcement_id: announcement.id,
      business_id: announcement.business_id,
      subject: announcement.subject,
      body: announcement.body,
      status: announcement.status,
      recipient_count: Number(announcement.total_recipients),
      sent_count: Number(announcement.sent_count),
      failed_count: Number(announcement.failed_count),
      sent_at: announcement.sent_at,
      recipients: recipients.map((r) => ({
        id: r.id,
        customer_id: r.customer_id,
        customer_name: r.customer_name,
        email: r.email,
        status: r.status,
        error_message: r.error_message,
        sent_at: r.sent_at,
      })),
    });
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  draftBusinessAnnouncement,
  sendBusinessAnnouncement,
};
