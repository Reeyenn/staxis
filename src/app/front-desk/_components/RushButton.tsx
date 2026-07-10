'use client';

import React, { useState } from 'react';
import { Zap, X, Clock } from 'lucide-react';
import { useLang } from '@/contexts/LanguageContext';
import { useProperty } from '@/contexts/PropertyContext';
import { t } from '@/lib/translations';
import { useToast, ToastHost } from '@/app/_components/ui/toast';

/**
 * RushButton — front-desk clerk taps this on a room tile to ask the
 * housekeeper to prioritize it. Opens a small picker (15min / 30min /
 * 1hr), then POSTs /api/front-desk/rush which sets the flag on the room
 * row + the cleaning_tasks row + fires an SMS to the assigned housekeeper.
 *
 * Designed to drop into the selected-room modal on /front-desk; renders
 * inline with the existing "Early Checkout" / "Mark Extension" buttons.
 */
interface Props {
  roomNumber: string;
  isAlreadyRush?: boolean;
  /** Called after a successful set/clear so the parent can refetch. */
  onChange?: (next: { cleared: boolean; smsSent: boolean }) => void;
}

const OPTIONS = [
  { key: '15min' as const, labelKey: 'rush15min' },
  { key: '30min' as const, labelKey: 'rush30min' },
  { key: '1hr'   as const, labelKey: 'rush1hr'   },
];

export function RushButton({ roomNumber, isAlreadyRush, onChange }: Props) {
  const { lang } = useLang();
  const { activePropertyId } = useProperty();
  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  // Shared toast primitive (F7) — 3s dark pill, bottom-center.
  const { toasts, show: showToast } = useToast({ durationMs: 3000, max: 1 });

  const handlePick = async (due: '15min' | '30min' | '1hr') => {
    if (!activePropertyId || submitting) return;
    setSubmitting(true);
    try {
      const res = await fetch('/api/front-desk/rush', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pid: activePropertyId,
          room_number: roomNumber,
          due_label: due,
        }),
      });
      const json = (await res.json().catch(() => null)) as
        | { ok?: boolean; data?: { cleared?: boolean; smsSent?: boolean } }
        | null;
      if (res.ok && json?.ok) {
        showToast(json.data?.smsSent ? t('rushNotifySent', lang) : t('rushSubmit', lang));
        setOpen(false);
        onChange?.({ cleared: false, smsSent: !!json.data?.smsSent });
      } else {
        showToast("Couldn't set rush");
      }
    } catch {
      showToast("Couldn't set rush");
    } finally {
      setSubmitting(false);
    }
  };

  const handleClear = async () => {
    if (!activePropertyId || submitting) return;
    setSubmitting(true);
    try {
      const res = await fetch('/api/front-desk/rush', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pid: activePropertyId,
          room_number: roomNumber,
          clear: true,
        }),
      });
      if (res.ok) {
        showToast(t('rushCleared', lang));
        setOpen(false);
        onChange?.({ cleared: true, smsSent: false });
      } else {
        showToast("Couldn't clear rush");
      }
    } catch {
      showToast("Couldn't clear rush");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        disabled={submitting}
        style={{
          flex: 1,
          padding: '16px',
          background: isAlreadyRush ? '#DC2626' : '#B45309',
          color: '#FFFFFF',
          border: 'none',
          borderRadius: '9999px',
          fontWeight: 600,
          fontSize: '15px',
          cursor: submitting ? 'not-allowed' : 'pointer',
          fontFamily: 'Inter, sans-serif',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '8px',
        }}
      >
        <Zap size={18} strokeWidth={2.5} />
        {isAlreadyRush ? t('rushClearButton', lang) : t('rushButton', lang)}
      </button>

      {open && (
        <div
          role="dialog"
          aria-modal="true"
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(15,23,42,0.55)',
            zIndex: 240,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 16,
          }}
          onClick={(e) => {
            if (e.target === e.currentTarget) setOpen(false);
          }}
        >
          <div
            style={{
              width: '100%',
              maxWidth: 420,
              background: 'white',
              borderRadius: 20,
              padding: 22,
              display: 'flex',
              flexDirection: 'column',
              gap: 16,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <h3 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: '#0F172A' }}>
                {t('rushTitle', lang)} · {roomNumber}
              </h3>
              <button
                onClick={() => setOpen(false)}
                aria-label="Close"
                style={{
                  minHeight: 36,
                  minWidth: 36,
                  border: 'none',
                  background: 'transparent',
                  cursor: 'pointer',
                  padding: 0,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <X size={18} color="#374151" />
              </button>
            </div>

            <p style={{ margin: 0, color: '#374151', fontSize: 14 }}>{t('rushPrompt', lang)}</p>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {OPTIONS.map((opt) => (
                <button
                  key={opt.key}
                  onClick={() => handlePick(opt.key)}
                  disabled={submitting}
                  style={{
                    padding: '14px',
                    background: '#FEF3C7',
                    border: '1.5px solid #FCD34D',
                    borderRadius: 12,
                    color: '#92400E',
                    fontSize: 15,
                    fontWeight: 700,
                    cursor: submitting ? 'not-allowed' : 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                  }}
                >
                  <Clock size={16} />
                  {t(opt.labelKey as never, lang)}
                </button>
              ))}
            </div>

            {isAlreadyRush && (
              <button
                onClick={handleClear}
                disabled={submitting}
                style={{
                  padding: '12px',
                  background: '#F3F4F6',
                  border: '1px solid #D1D5DB',
                  borderRadius: 12,
                  color: '#374151',
                  fontSize: 14,
                  fontWeight: 600,
                  cursor: submitting ? 'not-allowed' : 'pointer',
                }}
              >
                {t('rushClearButton', lang)}
              </button>
            )}
          </div>
        </div>
      )}

      <ToastHost
        toasts={toasts}
        position="bottom"
        offset="24px"
        zIndex={250}
        toastStyle={{
          background: '#0F172A',
          color: 'white',
          padding: '10px 16px',
          borderRadius: 999,
          fontSize: 13,
        }}
      />
    </>
  );
}
