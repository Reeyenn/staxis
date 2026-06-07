'use client';

/**
 * ScheduleBoard — "Board" view of the redesigned Schedule tab (the
 * wearebrand June-2026 handoff, design View A). One compact single-line
 * row per housekeeper: avatar + name · workload bar · "rooms · time" +
 * status pill · their room chips (a single horizontal scroll lane). A
 * dashed "Unassigned" row at the bottom holds whatever's still unplaced.
 *
 * Presentational + drag only. The parent ScheduleTab owns the data
 * (GET /api/housekeeping/board), the action buttons, and persistence:
 *   - drag a chip onto a crew row  → onReassign(taskId, hkId)  (/reassign)
 *   - drag a chip onto Unassigned  → onUnassign(taskId)        (/reset, taskId)
 *   - tap a chip                   → onOpenTask(task)          (detail drawer)
 *
 * This file also exports the shared board types + chip styling reused by
 * ScheduleTimeline so the two views stay visually in lock-step.
 *
 * Design system: Snow tokens via _snow.tsx. Glyphs ↗ ◐ ★ and the
 * rust/gold/green chip accents map onto the warm/caramel/sage palette.
 */

import React, { useState } from 'react';
import { T, FONT_SANS, FONT_MONO, HousekeeperDot } from './_snow';

export type Language = 'en' | 'es';

// Mirrors the housekeeper shape from /api/housekeeping/board (+ the
// schedule_priority / has_phone fields added 2026-06-05).
export interface BoardHk {
  id: string;
  name: string;
  language: 'en' | 'es';
  is_senior: boolean;
  is_active: boolean;
  scheduled_today: boolean;
  schedule_priority: 'priority' | 'normal' | 'excluded';
  has_phone: boolean;
  phone: string | null;
  workload_minutes: number;
}

