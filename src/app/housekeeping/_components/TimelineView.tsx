'use client';

/**
 * TimelineView — manager-facing Gantt-style strip showing each
 * housekeeper's day visually. Sits below the AutoAssignBoard on the
 * Schedule tab and shares its data model (cleaning_tasks +
 * hk_assignments) but a richer endpoint (/api/housekeeping/timeline)
 * that adds lifecycle timestamps + the shift window.
 *
 * Visual structure:
 *   - Hour-labelled axis across the top (07 08 09 …)
 *   - One row per housekeeper on shift today, with name + workload chip
 *     at the left and the colored task cards on the right
 *   - A vertical "now" line that crawls left-to-right with the wall clock
 *
 * Card colors track HOUSEKEEPING_FEATURES.md §3:
 *   departure → caramel  | stayover → sage  | deep clean → deep sage
 *   refresh   → sage     | inspection → purple
 *   correction → warm    | room_check → neutral
 * Status outline:
 *   in_progress → caramel pulse with progress fill
 *   behind schedule → warm pulse + warning glyph
 *   completed → faded
 *
 * Interactions (kept in lock-step with AutoAssignBoard):
 *   - Click card → side panel with details
 *   - Drag card to a different housekeeper's row → reassign via
 *     /api/housekeeping/reassign (same endpoint the board uses)
 *   - Filter chips above the grid: floor, cleaning type, "show breaks"
 *
 * Live updates: polls /api/housekeeping/timeline every 8s, plus a 1s
 * tick to keep the now-line and progress fills smooth without
 * refetching. Visibility-aware so the tab pauses when hidden.
 *
 * Design system: Snow tokens via _snow.tsx. No new colors or fonts.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fetchWithAuth } from '@/lib/api-fetch';
import {
  layoutLane,
  nowLineX,
  hourGridlines,
  type LayoutTaskInput,
  type LayoutTaskOutput,
} from '@/lib/timeline-layout';
import { T, FONT_SANS, FONT_MONO, FONT_SERIF, Caps, Pill, Btn, Card, HousekeeperDot } from './_snow';

type Language = 'en' | 'es';

// ───────────────────────────────────────────────────────────────────────
// API types — mirror /api/housekeeping/timeline response.
// ───────────────────────────────────────────────────────────────────────

interface TimelineTask {
  id: string;
  room_number: string;
  cleaning_type: string;
  priority: 'urgent' | 'high' | 'normal' | 'low';
  due_by: string | null;
  status: string;
  estimated_minutes_resolved: number;
  requires_inspection: boolean;
  extras: string[];
  assignee_id: string | null;
  queue_order: number;
  started_at: string | null;
  completed_at: string | null;
}

interface TimelineHk {
  id: string;
  name: string;
  language: 'en' | 'es';
  is_senior: boolean;
  is_active: boolean;
  scheduled_today: boolean;
  workload_minutes: number;
}

interface ShiftWindow {
  date: string;
  timezone: string;
  start_iso: string;
  end_iso: string;
  shift_minutes: number;
}

interface TimelineData {
  tasks: TimelineTask[];
  housekeepers: TimelineHk[];
  unassigned: number;
  shift: ShiftWindow;
}

// ───────────────────────────────────────────────────────────────────────
// Local translations
// ───────────────────────────────────────────────────────────────────────

const STR = {
  title: (l: Language) => l === 'es' ? 'Línea de tiempo' : 'Timeline',
  subtitle: (l: Language) =>
    l === 'es'
      ? 'Día visual de cada camarera — arrastra para reasignar'
      : 'Each housekeeper\'s day at a glance — drag a card to reassign',
  rooms: (l: Language) => l === 'es' ? 'cuartos' : 'rooms',
  reassignFailed: (l: Language) => l === 'es' ? 'Falló la reasignación' : 'Reassign failed',
  retry: (l: Language) => l === 'es' ? 'Reintentar' : 'Retry',
  loadFailed: (l: Language) => l === 'es' ? 'No se pudo cargar' : 'Failed to load',
  noScheduled: (l: Language) =>
    l === 'es'
      ? 'Aún no hay turno programado para hoy.'
      : 'No housekeepers scheduled for today yet.',
  filterFloor: (l: Language) => l === 'es' ? 'Piso' : 'Floor',
  filterType: (l: Language) => l === 'es' ? 'Tipo' : 'Type',
  filterAll: (l: Language) => l === 'es' ? 'Todos' : 'All',
  close: (l: Language) => l === 'es' ? 'Cerrar' : 'Close',
  taskDetails: (l: Language) => l === 'es' ? 'Detalles' : 'Task details',
  type: (l: Language) => l === 'es' ? 'Tipo' : 'Type',
  status: (l: Language) => l === 'es' ? 'Estado' : 'Status',
  estMin: (l: Language) => l === 'es' ? 'Min. estimados' : 'Est. minutes',
  dueBy: (l: Language) => l === 'es' ? 'Antes de' : 'Due by',
  startedAt: (l: Language) => l === 'es' ? 'Iniciado' : 'Started',
  finishedAt: (l: Language) => l === 'es' ? 'Terminado' : 'Finished',
};

// ───────────────────────────────────────────────────────────────────────
// Color mapping for cleaning_type → tone (matches FEATURES §3).
// ───────────────────────────────────────────────────────────────────────

interface TypeStyle {
  fill: string;       // card background tint
  border: string;     // left bar + outline
  ink: string;        // foreground / text
  label: string;      // short uppercase label
}

function typeStyle(cleaningType: string, lang: Language): TypeStyle {
  const en = lang === 'en';
  switch (cleaningType) {
    case 'departure':
    case 'departure_deep':
      return {
        fill: 'rgba(215,176,126,0.18)',
        border: T.caramelDeep,
        ink: T.caramelDeep,
        label: en
          ? (cleaningType === 'departure_deep' ? 'DEP DEEP' : 'DEPARTURE')
          : (cleaningType === 'departure_deep' ? 'SAL PROF' : 'SALIDA'),
      };
    case 'stayover':
      return {
        fill: 'rgba(92,122,96,0.14)',
        border: T.sageDeep,
        ink: T.sageDeep,
        label: en ? 'STAYOVER' : 'CONTINÚA',
      };
    case 'refresh':
      return {
        fill: 'rgba(92,122,96,0.10)',
        border: T.sage,
        ink: T.sageDeep,
        label: en ? 'REFRESH' : 'RETOQUE',
      };
    case 'deep':
      return {
        fill: 'rgba(92,122,96,0.22)',
        border: '#3F5D49',
        ink: '#3F5D49',
        label: en ? 'DEEP' : 'PROFUNDA',
      };
    case 'inspection_only':
      return {
        fill: 'rgba(123,106,151,0.16)',
        border: T.purple,
        ink: T.purple,
        label: en ? 'INSPECTION' : 'INSPEC',
      };
    case 'room_check':
      return {
        fill: '#F7F5EE',
        border: T.ink3,
        ink: T.ink2,
        label: en ? 'CHECK' : 'REVISIÓN',
      };
    case 'no_clean':
      return {
        fill: '#F7F5EE',
        border: T.ruleSoft,
        ink: T.ink3,
        label: en ? 'NO CLEAN' : 'NO LIMP',
      };
    default:
      return {
        fill: 'rgba(92,122,96,0.10)',
        border: T.sageDeep,
        ink: T.sageDeep,
        label: cleaningType.replace(/_/g, ' ').toUpperCase().slice(0, 9),
      };
  }
}

// ───────────────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────────────

function fmtMinutes(mins: number): string {
  if (mins < 60) return `${Math.round(mins)}m`;
  const h = Math.floor(mins / 60);
  const m = Math.round(mins % 60);
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

function fmtHourLabel(ms: number, timezone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: 'numeric',
    hour12: true,
  }).format(new Date(ms));
}

function fmtTimeLabel(iso: string, timezone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(new Date(iso));
}

/** Extract a floor number from a room number ("203" → "2", "1014" → "10"). */
function floorOf(roomNumber: string): string {
  if (!roomNumber) return '?';
  const digits = roomNumber.replace(/\D/g, '');
  if (digits.length >= 4) return digits.slice(0, 2);
  if (digits.length === 3) return digits.slice(0, 1);
  if (digits.length === 2) return digits.slice(0, 1);
  return '?';
}

