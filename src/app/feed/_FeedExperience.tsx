'use client';

// ════════════════════════════════════════════════════════════════════
// Staxis · Feed — the decision-feed experience ("your hotel's inbox").
//
// The AI runs every department in the background and surfaces only the
// DECISIONS that need a human: one tap to approve. Phase 1 — realistic
// sample data, same editorial language as the dashboard (Fraunces serif
// italics, Geist sans, mono numbers, warm green / rust / sage palette),
// now with a fully choreographed motion system:
//
//   · time-of-day atmosphere (drifting warm gradient sky + grain)
//   · staggered "the day assembles itself" page entrance
//   · rolling odometer numerals for every live count
//   · approve → button morphs to a check → card folds into the
//     "Handled automatically" ledger → undo snackbar
//   · segmented day-meter that fills as decisions clear
//   · a real all-clear moment (check draws in, ring ripple, sky lifts)
//
// Everything is CSS + React state — no animation deps — and all of it
// collapses to near-instant under prefers-reduced-motion.
//
// Exported as a shared component so /feed (real shell) and /demo/feed
// (login-free design preview) render the identical experience.
// Wiring cards to real data + real actions is Phase 2+.
// ════════════════════════════════════════════════════════════════════

import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  BedDouble, Wrench, Package, MessageSquare, Droplets, UserRound,
  Check, ChevronDown, Sparkles, Send, Sunrise, Sun, Moon, RotateCcw,
  type LucideIcon,
} from 'lucide-react';
import { useProperty } from '@/contexts/PropertyContext';
import { useLang } from '@/contexts/LanguageContext';
import { isSectionEnabled, type AppSection } from '@/lib/sections/registry';

// ─── palette + fonts (1:1 with the dashboard) ─────────────────────────
const C = {
  paper:  '#FFFFFF',
  paper2: '#F1F2F4',
  ink:    '#20251F',
  ink2:   '#4A5249',
  ink3:   '#8A9187',
  ink4:   '#B4B9AE',
  green:  '#356B4C',
  greenL: '#5C8E6F',
  sage:   '#9DB8A6',
  rust:   '#BC5E37',
  rustD:  '#9A4A29',
  gold:   '#C09A3C',
  line:   'rgba(32,37,31,0.10)',
  line2:  'rgba(32,37,31,0.16)',
} as const;

const SERIF = 'var(--font-fraunces), Georgia, "Times New Roman", serif';
const SANS  = 'var(--font-geist), system-ui, -apple-system, sans-serif';
const MONO  = 'var(--font-geist-mono), ui-monospace, "SF Mono", Menlo, monospace';

const LABEL: React.CSSProperties = {
  fontFamily: SANS, textTransform: 'uppercase', letterSpacing: '0.14em',
  fontWeight: 600, fontSize: 11, color: C.ink3,
};

// fine paper grain — feTurbulence tile, repeated
const GRAIN =
  'url("data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 width=%27160%27 height=%27160%27%3E%3Cfilter id=%27n%27%3E%3CfeTurbulence type=%27fractalNoise%27 baseFrequency=%270.9%27 numOctaves=%272%27 stitchTiles=%27stitch%27/%3E%3C/filter%3E%3Crect width=%27160%27 height=%27160%27 filter=%27url(%23n)%27 opacity=%270.5%27/%3E%3C/svg%3E")';

// ─── decision-card model ──────────────────────────────────────────────
type Tone = 'save' | 'urgent' | 'info';
export type DecisionCard = {
  id: string;
  dept: string;
  // Which app section owns this card. When that section is off for the hotel
  // the card is filtered out. Undefined ⇒ never gated (Guests + anything
  // ambiguous). Future real cards inherit the same gate by setting this.
  section?: AppSection;
  icon: LucideIcon;
  accent: string;
  tint: string;        // soft icon background
  title: string;
  detail: string;
  impact?: { text: string; tone: Tone };
  primary: string;
  secondary?: string;
  urgent?: boolean;
  handledNote: string; // what shows in the "handled" log after approval
};

// ─── realistic sample feed (Comfort Suites Beaumont) ──────────────────
const SAMPLE: DecisionCard[] = [
  {
    id: 'guest-207',
    dept: 'Guests',
    icon: MessageSquare, accent: C.rust, tint: 'rgba(188,94,55,0.10)',
    title: 'Room 207 messaged about noise — twice',
    detail: 'Guest is still up. An apology + 10% off tonight is drafted and ready to send.',
    impact: { text: 'protects your review score', tone: 'urgent' },
    primary: 'Send reply', secondary: 'Edit',
    urgent: true,
    handledNote: 'Sent apology + 10% comp to room 207',
  },
  {
    id: 'staff-maria',
    dept: 'Staff', section: 'staff',
    icon: UserRound, accent: C.gold, tint: 'rgba(192,154,60,0.12)',
    title: 'Maria hasn’t confirmed tomorrow',
    detail: 'No reply since last night. Lupe is available as backup — want me to text her to be safe?',
    impact: { text: 'avoids a morning scramble', tone: 'save' },
    primary: 'Text Lupe', secondary: 'Call Maria',
    handledNote: 'Texted Lupe to cover as backup',
  },
  {
    id: 'crew-tomorrow',
    dept: 'Housekeeping', section: 'housekeeping',
    icon: BedDouble, accent: C.green, tint: 'rgba(53,107,76,0.10)',
    title: 'Tomorrow’s crew is ready',
    detail: '86 rooms · 4 housekeepers — Ana, Rosa, Maria, Lupe. Board balanced by floor and checkout load.',
    impact: { text: 'saves ~$210 vs a flat 5-person crew', tone: 'save' },
    primary: 'Approve & send', secondary: 'Adjust',
    handledNote: 'Sent tomorrow’s board to 4 housekeepers',
  },
  {
    id: 'inv-towels',
    dept: 'Inventory', section: 'inventory',
    icon: Package, accent: C.ink2, tint: 'rgba(32,37,31,0.07)',
    title: 'Towels run out Thursday',
    detail: 'At today’s pace you’ll be short by Thursday. Order drafted: 6 cases · $310 · ABC Supply.',
    impact: { text: '$310', tone: 'info' },
    primary: 'Approve order', secondary: 'Change',
    handledNote: 'Placed towel order — 6 cases, ABC Supply',
  },
  {
    id: 'maint-214',
    dept: 'Maintenance', section: 'maintenance',
    icon: Wrench, accent: C.gold, tint: 'rgba(192,154,60,0.12)',
    title: 'AC in 214 keeps coming back',
    detail: 'Reported twice this week. A work order is drafted and ready for José.',
    primary: 'Send to José', secondary: 'Why?',
    handledNote: 'Routed AC work order (214) to José',
  },
  {
    id: 'comp-pool',
    dept: 'Compliance', section: 'maintenance',
    icon: Droplets, accent: C.green, tint: 'rgba(53,107,76,0.10)',
    title: 'Pool chlorine reading was overdue',
    detail: 'I reminded José and recorded the reading at 8:02a. Just confirming you saw it.',
    primary: 'OK',
    handledNote: 'Logged pool chlorine reading',
  },
];