// Mirrors the task shape from /api/housekeeping/board.
export interface BoardTask {
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

// ───────────────────────────────────────────────────────────────────────
// Chip styling — collapse the real cleaning_type taxonomy onto the
// design's three accents/glyphs. The exact cleaning_type is still shown
// verbatim in the detail drawer; the chip just needs a fast visual cue.
//   checkout (rust ↗)  — guest left / heavy clean
//   stayover (gold ◐)  — guest staying / light touch
//   arrival  (green ★) — verify / check / no-clean
// ───────────────────────────────────────────────────────────────────────

export type ChipKind = 'checkout' | 'stayover' | 'arrival';

export function chipKind(cleaningType: string): ChipKind {
  switch (cleaningType) {
    case 'departure':
    case 'departure_deep':
    case 'deep':
      return 'checkout';
    case 'stayover':
    case 'refresh':
      return 'stayover';
    default:
      // inspection_only, room_check, no_clean, and anything new
      return 'arrival';
  }
}

const CHIP_COLOR: Record<ChipKind, string> = {
  checkout: T.warm,        // rust
  stayover: T.caramelDeep, // gold
  arrival: T.sageDeep,     // green
};
const CHIP_GLYPH: Record<ChipKind, string> = {
  checkout: '↗', stayover: '◐', arrival: '★',
};

export function fmtMinutes(mins: number): string {
  const m = Math.round(mins);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r > 0 ? `${h}h ${r}m` : `${h}h`;
}

// Status of a crew member's load vs the shift cap.
type LoadStatus = 'ok' | 'near' | 'over';

export function loadStatus(loadMinutes: number, shiftMinutes: number): LoadStatus {
  if (loadMinutes > shiftMinutes) return 'over';
  if (loadMinutes > shiftMinutes * 0.85) return 'near';
  return 'ok';
}

function statusLabel(st: LoadStatus, roomCount: number, lang: Language): string {
  if (st === 'over') return lang === 'es' ? 'Sobre cap.' : 'Over cap';
  if (st === 'near') return lang === 'es' ? 'Casi lleno' : 'Near full';
  if (roomCount === 0) return lang === 'es' ? 'Libre' : 'Open';
  return lang === 'es' ? 'En curso' : 'On track';
}

function statusColors(st: LoadStatus): { bg: string; fg: string } {
  if (st === 'over') return { bg: T.warmDim, fg: T.warm };
  if (st === 'near') return { bg: 'rgba(215,176,126,0.18)', fg: T.caramelDeep };
  return { bg: T.sageDim, fg: T.sageDeep };
}

// ───────────────────────────────────────────────────────────────────────
// Room chip
// ───────────────────────────────────────────────────────────────────────

function Chip({
  task, onDragStart, onDragEnd, onClick,
}: {
  task: BoardTask;
  onDragStart: (taskId: string) => void;
  onDragEnd: () => void;
  onClick: (task: BoardTask) => void;
}) {
  const kind = chipKind(task.cleaning_type);
  const isLocked = task.status === 'in_progress'
    || task.status === 'completed'
    || task.status === 'cancelled'
    || task.status === 'inspection_pending';
  return (
    <button
      type="button"
      draggable={!isLocked}
      onDragStart={(e) => {
        if (isLocked) { e.preventDefault(); return; }
        try { e.dataTransfer.setData('text/plain', task.id); } catch { /* Safari needs a payload */ }
        e.dataTransfer.effectAllowed = 'move';
        onDragStart(task.id);
      }}
      onDragEnd={onDragEnd}
      onClick={() => onClick(task)}
      title={`${task.room_number} · ${task.cleaning_type.replace(/_/g, ' ')} · ${fmtMinutes(task.estimated_minutes_resolved)}`}
      aria-label={`Room ${task.room_number} ${task.cleaning_type}`}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 5,
        flex: '0 0 auto',
        background: T.paper,
        border: `1px solid ${T.rule}`,
        borderLeft: `3px solid ${CHIP_COLOR[kind]}`,
        borderRadius: 8, padding: '4px 9px',
        fontFamily: FONT_MONO, fontWeight: 600, fontSize: 13, color: T.ink,
        whiteSpace: 'nowrap',
        cursor: isLocked ? 'default' : 'grab',
        opacity: isLocked ? 0.6 : 1,
      }}
    >
      <span>{task.room_number}</span>
      <span style={{ fontFamily: FONT_SANS, fontWeight: 400, color: T.ink3, fontSize: 11 }}>
        {CHIP_GLYPH[kind]}
      </span>
      {task.requires_inspection && (
        <span style={{ color: T.purple, fontSize: 11 }} title="inspection">◆</span>
      )}
    </button>
  );
}

// ───────────────────────────────────────────────────────────────────────
// Crew row
// ───────────────────────────────────────────────────────────────────────

