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
//
// Saves are bulk-replace: the PUT body carries the FULL item list and the
// server swaps the override wholesale. The shared row-editor chrome lives in
// _components/ChecklistEditor.tsx; this file keeps the two editors' state
// machines, label maps, and payload shapes.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { ChevronLeft, Check, AlertTriangle } from 'lucide-react';

import { AppLayout } from '@/components/layout/AppLayout';
import { useScope } from '@/lib/hooks/use-scope';
import { useProperty } from '@/contexts/PropertyContext';
import { useLang } from '@/contexts/LanguageContext';
import { useCan } from '@/lib/capabilities/useCan';
import { fetchWithAuth } from '@/lib/api-fetch';
import { t } from '@/lib/translations';
import { T, fonts, Btn, Caps } from '@/app/staff/_components/_tokens';
import {
  ChecklistEditor, StatusRow, Banner, Loading, ActionBar, CopyModal, ConfirmModal,
  nextKey, inputStyle, type Lang,
} from './_components/ChecklistEditor';

// ─── Bilingual label maps ───────────────────────────────────────────────────

const CLEANING_TYPES = ['departure', 'stayover', 'deep', 'refresh', 'inspection'] as const;
type CleaningType = (typeof CLEANING_TYPES)[number];
const CLEANING_TYPE_LABEL: Record<CleaningType, { en: string }> = {
  departure: { en: 'Departure', },
  stayover: { en: 'Stayover', },
  deep: { en: 'Deep clean', },
  refresh: { en: 'Refresh', },
  inspection: { en: 'Inspection', },
};

const CLEANING_AREAS = ['bathroom', 'bedroom', 'living', 'kitchen', 'entry', 'amenities', 'final'] as const;
type CleaningArea = (typeof CLEANING_AREAS)[number];
const AREA_LABEL: Record<CleaningArea, { en: string }> = {
  bathroom: { en: 'Bathroom', },
  bedroom: { en: 'Bedroom', },
  living: { en: 'Living', },
  kitchen: { en: 'Kitchen', },
  entry: { en: 'Entry', },
  amenities: { en: 'Amenities', },
  final: { en: 'Final', },
};

const INSPECTION_CATEGORIES = ['bathroom', 'bedroom', 'living', 'kitchen', 'welcome', 'other'] as const;
type InspectionCategory = (typeof INSPECTION_CATEGORIES)[number];
const CATEGORY_LABEL: Record<InspectionCategory, { en: string }> = {
  bathroom: { en: 'Bathroom', },
  bedroom: { en: 'Bedroom', },
  living: { en: 'Living', },
  kitchen: { en: 'Kitchen', },
  welcome: { en: 'Welcome', },
  other: { en: 'Other', },
};

const SEVERITIES = ['minor', 'major', 'critical'] as const;
type Severity = (typeof SEVERITIES)[number];
const SEVERITY_LABEL: Record<Severity, { en: string }> = {
  minor: { en: 'Minor', },
  major: { en: 'Major', },
  critical: { en: 'Critical', },
};

const INSPECTION_CLEANING_TYPES = ['departure', 'departure_deep', 'stayover', 'deep', 'refresh'] as const;
type InspectionCleaningType = (typeof INSPECTION_CLEANING_TYPES)[number];
const INSPECTION_CT_LABEL: Record<InspectionCleaningType, { en: string }> = {
  departure: { en: 'Departure', },
  departure_deep: { en: 'Departure deep', },
  stayover: { en: 'Stayover', },
  deep: { en: 'Deep', },
  refresh: { en: 'Refresh', },
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
  otherCount: number;
  items: Array<InspectionItem & { id: string; orderIndex: number }>;
}

type EditCleaning = CleaningItem & { _key: string };
type EditInspection = InspectionItem & { _key: string };

// ─── Page shell + management gate ───────────────────────────────────────────

