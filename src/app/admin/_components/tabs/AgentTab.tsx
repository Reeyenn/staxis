'use client';

/**
 * Agent tab — Snow design (May 2026).
 *
 * Landing page for the AI agent admin surfaces. Two big action cards:
 *   - Agent dashboard   (→ /admin/agent — metrics, conversations, KPIs)
 *   - Edit AI prompts   (→ /admin/agent/prompts — the rulebook editor)
 *
 * Plus a quick-glance stat strip: today's user-driven spend, background
 * work spend, recent conversations count, tool issues.
 */

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { fetchWithAuth } from '@/lib/api-fetch';
import { ChevronRight, MessageSquare, Sparkles, DollarSign, Activity } from 'lucide-react';
import {
  T, FONT_SANS, FONT_MONO, FONT_SERIF,
  Caps, Card, SerifNum,
} from '@/app/admin/_components/_snow';

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
    void (async () => {
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
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24, fontFamily: FONT_SANS }}>

      {/* Hero header */}
      <Card padding="20px 24px">
        <Caps>AI agent</Caps>
        <h2 style={{
          fontFamily: FONT_SERIF, fontSize: 26, fontWeight: 400,
          letterSpacing: '-0.02em', color: T.ink, margin: '4px 0 6px',
          lineHeight: 1.15,
        }}>
          The <span style={{ fontStyle: 'italic' }}>AI</span> running inside Staxis.
        </h2>
        <p style={{ fontSize: 13, color: T.ink2, lineHeight: 1.55, maxWidth: 640 }}>
          The assistant that helps housekeepers, managers, and owners. Monitor what
          it&apos;s doing and edit its instructions without a code deploy.
        </p>
      </Card>

      {/* Quick-glance stats */}
      {error ? (
        <div style={{
          padding: '14px 16px',
          background: T.warmDim,
          border: `1px solid rgba(184,92,61,0.25)`,
          borderRadius: 14,
          color: T.warm,
          fontSize: 13,
        }}>
          {error}
        </div>
      ) : (
        <Card padding="0">
          <div style={{ display: 'flex', flexWrap: 'wrap' }}>
            <Stat
              icon={<DollarSign size={14} />}
              label="User spend today"
              value={data ? `$${data.today.totalCostUsd.toFixed(2)}` : '—'}
              sub={data ? `${data.today.requestCount} requests · ${data.today.uniqueUsers} users` : ''}
              tone="neutral"
            />
            <Stat
              icon={<Sparkles size={14} />}
              label="Background work"
              value={data ? `$${data.today.backgroundCostUsd.toFixed(2)}` : '—'}
              sub="Summarizer + auto-pilot · not against caps"
              tone={data && data.today.backgroundCostUsd > 0 ? 'caramel' : 'neutral'}
            />
            <Stat
              icon={<MessageSquare size={14} />}
              label="Conversations"
              value={data ? String(data.recentConversations.length) : '—'}
              sub="recent (last 50 by activity)"
              tone="neutral"
            />
            <Stat
              icon={<Activity size={14} />}
              label="Tool issues today"
              value={data ? String(data.toolErrorsToday + data.toolIncompleteToday) : '—'}
              sub={data
                ? `${data.toolErrorsToday} errors · ${data.toolIncompleteToday} incomplete`
                : ''}
              tone={data && (data.toolErrorsToday + data.toolIncompleteToday) > 0 ? 'warm' : 'sage'}
              last
            />
          </div>
        </Card>
      )}

      {/* Two action cards */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))',
        gap: 18,
      }}>
        <ActionCard
          href="/admin/agent"
          caps="Dashboard"
          title="Open agent"
          italic="dashboard"
          description="See every conversation, cost breakdown, tool error rates, model usage, and cron health. The full monitoring page."
          icon={<Activity size={20} />}
        />
        <ActionCard
          href="/admin/agent/prompts"
          caps="Prompts"
          title="Edit AI"
          italic="prompts"
          description="Change how the AI behaves without a code deploy. Versioned, with 30-second propagation. Edit housekeeper, manager, summarizer, or admin prompts."
          icon={<Sparkles size={20} />}
        />
      </div>
    </div>
  );
}

function Stat({ icon, label, value, sub, tone, last }: {
  icon: React.ReactNode;
  label: string;
  value: string;
  sub?: string;
  tone: 'neutral' | 'sage' | 'warm' | 'caramel';
  last?: boolean;
}) {
  const c = {
    neutral: T.ink,
    sage:    T.sageDeep,
    warm:    T.warm,
    caramel: T.caramelDeep,
  }[tone];
  return (
    <div style={{
      flex: '1 1 200px', minWidth: 180,
      padding: '16px 20px',
      borderRight: last ? 'none' : `1px solid ${T.rule}`,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: T.ink2 }}>
        {icon}
        <Caps>{label}</Caps>
      </div>
      <div style={{ marginTop: 6 }}>
        <SerifNum size={32} italic c={c}>{value}</SerifNum>
      </div>
      {sub && (
        <div style={{ fontSize: 11, color: T.ink3, marginTop: 4, fontFamily: FONT_MONO, letterSpacing: '0.03em' }}>
          {sub}
        </div>
      )}
    </div>
  );
}

function ActionCard({ href, caps, title, italic, description, icon }: {
  href: string;
  caps: string;
  title: string;
  italic: string;
  description: string;
  icon: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      style={{
        display: 'block',
        padding: '22px 24px',
        background: T.paper,
        border: `1px solid ${T.rule}`,
        borderRadius: 18,
        textDecoration: 'none',
        color: 'inherit',
        transition: 'border-color 0.15s, transform 0.15s',
      }}
      onMouseEnter={e => { e.currentTarget.style.borderColor = T.ink; }}
      onMouseLeave={e => { e.currentTarget.style.borderColor = T.rule; }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 36, height: 36,
          background: T.sageDim,
          borderRadius: 999,
          color: T.sageDeep,
        }}>
          {icon}
        </div>
        <ChevronRight size={18} color={T.ink3} />
      </div>
      <Caps>{caps}</Caps>
      <h3 style={{
        fontFamily: FONT_SERIF, fontSize: 24, fontWeight: 400,
        letterSpacing: '-0.02em', color: T.ink, margin: '4px 0 8px',
        lineHeight: 1.15,
      }}>
        {title} <span style={{ fontStyle: 'italic' }}>{italic}</span>
      </h3>
      <p style={{ fontSize: 13, color: T.ink2, lineHeight: 1.55 }}>
        {description}
      </p>
    </Link>
  );
}
