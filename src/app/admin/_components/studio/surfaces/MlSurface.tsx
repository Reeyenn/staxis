'use client';

/* ───────────────────────────────────────────────────────────────────────
   SURFACE — ML · "Editorial Cockpit" (dark).

   Production port of the design-handoff finalized ML screen
   (surfaces/ml.jsx → MlEditorial, the `final: 0` iteration), wired to the
   REAL ML cockpit data the prior MlTab already fetched. Nothing is mocked.

   Data (verbatim from src/app/admin/_components/tabs/MlTab.tsx):
     • GET /api/admin/ml/housekeeping/cockpit-data[?propertyId=<uuid>]
     • GET /api/admin/ml/inventory/cockpit-data[?propertyId=<uuid>]
   Network mode → no propertyId (fleet aggregate, test hotels excluded from
   the aggregate but listed in the rail). Single mode → ?propertyId=<id>.
   Switching the HK⇄Inventory sub-tab clears the selected hotel, same as the
   prior tab.

   THE LEARNING TIMELINE (centerpiece). The milestones live at days
   0 / 14 / 45 / 90 with tones terracotta / gold / teal / forest — these are
   the finalized *visual* lifecycle markers from the design pack, kept as-is.
   The handoff README flags the day thresholds as the one approximate area to
   "retune against the real ML pipeline's actual phase boundaries / per-
   property daysSinceFirstEvent." We honor that: every day a hotel is plotted
   at — fleet dots, the single-hotel progress fill, the "you are here"
   pointer, the median marker — is the REAL `daysSinceFirstEvent` (HK) /
   `daysSinceFirstCount` (inventory) from cockpit-data, and the fleet median
   is `aggregate.fleetMedianDay`. We do NOT use the prototype's mock 5-phase
   server thresholds (0/30/60/90/120) for the *visual*; the 4-milestone
   editorial track is the chosen design and is what we render. Cold-start
   honesty is preserved — "Learning…" empty states where there's no history
   yet, no fabricated numbers.

   Dark surface via SurfaceShell glow="tealTL"; translucent-white DarkCards;
   tokens via CSS vars + the .admin-studio-scoped caps/serif-num/mono classes.
   ─────────────────────────────────────────────────────────────────────── */

import React, { useEffect, useRef, useState } from 'react';
import { fetchWithAuth } from '@/lib/api-fetch';
import { SurfaceShell, DarkCard, DarkSpinner, DarkEmpty, dimWhite } from '../surface-kit';
import { DividerRow } from '../ui-kit';
import {
  FONT_SERIF, FONT_SANS, FONT_MONO, Caps, Pill, Dot, Btn,
  countUp, sweepWidth, useRiseIn, age, ageIn, prefersReducedMotion,
  EASE_OUT, type DotTone,
} from '../kit';

// ─── Cockpit data shapes (verbatim from MlTab.tsx) ──────────────────────

type Sub = 'housekeeping' | 'inventory';
type Health = 'healthy' | 'warming' | 'issue';

interface PhaseBucket { phaseId: string; phaseLabel: string; phaseDay: number; hotelCount: number }

interface InventoryProperty {
  id: string; name: string; brand: string | null;
  daysSinceFirstCount: number; itemsTotal: number; itemsGraduated: number;
  status: Health;
  lastTrainingAt: string | null; lastPredictionAt: string | null;
  countsLast7d: number; countsLast1h: number;
  joinedAt: string | null; isTest: boolean;
}
interface InventoryCockpitData {
  mode: 'network' | 'single';
  selectedProperty: { id: string; name: string } | null;
  properties: InventoryProperty[];
  aggregate: {
    hotelCount: number; totalCounts: number; totalCountsLast7d: number;
    totalCountsLast24h: number; totalCountsLast1h: number;
    totalItems: number; totalItemsGraduated: number;
    totalItemsLearning: number; fleetMedianDay: number;
    daysOfHistoryRange: { min: number; max: number };
    healthCounts: { healthy: number; warming: number; issue: number };
    daysToNextMilestoneMedian: number | null;
    nextMilestoneLabel: string;
    phaseHistogram: PhaseBucket[];
    dailyCountSeries: Array<{ date: string; recorded: number }>;
    lastTrainingRunAt: string | null; lastInferenceWriteAt: string | null;
    lastAnomalyFiredAt: string | null;
    predictionsLast24h: number; activeItemModelCount: number;
    nextTrainingAt: string; nextPredictionAt: string;
  };
  recentAnomalies: Array<{
    id: string; itemId: string | null; itemName: string;
    reason: string; severity: 'info' | 'warn' | 'critical';
    ts: string; propertyId: string; propertyName: string;
  }>;
  topCounters: Array<{
    countedBy: string; countCount: number; itemsTouched: number;
    lastCountedAt: string | null; propertyId: string; propertyName: string;
  }>;
}

