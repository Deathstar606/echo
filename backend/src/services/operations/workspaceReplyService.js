const { retrieveCrossDocumentContext } = require('../rag/crossRagService');
const { buildWorkspaceSupportPrompt } = require('../llm/promptBuilderService');
const {
  generateAiSupportResponse,
  hasCustomGenerator,
} = require('../llm/geminiService');
const { classifyIntentAndExpandQueries } = require('./workspaceIntentRouter');
const { runBoundedReActLoop } = require('./reactAgentService');

async function generateWorkspaceCustomerReply({
  workspace,
  customerMessage,
  customerContext = {},
  conversationHistory = [],
  sessionId = null,
}) {
  if (!hasCustomGenerator()) {
    const routerResult = await classifyIntentAndExpandQueries({
      businessId: workspace.id,
      prompt: customerMessage,
      requestEntity: 'customer',
      history: conversationHistory,
      sessionId,
    });

    const reactRes = await runBoundedReActLoop({
      businessId: workspace.id,
      prompt: customerMessage,
      entity: routerResult.primary_table || null,
      requestEntity: 'customer',
      customerContext,
      routerResult,
      sessionId,
      maxSteps: 3,
    });

    const suggestion = reactRes.answer || reactRes.message;
    return {
      aiResponse: {
        category: reactRes.category || 'customer_inquiry',
        suggestions: [suggestion],
        missing_information: reactRes.missing_information || [],
      },
      retrievedContext: {
        citations: reactRes.citations || [],
        document_chunks: [],
        table_rows: [],
      },
      suggestion,
      citations: reactRes.citations || [],
      reactTelemetry: reactRes.react_telemetry || null,
    };
  }

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
    rowTopK: 5,
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
