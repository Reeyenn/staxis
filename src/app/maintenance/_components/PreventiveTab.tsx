// Maintenance → Preventive tab. Centered three-band board (Claude Design
// handoff, Jun 2026): Overdue · Due this month · Upcoming. Only the non-empty
// bands render, centered. Tap a card to edit its cadence / last-done / notes,
// or hit "Done today" to bump the next-due.
//
// Wired to the real preventive_tasks data layer (realtime subscription +
// addPreventiveTask / completePreventiveTask / updatePreventiveTask).
//
// The physical equipment-ASSET registry (HVAC units, pumps — the `equipment`
// table, not the storeroom "Equipment" tab) still lives behind the "Equipment
// assets" button up top, exactly as before.

'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { Wrench } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useProperty } from '@/contexts/PropertyContext';
import { useLang } from '@/contexts/LanguageContext';
import {
  subscribeToPreventiveTasks, addPreventiveTask, completePreventiveTask, updatePreventiveTask,
} from '@/lib/db';
import type { PreventiveTask } from '@/types';
import {
  T, FONT_SANS, FONT_MONO, FONT_SERIF,
  Caps, Pill, Btn, Modal, Field, TextInput, TextArea,
  PageHead, BoardColumn, BoardCard, CenteredBoard, MtEmptyCard,
  useBoardGate, BoardLoading, BoardLoadError,
  relDue, fmtDate, fmtDateShort, daysBetween, addDaysLocal, cadenceLabel,
} from './_mt-snow';
import { useToast, ToastHost } from '@/app/_components/ui/toast';
import { EquipmentRegistry } from './EquipmentRegistry';
import { WheelDatePicker } from '@/components/ui/WheelDatePicker';

type Band = 'overdue' | 'soon' | 'upcoming';
const BAND: Record<Band, { color: string; tone: 'warm' | 'caramel' | 'sage'; en: string; es: string }> = {
  overdue:  { color: T.warm,     tone: 'warm',    en: 'Overdue',        es: 'Vencidas' },
  soon:     { color: T.caramel,  tone: 'caramel', en: 'Due this month', es: 'Este mes' },
  upcoming: { color: T.sageDeep, tone: 'sage',    en: 'Upcoming',       es: 'Próximas' },
};
const BAND_ORDER: Band[] = ['overdue', 'soon', 'upcoming'];

const UNITS = [
  { value: 'days',   mult: 1,   en: 'days',   es: 'días' },
  { value: 'weeks',  mult: 7,   en: 'weeks',  es: 'semanas' },
  { value: 'months', mult: 30,  en: 'months', es: 'meses' },
  { value: 'years',  mult: 365, en: 'years',  es: 'años' },
] as const;
type Unit = typeof UNITS[number]['value'];

function nextDueDate(t: PreventiveTask): Date {
  if (!t.lastCompletedAt) return new Date();
  // Calendar-day addition (DST-safe) — raw ms addition landed backfilled
  // midnight-anchored dates at 23:00 the previous day across the fall-back,
  // banding/displaying the due date one day early.
  return addDaysLocal(t.lastCompletedAt, t.frequencyDays);
}
function bandFor(t: PreventiveTask): Band {
  const d = daysBetween(new Date(), nextDueDate(t));
  if (d < 0) return 'overdue';
  if (d <= 30) return 'soon';
  return 'upcoming';
}
// Editor draft (count text + unit + optional last-done ISO date) → concrete
// cadence numbers. Shared by the New-task and edit modals, which previously
// each re-derived it inline. An empty `last` previews from today — callers
// must NOT persist `lastDate` when `last` is empty (that would silently stamp
// a never-completed task as completed today).
function cadenceFrom(count: string, unit: Unit, last: string): {
  n: number; freqDays: number; lastDate: Date; nextDue: Date;
} {
  const n = parseInt(count, 10) || 0;
  const freqDays = Math.max(1, n) * UNITS.find((u) => u.value === unit)!.mult;
  const lastDate = last ? new Date(`${last}T00:00:00`) : new Date();
  return { n, freqDays, lastDate, nextDue: addDaysLocal(lastDate, freqDays) };
}
// Best count+unit for a day-count (prefilling the editor): largest unit that
// divides evenly.
function daysToCountUnit(d: number): { count: number; unit: Unit } {
  if (d % 365 === 0) return { count: d / 365, unit: 'years' };
  if (d % 30 === 0)  return { count: d / 30,  unit: 'months' };
  if (d % 7 === 0)   return { count: d / 7,   unit: 'weeks' };
  return { count: d, unit: 'days' };
}

