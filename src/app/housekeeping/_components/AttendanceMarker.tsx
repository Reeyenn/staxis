/**
 * AttendanceMarker
 *
 * P6 — End-of-shift "marked attended" toggle for each housekeeper.
 *
 * Renders two circular toggles per HK in the crew card:
 *   "✓ Showed up" / "✗ No-show"
 *
 * State stored in `attendance_marks` table via `markAttendance()`.
 * Visually compact — 16x16 toggles, subtle styling.
 * Disabled before 6 PM CT (only meaningful at end of shift).
 * Tooltip explains "End-of-shift confirmation — feeds the ML model."
 */

'use client';

import React, { useState, useEffect } from 'react';
import { Check, X } from 'lucide-react';
import { markAttendance } from '@/lib/db/attendance';

interface AttendanceMarkerProps {
  propertyId: string;
  date: string;
  staffId: string;
  staffName: string;
  attended: boolean | null;
  onUpdate?: (attended: boolean) => void;
}

export function AttendanceMarker({
  propertyId,
  date,
  staffId,
  staffName,
  attended,
  onUpdate,
}: AttendanceMarkerProps) {
  const [loading, setLoading] = useState(false);
  const [isEnabledByTime, setIsEnabledByTime] = useState(false);

  // Check if we're past 6 PM CT — only then should attendance marking be enabled
  useEffect(() => {
    const checkTime = () => {
      const now = new Date();
      const ct = new Date(
        now.toLocaleString('en-US', { timeZone: 'America/Chicago' })
      );
      const hour = ct.getHours();
      setIsEnabledByTime(hour >= 18); // 6 PM = 18:00
    };

    checkTime();
    const timer = setInterval(checkTime, 60000); // recheck every minute
    return () => clearInterval(timer);
  }, []);

  const handleToggle = async (newAttended: boolean) => {
    setLoading(true);
    try {
      await markAttendance({
        propertyId,
        date,
        staffId,
        attended: newAttended,
      });
      if (onUpdate) onUpdate(newAttended);
    } catch (err) {
      console.error('Failed to mark attendance:', err);
    } finally {
      setLoading(false);
    }
  };

  const title = 'End-of-shift confirmation — feeds the ML model';

  if (!isEnabledByTime) {
    return (
      <div
        title={title}
        className="flex items-center gap-1 opacity-50 cursor-not-allowed"
      >
        <div className="w-5 h-5 rounded-full border border-slate-300 bg-slate-50" />
        <span className="text-xs text-slate-400">—</span>
        <div className="w-5 h-5 rounded-full border border-slate-300 bg-slate-50" />
      </div>
    );
  }

  return (
    <div
      title={title}
      className="flex items-center gap-1"
    >
      {/* Showed up button */}
      <button
        onClick={() => handleToggle(true)}
        disabled={loading}
        className={`w-5 h-5 rounded-full border-2 flex items-center justify-center transition-colors ${
          attended === true
            ? 'bg-green-100 border-green-500'
            : 'border-slate-300 bg-white hover:border-green-500 hover:bg-green-50'
        } disabled:opacity-50 disabled:cursor-not-allowed`}
        aria-label={`Mark ${staffName} as attended`}
      >
        {attended === true && (
          <Check className="w-3 h-3 text-green-600" />
        )}
      </button>

      {/* No-show button */}
      <button
        onClick={() => handleToggle(false)}
        disabled={loading}
        className={`w-5 h-5 rounded-full border-2 flex items-center justify-center transition-colors ${
          attended === false
            ? 'bg-red-100 border-red-500'
            : 'border-slate-300 bg-white hover:border-red-500 hover:bg-red-50'
        } disabled:opacity-50 disabled:cursor-not-allowed`}
        aria-label={`Mark ${staffName} as no-show`}
      >
        {attended === false && (
          <X className="w-3 h-3 text-red-600" />
        )}
      </button>
    </div>
  );
}
