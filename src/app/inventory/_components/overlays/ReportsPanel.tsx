'use client';

// Reports v2 (2026-07-18): every number on this panel is either computed from
// real data or explicitly marked "coming soon". The old panel showed a
// cost-per-occupied-room built on a hard-coded 78% occupancy guess and a
// "0.0%" shrinkage rate on hotels with no history — both read as real data.
// Rules now:
//   • Day-one stats (inventory value, items, needs-attention, value by
//     category) come straight from the live item list — always real.
//   • This-month spend comes from the delivery ledger; when the hotel has
//     never logged a delivery it says so instead of showing $0 as a stat.
//   • Trend, shrinkage and cost/occupied-room render as "coming soon" cards
//     until the underlying data actually exists (months of deliveries,
//     count-vs-delivery reconciliations, real occupancy).

import React, { useEffect, useMemo, useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { useProperty } from '@/contexts/PropertyContext';
import { fetchWithAuth } from '@/lib/api-fetch';

import { currentMonthLabel, shortDateFromDate, shortMonthFromYmd } from '@/lib/format-date';
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
      deliveriesReceived: 'Spent on deliveries',
      noDeliveriesYet: 'No deliveries logged yet — spend shows up here once a delivery is added.',
      thrownOut: 'thrown out',
      lastCount: 'Last count',
      noCountsYet: 'No counts yet',
      monthlyTrend: 'Monthly trend',
      spendByMonth: 'Spend by month',
      lastNMonths: (n: number) => ` · last ${n} months`,
      comingSoon: 'Coming soon',
      trendSoon: 'Fills in automatically after a couple of months of deliveries.',
      shrinkageRate: 'Shrinkage',
      shrinkageSoon: 'Needs a few counts and deliveries to compare — fills in automatically.',
      mtdLoss: 'MTD loss',
      costPerOccRoom: 'Cost / occupied room',
      costSoon: 'Needs real occupancy data from your hotel system.',
      occNights: 'occupied room-nights',
      loading: 'Loading…',
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
      deliveriesReceived: 'Gastado en entregas',
      noDeliveriesYet: 'Aún no hay entregas registradas — el gasto aparecerá aquí al agregar una entrega.',
      thrownOut: 'desechado',
      lastCount: 'Último conteo',
      noCountsYet: 'Aún no hay conteos',
      monthlyTrend: 'Tendencia mensual',
      spendByMonth: 'Gasto por mes',
      lastNMonths: (n: number) => ` · últimos ${n} meses`,
      comingSoon: 'Próximamente',
      trendSoon: 'Se completa automáticamente tras un par de meses de entregas.',
      shrinkageRate: 'Merma',
      shrinkageSoon: 'Necesita algunos conteos y entregas para comparar — se completa automáticamente.',
      mtdLoss: 'pérdida del mes',
      costPerOccRoom: 'Costo / hab. ocupada',
      costSoon: 'Necesita datos reales de ocupación de su sistema hotelero.',
      occNights: 'noches-hab. ocupadas',
      loading: 'Cargando…',
    },
  }[lang];
}

interface YtdRow {
  monthStart: string;
  receiptsValue: number;
  discardsValue: number;
}

interface SummaryShape {
  totals: {
    openingValue: number;
    receiptsValue: number;
    discardsValue: number;
    closingValue: number;
    unaccountedShrinkageValue: number;
    budgetCents: number | null;
    spendCents: number;
  };
  byCategory: Array<{ reconciliationsThisMonth: number }>;
  ytd: YtdRow[];
  costPerOccupiedRoom: {
    thisMonth: number | null;
    occupiedNightsThisMonth: number;
  };
}

