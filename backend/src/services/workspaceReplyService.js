const { retrieveCrossDocumentContext } = require('./crossRagService');
const { buildWorkspaceSupportPrompt } = require('./promptBuilderService');
const { generateAiSupportResponse } = require('./geminiService');

async function generateWorkspaceCustomerReply({
  workspace,
  customerMessage,
  customerContext = {},
  conversationHistory = [],
}) {
  const queryParts = [
    ...conversationHistory.slice(-5).map((message) => message.content),
    customerMessage,
    customerContext.customer_name,
    customerContext.customer_email,
    customerContext.reference_id,
  ].filter((value) => typeof value === 'string' && value.trim());
  const retrievedContext = await retrieveCrossDocumentContext({
    businessId: workspace.id,
    queryText: queryParts.join('\n'),
    topK: 6,
    customerContext,
  });
  const promptText = buildWorkspaceSupportPrompt({
    workspace,
    retrievedContext,
    customerMessage,
    customerContext,
    conversationHistory: conversationHistory.slice(-5),
  });
  const aiResponse = await generateAiSupportResponse(promptText);
  return {
    aiResponse,
    retrievedContext,
    suggestion: aiResponse.suggestions[0],
  };
}

module.exports = {
  generateWorkspaceCustomerReply,
};