interface HKProperty {
  id: string; name: string; brand: string | null;
  daysSinceFirstEvent: number; staffActive: number; modelsActive: number;
  status: Health;
  lastTrainingAt: string | null; lastInferenceAt: string | null;
  eventsLast7d: number; eventsLast1h: number;
  joinedAt: string | null; isTest: boolean;
  lastAutoRollbackAt: string | null;
}
interface HKCockpitData {
  mode: 'network' | 'single';
  selectedProperty: { id: string; name: string } | null;
  properties: HKProperty[];
  aggregate: {
    hotelCount: number; totalEvents: number; totalEventsLast7d: number;
    totalEventsLast24h: number; totalEventsLast1h: number; totalDiscardedEvents: number;
    distinctStaff: number; distinctRooms: number;
    fleetMedianDay: number; daysOfHistoryRange: { min: number; max: number };
    healthCounts: { healthy: number; warming: number; issue: number };
    warmingUpCount: number; capacityUnavailableCount: number;
    xgboostDeferredCount: number; fullyFittedCount: number;
    lastAutoRollbackAt: string | null;
    autoRollbacksLast7d: number; dryRunRollbacksLast7d: number;
    daysToNextMilestoneMedian: number | null;
    nextMilestoneLabel: string;
    phaseHistogram: PhaseBucket[];
    dailyEventSeries: Array<{ date: string; recorded: number; discarded: number }>;
    lastTrainingRunAt: string | null; lastInferenceWriteAt: string | null;
    lastOverrideAt: string | null;
    predictionsLast24h: number; activeModelRunCount: number;
    optimizerActive: boolean;
    nextTrainingAt: string; nextPredictionAt: string;
  };
  recentOverrides: Array<{
    id: string; date: string; optimizerRecommendation: number; manualHeadcount: number;
    overrideReason: string | null; propertyId: string; propertyName: string;
  }>;
  topAdoption: Array<{
    staffId: string; staffName: string; roomsAssigned: number; roomsWithEvent: number;
    adoptionPct: number; propertyId: string; propertyName: string;
  }>;
}

// ─── Lifecycle milestones (finalized design — days 0/14/45/90) ──────────
//  The editorial track from ml.jsx. Day values plotted on it are the REAL
//  per-property daysSinceFirstEvent / daysSinceFirstCount; these thresholds
//  define the visual phase boundaries the design locked in.

type ToneKey = 'terracotta' | 'gold' | 'teal' | 'forest';
interface Milestone { day: number; label: string; tone: ToneKey }

const MILESTONES: Record<Sub, Milestone[]> = {
  housekeeping: [
    { day: 0,  label: 'First clean', tone: 'terracotta' },
    { day: 14, label: 'Heuristic',   tone: 'gold' },
    { day: 45, label: 'Blended',     tone: 'teal' },
    { day: 90, label: 'Graduated',   tone: 'forest' },
  ],
  inventory: [
    { day: 0,  label: 'First count',   tone: 'terracotta' },
    { day: 14, label: 'Par learned',   tone: 'gold' },
    { day: 45, label: 'Blended',       tone: 'teal' },
    { day: 90, label: 'Anomaly-ready', tone: 'forest' },
  ],
};
const MAXDAY = 100;
const xOf = (d: number) => (Math.max(0, Math.min(MAXDAY, d)) / MAXDAY) * 100;
const TONE_HEX: Record<ToneKey, string> = { terracotta: '#C2562E', gold: '#C99A2E', teal: '#3389A0', forest: '#3C9C68' };
const HS: Record<Health, DotTone> = { healthy: 'forest', warming: 'gold', issue: 'terracotta' };

function phaseIndexFor(day: number, sub: Sub): number {
  const ms = MILESTONES[sub];
  let idx = 0;
  for (let i = 0; i < ms.length; i++) if (day >= ms[i].day) idx = i;
  return idx;
}

// Centered dark spinner block — the cockpit's loading placeholder.
function Loading() {
  return <div style={{ padding: '70px 0', textAlign: 'center' }}><DarkSpinner /></div>;
}
// Shown when a single-hotel scope points at a property that isn't in the set.
function NotFound() {
  return <DarkCard><span style={{ color: dimWhite(.6), fontSize: 13 }}>Selected hotel not found.</span></DarkCard>;
}

// ─── Surface root ────────────────────────────────────────────────────────

export function MlSurface() {
  const [sub, setSub] = useState<Sub>('housekeeping');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hk, setHk] = useState<HKCockpitData | null>(null);
  const [inv, setInv] = useState<InventoryCockpitData | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  // Fetch — verbatim logic from MlTab.tsx (same endpoints, same propertyId
  // param, same sub-tab toggle), via the production fetchWithAuth wrapper
  // that handles token refresh / 401 recovery.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoading(true);
      setErr(null);
      try {
        const base = sub === 'inventory'
          ? '/api/admin/ml/inventory/cockpit-data'
          : '/api/admin/ml/housekeeping/cockpit-data';
        const url = selectedId ? `${base}?propertyId=${selectedId}` : base;
        const res = await fetchWithAuth(url);
        const json = await res.json();
        if (!res.ok || !json.ok) throw new Error(json.error || `HTTP ${res.status}`);
        if (!cancelled) {
          if (sub === 'inventory') setInv(json.data);
          else setHk(json.data);
        }
      } catch (e) {
        if (!cancelled) setErr((e as Error).message ?? 'failed');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [sub, selectedId]);

  const cockpit = sub === 'inventory' ? inv : hk;
  const properties: RailProperty[] = cockpit ? cockpit.properties.map(toRailProp) : [];
  const hotelCount = cockpit?.aggregate.hotelCount;
  const healthCounts = cockpit?.aggregate.healthCounts;

  const selected = selectedId && cockpit
    ? cockpit.properties.find((p) => p.id === selectedId) ?? null
    : null;
  const selDay = selected
    ? ('daysSinceFirstEvent' in selected ? selected.daysSinceFirstEvent : selected.daysSinceFirstCount)
    : 0;

  return (
    <SurfaceShell glow="tealTL">
      <Masthead
        sub={sub}
        onSub={(s) => { setSub(s); setSelectedId(null); }}
        selected={selected ? { name: selected.name, brand: selected.brand, status: selected.status, day: selDay } : null}
        onClearSelected={() => setSelectedId(null)}
        hotelCount={hotelCount}
        healthCounts={healthCounts}
      />

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 290px', gap: 26, alignItems: 'start' }}>
        {/* keyed on sub+scope so the column re-mounts and re-animates on change */}
        <div key={`${sub}-${selectedId ?? 'fleet'}`} style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 }}>
          {loading && !hk && !inv ? (
            <Loading />
          ) : err ? (
            <DarkCard style={{ borderColor: 'rgba(194,86,46,.35)' }}>
              <span style={{ color: 'var(--terracotta)', fontSize: 13 }}>Failed to load cockpit: {err}</span>
            </DarkCard>
          ) : sub === 'inventory' && inv ? (
            <InventoryPanels cockpit={inv} onSelect={setSelectedId} />
          ) : sub === 'housekeeping' && hk ? (
            <HousekeepingPanels cockpit={hk} onSelect={setSelectedId} />
          ) : (
            <Loading />
          )}
        </div>

        <HotelRail
          sub={sub}
          properties={properties}
          selectedId={selectedId}
          onSelect={setSelectedId}
        />
      </div>
    </SurfaceShell>
  );
}

