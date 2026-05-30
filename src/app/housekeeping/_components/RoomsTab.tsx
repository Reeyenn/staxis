'use client';

// Snow / floor-tracks redesign from the Claude Design housekeeping handoff
// (May 2026). All real-time data hooks and write handlers are preserved
// from the previous version — only the JSX layout changed:
//   • horizontal floor "tracks" with 76×82 tiles (was: floor grids)
//   • filter pills + search box (was: status-color legend)
//   • progress strip across the top (replaces glass metrics footer)
//   • crew-on-the-floor strip at the bottom
//   • AI Intelligence Recommendation card removed per design lock
//
// Tap a room → flips its status directly (dirty ↔ clean), no popup. Each
// tile has a small note icon in its bottom-right corner that opens a
// viewport-centered popup for adding/reviewing that room's notes.

import React, { useState, useEffect, useMemo } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { useProperty } from '@/contexts/PropertyContext';
import { useLang } from '@/contexts/LanguageContext';
import { useSyncContext } from '@/contexts/SyncContext';
import {
  subscribeToRooms, updateRoom, addRoom,
  subscribeToWorkOrders,
} from '@/lib/db';
import { useTodayStr } from '@/lib/use-today-str';
import type { Room, RoomStatus, WorkOrder, StaffMember } from '@/types';
import {
  T, FONT_SANS, FONT_MONO, FONT_SERIF,
  Caps, Pill, Btn, RoomTileBase, HousekeeperDot,
} from './_snow';
import { ManagerNotesEditor } from './ManagerNotesEditor';

// Internal "floor" extracted from a room number — first char for now,
// matches what `_shared.tsx` does. Inlined to avoid pulling in the
// heavy _shared module just for one helper.
function floorOf(num: string): string {
  if (!num) return '?';
  return num.charAt(0);
}

