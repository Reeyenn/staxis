'use client';

/**
 * MlHealthPanel — per-property ML health card on /admin/properties/[id]
 * (Snow design).
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
import { T, FONT_SANS, FONT_MONO, FONT_SERIF, Caps, Pill, MonoNum } from './_snow';

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
  return (
    <Pill tone={isColdStart ? 'caramel' : 'sage'}>
      {isColdStart ? 'cold-start' : algo}
    </Pill>
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
    <div style={{ marginTop: 24, fontFamily: FONT_SANS }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
        <div>
          <Caps>Layers</Caps>
          <h2 style={{
            fontFamily: FONT_SERIF, fontSize: 24, fontWeight: 400,
            letterSpacing: '-0.02em', color: T.ink, margin: '2px 0 0',
            lineHeight: 1.15, display: 'flex', alignItems: 'center', gap: 10,
          }}>
            <Activity size={18} color={T.ink} />
            ML <span style={{ fontStyle: 'italic' }}>health</span>
          </h2>
        </div>
        {data && (
          <span style={{ fontFamily: FONT_MONO, fontSize: 11, color: T.ink3, letterSpacing: '0.04em' }}>
            cohort: {data.cohort.brand ?? '—'} · {data.cohort.region ?? '—'} · {data.cohort.sizeTier ?? '—'}
          </span>
        )}
      </div>

      {loading && (
        <p style={{ fontSize: 12, color: T.ink2, display: 'flex', alignItems: 'center', gap: 6 }}>
          <Loader2 size={12} style={{ animation: 'spin 1s linear infinite' }} /> Loading…
        </p>
      )}

      {error && (
        <p style={{ fontSize: 12, color: T.warm }}>Error: {error}</p>
      )}

      {data && (
        <div style={{ border: `1px solid ${T.rule}`, borderRadius: 14, overflow: 'hidden', background: T.paper }}>
          {data.layers.map((layer, idx) => (
            <div key={layer.layer} style={{
              padding: '14px 16px',
              borderBottom: idx < data.layers.length - 1 ? `1px solid ${T.rule}` : 'none',
              display: 'grid',
              gridTemplateColumns: '120px 1fr 1fr',
              gap: 14,
              alignItems: 'center',
              fontSize: 12.5,
            }}>
              <div style={{ fontWeight: 600, fontSize: 14, color: T.ink, letterSpacing: '-0.005em' }}>
                {LAYER_LABEL[layer.layer]}
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {layer.activeModel ? (
                  <>
                    <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                      {algorithmBadge(layer.activeModel.algorithm, layer.activeModel.isColdStart)}
                      <span style={{ fontFamily: FONT_MONO, fontSize: 10, color: T.ink3, letterSpacing: '0.04em' }}>
                        {layer.activeModel.id.slice(0, 8)}…
                      </span>
                    </div>
                    <div style={{ color: T.ink2, fontSize: 11.5, lineHeight: 1.5 }}>
                      trained {relativeTime(layer.activeModel.trainedAt)}
                      <span style={{ fontFamily: FONT_MONO }}> · {layer.activeModel.trainingRowCount} rows</span>
                      {layer.activeModel.validationMae != null && (
                        <span style={{ fontFamily: FONT_MONO }}> · MAE {layer.activeModel.validationMae.toFixed(2)}</span>
                      )}
                      {layer.activeModel.beatsBaselinePct != null && layer.activeModel.beatsBaselinePct > 0 && (
                        <span style={{ fontFamily: FONT_MONO, color: T.sageDeep }}> · beats {(layer.activeModel.beatsBaselinePct * 100).toFixed(0)}%</span>
                      )}
                    </div>
                  </>
                ) : (
                  <div style={{ color: T.ink2, fontStyle: 'italic', fontFamily: FONT_SERIF }}>
                    {layer.note ?? 'No active model'}
                  </div>
                )}
              </div>

              <div style={{ textAlign: 'right' }}>
                <div style={{ display: 'inline-flex', alignItems: 'baseline', gap: 6 }}>
                  <MonoNum size={16} weight={600}>{layer.predictionCountToday}</MonoNum>
                  <span style={{ color: T.ink3, fontSize: 11 }}>
                    {layer.predictionCountToday === 1 ? 'pred today' : 'preds today'}
                  </span>
                </div>
                <div style={{ color: T.ink3, fontSize: 10.5, marginTop: 2, fontFamily: FONT_MONO, letterSpacing: '0.04em' }}>
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
