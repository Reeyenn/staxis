'use client';

/**
 * MapsManager — the robot's learned PMS maps + the controls to manage them,
 * as an embeddable modal. Lives INSIDE the admin Onboarding "Launch bay"
 * (OnboardingSurface), launched from the "PMS coverage" column, so there's no
 * separate Live Mapper page/tab — the map controls live next to the coverage
 * that shows which PMS has a map.
 *
 * Every map, grouped by PMS brand, with which one is LIVE plus hard-to-misclick
 * promote / roll back / take offline / delete controls. All reads + writes go
 * through the admin-gated /api/admin/live-mapper/* routes (pms_knowledge_files
 * is service-role-only), so the browser never touches the DB directly and never
 * sees the raw map JSON or the HMAC signature value. Every mutating action is
 * funneled through a confirm dialog that names the brand + version and spells
 * out the consequence; the live map can't be deleted (route 409s, UI hides it).
 *
 * Renders inside the dark studio context (OnboardingSurface), so it does NOT
 * import studio.css or wrap in AppLayout — the parent provides both.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { fetchWithAuth } from '@/lib/api-fetch';
import { RefreshCw, Map as MapIcon, AlertTriangle, X, ChevronRight, ChevronDown, ExternalLink, Layers } from 'lucide-react';
import { FONT_SERIF, FONT_MONO, Caps, Pill, Dot, Btn } from '@/app/admin/_components/studio/kit';
import { Backdrop, MODAL_CARD } from '@/app/admin/_components/studio/surface-kit';

const dim = (a: number) => `rgba(255,255,255,${a})`;

interface MapView {
  id: string;
  pmsFamily: string;
  version: number;
  status: string;
  feedsCovered: string[];
  feedsTotal: number;
  learnedAt: string;
  promotedToActiveAt: string | null;
  deprecatedAt: string | null;
  createdBy: string;
  notes: string | null;
  signed: boolean;
}

interface FamilyGroup {
  family: string;
  label: string;
  activeCount: number;
  maps: MapView[];
}

type ActionKind = 'promote' | 'deprecate' | 'delete';

interface PendingAction {
  kind: ActionKind;
  map: MapView;
  label: string;
}

// ── Per-feed (M1 /api/admin/live-mapper/feeds) ────────────────────────────
interface FeedView {
  key: string;
  actionKey: string | null;
  label: string;
  table: string | null;
  columns: Record<string, string>;
  required: boolean;
  learnable: boolean;
  drilldown: boolean;
  canTakeover: boolean;
  rowCount: number | null;
  source: 'actions' | 'legacy';
}

interface FeedsPayload {
  pmsFamily: string;
  propertyId: string | null;
  mapVersion: number | null;
  editable: boolean;
  shape: 'actions' | 'legacy' | 'empty';
  feeds: FeedView[];
}

// Per-family expander state for the "Show feeds" panel.
interface FeedsState {
  open: boolean;
  loading: boolean;
  error: string | null;
  data: FeedsPayload | null;
  /** Which feed's columns are expanded (View). */
  viewing: string | null;
  /** A delete confirm/poll in flight, keyed by the feed being deleted. */
  pendingDelete: FeedView | null;
  deleteBusy: boolean;
  deleteError: string | null;
}

const EMPTY_FEEDS_STATE: FeedsState = {
  open: false, loading: false, error: null, data: null,
  viewing: null, pendingDelete: null, deleteBusy: false, deleteError: null,
};

const FEED_LABEL: Record<string, string> = {
  dashboard_counts: 'Dashboard',
  arrivals_departures: 'Arrivals/Departures',
  room_status: 'Room status',
  housekeeping: 'Housekeeping',
  work_orders: 'Work orders',
};

const ACTION_ENDPOINT: Record<ActionKind, string> = {
  promote: '/api/admin/live-mapper/promote',
  deprecate: '/api/admin/live-mapper/deprecate',
  delete: '/api/admin/live-mapper/delete',
};

