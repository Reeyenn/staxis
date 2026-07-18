'use client';

/* ───────────────────────────────────────────────────────────────────────
   SURFACE — Live Hotels · "Fleet Map" (dark).

   The design-handoff finalized Live screen (`LiveMap`, iteration 04), wired
   verbatim to the real data + mutations the prior LiveHotelsTab used. Nothing
   here is mocked.

   Data (same endpoints, params, response shapes, debounce, filters,
   sort and pagination as the prior tab):
     • /api/admin/list-properties?page&pageSize&status&search → fleet + pagination
     • /api/admin/feedback                                   → feedback inbox
   Mutation kept: PATCH /api/admin/feedback { id, status } —
     new → in_progress → resolved / wontfix, then refetch.

   Layout (top→bottom), exactly mirroring LiveMap:
     1. Header — caps eyebrow + serif "<n> hotels live" + debounced search +
        status filter select.
     2. Fleet-health strip — Healthy · Watch · Needs attention · Disconnected
        PMS, each a dot + counting-up serif number.
     3. Four-column control grid (repeat(4, minmax(0,1fr)), gap 18):
        Hotels (single-click flip / double-click detail modal) · Feedback inbox
        (flip on status set). Recent errors moved to Mission Control (2026-07-17).
     Plus the Hotels-column pager (kept available for 18+ hotel fleets).

   Sync-freshness color (handoff): not connected = dim; stale(>12h) =
   terracotta; >60m = gold-deep; else forest-deep.

   This is a DARK surface: <SurfaceShell glow="tealTL"> + DarkCard / dimWhite
   for cards, Backdrop + MODAL_CARD for the light detail modal.
   ─────────────────────────────────────────────────────────────────────── */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { fetchWithAuth } from '@/lib/api-fetch';
import {
  FONT_SERIF, FONT_MONO, Caps, Pill, Dot, Btn, SerifNum,
  countUp, flip, riseIn, freshLabel, age,
  type PillTone, type DotTone,
} from '../kit';
import {
  SurfaceShell, DarkCard, DarkSpinner, DarkEmpty, dimWhite, Backdrop, MODAL_CARD,
} from '../surface-kit';
import { CoveragePickerModal } from '../CoveragePickerModal';
import { SectionsModal } from '../SectionsModal';
import { AddHotelModal } from '../AddHotelModal';
import { AIControlCenter } from '../../AIControlCenter';
import { AccessPopover } from '../../AccessPopover';
import { TwoFactorSwitch } from '../../TwoFactorSwitch';
import { APP_SECTIONS, type AppSection } from '@/lib/sections/registry';
import { FLEET_STALE_SYNC_MINUTES } from '@/lib/admin-property-health';

const PAGE_SIZE = 50;

// ── Real API shapes (mirror the prior LiveHotelsTab interfaces) ──────────
interface PropertyRow {
  id: string;
  name: string | null;
  totalRooms: number | null;
  subscriptionStatus: string | null;
  pmsType: string | null;
  pmsConnected: boolean;
  lastSyncedAt: string | null;
  syncFreshnessMin: number | null;
  staffCount: number;
  createdAt: string;
  // Full resolved 8-key section on/off map (default-ON coalesced server-side).
  enabledSections: Record<AppSection, boolean>;
}
interface FeedbackItem {
  id: string;
  property_id: string | null;
  property_name: string | null;
  user_email: string | null;
  user_display_name: string | null;
  message: string;
  category: string;
  status: string;
  admin_note: string | null;
  resolved_at: string | null;
  created_at: string;
}
interface Pagination { totalMatching: number; totalPages: number; hasMore: boolean }

type StatusFilter = 'all' | 'active' | 'trial' | 'past_due' | 'stale' | 'pms_disconnected' | 'no_pms';

// A property enriched with the staleness flag (= prior tab's isStale12h).
type EnrichedRow = PropertyRow & { isStale12h: boolean };

// ── Shared derivations (mirror the prototype + prior tab semantics) ──────
function subTone(s: string | null): PillTone {
  return s === 'active' ? 'forest' : s === 'past_due' ? 'terracotta' : s === 'trial' ? 'gold' : 'neutral';
}
// Sync-freshness color per the handoff.
function syncColor(p: { pmsConnected: boolean; isStale12h: boolean; syncFreshnessMin: number | null }): string {
  if (!p.pmsConnected) return 'var(--dim)';
  if (p.isStale12h) return 'var(--terracotta)';
  if (p.syncFreshnessMin !== null && p.syncFreshnessMin > 60) return 'var(--gold-deep)';
  return 'var(--forest-deep)';
}
// Health-strip tone for a single hotel (matches LiveMap's per-card toneOf).
function cardTone(p: EnrichedRow): DotTone {
  // No system detected (pms_type IS NULL) → needs action. Check first.
  if (p.pmsType === null) return 'terracotta';
  if (p.subscriptionStatus === 'past_due' || p.isStale12h || !p.pmsConnected) return 'terracotta';
  if (p.subscriptionStatus === 'trial' || (p.pmsConnected && p.syncFreshnessMin !== null && p.syncFreshnessMin > 60)) return 'gold';
  return 'forest';
}

