'use client';

export const dynamic = 'force-dynamic';

/**
 * /admin/live-mapper — Live Mapper: the library of the robot's learned PMS maps.
 *
 * Every map the robot has learned, grouped by PMS brand, showing which one is
 * LIVE plus explicit, hard-to-misclick controls to promote / roll back / take
 * offline / delete. All reads + writes go through admin-gated /api/admin/
 * live-mapper/* routes (the pms_knowledge_files table is service-role-only —
 * migration 0201 deny-all-browser policy), so the browser never touches the DB
 * directly and never sees the raw map JSON or the HMAC signature value.
 *
 * Promoting/deprecating changes which map EVERY hotel on that brand uses, so
 * every mutating action is funneled through a confirm dialog that names the
 * brand + version and spells out the consequence in plain English. The live
 * map can't be deleted (the route 409s and the UI doesn't offer it).
 *
 * Styling: dark "studio" admin look (var(--ink) canvas + dim() white-alpha
 * cards + forest/gold/teal accents), wrapped in .admin-studio so the studio CSS
 * vars resolve. Content is width-capped (not full-bleed) to match the other
 * standalone admin pages (e.g. /admin/pms-inbox).
 */

import React, { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useAuth } from '@/contexts/AuthContext';
import { fetchWithAuth } from '@/lib/api-fetch';
import { AppLayout } from '@/components/layout/AppLayout';
import { ChevronLeft, RefreshCw, Map as MapIcon, AlertTriangle } from 'lucide-react';
import { FONT_SERIF, FONT_MONO, Caps, Pill, Dot, Btn } from '@/app/admin/_components/studio/kit';
import { Backdrop, MODAL_CARD } from '@/app/admin/_components/studio/surface-kit';
// Dark studio palette (--ink/--forest/--gold/--teal/--serif/--mono) lives here,
// scoped under `.admin-studio`. This page renders OUTSIDE StudioShell, so it
// must import the stylesheet itself or every var resolves to nothing.
import '@/app/admin/_components/studio/studio.css';

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

function DarkPage({ children }: { children: React.ReactNode }) {
  return (
    <AppLayout>
      <div
        className="admin-studio"
        style={{
          background: 'var(--ink)',
          color: '#fff',
          marginLeft: 'calc(50% - 50vw)',
          marginRight: 'calc(50% - 50vw)',
          minHeight: 'calc(100vh - 64px)',
          position: 'relative',
        }}
      >
        <div style={{ position: 'absolute', inset: 0, background: 'radial-gradient(120% 70% at 100% 0%, rgba(60,156,104,.12), transparent 55%)', pointerEvents: 'none' }} />
        <div style={{ position: 'relative', maxWidth: 1080, margin: '0 auto', padding: '24px 28px 56px' }}>
          {children}
        </div>
      </div>
    </AppLayout>
  );
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

export default function LiveMapperPage() {
  const { user, loading: authLoading } = useAuth();
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
    if (!user) return;
    void load();
  }, [user, load]);

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

  if (authLoading) {
    return <DarkPage><div style={{ color: dim(.6), padding: 40, fontFamily: FONT_SERIF, fontStyle: 'italic' }}>Loading…</div></DarkPage>;
  }
  if (!user || user.role !== 'admin') {
    return <DarkPage><div style={{ color: dim(.6), padding: 40 }}>Admin access only.</div></DarkPage>;
  }

  const totalMaps = families.reduce((n, f) => n + f.maps.length, 0);

  return (
    <DarkPage>
      <Link href="/admin" style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12.5, color: dim(.5), textDecoration: 'none', marginBottom: 14 }}>
        <ChevronLeft size={14} /> Admin
      </Link>

      <header style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap', marginBottom: 24 }}>
        <div>
          <Caps style={{ color: dim(.5) }}>Onboarding · Robot brains</Caps>
          <h1 style={{ fontFamily: FONT_SERIF, fontSize: 32, fontWeight: 400, letterSpacing: '-0.02em', margin: '4px 0 0', color: '#fff', display: 'flex', alignItems: 'center', gap: 11 }}>
            <MapIcon size={26} style={{ color: 'var(--forest)' }} /> The maps the robot <span style={{ fontStyle: 'italic' }}>has learned</span>
          </h1>
          <p style={{ fontSize: 13.5, color: dim(.55), margin: '9px 0 0', maxWidth: 660, lineHeight: 1.55 }}>
            One map per PMS brand drives every hotel on it. Promote a draft to go live, roll back to an earlier version, take a brand offline, or delete an old map. The live map can’t be deleted — take it offline first.
          </p>
        </div>
        <Btn variant="ghost" size="lg" onClick={() => void load()} style={{ color: '#fff', borderColor: dim(.3), background: dim(.06) }}>
          <RefreshCw size={14} style={{ marginRight: 6 }} className={loading ? 'animate-spin' : undefined} /> Refresh
        </Btn>
      </header>

      {error && (
        <div style={{ marginBottom: 22, borderRadius: 12, border: '1px solid rgba(194,86,46,.42)', background: 'rgba(194,86,46,.10)', padding: '11px 14px', fontSize: 13, color: '#f0b8a6' }}>
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

      {pending && (
        <ConfirmDialog
          action={pending}
          busy={actionBusy}
          error={actionError}
          onCancel={() => { if (!actionBusy) { setPending(null); setActionError(null); } }}
          onConfirm={() => void runAction()}
        />
      )}
    </DarkPage>
  );
}
