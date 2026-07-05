'use client';

import React, { useCallback, useRef, useState } from 'react';
import { withStaffLinkTokenBody } from '@/lib/staff-link-client';
import { X, Camera, AlertTriangle, Trash2, CheckCircle } from 'lucide-react';
import { t, type HousekeeperLocale } from '@/lib/translations';

/**
 * StructuredIssueReporter — replaces the freeform issue textarea.
 *
 * Housekeeper picks action (replace/repair/clean/report), types the
 * item (lightbulb, sink, ...), optionally adds a location detail, picks
 * severity, optionally attaches a photo, optionally adds a free-text
 * note. On submit:
 *   1. /api/housekeeper/photo-presign returns a signed-upload URL
 *      (skipped if no photo).
 *   2. The browser PUTs the photo bytes directly to Supabase Storage.
 *   3. /api/housekeeper/structured-issue creates the work order with the
 *      photo path attached.
 *
 * The whole flow is wrapped in offline-aware fetch — without a photo,
 * the action queues for replay; with a photo, the photo step needs the
 * network so we block submit when offline.
 */
type Action = 'replace' | 'repair' | 'clean' | 'report';
type Severity = 'minor' | 'major' | 'urgent';

interface Props {
  pid: string;
  staffId: string;
  roomId: string;
  roomNumber: string;
  lang: HousekeeperLocale;
  online: boolean;
  enqueueIfOffline: (opts: {
    endpoint: string;
    body: Record<string, unknown>;
    label: string;
  }) => Promise<{ ok: boolean; queued: boolean; data?: unknown; status?: number }>;
  onClose: () => void;
  onSubmitted: () => void;
}

const MAX_PHOTO_BYTES = 10 * 1024 * 1024; // 10 MB; matches bucket limit