const STATUS_OPTS: [StatusFilter, string][] = [
  ['all', 'All statuses'], ['active', 'Active'], ['trial', 'Trial'], ['past_due', 'Past due'],
  ['stale', 'Stale (no PMS sync >12h)'], ['pms_disconnected', 'PMS disconnected'],
  ['no_pms', 'No system detected'],
];

const CAT: Record<string, string> = {
  bug: '◆ bug', feature_request: '✦ idea', general: '○ note', complaint: '▲ issue', love: '♥ love',
};
function fbTone(s: string): PillTone {
  return s === 'new' ? 'gold' : s === 'resolved' ? 'forest' : s === 'in_progress' ? 'teal' : 'neutral';
}

export function LiveSurface() {
  const [props, setProps] = useState<PropertyRow[] | null>(null);
  const [feedback, setFeedback] = useState<FeedbackItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [searchInput, setSearchInput] = useState('');
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [page, setPage] = useState(1);
  const [pagination, setPagination] = useState<Pagination | null>(null);
  // Bumped after a create to force EXACTLY ONE refetch off the reset filter
  // state. Calling load() directly there would fire a second fetch with the
  // stale pre-reset closure that can resolve last and clobber the fresh list
  // (hiding the just-created hotel) — the race all three reviewers flagged.
  const [reloadNonce, setReloadNonce] = useState(0);

  const [sel, setSel] = useState<EnrichedRow | null>(null);
  // Hotel currently being assigned a PMS coverage (null = picker closed).
  const [pickerHotel, setPickerHotel] = useState<EnrichedRow | null>(null);
  // Hotel whose section on/off toggles are open (null = modal closed).
  const [sectionsHotel, setSectionsHotel] = useState<EnrichedRow | null>(null);
  // "+ Add hotel" modal — create a new property directly from this tab.
  const [addOpen, setAddOpen] = useState(false);
  // Hotel pending permanent deletion (null = confirm closed).
  const [deleteHotel, setDeleteHotel] = useState<EnrichedRow | null>(null);

  // Debounced search (300ms) — same as the prior tab.
  useEffect(() => {
    const t = setTimeout(() => setSearchTerm(searchInput.trim()), 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  useEffect(() => { setPage(1); }, [searchTerm, statusFilter]);

  const load = useCallback(async () => {
    setError(null);
    try {
      // Every status — including 'no_pms' and the computed 'stale' /
      // 'pms_disconnected' — is applied server-side by list-properties.
      const propsParams = new URLSearchParams({
        page: String(page),
        pageSize: String(PAGE_SIZE),
        status: statusFilter,
      });
      if (searchTerm) propsParams.set('search', searchTerm);
      const [propsRes, feedbackRes] = await Promise.all([
        fetchWithAuth(`/api/admin/list-properties?${propsParams.toString()}`),
        fetchWithAuth('/api/admin/feedback'),
      ]);
      const [propsJson, feedbackJson] = await Promise.all([
        propsRes.json(), feedbackRes.json(),
      ]);

      // Surface a failed response as a visible error instead of leaving the
      // surface on its spinner forever (the prior behavior when a payload
      // came back !ok).
      const loads = [
        { label: 'hotel list', response: propsRes, payload: propsJson },
        { label: 'feedback', response: feedbackRes, payload: feedbackJson },
      ];
      const failed = loads.find(({ response, payload }) => !response.ok || payload?.ok !== true);
      if (failed) {
        const apiMessage = typeof failed.payload?.error?.message === 'string'
          ? failed.payload.error.message
          : typeof failed.payload?.error === 'string'
            ? failed.payload.error
            : `HTTP ${failed.response.status}`;
        setError(`Could not load ${failed.label}: ${apiMessage}`);
        return;
      }
      setProps(propsJson.data.properties);
      setPagination(propsJson.data.pagination ?? null);
      setFeedback(feedbackJson.data.feedback);
    } catch (err) {
      setError(`Network error: ${(err as Error).message}`);
    }
    // reloadNonce is an intentional refetch nonce — not read in the body, but
    // bumping it recreates `load` so the [load] effect below refetches after a
    // create even when the filters were already at their defaults.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, statusFilter, searchTerm, reloadNonce]);

  useEffect(() => { void load(); }, [load]);

  // ── Error / loading states (dark) ──────────────────────────────────────
  if (error) {
    return (
      <SurfaceShell glow="tealTL">
        <SurfaceHeader count={0} searchInput={searchInput} setSearchInput={setSearchInput} statusFilter={statusFilter} setStatusFilter={setStatusFilter} />
        <div style={{ marginTop: 18, padding: '14px 16px', background: 'var(--terracotta-dim)', border: '1px solid rgba(194,86,46,.4)', borderRadius: 14, color: 'var(--terracotta)', fontSize: 13 }}>
          {error}
        </div>
      </SurfaceShell>
    );
  }
  if (!props || !feedback) {
    return (
      <SurfaceShell glow="tealTL">
        <div style={{ padding: '80px 0', textAlign: 'center' }}><DarkSpinner /></div>
      </SurfaceShell>
    );
  }

  // ── Derivations (verbatim from the prior tab) ──────────────────────────
  // "all" view shows hotels that have synced at least once OR are active OR
  // are not-yet-assigned (so "no system detected" hotels surface for an admin
  // to pick coverage instead of hiding silently). Every explicit status,
  // including no_pms, is already applied server-side, so trust the list.
  const live = statusFilter === 'all'
    ? props.filter((p) => p.lastSyncedAt !== null || p.subscriptionStatus === 'active' || p.pmsType === null)
    : props;

  const enriched: EnrichedRow[] = live.map((p) => ({
    ...p,
    isStale12h: p.pmsConnected
      && p.syncFreshnessMin !== null
      && p.syncFreshnessMin > FLEET_STALE_SYNC_MINUTES,
  }));

  // Sort priority: past_due → stale → fresh, then newest.
  enriched.sort((a, b) => {
    const score = (p: EnrichedRow) => {
      if (p.subscriptionStatus === 'past_due') return 0;
      if (p.isStale12h) return 1;
      return 2;
    };
    const sa = score(a), sb = score(b);
    if (sa !== sb) return sa - sb;
    return Date.parse(b.createdAt) - Date.parse(a.createdAt);
  });

  // Fleet-health counts (the four big serif numbers, per LiveMap.health).
  const health = {
    ok: enriched.filter((p) => p.pmsConnected && !p.isStale12h && p.subscriptionStatus !== 'past_due').length,
    watch: enriched.filter((p) => p.subscriptionStatus === 'trial' || (p.pmsConnected && p.syncFreshnessMin !== null && p.syncFreshnessMin > 60 && !p.isStale12h)).length,
    attn: enriched.filter((p) => p.subscriptionStatus === 'past_due' || p.isStale12h || !p.pmsConnected).length,
    disc: enriched.filter((p) => !p.pmsConnected).length,
  };

  const newFeedbackCount = feedback.filter((f) => f.status === 'new').length;
  const heroCount = pagination?.totalMatching ?? enriched.length;

  return (
    <SurfaceShell glow="tealTL">
      <SurfaceHeader count={heroCount} searchInput={searchInput} setSearchInput={setSearchInput} statusFilter={statusFilter} setStatusFilter={setStatusFilter} />

      {/* Fleet-health strip */}
      <div style={{ display: 'flex', gap: 20, marginBottom: 22, flexWrap: 'wrap' }}>
        <DarkHealth label="Healthy" n={health.ok} tone="forest" />
        <DarkHealth label="Watch" n={health.watch} tone="gold" />
        <DarkHealth label="Needs attention" n={health.attn} tone="terracotta" />
        <DarkHealth label="Disconnected PMS" n={health.disc} tone="terracotta" />
      </div>

      {/* Control grid: Hotels · Feedback inbox */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0,1fr))', gap: 18, alignItems: 'start' }}>

        {/* Column 1 — Hotels */}
        <section style={{ minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
            <span className="caps" style={{ color: dimWhite(.5) }}>Hotels · {enriched.length}</span>
            <Btn size="sm" variant="ghost" onClick={() => setAddOpen(true)} style={{ color: '#fff', borderColor: dimWhite(.25), fontSize: 9.5, padding: '3px 9px' }}>+ Add hotel</Btn>
          </div>
          {enriched.length === 0 ? (
            <div style={{ marginTop: 10 }}><DarkEmpty text="No live hotels yet — they'll appear once their first sync completes." /></div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 10 }}>
              {enriched.map((h) => <MapCard key={h.id} h={h} onOpen={() => setSel(h)} onAssign={() => setPickerHotel(h)} onSections={() => setSectionsHotel(h)} onDelete={() => setDeleteHotel(h)} />)}
            </div>
          )}

          {pagination && pagination.totalPages > 1 && (
            <div style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginTop: 12,
              padding: '9px 14px', border: `1px solid ${dimWhite(.16)}`, borderRadius: 999,
            }}>
              <span className="mono" style={{ fontSize: 11, color: dimWhite(.7) }}>
                Page {page} / {pagination.totalPages} · {pagination.totalMatching} hotels
              </span>
              <div style={{ display: 'flex', gap: 6 }}>
                <Btn size="sm" variant="ghost" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1} style={{ color: '#fff', borderColor: dimWhite(.25) }}>Prev</Btn>
                <Btn size="sm" variant="ghost" onClick={() => setPage((p) => p + 1)} disabled={!pagination.hasMore} style={{ color: '#fff', borderColor: dimWhite(.25) }}>Next</Btn>
              </div>
            </div>
          )}
        </section>

        {/* Column 2 — Feedback inbox */}
        <section style={{ minWidth: 0 }}>
          <span className="caps" style={{ color: dimWhite(.5) }}>Feedback inbox · {newFeedbackCount} new</span>
          {feedback.length === 0 ? (
            <div style={{ marginTop: 10 }}><DarkEmpty text="No feedback yet." /></div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 10 }}>
              {feedback.map((f) => <FeedbackRow key={f.id} row={f} onChanged={load} />)}
            </div>
          )}
        </section>
      </div>

      {sel && (
        <MapDetail
          h={sel}
          onClose={() => setSel(null)}
          onPickCoverage={() => setPickerHotel(sel)}
          onOpenSections={() => { setSectionsHotel(sel); setSel(null); }}
          onDetached={() => { setSel(null); void load(); }}
          onRequestDelete={() => { setDeleteHotel(sel); setSel(null); }}
        />
      )}

      {pickerHotel && (
        <CoveragePickerModal
          propertyId={pickerHotel.id}
          currentPmsFamily={pickerHotel.pmsType}
          onClose={() => setPickerHotel(null)}
          onAssigned={() => { setPickerHotel(null); void load(); }}
        />
      )}

      {sectionsHotel && (
        <SectionsModal
          propertyId={sectionsHotel.id}
          currentSections={sectionsHotel.enabledSections}
          onClose={() => setSectionsHotel(null)}
          onSaved={() => { setSectionsHotel(null); void load(); }}
        />
      )}

      {addOpen && (
        <AddHotelModal
          onClose={() => setAddOpen(false)}
          onCreated={() => {
            // Reset the fleet view so the freshly-created hotel is actually
            // visible. It's a no-PMS, newest-first row, so an active search, a
            // non-'all' status filter, or page > 1 would hide it — and the
            // success view saying "it's in your fleet" while the list looks
            // unchanged reads as a silent failure (and invites a duplicate).
            setSearchInput('');
            setSearchTerm('');
            setStatusFilter('all');
            setPage(1);
            // Force one refetch off the (now-reset) state — never the stale
            // load() closure. A single fetch with the correct params, no race.
            setReloadNonce((n) => n + 1);
          }}
        />
      )}

      {deleteHotel && (
        <DeleteHotelModal
          h={deleteHotel}
          onClose={() => setDeleteHotel(null)}
          onDeleted={() => { setDeleteHotel(null); void load(); }}
        />
      )}
    </SurfaceShell>
  );
}

