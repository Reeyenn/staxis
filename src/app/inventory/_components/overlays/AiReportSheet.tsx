'use client';

import React, { useEffect, useState } from 'react';
import { useProperty } from '@/contexts/PropertyContext';
import { fetchWithAuth } from '@/lib/api-fetch';

import { T, fonts, statusColor } from '../tokens';
import { Caps } from '../Caps';
import { Serif } from '../Serif';
import { dateLocale, type Lang } from '../inv-i18n';
import { Overlay } from './Overlay';
import { aiStrings, type AiStrings } from './ai-i18n';

// ── Shapes returned by GET /api/inventory/ai-report ──────────────────────────
type ItemStatus = 'graduated' | 'learning' | 'not-enough-data';

interface ReportSummary {
  itemsTotal: number;
  itemsWithModel: number;
  itemsGraduated: number;
  itemsTracked: number;
  gateRatio: number | null;
  lastInferenceAt: string | null;
  lastInferenceStale: boolean;
  predictionsLast7Days: number;
  eventsNeeded: number;
}

interface ReportItem {
  itemId: string;
  itemName: string;
  predictedDailyRate: number | null;
  predictedCurrentStock: number | null;
  predictedAt: string | null;
  lastActualRate: number | null;
  lastPredictedRate: number | null;
  lastErrorPct: number | null;
  loggedAt: string | null;
  status: ItemStatus;
  countEvents: number;
  eventsNeeded: number;
}

interface ReportData {
  summary: ReportSummary;
  items: ReportItem[];
}

type LoadState = 'loading' | 'ready' | 'error';

interface AiReportSheetProps {
  lang: Lang;
  open: boolean;
  onClose: () => void;
}

