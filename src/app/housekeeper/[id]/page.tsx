'use client';

import React, { useEffect, useRef, useState } from 'react';
import {
  collectionGroup,
  query,
  where,
  onSnapshot,
  updateDoc,
  writeBatch,
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
    // Checkouts before stayovers before vacant
    if (a.type !== b.type) {
      if (a.type === 'checkout') return -1;
      if (b.type === 'checkout') return 1;
      if (a.type === 'stayover') return -1;
      return 1;
    }
    // Within same type: vip > early > standard
    const pDiff = (PRIORITY_SCORE[a.priority] ?? 2) - (PRIORITY_SCORE[b.priority] ?? 2);
    if (pDiff !== 0) return pDiff;
    // Finally by room number (numeric sort)
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

  // Guard so we only batch-write startedAt once per session (not on every snapshot)
  const sessionInitDone = useRef(false);

  useEffect(() => {
    let unsub: (() => void) | undefined;

    const subscribeToRooms = () => {
      // Single where clause — avoids composite index on collectionGroup.
      // Date is filtered client-side.
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

          // ── Per-room time tracking ────────────────────────────────────────
          // On first load, batch-write startedAt (= "when housekeeper saw their
          // list") for every pending room that doesn't have one yet.
          // This timestamp is the start_time for the scheduling model.
          // completedAt is written when they tap "Mark Clean" (the end_time).
          // Rooms that are already clean/inspected are skipped.
          if (!sessionInitDone.current) {
            sessionInitDone.current = true;
            const pageOpenedAt = Timestamp.now();
            const batch = writeBatch(db);
            let hasWrites = false;

            snap.docs.forEach(docSnap => {
              const d = docSnap.data();
              if (
                d.date === today &&
                !d.startedAt &&
                d.status !== 'clean' &&
                d.status !== 'inspected'
              ) {
                // Only writing startedAt — in the update allowlist in firestore.rules
                batch.update(docSnap.ref, { startedAt: pageOpenedAt });
                hasWrites = true;
              }
            });

            if (hasWrites) {
              batch.commit().catch(err =>
                console.error('[housekeeper] batch startedAt write failed:', err),
              );
            }
          }
        },
        error => {
          console.error('[housekeeper] Firestore error:', error);
          setLoading(false);
        },
      );
    };

    // Ensure auth before Firestore (rules require request.auth != null)
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

  // ── Mark Clean ─────────────────────────────────────────────────────────────
  // Single-tap: dirty / in_progress → clean.
  // Records completedAt (the end_time) and startedAt as fallback if missing.
  const handleMarkClean = async (room: RoomWithRef) => {
    setSavingRoomId(room.id);
    try {
      const updates: Record<string, unknown> = {
        status: 'clean' as RoomStatus,
        completedAt: Timestamp.now(),
      };
      // Safety net: if startedAt was never written (e.g. offline on page load)
      if (!room.startedAt) {
        updates.startedAt = Timestamp.now();
      }
      await updateDoc(room._ref, updates);
    } catch (err) {
      console.error('[housekeeper] mark clean error:', err);
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
  const allDone = total > 0 && done === total;
  const progressPct = total > 0 ? Math.round((done / total) * 100) : 0;

  // ── Loading ────────────────────────────────────────────────────────────────
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

  // ── Main render ────────────────────────────────────────────────────────────
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

          {/* Language toggle — large enough for wet hands */}
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
                  ? `${done} de ${total} habitaciones listas`
                  : `${done} of ${total} rooms done`}
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
          /* All done screen */
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
          /* No rooms yet */
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
              onMarkClean={() => handleMarkClean(room)}
              onReportIssue={() => {
                setIssueRoomId(room.id);
                setIssueNote((room as Room & { issueNote?: string }).issueNote ?? '');
              }}
            />
          ))
        )}
      </div>

      {/* ── Report Issue modal (bottom sheet) ── */}
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
   RoomCard — the core UI atom.
   States:
     • pending (dirty / in_progress): big green "Mark Clean" button
     • done (clean / inspected):      green "Done ✓" pill + completion time
   ───────────────────────────────────────────────────────────────────────── */
