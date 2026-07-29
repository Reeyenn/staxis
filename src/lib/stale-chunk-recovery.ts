const STALE_CHUNK_PATTERN = /chunkloaderror|loading (?:css )?chunk [\w-]+ failed|failed to fetch dynamically imported module|error loading dynamically imported module|failed to load module script|importing a module script failed|module script.*mime type/i;

export const STALE_CHUNK_RECOVERY_PARAM = '__staxis_chunk_recovery';
export const LEGACY_WORKER_RECOVERY_PARAM = '__staxis_worker_recovery';
export const STALE_CHUNK_RECOVERY_GUARD_KEY = 'staxis-chunk-recovery:active-incident';

/**
 * A route shell that stays mounted for this long without a stale-chunk error
 * is considered a healthy boot. The active-incident guard can then be cleared
 * so a genuinely later deployment incident gets its own one-shot recovery.
 */
export const STALE_CHUNK_STABLE_BOOT_MS = 15_000;

const STALE_CHUNK_FAILED_BOOT_FLAG = '__staxisStaleChunkFailureSeenThisBoot';

type StaleChunkGlobal = typeof globalThis & {
  __NEXT_DATA__?: { buildId?: unknown };
  __staxisStaleChunkFailureSeenThisBoot?: boolean;
};

interface RecoveryLocation {
  href: string;
  reload: () => void;
  replace: (url: string) => void;
}

interface ReloadOnceOptions {
  key: string;
  /**
   * Optional shared guard for a whole recovery incident. When provided, any
   * existing value blocks another automatic reload, even if the next error's
   * fingerprint differs after the document navigation.
   */
  guardKey?: string;
  fallbackParam: string;
  getSessionStorage: () => Pick<Storage, 'getItem' | 'setItem'>;
  location: RecoveryLocation;
}

interface ClearStaleChunkRecoveryOptions {
  getSessionStorage: () => Pick<Storage, 'removeItem'>;
  location: Pick<RecoveryLocation, 'href'>;
  replaceHistoryUrl: (url: string) => void;
}

/**
 * Hard-reload at most once for a recovery key.
 *
 * sessionStorage is the normal one-shot guard, but browsers can throw while
 * merely reading the property (privacy policy, sandboxed embeds, disabled
 * storage). In that case a URL marker survives the hard navigation and keeps a
 * still-broken deployment from entering an automatic reload loop. The marker
 * is only a fallback; normal browsers keep their original URL.
 */
export function reloadOnceWithSessionGuard({
  key,
  guardKey,
  fallbackParam,
  getSessionStorage,
  location,
}: ReloadOnceOptions): boolean {
  try {
    const storage = getSessionStorage();
    const storageKey = guardKey ?? key;
    const previous = storage.getItem(storageKey);
    if (guardKey ? previous !== null : previous === '1') return false;
    storage.setItem(storageKey, guardKey ? key : '1');
    location.reload();
    return true;
  } catch {
    const url = new URL(location.href);
    // A shared guard means any fallback marker belongs to the still-active
    // recovery incident. Do not loop merely because a new document reports a
    // slightly different digest, build id, or chunk URL.
    if (
      guardKey
        ? url.searchParams.has(fallbackParam)
        : url.searchParams.get(fallbackParam) === key
    ) return false;
    url.searchParams.set(fallbackParam, key);
    location.replace(url.toString());
    return true;
  }
}

/** Mark this document as an unsuccessful boot before attempting recovery. */
export function markStaleChunkFailureThisBoot(): void {
  (globalThis as StaleChunkGlobal)[STALE_CHUNK_FAILED_BOOT_FLAG] = true;
}

/** Used by the stable-shell cleanup to avoid clearing a still-needed guard. */
export function staleChunkFailureSeenThisBoot(): boolean {
  return (globalThis as StaleChunkGlobal)[STALE_CHUNK_FAILED_BOOT_FLAG] === true;
}

/**
 * Retire the active-incident marker after a confirmed healthy route shell.
 * Storage cleanup and URL cleanup are independent: Safari/privacy policies can
 * block sessionStorage while still allowing history.replaceState, and neither
 * failure should make a healthy page crash.
 */
export function clearStaleChunkRecoveryIncident({
  getSessionStorage,
  location,
  replaceHistoryUrl,
}: ClearStaleChunkRecoveryOptions): void {
  try {
    getSessionStorage().removeItem(STALE_CHUNK_RECOVERY_GUARD_KEY);
  } catch {
    // The URL fallback below remains available when storage is blocked.
  }

  try {
    const url = new URL(location.href);
    if (!url.searchParams.has(STALE_CHUNK_RECOVERY_PARAM)) return;
    url.searchParams.delete(STALE_CHUNK_RECOVERY_PARAM);
    replaceHistoryUrl(url.toString());
  } catch {
    // Conservatively leave the marker in place if URL history is unavailable.
  }
}

export function isStaleDeploymentChunkError(error: unknown): boolean {
  if (!error) return false;
  const value = error as { name?: unknown; message?: unknown; digest?: unknown };
  return STALE_CHUNK_PATTERN.test([
    value.name,
    value.message,
    value.digest,
  ].filter((part) => typeof part === 'string').join(' '));
}

/** Best-effort deployment identity. App Router does not guarantee __NEXT_DATA__. */
export function currentStaleChunkBuildIdentity(): string | null {
  try {
    const scope = globalThis as StaleChunkGlobal;
    const buildId = scope.__NEXT_DATA__?.buildId;
    if (typeof buildId === 'string' && buildId.trim()) {
      return `next-build:${buildId.trim().slice(0, 160)}`;
    }

    // Hashed Next asset names are deployment-relevant even when the runtime
    // does not expose a build id. Use one already-loaded asset, never fetch.
    const script = scope.document?.querySelector('script[src*="/_next/static/"]');
    const src = script?.getAttribute('src');
    return typeof src === 'string' && src ? `next-asset:${src.slice(0, 512)}` : null;
  } catch {
    return null;
  }
}

function errorTextPart(
  error: unknown,
  field: 'name' | 'message' | 'digest' | 'stack' | 'request',
): string {
  if (!error || typeof error !== 'object' || !(field in error)) return '';
  const value = (error as Record<string, unknown>)[field];
  return typeof value === 'string' ? value : '';
}

function staleChunkAssetReference(error: unknown): string {
  const source = [
    errorTextPart(error, 'message'),
    errorTextPart(error, 'stack'),
    errorTextPart(error, 'request'),
  ].join(' ');
  return source.match(/(?:https?:\/\/[^\s)"']+)?\/_next\/static\/[^\s)"']+/i)?.[0]?.slice(0, 512) ?? '';
}

export function staleChunkRecoveryKey(
  pathname: string,
  error: unknown,
  buildIdentity: string | null = currentStaleChunkBuildIdentity(),
): string {
  const primitiveMessage = error && typeof error === 'object' ? '' : String(error ?? '');
  const fingerprint = [
    errorTextPart(error, 'name'),
    errorTextPart(error, 'message') || primitiveMessage,
    errorTextPart(error, 'digest'),
    staleChunkAssetReference(error),
    buildIdentity ?? '',
  ].join('\u001f');
  // A compact deterministic hash keeps the storage key bounded while allowing
  // later incidents with different error/build metadata one fresh retry after
  // the previous incident reaches a confirmed stable boot.
  let hash = 0;
  for (let index = 0; index < fingerprint.length; index += 1) {
    hash = ((hash << 5) - hash + fingerprint.charCodeAt(index)) | 0;
  }
  return `staxis-chunk-recovery:${pathname}:${hash}`;
}
