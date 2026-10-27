const { query, withTransaction } = require('../../db');
const AppError = require('../utils/AppError');
const { getEligibleCustomersForBusiness } = require('./customerService');
const {
  validateSmtpConfig,
  personalizeAnnouncementBody,
  sendIndividualEmail,
} = require('./emailService');

/**
 * Saves a newly generated AI announcement draft in PostgreSQL.
 *
 * @param {object} params
 * @param {string} params.businessId
 * @param {string} params.announcementPrompt
 * @param {string} params.subject
 * @param {string} params.body
 * @param {number} params.recipientCount
 */
async function saveAnnouncementDraft({
  businessId,
  announcementPrompt,
  subject,
  body,
  recipientCount = 0,
}) {
  const result = await query(
    `
      INSERT INTO announcements (
        business_id,
        announcement_prompt,
        subject,
        body,
        status,
        total_recipients,
        sent_count,
        failed_count,
        created_at,
        updated_at
      )
      VALUES ($1, $2, $3, $4, 'draft', $5, 0, 0, NOW(), NOW())
      RETURNING
        id,
        business_id,
        announcement_prompt,
        subject,
        body,
        status,
        total_recipients,
        sent_count,
        failed_count,
        sent_at,
        created_at,
        updated_at;
    `,
    [businessId, announcementPrompt, subject, body, Number(recipientCount)]
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
 * Executes a confirmed bulk announcement campaign:
 * - Atomically locks and transitions the announcement from 'draft' -> 'sending' to prevent duplicate sends.
 * - Retrieves eligible customers belonging strictly to the business.
 * - Personalizes {{customer_name}} for each recipient and sends individual emails sequentially.
 * - Persists each recipient's delivery status ('sent' or 'failed') immediately so partial failures never lose progress.
 * - Finalizes campaign status ('sent', 'partially_sent', or 'failed') and counts.
 *
 * @param {object} params
 * @param {string} params.businessId
 * @param {string} params.announcementId
 * @param {string} params.subject
 * @param {string} params.body
 */
async function sendAnnouncementCampaign({
  businessId,
  announcementId,
  subject,
  body,
}) {
  // 1. Validate that SMTP (or test/mock transport) is configured before locking/sending
  validateSmtpConfig();

  // 2. Atomically verify ownership, prevent duplicate sends, verify eligible customers exist,
  //    and transition status to 'sending'
  const { eligibleCustomers } = await withTransaction(async (client) => {
    const annResult = await client.query(
      `
        SELECT
          id,
          business_id,
          announcement_prompt,
          subject,
          body,
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

    const customers = await getEligibleCustomersForBusiness(businessId);
    if (customers.length === 0) {
      throw new AppError(
        'No eligible customers found for this business. Please add or import customers with valid names and email addresses before sending an announcement.',
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
      [announcementId, businessId, subject, body, customers.length]
    );

    return { eligibleCustomers: customers };
  });

  // 3. Sequentially send one individually personalized email per recipient
  let sentCount = 0;
  let failedCount = 0;
  const recipientResults = [];

  for (const customer of eligibleCustomers) {
    const personalizedBody = personalizeAnnouncementBody(
      body,
      customer.customer_name
    );

    let deliveryStatus = 'sent';
    let errorMessage = null;

    try {
      await sendIndividualEmail({
        to: customer.email,
        subject,
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
  sendAnnouncementCampaign,
};
