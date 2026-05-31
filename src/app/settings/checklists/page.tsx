'use client';

export const dynamic = 'force-dynamic';

// Settings → Checklists.
// Managers build and edit their own Cleaning and Inspection checklists, copy
// them to other properties, and reset to the Staxis default. Built on the
// EXISTING checklist tables (0212 inspection, 0222 cleaning) — edits the
// per-property override only; the global Staxis defaults are never touched.
//
// Same manager/owner/admin gate + AppLayout shell + fetchWithAuth + /api
// pattern as Settings → Reports. Everything reads/writes through
// /api/settings/checklists/* with service-role on the server (the tables are
// deny-all to the browser client).

import React, { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import {
  ChevronLeft, ChevronUp, ChevronDown, Plus, Trash2, Copy, RotateCcw, Save, X, Check, AlertTriangle, ShieldCheck,
} from 'lucide-react';

import { AppLayout } from '@/components/layout/AppLayout';
import { useAuth } from '@/contexts/AuthContext';
import { useProperty } from '@/contexts/PropertyContext';
import { useLang } from '@/contexts/LanguageContext';
import { canManageTeam } from '@/lib/roles';
import { fetchWithAuth } from '@/lib/api-fetch';
import { t } from '@/lib/translations';
import { T, fonts, Btn, Caps, Pill } from '@/app/staff/_components/_tokens';

type Lang = 'en' | 'es';

// ─── Bilingual label maps ───────────────────────────────────────────────────

const CLEANING_TYPES = ['departure', 'stayover', 'deep', 'refresh', 'inspection'] as const;
type CleaningType = (typeof CLEANING_TYPES)[number];
const CLEANING_TYPE_LABEL: Record<CleaningType, { en: string; es: string }> = {
  departure: { en: 'Departure', es: 'Salida' },
  stayover: { en: 'Stayover', es: 'Estancia' },
  deep: { en: 'Deep clean', es: 'Limpieza profunda' },
  refresh: { en: 'Refresh', es: 'Retoque' },
  inspection: { en: 'Inspection', es: 'Inspección' },
};

const CLEANING_AREAS = ['bathroom', 'bedroom', 'living', 'kitchen', 'entry', 'amenities', 'final'] as const;
type CleaningArea = (typeof CLEANING_AREAS)[number];
const AREA_LABEL: Record<CleaningArea, { en: string; es: string }> = {
  bathroom: { en: 'Bathroom', es: 'Baño' },
  bedroom: { en: 'Bedroom', es: 'Dormitorio' },
  living: { en: 'Living', es: 'Sala' },
  kitchen: { en: 'Kitchen', es: 'Cocina' },
  entry: { en: 'Entry', es: 'Entrada' },
  amenities: { en: 'Amenities', es: 'Amenidades' },
  final: { en: 'Final', es: 'Final' },
};

const INSPECTION_CATEGORIES = ['bathroom', 'bedroom', 'living', 'kitchen', 'welcome', 'other'] as const;
type InspectionCategory = (typeof INSPECTION_CATEGORIES)[number];
const CATEGORY_LABEL: Record<InspectionCategory, { en: string; es: string }> = {
  bathroom: { en: 'Bathroom', es: 'Baño' },
  bedroom: { en: 'Bedroom', es: 'Dormitorio' },
  living: { en: 'Living', es: 'Sala' },
  kitchen: { en: 'Kitchen', es: 'Cocina' },
  welcome: { en: 'Welcome', es: 'Bienvenida' },
  other: { en: 'Other', es: 'Otro' },
};

const SEVERITIES = ['minor', 'major', 'critical'] as const;
type Severity = (typeof SEVERITIES)[number];
const SEVERITY_LABEL: Record<Severity, { en: string; es: string }> = {
  minor: { en: 'Minor', es: 'Menor' },
  major: { en: 'Major', es: 'Mayor' },
  critical: { en: 'Critical', es: 'Crítico' },
};

const INSPECTION_CLEANING_TYPES = ['departure', 'departure_deep', 'stayover', 'deep', 'refresh'] as const;
type InspectionCleaningType = (typeof INSPECTION_CLEANING_TYPES)[number];
const INSPECTION_CT_LABEL: Record<InspectionCleaningType, { en: string; es: string }> = {
  departure: { en: 'Departure', es: 'Salida' },
  departure_deep: { en: 'Departure deep', es: 'Salida profunda' },
  stayover: { en: 'Stayover', es: 'Estancia' },
  deep: { en: 'Deep', es: 'Profunda' },
  refresh: { en: 'Refresh', es: 'Retoque' },
};

// ─── DTOs (mirror the API envelope payloads) ────────────────────────────────

interface CleaningItem { area: CleaningArea; itemEn: string; itemEs: string; isCritical: boolean; }
interface CleaningChecklist {
  cleaningType: CleaningType;
  nameEn: string; nameEs: string;
  isOverride: boolean; hasDefault: boolean;
  items: Array<CleaningItem & { id: string; sortOrder: number }>;
}
interface InspectionItem {
  category: InspectionCategory; label: string; labelEs: string;
  severityDefault: Severity; requiresPhotoOnFail: boolean;
}
interface InspectionChecklist {
  checklistId: string | null;
  name: string;
  appliesToCleaningTypes: string[];
  appliesToRoomTypes: string[];
  isOverride: boolean; hasDefault: boolean;
  items: Array<InspectionItem & { id: string; orderIndex: number }>;
}

// Editable rows carry a client-only key so React reconciles correctly while
// rows are added / reordered before they have a server id.
let keySeq = 0;
const nextKey = () => `row-${keySeq++}`;
type EditCleaning = CleaningItem & { _key: string };
type EditInspection = InspectionItem & { _key: string };

// ─── Page shell + management gate ───────────────────────────────────────────

export default function ChecklistsPage() {
  const { user } = useAuth();
  const { activePropertyId, properties } = useProperty();
  const { lang } = useLang();

  if (!user) {
    return <AppLayout><div style={{ padding: 24 }}>Sign in to continue.</div></AppLayout>;
  }
  if (!canManageTeam(user.role)) {
    return (
      <AppLayout>
        <div style={{ padding: 24, maxWidth: 520, margin: '40px auto', textAlign: 'center' }}>
          <h1 style={{ fontFamily: fonts.serif, fontSize: 24, color: T.ink, marginBottom: 12 }}>
            {lang === 'es' ? 'Acceso restringido' : 'You don’t have access'}
          </h1>
          <p style={{ fontFamily: fonts.sans, fontSize: 14, color: T.ink2, marginBottom: 20 }}>
            {lang === 'es'
              ? 'Las listas de verificación solo están disponibles para gerentes, propietarios y administradores.'
              : 'Checklists are restricted to managers, owners, and admins.'}
          </p>
          <Link href="/settings">
            <Btn variant="ghost"><ChevronLeft size={14} /> {lang === 'es' ? 'Volver' : 'Back to Settings'}</Btn>
          </Link>
        </div>
      </AppLayout>
    );
  }

  return (
    <AppLayout>
      <ChecklistsBody
        pid={activePropertyId ?? ''}
        lang={lang}
        properties={properties.map((p) => ({ id: p.id, name: p.name }))}
      />
    </AppLayout>
  );
}

function ChecklistsBody({ pid, lang, properties }: {
  pid: string; lang: Lang; properties: Array<{ id: string; name: string }>;
}) {
  const [tab, setTab] = useState<'cleaning' | 'inspection'>('cleaning');

  if (!pid) {
    return (
      <div style={{ padding: '16px 16px 40px', maxWidth: 980, margin: '0 auto' }}>
        <div style={{ fontFamily: fonts.sans, fontSize: 14, color: T.ink2 }}>
          {lang === 'es' ? 'Selecciona una propiedad primero.' : 'Select a property first.'}
        </div>
      </div>
    );
  }

  return (
    <div style={{ padding: '16px 16px 48px', display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 980, margin: '0 auto', width: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <Link href="/settings" style={{ textDecoration: 'none', color: T.ink2 }}>
          <Btn variant="ghost" size="sm"><ChevronLeft size={14} /> {lang === 'es' ? 'Ajustes' : 'Settings'}</Btn>
        </Link>
        <h1 style={{ fontFamily: fonts.serif, fontSize: 26, lineHeight: 1.1, color: T.ink, margin: 0, letterSpacing: '-0.01em' }}>
          {t('checklistsTitle', lang)}
        </h1>
      </div>
      <p style={{ fontFamily: fonts.sans, fontSize: 14, color: T.ink2, margin: 0, maxWidth: 680 }}>
        {t('checklistsCardDesc', lang)}
      </p>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 6 }}>
        <TabBtn active={tab === 'cleaning'} onClick={() => setTab('cleaning')}>
          {lang === 'es' ? 'Limpieza' : 'Cleaning'}
        </TabBtn>
        <TabBtn active={tab === 'inspection'} onClick={() => setTab('inspection')}>
          {lang === 'es' ? 'Inspección' : 'Inspection'}
        </TabBtn>
      </div>

      {tab === 'cleaning'
        ? <CleaningEditor pid={pid} lang={lang} properties={properties} />
        : <InspectionEditor pid={pid} lang={lang} properties={properties} />}

      {/* Compliance note — out of scope for editing; managed by Staxis. */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', color: T.ink3, fontFamily: fonts.sans, fontSize: 12, marginTop: 4 }}>
        <ShieldCheck size={13} />
        {lang === 'es'
          ? 'Las listas de cumplimiento (compliance) las administra Staxis y no se editan aquí.'
          : 'Compliance checklists are managed by Staxis and aren’t edited here.'}
      </div>
    </div>
  );
}

function TabBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: '7px 16px', borderRadius: 999,
        border: `1px solid ${active ? T.ink : T.rule}`,
        background: active ? T.ink : 'transparent',
        color: active ? T.bg : T.ink2,
        fontFamily: fonts.sans, fontSize: 13, fontWeight: 600, cursor: 'pointer',
      }}
    >
      {children}
    </button>
  );
}

