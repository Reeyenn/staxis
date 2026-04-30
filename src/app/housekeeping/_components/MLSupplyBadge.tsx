/**
 * MLSupplyBadge
 *
 * P6 — Subtle indicator that supply predictions are driving auto-assign workload.
 *
 * Render near the workload-minutes display when supply predictions are active.
 * Low-key visual — small "ML" superscript or tiny dot + hover tooltip.
 * Tooltip: "Workload computed from ML model, last trained {date}"
 */

'use client';

import React, { useState } from 'react';
import { Zap } from 'lucide-react';
import { formatTrainedDate } from '@/lib/ml-schedule-helpers';

interface MLSupplyBadgeProps {
  modelTrainedAt: Date | null;
  isActive: boolean;
}

export function MLSupplyBadge({
  modelTrainedAt,
  isActive,
}: MLSupplyBadgeProps) {
  const [showTooltip, setShowTooltip] = useState(false);

  if (!isActive) return null;

  const tooltipText = modelTrainedAt
    ? `Workload computed from ML model, last trained ${formatTrainedDate(modelTrainedAt)}`
    : 'Workload computed from ML model';

  return (
    <div className="relative inline-block ml-1">
      <button
        onMouseEnter={() => setShowTooltip(true)}
        onMouseLeave={() => setShowTooltip(false)}
        className="inline-flex items-center justify-center"
        title={tooltipText}
        aria-label={tooltipText}
      >
        <Zap className="w-3 h-3 text-amber-500 fill-amber-500" />
      </button>

      {showTooltip && (
        <div className="absolute left-1/2 -translate-x-1/2 top-full mt-1 bg-slate-900 text-white text-xs rounded px-2 py-1 whitespace-nowrap z-10 shadow-lg pointer-events-none">
          {tooltipText}
        </div>
      )}
    </div>
  );
}
