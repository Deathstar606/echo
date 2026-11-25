const env = require('../../config/env');
const { getPool } = require('../../../db');

const GEMINI_EMBEDDING_BASE_URL =
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001';
const EMBEDDING_DIM = 768;
const DEFAULT_BATCH_SIZE = 20;
const EMBEDDING_TIMEOUT_MS = 20000;

let customEmbeddingGenerator = null;

/**
 * Allows overriding embedding generation in offline tests.
 * Receives ({ texts, taskType, outputDimensionality }) and returns number[][].
 *
 * @param {Function | null} fn
 */
function setEmbeddingGenerator(fn) {
  customEmbeddingGenerator = fn;
}

function hasCustomEmbeddingGenerator() {
  return typeof customEmbeddingGenerator === 'function';
}

/**
 * Checks whether the currently configured pool is a live PostgreSQL pool
 * (as opposed to an in-memory unit-test mock pool).
 *
 * @returns {boolean}
 */
function isLivePostgresPool() {
  try {
    const pool = getPool();
    return Boolean(
      pool &&
        typeof pool.query === 'function' &&
        typeof pool.connect === 'function' &&
        env.databaseUrl
    );
  } catch {
    return false;
  }
}

/**
 * Deterministic L2 normalization.
 * Required for truncated gemini-embedding-001 outputs (< 3072 dims).
 *
 * @param {number[]} vec
 * @returns {number[]}
 */
function l2Normalize(vec) {
  if (!Array.isArray(vec) || vec.length === 0) return [];
  let sumSq = 0;
  for (let i = 0; i < vec.length; i += 1) {
    const v = Number(vec[i]) || 0;
    sumSq += v * v;
  }
  const norm = Math.sqrt(sumSq);
  if (!Number.isFinite(norm) || norm === 0) {
    return vec.map(() => 0);
  }
  const normalized = new Array(vec.length);
  for (let i = 0; i < vec.length; i += 1) {
    normalized[i] = (Number(vec[i]) || 0) / norm;
  }
  return normalized;
}

/**
 * Formats an embedding array into pgvector/halfvec literal syntax `"[v1,v2,...]"`.
 *
 * @param {number[]} vec
 * @returns {string | null}
 */
function formatPgVectorLiteral(vec) {
  if (!Array.isArray(vec) || vec.length === 0) return null;
  return `[${vec.map((v) => Number(v).toFixed(7)).join(',')}]`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithRetry(url, bodyPayload) {
  let lastError = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(bodyPayload),
        signal: AbortSignal.timeout(EMBEDDING_TIMEOUT_MS),
      });

      if (response.ok) {
        return await response.json();
      }

      const errBody = await response.text().catch(() => '');
      const retriable = response.status === 429 || response.status >= 500;
      lastError = new Error(
        `Gemini embedding API HTTP ${response.status}: ${errBody.slice(0, 240)}`
      );
      if (retriable && attempt < 3) {
        let delayMs = response.status === 429 ? 5000 * (attempt + 1) : 1000 * (attempt + 1);
        const retryMatch = errBody.match(/retry in\s+(\d+(?:\.\d+)?)s/i);
        if (retryMatch) {
          delayMs = Math.min(30000, Math.ceil(Number(retryMatch[1]) * 1000) + 500);
        }
        await sleep(delayMs);
        continue;
      }
      throw lastError;
    } catch (err) {
      lastError = err;
      const isAbortOrNetwork =
        err?.name === 'AbortError' ||
        err?.name === 'TimeoutError' ||
        /fetch failed|network|ECONNRESET|ETIMEDOUT/i.test(String(err?.message || ''));
      if (attempt === 0 && isAbortOrNetwork) {
        await sleep(800);
        continue;
      }
      throw err;
    }
  }
  throw lastError || new Error('Gemini embedding request failed.');
}

/**
 * Generates an L2-normalized 768-dim embedding for a single text query or document.
 * Gracefully degrades (returns { ok: false, vector: null }) if the API is unreachable.
 *
 * @param {string} text
 * @param {{ taskType?: 'RETRIEVAL_QUERY' | 'RETRIEVAL_DOCUMENT' }} [options]
 * @returns {Promise<{ ok: boolean, vector: number[] | null, literal: string | null, fallbackReason?: string }>}
 */
