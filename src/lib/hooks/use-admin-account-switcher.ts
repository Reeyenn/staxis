'use client';

/**
 * Browser half of the admin account switcher.
 *
 * Holds three things and no authority:
 *   • whether this session is a switched one (read from the cosmetic
 *     `staxis_switch_hint` cookie — see src/lib/admin-account-switch.ts; the
 *     real credential is the httpOnly twin the browser cannot see),
 *   • the roster of demo people, fetched as the admin and cached so a switched
 *     session can still draw the menu,
 *   • the two actions, each of which ends in a full page load.
 *
 * Why a hard reload rather than letting React re-render: the session that just
 * changed underneath us is the input to every context in the shell (property
 * list, capabilities, section toggles, the queue badge). Reloading is the only
 * way to be sure nothing from the previous identity survives on screen, which
 * for a feature whose whole promise is "the app exactly as they see it" is the
 * difference between a demo and a lie.
 *
 * The roster cache is names only. It is a convenience for drawing a menu; the
 * switch endpoint recomputes who is switchable on every call, so a stale or
 * tampered cache buys nothing.
 */

import React from 'react';

import { fetchWithAuth } from '@/lib/api-fetch';
import { supabase } from '@/lib/supabase';
import { readSwitchHint } from '@/components/concourse/AccountSwitcherMenuSection';
import type { SwitchablePerson } from '@/components/concourse/AccountSwitcherMenuSection';

const ROSTER_CACHE_KEY = 'staxis.switch-roster.v1';

export interface AdminAccountSwitcher {
  /** Name of the admin to return to, when this session is switched. */
  switchedBackTo: string | null;
  people: SwitchablePerson[];
  busy: boolean;
  error: string | null;
  /** Call when the menu opens, so the roster is fresh without polling. */
  refresh(): void;
  switchTo(accountId: string): void;
  returnToAdmin(): void;
}

function readCachedRoster(): SwitchablePerson[] {
  try {
    const raw = window.localStorage.getItem(ROSTER_CACHE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is SwitchablePerson => {
      if (!entry || typeof entry !== 'object') return false;
      const row = entry as Record<string, unknown>;
      return (
        typeof row.accountId === 'string' &&
        typeof row.displayName === 'string' &&
        typeof row.roleLine === 'string'
      );
    });
  } catch {
    // Privacy-mode browsers throw on storage. The menu simply shows the way
    // back and no roster, which is honest rather than broken.
    return [];
  }
}

function writeCachedRoster(people: SwitchablePerson[]): void {
  try {
    window.localStorage.setItem(ROSTER_CACHE_KEY, JSON.stringify(people));
  } catch {
    // See above.
  }
}

async function readTokenHash(res: Response): Promise<{ tokenHash: string } | null> {
  const body = (await res.json().catch(() => null)) as
    | { ok?: boolean; data?: { tokenHash?: unknown } }
    | null;
  const tokenHash = body?.ok ? body.data?.tokenHash : undefined;
  return typeof tokenHash === 'string' && tokenHash.length > 0 ? { tokenHash } : null;
}

/** Seconds of headroom before we refresh rather than send a nearly-dead token. */
const TOKEN_FRESHNESS_BUFFER_SEC = 30;

/**
 * A usable access token for the session this browser is in, or null.
 *
 * The way-back endpoint now identifies its caller, and the bearer header is
 * how it does that: `requireSession` only falls back to the auth cookies when
 * there is NO header at all, so sending a stale one would be worse than
 * sending none. Refresh first when the token is at or near expiry, and hand
 * back null if that fails so the cookie fallback still gets its chance.
 */
async function currentAccessToken(): Promise<string | null> {
  try {
    const { data } = await supabase.auth.getSession();
    const session = data.session;
    if (!session) return null;
    const expiresAt = typeof session.expires_at === 'number' ? session.expires_at : 0;
    if (expiresAt - TOKEN_FRESHNESS_BUFFER_SEC > Math.floor(Date.now() / 1000)) {
      return session.access_token;
    }
    const refreshed = await supabase.auth.refreshSession();
    return refreshed.data.session?.access_token ?? null;
  } catch {
    return null;
  }
}