// ── Header (eyebrow + serif count + debounced search + status filter) ────
function SurfaceHeader({
  count, searchInput, setSearchInput, statusFilter, setStatusFilter,
}: {
  count: number;
  searchInput: string; setSearchInput: (v: string) => void;
  statusFilter: StatusFilter; setStatusFilter: (v: StatusFilter) => void;
}) {
  return (
    <header style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap', marginBottom: 18 }}>
      <div style={{ minWidth: 0 }}>
        <span className="caps" style={{ color: dimWhite(.55) }}>Live hotels · Fleet map</span>
        <h1 style={{ fontFamily: FONT_SERIF, fontSize: 30, fontWeight: 400, letterSpacing: '-0.02em', margin: '4px 0 0', color: '#fff', whiteSpace: 'nowrap' }}>
          <HeroCount n={count} /> <span style={{ fontStyle: 'italic' }}>hotels live</span>
        </h1>
      </div>
      <Controls searchInput={searchInput} setSearchInput={setSearchInput} statusFilter={statusFilter} setStatusFilter={setStatusFilter} />
    </header>
  );
}

function HeroCount({ n }: { n: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => { countUp(ref.current, 0, n, { dur: 1000, fmt: (v) => String(Math.round(v)) }); }, [n]);
  return <SerifNum size={30} c="#fff"><span ref={ref}>{n}</span></SerifNum>;
}

