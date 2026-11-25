const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { query, withTransaction } = require('../../../db');
const AppError = require('../../utils/AppError');
const {
  embedDocuments,
  hasCustomEmbeddingGenerator,
  isLivePostgresPool,
} = require('./embeddingService');

const DOC_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VALID_DOC_TYPES = new Set(['policy', 'sop', 'manifest', 'faq', 'catalog', 'general']);
const TARGET_CHUNK_MAX_WORDS = 260; // ~345 tokens (target 250-400 tokens/chunk)
const INTRA_SECTION_OVERLAP_MIN_WORDS = 32; // ~42 tokens
const INTRA_SECTION_OVERLAP_MAX_WORDS = 45; // ~60 tokens

let cachedVectorType = undefined;

async function getChunkVectorColumnType() {
  if (!isLivePostgresPool()) return null;
  if (cachedVectorType !== undefined) return cachedVectorType;
  try {
    const res = await query(
      `SELECT udt_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'workspace_document_chunks' AND column_name = 'embedding' LIMIT 1;`
    );
    const udt = String(res?.rows?.[0]?.udt_name || '').toLowerCase();
    cachedVectorType = udt === 'halfvec' || udt === 'vector' ? udt : null;
  } catch {
    cachedVectorType = null;
  }
  return cachedVectorType;
}

function estimateTokenCount(text) {
  const words = estimateWordCount(text);
  if (words === 0) return 0;
  return Math.max(words, Math.ceil(words * 1.33));
}

function inferDocType(filename, title = '', bodySample = '') {
  const headerText = `${filename || ''} ${title || ''} ${String(bodySample || '').slice(0, 600)}`.toLowerCase();
  if (/\b(?:sop|standard operating procedure|operating procedure|protocol)\b/i.test(headerText)) {
    return 'sop';
  }
  if (/\b(?:manifest|dispatch|receiving|preorder|pre-order|invoices?|transfer_manifest|shipment list)\b/i.test(headerText)) {
    return 'manifest';
  }
  if (/\b(?:faq|frequently asked|q\s*&\s*a|questions?\s+and\s+answers?)\b/i.test(headerText)) {
    return 'faq';
  }
  if (/\b(?:catalog|catalogue|lookbook|line sheet)\b/i.test(headerText)) {
    return 'catalog';
  }
  if (/\b(?:policy|policies|sla|underwriting|addendum|compliance|recall|governance|brief|buffer|reserve|credit control)\b/i.test(headerText)) {
    return 'policy';
  }
  return 'general';
}