// ─── Masthead ───────────────────────────────────────────────────────────

function Masthead({
  sub, onSub, selected, onClearSelected, hotelCount, healthCounts,
}: {
  sub: Sub;
  onSub: (s: Sub) => void;
  selected: { name: string; brand: string | null; status: Health; day: number } | null;
  onClearSelected: () => void;
  hotelCount: number | undefined;
  healthCounts: { healthy: number; warming: number; issue: number } | undefined;
}) {
  return (
    <div style={{ paddingBottom: 16, borderBottom: `1px solid ${dimWhite(.12)}`, marginBottom: 22 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap' }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <Caps c={dimWhite(.55)}>Machine learning · Cockpit</Caps>
          <h1 style={{
            fontFamily: FONT_SERIF, fontSize: 'clamp(28px,4vw,42px)', fontStyle: 'italic',
            fontWeight: 400, letterSpacing: '-0.035em', lineHeight: 1.05,
            margin: '10px 0 0', maxWidth: 720, color: '#fff',
          }}>
            {selected ? (
              <>{selected.name}<span style={{ color: dimWhite(.45) }}>, alone.</span></>
            ) : (
              <>{hotelCount ?? '—'} hotels, <span style={{ fontStyle: 'italic' }}>learning every hour.</span></>
            )}
          </h1>
        </div>
        <div style={{ flexShrink: 0, paddingTop: 4 }}>
          {selected ? (
            <Btn size="sm" variant="ghost" onClick={onClearSelected} style={{ color: '#fff', borderColor: dimWhite(.25), background: dimWhite(.06) }}>
              <Dot tone={HS[selected.status]} size={7} /> {selected.brand ?? '—'} · D{selected.day} ✕
            </Btn>
          ) : healthCounts ? (
            <div style={{ textAlign: 'right' }}>
              <Caps c={dimWhite(.5)}>Network health</Caps>
              <div style={{ marginTop: 6 }}><HealthCounts counts={healthCounts} /></div>
            </div>
          ) : null}
        </div>
      </div>
      <div style={{ marginTop: 16 }}><SubTabs sub={sub} onSub={onSub} /></div>
    </div>
  );
}

function HealthCounts({ counts }: { counts: { healthy: number; warming: number; issue: number } }) {
  const items: Array<[Health, number]> = [['healthy', counts.healthy], ['warming', counts.warming], ['issue', counts.issue]];
  return (
    <div style={{ display: 'flex', gap: 14, fontFamily: FONT_MONO, fontSize: 10.5, letterSpacing: '.06em' }}>
      {items.map(([k, n]) => (
        <span key={k} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, color: dimWhite(.7) }}>
          <Dot tone={HS[k]} size={7} />{n} {k.toUpperCase()}
        </span>
      ))}
    </div>
  );
}

function SubTabs({ sub, onSub }: { sub: Sub; onSub: (s: Sub) => void }) {
  const items: Array<[Sub, string]> = [['housekeeping', 'Housekeeping'], ['inventory', 'Inventory']];
  return (
    <div style={{ display: 'inline-flex', gap: 18, alignItems: 'baseline' }}>
      {items.map(([k, l], i) => {
        const active = sub === k;
        return (
          <React.Fragment key={k}>
            <button
              onClick={() => onSub(k)}
              style={{
                background: 'none', border: 'none', padding: '0 0 4px', cursor: 'pointer',
                fontFamily: FONT_SERIF, fontStyle: 'italic', fontSize: 21,
                color: active ? '#fff' : dimWhite(.4),
                borderBottom: `1.5px solid ${active ? '#fff' : 'transparent'}`,
                transition: 'color .12s, border-color .12s',
              }}
            >{l}</button>
            {i === 0 && <span style={{ color: dimWhite(.3), fontFamily: FONT_SERIF }}>·</span>}
          </React.Fragment>
        );
      })}
    </div>
  );
}

// ─── Right rail ─────────────────────────────────────────────────────────

interface RailProperty {
  id: string; name: string; brand: string | null; status: Health; isTest: boolean;
  v7: number; day: number;
}
function toRailProp(p: HKProperty | InventoryProperty): RailProperty {
  const isInv = 'daysSinceFirstCount' in p;
  return {
    id: p.id, name: p.name, brand: p.brand, status: p.status, isTest: p.isTest,
    v7: isInv ? (p as InventoryProperty).countsLast7d : (p as HKProperty).eventsLast7d,
    day: isInv ? (p as InventoryProperty).daysSinceFirstCount : (p as HKProperty).daysSinceFirstEvent,
  };
}

