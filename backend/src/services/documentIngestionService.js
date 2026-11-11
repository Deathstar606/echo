const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { query } = require('../../db');
const AppError = require('../utils/AppError');

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
    if (letters > 0 && (uppercaseLetters / letters >= 0.65 || words.length <= 80)) {
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

function splitOversizedUnit(text, maxWords = 350) {
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
    if (startsListItem) flush();
    current.push(line);
    if (estimateWordCount(current.join('\n')) >= 300) flush();
  }
  flush();
  return units.flatMap((unit) => splitOversizedUnit(unit));
}

/**
 * Splits extracted pages into coherent chunks, retaining each body separately from
 * its dynamically generated retrieval breadcrumb.
 *
 * @param {Array<{ page_number: number, text: string }>} pages
 * @param {{ docId: string, businessId: string, filename: string }} meta
 * @returns {Array<object>}
 */
function chunkDocumentPages(pages, { docId, businessId, filename }) {
  const chunks = [];
  let globalChunkIndex = 0;
  const documentTitle = deriveDocumentTitle(filename, pages);
  const headingStack = [];

  for (const page of pages) {
    const sections = [];
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
            sections.length === 0 &&
            intro.length === 1 &&
            intro[0].trim().replace(/^#{1,6}\s*/, '').toLowerCase() === documentTitle.toLowerCase();
          if (!isDocumentTitlePreface) {
            sections.push({ title: currentPath.join(' > ') || 'Document body', text: currentLines.join('\n') });
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
      sections.push({
        title: currentPath.join(' > ') || 'Document body',
        text: currentLines.join('\n'),
      });
    }

    for (const section of sections) {
      const units = buildLogicalUnits(section.text);
      let buffer = [];
      let wordCount = 0;
      const emit = () => {
        const rawText = buffer.join('\n');
        if (!rawText.trim()) return;
        const entities = extractChunkEntities(rawText);
        const appliesTo = extractApplicableScope(rawText, entities);
        const breadcrumbHeader = `[Document: ${documentTitle} | Section: ${section.title} | Applies to: ${appliesTo}]`;
        const chunkIndex = globalChunkIndex++;
        const locator = `${section.title}${section.title ? ' / ' : ''}Page ${page.page_number} / Chunk ${chunkIndex + 1}`;
        chunks.push({
          chunk_id: crypto.randomUUID(),
          doc_id: docId,
          workspace_document_id: docId,
          workspace_id: businessId,
          business_id: businessId,
          filename,
          page_number: page.page_number,
          chunk_index: chunkIndex,
          section_title: section.title,
          locator,
          breadcrumb_header: breadcrumbHeader,
          raw_text: rawText,
          enriched_text: `${breadcrumbHeader}\n${rawText}`,
          extracted_entities: entities,
          tokens: tokenizeDocumentText(`${breadcrumbHeader}\n${rawText}`),
          tf_vector: buildTextVector(`${breadcrumbHeader}\n${rawText}`),
        });
        buffer = [];
        wordCount = 0;
      };

      for (const unit of units) {
        const count = estimateWordCount(unit);
        if (buffer.length > 0 && wordCount + count > 350) emit();
        buffer.push(unit);
        wordCount += count;
      }
      emit();
    }
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
  const chunks = chunkDocumentPages(pages, {
    docId: resolvedDocId,
    businessId,
    filename: resolvedFilename,
  });

  const fullText = pages.map((p) => p.text).join('\n\n');
  const docRecord = {
    doc_id: resolvedDocId,
    workspace_document_id: resolvedDocId,
    workspace_id: businessId,
    business_id: businessId,
    filename: resolvedFilename,
    mime_type: mime_type || mimeType || (isPdf ? 'application/pdf' : 'text/plain'),
    page_count: pages.length,
    chunk_count: chunks.length,
    full_text: fullText,
    created_at: new Date().toISOString(),
  };

  // Hydrate existing docs/chunks from DB if memory cache is cold so we never shadow earlier DB uploads
  const priorDocs = await listDocumentsForBusiness(businessId);
  const priorChunks = await getChunksForBusiness(businessId);

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
          chunk.section_title,
          chunk.raw_text,
          chunk.locator,
          chunk.breadcrumb_header,
          chunk.enriched_text,
          JSON.stringify(chunk.extracted_entities),
        ]
      );
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

/**
 * Lists all ingested documents for a business (merging in-memory and DB records if needed).
 *
 * @param {string} businessId
 * @returns {Promise<Array<object>>}
 */
async function listDocumentsForBusiness(businessId) {
  const memDocs = DOCUMENTS_BY_BUSINESS.get(businessId) || [];
  if (memDocs.length > 0) {
    return memDocs;
  }

  try {
    const res = await query(
      `SELECT doc_id, doc_id AS id, workspace_id, workspace_id AS business_id, user_id, filename, mime_type, page_count, chunk_count, full_text, created_at
       FROM workspace_documents
       WHERE workspace_id = $1
       ORDER BY created_at ASC;`,
      [businessId]
    );
    if (res && Array.isArray(res.rows) && res.rows.length > 0) {
      DOCUMENTS_BY_BUSINESS.set(businessId, res.rows);
      return res.rows;
    }
  } catch {
    // Fallback to empty
  }
  return [];
}

/**
 * Retrieves all semantic chunks for a business.
 *
 * @param {string} businessId
 * @returns {Promise<Array<object>>}
 */
async function getChunksForBusiness(businessId) {
  const memChunks = CHUNKS_BY_BUSINESS.get(businessId) || [];
  if (memChunks.length > 0) {
    return memChunks;
  }

  try {
    const res = await query(
      `SELECT chunk_id, doc_id, COALESCE(workspace_document_id, doc_id) AS workspace_document_id, workspace_id, workspace_id AS business_id, user_id, filename, page_number, chunk_index, section_title, raw_text, locator, breadcrumb_header, enriched_text, extracted_entities
       FROM workspace_document_chunks
       WHERE workspace_id = $1
       ORDER BY filename ASC, page_number ASC, chunk_index ASC;`,
      [businessId]
    );
    if (res && Array.isArray(res.rows) && res.rows.length > 0) {
      const hydrated = res.rows.map((r) => ({
        ...r,
        enriched_text: r.enriched_text || `${r.breadcrumb_header || ''}\n${r.raw_text}`,
        extracted_entities: Array.isArray(r.extracted_entities) ? r.extracted_entities : [],
        tokens: tokenizeDocumentText(r.enriched_text || r.raw_text),
        tf_vector: buildTextVector(r.enriched_text || r.raw_text),
      }));
      CHUNKS_BY_BUSINESS.set(businessId, hydrated);
      return hydrated;
    }
  } catch {
    // Fallback to empty
  }
  return [];
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

module.exports = {
  tokenizeDocumentText,
  buildTextVector,
  deriveDocumentTitle,
  isDocumentHeading,
  extractChunkEntities,
  extractApplicableScope,
  extractPagesFromPdf,
  chunkDocumentPages,
  ingestDocument,
  ingestDocumentFromPath,
  listDocumentsForBusiness,
  getChunksForBusiness,
  getInMemoryChunksForBusiness,
  clearDocumentsForBusiness,
  clearAllDocumentsGlobal,
};
