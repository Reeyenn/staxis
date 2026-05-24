'use client';

/**
 * AutoAssignBoard — manager-facing view of the new auto-assignment
 * engine. Renders a column per housekeeper with stacked task tiles,
 * supports drag-and-drop reassignment with a live workload preview,
 * and opens a side panel when a task is clicked.
 *
 * This sits alongside the existing Schedule tab UI (which is plumbed
 * to the legacy plan_snapshots / schedule_assignments system). The
 * Auto-Assign Board reads from cleaning_tasks + hk_assignments (the
 * new system) via /api/housekeeping/board. When neither table has
 * rows for today, the board collapses to a "no auto-assigned work
 * yet" placeholder — safe to render in production before the rules
 * engine runs for the first time.
 *
 * Design system: Snow tokens via _snow.tsx. No new top-level colors;
 * no new fonts. The drag affordances reuse the same warm/sage/caramel
 * accent palette already in use across the housekeeping tabs.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fetchWithAuth } from '@/lib/api-fetch';
import { T, FONT_SANS, FONT_MONO, FONT_SERIF, Caps, Pill, Btn, Card, HousekeeperDot } from './_snow';

type Language = 'en' | 'es';

// ───────────────────────────────────────────────────────────────────────
// API types — mirror /api/housekeeping/board response.
// ───────────────────────────────────────────────────────────────────────

interface BoardTask {
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
  assignment_reason: string | null;
  assigned_by: string | null;
}

interface BoardHk {
  id: string;
  name: string;
  language: 'en' | 'es';
  is_senior: boolean;
  is_active: boolean;
  scheduled_today: boolean;
  workload_minutes: number;
}

interface BoardData {
  tasks: BoardTask[];
  housekeepers: BoardHk[];
  unassigned: number;
}

// ───────────────────────────────────────────────────────────────────────
// Local translations — keep the global TranslationKey union untouched.
// ───────────────────────────────────────────────────────────────────────

const STR = {
  title: (l: Language) => l === 'es' ? 'Auto-asignación' : 'Auto-Assignment Board',
  subtitle: (l: Language) =>
    l === 'es'
      ? 'Tareas de limpieza generadas por reglas — arrastra para reasignar'
      : 'Rules-engine cleaning tasks — drag to reassign between housekeepers',
  empty: (l: Language) =>
    l === 'es'
      ? 'Aún no hay tareas para hoy. Aparecerán aquí cuando el motor de reglas las cree.'
      : 'No tasks for today yet. They\'ll appear here once the rules engine runs.',
  unassigned: (l: Language) => l === 'es' ? 'Sin asignar' : 'Unassigned',
  rush: (l: Language) => l === 'es' ? 'Urgente' : 'Rush',
  inspection: (l: Language) => l === 'es' ? 'Inspección' : 'Inspection',
  reassigning: (l: Language) => l === 'es' ? 'Reasignando…' : 'Reassigning…',
  reassignFailed: (l: Language) => l === 'es' ? 'Reasignación falló' : 'Reassignment failed',
  cancel: (l: Language) => l === 'es' ? 'Cancelar' : 'Cancel',
  close: (l: Language) => l === 'es' ? 'Cerrar' : 'Close',
  loadFailed: (l: Language) => l === 'es' ? 'No se pudo cargar' : 'Failed to load',
  retry: (l: Language) => l === 'es' ? 'Reintentar' : 'Retry',
  workloadPreview: (l: Language) => l === 'es' ? 'Previsualización' : 'Workload preview',
  taskDetails: (l: Language) => l === 'es' ? 'Detalles de tarea' : 'Task details',
  room: (l: Language) => l === 'es' ? 'Cuarto' : 'Room',
  type: (l: Language) => l === 'es' ? 'Tipo' : 'Type',
  estMin: (l: Language) => l === 'es' ? 'Min. estimados' : 'Est. minutes',
  dueBy: (l: Language) => l === 'es' ? 'Antes de' : 'Due by',
  reason: (l: Language) => l === 'es' ? 'Razón' : 'Reason',
  assignedBy: (l: Language) => l === 'es' ? 'Asignado por' : 'Assigned by',
  status: (l: Language) => l === 'es' ? 'Estado' : 'Status',
  noTasksHere: (l: Language) => l === 'es' ? 'Sin tareas todavía' : 'No tasks yet',
  shiftPctLabel: (l: Language) => l === 'es' ? 'del turno' : 'of shift',
  outToday: (l: Language) => l === 'es' ? 'Fuera hoy' : 'Off today',
};

// ───────────────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────────────

function fmtMinutes(mins: number): string {
  if (mins < 60) return `${Math.round(mins)}m`;
  const h = Math.floor(mins / 60);
  const m = Math.round(mins % 60);
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

function priorityTone(p: BoardTask['priority']): 'warm' | 'caramel' | 'sage' | 'neutral' {
  if (p === 'urgent') return 'warm';
  if (p === 'high') return 'caramel';
  if (p === 'normal') return 'neutral';
  return 'sage';
}

function priorityLabel(p: BoardTask['priority'], lang: Language): string {
  if (p === 'urgent') return lang === 'es' ? 'Urgente' : 'Urgent';
  if (p === 'high') return lang === 'es' ? 'Alta' : 'High';
  if (p === 'normal') return lang === 'es' ? 'Normal' : 'Normal';
  return lang === 'es' ? 'Baja' : 'Low';
}

// ───────────────────────────────────────────────────────────────────────
// Component
// ───────────────────────────────────────────────────────────────────────

export function AutoAssignBoard({
  propertyId,
  shiftDate,
  shiftMinutes = 420,
  lang,
}: {
  propertyId: string;
  shiftDate: string;
  shiftMinutes?: number;
  lang: Language;
}) {
  const [data, setData] = useState<BoardData | null>(null);
  const [loadState, setLoadState] = useState<'loading' | 'ok' | 'error'>('loading');
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [openTask, setOpenTask] = useState<BoardTask | null>(null);
  const [reassignErr, setReassignErr] = useState<string | null>(null);

  // Drag state — the task being held + the column being hovered. Drives
  // the preview math without committing to the DB until drop.
  const [draggingTaskId, setDraggingTaskId] = useState<string | null>(null);
  const [hoverColumnHkId, setHoverColumnHkId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoadState(prev => (prev === 'ok' ? 'ok' : 'loading'));
    try {
      const res = await fetchWithAuth(
        `/api/housekeeping/board?propertyId=${encodeURIComponent(propertyId)}&date=${encodeURIComponent(shiftDate)}`,
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error ?? `HTTP ${res.status}`);
      }
      const body = (await res.json()) as { ok: boolean; data?: BoardData; error?: string };
      if (!body.ok || !body.data) throw new Error(body.error ?? 'unknown error');
      setData(body.data);
      setLoadErr(null);
      setLoadState('ok');
    } catch (e) {
      setLoadErr(e instanceof Error ? e.message : String(e));
      setLoadState('error');
    }
  }, [propertyId, shiftDate]);

  useEffect(() => { void refresh(); }, [refresh]);

  // ── Drag handlers ─────────────────────────────────────────────────────
  const onDragStartTask = useCallback((taskId: string) => {
    setDraggingTaskId(taskId);
    setReassignErr(null);
  }, []);

  const onDragOverColumn = useCallback(
    (hkId: string, e: React.DragEvent) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      if (hkId !== hoverColumnHkId) setHoverColumnHkId(hkId);
    },
    [hoverColumnHkId],
  );

  const onDragLeaveColumn = useCallback(() => {
    setHoverColumnHkId(null);
  }, []);

  const onDragEnd = useCallback(() => {
    setDraggingTaskId(null);
    setHoverColumnHkId(null);
  }, []);

  const onDropOnColumn = useCallback(
    async (hkId: string) => {
      const taskId = draggingTaskId;
      setDraggingTaskId(null);
      setHoverColumnHkId(null);
      if (!taskId || !data) return;
      const task = data.tasks.find(t => t.id === taskId);
      if (!task) return;
      if (task.assignee_id === hkId) return; // dropped back on same column
      // Optimistic update — flip the assignee locally so the column
      // count moves immediately. Roll back on error.
      const prev = data;
      const taskMinutes = task.estimated_minutes_resolved;
      const oldHkId = task.assignee_id;
      setData(prevData => {
        if (!prevData) return prevData;
        const tasks = prevData.tasks.map(t =>
          t.id === task.id ? { ...t, assignee_id: hkId, assigned_by: 'manual' } : t,
        );
        const housekeepers = prevData.housekeepers.map(h => {
          if (h.id === hkId) return { ...h, workload_minutes: h.workload_minutes + taskMinutes };
          if (oldHkId && h.id === oldHkId) {
            return { ...h, workload_minutes: Math.max(0, h.workload_minutes - taskMinutes) };
          }
          return h;
        });
        return { ...prevData, tasks, housekeepers };
      });
      try {
        const res = await fetchWithAuth('/api/housekeeping/reassign', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            propertyId,
            taskId: task.id,
            toHousekeeperId: hkId,
          }),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body?.error ?? `HTTP ${res.status}`);
        }
        await refresh();
      } catch (e) {
        setData(prev); // rollback
        setReassignErr(e instanceof Error ? e.message : String(e));
      }
    },
    [draggingTaskId, data, propertyId, refresh],
  );

  // ── Workload preview for the hovered column during drag ────────────
  const previewByHk = useMemo(() => {
    const out: Record<string, { before: number; after: number; delta: number }> = {};
    if (!data || !draggingTaskId || !hoverColumnHkId) return out;
    const task = data.tasks.find(t => t.id === draggingTaskId);
    if (!task) return out;
    if (task.assignee_id === hoverColumnHkId) return out;
    const fromHk = task.assignee_id ? data.housekeepers.find(h => h.id === task.assignee_id) : null;
    const toHk = data.housekeepers.find(h => h.id === hoverColumnHkId);
    if (toHk) {
      out[toHk.id] = {
        before: toHk.workload_minutes,
        after: toHk.workload_minutes + task.estimated_minutes_resolved,
        delta: task.estimated_minutes_resolved,
      };
    }
    if (fromHk) {
      out[fromHk.id] = {
        before: fromHk.workload_minutes,
        after: Math.max(0, fromHk.workload_minutes - task.estimated_minutes_resolved),
        delta: -task.estimated_minutes_resolved,
      };
    }
    return out;
  }, [data, draggingTaskId, hoverColumnHkId]);

  // ── Group tasks by hk ─────────────────────────────────────────────
  const tasksByHk = useMemo(() => {
    const grouped = new Map<string, BoardTask[]>();
    const unassigned: BoardTask[] = [];
    if (!data) return { grouped, unassigned };
    for (const t of data.tasks) {
      if (!t.assignee_id) unassigned.push(t);
      else {
        const arr = grouped.get(t.assignee_id) ?? [];
        arr.push(t);
        grouped.set(t.assignee_id, arr);
      }
    }
    // Sort each group by queue_order, then priority, then room number.
    for (const arr of grouped.values()) {
      arr.sort((a, b) => {
        if (a.queue_order !== b.queue_order) return a.queue_order - b.queue_order;
        if (a.priority !== b.priority) {
          const rank = { urgent: 0, high: 1, normal: 2, low: 3 } as const;
          return rank[a.priority] - rank[b.priority];
        }
        return a.room_number.localeCompare(b.room_number);
      });
    }
    unassigned.sort((a, b) => a.room_number.localeCompare(b.room_number));
    return { grouped, unassigned };
  }, [data]);

  // ── Header strip ──────────────────────────────────────────────────
  const hasAnyTasks = (data?.tasks.length ?? 0) > 0;

  return (
    <Card padding="0">
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
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {data && data.unassigned > 0 && (
            <Pill tone="warm">
              {data.unassigned}&nbsp;{STR.unassigned(lang)}
            </Pill>
          )}
          <Btn size="sm" onClick={refresh}>↻</Btn>
        </div>
      </div>

      {/* Error / loading / empty states */}
      {loadState === 'loading' && !data && (
        <div style={{ padding: '40px 22px', textAlign: 'center', color: T.ink3, fontFamily: FONT_SANS, fontSize: 14 }}>
          …
        </div>
      )}

      {loadState === 'error' && (
        <div style={{ padding: '24px 22px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10 }}>
          <div style={{ color: T.warm, fontFamily: FONT_SANS, fontSize: 13 }}>
            {STR.loadFailed(lang)}: {loadErr}
          </div>
          <Btn size="sm" onClick={refresh}>{STR.retry(lang)}</Btn>
        </div>
      )}

      {loadState === 'ok' && data && !hasAnyTasks && (
        <div style={{
          padding: '40px 22px', textAlign: 'center', color: T.ink2,
          fontFamily: FONT_SANS, fontSize: 14, lineHeight: 1.5,
        }}>
          {STR.empty(lang)}
        </div>
      )}

      {reassignErr && (
        <div style={{
          padding: '10px 22px',
          background: T.warmDim,
          borderBottom: `1px solid ${T.rule}`,
          color: T.warm,
          fontFamily: FONT_SANS, fontSize: 12,
        }}>
          {STR.reassignFailed(lang)}: {reassignErr}
        </div>
      )}

      {loadState === 'ok' && data && hasAnyTasks && (
        <div style={{
          display: 'grid',
          gridTemplateColumns: `repeat(auto-fill, minmax(220px, 1fr))`,
          gap: 14, padding: 16,
        }}>
          {/* Unassigned bucket — appears first so the manager sees what needs placement. */}
          <HkColumn
            kind="unassigned"
            lang={lang}
            tasks={tasksByHk.unassigned}
            isDropTarget={false}
            previewMinutes={null}
            shiftMinutes={shiftMinutes}
            workloadMinutes={tasksByHk.unassigned.reduce((s, t) => s + t.estimated_minutes_resolved, 0)}
            housekeeper={null}
            onTaskClick={setOpenTask}
            onDragStartTask={onDragStartTask}
            onDragEndTask={onDragEnd}
          />

          {data.housekeepers.map(hk => {
            const tasks = tasksByHk.grouped.get(hk.id) ?? [];
            const preview = previewByHk[hk.id];
            return (
              <HkColumn
                key={hk.id}
                kind="hk"
                lang={lang}
                housekeeper={hk}
                tasks={tasks}
                workloadMinutes={hk.workload_minutes}
                shiftMinutes={shiftMinutes}
                isDropTarget={draggingTaskId != null}
                previewMinutes={preview?.after ?? null}
                isHoverTarget={hoverColumnHkId === hk.id}
                onTaskClick={setOpenTask}
                onDragStartTask={onDragStartTask}
                onDragEndTask={onDragEnd}
                onColumnDragOver={(e) => onDragOverColumn(hk.id, e)}
                onColumnDragLeave={onDragLeaveColumn}
                onColumnDrop={() => onDropOnColumn(hk.id)}
              />
            );
          })}
        </div>
      )}

      {/* Side panel — task detail. Slides in from the right when a task is clicked. */}
      {openTask && (
        <TaskDetailPanel
          task={openTask}
          lang={lang}
          onClose={() => setOpenTask(null)}
        />
      )}
    </Card>
  );
}

