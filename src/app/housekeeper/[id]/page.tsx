'use client';

import React, { useEffect, useRef, useState } from 'react';
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
  const today = todayStr();
  const { lang, setLang } = useLang();

  const [rooms, setRooms] = useState<RoomWithRef[]>([]);
  const [loading, setLoading] = useState(true);
  const [savingRoomId, setSavingRoomId] = useState<string | null>(null);
  const [issueRoomId, setIssueRoomId] = useState<string | null>(null);
  const [issueNote, setIssueNote] = useState('');
  const [savingIssue, setSavingIssue] = useState(false);

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
  // Requires hold-to-confirm on the button — accidental taps are ignored.
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
        background: '#F0FDF4', fontFamily: 'system-ui, -apple-system, sans-serif',
      }}>
        <p style={{ color: '#6B7280', fontSize: '16px' }}>
          {lang === 'es' ? 'Cargando habitaciones…' : 'Loading your rooms…'}
        </p>
      </div>
    );
  }

  return (
    <div style={{
      minHeight: '100dvh', background: '#F0FDF4',
      fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, sans-serif',
    }}>

      {/* ── Header ── */}
      <div style={{ background: '#166534', padding: '20px 16px 28px', color: 'white' }}>
        <p style={{
          fontSize: '11px', fontWeight: 600, letterSpacing: '0.08em',
          textTransform: 'uppercase', opacity: 0.55, marginBottom: '6px',
        }}>
          HotelOps AI
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
                background: progressPct === 100 ? '#4ADE80' : '#86EFAC',
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
              background: '#DCFCE7', display: 'flex', alignItems: 'center',
              justifyContent: 'center', margin: '0 auto 20px',
            }}>
              <CheckCircle size={42} color="#16A34A" />
            </div>
            <h2 style={{ fontSize: '26px', fontWeight: 800, color: '#111827', marginBottom: '10px' }}>
              {lang === 'es' ? '¡Todo listo!' : "You're all done!"}
            </h2>
            <p style={{ fontSize: '16px', color: '#4B5563', lineHeight: 1.5 }}>
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
            <p style={{ fontSize: '16px', color: '#6B7280', lineHeight: 1.8 }}>
              {lang === 'es'
                ? <><strong>Sin habitaciones asignadas.</strong><br />¡Revisa pronto!</>
                : <><strong>No rooms assigned yet.</strong><br />Check back soon!</>}
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
              onStart={() => handleStartRoom(room)}
              onFinish={() => handleFinishRoom(room)}
              onReportIssue={() => {
                setIssueRoomId(room.id);
                setIssueNote((room as Room & { issueNote?: string }).issueNote ?? '');
              }}
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
            background: 'rgba(0,0,0,0.55)',
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
            <h3 style={{ fontSize: '20px', fontWeight: 700, color: '#111827', marginBottom: '4px' }}>
              {lang === 'es' ? 'Reportar Problema' : 'Report Issue'}
            </h3>
            <p style={{ fontSize: '13px', color: '#6B7280', marginBottom: '16px' }}>
              {lang === 'es' ? 'Hab.' : 'Room'} {rooms.find(r => r.id === issueRoomId)?.number}
            </p>
            <textarea
              // eslint-disable-next-line jsx-a11y/no-autofocus
              autoFocus
              placeholder={lang === 'es'
                ? 'Describe el problema (ej. ducha rota, toallas faltantes, mantenimiento)'
                : 'Describe the issue (e.g. broken shower, missing towels, maintenance needed)'}
              value={issueNote}
              onChange={e => setIssueNote(e.target.value)}
              rows={4}
              style={{
                width: '100%', padding: '14px', boxSizing: 'border-box',
                border: '1.5px solid #D1D5DB', borderRadius: '12px',
                fontSize: '16px', fontFamily: 'inherit',
                resize: 'none', outline: 'none', lineHeight: 1.5,
              }}
              onFocus={e => { e.target.style.borderColor = '#166534'; }}
              onBlur={e => { e.target.style.borderColor = '#D1D5DB'; }}
            />
            <div style={{ display: 'flex', gap: '10px', marginTop: '14px' }}>
              <button
                onClick={() => { setIssueRoomId(null); setIssueNote(''); }}
                style={{
                  flex: 1, height: '56px', background: '#F3F4F6', border: 'none',
                  borderRadius: '12px', fontSize: '17px', fontWeight: 600,
                  color: '#374151', cursor: 'pointer',
                  WebkitTapHighlightColor: 'transparent',
                }}
              >
                {lang === 'es' ? 'Cancelar' : 'Cancel'}
              </button>
              <button
                onClick={handleSubmitIssue}
                disabled={!issueNote.trim() || savingIssue}
                style={{
                  flex: 1, height: '56px', border: 'none', borderRadius: '12px',
                  fontSize: '17px', fontWeight: 600,
                  cursor: !issueNote.trim() || savingIssue ? 'not-allowed' : 'pointer',
                  background: !issueNote.trim() || savingIssue ? '#D1D5DB' : '#166534',
                  color: !issueNote.trim() || savingIssue ? '#9CA3AF' : 'white',
                  transition: 'background 150ms ease',
                  WebkitTapHighlightColor: 'transparent',
                }}
              >
                {savingIssue
                  ? (lang === 'es' ? 'Guardando…' : 'Saving…')
                  : (lang === 'es' ? 'Enviar' : 'Submit')}
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
  onStart,
  onFinish,
  onReportIssue,
}: {
  room: RoomWithRef;
  lang: Language;
  index: number;
  isSaving: boolean;
  onStart: () => void;
  onFinish: () => void;
  onReportIssue: () => void;
}) {
  const isDone = room.status === 'clean' || room.status === 'inspected';
  const isInProgress = room.status === 'in_progress';

  const typeLabel =
    room.type === 'checkout' ? (lang === 'es' ? 'SALIDA' : 'CHECKOUT')
    : room.type === 'stayover' ? (lang === 'es' ? 'OCUPADA' : 'STAYOVER')
    : (lang === 'es' ? 'VACANTE' : 'VACANT');

  const accentColor =
    isDone ? '#16A34A'
    : isInProgress ? '#D97706'
    : room.priority === 'vip' ? '#DC2626'
    : room.priority === 'early' ? '#EA580C'
    : '#D1D5DB';

  const cardBg = isDone ? '#F0FDF4' : isInProgress ? '#FFFBEB' : 'white';
  const cardBorder = isDone ? '#86EFAC' : isInProgress ? '#FCD34D' : '#E5E7EB';

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
          background: '#FCD34D', color: '#78350F',
          padding: '10px 14px', borderRadius: '10px',
          fontSize: '14px', fontWeight: 700, marginBottom: '12px',
        }}>
          {lang === 'es' ? '🚫 No Molestar' : '🚫 Do Not Disturb'}
        </div>
      )}

      {/* Top row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '14px' }}>
        <span style={{
          fontSize: '13px', fontWeight: 700,
          color: isDone ? '#16A34A' : isInProgress ? '#D97706' : '#9CA3AF',
          minWidth: '18px', lineHeight: 1, flexShrink: 0,
        }}>
          {index}.
        </span>

        <span style={{
          fontFamily: 'ui-monospace, monospace', fontWeight: 800, fontSize: '34px',
          color: isDone ? '#16A34A' : isInProgress ? '#92400E' : '#111827',
          letterSpacing: '-0.02em', lineHeight: 1,
        }}>
          {room.number}
        </span>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', flex: 1 }}>
          <span style={{
            fontSize: '11px', fontWeight: 700, textTransform: 'uppercase',
            letterSpacing: '0.07em',
            color: isDone ? '#16A34A' : isInProgress ? '#D97706' : '#6B7280',
          }}>
            {isInProgress
              ? (lang === 'es' ? '⟳ EN PROGRESO' : '⟳ IN PROGRESS')
              : typeLabel}
          </span>
          {room.priority === 'vip' && !isDone && !isInProgress && (
            <span style={{
              fontSize: '11px', fontWeight: 700, color: '#DC2626',
              background: '#FEE2E2', padding: '2px 7px', borderRadius: '5px',
              display: 'inline-block', width: 'fit-content',
            }}>
              ★ VIP
            </span>
          )}
          {room.priority === 'early' && !isDone && !isInProgress && (
            <span style={{
              fontSize: '11px', fontWeight: 700, color: '#EA580C',
              background: '#FFF7ED', padding: '2px 7px', borderRadius: '5px',
              display: 'inline-block', width: 'fit-content',
            }}>
              {lang === 'es' ? '⚡ Llegada Temprana' : '⚡ Early Check-in'}
            </span>
          )}
          {/* Show startedAt time when in progress */}
          {isInProgress && room.startedAt && (
            <span style={{ fontSize: '11px', color: '#D97706', fontWeight: 600 }}>
              {lang === 'es' ? 'Empezado ' : 'Started '}
              {format(firestoreToDate(room.startedAt), 'h:mm a')}
            </span>
          )}
        </div>

        <button
          onClick={onReportIssue}
          style={{
            width: '40px', height: '40px',
            border: '1.5px solid #E5E7EB',
            borderRadius: '10px', background: 'transparent',
            cursor: 'pointer', flexShrink: 0,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            opacity: 0.6,
            WebkitTapHighlightColor: 'transparent',
          }}
          aria-label={lang === 'es' ? 'Reportar problema' : 'Report issue'}
        >
          <AlertTriangle size={17} color="#6B7280" />
        </button>
      </div>

      {/* Issue note */}
      {(room as Room & { issueNote?: string }).issueNote && (
        <div style={{
          display: 'flex', gap: '6px', alignItems: 'flex-start',
          padding: '9px 11px', background: '#FEF3C7', borderRadius: '10px',
          marginBottom: '12px',
        }}>
          <AlertTriangle size={13} color="#D97706" style={{ flexShrink: 0, marginTop: '2px' }} />
          <span style={{ fontSize: '13px', color: '#92400E', lineHeight: 1.4 }}>
            {(room as Room & { issueNote?: string }).issueNote}
          </span>
        </div>
      )}

      {/* ── Action area ── */}
      {isDone ? (
        <div style={{
          height: '56px', borderRadius: '14px',
          background: '#DCFCE7',
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '10px',
        }}>
          <CheckCircle size={22} color="#16A34A" />
          <span style={{ fontSize: '18px', fontWeight: 800, color: '#16A34A' }}>
            {lang === 'es' ? 'Listo ✓' : 'Done ✓'}
          </span>
          {room.completedAt && (
            <span style={{ fontSize: '13px', color: '#16A34A', opacity: 0.65, marginLeft: '2px' }}>
              {format(firestoreToDate(room.completedAt), 'h:mm a')}
            </span>
          )}
        </div>
      ) : isInProgress ? (
        <HoldToFinishButton lang={lang} isSaving={isSaving} onFinish={onFinish} />
      ) : (
        <StartButton lang={lang} isSaving={isSaving} onStart={onStart} />
      )}
    </div>
  );
}

