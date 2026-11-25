const DEFAULT_MAX_INPUT_TOKENS = 4500;

const TOKEN_ALLOCATION_GUIDE = Object.freeze({
  systemAndTools: 600,
  tableMetadata: 800,
  rrfChunks: 1200,
  memory: 600,
  sqlRows: 1300,
});

const PROSE_FIELD_PATTERN =
  /^(?:description|notes?|comments?|summary|details|bio|product_url|image_url|images|url|body|full_text|raw_text|enriched_text)$/i;

const KEY_OR_CORE_FIELD_PATTERN =
  /(?:^id$|_id$|_key$|_code$|sku|email|status|state|tier|category|type|flag|active|eligible|date|time|created|updated|stock|qty|quantity|amount|price|total|balance|credit|limit|buffer|reserve|beds|count|score|rate|name|title|unit)/i;

/**
 * Deterministic pre-flight token estimator.
 *
 * @param {string} text
 * @returns {number}
 */
function estimateTokens(text) {
  const clean = String(text || '');
  if (!clean.trim()) return 0;
  return Math.ceil(clean.length / 3.5);
}

function renderBlockText(block) {
  if (!block) return '';
  if (typeof block.render === 'function' && Array.isArray(block.items)) {
    return String(block.render(block.items) || '');
  }
  return String(block.content || '');
}

function measureBlocks(blocks) {
  let systemTextParts = [];
  let userTextParts = [];
  for (const block of blocks) {
    const rendered = renderBlockText(block).trim();
    if (!rendered) continue;
    if (block.kind === 'system') {
      systemTextParts.push(rendered);
    } else {
      userTextParts.push(rendered);
    }
  }
  const systemPrompt = systemTextParts.join('\n\n');
  const userPrompt = userTextParts.join('\n\n');
  const estimatedTokens = estimateTokens(systemPrompt) + estimateTokens(userPrompt);
  return { systemPrompt, userPrompt, estimatedTokens };
}

function compactSqlRowObject(row, maxProseLen = 48, stripProseCols = false) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    return row;
  }
  const compacted = {};
  for (const [k, v] of Object.entries(row)) {
    if (v === null || v === undefined) continue;
    if (stripProseCols && PROSE_FIELD_PATTERN.test(k) && !KEY_OR_CORE_FIELD_PATTERN.test(k)) {
      continue;
    }
    if (typeof v === 'string') {
      const clean = v.replace(/\s+/g, ' ').trim();
      if (!clean) continue;
      if (PROSE_FIELD_PATTERN.test(k) && !KEY_OR_CORE_FIELD_PATTERN.test(k)) {
        if (clean.length > maxProseLen) {
          compacted[k] = `${clean.slice(0, maxProseLen - 3)}...`;
          continue;
        }
      }
      compacted[k] = clean.length > 120 ? `${clean.slice(0, 117)}...` : clean;
    } else if (typeof v === 'object') {
      const rawJson = JSON.stringify(v);
      if (rawJson.length > 180) {
        compacted[k] = Array.isArray(v) ? `[${v.length} items]` : `${rawJson.slice(0, 140)}...`;
      } else {
        compacted[k] = v;
      }
    } else {
      compacted[k] = v;
    }
  }
  return compacted;
}

