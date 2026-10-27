const { query } = require('../../db');
const env = require('../config/env');

const STOP_WORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'if', 'in', 'on', 'at', 'to', 'for',
  'of', 'with', 'by', 'from', 'up', 'about', 'into', 'over', 'after', 'is',
  'am', 'are', 'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had',
  'do', 'does', 'did', 'can', 'could', 'would', 'should', 'will', 'shall',
  'may', 'might', 'must', 'i', 'me', 'my', 'mine', 'we', 'us', 'our', 'ours',
  'you', 'your', 'yours', 'he', 'him', 'his', 'she', 'her', 'hers', 'it',
  'its', 'they', 'them', 'their', 'theirs', 'this', 'that', 'these', 'those',
  'what', 'which', 'who', 'whom', 'how', 'when', 'where', 'why', 'get', 'got',
  'getting', 'please', 'hi', 'hello', 'hey', 'thanks', 'thank', 'there', 'here',
  'some', 'any', 'much', 'many', 'so', 'too', 'very', 'just', 'now', 'then',
  'also', 'as', 'at', 'out', 'need', 'want', 'like', 'know'
]);

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
 * Extracts unique meaningful keywords from a customer message.
 *
 * @param {string} message
 * @returns {Array<{ raw: string, stem: string }>}
 */
function extractQueryKeywords(message) {
  const rawTokens = tokenize(message);
  const filtered = rawTokens.filter(
    (token) => token.length >= 2 && !STOP_WORDS.has(token)
  );

  // Fallback to all tokens >= 2 chars if message only consisted of stop words
  const effectiveTokens =
    filtered.length > 0
      ? filtered
      : rawTokens.filter((token) => token.length >= 2);

  const uniqueMap = new Map();
  for (const token of effectiveTokens) {
    if (!uniqueMap.has(token)) {
      uniqueMap.set(token, {
        raw: token,
        stem: stemWord(token),
      });
    }
  }

  return Array.from(uniqueMap.values());
}

/**
 * Checks how a query keyword matches against a list of field tokens.
 * Returns 'exact' | 'stem' | null and match count.
 */
function evaluateFieldMatch(queryKw, fieldTokens) {
  let exactMatches = 0;
  let stemMatches = 0;

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
      }
    }
  }

  return { exactMatches, stemMatches };
}

/**
 * Computes a deterministic keyword relevance score for a single context entry
 * against the extracted query keywords.
 *
 * Weighting hierarchy:
 * - Category match: exact (+5), stem/prefix (+3)
 * - Title match:    exact (+4), stem/prefix (+2)
 * - Content match:  exact (+2, +1 extra for multiple occurrences), stem/prefix (+1)
 *
 * @param {object} entry - Context entry with category, title, content
 * @param {Array<{ raw: string, stem: string }>} queryKeywords
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
    }

    // 2. Title scoring
    const titleMatch = evaluateFieldMatch(queryKw, titleTokens);
    if (titleMatch.exactMatches > 0) {
      totalScore += 4;
    } else if (titleMatch.stemMatches > 0) {
      totalScore += 2;
    }

    // 3. Content scoring
    const contentMatch = evaluateFieldMatch(queryKw, contentTokens);
    if (contentMatch.exactMatches > 0) {
      totalScore += 2 + Math.min(contentMatch.exactMatches - 1, 1);
    } else if (contentMatch.stemMatches > 0) {
      totalScore += 1;
    }
  }

  return totalScore;
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
    return Number(a.id || 0) - Number(b.id || 0);
  });

  return scoredEntries.slice(0, limit);
}

/**
 * Retrieves all context entries for a specific business from PostgreSQL
 * and returns the highest-scoring relevant records for the customer message.
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
  const result = await query(
    `
      SELECT id, business_id, category, title, content, source_file, created_at, updated_at
      FROM context_entries
      WHERE business_id = $1
      ORDER BY id ASC;
    `,
    [businessId]
  );

  return selectRelevantContextEntries(result.rows, customerMessage, limit);
}

module.exports = {
  tokenize,
  stemWord,
  extractQueryKeywords,
  scoreContextEntry,
  selectRelevantContextEntries,
  retrieveRelevantContextForBusiness,
};