function ago(iso: string | null): string {
  if (!iso) return '—';
  const min = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (!isFinite(min)) return '—';
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

function StatusPill({ status }: { status: string }) {
  switch (status) {
    case 'active':
      return <Pill tone="forest"><Dot tone="forest" size={6} /> LIVE</Pill>;
    case 'draft':
      return <Pill tone="teal">Draft</Pill>;
    case 'deprecated':
      return <Pill tone="neutral">Retired</Pill>;
    case 'quarantined':
      return <Pill tone="terracotta">Quarantined</Pill>;
    default:
      return <Pill tone="neutral">{status}</Pill>;
  }
}

function Empty({ text }: { text: string }) {
  return (
    <div style={{ padding: '24px 16px', textAlign: 'center', border: `1px dashed ${dim(.16)}`, borderRadius: 12, color: dim(.42), fontFamily: FONT_SERIF, fontStyle: 'italic', fontSize: 13.5 }}>
      {text}
    </div>
  );
}

// ── One map version row inside a family card ──────────────────────────────
function MapRow({ map, label, first, onAction }: { map: MapView; label: string; first: boolean; onAction: (a: PendingAction) => void }) {
  const coveredLabels = map.feedsCovered.map((f) => FEED_LABEL[f] ?? f);
  const isActive = map.status === 'active';
  const promotable = map.status === 'draft' || map.status === 'deprecated';
  return (
    <div style={{ padding: '13px 16px', borderTop: first ? undefined : `1px solid ${dim(.07)}`, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ fontFamily: FONT_MONO, fontSize: 13, fontWeight: 700, color: '#fff' }}>v{map.version}</span>
        <StatusPill status={map.status} />
        {map.signed
          ? <Caps size={9} c="var(--forest)" style={{ letterSpacing: '.12em' }}>signed</Caps>
          : <Caps size={9} c="var(--gold)" style={{ letterSpacing: '.12em' }}>unsigned</Caps>}
        <span style={{ flex: 1 }} />
        <span style={{ fontFamily: FONT_MONO, fontSize: 10.5, color: dim(.45) }} title={map.learnedAt}>learned {ago(map.learnedAt)}</span>
      </div>

      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 11.5, fontWeight: 600, color: map.feedsCovered.length === map.feedsTotal ? 'var(--forest)' : dim(.62) }}>
          {map.feedsCovered.length}/{map.feedsTotal} feeds
        </span>
        <span style={{ fontSize: 11, color: dim(.42) }}>{coveredLabels.length ? coveredLabels.join(' · ') : 'none captured'}</span>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', fontFamily: FONT_MONO, fontSize: 10, color: dim(.38) }}>
        <span>by {map.createdBy}</span>
        {isActive && map.promotedToActiveAt && <span title={map.promotedToActiveAt}>live since {ago(map.promotedToActiveAt)}</span>}
      </div>

      {map.notes && <div style={{ fontSize: 12, color: dim(.55), fontStyle: 'italic', lineHeight: 1.5 }}>{map.notes}</div>}

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 2 }}>
        {isActive && (
          <Btn size="sm" variant="terracotta" onClick={() => onAction({ kind: 'deprecate', map, label })}>Take offline</Btn>
        )}
        {promotable && (
          <Btn size="sm" variant="forest" onClick={() => onAction({ kind: 'promote', map, label })}>
            {map.status === 'draft' ? 'Make live' : 'Make live again'}
          </Btn>
        )}
        {!isActive && (
          <Btn size="sm" variant="ghost" onClick={() => onAction({ kind: 'delete', map, label })} style={{ color: 'var(--terracotta)', borderColor: 'rgba(194,86,46,.3)' }}>Delete</Btn>
        )}
      </div>
    </div>
  );
}

