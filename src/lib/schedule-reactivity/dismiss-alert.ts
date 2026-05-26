/**
 * Dismiss an open schedule_alerts row. Pure-DI shape so the API route layer
 * can pass a thin writer. Idempotent: dismissing an already-dismissed alert
 * is a no-op success.
 */

export interface DismissAlertWriter {
  /** Update dismissed_at + dismissed_by_account_id. Returns true if a row
   *  changed (i.e. the alert was previously open and is now closed). */
  markDismissed(alertId: string, accountId: string | null): Promise<{
    ok: boolean;
    alreadyDismissed: boolean;
    notFound: boolean;
  }>;
}

export async function dismissAlert(
  alertId: string,
  accountId: string | null,
  writer: DismissAlertWriter,
): Promise<{ ok: boolean; alreadyDismissed: boolean; notFound: boolean }> {
  return writer.markDismissed(alertId, accountId);
}

import { supabaseAdmin } from '@/lib/supabase-admin';
import { log } from '@/lib/log';

/**
 * Live writer. Idempotent dismissal — re-dismissing returns
 * `alreadyDismissed: true` instead of erroring. Property scoping is the
 * caller's responsibility (the API route must check that `alertId`
 * belongs to a property the caller can manage before calling).
 */
export function makeSupabaseDismissWriter(): DismissAlertWriter {
  return {
    async markDismissed(alertId, accountId) {
      const { data: existing, error: selErr } = await supabaseAdmin
        .from('schedule_alerts')
        .select('id, dismissed_at')
        .eq('id', alertId)
        .maybeSingle();
      if (selErr) {
        log.warn('[schedule-reactivity] dismiss select failed', {
          alertId, err: selErr.message,
        });
        return { ok: false, alreadyDismissed: false, notFound: false };
      }
      if (!existing) return { ok: false, alreadyDismissed: false, notFound: true };
      if (existing.dismissed_at) {
        return { ok: true, alreadyDismissed: true, notFound: false };
      }
      const { error: updErr } = await supabaseAdmin
        .from('schedule_alerts')
        .update({
          dismissed_at: new Date().toISOString(),
          dismissed_by_account_id: accountId,
          updated_at: new Date().toISOString(),
        })
        .eq('id', alertId)
        .is('dismissed_at', null);
      if (updErr) {
        log.warn('[schedule-reactivity] dismiss update failed', {
          alertId, err: updErr.message,
        });
        return { ok: false, alreadyDismissed: false, notFound: false };
      }
      return { ok: true, alreadyDismissed: false, notFound: false };
    },
  };
}
