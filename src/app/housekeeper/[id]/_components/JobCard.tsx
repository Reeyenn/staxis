'use client';

import React from 'react';
import {
  PlayCircle,
  PauseCircle,
  CheckCircle,
  AlertTriangle,
  MoreHorizontal,
  Star,
  Zap,
  ClipboardList,
} from 'lucide-react';
import { format } from 'date-fns';
import { es as esLocale } from 'date-fns/locale';
import type { Room, RoomReservationContext } from '@/types';
import type { Language } from '@/lib/translations';
import { t } from '@/lib/translations';

/**
 * JobCard — one room tile on the housekeeper's home screen.
 *
 * States by room.status × room.exceptionType:
 *   dirty (no exception)  → Start button
 *   in_progress (normal)  → Pause + Done buttons, optional Checklist link
 *   in_progress (paused)  → Resume + Done buttons, paused chip
 *   clean / inspected     → Done pill with timestamp + Reset
 *   dirty (exception)     → Exception banner, Clear/Resume option
 *
 * The card surfaces:
 *   - Room number (huge), index, cleaning type badge, floor
 *   - Reservation context (guest name, arrival time, nights, VIP)
 *   - Manager note (display only — posting from manager comes in piece B)
 *   - Rush badge if room is flagged
 *   - Issue note (red box) if housekeeper has reported one
 */

const TYPE_COLORS: Record<string, { fg: string; bg: string; border: string }> = {
  checkout: { fg: '#B45309', bg: '#FFFBEB', border: '#FCD34D' },
  stayover: { fg: '#15803D', bg: '#F0FDF4', border: '#86EFAC' },
  vacant: { fg: '#1E40AF', bg: '#EFF6FF', border: '#93C5FD' },
};

export interface JobCardProps {
  room: Room;
  index: number;
  lang: Language;
  reservation?: RoomReservationContext;
  isSavingStart: boolean;
  isSavingPause: boolean;
  isSavingResume: boolean;
  isSavingComplete: boolean;
  isResetting: boolean;
  checklistChecked: number;
  checklistTotal: number;
  onStart: () => void;
  onPause: () => void;
  onResume: () => void;
  onComplete: () => void;
  onReset: () => void;
  onOpenChecklist: () => void;
  onOpenException: () => void;
  onReportIssue: () => void;
}

