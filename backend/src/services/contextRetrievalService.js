const { query } = require('../../db');
const env = require('../config/env');
const {
  ENTITY_SCHEMAS,
  REGISTERED_SCHEMAS,
  getSchema,
} = require('./sheetSchemaService');
const { getInMemoryChunksForBusiness } = require('./documentIngestionService');

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
  ['delay', 'delayed', 'deferral', 'deferred', 'late', 'overdue', 'backlog', 'disruption', 'bottleneck', 'halt', 'hold'],
  ['sla', 'policy', 'breach', 'breached', 'voucher', 'credit', 'compensation', 'compensatory', 'remediation', 'promo', 'discount'],
  ['order', 'orders', 'consignment', 'consignments', 'shipment', 'shipments', 'purchase', 'hub', 'warehouse', 'depot'],
  ['cost', 'fee', 'fees', 'charge', 'charges', 'price', 'pricing', 'rate', 'rates', 'vat', 'tax', 'bdt', 'subtotal'],
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

const GENERIC_SHEET_METADATA_WORDS = new Set([
  'inventory', 'sheet', 'sheets', 'table', 'tables', 'data', 'list', 'csv',
  'record', 'records', 'file', 'files', 'id', 'business', 'created', 'updated',
  'name', 'names', 'price', 'prices', 'cost', 'costs', 'status', 'description',
  'notes', 'total', 'count', 'value', 'values', 'amount', 'number', 'code',
  'type', 'category', 'current', 'unit', 'item', 'items'
]);

const SERVICE_DOMAIN_TOKENS = new Set([
  'service', 'services', 'appointment', 'appointments', 'book', 'booking',
  'bookings', 'session', 'sessions', 'consultation', 'consultations',
  'duration', 'hourly', 'package', 'packages', 'alteration', 'alterations',
  'tailor', 'tailoring', 'styling', 'stylist', 'repair', 'repairs',
  'maintenance', 'cleaning', 'installation', 'specialist', 'turnaround',
  'therapist', 'provider', 'schedule'
]);

const ELECTRONICS_DOMAIN_TOKENS = new Set([
  'electronic', 'electronics', 'laptop', 'laptops', 'notebook', 'monitor',
  'monitors', 'asus', 'dell', 'hp', 'lenovo', 'rog', 'zenbook', 'xps',
  'thinkpad', 'ultrasharp', 'warranty', 'warehouse', 'reorder', 'tech',
  'computer', 'computers', 'hardware'
]);

const GROCERY_DOMAIN_TOKENS = new Set([
  'grocery', 'groceries', 'supermarket', 'food', 'foods', 'expiry',
  'expiration', 'perishable', 'batch', 'supplier', 'organic', 'fresh',
  'dairy', 'milk', 'rice', 'oil', 'honey', 'flour', 'butter', 'cheese',
  'produce', 'pantry'
]);

const BAKERY_DOMAIN_TOKENS = new Set([
  'cake', 'cakes', 'bakery', 'pastry', 'pastries', 'dessert', 'desserts',
  'flavor', 'flavour', 'frosting', 'icing', 'sponge', 'chocolate',
  'vanilla', 'velvet', 'strawberry', 'cheesecake', 'birthday', 'wedding',
  'slice', 'slices', 'loaf', 'bake', 'baked'
]);

