'use client';

/**
 * Agent tab.
 *
 * Landing page for the AI agent admin surfaces. Two big buttons:
 *   - Agent dashboard   (→ /admin/agent — metrics, conversations, KPIs)
 *   - Edit AI prompts   (→ /admin/agent/prompts — the rulebook editor)
 *
 * Plus a quick-glance summary: today's user-driven spend, background
 * work spend, recent conversations count, prompts currently active.
 *
 * Round 11 follow-up (2026-05-13): the existing /admin/agent and
 * /admin/agent/prompts pages were only reachable by typing the URL.
 * This tab makes them discoverable from the main admin nav.
 */

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { fetchWithAuth } from '@/lib/api-fetch';
import { ChevronRight, MessageSquare, Sparkles, DollarSign, Activity } from 'lucide-react';

interface MetricsPayload {
  caps: { user: number; property: number; global: number };
  today: {
    totalCostUsd: number;
    backgroundCostUsd: number;
    requestCount: number;
    uniqueUsers: number;
    uniqueProperties: number;
  };
  recentConversations: Array<{ id: string }>;
  toolErrorsToday: number;
  toolIncompleteToday: number;
}

export function AgentTab() {
  const [data, setData] = useState<MetricsPayload | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetchWithAuth('/api/agent/metrics');
        if (!res.ok) {
          if (!cancelled) setError(`Failed to load (${res.status})`);
          return;
        }
        const body = await res.json();
        if (!cancelled) setData(body.data ?? body);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => { cancelled = true; };
  }, []);

  return (
    <div style={{ padding: '24px 0', display: 'flex', flexDirection: 'column', gap: 24 }}>
      {/* Header description */}
      <div style={{
        padding: '16px 20px',
        background: 'var(--surface-secondary, #FAFAF8)',
        border: '1px solid var(--rule, rgba(31, 35, 28, 0.08))',
        borderRadius: 12,
      }}>
        <div style={{ fontSize: 15, color: 'var(--text-primary)', marginBottom: 4 }}>
          AI agent admin
        </div>
        <div style={{ fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.5 }}>
          The AI assistant that runs inside Staxis for housekeepers, managers, and owners.
          From here you can monitor what it&apos;s doing and edit its instructions without a code deploy.
        </div>
      </div>

      {/* Quick-glance stats */}
      {error ? (
        <div style={{
          padding: '12px 16px',
          background: 'rgba(184, 92, 61, 0.08)',
          border: '1px solid rgba(184, 92, 61, 0.20)',
          borderRadius: 8,
          color: 'var(--red)',
          fontSize: 13,
        }}>
          {error}
        </div>
      ) : (
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
          gap: 12,
        }}>
          <Stat
            icon={<DollarSign size={14} />}
            label="User spend today"
            value={data ? `$${data.today.totalCostUsd.toFixed(2)}` : '—'}
            sub={data ? `${data.today.requestCount} requests · ${data.today.uniqueUsers} users` : ''}
          />
          <Stat
            icon={<Sparkles size={14} />}
            label="Background work today"
            value={data ? `$${data.today.backgroundCostUsd.toFixed(2)}` : '—'}
            sub="Summarizer + auto-pilot · not counted against caps"
            highlight={data ? data.today.backgroundCostUsd > 0 : false}
          />
          <Stat
            icon={<MessageSquare size={14} />}
            label="Conversations"
            value={data ? String(data.recentConversations.length) : '—'}
            sub="recent (last 50 by activity)"
          />
          <Stat
            icon={<Activity size={14} />}
            label="Tool issues today"
            value={data ? String(data.toolErrorsToday + data.toolIncompleteToday) : '—'}
            sub={data
              ? `${data.toolErrorsToday} errors · ${data.toolIncompleteToday} incomplete`
              : ''}
            highlight={data ? (data.toolErrorsToday + data.toolIncompleteToday) > 0 : false}
          />
        </div>
      )}

      {/* Two action cards */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
        gap: 16,
      }}>
        <ActionCard
          href="/admin/agent"
          title="Open agent dashboard"
          description="See every conversation, cost breakdown, tool error rates, model usage, and cron health. The full monitoring page."
          icon={<Activity size={20} />}
        />
        <ActionCard
          href="/admin/agent/prompts"
          title="Edit AI prompts"
          description="Change how the AI behaves without a code deploy. Versioned, with a 30-second propagation. Edit the housekeeper, manager, summarizer, or admin prompts."
          icon={<Sparkles size={20} />}
        />
      </div>
    </div>
  );
}

function Stat({ icon, label, value, sub, highlight }: {
  icon: React.ReactNode;
  label: string;
  value: string;
  sub?: string;
  highlight?: boolean;
}) {
  return (
    <div style={{
      padding: '14px 16px',
      background: 'var(--surface-primary, #FFFFFF)',
      border: `1px solid ${highlight ? 'rgba(201, 150, 68, 0.40)' : 'var(--rule, rgba(31, 35, 28, 0.08))'}`,
      borderRadius: 10,
    }}>
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        fontSize: 11,
        textTransform: 'uppercase',
        letterSpacing: '0.06em',
        color: 'var(--text-muted)',
        marginBottom: 6,
      }}>
        {icon}
        {label}
      </div>
      <div style={{
        fontSize: 22,
        fontWeight: 500,
        color: 'var(--text-primary)',
        marginBottom: 4,
      }}>
        {value}
      </div>
      {sub && (
        <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{sub}</div>
      )}
    </div>
  );
}

function ActionCard({ href, title, description, icon }: {
  href: string;
  title: string;
  description: string;
  icon: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      style={{
        display: 'block',
        padding: '20px',
        background: 'var(--surface-primary, #FFFFFF)',
        border: '1px solid var(--rule, rgba(31, 35, 28, 0.08))',
        borderRadius: 12,
        textDecoration: 'none',
        color: 'inherit',
        transition: 'border-color 0.15s, transform 0.15s',
      }}
      onMouseEnter={e => {
        e.currentTarget.style.borderColor = '#364262';
      }}
      onMouseLeave={e => {
        e.currentTarget.style.borderColor = 'var(--rule, rgba(31, 35, 28, 0.08))';
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 32,
          height: 32,
          background: 'rgba(54, 66, 98, 0.08)',
          borderRadius: 8,
          color: '#364262',
        }}>
          {icon}
        </div>
        <ChevronRight size={18} color="var(--text-muted)" />
      </div>
      <div style={{ fontSize: 16, fontWeight: 500, color: 'var(--text-primary)', marginBottom: 6 }}>
        {title}
      </div>
      <div style={{ fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.5 }}>
        {description}
      </div>
    </Link>
  );
}
