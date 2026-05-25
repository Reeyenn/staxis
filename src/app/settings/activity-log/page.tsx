'use client';

export const dynamic = 'force-dynamic';

// Settings → Activity Log.
// A unified timeline of every meaningful event across the property:
// cleanings, inspections, callouts, work orders, role changes, room status
// changes, system events. One searchable / filterable / exportable view.
// Reads /api/settings/activity-log via fetchWithAuth — the route gates to
// admin / owner / general_manager only.

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { ChevronLeft, Download, Filter, Search, X } from 'lucide-react';

import { AppLayout } from '@/components/layout/AppLayout';
import { useAuth } from '@/contexts/AuthContext';
import { useProperty } from '@/contexts/PropertyContext';
import { useLang } from '@/contexts/LanguageContext';
import { canManageTeam } from '@/lib/roles';
import { fetchWithAuth } from '@/lib/api-fetch';
import { T, fonts, Btn, Caps, Pill } from '@/app/staff/_components/_tokens';
import {
  ACTIVITY_CATEGORIES,
  ACTIVITY_SOURCES,
  type ActivityCategory,
  type ActivityLogRow,
  type ActivitySource,
} from '@/lib/activity-log/types';
import { categoryLabel, renderDescription, sourceLabel } from '@/lib/activity-log/renderer';

type DateRangeKey = 'today' | 'yesterday' | 'last7' | 'last30' | 'custom';

interface RangeBounds { from: string; to: string; }

function rangeFor(key: DateRangeKey, customFrom?: string, customTo?: string): RangeBounds {
  const now = new Date();
  const startOf = (d: Date) => { const x = new Date(d); x.setHours(0,0,0,0); return x; };
  const today = startOf(now);
  const tomorrow = new Date(today); tomorrow.setDate(today.getDate()+1);
  switch (key) {
    case 'today':     return { from: today.toISOString(), to: tomorrow.toISOString() };
    case 'yesterday': {
      const y = new Date(today); y.setDate(today.getDate()-1);
      return { from: y.toISOString(), to: today.toISOString() };
    }
    case 'last7': {
      const f = new Date(today); f.setDate(today.getDate()-7);
      return { from: f.toISOString(), to: tomorrow.toISOString() };
    }
    case 'last30': {
      const f = new Date(today); f.setDate(today.getDate()-30);
      return { from: f.toISOString(), to: tomorrow.toISOString() };
    }
    case 'custom':
    default:
      return {
        from: customFrom ? new Date(customFrom).toISOString() : new Date(today.getTime() - 7*86400000).toISOString(),
        to:   customTo   ? new Date(customTo).toISOString()   : tomorrow.toISOString(),
      };
  }
}

const PAGE_SIZE = 50;

export default function ActivityLogPage() {
  const { user } = useAuth();
  const { activePropertyId } = useProperty();
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
              ? 'El registro de actividad solo está disponible para gerentes, propietarios y administradores.'
              : 'The activity log is restricted to managers, owners, and admins.'}
          </p>
          <Link href="/settings">
            <Btn variant="ghost"><ChevronLeft size={14}/> {lang === 'es' ? 'Volver' : 'Back to Settings'}</Btn>
          </Link>
        </div>
      </AppLayout>
    );
  }

  return (
    <AppLayout>
      <ActivityLogBody pid={activePropertyId ?? ''} lang={lang}/>
    </AppLayout>
  );
}

