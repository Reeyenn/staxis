/**
 * Resolve the recipient list for a given property + report type.
 *
 * Recipients = active accounts at the property whose role is
 * 'general_manager' or 'owner', PLUS any CC emails on their
 * report_preferences row. Accounts with paused_until > now are skipped.
 *
 * For the weekly cron, weekly_enabled=false on a recipient's
 * preferences row also skips them (lets a GM opt out of Sundays).
 *
 * The recipient resolver is intentionally a pure DB query — the cron
 * route wraps it with logging + writes into report_runs. Keeping the
 * lookup in its own module makes it trivially testable: pump in
 * fixtures, assert the de-duplicated address list.
 */

import { supabaseAdmin } from '@/lib/supabase-admin';
import { log } from '@/lib/log';
import { isValidEmail } from '@/lib/api-validate';

export interface ResolvedRecipient {
  email: string;
  /** account_id when this email belongs to a Staxis account; null for CC-only. */
  accountId: string | null;
  role: 'gm' | 'owner' | 'cc';
  channel: 'email' | 'sms';
  /** Property-local timezone. Inherited from the property; useful for the
   *  email date line and any SMS body that includes a time. */
  timezone: string;
  /** Language preference. Defaults to 'en' if account has no preference. */
  lang: 'en' | 'es';
}

export interface ResolveRecipientsArgs {
  propertyId: string;
  /** 'daily' or 'weekly' — weekly respects weekly_enabled=false. */
  reportType: 'daily' | 'weekly';
  /** Current time used for the paused_until check. Pass a fixed time
   *  from the caller so test fixtures stay deterministic. */
  now?: Date;
}

interface AccountRow {
  id: string;
  role: string;
  active: boolean;
  data_user_id: string;
  property_access: string[] | null;
}

interface PrefRow {
  account_id: string;
  channels: { email?: boolean; sms?: boolean } | null;
  cc_emails: string[] | null;
  paused_until: string | null;
  weekly_enabled: boolean | null;
}

/** Strip duplicates + lowercase. Resends the same email even if two
 *  manager accounts use the same address (rare but happens — owner-GM
 *  same person). */
function dedupe(rs: ResolvedRecipient[]): ResolvedRecipient[] {
  const seen = new Map<string, ResolvedRecipient>();
  for (const r of rs) {
    const key = r.email.trim().toLowerCase();
    if (!seen.has(key)) seen.set(key, { ...r, email: key });
  }
  return [...seen.values()];
}

export async function resolveRecipients(args: ResolveRecipientsArgs): Promise<ResolvedRecipient[]> {
  const { propertyId, reportType } = args;
  const now = args.now ?? new Date();
  const nowIso = now.toISOString();

  // Load the property's timezone + every active account that includes
  // this property in property_access. Admins are excluded — they read
  // multi-hotel dashboards, not the per-hotel email.
  const [{ data: propRow, error: propErr }, { data: accountRows, error: accErr }] = await Promise.all([
    supabaseAdmin
      .from('properties')
      .select('id, timezone')
      .eq('id', propertyId)
      .maybeSingle(),
    supabaseAdmin
      .from('accounts')
      .select('id, role, active, data_user_id, property_access')
      .or('role.eq.general_manager,role.eq.owner')
      .eq('active', true),
  ]);

  if (propErr || !propRow) {
    log.error('[reports/recipients] property load failed', { propertyId, err: propErr?.message });
    return [];
  }
  if (accErr) {
    log.error('[reports/recipients] accounts load failed', { propertyId, err: accErr.message });
    return [];
  }
  const timezone = propRow.timezone ?? 'UTC';

  const accountsForHotel = (accountRows ?? []).filter((a: AccountRow) =>
    Array.isArray(a.property_access) && a.property_access.includes(propertyId),
  ) as AccountRow[];

  if (accountsForHotel.length === 0) return [];

  // Look up the email for each account via auth.users. listUsers is
  // bounded at perPage=1000 which is plenty for Staxis fleet sizes.
  const userIds = new Set(accountsForHotel.map(a => a.data_user_id));
  const emailByUserId = new Map<string, string>();
  const { data: authPage, error: usrErr } = await supabaseAdmin.auth.admin.listUsers({ perPage: 1000 });
  if (usrErr) {
    log.error('[reports/recipients] auth listUsers failed', { propertyId, err: usrErr.message });
    return [];
  }
  for (const u of authPage?.users ?? []) {
    if (u.id && u.email && userIds.has(u.id)) emailByUserId.set(u.id, u.email);
  }

  // Per-account preferences. Missing row = use defaults (email channel,
  // weekly enabled, no pause, no CC).
  const accountIds = accountsForHotel.map(a => a.id);
  const { data: prefRows } = await supabaseAdmin
    .from('report_preferences')
    .select('account_id, channels, cc_emails, paused_until, weekly_enabled')
    .eq('property_id', propertyId)
    .in('account_id', accountIds);
  const prefsByAccount = new Map<string, PrefRow>();
  for (const p of (prefRows ?? []) as PrefRow[]) {
    prefsByAccount.set(p.account_id, p);
  }

  const out: ResolvedRecipient[] = [];
  for (const a of accountsForHotel) {
    const email = emailByUserId.get(a.data_user_id);
    if (!email || !isValidEmail(email)) continue;

    const prefs = prefsByAccount.get(a.id);
    // Vacation pause — skip if paused_until is in the future.
    if (prefs?.paused_until && prefs.paused_until > nowIso) continue;
    // Weekly opt-out — skip on the weekly cron only.
    if (reportType === 'weekly' && prefs && prefs.weekly_enabled === false) continue;

    // Channel preferences. Default: email on, SMS off. SMS recipients
    // ride the same outbox in a separate post-MVP iteration; for now
    // we record the channel choice but only the email path actually
    // dispatches. (The cron's recipient loop checks `channel` and
    // skips SMS dispatch.)
    const channels = prefs?.channels ?? { email: true, sms: false };
    if (channels.email !== false) {
      out.push({
        email,
        accountId: a.id,
        role: a.role === 'owner' ? 'owner' : 'gm',
        channel: 'email',
        timezone,
        lang: 'en',
      });
    }
    if (channels.sms === true) {
      out.push({
        email,
        accountId: a.id,
        role: a.role === 'owner' ? 'owner' : 'gm',
        channel: 'sms',
        timezone,
        lang: 'en',
      });
    }

    // CC recipients — only added once per account, regardless of channel.
    for (const cc of prefs?.cc_emails ?? []) {
      const ccTrim = cc.trim().toLowerCase();
      if (!ccTrim || !isValidEmail(ccTrim)) continue;
      out.push({
        email: ccTrim,
        accountId: null,
        role: 'cc',
        channel: 'email',
        timezone,
        lang: 'en',
      });
    }
  }

  return dedupe(out);
}