/** Redeem a one-time login token; the browser session becomes that person. */
async function adoptSession(tokenHash: string): Promise<boolean> {
  const { data, error } = await supabase.auth.verifyOtp({
    token_hash: tokenHash,
    type: 'magiclink',
  });
  return !error && !!data.session;
}

export function useAdminAccountSwitcher(isPlatformAdmin: boolean): AdminAccountSwitcher {
  const [switchedBackTo, setSwitchedBackTo] = React.useState<string | null>(null);
  const [people, setPeople] = React.useState<SwitchablePerson[]>([]);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  // Cookie + cache are read after mount so server and client markup agree.
  React.useEffect(() => {
    setSwitchedBackTo(readSwitchHint(document.cookie));
    setPeople(readCachedRoster());
  }, []);

  const loadRoster = React.useCallback(async () => {
    if (!isPlatformAdmin) return;
    try {
      const res = await fetchWithAuth('/api/admin/account-switch');
      const body = (await res.json().catch(() => null)) as
        | { ok?: boolean; data?: { accounts?: unknown } }
        | null;
      const accounts = body?.ok ? body.data?.accounts : undefined;
      if (!Array.isArray(accounts)) return;
      const next = accounts.filter((entry): entry is SwitchablePerson => {
        if (!entry || typeof entry !== 'object') return false;
        const row = entry as Record<string, unknown>;
        return (
          typeof row.accountId === 'string' &&
          typeof row.displayName === 'string' &&
          typeof row.roleLine === 'string'
        );
      });
      setPeople(next);
      writeCachedRoster(next);
    } catch {
      // Keep whatever the menu already had. A failed read is not "nobody".
    }
  }, [isPlatformAdmin]);

  const refresh = React.useCallback(() => {
    setSwitchedBackTo(readSwitchHint(document.cookie));
    void loadRoster();
  }, [loadRoster]);

  /**
   * Redeem the return cookie. Resolves to true when we are the admin again.
   *
   * The access token goes on deliberately: the server now refuses a return that
   * is not presented by the demo session the switch created, so it has to be
   * able to see who is asking. Plain `fetch` rather than fetchWithAuth because
   * a legitimate refusal here (an expired way back) must leave the demo session
   * alone and show "please sign in again" — not trip the shared 401 recovery
   * path and force-sign-out a session that is perfectly valid.
   */
  const redeemReturn = React.useCallback(async (): Promise<boolean> => {
    const accessToken = await currentAccessToken();
    const res = await fetch('/api/auth/admin-switch-return', {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      },
    });
    const payload = await readTokenHash(res);
    if (!payload) return false;
    return adoptSession(payload.tokenHash);
  }, []);

  const returnToAdmin = React.useCallback(() => {
    if (busy) return;
    setBusy(true);
    setError(null);
    void (async () => {
      const restored = await redeemReturn();
      if (!restored) {
        setBusy(false);
        setError('Could not get back to your own account. Please sign in again.');
        return;
      }
      window.location.assign('/home');
    })();
  }, [busy, redeemReturn]);

  const switchTo = React.useCallback(
    (accountId: string) => {
      if (busy) return;
      setBusy(true);
      setError(null);
      void (async () => {
        // Hopping straight from one demo person to the next: the switch
        // endpoint only ever accepts a verified platform admin, so become the
        // admin again first. Each leg is independently gated on the server;
        // a failure here simply leaves the admin signed in as themselves.
        if (switchedBackTo) {
          const restored = await redeemReturn();
          if (!restored) {
            setBusy(false);
            setError('Could not get back to your own account. Please sign in again.');
            return;
          }
        }

        const res = await fetchWithAuth('/api/admin/account-switch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ accountId }),
        });
        const payload = await readTokenHash(res);
        if (!payload || !(await adoptSession(payload.tokenHash))) {
          setBusy(false);
          setError('Could not switch to that account.');
          // We may now be the admin again (the hop's first leg succeeded), so
          // reload rather than leaving the shell rendering a stale identity.
          if (switchedBackTo) window.location.assign('/home');
          return;
        }
        window.location.assign('/home');
      })();
    },
    [busy, redeemReturn, switchedBackTo],
  );

  return { switchedBackTo, people, busy, error, refresh, switchTo, returnToAdmin };
}
