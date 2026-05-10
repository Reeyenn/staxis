'use client';

import React from 'react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from 'recharts';

const MILESTONES = [50, 200, 500, 2000, 5000];

/**
 * Housekeeping data fuel gauge — total cleaning events captured.
 *
 * Two modes:
 *   • "single" — one hotel
 *   • "fleet"  — sum across hotels (with daysOfHistoryRange = min-max)
 *
 * Recorded vs discarded distinction matters here: 'discarded' status
 * captures Done-taps under 3 minutes (accidental) or over 90 minutes
 * (forgotten Stop). They're a signal of HK app usage even when not
 * counted as "real cleans."
 */

interface CommonProps {
  totalEvents: number;
  eventsLast7d: number;
  eventsLast24h: number;
  distinctStaff: number;
  distinctRooms: number;
  /** 30-day per-day series; recorded vs discarded tallies */
  dailyEventSeries: Array<{ date: string; recorded: number; discarded: number }>;
}

interface SingleModeProps extends CommonProps {
  mode: 'single';
  daysOfHistory: number;
  hotelName: string;
}

interface FleetModeProps extends CommonProps {
  mode: 'fleet';
  hotelCount: number;
  daysOfHistoryRange: { min: number; max: number };
}

export function HousekeepingDataFuelGauge(props: SingleModeProps | FleetModeProps) {
  const total = props.totalEvents;
  const nextMilestone = MILESTONES.find((m) => m > total) ?? MILESTONES[MILESTONES.length - 1];
  const prevMilestone = MILESTONES.filter((m) => m <= total).pop() ?? 0;
  const progressToNext = nextMilestone > prevMilestone
    ? ((total - prevMilestone) / (nextMilestone - prevMilestone)) * 100
    : 100;

  const headline = props.mode === 'single' ? 'Cleaning data fuel' : 'Cleaning data fuel — network';
  const subtitle = props.mode === 'single'
    ? 'Done-taps captured. The demand model needs ~200 events to start training.'
    : `Done-taps captured across ${props.hotelCount} ${props.hotelCount === 1 ? 'hotel' : 'hotels'}.`;

  const historyDisplay = props.mode === 'single'
    ? `${props.daysOfHistory}`
    : (props.daysOfHistoryRange.min === props.daysOfHistoryRange.max
        ? `${props.daysOfHistoryRange.min}`
        : `${props.daysOfHistoryRange.min}–${props.daysOfHistoryRange.max}`);

  return (
    <div style={cardStyle}>
      <div style={{ marginBottom: '16px' }}>
        <h2 style={{ fontSize: '16px', fontWeight: 600, color: '#1b1c19', margin: 0 }}>
          {headline}
        </h2>
        <p style={{ fontSize: '12px', color: '#7a8a9e', marginTop: '4px' }}>{subtitle}</p>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: '16px', marginBottom: '20px' }}>
        <Stat label="Total events" value={total.toLocaleString()} />
        <Stat label="Last 7 days" value={props.eventsLast7d.toLocaleString()} />
        <Stat label="Last 24 hours" value={props.eventsLast24h.toLocaleString()} />
        <Stat label="Staff" value={props.distinctStaff.toLocaleString()} />
        <Stat label="Rooms cleaned" value={props.distinctRooms.toLocaleString()} />
        <Stat
          label={props.mode === 'fleet' ? 'Days of history (range)' : 'Days of history'}
          value={historyDisplay}
        />
      </div>

      {/* Progress bar to next milestone */}
      <div style={{ marginBottom: '20px' }}>
        <div style={{
          display: 'flex', justifyContent: 'space-between',
          fontSize: '11px', color: '#7a8a9e', marginBottom: '6px',
        }}>
          <span>Next milestone: {nextMilestone.toLocaleString()} events</span>
          <span>{Math.round(progressToNext)}%</span>
        </div>
        <div style={{ height: '6px', background: '#f0f4f7', borderRadius: '3px', overflow: 'hidden' }}>
          <div style={{
            width: `${Math.min(100, Math.max(0, progressToNext))}%`,
            height: '100%',
            background: '#004b4b',
            transition: 'width 0.4s',
          }} />
        </div>
      </div>

      {/* Daily activity chart — recorded vs discarded stacked */}
      <div style={{ height: '200px' }}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={props.dailyEventSeries} margin={{ top: 8, right: 8, bottom: 8, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(78,90,122,0.1)" />
            <XAxis dataKey="date" tick={{ fontSize: 11, fill: '#7a8a9e' }} />
            <YAxis tick={{ fontSize: 11, fill: '#7a8a9e' }} allowDecimals={false} />
            <Tooltip
              contentStyle={{
                background: '#ffffff',
                border: '1px solid rgba(78,90,122,0.15)',
                borderRadius: '8px',
                fontSize: '12px',
              }}
            />
            <Legend wrapperStyle={{ fontSize: 11 }} />
            <Bar dataKey="recorded" stackId="a" name="Real cleans" fill="#004b4b" radius={[2, 2, 0, 0]} />
            <Bar dataKey="discarded" stackId="a" name="Throwaway taps" fill="#cdd5dd" />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

const cardStyle: React.CSSProperties = {
  background: '#ffffff',
  border: '1px solid rgba(78,90,122,0.12)',
  borderRadius: '12px',
  padding: '24px',
};

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div style={{ fontSize: '20px', fontWeight: 600, color: '#1b1c19' }}>{value}</div>
      <div style={{ fontSize: '11px', color: '#7a8a9e', marginTop: '2px' }}>{label}</div>
    </div>
  );
}
