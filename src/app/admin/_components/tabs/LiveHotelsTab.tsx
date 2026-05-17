'use client';

/**
 * Live hotels tab — Snow design (May 2026).
 *
 * Layout: header chips row, search controls, then a 4-column grid:
 *   Hotels | Recent errors | SMS health | Feedback inbox
 *
 * Errors + SMS health both use a 72h window. Error rows past 72h are
 * purged daily by /api/cron/purge-old-error-logs.
 */

import React, { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { fetchWithAuth } from '@/lib/api-fetch';
import {
  Building2, ChevronRight, WifiOff, Wifi, AlertCircle,
  MessageSquare, ChevronDown, Search,
} from 'lucide-react';
import {
  T, FONT_SANS, FONT_MONO, FONT_SERIF,
  Caps, Card, Btn, Pill, SerifNum,
  type PillTone,
} from '@/app/admin/_components/_snow';

const STALE_THRESHOLD_MIN = 12 * 60; // 12 hours

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
}

interface ErrorGroup {
  source: string | null;
  message: string;
  count: number;
  firstSeen: string;
  lastSeen: string;
  affectedPropertyIds: string[];
  sampleStack: string | null;
}

interface SmsHealthRow {
  propertyId: string;
  propertyName: string | null;
  sent: number;
  inFlight: number;
  failed: number;
  deliveryPct: number | null;
  topErrors: { message: string; count: number }[];
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

export function LiveHotelsTab() {
  const [props, setProps] = useState<PropertyRow[] | null>(null);
  const [errors, setErrors] = useState<ErrorGroup[] | null>(null);
  const [sms, setSms] = useState<SmsHealthRow[] | null>(null);
  const [feedback, setFeedback] = useState<FeedbackItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [searchInput, setSearchInput] = useState('');
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'trial' | 'past_due' | 'stale' | 'pms_disconnected'>('all');
  const [page, setPage] = useState(1);
  const [pagination, setPagination] = useState<{ totalMatching: number; totalPages: number; hasMore: boolean } | null>(null);
  const PAGE_SIZE = 50;

  useEffect(() => {
    const t = setTimeout(() => setSearchTerm(searchInput.trim()), 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  useEffect(() => { setPage(1); }, [searchTerm, statusFilter]);

  const load = useCallback(async () => {
    setError(null);
    try {
      const since72h = new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString();
      const propsParams = new URLSearchParams({
        page: String(page),
        pageSize: String(PAGE_SIZE),
        status: statusFilter,
      });
      if (searchTerm) propsParams.set('search', searchTerm);
      const [propsRes, errorsRes, smsRes, feedbackRes] = await Promise.all([
        fetchWithAuth(`/api/admin/list-properties?${propsParams.toString()}`),
        fetchWithAuth(`/api/admin/recent-errors?since=${encodeURIComponent(since72h)}`),
        fetchWithAuth('/api/admin/sms-health?hours=72'),
        fetchWithAuth('/api/admin/feedback'),
      ]);
      const [propsJson, errorsJson, smsJson, feedbackJson] = await Promise.all([
        propsRes.json(), errorsRes.json(), smsRes.json(), feedbackRes.json(),
      ]);
      if (propsJson.ok) {
        setProps(propsJson.data.properties);
        setPagination(propsJson.data.pagination ?? null);
      }
      if (errorsJson.ok) setErrors(errorsJson.data.groups);
      if (smsJson.ok) setSms(smsJson.data.perHotel);
      if (feedbackJson.ok) setFeedback(feedbackJson.data.feedback);
    } catch (err) {
      setError(`Network error: ${(err as Error).message}`);
    }
  }, [page, statusFilter, searchTerm]);

  useEffect(() => { void load(); }, [load]);

  if (error) {
    return (
      <div style={{
        padding: '14px 16px',
        background: T.warmDim,
        border: `1px solid rgba(184,92,61,0.25)`,
        borderRadius: 14,
        color: T.warm, fontSize: 13,
        fontFamily: FONT_SANS,
      }}>{error}</div>
    );
  }

  if (!props || !errors || !sms || !feedback) {
    return (
      <div style={{ padding: '60px 0', textAlign: 'center' }}>
        <div className="spinner" style={{ width: '24px', height: '24px', margin: '0 auto' }} />
      </div>
    );
  }

  const live = statusFilter === 'all'
    ? props.filter((p) => p.lastSyncedAt !== null || p.subscriptionStatus === 'active')
    : props;

  const enriched = live.map((p) => ({
    ...p,
    isStale12h: p.pmsConnected && p.syncFreshnessMin !== null && p.syncFreshnessMin > STALE_THRESHOLD_MIN,
  }));

  enriched.sort((a, b) => {
    const score = (p: typeof a) => {
      if (p.subscriptionStatus === 'past_due') return 0;
      if (p.isStale12h) return 1;
      return 2;
    };
    const sa = score(a), sb = score(b);
    if (sa !== sb) return sa - sb;
    return Date.parse(b.createdAt) - Date.parse(a.createdAt);
  });

  const summary = {
    total: enriched.length,
    active: enriched.filter((p) => p.subscriptionStatus === 'active').length,
    disconnected: enriched.filter((p) => !p.pmsConnected).length,
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24, fontFamily: FONT_SANS }}>

      {/* Hero summary — three stats with italic-serif numbers */}
      <Card padding="20px 24px">
        <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', flexWrap: 'wrap', gap: 24 }}>
          <div>
            <Caps>Fleet</Caps>
            <h2 style={{
              fontFamily: FONT_SERIF, fontSize: 26, fontWeight: 400,
              letterSpacing: '-0.02em', color: T.ink, margin: '2px 0 0',
              lineHeight: 1.15,
            }}>
              <SerifNum size={48} italic c={T.ink}>{pagination?.totalMatching ?? summary.total}</SerifNum>
              {' '}
              <span style={{ fontStyle: 'italic', color: T.ink2 }}>hotels live</span>
            </h2>
          </div>
          <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}>
            <SummaryCell label="Active" value={summary.active} tone="sage" />
            <SummaryCell
              label="Disconnected PMS"
              value={summary.disconnected}
              tone={summary.disconnected > 0 ? 'warm' : 'muted'}
            />
          </div>
        </div>
      </Card>

      {/* Search + filter */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <div style={{
          position: 'relative',
          flex: '1 1 260px', minWidth: 220, maxWidth: 420,
        }}>
          <Search
            size={14}
            color={T.ink3}
            style={{ position: 'absolute', left: 14, top: '50%', transform: 'translateY(-50%)' }}
          />
          <input
            type="search"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Find hotels by name or brand…"
            style={{
              width: '100%', boxSizing: 'border-box',
              padding: '10px 14px 10px 36px', fontSize: 13,
              border: `1px solid ${T.rule}`, borderRadius: 999, outline: 'none',
              fontFamily: FONT_SANS, background: T.paper, color: T.ink,
            }}
          />
        </div>
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as typeof statusFilter)}
          style={{
            padding: '10px 14px', fontSize: 13,
            border: `1px solid ${T.rule}`, borderRadius: 999,
            fontFamily: FONT_SANS, background: T.paper, color: T.ink,
            outline: 'none', cursor: 'pointer',
          }}
        >
          <option value="all">All statuses</option>
          <option value="active">Active</option>
          <option value="trial">Trial</option>
          <option value="past_due">Past due</option>
          <option value="stale">Stale (no PMS sync &gt;12h)</option>
          <option value="pms_disconnected">PMS disconnected</option>
        </select>
      </div>

      {/* 4-column grid */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))',
        gap: 18,
        alignItems: 'start',
      }}>

        {/* Column 1: Hotels */}
        <section style={columnStyle}>
          <SectionTitle caps="Hotels" title="Hotels" italic="list" />

          {enriched.length === 0 ? (
            <div style={{ padding: '40px 20px', textAlign: 'center', color: T.ink2 }}>
              <Building2 size={28} color={T.ink3} style={{ marginBottom: 8 }} />
              <p style={{ fontSize: 13, fontFamily: FONT_SERIF, fontStyle: 'italic' }}>
                No live hotels yet — they&apos;ll appear here once their first sync completes.
              </p>
            </div>
          ) : (
            <Card padding="0" style={{ marginTop: 8 }}>
              {enriched.map((p, idx) => (
                <Link
                  key={p.id}
                  href={`/admin/properties/${p.id}`}
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 4,
                    padding: '14px 16px',
                    borderBottom: idx < enriched.length - 1 ? `1px solid ${T.rule}` : 'none',
                    textDecoration: 'none', color: 'inherit',
                    background: rowBackground(p),
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                    <div style={{
                      fontWeight: 600, fontSize: 13.5, minWidth: 0,
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      color: T.ink, letterSpacing: '-0.005em',
                    }}>
                      {p.name ?? '(unnamed)'}
                    </div>
                    <ChevronRight size={14} color={T.ink3} style={{ flexShrink: 0 }} />
                  </div>
                  <div style={{ fontFamily: FONT_MONO, fontSize: 11, color: T.ink3, letterSpacing: '0.02em' }}>
                    {p.totalRooms ?? '—'} rooms · {p.staffCount} staff
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginTop: 4 }}>
                    <SubscriptionBadge status={p.subscriptionStatus} />
                    <SyncBadge p={p} />
                  </div>
                </Link>
              ))}
            </Card>
          )}

          {pagination && pagination.totalPages > 1 && (
            <div style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              gap: 8, marginTop: 12,
              padding: '10px 14px', background: T.paper,
              border: `1px solid ${T.rule}`, borderRadius: 999,
            }}>
              <span style={{ fontFamily: FONT_MONO, fontSize: 11, color: T.ink2, letterSpacing: '0.04em' }}>
                Page {page} / {pagination.totalPages} · {pagination.totalMatching} hotels
              </span>
              <div style={{ display: 'flex', gap: 6 }}>
                <Btn variant="ghost" size="sm" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1}>
                  Prev
                </Btn>
                <Btn variant="ghost" size="sm" onClick={() => setPage((p) => p + 1)} disabled={!pagination.hasMore}>
                  Next
                </Btn>
              </div>
            </div>
          )}
        </section>

        {/* Column 2: Recent errors */}
        <section style={columnStyle}>
          <SectionTitle caps="Recent errors" title="Recent" italic="errors" />
          {errors.length === 0 ? (
            <EmptyState text="No errors ✓" />
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
              {errors.map((g, idx) => <ErrorGroupRow key={idx} group={g} />)}
            </div>
          )}
        </section>

        {/* Column 3: SMS health */}
        <section style={columnStyle}>
          <SectionTitle caps="SMS" title="SMS" italic="health" />
          {sms.length === 0 ? (
            <EmptyState text="No SMS activity." />
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
              {sms.map((h) => <SmsHealthRowCard key={h.propertyId} row={h} />)}
            </div>
          )}
        </section>

        {/* Column 4: Feedback inbox */}
        <section style={columnStyle}>
          <SectionTitle caps="Inbox" title="Feedback" italic="inbox" />
          {feedback.length === 0 ? (
            <EmptyState text="No feedback yet." />
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
              {feedback.map((f) => <FeedbackRowCard key={f.id} row={f} onChange={load} />)}
            </div>
          )}
        </section>

      </div>
    </div>
  );
}

