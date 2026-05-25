/**
 * ScheduleTab — Plan v4 minimal restore.
 *
 * Shows today's room work derived from the new pms_* tables that the
 * vision CUA writes to every 30 seconds. Replaces the 1696-line pre-v4
 * version which read from the dropped `plan_snapshots` table.
 *
 * What you see today:
 *   - Date picker (defaults to today; arrows to flip)
 *   - Day-level counts (checkouts / stayovers / vacant_clean / vacant_dirty / OOO / in-house)
 *   - Room list grouped by assigned housekeeper (unassigned rooms first)
 *   - Live re-fetch on any CUA write (subscribes to pms_room_status_log
 *     + pms_housekeeping_assignments + pms_reservations)
 *
 * What's NOT in this minimal restore (vs the pre-v4 ScheduleTab):
 *   - Drag-and-drop housekeeper assignment (manager moves rooms between
 *     crew members)
 *   - Auto-fill ("compute tomorrow's schedule") — that cron is gone too
 *   - Shift-confirmation SMS dispatcher
 *   - Calendar week view
 *
 * Those features were tied to the old plan_snapshots write path. They'll
 * come back when (and if) someone rebuilds them against the pms_* schema.
 * In the meantime this tab is read-only — the CUA owns the room state,
 * the housekeepers tap Start/Done on RoomsTab, the schedule auto-updates.
 */

'use client';

