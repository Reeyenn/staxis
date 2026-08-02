'use client';

/* ───────────────────────────────────────────────────────────────────────
   SURFACE — Onboarding · "Launch Bay" (dark).

   The design-handoff finalized Onboarding screen, wired to the real v4
   onboarding pipeline. Watch every invited first person move signup → live.

   Data (same endpoints the prior OnboardingTab used):
     • /api/admin/list-properties        → properties + onboarding state
     • /api/admin/prospects               → sales pipeline (full CRUD kept)
   Mutations kept: prospect CRUD.

   Layout: one six-stage timeline row per onboarding hotel (journeyOf maps
   only onboarding_state + onboarding_completed_at).
   Clicking a row expands the invited person, hotel details, and current
   onboarding stage.
   ─────────────────────────────────────────────────────────────────────── */

import React, { useEffect, useRef, useState } from 'react';
import { fetchWithAuth } from '@/lib/api-fetch';
import {
  FONT_SERIF, Caps, Dot, Btn,
  countUp, sweepWidth, useRiseIn, age, type DotTone,
} from '../kit';
import { SurfaceShell, DarkEmpty, Backdrop, MODAL_CARD, dimWhite as dim } from '../surface-kit';
import { RowButton } from '../ui-kit';

// ── Real API shapes (mirror the prior OnboardingTab interfaces) ─────────
export interface OnbState {
  step?: number;
  invitedEmail?: string | null;
  firstPersonAccountId?: string | null;
  accountCreatedAt?: string | null;
  emailVerifiedAt?: string | null;
  hotelDetailsAt?: string | null;
  hotelContextAt?: string | null;
}
export interface PropertyRow {
  id: string;
  name: string | null;
  createdAt: string;
  onboardingState: OnbState | null;
  onboardingCompletedAt: string | null;
}
type ProspectStatus = 'talking' | 'negotiating' | 'committed' | 'onboarded' | 'dropped';
interface Prospect {
  id: string; hotel_name: string; contact_name: string | null; contact_email: string | null;
  contact_phone: string | null; pms_type: string | null; expected_launch_date: string | null;
  status: ProspectStatus; notes: string | null; checklist: Record<string, boolean>;
  created_at: string; updated_at: string;
}

// ── The six-stage onboarding journey (mirrors the /onboard wizard) ─────
export const STEP_LABELS = ['Welcome', 'Account', 'Verify email', 'About hotel', 'Your hotel', 'Done'] as const;
const TOTAL_STEPS = STEP_LABELS.length;

export interface Journey { step: number; label: string; sub: string; href: string; needsYou: boolean; }

// Latest activity timestamp across the durable customer-step markers.
function latestStateTs(s: OnbState | null): number {
  if (!s) return 0;
  return [
    s.accountCreatedAt,
    s.emailVerifiedAt,
    s.hotelDetailsAt,
    s.hotelContextAt,
  ].reduce((latest, value) => {
    const parsed = value ? Date.parse(value) : Number.NaN;
    return Number.isFinite(parsed) && parsed > latest ? parsed : latest;
  }, 0);
}

// Live is normally the durable completion boundary. Retained pre-wizard hotels
// have the historical `{}`/null state and no completion timestamp; treating
// exactly that markerless shape as legacy-live prevents them from becoming
// fake new invitations. New shells explicitly persist `{ step: 1 }`.
export function isLive(p: PropertyRow): boolean {
  if (p.onboardingCompletedAt) return true;
  return !p.onboardingState || Object.keys(p.onboardingState).length === 0;
}