const columnStyle: React.CSSProperties = {
  minWidth: 0,
};

// ── Sub-components ─────────────────────────────────────────────────────

function SectionTitle({ caps, title, italic }: { caps: string; title: string; italic?: string }) {
  return (
    <div>
      <Caps>{caps}</Caps>
      <h2 style={{
        fontFamily: FONT_SERIF, fontSize: 24, fontWeight: 400,
        letterSpacing: '-0.02em', color: T.ink, margin: '2px 0 0',
        lineHeight: 1.15,
      }}>
        {title}
        {italic && <> <span style={{ fontStyle: 'italic' }}>{italic}</span></>}
      </h2>
    </div>
  );
}

function SummaryCell({ label, value, tone }: { label: string; value: number; tone: 'sage' | 'warm' | 'muted' }) {
  const c = tone === 'sage' ? T.sageDeep : tone === 'warm' ? T.warm : T.ink3;
  return (
    <div>
      <Caps>{label}</Caps>
      <div style={{ marginTop: 2 }}>
        <SerifNum size={36} c={c}>{value}</SerifNum>
      </div>
    </div>
  );
}

function ErrorGroupRow({ group }: { group: ErrorGroup }) {
  const [expanded, setExpanded] = useState(false);
  const truncated = group.message.length > 120 ? group.message.slice(0, 120) + '…' : group.message;
  return (
    <Card
      padding="12px 14px"
      style={{ cursor: group.sampleStack ? 'pointer' : 'default' }}
    >
      <div
        style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}
        onClick={() => group.sampleStack && setExpanded(!expanded)}
      >
        <AlertCircle size={14} color={T.warm} style={{ marginTop: 2, flexShrink: 0 }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontFamily: FONT_MONO, fontSize: 12, fontWeight: 500, color: T.ink, lineHeight: 1.45 }}>
            {expanded ? group.message : truncated}
          </div>
          <div style={{ fontFamily: FONT_MONO, fontSize: 10.5, color: T.ink3, marginTop: 6, display: 'flex', flexWrap: 'wrap', gap: 10, letterSpacing: '0.04em' }}>
            <span>{group.source ?? 'unknown'}</span>
            <span>{group.count}× · last {formatAge(group.lastSeen)}</span>
            {group.affectedPropertyIds.length > 0 && (
              <span>{group.affectedPropertyIds.length} {group.affectedPropertyIds.length === 1 ? 'hotel' : 'hotels'}</span>
            )}
          </div>
        </div>
        <span style={{ fontFamily: FONT_MONO, fontSize: 11, fontWeight: 700, color: T.warm }}>
          ×{group.count}
        </span>
        {group.sampleStack && (
          <ChevronDown size={14} color={T.ink3} style={{ transform: expanded ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s', flexShrink: 0 }} />
        )}
      </div>
      {expanded && group.sampleStack && (
        <pre style={{
          marginTop: 10,
          padding: 12,
          background: T.ruleSoft,
          borderRadius: 10,
          fontSize: 11,
          fontFamily: FONT_MONO,
          color: T.ink2,
          overflowX: 'auto',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-all',
        }}>{group.sampleStack}</pre>
      )}
    </Card>
  );
}

