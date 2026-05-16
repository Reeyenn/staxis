// Maintenance → Preventive tab.
// Scheduled recurring tasks (inspections, filter swaps, fire-extinguisher
// checks). Color-coded by closeness to due. Sorted overdue-first.

'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { useProperty } from '@/contexts/PropertyContext';
import { supabase } from '@/lib/supabase';
import {
  subscribeToPreventiveTasks, addPreventiveTask, completePreventiveTask,
} from '@/lib/db';
import type { PreventiveTask } from '@/types';
import { Btn, Caps } from '@/app/housekeeping/_components/_snow';
import {
  T, FONT_SANS, FONT_MONO, FONT_SERIF,
  Modal, Field, TextInput, TextArea, PhotoSlot,
  StorageImage, fmtDate, relTime, daysBetween,
} from './_mt-snow';

type Band = 'overdue' | 'due-soon' | 'fresh';
const bandTone: Record<Band, { color: string; bg: string; bd: string; label: string }> = {
  overdue:    { color: '#B85C3D', bg: 'rgba(184,92,61,0.10)',  bd: 'rgba(184,92,61,0.30)',  label: 'Overdue'  },
  'due-soon': { color: '#C99644', bg: 'rgba(201,150,68,0.12)', bd: 'rgba(201,150,68,0.32)', label: 'Due soon' },
  fresh:      { color: '#5C7A60', bg: 'rgba(92,122,96,0.10)',  bd: 'rgba(92,122,96,0.28)',  label: 'Fresh'    },
};

// Derive next-due Date from the task's last-completed timestamp + cadence.
// Tasks with no last_completed_at are treated as due today (so they surface
// in the overdue band).
function nextDueDate(t: PreventiveTask): Date {
  if (!t.lastCompletedAt) return new Date();
  return new Date(t.lastCompletedAt.getTime() + t.frequencyDays * 24 * 60 * 60 * 1000);
}

function bandFor(t: PreventiveTask, today: Date = new Date()): Band {
  const days = daysBetween(today, nextDueDate(t));
  if (days < 0)  return 'overdue';
  if (days <= 7) return 'due-soon';
  return 'fresh';
}

// Human label for frequency. "Every 90 days" / "Every 2 weeks" / "Yearly".
function freqLabel(days: number): string {
  if (days === 1) return 'Daily';
  if (days === 7) return 'Weekly';
  if (days === 14) return 'Every 2 weeks';
  if (days === 30) return 'Monthly';
  if (days === 365) return 'Yearly';
  if (days % 30 === 0) return `Every ${days / 30} months`;
  if (days % 7 === 0)  return `Every ${days / 7} weeks`;
  return `Every ${days} days`;
}

