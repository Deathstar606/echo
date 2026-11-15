import {
  fetchBusinessSheets,
  fetchWorkspaceDocuments,
  getSyncedGoogleSheetsApi,
} from './api';
import {
  getCachedWorkspaceContext,
  runDeduplicatedWorkspaceRequest,
  setCachedWorkspaceDocuments,
  setCachedWorkspaceSyncedSheets,
  setCachedWorkspaceTables,
} from './workspaceContextCache';
import { loadBusinessSheets } from '../store/sheetSlice';

export interface PrefetchWorkspaceOptions {
  dispatch?: (action: any) => any;
  userId?: string | null;
  force?: boolean;
}

/**
 * Warms L1 in-memory and L2 localStorage caches for a workspace's tables, documents,
 * and synced Google Sheet metadata using shared in-flight request deduplication.
 * Safe to invoke while another workspace is active without disturbing visible UI state.
 */
export async function prefetchWorkspaceContext(
  workspaceId: string,
  options: PrefetchWorkspaceOptions = {}
): Promise<void> {
  const cleanWsId = String(workspaceId || '').trim();
  if (!cleanWsId) return;

  const userId = options.userId ?? null;
  const cached = !options.force ? getCachedWorkspaceContext(cleanWsId, userId) : null;
  const tasks: Promise<unknown>[] = [];

  if (!cached?.freshness?.tablesFresh) {
    if (options.dispatch) {
      tasks.push(
        Promise.resolve(
          options.dispatch(
            loadBusinessSheets({
              businessId: cleanWsId,
              silent: true,
              forceRefresh: Boolean(options.force),
            })
          )
        ).catch(() => null)
      );
    } else {
      tasks.push(
        runDeduplicatedWorkspaceRequest(
          'businessSheets',
          cleanWsId,
          () => fetchBusinessSheets(cleanWsId),
          { userId, force: options.force }
        )
          .then((data) => {
            const tables = Array.isArray(data?.tables) ? data.tables : [];
            setCachedWorkspaceTables(
              data?.business_id || cleanWsId,
              { tables },
              userId
            );
          })
          .catch(() => null)
      );
    }
  }

  if (!cached?.freshness?.documentsFresh) {
    tasks.push(
      runDeduplicatedWorkspaceRequest(
        'documents',
        cleanWsId,
        () => fetchWorkspaceDocuments(cleanWsId),
        { userId, force: options.force }
      )
        .then((res) => {
          if (Array.isArray(res?.documents)) {
            setCachedWorkspaceDocuments(cleanWsId, res.documents, userId);
          }
        })
        .catch(() => null)
    );
  }

  if (!cached?.freshness?.syncedSheetsFresh) {
    tasks.push(
      runDeduplicatedWorkspaceRequest(
        'syncedSheets',
        cleanWsId,
        () => getSyncedGoogleSheetsApi(cleanWsId),
        { userId, force: options.force }
      )
        .then((sheets) => {
          if (Array.isArray(sheets)) {
            setCachedWorkspaceSyncedSheets(cleanWsId, sheets, userId);
          }
        })
        .catch(() => null)
    );
  }

  if (tasks.length > 0) {
    await Promise.all(tasks);
  }
}
