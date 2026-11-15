import type {
  BusinessSheetTableInfo,
  DynamicSheetRow,
  WorkspaceDocument,
} from '../../../shared/types/contracts';
import type { DocumentInspectionResponse } from './api';

export const WORKSPACE_CACHE_PREFIX = 'maxitext_ws_ctx_v1:';
export const WORKSPACE_INDEX_KEY = 'maxitext_ws_ctx_v1:index';
export const DOC_CHUNK_CACHE_PREFIX = 'maxitext_doc_chunks_v1:';
export const DOC_CHUNK_INDEX_KEY = 'maxitext_doc_chunks_v1:index';

export const FRESH_TTL_MS = 60 * 1000;
export const MAX_SWR_AGE_MS = 24 * 60 * 60 * 1000;

export const DEFAULT_CACHE_LIMITS = {
  maxEntryBytes: 750 * 1024,
  maxTotalBytes: 2.5 * 1024 * 1024,
  maxL1ChunkEntries: 25,
  maxChunkEntryBytes: 200 * 1024,
  maxChunkTotalBytes: 600 * 1024,
};

export interface SyncedGoogleSheetMeta {
  table_name: string;
  google_spreadsheet_id: string;
  google_sheet_tab_name: string;
  row_count: number;
  last_synced_at: string;
}

export interface WorkspaceContextSnapshot {
  version: 1;
  userId: string;
  workspaceId: string;
  tables: BusinessSheetTableInfo<DynamicSheetRow>[] | null;
  rowsByEntity: Record<string, DynamicSheetRow[]> | null;
  lastActiveEntity?: string;
  rowsTruncatedInL2?: boolean;
  documents: WorkspaceDocument[] | null;
  syncedSheets: SyncedGoogleSheetMeta[] | null;
  tablesCachedAt: number | null;
  documentsCachedAt: number | null;
  syncedSheetsCachedAt: number | null;
  updatedAt: number;
}

export interface WorkspaceFreshnessStatus {
  tablesUsable: boolean;
  tablesFresh: boolean;
  documentsUsable: boolean;
  documentsFresh: boolean;
  syncedSheetsUsable: boolean;
  syncedSheetsFresh: boolean;
}

export interface CachedWorkspaceContextResult {
  snapshot: WorkspaceContextSnapshot;
  freshness: WorkspaceFreshnessStatus;
  source: 'l1' | 'l2';
}

interface LruIndexEntry {
  key: string;
  userId: string;
  workspaceId: string;
  byteSize: number;
  lastAccessedAt: number;
}

interface ChunkCacheRecord {
  version: 1;
  userId: string;
  workspaceId: string;
  docId: string;
  filename: string;
  cachedAt: number;
  data: DocumentInspectionResponse;
}

interface ChunkLruIndexEntry {
  key: string;
  userId: string;
  workspaceId: string;
  aliases: string[];
  byteSize: number;
  lastAccessedAt: number;
}

const l1WorkspaceCache = new Map<string, WorkspaceContextSnapshot>();
const l1ChunkCache = new Map<string, ChunkCacheRecord>();
const l1ChunkAliases = new Map<string, string>();
const inFlightRequests = new Map<string, Promise<unknown>>();

function getBrowserStorage(): Storage | null {
  try {
    const storage = (globalThis as { localStorage?: Storage })?.localStorage;
    if (
      storage &&
      typeof storage.getItem === 'function' &&
      typeof storage.setItem === 'function' &&
      typeof storage.removeItem === 'function'
    ) {
      return storage;
    }
  } catch {
    // Storage access blocked (e.g. private mode or sandbox)
  }
  return null;
}

export function resolveCacheUserId(explicitUserId?: string | null): string {
  if (explicitUserId && String(explicitUserId).trim()) {
    return String(explicitUserId).trim();
  }
  const storage = getBrowserStorage();
  if (storage) {
    try {
      const storedId = storage.getItem('maxitext_user_id');
      if (storedId && storedId.trim()) {
        return storedId.trim();
      }
      const rawProfile = storage.getItem('maxitext_user_profile');
      if (rawProfile) {
        const parsed = JSON.parse(rawProfile);
        if (parsed?.id && String(parsed.id).trim()) {
          return String(parsed.id).trim();
        }
      }
    } catch {
      // Ignore parse or storage errors
    }
  }
  return 'anonymous';
}

function buildScopeKey(userId: string, workspaceId: string): string {
  return `${userId}::${workspaceId}`;
}

function buildWorkspaceStorageKey(userId: string, workspaceId: string): string {
  return `${WORKSPACE_CACHE_PREFIX}${encodeURIComponent(userId)}:${encodeURIComponent(workspaceId)}`;
}

function normalizeIdentifierKey(identifier: string): string {
  return String(identifier || '').trim().toLowerCase();
}

function buildChunkScopeKey(userId: string, workspaceId: string, identifier: string): string {
  return `${userId}::${workspaceId}::${normalizeIdentifierKey(identifier)}`;
}

function buildChunkStorageKey(userId: string, workspaceId: string, canonicalDocKey: string): string {
  return `${DOC_CHUNK_CACHE_PREFIX}${encodeURIComponent(userId)}:${encodeURIComponent(workspaceId)}:${encodeURIComponent(canonicalDocKey)}`;
}

