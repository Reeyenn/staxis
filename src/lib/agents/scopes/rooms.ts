// ─── Scope: rooms ───────────────────────────────────────────────────────────
// Service-role read via pms-rooms-server.mergePmsRoomsForDate(pid, date).
// Returns a TRIMMED snapshot (counts + a capped dirty list) for the receipt.
//
// Honesty: room STATUS from pms_room_status_log is the latest known state, not
// point-in-time. On a dry-run/backtest we surface that as an approximation so
// the receipt can't claim a faithful historical view.

import { registerScope } from './registry';
import { mergePmsRoomsForDate } from '@/lib/pms-rooms-server';
import type { AgentScopeContext } from '@/lib/agents/types';

const DIRTY_LIST_CAP = 200;

registerScope({
  key: 'rooms',
  label: { en: 'Rooms & housekeeping status', es: 'Habitaciones y estado de limpieza' },
  async read(ctx: AgentScopeContext, approximations: string[]) {
    const rooms = await mergePmsRoomsForDate(ctx.propertyId, ctx.asOfDate);
    const byStatus: Record<string, number> = {};
    const dirty: Array<{ number: string; type: string; priority: string; arrival: string | null }> = [];
    for (const r of rooms) {
      byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
      if ((r.status === 'dirty' || r.status === 'in_progress') && dirty.length < DIRTY_LIST_CAP) {
        dirty.push({ number: r.number, type: r.type, priority: r.priority, arrival: r.arrival ?? null });
      }
    }
    if (ctx.mode === 'dry_run') {
      approximations.push(
        `Room status reflects the current state, not the historical state as of ${ctx.asOfDate}.`,
      );
    }
    return { date: ctx.asOfDate, total: rooms.length, byStatus, dirty };
  },
});