export function RoomsTab() {
  const { user } = useAuth();
  const { activePropertyId, activeProperty, staff } = useProperty();
  const { lang } = useLang();
  const { recordOfflineAction } = useSyncContext();

  const today = useTodayStr();
  const [rooms, setRooms] = useState<Room[]>([]);
  const [workOrders, setWorkOrders] = useState<WorkOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [noteRoom, setNoteRoom] = useState<Room | null>(null);
  const [filter, setFilter] = useState<'all' | 'toturn' | 'cleaning' | 'ready' | 'dnd'>('all');
  const [search, setSearch] = useState('');
  const [, setNowMs] = useState(Date.now());
  // Optimistic status overlay, keyed by room NUMBER (survives the
  // phantom→real id swap on the next poll). The board has no realtime — it
  // polls every 6s — so without this a tap shows nothing until the next
  // poll lands (the 4-8s lag managers complained about). We flip the tile
  // instantly here, fire the write in the background, and clear the entry
  // once a poll confirms the server agrees (or a safety timeout elapses).
  const [pending, setPending] = useState<Map<string, { status: RoomStatus; at: number }>>(() => new Map());
  const [toast, setToast] = useState<string | null>(null);

  // Subscribe to today's rooms (canonical live source — see the long
  // comment in the previous version for the full rationale).
  useEffect(() => {
    if (!user || !activePropertyId) return;
    setLoading(true);
    const unsub = subscribeToRooms(user.uid, activePropertyId, today, (todayRooms) => {
      setRooms(todayRooms);
      setLoading(false);
    });
    return unsub;
  }, [user, activePropertyId, today]);

  // Work orders → derive the "has open WO" flag per room number.
  useEffect(() => {
    if (!user || !activePropertyId) return;
    return subscribeToWorkOrders(user.uid, activePropertyId, setWorkOrders);
  }, [user, activePropertyId]);

  // Tick every 15s so in-progress tiles update their elapsed-time badge.
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 15_000);
    return () => clearInterval(id);
  }, []);

  // Merge today's rooms with property inventory so all rooms render even
  // before any live PMS data has landed for them. Phantom rows have an id
  // prefixed `phantom-` so handleToggle can lazily materialize them.
  const displayRooms = useMemo<Room[]>(() => {
    if (!activePropertyId) return [];
    const inventory = activeProperty?.roomInventory ?? [];

    let base: Room[];
    if (inventory.length === 0) {
      base = rooms;
    } else {
      const byNumber = new Map<string, Room>();
      for (const r of rooms) byNumber.set(r.number, r);

      const out: Room[] = [];
      for (const num of inventory) {
        const existing = byNumber.get(num);
        if (existing) out.push(existing);
        else {
          out.push({
            id: `phantom-${num}`,
            number: num,
            type: 'vacant',
            priority: 'standard',
            status: 'clean',
            date: today,
            propertyId: activePropertyId,
          });
        }
      }
      for (const r of rooms) {
        if (!inventory.includes(r.number)) out.push(r);
      }
      base = out;
    }

    // Apply the optimistic overlay so a just-tapped tile reflects its new
    // status immediately, before the next 6s poll confirms it server-side.
    if (pending.size === 0) return base;
    return base.map(r => {
      const p = pending.get(r.number);
      return p ? { ...r, status: p.status } : r;
    });
  }, [rooms, activeProperty?.roomInventory, activePropertyId, today, pending]);

  // Reconcile the optimistic overlay whenever a fresh poll lands. Drop an
  // entry once the server agrees with it (confirmed), or after a 15s safety
  // window so a failed/lost write can't pin a tile to the wrong status.
  useEffect(() => {
    setPending(prev => {
      if (prev.size === 0) return prev;
      const serverByNumber = new Map(rooms.map(r => [r.number, r.status] as const));
      const now = Date.now();
      const next = new Map(prev);
      for (const [num, p] of prev) {
        if (serverByNumber.get(num) === p.status) next.delete(num);
        else if (now - p.at > 15_000) next.delete(num);
      }
      return next.size === prev.size ? prev : next;
    });
  }, [rooms]);

  // Open-WO set keyed by room number, used to flag tiles with a red dot.
  // After the May-2026 maintenance simplification (migration 0131),
  // `WorkOrder.location` is a free-text field — we strip a leading
  // "Room "/"Rm "/"#" and only stash entries that look like a numeric
  // room id so the common cases ("Room 312", "312", "Rm 312") still mark
  // the right tile and free-text locations like "Lobby" are ignored.
  const openWoRooms = useMemo(() => {
    const set = new Set<string>();
    for (const o of workOrders) {
      if (o.status !== 'open') continue;
      const cleaned = (o.location || '').trim().replace(/^(room|rm\.?|#)\s*/i, '').trim();
      if (/^\d{1,5}$/.test(cleaned)) set.add(cleaned);
    }
    return set;
  }, [workOrders]);

  // Status counts across the whole property. DND is the housekeeper-set
  // "do not disturb" flag (r.isDnd), NOT r.type === 'vacant' — the inventory
  // merge above creates a phantom 'vacant' row for every untouched room,
  // which would inflate the DND count to "every room not yet touched today."
  const counts = useMemo(() => {
    const c = { total: 0, ready: 0, cleaning: 0, dirty: 0, dnd: 0, blocked: 0 };
    for (const r of displayRooms) {
      c.total++;
      if (r.status === 'clean' || r.status === 'inspected') c.ready++;
      if (r.status === 'in_progress') c.cleaning++;
      if (r.status === 'dirty') c.dirty++;
      if (r.isDnd) c.dnd++;
      if (openWoRooms.has(r.number)) c.blocked++;
    }
    return c;
  }, [displayRooms, openWoRooms]);

  const pct = counts.total > 0 ? Math.round((counts.ready / counts.total) * 100) : 0;

  // Tap a room to flip its status: clean → dirty, anything else → clean.
  // There's no manual "cleaning" step from the manager tap anymore —
  // housekeepers still set in_progress from their own flow. Inspected rooms
  // are locked. Phantom rooms are materialized into a real DB row on tap.
  //
  // The tile flips INSTANTLY via the optimistic overlay; the write runs in
  // the background and is reconciled against the next poll. On failure we
  // roll the overlay back and surface a toast so the manager knows to retry.
  const handleToggle = async (room: Room) => {
    if (!user || !activePropertyId || room.status === 'inspected') return;
    const newStatus: RoomStatus = room.status === 'clean' ? 'dirty' : 'clean';

    // Optimistic flip — instant feedback, keyed by room number.
    setPending(prev => {
      const next = new Map(prev);
      next.set(room.number, { status: newStatus, at: Date.now() });
      return next;
    });
    if (!navigator.onLine) recordOfflineAction();

    try {
      if (room.id.startsWith('phantom-')) {
        const completedAt = newStatus === 'clean' ? new Date() : undefined;
        await addRoom(user.uid, activePropertyId, {
          number: room.number,
          type: 'vacant',
          priority: 'standard',
          status: newStatus,
          date: today,
          propertyId: activePropertyId,
          ...(completedAt ? { completedAt } : {}),
        });
      } else {
        const updates: Partial<Room> = { status: newStatus };
        if (newStatus === 'clean') updates.completedAt = new Date();
        await updateRoom(user.uid, activePropertyId, room.id, updates);
      }
    } catch {
      // Roll back the optimistic flip and tell the manager.
      setPending(prev => {
        const next = new Map(prev);
        next.delete(room.number);
        return next;
      });
      setToast(lang === 'es' ? 'No se pudo guardar — intenta de nuevo' : "Couldn't save — try again");
      window.setTimeout(() => setToast(null), 2800);
    }
  };


  // Group rooms by floor → reversed so the top floor renders first
  // (matches the design's "top-down" stack).
  const floorMap = useMemo(() => {
    const m = new Map<string, Room[]>();
    for (const r of displayRooms) {
      const f = floorOf(r.number);
      if (!m.has(f)) m.set(f, []);
      m.get(f)!.push(r);
    }
    // Numerical sort, ground floor 'G' first.
    const sortedKeys = [...m.keys()].sort((a, b) => {
      if (a === 'G') return -1; if (b === 'G') return 1;
      return parseInt(a) - parseInt(b);
    }).reverse();
    return sortedKeys.map(k => ({
      floor: k,
      rooms: m.get(k)!.sort((a, b) =>
        (parseInt(a.number.replace(/\D/g, '')) || 0) - (parseInt(b.number.replace(/\D/g, '')) || 0)
      ),
    }));
  }, [displayRooms]);

  const matchesFilter = (r: Room) => {
    if (search && !r.number.includes(search)) return false;
    if (filter === 'all') return true;
    if (filter === 'toturn')   return r.status === 'dirty';
    if (filter === 'cleaning') return r.status === 'in_progress';
    if (filter === 'ready')    return r.status === 'clean' || r.status === 'inspected';
    if (filter === 'dnd')      return Boolean(r.isDnd) || openWoRooms.has(r.number);
    return true;
  };

  const filters: Array<{ key: typeof filter; label: string; n: number; danger?: boolean }> = [
    { key: 'all',      label: lang === 'es' ? 'Todas'        : 'All',             n: counts.total },
    { key: 'toturn',   label: lang === 'es' ? 'A limpiar'    : 'To turn',         n: counts.dirty },
    { key: 'cleaning', label: lang === 'es' ? 'Limpiando'    : 'Cleaning',        n: counts.cleaning },
    { key: 'ready',    label: lang === 'es' ? 'Limpias'      : 'Clean',           n: counts.ready },
    { key: 'dnd',      label: lang === 'es' ? 'DND / Bloq.'  : 'DND / blocked',   n: counts.dnd + counts.blocked },
  ];

  // Active crew → housekeepers currently assigned to at least one room
  // today. Powers the bottom strip.
  const activeCrew = useMemo(() => {
    const byId = new Map<string, { staff: StaffMember; done: number; total: number; active: Room | null }>();
    for (const r of displayRooms) {
      if (!r.assignedTo) continue;
      const s = staff.find(x => x.id === r.assignedTo);
      if (!s) continue;
      if (!byId.has(s.id)) byId.set(s.id, { staff: s, done: 0, total: 0, active: null });
      const entry = byId.get(s.id)!;
      entry.total++;
      if (r.status === 'clean' || r.status === 'inspected') entry.done++;
      if (r.status === 'in_progress') entry.active = r;
    }
    return [...byId.values()].sort((a, b) => {
      if (a.active && !b.active) return -1;
      if (!a.active && b.active) return 1;
      return a.staff.name.localeCompare(b.staff.name);
    });
  }, [displayRooms, staff]);

  if (loading) {
    return (
      <div style={{
        padding: '40px 48px', background: T.bg, color: T.ink2, fontFamily: FONT_SANS,
        minHeight: 'calc(100dvh - 130px)',
      }}>
        {lang === 'es' ? 'Cargando cuartos…' : 'Loading rooms…'}
      </div>
    );
  }

  return (
    <div style={{
      padding: '24px 48px 48px', background: T.bg, color: T.ink,
      fontFamily: FONT_SANS, minHeight: 'calc(100dvh - 130px)',
    }}>

      {/* HERO ROW — title */}
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end',
        marginBottom: 20, gap: 24, flexWrap: 'wrap',
      }}>
        <div>
          <Caps>{lang === 'es' ? 'El tablero · en vivo' : 'The board · live'}</Caps>
          <h1 style={{
            fontFamily: FONT_SERIF, fontSize: 36, color: T.ink, margin: '4px 0 0',
            letterSpacing: '-0.03em', lineHeight: 1.25, fontWeight: 400,
          }}>
            <span style={{ fontStyle: 'italic' }}>{counts.dirty}</span>
            {lang === 'es' ? ' cuartos por limpiar' : ' rooms to turn'}
            <span style={{ color: T.ink3 }}>
              {lang === 'es' ? ` · ${counts.cleaning} en progreso` : ` · ${counts.cleaning} in progress`}
            </span>
          </h1>
        </div>
      </div>

      {/* PROGRESS STRIP — overall % + per-status counts */}
      <div style={{
        background: T.paper, border: `1px solid ${T.rule}`, borderRadius: 14,
        padding: '14px 18px', marginBottom: 18,
        display: 'flex', alignItems: 'center', gap: 20, flexWrap: 'wrap',
      }}>
        <div style={{ flex: 1, minWidth: 240, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
            <span style={{ fontFamily: FONT_SANS, fontSize: 13, color: T.ink2 }}>
              <strong style={{ color: T.ink, fontWeight: 600 }}>{counts.ready} of {counts.total}</strong>
              {lang === 'es' ? ' limpias' : ' clean'}
            </span>
            <span style={{
              fontFamily: FONT_SERIF, fontSize: 24, fontStyle: 'italic',
              color: T.sageDeep, letterSpacing: '-0.02em',
            }}>{pct}%</span>
          </div>
          <div style={{ height: 6, background: T.ruleSoft, borderRadius: 3, overflow: 'hidden', display: 'flex' }}>
            <span style={{ width: `${(counts.ready / Math.max(1, counts.total)) * 100}%`, background: T.sageDeep }} />
            <span style={{ width: `${(counts.cleaning / Math.max(1, counts.total)) * 100}%`, background: T.caramelDeep }} />
            <span style={{ width: `${(counts.dirty / Math.max(1, counts.total)) * 100}%`, background: T.warm }} />
          </div>
        </div>
        <span style={{ width: 1, height: 34, background: T.rule }} />
        <div style={{ display: 'flex', gap: 18 }}>
          {[
            { l: lang === 'es' ? 'Limpias'   : 'Clean',    v: counts.ready,    c: T.sageDeep },
            { l: lang === 'es' ? 'Limpiando' : 'Cleaning', v: counts.cleaning, c: T.caramelDeep },
            { l: lang === 'es' ? 'Sucias'    : 'Dirty',    v: counts.dirty,    c: T.warm },
            { l: 'DND',                                     v: counts.dnd + counts.blocked, c: T.ink2 },
          ].map(s => (
            <div key={s.l} style={{ display: 'flex', flexDirection: 'column', gap: 2, alignItems: 'flex-start' }}>
              <Caps size={9}>{s.l}</Caps>
              <span style={{
                fontFamily: FONT_MONO, fontSize: 22, fontWeight: 500, color: s.c,
                letterSpacing: '-0.02em', lineHeight: 1,
              }}>{s.v}</span>
            </div>
          ))}
        </div>
      </div>

      {/* FILTERS + SEARCH */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        marginBottom: 18, gap: 14, flexWrap: 'wrap',
      }}>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {filters.map(f => {
            const active = filter === f.key;
            return (
              <button
                key={f.key}
                onClick={() => setFilter(f.key)}
                style={{
                  padding: '7px 14px', borderRadius: 999, cursor: 'pointer',
                  background: active ? T.ink : (f.danger ? T.warmDim : T.paper),
                  color: active ? T.bg : (f.danger ? T.warm : T.ink2),
                  border: active ? 'none' : `1px solid ${f.danger ? 'rgba(184,119,94,0.3)' : T.rule}`,
                  fontFamily: FONT_SANS, fontSize: 13, fontWeight: active ? 600 : 500,
                  display: 'inline-flex', alignItems: 'center', gap: 7,
                  whiteSpace: 'nowrap',
                }}
              >
                {f.label}
                <span style={{
                  fontFamily: FONT_MONO, fontSize: 11, fontWeight: 600,
                  color: active ? T.bg : (f.danger ? T.warm : T.ink3),
                  opacity: active ? 0.7 : 1,
                }}>{f.n}</span>
              </button>
            );
          })}
        </div>
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8,
          padding: '7px 14px', background: T.paper, border: `1px solid ${T.rule}`, borderRadius: 999,
          width: 260,
        }}>
          <svg width="13" height="13" viewBox="0 0 14 14">
            <circle cx="6" cy="6" r="4" fill="none" stroke={T.ink3 as string} strokeWidth="1.5"/>
            <line x1="9" y1="9" x2="12.5" y2="12.5" stroke={T.ink3 as string} strokeWidth="1.5" strokeLinecap="round"/>
          </svg>
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder={lang === 'es' ? 'Buscar cuarto…' : 'Find room number…'}
            style={{
              flex: 1, background: 'transparent', border: 'none', outline: 'none',
              fontFamily: FONT_SANS, fontSize: 13, color: T.ink,
            }}
          />
        </div>
      </div>

      {/* FLOOR TRACKS */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {floorMap.map(({ floor, rooms: floorRooms }) => {
          const visible = floorRooms.filter(matchesFilter);
          if (visible.length === 0) return null;
          const fc = {
            d: floorRooms.filter(r => r.status === 'dirty').length,
            p: floorRooms.filter(r => r.status === 'in_progress').length,
            c: floorRooms.filter(r => r.status === 'clean' || r.status === 'inspected').length,
          };
          return (
            <div key={floor} style={{
              background: T.paper, border: `1px solid ${T.rule}`, borderRadius: 18,
              padding: '18px 20px', display: 'flex', flexDirection: 'column', gap: 12,
            }}>
              <div style={{
                display: 'flex', alignItems: 'baseline', justifyContent: 'space-between',
                flexWrap: 'wrap', gap: 14,
              }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 14, whiteSpace: 'nowrap' }}>
                  <span style={{
                    fontFamily: FONT_SERIF, fontSize: 30, color: T.ink,
                    fontStyle: 'italic', lineHeight: 1.1, letterSpacing: '-0.02em',
                  }}>
                    {lang === 'es' ? 'Piso' : 'Floor'} {floor}
                  </span>
                  <span style={{ fontFamily: FONT_MONO, fontSize: 11, color: T.ink3 }}>
                    {floorRooms.length} {lang === 'es' ? 'cuartos' : 'rooms'}
                  </span>
                </div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <Pill tone="warm">{fc.d} {lang === 'es' ? 'sucias' : 'dirty'}</Pill>
                  <Pill tone="caramel">{fc.p} {lang === 'es' ? 'limpiando' : 'cleaning'}</Pill>
                  <Pill tone="sage">{fc.c} {lang === 'es' ? 'limpias' : 'clean'}</Pill>
                </div>
              </div>
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                {visible.map(r => (
                  <RoomTileBase
                    key={r.id}
                    r={r}
                    lang={lang}
                    hasWorkOrder={openWoRooms.has(r.number)}
                    onClick={() => { void handleToggle(r); }}
                    onNote={() => setNoteRoom(r)}
                  />
                ))}
              </div>
            </div>
          );
        })}
      </div>

      {/* CREW STRIP — only renders if at least one housekeeper is assigned today */}
      {activeCrew.length > 0 && (
        <div style={{
          marginTop: 18, background: T.paper, border: `1px solid ${T.rule}`, borderRadius: 14,
          padding: '14px 18px', display: 'flex', alignItems: 'center', gap: 18, flexWrap: 'wrap',
        }}>
          <Caps>{lang === 'es' ? 'En el piso' : 'On the floor'}</Caps>
          {activeCrew.map(({ staff: s, done, total, active }) => (
            <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <HousekeeperDot staff={s} size={26} />
              <div style={{ display: 'flex', flexDirection: 'column' }}>
                <span style={{
                  fontFamily: FONT_SANS, fontSize: 13, color: T.ink,
                  fontWeight: 500, lineHeight: 1.1,
                }}>{s.name}</span>
                <span style={{ fontFamily: FONT_MONO, fontSize: 10, color: T.ink2 }}>
                  {done}/{total} · {active
                    ? `${lang === 'es' ? 'en' : 'in'} ${active.number}`
                    : (lang === 'es' ? 'entre cuartos' : 'between rooms')}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* NOTE POPUP — tap a tile's note icon to add or review that room's
          notes. Fixed + viewport-centered so it lands in the middle of the
          screen no matter how far the board is scrolled. */}
      {noteRoom && (
        <>
          <div
            style={{ position: 'fixed', inset: 0, zIndex: 60, background: 'rgba(31,35,28,0.32)' }}
            onClick={() => setNoteRoom(null)}
          />
          <div style={{
            position: 'fixed', left: '50%', top: '50%', transform: 'translate(-50%, -50%)',
            zIndex: 61, background: T.paper, border: `1px solid ${T.rule}`, borderRadius: 18,
            padding: '20px 22px', width: 360, maxWidth: 'calc(100vw - 32px)',
            maxHeight: 'calc(100dvh - 64px)', overflowY: 'auto',
            boxShadow: '0 24px 48px rgba(31,35,28,0.18)',
            display: 'flex', flexDirection: 'column', gap: 14,
          }}>
            <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
              <div>
                <Caps>{lang === 'es' ? 'Nota del cuarto' : 'Room note'}</Caps>
                <h3 style={{
                  fontFamily: FONT_SERIF, fontSize: 32, color: T.ink, margin: '2px 0 0',
                  fontStyle: 'italic', letterSpacing: '-0.02em', lineHeight: 1,
                }}>{noteRoom.number}</h3>
              </div>
              <Btn variant="ghost" size="sm" onClick={() => setNoteRoom(null)}>{lang === 'es' ? 'Cerrar' : 'Close'}</Btn>
            </div>
            <ManagerNotesEditor roomNumber={noteRoom.number} />
          </div>
        </>
      )}
    </div>
  );
}
