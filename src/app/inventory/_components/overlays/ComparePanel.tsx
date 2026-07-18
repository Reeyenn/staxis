'use client';

// Compare (2026-07-18): two time periods of inventory, side by side, in
// layman's terms — months, whole years, or any custom date range. Rows:
// what you spent, thrown out, (months only) shelf value at start/end, and
// counts done, each with the difference spelled out ("▲ $120 more").
//
// Honesty rule: a period that ends before the hotel's first inventory
// activity shows "No data" — never a $0 that reads like a real number.
// Flow numbers come from /api/inventory/compare (one call per side);
// months mode adds /api/inventory/accounting-summary for the two shelf-value
// rows. Both endpoints are money-gated server-side (requireFinanceAccess).

import React, { useEffect, useMemo, useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { useProperty } from '@/contexts/PropertyContext';
import { fetchWithAuth } from '@/lib/api-fetch';

import { T, fonts } from '../tokens';
import { Caps } from '../Caps';
import { Overlay } from './Overlay';
import { fmtMoney } from '../format';
import { type Lang } from '../inv-i18n';

interface ComparePanelProps {
  lang: Lang;
  open: boolean;
  onClose: () => void;
}

function cmStrings(lang: Lang) {
  return {
    en: {
      eyebrow: 'Compare',
      italic: 'Side by side',
      modeMonths: 'Months',
      modeYears: 'Years',
      modeCustom: 'Custom dates',
      vs: 'vs',
      from: 'From',
      to: 'to',
      spent: 'What you spent',
      spentSub: 'deliveries received',
      thrownOut: 'Thrown out',
      thrownOutSub: 'damaged, stained, lost',
      shelfValue: 'Shelf value',
      shelfValueSub: 'what your inventory is worth',
      countsDone: 'Counts done',
      countsDoneSub: 'times someone counted',
      soFar: 'so far',
      more: 'more',
      less: 'less',
      same: 'same',
      noData: 'No data',
      noDataHint: 'Staxis wasn’t tracking inventory here yet.',
      noRecord: 'No record',
      noRecordHint: 'Staxis only knows today’s shelf value — it wasn’t saving month-end values back then.',
      loadFailed: 'Couldn’t load one of the periods — try again.',
    },
    es: {
      eyebrow: 'Comparar',
      italic: 'Lado a lado',
      modeMonths: 'Meses',
      modeYears: 'Años',
      modeCustom: 'Fechas propias',
      vs: 'vs',
      from: 'Desde',
      to: 'hasta',
      spent: 'Lo que gastó',
      spentSub: 'entregas recibidas',
      thrownOut: 'Desechado',
      thrownOutSub: 'dañado, manchado, perdido',
      shelfValue: 'Valor del inventario',
      shelfValueSub: 'lo que vale su inventario',
      countsDone: 'Conteos hechos',
      countsDoneSub: 'veces que se contó',
      soFar: 'hasta hoy',
      more: 'más',
      less: 'menos',
      same: 'igual',
      noData: 'Sin datos',
      noDataHint: 'Staxis aún no llevaba el inventario aquí.',
      noRecord: 'Sin registro',
      noRecordHint: 'Staxis solo conoce el valor de hoy — antes no guardaba el valor al cierre de cada mes.',
      loadFailed: 'No se pudo cargar uno de los períodos — intente de nuevo.',
    },
  }[lang];
}

type Mode = 'months' | 'years' | 'custom';

interface FlowTotals {
  receiptsValue: number;
  discardsValue: number;
  countSessions: number;
  firstActivityAt: string | null;
}

interface ValueTotals {
  openingValue: number;
  closingValue: number;
}

/** One side's resolved period: inclusive local dates + display label. */
interface Period {
  from: string; // YYYY-MM-DD
  to: string;   // YYYY-MM-DD (inclusive)
  label: string;
  monthKey?: string; // set in months mode (for the summary fetch)
  isCurrent?: boolean;
}

const pad = (n: number) => String(n).padStart(2, '0');
const dateStr = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const monthKeyOf = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
const addMonths = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth() + n, 1);
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

