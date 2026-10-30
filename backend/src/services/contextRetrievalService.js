const { query } = require('../../db');
const env = require('../config/env');

const STOP_WORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'if', 'in', 'on', 'at', 'to', 'for',
  'of', 'with', 'by', 'from', 'up', 'into', 'over', 'after', 'is',
  'am', 'are', 'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had',
  'do', 'does', 'did', 'can', 'could', 'would', 'should', 'will', 'shall',
  'may', 'might', 'must', 'i', 'me', 'my', 'mine', 'we', 'us', 'our', 'ours',
  'you', 'your', 'yours', 'he', 'him', 'his', 'she', 'her', 'hers', 'it',
  'its', 'they', 'them', 'their', 'theirs', 'this', 'that', 'these', 'those',
  'what', 'which', 'whom', 'how', 'when', 'where', 'why', 'get', 'got',
  'getting', 'please', 'hi', 'hello', 'hey', 'thanks', 'thank', 'there', 'here',
  'some', 'any', 'much', 'many', 'so', 'too', 'very', 'just', 'now', 'then',
  'also', 'as', 'out', 'need', 'want', 'like', 'know', 'tell'
]);

/**
 * Domain-independent lexical synonym and acronym expansions that bridge natural
 * customer phrasing to dynamic category/title/content fields without hardcoding
 * business-specific facts.
 */
const LEXICAL_SYNONYM_GROUPS = [
  ['ship', 'shipping', 'deliver', 'delivery', 'delivered', 'courier', 'dispatch', 'transit', 'parcel', 'tracking'],
  ['cost', 'fee', 'fees', 'charge', 'charges', 'price', 'pricing', 'rate', 'rates', 'vat', 'tax', 'bdt'],
  ['refund', 'refunds', 'return', 'returned', 'returns', 'reimburse', 'reimbursement', 'moneyback'],
  ['exchange', 'replace', 'replacement', 'replacements', 'wrong', 'incorrect', 'damaged', 'defective', 'mismatch', 'mismatched', 'unboxing'],
  ['cancel', 'cancellation', 'cancellations', 'canceled', 'cancelled'],
  ['pay', 'payment', 'payments', 'paid', 'checkout', 'cod', 'cash', 'card', 'cards', 'bank', 'banking', 'mfs', 'mobile', 'bkash', 'nagad', 'rocket', 'upay', 'visa', 'mastercard', 'amex', 'advance', 'deposit'],
  ['contact', 'contacting', 'reach', 'phone', 'email', 'call', 'number', 'hotline', 'facebook', 'instagram', 'support'],
  ['about', 'who', 'company', 'brand', 'overview', 'established', 'founded', 'mission', 'info'],
  ['privacy', 'personal', 'data', 'cookie', 'cookies', 'encryption', 'anonymous', 'identification'],
  ['account', 'register', 'registration', 'login', 'password', 'credentials', 'verification', 'identity'],
  ['terms', 'conditions', 'laws', 'legal', 'liability', 'intellectual', 'property', 'resale'],
];

const SYNONYM_LOOKUP = new Map();
for (const group of LEXICAL_SYNONYM_GROUPS) {
  for (const word of group) {
    const existing = SYNONYM_LOOKUP.get(word) || new Set();
    for (const peer of group) {
      if (peer !== word) {
        existing.add(peer);
      }
    }
    SYNONYM_LOOKUP.set(word, existing);
  }
}

const CATALOG_INTENT_TOKENS = new Set([
  'product', 'products', 'catalog', 'catalogue', 'stock', 'available', 'availability',
  'size', 'sizes', 'color', 'colors', 'colour', 'colours', 'shirt', 'shirts',
  'clothing', 'clothes', 'apparel', 'wear', 'outfit', 'bestseller', 'bestsellers',
  'popular', 'discount', 'discounts', 'sale', 'collection', 'recommend', 'fabric',
  'cotton', 'linen', 'bamboo', 'denim', 'flannel', 'corduroy', 'oxford', 'polo',
  'henley', 'turtleneck', 'overshirt', 'cargo', 'summer', 'winter', 'chart',
  'chest', 'shoulder', 'sleeve', 'inch', 'inches', 'gsm'
]);

