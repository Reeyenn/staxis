'use client';

/**
 * ScheduleTimeline — "Timeline" view of the redesigned Schedule tab
 * (design View B). The SAME assignment as the Board, drawn as a Gantt
 * strip: one lane per housekeeper across the shift window, each room a
 * block whose width is proportional to its estimated minutes, laid
 * end-to-end in queue order. A rust "NOW" line marks the current time.
 *
 * Shares the board's data + types (from ScheduleBoard) and the same
 * persistence callbacks — drag a block to another lane → onReassign,
 * tap a block → onOpenTask. Layout is percentage-based off the shift
 * window, so it's responsive with no measurement pass.
 *
 * Design system: Snow tokens via _snow.tsx.
 */

import React, { useState } from 'react';
import { T, FONT_SANS, FONT_MONO, HousekeeperDot } from './_snow';
import {
  type BoardTask, type BoardHk, type Language,
  chipKind, fmtMinutes,
} from './ScheduleBoard';

const START_HOUR = 7; // shift window starts 7:00 local (matches the design)
const CHIP_COLOR: Record<string, string> = {
  checkout: T.warm, stayover: T.caramelDeep, arrival: T.sageDeep,
};

function hourLabel(h: number): string {
  const hr = h % 24;
  const ampm = hr >= 12 ? 'p' : 'a';
  const display = hr > 12 ? hr - 12 : hr === 0 ? 12 : hr;
  return `${display}${ampm}`;
}