// ─── Cleaning editor ────────────────────────────────────────────────────────

function CleaningEditor({ pid, lang, properties }: {
  pid: string; lang: Lang; properties: Array<{ id: string; name: string }>;
}) {
  const [type, setType] = useState<CleaningType>('departure');
  const [data, setData] = useState<CleaningChecklist | null>(null);
  const [items, setItems] = useState<EditCleaning[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [showCopy, setShowCopy] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setError(null); setNotice(null);
    try {
      const r = await fetchWithAuth(`/api/settings/checklists/cleaning?propertyId=${encodeURIComponent(pid)}&cleaningType=${type}`);
      const body = await r.json().catch(() => null);
      if (!r.ok) { setError(body?.error ?? `Failed (${r.status})`); return; }
      const cl = (body?.data?.checklist ?? null) as CleaningChecklist | null;
      setData(cl);
      setItems((cl?.items ?? []).map((it) => ({
        area: it.area, itemEn: it.itemEn, itemEs: it.itemEs, isCritical: it.isCritical, _key: nextKey(),
      })));
    } catch (e) {
      setError((e as Error)?.message ?? 'Network error');
    } finally {
      setLoading(false);
    }
  }, [pid, type]);

  useEffect(() => { void load(); }, [load]);

  const save = useCallback(async () => {
    const blank = items.find((it) => !it.itemEn.trim() || !it.itemEs.trim());
    if (blank) { setError(lang === 'es' ? 'Cada tarea necesita texto en inglés y español.' : 'Every item needs English and Spanish text.'); return; }
    setSaving(true); setError(null); setNotice(null);
    try {
      const r = await fetchWithAuth('/api/settings/checklists/cleaning', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          propertyId: pid,
          cleaningType: type,
          items: items.map((it) => ({ area: it.area, itemEn: it.itemEn.trim(), itemEs: it.itemEs.trim(), isCritical: it.isCritical })),
        }),
      });
      const body = await r.json().catch(() => null);
      if (!r.ok) { setError(body?.error ?? `Failed (${r.status})`); return; }
      setNotice(lang === 'es' ? 'Guardado.' : 'Saved.');
      await load();
    } catch (e) {
      setError((e as Error)?.message ?? 'Network error');
    } finally {
      setSaving(false);
    }
  }, [pid, type, items, lang, load]);

  const reset = useCallback(async () => {
    setConfirmReset(false);
    setSaving(true); setError(null); setNotice(null);
    try {
      const r = await fetchWithAuth(`/api/settings/checklists/cleaning?propertyId=${encodeURIComponent(pid)}&cleaningType=${type}`, { method: 'DELETE' });
      const body = await r.json().catch(() => null);
      if (!r.ok) { setError(body?.error ?? `Failed (${r.status})`); return; }
      setNotice(lang === 'es' ? 'Restablecido al valor de Staxis.' : 'Reset to the Staxis default.');
      await load();
    } catch (e) {
      setError((e as Error)?.message ?? 'Network error');
    } finally {
      setSaving(false);
    }
  }, [pid, type, lang, load]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* Cleaning-type selector */}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {CLEANING_TYPES.map((ct) => (
          <button
            key={ct}
            onClick={() => setType(ct)}
            style={{
              padding: '5px 12px', borderRadius: 999,
              border: `1px solid ${type === ct ? T.sageDeep : T.rule}`,
              background: type === ct ? T.sageDim : 'transparent',
              color: type === ct ? T.sageDeep : T.ink2,
              fontFamily: fonts.sans, fontSize: 12.5, fontWeight: 500, cursor: 'pointer',
            }}
          >
            {CLEANING_TYPE_LABEL[ct][lang]}
          </button>
        ))}
      </div>

      <StatusRow
        lang={lang}
        isOverride={data?.isOverride ?? false}
        hasDefault={data?.hasDefault ?? false}
      />

      {error && <Banner tone="warm">{error}</Banner>}
      {notice && <Banner tone="sage"><Check size={13} /> {notice}</Banner>}

      {loading && items.length === 0 ? (
        <Loading lang={lang} />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {/* Header row */}
          <div style={{ display: 'grid', gridTemplateColumns: '120px 1fr 1fr 78px 96px', gap: 8, padding: '0 4px' }}>
            <Caps>{lang === 'es' ? 'Área' : 'Area'}</Caps>
            <Caps>{lang === 'es' ? 'Tarea (Inglés)' : 'Item (English)'}</Caps>
            <Caps>{lang === 'es' ? 'Tarea (Español)' : 'Item (Spanish)'}</Caps>
            <Caps>{lang === 'es' ? 'Clave' : 'Critical'}</Caps>
            <Caps>{lang === 'es' ? 'Orden' : 'Order'}</Caps>
          </div>

          {items.length === 0 && (
            <div style={{ fontFamily: fonts.sans, fontSize: 13, color: T.ink3, padding: '12px 4px' }}>
              {lang === 'es' ? 'Sin tareas todavía. Agrega la primera.' : 'No items yet. Add the first one.'}
            </div>
          )}

          {items.map((it, idx) => (
            <div key={it._key} style={{ display: 'grid', gridTemplateColumns: '120px 1fr 1fr 78px 96px', gap: 8, alignItems: 'center' }}>
              <select
                value={it.area}
                onChange={(e) => setItems((p) => p.map((x, i) => i === idx ? { ...x, area: e.target.value as CleaningArea } : x))}
                aria-label={lang === 'es' ? 'Área' : 'Area'}
                style={inputStyle}
              >
                {CLEANING_AREAS.map((a) => <option key={a} value={a}>{AREA_LABEL[a][lang]}</option>)}
              </select>
              <input
                value={it.itemEn}
                onChange={(e) => setItems((p) => p.map((x, i) => i === idx ? { ...x, itemEn: e.target.value } : x))}
                placeholder={lang === 'es' ? 'p. ej. Limpiar el inodoro' : 'e.g. Clean toilet'}
                aria-label="Item English"
                style={inputStyle}
              />
              <input
                value={it.itemEs}
                onChange={(e) => setItems((p) => p.map((x, i) => i === idx ? { ...x, itemEs: e.target.value } : x))}
                placeholder={lang === 'es' ? 'p. ej. Limpiar el inodoro' : 'p. ej. Limpiar el inodoro'}
                aria-label="Item Spanish"
                style={inputStyle}
              />
              <button
                onClick={() => setItems((p) => p.map((x, i) => i === idx ? { ...x, isCritical: !x.isCritical } : x))}
                aria-label={lang === 'es' ? 'Marcar como clave' : 'Toggle critical'}
                title={lang === 'es' ? 'Tarea clave' : 'Critical item'}
                style={{
                  height: 34, borderRadius: 8, cursor: 'pointer',
                  border: `1px solid ${it.isCritical ? 'rgba(160,74,44,0.4)' : T.rule}`,
                  background: it.isCritical ? T.redDim : 'transparent',
                  color: it.isCritical ? T.red : T.ink3,
                  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4,
                  fontFamily: fonts.sans, fontSize: 11.5, fontWeight: 600,
                }}
              >
                <AlertTriangle size={13} /> {it.isCritical ? (lang === 'es' ? 'Sí' : 'Yes') : (lang === 'es' ? 'No' : 'No')}
              </button>
              <RowControls
                idx={idx} count={items.length}
                onUp={() => move(setItems, idx, -1)}
                onDown={() => move(setItems, idx, 1)}
                onDelete={() => setItems((p) => p.filter((_, i) => i !== idx))}
              />
            </div>
          ))}

          <div>
            <Btn variant="ghost" size="sm" onClick={() => setItems((p) => [...p, { area: 'bedroom', itemEn: '', itemEs: '', isCritical: false, _key: nextKey() }])}>
              <Plus size={14} /> {lang === 'es' ? 'Agregar tarea' : 'Add item'}
            </Btn>
          </div>
        </div>
      )}

      {/* Action bar */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', borderTop: `1px solid ${T.rule}`, paddingTop: 12 }}>
        <Btn variant="primary" size="md" onClick={() => void save()} disabled={saving || loading}>
          <Save size={14} /> {saving ? (lang === 'es' ? 'Guardando…' : 'Saving…') : (lang === 'es' ? 'Guardar' : 'Save')}
        </Btn>
        <Btn variant="ghost" size="md" onClick={() => setShowCopy(true)} disabled={saving || loading}>
          <Copy size={14} /> {lang === 'es' ? 'Copiar a otras propiedades' : 'Copy to other properties'}
        </Btn>
        {data?.isOverride && (
          <Btn variant="ghost" size="md" onClick={() => setConfirmReset(true)} disabled={saving || loading}>
            <RotateCcw size={14} /> {lang === 'es' ? 'Restablecer al valor de Staxis' : 'Reset to Staxis default'}
          </Btn>
        )}
      </div>

      {showCopy && (
        <CopyModal
          lang={lang}
          pid={pid}
          properties={properties}
          label={CLEANING_TYPE_LABEL[type][lang]}
          onClose={() => setShowCopy(false)}
          buildBody={(targetIds) => ({ sourceType: 'cleaning', key: type, sourcePropertyId: pid, targetPropertyIds: targetIds })}
        />
      )}
      {confirmReset && (
        <ConfirmModal
          lang={lang}
          title={lang === 'es' ? 'Restablecer al valor de Staxis' : 'Reset to Staxis default'}
          message={lang === 'es'
            ? `Esto eliminará tu versión personalizada de la lista “${CLEANING_TYPE_LABEL[type].es}” y volverá al valor predeterminado de Staxis.`
            : `This deletes your customized “${CLEANING_TYPE_LABEL[type].en}” checklist and falls back to the Staxis default.`}
          confirmLabel={lang === 'es' ? 'Restablecer' : 'Reset'}
          onConfirm={() => void reset()}
          onCancel={() => setConfirmReset(false)}
        />
      )}
    </div>
  );
}

