'use client';

import React, { useEffect, useRef, useState } from 'react';
import { useProperty } from '@/contexts/PropertyContext';
import { fetchWithAuth } from '@/lib/api-fetch';

import { T, fonts, statusColor } from '../tokens';
import { Caps } from '../Caps';
import { Serif } from '../Serif';
import { type Lang } from '../inv-i18n';
import { Overlay } from './Overlay';
import { aiStrings, type AiStrings } from './ai-i18n';
import {
  IconClipboard,
  IconGauge,
  IconTag,
  IconCount,
  IconCompare,
  IconGrade,
  IconBadge,
  IconShield,
  IconMagnify,
} from './ai-icons';

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
  pairsNeeded?: number;
  occupancyDaysMissing?: number;
  occupancyCensusDays?: number;
  occupancyDays?: Array<{ date: string; hasData: boolean }>;
  windowsDroppedIncomplete?: number;
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
  cleanWindows?: number | null;
  prospectivePairs?: number | null;
  pairsNeeded?: number;
  pairSpanDays?: number | null;
  graduationWape?: number | null;
  graduationReason?: string | null;
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

// The Inventory AI screen: a VISUAL tracker (default) built around one
// metaphor — the road every item travels from "Watching" to "Trusted" —
// plus a near-wordless "How it works" layer for complete beginners.
// The inventory tab itself stays 100% manual; this is where the AI's silent
// background work is surfaced honestly.
export function AiReportSheet({ lang, open, onClose }: AiReportSheetProps) {
  const { activePropertyId } = useProperty();
  const ai = aiStrings(lang);

  const [state, setState] = useState<LoadState>('loading');
  const [data, setData] = useState<ReportData | null>(null);

  // Guide layer — stacked ON TOP of the tracker. While it's open, the
  // tracker overlay must ignore its own ESC/scrim close (both listen on
  // window; the ref-gate keeps one ESC from closing both layers).
  const [guideOpen, setGuideOpen] = useState(false);
  const guideOpenRef = useRef(false);
  useEffect(() => { guideOpenRef.current = guideOpen; }, [guideOpen]);
  useEffect(() => { if (!open) setGuideOpen(false); }, [open]);

  // Fetch fresh on every open. Reset to loading first so a reopen never
  // flashes the previous property's stale report.
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
      onClose={() => { if (!guideOpenRef.current) onClose(); }}
      accent={T.teal}
      eyebrow={ai.eyebrow}
      italic={ai.title}
      width={1100}
    >
      {state === 'loading' && <Centered text={ai.loading} />}
      {state === 'error' && <Centered text={ai.loadError} tone="warm" />}

      {state === 'ready' && summary && (
        <>
          {/* ── The hero: how far to trusted predictions, measured by DATA.
                 Centered; the little "How it works" box sits top-right in its
                 own row so it can never overlap the centered text. ── */}
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 2 }}>
            <button
              type="button"
              onClick={() => setGuideOpen(true)}
              style={{
                cursor: 'pointer',
                background: `${T.teal}0d`,
                border: `1.5px solid ${T.teal}55`,
                borderRadius: 12,
                padding: '10px 16px',
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                fontFamily: fonts.sans,
                fontSize: 13,
                fontWeight: 600,
                color: T.ink,
              }}
            >
              {ai.guideButton}
              <span aria-hidden style={{ color: T.teal, fontSize: 14 }}>→</span>
            </button>
          </div>
          <TrustLine ai={ai} items={items} />

          {noJobsYet && <Banner tone="neutral" text={ai.noJobsWarning} />}
          {showStale && <Banner tone="warm" text={ai.staleWarning} />}

          {items.length === 0 ? (
            <EmptyState ai={ai} />
          ) : (
            <div
              style={{
                marginTop: 22,
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))',
                gap: 10,
              }}
            >
              {items.map((it) => (
                <ItemTile key={it.itemId} ai={ai} it={it} />
              ))}
            </div>
          )}

          {/* ── The guide — a second layer, nearly wordless ── */}
          <Overlay
            open={guideOpen}
            onClose={() => setGuideOpen(false)}
            accent={T.teal}
            eyebrow={ai.guideEyebrow}
            italic={ai.guideTitle}
            width={720}
          >
            <VisualGuide ai={ai} />
          </Overlay>
        </>
      )}
    </Overlay>
  );
}

