'use client';

import React, { useEffect, useState, useCallback } from 'react';
import { withStaffLinkTokenBody } from '@/lib/staff-link-client';
import { CheckSquare, Square, X, AlertCircle } from 'lucide-react';
import type { HousekeeperLocale } from '@/lib/translations';
// Locally aliased so piece-A code keeps reading `lang: Language` everywhere.
type Language = HousekeeperLocale;
import { t } from '@/lib/translations';

/**
 * ChecklistModal — opens when the housekeeper taps "Open checklist" on an
 * in-progress room. Items are grouped by area and can be toggled on/off.
 * Toggles are optimistic — we flip the local state immediately, fire the
 * POST in the background, and revert if it fails.
 *
 * Templates are cached per cleaning-type in the parent component to avoid
 * a network round-trip every time the modal opens.
 */

export interface ChecklistItem {
  id: string;
  area: 'bathroom' | 'bedroom' | 'living' | 'kitchen' | 'entry' | 'amenities' | 'final';
  itemEn: string;
  itemEs: string;
  sortOrder: number;
  isCritical: boolean;
}

interface Props {
  roomNumber: string;
  items: ChecklistItem[];
  initialCheckedIds: string[];
  lang: Language;
  pid: string;
  staffId: string;
  roomId: string;
  onClose: () => void;
  onProgressChange: (checkedIds: string[]) => void;
}

const AREA_LABEL_KEYS: Record<ChecklistItem['area'], string> = {
  bathroom: 'hkAreaBathroom',
  bedroom: 'hkAreaBedroom',
  living: 'hkAreaLiving',
  kitchen: 'hkAreaKitchen',
  entry: 'hkAreaEntry',
  amenities: 'hkAreaAmenities',
  final: 'hkAreaFinal',
};

const AREA_ORDER: ChecklistItem['area'][] = [
  'entry',
  'bedroom',
  'bathroom',
  'amenities',
  'kitchen',
  'living',
  'final',
];

export function ChecklistModal(props: Props) {
  const { roomNumber, items, initialCheckedIds, lang, pid, staffId, roomId, onClose, onProgressChange } = props;

  const [checkedIds, setCheckedIds] = useState<Set<string>>(() => new Set(initialCheckedIds));

  // Keep local state in sync if the room data refreshes underneath us.
  useEffect(() => {
    setCheckedIds(new Set(initialCheckedIds));
  }, [initialCheckedIds]);

  const grouped = React.useMemo(() => {
    const map = new Map<ChecklistItem['area'], ChecklistItem[]>();
    for (const it of items) {
      const list = map.get(it.area) ?? [];
      list.push(it);
      map.set(it.area, list);
    }
    for (const list of map.values()) {
      list.sort((a, b) => a.sortOrder - b.sortOrder);
    }
    return map;
  }, [items]);

  const toggle = useCallback(
    async (itemId: string) => {
      const wasChecked = checkedIds.has(itemId);
      const next = new Set(checkedIds);
      if (wasChecked) next.delete(itemId);
      else next.add(itemId);
      setCheckedIds(next);
      onProgressChange(Array.from(next));

      try {
        const res = await fetch('/api/housekeeper/checklist/toggle', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(withStaffLinkTokenBody({
            pid,
            staffId,
            roomId,
            itemId,
            checked: !wasChecked,
          })),
        });
        if (!res.ok) throw new Error(`http ${res.status}`);
      } catch {
        // Revert on failure. Quiet — the offline banner will already be
        // showing if the network is the problem; we don't want a toast
        // for every checklist tap.
        setCheckedIds((curr) => {
          const reverted = new Set(curr);
          if (wasChecked) reverted.add(itemId);
          else reverted.delete(itemId);
          onProgressChange(Array.from(reverted));
          return reverted;
        });
      }
    },
    [checkedIds, onProgressChange, pid, staffId, roomId],
  );

  return (
    <div
      role="dialog"
      aria-modal="true"
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(15,23,42,0.55)',
        zIndex: 250,
        display: 'flex',
        alignItems: 'flex-end',
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        style={{
          width: '100%',
          maxWidth: '560px',
          margin: '0 auto',
          background: 'white',
          borderTopLeftRadius: '20px',
          borderTopRightRadius: '20px',
          maxHeight: '85dvh',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {/* Header */}
        <div
          style={{
            padding: '16px 18px 12px',
            display: 'flex',
            alignItems: 'flex-start',
            justifyContent: 'space-between',
            borderBottom: '1px solid #E5E7EB',
          }}
        >
          <div>
            <h2 style={{ fontSize: '18px', fontWeight: 800, margin: 0, color: '#0F172A' }}>
              {t('hkChecklistTitle', lang)}
            </h2>
            <p style={{ fontSize: '13px', color: '#6B7280', margin: '4px 0 0 0' }}>
              {t('hkRoomShort', lang)} {roomNumber} · {checkedIds.size} / {items.length} {t('hkChecklistChecked', lang)}
            </p>
          </div>
          <button
            onClick={onClose}
            aria-label={t('hkClose', lang)}
            style={{
              minHeight: '44px',
              minWidth: '44px',
              border: 'none',
              background: 'transparent',
              cursor: 'pointer',
              padding: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <X size={22} color="#374151" />
          </button>
        </div>

        {/* Optional advisory */}
        <div
          style={{
            padding: '10px 18px',
            fontSize: '12px',
            color: '#6B7280',
            background: '#F9FAFB',
            borderBottom: '1px solid #E5E7EB',
          }}
        >
          {t('hkChecklistOptional', lang)}
        </div>

        {/* Items by area */}
        <div style={{ overflowY: 'auto', padding: '8px 12px 24px' }}>
          {AREA_ORDER.filter((a) => grouped.has(a)).map((area) => {
            const list = grouped.get(area) ?? [];
            return (
              <div key={area} style={{ marginTop: '14px' }}>
                <div
                  style={{
                    fontSize: '11px',
                    fontWeight: 700,
                    color: '#6B7280',
                    letterSpacing: '0.08em',
                    textTransform: 'uppercase',
                    padding: '0 6px 6px',
                  }}
                >
                  {t(AREA_LABEL_KEYS[area] as never, lang)}
                </div>
                {list.map((item) => {
                  const isChecked = checkedIds.has(item.id);
                  const label = lang === 'es' ? item.itemEs : item.itemEn;
                  return (
                    <button
                      key={item.id}
                      onClick={() => toggle(item.id)}
                      style={{
                        width: '100%',
                        textAlign: 'left',
                        padding: '12px 10px',
                        background: isChecked ? '#F0FDF4' : 'white',
                        border: isChecked ? '1.5px solid #86EFAC' : '1.5px solid #E5E7EB',
                        borderRadius: '12px',
                        marginBottom: '6px',
                        cursor: 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        gap: '10px',
                        WebkitTapHighlightColor: 'transparent',
                        touchAction: 'manipulation',
                      }}
                    >
                      {isChecked ? (
                        <CheckSquare size={22} color="#15803D" />
                      ) : (
                        <Square size={22} color="#9CA3AF" />
                      )}
                      <span style={{ flex: 1, fontSize: '15px', color: '#111827', fontWeight: isChecked ? 500 : 600 }}>
                        {label}
                      </span>
                      {item.isCritical && (
                        <span
                          style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: '4px',
                            color: '#B45309',
                            fontSize: '11px',
                            fontWeight: 700,
                            padding: '2px 6px',
                            background: '#FFFBEB',
                            border: '1px solid #FCD34D',
                            borderRadius: '4px',
                          }}
                        >
                          <AlertCircle size={11} />
                          {t('hkCriticalItem', lang)}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