const PRODUCT_DETAIL_INTENT_TOKENS = new Set([
  'chart', 'inch', 'inches', 'chest', 'length', 'shoulder', 'sleeve', 'measurement',
  'measurements', 'fit', 'wash', 'washing', 'care', 'laundry', 'gsm', 'fabric',
  'material', 'detail', 'details', 'describe', 'description', 'specification', 'specs'
]);

const MIN_SENTENCE_FILTER_THRESHOLD_CHARS = 420;
const MAX_CONTEXT_ENTRY_CONTENT_CHARS = 850;
const MAX_COMPACT_PRODUCT_DESC_CHARS = 200;
const MAX_TOTAL_CONTEXT_CHARS = 1950;

/**
 * Tokenizes a string into lowercase alphanumeric words.
 * Replaces underscores and punctuation with spaces.
 *
 * @param {string} text
 * @returns {string[]}
 */
function tokenize(text) {
  if (!text || typeof text !== 'string') {
    return [];
  }
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * Deterministic lightweight English stemmer for matching word variations
 * (e.g., "cancellation"/"cancelling" -> "cancel", "refunds"/"refunded" -> "refund").
 *
 * @param {string} word
 * @returns {string}
 */
function stemWord(word) {
  if (!word || word.length <= 3) {
    return word;
  }

  let w = word.toLowerCase();

  // Handle specific common morphological suffixes
  if (w.endsWith('ellation') && w.length > 8) {
    return w.slice(0, -8) + 'el'; // cancellation -> cancel
  }
  if (w.endsWith('ation') && w.length > 7) {
    w = w.slice(0, -5);
  } else if (w.endsWith('ition') && w.length > 7) {
    w = w.slice(0, -5);
  } else if (w.endsWith('ments') && w.length > 7) {
    w = w.slice(0, -1); // appointments -> appointment
  } else if (w.endsWith('ibiliti') || w.endsWith('ibility')) {
    w = w.slice(0, -7);
  } else if (w.endsWith('ities') && w.length > 6) {
    w = w.slice(0, -5) + 'y';
  } else if (w.endsWith('ies') && w.length > 4) {
    w = w.slice(0, -3) + 'y';
  } else if (w.endsWith('es') && w.length > 4) {
    if (w.endsWith('ches') || w.endsWith('shes') || w.endsWith('sses') || w.endsWith('xes')) {
      w = w.slice(0, -2);
    } else {
      w = w.slice(0, -1);
    }
  } else if (w.endsWith('s') && !w.endsWith('ss') && w.length > 3) {
    w = w.slice(0, -1);
  }

  if (w.endsWith('ing') && w.length > 5) {
    w = w.slice(0, -3);
    // Handle doubled consonant (e.g., cancelling -> cancell -> cancel)
    if (w.length > 3 && w[w.length - 1] === w[w.length - 2]) {
      w = w.slice(0, -1);
    }
  } else if (w.endsWith('ed') && w.length > 4) {
    w = w.slice(0, -2);
    if (w.length > 3 && w[w.length - 1] === w[w.length - 2]) {
      w = w.slice(0, -1);
    }
  }

  if (w.endsWith('e') && w.length > 4) {
    w = w.slice(0, -1);
  }

  return w;
}

/**
 * Extracts unique meaningful keywords from a customer message, including
 * conversational intent cues ("how much" -> fee, "how long" -> hours) and
 * lexical synonym sets for dynamic field matching.
 *
 * @param {string} message
 * @returns {Array<{ raw: string, stem: string, synonyms: string[] }>}
 */
function extractQueryKeywords(message) {
  const sanitizedForTokens =
    typeof message === 'string'
      ? message.replace(/\bhow\s+long\b/gi, 'timeframe')
      : message;
  const rawTokens = tokenize(sanitizedForTokens);
  const filtered = rawTokens.filter(
    (token) => token.length >= 2 && !STOP_WORDS.has(token)
  );

  // Detect multi-word question intents lost when stop words ("how", "much", "who") are removed
  const intentExtras = [];
  if (typeof message === 'string') {
    if (/\bhow\s+much\b/i.test(message)) {
      intentExtras.push('fee');
    }
    if (/\b(?:who\s+are\s+you|what\s+is\s+your\s+(?:company|brand))\b/i.test(message)) {
      intentExtras.push('overview');
    }
  }

  // Fallback to all tokens >= 2 chars if message only consisted of stop words
  const effectiveTokens =
    filtered.length > 0 || intentExtras.length > 0
      ? [...filtered, ...intentExtras]
      : rawTokens.filter((token) => token.length >= 2);

  const uniqueMap = new Map();
  for (const token of effectiveTokens) {
    if (!uniqueMap.has(token)) {
      const stem = stemWord(token);
      const synSet = new Set([
        ...(SYNONYM_LOOKUP.get(token) || []),
        ...(SYNONYM_LOOKUP.get(stem) || []),
      ]);
      uniqueMap.set(token, {
        raw: token,
        stem,
        synonyms: Array.from(synSet),
      });
    }
  }

  return Array.from(uniqueMap.values());
}

/**
 * Checks how a query keyword matches against a list of field tokens.
 * Returns exactMatches, stemMatches, and synonymMatches counts.
 */
function evaluateFieldMatch(queryKw, fieldTokens) {
  let exactMatches = 0;
  let stemMatches = 0;
  let synonymMatches = 0;
  const synonyms = Array.isArray(queryKw.synonyms) ? queryKw.synonyms : [];

  for (const token of fieldTokens) {
    if (token === queryKw.raw) {
      exactMatches += 1;
      continue;
    }

    const tokenStem = stemWord(token);
    if (queryKw.stem.length >= 3 && tokenStem === queryKw.stem) {
      stemMatches += 1;
      continue;
    }

    // Prefix root match for words >= 4 chars (e.g., "cancel" <-> "cancellation")
    if (queryKw.raw.length >= 4 && token.length >= 4) {
      if (token.startsWith(queryKw.raw) || queryKw.raw.startsWith(token)) {
        stemMatches += 1;
        continue;
      }
    }

    if (
      synonyms.length > 0 &&
      (synonyms.includes(token) || (tokenStem.length >= 3 && synonyms.includes(tokenStem)))
    ) {
      synonymMatches += 1;
    }
  }

  return { exactMatches, stemMatches, synonymMatches };
}

/**
 * Computes a deterministic relevance score for a single context entry
 * against the extracted query keywords across its designated fields (category, title, content),
 * including sentence-level keyword co-occurrence for multi-topic content paragraphs.
 *
 * Weighting hierarchy:
 * - Category match: exact (+5), stem/prefix (+3), lexical synonym (+2)
 * - Title match:    exact (+4), stem/prefix (+2), lexical synonym (+1.5)
 * - Content match:  exact (+2, up to +2 extra for multiple occurrences), stem/prefix (+1.5), lexical synonym (+1)
 * - Sentence co-occurrence bonus: +2 per additional query concept co-occurring in the same sentence
 *
 * @param {object} entry - Context entry with category, title, content
 * @param {Array<{ raw: string, stem: string, synonyms?: string[] }>} queryKeywords
 * @returns {number}
 */
function scoreContextEntry(entry, queryKeywords) {
  if (!queryKeywords || queryKeywords.length === 0) {
    return 0;
  }

  const categoryTokens = tokenize(entry.category);
  const titleTokens = tokenize(entry.title);
  const contentTokens = tokenize(entry.content);

  let totalScore = 0;

  for (const queryKw of queryKeywords) {
    // 1. Category scoring
    const categoryMatch = evaluateFieldMatch(queryKw, categoryTokens);
    if (categoryMatch.exactMatches > 0) {
      totalScore += 5;
    } else if (categoryMatch.stemMatches > 0) {
      totalScore += 3;
    } else if (categoryMatch.synonymMatches > 0) {
      totalScore += 2;
    }

    // 2. Title scoring
    const titleMatch = evaluateFieldMatch(queryKw, titleTokens);
    if (titleMatch.exactMatches > 0) {
      totalScore += 4;
    } else if (titleMatch.stemMatches > 0) {
      totalScore += 2;
    } else if (titleMatch.synonymMatches > 0) {
      totalScore += 1.5;
    }

    // 3. Content scoring
    const contentMatch = evaluateFieldMatch(queryKw, contentTokens);
    if (contentMatch.exactMatches > 0) {
      totalScore += 2 + Math.min(contentMatch.exactMatches - 1, 2);
    } else if (contentMatch.stemMatches > 0) {
      totalScore += 1.5;
    } else if (contentMatch.synonymMatches > 0) {
      totalScore += 1;
    }
  }

  // 4. Sentence-level co-occurrence bonus for multi-sentence content fields
  if (totalScore > 0 && queryKeywords.length >= 2 && typeof entry.content === 'string') {
    const sentences = entry.content
      .split(/(?<=[.!?])\s+|\n+/)
      .map((s) => s.trim())
      .filter(Boolean);

    let maxCooccurringKeywords = 0;
    for (const sentence of sentences) {
      const sentenceTokens = tokenize(sentence);
      if (sentenceTokens.length === 0) continue;

      let matchedCount = 0;
      for (const queryKw of queryKeywords) {
        const m = evaluateFieldMatch(queryKw, sentenceTokens);
        if (m.exactMatches > 0 || m.stemMatches > 0 || m.synonymMatches > 0) {
          matchedCount += 1;
        }
      }
      if (matchedCount > maxCooccurringKeywords) {
        maxCooccurringKeywords = matchedCount;
      }
    }

    if (maxCooccurringKeywords >= 2) {
      totalScore += (maxCooccurringKeywords - 1) * 2;
    }
  }

  return totalScore;
}

/**
 * Dynamically compacts an extensive content field ONLY if it exceeds `maxChars`,
 * preserving the opening context sentence and the highest-scoring relevant sentences
 * in chronological order so token usage stays bounded without losing facts.
 *
 * @param {string} content
 * @param {Array<{ raw: string, stem: string, synonyms?: string[] }>} queryKeywords
 * @param {number} [maxChars=MAX_CONTEXT_ENTRY_CONTENT_CHARS]
 * @returns {string}
 */
function compactDynamicContent(
  content,
  queryKeywords,
  maxChars = MAX_CONTEXT_ENTRY_CONTENT_CHARS
) {
  if (typeof content !== 'string') {
    return '';
  }
  const trimmed = content.trim();
  if (trimmed.length <= Math.min(maxChars, MIN_SENTENCE_FILTER_THRESHOLD_CHARS)) {
    return trimmed;
  }

  const sentences = trimmed
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);

  if (sentences.length <= 1) {
    return trimmed.slice(0, maxChars);
  }

  const scoredSentences = sentences.map((sentence, idx) => {
    const tokens = tokenize(sentence);
    let score = 0;
    let matchedKeywords = 0;
    for (const queryKw of queryKeywords || []) {
      const m = evaluateFieldMatch(queryKw, tokens);
      if (m.exactMatches > 0) {
        score += 3;
        matchedKeywords += 1;
      } else if (m.stemMatches > 0) {
        score += 2;
        matchedKeywords += 1;
      } else if (m.synonymMatches > 0) {
        score += 1;
        matchedKeywords += 1;
      }
    }
    if (matchedKeywords >= 2) {
      score += (matchedKeywords - 1) * 2;
    }
    return { idx, sentence, score };
  });

  // Sort by highest score first to select relevant sentences within maxChars, then restore original sentence order
  const byRelevance = [...scoredSentences].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.idx - b.idx;
  });

  const selectedIndices = new Set();
  let currentLength = 0;

  for (const item of byRelevance) {
    if (selectedIndices.size > 0 && item.score === 0) {
      break;
    }
    const addition = item.sentence.length + (selectedIndices.size > 0 ? 1 : 0);
    if (currentLength + addition <= maxChars || selectedIndices.size === 0) {
      selectedIndices.add(item.idx);
      currentLength += addition;
    } else {
      break;
    }
  }

  return sentences
    .filter((_, idx) => selectedIndices.has(idx))
    .join(' ');
}

