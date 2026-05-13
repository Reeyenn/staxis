'use client';

// ─── /admin/agent — internal monitoring dashboard ─────────────────────────
// Staxis-only. Shows the agent layer's recent activity, today's spend vs
// caps, model breakdown, top tools called, recent conversations. Built
// for debugging "why did the AI do X" reports and for catching cost
// runaway before it bills.

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useAuth } from '@/contexts/AuthContext';
import { AppLayout } from '@/components/layout/AppLayout';
import { fetchWithAuth } from '@/lib/api-fetch';
import { Activity, AlertTriangle, ChevronRight, DollarSign, Hammer, Inbox, Users } from 'lucide-react';

const C = {
  bg:       'var(--snow-bg, #FFFFFF)',
  ink:      'var(--snow-ink, #1F231C)',
  ink2:     'var(--snow-ink2, #5C625C)',
  ink3:     'var(--snow-ink3, #A6ABA6)',
  rule:     'var(--snow-rule, rgba(31, 35, 28, 0.08))',
  ruleSoft: 'var(--snow-rule-soft, rgba(31, 35, 28, 0.04))',
  sage:     'var(--snow-sage, #9EB7A6)',
  sageDeep: 'var(--snow-sage-deep, #5C7A60)',
  caramel:  'var(--snow-caramel, #C99644)',
  warm:     'var(--snow-warm, #B85C3D)',
};

const FONT_SANS  = "var(--font-geist), -apple-system, BlinkMacSystemFont, sans-serif";
const FONT_MONO  = "var(--font-geist-mono), ui-monospace, monospace";
const FONT_SERIF = "var(--font-instrument-serif), 'Times New Roman', Georgia, serif";

interface MetricsPayload {
  caps: { user: number; property: number; global: number };
  today: {
    totalCostUsd: number;
    requestCount: number;
    evalCostUsd: number;
    uniqueUsers: number;
    uniqueProperties: number;
    cacheHitRatePct: number;
  };
  recentConversations: Array<{
    id: string; title: string | null; role: string;
    promptVersion: string | null; updatedAt: string; messageCount: number;
  }>;
  topTools: Array<{ tool: string; calls: number }>;
  modelUsage: Array<{ model: string; count: number; costUsd: number }>;
  modelIdsToday: Array<{ modelId: string; count: number }>;
  pendingNudges: number;
  staleReservations: number;
  sweptToday: number;
}