// ═══════════════════════════ TRACKER ════════════════════════════════════════

// Stage assignment: the one mental model of the whole screen.
function stageOf(it: ReportItem): 0 | 1 | 2 {
  if (it.status === 'graduated') return 2;
  if ((it.cleanWindows ?? 0) > 0 || (it.prospectivePairs ?? 0) > 0) return 1;
  return 0;
}

// Combined progress toward Trusted (fills the tile rings).
function progressOf(it: ReportItem): number {
  if (it.status === 'graduated') return 1;
  const w = Math.min((it.cleanWindows ?? 0) / (it.eventsNeeded || 15), 1);
  const p = Math.min((it.prospectivePairs ?? 0) / (it.pairsNeeded || 8), 1);
  return Math.min(0.65 * w + 0.35 * p, 0.97); // never shows "done" until Trusted
}

const STAGE_COLOR = (stage: 0 | 1 | 2): string =>
  stage === 2 ? statusColor.good : stage === 1 ? T.teal : T.ink3;

// Fleet-level "how far to trusted" — measured by DATA COLLECTED (each item's
// real gate progress: clean windows, passed tests, Trusted badges), never by
// calendar days. The one number a GM opens this screen for.
function fleetProgress(items: ReportItem[]): number {
  if (items.length === 0) return 0;
  const sum = items.reduce((acc, it) => acc + (it.status === 'graduated' ? 1 : progressOf(it)), 0);
  return sum / items.length;
}

function TrustLine({ ai, items }: { ai: AiStrings; items: ReportItem[] }) {
  const pct = Math.round(fleetProgress(items) * 100);
  const markerLeft = `${Math.min(Math.max(pct, 0), 100)}%`;
  return (
    <div style={{ maxWidth: 760, margin: '0 auto', textAlign: 'center', paddingTop: 6 }}>
      {/* the number */}
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'center', gap: 10, marginBottom: 20 }}>
        <Serif size={44} style={{ lineHeight: 1 }}>{pct}%</Serif>
        <span style={{ fontFamily: fonts.sans, fontSize: 13.5, color: T.ink2 }}>{ai.heroCaption}</span>
      </div>

      {/* the line: fill → marker → the 90% goal flag */}
      <div style={{ position: 'relative', paddingRight: 74, paddingTop: 6 }}>
        <div style={{ position: 'relative', height: 10, borderRadius: 6, background: T.ruleSoft }}>
          <div
            style={{
              position: 'absolute', left: 0, top: 0, bottom: 0,
              width: markerLeft, minWidth: pct > 0 ? 10 : 0,
              borderRadius: 6, background: T.teal,
            }}
          />
          {/* current-position marker */}
          <span
            style={{
              position: 'absolute', left: markerLeft, top: '50%',
              transform: 'translate(-50%, -50%)',
              width: 18, height: 18, borderRadius: '50%',
              background: T.bg, border: `3px solid ${T.teal}`,
            }}
          />
        </div>
        {/* the goal, with the 90 VISIBLE at the end of the line */}
        <div
          style={{
            position: 'absolute', right: 0, top: -16,
            display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1,
          }}
        >
          <svg width={16} height={20} viewBox="0 0 16 20" aria-hidden>
            <line x1={3} y1={1} x2={3} y2={19} stroke={statusColor.good} strokeWidth={2} strokeLinecap="round" />
            <path d="M4.5 2 L14 4.8 L4.5 7.6 Z" fill={statusColor.good} />
          </svg>
          <Serif size={19} style={{ color: statusColor.good, lineHeight: 1 }}>
            {ai.heroGoalPct}
          </Serif>
          <Caps size={7.5} color={statusColor.good}>{ai.heroGoal}</Caps>
        </div>
      </div>

      {/* goal meaning + honest measurement note */}
      <div style={{ marginTop: 16, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3 }}>
        <span style={{ fontFamily: fonts.sans, fontSize: 12.5, fontWeight: 600, color: T.ink }}>
          {ai.heroGoalSub}
        </span>
        <span style={{ fontFamily: fonts.sans, fontSize: 11.5, color: T.ink3 }}>
          {ai.heroEst}
        </span>
      </div>
    </div>
  );
}