function Controls({
  searchInput, setSearchInput, statusFilter, setStatusFilter,
}: {
  searchInput: string; setSearchInput: (v: string) => void;
  statusFilter: StatusFilter; setStatusFilter: (v: StatusFilter) => void;
}) {
  const bd = dimWhite(.18);
  const bg = dimWhite(.06);
  return (
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
      {/* Per-hotel access grid (the former Access tab) — left of AI Control
          Center per Reeyen 2026-07-17. */}
      <AccessPopover />
      {/* Fleet-wide, non-CUA AI settings — intentionally left of 2FA. */}
      <AIControlCenter />
      {/* Global 2FA master switch — left of the hotel search. */}
      <TwoFactorSwitch />
      <div style={{ position: 'relative', flex: '1 1 240px', minWidth: 200, maxWidth: 380 }}>
        <span style={{ position: 'absolute', left: 13, top: '50%', transform: 'translateY(-50%)', color: dimWhite(.5), fontSize: 13 }}>⌕</span>
        <input
          type="search"
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          placeholder="Find hotels by name or brand…"
          style={{ width: '100%', boxSizing: 'border-box', padding: '9px 14px 9px 30px', fontSize: 13, border: `1px solid ${bd}`, borderRadius: 999, outline: 'none', background: bg, color: '#fff', fontFamily: 'var(--sans)' }}
        />
      </div>
      <select
        value={statusFilter}
        onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
        style={{ padding: '9px 14px', fontSize: 13, border: `1px solid ${bd}`, borderRadius: 999, background: bg, color: '#fff', outline: 'none', cursor: 'pointer', fontFamily: 'var(--sans)' }}
      >
        {STATUS_OPTS.map(([v, l]) => <option key={v} value={v} style={{ color: '#181611' }}>{l}</option>)}
      </select>
    </div>
  );
}