// The Inventory AI "report card", surfaced as a large overlay on the inventory
// tab (was formerly the standalone /inventory/ai page). The inventory tab
// itself is 100% manual — no ML numbers. The AI keeps predicting silently in
// the background; this overlay is where those predictions are surfaced honestly
// (what it's learned, how accurate it's been, how close each item is to
// graduating). Data fetches from /api/inventory/ai-report when `open` flips true.
export function AiReportSheet({ lang, open, onClose }: AiReportSheetProps) {
  const { activePropertyId } = useProperty();
  const ai = aiStrings(lang);

  const [state, setState] = useState<LoadState>('loading');
  const [data, setData] = useState<ReportData | null>(null);

  // Fetch fresh on every open (when `open` flips true). Reset to loading first
  // so a reopen never flashes the previous property's stale report.
  useEffect(() => {
    if (!open || !activePropertyId) return;
    let cancelled = false;
    setState('loading');
    setData(null);
    void (async () => {
      try {
        const res = await fetchWithAuth(
          `/api/inventory/ai-report?propertyId=${activePropertyId}`,
          { cache: 'no-store' },
        );
        if (!res.ok) throw new Error(`status ${res.status}`);
        const json = (await res.json()) as { data?: ReportData };
        if (cancelled) return;
        if (json.data) {
          setData(json.data);
          setState('ready');
        } else {
          setState('error');
        }
      } catch (err) {
        console.error('[inventory-ai] report load failed', err);
        if (!cancelled) setState('error');
      }
    })();
    return () => { cancelled = true; };
  }, [open, activePropertyId]);

  const summary = data?.summary ?? null;
  const items = data?.items ?? [];

  // "No jobs yet" = the AI has never written a prediction AND has no comparison
  // rows. Distinct from a stale-but-populated model (staleWarning covers that).
  const noJobsYet =
    !!summary &&
    summary.lastInferenceAt == null &&
    summary.itemsWithModel === 0 &&
    items.length === 0;

  const showStale =
    !!summary && !noJobsYet && summary.lastInferenceStale && summary.lastInferenceAt != null;

  return (
    <Overlay
      open={open}
      onClose={onClose}
      accent={T.teal}
      eyebrow={ai.eyebrow}
      italic={ai.title}
      width={1100}
    >
      {/* Intro line — the same honest framing the page carried. */}
      <p
        style={{
          margin: '0 0 24px',
          maxWidth: 720,
          fontFamily: fonts.sans,
          fontSize: 14,
          lineHeight: 1.55,
          color: T.ink2,
        }}
      >
        {ai.subtitle}
      </p>

      {state === 'loading' && <Centered text={ai.loading} />}
      {state === 'error' && <Centered text={ai.loadError} tone="warm" />}

      {state === 'ready' && summary && (
        <>
          <SummaryHeader ai={ai} lang={lang} summary={summary} />

          {noJobsYet && <Banner tone="neutral" text={ai.noJobsWarning} />}
          {showStale && <Banner tone="warm" text={ai.staleWarning} />}

          {items.length === 0 ? (
            <EmptyState ai={ai} />
          ) : (
            <div style={{ marginTop: 26 }}>
              <Caps size={9} style={{ marginBottom: 12, display: 'block' }}>{ai.listHeading}</Caps>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
                {items.map((it) => (
                  <ItemCard key={it.itemId} ai={ai} lang={lang} it={it} />
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </Overlay>
  );
}

// ── Summary header — four stat cards ─────────────────────────────────────────
function SummaryHeader({ ai, lang, summary }: { ai: AiStrings; lang: Lang; summary: ReportSummary }) {
  const accuracyBig =
    summary.gateRatio != null ? ai.pctOff((summary.gateRatio * 100).toFixed(1)) : ai.accuracyPending;
  const lastBig = summary.lastInferenceAt ? relativeWhen(summary.lastInferenceAt, lang, ai) : ai.never;

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
        gap: 12,
      }}
    >
      <StatCard label={ai.itemsTracked} big={String(summary.itemsTracked)} />
      <StatCard
        label={ai.graduated}
        big={`${summary.itemsGraduated} ${ai.of} ${summary.itemsWithModel}`}
      />
      <StatCard label={ai.accuracy} big={accuracyBig} />
      <StatCard
        label={ai.lastPredicted}
        big={lastBig}
        tone={summary.lastInferenceStale && summary.lastInferenceAt != null ? 'warm' : undefined}
      />
    </div>
  );
}

function StatCard({ label, big, tone }: { label: string; big: string; tone?: 'warm' }) {
  return (
    <div
      style={{
        background: T.paper,
        border: `1px solid ${tone === 'warm' ? `${T.warm}44` : T.rule}`,
        borderRadius: 14,
        padding: '16px 18px',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
      }}
    >
      <Caps size={9}>{label}</Caps>
      <span
        style={{
          fontFamily: fonts.serif,
          fontSize: 26,
          fontStyle: 'italic',
          fontWeight: 400,
          letterSpacing: '-0.02em',
          lineHeight: 1.05,
          color: tone === 'warm' ? T.warm : T.ink,
        }}
      >
        {big}
      </span>
    </div>
  );
}

// ── Per-item report card ─────────────────────────────────────────────────────
function ItemCard({ ai, lang, it }: { ai: AiStrings; lang: Lang; it: ReportItem }) {
  const chip = STATUS_CHIP[it.status];
  const chipLabel =
    it.status === 'graduated' ? ai.chipGraduated : it.status === 'learning' ? ai.chipLearning : ai.chipNotEnough;

  const usage =
    it.predictedDailyRate != null ? `${fmtRate(it.predictedDailyRate)}${ai.perDay}` : '—';
  const stock =
    it.predictedCurrentStock != null ? fmtRate(it.predictedCurrentStock) : '—';

  // Comparison line — the honest "how far off was the AI" figure.
  let compareText: string;
  let compareColor: string = T.ink2;
  if (it.lastErrorPct != null) {
    const rounded = it.lastErrorPct < 0.5 ? ai.spotOn : ai.wasOff(it.lastErrorPct.toFixed(0));
    const actualStr = it.lastActualRate != null ? `${fmtRate(it.lastActualRate)}${ai.perDay}` : '—';
    const predStr = it.lastPredictedRate != null ? `${fmtRate(it.lastPredictedRate)}${ai.perDay}` : '—';
    compareText = `${ai.lastCount} ${actualStr} · ${ai.predictionWas} ${predStr} · ${rounded}`;
    compareColor = it.lastErrorPct < 0.5 ? T.forestText : it.lastErrorPct <= 10 ? T.ink2 : T.warm;
  } else {
    compareText = ai.noComparisonYet;
    compareColor = T.ink3;
  }

  const pct = it.eventsNeeded > 0 ? Math.min(1, it.countEvents / it.eventsNeeded) : 0;

  return (
    <div
      style={{
        background: T.paper,
        border: `1px solid ${T.rule}`,
        borderRadius: 13,
        padding: '14px 18px',
        display: 'grid',
        gridTemplateColumns: 'minmax(160px, 1.4fr) 120px 120px minmax(200px, 1.6fr)',
        gap: 18,
        alignItems: 'center',
      }}
    >
      {/* Name + status chip */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
        <span style={{ fontFamily: fonts.sans, fontSize: 14, fontWeight: 600, color: T.ink }}>
          {it.itemName}
        </span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <span
            style={{
              display: 'inline-block',
              width: 6,
              height: 6,
              borderRadius: '50%',
              background: chip.color,
            }}
          />
          <span
            style={{
              fontFamily: fonts.mono,
              fontSize: 9.5,
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
              fontWeight: 600,
              color: chip.color,
            }}
          >
            {chipLabel}
          </span>
        </span>
      </div>

      {/* Predicted usage */}
      <Metric label={ai.predictedUsage} value={usage} />

      {/* Predicted on hand */}
      <Metric label={ai.predictedStock} value={stock} />

      {/* Comparison + count-events progress */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 7, minWidth: 0 }}>
        <span style={{ fontFamily: fonts.sans, fontSize: 12, color: compareColor, lineHeight: 1.4 }}>
          {compareText}
        </span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span
            style={{
              flex: 1,
              display: 'block',
              height: 5,
              borderRadius: 5,
              background: T.ruleSoft,
              overflow: 'hidden',
            }}
          >
            <span
              style={{
                display: 'block',
                height: '100%',
                width: `${pct * 100}%`,
                borderRadius: 5,
                background: it.status === 'graduated' ? statusColor.good : T.teal,
              }}
            />
          </span>
          <span
            style={{
              fontFamily: fonts.mono,
              fontSize: 10,
              color: T.ink3,
              whiteSpace: 'nowrap',
            }}
          >
            {ai.countProgress(Math.min(it.countEvents, it.eventsNeeded), it.eventsNeeded)}
          </span>
        </div>
      </div>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
      <Caps size={8.5}>{label}</Caps>
      <span
        style={{
          fontFamily: fonts.serif,
          fontSize: 18,
          fontStyle: 'italic',
          fontWeight: 400,
          letterSpacing: '-0.02em',
          color: T.ink,
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
      >
        {value}
      </span>
    </div>
  );
}

// ── Empty state ──────────────────────────────────────────────────────────────
function EmptyState({ ai }: { ai: AiStrings }) {
  return (
    <div
      style={{
        marginTop: 26,
        background: T.paper,
        border: `1px solid ${T.rule}`,
        borderRadius: 16,
        padding: '48px 32px',
        textAlign: 'center',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 12,
      }}
    >
      <Serif size={24} style={{ fontStyle: 'italic' }}>{ai.emptyTitle}</Serif>
      <p
        style={{
          margin: 0,
          maxWidth: 460,
          fontFamily: fonts.sans,
          fontSize: 13.5,
          lineHeight: 1.55,
          color: T.ink2,
        }}
      >
        {ai.emptyBody}
      </p>
    </div>
  );
}

// ── Small shared bits ────────────────────────────────────────────────────────
function Banner({ tone, text }: { tone: 'warm' | 'neutral'; text: string }) {
  const warm = tone === 'warm';
  return (
    <div
      style={{
        marginTop: 18,
        background: warm ? T.warmDim : T.inkWash,
        border: `1px solid ${warm ? `${T.warm}33` : T.rule}`,
        borderRadius: 12,
        padding: '13px 16px',
        fontFamily: fonts.sans,
        fontSize: 13,
        lineHeight: 1.5,
        color: warm ? T.warm : T.ink2,
      }}
    >
      {text}
    </div>
  );
}

function Centered({ text, tone }: { text: string; tone?: 'warm' }) {
  return (
    <div
      style={{
        padding: '64px 24px',
        textAlign: 'center',
        fontFamily: fonts.sans,
        fontSize: 14,
        color: tone === 'warm' ? T.warm : T.ink2,
      }}
    >
      {text}
    </div>
  );
}

const STATUS_CHIP: Record<ItemStatus, { color: string }> = {
  graduated: { color: statusColor.good },
  learning: { color: T.teal },
  'not-enough-data': { color: T.ink3 },
};

// Format a rate/stock number: 2 decimals under 10, else whole-ish.
function fmtRate(v: number): string {
  if (!Number.isFinite(v)) return '—';
  if (Math.abs(v) >= 10) return Math.round(v).toLocaleString('en-US');
  return v.toFixed(2);
}

// Relative "3h ago" / "2d ago" using the item date locale.
function relativeWhen(iso: string, lang: Lang, ai: AiStrings): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return ai.never;
  const mins = Math.max(0, Math.floor((Date.now() - then) / 60000));
  if (mins < 60) return lang === 'es' ? `hace ${mins}m` : `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return lang === 'es' ? `hace ${hours}h` : `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return lang === 'es' ? `hace ${days}d` : `${days}d ago`;
  return new Date(iso).toLocaleDateString(dateLocale(lang), { month: 'short', day: 'numeric' });
}
