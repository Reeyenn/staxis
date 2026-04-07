'use client';

import React, { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import {
  collectionGroup,
  doc,
  getDoc,
  query,
  where,
  onSnapshot,
  updateDoc,
  Timestamp,
  DocumentReference,
} from 'firebase/firestore';
import { signInAnonymously } from 'firebase/auth';
import { db, auth } from '@/lib/firebase';
import { todayStr } from '@/lib/utils';
import type { Room, RoomStatus } from '@/types';
import { format } from 'date-fns';
import { CheckCircle, AlertTriangle } from 'lucide-react';
import { useLang } from '@/contexts/LanguageContext';
import { t } from '@/lib/translations';
import type { Language } from '@/lib/translations';

type RoomWithRef = Room & { _ref: DocumentReference };

function firestoreToDate(v: unknown): Date {
  if (v && typeof (v as { toDate?: unknown }).toDate === 'function') {
    return (v as { toDate: () => Date }).toDate();
  }
  return new Date(v as string | number);
}

const PRIORITY_SCORE: Record<string, number> = { vip: 0, early: 1, standard: 2 };

function sortRooms(rooms: RoomWithRef[]): RoomWithRef[] {
  return [...rooms].sort((a, b) => {
    if (a.type !== b.type) {
      if (a.type === 'checkout') return -1;
      if (b.type === 'checkout') return 1;
      if (a.type === 'stayover') return -1;
      return 1;
    }
    const pDiff = (PRIORITY_SCORE[a.priority] ?? 2) - (PRIORITY_SCORE[b.priority] ?? 2);
    if (pDiff !== 0) return pDiff;
    return parseInt(a.number, 10) - parseInt(b.number, 10);
  });
}

export default function HousekeeperRoomPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: housekeeperId } = React.use(params);
  const searchParams = useSearchParams();
  const uid = searchParams.get('uid');
  const pid = searchParams.get('pid');
  const today = todayStr();
  const { lang, setLang } = useLang();

  const [rooms, setRooms] = useState<RoomWithRef[]>([]);
  const [loading, setLoading] = useState(true);
  const [savingRoomId, setSavingRoomId] = useState<string | null>(null);
  const [issueRoomId, setIssueRoomId] = useState<string | null>(null);
  const [issueNote, setIssueNote] = useState('');
  const [savingIssue, setSavingIssue] = useState(false);
  const [savingDnd, setSavingDnd] = useState<string | null>(null);
  const [helpSent, setHelpSent] = useState<Set<string>>(new Set());
  const [savingHelp, setSavingHelp] = useState<string | null>(null);

  // Load saved language preference from staffPrefs on mount so the page
  // auto-displays in Spanish for HKs who replied ESPAÑOL to a text.
  useEffect(() => {
    if (!housekeeperId) return;
    const prefRef = doc(db, 'staffPrefs', housekeeperId);
    getDoc(prefRef)
      .then(snap => {
        if (snap.exists()) {
          const pref = snap.data() as { language?: 'en' | 'es' };
          if (pref.language === 'es' || pref.language === 'en') {
            setLang(pref.language as Language);
          }
        }
      })
      .catch(err => console.error('[housekeeper] staffPrefs load failed:', err));
  }, [housekeeperId, setLang]);

  useEffect(() => {
    let unsub: (() => void) | undefined;

    const subscribeToRooms = () => {
      const q = query(
        collectionGroup(db, 'rooms'),
        where('assignedTo', '==', housekeeperId),
      );

      unsub = onSnapshot(
        q,
        snap => {
          const data = snap.docs
            .map(d => ({ id: d.id, _ref: d.ref, ...d.data() } as RoomWithRef))
            .filter(r => r.date === today);
          setRooms(sortRooms(data));
          setLoading(false);
        },
        error => {
          console.error('[housekeeper] Firestore error:', error);
          setLoading(false);
        },
      );
    };

    const currentUser = auth.currentUser;
    if (currentUser) {
      subscribeToRooms();
    } else {
      signInAnonymously(auth)
        .then(subscribeToRooms)
        .catch(err => {
          console.error('[housekeeper] Anonymous auth failed:', err);
          setLoading(false);
        });
    }

    return () => unsub?.();
  }, [housekeeperId, today]);

  // ── Start room (dirty → in_progress) ──────────────────────────────────────
  const handleStartRoom = async (room: RoomWithRef) => {
    setSavingRoomId(room.id);
    try {
      await updateDoc(room._ref, {
        status: 'in_progress' as RoomStatus,
        startedAt: Timestamp.now(),
      });
    } catch (err) {
      console.error('[housekeeper] start room error:', err);
    } finally {
      setSavingRoomId(null);
    }
  };

  // ── Finish room (in_progress → clean) ─────────────────────────────────────
  // Requires hold-to-confirm on the button - accidental taps are ignored.
  const handleFinishRoom = async (room: RoomWithRef) => {
    setSavingRoomId(room.id);
    try {
      const updates: Record<string, unknown> = {
        status: 'clean' as RoomStatus,
        completedAt: Timestamp.now(),
      };
      // Safety net: write startedAt if somehow missing
      if (!room.startedAt) {
        updates.startedAt = Timestamp.now();
      }
      await updateDoc(room._ref, updates);
    } catch (err) {
      console.error('[housekeeper] finish room error:', err);
    } finally {
      setSavingRoomId(null);
    }
  };

  // ── Toggle DND on a room ────────────────────────────────────────────────────
  const handleToggleDnd = async (room: RoomWithRef) => {
    setSavingDnd(room.id);
    try {
      const newDnd = !room.isDnd;
      await updateDoc(room._ref, {
        isDnd: newDnd,
        ...(newDnd ? { dndNote: `Marked DND by housekeeper at ${new Date().toLocaleTimeString()}` } : { dndNote: '' }),
      });
    } catch (err) {
      console.error('[housekeeper] toggle DND error:', err);
    } finally {
      setSavingDnd(null);
    }
  };

  // ── Need Help - alert Maria ───────────────────────────────────────────────
  const handleNeedHelp = async (room: RoomWithRef) => {
    if (helpSent.has(room.id)) return; // already sent for this room
    setSavingHelp(room.id);
    try {
      await updateDoc(room._ref, {
        helpRequested: true,
        helpRequestedAt: Timestamp.now(),
        helpRequestedBy: housekeeperId,
      });
      setHelpSent(prev => new Set(prev).add(room.id));

      // Send SMS notification to front desk staff (best-effort, don't block on failure)
      if (uid && pid) {
        fetch('/api/help-request', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            uid,
            pid,
            staffName: room.assignedName || 'Housekeeper',
            roomNumber: room.number,
            language: lang,
          }),
        }).catch(err => {
          console.error('[housekeeper] help request SMS failed:', err);
        });
      }
    } catch (err) {
      console.error('[housekeeper] help request error:', err);
    } finally {
      setSavingHelp(null);
    }
  };

  // ── Report Issue ───────────────────────────────────────────────────────────
  const handleSubmitIssue = async () => {
    if (!issueRoomId || !issueNote.trim()) return;
    setSavingIssue(true);
    const room = rooms.find(r => r.id === issueRoomId);
    if (room) {
      await updateDoc(room._ref, { issueNote: issueNote.trim() });
    }
    setSavingIssue(false);
    setIssueRoomId(null);
    setIssueNote('');
  };

  // ── Derived state ──────────────────────────────────────────────────────────
  const housekeeperName = rooms[0]?.assignedName ?? '';
  const firstName = housekeeperName.split(' ')[0] || 'Housekeeper';
  const total = rooms.length;
  const done = rooms.filter(r => r.status === 'clean' || r.status === 'inspected').length;
  const inProgress = rooms.filter(r => r.status === 'in_progress').length;
  const allDone = total > 0 && done === total;
  const progressPct = total > 0 ? Math.round((done / total) * 100) : 0;

  if (loading) {
    return (
      <div style={{
        minHeight: '100dvh', display: 'flex', alignItems: 'center', justifyContent: 'center',
        flexDirection: 'column', gap: '12px',
        background: 'var(--bg)', fontFamily: 'system-ui, -apple-system, sans-serif',
      }}>
        <div style={{
          width: '32px', height: '32px', border: '4px solid var(--border)',
          borderTopColor: 'var(--green)', borderRadius: '50%',
          animation: 'spin 0.8s linear infinite',
        }} />
        <p style={{ color: 'var(--text-muted)', fontSize: '14px' }}>
          {t('loadingRooms', lang)}
        </p>
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      </div>
    );
  }

  return (
    <div style={{
      minHeight: '100dvh', background: 'var(--green-bg, #F0FDF4)',
      fontFamily: 'var(--font-sans, system-ui, -apple-system, BlinkMacSystemFont, sans-serif)',
    }}>

      {/* ── Header ── */}
      <div style={{ background: 'var(--green-dark, #166534)', padding: '20px 16px 28px', color: 'white' }}>
        <p style={{
          fontSize: '11px', fontWeight: 600, letterSpacing: '0.08em',
          textTransform: 'uppercase', opacity: 0.55, marginBottom: '6px',
        }}>
          Staxis
        </p>

        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '12px' }}>
          <div>
            <h1 style={{ fontSize: '28px', fontWeight: 800, letterSpacing: '-0.02em', marginBottom: '2px', lineHeight: 1.1 }}>
              {lang === 'es' ? `Hola, ${firstName}` : `Hi, ${firstName}`}
            </h1>
            <p style={{ fontSize: '13px', opacity: 0.7, fontWeight: 500 }}>
              {format(new Date(), 'EEEE, MMMM d')}
            </p>
          </div>

          <button
            onClick={() => setLang(lang === 'en' ? 'es' : 'en')}
            style={{
              background: 'rgba(255,255,255,0.18)',
              border: '1.5px solid rgba(255,255,255,0.35)',
              borderRadius: '12px', color: 'white',
              fontWeight: 700, fontSize: '14px',
              padding: '10px 16px', cursor: 'pointer',
              letterSpacing: '0.05em', flexShrink: 0,
              WebkitTapHighlightColor: 'transparent',
            }}
          >
            {lang === 'en' ? 'ES' : 'EN'}
          </button>
        </div>

        {/* Progress bar */}
        {total > 0 && (
          <div style={{ marginTop: '20px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px' }}>
              <span style={{ fontSize: '14px', fontWeight: 600 }}>
                {lang === 'es'
                  ? `${done} de ${total} listas${inProgress > 0 ? ` · ${inProgress} en progreso` : ''}`
                  : `${done} of ${total} done${inProgress > 0 ? ` · ${inProgress} in progress` : ''}`}
              </span>
              <span style={{ fontSize: '14px', fontWeight: 700, opacity: 0.9 }}>
                {progressPct}%
              </span>
            </div>
            <div style={{
              height: '10px', background: 'rgba(255,255,255,0.2)',
              borderRadius: '99px', overflow: 'hidden',
            }}>
              <div style={{
                height: '100%', width: `${progressPct}%`,
                background: progressPct === 100 ? 'var(--green)' : 'var(--green-light, #86EFAC)',
                borderRadius: '99px',
                transition: 'width 500ms cubic-bezier(0.4,0,0.2,1)',
              }} />
            </div>
          </div>
        )}
      </div>

      {/* ── Room list ── */}
      <div style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: '12px' }}>

        {allDone ? (
          <div style={{
            textAlign: 'center', padding: '64px 24px', background: 'white',
            borderRadius: '20px', boxShadow: '0 2px 8px rgba(0,0,0,0.06)',
          }}>
            <div style={{
              width: '84px', height: '84px', borderRadius: '50%',
              background: 'var(--green-dim)', display: 'flex', alignItems: 'center',
              justifyContent: 'center', margin: '0 auto 20px',
            }}>
              <CheckCircle size={42} color="var(--green)" />
            </div>
            <h2 style={{ fontSize: '26px', fontWeight: 800, color: 'var(--text-primary)', marginBottom: '10px' }}>
              {t('allDone', lang)}
            </h2>
            <p style={{ fontSize: '16px', color: 'var(--text-secondary)', lineHeight: 1.5 }}>
              {lang === 'es'
                ? `¡Buen trabajo hoy, ${firstName}! 🎉`
                : `Great work today, ${firstName}! 🎉`}
            </p>
          </div>
        ) : total === 0 ? (
          <div style={{
            textAlign: 'center', padding: '64px 24px', background: 'white',
            borderRadius: '20px', boxShadow: '0 2px 8px rgba(0,0,0,0.06)',
          }}>
            <p style={{ fontSize: '16px', color: 'var(--text-muted)', lineHeight: 1.8 }}>
              {lang === 'es'
                ? <><strong>{t('noRoomsAssigned', lang)}</strong><br />{t('checkBackSoon', lang)}</>
                : <><strong>{t('noRoomsAssigned', lang)}</strong><br />{t('checkBackSoon', lang)}</>}
            </p>
          </div>
        ) : (
          rooms.map((room, idx) => (
            <RoomCard
              key={room.id}
              room={room}
              lang={lang}
              index={idx + 1}
              isSaving={savingRoomId === room.id}
              isSavingDnd={savingDnd === room.id}
              isSavingHelp={savingHelp === room.id}
              helpAlreadySent={helpSent.has(room.id)}
              onStart={() => handleStartRoom(room)}
              onFinish={() => handleFinishRoom(room)}
              onReportIssue={() => {
                setIssueRoomId(room.id);
                setIssueNote((room as Room & { issueNote?: string }).issueNote ?? '');
              }}
              onToggleDnd={() => handleToggleDnd(room)}
              onNeedHelp={() => handleNeedHelp(room)}
            />
          ))
        )}
      </div>

      {/* ── Report Issue modal ── */}
      {issueRoomId && (
        <div
          role="dialog"
          aria-modal="true"
          style={{
            position: 'fixed', inset: 0,
            background: 'rgba(0,0,0,0.4)',
            display: 'flex', alignItems: 'flex-end',
            zIndex: 200,
          }}
          onClick={e => {
            if (e.target === e.currentTarget) {
              setIssueRoomId(null);
              setIssueNote('');
            }
          }}
        >
          <div style={{
            width: '100%', background: 'white',
            borderRadius: '20px 20px 0 0',
            padding: '24px 16px calc(env(safe-area-inset-bottom, 0px) + 24px)',
          }}>
            <h3 style={{ fontSize: '20px', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '4px' }}>
              {t('reportIssue', lang)}
            </h3>
            <p style={{ fontSize: '13px', color: 'var(--text-muted)', marginBottom: '16px' }}>
              {lang === 'es' ? 'Hab.' : 'Room'} {rooms.find(r => r.id === issueRoomId)?.number}
            </p>
            <textarea
              // eslint-disable-next-line jsx-a11y/no-autofocus
              autoFocus
              placeholder={t('describeIssue', lang)}
              value={issueNote}
              onChange={e => setIssueNote(e.target.value)}
              rows={4}
              style={{
                width: '100%', padding: '14px', boxSizing: 'border-box',
                border: '1.5px solid var(--border)', borderRadius: '12px',
                fontSize: '16px', fontFamily: 'inherit',
                resize: 'none', outline: 'none', lineHeight: 1.5,
              }}
              onFocus={e => { e.target.style.borderColor = 'var(--green-dark, #166534)'; }}
              onBlur={e => { e.target.style.borderColor = 'var(--border)'; }}
            />
            <div style={{ display: 'flex', gap: '10px', marginTop: '14px' }}>
              <button
                onClick={() => { setIssueRoomId(null); setIssueNote(''); }}
                style={{
                  flex: 1, height: '56px', background: 'var(--bg-elevated, #F3F4F6)', border: 'none',
                  borderRadius: '12px', fontSize: '17px', fontWeight: 600,
                  color: 'var(--text-secondary)', cursor: 'pointer',
                  WebkitTapHighlightColor: 'transparent',
                }}
              >
                {t('cancel', lang)}
              </button>
              <button
                onClick={handleSubmitIssue}
                disabled={!issueNote.trim() || savingIssue}
                style={{
                  flex: 1, height: '56px', border: 'none', borderRadius: '12px',
                  fontSize: '17px', fontWeight: 600,
                  cursor: !issueNote.trim() || savingIssue ? 'not-allowed' : 'pointer',
                  background: !issueNote.trim() || savingIssue ? 'var(--border)' : 'var(--green-dark, #166534)',
                  color: !issueNote.trim() || savingIssue ? 'var(--text-muted)' : 'white',
                  transition: 'background 150ms ease',
                  WebkitTapHighlightColor: 'transparent',
                }}
              >
                {savingIssue
                  ? t('savingDots', lang)
                  : t('submit', lang)}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────────
   RoomCard
   States:
     • dirty:       "Start" button (blue)
     • in_progress: "Hold to Finish" button (green, hold-to-confirm)
     • clean/inspected: green "Done ✓" pill
   ───────────────────────────────────────────────────────────────────────── */
function RoomCard({
  room,
  lang,
  index,
  isSaving,
  isSavingDnd,
  isSavingHelp,
  helpAlreadySent,
  onStart,
  onFinish,
  onReportIssue,
  onToggleDnd,
  onNeedHelp,
}: {
  room: RoomWithRef;
  lang: Language;
  index: number;
  isSaving: boolean;
  isSavingDnd: boolean;
  isSavingHelp: boolean;
  helpAlreadySent: boolean;
  onStart: () => void;
  onFinish: () => void;
  onReportIssue: () => void;
  onToggleDnd: () => void;
  onNeedHelp: () => void;
}) {
  const isDone = room.status === 'clean' || room.status === 'inspected';
  const isInProgress = room.status === 'in_progress';

  const typeLabel =
    room.type === 'checkout' ? (lang === 'es' ? 'SALIDA' : 'CHECKOUT')
    : room.type === 'stayover' ? (lang === 'es' ? 'OCUPADA' : 'STAYOVER')
    : (lang === 'es' ? 'VACANTE' : 'VACANT');

  const accentColor =
    isDone ? 'var(--green)'
    : isInProgress ? 'var(--amber)'
    : room.priority === 'vip' ? 'var(--red)'
    : room.priority === 'early' ? 'var(--orange, #EA580C)'
    : 'var(--border)';

  const cardBg = isDone ? 'var(--green-bg, #F0FDF4)' : isInProgress ? 'var(--amber-bg, #FFFBEB)' : 'white';
  const cardBorder = isDone ? 'var(--green-light, #86EFAC)' : isInProgress ? 'var(--amber-light, #FCD34D)' : 'var(--border-light, #E5E7EB)';

  return (
    <div style={{
      background: cardBg,
      border: `2px solid ${cardBorder}`,
      borderLeft: `6px solid ${accentColor}`,
      borderRadius: '16px',
      padding: '16px',
      transition: 'background 300ms ease, border-color 300ms ease',
      boxShadow: isDone ? 'none' : '0 1px 6px rgba(0,0,0,0.07)',
    }}>

      {/* DND banner */}
      {room.isDnd && (
        <div style={{
          background: 'var(--amber-light, #FCD34D)', color: 'var(--amber-dark, #78350F)',
          padding: '10px 14px', borderRadius: '10px',
          fontSize: '14px', fontWeight: 700, marginBottom: '12px',
        }}>
          {lang === 'es' ? '🚫 No Molestar' : '🚫 ' + t('doNotDisturb', lang)}
        </div>
      )}

      {/* Top row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '14px' }}>
        <span style={{
          fontSize: '13px', fontWeight: 700,
          color: isDone ? 'var(--green)' : isInProgress ? 'var(--amber)' : 'var(--text-muted)',
          minWidth: '18px', lineHeight: 1, flexShrink: 0,
        }}>
          {index}.
        </span>

        <span style={{
          fontFamily: 'ui-monospace, monospace', fontWeight: 800, fontSize: '34px',
          color: isDone ? 'var(--green)' : isInProgress ? 'var(--amber-dark, #92400E)' : 'var(--text-primary)',
          letterSpacing: '-0.02em', lineHeight: 1,
        }}>
          {room.number}
        </span>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', flex: 1 }}>
          <span style={{
            fontSize: '11px', fontWeight: 700, textTransform: 'uppercase',
            letterSpacing: '0.07em',
            color: isDone ? 'var(--green)' : isInProgress ? 'var(--amber)' : 'var(--text-secondary)',
          }}>
            {isInProgress
              ? (lang === 'es' ? '⟳ ' + t('inProgress', lang) : '⟳ ' + t('inProgress', lang))
              : typeLabel}
          </span>
          {room.priority === 'vip' && !isDone && !isInProgress && (
            <span style={{
              fontSize: '11px', fontWeight: 700, color: 'var(--red)',
              background: 'var(--red-dim)', padding: '2px 7px', borderRadius: '5px',
              display: 'inline-block', width: 'fit-content',
            }}>
              ★ VIP
            </span>
          )}
          {room.priority === 'early' && !isDone && !isInProgress && (
            <span style={{
              fontSize: '11px', fontWeight: 700, color: 'var(--orange, #EA580C)',
              background: 'var(--orange-dim, #FFF7ED)', padding: '2px 7px', borderRadius: '5px',
              display: 'inline-block', width: 'fit-content',
            }}>
              ⚡ {t('earlyCheckin', lang)}
            </span>
          )}
          {/* Show startedAt time when in progress */}
          {isInProgress && room.startedAt && (
            <span style={{ fontSize: '11px', color: 'var(--amber)', fontWeight: 600 }}>
              {t('start', lang)}
              {format(firestoreToDate(room.startedAt), 'h:mm a')}
            </span>
          )}
        </div>

        <div style={{ display: 'flex', gap: '6px', flexShrink: 0 }}>
          {/* DND toggle button */}
          {!isDone && (
            <button
              onClick={onToggleDnd}
              disabled={isSavingDnd}
              style={{
                width: '40px', height: '40px',
                border: `1.5px solid ${room.isDnd ? 'var(--amber)' : 'var(--border-light, #E5E7EB)'}`,
                borderRadius: '10px',
                background: room.isDnd ? 'var(--amber-dim)' : 'transparent',
                cursor: isSavingDnd ? 'not-allowed' : 'pointer',
                flexShrink: 0,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                opacity: isSavingDnd ? 0.4 : room.isDnd ? 1 : 0.6,
                WebkitTapHighlightColor: 'transparent',
                transition: 'all 150ms ease',
              }}
              aria-label={room.isDnd ? t('removeDnd', lang) : t('markDnd', lang)}
            >
              <span style={{ fontSize: '16px', lineHeight: 1 }}>🚫</span>
            </button>
          )}

          {/* Report issue button */}
          <button
            onClick={onReportIssue}
            style={{
              width: '40px', height: '40px',
              border: '1.5px solid var(--border-light, #E5E7EB)',
              borderRadius: '10px', background: 'transparent',
              cursor: 'pointer', flexShrink: 0,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              opacity: 0.6,
              WebkitTapHighlightColor: 'transparent',
            }}
            aria-label={lang === 'es' ? 'Reportar problema' : 'Report issue'}
          >
            <AlertTriangle size={17} color="var(--text-muted)" />
          </button>
        </div>
      </div>

      {/* Issue note */}
      {(room as Room & { issueNote?: string }).issueNote && (
        <div style={{
          display: 'flex', gap: '6px', alignItems: 'flex-start',
          padding: '9px 11px', background: 'var(--amber-dim)', borderRadius: '10px',
          marginBottom: '12px',
        }}>
          <AlertTriangle size={13} color="var(--amber)" style={{ flexShrink: 0, marginTop: '2px' }} />
          <span style={{ fontSize: '13px', color: 'var(--amber-dark, #92400E)', lineHeight: 1.4 }}>
            {(room as Room & { issueNote?: string }).issueNote}
          </span>
        </div>
      )}

      {/* ── Action area ── */}
      {isDone ? (
        <div style={{
          height: '56px', borderRadius: '14px',
          background: 'var(--green-dim)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '10px',
        }}>
          <CheckCircle size={22} color="var(--green)" />
          <span style={{ fontSize: '18px', fontWeight: 800, color: 'var(--green)' }}>
            {t('done', lang)}
          </span>
          {room.completedAt && (
            <span style={{ fontSize: '13px', color: 'var(--green)', opacity: 0.65, marginLeft: '2px' }}>
              {format(firestoreToDate(room.completedAt), 'h:mm a')}
            </span>
          )}
        </div>
      ) : isInProgress ? (
        <HoldToFinishButton lang={lang} isSaving={isSaving} onFinish={onFinish} />
      ) : (
        <StartButton lang={lang} isSaving={isSaving} onStart={onStart} />
      )}

      {/* ── Need Help button — visible when in progress ── */}
      {isInProgress && (
        <button
          onClick={onNeedHelp}
          disabled={isSavingHelp || helpAlreadySent}
          style={{
            width: '100%', height: '48px', marginTop: '8px',
            border: helpAlreadySent ? '2px solid var(--green-light, #86EFAC)' : '2px solid var(--red-light, #FCA5A5)',
            borderRadius: '12px',
            background: helpAlreadySent ? 'var(--green-bg, #F0FDF4)' : isSavingHelp ? 'var(--red-dim)' : 'var(--red-dim)',
            color: helpAlreadySent ? 'var(--green)' : 'var(--red)',
            fontSize: '16px', fontWeight: 700,
            cursor: isSavingHelp || helpAlreadySent ? 'not-allowed' : 'pointer',
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px',
            WebkitTapHighlightColor: 'transparent',
            transition: 'all 150ms ease',
          }}
        >
          {helpAlreadySent ? (
            <>
              <CheckCircle size={18} color="var(--green)" />
              {t('helpAlertSent', lang)}
            </>
          ) : isSavingHelp ? (
            t('savingDots', lang)
          ) : (
            <>
              <span style={{ fontSize: '18px' }}>🆘</span>
              {t('needHelp', lang)}
            </>
          )}
        </button>
      )}
    </div>
  );
}

/* ── Start Button - single tap, no protection needed ── */
function StartButton({
  lang,
  isSaving,
  onStart,
}: {
  lang: Language;
  isSaving: boolean;
  onStart: () => void;
}) {
  const [pressed, setPressed] = useState(false);

  return (
    <button
      onClick={onStart}
      disabled={isSaving}
      onPointerDown={() => !isSaving && setPressed(true)}
      onPointerUp={() => setPressed(false)}
      onPointerLeave={() => setPressed(false)}
      style={{
        width: '100%', height: '68px', border: 'none', borderRadius: '14px',
        background: isSaving ? 'var(--border)' : pressed ? 'var(--navy)' : 'var(--navy-light, #2563EB)',
        color: isSaving ? 'var(--text-muted)' : 'white',
        fontSize: '20px', fontWeight: 800,
        cursor: isSaving ? 'not-allowed' : 'pointer',
        letterSpacing: '-0.01em',
        transform: pressed && !isSaving ? 'scale(0.97)' : 'scale(1)',
        transition: 'background 100ms ease, transform 80ms ease',
        WebkitTapHighlightColor: 'transparent',
        boxShadow: pressed || isSaving ? 'none' : '0 4px 12px rgba(37,99,235,0.35)',
      }}
    >
      {isSaving
        ? t('savingDots', lang)
        : (lang === 'es' ? '▶ Empezar' : '▶ ' + t('start', lang))}
    </button>
  );
}

/* ── Hold to Finish Button - press and hold 1.5s to confirm ──
   Prevents accidental taps. A progress bar fills while holding.
   Release early = cancel. Complete = fires onFinish.            */
function HoldToFinishButton({
  lang,
  isSaving,
  onFinish,
}: {
  lang: Language;
  isSaving: boolean;
  onFinish: () => void;
}) {
  const [progress, setProgress] = useState(0); // 0–100
  const holdStartRef = useRef<number | null>(null);
  const rafRef = useRef<number | null>(null);
  const firedRef = useRef(false);
  const HOLD_MS = 1500;

  const startHold = () => {
    if (isSaving) return;
    firedRef.current = false;
    holdStartRef.current = Date.now();

    const tick = () => {
      if (!holdStartRef.current) return;
      const elapsed = Date.now() - holdStartRef.current;
      const pct = Math.min(100, (elapsed / HOLD_MS) * 100);
      setProgress(pct);

      if (pct >= 100 && !firedRef.current) {
        firedRef.current = true;
        holdStartRef.current = null;
        onFinish();
        setProgress(0);
      } else if (pct < 100) {
        rafRef.current = requestAnimationFrame(tick);
      }
    };

    rafRef.current = requestAnimationFrame(tick);
  };

  const cancelHold = () => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    holdStartRef.current = null;
    setProgress(0);
  };

  const isHolding = progress > 0;
  const label = isSaving
    ? t('savingDots', lang)
    : isHolding
      ? t('keepHolding', lang)
      : t('holdToFinish', lang);

  return (
    <button
      disabled={isSaving}
      onPointerDown={startHold}
      onPointerUp={cancelHold}
      onPointerLeave={cancelHold}
      onPointerCancel={cancelHold}
      style={{
        position: 'relative',
        width: '100%', height: '68px', border: 'none', borderRadius: '14px',
        background: 'var(--green-dim)',
        color: 'var(--green-dark, #166534)',
        fontSize: '18px', fontWeight: 800,
        cursor: isSaving ? 'not-allowed' : 'pointer',
        letterSpacing: '-0.01em',
        overflow: 'hidden',
        WebkitTapHighlightColor: 'transparent',
        userSelect: 'none',
        // Subtle border to distinguish from the done state
        outline: '2px solid var(--green-light, #86EFAC)',
      }}
    >
      {/* Fill bar - grows left to right as user holds */}
      <div style={{
        position: 'absolute',
        inset: 0,
        background: 'var(--green)',
        transformOrigin: 'left center',
        transform: `scaleX(${progress / 100})`,
        transition: progress === 0 ? 'transform 200ms ease' : 'none',
        borderRadius: '14px',
      }} />

      {/* Label on top of fill */}
      <span style={{
        position: 'relative',
        zIndex: 1,
        color: progress > 50 ? 'white' : 'var(--green-dark, #166534)',
        transition: 'color 150ms ease',
        pointerEvents: 'none',
      }}>
        {label}
      </span>
    </button>
  );
}
