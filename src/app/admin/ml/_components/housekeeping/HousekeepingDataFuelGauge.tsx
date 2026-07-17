'use client';

import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from 'recharts';
import { DataFuelGauge } from '../DataFuelGauge';

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
 *
 * The card chrome + milestone progress bar is shared with
 * InventoryDataFuelGauge via DataFuelGauge; the throwaway-rate callout and
 * the stacked recorded/discarded chart are HK-specific slot content.
 */

interface CommonProps {
  totalEvents: number;
  eventsLast7d: number;
  eventsLast24h: number;
  eventsLast1h: number;
  /** Total discarded (throwaway) taps — under-3-min auto-discards + Done→Reset undos. */
  totalDiscardedEvents: number;
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

  const headline = props.mode === 'single' ? 'Cleaning data fuel' : 'Cleaning data fuel — network';
  const subtitle = props.mode === 'single'
    ? 'Done-taps captured. The demand model needs ~200 events to start training.'
    : `Done-taps captured across ${props.hotelCount} ${props.hotelCount === 1 ? 'hotel' : 'hotels'}.`;

  const historyDisplay = props.mode === 'single'
    ? `${props.daysOfHistory}`
    : (props.daysOfHistoryRange.min === props.daysOfHistoryRange.max
        ? `${props.daysOfHistoryRange.min}`
        : `${props.daysOfHistoryRange.min}–${props.daysOfHistoryRange.max}`);

  const stats = (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: '16px', marginBottom: '12px' }}>
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
  );

  const chart = (
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
  );

  return (
    <DataFuelGauge
      headline={headline}
      subtitle={subtitle}
      total={total}
      milestones={MILESTONES}
      milestoneNoun="events"
      stats={stats}
      // Throwaway tap rate — when this is high it means staff are tapping
      // Done by accident or tapping Start without a Stop. Worth surfacing
      // so Reeyen can spot bad UX or training issues.
      extraRow={<ThrowawayRow recorded={props.totalEvents} discarded={props.totalDiscardedEvents} />}
      chart={chart}
    />
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div style={{ fontSize: '20px', fontWeight: 600, color: '#1b1c19' }}>{value}</div>
      <div style={{ fontSize: '11px', color: '#7a8a9e', marginTop: '2px' }}>{label}</div>
    </div>
  );
}

function ThrowawayRow({ recorded, discarded }: { recorded: number; discarded: number }) {
  const total = recorded + discarded;
  if (total === 0) return null;
  const pct = Math.round((discarded / total) * 1000) / 10;     // one decimal
  const isHigh = pct >= 30;
  const isMid = pct >= 15;
  const color = isHigh ? '#dc3545' : isMid ? '#f0ad4e' : '#7a8a9e';
  const message = isHigh
    ? 'High throwaway rate — likely accidental Done-taps or Done→Reset undos. Worth checking app UX or training.'
    : isMid
    ? 'Some throwaway taps — normal at small N but watch for trend.'
    : 'Throwaway rate looks healthy.';
  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: '12px',
      padding: '10px 12px',
      background: '#f7fafb',
      border: '1px solid rgba(78,90,122,0.08)',
      borderRadius: '8px',
      marginBottom: '20px',
    }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
        <div style={{ fontSize: '11px', color: '#7a8a9e', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
          Throwaway tap rate
        </div>
        <div style={{ fontSize: '12px', color: '#454652' }}>
          {discarded.toLocaleString()} throwaway / {total.toLocaleString()} total · {message}
        </div>
      </div>
      <div style={{ fontSize: '22px', fontWeight: 700, color, flexShrink: 0 }}>
        {pct}%
      </div>
    </div>
  );
}