import { useEffect, useMemo, useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { useProperty } from '@/contexts/PropertyContext';
import { useLang } from '@/contexts/LanguageContext';
import {
  fetchTodayRoomWork,
  fetchTodayPropertyCounts,
  subscribeTodayRoomWork,
  type TodayRoomWorkRow,
  type TodayPropertyCounts,
} from '@/lib/db';
import {
  defaultShiftDate, addDays, formatDisplayDate, todayRoomWorkToShiftRooms,
} from './_shared';
import { T, FONT_SANS, FONT_MONO, FONT_SERIF, Card, Caps, Pill } from './_snow';
import { ChevronLeft, ChevronRight, Users } from 'lucide-react';

const EMPTY_COUNTS: TodayPropertyCounts = {
  checkouts: 0, stayovers: 0, vacant_clean: 0, vacant_dirty: 0,
  ooo: 0, total_rooms: 0, total_checkouts_today: 0, in_house: 0,
};

export function ScheduleTab() {
  const { user, loading: authLoading } = useAuth();
  const { activePropertyId } = useProperty();
  const { lang } = useLang();
  const pid = activePropertyId ?? '';

  const [shiftDate, setShiftDate] = useState<string>(defaultShiftDate());
  const [rows, setRows] = useState<TodayRoomWorkRow[]>([]);
  const [counts, setCounts] = useState<TodayPropertyCounts>(EMPTY_COUNTS);
  const [loading, setLoading] = useState(true);

  // Fetch + auto-refresh on CUA writes.
  useEffect(() => {
    if (!pid) return;
    let alive = true;
    const load = async () => {
      const [w, c] = await Promise.all([
        fetchTodayRoomWork(pid, shiftDate),
        fetchTodayPropertyCounts(pid, shiftDate),
      ]);
      if (!alive) return;
      setRows(w);
      setCounts(c);
      setLoading(false);
    };
    void load();
    const unsub = subscribeTodayRoomWork(pid, () => { void load(); });
    return () => { alive = false; unsub(); };
  }, [pid, shiftDate]);

  const shiftRooms = useMemo(
    () => todayRoomWorkToShiftRooms(rows, shiftDate, pid),
    [rows, shiftDate, pid],
  );

  // Group rooms by assigned housekeeper (or "Unassigned").
  const grouped = useMemo(() => {
    const buckets = new Map<string, typeof shiftRooms>();
    for (const r of shiftRooms) {
      const key = r.assignedTo ?? '__unassigned__';
      const arr = buckets.get(key) ?? [];
      arr.push(r);
      buckets.set(key, arr);
    }
    return Array.from(buckets.entries())
      .map(([who, list]) => ({
        who: who === '__unassigned__' ? (lang === 'es' ? 'Sin asignar' : 'Unassigned') : who,
        list: list.sort((a, b) => a.number.localeCompare(b.number)),
      }))
      .sort((a, b) => {
        // Unassigned first
        if (a.who === 'Unassigned' || a.who === 'Sin asignar') return -1;
        if (b.who === 'Unassigned' || b.who === 'Sin asignar') return 1;
        return a.who.localeCompare(b.who);
      });
  }, [shiftRooms, lang]);

  if (authLoading || !user) {
    return (
      <div style={{ padding: 40, textAlign: 'center', fontFamily: FONT_SANS, color: T.ink3 }}>
        Loading…
      </div>
    );
  }

  return (
    <div style={{ padding: '16px 24px 48px', fontFamily: FONT_SANS, color: T.ink, maxWidth: 1100, margin: '0 auto' }}>
      {/* Header: date picker */}
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 16, marginBottom: 24 }}>
        <h1 style={{ fontFamily: FONT_SERIF, fontSize: 32, fontStyle: 'italic', fontWeight: 400, margin: 0 }}>
          {lang === 'es' ? 'Horario' : 'Schedule'}
        </h1>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <button
            onClick={() => setShiftDate(addDays(shiftDate, -1))}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: T.ink2, padding: 4 }}
            aria-label="Previous day"
          >
            <ChevronLeft size={18} />
          </button>
          <span style={{ fontFamily: FONT_MONO, fontSize: 13, minWidth: 220, textAlign: 'center' }}>
            {formatDisplayDate(shiftDate, lang)}
          </span>
          <button
            onClick={() => setShiftDate(addDays(shiftDate, 1))}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: T.ink2, padding: 4 }}
            aria-label="Next day"
          >
            <ChevronRight size={18} />
          </button>
          {shiftDate !== defaultShiftDate() && (
            <button
              onClick={() => setShiftDate(defaultShiftDate())}
              style={{
                fontFamily: FONT_MONO, fontSize: 10, letterSpacing: '0.16em',
                textTransform: 'uppercase', color: T.ink3, background: 'none',
                border: `1px solid ${T.rule}`, padding: '4px 8px', borderRadius: 3,
                cursor: 'pointer',
              }}
            >
              Today
            </button>
          )}
        </div>
      </div>

      {/* Day counts */}
      <Card padding="16px 20px" style={{ marginBottom: 16 }}>
        <Caps>{lang === 'es' ? 'Resumen del día' : 'Today at a glance'}</Caps>
        <div style={{ display: 'flex', gap: 28, flexWrap: 'wrap', marginTop: 10 }}>
          <CountBlock label={lang === 'es' ? 'Salidas' : 'Checkouts'} value={counts.checkouts} tone="warm" />
          <CountBlock label={lang === 'es' ? 'Continuación' : 'Stayovers'} value={counts.stayovers} tone="sage" />
          <CountBlock label={lang === 'es' ? 'Limpio' : 'Vacant clean'} value={counts.vacant_clean} tone="neutral" />
          <CountBlock label={lang === 'es' ? 'Sucio' : 'Vacant dirty'} value={counts.vacant_dirty} tone="caramel" />
          <CountBlock label="OOO" value={counts.ooo} tone="neutral" />
          <CountBlock label={lang === 'es' ? 'Ocupadas' : 'In-house'} value={counts.in_house} tone="sage" />
          <CountBlock label={lang === 'es' ? 'Inventario' : 'Total rooms'} value={counts.total_rooms} tone="neutral" />
        </div>
      </Card>

      {/* Status note */}
      {loading && (
        <Card padding="14px 18px" style={{ marginBottom: 16 }}>
          <div style={{ fontFamily: FONT_MONO, fontSize: 12, color: T.ink3 }}>Loading…</div>
        </Card>
      )}
      {!loading && shiftRooms.length === 0 && (
        <Card padding="14px 18px" style={{ marginBottom: 16 }}>
          <div style={{ fontFamily: FONT_MONO, fontSize: 12, color: T.ink3, lineHeight: 1.6 }}>
            {lang === 'es'
              ? 'Sin trabajo para esta fecha. Si la fecha es hoy y debería haber habitaciones, el robot CUA aún no ha sincronizado este hotel — espera ~30 segundos.'
              : "No work for this date. If today's date looks empty, the CUA worker hasn't synced this hotel yet — give it ~30 seconds."}
          </div>
        </Card>
      )}

      {/* Per-housekeeper sections */}
      {grouped.map(g => (
        <Card key={g.who} padding="16px 20px" style={{ marginBottom: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
            <Users size={14} color={T.ink2} />
            <Caps>{g.who}</Caps>
            <span style={{ fontFamily: FONT_MONO, fontSize: 11, color: T.ink3, marginLeft: 'auto' }}>
              {g.list.length} {lang === 'es' ? (g.list.length === 1 ? 'habitación' : 'habitaciones') : (g.list.length === 1 ? 'room' : 'rooms')}
            </span>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {g.list.map(r => (
              <div
                key={r.id}
                style={{
                  display: 'flex', flexDirection: 'column', alignItems: 'center',
                  padding: '8px 10px', minWidth: 76,
                  background: T.bg, border: `1px solid ${T.rule}`, borderRadius: 4,
                }}
              >
                <span style={{ fontFamily: FONT_MONO, fontSize: 14, color: T.ink }}>
                  {r.number}
                </span>
                <Pill tone={r.type === 'checkout' ? 'warm' : 'sage'} style={{ marginTop: 4, fontSize: 9 }}>
                  {r.type === 'checkout' ? 'C/O' : `Stay${r.stayoverDay ? ` D${r.stayoverDay}` : ''}`}
                </Pill>
              </div>
            ))}
          </div>
        </Card>
      ))}
    </div>
  );
}

// ─── Small UI bits ────────────────────────────────────────────────────────

function CountBlock({ label, value, tone }: { label: string; value: number; tone: 'sage' | 'warm' | 'caramel' | 'neutral' }) {
  return (
    <div>
      <Caps>{label}</Caps>
      <Pill tone={tone} style={{ marginTop: 4, fontSize: 13, padding: '4px 10px' }}>
        {value}
      </Pill>
    </div>
  );
}