function HotelRail({
  sub, properties, selectedId, onSelect,
}: {
  sub: Sub;
  properties: RailProperty[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}) {
  const unit = sub === 'inventory' ? 'counts' : 'cleans';
  return (
    <div style={{
      background: dimWhite(.04), border: `1px solid ${dimWhite(.12)}`, borderRadius: 14,
      padding: '16px 6px 14px', position: 'sticky', top: 24,
      maxHeight: 'calc(100vh - 48px)', overflowY: 'auto', alignSelf: 'flex-start',
      fontFamily: FONT_SANS,
    }}>
      <div style={{ padding: '0 14px 10px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <Caps c={dimWhite(.55)}>Hotels · {properties.length}</Caps>
        <span className="mono" style={{ fontSize: 9, color: dimWhite(.4), letterSpacing: '.06em' }}>{selectedId ? 'SINGLE' : 'FLEET'}</span>
      </div>

      <RailRow
        active={!selectedId}
        onClick={() => onSelect(null)}
        title="All hotels"
        subtitle={`Fleet · ${properties.length} ${properties.length === 1 ? 'hotel' : 'hotels'}`}
        status={null}
        meta={null}
      />

      <div style={{ height: 1, background: dimWhite(.12), margin: '8px 14px' }} />

      {properties.length === 0 ? (
        <div style={{ padding: '6px 12px 0' }}><DarkEmpty text="No hotels yet." /></div>
      ) : properties.map((p) => (
        <RailRow
          key={p.id}
          active={selectedId === p.id}
          onClick={() => onSelect(p.id)}
          title={p.name}
          subtitle={`${p.brand || 'Unbranded'}${p.isTest ? ' · test' : ''}`}
          status={p.status}
          meta={`${p.v7.toLocaleString()} ${unit}/7d · D${p.day}`}
          dim={p.isTest}
        />
      ))}
    </div>
  );
}

function RailRow({
  active, onClick, title, subtitle, status, meta, dim,
}: {
  active: boolean; onClick: () => void; title: string; subtitle: string;
  status: Health | null; meta: string | null; dim?: boolean;
}) {
  const aBg = 'rgba(60,156,104,.18)';
  return (
    <button
      onClick={onClick}
      style={{
        display: 'block', width: 'calc(100% - 12px)', textAlign: 'left',
        margin: '1px 6px', padding: '9px 13px', borderRadius: 9, border: 'none', cursor: 'pointer',
        background: active ? aBg : 'transparent',
        borderLeft: `2px solid ${active ? 'var(--forest)' : 'transparent'}`,
        opacity: dim ? 0.6 : 1, transition: 'background .12s',
      }}
      onMouseEnter={(e) => { if (!active) e.currentTarget.style.background = dimWhite(.05); }}
      onMouseLeave={(e) => { if (!active) e.currentTarget.style.background = 'transparent'; }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{
            fontFamily: FONT_SERIF, fontStyle: 'italic', fontSize: 14,
            color: active ? 'var(--forest)' : '#fff',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>{title}</div>
          <div style={{ fontSize: 10.5, color: dimWhite(.55), marginTop: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{subtitle}</div>
          {meta && <div className="mono" style={{ fontSize: 9, color: dimWhite(.4), marginTop: 3 }}>{meta}</div>}
        </div>
        {status && <Dot tone={HS[status]} size={8} style={{ marginTop: 4 }} />}
      </div>
    </button>
  );
}

// ─── Generic dark card with editorial header ────────────────────────────

function Card({ children, title, caps, right, riseDelay }: {
  children: React.ReactNode; title: string; caps: string; right?: React.ReactNode; riseDelay?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useRiseIn(ref, { dy: 12, delay: riseDelay ?? 0, dur: 460 }, [riseDelay]);
  return (
    <div ref={ref} style={{ background: dimWhite(.06), border: `1px solid ${dimWhite(.14)}`, borderRadius: 16, padding: '16px 18px' }}>
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 10, marginBottom: 12 }}>
        <div>
          <Caps c={dimWhite(.5)}>{caps}</Caps>
          <h3 style={{ fontFamily: FONT_SERIF, fontSize: 19, fontWeight: 400, fontStyle: 'italic', letterSpacing: '-0.02em', margin: '2px 0 0', color: '#fff' }}>{title}</h3>
        </div>
        {right}
      </div>
      {children}
    </div>
  );
}

// ─── Panel 1 — Learning timeline (centerpiece) ──────────────────────────

function TimelinePanel({
  sub, mode, day, last1h, nextMilestoneLabel, daysToNextMilestone,
  properties, onSelect, extraPill,
}: {
  sub: Sub;
  mode: 'fleet' | 'single';
  day: number;
  last1h: number;
  nextMilestoneLabel: string;
  daysToNextMilestone: number | null;
  properties: RailProperty[];
  onSelect: (id: string) => void;
  extraPill?: React.ReactNode;
}) {
  const ms = MILESTONES[sub];
  const curIdx = phaseIndexFor(day, sub);
  const nextMs = ms[curIdx + 1];
  // Prefer the real per-property/aggregate "days to next milestone" + label
  // from cockpit-data; fall back to the visual track's own next milestone.
  const dToNext = daysToNextMilestone != null ? daysToNextMilestone : (nextMs ? Math.max(0, nextMs.day - day) : null);
  const nextLabel = nextMilestoneLabel || (nextMs ? nextMs.label : 'Mature');
  const unit = sub === 'inventory' ? 'counts' : 'cleans';

  return (
    <Card
      title={mode === 'single' ? 'Learning timeline' : 'Fleet learning timeline'}
      caps="Timeline"
      right={<Pill tone="forest">{last1h} {unit}/1h</Pill>}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 18, flexWrap: 'wrap' }}>
        <BigDay day={day} />
        <span style={{ fontFamily: FONT_SERIF, fontStyle: 'italic', fontSize: 15, color: dimWhite(.6) }}>
          {mode === 'single' ? `in the ${ms[curIdx].label} phase` : 'fleet median'}
        </span>
        {dToNext != null && dToNext > 0
          ? <span className="mono" style={{ marginLeft: 'auto', fontSize: 10.5, color: 'var(--gold-deep)' }}>{dToNext}d → {nextLabel}</span>
          : <span className="mono" style={{ marginLeft: 'auto', fontSize: 10.5, color: 'var(--forest-deep)' }}>fully graduated ✓</span>}
      </div>

      <LearningTimeline sub={sub} mode={mode} day={day} properties={properties} onSelect={onSelect} />

      {extraPill && <div style={{ marginTop: 14 }}>{extraPill}</div>}
    </Card>
  );
}

function BigDay({ day }: { day: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => { countUp(ref.current, 0, day, { dur: 900, fmt: (v) => `D${Math.round(v)}` }); }, [day]);
  return <span ref={ref} className="serif-num" style={{ fontSize: 38, color: '#fff' }}>D{day}</span>;
}

function LearningTimeline({
  sub, mode, day, properties, onSelect,
}: {
  sub: Sub; mode: 'fleet' | 'single'; day: number; properties: RailProperty[]; onSelect: (id: string) => void;
}) {
  const ms = MILESTONES[sub];
  const single = mode === 'single';
  const fillRef = useRef<HTMLDivElement>(null);

  // band segments between milestones (+ graduated tail to MAXDAY)
  const segs = ms.map((m, i) => ({ from: m.day, to: i < ms.length - 1 ? ms[i + 1].day : MAXDAY, tone: m.tone }));

  useEffect(() => {
    const el = fillRef.current;
    if (!single || !el) return;
    const w = xOf(day);
    el.style.width = w + '%';
    if (prefersReducedMotion() || typeof el.animate !== 'function') return;
    el.animate([{ width: '0%' }, { width: w + '%' }], { duration: 900, easing: EASE_OUT, fill: 'both' });
  }, [day, single, sub]);

  const rowH = 16;
  // fleet: plot each NON-TEST hotel as a dot at its real current day, with a
  // 3-row jitter to reduce overlap (the fleet aggregate + median exclude test
  // hotels, so we plot the same set to stay consistent with the median).
  const fleetProps = !single ? properties.filter((p) => !p.isTest) : [];
  const fleetDots = !single
    ? [...fleetProps].sort((a, b) => a.day - b.day).map((p, i) => ({ p, x: xOf(p.day), row: i % 3 }))
    : [];
  const axisCol = dimWhite(.45);

  return (
    <div style={{ paddingTop: 22 }}>
      {/* milestone labels above (vertically staggered so adjacent ones never collide) */}
      <div style={{ position: 'relative', height: 30, marginBottom: 4 }}>
        {ms.map((m, i) => (
          <div key={m.day} style={{
            position: 'absolute', left: xOf(m.day) + '%', top: (i % 2) * 14,
            transform: i === 0 ? 'translateX(0)' : i === ms.length - 1 ? 'translateX(-100%)' : 'translateX(-50%)',
            whiteSpace: 'nowrap',
          }}>
            <span style={{ fontSize: 11, fontWeight: 700, color: TONE_HEX[m.tone] }}>{m.label}</span>
          </div>
        ))}
      </div>

      {/* the track */}
      <div style={{ position: 'relative', height: 12, borderRadius: 6, background: dimWhite(.08), overflow: 'visible' }}>
        {/* phase bands */}
        <div style={{ position: 'absolute', inset: 0, borderRadius: 6, overflow: 'hidden', display: 'flex' }}>
          {segs.map((s, i) => (
            <div key={i} style={{
              width: (xOf(s.to) - xOf(s.from)) + '%', height: '100%',
              background: TONE_HEX[s.tone] + '33',
              borderRight: i < segs.length - 1 ? '1px solid rgba(0,0,0,.3)' : 'none',
            }} />
          ))}
        </div>
        {/* single-hotel progress fill */}
        {single && (
          <div ref={fillRef} style={{
            position: 'absolute', left: 0, top: 0, bottom: 0, width: 0, borderRadius: 6,
            background: `linear-gradient(90deg, ${TONE_HEX.terracotta}, ${TONE_HEX.gold} 30%, ${TONE_HEX.teal} 60%, ${TONE_HEX.forest})`,
            opacity: 0.95,
          }} />
        )}
        {/* milestone ticks */}
        {ms.map((m) => {
          const reached = single ? day >= m.day : true;
          return (
            <div key={m.day} style={{
              position: 'absolute', left: xOf(m.day) + '%', top: -3, bottom: -3, width: 2,
              transform: 'translateX(-1px)',
              background: single && !reached ? dimWhite(.3) : TONE_HEX[m.tone],
            }} />
          );
        })}
        {/* single-hotel "you are here" pointer */}
        {single && (
          <div style={{ position: 'absolute', left: xOf(day) + '%', top: -7, transform: 'translateX(-50%)', zIndex: 3 }}>
            <div style={{
              width: 16, height: 16, borderRadius: '50%', background: '#fff',
              border: `3px solid ${TONE_HEX[ms[phaseIndexFor(day, sub)].tone]}`,
              boxShadow: '0 0 10px rgba(0,0,0,.5)',
            }} />
          </div>
        )}
      </div>

      {/* day axis numbers */}
      <div style={{ position: 'relative', height: 14, marginTop: 5 }}>
        {ms.map((m, i) => (
          <span key={m.day} className="mono" style={{
            position: 'absolute', left: xOf(m.day) + '%',
            transform: i === 0 ? 'translateX(0)' : i === ms.length - 1 ? 'translateX(-100%)' : 'translateX(-50%)',
            fontSize: 9, color: axisCol,
          }}>day {m.day}</span>
        ))}
      </div>

      {single ? (
        /* single hotel: SAME horizontal legend as fleet, current phase highlighted */
        <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginTop: 16 }}>
          {ms.map((m, i) => {
            const isCurrent = phaseIndexFor(day, sub) === i;
            const reached = day >= m.day;
            return (
              <span key={m.day} style={{
                display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11,
                color: isCurrent ? '#fff' : dimWhite(.55), opacity: reached ? 1 : 0.5,
              }}>
                <span style={{ width: 9, height: 9, borderRadius: '50%', background: TONE_HEX[m.tone] }} />
                <span style={{ fontWeight: isCurrent ? 700 : 400 }}>{m.label}</span>
                {isCurrent && <Pill tone={m.tone} style={{ fontSize: 8.5, padding: '1px 6px' }}>NOW · D{day}</Pill>}
              </span>
            );
          })}
        </div>
      ) : (
        /* fleet: each hotel plotted on the same axis + per-phase counts */
        <div style={{ marginTop: 10 }}>
          {fleetDots.length === 0 ? (
            <div style={{ paddingTop: 6 }}>
              <DarkEmpty text="No hotels recording yet — the fleet is still learning." />
            </div>
          ) : (
            <div style={{ position: 'relative', height: rowH * 3 + 6 }}>
              {fleetDots.map(({ p, x, row }) => (
                <button
                  key={p.id}
                  onClick={() => onSelect(p.id)}
                  title={`${p.name} · D${p.day} · ${ms[phaseIndexFor(p.day, sub)].label}`}
                  style={{
                    position: 'absolute', left: x + '%', top: row * rowH, transform: 'translateX(-50%)',
                    width: 11, height: 11, borderRadius: '50%', padding: 0, cursor: 'pointer',
                    background: TONE_HEX[ms[phaseIndexFor(p.day, sub)].tone],
                    border: '1.5px solid rgba(0,0,0,.4)', boxShadow: `0 0 0 1px ${dimWhite(.15)}`,
                  }}
                />
              ))}
              {/* median marker — real aggregate.fleetMedianDay */}
              <div style={{ position: 'absolute', left: xOf(day) + '%', top: -2, bottom: 0, width: 1, borderLeft: `1px dashed ${dimWhite(.4)}`, transform: 'translateX(-50%)' }}>
                <span className="mono" style={{ position: 'absolute', top: -2, left: 4, fontSize: 8.5, color: axisCol, whiteSpace: 'nowrap' }}>median D{day}</span>
              </div>
            </div>
          )}
          <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginTop: 8 }}>
            {ms.map((m, i) => {
              const count = fleetProps.filter((p) => phaseIndexFor(p.day, sub) === i).length;
              return (
                <span key={m.day} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11, color: dimWhite(.7) }}>
                  <span style={{ width: 9, height: 9, borderRadius: '50%', background: TONE_HEX[m.tone] }} />
                  {m.label} <b style={{ color: '#fff' }}>{count}</b>
                </span>
              );
            })}
            {fleetDots.length > 0 && (
              <span className="mono" style={{ fontSize: 9.5, color: axisCol, marginLeft: 'auto' }}>tap a dot to drill in →</span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Panel 2 — Data fuel gauge ──────────────────────────────────────────

function FuelGauge({
  total, bigLabel, last7, last1h, actorLabel, actorN, series, unit,
}: {
  total: number; bigLabel: string; last7: number; last1h: number;
  actorLabel: string; actorN: number;
  series: Array<{ date: string; recorded: number }>; unit: string;
}) {
  const numRef = useRef<HTMLSpanElement>(null);
  useEffect(() => { countUp(numRef.current, 0, total, { dur: 1000 }); }, [total]);
  const max = Math.max(1, ...series.map((d) => d.recorded));
  return (
    <Card title="Data fuel gauge" caps="Fuel" riseDelay={60}>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 16, flexWrap: 'wrap' }}>
        <div>
          <span ref={numRef} className="serif-num" style={{ fontSize: 42, color: '#fff' }}>{total.toLocaleString()}</span>
          <div className="mono" style={{ fontSize: 10, color: dimWhite(.5), marginTop: 2 }}>{bigLabel.toUpperCase()}</div>
        </div>
        <div style={{ display: 'flex', gap: 16, paddingBottom: 4 }}>
          <Mini label="7d" v={last7.toLocaleString()} />
          <Mini label="1h" v={last1h.toLocaleString()} c="var(--forest)" />
          <Mini label={actorLabel} v={actorN.toLocaleString()} />
        </div>
      </div>
      <SparkBars series={series} max={max} />
      <div className="mono" style={{ fontSize: 9, color: dimWhite(.4), marginTop: 5 }}>LAST 30 DAYS · {unit.toUpperCase()}/DAY</div>
    </Card>
  );
}

function Mini({ label, v, c }: { label: string; v: string; c?: string }) {
  return (
    <div>
      <div className="mono" style={{ fontSize: 9, color: dimWhite(.45), letterSpacing: '.08em' }}>{label.toUpperCase()}</div>
      <div className="mono" style={{ fontSize: 15, fontWeight: 700, color: c ?? '#fff', marginTop: 2 }}>{v}</div>
    </div>
  );
}

// 30-day daily-volume spark — each bar sweeps up to its real height. The
// resting height is set inline so it's correct under reduced motion.
function SparkBars({ series, max }: { series: Array<{ date: string; recorded: number }>; max: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const root = ref.current;
    if (!root || prefersReducedMotion()) return;
    Array.from(root.children).forEach((c, i) => {
      const el = c as HTMLElement;
      const h = el.style.height;
      if (typeof el.animate === 'function') el.animate([{ height: '0%' }, { height: h }], { duration: 600, delay: i * 12, easing: EASE_OUT, fill: 'both' });
    });
  }, [series]);
  if (series.length === 0) {
    return <div style={{ height: 44, marginTop: 14, display: 'flex', alignItems: 'center' }}><DarkEmpty text="No daily volume yet." /></div>;
  }
  return (
    <div ref={ref} style={{ display: 'flex', alignItems: 'flex-end', gap: 2, height: 44, marginTop: 14 }}>
      {series.map((d, i) => (
        <div key={i} title={`${d.date}: ${d.recorded}`} style={{
          flex: 1, height: `${Math.max(6, (d.recorded / max) * 100)}%`,
          background: i === series.length - 1 ? 'var(--forest)' : dimWhite(.22),
          borderRadius: 2,
        }} />
      ))}
    </div>
  );
}

// ─── Panel 3 — System / Pipeline health ─────────────────────────────────

function HealthPanel({
  sub, rows, pills,
}: {
  sub: Sub;
  rows: Array<[string, string, ToneKey | null]>;
  pills: React.ReactNode;
}) {
  return (
    <Card title={sub === 'inventory' ? 'Pipeline health' : 'System health'} caps="Health" riseDelay={120}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '9px 18px' }}>
        {rows.map(([l, v, t]) => (
          <div key={l} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, borderBottom: `1px solid ${dimWhite(.08)}`, paddingBottom: 7 }}>
            <span style={{ fontSize: 11.5, color: dimWhite(.7) }}>{l}</span>
            <span className="mono" style={{ fontSize: 11.5, fontWeight: 600, color: t ? `var(--${t}-deep)` : '#fff' }}>{v}</span>
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>{pills}</div>
    </Card>
  );
}

