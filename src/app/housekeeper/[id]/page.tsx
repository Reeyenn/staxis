'use client';

import React, { useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import {
  subscribeToRoomsForStaff,
  updateRoom,
  getStaffMember,
  saveStaffLanguage,
} from '@/lib/db';
import { todayStr } from '@/lib/utils';
import type { Room, RoomStatus } from '@/types';
import { format } from 'date-fns';
import { es as esLocale } from 'date-fns/locale';
import { CheckCircle, AlertTriangle } from 'lucide-react';
import { t } from '@/lib/translations';
import type { Language } from '@/lib/translations';

// Rooms come off Supabase via `subscribeToRoomsForStaff` fully shaped as our
// canonical Room type — no Firestore DocumentReference to carry around.
// Per-room mutations all go through `updateRoom(_, _, room.id, patch)`.
type RoomRow = Room;

const PRIORITY_SCORE: Record<string, number> = { vip: 0, early: 1, standard: 2 };

function sortRooms(rooms: RoomRow[]): RoomRow[] {
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

  // ── Language is LOCAL to this page ──
  // Previously this called the global setLang() from LanguageContext, which
  // writes to localStorage. That meant when Maria (admin) opened any HK's
  // personal link in her browser to test, the whole admin UI flipped to
  // Spanish permanently. We keep a page-scoped lang state here instead and
  // source the initial value from the staff doc (what Maria set in the
  // staff modal) — falling back to the legacy staffPrefs doc for HKs who
  // self-selected via SMS before we wired up the staff-doc write path.
  const [lang, setLang] = useState<Language>('en');

  const [rooms, setRooms] = useState<RoomRow[]>([]);
  const [activeDate, setActiveDate] = useState<string>(today);
  const [loading, setLoading] = useState(true);
  const [savingRoomId, setSavingRoomId] = useState<string | null>(null);
  const [issueRoomId, setIssueRoomId] = useState<string | null>(null);
  const [issueNote, setIssueNote] = useState('');
  const [savingIssue, setSavingIssue] = useState(false);
  const [savingDnd, setSavingDnd] = useState<string | null>(null);
  const [helpSent, setHelpSent] = useState<Set<string>>(new Set());
  const [savingHelp, setSavingHelp] = useState<string | null>(null);
  const [resettingRoomId, setResettingRoomId] = useState<string | null>(null);

  // Seed the page language from the staff row on mount.
  // The staff table has a `language` column that Maria sets via the Staff
  // modal (and that this page writes back to when the HK hits the lang
  // toggle). Legacy `staffPrefs/{id}` doc from the Firestore era is gone.
  useEffect(() => {
    if (!housekeeperId || !pid) return;
    let cancelled = false;

    (async () => {
      try {
        const s = await getStaffMember(pid, housekeeperId);
        if (!cancelled && s && (s.language === 'es' || s.language === 'en')) {
          setLang(s.language);
        }
      } catch (err) {
        console.error('[housekeeper] staff row lang load failed:', err);
      }
    })();

    return () => { cancelled = true; };
  }, [housekeeperId, pid]);

  useEffect(() => {
    if (!housekeeperId || !pid) return;

    // Subscribe to every room assigned to this HK (any date), then pick the
    // right date bucket to display. Previously we always filtered to
    // today — which broke when Maria sent assignments for tomorrow's shift:
    // the rooms existed but the page saw zero matches.
    //
    // Behavior: prefer today's rooms; else nearest upcoming shift; else the
    // most recent past date (so HKs can still see their just-completed shift).
    const unsub = subscribeToRoomsForStaff(pid, housekeeperId, (all) => {
      const byDate = new Map<string, RoomRow[]>();
      for (const r of all) {
        if (!r.date) continue;
        const list = byDate.get(r.date) ?? [];
        list.push(r);
        byDate.set(r.date, list);
      }

      let chosenDate = today;
      if (byDate.has(today)) {
        chosenDate = today;
      } else {
        const future = [...byDate.keys()].filter(d => d > today).sort();
        if (future.length > 0) {
          chosenDate = future[0];
        } else {
          const past = [...byDate.keys()].filter(d => d < today).sort().reverse();
          if (past.length > 0) chosenDate = past[0];
        }
      }

      setActiveDate(chosenDate);
      setRooms(sortRooms(byDate.get(chosenDate) ?? []));
      setLoading(false);
    });

    return () => { unsub(); };
  }, [housekeeperId, pid, today]);

  // ── Start room (dirty → in_progress) ──────────────────────────────────────
  const handleStartRoom = async (room: RoomRow) => {
    if (!uid || !pid) return;
    setSavingRoomId(room.id);
    try {
      await updateRoom(uid, pid, room.id, {
        status: 'in_progress' as RoomStatus,
        startedAt: new Date(),
      });
    } catch (err) {
      console.error('[housekeeper] start room error:', err);
    } finally {
      setSavingRoomId(null);
    }
  };

  // ── Stop room (in_progress → dirty, clear startedAt) ──────────────────────
  const handleStopRoom = async (room: RoomRow) => {
    if (!uid || !pid) return;
    setSavingRoomId(room.id);
    try {
      await updateRoom(uid, pid, room.id, {
        status: 'dirty' as RoomStatus,
        startedAt: null,
      });
    } catch (err) {
      console.error('[housekeeper] stop room error:', err);
    } finally {
      setSavingRoomId(null);
    }
  };

  // ── Finish room (in_progress → clean) ─────────────────────────────────────
  // Requires hold-to-confirm on the button - accidental taps are ignored.
  const handleFinishRoom = async (room: RoomRow) => {
    if (!uid || !pid) return;
    setSavingRoomId(room.id);
    try {
      const updates: Partial<Room> = {
        status: 'clean' as RoomStatus,
        completedAt: new Date(),
      };
      // Safety net: write startedAt if somehow missing
      if (!room.startedAt) {
        updates.startedAt = new Date();
      }
      await updateRoom(uid, pid, room.id, updates);
    } catch (err) {
      console.error('[housekeeper] finish room error:', err);
    } finally {
      setSavingRoomId(null);
    }
  };

  // ── Toggle DND on a room ────────────────────────────────────────────────────
  const handleToggleDnd = async (room: RoomRow) => {
    if (!uid || !pid) return;
    setSavingDnd(room.id);
    try {
      const newDnd = !room.isDnd;
      await updateRoom(uid, pid, room.id, {
        isDnd: newDnd,
        dndNote: newDnd
          ? `Marked DND by housekeeper at ${new Date().toLocaleTimeString()}`
          : '',
      });
    } catch (err) {
      console.error('[housekeeper] toggle DND error:', err);
    } finally {
      setSavingDnd(null);
    }
  };

  // ── Need Help - alert Maria ───────────────────────────────────────────────
  const handleNeedHelp = async (room: RoomRow) => {
    if (helpSent.has(room.id)) return; // already sent for this room
    if (!uid || !pid) return;
    setSavingHelp(room.id);
    try {
      // helpRequestedAt / helpRequestedBy are legacy Firestore-only fields
      // that the Postgres schema doesn't carry — the SMS alert below is
      // the authoritative notification channel, so we only flip the
      // `helpRequested` flag here for the UI state.
      await updateRoom(uid, pid, room.id, {
        helpRequested: true,
      });
      setHelpSent(prev => new Set(prev).add(room.id));

      // Send SMS to the property's Scheduling Manager only.
      // /api/help-request looks up the single staff member with
      // isSchedulingManager=true and texts them — no broadcasts, no
      // front desk fallback. Best-effort, don't block on failure.
      //
      // Pass staffId (housekeeperId from the URL) so the API route can
      // confirm the request originates from a real staff member of this
      // property — not just anyone who happens to know the pid.
      if (uid && pid) {
        fetch('/api/help-request', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            uid,
            pid,
            staffId: housekeeperId,
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
    if (!uid || !pid) return;
    setSavingIssue(true);
    const room = rooms.find(r => r.id === issueRoomId);
    if (!room) {
      console.error('[housekeeper] submit issue: room not found', issueRoomId);
      setSavingIssue(false);
      return;
    }
    try {
      await updateRoom(uid, pid, room.id, { issueNote: issueNote.trim() });
      setIssueRoomId(null);
      setIssueNote('');
    } catch (err) {
      console.error('[housekeeper] submit issue error:', err);
    } finally {
      setSavingIssue(false);
    }
  };

  // ── Reset room (clean/inspected → dirty, clear times) ─────────────────────
  const handleResetRoom = async (room: RoomRow) => {
    if (!uid || !pid) return;
    setResettingRoomId(room.id);
    try {
      await updateRoom(uid, pid, room.id, {
        status: 'dirty' as RoomStatus,
        startedAt: null,
        completedAt: null,
      });
    } catch (err) {
      console.error('[housekeeper] reset room error:', err);
    } finally {
      setResettingRoomId(null);
    }
  };

  // ── Derived state ──────────────────────────────────────────────────────────
  const housekeeperName = rooms[0]?.assignedName ?? '';
  const firstName = housekeeperName.split(' ')[0] || 'Housekeeper';
  const total = rooms.length;
  const done = rooms.filter(r => r.status === 'clean' || r.status === 'inspected' || r.isDnd).length;
  const inProgress = rooms.filter(r => r.status === 'in_progress').length;
  const dndCount = rooms.filter(r => r.isDnd && r.status !== 'clean' && r.status !== 'inspected').length;
  const allDone = total > 0 && done === total;
  const progressPct = total > 0 ? Math.round((done / total) * 100) : 0;

  // Missing pid means the SMS/shared link was mangled or hand-typed without
  // the ?pid=... query string. Without this guard the useEffect above returns
  // early, never calls setLoading(false), and the spinner runs forever —
  // which on a housekeeper's phone reads as "the app is broken." Render a
  // concrete error instead so they can flag it to Maria.
  if (!pid || !housekeeperId) {
    return (
      <div style={{
        minHeight: '100dvh', display: 'flex', alignItems: 'center', justifyContent: 'center',
        flexDirection: 'column', gap: '12px', padding: '24px',
        background: 'var(--bg)', fontFamily: 'var(--font-sans, system-ui, -apple-system, sans-serif)',
        textAlign: 'center',
      }}>
        <AlertTriangle size={32} color="var(--red, #EF4444)" />
        <p style={{ fontSize: '16px', fontWeight: 600, color: 'var(--text-primary)', margin: 0 }}>
          {lang === 'es' ? 'Enlace incompleto' : 'Incomplete link'}
        </p>
        <p style={{ fontSize: '14px', color: 'var(--text-muted)', maxWidth: '320px', margin: 0 }}>
          {lang === 'es'
            ? 'Pídele a tu encargada el enlace completo. Falta el identificador de la propiedad.'
            : 'Ask your manager for the full link. The property ID is missing.'}
        </p>
      </div>
    );
  }

  if (loading) {
    return (
      <div style={{
        minHeight: '100dvh', display: 'flex', alignItems: 'center', justifyContent: 'center',
        flexDirection: 'column', gap: '12px',
        background: 'var(--bg)', fontFamily: 'var(--font-sans, system-ui, -apple-system, sans-serif)',
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
    <div style={{
      maxWidth: '768px',
      margin: '0 auto',
      minHeight: '100dvh',
      background: 'var(--green-bg, #F0FDF4)',
    }}>

      {/* ── Header ── */}
      <div style={{ background: 'linear-gradient(135deg, var(--navy, #0F172A) 0%, var(--navy-light, #2563EB) 100%)', padding: '20px 16px 28px', color: 'white' }}>
        <p style={{
          fontSize: '11px', fontWeight: 600, letterSpacing: '0.08em',
          textTransform: 'uppercase', opacity: 0.55, marginBottom: '6px',
        }}>
          Staxis
        </p>

        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '12px' }}>
          <div>
            <h1 style={{ fontSize: '20px', fontWeight: 800, letterSpacing: '-0.02em', marginBottom: '2px', lineHeight: 1.1 }}>
              {lang === 'es' ? `Hola, ${firstName}` : `Hi, ${firstName}`}
            </h1>
            <p style={{ fontSize: '12px', opacity: 0.7, fontWeight: 500 }}>
              {(() => {
                // Parse activeDate as local-time midnight (avoids the UTC-shift
                // "Saturday Apr 18" getting rendered as "Friday Apr 17" on clients
                // west of UTC).
                const [y, m, d] = activeDate.split('-').map(Number);
                const dateObj = new Date(y, (m ?? 1) - 1, d ?? 1);
                const formatted = format(dateObj, 'EEEE, MMMM d', { locale: lang === 'es' ? esLocale : undefined });
                if (activeDate === today) return formatted;
                // Different date — add a label so HK knows they're looking at a
                // future (or past) shift.
                return activeDate > today
                  ? `${lang === 'es' ? 'Próximo turno: ' : 'Next shift: '}${formatted}`
                  : `${lang === 'es' ? 'Turno anterior: ' : 'Last shift: '}${formatted}`;
              })()}
            </p>
          </div>

          <button
            onClick={async () => {
              const next: Language = lang === 'en' ? 'es' : 'en';
              setLang(next);
              // Persist to the staff row so Maria's staff modal stays in
              // sync with whatever this HK picked. Best-effort; silent on
              // failure since the UI already updated locally.
              if (housekeeperId) {
                try {
                  await saveStaffLanguage(housekeeperId, next);
                } catch (err) {
                  console.error('[housekeeper] lang persist failed:', err);
                }
              }
            }}
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
                  ? `${done} de ${total} listas${dndCount > 0 ? ` · ${dndCount} DND` : ''}${inProgress > 0 ? ` · ${inProgress} en progreso` : ''}`
                  : `${done} of ${total} done${dndCount > 0 ? ` · ${dndCount} DND` : ''}${inProgress > 0 ? ` · ${inProgress} in progress` : ''}`}
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

        {allDone && (
          <div style={{
            textAlign: 'center', padding: '32px 24px', background: 'white',
            borderRadius: '20px', boxShadow: '0 2px 8px rgba(0,0,0,0.06)',
            marginBottom: '4px',
          }}>
            <div style={{
              width: '64px', height: '64px', borderRadius: '50%',
              background: 'var(--green-dim)', display: 'flex', alignItems: 'center',
              justifyContent: 'center', margin: '0 auto 14px',
            }}>
              <CheckCircle size={32} color="var(--green)" />
            </div>
            <h2 style={{ fontSize: '22px', fontWeight: 800, color: 'var(--text-primary)', marginBottom: '6px' }}>
              {t('allDone', lang)}
            </h2>
            <p style={{ fontSize: '14px', color: 'var(--text-secondary)', lineHeight: 1.5 }}>
              {lang === 'es'
                ? `¡Buen trabajo hoy, ${firstName}! 🎉`
                : `Great work today, ${firstName}! 🎉`}
            </p>
          </div>
        )}

        {total === 0 ? (
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
              onStop={() => handleStopRoom(room)}
              onReset={() => handleResetRoom(room)}
              isResetting={resettingRoomId === room.id}
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
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            padding: '16px',
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
            width: '100%', maxWidth: '420px', background: 'white',
            borderRadius: '20px',
            padding: '24px 20px',
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
  onStop,
  onReset,
  isResetting,
  onReportIssue,
  onToggleDnd,
  onNeedHelp,
}: {
  room: RoomRow;
  lang: Language;
  index: number;
  isSaving: boolean;
  isSavingDnd: boolean;
  isSavingHelp: boolean;
  helpAlreadySent: boolean;
  onStart: () => void;
  onFinish: () => void;
  onStop: () => void;
  onReset: () => void;
  isResetting: boolean;
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
    : isInProgress ? 'var(--navy-light, #2563EB)'
    : room.priority === 'vip' ? 'var(--red)'
    : room.priority === 'early' ? 'var(--orange, #EA580C)'
    : 'var(--border)';

  const cardBg = isDone ? 'var(--green-bg, #F0FDF4)' : isInProgress ? 'var(--blue-dim, #EFF6FF)' : 'white';
  const cardBorder = isDone ? 'var(--green-light, #86EFAC)' : isInProgress ? 'var(--blue-light, #93C5FD)' : 'var(--border-light, #E5E7EB)';

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

      {/* DND banner — only show when in-progress, dirty+DND uses the action area instead */}
      {room.isDnd && isInProgress && (
        <div style={{
          background: 'var(--gray-dim, #F3F4F6)', color: 'var(--text-secondary, #4B5563)',
          padding: '10px 14px', borderRadius: '10px',
          fontSize: '14px', fontWeight: 700, marginBottom: '12px',
          border: '1.5px solid var(--border-light, #E5E7EB)',
        }}>
          {lang === 'es' ? '🚫 No Molestar' : '🚫 ' + t('doNotDisturb', lang)}
        </div>
      )}

      {/* Top row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '14px' }}>
        <span style={{
          fontSize: '13px', fontWeight: 700,
          color: isDone ? 'var(--green)' : isInProgress ? 'var(--navy-light, #2563EB)' : 'var(--text-muted)',
          minWidth: '18px', lineHeight: 1, flexShrink: 0,
        }}>
          {index}.
        </span>

        <span style={{
          fontFamily: 'ui-monospace, monospace', fontWeight: 800, fontSize: '34px',
          color: isDone ? 'var(--green)' : isInProgress ? 'var(--navy-light, #2563EB)' : 'var(--text-primary)',
          letterSpacing: '-0.02em', lineHeight: 1,
        }}>
          {room.number}
        </span>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', flex: 1 }}>
          <span style={{
            fontSize: '11px', fontWeight: 700, textTransform: 'uppercase',
            letterSpacing: '0.07em',
            color: isDone ? 'var(--green)' : isInProgress ? 'var(--navy-light, #2563EB)' : 'var(--text-secondary)',
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
            <span style={{ fontSize: '11px', color: 'var(--navy-light, #2563EB)', fontWeight: 600 }}>
              {t('start', lang)}: {format(new Date(room.startedAt), 'h:mm a')}
            </span>
          )}
        </div>

        <div style={{ display: 'flex', gap: '6px', flexShrink: 0 }}>
          {/* DND toggle button — hide when done, when dirty+DND (action area handles it), and when in-progress (can't DND a started room) */}
          {!isDone && !isInProgress && !room.isDnd && (
            <button
              onClick={onToggleDnd}
              disabled={isSavingDnd}
              style={{
                height: '36px',
                padding: '0 10px',
                border: `1.5px solid var(--border-light, #E5E7EB)`,
                borderRadius: '10px',
                background: 'transparent',
                cursor: isSavingDnd ? 'not-allowed' : 'pointer',
                flexShrink: 0,
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '5px',
                opacity: isSavingDnd ? 0.4 : 0.6,
                WebkitTapHighlightColor: 'transparent',
                transition: 'all 150ms ease',
              }}
              aria-label={room.isDnd ? t('removeDnd', lang) : t('markDnd', lang)}
            >
              <span style={{ fontSize: '13px', lineHeight: 1 }}>🚫</span>
              <span style={{
                fontSize: '11px', fontWeight: 700,
                color: 'var(--text-muted)',
                whiteSpace: 'nowrap',
              }}>
                {lang === 'es' ? 'DND' : 'DND'}
              </span>
            </button>
          )}

          {/* Report issue button */}
          <button
            onClick={onReportIssue}
            style={{
              height: '36px',
              padding: '0 10px',
              border: '1.5px solid var(--border-light, #E5E7EB)',
              borderRadius: '10px', background: 'transparent',
              cursor: 'pointer', flexShrink: 0,
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '5px',
              opacity: 0.6,
              WebkitTapHighlightColor: 'transparent',
            }}
            aria-label={lang === 'es' ? 'Reportar problema' : 'Report issue'}
          >
            <AlertTriangle size={14} color="var(--text-muted)" />
            <span style={{
              fontSize: '11px', fontWeight: 700,
              color: 'var(--text-muted)',
              whiteSpace: 'nowrap',
            }}>
              {lang === 'es' ? 'Problema' : 'Issue'}
            </span>
          </button>
        </div>
      </div>

      {/* Issue note */}
      {(room as Room & { issueNote?: string }).issueNote && (
        <div style={{
          display: 'flex', gap: '6px', alignItems: 'flex-start',
          padding: '9px 11px', background: 'var(--red-dim, #FEF2F2)', borderRadius: '10px',
          marginBottom: '12px', border: '1px solid var(--red-light, #FECACA)',
        }}>
          <AlertTriangle size={13} color="var(--red, #DC2626)" style={{ flexShrink: 0, marginTop: '2px' }} />
          <span style={{ fontSize: '13px', color: 'var(--red-dark, #991B1B)', lineHeight: 1.4 }}>
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
              {format(new Date(room.completedAt), 'h:mm a')}
            </span>
          )}
          <span style={{ color: 'var(--green)', opacity: 0.3, fontSize: '14px', margin: '0 2px' }}>·</span>
          <button
            onClick={onReset}
            disabled={isResetting}
            style={{
              background: 'none',
              border: 'none',
              padding: '4px 6px',
              fontSize: '13px',
              fontWeight: 600,
              color: 'var(--green)',
              cursor: isResetting ? 'not-allowed' : 'pointer',
              opacity: isResetting ? 0.4 : 0.55,
              WebkitTapHighlightColor: 'transparent',
              textDecoration: 'underline',
              textUnderlineOffset: '2px',
              transition: 'opacity 150ms ease',
            }}
          >
            {isResetting
              ? '...'
              : (lang === 'es' ? 'Revertir' : 'Reset')}
          </button>
        </div>
      ) : isInProgress ? (
        <div style={{ display: 'flex', gap: '8px' }}>
          <button
            onClick={onStop}
            disabled={isSaving}
            style={{
              width: '68px', height: '68px', flexShrink: 0,
              border: '2px solid var(--border-light, #E5E7EB)',
              borderRadius: '14px',
              background: 'white',
              color: 'var(--text-secondary)',
              fontSize: '13px', fontWeight: 700,
              cursor: isSaving ? 'not-allowed' : 'pointer',
              opacity: isSaving ? 0.4 : 1,
              WebkitTapHighlightColor: 'transparent',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              transition: 'all 150ms ease',
            }}
          >
            {lang === 'es' ? 'Parar' : 'Stop'}
          </button>
          <div style={{ flex: 1 }}>
            <CompleteButton lang={lang} isSaving={isSaving} onFinish={onFinish} />
          </div>
        </div>
      ) : room.isDnd ? (
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '12px',
          height: '68px', borderRadius: '14px',
          background: 'var(--gray-dim, #F3F4F6)',
          border: '2px solid var(--border-light, #E5E7EB)',
        }}>
          <span style={{ fontSize: '20px' }}>🚫</span>
          <span style={{ fontSize: '17px', fontWeight: 700, color: 'var(--text-secondary, #4B5563)' }}>
            {lang === 'es' ? 'No Molestar' : 'Do Not Disturb'}
          </span>
          <span style={{ color: 'var(--border-light, #E5E7EB)', margin: '0 2px' }}>·</span>
          <button
            onClick={onToggleDnd}
            disabled={isSavingDnd}
            style={{
              background: 'none', border: 'none',
              fontSize: '14px', fontWeight: 600,
              color: 'var(--text-secondary, #4B5563)',
              cursor: isSavingDnd ? 'not-allowed' : 'pointer',
              opacity: isSavingDnd ? 0.4 : 0.7,
              textDecoration: 'underline', textUnderlineOffset: '2px',
              WebkitTapHighlightColor: 'transparent',
              padding: '4px 6px',
            }}
          >
            {isSavingDnd ? '...' : (lang === 'es' ? 'Quitar' : 'Undo')}
          </button>
        </div>
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

/* ── Complete Button - simple tap to mark done ── */
function CompleteButton({
  lang,
  isSaving,
  onFinish,
}: {
  lang: Language;
  isSaving: boolean;
  onFinish: () => void;
}) {
  const [pressed, setPressed] = useState(false);

  return (
    <button
      onClick={onFinish}
      disabled={isSaving}
      onPointerDown={() => !isSaving && setPressed(true)}
      onPointerUp={() => setPressed(false)}
      onPointerLeave={() => setPressed(false)}
      style={{
        width: '100%', height: '68px', border: 'none', borderRadius: '14px',
        background: isSaving ? 'var(--border)' : pressed ? 'var(--green-dark, #166534)' : 'var(--green)',
        color: isSaving ? 'var(--text-muted)' : 'white',
        fontSize: '20px', fontWeight: 800,
        cursor: isSaving ? 'not-allowed' : 'pointer',
        letterSpacing: '-0.01em',
        transform: pressed && !isSaving ? 'scale(0.97)' : 'scale(1)',
        transition: 'background 100ms ease, transform 80ms ease',
        WebkitTapHighlightColor: 'transparent',
        boxShadow: pressed || isSaving ? 'none' : '0 4px 12px rgba(22,101,52,0.35)',
      }}
    >
      {isSaving
        ? t('savingDots', lang)
        : (lang === 'es' ? '✓ Completar' : '✓ Complete')}
    </button>
  );
}
