/**
 * RecommendedHeadcountPill
 *
 * P6 — Renders the ML-recommended headcount at the top of the Schedule tab.
 *
 * Display (when active model exists AND ML enabled AND date is tomorrow):
 *   - Headline number in monospace, large
 *   - Confidence range (p80/p95) as: "Estimated {p80}-{p95} needed (80-95% confidence)"
 *   - Hover tooltip with: "Powered by ML model — last trained {date}, MAE {N} min"
 *   - "✎ Override" link → opens OverrideHeadcountModal
 *
 * When no active model OR ML disabled OR date is not tomorrow:
 *   - Renders nothing (preserves existing UX)
 */

'use client';

import React, { useState } from 'react';
import { Info, Pencil } from 'lucide-react';
import { OverrideHeadcountModal } from './OverrideHeadcountModal';
import {
  formatTrainedDate,
  formatMae,
} from '@/lib/ml-schedule-helpers';

interface RecommendedHeadcountPillProps {
  recommendedHeadcount: number | null;
  p80: number | null;
  p95: number | null;
  modelTrainedAt: Date | null;
  modelMae: number | null;
  propertyId: string;
  date: string;
  isActiveDate: boolean;
}

export function RecommendedHeadcountPill({
  recommendedHeadcount,
  p80,
  p95,
  modelTrainedAt,
  modelMae,
  propertyId,
  date,
  isActiveDate,
}: RecommendedHeadcountPillProps) {
  const [showOverride, setShowOverride] = useState(false);
  const [showTooltip, setShowTooltip] = useState(false);

  // Only render if we have an active recommendation AND this is the active date
  if (recommendedHeadcount === null || !isActiveDate) {
    return null;
  }

  const tooltipText =
    modelTrainedAt && modelMae !== null
      ? `Powered by ML model — last trained ${formatTrainedDate(modelTrainedAt)}, MAE ${formatMae(modelMae)}`
      : 'Powered by ML model';

  const confidenceRangeText =
    p80 && p95
      ? `Estimated ${p80}-${p95} needed (80-95% confidence)`
      : null;

  return (
    <>
      <div className="bg-gradient-to-r from-blue-50 to-indigo-50 border border-blue-200 rounded-lg px-4 py-3 mb-4">
        <div className="flex items-center justify-between gap-3">
          <div className="flex-1">
            <p className="text-xs font-semibold text-blue-600 uppercase tracking-wide mb-1">
              ML Recommendation
            </p>
            <div className="flex items-baseline gap-3">
              <div className="text-4xl font-mono font-bold text-blue-900">
                {recommendedHeadcount}
              </div>
              <div className="flex-1">
                {confidenceRangeText && (
                  <p className="text-sm text-blue-700">{confidenceRangeText}</p>
                )}
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {/* Info tooltip button */}
            <div className="relative">
              <button
                onMouseEnter={() => setShowTooltip(true)}
                onMouseLeave={() => setShowTooltip(false)}
                className="p-2 rounded hover:bg-blue-100 text-blue-600 transition-colors"
                title={tooltipText}
              >
                <Info className="w-4 h-4" />
              </button>

              {showTooltip && (
                <div className="absolute right-0 top-full mt-1 bg-slate-900 text-white text-xs rounded px-2 py-1 whitespace-nowrap z-10 shadow-lg">
                  {tooltipText}
                </div>
              )}
            </div>

            {/* Override button */}
            <button
              onClick={() => setShowOverride(true)}
              className="flex items-center gap-1 text-blue-600 hover:text-blue-700 text-sm font-medium px-2 py-1 rounded hover:bg-blue-100 transition-colors"
            >
              <Pencil className="w-3 h-3" />
              Override
            </button>
          </div>
        </div>
      </div>

      {/* Override modal */}
      <OverrideHeadcountModal
        isOpen={showOverride}
        onClose={() => setShowOverride(false)}
        propertyId={propertyId}
        date={date}
        optimizerRecommendation={recommendedHeadcount}
      />
    </>
  );
}