/* ── Start Button — single tap, no protection needed ── */
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
        background: isSaving ? '#D1D5DB' : pressed ? '#1D4ED8' : '#2563EB',
        color: isSaving ? '#9CA3AF' : 'white',
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
        ? (lang === 'es' ? 'Guardando…' : 'Saving…')
        : (lang === 'es' ? '▶ Empezar' : '▶ Start')}
    </button>
  );
}

/* ── Hold to Finish Button — press and hold 1.5s to confirm ──
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
    ? (lang === 'es' ? 'Guardando…' : 'Saving…')
    : isHolding
      ? (lang === 'es' ? 'Sigue presionando…' : 'Keep holding…')
      : (lang === 'es' ? 'Mantén para terminar' : 'Hold to Finish');

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
        background: '#D1FAE5',
        color: '#166534',
        fontSize: '18px', fontWeight: 800,
        cursor: isSaving ? 'not-allowed' : 'pointer',
        letterSpacing: '-0.01em',
        overflow: 'hidden',
        WebkitTapHighlightColor: 'transparent',
        userSelect: 'none',
        // Subtle border to distinguish from the done state
        outline: '2px solid #86EFAC',
      }}
    >
      {/* Fill bar — grows left to right as user holds */}
      <div style={{
        position: 'absolute',
        inset: 0,
        background: '#16A34A',
        transformOrigin: 'left center',
        transform: `scaleX(${progress / 100})`,
        transition: progress === 0 ? 'transform 200ms ease' : 'none',
        borderRadius: '14px',
      }} />

      {/* Label on top of fill */}
      <span style={{
        position: 'relative',
        zIndex: 1,
        color: progress > 50 ? 'white' : '#166534',
        transition: 'color 150ms ease',
        pointerEvents: 'none',
      }}>
        {label}
      </span>
    </button>
  );
}