// ─── Panel 4 — Overrides (HK) / Anomalies (inventory) ───────────────────

function OverridesTable({ rows }: { rows: HKCockpitData['recentOverrides'] }) {
  return (
    <Card title="Optimizer overrides" caps="Overrides" riseDelay={180}>
      {rows.length === 0 ? (
        <DarkEmpty text="No manager overrides yet — the optimizer is running unchallenged." />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          {rows.map((o) => (
            <DividerRow key={o.id}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12.5, fontWeight: 600, color: '#fff' }}>{o.propertyName}</div>
                <div style={{ fontSize: 11, color: dimWhite(.55) }}>{o.overrideReason || 'No reason given'} · {o.date}</div>
              </div>
              <span className="mono" style={{ fontSize: 11, color: dimWhite(.6) }}>
                {o.optimizerRecommendation}→
                <b style={{ color: o.manualHeadcount > o.optimizerRecommendation ? 'var(--terracotta)' : 'var(--forest-deep)' }}>{o.manualHeadcount}</b>
              </span>
            </DividerRow>
          ))}
        </div>
      )}
    </Card>
  );
}

function AnomaliesTable({ rows }: { rows: InventoryCockpitData['recentAnomalies'] }) {
  return (
    <Card title="Recent anomalies" caps="Anomalies" riseDelay={180}>
      {rows.length === 0 ? (
        <DarkEmpty text="No anomalies flagged — consumption is within the learned bands." />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          {rows.map((a) => (
            <DividerRow key={a.id}>
              <Dot tone={a.severity === 'critical' ? 'terracotta' : a.severity === 'warn' ? 'gold' : 'teal'} size={7} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12.5, fontWeight: 600, color: '#fff' }}>{a.itemName}</div>
                <div style={{ fontSize: 11, color: dimWhite(.55) }}>{a.reason} · {a.propertyName}</div>
              </div>
              <span className="mono" style={{ fontSize: 10, color: dimWhite(.4) }}>{age(a.ts)} ago</span>
            </DividerRow>
          ))}
        </div>
      )}
    </Card>
  );
}

