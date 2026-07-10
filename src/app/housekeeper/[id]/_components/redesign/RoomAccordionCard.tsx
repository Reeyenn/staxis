'use client';

import React from 'react';
import {
  Play,
  Pause,
  Check,
  CheckCircle2,
  AlertTriangle,
  Star,
  Zap,
  ClipboardList,
  ChevronDown,
  User,
} from 'lucide-react';
import { format } from 'date-fns';
import type { Room, RoomReservationContext } from '@/types';
import type { HousekeeperLocale } from '@/lib/translations';
import { t } from '@/lib/translations';
import { floorFromRoomNumber } from '@/lib/housekeeper-workflow/state-machine';
import { TOK, bigBtn, fallbackTasks } from './tokens';

/**
 * RoomAccordionCard — the redesigned room tile (Claude Design handoff).
 *
 * One room = one card that expands in place (accordion; one open at a time,
 * controlled by the parent via `open` + `onToggle`). The card stays white in
 * every state — only the buttons change color. Button workflow mirrors the
 * legacy JobCard state machine exactly, wired to the same handlers, so it is
 * fully functional, not a mock:
 *
 *   dirty           → Start cleaning + Issue
 *   in_progress     → Stop + Done + Issue   (Resume replaces Stop when paused)
 *   clean/inspected → "Done · {time}" pill + Start again
 */

export interface RoomAccordionCardProps {
  room: Room;
  lang: HousekeeperLocale;
  reservation?: RoomReservationContext;
  open: boolean;
  onToggle: () => void;
  isSavingStart: boolean;
  isSavingPause: boolean;
  isSavingResume: boolean;
  isSavingComplete: boolean;
  isResetting: boolean;
  checklistChecked: number;
  checklistTotal: number;
  /** Real per-type checklist item labels (read-only preview). Falls back to a
   *  generic set by cleaning type when the template hasn't loaded. */
  checklistLabels?: string[];
  onStart: () => void;
  onPause: () => void;
  onResume: () => void;
  onComplete: (e: React.MouseEvent<HTMLButtonElement>) => void;
  onReset: () => void;
  onOpenChecklist: () => void;
  onReportIssue: () => void;
  /** Component-suite badge (rendered at the top of the expanded body). */
  extraTopSlot?: React.ReactNode;
  /** Secondary actions: Add note / Mark for inspection / Found item. */
  extraActionsSlot?: React.ReactNode;
}

const TYPE_LABEL_KEY = {
  checkout: 'hkTypeCheckout',
  stayover: 'hkTypeStayover',
  vacant: 'hkTypeVacant',
} as const;