// ─── Inspection editor ──────────────────────────────────────────────────────

function InspectionEditor({ pid, lang, properties }: {
  pid: string; lang: Lang; properties: Array<{ id: string; name: string }>;
}) {
  const [data, setData] = useState<InspectionChecklist | null>(null);
  const [name, setName] = useState('');
  const [applies, setApplies] = useState<string[]>([]);
  const [items, setItems] = useState<EditInspection[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [showCopy, setShowCopy] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setError(null); setNotice(null);
    try {
      const r = await fetchWithAuth(`/api/settings/checklists/inspection?propertyId=${encodeURIComponent(pid)}`);
      const body = await r.json().catch(() => null);
      if (!r.ok) { setError(body?.error ?? `Failed (${r.status})`); return; }
      const cl = (body?.data?.checklist ?? null) as InspectionChecklist | null;
      setData(cl);
      setName(cl?.name ?? '');
      setApplies(cl?.appliesToCleaningTypes ?? []);
      setItems((cl?.items ?? []).map((it) => ({
        category: it.category, label: it.label, labelEs: it.labelEs,
        severityDefault: it.severityDefault, requiresPhotoOnFail: it.requiresPhotoOnFail, _key: nextKey(),
      })));
    } catch (e) {
      setError((e as Error)?.message ?? 'Network error');
    } finally {
      setLoading(false);
    }
  }, [pid]);

  useEffect(() => { void load(); }, [load]);

  const save = useCallback(async () => {
    if (!name.trim()) { setError(lang === 'es' ? 'La lista necesita un nombre.' : 'The checklist needs a name.'); return; }
    const blank = items.find((it) => !it.label.trim() || !it.labelEs.trim());
    if (blank) { setError(lang === 'es' ? 'Cada punto necesita texto en inglés y español.' : 'Every item needs English and Spanish text.'); return; }
    setSaving(true); setError(null); setNotice(null);
    try {
      const r = await fetchWithAuth('/api/settings/checklists/inspection', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          propertyId: pid,
          checklistId: data?.isOverride ? data.checklistId : null,
          name: name.trim(),
          appliesToCleaningTypes: applies,
          appliesToRoomTypes: [],
          items: items.map((it) => ({
            category: it.category, label: it.label.trim(), labelEs: it.labelEs.trim(),
            severityDefault: it.severityDefault, requiresPhotoOnFail: it.requiresPhotoOnFail,
          })),
        }),
      });
      const body = await r.json().catch(() => null);
      if (!r.ok) { setError(body?.error ?? `Failed (${r.status})`); return; }
      setNotice(lang === 'es' ? 'Guardado.' : 'Saved.');
      await load();
    } catch (e) {
      setError((e as Error)?.message ?? 'Network error');
    } finally {
      setSaving(false);
    }
  }, [pid, data, name, applies, items, lang, load]);

  const reset = useCallback(async () => {
    setConfirmReset(false);
    if (!data?.checklistId) return;
    setSaving(true); setError(null); setNotice(null);
    try {
      const r = await fetchWithAuth(`/api/settings/checklists/inspection?propertyId=${encodeURIComponent(pid)}&checklistId=${encodeURIComponent(data.checklistId)}`, { method: 'DELETE' });
      const body = await r.json().catch(() => null);
      if (!r.ok) { setError(body?.error ?? `Failed (${r.status})`); return; }
      setNotice(lang === 'es' ? 'Restablecido al valor de Staxis.' : 'Reset to the Staxis default.');
      await load();
    } catch (e) {
      setError((e as Error)?.message ?? 'Network error');
    } finally {
      setSaving(false);
    }
  }, [pid, data, lang, load]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <StatusRow lang={lang} isOverride={data?.isOverride ?? false} hasDefault={data?.hasDefault ?? false} />

      {error && <Banner tone="warm">{error}</Banner>}
      {notice && <Banner tone="sage"><Check size={13} /> {notice}</Banner>}

      {loading && items.length === 0 ? (
        <Loading lang={lang} />
      ) : (
        <>
          {/* Name */}
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <Caps>{lang === 'es' ? 'Nombre de la lista' : 'Checklist name'}</Caps>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={lang === 'es' ? 'p. ej. Inspección de salida estándar' : 'e.g. Standard Departure Clean'}
              style={{ ...inputStyle, height: 38, maxWidth: 420 }}
            />
          </label>

          {/* Applies-to cleaning types */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <Caps>{lang === 'es' ? 'Aplica a tipos de limpieza (vacío = todos)' : 'Applies to cleaning types (empty = all)'}</Caps>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {INSPECTION_CLEANING_TYPES.map((ct) => {
                const on = applies.includes(ct);
                return (
                  <button
                    key={ct}
                    onClick={() => setApplies((p) => on ? p.filter((x) => x !== ct) : [...p, ct])}
                    style={{
                      padding: '4px 11px', borderRadius: 999,
                      border: `1px solid ${on ? T.sageDeep : T.rule}`,
                      background: on ? T.sageDim : 'transparent',
                      color: on ? T.sageDeep : T.ink2,
                      fontFamily: fonts.sans, fontSize: 12, fontWeight: 500, cursor: 'pointer',
                    }}
                  >
                    {INSPECTION_CT_LABEL[ct][lang]}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Items header */}
          <div style={{ display: 'grid', gridTemplateColumns: '110px 1fr 1fr 96px 70px 96px', gap: 8, padding: '0 4px', marginTop: 4 }}>
            <Caps>{lang === 'es' ? 'Categoría' : 'Category'}</Caps>
            <Caps>{lang === 'es' ? 'Punto (Inglés)' : 'Item (English)'}</Caps>
            <Caps>{lang === 'es' ? 'Punto (Español)' : 'Item (Spanish)'}</Caps>
            <Caps>{lang === 'es' ? 'Severidad' : 'Severity'}</Caps>
            <Caps>{lang === 'es' ? 'Foto' : 'Photo'}</Caps>
            <Caps>{lang === 'es' ? 'Orden' : 'Order'}</Caps>
          </div>

          {items.length === 0 && (
            <div style={{ fontFamily: fonts.sans, fontSize: 13, color: T.ink3, padding: '12px 4px' }}>
              {lang === 'es' ? 'Sin puntos todavía. Agrega el primero.' : 'No items yet. Add the first one.'}
            </div>
          )}

          {items.map((it, idx) => (
            <div key={it._key} style={{ display: 'grid', gridTemplateColumns: '110px 1fr 1fr 96px 70px 96px', gap: 8, alignItems: 'center' }}>
              <select
                value={it.category}
                onChange={(e) => setItems((p) => p.map((x, i) => i === idx ? { ...x, category: e.target.value as InspectionCategory } : x))}
                aria-label={lang === 'es' ? 'Categoría' : 'Category'}
                style={inputStyle}
              >
                {INSPECTION_CATEGORIES.map((c) => <option key={c} value={c}>{CATEGORY_LABEL[c][lang]}</option>)}
              </select>
              <input
                value={it.label}
                onChange={(e) => setItems((p) => p.map((x, i) => i === idx ? { ...x, label: e.target.value } : x))}
                placeholder={lang === 'es' ? 'p. ej. El baño está impecable' : 'e.g. Bathroom is spotless'}
                aria-label="Item English"
                style={inputStyle}
              />
              <input
                value={it.labelEs}
                onChange={(e) => setItems((p) => p.map((x, i) => i === idx ? { ...x, labelEs: e.target.value } : x))}
                placeholder={lang === 'es' ? 'p. ej. El baño está impecable' : 'p. ej. El baño está impecable'}
                aria-label="Item Spanish"
                style={inputStyle}
              />
              <select
                value={it.severityDefault}
                onChange={(e) => setItems((p) => p.map((x, i) => i === idx ? { ...x, severityDefault: e.target.value as Severity } : x))}
                aria-label={lang === 'es' ? 'Severidad' : 'Severity'}
                style={inputStyle}
              >
                {SEVERITIES.map((s) => <option key={s} value={s}>{SEVERITY_LABEL[s][lang]}</option>)}
              </select>
              <button
                onClick={() => setItems((p) => p.map((x, i) => i === idx ? { ...x, requiresPhotoOnFail: !x.requiresPhotoOnFail } : x))}
                aria-label={lang === 'es' ? 'Requiere foto al fallar' : 'Requires photo on fail'}
                title={lang === 'es' ? 'Requiere foto al fallar' : 'Requires photo on fail'}
                style={{
                  height: 34, borderRadius: 8, cursor: 'pointer',
                  border: `1px solid ${it.requiresPhotoOnFail ? T.sageDeep : T.rule}`,
                  background: it.requiresPhotoOnFail ? T.sageDim : 'transparent',
                  color: it.requiresPhotoOnFail ? T.sageDeep : T.ink3,
                  fontFamily: fonts.sans, fontSize: 11.5, fontWeight: 600,
                }}
              >
                {it.requiresPhotoOnFail ? (lang === 'es' ? 'Sí' : 'Yes') : (lang === 'es' ? 'No' : 'No')}
              </button>
              <RowControls
                idx={idx} count={items.length}
                onUp={() => move(setItems, idx, -1)}
                onDown={() => move(setItems, idx, 1)}
                onDelete={() => setItems((p) => p.filter((_, i) => i !== idx))}
              />
            </div>
          ))}

          <div>
            <Btn variant="ghost" size="sm" onClick={() => setItems((p) => [...p, { category: 'bedroom', label: '', labelEs: '', severityDefault: 'minor', requiresPhotoOnFail: false, _key: nextKey() }])}>
              <Plus size={14} /> {lang === 'es' ? 'Agregar punto' : 'Add item'}
            </Btn>
          </div>
        </>
      )}

      {/* Action bar */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', borderTop: `1px solid ${T.rule}`, paddingTop: 12 }}>
        <Btn variant="primary" size="md" onClick={() => void save()} disabled={saving || loading}>
          <Save size={14} /> {saving ? (lang === 'es' ? 'Guardando…' : 'Saving…') : (lang === 'es' ? 'Guardar' : 'Save')}
        </Btn>
        <Btn
          variant="ghost" size="md"
          onClick={() => setShowCopy(true)}
          disabled={saving || loading || !data?.isOverride}
          title={!data?.isOverride ? (lang === 'es' ? 'Guarda primero para personalizar esta propiedad.' : 'Save first to customize this property.') : undefined}
        >
          <Copy size={14} /> {lang === 'es' ? 'Copiar a otras propiedades' : 'Copy to other properties'}
        </Btn>
        {data?.isOverride && (
          <Btn variant="ghost" size="md" onClick={() => setConfirmReset(true)} disabled={saving || loading}>
            <RotateCcw size={14} /> {lang === 'es' ? 'Restablecer al valor de Staxis' : 'Reset to Staxis default'}
          </Btn>
        )}
      </div>

      {showCopy && data?.checklistId && (
        <CopyModal
          lang={lang}
          pid={pid}
          properties={properties}
          label={name || (lang === 'es' ? 'Inspección' : 'Inspection')}
          onClose={() => setShowCopy(false)}
          buildBody={(targetIds) => ({ sourceType: 'inspection', key: data.checklistId, targetPropertyIds: targetIds })}
        />
      )}
      {confirmReset && (
        <ConfirmModal
          lang={lang}
          title={lang === 'es' ? 'Restablecer al valor de Staxis' : 'Reset to Staxis default'}
          message={lang === 'es'
            ? 'Esto eliminará la lista de inspección personalizada de esta propiedad y volverá al valor predeterminado de Staxis.'
            : 'This deletes this property’s customized inspection checklist and falls back to the Staxis default.'}
          confirmLabel={lang === 'es' ? 'Restablecer' : 'Reset'}
          onConfirm={() => void reset()}
          onCancel={() => setConfirmReset(false)}
        />
      )}
    </div>
  );
}

// ─── Shared pieces ──────────────────────────────────────────────────────────

function StatusRow({ lang, isOverride, hasDefault }: { lang: Lang; isOverride: boolean; hasDefault: boolean }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      {isOverride
        ? <Pill tone="sage"><Check size={12} /> {lang === 'es' ? 'Personalizada para esta propiedad' : 'Customized for this property'}</Pill>
        : <Pill tone="neutral">{lang === 'es' ? 'Usando el valor de Staxis' : 'Using the Staxis default'}</Pill>}
      {!hasDefault && !isOverride && (
        <span style={{ fontFamily: fonts.sans, fontSize: 12, color: T.ink3 }}>
          {lang === 'es' ? 'Aún no hay valor predeterminado — empieza desde cero.' : 'No default yet — start from scratch.'}
        </span>
      )}
    </div>
  );
}

function RowControls({ idx, count, onUp, onDown, onDelete }: {
  idx: number; count: number; onUp: () => void; onDown: () => void; onDelete: () => void;
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 2, justifyContent: 'flex-end' }}>
      <IconBtn onClick={onUp} disabled={idx === 0} label="Move up"><ChevronUp size={15} /></IconBtn>
      <IconBtn onClick={onDown} disabled={idx === count - 1} label="Move down"><ChevronDown size={15} /></IconBtn>
      <IconBtn onClick={onDelete} label="Delete" danger><Trash2 size={14} /></IconBtn>
    </div>
  );
}

function IconBtn({ children, onClick, disabled, label, danger }: {
  children: React.ReactNode; onClick: () => void; disabled?: boolean; label: string; danger?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      style={{
        width: 28, height: 28, borderRadius: 7, border: `1px solid ${T.rule}`,
        background: 'transparent', cursor: disabled ? 'not-allowed' : 'pointer',
        color: disabled ? T.ink3 : danger ? T.red : T.ink2,
        opacity: disabled ? 0.4 : 1,
        display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
      }}
    >
      {children}
    </button>
  );
}

function Banner({ tone, children }: { tone: 'warm' | 'sage'; children: React.ReactNode }) {
  const c = tone === 'warm'
    ? { fg: T.warm, bg: T.warmDim, br: 'rgba(184,92,61,0.25)' }
    : { fg: T.sageDeep, bg: T.sageDim, br: 'rgba(104,131,114,0.25)' };
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 8,
      fontFamily: fonts.sans, fontSize: 13, color: c.fg,
      padding: '8px 12px', border: `1px solid ${c.br}`, background: c.bg, borderRadius: 8,
    }}>
      {children}
    </div>
  );
}