// Position the hotel at the first unfinished stage. PMS connection and team
// management happen later from their dedicated operational surfaces.
//
// Stage 1 has two truthful shapes, and `invitedEmail` is the only thing that
// tells them apart. Both admin entry points that mint a first-person
// invitation (the Add-hotel modal's optional first-person field, and the My
// Hotel → People control) go through the same guarded mint, which stamps
// `invitedEmail` onto the hotel's onboarding state. So a hotel created WITH an
// invitation lands on "Invitation ready", and only a hotel with nobody invited
// shows the pointer at the People control.
export function journeyOf(p: PropertyRow): Journey {
  const propHref = `/admin/properties/${p.id}`;
  const s = p.onboardingState;
  if (!s?.accountCreatedAt) {
    if (s?.step === 2) {
      return { step: 2, label: 'Creating account', sub: 'Clicked Begin. Creating the assigned account.', href: propHref, needsYou: false };
    }
    return {
      step: 1,
      label: s?.invitedEmail ? 'Invitation ready' : 'Waiting for first person',
      sub: s?.invitedEmail
        ? 'The invited person has not started yet.'
        : 'Invite the first person from this hotel’s People control.',
      href: propHref,
      needsYou: false,
    };
  }
  if (!s.emailVerifiedAt) {
    return { step: 3, label: 'Verifying email', sub: 'Account created. Confirming the invited email.', href: propHref, needsYou: false };
  }
  if (!s.hotelDetailsAt) {
    return { step: 4, label: 'About the hotel', sub: 'Entering rooms, brand, timezone, and hotel details.', href: propHref, needsYou: false };
  }
  if (!s.hotelContextAt) {
    return { step: 5, label: 'Your hotel', sub: 'Optional notes for Staxis, then setup is done.', href: propHref, needsYou: false };
  }
  return { step: 6, label: 'Ready to enter', sub: 'All set. Entering Staxis marks the hotel live.', href: propHref, needsYou: false };
}

// Timeline row layout — header labels + each hotel row share these so the
// step labels line up exactly above the node dots.
const NAME_W = 150;   // left "hotel name" column (px)
const STATUS_W = 140; // right "current step" column (px)
const ROW_GAP = 12;   // gap between name · rail · status

// A hotel untouched this long gets tucked
// into the collapsed "Parked" group so the top of the page is only real
// activity (owner ask 2026-07-17: old test hotels sat as noise for 40 days).
const PARK_AFTER_DAYS = 14;

// Animated open/close (same pattern as Mission Control's disclosures).
function Reveal({ open, children }: { open: boolean; children: React.ReactNode }) {
  return (
    <div style={{ display: 'grid', gridTemplateRows: open ? '1fr' : '0fr', transition: 'grid-template-rows .26s ease' }} aria-hidden={!open}>
      <div style={{ overflow: 'hidden', opacity: open ? 1 : 0, transition: 'opacity .22s ease' }}>{children}</div>
    </div>
  );
}

