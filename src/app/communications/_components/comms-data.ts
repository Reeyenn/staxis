'use client';
// ═══════════════════════════════════════════════════════════════════════════
// Communications · data adapter — useCommsResource (F2 for this tab).
//
// Every read still goes through @/lib/comms/client's apiGet (Supabase bearer
// token + default same-origin cookies, silent failure on auth errors) — NOT
// fetchWithAuth, whose token preflight / 401 auto-recovery / signout redirect
// would change this tab's behavior. The foundation hook supplies the rest:
// stale-response gating, poll hygiene (document.hidden + in-flight skip),
// keepDataOnError.
//
// useApiResource only re-fetches by itself on STRING-source URL changes, and
// string sources are hard-wired to fetchWithAuth — so comms sources are
// functions, and this wrapper watches the url/key and triggers a silent
// reload() when it changes. That reproduces the area's historical
// param-change behavior exactly: last-good data stays on screen until the new
// response lands (the old hand-rolled code only setState'd on success), and
// the request gate drops any in-flight response for the old params.
// ═══════════════════════════════════════════════════════════════════════════
import React from 'react';
import { useApiResource, type UseApiResourceResult } from '@/lib/hooks/use-api-resource';
import type { EnvelopeResult } from '@/lib/api-envelope';
import { apiGet } from '@/lib/comms/client';

/** Multi-request reads (e.g. documents + folders) pass a keyed fetcher; the
 *  key plays the URL's role for change-triggered reloads. */
export interface CommsSource<T> {
  key: string;
  fetch: () => Promise<EnvelopeResult<T>>;
}

export interface CommsResourceOptions {
  /** Poll cadence in ms — ticks skip while document.hidden (and while a
   *  request is in flight), same gating the hand-rolled intervals had. */
  pollMs?: number;
  /** Keep last-good data through a failed refetch (the `if (r.ok) set(...)`
   *  pattern). Default false = an error blanks data (the `else set([])`
   *  pattern once mapped through `loading`). */
  keepDataOnError?: boolean;
  enabled?: boolean;
}

async function envelopeGet<T>(url: string): Promise<EnvelopeResult<T>> {
  const r = await apiGet<T>(url);
  return r.ok && r.data !== undefined
    ? { data: r.data }
    : { error: r.error ?? `Failed (${r.status})` };
}

export function useCommsResource<T>(
  source: string | CommsSource<T>,
  opts: CommsResourceOptions = {},
): UseApiResourceResult<T> {
  const srcRef = React.useRef(source);
  srcRef.current = source;
  const fetcher = React.useCallback((): Promise<EnvelopeResult<T>> => {
    const s = srcRef.current;
    return typeof s === 'string' ? envelopeGet<T>(s) : s.fetch();
  }, []);

  const res = useApiResource<T>(fetcher, opts);

  // Param change (pid, conversationId, …) → silent refetch. Skips the mount
  // render — the hook's own identity effect already fired the initial load.
  // Also skips enabled flips: the foundation treats enabled=false→true as a
  // fresh identity and fires the initial load itself, so a key change that
  // rides the same render (pid null→value flips `enabled` AND the URL) must
  // not add a second, duplicate request.
  const key = typeof source === 'string' ? source : source.key;
  const enabled = opts.enabled ?? true;
  const firstRef = React.useRef(true);
  const { reload } = res;
  React.useEffect(() => {
    if (!enabled) {
      // Foundation cleared state on disable; re-enabling counts as a fresh
      // first identity whose load the foundation fires — mirror its
      // hadIdentityRef reset so we don't double it.
      firstRef.current = true;
      return;
    }
    if (firstRef.current) { firstRef.current = false; return; }
    void reload();
  }, [key, enabled, reload]);

  return res;
}