function ActivityLogBody({ pid, lang }: { pid: string; lang: 'en' | 'es' }) {
  const [rangeKey, setRangeKey] = useState<DateRangeKey>('today');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [categories, setCategories] = useState<Set<ActivityCategory>>(new Set());
  const [sources, setSources] = useState<Set<ActivitySource>>(new Set());
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState<ActivityLogRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<ActivityLogRow | null>(null);

  const bounds = useMemo(() => rangeFor(rangeKey, customFrom, customTo), [rangeKey, customFrom, customTo]);

  const queryString = useMemo(() => {
    const p = new URLSearchParams();
    p.set('propertyId', pid);
    p.set('from', bounds.from);
    p.set('to', bounds.to);
    if (categories.size > 0) p.set('categories', Array.from(categories).join(','));
    if (sources.size > 0)    p.set('sources',    Array.from(sources).join(','));
    if (search.trim())       p.set('search', search.trim());
    p.set('page', String(page));
    p.set('pageSize', String(PAGE_SIZE));
    return p.toString();
  }, [pid, bounds, categories, sources, search, page]);

  // Debounce + fetch.
  useEffect(() => {
    if (!pid) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    const timer = setTimeout(() => {
      fetchWithAuth(`/api/settings/activity-log?${queryString}`)
        .then(async (r) => {
          if (cancelled) return;
          if (!r.ok) {
            const body = await r.json().catch(() => null);
            setError(body?.error ?? `Request failed (${r.status})`);
            setRows([]); setTotal(0);
            return;
          }
          const body = await r.json();
          const data = body?.data ?? body;
          setRows(data?.rows ?? []);
          setTotal(data?.total ?? 0);
        })
        .catch((e) => {
          if (cancelled) return;
          setError(e?.message ?? 'Network error');
        })
        .finally(() => { if (!cancelled) setLoading(false); });
    }, 250);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [pid, queryString]);

  const toggleCategory = (c: ActivityCategory) => {
    setPage(1);
    setCategories((prev) => {
      const next = new Set(prev);
      if (next.has(c)) next.delete(c); else next.add(c);
      return next;
    });
  };
  const toggleSource = (s: ActivitySource) => {
    setPage(1);
    setSources((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s); else next.add(s);
      return next;
    });
  };

  const handleExport = useCallback(async (format: 'csv' | 'xlsx' | 'pdf') => {
    if (!pid) return;
    const p = new URLSearchParams(queryString);
    p.delete('page'); p.delete('pageSize');
    p.set('format', format);
    try {
      const r = await fetchWithAuth(`/api/settings/activity-log/export?${p.toString()}`);
      if (!r.ok) {
        const body = await r.json().catch(() => null);
        setError(body?.error ?? `Export failed (${r.status})`);
        return;
      }
      const blob = await r.blob();
      const disposition = r.headers.get('Content-Disposition') ?? '';
      const m = /filename="([^"]+)"/.exec(disposition);
      const filename = m?.[1] ?? `activity-log.${format === 'xlsx' ? 'xls' : format}`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = filename;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 250);
    } catch (e) {
      setError((e as Error)?.message ?? 'Export failed');
    }
  }, [pid, queryString]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div style={{ padding: '16px 16px 32px', display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Link href="/settings" style={{ textDecoration: 'none', color: T.ink2 }}>
            <Btn variant="ghost" size="sm"><ChevronLeft size={14}/> {lang === 'es' ? 'Ajustes' : 'Settings'}</Btn>
          </Link>
          <h1 style={{
            fontFamily: fonts.serif, fontSize: 26, lineHeight: 1.1,
            color: T.ink, margin: 0, letterSpacing: '-0.01em',
          }}>
            {lang === 'es' ? 'Registro de actividad' : 'Activity Log'}
          </h1>
        </div>

        <div style={{ display: 'flex', gap: 6 }}>
          <Btn variant="ghost" size="sm" onClick={() => handleExport('csv')}><Download size={14}/> CSV</Btn>
          <Btn variant="ghost" size="sm" onClick={() => handleExport('xlsx')}><Download size={14}/> Excel</Btn>
          <Btn variant="ghost" size="sm" onClick={() => handleExport('pdf')}><Download size={14}/> PDF</Btn>
        </div>
      </div>

      {/* Date range */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        {(['today','yesterday','last7','last30','custom'] as const).map((k) => (
          <button
            key={k}
            onClick={() => { setRangeKey(k); setPage(1); }}
            style={{
              padding: '4px 10px', borderRadius: 999,
              border: `1px solid ${rangeKey === k ? T.ink : T.rule}`,
              background: rangeKey === k ? T.ink : 'transparent',
              color: rangeKey === k ? T.bg : T.ink2,
              fontFamily: fonts.sans, fontSize: 12, fontWeight: 500,
              cursor: 'pointer',
            }}
          >
            {rangeLabel(k, lang)}
          </button>
        ))}
        {rangeKey === 'custom' && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <input
              type="date" value={customFrom}
              onChange={(e) => { setCustomFrom(e.target.value); setPage(1); }}
              style={dateInputStyle}
            />
            <span style={{ color: T.ink3, fontSize: 12 }}>—</span>
            <input
              type="date" value={customTo}
              onChange={(e) => { setCustomTo(e.target.value); setPage(1); }}
              style={dateInputStyle}
            />
          </div>
        )}
      </div>

      {/* Search */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        border: `1px solid ${T.rule}`, borderRadius: 8, padding: '6px 10px',
        background: T.paper,
      }}>
        <Search size={14} color={T.ink3}/>
        <input
          placeholder={lang === 'es' ? 'Buscar por persona, habitación, evento…' : 'Search by person, room, event…'}
          value={search}
          onChange={(e) => { setSearch(e.target.value); setPage(1); }}
          style={{
            border: 'none', outline: 'none', background: 'transparent',
            flex: 1, fontFamily: fonts.sans, fontSize: 13, color: T.ink,
          }}
        />
        {search && (
          <button onClick={() => { setSearch(''); setPage(1); }} style={{ border: 'none', background: 'transparent', cursor: 'pointer' }}>
            <X size={14} color={T.ink3}/>
          </button>
        )}
      </div>

      {/* Category pills */}
      <FilterPills
        legend={lang === 'es' ? 'Categoría' : 'Category'}
        options={ACTIVITY_CATEGORIES as unknown as ActivityCategory[]}
        active={categories}
        onToggle={toggleCategory}
        labeler={(v) => categoryLabel(v, lang)}
      />

      {/* Source pills */}
      <FilterPills
        legend={lang === 'es' ? 'Origen' : 'Source'}
        options={ACTIVITY_SOURCES as unknown as ActivitySource[]}
        active={sources}
        onToggle={toggleSource}
        labeler={(v) => sourceLabel(v, lang)}
      />

      {/* Result count */}
      <div style={{ fontFamily: fonts.mono, fontSize: 11, color: T.ink3, letterSpacing: '0.04em', textTransform: 'uppercase' }}>
        {loading
          ? (lang === 'es' ? 'Cargando…' : 'Loading…')
          : total > 0
            ? `${(page - 1) * PAGE_SIZE + 1}–${Math.min(page * PAGE_SIZE, total)} ${lang === 'es' ? 'de' : 'of'} ${total}`
            : (lang === 'es' ? 'Sin eventos' : 'No events')}
      </div>

      {error && (
        <div style={{
          fontFamily: fonts.sans, fontSize: 13, color: T.warm, padding: '8px 12px',
          border: `1px solid ${T.warmDim}`, background: T.warmDim, borderRadius: 8,
        }}>{error}</div>
      )}

      {/* Table */}
      <ActivityTable rows={rows} lang={lang} onSelect={setSelected} />

      {/* Pager */}
      {total > PAGE_SIZE && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8 }}>
          <Btn variant="ghost" size="sm" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>
            {lang === 'es' ? 'Anterior' : 'Previous'}
          </Btn>
          <span style={{ fontFamily: fonts.mono, fontSize: 11, color: T.ink2 }}>
            {page} / {totalPages}
          </span>
          <Btn variant="ghost" size="sm" disabled={page >= totalPages} onClick={() => setPage((p) => Math.min(totalPages, p + 1))}>
            {lang === 'es' ? 'Siguiente' : 'Next'}
          </Btn>
        </div>
      )}

      {selected && (
        <EventDetailDrawer row={selected} lang={lang} onClose={() => setSelected(null)} />
      )}
    </div>
  );
}

