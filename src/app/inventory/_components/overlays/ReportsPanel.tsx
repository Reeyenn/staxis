'use client';

// Reports v3 (2026-07-19): shelf value, purchases, and actual usage are three
// different facts. Shelf value comes from today's item list. Purchases come
// from logged deliveries. Actual usage exists only after a monthly inventory
// close (beginning + confirmed purchases - ending). An open month therefore
// says "usage pending" instead of treating deliveries as usage or as $0.

import React, { useEffect, useMemo, useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { useProperty } from '@/contexts/PropertyContext';
import { fetchWithAuth } from '@/lib/api-fetch';

import { shortDateFromDate, shortMonthFromYmd } from '@/lib/format-date';
import { formatInventoryMonthKey } from '@/lib/inventory-month-close';
import { inventoryReportMonthKey } from '@/lib/reports/property-report-range';
import { T, fonts, statusColor, type InvCat } from '../tokens';
import { catLabelFor, type Lang } from '../inv-i18n';
import { Caps } from '../Caps';
import { Overlay } from './Overlay';
import { fmtMoney } from '../format';
import type { DisplayItem } from '../types';

interface ReportsPanelProps {
  lang: Lang;
  open: boolean;
  onClose: () => void;
  display: DisplayItem[];
  /** Custom-category id → hotel-chosen tab name (for the value-by-category list). */
  customNameById: Map<string, string>;
  timezone: string;
}

function rpStrings(lang: Lang) {
  return {
    en: {
      eyebrow: 'Reports · this property',
      italic: 'At a glance',
      mtd: 'MTD',
      inventoryValue: 'Inventory value',
      skus: 'items',
      valuedToday: 'valued today',
      pricedNote: (p: number, t: number) => `${p} of ${t} items have a price`,
      itemsTracked: 'Items tracked',
      counted: 'counted',
      notCountedYet: 'not counted yet',
      needsAttention: 'Needs attention',
      critical: 'critical',
      low: 'low',
      allStocked: 'all items look stocked',
      valueByCategory: 'Value by category',
      thisMonth: 'This month',
      actualUsed: 'Actual used',
      usagePending: 'Usage pending',
      pendingNote: 'Close the month after the ending count to calculate actual usage.',
      partialActual: 'Partial month actual',
      totalOnlyActual: 'Total only · no category split',
      purchasesLogged: 'Purchases logged',
      purchasesConfirmed: 'Purchases confirmed at close',
      loggedDeliverySubtotal: 'Logged delivery subtotal',
      purchaseCostsMissing: 'some delivery costs are missing',
      lossCostsMissing: 'some loss costs are missing',
      noDeliveriesYet: 'No purchases logged yet.',
      thrownOut: 'thrown out',
      lastCount: 'Last count',
      noCountsYet: 'No counts yet',
      monthlyTrend: 'Monthly trend',
      usageByMonth: 'Actual usage by month',
      lastNMonths: (n: number) => ` · last ${n} months`,
      comingSoon: 'Coming soon',
      trendSoon: 'Fills in after two monthly inventory closes.',
      partialTrendNote: '∗ Partial month — not compared with a full-month budget.',
      shrinkageRate: 'Shrinkage',
      shrinkageSoon: 'Needs a few counts and deliveries to compare — fills in automatically.',
      mtdLoss: 'MTD loss',
      costPerOccRoom: 'Cost / occupied room',
      costSoon: 'Needs real occupancy data from your hotel system.',
      occNights: 'occupied room-nights',
      loading: 'Loading…',
      loadFailed: 'Couldn’t load monthly accounting. Try again.',
    },
    es: {
      eyebrow: 'Informes · esta propiedad',
      italic: 'De un vistazo',
      mtd: 'del mes',
      inventoryValue: 'Valor del inventario',
      skus: 'artículos',
      valuedToday: 'valorado hoy',
      pricedNote: (p: number, t: number) => `${p} de ${t} artículos tienen precio`,
      itemsTracked: 'Artículos registrados',
      counted: 'contados',
      notCountedYet: 'sin contar aún',
      needsAttention: 'Necesitan atención',
      critical: 'críticos',
      low: 'bajos',
      allStocked: 'todo se ve abastecido',
      valueByCategory: 'Valor por categoría',
      thisMonth: 'Este mes',
      actualUsed: 'Uso real',
      usagePending: 'Uso pendiente',
      pendingNote: 'Cierre el mes después del conteo final para calcular el uso real.',
      partialActual: 'Uso real de mes parcial',
      totalOnlyActual: 'Solo total · sin desglose por categoría',
      purchasesLogged: 'Compras registradas',
      purchasesConfirmed: 'Compras confirmadas al cierre',
      loggedDeliverySubtotal: 'Subtotal de entregas registradas',
      purchaseCostsMissing: 'faltan costos de algunas entregas',
      lossCostsMissing: 'faltan costos de algunas pérdidas',
      noDeliveriesYet: 'Aún no hay compras registradas.',
      thrownOut: 'desechado',
      lastCount: 'Último conteo',
      noCountsYet: 'Aún no hay conteos',
      monthlyTrend: 'Tendencia mensual',
      usageByMonth: 'Uso real por mes',
      lastNMonths: (n: number) => ` · últimos ${n} meses`,
      comingSoon: 'Próximamente',
      trendSoon: 'Se completa después de dos cierres mensuales de inventario.',
      partialTrendNote: '∗ Mes parcial — no se compara con un presupuesto mensual completo.',
      shrinkageRate: 'Merma',
      shrinkageSoon: 'Necesita algunos conteos y entregas para comparar — se completa automáticamente.',
      mtdLoss: 'pérdida del mes',
      costPerOccRoom: 'Costo / hab. ocupada',
      costSoon: 'Necesita datos reales de ocupación de su sistema hotelero.',
      occNights: 'noches-hab. ocupadas',
      loading: 'Cargando…',
      loadFailed: 'No se pudo cargar la contabilidad mensual. Intente de nuevo.',
    },
  }[lang];
}

interface YtdRow {
  monthStart: string;
  receiptsValue: number;
  purchasesValue: number | null;
  actualUsageValue: number | null;
  actualStatus: 'pending' | 'complete' | 'partial' | 'unallocated';
  isPartial: boolean;
  discardsValue: number | null;
  knownDiscardsValue: number;
  discardsComplete: boolean;
}

interface SummaryShape {
  monthKey: string;
  monthStart: string;
  totals: {
    openingValue: number | null;
    receiptsValue: number;
    loggedPurchasesValue: number | null;
    knownLoggedPurchasesValue: number;
    purchasesValue: number | null;
    actualUsageValue: number | null;
    actualStatus: 'pending' | 'complete' | 'partial' | 'unallocated';
    allocation: 'pending' | 'itemized' | 'total_only';
    isPartial: boolean;
    budgetComparisonAvailable: boolean;
    discardsValue: number | null;
    knownDiscardsValue: number;
    discardsComplete: boolean;
    closingValue: number | null;
    unaccountedShrinkageValue: number | null;
    knownUnaccountedShrinkageValue: number;
    shrinkageComplete: boolean;
    budgetCents: number | null;
    spendCents: number | null;
  };
  byCategory: Array<{ reconciliationsThisMonth: number }>;
  ytd: YtdRow[];
  costPerOccupiedRoom: {
    thisMonth: number | null;
    occupiedNightsThisMonth: number;
  };
}

export function ReportsPanel({ lang, open, onClose, display, customNameById, timezone }: ReportsPanelProps) {
  const { user } = useAuth();
  const { activePropertyId } = useProperty();
  const rp = rpStrings(lang);
  const [summary, setSummary] = useState<SummaryShape | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);

  useEffect(() => {
    if (!open || !user || !activePropertyId) return;
    let cancelled = false;
    setLoading(true);
    setLoadFailed(false);
    setSummary(null);
    void (async () => {
      try {
        const res = await fetchWithAuth(
          `/api/inventory/accounting-summary?propertyId=${activePropertyId}`,
          { cache: 'no-store' },
        );
        if (!res.ok) {
          if (!cancelled) setLoadFailed(true);
          return;
        }
        const json = (await res.json()) as { ok: boolean; data: SummaryShape };
        if (cancelled) return;
        if (json.ok) setSummary(json.data);
        else setLoadFailed(true);
      } catch (err) {
        console.error('[reports] load failed', err);
        if (!cancelled) setLoadFailed(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [open, user, activePropertyId]);

  // ── Day-one stats — computed from the live item list, always real ────────
  // Memoized: this panel stays mounted while closed (the Overlay needs `open`
  // for its exit animation), and the shell re-renders on every quick-count
  // tick — don't re-scan the item list each time.
  const stats = useMemo(() => {
    const totalValue = display.reduce((s, d) => s + d.value, 0);
    const pricedCount = display.filter((d) => d.raw.unitCost != null).length;
    const valueComplete = display.every(
      (d) => (d.raw.currentStock ?? 0) <= 0 || d.raw.unitCost != null,
    );
    const uncountedCount = display.filter((d) => d.uncounted).length;
    const criticalCount = display.filter((d) => !d.uncounted && d.status === 'critical').length;
    const lowCount = display.filter((d) => !d.uncounted && d.status === 'low').length;
    const lastCountAt = display.reduce<Date | null>(
      (acc, d) => (d.lastCountedAt && (!acc || d.lastCountedAt > acc) ? d.lastCountedAt : acc),
      null,
    );
    // Value by category — custom tabs by their hotel-chosen name, built-ins by
    // their translated label. Sorted by value, zero-value groups dropped.
    const catRows: Array<{ key: string; label: string; value: number; complete: boolean }> = [];
    const byKey = new Map<string, { label: string; value: number; complete: boolean }>();
    for (const d of display) {
      const key = d.customCategoryId ?? d.cat;
      const label = d.customCategoryId
        ? customNameById.get(d.customCategoryId) ?? catLabelFor(lang, d.cat as InvCat)
        : catLabelFor(lang, d.cat as InvCat);
      const cur = byKey.get(key) ?? { label, value: 0, complete: true };
      cur.value += d.value;
      if ((d.raw.currentStock ?? 0) > 0 && d.raw.unitCost == null) cur.complete = false;
      byKey.set(key, cur);
    }
    for (const [key, v] of byKey) if (v.value > 0) catRows.push({ key, ...v });
    catRows.sort((a, b) => b.value - a.value);
    return { totalValue, valueComplete, pricedCount, uncountedCount, countedCount: display.length - uncountedCount, criticalCount, lowCount, lastCountAt, catRows };
  }, [display, customNameById, lang]);
  const { totalValue, valueComplete, pricedCount, uncountedCount, countedCount, criticalCount, lowCount, lastCountAt, catRows } = stats;

  // ── History-dependent stats — shown only when the data exists ────────────
  // Logged receipts are purchases. They are never substituted for actual
  // usage, and an incomplete cost subtotal is labeled instead of shown as a
  // complete total.
  const loggedPurchases = summary ? summary.totals.loggedPurchasesValue : 0;
  const knownLoggedPurchases = summary?.totals.knownLoggedPurchasesValue
    ?? summary?.totals.receiptsValue
    ?? 0;
  const loggedPurchaseText = loggedPurchases == null
    ? `≥ ${fmtMoney(knownLoggedPurchases)} · ${rp.purchaseCostsMissing}`
    : fmtMoney(loggedPurchases);
  // The aggregate can include a live purchase preview for an open period.
  // Only a period with a persisted usage actual has confirmed close purchases.
  const confirmedPurchases = summary?.totals.actualUsageValue != null
    ? summary.totals.purchasesValue
    : null;
  const purchaseText = confirmedPurchases != null ? fmtMoney(confirmedPurchases) : loggedPurchaseText;
  const purchaseLabel = confirmedPurchases != null ? rp.purchasesConfirmed : rp.purchasesLogged;
  const showLoggedReconciliation = confirmedPurchases != null && (
    loggedPurchases == null || Math.abs(confirmedPurchases - loggedPurchases) >= 0.005
  );
  const actualUsage = summary?.totals.actualUsageValue ?? null;
  const actualStatus = summary?.totals.actualStatus ?? 'pending';
  const allocation = summary?.totals.allocation ?? 'pending';
  const knownDiscards = summary?.totals.knownDiscardsValue
    ?? summary?.totals.discardsValue
    ?? 0;
  const discardsComplete = summary?.totals.discardsComplete ?? true;
  const discardText = `${discardsComplete ? '' : '≥ '}${fmtMoney(knownDiscards)}`;
  const hasDiscards = knownDiscards > 0 || !discardsComplete;
  const ytd = (summary?.ytd ?? []).slice().sort((a, b) => a.monthStart.localeCompare(b.monthStart));
  const closedMonths = ytd.filter((r) => r.actualUsageValue != null && r.actualStatus !== 'pending');
  const trendReady = closedMonths.length >= 2;

  const reconciliations = (summary?.byCategory ?? []).reduce(
    (s, c) => s + (c.reconciliationsThisMonth || 0),
    0,
  );
  const knownShrinkage = summary?.totals.knownUnaccountedShrinkageValue
    ?? summary?.totals.unaccountedShrinkageValue
    ?? 0;
  const shrinkageComplete = summary?.totals.shrinkageComplete ?? true;
  const shrinkageReady = reconciliations > 0 || knownShrinkage > 0 || !shrinkageComplete;
  // Shrinkage is a percentage of actual usage, not of purchases. Until the
  // month closes, keep the honest dollar loss instead of inventing a ratio.
  const shrinkagePct = shrinkageComplete && actualStatus !== 'partial' && actualUsage != null && actualUsage > 0
    ? Math.min(100, (knownShrinkage / actualUsage) * 100)
    : null;

  // Real cost/occ-room from the server (actual occupancy) — null when the
  // hotel has no occupancy data. Never approximated client-side.
  const costPerOccRoom = summary?.costPerOccupiedRoom?.thisMonth ?? null;
  const occNights = summary?.costPerOccupiedRoom?.occupiedNightsThisMonth ?? 0;
  const reportMonthKey = inventoryReportMonthKey(
    summary?.monthKey,
    summary?.monthStart,
    timezone,
  );
  const reportMonthLabel = formatInventoryMonthKey(reportMonthKey, lang === 'es' ? 'es' : 'en');


  return (
    <Overlay
      open={open}
      onClose={onClose}
      eyebrow={rp.eyebrow}
      italic={rp.italic}
      suffix={`${reportMonthLabel}, ${rp.mtd}`}
      width={1080}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {/* Row 1 — always-real, day-one stats */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
          <KPI
            eyebrow={rp.inventoryValue}
            value={`${valueComplete ? '' : '≥ '}${fmtMoney(totalValue)}`}
            cohort={{
              left: `${display.length} ${rp.skus}`,
              right: pricedCount < display.length
                ? rp.pricedNote(pricedCount, display.length)
                : rp.valuedToday,
            }}
          />
          <KPI
            eyebrow={rp.itemsTracked}
            value={String(display.length)}
            cohort={{
              left: `${countedCount} ${rp.counted}`,
              right: uncountedCount > 0 ? `${uncountedCount} ${rp.notCountedYet}` : (
                lastCountAt ? `${rp.lastCount}: ${shortDateFromDate(lastCountAt, lang)}` : rp.noCountsYet
              ),
            }}
          />
          <KPI
            eyebrow={rp.needsAttention}
            value={String(criticalCount + lowCount)}
            accent={criticalCount > 0 ? statusColor.critical : lowCount > 0 ? statusColor.low : undefined}
            cohort={
              criticalCount + lowCount > 0
                ? { left: `${criticalCount} ${rp.critical}`, right: `${lowCount} ${rp.low}` }
                : { left: rp.allStocked, right: '' }
            }
          />
        </div>

        {/* Row 2 — shelf value by category + monthly actual/purchases */}
        <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr', gap: 10 }}>
          <Card title={rp.valueByCategory}>
            {catRows.length === 0 ? (
              <EmptyText>{rp.noCountsYet}</EmptyText>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {catRows.map((c) => {
                  const pct = totalValue > 0 ? c.value / totalValue : 0;
                  return (
                    <div key={c.key}>
                      <div style={{
                        display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
                        fontFamily: fonts.sans, fontSize: 13, color: T.ink, marginBottom: 4,
                      }}>
                        <span>{c.label}</span>
                        <span style={{ fontFamily: fonts.mono, fontSize: 12, color: T.ink2 }}>
                          {c.complete ? fmtMoney(c.value) : `≥ ${fmtMoney(c.value)}`}
                        </span>
                      </div>
                      <div style={{ height: 6, borderRadius: 6, background: T.ruleSoft, overflow: 'hidden' }}>
                        <div style={{
                          height: '100%', width: `${Math.max(2, pct * 100)}%`,
                          background: T.sageDeep, borderRadius: 6,
                        }} />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </Card>
          <Card title={rp.thisMonth}>
            {loading && !summary ? (
              <EmptyText>{rp.loading}</EmptyText>
            ) : loadFailed && !summary ? (
              <EmptyText>{rp.loadFailed}</EmptyText>
            ) : actualUsage != null ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ fontFamily: fonts.sans, fontSize: 34, fontWeight: 600, color: T.ink, letterSpacing: '-0.02em' }}>
                  {fmtMoney(actualUsage)}
                </div>
                <div style={{ fontFamily: fonts.mono, fontSize: 10, color: T.ink3, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
                  {actualStatus === 'partial' ? rp.partialActual : rp.actualUsed}
                  {allocation === 'total_only' ? ` · ${rp.totalOnlyActual}` : ''}
                </div>
                <div style={{ paddingTop: 8, borderTop: `1px solid ${T.ruleSoft}`, fontFamily: fonts.sans, fontSize: 12.5, color: T.ink2 }}>
                  {purchaseLabel}: {purchaseText}
                  {hasDiscards ? ` · ${discardText} ${rp.thrownOut}` : ''}
                </div>
                {showLoggedReconciliation && (
                  <div style={{ fontFamily: fonts.sans, fontSize: 11.5, color: T.ink3 }}>
                    {rp.loggedDeliverySubtotal}: {loggedPurchaseText}
                  </div>
                )}
              </div>
            ) : (
              <div role="status" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ fontFamily: fonts.sans, fontSize: 21, fontWeight: 600, color: T.ink }}>
                  {rp.usagePending}
                </div>
                <EmptyText>{rp.pendingNote}</EmptyText>
                <div style={{ paddingTop: 8, borderTop: `1px solid ${T.ruleSoft}`, fontFamily: fonts.sans, fontSize: 12.5, color: T.ink2 }}>
                  {knownLoggedPurchases > 0 || loggedPurchases == null
                    ? `${rp.purchasesLogged}: ${loggedPurchaseText}`
                    : rp.noDeliveriesYet}
                  {hasDiscards ? ` · ${discardText} ${rp.thrownOut}` : ''}
                </div>
              </div>
            )}
          </Card>
        </div>

        {/* Row 3 — usage trend: real chart once ≥2 months are closed.
            Feed ALL months (zero months included) so gaps show as gaps — two
            spikes five months apart must not render as adjacent bars. */}
        {trendReady ? (
          <MonthlyChart ytd={ytd} rp={rp} lang={lang} />
        ) : (
          <ComingSoonCard title={rp.usageByMonth} note={rp.trendSoon} soon={rp.comingSoon} />
        )}

        {/* Row 4 — shrinkage + cost/occ-room: real when computable, honest otherwise */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          {shrinkageReady ? (
            <KPI
              eyebrow={rp.shrinkageRate}
              value={shrinkagePct != null
                ? `${shrinkagePct.toFixed(1)}%`
                : `${shrinkageComplete ? '' : '≥ '}${fmtMoney(knownShrinkage)}`}
              cohort={shrinkagePct != null
                ? { left: fmtMoney(knownShrinkage), right: rp.mtdLoss }
                : { left: rp.mtdLoss, right: shrinkageComplete ? '' : rp.lossCostsMissing }}
            />
          ) : (
            <ComingSoonCard title={rp.shrinkageRate} note={rp.shrinkageSoon} soon={rp.comingSoon} />
          )}
          {costPerOccRoom != null ? (
            <KPI
              eyebrow={rp.costPerOccRoom}
              value={fmtMoney(costPerOccRoom, { digits: 2 })}
              cohort={{ left: `${occNights} ${rp.occNights}`, right: rp.mtd }}
            />
          ) : (
            <ComingSoonCard title={rp.costPerOccRoom} note={rp.costSoon} soon={rp.comingSoon} />
          )}
        </div>
      </div>
    </Overlay>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div
      style={{
        background: T.paper,
        border: `1px solid ${T.rule}`,
        borderRadius: 16,
        padding: '18px 20px',
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        minHeight: 120,
      }}
    >
      <Caps>{title}</Caps>
      {children}
    </div>
  );
}

function EmptyText({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontFamily: fonts.sans, fontSize: 13, color: T.ink3, lineHeight: 1.5 }}>
      {children}
    </div>
  );
}

function ComingSoonCard({ title, note, soon }: { title: string; note: string; soon: string }) {
  return (
    <div
      style={{
        border: `1.5px dashed ${T.rule}`,
        borderRadius: 16,
        padding: '18px 20px',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        minHeight: 120,
        background: 'transparent',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <Caps>{title}</Caps>
        <span
          style={{
            padding: '1px 7px',
            borderRadius: 999,
            background: T.inkWash,
            border: `1px solid ${T.rule}`,
            fontFamily: fonts.mono,
            fontSize: 9,
            fontWeight: 600,
            letterSpacing: '0.06em',
            textTransform: 'uppercase',
            color: T.dim,
          }}
        >
          {soon}
        </span>
      </div>
      <div style={{ fontFamily: fonts.sans, fontSize: 13, color: T.ink3, lineHeight: 1.5 }}>
        {note}
      </div>
    </div>
  );
}

function KPI({
  eyebrow,
  value,
  accent,
  cohort,
}: {
  eyebrow: string;
  value: string;
  accent?: string;
  cohort?: { left: string; right: string };
}) {
  return (
    <div
      style={{
        background: T.paper,
        border: `1px solid ${T.rule}`,
        borderRadius: 16,
        padding: '18px 20px',
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        minHeight: 120,
      }}
    >
      <Caps>{eyebrow}</Caps>
      <div
        style={{
          fontFamily: fonts.sans,
          fontSize: 42,
          color: accent ?? T.ink,
          letterSpacing: '-0.02em',
          lineHeight: 1,
          fontWeight: 600,
        }}
      >
        {value}
      </div>
      {cohort && (
        <div
          style={{
            paddingTop: 10,
            borderTop: `1px solid ${T.ruleSoft}`,
            display: 'flex',
            justifyContent: 'space-between',
            fontFamily: fonts.mono,
            fontSize: 10,
            color: T.ink3,
            letterSpacing: '0.06em',
            textTransform: 'uppercase',
          }}
        >
          <span>{cohort.left}</span>
          <span>{cohort.right}</span>
        </div>
      )}
    </div>
  );
}

function MonthlyChart({ ytd, rp, lang }: { ytd: YtdRow[]; rp: ReturnType<typeof rpStrings>; lang: Lang }) {
  const data = ytd.slice(-7);
  const max = data.length > 0 ? Math.max(...data.map((d) => d.actualUsageValue ?? 0), 1) : 1;
  const hasPartial = data.some((d) => d.actualStatus === 'partial' || d.isPartial);
  return (
    <div
      style={{
        background: T.paper,
        border: `1px solid ${T.rule}`,
        borderRadius: 16,
        padding: '18px 22px',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 14 }}>
        <div>
          <Caps>{rp.monthlyTrend}</Caps>
          <h3
            style={{
              fontFamily: fonts.sans,
              fontSize: 20,
              color: T.ink,
              margin: '2px 0 0',
              letterSpacing: '-0.02em',
              fontWeight: 600,
            }}
          >
            <span>{rp.usageByMonth}</span>
            <span style={{ color: T.ink3 }}>{rp.lastNMonths(data.length)}</span>
          </h3>
        </div>
      </div>
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-end',
          gap: 22,
          height: 160,
          borderBottom: `1px solid ${T.rule}`,
          paddingBottom: 8,
        }}
      >
        {data.map((d, i) => {
          const value = d.actualUsageValue;
          const sH = (Math.max(0, value ?? 0) / max) * 150;
          const cur = i === data.length - 1;
          const monthLabel = shortMonthFromYmd(d.monthStart, lang);
          const partial = d.actualStatus === 'partial' || d.isPartial;
          return (
            <div
              key={d.monthStart}
              aria-label={value == null
                ? `${monthLabel}: ${rp.usagePending}`
                : `${monthLabel}: ${fmtMoney(value)}${partial ? `, ${rp.partialActual}` : ''}`}
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: 6,
                position: 'relative',
                flex: 1,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'flex-end', height: 150 }}>
                <span
                  style={{
                    width: 28,
                    height: value == null ? 2 : Math.max(2, sH),
                    background: value == null
                      ? T.rule
                      : (cur ? T.sageDeep : `${T.sageDeep}66`),
                    borderRadius: '4px 4px 0 0',
                  }}
                />
              </div>
              <span
                style={{
                  fontFamily: fonts.mono,
                  fontSize: 10,
                  color: cur ? T.ink : T.ink3,
                  letterSpacing: '0.06em',
                  textTransform: 'uppercase',
                }}
              >
                {monthLabel}{partial ? '∗' : ''}
              </span>
            </div>
          );
        })}
      </div>
      {hasPartial && (
        <div style={{ marginTop: 10, fontFamily: fonts.sans, fontSize: 11.5, color: T.ink3 }}>
          {rp.partialTrendNote}
        </div>
      )}
    </div>
  );
}