function RoomCard({
  room,
  lang,
  index,
  isSaving,
  onMarkClean,
  onReportIssue,
}: {
  room: RoomWithRef;
  lang: Language;
  index: number;
  isSaving: boolean;
  onMarkClean: () => void;
  onReportIssue: () => void;
}) {
  const isDone = room.status === 'clean' || room.status === 'inspected';

  const typeLabel =
    room.type === 'checkout' ? (lang === 'es' ? 'SALIDA' : 'CHECKOUT')
    : room.type === 'stayover' ? (lang === 'es' ? 'OCUPADA' : 'STAYOVER')
    : (lang === 'es' ? 'VACANTE' : 'VACANT');

  // Colour of left accent bar
  const accentColor =
    isDone ? '#16A34A'
    : room.priority === 'vip' ? '#DC2626'
    : room.priority === 'early' ? '#EA580C'
    : '#D1D5DB';

  return (
    <div style={{
      background: isDone ? '#F0FDF4' : 'white',
      border: isDone ? '2px solid #86EFAC' : '2px solid #E5E7EB',
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

      {/* Top row: index + room number + type/priority + issue button */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '14px' }}>
        {/* Sequence number */}
        <span style={{
          fontSize: '13px', fontWeight: 700,
          color: isDone ? '#16A34A' : '#9CA3AF',
          minWidth: '18px', lineHeight: 1, flexShrink: 0,
        }}>
          {index}.
        </span>

        {/* Room number */}
        <span style={{
          fontFamily: 'ui-monospace, monospace', fontWeight: 800, fontSize: '34px',
          color: isDone ? '#16A34A' : '#111827',
          letterSpacing: '-0.02em', lineHeight: 1,
        }}>
          {room.number}
        </span>

        {/* Type + priority tags */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', flex: 1 }}>
          <span style={{
            fontSize: '11px', fontWeight: 700, textTransform: 'uppercase',
            letterSpacing: '0.07em',
            color: isDone ? '#16A34A' : '#6B7280',
          }}>
            {typeLabel}
          </span>
          {room.priority === 'vip' && (
            <span style={{
              fontSize: '11px', fontWeight: 700, color: '#DC2626',
              background: '#FEE2E2', padding: '2px 7px', borderRadius: '5px',
              display: 'inline-block', width: 'fit-content',
            }}>
              ★ VIP
            </span>
          )}
          {room.priority === 'early' && (
            <span style={{
              fontSize: '11px', fontWeight: 700, color: '#EA580C',
              background: '#FFF7ED', padding: '2px 7px', borderRadius: '5px',
              display: 'inline-block', width: 'fit-content',
            }}>
              {lang === 'es' ? '⚡ Llegada Temprana' : '⚡ Early Check-in'}
            </span>
          )}
        </div>

        {/* Issue report button — small, secondary, always accessible */}
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
          title={lang === 'es' ? 'Reportar problema' : 'Report issue'}
        >
          <AlertTriangle size={17} color="#6B7280" />
        </button>
      </div>

      {/* Existing issue note display */}
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
        /* Done state */
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
      ) : (
        /* Mark Clean button — intentionally large for wet/gloved hands */
        <MarkCleanButton
          lang={lang}
          isSaving={isSaving}
          onPress={onMarkClean}
        />
      )}
    </div>
  );
}

/* ── Mark Clean Button ── Separated for press animation state */
function MarkCleanButton({
  lang,
  isSaving,
  onPress,
}: {
  lang: Language;
  isSaving: boolean;
  onPress: () => void;
}) {
  const [pressed, setPressed] = useState(false);

  return (
    <button
      onClick={onPress}
      disabled={isSaving}
      onPointerDown={() => !isSaving && setPressed(true)}
      onPointerUp={() => setPressed(false)}
      onPointerLeave={() => setPressed(false)}
      style={{
        width: '100%', height: '68px', border: 'none', borderRadius: '14px',
        background: isSaving ? '#D1D5DB' : pressed ? '#15803D' : '#16A34A',
        color: isSaving ? '#9CA3AF' : 'white',
        fontSize: '20px', fontWeight: 800,
        cursor: isSaving ? 'not-allowed' : 'pointer',
        letterSpacing: '-0.01em',
        transform: pressed && !isSaving ? 'scale(0.97)' : 'scale(1)',
        transition: 'background 100ms ease, transform 80ms ease',
        WebkitTapHighlightColor: 'transparent',
        // Raised shadow when not pressed
        boxShadow: pressed || isSaving ? 'none' : '0 4px 12px rgba(22,101,52,0.35)',
      }}
    >
      {isSaving
        ? (lang === 'es' ? 'Guardando…' : 'Saving…')
        : (lang === 'es' ? 'Marcar Limpia ✓' : 'Mark Clean ✓')}
    </button>
  );
}