// One item on the road: ring = progress toward Trusted; the grade chip is
// the honest "how did its last test go".
function ItemTile({ ai, it }: { ai: AiStrings; it: ReportItem }) {
  const stage = stageOf(it);
  const color = STAGE_COLOR(stage);
  const pct = progressOf(it);
  const usage = it.predictedDailyRate != null ? fmtRate(it.predictedDailyRate) : '—';

  let grade: { text: string; color: string } | null = null;
  if (it.lastErrorPct != null) {
    grade = it.lastErrorPct < 0.5
      ? { text: ai.gradeSpotOn, color: T.forestText }
      : { text: ai.gradeOff(it.lastErrorPct.toFixed(0)), color: it.lastErrorPct <= 15 ? T.ink2 : T.warm };
  }
  const reason = stage !== 2 && it.graduationReason && it.graduationReason !== 'ok'
    ? ai.gradReason(it.graduationReason)
    : '';
  const progressDetail = `${ai.windowsProgress(Math.min(it.cleanWindows ?? 0, it.eventsNeeded), it.eventsNeeded)} · ${ai.pairsProgress(Math.min(it.prospectivePairs ?? 0, it.pairsNeeded ?? 8), it.pairsNeeded ?? 8)}`;

  return (
    <div
      title={progressDetail}
      style={{
        background: T.paper,
        border: `1px solid ${T.rule}`,
        borderRadius: 13,
        padding: '14px 16px',
        display: 'flex',
        alignItems: 'center',
        gap: 14,
      }}
    >
      <ProgressRing pct={pct} color={color} trusted={stage === 2} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 }}>
        <span
          style={{
            fontFamily: fonts.sans, fontSize: 13.5, fontWeight: 600, color: T.ink,
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
          }}
        >
          {it.itemName}
        </span>
        <span style={{ display: 'flex', alignItems: 'baseline', gap: 4 }}>
          <Serif size={19}>{usage}</Serif>
          <span style={{ fontFamily: fonts.mono, fontSize: 9.5, color: T.ink3 }}>{ai.perDayShort}</span>
        </span>
        <span style={{ fontFamily: fonts.sans, fontSize: 11, color: grade ? grade.color : T.ink3 }}>
          {grade ? grade.text : ai.noComparisonYet}
          {reason ? ` · ${reason}` : ''}
        </span>
      </div>
    </div>
  );
}

function ProgressRing({ pct, color, trusted }: { pct: number; color: string; trusted: boolean }) {
  const r = 23;
  const c = 2 * Math.PI * r;
  return (
    <svg width={58} height={58} viewBox="0 0 58 58" style={{ flex: 'none' }} aria-hidden>
      <circle cx={29} cy={29} r={r} fill="none" stroke={T.ruleSoft} strokeWidth={5} />
      <circle
        cx={29} cy={29} r={r} fill="none"
        stroke={color} strokeWidth={5} strokeLinecap="round"
        strokeDasharray={`${c * pct} ${c}`}
        transform="rotate(-90 29 29)"
      />
      {trusted ? (
        <path d="M20 29.5 L26.5 36 L38.5 23" fill="none" stroke={color} strokeWidth={3.5} strokeLinecap="round" strokeLinejoin="round" />
      ) : (
        <text
          x={29} y={33}
          textAnchor="middle"
          style={{ font: `600 13px ${fonts.sans}`, fill: T.ink2 }}
        >
          {Math.round(pct * 100)}%
        </text>
      )}
    </svg>
  );
}