export function OnboardingSurface() {
  const [props, setProps] = useState<PropertyRow[] | null>(null);
  const [prospects, setProspects] = useState<Prospect[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [parkedOpen, setParkedOpen] = useState(false);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = async () => {
    try {
      const [a, d] = await Promise.all([
        fetchWithAuth('/api/admin/list-properties'),
        fetchWithAuth('/api/admin/prospects'),
      ]);
      const [aj, dj] = await Promise.all([a.json(), d.json()]);
      if (aj.ok) setProps(aj.data.properties);
      if (dj.ok) setProspects(dj.data.prospects);
    } catch (err) {
      setError(`Network error: ${(err as Error).message}`);
    }
  };
  useEffect(() => { void load(); }, []);
  // Keep the six-stage customer journey moving while any hotel is unfinished.
  useEffect(() => {
    const inWizard = (props ?? []).some((p) => !isLive(p));
    if (!inWizard) return;
    refreshTimer.current = setTimeout(() => { void load(); }, 5000);
    return () => { if (refreshTimer.current) clearTimeout(refreshTimer.current); };
  }, [props]);

  // Hover-✕ delete for a junk/test hotel. Confirmed client-side, and the
  // server refuses to delete a hotel that has finished onboarding.
  const deleteHotel = async (p: PropertyRow) => {
    if (!window.confirm(`Delete “${p.name ?? 'this hotel'}”? This permanently removes the hotel, all of its data, and its linked login (frees the email to re-use).`)) return;
    setDeletingId(p.id);
    try {
      const res = await fetchWithAuth('/api/admin/properties/delete', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ propertyId: p.id }),
      });
      const json = await res.json();
      if (json.ok) { if (expandedId === p.id) setExpandedId(null); await load(); }
      else window.alert(json.error ?? 'Delete failed');
    } catch (e) {
      window.alert(`Delete failed: ${(e as Error).message}`);
    } finally {
      setDeletingId(null);
    }
  };

  if (error) return <SurfaceShell glow="forestTR"><div style={{ color: 'var(--terracotta)', fontSize: 13 }}>{error}</div></SurfaceShell>;
  if (!props) {
    return <SurfaceShell glow="forestTR"><div style={{ padding: '80px 0', textAlign: 'center' }}><span className="spinner" style={{ width: 22, height: 22, display: 'inline-block', borderTopColor: '#fff' }} /></div></SurfaceShell>;
  }

  // Hotels still on the timeline (not yet live), most-recently-active first
  // so the one a customer is actively walking sits at the top.
  const allJourneyRows = props
    .filter((p) => !isLive(p))
    .map((p) => ({ p, j: journeyOf(p), ts: latestStateTs(p.onboardingState) }))
    .sort((a, c) => (c.ts - a.ts) || (Date.parse(c.p.createdAt) - Date.parse(a.p.createdAt)));
  // Split off long-idle early-stage hotels into the collapsed Parked group.
  const isParkedRow = (r: (typeof allJourneyRows)[number]) =>
    (Date.now() - Math.max(r.ts, Date.parse(r.p.createdAt))) > PARK_AFTER_DAYS * 86_400_000;
  const journeyRows = allJourneyRows.filter((r) => !isParkedRow(r));
  const parkedRows = allJourneyRows.filter(isParkedRow);
  const liveCount = props.filter(isLive).length;
  const activeProspects = (prospects ?? []).filter((p) => p.status !== 'onboarded' && p.status !== 'dropped');

  return (
    <SurfaceShell glow="forestTR">
      <header style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap', marginBottom: 22, position: 'relative' }}>
        <div>
          <span className="caps" style={{ color: dim(.55) }}>Onboarding · Launch bay</span>
          <h1 style={{ fontFamily: FONT_SERIF, fontSize: 32, fontWeight: 400, letterSpacing: '-0.02em', margin: '4px 0 0', color: '#fff' }}>
            Everything <span style={{ fontStyle: 'italic' }}>inbound to live</span>
          </h1>
        </div>
      </header>

      {/* ── Live onboarding journey — one rail per hotel, fills as they move ── */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
        <span className="caps" style={{ color: dim(.55) }}>Onboarding · live journey</span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, padding: '4px 12px 4px 11px', borderRadius: 999, background: 'rgba(60,156,104,.15)', border: '1px solid rgba(60,156,104,.4)' }}>
          <Dot tone="forest" size={7} />
          <BayLiveCount n={liveCount} />
          <span className="mono" style={{ fontSize: 9, color: dim(.6), letterSpacing: '.08em' }}>{liveCount === 1 ? 'HOTEL LIVE' : 'HOTELS LIVE'}</span>
        </span>
      </div>

      {/* step-label header — lines up exactly above the node dots below */}
      <div style={{ display: 'flex', alignItems: 'center', gap: ROW_GAP, padding: '0 14px 7px' }}>
        <div style={{ width: NAME_W, flexShrink: 0 }} />
        <div style={{ flex: 1, minWidth: 0, display: 'flex', justifyContent: 'space-between' }}>
          {STEP_LABELS.map((l, i) => (
            <span key={i} className="mono" style={{ fontSize: 8.5, color: i === STEP_LABELS.length - 1 ? 'rgba(60,156,104,.85)' : dim(.42), letterSpacing: '.02em', whiteSpace: 'nowrap' }}>{l}</span>
          ))}
        </div>
        <div style={{ width: STATUS_W, flexShrink: 0 }} />
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {journeyRows.length === 0 && parkedRows.length === 0
          ? <DarkEmpty text="No hotels onboarding right now." />
          : journeyRows.map((r) => (
            <HotelRow
              key={r.p.id} row={r}
              hoverId={hoverId} setHoverId={setHoverId}
              deletingId={deletingId} deleteHotel={deleteHotel}
              expandedId={expandedId} setExpandedId={setExpandedId}
            />
          ))}
      </div>

      {/* Long-idle early hotels tucked away — click to reveal, animated. */}
      {parkedRows.length > 0 && (
        <div style={{ marginTop: 10 }}>
          <button
            onClick={() => setParkedOpen((o) => !o)}
            aria-expanded={parkedOpen}
            className="mono"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 9.5, letterSpacing: '.1em', color: dim(.5), background: 'none', border: 'none', cursor: 'pointer', padding: '4px 2px' }}
          >
            PARKED · {parkedRows.length} · no activity in {PARK_AFTER_DAYS}+ days {parkedOpen ? '▴' : '▾'}
          </button>
          <Reveal open={parkedOpen}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, paddingTop: 6 }}>
              {parkedRows.map((r) => (
                <HotelRow
                  key={r.p.id} row={r}
                  hoverId={hoverId} setHoverId={setHoverId}
                  deletingId={deletingId} deleteHotel={deleteHotel}
                  expandedId={expandedId} setExpandedId={setExpandedId}
                />
              ))}
            </div>
          </Reveal>
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 16, marginTop: 26, position: 'relative' }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span className="caps" style={{ color: dim(.5) }}>Prospects</span>
            <AddProspect onAdded={load} />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 7, marginTop: 10 }}>
            {activeProspects.length === 0
              ? <DarkEmpty text="No prospects yet." />
              : activeProspects.map((p) => <BayProspect key={p.id} p={p} onSaved={load} />)}
          </div>
        </div>
      </div>

    </SurfaceShell>
  );
}

