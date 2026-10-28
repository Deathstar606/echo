const express = require('express');
const { createBusiness } = require('../controllers/businessController');
const { uploadBusinessContext } = require('../controllers/contextController');
const { generateBusinessPrompt } = require('../controllers/promptController');
const {
  createBusinessCustomer,
  uploadBusinessCustomers,
} = require('../controllers/customerController');
const {
  listBusinessConversations,
  getCustomerConversationHistory,
  createBusinessConversation,
  getBusinessConversation,
  updateBusinessConversationStatus,
  postCustomerMessageAndGeneratePrompt,
  postAgentReplyToConversation,
} = require('../controllers/conversationController');
const {
  draftBusinessAnnouncement,
  sendBusinessAnnouncement,
} = require('../controllers/announcementController');
const {
  validateBusinessIdParam,
  validateConversationIdParam,
  validateAnnouncementIdParam,
} = require('../middleware/validate');
const { uploadSingleCsv } = require('../middleware/uploadMiddleware');
const sheetRoutes = require('./sheetRoutes');

const router = express.Router();

// Phase 1: Business Creation Endpoint
// POST /api/businesses
router.post('/', createBusiness);

// Phase 1: CSV Upload and Import Endpoint
// POST /api/businesses/:businessId/context/upload
router.post(
  '/:businessId/context/upload',
  validateBusinessIdParam,
  uploadSingleCsv,
  uploadBusinessContext
);

// Phase 1: Single-Turn Contextual Prompt Generation Endpoint
// POST /api/businesses/:businessId/prompt
router.post(
  '/:businessId/prompt',
  validateBusinessIdParam,
  generateBusinessPrompt
);

// Phase 2 & 3: Individual Customer Creation Endpoint
// POST /api/businesses/:businessId/customers
router.post(
  '/:businessId/customers',
  validateBusinessIdParam,
  createBusinessCustomer
);

// Phase 3: Bulk Customer CSV Upload Endpoint
// POST /api/businesses/:businessId/customers/upload
router.post(
  '/:businessId/customers/upload',
  validateBusinessIdParam,
  uploadSingleCsv,
  uploadBusinessCustomers
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

// Phase 2: Incoming Customer Message & Multi-Turn Contextual Prompt Generation
// (Also supports sender_type: 'agent' to persist a reply directly without prompt generation)
// POST /api/businesses/:businessId/conversations/:conversationId/messages
router.post(
  '/:businessId/conversations/:conversationId/messages',
  validateBusinessIdParam,
  validateConversationIdParam,
  postCustomerMessageAndGeneratePrompt
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
