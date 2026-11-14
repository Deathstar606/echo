const { google } = require('googleapis');
const {
  getAuthenticatedClient,
  assertGoogleServiceAllowed,
} = require('./googleAuthService');
const AppError = require('../utils/AppError');

/**
 * Parses email address and display name from a From header string.
 * Example: 'Alice Smith <alice@example.com>' -> { name: 'Alice Smith', email: 'alice@example.com' }
 */
function parseSender(fromHeader = '') {
  const match = fromHeader.match(/^(?:["']?([^"']+)["']?\s+)?<?([^<>\s]+@[^<>\s]+)>?$/);
  if (match) {
    return {
      name: (match[1] || match[2]).trim(),
      email: match[2].trim(),
    };
  }
  return { name: fromHeader, email: fromHeader };
}

/**
 * Recursively extracts plain text and HTML from a Gmail MIME message payload.
 */
function extractBodyParts(payload) {
  let text = '';
  let html = '';

  if (!payload) return { text, html };

  if (payload.body && payload.body.data) {
    const decoded = Buffer.from(payload.body.data, 'base64url').toString('utf8');
    if (payload.mimeType === 'text/plain') {
      text = decoded;
    } else if (payload.mimeType === 'text/html') {
      html = decoded;
    }
  }

  if (payload.parts && Array.isArray(payload.parts)) {
    for (const part of payload.parts) {
      const sub = extractBodyParts(part);
      if (sub.text && !text) text = sub.text;
      if (sub.html && !html) html = sub.html;
    }
  }

  // If plain text is missing, strip HTML tags for text representation
  if (!text && html) {
    text = html
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  return { text, html };
}

/**
 * Fetches primary inbox messages for the connected Google account.
 *
 * @param {string} [businessId]
 * @param {object} [options]
 * @param {number} [options.maxResults=20]
 * @returns {Promise<Array<object>>}
 */
async function fetchPrimaryInboxMessages(businessId, options = {}) {
  await assertGoogleServiceAllowed(businessId, options.requestUserId || '');
  const auth = await getAuthenticatedClient(businessId);
  const gmail = google.gmail({ version: 'v1', auth });
  const maxResults = Math.min(options.maxResults || 20, 50);

  const listRes = await gmail.users.messages.list({
    userId: 'me',
    q: 'label:INBOX category:primary',
    maxResults,
  });

  const messageList = listRes.data.messages || [];
  if (messageList.length === 0) {
    return [];
  }

  // Fetch full details concurrently
  const detailedMessages = await Promise.all(
    messageList.map(async (item) => {
      try {
        const msgRes = await gmail.users.messages.get({
          userId: 'me',
          id: item.id,
          format: 'full',
        });
        const msg = msgRes.data;
        const headers = msg.payload?.headers || [];
        const headerMap = {};
        for (const h of headers) {
          headerMap[h.name.toLowerCase()] = h.value;
        }

        const sender = parseSender(headerMap['from'] || '');
        const { text, html } = extractBodyParts(msg.payload);

        return {
          id: msg.id,
          threadId: msg.threadId,
          subject: headerMap['subject'] || '(No Subject)',
          fromName: sender.name,
          fromEmail: sender.email,
          toEmail: headerMap['to'] || '',
          date: headerMap['date'] || new Date(Number(msg.internalDate || Date.now())).toISOString(),
          snippet: msg.snippet || '',
          bodyText: text || msg.snippet || '',
          bodyHtml: html || '',
          messageId: headerMap['message-id'] || '',
          references: headerMap['references'] || '',
          inReplyTo: headerMap['in-reply-to'] || '',
          isGmail: true,
        };
      } catch (err) {
        console.warn(`[GmailService] Failed to hydrate message ${item.id}:`, err.message);
        return null;
      }
    })
  );

  return detailedMessages.filter(Boolean);
}

/**
 * Sends a standards-compliant RFC 2822 reply directly to an existing Gmail thread.
 *
 * @param {string} [businessId]
 * @param {object} replyData
 * @param {string} replyData.threadId
 * @param {string} replyData.to
 * @param {string} replyData.subject
 * @param {string} [replyData.inReplyTo]
 * @param {string} [replyData.references]
 * @param {string} replyData.bodyText
 * @returns {Promise<object>}
 */
async function sendGmailThreadReply(businessId, replyData) {
  const { threadId, to, subject, inReplyTo, references, bodyText, requestUserId = '' } = replyData;

  await assertGoogleServiceAllowed(businessId, requestUserId);

  if (!to || !bodyText) {
    throw new AppError('Recipient "to" and message "bodyText" are required.', 400);
  }

  const auth = await getAuthenticatedClient(businessId);
  const gmail = google.gmail({ version: 'v1', auth });

  const cleanSubject = /^re:\s*/i.test(subject || '')
    ? (subject || 'Re: Inquiry')
    : `Re: ${subject || 'Inquiry'}`;

  const allRefs = [references, inReplyTo].filter(Boolean).join(' ').trim();

  // Construct RFC 2822 headers and body
  const lines = [
    `To: ${to}`,
    `Subject: ${cleanSubject}`,
  ];
  if (inReplyTo) {
    lines.push(`In-Reply-To: ${inReplyTo}`);
  }
  if (allRefs) {
    lines.push(`References: ${allRefs}`);
  }
  lines.push('Content-Type: text/plain; charset=utf-8');
  lines.push('Content-Transfer-Encoding: 7bit');
  lines.push('');
  lines.push(bodyText);

  const rawMessage = lines.join('\r\n');
  const encodedRaw = Buffer.from(rawMessage, 'utf8').toString('base64url');

  const res = await gmail.users.messages.send({
    userId: 'me',
    requestBody: {
      raw: encodedRaw,
      threadId: threadId || undefined,
    },
  });

  return {
    success: true,
    messageId: res.data.id,
    threadId: res.data.threadId,
    recipient: to,
    subject: cleanSubject,
  };
}

/**
 * Generates an AI suggested reply draft and context citations for an incoming Gmail message
 * using the business's existing RAG context and Gemini model.
 *
 * @param {string} businessId
 * @param {object} payload
 * @param {string} payload.messageText
 * @param {string} [payload.senderName]
 * @param {string} [payload.subject]
 * @returns {Promise<object>}
 */
async function generateAiDraftForGmailMessage(businessId, payload) {
  const { messageText, senderName = 'Customer', subject = '', requestUserId = '' } = payload;
  await assertGoogleServiceAllowed(businessId, requestUserId);
  const { query } = require('../../db');
  const { retrieveRelevantContextForBusiness } = require('./contextRetrievalService');
  const { buildContextualPrompt } = require('./promptBuilderService');
  const { generateAiSupportResponse } = require('./geminiService');

  const bizRes = await query('SELECT id, name FROM workspaces WHERE id = $1 LIMIT 1;', [businessId]);
  const business = bizRes.rows?.[0] || { id: businessId, name: 'Support Workspace' };

  const combinedSearch = [subject, messageText].filter(Boolean).join(' ');
  const relevantRecords = await retrieveRelevantContextForBusiness(businessId, combinedSearch);

  const prompt = buildContextualPrompt({
    business,
    relevantRecords,
    customerMessage: messageText,
    conversationHistory: [],
  });

  try {
    const aiResponse = await generateAiSupportResponse(prompt);
    const topSuggestion = Array.isArray(aiResponse.suggestions) && aiResponse.suggestions.length > 0
      ? aiResponse.suggestions[0]
      : 'Thank you for reaching out. We have received your inquiry and our team is looking into it.';

    return {
      success: true,
      draftText: topSuggestion,
      category: aiResponse.category || 'general_inquiry',
      missingInfo: aiResponse.missing_information || [],
      contextNote: `Generated using ${relevantRecords.length} workspace knowledge sources.`,
      citations: relevantRecords.map((r) => ({
        source_type: r.source_type || 'context',
        title: r.title,
        content: (r.content || '').slice(0, 300),
      })),
    };
  } catch (err) {
    console.warn('[GmailService] AI suggestion fallback:', err.message);
    return {
      success: true,
      draftText: `Hello ${senderName},\n\nThank you for contacting us regarding "${subject}". We are reviewing your request and will follow up shortly.\n\nBest regards,\n${business.name} Team`,
      category: 'general_inquiry',
      missingInfo: [],
      contextNote: 'Standard fallback draft.',
      citations: [],
    };
  }
}

module.exports = {
  fetchPrimaryInboxMessages,
  sendGmailThreadReply,
  generateAiDraftForGmailMessage,
};
