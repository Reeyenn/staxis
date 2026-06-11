'use client';

// Housekeeping — Rooms Board ("Ledger") redesign, from the Claude Design
// handoff (design_handoff_rooms_board). Minimal white cards with a thin
// status-colored left bar + a status-colored room number, grouped by floor
// (ascending). Tap a card to flip Dirty ⇄ Clean with a physical card-turn
// animation driven by the Web Animations API (so it plays even under
// prefers-reduced-motion). The face (number color, status pill, bar) swaps at
// the edge-on midpoint of the turn.
//
// All real-time data hooks + the optimistic write/reconcile are preserved
// from the previous floor-tracks version — only the visual and the flip
// interaction changed. The old filters / search / crew strip and the per-room
// note popup are not part of this design.

import React, { useState, useEffect, useMemo, useRef } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { useProperty } from '@/contexts/PropertyContext';
import { useLang } from '@/contexts/LanguageContext';
import { useSyncContext } from '@/contexts/SyncContext';
import {
  subscribeToRooms, updateRoom, addRoom, subscribeToWorkOrders,
} from '@/lib/db';
import { useTodayStr } from '@/lib/use-today-str';
import type { Room, RoomStatus, WorkOrder } from '@/types';
import type { PropertyFeedStatus } from '@/lib/pms/feed-status';
import { FeedLearningBanner } from '@/components/FeedLearningBanner';
import { FONT_SANS, FONT_MONO, FONT_SERIF } from './_snow';

// Exact Ledger design tokens from the handoff.
const LED = {
  ink: '#181611', dim: '#928C7F', line: 'rgba(24,22,17,.12)', card: '#FFFFFF',
  dirty: '#C2562E', cleaning: '#A37C28', cleaningFill: '#C99A2E',
  clean: '#2F7A4E', cleanFill: '#3C9C68',
} as const;

// The board shows three states; fold inspected (and anything unexpected) into clean.
type Board = 'dirty' | 'cleaning' | 'clean';
const SC: Record<Board, { sc: string; fill: string }> = {
  dirty:    { sc: LED.dirty,    fill: LED.dirty },
  cleaning: { sc: LED.cleaning, fill: LED.cleaningFill },
  clean:    { sc: LED.clean,    fill: LED.cleanFill },
};
function boardStatus(s: RoomStatus): Board {
  if (s === 'dirty') return 'dirty';
  if (s === 'in_progress') return 'cleaning';
  return 'clean';
}
function floorOf(num: string): string { return num ? num.charAt(0) : '?'; }
function todayMDYStr(): string {
  const n = new Date();
  return `${n.getMonth() + 1}/${n.getDate()}/${String(n.getFullYear()).slice(2)}`;
}

