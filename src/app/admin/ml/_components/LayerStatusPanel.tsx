'use client';

import React, { useEffect, useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { useProperty } from '@/contexts/PropertyContext';
import { getRecentModelRuns } from '@/lib/db';
import type { ModelRun } from '@/lib/db';
import { AlertCircle, Check, X, CheckCircle2 } from 'lucide-react';

interface LayerStatusPanelProps {
  layer: 'demand' | 'supply' | 'optimizer';
}

export function LayerStatusPanel({ layer }: LayerStatusPanelProps) {
  const { user } = useAuth();
  const { activePropertyId } = useProperty();

  const [models, setModels] = useState<ModelRun[]>([]);
  const [activeModel, setActiveModel] = useState<ModelRun | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user || !activePropertyId) return;

    (async () => {
      try {
        const allModels = await getRecentModelRuns(activePropertyId, 10);
        const forLayer = allModels.filter(m => m.layer === layer);
        setModels(forLayer);
        const active = forLayer.find(m => m.isActive);
        setActiveModel(active ?? null);
      } catch (err) {
        console.error(`LayerStatusPanel[${layer}]: fetch error`, err);
      } finally {
        setLoading(false);
      }
    })();
  }, [user, activePropertyId, layer]);

  const LAYER_LABELS: Record<string, { name: string; color: string }> = {
    demand: { name: 'Demand (L1)', color: '#004b4b' },
    supply: { name: 'Supply (L2)', color: '#0066cc' },
    optimizer: { name: 'Optimizer (L3)', color: '#8b5cf6' },
  };

  const label = LAYER_LABELS[layer];

  const checkActivationCriteria = (model: ModelRun) => {
    const hasEnoughData = model.trainingRowCount >= 500;
    const hasGoodMAE = model.validationMae !== null && model.validationMae < 5;
    const beatsBaseline = model.beatsBaselinePct !== null && model.beatsBaselinePct >= 0.20;
    return {
      hasEnoughData,
      hasGoodMAE,
      beatsBaseline,
      allPass: hasEnoughData && hasGoodMAE && beatsBaseline,
    };
  };

  return (
    <div style={{
      background: '#ffffff',
      border: `1px solid rgba(78,90,122,0.12)`,
      borderRadius: '12px',
      padding: '20px',
    }}>
      {/* Header */}
      <div style={{ marginBottom: '16px' }}>
        <h3 style={{
          fontSize: '15px',
          fontWeight: 600,
          color: label.color,
          margin: 0,
          marginBottom: '4px',
        }}>
          {label.name}
        </h3>
      </div>

      {loading ? (
        <div style={{ color: '#7a8a9e', fontSize: '13px' }}>Loading...</div>
      ) : !activeModel ? (
        <div style={{ color: '#7a8a9e', fontSize: '13px' }}>No active model</div>
      ) : (
        <>
          {/* Active Model Summary */}
          <div style={{
            background: 'rgba(0,101,101,0.04)',
            border: '1px solid rgba(0,101,101,0.1)',
            borderRadius: '8px',
            padding: '12px',
            marginBottom: '16px',
          }}>
            <div style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'flex-start',
              marginBottom: '8px',
            }}>
              <div>
                <div style={{ fontSize: '12px', fontWeight: 600, color: '#004b4b' }}>
                  {activeModel.modelVersion}
                </div>
                <div style={{ fontSize: '11px', color: '#7a8a9e', marginTop: '2px' }}>
                  {activeModel.algorithm}
                </div>
              </div>
              <div style={{ fontSize: '11px', color: '#7a8a9e', textAlign: 'right' }}>
                {new Date(activeModel.trainedAt).toLocaleDateString()} {new Date(activeModel.trainedAt).toLocaleTimeString()}
              </div>
            </div>

            {/* Metrics grid */}
            <div style={{
              display: 'grid',
              gridTemplateColumns: '1fr 1fr 1fr',
              gap: '8px',
              fontSize: '12px',
            }}>
              <div>
                <div style={{ color: '#7a8a9e' }}>Training Rows</div>
                <div style={{ fontWeight: 600, color: '#1b1c19' }}>
                  {activeModel.trainingRowCount.toLocaleString()}
                </div>
              </div>
              <div>
                <div style={{ color: '#7a8a9e' }}>Validation MAE</div>
                <div style={{ fontWeight: 600, color: '#1b1c19' }}>
                  {activeModel.validationMae?.toFixed(2) ?? '—'}
                </div>
              </div>
              <div>
                <div style={{ color: '#7a8a9e' }}>Beats Baseline</div>
                <div style={{ fontWeight: 600, color: '#1b1c19' }}>
                  {activeModel.beatsBaselinePct ? `${(activeModel.beatsBaselinePct * 100).toFixed(0)}%` : '—'}
                </div>
              </div>
            </div>
          </div>

          {/* Activation Criteria Checklist */}
          <div style={{ marginBottom: '16px' }}>
            <div style={{ fontSize: '12px', fontWeight: 600, color: '#454652', marginBottom: '8px' }}>
              Activation Criteria
            </div>
            {(() => {
              const criteria = checkActivationCriteria(activeModel);
              return [
                { label: 'N ≥ 500', pass: criteria.hasEnoughData },
                { label: 'MAE < 5', pass: criteria.hasGoodMAE },
                { label: 'Beats baseline ≥ 20%', pass: criteria.beatsBaseline },
              ].map((item, i) => (
                <div key={i} style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                  fontSize: '12px',
                  padding: '6px 0',
                  color: item.pass ? '#00a050' : '#dc3545',
                }}>
                  {item.pass ? (
                    <CheckCircle2 size={14} />
                  ) : (
                    <AlertCircle size={14} />
                  )}
                  <span>{item.label}</span>
                </div>
              ));
            })()}
          </div>

          {/* Recent Training Runs */}
          <div>
            <div style={{ fontSize: '12px', fontWeight: 600, color: '#454652', marginBottom: '8px' }}>
              Last 5 Training Runs
            </div>
            <div style={{ fontSize: '12px' }}>
              {models.slice(0, 5).map((m, i) => (
                <div key={i} style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  padding: '6px 0',
                  borderBottom: i < Math.min(4, models.length - 1) ? '1px solid rgba(78,90,122,0.06)' : 'none',
                  color: m.isActive ? '#004b4b' : '#7a8a9e',
                }}>
                  <span>{new Date(m.trainedAt).toLocaleDateString()}</span>
                  <span>{m.validationMae?.toFixed(2) ?? '—'}</span>
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
