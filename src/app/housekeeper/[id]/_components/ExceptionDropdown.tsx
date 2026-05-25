'use client';

import React, { useState } from 'react';
import { X, AlertTriangle } from 'lucide-react';
import type { Language } from '@/lib/translations';
import { t } from '@/lib/translations';
import type { ExceptionType } from '@/lib/housekeeper-workflow/state-machine';

/**
 * ExceptionDropdown — opens when the housekeeper taps the ⋯ button on a
 * room card. Five options:
 *
 *   • DND       — Do Not Disturb
 *   • NSR       — No Service Required
 *   • DLA       — Double-Lock Active
 *   • Sleep Out — Guest paid but never arrived
 *   • Skipped   — Couldn't clean, needs supervisor
 *
 * If the room already has an exception, the modal becomes a "clear
 * exception" confirmation. Optional note is sent with every exception so
 * the manager dashboard can see context.
 */

interface Props {
  roomNumber: string;
  currentException: ExceptionType | null;
  lang: Language;
  pid: string;
  staffId: string;
  roomId: string;
  onClose: () => void;
  onSubmit: (next: { type: ExceptionType | null; note: string | null }) => Promise<void>;
}

const OPTIONS: { type: ExceptionType; labelKey: string; descKey: string }[] = [
  { type: 'dnd', labelKey: 'hkExceptionDnd', descKey: 'hkExceptionDndDescription' },
  { type: 'nsr', labelKey: 'hkExceptionNsr', descKey: 'hkExceptionNsrDescription' },
  { type: 'dla', labelKey: 'hkExceptionDla', descKey: 'hkExceptionDlaDescription' },
  { type: 'sleep_out', labelKey: 'hkExceptionSleepOut', descKey: 'hkExceptionSleepOutDescription' },
  { type: 'skipped', labelKey: 'hkExceptionSkipped', descKey: 'hkExceptionSkippedDescription' },
];

export function ExceptionDropdown({
  roomNumber,
  currentException,
  lang,
  onClose,
  onSubmit,
}: Props) {
  const [selectedType, setSelectedType] = useState<ExceptionType | null>(currentException);
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (nextType: ExceptionType | null) => {
    setSubmitting(true);
    try {
      await onSubmit({ type: nextType, note: note.trim() || null });
      onClose();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(15,23,42,0.55)',
        zIndex: 250,
        display: 'flex',
        alignItems: 'flex-end',
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
          padding: '18px 18px 24px',
          maxHeight: '80dvh',
          overflowY: 'auto',
        }}
      >
        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '14px' }}>
          <div>
            <h2 style={{ fontSize: '18px', fontWeight: 800, margin: 0, color: '#0F172A' }}>
              {t('hkExceptionLabel', lang)}
            </h2>
            <p style={{ fontSize: '13px', color: '#6B7280', margin: '4px 0 0 0' }}>
              {t('hkRoomShort', lang)} {roomNumber}
            </p>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
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

        {/* Clear button if an exception is already set */}
        {currentException && (
          <button
            onClick={() => handleSubmit(null)}
            disabled={submitting}
            style={{
              width: '100%',
              padding: '12px',
              background: '#FEF2F2',
              border: '1.5px solid #FCA5A5',
              borderRadius: '10px',
              color: '#991B1B',
              fontSize: '14px',
              fontWeight: 700,
              cursor: submitting ? 'not-allowed' : 'pointer',
              marginBottom: '14px',
              WebkitTapHighlightColor: 'transparent',
            }}
          >
            {t('hkExceptionClear', lang)}
          </button>
        )}

        {/* Exception type options */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {OPTIONS.map((opt) => {
            const isSelected = selectedType === opt.type;
            const isCurrent = currentException === opt.type;
            return (
              <button
                key={opt.type}
                onClick={() => setSelectedType(opt.type)}
                disabled={submitting}
                style={{
                  textAlign: 'left',
                  padding: '12px 14px',
                  borderRadius: '12px',
                  border: isSelected ? '2px solid #2563EB' : '1.5px solid #E5E7EB',
                  background: isSelected ? '#EFF6FF' : 'white',
                  cursor: submitting ? 'not-allowed' : 'pointer',
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: '10px',
                  WebkitTapHighlightColor: 'transparent',
                  touchAction: 'manipulation',
                }}
              >
                <AlertTriangle
                  size={20}
                  color={isSelected ? '#2563EB' : '#9CA3AF'}
                  style={{ flexShrink: 0, marginTop: '2px' }}
                />
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: '15px', fontWeight: 700, color: '#111827' }}>
                    {t(opt.labelKey as never, lang)}
                    {isCurrent && (
                      <span style={{ marginLeft: '6px', fontSize: '11px', color: '#6B7280', fontWeight: 600 }}>
                        (current)
                      </span>
                    )}
                  </div>
                  <div style={{ fontSize: '13px', color: '#6B7280', marginTop: '2px' }}>
                    {t(opt.descKey as never, lang)}
                  </div>
                </div>
              </button>
            );
          })}
        </div>

        {/* Optional note */}
        {selectedType && selectedType !== currentException && (
          <div style={{ marginTop: '14px' }}>
            <label style={{ fontSize: '13px', color: '#374151', fontWeight: 600 }}>
              {t('hkExceptionAddNoteOptional', lang)}
            </label>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={2}
              style={{
                width: '100%',
                marginTop: '6px',
                padding: '10px',
                boxSizing: 'border-box',
                border: '1.5px solid #E5E7EB',
                borderRadius: '10px',
                fontSize: '15px',
                fontFamily: 'inherit',
                resize: 'none',
                outline: 'none',
              }}
            />
          </div>
        )}

        {/* Confirm */}
        {selectedType && selectedType !== currentException && (
          <button
            onClick={() => handleSubmit(selectedType)}
            disabled={submitting}
            style={{
              width: '100%',
              marginTop: '14px',
              height: '54px',
              border: 'none',
              borderRadius: '12px',
              background: submitting ? 'var(--border)' : '#2563EB',
              color: 'white',
              fontSize: '17px',
              fontWeight: 700,
              cursor: submitting ? 'not-allowed' : 'pointer',
              WebkitTapHighlightColor: 'transparent',
              touchAction: 'manipulation',
            }}
          >
            {submitting ? '...' : t('hkExceptionConfirm', lang)}
          </button>
        )}
      </div>
    </div>
  );
}