// ─── Panel 5 — Adoption ─────────────────────────────────────────────────

interface AdoptRow { name: string; pct: number; meta: string }

function AdoptionPanel({ title, rows }: { title: string; rows: AdoptRow[] }) {
  return (
    <Card title={title} caps="Adoption" riseDelay={240}>
      {rows.length === 0 ? (
        <DarkEmpty text="No staff activity yet." />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
          {rows.map((r) => <AdoptBar key={r.name} r={r} />)}
        </div>
      )}
    </Card>
  );
}

function AdoptBar({ r }: { r: AdoptRow }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { sweepWidth(ref.current, r.pct, { dur: 760 }); }, [r.pct]);
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
        <span style={{ fontSize: 12, color: '#fff', fontWeight: 600 }}>{r.name}</span>
        <span className="mono" style={{ fontSize: 10.5, color: dimWhite(.55) }}>{r.meta}</span>
      </div>
      <div style={{ height: 6, background: dimWhite(.1), borderRadius: 3, overflow: 'hidden' }}>
        <div ref={ref} style={{ height: '100%', width: 0, background: r.pct >= 80 ? 'var(--forest)' : r.pct >= 50 ? 'var(--gold)' : 'var(--terracotta)' }} />
      </div>
    </div>
  );
}

// ─── Panel group — Housekeeping ─────────────────────────────────────────