function FilterPills<V extends string>({
  legend, options, active, onToggle, labeler,
}: {
  legend: string;
  options: readonly V[];
  active: Set<V>;
  onToggle: (v: V) => void;
  labeler: (v: V) => string;
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      <Caps>{legend}</Caps>
      {options.map((v) => {
        const isOn = active.has(v);
        return (
          <button
            key={v}
            onClick={() => onToggle(v)}
            style={{
              padding: '3px 9px', borderRadius: 999,
              border: `1px solid ${isOn ? T.sageDeep : T.rule}`,
              background: isOn ? T.sageDim : 'transparent',
              color: isOn ? T.sageDeep : T.ink2,
              fontFamily: fonts.sans, fontSize: 11, fontWeight: 500,
              cursor: 'pointer',
            }}
          >
            {labeler(v)}
          </button>
        );
      })}
    </div>
  );
}

function ActivityTable({
  rows, lang, onSelect,
}: {
  rows: ActivityLogRow[];
  lang: 'en' | 'es';
  onSelect: (r: ActivityLogRow) => void;
}) {
  return (
    <div style={{
      border: `1px solid ${T.rule}`, borderRadius: 12, overflow: 'hidden',
      background: T.paper,
    }}>
      <div style={{
        position: 'sticky', top: 0, zIndex: 1, background: T.paper,
        display: 'grid', gridTemplateColumns: '170px 130px minmax(120px,1fr) 1fr 110px',
        gap: 10, padding: '10px 14px',
        borderBottom: `1px solid ${T.rule}`,
      }}>
        <Caps>{lang === 'es' ? 'Cuándo' : 'When'}</Caps>
        <Caps>{lang === 'es' ? 'Categoría' : 'Category'}</Caps>
        <Caps>{lang === 'es' ? 'Persona' : 'Actor'}</Caps>
        <Caps>{lang === 'es' ? 'Descripción' : 'Description'}</Caps>
        <Caps>{lang === 'es' ? 'Origen' : 'Source'}</Caps>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        {rows.length === 0 && (
          <div style={{ padding: '20px 14px', color: T.ink3, fontFamily: fonts.sans, fontSize: 13 }}>
            {lang === 'es' ? 'No hay eventos en este intervalo.' : 'No events in this range.'}
          </div>
        )}
        {rows.map((r) => (
          <button
            key={r.id}
            onClick={() => onSelect(r)}
            style={{
              all: 'unset', cursor: 'pointer',
              display: 'grid', gridTemplateColumns: '170px 130px minmax(120px,1fr) 1fr 110px',
              gap: 10, padding: '10px 14px',
              borderBottom: `1px solid ${T.ruleSoft}`,
              fontFamily: fonts.sans, fontSize: 13, color: T.ink,
              alignItems: 'center',
            }}
          >
            <span style={{ fontFamily: fonts.mono, fontSize: 11, color: T.ink2 }}>{formatWhen(r.occurred_at, lang)}</span>
            <Pill tone={pillFor(r.event_category)}>{categoryLabel(r.event_category, lang)}</Pill>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.actor_name ?? '—'}</span>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{renderDescription(r, lang)}</span>
            <span style={{ fontFamily: fonts.mono, fontSize: 11, color: T.ink3 }}>{sourceLabel(r.source, lang)}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function EventDetailDrawer({
  row, lang, onClose,
}: { row: ActivityLogRow; lang: 'en' | 'es'; onClose: () => void; }) {
  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(31,35,28,0.18)', zIndex: 50,
        display: 'flex', justifyContent: 'flex-end',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 'min(480px, 96vw)', height: '100vh', overflowY: 'auto',
          background: T.paper, borderLeft: `1px solid ${T.rule}`,
          padding: 20, display: 'flex', flexDirection: 'column', gap: 14,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <Caps>{lang === 'es' ? 'Detalle del evento' : 'Event detail'}</Caps>
          <button onClick={onClose} style={{ background: 'transparent', border: 'none', cursor: 'pointer' }}>
            <X size={16} color={T.ink2}/>
          </button>
        </div>

        <div style={{ fontFamily: fonts.serif, fontSize: 20, color: T.ink, lineHeight: 1.25 }}>
          {renderDescription(row, lang)}
        </div>

        <DetailRow label={lang === 'es' ? 'Cuándo' : 'When'} value={new Date(row.occurred_at).toLocaleString(lang === 'es' ? 'es-MX' : undefined)} />
        <DetailRow label={lang === 'es' ? 'Categoría' : 'Category'} value={categoryLabel(row.event_category, lang)} />
        <DetailRow label={lang === 'es' ? 'Tipo' : 'Type'} value={row.event_type} />
        <DetailRow label={lang === 'es' ? 'Persona' : 'Actor'} value={row.actor_name ?? '—'} />
        {row.actor_role && <DetailRow label={lang === 'es' ? 'Rol' : 'Role'} value={row.actor_role} />}
        {row.target_label && <DetailRow label={lang === 'es' ? 'Objetivo' : 'Target'} value={row.target_label} />}
        <DetailRow label={lang === 'es' ? 'Origen' : 'Source'} value={sourceLabel(row.source, lang)} />

        <details style={{ marginTop: 8 }}>
          <summary style={{ cursor: 'pointer', fontFamily: fonts.mono, fontSize: 11, color: T.ink2, letterSpacing: '0.04em', textTransform: 'uppercase' }}>
            {lang === 'es' ? 'Datos sin procesar' : 'Raw event'}
          </summary>
          <pre style={{
            marginTop: 8, padding: 10, fontFamily: fonts.mono, fontSize: 11,
            background: '#F6F6F4', color: T.ink2, borderRadius: 8, overflowX: 'auto',
            border: `1px solid ${T.ruleSoft}`,
          }}>{JSON.stringify(row.metadata, null, 2)}</pre>
        </details>
      </div>
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div style={{ display: 'flex', gap: 12, alignItems: 'baseline' }}>
      <Caps>{label}</Caps>
      <span style={{ fontFamily: fonts.sans, fontSize: 13, color: T.ink, wordBreak: 'break-word' }}>
        {value ?? '—'}
      </span>
    </div>
  );
}

function formatWhen(iso: string, lang: 'en' | 'es'): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const date = d.toLocaleDateString(lang === 'es' ? 'es-MX' : undefined, { month: 'short', day: 'numeric' });
  const time = d.toLocaleTimeString(lang === 'es' ? 'es-MX' : undefined, { hour: 'numeric', minute: '2-digit' });
  return `${date} · ${time}`;
}

function rangeLabel(k: DateRangeKey, lang: 'en' | 'es'): string {
  if (lang === 'es') {
    switch (k) {
      case 'today':     return 'Hoy';
      case 'yesterday': return 'Ayer';
      case 'last7':     return 'Últimos 7 días';
      case 'last30':    return 'Últimos 30 días';
      case 'custom':    return 'Personalizado';
    }
  }
  switch (k) {
    case 'today':     return 'Today';
    case 'yesterday': return 'Yesterday';
    case 'last7':     return 'Last 7 days';
    case 'last30':    return 'Last 30 days';
    case 'custom':    return 'Custom';
  }
}

function pillFor(c: ActivityCategory): 'sage' | 'caramel' | 'warm' | 'purple' | 'neutral' | 'ink' {
  switch (c) {
    case 'housekeeping': return 'sage';
    case 'maintenance':  return 'caramel';
    case 'staff':        return 'purple';
    case 'system':       return 'neutral';
    case 'messages':     return 'ink';
    case 'inventory':    return 'caramel';
    case 'front_desk':   return 'warm';
  }
}

const dateInputStyle: React.CSSProperties = {
  fontFamily: fonts.sans, fontSize: 12, padding: '4px 8px',
  border: `1px solid ${T.rule}`, borderRadius: 6, background: T.paper, color: T.ink,
};
