'use client';

import React, { useEffect, useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { getInventoryNetworkSummary } from '@/lib/db';
import type { InventoryNetworkSummary, CohortSummaryRow } from '@/lib/db/ml-inventory-cockpit';
import { Network, CheckCircle2, Circle } from 'lucide-react';

/**
 * Network-wide cohort + prior status. Tells Reeyen how the cross-hotel
 * learning is doing at scale. Mostly empty at 1 hotel; becomes meaningful
 * when 10+ hotels are signed up and contributing data.
 */
export function InventoryNetworkHealth() {
  const { user } = useAuth();
  const [data, setData] = useState<InventoryNetworkSummary | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user) return;
    (async () => {
      try {
        setData(await getInventoryNetworkSummary());
      } catch (err) {
        console.error('InventoryNetworkHealth: fetch error', err);
      } finally {
        setLoading(false);
      }
    })();
  }, [user]);

  return (
    <div style={{
      background: '#ffffff',
      border: '1px solid rgba(78,90,122,0.12)',
      borderRadius: '12px',
      padding: '24px',
    }}>
      <div style={{ marginBottom: '12px', display: 'flex', alignItems: 'center', gap: '10px' }}>
        <Network size={18} color="#004b4b" />
        <h2 style={{ fontSize: '16px', fontWeight: 600, color: '#1b1c19', margin: 0 }}>
          Network health
        </h2>
      </div>
      <p style={{ fontSize: '12px', color: '#7a8a9e', marginBottom: '16px', marginTop: 0 }}>
        Cross-hotel cohort priors. Empty until you sign up multiple hotels in the same brand/region.
      </p>

      {loading || !data ? (
        <div style={{ color: '#7a8a9e', fontSize: '13px' }}>Loading…</div>
      ) : (
        <>
          <div style={{ display: 'flex', gap: '24px', marginBottom: '16px' }}>
            <Stat label="Total properties" value={data.totalProperties} />
            <Stat label="Cohorts" value={data.cohorts.length} />
            <Stat label="Industry-seed items" value={data.industryBenchmarkItems} />
            <NetworkBadge active={data.networkModelActive} />
          </div>

          {data.cohorts.length === 0 ? (
            <div style={{
              padding: '24px', textAlign: 'center', color: '#7a8a9e', fontSize: '13px',
              background: '#f7fafb', borderRadius: '8px',
            }}>
              No cohorts yet. The aggregation cron will populate this once data accumulates.
            </div>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid rgba(78,90,122,0.12)' }}>
                  <Th>Cohort</Th>
                  <Th align="right">Items</Th>
                  <Th align="right">Hotels</Th>
                  <Th align="right">Prior strength</Th>
                  <Th>Source</Th>
                  <Th>Updated</Th>
                </tr>
              </thead>
              <tbody>
                {data.cohorts.map((c) => <CohortRow key={c.cohortKey} c={c} />)}
              </tbody>
            </table>
          )}
        </>
      )}
    </div>
  );
}

function CohortRow({ c }: { c: CohortSummaryRow }) {
  return (
    <tr style={{ borderBottom: '1px solid rgba(78,90,122,0.06)' }}>
      <Td>
        <span style={{ fontWeight: c.cohortKey === 'global' ? 600 : 400, color: '#1b1c19' }}>
          {c.cohortKey}
        </span>
      </Td>
      <Td align="right">{c.itemCount}</Td>
      <Td align="right">{c.hotelsContributing}</Td>
      <Td align="right">{c.priorStrength.toFixed(2)}</Td>
      <Td>
        <span style={{
          fontSize: '11px',
          fontWeight: 500,
          color: c.source === 'cohort-aggregate' ? '#00a050' : '#7a8a9e',
          background: c.source === 'cohort-aggregate' ? 'rgba(0,160,80,0.08)' : 'rgba(122,138,158,0.08)',
          padding: '2px 8px',
          borderRadius: '6px',
        }}>
          {c.source === 'cohort-aggregate' ? 'live' : 'seed'}
        </span>
      </Td>
      <Td>{c.updatedAt ? new Date(c.updatedAt).toLocaleDateString() : '—'}</Td>
    </tr>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <div style={{ fontSize: '20px', fontWeight: 600, color: '#1b1c19' }}>{value}</div>
      <div style={{ fontSize: '11px', color: '#7a8a9e' }}>{label}</div>
    </div>
  );
}

function NetworkBadge({ active }: { active: boolean }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
      {active
        ? <CheckCircle2 size={16} color="#00a050" />
        : <Circle size={16} color="#cdd5dd" />}
      <div>
        <div style={{ fontSize: '13px', fontWeight: 600, color: active ? '#00a050' : '#7a8a9e' }}>
          {active ? 'Network model active' : 'Industry seeds'}
        </div>
        <div style={{ fontSize: '11px', color: '#7a8a9e' }}>
          Activates at 5+ hotels
        </div>
      </div>
    </div>
  );
}

function Th({ children, align }: { children: React.ReactNode; align?: 'left' | 'right' }) {
  return (
    <th style={{
      padding: '8px 12px',
      textAlign: align ?? 'left',
      color: '#7a8a9e',
      fontWeight: 500,
      fontSize: '11px',
      textTransform: 'uppercase',
      letterSpacing: '0.04em',
    }}>{children}</th>
  );
}

function Td({ children, align }: { children: React.ReactNode; align?: 'left' | 'right' }) {
  return <td style={{ padding: '8px 12px', textAlign: align ?? 'left', color: '#1b1c19' }}>{children}</td>;
}