// ── Fleet-health big number ──────────────────────────────────────────────
function DarkHealth({ label, n, tone }: { label: string; n: number; tone: DotTone }) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => { countUp(ref.current, 0, n, { dur: 1000, fmt: (v) => String(Math.round(v)) }); }, [n]);
  return (
    <div>
      <span className="caps" style={{ color: dimWhite(.45) }}>{label}</span>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 3 }}>
        <Dot tone={tone} size={9} />
        <SerifNum size={30} c="#fff"><span ref={ref}>{n}</span></SerifNum>
      </div>
    </div>
  );
}

// ── Hotel card — single-click flips front/back, double-click → detail ────
function MapCard({ h, onOpen, onAssign, onSections, onDelete }: { h: EnrichedRow; onOpen: () => void; onAssign: () => void; onSections: () => void; onDelete: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [back, setBack] = useState(false);
  const tone = cardTone(h);
  const unassigned = h.pmsType === null;
  const sectionsOff = APP_SECTIONS.filter((s) => h.enabledSections[s] === false).length;
  useEffect(() => {
    const el = ref.current;
    if (el && typeof el.animate === 'function') {
      el.animate([{ opacity: 0, transform: 'scale(.94)' }, { opacity: 1, transform: 'scale(1)' }], { duration: 420, easing: 'cubic-bezier(.16,1,.3,1)', fill: 'both' });
    }
  }, []);
  return (
    <div
      ref={ref}
      role="button"
      tabIndex={0}
      onClick={() => flip(ref.current, () => setBack((b) => !b), { axis: 'Y', dur: 520 })}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); void flip(ref.current, () => setBack((b) => !b), { axis: 'Y', dur: 520 }); } }}
      onDoubleClick={onOpen}
      style={{
        position: 'relative',
        textAlign: 'left', background: dimWhite(.06),
        border: `1px solid ${tone === 'forest' ? dimWhite(.14) : `var(--${tone})`}`,
        borderRadius: 12, padding: '12px 13px', cursor: 'pointer', color: '#fff', minHeight: 78,
      }}
    >
      <button
        onClick={(e) => { e.stopPropagation(); onDelete(); }}
        title="Delete this hotel"
        aria-label={`Delete ${h.name ?? 'this hotel'}`}
        style={{ position: 'absolute', top: 7, right: 9, zIndex: 1, background: 'transparent', border: 'none', padding: '2px 4px', cursor: 'pointer', color: dimWhite(.4), fontFamily: 'var(--sans)', fontSize: 9.5, fontWeight: 700, letterSpacing: '.06em', textTransform: 'uppercase' }}
        onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--terracotta)'; }}
        onMouseLeave={(e) => { e.currentTarget.style.color = dimWhite(.4); }}
      >
        Delete
      </button>
      {!back ? (
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, paddingRight: 44 }}>
            <Dot tone={tone} size={7} />
            <span style={{ fontSize: 12, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{h.name ?? '(unnamed)'}</span>
          </div>
          <div className="mono" style={{ fontSize: 9.5, color: dimWhite(.45), marginTop: 5 }}>{h.totalRooms ?? '—'} rooms · {h.staffCount} staff</div>
          {unassigned ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 7, flexWrap: 'wrap' }}>
              <Pill tone="gold" style={{ fontSize: 9, padding: '2px 6px' }}>No system detected</Pill>
              <Btn
                size="sm"
                variant="ghost"
                onClick={(e) => { e.stopPropagation(); onAssign(); }}
                style={{ color: '#fff', borderColor: dimWhite(.25), fontSize: 9.5, padding: '3px 8px' }}
              >
                Assign coverage
              </Btn>
            </div>
          ) : (
            <div className="mono" style={{ fontSize: 9.5, color: syncColor(h), marginTop: 3 }}>
              {h.pmsConnected ? `${h.pmsType}${h.syncFreshnessMin !== null ? ` · ${freshLabel(h.syncFreshnessMin)}` : ''}` : 'not connected'}
            </div>
          )}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
            <Btn
              size="sm"
              variant="ghost"
              onClick={(e) => { e.stopPropagation(); onSections(); }}
              style={{ color: '#fff', borderColor: dimWhite(.25), fontSize: 9.5, padding: '3px 8px' }}
            >
              Sections
            </Btn>
            <Btn
              size="sm"
              variant="ghost"
              href={`/admin/properties/${h.id}`}
              onClick={(e) => e.stopPropagation()}
              style={{ color: '#fff', borderColor: dimWhite(.25), fontSize: 9.5, padding: '3px 8px' }}
            >
              Property page
            </Btn>
            {sectionsOff > 0 && (
              <Pill tone="terracotta" style={{ fontSize: 9, padding: '2px 6px' }}>{sectionsOff} off</Pill>
            )}
          </div>
        </div>
      ) : (
        <div style={{ transform: 'scaleX(-1)' }}>
          <Pill tone={subTone(h.subscriptionStatus)} style={{ fontSize: 9, padding: '2px 6px' }}>{(h.subscriptionStatus ?? 'unknown').toUpperCase()}</Pill>
          <div className="mono" style={{ fontSize: 9.5, color: dimWhite(.7), marginTop: 7 }}>{h.pmsConnected ? `${h.pmsType} · synced ${freshLabel(h.syncFreshnessMin)} ago` : 'PMS not connected'}</div>
          <div className="mono" style={{ fontSize: 9.5, color: dimWhite(.5), marginTop: 3 }}>double-click → detail</div>
        </div>
      )}
    </div>
  );
}