// already-handled items shown in the trust log
const PREHANDLED: { text: string; at: string }[] = [
  { text: 'Reassigned 9 rooms as statuses changed', at: '9:14a' },
  { text: 'Routed 2 work orders to maintenance', at: '7:48a' },
  { text: 'Texted tonight’s 4 housekeepers their rooms', at: '7:30a' },
  { text: 'Skipped full cleans on 18 stayover rooms', at: '7:12a' },
];

// ─── time-of-day phase → briefing copy + sky colors ───────────────────
export type Phase = 'morning' | 'afternoon' | 'night';

const BRIEFINGS: Record<Phase, {
  greeting: string; label: string; icon: LucideIcon; accent: string; sub: string;
  sky: [string, string, string];
}> = {
  morning: {
    greeting: 'Good morning.', label: 'Morning briefing', icon: Sunrise, accent: C.gold,
    sub: '86 rooms to turn today · 4 housekeepers ready',
    sky: ['rgba(240,206,138,0.55)', 'rgba(236,190,166,0.42)', 'rgba(196,214,196,0.50)'],
  },
  afternoon: {
    greeting: 'Good afternoon.', label: 'Afternoon check', icon: Sun, accent: C.green,
    sub: 'On track for the day · 78% tonight',
    sky: ['rgba(226,228,186,0.50)', 'rgba(242,226,178,0.40)', 'rgba(190,214,196,0.48)'],
  },
  night: {
    greeting: 'Good evening.', label: 'Evening wrap-up', icon: Moon, accent: C.greenL,
    sub: 'Tomorrow’s crew is set · night shift briefed',
    sky: ['rgba(232,186,154,0.48)', 'rgba(214,178,170,0.40)', 'rgba(174,196,182,0.50)'],
  },
};

// ─── rolling odometer numeral ─────────────────────────────────────────
// Each digit is a vertical strip of 0-9 that slides to the current value.
function RollingDigit({ d }: { d: number }) {
  return (
    <span className="stx-odo" aria-hidden="true">
      <span className="stx-odo-strip" style={{ transform: `translateY(${-d}em)` }}>
        {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map(n => (
          <span key={n} className="stx-odo-cell">{n}</span>
        ))}
      </span>
    </span>
  );
}

function Rolling({ value }: { value: number }) {
  const chars = String(value).split('');
  return (
    <span style={{ whiteSpace: 'nowrap' }} role="text" aria-label={String(value)}>
      {chars.map((ch, i) =>
        /\d/.test(ch)
          ? <RollingDigit key={chars.length - i} d={Number(ch)} />
          : <span key={`c${i}`}>{ch}</span>,
      )}
    </span>
  );
}

// ─── rAF count-up for the labor numbers ───────────────────────────────
function useCountUp(target: number, run: boolean, ms = 950) {
  const [v, setV] = useState(0);
  useEffect(() => {
    if (!run) return;
    if (typeof window !== 'undefined'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setV(target);
      return;
    }
    let raf = 0;
    const t0 = performance.now();
    const tick = (t: number) => {
      const p = Math.min(1, (t - t0) / ms);
      const eased = 1 - Math.pow(1 - p, 3);
      setV(Math.round(target * eased));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, run, ms]);
  return v;
}

// ─── self-drawing check mark ──────────────────────────────────────────
function DrawnCheck({ size = 14, color = C.green, delay = 0, strokeWidth = 2.6 }: {
  size?: number; color?: string; delay?: number; strokeWidth?: number;
}) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" style={{ flexShrink: 0 }}>
      <path
        d="M4.5 12.8 L9.6 17.8 L19.5 6.5"
        stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round"
        className="stx-checkdraw" style={{ animationDelay: `${delay}ms` }}
      />
    </svg>
  );
}

// ─── one decision card ────────────────────────────────────────────────
type CardStage = 'idle' | 'confirming' | 'collapsing' | 'entering';