function SmsHealthRowCard({ row }: { row: SmsHealthRow }) {
  const hasFailures = row.failed > 0;
  return (
    <Link href={`/admin/properties/${row.propertyId}`} style={{ textDecoration: 'none', color: 'inherit' }}>
      <Card
        padding="12px 14px"
        style={{
          border: `1px solid ${hasFailures ? 'rgba(184,92,61,0.25)' : T.rule}`,
          display: 'flex', alignItems: 'center', gap: 12,
        }}
      >
        <MessageSquare size={14} color={hasFailures ? T.warm : T.ink3} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13.5, fontWeight: 600, color: T.ink, letterSpacing: '-0.005em' }}>
            {row.propertyName ?? '(deleted property)'}
          </div>
          <div style={{ fontFamily: FONT_MONO, fontSize: 10.5, color: T.ink3, marginTop: 3, display: 'flex', flexWrap: 'wrap', gap: 10, letterSpacing: '0.04em' }}>
            <span style={{ color: T.sageDeep }}>{row.sent} sent</span>
            {row.inFlight > 0 && <span>{row.inFlight} in flight</span>}
            {row.failed > 0 && <span style={{ color: T.warm }}>{row.failed} failed</span>}
            {row.deliveryPct !== null && (
              <span style={{ color: row.deliveryPct >= 95 ? T.sageDeep : row.deliveryPct >= 80 ? T.caramelDeep : T.warm }}>
                {row.deliveryPct}% delivery
              </span>
            )}
          </div>
          {row.topErrors.length > 0 && (
            <div style={{ fontFamily: FONT_MONO, fontSize: 10.5, color: T.warm, marginTop: 4 }}>
              {row.topErrors[0].message}{row.topErrors.length > 1 ? ` (+${row.topErrors.length - 1})` : ''}
            </div>
          )}
        </div>
        <ChevronRight size={14} color={T.ink3} />
      </Card>
    </Link>
  );
}