// ── Delete-hotel confirm (typed-exact-name gate; shared by the card delete
//    control + the detail modal). The server requires the same name match to
//    delete a LIVE hotel, so this is the accident guard for the live customer.
function DeleteHotelModal({ h, onClose, onDeleted }: {
  h: EnrichedRow;
  onClose: () => void;
  onDeleted: () => void;   // delete succeeded → refetch + close
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [confirmText, setConfirmText] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameMatches =
    (h.name ?? '').trim().length > 0 &&
    confirmText.trim().toLowerCase() === (h.name ?? '').trim().toLowerCase();
  useEffect(() => { riseIn(ref.current, { dy: 26, dur: 380 }); }, []);

  const doDelete = async () => {
    if (deleting || !nameMatches) return;
    setDeleting(true);
    setError(null);
    try {
      const res = await fetchWithAuth('/api/admin/properties/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ propertyId: h.id, confirmName: confirmText.trim() }),
      });
      const json = await res.json();
      if (!json.ok) { setError(json.error ?? 'Could not delete this hotel. Please try again.'); return; }
      onDeleted();
    } catch (err) {
      setError(`Network error: ${(err as Error).message}`);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <Backdrop onClose={onClose}>
      <div ref={ref} onClick={(e) => e.stopPropagation()} style={{ ...MODAL_CARD, width: 440 }}>
        <Caps>Delete hotel</Caps>
        <h3 style={{ fontFamily: FONT_SERIF, fontSize: 24, fontWeight: 400, letterSpacing: '-0.02em', margin: '6px 0 10px' }}>
          Permanently delete <span style={{ fontStyle: 'italic' }}>{h.name ?? '(unnamed)'}</span>?
        </h3>
        <p style={{ fontSize: 13, color: 'var(--ink)', lineHeight: 1.5, marginBottom: 12 }}>
          This erases the hotel and <strong>all</strong> its data — rooms, staff, schedules, messages, coverage — and frees the owner’s login. It <strong>cannot be undone</strong>. Type the hotel’s name to confirm.
        </p>
        <input
          autoFocus
          value={confirmText}
          onChange={(e) => setConfirmText(e.target.value)}
          placeholder={h.name ?? 'hotel name'}
          onKeyDown={(e) => { if (e.key === 'Enter' && nameMatches && !deleting) void doDelete(); }}
          style={{ width: '100%', boxSizing: 'border-box', fontSize: 13, padding: '9px 11px', border: '1px solid var(--rule)', borderRadius: 9, background: '#fff', color: 'var(--ink)', outline: 'none', marginBottom: 12 }}
        />
        <div style={{ display: 'flex', gap: 8 }}>
          <Btn variant="terracotta" onClick={doDelete} disabled={!nameMatches || deleting}>
            {deleting ? 'Deleting…' : 'Permanently delete'}
          </Btn>
          <Btn variant="ghost" onClick={onClose} disabled={deleting}>Cancel</Btn>
        </div>
        {error && (
          <div style={{ marginTop: 12, padding: '11px 13px', background: 'var(--terracotta-dim)', border: '1px solid rgba(194,86,46,.3)', borderRadius: 12, color: 'var(--terracotta-deep)', fontSize: 12.5, lineHeight: 1.45 }}>
            {error}
          </div>
        )}
      </div>
    </Backdrop>
  );
}

// ── Hotel detail modal (light card on blurred ink) ───────────────────────
function MapDetail({ h, onClose, onPickCoverage, onOpenSections, onDetached, onRequestDelete }: {
  h: EnrichedRow;
  onClose: () => void;
  onPickCoverage: () => void;   // opens CoveragePickerModal (assign or switch)
  onOpenSections: () => void;   // opens SectionsModal for this hotel
  onDetached: () => void;       // detach succeeded → refetch + close
  onRequestDelete: () => void;  // open the shared DeleteHotelModal for this hotel
}) {
  const ref = useRef<HTMLDivElement>(null);
  const hasSystem = h.pmsType !== null;
  const [detaching, setDetaching] = useState(false);
  const [detachError, setDetachError] = useState<string | null>(null);
  useEffect(() => { riseIn(ref.current, { dy: 26, dur: 440 }); }, []);

  // Detach this hotel from its current coverage. Mirrors the FeedbackRow
  // fetch+envelope+busy pattern: POST through fetchWithAuth, read { ok }, and
  // on success let the parent refetch (load()) and close the modal.
  const detach = async () => {
    if (detaching || !hasSystem) return;
    setDetaching(true);
    setDetachError(null);
    try {
      const res = await fetchWithAuth('/api/admin/coverage/detach', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pmsFamily: h.pmsType, propertyId: h.id }),
      });
      const json = await res.json();
      if (!json.ok) {
        setDetachError(json.error ?? 'Could not detach coverage. Please try again.');
        return;
      }
      onDetached();
    } catch (err) {
      setDetachError(`Network error: ${(err as Error).message}`);
    } finally {
      setDetaching(false);
    }
  };

  return (
    <Backdrop onClose={onClose}>
      <div ref={ref} onClick={(e) => e.stopPropagation()} style={{ ...MODAL_CARD, width: 460 }}>
        <Caps>{h.pmsConnected ? (h.pmsType ?? 'PMS') : 'No PMS'}</Caps>
        <h3 style={{ fontFamily: FONT_SERIF, fontSize: 26, fontWeight: 400, letterSpacing: '-0.02em', margin: '6px 0 12px' }}>
          <span style={{ fontStyle: 'italic' }}>{h.name ?? '(unnamed)'}</span>
        </h3>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 10, marginBottom: 14 }}>
          <Stat label="Rooms" v={h.totalRooms ?? '—'} />
          <Stat label="Staff" v={h.staffCount} />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
          <Pill tone={hasSystem ? subTone(h.subscriptionStatus) : 'gold'}>
            {hasSystem ? (h.subscriptionStatus ?? 'unknown').toUpperCase() : 'NO SYSTEM DETECTED'}
          </Pill>
          <span className="mono" style={{ fontSize: 11, color: syncColor(h) }}>
            {h.pmsConnected ? `${h.pmsType}${h.syncFreshnessMin !== null ? ` · synced ${freshLabel(h.syncFreshnessMin)} ago` : ''}` : hasSystem ? 'PMS not connected' : 'No coverage assigned'}
          </span>
        </div>

        {/* Coverage actions — attach (no system) / switch + detach (has system) */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: detachError ? 10 : 16, flexWrap: 'wrap' }}>
          {hasSystem ? (
            <>
              <Btn variant="ghost" onClick={onPickCoverage} disabled={detaching}>Switch coverage</Btn>
              <Btn variant="terracotta" onClick={detach} disabled={detaching}>
                {detaching ? 'Detaching…' : 'Detach'}
              </Btn>
            </>
          ) : (
            <Btn variant="forest" onClick={onPickCoverage}>Assign coverage</Btn>
          )}
        </div>
        {detachError && (
          <div style={{ padding: '11px 13px', marginBottom: 16, background: 'var(--terracotta-dim)', border: '1px solid rgba(194,86,46,.3)', borderRadius: 12, color: 'var(--terracotta-deep)', fontSize: 12.5, lineHeight: 1.45 }}>
            {detachError}
          </div>
        )}

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Btn
            variant="forest"
            onClick={() => {
              localStorage.setItem('hotelops-active-property', h.id);
              window.location.href = '/home';
            }}
          >
            Open hotel →
          </Btn>
          <Btn variant="primary" href={`/admin/properties/${h.id}`}>Property page →</Btn>
          <Btn variant="ghost" onClick={onOpenSections}>
            Sections{APP_SECTIONS.filter((s) => h.enabledSections[s] === false).length > 0 ? ` · ${APP_SECTIONS.filter((s) => h.enabledSections[s] === false).length} off` : ''}
          </Btn>
          <Btn variant="ghost" onClick={onClose}>Close</Btn>
        </div>

        {/* Danger zone — opens the shared typed-name delete confirm. */}
        <div style={{ marginTop: 16, paddingTop: 14, borderTop: '1px solid var(--rule)' }}>
          <button
            onClick={onRequestDelete}
            style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--terracotta-deep)', fontFamily: 'var(--sans)', fontSize: 12, fontWeight: 600, textDecoration: 'underline' }}
          >
            Delete this hotel…
          </button>
        </div>
      </div>
    </Backdrop>
  );
}