// ───────────────────────────────────────────────────────────────────────
// Component
// ───────────────────────────────────────────────────────────────────────

const ROW_HEIGHT = 56;
const GUTTER_PX = 168;
const POLL_MS = 8000;
const TICK_MS = 1000;

export function TimelineView({
  propertyId,
  shiftDate,
  lang,
}: {
  propertyId: string;
  shiftDate: string;
  lang: Language;
}) {
  const [data, setData] = useState<TimelineData | null>(null);
  const [loadState, setLoadState] = useState<'loading' | 'ok' | 'error'>('loading');
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [openTask, setOpenTask] = useState<TimelineTask | null>(null);
  const [draggingTaskId, setDraggingTaskId] = useState<string | null>(null);
  const [hoverLaneHkId, setHoverLaneHkId] = useState<string | null>(null);
  const [reassignErr, setReassignErr] = useState<string | null>(null);
  const [filterFloor, setFilterFloor] = useState<string>('all');
  const [filterType, setFilterType] = useState<string>('all');
  const [plotWidth, setPlotWidth] = useState<number>(720);
  const [nowMs, setNowMs] = useState<number>(() => Date.now());

  const plotRef = useRef<HTMLDivElement | null>(null);
  // Mounted flag so the polling fetch + reassign optimistic update don't
  // setState on an unmounted component (React 18+ warns; harmless but ugly).
  // Refs survive re-renders, so this is the standard pattern.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  // ── 1s tick — keeps now-line + in-progress fills smooth without refetch
  useEffect(() => {
    const id = window.setInterval(() => {
      if (mountedRef.current) setNowMs(Date.now());
    }, TICK_MS);
    return () => window.clearInterval(id);
  }, []);

  // ── Resize observer — recompute pxPerMinute when the plot area resizes
  useEffect(() => {
    const el = plotRef.current;
    if (!el) return;
    const ro = new ResizeObserver(entries => {
      for (const e of entries) {
        const w = Math.max(360, e.contentRect.width);
        setPlotWidth(w);
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // ── Polling fetch with visibility gating + mounted-guard so a late
  //    response after unmount doesn't trigger a setState warning.
  const refresh = useCallback(async () => {
    try {
      const res = await fetchWithAuth(
        `/api/housekeeping/timeline?propertyId=${encodeURIComponent(propertyId)}&date=${encodeURIComponent(shiftDate)}`,
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error ?? `HTTP ${res.status}`);
      }
      const body = (await res.json()) as { ok: boolean; data?: TimelineData; error?: string };
      if (!body.ok || !body.data) throw new Error(body.error ?? 'unknown error');
      if (!mountedRef.current) return;
      setData(body.data);
      setLoadErr(null);
      setLoadState('ok');
    } catch (e) {
      if (!mountedRef.current) return;
      setLoadErr(e instanceof Error ? e.message : String(e));
      setLoadState(prev => (prev === 'ok' ? 'ok' : 'error'));
    }
  }, [propertyId, shiftDate]);

  useEffect(() => {
    void refresh();
    let timer: number | null = null;
    const tick = () => { void refresh(); timer = window.setTimeout(tick, POLL_MS); };
    timer = window.setTimeout(tick, POLL_MS);
    const onVis = () => { if (document.visibilityState === 'visible') void refresh(); };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      if (timer != null) window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [refresh]);

  // ── Derived: shift window + pxPerMinute
  const shiftStartMs = data ? Date.parse(data.shift.start_iso) : 0;
  const shiftEndMs = data ? Date.parse(data.shift.end_iso) : 0;
  const shiftMinutes = data?.shift.shift_minutes ?? 480;
  const pxPerMinute = data ? plotWidth / Math.max(60, shiftMinutes) : 1;

  // ── Filter + group tasks by housekeeper
  const filteredTasks = useMemo(() => {
    if (!data) return [] as TimelineTask[];
    return data.tasks.filter(t => {
      if (filterFloor !== 'all' && floorOf(t.room_number) !== filterFloor) return false;
      if (filterType !== 'all' && t.cleaning_type !== filterType) return false;
      return true;
    });
  }, [data, filterFloor, filterType]);

  const lanesByHk = useMemo(() => {
    const grouped = new Map<string, LayoutTaskInput[]>();
    for (const t of filteredTasks) {
      if (!t.assignee_id) continue;
      const arr = grouped.get(t.assignee_id) ?? [];
      arr.push({
        id: t.id,
        queue_order: t.queue_order,
        estimated_minutes_resolved: t.estimated_minutes_resolved,
        status: t.status,
        started_at: t.started_at,
        completed_at: t.completed_at,
      });
      grouped.set(t.assignee_id, arr);
    }
    for (const arr of grouped.values()) {
      arr.sort((a, b) => {
        if (a.queue_order !== b.queue_order) return a.queue_order - b.queue_order;
        // Deterministic tiebreaker so two tasks with the same queue_order
        // always lay out in the same order across renders.
        return a.id.localeCompare(b.id);
      });
    }
    return grouped;
  }, [filteredTasks]);

  // ── Filter dropdown choices — derive from the full task set, not the
  //    filtered set, so a "Floor 3" filter doesn't make the dropdown
  //    forget the other floors exist.
  const floorOptions = useMemo(() => {
    if (!data) return [] as string[];
    const set = new Set<string>();
    for (const t of data.tasks) set.add(floorOf(t.room_number));
    return Array.from(set).sort();
  }, [data]);
  const typeOptions = useMemo(() => {
    if (!data) return [] as string[];
    const set = new Set<string>();
    for (const t of data.tasks) set.add(t.cleaning_type);
    return Array.from(set).sort();
  }, [data]);

  // ── Hour gridlines + now-line position
  const gridlines = useMemo(() => {
    if (!data) return [] as Array<{ x: number; ms: number }>;
    return hourGridlines({ shiftStartMs, shiftEndMs, pxPerMinute });
  }, [data, shiftStartMs, shiftEndMs, pxPerMinute]);

  const nowX = data
    ? nowLineX(nowMs, { shiftStartMs, shiftEndMs, pxPerMinute })
    : null;

  // ── Drag-and-drop reassign — same endpoint as the board view
  const onDragStartCard = useCallback((taskId: string) => {
    setDraggingTaskId(taskId);
    setReassignErr(null);
  }, []);
  const onDragEnd = useCallback(() => {
    setDraggingTaskId(null);
    setHoverLaneHkId(null);
  }, []);
  const onLaneDragOver = useCallback((hkId: string, e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (hkId !== hoverLaneHkId) setHoverLaneHkId(hkId);
  }, [hoverLaneHkId]);
  const onLaneDrop = useCallback(async (hkId: string) => {
    const taskId = draggingTaskId;
    setDraggingTaskId(null);
    setHoverLaneHkId(null);
    if (!taskId || !data) return;
    const task = data.tasks.find(t => t.id === taskId);
    if (!task || task.assignee_id === hkId) return;
    // Optimistic update for snappy feel; rollback on failure.
    const prev = data;
    setData(d => {
      if (!d) return d;
      const tasks = d.tasks.map(t => t.id === task.id ? { ...t, assignee_id: hkId } : t);
      return { ...d, tasks };
    });
    try {
      const res = await fetchWithAuth('/api/housekeeping/reassign', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ propertyId, taskId: task.id, toHousekeeperId: hkId }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error ?? `HTTP ${res.status}`);
      }
      await refresh();
    } catch (e) {
      if (!mountedRef.current) return;
      setData(prev);
      setReassignErr(e instanceof Error ? e.message : String(e));
    }
  }, [draggingTaskId, data, propertyId, refresh]);

  // ── Render
  const hasAnyData = !!data && data.housekeepers.length > 0;
  const scheduledHks = data?.housekeepers.filter(h => h.is_active && h.scheduled_today) ?? [];

  return (
    <Card padding="0">
      {/* Header */}
      <div style={{
        padding: '18px 22px 14px',
        borderBottom: `1px solid ${T.rule}`,
        display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between',
        gap: 16, flexWrap: 'wrap',
      }}>
        <div style={{ flex: 1, minWidth: 260 }}>
          <div style={{
            fontFamily: FONT_SERIF, fontSize: 22, color: T.ink, letterSpacing: '-0.01em',
          }}>{STR.title(lang)}</div>
          <div style={{
            fontFamily: FONT_SANS, fontSize: 13, color: T.ink2, marginTop: 4,
          }}>{STR.subtitle(lang)}</div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          {/* Floor filter */}
          {floorOptions.length > 1 && (
            <FilterChips
              label={STR.filterFloor(lang)}
              allLabel={STR.filterAll(lang)}
              value={filterFloor}
              onChange={setFilterFloor}
              options={floorOptions}
            />
          )}
          {/* Type filter */}
          {typeOptions.length > 1 && (
            <FilterChips
              label={STR.filterType(lang)}
              allLabel={STR.filterAll(lang)}
              value={filterType}
              onChange={setFilterType}
              options={typeOptions}
              formatOption={(o) => o.replace(/_/g, ' ')}
            />
          )}
          <Btn size="sm" onClick={() => void refresh()}>↻</Btn>
        </div>
      </div>

      {/* Error banner */}
      {reassignErr && (
        <div style={{
          padding: '10px 22px',
          background: T.warmDim,
          borderBottom: `1px solid ${T.rule}`,
          color: T.warm,
          fontFamily: FONT_SANS, fontSize: 12,
        }}>{STR.reassignFailed(lang)}: {reassignErr}</div>
      )}

      {/* Loading / error / empty */}
      {loadState === 'loading' && !data && (
        <div style={{ padding: '40px 22px', textAlign: 'center', color: T.ink3, fontFamily: FONT_SANS, fontSize: 14 }}>
          …
        </div>
      )}

      {loadState === 'error' && !data && (
        <div style={{ padding: '24px 22px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10 }}>
          <div style={{ color: T.warm, fontFamily: FONT_SANS, fontSize: 13 }}>
            {STR.loadFailed(lang)}: {loadErr}
          </div>
          <Btn size="sm" onClick={() => void refresh()}>{STR.retry(lang)}</Btn>
        </div>
      )}

      {loadState === 'ok' && data && !hasAnyData && (
        <div style={{
          padding: '40px 22px', textAlign: 'center', color: T.ink2,
          fontFamily: FONT_SANS, fontSize: 14, lineHeight: 1.5,
        }}>{STR.noScheduled(lang)}</div>
      )}

      {/* Grid */}
      {data && hasAnyData && (
        <div style={{ padding: '14px 18px 18px' }}>
          {/* Time axis header */}
          <div style={{
            display: 'grid',
            gridTemplateColumns: `${GUTTER_PX}px 1fr`,
            alignItems: 'end',
            paddingBottom: 6,
          }}>
            <div />
            <div
              ref={plotRef}
              style={{
                position: 'relative',
                height: 22,
                borderBottom: `1px solid ${T.rule}`,
              }}
            >
              {gridlines.map((g, i) => (
                <React.Fragment key={i}>
                  <div style={{
                    position: 'absolute',
                    left: g.x, bottom: 0, top: 8,
                    width: 1, background: T.ruleSoft,
                  }} />
                  <div style={{
                    position: 'absolute',
                    left: g.x, bottom: 4,
                    transform: 'translateX(-50%)',
                    fontFamily: FONT_MONO, fontSize: 10,
                    color: T.ink3, letterSpacing: '0.04em',
                    whiteSpace: 'nowrap', padding: '0 4px',
                    background: T.paper,
                  }}>{fmtHourLabel(g.ms, data.shift.timezone)}</div>
                </React.Fragment>
              ))}
            </div>
          </div>

          {/* Rows */}
          {scheduledHks.length === 0 && (
            <div style={{
              padding: '24px 22px', textAlign: 'center', color: T.ink3,
              fontFamily: FONT_SANS, fontSize: 13,
            }}>{STR.noScheduled(lang)}</div>
          )}
          {scheduledHks.map(hk => {
            const tasks = lanesByHk.get(hk.id) ?? [];
            const laid = layoutLane(tasks, { shiftStartMs, pxPerMinute, nowMs });
            const isHover = hoverLaneHkId === hk.id;
            const myTaskCount = filteredTasks.filter(t => t.assignee_id === hk.id).length;
            return (
              <div
                key={hk.id}
                style={{
                  display: 'grid',
                  gridTemplateColumns: `${GUTTER_PX}px 1fr`,
                  alignItems: 'center',
                  borderBottom: `1px solid ${T.ruleSoft}`,
                  minHeight: ROW_HEIGHT,
                }}
              >
                {/* Row header */}
                <div style={{
                  paddingRight: 12,
                  display: 'flex', alignItems: 'center', gap: 10,
                  minHeight: ROW_HEIGHT,
                }}>
                  <HousekeeperDot staff={{ id: hk.id, name: hk.name }} size={26} />
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{
                      fontFamily: FONT_SANS, fontSize: 13, fontWeight: 600,
                      color: T.ink, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                    }}>{hk.name}</div>
                    <div style={{
                      fontFamily: FONT_MONO, fontSize: 10, color: T.ink3, marginTop: 1,
                      whiteSpace: 'nowrap',
                    }}>
                      {myTaskCount}&nbsp;{STR.rooms(lang)} · {fmtMinutes(hk.workload_minutes)}
                    </div>
                  </div>
                </div>

                {/* Lane */}
                <div
                  onDragOver={(e) => onLaneDragOver(hk.id, e)}
                  onDrop={() => void onLaneDrop(hk.id)}
                  style={{
                    position: 'relative',
                    height: ROW_HEIGHT,
                    background: isHover ? T.sageDim : 'transparent',
                    transition: 'background 120ms ease',
                  }}
                >
                  {/* Gridlines */}
                  {gridlines.map((g, i) => (
                    <div key={i} style={{
                      position: 'absolute', left: g.x, top: 0, bottom: 0,
                      width: 1, background: T.ruleSoft,
                    }} />
                  ))}
                  {/* Cards */}
                  {laid.map(layout => {
                    const task = filteredTasks.find(t => t.id === layout.id);
                    if (!task) return null;
                    return (
                      <TimelineCard
                        key={task.id}
                        task={task}
                        layout={layout}
                        lang={lang}
                        timezone={data.shift.timezone}
                        onClick={() => setOpenTask(task)}
                        onDragStart={() => onDragStartCard(task.id)}
                        onDragEnd={onDragEnd}
                      />
                    );
                  })}
                </div>
              </div>
            );
          })}

          {/* Floating "now" line — drawn ABOVE the rows so it shows
              across every housekeeper. Positioned with the same
              pxPerMinute that drove the cards. */}
          {nowX != null && scheduledHks.length > 0 && (
            <NowLine
              x={nowX + GUTTER_PX}
              top={36}
              height={scheduledHks.length * ROW_HEIGHT}
              lang={lang}
            />
          )}
        </div>
      )}

      {/* Side panel — task detail */}
      {openTask && (
        <TaskDetailPanel
          task={openTask}
          lang={lang}
          timezone={data?.shift.timezone ?? 'America/Chicago'}
          onClose={() => setOpenTask(null)}
        />
      )}
    </Card>
  );
}

// ───────────────────────────────────────────────────────────────────────
// Single card
// ───────────────────────────────────────────────────────────────────────

function TimelineCard({
  task, layout, lang, timezone, onClick, onDragStart, onDragEnd,
}: {
  task: TimelineTask;
  layout: LayoutTaskOutput;
  lang: Language;
  timezone: string;
  onClick: () => void;
  onDragStart: () => void;
  onDragEnd: () => void;
}) {
  const style = typeStyle(task.cleaning_type, lang);
  const isCompleted = layout.status === 'completed'
    || layout.status === 'inspected_pass'
    || layout.status === 'inspected_fail'
    || layout.status === 'correction_complete';
  const isInProgress = layout.status === 'in_progress';
  const isLocked = isCompleted || isInProgress || layout.status === 'inspection_pending';
  const cardBg = isCompleted ? '#FBFAF6' : style.fill;
  const cardOpacity = isCompleted ? 0.55 : 1;
  const outline = layout.is_behind
    ? `2px solid ${T.warm}`
    : task.status === 'inspected_fail' || task.status === 'correction_pending'
      ? `2px solid ${T.red}`
      : `1px solid ${style.border}`;

  return (
    <button
      type="button"
      draggable={!isLocked}
      onDragStart={(e) => {
        if (isLocked) { e.preventDefault(); return; }
        try { e.dataTransfer.setData('text/plain', task.id); } catch { /* ignore */ }
        e.dataTransfer.effectAllowed = 'move';
        onDragStart();
      }}
      onDragEnd={onDragEnd}
      onClick={onClick}
      title={`${task.room_number} · ${style.label} · ${fmtMinutes(layout.estimated_minutes_resolved)} · ${fmtTimeLabel(new Date(layout.start_ms).toISOString(), timezone)}`}
      aria-label={`Room ${task.room_number} ${task.cleaning_type}`}
      style={{
        position: 'absolute',
        left: layout.x,
        top: 6,
        bottom: 6,
        width: layout.width,
        background: cardBg,
        border: outline,
        borderLeft: `4px solid ${style.border}`,
        borderRadius: 8,
        padding: '4px 6px',
        opacity: cardOpacity,
        cursor: isLocked ? 'not-allowed' : 'grab',
        display: 'flex', flexDirection: 'column', justifyContent: 'space-between',
        gap: 2,
        overflow: 'hidden',
        fontFamily: FONT_SANS,
        textAlign: 'left',
        boxShadow: isInProgress ? `0 0 0 2px rgba(140,106,51,0.18)` : undefined,
      }}
    >
      {/* Progress fill for in-progress */}
      {isInProgress && layout.progress != null && (
        <div style={{
          position: 'absolute', left: 0, top: 0, bottom: 0,
          width: `${Math.round(layout.progress * 100)}%`,
          background: 'rgba(140,106,51,0.18)',
          pointerEvents: 'none',
        }} />
      )}
      <div style={{
        position: 'relative',
        display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 4,
      }}>
        <span style={{
          fontFamily: FONT_SERIF, fontSize: 15, fontWeight: 400,
          color: style.ink, letterSpacing: '-0.01em',
          textDecoration: isCompleted ? 'line-through' : 'none',
        }}>{task.room_number}</span>
        {layout.is_behind && (
          <span style={{
            fontFamily: FONT_MONO, fontSize: 9, fontWeight: 700, color: T.warm,
          }}>!</span>
        )}
      </div>
      {layout.width >= 60 && (
        <span style={{
          position: 'relative',
          fontFamily: FONT_MONO, fontSize: 8, fontWeight: 600,
          color: style.ink, letterSpacing: '0.06em', textTransform: 'uppercase',
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        }}>{style.label}</span>
      )}
    </button>
  );
}

// ───────────────────────────────────────────────────────────────────────
// "Now" indicator — vertical line + tiny pill label
// ───────────────────────────────────────────────────────────────────────

function NowLine({ x, top, height, lang }: { x: number; top: number; height: number; lang: Language }) {
  return (
    <div style={{
      position: 'absolute',
      left: x,
      top,
      height,
      width: 2,
      background: T.warm,
      pointerEvents: 'none',
      zIndex: 2,
    }}>
      <span style={{
        position: 'absolute',
        top: -16, left: 0,
        transform: 'translateX(-50%)',
        background: T.warm,
        color: '#fff',
        fontFamily: FONT_MONO, fontSize: 9, fontWeight: 600,
        letterSpacing: '0.08em', textTransform: 'uppercase',
        padding: '2px 6px', borderRadius: 4,
        whiteSpace: 'nowrap',
      }}>{lang === 'es' ? 'AHORA' : 'NOW'}</span>
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────
// Filter chip group
// ───────────────────────────────────────────────────────────────────────

function FilterChips({
  label, allLabel, value, onChange, options, formatOption,
}: {
  label: string;
  allLabel: string;
  value: string;
  onChange: (v: string) => void;
  options: string[];
  formatOption?: (o: string) => string;
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
      <Caps>{label}</Caps>
      <div style={{ display: 'flex', gap: 2 }}>
        <ChipBtn active={value === 'all'} onClick={() => onChange('all')}>{allLabel}</ChipBtn>
        {options.map(o => (
          <ChipBtn key={o} active={value === o} onClick={() => onChange(o)}>
            {formatOption ? formatOption(o) : o}
          </ChipBtn>
        ))}
      </div>
    </div>
  );
}

function ChipBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        height: 24, padding: '0 8px', borderRadius: 999,
        background: active ? T.ink : 'transparent',
        color: active ? T.bg : T.ink2,
        border: `1px solid ${active ? T.ink : T.rule}`,
        fontFamily: FONT_SANS, fontSize: 11, fontWeight: 500,
        cursor: 'pointer', whiteSpace: 'nowrap', textTransform: 'capitalize',
      }}
    >{children}</button>
  );
}

// ───────────────────────────────────────────────────────────────────────
// Task detail side panel — kept light; shares shape with AutoAssignBoard's
// TaskDetailPanel but isn't imported from there so the two components
// stay decoupled.
// ───────────────────────────────────────────────────────────────────────

function TaskDetailPanel({
  task, lang, timezone, onClose,
}: { task: TimelineTask; lang: Language; timezone: string; onClose: () => void }) {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeRef.current(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(26,31,27,0.32)',
        display: 'flex', justifyContent: 'flex-end', zIndex: 50,
      }}
      role="dialog" aria-modal="true"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 'min(420px, 92vw)',
          background: T.paper, height: '100%',
          padding: '22px 22px 28px',
          borderLeft: `1px solid ${T.rule}`,
          display: 'flex', flexDirection: 'column', gap: 16,
          overflowY: 'auto',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div>
            <Caps>{STR.taskDetails(lang)}</Caps>
            <div style={{
              fontFamily: FONT_SERIF, fontSize: 28, color: T.ink, marginTop: 4, letterSpacing: '-0.02em',
            }}>{task.room_number}</div>
          </div>
          <Btn size="sm" onClick={onClose}>{STR.close(lang)}</Btn>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <DetailRow label={STR.type(lang)} value={task.cleaning_type.replace(/_/g, ' ')} />
          <DetailRow label={STR.status(lang)} value={task.status.replace(/_/g, ' ')} />
          <DetailRow label={STR.estMin(lang)} value={fmtMinutes(task.estimated_minutes_resolved)} />
          {task.due_by && (
            <DetailRow label={STR.dueBy(lang)} value={fmtTimeLabel(task.due_by, timezone)} />
          )}
          {task.started_at && (
            <DetailRow label={STR.startedAt(lang)} value={fmtTimeLabel(task.started_at, timezone)} />
          )}
          {task.completed_at && (
            <DetailRow label={STR.finishedAt(lang)} value={fmtTimeLabel(task.completed_at, timezone)} />
          )}
          {task.extras.length > 0 && (
            <div>
              <Caps>Extras</Caps>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
                {task.extras.map(x => <Pill key={x} tone="caramel">{x.replace(/_/g, ' ')}</Pill>)}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <Caps>{label}</Caps>
      <div style={{ fontFamily: FONT_SANS, fontSize: 14, color: T.ink, textTransform: 'capitalize' }}>{value}</div>
    </div>
  );
}