export function StructuredIssueReporter(props: Props) {
  const { pid, staffId, roomId, roomNumber, lang, online, enqueueIfOffline, onClose, onSubmitted } = props;

  const [action, setAction] = useState<Action | null>(null);
  const [item, setItem] = useState('');
  const [locationDetail, setLocationDetail] = useState('');
  const [severity, setSeverity] = useState<Severity>('minor');
  const [note, setNote] = useState('');
  const [photoFile, setPhotoFile] = useState<File | null>(null);
  const [photoPreview, setPhotoPreview] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handlePhotoChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      if (file.size > MAX_PHOTO_BYTES) {
        setErrorMsg(t('hkErrPhotoTooBig', lang));
        if (fileInputRef.current) fileInputRef.current.value = '';
        return;
      }
      // Revoke previous preview to avoid leaking object URLs.
      if (photoPreview) URL.revokeObjectURL(photoPreview);
      setPhotoFile(file);
      setPhotoPreview(URL.createObjectURL(file));
      setErrorMsg(null);
    },
    [lang, photoPreview],
  );

  const removePhoto = () => {
    if (photoPreview) URL.revokeObjectURL(photoPreview);
    setPhotoFile(null);
    setPhotoPreview(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const canSubmit = !submitting && !!action && item.trim().length > 0;

  const handleSubmit = useCallback(async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setErrorMsg(null);

    // Photo path: when present, we need online to upload first. We mint a
    // client-side UUID scope key so the photo's path is stable even before
    // the work order id exists.
    let photoPath: string | null = null;
    if (photoFile) {
      if (!online) {
        setErrorMsg(t('hkErrPhotoUpload', lang));
        setSubmitting(false);
        return;
      }
      try {
        const scopeKey =
          typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
            ? crypto.randomUUID()
            : 'draft-' + Date.now();
        const presignRes = await fetch('/api/housekeeper/photo-presign', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(withStaffLinkTokenBody({
            pid,
            staffId,
            scopeKey,
            filename: photoFile.name,
          })),
        });
        const presignJson = (await presignRes.json().catch(() => null)) as
          | { ok?: boolean; data?: { signedUrl: string; path: string } }
          | null;
        if (!presignRes.ok || !presignJson?.ok || !presignJson.data) {
          setErrorMsg(t('hkErrPhotoUpload', lang));
          setSubmitting(false);
          return;
        }
        const putRes = await fetch(presignJson.data.signedUrl, {
          method: 'PUT',
          headers: { 'Content-Type': photoFile.type || 'image/jpeg' },
          body: photoFile,
        });
        if (!putRes.ok) {
          setErrorMsg(t('hkErrPhotoUpload', lang));
          setSubmitting(false);
          return;
        }
        photoPath = presignJson.data.path;
      } catch {
        setErrorMsg(t('hkErrPhotoUpload', lang));
        setSubmitting(false);
        return;
      }
    }

    // Send the structured issue. Offline-aware: if no photo, this queues
    // for replay when the housekeeper comes back online.
    const result = await enqueueIfOffline({
      endpoint: '/api/housekeeper/structured-issue',
      body: withStaffLinkTokenBody({
        pid,
        staffId,
        roomId,
        roomNumber,
        action,
        item: item.trim(),
        locationDetail: locationDetail.trim(),
        severity,
        note: note.trim(),
        photoPath,
      }),
      label: `Issue · room ${roomNumber}`,
    });

    if (!result.ok && !result.queued) {
      setErrorMsg(t('hkErrCouldntSaveIssue', lang));
      setSubmitting(false);
      return;
    }

    setSubmitted(true);
    setSubmitting(false);
    onSubmitted();
    window.setTimeout(onClose, 1200);
  }, [
    canSubmit, photoFile, online, lang, pid, staffId, roomId, roomNumber,
    action, item, locationDetail, severity, note, enqueueIfOffline, onSubmitted, onClose,
  ]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(15,23,42,0.55)',
        zIndex: 220,
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
          maxWidth: 560,
          margin: '0 auto',
          background: 'white',
          borderTopLeftRadius: 20,
          borderTopRightRadius: 20,
          maxHeight: '92dvh',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
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
            <h2 style={{ fontSize: 18, fontWeight: 800, margin: 0, color: '#0F172A' }}>
              {t('reportIssue', lang)}
            </h2>
            <p style={{ fontSize: 13, color: '#6B7280', margin: '4px 0 0 0' }}>
              {t('hkRoomShort', lang)} {roomNumber}
            </p>
          </div>
          <button
            onClick={onClose}
            aria-label={t('hkClose', lang)}
            style={{
              minHeight: 44,
              minWidth: 44,
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

        {submitted ? (
          <div
            style={{
              padding: 36,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 12,
            }}
          >
            <CheckCircle size={48} color="#15803D" />
            <div style={{ fontSize: 16, fontWeight: 700, color: '#15803D' }}>
              {t('hkIssueRoutedToMaintenance', lang)}
            </div>
          </div>
        ) : (
          <div style={{ overflowY: 'auto', padding: '12px 18px 24px', display: 'flex', flexDirection: 'column', gap: 14 }}>
            {/* Action */}
            <div>
              <Label text={t('hkIssueAction', lang)} />
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 6 }}>
                {(
                  [
                    ['replace', 'hkIssueActionReplace'],
                    ['repair', 'hkIssueActionRepair'],
                    ['clean', 'hkIssueActionClean'],
                    ['report', 'hkIssueActionReport'],
                  ] as const
                ).map(([a, k]) => (
                  <PickerButton
                    key={a}
                    active={action === a}
                    onClick={() => setAction(a)}
                    label={t(k, lang)}
                  />
                ))}
              </div>
            </div>

            {/* Item */}
            <div>
              <Label text={t('hkIssueItem', lang)} />
              <input
                value={item}
                onChange={(e) => setItem(e.target.value)}
                placeholder={t('hkIssueItemPlaceholder', lang)}
                maxLength={100}
                style={fieldStyle}
              />
            </div>

            {/* Location */}
            <div>
              <Label text={t('hkIssueLocation', lang)} />
              <input
                value={locationDetail}
                onChange={(e) => setLocationDetail(e.target.value)}
                placeholder={t('hkIssueLocationPlaceholder', lang)}
                maxLength={200}
                style={fieldStyle}
              />
            </div>

            {/* Severity */}
            <div>
              <Label text={t('hkIssueSeverity', lang)} />
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 6 }}>
                {(
                  [
                    ['minor', 'hkIssueSeverityMinor'],
                    ['major', 'hkIssueSeverityMajor'],
                    ['urgent', 'hkIssueSeverityUrgent'],
                  ] as const
                ).map(([s, k]) => (
                  <PickerButton
                    key={s}
                    active={severity === s}
                    onClick={() => setSeverity(s)}
                    label={t(k, lang)}
                    tone={s === 'urgent' ? 'urgent' : s === 'major' ? 'warn' : 'neutral'}
                  />
                ))}
              </div>
            </div>

            {/* Note */}
            <div>
              <Label text={t('hkIssueNote', lang)} />
              <textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder={t('hkIssueNotePlaceholder', lang)}
                rows={2}
                maxLength={500}
                style={{ ...fieldStyle, resize: 'vertical', minHeight: 60 }}
              />
            </div>

            {/* Photo */}
            <div>
              <Label text={t('hkIssuePhotoAdd', lang)} />
              {!photoPreview ? (
                <label
                  htmlFor="hk-issue-photo"
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 8,
                    padding: '10px 14px',
                    border: '1.5px dashed #93C5FD',
                    borderRadius: 10,
                    color: '#1E40AF',
                    background: '#EFF6FF',
                    fontSize: 14,
                    fontWeight: 600,
                    cursor: 'pointer',
                  }}
                >
                  <Camera size={16} />
                  {t('hkIssuePhotoAdd', lang)}
                </label>
              ) : (
                <div style={{ position: 'relative', display: 'inline-block' }}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={photoPreview}
                    alt={lang === 'es' ? 'Vista previa del problema' : 'Issue preview'}
                    style={{
                      maxWidth: 200,
                      maxHeight: 200,
                      borderRadius: 10,
                      border: '1px solid #E5E7EB',
                      objectFit: 'cover',
                    }}
                  />
                  <button
                    onClick={removePhoto}
                    aria-label={t('hkIssuePhotoRemove', lang)}
                    style={{
                      position: 'absolute',
                      top: 4,
                      right: 4,
                      background: 'rgba(0,0,0,0.6)',
                      color: 'white',
                      border: 'none',
                      borderRadius: '50%',
                      width: 28,
                      height: 28,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      cursor: 'pointer',
                    }}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              )}
              <input
                ref={fileInputRef}
                id="hk-issue-photo"
                type="file"
                accept="image/*"
                capture="environment"
                onChange={handlePhotoChange}
                style={{ display: 'none' }}
              />
            </div>

            {errorMsg && (
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '10px 12px',
                  background: '#FEF2F2',
                  border: '1px solid #FECACA',
                  borderRadius: 10,
                  color: '#991B1B',
                  fontSize: 13,
                }}
              >
                <AlertTriangle size={14} />
                {errorMsg}
              </div>
            )}

            <button
              onClick={handleSubmit}
              disabled={!canSubmit}
              style={{
                marginTop: 8,
                height: 56,
                border: 'none',
                borderRadius: 12,
                background: canSubmit ? '#15803D' : '#D1D5DB',
                color: canSubmit ? 'white' : '#6B7280',
                fontSize: 16,
                fontWeight: 700,
                cursor: canSubmit ? 'pointer' : 'not-allowed',
                WebkitTapHighlightColor: 'transparent',
              }}
            >
              {submitting ? t('savingDots', lang) : t('hkIssueSubmit', lang)}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function Label({ text }: { text: string }) {
  return (
    <div
      style={{
        fontSize: 12,
        fontWeight: 700,
        color: '#6B7280',
        textTransform: 'uppercase',
        letterSpacing: '0.05em',
        marginBottom: 6,
      }}
    >
      {text}
    </div>
  );
}