function CrewRow({
  hk, tasks, shiftMinutes, lang, isHover,
  onDragStartTask, onDragEndTask, onClickTask,
  onDragOver, onDragLeave, onDrop,
}: {
  hk: BoardHk;
  tasks: BoardTask[];
  shiftMinutes: number;
  lang: Language;
  isHover: boolean;
  onDragStartTask: (taskId: string) => void;
  onDragEndTask: () => void;
  onClickTask: (task: BoardTask) => void;
  onDragOver: (e: React.DragEvent) => void;
  onDragLeave: () => void;
  onDrop: () => void;
}) {
  const load = tasks.reduce((s, t) => s + t.estimated_minutes_resolved, 0);
  const st = loadStatus(load, shiftMinutes);
  const pct = Math.min(100, Math.round((load / Math.max(1, shiftMinutes)) * 100));
  const barColor = st === 'over' ? T.warm : st === 'near' ? T.caramelDeep : T.sageDeep;
  const sc = statusColors(st);
  const isExcluded = hk.schedule_priority === 'excluded';

  return (
    <div
      data-hk={hk.id}
      onDragOver={(e) => { e.preventDefault(); onDragOver(e); }}
      onDragLeave={onDragLeave}
      onDrop={(e) => { e.preventDefault(); onDrop(); }}
      style={{
        display: 'grid',
        gridTemplateColumns: '180px 80px 150px 1fr',
        gap: 13, alignItems: 'center',
        border: `1px solid ${isHover ? T.sageDeep : T.rule}`,
        borderRadius: 11, padding: '8px 15px',
        background: T.paper,
        boxShadow: isHover ? `0 0 0 3px ${T.sageDim}` : undefined,
        transition: 'box-shadow 120ms ease, border-color 120ms ease',
        opacity: isExcluded ? 0.62 : 1,
      }}
    >
      {/* Who */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 9, minWidth: 0 }}>
        <HousekeeperDot staff={{ id: hk.id, name: hk.name }} size={33} />
        <div style={{ minWidth: 0 }}>
          <div style={{
            fontFamily: FONT_SANS, fontWeight: 600, fontSize: 14, color: T.ink,
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', lineHeight: 1.1,
          }}>{hk.name}</div>
          {(hk.is_senior || isExcluded) && (
            <div style={{ fontFamily: FONT_MONO, fontSize: 9, color: T.ink3, marginTop: 1, letterSpacing: '0.04em' }}>
              {hk.is_senior ? (lang === 'es' ? 'SÉNIOR' : 'SENIOR') : ''}
              {hk.is_senior && isExcluded ? ' · ' : ''}
              {isExcluded ? (lang === 'es' ? 'EXCLUIDO' : 'EXCLUDED') : ''}
            </div>
          )}
        </div>
      </div>

      {/* Workload bar */}
      <div>
        <div style={{ height: 7, background: T.ruleSoft, borderRadius: 999, overflow: 'hidden' }}>
          <div style={{ height: '100%', width: `${pct}%`, background: barColor, borderRadius: 999, transition: 'width 200ms ease' }} />
        </div>
      </div>

      {/* Readout */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, whiteSpace: 'nowrap' }}>
        <span style={{ fontFamily: FONT_MONO, fontSize: 10.5, color: T.ink2 }}>
          {tasks.length} {lang === 'es' ? 'cu' : 'rms'} · {fmtMinutes(load)}
        </span>
        <span style={{
          fontFamily: FONT_SANS, fontWeight: 600, fontSize: 9,
          padding: '1px 6px', borderRadius: 999,
          background: sc.bg, color: sc.fg, whiteSpace: 'nowrap',
        }}>{statusLabel(st, tasks.length, lang)}</span>
      </div>

      {/* Chips (single horizontal scroll lane) */}
      <div className="hk-chiprow" style={{ display: 'flex', gap: 6, flexWrap: 'nowrap', overflowX: 'auto', paddingBottom: 1 }}>
        {tasks.length > 0
          ? tasks.map(t => (
            <Chip key={t.id} task={t} onDragStart={onDragStartTask} onDragEnd={onDragEndTask} onClick={onClickTask} />
          ))
          : (
            <span style={{ fontFamily: FONT_MONO, fontSize: 10.5, color: T.ink3, opacity: 0.7 }}>
              {lang === 'es' ? 'Suelta cuartos aquí' : 'Drop rooms here'}
            </span>
          )}
      </div>
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────
// Board
// ───────────────────────────────────────────────────────────────────────