function HousekeepingPanels({ cockpit, onSelect }: { cockpit: HKCockpitData; onSelect: (id: string) => void }) {
  const { mode, selectedProperty, aggregate, recentOverrides, topAdoption, properties } = cockpit;
  const rail = properties.map(toRailProp);

  const single = mode === 'single';
  const me = single && selectedProperty ? properties.find((p) => p.id === selectedProperty.id) ?? null : null;
  if (single && (!selectedProperty || !me)) {
    return <NotFound />;
  }

  const day = me ? me.daysSinceFirstEvent : aggregate.fleetMedianDay;
  const last1h = me ? me.eventsLast1h : aggregate.totalEventsLast1h;

  // Single-hotel total events ≈ per-7d run-rate × weeks of history (the
  // cockpit aggregate is fleet-wide; this is the honest single-hotel
  // approximation the prototype used and the only single-scope total we have).
  const total = me
    ? me.eventsLast7d * Math.max(1, Math.round(me.daysSinceFirstEvent / 7))
    : aggregate.totalEvents;

  const healthRows: Array<[string, string, ToneKey | null]> = [
    ['Last training', age(aggregate.lastTrainingRunAt) + ' ago', 'forest'],
    ['Last inference write', age(aggregate.lastInferenceWriteAt) + ' ago', 'forest'],
    ['Predictions · 24h', aggregate.predictionsLast24h.toLocaleString(), null],
    ['Active model runs', String(aggregate.activeModelRunCount), null],
    ['Next training', 'in ' + ageIn(aggregate.nextTrainingAt), 'teal'],
    ['Next prediction', 'in ' + ageIn(aggregate.nextPredictionAt), 'teal'],
  ];
  const healthPills = (
    <>
      <Pill tone="forest">{aggregate.fullyFittedCount} fully fitted</Pill>
      <Pill tone="gold">{aggregate.warmingUpCount} warming</Pill>
      <Pill tone="teal">{aggregate.xgboostDeferredCount} XGB deferred</Pill>
      <Pill tone="neutral">{aggregate.autoRollbacksLast7d} rollbacks · 7d</Pill>
    </>
  );

  const adoptRows: AdoptRow[] = topAdoption.map((a) => ({
    name: a.staffName,
    pct: a.adoptionPct,
    meta: `${a.roomsWithEvent}/${a.roomsAssigned} rooms`,
  }));

  return (
    <>
      <TimelinePanel
        sub="housekeeping"
        mode={single ? 'single' : 'fleet'}
        day={day}
        last1h={last1h}
        nextMilestoneLabel={aggregate.nextMilestoneLabel}
        daysToNextMilestone={aggregate.daysToNextMilestoneMedian}
        properties={rail}
        onSelect={onSelect}
        extraPill={<Pill tone={aggregate.optimizerActive ? 'forest' : 'neutral'}>{aggregate.optimizerActive ? '● Optimizer active' : '○ Optimizer idle'}</Pill>}
      />
      <FuelGauge
        total={total}
        bigLabel="events recorded"
        last7={aggregate.totalEventsLast7d}
        last1h={aggregate.totalEventsLast1h}
        actorLabel="staff"
        actorN={aggregate.distinctStaff}
        series={aggregate.dailyEventSeries}
        unit="cleans"
      />
      <HealthPanel sub="housekeeping" rows={healthRows} pills={healthPills} />
      <OverridesTable rows={recentOverrides} />
      <AdoptionPanel title="Staff adoption" rows={adoptRows} />
    </>
  );
}