// ═══════════════════════════ THE GUIDE ══════════════════════════════════════
// Visuals first; words only as captions. No jargon anywhere.

function VisualGuide({ ai }: { ai: AiStrings }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 34, paddingBottom: 6 }}>
      {/* 1 — it watches two things */}
      <GuidePanel title={ai.g1Title}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 18, flexWrap: 'wrap' }}>
          <IconWithCaption icon={<IconClipboard />} caption={ai.g1Counts} />
          <BigGlyph>+</BigGlyph>
          <IconWithCaption icon={<IconGauge />} caption={ai.g1Occupancy} />
          <BigGlyph>=</BigGlyph>
          <IconWithCaption icon={<IconTag />} caption={ai.g1Learns} accent />
        </div>
      </GuidePanel>

      {/* 2 — every count is a test */}
      <GuidePanel title={ai.g2Title}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 14, flexWrap: 'wrap' }}>
          <IconWithCaption icon={<IconCount />} caption={ai.g2Count} />
          <Arrow />
          <IconWithCaption icon={<IconCompare />} caption={ai.g2Compare} />
          <Arrow />
          <IconWithCaption icon={<IconGrade />} caption={ai.g2Grade} />
          <Arrow />
          <IconWithCaption icon={<IconBadge />} caption={ai.chipGraduated} accent />
        </div>
        <p style={{ margin: '14px 0 0', textAlign: 'center', fontFamily: fonts.mono, fontSize: 10.5, letterSpacing: '0.05em', color: T.ink3 }}>
          {ai.g2Badge}
        </p>
      </GuidePanel>

      {/* 3 — accuracy grows: the curve AND the road, one shared timeline */}
      <GuidePanel title={ai.g3Title}>
        <AccuracyCurve ai={ai} />
      </GuidePanel>

      {/* 4 — objection handling: what if it's wrong? Three safeties. */}
      <GuidePanel title={ai.g4Title}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 18, flexWrap: 'wrap' }}>
          <IconWithCaption icon={<IconShield />} caption={ai.g4Manual} />
          <IconWithCaption icon={<IconMagnify />} caption={ai.g4Caught} />
          <IconWithCaption icon={<IconBadge />} caption={ai.g4Badge} accent />
        </div>
        <p style={{ margin: '14px 0 0', textAlign: 'center', fontFamily: fonts.mono, fontSize: 10.5, letterSpacing: '0.05em', color: T.ink3 }}>
          {ai.g4Kicker}
        </p>
      </GuidePanel>
    </div>
  );
}

function GuidePanel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <Caps size={9.5} color={T.teal} style={{ display: 'block', textAlign: 'center', marginBottom: 16 }}>
        {title}
      </Caps>
      {children}
    </section>
  );
}

function IconWithCaption({ icon, caption, accent }: { icon: React.ReactNode; caption: string; accent?: boolean }) {
  return (
    <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, width: 96 }}>
      <span
        style={{
          width: 64, height: 64, borderRadius: '50%',
          border: `1.5px solid ${accent ? T.teal : T.rule}`,
          background: accent ? `${T.teal}0d` : T.paper,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: accent ? T.teal : T.ink,
        }}
      >
        {icon}
      </span>
      <span style={{ fontFamily: fonts.sans, fontSize: 11.5, fontWeight: 600, color: T.ink2, textAlign: 'center' }}>
        {caption}
      </span>
    </span>
  );
}

function BigGlyph({ children }: { children: React.ReactNode }) {
  return (
    <span style={{ fontFamily: fonts.sans, fontWeight: 600, fontSize: 26, color: T.ink3, transform: 'translateY(-14px)' }}>
      {children}
    </span>
  );
}

function Arrow() {
  return (
    <span aria-hidden style={{ color: T.ink3, fontSize: 15, transform: 'translateY(-14px)' }}>→</span>
  );
}