export function RoomAccordionCard(props: RoomAccordionCardProps) {
  const {
    room,
    lang,
    reservation,
    open,
    onToggle,
    isSavingStart,
    isSavingPause,
    isSavingResume,
    isSavingComplete,
    isResetting,
    checklistChecked,
    checklistTotal,
    checklistLabels,
    onStart,
    onPause,
    onResume,
    onComplete,
    onReset,
    onOpenChecklist,
    onReportIssue,
    extraTopSlot,
    extraActionsSlot,
  } = props;

  const [showTasks, setShowTasks] = React.useState(false);

  const done = room.status === 'clean' || room.status === 'inspected';
  const inProg = room.status === 'in_progress';
  const paused = !!room.isPaused;
  const isVip = room.priority === 'vip' || !!reservation?.isVip;
  const typeLabel = t(TYPE_LABEL_KEY[room.type] ?? 'hkTypeCheckout', lang);

  const dot = done ? TOK.green : inProg ? (paused ? TOK.amber : TOK.teal) : '#C9CDD4';
  const eta = reservation?.arrivalTime ? reservation.arrivalTime.slice(0, 5) : null;
  const completedTime = room.completedAt ? format(new Date(room.completedAt), 'h:mm a') : '';
  // Fall back to number-derived floor so the subline matches the floor grouping
  // even when the PMS row has no explicit floor value.
  const floorLabel = room.floor ?? floorFromRoomNumber(room.number);

  const tasks =
    checklistLabels && checklistLabels.length > 0
      ? checklistLabels
      : fallbackTasks(room.type, lang).slice(0, checklistTotal || 6);

  const subline = done
    ? completedTime
      ? `${t('hkActionDone', lang)} · ${completedTime}`
      : t('hkActionDone', lang)
    : inProg
      ? paused
        ? t('hkPaused', lang)
        : checklistTotal > 0
          ? `${t('hkCleaningLabel', lang)} · ${checklistChecked}/${checklistTotal}`
          : t('hkCleaningLabel', lang)
      : `${t('hkFloorPrefix', lang)} ${floorLabel}${eta ? ` · ${t('hkETALabel', lang)} ${eta}` : ''}`;

  return (
    <div
      className="fh-card"
      style={{
        borderRadius: 18,
        overflow: 'hidden',
        background: done ? TOK.doneBg : 'white',
        border: `1px solid ${done ? TOK.doneBorder : open ? TOK.openBorder : TOK.border}`,
        boxShadow: open ? '0 8px 22px rgba(16,24,40,.08)' : 'none',
        color: TOK.ink,
      }}
    >
      {/* ── collapsed header row — tap toggles this card ── */}
      <button
        className="fh-press"
        onClick={onToggle}
        aria-expanded={open}
        style={{
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          gap: 13,
          padding: '13px 14px',
          background: 'none',
          border: 'none',
          cursor: 'pointer',
          textAlign: 'left',
          color: 'inherit',
          WebkitTapHighlightColor: 'transparent',
          touchAction: 'manipulation',
        }}
      >
        <span
          style={{
            width: 10,
            height: 10,
            borderRadius: '50%',
            background: dot,
            flexShrink: 0,
            boxShadow: inProg && !paused ? '0 0 0 4px rgba(0,101,101,.15)' : 'none',
          }}
        />
        <span
          style={{
            fontFamily: TOK.fontMono,
            fontWeight: 700,
            fontSize: 24,
            minWidth: 50,
            letterSpacing: '-.02em',
            color: done ? TOK.green : TOK.ink,
          }}
        >
          {room.number}
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13.5, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 6 }}>
            {typeLabel}
            {isVip && <Star size={11} fill={TOK.amber} color={TOK.amber} />}
            {room.isRush && <Zap size={11} fill={TOK.red} color={TOK.red} />}
          </div>
          <div style={{ fontSize: 11.5, color: TOK.ink3, marginTop: 1, fontWeight: 600 }}>{subline}</div>
        </div>
        {done ? (
          <CheckCircle2 size={22} color={TOK.green} />
        ) : (
          <span className="fh-chev" style={{ transform: open ? 'rotate(180deg)' : 'none', opacity: 0.85, display: 'inline-flex' }}>
            <ChevronDown size={20} color="#B5BDC6" />
          </span>
        )}
      </button>

      {/* ── expanded body ── */}
      {open && (
        <div style={{ padding: '0 14px 16px' }}>
          {extraTopSlot}

          {/* dirty: reservation row (guest + ETA / VIP) */}
          {reservation?.guestName && !done && !inProg && (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '10px 12px',
                borderRadius: 12,
                background: TOK.subtle,
                marginBottom: 9,
              }}
            >
              <User size={15} color={TOK.teal} />
              <span style={{ fontSize: 13.5, fontWeight: 600 }}>{reservation.guestName}</span>
              {isVip ? (
                <span style={{ marginLeft: 'auto', fontSize: 11, fontWeight: 800, display: 'inline-flex', alignItems: 'center', gap: 4, color: TOK.amber }}>
                  <Star size={11} fill={TOK.amber} color={TOK.amber} /> VIP
                </span>
              ) : (
                eta && <span style={{ marginLeft: 'auto', fontSize: 12, color: TOK.ink3 }}>{t('hkETALabel', lang)} {eta}</span>
              )}
            </div>
          )}

          {/* manager note */}
          {room.managerNotes && !done && (
            <div
              style={{
                fontSize: 12.5,
                lineHeight: 1.45,
                padding: '9px 12px',
                borderRadius: 11,
                background: TOK.mgrBg,
                color: TOK.mgrText,
                border: `1px solid ${TOK.mgrBorder}`,
                marginBottom: 9,
              }}
            >
              <strong style={{ fontSize: 10.5, textTransform: 'uppercase' }}>
                {t('hkManagerNotesLabel', lang)} ·{' '}
              </strong>
              {room.managerNotes}
            </div>
          )}

          {/* reported issue */}
          {room.issueNote && !done && (
            <div
              style={{
                fontSize: 12.5,
                lineHeight: 1.45,
                padding: '9px 12px',
                borderRadius: 11,
                background: TOK.issueBg,
                color: TOK.issueText,
                border: `1px solid ${TOK.issueBorder}`,
                marginBottom: 9,
                display: 'flex',
                gap: 7,
              }}
            >
              <AlertTriangle size={13} color={TOK.red} style={{ flexShrink: 0, marginTop: 1 }} />
              {room.issueNote}
            </div>
          )}

          {/* in_progress: guest row + checklist pill (toggles inline preview) */}
          {inProg && (
            <>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '10px 12px',
                  borderRadius: 12,
                  background: TOK.subtle,
                  marginBottom: showTasks ? 0 : 12,
                }}
              >
                {reservation?.guestName ? (
                  <>
                    <User size={15} color={TOK.teal} />
                    <span style={{ fontSize: 13.5, fontWeight: 600, color: TOK.ink, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {reservation.guestName}
                    </span>
                    {isVip && (
                      <span style={{ fontSize: 11, fontWeight: 800, display: 'inline-flex', alignItems: 'center', gap: 3, color: TOK.amber }}>
                        <Star size={11} fill={TOK.amber} color={TOK.amber} /> VIP
                      </span>
                    )}
                  </>
                ) : (
                  <span style={{ fontSize: 13.5, fontWeight: 600, color: TOK.ink2 }}>
                    {t('hkFloorPrefix', lang)} {floorLabel}
                  </span>
                )}
                {checklistTotal > 0 && (
                  <button
                    className="fh-press"
                    onClick={() => setShowTasks((v) => !v)}
                    style={{
                      marginLeft: 'auto',
                      flexShrink: 0,
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 5,
                      height: 28,
                      padding: '0 11px',
                      borderRadius: 99,
                      border: `1px solid ${TOK.chkBorder}`,
                      background: TOK.chkBg,
                      color: TOK.teal,
                      fontSize: 12,
                      fontWeight: 800,
                      cursor: 'pointer',
                    }}
                  >
                    <ClipboardList size={13} color={TOK.teal} /> {checklistChecked}/{checklistTotal}
                    <span className="fh-chev" style={{ transform: showTasks ? 'rotate(180deg)' : 'none', display: 'inline-flex' }}>
                      <ChevronDown size={13} color={TOK.teal} />
                    </span>
                  </button>
                )}
              </div>
              {showTasks && checklistTotal > 0 && (
                <div style={{ background: TOK.subtle, borderRadius: 12, padding: '11px 13px', margin: '8px 0 12px' }}>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    {tasks.map((task, i) => (
                      <div key={i} style={{ display: 'flex', gap: 8, fontSize: 12.5, fontWeight: 500, color: TOK.ink2, lineHeight: 1.35 }}>
                        <span style={{ color: TOK.teal, opacity: 0.6 }}>•</span>
                        {task}
                      </div>
                    ))}
                  </div>
                  <button
                    className="fh-press"
                    onClick={onOpenChecklist}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: 6,
                      height: 30,
                      padding: '0 12px',
                      marginTop: 10,
                      borderRadius: 99,
                      border: 'none',
                      cursor: 'pointer',
                      fontSize: 12,
                      fontWeight: 800,
                      background: checklistChecked >= checklistTotal ? TOK.chkDoneBg : TOK.teal,
                      color: checklistChecked >= checklistTotal ? TOK.green : '#fff',
                    }}
                  >
                    <ClipboardList size={13} />{' '}
                    {checklistChecked >= checklistTotal ? t('hkChecklistDone', lang) : t('hkOpenChecklist', lang)}
                  </button>
                </div>
              )}
            </>
          )}

          {/* secondary actions: Add note / Mark for inspection / Found item */}
          {extraActionsSlot && !done && (
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>{extraActionsSlot}</div>
          )}

          {/* ── workflow buttons ── */}
          {done ? (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 9,
                minHeight: 54,
                borderRadius: 12,
                background: TOK.doneChip,
                flexWrap: 'wrap',
                padding: '8px 10px',
              }}
            >
              <CheckCircle2 size={22} color={TOK.green} />
              <span style={{ fontSize: 17, fontWeight: 800, color: TOK.green }}>{t('hkActionDone', lang)}</span>
              {completedTime && <span style={{ fontSize: 13, color: TOK.green, opacity: 0.7 }}>{completedTime}</span>}
              <span style={{ color: TOK.green, opacity: 0.35 }}>·</span>
              <button
                className="fh-press"
                onClick={onReset}
                disabled={isResetting}
                style={{
                  background: 'none',
                  border: 'none',
                  fontSize: 13.5,
                  fontWeight: 700,
                  color: TOK.green,
                  textDecoration: 'underline',
                  textUnderlineOffset: 2,
                  cursor: isResetting ? 'not-allowed' : 'pointer',
                  opacity: isResetting ? 0.5 : 1,
                  padding: '4px 6px',
                }}
              >
                {isResetting ? '…' : t('hkStartAgain', lang)}
              </button>
            </div>
          ) : inProg ? (
            <div style={{ display: 'flex', gap: 8 }}>
              {paused ? (
                <button
                  className="fh-press"
                  onClick={onResume}
                  disabled={isSavingResume}
                  style={{ ...bigBtn, flex: '0 0 104px', background: TOK.pausedBg, color: TOK.pausedInk, border: `1px solid ${TOK.pausedBorder}`, opacity: isSavingResume ? 0.6 : 1 }}
                >
                  <Play size={18} fill="currentColor" /> {isSavingResume ? '…' : t('hkActionResume', lang)}
                </button>
              ) : (
                <button
                  className="fh-press"
                  onClick={onPause}
                  disabled={isSavingPause}
                  style={{ ...bigBtn, flex: '0 0 104px', background: TOK.ctrlBg, color: TOK.ctrlInk, border: `1px solid ${TOK.borderStrong}`, opacity: isSavingPause ? 0.6 : 1 }}
                >
                  <Pause size={18} /> {isSavingPause ? '…' : t('hkStopLabel', lang)}
                </button>
              )}
              <button
                className="fh-press"
                onClick={onComplete}
                disabled={isSavingComplete}
                style={{ ...bigBtn, flex: 1, background: TOK.teal, color: 'white', boxShadow: '0 8px 20px rgba(0,98,98,.28)', opacity: isSavingComplete ? 0.6 : 1 }}
              >
                <Check size={20} strokeWidth={3} /> {isSavingComplete ? '…' : t('hkActionDone', lang)}
              </button>
              <button
                className="fh-press"
                onClick={onReportIssue}
                aria-label={t('hkReportIssueAria', lang)}
                style={{ ...bigBtn, flex: '0 0 50px', background: TOK.ctrlBg, color: TOK.ctrlInk2, border: `1px solid ${TOK.borderStrong}` }}
              >
                <AlertTriangle size={19} />
              </button>
            </div>
          ) : (
            <div style={{ display: 'flex', gap: 10 }}>
              <button
                className="fh-press"
                onClick={onStart}
                disabled={isSavingStart}
                style={{ ...bigBtn, flex: 1, background: TOK.teal, color: 'white', boxShadow: '0 8px 20px rgba(0,98,98,.28)', opacity: isSavingStart ? 0.6 : 1 }}
              >
                <Play size={20} fill="currentColor" /> {isSavingStart ? '…' : t('hkStartCleaning', lang)}
              </button>
              <button
                className="fh-press"
                onClick={onReportIssue}
                aria-label={t('hkReportIssueAria', lang)}
                style={{ ...bigBtn, flex: '0 0 80px', background: TOK.ctrlBg, color: TOK.ctrlInk2, fontSize: 13.5, gap: 6 }}
              >
                <AlertTriangle size={18} /> {t('hkIssueShort', lang)}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
