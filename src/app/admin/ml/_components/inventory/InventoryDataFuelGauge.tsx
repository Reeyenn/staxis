'use client';

import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { DataFuelGauge } from '../DataFuelGauge';

const MILESTONES = [10, 50, 200, 500, 2000];

/**
 * Inventory data fuel gauge — shows how much count data exists.
 *
 * Two modes:
 *   • "single" — one hotel's counts
 *   • "fleet"  — sum across all hotels (with daysOfHistoryRange = min-max
 *                across the network)
 *
 * Data is server-computed and passed in via props. The card chrome +
 * milestone progress bar is shared with HousekeepingDataFuelGauge via
 * DataFuelGauge; the stat strip and daily chart are inventory-specific slots.
 */

interface CommonProps {
  totalCounts: number;
  countsLast7d: number;
  countsLast24h: number;
  itemsTracked: number;
  /** 30-day per-day count series, oldest→newest, MM-DD label */
  dailyCountSeries: Array<{ date: string; recorded: number }>;
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

export function InventoryDataFuelGauge(props: SingleModeProps | FleetModeProps) {
  const total = props.totalCounts;

  const headline = props.mode === 'single' ? 'Inventory data fuel' : 'Inventory data fuel — network';
  const subtitle = props.mode === 'single'
    ? 'Count events captured. The model needs ~30 events per item to graduate that item to auto-fill.'
    : `Total counts captured across ${props.hotelCount} ${props.hotelCount === 1 ? 'hotel' : 'hotels'}.`;

  const historyDisplay = props.mode === 'single'
    ? `${props.daysOfHistory}`
    : (props.daysOfHistoryRange.min === props.daysOfHistoryRange.max
        ? `${props.daysOfHistoryRange.min}`
        : `${props.daysOfHistoryRange.min}–${props.daysOfHistoryRange.max}`);

  const stats = (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: '16px', marginBottom: '20px' }}>
      <Stat label="Total counts" value={total.toLocaleString()} />
      <Stat label="Last 7 days" value={props.countsLast7d.toLocaleString()} />
      <Stat label="Last 24 hours" value={props.countsLast24h.toLocaleString()} />
      <Stat label="Items tracked" value={props.itemsTracked.toLocaleString()} />
      <Stat
        label={props.mode === 'fleet' ? 'Days of history (range)' : 'Days of history'}
        value={historyDisplay}
      />
    </div>
  );

  const chart = (
    <div style={{ height: '180px' }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={props.dailyCountSeries} margin={{ top: 8, right: 8, bottom: 8, left: 0 }}>
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
          <Bar dataKey="recorded" fill="#004b4b" radius={[2, 2, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );

  return (
    <DataFuelGauge
      headline={headline}
      subtitle={subtitle}
      total={total}
      milestones={MILESTONES}
      milestoneNoun="counts"
      stats={stats}
      chart={chart}
    />
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div style={{ fontSize: '22px', fontWeight: 600, color: '#1b1c19' }}>{value}</div>
      <div style={{ fontSize: '11px', color: '#7a8a9e', marginTop: '2px' }}>{label}</div>
    </div>
  );
}
