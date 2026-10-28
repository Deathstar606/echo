const { query, withTransaction } = require('../../db');
const AppError = require('../utils/AppError');
const {
  getCustomersMatchingAnnouncementCriteria,
} = require('./customerService');
const {
  validateSmtpConfig,
  personalizeAnnouncementBody,
  sendIndividualEmail,
} = require('./emailService');

/**
 * Saves a newly generated AI announcement draft in PostgreSQL, including
 * validated audience targeting criteria and human-readable audience description.
 *
 * @param {object} params
 * @param {string} params.businessId
 * @param {string} params.announcementPrompt
 * @param {string} params.subject
 * @param {string} params.body
 * @param {number} [params.recipientCount=0]
 * @param {object} [params.targetCriteria]
 * @param {string} [params.audienceDescription]
 */
async function saveAnnouncementDraft({
  businessId,
  announcementPrompt,
  subject,
  body,
  recipientCount = 0,
  targetCriteria = { status: 'ok', scope: 'all', filters: [] },
  audienceDescription = 'All registered customers',
}) {
  const serializedCriteria =
    typeof targetCriteria === 'string'
      ? targetCriteria
      : JSON.stringify(targetCriteria || { status: 'ok', scope: 'all', filters: [] });

  const result = await query(
    `
      INSERT INTO announcements (
        business_id,
        announcement_prompt,
        subject,
        body,
        target_criteria,
        audience_description,
        status,
        total_recipients,
        sent_count,
        failed_count,
        created_at,
        updated_at
      )
      VALUES ($1, $2, $3, $4, $5::jsonb, $6, 'draft', $7, 0, 0, NOW(), NOW())
      RETURNING
        id,
        business_id,
        announcement_prompt,
        subject,
        body,
        target_criteria,
        audience_description,
        status,
        total_recipients,
        sent_count,
        failed_count,
        sent_at,
        created_at,
        updated_at;
    `,
    [
      businessId,
      announcementPrompt,
      subject,
      body,
      serializedCriteria,
      audienceDescription || 'All registered customers',
      Number(recipientCount),
    ]
  );

  return result.rows[0];
}

/**
 * Fetches an announcement by ID and verifies it belongs to the specified business.
 *
 * @param {string} businessId
 * @param {string} announcementId
 */
async function findAnnouncementForBusinessOrThrow(businessId, announcementId) {
  const result = await query(
    `
      SELECT
        id,
        business_id,
        announcement_prompt,
        subject,
        body,
        target_criteria,
        audience_description,
        status,
        total_recipients,
        sent_count,
        failed_count,
        sent_at,
        created_at,
        updated_at
      FROM announcements
      WHERE id = $1 AND business_id = $2;
    `,
    [announcementId, businessId]
  );

  if (result.rowCount === 0) {
    throw new AppError(
      `Announcement with ID "${announcementId}" was not found for this business.`,
      404
    );
  }

  return result.rows[0];
}

/**
 * Lists all announcements for a business ordered by creation date descending,
 * including recipient counts and delivery results.
 *
 * @param {string} businessId
 * @returns {Promise<Array<object>>}
 */