function Card({ card, stage, index, onPrimary, onSecondary }: {
  card: DecisionCard;
  stage: CardStage;
  index: number;
  onPrimary: () => void;
  onSecondary: () => void;
}) {
  const Icon = card.icon;
  const impactColor = card.impact?.tone === 'urgent' ? C.rust
    : card.impact?.tone === 'save' ? C.green : C.ink3;
  const confirmed = stage === 'confirming' || stage === 'collapsing';

  return (
    <div
      className={
        'stx-cardwrap'
        + (stage === 'collapsing' ? ' stx-cardwrap-out' : '')
        + (stage === 'entering' ? ' stx-cardwrap-in' : '')
      }
      style={stage === 'entering' ? undefined : { animationDelay: `${340 + index * 85}ms` }}
    >
      <div style={{ minHeight: 0, overflow: stage === 'collapsing' ? 'hidden' : 'visible' }}>
        <div
          className={'stx-card' + (card.urgent && !confirmed ? ' stx-card-urgent' : '')}
          style={{
            position: 'relative',
            background: C.paper,
            border: `1px solid ${C.line}`,
            borderRadius: 18,
            padding: '18px 18px 16px 22px',
            display: 'flex', gap: 14,
            overflow: 'hidden',
          }}>
          {/* department accent hairline */}
          <span aria-hidden="true" className="stx-card-hair" style={{
            position: 'absolute', left: 0, top: 0, bottom: 0, width: 3,
            background: `linear-gradient(180deg, ${card.accent}, transparent 130%)`,
            opacity: card.urgent ? 0.95 : 0.45,
          }} />

          {/* icon */}
          <div style={{
            width: 40, height: 40, borderRadius: 12, background: card.tint,
            display: 'grid', placeItems: 'center', flexShrink: 0, marginTop: 1,
            border: '1px solid rgba(32,37,31,0.05)',
          }}>
            <Icon size={19} color={card.accent} strokeWidth={2} />
          </div>

          {/* body */}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 5 }}>
              <span style={{ ...LABEL, fontSize: 10, color: card.accent }}>{card.dept}</span>
              {card.urgent && (
                <span style={{
                  fontFamily: MONO, fontSize: 9, fontWeight: 700, letterSpacing: '0.12em',
                  textTransform: 'uppercase', color: C.rust,
                  background: 'rgba(188,94,55,0.10)', border: '1px solid rgba(188,94,55,0.22)',
                  borderRadius: 999, padding: '2px 7px',
                }}>urgent</span>
              )}
            </div>
            <div style={{ fontFamily: SANS, fontSize: 16, fontWeight: 600, color: C.ink, lineHeight: 1.3, letterSpacing: '-0.01em' }}>
              {card.title}
            </div>
            <div style={{ fontFamily: SANS, fontSize: 13.5, color: C.ink2, lineHeight: 1.55, marginTop: 5 }}>
              {card.detail}
            </div>

            {/* impact + actions */}
            <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 10, marginTop: 14 }}>
              <button onClick={onPrimary} disabled={confirmed}
                className={'stx-btn-primary' + (confirmed ? ' stx-btn-done' : '')}
                style={{
                  fontFamily: SANS, fontSize: 13.5, fontWeight: 600, color: C.paper,
                  background: confirmed ? C.green : card.urgent ? C.rust : C.ink,
                  border: 'none',
                  borderRadius: 11, padding: '9px 16px', cursor: confirmed ? 'default' : 'pointer',
                  display: 'inline-flex', alignItems: 'center', gap: 7,
                  position: 'relative', overflow: 'hidden',
                }}>
                {confirmed
                  ? <><DrawnCheck size={14} color={C.paper} strokeWidth={3} /> Done</>
                  : <>{card.primary === 'Send reply' && <Send size={14} />}{card.primary}</>}
              </button>
              {card.secondary && !confirmed && (
                <button onClick={onSecondary} className="stx-btn-ghost"
                  style={{
                    fontFamily: SANS, fontSize: 13.5, fontWeight: 500, color: C.ink2,
                    background: 'transparent', border: `1px solid ${C.line2}`,
                    borderRadius: 11, padding: '9px 14px', cursor: 'pointer',
                  }}>
                  {card.secondary}
                </button>
              )}
              {card.impact && (
                <span style={{
                  marginLeft: 'auto', fontFamily: SANS, fontSize: 12.5, fontWeight: 600,
                  color: impactColor, display: 'inline-flex', alignItems: 'center', gap: 5,
                }}>
                  {card.impact.tone === 'save' && <span aria-hidden="true">↓</span>}
                  <span>{card.impact.text}</span>
                </span>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── the experience ───────────────────────────────────────────────────
export function FeedExperience({ phaseOverride, demo = false }: { phaseOverride?: Phase; demo?: boolean }) {
  // The cards / handled ledger / labor $ / pulse counts / day-meter below are a
  // realistic DESIGN SAMPLE, not real data. Per Reeyen (2026-07-09): a real
  // hotel must only ever see its own real info — never demo/example content. So
  // the sample renders ONLY when `demo` is set (the login-free /demo/feed
  // showcase) or the active hotel is a demo/test hotel (properties.is_test →
  // activeProperty.isTest). Every real hotel gets the honest quiet state
  // instead. Mirrors the dashboard's synthetic-KPI gate (!!activeProperty?.isTest).
  const { activeProperty } = useProperty();
  const { lang } = useLang();
  const showSample = demo || !!activeProperty?.isTest;

  // Per-hotel section gate. activeProperty.enabledSections rides on
  // PropertyContext (no fetch). A card whose owning section is off is filtered
  // out; undefined section is never gated. isSectionEnabled is default-ON, so
  // this is fail-open. Only consulted when the sample is shown at all.
  const enabledSections = activeProperty?.enabledSections;
  // Key on the CONTENT of the flags (not the object identity) so a routine
  // PropertyContext refresh that re-creates activeProperty with the same flags
  // doesn't recompute + reset the feed mid-session.
  const enabledKey = enabledSections ? JSON.stringify(enabledSections) : '';
  const visibleSample = useMemo(
    () => (showSample ? SAMPLE.filter((c) => !c.section || isSectionEnabled(enabledSections, c.section)) : []),
    // enabledSections is derived from enabledKey; keying on the string is stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [enabledKey, showSample],
  );
  const [cards, setCards] = useState<DecisionCard[]>(visibleSample);
  const [stages, setStages] = useState<Record<string, CardStage>>({});
  const [handled, setHandled] = useState<{ text: string; at: string; fresh?: boolean }[]>(PREHANDLED);
  const [logOpen, setLogOpen] = useState(false);
  const [ledgerFlash, setLedgerFlash] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [undoItem, setUndoItem] = useState<{ card: DecisionCard; index: number; note: string } | null>(null);
  const [hintIdx, setHintIdx] = useState(0);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  useEffect(() => setMounted(true), []);
  useEffect(() => {
    const list = timers.current;
    return () => list.forEach(clearTimeout);
  }, []);
  const later = (fn: () => void, ms: number) => { timers.current.push(setTimeout(fn, ms)); };

  // Time-of-day phase drives the briefing + sky. Set in an effect (not at
  // first render) so server + client agree on the initial 'morning' markup.
  const [autoPhase, setAutoPhase] = useState<Phase>('morning');
  useEffect(() => {
    const h = new Date().getHours();
    setAutoPhase(h >= 5 && h < 12 ? 'morning' : h >= 12 && h < 17 ? 'afternoon' : 'night');
  }, []);
  const phase = phaseOverride ?? autoPhase;
  const brief = BRIEFINGS[phase];
  const BriefIcon = brief.icon;

  const dateLong = useMemo(
    () => new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' }),
    [],
  );
  const nowTime = useMemo(
    // "9:40 AM" → "9:40a", matching the seeded ledger rows
    () => new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }).toLowerCase().replace(' ', '').replace(/m$/, ''),
    [],
  );

  // When the section gate resolves after mount (property loads, or the hotel
  // is switched), rebuild the feed from the freshly-filtered sample. Skips the
  // first run so a straight mount keeps its lazy-initialized cards.
  const gateSynced = useRef(true);
  useEffect(() => {
    if (gateSynced.current) { gateSynced.current = false; return; }
    setCards(visibleSample);
    setStages({});
    setUndoItem(null);
  }, [visibleSample]);

  // day meter: how many of today's decisions are cleared. Denominator is the
  // number of cards this hotel actually shows (post section-gate).
  const totalDecisions = visibleSample.length;
  const cleared = totalDecisions - cards.length;
  const allClear = cards.length === 0;

  // approve → button morphs → card folds shut → lands in the ledger
  const approve = (card: DecisionCard) => {
    if (stages[card.id] && stages[card.id] !== 'entering') return;
    const index = cards.findIndex(c => c.id === card.id);
    setStages(s => ({ ...s, [card.id]: 'confirming' }));
    later(() => setStages(s => ({ ...s, [card.id]: 'collapsing' })), 520);
    later(() => {
      setCards(prev => prev.filter(c => c.id !== card.id));
      setStages(s => { const n = { ...s }; delete n[card.id]; return n; });
      setHandled(prev => [{ text: card.handledNote, at: nowTime, fresh: true }, ...prev]);
      setLedgerFlash(true);
      later(() => setLedgerFlash(false), 900);
      setUndoItem({ card, index, note: card.handledNote });
      later(() => setUndoItem(u => (u?.card.id === card.id ? null : u)), 6000);
    }, 980);
  };

  // secondary action — Phase 1: gently slides the card away (undo-able)
  const dismiss = (card: DecisionCard) => {
    if (stages[card.id] && stages[card.id] !== 'entering') return;
    const index = cards.findIndex(c => c.id === card.id);
    setStages(s => ({ ...s, [card.id]: 'collapsing' }));
    later(() => {
      setCards(prev => prev.filter(c => c.id !== card.id));
      setStages(s => { const n = { ...s }; delete n[card.id]; return n; });
      setUndoItem({ card, index, note: `Set aside “${card.title}”` });
      later(() => setUndoItem(u => (u?.card.id === card.id ? null : u)), 6000);
    }, 460);
  };

  const undo = () => {
    if (!undoItem) return;
    const { card, index } = undoItem;
    setHandled(prev => prev.filter(h => !(h.fresh && h.text === card.handledNote)));
    setCards(prev => {
      if (prev.some(c => c.id === card.id)) return prev;
      const next = [...prev];
      next.splice(Math.min(index, next.length), 0, card);
      return next;
    });
    setStages(s => ({ ...s, [card.id]: 'entering' }));
    later(() => setStages(s => { const n = { ...s }; delete n[card.id]; return n; }), 600);
    setUndoItem(null);
  };

  // labor scoreboard (sample) — numbers count up on load
  const budget = 1910;
  const spentTarget = 1840;
  const spent = useCountUp(spentTarget, mounted);
  const under = useCountUp(budget - spentTarget, mounted, 1200);
  const pct = Math.min(100, Math.round((spentTarget / budget) * 100));

  // ask-hint cycler
  const HINTS = useMemo(() => ([
    '“add a cleaner tomorrow”',
    '“why was labor high last week?”',
    '“what time is the checkout rush?”',
  ]), []);
  useEffect(() => {
    const id = setInterval(() => setHintIdx(i => (i + 1) % HINTS.length), 4200);
    return () => clearInterval(id);
  }, [HINTS]);

  const briefHeadline = phase === 'morning'
    ? (allClear ? 'You’re set for the day.' : 'then the hotel runs itself.')
    : phase === 'afternoon'
      ? (allClear ? 'Everything’s covered.' : 'then you’re back on cruise.')
      : (allClear ? 'Tomorrow’s set, nothing pending.' : 'then you can close the day.');

  return (
    <div style={{
      width: '100%', minHeight: '100vh', background: C.paper, fontFamily: SANS, color: C.ink,
      position: 'relative', overflow: 'clip',
      padding: 'clamp(18px, 2vw, 32px) clamp(16px, 3vw, 48px) 150px',
    }}>
      <style>{STYLES}</style>

      {/* ── atmosphere: time-of-day sky + grain (behind everything) ── */}
      <div aria-hidden="true" className={'stx-sky' + (allClear ? ' stx-sky-lift' : '')}>
        <div className="stx-blob stx-blob-a" style={{ background: `radial-gradient(circle at 50% 50%, ${brief.sky[0]}, transparent 62%)` }} />
        <div className="stx-blob stx-blob-b" style={{ background: `radial-gradient(circle at 50% 50%, ${brief.sky[1]}, transparent 62%)` }} />
        <div className="stx-blob stx-blob-c" style={{ background: `radial-gradient(circle at 50% 50%, ${brief.sky[2]}, transparent 62%)` }} />
        <div className="stx-sky-fade" />
      </div>
      <div aria-hidden="true" className="stx-grain" style={{ backgroundImage: GRAIN }} />

      <div className="stx-feed">

        {/* ── pulse row ── */}
        <header className="stx-rise" style={{
          marginTop: 4, display: 'flex', alignItems: 'center',
          justifyContent: 'space-between', flexWrap: 'wrap', gap: '8px 16px',
        }}>
          <div style={{ ...LABEL, display: 'inline-flex', alignItems: 'center', gap: 9 }}>
            <BriefIcon size={13} color={brief.accent} strokeWidth={2.2} />
            <span>{brief.label}{mounted ? ` · ${dateLong}` : ''}</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: C.ink2, fontSize: 13.5 }}>
            <span className="stx-livedot" />
            <span>{showSample
              ? '78% tonight · 22 rooms to clean · all shifts staffed'
              : (lang === 'es' ? 'Todo tranquilo por ahora' : 'All quiet right now')}</span>
          </div>
        </header>

        {/* ── hero briefing ── */}
        <section className="stx-rise" style={{ animationDelay: '70ms', marginTop: 6 }}>
          <h1 style={{
            fontFamily: SERIF, fontStyle: 'italic', fontWeight: 500,
            fontSize: 'clamp(38px, 7vw, 60px)', lineHeight: 1.02,
            letterSpacing: '-0.01em', color: C.ink, margin: 0,
          }}>
            {brief.greeting}
          </h1>
          <p key={allClear ? 'clear' : 'work'} className="stx-fadeswap" style={{
            fontFamily: SANS, fontSize: 'clamp(15px, 2.4vw, 17.5px)', color: C.ink2,
            lineHeight: 1.5, margin: '12px 0 0', maxWidth: 560,
          }}>
            {allClear ? (
              <span style={{ fontFamily: SERIF, fontStyle: 'italic', fontSize: '1.15em', color: C.green }}>
                {briefHeadline}
              </span>
            ) : (
              <>
                <span style={{
                  fontFamily: SERIF, fontStyle: 'italic', fontWeight: 500,
                  fontSize: '1.32em', color: C.green, marginRight: 2,
                }}>
                  <Rolling value={cards.length} />
                </span>
                {' '}{cards.length === 1 ? 'decision needs' : 'decisions need'} you — {briefHeadline}
              </>
            )}
          </p>

          {/* day meter — one segment per decision, fills as you clear (sample only) */}
          {showSample && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 18 }}>
            <div style={{ display: 'flex', gap: 5, flex: 1, maxWidth: 340 }}>
              {Array.from({ length: totalDecisions }).map((_, i) => (
                <span key={i} className={'stx-seg' + (i < cleared ? ' stx-seg-on' : '')} />
              ))}
            </div>
            <span style={{ fontFamily: MONO, fontSize: 11, color: C.ink3, letterSpacing: '0.06em', whiteSpace: 'nowrap' }}>
              <Rolling value={cleared} /> of {totalDecisions} cleared
            </span>
          </div>
          )}
        </section>

        {/* ── labor scoreboard (sample only) ── */}
        {showSample && (
        <section className="stx-rise stx-glass" style={{
          animationDelay: '150ms',
          borderRadius: 18, padding: '16px 18px',
          display: 'flex', alignItems: 'center', gap: 18,
        }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ ...LABEL, marginBottom: 8 }}>Labor today</div>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
              <span style={{ fontFamily: MONO, fontSize: 26, fontWeight: 700, letterSpacing: '-0.03em', color: C.ink, fontVariantNumeric: 'tabular-nums' }}>
                ${spent.toLocaleString()}
              </span>
              <span style={{ fontFamily: MONO, fontSize: 14, color: C.ink3 }}>/ ${budget.toLocaleString()}</span>
            </div>
            <div style={{ height: 4, borderRadius: 999, background: C.paper2, marginTop: 12, overflow: 'hidden' }}>
              <div className="stx-laborfill" style={{ width: mounted ? `${pct}%` : '0%' }} />
            </div>
          </div>
          <div style={{ textAlign: 'right', flexShrink: 0 }}>
            <div style={{ fontFamily: SERIF, fontStyle: 'italic', fontWeight: 500, fontSize: 30, color: C.green, lineHeight: 1 }}>
              ${under}
            </div>
            <div style={{ fontSize: 12, color: C.ink3, marginTop: 4 }}>under budget</div>
          </div>
        </section>
        )}

        {/* ── needs you ── */}
        <section>
          <div className="stx-rise" style={{ animationDelay: '230ms', display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
            <span style={LABEL}>Needs you</span>
            {!allClear && (
              <span style={{
                background: C.ink, color: C.paper, borderRadius: 999, minWidth: 22, height: 22,
                padding: '0 7px', display: 'grid', placeItems: 'center', fontSize: 12, fontWeight: 700, fontFamily: MONO,
              }}>
                <Rolling value={cards.length} />
              </span>
            )}
            <span style={{ flex: 1, height: 1, background: C.line }} />
          </div>

          {allClear ? (
            <div className="stx-allclear" style={{
              position: 'relative', overflow: 'hidden',
              border: '1px solid rgba(53,107,76,0.18)', borderRadius: 20,
              padding: '40px 22px 38px', textAlign: 'center',
              background: 'linear-gradient(180deg, rgba(53,107,76,0.07), rgba(157,184,166,0.10))',
            }}>
              <span aria-hidden="true" className="stx-ripple" />
              <div style={{
                width: 52, height: 52, borderRadius: 26, background: 'rgba(53,107,76,0.13)',
                display: 'grid', placeItems: 'center', margin: '0 auto 16px',
                border: '1px solid rgba(53,107,76,0.2)',
              }}>
                <DrawnCheck size={26} delay={250} />
              </div>
              <div style={{ fontFamily: SERIF, fontStyle: 'italic', fontWeight: 500, fontSize: 'clamp(22px, 4vw, 28px)', color: C.green }}>
                {showSample
                  ? 'Nothing needs you right now.'
                  : (lang === 'es' ? 'Todo en orden — nada requiere tu atención aún.' : 'All clear — nothing needs you yet.')}
              </div>
              <div style={{ fontSize: 13.5, color: C.ink2, marginTop: 7 }}>
                {showSample
                  ? 'Staxis is running the floor. I’ll bring you anything worth a decision.'
                  : (lang === 'es' ? 'Cuando algo necesite una decisión, aparecerá aquí.' : 'When something needs a decision, it’ll show up here.')}
              </div>
            </div>
          ) : (
            <div>
              {cards.map((card, i) => (
                <Card key={card.id} card={card} index={i}
                  stage={stages[card.id] ?? 'idle'}
                  onPrimary={() => approve(card)} onSecondary={() => dismiss(card)} />
              ))}
            </div>
          )}
        </section>

        {/* ── handled automatically (sample only) ── */}
        {showSample && (
        <section className={'stx-rise stx-ledger' + (ledgerFlash ? ' stx-ledger-flash' : '')}
          style={{ animationDelay: '740ms', borderRadius: 18, overflow: 'hidden' }}>
          <button onClick={() => setLogOpen(v => !v)}
            style={{
              width: '100%', background: 'transparent', border: 'none', cursor: 'pointer',
              padding: '15px 18px', display: 'flex', alignItems: 'center', gap: 10, textAlign: 'left',
            }}>
            <Sparkles size={16} color={C.sage} strokeWidth={2} className="stx-twinkle" />
            <span style={{ fontFamily: SANS, fontSize: 13.5, fontWeight: 600, color: C.ink2 }}>
              Handled automatically
            </span>
            <span style={{ fontFamily: MONO, fontSize: 12.5, color: C.ink3 }}>
              · <Rolling value={handled.length} /> today
            </span>
            <ChevronDown size={17} color={C.ink3}
              style={{ marginLeft: 'auto', transition: 'transform .25s cubic-bezier(.2,.8,.2,1)', transform: logOpen ? 'rotate(180deg)' : 'none' }} />
          </button>
          <div className="stx-ledger-body" style={{ gridTemplateRows: logOpen ? '1fr' : '0fr' }}>
            <div style={{ minHeight: 0, overflow: 'hidden' }}>
              <div style={{ padding: '0 18px 10px' }}>
                {handled.map((h, i) => (
                  <div key={`${h.text}-${i}`}
                    className={h.fresh ? 'stx-ledger-fresh' : undefined}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 11, padding: '9px 0',
                      borderTop: `1px solid ${C.line}`,
                    }}>
                    {logOpen
                      ? <DrawnCheck size={14} delay={90 + i * 70} />
                      : <Check size={14} color={C.green} strokeWidth={2.6} style={{ flexShrink: 0 }} />}
                    <span style={{ fontSize: 13.5, color: C.ink2, flex: 1 }}>{h.text}</span>
                    <span style={{ fontFamily: MONO, fontSize: 12, color: C.ink4 }}>{h.at}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </section>
        )}

        {/* ── ask hint (the real Ask bar is global, bottom of screen) ── */}
        <div className="stx-rise" style={{ animationDelay: '840ms', textAlign: 'center', color: C.ink4, fontSize: 13, marginTop: 2 }}>
          Ask or tell Staxis anything below —{' '}
          <span key={hintIdx} className="stx-hint" style={{ fontFamily: SERIF, fontStyle: 'italic', color: C.ink3 }}>
            {HINTS[hintIdx]}
          </span>
        </div>
      </div>

      {/* ── undo snackbar ── */}
      {undoItem && (
        <div className="stx-snack" role="status">
          <Check size={14} color={C.sage} strokeWidth={2.6} />
          <span style={{
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '54vw',
          }}>{undoItem.note}</span>
          <button onClick={undo} style={{
            fontFamily: SANS, fontSize: 12.5, fontWeight: 700, color: C.paper,
            background: 'rgba(255,255,255,0.14)', border: '1px solid rgba(255,255,255,0.22)',
            borderRadius: 999, padding: '5px 12px', cursor: 'pointer',
            display: 'inline-flex', alignItems: 'center', gap: 6, flexShrink: 0,
          }}>
            <RotateCcw size={12} /> Undo
          </button>
        </div>
      )}
    </div>
  );
}

// ─── styles ───────────────────────────────────────────────────────────
const STYLES = `
  .stx-feed { position: relative; z-index: 1; max-width: 720px; margin: 0 auto; display: flex; flex-direction: column; gap: 26px; }

  /* atmosphere */
  .stx-sky { position: absolute; inset: 0 0 auto 0; height: 460px; pointer-events: none; z-index: 0; transition: opacity 1.2s ease; }
  .stx-sky-lift { opacity: 0.55; }
  .stx-blob { position: absolute; width: 620px; height: 620px; border-radius: 50%; filter: blur(46px); will-change: transform; }
  .stx-blob-a { top: -320px; left: -140px; animation: stxDriftA 68s ease-in-out infinite alternate; }
  .stx-blob-b { top: -360px; right: -180px; animation: stxDriftB 86s ease-in-out infinite alternate; }
  .stx-blob-c { top: -260px; left: 32%; animation: stxDriftC 102s ease-in-out infinite alternate; }
  .stx-sky-fade { position: absolute; inset: 0; background: linear-gradient(180deg, rgba(255,255,255,0) 0%, rgba(255,255,255,0.72) 62%, #FFFFFF 100%); }
  .stx-grain { position: absolute; inset: 0; pointer-events: none; opacity: 0.05; z-index: 0; }
  @keyframes stxDriftA { from { transform: translate3d(0,0,0) scale(1); } to { transform: translate3d(90px, 44px, 0) scale(1.12); } }
  @keyframes stxDriftB { from { transform: translate3d(0,0,0) scale(1.06); } to { transform: translate3d(-70px, 30px, 0) scale(0.96); } }
  @keyframes stxDriftC { from { transform: translate3d(0,0,0) scale(0.98); } to { transform: translate3d(40px, 60px, 0) scale(1.1); } }

  /* page-load choreography */
  .stx-rise { animation: stxRise .6s cubic-bezier(.05,.7,.1,1) both; }
  @keyframes stxRise { from { opacity: 0; transform: translateY(16px); filter: blur(3px); } to { opacity: 1; transform: translateY(0); filter: blur(0); } }
  .stx-fadeswap { animation: stxFade .5s ease both; }
  @keyframes stxFade { from { opacity: 0; } to { opacity: 1; } }

  /* rolling odometer */
  .stx-odo { display: inline-block; height: 1em; overflow: hidden; vertical-align: baseline; }
  .stx-odo-strip { display: block; transition: transform .55s cubic-bezier(.2,.8,.2,1); will-change: transform; }
  .stx-odo-cell { display: block; height: 1em; line-height: 1; }

  /* live status dot */
  .stx-livedot { position: relative; width: 8px; height: 8px; border-radius: 4px; background: ${C.green}; flex-shrink: 0; }
  .stx-livedot::after { content: ''; position: absolute; inset: -4px; border-radius: 999px; border: 1.5px solid ${C.green}; opacity: 0; animation: stxPing 2.6s cubic-bezier(.2,.6,.4,1) infinite; }
  @keyframes stxPing { 0% { transform: scale(.5); opacity: .55; } 70%, 100% { transform: scale(1.25); opacity: 0; } }

  /* day meter segments */
  .stx-seg { flex: 1; height: 3px; border-radius: 999px; background: ${C.paper2}; overflow: hidden; position: relative; transition: background .4s ease; }
  .stx-seg-on { background: ${C.green}; }
  .stx-seg-on::after { content: ''; position: absolute; inset: 0; background: linear-gradient(90deg, transparent, rgba(255,255,255,.75), transparent); transform: translateX(-100%); animation: stxSheen .9s ease .1s 1 both; }
  @keyframes stxSheen { to { transform: translateX(100%); } }

  /* glassy panels */
  .stx-glass { background: rgba(255,255,255,0.72); border: 1px solid ${C.line}; backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px); box-shadow: 0 1px 2px rgba(32,37,31,0.04), 0 8px 28px -18px rgba(32,37,31,0.18); }

  /* labor fill */
  .stx-laborfill { height: 100%; background: linear-gradient(90deg, ${C.greenL}, ${C.green}); border-radius: 999px; transition: width 1.1s cubic-bezier(.2,.8,.2,1) .25s; }

  /* cards */
  .stx-cardwrap { display: grid; grid-template-rows: 1fr; margin-bottom: 12px; animation: stxDeal .62s cubic-bezier(.22,1.2,.36,1) both; transition: grid-template-rows .42s cubic-bezier(.4,0,.2,1), margin-bottom .42s cubic-bezier(.4,0,.2,1), opacity .4s ease, transform .42s cubic-bezier(.4,0,.2,1); }
  .stx-cardwrap-out { grid-template-rows: 0fr; margin-bottom: 0; opacity: 0; transform: translateY(22px) scale(.97); }
  .stx-cardwrap-in { animation: stxDeal .55s cubic-bezier(.22,1.2,.36,1) both; }
  @keyframes stxDeal { from { opacity: 0; transform: translateY(22px) scale(.98); filter: blur(3px); } to { opacity: 1; transform: translateY(0) scale(1); filter: blur(0); } }

  .stx-card { box-shadow: 0 1px 2px rgba(32,37,31,0.05), 0 12px 32px -22px rgba(32,37,31,0.22); transition: transform .28s cubic-bezier(.2,.8,.2,1), box-shadow .28s ease, border-color .28s ease; }
  .stx-card:hover { transform: translateY(-2px); border-color: ${C.line2}; box-shadow: 0 2px 4px rgba(32,37,31,0.05), 0 22px 44px -22px rgba(32,37,31,0.3); }
  .stx-card:hover .stx-card-hair { opacity: 1; }
  .stx-card-hair { transition: opacity .28s ease; }
  .stx-card-urgent { animation: stxBreathe 3.2s ease-in-out infinite; }
  @keyframes stxBreathe {
    0%, 100% { box-shadow: 0 1px 2px rgba(32,37,31,0.05), 0 12px 32px -22px rgba(32,37,31,0.22), 0 0 0 0 rgba(188,94,55,0); }
    50% { box-shadow: 0 1px 2px rgba(32,37,31,0.05), 0 12px 32px -22px rgba(32,37,31,0.22), 0 0 0 5px rgba(188,94,55,0.07); }
  }

  /* buttons */
  .stx-btn-primary { transition: filter .15s ease, transform .12s ease, background .3s ease; }
  .stx-btn-primary:hover:not(:disabled) { filter: brightness(1.12); }
  .stx-btn-primary:active:not(:disabled) { transform: scale(.96); }
  .stx-btn-primary::before { content: ''; position: absolute; inset: 0; background: linear-gradient(105deg, transparent 38%, rgba(255,255,255,.24) 50%, transparent 62%); transform: translateX(-120%); }
  .stx-btn-primary:hover:not(:disabled)::before { transform: translateX(120%); transition: transform .7s ease; }
  .stx-btn-done { animation: stxPop .4s cubic-bezier(.22,1.4,.36,1); }
  @keyframes stxPop { 0% { transform: scale(.94); } 60% { transform: scale(1.04); } 100% { transform: scale(1); } }
  .stx-btn-ghost { transition: border-color .15s ease, color .15s ease, background .15s ease; }
  .stx-btn-ghost:hover { color: ${C.ink}; border-color: ${C.ink3}; background: ${C.paper2}; }

  /* self-drawing check */
  .stx-checkdraw { stroke-dasharray: 24; stroke-dashoffset: 24; animation: stxDraw .5s cubic-bezier(.2,.8,.2,1) both; }
  @keyframes stxDraw { to { stroke-dashoffset: 0; } }

  /* all-clear */
  .stx-allclear { animation: stxBloom .7s cubic-bezier(.22,1.2,.36,1) both; }
  @keyframes stxBloom { from { opacity: 0; transform: scale(.97); } to { opacity: 1; transform: scale(1); } }
  .stx-ripple { position: absolute; left: 50%; top: 66px; width: 52px; height: 52px; margin-left: -26px; margin-top: -26px; border-radius: 999px; border: 1.5px solid rgba(53,107,76,0.4); animation: stxRipple 1.3s cubic-bezier(.2,.6,.4,1) .3s both; }
  @keyframes stxRipple { from { transform: scale(.6); opacity: .8; } to { transform: scale(4.4); opacity: 0; } }

  /* ledger */
  .stx-ledger { background: rgba(255,255,255,0.72); border: 1px solid ${C.line}; backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px); transition: background .5s ease, border-color .5s ease, box-shadow .5s ease; }
  .stx-ledger-flash { background: rgba(53,107,76,0.08); border-color: rgba(53,107,76,0.28); box-shadow: 0 0 0 4px rgba(53,107,76,0.06); }
  .stx-ledger-body { display: grid; transition: grid-template-rows .45s cubic-bezier(.2,.8,.2,1); }
  .stx-ledger-fresh { animation: stxFreshRow 1s ease both; }
  @keyframes stxFreshRow { from { background: rgba(53,107,76,0.10); } to { background: transparent; } }
  .stx-twinkle { animation: stxTwinkle 3.4s ease-in-out infinite; }
  @keyframes stxTwinkle { 0%, 100% { opacity: 1; transform: rotate(0deg) scale(1); } 50% { opacity: .55; transform: rotate(12deg) scale(.9); } }

  /* ask hint cycler */
  .stx-hint { display: inline-block; animation: stxHint .55s cubic-bezier(.05,.7,.1,1) both; }
  @keyframes stxHint { from { opacity: 0; transform: translateY(7px); } to { opacity: 1; transform: translateY(0); } }

  /* undo snackbar — sits above the global Ask bar */
  .stx-snack { position: fixed; bottom: 104px; left: 50%; transform: translateX(-50%); z-index: 60; display: flex; align-items: center; gap: 10px; background: ${C.ink}; color: ${C.paper}; font-family: ${SANS}; font-size: 13px; font-weight: 500; padding: 9px 10px 9px 16px; border-radius: 999px; box-shadow: 0 14px 40px -12px rgba(32,37,31,0.5); animation: stxSnack .45s cubic-bezier(.22,1.2,.36,1) both; }
  @keyframes stxSnack { from { opacity: 0; transform: translateX(-50%) translateY(14px) scale(.96); } to { opacity: 1; transform: translateX(-50%) translateY(0) scale(1); } }

  @media (prefers-reduced-motion: reduce) {
    .stx-rise, .stx-cardwrap, .stx-cardwrap-in, .stx-fadeswap, .stx-allclear, .stx-btn-done,
    .stx-checkdraw, .stx-hint, .stx-snack, .stx-seg-on::after, .stx-ledger-fresh { animation-duration: .001ms !important; animation-delay: 0ms !important; }
    .stx-blob, .stx-livedot::after, .stx-twinkle, .stx-card-urgent, .stx-ripple { animation: none !important; }
    .stx-odo-strip, .stx-laborfill, .stx-cardwrap, .stx-ledger-body { transition-duration: .001ms !important; }
  }
`;
