// Maintenance → Work Orders tab. Four-lane triage board (Claude Design
// handoff, Jun 2026): Low · Normal · Urgent · Professional. Submit → the card
// arrives with a glow; re-prioritise from the detail modal and it flies to its
// new lane; mark it done and it drops into the History popup.
//
// Wired to the real work_orders data layer (realtime subscription + the
// addWorkOrder / markWorkOrderDone / updateWorkOrder helpers). The "Professional"
// lane is backed by the needs_pro / pro_* columns (migration 0262).

'use client';

import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { useProperty } from '@/contexts/PropertyContext';
import { useLang } from '@/contexts/LanguageContext';
import { supabase } from '@/lib/supabase';
import {
  subscribeToWorkOrders, addWorkOrder, markWorkOrderDone, updateWorkOrder,
} from '@/lib/db';
import type { WorkOrder, WorkOrderPriority } from '@/types';
import {
  T, FONT_SANS, FONT_MONO,
  Caps, Pill, Btn, Avatar, Modal, Field, TextInput, TextArea, ChipChoose,
  StorageImage, PageHead, BoardColumn, MtEmptyCard,
  useBoardGate, BoardLoading, BoardLoadError,
  displayLoc, fmtDateShort, fmtSubmittedAt, fmtSubmittedAtCompact,
  prioColor, prioLabel,
  CX_SPRING, CX_CARD_SHADOW, CX_CARD_SHADOW_HOVER, CX_CARD_BORDER_HOVER,
} from './_mt-snow';
import { useToast, ToastHost } from '@/app/_components/ui/toast';
import { PatternChip } from '@/components/concourse/PatternChip';
import { roomNumberFromLocation } from '@/components/concourse/target-chip';
import { EquipmentPicker } from './EquipmentPicker';

// ── placement: the 4-way choice (3 priorities + "professional") ────────────
type Placement = WorkOrderPriority | 'professional';

function hasContractor(w: WorkOrder): boolean {
  return !!(w.proCompany || w.proTrade || w.proPhone);
}
function placementOf(w: WorkOrder): Placement {
  return w.needsPro || hasContractor(w) ? 'professional' : w.priority;
}

function roleLabel(role: string | undefined, es: boolean): string {
  if (role === 'admin') return 'General manager';
  return 'Staff';
}

// submitter_role is a free-text column. New rows persist the CANONICAL
// English label (so the stored value no longer depends on the submitter's
// language setting); this maps the known labels — including legacy
// Spanish-persisted rows — to the VIEWER's language. Unknown values pass
// through verbatim.
function displayRole(stored: string | undefined, es: boolean): string {
  if (!stored) return 'Staff';
  if (stored === 'General manager' || stored === 'Gerente general') return roleLabel('admin', es);
  if (stored === 'Staff' || stored === 'Personal') return roleLabel(undefined, es);
  return stored;
}

// Professional lane tone — Concourse "muted" slate (the outside-contractor
// lane is neutral, not a severity), replacing the old off-palette purple.
const PRO = '#5C625C';
const PRO_DIM = 'rgba(31,35,28,0.06)';

// Lane colors: the three priority colors + muted slate for the professional lane.
const LANE_COLOR: Record<Placement, string> = {
  low: prioColor.low, normal: prioColor.normal, urgent: prioColor.urgent, professional: PRO,
};

const reduceMotion = () =>
  typeof window !== 'undefined'
  && typeof window.matchMedia === 'function'
  && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// ── muted "pro" pill ───────────────────────────────────────────────────────
function ProPill({ w, es }: { w: WorkOrder; es: boolean }) {
  if (hasContractor(w)) {
    return (
      <span style={{
        display: 'inline-flex', alignItems: 'center', gap: 5, padding: '3px 9px', borderRadius: 999, height: 22,
        background: PRO_DIM, color: PRO,
        fontFamily: FONT_MONO, fontSize: 10, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', whiteSpace: 'nowrap',
      }}>☎ {w.proTrade || w.proCompany}</span>
    );
  }
  if (w.needsPro) {
    return (
      <span style={{
        display: 'inline-flex', alignItems: 'center', gap: 5, padding: '3px 9px', borderRadius: 999, height: 22,
        background: 'transparent', color: PRO, border: '1px dashed rgba(31,35,28,0.3)',
        fontFamily: FONT_MONO, fontSize: 10, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', whiteSpace: 'nowrap',
      }}>{'Needs a professional'}</span>
    );
  }
  return null;
}

