const { google } = require('googleapis');
const { getAuthenticatedClient } = require('./googleAuthService');
const { ingestDocument } = require('./documentIngestionService');
const AppError = require('../utils/AppError');

/**
 * Lists Google Docs accessible in Google Drive.
 *
 * @param {string} [businessId]
 * @returns {Promise<Array<object>>}
 */
async function listGoogleDocs(businessId) {
  try {
    const auth = await getAuthenticatedClient(businessId);
    const drive = google.drive({ version: 'v3', auth });

    const res = await drive.files.list({
      q: "mimeType='application/vnd.google-apps.document' and trashed=false",
      fields: 'files(id, name, modifiedTime, webViewLink)',
      pageSize: 30,
    });

    return res.data.files || [];
  } catch (err) {
    console.warn('[GoogleDocs] Could not list Drive files (Drive API scope or service not enabled):', err.message);
    return [];
  }
}

/**
 * Extracts plain text from a paragraph element array.
 */
function extractParagraphText(paragraph) {
  if (!paragraph || !paragraph.elements) return '';
  let str = '';
  for (const el of paragraph.elements) {
    if (el.textRun && typeof el.textRun.content === 'string') {
      str += el.textRun.content;
    }
  }
  return str.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

/**
 * Converts a Google Docs table element into a formatted Markdown table string.
 */
function formatDocsTableToMarkdown(table) {
  if (!table || !table.tableRows || table.tableRows.length === 0) return '';

  const rows = [];
  for (const row of table.tableRows) {
    const cells = [];
    for (const cell of row.tableCells || []) {
      let cellText = '';
      for (const contentEl of cell.content || []) {
        if (contentEl.paragraph) {
          cellText += extractParagraphText(contentEl.paragraph).trim() + ' ';
        }
      }
      // Sanitize pipe characters and normalize internal whitespace
      cells.push(cellText.replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim());
    }
    rows.push(cells);
  }

  if (rows.length === 0) return '';

  const colCount = Math.max(...rows.map((r) => r.length), 1);
  const normalizedRows = rows.map((r) => {
    while (r.length < colCount) r.push('');
    return r;
  });

  const mdLines = [];
  const headerRow = normalizedRows[0];
  mdLines.push(`| ${headerRow.join(' | ')} |`);
  mdLines.push(`| ${new Array(colCount).fill('---').join(' | ')} |`);

  for (let i = 1; i < normalizedRows.length; i++) {
    mdLines.push(`| ${normalizedRows[i].join(' | ')} |`);
  }

  return mdLines.join('\n');
}

function extractGoogleDocId(input) {
  if (!input || typeof input !== 'string') return '';
  const trimmed = input.trim();
  const match = trimmed.match(/\/document\/d\/([a-zA-Z0-9_-]+)/);
  if (match) return match[1];
  return trimmed;
}

function mapGoogleDocsError(err, documentId) {
  if (err instanceof AppError || err?.isOperational) {
    return err;
  }
  const gData = err?.response?.data;
  const gError = gData?.error;
  const rawMsg =
    (typeof gError === 'string' && gData?.error_description) ||
    (typeof gError === 'string' && gError) ||
    gError?.message ||
    err?.message ||
    'Failed to access Google Doc.';
  const rawStatus = Number(err?.status ?? err?.response?.status ?? gError?.code ?? err?.code);

  if (/invalid_grant/i.test(rawMsg) || /no access|refresh token|api key/i.test(rawMsg) || rawStatus === 401) {
    return new AppError(
      'No Google Workspace account is currently connected for this user. Please sign in with Google first.',
      401
    );
  }
  if (rawStatus === 403 || /permission|insufficient|accessNotConfigured/i.test(rawMsg)) {
    return new AppError(
      `Google Docs permission denied for "${documentId}": ${rawMsg}`,
      403
    );
  }
  if (rawStatus === 404 || /not found/i.test(rawMsg)) {
    return new AppError(
      `Google Doc "${documentId}" was not found or your connected Google account does not have access to it.`,
      404
    );
  }
  if (/not supported for this document|failed_precondition/i.test(rawMsg) || rawStatus === 400) {
    return new AppError(
      `Unable to parse Google Doc "${documentId}": ${rawMsg}. Ensure the link points to a native Google Doc (not a Google Sheet, PDF, or .docx).`,
      400
    );
  }
  return new AppError(
    rawMsg,
    Number.isInteger(rawStatus) && rawStatus >= 400 && rawStatus <= 599 ? rawStatus : 502
  );
}

/**
 * Parses a Google Doc into semantic Markdown sections grouped into logical pages.
 *
 * @param {string} rawDocumentId
 * @param {string} [businessId]
 * @returns {Promise<{ title: string, documentId: string, pages: Array<{ page_number: number, text: string }> }>}
 */
async function parseGoogleDoc(rawDocumentId, businessId) {
  const documentId = extractGoogleDocId(rawDocumentId);
  if (!documentId) {
    throw new AppError('A valid Google Doc ID or URL is required.', 400);
  }

  const auth = await getAuthenticatedClient(businessId);
  const docs = google.docs({ version: 'v1', auth });

  let docRes;
  try {
    docRes = await docs.documents.get({ documentId });
  } catch (err) {
    throw mapGoogleDocsError(err, documentId);
  }
  const doc = docRes.data;
  const title = doc.title || 'Untitled Document';
  const contentList = doc.body?.content || [];

  const pages = [];
  let currentPageNumber = 1;
  let currentPageLines = [];
  let currentLength = 0;

  function flushPage() {
    if (currentPageLines.length > 0) {
      const pageText = currentPageLines.join('\n').trim();
      if (pageText) {
        pages.push({
          page_number: currentPageNumber++,
          text: pageText,
        });
      }
      currentPageLines = [];
      currentLength = 0;
    }
  }

  for (const element of contentList) {
    if (element.paragraph) {
      const p = element.paragraph;
      const rawText = extractParagraphText(p);
      const trimmed = rawText.trim();
      if (!trimmed) continue;

      const style = p.paragraphStyle?.namedStyleType || 'NORMAL_TEXT';
      let formattedLine = trimmed;

      const isHeading =
        style.startsWith('HEADING_') ||
        style === 'TITLE' ||
        /^\d+\.\s+[A-Z0-9\s&,/-]{4,}$/.test(trimmed);

      if (style === 'TITLE') {
        formattedLine = `# ${trimmed}`;
      } else if (style === 'HEADING_1') {
        formattedLine = `## ${trimmed}`;
      } else if (style === 'HEADING_2') {
        formattedLine = `### ${trimmed}`;
      } else if (style === 'HEADING_3') {
        formattedLine = `#### ${trimmed}`;
      }

      // Start a new logical page on major headings or when page length exceeds ~1,500 chars
      if ((isHeading && currentLength >= 600) || currentLength >= 1600) {
        flushPage();
      }

      currentPageLines.push(formattedLine);
      currentLength += formattedLine.length + 1;
    } else if (element.table) {
      const tableMd = formatDocsTableToMarkdown(element.table);
      if (tableMd) {
        if (currentLength >= 1200) {
          flushPage();
        }
        currentPageLines.push(tableMd);
        currentLength += tableMd.length + 1;
      }
    }
  }

  flushPage();

  if (pages.length === 0) {
    pages.push({
      page_number: 1,
      text: title,
    });
  }

  return {
    title,
    documentId,
    pages,
  };
}

/**
 * Parses a Google Doc and ingests its structured pages into the workspace's Hybrid RAG store.
 *
 * @param {string} businessId
 * @param {string} documentId
 * @returns {Promise<object>}
 */
async function importGoogleDocToRAG(businessId, documentId) {
  if (!businessId) {
    throw new AppError('businessId is required to import a document.', 400);
  }

  const { title, pages } = await parseGoogleDoc(documentId, businessId);

  const cleanFilename = title.endsWith('.gdoc')
    ? title
    : `${title}.gdoc`;

  const ingestRes = await ingestDocument({
    businessId,
    filename: cleanFilename,
    customPages: pages,
    mime_type: 'application/vnd.google-apps.document',
  });

  return {
    success: true,
    workspace_document_id: ingestRes.doc_id,
    doc_id: ingestRes.doc_id,
    filename: cleanFilename,
    page_count: pages.length,
    chunk_count: ingestRes.chunk_count,
    title,
    documentId,
  };
}

module.exports = {
  listGoogleDocs,
  parseGoogleDoc,
  importGoogleDocToRAG,
};