export function ScheduleBoard({
  crew, tasks, shiftMinutes, lang,
  onReassign, onUnassign, onOpenTask,
}: {
  crew: BoardHk[];
  tasks: BoardTask[];
  shiftMinutes: number;
  lang: Language;
  onReassign: (taskId: string, toHkId: string) => void;
  onUnassign: (taskId: string) => void;
  onOpenTask: (task: BoardTask) => void;
}) {
  const [dragTaskId, setDragTaskId] = useState<string | null>(null);
  const [hoverZone, setHoverZone] = useState<string | null>(null); // hk id or '__un__'

  const crewIds = new Set(crew.map(c => c.id));
  const tasksByHk = new Map<string, BoardTask[]>();
  const unassigned: BoardTask[] = [];
  for (const t of tasks) {
    if (t.assignee_id && crewIds.has(t.assignee_id)) {
      const arr = tasksByHk.get(t.assignee_id) ?? [];
      arr.push(t);
      tasksByHk.set(t.assignee_id, arr);
    } else {
      // Either truly unassigned, or assigned to someone not in the
      // displayed crew (e.g. off-roster) — surface so it's never hidden.
      unassigned.push(t);
    }
  }
  for (const arr of tasksByHk.values()) {
    arr.sort((a, b) => (a.queue_order - b.queue_order) || a.room_number.localeCompare(b.room_number, undefined, { numeric: true }));
  }
  unassigned.sort((a, b) => a.room_number.localeCompare(b.room_number, undefined, { numeric: true }));

  const handleDrop = (zone: string) => {
    const taskId = dragTaskId;
    setDragTaskId(null);
    setHoverZone(null);
    if (!taskId) return;
    if (zone === '__un__') onUnassign(taskId);
    else onReassign(taskId, zone);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
      {/* Hide the chip-lane scrollbar so each crew row stays one avatar tall. */}
      <style>{`.hk-chiprow{scrollbar-width:none;-ms-overflow-style:none;}.hk-chiprow::-webkit-scrollbar{display:none;}`}</style>

      {crew.map(hk => (
        <CrewRow
          key={hk.id}
          hk={hk}
          tasks={tasksByHk.get(hk.id) ?? []}
          shiftMinutes={shiftMinutes}
          lang={lang}
          isHover={hoverZone === hk.id}
          onDragStartTask={setDragTaskId}
          onDragEndTask={() => { setDragTaskId(null); setHoverZone(null); }}
          onClickTask={onOpenTask}
          onDragOver={() => { if (hoverZone !== hk.id) setHoverZone(hk.id); }}
          onDragLeave={() => setHoverZone(z => (z === hk.id ? null : z))}
          onDrop={() => handleDrop(hk.id)}
        />
      ))}

      {/* Unassigned row — always droppable; only visible when it has rooms. */}
      {unassigned.length > 0 && (
        <div
          data-hk="__un__"
          onDragOver={(e) => { e.preventDefault(); if (hoverZone !== '__un__') setHoverZone('__un__'); }}
          onDragLeave={() => setHoverZone(z => (z === '__un__' ? null : z))}
          onDrop={(e) => { e.preventDefault(); handleDrop('__un__'); }}
          style={{
            display: 'grid', gridTemplateColumns: '180px 80px 150px 1fr', gap: 13, alignItems: 'center',
            border: `1px dashed ${hoverZone === '__un__' ? T.sageDeep : T.rule}`,
            borderRadius: 11, padding: '8px 15px', background: T.paper,
            boxShadow: hoverZone === '__un__' ? `0 0 0 3px ${T.sageDim}` : undefined,
            transition: 'box-shadow 120ms ease, border-color 120ms ease',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 9, minWidth: 0 }}>
            <span style={{
              width: 33, height: 33, borderRadius: '50%', background: T.ink3, color: '#fff',
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              fontFamily: FONT_SANS, fontWeight: 700, fontSize: 14, flexShrink: 0,
            }}>?</span>
            <div style={{ fontFamily: FONT_SANS, fontWeight: 600, fontSize: 14, color: T.ink }}>
              {lang === 'es' ? 'Sin asignar' : 'Unassigned'}
            </div>
          </div>
          <div />
          <div style={{ display: 'flex', alignItems: 'center', whiteSpace: 'nowrap' }}>
            <span style={{ fontFamily: FONT_MONO, fontSize: 10.5, color: T.ink2 }}>
              {unassigned.length} {lang === 'es' ? 'cuartos' : 'rooms'}
            </span>
          </div>
          <div className="hk-chiprow" style={{ display: 'flex', gap: 6, flexWrap: 'nowrap', overflowX: 'auto', paddingBottom: 1 }}>
            {unassigned.map(t => (
              <Chip
                key={t.id}
                task={t}
                onDragStart={setDragTaskId}
                onDragEnd={() => { setDragTaskId(null); setHoverZone(null); }}
                onClick={onOpenTask}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
