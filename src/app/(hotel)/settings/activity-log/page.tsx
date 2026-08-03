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

import { useScope } from '@/lib/hooks/use-scope';
import { useLang } from '@/contexts/LanguageContext';
import { useCan } from '@/lib/capabilities/useCan';
import { fetchWithAuth } from '@/lib/api-fetch';
import { exportBlob, filenameFromDisposition } from '@/lib/export-blob';
import { T, fonts, Btn, Caps, Pill } from '@/app/staff/_components/_tokens';
import {
  ACTIVITY_CATEGORIES,
  ACTIVITY_SOURCES,
  type ActivityCategory,
  type ActivityLogRow,
  type ActivitySource,
} from '@/lib/activity-log/types';
import { categoryLabel, renderDescription, sourceLabel } from '@/lib/activity-log/renderer';
// Range math lives in ./date-range (pure, unit-tested): the custom range is
// local-midnight based and end-EXCLUSIVE-safe (includes the whole end day).
import { rangeFor, type DateRangeKey } from '@/app/settings/activity-log/date-range';

const PAGE_SIZE = 50;

export default function ActivityLogPage() {
  const { uid, pid } = useScope();
  const { lang } = useLang();
  const can = useCan();

  if (!uid) {
    return <div style={{ padding: 24 }}>{'Sign in to continue.'}</div>;
  }
  if (!can('view_activity_log')) {
    return (

        <div style={{ padding: 24, maxWidth: 520, margin: '40px auto', textAlign: 'center' }}>
          <h1 style={{ fontFamily: fonts.serif, fontSize: 24, color: T.ink, marginBottom: 12 }}>
            {'You don’t have access'}
          </h1>
          <p style={{ fontFamily: fonts.sans, fontSize: 14, color: T.ink2, marginBottom: 20 }}>
            {'The activity log is restricted to managers, owners, and admins.'}
          </p>
          <Link href="/settings">
            <Btn variant="ghost"><ChevronLeft size={14}/> {'Back to Settings'}</Btn>
          </Link>
        </div>

    );
  }

  return (

      <ActivityLogBody pid={pid ?? ''} lang={lang}/>

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
      const fallback = `activity-log.${format === 'xlsx' ? 'xls' : format}`;
      exportBlob(
        filenameFromDisposition(r.headers.get('Content-Disposition')) ?? fallback,
        await r.blob(),
      );
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
            <Btn variant="ghost" size="sm"><ChevronLeft size={14}/> {'Settings'}</Btn>
          </Link>
          <h1 style={{
            fontFamily: fonts.serif, fontSize: 26, lineHeight: 1.1,
            color: T.ink, margin: 0, letterSpacing: '-0.01em',
          }}>
            {'Activity Log'}
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
          placeholder={'Search by person, room, event…'}
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
        legend={'Category'}
        options={ACTIVITY_CATEGORIES as unknown as ActivityCategory[]}
        active={categories}
        onToggle={toggleCategory}
        labeler={categoryLabel}
      />

      {/* Source pills */}
      <FilterPills
        legend={'Source'}
        options={ACTIVITY_SOURCES as unknown as ActivitySource[]}
        active={sources}
        onToggle={toggleSource}
        labeler={sourceLabel}
      />

      {/* Result count */}
      <div style={{ fontFamily: fonts.mono, fontSize: 11, color: T.ink3, letterSpacing: '0.04em', textTransform: 'uppercase' }}>
        {loading
          ? ('Loading…')
          : total > 0
            ? `${(page - 1) * PAGE_SIZE + 1}–${Math.min(page * PAGE_SIZE, total)} ${'of'} ${total}`
            : ('No events')}
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
            {'Previous'}
          </Btn>
          <span style={{ fontFamily: fonts.mono, fontSize: 11, color: T.ink2 }}>
            {page} / {totalPages}
          </span>
          <Btn variant="ghost" size="sm" disabled={page >= totalPages} onClick={() => setPage((p) => Math.min(totalPages, p + 1))}>
            {'Next'}
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
        <Caps>{'When'}</Caps>
        <Caps>{'Category'}</Caps>
        <Caps>{'Actor'}</Caps>
        <Caps>{'Description'}</Caps>
        <Caps>{'Source'}</Caps>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        {rows.length === 0 && (
          <div style={{ padding: '20px 14px', color: T.ink3, fontFamily: fonts.sans, fontSize: 13 }}>
            {'No events in this range.'}
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
            <Pill tone={pillFor(r.event_category)}>{categoryLabel(r.event_category)}</Pill>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.actor_name ?? '—'}</span>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{renderDescription(r)}</span>
            <span style={{ fontFamily: fonts.mono, fontSize: 11, color: T.ink3 }}>{sourceLabel(r.source)}</span>
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
          <Caps>{'Event detail'}</Caps>
          <button onClick={onClose} style={{ background: 'transparent', border: 'none', cursor: 'pointer' }}>
            <X size={16} color={T.ink2}/>
          </button>
        </div>

        <div style={{ fontFamily: fonts.serif, fontSize: 20, color: T.ink, lineHeight: 1.25 }}>
          {renderDescription(row)}
        </div>

        <DetailRow label={'When'} value={new Date(row.occurred_at).toLocaleString(undefined)} />
        <DetailRow label={'Category'} value={categoryLabel(row.event_category)} />
        <DetailRow label={'Type'} value={row.event_type} />
        <DetailRow label={'Actor'} value={row.actor_name ?? '—'} />
        {row.actor_role && <DetailRow label={'Role'} value={row.actor_role} />}
        {row.target_label && <DetailRow label={'Target'} value={row.target_label} />}
        <DetailRow label={'Source'} value={sourceLabel(row.source)} />

        <details style={{ marginTop: 8 }}>
          <summary style={{ cursor: 'pointer', fontFamily: fonts.mono, fontSize: 11, color: T.ink2, letterSpacing: '0.04em', textTransform: 'uppercase' }}>
            {'Raw event'}
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
  const date = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return `${date} · ${time}`;
}

function rangeLabel(k: DateRangeKey, lang: 'en' | 'es'): string {

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
