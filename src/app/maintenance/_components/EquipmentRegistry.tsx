'use client';

// Equipment (asset) registry — opens from a button at the top of the Preventive
// tab (NOT a 4th sub-tab). In-tab view toggle: PreventiveTab renders this
// instead of the PM list while open; the "← Back" button restores the PM list.
//
// Reads + writes go through /api/maintenance/equipment/* (service-role; the
// equipment table is deny-all RLS). Create / edit / delete are management-gated
// both server-side (isManager) and here (canManageTeam hides the controls).

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { useProperty } from '@/contexts/PropertyContext';
import { useLang } from '@/contexts/LanguageContext';
import { canManageTeam } from '@/lib/roles';
import { tr } from '@/lib/i18n-utils';
import { useToast, ToastHost } from '@/app/_components/ui/toast';
import {
  fetchEquipmentList, fetchEquipmentDetail,
  createEquipmentAsset, updateEquipmentAsset, deleteEquipmentAsset,
} from '@/lib/db';
import {
  EQUIPMENT_CATEGORIES, EQUIPMENT_STATUSES,
  type Equipment, type EquipmentCategory, type EquipmentStatus,
  type EquipmentDetail, type EquipmentInput,
} from '@/lib/equipment/types';
import { Btn, Caps } from '@/app/housekeeping/_components/_snow';
import {
  T, FONT_SANS, FONT_MONO, FONT_SERIF,
  Modal, Field, TextInput, TextArea, MtEmptyCard, daysBetween,
} from './_mt-snow';

const CATEGORY_LABEL: Record<EquipmentCategory, { en: string; es: string }> = {
  hvac:       { en: 'HVAC',        es: 'HVAC' },
  plumbing:   { en: 'Plumbing',    es: 'Plomería' },
  electrical: { en: 'Electrical',  es: 'Eléctrico' },
  appliance:  { en: 'Appliance',   es: 'Electrodoméstico' },
  structural: { en: 'Structural',  es: 'Estructural' },
  elevator:   { en: 'Elevator',    es: 'Ascensor' },
  pool:       { en: 'Pool',        es: 'Piscina' },
  laundry:    { en: 'Laundry',     es: 'Lavandería' },
  kitchen:    { en: 'Kitchen',     es: 'Cocina' },
  other:      { en: 'Other',       es: 'Otro' },
};
const STATUS_LABEL: Record<EquipmentStatus, { en: string; es: string }> = {
  operational:    { en: 'Operational',    es: 'Operativo' },
  degraded:       { en: 'Degraded',       es: 'Degradado' },
  failed:         { en: 'Failed',         es: 'Averiado' },
  replaced:       { en: 'Replaced',       es: 'Reemplazado' },
  decommissioned: { en: 'Decommissioned', es: 'Retirado' },
};
const STATUS_TONE: Record<EquipmentStatus, string> = {
  operational: T.sageDeep,
  degraded: T.caramel,
  failed: T.warm,
  replaced: T.ink2,
  decommissioned: T.ink3,
};

const catLabel = (c: EquipmentCategory, lang: string) => tr(lang, CATEGORY_LABEL[c].en, CATEGORY_LABEL[c].es);
const statusLabel = (s: EquipmentStatus, lang: string) => tr(lang, STATUS_LABEL[s].en, STATUS_LABEL[s].es);