// Row + hover-delete + expandable panel, shared by the active list and the
// Parked group so both behave identically.
function HotelRow({ row, hoverId, setHoverId, deletingId, deleteHotel, expandedId, setExpandedId }: {
  row: { p: PropertyRow; j: Journey };
  hoverId: string | null;
  setHoverId: React.Dispatch<React.SetStateAction<string | null>>;
  deletingId: string | null;
  deleteHotel: (p: PropertyRow) => Promise<void>;
  expandedId: string | null;
  setExpandedId: React.Dispatch<React.SetStateAction<string | null>>;
}) {
  const { p, j } = row;
  return (
    <div
      style={{ position: 'relative' }}
      onMouseEnter={() => setHoverId(p.id)}
      onMouseLeave={() => setHoverId((h) => (h === p.id ? null : h))}
    >
      <JourneyRow p={p} j={j} expanded={expandedId === p.id} onClick={() => setExpandedId(expandedId === p.id ? null : p.id)} />
      {(hoverId === p.id || deletingId === p.id) && (
        <button
          title="Delete this hotel"
          aria-label={`Delete ${p.name ?? 'hotel'}`}
          onClick={(e) => { e.stopPropagation(); void deleteHotel(p); }}
          disabled={deletingId === p.id}
          style={{
            position: 'absolute', top: 7, right: 7, zIndex: 4,
            width: 22, height: 22, borderRadius: 6, padding: 0, lineHeight: 1, fontSize: 14,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: 'rgba(24,12,9,.92)', color: 'var(--terracotta)',
            border: '1px solid rgba(194,86,46,.5)',
            cursor: deletingId === p.id ? 'wait' : 'pointer',
          }}
        >{deletingId === p.id ? '·' : '×'}</button>
      )}
      {expandedId === p.id && <JourneyPanel propertyId={p.id} j={j} />}
    </div>
  );
}