// ─── Ledger room card — owns its WAAPI flip ──────────────────────────
function LedgerCard({ room, hasWO, lang, onFlip, neutral = false }: {
  room: Room; hasWO: boolean; lang: string; onFlip: () => void;
  /** feat/cua-partial-promotion — true when this room's status has NO real
   *  signal yet (room-status feed still learning + catch-all default, or a
   *  phantom row while the PMS list syncs). Renders a gray "no data" face
   *  instead of a confident Dirty/Clean. Tap still works — an in-app status
   *  set by staff is trustworthy and the card flips to a real face. */
  neutral?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const board = boardStatus(room.status);
  const { sc, fill } = neutral ? { sc: LED.dim, fill: LED.dim } : SC[board];
  const locked = room.status === 'inspected';

  const word = neutral
    ? (lang === 'es' ? 'Sin datos' : 'No data')
    : board === 'dirty'
      ? (lang === 'es' ? 'Sucia' : 'Dirty')
      : board === 'cleaning'
        ? (lang === 'es' ? 'Limpiando' : 'Cleaning')
        : (lang === 'es' ? 'Limpia' : 'Clean');
  const glyph = room.type === 'checkout' ? '↗'
    : room.type === 'stayover' ? '◐'
    : (room.arrival && room.arrival === todayMDYStr()) ? '★' : '·';

  const onClick = () => {
    const el = ref.current; if (!el) return;
    if (locked) {
      // Inspected rooms are locked (supervisor sign-off) — a small bounce, no flip.
      el.animate([{ transform: 'scale(1)' }, { transform: 'scale(.95)' }, { transform: 'scale(1)' }], { duration: 220 });
      return;
    }
    el.style.transformStyle = 'preserve-3d';
    el.animate([
      { transform: 'perspective(760px) rotateY(0deg)', boxShadow: '0 4px 12px rgba(24,22,17,.06)' },
      { transform: 'perspective(760px) rotateY(-90deg) scale(1.06)', boxShadow: '0 18px 34px rgba(24,22,17,.22)', offset: 0.5 },
      { transform: 'perspective(760px) rotateY(0deg)', boxShadow: '0 4px 12px rgba(24,22,17,.06)' },
    ], { duration: 540, easing: 'cubic-bezier(.34,1.3,.4,1)' });
    // Flip the data (and thus the card's face) at the edge-on midpoint.
    window.setTimeout(onFlip, 255);
  };

  return (
    <div ref={ref} className="lgr-card" onClick={onClick}
      title={lang === 'es' ? `Cuarto ${room.number}` : `Room ${room.number}`}>
      <span className="lgr-bar" style={{ background: sc }} />
      <div className="lgr-top">
        <span className="lgr-num" style={{ color: sc }}>{room.number}</span>
        <span className="lgr-glyph">{glyph}</span>
      </div>
      <div className="lgr-bot">
        <span className="lgr-st" style={{ color: sc }}>
          <i style={{ background: fill }} />{word}
        </span>
      </div>
      {hasWO && <span className="lgr-wo">!</span>}
    </div>
  );
}

export function RoomsTab() {
  const { user } = useAuth();
  const { activePropertyId, activeProperty } = useProperty();
  const { lang } = useLang();
  const { recordOfflineAction } = useSyncContext();
  const today = useTodayStr();

  const [rooms, setRooms] = useState<Room[]>([]);
  const [workOrders, setWorkOrders] = useState<WorkOrder[]>([]);
  const [loading, setLoading] = useState(true);
  // feat/cua-partial-promotion — per-feed PMS trust, riding the rooms poll.
  // null until the first response (or for older server versions) = render
  // exactly as today.
  const [feedStatus, setFeedStatus] = useState<PropertyFeedStatus | null>(null);
  // Optimistic status overlay keyed by room NUMBER (survives the phantom→real
  // id swap). The board polls every 6s, so we flip instantly here, fire the
  // write in the background, and clear once a poll confirms (or after 15s).
  const [pending, setPending] = useState<Map<string, { status: RoomStatus; at: number }>>(() => new Map());
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    if (!user || !activePropertyId) return;
    setLoading(true);
    const unsub = subscribeToRooms(user.uid, activePropertyId, today, (todayRooms, fs) => {
      setRooms(todayRooms); if (fs) setFeedStatus(fs); setLoading(false);
    });
    return unsub;
  }, [user, activePropertyId, today]);

  useEffect(() => {
    if (!user || !activePropertyId) return;
    return subscribeToWorkOrders(user.uid, activePropertyId, setWorkOrders);
  }, [user, activePropertyId]);

  // Merge today's rooms with property inventory so every room renders even
  // before any live PMS data has landed (phantom rows materialize on tap).
  const displayRooms = useMemo<Room[]>(() => {
    if (!activePropertyId) return [];
    const inventory = activeProperty?.roomInventory ?? [];
    let base: Room[];
    if (inventory.length === 0) base = rooms;
    else {
      const byNumber = new Map<string, Room>();
      for (const r of rooms) byNumber.set(r.number, r);
      const out: Room[] = [];
      for (const num of inventory) {
        const existing = byNumber.get(num);
        if (existing) out.push(existing);
        else out.push({ id: `phantom-${num}`, number: num, type: 'vacant', priority: 'standard', status: 'clean', date: today, propertyId: activePropertyId });
      }
      for (const r of rooms) if (!inventory.includes(r.number)) out.push(r);
      base = out;
    }
    if (pending.size === 0) return base;
    // An optimistic tap is APP-originated truth — also stamp statusSource so
    // the neutral "no data" face flips to a real one immediately.
    return base.map(r => { const p = pending.get(r.number); return p ? { ...r, status: p.status, statusSource: 'assignment' as const } : r; });
  }, [rooms, activeProperty?.roomInventory, activePropertyId, today, pending]);

  // feat/cua-partial-promotion — honesty derivations. All false until feed
  // status arrives (or for manual hotels) → board renders exactly as today.
  // Review pass: banner PRECEDENCE picks one message, but data
  // NEUTRALIZATION is a union — a pending first sync makes every no-signal
  // status fake even when no feed is formally 'learning' (Codex #3).
  // 'pending' = never synced (mask data); 'paused' = real-but-stale data
  // (banner only — staleness is the doctor/freshness domain).
  const fsLive = feedStatus?.mode === 'live';
  const connPending = fsLive && feedStatus.connection === 'pending';
  const connPaused = fsLive && feedStatus.connection === 'paused';
  const roomStatusLearning = fsLive && feedStatus.feeds.roomStatus === 'learning';
  const workOrdersLearning = fsLive && feedStatus.feeds.workOrders === 'learning';
  // PMS-connected but the canonical room list hasn't synced yet → every card
  // is a phantom; without this the board reads "all clean" on day one.
  const roomListSyncing = fsLive && !connPaused && rooms.length === 0;
  const isNeutralRoom = (r: Room): boolean => {
    // An optimistic tap stamps statusSource:'assignment' — app truth, never
    // neutral (senior #6a: without this a tapped phantom stayed "No data"
    // for a full poll cycle and invited double-taps).
    if (r.statusSource === 'assignment') return false;
    return ((roomStatusLearning || connPending) && r.statusSource === 'default') ||
      ((roomStatusLearning || roomListSyncing || connPending) && r.id.startsWith('phantom-'));
  };

  // Reconcile the optimistic overlay on each fresh poll.
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

  // Open-WO set keyed by room number (free-text location → numeric room id).
  const openWoRooms = useMemo(() => {
    const set = new Set<string>();
    for (const o of workOrders) {
      if (o.status !== 'open') continue;
      const cleaned = (o.location || '').trim().replace(/^(room|rm\.?|#)\s*/i, '').trim();
      if (/^\d{1,5}$/.test(cleaned)) set.add(cleaned);
    }
    return set;
  }, [workOrders]);

  const counts = useMemo(() => {
    const c = { total: 0, clean: 0, cleaning: 0, dirty: 0, unknown: 0 };
    for (const r of displayRooms) {
      c.total++;
      // Neutral rooms (no real status signal while the PMS feed is still
      // learning) must not count as clean OR dirty — either way would be a
      // confident claim with no data behind it.
      if (isNeutralRoom(r)) { c.unknown++; continue; }
      const b = boardStatus(r.status);
      if (b === 'clean') c.clean++;
      else if (b === 'cleaning') c.cleaning++;
      else c.dirty++;
    }
    return c;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [displayRooms, roomStatusLearning, roomListSyncing, connPending]);
  const knownTotal = counts.total - counts.unknown;
  const donePct = knownTotal > 0 ? Math.round((counts.clean / knownTotal) * 100) : 0;

  // Tap a room → flip clean → dirty, anything else → clean. Inspected rooms are
  // locked (the card bounces instead). Phantom rooms materialize into a real
  // row on tap. Optimistic + background write + rollback-on-failure toast.
  const handleToggle = async (room: Room) => {
    if (!user || !activePropertyId || room.status === 'inspected') return;
    const newStatus: RoomStatus = room.status === 'clean' ? 'dirty' : 'clean';
    setPending(prev => { const next = new Map(prev); next.set(room.number, { status: newStatus, at: Date.now() }); return next; });
    if (!navigator.onLine) recordOfflineAction();
    try {
      if (room.id.startsWith('phantom-')) {
        const completedAt = newStatus === 'clean' ? new Date() : undefined;
        await addRoom(user.uid, activePropertyId, { number: room.number, type: 'vacant', priority: 'standard', status: newStatus, date: today, propertyId: activePropertyId, ...(completedAt ? { completedAt } : {}) });
      } else {
        const updates: Partial<Room> = { status: newStatus };
        if (newStatus === 'clean') updates.completedAt = new Date();
        await updateRoom(user.uid, activePropertyId, room.id, updates);
      }
    } catch {
      setPending(prev => { const next = new Map(prev); next.delete(room.number); return next; });
      setToast(lang === 'es' ? 'No se pudo guardar — intenta de nuevo' : "Couldn't save — try again");
      window.setTimeout(() => setToast(null), 2800);
    }
  };

  // Group by floor, ascending (Floor 1 → 4); rooms within a floor ascending.
  const floorGroups = useMemo(() => {
    const m = new Map<string, Room[]>();
    for (const r of displayRooms) { const f = floorOf(r.number); if (!m.has(f)) m.set(f, []); m.get(f)!.push(r); }
    const keys = [...m.keys()].sort((a, b) => {
      if (a === 'G') return -1; if (b === 'G') return 1;
      return (parseInt(a) || 0) - (parseInt(b) || 0);
    });
    return keys.map(k => ({
      floor: k,
      rooms: m.get(k)!.sort((a, b) => (parseInt(a.number.replace(/\D/g, '')) || 0) - (parseInt(b.number.replace(/\D/g, '')) || 0)),
    }));
  }, [displayRooms]);

  if (loading) {
    return (
      <div style={{ padding: '40px 36px', background: LED.card, color: LED.dim, fontFamily: FONT_SANS, minHeight: 'calc(100dvh - 130px)' }}>
        {lang === 'es' ? 'Cargando cuartos…' : 'Loading rooms…'}
      </div>
    );
  }

  const capLabel: React.CSSProperties = { fontFamily: FONT_MONO, fontSize: 9, letterSpacing: '.14em', textTransform: 'uppercase', color: LED.dim };

  return (
    <div className="rooms-ledger" style={{ background: LED.card, color: LED.ink, fontFamily: FONT_SANS, minHeight: 'calc(100dvh - 130px)' }}>
      <style>{`
        .rooms-ledger .lgr-wrap { width:100%; padding:26px 36px 90px; }
        .rooms-ledger .lgr-head { display:grid; grid-template-columns:1fr auto 1fr; align-items:baseline; gap:24px; margin:0 0 8px; }
        .rooms-ledger .lgr-stats { justify-self:center; display:flex; gap:26px; }
        @media (max-width:680px){ .rooms-ledger .lgr-head { grid-template-columns:1fr; } .rooms-ledger .lgr-stats { justify-self:start; } }
        .rooms-ledger .lgr-grid { display:grid; gap:10px; grid-template-columns:repeat(auto-fill, minmax(94px, 1fr)); }
        .rooms-ledger .lgr-card { position:relative; height:66px; border-radius:9px; background:#FFFFFF; border:1px solid ${LED.line}; cursor:pointer; overflow:visible; display:flex; flex-direction:column; justify-content:space-between; padding:9px 10px 9px 13px; transition:transform .25s cubic-bezier(.34,1.56,.5,1), box-shadow .25s; -webkit-tap-highlight-color:transparent; }
        .rooms-ledger .lgr-card:hover { transform:translateY(-3px); box-shadow:0 10px 24px rgba(24,22,17,.10); }
        .rooms-ledger .lgr-bar { position:absolute; left:0; top:0; bottom:0; width:4px; border-radius:9px 0 0 9px; }
        .rooms-ledger .lgr-top { display:flex; align-items:flex-start; justify-content:space-between; }
        .rooms-ledger .lgr-num { font-family:${FONT_MONO}; font-weight:600; font-size:19px; letter-spacing:-.02em; line-height:1; }
        .rooms-ledger .lgr-glyph { font-size:13px; color:${LED.dim}; }
        .rooms-ledger .lgr-bot { display:flex; align-items:center; }
        .rooms-ledger .lgr-st { display:inline-flex; align-items:center; gap:5px; font-family:${FONT_MONO}; font-size:8.5px; font-weight:700; letter-spacing:.08em; text-transform:uppercase; }
        .rooms-ledger .lgr-st i { width:8px; height:8px; border-radius:50%; display:inline-block; flex-shrink:0; }
        .rooms-ledger .lgr-wo { position:absolute; top:-7px; right:-7px; width:19px; height:19px; border-radius:50%; background:${LED.dirty}; color:#fff; font-weight:800; font-size:11px; display:flex; align-items:center; justify-content:center; z-index:6; box-shadow:0 2px 7px rgba(194,86,46,.45); border:2px solid #fff; }
        @media (max-width:600px){ .rooms-ledger .lgr-wrap { padding:18px 16px 80px; } .rooms-ledger .lgr-grid { grid-template-columns:repeat(auto-fill, minmax(80px, 1fr)); gap:8px; } }
        @media (prefers-reduced-motion: reduce){ .rooms-ledger .lgr-card { transition:none; } }
      `}</style>

      <div className="lgr-wrap">
        {/* feat/cua-partial-promotion — honesty strips. One banner at a
            time: pending > paused > feed-level. */}
        {connPending && (
          <div style={{ marginBottom: 18 }}>
            <FeedLearningBanner
              variant="strip"
              title={lang === 'es' ? 'Conectando con tu PMS.' : 'Connecting to your PMS.'}
              text={lang === 'es'
                ? 'Los datos de habitaciones en vivo aparecerán cuando termine la primera sincronización.'
                : 'Live room data will appear once the first sync lands.'}
            />
          </div>
        )}
        {!connPending && connPaused && (
          <div style={{ marginBottom: 18 }}>
            <FeedLearningBanner
              variant="strip"
              title={lang === 'es' ? 'Conexión con el PMS en pausa.' : 'PMS connection paused.'}
              text={lang === 'es'
                ? 'Los datos pueden estar desactualizados hasta que se reanude.'
                : 'Data may be out of date until it resumes.'}
            />
          </div>
        )}
        {!connPending && !connPaused && (roomStatusLearning || roomListSyncing || workOrdersLearning) && (
          <div style={{ marginBottom: 18 }}>
            <FeedLearningBanner
              variant="strip"
              title={lang === 'es' ? 'Aún aprendiendo tu PMS.' : 'Still learning your PMS.'}
              text={[
                roomStatusLearning
                  ? (lang === 'es'
                    ? 'Los estados de habitaciones del PMS todavía no llegan — lo mostrado refleja solo cambios hechos en la app, y las habitaciones “Sin datos” no tienen información todavía.'
                    : 'Room statuses from the PMS aren’t flowing yet — what you see reflects in-app updates only, and “No data” rooms have no information yet.')
                  : roomListSyncing
                    ? (lang === 'es'
                      ? 'La lista de habitaciones aún se está sincronizando desde tu PMS.'
                      : 'The room list is still syncing from your PMS.')
                    : '',
                workOrdersLearning
                  ? (lang === 'es'
                    ? 'Las órdenes de mantenimiento del PMS también se están aprendiendo — las marcas de fuera de servicio pueden faltar.'
                    : 'PMS maintenance flags are still being learned too — out-of-order badges may be missing.')
                  : '',
              ].filter(Boolean).join(' ')}
            />
          </div>
        )}
        {/* header: title (left) + summary counts (centered) */}
        <div className="lgr-head">
          <div>
            <div style={{ fontFamily: FONT_SERIF, fontSize: 38, fontWeight: 400, lineHeight: 1, color: LED.ink }}>
              <i style={{ color: LED.dirty }}>{counts.dirty}</i>{lang === 'es' ? ' cuartos por limpiar' : ' rooms to turn'}
            </div>
          </div>
          <div className="lgr-stats">
            {[
              { v: String(counts.clean), l: lang === 'es' ? 'Limpias' : 'Clean', c: LED.clean },
              { v: String(counts.dirty), l: lang === 'es' ? 'Sucias' : 'Dirty', c: LED.dirty },
              { v: `${donePct}%`,         l: lang === 'es' ? 'Listo' : 'Done',  c: LED.ink },
            ].map(s => (
              <div key={s.l} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                <b style={{ fontFamily: FONT_SERIF, fontStyle: 'italic', fontSize: 28, lineHeight: 1, color: s.c, fontWeight: 400 }}>{s.v}</b>
                <span style={{ ...capLabel, marginTop: 4 }}>{s.l}</span>
              </div>
            ))}
          </div>
        </div>

        {/* room-type legend */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 20, flexWrap: 'wrap', margin: '0 0 22px', fontFamily: FONT_SANS, fontSize: 12.5, color: LED.dim }}>
          <span style={{ fontFamily: FONT_MONO, fontSize: 10, letterSpacing: '.16em', textTransform: 'uppercase', color: LED.dim }}>{lang === 'es' ? 'Tipo de cuarto' : 'Room type'}</span>
          {[
            { g: '★', l: lang === 'es' ? 'Llegada' : 'Arrival' },
            { g: '◐', l: lang === 'es' ? 'Estancia' : 'Stayover' },
            { g: '↗', l: lang === 'es' ? 'Salida' : 'Checkout' },
          ].map(e => (
            <span key={e.l} style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
              <b style={{ fontSize: 15, color: LED.ink, fontWeight: 500 }}>{e.g}</b>{e.l}
            </span>
          ))}
        </div>

        {/* floor sections (ascending) */}
        {floorGroups.map(({ floor, rooms: fr }) => (
          <div key={floor} style={{ marginBottom: 26 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 13 }}>
              <b style={{ fontFamily: FONT_SERIF, fontStyle: 'italic', fontSize: 23, fontWeight: 400, color: LED.ink }}>{lang === 'es' ? 'Piso' : 'Floor'} {floor}</b>
              <span style={{ fontFamily: FONT_MONO, fontSize: 10, letterSpacing: '.18em', textTransform: 'uppercase', color: LED.dim }}>{fr.length} {lang === 'es' ? 'cuartos' : 'rooms'}</span>
            </div>
            <div className="lgr-grid">
              {fr.map(r => (
                <LedgerCard key={r.id} room={r} hasWO={openWoRooms.has(r.number)} lang={lang} neutral={isNeutralRoom(r)} onFlip={() => { void handleToggle(r); }} />
              ))}
            </div>
          </div>
        ))}
      </div>

      {toast && (
        <div style={{ position: 'fixed', left: '50%', bottom: 28, transform: 'translateX(-50%)', zIndex: 70, background: LED.ink, color: '#fff', padding: '11px 18px', borderRadius: 999, fontFamily: FONT_SANS, fontSize: 13, boxShadow: '0 10px 30px rgba(24,22,17,.28)' }}>{toast}</div>
      )}
    </div>
  );
}