function fmtMoney(n: number | null, lang: string): string {
  if (n == null) return tr(lang, '—', '—');
  return '$' + n.toLocaleString('en-US', { maximumFractionDigits: 2 });
}
function parseDateMaybe(d: string | null): Date | null {
  if (!d) return null;
  const dt = new Date(d.length === 10 ? d + 'T00:00:00' : d);
  return isNaN(dt.getTime()) ? null : dt;
}
function fmtDateL(d: string | null, lang: string): string {
  const dt = parseDateMaybe(d);
  if (!dt) return '—';
  return dt.toLocaleDateString(lang === 'es' ? 'es-ES' : 'en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// ── Warranty badge — "under warranty until X" / "expires in Nd" / "out of warranty"
interface WarrantyInfo { tone: string; bg: string; bd: string; label: string }
function warrantyInfo(expiresAt: string | null, lang: string): WarrantyInfo {
  const exp = parseDateMaybe(expiresAt);
  if (!exp) {
    return {
      tone: T.ink3, bg: 'rgba(31,35,28,0.04)', bd: T.rule,
      label: tr(lang, 'No warranty on file', 'Sin garantía registrada'),
    };
  }
  const days = daysBetween(new Date(), exp);
  if (days < 0) {
    return {
      tone: T.warm, bg: 'rgba(184,92,61,0.10)', bd: 'rgba(184,92,61,0.30)',
      label: tr(lang, 'Out of warranty', 'Fuera de garantía'),
    };
  }
  if (days <= 60) {
    return {
      tone: T.caramel, bg: 'rgba(201,150,68,0.12)', bd: 'rgba(201,150,68,0.32)',
      label: tr(lang, `Expires in ${days}d`, `Vence en ${days}d`),
    };
  }
  return {
    tone: T.sageDeep, bg: 'rgba(92,122,96,0.10)', bd: 'rgba(92,122,96,0.28)',
    label: tr(lang, `Under warranty until ${fmtDateL(expiresAt, lang)}`, `En garantía hasta ${fmtDateL(expiresAt, lang)}`),
  };
}

function StatusPill({ s, lang }: { s: EquipmentStatus; lang: string }) {
  const c = STATUS_TONE[s];
  return (
    <span style={{
      padding: '4px 11px', borderRadius: 999, height: 22,
      display: 'inline-flex', alignItems: 'center', gap: 6,
      background: `${c}14`, color: c, border: `1px solid ${c}33`,
      fontFamily: FONT_SANS, fontSize: 11, fontWeight: 600, whiteSpace: 'nowrap',
    }}>
      <span style={{ width: 7, height: 7, borderRadius: '50%', background: c, display: 'inline-block' }} />
      {statusLabel(s, lang)}
    </span>
  );
}
function WarrantyBadge({ w }: { w: WarrantyInfo }) {
  return (
    <span style={{
      padding: '4px 11px', borderRadius: 999,
      background: w.bg, color: w.tone, border: `1px solid ${w.bd}`,
      fontFamily: FONT_SANS, fontSize: 11, fontWeight: 600, whiteSpace: 'nowrap',
    }}>{w.label}</span>
  );
}

// ── shared select styling ──────────────────────────────────────────────────
const selectStyle: React.CSSProperties = {
  height: 40, padding: '0 12px', borderRadius: 10,
  background: T.bg, border: `1px solid ${T.rule}`,
  fontFamily: FONT_SANS, fontSize: 14, color: T.ink, width: '100%',
  boxSizing: 'border-box', outline: 'none', cursor: 'pointer',
};
const numInputStyle: React.CSSProperties = {
  height: 40, padding: '0 14px', borderRadius: 10,
  background: T.bg, border: `1px solid ${T.rule}`,
  fontFamily: FONT_SANS, fontSize: 14, color: T.ink, width: '100%',
  boxSizing: 'border-box', outline: 'none',
};

// ─────────────────────────────────────────────────────────────────────────
// ADD / EDIT FORM
// ─────────────────────────────────────────────────────────────────────────
function EquipmentForm({
  open, onClose, onSave, editTarget, lang,
}: {
  open: boolean;
  onClose: () => void;
  onSave: (input: EquipmentInput, id: string | null) => Promise<boolean>;
  editTarget: Equipment | null;
  lang: string;
}) {
  const [name, setName] = useState('');
  const [category, setCategory] = useState<EquipmentCategory>('other');
  const [status, setStatus] = useState<EquipmentStatus>('operational');
  const [location, setLocation] = useState('');
  const [manufacturer, setManufacturer] = useState('');
  const [modelNumber, setModelNumber] = useState('');
  const [serialNumber, setSerialNumber] = useState('');
  const [installDate, setInstallDate] = useState('');
  const [lifetime, setLifetime] = useState('');
  const [purchaseCost, setPurchaseCost] = useState('');
  const [replacementCost, setReplacementCost] = useState('');
  const [pmInterval, setPmInterval] = useState('');
  const [warrantyProvider, setWarrantyProvider] = useState('');
  const [warrantyExpires, setWarrantyExpires] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);

  // Re-seed the form whenever it opens (add = blank, edit = pre-filled).
  useEffect(() => {
    if (!open) return;
    const e = editTarget;
    setName(e?.name ?? '');
    setCategory(e?.category ?? 'other');
    setStatus(e?.status ?? 'operational');
    setLocation(e?.location ?? '');
    setManufacturer(e?.manufacturer ?? '');
    setModelNumber(e?.modelNumber ?? '');
    setSerialNumber(e?.serialNumber ?? '');
    setInstallDate(e?.installDate ?? '');
    setLifetime(e?.expectedLifetimeYears != null ? String(e.expectedLifetimeYears) : '');
    setPurchaseCost(e?.purchaseCost != null ? String(e.purchaseCost) : '');
    setReplacementCost(e?.replacementCost != null ? String(e.replacementCost) : '');
    setPmInterval(e?.pmIntervalDays != null ? String(e.pmIntervalDays) : '');
    setWarrantyProvider(e?.warrantyProvider ?? '');
    setWarrantyExpires(e?.warrantyExpiresAt ?? '');
    setNotes(e?.notes ?? '');
    setBusy(false);
  }, [open, editTarget]);

  const toNum = (s: string): number | null => {
    const t = s.trim();
    if (t === '') return null;
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
  };
  const toText = (s: string): string | null => (s.trim() === '' ? null : s.trim());

  const canSubmit = name.trim().length > 0 && !busy;

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    try {
      const input: EquipmentInput = {
        name: name.trim(),
        category,
        status,
        location: toText(location),
        manufacturer: toText(manufacturer),
        modelNumber: toText(modelNumber),
        serialNumber: toText(serialNumber),
        installDate: installDate || null,
        expectedLifetimeYears: toNum(lifetime),
        purchaseCost: toNum(purchaseCost),
        replacementCost: toNum(replacementCost),
        pmIntervalDays: toNum(pmInterval),
        warrantyProvider: toText(warrantyProvider),
        warrantyExpiresAt: warrantyExpires || null,
        notes: toText(notes),
      };
      const ok = await onSave(input, editTarget?.id ?? null);
      if (ok) onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={editTarget ? tr(lang, 'Edit equipment', 'Editar equipo') : tr(lang, 'Add equipment', 'Agregar equipo')}
      subtitle={tr(lang, 'An asset with its warranty, cost, and service history.', 'Un activo con su garantía, costo e historial de servicio.')}
      width={640}
      footer={
        <>
          <Btn variant="ghost" size="md" onClick={onClose}>{tr(lang, 'Cancel', 'Cancelar')}</Btn>
          <Btn variant="primary" size="md" onClick={submit} disabled={!canSubmit} style={{ opacity: canSubmit ? 1 : 0.4 }}>
            {busy ? tr(lang, 'Saving…', 'Guardando…') : (editTarget ? tr(lang, 'Save changes', 'Guardar cambios') : tr(lang, 'Add equipment', 'Agregar equipo'))}
          </Btn>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <Field label={tr(lang, 'Name', 'Nombre')} required>
          <TextInput value={name} onChange={setName} placeholder={tr(lang, 'e.g. "Rooftop AC unit #1"', 'p. ej. "Unidad de aire #1"')} />
        </Field>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
          <Field label={tr(lang, 'Category', 'Categoría')} required>
            <select value={category} onChange={(e) => setCategory(e.target.value as EquipmentCategory)} style={selectStyle}>
              {EQUIPMENT_CATEGORIES.map((c) => <option key={c} value={c}>{catLabel(c, lang)}</option>)}
            </select>
          </Field>
          <Field label={tr(lang, 'Status', 'Estado')}>
            <select value={status} onChange={(e) => setStatus(e.target.value as EquipmentStatus)} style={selectStyle}>
              {EQUIPMENT_STATUSES.map((s) => <option key={s} value={s}>{statusLabel(s, lang)}</option>)}
            </select>
          </Field>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
          <Field label={tr(lang, 'Location', 'Ubicación')}>
            <TextInput value={location} onChange={setLocation} placeholder={tr(lang, 'e.g. "Roof" or "Boiler room"', 'p. ej. "Techo"')} />
          </Field>
          <Field label={tr(lang, 'Manufacturer', 'Fabricante')}>
            <TextInput value={manufacturer} onChange={setManufacturer} placeholder={tr(lang, 'e.g. "Carrier"', 'p. ej. "Carrier"')} />
          </Field>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
          <Field label={tr(lang, 'Model number', 'Número de modelo')}>
            <TextInput value={modelNumber} onChange={setModelNumber} placeholder="—" />
          </Field>
          <Field label={tr(lang, 'Serial number', 'Número de serie')}>
            <TextInput value={serialNumber} onChange={setSerialNumber} placeholder="—" />
          </Field>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
          <Field label={tr(lang, 'Install date', 'Fecha de instalación')}>
            <input type="date" value={installDate} onChange={(e) => setInstallDate(e.target.value)} style={numInputStyle} />
          </Field>
          <Field label={tr(lang, 'Expected lifetime (years)', 'Vida útil (años)')}>
            <input type="number" min={0} step="0.5" value={lifetime} onChange={(e) => setLifetime(e.target.value)} style={numInputStyle} placeholder="—" />
          </Field>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
          <Field label={tr(lang, 'Purchase cost ($)', 'Costo de compra ($)')}>
            <input type="number" min={0} step="0.01" value={purchaseCost} onChange={(e) => setPurchaseCost(e.target.value)} style={numInputStyle} placeholder="—" />
          </Field>
          <Field label={tr(lang, 'Replacement cost ($)', 'Costo de reemplazo ($)')}>
            <input type="number" min={0} step="0.01" value={replacementCost} onChange={(e) => setReplacementCost(e.target.value)} style={numInputStyle} placeholder="—" />
          </Field>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
          <Field label={tr(lang, 'PM interval (days)', 'Intervalo PM (días)')} hint={tr(lang, 'How often it should be serviced', 'Frecuencia de servicio')}>
            <input type="number" min={0} step="1" value={pmInterval} onChange={(e) => setPmInterval(e.target.value)} style={numInputStyle} placeholder="—" />
          </Field>
          <Field label={tr(lang, 'Warranty provider', 'Proveedor de garantía')}>
            <TextInput value={warrantyProvider} onChange={setWarrantyProvider} placeholder="—" />
          </Field>
        </div>

        <Field label={tr(lang, 'Warranty expires', 'Vence la garantía')} hint={tr(lang, 'Drives the warranty badge', 'Define la insignia de garantía')}>
          <input type="date" value={warrantyExpires} onChange={(e) => setWarrantyExpires(e.target.value)} style={numInputStyle} />
        </Field>

        <Field label={tr(lang, 'Notes', 'Notas')}>
          <TextArea value={notes} onChange={setNotes} rows={2} placeholder={tr(lang, 'Anything worth remembering about this asset.', 'Algo que valga la pena recordar.')} />
        </Field>
      </div>
    </Modal>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// DETAIL + HISTORY
// ─────────────────────────────────────────────────────────────────────────
function DetailRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <Caps size={9}>{label}</Caps>
      <span style={{ fontFamily: FONT_SANS, fontSize: 14, color: T.ink, fontWeight: 500 }}>{value}</span>
    </div>
  );
}

function EquipmentDetailModal({
  open, onClose, detail, loading, lang, isMgr, onEdit, onDelete,
}: {
  open: boolean;
  onClose: () => void;
  detail: EquipmentDetail | null;
  loading: boolean;
  lang: string;
  isMgr: boolean;
  onEdit: (e: Equipment) => void;
  onDelete: (e: Equipment) => void;
}) {
  const eq = detail?.equipment ?? null;
  const w = useMemo(() => (eq ? warrantyInfo(eq.warrantyExpiresAt, lang) : null), [eq, lang]);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={eq ? eq.name : tr(lang, 'Equipment', 'Equipo')}
      subtitle={eq ? `${catLabel(eq.category, lang)}${eq.location ? ` · ${eq.location}` : ''}` : undefined}
      width={680}
      footer={
        <>
          {eq && isMgr && (
            <>
              <Btn variant="ghost" size="md" onClick={() => onDelete(eq)} style={{ color: T.warm, marginRight: 'auto' }}>
                {tr(lang, 'Delete', 'Eliminar')}
              </Btn>
              <Btn variant="ghost" size="md" onClick={() => onEdit(eq)}>{tr(lang, 'Edit', 'Editar')}</Btn>
            </>
          )}
          <Btn variant="primary" size="md" onClick={onClose}>{tr(lang, 'Close', 'Cerrar')}</Btn>
        </>
      }
    >
      {loading || !detail || !eq ? (
        <div style={{ padding: '40px 0', textAlign: 'center', fontFamily: FONT_SANS, fontSize: 13, color: T.ink2 }}>
          {tr(lang, 'Loading…', 'Cargando…')}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          {/* status + warranty */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <StatusPill s={eq.status} lang={lang} />
            {w && <WarrantyBadge w={w} />}
          </div>

          {/* spend summary */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>
            {[
              { k: tr(lang, 'Total repair spend', 'Gasto total en reparaciones'), v: fmtMoney(detail.totalRepairSpend, lang), tone: T.ink },
              { k: tr(lang, 'Failures (work orders)', 'Fallas (órdenes)'), v: String(detail.failureCount), tone: detail.failureCount > 0 ? T.warm : T.ink },
              { k: tr(lang, 'PM tasks', 'Tareas PM'), v: String(detail.preventiveCount), tone: T.ink },
            ].map((s, i) => (
              <div key={i} style={{ background: T.bg, border: `1px solid ${T.rule}`, borderRadius: 12, padding: '12px 14px' }}>
                <Caps size={9}>{s.k}</Caps>
                <p style={{ fontFamily: FONT_SERIF, fontSize: 26, color: s.tone, margin: '4px 0 0', fontWeight: 400, letterSpacing: '-0.02em' }}>{s.v}</p>
              </div>
            ))}
          </div>

          {/* fields */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 16, padding: '4px 0 16px', borderBottom: `1px solid ${T.ruleSoft}` }}>
            <DetailRow label={tr(lang, 'Manufacturer', 'Fabricante')} value={eq.manufacturer ?? '—'} />
            <DetailRow label={tr(lang, 'Model #', 'Modelo #')} value={eq.modelNumber ?? '—'} />
            <DetailRow label={tr(lang, 'Serial #', 'Serie #')} value={eq.serialNumber ?? '—'} />
            <DetailRow label={tr(lang, 'Installed', 'Instalado')} value={fmtDateL(eq.installDate, lang)} />
            <DetailRow label={tr(lang, 'Expected lifetime', 'Vida útil')} value={eq.expectedLifetimeYears != null ? tr(lang, `${eq.expectedLifetimeYears} yr`, `${eq.expectedLifetimeYears} años`) : '—'} />
            <DetailRow label={tr(lang, 'PM interval', 'Intervalo PM')} value={eq.pmIntervalDays != null ? tr(lang, `${eq.pmIntervalDays} days`, `${eq.pmIntervalDays} días`) : '—'} />
            <DetailRow label={tr(lang, 'Purchase cost', 'Costo de compra')} value={fmtMoney(eq.purchaseCost, lang)} />
            <DetailRow label={tr(lang, 'Replacement cost', 'Costo de reemplazo')} value={fmtMoney(eq.replacementCost, lang)} />
            <DetailRow label={tr(lang, 'Warranty provider', 'Proveedor garantía')} value={eq.warrantyProvider ?? '—'} />
          </div>

          {eq.notes && (
            <div>
              <Caps size={9}>{tr(lang, 'Notes', 'Notas')}</Caps>
              <p style={{ fontFamily: FONT_SANS, fontSize: 13, color: T.ink2, margin: '6px 0 0', lineHeight: 1.5, fontStyle: 'italic' }}>{eq.notes}</p>
            </div>
          )}

          {/* history */}
          <div>
            <Caps>{tr(lang, 'Service history', 'Historial de servicio')}</Caps>
            <p style={{ fontFamily: FONT_SANS, fontSize: 12, color: T.ink2, margin: '4px 0 12px', fontStyle: 'italic' }}>
              {tr(lang, 'Every work order and preventive task linked to this asset.', 'Cada orden de trabajo y tarea preventiva vinculada a este activo.')}
            </p>

            {detail.history.length === 0 ? (
              <div style={{ background: T.bg, border: `1px solid ${T.rule}`, borderRadius: 12, padding: '24px', textAlign: 'center', fontFamily: FONT_SERIF, fontSize: 16, color: T.ink2, fontStyle: 'italic' }}>
                {tr(lang, 'No linked history yet.', 'Sin historial vinculado todavía.')}
              </div>
            ) : (
              <div style={{ background: T.paper, border: `1px solid ${T.rule}`, borderRadius: 12, overflow: 'hidden' }}>
                <div style={{ display: 'grid', gridTemplateColumns: '110px 1fr 110px 90px', gap: 12, padding: '10px 16px', borderBottom: `1px solid ${T.rule}`, background: T.bg }}>
                  <Caps size={9}>{tr(lang, 'Date', 'Fecha')}</Caps>
                  <Caps size={9}>{tr(lang, 'What', 'Qué')}</Caps>
                  <Caps size={9}>{tr(lang, 'Type', 'Tipo')}</Caps>
                  <Caps size={9}>{tr(lang, 'Cost', 'Costo')}</Caps>
                </div>
                {detail.history.map((h) => (
                  <div key={`${h.kind}-${h.id}`} style={{ display: 'grid', gridTemplateColumns: '110px 1fr 110px 90px', gap: 12, padding: '12px 16px', borderBottom: `1px solid ${T.ruleSoft}`, alignItems: 'center' }}>
                    <span style={{ fontFamily: FONT_MONO, fontSize: 12, color: T.ink2 }}>{fmtDateL(h.date, lang)}</span>
                    <div style={{ minWidth: 0 }}>
                      <span style={{ fontFamily: FONT_SANS, fontSize: 13, color: T.ink, fontWeight: 500 }}>{h.title || '—'}</span>
                      {h.detail && <span style={{ fontFamily: FONT_MONO, fontSize: 10, color: T.ink3, marginLeft: 8 }}>{h.detail}</span>}
                    </div>
                    <span style={{ fontFamily: FONT_SANS, fontSize: 11, color: T.ink2 }}>
                      {h.kind === 'work_order'
                        ? `${tr(lang, 'Work order', 'Orden')}${h.status ? ` · ${h.status === 'done' ? tr(lang, 'done', 'hecho') : tr(lang, 'open', 'abierta')}` : ''}`
                        : tr(lang, 'Preventive', 'Preventiva')}
                    </span>
                    <span style={{ fontFamily: FONT_MONO, fontSize: 13, color: h.cost != null ? T.ink : T.ink3 }}>{h.cost != null ? fmtMoney(h.cost, lang) : '—'}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// LIST CARD
// ─────────────────────────────────────────────────────────────────────────
function EquipmentCard({ e, lang, onOpen }: { e: Equipment; lang: string; onOpen: (e: Equipment) => void }) {
  const w = warrantyInfo(e.warrantyExpiresAt, lang);
  const tone = STATUS_TONE[e.status];
  return (
    <button onClick={() => onOpen(e)} style={{
      textAlign: 'left', cursor: 'pointer', width: '100%',
      background: T.paper, border: `1px solid ${T.rule}`, borderRadius: 14,
      padding: '16px 22px 16px 26px', display: 'grid',
      gridTemplateColumns: 'minmax(200px, 1.6fr) 150px auto auto', gap: 16, alignItems: 'center',
      position: 'relative', overflow: 'hidden',
    }}>
      <span style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 4, background: tone }} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 }}>
        <span style={{ fontFamily: FONT_SERIF, fontSize: 22, color: T.ink, fontStyle: 'italic', letterSpacing: '-0.02em', lineHeight: 1.1, fontWeight: 400 }}>{e.name}</span>
        <span style={{ fontFamily: FONT_MONO, fontSize: 11, color: T.ink2, letterSpacing: '0.04em' }}>
          {catLabel(e.category, lang)}{e.location ? ` · ${e.location}` : ''}
        </span>
      </div>
      <StatusPill s={e.status} lang={lang} />
      <WarrantyBadge w={w} />
      <span style={{ fontFamily: FONT_SERIF, fontSize: 24, color: T.ink2, fontStyle: 'italic', justifySelf: 'end' }}>→</span>
    </button>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// ROOT
// ─────────────────────────────────────────────────────────────────────────
export function EquipmentRegistry({ onBack }: { onBack: () => void }) {
  const { user } = useAuth();
  const { activePropertyId } = useProperty();
  const { lang } = useLang();
  const pid = activePropertyId;
  const isMgr = user ? canManageTeam(user.role) : false;

  const [list, setList] = useState<Equipment[]>([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState('');

  const [detailId, setDetailId] = useState<string | null>(null);
  const [detail, setDetail] = useState<EquipmentDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const [formOpen, setFormOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<Equipment | null>(null);

  // Single replace-on-reshow toast (max: 1 drops the previous one, and each
  // show gets a fresh 3200ms timer — same semantics as the old hand-roll).
  const { toasts, show: flash } = useToast({ durationMs: 3200, max: 1 });

  const refresh = useCallback(async () => {
    if (!pid) return;
    const l = await fetchEquipmentList(pid);
    setList(l);
    setLoading(false);
  }, [pid]);

  useEffect(() => { void refresh(); }, [refresh]);

  const loadDetail = useCallback(async (id: string) => {
    if (!pid) return;
    setDetailLoading(true);
    const d = await fetchEquipmentDetail(pid, id);
    setDetail(d);
    setDetailLoading(false);
  }, [pid]);

  const openDetail = (e: Equipment) => {
    setDetailId(e.id);
    setDetail(null);
    void loadDetail(e.id);
  };
  const closeDetail = () => { setDetailId(null); setDetail(null); };

  const openAdd = () => { setEditTarget(null); setFormOpen(true); };
  const openEdit = (e: Equipment) => { setEditTarget(e); setFormOpen(true); };

  const handleSave = async (input: EquipmentInput, id: string | null): Promise<boolean> => {
    if (!pid) return false;
    const res = id ? await updateEquipmentAsset(pid, id, input) : await createEquipmentAsset(pid, input);
    if (!res.ok) {
      flash(res.error || tr(lang, 'Could not save', 'No se pudo guardar'));
      return false;
    }
    flash(id ? tr(lang, 'Saved', 'Guardado') : tr(lang, 'Equipment added', 'Equipo agregado'));
    await refresh();
    if (id && detailId === id) await loadDetail(id);  // keep open detail fresh
    return true;
  };

  const handleDelete = async (e: Equipment) => {
    if (!pid) return;
    const msg = tr(lang,
      `Delete "${e.name}"? Its work orders and PM tasks stay — they just unlink from this asset.`,
      `¿Eliminar "${e.name}"? Sus órdenes y tareas PM permanecen — solo se desvinculan de este activo.`);
    if (!window.confirm(msg)) return;
    const res = await deleteEquipmentAsset(pid, e.id);
    if (!res.ok) { flash(res.error || tr(lang, 'Could not delete', 'No se pudo eliminar')); return; }
    flash(tr(lang, 'Equipment deleted', 'Equipo eliminado'));
    closeDetail();
    await refresh();
  };

  const filtered = useMemo(() => {
    if (!q.trim()) return list;
    const needle = q.toLowerCase();
    return list.filter((e) =>
      `${e.name} ${e.location ?? ''} ${e.manufacturer ?? ''} ${e.modelNumber ?? ''} ${e.serialNumber ?? ''} ${catLabel(e.category, lang)}`
        .toLowerCase().includes(needle));
  }, [list, q, lang]);

  return (
    <div style={{ padding: '24px 48px 48px', background: T.bg, color: T.ink, fontFamily: FONT_SANS, minHeight: 'calc(100dvh - 130px)' }}>
      {/* header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: 18, gap: 24, flexWrap: 'wrap' }}>
        <div>
          <button onClick={onBack} style={{ background: 'transparent', border: 'none', cursor: 'pointer', padding: 0, marginBottom: 6, fontFamily: FONT_SANS, fontSize: 13, color: T.ink2, fontWeight: 500 }}>
            ← {tr(lang, 'Back to preventive', 'Volver a preventivo')}
          </button>
          <Caps>{tr(lang, 'Equipment registry', 'Registro de equipos')}</Caps>
          <h1 style={{ fontFamily: FONT_SERIF, fontSize: 36, color: T.ink, margin: '4px 0 0', letterSpacing: '-0.03em', lineHeight: 1.25, fontWeight: 400 }}>
            <span style={{ fontStyle: 'italic' }}>{list.length} {tr(lang, list.length === 1 ? 'asset' : 'assets', list.length === 1 ? 'activo' : 'activos')}</span>
          </h1>
        </div>
        {isMgr && <Btn variant="primary" size="md" onClick={openAdd}>＋ {tr(lang, 'Add equipment', 'Agregar equipo')}</Btn>}
      </div>

      {/* search */}
      {list.length > 0 && (
        <div style={{ marginBottom: 14 }}>
          <input
            type="text" value={q} onChange={(e) => setQ(e.target.value)}
            placeholder={tr(lang, 'Search by name, location, model…', 'Buscar por nombre, ubicación, modelo…')}
            style={{ width: '100%', maxWidth: 420, height: 38, padding: '0 14px', borderRadius: 10, background: T.paper, border: `1px solid ${T.rule}`, fontFamily: FONT_SANS, fontSize: 13, color: T.ink, outline: 'none' }}
          />
        </div>
      )}

      {/* list */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {loading && (
          <div style={{ padding: '48px 0', textAlign: 'center', fontFamily: FONT_SANS, fontSize: 13, color: T.ink2 }}>{tr(lang, 'Loading…', 'Cargando…')}</div>
        )}
        {!loading && list.length === 0 && (
          <MtEmptyCard
            titleSize={24}
            bodySize={13}
            title={tr(lang, 'No equipment yet.', 'Aún no hay equipos.')}
            body={tr(lang, 'Add your HVAC units, water heaters, elevators, pool pumps — anything you service.', 'Agregue unidades de aire, calentadores, ascensores, bombas de piscina — todo lo que da servicio.')}
            action={isMgr && <Btn variant="primary" size="md" onClick={openAdd}>＋ {tr(lang, 'Add your first asset', 'Agregar su primer activo')}</Btn>}
          />
        )}
        {!loading && list.length > 0 && filtered.length === 0 && (
          <div style={{ padding: '40px 0', textAlign: 'center', fontFamily: FONT_SERIF, fontSize: 18, color: T.ink2, fontStyle: 'italic' }}>{tr(lang, 'Nothing matches that search.', 'Nada coincide con esa búsqueda.')}</div>
        )}
        {!loading && filtered.map((e) => <EquipmentCard key={e.id} e={e} lang={lang} onOpen={openDetail} />)}
      </div>

      <EquipmentForm open={formOpen} onClose={() => setFormOpen(false)} onSave={handleSave} editTarget={editTarget} lang={lang} />
      <EquipmentDetailModal
        open={detailId !== null}
        onClose={closeDetail}
        detail={detail}
        loading={detailLoading}
        lang={lang}
        isMgr={isMgr}
        onEdit={(e) => { closeDetail(); openEdit(e); }}
        onDelete={handleDelete}
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
