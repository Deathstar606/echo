const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const app = require('../src/app');
const { setPool } = require('../db');
const {
  setGeminiGenerator,
  setAnnouncementGeminiGenerator,
} = require('../src/services/geminiService');
const { setMailTransporter } = require('../src/services/emailService');

/**
 * In-memory PostgreSQL pool simulator that faithfully implements the SQL queries,
 * constraints (including composite FK fk_conversations_customer_business and uq_customers_business_email),
 * and transactional semantics (BEGIN/COMMIT/ROLLBACK + ON CONFLICT DO UPDATE)
 * used across Phase 1, Phase 2, and Phase 3.
 */
function createInMemoryPostgresPool() {
  let businesses = new Map(); // id -> { id, name, created_at }
  let contextEntries = []; // Array of entry objects
  let customers = new Map(); // id -> { id, business_id, customer_name, email, external_customer_id, created_at, updated_at }
  let conversations = new Map(); // id -> { id, business_id, customer_id, status, created_at, updated_at }
  let messages = []; // Array of { id, conversation_id, sender_type, content, created_at }
  let announcements = new Map(); // id -> announcement object
  let announcementRecipients = []; // Array of recipient delivery objects
  let nextEntryId = 1;
  let monotonicClock = Date.now();

  function nextIsoTimestamp() {
    monotonicClock = Math.max(Date.now(), monotonicClock + 1);
    return new Date(monotonicClock).toISOString();
  }

  function cloneState() {
    return {
      businesses: new Map(
        Array.from(businesses.entries()).map(([k, v]) => [k, { ...v }])
      ),
      contextEntries: contextEntries.map((e) => ({ ...e })),
      customers: new Map(
        Array.from(customers.entries()).map(([k, v]) => [k, { ...v }])
      ),
      conversations: new Map(
        Array.from(conversations.entries()).map(([k, v]) => [k, { ...v }])
      ),
      messages: messages.map((m) => ({ ...m })),
      announcements: new Map(
        Array.from(announcements.entries()).map(([k, v]) => [k, { ...v }])
      ),
      announcementRecipients: announcementRecipients.map((r) => ({ ...r })),
      nextEntryId,
    };
  }

  function restoreState(snapshot) {
    businesses = snapshot.businesses;
    contextEntries = snapshot.contextEntries;
    customers = snapshot.customers;
    conversations = snapshot.conversations;
    messages = snapshot.messages;
    announcements = snapshot.announcements;
    announcementRecipients = snapshot.announcementRecipients;
    nextEntryId = snapshot.nextEntryId;
  }

  async function executeQuery(sql, params = []) {
    const normalized = sql.replace(/\s+/g, ' ').trim().toUpperCase();

    if (normalized === 'SELECT 1;') {
      return { rows: [{ '?column?': 1 }], rowCount: 1 };
    }

    // Businesses
    if (normalized.startsWith('INSERT INTO BUSINESSES')) {
      const [id, name] = params;
      const row = {
        id: id || crypto.randomUUID(),
        name,
        created_at: nextIsoTimestamp(),
      };
      businesses.set(row.id, row);
      return { rows: [row], rowCount: 1 };
    }

    if (
      normalized.startsWith(
        'SELECT ID, NAME, CREATED_AT FROM BUSINESSES WHERE ID = $1'
      )
    ) {
      const [id] = params;
      const biz = businesses.get(id);
      if (!biz) {
        return { rows: [], rowCount: 0 };
      }
      return { rows: [{ ...biz }], rowCount: 1 };
    }

    // Context Entries
    if (normalized.startsWith('INSERT INTO CONTEXT_ENTRIES')) {
      const [businessId, category, title, content, sourceFile] = params;
      if (!businesses.has(businessId)) {
        const fkErr = new Error('Foreign key violation');
        fkErr.code = '23503';
        throw fkErr;
      }

      const now = nextIsoTimestamp();
      const existingIndex = contextEntries.findIndex(
        (e) =>
          e.business_id === businessId &&
          e.category === category &&
          e.title === title
      );

      if (existingIndex === -1) {
        const newEntry = {
          id: nextEntryId++,
          business_id: businessId,
          category,
          title,
          content,
          source_file: sourceFile,
          created_at: now,
          updated_at: now,
          inserted: true,
        };
        contextEntries.push(newEntry);
        return { rows: [{ ...newEntry }], rowCount: 1 };
      } else {
        const updatedEntry = {
          ...contextEntries[existingIndex],
          content,
          source_file: sourceFile,
          updated_at: now,
          inserted: false,
        };
        contextEntries[existingIndex] = updatedEntry;
        return { rows: [{ ...updatedEntry }], rowCount: 1 };
      }
    }

    if (
      normalized.startsWith(
        'SELECT ID, BUSINESS_ID, CATEGORY, TITLE, CONTENT, SOURCE_FILE, CREATED_AT, UPDATED_AT FROM CONTEXT_ENTRIES WHERE BUSINESS_ID = $1'
      )
    ) {
      const [businessId] = params;
      const rows = contextEntries
        .filter((e) => e.business_id === businessId)
        .sort((a, b) => a.id - b.id)
        .map((e) => ({ ...e }));
      return { rows, rowCount: rows.length };
    }

    // Customers
    if (
      normalized.startsWith(
        'SELECT ID, BUSINESS_ID, CUSTOMER_NAME, EMAIL, EXTERNAL_CUSTOMER_ID, CREATED_AT, UPDATED_AT FROM CUSTOMERS WHERE BUSINESS_ID = $1 AND EMAIL = $2'
      )
    ) {
      const [businessId, email] = params;
      const found = Array.from(customers.values()).find(
        (c) => c.business_id === businessId && c.email === email
      );
      return found
        ? { rows: [{ ...found }], rowCount: 1 }
        : { rows: [], rowCount: 0 };
    }

    if (normalized.startsWith('INSERT INTO CUSTOMERS')) {
      const [businessId, customerName, email, externalCustomerId] = params;
      if (!businesses.has(businessId)) {
        const fkErr = new Error('Foreign key violation on businesses');
        fkErr.code = '23503';
        throw fkErr;
      }

      const now = nextIsoTimestamp();
      const existing = Array.from(customers.values()).find(
        (c) =>
          c.business_id === businessId &&
          c.email !== null &&
          c.email === email
      );

      if (normalized.includes('ON CONFLICT (BUSINESS_ID, EMAIL)')) {
        if (!existing) {
          const row = {
            id: crypto.randomUUID(),
            business_id: businessId,
            customer_name: customerName,
            email,
            external_customer_id: externalCustomerId ?? null,
            created_at: now,
            updated_at: now,
            inserted: true,
          };
          customers.set(row.id, row);
          return { rows: [{ ...row }], rowCount: 1 };
        } else {
          const updated = {
            ...existing,
            customer_name: customerName,
            external_customer_id:
              externalCustomerId !== null && externalCustomerId !== undefined
                ? externalCustomerId
                : existing.external_customer_id,
            updated_at: now,
            inserted: false,
          };
          customers.set(updated.id, updated);
          return { rows: [{ ...updated }], rowCount: 1 };
        }
      }

      if (existing) {
        const uqErr = new Error(
          'duplicate key value violates unique constraint "uq_customers_business_email"'
        );
        uqErr.code = '23505';
        throw uqErr;
      }

      const row = {
        id: crypto.randomUUID(),
        business_id: businessId,
        customer_name: customerName,
        email,
        external_customer_id: externalCustomerId ?? null,
        created_at: now,
        updated_at: now,
      };
      customers.set(row.id, row);
      return { rows: [{ ...row }], rowCount: 1 };
    }

    if (
      normalized.startsWith(
        'SELECT ID, BUSINESS_ID, CUSTOMER_NAME, EMAIL, EXTERNAL_CUSTOMER_ID, CREATED_AT, UPDATED_AT FROM CUSTOMERS WHERE ID = $1'
      )
    ) {
      const [id] = params;
      const cust = customers.get(id);
      if (!cust) {
        return { rows: [], rowCount: 0 };
      }
      return { rows: [{ ...cust }], rowCount: 1 };
    }

    if (normalized.startsWith('UPDATE CUSTOMERS SET CREATED_AT = $2 WHERE ID = $1')) {
      const [id, createdAt] = params;
      const cust = customers.get(id);
      if (!cust) return { rows: [], rowCount: 0 };
      cust.created_at = new Date(createdAt).toISOString();
      customers.set(id, cust);
      return { rows: [{ ...cust }], rowCount: 1 };
    }

    if (
      normalized.startsWith(
        'SELECT ID, BUSINESS_ID, CUSTOMER_NAME, EMAIL, EXTERNAL_CUSTOMER_ID, CREATED_AT, UPDATED_AT FROM CUSTOMERS WHERE BUSINESS_ID = $1 AND CUSTOMER_NAME IS NOT NULL'
      )
    ) {
      const [businessId] = params;
      let rows = Array.from(customers.values()).filter(
        (c) =>
          c.business_id === businessId &&
          c.customer_name &&
          String(c.customer_name).trim().length > 0 &&
          c.email &&
          String(c.email).trim().length > 0
      );

      for (let i = 1; i < params.length; i += 1) {
        const val = params[i];
        const ph = `$${i + 1}`;
        if (normalized.includes(`CREATED_AT > ${ph}`)) {
          const cutoff = new Date(val).getTime();
          rows = rows.filter((c) => new Date(c.created_at).getTime() > cutoff);
        } else if (normalized.includes(`CREATED_AT >= ${ph}`)) {
          const cutoff = new Date(val).getTime();
          rows = rows.filter((c) => new Date(c.created_at).getTime() >= cutoff);
        } else if (normalized.includes(`CREATED_AT < ${ph}`)) {
          const cutoff = new Date(val).getTime();
          rows = rows.filter((c) => new Date(c.created_at).getTime() < cutoff);
        } else if (normalized.includes(`CREATED_AT <= ${ph}`)) {
          const cutoff = new Date(val).getTime();
          rows = rows.filter((c) => new Date(c.created_at).getTime() <= cutoff);
        } else if (normalized.includes(`CREATED_AT::DATE = ${ph}::DATE`)) {
          const targetDate = String(val).slice(0, 10);
          rows = rows.filter((c) => String(c.created_at).slice(0, 10) === targetDate);
        } else if (normalized.includes(`EMAIL ILIKE ${ph}`)) {
          const needle = String(val).replace(/^%|%$/g, '').toLowerCase();
          rows = rows.filter((c) => c.email.toLowerCase().includes(needle));
        }
      }

      rows = rows
        .sort((a, b) => {
          const tDiff =
            new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
          if (tDiff !== 0) return tDiff;
          return a.id.localeCompare(b.id);
        })
        .map((c) => ({ ...c }));
      return { rows, rowCount: rows.length };
    }

    if (
      normalized.startsWith(
        'SELECT COUNT(*)::INT AS COUNT FROM CUSTOMERS WHERE BUSINESS_ID = $1'
      )
    ) {
      const [businessId] = params;
      const count = Array.from(customers.values()).filter(
        (c) =>
          c.business_id === businessId &&
          c.customer_name &&
          String(c.customer_name).trim().length > 0 &&
          c.email &&
          String(c.email).trim().length > 0
      ).length;
      return { rows: [{ count }], rowCount: 1 };
    }

    // Conversations
    if (normalized.startsWith('INSERT INTO CONVERSATIONS')) {
      const [businessId, customerId, status] = params;
      if (!businesses.has(businessId)) {
        const fkErr = new Error('Foreign key violation on businesses');
        fkErr.code = '23503';
        throw fkErr;
      }
      const cust = customers.get(customerId);
      if (!cust) {
        const fkErr = new Error('Foreign key violation on customers');
        fkErr.code = '23503';
        throw fkErr;
      }
      // Composite FK constraint (customer_id, business_id) REFERENCES customers(id, business_id)
      if (cust.business_id !== businessId) {
        const fkErr = new Error(
          'insert or update on table "conversations" violates foreign key constraint "fk_conversations_customer_business"'
        );
        fkErr.code = '23503';
        fkErr.constraint = 'fk_conversations_customer_business';
        throw fkErr;
      }

      const now = nextIsoTimestamp();
      const row = {
        id: crypto.randomUUID(),
        business_id: businessId,
        customer_id: customerId,
        status: status || 'open',
        ai_draft_reply: null,
        ai_draft_category: null,
        ai_draft_missing_info: null,
        ai_draft_message_id: null,
        ai_draft_updated_at: null,
        created_at: now,
        updated_at: now,
      };
      conversations.set(row.id, row);
      return { rows: [{ ...row }], rowCount: 1 };
    }

    if (
      normalized.startsWith(
        'SELECT ID, BUSINESS_ID, CUSTOMER_ID, STATUS, CREATED_AT, UPDATED_AT FROM CONVERSATIONS WHERE ID = $1 AND BUSINESS_ID = $2'
      ) ||
      normalized.startsWith(
        'SELECT ID, BUSINESS_ID, CUSTOMER_ID, STATUS, AI_DRAFT_REPLY, AI_DRAFT_CATEGORY, AI_DRAFT_MISSING_INFO, AI_DRAFT_MESSAGE_ID, AI_DRAFT_UPDATED_AT, CREATED_AT, UPDATED_AT FROM CONVERSATIONS WHERE ID = $1 AND BUSINESS_ID = $2'
      )
    ) {
      const [conversationId, businessId] = params;
      const conv = conversations.get(conversationId);
      if (!conv || conv.business_id !== businessId) {
        return { rows: [], rowCount: 0 };
      }
      return { rows: [{ ...conv }], rowCount: 1 };
    }

    if (
      normalized.startsWith(
        'SELECT ID, BUSINESS_ID, CUSTOMER_ID, STATUS, CREATED_AT, UPDATED_AT FROM CONVERSATIONS WHERE BUSINESS_ID = $1 AND CUSTOMER_ID = $2 ORDER BY UPDATED_AT DESC, CREATED_AT DESC, ID DESC'
      )
    ) {
      const [businessId, customerId] = params;
      const rows = Array.from(conversations.values())
        .filter(
          (c) => c.business_id === businessId && c.customer_id === customerId
        )
        .sort((a, b) => {
          const tDiff =
            new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime();
          if (tDiff !== 0) return tDiff;
          return b.id.localeCompare(a.id);
        })
        .map((c) => ({ ...c }));
      return { rows, rowCount: rows.length };
    }

    if (
      normalized.startsWith(
        'SELECT ID, BUSINESS_ID, CUSTOMER_ID, STATUS, AI_DRAFT_REPLY, AI_DRAFT_CATEGORY, AI_DRAFT_MISSING_INFO, AI_DRAFT_MESSAGE_ID, AI_DRAFT_UPDATED_AT, CREATED_AT, UPDATED_AT FROM CONVERSATIONS WHERE BUSINESS_ID = $1 ORDER BY UPDATED_AT DESC, CREATED_AT DESC, ID DESC'
      )
    ) {
      const [businessId] = params;
      const rows = Array.from(conversations.values())
        .filter((c) => c.business_id === businessId)
        .sort((a, b) => {
          const tDiff =
            new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime();
          if (tDiff !== 0) return tDiff;
          return b.id.localeCompare(a.id);
        })
        .map((c) => ({ ...c }));
      return { rows, rowCount: rows.length };
    }

    if (
      normalized.startsWith(
        'UPDATE CONVERSATIONS SET UPDATED_AT = NOW() WHERE ID = $1 AND BUSINESS_ID = $2'
      )
    ) {
      const [conversationId, businessId] = params;
      const conv = conversations.get(conversationId);
      if (!conv || conv.business_id !== businessId) {
        return { rows: [], rowCount: 0 };
      }
      conv.updated_at = nextIsoTimestamp();
      return { rows: [{ ...conv }], rowCount: 1 };
    }

    if (
      normalized.startsWith(
        'UPDATE CONVERSATIONS SET AI_DRAFT_REPLY = $3, AI_DRAFT_CATEGORY = $4, AI_DRAFT_MISSING_INFO = $5::JSONB, AI_DRAFT_MESSAGE_ID = $6, AI_DRAFT_UPDATED_AT = NOW() WHERE ID = $1 AND BUSINESS_ID = $2'
      )
    ) {
      const [
        conversationId,
        businessId,
        draftReply,
        draftCategory,
        draftMissingInfo,
        draftMessageId,
      ] = params;
      const conv = conversations.get(conversationId);
      if (!conv || conv.business_id !== businessId) {
        return { rows: [], rowCount: 0 };
      }
      conv.ai_draft_reply = draftReply;
      conv.ai_draft_category = draftCategory;
      conv.ai_draft_missing_info = draftMissingInfo;
      conv.ai_draft_message_id = draftMessageId;
      conv.ai_draft_updated_at = nextIsoTimestamp();
      return { rows: [{ ...conv }], rowCount: 1 };
    }

    if (
      normalized.startsWith(
        'UPDATE CONVERSATIONS SET AI_DRAFT_REPLY = NULL, AI_DRAFT_CATEGORY = NULL, AI_DRAFT_MISSING_INFO = NULL, AI_DRAFT_MESSAGE_ID = NULL, AI_DRAFT_UPDATED_AT = NOW() WHERE ID = $1 AND BUSINESS_ID = $2'
      )
    ) {
      const [conversationId, businessId] = params;
      const conv = conversations.get(conversationId);
      if (!conv || conv.business_id !== businessId) {
        return { rows: [], rowCount: 0 };
      }
      conv.ai_draft_reply = null;
      conv.ai_draft_category = null;
      conv.ai_draft_missing_info = null;
      conv.ai_draft_message_id = null;
      conv.ai_draft_updated_at = nextIsoTimestamp();
      return { rows: [{ ...conv }], rowCount: 1 };
    }

    if (
      normalized.startsWith(
        'UPDATE CONVERSATIONS SET STATUS = $3, UPDATED_AT = NOW() WHERE ID = $1 AND BUSINESS_ID = $2'
      )
    ) {
      const [conversationId, businessId, status] = params;
      const conv = conversations.get(conversationId);
      if (!conv || conv.business_id !== businessId) {
        return { rows: [], rowCount: 0 };
      }
      conv.status = status;
      conv.updated_at = nextIsoTimestamp();
      return { rows: [{ ...conv }], rowCount: 1 };
    }

    // Messages
    if (normalized.startsWith('INSERT INTO MESSAGES')) {
      const [conversationId, senderType, content] = params;
      if (!conversations.has(conversationId)) {
        const fkErr = new Error('Foreign key violation on conversations');
        fkErr.code = '23503';
        throw fkErr;
      }
      if (!['customer', 'agent'].includes(senderType)) {
        const checkErr = new Error('Check constraint violation on sender_type');
        checkErr.code = '23514';
        throw checkErr;
      }
      const row = {
        id: crypto.randomUUID(),
        conversation_id: conversationId,
        sender_type: senderType,
        content,
        ai_suggestion: null,
        ai_category: null,
        ai_missing_info: null,
        created_at: nextIsoTimestamp(),
      };
      messages.push(row);
      return { rows: [{ ...row }], rowCount: 1 };
    }

    if (
      normalized.startsWith(
        'UPDATE MESSAGES SET AI_SUGGESTION = $2, AI_CATEGORY = $3, AI_MISSING_INFO = $4::JSONB WHERE ID = $1'
      )
    ) {
      const [messageId, suggestion, category, missingInfo] = params;
      const msg = messages.find((m) => m.id === messageId);
      if (!msg) {
        return { rows: [], rowCount: 0 };
      }
      msg.ai_suggestion = suggestion;
      msg.ai_category = category;
      msg.ai_missing_info = missingInfo;
      return { rows: [{ ...msg }], rowCount: 1 };
    }

    // Full chronological messages for a conversation
    if (
      normalized.startsWith(
        'SELECT ID, CONVERSATION_ID, SENDER_TYPE, CONTENT, CREATED_AT FROM MESSAGES WHERE CONVERSATION_ID = $1 ORDER BY CREATED_AT ASC, ID ASC'
      ) ||
      normalized.startsWith(
        'SELECT ID, CONVERSATION_ID, SENDER_TYPE, CONTENT, AI_SUGGESTION, AI_CATEGORY, AI_MISSING_INFO, CREATED_AT FROM MESSAGES WHERE CONVERSATION_ID = $1 ORDER BY CREATED_AT ASC, ID ASC'
      )
    ) {
      const [conversationId] = params;
      const rows = messages
        .filter((m) => m.conversation_id === conversationId)
        .sort((a, b) => {
          const tDiff =
            new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
          if (tDiff !== 0) return tDiff;
          return a.id.localeCompare(b.id);
        })
        .map((m) => ({ ...m }));
      return { rows, rowCount: rows.length };
    }

    // Bounded latest N messages selected in reverse chronological order and returned in chronological order
    if (
      normalized.startsWith(
        'SELECT ID, CONVERSATION_ID, SENDER_TYPE, CONTENT, CREATED_AT FROM ( SELECT ID, CONVERSATION_ID, SENDER_TYPE, CONTENT, CREATED_AT FROM MESSAGES WHERE CONVERSATION_ID = $1 ORDER BY CREATED_AT DESC, ID DESC LIMIT $2 ) AS RECENT_MESSAGES ORDER BY CREATED_AT ASC, ID ASC'
      )
    ) {
      const [conversationId, limit] = params;
      const descSlice = messages
        .filter((m) => m.conversation_id === conversationId)
        .sort((a, b) => {
          const tDiff =
            new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
          if (tDiff !== 0) return tDiff;
          return b.id.localeCompare(a.id);
        })
        .slice(0, Number(limit));

      const ascRows = descSlice
        .sort((a, b) => {
          const tDiff =
            new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
          if (tDiff !== 0) return tDiff;
          return a.id.localeCompare(b.id);
        })
        .map((m) => ({ ...m }));

      return { rows: ascRows, rowCount: ascRows.length };
    }

    // Announcements
    if (normalized.startsWith('INSERT INTO ANNOUNCEMENTS')) {
      const [
        businessId,
        announcementPrompt,
        subject,
        body,
        targetCriteria,
        audienceDescription,
        recipientCount,
      ] = params;
      if (!businesses.has(businessId)) {
        const fkErr = new Error('Foreign key violation on businesses');
        fkErr.code = '23503';
        throw fkErr;
      }
      const now = nextIsoTimestamp();
      const parsedCriteria =
        typeof targetCriteria === 'string'
          ? JSON.parse(targetCriteria)
          : targetCriteria || { status: 'ok', scope: 'all', filters: [] };
      const row = {
        id: crypto.randomUUID(),
        business_id: businessId,
        announcement_prompt: announcementPrompt,
        subject,
        body,
        target_criteria: parsedCriteria,
        audience_description: audienceDescription || 'All registered customers',
        status: 'draft',
        total_recipients: Number(recipientCount) || 0,
        sent_count: 0,
        failed_count: 0,
        sent_at: null,
        created_at: now,
        updated_at: now,
      };
      announcements.set(row.id, row);
      return { rows: [{ ...row }], rowCount: 1 };
    }

    if (
      normalized.startsWith('SELECT') &&
      normalized.includes('FROM ANNOUNCEMENTS WHERE BUSINESS_ID = $1 ORDER BY CREATED_AT DESC')
    ) {
      const [businessId] = params;
      const rows = Array.from(announcements.values())
        .filter((a) => a.business_id === businessId)
        .sort((a, b) => {
          const tDiff =
            new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
          if (tDiff !== 0) return tDiff;
          return b.id.localeCompare(a.id);
        })
        .map((a) => ({ ...a }));
      return { rows, rowCount: rows.length };
    }

    if (
      normalized.startsWith('SELECT') &&
      normalized.includes('FROM ANNOUNCEMENT_RECIPIENTS WHERE ANNOUNCEMENT_ID = ANY')
    ) {
      const [ids] = params;
      const idSet = new Set(Array.isArray(ids) ? ids : []);
      const rows = announcementRecipients
        .filter((r) => idSet.has(r.announcement_id))
        .map((r) => ({ ...r }));
      return { rows, rowCount: rows.length };
    }

    if (
      normalized.startsWith('SELECT') &&
      normalized.includes('FROM ANNOUNCEMENTS WHERE ID = $1 AND BUSINESS_ID = $2')
    ) {
      const [announcementId, businessId] = params;
      const ann = announcements.get(announcementId);
      if (!ann || ann.business_id !== businessId) {
        return { rows: [], rowCount: 0 };
      }
      return { rows: [{ ...ann }], rowCount: 1 };
    }

    if (
      normalized.startsWith(
        "UPDATE ANNOUNCEMENTS SET SUBJECT = $3, BODY = $4, STATUS = 'SENDING', TOTAL_RECIPIENTS = $5, UPDATED_AT = NOW() WHERE ID = $1 AND BUSINESS_ID = $2"
      )
    ) {
      const [announcementId, businessId, subject, body, totalRecipients] =
        params;
      const ann = announcements.get(announcementId);
      if (!ann || ann.business_id !== businessId) {
        return { rows: [], rowCount: 0 };
      }
      ann.subject = subject;
      ann.body = body;
      ann.status = 'sending';
      ann.total_recipients = Number(totalRecipients);
      ann.updated_at = nextIsoTimestamp();
      return { rows: [{ ...ann }], rowCount: 1 };
    }

    if (
      normalized.startsWith(
        'UPDATE ANNOUNCEMENTS SET STATUS = $3, TOTAL_RECIPIENTS = $4, SENT_COUNT = $5, FAILED_COUNT = $6, SENT_AT = NOW(), UPDATED_AT = NOW() WHERE ID = $1 AND BUSINESS_ID = $2'
      )
    ) {
      const [
        announcementId,
        businessId,
        status,
        totalRecipients,
        sentCount,
        failedCount,
      ] = params;
      const ann = announcements.get(announcementId);
      if (!ann || ann.business_id !== businessId) {
        return { rows: [], rowCount: 0 };
      }
      const now = nextIsoTimestamp();
      ann.status = status;
      ann.total_recipients = Number(totalRecipients);
      ann.sent_count = Number(sentCount);
      ann.failed_count = Number(failedCount);
      ann.sent_at = now;
      ann.updated_at = now;
      return { rows: [{ ...ann }], rowCount: 1 };
    }

    // Announcement Recipients
    if (normalized.startsWith('INSERT INTO ANNOUNCEMENT_RECIPIENTS')) {
      const [
        announcementId,
        customerId,
        customerName,
        email,
        status,
        errorMessage,
      ] = params;
      const now = nextIsoTimestamp();
      const existingIdx = announcementRecipients.findIndex(
        (r) => r.announcement_id === announcementId && r.email === email
      );
      if (existingIdx !== -1) {
        announcementRecipients[existingIdx].status = status;
        announcementRecipients[existingIdx].error_message = errorMessage;
        announcementRecipients[existingIdx].sent_at = now;
        return {
          rows: [{ ...announcementRecipients[existingIdx] }],
          rowCount: 1,
        };
      }
      const row = {
        id: crypto.randomUUID(),
        announcement_id: announcementId,
        customer_id: customerId,
        customer_name: customerName,
        email,
        status,
        error_message: errorMessage || null,
        sent_at: now,
      };
      announcementRecipients.push(row);
      return { rows: [{ ...row }], rowCount: 1 };
    }

    throw new Error(`Unsupported SQL in test pool: ${normalized}`);
  }

  return {
    async query(sql, params) {
      return executeQuery(sql, params);
    },
    async connect() {
      let snapshot = null;
      return {
        async query(sql, params) {
          const cmd = sql.trim().toUpperCase();
          if (cmd === 'BEGIN') {
            snapshot = cloneState();
            return { rows: [], rowCount: 0 };
          }
          if (cmd === 'COMMIT') {
            snapshot = null;
            return { rows: [], rowCount: 0 };
          }
          if (cmd === 'ROLLBACK') {
            if (snapshot) {
              restoreState(snapshot);
              snapshot = null;
            }
            return { rows: [], rowCount: 0 };
          }
          return executeQuery(sql, params);
        },
        release() {},
      };
    },
    async end() {},
    getInternalEntries() {
      return contextEntries;
    },
    getInternalMessages() {
      return messages;
    },
    getInternalCustomers() {
      return Array.from(customers.values());
    },
    getInternalAnnouncements() {
      return Array.from(announcements.values());
    },
    getInternalAnnouncementRecipients() {
      return announcementRecipients;
    },
  };
}

