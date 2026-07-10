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
  T, FONT_SANS, FONT_MONO, FONT_SERIF,
  Caps, Pill, Btn, Avatar, Modal, Field, TextInput, TextArea, ChipChoose,
  StorageImage, PageHead, BoardColumn, MtEmptyCard,
  useBoardGate, BoardLoading, BoardLoadError,
  displayLoc, fmtDateShort, fmtSubmittedAt, fmtSubmittedAtCompact,
  prioColor, prioLabel,
} from './_mt-snow';
import { useToast, ToastHost } from '@/app/_components/ui/toast';
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
  if (role === 'admin') return es ? 'Gerente general' : 'General manager';
  return es ? 'Personal' : 'Staff';
}

// submitter_role is a free-text column. New rows persist the CANONICAL
// English label (so the stored value no longer depends on the submitter's
// language setting); this maps the known labels — including legacy
// Spanish-persisted rows — to the VIEWER's language. Unknown values pass
// through verbatim.
function displayRole(stored: string | undefined, es: boolean): string {
  if (!stored) return es ? 'Personal' : 'Staff';
  if (stored === 'General manager' || stored === 'Gerente general') return roleLabel('admin', es);
  if (stored === 'Staff' || stored === 'Personal') return roleLabel(undefined, es);
  return stored;
}

// Lane colors: the three priority colors + purple for the professional lane.
const LANE_COLOR: Record<Placement, string> = {
  low: prioColor.low, normal: prioColor.normal, urgent: prioColor.urgent, professional: T.purple,
};

const reduceMotion = () =>
  typeof window !== 'undefined'
  && typeof window.matchMedia === 'function'
  && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// ── purple "pro" pill ──────────────────────────────────────────────────────