// ── open card (with the "arrive & glow" entrance animation) ────────────────
function OpenCard({
  w, onOpen, isEnter, es,
}: {
  w: WorkOrder; onOpen: (w: WorkOrder) => void; isEnter: boolean; es: boolean;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const played = useRef(false);

  useEffect(() => {
    if (!isEnter || played.current || !ref.current || reduceMotion()) return;
    played.current = true;
    const card = ref.current;
    const accent = (w.needsPro || hasContractor(w)) ? PRO : prioColor[w.priority];
    card.animate(
      [{ transform: 'translateY(-10px)', opacity: 0 }, { transform: 'translateY(0)', opacity: 1 }],
      { duration: 380, easing: 'cubic-bezier(0.22,1,0.36,1)' },
    );
    card.animate(
      [
        { boxShadow: `0 0 0 0 ${accent}00` },
        { boxShadow: `0 0 0 4px ${accent}59`, offset: 0.5 },
        { boxShadow: '0 1px 2px rgba(31,35,28,0.05)' },
      ],
      { duration: 1100, delay: 160, easing: 'ease-out' },
    );
    const sweep = document.createElement('span');
    sweep.style.cssText = 'position:absolute;inset:0;pointer-events:none;background:linear-gradient(105deg, transparent 30%, rgba(255,255,255,0.85) 50%, transparent 70%);';
    card.appendChild(sweep);
    const s = sweep.animate(
      [{ transform: 'translateX(-120%)' }, { transform: 'translateX(120%)' }],
      { duration: 720, delay: 220, easing: 'ease-in-out' },
    );
    s.onfinish = () => sweep.remove();
  }, [isEnter, w.needsPro, w.priority, w]);

  const showPro = w.needsPro || hasContractor(w);

  return (
    <button
      ref={ref}
      data-wo-id={w.id}
      data-trace-anchor={`wo:${w.id}`}
      onClick={() => onOpen(w)}
      onMouseEnter={(e) => { e.currentTarget.style.borderColor = CX_CARD_BORDER_HOVER; e.currentTarget.style.transform = 'translateY(-5px)'; e.currentTarget.style.boxShadow = CX_CARD_SHADOW_HOVER; }}
      onMouseLeave={(e) => { e.currentTarget.style.borderColor = T.rule; e.currentTarget.style.transform = 'translateY(0)'; e.currentTarget.style.boxShadow = CX_CARD_SHADOW; }}
      style={{
        textAlign: 'left', cursor: 'pointer', background: '#FFFFFF', border: `1px solid ${T.rule}`,
        borderRadius: 14, padding: '14px 16px 13px 19px', display: 'flex', flexDirection: 'column', gap: 9,
        width: '100%', position: 'relative', overflow: 'hidden', boxShadow: CX_CARD_SHADOW,
        transition: `border-color .55s ${CX_SPRING}, transform .55s ${CX_SPRING}, box-shadow .55s ${CX_SPRING}`,
      }}
    >
      <span style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 4, background: prioColor[w.priority] }} />
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
        <span style={{ fontFamily: FONT_SANS, fontSize: 15.5, color: T.ink, letterSpacing: '-0.01em', lineHeight: 1.2, fontWeight: 600 }}>
          {displayLoc(w.location)}
        </span>
        <span style={{ fontFamily: FONT_MONO, fontSize: 10, color: T.ink3, letterSpacing: '0.06em', flexShrink: 0 }}>
          {w.id.slice(0, 8)}
        </span>
      </div>
      <span style={{ fontFamily: FONT_SANS, fontSize: 13, color: T.ink, fontWeight: 500, lineHeight: 1.42, display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
        {w.description}
      </span>
      {showPro && <div><ProPill w={w} es={es} /></div>}
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginTop: 1 }}>
        <Avatar name={w.submittedByName || '?'} size={20} />
        <span style={{ fontFamily: FONT_SANS, fontSize: 11.5, color: T.ink2, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {(w.submittedByName || '').split(' ')[0] || ('Someone')}
        </span>
        {w.submitterPhotoPath && <span style={{ fontFamily: FONT_MONO, fontSize: 9, color: T.ink3 }}>📷</span>}
        <span style={{ marginLeft: 'auto', fontFamily: FONT_MONO, fontSize: 10.5, color: T.ink3, whiteSpace: 'nowrap', flexShrink: 0 }}>
          {fmtSubmittedAtCompact(w.createdAt)}
        </span>
      </div>
    </button>
  );
}

// ── photo dropzone (holds a File, previews via object URL) ─────────────────
function DropPhoto({
  value, onChange, busy, es,
}: {
  value: File | null; onChange: (f: File | null) => void; busy?: boolean; es: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [drag, setDrag] = useState(false);
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!value) { setUrl(null); return; }
    const u = URL.createObjectURL(value);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [value]);

  const take = (file: File | null | undefined) => {
    if (!file || !file.type.startsWith('image/')) return;
    onChange(file);
  };

  if (value && url) {
    return (
      <div style={{ position: 'relative', borderRadius: 12, overflow: 'hidden', border: `1px solid ${T.rule}`, background: T.bg }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={url} alt="" style={{ display: 'block', width: '100%', height: 188, objectFit: 'cover' }} />
        <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, padding: '20px 12px 9px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, background: 'linear-gradient(to top, rgba(31,35,28,0.62), transparent)' }}>
          <span style={{ fontFamily: FONT_MONO, fontSize: 11, color: '#fff', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {busy ? ('Uploading…') : value.name}
          </span>
          <button type="button" onClick={() => onChange(null)} disabled={busy} style={{ flexShrink: 0, height: 28, padding: '0 12px', borderRadius: 999, cursor: busy ? 'wait' : 'pointer', background: 'rgba(255,255,255,0.92)', color: T.ink, border: 'none', fontFamily: FONT_SANS, fontSize: 12, fontWeight: 500 }}>
            {'Remove'}
          </button>
        </div>
      </div>
    );
  }
  return (
    <div
      onClick={() => inputRef.current?.click()}
      onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => { e.preventDefault(); setDrag(false); take(e.dataTransfer.files?.[0]); }}
      style={{ cursor: 'pointer', borderRadius: 12, border: `1.5px dashed ${drag ? T.sageDeep : 'rgba(31,35,28,0.18)'}`, background: drag ? T.sageDim : 'rgba(31,35,28,0.03)', padding: '22px 16px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 5, textAlign: 'center', transition: `background .3s ${CX_SPRING}, border-color .3s ${CX_SPRING}` }}
    >
      <svg width={26} height={26} viewBox="0 0 24 24" fill="none" stroke={drag ? T.sageDeep : T.ink3} strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="5" width="18" height="14" rx="2.5" /><circle cx="9" cy="11" r="2" /><path d="M3 17l5-4 4 3 3-2 6 5" /></svg>
      <span style={{ fontFamily: FONT_SANS, fontSize: 13.5, color: T.ink, fontWeight: 500 }}>{'Add a photo'}</span>
      <span style={{ fontFamily: FONT_SANS, fontSize: 12, color: T.ink3 }}>{'Snap it or drag an image here · optional'}</span>
      <input ref={inputRef} type="file" accept="image/*" capture="environment" onChange={(e) => { take(e.target.files?.[0]); if (e.target) e.target.value = ''; }} style={{ display: 'none' }} />
    </div>
  );
}

// ── priority / placement chip chooser ──────────────────────────────────────
function PlacementChips({ value, onChange, es }: { value: Placement; onChange: (v: Placement) => void; es: boolean }) {
  const opts: { value: Placement; label: string }[] = [
    { value: 'low',          label: 'Low' },
    { value: 'normal',       label: 'Normal' },
    { value: 'urgent',       label: 'Urgent' },
    { value: 'professional', label: 'Call in a professional' },
  ];
  return (
    <ChipChoose<Placement>
      options={opts}
      value={value}
      onChange={onChange}
      render={(opt) => opt.value === 'professional'
        ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>☎ {opt.label}</span>
        : <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            <span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: '50%', background: prioColor[opt.value as WorkOrderPriority] }} />
            {opt.label}
          </span>}
    />
  );
}

// ── submit modal ────────────────────────────────────────────────────────────
function SubmitModal({
  open, onClose, onSubmit,
}: {
  open: boolean;
  onClose: () => void;
  onSubmit: (args: {
    location: string; description: string; placement: Placement;
    photo: File | null; equipmentId: string | null; repairCost: number | null;
  }) => Promise<void>;
}) {
  const { user } = useAuth();
  const { activePropertyId } = useProperty();
  const { lang } = useLang();
  const es = false;
  const [loc, setLoc] = useState('');
  const [desc, setDesc] = useState('');
  const [placement, setPlacement] = useState<Placement>('normal');
  const [photo, setPhoto] = useState<File | null>(null);
  const [equipmentId, setEquipmentId] = useState<string | null>(null);
  const [repairCost, setRepairCost] = useState('');
  const [busy, setBusy] = useState(false);

  const reset = () => { setLoc(''); setDesc(''); setPlacement('normal'); setPhoto(null); setEquipmentId(null); setRepairCost(''); };
  const dirty = loc.trim() !== '' || desc.trim() !== '' || photo !== null || equipmentId !== null || repairCost.trim() !== '';
  // Guard the eaten-form path: Escape / a stray scrim click used to wipe the
  // half-typed order instantly. Confirm before discarding anything typed.
  const close = () => {
    if (dirty && !window.confirm('Discard this work order? What you typed will be lost.')) return;
    reset();
    onClose();
  };
  const canSubmit = loc.trim().length > 0 && desc.trim().length > 0 && !busy;

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    try {
      const rc = repairCost.trim() === '' ? null : Number(repairCost);
      await onSubmit({
        location: loc.trim(), description: desc.trim(), placement, photo,
        equipmentId, repairCost: rc != null && Number.isFinite(rc) ? rc : null,
      });
      reset();
      onClose();
    } catch {
      // Submit failed — the board already surfaced the error in a toast.
      // Keep the modal open with the form intact so nothing typed is lost.
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open} onClose={close}
      title={"What's broken?"}
      subtitle={'Anyone on the team can submit. It goes straight to the open list.'}
      width={580}
      footer={<>
        <Btn variant="ghost" onClick={close}>{'Cancel'}</Btn>
        <Btn variant="primary" disabled={!canSubmit} onClick={submit}>
          {busy ? ('Submitting…') : ('Submit work order')}
        </Btn>
      </>}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
        <Field label={'Location'} required hint={'Room number, common area, anything specific.'}>
          <TextInput value={loc} onChange={setLoc} placeholder={'e.g. "Room 312" or "Lobby"'} />
        </Field>
        <Field label={"What's wrong?"} required hint={"Plain words. The way you'd write it in the book."}>
          <TextArea value={desc} onChange={setDesc} placeholder={'e.g. AC blowing warm air. Filter looked dirty.'} rows={3} />
        </Field>
        <Field label={'Priority'} hint={'Pick a lane, or hand it to an outside professional.'}>
          <PlacementChips value={placement} onChange={setPlacement} es={es} />
        </Field>
        <Field label={'Equipment (optional)'} hint={'The asset this is about'}>
          {activePropertyId && <EquipmentPicker pid={activePropertyId} value={equipmentId} onChange={setEquipmentId} lang={lang} />}
        </Field>
        <Field label={'Repair cost ($, optional)'} hint={'If known (quote / vendor)'}>
          <TextInput value={repairCost} onChange={setRepairCost} type="number" min={0} step="0.01" placeholder="—" />
        </Field>
        <Field label={'Photo'} hint={"Helps the fixer know what they're walking into."}>
          <DropPhoto value={photo} onChange={setPhoto} es={es} />
        </Field>
        <div style={{ background: 'rgba(31,35,28,0.03)', border: `1px solid ${T.rule}`, borderRadius: 10, padding: '10px 14px', display: 'flex', alignItems: 'center', gap: 12 }}>
          <Avatar name={user?.displayName || 'You'} size={28} />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <span style={{ fontFamily: FONT_SANS, fontSize: 13, color: T.ink, fontWeight: 500 }}>
              {'Submitted by'} {user?.displayName || ('you')}
            </span>
            <Caps size={10} tracking="0.06em" c={T.ink3}>
              {roleLabel(user?.role, es)} · {'auto-filled · timestamp set on submit'}
            </Caps>
          </div>
        </div>
      </div>
    </Modal>
  );
}

// ── contractor panel (editable, shown when the order is in the pro lane) ────
function ContractorPanel({
  w, onSave, es,
}: {
  w: WorkOrder; onSave: (args: { trade: string; company: string; phone: string }) => Promise<void>; es: boolean;
}) {
  const [trade, setTrade] = useState(w.proTrade || '');
  const [company, setCompany] = useState(w.proCompany || '');
  const [phone, setPhone] = useState(w.proPhone || '');
  const [busy, setBusy] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  // Re-sync when switching to a different order while the modal is mounted.
  useEffect(() => { setTrade(w.proTrade || ''); setCompany(w.proCompany || ''); setPhone(w.proPhone || ''); setSavedAt(null); }, [w.id, w.proTrade, w.proCompany, w.proPhone]);

  const dirty = trade !== (w.proTrade || '') || company !== (w.proCompany || '') || phone !== (w.proPhone || '');
  const save = async () => {
    setBusy(true);
    try { await onSave({ trade: trade.trim(), company: company.trim(), phone: phone.trim() }); setSavedAt(Date.now()); }
    catch { /* save failed — the board surfaced a toast; keep the fields editable, no "Saved" mark */ }
    finally { setBusy(false); }
  };

  return (
    <div style={{ background: PRO_DIM, border: '1px solid rgba(31,35,28,0.14)', borderRadius: 12, padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
        <Caps size={10} c={PRO} weight={600}>☎ {'Professional'}{w.proTrade ? ` · ${w.proTrade}` : ''}</Caps>
        {w.proCalledAt && <Caps size={10} c={T.ink3}>{fmtSubmittedAt(w.proCalledAt)}</Caps>}
      </div>
      {!hasContractor(w) && (
        <span style={{ fontFamily: FONT_SANS, fontSize: 12.5, color: T.ink2 }}>
          {"This one's with an outside contractor. Note who you called."}
        </span>
      )}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <Field label={'Trade'}><TextInput value={trade} onChange={setTrade} placeholder={'e.g. Plumbing'} /></Field>
        <Field label={'Company'}><TextInput value={company} onChange={setCompany} placeholder={'e.g. Acme Plumbing'} /></Field>
      </div>
      <Field label={'Phone'}><TextInput value={phone} onChange={setPhone} type="tel" placeholder="(409) 555-0142" /></Field>
      <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 10 }}>
        {savedAt && !dirty && <Caps size={10} c={T.sageDeep}>{'Saved'}</Caps>}
        <Btn variant="sage" size="sm" disabled={busy || !dirty} onClick={save}>
          {busy ? ('Saving…') : ('Save contractor')}
        </Btn>
      </div>
    </div>
  );
}

// ── detail modal ────────────────────────────────────────────────────────────
function DetailModal({
  w, open, onClose, onDone, onSetPlacement, onAttachPhoto, onSaveContractor,
}: {
  w: WorkOrder | null;
  open: boolean;
  onClose: () => void;
  onDone: (id: string, note: string) => Promise<void>;
  onSetPlacement: (w: WorkOrder, v: Placement) => void;
  onAttachPhoto: (id: string, file: File) => Promise<void>;
  onSaveContractor: (id: string, args: { trade: string; company: string; phone: string }) => Promise<void>;
}) {
  const { lang } = useLang();
  const { activePropertyId } = useProperty();
  const es = false;
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [attaching, setAttaching] = useState(false);

  useEffect(() => { if (!open) { setNote(''); setBusy(false); setAttaching(false); } }, [open]);
  if (!w) return null;

  // The room this order is about, when it is about a room at all. A "Lobby" or
  // "Pool pump" order has no room and gets no chip — see roomNumberFromLocation.
  const roomNumber = roomNumberFromLocation(w.location);

  const placement = placementOf(w);
  const done = async () => {
    setBusy(true);
    try { await onDone(w.id, note.trim()); setNote(''); onClose(); }
    catch { /* failed — the board surfaced a toast; keep the modal open so the note isn't lost */ }
    finally { setBusy(false); }
  };
  const attach = async (file: File | null) => {
    if (!file) return;
    setAttaching(true);
    try { await onAttachPhoto(w.id, file); }
    catch { /* upload/save failed — the board surfaced a toast */ }
    finally { setAttaching(false); }
  };

  return (
    <Modal
      open={open} onClose={onClose}
      title={displayLoc(w.location)} subtitle={w.id.slice(0, 8)} width={580}
      footer={<>
        <Btn variant="ghost" onClick={onClose}>{'Close'}</Btn>
        <Btn variant="primary" disabled={busy} onClick={done}>{busy ? ('Saving…') : ('✓ Mark done')}</Btn>
      </>}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
        <Caps size={11} tracking="0.06em">{'Open · submitted'} {fmtSubmittedAt(w.createdAt)}</Caps>

        {/* On the THING, not the tab: this modal is one room's broken thing, so
            the signpost belongs here and nowhere on the board behind it. */}
        <PatternChip propertyId={activePropertyId} kind="room" value={roomNumber} lang={lang} />

        <Field label={'Priority'}>
          <PlacementChips value={placement} onChange={(v) => onSetPlacement(w, v)} es={es} />
        </Field>

        <div>
          <Caps>{"What's wrong"}</Caps>
          <p style={{ fontFamily: FONT_SANS, fontSize: 16, color: T.ink, margin: '8px 0 0', lineHeight: 1.5, fontWeight: 500 }}>{w.description}</p>
        </div>

        <Field label={'Photo'} hint={w.submitterPhotoPath ? undefined : ('Snap or drag one in. Optional.')}>
          {w.submitterPhotoPath
            ? <StorageImage path={w.submitterPhotoPath} alt="work order photo" />
            : <DropPhoto value={null} onChange={attach} busy={attaching} es={es} />}
        </Field>

        {placement === 'professional' && (
          <ContractorPanel w={w} es={es} onSave={(args) => onSaveContractor(w.id, args)} />
        )}

        <div style={{ background: 'rgba(31,35,28,0.03)', border: `1px solid ${T.rule}`, borderRadius: 10, padding: '10px 14px', display: 'flex', alignItems: 'center', gap: 12 }}>
          <Avatar name={w.submittedByName || '?'} size={28} />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <span style={{ fontFamily: FONT_SANS, fontSize: 13, color: T.ink, fontWeight: 500 }}>{w.submittedByName || ('Unknown')}</span>
            <Caps size={10} tracking="0.06em" c={T.ink3}>{displayRole(w.submitterRole, es)} · {fmtSubmittedAt(w.createdAt)}</Caps>
          </div>
        </div>

        <div style={{ padding: '18px 0 0', borderTop: `1px solid ${T.rule}` }}>
          <Caps>{"When you're done"}</Caps>
          <p style={{ fontFamily: FONT_SANS, fontSize: 12, color: T.ink2, margin: '4px 0 12px' }}>
            {'Optional. Future-you will thank present-you for the note.'}
          </p>
          <TextArea value={note} onChange={setNote} placeholder={'e.g. "Replaced filter, unit is old, will need full replacement soon"'} rows={2} />
        </div>
      </div>
    </Modal>
  );
}

// ── history popup ────────────────────────────────────────────────────────────
function HistoryModal({ open, onClose, done, es }: { open: boolean; onClose: () => void; done: WorkOrder[]; es: boolean }) {
  const cols = '120px 1fr 130px 96px 78px';
  return (
    <Modal
      open={open} onClose={onClose}
      title={'Work order history'}
      subtitle={`${done.length} resolved · everything closed out`}
      width={820}
      footer={<Btn variant="ghost" onClick={onClose}>{'Close'}</Btn>}
    >
      {done.length === 0 ? (
        <p style={{ fontFamily: FONT_SANS, fontSize: 14, color: T.ink3, margin: '8px 0', textAlign: 'center' }}>
          {'Nothing closed yet.'}
        </p>
      ) : (
        <div>
          <div style={{ display: 'grid', gridTemplateColumns: cols, gap: 14, padding: '0 0 12px', borderBottom: `1px solid ${T.rule}` }}>
            <Caps size={9}>{'Where'}</Caps>
            <Caps size={9}>{'What & note'}</Caps>
            <Caps size={9}>{'Fixed by'}</Caps>
            <Caps size={9}>{'Completed'}</Caps>
            <Caps size={9}>{'Status'}</Caps>
          </div>
          {done.slice().sort((a, b) => (b.completedAt?.getTime() ?? 0) - (a.completedAt?.getTime() ?? 0)).map((w) => (
            <div key={w.id} style={{ display: 'grid', gridTemplateColumns: cols, gap: 14, padding: '14px 0', borderBottom: `1px solid ${T.ruleSoft}`, alignItems: 'center' }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <span style={{ fontFamily: FONT_SANS, fontSize: 14, color: T.ink, letterSpacing: '-0.01em', lineHeight: 1.2, fontWeight: 600 }}>{displayLoc(w.location)}</span>
                <span style={{ fontFamily: FONT_MONO, fontSize: 10, color: T.ink3 }}>{w.id.slice(0, 8)}</span>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 }}>
                <span style={{ fontFamily: FONT_SANS, fontSize: 13, color: T.ink, fontWeight: 500 }}>{w.description}</span>
                {w.completionNote && <span style={{ fontFamily: FONT_SANS, fontSize: 12, color: T.ink2, fontStyle: 'italic' }}>“{w.completionNote}”</span>}
              </div>
              <span style={{ fontFamily: FONT_SANS, fontSize: 13, color: T.ink }}>{w.completedByName || '—'}</span>
              <span style={{ fontFamily: FONT_MONO, fontSize: 12, color: T.ink2 }}>{w.completedAt ? fmtDateShort(w.completedAt) : '—'}</span>
              <Pill tone="sage">✓ {'Done'}</Pill>
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}

// ── root ─────────────────────────────────────────────────────────────────────
export function WorkOrdersTab() {
  const { user } = useAuth();
  const { activePropertyId } = useProperty();
  const { lang } = useLang();
  const es = false;

  const [orders, setOrders] = useState<WorkOrder[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [submitOpen, setSubmitOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [enterId, setEnterId] = useState<string | null>(null);

  const boardRef = useRef<HTMLDivElement>(null);
  const flipRef = useRef<{ id: string; first: DOMRect } | null>(null);

  // Failure feedback for board writes (same replace-on-reshow ink pill as the
  // equipment registry).
  const { toasts, show: flash } = useToast({ durationMs: 3600, max: 1 });

  // Load gate: don't render the happy "All caught up" empty state until the
  // first snapshot actually arrived; show an error card with retry when the
  // initial load failed (see useBoardGate in _mt-snow).
  const gate = useBoardGate(activePropertyId, 'work_orders', loaded);

  useEffect(() => {
    if (!user || !activePropertyId) return;
    setLoaded(false);
    const unsub = subscribeToWorkOrders(user.uid, activePropertyId, (rows) => {
      setLoaded(true);
      setOrders(rows);
    });
    return () => unsub();
  }, [user, activePropertyId, gate.retryKey]);

  const open = useMemo(() => orders.filter((o) => o.status === 'open'), [orders]);
  const doneList = useMemo(() => orders.filter((o) => o.status === 'done'), [orders]);
  const detail = detailId ? orders.find((o) => o.id === detailId) ?? null : null;

  // Animation B — "lift · slide · drop": FLIP the moved card from its recorded
  // position to wherever it lands after the board re-renders. Because the move
  // round-trips through the DB, we keep the pending flip until the card has
  // actually shifted (dx/dy ≠ 0), then consume it.
  useLayoutEffect(() => {
    const f = flipRef.current;
    if (!f || !boardRef.current || reduceMotion()) return;
    const node = boardRef.current.querySelector<HTMLElement>(`[data-wo-id="${f.id}"]`);
    if (!node) return;
    const last = node.getBoundingClientRect();
    const dx = f.first.left - last.left, dy = f.first.top - last.top;
    if (!dx && !dy) return; // hasn't moved yet — wait for the realtime update
    flipRef.current = null;
    node.style.zIndex = '5';
    const a = node.animate([
      { transform: `translate(${dx}px, ${dy}px) scale(1)`, boxShadow: '0 1px 2px rgba(31,35,28,0.06)' },
      { transform: `translate(${dx}px, ${dy - 14}px) scale(1.05)`, boxShadow: '0 18px 32px rgba(31,35,28,0.20)', offset: 0.24 },
      { transform: 'translate(0px, -14px) scale(1.05)', boxShadow: '0 18px 32px rgba(31,35,28,0.20)', offset: 0.64 },
      { transform: 'translate(0,0) scale(1)', boxShadow: '0 1px 2px rgba(31,35,28,0.06)' },
    ], { duration: 880, easing: 'cubic-bezier(0.5,0,0.2,1)' });
    a.onfinish = () => { node.style.zIndex = ''; node.style.boxShadow = ''; };
  });

  const uploadPhoto = async (file: File): Promise<string | null> => {
    if (!activePropertyId) return null;
    const ext = file.name.split('.').pop()?.toLowerCase() || 'jpg';
    const path = `${activePropertyId}/${Date.now()}-submitter-${Math.random().toString(36).slice(2, 7)}.${ext}`;
    const { error } = await supabase.storage.from('maintenance-photos').upload(path, file, { contentType: file.type || 'image/jpeg', upsert: false });
    if (error) { console.error('photo upload failed', error); return null; }
    return path;
  };

  const handleSubmit = async (args: {
    location: string; description: string; placement: Placement;
    photo: File | null; equipmentId: string | null; repairCost: number | null;
  }) => {
    if (!user || !activePropertyId) return;
    let submitterPhotoPath: string | undefined;
    if (args.photo) {
      const p = await uploadPhoto(args.photo);
      if (!p) {
        // Don't silently create a photoless order — the fixer would walk in
        // blind. Surface it and keep the modal open (throw → modal stays).
        flash("Couldn't upload the photo. Try again or remove it.");
        throw new Error('photo upload failed');
      }
      submitterPhotoPath = p;
    }
    const isPro = args.placement === 'professional';
    let newId: string;
    try {
      newId = await addWorkOrder(user.uid, activePropertyId, {
        propertyId: activePropertyId,
        location: args.location,
        description: args.description,
        priority: args.placement === 'professional' ? 'normal' : args.placement,
        status: 'open',
        submittedByName: user.displayName,
        // Canonical English label — translated to the viewer's language at
        // display time (displayRole), never persisted pre-translated.
        submitterRole: roleLabel(user.role, false),
        submitterPhotoPath,
        equipmentId: args.equipmentId ?? null,
        repairCost: args.repairCost ?? null,
        needsPro: isPro,
      });
    } catch (err) {
      flash("Couldn't submit the work order. Check your connection and try again.");
      throw err;
    }
    // Trigger the "arrive & glow" once the new card mounts from the subscription.
    if (newId) {
      setEnterId(newId);
      window.setTimeout(() => setEnterId((cur) => (cur === newId ? null : cur)), 1600);
    }
  };

  const handleDone = async (id: string, note: string) => {
    if (!user) return;
    try {
      await markWorkOrderDone(id, {
        completedByName: user.displayName,
        completionNote: note || undefined,
      });
    } catch (err) {
      flash("Couldn't mark it done. Check your connection and try again.");
      throw err;
    }
    setDetailId(null);
  };

  const setPlacement = (w: WorkOrder, val: Placement) => {
    if (!user || !activePropertyId) return;
    if (placementOf(w) === val) return;
    // Leaving the Professional lane permanently erases the saved contractor
    // (trade / company / phone / called-at) — confirm before a one-tap loss.
    if (val !== 'professional' && hasContractor(w)) {
      const who = w.proCompany || w.proTrade || w.proPhone || '';
      const msg = `This removes the saved contractor${who ? ` (${who})` : ''} from this order. Move it anyway?`;
      if (!window.confirm(msg)) return;
    }
    // Record the FLIP start position before the board re-renders.
    const node = boardRef.current?.querySelector<HTMLElement>(`[data-wo-id="${w.id}"]`);
    if (node) {
      flipRef.current = { id: w.id, first: node.getBoundingClientRect() };
      window.setTimeout(() => { if (flipRef.current?.id === w.id) flipRef.current = null; }, 2000);
    }
    setDetailId(null);
    const patch = val === 'professional'
      ? { needsPro: true }
      : { priority: val, needsPro: false, proTrade: null, proCompany: null, proPhone: null, proCalledAt: null };
    updateWorkOrder(user.uid, activePropertyId, w.id, patch).catch(() => {
      // Fire-and-forget no more: the card won't move (realtime never fires on
      // a failed write), so tell the user why.
      flash("Couldn't move the work order. Check your connection and try again.");
    });
  };

  const attachPhoto = async (id: string, file: File) => {
    if (!user || !activePropertyId) return;
    const path = await uploadPhoto(file);
    if (!path) {
      flash("Couldn't upload the photo. Try again.");
      return;
    }
    try {
      await updateWorkOrder(user.uid, activePropertyId, id, { submitterPhotoPath: path });
    } catch {
      flash("Couldn't attach the photo. Try again.");
    }
  };

  const saveContractor = async (id: string, args: { trade: string; company: string; phone: string }) => {
    if (!user || !activePropertyId) return;
    try {
      await updateWorkOrder(user.uid, activePropertyId, id, {
        needsPro: true,
        proTrade: args.trade || null,
        proCompany: args.company || null,
        proPhone: args.phone || null,
        proCalledAt: new Date(),
      });
    } catch (err) {
      flash("Couldn't save the contractor. Check your connection and try again.");
      throw err;
    }
  };

  const laneItems = (p: Placement) => {
    if (p === 'professional') {
      return open.filter((o) => o.needsPro || hasContractor(o)).sort((a, b) => (a.createdAt?.getTime() ?? 0) - (b.createdAt?.getTime() ?? 0));
    }
    return open.filter((o) => o.priority === p && !o.needsPro && !hasContractor(o)).sort((a, b) => (a.createdAt?.getTime() ?? 0) - (b.createdAt?.getTime() ?? 0));
  };

  const lanes: { key: Placement; label: string }[] = [
    { key: 'low',          label: prioLabel.low },
    { key: 'normal',       label: prioLabel.normal },
    { key: 'urgent',       label: prioLabel.urgent },
    { key: 'professional', label: 'Professional' },
  ];

  return (
    <div className="mt-workorders-page" style={{ background: 'transparent', color: T.ink, fontFamily: FONT_SANS, minHeight: 'calc(100dvh - 130px)' }}>
      <style>{`
        .mt-workorders-page { padding: 28px 48px 130px; }
        .mt-workorders-board {
          display: grid;
          grid-template-columns: repeat(4, minmax(0, 1fr));
          gap: 20px;
          align-items: start;
        }
        @media (max-width: 980px) {
          .mt-workorders-page { padding-inline: 24px; }
          .mt-workorders-board { grid-template-columns: repeat(2, minmax(0, 1fr)); }
        }
        @media (max-width: 560px) {
          .mt-workorders-page { padding: 20px 16px 130px; }
          .mt-workorders-board { grid-template-columns: minmax(0, 1fr); gap: 16px; }
        }
      `}</style>
      <PageHead
        eyebrow={'Work orders · today'}
        lead={`${open.length} ${'open'}`}
        rest={`${doneList.length} ${'done'}`}
        actions={<>
          <Btn size="lg" variant="ghost" onClick={() => setHistoryOpen(true)}>{'History'} ({doneList.length}) →</Btn>
          <Btn size="lg" variant="primary" onClick={() => setSubmitOpen(true)}>＋ {'New work order'}</Btn>
        </>}
      />

      {gate.status === 'error' ? (
        <BoardLoadError es={es} onRetry={gate.retry} />
      ) : gate.status === 'loading' ? (
        <BoardLoading es={es} />
      ) : open.length === 0 ? (
        <MtEmptyCard
          title={'All caught up.'}
          body={'Nothing open. Nice work.'}
          action={<Btn size="lg" variant="primary" onClick={() => setSubmitOpen(true)}>＋ {'New work order'}</Btn>}
        />
      ) : (
        <div ref={boardRef} className="mt-workorders-board">
          {lanes.map((l) => {
            const items = laneItems(l.key);
            return (
              <BoardColumn key={l.key} color={LANE_COLOR[l.key]} label={l.label} count={items.length} empty={'Nothing here.'}>
                {items.map((w) => <OpenCard key={w.id} w={w} onOpen={(x) => setDetailId(x.id)} isEnter={w.id === enterId} es={es} />)}
              </BoardColumn>
            );
          })}
        </div>
      )}

      <SubmitModal open={submitOpen} onClose={() => setSubmitOpen(false)} onSubmit={handleSubmit} />
      <DetailModal
        w={detail}
        open={!!detail}
        onClose={() => setDetailId(null)}
        onDone={handleDone}
        onSetPlacement={setPlacement}
        onAttachPhoto={attachPhoto}
        onSaveContractor={saveContractor}
      />
      <HistoryModal open={historyOpen} onClose={() => setHistoryOpen(false)} done={doneList} es={es} />

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