function Stat({ label, v, c }: { label: string; v: React.ReactNode; c?: string }) {
  return (
    <div style={{ background: 'var(--rule-soft)', borderRadius: 10, padding: '10px 12px' }}>
      <Caps size={9}>{label}</Caps>
      <div style={{ marginTop: 2 }}><SerifNum size={24} c={c || 'var(--ink)'}>{v}</SerifNum></div>
    </div>
  );
}


// ── Feedback inbox card — flip on status set, real PATCH + refetch ───────
function FeedbackRow({ row, onChanged }: { row: FeedbackItem; onChanged: () => Promise<void> }) {
  const ref = useRef<HTMLDivElement>(null);
  const [updating, setUpdating] = useState(false);
  const open = row.status !== 'resolved' && row.status !== 'wontfix';

  const setStatus = async (status: string) => {
    if (updating) return;
    setUpdating(true);
    // Flip the card as the gesture; the real mutation + refetch run at the
    // halfway point so the swapped face shows fresh server state.
    await flip(ref.current, async () => {
      try {
        await fetchWithAuth('/api/admin/feedback', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: row.id, status }),
        });
        await onChanged();
      } finally {
        setUpdating(false);
      }
    }, { axis: 'X', dur: 480 });
  };

  return (
    <div ref={ref} style={{ background: dimWhite(.05), border: `1px solid ${row.status === 'new' ? 'rgba(201,154,46,.45)' : dimWhite(.12)}`, borderRadius: 13, padding: '13px 15px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <span className="mono" style={{ fontSize: 10, color: dimWhite(.55) }}>{CAT[row.category] ?? '○ note'}</span>
        <span style={{ fontSize: 12.5, fontWeight: 600, color: '#fff', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{row.user_display_name ?? row.user_email ?? 'Anonymous'}</span>
        {row.property_name && <span style={{ fontFamily: FONT_SERIF, fontStyle: 'italic', fontSize: 12, color: dimWhite(.45), overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>· {row.property_name}</span>}
        <Pill tone={fbTone(row.status)} style={{ marginLeft: 'auto', fontSize: 9.5, padding: '2px 7px' }}>{row.status.replace('_', ' ').toUpperCase()}</Pill>
      </div>
      <div style={{ fontSize: 12.5, color: dimWhite(.75), lineHeight: 1.5, marginBottom: open ? 10 : 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{row.message}</div>
      {open && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {row.status === 'new' && <Btn size="sm" variant="ghost" onClick={() => setStatus('in_progress')} disabled={updating} style={{ color: '#fff', borderColor: dimWhite(.25) }}>Mark in progress</Btn>}
          <Btn size="sm" variant="forest" onClick={() => setStatus('resolved')} disabled={updating}>Resolve</Btn>
          <Btn size="sm" variant="ghost" onClick={() => setStatus('wontfix')} disabled={updating} style={{ color: '#fff', borderColor: dimWhite(.25) }}>Won&apos;t fix</Btn>
        </div>
      )}
    </div>
  );
}
