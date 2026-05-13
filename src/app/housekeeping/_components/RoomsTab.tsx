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
// Click a room → popup with status-cycle actions, same as before. If a
// room has helpRequested = true, the popup is replaced by the backup
// picker (same flow as before, just re-skinned to Snow).

import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { useProperty } from '@/contexts/PropertyContext';
import { useLang } from '@/contexts/LanguageContext';
import { useSyncContext } from '@/contexts/SyncContext';
import { fetchWithAuth } from '@/lib/api-fetch';
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
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  // Single tracked timer so a slow toast can't get hidden by a faster one
  // landing right after, and so an unmounted component can't race-fire
  // setToastMessage(null). Cleared on unmount via the effect below.
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [toastKind, setToastKind] = useState<'success' | 'error'>('success');
  const [actionRoom, setActionRoom] = useState<Room | null>(null);
  const [backupRoom, setBackupRoom] = useState<Room | null>(null);
  const [populating, setPopulating] = useState(false);
  const [pulledAt, setPulledAt] = useState<Date | null>(null);
  const [filter, setFilter] = useState<'all' | 'toturn' | 'cleaning' | 'ready' | 'dnd' | 'help'>('all');
  const [search, setSearch] = useState('');
  const [, setNowMs] = useState(Date.now());

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
  // before "Refresh from PMS" has been clicked. Phantom rows have an id
  // prefixed `phantom-` so handleToggle can lazily materialize them.
  const displayRooms = useMemo<Room[]>(() => {
    if (!activePropertyId) return [];
    const inventory = activeProperty?.roomInventory ?? [];
    if (inventory.length === 0) return rooms;

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
    return out;
  }, [rooms, activeProperty?.roomInventory, activePropertyId, today]);

  // Open-WO set keyed by room number, used to flag tiles with a red dot.
  const openWoRooms = useMemo(() => {
    const set = new Set<string>();
    for (const o of workOrders) {
      if (o.status !== 'resolved') set.add(o.roomNumber);
    }
    return set;
  }, [workOrders]);

  // Status counts across the whole property. DND is the housekeeper-set
  // "do not disturb" flag (r.isDnd), NOT r.type === 'vacant' — the inventory
  // merge above creates a phantom 'vacant' row for every untouched room,
  // which would inflate the DND count to "every room not yet touched today."
  const counts = useMemo(() => {
    const c = { total: 0, ready: 0, cleaning: 0, dirty: 0, dnd: 0, blocked: 0, help: 0 };
    for (const r of displayRooms) {
      c.total++;
      if (r.status === 'clean' || r.status === 'inspected') c.ready++;
      if (r.status === 'in_progress') c.cleaning++;
      if (r.status === 'dirty') c.dirty++;
      if (r.isDnd) c.dnd++;
      if (openWoRooms.has(r.number)) c.blocked++;
      if (r.helpRequested) c.help++;
    }
    return c;
  }, [displayRooms, openWoRooms]);

  const pct = counts.total > 0 ? Math.round((counts.ready / counts.total) * 100) : 0;

  // "Refresh from PMS" — pulls live state from Choice Advantage via the
  // Railway scraper. ~5–15s round-trip typically. Same handler as before,
  // just renamed in the UI to match the design.
  const handlePopulateFromCsv = useCallback(async () => {
    if (!user || !activePropertyId || populating) return;
    setPopulating(true);
    try {
      const res = await fetchWithAuth('/api/refresh-from-pms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pid: activePropertyId, date: today }),
      });
      const j = await res.json().catch(() => ({}));
      if (j?.ok) {
        const data = j.data || {};
        const msg = lang === 'es'
          ? `Cargados ${data.totalFromHkCenter ?? '?'} cuartos del PMS`
          : `Loaded ${data.totalFromHkCenter ?? '?'} rooms from PMS`;
        setToastKind('success');
        setToastMessage(msg);
        setPulledAt(new Date());
      } else {
        setToastKind('error');
        setToastMessage(lang === 'es' ? 'No se pudo cargar del PMS' : 'Could not load from PMS');
      }
    } catch {
      setToastKind('error');
      setToastMessage(lang === 'es' ? 'Error al conectar con PMS' : 'PMS connection error');
    } finally {
      setPopulating(false);
      if (toastTimer.current) clearTimeout(toastTimer.current);
      toastTimer.current = setTimeout(() => setToastMessage(null), 3000);
    }
  }, [user, activePropertyId, populating, today, lang]);

  // Clean up the toast timer on unmount so a delayed setToastMessage(null)
  // can't fire after the component is gone (causes a React warning + leaks).
  useEffect(() => () => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
  }, []);

  // Cycle a room's status: dirty → in_progress → clean → dirty. Phantom
  // rooms are materialized into a real DB row on first click.
  const handleToggle = async (room: Room) => {
    if (!user || !activePropertyId || room.status === 'inspected') return;
    let newStatus: RoomStatus;
    if (room.status === 'dirty') newStatus = 'in_progress';
    else if (room.status === 'in_progress') newStatus = 'clean';
    else newStatus = 'dirty';
    if (!navigator.onLine) recordOfflineAction();

    if (room.id.startsWith('phantom-')) {
      const startedAt   = newStatus === 'in_progress' ? new Date() : undefined;
      const completedAt = newStatus === 'clean'       ? new Date() : undefined;
      await addRoom(user.uid, activePropertyId, {
        number: room.number,
        type: 'vacant',
        priority: 'standard',
        status: newStatus,
        date: today,
        propertyId: activePropertyId,
        ...(startedAt ? { startedAt } : {}),
        ...(completedAt ? { completedAt } : {}),
      });
      setActionRoom(null);
      return;
    }

    const updates: Partial<Room> = { status: newStatus };
    if (newStatus === 'in_progress') updates.startedAt   = new Date();
    if (newStatus === 'clean')       updates.completedAt = new Date();
    await updateRoom(user.uid, activePropertyId, room.id, updates);
    setActionRoom(null);
  };

  // Assign a backup housekeeper to a room that hit "help requested".
  //   1. Send the SMS first so we know whether it actually went out.
  //   2. Only clear `helpRequested` if the SMS succeeded — otherwise the
  //      HELP badge stays on the room as the obvious retry cue (and we
  //      surface a warm toast so the manager knows the text didn't land).
  //   3. Pass the *backup housekeeper's own* language to the API so a
  //      Spanish-speaking housekeeper gets a Spanish text, not the UI's
  //      current language. (Hardcoded 'en' was wrong even when the UI
  //      was in Spanish.)
  const handleSendBackup = async (room: Room, backupStaff: StaffMember) => {
    if (!user || !activePropertyId) return;
    if (!navigator.onLine) recordOfflineAction();
    let smsFailed = false;
    try {
      const res = await fetchWithAuth('/api/notify-backup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          uid: user.uid, pid: activePropertyId,
          backupStaffId: backupStaff.id,
          roomNumber: room.number,
          language: backupStaff.language ?? 'en',
        }),
      });
      if (!res.ok) smsFailed = true;
    } catch {
      smsFailed = true;
    }
    if (!smsFailed) {
      // SMS confirmed — safe to clear the HELP badge. Without this
      // ordering, a network failure left the room un-flagged AND the
      // backup uninformed — invisible to the manager until they noticed.
      await updateRoom(user.uid, activePropertyId, room.id, {
        helpRequested: false,
        issueNote: `Backup sent: ${backupStaff.name} at ${new Date().toLocaleTimeString()}`,
      });
    }
    setBackupRoom(null);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    if (smsFailed) {
      setToastKind('error');
      setToastMessage(lang === 'es'
        ? `${backupStaff.name} no recibió el aviso — intenta de nuevo`
        : `${backupStaff.name} not notified — try again`);
    } else {
      setToastKind('success');
      setToastMessage(lang === 'es'
        ? `${backupStaff.name} enviado a ${room.number}`
        : `${backupStaff.name} sent to Room ${room.number}`);
    }
    toastTimer.current = setTimeout(() => setToastMessage(null), 3500);
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
    if (filter === 'help')     return Boolean(r.helpRequested);
    return true;
  };

  const filters: Array<{ key: typeof filter; label: string; n: number; danger?: boolean }> = [
    { key: 'all',      label: lang === 'es' ? 'Todas'        : 'All',             n: counts.total },
    { key: 'toturn',   label: lang === 'es' ? 'A limpiar'    : 'To turn',         n: counts.dirty },
    { key: 'cleaning', label: lang === 'es' ? 'Limpiando'    : 'Cleaning',        n: counts.cleaning },
    { key: 'ready',    label: lang === 'es' ? 'Listas'       : 'Ready',           n: counts.ready },
    { key: 'dnd',      label: lang === 'es' ? 'DND / Bloq.'  : 'DND / blocked',   n: counts.dnd + counts.blocked },
    { key: 'help',     label: lang === 'es' ? 'Ayuda'        : 'Help requested',  n: counts.help, danger: true },
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

      {/* HERO ROW — title + refresh-from-PMS button */}
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
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 8 }}>
          {pulledAt && (
            <span style={{ fontFamily: FONT_MONO, fontSize: 11, color: T.ink2, whiteSpace: 'nowrap' }}>
              <span style={{ color: T.ink3 }}>{lang === 'es' ? 'Última carga PMS · ' : 'Last PMS pull · '}</span>
              <strong style={{ color: T.ink }}>{pulledAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</strong>
            </span>
          )}
          <Btn variant="primary" onClick={handlePopulateFromCsv} disabled={populating}>
            {populating
              ? (lang === 'es' ? 'Cargando…' : 'Loading…')
              : (lang === 'es' ? '↻ Cargar del PMS' : '↻ Refresh from PMS')}
          </Btn>
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
              {lang === 'es' ? ' listas' : ' ready'}
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
            { l: lang === 'es' ? 'Listas'    : 'Ready',    v: counts.ready,    c: T.sageDeep },
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
                  <Pill tone="sage">{fc.c} {lang === 'es' ? 'listas' : 'ready'}</Pill>
                </div>
              </div>
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                {visible.map(r => (
                  <RoomTileBase
                    key={r.id}
                    r={r}
                    lang={lang}
                    hasWorkOrder={openWoRooms.has(r.number)}
                    onClick={() => r.helpRequested ? setBackupRoom(r) : setActionRoom(r)}
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

      {/* ACTION POPUP — click a tile to cycle its status */}
      {actionRoom && (
        <>
          <div
            style={{ position: 'fixed', inset: 0, zIndex: 60, background: 'rgba(31,35,28,0.32)' }}
            onClick={() => setActionRoom(null)}
          />
          <div style={{
            position: 'fixed', left: '50%', top: '50%', transform: 'translate(-50%, -50%)',
            zIndex: 61, background: T.paper, border: `1px solid ${T.rule}`, borderRadius: 18,
            padding: '20px 22px', minWidth: 320, boxShadow: '0 24px 48px rgba(31,35,28,0.18)',
            display: 'flex', flexDirection: 'column', gap: 16,
          }}>
            <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
              <div>
                <Caps>{lang === 'es' ? 'Cuarto' : 'Room'}</Caps>
                <h3 style={{
                  fontFamily: FONT_SERIF, fontSize: 32, color: T.ink, margin: '2px 0 0',
                  fontStyle: 'italic', letterSpacing: '-0.02em', lineHeight: 1,
                }}>{actionRoom.number}</h3>
              </div>
              <Btn variant="ghost" size="sm" onClick={() => setActionRoom(null)}>{lang === 'es' ? 'Cerrar' : 'Close'}</Btn>
            </div>
            <p style={{ fontFamily: FONT_SANS, fontSize: 13, color: T.ink2, margin: 0 }}>
              {lang === 'es' ? 'Estado actual:' : 'Current status:'}{' '}
              <strong style={{ color: T.ink }}>{actionRoom.status}</strong>
            </p>
            <Btn variant="primary" size="md" onClick={() => handleToggle(actionRoom)}>
              {actionRoom.status === 'dirty'       ? (lang === 'es' ? 'Marcar como limpiando' : 'Mark as cleaning')
                : actionRoom.status === 'in_progress' ? (lang === 'es' ? 'Marcar como lista'      : 'Mark as ready')
                : actionRoom.status === 'clean'       ? (lang === 'es' ? 'Reiniciar a sucia'      : 'Reset to dirty')
                : (lang === 'es' ? 'Inspeccionada (bloqueada)' : 'Inspected (locked)')}
            </Btn>
          </div>
        </>
      )}

      {/* BACKUP PICKER — opens when clicking a room with helpRequested */}
      {backupRoom && (
        <>
          <div
            style={{ position: 'fixed', inset: 0, zIndex: 60, background: 'rgba(31,35,28,0.32)' }}
            onClick={() => setBackupRoom(null)}
          />
          <div style={{
            position: 'fixed', left: '50%', top: '50%', transform: 'translate(-50%, -50%)',
            zIndex: 61, background: T.paper, border: `1px solid ${T.rule}`, borderRadius: 18,
            padding: '20px 22px', minWidth: 360, maxWidth: 420,
            boxShadow: '0 24px 48px rgba(31,35,28,0.18)',
            display: 'flex', flexDirection: 'column', gap: 14,
          }}>
            <div>
              <Caps>{lang === 'es' ? 'Enviar refuerzo' : 'Send backup'}</Caps>
              <h3 style={{
                fontFamily: FONT_SERIF, fontSize: 28, color: T.ink, margin: '2px 0 0',
                fontStyle: 'italic', letterSpacing: '-0.02em', lineHeight: 1,
              }}>
                {lang === 'es' ? `Cuarto ${backupRoom.number}` : `Room ${backupRoom.number}`}
              </h3>
              <p style={{ fontFamily: FONT_SANS, fontSize: 13, color: T.ink2, margin: '6px 0 0' }}>
                {lang === 'es'
                  ? 'Elige a quién enviar como refuerzo. Recibirán un SMS.'
                  : 'Pick who to send as backup. They’ll get an SMS.'}
              </p>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 320, overflowY: 'auto' }}>
              {staff
                // Match the historical filter: undefined isActive defaults
                // to active; undefined department defaults to housekeeping.
                // Also exclude the housekeeper who's already on this room
                // (no point sending backup to themselves).
                .filter(s =>
                  s.isActive !== false &&
                  (!s.department || s.department === 'housekeeping') &&
                  s.id !== backupRoom.assignedTo,
                )
                .map(s => (
                <button
                  key={s.id}
                  onClick={() => handleSendBackup(backupRoom, s)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 12,
                    padding: '10px 14px', borderRadius: 12,
                    background: T.bg, border: `1px solid ${T.rule}`, cursor: 'pointer',
                    fontFamily: FONT_SANS, fontSize: 14, color: T.ink, fontWeight: 500,
                    textAlign: 'left',
                  }}
                >
                  <HousekeeperDot staff={s} size={28} />
                  <span style={{ flex: 1 }}>{s.name}</span>
                  <span style={{ fontFamily: FONT_MONO, fontSize: 11, color: T.ink3 }}>SMS →</span>
                </button>
              ))}
            </div>
            <Btn variant="ghost" size="sm" onClick={() => setBackupRoom(null)}>
              {lang === 'es' ? 'Cancelar' : 'Cancel'}
            </Btn>
          </div>
        </>
      )}

      {/* TOAST */}
      {toastMessage && (
        <div style={{
          position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)',
          zIndex: 70, padding: '12px 18px',
          background: toastKind === 'success' ? T.sageDim : T.warmDim,
          color: toastKind === 'success' ? T.sageDeep : T.warm,
          border: `1px solid ${toastKind === 'success' ? 'rgba(104,131,114,0.3)' : 'rgba(184,92,61,0.3)'}`,
          borderRadius: 999, fontFamily: FONT_SANS, fontSize: 13, fontWeight: 500,
        }}>
          {toastMessage}
        </div>
      )}
    </div>
  );
}