// ─────────────────────────────────────────────────────────────────────────
// ROW
// ─────────────────────────────────────────────────────────────────────────
function PMRow({ t, onOpen }: { t: PreventiveTask; onOpen: (t: PreventiveTask) => void }) {
  const band = bandFor(t);
  const tone = bandTone[band];
  const due = nextDueDate(t);
  const days = daysBetween(new Date(), due);

  return (
    <button onClick={() => onOpen(t)} style={{
      textAlign: 'left', cursor: 'pointer', width: '100%',
      background: T.paper, border: `1px solid ${T.rule}`, borderRadius: 14,
      padding: '16px 22px 16px 26px', display: 'grid',
      gridTemplateColumns: 'minmax(220px, 1.6fr) 130px 150px auto',
      gap: 18, alignItems: 'center', overflow: 'hidden', position: 'relative',
    }}>
      {/* status accent bar */}
      <span style={{
        position: 'absolute', left: 0, top: 0, bottom: 0, width: 4, background: tone.color,
      }}/>

      {/* task name + area */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 }}>
        <span style={{ fontFamily: FONT_SERIF, fontSize: 22, color: T.ink, fontStyle: 'italic', letterSpacing: '-0.02em', lineHeight: 1.1, fontWeight: 400 }}>
          {t.name}
        </span>
        <span style={{ fontFamily: FONT_MONO, fontSize: 11, color: T.ink2, letterSpacing: '0.04em' }}>
          {t.area ? `${t.area} · ` : ''}{freqLabel(t.frequencyDays)}
        </span>
      </div>

      {/* status pill */}
      <span style={{
        padding: '5px 12px', borderRadius: 999, height: 24,
        display: 'inline-flex', alignItems: 'center', gap: 6, justifySelf: 'start',
        background: tone.bg, color: tone.color, border: `1px solid ${tone.bd}`,
        fontFamily: FONT_SANS, fontSize: 12, fontWeight: 600,
      }}>
        <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: tone.color }} />
        {tone.label}
      </span>

      {/* due date */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <span style={{ fontFamily: FONT_SANS, fontSize: 13, color: T.ink, fontWeight: 500 }}>
          Due {fmtDate(due)}
        </span>
        <span style={{ fontFamily: FONT_MONO, fontSize: 11, color: tone.color, fontWeight: 600 }}>
          {relTime(days)}
        </span>
      </div>

      <span style={{
        fontFamily: FONT_SERIF, fontSize: 24, color: T.ink2, fontStyle: 'italic',
        letterSpacing: '-0.02em', lineHeight: 1, justifySelf: 'end',
      }}>→</span>
    </button>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// ADD MODAL
// ─────────────────────────────────────────────────────────────────────────
function AddModal({
  open, onClose, onAdd,
}: {
  open: boolean;
  onClose: () => void;
  onAdd: (t: {
    name: string;
    area: string;
    frequencyDays: number;
    lastCompletedISO: string;
    notes?: string;
  }) => Promise<void>;
}) {
  const [name, setName] = useState('');
  const [area, setArea] = useState('');
  const [freqN, setFreqN] = useState('90');
  const [freqUnit, setFreqUnit] = useState<'days' | 'weeks' | 'months' | 'years'>('days');
  const [lastDate, setLastDate] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);

  const reset = () => {
    setName(''); setArea(''); setFreqN('90'); setFreqUnit('days');
    setLastDate(''); setNotes(''); setBusy(false);
  };
  const close = () => { reset(); onClose(); };

  const freqDays = useMemo(() => {
    const n = parseInt(freqN, 10) || 0;
    const mult: Record<typeof freqUnit, number> = { days: 1, weeks: 7, months: 30, years: 365 };
    return n * mult[freqUnit];
  }, [freqN, freqUnit]);

  const nextDuePreview = useMemo(() => {
    if (!lastDate) return null;
    const d = new Date(lastDate);
    if (isNaN(d.getTime())) return null;
    return new Date(d.getTime() + freqDays * 24 * 60 * 60 * 1000);
  }, [lastDate, freqDays]);

  const computedDaysUntil = nextDuePreview ? daysBetween(new Date(), nextDuePreview) : null;

  const canSubmit = !!name.trim() && !!area.trim() && freqDays > 0 && !!lastDate && !busy;

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    try {
      await onAdd({
        name: name.trim(),
        area: area.trim(),
        frequencyDays: freqDays,
        lastCompletedISO: new Date(lastDate).toISOString(),
        notes: notes.trim() || undefined,
      });
      reset();
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={close}
      title="Add a preventive task"
      subtitle="Recurring inspections, scheduled cleanings, anything that comes around again."
      width={580}
      footer={
        <>
          <Btn variant="ghost" size="md" onClick={close}>Cancel</Btn>
          <Btn
            variant="primary"
            size="md"
            onClick={submit}
            disabled={!canSubmit}
            style={{ opacity: canSubmit ? 1 : 0.4 }}
          >
            {busy ? 'Adding…' : 'Add task'}
          </Btn>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
        <Field label="Task name" required>
          <TextInput value={name} onChange={setName} placeholder={'e.g. "Elevator inspection"'} />
        </Field>

        <Field label="Location / area" required>
          <TextInput value={area} onChange={setArea} placeholder={'e.g. "Floor 2" or "Building"'} />
        </Field>

        <Field label="Frequency" required hint="How often does it come around?">
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={{ fontFamily: FONT_SANS, fontSize: 13, color: T.ink2 }}>Every</span>
            <input
              type="number"
              min={1}
              value={freqN}
              onChange={e => setFreqN(e.target.value)}
              style={{
                width: 80, height: 40, padding: '0 12px', borderRadius: 10,
                background: T.bg, border: `1px solid ${T.rule}`,
                fontFamily: FONT_MONO, fontSize: 14, color: T.ink, outline: 'none', textAlign: 'center',
              }}
            />
            <div style={{
              display: 'flex', gap: 4, padding: 4,
              background: T.bg, border: `1px solid ${T.rule}`, borderRadius: 10,
            }}>
              {(['days', 'weeks', 'months', 'years'] as const).map(u => (
                <button
                  key={u}
                  type="button"
                  onClick={() => setFreqUnit(u)}
                  style={{
                    padding: '6px 12px', borderRadius: 6, cursor: 'pointer',
                    background: freqUnit === u ? T.paper : 'transparent',
                    border: 'none',
                    color: freqUnit === u ? T.ink : T.ink2,
                    fontFamily: FONT_SANS, fontSize: 12, fontWeight: 500,
                    boxShadow: freqUnit === u ? '0 1px 2px rgba(31,35,28,0.08)' : 'none',
                  }}
                >{u}</button>
              ))}
            </div>
          </div>
        </Field>

        <Field label="Last completed" required hint="For backfilling on first setup">
          <input
            type="date"
            value={lastDate}
            onChange={e => setLastDate(e.target.value)}
            style={{
              height: 40, padding: '0 14px', borderRadius: 10,
              background: T.bg, border: `1px solid ${T.rule}`,
              fontFamily: FONT_SANS, fontSize: 14, color: T.ink, outline: 'none',
              width: '100%', boxSizing: 'border-box',
            }}
          />
        </Field>

        {/* auto-calc preview */}
        <div style={{
          background: T.sageDim, border: '1px solid rgba(92,122,96,0.18)',
          borderRadius: 12, padding: '12px 16px',
          display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
        }}>
          <Caps c={T.sageDeep} size={9}>Auto-calculated</Caps>
          <span style={{ fontFamily: FONT_SANS, fontSize: 13, color: T.ink }}>
            Next due:{' '}
            <span style={{ fontFamily: FONT_SERIF, fontSize: 18, fontStyle: 'italic', color: T.sageDeep, fontWeight: 400 }}>
              {nextDuePreview ? fmtDate(nextDuePreview) : '—'}
            </span>
          </span>
          {computedDaysUntil != null && (
            <span style={{ fontFamily: FONT_MONO, fontSize: 11, color: T.ink2 }}>
              · {relTime(computedDaysUntil)}
            </span>
          )}
        </div>

        <Field label="Notes" hint="Optional. Brand standard, what to check, anything that helps.">
          <TextArea
            value={notes}
            onChange={setNotes}
            placeholder="e.g. Press test button on each, replace 9V if chirping."
            rows={2}
          />
        </Field>
      </div>
    </Modal>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// DETAIL MODAL — view + complete with date choice
// ─────────────────────────────────────────────────────────────────────────
function DetailModal({
  t, open, onClose, onComplete, todayISO,
}: {
  t: PreventiveTask | null;
  open: boolean;
  onClose: () => void;
  onComplete: (id: string, completedISO: string, args: { photo: File | null }) => Promise<void>;
  todayISO: string;
}) {
  const [photo, setPhoto] = useState<File | null>(null);
  const [pickedDate, setPickedDate] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => { if (!open) { setPhoto(null); setPickedDate(''); setBusy(false); } }, [open]);

  if (!t) return null;

  const band = bandFor(t);
  const tone = bandTone[band];
  const due = nextDueDate(t);
  const days = daysBetween(new Date(), due);
  const todayLabel = fmtDate(new Date(todayISO));
  const pickedLabel = pickedDate ? fmtDate(new Date(pickedDate)) : null;

  const close = () => { setPhoto(null); setPickedDate(''); onClose(); };

  const doComplete = async (iso: string) => {
    setBusy(true);
    try {
      await onComplete(t.id, iso, { photo });
      setPhoto(null); setPickedDate('');
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={close}
      title={t.name}
      subtitle={`${t.area ? `${t.area} · ` : ''}${freqLabel(t.frequencyDays)}`}
      width={580}
      footer={<Btn variant="ghost" size="md" onClick={close}>Close</Btn>}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
        {/* status banner */}
        <div style={{
          background: tone.bg, border: `1px solid ${tone.bd}`, borderRadius: 12,
          padding: '12px 16px',
        }}>
          <Caps c={tone.color} size={9}>{tone.label}</Caps>
          <p style={{ fontFamily: FONT_SERIF, fontSize: 22, color: T.ink, margin: '4px 0 0', lineHeight: 1.3, fontWeight: 400, letterSpacing: '-0.01em' }}>
            Due <span style={{ fontStyle: 'italic' }}>{fmtDate(due)}</span>
            <span style={{ color: tone.color, fontSize: 14, marginLeft: 8 }}>· {relTime(days)}</span>
          </p>
        </div>

        {/* last completed */}
        <div style={{ padding: '0 0 14px', borderBottom: `1px solid ${T.ruleSoft}` }}>
          <Caps size={9}>Last completed</Caps>
          <p style={{ fontFamily: FONT_SANS, fontSize: 14, color: T.ink, margin: '4px 0 0', fontWeight: 500 }}>
            {t.lastCompletedAt ? fmtDate(t.lastCompletedAt) : 'Never'}
          </p>
          <p style={{ fontFamily: FONT_MONO, fontSize: 11, color: T.ink2, margin: '2px 0 0', letterSpacing: '0.04em' }}>
            {t.lastCompletedBy ? `by ${t.lastCompletedBy} · ` : ''}cadence {freqLabel(t.frequencyDays).toLowerCase()}
          </p>
        </div>

        {t.notes && (
          <div>
            <Caps size={9}>Notes</Caps>
            <p style={{ fontFamily: FONT_SANS, fontSize: 13, color: T.ink2, margin: '6px 0 0', lineHeight: 1.5, fontStyle: 'italic' }}>
              {t.notes}
            </p>
          </div>
        )}

        {/* previous completion photo (if any) */}
        {t.completionPhotoPath && (
          <div>
            <Caps size={9}>Last photo</Caps>
            <div style={{ marginTop: 8 }}>
              <StorageImage path={t.completionPhotoPath} height={140} alt="last completion photo" />
            </div>
          </div>
        )}

        {/* completion photo (new) */}
        <div>
          <Caps size={9}>Photo for this completion (optional)</Caps>
          <div style={{ marginTop: 8 }}>
            <PhotoSlot file={photo} onFileChange={setPhoto} label="Completion photo (optional)" height={100} />
          </div>
        </div>

        {/* TWO completion buttons */}
        <div style={{ padding: '18px 0 0', borderTop: `1px solid ${T.rule}` }}>
          <Caps>When was it done?</Caps>
          <p style={{ fontFamily: FONT_SANS, fontSize: 12, color: T.ink2, margin: '4px 0 14px', fontStyle: 'italic' }}>
            We&apos;ll bump the next-due by {freqLabel(t.frequencyDays).toLowerCase()} from whichever date you pick.
          </p>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            {/* Today */}
            <button
              onClick={() => doComplete(todayISO)}
              disabled={busy}
              style={{
                cursor: busy ? 'wait' : 'pointer', textAlign: 'left',
                background: T.ink, color: T.bg, border: 'none', borderRadius: 12,
                padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 4,
                opacity: busy ? 0.6 : 1,
              }}
            >
              <span style={{ fontFamily: FONT_MONO, fontSize: 10, color: 'rgba(255,255,255,0.65)', letterSpacing: '0.1em', textTransform: 'uppercase', fontWeight: 500 }}>
                Most common
              </span>
              <span style={{ fontFamily: FONT_SANS, fontSize: 14, fontWeight: 600 }}>
                ✓ Mark completed today
              </span>
              <span style={{ fontFamily: FONT_SERIF, fontSize: 13, color: 'rgba(255,255,255,0.75)', fontStyle: 'italic' }}>
                {todayLabel}
              </span>
            </button>

            {/* Pick a date */}
            <div style={{
              background: T.bg, border: `1px solid ${T.rule}`, borderRadius: 12,
              padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 6,
            }}>
              <span style={{ fontFamily: FONT_MONO, fontSize: 10, color: T.ink3, letterSpacing: '0.1em', textTransform: 'uppercase', fontWeight: 500 }}>
                Or a different date
              </span>
              <input
                type="date"
                value={pickedDate}
                max={todayISO}
                onChange={e => setPickedDate(e.target.value)}
                style={{
                  height: 36, padding: '0 12px', borderRadius: 8,
                  background: T.paper, border: `1px solid ${T.rule}`,
                  fontFamily: FONT_SANS, fontSize: 13, color: T.ink, outline: 'none',
                }}
              />
              <button
                onClick={() => pickedDate && doComplete(new Date(pickedDate).toISOString())}
                disabled={!pickedDate || busy}
                style={{
                  height: 32, padding: '0 12px', borderRadius: 8,
                  cursor: pickedDate && !busy ? 'pointer' : 'not-allowed',
                  background: pickedDate ? T.ink : 'transparent',
                  color: pickedDate ? T.bg : T.ink3,
                  border: `1px solid ${pickedDate ? T.ink : T.rule}`,
                  fontFamily: FONT_SANS, fontSize: 12, fontWeight: 600,
                  marginTop: 2,
                  opacity: busy ? 0.6 : 1,
                }}
              >
                {pickedLabel ? `✓ Mark completed on ${pickedLabel}` : 'Pick a date first'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </Modal>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// ROOT
// ─────────────────────────────────────────────────────────────────────────
export function PreventiveTab() {
  const { user } = useAuth();
  const { activePropertyId } = useProperty();
  const [tasks, setTasks] = useState<PreventiveTask[]>([]);
  const [addOpen, setAddOpen] = useState(false);
  const [detail, setDetail] = useState<PreventiveTask | null>(null);

  useEffect(() => {
    if (!user || !activePropertyId) return;
    const unsub = subscribeToPreventiveTasks(user.uid, activePropertyId, setTasks);
    return () => unsub();
  }, [user, activePropertyId]);

  // Keep the open Detail modal's data fresh as tasks update.
  const detailRow = useMemo(
    () => (detail ? tasks.find(t => t.id === detail.id) ?? detail : null),
    [detail, tasks],
  );

  const todayISO = new Date().toISOString().slice(0, 10);

  const sorted = useMemo(() => {
    return [...tasks].sort((a, b) => {
      const da = daysBetween(new Date(), nextDueDate(a));
      const db = daysBetween(new Date(), nextDueDate(b));
      return da - db;
    });
  }, [tasks]);

  const overdue = sorted.filter(t => bandFor(t) === 'overdue');
  const dueSoon = sorted.filter(t => bandFor(t) === 'due-soon');
  const fresh   = sorted.filter(t => bandFor(t) === 'fresh');

  const uploadPhoto = async (file: File): Promise<string | null> => {
    if (!activePropertyId) return null;
    const ext = file.name.split('.').pop()?.toLowerCase() || 'jpg';
    const path = `${activePropertyId}/pm-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.${ext}`;
    const { error } = await supabase.storage
      .from('maintenance-photos')
      .upload(path, file, { contentType: file.type || 'image/jpeg', upsert: false });
    if (error) {
      console.error('preventive photo upload failed', error);
      return null;
    }
    return path;
  };

  const handleAdd = async (args: {
    name: string;
    area: string;
    frequencyDays: number;
    lastCompletedISO: string;
    notes?: string;
  }) => {
    if (!user || !activePropertyId) return;
    await addPreventiveTask(user.uid, activePropertyId, {
      propertyId: activePropertyId,
      name: args.name,
      area: args.area,
      frequencyDays: args.frequencyDays,
      lastCompletedAt: new Date(args.lastCompletedISO),
      lastCompletedBy: user.displayName,
      notes: args.notes,
    });
  };

  const handleComplete = async (id: string, completedISO: string, args: { photo: File | null }) => {
    if (!user) return;
    let photoPath: string | undefined;
    if (args.photo) {
      const path = await uploadPhoto(args.photo);
      if (path) photoPath = path;
    }
    await completePreventiveTask(id, {
      completedISO,
      completedByName: user.displayName,
      photoPath,
    });
  };

  return (
    <div style={{
      padding: '24px 48px 48px', background: T.bg, color: T.ink,
      fontFamily: FONT_SANS, minHeight: 'calc(100dvh - 130px)',
    }}>
      {/* header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: 18, gap: 24, flexWrap: 'wrap' }}>
        <div>
          <Caps>Preventive maintenance</Caps>
          <h1 style={{ fontFamily: FONT_SERIF, fontSize: 36, color: T.ink, margin: '4px 0 0', letterSpacing: '-0.03em', lineHeight: 1.25, fontWeight: 400, whiteSpace: 'nowrap' }}>
            <span style={{ fontStyle: 'italic', color: overdue.length > 0 ? T.warm : T.ink }}>
              {overdue.length} overdue
            </span>
            <span style={{ color: T.ink3 }}>
              {' · '}{dueSoon.length} due soon · {fresh.length} fresh
            </span>
          </h1>
        </div>
        <Btn variant="primary" size="md" onClick={() => setAddOpen(true)}>＋ Add task</Btn>
      </div>

      {/* task list */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {sorted.length === 0 && (
          <div style={{
            background: T.paper, border: `1px solid ${T.rule}`, borderRadius: 18,
            padding: '48px 24px', textAlign: 'center',
          }}>
            <span style={{ fontFamily: FONT_SERIF, fontSize: 24, color: T.ink, fontStyle: 'italic' }}>
              No preventive tasks yet.
            </span>
            <p style={{ fontFamily: FONT_SANS, fontSize: 13, color: T.ink2, margin: '8px 0 18px' }}>
              Add inspections, filter swaps, fire-extinguisher checks — anything on a recurring schedule.
            </p>
            <Btn variant="primary" size="md" onClick={() => setAddOpen(true)}>＋ Add your first task</Btn>
          </div>
        )}
        {sorted.map(t => <PMRow key={t.id} t={t} onOpen={(tt) => setDetail(tt)} />)}
      </div>

      <AddModal open={addOpen} onClose={() => setAddOpen(false)} onAdd={handleAdd} />
      <DetailModal
        t={detailRow}
        open={!!detail}
        onClose={() => setDetail(null)}
        onComplete={handleComplete}
        todayISO={todayISO}
      />
    </div>
  );
}