describe('Echo Customer-Support Assistant — Phase 1, Phase 2 & Phase 3 Workflow Tests', () => {
  let server;
  let baseUrl;
  let mockPool;
  let businessAId;
  let businessBId;
  let lastDispatchedPrompt = '';
  let lastDispatchedAnnouncementPrompt = '';
  let sentEmailsLog = [];
  let failingEmailsSet = new Set();

  before(async () => {
    mockPool = createInMemoryPostgresPool();
    setPool(mockPool);

    setGeminiGenerator(async (promptText) => {
      lastDispatchedPrompt = promptText;
      return {
        category: 'cancellation_policy',
        suggestions: [
          'We would be happy to help you reschedule your appointment. Please let us know at least 24 hours in advance and share your preferred time.',
          'Extra suggestion that must be stripped to enforce singularity.',
        ],
        missing_information: ['Preferred new appointment date and time'],
      };
    });

    setAnnouncementGeminiGenerator(async (promptText) => {
      lastDispatchedAnnouncementPrompt = promptText;
      return {
        subject: 'Enjoy 10% Off Service X',
        body: 'Hello {{customer_name}},\n\nWe are pleased to offer you a 10% discount on Service X. Contact us to learn more.\n\nBest regards,\nExample Home Renovations',
      };
    });

    setMailTransporter({
      async sendMail(mailOptions) {
        if (failingEmailsSet.has(mailOptions.to)) {
          throw new Error(`Simulated SMTP bounce for ${mailOptions.to}`);
        }
        sentEmailsLog.push({ ...mailOptions });
        return { messageId: `<mock-${crypto.randomUUID()}@example.test>` };
      },
    });

    await new Promise((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        const address = server.address();
        baseUrl = `http://127.0.0.1:${address.port}`;
        resolve();
      });
    });
  });

  after(async () => {
    setGeminiGenerator(null);
    setAnnouncementGeminiGenerator(null);
    setMailTransporter(null);
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  // =========================================================================
  // Phase 1 Tests
  // =========================================================================

  it('1. GET /health and GET /api/health return 200 OK', async () => {
    const res1 = await fetch(`${baseUrl}/health?db=true`);
    assert.equal(res1.status, 200);
    const body1 = await res1.json();
    assert.equal(body1.status, 'ok');
    assert.equal(body1.database, 'connected');

    const res2 = await fetch(`${baseUrl}/api/health`);
    assert.equal(res2.status, 200);
  });

  it('2. POST /api/businesses creates businesses and validates request body', async () => {
    const badRes = await fetch(`${baseUrl}/api/businesses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '   ' }),
    });
    assert.equal(badRes.status, 400);

    const resA = await fetch(`${baseUrl}/api/businesses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Example Home Renovations' }),
    });
    assert.equal(resA.status, 201);
    const dataA = await resA.json();
    assert.ok(dataA.id);
    assert.equal(dataA.name, 'Example Home Renovations');
    businessAId = dataA.id;

    const resB = await fetch(`${baseUrl}/api/businesses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Other Gadgets Corp' }),
    });
    assert.equal(resB.status, 201);
    const dataB = await resB.json();
    businessBId = dataB.id;
  });

  it('3. POST /api/businesses/:businessId/context/upload imports valid CSV with commas and line breaks', async () => {
    const csvContent = [
      'category,title,content',
      'company_info,Company Overview,"We provide home renovation, remodeling, and consultation services."',
      'refund_policy,Refund Eligibility,"Customers may request a refund within 7 days if the service has not started.\nRequests must include the booking reference."',
      'cancellation_policy,Appointment Cancellation,"Customers should cancel or reschedule at least 24 hours before their appointment."',
      'support_process,Human Support,"Escalate unresolved disputes to a human support representative."',
    ].join('\n');

    const formData = new FormData();
    formData.append(
      'file',
      new Blob([csvContent], { type: 'text/csv' }),
      'initial-policies.csv'
    );

    const res = await fetch(
      `${baseUrl}/api/businesses/${businessAId}/context/upload`,
      {
        method: 'POST',
        body: formData,
      }
    );

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.totalProcessed, 4);
    assert.equal(body.insertedCount, 4);
    assert.equal(body.updatedCount, 0);
    assert.equal(body.sourceFile, 'initial-policies.csv');
  });

  it('4. Re-uploading an existing (business_id, category, title) record updates it instead of duplicating', async () => {
    const updatedCsv = [
      'category,title,content',
      'refund_policy,Refund Eligibility,"Updated policy: Customers may request a full refund within 14 days if the service has not started."',
      'warranty_policy,Workmanship Warranty,"All renovation work includes a 2-year workmanship warranty."',
    ].join('\n');

    const formData = new FormData();
    formData.append(
      'file',
      new Blob([updatedCsv], { type: 'text/csv' }),
      'updated-policies.csv'
    );

    const res = await fetch(
      `${baseUrl}/api/businesses/${businessAId}/context/upload`,
      {
        method: 'POST',
        body: formData,
      }
    );

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.totalProcessed, 2);
    assert.equal(body.insertedCount, 1);
    assert.equal(body.updatedCount, 1);

    const entriesForA = mockPool
      .getInternalEntries()
      .filter((e) => e.business_id === businessAId);
    assert.equal(entriesForA.length, 5);

    const refundEntry = entriesForA.find((e) => e.category === 'refund_policy');
    assert.ok(refundEntry.content.includes('within 14 days'));
    assert.equal(refundEntry.source_file, 'updated-policies.csv');
  });

  it('5. Rejects invalid CSV uploads (missing columns, empty values, non-CSV files, unknown business)', async () => {
    const badFileForm = new FormData();
    badFileForm.append(
      'file',
      new Blob(['{"hello":"world"}'], { type: 'application/json' }),
      'policies.json'
    );
    const resNonCsv = await fetch(
      `${baseUrl}/api/businesses/${businessAId}/context/upload`,
      { method: 'POST', body: badFileForm }
    );
    assert.equal(resNonCsv.status, 400);

    const badHeaderForm = new FormData();
    badHeaderForm.append(
      'file',
      new Blob(['category,title\nrefund_policy,Refunds'], { type: 'text/csv' }),
      'bad-headers.csv'
    );
    const resBadHeader = await fetch(
      `${baseUrl}/api/businesses/${businessAId}/context/upload`,
      { method: 'POST', body: badHeaderForm }
    );
    assert.equal(resBadHeader.status, 400);
    const errHeader = await resBadHeader.json();
    assert.match(errHeader.error, /Missing required column/i);

    const emptyValForm = new FormData();
    emptyValForm.append(
      'file',
      new Blob(['category,title,content\nrefund_policy,,Some text'], {
        type: 'text/csv',
      }),
      'missing-val.csv'
    );
    const resEmptyVal = await fetch(
      `${baseUrl}/api/businesses/${businessAId}/context/upload`,
      { method: 'POST', body: emptyValForm }
    );
    assert.equal(resEmptyVal.status, 400);
    const errVal = await resEmptyVal.json();
    assert.match(errVal.error, /row 2/i);

    const unknownId = '00000000-0000-4000-8000-000000000000';
    const validForm = new FormData();
    validForm.append(
      'file',
      new Blob(['category,title,content\ninfo,Title,Text'], {
        type: 'text/csv',
      }),
      'valid.csv'
    );
    const resNotFound = await fetch(
      `${baseUrl}/api/businesses/${unknownId}/context/upload`,
      { method: 'POST', body: validForm }
    );
    assert.equal(resNotFound.status, 404);
  });

  it('6. POST /api/businesses/:businessId/prompt returns only plain-text prompt with relevant records', async () => {
    const res = await fetch(`${baseUrl}/api/businesses/${businessAId}/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: 'Can I cancel my appointment and get a refund?',
      }),
    });

    assert.equal(res.status, 200);
    const contentType = res.headers.get('content-type') || '';
    assert.match(contentType, /text\/plain/i);

    const promptText = await res.text();

    assert.match(promptText, /^ROLE\b/m);
    assert.match(promptText, /^OBJECTIVE\b/m);
    assert.match(promptText, /^BUSINESS CONTEXT\b/m);
    assert.match(promptText, /^CONVERSATION HISTORY\b/m);
    assert.match(promptText, /^CUSTOMER MESSAGE\b/m);
    assert.match(promptText, /^RULES\b/m);
    assert.match(promptText, /^OUTPUT FORMAT\b/m);

    assert.ok(promptText.includes('Business Name: Example Home Renovations'));
    assert.ok(promptText.includes('Category: cancellation_policy'));
    assert.ok(promptText.includes('Title: Appointment Cancellation'));
    assert.ok(promptText.includes('Category: refund_policy'));
    assert.ok(promptText.includes('Title: Refund Eligibility'));
    assert.ok(promptText.includes('within 14 days'));

    assert.ok(!promptText.includes('Title: Company Overview'));
    assert.ok(!promptText.includes('Title: Workmanship Warranty'));
  });

  it('7. Explicitly indicates when no relevant business context is found and never leaks other businesses', async () => {
    const resB = await fetch(`${baseUrl}/api/businesses/${businessBId}/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: 'Can I cancel my appointment and get a refund?',
      }),
    });

    assert.equal(resB.status, 200);
    const promptB = await resB.text();
    assert.ok(promptB.includes('Business Name: Other Gadgets Corp'));
    assert.ok(
      promptB.includes(
        'No relevant business context was found for this customer message.'
      )
    );
    assert.ok(!promptB.includes('Example Home Renovations'));
    assert.ok(!promptB.includes('Appointment Cancellation'));

    const resUnrelated = await fetch(
      `${baseUrl}/api/businesses/${businessAId}/prompt`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: 'Do you ship international cryptocurrency hardware wallets?',
        }),
      }
    );
    assert.equal(resUnrelated.status, 200);
    const promptUnrelated = await resUnrelated.text();
    assert.ok(
      promptUnrelated.includes(
        'No relevant business context was found for this customer message.'
      )
    );
  });

  // =========================================================================
  // Phase 2 Tests: Persistent Multi-Turn Customer Conversations
  // =========================================================================

  let customerAId;
  let customerBId;
  let conversationAId;

  it('8. Creates a customer and a new conversation with empty initial history', async () => {
    // Create customer for Business A
    const custResA = await fetch(
      `${baseUrl}/api/businesses/${businessAId}/customers`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customer_name: 'Alice Renovator',
          email: 'Alice.Renovator@Example.test',
          external_customer_id: 'ext-cust-001',
        }),
      }
    );
    assert.equal(custResA.status, 201);
    const custA = await custResA.json();
    assert.ok(custA.id);
    assert.equal(custA.business_id, businessAId);
    assert.equal(custA.customer_name, 'Alice Renovator');
    assert.equal(custA.email, 'alice.renovator@example.test');
    assert.equal(custA.external_customer_id, 'ext-cust-001');
    customerAId = custA.id;

    // Create customer for Business B (without external_customer_id)
    const custResB = await fetch(
      `${baseUrl}/api/businesses/${businessBId}/customers`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customer_name: 'Bob Gadget',
          email: 'bob.gadget@example.test',
        }),
      }
    );
    assert.equal(custResB.status, 201);
    const custB = await custResB.json();
    assert.ok(custB.id);
    assert.equal(custB.business_id, businessBId);
    assert.equal(custB.customer_name, 'Bob Gadget');
    assert.equal(custB.email, 'bob.gadget@example.test');
    assert.equal(custB.external_customer_id, null);
    customerBId = custB.id;

    // Create conversation for Customer A under Business A
    const convRes = await fetch(
      `${baseUrl}/api/businesses/${businessAId}/conversations`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ customer_id: customerAId }),
      }
    );
    assert.equal(convRes.status, 201);
    const conv = await convRes.json();
    assert.ok(conv.id);
    assert.equal(conv.business_id, businessAId);
    assert.equal(conv.customer_id, customerAId);
    assert.equal(conv.status, 'open');
    assert.deepEqual(conv.messages, []);
    conversationAId = conv.id;

    // GET conversation verifies empty history on a new conversation
    const getRes = await fetch(
      `${baseUrl}/api/businesses/${businessAId}/conversations/${conversationAId}`
    );
    assert.equal(getRes.status, 200);
    const getBody = await getRes.json();
    assert.equal(getBody.id, conversationAId);
    assert.equal(getBody.status, 'open');
    assert.deepEqual(getBody.messages, []);
  });

  it('9. First and second customer messages save AI suggestion server-side without exposing it to customer, include earlier conversation in prompt, preserve chronological order, and do not fabricate agent messages', async () => {
    const beforeConvRes = await fetch(
      `${baseUrl}/api/businesses/${businessAId}/conversations/${conversationAId}`
    );
    const beforeConv = await beforeConvRes.json();

    // First customer message
    const msg1Res = await fetch(
      `${baseUrl}/api/businesses/${businessAId}/conversations/${conversationAId}/messages`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: 'Can you reschedule my appointment?',
        }),
      }
    );
    assert.equal(msg1Res.status, 201);
    assert.match(
      msg1Res.headers.get('content-type') || '',
      /application\/json/i
    );
    const savedMsg1 = await msg1Res.json();
    assert.equal(savedMsg1.sender_type, 'customer');
    assert.equal(savedMsg1.content, 'Can you reschedule my appointment?');
    // Privacy check: AI suggestion must NEVER be exposed in the customer-facing response
    assert.equal(savedMsg1.suggestions, undefined);
    assert.equal(savedMsg1.ai_suggestion, undefined);
    assert.equal(savedMsg1.ai_draft_reply, undefined);
    assert.equal(savedMsg1.category, undefined);

    const prompt1 = lastDispatchedPrompt;

    // On first message, there was no prior history before this message
    assert.ok(prompt1.includes('No prior messages in this conversation.'));
    assert.ok(prompt1.includes('Can you reschedule my appointment?'));
    assert.ok(prompt1.includes('Title: Appointment Cancellation'));

    // Second customer message ("Tomorrow afternoon.")
    const msg2Res = await fetch(
      `${baseUrl}/api/businesses/${businessAId}/conversations/${conversationAId}/messages`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: 'Tomorrow afternoon.',
        }),
      }
    );
    assert.equal(msg2Res.status, 201);
    const savedMsg2 = await msg2Res.json();
    assert.equal(savedMsg2.sender_type, 'customer');
    assert.equal(savedMsg2.suggestions, undefined);
    assert.equal(savedMsg2.ai_suggestion, undefined);
    const prompt2 = lastDispatchedPrompt;

    // Prompt 2 MUST include the earlier conversation in CONVERSATION HISTORY
    assert.ok(
      prompt2.includes(
        '[Message 1] Customer (customer): Can you reschedule my appointment?'
      )
    );
    // And the latest customer message in CUSTOMER MESSAGE
    assert.match(
      prompt2,
      /<customer_message>\s*Tomorrow afternoon\.\s*<\/customer_message>/
    );
    // And relevant business context for Business A only
    assert.ok(prompt2.includes('Business Name: Example Home Renovations'));
    assert.ok(prompt2.includes('Title: Appointment Cancellation'));

    // Third customer message to further verify chronological ordering
    const msg3Res = await fetch(
      `${baseUrl}/api/businesses/${businessAId}/conversations/${conversationAId}/messages`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: 'Around 2 PM works best for me.',
        }),
      }
    );
    assert.equal(msg3Res.status, 201);
    const savedMsg3 = await msg3Res.json();
    assert.equal(savedMsg3.sender_type, 'customer');
    assert.equal(savedMsg3.suggestions, undefined);
    const prompt3 = lastDispatchedPrompt;
    const idxMsg1 = prompt3.indexOf(
      '[Message 1] Customer (customer): Can you reschedule my appointment?'
    );
    const idxMsg2 = prompt3.indexOf(
      '[Message 2] Customer (customer): Tomorrow afternoon.'
    );
    assert.ok(idxMsg1 !== -1 && idxMsg2 !== -1 && idxMsg1 < idxMsg2);

    // Fetch conversation metadata and history via company GET endpoint
    const afterConvRes = await fetch(
      `${baseUrl}/api/businesses/${businessAId}/conversations/${conversationAId}`
    );
    assert.equal(afterConvRes.status, 200);
    const afterConv = await afterConvRes.json();

    // Verify updated_at was updated when new messages were added
    assert.notEqual(afterConv.updated_at, beforeConv.updated_at);

    // Confirm AI suggestion IS available on the company endpoint
    assert.ok(afterConv.ai_draft_reply);
    assert.ok(afterConv.ai_suggestion);
    assert.equal(afterConv.ai_suggestion.category, 'cancellation_policy');
    assert.ok(
      afterConv.ai_suggestion.suggestion.includes(
        'We would be happy to help you reschedule your appointment.'
      )
    );

    // Confirm generated suggestions were NOT stored as agent messages (only the 3 actual customer messages exist)
    assert.equal(afterConv.messages.length, 3);
    assert.ok(afterConv.messages.every((m) => m.sender_type === 'customer'));

    // Verify chronological order of returned messages
    assert.equal(
      afterConv.messages[0].content,
      'Can you reschedule my appointment?'
    );
    assert.equal(afterConv.messages[1].content, 'Tomorrow afternoon.');
    assert.equal(
      afterConv.messages[2].content,
      'Around 2 PM works best for me.'
    );
    assert.ok(
      new Date(afterConv.messages[0].created_at).getTime() <=
        new Date(afterConv.messages[1].created_at).getTime()
    );
    assert.ok(
      new Date(afterConv.messages[1].created_at).getTime() <=
        new Date(afterConv.messages[2].created_at).getTime()
    );
  });

  it('10. Rejects a conversation ID that belongs to another business and prevents cross-business customer assignment', async () => {
    // Prevent a customer from Business B from being assigned to a conversation under Business A
    const crossCustomerConvRes = await fetch(
      `${baseUrl}/api/businesses/${businessAId}/conversations`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ customer_id: customerBId }),
      }
    );
    assert.equal(crossCustomerConvRes.status, 400);
    const crossCustomerErr = await crossCustomerConvRes.json();
    assert.match(crossCustomerErr.error, /does not belong to the specified business/i);

    // Reject GET for Business A's conversation when accessed under Business B
    const wrongBizGetRes = await fetch(
      `${baseUrl}/api/businesses/${businessBId}/conversations/${conversationAId}`
    );
    assert.equal(wrongBizGetRes.status, 404);

    // Reject POST message to Business A's conversation when accessed under Business B
    const wrongBizMsgRes = await fetch(
      `${baseUrl}/api/businesses/${businessBId}/conversations/${conversationAId}/messages`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'Trying to access another business conversation' }),
      }
    );
    assert.equal(wrongBizMsgRes.status, 404);
  });

  it('11. Rejects empty messages and invalid UUIDs across endpoints', async () => {
    // Invalid businessId UUID
    const badBizUuidRes = await fetch(
      `${baseUrl}/api/businesses/not-a-uuid/customers`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      }
    );
    assert.equal(badBizUuidRes.status, 400);

    // Invalid customerId UUID when creating conversation
    const badCustUuidRes = await fetch(
      `${baseUrl}/api/businesses/${businessAId}/conversations`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ customer_id: 'invalid-uuid' }),
      }
    );
    assert.equal(badCustUuidRes.status, 400);

    // Invalid conversationId UUID on GET and POST messages
    const badConvUuidGet = await fetch(
      `${baseUrl}/api/businesses/${businessAId}/conversations/invalid-uuid`
    );
    assert.equal(badConvUuidGet.status, 400);

    const badConvUuidPost = await fetch(
      `${baseUrl}/api/businesses/${businessAId}/conversations/invalid-uuid/messages`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'Hello' }),
      }
    );
    assert.equal(badConvUuidPost.status, 400);

    // Empty / whitespace-only message
    const emptyMsgRes = await fetch(
      `${baseUrl}/api/businesses/${businessAId}/conversations/${conversationAId}/messages`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: '   ' }),
      }
    );
    assert.equal(emptyMsgRes.status, 400);
  });

  it('12. Rejects messages in closed conversations', async () => {
    // Close conversationAId via PATCH
    const closeRes = await fetch(
      `${baseUrl}/api/businesses/${businessAId}/conversations/${conversationAId}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'closed' }),
      }
    );
    assert.equal(closeRes.status, 200);
    const closedConv = await closeRes.json();
    assert.equal(closedConv.status, 'closed');

    // Attempt to post a message to the closed conversation
    const msgClosedRes = await fetch(
      `${baseUrl}/api/businesses/${businessAId}/conversations/${conversationAId}/messages`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'Can I still reply here?' }),
      }
    );
    assert.equal(msgClosedRes.status, 400);
    const closedErr = await msgClosedRes.json();
    assert.match(closedErr.error, /closed conversation/i);

    // Confirm the rejected message was not saved
    const checkConvRes = await fetch(
      `${baseUrl}/api/businesses/${businessAId}/conversations/${conversationAId}`
    );
    const checkConv = await checkConvRes.json();
    assert.equal(checkConv.messages.length, 3);
  });

  it('13. Bounds prompt conversation history to the latest 20 messages and isolates business context', async () => {
    // Upload context specifically for Business B
    const csvB = [
      'category,title,content',
      'shipping_policy,Gadget Shipping,"Gadgets ship within 2 business days via express courier."',
    ].join('\n');
    const formB = new FormData();
    formB.append('file', new Blob([csvB], { type: 'text/csv' }), 'b-context.csv');
    const uploadBRes = await fetch(
      `${baseUrl}/api/businesses/${businessBId}/context/upload`,
      { method: 'POST', body: formB }
    );
    assert.equal(uploadBRes.status, 200);

    // Create a new open conversation for Business B
    const convBRes = await fetch(
      `${baseUrl}/api/businesses/${businessBId}/conversations`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ customer_id: customerBId }),
      }
    );
    assert.equal(convBRes.status, 201);
    const convB = await convBRes.json();

    // Send 22 messages in Business B's conversation
    let latestPrompt = '';
    for (let i = 1; i <= 22; i += 1) {
      const res = await fetch(
        `${baseUrl}/api/businesses/${businessBId}/conversations/${convB.id}/messages`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            message: `Turn-${i}: When will my gadget ship?`,
          }),
        }
      );
      assert.equal(res.status, 201);
      const savedMsg = await res.json();
      assert.equal(savedMsg.sender_type, 'customer');
      assert.equal(savedMsg.suggestions, undefined);
      latestPrompt = lastDispatchedPrompt;
    }

    // Earliest messages (Turn-1 and Turn-2) must be dropped by the 20-message bound
    assert.ok(!latestPrompt.includes('Turn-1:'));
    assert.ok(!latestPrompt.includes('Turn-2:'));
    // Turn-3 through Turn-21 are in CONVERSATION HISTORY, and Turn-22 is in CUSTOMER MESSAGE
    assert.ok(latestPrompt.includes('Turn-3:'));
    assert.ok(latestPrompt.includes('Turn-21:'));
    assert.match(
      latestPrompt,
      /<customer_message>\s*Turn-22: When will my gadget ship\?\s*<\/customer_message>/
    );

    // Business B's prompt must include Business B's context and NEVER Business A's context
    assert.ok(latestPrompt.includes('Business Name: Other Gadgets Corp'));
    assert.ok(latestPrompt.includes('Title: Gadget Shipping'));
    assert.ok(!latestPrompt.includes('Example Home Renovations'));
    assert.ok(!latestPrompt.includes('Appointment Cancellation'));
  });

  it('14. Saves agent/user replies directly to DB without generating an AI prompt, and includes both customer and agent messages when the customer replies next', async () => {
    // Create a fresh open conversation under Business A
    const convRes = await fetch(
      `${baseUrl}/api/businesses/${businessAId}/conversations`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ customer_id: customerAId }),
      }
    );
    assert.equal(convRes.status, 201);
    const conv = await convRes.json();

    // Turn 1: Customer sends initial message -> saves AI response server-side and returns only customer message
    const custTurn1Res = await fetch(
      `${baseUrl}/api/businesses/${businessAId}/conversations/${conv.id}/messages`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: 'Can we reschedule the appointment?',
        }),
      }
    );
    assert.equal(custTurn1Res.status, 201);
    assert.match(
      custTurn1Res.headers.get('content-type') || '',
      /application\/json/i
    );
    const savedCustTurn1 = await custTurn1Res.json();
    assert.equal(savedCustTurn1.sender_type, 'customer');
    assert.equal(savedCustTurn1.suggestions, undefined);
    const promptTurn1 = lastDispatchedPrompt;
    assert.ok(promptTurn1.includes('No prior messages in this conversation.'));
    assert.ok(promptTurn1.includes('Can we reschedule the appointment?'));

    // Turn 2: User / Support Agent replies via dedicated /replies endpoint -> saves directly as JSON (201) WITHOUT generating a prompt
    const agentReply1Res = await fetch(
      `${baseUrl}/api/businesses/${businessAId}/conversations/${conv.id}/replies`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: 'Yes of course, when do you prefer it?',
        }),
      }
    );
    assert.equal(agentReply1Res.status, 201);
    assert.match(
      agentReply1Res.headers.get('content-type') || '',
      /application\/json/i
    );
    const savedAgentReply1 = await agentReply1Res.json();
    assert.equal(savedAgentReply1.conversation_id, conv.id);
    assert.equal(savedAgentReply1.sender_type, 'agent');
    assert.equal(
      savedAgentReply1.content,
      'Yes of course, when do you prefer it?'
    );

    // Turn 3: Customer responds seeing the agent reply -> generates singular AI response with BOTH Customer and Agent turns in CONVERSATION HISTORY
    const custTurn2Res = await fetch(
      `${baseUrl}/api/businesses/${businessAId}/conversations/${conv.id}/messages`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: 'Tomorrow afternoon at 3 PM.',
        }),
      }
    );
    assert.equal(custTurn2Res.status, 201);
    assert.match(
      custTurn2Res.headers.get('content-type') || '',
      /application\/json/i
    );
    const savedCustTurn2 = await custTurn2Res.json();
    assert.equal(savedCustTurn2.sender_type, 'customer');
    assert.equal(savedCustTurn2.suggestions, undefined);
    const promptTurn2 = lastDispatchedPrompt;

    assert.ok(
      promptTurn2.includes(
        '[Message 1] Customer (customer): Can we reschedule the appointment?'
      )
    );
    assert.ok(
      promptTurn2.includes(
        '[Message 2] Agent (agent): Yes of course, when do you prefer it?'
      )
    );
    assert.match(
      promptTurn2,
      /<customer_message>\s*Tomorrow afternoon at 3 PM\.\s*<\/customer_message>/
    );
    assert.ok(promptTurn2.includes('Title: Appointment Cancellation'));

    // Turn 4: User / Support Agent also can reply via /messages with sender_type: "agent" -> saves directly as JSON (201) WITHOUT generating a prompt
    const agentReply2Res = await fetch(
      `${baseUrl}/api/businesses/${businessAId}/conversations/${conv.id}/messages`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sender_type: 'agent',
          message: 'Great, please share your booking reference so I can confirm 3 PM tomorrow.',
        }),
      }
    );
    assert.equal(agentReply2Res.status, 201);
    assert.match(
      agentReply2Res.headers.get('content-type') || '',
      /application\/json/i
    );
    const savedAgentReply2 = await agentReply2Res.json();
    assert.equal(savedAgentReply2.sender_type, 'agent');

    // Turn 5: Customer replies with booking reference -> generates singular AI response with all 4 prior messages in chronological order
    const custTurn3Res = await fetch(
      `${baseUrl}/api/businesses/${businessAId}/conversations/${conv.id}/messages`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: 'My booking reference is BK-9921.',
        }),
      }
    );
    assert.equal(custTurn3Res.status, 201);
    const savedCustTurn3 = await custTurn3Res.json();
    assert.equal(savedCustTurn3.sender_type, 'customer');
    assert.equal(savedCustTurn3.suggestions, undefined);
    const promptTurn3 = lastDispatchedPrompt;
    assert.ok(
      promptTurn3.includes(
        '[Message 1] Customer (customer): Can we reschedule the appointment?'
      )
    );
    assert.ok(
      promptTurn3.includes(
        '[Message 2] Agent (agent): Yes of course, when do you prefer it?'
      )
    );
    assert.ok(
      promptTurn3.includes(
        '[Message 3] Customer (customer): Tomorrow afternoon at 3 PM.'
      )
    );
    assert.ok(
      promptTurn3.includes(
        '[Message 4] Agent (agent): Great, please share your booking reference so I can confirm 3 PM tomorrow.'
      )
    );
    assert.match(
      promptTurn3,
      /<customer_message>\s*My booking reference is BK-9921\.\s*<\/customer_message>/
    );

    // Reject invalid sender_type values
    const badSenderRes = await fetch(
      `${baseUrl}/api/businesses/${businessAId}/conversations/${conv.id}/messages`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sender_type: 'bot_admin',
          message: 'Invalid sender role test',
        }),
      }
    );
    assert.equal(badSenderRes.status, 400);
  });

  // =========================================================================
  // Phase 3 Tests: Customer CSV Imports & AI Bulk Email Announcements
  // =========================================================================

  it('15. Validates customer creation fields, normalizes emails, prevents duplicate emails within a business, and isolates across businesses', async () => {
    // Missing customer_name
    const missingNameRes = await fetch(
      `${baseUrl}/api/businesses/${businessAId}/customers`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'valid@example.test' }),
      }
    );
    assert.equal(missingNameRes.status, 400);

    // Invalid email format
    const invalidEmailRes = await fetch(
      `${baseUrl}/api/businesses/${businessAId}/customers`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customer_name: 'Invalid Email User',
          email: 'not-an-email',
        }),
      }
    );
    assert.equal(invalidEmailRes.status, 400);

    // Duplicate email within Business A (case-insensitive / whitespace normalized) -> 409 Conflict
    const dupRes = await fetch(
      `${baseUrl}/api/businesses/${businessAId}/customers`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customer_name: 'Alice Duplicate',
          email: '  ALICE.RENOVATOR@EXAMPLE.TEST ',
        }),
      }
    );
    assert.equal(dupRes.status, 409);

    // Same email under Business B is allowed (business scoping)
    const crossBizAllowedRes = await fetch(
      `${baseUrl}/api/businesses/${businessBId}/customers`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customer_name: 'Alice In Business B',
          email: 'ALICE.RENOVATOR@EXAMPLE.TEST',
        }),
      }
    );
    assert.equal(crossBizAllowedRes.status, 201);
    const crossBizCust = await crossBizAllowedRes.json();
    assert.equal(crossBizCust.business_id, businessBId);
    assert.equal(crossBizCust.email, 'alice.renovator@example.test');
  });

  it('16. Bulk imports sample-customers.csv, updates existing customers on re-upload, and reports row-level errors for malformed rows', async () => {
    // 1. Valid customer CSV upload using standard or alternative field names (e.g. 'file' or 'customer_csv')
    const sampleCsvContent = [
      'customer_name,email',
      'Sarah Khan,sarah@example.test',
      'David Lee,david@example.test',
      'Alex Rahman,alex@example.test',
    ].join('\n');

    const form1 = new FormData();
    form1.append(
      'customer_csv',
      new Blob([sampleCsvContent], { type: 'text/csv' }),
      'sample-customers.csv'
    );

    const res1 = await fetch(
      `${baseUrl}/api/businesses/${businessAId}/customers/upload`,
      {
        method: 'POST',
        body: form1,
      }
    );
    assert.equal(res1.status, 200);
    const body1 = await res1.json();
    assert.equal(body1.business_id, businessAId);
    assert.equal(body1.imported_count, 3);
    assert.equal(body1.updated_count, 0);
    assert.equal(body1.rejected_count, 0);
    assert.deepEqual(body1.errors, []);

    // 2. Re-upload with 1 updated customer, 1 new customer, and 2 invalid rows (missing name + bad email)
    const mixedCsv = [
      'customer_name,email',
      'Sarah Khan Updated,SARAH@EXAMPLE.TEST',
      'Nadia Islam,nadia@example.test',
      ',missingname@example.test',
      'Bad Email Person,invalid-email-format',
    ].join('\n');

    const form2 = new FormData();
    form2.append(
      'file',
      new Blob([mixedCsv], { type: 'text/csv' }),
      'mixed-customers.csv'
    );

    const res2 = await fetch(
      `${baseUrl}/api/businesses/${businessAId}/customers/upload`,
      {
        method: 'POST',
        body: form2,
      }
    );
    assert.equal(res2.status, 200);
    const body2 = await res2.json();
    assert.equal(body2.imported_count, 1);
    assert.equal(body2.updated_count, 1);
    assert.equal(body2.rejected_count, 2);
    assert.equal(body2.errors.length, 2);
    assert.equal(body2.errors[0].row, 4);
    assert.equal(body2.errors[1].row, 5);

    // Verify Sarah Khan's name was updated in Business A and not duplicated
    const custsA = mockPool
      .getInternalCustomers()
      .filter((c) => c.business_id === businessAId);
    // Total in Business A: Alice Renovator + Sarah Khan + David Lee + Alex Rahman + Nadia Islam = 5
    assert.equal(custsA.length, 5);
    const sarah = custsA.find((c) => c.email === 'sarah@example.test');
    assert.equal(sarah.customer_name, 'Sarah Khan Updated');
  });

  let draftedAnnouncementId;

  it('17. Generates an AI announcement draft with {{customer_name}} placeholder, saves draft in PostgreSQL, and returns recipient_count', async () => {
    // Reject empty announcement text
    const badRes = await fetch(
      `${baseUrl}/api/businesses/${businessAId}/announcements/draft`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ announcement: '   ' }),
      }
    );
    assert.equal(badRes.status, 400);

    // Generate valid draft for Business A
    const res = await fetch(
      `${baseUrl}/api/businesses/${businessAId}/announcements/draft`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          announcement: 'We are offering a 10% discount on Service X.',
        }),
      }
    );
    assert.equal(res.status, 201);
    const draft = await res.json();
    assert.ok(draft.id);
    assert.equal(draft.business_id, businessAId);
    assert.equal(draft.subject, 'Enjoy 10% Off Service X');
    assert.ok(draft.body.includes('{{customer_name}}'));
    assert.equal(draft.status, 'draft');
    assert.equal(draft.recipient_count, 5);
    draftedAnnouncementId = draft.id;

    // Verify prompt builder rules were included in the prompt sent to Gemini
    assert.ok(lastDispatchedAnnouncementPrompt.includes('Example Home Renovations'));
    assert.ok(lastDispatchedAnnouncementPrompt.includes('{{customer_name}}'));
    assert.ok(
      lastDispatchedAnnouncementPrompt.includes(
        'We are offering a 10% discount on Service X.'
      )
    );
    assert.ok(
      lastDispatchedAnnouncementPrompt.includes(
        'Do NOT invent discount conditions, minimum spend requirements, expiry dates'
      )
    );
  });

  it('18. Sends confirmed bulk announcement individually per recipient with personalized {{customer_name}}, no CC/BCC, and prevents duplicate sends', async () => {
    sentEmailsLog = [];
    failingEmailsSet.clear();

    // 1. Reject when confirm !== true
    const unconfirmedRes = await fetch(
      `${baseUrl}/api/businesses/${businessAId}/announcements/${draftedAnnouncementId}/send`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          subject: 'Enjoy 10% Off Service X',
          body: 'Hello {{customer_name}},\n\nEnjoy 10% off Service X.',
          confirm: false,
        }),
      }
    );
    assert.equal(unconfirmedRes.status, 400);
    assert.equal(sentEmailsLog.length, 0);

    // 2. Reject when another business tries to send Business A's announcement
    const crossBizSendRes = await fetch(
      `${baseUrl}/api/businesses/${businessBId}/announcements/${draftedAnnouncementId}/send`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          subject: 'Enjoy 10% Off Service X',
          body: 'Hello {{customer_name}},\n\nEnjoy 10% off Service X.',
          confirm: true,
        }),
      }
    );
    assert.equal(crossBizSendRes.status, 404);
    assert.equal(sentEmailsLog.length, 0);

    // 3. Confirmed send for Business A
    const sendRes = await fetch(
      `${baseUrl}/api/businesses/${businessAId}/announcements/${draftedAnnouncementId}/send`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          subject: 'Final Approved: 10% Off Service X',
          body: 'Hello {{customer_name}},\n\nWe are pleased to offer you a 10% discount on Service X.\n\nBest regards',
          confirm: true,
        }),
      }
    );
    assert.equal(sendRes.status, 200);
    const sendSummary = await sendRes.json();
    assert.equal(sendSummary.announcement_id, draftedAnnouncementId);
    assert.equal(sendSummary.business_id, businessAId);
    assert.equal(sendSummary.subject, 'Final Approved: 10% Off Service X');
    assert.equal(sendSummary.status, 'sent');
    assert.equal(sendSummary.recipient_count, 5);
    assert.equal(sendSummary.sent_count, 5);
    assert.equal(sendSummary.failed_count, 0);
    assert.equal(sendSummary.recipients.length, 5);

    // Verify 5 separate emails were sent, personalized, and without CC/BCC
    assert.equal(sentEmailsLog.length, 5);
    for (const mail of sentEmailsLog) {
      assert.equal(mail.cc, undefined);
      assert.equal(mail.bcc, undefined);
      assert.ok(!mail.text.includes('{{customer_name}}'));
      if (mail.html) {
        assert.ok(!mail.html.includes('{{customer_name}}'));
      }
    }

    const sarahMail = sentEmailsLog.find(
      (m) => m.to === 'sarah@example.test'
    );
    assert.ok(sarahMail);
    assert.ok(sarahMail.text.includes('Hello Sarah Khan Updated,'));

    // 4. Prevent accidental duplicate campaign send -> 409 Conflict
    const duplicateSendRes = await fetch(
      `${baseUrl}/api/businesses/${businessAId}/announcements/${draftedAnnouncementId}/send`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          subject: 'Final Approved: 10% Off Service X',
          body: 'Hello {{customer_name}},\n\nWe are pleased to offer you a 10% discount on Service X.\n\nBest regards',
          confirm: true,
        }),
      }
    );
    assert.equal(duplicateSendRes.status, 409);
    // Ensure no extra emails were sent
    assert.equal(sentEmailsLog.length, 5);
  });

  it('19. Tracks partial SMTP failures without losing successful sends and rejects sending when business has 0 customers', async () => {
    // 1. Draft and send a second announcement where 1 recipient fails SMTP delivery
    const draftRes = await fetch(
      `${baseUrl}/api/businesses/${businessAId}/announcements/draft`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          announcement: 'Our showroom will open at 10 AM this Saturday.',
        }),
      }
    );
    assert.equal(draftRes.status, 201);
    const draft2 = await draftRes.json();

    sentEmailsLog = [];
    failingEmailsSet = new Set(['david@example.test']);

    const partialSendRes = await fetch(
      `${baseUrl}/api/businesses/${businessAId}/announcements/${draft2.id}/send`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          subject: 'Showroom Hours This Saturday',
          body: 'Hello {{customer_name}},\n\nOur showroom will open at 10 AM this Saturday.',
          confirm: true,
        }),
      }
    );
    assert.equal(partialSendRes.status, 200);
    const partialBody = await partialSendRes.json();
    assert.equal(partialBody.status, 'partially_sent');
    assert.equal(partialBody.recipient_count, 5);
    assert.equal(partialBody.sent_count, 4);
    assert.equal(partialBody.failed_count, 1);

    const davidRecipient = partialBody.recipients.find(
      (r) => r.email === 'david@example.test'
    );
    assert.equal(davidRecipient.status, 'failed');
    assert.match(davidRecipient.error_message, /Simulated SMTP bounce/i);

    const sarahRecipient = partialBody.recipients.find(
      (r) => r.email === 'sarah@example.test'
    );
    assert.equal(sarahRecipient.status, 'sent');
    assert.equal(sarahRecipient.error_message, null);

    failingEmailsSet.clear();

    // 2. Create a business with 0 customers and verify sending an announcement returns 400
    const emptyBizRes = await fetch(`${baseUrl}/api/businesses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Zero Customers Co' }),
    });
    const emptyBiz = await emptyBizRes.json();

    const emptyDraftRes = await fetch(
      `${baseUrl}/api/businesses/${emptyBiz.id}/announcements/draft`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          announcement: 'Welcome to our new store!',
        }),
      }
    );
    assert.equal(emptyDraftRes.status, 201);
    const emptyDraft = await emptyDraftRes.json();
    assert.equal(emptyDraft.recipient_count, 0);

    const emptySendRes = await fetch(
      `${baseUrl}/api/businesses/${emptyBiz.id}/announcements/${emptyDraft.id}/send`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          subject: 'Welcome',
          body: 'Hello {{customer_name}}, welcome!',
          confirm: true,
        }),
      }
    );
    assert.equal(emptySendRes.status, 400);
    const emptySendErr = await emptySendRes.json();
    assert.match(emptySendErr.error, /No eligible customers found/i);
  });

  // =========================================================================
  // Phase 5 Tests: Customer Conversation History Lookup & Company Inbox
  // =========================================================================

  it('20. Validates POST /conversations/history and GET /conversations for business isolation, server-side AI draft lifecycle, and customer privacy', async () => {
    // 1. Create a brand new customer under Business A
    const newCustRes = await fetch(
      `${baseUrl}/api/businesses/${businessAId}/customers`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customer_name: 'Jane Smith',
          email: 'jane.smith@example.test',
        }),
      }
    );
    assert.equal(newCustRes.status, 201);
    const newCust = await newCustRes.json();
    assert.ok(newCust.customer_id);
    assert.equal(newCust.id, newCust.customer_id);

    // 2. Lookup history for valid customer with no conversation yet
    const histNoConvRes = await fetch(
      `${baseUrl}/api/businesses/${businessAId}/conversations/history`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ customer_id: newCust.customer_id }),
      }
    );
    assert.equal(histNoConvRes.status, 200);
    const histNoConv = await histNoConvRes.json();
    assert.equal(histNoConv.customer_valid, true);
    assert.equal(histNoConv.has_conversation, false);
    assert.equal(histNoConv.conversation, null);
    assert.deepEqual(histNoConv.messages, []);

    // 3. Reject cross-business customer ID on /conversations/history
    const crossBizHistRes = await fetch(
      `${baseUrl}/api/businesses/${businessBId}/conversations/history`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ customer_id: newCust.customer_id }),
      }
    );
    assert.equal(crossBizHistRes.status, 400);

    // 4. Create conversation and send a customer message
    const convCreateRes = await fetch(
      `${baseUrl}/api/businesses/${businessAId}/conversations`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ customer_id: newCust.customer_id }),
      }
    );
    assert.equal(convCreateRes.status, 201);
    const createdConv = await convCreateRes.json();
    assert.equal(createdConv.conversation_id, createdConv.id);

    const custMsgRes = await fetch(
      `${baseUrl}/api/businesses/${businessAId}/conversations/${createdConv.conversation_id}/messages`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: 'Hello, can I get an extension on my overdue balance?',
        }),
      }
    );
    assert.equal(custMsgRes.status, 201);
    const custMsgBody = await custMsgRes.json();
    assert.equal(custMsgBody.ai_suggestion, undefined);
    assert.equal(custMsgBody.suggestions, undefined);

    // 5. Lookup history again -> returns existing conversation and messages WITHOUT AI suggestions
    const histWithConvRes = await fetch(
      `${baseUrl}/api/businesses/${businessAId}/conversations/history`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ customer_id: newCust.customer_id }),
      }
    );
    assert.equal(histWithConvRes.status, 200);
    const histWithConv = await histWithConvRes.json();
    assert.equal(histWithConv.has_conversation, true);
    assert.equal(histWithConv.conversation_id, createdConv.conversation_id);
    assert.equal(histWithConv.messages.length, 1);
    assert.equal(histWithConv.messages[0].ai_suggestion, undefined);
    assert.equal(histWithConv.conversation.ai_draft_reply, undefined);

    // 6. Company GET /conversations lists business conversations with customer info and AI draft
    const listRes = await fetch(
      `${baseUrl}/api/businesses/${businessAId}/conversations`
    );
    assert.equal(listRes.status, 200);
    const listBody = await listRes.json();
    assert.equal(listBody.business_id, businessAId);
    assert.ok(Array.isArray(listBody.conversations));
    const janeConv = listBody.conversations.find(
      (c) => c.id === createdConv.conversation_id
    );
    assert.ok(janeConv);
    assert.equal(janeConv.customer_name, 'Jane Smith');
    assert.equal(janeConv.unread_count, 1);
    assert.equal(janeConv.needs_reply, true);
    assert.ok(janeConv.ai_draft_reply);
    assert.ok(janeConv.ai_suggestion);
    assert.ok(
      janeConv.ai_suggestion.suggestion.includes(
        'We would be happy to help you reschedule your appointment.'
      )
    );

    // 7. Company sends reply -> clears active AI draft and resets unread_count to 0
    const replyRes = await fetch(
      `${baseUrl}/api/businesses/${businessAId}/conversations/${createdConv.conversation_id}/replies`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: 'Hi Jane! Let me look that up... Yes, you have 3 more days.',
        }),
      }
    );
    assert.equal(replyRes.status, 201);

    const listAfterReplyRes = await fetch(
      `${baseUrl}/api/businesses/${businessAId}/conversations`
    );
    const listAfterReply = await listAfterReplyRes.json();
    const janeConvAfter = listAfterReply.conversations.find(
      (c) => c.id === createdConv.conversation_id
    );
    assert.equal(janeConvAfter.unread_count, 0);
    assert.equal(janeConvAfter.needs_reply, false);
    assert.equal(janeConvAfter.ai_draft_reply, null);
    assert.equal(janeConvAfter.messages.length, 2);
  });

  // =========================================================================
  // Phase 6 Tests: Natural-Language Recipient Targeting & Announcement History
  // =========================================================================

  it('21. Filters announcement recipients by created_at from natural-language criteria, blocks ambiguous audiences, sends with { confirm: true }, and returns Announcement History', async () => {
    // 1. Set two customers in Business A to have registered in 2025 (before 2026-01-01)
    const custsA = mockPool
      .getInternalCustomers()
      .filter((c) => c.business_id === businessAId);
    assert.equal(custsA.length, 6); // 5 earlier + Jane Smith

    await mockPool.query('UPDATE customers SET created_at = $2 WHERE id = $1', [
      custsA[0].id,
      '2025-11-15T10:00:00Z',
    ]);
    await mockPool.query('UPDATE customers SET created_at = $2 WHERE id = $1', [
      custsA[1].id,
      '2025-12-20T10:00:00Z',
    ]);
    for (let i = 2; i < custsA.length; i += 1) {
      await mockPool.query('UPDATE customers SET created_at = $2 WHERE id = $1', [
        custsA[i].id,
        '2026-03-10T10:00:00Z',
      ]);
    }

    // 2. Ambiguous / unsupported audience criteria must NOT silently fall back to all users
    const ambigRes = await fetch(
      `${baseUrl}/api/businesses/${businessAId}/announcements/draft`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          announcement:
            'Send an announcement about a 15% discount to VIP gold customers.',
        }),
      }
    );
    assert.equal(ambigRes.status, 200);
    const ambigBody = await ambigRes.json();
    assert.equal(ambigBody.status, 'clarification_needed');
    assert.equal(ambigBody.clarification_needed, true);
    assert.equal(ambigBody.recipient_count, 0);
    assert.ok(ambigBody.message);

    // 3. Natural-language registration date targeting: "users who registered after 2026-01-01"
    const filteredDraftRes = await fetch(
      `${baseUrl}/api/businesses/${businessAId}/announcements/draft`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          announcement:
            'Send an announcement about a flat 10% discount on all services to users who registered after 2026-01-01.',
        }),
      }
    );
    assert.equal(filteredDraftRes.status, 201);
    const filteredDraft = await filteredDraftRes.json();
    assert.equal(filteredDraft.status, 'draft');
    assert.equal(filteredDraft.recipient_count, 4); // 4 customers registered in 2026, 2 in 2025
    assert.match(filteredDraft.audience_description, /after 2026-01-01/i);
    assert.equal(filteredDraft.target_criteria.scope, 'filtered');

    // 4. Send with only { "confirm": true } -> uses saved subject, body, and validated target_criteria
    sentEmailsLog = [];
    failingEmailsSet.clear();
    const sendFilteredRes = await fetch(
      `${baseUrl}/api/businesses/${businessAId}/announcements/${filteredDraft.id}/send`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm: true }),
      }
    );
    assert.equal(sendFilteredRes.status, 200);
    const sendFilteredBody = await sendFilteredRes.json();
    assert.equal(sendFilteredBody.status, 'sent');
    assert.equal(sendFilteredBody.recipient_count, 4);
    assert.equal(sendFilteredBody.sent_count, 4);
    assert.equal(sendFilteredBody.failed_count, 0);
    assert.equal(sentEmailsLog.length, 4);

    // 5. Retrieve Announcement History via GET /api/businesses/:businessId/announcements
    const historyRes = await fetch(
      `${baseUrl}/api/businesses/${businessAId}/announcements`
    );
    assert.equal(historyRes.status, 200);
    const historyBody = await historyRes.json();
    assert.equal(historyBody.business_id, businessAId);
    assert.ok(historyBody.announcements.length >= 3);
    const latestHistoryItem = historyBody.announcements.find(
      (a) => a.id === filteredDraft.id
    );
    assert.ok(latestHistoryItem);
    assert.equal(latestHistoryItem.sent_count, 4);
    assert.equal(latestHistoryItem.status, 'sent');
    assert.ok(latestHistoryItem.failed_recipients);
  });

  it('22. Imports extensive sample-context.csv (VELOURA), dynamically retrieves across all designated fields, adapts when field content changes, and keeps prompt tokens compact', async () => {
    const bizRes = await fetch(`${baseUrl}/api/businesses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'VELOURA' }),
    });
    assert.equal(bizRes.status, 201);
    const velouraBiz = await bizRes.json();

    const sampleContextPath = path.resolve(__dirname, '../sample-context.csv');
    const sampleContextCsv = fs.readFileSync(sampleContextPath, 'utf8');

    const formData = new FormData();
    formData.append(
      'file',
      new Blob([sampleContextCsv], { type: 'text/csv' }),
      'sample-context.csv'
    );

    const uploadRes = await fetch(
      `${baseUrl}/api/businesses/${velouraBiz.id}/context/upload`,
      { method: 'POST', body: formData }
    );
    assert.equal(uploadRes.status, 200);
    const uploadBody = await uploadRes.json();
    assert.equal(uploadBody.totalProcessed, 6);
    assert.equal(uploadBody.insertedCount, 6);

    // 1. Inquiry about delivery fee & timeframe inside/outside Khulna -> retrieves terms_and_conditions & shipping_policy
    const shipRes = await fetch(
      `${baseUrl}/api/businesses/${velouraBiz.id}/prompt`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: 'How much is the shipping cost inside and outside Khulna, and how long does delivery take?',
        }),
      }
    );
    assert.equal(shipRes.status, 200);
    const shipPrompt = await shipRes.text();
    assert.ok(shipPrompt.includes('70 BDT'));
    assert.ok(shipPrompt.includes('120 BDT'));
    assert.ok(shipPrompt.includes('1 to 3 business days'));
    assert.ok(shipPrompt.length < 4800);

    // 2. Inquiry about COD, bKash, and SPACES furniture advance -> retrieves payment_policy
    const payRes = await fetch(
      `${baseUrl}/api/businesses/${velouraBiz.id}/prompt`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: 'Can I pay with COD or bKash, and what is the advance deposit for SPACES furniture?',
        }),
      }
    );
    assert.equal(payRes.status, 200);
    const payPrompt = await payRes.text();
    assert.ok(payPrompt.includes('Category: payment_policy'));
    assert.ok(payPrompt.includes('bKash'));
    assert.ok(payPrompt.includes('10% advance'));
    assert.ok(payPrompt.length < 4800);

    // 3. Dynamically update the content of an existing (category, title) row and verify the prompt immediately reflects the new content
    const dynamicUpdateCsv = [
      'category,title,content',
      'refund_policy,Refund Eligibility,"Updated dynamic policy: Refund requests must now be submitted within 5 days of delivery via support@velourabd.com and are processed within 10 working days."',
    ].join('\n');
    const updateForm = new FormData();
    updateForm.append(
      'file',
      new Blob([dynamicUpdateCsv], { type: 'text/csv' }),
      'sample-context.csv'
    );
    const reuploadRes = await fetch(
      `${baseUrl}/api/businesses/${velouraBiz.id}/context/upload`,
      { method: 'POST', body: updateForm }
    );
    assert.equal(reuploadRes.status, 200);
    const reuploadBody = await reuploadRes.json();
    assert.equal(reuploadBody.updatedCount, 1);

    const refundRes = await fetch(
      `${baseUrl}/api/businesses/${velouraBiz.id}/prompt`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: 'How many days do I have to request a refund after delivery?',
        }),
      }
    );
    assert.equal(refundRes.status, 200);
    const refundPrompt = await refundRes.text();
    assert.ok(refundPrompt.includes('within 5 days of delivery'));
    assert.ok(refundPrompt.includes('support@velourabd.com'));
    assert.ok(!refundPrompt.includes('within 3 days of delivery'));
  });
});