function FeedbackRowCard({ row, onChange }: { row: FeedbackItem; onChange: () => Promise<void> }) {
  const [updating, setUpdating] = useState(false);

  const setStatus = async (status: string) => {
    setUpdating(true);
    try {
      await fetchWithAuth('/api/admin/feedback', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: row.id, status }),
      });
      await onChange();
    } finally {
      setUpdating(false);
    }
  };

  const categoryEmoji: Record<string, string> = {
    bug: '🐛', feature_request: '✨', general: '💬', complaint: '😠', love: '❤️',
  };
  const statusTone: Record<string, PillTone> = {
    new: 'caramel', in_progress: 'neutral', resolved: 'sage', wontfix: 'neutral',
  };

  return (
    <Card
      padding="14px 16px"
      style={{
        border: `1px solid ${row.status === 'new' ? 'rgba(140,106,51,0.25)' : T.rule}`,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, marginBottom: 6 }}>
        <span style={{ fontSize: 16 }}>{categoryEmoji[row.category] ?? '💬'}</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13.5, fontWeight: 600, color: T.ink, letterSpacing: '-0.005em' }}>
            {row.user_display_name ?? row.user_email ?? 'Anonymous'}
            {row.property_name && (
              <span style={{ fontWeight: 400, color: T.ink3, fontSize: 12, marginLeft: 6, fontStyle: 'italic' }}>
                · {row.property_name}
              </span>
            )}
          </div>
          <div style={{ fontFamily: FONT_MONO, fontSize: 10.5, color: T.ink3, marginTop: 3, letterSpacing: '0.04em' }}>
            {formatAge(row.created_at)} · {row.category.replace('_', ' ')}
          </div>
        </div>
        <Pill tone={statusTone[row.status] ?? 'neutral'}>
          {row.status.toUpperCase()}
        </Pill>
      </div>
      <div style={{
        padding: 12,
        background: T.ruleSoft,
        borderRadius: 12,
        fontSize: 13, color: T.ink,
        whiteSpace: 'pre-wrap', wordBreak: 'break-word',
        marginBottom: row.status !== 'resolved' && row.status !== 'wontfix' ? 10 : 0,
        lineHeight: 1.5,
      }}>{row.message}</div>
      {row.status !== 'resolved' && row.status !== 'wontfix' && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {row.status === 'new' && (
            <Btn variant="ghost" size="sm" onClick={() => setStatus('in_progress')} disabled={updating}>
              Mark in progress
            </Btn>
          )}
          <Btn variant="sage" size="sm" onClick={() => setStatus('resolved')} disabled={updating}>
            Resolve
          </Btn>
          <Btn variant="ghost" size="sm" onClick={() => setStatus('wontfix')} disabled={updating}>
            Won&apos;t fix
          </Btn>
        </div>
      )}
    </Card>
  );
}

