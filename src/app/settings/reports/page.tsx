'use client';

export const dynamic = 'force-dynamic';

// Settings → Reports.
// A self-serve report hub: browse a catalog of reports built on data we
// already have, run any on demand over a date range, export it (CSV / Excel),
// favorite it, and schedule it to auto-email. Mirrors the activity-log page:
// same manager/owner/admin gate, same AppLayout shell, same fetchWithAuth +
// /api routes (everything reads/writes through /api/settings/reports/* with
// service-role on the server — never the browser client).

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  Calendar, ChevronLeft, Clock, Download, Mail, Play, Plus, Sparkles, Star, Trash2, X,
} from 'lucide-react';

import { AppLayout } from '@/components/layout/AppLayout';
import { useScope } from '@/lib/hooks/use-scope';
import { useLang } from '@/contexts/LanguageContext';
import { useCan } from '@/lib/capabilities/useCan';
import { fetchWithAuth } from '@/lib/api-fetch';
import { exportBlob, filenameFromDisposition } from '@/lib/export-blob';
import { T, fonts, Btn, Caps } from '@/app/staff/_components/_tokens';
import { formatCell } from '@/lib/reports/catalog/format';
import type { Bilingual, ColumnKind, ReportCategory } from '@/lib/reports/catalog/types';

type Lang = 'en' | 'es';

interface CatalogEntry {
  key: string;
  title: Bilingual;
  description: Bilingual;
  category: ReportCategory;
  defaultRange: 'last7' | 'last30' | 'mtd';
}
interface ReportColumnDTO { key: string; label: Bilingual; kind?: ColumnKind; align?: 'left' | 'right'; }
interface ReportStatDTO { label: Bilingual; value: string; }
interface RunResult {
  key: string;
  title: Bilingual;
  description: Bilingual;
  columns: ReportColumnDTO[];
  rows: Array<Record<string, string | number | null>>;
  stats: ReportStatDTO[];
  notes: Bilingual | null;
  aiSummary: string | null;
}
interface ScheduleDTO {
  id: string;
  reportKey: string;
  cadence: 'daily' | 'weekly' | 'monthly';
  hourLocal: number;
  dayOfWeek: number | null;
  dayOfMonth: number | null;
  rangeKind: 'last7' | 'last30' | 'mtd' | 'prev_month';
  recipients: string[];
  enabled: boolean;
  lastRunDate: string | null;
  lastRunStatus: string | null;
}

const CATEGORY_LABEL: Record<ReportCategory, Bilingual> = {
  housekeeping: { en: 'Housekeeping', es: 'Limpieza' },
  inspections: { en: 'Inspections', es: 'Inspecciones' },
  maintenance: { en: 'Maintenance', es: 'Mantenimiento' },
  inventory: { en: 'Inventory', es: 'Inventario' },
  occupancy: { en: 'Occupancy', es: 'Ocupación' },
  activity: { en: 'Activity', es: 'Actividad' },
  compliance: { en: 'Compliance', es: 'Cumplimiento' },
  lost_found: { en: 'Lost & Found', es: 'Objetos perdidos' },
};

const CATEGORY_ORDER: ReportCategory[] = [
  'housekeeping', 'inspections', 'maintenance', 'inventory', 'occupancy', 'activity', 'compliance', 'lost_found',
];

type RangeKey = 'last7' | 'last30' | 'mtd' | 'custom';

function ymd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function rangeFor(key: RangeKey, customFrom?: string, customTo?: string): { from: string; to: string } {
  const today = new Date();
  const to = ymd(today);
  if (key === 'custom') {
    return { from: customFrom || ymd(new Date(today.getTime() - 6 * 86400000)), to: customTo || to };
  }
  if (key === 'mtd') {
    return { from: ymd(new Date(today.getFullYear(), today.getMonth(), 1)), to };
  }
  const days = key === 'last30' ? 29 : 6;
  return { from: ymd(new Date(today.getTime() - days * 86400000)), to };
}