async function embedText(text, options = {}) {
  const cleanText = String(text || '').trim();
  const taskType = options.taskType || 'RETRIEVAL_QUERY';
  if (!cleanText) {
    return { ok: false, vector: null, literal: null, fallbackReason: 'empty_text' };
  }

  if (customEmbeddingGenerator) {
    const out = await customEmbeddingGenerator({
      texts: [cleanText],
      taskType,
      outputDimensionality: EMBEDDING_DIM,
    });
    const raw = Array.isArray(out?.[0]) ? out[0] : [];
    const normalized = l2Normalize(raw);
    return {
      ok: normalized.length === EMBEDDING_DIM,
      vector: normalized.length === EMBEDDING_DIM ? normalized : null,
      literal: normalized.length === EMBEDDING_DIM ? formatPgVectorLiteral(normalized) : null,
    };
  }

  if (!env.geminiApiKey) {
    return {
      ok: false,
      vector: null,
      literal: null,
      fallbackReason: 'missing_gemini_api_key',
    };
  }

  try {
    const url = `${GEMINI_EMBEDDING_BASE_URL}:embedContent?key=${encodeURIComponent(
      env.geminiApiKey
    )}`;
    const data = await fetchWithRetry(url, {
      model: 'models/gemini-embedding-001',
      content: { parts: [{ text: cleanText }] },
      taskType,
      outputDimensionality: EMBEDDING_DIM,
    });
    const rawValues = data?.embedding?.values;
    if (!Array.isArray(rawValues) || rawValues.length !== EMBEDDING_DIM) {
      return {
        ok: false,
        vector: null,
        literal: null,
        fallbackReason: 'invalid_embedding_shape',
      };
    }
    const normalized = l2Normalize(rawValues);
    return {
      ok: true,
      vector: normalized,
      literal: formatPgVectorLiteral(normalized),
    };
  } catch (err) {
    return {
      ok: false,
      vector: null,
      literal: null,
      fallbackReason: err?.message || 'embedding_api_error',
    };
  }
}

/**
 * Convenience wrapper for query embeddings (`taskType: 'RETRIEVAL_QUERY'`).
 *
 * @param {string} queryText
 */
async function embedQuery(queryText) {
  return embedText(queryText, { taskType: 'RETRIEVAL_QUERY' });
}

/**
 * Batch-embeds document chunks (`taskType: 'RETRIEVAL_DOCUMENT'`) in batches of 20.
 * Always L2-normalizes truncated 768-dim vectors.
 * Returns { ok, vectors, literals, fallbackReason } without throwing on transient outages.
 *
 * @param {string[]} texts
 * @param {{ batchSize?: number, taskType?: 'RETRIEVAL_DOCUMENT' | 'RETRIEVAL_QUERY' }} [options]
 */
async function embedDocuments(texts, options = {}) {
  const list = Array.isArray(texts) ? texts.map((t) => String(t || '').trim()) : [];
  if (list.length === 0) {
    return { ok: true, vectors: [], literals: [] };
  }

  const batchSize = Math.max(1, Math.min(20, Number(options.batchSize) || DEFAULT_BATCH_SIZE));
  const taskType = options.taskType || 'RETRIEVAL_DOCUMENT';

  if (customEmbeddingGenerator) {
    const out = await customEmbeddingGenerator({
      texts: list,
      taskType,
      outputDimensionality: EMBEDDING_DIM,
    });
    const vectors = list.map((_, idx) => {
      const vec = Array.isArray(out?.[idx]) ? l2Normalize(out[idx]) : null;
      return vec && vec.length === EMBEDDING_DIM ? vec : null;
    });
    return {
      ok: vectors.every(Boolean),
      vectors,
      literals: vectors.map((v) => (v ? formatPgVectorLiteral(v) : null)),
    };
  }

  if (!env.geminiApiKey) {
    return {
      ok: false,
      vectors: list.map(() => null),
      literals: list.map(() => null),
      fallbackReason: 'missing_gemini_api_key',
    };
  }

  const vectors = new Array(list.length).fill(null);
  let fallbackReason = null;

  try {
    const url = `${GEMINI_EMBEDDING_BASE_URL}:batchEmbedContents?key=${encodeURIComponent(
      env.geminiApiKey
    )}`;
    for (let start = 0; start < list.length; start += batchSize) {
      const slice = list.slice(start, start + batchSize);
      const requests = slice.map((text) => ({
        model: 'models/gemini-embedding-001',
        content: { parts: [{ text: text || ' ' }] },
        taskType,
        outputDimensionality: EMBEDDING_DIM,
      }));
      const data = await fetchWithRetry(url, { requests });
      const embeddings = Array.isArray(data?.embeddings) ? data.embeddings : [];
      for (let i = 0; i < slice.length; i += 1) {
        const vals = embeddings[i]?.values;
        if (Array.isArray(vals) && vals.length === EMBEDDING_DIM) {
          vectors[start + i] = l2Normalize(vals);
        }
      }
    }
  } catch (err) {
    fallbackReason = err?.message || 'batch_embedding_error';
  }

  const literals = vectors.map((v) => (v ? formatPgVectorLiteral(v) : null));
  const allPresent = vectors.every((v) => Array.isArray(v) && v.length === EMBEDDING_DIM);
  return {
    ok: allPresent,
    vectors,
    literals,
    ...(fallbackReason ? { fallbackReason } : {}),
  };
}

module.exports = {
  EMBEDDING_DIM,
  DEFAULT_BATCH_SIZE,
  setEmbeddingGenerator,
  hasCustomEmbeddingGenerator,
  isLivePostgresPool,
  l2Normalize,
  formatPgVectorLiteral,
  embedText,
  embedQuery,
  embedDocuments,
};
