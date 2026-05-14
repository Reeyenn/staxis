'use client';

/**
 * MlHealthPanel — per-property ML health card on /admin/properties/[id].
 *
 * Answers "why doesn't hotel X have predictions?" without psql. Shows a
 * row per layer (inventory, demand, supply, optimizer) with:
 *   - active model id + algorithm + cold-start flag
 *   - training row count + holdout MAE + baseline-beat %
 *   - last prediction at + count for today
 *
 * A cold-start row signals the layer is serving cohort priors (good Day
 * 1) — operator should expect wider quantile bands until enough local
 * data accumulates for the full Bayesian / XGBoost path.
 */

import React, { useEffect, useState } from 'react';
import { fetchWithAuth } from '@/lib/api-fetch';
import { Activity, Loader2 } from 'lucide-react';

type Layer = 'inventory_rate' | 'demand' | 'supply' | 'optimizer';

interface ActiveModel {
  id: string;
  algorithm: string;
  modelVersion: string;
  trainedAt: string;
  isColdStart: boolean;
  trainingRowCount: number;
  validationMae: number | null;
  beatsBaselinePct: number | null;
  consecutivePassingRuns: number | null;
}

interface LayerHealth {
  layer: Layer;
  activeModel: ActiveModel | null;
  lastPredictionAt: string | null;
  predictionCountToday: number;
  note: string | null;
}

interface MlHealthData {
  cohort: { brand: string | null; region: string | null; sizeTier: string | null };
  layers: LayerHealth[];
}

const LAYER_LABEL: Record<Layer, string> = {
  inventory_rate: 'Inventory',
  demand: 'Demand',
  supply: 'Supply',
  optimizer: 'Optimizer',
};

function relativeTime(iso: string | null): string {
  if (!iso) return 'never';
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return 'just now';
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}

function algorithmBadge(algo: string, isColdStart: boolean): React.ReactNode {
  const isFull = !isColdStart;
  const bg = isColdStart
    ? 'var(--amber-dim, rgba(245,158,11,0.12))'
    : 'var(--green-dim, rgba(16,185,129,0.12))';
  const fg = isColdStart ? 'var(--amber, #f59e0b)' : 'var(--green, #10b981)';
  const label = isColdStart ? 'cold-start' : isFull ? algo : algo;
  return (
    <span style={{
      display: 'inline-block',
      padding: '2px 8px',
      borderRadius: '999px',
      background: bg,
      color: fg,
      fontSize: '11px',
      fontWeight: 600,
      fontFamily: 'var(--font-mono)',
    }}>{label}</span>
  );
}

export function MlHealthPanel({ propertyId }: { propertyId: string }) {
  const [data, setData] = useState<MlHealthData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchWithAuth(`/api/admin/ml-health?propertyId=${propertyId}`)
      .then((r) => r.json())
      .then((body: { ok?: boolean; data?: MlHealthData; error?: string }) => {
        if (cancelled) return;
        if (body.ok && body.data) setData(body.data);
        else setError(body.error ?? 'Failed to load ML health');
      })
      .catch((e: Error) => { if (!cancelled) setError(e.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [propertyId]);

  return (
    <div style={{ marginTop: '20px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
        <h2 style={{ fontSize: '15px', fontWeight: 700, display: 'flex', alignItems: 'center', gap: '8px' }}>
          <Activity size={16} /> ML health
        </h2>
        {data && (
          <span style={{ fontSize: '11px', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
            cohort: {data.cohort.brand ?? '—'} · {data.cohort.region ?? '—'} · {data.cohort.sizeTier ?? '—'}
          </span>
        )}
      </div>

      {loading && (
        <p style={{ fontSize: '12px', color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: '6px' }}>
          <Loader2 size={12} style={{ animation: 'spin 1s linear infinite' }} /> Loading…
        </p>
      )}

      {error && (
        <p style={{ fontSize: '12px', color: 'var(--red)' }}>Error: {error}</p>
      )}

      {data && (
        <div style={{ border: '1px solid var(--border)', borderRadius: '10px', overflow: 'hidden' }}>
          {data.layers.map((layer, idx) => (
            <div key={layer.layer} style={{
              padding: '12px 14px',
              borderBottom: idx < data.layers.length - 1 ? '1px solid var(--border)' : 'none',
              display: 'grid',
              gridTemplateColumns: '110px 1fr 1fr',
              gap: '12px',
              alignItems: 'center',
              fontSize: '12px',
            }}>
              <div style={{ fontWeight: 600, fontSize: '13px' }}>
                {LAYER_LABEL[layer.layer]}
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                {layer.activeModel ? (
                  <>
                    <div style={{ display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' }}>
                      {algorithmBadge(layer.activeModel.algorithm, layer.activeModel.isColdStart)}
                      <span style={{ fontFamily: 'var(--font-mono)', fontSize: '10px', color: 'var(--text-muted)' }}>
                        {layer.activeModel.id.slice(0, 8)}…
                      </span>
                    </div>
                    <div style={{ color: 'var(--text-muted)', fontSize: '11px' }}>
                      trained {relativeTime(layer.activeModel.trainedAt)} · {layer.activeModel.trainingRowCount} rows
                      {layer.activeModel.validationMae != null && (
                        <> · MAE {layer.activeModel.validationMae.toFixed(2)}</>
                      )}
                      {layer.activeModel.beatsBaselinePct != null && layer.activeModel.beatsBaselinePct > 0 && (
                        <> · beats baseline {(layer.activeModel.beatsBaselinePct * 100).toFixed(0)}%</>
                      )}
                    </div>
                  </>
                ) : (
                  <div style={{ color: 'var(--text-muted)' }}>
                    {layer.note ?? 'No active model'}
                  </div>
                )}
              </div>

              <div style={{ textAlign: 'right' }}>
                <div style={{ color: 'var(--text-primary)' }}>
                  <strong>{layer.predictionCountToday}</strong>
                  <span style={{ color: 'var(--text-muted)' }}> {layer.predictionCountToday === 1 ? 'prediction' : 'predictions'} today</span>
                </div>
                <div style={{ color: 'var(--text-muted)', fontSize: '11px', marginTop: '2px' }}>
                  last {relativeTime(layer.lastPredictionAt)}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