function PickerButton({
  active,
  onClick,
  label,
  tone = 'neutral',
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  tone?: 'neutral' | 'warn' | 'urgent';
}) {
  const palette =
    tone === 'urgent'
      ? { activeBg: '#DC2626', activeFg: 'white', inactiveBg: '#FEF2F2', inactiveFg: '#991B1B', border: '#FCA5A5' }
      : tone === 'warn'
        ? { activeBg: '#B45309', activeFg: 'white', inactiveBg: '#FFFBEB', inactiveFg: '#92400E', border: '#FCD34D' }
        : { activeBg: '#2563EB', activeFg: 'white', inactiveBg: 'white',   inactiveFg: '#374151', border: '#D1D5DB' };
  return (
    <button
      onClick={onClick}
      style={{
        padding: '12px 10px',
        background: active ? palette.activeBg : palette.inactiveBg,
        color: active ? palette.activeFg : palette.inactiveFg,
        border: `1.5px solid ${active ? palette.activeBg : palette.border}`,
        borderRadius: 10,
        fontSize: 14,
        fontWeight: 700,
        cursor: 'pointer',
        WebkitTapHighlightColor: 'transparent',
      }}
    >
      {label}
    </button>
  );
}

const fieldStyle: React.CSSProperties = {
  width: '100%',
  padding: '12px 14px',
  border: '1.5px solid #D1D5DB',
  borderRadius: 10,
  fontSize: 15,
  fontFamily: 'inherit',
  boxSizing: 'border-box',
  outline: 'none',
};
