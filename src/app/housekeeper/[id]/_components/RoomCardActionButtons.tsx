'use client';

import React, { useState } from 'react';
import { Eye, NotebookPen, X } from 'lucide-react';
import { t, type HousekeeperLocale } from '@/lib/translations';
import { withStaffLinkTokenBody } from '@/lib/staff-link-client';
import {
  smallBtnStyle,
  smallBtnLabelStyle,
  overlayStyle,
  dialogStyle,
  closeBtnStyle,
  primaryBtnStyle,
} from './dialog-styles';

/**
 * Two small per-room action buttons that the housekeeper can tap from
 * a job card: "Add Note" + "Mark for Inspection".
 *
 * Both are offline-aware via the enqueueIfOffline helper passed in from
 * the page. The note dialog is inline (no separate modal file) because
 * it's a single textarea — kept the surface area minimal.
 */
interface CommonProps {
  pid: string;
  staffId: string;
  roomId: string;
  lang: HousekeeperLocale;
  enqueueIfOffline: (opts: {
    endpoint: string;
    body: Record<string, unknown>;
    label: string;
  }) => Promise<{ ok: boolean; queued: boolean; data?: unknown; status?: number }>;
  onError: (msg: string) => void;
}

export function AddNoteButton({
  initialNote,
  ...props
}: CommonProps & { initialNote: string | null }) {
  const { pid, staffId, roomId, lang, enqueueIfOffline, onError } = props;
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState(initialNote ?? '');
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async () => {
    if (submitting) return;
    setSubmitting(true);
    try {
      const res = await enqueueIfOffline({
        endpoint: '/api/housekeeper/add-note',
        // The gate authenticates the per-staff link token, not the raw
        // pid+staffId tuple — and the queued body is replayed verbatim later,
        // so the token must be captured at enqueue time.
        body: withStaffLinkTokenBody({ pid, staffId, roomId, noteText: note.trim() }),
        label: `Note · room ${roomId}`,
      });
      if (!res.ok && !res.queued) {
        onError(t('hkErrCouldntSaveIssue', lang));
        return;
      }
      setOpen(false);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        aria-label={t('hkAddNote', lang)}
        style={smallBtnStyle}
      >
        <NotebookPen size={14} color="#4B5563" />
        <span style={smallBtnLabelStyle}>{t('hkAddNote', lang)}</span>
      </button>

      {open && (
        <div
          role="dialog"
          aria-modal="true"
          style={overlayStyle}
          onClick={(e) => {
            if (e.target === e.currentTarget) setOpen(false);
          }}
        >
          <div style={dialogStyle}>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                marginBottom: 12,
              }}
            >
              <h3 style={{ margin: 0, fontSize: 17, fontWeight: 700, color: '#0F172A' }}>
                {t('hkAddNoteTitle', lang)}
              </h3>
              <button
                onClick={() => setOpen(false)}
                aria-label={t('hkClose', lang)}
                style={closeBtnStyle}
              >
                <X size={18} color="#374151" />
              </button>
            </div>
            <textarea
              autoFocus
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder={t('hkAddNotePlaceholder', lang)}
              rows={4}
              maxLength={1000}
              style={{
                width: '100%',
                padding: 12,
                border: '1.5px solid #D1D5DB',
                borderRadius: 10,
                fontSize: 15,
                fontFamily: 'inherit',
                boxSizing: 'border-box',
                resize: 'none',
                outline: 'none',
              }}
            />
            <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
              <button
                onClick={() => {
                  setNote('');
                }}
                style={secondaryBtnStyle}
              >
                {t('hkAddNoteClear', lang)}
              </button>
              <button
                onClick={handleSubmit}
                disabled={submitting}
                style={{
                  ...primaryBtnStyle,
                  background: submitting ? '#D1D5DB' : '#15803D',
                }}
              >
                {submitting ? '...' : t('hkAddNoteSubmit', lang)}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

export function MarkForInspectionButton(props: CommonProps & { markedAt: string | null }) {
  const { pid, staffId, roomId, lang, enqueueIfOffline, onError, markedAt } = props;
  const [submitting, setSubmitting] = useState(false);
  const [marked, setMarked] = useState(!!markedAt);

  const handleClick = async () => {
    if (submitting) return;
    setSubmitting(true);
    const next = !marked;
    setMarked(next); // optimistic
    try {
      const res = await enqueueIfOffline({
        endpoint: '/api/housekeeper/mark-for-inspection',
        body: withStaffLinkTokenBody({ pid, staffId, roomId, clear: !next }),
        label: `Inspection · room ${roomId}`,
      });
      if (!res.ok && !res.queued) {
        setMarked(!next); // revert
        onError(t('hkErrMarkInspection', lang));
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <button
      onClick={handleClick}
      aria-pressed={marked}
      aria-label={marked ? t('hkMarkedForInspection', lang) : t('hkMarkForInspection', lang)}
      style={{
        ...smallBtnStyle,
        background: marked ? '#EFF6FF' : 'transparent',
        borderColor: marked ? '#93C5FD' : '#E5E7EB',
        opacity: submitting ? 0.5 : 1,
      }}
    >
      <Eye size={14} color={marked ? '#1E40AF' : '#4B5563'} />
      <span
        style={{
          ...smallBtnLabelStyle,
          color: marked ? '#1E40AF' : '#4B5563',
        }}
      >
        {marked ? t('hkMarkedForInspection', lang) : t('hkMarkForInspection', lang)}
      </span>
    </button>
  );
}

const secondaryBtnStyle: React.CSSProperties = {
  flex: 1,
  height: 48,
  border: '1px solid #D1D5DB',
  borderRadius: 10,
  background: 'white',
  color: '#374151',
  fontSize: 15,
  fontWeight: 600,
  cursor: 'pointer',
};