/**
 * Formats a product row from the `products` table into a structured context entry
 * so customer inquiries are grounded directly in the live `products.csv` catalog.
 * Supports compacting lengthy product descriptions when full size charts are not requested.
 *
 * @param {object} productRow
 * @param {object} [options]
 * @param {boolean} [options.compactDescription=false]
 * @returns {object}
 */
function formatProductRowAsContextEntry(productRow, options = {}) {
  const bestLabel = productRow.best ? 'Yes (Best Seller)' : 'No';
  let descriptionText = String(productRow.description || '').trim();

  if (options.compactDescription && descriptionText.length > MAX_COMPACT_PRODUCT_DESC_CHARS) {
    // Strip verbose ASCII Size Chart block when not specifically asked for measurements
    const beforeSizeChart = descriptionText.split(/Size Chart\s*[-–]/i)[0].trim();
    const baseText = beforeSizeChart || descriptionText;
    if (baseText.length > MAX_COMPACT_PRODUCT_DESC_CHARS) {
      descriptionText = `${baseText.slice(0, MAX_COMPACT_PRODUCT_DESC_CHARS).trim()}...`;
    } else {
      descriptionText = baseText;
    }
  }

  const contentParts = [
    `Product Name: ${productRow.name}`,
    `Category: ${productRow.category || 'shirt'}`,
    `Price: ${productRow.price}`,
    `Discount: ${productRow.discount ?? 0}%`,
    `Best Seller: ${bestLabel}`,
    `Available Colors: ${productRow.color || 'N/A'}`,
    `Available Sizes & Stock (JSON): ${productRow.size || 'N/A'}`,
    `Orders Placed: ${productRow.ordered ?? 0}`,
    `Description: ${descriptionText}`,
  ];

  return {
    id: productRow.id,
    business_id: productRow.business_id,
    category: productRow.category || 'product',
    title: productRow.name,
    content: contentParts.join('\n'),
    source_file: 'products.csv',
    created_at: productRow.created_at,
    updated_at: productRow.updated_at,
  };
}