function compactSqlObservationItem(item, maxRowsPerTable = null, stripSecondary = false) {
  if (!item || typeof item !== 'object') return item;
  if (Array.isArray(item)) {
    const sliced =
      Number.isInteger(maxRowsPerTable) && maxRowsPerTable > 0
        ? item.slice(0, maxRowsPerTable)
        : item;
    return sliced.map((el) => compactSqlObservationItem(el, maxRowsPerTable, stripSecondary));
  }
  const copy = { ...item };
  if (Array.isArray(copy.results)) {
    copy.results = copy.results.map((r) =>
      compactSqlObservationItem(r, maxRowsPerTable, stripSecondary)
    );
  }
  if (Array.isArray(copy.chunks)) {
    const chunksSlice =
      Number.isInteger(maxRowsPerTable) && maxRowsPerTable > 0
        ? copy.chunks.slice(0, Math.min(3, maxRowsPerTable))
        : copy.chunks;
    copy.chunks = chunksSlice.map((c) => ({
      chunk_id: c.chunk_id,
      filename: c.filename,
      locator: c.locator,
      raw_text: stripSecondary ? String(c.raw_text || '').slice(0, 140) : String(c.raw_text || '').slice(0, 320),
    }));
  }
  if (Array.isArray(copy.rows)) {
    const rowsToUse =
      Number.isInteger(maxRowsPerTable) && maxRowsPerTable > 0
        ? copy.rows.slice(0, maxRowsPerTable)
        : copy.rows;
    copy.rows = rowsToUse.map((r) => compactSqlRowObject(r, 40, stripSecondary));
    if (rowsToUse.length < item.rows.length) {
      copy.truncated_rows = item.rows.length - rowsToUse.length;
    }
  }
  if (Array.isArray(copy.highlighted_rows)) {
    if (stripSecondary) {
      delete copy.highlighted_rows;
    } else {
      const hlToUse =
        Number.isInteger(maxRowsPerTable) && maxRowsPerTable > 0
          ? copy.highlighted_rows.slice(0, maxRowsPerTable)
          : copy.highlighted_rows;
      copy.highlighted_rows = hlToUse.map((r) => compactSqlRowObject(r, 40, stripSecondary));
    }
  }
  if (Array.isArray(copy.query_results)) {
    copy.query_results = copy.query_results.map((qr) =>
      compactSqlObservationItem(qr, maxRowsPerTable, stripSecondary)
    );
  }
  if (Array.isArray(copy.lookup_results)) {
    copy.lookup_results = copy.lookup_results.map((lr) =>
      compactSqlObservationItem(lr, maxRowsPerTable, stripSecondary)
    );
  }
  if (copy.cross_table_evaluation && typeof copy.cross_table_evaluation === 'object') {
    const evalCopy = { ...copy.cross_table_evaluation };
    if (Array.isArray(evalCopy.pairs)) {
      const pairsToUse =
        Number.isInteger(maxRowsPerTable) && maxRowsPerTable > 0
          ? evalCopy.pairs.slice(0, maxRowsPerTable)
          : evalCopy.pairs;
      evalCopy.pairs = pairsToUse.map((p) => ({
        ...p,
        anchor_row: compactSqlRowObject(p.anchor_row, 32, stripSecondary),
        lookup_row: compactSqlRowObject(p.lookup_row, 32, stripSecondary),
      }));
    }
    copy.cross_table_evaluation = evalCopy;
  }
  if (typeof copy.thought === 'string' && copy.thought.length > 120) {
    copy.thought = `${copy.thought.slice(0, 117)}...`;
  }
  return copy;
}

/**
 * deterministically trims oversized prompt blocks in strict reverse priority order:
 * 1. Drop lowest-ranked RRF document chunks first (keeping >= 2 top chunks).
 * 2. Drop oldest turns from 5-turn memory first (keeping >= 1 latest turn).
 * 3. Compact excess SQL/Tool result row fields (preserving PKs, numerics, statuses, emails).
 * NEVER truncates system prompts, tool definitions, table_metadata keys, or the current user prompt.
 *
 * @param {Array<object>} promptBlocks
 * @param {number} [maxInputTokens=4500]
 */