function extractTrailingOverlap(cleanBody, minWords = INTRA_SECTION_OVERLAP_MIN_WORDS, maxWords = INTRA_SECTION_OVERLAP_MAX_WORDS) {
  const trimmed = String(cleanBody || '').trim();
  if (!trimmed) return '';
  const words = trimmed.split(/\s+/).filter(Boolean);
  if (words.length <= minWords) return '';
  const windowWords = words.slice(-Math.min(maxWords, Math.max(minWords, Math.floor(words.length * 0.2))));
  const windowText = windowWords.join(' ');
  // Prefer snapping to a clean sentence boundary inside the trailing window when possible
  const sentenceBreak = windowText.match(/[.!?]\s+([A-Z0-9["(].*)$/);
  if (sentenceBreak && estimateWordCount(sentenceBreak[1]) >= Math.floor(minWords * 0.6)) {
    return sentenceBreak[1].trim();
  }
  return windowText.trim();
}

/**
 * In-memory business-scoped document & chunk store (synchronized with PostgreSQL when available)
 * so both live PostgreSQL databases and lightweight mock test pools have immediate access
 * to ingested unstructured documents and chunks.
 */
const DOCUMENTS_BY_BUSINESS = new Map();
const CHUNKS_BY_BUSINESS = new Map();

/**
 * Tokenizes text into lowercase alphanumeric words and domain tokens (preserving hyphenated codes like POL-SLA-48H-2026 or FUR-OF-016).
 *
 * @param {string} text
 * @returns {string[]}
 */
function tokenizeDocumentText(text) {
  if (!text || typeof text !== 'string') return [];
  const lower = text.toLowerCase();
  const codeMatches = lower.match(/\b[a-z0-9]+(?:-[a-z0-9]+)+\b/g) || [];
  const wordMatches = lower
    .replace(/[^a-z0-9%]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter((w) => w.length >= 2);
  return [...wordMatches, ...codeMatches];
}

/**
 * Builds a normalized term-frequency (TF) + character 3-gram map for dense/sparse cosine similarity.
 *
 * @param {string} text
 * @returns {Record<string, number>}
 */
function buildTextVector(text) {
  const tokens = tokenizeDocumentText(text);
  const counts = {};
  for (const token of tokens) {
    counts[token] = (counts[token] || 0) + 1;
    if (token.length >= 4) {
      const prefix = `pre:${token.slice(0, 4)}`;
      counts[prefix] = (counts[prefix] || 0) + 0.5;
    }
  }
  const norm = Math.sqrt(
    Object.values(counts).reduce((acc, v) => acc + v * v, 0)
  );
  if (norm > 0) {
    for (const k of Object.keys(counts)) {
      counts[k] = Number((counts[k] / norm).toFixed(6));
    }
  }
  return counts;
}

/**
 * Parses a PDF ToUnicode CMap stream (beginbfchar and beginbfrange) into a Map<number, string>.
 *
 * @param {string} cmapText
 * @returns {Map<number, string>}
 */
function parsePdfCMap(cmapText) {
  const map = new Map();
  if (!cmapText || typeof cmapText !== 'string') return map;

  for (const b of cmapText.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const p of b[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
      const srcCode = Number.parseInt(p[1], 16);
      const dstHex = p[2];
      let decoded = '';
      for (let i = 0; i < dstHex.length; i += 4) {
        const cp = Number.parseInt(dstHex.slice(i, i + 4), 16);
        if (Number.isFinite(cp)) {
          decoded += String.fromCodePoint(cp);
        }
      }
      map.set(srcCode, decoded);
    }
  }

  for (const b of cmapText.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const r of b[1].matchAll(
      /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g
    )) {
      const start = Number.parseInt(r[1], 16);
      const end = Number.parseInt(r[2], 16);
      const base = Number.parseInt(r[3], 16);
      if (Number.isFinite(start) && Number.isFinite(end) && Number.isFinite(base)) {
        for (let c = start; c <= end; c += 1) {
          map.set(c, String.fromCodePoint(base + (c - start)));
        }
      }
    }
  }

  return map;
}

/**
 * Decodes a single PDF string literal `(...)` or hex string `<...>` using the active font's CMap.
 *
 * @param {string} token
 * @param {Map<number, string> | null} cmap
 * @returns {string}
 */
function decodePdfStringToken(token, cmap) {
  const bytes = [];
  if (token.startsWith('<') && token.endsWith('>')) {
    const hex = token.slice(1, -1).replace(/\s+/g, '');
    for (let i = 0; i < hex.length; i += 2) {
      bytes.push(Number.parseInt(hex.slice(i, i + 2), 16));
    }
  } else if (token.startsWith('(') && token.endsWith(')')) {
    const inner = token.slice(1, -1);
    for (let i = 0; i < inner.length; i += 1) {
      if (inner[i] === '\\') {
        i += 1;
        if (i >= inner.length) break;
        const ch = inner[i];
        if (ch === 'n') bytes.push(10);
        else if (ch === 'r') bytes.push(13);
        else if (ch === 't') bytes.push(9);
        else if (ch === 'b') bytes.push(8);
        else if (ch === 'f') bytes.push(12);
        else if (/[0-7]/.test(ch)) {
          let oct = ch;
          if (/[0-7]/.test(inner[i + 1] || '')) oct += inner[++i];
          if (/[0-7]/.test(inner[i + 1] || '')) oct += inner[++i];
          bytes.push(Number.parseInt(oct, 8));
        } else {
          bytes.push(ch.charCodeAt(0));
        }
      } else {
        bytes.push(inner.charCodeAt(0));
      }
    }
  }

  return bytes
    .map((code) => (cmap && cmap.get(code)) ?? String.fromCharCode(code))
    .join('')
    .normalize('NFKC');
}

let unpdfModulePromise = null;

async function loadUnpdf() {
  if (!unpdfModulePromise) {
    unpdfModulePromise = import('unpdf');
  }
  return unpdfModulePromise;
}

/**
 * Legacy fallback stream scanner used only if a synthetic unit-test PDF buffer
 * lacks a valid PDF cross-reference table for PDF.js (`unpdf`).
 *
 * @param {Buffer} pdfBuffer
 * @returns {Array<{ page_number: number, text: string }>}
 */
function extractPagesFromPdfLegacy(pdfBuffer) {
  if (!Buffer.isBuffer(pdfBuffer) || pdfBuffer.length === 0) {
    return [];
  }

  const raw = pdfBuffer.toString('latin1');
  const objects = new Map();

  for (const m of raw.matchAll(/(\d+)\s+0\s+obj([\s\S]*?)endobj/g)) {
    const id = Number(m[1]);
    const body = m[2];
    let streamData = null;

    if (body.includes('stream')) {
      let start = pdfBuffer.indexOf('stream', m.index) + 6;
      if (pdfBuffer[start] === 13 && pdfBuffer[start + 1] === 10) start += 2;
      else if (pdfBuffer[start] === 10 || pdfBuffer[start] === 13) start += 1;

      let end = pdfBuffer.indexOf('endstream', start);
      if (end !== -1) {
        if (pdfBuffer[end - 2] === 13 && pdfBuffer[end - 1] === 10) end -= 2;
        else if (pdfBuffer[end - 1] === 10 || pdfBuffer[end - 1] === 13) end -= 1;
        const slice = pdfBuffer.slice(start, end);
        try {
          streamData = zlib.inflateSync(slice).toString('latin1');
        } catch {
          try {
            streamData = zlib.inflateRawSync(slice).toString('latin1');
          } catch {
            streamData = slice.toString('latin1');
          }
        }
      }
    }

    objects.set(id, { body, streamData });
  }

  const allCMaps = new Map();
  for (const [id, obj] of objects.entries()) {
    if (
      obj.streamData &&
      (obj.streamData.includes('beginbfchar') ||
        obj.streamData.includes('beginbfrange'))
    ) {
      allCMaps.set(id, parsePdfCMap(obj.streamData));
    }
  }

  const pages = [];
  let pageNumber = 1;

  for (const [, obj] of objects.entries()) {
    if (/\/Type\s*\/Page\b/.test(obj.body)) {
      const fontMap = new Map();
      let resourcesText = obj.body;
      const resRef = obj.body.match(/\/Resources\s+(\d+)\s+0\s+R/);
      if (resRef && objects.has(Number(resRef[1]))) {
        resourcesText += `\n${objects.get(Number(resRef[1])).body}`;
      }

      for (const [, fName, fObjId] of resourcesText.matchAll(
        /\/(F\d+)\s+(\d+)\s+0\s+R/g
      )) {
        const fObj = objects.get(Number(fObjId));
        if (fObj) {
          const toUni = fObj.body.match(/\/ToUnicode\s+(\d+)\s+0\s+R/);
          if (toUni) {
            const cmapId = Number(toUni[1]);
            if (allCMaps.has(cmapId)) {
              fontMap.set(fName, allCMaps.get(cmapId));
            }
          }
        }
      }

      const contentIds = [];
      const singleContent = obj.body.match(/\/Contents\s+(\d+)\s+0\s+R/);
      const arrayContent = obj.body.match(/\/Contents\s*\[([\s\S]*?)\]/);
      if (singleContent) {
        contentIds.push(Number(singleContent[1]));
      } else if (arrayContent) {
        for (const ref of arrayContent[1].matchAll(/(\d+)\s+0\s+R/g)) {
          contentIds.push(Number(ref[1]));
        }
      }

      const combinedStream = contentIds
        .map((cid) => objects.get(cid)?.streamData || '')
        .filter(Boolean)
        .join('\n');

      if (combinedStream) {
        let currentFont = null;
        const lines = [];
        let line = '';

        for (const bt of combinedStream.matchAll(/BT([\s\S]*?)ET/g)) {
          const tokenRe =
            /\/(F\d+)\s+[\d.]+\s+Tf|(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+Td|(\[(?:[^\[\]]|\((?:\\.|[^\\)])*\)|<[0-9A-Fa-f\s]*>)*\])\s*TJ|(\((?:\\.|[^\\)])*\)|<[0-9A-Fa-f\s]*>)\s*Tj|T\*/g;
          for (const t of bt[1].matchAll(tokenRe)) {
            if (t[1]) {
              currentFont = fontMap.get(t[1]) || null;
            } else if (t[2] !== undefined && t[3] !== undefined) {
              const dy = Number.parseFloat(t[3]);
              if (Math.abs(dy) > 1) {
                if (line.trim()) {
                  lines.push(line.trim());
                  line = '';
                }
              }
            } else if (t[4]) {
              for (const st of t[4].matchAll(
                /(\((?:\\.|[^\\)])*\)|<[0-9A-Fa-f\s]*>)|(-?\d+(?:\.\d+)?)/g
              )) {
                if (st[1]) {
                  line += decodePdfStringToken(st[1], currentFont);
                }
              }
            } else if (t[5]) {
              line += decodePdfStringToken(t[5], currentFont);
            } else if (line.trim()) {
              lines.push(line.trim());
              line = '';
            }
          }
          if (line.trim()) {
            lines.push(line.trim());
            line = '';
          }
        }

        const cleanedPageText = lines
          .join('\n')
          .replace(/([a-z])-\n([a-z])/g, '$1$2')
          .replace(/-\n/g, '-')
          .trim();

        if (cleanedPageText) {
          pages.push({
            page_number: pageNumber,
            text: cleanedPageText,
          });
          pageNumber += 1;
        }
      }
    }
  }

  if (pages.length === 0) {
    const fallbackLines = [];
    for (const m of raw.matchAll(/\(([^()]{3,})\)\s*Tj/g)) {
      fallbackLines.push(decodePdfStringToken(`(${m[1]})`, null));
    }
    const fallbackText = fallbackLines.join('\n').trim();
    if (fallbackText) {
      pages.push({ page_number: 1, text: fallbackText });
    }
  }

  return pages;
}

/**
 * Extracts per-page UTF-8 text from a PDF buffer using spec-compliant PDF.js (`unpdf`),
 * accurately decoding 2-byte Identity-H CID fonts, subsetted ToUnicode CMaps, indirect
 * resource dictionaries, and kerning arrays (`TJ`).
 *
 * @param {Buffer} pdfBuffer
 * @returns {Promise<Array<{ page_number: number, text: string }>>}
 */
async function extractPagesFromPdf(pdfBuffer) {
  if (!Buffer.isBuffer(pdfBuffer) || pdfBuffer.length === 0) {
    return [];
  }

  try {
    const { extractText, getDocumentProxy } = await loadUnpdf();
    const uint8 = new Uint8Array(
      pdfBuffer.buffer,
      pdfBuffer.byteOffset,
      pdfBuffer.byteLength
    );
    const pdf = await getDocumentProxy(uint8);
    const { text } = await extractText(pdf, { mergePages: false });
    const rawPages = Array.isArray(text) ? text : [String(text || '')];
    const pages = [];

    rawPages.forEach((rawPage, idx) => {
      const cleaned = String(rawPage || '')
        .replace(/\u0000+/g, '')
        .replace(/\r\n/g, '\n')
        .split('\n')
        .map((line) => line.replace(/[ \t]+/g, ' ').trim())
        .join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .normalize('NFKC')
        .trim();

      if (cleaned) {
        pages.push({
          page_number: idx + 1,
          text: cleaned,
        });
      }
    });

    if (pages.length > 0) {
      return pages;
    }
  } catch {
    // Fall back to legacy parser only for synthetic unit-test PDF buffers without valid xref tables
  }

  return extractPagesFromPdfLegacy(pdfBuffer);
}

/**
 * Derives a readable document title without rewriting source text.
 *
 * @param {string} filename
 * @param {Array<{ text: string }>} pages
 * @returns {string}
 */
function deriveDocumentTitle(filename, pages) {
  const firstLines = pages
    .flatMap((page) => String(page.text || '').split(/\r?\n/))
    .map((line) => line.trim().replace(/^#{1,6}\s*/, ''))
    .filter(Boolean)
    .slice(0, 20);
  const title = firstLines.find(
    (line) =>
      line.length >= 5 &&
      line.length <= 160 &&
      (/\b(?:policy|brief|notice|manifest|memo|procedure|agreement|SOP)\b/i.test(line) ||
        /^[A-Z0-9][A-Z0-9\s&/:-]{7,}$/.test(line))
  );
  return String(title || path.basename(filename, path.extname(filename)))
    .replace(/\s+/g, ' ')
    .trim();
}

function isDocumentHeading(line) {
  const value = String(line || '').trim();
  const markdown = value.match(/^(#{1,6})\s+(.+)$/);
  if (markdown) return { depth: markdown[1].length, title: markdown[2].trim() };

  const numbered = value.match(/^(\d+(?:\.\d+)*)(?:[.)])\s+(.+)$/);
  if (numbered) {
    const words = numbered[2].trim();
    const uppercaseLetters = (words.match(/[A-Z]/g) || []).length;
    const letters = (words.match(/[A-Za-z]/g) || []).length;
    const wordLen = words.split(/\s+/).filter(Boolean).length;
    if (
      letters > 0 &&
      !/[.!?]$/.test(words) &&
      (uppercaseLetters / letters >= 0.65 || (wordLen <= 10 && words.length <= 80))
    ) {
      return {
        depth: numbered[1].split('.').length,
        title: value,
      };
    }
  }

  if (
    value.length <= 140 &&
    /[A-Za-z]/.test(value) &&
    !/[.!?]$/.test(value) &&
    (value === value.toUpperCase() || /^appendix\b/i.test(value))
  ) {
    return { depth: 1, title: value };
  }
  return null;
}

function extractChunkEntities(text) {
  const source = String(text || '');
  const entities = new Set();
  const addMatches = (pattern) => {
    for (const match of source.matchAll(pattern)) {
      if (match[0]) entities.add(match[0].trim());
    }
  };
  addMatches(/\b[A-Z][A-Z0-9]*(?:[-_][A-Z0-9]+)+\b/g);
  addMatches(/\b\d+(?:\.\d+)?\s*%/g);
  addMatches(/(?:>=|<=|>|<|at least|more than|less than|over|under)\s*\$?\s*\d[\d,]*(?:\.\d+)?(?:\s*(?:BDT|USD|hours?|hrs?|days?|weeks?|months?|units?|beds?))?/gi);
  addMatches(/\b\d+(?:\.\d+)?\s*(?:hours?|hrs?|days?|weeks?|months?|units?|beds?)\b/gi);
  addMatches(/\b(?:policy|document|order|account|batch|SKU|product|unit|dataset|table)\s*(?:ID|code|number)?\s*[:=]\s*[^,.;\n]{1,100}/gi);
  return Array.from(entities).slice(0, 80);
}

function extractApplicableScope(text, entities) {
  const scopes = [];
  for (const match of String(text || '').matchAll(
    /\b(?:applies to|applicable to|scope|target(?:s| dataset)?|eligible for|affected(?: rows?| orders?| accounts?| units?)?)\s*[:=]?\s*([^.;\n]{1,120})/gi
  )) {
    const scope = match[1].trim().replace(/\s+/g, ' ');
    if (scope) scopes.push(scope);
  }
  const values = [...new Set([...scopes, ...entities])].slice(0, 8);
  return values.length ? values.join(', ').slice(0, 180) : 'not specified in this section';
}

function estimateWordCount(text) {
  return String(text || '').trim().split(/\s+/).filter(Boolean).length;
}

function splitOversizedUnit(text, maxWords = TARGET_CHUNK_MAX_WORDS) {
  if (estimateWordCount(text) <= maxWords) return [text];
  const sentences = String(text).match(/[^.!?]+(?:[.!?]+(?:["')\]]*)|$)/g) || [text];
  const pieces = [];
  let current = '';
  for (const sentence of sentences) {
    if (current && estimateWordCount(`${current} ${sentence}`) > maxWords) {
      pieces.push(current);
      current = sentence;
    } else {
      current += sentence;
    }
  }
  if (current) pieces.push(current);
  return pieces;
}

function buildLogicalUnits(sectionText) {
  const lines = String(sectionText || '').split(/\r?\n/);
  const units = [];
  let current = [];
  const flush = () => {
    if (current.some((line) => line.trim())) units.push(current.join('\n'));
    current = [];
  };
  for (const line of lines) {
    const trimmed = line.trim();
    const startsListItem = /^(?:[-*•]\s+|\d+(?:\.\d+)*[.)]\s+)/.test(trimmed);
    if (!trimmed) {
      flush();
      continue;
    }
    if (startsListItem && estimateWordCount(current.join('\n')) >= 90) flush();
    current.push(line);
    if (estimateWordCount(current.join('\n')) >= 230) flush();
  }
  flush();
  return units.flatMap((unit) => splitOversizedUnit(unit, TARGET_CHUNK_MAX_WORDS));
}

/**
 * Splits extracted pages into coherent chunks (targeting 250-400 tokens) with
 * 10-15% (~40-60 tokens) intra-section overlap, zero cross-section overlap,
 * and dynamic retrieval breadcrumbs.
 *
 * @param {Array<{ page_number: number, text: string }>} pages
 * @param {{ docId: string, businessId: string, filename: string, docType?: string, isActive?: boolean }} meta
 * @returns {Array<object>}
 */
function chunkDocumentPages(pages, { docId, businessId, filename, docType = null, isActive = true }) {
  const chunks = [];
  let globalChunkIndex = 0;
  const documentTitle = deriveDocumentTitle(filename, pages);
  const resolvedDocType =
    docType && VALID_DOC_TYPES.has(docType)
      ? docType
      : inferDocType(filename, documentTitle, pages.map((p) => p.text).join('\n'));
  const headingStack = [];

  // Flatten all sections across pages preserving starting page_number per section
  // and merging continuation text that shares the exact same section heading across a page break.
  const allSections = [];
  for (const page of pages) {
    const pageSections = [];
    let currentPath = headingStack.map((heading) => heading.title);
    let currentLines = [];
    const rawLines = String(page.text || '').split(/\r?\n/);
    for (const line of rawLines) {
      const heading = isDocumentHeading(line);
      if (heading) {
        let titlePrefaceLines = [];
        if (currentLines.some((item) => item.trim())) {
          const intro = currentLines.filter((item) => item.trim());
          const isDocumentTitlePreface =
            pageSections.length === 0 &&
            allSections.length === 0 &&
            intro.length === 1 &&
            intro[0].trim().replace(/^#{1,6}\s*/, '').toLowerCase() === documentTitle.toLowerCase();
          if (!isDocumentTitlePreface) {
            pageSections.push({
              title: currentPath.join(' > ') || 'Document body',
              text: currentLines.join('\n'),
              page_number: page.page_number,
            });
          } else {
            titlePrefaceLines = intro;
          }
        }
        headingStack.splice(Math.max(0, heading.depth - 1));
        headingStack[heading.depth - 1] = heading;
        currentPath = headingStack.map((item) => item.title);
        currentLines = [...titlePrefaceLines, line];
      } else {
        currentLines.push(line);
      }
    }
    if (currentLines.some((item) => item.trim())) {
      pageSections.push({
        title: currentPath.join(' > ') || 'Document body',
        text: currentLines.join('\n'),
        page_number: page.page_number,
      });
    }

    for (const sec of pageSections) {
      const last = allSections[allSections.length - 1];
      if (last && last.title === sec.title) {
        last.text = `${last.text}\n${sec.text}`;
      } else {
        allSections.push(sec);
      }
    }
  }

  for (const section of allSections) {
    const units = buildLogicalUnits(section.text);
    let buffer = [];
    let wordCount = 0;
    let prevCleanBody = '';
    const emit = () => {
      const cleanBody = buffer.join('\n').trim();
      if (!cleanBody) return;
      // Intra-section overlap ONLY inside the same section; NEVER across heading boundaries
      const overlapPrefix = prevCleanBody ? extractTrailingOverlap(prevCleanBody) : '';
      const overlapChars = overlapPrefix ? overlapPrefix.length : 0;
      const rawText = overlapPrefix ? `${overlapPrefix}\n${cleanBody}` : cleanBody;
      prevCleanBody = cleanBody;

      const entities = extractChunkEntities(rawText);
      const appliesTo = extractApplicableScope(rawText, entities);
      const breadcrumbHeader = `[Document: ${documentTitle} | Section: ${section.title} | Applies to: ${appliesTo}]`;
      const enrichedText = `${breadcrumbHeader}\n${rawText}`;
      const chunkIndex = globalChunkIndex++;
      const locator = `${section.title}${section.title ? ' / ' : ''}Page ${section.page_number} / Chunk ${chunkIndex + 1}`;
      chunks.push({
        chunk_id: crypto.randomUUID(),
        doc_id: docId,
        workspace_document_id: docId,
        workspace_id: businessId,
        business_id: businessId,
        filename,
        page_number: section.page_number,
        chunk_index: chunkIndex,
        section_title: section.title,
        doc_type: resolvedDocType,
        is_active: Boolean(isActive),
        token_count: estimateTokenCount(enrichedText),
        overlap_chars: overlapChars,
        locator,
        breadcrumb_header: breadcrumbHeader,
        raw_text: rawText,
        enriched_text: enrichedText,
        extracted_entities: entities,
        tokens: tokenizeDocumentText(enrichedText),
        tf_vector: buildTextVector(enrichedText),
      });
      buffer = [];
      wordCount = 0;
    };

    for (const unit of units) {
      const count = estimateWordCount(unit);
      if (buffer.length > 0 && wordCount + count > TARGET_CHUNK_MAX_WORDS) emit();
      buffer.push(unit);
      wordCount += count;
    }
    emit();
  }

  return chunks;
}

/**
 * Ensures PostgreSQL tables for unstructured documents and semantic chunks exist when using a live DB.
 */
async function ensureDocumentTablesExist() {
  try {
    await query(`
      CREATE TABLE IF NOT EXISTS workspace_documents (
        doc_id UUID PRIMARY KEY,
        workspace_id UUID NOT NULL,
        user_id UUID,
        filename VARCHAR(255) NOT NULL,
        mime_type VARCHAR(100),
        page_count INTEGER NOT NULL DEFAULT 1,
        chunk_count INTEGER NOT NULL DEFAULT 0,
        full_text TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await query(`
      CREATE TABLE IF NOT EXISTS workspace_document_chunks (
        chunk_id UUID PRIMARY KEY,
        doc_id UUID NOT NULL REFERENCES workspace_documents(doc_id) ON DELETE CASCADE,
        workspace_document_id UUID,
        workspace_id UUID NOT NULL,
        user_id UUID,
        filename VARCHAR(255) NOT NULL,
        page_number INTEGER NOT NULL DEFAULT 1,
        chunk_index INTEGER NOT NULL DEFAULT 0,
        section_title VARCHAR(255),
        raw_text TEXT NOT NULL,
        locator TEXT,
        breadcrumb_header TEXT,
        enriched_text TEXT,
        extracted_entities JSONB NOT NULL DEFAULT '[]'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await query(`
      ALTER TABLE workspace_document_chunks
        ADD COLUMN IF NOT EXISTS locator TEXT,
        ADD COLUMN IF NOT EXISTS breadcrumb_header TEXT,
        ADD COLUMN IF NOT EXISTS enriched_text TEXT,
        ADD COLUMN IF NOT EXISTS extracted_entities JSONB NOT NULL DEFAULT '[]'::jsonb;
    `);
  } catch {
    // Graceful fallback when running against an in-memory/mock test pool
  }
}

/**
 * Ingests an unstructured document (PDF, Markdown, TXT) into semantic chunks with metadata.
 *
 * @param {object} params
 * @param {string} params.businessId
 * @param {string} params.filename
 * @param {Buffer | string} [params.buffer]
 * @param {string} [params.filePath]
 * @param {string} [params.docId]
 * @returns {Promise<{ doc_id: string, business_id: string, filename: string, page_count: number, chunk_count: number, chunks: Array<object> }>}
 */
async function ingestDocument({
  businessId,
  userId = null,
  filename,
  buffer,
  filePath,
  docId,
  replaceAll = false,
  customPages = null,
  mime_type = null,
  mimeType = null,
}) {
  if (!businessId) {
    throw new AppError('businessId is required to ingest a document.', 400);
  }

  if (replaceAll) {
    await clearDocumentsForBusiness(businessId);
  }

  let rawBuffer = null;
  if (Array.isArray(customPages) && customPages.length > 0) {
    rawBuffer = Buffer.from(customPages.map((p) => p.text).join('\n\n'), 'utf8');
  } else {
    rawBuffer = buffer
      ? Buffer.isBuffer(buffer)
        ? buffer
        : Buffer.from(String(buffer), 'utf8')
      : filePath
        ? fs.readFileSync(filePath)
        : null;
  }

  if (!rawBuffer || rawBuffer.length === 0) {
    throw new AppError(`Document "${filename || filePath}" is empty.`, 400);
  }

  const resolvedFilename =
    filename || (filePath ? path.basename(filePath) : 'document.txt');
  const ext = path.extname(resolvedFilename).toLowerCase();
  const isPdf =
    ext === '.pdf' ||
    (rawBuffer.length >= 5 && rawBuffer.slice(0, 5).toString('ascii') === '%PDF-');

  let pages = [];
  if (Array.isArray(customPages) && customPages.length > 0) {
    pages = customPages;
  } else if (isPdf) {
    pages = await extractPagesFromPdf(rawBuffer);
  } else {
    const text = rawBuffer.toString('utf8').trim();
    if (text) {
      pages = [{ page_number: 1, text }];
    }
  }

  if (pages.length === 0) {
    throw new AppError(
      `Could not extract readable text from document "${resolvedFilename}".`,
      400
    );
  }

  const resolvedDocId = docId || crypto.randomUUID();
  const resolvedDocType = inferDocType(
    resolvedFilename,
    deriveDocumentTitle(resolvedFilename, pages),
    pages.map((p) => p.text).join('\n')
  );
  const chunks = chunkDocumentPages(pages, {
    docId: resolvedDocId,
    businessId,
    filename: resolvedFilename,
    docType: resolvedDocType,
    isActive: true,
  });

  if (isLivePostgresPool() || hasCustomEmbeddingGenerator()) {
    const embRes = await embedDocuments(
      chunks.map((c) => c.enriched_text),
      { taskType: 'RETRIEVAL_DOCUMENT' }
    );
    chunks.forEach((chunk, idx) => {
      chunk.embedding_vector = embRes.vectors?.[idx] || null;
      chunk.embedding_literal = embRes.literals?.[idx] || null;
    });
  }

  const fullText = pages.map((p) => p.text).join('\n\n');
  const docRecord = {
    doc_id: resolvedDocId,
    workspace_document_id: resolvedDocId,
    workspace_id: businessId,
    business_id: businessId,
    filename: resolvedFilename,
    mime_type: mime_type || mimeType || (isPdf ? 'application/pdf' : 'text/plain'),
    doc_type: resolvedDocType,
    is_active: true,
    page_count: pages.length,
    chunk_count: chunks.length,
    full_text: fullText,
    created_at: new Date().toISOString(),
  };

  // Hydrate existing docs/chunks from DB if memory cache is cold so we never shadow earlier DB uploads
  const priorDocs = await listDocumentsForBusiness(businessId, { includeInactive: true });
  const priorChunks = await getChunksForBusiness(businessId, { includeInactive: true });

  const existingDocs = priorDocs.filter(
    (d) => d.filename.toLowerCase() !== resolvedFilename.toLowerCase()
  );
  existingDocs.push(docRecord);
  DOCUMENTS_BY_BUSINESS.set(businessId, existingDocs);

  const existingChunks = priorChunks.filter(
    (c) => c.filename.toLowerCase() !== resolvedFilename.toLowerCase()
  );
  existingChunks.push(...chunks);
  CHUNKS_BY_BUSINESS.set(businessId, existingChunks);

  // Best-effort persistence to PostgreSQL
  await ensureDocumentTablesExist();
  try {
    let resolvedUserId = userId || null;
    if (!resolvedUserId) {
      const wsUserRes = await query('SELECT user_id FROM workspaces WHERE id = $1;', [businessId]);
      resolvedUserId = wsUserRes.rows?.[0]?.user_id || null;
    }

    await query(
      `DELETE FROM workspace_document_chunks WHERE workspace_id = $1 AND LOWER(filename) = LOWER($2);`,
      [businessId, resolvedFilename]
    );
    await query(
      `DELETE FROM workspace_documents WHERE workspace_id = $1 AND LOWER(filename) = LOWER($2);`,
      [businessId, resolvedFilename]
    );

    const vecType = await getChunkVectorColumnType();
    if (vecType) {
      await query(
        `INSERT INTO workspace_documents (doc_id, workspace_id, user_id, filename, mime_type, page_count, chunk_count, full_text, is_active, doc_type)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10);`,
        [
          resolvedDocId,
          businessId,
          resolvedUserId,
          resolvedFilename,
          docRecord.mime_type,
          pages.length,
          chunks.length,
          fullText,
          true,
          resolvedDocType,
        ]
      );
      await persistChunksToDb(query, chunks, {
        businessId,
        resolvedUserId,
        resolvedDocId,
        vecType,
      });
    } else {
      await query(
        `INSERT INTO workspace_documents (doc_id, workspace_id, user_id, filename, mime_type, page_count, chunk_count, full_text)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8);`,
        [
          resolvedDocId,
          businessId,
          resolvedUserId,
          resolvedFilename,
          docRecord.mime_type,
          pages.length,
          chunks.length,
          fullText,
        ]
      );
      for (const chunk of chunks) {
        await query(
          `INSERT INTO workspace_document_chunks
             (chunk_id, doc_id, workspace_document_id, workspace_id, user_id, filename,
              page_number, chunk_index, section_title, raw_text, locator, breadcrumb_header,
              enriched_text, extracted_entities)
           VALUES ($1, $2, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb);`,
          [
            chunk.chunk_id,
            chunk.doc_id,
            businessId,
            resolvedUserId,
            chunk.filename,
            chunk.page_number,
            chunk.chunk_index,
            String(chunk.section_title || '').slice(0, 250),
            chunk.raw_text,
            chunk.locator,
            chunk.breadcrumb_header,
            chunk.enriched_text,
            JSON.stringify(chunk.extracted_entities),
          ]
        );
      }
    }
  } catch (dbErr) {
    // Ignore DB errors when running against an in-memory mock test pool
    console.warn('[DocumentIngestion] Note on DB insert:', dbErr.message);
  }

  return {
    ...docRecord,
    chunks,
  };
}

async function persistChunksToDb(
  execQuery,
  chunks,
  { businessId, resolvedUserId, resolvedDocId, vecType }
) {
  const vecCast = vecType === 'halfvec' ? '::halfvec(768)' : '::vector(768)';
  for (const chunk of chunks) {
    await execQuery(
      `INSERT INTO workspace_document_chunks
         (chunk_id, doc_id, workspace_document_id, workspace_id, user_id, filename,
          page_number, chunk_index, section_title, raw_text, locator, breadcrumb_header,
          enriched_text, extracted_entities, is_active, doc_type, token_count, overlap_chars,
          search_tsv, embedding)
       VALUES (
         $1, $2, $2, $3, $4, $5,
         $6, $7, $8, $9, $10, $11,
         $12, $13::jsonb, $14, $15, $16, $17,
         to_tsvector('english', $12),
         ${chunk.embedding_literal ? `$18${vecCast}` : 'NULL'}
       );`,
      chunk.embedding_literal
        ? [
            chunk.chunk_id,
            resolvedDocId || chunk.doc_id,
            businessId,
            resolvedUserId,
            chunk.filename,
            chunk.page_number,
            chunk.chunk_index,
            String(chunk.section_title || '').slice(0, 250),
            chunk.raw_text,
            chunk.locator,
            chunk.breadcrumb_header,
            chunk.enriched_text,
            JSON.stringify(chunk.extracted_entities),
            chunk.is_active !== false,
            chunk.doc_type || 'general',
            chunk.token_count || 0,
            chunk.overlap_chars || 0,
            chunk.embedding_literal,
          ]
        : [
            chunk.chunk_id,
            resolvedDocId || chunk.doc_id,
            businessId,
            resolvedUserId,
            chunk.filename,
            chunk.page_number,
            chunk.chunk_index,
            String(chunk.section_title || '').slice(0, 250),
            chunk.raw_text,
            chunk.locator,
            chunk.breadcrumb_header,
            chunk.enriched_text,
            JSON.stringify(chunk.extracted_entities),
            chunk.is_active !== false,
            chunk.doc_type || 'general',
            chunk.token_count || 0,
            chunk.overlap_chars || 0,
          ]
    );
  }
}

/**
 * Convenience helper to ingest a document directly from a local filesystem path.
 *
 * @param {string} businessId
 * @param {string} filePath
 * @returns {Promise<object>}
 */
async function ingestDocumentFromPath(businessId, filePath) {
  const absPath = path.resolve(filePath);
  const buffer = fs.readFileSync(absPath);
  const filename = path.basename(absPath);
  return ingestDocument({ businessId, filename, buffer, filePath: absPath });
}

const STRUCTURED_SHEET_MIME_TYPES = new Set([
  'application/vnd.google-apps.spreadsheet',
  'text/csv',
  'application/csv',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
]);

function isStructuredSheetDocument(doc) {
  if (!doc) return false;
  const mime = String(doc.mime_type || '').trim().toLowerCase();
  if (STRUCTURED_SHEET_MIME_TYPES.has(mime)) return true;
  const fullText = String(doc.full_text || '').trim();
  if (/^(Google Sheet|CSV sheet) for table /i.test(fullText)) return true;
  const fname = String(doc.filename || '').trim().toLowerCase();
  return fname.endsWith('.csv');
}

/**
 * Lists all ingested unstructured policy/notice documents for a business
 * (excluding structured spreadsheets and CSV table metadata rows).
 *
 * @param {string} businessId
 * @returns {Promise<Array<object>>}
 */
async function listDocumentsForBusiness(businessId, options = {}) {
  const includeInactive = Boolean(options.includeInactive);
  const filterVisible = (docs) =>
    docs.filter(
      (doc) => !isStructuredSheetDocument(doc) && (includeInactive || doc.is_active !== false)
    );

  const memDocs = DOCUMENTS_BY_BUSINESS.get(businessId) || [];
  if (memDocs.length > 0) {
    const cleanAll = memDocs.filter((doc) => !isStructuredSheetDocument(doc));
    if (cleanAll.length !== memDocs.length) {
      DOCUMENTS_BY_BUSINESS.set(businessId, cleanAll);
    }
    if (cleanAll.length > 0) {
      return filterVisible(cleanAll);
    }
  }

  try {
    // Run legacy sheet-row cleanup concurrently with document fetch to save a remote DB round-trip
    const cleanupPromise = query(
      `DELETE FROM workspace_documents
       WHERE workspace_id = $1
         AND (
           LOWER(COALESCE(mime_type, '')) IN (
             'application/vnd.google-apps.spreadsheet',
             'text/csv',
             'application/csv',
             'application/vnd.ms-excel',
             'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
           )
           OR COALESCE(full_text, '') ILIKE 'Google Sheet for table %'
           OR COALESCE(full_text, '') ILIKE 'CSV sheet for table %'
           OR LOWER(COALESCE(filename, '')) LIKE '%.csv'
         );`,
      [businessId]
    ).catch(() => {});

    const vecType = await getChunkVectorColumnType();
    const extraCols = vecType ? ', is_active, doc_type' : '';
    const selectPromise = query(
      `SELECT doc_id, doc_id AS id, workspace_id, workspace_id AS business_id, user_id, filename, mime_type, page_count, chunk_count, full_text${extraCols}, created_at
       FROM workspace_documents
       WHERE workspace_id = $1
         AND LOWER(COALESCE(mime_type, '')) NOT IN (
           'application/vnd.google-apps.spreadsheet',
           'text/csv',
           'application/csv',
           'application/vnd.ms-excel',
           'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
         )
         AND COALESCE(full_text, '') NOT ILIKE 'Google Sheet for table %'
         AND COALESCE(full_text, '') NOT ILIKE 'CSV sheet for table %'
         AND LOWER(COALESCE(filename, '')) NOT LIKE '%.csv'
       ORDER BY created_at ASC;`,
      [businessId]
    );

    const [, res] = await Promise.all([cleanupPromise, selectPromise]);
    if (res && Array.isArray(res.rows) && res.rows.length > 0) {
      const filteredRows = res.rows.filter((doc) => !isStructuredSheetDocument(doc));
      DOCUMENTS_BY_BUSINESS.set(businessId, filteredRows);
      return filterVisible(filteredRows);
    }
  } catch {
    // Fallback to empty
  }
  return [];
}

/**
 * Retrieves semantic chunks for a business (excluding inactive chunks unless includeInactive=true).
 *
 * @param {string} businessId
 * @param {{ includeInactive?: boolean }} [options]
 * @returns {Promise<Array<object>>}
 */
async function getChunksForBusiness(businessId, options = {}) {
  const includeInactive = Boolean(options.includeInactive);
  const memChunks = CHUNKS_BY_BUSINESS.get(businessId) || [];
  if (memChunks.length > 0) {
    return includeInactive
      ? memChunks
      : memChunks.filter((chunk) => chunk.is_active !== false);
  }

  try {
    const vecType = await getChunkVectorColumnType();
    const extraCols = vecType
      ? ', is_active, doc_type, token_count, overlap_chars'
      : '';
    const res = await query(
      `SELECT chunk_id, doc_id, COALESCE(workspace_document_id, doc_id) AS workspace_document_id, workspace_id, workspace_id AS business_id, user_id, filename, page_number, chunk_index, section_title, raw_text, locator, breadcrumb_header, enriched_text, extracted_entities${extraCols}
       FROM workspace_document_chunks
       WHERE workspace_id = $1
       ORDER BY filename ASC, page_number ASC, chunk_index ASC;`,
      [businessId]
    );
    if (res && Array.isArray(res.rows) && res.rows.length > 0) {
      const hydrated = res.rows.map((r) => ({
        ...r,
        is_active: r.is_active !== false,
        doc_type: r.doc_type || 'general',
        enriched_text: r.enriched_text || `${r.breadcrumb_header || ''}\n${r.raw_text}`,
        extracted_entities: Array.isArray(r.extracted_entities) ? r.extracted_entities : [],
        tokens: tokenizeDocumentText(r.enriched_text || r.raw_text),
        tf_vector: buildTextVector(r.enriched_text || r.raw_text),
      }));
      CHUNKS_BY_BUSINESS.set(businessId, hydrated);
      return includeInactive
        ? hydrated
        : hydrated.filter((chunk) => chunk.is_active !== false);
    }
  } catch {
    // Fallback to empty
  }
  return [];
}

/**
 * Toggles `is_active` for a document across `workspace_documents`, `workspace_document_chunks`,
 * and in-memory caches without deleting any rows.
 *
 * @param {string} workspaceId
 * @param {string} docId
 * @param {boolean} isActive
 */
async function setDocumentActiveState(workspaceId, docId, isActive) {
  const cleanWsId = String(workspaceId || '').trim();
  const cleanDocId = String(docId || '').trim();
  const nextActive = Boolean(isActive);
  if (!cleanWsId || !cleanDocId) {
    throw new AppError('workspaceId and docId are required to update document active state.', 400);
  }

  let updatedDocsCount = 0;
  let updatedChunksCount = 0;
  try {
    const docRes = await query(
      `UPDATE workspace_documents
       SET is_active = $3, updated_at = NOW()
       WHERE workspace_id = $1 AND doc_id = $2;`,
      [cleanWsId, cleanDocId, nextActive]
    );
    updatedDocsCount = Number(docRes?.rowCount || 0);
    const chunkRes = await query(
      `UPDATE workspace_document_chunks
       SET is_active = $3
       WHERE workspace_id = $1 AND (doc_id = $2 OR workspace_document_id = $2);`,
      [cleanWsId, cleanDocId, nextActive]
    );
    updatedChunksCount = Number(chunkRes?.rowCount || 0);
  } catch (err) {
    console.warn('[setDocumentActiveState] Note on DB update:', err.message);
  }

  const memDocs = DOCUMENTS_BY_BUSINESS.get(cleanWsId);
  if (Array.isArray(memDocs)) {
    for (const d of memDocs) {
      if (String(d.doc_id || d.id || '') === cleanDocId) {
        d.is_active = nextActive;
      }
    }
  }
  const memChunks = CHUNKS_BY_BUSINESS.get(cleanWsId);
  if (Array.isArray(memChunks)) {
    for (const c of memChunks) {
      if (
        String(c.doc_id || '') === cleanDocId ||
        String(c.workspace_document_id || '') === cleanDocId
      ) {
        c.is_active = nextActive;
      }
    }
  }

  return {
    workspace_id: cleanWsId,
    doc_id: cleanDocId,
    is_active: nextActive,
    updated_documents: updatedDocsCount,
    updated_chunks: updatedChunksCount,
  };
}

/**
 * Updates the full text of an existing workspace document and re-indexes its semantic chunks
 * in both PostgreSQL and in-memory caches without touching conversation state.
 *
 * @param {{ businessId: string, docId: string, content: string }} params
 * @returns {Promise<object>}
 */
async function updateDocumentContentById({ businessId, docId, content }) {
  const cleanBizId = String(businessId || '').trim();
  const cleanDocIdentifier = String(docId || '').trim();
  const nextText = typeof content === 'string' ? content.replace(/\r\n/g, '\n').trim() : '';

  if (!cleanBizId || !cleanDocIdentifier) {
    throw new AppError('Both workspace_id and docIdentifier are required to update a document.', 400);
  }
  if (!nextText) {
    throw new AppError('Document content cannot be empty.', 400);
  }

  let docRow = null;
  const isUuid = DOC_UUID_RE.test(cleanDocIdentifier);

  try {
    const docQuery = isUuid
      ? `SELECT doc_id, workspace_id, user_id, filename, mime_type, page_count, chunk_count, full_text, created_at
         FROM workspace_documents
         WHERE workspace_id = $1 AND (doc_id = $2 OR LOWER(filename) = LOWER($3))
         LIMIT 1;`
      : `SELECT doc_id, workspace_id, user_id, filename, mime_type, page_count, chunk_count, full_text, created_at
         FROM workspace_documents
         WHERE workspace_id = $1 AND (LOWER(filename) = LOWER($2) OR LOWER(filename) = LOWER($3))
         LIMIT 1;`;
    const docParams = isUuid
      ? [cleanBizId, cleanDocIdentifier, cleanDocIdentifier]
      : [cleanBizId, cleanDocIdentifier, path.basename(cleanDocIdentifier)];
    const docRes = await query(docQuery, docParams);
    if (docRes?.rows?.length > 0) {
      docRow = docRes.rows[0];
    }
  } catch (dbErr) {
    console.warn('[updateDocumentContentById] DB lookup warning:', dbErr.message);
  }

  if (!docRow) {
    const memDocs = await listDocumentsForBusiness(cleanBizId);
    const matchedMem = memDocs.find(
      (d) =>
        String(d.doc_id || d.id || '') === cleanDocIdentifier ||
        String(d.filename || '').toLowerCase() === cleanDocIdentifier.toLowerCase() ||
        path.basename(String(d.filename || '')).toLowerCase() === path.basename(cleanDocIdentifier).toLowerCase()
    );
    if (matchedMem) {
      docRow = {
        doc_id: matchedMem.doc_id || matchedMem.id,
        workspace_id: cleanBizId,
        user_id: matchedMem.user_id || null,
        filename: matchedMem.filename,
        mime_type: matchedMem.mime_type || 'text/plain',
        page_count: matchedMem.page_count || 1,
        created_at: matchedMem.created_at,
      };
    }
  }

  if (!docRow) {
    throw new AppError(`Document "${cleanDocIdentifier}" was not found in this workspace.`, 404);
  }

  const resolvedDocId = docRow.doc_id;
  const resolvedFilename = docRow.filename;
  const resolvedPageCount = Number(docRow.page_count || 1) || 1;
  const pages = [{ page_number: 1, text: nextText }];
  const resolvedDocType = inferDocType(
    resolvedFilename,
    deriveDocumentTitle(resolvedFilename, pages),
    nextText
  );
  const nextChunks = chunkDocumentPages(pages, {
    docId: resolvedDocId,
    businessId: cleanBizId,
    filename: resolvedFilename,
    docType: resolvedDocType,
    isActive: docRow.is_active !== false,
  });

  if (isLivePostgresPool() || hasCustomEmbeddingGenerator()) {
    const embRes = await embedDocuments(
      nextChunks.map((c) => c.enriched_text),
      { taskType: 'RETRIEVAL_DOCUMENT' }
    );
    nextChunks.forEach((chunk, idx) => {
      chunk.embedding_vector = embRes.vectors?.[idx] || null;
      chunk.embedding_literal = embRes.literals?.[idx] || null;
    });
  }

  await ensureDocumentTablesExist();
  const vecType = await getChunkVectorColumnType();

  const persistUpdate = async (execQuery) => {
    let resolvedUserId = docRow.user_id || null;
    if (!resolvedUserId) {
      const wsUserRes = await execQuery('SELECT user_id FROM workspaces WHERE id = $1;', [cleanBizId]);
      resolvedUserId = wsUserRes?.rows?.[0]?.user_id || null;
    }

    await execQuery(
      vecType
        ? `UPDATE workspace_documents
           SET full_text = $1, chunk_count = $2, doc_type = $3, updated_at = NOW()
           WHERE workspace_id = $4 AND doc_id = $5;`
        : `UPDATE workspace_documents
           SET full_text = $1, chunk_count = $2, updated_at = NOW()
           WHERE workspace_id = $3 AND doc_id = $4;`,
      vecType
        ? [nextText, nextChunks.length, resolvedDocType, cleanBizId, resolvedDocId]
        : [nextText, nextChunks.length, cleanBizId, resolvedDocId]
    );

    await execQuery(
      `DELETE FROM workspace_document_chunks
       WHERE workspace_id = $1 AND (doc_id = $2 OR workspace_document_id = $2);`,
      [cleanBizId, resolvedDocId]
    );

    if (vecType) {
      await persistChunksToDb(execQuery, nextChunks, {
        businessId: cleanBizId,
        resolvedUserId,
        resolvedDocId,
        vecType,
      });
    } else {
      for (const chunk of nextChunks) {
        await execQuery(
          `INSERT INTO workspace_document_chunks
             (chunk_id, doc_id, workspace_document_id, workspace_id, user_id, filename,
              page_number, chunk_index, section_title, raw_text, locator, breadcrumb_header,
              enriched_text, extracted_entities)
           VALUES ($1, $2, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb);`,
          [
            chunk.chunk_id,
            resolvedDocId,
            cleanBizId,
            resolvedUserId,
            resolvedFilename,
            chunk.page_number,
            chunk.chunk_index,
            String(chunk.section_title || '').slice(0, 250),
            chunk.raw_text,
            chunk.locator,
            chunk.breadcrumb_header,
            chunk.enriched_text,
            JSON.stringify(chunk.extracted_entities),
          ]
        );
      }
    }
  };

  if (typeof withTransaction === 'function') {
    try {
      await withTransaction((client) =>
        persistUpdate((sql, params) => client.query(sql, params))
      );
    } catch (err) {
      if (!/DATABASE_URL is not set|connect is not a function/i.test(String(err?.message || ''))) {
        throw err;
      }
      await persistUpdate(query);
    }
  } else {
    await persistUpdate(query);
  }

  // Keep in-memory document & chunk stores synchronized
  const priorDocs = await listDocumentsForBusiness(cleanBizId);
  const updatedDocRecord = {
    doc_id: resolvedDocId,
    workspace_document_id: resolvedDocId,
    workspace_id: cleanBizId,
    business_id: cleanBizId,
    filename: resolvedFilename,
    mime_type: docRow.mime_type || 'text/plain',
    page_count: resolvedPageCount,
    chunk_count: nextChunks.length,
    full_text: nextText,
    created_at: docRow.created_at || new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  DOCUMENTS_BY_BUSINESS.set(cleanBizId, [
    ...priorDocs.filter((d) => String(d.doc_id || d.id || '') !== String(resolvedDocId)),
    updatedDocRecord,
  ]);

  const priorChunks = await getChunksForBusiness(cleanBizId);
  CHUNKS_BY_BUSINESS.set(cleanBizId, [
    ...priorChunks.filter(
      (c) =>
        String(c.doc_id || '') !== String(resolvedDocId) &&
        String(c.workspace_document_id || '') !== String(resolvedDocId) &&
        String(c.filename || '').toLowerCase() !== resolvedFilename.toLowerCase()
    ),
    ...nextChunks,
  ]);

  const entitySet = new Set();
  const formattedChunks = nextChunks.map((c, index) => {
    for (const ent of c.extracted_entities || []) {
      if (ent && typeof ent === 'string' && ent.trim()) entitySet.add(ent.trim());
    }
    return {
      id: c.chunk_id || `chunk-${index}`,
      chunk_index: Number(c.chunk_index ?? index),
      locator: c.locator || `Page ${c.page_number || 1} / Chunk ${index + 1}`,
      breadcrumb_header: c.breadcrumb_header || null,
      raw_text: c.raw_text || '',
      enriched_text: c.enriched_text || null,
      extracted_entities: c.extracted_entities || [],
    };
  });

  return {
    document: {
      id: resolvedDocId,
      workspace_id: cleanBizId,
      filename: resolvedFilename,
      mime_type: updatedDocRecord.mime_type,
      page_count: resolvedPageCount,
      total_chunks: formattedChunks.length,
      full_text: nextText,
      all_extracted_entities: Array.from(entitySet),
      created_at: updatedDocRecord.created_at,
      updated_at: updatedDocRecord.updated_at,
    },
    chunks: formattedChunks,
  };
}

/**
 * Deletes a single workspace document and all of its indexed chunks
 * from both PostgreSQL and the in-memory caches.
 *
 * @param {{ businessId: string, docId: string }} param0
 * @returns {Promise<{ doc_id: string, filename: string | null, deleted_chunks: number }>}
 */
async function deleteDocumentById({ businessId, docId }) {
  const cleanBizId = String(businessId || '').trim();
  const cleanDocId = String(docId || '').trim();
  if (!cleanBizId || !cleanDocId) {
    throw new AppError('Both workspace_id and doc_id are required to delete a document.', 400);
  }

  let memDocRemoved = false;
  let memFilename = null;
  let memChunksRemoved = 0;

  const currentDocs = DOCUMENTS_BY_BUSINESS.get(cleanBizId);
  if (Array.isArray(currentDocs)) {
    const remainingDocs = [];
    for (const d of currentDocs) {
      if (String(d.doc_id || d.id || '') === cleanDocId) {
        memDocRemoved = true;
        memFilename = d.filename || memFilename;
      } else {
        remainingDocs.push(d);
      }
    }
    if (remainingDocs.length > 0) {
      DOCUMENTS_BY_BUSINESS.set(cleanBizId, remainingDocs);
    } else {
      DOCUMENTS_BY_BUSINESS.delete(cleanBizId);
    }
  }

  const currentChunks = CHUNKS_BY_BUSINESS.get(cleanBizId);
  if (Array.isArray(currentChunks)) {
    const remainingChunks = [];
    for (const c of currentChunks) {
      if (
        String(c.doc_id || '') === cleanDocId ||
        String(c.workspace_document_id || '') === cleanDocId
      ) {
        memChunksRemoved += 1;
      } else {
        remainingChunks.push(c);
      }
    }
    if (remainingChunks.length > 0) {
      CHUNKS_BY_BUSINESS.set(cleanBizId, remainingChunks);
    } else {
      CHUNKS_BY_BUSINESS.delete(cleanBizId);
    }
  }

  if (!DOC_UUID_RE.test(cleanDocId)) {
    if (memDocRemoved) {
      return {
        doc_id: cleanDocId,
        filename: memFilename,
        deleted_chunks: memChunksRemoved,
      };
    }
    throw new AppError('Valid document ID (UUID) is required.', 400);
  }

  const runDeleteQueries = async (execQuery) => {
    const chunksDel = await execQuery(
      `DELETE FROM workspace_document_chunks
       WHERE workspace_id = $1 AND (doc_id = $2 OR workspace_document_id = $2);`,
      [cleanBizId, cleanDocId]
    );
    const docsDel = await execQuery(
      `DELETE FROM workspace_documents
       WHERE workspace_id = $1 AND doc_id = $2
       RETURNING doc_id, filename;`,
      [cleanBizId, cleanDocId]
    );
    return {
      deletedChunks: Number(chunksDel?.rowCount || 0),
      deletedDocs: Array.isArray(docsDel?.rows) ? docsDel.rows : [],
    };
  };

  let dbResult = { deletedChunks: 0, deletedDocs: [] };
  if (typeof withTransaction === 'function') {
    try {
      dbResult = await withTransaction((client) =>
        runDeleteQueries((sql, params) => client.query(sql, params))
      );
    } catch (err) {
      if (!/DATABASE_URL is not set|connect is not a function/i.test(String(err?.message || ''))) {
        throw err;
      }
      dbResult = await runDeleteQueries(query);
    }
  } else {
    dbResult = await runDeleteQueries(query);
  }

  if (dbResult.deletedDocs.length === 0 && !memDocRemoved) {
    throw new AppError(`Document "${cleanDocId}" was not found in this workspace.`, 404);
  }

  return {
    doc_id: cleanDocId,
    filename: dbResult.deletedDocs[0]?.filename || memFilename || null,
    deleted_chunks: Math.max(dbResult.deletedChunks, memChunksRemoved),
  };
}

/**
 * Clears ingested documents and chunks for a business.
 *
 * @param {string} businessId
 */
async function clearDocumentsForBusiness(businessId) {
  DOCUMENTS_BY_BUSINESS.delete(businessId);
  CHUNKS_BY_BUSINESS.delete(businessId);
  try {
    await query(`DELETE FROM workspace_document_chunks WHERE workspace_id = $1;`, [
      businessId,
    ]);
    await query(`DELETE FROM workspace_documents WHERE workspace_id = $1;`, [
      businessId,
    ]);
  } catch {
    // Ignore on mock pools
  }
}

/**
 * Clears all ingested documents and chunks globally across memory and PostgreSQL.
 */
async function clearAllDocumentsGlobal() {
  DOCUMENTS_BY_BUSINESS.clear();
  CHUNKS_BY_BUSINESS.clear();
  try {
    await query(
      `TRUNCATE TABLE workspace_document_chunks, workspace_documents RESTART IDENTITY CASCADE;`
    );
  } catch {
    try {
      await query(`DELETE FROM workspace_document_chunks;`);
      await query(`DELETE FROM workspace_documents;`);
    } catch {
      // Ignore on mock pools
    }
  }
}

function getInMemoryChunksForBusiness(businessId) {
  return CHUNKS_BY_BUSINESS.get(businessId) || [];
}

const PREWARM_IN_FLIGHT = new Set();

/**
 * Non-blocking background pre-warmer for workspace document & chunk caches.
 * Ensures first chat query after server start avoids cold DB chunk hydration without delaying UI listing requests.
 *
 * @param {string} businessId
 */
function prewarmWorkspaceDocumentCaches(businessId) {
  const cleanId = String(businessId || '').trim();
  if (!cleanId || PREWARM_IN_FLIGHT.has(cleanId)) return;
  if (DOCUMENTS_BY_BUSINESS.has(cleanId) && CHUNKS_BY_BUSINESS.has(cleanId)) return;
  PREWARM_IN_FLIGHT.add(cleanId);
  setImmediate(async () => {
    try {
      await Promise.all([
        listDocumentsForBusiness(cleanId),
        getChunksForBusiness(cleanId),
      ]);
    } catch {
      // Ignore background pre-warm errors
    } finally {
      PREWARM_IN_FLIGHT.delete(cleanId);
    }
  });
}

module.exports = {
  tokenizeDocumentText,
  buildTextVector,
  deriveDocumentTitle,
  isDocumentHeading,
  estimateTokenCount,
  inferDocType,
  extractTrailingOverlap,
  extractChunkEntities,
  extractApplicableScope,
  extractPagesFromPdf,
  chunkDocumentPages,
  getChunkVectorColumnType,
  persistChunksToDb,
  ingestDocument,
  ingestDocumentFromPath,
  isStructuredSheetDocument,
  listDocumentsForBusiness,
  getChunksForBusiness,
  getInMemoryChunksForBusiness,
  prewarmWorkspaceDocumentCaches,
  setDocumentActiveState,
  updateDocumentContentById,
  deleteDocumentById,
  clearDocumentsForBusiness,
  clearAllDocumentsGlobal,
};