export default function AdminAgentPage() {
  const { user, loading: authLoading } = useAuth();
  const [data, setData] = useState<MetricsPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastFetchedAt, setLastFetchedAt] = useState<Date | null>(null);

  const fetchMetrics = async () => {
    try {
      const res = await fetchWithAuth('/api/agent/metrics');
      if (!res.ok) {
        setError(`Failed to load: ${res.status}`);
        return;
      }
      const body = await res.json();
      setData(body.data);
      setLastFetchedAt(new Date());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  useEffect(() => {
    if (!user || user.role !== 'admin') return;
    void fetchMetrics();
    const interval = setInterval(fetchMetrics, 30_000);
    return () => clearInterval(interval);
  }, [user]);

  if (authLoading) {
    return (
      <AppLayout>
        <Centered>Loading…</Centered>
      </AppLayout>
    );
  }
  if (!user || user.role !== 'admin') {
    return (
      <AppLayout>
        <Centered>This page is Staxis-only.</Centered>
      </AppLayout>
    );
  }

  return (
    <AppLayout>
      <div style={{
        maxWidth: 1280,
        margin: '0 auto',
        padding: '32px 24px 80px',
        fontFamily: FONT_SANS,
        color: C.ink,
        background: C.bg,
        minHeight: '100vh',
      }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 36 }}>
          <div>
            <div style={{
              fontFamily: FONT_SERIF,
              fontSize: 'clamp(48px, 6vw, 72px)',
              lineHeight: 1,
              letterSpacing: '-0.02em',
              color: C.ink,
            }}>
              Agent
            </div>
            <div style={{
              marginTop: 8,
              fontFamily: FONT_MONO,
              fontSize: 11,
              textTransform: 'uppercase',
              letterSpacing: '0.1em',
              color: C.ink3,
            }}>
              Monitoring · {lastFetchedAt ? `updated ${formatRelative(lastFetchedAt)}` : 'loading'}
            </div>
          </div>
          {error && (
            <div style={{
              padding: '6px 12px',
              background: 'rgba(184, 92, 61, 0.08)',
              border: `1px solid rgba(184, 92, 61, 0.20)`,
              borderRadius: 6,
              color: C.warm,
              fontFamily: FONT_MONO,
              fontSize: 11,
            }}>
              {error}
            </div>
          )}
        </div>

        {/* Top KPIs */}
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
          gap: 16,
          marginBottom: 32,
        }}>
          <KPI
            icon={<DollarSign size={14} />}
            label="Spent today"
            value={data ? `$${data.today.totalCostUsd.toFixed(2)}` : '—'}
            sub={data ? `of $${data.caps.global} cap (${Math.round((data.today.totalCostUsd / data.caps.global) * 100)}%)` : ''}
            severity={data && data.today.totalCostUsd / data.caps.global > 0.5 ? 'warm' : 'ok'}
          />
          <KPI
            icon={<Activity size={14} />}
            label="Requests today"
            value={data ? String(data.today.requestCount) : '—'}
            sub={data ? `${data.today.uniqueUsers} user${data.today.uniqueUsers === 1 ? '' : 's'}, ${data.today.uniqueProperties} propert${data.today.uniqueProperties === 1 ? 'y' : 'ies'}` : ''}
          />
          <KPI
            icon={<Hammer size={14} />}
            label="Tool calls"
            value={data ? String(data.topTools.reduce((acc, t) => acc + t.calls, 0)) : '—'}
            sub={data && data.topTools.length ? `${data.topTools.length} unique tools` : 'no tools used yet'}
          />
          <KPI
            icon={<Inbox size={14} />}
            label="Pending nudges"
            value={data ? String(data.pendingNudges) : '—'}
            sub="across all properties"
          />
          <KPI
            icon={<Activity size={14} />}
            label="Cache hit rate"
            value={data ? `${data.today.cacheHitRatePct}%` : '—'}
            sub={data && data.today.cacheHitRatePct > 50 ? 'prompt cache is hitting well' : 'cache is missing — investigate'}
            severity={data && data.today.cacheHitRatePct < 30 ? 'warm' : 'ok'}
          />
          <KPI
            icon={<AlertTriangle size={14} />}
            label="Stuck reservations"
            value={data ? String(data.staleReservations) : '—'}
            sub={data
              ? `${data.sweptToday} swept today${data.staleReservations > 0 ? ' · finalize+cancel both failing' : data.sweptToday > 0 ? ' · sweeper recovering failures' : ' · sweeper running clean'}`
              : ''}
            severity={data && (data.staleReservations > 0 || data.sweptToday > 0) ? 'warm' : 'ok'}
          />
        </div>

        {/* Two-column layout: recent conversations + side panels */}
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(0, 1fr) 320px',
          gap: 24,
          alignItems: 'flex-start',
        }}>
          {/* Recent conversations */}
          <Card title="Recent conversations">
            {!data || data.recentConversations.length === 0 ? (
              <EmptyRow text="No conversations yet today." />
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column' }}>
                {data.recentConversations.map(c => (
                  <Link
                    key={c.id}
                    href="/chat"
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      padding: '12px 16px',
                      borderBottom: `1px solid ${C.rule}`,
                      textDecoration: 'none',
                      color: 'inherit',
                    }}
                  >
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={{
                        fontSize: 14,
                        color: C.ink,
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        marginBottom: 4,
                      }}>
                        {c.title ?? '(untitled)'}
                      </div>
                      <div style={{
                        fontFamily: FONT_MONO,
                        fontSize: 10,
                        color: C.ink3,
                        textTransform: 'uppercase',
                        letterSpacing: '0.06em',
                      }}>
                        {c.role} · {c.messageCount} message{c.messageCount === 1 ? '' : 's'} · {c.promptVersion ?? 'no prompt version'} · {formatRelative(new Date(c.updatedAt))}
                      </div>
                    </div>
                    <ChevronRight size={14} color={C.ink3} />
                  </Link>
                ))}
              </div>
            )}
          </Card>

          {/* Right column */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
            <Card title="Top tools today">
              {!data || data.topTools.length === 0 ? (
                <EmptyRow text="No tools called yet today." />
              ) : (
                <div style={{ padding: '8px 0' }}>
                  {data.topTools.map(t => (
                    <div key={t.tool} style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      padding: '6px 16px',
                    }}>
                      <span style={{
                        fontFamily: FONT_MONO,
                        fontSize: 12,
                        color: C.ink,
                      }}>{t.tool}</span>
                      <span style={{
                        fontFamily: FONT_MONO,
                        fontSize: 12,
                        color: C.ink2,
                        fontWeight: 500,
                      }}>{t.calls}</span>
                    </div>
                  ))}
                </div>
              )}
            </Card>

            <Card title="Model usage">
              {!data || data.modelUsage.length === 0 ? (
                <EmptyRow text="No requests yet today." />
              ) : (
                <div style={{ padding: '8px 0' }}>
                  {data.modelUsage.map(m => (
                    <div key={m.model} style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      padding: '6px 16px',
                    }}>
                      <span style={{
                        fontFamily: FONT_MONO,
                        fontSize: 12,
                        color: C.ink,
                      }}>{m.model}</span>
                      <span style={{
                        fontFamily: FONT_MONO,
                        fontSize: 11,
                        color: C.ink3,
                      }}>{m.count} · ${m.costUsd.toFixed(2)}</span>
                    </div>
                  ))}
                </div>
              )}
            </Card>

            <Card title="Anthropic snapshot IDs today">
              {!data || data.modelIdsToday.length === 0 ? (
                <EmptyRow text="No requests yet today." />
              ) : (
                <div style={{ padding: '8px 0' }}>
                  {data.modelIdsToday.map(m => (
                    <div key={m.modelId} style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      padding: '6px 16px',
                    }}>
                      <span style={{
                        fontFamily: FONT_MONO,
                        fontSize: 11,
                        color: C.ink,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        maxWidth: 200,
                      }} title={m.modelId}>{m.modelId}</span>
                      <span style={{
                        fontFamily: FONT_MONO,
                        fontSize: 11,
                        color: C.ink3,
                      }}>{m.count}</span>
                    </div>
                  ))}
                  {data.modelIdsToday.length > 1 && (
                    <div style={{
                      padding: '6px 16px',
                      fontFamily: FONT_MONO,
                      fontSize: 10,
                      color: C.warm,
                    }}>
                      ⚠ Multiple snapshots — Anthropic may have shipped a model update. Re-run evals.
                    </div>
                  )}
                </div>
              )}
            </Card>

            <Card title="Caps">
              <div style={{ padding: '8px 16px' }}>
                {data && (
                  <>
                    <CapLine label="User / day" cap={data.caps.user} />
                    <CapLine label="Property / day" cap={data.caps.property} />
                    <CapLine label="Global / day" cap={data.caps.global} current={data.today.totalCostUsd} highlight />
                  </>
                )}
              </div>
            </Card>

            {data && data.today.evalCostUsd > 0 && (
              <div style={{
                padding: '10px 14px',
                background: C.ruleSoft,
                border: `1px solid ${C.rule}`,
                borderRadius: 8,
                fontFamily: FONT_MONO,
                fontSize: 11,
                color: C.ink2,
              }}>
                <AlertTriangle size={12} style={{ marginRight: 6, verticalAlign: 'middle', color: C.caramel }} />
                Eval runs today: ${data.today.evalCostUsd.toFixed(2)} (not counted against caps)
              </div>
            )}
          </div>
        </div>
      </div>
    </AppLayout>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      minHeight: '60vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
      color: C.ink, fontFamily: FONT_SANS, fontSize: 14,
    }}>
      {children}
    </div>
  );
}