// ─── Panel group — Inventory ────────────────────────────────────────────

function InventoryPanels({ cockpit, onSelect }: { cockpit: InventoryCockpitData; onSelect: (id: string) => void }) {
  const { mode, selectedProperty, aggregate, recentAnomalies, topCounters, properties } = cockpit;
  const rail = properties.map(toRailProp);

  const single = mode === 'single';
  const me = single && selectedProperty ? properties.find((p) => p.id === selectedProperty.id) ?? null : null;
  if (single && (!selectedProperty || !me)) {
    return <NotFound />;
  }

  const day = me ? me.daysSinceFirstCount : aggregate.fleetMedianDay;
  const last1h = me ? me.countsLast1h : aggregate.totalCountsLast1h;
  const total = me
    ? me.countsLast7d * Math.max(1, Math.round(me.daysSinceFirstCount / 7))
    : aggregate.totalCounts;

  const healthRows: Array<[string, string, ToneKey | null]> = [
    ['Last training', age(aggregate.lastTrainingRunAt) + ' ago', 'forest'],
    ['Last inference write', age(aggregate.lastInferenceWriteAt) + ' ago', 'forest'],
    ['Predictions · 24h', aggregate.predictionsLast24h.toLocaleString(), null],
    ['Active item models', String(aggregate.activeItemModelCount), null],
    ['Next training', 'in ' + ageIn(aggregate.nextTrainingAt), 'teal'],
    ['Next prediction', 'in ' + ageIn(aggregate.nextPredictionAt), 'teal'],
  ];
  const healthPills = (
    <>
      <Pill tone="forest">{aggregate.totalItemsGraduated} items graduated</Pill>
      <Pill tone="gold">{aggregate.totalItemsLearning} learning</Pill>
      <Pill tone="terracotta">{age(aggregate.lastAnomalyFiredAt)} since last anomaly</Pill>
    </>
  );

  // Inventory has no per-staff adoption %; the prototype derives a coverage
  // bar from itemsTouched/40. Keep that (honest, real itemsTouched).
  const adoptRows: AdoptRow[] = topCounters.map((c) => ({
    name: c.countedBy,
    pct: Math.min(100, Math.round((c.itemsTouched / 40) * 100)),
    meta: `${c.countCount} counts · ${c.itemsTouched} items`,
  }));

  return (
    <>
      <TimelinePanel
        sub="inventory"
        mode={single ? 'single' : 'fleet'}
        day={day}
        last1h={last1h}
        nextMilestoneLabel={aggregate.nextMilestoneLabel}
        daysToNextMilestone={aggregate.daysToNextMilestoneMedian}
        properties={rail}
        onSelect={onSelect}
      />
      <FuelGauge
        total={total}
        bigLabel="counts recorded"
        last7={aggregate.totalCountsLast7d}
        last1h={aggregate.totalCountsLast1h}
        actorLabel="items"
        actorN={aggregate.totalItems}
        series={aggregate.dailyCountSeries}
        unit="counts"
      />
      <HealthPanel sub="inventory" rows={healthRows} pills={healthPills} />
      <AnomaliesTable rows={recentAnomalies} />
      <AdoptionPanel title="Top counters" rows={adoptRows} />
    </>
  );
}