export function ReportsPanel({ lang, open, onClose, display, customNameById }: ReportsPanelProps) {
  const { user } = useAuth();
  const { activePropertyId } = useProperty();
  const rp = rpStrings(lang);
  const [summary, setSummary] = useState<SummaryShape | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open || !user || !activePropertyId) return;
    setLoading(true);
    void (async () => {
      try {
        // Send the viewer's time zone so the server bounds "this month" on the
        // same local clock the Budgets overlay uses (month.ts) — otherwise a
        // delivery received the evening of the 31st lands in different months
        // on the two screens.
        const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
        const res = await fetchWithAuth(
          `/api/inventory/accounting-summary?propertyId=${activePropertyId}&tz=${encodeURIComponent(tz)}`,
          { cache: 'no-store' },
        );
        if (!res.ok) return;
        const json = (await res.json()) as { ok: boolean; data: SummaryShape };
        if (json.ok) setSummary(json.data);
      } catch (err) {
        console.error('[reports] load failed', err);
      } finally {
        setLoading(false);
      }
    })();
  }, [open, user, activePropertyId]);

  // ── Day-one stats — computed from the live item list, always real ────────
  // Memoized: this panel stays mounted while closed (the Overlay needs `open`
  // for its exit animation), and the shell re-renders on every quick-count
  // tick — don't re-scan the item list each time.
  const stats = useMemo(() => {
    const totalValue = display.reduce((s, d) => s + d.value, 0);
    const pricedCount = display.filter((d) => d.unitCost > 0).length;
    const uncountedCount = display.filter((d) => d.uncounted).length;
    const criticalCount = display.filter((d) => !d.uncounted && d.status === 'critical').length;
    const lowCount = display.filter((d) => !d.uncounted && d.status === 'low').length;
    const lastCountAt = display.reduce<Date | null>(
      (acc, d) => (d.lastCountedAt && (!acc || d.lastCountedAt > acc) ? d.lastCountedAt : acc),
      null,
    );
    // Value by category — custom tabs by their hotel-chosen name, built-ins by
    // their translated label. Sorted by value, zero-value groups dropped.
    const catRows: Array<{ key: string; label: string; value: number }> = [];
    const byKey = new Map<string, { label: string; value: number }>();
    for (const d of display) {
      const key = d.customCategoryId ?? d.cat;
      const label = d.customCategoryId
        ? customNameById.get(d.customCategoryId) ?? catLabelFor(lang, d.cat as InvCat)
        : catLabelFor(lang, d.cat as InvCat);
      const cur = byKey.get(key) ?? { label, value: 0 };
      cur.value += d.value;
      byKey.set(key, cur);
    }
    for (const [key, v] of byKey) if (v.value > 0) catRows.push({ key, ...v });
    catRows.sort((a, b) => b.value - a.value);
    return { totalValue, pricedCount, uncountedCount, countedCount: display.length - uncountedCount, criticalCount, lowCount, lastCountAt, catRows };
  }, [display, customNameById, lang]);
  const { totalValue, pricedCount, uncountedCount, countedCount, criticalCount, lowCount, lastCountAt, catRows } = stats;

  // ── History-dependent stats — shown only when the data exists ────────────
  const receipts = summary?.totals.receiptsValue ?? 0;
  const discards = summary?.totals.discardsValue ?? 0;
  const ytd = (summary?.ytd ?? []).slice().sort((a, b) => a.monthStart.localeCompare(b.monthStart));
  const monthsWithActivity = ytd.filter((r) => r.receiptsValue > 0 || r.discardsValue > 0);
  const anyDeliveryEver = monthsWithActivity.length > 0 || receipts > 0;
  const trendReady = monthsWithActivity.length >= 2;

  const reconciliations = (summary?.byCategory ?? []).reduce(
    (s, c) => s + (c.reconciliationsThisMonth || 0),
    0,
  );
  const shrinkage = summary?.totals.unaccountedShrinkageValue ?? 0;
  const shrinkageReady = reconciliations > 0 || shrinkage > 0;
  // A % of spend only exists when there IS spend — with $ loss but no
  // deliveries this month, showing "0.0%" would be the fake number this
  // rebuild exists to kill. In that case the $ figure becomes the headline.
  const shrinkagePct = receipts > 0 ? Math.min(100, (shrinkage / receipts) * 100) : null;

  // Real cost/occ-room from the server (actual occupancy) — null when the
  // hotel has no occupancy data. Never approximated client-side.
  const costPerOccRoom = summary?.costPerOccupiedRoom?.thisMonth ?? null;
  const occNights = summary?.costPerOccupiedRoom?.occupiedNightsThisMonth ?? 0;


  return (
    <Overlay
      open={open}
      onClose={onClose}
      eyebrow={rp.eyebrow}
      italic={rp.italic}
      suffix={`${currentMonthLabel(lang)}, ${rp.mtd}`}
      width={1080}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {/* Row 1 — always-real, day-one stats */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
          <KPI
            eyebrow={rp.inventoryValue}
            value={fmtMoney(totalValue)}
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

        {/* Row 2 — value by category + this-month spend */}
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
                          {fmtMoney(c.value)}
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
            ) : anyDeliveryEver ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ fontFamily: fonts.sans, fontSize: 34, fontWeight: 600, color: T.ink, letterSpacing: '-0.02em' }}>
                  {fmtMoney(receipts)}
                </div>
                <div style={{ fontFamily: fonts.mono, fontSize: 10, color: T.ink3, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
                  {rp.deliveriesReceived}
                  {discards > 0 ? ` · ${fmtMoney(discards)} ${rp.thrownOut}` : ''}
                </div>
              </div>
            ) : (
              <EmptyText>{rp.noDeliveriesYet}</EmptyText>
            )}
          </Card>
        </div>

        {/* Row 3 — spend trend: real chart once ≥2 months have activity.
            Feed ALL months (zero months included) so gaps show as gaps — two
            spikes five months apart must not render as adjacent bars. */}
        {trendReady ? (
          <MonthlyChart ytd={ytd} rp={rp} lang={lang} />
        ) : (
          <ComingSoonCard title={rp.spendByMonth} note={rp.trendSoon} soon={rp.comingSoon} />
        )}

        {/* Row 4 — shrinkage + cost/occ-room: real when computable, honest otherwise */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          {shrinkageReady ? (
            <KPI
              eyebrow={rp.shrinkageRate}
              value={shrinkagePct != null ? `${shrinkagePct.toFixed(1)}%` : fmtMoney(shrinkage)}
              cohort={shrinkagePct != null
                ? { left: fmtMoney(shrinkage), right: rp.mtdLoss }
                : { left: rp.mtdLoss, right: '' }}
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
  const max = data.length > 0 ? Math.max(...data.map((d) => d.receiptsValue || 0), 1) : 1;
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
            <span>{rp.spendByMonth}</span>
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
          const sH = (Math.max(0, d.receiptsValue) / max) * 150;
          const cur = i === data.length - 1;
          const monthLabel = shortMonthFromYmd(d.monthStart, lang);
          return (
            <div
              key={d.monthStart}
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
                    height: sH,
                    background: cur ? T.sageDeep : `${T.sageDeep}66`,
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
                {monthLabel}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