function AccuracyCurve({ ai }: { ai: AiStrings }) {
  // ONE shared timeline: the accuracy curve on top (0% at day one, rising
  // into the 85–90% band by ~3 months) and the road's milestone stops along
  // the SAME axis below — every stage of the journey on a single picture.
  // x positions keep every centered label inside the 0–560 viewBox (the
  // first/last stops need breathing room or their sublabels clip).
  const stops = [
    { x: 56, label: ai.g3M0, sub: ai.g3M0b, color: T.ink3, curveY: 175 },
    { x: 170, label: ai.g3M1, sub: ai.g3M1b, color: T.ink3, curveY: 146 },
    { x: 285, label: ai.g3M2, sub: ai.g3M2b, color: T.teal, curveY: 104 },
    { x: 395, label: ai.g3M3, sub: ai.g3M3b, color: T.teal, curveY: 63 },
    { x: 500, label: ai.g3M4, sub: ai.g3M4b, color: statusColor.good, curveY: 42 },
  ];
  return (
    <svg viewBox="0 0 560 268" style={{ width: '100%', height: 'auto', display: 'block' }} aria-hidden>
      {/* the 85–90% goal band */}
      <rect x={0} y={30} width={560} height={22} rx={4} fill={`${statusColor.good}18`} />
      <text x={10} y={46} textAnchor="start" style={{ font: `600 14px ${fonts.sans}`, fill: statusColor.good }}>
        {ai.g3Band}
      </text>
      {/* the learning curve — starts at 0% on the axis */}
      <path
        d="M 56 178 C 130 172, 195 138, 285 104 C 365 74, 430 50, 500 42 C 515 40.5, 530 40, 540 40"
        fill="none" stroke={T.teal} strokeWidth={3} strokeLinecap="round"
      />
      {/* axis (0% accuracy) */}
      <line x1={14} y1={178} x2={546} y2={178} stroke={T.rule} strokeWidth={1.5} />
      <text x={56} y={196} textAnchor="start" style={{ font: `600 11px ${fonts.sans}`, fill: T.ink3 }}>
        {ai.g3Start}
      </text>
      <text x={500} y={196} textAnchor="middle" style={{ font: `600 11px ${fonts.sans}`, fill: T.ink2 }}>
        {ai.g3Mark}
      </text>
      {/* the road itself (painted first so the stops sit on top of it) */}
      <line x1={14} y1={226} x2={546} y2={226} stroke={T.rule} strokeWidth={2} strokeDasharray="6 5" />
      {/* milestone stops: a dot ON the curve + a stop on the road below,
          joined by a faint drop line */}
      {stops.map((s) => (
        <g key={s.label}>
          <circle cx={s.x} cy={s.curveY} r={4.5} fill={T.bg} stroke={s.color} strokeWidth={2.5} />
          <line x1={s.x} y1={s.curveY + 8} x2={s.x} y2={218} stroke={T.rule} strokeWidth={1} strokeDasharray="3 4" />
          <circle cx={s.x} cy={226} r={7} fill={T.bg} stroke={s.color} strokeWidth={2.5} />
          <circle cx={s.x} cy={226} r={2.6} fill={s.color} />
          <text x={s.x} y={248} textAnchor="middle" style={{ font: `700 10.5px ${fonts.sans}`, fill: T.ink }}>
            {s.label}
          </text>
          <text x={s.x} y={262} textAnchor="middle" style={{ font: `500 10px ${fonts.sans}`, fill: T.ink3 }}>
            {s.sub}
          </text>
        </g>
      ))}
    </svg>
  );
}

// ── Shared bits ──────────────────────────────────────────────────────────────

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
      <Serif size={24}>{ai.emptyTitle}</Serif>
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

// Format a rate/stock number: 2 decimals under 10, else whole-ish.
function fmtRate(v: number): string {
  if (!Number.isFinite(v)) return '—';
  if (Math.abs(v) >= 10) return Math.round(v).toLocaleString('en-US');
  return v.toFixed(2);
}

