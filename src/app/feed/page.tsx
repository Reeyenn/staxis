'use client';

// ════════════════════════════════════════════════════════════════════
// Staxis · Feed — the decision-feed home ("your hotel's inbox").
//
// The AI runs every department in the background and surfaces only the
// DECISIONS that need a human: one tap to approve. This is Phase 1 — the
// page built beautiful on realistic sample data, in the same editorial
// design language as the dashboard (Fraunces serif italics, Geist sans,
// mono numbers, the warm green / rust / sage palette). Approving a card
// animates it into the "Handled automatically" log so the page feels
// alive. Wiring each card to real data + real actions is Phase 2+.
// ════════════════════════════════════════════════════════════════════

export const dynamic = 'force-dynamic';

import React, { useEffect, useMemo, useState } from 'react';
import {
  BedDouble, Wrench, Package, MessageSquare, Droplets, UserRound,
  Check, ChevronDown, Sparkles, Send, type LucideIcon,
} from 'lucide-react';
import { AppLayout } from '@/components/layout/AppLayout';

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
  rustBg: '#F4E2D6',
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

// ─── decision-card model ──────────────────────────────────────────────
type Tone = 'save' | 'urgent' | 'info';
type DecisionCard = {
  id: string;
  dept: string;
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
    dept: 'Staff',
    icon: UserRound, accent: C.gold, tint: 'rgba(192,154,60,0.12)',
    title: 'Maria hasn’t confirmed tomorrow',
    detail: 'No reply since last night. Lupe is available as backup — want me to text her to be safe?',
    impact: { text: 'avoids a morning scramble', tone: 'save' },
    primary: 'Text Lupe', secondary: 'Call Maria',
    handledNote: 'Texted Lupe to cover as backup',
  },
  {
    id: 'crew-tomorrow',
    dept: 'Housekeeping',
    icon: BedDouble, accent: C.green, tint: 'rgba(53,107,76,0.10)',
    title: 'Tomorrow’s crew is ready',
    detail: '86 rooms · 4 housekeepers — Ana, Rosa, Maria, Lupe. Board balanced by floor and checkout load.',
    impact: { text: 'saves ~$210 vs a flat 5-person crew', tone: 'save' },
    primary: 'Approve & send', secondary: 'Adjust',
    handledNote: 'Sent tomorrow’s board to 4 housekeepers',
  },
  {
    id: 'inv-towels',
    dept: 'Inventory',
    icon: Package, accent: C.ink2, tint: 'rgba(32,37,31,0.07)',
    title: 'Towels run out Thursday',
    detail: 'At today’s pace you’ll be short by Thursday. Order drafted: 6 cases · $310 · ABC Supply.',
    impact: { text: '$310', tone: 'info' },
    primary: 'Approve order', secondary: 'Change',
    handledNote: 'Placed towel order — 6 cases, ABC Supply',
  },
  {
    id: 'maint-214',
    dept: 'Maintenance',
    icon: Wrench, accent: C.gold, tint: 'rgba(192,154,60,0.12)',
    title: 'AC in 214 keeps coming back',
    detail: 'Reported twice this week. A work order is drafted and ready for José.',
    primary: 'Send to José', secondary: 'Why?',
    handledNote: 'Routed AC work order (214) to José',
  },
  {
    id: 'comp-pool',
    dept: 'Compliance',
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

// ─── one decision card ────────────────────────────────────────────────
function Card({ card, exiting, onPrimary, onSecondary }: {
  card: DecisionCard;
  exiting: boolean;
  onPrimary: () => void;
  onSecondary: () => void;
}) {
  const Icon = card.icon;
  const impactColor = card.impact?.tone === 'urgent' ? C.rust
    : card.impact?.tone === 'save' ? C.green : C.ink3;
  return (
    <div className={'stx-card' + (exiting ? ' stx-card-exit' : '')}
      style={{
        background: C.paper,
        border: `1px solid ${C.line}`,
        borderLeft: card.urgent ? `3px solid ${C.rust}` : `1px solid ${C.line}`,
        borderRadius: 16,
        padding: '18px 18px 16px',
        boxShadow: '0 1px 3px rgba(32,37,31,0.05), 0 1px 2px rgba(32,37,31,0.03)',
        display: 'flex', gap: 14,
      }}>
      {/* icon */}
      <div style={{
        width: 38, height: 38, borderRadius: 11, background: card.tint,
        display: 'grid', placeItems: 'center', flexShrink: 0, marginTop: 1,
      }}>
        <Icon size={19} color={card.accent} strokeWidth={2} />
      </div>

      {/* body */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ ...LABEL, fontSize: 10, color: card.accent, marginBottom: 5 }}>{card.dept}</div>
        <div style={{ fontFamily: SANS, fontSize: 15.5, fontWeight: 600, color: C.ink, lineHeight: 1.3 }}>
          {card.title}
        </div>
        <div style={{ fontFamily: SANS, fontSize: 13.5, color: C.ink2, lineHeight: 1.5, marginTop: 5 }}>
          {card.detail}
        </div>

        {/* impact + actions */}
        <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 10, marginTop: 14 }}>
          <button onClick={onPrimary} className="stx-btn-primary"
            style={{
              fontFamily: SANS, fontSize: 13.5, fontWeight: 600, color: C.paper,
              background: card.urgent ? C.rust : C.ink, border: 'none',
              borderRadius: 10, padding: '9px 16px', cursor: 'pointer',
              display: 'inline-flex', alignItems: 'center', gap: 7,
            }}>
            {card.primary === 'Send reply' && <Send size={14} />}
            {card.primary}
          </button>
          {card.secondary && (
            <button onClick={onSecondary} className="stx-btn-ghost"
              style={{
                fontFamily: SANS, fontSize: 13.5, fontWeight: 500, color: C.ink2,
                background: 'transparent', border: `1px solid ${C.line2}`,
                borderRadius: 10, padding: '9px 14px', cursor: 'pointer',
              }}>
              {card.secondary}
            </button>
          )}
          {card.impact && (
            <span style={{
              marginLeft: 'auto', fontFamily: SANS, fontSize: 12.5, fontWeight: 600,
              color: impactColor, display: 'inline-flex', alignItems: 'center', gap: 5,
            }}>
              {card.impact.tone === 'save' && '↓'}
              {card.impact.text}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── page ─────────────────────────────────────────────────────────────
export default function FeedPage() {
  const [cards, setCards] = useState<DecisionCard[]>(SAMPLE);
  const [exiting, setExiting] = useState<Set<string>>(new Set());
  const [handled, setHandled] = useState<{ text: string; at: string }[]>(PREHANDLED);
  const [logOpen, setLogOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const greeting = useMemo(() => {
    const h = new Date().getHours();
    return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
  }, []);
  const dateLong = useMemo(
    () => new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' }),
    [],
  );
  const nowTime = useMemo(
    () => new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }).toLowerCase().replace(' ', ''),
    [],
  );

  // approve → animate out → drop into the handled log
  const approve = (card: DecisionCard) => {
    setExiting(prev => new Set(prev).add(card.id));
    window.setTimeout(() => {
      setCards(prev => prev.filter(c => c.id !== card.id));
      setHandled(prev => [{ text: card.handledNote, at: nowTime }, ...prev]);
      setExiting(prev => { const n = new Set(prev); n.delete(card.id); return n; });
    }, 300);
  };
  const dismiss = (card: DecisionCard) => {
    // secondary action — in Phase 1 it just slides the card away
    setExiting(prev => new Set(prev).add(card.id));
    window.setTimeout(() => {
      setCards(prev => prev.filter(c => c.id !== card.id));
      setExiting(prev => { const n = new Set(prev); n.delete(card.id); return n; });
    }, 300);
  };

  // labor scoreboard (sample)
  const spent = 1840, budget = 1910;
  const pct = Math.min(100, Math.round((spent / budget) * 100));
  const under = budget - spent;

  const allClear = cards.length === 0;

  return (
    <AppLayout>
      <div style={{
        width: '100%', minHeight: '100vh', background: C.paper, fontFamily: SANS, color: C.ink,
        padding: 'clamp(18px, 2vw, 32px) clamp(16px, 3vw, 48px) 120px',
      }}>
        <style>{`
          .stx-feed { max-width: 760px; margin: 0 auto; display: flex; flex-direction: column; gap: 22px; }
          .stx-card { animation: stxIn .34s cubic-bezier(.05,.7,.1,1) both; transition: opacity .28s ease, transform .28s cubic-bezier(.4,0,.1,1); }
          .stx-card-exit { opacity: 0; transform: translateX(40px) scale(.98); }
          .stx-btn-primary { transition: filter .15s ease, transform .12s ease; }
          .stx-btn-primary:hover { filter: brightness(1.12); }
          .stx-btn-primary:active { transform: scale(.97); }
          .stx-btn-ghost { transition: border-color .15s ease, color .15s ease, background .15s ease; }
          .stx-btn-ghost:hover { color: ${C.ink}; border-color: ${C.ink3}; background: ${C.paper2}; }
          .stx-feed-stack > * + * { margin-top: 12px; }
          @keyframes stxIn { from { opacity: 0; transform: translateY(14px); } to { opacity: 1; transform: translateY(0); } }
          @media (prefers-reduced-motion: reduce) { .stx-card { animation-duration: .001ms; } }
        `}</style>

        <div className="stx-feed">

          {/* ── pulse ── */}
          <header style={{ marginTop: 4 }}>
            <div style={{ ...LABEL, marginBottom: 8 }}>
              {mounted ? `${greeting} · ${dateLong}` : ' '}
            </div>
            <h1 style={{
              fontFamily: SERIF, fontStyle: 'italic', fontWeight: 500,
              fontSize: 'clamp(30px, 5vw, 42px)', lineHeight: 1.05, color: C.ink, letterSpacing: '-0.01em',
            }}>
              {allClear ? 'You’re all caught up.' : 'You’re covered for tonight.'}
            </h1>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 12, color: C.ink2, fontSize: 14 }}>
              <span style={{ width: 8, height: 8, borderRadius: 4, background: C.green, flexShrink: 0 }} />
              <span>78% occupancy · 22 rooms left to clean · all shifts staffed</span>
            </div>
          </header>

          {/* ── labor scoreboard ── */}
          <section style={{
            border: `1px solid ${C.line}`, borderRadius: 16, padding: '16px 18px',
            background: C.paper, display: 'flex', alignItems: 'center', gap: 18,
          }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ ...LABEL, marginBottom: 8 }}>Labor today</div>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                <span style={{ fontFamily: MONO, fontSize: 26, fontWeight: 700, letterSpacing: '-0.03em', color: C.ink }}>
                  ${spent.toLocaleString()}
                </span>
                <span style={{ fontFamily: MONO, fontSize: 14, color: C.ink3 }}>/ ${budget.toLocaleString()}</span>
              </div>
              <div style={{ height: 4, borderRadius: 999, background: C.paper2, marginTop: 12, overflow: 'hidden' }}>
                <div style={{ height: '100%', width: `${pct}%`, background: C.green, borderRadius: 999 }} />
              </div>
            </div>
            <div style={{ textAlign: 'right', flexShrink: 0 }}>
              <div style={{ fontFamily: SERIF, fontStyle: 'italic', fontWeight: 500, fontSize: 28, color: C.green, lineHeight: 1 }}>
                ${under}
              </div>
              <div style={{ fontSize: 12, color: C.ink3, marginTop: 4 }}>under budget</div>
            </div>
          </section>

          {/* ── needs you ── */}
          <section>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
              <span style={LABEL}>Needs you</span>
              {!allClear && (
                <span style={{
                  background: C.ink, color: C.paper, borderRadius: 999, minWidth: 22, height: 22,
                  padding: '0 7px', display: 'grid', placeItems: 'center', fontSize: 12, fontWeight: 700, fontFamily: MONO,
                }}>{cards.length}</span>
              )}
              <span style={{ flex: 1, height: 1, background: C.line }} />
            </div>

            {allClear ? (
              <div style={{
                border: `1px solid ${C.line}`, borderRadius: 16, padding: '34px 22px', textAlign: 'center',
                background: '#E7EFE7',
              }}>
                <div style={{
                  width: 44, height: 44, borderRadius: 22, background: 'rgba(53,107,76,0.14)',
                  display: 'grid', placeItems: 'center', margin: '0 auto 14px',
                }}>
                  <Check size={22} color={C.green} strokeWidth={2.4} />
                </div>
                <div style={{ fontFamily: SERIF, fontStyle: 'italic', fontWeight: 500, fontSize: 22, color: C.green }}>
                  Nothing needs you right now.
                </div>
                <div style={{ fontSize: 13.5, color: C.ink2, marginTop: 6 }}>
                  Staxis is running the floor. I’ll bring you anything worth a decision.
                </div>
              </div>
            ) : (
              <div className="stx-feed-stack">
                {cards.map(card => (
                  <Card key={card.id} card={card} exiting={exiting.has(card.id)}
                    onPrimary={() => approve(card)} onSecondary={() => dismiss(card)} />
                ))}
              </div>
            )}
          </section>

          {/* ── handled automatically ── */}
          <section style={{ border: `1px solid ${C.line}`, borderRadius: 16, overflow: 'hidden' }}>
            <button onClick={() => setLogOpen(v => !v)}
              style={{
                width: '100%', background: 'transparent', border: 'none', cursor: 'pointer',
                padding: '15px 18px', display: 'flex', alignItems: 'center', gap: 10, textAlign: 'left',
              }}>
              <Sparkles size={16} color={C.sage} strokeWidth={2} />
              <span style={{ fontFamily: SANS, fontSize: 13.5, fontWeight: 600, color: C.ink2 }}>
                Handled automatically
              </span>
              <span style={{ fontFamily: MONO, fontSize: 12.5, color: C.ink3 }}>· {handled.length} today</span>
              <ChevronDown size={17} color={C.ink3}
                style={{ marginLeft: 'auto', transition: 'transform .2s ease', transform: logOpen ? 'rotate(180deg)' : 'none' }} />
            </button>
            {logOpen && (
              <div style={{ padding: '0 18px 8px' }}>
                {handled.map((h, i) => (
                  <div key={i} style={{
                    display: 'flex', alignItems: 'center', gap: 11, padding: '9px 0',
                    borderTop: `1px solid ${C.line}`,
                  }}>
                    <Check size={14} color={C.green} strokeWidth={2.6} style={{ flexShrink: 0 }} />
                    <span style={{ fontSize: 13.5, color: C.ink2, flex: 1 }}>{h.text}</span>
                    <span style={{ fontFamily: MONO, fontSize: 12, color: C.ink4 }}>{h.at}</span>
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* ── ask hint (the real Ask bar is global, bottom of screen) ── */}
          <div style={{ textAlign: 'center', color: C.ink4, fontSize: 12.5, marginTop: 2 }}>
            Ask or tell Staxis anything below — “add a cleaner tomorrow”, “why was labor high?”
          </div>

        </div>
      </div>
    </AppLayout>
  );
}