function enforceTokenBudget(promptBlocks, maxInputTokens = DEFAULT_MAX_INPUT_TOKENS) {
  const limit =
    Number.isFinite(Number(maxInputTokens)) && Number(maxInputTokens) > 0
      ? Number(maxInputTokens)
      : DEFAULT_MAX_INPUT_TOKENS;

  const workingBlocks = (Array.isArray(promptBlocks) ? promptBlocks : []).map((b) => ({
    ...b,
    items: Array.isArray(b?.items) ? [...b.items] : undefined,
  }));

  const trimLog = [];
  let trimmed = false;
  let measured = measureBlocks(workingBlocks);

  // Stage 1: Drop lowest-ranked RRF chunks first, keeping at least top 2.
  // Because cache-ordered prompts place RRF chunks lowest-rank -> highest-rank, index 0 is lowest-ranked.
  if (measured.estimatedTokens > limit) {
    const chunkBlock = workingBlocks.find((b) => b.kind === 'rrf_chunks' && !b.protected);
    if (chunkBlock && Array.isArray(chunkBlock.items)) {
      let droppedChunks = 0;
      while (measured.estimatedTokens > limit && chunkBlock.items.length > 2) {
        chunkBlock.items.shift();
        droppedChunks += 1;
        trimmed = true;
        measured = measureBlocks(workingBlocks);
      }
      if (droppedChunks > 0) {
        trimLog.push(`Dropped ${droppedChunks} lowest-ranked RRF chunk(s), kept ${chunkBlock.items.length}`);
      }
      // If still over budget, trim verbose excerpt characters from remaining chunks without removing metadata
      if (measured.estimatedTokens > limit && chunkBlock.items.length > 0) {
        chunkBlock.items = chunkBlock.items.map((c) => {
          const next = { ...c };
          if (typeof next.raw_text === 'string') {
            next.raw_text = next.raw_text.slice(0, 420);
          } else if (typeof next.text === 'string') {
            next.text = next.text.slice(0, 420);
          }
          return next;
        });
        trimmed = true;
        trimLog.push('Compacted remaining RRF chunk text to <=420 chars');
        measured = measureBlocks(workingBlocks);
      }
    }
  }

  // Stage 2: Drop oldest turns from 5-turn memory window first, keeping at least latest 1 turn
  if (measured.estimatedTokens > limit) {
    const memoryBlock = workingBlocks.find((b) => b.kind === 'memory' && !b.protected);
    if (memoryBlock && Array.isArray(memoryBlock.items)) {
      let droppedTurns = 0;
      while (measured.estimatedTokens > limit && memoryBlock.items.length > 1) {
        memoryBlock.items.shift();
        droppedTurns += 1;
        trimmed = true;
        measured = measureBlocks(workingBlocks);
      }
      if (droppedTurns > 0) {
        trimLog.push(`Dropped ${droppedTurns} oldest memory turn(s), kept latest ${memoryBlock.items.length}`);
      }
    }
  }

  // Stage 3: Compact excess SQL/tool result rows while keeping PKs, numerics, statuses, emails
  if (measured.estimatedTokens > limit) {
    const sqlBlock = workingBlocks.find((b) => b.kind === 'sql_rows' && !b.protected);
    if (sqlBlock) {
      if (Array.isArray(sqlBlock.items) && sqlBlock.items.length > 0) {
        sqlBlock.items = sqlBlock.items.map((item) => compactSqlObservationItem(item, null, false));
        trimmed = true;
        trimLog.push('Compacted SQL row prose columns');
        measured = measureBlocks(workingBlocks);

        const caps = [
          { cap: 12, strip: false },
          { cap: 6, strip: true },
          { cap: 3, strip: true },
          { cap: 1, strip: true },
        ];
        for (const { cap, strip } of caps) {
          if (measured.estimatedTokens <= limit) break;
          sqlBlock.items = sqlBlock.items.map((item) =>
            compactSqlObservationItem(item, cap, strip)
          );
          trimmed = true;
          trimLog.push(`Capped SQL row arrays to ${cap} rows while preserving PKs/numerics/emails`);
          measured = measureBlocks(workingBlocks);
        }

        while (measured.estimatedTokens > limit && sqlBlock.items.length > 1) {
          // Drop earlier error-only steps (NEVER drop the most recent step items[items.length - 1] which has fresh tool feedback!)
          const earlierItems = sqlBlock.items.slice(0, -1);
          const errorOnlyIdx = earlierItems.findIndex((it) => {
            const results = Array.isArray(it?.results) ? it.results : [];
            const hasSqlData = results.some(
              (r) =>
                r &&
                r.ok === true &&
                (r.tool_name === 'query_tables_with_lookup' ||
                  Array.isArray(r.rows) ||
                  r.cross_table_evaluation)
            );
            return !hasSqlData;
          });
          if (errorOnlyIdx !== -1) {
            sqlBlock.items.splice(errorOnlyIdx, 1);
            trimLog.push('Dropped earlier error-only observation while keeping live SQL rows and latest tool feedback');
          } else {
            // Compact earliest step even further before dropping it
            sqlBlock.items.shift();
            trimLog.push('Dropped oldest observation entry from sql_rows');
          }
          trimmed = true;
          measured = measureBlocks(workingBlocks);
        }

        if (measured.estimatedTokens > limit && sqlBlock.items.length === 1) {
          const renderedSql = renderBlockText(sqlBlock);
          const otherTokens = measured.estimatedTokens - estimateTokens(renderedSql);
          const availableSqlChars = Math.max(350, Math.floor((limit - otherTokens) * 3.2));
          if (renderedSql.length > availableSqlChars) {
            sqlBlock.items = undefined;
            sqlBlock.render = undefined;
            sqlBlock.content = `${renderedSql.slice(0, availableSqlChars)}...[sql_compacted]`;
            trimmed = true;
            trimLog.push('Applied final hard cap on oversized sql_rows observation to enforce <= maxInputTokens');
            measured = measureBlocks(workingBlocks);
          }
        }
      } else if (typeof sqlBlock.content === 'string' && sqlBlock.content.length > 600) {
        try {
          const parsed = JSON.parse(sqlBlock.content);
          sqlBlock.content = JSON.stringify(
            Array.isArray(parsed)
              ? parsed.map((item) => compactSqlObservationItem(item, 10))
              : compactSqlObservationItem(parsed, 10)
          );
          trimmed = true;
          trimLog.push('Compacted serialized sql_rows JSON');
          measured = measureBlocks(workingBlocks);
        } catch {
          const keepChars = Math.max(400, Math.floor((limit - (measured.estimatedTokens - estimateTokens(sqlBlock.content))) * 3.2));
          if (sqlBlock.content.length > keepChars) {
            sqlBlock.content = `${sqlBlock.content.slice(0, keepChars)}...[compacted]`;
            trimmed = true;
            trimLog.push('Truncated raw sql_rows content to fit token budget');
            measured = measureBlocks(workingBlocks);
          }
        }
      }
    }
  }

  // Final safeguard only on non-protected dynamic chunks/memory text if still marginally over
  if (measured.estimatedTokens > limit) {
    const chunkBlock = workingBlocks.find((b) => b.kind === 'rrf_chunks' && !b.protected);
    if (chunkBlock && Array.isArray(chunkBlock.items) && chunkBlock.items.length > 0) {
      chunkBlock.items = chunkBlock.items.map((c) => {
        const next = { ...c };
        if (typeof next.raw_text === 'string') {
          next.raw_text = next.raw_text.slice(0, 180);
        } else if (typeof next.text === 'string') {
          next.text = next.text.slice(0, 180);
        }
        return next;
      });
      trimmed = true;
      trimLog.push('Applied tight 180-char excerpt cap on top RRF chunks');
      measured = measureBlocks(workingBlocks);
    }
  }

  const finalBlocks = workingBlocks.map((b) => ({
    ...b,
    renderedText: renderBlockText(b),
  }));

  return {
    blocks: finalBlocks,
    systemPrompt: measured.systemPrompt,
    userPrompt: measured.userPrompt,
    estimatedTokens: measured.estimatedTokens,
    trimmed,
    trimLog,
  };
}

module.exports = {
  DEFAULT_MAX_INPUT_TOKENS,
  TOKEN_ALLOCATION_GUIDE,
  estimateTokens,
  enforceTokenBudget,
  compactSqlRowObject,
};
