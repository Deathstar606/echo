const express = require('express');
const { createBusiness, getBusiness, updateBusiness } = require('../controllers/businessController');
const { createBusinessCustomer } = require('../controllers/customerController');
const {
  listBusinessConversations,
  getCustomerConversationHistory,
  createBusinessConversation,
  getBusinessConversation,
  updateBusinessConversationStatus,
  postConversationMessage,
  generateConversationReplyDraft,
  postAgentReplyToConversation,
} = require('../controllers/conversationController');
const {
  listBusinessAnnouncements,
  draftBusinessAnnouncement,
  sendBusinessAnnouncement,
} = require('../controllers/announcementController');
const {
  validateBusinessIdParam,
  validateConversationIdParam,
  validateAnnouncementIdParam,
} = require('../middleware/validate');
const sheetRoutes = require('./sheetRoutes');

const router = express.Router();

// Business Creation Endpoint
// POST /api/businesses
router.post('/', createBusiness);

// Business Lookup Endpoint
// GET /api/businesses/:businessId
router.get('/:businessId', validateBusinessIdParam, getBusiness);

// Business Rename / Update Endpoint
// PATCH /api/businesses/:businessId
// PUT /api/businesses/:businessId
router.patch('/:businessId', validateBusinessIdParam, updateBusiness);
router.put('/:businessId', validateBusinessIdParam, updateBusiness);

// Individual Customer Creation Endpoint
// POST /api/businesses/:businessId/customers
router.post(
  '/:businessId/customers',
  validateBusinessIdParam,
  createBusinessCustomer
);

// Phase 3 & 6: List Announcement History Endpoint
// GET /api/businesses/:businessId/announcements
router.get(
  '/:businessId/announcements',
  validateBusinessIdParam,
  listBusinessAnnouncements
);

// Phase 3: AI Announcement Draft Generation Endpoint
// POST /api/businesses/:businessId/announcements/draft
router.post(
  '/:businessId/announcements/draft',
  validateBusinessIdParam,
  draftBusinessAnnouncement
);

// Phase 3: Confirmed Bulk Announcement Send Endpoint
// POST /api/businesses/:businessId/announcements/:announcementId/send
router.post(
  '/:businessId/announcements/:announcementId/send',
  validateBusinessIdParam,
  validateAnnouncementIdParam,
  sendBusinessAnnouncement
);

// Phase 2 & 5: List All Business Conversations (Company Inquiry Panel)
// GET /api/businesses/:businessId/conversations
router.get(
  '/:businessId/conversations',
  validateBusinessIdParam,
  listBusinessConversations
);

// Phase 2 & 5: Customer Conversation History Lookup
// POST /api/businesses/:businessId/conversations/history
router.post(
  '/:businessId/conversations/history',
  validateBusinessIdParam,
  getCustomerConversationHistory
);

// Phase 2: Conversation Creation Endpoint
// POST /api/businesses/:businessId/conversations
router.post(
  '/:businessId/conversations',
  validateBusinessIdParam,
  createBusinessConversation
);

// Phase 2: Retrieve Conversation Metadata and Chronological Message History
// GET /api/businesses/:businessId/conversations/:conversationId
router.get(
  '/:businessId/conversations/:conversationId',
  validateBusinessIdParam,
  validateConversationIdParam,
  getBusinessConversation
);

// Phase 2: Update Conversation Status ('open' / 'closed')
// PATCH /api/businesses/:businessId/conversations/:conversationId
router.patch(
  '/:businessId/conversations/:conversationId',
  validateBusinessIdParam,
  validateConversationIdParam,
  updateBusinessConversationStatus
);

// Phase 2: Save an incoming customer or agent message without AI generation
// POST /api/businesses/:businessId/conversations/:conversationId/messages
router.post(
  '/:businessId/conversations/:conversationId/messages',
  validateBusinessIdParam,
  validateConversationIdParam,
  postConversationMessage
);

// On-demand workspace-grounded customer reply draft; never sends the draft
router.post(
  '/:businessId/conversations/:conversationId/reply-draft',
  validateBusinessIdParam,
  validateConversationIdParam,
  generateConversationReplyDraft
);

// Phase 2: Agent / Support User Reply Persistence (Direct DB save without AI prompt generation)
// POST /api/businesses/:businessId/conversations/:conversationId/replies
router.post(
  '/:businessId/conversations/:conversationId/replies',
  validateBusinessIdParam,
  validateConversationIdParam,
  postAgentReplyToConversation
);

// Phase 4: Spreadsheet Products and Services Routes (scoped to businessId)
router.use('/:businessId/sheets', validateBusinessIdParam, sheetRoutes);

module.exports = router;