function KPI({ icon, label, value, sub, severity }: {
  icon: React.ReactNode;
  label: string;
  value: string;
  sub?: string;
  severity?: 'ok' | 'warm';
}) {
  return (
    <div style={{
      padding: '20px 22px',
      background: C.bg,
      border: `1px solid ${C.rule}`,
      borderRadius: 14,
    }}>
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        fontFamily: FONT_MONO,
        fontSize: 10,
        textTransform: 'uppercase',
        letterSpacing: '0.08em',
        color: C.ink3,
        marginBottom: 12,
      }}>
        {icon} {label}
      </div>
      <div style={{
        fontFamily: FONT_SERIF,
        fontSize: 'clamp(40px, 4vw, 52px)',
        lineHeight: 1,
        color: severity === 'warm' ? C.warm : C.ink,
      }}>
        {value}
      </div>
      {sub && (
        <div style={{
          marginTop: 8,
          fontFamily: FONT_SANS,
          fontSize: 12,
          color: C.ink2,
        }}>
          {sub}
        </div>
      )}
    </div>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{
      background: C.bg,
      border: `1px solid ${C.rule}`,
      borderRadius: 14,
      overflow: 'hidden',
    }}>
      <div style={{
        padding: '14px 16px',
        borderBottom: `1px solid ${C.rule}`,
        fontFamily: FONT_MONO,
        fontSize: 10,
        textTransform: 'uppercase',
        letterSpacing: '0.08em',
        color: C.ink3,
      }}>
        {title}
      </div>
      {children}
    </div>
  );
}

function EmptyRow({ text }: { text: string }) {
  return (
    <div style={{
      padding: '20px 16px',
      fontFamily: FONT_SANS,
      fontSize: 13,
      color: C.ink3,
    }}>
      {text}
    </div>
  );
}

function CapLine({ label, cap, current, highlight }: { label: string; cap: number; current?: number; highlight?: boolean }) {
  const pct = current !== undefined ? Math.min(100, (current / cap) * 100) : 0;
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        fontFamily: FONT_MONO,
        fontSize: 11,
        color: C.ink2,
        marginBottom: 4,
      }}>
        <span>{label}</span>
        <span>{current !== undefined ? `$${current.toFixed(2)}` : ''} / ${cap}</span>
      </div>
      {highlight && (
        <div style={{ height: 4, background: C.rule, borderRadius: 2, overflow: 'hidden' }}>
          <div style={{
            height: '100%',
            width: `${pct}%`,
            background: pct > 80 ? C.warm : pct > 50 ? C.caramel : C.sageDeep,
            transition: 'width 0.3s ease',
          }} />
        </div>
      )}
    </div>
  );
}

function formatRelative(date: Date): string {
  const seconds = Math.round((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86400)}d ago`;
}