function EmptyState({ text }: { text: string }) {
  return (
    <div style={{
      marginTop: 8,
      padding: '24px 20px',
      background: T.ruleSoft,
      border: `1px dashed ${T.rule}`,
      borderRadius: 14,
      textAlign: 'center',
      fontSize: 12.5,
      color: T.ink2,
      fontStyle: 'italic',
      fontFamily: FONT_SERIF,
    }}>{text}</div>
  );
}

function rowBackground(p: { subscriptionStatus: string | null; isStale12h: boolean }): string {
  if (p.subscriptionStatus === 'past_due') return 'rgba(184,92,61,0.04)';
  if (p.isStale12h) return 'rgba(184,92,61,0.03)';
  return 'transparent';
}

function SubscriptionBadge({ status }: { status: string | null }) {
  const s = status ?? 'unknown';
  const tone: PillTone = s === 'active' ? 'sage'
              : s === 'past_due' ? 'warm'
              : 'neutral';
  return <Pill tone={tone}>{s.toUpperCase()}</Pill>;
}

function SyncBadge({ p }: { p: { pmsConnected: boolean; pmsType: string | null; syncFreshnessMin: number | null; isStale12h: boolean } }) {
  if (!p.pmsConnected) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontFamily: FONT_MONO, fontSize: 11, color: T.ink2, letterSpacing: '0.04em' }}>
        <WifiOff size={13} /> not connected
      </div>
    );
  }
  const c = p.isStale12h ? T.warm
          : p.syncFreshnessMin !== null && p.syncFreshnessMin > 60 ? T.caramelDeep
          : T.sageDeep;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontFamily: FONT_MONO, fontSize: 11, color: c, letterSpacing: '0.04em' }}>
      <Wifi size={13} /> {p.pmsType}
      {p.syncFreshnessMin !== null && (
        <span>· {formatMin(p.syncFreshnessMin)}</span>
      )}
    </div>
  );
}

function formatMin(min: number): string {
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  return `${Math.floor(hr / 24)}d`;
}

function formatAge(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}