// ── Confirm dialog — light card on the studio's blurred ink backdrop ──────
function ConfirmDialog({ action, busy, error, onCancel, onConfirm }: {
  action: PendingAction; busy: boolean; error: string | null; onCancel: () => void; onConfirm: () => void;
}) {
  const { kind, map, label } = action;
  const name = `${label} v${map.version}`;

  let title = '';
  let body: React.ReactNode = null;
  let confirmLabel = '';
  let confirmVariant: 'forest' | 'terracotta' = 'forest';

  if (kind === 'promote') {
    title = `Make ${name} the live map?`;
    body = (
      <>
        Every <b>{label}</b> hotel’s robot will switch to this map
        {map.status === 'deprecated' ? ', rolling back to this earlier version' : ''}.
        {!map.signed && (
          <span style={{ display: 'flex', gap: 7, alignItems: 'flex-start', marginTop: 12, padding: '9px 11px', borderRadius: 10, background: 'rgba(201,154,46,.12)', border: '1px solid rgba(201,154,46,.4)', color: 'var(--gold-deep)', fontSize: 12.5 }}>
            <AlertTriangle size={15} style={{ flexShrink: 0, marginTop: 1 }} />
            <span>This map isn’t signed. If the robot’s signature check is switched on, it may refuse to load it.</span>
          </span>
        )}
      </>
    );
    confirmLabel = 'Make live';
    confirmVariant = 'forest';
  } else if (kind === 'deprecate') {
    title = `Take ${name} offline?`;
    body = (
      <>
        <b>{label}</b> will have <b>no live map</b>. Every {label} hotel the robot runs will pause until you make a map live again.
      </>
    );
    confirmLabel = 'Take offline';
    confirmVariant = 'terracotta';
  } else {
    title = `Delete ${name}?`;
    body = (
      <>
        This permanently removes the {map.status === 'draft' ? 'draft ' : ''}map. This can’t be undone.
      </>
    );
    confirmLabel = 'Delete';
    confirmVariant = 'terracotta';
  }

  return (
    <Backdrop onClose={busy ? () => {} : onCancel}>
      <div onClick={(e) => e.stopPropagation()} style={{ ...MODAL_CARD, width: 460 }}>
        <h3 style={{ fontFamily: FONT_SERIF, fontSize: 21, fontWeight: 500, margin: '0 0 10px', color: 'var(--ink)', lineHeight: 1.25 }}>{title}</h3>
        <div style={{ fontSize: 13.5, color: 'var(--ink-soft)', lineHeight: 1.6 }}>{body}</div>

        {error && (
          <div style={{ marginTop: 14, borderRadius: 10, border: '1px solid rgba(194,86,46,.4)', background: 'rgba(194,86,46,.08)', padding: '9px 12px', fontSize: 12.5, color: 'var(--terracotta-deep)' }}>
            {error}
          </div>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 22 }}>
          <Btn size="md" variant="ghost" onClick={onCancel} disabled={busy}>Cancel</Btn>
          <Btn size="md" variant={confirmVariant} onClick={onConfirm} disabled={busy}>{busy ? 'Working…' : confirmLabel}</Btn>
        </div>
      </div>
    </Backdrop>
  );
}

// ── Delete-feed confirm — family-scoped copy (the recipe drives EVERY hotel
//    on this PMS family, not one hotel). ───────────────────────────────────
function DeleteFeedDialog({ feed, familyLabel, busy, error, onCancel, onConfirm }: {
  feed: FeedView; familyLabel: string; busy: boolean; error: string | null;
  onCancel: () => void; onConfirm: () => void;
}) {
  return (
    <Backdrop onClose={busy ? () => {} : onCancel}>
      <div onClick={(e) => e.stopPropagation()} style={{ ...MODAL_CARD, width: 480 }}>
        <h3 style={{ fontFamily: FONT_SERIF, fontSize: 21, fontWeight: 500, margin: '0 0 10px', color: 'var(--ink)', lineHeight: 1.25 }}>
          Remove the {feed.label} feed?
        </h3>
        <div style={{ fontSize: 13.5, color: 'var(--ink-soft)', lineHeight: 1.6 }}>
          This map is shared by <b>every {familyLabel} hotel</b>. Removing this feed
          re-publishes the map and the robot will <b>stop capturing {feed.label}</b> for{' '}
          <b>all {familyLabel} hotels</b> — not just one. The robot keeps every other feed.
          You can add it back later with Edit.
        </div>

        {error && (
          <div style={{ marginTop: 14, borderRadius: 10, border: '1px solid rgba(194,86,46,.4)', background: 'rgba(194,86,46,.08)', padding: '9px 12px', fontSize: 12.5, color: 'var(--terracotta-deep)' }}>
            {error}
          </div>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 22 }}>
          <Btn size="md" variant="ghost" onClick={onCancel} disabled={busy}>Cancel</Btn>
          <Btn size="md" variant="terracotta" onClick={onConfirm} disabled={busy}>
            {busy ? 'Removing…' : `Remove for all ${familyLabel} hotels`}
          </Btn>
        </div>
      </div>
    </Backdrop>
  );
}