export default function ReportsPage() {
  const { uid, pid } = useScope();
  const { lang } = useLang();
  const can = useCan();

  if (!uid) {
    return <AppLayout><div style={{ padding: 24 }}>Sign in to continue.</div></AppLayout>;
  }
  if (!can('run_reports')) {
    return (
      <AppLayout>
        <div style={{ padding: 24, maxWidth: 520, margin: '40px auto', textAlign: 'center' }}>
          <h1 style={{ fontFamily: fonts.serif, fontSize: 24, color: T.ink, marginBottom: 12 }}>
            {lang === 'es' ? 'Acceso restringido' : 'You don’t have access'}
          </h1>
          <p style={{ fontFamily: fonts.sans, fontSize: 14, color: T.ink2, marginBottom: 20 }}>
            {lang === 'es'
              ? 'Los reportes solo están disponibles para gerentes, propietarios y administradores.'
              : 'Reports are restricted to managers, owners, and admins.'}
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
      <ReportsBody pid={pid ?? ''} lang={lang} />
    </AppLayout>
  );
}

function ReportsBody({ pid, lang }: { pid: string; lang: Lang }) {
  const [catalog, setCatalog] = useState<CatalogEntry[]>([]);
  const [favorites, setFavorites] = useState<Set<string>>(new Set());
  const [schedules, setSchedules] = useState<ScheduleDTO[]>([]);
  const [loadingCatalog, setLoadingCatalog] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<CatalogEntry | null>(null);

  const loadCatalog = useCallback(async () => {
    if (!pid) return;
    setLoadingCatalog(true);
    setError(null);
    try {
      const r = await fetchWithAuth(`/api/settings/reports/catalog?propertyId=${encodeURIComponent(pid)}`);
      const body = await r.json().catch(() => null);
      if (!r.ok) { setError(body?.error ?? `Failed (${r.status})`); return; }
      const data = body?.data ?? body;
      setCatalog(data?.catalog ?? []);
      setFavorites(new Set<string>(data?.favorites ?? []));
      setSchedules(data?.schedules ?? []);
    } catch (e) {
      setError((e as Error)?.message ?? 'Network error');
    } finally {
      setLoadingCatalog(false);
    }
  }, [pid]);

  useEffect(() => { void loadCatalog(); }, [loadCatalog]);

  const toggleFavorite = useCallback(async (key: string) => {
    // optimistic
    setFavorites((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
    try {
      const r = await fetchWithAuth('/api/settings/reports/favorite', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ propertyId: pid, reportKey: key }),
      });
      if (!r.ok) await loadCatalog(); // revert on failure
    } catch {
      await loadCatalog();
    }
  }, [pid, loadCatalog]);

  if (selected) {
    return (
      <ReportRunner
        pid={pid}
        lang={lang}
        entry={selected}
        favorited={favorites.has(selected.key)}
        schedules={schedules.filter((s) => s.reportKey === selected.key)}
        onToggleFavorite={() => toggleFavorite(selected.key)}
        onSchedulesChanged={loadCatalog}
        onBack={() => setSelected(null)}
      />
    );
  }

  // Library view — favorites pinned, then grouped by category.
  const favs = catalog.filter((c) => favorites.has(c.key));
  const grouped = CATEGORY_ORDER
    .map((cat) => ({ cat, items: catalog.filter((c) => c.category === cat) }))
    .filter((g) => g.items.length > 0);

  return (
    <div style={{ padding: '16px 16px 40px', display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 1100, margin: '0 auto', width: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <Link href="/settings" style={{ textDecoration: 'none', color: T.ink2 }}>
          <Btn variant="ghost" size="sm"><ChevronLeft size={14} /> {lang === 'es' ? 'Ajustes' : 'Settings'}</Btn>
        </Link>
        <h1 style={{ fontFamily: fonts.serif, fontSize: 26, lineHeight: 1.1, color: T.ink, margin: 0, letterSpacing: '-0.01em' }}>
          {lang === 'es' ? 'Reportes' : 'Reports'}
        </h1>
      </div>
      <p style={{ fontFamily: fonts.sans, fontSize: 14, color: T.ink2, margin: 0, maxWidth: 640 }}>
        {lang === 'es'
          ? 'Genera cualquier reporte cuando lo necesites, expórtalo, márcalo como favorito o prográmalo para enviarse por correo.'
          : 'Run any report on demand, export it, star your favorites, or schedule it to auto-email.'}
      </p>

      {error && (
        <div style={{ fontFamily: fonts.sans, fontSize: 13, color: T.warm, padding: '8px 12px', border: `1px solid ${T.warmDim}`, background: T.warmDim, borderRadius: 8 }}>{error}</div>
      )}

      {loadingCatalog && catalog.length === 0 && (
        <div style={{ fontFamily: fonts.mono, fontSize: 11, color: T.ink3, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
          {lang === 'es' ? 'Cargando…' : 'Loading…'}
        </div>
      )}

      {favs.length > 0 && (
        <Section title={lang === 'es' ? '★ Favoritos' : '★ Favorites'}>
          <CardGrid>
            {favs.map((c) => (
              <ReportCard key={c.key} entry={c} lang={lang} favorited onOpen={() => setSelected(c)} onStar={() => toggleFavorite(c.key)} />
            ))}
          </CardGrid>
        </Section>
      )}

      {grouped.map((g) => (
        <Section key={g.cat} title={CATEGORY_LABEL[g.cat][lang]}>
          <CardGrid>
            {g.items.map((c) => (
              <ReportCard key={c.key} entry={c} lang={lang} favorited={favorites.has(c.key)} onOpen={() => setSelected(c)} onStar={() => toggleFavorite(c.key)} />
            ))}
          </CardGrid>
        </Section>
      ))}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <Caps>{title}</Caps>
      {children}
    </div>
  );
}
function CardGrid({ children }: { children: React.ReactNode }) {
  return <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 10 }}>{children}</div>;
}

function ReportCard({ entry, lang, favorited, onOpen, onStar }: {
  entry: CatalogEntry; lang: Lang; favorited: boolean; onOpen: () => void; onStar: () => void;
}) {
  return (
    <div style={{ border: `1px solid ${T.rule}`, borderRadius: 12, padding: 14, background: T.paper, display: 'flex', flexDirection: 'column', gap: 8, minHeight: 120 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 }}>
        <h3 style={{ fontFamily: fonts.serif, fontSize: 17, color: T.ink, margin: 0, lineHeight: 1.2 }}>{entry.title[lang]}</h3>
        <button
          onClick={onStar}
          aria-label={favorited ? 'Unfavorite' : 'Favorite'}
          style={{ border: 'none', background: 'transparent', cursor: 'pointer', padding: 2, color: favorited ? T.caramel : T.ink3 }}
        >
          <Star size={16} fill={favorited ? T.caramel : 'none'} />
        </button>
      </div>
      <p style={{ fontFamily: fonts.sans, fontSize: 12.5, color: T.ink2, margin: 0, flex: 1, lineHeight: 1.4 }}>{entry.description[lang]}</p>
      <div>
        <Btn variant="ghost" size="sm" onClick={onOpen}><Play size={13} /> {lang === 'es' ? 'Abrir' : 'Open'}</Btn>
      </div>
    </div>
  );
}

function ReportRunner({ pid, lang, entry, favorited, schedules, onToggleFavorite, onSchedulesChanged, onBack }: {
  pid: string; lang: Lang; entry: CatalogEntry; favorited: boolean; schedules: ScheduleDTO[];
  onToggleFavorite: () => void; onSchedulesChanged: () => void; onBack: () => void;
}) {
  const [rangeKey, setRangeKey] = useState<RangeKey>(entry.defaultRange);
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [result, setResult] = useState<RunResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showSchedule, setShowSchedule] = useState(false);

  const bounds = useMemo(() => rangeFor(rangeKey, customFrom, customTo), [rangeKey, customFrom, customTo]);

  const run = useCallback(async () => {
    if (!pid) return;
    setLoading(true); setError(null);
    try {
      const p = new URLSearchParams({ reportKey: entry.key, propertyId: pid, from: bounds.from, to: bounds.to, lang, summary: '1' });
      const r = await fetchWithAuth(`/api/settings/reports/run?${p.toString()}`);
      const body = await r.json().catch(() => null);
      if (!r.ok) { setError(body?.error ?? `Failed (${r.status})`); setResult(null); return; }
      setResult((body?.data ?? body) as RunResult);
    } catch (e) {
      setError((e as Error)?.message ?? 'Network error');
    } finally {
      setLoading(false);
    }
  }, [pid, entry.key, bounds.from, bounds.to, lang]);

  // Auto-run on open + whenever the range changes.
  useEffect(() => { void run(); }, [run]);

  const handleExport = useCallback(async (format: 'csv' | 'xlsx') => {
    if (!pid) return;
    try {
      const p = new URLSearchParams({ reportKey: entry.key, propertyId: pid, from: bounds.from, to: bounds.to, lang, format });
      const r = await fetchWithAuth(`/api/settings/reports/export?${p.toString()}`);
      if (!r.ok) { const b = await r.json().catch(() => null); setError(b?.error ?? `Export failed (${r.status})`); return; }
      const fallback = `${entry.key}.${format === 'xlsx' ? 'xls' : 'csv'}`;
      exportBlob(
        filenameFromDisposition(r.headers.get('Content-Disposition')) ?? fallback,
        await r.blob(),
      );
    } catch (e) {
      setError((e as Error)?.message ?? 'Export failed');
    }
  }, [pid, entry.key, bounds.from, bounds.to, lang]);

  return (
    <div style={{ padding: '16px 16px 40px', display: 'flex', flexDirection: 'column', gap: 14, maxWidth: 1100, margin: '0 auto', width: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Btn variant="ghost" size="sm" onClick={onBack}><ChevronLeft size={14} /> {lang === 'es' ? 'Reportes' : 'Reports'}</Btn>
          <h1 style={{ fontFamily: fonts.serif, fontSize: 24, color: T.ink, margin: 0, letterSpacing: '-0.01em' }}>{entry.title[lang]}</h1>
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <Btn variant="ghost" size="sm" onClick={onToggleFavorite}>
            <Star size={14} fill={favorited ? T.caramel : 'none'} /> {favorited ? (lang === 'es' ? 'Favorito' : 'Favorited') : (lang === 'es' ? 'Favorito' : 'Favorite')}
          </Btn>
          <Btn variant="ghost" size="sm" onClick={() => handleExport('csv')}><Download size={14} /> CSV</Btn>
          <Btn variant="ghost" size="sm" onClick={() => handleExport('xlsx')}><Download size={14} /> Excel</Btn>
          <Btn variant="ghost" size="sm" onClick={() => setShowSchedule(true)}><Calendar size={14} /> {lang === 'es' ? 'Programar' : 'Schedule'}</Btn>
        </div>
      </div>

      <p style={{ fontFamily: fonts.sans, fontSize: 13.5, color: T.ink2, margin: 0, maxWidth: 680 }}>{entry.description[lang]}</p>

      {/* Date range */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        {(['last7', 'last30', 'mtd', 'custom'] as const).map((k) => (
          <button
            key={k}
            onClick={() => setRangeKey(k)}
            style={{
              padding: '4px 10px', borderRadius: 999,
              border: `1px solid ${rangeKey === k ? T.ink : T.rule}`,
              background: rangeKey === k ? T.ink : 'transparent',
              color: rangeKey === k ? T.bg : T.ink2,
              fontFamily: fonts.sans, fontSize: 12, fontWeight: 500, cursor: 'pointer',
            }}
          >
            {rangeLabel(k, lang)}
          </button>
        ))}
        {rangeKey === 'custom' && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <input type="date" value={customFrom} onChange={(e) => setCustomFrom(e.target.value)} style={dateInputStyle} />
            <span style={{ color: T.ink3, fontSize: 12 }}>—</span>
            <input type="date" value={customTo} onChange={(e) => setCustomTo(e.target.value)} style={dateInputStyle} />
          </div>
        )}
        <Btn variant="ghost" size="sm" onClick={() => void run()}><Play size={13} /> {lang === 'es' ? 'Actualizar' : 'Run'}</Btn>
      </div>

      {error && (
        <div style={{ fontFamily: fonts.sans, fontSize: 13, color: T.warm, padding: '8px 12px', border: `1px solid ${T.warmDim}`, background: T.warmDim, borderRadius: 8 }}>{error}</div>
      )}

      {/* AI summary */}
      {result?.aiSummary && (
        <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: '12px 14px', background: T.sageDim, borderLeft: `3px solid ${T.sageDeep}`, borderRadius: 8 }}>
          <Sparkles size={16} color={T.sageDeep} style={{ marginTop: 2, flexShrink: 0 }} />
          <div style={{ fontFamily: fonts.serif, fontSize: 15, color: T.ink, lineHeight: 1.4 }}>{result.aiSummary}</div>
        </div>
      )}

      {/* Stats */}
      {result && result.stats.length > 0 && (
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          {result.stats.map((s, i) => (
            <div key={i} style={{ border: `1px solid ${T.rule}`, borderRadius: 10, padding: '8px 14px', background: T.paper, minWidth: 120 }}>
              <Caps>{s.label[lang]}</Caps>
              <div style={{ fontFamily: fonts.serif, fontSize: 22, color: T.ink, marginTop: 2 }}>{s.value}</div>
            </div>
          ))}
        </div>
      )}

      {loading && (
        <div style={{ fontFamily: fonts.mono, fontSize: 11, color: T.ink3, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
          {lang === 'es' ? 'Ejecutando…' : 'Running…'}
        </div>
      )}

      {/* Table */}
      {result && <ResultTable result={result} lang={lang} />}

      {result?.notes && (
        <div style={{ fontFamily: fonts.sans, fontSize: 12, color: T.ink3 }}>{result.notes[lang]}</div>
      )}

      {showSchedule && (
        <ScheduleModal
          pid={pid}
          lang={lang}
          reportKey={entry.key}
          reportTitle={entry.title[lang]}
          existing={schedules}
          onClose={() => setShowSchedule(false)}
          onChanged={onSchedulesChanged}
        />
      )}
    </div>
  );
}

function ResultTable({ result, lang }: { result: RunResult; lang: Lang }) {
  const cols = result.columns;
  const grid = cols.map((c) => (c.align === 'right' ? 'minmax(80px,auto)' : 'minmax(120px,1fr)')).join(' ');
  return (
    <div style={{ border: `1px solid ${T.rule}`, borderRadius: 12, overflow: 'auto', background: T.paper }}>
      <div style={{ display: 'grid', gridTemplateColumns: grid, gap: 10, padding: '10px 14px', borderBottom: `1px solid ${T.rule}`, minWidth: 'fit-content' }}>
        {cols.map((c) => (
          <div key={c.key} style={{ textAlign: c.align ?? 'left' }}><Caps>{c.label[lang]}</Caps></div>
        ))}
      </div>
      {result.rows.length === 0 && (
        <div style={{ padding: '20px 14px', color: T.ink3, fontFamily: fonts.sans, fontSize: 13 }}>
          {lang === 'es' ? 'No hay datos en este intervalo.' : 'No data in this range.'}
        </div>
      )}
      {result.rows.map((row, i) => (
        <div key={i} style={{ display: 'grid', gridTemplateColumns: grid, gap: 10, padding: '8px 14px', borderBottom: `1px solid ${T.ruleSoft}`, fontFamily: fonts.sans, fontSize: 13, color: T.ink, minWidth: 'fit-content' }}>
          {cols.map((c) => (
            <div key={c.key} style={{ textAlign: c.align ?? 'left', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {formatCell(row[c.key], c.kind, lang)}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

function ScheduleModal({ pid, lang, reportKey, reportTitle, existing, onClose, onChanged }: {
  pid: string; lang: Lang; reportKey: string; reportTitle: string; existing: ScheduleDTO[];
  onClose: () => void; onChanged: () => void;
}) {
  const [cadence, setCadence] = useState<'daily' | 'weekly' | 'monthly'>('weekly');
  const [hourLocal, setHourLocal] = useState(8);
  const [dayOfWeek, setDayOfWeek] = useState(1);
  const [dayOfMonth, setDayOfMonth] = useState(1);
  const [rangeKind, setRangeKind] = useState<'last7' | 'last30' | 'mtd' | 'prev_month'>('last7');
  const [recipients, setRecipients] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = useCallback(async () => {
    setSaving(true); setError(null);
    const emails = recipients.split(/[,\s;]+/).map((e) => e.trim()).filter(Boolean);
    try {
      const r = await fetchWithAuth('/api/settings/reports/schedules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          propertyId: pid, reportKey, cadence, hourLocal,
          dayOfWeek: cadence === 'weekly' ? dayOfWeek : null,
          dayOfMonth: cadence === 'monthly' ? dayOfMonth : null,
          rangeKind, recipients: emails, enabled: true,
        }),
      });
      const body = await r.json().catch(() => null);
      if (!r.ok) { setError(body?.error ?? `Failed (${r.status})`); return; }
      setRecipients('');
      onChanged();
    } catch (e) {
      setError((e as Error)?.message ?? 'Failed to save');
    } finally {
      setSaving(false);
    }
  }, [pid, reportKey, cadence, hourLocal, dayOfWeek, dayOfMonth, rangeKind, recipients, onChanged]);

  const remove = useCallback(async (id: string) => {
    try {
      const r = await fetchWithAuth(`/api/settings/reports/schedules?id=${encodeURIComponent(id)}&propertyId=${encodeURIComponent(pid)}`, { method: 'DELETE' });
      if (r.ok) onChanged();
    } catch { /* ignore */ }
  }, [pid, onChanged]);

  const DOW = lang === 'es'
    ? ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb']
    : ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(31,35,28,0.18)', zIndex: 50, display: 'flex', justifyContent: 'flex-end' }}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: 'min(460px, 96vw)', height: '100vh', overflowY: 'auto', background: T.paper, borderLeft: `1px solid ${T.rule}`, padding: 20, display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <Caps>{lang === 'es' ? 'Programar reporte' : 'Schedule report'}</Caps>
          <button onClick={onClose} style={{ background: 'transparent', border: 'none', cursor: 'pointer' }}><X size={16} color={T.ink2} /></button>
        </div>
        <div style={{ fontFamily: fonts.serif, fontSize: 19, color: T.ink }}>{reportTitle}</div>

        {existing.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <Caps>{lang === 'es' ? 'Programaciones activas' : 'Active schedules'}</Caps>
            {existing.map((s) => (
              <div key={s.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, border: `1px solid ${T.rule}`, borderRadius: 8, padding: '8px 10px' }}>
                <div style={{ fontFamily: fonts.sans, fontSize: 12.5, color: T.ink2 }}>
                  <span style={{ color: T.ink }}>{cadenceLabel(s.cadence, lang)}</span>
                  {' · '}{String(s.hourLocal).padStart(2, '0')}:00
                  {s.cadence === 'weekly' && s.dayOfWeek != null ? ` · ${DOW[s.dayOfWeek]}` : ''}
                  {s.cadence === 'monthly' && s.dayOfMonth != null ? ` · ${lang === 'es' ? 'día' : 'day'} ${s.dayOfMonth}` : ''}
                  <div style={{ color: T.ink3, fontSize: 11 }}>{s.recipients.join(', ')}</div>
                </div>
                <button onClick={() => remove(s.id)} style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: T.ink3 }} aria-label="Delete schedule"><Trash2 size={15} /></button>
              </div>
            ))}
          </div>
        )}

        <div style={{ height: 1, background: T.rule }} />
        <Caps>{lang === 'es' ? 'Nueva programación' : 'New schedule'}</Caps>

        <Field label={lang === 'es' ? 'Frecuencia' : 'Frequency'}>
          <select value={cadence} onChange={(e) => setCadence(e.target.value as typeof cadence)} style={selectStyle}>
            <option value="daily">{lang === 'es' ? 'Diario' : 'Daily'}</option>
            <option value="weekly">{lang === 'es' ? 'Semanal' : 'Weekly'}</option>
            <option value="monthly">{lang === 'es' ? 'Mensual' : 'Monthly'}</option>
          </select>
        </Field>

        {cadence === 'weekly' && (
          <Field label={lang === 'es' ? 'Día de la semana' : 'Day of week'}>
            <select value={dayOfWeek} onChange={(e) => setDayOfWeek(Number(e.target.value))} style={selectStyle}>
              {DOW.map((d, i) => <option key={i} value={i}>{d}</option>)}
            </select>
          </Field>
        )}
        {cadence === 'monthly' && (
          <Field label={lang === 'es' ? 'Día del mes' : 'Day of month'}>
            <select value={dayOfMonth} onChange={(e) => setDayOfMonth(Number(e.target.value))} style={selectStyle}>
              {Array.from({ length: 28 }, (_, i) => i + 1).map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
          </Field>
        )}

        <Field label={lang === 'es' ? 'Hora (local)' : 'Time (local)'}>
          <select value={hourLocal} onChange={(e) => setHourLocal(Number(e.target.value))} style={selectStyle}>
            {Array.from({ length: 24 }, (_, i) => i).map((h) => <option key={h} value={h}>{String(h).padStart(2, '0')}:00</option>)}
          </select>
        </Field>

        <Field label={lang === 'es' ? 'Periodo de datos' : 'Data window'}>
          <select value={rangeKind} onChange={(e) => setRangeKind(e.target.value as typeof rangeKind)} style={selectStyle}>
            <option value="last7">{lang === 'es' ? 'Últimos 7 días' : 'Last 7 days'}</option>
            <option value="last30">{lang === 'es' ? 'Últimos 30 días' : 'Last 30 days'}</option>
            <option value="mtd">{lang === 'es' ? 'Mes a la fecha' : 'Month to date'}</option>
            <option value="prev_month">{lang === 'es' ? 'Mes anterior' : 'Previous month'}</option>
          </select>
        </Field>

        <Field label={lang === 'es' ? 'Destinatarios (correos)' : 'Recipients (emails)'}>
          <textarea
            value={recipients}
            onChange={(e) => setRecipients(e.target.value)}
            placeholder={lang === 'es' ? 'correo@ejemplo.com, otro@ejemplo.com' : 'name@example.com, other@example.com'}
            rows={2}
            style={{ ...selectStyle, resize: 'vertical', fontFamily: fonts.sans }}
          />
        </Field>

        {error && <div style={{ fontFamily: fonts.sans, fontSize: 12.5, color: T.warm }}>{error}</div>}

        <div style={{ display: 'flex', gap: 8 }}>
          <Btn variant="primary" size="sm" onClick={() => void save()} disabled={saving}>
            <Plus size={14} /> {saving ? (lang === 'es' ? 'Guardando…' : 'Saving…') : (lang === 'es' ? 'Agregar' : 'Add schedule')}
          </Btn>
        </div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', color: T.ink3, fontFamily: fonts.sans, fontSize: 11.5 }}>
          <Mail size={12} /> {lang === 'es' ? 'Se enviará automáticamente por correo.' : 'Sent automatically by email.'}
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <Caps>{label}</Caps>
      {children}
    </label>
  );
}

function cadenceLabel(c: 'daily' | 'weekly' | 'monthly', lang: Lang): string {
  if (lang === 'es') return c === 'daily' ? 'Diario' : c === 'weekly' ? 'Semanal' : 'Mensual';
  return c === 'daily' ? 'Daily' : c === 'weekly' ? 'Weekly' : 'Monthly';
}
function rangeLabel(k: RangeKey, lang: Lang): string {
  if (lang === 'es') {
    return k === 'last7' ? 'Últimos 7 días' : k === 'last30' ? 'Últimos 30 días' : k === 'mtd' ? 'Mes a la fecha' : 'Personalizado';
  }
  return k === 'last7' ? 'Last 7 days' : k === 'last30' ? 'Last 30 days' : k === 'mtd' ? 'Month to date' : 'Custom';
}

const dateInputStyle: React.CSSProperties = {
  fontFamily: fonts.sans, fontSize: 12, padding: '4px 8px',
  border: `1px solid ${T.rule}`, borderRadius: 6, background: T.paper, color: T.ink,
};
const selectStyle: React.CSSProperties = {
  fontFamily: fonts.sans, fontSize: 13, padding: '7px 10px',
  border: `1px solid ${T.rule}`, borderRadius: 8, background: T.paper, color: T.ink, width: '100%',
};
