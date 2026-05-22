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

import { redirect } from 'next/navigation';
import { createSupabaseServerClient } from '@/lib/supabase-server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { log } from '@/lib/log';

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
    .select('role')
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

  if (!account || (account.role as string) !== 'admin') {
    // Signed in but not an admin. Redirect to the marketing root so they
    // can navigate to their normal dashboard. We don't render a 403 page
    // because there's no legitimate path for a non-admin user to reach
    // /admin/* — the link only appears in the admin nav.
    redirect('/');
  }

  return <>{children}</>;
}