// One hotel = one row: name · a six-node rail that fills to the live stage · the
// current step label. The fill bar + current node animate when the step
// advances (every poll), so you watch a hotel travel the whole journey.
function JourneyRow({ p, j, expanded, onClick }: { p: PropertyRow; j: Journey; expanded: boolean; onClick: () => void }) {
  const rowRef = useRef<HTMLButtonElement>(null);
  const fillRef = useRef<HTMLDivElement>(null);
  const current = j.step - 1; // 0-based index of the in-progress node
  const fillPct = TOTAL_STEPS > 1 ? (current / (TOTAL_STEPS - 1)) * 100 : 0;
  useRiseIn(rowRef, { dy: 10, dur: 420 });
  useEffect(() => { sweepWidth(fillRef.current, fillPct, { dur: 700 }); }, [fillPct]);
  const accentTone: DotTone = j.needsYou ? 'terracotta' : 'gold';
  const accent = `var(--${accentTone})`;
  const ring = accentTone === 'terracotta' ? 'rgba(194,86,46,.22)' : 'rgba(201,154,46,.22)';
  return (
    <button ref={rowRef} onClick={onClick} aria-expanded={expanded} style={{
      display: 'flex', alignItems: 'center', gap: ROW_GAP, width: '100%', textAlign: 'left',
      background: j.needsYou ? 'rgba(194,86,46,.07)' : expanded ? dim(.07) : dim(.04),
      border: `1px solid ${j.needsYou ? 'rgba(194,86,46,.4)' : expanded ? dim(.22) : dim(.12)}`,
      borderRadius: expanded ? '12px 12px 0 0' : 12, padding: '12px 14px', cursor: 'pointer', color: '#fff',
    }}>
      {/* hotel */}
      <div style={{ width: NAME_W, flexShrink: 0, minWidth: 0 }}>
        <div style={{ fontSize: 12.5, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name ?? '(unnamed)'}</div>
      </div>
      {/* rail */}
      <div style={{ flex: 1, minWidth: 0, position: 'relative', height: 16, display: 'flex', alignItems: 'center' }}>
        <div style={{ position: 'absolute', left: 5, right: 5, top: '50%', height: 2, transform: 'translateY(-50%)', background: dim(.13), borderRadius: 2 }} />
        <div ref={fillRef} style={{ position: 'absolute', left: 5, top: '50%', height: 2, transform: 'translateY(-50%)', width: 0, maxWidth: 'calc(100% - 10px)', background: j.needsYou ? 'var(--terracotta)' : 'linear-gradient(90deg, var(--forest), var(--gold))', borderRadius: 2 }} />
        <div style={{ position: 'relative', display: 'flex', justifyContent: 'space-between', width: '100%', zIndex: 1 }}>
          {STEP_LABELS.map((_, i) => {
            const done = i < current, cur = i === current;
            const sz = cur ? 11 : done ? 8 : 7;
            return <span key={i} style={{
              width: sz, height: sz, borderRadius: '50%', flexShrink: 0,
              background: done ? 'var(--forest)' : cur ? accent : dim(.16),
              boxShadow: cur ? `0 0 0 4px ${ring}` : 'none',
              border: (!done && !cur) ? `1px solid ${dim(.26)}` : 'none',
              transition: 'background .3s ease, box-shadow .3s ease, width .2s ease',
            }} />;
          })}
        </div>
      </div>
      {/* Current onboarding stage. */}
      <div style={{ width: STATUS_W, flexShrink: 0, textAlign: 'right', minWidth: 0 }}>
        <div style={{ fontSize: 11.5, fontWeight: 600, color: j.needsYou ? 'var(--terracotta)' : '#fff', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{j.label}{j.needsYou ? ' ›' : ''}</div>
        <div className="mono" style={{ fontSize: 9.5, color: dim(.45), marginTop: 2 }}>
          {j.step} / {TOTAL_STEPS} · {expanded ? 'close ▴' : 'detail ▾'}
        </div>
      </div>
    </button>
  );
}

// ── Journey detail — the first person, entered hotel details, and stage. ──
interface PanelDetail {
  property: {
    id: string; name: string | null; totalRooms: number | null; brand: string | null;
    timezone: string | null; createdAt: string;
    onboardingState: OnbState | null; onboardingCompletedAt: string | null;
  };
  owner: { name: string | null; email: string | null; phone: string | null } | null;
}

function PanelCaps({ children }: { children: React.ReactNode }) {
  return <div className="mono" style={{ fontSize: 9, letterSpacing: '.14em', textTransform: 'uppercase', color: dim(.45), marginBottom: 8 }}>{children}</div>;
}
function KV({ k, v, tone }: { k: string; v: React.ReactNode; tone?: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, padding: '3px 0', minWidth: 0 }}>
      <span style={{ fontSize: 11, color: dim(.5), flexShrink: 0 }}>{k}</span>
      <span style={{ fontSize: 11.5, fontWeight: 600, color: tone ?? '#fff', textAlign: 'right', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{v}</span>
    </div>
  );
}
function NoteBox({ tone, children }: { tone: 'gold' | 'terracotta' | 'teal' | 'forest'; children: React.ReactNode }) {
  const bg: Record<string, string> = { gold: 'rgba(201,154,46,.1)', terracotta: 'rgba(194,86,46,.1)', teal: 'rgba(51,137,160,.1)', forest: 'rgba(60,156,104,.1)' };
  const br: Record<string, string> = { gold: 'rgba(201,154,46,.35)', terracotta: 'rgba(194,86,46,.4)', teal: 'rgba(51,137,160,.35)', forest: 'rgba(60,156,104,.35)' };
  return <div style={{ background: bg[tone], border: `1px solid ${br[tone]}`, borderRadius: 10, padding: '9px 11px', fontSize: 11.5, lineHeight: 1.45, color: dim(.85), marginBottom: 8 }}>{children}</div>;
}

function JourneyPanel({ propertyId, j }: { propertyId: string; j: Journey }) {
  const [d, setD] = useState<PanelDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const fetchDetail = React.useCallback(async () => {
    try {
      const res = await fetchWithAuth(`/api/admin/onboarding-detail?propertyId=${propertyId}`);
      const json = await res.json();
      if (json.ok) { setD(json.data); setErr(null); }
      else setErr(json.error ?? 'Could not load detail');
    } catch (e) { setErr(`Network error: ${(e as Error).message}`); }
  }, [propertyId]);

  useRiseIn(panelRef, { dy: 6, dur: 360 });
  useEffect(() => {
    void fetchDetail();
    const t = setInterval(() => { void fetchDetail(); }, 5000);
    return () => clearInterval(t);
  }, [fetchDetail]);

  const shell: React.CSSProperties = {
    border: `1px solid ${dim(.22)}`, borderTop: 'none', borderRadius: '0 0 12px 12px',
    background: dim(.03), padding: '14px 16px 16px',
  };
  if (err) return <div ref={panelRef} style={shell}><span style={{ fontSize: 12, color: 'var(--terracotta)' }}>{err}</span></div>;
  if (!d) return <div ref={panelRef} style={shell}><span className="spinner" style={{ width: 14, height: 14, display: 'inline-block', borderTopColor: '#fff' }} /></div>;

  const grid: React.CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(230px, 1fr))', gap: 18 };

  const personCol = (
    <div>
      <PanelCaps>First person</PanelCaps>
      {d.owner ? (
        <>
          <KV k="Name" v={d.owner.name ?? '—'} />
          <KV k="Email" v={d.owner.email ?? d.property.onboardingState?.invitedEmail ?? '—'} />
          <KV k="Phone" v={d.owner.phone ?? '—'} />
        </>
      ) : (
        <>
          <KV k="Invited email" v={d.property.onboardingState?.invitedEmail ?? 'Not invited yet'} />
          <div style={{ fontSize: 11.5, color: dim(.5), fontFamily: FONT_SERIF, fontStyle: 'italic', marginTop: 6 }}>
            No account yet.
          </div>
        </>
      )}
      <KV k="Hotel created" v={`${age(d.property.createdAt)} ago`} />
    </div>
  );

  const enteredCol = (
    <div>
      <PanelCaps>Hotel details</PanelCaps>
      <KV k="Hotel" v={d.property.name ?? '—'} />
      <KV k="Rooms" v={d.property.totalRooms ?? '—'} />
      <KV k="Brand" v={d.property.brand ?? '—'} />
      <KV k="Timezone" v={d.property.timezone ?? '—'} />
    </div>
  );

  const stageCol = (
    <div>
      <PanelCaps>Current stage</PanelCaps>
      <KV k="Progress" v={`${j.step} / ${TOTAL_STEPS} · ${STEP_LABELS[j.step - 1]}`} />
      <NoteBox tone={j.step === TOTAL_STEPS ? 'forest' : 'gold'}>{j.sub}</NoteBox>
    </div>
  );

  return (
    <div ref={panelRef} style={shell}>
      <div style={grid}>{personCol}{enteredCol}{stageCol}</div>
    </div>
  );
}
function BayLiveCount({ n }: { n: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => { countUp(ref.current, 0, n, { dur: 1100, fmt: (v) => String(Math.round(v)) }); }, [n]);
  return <span ref={ref} className="serif-num" style={{ fontSize: 44, color: '#fff', margin: '4px 0' }}>0</span>;
}

function BayProspect({ p, onSaved }: { p: Prospect; onSaved: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const tone: DotTone = p.status === 'committed' ? 'forest' : p.status === 'negotiating' ? 'gold' : 'teal';
  return (
    <>
      <RowButton onClick={() => setOpen(true)}>
        <span style={{ fontSize: 12, fontWeight: 600, color: '#fff', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.hotel_name}</span>
        <span style={{ fontSize: 10, color: `var(--${tone === 'teal' ? 'teal' : tone})`, textTransform: 'capitalize' }}>{p.status}</span>
        <span className="mono" style={{ fontSize: 9.5, color: dim(.4) }}>{age(p.created_at)}</span>
      </RowButton>
      {open && <ProspectModal p={p} onClose={() => setOpen(false)} onSaved={onSaved} />}
    </>
  );
}

// ── Prospect quick-add + edit modal (preserves full CRUD) ───────────────
const PROSPECT_STATUSES: ProspectStatus[] = ['talking', 'negotiating', 'committed', 'onboarded', 'dropped'];
const CHECKLIST = [
  { key: 'pmsCredsCollected', label: 'PMS creds collected' },
  { key: 'staffListReady', label: 'Staff list ready' },
  { key: 'gmTrained', label: 'GM trained' },
  { key: 'launchDateConfirmed', label: 'Launch date confirmed' },
];

function AddProspect({ onAdded }: { onAdded: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const create = async () => {
    if (!name.trim()) return;
    setBusy(true);
    try {
      const res = await fetchWithAuth('/api/admin/prospects', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ hotelName: name.trim() }) });
      const json = await res.json();
      if (json.ok) { setName(''); setOpen(false); await onAdded(); }
    } finally { setBusy(false); }
  };
  if (!open) return <button onClick={() => setOpen(true)} className="mono" style={{ background: 'none', border: 'none', color: dim(.5), fontSize: 10, cursor: 'pointer', letterSpacing: '.08em' }}>+ ADD</button>;
  return (
    <span style={{ display: 'inline-flex', gap: 5, alignItems: 'center' }}>
      <input autoFocus value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void create(); if (e.key === 'Escape') setOpen(false); }} placeholder="Hotel name"
        style={{ width: 130, fontSize: 11, padding: '4px 8px', borderRadius: 8, border: `1px solid ${dim(.2)}`, background: dim(.08), color: '#fff', outline: 'none' }} />
      <button onClick={create} disabled={busy} className="mono" style={{ background: 'none', border: 'none', color: 'var(--forest)', fontSize: 10, cursor: 'pointer' }}>{busy ? '…' : 'SAVE'}</button>
    </span>
  );
}

