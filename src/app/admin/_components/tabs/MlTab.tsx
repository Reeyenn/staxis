'use client';

/**
 * ML tab — Snow editorial cockpit inside /admin/properties (May 2026).
 *
 * Reeyen asked for the ML cockpit to live next to Agent on the admin
 * page instead of as a separate top-nav link. The data shape is the same
 * as /admin/ml — we hit the same `cockpit-data` endpoints — but the
 * chrome is the editorial Snow masthead + right-rail hotel selector from
 * the May 2026 design pack.
 *
 * Two HK/Inv sub-tabs; the right rail lets the owner drop into any
 * single property. The five data panels (Timeline, Data Fuel Gauge,
 * System Health, Overrides/Anomalies, Adoption) are reused from
 * /admin/ml — they're real, battle-tested visualizations.
 */

import React, { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { Building2 } from 'lucide-react';

import { HousekeepingTimeline } from '@/app/admin/ml/_components/housekeeping/HousekeepingTimeline';
import { HousekeepingDataFuelGauge } from '@/app/admin/ml/_components/housekeeping/HousekeepingDataFuelGauge';
import { HousekeepingSystemHealth } from '@/app/admin/ml/_components/housekeeping/HousekeepingSystemHealth';
import { HousekeepingOverridesTable } from '@/app/admin/ml/_components/housekeeping/HousekeepingOverridesTable';
import { HousekeepingAdoption } from '@/app/admin/ml/_components/housekeeping/HousekeepingAdoption';

import { InventoryTimeline } from '@/app/admin/ml/_components/inventory/InventoryTimeline';
import { InventoryDataFuelGauge } from '@/app/admin/ml/_components/inventory/InventoryDataFuelGauge';
import { InventoryPipelineHealth } from '@/app/admin/ml/_components/inventory/InventoryPipelineHealth';
import { InventoryRecentAnomaliesTable } from '@/app/admin/ml/_components/inventory/InventoryRecentAnomaliesTable';
import { InventoryAdoptionPanel } from '@/app/admin/ml/_components/inventory/InventoryAdoptionPanel';

import { T, FONT_SANS, FONT_MONO, FONT_SERIF, Caps } from '@/app/admin/_components/_snow';

type Sub = 'housekeeping' | 'inventory';

// ─── Cockpit data shapes (mirror /admin/ml/page.tsx) ────────────────────

interface InventoryCockpitData {
  mode: 'network' | 'single';
  selectedProperty: { id: string; name: string } | null;
  properties: Array<{
    id: string; name: string; brand: string | null;
    daysSinceFirstCount: number; itemsTotal: number; itemsGraduated: number;
    status: 'healthy' | 'warming' | 'issue';
    lastTrainingAt: string | null; lastPredictionAt: string | null;
    countsLast7d: number;
    countsLast1h: number;
    joinedAt: string | null;
    isTest: boolean;
  }>;
  aggregate: {
    hotelCount: number; totalCounts: number; totalCountsLast7d: number;
    totalCountsLast24h: number; totalCountsLast1h: number;
    totalItems: number; totalItemsGraduated: number;
    totalItemsLearning: number; fleetMedianDay: number;
    daysOfHistoryRange: { min: number; max: number };
    healthCounts: { healthy: number; warming: number; issue: number };
    daysToNextMilestoneMedian: number | null;
    nextMilestoneLabel: string;
    phaseHistogram: Array<{ phaseId: string; phaseLabel: string; phaseDay: number; hotelCount: number }>;
    dailyCountSeries: Array<{ date: string; recorded: number }>;
    lastTrainingRunAt: string | null; lastInferenceWriteAt: string | null;
    lastAnomalyFiredAt: string | null;
    predictionsLast24h: number; activeItemModelCount: number;
    nextTrainingAt: string;
    nextPredictionAt: string;
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

interface HKCockpitData {
  mode: 'network' | 'single';
  selectedProperty: { id: string; name: string } | null;
  properties: Array<{
    id: string; name: string; brand: string | null;
    daysSinceFirstEvent: number; staffActive: number; modelsActive: number;
    status: 'healthy' | 'warming' | 'issue';
    lastTrainingAt: string | null; lastInferenceAt: string | null;
    eventsLast7d: number;
    eventsLast1h: number;
    joinedAt: string | null;
    isTest: boolean;
    // Phase 7 v2 (2026-05-22) — per-property last auto-rollback ts.
    lastAutoRollbackAt: string | null;
  }>;
  aggregate: {
    hotelCount: number; totalEvents: number; totalEventsLast7d: number;
    totalEventsLast24h: number; totalEventsLast1h: number; totalDiscardedEvents: number;
    distinctStaff: number; distinctRooms: number;
    fleetMedianDay: number; daysOfHistoryRange: { min: number; max: number };
    healthCounts: { healthy: number; warming: number; issue: number };
    // Phase 1.5 (2026-05-22) — honesty rollup from cockpit-data route.
    warmingUpCount: number;
    capacityUnavailableCount: number;
    xgboostDeferredCount: number;
    fullyFittedCount: number;
    // Phase 7 v2 (2026-05-22) — auto-rollback (drift detector) rollup.
    lastAutoRollbackAt: string | null;
    autoRollbacksLast7d: number;
    dryRunRollbacksLast7d: number;
    daysToNextMilestoneMedian: number | null;
    nextMilestoneLabel: string;
    phaseHistogram: Array<{ phaseId: string; phaseLabel: string; phaseDay: number; hotelCount: number }>;
    dailyEventSeries: Array<{ date: string; recorded: number; discarded: number }>;
    lastTrainingRunAt: string | null; lastInferenceWriteAt: string | null;
    lastOverrideAt: string | null;
    predictionsLast24h: number; activeModelRunCount: number;
    optimizerActive: boolean;
    nextTrainingAt: string;
    nextPredictionAt: string;
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

export function MlTab() {
  const [sub, setSub] = useState<Sub>('housekeeping');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hk, setHk] = useState<HKCockpitData | null>(null);
  const [inv, setInv] = useState<InventoryCockpitData | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoading(true);
      setErr(null);
      try {
        const { data: { session } } = await supabase.auth.getSession();
        const base = sub === 'inventory'
          ? '/api/admin/ml/inventory/cockpit-data'
          : '/api/admin/ml/housekeeping/cockpit-data';
        const url = selectedId ? `${base}?propertyId=${selectedId}` : base;
        const res = await fetch(url, {
          headers: session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {},
        });
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

  // Pick the active cockpit for the rail + masthead counts.
  const properties = sub === 'inventory' ? inv?.properties : hk?.properties;
  const hotelCount = sub === 'inventory'
    ? inv?.aggregate.hotelCount
    : hk?.aggregate.hotelCount;
  const healthCounts = sub === 'inventory'
    ? inv?.aggregate.healthCounts
    : hk?.aggregate.healthCounts;

  const selectedProperty = selectedId && properties
    ? properties.find((p) => p.id === selectedId) ?? null
    : null;

  return (
    <div style={{ fontFamily: FONT_SANS }}>
      <Masthead
        sub={sub}
        onSub={(s) => { setSub(s); setSelectedId(null); }}
        selected={selectedProperty
          ? { name: selectedProperty.name, brand: selectedProperty.brand, status: selectedProperty.status, days: 'daysSinceFirstEvent' in selectedProperty ? selectedProperty.daysSinceFirstEvent : selectedProperty.daysSinceFirstCount }
          : null}
        onClearSelected={() => setSelectedId(null)}
        hotelCount={hotelCount}
        healthCounts={healthCounts}
      />

      <div style={{
        display: 'grid',
        gridTemplateColumns: 'minmax(0, 1fr) 300px',
        gap: 28, alignItems: 'flex-start',
      }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20, minWidth: 0 }}>
          {loading && !hk && !inv ? (
            <div style={{
              padding: '60px 0', textAlign: 'center', fontStyle: 'italic',
              fontFamily: FONT_SERIF, fontSize: 16, color: T.ink3,
            }}>
              Loading cockpit data…
            </div>
          ) : err ? (
            <div style={{
              padding: '14px 16px',
              background: T.warmDim,
              border: `1px solid rgba(184,92,61,0.25)`,
              borderRadius: 14,
              color: T.warm, fontSize: 13,
            }}>
              Failed to load cockpit: {err}
            </div>
          ) : sub === 'inventory' && inv ? (
            <InventoryPanels cockpit={inv} />
          ) : sub === 'housekeeping' && hk ? (
            <HousekeepingPanels cockpit={hk} />
          ) : null}
        </div>

        <HotelRail
          sub={sub}
          properties={properties ?? []}
          selectedId={selectedId}
          onSelect={setSelectedId}
        />
      </div>
    </div>
  );
}

// ─── Masthead ───────────────────────────────────────────────────────────

function Masthead({
  sub, onSub, selected, onClearSelected, hotelCount, healthCounts,
}: {
  sub: Sub;
  onSub: (s: Sub) => void;
  selected: { name: string; brand: string | null; status: 'healthy' | 'warming' | 'issue'; days: number } | null;
  onClearSelected: () => void;
  hotelCount: number | undefined;
  healthCounts: { healthy: number; warming: number; issue: number } | undefined;
}) {
  return (
    <div style={{ marginBottom: 24, paddingBottom: 18, borderBottom: `1px solid ${T.rule}` }}>
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start',
        gap: 32,
      }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <Caps>Machine learning · Cockpit</Caps>
          <h1 style={{
            fontFamily: FONT_SERIF, fontSize: 42, fontStyle: 'italic',
            color: T.ink, margin: '10px 0 0',
            letterSpacing: '-0.035em', lineHeight: 1.05, fontWeight: 400,
            maxWidth: 680,
          }}>
            {selected ? (
              <>{selected.name}<span style={{ color: T.ink3 }}>, alone.</span></>
            ) : (
              <>{hotelCount ?? '—'} {hotelCount === 1 ? 'hotel' : 'hotels'}, learning every hour.</>
            )}
          </h1>
        </div>
        <div style={{
          textAlign: 'right', display: 'flex', flexDirection: 'column',
          alignItems: 'flex-end', gap: 10, flexShrink: 0, paddingTop: 2,
        }}>
          {selected ? (
            <>
              <Caps size={9}>Scope</Caps>
              <button onClick={onClearSelected} style={{
                all: 'unset', cursor: 'pointer',
                display: 'inline-flex', alignItems: 'center', gap: 8,
                padding: '6px 14px', border: `1px solid ${T.rule}`, borderRadius: 999,
                background: T.paper,
                fontFamily: FONT_SANS, fontSize: 12, color: T.ink2,
              }}>
                <StatusDot status={selected.status} />
                <span>{selected.brand ?? '—'} · D{selected.days}</span>
                <span style={{ marginLeft: 6, color: T.ink3 }}>×</span>
              </button>
            </>
          ) : healthCounts ? (
            <>
              <Caps size={9}>Network health</Caps>
              <div style={{
                display: 'flex', gap: 14,
                fontFamily: FONT_MONO, fontSize: 10.5, color: T.ink2, letterSpacing: '0.08em',
              }}>
                <HealthCell color={T.sageDeep} label={`${healthCounts.healthy} healthy`} />
                <HealthCell color={T.caramelDeep} label={`${healthCounts.warming} warming`} />
                <HealthCell color={T.warm} label={`${healthCounts.issue} issue`} />
              </div>
            </>
          ) : null}
        </div>
      </div>
      {/* Sub-tabs */}
      <div style={{ marginTop: 18 }}>
        <SubTabs sub={sub} onSub={onSub} />
      </div>
    </div>
  );
}

function SubTabs({ sub, onSub }: { sub: Sub; onSub: (s: Sub) => void }) {
  const items: { k: Sub; l: string }[] = [
    { k: 'housekeeping', l: 'Housekeeping' },
    { k: 'inventory', l: 'Inventory' },
  ];
  return (
    <div style={{ display: 'inline-flex', gap: 20, alignItems: 'baseline' }}>
      {items.map((it, i) => {
        const active = sub === it.k;
        return (
          <React.Fragment key={it.k}>
            <button
              onClick={() => onSub(it.k)}
              style={{
                all: 'unset', cursor: 'pointer',
                fontFamily: FONT_SERIF, fontSize: 22, fontStyle: 'italic',
                color: active ? T.ink : T.ink3,
                letterSpacing: '-0.02em',
                borderBottom: active ? `1.5px solid ${T.ink}` : '1.5px solid transparent',
                paddingBottom: 4, transition: 'color 0.12s, border-color 0.12s',
              }}
            >
              {it.l}
            </button>
            {i < items.length - 1 && (
              <span style={{ color: T.ink3, fontFamily: FONT_SERIF, fontSize: 18 }}>·</span>
            )}
          </React.Fragment>
        );
      })}
    </div>
  );
}

function HealthCell({ color, label }: { color: string; label: string }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
      <span style={{ width: 7, height: 7, borderRadius: '50%', background: color }} />
      {label.toUpperCase()}
    </span>
  );
}

function StatusDot({ status, size = 8 }: { status: 'healthy' | 'warming' | 'issue'; size?: number }) {
  const c = status === 'healthy' ? T.sageDeep
    : status === 'warming' ? T.caramelDeep
    : T.warm;
  return (
    <span style={{
      display: 'inline-block', width: size, height: size, borderRadius: '50%',
      background: c,
      boxShadow: `0 0 0 1.5px ${T.bg}, 0 0 0 2.5px ${c}33`,
      flexShrink: 0,
    }} />
  );
}

// ─── Right rail ─────────────────────────────────────────────────────────

interface RailProperty {
  id: string;
  name: string;
  brand: string | null;
  status: 'healthy' | 'warming' | 'issue';
  isTest: boolean;
}

function HotelRail({
  sub, properties, selectedId, onSelect,
}: {
  sub: Sub;
  properties: Array<RailProperty & {
    eventsLast7d?: number;
    eventsLast1h?: number;
    countsLast7d?: number;
    countsLast1h?: number;
    daysSinceFirstEvent?: number;
    daysSinceFirstCount?: number;
  }>;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}) {
  return (
    <div style={{
      background: T.paper,
      border: `1px solid ${T.rule}`,
      borderRadius: 14,
      padding: '18px 4px 16px',
      position: 'sticky', top: 24,
      maxHeight: 'calc(100vh - 48px)', overflowY: 'auto',
      alignSelf: 'flex-start',
      fontFamily: FONT_SANS,
    }}>
      <div style={{
        padding: '0 18px 12px',
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      }}>
        <Caps size={9}>Hotels · {properties.length}</Caps>
        <span style={{ fontFamily: FONT_MONO, fontSize: 9.5, color: T.ink3, letterSpacing: '0.06em' }}>
          {selectedId ? 'SINGLE' : 'FLEET'}
        </span>
      </div>

      <RailRow
        active={!selectedId}
        onClick={() => onSelect(null)}
        title="All hotels"
        subtitle={`Fleet aggregate · ${properties.length} ${properties.length === 1 ? 'hotel' : 'hotels'}`}
        status={null}
        meta={null}
      />

      <div style={{ height: 1, background: T.ruleSoft, margin: '8px 18px 6px' }} />

      {properties.length === 0 ? (
        <div style={{
          padding: '24px 18px', textAlign: 'center',
          color: T.ink3, fontStyle: 'italic', fontFamily: FONT_SERIF, fontSize: 13,
        }}>
          <Building2 size={20} style={{ marginBottom: 6, opacity: 0.6 }} />
          <div>No hotels yet.</div>
        </div>
      ) : properties.map((p) => {
        const v7 = sub === 'inventory'
          ? p.countsLast7d ?? 0
          : p.eventsLast7d ?? 0;
        const days = sub === 'inventory'
          ? p.daysSinceFirstCount ?? 0
          : p.daysSinceFirstEvent ?? 0;
        const unit = sub === 'inventory' ? 'counts' : 'cleans';
        const meta = `${v7.toLocaleString()} ${unit}/7d · D${days}`;
        return (
          <RailRow
            key={p.id}
            active={selectedId === p.id}
            onClick={() => onSelect(p.id)}
            title={p.name}
            subtitle={`${p.brand ?? 'Unbranded'}${p.isTest ? ' · test' : ''}`}
            status={p.status}
            meta={meta}
            dim={p.isTest}
          />
        );
      })}
    </div>
  );
}

function RailRow({
  active, onClick, title, subtitle, status, meta, dim,
}: {
  active: boolean;
  onClick: () => void;
  title: string;
  subtitle: string;
  status: 'healthy' | 'warming' | 'issue' | null;
  meta: string | null;
  dim?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        all: 'unset', cursor: 'pointer', display: 'block', width: 'calc(100% - 12px)',
        padding: '10px 14px', margin: '1px 6px', borderRadius: 8,
        background: active ? T.sageDim : 'transparent',
        borderLeft: active ? `2px solid ${T.sageDeep}` : '2px solid transparent',
        transition: 'background 0.12s',
        opacity: dim ? 0.6 : 1,
      }}
      onMouseEnter={(e) => !active && (e.currentTarget.style.background = 'rgba(31,35,28,0.025)')}
      onMouseLeave={(e) => !active && (e.currentTarget.style.background = 'transparent')}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{
            fontFamily: FONT_SERIF, fontSize: 14.5, fontStyle: 'italic',
            color: active ? T.sageDeep : T.ink, letterSpacing: '-0.015em', lineHeight: 1.15,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>
            {title}
          </div>
          <div style={{
            fontFamily: FONT_SANS, fontSize: 11, color: T.ink2, marginTop: 2,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>
            {subtitle}
          </div>
          {meta && (
            <div style={{
              fontFamily: FONT_MONO, fontSize: 9.5, color: T.ink3,
              marginTop: 3, letterSpacing: '0.06em',
            }}>
              {meta}
            </div>
          )}
        </div>
        {status && <div style={{ paddingTop: 5 }}><StatusDot status={status} /></div>}
      </div>
    </button>
  );
}

// ─── Panel groups (delegated to the existing /admin/ml panels) ──────────

function InventoryPanels({ cockpit }: { cockpit: InventoryCockpitData }) {
  const { mode, selectedProperty, aggregate, recentAnomalies, topCounters, properties } = cockpit;

  if (mode === 'single') {
    const sp = selectedProperty;
    const me = sp ? properties.find((p) => p.id === sp.id) : null;
    if (!sp || !me) {
      return <p style={{ color: T.ink2, fontSize: 13 }}>Selected hotel not found.</p>;
    }
    return (
      <>
        <InventoryTimeline
          mode="single"
          day={me.daysSinceFirstCount}
          itemsTotal={me.itemsTotal}
          itemsGraduated={me.itemsGraduated}
          countsLast1h={me.countsLast1h}
          daysToNextMilestone={aggregate.daysToNextMilestoneMedian}
          nextMilestoneLabel={aggregate.nextMilestoneLabel}
          aiMode="auto"
          hotelName={sp.name}
        />
        <InventoryDataFuelGauge
          mode="single"
          totalCounts={aggregate.totalCounts}
          countsLast7d={aggregate.totalCountsLast7d}
          countsLast24h={aggregate.totalCountsLast24h}
          itemsTracked={aggregate.totalItems}
          dailyCountSeries={aggregate.dailyCountSeries}
          daysOfHistory={me.daysSinceFirstCount}
          hotelName={sp.name}
        />
        <InventoryPipelineHealth
          mode="single"
          lastTrainingRunAt={aggregate.lastTrainingRunAt}
          lastInferenceWriteAt={aggregate.lastInferenceWriteAt}
          lastAnomalyFiredAt={aggregate.lastAnomalyFiredAt}
          activeItemModelCount={aggregate.activeItemModelCount}
          predictionsLast24h={aggregate.predictionsLast24h}
          nextTrainingAt={aggregate.nextTrainingAt}
          nextPredictionAt={aggregate.nextPredictionAt}
          hotelName={sp.name}
        />
        <InventoryRecentAnomaliesTable mode="single" rows={recentAnomalies} />
        <InventoryAdoptionPanel mode="single" rows={topCounters} />
      </>
    );
  }

  return (
    <>
      <InventoryTimeline
        mode="fleet"
        fleetMedianDay={aggregate.fleetMedianDay}
        hotelCount={aggregate.hotelCount}
        itemsLearningTotal={aggregate.totalItemsLearning}
        itemsGraduatedTotal={aggregate.totalItemsGraduated}
        totalCountsLast1h={aggregate.totalCountsLast1h}
        daysToNextMilestoneMedian={aggregate.daysToNextMilestoneMedian}
        nextMilestoneLabel={aggregate.nextMilestoneLabel}
        phaseHistogram={aggregate.phaseHistogram}
      />
      <InventoryDataFuelGauge
        mode="fleet"
        totalCounts={aggregate.totalCounts}
        countsLast7d={aggregate.totalCountsLast7d}
        countsLast24h={aggregate.totalCountsLast24h}
        itemsTracked={aggregate.totalItems}
        dailyCountSeries={aggregate.dailyCountSeries}
        hotelCount={aggregate.hotelCount}
        daysOfHistoryRange={aggregate.daysOfHistoryRange}
      />
      <InventoryPipelineHealth
        mode="fleet"
        lastTrainingRunAt={aggregate.lastTrainingRunAt}
        lastInferenceWriteAt={aggregate.lastInferenceWriteAt}
        lastAnomalyFiredAt={aggregate.lastAnomalyFiredAt}
        activeItemModelCount={aggregate.activeItemModelCount}
        predictionsLast24h={aggregate.predictionsLast24h}
        nextTrainingAt={aggregate.nextTrainingAt}
        nextPredictionAt={aggregate.nextPredictionAt}
        hotelCount={aggregate.hotelCount}
        healthCounts={aggregate.healthCounts}
      />
      <InventoryRecentAnomaliesTable mode="fleet" rows={recentAnomalies} />
      <InventoryAdoptionPanel mode="fleet" rows={topCounters} />
    </>
  );
}

function HousekeepingPanels({ cockpit }: { cockpit: HKCockpitData }) {
  const { mode, selectedProperty, aggregate, recentOverrides, topAdoption, properties } = cockpit;

  if (mode === 'single') {
    const sp = selectedProperty;
    const me = sp ? properties.find((p) => p.id === sp.id) : null;
    if (!sp || !me) {
      return <p style={{ color: T.ink2, fontSize: 13 }}>Selected hotel not found.</p>;
    }
    return (
      <>
        <HousekeepingTimeline
          mode="single"
          day={me.daysSinceFirstEvent}
          staffActive={me.staffActive}
          modelsActive={me.modelsActive}
          eventsLast1h={me.eventsLast1h}
          daysToNextMilestone={aggregate.daysToNextMilestoneMedian}
          nextMilestoneLabel={aggregate.nextMilestoneLabel}
          hotelName={sp.name}
          optimizerActive={aggregate.optimizerActive}
        />
        <HousekeepingDataFuelGauge
          mode="single"
          totalEvents={aggregate.totalEvents}
          eventsLast7d={aggregate.totalEventsLast7d}
          eventsLast24h={aggregate.totalEventsLast24h}
          eventsLast1h={aggregate.totalEventsLast1h}
          totalDiscardedEvents={aggregate.totalDiscardedEvents}
          distinctStaff={aggregate.distinctStaff}
          distinctRooms={aggregate.distinctRooms}
          dailyEventSeries={aggregate.dailyEventSeries}
          daysOfHistory={me.daysSinceFirstEvent}
          hotelName={sp.name}
        />
        <HousekeepingSystemHealth
          mode="single"
          lastTrainingRunAt={aggregate.lastTrainingRunAt}
          lastInferenceWriteAt={aggregate.lastInferenceWriteAt}
          lastOverrideAt={aggregate.lastOverrideAt}
          activeModelRunCount={aggregate.activeModelRunCount}
          predictionsLast24h={aggregate.predictionsLast24h}
          optimizerActive={aggregate.optimizerActive}
          nextTrainingAt={aggregate.nextTrainingAt}
          nextPredictionAt={aggregate.nextPredictionAt}
          warmingUpCount={aggregate.warmingUpCount}
          capacityUnavailableCount={aggregate.capacityUnavailableCount}
          xgboostDeferredCount={aggregate.xgboostDeferredCount}
          fullyFittedCount={aggregate.fullyFittedCount}
          lastAutoRollbackAt={me?.lastAutoRollbackAt ?? null}
          autoRollbacksLast7d={aggregate.autoRollbacksLast7d}
          dryRunRollbacksLast7d={aggregate.dryRunRollbacksLast7d}
          hotelName={sp.name}
        />
        <HousekeepingOverridesTable mode="single" rows={recentOverrides} />
        <HousekeepingAdoption mode="single" rows={topAdoption} />
      </>
    );
  }

  return (
    <>
      <HousekeepingTimeline
        mode="fleet"
        fleetMedianDay={aggregate.fleetMedianDay}
        hotelCount={aggregate.hotelCount}
        totalStaff={aggregate.distinctStaff}
        totalModelsActive={aggregate.activeModelRunCount}
        totalEventsLast1h={aggregate.totalEventsLast1h}
        daysToNextMilestoneMedian={aggregate.daysToNextMilestoneMedian}
        nextMilestoneLabel={aggregate.nextMilestoneLabel}
        phaseHistogram={aggregate.phaseHistogram}
        optimizerActive={aggregate.optimizerActive}
      />
      <HousekeepingDataFuelGauge
        mode="fleet"
        totalEvents={aggregate.totalEvents}
        eventsLast7d={aggregate.totalEventsLast7d}
        eventsLast24h={aggregate.totalEventsLast24h}
        eventsLast1h={aggregate.totalEventsLast1h}
        totalDiscardedEvents={aggregate.totalDiscardedEvents}
        distinctStaff={aggregate.distinctStaff}
        distinctRooms={aggregate.distinctRooms}
        dailyEventSeries={aggregate.dailyEventSeries}
        hotelCount={aggregate.hotelCount}
        daysOfHistoryRange={aggregate.daysOfHistoryRange}
      />
      <HousekeepingSystemHealth
        mode="fleet"
        lastTrainingRunAt={aggregate.lastTrainingRunAt}
        lastInferenceWriteAt={aggregate.lastInferenceWriteAt}
        lastOverrideAt={aggregate.lastOverrideAt}
        activeModelRunCount={aggregate.activeModelRunCount}
        predictionsLast24h={aggregate.predictionsLast24h}
        optimizerActive={aggregate.optimizerActive}
        nextTrainingAt={aggregate.nextTrainingAt}
        nextPredictionAt={aggregate.nextPredictionAt}
        hotelCount={aggregate.hotelCount}
        healthCounts={aggregate.healthCounts}
        warmingUpCount={aggregate.warmingUpCount}
        capacityUnavailableCount={aggregate.capacityUnavailableCount}
        xgboostDeferredCount={aggregate.xgboostDeferredCount}
        fullyFittedCount={aggregate.fullyFittedCount}
        lastAutoRollbackAt={aggregate.lastAutoRollbackAt}
        autoRollbacksLast7d={aggregate.autoRollbacksLast7d}
        dryRunRollbacksLast7d={aggregate.dryRunRollbacksLast7d}
      />
      <HousekeepingOverridesTable mode="fleet" rows={recentOverrides} />
      <HousekeepingAdoption mode="fleet" rows={topAdoption} />
    </>
  );
}
