'use client';

// Compare (2026-07-19): two time periods of inventory, side by side. Purchases
// and actual usage are deliberately separate. Actual usage is shown only from
// closed monthly snapshots; an arbitrary partial date range never fabricates
// usage from deliveries. Month snapshots also provide honest beginning and
// ending shelf values.
//
// Honesty rule: a period that ends before the hotel's first inventory
// activity shows "No data" — never a $0 that reads like a real number.
// Flow numbers come from /api/inventory/compare (one call per side); months
// mode adds /api/inventory/accounting-summary for the two shelf-value rows.
// Both endpoints are money-gated server-side (requireFinanceAccess).

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { useProperty } from '@/contexts/PropertyContext';
import { fetchWithAuth } from '@/lib/api-fetch';
import {
  formatInventoryDateKey,
  formatInventoryMonthKey,
  inventoryDateKeyInZone,
  inventoryMonthEndDateKey,
  propertyLocalDayStartUTC,
  shiftInventoryDateKey,
  shiftInventoryMonthKey,
} from '@/lib/inventory-month-close';

import { T, fonts } from '../tokens';
import { Caps } from '../Caps';
import { Overlay } from './Overlay';
import { fmtMoney } from '../format';
import { type Lang } from '../inv-i18n';
import styles from './ComparePanel.module.css';

interface ComparePanelProps {
  lang: Lang;
  open: boolean;
  onClose: () => void;
  timezone: string;
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
      actualUsed: 'Actual used',
      actualUsedSub: 'beginning + purchases − ending',
      purchases: 'Purchases',
      purchasesSub: 'logged deliveries received in the selected period',
      closedMonthCoverage: (closed: number, ended: number) =>
        `${closed} of ${ended} ended ${ended === 1 ? 'month' : 'months'} covered`,
      missingCost: 'Missing cost',
      pendingClose: 'Pending close',
      partial: 'Partial month',
      unavailable: 'Not available',
      customUsageHint: 'Actual usage is monthly, so it is not estimated for custom date ranges.',
      thrownOut: 'Thrown out',
      thrownOutSub: 'damaged, stained, lost',
      beginningInventory: 'Beginning inventory',
      beginningInventorySub: 'shelf value at the monthly start count',
      endingInventory: 'Ending inventory',
      endingInventorySub: 'shelf value at the monthly ending count',
      countsDone: 'Counts done',
      countsDoneSub: 'times someone counted',
      soFar: 'so far',
      more: 'more',
      less: 'less',
      same: 'same',
      noData: 'No data',
      noDataHint: 'Staxis wasn’t tracking inventory here yet.',
      noRecord: 'No record',
      noRecordHint: 'No closed monthly inventory snapshot exists for that month.',
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
      actualUsed: 'Uso real',
      actualUsedSub: 'inicial + compras − final',
      purchases: 'Compras',
      purchasesSub: 'entregas registradas recibidas en el período elegido',
      closedMonthCoverage: (closed: number, ended: number) =>
        `${closed} de ${ended} ${ended === 1 ? 'mes terminado cubierto' : 'meses terminados cubiertos'}`,
      missingCost: 'Falta costo',
      pendingClose: 'Cierre pendiente',
      partial: 'Mes parcial',
      unavailable: 'No disponible',
      customUsageHint: 'El uso real es mensual, por lo que no se estima para fechas personalizadas.',
      thrownOut: 'Desechado',
      thrownOutSub: 'dañado, manchado, perdido',
      beginningInventory: 'Inventario inicial',
      beginningInventorySub: 'valor al conteo inicial del mes',
      endingInventory: 'Inventario final',
      endingInventorySub: 'valor al conteo final del mes',
      countsDone: 'Conteos hechos',
      countsDoneSub: 'veces que se contó',
      soFar: 'hasta hoy',
      more: 'más',
      less: 'menos',
      same: 'igual',
      noData: 'Sin datos',
      noDataHint: 'Staxis aún no llevaba el inventario aquí.',
      noRecord: 'Sin registro',
      noRecordHint: 'No existe un cierre mensual de inventario para ese mes.',
      loadFailed: 'No se pudo cargar uno de los períodos — intente de nuevo.',
    },
  }[lang];
}

type Mode = 'months' | 'years' | 'custom';

interface FlowTotals {
  receiptsValue: number | null;
  knownReceiptsValue: number;
  purchasesComplete: boolean;
  actualUsageValue: number | null;
  confirmedPurchasesValue: number | null;
  actualUsageStatus: 'complete' | 'partial' | 'pending' | 'unavailable';
  closedMonths: number;
  expectedMonths: number;
  windowMonths: number;
  discardsValue: number | null;
  knownDiscardsValue: number;
  discardsComplete: boolean;
  countSessions: number;
  firstActivityAt: string | null;
}

