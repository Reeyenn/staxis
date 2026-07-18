/**
 * Offline action queue — IndexedDB-backed, browser-only.
 *
 * Stores mutating actions the housekeeper takes while offline so a
 * subsequent online event can replay them in order against the original
 * endpoint. Idempotency is enforced server-side via the offline_action_replays
 * table; every queued mutation carries a client-generated UUID action_id
 * that the server checks before applying the side effect.
 *
 * No service worker / Workbox dependency for the queue itself — IndexedDB
 * + the window 'online' event is enough for the housekeeper page (which
 * is a single tab on a phone). The companion service worker (public/sw.js
 * extended) handles cache-of-page-shell only; replay happens in the
 * page itself.
 *
 * Public surface:
 *   - enqueueAction(action): persist a queued mutation
 *   - drainQueue(onProgress): try to replay every queued action in order
 *   - getQueueLength(): for the banner UI
 *   - clearQueue(): unit-test escape hatch
 *
 * Failure model: a queued action that returns 2xx → remove from queue.
 *   - 4xx other than 429 (client-side, won't succeed on retry) → mark as
 *     failed in local state, leave in queue with `lastError`. The next online
 *     drain will skip it (so we don't loop on 400/422/etc.).
 *   - 429 (rate limited) → leave retryable and stop this drain. A later
 *     drain can replay it after the server-side window resets.
 *   - 5xx / network error → leave in queue, exponential backoff.
 */

export interface QueuedAction {
  /** UUID — also sent in the action body as `actionId` for server dedup. */
  id: string;
  endpoint: string; // e.g. '/api/housekeeper/start-clean'
  method: 'POST';
  body: Record<string, unknown>;
  enqueuedAt: number;
  /** Display label used in the offline banner. EN — the banner shows a
   *  count, not the labels themselves, so this stays in English. */
  label: string;
  /** Retry bookkeeping. */
  attempts: number;
  lastError: string | null;
  /** Set true when the server returned a 4xx we know won't succeed on
   *  retry; the drain loop skips these and they sit in the queue until a
   *  manual user action clears them. */
  permanentFailure: boolean;
}

const DB_NAME = 'staxis-offline-queue';
const DB_VERSION = 1;
const STORE = 'actions';

function isBrowser(): boolean {
  return typeof window !== 'undefined' && typeof indexedDB !== 'undefined';
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (!isBrowser()) {
      reject(new Error('IndexedDB only available in the browser'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'id' });
        store.createIndex('by_enqueuedAt', 'enqueuedAt', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'));
  });
}

async function withStore<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => Promise<T> | T,
): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const store = tx.objectStore(STORE);
      Promise.resolve(fn(store))
        .then((value) => {
          tx.oncomplete = () => resolve(value);
          tx.onerror = () => reject(tx.error ?? new Error('IndexedDB tx error'));
          tx.onabort = () => reject(tx.error ?? new Error('IndexedDB tx aborted'));
        })
        .catch(reject);
    });
  } finally {
    db.close();
  }
}

export function generateOfflineActionId(
  randomUuid: (() => string) | null | undefined = undefined,
): string {
  const nativeUuid = randomUuid === undefined
    ? (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID.bind(crypto)
        : null)
    : randomUuid;
  if (nativeUuid) {
    return nativeUuid();
  }
  // RFC4122 v4-ish fallback for ancient browsers; the housekeeper phones
  // we target all support crypto.randomUUID, so this is belt-and-braces.
  const hex = '0123456789abcdef';
  let out = '';
  for (let i = 0; i < 36; i += 1) {
    if (i === 8 || i === 13 || i === 18 || i === 23) out += '-';
    else if (i === 14) out += '4';
    else if (i === 19) out += hex[(Math.random() * 4) | 8];
    else out += hex[(Math.random() * 16) | 0];
  }
  return out;
}

export interface EnqueueInput {
  endpoint: string;
  body: Record<string, unknown>;
  label: string;
  /** Caller may supply an id; if omitted we mint one. The mutation body
   *  will carry this as `actionId` for server-side dedup. */
  id?: string;
}

export async function enqueueAction(input: EnqueueInput): Promise<QueuedAction> {
  const id = input.id ?? generateOfflineActionId();
  const action: QueuedAction = {
    id,
    endpoint: input.endpoint,
    method: 'POST',
    body: { ...input.body, actionId: id },
    enqueuedAt: Date.now(),
    label: input.label,
    attempts: 0,
    lastError: null,
    permanentFailure: false,
  };

  if (!isBrowser()) {
    return action;
  }
  await withStore('readwrite', (store) => {
    store.put(action);
  });
  return action;
}