// ───────────────────────────────────────────────────────────────────────
// One column (a housekeeper, or the unassigned bucket)
// ───────────────────────────────────────────────────────────────────────

function HkColumn(props: {
  kind: 'hk' | 'unassigned';
  lang: Language;
  housekeeper: BoardHk | null;
  tasks: BoardTask[];
  workloadMinutes: number;
  shiftMinutes: number;
  isDropTarget: boolean;
  isHoverTarget?: boolean;
  previewMinutes: number | null;
  onTaskClick: (t: BoardTask) => void;
  onDragStartTask: (taskId: string) => void;
  onDragEndTask: () => void;
  onColumnDragOver?: (e: React.DragEvent) => void;
  onColumnDragLeave?: () => void;
  onColumnDrop?: () => void;
}) {
  const {
    kind, lang, housekeeper, tasks, workloadMinutes, shiftMinutes,
    isDropTarget, isHoverTarget, previewMinutes,
    onTaskClick, onDragStartTask, onDragEndTask,
    onColumnDragOver, onColumnDragLeave, onColumnDrop,
  } = props;

  const pct = Math.min(100, Math.round((workloadMinutes / Math.max(1, shiftMinutes)) * 100));
  const previewPct = previewMinutes != null
    ? Math.min(100, Math.round((previewMinutes / Math.max(1, shiftMinutes)) * 100))
    : null;
  const overCap = workloadMinutes > shiftMinutes;
  const isOff = housekeeper && (!housekeeper.is_active || !housekeeper.scheduled_today);

  return (
    <div
      onDragOver={kind === 'hk' && onColumnDragOver ? onColumnDragOver : undefined}
      onDragLeave={kind === 'hk' && onColumnDragLeave ? onColumnDragLeave : undefined}
      onDrop={kind === 'hk' && onColumnDrop ? onColumnDrop : undefined}
      style={{
        background: T.paper,
        border: `1px solid ${isHoverTarget ? T.sageDeep : T.rule}`,
        borderRadius: 14,
        padding: 12,
        boxShadow: isHoverTarget ? `0 0 0 3px ${T.sageDim}` : undefined,
        transition: 'border-color 120ms ease, box-shadow 120ms ease',
        opacity: isOff ? 0.55 : 1,
        minHeight: 200,
        display: 'flex', flexDirection: 'column', gap: 10,
      }}
    >
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, minHeight: 32 }}>
        {kind === 'unassigned' ? (
          <>
            <div style={{
              width: 24, height: 24, borderRadius: '50%',
              background: T.warmDim, border: `1px solid ${T.warm}`,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              color: T.warm, fontFamily: FONT_SANS, fontSize: 12, fontWeight: 700,
            }}>?</div>
            <div style={{ fontFamily: FONT_SANS, fontSize: 14, fontWeight: 600, color: T.ink }}>
              {STR.unassigned(lang)}
            </div>
          </>
        ) : housekeeper ? (
          <>
            <HousekeeperDot staff={{ id: housekeeper.id, name: housekeeper.name }} size={24} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{
                fontFamily: FONT_SANS, fontSize: 14, fontWeight: 600, color: T.ink,
                whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
              }}>
                {housekeeper.name}
              </div>
              <div style={{ fontFamily: FONT_MONO, fontSize: 10, color: T.ink3, marginTop: 2 }}>
                {housekeeper.language.toUpperCase()}{housekeeper.is_senior ? ' · SR' : ''}
                {isOff ? ` · ${STR.outToday(lang).toUpperCase()}` : ''}
              </div>
            </div>
          </>
        ) : null}
      </div>

      {/* Workload bar */}
      {kind === 'hk' && (
        <div>
          <div style={{
            display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
            fontFamily: FONT_MONO, fontSize: 10, color: T.ink2, marginBottom: 4,
          }}>
            <span>
              {fmtMinutes(workloadMinutes)}
              {previewMinutes != null && previewMinutes !== workloadMinutes && (
                <span style={{ color: previewMinutes > workloadMinutes ? T.warm : T.sageDeep, marginLeft: 6 }}>
                  → {fmtMinutes(previewMinutes)}
                </span>
              )}
            </span>
            <span>{pct}% {STR.shiftPctLabel(lang)}</span>
          </div>
          <div style={{
            height: 6, background: T.ruleSoft, borderRadius: 999, overflow: 'hidden', position: 'relative',
          }}>
            <div style={{
              position: 'absolute', left: 0, top: 0, bottom: 0,
              width: `${pct}%`,
              background: overCap ? T.warm : T.sageDeep,
              transition: 'width 200ms ease',
            }} />
            {previewPct != null && previewPct !== pct && (
              <div style={{
                position: 'absolute', left: `${Math.min(pct, previewPct)}%`, top: 0, bottom: 0,
                width: `${Math.abs(previewPct - pct)}%`,
                background: previewPct > pct ? T.warmDim : T.sageDim,
                transition: 'width 200ms ease',
              }} />
            )}
          </div>
        </div>
      )}

      {kind === 'unassigned' && (
        <div style={{
          fontFamily: FONT_MONO, fontSize: 10, color: T.ink2,
        }}>
          {fmtMinutes(workloadMinutes)} total
        </div>
      )}

      {/* Task tiles */}
      {tasks.length === 0 ? (
        <div style={{
          fontFamily: FONT_SANS, fontSize: 12, color: T.ink3,
          textAlign: 'center', padding: '18px 4px',
          border: isDropTarget && kind === 'hk' ? `1px dashed ${T.rule}` : 'none',
          borderRadius: 10,
        }}>
          {STR.noTasksHere(lang)}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {tasks.map(task => (
            <TaskTile
              key={task.id}
              task={task}
              lang={lang}
              onClick={() => onTaskClick(task)}
              onDragStart={() => onDragStartTask(task.id)}
              onDragEnd={onDragEndTask}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────
// Single task tile (draggable)
// ───────────────────────────────────────────────────────────────────────

function TaskTile({
  task, lang, onClick, onDragStart, onDragEnd,
}: {
  task: BoardTask;
  lang: Language;
  onClick: () => void;
  onDragStart: () => void;
  onDragEnd: () => void;
}) {
  const tone = priorityTone(task.priority);
  const dueLabel = task.due_by ? new Date(task.due_by).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : null;
  const isLocked = task.status === 'in_progress' || task.status === 'completed' || task.status === 'inspection_pending';
  return (
    <button
      type="button"
      draggable={!isLocked}
      onDragStart={(e) => {
        if (isLocked) { e.preventDefault(); return; }
        // Native DnD needs SOME payload to fire on Safari.
        try { e.dataTransfer.setData('text/plain', task.id); } catch { /* ignore */ }
        e.dataTransfer.effectAllowed = 'move';
        onDragStart();
      }}
      onDragEnd={onDragEnd}
      onClick={onClick}
      style={{
        textAlign: 'left',
        background: '#FFFFFF',
        border: `1px solid ${T.rule}`,
        borderLeft: `3px solid ${tone === 'warm' ? T.warm : tone === 'caramel' ? T.caramelDeep : tone === 'sage' ? T.sageDeep : T.ink3}`,
        borderRadius: 8,
        padding: '8px 10px',
        cursor: isLocked ? 'not-allowed' : 'grab',
        opacity: isLocked ? 0.6 : 1,
        display: 'flex', flexDirection: 'column', gap: 4,
        fontFamily: FONT_SANS,
      }}
      aria-label={`Room ${task.room_number} ${task.cleaning_type}`}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
        <span style={{ fontFamily: FONT_SERIF, fontSize: 18, fontWeight: 400, color: T.ink, letterSpacing: '-0.01em' }}>
          {task.room_number}
        </span>
        <span style={{ fontFamily: FONT_MONO, fontSize: 11, color: T.ink2, fontWeight: 600 }}>
          {fmtMinutes(task.estimated_minutes_resolved)}
        </span>
      </div>
      <div style={{
        display: 'flex', flexWrap: 'wrap', gap: 4, alignItems: 'center',
        fontFamily: FONT_MONO, fontSize: 10, color: T.ink2,
        letterSpacing: '0.04em', textTransform: 'uppercase',
      }}>
        <span>{task.cleaning_type.replace(/_/g, ' ')}</span>
        {task.priority !== 'normal' && task.priority !== 'low' && (
          <Pill tone={tone === 'neutral' ? 'neutral' : tone}>{priorityLabel(task.priority, lang)}</Pill>
        )}
        {task.requires_inspection && <Pill tone="purple">{STR.inspection(lang)}</Pill>}
        {dueLabel && (
          <span style={{ color: T.ink3 }}>· {dueLabel}</span>
        )}
      </div>
    </button>
  );
}

// ───────────────────────────────────────────────────────────────────────
// Side panel for task details
// ───────────────────────────────────────────────────────────────────────

function TaskDetailPanel({
  task, lang, onClose,
}: { task: BoardTask; lang: Language; onClose: () => void }) {
  // Focus-trap-lite: close on Escape.
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
            <DetailRow
              label={STR.dueBy(lang)}
              value={new Date(task.due_by).toLocaleString(undefined, {
                month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
              })}
            />
          )}
          <DetailRow label={'Priority'} value={priorityLabel(task.priority, lang)} />
          {task.assignment_reason && (
            <DetailRow label={STR.reason(lang)} value={task.assignment_reason} />
          )}
          {task.assigned_by && (
            <DetailRow label={STR.assignedBy(lang)} value={task.assigned_by} />
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
