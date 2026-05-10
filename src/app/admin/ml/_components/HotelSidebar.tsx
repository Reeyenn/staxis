'use client';

import React from 'react';
import { useRouter, usePathname, useSearchParams } from 'next/navigation';
import { Building2, CheckCircle2, AlertTriangle, Circle } from 'lucide-react';

/**
 * Shared hotel selector rail for the ML Cockpit (Inventory + Housekeeping
 * tabs use the same component). Lists every platform property with a tiny
 * status pip; click switches the cockpit to that hotel via
 * `?propertyId=<uuid>`. The "All hotels" entry at the top is the
 * network/aggregate view (no propertyId param).
 *
 * Status pips:
 *   • 🟢 healthy  — training fresh + predictions fresh
 *   • 🟡 warming  — bootstrap state, no first run yet
 *   • 🔴 issue    — training >8d stale or predictions >36h stale
 *
 * The status semantics are tab-specific (computed by each tab's API
 * endpoint) but the colors and pip rendering are shared.
 */

export interface HotelSidebarEntry {
  id: string;
  name: string;
  brand: string | null;
  status: 'healthy' | 'warming' | 'issue';
  /** Plain-English count tag: "99 events" / "112 counts" / etc. Optional. */
  volumeLabel: string | null;
  /** "Joined 14 days ago" — short tag under hotel name. Optional. */
  joinedLabel: string | null;
  /** True for test properties; render with a 🧪 chip + dim styling. */
  isTest: boolean;
  /** Last-hour activity ("3 working" / "2 counting"). Renders next to status. */
  activeNowLabel: string | null;
}

export function HotelSidebar({
  properties,
  selectedPropertyId,
  totalNetworkCount,
  /** Which tab the user is on — preserved when switching hotels. */
  activeTab,
}: {
  properties: HotelSidebarEntry[];
  /** null when "All hotels" is the active view. */
  selectedPropertyId: string | null;
  /** Number of hotels for the "All hotels (N)" label. */
  totalNetworkCount: number;
  activeTab: 'inventory' | 'housekeeping';
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // We use router.push (not replace) — replace silently no-ops in some
  // turbopack/RSC interactions even when the resulting URL differs. push
  // always emits a history entry, which is also better UX (back button
  // returns to the previous hotel).
  const setProperty = (id: string | null) => {
    const params = new URLSearchParams(searchParams.toString());
    if (id) params.set('propertyId', id);
    else params.delete('propertyId');
    if (params.get('tab') !== activeTab) {
      if (activeTab === 'housekeeping') params.delete('tab');
      else params.set('tab', activeTab);
    }
    const target = `${pathname}${params.toString() ? `?${params.toString()}` : ''}`;
    router.push(target, { scroll: false });
  };

  return (
    <div style={{
      background: '#ffffff',
      border: '1px solid rgba(78,90,122,0.12)',
      borderRadius: '12px',
      padding: '16px',
      position: 'sticky',
      top: '24px',
      maxHeight: 'calc(100vh - 48px)',
      overflowY: 'auto',
    }}>
      <div style={{ marginBottom: '12px' }}>
        <h3 style={{ fontSize: '13px', fontWeight: 600, color: '#1b1c19', margin: 0,
          textTransform: 'uppercase', letterSpacing: '0.06em',
        }}>
          Hotels ({totalNetworkCount})
        </h3>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
        {/* All hotels entry */}
        <SidebarRow
          active={selectedPropertyId === null}
          onClick={() => setProperty(null)}
          icon={<Building2 size={14} color={selectedPropertyId === null ? '#004b4b' : '#7a8a9e'} />}
          title="All hotels"
          subtitle={`${totalNetworkCount} ${totalNetworkCount === 1 ? 'hotel' : 'hotels'}`}
          status={null}
          volumeLabel={null}
          joinedLabel={null}
          activeNowLabel={null}
          isTest={false}
        />

        {/* Divider */}
        <div style={{ height: '1px', background: 'rgba(78,90,122,0.10)', margin: '6px 0' }} />

        {/* Per-hotel entries */}
        {properties.map((p) => (
          <SidebarRow
            key={p.id}
            active={selectedPropertyId === p.id}
            onClick={() => setProperty(p.id)}
            icon={null}
            title={p.name}
            subtitle={p.brand ?? ''}
            status={p.status}
            volumeLabel={p.volumeLabel}
            joinedLabel={p.joinedLabel}
            activeNowLabel={p.activeNowLabel}
            isTest={p.isTest}
          />
        ))}

        {properties.length === 0 && (
          <div style={{ padding: '12px', color: '#7a8a9e', fontSize: '12px', textAlign: 'center' }}>
            No hotels yet
          </div>
        )}
      </div>
    </div>
  );
}

function SidebarRow({
  active,
  onClick,
  icon,
  title,
  subtitle,
  status,
  volumeLabel,
  joinedLabel,
  activeNowLabel,
  isTest,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode | null;
  title: string;
  subtitle: string;
  status: 'healthy' | 'warming' | 'issue' | null;
  volumeLabel: string | null;
  joinedLabel: string | null;
  activeNowLabel: string | null;
  isTest: boolean;
}) {
  // Compose the meta line under the hotel name. Order: brand · volume ·
  // active-now · joined. Skip empty parts. Tested property gets a 🧪 prefix.
  const metaParts: string[] = [];
  if (subtitle) metaParts.push(subtitle);
  if (volumeLabel) metaParts.push(volumeLabel);
  if (activeNowLabel) metaParts.push(activeNowLabel);
  if (joinedLabel) metaParts.push(joinedLabel);
  const meta = metaParts.join(' · ');

  return (
    <button
      onClick={onClick}
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: '8px',
        width: '100%',
        padding: '8px 10px',
        background: active ? 'rgba(0,75,75,0.06)' : 'transparent',
        border: active ? '1px solid rgba(0,75,75,0.2)' : '1px solid transparent',
        borderRadius: '8px',
        cursor: 'pointer',
        textAlign: 'left',
        transition: 'background 0.15s',
        opacity: isTest ? 0.65 : 1,    // dim test properties so they read as secondary
      }}
      onMouseEnter={e => !active && (e.currentTarget.style.background = 'rgba(0,0,0,0.03)')}
      onMouseLeave={e => !active && (e.currentTarget.style.background = 'transparent')}
    >
      {icon}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          display: 'flex', alignItems: 'center', gap: '5px',
          fontSize: '13px',
          fontWeight: active ? 600 : 500,
          color: active ? '#004b4b' : '#1b1c19',
        }}>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
            {title}
          </span>
          {isTest && (
            <span title="Test property — excluded from fleet aggregates" style={{
              fontSize: '9px', fontWeight: 600,
              padding: '1px 5px',
              background: 'rgba(122,138,158,0.12)',
              color: '#454652',
              borderRadius: '4px',
              flexShrink: 0,
            }}>
              TEST
            </span>
          )}
        </div>
        {meta && (
          <div style={{
            fontSize: '11px', color: '#7a8a9e', marginTop: '2px',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>
            {meta}
          </div>
        )}
      </div>
      {status && <div style={{ paddingTop: '2px', flexShrink: 0 }}><StatusPip status={status} /></div>}
    </button>
  );
}

function StatusPip({ status }: { status: 'healthy' | 'warming' | 'issue' }) {
  if (status === 'healthy') {
    return <CheckCircle2 size={12} color="#00a050" />;
  }
  if (status === 'issue') {
    return <AlertTriangle size={12} color="#dc3545" />;
  }
  return <Circle size={12} color="#f0ad4e" fill="#f0ad4e" />;
}