async function listAnnouncementsForBusiness(businessId) {
  const annResult = await query(
    `
      SELECT
        id,
        business_id,
        announcement_prompt,
        subject,
        body,
        target_criteria,
        audience_description,
        status,
        total_recipients,
        sent_count,
        failed_count,
        sent_at,
        created_at,
        updated_at
      FROM announcements
      WHERE business_id = $1
      ORDER BY created_at DESC, id DESC;
    `,
    [businessId]
  );

  const announcements = annResult.rows;
  if (announcements.length === 0) {
    return [];
  }

  const announcementIds = announcements.map((a) => a.id);
  const recResult = await query(
    `
      SELECT
        id,
        announcement_id,
        customer_id,
        customer_name,
        email,
        status,
        error_message,
        sent_at
      FROM announcement_recipients
      WHERE announcement_id = ANY($1::uuid[])
      ORDER BY sent_at ASC, id ASC;
    `,
    [announcementIds]
  );

  const recipientsByAnnouncement = new Map();
  for (const r of recResult.rows) {
    if (!recipientsByAnnouncement.has(r.announcement_id)) {
      recipientsByAnnouncement.set(r.announcement_id, []);
    }
    recipientsByAnnouncement.get(r.announcement_id).push(r);
  }

  return announcements.map((ann) => {
    const recs = recipientsByAnnouncement.get(ann.id) || [];
    const parsedCriteria =
      typeof ann.target_criteria === 'string'
        ? JSON.parse(ann.target_criteria)
        : ann.target_criteria || { status: 'ok', scope: 'all', filters: [] };

    const failedRecipients = recs
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

    return {
      id: ann.id,
      business_id: ann.business_id,
      announcement_prompt: ann.announcement_prompt,
      subject: ann.subject,
      body: ann.body,
      content: ann.body,
      audience_description:
        ann.audience_description || 'All registered customers',
      target_criteria: parsedCriteria,
      status: ann.status,
      total_recipients: Number(ann.total_recipients || 0),
      recipient_count: Number(ann.total_recipients || 0),
      sent_count: Number(ann.sent_count || 0),
      failed_count: Number(ann.failed_count || 0),
      sent_at: ann.sent_at,
      created_at: ann.created_at,
      updated_at: ann.updated_at,
      recipients: recs,
      failed_recipients: failedRecipients,
    };
  });
}

/**
 * Executes a confirmed bulk announcement campaign:
 * - Atomically locks and transitions the announcement from 'draft' -> 'sending' to prevent duplicate sends.
 * - Uses the saved announcement's validated target_criteria to select matching customers from the DB.
 * - Personalizes {{customer_name}} for each recipient and sends individual emails sequentially.
 * - Persists each recipient's delivery status ('sent' or 'failed') immediately so partial failures never lose progress.
 * - Finalizes campaign status ('sent', 'partially_sent', or 'failed') and counts.
 *
 * @param {object} params
 * @param {string} params.businessId
 * @param {string} params.announcementId
 * @param {string | null} [params.subject]
 * @param {string | null} [params.body]
 */
