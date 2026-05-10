'use client';

import React, { useEffect, useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { useProperty } from '@/contexts/PropertyContext';
import { getInventoryPipelineHealth } from '@/lib/db';
import type { InventoryPipelineHealth as Health } from '@/lib/db/ml-inventory-cockpit';
import { Activity } from 'lucide-react';

export function InventoryPipelineHealth() {
  const { user } = useAuth();
  const { activePropertyId } = useProperty();
  const [data, setData] = useState<Health | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user || !activePropertyId) return;
    (async () => {
      try {
        setData(await getInventoryPipelineHealth(activePropertyId));
      } catch (err) {
        console.error('InventoryPipelineHealth: fetch error', err);
      } finally {
        setLoading(false);
      }
    })();
  }, [user, activePropertyId]);

  return (
    <div style={{
      background: '#ffffff',
      border: '1px solid rgba(78,90,122,0.12)',
      borderRadius: '12px',
      padding: '24px',
      height: '100%',
    }}>
      <div style={{ marginBottom: '16px' }}>
        <h2 style={{ fontSize: '16px', fontWeight: 600, color: '#1b1c19', margin: 0 }}>
          Pipeline health
        </h2>
        <p style={{ fontSize: '12px', color: '#7a8a9e', marginTop: '4px' }}>
          When the model last did anything.
        </p>
      </div>

      {loading || !data ? (
        <div style={{ color: '#7a8a9e', fontSize: '13px' }}>Loading…</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
          <Row icon={<Activity size={14} />} label="Last training run" value={fmt(data.lastTrainingRunAt)} />
          <Row icon={<Activity size={14} />} label="Last inference write" value={fmt(data.lastInferenceWriteAt)} />
          <Row icon={<Activity size={14} />} label="Last anomaly fired" value={fmt(data.lastAnomalyFiredAt)} />
          <Row icon={<Activity size={14} />} label="Active item models" value={String(data.activeItemCount)} />
          <Row icon={<Activity size={14} />} label="Predictions in last 24h" value={String(data.predictionsLast24h)} />
        </div>
      )}
    </div>
  );
}

function fmt(d: Date | null): string {
  if (!d) return 'Never';
  const ms = Date.now() - d.getTime();
  const min = Math.round(ms / 60000);
  if (min < 60) return `${min} min ago`;
  const hr = Math.round(min / 60);
  if (hr < 48) return `${hr} hr ago`;
  const days = Math.round(hr / 24);
  return `${days} days ago`;
}

function Row({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingBottom: '12px',
      borderBottom: '1px solid rgba(78,90,122,0.06)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: '#7a8a9e', fontSize: '12px' }}>
        {icon}<span>{label}</span>
      </div>
      <div style={{ fontSize: '13px', color: '#1b1c19', fontWeight: 500 }}>{value}</div>
    </div>
  );
}