type CompareCellState = FlowTotals['actualUsageStatus'] | 'incomplete';

interface ValueTotals {
  openingValue: number | null;
  closingValue: number | null;
  actualStatus: 'pending' | 'complete' | 'partial' | 'unallocated';
}

/** One side's resolved period: inclusive local dates + display label. */
interface Period {
  from: string; // YYYY-MM-DD
  to: string;   // YYYY-MM-DD (inclusive)
  label: string;
  monthKey?: string; // set in months mode (for the summary fetch)
  isCurrent?: boolean;
}

export function ComparePanel({ lang, open, onClose, timezone }: ComparePanelProps) {
  const cm = cmStrings(lang);
  const { user } = useAuth();
  const { activePropertyId } = useProperty();
  const locale = lang === 'es' ? 'es' : 'en';
  // Re-resolve "today" each time the panel opens. A remote manager therefore
  // sees the hotel's current month/day, not the browser's calendar.
  const todayKey = inventoryDateKeyInZone(new Date(), timezone);
  const currentMonthKey = todayKey.slice(0, 7);
  const previousMonthKey = shiftInventoryMonthKey(currentMonthKey, -1);
  const thisYear = Number(todayKey.slice(0, 4));

  const [mode, setMode] = useState<Mode>('months');

  // Months mode — last 12 calendar months.
  const monthOptions = useMemo(() => {
    return Array.from({ length: 12 }, (_, i) => {
      const key = shiftInventoryMonthKey(currentMonthKey, -i);
      const label = formatInventoryMonthKey(key, locale);
      return { key, label: label.charAt(0).toUpperCase() + label.slice(1) };
    });
  }, [currentMonthKey, locale]);
  const [monthA, setMonthA] = useState(currentMonthKey);
  const [monthB, setMonthB] = useState(previousMonthKey);

  // Years mode — last 6 years.
  const yearOptions = useMemo(
    () => Array.from({ length: 6 }, (_, i) => thisYear - i),
    [thisYear],
  );
  const [yearA, setYearA] = useState(thisYear);
  const [yearB, setYearB] = useState(thisYear - 1);

  // Custom mode — defaults: last 30 days vs the 30 days before that.
  const [customA, setCustomA] = useState(() => ({
    from: shiftInventoryDateKey(todayKey, -29), to: todayKey,
  }));
  const [customB, setCustomB] = useState(() => ({
    from: shiftInventoryDateKey(todayKey, -59), to: shiftInventoryDateKey(todayKey, -30),
  }));

  const wasOpenRef = useRef(false);
  useEffect(() => {
    if (!open) {
      wasOpenRef.current = false;
      return;
    }
    if (wasOpenRef.current) return;
    wasOpenRef.current = true;
    setMonthA(currentMonthKey);
    setMonthB(previousMonthKey);
    setYearA(thisYear);
    setYearB(thisYear - 1);
    setCustomA({ from: shiftInventoryDateKey(todayKey, -29), to: todayKey });
    setCustomB({
      from: shiftInventoryDateKey(todayKey, -59),
      to: shiftInventoryDateKey(todayKey, -30),
    });
  }, [open, currentMonthKey, previousMonthKey, thisYear, todayKey]);

  // Resolve each side to a concrete period.
  const periodFor = (side: 'A' | 'B'): Period => {
    if (mode === 'months') {
      const key = side === 'A' ? monthA : monthB;
      return {
        from: `${key}-01`,
        to: inventoryMonthEndDateKey(key),
        label: monthOptions.find((o) => o.key === key)?.label ?? key,
        monthKey: key,
        isCurrent: key === currentMonthKey,
      };
    }
    if (mode === 'years') {
      const y = side === 'A' ? yearA : yearB;
      const isCurrent = y === thisYear;
      return {
        from: `${y}-01-01`,
        to: isCurrent ? todayKey : `${y}-12-31`,
        label: String(y),
        isCurrent,
      };
    }
    const c = side === 'A' ? customA : customB;
    const lbl = (s: string) => formatInventoryDateKey(s, locale);
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

  const fetchKey = `${timezone}|${mode}|${periodA.from}|${periodA.to}|${periodB.from}|${periodB.to}`;
  useEffect(() => {
    if (!open || !user || !activePropertyId) return;
    // Custom mode: don't fire on a half-typed backwards range.
    if (periodA.to < periodA.from || periodB.to < periodB.from) return;
    let cancelled = false;
    setLoading(true);
    setFailed(false);

    const fetchFlow = async (p: Period): Promise<FlowTotals | null> => {
      try {
        const res = await fetchWithAuth(
          `/api/inventory/compare?propertyId=${activePropertyId}&from=${p.from}&to=${p.to}&basis=${mode}`,
          { cache: 'no-store' },
        );
        if (!res.ok) return null;
        const json = (await res.json()) as { ok: boolean; data: FlowTotals };
        return json.ok ? json.data : null;
      } catch { return null; }
    };
    // Beginning/ending shelf values are only shown from the monthly close
    // snapshot. The accounting endpoint returns null for an unclosed month;
    // it never back-prices today's stock as a historical month-end value.
    const fetchValues = async (p: Period): Promise<ValueTotals | null> => {
      if (!p.monthKey) return null;
      try {
        const res = await fetchWithAuth(
          `/api/inventory/accounting-summary?propertyId=${activePropertyId}&month=${p.monthKey}`,
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
      setFailed(
        fa === null || fb === null ||
        (mode === 'months' && (va === null || vb === null)),
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
    const [y, m, d] = shiftInventoryDateKey(p.to, 1).split('-').map(Number);
    const periodEndExclusive = propertyLocalDayStartUTC(y, m, d, timezone);
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
    /** Actual-usage cells can be pending, unavailable, or a labeled partial. */
    stateA?: CompareCellState;
    stateB?: CompareCellState;
    /** Closed-month coverage for a yearly usage actual. */
    coverageA?: { closed: number; ended: number };
    coverageB?: { closed: number; ended: number };
  }
  const rows: RowSpec[] = [
    {
      label: cm.actualUsed,
      sub: cm.actualUsedSub,
      a: flowA?.actualUsageValue ?? null,
      b: flowB?.actualUsageValue ?? null,
      money: true,
      stateA: flowA?.actualUsageStatus,
      stateB: flowB?.actualUsageStatus,
      coverageA: mode === 'years' && flowA && flowA.windowMonths > 0
        ? { closed: flowA.closedMonths, ended: flowA.windowMonths }
        : undefined,
      coverageB: mode === 'years' && flowB && flowB.windowMonths > 0
        ? { closed: flowB.closedMonths, ended: flowB.windowMonths }
        : undefined,
    },
    {
      label: cm.purchases,
      sub: cm.purchasesSub,
      // Purchases are the complete selected delivery window. Never replace a
      // year with the smaller subtotal from only its closed usage months.
      a: flowA ? flowA.receiptsValue ?? flowA.knownReceiptsValue : null,
      b: flowB ? flowB.receiptsValue ?? flowB.knownReceiptsValue : null,
      money: true,
      stateA: flowA && !flowA.purchasesComplete ? 'incomplete' : undefined,
      stateB: flowB && !flowB.purchasesComplete ? 'incomplete' : undefined,
    },
    {
      label: cm.thrownOut,
      sub: cm.thrownOutSub,
      a: flowA ? flowA.discardsValue ?? flowA.knownDiscardsValue : null,
      b: flowB ? flowB.discardsValue ?? flowB.knownDiscardsValue : null,
      money: true,
      stateA: flowA && !flowA.discardsComplete ? 'incomplete' : undefined,
      stateB: flowB && !flowB.discardsComplete ? 'incomplete' : undefined,
    },
    ...(mode === 'months'
      ? [
          {
            label: cm.beginningInventory,
            sub: cm.beginningInventorySub,
            a: valA?.openingValue ?? null,
            b: valB?.openingValue ?? null,
            money: true,
            noRecordA: valA?.openingValue == null,
            noRecordB: valB?.openingValue == null,
          },
          {
            label: cm.endingInventory,
            sub: cm.endingInventorySub,
            a: valA?.closingValue ?? null,
            b: valB?.closingValue ?? null,
            money: true,
            noRecordA: valA?.closingValue == null,
            noRecordB: valB?.closingValue == null,
          },
        ]
      : []),
    { label: cm.countsDone, sub: cm.countsDoneSub, a: flowA?.countSessions ?? null, b: flowB?.countSessions ?? null, money: false },
  ];
  const anyNoRecord = mode === 'months' && (
    valA?.openingValue == null || valA?.closingValue == null ||
    valB?.openingValue == null || valB?.closingValue == null
  );

  const selectStyle: React.CSSProperties = {
    height: 44,
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
        aria-pressed={active}
        style={{
          minHeight: 44,
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
        <div className={styles.modeRow}>
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
        <div className={styles.tableCard} style={{ background: T.paper, border: `1px solid ${T.rule}`, borderRadius: 14, padding: '4px 20px' }}>
          <div className={styles.tableHeader}>
            <span className={styles.desktopSpacer} />
            {/* "· so far" marks a period that isn't over — comparing a partial
                month/year against a complete one should say so. */}
            <Caps size={9} style={{ textAlign: 'right' }}>
              {periodA.label}{periodA.isCurrent ? ` · ${cm.soFar}` : ''}
            </Caps>
            <Caps size={9} style={{ textAlign: 'right' }}>
              {periodB.label}{periodB.isCurrent ? ` · ${cm.soFar}` : ''}
            </Caps>
            <span className={styles.desktopSpacer} />
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
          {mode === 'custom' && !loading && (
            <div style={{ padding: '10px 0 14px', fontFamily: fonts.sans, fontSize: 11.5, color: T.ink3 }}>
              {cm.customUsageHint}
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
  row: {
    label: string;
    sub: string;
    a: number | null;
    b: number | null;
    money: boolean;
    noRecordA?: boolean;
    noRecordB?: boolean;
    stateA?: CompareCellState;
    stateB?: CompareCellState;
    coverageA?: { closed: number; ended: number };
    coverageB?: { closed: number; ended: number };
  };
  cm: ReturnType<typeof cmStrings>;
  loading: boolean;
  noDataA: boolean;
  noDataB: boolean;
  first: boolean;
}) {
  const cell = (
    v: number | null,
    noData: boolean,
    noRecord: boolean,
    state?: CompareCellState,
    coverage?: { closed: number; ended: number },
  ): React.ReactNode => {
    if (loading) return '…';
    if (noData || noRecord) {
      return (
        <span style={{ fontSize: 13, fontWeight: 500, fontStyle: 'italic', color: T.ink3 }}>
          {noData ? cm.noData : cm.noRecord}
        </span>
      );
    }
    const primary = state === 'pending'
      ? cm.pendingClose
      : state === 'unavailable'
        ? cm.unavailable
        : v == null
          ? '—'
          : `${state === 'incomplete' ? '≥ ' : ''}${row.money ? fmtMoney(v) : String(v)}`;
    const stateDetail = state === 'incomplete'
      ? cm.missingCost
      : state === 'partial'
        ? cm.partial
        : null;
    const coverageDetail = coverage
      ? cm.closedMonthCoverage(coverage.closed, coverage.ended)
      : null;
    if (!stateDetail && !coverageDetail) {
      return state === 'pending' || state === 'unavailable'
        ? <span style={{ fontSize: 13, fontWeight: 500, color: T.ink3 }}>{primary}</span>
        : primary;
    }
    return (
      <span style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'flex-end', gap: 2 }}>
        <span style={state === 'pending' || state === 'unavailable' ? { fontSize: 13, fontWeight: 500, color: T.ink3 } : undefined}>
          {primary}
        </span>
        {stateDetail && (
          <span style={{ fontSize: 9.5, fontWeight: 600, color: T.warm, letterSpacing: '0.04em', textTransform: 'uppercase' }}>
            {stateDetail}
          </span>
        )}
        {coverageDetail && (
          <span style={{ fontSize: 9.5, fontWeight: 600, color: T.ink3, letterSpacing: '0.02em' }}>
            {coverageDetail}
          </span>
        )}
      </span>
    );
  };
  // Difference in plain words — only when BOTH sides have real numbers.
  let diffText = '';
  if (
    !loading && !noDataA && !noDataB && !row.noRecordA && !row.noRecordB &&
    (!row.stateA || row.stateA === 'complete') && (!row.stateB || row.stateB === 'complete') &&
    row.a != null && row.b != null
  ) {
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
      className={styles.compareRow}
      style={{
        alignItems: 'center',
        padding: '14px 0',
        borderTop: first ? 'none' : `1px solid ${T.ruleSoft}`,
      }}
    >
      <span className={styles.rowLabel} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <span style={{ fontFamily: fonts.sans, fontSize: 13.5, fontWeight: 600, color: T.ink }}>
          {row.label}
        </span>
        <span style={{ fontFamily: fonts.sans, fontSize: 11.5, color: T.ink3 }}>
          {row.sub}
        </span>
      </span>
      <span className={styles.valueCell} style={{ fontFamily: fonts.sans, fontSize: 22, fontWeight: 600, letterSpacing: '-0.02em', color: T.ink, textAlign: 'right' }}>
        {cell(row.a, noDataA, !!row.noRecordA, row.stateA, row.coverageA)}
      </span>
      <span className={styles.valueCell} style={{ fontFamily: fonts.sans, fontSize: 22, fontWeight: 600, letterSpacing: '-0.02em', color: T.ink2, textAlign: 'right' }}>
        {cell(row.b, noDataB, !!row.noRecordB, row.stateB, row.coverageB)}
      </span>
      <span className={styles.diffCell} style={{ fontFamily: fonts.sans, fontSize: 12, fontWeight: 600, color: T.ink2, textAlign: 'right', whiteSpace: 'nowrap' }}>
        {diffText}
      </span>
    </div>
  );
}