// ── One feed row inside the "Show feeds" panel ────────────────────────────
function FeedRow({ feed, editable, onView, viewing, onEdit, onDelete }: {
  feed: FeedView; editable: boolean; onView: () => void; viewing: boolean;
  onEdit: () => void; onDelete: () => void;
}) {
  const columnNames = Object.keys(feed.columns);
  return (
    <div style={{ padding: '11px 14px', borderTop: `1px solid ${dim(.07)}`, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: '#fff' }}>{feed.label}</span>
        {feed.required && <Caps size={9} c="var(--gold)" style={{ letterSpacing: '.1em' }}>core feed</Caps>}
        {feed.drilldown && <Caps size={9} c={dim(.45)} style={{ letterSpacing: '.1em' }}>drill-down</Caps>}
        <span style={{ flex: 1 }} />
        {feed.rowCount != null && (
          <span style={{ fontFamily: FONT_MONO, fontSize: 10.5, color: dim(.45) }} title="rows captured for the sample hotel">
            {feed.rowCount.toLocaleString()} rows
          </span>
        )}
      </div>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        {/* View — toggles the learned columns. Disabled when none parsed. */}
        <Btn
          size="sm"
          variant="ghost"
          onClick={onView}
          disabled={columnNames.length === 0}
          style={{ color: '#fff', borderColor: dim(.22) }}
          title={columnNames.length === 0 ? 'No column detail to show for this feed' : undefined}
        >
          {viewing ? <ChevronDown size={13} style={{ marginRight: 4 }} /> : <ChevronRight size={13} style={{ marginRight: 4 }} />}
          {columnNames.length === 0 ? 'No detail' : `View ${columnNames.length} ${columnNames.length === 1 ? 'column' : 'columns'}`}
        </Btn>

        {/* Edit — re-point this feed via founder takeover (opens the board in a
            new tab). Only when the map is editable and the feed is takeover-able. */}
        {editable && feed.canTakeover && (
          <Btn size="sm" variant="forest" onClick={onEdit}>
            Edit <ExternalLink size={12} style={{ marginLeft: 4 }} />
          </Btn>
        )}

        {/* Delete — HIDDEN for required (core) feeds. Family-scoped confirm. */}
        {editable && !feed.required && (
          <Btn size="sm" variant="ghost" onClick={onDelete} style={{ color: 'var(--terracotta)', borderColor: 'rgba(194,86,46,.3)' }}>
            Delete
          </Btn>
        )}
      </div>

      {viewing && columnNames.length > 0 && (
        <div style={{ marginTop: 2, borderRadius: 10, border: `1px solid ${dim(.1)}`, background: dim(.03), padding: '9px 12px', display: 'flex', flexDirection: 'column', gap: 5 }}>
          {columnNames.map((name) => (
            <div key={name} style={{ display: 'flex', gap: 10, alignItems: 'baseline', fontFamily: FONT_MONO, fontSize: 11 }}>
              <span style={{ color: '#fff', fontWeight: 600, minWidth: 110, flexShrink: 0 }}>{name}</span>
              <span style={{ color: dim(.5), wordBreak: 'break-all' }}>{feed.columns[name]}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── The "Show feeds" panel for ONE family's live map ──────────────────────
function FeedsPanel({ familyLabel, state, onView, onEdit, onDelete }: {
  familyLabel: string;
  state: FeedsState;
  onView: (feedKey: string) => void;
  onEdit: (feed: FeedView) => void;
  onDelete: (feed: FeedView) => void;
}) {
  if (state.loading && !state.data) {
    return <div style={{ padding: '14px 16px', fontSize: 12.5, color: dim(.5) }}>Loading feeds…</div>;
  }
  if (state.error) {
    return (
      <div style={{ margin: '12px 14px', borderRadius: 10, border: '1px solid rgba(194,86,46,.4)', background: 'rgba(194,86,46,.08)', padding: '9px 12px', fontSize: 12.5, color: '#f0b8a6' }}>
        {state.error}
      </div>
    );
  }
  const data = state.data;
  if (!data) return null;

  if (data.feeds.length === 0) {
    return (
      <div style={{ padding: '14px 16px', fontSize: 12.5, color: dim(.5), fontStyle: 'italic' }}>
        This family has no live map yet — there are no feeds to manage.
      </div>
    );
  }

  return (
    <div>
      {!data.editable && (
        <div style={{ margin: '12px 14px 4px', borderRadius: 10, border: '1px solid rgba(201,154,46,.4)', background: 'rgba(201,154,46,.12)', padding: '9px 12px', fontSize: 12, color: 'var(--gold)', display: 'flex', gap: 7, alignItems: 'flex-start' }}>
          <AlertTriangle size={14} style={{ flexShrink: 0, marginTop: 1 }} />
          <span>This is an older-style map. Re-learn this PMS once to turn on editing and deleting individual feeds.</span>
        </div>
      )}
      {data.feeds.map((f) => (
        <FeedRow
          key={f.key}
          feed={f}
          editable={data.editable}
          viewing={state.viewing === f.key}
          onView={() => onView(f.key)}
          onEdit={() => onEdit(f)}
          onDelete={() => onDelete(f)}
        />
      ))}
    </div>
  );
}

/**
 * The maps manager as a modal. Launched from the PMS coverage column header in
 * OnboardingSurface. Renders nothing when `open` is false.
 */
export function MapsManagerModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [families, setFamilies] = useState<FamilyGroup[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [pending, setPending] = useState<PendingAction | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchWithAuth('/api/admin/live-mapper/maps');
      const json = await res.json();
      if (!res.ok || !json.ok) {
        setError(json.error ?? `Request failed (${res.status})`);
        return;
      }
      setFamilies((json.data?.families as FamilyGroup[]) ?? []);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  const runAction = useCallback(async () => {
    if (!pending) return;
    setActionBusy(true);
    setActionError(null);
    try {
      const res = await fetchWithAuth(ACTION_ENDPOINT[pending.kind], {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Bind the action to the exact map version + status the admin saw and
        // confirmed — the server refuses if the row changed underneath us.
        body: JSON.stringify({ id: pending.map.id, expectedVersion: pending.map.version, expectedStatus: pending.map.status }),
      });
      const json = await res.json();
      if (!res.ok || !json.ok) {
        setActionError(json.error ?? `Request failed (${res.status})`);
        return;
      }
      setPending(null);
      await load();
    } catch (err) {
      setActionError((err as Error).message);
    } finally {
      setActionBusy(false);
    }
  }, [pending, load]);

  // ── Per-family "Show feeds" expander state, keyed by pms_family ──────────
  const [feedsByFamily, setFeedsByFamily] = useState<Record<string, FeedsState>>({});

  const patchFeeds = useCallback((family: string, patch: Partial<FeedsState>) => {
    setFeedsByFamily((prev) => ({
      ...prev,
      [family]: { ...(prev[family] ?? EMPTY_FEEDS_STATE), ...patch },
    }));
  }, []);

  const loadFeeds = useCallback(async (family: string) => {
    patchFeeds(family, { loading: true, error: null });
    try {
      const res = await fetchWithAuth(`/api/admin/live-mapper/feeds?pmsFamily=${encodeURIComponent(family)}`);
      const json = await res.json();
      if (!res.ok || !json.ok) {
        patchFeeds(family, { loading: false, error: json.error ?? `Request failed (${res.status})` });
        return;
      }
      patchFeeds(family, { loading: false, error: null, data: json.data as FeedsPayload });
    } catch (err) {
      patchFeeds(family, { loading: false, error: (err as Error).message });
    }
  }, [patchFeeds]);

  const toggleFeeds = useCallback((family: string) => {
    const cur = feedsByFamily[family] ?? EMPTY_FEEDS_STATE;
    if (cur.open) {
      patchFeeds(family, { open: false });
      return;
    }
    patchFeeds(family, { open: true });
    // (Re)fetch on open so counts/columns are fresh each time.
    void loadFeeds(family);
  }, [feedsByFamily, patchFeeds, loadFeeds]);

  // Edit a single feed → reuse POST /api/admin/mapper/coverage/edit-feed with the
  // representative property, then open the returned board URL in a NEW TAB so the
  // founder drives the takeover without losing this modal.
  const editFeed = useCallback(async (family: string, feed: FeedView) => {
    const state = feedsByFamily[family];
    const propertyId = state?.data?.propertyId ?? null;
    const targetKey = feed.actionKey ?? feed.key;
    if (!propertyId) {
      patchFeeds(family, { error: 'No hotel session on this PMS to drive the edit. Connect a hotel first.' });
      return;
    }
    try {
      const res = await fetchWithAuth('/api/admin/mapper/coverage/edit-feed', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pmsFamily: family, propertyId, targetKey, mode: 'edit' }),
      });
      const json = await res.json();
      if (!res.ok || !json.ok) {
        patchFeeds(family, { error: json.error ?? `Could not start the edit (${res.status})` });
        return;
      }
      const boardUrl = json.data?.boardUrl as string | undefined;
      if (boardUrl) window.open(boardUrl, '_blank', 'noopener,noreferrer');
    } catch (err) {
      patchFeeds(family, { error: (err as Error).message });
    }
  }, [feedsByFamily, patchFeeds]);

  // Delete a single feed → reuse POST /api/admin/mapper/coverage/delete-feed,
  // then poll GET /api/admin/mapper/live/[jobId] until the worker re-publishes
  // the map, and refresh the feed list.
  const runDeleteFeed = useCallback(async (family: string) => {
    const state = feedsByFamily[family];
    const feed = state?.pendingDelete;
    const propertyId = state?.data?.propertyId ?? null;
    if (!feed) return;
    const targetKey = feed.actionKey ?? feed.key;
    if (!propertyId) {
      patchFeeds(family, { deleteError: 'No hotel session on this PMS to re-publish the map.' });
      return;
    }
    patchFeeds(family, { deleteBusy: true, deleteError: null });
    try {
      const res = await fetchWithAuth('/api/admin/mapper/coverage/delete-feed', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pmsFamily: family, propertyId, targetKey }),
      });
      const json = await res.json();
      if (!res.ok || !json.ok) {
        patchFeeds(family, { deleteBusy: false, deleteError: json.error ?? `Could not remove the feed (${res.status})` });
        return;
      }
      const jobId = json.data?.jobId as string | undefined;
      if (!jobId) {
        patchFeeds(family, { deleteBusy: false, deleteError: 'The server did not return a job to track.' });
        return;
      }
      // Poll the job until terminal (~up to 60s; the re-sign is a fast non-browser job).
      const deadline = Date.now() + 60_000;
      let finalState: 'completed' | 'failed' | 'cancelled' | 'timeout' = 'timeout';
      let jobErr: string | null = null;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 2000));
        try {
          const pollRes = await fetchWithAuth(`/api/admin/mapper/live/${jobId}`);
          const pollJson = await pollRes.json();
          if (pollRes.ok && pollJson.ok) {
            const status = pollJson.data?.job?.status as string | undefined;
            if (status === 'completed') { finalState = 'completed'; break; }
            if (status === 'failed' || status === 'cancelled') {
              finalState = status;
              jobErr = (pollJson.data?.job?.error as string | undefined) ?? null;
              break;
            }
          }
        } catch {
          // transient — keep polling until the deadline
        }
      }
      if (finalState === 'completed') {
        patchFeeds(family, { deleteBusy: false, pendingDelete: null, deleteError: null, viewing: null });
        await loadFeeds(family);
        await load(); // refresh the version list (a new version was published)
      } else if (finalState === 'timeout') {
        patchFeeds(family, { deleteBusy: false, deleteError: 'Still working — the map is taking longer than expected. Close and reopen feeds in a moment to check.' });
      } else {
        patchFeeds(family, { deleteBusy: false, deleteError: jobErr ?? `The map could not be re-published (${finalState}).` });
      }
    } catch (err) {
      patchFeeds(family, { deleteBusy: false, deleteError: (err as Error).message });
    }
  }, [feedsByFamily, patchFeeds, loadFeeds, load]);

  if (!open) return null;

  const totalMaps = families.reduce((n, f) => n + f.maps.length, 0);

  return (
    <Backdrop onClose={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="admin-studio"
        style={{
          width: 'min(720px, 94vw)', maxHeight: '88vh', overflowY: 'auto',
          background: 'var(--ink)', color: '#fff',
          border: `1px solid ${dim(.14)}`, borderRadius: 16,
          padding: '22px 24px 28px', position: 'relative',
          boxShadow: '0 24px 70px rgba(0,0,0,.5)',
        }}
      >
        <div style={{ position: 'absolute', inset: 0, borderRadius: 16, background: 'radial-gradient(120% 60% at 100% 0%, rgba(60,156,104,.12), transparent 55%)', pointerEvents: 'none' }} />
        <div style={{ position: 'relative' }}>
          <header style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, marginBottom: 18 }}>
            <div>
              <Caps style={{ color: dim(.5) }}>PMS coverage · Robot brains</Caps>
              <h2 style={{ fontFamily: FONT_SERIF, fontSize: 24, fontWeight: 400, letterSpacing: '-0.02em', margin: '4px 0 0', color: '#fff', display: 'flex', alignItems: 'center', gap: 10 }}>
                <MapIcon size={22} style={{ color: 'var(--forest)' }} /> The maps the robot <span style={{ fontStyle: 'italic' }}>has learned</span>
              </h2>
              <p style={{ fontSize: 12.5, color: dim(.55), margin: '8px 0 0', maxWidth: 560, lineHeight: 1.55 }}>
                One map per PMS brand drives every hotel on it. Promote a draft to go live, roll back, take a brand offline, or delete an old map. The live map can’t be deleted — take it offline first.
              </p>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Btn variant="ghost" size="sm" onClick={() => void load()} style={{ color: '#fff', borderColor: dim(.3), background: dim(.06) }}>
                <RefreshCw size={13} style={{ marginRight: 5 }} className={loading ? 'animate-spin' : undefined} /> Refresh
              </Btn>
              <button aria-label="Close" onClick={onClose} style={{ width: 30, height: 30, borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center', background: dim(.06), border: `1px solid ${dim(.16)}`, color: '#fff', cursor: 'pointer' }}>
                <X size={16} />
              </button>
            </div>
          </header>

          {error && (
            <div style={{ marginBottom: 18, borderRadius: 12, border: '1px solid rgba(194,86,46,.42)', background: 'rgba(194,86,46,.10)', padding: '11px 14px', fontSize: 13, color: '#f0b8a6' }}>
              {error}
            </div>
          )}

          {totalMaps === 0 && !loading && !error ? (
            <Empty text="No maps learned yet — the robot writes one here the first time it maps a PMS." />
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              {families.map((fam) => {
                const live = fam.maps.find((m) => m.status === 'active');
                const fs = feedsByFamily[fam.family] ?? EMPTY_FEEDS_STATE;
                return (
                  <div key={fam.family} style={{ background: dim(.04), border: `1px solid ${dim(.12)}`, borderRadius: 14, overflow: 'hidden' }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '12px 16px', borderBottom: `1px solid ${dim(.08)}`, background: dim(.03) }}>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontSize: 14.5, fontWeight: 600, color: '#fff' }}>{fam.label}</div>
                        <div style={{ fontFamily: FONT_MONO, fontSize: 10, color: dim(.4), letterSpacing: '.03em', marginTop: 1 }}>
                          {fam.family} · {fam.maps.length} {fam.maps.length === 1 ? 'version' : 'versions'}
                        </div>
                      </div>
                      {live
                        ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11.5, fontWeight: 600, color: 'var(--forest)', whiteSpace: 'nowrap' }}><Dot tone="forest" size={7} /> Live · v{live.version}</span>
                        : <Pill tone="gold">No live map</Pill>}
                    </div>
                    {fam.maps.map((m, idx) => (
                      <MapRow key={m.id} map={m} label={fam.label} first={idx === 0} onAction={(a) => { setActionError(null); setPending(a); }} />
                    ))}

                    {/* Per-feed VIEW / EDIT / DELETE — only the LIVE map's feeds
                        are manageable here, so the expander is only offered when
                        the family has a live map. */}
                    {live && (
                      <div style={{ borderTop: `1px solid ${dim(.08)}`, background: dim(.02) }}>
                        <button
                          type="button"
                          onClick={() => toggleFeeds(fam.family)}
                          style={{
                            width: '100%', display: 'flex', alignItems: 'center', gap: 8,
                            padding: '11px 16px', background: 'transparent', border: 'none',
                            color: dim(.72), fontSize: 12, fontWeight: 600, cursor: 'pointer', textAlign: 'left',
                          }}
                        >
                          {fs.open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                          <Layers size={13} style={{ color: 'var(--forest)' }} />
                          {fs.open ? 'Hide feeds' : 'Show feeds'}
                          <span style={{ fontFamily: FONT_MONO, fontSize: 10, color: dim(.4), fontWeight: 400 }}>
                            view / edit / delete each feed
                          </span>
                        </button>
                        {fs.open && (
                          <FeedsPanel
                            familyLabel={fam.label}
                            state={fs}
                            onView={(feedKey) => patchFeeds(fam.family, { viewing: fs.viewing === feedKey ? null : feedKey })}
                            onEdit={(feed) => void editFeed(fam.family, feed)}
                            onDelete={(feed) => patchFeeds(fam.family, { pendingDelete: feed, deleteError: null })}
                          />
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {pending && (
        <ConfirmDialog
          action={pending}
          busy={actionBusy}
          error={actionError}
          onCancel={() => { if (!actionBusy) { setPending(null); setActionError(null); } }}
          onConfirm={() => void runAction()}
        />
      )}

      {/* Per-feed delete confirm — family-scoped copy (the recipe is shared by
          every hotel on the PMS family). At most one open at a time. */}
      {(() => {
        const entry = Object.entries(feedsByFamily).find(([, s]) => s.pendingDelete);
        if (!entry) return null;
        const [family, s] = entry;
        const fam = families.find((f) => f.family === family);
        if (!s.pendingDelete) return null;
        return (
          <DeleteFeedDialog
            feed={s.pendingDelete}
            familyLabel={fam?.label ?? family}
            busy={s.deleteBusy}
            error={s.deleteError}
            onCancel={() => { if (!s.deleteBusy) patchFeeds(family, { pendingDelete: null, deleteError: null }); }}
            onConfirm={() => void runDeleteFeed(family)}
          />
        );
      })()}
    </Backdrop>
  );
}