/**
 * Scores a raw product row strictly on product-identifying fields (name, category, color)
 * and catalog inquiry intent so policy-only questions do not pull in verbose product rows.
 *
 * @param {object} productRow
 * @param {Array<{ raw: string, stem: string, synonyms?: string[] }>} queryKeywords
 * @returns {number}
 */
function scoreProductRow(productRow, queryKeywords) {
  if (!queryKeywords || queryKeywords.length === 0) {
    return 0;
  }

  const nameTokens = tokenize(productRow.name);
  const categoryTokens = tokenize(productRow.category);
  const colorTokens = tokenize(productRow.color);
  const descTokens = tokenize(productRow.description);

  let identityScore = 0;
  let catalogIntentMatched = false;
  let descScore = 0;

  for (const queryKw of queryKeywords) {
    if (CATALOG_INTENT_TOKENS.has(queryKw.raw) || CATALOG_INTENT_TOKENS.has(queryKw.stem)) {
      catalogIntentMatched = true;
    }

    const nameMatch = evaluateFieldMatch(queryKw, nameTokens);
    if (nameMatch.exactMatches > 0) {
      identityScore += 6;
    } else if (nameMatch.stemMatches > 0) {
      identityScore += 4;
    }

    const catMatch = evaluateFieldMatch(queryKw, categoryTokens);
    if (catMatch.exactMatches > 0) {
      identityScore += 5;
    } else if (catMatch.stemMatches > 0) {
      identityScore += 3;
    }

    const colorMatch = evaluateFieldMatch(queryKw, colorTokens);
    if (colorMatch.exactMatches > 0) {
      identityScore += 4;
    } else if (colorMatch.stemMatches > 0) {
      identityScore += 2;
    }

    const descMatch = evaluateFieldMatch(queryKw, descTokens);
    if (descMatch.exactMatches > 0) {
      descScore += 1.5;
    } else if (descMatch.stemMatches > 0) {
      descScore += 1;
    }
  }

  // Only count description or catalog matches if product identity or catalog intent was triggered
  if (identityScore === 0 && !catalogIntentMatched) {
    return 0;
  }

  let total = identityScore + descScore;
  if (catalogIntentMatched && total === 0) {
    total = productRow.best ? 2.5 : 1.5;
  }
  return total;
}

