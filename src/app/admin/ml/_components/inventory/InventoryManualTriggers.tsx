'use client';

import React, { useState } from 'react';
import { useProperty } from '@/contexts/PropertyContext';
import { Zap, AlertCircle } from 'lucide-react';
import { supabase } from '@/lib/supabase';

export function InventoryManualTriggers() {
  const { activePropertyId } = useProperty();
  const [loading, setLoading] = useState<string | null>(null);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const triggerAction = async (action: 'retrain' | 'run-inference') => {
    if (!activePropertyId) return;
    setLoading(action);
    setMessage(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const res = await fetch(`/api/admin/ml/inventory/${action}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}),
        },
        body: JSON.stringify({ propertyId: activePropertyId }),
      });
      const json = await res.json();
      if (!res.ok || !json.ok) {
        const detail = json.error || `HTTP ${res.status}`;
        throw new Error(detail);
      }
      const summary = action === 'retrain'
        ? `Trained ${json.result?.items_trained ?? 0} items, ${json.result?.items_with_auto_fill ?? 0} graduated`
        : `Predicted ${json.result?.predicted ?? 0} items`;
      setMessage({ type: 'success', text: summary });
    } catch (err) {
      setMessage({ type: 'error', text: (err as Error).message ?? 'Request failed' });
    } finally {
      setLoading(null);
    }
  };

  return (
    <div style={{
      background: '#ffffff',
      border: '1px solid rgba(78,90,122,0.12)',
      borderRadius: '12px',
      padding: '24px',
      height: '100%',
    }}>
      <div style={{ marginBottom: '20px' }}>
        <h2 style={{ fontSize: '16px', fontWeight: 600, color: '#1b1c19', margin: 0 }}>
          Manual triggers
        </h2>
        <p style={{ fontSize: '12px', color: '#7a8a9e', marginTop: '4px' }}>
          Owner-only actions
        </p>
      </div>

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

      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
        {[
          { label: 'Retrain all items now', action: 'retrain' as const },
          { label: 'Run inference now', action: 'run-inference' as const },
        ].map((btn) => (
          <button
            key={btn.action}
            onClick={() => triggerAction(btn.action)}
            disabled={loading !== null}
            style={{
              padding: '10px 12px',
              background: loading === btn.action ? '#7a8a9e' : (loading ? '#d0d0d0' : '#004b4b'),
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
            }}
          >
            <Zap size={14} />
            {loading === btn.action ? 'Working…' : btn.label}
          </button>
        ))}
      </div>

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
          Training takes ~1 second per item (so ~1 minute for a full hotel). Inference is faster.
        </div>
      </div>
    </div>
  );
}
