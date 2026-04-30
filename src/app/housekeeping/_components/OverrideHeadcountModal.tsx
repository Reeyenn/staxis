/**
 * OverrideHeadcountModal
 *
 * P10 — Modal for Maria to override the optimizer's headcount recommendation.
 * Opens from the "✎ Override" link on the recommended-headcount pill.
 *
 * UI:
 *   - Number input pre-filled with optimizer's recommendation
 *   - Optional reason textarea (max 500 chars)
 *   - Save / Cancel buttons
 *
 * On save:
 *   - POST to /api/ml/override with propertyId, date, recommendation, manual count, reason
 *   - Close modal + show green toast "Override saved"
 *   - Parent caller handles refresh if needed
 */

'use client';

import React, { useState } from 'react';
import { X, Check, AlertCircle } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import { fetchWithAuth } from '@/lib/api-fetch';
import type { ApiResponse } from '@/lib/api-response';

interface OverrideHeadcountModalProps {
  isOpen: boolean;
  onClose: () => void;
  propertyId: string;
  date: string;
  optimizerRecommendation: number;
  onSuccess?: () => void;
}

export function OverrideHeadcountModal({
  isOpen,
  onClose,
  propertyId,
  date,
  optimizerRecommendation,
  onSuccess,
}: OverrideHeadcountModalProps) {
  const [manualHeadcount, setManualHeadcount] = useState(optimizerRecommendation);
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const handleSave = async () => {
    if (manualHeadcount < 1 || manualHeadcount > 50) {
      setError('Headcount must be between 1 and 50');
      return;
    }

    setSaving(true);
    setError(null);

    try {
      const response = await fetchWithAuth('/api/ml/override', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          propertyId,
          date,
          optimizerRecommendation,
          manualHeadcount,
          reason: reason.trim() || undefined,
        }),
      });

      const data = (await response.json()) as ApiResponse;

      if (!data.ok) {
        setError(data.error ?? 'Failed to save override');
        setSaving(false);
        return;
      }

      // Show success state briefly, then close
      setSuccess(true);
      setTimeout(() => {
        onClose();
        if (onSuccess) onSuccess();
        // Reset state for next open
        setSuccess(false);
        setManualHeadcount(optimizerRecommendation);
        setReason('');
      }, 1000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Network error');
      setSaving(false);
    }
  };

  if (!isOpen) return null;

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Override Headcount Recommendation">
      <div className="space-y-4">
        {/* Current recommendation display */}
        <div className="bg-slate-50 rounded px-3 py-2 text-sm">
          <p className="text-slate-600">Model recommends: <span className="font-mono font-semibold">{optimizerRecommendation}</span></p>
        </div>

        {/* Manual headcount input */}
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">
            Your Decision
          </label>
          <input
            type="number"
            min="1"
            max="50"
            value={manualHeadcount}
            onChange={(e) => setManualHeadcount(Math.max(1, parseInt(e.target.value) || 1))}
            disabled={saving || success}
            className="w-full px-3 py-2 border border-slate-300 rounded font-mono text-lg font-semibold focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-slate-100 disabled:text-slate-400"
          />
        </div>

        {/* Reason textarea */}
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">
            Reason (optional)
          </label>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value.slice(0, 500))}
            disabled={saving || success}
            placeholder="e.g., 'Cindy out sick', 'Convention this weekend', etc."
            maxLength={500}
            rows={3}
            className="w-full px-3 py-2 border border-slate-300 rounded text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-slate-100 disabled:text-slate-400 resize-none"
          />
          <p className="text-xs text-slate-500 mt-1">{reason.length}/500</p>
        </div>

        {/* Error display */}
        {error && (
          <div className="bg-red-50 border border-red-200 rounded px-3 py-2 flex items-start gap-2">
            <AlertCircle className="w-4 h-4 text-red-600 mt-0.5 flex-shrink-0" />
            <p className="text-sm text-red-700">{error}</p>
          </div>
        )}

        {/* Success state */}
        {success && (
          <div className="bg-green-50 border border-green-200 rounded px-3 py-2 flex items-start gap-2">
            <Check className="w-4 h-4 text-green-600 mt-0.5 flex-shrink-0" />
            <p className="text-sm text-green-700">Override saved</p>
          </div>
        )}

        {/* Buttons */}
        <div className="flex gap-2 justify-end pt-4 border-t border-slate-200">
          <button
            onClick={onClose}
            disabled={saving || success}
            className="px-4 py-2 text-slate-700 border border-slate-300 rounded hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={saving || success}
            className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
          >
            {saving && <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />}
            Save Override
          </button>
        </div>
      </div>
    </Modal>
  );
}