function estimateSerializedBytes(serialized: string): number {
  return serialized.length * 2;
}

function createEmptySnapshot(userId: string, workspaceId: string, now = Date.now()): WorkspaceContextSnapshot {
  return {
    version: 1,
    userId,
    workspaceId,
    tables: null,
    rowsByEntity: null,
    documents: null,
    syncedSheets: null,
    tablesCachedAt: null,
    documentsCachedAt: null,
    syncedSheetsCachedAt: null,
    updatedAt: now,
  };
}

export function isTimestampUsable(
  ts: number | null | undefined,
  maxAgeMs = MAX_SWR_AGE_MS,
  now = Date.now()
): boolean {
  if (typeof ts !== 'number' || !Number.isFinite(ts) || ts <= 0) {
    return false;
  }
  const age = now - ts;
  return age >= 0 && age <= maxAgeMs;
}

export function isTimestampFresh(
  ts: number | null | undefined,
  freshTtlMs = FRESH_TTL_MS,
  now = Date.now()
): boolean {
  if (typeof ts !== 'number' || !Number.isFinite(ts) || ts <= 0) {
    return false;
  }
  const age = now - ts;
  return age >= 0 && age < freshTtlMs;
}

function computeFreshness(
  snapshot: WorkspaceContextSnapshot,
  freshTtlMs = FRESH_TTL_MS,
  maxAgeMs = MAX_SWR_AGE_MS,
  now = Date.now()
): WorkspaceFreshnessStatus {
  const tablesUsable =
    Array.isArray(snapshot.tables) && isTimestampUsable(snapshot.tablesCachedAt, maxAgeMs, now);
  const documentsUsable =
    Array.isArray(snapshot.documents) &&
    isTimestampUsable(snapshot.documentsCachedAt, maxAgeMs, now);
  const syncedSheetsUsable =
    Array.isArray(snapshot.syncedSheets) &&
    isTimestampUsable(snapshot.syncedSheetsCachedAt, maxAgeMs, now);

  return {
    tablesUsable,
    tablesFresh:
      tablesUsable &&
      !snapshot.rowsTruncatedInL2 &&
      isTimestampFresh(snapshot.tablesCachedAt, freshTtlMs, now),
    documentsUsable,
    documentsFresh:
      documentsUsable && isTimestampFresh(snapshot.documentsCachedAt, freshTtlMs, now),
    syncedSheetsUsable,
    syncedSheetsFresh:
      syncedSheetsUsable && isTimestampFresh(snapshot.syncedSheetsCachedAt, freshTtlMs, now),
  };
}

