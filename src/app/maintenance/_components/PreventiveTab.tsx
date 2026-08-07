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
import { useActiveHotelStanding, useCan } from '@/lib/capabilities/useCan';
import {
  subscribeToPreventiveTasks, addPreventiveTask, completePreventiveTask, updatePreventiveTask,
} from '@/lib/db';
import type { PreventiveTask } from '@/types';
import {
  T, FONT_SANS, FONT_MONO,
  Caps, Pill, Btn, Modal, Field, TextInput, TextArea,
  PageHead, BoardColumn, BoardCard, CenteredBoard, MtEmptyCard,
  useBoardGate, BoardLoading, BoardLoadError,
  relDue, fmtDate, fmtDateShort, daysBetween, addDaysLocal, cadenceLabel,
} from './_mt-snow';
import { useToast, ToastHost } from '@/app/_components/ui/toast';
import { EquipmentRegistry } from './EquipmentRegistry';
import { WheelDatePicker } from '@/components/ui/WheelDatePicker';
import { PatternChip } from '@/components/concourse/PatternChip';

type Band = 'overdue' | 'soon' | 'upcoming';
const BAND: Record<Band, { color: string; tone: 'warm' | 'caramel' | 'sage'; en: string }> = {
  overdue:  { color: T.warm,     tone: 'warm',    en: 'Overdue',        },
  soon:     { color: T.caramel,  tone: 'caramel', en: 'Due this month', },
  upcoming: { color: T.sageDeep, tone: 'sage',    en: 'Upcoming',       },
};
const BAND_ORDER: Band[] = ['overdue', 'soon', 'upcoming'];