export function ComparePanel({ lang, open, onClose }: ComparePanelProps) {
  const cm = cmStrings(lang);
  const { user } = useAuth();
  const { activePropertyId } = useProperty();

  const [mode, setMode] = useState<Mode>('months');

  // Months mode — last 12 calendar months.
  const monthOptions = useMemo(() => {
    const now = new Date();
    const fmt = new Intl.DateTimeFormat(lang === 'es' ? 'es' : 'en', { month: 'long', year: 'numeric' });
    return Array.from({ length: 12 }, (_, i) => {
      const d = addMonths(now, -i);
      const label = fmt.format(d);
      return { key: monthKeyOf(d), label: label.charAt(0).toUpperCase() + label.slice(1) };
    });
  }, [lang]);
  const [monthA, setMonthA] = useState(() => monthKeyOf(new Date()));
  const [monthB, setMonthB] = useState(() => monthKeyOf(addMonths(new Date(), -1)));

  // Years mode — last 6 years.
  const thisYear = new Date().getFullYear();
  const yearOptions = useMemo(
    () => Array.from({ length: 6 }, (_, i) => thisYear - i),
    [thisYear],
  );
  const [yearA, setYearA] = useState(thisYear);
  const [yearB, setYearB] = useState(thisYear - 1);

  // Custom mode — defaults: last 30 days vs the 30 days before that.
  const [customA, setCustomA] = useState(() => ({
    from: dateStr(addDays(new Date(), -29)), to: dateStr(new Date()),
  }));
  const [customB, setCustomB] = useState(() => ({
    from: dateStr(addDays(new Date(), -59)), to: dateStr(addDays(new Date(), -30)),
  }));

  // Resolve each side to a concrete period.
  const rangeFmt = useMemo(
    () => new Intl.DateTimeFormat(lang === 'es' ? 'es' : 'en', { month: 'short', day: 'numeric' }),
    [lang],
  );
  const periodFor = (side: 'A' | 'B'): Period => {
    if (mode === 'months') {
      const key = side === 'A' ? monthA : monthB;
      const [y, m] = key.split('-').map(Number);
      const first = new Date(y, m - 1, 1);
      const last = new Date(y, m, 0); // day 0 of next month = last day
      return {
        from: dateStr(first),
        to: dateStr(last),
        label: monthOptions.find((o) => o.key === key)?.label ?? key,
        monthKey: key,
        isCurrent: key === monthKeyOf(new Date()),
      };
    }
    if (mode === 'years') {
      const y = side === 'A' ? yearA : yearB;
      const isCurrent = y === thisYear;
      return {
        from: `${y}-01-01`,
        to: isCurrent ? dateStr(new Date()) : `${y}-12-31`,
        label: String(y),
        isCurrent,
      };
    }
    const c = side === 'A' ? customA : customB;
    const lbl = (s: string) => {
      const [y, m, d] = s.split('-').map(Number);
      return rangeFmt.format(new Date(y, m - 1, d));
    };
    return { from: c.from, to: c.to, label: `${lbl(c.from)} – ${lbl(c.to)}` };
  };
  const periodA = periodFor('A');
  const periodB = periodFor('B');

  // ── Data ─────────────────────────────────────────────────────────────────
  const [flowA, setFlowA] = useState<FlowTotals | null>(null);
  const [flowB, setFlowB] = useState<FlowTotals | null>(null);
  const [valA, setValA] = useState<ValueTotals | null>(null);
  const [valB, setValB] = useState<ValueTotals | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);

  const fetchKey = `${mode}|${periodA.from}|${periodA.to}|${periodB.from}|${periodB.to}`;
  useEffect(() => {
    if (!open || !user || !activePropertyId) return;
    // Custom mode: don't fire on a half-typed backwards range.
    if (periodA.to < periodA.from || periodB.to < periodB.from) return;
    let cancelled = false;
    setLoading(true);
    setFailed(false);
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

    const fetchFlow = async (p: Period): Promise<FlowTotals | null> => {
      try {
        const res = await fetchWithAuth(
          `/api/inventory/compare?propertyId=${activePropertyId}&from=${p.from}&to=${p.to}&tz=${encodeURIComponent(tz)}`,
          { cache: 'no-store' },
        );
        if (!res.ok) return null;
        const json = (await res.json()) as { ok: boolean; data: FlowTotals };
        return json.ok ? json.data : null;
      } catch { return null; }
    };
    // Shelf value is only KNOWN for the current month (the accounting
    // aggregate prices current stock — for past months that same formula
    // yields a today-anchored estimate, not a historical fact, so we refuse
    // to show it; see the noRecord cells).
    const fetchValues = async (p: Period): Promise<ValueTotals | null> => {
      if (!p.monthKey || !p.isCurrent) return null;
      try {
        const res = await fetchWithAuth(
          `/api/inventory/accounting-summary?propertyId=${activePropertyId}&month=${p.monthKey}&tz=${encodeURIComponent(tz)}`,
          { cache: 'no-store' },
        );
        if (!res.ok) return null;
        const json = (await res.json()) as { ok: boolean; data: { totals: ValueTotals } };
        return json.ok ? json.data.totals : null;
      } catch { return null; }
    };

    void Promise.all([
      fetchFlow(periodA),
      fetchFlow(periodB),
      mode === 'months' ? fetchValues(periodA) : Promise.resolve(null),
      mode === 'months' ? fetchValues(periodB) : Promise.resolve(null),
    ]).then(([fa, fb, va, vb]) => {
      if (cancelled) return;
      setFlowA(fa); setFlowB(fb); setValA(va); setValB(vb);
      // A missing summary only counts as a failure for the current-month side
      // — past months intentionally skip the shelf-value fetch (noRecord).
      setFailed(
        fa === null || fb === null ||
        (mode === 'months' && ((!!periodA.isCurrent && va === null) || (!!periodB.isCurrent && vb === null))),
      );
      setLoading(false);
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, user, activePropertyId, fetchKey]);

  // "No data": the period ends before the hotel's first inventory activity
  // (or there's no activity at all). $0 after that point is a real zero.
  // Compare INSTANTS, not date strings — firstActivityAt is a UTC timestamp
  // and p.to is a local calendar date; an evening first-delivery near the
  // day boundary would flip a string comparison the wrong way.
  const noDataFor = (p: Period, flow: FlowTotals | null): boolean => {
    if (!flow) return false; // fetch failure is handled separately
    if (!flow.firstActivityAt) return true;
    const [y, m, d] = p.to.split('-').map(Number);
    const periodEndExclusive = new Date(y, m - 1, d + 1); // local midnight after the period
    return periodEndExclusive.getTime() <= new Date(flow.firstActivityAt).getTime();
  };
  const noDataA = noDataFor(periodA, flowA);
  const noDataB = noDataFor(periodB, flowB);

  interface RowSpec {
    label: string;
    sub: string;
    a: number | null;
    b: number | null;
    money: boolean;
    /** Per-side "we don't have a record of this" (shelf value of past months). */
    noRecordA?: boolean;
    noRecordB?: boolean;
  }
  const rows: RowSpec[] = [
    { label: cm.spent, sub: cm.spentSub, a: flowA?.receiptsValue ?? null, b: flowB?.receiptsValue ?? null, money: true },
    { label: cm.thrownOut, sub: cm.thrownOutSub, a: flowA?.discardsValue ?? null, b: flowB?.discardsValue ?? null, money: true },
    ...(mode === 'months'
      ? [{
          label: cm.shelfValue,
          sub: cm.shelfValueSub,
          a: valA?.closingValue ?? null,
          b: valB?.closingValue ?? null,
          money: true,
          noRecordA: !periodA.isCurrent,
          noRecordB: !periodB.isCurrent,
        }]
      : []),
    { label: cm.countsDone, sub: cm.countsDoneSub, a: flowA?.countSessions ?? null, b: flowB?.countSessions ?? null, money: false },
  ];
  const anyNoRecord = mode === 'months' && (!periodA.isCurrent || !periodB.isCurrent);

  const selectStyle: React.CSSProperties = {
    height: 38,
    padding: '0 12px',
    borderRadius: 10,
    border: `1px solid ${T.rule}`,
    background: T.bg,
    fontFamily: fonts.sans,
    fontSize: 14,
    fontWeight: 600,
    color: T.ink,
    cursor: 'pointer',
  };
  const dateStyle: React.CSSProperties = { ...selectStyle, fontWeight: 500, fontSize: 13, padding: '0 10px' };

  const modeChip = (m: Mode, label: string) => {
    const active = mode === m;
    return (
      <button
        key={m}
        type="button"
        onClick={() => setMode(m)}
        style={{
          height: 30,
          padding: '0 13px',
          borderRadius: 999,
          border: `1px solid ${active ? 'rgba(92,122,96,.35)' : 'rgba(31,35,28,.12)'}`,
          background: active ? 'rgba(158,183,166,.25)' : 'transparent',
          color: active ? T.forestText : T.ink2,
          fontFamily: fonts.sans,
          fontSize: 11.5,
          fontWeight: 600,
          cursor: 'pointer',
        }}
      >
        {label}
      </button>
    );
  };

  return (
    <Overlay
      open={open}
      onClose={onClose}
      eyebrow={cm.eyebrow}
      italic={cm.italic}
      width={780}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {/* Mode chips */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {modeChip('months', cm.modeMonths)}
          {modeChip('years', cm.modeYears)}
          {modeChip('custom', cm.modeCustom)}
        </div>

        {/* Period pickers */}
        {mode === 'months' && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <select value={monthA} onChange={(e) => setMonthA(e.target.value)} style={selectStyle} aria-label={`${cm.eyebrow} A`}>
              {monthOptions.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
            </select>
            <span style={{ fontFamily: fonts.sans, fontSize: 13, fontWeight: 600, color: T.ink3 }}>{cm.vs}</span>
            <select value={monthB} onChange={(e) => setMonthB(e.target.value)} style={selectStyle} aria-label={`${cm.eyebrow} B`}>
              {monthOptions.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
            </select>
          </div>
        )}
        {mode === 'years' && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <select value={yearA} onChange={(e) => setYearA(Number(e.target.value))} style={selectStyle} aria-label={`${cm.eyebrow} A`}>
              {yearOptions.map((y) => <option key={y} value={y}>{y}</option>)}
            </select>
            <span style={{ fontFamily: fonts.sans, fontSize: 13, fontWeight: 600, color: T.ink3 }}>{cm.vs}</span>
            <select value={yearB} onChange={(e) => setYearB(Number(e.target.value))} style={selectStyle} aria-label={`${cm.eyebrow} B`}>
              {yearOptions.map((y) => <option key={y} value={y}>{y}</option>)}
            </select>
          </div>
        )}
        {mode === 'custom' && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <input type="date" value={customA.from} max={customA.to} onChange={(e) => setCustomA((c) => ({ ...c, from: e.target.value }))} style={dateStyle} aria-label={`${cm.from} A`} />
            <span style={{ fontFamily: fonts.sans, fontSize: 12, color: T.ink3 }}>{cm.to}</span>
            <input type="date" value={customA.to} min={customA.from} onChange={(e) => setCustomA((c) => ({ ...c, to: e.target.value }))} style={dateStyle} aria-label={`${cm.to} A`} />
            <span style={{ fontFamily: fonts.sans, fontSize: 13, fontWeight: 600, color: T.ink3, margin: '0 4px' }}>{cm.vs}</span>
            <input type="date" value={customB.from} max={customB.to} onChange={(e) => setCustomB((c) => ({ ...c, from: e.target.value }))} style={dateStyle} aria-label={`${cm.from} B`} />
            <span style={{ fontFamily: fonts.sans, fontSize: 12, color: T.ink3 }}>{cm.to}</span>
            <input type="date" value={customB.to} min={customB.from} onChange={(e) => setCustomB((c) => ({ ...c, to: e.target.value }))} style={dateStyle} aria-label={`${cm.to} B`} />
          </div>
        )}

        {failed && !loading && (
          <div style={{ fontFamily: fonts.sans, fontSize: 13, color: T.warm }}>{cm.loadFailed}</div>
        )}

        {/* The comparison table */}
        <div style={{ background: T.paper, border: `1px solid ${T.rule}`, borderRadius: 14, padding: '4px 20px' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1.3fr 1fr 1fr 1fr', gap: 12, padding: '12px 0 8px' }}>
            <span />
            {/* "· so far" marks a period that isn't over — comparing a partial
                month/year against a complete one should say so. */}
            <Caps size={9} style={{ textAlign: 'right' }}>
              {periodA.label}{periodA.isCurrent ? ` · ${cm.soFar}` : ''}
            </Caps>
            <Caps size={9} style={{ textAlign: 'right' }}>
              {periodB.label}{periodB.isCurrent ? ` · ${cm.soFar}` : ''}
            </Caps>
            <span />
          </div>
          {rows.map((r, i) => (
            <CompareRow
              key={r.label}
              row={r}
              cm={cm}
              loading={loading}
              noDataA={noDataA}
              noDataB={noDataB}
              first={i === 0}
            />
          ))}
          {(noDataA || noDataB) && !loading && (
            <div style={{ padding: '10px 0 4px', fontFamily: fonts.sans, fontSize: 11.5, color: T.ink3 }}>
              {cm.noData}: {cm.noDataHint}
            </div>
          )}
          {anyNoRecord && !loading && (
            <div style={{ padding: '10px 0 14px', fontFamily: fonts.sans, fontSize: 11.5, color: T.ink3 }}>
              {cm.noRecord}: {cm.noRecordHint}
            </div>
          )}
        </div>
      </div>
    </Overlay>
  );
}

function CompareRow({
  row,
  cm,
  loading,
  noDataA,
  noDataB,
  first,
}: {
  row: { label: string; sub: string; a: number | null; b: number | null; money: boolean; noRecordA?: boolean; noRecordB?: boolean };
  cm: ReturnType<typeof cmStrings>;
  loading: boolean;
  noDataA: boolean;
  noDataB: boolean;
  first: boolean;
}) {
  const cell = (v: number | null, noData: boolean, noRecord: boolean): React.ReactNode => {
    if (loading) return '…';
    if (noData || noRecord) {
      return (
        <span style={{ fontSize: 13, fontWeight: 500, fontStyle: 'italic', color: T.ink3 }}>
          {noData ? cm.noData : cm.noRecord}
        </span>
      );
    }
    if (v == null) return '—';
    return row.money ? fmtMoney(v) : String(v);
  };
  // Difference in plain words — only when BOTH sides have real numbers.
  let diffText = '';
  if (!loading && !noDataA && !noDataB && !row.noRecordA && !row.noRecordB && row.a != null && row.b != null) {
    const diff = row.a - row.b;
    if (Math.abs(diff) < (row.money ? 0.005 : 1)) {
      diffText = cm.same;
    } else {
      const amount = row.money ? fmtMoney(Math.abs(diff)) : String(Math.abs(diff));
      diffText = `${diff > 0 ? '▲' : '▼'} ${amount} ${diff > 0 ? cm.more : cm.less}`;
    }
  }
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '1.3fr 1fr 1fr 1fr',
        gap: 12,
        alignItems: 'center',
        padding: '14px 0',
        borderTop: first ? 'none' : `1px solid ${T.ruleSoft}`,
      }}
    >
      <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <span style={{ fontFamily: fonts.sans, fontSize: 13.5, fontWeight: 600, color: T.ink }}>
          {row.label}
        </span>
        <span style={{ fontFamily: fonts.sans, fontSize: 11.5, color: T.ink3 }}>
          {row.sub}
        </span>
      </span>
      <span style={{ fontFamily: fonts.sans, fontSize: 22, fontWeight: 600, letterSpacing: '-0.02em', color: T.ink, textAlign: 'right' }}>
        {cell(row.a, noDataA, !!row.noRecordA)}
      </span>
      <span style={{ fontFamily: fonts.sans, fontSize: 22, fontWeight: 600, letterSpacing: '-0.02em', color: T.ink2, textAlign: 'right' }}>
        {cell(row.b, noDataB, !!row.noRecordB)}
      </span>
      <span style={{ fontFamily: fonts.sans, fontSize: 12, fontWeight: 600, color: T.ink2, textAlign: 'right', whiteSpace: 'nowrap' }}>
        {diffText}
      </span>
    </div>
  );
}