function Loading({ lang }: { lang: Lang }) {
  return (
    <div style={{ fontFamily: fonts.mono, fontSize: 11, color: T.ink3, textTransform: 'uppercase', letterSpacing: '0.04em', padding: '12px 4px' }}>
      {lang === 'es' ? 'Cargando…' : 'Loading…'}
    </div>
  );
}

function move<T>(setter: React.Dispatch<React.SetStateAction<T[]>>, idx: number, delta: number): void {
  setter((prev) => {
    const next = [...prev];
    const target = idx + delta;
    if (target < 0 || target >= next.length) return prev;
    [next[idx], next[target]] = [next[target], next[idx]];
    return next;
  });
}

// ─── Copy-to-properties modal ───────────────────────────────────────────────

type CopyBody =
  | { sourceType: 'cleaning'; key: string; sourcePropertyId: string; targetPropertyIds: string[] }
  | { sourceType: 'inspection'; key: string | null; targetPropertyIds: string[] };

function CopyModal({ lang, pid, properties, label, onClose, buildBody }: {
  lang: Lang;
  pid: string;
  properties: Array<{ id: string; name: string }>;
  label: string;
  onClose: () => void;
  buildBody: (targetIds: string[]) => CopyBody;
}) {
  const others = properties.filter((p) => p.id !== pid);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<number | null>(null);

  const toggle = (id: string) => setSelected((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const run = useCallback(async () => {
    const targetIds = Array.from(selected);
    if (targetIds.length === 0) return;
    setBusy(true); setError(null);
    try {
      const r = await fetchWithAuth('/api/settings/checklists/copy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildBody(targetIds)),
      });
      const body = await r.json().catch(() => null);
      if (!r.ok) { setError(body?.error ?? `Failed (${r.status})`); return; }
      setDone((body?.data?.copied ?? targetIds.length) as number);
    } catch (e) {
      setError((e as Error)?.message ?? 'Network error');
    } finally {
      setBusy(false);
    }
  }, [selected, buildBody]);

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(31,35,28,0.18)', zIndex: 50, display: 'flex', justifyContent: 'center', alignItems: 'flex-start', padding: '8vh 16px' }}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: 'min(460px, 96vw)', maxHeight: '80vh', overflowY: 'auto', background: T.paper, border: `1px solid ${T.rule}`, borderRadius: 16, padding: 20, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <Caps>{lang === 'es' ? 'Copiar a otras propiedades' : 'Copy to other properties'}</Caps>
          <button onClick={onClose} aria-label="Close" style={{ background: 'transparent', border: 'none', cursor: 'pointer' }}><X size={16} color={T.ink2} /></button>
        </div>
        <div style={{ fontFamily: fonts.serif, fontSize: 18, color: T.ink }}>{label}</div>

        {done !== null ? (
          <>
            <Banner tone="sage"><Check size={13} /> {lang === 'es' ? `Copiada a ${done} propiedad(es).` : `Copied to ${done} propert${done === 1 ? 'y' : 'ies'}.`}</Banner>
            <div><Btn variant="ghost" size="sm" onClick={onClose}>{lang === 'es' ? 'Cerrar' : 'Close'}</Btn></div>
          </>
        ) : others.length === 0 ? (
          <>
            <div style={{ fontFamily: fonts.sans, fontSize: 13, color: T.ink2 }}>
              {lang === 'es' ? 'No tienes otras propiedades a las que copiar.' : 'You have no other properties to copy to.'}
            </div>
            <div><Btn variant="ghost" size="sm" onClick={onClose}>{lang === 'es' ? 'Cerrar' : 'Close'}</Btn></div>
          </>
        ) : (
          <>
            <div style={{ fontFamily: fonts.sans, fontSize: 12.5, color: T.ink2 }}>
              {lang === 'es'
                ? `Esto reemplazará la lista “${label}” en las propiedades seleccionadas.`
                : `This will replace the “${label}” checklist on the selected properties.`}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {others.map((p) => {
                const on = selected.has(p.id);
                return (
                  <button
                    key={p.id}
                    onClick={() => toggle(p.id)}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 10, textAlign: 'left',
                      padding: '9px 11px', borderRadius: 9, cursor: 'pointer',
                      border: `1px solid ${on ? T.sageDeep : T.rule}`,
                      background: on ? T.sageDim : 'transparent',
                      fontFamily: fonts.sans, fontSize: 13.5, color: T.ink,
                    }}
                  >
                    <span style={{
                      width: 18, height: 18, borderRadius: 5, flexShrink: 0,
                      border: `1px solid ${on ? T.sageDeep : T.ink3}`,
                      background: on ? T.sageDeep : 'transparent',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                    }}>
                      {on && <Check size={12} color="#fff" />}
                    </span>
                    {p.name}
                  </button>
                );
              })}
            </div>

            {error && <Banner tone="warm">{error}</Banner>}

            <div style={{ fontFamily: fonts.sans, fontSize: 12, color: T.ink3 }}>
              {lang === 'es'
                ? `${selected.size} propiedad(es) seleccionada(s).`
                : `${selected.size} propert${selected.size === 1 ? 'y' : 'ies'} selected.`}
            </div>

            <div style={{ display: 'flex', gap: 8 }}>
              <Btn variant="primary" size="md" onClick={() => void run()} disabled={busy || selected.size === 0}>
                <Copy size={14} /> {busy ? (lang === 'es' ? 'Copiando…' : 'Copying…') : (lang === 'es' ? 'Copiar' : 'Copy')}
              </Btn>
              <Btn variant="ghost" size="md" onClick={onClose} disabled={busy}>{lang === 'es' ? 'Cancelar' : 'Cancel'}</Btn>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ─── Confirm modal ──────────────────────────────────────────────────────────

function ConfirmModal({ lang, title, message, confirmLabel, onConfirm, onCancel }: {
  lang: Lang; title: string; message: string; confirmLabel: string; onConfirm: () => void; onCancel: () => void;
}) {
  return (
    <div onClick={onCancel} style={{ position: 'fixed', inset: 0, background: 'rgba(31,35,28,0.18)', zIndex: 50, display: 'flex', justifyContent: 'center', alignItems: 'center', padding: 16 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: 'min(420px, 96vw)', background: T.paper, border: `1px solid ${T.rule}`, borderRadius: 16, padding: 20, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ fontFamily: fonts.serif, fontSize: 19, color: T.ink }}>{title}</div>
        <div style={{ fontFamily: fonts.sans, fontSize: 13.5, color: T.ink2, lineHeight: 1.45 }}>{message}</div>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <Btn variant="ghost" size="md" onClick={onCancel}>{lang === 'es' ? 'Cancelar' : 'Cancel'}</Btn>
          <Btn variant="primary" size="md" onClick={onConfirm}>{confirmLabel}</Btn>
        </div>
      </div>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  fontFamily: fonts.sans, fontSize: 13, padding: '7px 9px', height: 34,
  border: `1px solid ${T.rule}`, borderRadius: 8, background: T.paper, color: T.ink, width: '100%',
  boxSizing: 'border-box',
};
