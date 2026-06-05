// ─── Scope: pms ─────────────────────────────────────────────────────────────
// Service-role read of today's arrivals/departures from pms_reservations.
// Defensive: PMS columns vary by family, so a read error degrades to a noted
// zero rather than failing the whole run.

import { registerScope } from './registry';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { log } from '@/lib/log';
import type { AgentScopeContext } from '@/lib/agents/types';

registerScope({
  key: 'pms',
  label: { en: 'Arrivals & departures', es: 'Llegadas y salidas' },
  async read(ctx: AgentScopeContext, approximations: string[]) {
    try {
      const [arrivals, departures] = await Promise.all([
        supabaseAdmin
          .from('pms_reservations')
          .select('id', { count: 'exact', head: true })
          .eq('property_id', ctx.propertyId)
          .eq('arrival_date', ctx.asOfDate),
        supabaseAdmin
          .from('pms_reservations')
          .select('id', { count: 'exact', head: true })
          .eq('property_id', ctx.propertyId)
          .eq('departure_date', ctx.asOfDate),
      ]);
      if (arrivals.error || departures.error) {
        approximations.push('Arrivals/departures were partially unavailable for this run.');
      }
      return {
        date: ctx.asOfDate,
        arrivals: arrivals.count ?? 0,
        departures: departures.count ?? 0,
      };
    } catch (e) {
      log.warn('agents/pms scope read failed', { propertyId: ctx.propertyId, msg: e instanceof Error ? e.message : String(e) });
      approximations.push('Arrivals/departures were unavailable for this run.');
      return { date: ctx.asOfDate, arrivals: 0, departures: 0, unavailable: true };
    }
  },
});