/**
 * Ranks a list of context entries by deterministic keyword relevance and returns top K.
 *
 * @param {Array<object>} entries - Context entries belonging to the business
 * @param {string} customerMessage - Customer's inquiry text
 * @param {number} [limit] - Maximum number of relevant records to return
 * @returns {Array<object>}
 */
function selectRelevantContextEntries(
  entries,
  customerMessage,
  limit = env.promptTopK
) {
  if (!Array.isArray(entries) || entries.length === 0) {
    return [];
  }

  const queryKeywords = extractQueryKeywords(customerMessage);
  if (queryKeywords.length === 0) {
    return [];
  }

  const scoredEntries = [];

  for (const entry of entries) {
    const score = scoreContextEntry(entry, queryKeywords);
    if (score > 0) {
      scoredEntries.push({
        ...entry,
        content: compactDynamicContent(entry.content, queryKeywords),
        relevanceScore: score,
      });
    }
  }

  // Deterministic sort: highest score first, then category, title, id
  scoredEntries.sort((a, b) => {
    if (b.relevanceScore !== a.relevanceScore) {
      return b.relevanceScore - a.relevanceScore;
    }
    const categoryCompare = String(a.category).localeCompare(String(b.category));
    if (categoryCompare !== 0) {
      return categoryCompare;
    }
    const titleCompare = String(a.title).localeCompare(String(b.title));
    if (titleCompare !== 0) {
      return titleCompare;
    }
    return String(a.id || '').localeCompare(String(b.id || ''));
  });

  return scoredEntries.slice(0, limit);
}