async function sendAnnouncementCampaign({
  businessId,
  announcementId,
  subject = null,
  body = null,
}) {
  // 1. Validate that SMTP (or test/mock transport) is configured before locking/sending
  validateSmtpConfig();

  // 2. Atomically verify ownership, prevent duplicate sends, resolve saved subject/body/criteria,
  //    verify matching customers exist, and transition status to 'sending'
  const { eligibleCustomers, resolvedSubject, resolvedBody } =
    await withTransaction(async (client) => {
      const annResult = await client.query(
        `
          SELECT
            id,
            business_id,
            announcement_prompt,
            subject,
            body,
            target_criteria,
            audience_description,
            status,
            total_recipients,
            sent_count,
            failed_count,
            sent_at,
            created_at,
            updated_at
          FROM announcements
          WHERE id = $1 AND business_id = $2
          FOR UPDATE;
        `,
        [announcementId, businessId]
      );

      if (annResult.rowCount === 0) {
        throw new AppError(
          `Announcement with ID "${announcementId}" was not found for this business.`,
          404
        );
      }

      const announcement = annResult.rows[0];

      if (announcement.status !== 'draft') {
        throw new AppError(
          `Announcement has already been processed (current status: "${announcement.status}"). Duplicate campaign sends are not allowed.`,
          409
        );
      }

      const parsedCriteria =
        typeof announcement.target_criteria === 'string'
          ? JSON.parse(announcement.target_criteria)
          : announcement.target_criteria || {
              status: 'ok',
              scope: 'all',
              filters: [],
            };

      if (
        parsedCriteria.status === 'clarification_needed' ||
        parsedCriteria.scope === 'ambiguous'
      ) {
        throw new AppError(
          parsedCriteria.clarification_message ||
            'Cannot send announcement because the intended recipient audience is ambiguous and requires clarification.',
          400
        );
      }

      const finalSubject =
        typeof subject === 'string' && subject.trim()
          ? subject.replace(/[\r\n]+/g, ' ').trim()
          : announcement.subject;

      const finalBody =
        typeof body === 'string' && body.trim()
          ? body.trim()
          : announcement.body;

      const customers = await getCustomersMatchingAnnouncementCriteria(
        businessId,
        parsedCriteria
      );
      if (customers.length === 0) {
        throw new AppError(
          'No eligible customers found matching the announcement criteria for this business.',
          400
        );
      }

      await client.query(
        `
          UPDATE announcements
          SET
            subject = $3,
            body = $4,
            status = 'sending',
            total_recipients = $5,
            updated_at = NOW()
          WHERE id = $1 AND business_id = $2;
        `,
        [announcementId, businessId, finalSubject, finalBody, customers.length]
      );

      return {
        eligibleCustomers: customers,
        resolvedSubject: finalSubject,
        resolvedBody: finalBody,
      };
    });

  // 3. Sequentially send one individually personalized email per recipient
  let sentCount = 0;
  let failedCount = 0;
  const recipientResults = [];

  for (const customer of eligibleCustomers) {
    const personalizedBody = personalizeAnnouncementBody(
      resolvedBody,
      customer.customer_name
    );

    let deliveryStatus = 'sent';
    let errorMessage = null;

    try {
      await sendIndividualEmail({
        to: customer.email,
        subject: resolvedSubject,
        text: personalizedBody,
      });
      sentCount += 1;
    } catch (err) {
      deliveryStatus = 'failed';
      errorMessage =
        err && err.message ? String(err.message) : 'SMTP delivery failed.';
      failedCount += 1;
    }

    // Record each recipient's result immediately so partial failures never lose successful send records
    const recResult = await query(
      `
        INSERT INTO announcement_recipients (
          announcement_id,
          customer_id,
          customer_name,
          email,
          status,
          error_message,
          sent_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, NOW())
        ON CONFLICT (announcement_id, email)
        DO UPDATE SET
          status = EXCLUDED.status,
          error_message = EXCLUDED.error_message,
          sent_at = NOW()
        RETURNING
          id,
          announcement_id,
          customer_id,
          customer_name,
          email,
          status,
          error_message,
          sent_at;
      `,
      [
        announcementId,
        customer.id,
        customer.customer_name,
        customer.email,
        deliveryStatus,
        errorMessage,
      ]
    );

    recipientResults.push(recResult.rows[0]);
  }

  // 4. Determine final campaign status
  let finalStatus = 'sent';
  if (sentCount > 0 && failedCount > 0) {
    finalStatus = 'partially_sent';
  } else if (sentCount === 0 && failedCount > 0) {
    finalStatus = 'failed';
  }

  const finalAnnResult = await query(
    `
      UPDATE announcements
      SET
        status = $3,
        total_recipients = $4,
        sent_count = $5,
        failed_count = $6,
        sent_at = NOW(),
        updated_at = NOW()
      WHERE id = $1 AND business_id = $2
      RETURNING
        id,
        business_id,
        announcement_prompt,
        subject,
        body,
        target_criteria,
        audience_description,
        status,
        total_recipients,
        sent_count,
        failed_count,
        sent_at,
        created_at,
        updated_at;
    `,
    [
      announcementId,
      businessId,
      finalStatus,
      eligibleCustomers.length,
      sentCount,
      failedCount,
    ]
  );

  return {
    announcement: finalAnnResult.rows[0],
    recipients: recipientResults,
  };
}

module.exports = {
  saveAnnouncementDraft,
  findAnnouncementForBusinessOrThrow,
  listAnnouncementsForBusiness,
  sendAnnouncementCampaign,
};