function ProPill({ w, es }: { w: WorkOrder; es: boolean }) {
  if (hasContractor(w)) {
    return (
      <span style={{
        display: 'inline-flex', alignItems: 'center', gap: 5, padding: '3px 9px', borderRadius: 999, height: 22,
        background: T.purpleDim, color: T.purple, border: '1px solid rgba(123,106,151,0.3)',
        fontFamily: FONT_SANS, fontSize: 11, fontWeight: 600, whiteSpace: 'nowrap',
      }}>☎ {w.proTrade || w.proCompany}</span>
    );
  }
  if (w.needsPro) {
    return (
      <span style={{
        display: 'inline-flex', alignItems: 'center', gap: 5, padding: '3px 9px', borderRadius: 999, height: 22,
        background: 'transparent', color: T.purple, border: '1px dashed rgba(123,106,151,0.5)',
        fontFamily: FONT_SANS, fontSize: 11, fontWeight: 600, whiteSpace: 'nowrap',
      }}>{es ? 'Necesita un profesional' : 'Needs a professional'}</span>
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
    const accent = (w.needsPro || hasContractor(w)) ? T.purple : prioColor[w.priority];
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
      onClick={() => onOpen(w)}
      onMouseEnter={(e) => { e.currentTarget.style.borderColor = 'rgba(31,35,28,0.18)'; e.currentTarget.style.transform = 'translateY(-1px)'; }}
      onMouseLeave={(e) => { e.currentTarget.style.borderColor = T.rule; e.currentTarget.style.transform = 'translateY(0)'; }}
      style={{
        textAlign: 'left', cursor: 'pointer', background: T.paper, border: `1px solid ${T.rule}`,
        borderRadius: 14, padding: '14px 16px 13px 19px', display: 'flex', flexDirection: 'column', gap: 9,
        width: '100%', position: 'relative', overflow: 'hidden', transition: 'border-color 0.14s, transform 0.14s',
      }}
    >
      <span style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 4, background: prioColor[w.priority] }} />
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
        <span style={{ fontFamily: FONT_SERIF, fontSize: 22, color: T.ink, fontStyle: 'italic', letterSpacing: '-0.02em', lineHeight: 1.15, fontWeight: 400 }}>
          {displayLoc(w.location, es)}
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
          {(w.submittedByName || '').split(' ')[0] || (es ? 'Alguien' : 'Someone')}
        </span>
        {w.submitterPhotoPath && <span style={{ fontFamily: FONT_MONO, fontSize: 9, color: T.ink3 }}>📷</span>}
        <span style={{ marginLeft: 'auto', fontFamily: FONT_MONO, fontSize: 10.5, color: T.ink3, whiteSpace: 'nowrap', flexShrink: 0 }}>
          {fmtSubmittedAtCompact(w.createdAt, es)}
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
            {busy ? (es ? 'Subiendo…' : 'Uploading…') : value.name}
          </span>
          <button type="button" onClick={() => onChange(null)} disabled={busy} style={{ flexShrink: 0, height: 28, padding: '0 12px', borderRadius: 999, cursor: busy ? 'wait' : 'pointer', background: 'rgba(255,255,255,0.92)', color: T.ink, border: 'none', fontFamily: FONT_SANS, fontSize: 12, fontWeight: 500 }}>
            {es ? 'Quitar' : 'Remove'}
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
      style={{ cursor: 'pointer', borderRadius: 12, border: `1.5px dashed ${drag ? T.sageDeep : 'rgba(31,35,28,0.18)'}`, background: drag ? T.sageDim : T.bg, padding: '22px 16px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 5, textAlign: 'center', transition: 'background 0.14s, border-color 0.14s' }}
    >
      <svg width={26} height={26} viewBox="0 0 24 24" fill="none" stroke={drag ? T.sageDeep : T.ink3} strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="5" width="18" height="14" rx="2.5" /><circle cx="9" cy="11" r="2" /><path d="M3 17l5-4 4 3 3-2 6 5" /></svg>
      <span style={{ fontFamily: FONT_SANS, fontSize: 13.5, color: T.ink, fontWeight: 500 }}>{es ? 'Agregar foto' : 'Add a photo'}</span>
      <span style={{ fontFamily: FONT_SANS, fontSize: 12, color: T.ink3 }}>{es ? 'Tómala o arrastra una imagen · opcional' : 'Snap it or drag an image here · optional'}</span>
      <input ref={inputRef} type="file" accept="image/*" capture="environment" onChange={(e) => { take(e.target.files?.[0]); if (e.target) e.target.value = ''; }} style={{ display: 'none' }} />
    </div>
  );
}

// ── priority / placement chip chooser ──────────────────────────────────────
function PlacementChips({ value, onChange, es }: { value: Placement; onChange: (v: Placement) => void; es: boolean }) {
  const opts: { value: Placement; label: string }[] = [
    { value: 'low',          label: es ? 'Baja'    : 'Low' },
    { value: 'normal',       label: es ? 'Normal'  : 'Normal' },
    { value: 'urgent',       label: es ? 'Urgente' : 'Urgent' },
    { value: 'professional', label: es ? 'Llamar a un profesional' : 'Call in a professional' },
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
  const es = lang === 'es';
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
    if (dirty && !window.confirm(es
      ? '¿Descartar esta orden sin enviar? Se perderá lo que escribiste.'
      : 'Discard this work order? What you typed will be lost.')) return;
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
      title={es ? '¿Qué se dañó?' : "What's broken?"}
      subtitle={es ? 'Cualquiera del equipo puede enviarla. Va directo a la lista de abiertas.' : 'Anyone on the team can submit. It goes straight to the open list.'}
      width={580}
      footer={<>
        <Btn variant="ghost" onClick={close}>{es ? 'Cancelar' : 'Cancel'}</Btn>
        <Btn variant="primary" disabled={!canSubmit} onClick={submit}>
          {busy ? (es ? 'Enviando…' : 'Submitting…') : (es ? 'Enviar orden' : 'Submit work order')}
        </Btn>
      </>}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
        <Field label={es ? 'Ubicación' : 'Location'} required hint={es ? 'Número de habitación, área común, algo específico.' : 'Room number, common area, anything specific.'}>
          <TextInput value={loc} onChange={setLoc} placeholder={es ? 'ej. "Habitación 312" o "Lobby"' : 'e.g. "Room 312" or "Lobby"'} />
        </Field>
        <Field label={es ? '¿Qué pasa?' : "What's wrong?"} required hint={es ? 'En tus palabras. Como lo anotarías en el cuaderno.' : "Plain words. The way you'd write it in the book."}>
          <TextArea value={desc} onChange={setDesc} placeholder={es ? 'ej. El aire sopla caliente. El filtro se veía sucio.' : 'e.g. AC blowing warm air. Filter looked dirty.'} rows={3} />
        </Field>
        <Field label={es ? 'Prioridad' : 'Priority'} hint={es ? 'Elige un carril — o pásala a un profesional externo.' : 'Pick a lane — or hand it to an outside professional.'}>
          <PlacementChips value={placement} onChange={setPlacement} es={es} />
        </Field>
        <Field label={es ? 'Equipo (opcional)' : 'Equipment (optional)'} hint={es ? 'El activo afectado' : 'The asset this is about'}>
          {activePropertyId && <EquipmentPicker pid={activePropertyId} value={equipmentId} onChange={setEquipmentId} lang={lang} />}
        </Field>
        <Field label={es ? 'Costo de reparación ($, opcional)' : 'Repair cost ($, optional)'} hint={es ? 'Si se conoce (cotización/proveedor)' : 'If known (quote / vendor)'}>
          <TextInput value={repairCost} onChange={setRepairCost} type="number" min={0} step="0.01" placeholder="—" />
        </Field>
        <Field label={es ? 'Foto' : 'Photo'} hint={es ? 'Ayuda a quien lo arregla a saber qué encontrará.' : "Helps the fixer know what they're walking into."}>
          <DropPhoto value={photo} onChange={setPhoto} es={es} />
        </Field>
        <div style={{ background: T.bg, border: `1px solid ${T.rule}`, borderRadius: 10, padding: '10px 14px', display: 'flex', alignItems: 'center', gap: 12 }}>
          <Avatar name={user?.displayName || 'You'} size={28} />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <span style={{ fontFamily: FONT_SANS, fontSize: 13, color: T.ink, fontWeight: 500 }}>
              {es ? 'Enviado por' : 'Submitted by'} {user?.displayName || (es ? 'ti' : 'you')}
            </span>
            <Caps size={10} tracking="0.06em" c={T.ink3}>
              {roleLabel(user?.role, es)} · {es ? 'autocompletado · hora al enviar' : 'auto-filled · timestamp set on submit'}
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
    <div style={{ background: T.purpleDim, border: '1px solid rgba(123,106,151,0.28)', borderRadius: 12, padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
        <Caps size={10} c={T.purple} weight={600}>☎ {es ? 'Profesional' : 'Professional'}{w.proTrade ? ` · ${w.proTrade}` : ''}</Caps>
        {w.proCalledAt && <Caps size={10} c={T.ink3}>{fmtSubmittedAt(w.proCalledAt, es)}</Caps>}
      </div>
      {!hasContractor(w) && (
        <span style={{ fontFamily: FONT_SANS, fontSize: 12.5, color: T.ink2 }}>
          {es ? 'Esta es para un contratista externo. Anota a quién llamaste.' : "This one's with an outside contractor. Note who you called."}
        </span>
      )}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <Field label={es ? 'Oficio' : 'Trade'}><TextInput value={trade} onChange={setTrade} placeholder={es ? 'ej. Plomería' : 'e.g. Plumbing'} /></Field>
        <Field label={es ? 'Empresa' : 'Company'}><TextInput value={company} onChange={setCompany} placeholder={es ? 'ej. Plomería Acme' : 'e.g. Acme Plumbing'} /></Field>
      </div>
      <Field label={es ? 'Teléfono' : 'Phone'}><TextInput value={phone} onChange={setPhone} type="tel" placeholder="(409) 555-0142" /></Field>
      <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 10 }}>
        {savedAt && !dirty && <Caps size={10} c={T.sageDeep}>{es ? 'Guardado' : 'Saved'}</Caps>}
        <Btn variant="sage" size="sm" disabled={busy || !dirty} onClick={save}>
          {busy ? (es ? 'Guardando…' : 'Saving…') : (es ? 'Guardar contratista' : 'Save contractor')}
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
  const es = lang === 'es';
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [attaching, setAttaching] = useState(false);

  useEffect(() => { if (!open) { setNote(''); setBusy(false); setAttaching(false); } }, [open]);
  if (!w) return null;

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
      title={displayLoc(w.location, es)} subtitle={w.id.slice(0, 8)} width={580}
      footer={<>
        <Btn variant="ghost" onClick={onClose}>{es ? 'Cerrar' : 'Close'}</Btn>
        <Btn variant="primary" disabled={busy} onClick={done}>{busy ? (es ? 'Guardando…' : 'Saving…') : (es ? '✓ Marcar lista' : '✓ Mark done')}</Btn>
      </>}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
        <Caps size={11} tracking="0.06em">{es ? 'Abierta · enviada' : 'Open · submitted'} {fmtSubmittedAt(w.createdAt, es)}</Caps>

        <Field label={es ? 'Prioridad' : 'Priority'}>
          <PlacementChips value={placement} onChange={(v) => onSetPlacement(w, v)} es={es} />
        </Field>

        <div>
          <Caps>{es ? '¿Qué pasa?' : "What's wrong"}</Caps>
          <p style={{ fontFamily: FONT_SERIF, fontSize: 22, color: T.ink, margin: '8px 0 0', lineHeight: 1.35, fontWeight: 400 }}>{w.description}</p>
        </div>

        <Field label={es ? 'Foto' : 'Photo'} hint={w.submitterPhotoPath ? undefined : (es ? 'Tómala o arrastra una — opcional.' : 'Snap or drag one in — optional.')}>
          {w.submitterPhotoPath
            ? <StorageImage path={w.submitterPhotoPath} alt="work order photo" />
            : <DropPhoto value={null} onChange={attach} busy={attaching} es={es} />}
        </Field>

        {placement === 'professional' && (
          <ContractorPanel w={w} es={es} onSave={(args) => onSaveContractor(w.id, args)} />
        )}

        <div style={{ background: T.bg, border: `1px solid ${T.rule}`, borderRadius: 10, padding: '10px 14px', display: 'flex', alignItems: 'center', gap: 12 }}>
          <Avatar name={w.submittedByName || '?'} size={28} />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <span style={{ fontFamily: FONT_SANS, fontSize: 13, color: T.ink, fontWeight: 500 }}>{w.submittedByName || (es ? 'Desconocido' : 'Unknown')}</span>
            <Caps size={10} tracking="0.06em" c={T.ink3}>{displayRole(w.submitterRole, es)} · {fmtSubmittedAt(w.createdAt, es)}</Caps>
          </div>
        </div>

        <div style={{ padding: '18px 0 0', borderTop: `1px solid ${T.rule}` }}>
          <Caps>{es ? 'Cuando termines' : "When you're done"}</Caps>
          <p style={{ fontFamily: FONT_SANS, fontSize: 12, color: T.ink2, margin: '4px 0 12px', fontStyle: 'italic' }}>
            {es ? 'Opcional. El tú del futuro agradecerá la nota.' : 'Optional. Future-you will thank present-you for the note.'}
          </p>
          <TextArea value={note} onChange={setNote} placeholder={es ? 'ej. "Cambié el filtro, la unidad es vieja, pronto necesitará reemplazo"' : 'e.g. "Replaced filter, unit is old, will need full replacement soon"'} rows={2} />
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
      title={es ? 'Historial de órdenes' : 'Work order history'}
      subtitle={es ? `${done.length} resueltas · todo cerrado` : `${done.length} resolved · everything closed out`}
      width={820}
      footer={<Btn variant="ghost" onClick={onClose}>{es ? 'Cerrar' : 'Close'}</Btn>}
    >
      {done.length === 0 ? (
        <p style={{ fontFamily: FONT_SERIF, fontSize: 20, color: T.ink3, fontStyle: 'italic', margin: '8px 0', textAlign: 'center' }}>
          {es ? 'Nada cerrado aún.' : 'Nothing closed yet.'}
        </p>
      ) : (
        <div>
          <div style={{ display: 'grid', gridTemplateColumns: cols, gap: 14, padding: '0 0 12px', borderBottom: `1px solid ${T.rule}` }}>
            <Caps size={9}>{es ? 'Dónde' : 'Where'}</Caps>
            <Caps size={9}>{es ? 'Qué y nota' : 'What & note'}</Caps>
            <Caps size={9}>{es ? 'Resuelta por' : 'Fixed by'}</Caps>
            <Caps size={9}>{es ? 'Completada' : 'Completed'}</Caps>
            <Caps size={9}>{es ? 'Estado' : 'Status'}</Caps>
          </div>
          {done.slice().sort((a, b) => (b.completedAt?.getTime() ?? 0) - (a.completedAt?.getTime() ?? 0)).map((w) => (
            <div key={w.id} style={{ display: 'grid', gridTemplateColumns: cols, gap: 14, padding: '14px 0', borderBottom: `1px solid ${T.ruleSoft}`, alignItems: 'center' }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <span style={{ fontFamily: FONT_SERIF, fontSize: 18, color: T.ink, fontStyle: 'italic', letterSpacing: '-0.02em', lineHeight: 1.1, fontWeight: 400 }}>{displayLoc(w.location, es)}</span>
                <span style={{ fontFamily: FONT_MONO, fontSize: 10, color: T.ink3 }}>{w.id.slice(0, 8)}</span>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 }}>
                <span style={{ fontFamily: FONT_SANS, fontSize: 13, color: T.ink, fontWeight: 500 }}>{w.description}</span>
                {w.completionNote && <span style={{ fontFamily: FONT_SANS, fontSize: 12, color: T.ink2, fontStyle: 'italic' }}>“{w.completionNote}”</span>}
              </div>
              <span style={{ fontFamily: FONT_SANS, fontSize: 13, color: T.ink }}>{w.completedByName || '—'}</span>
              <span style={{ fontFamily: FONT_MONO, fontSize: 12, color: T.ink2 }}>{w.completedAt ? fmtDateShort(w.completedAt, es) : '—'}</span>
              <Pill tone="sage">✓ {es ? 'Lista' : 'Done'}</Pill>
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
  const es = lang === 'es';

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
        flash(es ? 'No se pudo subir la foto — inténtalo de nuevo o quítala.' : "Couldn't upload the photo — try again or remove it.");
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
      flash(es ? 'No se pudo enviar la orden — revisa la conexión e inténtalo de nuevo.' : "Couldn't submit the work order — check your connection and try again.");
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
      flash(es ? 'No se pudo marcar como lista — revisa la conexión e inténtalo de nuevo.' : "Couldn't mark it done — check your connection and try again.");
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
      const msg = es
        ? `Esto quita el contratista guardado${who ? ` (${who})` : ''} de esta orden. ¿Mover de todos modos?`
        : `This removes the saved contractor${who ? ` (${who})` : ''} from this order. Move it anyway?`;
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
      flash(es ? 'No se pudo mover la orden — revisa la conexión e inténtalo de nuevo.' : "Couldn't move the work order — check your connection and try again.");
    });
  };

  const attachPhoto = async (id: string, file: File) => {
    if (!user || !activePropertyId) return;
    const path = await uploadPhoto(file);
    if (!path) {
      flash(es ? 'No se pudo subir la foto — inténtalo de nuevo.' : "Couldn't upload the photo — try again.");
      return;
    }
    try {
      await updateWorkOrder(user.uid, activePropertyId, id, { submitterPhotoPath: path });
    } catch {
      flash(es ? 'No se pudo adjuntar la foto — inténtalo de nuevo.' : "Couldn't attach the photo — try again.");
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
      flash(es ? 'No se pudo guardar el contratista — revisa la conexión e inténtalo de nuevo.' : "Couldn't save the contractor — check your connection and try again.");
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
    { key: 'low',          label: es ? 'Baja'         : prioLabel.low },
    { key: 'normal',       label: es ? 'Normal'       : prioLabel.normal },
    { key: 'urgent',       label: es ? 'Urgente'      : prioLabel.urgent },
    { key: 'professional', label: es ? 'Profesional'  : 'Professional' },
  ];

  return (
    <div style={{ padding: '28px 48px 64px', background: T.bg, color: T.ink, fontFamily: FONT_SANS, minHeight: 'calc(100dvh - 130px)' }}>
      <PageHead
        eyebrow={es ? 'Órdenes de trabajo · hoy' : 'Work orders · today'}
        lead={`${open.length} ${es ? 'abiertas' : 'open'}`}
        rest={`${doneList.length} ${es ? 'listas' : 'done'}`}
        actions={<>
          <Btn variant="ghost" onClick={() => setHistoryOpen(true)}>{es ? 'Historial' : 'History'} ({doneList.length}) →</Btn>
          <Btn variant="primary" onClick={() => setSubmitOpen(true)}>＋ {es ? 'Nueva orden' : 'New work order'}</Btn>
        </>}
      />

      {gate.status === 'error' ? (
        <BoardLoadError es={es} onRetry={gate.retry} />
      ) : gate.status === 'loading' ? (
        <BoardLoading es={es} />
      ) : open.length === 0 ? (
        <MtEmptyCard
          titleSize={28}
          title={es ? 'Todo al día.' : 'All caught up.'}
          body={es ? 'Nada abierto. Buen trabajo.' : 'Nothing open. Nice work.'}
          action={<Btn variant="primary" onClick={() => setSubmitOpen(true)}>＋ {es ? 'Nueva orden' : 'New work order'}</Btn>}
        />
      ) : (
        <div ref={boardRef} style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 20, alignItems: 'start' }}>
          {lanes.map((l) => {
            const items = laneItems(l.key);
            return (
              <BoardColumn key={l.key} color={LANE_COLOR[l.key]} label={l.label} count={items.length} empty={es ? 'Nada aquí.' : 'Nothing here.'}>
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