export function ScheduleTimeline({
  crew, tasks, shiftMinutes, lang, showNow,
  onReassign, onOpenTask,
}: {
  crew: BoardHk[];
  tasks: BoardTask[];
  shiftMinutes: number;
  lang: Language;
  /** Draw the NOW line (only meaningful when viewing today). */
  showNow: boolean;
  onReassign: (taskId: string, toHkId: string) => void;
  onOpenTask: (task: BoardTask) => void;
}) {
  const [dragTaskId, setDragTaskId] = useState<string | null>(null);
  const [hoverHk, setHoverHk] = useState<string | null>(null);

  const crewIds = new Set(crew.map(c => c.id));
  const tasksByHk = new Map<string, BoardTask[]>();
  for (const t of tasks) {
    if (!t.assignee_id || !crewIds.has(t.assignee_id)) continue;
    const arr = tasksByHk.get(t.assignee_id) ?? [];
    arr.push(t);
    tasksByHk.set(t.assignee_id, arr);
  }
  for (const arr of tasksByHk.values()) {
    arr.sort((a, b) => (a.queue_order - b.queue_order) || a.room_number.localeCompare(b.room_number, undefined, { numeric: true }));
  }

  // Window = whichever is larger: the shift cap or the busiest crew's load,
  // so over-cap lanes still fit (blocks never clip off the right edge).
  const maxLoad = Math.max(
    shiftMinutes,
    ...crew.map(c => (tasksByHk.get(c.id) ?? []).reduce((s, t) => s + t.estimated_minutes_resolved, 0)),
  );
  const windowMinutes = Math.max(60, Math.ceil(maxLoad / 60) * 60);
  const hourCount = Math.round(windowMinutes / 60);
  const hours = Array.from({ length: hourCount + 1 }, (_, i) => START_HOUR + i);

  // NOW position as a fraction of the window (clamped to [0,1]).
  const now = new Date();
  const nowMinFromStart = (now.getHours() - START_HOUR) * 60 + now.getMinutes();
  const nowPct = Math.max(0, Math.min(1, nowMinFromStart / windowMinutes)) * 100;
  const nowVisible = showNow && nowMinFromStart >= 0 && nowMinFromStart <= windowMinutes;

  const handleDrop = (hkId: string) => {
    const id = dragTaskId;
    setDragTaskId(null);
    setHoverHk(null);
    if (id) onReassign(id, hkId);
  };

  return (
    <div style={{
      position: 'relative',
      border: `1px solid ${T.rule}`, borderRadius: 14, padding: '14px 16px',
      background: T.paper,
    }}>
      {crew.length === 0 && (
        <div style={{ padding: '28px 8px', textAlign: 'center', color: T.ink2, fontFamily: FONT_SANS, fontSize: 14 }}>
          {lang === 'es' ? 'No hay personal para mostrar.' : 'No crew to show.'}
        </div>
      )}

      {crew.length > 0 && (
        <>
          {/* Axis row */}
          <div style={{
            display: 'grid', gridTemplateColumns: '150px 1fr', alignItems: 'end',
            borderBottom: `1px solid ${T.rule}`, minHeight: 24,
          }}>
            <div />
            <div style={{ position: 'relative', height: 22 }}>
              {hours.map(h => {
                const pct = ((h - START_HOUR) * 60 / windowMinutes) * 100;
                if (pct > 100.01) return null;
                return (
                  <span key={h} style={{
                    position: 'absolute', left: `${pct}%`, bottom: 3, transform: 'translateX(-50%)',
                    fontFamily: FONT_MONO, fontSize: 10, color: T.ink3, whiteSpace: 'nowrap',
                  }}>{hourLabel(h)}</span>
                );
              })}
            </div>
          </div>

          {/* Crew lanes */}
          {crew.map(hk => {
            const myTasks = tasksByHk.get(hk.id) ?? [];
            const load = myTasks.reduce((s, t) => s + t.estimated_minutes_resolved, 0);
            const isHover = hoverHk === hk.id;
            // Cumulative left offset per block.
            let cursor = 0;
            return (
              <div key={hk.id} style={{
                display: 'grid', gridTemplateColumns: '150px 1fr', alignItems: 'center',
                borderBottom: `1px solid ${T.ruleSoft}`, minHeight: 50,
              }}>
                {/* Lane header */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 9, paddingRight: 10, minWidth: 0 }}>
                  <HousekeeperDot staff={{ id: hk.id, name: hk.name }} size={24} />
                  <div style={{ minWidth: 0 }}>
                    <div style={{
                      fontFamily: FONT_SANS, fontSize: 12.5, fontWeight: 600, color: T.ink,
                      whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                    }}>{hk.name}</div>
                    <div style={{ fontFamily: FONT_MONO, fontSize: 10, color: T.ink3, whiteSpace: 'nowrap' }}>
                      {myTasks.length} {lang === 'es' ? 'cu' : 'rms'} · {fmtMinutes(load)}
                    </div>
                  </div>
                </div>

                {/* Lane */}
                <div
                  onDragOver={(e) => { e.preventDefault(); if (hoverHk !== hk.id) setHoverHk(hk.id); }}
                  onDragLeave={() => setHoverHk(h => (h === hk.id ? null : h))}
                  onDrop={(e) => { e.preventDefault(); handleDrop(hk.id); }}
                  style={{
                    position: 'relative', height: 50,
                    background: isHover ? T.sageDim : 'transparent',
                    transition: 'background 120ms ease',
                  }}
                >
                  {/* Hour gridlines */}
                  {hours.map(h => {
                    const pct = ((h - START_HOUR) * 60 / windowMinutes) * 100;
                    if (pct > 100.01) return null;
                    return (
                      <span key={h} style={{
                        position: 'absolute', top: 0, bottom: 0, left: `${pct}%`,
                        width: 1, background: T.ruleSoft,
                      }} />
                    );
                  })}
                  {/* Blocks */}
                  {myTasks.map(t => {
                    const kind = chipKind(t.cleaning_type);
                    const color = CHIP_COLOR[kind];
                    const leftPct = (cursor / windowMinutes) * 100;
                    const widthPct = (t.estimated_minutes_resolved / windowMinutes) * 100;
                    cursor += t.estimated_minutes_resolved;
                    const isLocked = t.status === 'in_progress' || t.status === 'completed'
                      || t.status === 'cancelled' || t.status === 'inspection_pending';
                    return (
                      <button
                        key={t.id}
                        type="button"
                        draggable={!isLocked}
                        onDragStart={(e) => {
                          if (isLocked) { e.preventDefault(); return; }
                          try { e.dataTransfer.setData('text/plain', t.id); } catch { /* Safari */ }
                          e.dataTransfer.effectAllowed = 'move';
                          setDragTaskId(t.id);
                        }}
                        onDragEnd={() => { setDragTaskId(null); setHoverHk(null); }}
                        onClick={() => onOpenTask(t)}
                        title={`${t.room_number} · ${t.cleaning_type.replace(/_/g, ' ')} · ${fmtMinutes(t.estimated_minutes_resolved)}`}
                        aria-label={`Room ${t.room_number} ${t.cleaning_type}`}
                        style={{
                          position: 'absolute', top: 8, bottom: 8,
                          left: `${leftPct}%`, width: `${widthPct}%`, minWidth: 18,
                          border: `1px solid ${color}`, borderLeft: `3px solid ${color}`,
                          borderRadius: 7,
                          background: `color-mix(in srgb, ${color} 12%, #fff)`,
                          padding: '2px 5px', overflow: 'hidden',
                          cursor: isLocked ? 'default' : 'grab', opacity: isLocked ? 0.6 : 1,
                          display: 'flex', flexDirection: 'column', justifyContent: 'center',
                          textAlign: 'left',
                        }}
                      >
                        <span style={{
                          fontFamily: FONT_MONO, fontWeight: 600, fontSize: 11.5, color,
                          lineHeight: 1, whiteSpace: 'nowrap',
                        }}>{t.room_number}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}

          {/* NOW line — spans the lane area (offset by the 150px gutter). */}
          {nowVisible && (
            <div style={{
              position: 'absolute', top: 14, bottom: 14,
              left: `calc(150px + 16px + (100% - 150px - 32px) * ${nowPct / 100})`,
              width: 2, background: T.warm, zIndex: 3, pointerEvents: 'none',
            }}>
              <span style={{
                position: 'absolute', top: -2, left: 0, transform: 'translateX(-50%)',
                background: T.warm, color: '#fff',
                fontFamily: FONT_MONO, fontSize: 8, fontWeight: 700, letterSpacing: '0.08em',
                padding: '2px 5px', borderRadius: 4, whiteSpace: 'nowrap',
              }}>{lang === 'es' ? 'AHORA' : 'NOW'}</span>
            </div>
          )}
        </>
      )}
    </div>
  );
}
