// FillModal — the single entry point for populating a day or a week.
//
// Body order (per the design): saved whole-day / whole-week template rows
// (Use), the solid "Fill from history…" expander (browse every past day or
// week, preview who was on, then Use / Save as template), and a quiet
// "Save this day/week as a template" link at the bottom.
//
// Applying always replaces the target period's entire shift set; the parent
// owns undo snapshots, persistence, toasts, and closing.

'use client';

import React, { useEffect, useState } from 'react';
import type { StaffMember } from '@/types';
import {
  boardRange, fmtMin, fmtMinRange, shortName,
  type BoardShift, type DayInfo, type WeekInfo,
} from '@/lib/schedule-board';
import { T, fonts, deptMeta, asDeptKey, Caps, Btn, type DeptKey } from '../_tokens';
import { Avatar } from '../_people';
import { WeekRoster } from './WeekRoster';
import type { ScheduleTemplate } from './useScheduleData';

export function FillModal({
  scope, subLabel, templates, currentCount, weeks, today, selDate, selWeekStart,
  getDay, staff, lang, nameOf,
  onApplyTemplate, onSaveCurrent, onSaveAt, onDeleteTemplate,
  onHistoryDay, onHistoryWeek, onClose, reducedMotion,
}: {
  scope: 'day' | 'week';
  subLabel: string;
  templates: ScheduleTemplate[];
  currentCount: number;
  weeks: WeekInfo[];
  today: string;
  selDate: string;
  selWeekStart: string;
  getDay: (date: string) => BoardShift[];
  staff: StaffMember[];
  lang: 'en' | 'es';
  nameOf: (staffId: string) => string;
  onApplyTemplate: (t: ScheduleTemplate, repeatAll: boolean) => void;
  onSaveCurrent: (name: string) => void;
  onSaveAt: (name: string, target: { date: string } | { weekStart: string }) => void;
  onDeleteTemplate: (t: ScheduleTemplate) => void;
  onHistoryDay: (date: string) => void;
  onHistoryWeek: (weekStart: string, repeatAll: boolean) => void;
  onClose: () => void;
  reducedMotion: boolean;
}) {
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');
  const [more, setMore] = useState(false);
  const [preview, setPreview] = useState<DayInfo | null>(null);
  const [wPreview, setWPreview] = useState<WeekInfo | null>(null);
  // Week scope: apply the pick to every upcoming week, not just this one.
  const [repeatAll, setRepeatAll] = useState(false);

  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);

  const es = lang === 'es';
  const save = () => {
    if (!name.trim()) return;
    onSaveCurrent(name.trim());
    setName('');
    setNaming(false);
  };

  // Every week containing at least one past day, newest first.
  const histWeeks = weeks.filter(w => w.days.some(d => d.date < today)).slice().reverse();
  // Week scope: weeks strictly before the selected one, newest first.
  const earlierWeeks = weeks.filter(w => w.start < selWeekStart).slice().reverse();

  const title = preview
    ? `${preview.dowFull}, ${es ? `${preview.dayNum} ${preview.mon}` : `${preview.mon} ${preview.dayNum}`}`
    : wPreview
      ? `${es ? 'Semana' : 'Week'}, ${wPreview.label}`
      : scope === 'day' ? (es ? 'Llenar este día' : 'Fill this day') : (es ? 'Llenar esta semana' : 'Fill this week');

  return (
    <div
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      style={{
        position: 'fixed', inset: 0, zIndex: 1100,
        background: 'rgba(31,35,28,0.42)', backdropFilter: 'blur(6px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 20, fontFamily: fonts.sans,
      }}
    >
      <div onClick={e => e.stopPropagation()} style={{
        background: T.paper, borderRadius: 22, width: '100%', maxWidth: wPreview ? 880 : 460,
        maxHeight: '86vh', display: 'flex', flexDirection: 'column', overflow: 'hidden',
        boxShadow: '0 24px 70px -10px rgba(31,35,28,0.34), 0 0 0 1px rgba(31,35,28,0.04)',
      }}>
        {/* header */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
          padding: '18px 24px 14px', borderBottom: `1px solid ${T.rule}`,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 11 }}>
            {(preview || wPreview) && (
              <button
                onClick={() => { setPreview(null); setWPreview(null); }}
                title={es ? 'Atrás' : 'Back'}
                style={{
                  width: 30, height: 30, borderRadius: '50%', border: `1px solid ${T.rule}`,
                  background: 'transparent', cursor: 'pointer', color: T.ink2, fontSize: 15, flexShrink: 0,
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                }}
              >‹</button>
            )}
            <div>
              <h2 style={{
                margin: 0, fontFamily: fonts.serif, fontSize: 24, fontStyle: 'italic',
                fontWeight: 400, letterSpacing: '-0.02em', whiteSpace: 'nowrap', color: T.ink,
              }}>{title}</h2>
              <div style={{ fontFamily: fonts.mono, fontSize: 10.5, color: T.ink3, marginTop: 3 }}>
                {(preview || wPreview)
                  ? (es ? 'Historial · quién estuvo' : 'History · who was on')
                  : `${subLabel} · ${es ? 'elige uno, listo' : 'pick one, done'}`}
              </div>
            </div>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            style={{
              background: 'transparent', border: `1px solid ${T.rule}`, borderRadius: '50%',
              width: 30, height: 30, cursor: 'pointer', color: T.ink2, fontSize: 16, flexShrink: 0,
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            }}
          >×</button>
        </div>

        <div style={{ overflowY: 'auto', padding: '16px 24px 18px' }}>
          {preview ? (
            <DayPreview
              shifts={getDay(preview.date)}
              lang={lang}
              nameOf={nameOf}
              onUse={() => onHistoryDay(preview.date)}
              onSave={nm => { onSaveAt(nm, { date: preview.date }); setPreview(null); setMore(false); }}
            />
          ) : wPreview ? (
            <WeekPreview
              win={wPreview}
              getDay={getDay}
              staff={staff}
              lang={lang}
              reducedMotion={reducedMotion}
              onUse={() => onHistoryWeek(wPreview.start, repeatAll)}
              onSave={nm => { onSaveAt(nm, { weekStart: wPreview.start }); setWPreview(null); setMore(false); }}
            />
          ) : (
            <>
              {/* auto-repeat — week scope only */}
              {scope === 'week' && weeks.some(w => w.start > selWeekStart) && (
                <label style={{
                  display: 'flex', alignItems: 'flex-start', gap: 9, cursor: 'pointer',
                  border: `1px solid ${repeatAll ? 'rgba(140,106,51,0.32)' : T.rule}`,
                  background: repeatAll ? 'rgba(201,150,68,0.10)' : 'transparent',
                  borderRadius: 12, padding: '10px 13px', marginBottom: 10,
                }}>
                  <input
                    type="checkbox"
                    checked={repeatAll}
                    onChange={e => setRepeatAll(e.target.checked)}
                    style={{ marginTop: 2, accentColor: T.ink, cursor: 'pointer' }}
                  />
                  <span style={{ minWidth: 0 }}>
                    <span style={{ display: 'block', fontSize: 13, fontWeight: 600, color: T.ink }}>
                      {es ? 'Repetir automáticamente' : 'Auto-repeat'}
                    </span>
                    <span style={{ display: 'block', fontSize: 11.5, color: T.ink2, marginTop: 1, lineHeight: 1.45 }}>
                      {es
                        ? `Lo que elijas aquí se aplica a esta semana y a todas las que siguen (hasta ${weeks[weeks.length - 1].label}).`
                        : `Whatever you pick fills this week and every upcoming week (through ${weeks[weeks.length - 1].label}).`}
                    </span>
                  </span>
                </label>
              )}

              {/* templates */}
              {templates.length === 0 ? (
                <div style={{
                  border: `1.5px dashed ${T.rule}`, borderRadius: 14, padding: '16px 18px', textAlign: 'center',
                }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: T.ink2 }}>
                    {scope === 'day'
                      ? (es ? 'Aún no hay plantillas de día' : 'No day templates yet')
                      : (es ? 'Aún no hay plantillas de semana' : 'No week templates yet')}
                  </div>
                  <div style={{ fontSize: 12, color: T.ink3, marginTop: 4, lineHeight: 1.5 }}>
                    {scope === 'day'
                      ? (es
                        ? 'Arma un día en el tablero como te guste y guárdalo abajo. Aparecerá aquí listo para reusar.'
                        : 'Set up a day on the board the way you like it, then save it below. It’ll show up here ready to reuse.')
                      : (es
                        ? 'Arma una semana como te guste y guárdala abajo. Aparecerá aquí lista para reusar.'
                        : 'Set up a week the way you like it, then save it below. It’ll show up here ready to reuse.')}
                  </div>
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {templates.map(t => {
                    const n = t.scope === 'day'
                      ? (t.payload as { length: number }).length
                      : (t.payload as unknown[][]).reduce((a, d) => a + d.length, 0);
                    return (
                      <FillRow
                        key={t.id}
                        tag={es ? 'PLANTILLA' : 'TEMPLATE'}
                        title={t.name}
                        sub={`${n} ${n === 1 ? (es ? 'turno' : 'shift') : (es ? 'turnos' : 'shifts')}`}
                        cta={es ? 'Usar' : 'Use'}
                        onUse={() => onApplyTemplate(t, repeatAll)}
                        onDelete={() => onDeleteTemplate(t)}
                        deleteTitle={es ? 'Eliminar plantilla' : 'Delete template'}
                      />
                    );
                  })}
                </div>
              )}

              {/* fill from history — the main move */}
              {!more ? (
                <button
                  onClick={() => setMore(true)}
                  style={{
                    marginTop: 10, width: '100%', cursor: 'pointer',
                    padding: 13, borderRadius: 12, border: '1px solid transparent',
                    background: T.ink, color: T.bg,
                    fontFamily: fonts.sans, fontSize: 13.5, fontWeight: 600,
                    boxShadow: '0 6px 18px rgba(31,35,28,0.18)',
                  }}
                >{es ? 'Llenar desde el historial…' : 'Fill from history…'}</button>
              ) : scope === 'day' ? (
                <div style={{
                  border: `1px solid ${T.rule}`, borderRadius: 14, padding: '12px 14px',
                  marginTop: 10, maxHeight: 264, overflowY: 'auto',
                }}>
                  {histWeeks.length === 0 && (
                    <div style={{ padding: '14px 4px', textAlign: 'center', color: T.ink3, fontSize: 12.5 }}>
                      {es ? 'Todavía no hay historial.' : 'No history yet.'}
                    </div>
                  )}
                  {histWeeks.map(w => (
                    <div key={w.start} style={{ marginBottom: 12 }}>
                      <Caps size={9}>{es ? 'Semana del' : 'Week of'} {w.label}</Caps>
                      <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                        {w.days.map(d => {
                          const okDay = d.date < today && d.date !== selDate;
                          return (
                            <button
                              key={d.date}
                              onClick={() => okDay && setPreview(d)}
                              disabled={!okDay}
                              title={okDay
                                ? (es ? `Ver quién estuvo el ${d.dowFull} ${d.dayNum}` : `See who was on ${d.dowFull} ${d.mon} ${d.dayNum}`)
                                : (es ? 'Aún no es historial' : 'Not history yet')}
                              style={{
                                flex: 1, cursor: okDay ? 'pointer' : 'not-allowed', opacity: okDay ? 1 : 0.35,
                                padding: '7px 2px', borderRadius: 9, border: `1px solid ${T.rule}`,
                                background: T.paper, textAlign: 'center',
                              }}
                            >
                              <span style={{ display: 'block', fontFamily: fonts.mono, fontSize: 8.5, fontWeight: 600, color: T.ink3 }}>
                                {d.dow.toUpperCase()}
                              </span>
                              <span style={{ display: 'block', fontFamily: fonts.serif, fontSize: 15, fontStyle: 'italic', color: T.ink }}>
                                {d.dayNum}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 10 }}>
                  {earlierWeeks.length === 0 && (
                    <div style={{ padding: '14px 4px', textAlign: 'center', color: T.ink3, fontSize: 12.5 }}>
                      {es ? 'No hay semanas anteriores.' : 'No earlier weeks.'}
                    </div>
                  )}
                  {earlierWeeks.map(w => (
                    <FillRow
                      key={w.start}
                      tag={w.past ? (es ? 'HISTORIAL' : 'HISTORY') : (es ? 'PLANEADA' : 'PLANNED')}
                      title={`${es ? 'Semana del' : 'Week of'} ${w.label}`}
                      sub={es ? 'dom–sáb' : 'Sun–Sat'}
                      cta={es ? 'Ver →' : 'View →'}
                      onUse={() => setWPreview(w)}
                    />
                  ))}
                </div>
              )}

              {/* save as template — one quiet line at the bottom */}
              <div style={{ marginTop: 14, paddingTop: 12, borderTop: `1px solid ${T.rule}` }}>
                {!naming ? (
                  <button
                    onClick={() => currentCount > 0 && setNaming(true)}
                    disabled={currentCount === 0}
                    style={{
                      background: 'transparent', border: 'none',
                      cursor: currentCount > 0 ? 'pointer' : 'not-allowed',
                      opacity: currentCount > 0 ? 1 : 0.5, padding: 0,
                      fontFamily: fonts.sans, fontSize: 12.5, fontWeight: 600, color: T.ink2,
                      textDecoration: 'underline', textUnderlineOffset: 3,
                    }}
                  >
                    {scope === 'day'
                      ? (es ? 'Guardar este día como plantilla' : 'Save this day as a template')
                      : (es ? 'Guardar esta semana como plantilla' : 'Save this week as a template')}
                  </button>
                ) : (
                  <div style={{ display: 'flex', gap: 8 }}>
                    <input
                      autoFocus
                      value={name}
                      onChange={e => setName(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') save(); }}
                      placeholder={es ? 'Ponle nombre — ej. Día estándar' : 'Name it — e.g. Standard weekday'}
                      style={{
                        flex: 1, boxSizing: 'border-box', padding: '9px 12px', borderRadius: 10,
                        border: `1px solid ${T.rule}`, background: T.paper,
                        fontFamily: fonts.sans, fontSize: 13, color: T.ink, outline: 'none',
                      }}
                    />
                    <Btn variant="ghost" size="sm" onClick={() => setNaming(false)}>{es ? 'Cancelar' : 'Cancel'}</Btn>
                    <Btn variant="primary" size="sm" style={{ borderRadius: 10 }} onClick={save}>{es ? 'Guardar' : 'Save'}</Btn>
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ── shared template/history row ────────────────────────────────────────────
function FillRow({
  tag, title, sub, cta, onUse, onDelete, deleteTitle,
}: {
  tag?: string;
  title: string;
  sub?: string;
  cta: string;
  onUse: () => void;
  onDelete?: () => void;
  deleteTitle?: string;
}) {
  const [hover, setHover] = useState(false);
  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        border: `1px solid ${T.rule}`, borderRadius: 14, padding: '12px 14px',
        display: 'flex', alignItems: 'center', gap: 12,
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{
            fontSize: 13.5, fontWeight: 600, color: T.ink,
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
          }}>{title}</span>
          {tag && (
            <span style={{
              fontFamily: fonts.mono, fontSize: 8.5, fontWeight: 700, letterSpacing: '0.08em',
              color: T.ink3, border: `1px solid ${T.rule}`, borderRadius: 999, padding: '2px 7px',
              flexShrink: 0,
            }}>{tag}</span>
          )}
        </div>
        {sub && <div style={{ fontFamily: fonts.mono, fontSize: 10.5, color: T.ink3, marginTop: 3 }}>{sub}</div>}
      </div>
      <Btn variant="primary" size="sm" style={{ borderRadius: 10 }} onClick={onUse}>{cta}</Btn>
      {onDelete && (
        <button
          onClick={onDelete}
          title={deleteTitle}
          style={{
            width: 24, height: 24, borderRadius: '50%', border: `1px solid ${T.rule}`,
            background: 'transparent', color: T.ink3, cursor: 'pointer',
            fontSize: 12, lineHeight: 1, padding: 0, flexShrink: 0,
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            opacity: hover ? 1 : 0.25,
          }}
        >×</button>
      )}
    </div>
  );
}

// ── history day preview: who was on, with time bars ────────────────────────
function DayPreview({
  shifts, lang, nameOf, onUse, onSave,
}: {
  shifts: BoardShift[];
  lang: 'en' | 'es';
  nameOf: (staffId: string) => string;
  onUse: () => void;
  onSave: (name: string) => void;
}) {
  const es = lang === 'es';
  const { start: pvStart, end: pvEnd } = boardRange(shifts);
  const pvSpan = pvEnd - pvStart;
  const lanesAll: DeptKey[] = ['housekeeping', 'front_desk', 'maintenance', 'other'];
  const lanes = lanesAll
    .map(dep => ({ dep, rows: shifts.filter(s => s.dept === dep).slice().sort((a, b) => a.startMin - b.startMin) }))
    .filter(l => l.rows.length);

  return (
    <div>
      {lanes.length === 0 && (
        <div style={{ padding: '22px 0', textAlign: 'center', color: T.ink3, fontSize: 13 }}>
          {es ? 'Nadie trabajó ese día.' : 'No one worked this day.'}
        </div>
      )}
      {lanes.map(l => {
        const m = deptMeta[l.dep];
        return (
          <div key={l.dep} style={{ marginBottom: 13 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 7 }}>
              <span style={{ width: 5, height: 5, borderRadius: '50%', background: m.tone }}/>
              <Caps size={9} c={T.ink2}>{m.label} · {l.rows.length}</Caps>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
              {l.rows.map(s => {
                const left = ((s.startMin - pvStart) / pvSpan) * 100;
                const width = ((s.endMin - s.startMin) / pvSpan) * 100;
                return (
                  <div key={`${s.staffId}-${s.startMin}`} style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                    <Avatar staffId={s.staffId} name={nameOf(s.staffId)} size={20}/>
                    <span style={{
                      width: 80, fontSize: 12, fontWeight: 600, color: T.ink, flexShrink: 0,
                      whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                    }}>{shortName(nameOf(s.staffId))}</span>
                    <div style={{ position: 'relative', flex: 1, height: 18, borderRadius: 6, background: '#FBFAF6' }}>
                      <div style={{
                        position: 'absolute', top: 2, bottom: 2, left: `${left}%`, width: `${width}%`,
                        borderRadius: 5, background: m.dim, border: `1px solid ${m.tone}55`, boxSizing: 'border-box',
                      }}/>
                    </div>
                    <span style={{
                      fontFamily: fonts.mono, fontSize: 10, color: T.ink2,
                      width: 76, textAlign: 'right', flexShrink: 0,
                    }}>{fmtMin(s.startMin)}–{fmtMin(s.endMin)}</span>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
      <SaveBar
        total={shifts.length}
        cta={es ? 'Usar este día →' : 'Use this day →'}
        lang={lang}
        onUse={onUse}
        onSave={onSave}
      />
    </div>
  );
}

// ── footer shared by the previews ──────────────────────────────────────────
function SaveBar({
  total, cta, lang, onUse, onSave,
}: {
  total: number;
  cta: string;
  lang: 'en' | 'es';
  onUse: () => void;
  onSave: (name: string) => void;
}) {
  const es = lang === 'es';
  const [open, setOpen] = useState(false);
  const [nm, setNm] = useState('');
  const go = () => { if (nm.trim()) onSave(nm.trim()); };
  return (
    <div style={{
      marginTop: 14, paddingTop: 12, borderTop: `1px solid ${T.rule}`,
      display: 'flex', flexDirection: 'column', gap: 10,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontFamily: fonts.mono, fontSize: 10.5, color: T.ink3, flexShrink: 0 }}>
          {total} {total === 1 ? (es ? 'turno' : 'shift') : (es ? 'turnos' : 'shifts')}
        </span>
        <span style={{ flex: 1 }}/>
        {total > 0 && <Btn variant="ghost" size="md" onClick={() => setOpen(o => !o)}>{es ? 'Guardar como plantilla' : 'Save as template'}</Btn>}
        {total > 0 && <Btn variant="primary" size="md" onClick={onUse}>{cta}</Btn>}
      </div>
      {open && (
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            autoFocus
            value={nm}
            onChange={e => setNm(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') go(); }}
            placeholder={es ? 'Ponle nombre — ej. Día estándar' : 'Name it — e.g. Standard weekday'}
            style={{
              flex: 1, boxSizing: 'border-box', padding: '9px 12px', borderRadius: 10,
              border: `1px solid ${T.rule}`, background: T.paper,
              fontFamily: fonts.sans, fontSize: 13, color: T.ink, outline: 'none',
            }}
          />
          <Btn variant="ghost" size="sm" onClick={() => setOpen(false)}>{es ? 'Cancelar' : 'Cancel'}</Btn>
          <Btn variant="primary" size="sm" style={{ borderRadius: 10 }} onClick={go}>{es ? 'Guardar' : 'Save'}</Btn>
        </div>
      )}
    </div>
  );
}

// ── history week preview — the same roster grid as the Week tab ────────────
function WeekPreview({
  win, getDay, staff, lang, reducedMotion, onUse, onSave,
}: {
  win: WeekInfo;
  getDay: (date: string) => BoardShift[];
  staff: StaffMember[];
  lang: 'en' | 'es';
  reducedMotion: boolean;
  onUse: () => void;
  onSave: (name: string) => void;
}) {
  const es = lang === 'es';
  const total = win.days.reduce((n, d) => n + getDay(d.date).length, 0);
  return (
    <div>
      <WeekRoster days={win.days} getDay={getDay} staff={staff} lang={lang} reducedMotion={reducedMotion}/>
      <SaveBar
        total={total}
        cta={es ? 'Usar esta semana →' : 'Use this week →'}
        lang={lang}
        onUse={onUse}
        onSave={onSave}
      />
    </div>
  );
}
