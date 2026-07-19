// Server-side admin guard. Wraps every page under /admin/*.
//
// Why this exists: the pages under /admin (agent, pms, ml, properties) are
// all 'use client' components that call useAuth() / useEffect to gate
// themselves on role='admin'. That's a CLIENT check — Next.js still
// renders + ships the page HTML, the gate only short-circuits the data
// fetch. A signed-out user typing /admin/agent gets bounced by the edge
// middleware (no auth cookie → 302 to /signin). But a signed-in NON-admin
// staff member, or anyone with a stale/invalid cookie, would see the
// page shell flash before the client check kicks in.
//
// This server component runs ON THE SERVER before any /admin/* page is
// rendered. It validates the Supabase session against the actual user
// row (not just cookie presence) and confirms accounts.role='admin'.
// Non-admins are redirected before HTML ever ships. The underlying
// 'use client' pages are unchanged — they keep their useAuth gate as a
// defense-in-depth layer (useful during the brief window between
// signOut and next navigation).
//
// Performance: adds one Supabase Auth round-trip + one accounts row read
// per admin page render. Admin pages are low-traffic (Reeyen-only in
// practice) so the cost is acceptable.
//
// Added 2026-05-22 in the auth/2FA audit (finding H1).
//
// @audit: tenant-scope-not-applicable — this is a server-side admin gate
// that runs BEFORE any per-tenant query. supabaseAdmin is used here
// (bypasses RLS) precisely so the role+trusted_devices check stays
// independent of RLS drift on the accounts/trusted_devices tables. A
// failure to read role here MUST fail closed (redirect to /) regardless
// of whether the requesting user could read their own row via RLS.

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { createSupabaseServerClient } from '@/lib/supabase-server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { log } from '@/lib/log';
import { hashDeviceToken, TRUST_COOKIE_NAME } from '@/lib/trusted-device';
import { isTwoFactorEnabled } from '@/lib/two-factor';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Validate the user against Supabase Auth — not just cookie presence.
  // getUser() round-trips to Supabase and returns the canonical user row,
  // or null if the session is invalid/expired.
  const supabase = await createSupabaseServerClient();
  const { data: { user }, error: userErr } = await supabase.auth.getUser();

  if (userErr || !user) {
    // No valid session → bounce to sign-in. Preserve redirect target so
    // the user lands back on /admin after they re-auth.
    redirect('/signin?redirect=%2Fadmin');
  }

  // Role check via the service-role client (bypasses RLS so we can read
  // any account's role directly). The anon client would also work here
  // via the self-select RLS policy, but using supabaseAdmin keeps this
  // gate independent of RLS drift on the accounts table.
  const { data: account, error: acctErr } = await supabaseAdmin
    .from('accounts')
    .select('id, role, active')
    .eq('data_user_id', user.id)
    .maybeSingle();

  if (acctErr) {
    // DB error — fail closed. Log loudly so this surfaces in Sentry; a
    // non-admin getting through here on a transient DB hiccup would be a
    // privilege-escalation bug.
    log.error('[admin/layout] accounts lookup failed — failing closed', {
      userId: user.id,
      err: acctErr.message,
    });
    redirect('/');
  }

  if (!account || (account.role as string) !== 'admin' || account.active !== true) {
    // Signed in but not an admin. Redirect to the marketing root so they
    // can navigate to their normal dashboard. We don't render a 403 page
    // because there's no legitimate path for a non-admin user to reach
    // /admin/* — the link only appears in the admin nav.
    redirect('/');
  }

  // Audit 2026-05-22 (Codex review finding #4): role check alone is not
  // enough — a stolen admin password gives the attacker a valid Supabase
  // session (passes the getUser check above) and they happen to have
  // role='admin' (because they're using Reeyen's account). They'd then
  // see the admin HTML shell + any RSC-rendered content before any API
  // call gets blocked by Phase 1's requireSession device-trust gate.
  //
  // Close the shell-leak gap by enforcing the same device-trust check
  // here as requireSession does for API routes: the staxis_device cookie
  // must match a non-expired trusted_devices row for THIS account.
  //
  // Global human-2FA switch (migration 0310): the device-trust block below
  // is 2FA enforcement, so it runs only while the switch is ON. The
  // getUser() session check and the role='admin' check above are
  // authentication + authorization and ALWAYS run regardless of the
  // switch. Fail-safe: isTwoFactorEnabled() returns true on any error, so
  // a DB hiccup means the block runs — today's behavior, never an open
  // gate.
  if (await isTwoFactorEnabled()) {
    const cookieStore = await cookies();
    const deviceCookieValue = cookieStore.get(TRUST_COOKIE_NAME)?.value ?? null;
    let hasValidDeviceTrust = false;

    if (deviceCookieValue) {
      const tokenHash = hashDeviceToken(deviceCookieValue);
      const { data: deviceRow, error: deviceErr } = await supabaseAdmin
        .from('trusted_devices')
        .select('id, expires_at, absolute_expires_at')
        .eq('account_id', account.id)
        .eq('token_hash', tokenHash)
        .maybeSingle();
      if (deviceErr) {
        log.error('[admin/layout] trusted_devices lookup failed — failing closed', {
          userId: user.id,
          accountId: account.id,
          err: deviceErr.message,
        });
        redirect('/signin?reason=2fa_required&redirect=%2Fadmin');
      }
      if (deviceRow) {
        const now = Date.now();
        const expires = new Date(deviceRow.expires_at).getTime();
        const absExpRaw = (deviceRow as { absolute_expires_at?: string | null })
          .absolute_expires_at;
        const absExpires = absExpRaw ? new Date(absExpRaw).getTime() : 0;
        if (expires > now && absExpires > now) {
          hasValidDeviceTrust = true;
        }
      }
    }

    if (!hasValidDeviceTrust) {
      // Admin signed in but device not trusted → could be a fresh stolen-
      // password sign-in via curl. Bounce to /signin?reason=2fa_required
      // so the user re-OTPs. Same posture as Phase 1's requires_2fa for
      // /api/* routes.
      log.warn('[admin/layout] admin without device trust — bouncing', {
        userId: user.id,
        accountId: account.id,
      });
      redirect('/signin?reason=2fa_required&redirect=%2Fadmin');
    }
  }

  return <>{children}</>;
}
