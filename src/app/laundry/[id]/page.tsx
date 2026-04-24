'use client';

import React, { useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { todayStr } from '@/lib/utils';
import {
  getPublicAreas,
  getLaundryConfig,
  subscribeToRooms,
  getStaffMember,
  saveStaffLanguage,
} from '@/lib/db';
import { isAreaDueToday, calcLaundryMinutes } from '@/lib/calculations';
import type { PublicArea, LaundryCategory, Room } from '@/types';
import { format } from 'date-fns';
import { es as esLocale } from 'date-fns/locale';
import { CheckCircle, Globe, AlertTriangle } from 'lucide-react';
import { t } from '@/lib/translations';
import type { Language } from '@/lib/translations';

export default function LaundryPersonPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: laundryPersonId } = React.use(params);
  const searchParams = useSearchParams();
  const uid = searchParams.get('uid');
  const pid = searchParams.get('pid');
  const today = todayStr();

  // ── Language is LOCAL to this page ──
  // See the matching comment block on /housekeeper/[id]. Using the global
  // LanguageContext here was flipping Maria's admin UI to Spanish any time
  // she opened a staff member's personal link.
  const [lang, setLang] = useState<Language>('en');

  const [laundryPersonName, setLaundryPersonName] = useState('');
  const [publicAreas, setPublicAreas] = useState<PublicArea[]>([]);
  const [laundryConfig, setLaundryConfig] = useState<LaundryCategory[]>([]);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [loading, setLoading] = useState(true);
  const [completedAreas, setCompletedAreas] = useState<Set<string>>(new Set());
  const [completedLoads, setCompletedLoads] = useState<Set<string>>(new Set());

  // Seed the page language from the staff row on mount. Source of truth is
  // the `language` column on the staff table (written by Maria in the Staff
  // modal, and by this page when the HK hits the language toggle). Legacy
  // Firestore `staffPrefs/{id}` is gone.
  useEffect(() => {
    if (!laundryPersonId || !pid) return;
    let cancelled = false;

    (async () => {
      try {
        const s = await getStaffMember(pid, laundryPersonId);
        if (!cancelled && s && (s.language === 'es' || s.language === 'en')) {
          setLang(s.language);
        }
      } catch (err) {
        console.error('[laundry] staff row lang load failed:', err);
      }
    })();

    return () => { cancelled = true; };
  }, [laundryPersonId, pid]);

  // Load laundry person name from staff list
  useEffect(() => {
    if (!uid || !pid || !laundryPersonId) return;

    fetch(`/api/staff-list?uid=${uid}&pid=${pid}`)
      .then(r => r.json())
      .then((data: Array<{ id: string; name: string }>) => {
        const person = data.find(s => s.id === laundryPersonId);
        if (person) {
          setLaundryPersonName(person.name);
        }
      })
      .catch(err => console.error('[laundry] staff name load failed:', err));
  }, [uid, pid, laundryPersonId]);

  // Load public areas and laundry config
  useEffect(() => {
    if (!uid || !pid) return;

    Promise.all([
      getPublicAreas(uid, pid),
      getLaundryConfig(uid, pid),
    ])
      .then(([areas, config]) => {
        setPublicAreas(areas);
        setLaundryConfig(config);
        setLoading(false);
      })
      .catch(err => {
        console.error('[laundry] load config error:', err);
        setLoading(false);
      });
  }, [uid, pid]);

  // Subscribe to rooms for today. No auth dance — the Supabase browser client
  // uses the anon key and the capability URL (uid+pid+staffId) is the access
  // token for this page.
  useEffect(() => {
    if (!uid || !pid) return;
    const unsub = subscribeToRooms(uid, pid, today, (data: Room[]) => {
      setRooms(data);
    });
    return () => unsub();
  }, [uid, pid, today]);

  // Calculate today's date for area filtering
  const todayDate = new Date();

  // Filter public areas due today
  const areasDueToday = publicAreas.filter(area => isAreaDueToday(area, todayDate));

  // Count checkouts, stayovers, and two-bed checkouts from rooms
  const checkouts = rooms.filter(r => r.type === 'checkout').length;
  const twoBedCheckouts = Math.floor(checkouts * 0.3); // estimate, adjust as needed
  const oneBedCheckouts = checkouts - twoBedCheckouts;
  const stayovers = rooms.filter(r => r.type === 'stayover').length;

  // Calculate laundry loads
  const { breakdown: laundryBreakdown } = calcLaundryMinutes(
    laundryConfig,
    oneBedCheckouts,
    twoBedCheckouts,
    stayovers
  );

  // Build load cards with unique keys for tracking completion
  const loadCards = laundryBreakdown.map((item, idx) => ({
    id: `${item.category}-${idx}`,
    category: item.category,
    loads: item.loads,
    minutes: item.minutes,
  }));

  // Calculate progress
  const totalTasks = areasDueToday.length + loadCards.length;
  const completedTasks = completedAreas.size + completedLoads.size;
  const progressPct = totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0;
  const allDone = totalTasks > 0 && completedTasks === totalTasks;

  const firstName = laundryPersonName.split(' ')[0] || 'Laundry';

  // Missing uid or pid means a mangled SMS/shared link — useEffects below
  // return early without ever setting loading=false, so without this guard
  // the spinner runs forever on the laundry person's phone. Render a concrete
  // error instead.
  if (!pid || !uid || !laundryPersonId) {
    return (
      <div style={{
        minHeight: '100dvh', display: 'flex', alignItems: 'center', justifyContent: 'center',
        flexDirection: 'column', gap: '12px', padding: '24px',
        background: 'var(--blue-dim, #F0F9FF)', fontFamily: 'system-ui, -apple-system, sans-serif',
        textAlign: 'center',
      }}>
        <AlertTriangle size={32} color="var(--red, #EF4444)" />
        <p style={{ fontSize: '16px', fontWeight: 600, color: 'var(--text-primary)', margin: 0 }}>
          {lang === 'es' ? 'Enlace incompleto' : 'Incomplete link'}
        </p>
        <p style={{ fontSize: '14px', color: 'var(--text-muted)', maxWidth: '320px', margin: 0 }}>
          {lang === 'es'
            ? 'Pídele a tu encargada el enlace completo. Faltan parámetros.'
            : 'Ask your manager for the full link. Parameters are missing.'}
        </p>
      </div>
    );
  }

  if (loading) {
    return (
      <div style={{
        minHeight: '100dvh', display: 'flex', alignItems: 'center', justifyContent: 'center',
        flexDirection: 'column', gap: '12px',
        background: 'var(--blue-dim, #F0F9FF)', fontFamily: 'system-ui, -apple-system, sans-serif',
      }}>
        <div style={{
          width: '32px', height: '32px', border: '4px solid var(--border)',
          borderTopColor: 'var(--navy)', borderRadius: '50%',
          animation: 'spin 0.8s linear infinite',
        }} />
        <p style={{ color: 'var(--text-muted)', fontSize: '14px', fontWeight: 500 }}>
          {lang === 'es' ? 'Cargando tareas...' : 'Loading tasks...'}
        </p>
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      </div>
    );
  }

  return (
    <div style={{
      minHeight: '100dvh', background: 'var(--blue-dim, #F0F9FF)',
      fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, sans-serif',
    }}>

      {/* ── Header ── */}
      <div style={{ background: 'var(--navy)', padding: '20px 16px 28px', color: 'white' }}>
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
              {format(new Date(), 'EEEE, MMMM d', { locale: lang === 'es' ? esLocale : undefined })}
            </p>
          </div>

          <button
            onClick={async () => {
              const next: Language = lang === 'en' ? 'es' : 'en';
              setLang(next);
              if (laundryPersonId) {
                try {
                  await saveStaffLanguage(laundryPersonId, next);
                } catch (err) {
                  console.error('[laundry] lang persist failed:', err);
                }
              }
            }}
            style={{
              background: 'rgba(255,255,255,0.18)',
              border: '1.5px solid rgba(255,255,255,0.35)',
              borderRadius: '12px', color: 'white',
              fontWeight: 700, fontSize: '13px',
              padding: '10px 16px', cursor: 'pointer',
              letterSpacing: '0.03em', flexShrink: 0,
              WebkitTapHighlightColor: 'transparent',
              display: 'flex', alignItems: 'center', gap: '6px',
            }}
          >
            <Globe size={14} />
            {lang === 'en' ? 'Español' : 'English'}
          </button>
        </div>

        {/* Progress bar */}
        {totalTasks > 0 && (
          <div style={{ marginTop: '20px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px' }}>
              <span style={{ fontSize: '14px', fontWeight: 600 }}>
                {lang === 'es'
                  ? `${completedTasks} de ${totalTasks} listas`
                  : `${completedTasks} of ${totalTasks} done`}
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
                background: progressPct === 100 ? 'var(--green)' : 'var(--green-light, #4ADE80)',
                borderRadius: '99px',
                transition: 'width 500ms cubic-bezier(0.4,0,0.2,1)',
              }} />
            </div>
          </div>
        )}
      </div>

      {/* ── Task list ── */}
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
        ) : totalTasks === 0 ? (
          <div style={{
            textAlign: 'center', padding: '64px 24px', background: 'white',
            borderRadius: '20px', boxShadow: '0 2px 8px rgba(0,0,0,0.06)',
          }}>
            <p style={{ fontSize: '16px', color: 'var(--text-muted)', lineHeight: 1.8 }}>
              {lang === 'es'
                ? 'No hay tareas de lavandería hoy. ¡Vuelve más tarde!'
                : 'No laundry tasks today. Check back later!'}
            </p>
          </div>
        ) : (
          <>
            {/* Public Area Tasks */}
            {areasDueToday.length > 0 && (
              <div>
                <h3 style={{
                  fontSize: '16px', fontWeight: 700, color: 'var(--navy)',
                  marginBottom: '12px', marginTop: '8px', paddingLeft: '4px',
                }}>
                  {lang === 'es' ? 'Áreas Públicas' : 'Public Areas'}
                </h3>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                  {areasDueToday.map(area => (
                    <AreaTaskCard
                      key={area.id}
                      area={area}
                      lang={lang}
                      isCompleted={completedAreas.has(area.id)}
                      onToggle={() => {
                        const newSet = new Set(completedAreas);
                        if (newSet.has(area.id)) {
                          newSet.delete(area.id);
                        } else {
                          newSet.add(area.id);
                        }
                        setCompletedAreas(newSet);
                      }}
                    />
                  ))}
                </div>
              </div>
            )}

            {/* Laundry Loads */}
            {loadCards.length > 0 && (
              <div>
                <h3 style={{
                  fontSize: '16px', fontWeight: 700, color: 'var(--navy)',
                  marginBottom: '12px', marginTop: areasDueToday.length > 0 ? '16px' : '8px', paddingLeft: '4px',
                }}>
                  {lang === 'es' ? 'Cargas de Lavandería' : 'Laundry Loads'}
                </h3>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                  {loadCards.map(load => (
                    <LaundryLoadCard
                      key={load.id}
                      load={load}
                      lang={lang}
                      isCompleted={completedLoads.has(load.id)}
                      onToggle={() => {
                        const newSet = new Set(completedLoads);
                        if (newSet.has(load.id)) {
                          newSet.delete(load.id);
                        } else {
                          newSet.add(load.id);
                        }
                        setCompletedLoads(newSet);
                      }}
                    />
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────────
   AreaTaskCard - Public area task
   ───────────────────────────────────────────────────────────────────────────── */
function AreaTaskCard({
  area,
  lang,
  isCompleted,
  onToggle,
}: {
  area: PublicArea;
  lang: Language;
  isCompleted: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      onClick={onToggle}
      style={{
        width: '100%', textAlign: 'left',
        background: isCompleted ? 'var(--green-dim)' : 'white',
        border: `2px solid ${isCompleted ? 'var(--green-light, #86EFAC)' : 'var(--border)'}`,
        borderLeft: `6px solid ${isCompleted ? 'var(--green)' : 'var(--navy)'}`,
        borderRadius: '16px',
        padding: '16px',
        transition: 'background 300ms ease, border-color 300ms ease',
        boxShadow: isCompleted ? 'none' : '0 1px 6px rgba(0,0,0,0.07)',
        cursor: 'pointer',
        WebkitTapHighlightColor: 'transparent',
      }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
        <div style={{
          width: '20px', height: '20px', borderRadius: '4px',
          border: `2px solid ${isCompleted ? 'var(--green)' : 'var(--border)'}`,
          background: isCompleted ? 'var(--green)' : 'transparent',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          flexShrink: 0,
        }}>
          {isCompleted && <CheckCircle size={14} color="white" />}
        </div>
        <div style={{ flex: 1 }}>
          <p style={{
            fontSize: '16px', fontWeight: 700,
            color: isCompleted ? 'var(--green)' : 'var(--text-primary)',
            marginBottom: '4px',
          }}>
            {area.name}
          </p>
          <p style={{
            fontSize: '13px', color: isCompleted ? 'var(--text-muted)' : 'var(--text-muted)',
          }}>
            {lang === 'es' ? 'Piso' : 'Floor'} {area.floor} • {area.minutesPerClean} {lang === 'es' ? 'min' : 'min'}
          </p>
        </div>
      </div>
    </button>
  );
}

/* ─────────────────────────────────────────────────────────────────────────────
   LaundryLoadCard - Laundry category task
   ───────────────────────────────────────────────────────────────────────────── */
function LaundryLoadCard({
  load,
  lang,
  isCompleted,
  onToggle,
}: {
  load: { id: string; category: string; loads: number; minutes: number };
  lang: Language;
  isCompleted: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      onClick={onToggle}
      style={{
        width: '100%', textAlign: 'left',
        background: isCompleted ? 'var(--green-dim)' : 'white',
        border: `2px solid ${isCompleted ? 'var(--green-light, #86EFAC)' : 'var(--border)'}`,
        borderLeft: `6px solid ${isCompleted ? 'var(--green)' : 'var(--navy)'}`,
        borderRadius: '16px',
        padding: '16px',
        transition: 'background 300ms ease, border-color 300ms ease',
        boxShadow: isCompleted ? 'none' : '0 1px 6px rgba(0,0,0,0.07)',
        cursor: 'pointer',
        WebkitTapHighlightColor: 'transparent',
      }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
        <div style={{
          width: '20px', height: '20px', borderRadius: '4px',
          border: `2px solid ${isCompleted ? 'var(--green)' : 'var(--border)'}`,
          background: isCompleted ? 'var(--green)' : 'transparent',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          flexShrink: 0,
        }}>
          {isCompleted && <CheckCircle size={14} color="white" />}
        </div>
        <div style={{ flex: 1 }}>
          <p style={{
            fontSize: '16px', fontWeight: 700,
            color: isCompleted ? 'var(--green)' : 'var(--text-primary)',
            marginBottom: '4px',
          }}>
            {load.category}
          </p>
          <p style={{
            fontSize: '13px', color: isCompleted ? 'var(--text-muted)' : 'var(--text-muted)',
          }}>
            {load.loads} {lang === 'es' ? 'cargas' : 'loads'} • {load.minutes} {lang === 'es' ? 'min' : 'min'}
          </p>
        </div>
      </div>
    </button>
  );
}