const UNITS = [
  { value: 'days',   mult: 1,   en: 'days',   },
  { value: 'weeks',  mult: 7,   en: 'weeks',  },
  { value: 'months', mult: 30,  en: 'months', },
  { value: 'years',  mult: 365, en: 'years',  },
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

// ── "somebody's been called" ────────────────────────────────────────────────
//
// The state between overdue and done (0366). It is deliberately NOT a band: the
// task is still late, and moving it out of Overdue would hide a job nobody has
// actually done behind a phone call. It shows as a line ON the card instead, so
// the board still tells the truth about what is outstanding while also saying
// that somebody is on it.
//
// Set from the Staxis due card ("Somebody's been called") or from this tab's own
// button below. Cleared by a database trigger the moment last-done moves, so a
// task marked done from anywhere stops claiming a pending call.
function calledLine(t: PreventiveTask, es: boolean): string | null {
  if (!t.calledAt) return null;
  const days = Math.max(0, daysBetween(t.calledAt, new Date()));
  const who = t.calledBy?.trim();
  const when =
    days === 0
      ? ('today')
      : days === 1
        ? ('yesterday')
        : (`${days} days ago`);

  return who ? `${who} called somebody ${when}` : `Somebody was called ${when}`;
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
      <span style={{ fontFamily: FONT_SANS, fontSize: 14, color: T.ink2 }}>{'Every'}</span>
      <input
        value={count} onChange={(e) => onCount(e.target.value)} type="number" min={1}
        style={{ width: 92, height: 44, textAlign: 'center', borderRadius: 12, border: '1px solid rgba(31,35,28,0.14)', background: '#FFFFFF', fontFamily: FONT_MONO, fontSize: 18, fontWeight: 600, color: T.ink, outline: 'none' }}
      />
      <div style={{ display: 'inline-flex', gap: 2, padding: 3, borderRadius: 999, background: 'rgba(31,35,28,0.05)' }}>
        {UNITS.map((u) => {
          const on = unit === u.value;
          return (
            <button key={u.value} type="button" onClick={() => onUnit(u.value)}
              style={{ border: 'none', background: on ? '#1F231C' : 'transparent', cursor: 'pointer', padding: '8px 16px', borderRadius: 999, fontFamily: FONT_SANS, fontSize: 13, fontWeight: on ? 600 : 500, color: on ? '#FFFFFF' : T.ink2, transition: 'background .2s, color .2s' }}>
              {u.en}
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
  const es = false;
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
    if (dirty && !window.confirm('Discard this task? What you typed will be lost.')) return;
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
      title={'New preventive task'}
      subtitle={'A recurring job that comes back on a schedule.'}
      width={600}
      footer={<>
        <Btn variant="ghost" onClick={close}>{'Cancel'}</Btn>
        <Btn variant="primary" disabled={!can} onClick={submit}>{busy ? ('Adding…') : ('Add task')}</Btn>
      </>}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
        {/* 120 chars, matching CHECK preventive_tasks_name_len_ck (0370) and
            equipment.name. A schedule's name is quoted into the nightly cards
            and into the model call behind them, so a pasted document in this
            box is somebody else's spend cap. The database refuses it too — this
            just means the manager finds out here rather than on save. */}
        <Field label={'Task'} required><TextInput maxLength={120} value={name} onChange={setName} placeholder={'e.g. "Fire extinguisher check"'} /></Field>
        <Field label={'Area'} required><TextInput value={area} onChange={setArea} placeholder={'e.g. "Building" or "Pool"'} /></Field>
        <Field label={'Frequency'} required hint={'How often does it come around?'}>
          <FreqEditor count={count} unit={unit} onCount={setCount} onUnit={setUnit} es={es} />
        </Field>
        <Field label={'Last completed'} hint={'For backfilling on first setup'}>
          <WheelDatePicker value={last} onChange={setLast} lang={'en'} />
        </Field>
        <div style={{ background: 'rgba(158,183,166,0.14)', border: '1px solid rgba(92,122,96,0.25)', borderRadius: 12, padding: '14px 16px', display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <Caps size={10} c={T.sageDeep} weight={600}>{'Auto-calculated'}</Caps>
          <span style={{ fontFamily: FONT_SANS, fontSize: 15, color: T.ink }}>
            {'Next due: '}<strong style={{ fontWeight: 600 }}>{can ? fmtDate(nextDue) : '—'}</strong>
          </span>
        </div>
      </div>
    </Modal>
  );
}

// ── editable task detail modal ───────────────────────────────────────────────
function TaskModal({
  task, open, onClose, onSave, onCompleteToday, onCalled, propertyId, canEdit,
}: {
  task: PreventiveTask | null;
  open: boolean;
  onClose: () => void;
  onSave: (id: string, args: { frequencyDays: number; lastCompletedISO: string | null; notes: string }) => Promise<void>;
  onCompleteToday: (id: string, args: { frequencyDays: number; notes: string }) => Promise<void>;
  onCalled: (id: string) => Promise<void>;
  propertyId: string | null;
  /** Whether this viewer may change upkeep schedules at this hotel. */
  canEdit: boolean;
}) {
  const { lang } = useLang();
  const es = false;
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

  const { n, freqDays, lastDate, nextDue } = cadenceFrom(count, unit, last);
  const du = daysBetween(new Date(), nextDue);
  const band: Band = du < 0 ? 'overdue' : du <= 30 ? 'soon' : 'upcoming';
  const meta = BAND[band];
  // Same guard the create form uses. An emptied or zeroed frequency box falls
  // through cadenceFrom's Math.max(1, n), so saving it would quietly turn
  // "every 6 months" into "every 1 month" and start nagging five months early.
  const canSave = canEdit && n > 0 && !busy;

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
  // Deliberately does NOT touch last-done. Arranging the work is not doing it,
  // and recording a call as a completion would restart this task's clock on a
  // job nobody has performed — after which Staxis would stay quiet about it for
  // a full cadence, which is the worst thing this feature could get wrong.
  const called = async () => {
    setBusy(true);
    try { await onCalled(task.id); onClose(); }
    catch { /* failed — the board surfaced a toast; keep the modal open */ }
    finally { setBusy(false); }
  };
  const wasCalled = calledLine(task, es);
  const isLate = daysBetween(new Date(), nextDueDate(task)) < 0;

  return (
    <Modal
      open={open} onClose={onClose}
      title={task.name} subtitle={task.area} width={580}
      footer={<>
        <Btn variant="ghost" onClick={onClose}>{'Close'}</Btn>
        {/* Only offered on a task that is actually late. On one that is not yet
            due there is nothing to have called anybody about, and a button that
            silences a card which does not exist would be a trap. */}
        {canEdit && isLate && !task.calledAt && (
          <Btn variant="ghost" disabled={busy} onClick={called}>
            {busy ? '…' : ("Somebody's been called")}
          </Btn>
        )}
        {canEdit && <Btn variant="sage" disabled={!canSave} onClick={completeToday}>{busy ? '…' : ('✓ Done today')}</Btn>}
        {canEdit && <Btn variant="primary" disabled={!canSave} onClick={save}>{busy ? '…' : ('Save changes')}</Btn>}
      </>}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <Pill tone={meta.tone}>{meta.en}</Pill>
          <Caps size={11} tracking="0.06em">{'Next due'} {fmtDate(nextDue)} · {relDue(du)}</Caps>
        </div>

        {!canEdit && (
          <div style={{
            background: 'rgba(31,35,28,0.03)', border: `1px solid ${T.rule}`,
            borderRadius: 12, padding: '12px 14px', fontFamily: FONT_SANS,
            fontSize: 13, color: T.ink2, lineHeight: 1.45,
          }}>
            {'This is view only. Ask a manager to change the schedule or mark it done.'}
          </div>
        )}

        {/* On the THING, not the tab: this modal is one upkeep schedule, so the
            signpost to its card in the Staxis queue belongs here and nowhere on
            the board behind it. Renders nothing at all when there is no card. */}
        <PatternChip propertyId={propertyId} kind="preventive_task" value={task.id} lang={lang} />

        {wasCalled && (
          <div style={{
            background: 'rgba(201,150,68,0.12)', border: '1px solid rgba(176,124,60,0.28)',
            borderRadius: 12, padding: '12px 14px', fontFamily: FONT_SANS, fontSize: 13.5,
            color: '#7A5518', lineHeight: 1.45,
          }}>
            {wasCalled}. {'It still counts as outstanding until it is marked done.'}
          </div>
        )}
        <Field label={'Frequency'} required hint={'How often does it come around?'}>
          <FreqEditor count={count} unit={unit} onCount={setCount} onUnit={setUnit} es={es} />
        </Field>
        <Field label={'Last completed'} hint={'Next due is calculated from here.'}>
          <WheelDatePicker value={last} onChange={setLast} lang={'en'} />
        </Field>
        <Field label={'Notes'} hint={'What the next person should know.'}>
          <TextArea value={notes} onChange={setNotes} placeholder={'e.g. MERV 8, 20×25×1. Box is in the mechanical room.'} rows={3} />
        </Field>
      </div>
    </Modal>
  );
}

// Every write on this board lands in preventive_tasks, whose insert/update/
// delete policies all require staxis_user_can_manage_equipment (0334). An
// insufficient-privilege refusal is not a dropped connection, so don't tell the
// user to check their connection about it.
function writeFailureMessage(e: unknown, fallback: string): string {
  const code = String((e as { code?: string } | null)?.code ?? '');
  return code === '42501'
    ? "You don't have permission to change upkeep schedules."
    : fallback;
}

// ── root ─────────────────────────────────────────────────────────────────────
export function PreventiveTab() {
  const { user } = useAuth();
  const { activePropertyId } = useProperty();
  const { lang } = useLang();
  const es = false;
  // The capability overrides answer whether this role may change upkeep
  // schedules; the normalized standing separately answers whether this viewer
  // may mutate this hotel at all. Both have to hold, because the database
  // policy behind every button below checks the same thing.
  const hotelStanding = useActiveHotelStanding();
  const can = useCan();
  const canEdit = hotelStanding.ready && hotelStanding.hotelMutationAllowed && can('manage_equipment');

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
      flash(writeFailureMessage(err, "Couldn't add the task. Check your connection and try again."));
      throw err;
    }
  };

  const handleSave = async (id: string, args: { frequencyDays: number; lastCompletedISO: string | null; notes: string }) => {
    if (!user || !activePropertyId) return;
    const patch: Partial<PreventiveTask> = {
      frequencyDays: args.frequencyDays,
      // Send the emptied box as an empty string, NOT undefined. toPreventiveRow
      // drops undefined keys, so `|| undefined` left the notes column out of the
      // UPDATE entirely and a deleted note came straight back on the next
      // refetch — the manager replaced a filter spec and the old one survived.
      notes: args.notes,
    };
    // Null = the date field was left empty ("never completed") — leave
    // last_completed_at alone rather than fabricating a completion.
    if (args.lastCompletedISO) patch.lastCompletedAt = new Date(args.lastCompletedISO);
    try {
      await updatePreventiveTask(user.uid, activePropertyId, id, patch);
    } catch (err) {
      flash(writeFailureMessage(err, "Couldn't save the changes. Check your connection and try again."));
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
        // Empty string, not undefined — see handleSave on why `|| undefined`
        // silently discarded a cleared note.
        await updatePreventiveTask(user.uid, activePropertyId, id, { frequencyDays: edits.frequencyDays, notes: edits.notes });
      }
      await completePreventiveTask(id, { completedISO: new Date().toISOString(), completedByName: user.displayName });
    } catch (err) {
      flash(writeFailureMessage(err, "Couldn't mark it done. Check your connection and try again."));
      throw err;
    }
  };

  // "Somebody's been called": arranged, not done. Writes only the called flag —
  // last-done stays exactly where it was, because the job has not happened.
  const handleCalled = async (id: string) => {
    if (!user || !activePropertyId) return;
    try {
      await updatePreventiveTask(user.uid, activePropertyId, id, {
        calledAt: new Date(),
        calledBy: user.displayName,
      });
    } catch (err) {
      flash(writeFailureMessage(err, "Couldn't save that. Check your connection and try again."));
      throw err;
    }
  };

  if (registryOpen) {
    return <EquipmentRegistry onBack={() => setRegistryOpen(false)} />;
  }

  return (
    <div style={{ padding: '28px 48px 130px', background: 'transparent', color: T.ink, fontFamily: FONT_SANS, minHeight: 'calc(100dvh - 130px)' }}>
      <PageHead
        eyebrow={'Preventive · scheduled'}
        lead={overdueCount > 0 ? `${overdueCount} ${'overdue'}` : ('All on track')}
        rest={`${tasks.length} ${tasks.length === 1 ? ('recurring task') : ('recurring tasks')}`}
        actions={<>
          <Btn variant="ghost" onClick={() => setRegistryOpen(true)}>
            {/* This opens the asset registry, distinct from the storeroom board. */}
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Wrench size={14} /> {'Equipment assets'}</span>
          </Btn>
          {canEdit && <Btn variant="primary" onClick={() => setNewOpen(true)}>＋ {'New task'}</Btn>}
        </>}
      />

      {gate.status === 'error' ? (
        <BoardLoadError es={es} onRetry={gate.retry} />
      ) : gate.status === 'loading' ? (
        <BoardLoading es={es} />
      ) : tasks.length === 0 ? (
        <MtEmptyCard
          title={'No preventive tasks yet.'}
          body={'Inspections, filter swaps, fire-extinguisher checks, anything on a recurring schedule.'}
          action={canEdit ? <Btn variant="primary" onClick={() => setNewOpen(true)}>＋ {'Add your first task'}</Btn> : undefined}
        />
      ) : (
        <CenteredBoard>
          {liveBands.map((b) => {
            const meta = BAND[b];
            const items = tasks.filter((t) => bandFor(t) === b)
              .sort((a, c) => daysBetween(new Date(), nextDueDate(a)) - daysBetween(new Date(), nextDueDate(c)));
            return (
              <BoardColumn key={b} color={meta.color} label={meta.en} count={items.length}>
                {items.map((t) => {
                  const du = daysBetween(new Date(), nextDueDate(t));
                  return (
                    <BoardCard key={t.id} accent={meta.color} onClick={() => setSelId(t.id)}>
                      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
                        <span style={{ fontFamily: FONT_SANS, fontSize: 15, color: T.ink, letterSpacing: '-0.01em', lineHeight: 1.25, fontWeight: 600 }}>{t.name}</span>
                        <span style={{ fontFamily: FONT_MONO, fontSize: 10.5, fontWeight: 600, color: meta.color, whiteSpace: 'nowrap', flexShrink: 0 }}>{relDue(du)}</span>
                      </div>
                      <span style={{ fontFamily: FONT_SANS, fontSize: 12.5, color: T.ink2, lineHeight: 1.4 }}>{t.area ? `${t.area} · ` : ''}{cadenceLabel(t.frequencyDays)}</span>
                      {/* Still outstanding, but somebody is on it. Said on the
                          card so the board is not silently identical to one
                          where nobody has done anything at all. */}
                      {calledLine(t, es) && (
                        <span style={{ fontFamily: FONT_SANS, fontSize: 12, color: '#8A5A22', lineHeight: 1.4 }}>
                          {calledLine(t, es)}
                        </span>
                      )}
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginTop: 1 }}>
                        <Caps size={10} tracking="0.06em" c={T.ink3}>{'next'} · {fmtDateShort(nextDueDate(t))}</Caps>
                        {canEdit && <Btn variant={b === 'upcoming' ? 'ghost' : 'sage'} size="sm" onClick={(e) => { e.stopPropagation(); handleCompleteToday(t.id).catch(() => { /* toast shown */ }); }}>✓ {'Done today'}</Btn>}
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
        canEdit={canEdit}
        propertyId={activePropertyId}
        onClose={() => setSelId(null)}
        onSave={handleSave}
        onCompleteToday={(id, edits) => handleCompleteToday(id, edits)}
        onCalled={handleCalled}
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