export default function ChecklistsPage() {
  const { uid, pid } = useScope();
  const { properties } = useProperty();
  const { lang } = useLang();
  const can = useCan();

  if (!uid) {
    return <AppLayout><div style={{ padding: 24 }}>{'Sign in to continue.'}</div></AppLayout>;
  }
  if (!can('manage_checklists')) {
    return (
      <AppLayout>
        <div style={{ padding: 24, maxWidth: 520, margin: '40px auto', textAlign: 'center' }}>
          <h1 style={{ fontFamily: fonts.serif, fontSize: 24, color: T.ink, marginBottom: 12 }}>
            {'You don’t have access'}
          </h1>
          <p style={{ fontFamily: fonts.sans, fontSize: 14, color: T.ink2, marginBottom: 20 }}>
            {'Checklists are restricted to managers, owners, and admins.'}
          </p>
          <Link href="/settings">
            <Btn variant="ghost"><ChevronLeft size={14} /> {'Back to Settings'}</Btn>
          </Link>
        </div>
      </AppLayout>
    );
  }

  return (
    <AppLayout>
      <ChecklistsBody
        pid={pid ?? ''}
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
          {'Select a property first.'}
        </div>
      </div>
    );
  }

  return (
    <div style={{ padding: '16px 16px 48px', display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 980, margin: '0 auto', width: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <Link href="/settings" style={{ textDecoration: 'none', color: T.ink2 }}>
          <Btn variant="ghost" size="sm"><ChevronLeft size={14} /> {'Settings'}</Btn>
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
          {'Cleaning'}
        </TabBtn>
        <TabBtn active={tab === 'inspection'} onClick={() => setTab('inspection')}>
          {'Inspection'}
        </TabBtn>
      </div>

      {tab === 'cleaning'
        ? <CleaningEditor pid={pid} lang={lang} properties={properties} />
        : <InspectionEditor pid={pid} lang={lang} properties={properties} />}

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

  // Race guard: switching cleaning types refires load() without cancelling
  // the in-flight request, so the OLDER response could land last and render
  // type A's items under the type-B selector — and Save (a bulk-replace)
  // would then overwrite B's checklist with A's items. Each load takes a
  // sequence number; stale responses are dropped. loadedTypeRef records
  // which type the on-screen items actually belong to, and save() refuses
  // to write when it doesn't match the selector.
  const loadSeqRef = useRef(0);
  const loadedTypeRef = useRef<CleaningType | null>(null);

  const load = useCallback(async () => {
    const seq = ++loadSeqRef.current;
    setLoading(true); setError(null); setNotice(null);
    try {
      const r = await fetchWithAuth(`/api/settings/checklists/cleaning?propertyId=${encodeURIComponent(pid)}&cleaningType=${type}`);
      const body = await r.json().catch(() => null);
      if (seq !== loadSeqRef.current) return; // superseded by a newer load
      if (!r.ok) { loadedTypeRef.current = null; setError(body?.error ?? `Failed (${r.status})`); return; }
      const cl = (body?.data?.checklist ?? null) as CleaningChecklist | null;
      loadedTypeRef.current = type;
      setData(cl);
      setItems((cl?.items ?? []).map((it) => ({
        area: it.area, itemEn: it.itemEn, itemEs: it.itemEs, isCritical: it.isCritical, _key: nextKey(),
      })));
    } catch (e) {
      if (seq !== loadSeqRef.current) return;
      loadedTypeRef.current = null;
      setError((e as Error)?.message ?? 'Network error');
    } finally {
      if (seq === loadSeqRef.current) setLoading(false);
    }
  }, [pid, type]);

  useEffect(() => { void load(); }, [load]);

  const save = useCallback(async () => {
    // Bulk-replace safety: never write items that belong to another cleaning
    // type (or to a failed load) under the currently selected one.
    if (loadedTypeRef.current !== type) {
      setError('This checklist didn’t finish loading. Refresh the page before saving.');
      return;
    }
    const blank = items.find((it) => !it.itemEn.trim());
    if (blank) { setError('Every item needs text.'); return; }
    setSaving(true); setError(null); setNotice(null);
    try {
      const r = await fetchWithAuth('/api/settings/checklists/cleaning', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          propertyId: pid,
          cleaningType: type,
          // itemEs is a required legacy database/API field. Preserve existing
          // content exactly; new rows use the English label at that contract
          // seam without exposing a second UI-copy field.
          items: items.map((it) => ({
            area: it.area,
            itemEn: it.itemEn.trim(),
            itemEs: it.itemEs || it.itemEn.trim(),
            isCritical: it.isCritical,
          })),
        }),
      });
      const body = await r.json().catch(() => null);
      if (!r.ok) { setError(body?.error ?? `Failed (${r.status})`); return; }
      setNotice('Saved.');
      await load();
    } catch (e) {
      setError((e as Error)?.message ?? 'Network error');
    } finally {
      setSaving(false);
    }
  }, [pid, type, items, load]);

  const reset = useCallback(async () => {
    setConfirmReset(false);
    setSaving(true); setError(null); setNotice(null);
    try {
      const r = await fetchWithAuth(`/api/settings/checklists/cleaning?propertyId=${encodeURIComponent(pid)}&cleaningType=${type}`, { method: 'DELETE' });
      const body = await r.json().catch(() => null);
      if (!r.ok) { setError(body?.error ?? `Failed (${r.status})`); return; }
      setNotice('Reset to the Staxis default.');
      await load();
    } catch (e) {
      setError((e as Error)?.message ?? 'Network error');
    } finally {
      setSaving(false);
    }
  }, [pid, type, load]);

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
            {CLEANING_TYPE_LABEL[ct]['en']}
          </button>
        ))}
      </div>

      <StatusRow
        lang={lang}
        isOverride={data?.isOverride ?? false}
      />

      {error && <Banner tone="warm">{error}</Banner>}
      {notice && <Banner tone="sage"><Check size={13} /> {notice}</Banner>}

      {loading && items.length === 0 ? (
        <Loading lang={lang} />
      ) : (
        <ChecklistEditor<EditCleaning>
          grid="120px 1fr 78px 96px"
          gap={8}
          headers={[
            'Area',
            'Item',
            'Critical',
            'Order',
          ]}
          emptyText={'No items yet. Add the first one.'}
          addLabel={'Add item'}
          items={items}
          setItems={setItems}
          newItem={() => ({ area: 'bedroom', itemEn: '', itemEs: '', isCritical: false, _key: nextKey() })}
          renderCells={(it, update) => (
            <>
              <select
                value={it.area}
                onChange={(e) => update({ area: e.target.value as CleaningArea })}
                aria-label={'Area'}
                style={inputStyle}
              >
                {CLEANING_AREAS.map((a) => <option key={a} value={a}>{AREA_LABEL[a]['en']}</option>)}
              </select>
              <input
                value={it.itemEn}
                onChange={(e) => update({ itemEn: e.target.value })}
                placeholder={'e.g. Clean toilet'}
                aria-label="Item English"
                style={inputStyle}
              />
              <button
                onClick={() => update({ isCritical: !it.isCritical })}
                aria-label={'Toggle critical'}
                title={'Critical item'}
                style={{
                  height: 34, borderRadius: 8, cursor: 'pointer',
                  border: `1px solid ${it.isCritical ? 'rgba(160,74,44,0.4)' : T.rule}`,
                  background: it.isCritical ? T.redDim : 'transparent',
                  color: it.isCritical ? T.red : T.ink3,
                  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4,
                  fontFamily: fonts.sans, fontSize: 11.5, fontWeight: 600,
                }}
              >
                <AlertTriangle size={13} /> {it.isCritical ? ('Yes') : ('No')}
              </button>
            </>
          )}
        />
      )}

      <ActionBar
        lang={lang}
        saving={saving}
        loading={loading}
        isOverride={data?.isOverride ?? false}
        copyLockedTitle={'Customize and save first to copy.'}
        onSave={() => void save()}
        onCopy={() => setShowCopy(true)}
        onDelete={() => setConfirmReset(true)}
      />

      {showCopy && data?.isOverride && (
        <CopyModal
          lang={lang}
          pid={pid}
          properties={properties}
          label={CLEANING_TYPE_LABEL[type]['en']}
          onClose={() => setShowCopy(false)}
          buildBody={(targetIds) => ({ sourceType: 'cleaning', key: type, sourcePropertyId: pid, targetPropertyIds: targetIds })}
        />
      )}
      {confirmReset && (
        <ConfirmModal
          lang={lang}
          title={'Delete this checklist'}
          message={`This permanently deletes the “${CLEANING_TYPE_LABEL[type].en}” checklist for this property. It will be empty until you build a new one from scratch.`}
          confirmLabel={'Delete'}
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

  // Same race/failed-load guards as CleaningEditor: drop stale responses and
  // refuse the bulk-replace save until a load has actually succeeded.
  const loadSeqRef = useRef(0);
  const loadedRef = useRef(false);

  const load = useCallback(async () => {
    const seq = ++loadSeqRef.current;
    setLoading(true); setError(null); setNotice(null);
    try {
      const r = await fetchWithAuth(`/api/settings/checklists/inspection?propertyId=${encodeURIComponent(pid)}`);
      const body = await r.json().catch(() => null);
      if (seq !== loadSeqRef.current) return; // superseded by a newer load
      if (!r.ok) { loadedRef.current = false; setError(body?.error ?? `Failed (${r.status})`); return; }
      const cl = (body?.data?.checklist ?? null) as InspectionChecklist | null;
      loadedRef.current = true;
      setData(cl);
      setName(cl?.name ?? '');
      setApplies(cl?.appliesToCleaningTypes ?? []);
      setItems((cl?.items ?? []).map((it) => ({
        category: it.category, label: it.label, labelEs: it.labelEs,
        severityDefault: it.severityDefault, requiresPhotoOnFail: it.requiresPhotoOnFail, _key: nextKey(),
      })));
    } catch (e) {
      if (seq !== loadSeqRef.current) return;
      loadedRef.current = false;
      setError((e as Error)?.message ?? 'Network error');
    } finally {
      if (seq === loadSeqRef.current) setLoading(false);
    }
  }, [pid]);

  useEffect(() => { void load(); }, [load]);

  const save = useCallback(async () => {
    if (!loadedRef.current) {
      setError('This checklist didn’t finish loading. Refresh the page before saving.');
      return;
    }
    if (!name.trim()) { setError('The checklist needs a name.'); return; }
    const blank = items.find((it) => !it.label.trim());
    if (blank) { setError('Every item needs text.'); return; }
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
            category: it.category,
            label: it.label.trim(),
            // Preserve the required legacy contract field without maintaining
            // a second presentation string in the editor.
            labelEs: it.labelEs || it.label.trim(),
            severityDefault: it.severityDefault, requiresPhotoOnFail: it.requiresPhotoOnFail,
          })),
        }),
      });
      const body = await r.json().catch(() => null);
      if (!r.ok) { setError(body?.error ?? `Failed (${r.status})`); return; }
      setNotice('Saved.');
      await load();
    } catch (e) {
      setError((e as Error)?.message ?? 'Network error');
    } finally {
      setSaving(false);
    }
  }, [pid, data, name, applies, items, load]);

  const reset = useCallback(async () => {
    setConfirmReset(false);
    if (!data?.checklistId) return;
    setSaving(true); setError(null); setNotice(null);
    try {
      const r = await fetchWithAuth(`/api/settings/checklists/inspection?propertyId=${encodeURIComponent(pid)}&checklistId=${encodeURIComponent(data.checklistId)}`, { method: 'DELETE' });
      const body = await r.json().catch(() => null);
      if (!r.ok) { setError(body?.error ?? `Failed (${r.status})`); return; }
      setNotice('Reset to the Staxis default.');
      await load();
    } catch (e) {
      setError((e as Error)?.message ?? 'Network error');
    } finally {
      setSaving(false);
    }
  }, [pid, data, load]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <StatusRow lang={lang} isOverride={data?.isOverride ?? false} />

      {(data?.otherCount ?? 0) > 0 && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', fontFamily: fonts.sans, fontSize: 12.5, color: T.caramelDeep, background: 'rgba(215,176,126,0.14)', border: '1px solid rgba(140,106,51,0.25)', borderRadius: 8, padding: '8px 12px' }}>
          <AlertTriangle size={13} style={{ flexShrink: 0 }} />
          {`This property has ${(data?.otherCount ?? 0) + 1} inspection checklists. You’re editing the most recent; the others stay active for inspections.`}
        </div>
      )}

      {error && <Banner tone="warm">{error}</Banner>}
      {notice && <Banner tone="sage"><Check size={13} /> {notice}</Banner>}

      {loading && items.length === 0 ? (
        <Loading lang={lang} />
      ) : (
        <>
          {/* Name */}
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <Caps>{'Checklist name'}</Caps>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={'e.g. Standard Departure Clean'}
              style={{ ...inputStyle, height: 38, maxWidth: 420 }}
            />
          </label>

          {/* Applies-to cleaning types */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <Caps>{'Applies to cleaning types (empty = all)'}</Caps>
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
                    {INSPECTION_CT_LABEL[ct]['en']}
                  </button>
                );
              })}
            </div>
          </div>

          <ChecklistEditor<EditInspection>
            grid="110px 1fr 96px 70px 96px"
            gap={14}
            headerStyle={{ marginTop: 4 }}
            headers={[
              'Category',
              'Item',
              'Severity',
              'Photo',
              'Order',
            ]}
            emptyText={'No items yet. Add the first one.'}
            addLabel={'Add item'}
            items={items}
            setItems={setItems}
            newItem={() => ({ category: 'bedroom', label: '', labelEs: '', severityDefault: 'minor', requiresPhotoOnFail: false, _key: nextKey() })}
            renderCells={(it, update) => (
              <>
                <select
                  value={it.category}
                  onChange={(e) => update({ category: e.target.value as InspectionCategory })}
                  aria-label={'Category'}
                  style={inputStyle}
                >
                  {INSPECTION_CATEGORIES.map((c) => <option key={c} value={c}>{CATEGORY_LABEL[c]['en']}</option>)}
                </select>
                <input
                  value={it.label}
                  onChange={(e) => update({ label: e.target.value })}
                  placeholder={'e.g. Bathroom is spotless'}
                  aria-label="Item English"
                  style={inputStyle}
                />
                <select
                  value={it.severityDefault}
                  onChange={(e) => update({ severityDefault: e.target.value as Severity })}
                  aria-label={'Severity'}
                  style={inputStyle}
                >
                  {SEVERITIES.map((s) => <option key={s} value={s}>{SEVERITY_LABEL[s]['en']}</option>)}
                </select>
                <button
                  onClick={() => update({ requiresPhotoOnFail: !it.requiresPhotoOnFail })}
                  aria-label={'Requires photo on fail'}
                  title={'Requires photo on fail'}
                  style={{
                    height: 34, borderRadius: 8, cursor: 'pointer',
                    border: `1px solid ${it.requiresPhotoOnFail ? T.sageDeep : T.rule}`,
                    background: it.requiresPhotoOnFail ? T.sageDim : 'transparent',
                    color: it.requiresPhotoOnFail ? T.sageDeep : T.ink3,
                    fontFamily: fonts.sans, fontSize: 11.5, fontWeight: 600,
                  }}
                >
                  {it.requiresPhotoOnFail ? ('Yes') : ('No')}
                </button>
              </>
            )}
          />
        </>
      )}

      <ActionBar
        lang={lang}
        saving={saving}
        loading={loading}
        isOverride={data?.isOverride ?? false}
        copyLockedTitle={'Save first to customize this property.'}
        onSave={() => void save()}
        onCopy={() => setShowCopy(true)}
        onDelete={() => setConfirmReset(true)}
      />

      {showCopy && data?.checklistId && (
        <CopyModal
          lang={lang}
          pid={pid}
          properties={properties}
          label={name || ('Inspection')}
          onClose={() => setShowCopy(false)}
          buildBody={(targetIds) => ({ sourceType: 'inspection', key: data.checklistId, targetPropertyIds: targetIds })}
        />
      )}
      {confirmReset && (
        <ConfirmModal
          lang={lang}
          title={'Delete this checklist'}
          message={'This permanently deletes this property’s inspection checklist. It will be empty until you build a new one from scratch.'}
          confirmLabel={'Delete'}
          onConfirm={() => void reset()}
          onCancel={() => setConfirmReset(false)}
        />
      )}
    </div>
  );
}