// ── frequency editor: number box + segmented unit control ──────────────────
function FreqEditor({
  count, unit, onCount, onUnit, es,
}: {
  count: string; unit: Unit; onCount: (v: string) => void; onUnit: (u: Unit) => void; es: boolean;
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
      <span style={{ fontFamily: FONT_SANS, fontSize: 14, color: T.ink2 }}>{es ? 'Cada' : 'Every'}</span>
      <input
        value={count} onChange={(e) => onCount(e.target.value)} type="number" min={1}
        style={{ width: 92, height: 44, textAlign: 'center', borderRadius: 12, border: `1px solid ${T.rule}`, background: T.bg, fontFamily: FONT_MONO, fontSize: 18, fontWeight: 600, color: T.ink, outline: 'none' }}
      />
      <div style={{ display: 'inline-flex', gap: 2, padding: 4, borderRadius: 12, border: `1px solid ${T.rule}`, background: T.bg }}>
        {UNITS.map((u) => {
          const on = unit === u.value;
          return (
            <button key={u.value} type="button" onClick={() => onUnit(u.value)}
              style={{ border: 'none', background: on ? T.paper : 'transparent', boxShadow: on ? '0 1px 2px rgba(31,35,28,0.12)' : 'none', cursor: 'pointer', padding: '8px 16px', borderRadius: 9, fontFamily: FONT_SANS, fontSize: 14, fontWeight: on ? 600 : 500, color: on ? T.ink : T.ink2 }}>
              {es ? u.es : u.en}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ── new task modal ───────────────────────────────────────────────────────────
function NewTaskModal({
  open, onClose, onCreate,
}: {
  open: boolean;
  onClose: () => void;
  onCreate: (args: { name: string; area: string; frequencyDays: number; lastCompletedISO: string | null }) => Promise<void>;
}) {
  const { lang } = useLang();
  const es = lang === 'es';
  const [name, setName] = useState('');
  const [area, setArea] = useState('');
  const [count, setCount] = useState('1');
  const [unit, setUnit] = useState<Unit>('months');
  const [last, setLast] = useState('');
  const [busy, setBusy] = useState(false);

  const reset = () => { setName(''); setArea(''); setCount('1'); setUnit('months'); setLast(''); setBusy(false); };
  const dirty = name.trim() !== '' || area.trim() !== '' || last !== '';
  // Guard the eaten-form path: Escape / a stray scrim click used to wipe the
  // half-typed task instantly. Confirm before discarding anything typed.
  const close = () => {
    if (dirty && !window.confirm(es
      ? '¿Descartar esta tarea sin agregar? Se perderá lo que escribiste.'
      : 'Discard this task? What you typed will be lost.')) return;
    reset();
    onClose();
  };

  const { n, freqDays, nextDue } = cadenceFrom(count, unit, last);
  const can = name.trim() && area.trim() && n > 0 && !busy;

  const submit = async () => {
    if (!can) return;
    setBusy(true);
    try {
      await onCreate({ name: name.trim(), area: area.trim(), frequencyDays: freqDays, lastCompletedISO: last ? new Date(`${last}T00:00:00`).toISOString() : null });
      reset();
      onClose();
    } catch {
      // Create failed — the board surfaced a toast; keep the form intact.
    } finally { setBusy(false); }
  };

  return (
    <Modal
      open={open} onClose={close}
      title={es ? 'Nueva tarea preventiva' : 'New preventive task'}
      subtitle={es ? 'Un trabajo recurrente que vuelve según un calendario.' : 'A recurring job that comes back on a schedule.'}
      width={600}
      footer={<>
        <Btn variant="ghost" onClick={close}>{es ? 'Cancelar' : 'Cancel'}</Btn>
        <Btn variant="primary" disabled={!can} onClick={submit}>{busy ? (es ? 'Agregando…' : 'Adding…') : (es ? 'Agregar tarea' : 'Add task')}</Btn>
      </>}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
        <Field label={es ? 'Tarea' : 'Task'} required><TextInput value={name} onChange={setName} placeholder={es ? 'ej. "Revisión de extintores"' : 'e.g. "Fire extinguisher check"'} /></Field>
        <Field label={es ? 'Área' : 'Area'} required><TextInput value={area} onChange={setArea} placeholder={es ? 'ej. "Edificio" o "Piscina"' : 'e.g. "Building" or "Pool"'} /></Field>
        <Field label={es ? 'Frecuencia' : 'Frequency'} required hint={es ? '¿Cada cuánto vuelve?' : 'How often does it come around?'}>
          <FreqEditor count={count} unit={unit} onCount={setCount} onUnit={setUnit} es={es} />
        </Field>
        <Field label={es ? 'Última vez completada' : 'Last completed'} hint={es ? 'Para configurar por primera vez' : 'For backfilling on first setup'}>
          <WheelDatePicker value={last} onChange={setLast} lang={es ? 'es' : 'en'} />
        </Field>
        <div style={{ background: T.sageDim, border: '1px solid rgba(104,131,114,0.22)', borderRadius: 12, padding: '14px 16px', display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <Caps size={10} c={T.sageDeep} weight={600}>{es ? 'Calculado' : 'Auto-calculated'}</Caps>
          <span style={{ fontFamily: FONT_SANS, fontSize: 15, color: T.ink }}>
            {es ? 'Próxima: ' : 'Next due: '}<strong style={{ fontWeight: 600 }}>{can ? fmtDate(nextDue, es) : '—'}</strong>
          </span>
        </div>
      </div>
    </Modal>
  );
}

// ── editable task detail modal ───────────────────────────────────────────────
function TaskModal({
  task, open, onClose, onSave, onCompleteToday,
}: {
  task: PreventiveTask | null;
  open: boolean;
  onClose: () => void;
  onSave: (id: string, args: { frequencyDays: number; lastCompletedISO: string | null; notes: string }) => Promise<void>;
  onCompleteToday: (id: string, args: { frequencyDays: number; notes: string }) => Promise<void>;
}) {
  const { lang } = useLang();
  const es = lang === 'es';
  const [count, setCount] = useState('1');
  const [unit, setUnit] = useState<Unit>('months');
  const [last, setLast] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);

  // Re-seed the editor only when the modal opens or switches tasks — NOT on
  // every realtime update, which would clobber the user's in-progress edits.
  useEffect(() => {
    if (task) {
      const cu = daysToCountUnit(task.frequencyDays);
      setCount(String(cu.count)); setUnit(cu.unit);
      setLast(task.lastCompletedAt ? new Date(task.lastCompletedAt.getTime() - task.lastCompletedAt.getTimezoneOffset() * 60000).toISOString().slice(0, 10) : '');
      setNotes(task.notes || '');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task?.id, open]);

  if (!task) return null;

  const { freqDays, lastDate, nextDue } = cadenceFrom(count, unit, last);
  const du = daysBetween(new Date(), nextDue);
  const band: Band = du < 0 ? 'overdue' : du <= 30 ? 'soon' : 'upcoming';
  const meta = BAND[band];

  const save = async () => {
    setBusy(true);
    try {
      // Empty date field = "no completion recorded" — send null so the save
      // leaves last_completed_at untouched instead of silently stamping a
      // never-completed task as completed today.
      await onSave(task.id, { frequencyDays: freqDays, lastCompletedISO: last ? lastDate.toISOString() : null, notes: notes.trim() });
      onClose();
    } catch { /* save failed — the board surfaced a toast; keep the modal open */ }
    finally { setBusy(false); }
  };
  const completeToday = async () => {
    setBusy(true);
    try { await onCompleteToday(task.id, { frequencyDays: freqDays, notes: notes.trim() }); onClose(); }
    catch { /* failed — the board surfaced a toast; keep the modal open */ }
    finally { setBusy(false); }
  };

  return (
    <Modal
      open={open} onClose={onClose}
      title={task.name} subtitle={task.area} width={580}
      footer={<>
        <Btn variant="ghost" onClick={onClose}>{es ? 'Cerrar' : 'Close'}</Btn>
        <Btn variant="sage" disabled={busy} onClick={completeToday}>{busy ? '…' : (es ? '✓ Hecho hoy' : '✓ Done today')}</Btn>
        <Btn variant="primary" disabled={busy} onClick={save}>{busy ? '…' : (es ? 'Guardar' : 'Save changes')}</Btn>
      </>}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <Pill tone={meta.tone}>{es ? meta.es : meta.en}</Pill>
          <Caps size={11} tracking="0.06em">{es ? 'Próxima' : 'Next due'} {fmtDate(nextDue, es)} · {relDue(du, es)}</Caps>
        </div>
        <Field label={es ? 'Frecuencia' : 'Frequency'} required hint={es ? '¿Cada cuánto vuelve?' : 'How often does it come around?'}>
          <FreqEditor count={count} unit={unit} onCount={setCount} onUnit={setUnit} es={es} />
        </Field>
        <Field label={es ? 'Última vez completada' : 'Last completed'} hint={es ? 'La próxima se calcula desde aquí.' : 'Next due is calculated from here.'}>
          <WheelDatePicker value={last} onChange={setLast} lang={es ? 'es' : 'en'} />
        </Field>
        <Field label={es ? 'Notas' : 'Notes'} hint={es ? 'Lo que la próxima persona debería saber.' : 'What the next person should know.'}>
          <TextArea value={notes} onChange={setNotes} placeholder={es ? 'ej. MERV 8, 20×25×1. La caja está en el cuarto de máquinas.' : 'e.g. MERV 8, 20×25×1. Box is in the mechanical room.'} rows={3} />
        </Field>
      </div>
    </Modal>
  );
}

// ── root ─────────────────────────────────────────────────────────────────────
export function PreventiveTab() {
  const { user } = useAuth();
  const { activePropertyId } = useProperty();
  const { lang } = useLang();
  const es = lang === 'es';

  const [tasks, setTasks] = useState<PreventiveTask[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [newOpen, setNewOpen] = useState(false);
  const [selId, setSelId] = useState<string | null>(null);
  const [registryOpen, setRegistryOpen] = useState(false);

  // Failure feedback for board writes (same ink pill as the equipment registry).
  const { toasts, show: flash } = useToast({ durationMs: 3600, max: 1 });

  // Load gate: don't render the happy "No preventive tasks yet" empty state
  // until the first snapshot arrived; error card + retry when the load failed.
  const gate = useBoardGate(activePropertyId, 'preventive_tasks', loaded);

  useEffect(() => {
    if (!user || !activePropertyId) return;
    setLoaded(false);
    const unsub = subscribeToPreventiveTasks(user.uid, activePropertyId, (rows) => {
      setLoaded(true);
      setTasks(rows);
    });
    return () => unsub();
  }, [user, activePropertyId, gate.retryKey]);

  const sel = selId ? tasks.find((t) => t.id === selId) ?? null : null;
  const overdueCount = useMemo(() => tasks.filter((t) => bandFor(t) === 'overdue').length, [tasks]);
  const liveBands = BAND_ORDER.filter((b) => tasks.some((t) => bandFor(t) === b));

  const handleCreate = async (args: { name: string; area: string; frequencyDays: number; lastCompletedISO: string | null }) => {
    if (!user || !activePropertyId) return;
    try {
      await addPreventiveTask(user.uid, activePropertyId, {
        propertyId: activePropertyId,
        name: args.name,
        area: args.area,
        frequencyDays: args.frequencyDays,
        lastCompletedAt: args.lastCompletedISO ? new Date(args.lastCompletedISO) : new Date(),
        lastCompletedBy: user.displayName,
        notes: undefined,
        equipmentId: null,
      });
    } catch (err) {
      flash(es ? 'No se pudo agregar la tarea — revisa la conexión e inténtalo de nuevo.' : "Couldn't add the task — check your connection and try again.");
      throw err;
    }
  };

  const handleSave = async (id: string, args: { frequencyDays: number; lastCompletedISO: string | null; notes: string }) => {
    if (!user || !activePropertyId) return;
    const patch: Partial<PreventiveTask> = {
      frequencyDays: args.frequencyDays,
      notes: args.notes || undefined,
    };
    // Null = the date field was left empty ("never completed") — leave
    // last_completed_at alone rather than fabricating a completion.
    if (args.lastCompletedISO) patch.lastCompletedAt = new Date(args.lastCompletedISO);
    try {
      await updatePreventiveTask(user.uid, activePropertyId, id, patch);
    } catch (err) {
      flash(es ? 'No se pudieron guardar los cambios — revisa la conexión e inténtalo de nuevo.' : "Couldn't save the changes — check your connection and try again.");
      throw err;
    }
  };

  // Quick-complete (card button or modal "Done today"): stamp last_completed,
  // persisting any cadence/notes edits first. Failures surface in a toast —
  // callers see the rejection (modal stays open); the card button swallows it.
  const handleCompleteToday = async (id: string, edits?: { frequencyDays: number; notes: string }) => {
    if (!user || !activePropertyId) return;
    try {
      if (edits) {
        await updatePreventiveTask(user.uid, activePropertyId, id, { frequencyDays: edits.frequencyDays, notes: edits.notes || undefined });
      }
      await completePreventiveTask(id, { completedISO: new Date().toISOString(), completedByName: user.displayName });
    } catch (err) {
      flash(es ? 'No se pudo marcar como hecha — revisa la conexión e inténtalo de nuevo.' : "Couldn't mark it done — check your connection and try again.");
      throw err;
    }
  };

  if (registryOpen) {
    return <EquipmentRegistry onBack={() => setRegistryOpen(false)} />;
  }

  return (
    <div style={{ padding: '28px 48px 64px', background: T.bg, color: T.ink, fontFamily: FONT_SANS, minHeight: 'calc(100dvh - 130px)' }}>
      <PageHead
        eyebrow={es ? 'Preventivo · programado' : 'Preventive · scheduled'}
        lead={overdueCount > 0 ? `${overdueCount} ${es ? 'vencidas' : 'overdue'}` : (es ? 'Todo al día' : 'All on track')}
        rest={`${tasks.length} ${tasks.length === 1 ? (es ? 'tarea recurrente' : 'recurring task') : (es ? 'tareas recurrentes' : 'recurring tasks')}`}
        actions={<>
          <Btn variant="ghost" onClick={() => setRegistryOpen(true)}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Wrench size={14} /> {es ? 'Activos' : 'Equipment assets'}</span>
          </Btn>
          <Btn variant="primary" onClick={() => setNewOpen(true)}>＋ {es ? 'Nueva tarea' : 'New task'}</Btn>
        </>}
      />

      {gate.status === 'error' ? (
        <BoardLoadError es={es} onRetry={gate.retry} />
      ) : gate.status === 'loading' ? (
        <BoardLoading es={es} />
      ) : tasks.length === 0 ? (
        <MtEmptyCard
          title={es ? 'Sin tareas preventivas aún.' : 'No preventive tasks yet.'}
          body={es ? 'Inspecciones, cambios de filtro, revisiones de extintores — todo lo que vuelve según un calendario.' : 'Inspections, filter swaps, fire-extinguisher checks — anything on a recurring schedule.'}
          action={<Btn variant="primary" onClick={() => setNewOpen(true)}>＋ {es ? 'Agrega tu primera tarea' : 'Add your first task'}</Btn>}
        />
      ) : (
        <CenteredBoard>
          {liveBands.map((b) => {
            const meta = BAND[b];
            const items = tasks.filter((t) => bandFor(t) === b)
              .sort((a, c) => daysBetween(new Date(), nextDueDate(a)) - daysBetween(new Date(), nextDueDate(c)));
            return (
              <BoardColumn key={b} color={meta.color} label={es ? meta.es : meta.en} count={items.length}>
                {items.map((t) => {
                  const du = daysBetween(new Date(), nextDueDate(t));
                  return (
                    <BoardCard key={t.id} accent={meta.color} onClick={() => setSelId(t.id)}>
                      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
                        <span style={{ fontFamily: FONT_SERIF, fontSize: 21, color: T.ink, fontStyle: 'italic', letterSpacing: '-0.02em', lineHeight: 1.15, fontWeight: 400 }}>{t.name}</span>
                        <span style={{ fontFamily: FONT_MONO, fontSize: 11.5, fontWeight: 600, color: meta.color, whiteSpace: 'nowrap', flexShrink: 0 }}>{relDue(du, es)}</span>
                      </div>
                      <span style={{ fontFamily: FONT_SANS, fontSize: 12.5, color: T.ink2, lineHeight: 1.4 }}>{t.area ? `${t.area} · ` : ''}{cadenceLabel(t.frequencyDays, es)}</span>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginTop: 1 }}>
                        <Caps size={10} tracking="0.06em" c={T.ink3}>{es ? 'próx' : 'next'} · {fmtDateShort(nextDueDate(t), es)}</Caps>
                        <Btn variant={b === 'upcoming' ? 'ghost' : 'sage'} size="sm" onClick={(e) => { e.stopPropagation(); handleCompleteToday(t.id).catch(() => { /* toast shown */ }); }}>✓ {es ? 'Hecho hoy' : 'Done today'}</Btn>
                      </div>
                    </BoardCard>
                  );
                })}
              </BoardColumn>
            );
          })}
        </CenteredBoard>
      )}

      <NewTaskModal open={newOpen} onClose={() => setNewOpen(false)} onCreate={handleCreate} />
      <TaskModal
        task={sel}
        open={!!sel}
        onClose={() => setSelId(null)}
        onSave={handleSave}
        onCompleteToday={(id, edits) => handleCompleteToday(id, edits)}
      />

      <ToastHost
        toasts={toasts}
        position="bottom"
        offset="28px"
        zIndex={1100}
        toastStyle={{ background: T.ink, color: T.bg, padding: '12px 22px', borderRadius: 12, fontFamily: FONT_SANS, fontSize: 13, fontWeight: 500, boxShadow: '0 12px 32px rgba(31,35,28,0.24)' }}
      />
    </div>
  );
}
