'use client';

import React, { useEffect, useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { useProperty } from '@/contexts/PropertyContext';
import { getPipelineHealth } from '@/lib/db';
import { CheckCircle2, AlertCircle, Clock } from 'lucide-react';

interface Health {
  lastTrainingRunAt?: Date;
  lastInferenceRunAt?: Date;
  lastShadowLogAt?: Date;
}

export function PipelineHealth() {
  const { user } = useAuth();
  const { activePropertyId } = useProperty();

  const [health, setHealth] = useState<Health>({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user || !activePropertyId) return;

    (async () => {
      try {
        const result = await getPipelineHealth(activePropertyId);
        setHealth(result);
      } catch (err) {
        console.error('PipelineHealth: fetch error', err);
      } finally {
        setLoading(false);
      }
    })();
  }, [user, activePropertyId]);

  const formatTime = (date?: Date): string => {
    if (!date) return 'Never';
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    const diffHrs = Math.floor(diffMins / 60);
    if (diffHrs < 24) return `${diffHrs}h ago`;
    const diffDays = Math.floor(diffHrs / 24);
    return `${diffDays}d ago`;
  };

  const getHealthStatus = (date?: Date): 'healthy' | 'warning' | 'error' => {
    if (!date) return 'error';
    const now = new Date();
    const diffMins = (now.getTime() - date.getTime()) / 60000;
    if (diffMins < 60) return 'healthy';
    if (diffMins < 24 * 60) return 'warning';
    return 'error';
  };

  const statusColor = (status: 'healthy' | 'warning' | 'error'): string => {
    if (status === 'healthy') return '#00a050';
    if (status === 'warning') return '#f0ad4e';
    return '#dc3545';
  };

  return (
    <div style={{
      background: '#ffffff',
      border: '1px solid rgba(78,90,122,0.12)',
      borderRadius: '12px',
      padding: '24px',
    }}>
      {/* Header */}
      <div style={{ marginBottom: '20px' }}>
        <h2 style={{ fontSize: '16px', fontWeight: 600, color: '#1b1c19', margin: 0 }}>
          Pipeline Health
        </h2>
      </div>

      {loading ? (
        <div style={{ color: '#7a8a9e', fontSize: '13px' }}>Loading...</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          {[
            { label: 'Last Training', date: health.lastTrainingRunAt },
            { label: 'Last Inference', date: health.lastInferenceRunAt },
            { label: 'Last Shadow Log', date: health.lastShadowLogAt },
          ].map((item, i) => {
            const status = getHealthStatus(item.date);
            const color = statusColor(status);
            return (
              <div key={i} style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '12px',
                background: status === 'healthy' ? 'rgba(0,160,80,0.04)' : status === 'warning' ? 'rgba(240,173,78,0.04)' : 'rgba(220,52,69,0.04)',
                borderRadius: '8px',
                borderLeft: `3px solid ${color}`,
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  {status === 'healthy' ? (
                    <CheckCircle2 size={16} color={color} />
                  ) : (
                    <AlertCircle size={16} color={color} />
                  )}
                  <span style={{ fontSize: '13px', fontWeight: 500, color: '#1b1c19' }}>
                    {item.label}
                  </span>
                </div>
                <span style={{ fontSize: '12px', color: color, fontWeight: 600 }}>
                  {formatTime(item.date)}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
