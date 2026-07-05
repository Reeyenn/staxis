'use client';

import React, { useRef, useState } from 'react';
import { withStaffLinkTokenBody } from '@/lib/staff-link-client';
import { PackageSearch, X, Camera } from 'lucide-react';
import { t, type HousekeeperLocale } from '@/lib/translations';

/**
 * Per-room "Found an item" action for the housekeeper page. Mirrors
 * AddNoteButton: inline dialog, offline-aware via enqueueIfOffline, bilingual.
 * Adds an optional photo (uploaded via the found-item presign route when
 * online). Writes a 'found' row into the Lost & Found register, room
 * auto-filled from the job card.
 */
interface Props {
  pid: string;
  staffId: string;
  /** Room number (descriptive context for the found item). */
  roomNumber: string;
  lang: HousekeeperLocale;
  enqueueIfOffline: (opts: {
    endpoint: string;
    body: Record<string, unknown>;
    label: string;
  }) => Promise<{ ok: boolean; queued: boolean; data?: unknown; status?: number }>;
  onError: (msg: string) => void;
}

export function ReportFoundItemButton({ pid, staffId, roomNumber, lang, enqueueIfOffline, onError }: Props) {
  const [open, setOpen] = useState(false);
  const [desc, setDesc] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const reset = () => {
    setDesc('');
    setFile(null);
    setPreview(null);
  };

  const pickPhoto = (f: File | null) => {
    setFile(f);
    setPreview(f ? URL.createObjectURL(f) : null);
  };

  const handleSubmit = async () => {
    if (submitting) return;
    if (!desc.trim()) {
      onError(t('hkFoundItemError', lang));
      return;
    }
    setSubmitting(true);
    try {
      // Upload the photo first (online only). If it fails, log without it.
      let photoPath: string | null = null;
      if (file && (typeof navigator === 'undefined' || navigator.onLine)) {
        try {
          const scopeKey =
            typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `d${Date.now()}`;
          const pre = await fetch('/api/housekeeper/found-item-photo-presign', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(withStaffLinkTokenBody({ pid, staffId, scopeKey, filename: file.name })),
          });
          const pj = (await pre.json().catch(() => null)) as
            | { ok?: boolean; data?: { signedUrl: string; token: string; path: string } }
            | null;
          if (pre.ok && pj?.ok && pj.data?.signedUrl) {
            const up = await fetch(pj.data.signedUrl, {
              method: 'PUT',
              headers: { Authorization: `Bearer ${pj.data.token}` },
              body: file,
            });
            if (up.ok) photoPath = pj.data.path;
          }
        } catch {
          /* photo optional */
        }
      }

      const res = await enqueueIfOffline({
        endpoint: '/api/housekeeper/report-found-item',
        body: withStaffLinkTokenBody({ pid, staffId, roomNumber, itemDescription: desc.trim(), ...(photoPath ? { photoPath } : {}) }),
        label: `Found · room ${roomNumber}`,
      });
      if (!res.ok && !res.queued) {
        onError(t('hkFoundItemError', lang));
        return;
      }
      reset();
      setOpen(false);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      <button onClick={() => setOpen(true)} aria-label={t('hkFoundItem', lang)} style={smallBtnStyle}>
        <PackageSearch size={14} color="#4B5563" />
        <span style={smallBtnLabelStyle}>{t('hkFoundItem', lang)}</span>
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
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
              <h3 style={{ margin: 0, fontSize: 17, fontWeight: 700, color: '#0F172A' }}>
                {t('hkFoundItemTitle', lang)}
              </h3>
              <button onClick={() => setOpen(false)} aria-label="Close" style={closeBtnStyle}>
                <X size={18} color="#374151" />
              </button>
            </div>

            <textarea
              autoFocus
              value={desc}
              onChange={(e) => setDesc(e.target.value)}
              placeholder={t('hkFoundItemPlaceholder', lang)}
              rows={3}
              maxLength={500}
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

            {/* Photo picker */}
            <button
              type="button"
              onClick={() => (preview ? pickPhoto(null) : fileRef.current?.click())}
              style={{
                marginTop: 10,
                width: '100%',
                minHeight: 48,
                border: `1.5px ${preview ? 'solid' : 'dashed'} ${preview ? '#15803D' : '#D1D5DB'}`,
                borderRadius: 10,
                background: preview ? '#F0FDF4' : 'white',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 8,
                color: preview ? '#15803D' : '#4B5563',
                fontSize: 14,
                fontWeight: 600,
                overflow: 'hidden',
                padding: preview ? 0 : '0 12px',
              }}
            >
              {preview ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={preview} alt="" style={{ maxHeight: 120, maxWidth: '100%', objectFit: 'contain' }} />
              ) : (
                <>
                  <Camera size={16} /> {t('hkFoundItemPhotoAdd', lang)}
                </>
              )}
            </button>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              capture="environment"
              style={{ display: 'none' }}
              onChange={(e) => {
                pickPhoto(e.target.files?.[0] ?? null);
                if (e.target) e.target.value = '';
              }}
            />

            <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
              <button onClick={() => setOpen(false)} style={secondaryBtnStyle}>
                <X size={16} style={{ display: 'inline', verticalAlign: 'middle' }} />
              </button>
              <button
                onClick={handleSubmit}
                disabled={submitting}
                style={{ ...primaryBtnStyle, background: submitting ? '#D1D5DB' : '#15803D' }}
              >
                {submitting ? '…' : t('hkFoundItemSubmit', lang)}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

const smallBtnStyle: React.CSSProperties = {
  minHeight: 36,
  padding: '6px 10px',
  border: '1px solid #E5E7EB',
  borderRadius: 8,
  background: 'transparent',
  cursor: 'pointer',
  display: 'inline-flex',
  alignItems: 'center',
  gap: 5,
  WebkitTapHighlightColor: 'transparent',
};
const smallBtnLabelStyle: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 700,
  color: '#4B5563',
  whiteSpace: 'nowrap',
};
const overlayStyle: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(15,23,42,0.55)',
  zIndex: 200,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 16,
};
const dialogStyle: React.CSSProperties = {
  width: '100%',
  maxWidth: 420,
  background: 'white',
  borderRadius: 20,
  padding: 22,
};
const closeBtnStyle: React.CSSProperties = {
  minHeight: 36,
  minWidth: 36,
  border: 'none',
  background: 'transparent',
  cursor: 'pointer',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
};
const primaryBtnStyle: React.CSSProperties = {
  flex: 1,
  height: 48,
  border: 'none',
  borderRadius: 10,
  color: 'white',
  fontSize: 15,
  fontWeight: 700,
  cursor: 'pointer',
};
const secondaryBtnStyle: React.CSSProperties = {
  width: 56,
  height: 48,
  border: '1px solid #D1D5DB',
  borderRadius: 10,
  background: 'white',
  color: '#374151',
  fontSize: 15,
  fontWeight: 600,
  cursor: 'pointer',
};