function ProspectModal({ p, onClose, onSaved }: { p: Prospect; onClose: () => void; onSaved: () => Promise<void> }) {
  const ref = useRef<HTMLDivElement>(null);
  const [d, setD] = useState<Prospect>(p);
  const [saving, setSaving] = useState(false);
  useRiseIn(ref, { dy: 30, dur: 440 });
  const dirty = JSON.stringify(d) !== JSON.stringify(p);

  const save = async () => {
    setSaving(true);
    try {
      await fetchWithAuth(`/api/admin/prospects/${p.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hotelName: d.hotel_name, contactName: d.contact_name, contactEmail: d.contact_email, contactPhone: d.contact_phone, pmsType: d.pms_type, expectedLaunchDate: d.expected_launch_date, status: d.status, notes: d.notes, checklist: d.checklist }) });
      await onSaved(); onClose();
    } finally { setSaving(false); }
  };
  const remove = async () => {
    if (!confirm(`Delete "${p.hotel_name}"? Use status 'Dropped' to keep history.`)) return;
    await fetchWithAuth(`/api/admin/prospects/${p.id}`, { method: 'DELETE' });
    await onSaved(); onClose();
  };
  const inp: React.CSSProperties = { width: '100%', boxSizing: 'border-box', marginTop: 4, padding: '8px 11px', fontSize: 13, fontFamily: 'var(--sans)', border: '1px solid var(--rule)', borderRadius: 10, outline: 'none', background: '#fff', color: 'var(--ink)' };

  return (
    <Backdrop onClose={onClose}>
      <div ref={ref} onClick={(e) => e.stopPropagation()} style={{ ...MODAL_CARD, width: 460 }}>
        <Caps>Prospect</Caps>
        <input value={d.hotel_name} onChange={(e) => setD({ ...d, hotel_name: e.target.value })} style={{ ...inp, fontFamily: 'var(--serif)', fontSize: 22, fontStyle: 'italic', border: 'none', padding: '4px 0', marginTop: 2 }} />
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 10 }}>
          <label><Caps size={9}>Status</Caps>
            <select value={d.status} onChange={(e) => setD({ ...d, status: e.target.value as ProspectStatus })} style={inp}>
              {PROSPECT_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </label>
          <label><Caps size={9}>PMS</Caps><input value={d.pms_type ?? ''} onChange={(e) => setD({ ...d, pms_type: e.target.value || null })} style={inp} /></label>
          <label><Caps size={9}>Contact</Caps><input value={d.contact_name ?? ''} onChange={(e) => setD({ ...d, contact_name: e.target.value || null })} style={inp} /></label>
          <label><Caps size={9}>Phone</Caps><input value={d.contact_phone ?? ''} onChange={(e) => setD({ ...d, contact_phone: e.target.value || null })} style={inp} /></label>
          <label><Caps size={9}>Email</Caps><input value={d.contact_email ?? ''} onChange={(e) => setD({ ...d, contact_email: e.target.value || null })} style={inp} /></label>
          <label><Caps size={9}>Launch</Caps><input type="date" value={d.expected_launch_date ?? ''} onChange={(e) => setD({ ...d, expected_launch_date: e.target.value || null })} style={inp} /></label>
        </div>
        <label style={{ display: 'block', marginTop: 10 }}><Caps size={9}>Notes</Caps>
          <textarea value={d.notes ?? ''} onChange={(e) => setD({ ...d, notes: e.target.value || null })} rows={2} style={{ ...inp, resize: 'vertical' }} />
        </label>
        <div style={{ marginTop: 12 }}><Caps size={9}>Launch checklist</Caps>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, marginTop: 6 }}>
            {CHECKLIST.filter((c) => c.key !== 'pmsCredsCollected').map((c) => {
              const on = !!d.checklist?.[c.key];
              return (
                <label key={c.key} style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '7px 10px', borderRadius: 999, fontSize: 12, cursor: 'pointer', background: on ? 'var(--forest-dim)' : 'var(--rule-soft)', border: `1px solid ${on ? 'rgba(60,156,104,.3)' : 'var(--rule)'}`, color: on ? 'var(--forest-deep)' : 'var(--dim)' }}>
                  <input type="checkbox" checked={on} onChange={() => setD({ ...d, checklist: { ...d.checklist, [c.key]: !on } })} />{c.label}
                </label>
              );
            })}
          </div>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 18 }}>
          <Btn variant="ghost" size="sm" onClick={remove} style={{ color: 'var(--terracotta)', borderColor: 'rgba(194,86,46,.3)' }}>Delete</Btn>
          <div style={{ display: 'flex', gap: 8 }}>
            <Btn variant="ghost" size="sm" onClick={onClose}>Cancel</Btn>
            <Btn variant="primary" size="sm" onClick={save} disabled={!dirty || saving}>{saving ? 'Saving…' : 'Save'}</Btn>
          </div>
        </div>
      </div>
    </Backdrop>
  );
}
