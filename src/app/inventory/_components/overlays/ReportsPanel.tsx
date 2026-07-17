'use client';

import React, { useEffect, useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { useProperty } from '@/contexts/PropertyContext';
import { fetchWithAuth } from '@/lib/api-fetch';

import { currentMonthLabel, shortMonthFromYmd } from '@/lib/format-date';
import { T, fonts, statusColor } from '../tokens';
import { Caps } from '../Caps';
import { Sparkline } from '../Sparkline';
import { Overlay } from './Overlay';
import { fmtMoney } from '../format';
import type { DisplayItem } from '../types';
import { type Lang } from '../inv-i18n';

interface ReportsPanelProps {
  lang: Lang;
  open: boolean;
  onClose: () => void;
  display: DisplayItem[];
}

function rpStrings(lang: Lang) {
  return {
    en: {
      eyebrow: 'Reports · this property',
      italic: 'At a glance',
      mtd: 'MTD',
      costPerOccRoom: 'Cost / occ-room',
      rooms: 'rooms',
      thisProperty: 'this property',
      shrinkageRate: 'Shrinkage rate',
      mtdLoss: 'MTD loss',
      inventoryValue: 'Inventory value',
      skus: 'SKUs',
      valuedToday: 'valued today',
      monthlyTrend: 'Monthly trend',
      spendAndShrinkage: 'Spend & shrinkage',
      lastNMonths: (n: number) => ` · last ${n} months`,
      spend: 'Spend',
      shrinkage: 'Shrinkage',
      loading: 'Loading…',
      notEnoughHistory: 'Not enough history yet',
    },
    es: {
      eyebrow: 'Informes · esta propiedad',
      italic: 'De un vistazo',
      mtd: 'del mes',
      costPerOccRoom: 'Costo / hab. ocupada',
      rooms: 'habitaciones',
      thisProperty: 'esta propiedad',
      shrinkageRate: 'Tasa de merma',
      mtdLoss: 'pérdida del mes',
      inventoryValue: 'Valor del inventario',
      skus: 'SKUs',
      valuedToday: 'valorado hoy',
      monthlyTrend: 'Tendencia mensual',
      spendAndShrinkage: 'Gasto y merma',
      lastNMonths: (n: number) => ` · últimos ${n} meses`,
      spend: 'Gasto',
      shrinkage: 'Merma',
      loading: 'Cargando…',
      notEnoughHistory: 'Aún no hay suficiente historial',
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
  ytd: YtdRow[];
}

export function ReportsPanel({ lang, open, onClose, display }: ReportsPanelProps) {
  const { user } = useAuth();
  const { activePropertyId, activeProperty } = useProperty();
  const rp = rpStrings(lang);
  const [summary, setSummary] = useState<SummaryShape | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open || !user || !activePropertyId) return;
    setLoading(true);
    void (async () => {
      try {
        // Send the viewer's time zone so the server bounds "this month" on the
        // same local clock the Budgets overlay uses (month.ts) — otherwise an
        // order received the evening of the 31st lands in different months on
        // the two screens.
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

  // Derived numbers — values are in dollars (totals from accounting-summary
  // already converted; receipts/discards/closing in dollars).
  const totalRooms = (activeProperty as { totalRooms?: number } | null)?.totalRooms ?? 0;

  // Cost / occ-room — use receipts ÷ rough occupied-room-nights estimate.
  // LOCAL day-of-month: getUTCDate() would already read "1" on the evening of
  // the month's last day in US timezones, skewing the MTD divisor.
  const now = new Date();
  const daysElapsed = Math.max(1, now.getDate());
  // Without a real occupancy figure here we use 78% as a baseline. This is a
  // qualitative metric on the dashboard — the source-of-truth is in the
  // accounting export.
  const occRoomNightsApprox = totalRooms > 0 ? totalRooms * 0.78 * daysElapsed : daysElapsed;
  const receipts = summary?.totals.receiptsValue ?? 0;
  const closing = summary?.totals.closingValue
    ?? display.reduce((s, d) => s + d.value, 0);
  const shrinkage = summary?.totals.unaccountedShrinkageValue ?? 0;
  const costPerOccRoom = receipts / Math.max(1, occRoomNightsApprox);
  const shrinkagePct = receipts > 0 ? Math.min(100, (shrinkage / receipts) * 100) : 0;

  // Build sparklines from the YTD slice (oldest → newest).
  const ytd = (summary?.ytd ?? []).slice().sort((a, b) =>
    a.monthStart.localeCompare(b.monthStart),
  );
  const sparkReceipts = ytd.map((r) => r.receiptsValue);
  const sparkShrinkage = ytd.map((r) => r.discardsValue);

  return (
    <Overlay
      open={open}
      onClose={onClose}
      eyebrow={rp.eyebrow}
      italic={rp.italic}
      suffix={`${currentMonthLabel(lang)}, ${rp.mtd}`}
      width={1080}
      /* No footer: the old month-picker / Compare / Export buttons had no
         handlers — they looked clickable but silently did nothing. Removed
         until those features actually exist. */
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
          <KPI
            eyebrow={rp.costPerOccRoom}
            value={fmtMoney(costPerOccRoom, { digits: 2 })}
            spark={sparkReceipts}
            sparkColor={statusColor.good}
            cohort={{ left: `${totalRooms} ${rp.rooms}`, right: rp.thisProperty }}
          />
          <KPI
            eyebrow={rp.shrinkageRate}
            value={`${shrinkagePct.toFixed(1)}%`}
            spark={sparkShrinkage}
            sparkColor={T.warm}
            cohort={{ left: fmtMoney(shrinkage), right: rp.mtdLoss }}
          />
          <KPI
            eyebrow={rp.inventoryValue}
            value={fmtMoney(closing)}
            spark={ytd.length > 0 ? ytd.map((r) => r.receiptsValue + r.discardsValue) : sparkReceipts}
            sparkColor={T.caramelDeep}
            cohort={{ left: `${display.length} ${rp.skus}`, right: rp.valuedToday }}
          />
        </div>
        <MonthlyChart ytd={ytd} loading={loading} rp={rp} lang={lang} />
      </div>
    </Overlay>
  );
}

function KPI({
  eyebrow,
  value,
  spark,
  sparkColor,
  cohort,
}: {
  eyebrow: string;
  value: string;
  spark?: number[];
  sparkColor?: string;
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
        minHeight: 160,
      }}
    >
      <Caps>{eyebrow}</Caps>
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-end',
          justifyContent: 'space-between',
          gap: 14,
        }}
      >
        <div>
          <div
            style={{
              fontFamily: fonts.sans,
              fontSize: 42,
              color: T.ink,
              letterSpacing: '-0.02em',
              lineHeight: 1,
              fontWeight: 600,
            }}
          >
            {value}
          </div>
        </div>
        {spark && spark.length >= 2 && (
          <Sparkline values={spark} color={sparkColor} width={90} height={32} />
        )}
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

function MonthlyChart({ ytd, loading, rp, lang }: { ytd: YtdRow[]; loading: boolean; rp: ReturnType<typeof rpStrings>; lang: Lang }) {
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
            <span>{rp.spendAndShrinkage}</span>
            <span style={{ color: T.ink3 }}>{rp.lastNMonths(data.length)}</span>
          </h3>
        </div>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 16,
            fontFamily: fonts.mono,
            fontSize: 10,
            color: T.ink2,
            letterSpacing: '0.06em',
            textTransform: 'uppercase',
          }}
        >
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <span style={{ width: 10, height: 10, borderRadius: 2, background: T.sageDeep }} />
            {rp.spend}
          </span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <span style={{ width: 10, height: 10, borderRadius: 2, background: T.warm }} />
            {rp.shrinkage}
          </span>
        </div>
      </div>
      {data.length === 0 ? (
        <div
          style={{
            height: 160,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontFamily: fonts.sans,
            fontSize: 13,
            color: T.ink3,
          }}
        >
          {loading ? rp.loading : rp.notEnoughHistory}
        </div>
      ) : (
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
            // Visual amplification on shrinkage so it stays visible alongside spend.
            const shH = Math.min(150, (Math.max(0, d.discardsValue) / max) * 150 * 6);
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
                <div style={{ display: 'flex', alignItems: 'flex-end', gap: 3, height: 150 }}>
                  <span
                    style={{
                      width: 24,
                      height: sH,
                      background: cur ? T.sageDeep : `${T.sageDeep}66`,
                      borderRadius: '4px 4px 0 0',
                    }}
                  />
                  <span
                    style={{
                      width: 14,
                      height: shH,
                      background: cur ? T.warm : `${T.warm}66`,
                      borderRadius: '4px 4px 0 0',
                    }}
                  />
                </div>
                <span
                  style={{
                    fontFamily: fonts.mono,
                    fontSize: 10,
                    color: cur ? T.ink : T.ink2,
                    letterSpacing: '0.06em',
                    fontWeight: cur ? 600 : 400,
                  }}
                >
                  {monthLabel}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