export function JobCard(props: JobCardProps) {
  const {
    room,
    index,
    lang,
    reservation,
    isSavingStart,
    isSavingPause,
    isSavingResume,
    isSavingComplete,
    isResetting,
    checklistChecked,
    checklistTotal,
    onStart,
    onPause,
    onResume,
    onComplete,
    onReset,
    onOpenChecklist,
    onOpenException,
    onReportIssue,
  } = props;

  const isDone = room.status === 'clean' || room.status === 'inspected';
  const isInProgress = room.status === 'in_progress';
  const isPaused = !!room.isPaused;
  const exception = room.exceptionType ?? null;
  const issueNote = room.issueNote ?? null;

  const typeLabel =
    room.type === 'checkout'
      ? t('hkTypeCheckout', lang)
      : room.type === 'stayover'
        ? t('hkTypeStayover', lang)
        : t('hkTypeVacant', lang);

  const typeColors = TYPE_COLORS[room.type] ?? TYPE_COLORS.checkout;

  const accentColor = isDone
    ? 'var(--green)'
    : isInProgress
      ? isPaused
        ? '#CA8A04'
        : 'var(--navy-light, #2563EB)'
      : exception
        ? '#6B7280'
        : room.isRush
          ? '#DC2626'
          : room.priority === 'vip'
            ? 'var(--red)'
            : room.priority === 'early'
              ? 'var(--orange, #EA580C)'
              : 'var(--border)';

  const cardBg = isDone
    ? 'var(--green-bg, #F0FDF4)'
    : isInProgress
      ? isPaused
        ? '#FEF3C7'
        : 'var(--blue-dim, #EFF6FF)'
      : exception
        ? '#F9FAFB'
        : 'white';
  const cardBorder = isDone
    ? 'var(--green-light, #86EFAC)'
    : isInProgress
      ? isPaused
        ? '#FDE68A'
        : 'var(--blue-light, #93C5FD)'
      : 'var(--border-light, #E5E7EB)';

  const exceptionLabelMap: Record<NonNullable<Room['exceptionType']>, string> = {
    dnd: t('hkExceptionDnd', lang),
    nsr: t('hkExceptionNsr', lang),
    dla: t('hkExceptionDla', lang),
    sleep_out: t('hkExceptionSleepOut', lang),
    skipped: t('hkExceptionSkipped', lang),
  };

  return (
    <div
      style={{
        background: cardBg,
        border: `2px solid ${cardBorder}`,
        borderLeft: `6px solid ${accentColor}`,
        borderRadius: '16px',
        padding: '14px',
        transition: 'background 250ms ease, border-color 250ms ease',
        boxShadow: isDone ? 'none' : '0 1px 6px rgba(0,0,0,0.07)',
      }}
    >
      {/* ── Rush banner ── */}
      {room.isRush && !isDone && (
        <div
          style={{
            background: '#FEE2E2',
            color: '#991B1B',
            border: '1.5px solid #FCA5A5',
            padding: '6px 10px',
            borderRadius: '8px',
            fontSize: '12px',
            fontWeight: 800,
            letterSpacing: '0.05em',
            marginBottom: '10px',
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
          }}
        >
          <Zap size={14} strokeWidth={3} />
          <span>{t('hkRushBanner', lang)}</span>
          {room.rushDueBy && (
            <span style={{ marginLeft: 'auto', fontSize: '11px', opacity: 0.85 }}>
              {t('hkRushDueIn', lang)} {format(new Date(room.rushDueBy), 'h:mm a', lang === 'es' ? { locale: esLocale } : undefined)}
            </span>
          )}
        </div>
      )}

      {/* ── Exception banner ── */}
      {exception && !isDone && (
        <div
          style={{
            background: '#F3F4F6',
            border: '1.5px solid #D1D5DB',
            color: '#374151',
            padding: '10px 12px',
            borderRadius: '10px',
            marginBottom: '10px',
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
          }}
        >
          <AlertTriangle size={16} color="#6B7280" />
          <span style={{ fontWeight: 700, fontSize: '14px' }}>
            {exceptionLabelMap[exception]}
          </span>
          {room.exceptionNote && (
            <span style={{ fontSize: '12px', color: '#6B7280', marginLeft: '6px', flex: 1 }}>
              {room.exceptionNote}
            </span>
          )}
        </div>
      )}

      {/* ── Top row ── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '10px' }}>
        <span
          style={{
            fontSize: '12px',
            fontWeight: 700,
            color: isDone
              ? 'var(--green)'
              : isInProgress
                ? 'var(--navy-light, #2563EB)'
                : 'var(--text-muted)',
            minWidth: '18px',
            lineHeight: 1,
            flexShrink: 0,
          }}
        >
          {index}.
        </span>

        <span
          style={{
            fontFamily: 'ui-monospace, monospace',
            fontWeight: 800,
            fontSize: '34px',
            color: isDone
              ? 'var(--green)'
              : isInProgress
                ? 'var(--navy-light, #2563EB)'
                : 'var(--text-primary)',
            letterSpacing: '-0.02em',
            lineHeight: 1,
          }}
        >
          {room.number}
        </span>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', flex: 1 }}>
          <span
            style={{
              fontSize: '11px',
              fontWeight: 700,
              textTransform: 'uppercase',
              letterSpacing: '0.07em',
              padding: '2px 8px',
              borderRadius: '5px',
              width: 'fit-content',
              background: typeColors.bg,
              color: typeColors.fg,
              border: `1px solid ${typeColors.border}`,
            }}
          >
            {typeLabel}
          </span>
          <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
            {room.priority === 'vip' && !isDone && (
              <Badge color="#DC2626" bg="#FEE2E2">
                <Star size={11} fill="#DC2626" /> VIP
              </Badge>
            )}
            {room.priority === 'early' && !isDone && (
              <Badge color="#EA580C" bg="#FFF7ED">
                <Zap size={11} /> {t('earlyCheckin', lang)}
              </Badge>
            )}
            {room.floor && (
              <Badge color="#4B5563" bg="#F3F4F6">
                {t('hkFloorPrefix', lang)} {room.floor}
              </Badge>
            )}
            {isPaused && (
              <Badge color="#92400E" bg="#FEF3C7">
                <PauseCircle size={11} /> {t('hkPaused', lang)}
              </Badge>
            )}
          </div>
        </div>

        {/* ⋯ Exception/options menu (always available except when done) */}
        {!isDone && (
          <button
            onClick={onOpenException}
            style={{
              minHeight: '44px',
              minWidth: '44px',
              padding: '0 10px',
              border: '1.5px solid var(--border-light, #E5E7EB)',
              borderRadius: '10px',
              background: 'transparent',
              cursor: 'pointer',
              flexShrink: 0,
              display: 'flex',
              alignItems: 'center',
              gap: '4px',
              opacity: 0.65,
              WebkitTapHighlightColor: 'transparent',
              touchAction: 'manipulation',
            }}
            aria-label={t('hkException', lang)}
          >
            <MoreHorizontal size={16} color="#4B5563" />
          </button>
        )}
      </div>

      {/* ── Reservation context ── */}
      {(reservation?.guestName || reservation?.arrivalTime || reservation?.numNights) && !isDone && (
        <div
          style={{
            background: 'white',
            border: '1px solid var(--border-light, #E5E7EB)',
            borderRadius: '10px',
            padding: '10px 12px',
            marginBottom: '10px',
            display: 'flex',
            flexWrap: 'wrap',
            gap: '12px',
            fontSize: '13px',
          }}
        >
          {reservation.guestName && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
              <span style={{ fontSize: '10px', color: '#6B7280', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                {t('hkGuestNameLabel', lang)}
              </span>
              <span style={{ fontWeight: 600, color: '#111827' }}>
                {reservation.guestName}
                {reservation.isVip && (
                  <Star
                    size={11}
                    fill="#DC2626"
                    style={{ marginLeft: '4px', verticalAlign: 'middle' }}
                  />
                )}
              </span>
            </div>
          )}
          {reservation.arrivalTime && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
              <span style={{ fontSize: '10px', color: '#6B7280', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                {t('hkETALabel', lang)}
              </span>
              <span style={{ fontWeight: 600, color: '#111827' }}>{reservation.arrivalTime.slice(0, 5)}</span>
            </div>
          )}
          {typeof reservation.numNights === 'number' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
              <span style={{ fontSize: '10px', color: '#6B7280', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                {t('hkNightsLabel', lang)}
              </span>
              <span style={{ fontWeight: 600, color: '#111827' }}>
                {reservation.numNights} {t('hkNightsUnit', lang)}
              </span>
            </div>
          )}
        </div>
      )}

      {/* ── Manager note (display only in piece A) ── */}
      {room.managerNotes && !isDone && (
        <div
          style={{
            background: '#FFFBEB',
            border: '1px solid #FCD34D',
            borderRadius: '10px',
            padding: '8px 10px',
            marginBottom: '10px',
            fontSize: '13px',
            color: '#92400E',
          }}
        >
          <strong style={{ fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            {t('hkManagerNotesLabel', lang)}:
          </strong>{' '}
          {room.managerNotes}
        </div>
      )}

      {/* ── Reported issue ── */}
      {issueNote && (
        <div
          style={{
            display: 'flex',
            gap: '6px',
            alignItems: 'flex-start',
            padding: '8px 10px',
            background: 'var(--red-dim, #FEF2F2)',
            borderRadius: '10px',
            marginBottom: '10px',
            border: '1px solid var(--red-light, #FECACA)',
          }}
        >
          <AlertTriangle
            size={13}
            color="var(--red, #DC2626)"
            style={{ flexShrink: 0, marginTop: '2px' }}
          />
          <span
            style={{
              fontSize: '13px',
              color: 'var(--red-dark, #991B1B)',
              lineHeight: 1.4,
            }}
          >
            {issueNote}
          </span>
        </div>
      )}

      {/* ── Action area ── */}
      {isDone ? (
        <div
          style={{
            height: '54px',
            borderRadius: '12px',
            background: 'var(--green-dim, #DCFCE7)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '10px',
          }}
        >
          <CheckCircle size={22} color="var(--green)" />
          <span style={{ fontSize: '17px', fontWeight: 800, color: 'var(--green)' }}>
            {t('hkActionDone', lang)}
          </span>
          {room.completedAt && (
            <span style={{ fontSize: '13px', color: 'var(--green)', opacity: 0.7 }}>
              {format(new Date(room.completedAt), 'h:mm a')}
            </span>
          )}
          <span style={{ color: 'var(--green)', opacity: 0.3, fontSize: '14px' }}>·</span>
          <button
            onClick={onReset}
            disabled={isResetting}
            style={{
              background: 'none',
              border: 'none',
              minHeight: '40px',
              minWidth: '40px',
              padding: '0 8px',
              fontSize: '13px',
              fontWeight: 600,
              color: 'var(--green)',
              cursor: isResetting ? 'not-allowed' : 'pointer',
              opacity: isResetting ? 0.4 : 0.6,
              textDecoration: 'underline',
              textUnderlineOffset: '2px',
            }}
          >
            {isResetting ? '...' : t('hkResetShort', lang)}
          </button>
        </div>
      ) : isInProgress ? (
        <WorkflowButtonsInProgress
          lang={lang}
          isPaused={isPaused}
          isSavingPause={isSavingPause}
          isSavingResume={isSavingResume}
          isSavingComplete={isSavingComplete}
          checklistChecked={checklistChecked}
          checklistTotal={checklistTotal}
          onPause={onPause}
          onResume={onResume}
          onComplete={onComplete}
          onOpenChecklist={onOpenChecklist}
          onReportIssue={onReportIssue}
        />
      ) : (
        <WorkflowButtonsDirty
          lang={lang}
          isSavingStart={isSavingStart}
          hasException={!!exception}
          onStart={onStart}
          onReportIssue={onReportIssue}
        />
      )}
    </div>
  );
}

/* ─── Small reusable helpers ─── */

function Badge({
  children,
  color,
  bg,
}: {
  children: React.ReactNode;
  color: string;
  bg: string;
}) {
  return (
    <span
      style={{
        fontSize: '11px',
        fontWeight: 700,
        color,
        background: bg,
        padding: '2px 7px',
        borderRadius: '5px',
        display: 'inline-flex',
        alignItems: 'center',
        gap: '4px',
        lineHeight: 1.4,
      }}
    >
      {children}
    </span>
  );
}

function WorkflowButtonsDirty({
  lang,
  isSavingStart,
  hasException,
  onStart,
  onReportIssue,
}: {
  lang: Language;
  isSavingStart: boolean;
  hasException: boolean;
  onStart: () => void;
  onReportIssue: () => void;
}) {
  return (
    <div style={{ display: 'flex', gap: '8px' }}>
      <button
        onClick={onStart}
        disabled={isSavingStart || hasException}
        style={{
          flex: 1,
          height: '60px',
          border: 'none',
          borderRadius: '12px',
          background: isSavingStart || hasException ? 'var(--border)' : 'var(--navy-light, #2563EB)',
          color: 'white',
          fontSize: '18px',
          fontWeight: 800,
          cursor: isSavingStart || hasException ? 'not-allowed' : 'pointer',
          letterSpacing: '0.01em',
          WebkitTapHighlightColor: 'transparent',
          touchAction: 'manipulation',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '8px',
          boxShadow: isSavingStart || hasException ? 'none' : '0 3px 10px rgba(37,99,235,0.3)',
        }}
      >
        <PlayCircle size={22} />
        {isSavingStart ? '...' : t('hkActionStart', lang)}
      </button>
      <button
        onClick={onReportIssue}
        style={{
          minHeight: '60px',
          minWidth: '60px',
          padding: '0 16px',
          border: '1.5px solid var(--border-light, #E5E7EB)',
          borderRadius: '12px',
          background: 'transparent',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '6px',
          opacity: 0.7,
          WebkitTapHighlightColor: 'transparent',
          touchAction: 'manipulation',
        }}
        aria-label={t('hkReportIssueAria', lang)}
      >
        <AlertTriangle size={16} color="#4B5563" />
        <span style={{ fontSize: '13px', fontWeight: 700, color: '#4B5563' }}>
          {t('hkIssueShort', lang)}
        </span>
      </button>
    </div>
  );
}

function WorkflowButtonsInProgress({
  lang,
  isPaused,
  isSavingPause,
  isSavingResume,
  isSavingComplete,
  checklistChecked,
  checklistTotal,
  onPause,
  onResume,
  onComplete,
  onOpenChecklist,
  onReportIssue,
}: {
  lang: Language;
  isPaused: boolean;
  isSavingPause: boolean;
  isSavingResume: boolean;
  isSavingComplete: boolean;
  checklistChecked: number;
  checklistTotal: number;
  onPause: () => void;
  onResume: () => void;
  onComplete: () => void;
  onOpenChecklist: () => void;
  onReportIssue: () => void;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
      {/* Checklist link */}
      {checklistTotal > 0 && (
        <button
          onClick={onOpenChecklist}
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '10px 12px',
            background: 'white',
            border: '1.5px solid var(--border-light, #E5E7EB)',
            borderRadius: '10px',
            cursor: 'pointer',
            WebkitTapHighlightColor: 'transparent',
            touchAction: 'manipulation',
          }}
        >
          <span style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <ClipboardList size={16} color="#2563EB" />
            <span style={{ fontSize: '14px', fontWeight: 700, color: '#111827' }}>
              {t('hkOpenChecklist', lang)}
            </span>
          </span>
          <span style={{ fontSize: '13px', fontWeight: 700, color: '#2563EB' }}>
            {checklistChecked} / {checklistTotal}
          </span>
        </button>
      )}

      <div style={{ display: 'flex', gap: '8px' }}>
        {/* Pause / Resume toggle */}
        {isPaused ? (
          <button
            onClick={onResume}
            disabled={isSavingResume}
            style={{
              minWidth: '110px',
              height: '60px',
              border: '1.5px solid #FDE68A',
              borderRadius: '12px',
              background: '#FEF3C7',
              color: '#92400E',
              fontSize: '15px',
              fontWeight: 800,
              cursor: isSavingResume ? 'not-allowed' : 'pointer',
              opacity: isSavingResume ? 0.5 : 1,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '6px',
              WebkitTapHighlightColor: 'transparent',
              touchAction: 'manipulation',
            }}
          >
            <PlayCircle size={18} />
            {isSavingResume ? '...' : t('hkActionResume', lang)}
          </button>
        ) : (
          <button
            onClick={onPause}
            disabled={isSavingPause}
            style={{
              minWidth: '110px',
              height: '60px',
              border: '1.5px solid var(--border-light, #E5E7EB)',
              borderRadius: '12px',
              background: 'white',
              color: '#374151',
              fontSize: '15px',
              fontWeight: 700,
              cursor: isSavingPause ? 'not-allowed' : 'pointer',
              opacity: isSavingPause ? 0.5 : 1,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '6px',
              WebkitTapHighlightColor: 'transparent',
              touchAction: 'manipulation',
            }}
          >
            <PauseCircle size={18} />
            {isSavingPause ? '...' : t('hkActionPause', lang)}
          </button>
        )}

        {/* Done */}
        <button
          onClick={onComplete}
          disabled={isSavingComplete}
          style={{
            flex: 1,
            height: '60px',
            border: 'none',
            borderRadius: '12px',
            background: isSavingComplete ? 'var(--border)' : 'var(--green, #006565)',
            color: 'white',
            fontSize: '18px',
            fontWeight: 800,
            cursor: isSavingComplete ? 'not-allowed' : 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '8px',
            WebkitTapHighlightColor: 'transparent',
            touchAction: 'manipulation',
            boxShadow: isSavingComplete ? 'none' : '0 3px 10px rgba(22,101,52,0.3)',
          }}
        >
          <CheckCircle size={22} />
          {isSavingComplete ? '...' : t('hkActionDone', lang)}
        </button>

        {/* Report issue */}
        <button
          onClick={onReportIssue}
          style={{
            minHeight: '60px',
            minWidth: '52px',
            padding: '0 8px',
            border: '1.5px solid var(--border-light, #E5E7EB)',
            borderRadius: '12px',
            background: 'transparent',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            opacity: 0.7,
            WebkitTapHighlightColor: 'transparent',
            touchAction: 'manipulation',
          }}
          aria-label={t('hkReportIssueAria', lang)}
        >
          <AlertTriangle size={16} color="#4B5563" />
        </button>
      </div>
    </div>
  );
}