export async function getQueueLength(): Promise<number> {
  if (!isBrowser()) return 0;
  return withStore('readonly', (store) => {
    return new Promise<number>((resolve, reject) => {
      const req = store.count();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  });
}

export async function getQueueItems(): Promise<QueuedAction[]> {
  if (!isBrowser()) return [];
  return withStore('readonly', (store) => {
    return new Promise<QueuedAction[]>((resolve, reject) => {
      const req = store.getAll();
      req.onsuccess = () => {
        const items = (req.result as QueuedAction[]) ?? [];
        items.sort((a, b) => a.enqueuedAt - b.enqueuedAt);
        resolve(items);
      };
      req.onerror = () => reject(req.error);
    });
  });
}

async function removeAction(id: string): Promise<void> {
  await withStore('readwrite', (store) => {
    store.delete(id);
  });
}

async function updateAction(action: QueuedAction): Promise<void> {
  await withStore('readwrite', (store) => {
    store.put(action);
  });
}

export async function clearQueue(): Promise<void> {
  if (!isBrowser()) return;
  await withStore('readwrite', (store) => {
    store.clear();
  });
}

export interface DrainProgress {
  total: number;
  done: number;
  failed: number;
  pending: number;
  /** Suggested delay before retrying a transiently blocked queue. */
  retryAfterMs: number | null;
}

export interface DrainOptions {
  onProgress?: (p: DrainProgress) => void;
  /** Maximum attempts per action before marking permanent failure. */
  maxAttempts?: number;
  /** Fetch implementation — defaults to global `fetch`. Tests can stub. */
  fetchImpl?: typeof fetch;
}

const MAX_RETRY_DELAY_MS = 5 * 60 * 1000;

function retryBackoffMs(attempts: number): number {
  return Math.min(MAX_RETRY_DELAY_MS, 1000 * (2 ** Math.min(Math.max(attempts - 1, 0), 8)));
}

function retryAfterHeaderMs(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(MAX_RETRY_DELAY_MS, Math.ceil(seconds * 1000));
  }
  const at = Date.parse(value);
  if (Number.isNaN(at)) return null;
  return Math.min(MAX_RETRY_DELAY_MS, Math.max(0, at - Date.now()));
}

/**
 * Replay every queued action serially. Stops early if a network error
 * suggests we're offline again (so we don't burn through retries in a
 * brief connectivity blip).
 */
export async function drainQueue(opts: DrainOptions = {}): Promise<DrainProgress> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const maxAttempts = opts.maxAttempts ?? 5;
  const items = await getQueueItems();
  const eligible = items.filter((a) => !a.permanentFailure);
  let done = 0;
  let failed = 0;
  let retryAfterMs: number | null = null;

  // Compute initial progress so the caller can render a counter.
  const emit = () => {
    opts.onProgress?.({
      total: eligible.length,
      done,
      failed,
      pending: eligible.length - done - failed,
      retryAfterMs,
    });
  };
  emit();

  for (const action of eligible) {
    try {
      const res = await fetchImpl(action.endpoint, {
        method: action.method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(action.body),
      });
      if (res.ok) {
        await removeAction(action.id);
        done += 1;
        emit();
        continue;
      }
      // 429 is explicitly retryable. Do not consume the permanent-failure
      // budget: a busy server-side rate-limit window says nothing about
      // whether this action is valid, even after several attempts.
      if (res.status === 429) {
        const attempts = action.attempts + 1;
        const updated: QueuedAction = {
          ...action,
          attempts,
          lastError: 'http 429',
          permanentFailure: false,
        };
        await updateAction(updated);
        retryAfterMs = Math.max(
          retryBackoffMs(attempts),
          retryAfterHeaderMs(res.headers.get('retry-after')) ?? 0,
        );
        emit();
        // Preserve ordering and avoid hammering the same rate-limit window.
        break;
      }
      // Other 4xx responses won't succeed on retry. Mark permanent failure.
      if (res.status >= 400 && res.status < 500) {
        const updated: QueuedAction = {
          ...action,
          attempts: action.attempts + 1,
          lastError: `http ${res.status}`,
          permanentFailure: true,
        };
        await updateAction(updated);
        failed += 1;
        emit();
        continue;
      }
      // A server-supplied Retry-After explicitly marks a 503 as transient.
      // This includes an idempotency claim that is still being completed.
      // Keep it retryable and back off instead of turning it permanent after
      // five rapid drains.
      if (res.status === 503 && res.headers.has('retry-after')) {
        const attempts = action.attempts + 1;
        const updated: QueuedAction = {
          ...action,
          attempts,
          lastError: 'http 503',
          permanentFailure: false,
        };
        await updateAction(updated);
        retryAfterMs = Math.max(
          retryBackoffMs(attempts),
          retryAfterHeaderMs(res.headers.get('retry-after')) ?? 0,
        );
        emit();
        break;
      }
      // 5xx / unexpected — leave queued, bump attempts.
      const updated: QueuedAction = {
        ...action,
        attempts: action.attempts + 1,
        lastError: `http ${res.status}`,
        permanentFailure: action.attempts + 1 >= maxAttempts,
      };
      await updateAction(updated);
      if (updated.permanentFailure) failed += 1;
      else retryAfterMs = retryBackoffMs(updated.attempts);
      emit();
      // If we've started failing on 5xx we might be flaky — bail out and
      // let the next online tick try again.
      break;
    } catch (caughtErr) {
      // Network error — almost certainly we're offline again. Bail.
      const updated: QueuedAction = {
        ...action,
        attempts: action.attempts + 1,
        lastError: caughtErr instanceof Error ? caughtErr.message : String(caughtErr),
        permanentFailure: action.attempts + 1 >= maxAttempts,
      };
      await updateAction(updated);
      if (updated.permanentFailure) failed += 1;
      else retryAfterMs = retryBackoffMs(updated.attempts);
      emit();
      break;
    }
  }

  return {
    total: eligible.length,
    done,
    failed,
    pending: eligible.length - done - failed,
    retryAfterMs,
  };
}

/** Drop permanent-failure entries so the user can dismiss them. */
export async function clearFailures(): Promise<number> {
  const items = await getQueueItems();
  const failures = items.filter((a) => a.permanentFailure);
  for (const a of failures) await removeAction(a.id);
  return failures.length;
}