const HANDBAG_DOMAIN_TOKENS = new Set([
  'handbag', 'handbags', 'bag', 'bags', 'tote', 'clutch', 'crossbody',
  'satchel', 'purse', 'purses', 'leather', 'strap', 'wallet', 'backpack'
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
 * Returns all candidate sheet schemas registered in memory for the application.
 *
 * @returns {Array<object>}
 */
function getCandidateSheetSchemas() {
  const byTable = new Map();
  const addSchema = (schema) => {
    if (!schema || !schema.entity || !schema.columns) return;
    const key = String(schema.tableName || schema.entity).toLowerCase();
    if (!byTable.has(key)) {
      byTable.set(key, schema);
    } else {
      // Prefer REGISTERED_SCHEMAS entry if it has representativeValues or more columns
      const existing = byTable.get(key);
      const existingRepCount = Object.keys(existing.representativeValues || {}).length;
      const newRepCount = Object.keys(schema.representativeValues || {}).length;
      if (newRepCount >= existingRepCount) {
        byTable.set(key, schema);
      }
    }
  };

  if (ENTITY_SCHEMAS && typeof ENTITY_SCHEMAS === 'object') {
    for (const s of Object.values(ENTITY_SCHEMAS)) {
      addSchema(s);
    }
  }
  if (REGISTERED_SCHEMAS && typeof REGISTERED_SCHEMAS.values === 'function') {
    for (const s of REGISTERED_SCHEMAS.values()) {
      addSchema(s);
    }
  }
  return Array.from(byTable.values());
}

/**
 * Infers domain-specific vocabulary tokens for a sheet schema based on its entity name,
 * display name, and column structure so natural-language customer queries route only
 * to the relevant CSV/sheet.
 *
 * @param {object} schema
 * @returns {Set<string>}
 */
function inferSchemaDomainTokens(schema) {
  const domainTokens = new Set();
  const entityLower = String(schema.entity || '').toLowerCase();
  const displayLower = String(schema.displayName || '').toLowerCase();
  const colNamesLower = Object.values(schema.columns || {}).map((c) =>
    String(c.exactName || '').toLowerCase()
  );

  // Entity and display name tokens (excluding generic words like "inventory", "sheet")
  for (const t of [...tokenize(entityLower), ...tokenize(displayLower)]) {
    if (t.length >= 2 && !GENERIC_SHEET_METADATA_WORDS.has(t)) {
      domainTokens.add(t);
      domainTokens.add(stemWord(t));
    }
  }

  // Distinct column name tokens (excluding generic metadata words)
  for (const colName of colNamesLower) {
    if ([
      'id',
      'business_id',
      'workspace_id',
      'user_id',
      'workspace_document_id',
      '_google_row_index',
      'created_at',
      'updated_at',
    ].includes(colName)) continue;
    for (const t of tokenize(colName)) {
      if (t.length >= 3 && !GENERIC_SHEET_METADATA_WORDS.has(t)) {
        domainTokens.add(t);
        domainTokens.add(stemWord(t));
      }
    }
  }

  // Domain expansions based on entity/column signatures
  const isProductsApparel =
    entityLower === 'products' ||
    (colNamesLower.includes('size') &&
      colNamesLower.includes('color') &&
      colNamesLower.includes('best'));
  if (isProductsApparel) {
    for (const t of CATALOG_INTENT_TOKENS) {
      domainTokens.add(t);
    }
  }

  const isServiceSheet =
    entityLower.includes('service') ||
    colNamesLower.some((c) =>
      /service|duration|hourly|session|consultation|therapist|provider|turnaround|appointment|booking/.test(c)
    );
  if (isServiceSheet) {
    for (const t of SERVICE_DOMAIN_TOKENS) {
      domainTokens.add(t);
    }
  }

  const isElectronicsSheet =
    entityLower.includes('electronic') ||
    (colNamesLower.some((c) => c.includes('warranty')) &&
      colNamesLower.some((c) => c.includes('brand') || c.includes('model')));
  if (isElectronicsSheet) {
    for (const t of ELECTRONICS_DOMAIN_TOKENS) {
      domainTokens.add(t);
    }
  }

  const isGrocerySheet =
    entityLower.includes('grocery') ||
    (colNamesLower.some((c) => c.includes('expiry') || c.includes('expiration')) &&
      colNamesLower.some((c) => c.includes('supplier') || c.includes('batch')));
  if (isGrocerySheet) {
    for (const t of GROCERY_DOMAIN_TOKENS) {
      domainTokens.add(t);
    }
  }

  const isBakerySheet =
    entityLower.includes('cake') ||
    entityLower.includes('bakery') ||
    colNamesLower.some((c) => /cake|flavor|flavour|frosting|icing|bakery|pastry/.test(c));
  if (isBakerySheet) {
    for (const t of BAKERY_DOMAIN_TOKENS) {
      domainTokens.add(t);
    }
  }

  const isHandbagSheet =
    entityLower.includes('handbag') ||
    entityLower.includes('bag') ||
    colNamesLower.some((c) => /handbag|bag_type|strap|leather/.test(c));
  if (isHandbagSheet) {
    for (const t of HANDBAG_DOMAIN_TOKENS) {
      domainTokens.add(t);
    }
  }

  return domainTokens;
}

/**
 * Scores a candidate sheet schema's relevance to the customer query BEFORE querying
 * all rows from the database, ensuring unrelated sheets are not queried or included.
 *
 * @param {object} schema
 * @param {Array<{ raw: string, stem: string, synonyms?: string[] }>} queryKeywords
 * @returns {number}
 */
function scoreSheetSchemaRelevance(schema, queryKeywords) {
  if (!schema || !Array.isArray(queryKeywords) || queryKeywords.length === 0) {
    return 0;
  }

  const entityTokens = [
    ...tokenize(schema.entity),
    ...tokenize(schema.displayName),
  ].filter((t) => !GENERIC_SHEET_METADATA_WORDS.has(t));

  const domainTokensSet = inferSchemaDomainTokens(schema);
  const domainTokensList = Array.from(domainTokensSet);

  const repValueTokens = [];
  if (schema.representativeValues && typeof schema.representativeValues === 'object') {
    for (const vals of Object.values(schema.representativeValues)) {
      if (Array.isArray(vals)) {
        for (const v of vals) {
          repValueTokens.push(...tokenize(String(v ?? '')));
        }
      }
    }
  }

  let score = 0;

  for (const kw of queryKeywords) {
    // 1. Direct match on sheet entity / display name (e.g. "services" vs "products" vs "cake")
    const entityMatch = evaluateFieldMatch(kw, entityTokens);
    if (entityMatch.exactMatches > 0) {
      score += 12;
    } else if (entityMatch.stemMatches > 0) {
      score += 9;
    } else if (entityMatch.synonymMatches > 0) {
      score += 6;
    }

    // 2. Match against representative catalog values of this sheet
    if (repValueTokens.length > 0) {
      const repMatch = evaluateFieldMatch(kw, repValueTokens);
      if (repMatch.exactMatches > 0) {
        score += 10;
      } else if (repMatch.stemMatches > 0) {
        score += 7;
      }
    }

    // 3. Match against column & domain tokens of this sheet
    if (domainTokensSet.has(kw.raw) || domainTokensSet.has(kw.stem)) {
      score += 6;
    } else {
      const domMatch = evaluateFieldMatch(kw, domainTokensList);
      if (domMatch.exactMatches > 0) {
        score += 6;
      } else if (domMatch.stemMatches > 0) {
        score += 4;
      }
    }
  }

  return score;
}

/**
 * Selects only the relevant business sheet(s) for a customer query so unrelated
 * CSV tables belonging to the business are never queried or mixed into the context.
 *
 * @param {Array<object>} candidateSchemas
 * @param {Array<{ raw: string, stem: string, synonyms?: string[] }>} queryKeywords
 * @returns {Array<{ schema: object, sheetScore: number }>}
 */
function selectRelevantBusinessSheets(candidateSchemas, queryKeywords) {
  if (!Array.isArray(candidateSchemas) || candidateSchemas.length === 0) {
    return [];
  }
  if (!Array.isArray(queryKeywords) || queryKeywords.length === 0) {
    return [];
  }

  const scored = [];
  for (const schema of candidateSchemas) {
    const sheetScore = scoreSheetSchemaRelevance(schema, queryKeywords);
    if (sheetScore > 0) {
      scored.push({ schema, sheetScore });
    }
  }

  if (scored.length === 0) {
    return [];
  }

  scored.sort((a, b) => b.sheetScore - a.sheetScore);
  const topSheetScore = scored[0].sheetScore;

  // Keep only sheets strongly relevant to the inquiry (prevents querying unrelated sheets)
  return scored.filter((item) => item.sheetScore >= Math.max(4, topSheetScore * 0.5));
}

/**
 * Scores a single row from any arbitrary business sheet against the customer's query keywords.
 *
 * @param {object} row
 * @param {object} schema
 * @param {Array<{ raw: string, stem: string, synonyms?: string[] }>} queryKeywords
 * @param {number} [sheetScore=0]
 * @returns {number}
 */
function scoreSheetRow(row, schema, queryKeywords, sheetScore = 0) {
  if (!row || !queryKeywords || queryKeywords.length === 0) {
    return 0;
  }

  if (!schema || schema.entity === 'products') {
    return scoreProductRow(row, queryKeywords);
  }

  const identityTokens = [];
  const categoryTokens = [];
  const detailTokens = [];
  const colNameTokens = [];

  for (const [key, rawVal] of Object.entries(row)) {
    const lowerKey = key.toLowerCase();
    if ([
      'id',
      'business_id',
      'workspace_id',
      'user_id',
      'workspace_document_id',
      '_google_row_index',
      'created_at',
      'updated_at',
    ].includes(lowerKey)) {
      continue;
    }
    if (rawVal === null || rawVal === undefined || rawVal === '') {
      continue;
    }

    const valTokens = tokenize(String(rawVal));
    colNameTokens.push(...tokenize(key));

    if (
      /name|title|model|service|cake|bag|item|sku|code/.test(lowerKey)
    ) {
      identityTokens.push(...valTokens);
    } else if (
      /category|brand|type|department|supplier|vendor|warehouse|location|color|flavor|flavour|material|style|status|specialist|provider|package/.test(
        lowerKey
      )
    ) {
      categoryTokens.push(...valTokens);
    } else {
      detailTokens.push(...valTokens);
    }
  }

  let identityScore = 0;
  let categoryScore = 0;
  let detailScore = 0;
  let colNameScore = 0;

  for (const queryKw of queryKeywords) {
    const idMatch = evaluateFieldMatch(queryKw, identityTokens);
    if (idMatch.exactMatches > 0) {
      identityScore += 6;
    } else if (idMatch.stemMatches > 0) {
      identityScore += 4;
    } else if (idMatch.synonymMatches > 0) {
      identityScore += 2;
    }

    const catMatch = evaluateFieldMatch(queryKw, categoryTokens);
    if (catMatch.exactMatches > 0) {
      categoryScore += 5;
    } else if (catMatch.stemMatches > 0) {
      categoryScore += 3;
    } else if (catMatch.synonymMatches > 0) {
      categoryScore += 2;
    }

    const detMatch = evaluateFieldMatch(queryKw, detailTokens);
    if (detMatch.exactMatches > 0) {
      detailScore += 2;
    } else if (detMatch.stemMatches > 0) {
      detailScore += 1.5;
    } else if (detMatch.synonymMatches > 0) {
      detailScore += 1;
    }

    const colMatch = evaluateFieldMatch(queryKw, colNameTokens);
    if (colMatch.exactMatches > 0 || colMatch.stemMatches > 0) {
      colNameScore += 1.5;
    }
  }

  const rowSpecificScore = identityScore + categoryScore + detailScore;
  if (rowSpecificScore > 0) {
    return rowSpecificScore + colNameScore;
  }

  // If the customer asked a general domain question targeting this sheet (e.g. "What services do you offer?"),
  // include top rows from this sheet with a baseline relevance score.
  if (sheetScore >= 6) {
    return 2.0 + colNameScore;
  }

  return 0;
}

/**
 * Formats a row from any arbitrary business sheet into a structured context entry
 * for grounding customer response generation.
 *
 * @param {object} row
 * @param {object} schema
 * @param {object} [options]
 * @param {boolean} [options.compactDescription=false]
 * @returns {object}
 */
function formatSheetRowAsContextEntry(row, schema, options = {}) {
  if (!schema || schema.entity === 'products') {
    return formatProductRowAsContextEntry(row, options);
  }

  const entries = Object.entries(row).filter(
    ([k, v]) =>
      ![
        'id',
        'business_id',
        'workspace_id',
        'user_id',
        'workspace_document_id',
        '_google_row_index',
        'created_at',
        'updated_at',
      ].includes(k.toLowerCase()) &&
      v !== undefined &&
      v !== null &&
      String(v).trim() !== ''
  );

  // Determine title and category dynamically
  let title = null;
  let category = schema.displayName || schema.entity;

  for (const [k, v] of entries) {
    const lower = k.toLowerCase();
    if (!title && /name|title|model|service|cake|bag|item/.test(lower)) {
      title = String(v).trim();
    }
    if (/category|type|department|brand|supplier/.test(lower)) {
      category = String(v).trim();
    }
  }

  if (!title && entries.length > 0) {
    title = String(entries[0][1]).trim();
  }

  const contentParts = [`Sheet: ${schema.displayName || schema.entity} (${schema.entity}.csv)`];
  for (const [k, v] of entries) {
    const label = k.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
    let valStr = typeof v === 'object' ? JSON.stringify(v) : String(v).trim();
    if (
      options.compactDescription &&
      /desc|detail|note/.test(k.toLowerCase()) &&
      valStr.length > MAX_COMPACT_PRODUCT_DESC_CHARS
    ) {
      valStr = `${valStr.slice(0, MAX_COMPACT_PRODUCT_DESC_CHARS).trim()}...`;
    }
    contentParts.push(`${label}: ${valStr}`);
  }

  return {
    id: row.id,
    business_id: row.business_id,
    category: category || schema.entity,
    title: title || `${schema.displayName || schema.entity} Record`,
    content: contentParts.join('\n'),
    source_file: `${schema.entity}.csv`,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
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

  // Merge any ingested unstructured document chunks (PDF/MD/TXT) for this business
  const docChunks = getInMemoryChunksForBusiness(businessId);
  if (docChunks.length > 0) {
    for (const chunk of docChunks) {
      contextEntries.push({
        id: chunk.chunk_id,
        business_id: businessId,
        category: chunk.filename,
        title: chunk.section_title || `${chunk.filename} (Page ${chunk.page_number})`,
        content: chunk.raw_text,
        source_file: chunk.filename,
        page_number: chunk.page_number,
        chunk_index: chunk.chunk_index,
      });
    }
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

  // 2. Dynamically select ONLY the relevant business sheet(s) for this customer inquiry
  const candidateSchemas = getCandidateSheetSchemas();
  let selectedSheets = selectRelevantBusinessSheets(candidateSchemas, queryKeywords);

  // Fallback: if no sheet matched by domain/metadata tokens and company policy context did not strongly match,
  // check the primary products catalog so direct item-name lookups without category words still resolve.
  if (selectedSheets.length === 0 && topContextScore < 8) {
    const productsSchema = candidateSchemas.find((s) => s.entity === 'products');
    if (productsSchema) {
      selectedSheets = [{ schema: productsSchema, sheetScore: 0 }];
    }
  }

  const wantsFullProductDetails = queryKeywords.some(
    (kw) =>
      PRODUCT_DETAIL_INTENT_TOKENS.has(kw.raw) ||
      PRODUCT_DETAIL_INTENT_TOKENS.has(kw.stem)
  );

  const scoredSheetRows = [];

  for (const { schema, sheetScore } of selectedSheets) {
    let rawRows = [];
    try {
      const whereBizSql = schema?.columns?.workspace_id
        ? '(business_id = $1 OR workspace_id = $1)'
        : 'business_id = $1';
      if (schema.entity === 'products') {
        const productsResult = await query(
          `
            SELECT id, business_id, name, category, description, best, color, discount, ordered, images, size, price, created_at, updated_at
            FROM products
            WHERE ${whereBizSql}
            ORDER BY best DESC, ordered DESC, name ASC;
          `,
          [businessId]
        );
        if (productsResult && Array.isArray(productsResult.rows)) {
          rawRows = productsResult.rows;
        }
      } else {
        const safeTableName = String(schema.tableName || schema.entity).replace(
          /[^a-z0-9_]/gi,
          '_'
        );
        const sheetResult = await query(
          `SELECT * FROM "${safeTableName}" WHERE ${whereBizSql};`,
          [businessId]
        );
        if (sheetResult && Array.isArray(sheetResult.rows)) {
          rawRows = sheetResult.rows;
        }
      }
    } catch {
      rawRows = [];
    }

    for (const row of rawRows) {
      const rScore =
        schema.entity === 'products'
          ? scoreProductRow(row, queryKeywords)
          : scoreSheetRow(row, schema, queryKeywords, sheetScore);
      if (rScore > 0) {
        scoredSheetRows.push({
          row,
          schema,
          relevanceScore: rScore,
        });
      }
    }
  }

  scoredSheetRows.sort((a, b) => {
    if (b.relevanceScore !== a.relevanceScore) {
      return b.relevanceScore - a.relevanceScore;
    }
    const nameA = String(
      a.row.name || a.row.Product_Name || a.row.Item_Name || a.row.Service_Name || a.row.id || ''
    );
    const nameB = String(
      b.row.name || b.row.Product_Name || b.row.Item_Name || b.row.Service_Name || b.row.id || ''
    );
    return nameA.localeCompare(nameB);
  });

  const topSheetRowScore =
    scoredSheetRows.length > 0 ? scoredSheetRows[0].relevanceScore : 0;
  const sheetRatioThreshold =
    filteredContext.length > 0 && topSheetRowScore >= 18 ? 0.75 : 0.4;
  const relevantSheetRows = scoredSheetRows.filter(
    (item) =>
      item.relevanceScore >=
      Math.max(2, topSheetRowScore * sheetRatioThreshold)
  );

  // 3. Allocate slots between context_entries and relevant sheet rows so neither drowns out the other
  let selectedContext = [];
  let selectedCatalogItems = [];

  if (filteredContext.length > 0 && relevantSheetRows.length > 0) {
    const maxContextSlots = Math.min(filteredContext.length, Math.max(2, limit - 2));
    selectedContext = filteredContext.slice(0, maxContextSlots);
    const remainingSlots = Math.max(1, limit - selectedContext.length);
    selectedCatalogItems = relevantSheetRows.slice(0, remainingSlots);
  } else if (filteredContext.length > 0) {
    selectedContext = filteredContext.slice(0, Math.min(limit, 3));
  } else if (relevantSheetRows.length > 0) {
    selectedCatalogItems = relevantSheetRows.slice(0, Math.min(limit, 4));
  }

  const formattedSheetEntries = selectedCatalogItems.map((item) => {
    const useCompact =
      !wantsFullProductDetails &&
      (selectedCatalogItems.length > 1 || selectedContext.length > 0);
    return {
      ...formatSheetRowAsContextEntry(item.row, item.schema, {
        compactDescription: useCompact,
      }),
      relevanceScore: item.relevanceScore,
    };
  });

  // Interleave top context entries and top sheet entries so both domains are represented within budget
  const combined = [];
  const maxLen = Math.max(selectedContext.length, formattedSheetEntries.length);
  for (let i = 0; i < maxLen; i += 1) {
    if (i < selectedContext.length) {
      combined.push(selectedContext[i]);
    }
    if (i < formattedSheetEntries.length) {
      combined.push(formattedSheetEntries[i]);
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

const CONVERSATIONAL_GREETING_PATTERNS =
  /^(?:hi|hello|hey|greetings|good\s+(?:morning|afternoon|evening|day)|howdy|yo|sup|thanks|thank\s+you|ok|okay|help|tell\s+me|what\s+can\s+you\s+do|are\s+you\s+there)[!.?\s]*$/i;

/**
 * Detects whether a prompt is a short conversational greeting or generic non-domain
 * input (e.g., "Hello", "Tell me") so callers can bypass empty lexical failures
 * and respond naturally without throwing zero-match errors.
 *
 * @param {string} message
 * @returns {{ isConversational: boolean, intent: string | null, suggestedReply: string | null }}
 */
function detectConversationalIntent(message) {
  if (!message || typeof message !== 'string') {
    return {
      isConversational: true,
      intent: 'empty_input',
      suggestedReply: 'Hello! How can I assist you today?',
    };
  }

  const trimmed = message.trim();
  const queryKeywords = extractQueryKeywords(trimmed);
  if (CONVERSATIONAL_GREETING_PATTERNS.test(trimmed) || queryKeywords.length === 0) {
    return {
      isConversational: true,
      intent: 'greeting_or_conversational',
      suggestedReply:
        'Hello! I am ready to help you with your orders, inventory spreadsheets, company policies, or customer inquiries. What would you like to check or update?',
    };
  }

  return {
    isConversational: false,
    intent: null,
    suggestedReply: null,
  };
}

module.exports = {
  SYNONYM_LOOKUP,
  tokenize,
  stemWord,
  extractQueryKeywords,
  evaluateFieldMatch,
  scoreContextEntry,
  compactDynamicContent,
  formatProductRowAsContextEntry,
  formatSheetRowAsContextEntry,
  scoreProductRow,
  scoreSheetRow,
  getCandidateSheetSchemas,
  scoreSheetSchemaRelevance,
  selectRelevantBusinessSheets,
  selectRelevantContextEntries,
  retrieveRelevantContextForBusiness,
  detectConversationalIntent,
};
