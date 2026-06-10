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
import { RefreshCw, Map as MapIcon, AlertTriangle, X } from 'lucide-react';
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
    </Backdrop>
  );
}
