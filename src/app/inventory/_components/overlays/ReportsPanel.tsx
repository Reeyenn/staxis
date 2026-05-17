'use client';

import React, { useEffect, useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { useProperty } from '@/contexts/PropertyContext';
import { fetchWithAuth } from '@/lib/api-fetch';

import { T, fonts, statusColor } from '../tokens';
import { Caps } from '../Caps';
import { Btn } from '../Btn';
import { Sparkline } from '../Sparkline';
import { Overlay } from './Overlay';
import { fmtMoney } from '../format';
import type { DisplayItem } from '../types';

interface ReportsPanelProps {
  open: boolean;
  onClose: () => void;
  display: DisplayItem[];
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

export function ReportsPanel({ open, onClose, display }: ReportsPanelProps) {
  const { user } = useAuth();
  const { activePropertyId, activeProperty } = useProperty();
  const [summary, setSummary] = useState<SummaryShape | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open || !user || !activePropertyId) return;
    setLoading(true);
    void (async () => {
      try {
        const res = await fetchWithAuth(
          `/api/inventory/accounting-summary?propertyId=${activePropertyId}`,
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
  const now = new Date();
  const daysElapsed = Math.max(1, now.getUTCDate());
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
      eyebrow="Reports · this property"
      italic="At a glance"
      suffix={`${currentMonthLabel()}, MTD`}
      width={1080}
      footer={
        <>
          <Btn variant="ghost" size="md">{currentMonthLabel()} ▾</Btn>
          <Btn variant="ghost" size="md">Compare ▾</Btn>
          <Btn variant="ghost" size="md">Export ↓</Btn>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
          <KPI
            eyebrow="Cost / occ-room"
            value={fmtMoney(costPerOccRoom, { digits: 2 })}
            spark={sparkReceipts}
            sparkColor={statusColor.good}
            cohort={{ left: `${totalRooms} rooms`, right: 'this property' }}
          />
          <KPI
            eyebrow="Shrinkage rate"
            value={`${shrinkagePct.toFixed(1)}%`}
            spark={sparkShrinkage}
            sparkColor={T.warm}
            cohort={{ left: fmtMoney(shrinkage), right: 'MTD loss' }}
          />
          <KPI
            eyebrow="Inventory value"
            value={fmtMoney(closing)}
            spark={ytd.length > 0 ? ytd.map((r) => r.receiptsValue + r.discardsValue) : sparkReceipts}
            sparkColor={T.caramelDeep}
            cohort={{ left: `${display.length} SKUs`, right: 'valued today' }}
          />
        </div>
        <MonthlyChart ytd={ytd} loading={loading} />
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
              fontFamily: fonts.serif,
              fontSize: 42,
              color: T.ink,
              letterSpacing: '-0.03em',
              lineHeight: 1,
              fontWeight: 400,
              fontStyle: 'italic',
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

function MonthlyChart({ ytd, loading }: { ytd: YtdRow[]; loading: boolean }) {
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
          <Caps>Monthly trend</Caps>
          <h3
            style={{
              fontFamily: fonts.serif,
              fontSize: 20,
              color: T.ink,
              margin: '2px 0 0',
              letterSpacing: '-0.02em',
              fontWeight: 400,
            }}
          >
            <span style={{ fontStyle: 'italic' }}>Spend & shrinkage</span>
            <span style={{ color: T.ink3 }}> · last {data.length} months</span>
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
            Spend
          </span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <span style={{ width: 10, height: 10, borderRadius: 2, background: T.warm }} />
            Shrinkage
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
            fontStyle: 'italic',
          }}
        >
          {loading ? 'Loading…' : 'Not enough history yet'}
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
            const monthLabel = shortMonthFromYmd(d.monthStart);
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

function currentMonthLabel(): string {
  return new Date().toLocaleDateString('en-US', { month: 'long' });
}

function shortMonthFromYmd(s: string): string {
  // s is "YYYY-MM-01" or similar — pull the month index and format.
  const m = Number(s.slice(5, 7));
  if (!Number.isFinite(m)) return '—';
  return new Date(Date.UTC(2000, m - 1, 1)).toLocaleDateString('en-US', { month: 'short' });
}