function readJsonIndex<T>(storage: Storage, indexKey: string): T[] {
  try {
    const raw = storage.getItem(indexKey);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeJsonIndex<T>(storage: Storage, indexKey: string, entries: T[]): void {
  try {
    storage.setItem(indexKey, JSON.stringify(entries));
  } catch {
    // Best-effort index write
  }
}

function cloneTablesWithRowLimit(
  tables: BusinessSheetTableInfo<DynamicSheetRow>[] | null,
  rowsByEntity: Record<string, DynamicSheetRow[]> | null,
  rowCapPerTable: number
): {
  tables: BusinessSheetTableInfo<DynamicSheetRow>[] | null;
  rowsByEntity: Record<string, DynamicSheetRow[]> | null;
} {
  if (!Array.isArray(tables)) {
    return { tables: null, rowsByEntity: null };
  }
  const nextTables = tables.map((table) => {
    const fullRows = Array.isArray(table.rows)
      ? table.rows
      : Array.isArray(rowsByEntity?.[table.entity])
        ? rowsByEntity[table.entity]
        : [];
    const cappedRows = rowCapPerTable > 0 ? fullRows.slice(0, rowCapPerTable) : [];
    return {
      ...table,
      rows: cappedRows,
    };
  });
  return {
    tables: nextTables,
    rowsByEntity: null, // Reconstructed from tables[].rows upon L2 read to halve JSON size
  };
}

function buildPersistableWorkspaceJson(
  snapshot: WorkspaceContextSnapshot,
  maxEntryBytes = DEFAULT_CACHE_LIMITS.maxEntryBytes
): { serialized: string; truncated: boolean } {
  // Store tables[].rows in L2 and omit duplicate rowsByEntity map to avoid duplicating every row
  const compactSnapshot: WorkspaceContextSnapshot = {
    ...snapshot,
    rowsByEntity: null,
  };
  const directJson = JSON.stringify(compactSnapshot);
  if (estimateSerializedBytes(directJson) <= maxEntryBytes) {
    return { serialized: directJson, truncated: Boolean(snapshot.rowsTruncatedInL2) };
  }

  // Progressively trim rows stored in L2 while retaining table schemas, counts, docs & synced metadata
  for (const rowCap of [100, 25, 0]) {
    const trimmed = cloneTablesWithRowLimit(snapshot.tables, snapshot.rowsByEntity, rowCap);
    const candidate: WorkspaceContextSnapshot = {
      ...compactSnapshot,
      tables: trimmed.tables,
      rowsByEntity: trimmed.rowsByEntity,
      rowsTruncatedInL2: true,
    };
    const json = JSON.stringify(candidate);
    if (estimateSerializedBytes(json) <= maxEntryBytes || rowCap === 0) {
      return { serialized: json, truncated: true };
    }
  }

  return { serialized: directJson, truncated: true };
}

function getCombinedL2Bytes(storage: Storage): number {
  const wsIndex = readJsonIndex<LruIndexEntry>(storage, WORKSPACE_INDEX_KEY);
  const chunkIndex = readJsonIndex<ChunkLruIndexEntry>(storage, DOC_CHUNK_INDEX_KEY);
  const wsBytes = wsIndex.reduce((sum, item) => sum + (Number(item.byteSize) || 0), 0);
  const chunkBytes = chunkIndex.reduce((sum, item) => sum + (Number(item.byteSize) || 0), 0);
  return wsBytes + chunkBytes;
}

function evictOldestChunks(storage: Storage, targetFreeBytes: number): number {
  const index = readJsonIndex<ChunkLruIndexEntry>(storage, DOC_CHUNK_INDEX_KEY);
  if (index.length === 0) return 0;
  const sorted = [...index].sort((a, b) => (a.lastAccessedAt || 0) - (b.lastAccessedAt || 0));
  let freed = 0;
  const remaining: ChunkLruIndexEntry[] = [];
  for (const entry of sorted) {
    if (freed < targetFreeBytes) {
      try {
        storage.removeItem(entry.key);
      } catch {
        // Ignore removal errors
      }
      freed += Number(entry.byteSize) || 0;
    } else {
      remaining.push(entry);
    }
  }
  writeJsonIndex(storage, DOC_CHUNK_INDEX_KEY, remaining);
  return freed;
}

function evictWorkspaceEntriesForBudget(
  storage: Storage,
  incomingKey: string,
  incomingBytes: number
): void {
  const currentTotal = getCombinedL2Bytes(storage);
  const existingWs = readJsonIndex<LruIndexEntry>(storage, WORKSPACE_INDEX_KEY);
  const prevSame = existingWs.find((e) => e.key === incomingKey);
  const prevBytes = prevSame ? Number(prevSame.byteSize) || 0 : 0;
  const projectedTotal = currentTotal - prevBytes + incomingBytes;

  if (projectedTotal <= DEFAULT_CACHE_LIMITS.maxTotalBytes) {
    return;
  }

  let needToFree = projectedTotal - DEFAULT_CACHE_LIMITS.maxTotalBytes;
  needToFree -= evictOldestChunks(storage, needToFree);
  if (needToFree <= 0) return;

  const others = existingWs
    .filter((entry) => entry.key !== incomingKey)
    .sort((a, b) => (a.lastAccessedAt || 0) - (b.lastAccessedAt || 0));

  const kept: LruIndexEntry[] = prevSame ? [prevSame] : [];
  for (const entry of others) {
    if (needToFree > 0) {
      try {
        storage.removeItem(entry.key);
      } catch {
        // Ignore
      }
      needToFree -= Number(entry.byteSize) || 0;
    } else {
      kept.push(entry);
    }
  }
  writeJsonIndex(storage, WORKSPACE_INDEX_KEY, kept);
}

function writeSnapshotToL2(snapshot: WorkspaceContextSnapshot): void {
  const storage = getBrowserStorage();
  if (!storage) return;

  const storageKey = buildWorkspaceStorageKey(snapshot.userId, snapshot.workspaceId);
  const { serialized } = buildPersistableWorkspaceJson(snapshot);
  const byteSize = estimateSerializedBytes(serialized);

  if (byteSize > DEFAULT_CACHE_LIMITS.maxTotalBytes) {
    return;
  }

  evictWorkspaceEntriesForBudget(storage, storageKey, byteSize);

  const attemptWrite = (): boolean => {
    try {
      storage.setItem(storageKey, serialized);
      const index = readJsonIndex<LruIndexEntry>(storage, WORKSPACE_INDEX_KEY).filter(
        (entry) => entry.key !== storageKey
      );
      index.push({
        key: storageKey,
        userId: snapshot.userId,
        workspaceId: snapshot.workspaceId,
        byteSize,
        lastAccessedAt: Date.now(),
      });
      writeJsonIndex(storage, WORKSPACE_INDEX_KEY, index);
      return true;
    } catch {
      return false;
    }
  };

  if (attemptWrite()) {
    return;
  }

  // Handle QuotaExceededError cleanly by shedding all cached chunks and oldest workspaces
  evictOldestChunks(storage, Number.MAX_SAFE_INTEGER);
  const wsIndex = readJsonIndex<LruIndexEntry>(storage, WORKSPACE_INDEX_KEY)
    .filter((entry) => entry.key !== storageKey)
    .sort((a, b) => (a.lastAccessedAt || 0) - (b.lastAccessedAt || 0));

  const evictCount = Math.max(1, Math.ceil(wsIndex.length / 2));
  for (let i = 0; i < evictCount && i < wsIndex.length; i += 1) {
    try {
      storage.removeItem(wsIndex[i].key);
    } catch {
      // Ignore
    }
  }
  writeJsonIndex(storage, WORKSPACE_INDEX_KEY, wsIndex.slice(evictCount));
  attemptWrite();
}

function hydrateRowsByEntityFromTables(
  snapshot: WorkspaceContextSnapshot
): WorkspaceContextSnapshot {
  if (snapshot.rowsByEntity && Object.keys(snapshot.rowsByEntity).length > 0) {
    return snapshot;
  }
  if (!Array.isArray(snapshot.tables)) {
    return snapshot;
  }
  const reconstructed: Record<string, DynamicSheetRow[]> = {};
  for (const table of snapshot.tables) {
    if (table?.entity) {
      reconstructed[table.entity] = Array.isArray(table.rows) ? table.rows : [];
    }
  }
  return {
    ...snapshot,
    rowsByEntity: reconstructed,
  };
}

function readSnapshotFromL2(
  userId: string,
  workspaceId: string
): WorkspaceContextSnapshot | null {
  const storage = getBrowserStorage();
  if (!storage) return null;

  const storageKey = buildWorkspaceStorageKey(userId, workspaceId);
  try {
    const raw = storage.getItem(storageKey);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as WorkspaceContextSnapshot;
    if (!parsed || parsed.version !== 1 || parsed.workspaceId !== workspaceId) {
      return null;
    }
    const hydrated = hydrateRowsByEntityFromTables(parsed);
    // Touch LRU timestamp in index
    const index = readJsonIndex<LruIndexEntry>(storage, WORKSPACE_INDEX_KEY);
    const existing = index.find((e) => e.key === storageKey);
    if (existing) {
      existing.lastAccessedAt = Date.now();
      writeJsonIndex(storage, WORKSPACE_INDEX_KEY, index);
    }
    return hydrated;
  } catch {
    return null;
  }
}

export function getCachedWorkspaceContext(
  workspaceId: string,
  explicitUserId?: string | null,
  options?: { freshTtlMs?: number; maxAgeMs?: number }
): CachedWorkspaceContextResult | null {
  const cleanWsId = String(workspaceId || '').trim();
  if (!cleanWsId) return null;

  const userId = resolveCacheUserId(explicitUserId);
  const scopeKey = buildScopeKey(userId, cleanWsId);
  const freshTtlMs = options?.freshTtlMs ?? FRESH_TTL_MS;
  const maxAgeMs = options?.maxAgeMs ?? MAX_SWR_AGE_MS;

  const l1 = l1WorkspaceCache.get(scopeKey);
  if (l1) {
    const freshness = computeFreshness(l1, freshTtlMs, maxAgeMs);
    if (freshness.tablesUsable || freshness.documentsUsable || freshness.syncedSheetsUsable) {
      return {
        snapshot: {
          ...l1,
          tables: freshness.tablesUsable ? l1.tables : null,
          rowsByEntity: freshness.tablesUsable ? l1.rowsByEntity : null,
          documents: freshness.documentsUsable ? l1.documents : null,
          syncedSheets: freshness.syncedSheetsUsable ? l1.syncedSheets : null,
        },
        freshness,
        source: 'l1',
      };
    }
  }

  const l2 = readSnapshotFromL2(userId, cleanWsId);
  if (!l2) return null;

  const freshness = computeFreshness(l2, freshTtlMs, maxAgeMs);
  if (!freshness.tablesUsable && !freshness.documentsUsable && !freshness.syncedSheetsUsable) {
    return null;
  }

  l1WorkspaceCache.set(scopeKey, l2);
  return {
    snapshot: {
      ...l2,
      tables: freshness.tablesUsable ? l2.tables : null,
      rowsByEntity: freshness.tablesUsable ? l2.rowsByEntity : null,
      documents: freshness.documentsUsable ? l2.documents : null,
      syncedSheets: freshness.syncedSheetsUsable ? l2.syncedSheets : null,
    },
    freshness,
    source: 'l2',
  };
}

function getOrInitSnapshot(userId: string, workspaceId: string): WorkspaceContextSnapshot {
  const scopeKey = buildScopeKey(userId, workspaceId);
  const existingL1 = l1WorkspaceCache.get(scopeKey);
  if (existingL1) return existingL1;
  const existingL2 = readSnapshotFromL2(userId, workspaceId);
  if (existingL2) return existingL2;
  return createEmptySnapshot(userId, workspaceId);
}

export function setCachedWorkspaceTables(
  workspaceId: string,
  payload: {
    tables: BusinessSheetTableInfo<DynamicSheetRow>[];
    rowsByEntity?: Record<string, DynamicSheetRow[]>;
    lastActiveEntity?: string;
  },
  explicitUserId?: string | null
): void {
  const cleanWsId = String(workspaceId || '').trim();
  if (!cleanWsId) return;

  const userId = resolveCacheUserId(explicitUserId);
  const scopeKey = buildScopeKey(userId, cleanWsId);
  const now = Date.now();
  const base = getOrInitSnapshot(userId, cleanWsId);

  const normalizedTables = Array.isArray(payload.tables) ? payload.tables : [];
  const rowsByEntity: Record<string, DynamicSheetRow[]> = payload.rowsByEntity
    ? { ...payload.rowsByEntity }
    : {};
  if (!payload.rowsByEntity) {
    for (const table of normalizedTables) {
      if (table?.entity) {
        rowsByEntity[table.entity] = Array.isArray(table.rows) ? table.rows : [];
      }
    }
  }

  const nextSnapshot: WorkspaceContextSnapshot = {
    ...base,
    tables: normalizedTables,
    rowsByEntity,
    lastActiveEntity: payload.lastActiveEntity ?? base.lastActiveEntity,
    rowsTruncatedInL2: false,
    tablesCachedAt: now,
    updatedAt: now,
  };

  l1WorkspaceCache.set(scopeKey, nextSnapshot);
  writeSnapshotToL2(nextSnapshot);
}

export function setWorkspaceLastActiveEntity(
  workspaceId: string,
  entity: string,
  explicitUserId?: string | null
): void {
  const cleanWsId = String(workspaceId || '').trim();
  const cleanEntity = String(entity || '').trim();
  if (!cleanWsId || !cleanEntity) return;

  const userId = resolveCacheUserId(explicitUserId);
  const scopeKey = buildScopeKey(userId, cleanWsId);
  const existing = l1WorkspaceCache.get(scopeKey) || readSnapshotFromL2(userId, cleanWsId);
  if (!existing) return;

  const updated: WorkspaceContextSnapshot = {
    ...existing,
    lastActiveEntity: cleanEntity,
    updatedAt: Date.now(),
  };
  l1WorkspaceCache.set(scopeKey, updated);
  writeSnapshotToL2(updated);
}

export function setCachedWorkspaceDocuments(
  workspaceId: string,
  documents: WorkspaceDocument[],
  explicitUserId?: string | null
): void {
  const cleanWsId = String(workspaceId || '').trim();
  if (!cleanWsId) return;

  const userId = resolveCacheUserId(explicitUserId);
  const scopeKey = buildScopeKey(userId, cleanWsId);
  const now = Date.now();
  const base = getOrInitSnapshot(userId, cleanWsId);

  const nextSnapshot: WorkspaceContextSnapshot = {
    ...base,
    documents: Array.isArray(documents) ? documents : [],
    documentsCachedAt: now,
    updatedAt: now,
  };

  l1WorkspaceCache.set(scopeKey, nextSnapshot);
  writeSnapshotToL2(nextSnapshot);
}

export function setCachedWorkspaceSyncedSheets(
  workspaceId: string,
  syncedSheets: SyncedGoogleSheetMeta[],
  explicitUserId?: string | null
): void {
  const cleanWsId = String(workspaceId || '').trim();
  if (!cleanWsId) return;

  const userId = resolveCacheUserId(explicitUserId);
  const scopeKey = buildScopeKey(userId, cleanWsId);
  const now = Date.now();
  const base = getOrInitSnapshot(userId, cleanWsId);

  const nextSnapshot: WorkspaceContextSnapshot = {
    ...base,
    syncedSheets: Array.isArray(syncedSheets) ? syncedSheets : [],
    syncedSheetsCachedAt: now,
    updatedAt: now,
  };

  l1WorkspaceCache.set(scopeKey, nextSnapshot);
  writeSnapshotToL2(nextSnapshot);
}

export function patchCachedTableRows(
  workspaceId: string,
  entity: string,
  rows: DynamicSheetRow[],
  metaPatch?: { displayName?: string; columns?: string[] },
  explicitUserId?: string | null
): void {
  const cleanWsId = String(workspaceId || '').trim();
  const cleanEntity = String(entity || '').trim();
  if (!cleanWsId || !cleanEntity) return;

  const userId = resolveCacheUserId(explicitUserId);
  const scopeKey = buildScopeKey(userId, cleanWsId);
  const existing = l1WorkspaceCache.get(scopeKey) || readSnapshotFromL2(userId, cleanWsId);
  if (!existing || !Array.isArray(existing.tables)) return;

  const nextRows = Array.isArray(rows) ? rows : [];
  const nextRowsByEntity = {
    ...(existing.rowsByEntity || {}),
    [cleanEntity]: nextRows,
  };

  const lowerTarget = cleanEntity.toLowerCase();
  let updatedTable = false;
  const nextTables = existing.tables.map((tbl) => {
    if (String(tbl.entity || '').toLowerCase() !== lowerTarget) {
      return tbl;
    }
    updatedTable = true;
    return {
      ...tbl,
      displayName: metaPatch?.displayName || tbl.displayName,
      columns:
        Array.isArray(metaPatch?.columns) && metaPatch.columns.length > 0
          ? metaPatch.columns
          : tbl.columns,
      rowCount: nextRows.length,
      rows: nextRows,
    };
  });

  if (!updatedTable) {
    nextTables.push({
      entity: cleanEntity,
      tableName: cleanEntity,
      displayName: metaPatch?.displayName || cleanEntity,
      fileName: `${cleanEntity}.csv`,
      columns: Array.isArray(metaPatch?.columns) ? metaPatch.columns : [],
      rowCount: nextRows.length,
      rows: nextRows,
    });
  }

  const hasIncompleteOtherTable = nextTables.some(
    (tbl) =>
      String(tbl.entity || '').toLowerCase() !== lowerTarget &&
      Number(tbl.rowCount || 0) > (Array.isArray(tbl.rows) ? tbl.rows.length : 0)
  );

  const now = Date.now();
  const nextSnapshot: WorkspaceContextSnapshot = {
    ...existing,
    tables: nextTables,
    rowsByEntity: nextRowsByEntity,
    lastActiveEntity: cleanEntity,
    rowsTruncatedInL2: Boolean(existing.rowsTruncatedInL2 && hasIncompleteOtherTable),
    tablesCachedAt: now,
    updatedAt: now,
  };

  l1WorkspaceCache.set(scopeKey, nextSnapshot);
  writeSnapshotToL2(nextSnapshot);
}

export function removeCachedTableEntity(
  workspaceId: string,
  entity: string,
  explicitUserId?: string | null
): void {
  const cleanWsId = String(workspaceId || '').trim();
  const cleanEntity = String(entity || '').trim();
  if (!cleanWsId || !cleanEntity) return;

  const userId = resolveCacheUserId(explicitUserId);
  const scopeKey = buildScopeKey(userId, cleanWsId);
  const existing = l1WorkspaceCache.get(scopeKey) || readSnapshotFromL2(userId, cleanWsId);
  if (!existing) return;

  const lowerTarget = cleanEntity.toLowerCase();
  const nextTables = Array.isArray(existing.tables)
    ? existing.tables.filter((t) => String(t.entity || '').toLowerCase() !== lowerTarget)
    : existing.tables;

  const nextRowsByEntity = existing.rowsByEntity ? { ...existing.rowsByEntity } : null;
  if (nextRowsByEntity) {
    for (const key of Object.keys(nextRowsByEntity)) {
      if (key.toLowerCase() === lowerTarget) {
        delete nextRowsByEntity[key];
      }
    }
  }

  const nextSynced = Array.isArray(existing.syncedSheets)
    ? existing.syncedSheets.filter((s) => String(s.table_name || '').toLowerCase() !== lowerTarget)
    : existing.syncedSheets;

  const nextActive =
    existing.lastActiveEntity && existing.lastActiveEntity.toLowerCase() === lowerTarget
      ? nextTables?.[0]?.entity || ''
      : existing.lastActiveEntity;

  const nextSnapshot: WorkspaceContextSnapshot = {
    ...existing,
    tables: nextTables,
    rowsByEntity: nextRowsByEntity,
    syncedSheets: nextSynced,
    lastActiveEntity: nextActive,
    updatedAt: Date.now(),
  };

  l1WorkspaceCache.set(scopeKey, nextSnapshot);
  writeSnapshotToL2(nextSnapshot);
}

export function removeCachedDocument(
  workspaceId: string,
  docIdentifier: string,
  explicitUserId?: string | null
): void {
  const cleanWsId = String(workspaceId || '').trim();
  const cleanTarget = normalizeIdentifierKey(docIdentifier);
  if (!cleanWsId || !cleanTarget) return;

  const userId = resolveCacheUserId(explicitUserId);
  const scopeKey = buildScopeKey(userId, cleanWsId);
  const existing = l1WorkspaceCache.get(scopeKey) || readSnapshotFromL2(userId, cleanWsId);

  let matchedFilename = '';
  let matchedDocId = '';
  if (existing && Array.isArray(existing.documents)) {
    const remainingDocs: WorkspaceDocument[] = [];
    for (const doc of existing.documents) {
      const idNorm = normalizeIdentifierKey(doc.doc_id);
      const fnameNorm = normalizeIdentifierKey(doc.filename);
      if (idNorm === cleanTarget || fnameNorm === cleanTarget) {
        matchedDocId = doc.doc_id || '';
        matchedFilename = doc.filename || '';
      } else {
        remainingDocs.push(doc);
      }
    }
    const nextSnapshot: WorkspaceContextSnapshot = {
      ...existing,
      documents: remainingDocs,
      updatedAt: Date.now(),
    };
    l1WorkspaceCache.set(scopeKey, nextSnapshot);
    writeSnapshotToL2(nextSnapshot);
  }

  evictCachedDocumentChunks(cleanWsId, docIdentifier, userId);
  if (matchedDocId) evictCachedDocumentChunks(cleanWsId, matchedDocId, userId);
  if (matchedFilename) evictCachedDocumentChunks(cleanWsId, matchedFilename, userId);
}

export function invalidateWorkspaceCache(
  workspaceId: string,
  slices: Array<'tables' | 'documents' | 'syncedSheets'> = ['tables', 'documents', 'syncedSheets'],
  explicitUserId?: string | null
): void {
  const cleanWsId = String(workspaceId || '').trim();
  if (!cleanWsId) return;
  const userId = resolveCacheUserId(explicitUserId);
  const scopeKey = buildScopeKey(userId, cleanWsId);
  const existing = l1WorkspaceCache.get(scopeKey) || readSnapshotFromL2(userId, cleanWsId);
  if (!existing) return;

  const next: WorkspaceContextSnapshot = { ...existing, updatedAt: Date.now() };
  if (slices.includes('tables')) {
    next.tablesCachedAt = null;
  }
  if (slices.includes('documents')) {
    next.documentsCachedAt = null;
  }
  if (slices.includes('syncedSheets')) {
    next.syncedSheetsCachedAt = null;
  }
  l1WorkspaceCache.set(scopeKey, next);
  writeSnapshotToL2(next);
}

// =============================================================================
// Document Chunks Sub-Cache (CitationInspectorModal)
// =============================================================================

function touchL1ChunkLru(canonicalKey: string, record: ChunkCacheRecord): void {
  if (l1ChunkCache.has(canonicalKey)) {
    l1ChunkCache.delete(canonicalKey);
  }
  l1ChunkCache.set(canonicalKey, record);
  while (l1ChunkCache.size > DEFAULT_CACHE_LIMITS.maxL1ChunkEntries) {
    const oldestKey = l1ChunkCache.keys().next().value;
    if (!oldestKey) break;
    l1ChunkCache.delete(oldestKey);
    for (const [aliasKey, target] of l1ChunkAliases.entries()) {
      if (target === oldestKey) {
        l1ChunkAliases.delete(aliasKey);
      }
    }
  }
}

function writeChunkRecordToL2(record: ChunkCacheRecord, aliases: string[]): void {
  const storage = getBrowserStorage();
  if (!storage) return;

  const canonicalDocId = record.docId || record.filename;
  const storageKey = buildChunkStorageKey(record.userId, record.workspaceId, canonicalDocId);

  let serialized = '';
  try {
    serialized = JSON.stringify(record);
  } catch {
    return;
  }
  const byteSize = estimateSerializedBytes(serialized);
  if (byteSize > DEFAULT_CACHE_LIMITS.maxChunkEntryBytes) {
    return;
  }

  let index = readJsonIndex<ChunkLruIndexEntry>(storage, DOC_CHUNK_INDEX_KEY).filter(
    (item) => item.key !== storageKey
  );
  let totalChunkBytes =
    index.reduce((sum, item) => sum + (Number(item.byteSize) || 0), 0) + byteSize;

  if (totalChunkBytes > DEFAULT_CACHE_LIMITS.maxChunkTotalBytes) {
    const sorted = [...index].sort((a, b) => (a.lastAccessedAt || 0) - (b.lastAccessedAt || 0));
    const kept: ChunkLruIndexEntry[] = [];
    for (const item of sorted) {
      if (totalChunkBytes > DEFAULT_CACHE_LIMITS.maxChunkTotalBytes) {
        try {
          storage.removeItem(item.key);
        } catch {
          // Ignore
        }
        totalChunkBytes -= Number(item.byteSize) || 0;
      } else {
        kept.push(item);
      }
    }
    index = kept;
  }

  try {
    storage.setItem(storageKey, serialized);
    index.push({
      key: storageKey,
      userId: record.userId,
      workspaceId: record.workspaceId,
      aliases,
      byteSize,
      lastAccessedAt: Date.now(),
    });
    writeJsonIndex(storage, DOC_CHUNK_INDEX_KEY, index);
  } catch {
    // Ignore L2 quota overflow for chunk cache; L1 cache still serves current session
  }
}

export function getCachedDocumentChunks(
  workspaceId: string,
  docIdentifier: string,
  explicitUserId?: string | null,
  options?: { maxAgeMs?: number }
): DocumentInspectionResponse | null {
  const cleanWsId = String(workspaceId || '').trim();
  const normId = normalizeIdentifierKey(docIdentifier);
  if (!cleanWsId || !normId) return null;

  const userId = resolveCacheUserId(explicitUserId);
  const maxAgeMs = options?.maxAgeMs ?? MAX_SWR_AGE_MS;
  const aliasKey = buildChunkScopeKey(userId, cleanWsId, normId);
  const canonicalKey = l1ChunkAliases.get(aliasKey) || aliasKey;

  const l1 = l1ChunkCache.get(canonicalKey);
  if (l1 && isTimestampUsable(l1.cachedAt, maxAgeMs)) {
    touchL1ChunkLru(canonicalKey, l1);
    return l1.data;
  }
  if (l1) {
    l1ChunkCache.delete(canonicalKey);
  }

  const storage = getBrowserStorage();
  if (!storage) return null;

  const index = readJsonIndex<ChunkLruIndexEntry>(storage, DOC_CHUNK_INDEX_KEY);
  const matchEntry = index.find(
    (entry) =>
      entry.userId === userId &&
      entry.workspaceId === cleanWsId &&
      Array.isArray(entry.aliases) &&
      entry.aliases.includes(normId)
  );
  if (!matchEntry) return null;

  try {
    const raw = storage.getItem(matchEntry.key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ChunkCacheRecord;
    if (!parsed || !isTimestampUsable(parsed.cachedAt, maxAgeMs)) {
      storage.removeItem(matchEntry.key);
      return null;
    }
    const storedCanonical = buildChunkScopeKey(
      userId,
      cleanWsId,
      parsed.docId || parsed.filename || normId
    );
    touchL1ChunkLru(storedCanonical, parsed);
    for (const al of matchEntry.aliases) {
      l1ChunkAliases.set(buildChunkScopeKey(userId, cleanWsId, al), storedCanonical);
    }
    matchEntry.lastAccessedAt = Date.now();
    writeJsonIndex(storage, DOC_CHUNK_INDEX_KEY, index);
    return parsed.data;
  } catch {
    return null;
  }
}

export function setCachedDocumentChunks(
  workspaceId: string,
  docIdentifier: string,
  data: DocumentInspectionResponse,
  explicitUserId?: string | null
): void {
  const cleanWsId = String(workspaceId || '').trim();
  if (!cleanWsId || !data || !data.document) return;

  const userId = resolveCacheUserId(explicitUserId);
  const docId = String(data.document.id || '').trim();
  const filename = String(data.document.filename || '').trim();
  const canonicalId = docId || filename || docIdentifier;
  const canonicalKey = buildChunkScopeKey(userId, cleanWsId, canonicalId);

  const aliasesSet = new Set<string>(
    [docId, filename, docIdentifier]
      .map(normalizeIdentifierKey)
      .filter(Boolean)
  );
  const aliases = Array.from(aliasesSet);

  const record: ChunkCacheRecord = {
    version: 1,
    userId,
    workspaceId: cleanWsId,
    docId,
    filename,
    cachedAt: Date.now(),
    data,
  };

  touchL1ChunkLru(canonicalKey, record);
  for (const al of aliases) {
    l1ChunkAliases.set(buildChunkScopeKey(userId, cleanWsId, al), canonicalKey);
  }
  writeChunkRecordToL2(record, aliases);
}

export function evictCachedDocumentChunks(
  workspaceId: string,
  docIdentifier: string,
  explicitUserId?: string | null
): void {
  const cleanWsId = String(workspaceId || '').trim();
  const normId = normalizeIdentifierKey(docIdentifier);
  if (!cleanWsId || !normId) return;

  const userId = resolveCacheUserId(explicitUserId);
  const aliasKey = buildChunkScopeKey(userId, cleanWsId, normId);
  const canonicalKey = l1ChunkAliases.get(aliasKey) || aliasKey;
  l1ChunkCache.delete(canonicalKey);

  for (const [k, target] of l1ChunkAliases.entries()) {
    if (k === aliasKey || target === canonicalKey) {
      l1ChunkAliases.delete(k);
    }
  }

  const storage = getBrowserStorage();
  if (!storage) return;

  const index = readJsonIndex<ChunkLruIndexEntry>(storage, DOC_CHUNK_INDEX_KEY);
  const remaining: ChunkLruIndexEntry[] = [];
  let changed = false;
  for (const entry of index) {
    const matches =
      entry.userId === userId &&
      entry.workspaceId === cleanWsId &&
      Array.isArray(entry.aliases) &&
      entry.aliases.includes(normId);
    if (matches) {
      changed = true;
      try {
        storage.removeItem(entry.key);
      } catch {
        // Ignore
      }
    } else {
      remaining.push(entry);
    }
  }
  if (changed) {
    writeJsonIndex(storage, DOC_CHUNK_INDEX_KEY, remaining);
  }
}

// =============================================================================
// In-Flight Deduplication & Session / Sign-Out Cleanup
// =============================================================================

export function runDeduplicatedWorkspaceRequest<T>(
  channel: string,
  workspaceId: string,
  fetcher: () => Promise<T>,
  options?: { force?: boolean; userId?: string | null }
): Promise<T> {
  const cleanWsId = String(workspaceId || '').trim();
  const userId = resolveCacheUserId(options?.userId);
  const dedupKey = `${channel}::${userId}::${cleanWsId}`;

  if (!options?.force && inFlightRequests.has(dedupKey)) {
    return inFlightRequests.get(dedupKey) as Promise<T>;
  }

  const promise = Promise.resolve()
    .then(fetcher)
    .finally(() => {
      if (inFlightRequests.get(dedupKey) === promise) {
        inFlightRequests.delete(dedupKey);
      }
    });

  inFlightRequests.set(dedupKey, promise);
  return promise;
}

export function clearAllL1Cache(): void {
  l1WorkspaceCache.clear();
  l1ChunkCache.clear();
  l1ChunkAliases.clear();
  inFlightRequests.clear();
}

export function clearUserWorkspaceCache(explicitUserId?: string | null): void {
  const targetUserId = explicitUserId ? String(explicitUserId).trim() : '';
  if (!targetUserId) {
    clearAllL1Cache();
    return;
  }

  const prefix = `${targetUserId}::`;
  for (const key of l1WorkspaceCache.keys()) {
    if (key.startsWith(prefix)) l1WorkspaceCache.delete(key);
  }
  for (const key of l1ChunkCache.keys()) {
    if (key.startsWith(prefix)) l1ChunkCache.delete(key);
  }
  for (const key of l1ChunkAliases.keys()) {
    if (key.startsWith(prefix)) l1ChunkAliases.delete(key);
  }
  for (const key of inFlightRequests.keys()) {
    if (key.includes(`::${targetUserId}::`)) inFlightRequests.delete(key);
  }

  const storage = getBrowserStorage();
  if (!storage) return;

  const wsIndex = readJsonIndex<LruIndexEntry>(storage, WORKSPACE_INDEX_KEY);
  const keptWs: LruIndexEntry[] = [];
  for (const entry of wsIndex) {
    if (entry.userId === targetUserId) {
      try {
        storage.removeItem(entry.key);
      } catch {
        // Ignore
      }
    } else {
      keptWs.push(entry);
    }
  }
  writeJsonIndex(storage, WORKSPACE_INDEX_KEY, keptWs);

  const chunkIndex = readJsonIndex<ChunkLruIndexEntry>(storage, DOC_CHUNK_INDEX_KEY);
  const keptChunks: ChunkLruIndexEntry[] = [];
  for (const entry of chunkIndex) {
    if (entry.userId === targetUserId) {
      try {
        storage.removeItem(entry.key);
      } catch {
        // Ignore
      }
    } else {
      keptChunks.push(entry);
    }
  }
  writeJsonIndex(storage, DOC_CHUNK_INDEX_KEY, keptChunks);
}
