'use client';

import React from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import type { PropertySidebarEntry } from '@/app/api/admin/ml/inventory/cockpit-data/route';
import { Building2, CheckCircle2, AlertTriangle, Circle } from 'lucide-react';

/**
 * Hotel selector rail for the Inventory cockpit. Lists every platform
 * property with a tiny status pip; click switches the cockpit to that
 * hotel via `?propertyId=<uuid>`. The "All hotels" entry at the top is
 * the network/aggregate view (no propertyId param).
 *
 * Status pips:
 *   • 🟢 healthy  — training fresh + predictions fresh
 *   • 🟡 warming  — bootstrap state, no first run yet
 *   • 🔴 issue    — training >8d stale or predictions >36h stale
 */
export function InventoryHotelSidebar({
  properties,
  selectedPropertyId,
  totalNetworkCount,
}: {
  properties: PropertySidebarEntry[];
  /** null when "All hotels" is the active view. */
  selectedPropertyId: string | null;
  /** Number of hotels for the "All hotels (N)" label. */
  totalNetworkCount: number;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();

  const setProperty = (id: string | null) => {
    const params = new URLSearchParams(searchParams.toString());
    if (id) params.set('propertyId', id);
    else params.delete('propertyId');
    if (params.get('tab') !== 'inventory') params.set('tab', 'inventory');
    router.replace(`/admin/ml${params.toString() ? `?${params.toString()}` : ''}`, { scroll: false });
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
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode | null;
  title: string;
  subtitle: string;
  status: 'healthy' | 'warming' | 'issue' | null;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        width: '100%',
        padding: '8px 10px',
        background: active ? 'rgba(0,75,75,0.06)' : 'transparent',
        border: active ? '1px solid rgba(0,75,75,0.2)' : '1px solid transparent',
        borderRadius: '8px',
        cursor: 'pointer',
        textAlign: 'left',
        transition: 'background 0.15s',
      }}
      onMouseEnter={e => !active && (e.currentTarget.style.background = 'rgba(0,0,0,0.03)')}
      onMouseLeave={e => !active && (e.currentTarget.style.background = 'transparent')}
    >
      {icon}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          fontSize: '13px',
          fontWeight: active ? 600 : 500,
          color: active ? '#004b4b' : '#1b1c19',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}>
          {title}
        </div>
        {subtitle && (
          <div style={{ fontSize: '11px', color: '#7a8a9e', marginTop: '1px' }}>
            {subtitle}
          </div>
        )}
      </div>
      {status && <StatusPip status={status} />}
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
