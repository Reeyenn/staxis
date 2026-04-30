'use client';

import React, { useState } from 'react';
import { useProperty } from '@/contexts/PropertyContext';
import { Zap, AlertCircle } from 'lucide-react';

export function ManualTriggers() {
  const { activePropertyId } = useProperty();

  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const triggerAction = async (action: 'train-demand' | 'run-inference' | 'run-optimizer') => {
    setLoading(true);
    setMessage(null);

    // Stub: endpoint doesn't exist yet
    alert(`[STUB] Endpoint coming soon: /api/admin/ml/${action}`);
    setLoading(false);

    /* When the endpoint is built, replace the above with:
    try {
      const res = await fetch(`/api/admin/ml/${action}`, { method: 'POST' });
      if (!res.ok) throw new Error('Request failed');
      setMessage({ type: 'success', text: 'Request sent successfully' });
    } catch (err) {
      setMessage({ type: 'error', text: 'Request failed' });
    } finally {
      setLoading(false);
    }
    */
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
          Manual Triggers
        </h2>
        <p style={{ fontSize: '12px', color: '#7a8a9e', marginTop: '4px' }}>
          Owner-only actions
        </p>
      </div>

      {/* Message */}
      {message && (
        <div style={{
          padding: '12px',
          marginBottom: '16px',
          borderRadius: '8px',
          fontSize: '12px',
          background: message.type === 'success' ? 'rgba(0,160,80,0.1)' : 'rgba(220,52,69,0.1)',
          color: message.type === 'success' ? '#00a050' : '#dc3545',
          border: `1px solid ${message.type === 'success' ? 'rgba(0,160,80,0.2)' : 'rgba(220,52,69,0.2)'}`,
        }}>
          {message.text}
        </div>
      )}

      {/* Buttons */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
        {[
          { label: 'Train Demand Now', action: 'train-demand' as const },
          { label: 'Run Inference Now', action: 'run-inference' as const },
          { label: 'Run Optimizer Now', action: 'run-optimizer' as const },
        ].map(btn => (
          <button
            key={btn.action}
            onClick={() => triggerAction(btn.action)}
            disabled={loading}
            style={{
              padding: '10px 12px',
              background: loading ? '#d0d0d0' : '#004b4b',
              color: '#ffffff',
              border: 'none',
              borderRadius: '8px',
              fontSize: '13px',
              fontWeight: 500,
              cursor: loading ? 'not-allowed' : 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '6px',
              transition: 'background 0.15s',
            }}
            onMouseEnter={e => !loading && (e.currentTarget.style.background = '#00656a')}
            onMouseLeave={e => !loading && (e.currentTarget.style.background = '#004b4b')}
          >
            <Zap size={14} />
            {btn.label}
          </button>
        ))}
      </div>

      {/* Info */}
      <div style={{
        marginTop: '16px',
        padding: '12px',
        background: 'rgba(0,101,101,0.04)',
        border: '1px solid rgba(0,101,101,0.1)',
        borderRadius: '8px',
        fontSize: '11px',
        color: '#7a8a9e',
        display: 'flex',
        alignItems: 'flex-start',
        gap: '8px',
      }}>
        <AlertCircle size={14} style={{ flexShrink: 0, marginTop: '2px' }} />
        <div>
          Endpoints coming soon. These actions are currently stubbed.
        </div>
      </div>
    </div>
  );
}