/**
 * Retrieves context entries (from `context_entries` table seeded by `sample-context.csv`)
 * and product catalog entries (from `products` table seeded by `products.csv`)
 * for a specific business from PostgreSQL, balancing both sources and enforcing a
 * strict token/character budget so responses arrive quickly and accurately.
 *
 * @param {string} businessId - UUID of the business
 * @param {string} customerMessage - Customer's message
 * @param {number} [limit] - Max relevant records to return (default 5)
 * @returns {Promise<Array<object>>}
 */
async function retrieveRelevantContextForBusiness(
  businessId,
  customerMessage,
  limit = env.promptTopK
) {
  const queryKeywords = extractQueryKeywords(customerMessage);
  if (queryKeywords.length === 0) {
    return [];
  }

  let contextEntries = [];
  try {
    const result = await query(
      `
        SELECT id, business_id, category, title, content, source_file, created_at, updated_at
        FROM context_entries
        WHERE business_id = $1
        ORDER BY id ASC;
      `,
      [businessId]
    );
    if (result && Array.isArray(result.rows)) {
      contextEntries = result.rows;
    }
  } catch {
    contextEntries = [];
  }

  let rawProducts = [];
  try {
    const productsResult = await query(
      `
        SELECT id, business_id, name, category, description, best, color, discount, ordered, images, size, price, created_at, updated_at
        FROM products
        WHERE business_id = $1
        ORDER BY best DESC, ordered DESC, name ASC;
      `,
      [businessId]
    );
    if (productsResult && Array.isArray(productsResult.rows)) {
      rawProducts = productsResult.rows;
    }
  } catch {
    // Fallback gracefully if running against a test mock without a products table
    rawProducts = [];
  }

  // 1. Score and rank company context entries (category, title, content)
  const allMatchedContext = selectRelevantContextEntries(
    contextEntries,
    customerMessage,
    limit
  );

  // Filter out weak incidental matches when a clear primary context match exists
  const topContextScore =
    allMatchedContext.length > 0 ? allMatchedContext[0].relevanceScore : 0;
  const filteredContext = allMatchedContext.filter(
    (entry) => entry.relevanceScore >= Math.max(2, topContextScore * 0.25)
  );

  // 2. Score and rank product rows only when the query has product/catalog relevance
  const wantsFullProductDetails = queryKeywords.some(
    (kw) =>
      PRODUCT_DETAIL_INTENT_TOKENS.has(kw.raw) ||
      PRODUCT_DETAIL_INTENT_TOKENS.has(kw.stem)
  );

  const scoredProducts = [];
  for (const productRow of rawProducts) {
    const pScore = scoreProductRow(productRow, queryKeywords);
    if (pScore > 0) {
      scoredProducts.push({
        productRow,
        relevanceScore: pScore,
      });
    }
  }

  scoredProducts.sort((a, b) => {
    if (b.relevanceScore !== a.relevanceScore) {
      return b.relevanceScore - a.relevanceScore;
    }
    return String(a.productRow.name || '').localeCompare(
      String(b.productRow.name || '')
    );
  });

  const topProductScore =
    scoredProducts.length > 0 ? scoredProducts[0].relevanceScore : 0;
  const productRatioThreshold =
    filteredContext.length > 0 && topProductScore >= 18 ? 0.75 : 0.4;
  const relevantProductRows = scoredProducts.filter(
    (item) =>
      item.relevanceScore >=
      Math.max(2, topProductScore * productRatioThreshold)
  );

  // 3. Allocate slots between context_entries and products so neither drowns out the other
  let selectedContext = [];
  let selectedProducts = [];

  if (filteredContext.length > 0 && relevantProductRows.length > 0) {
    const maxContextSlots = Math.min(filteredContext.length, Math.max(2, limit - 2));
    selectedContext = filteredContext.slice(0, maxContextSlots);
    const remainingSlots = Math.max(1, limit - selectedContext.length);
    selectedProducts = relevantProductRows.slice(0, remainingSlots);
  } else if (filteredContext.length > 0) {
    selectedContext = filteredContext.slice(0, Math.min(limit, 3));
  } else if (relevantProductRows.length > 0) {
    selectedProducts = relevantProductRows.slice(0, Math.min(limit, 4));
  }

  const formattedProducts = selectedProducts.map((item) => {
    const useCompact =
      !wantsFullProductDetails &&
      (selectedProducts.length > 1 || selectedContext.length > 0);
    return {
      ...formatProductRowAsContextEntry(item.productRow, {
        compactDescription: useCompact,
      }),
      relevanceScore: item.relevanceScore,
    };
  });

  // Interleave top context entries and top product entries so both domains are represented within budget
  const combined = [];
  const maxLen = Math.max(selectedContext.length, formattedProducts.length);
  for (let i = 0; i < maxLen; i += 1) {
    if (i < selectedContext.length) {
      combined.push(selectedContext[i]);
    }
    if (i < formattedProducts.length) {
      combined.push(formattedProducts[i]);
    }
  }

  // 4. Enforce overall character budget to keep input tokens compact and latency low
  const budgetedRecords = [];
  let totalChars = 0;

  for (const record of combined.slice(0, limit)) {
    const recordChars =
      (record.category ? record.category.length : 0) +
      (record.title ? record.title.length : 0) +
      (record.content ? record.content.length : 0);

    if (
      budgetedRecords.length > 0 &&
      totalChars + recordChars > MAX_TOTAL_CONTEXT_CHARS
    ) {
      const remainingChars = MAX_TOTAL_CONTEXT_CHARS - totalChars;
      if (remainingChars >= 200) {
        budgetedRecords.push({
          ...record,
          content: compactDynamicContent(
            record.content,
            queryKeywords,
            remainingChars
          ),
        });
        totalChars += remainingChars;
      }
      break;
    }

    budgetedRecords.push(record);
    totalChars += recordChars;
  }

  return budgetedRecords;
}

module.exports = {
  tokenize,
  stemWord,
  extractQueryKeywords,
  scoreContextEntry,
  compactDynamicContent,
  formatProductRowAsContextEntry,
  selectRelevantContextEntries,
  retrieveRelevantContextForBusiness,
};
