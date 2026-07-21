'use client';


export const dynamic = 'force-dynamic';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useTodayStr } from '@/lib/use-today-str';
import { withStaffLinkToken, withStaffLinkTokenBody } from '@/lib/staff-link-client';
import {
  getStaffSelfPublic,
  saveStaffLanguagePublic,
} from '@/lib/db';
import { isAreaDueToday, calcLaundryMinutes } from '@/lib/calculations';
import type { PublicArea, LaundryCategory, Room } from '@/types';
import { format } from 'date-fns';
import { es as esLocale } from 'date-fns/locale';
import { CheckCircle, AlertTriangle } from 'lucide-react';
import { t, SUPPORTED_LOCALES } from '@/lib/translations';
import type { HousekeeperLocale } from '@/lib/translations';
import { LanguageSwitcher } from '@/components/i18n/LanguageSwitcher';

type CompletionSnapshot = {
  pid: string;
  staffId: string;
  date: string;
  areas: string[];
  loads: string[];
};

// Shared full-screen state wrapper (missing-link / loading / error). Each state
// spreads this and overrides only gap/padding/textAlign, so the rendered inline
// style stays byte-for-byte what it was when written out three times.
const SCREEN_WRAP: React.CSSProperties = {
  minHeight: '100dvh', display: 'flex', alignItems: 'center', justifyContent: 'center',
  flexDirection: 'column',
  background: 'var(--blue-dim, #F0F9FF)', fontFamily: 'system-ui, -apple-system, sans-serif',
};

// Toggle a string in a Set immutably (add if absent, remove if present).
function toggleInSet(set: Set<string>, key: string): Set<string> {
  const next = new Set(set);
  if (next.has(key)) next.delete(key); else next.add(key);
  return next;
}

export default function LaundryPersonPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: laundryPersonId } = React.use(params);
  const searchParams = useSearchParams();
  const pid = searchParams.get('pid');
  // Reactive — flips at midnight Central so the rooms subscription rolls
  // over to the new day's bucket. The staffer's iPad sometimes stays on
  // this page from one shift into the next.
  const today = useTodayStr();

  // ── Language is LOCAL to this page ──
  // See the matching comment block on /housekeeper/[id]. Using the global
  // LanguageContext here was flipping Maria's admin UI to Spanish any time
  // she opened a staff member's personal link.
  const [lang, setLang] = useState<HousekeeperLocale>('en');

  const [laundryPersonName, setLaundryPersonName] = useState('');
  const [publicAreas, setPublicAreas] = useState<PublicArea[]>([]);
  const [laundryConfig, setLaundryConfig] = useState<LaundryCategory[]>([]);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [loading, setLoading] = useState(true);
  const [completedAreas, setCompletedAreas] = useState<Set<string>>(new Set());
  // feat/cua-partial-promotion — checkout/stayover load counts derive from
  // PMS reservations + room statuses; while those feeds are still being
  // learned a zero count is NOT "no laundry today". One honest pill.
  const [pmsLearning, setPmsLearning] = useState(false);
  // Completed laundry-load CATEGORY names (not card index) — matches the
  // persistence keying so a checkmark survives the displayed load count
  // shifting through the day as the CUA updates checkout/stayover rooms.
  const [completedLoads, setCompletedLoads] = useState<Set<string>>(new Set());
  const [error, setError] = useState(false);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'error'>('idle');
  // Seed saved completion only on first load / date roll, never on the 60s
  // poll — otherwise a poll landing between a local toggle and its save would
  // clobber the worker's just-tapped checkmark with stale server state.
  const seededRef = useRef(false);
  // Checklist writes are serialized and coalesced. A worker can tap several
  // rows quickly, but only one request is ever in flight; after it finishes we
  // persist the newest queued snapshot. `keepalive` lets an already-started
  // write finish when the worker follows another link or closes the tab.
  const queuedSaveRef = useRef<CompletionSnapshot | null>(null);
  const saveInFlightRef = useRef(false);
  const mountedRef = useRef(true);

  // Seed BOTH the page language and this worker's name from the staff row on
  // mount. These used to be two effects firing one identical getStaffSelfPublic
  // round-trip each; folded into a single fetch. Goes through
  // /api/housekeeper/me (service-role) instead of getStaffMember(), because
  // this page has no auth session and the supabase browser client would
  // silently return null under RLS. Same RLS-blocks-anon trap as the
  // 2026-04-30 housekeeper rooms bug.
  //
  // Security audit 2026-06-26 #1: the roster endpoint /api/staff-list is
  // retired (it leaked every staff UUID) — this reads just THIS worker's own
  // row, gated by the per-staff link token (getStaffSelfPublic forwards it).
  useEffect(() => {
    if (!laundryPersonId || !pid) return;
    let cancelled = false;

    void (async () => {
      try {
        const s = await getStaffSelfPublic(pid, laundryPersonId);
        if (cancelled || !s) return;
        // Full housekeeper locale set (en/es/ht/tl/vi) — the /api/housekeeper/me
        // read now round-trips ht/tl/vi instead of collapsing them to English.
        if (s.language && (SUPPORTED_LOCALES as readonly string[]).includes(s.language)) {
          setLang(s.language);
        }
        if (s.name) setLaundryPersonName(s.name);
      } catch (err) {
        console.error('[laundry] staff row load failed:', err);
      }
    })();

    return () => { cancelled = true; };
  }, [laundryPersonId, pid]);

  // Bootstrap fetch — public_areas + laundry_config + today's rooms in
  // one server-side round-trip. Goes through /api/laundry/bootstrap
  // (service-role, RLS-bypass) because the laundry worker has no Staxis
  // session and the supabase browser client would silently return [] for
  // each table under RLS. Same root cause as the housekeeper "no rooms"
  // bug from earlier today.
  //
  // Polled every 30s instead of using realtime — anon clients don't get
  // postgres_changes events under RLS anyway, and the laundry workflow is
  // not as latency-sensitive as the per-room housekeeper actions.
  // Bootstrap fetch — public_areas + laundry_config + today's rooms + saved
  // checklist progress in one server-side round-trip. Goes through
  // /api/laundry/bootstrap (service-role, RLS-bypass): the laundry worker has
  // no Staxis session, so the browser client would return [] under RLS.
  const loadBootstrap = useCallback(async () => {
    if (!pid || !laundryPersonId) return;
    try {
      const res = await fetch(
        withStaffLinkToken(`/api/laundry/bootstrap?pid=${encodeURIComponent(pid)}&staffId=${encodeURIComponent(laundryPersonId)}&date=${encodeURIComponent(today)}`),
      );
      if (!res.ok) {
        console.error('[laundry] bootstrap http', res.status);
        setError(true);
        setLoading(false);
        return;
      }
      const json = (await res.json().catch(() => null)) as
        | { ok?: boolean; data?: { publicAreas?: PublicArea[]; laundryConfig?: LaundryCategory[]; rooms?: Room[]; completedAreaIds?: string[]; completedLoadCategories?: string[] }; feedStatus?: { mode?: string; connection?: string; feeds?: Record<string, string> }; error?: string }
        | null;
      if (!json?.ok || !json.data) {
        console.error('[laundry] bootstrap unexpected body', json?.error || 'no data');
        setError(true);
        setLoading(false);
        return;
      }
      // Top-level sibling (absent on older servers → render as today).
      // 'pending' = never synced (counts are fake); 'paused' = stale-but-
      // real data, no pill. Else-clear so the pill doesn't latch if the
      // property's state changes (review pass, senior #10).
      const fs = json.feedStatus;
      if (fs && fs.feeds) {
        setPmsLearning(
          fs.mode === 'live' && (
            fs.connection === 'pending' ||
            fs.feeds.arrivals === 'learning' ||
            fs.feeds.departures === 'learning' ||
            fs.feeds.roomStatus === 'learning'
          ),
        );
      }
      setPublicAreas(json.data.publicAreas || []);
      setLaundryConfig(json.data.laundryConfig || []);
      setRooms(json.data.rooms || []);
      // Seed completion once (first load / date roll); routine 60s polls leave
      // the worker's in-progress checkmarks alone (see seededRef note above).
      if (!seededRef.current) {
        setCompletedAreas(new Set(json.data.completedAreaIds || []));
        setCompletedLoads(new Set(json.data.completedLoadCategories || []));
        seededRef.current = true;
      }
      setError(false);
      setLoading(false);
    } catch (err) {
      console.error('[laundry] bootstrap error:', err);
      setError(true);
      setLoading(false);
    }
  }, [pid, laundryPersonId, today]);

  const drainCompletionSaves = useCallback(async () => {
    if (saveInFlightRef.current || !queuedSaveRef.current) return;
    saveInFlightRef.current = true;

    while (queuedSaveRef.current) {
      const snapshot = queuedSaveRef.current;
      queuedSaveRef.current = null;
      if (mountedRef.current) setSaveStatus('saving');

      try {
        const res = await fetch('/api/laundry/complete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          keepalive: true,
          body: JSON.stringify(withStaffLinkTokenBody({
            pid: snapshot.pid,
            staffId: snapshot.staffId,
            date: snapshot.date,
            completedAreaIds: snapshot.areas,
            completedLoadCategories: snapshot.loads,
          })),
        });
        const body = await res.json().catch(() => null) as { ok?: boolean; error?: string } | null;
        if (!res.ok || !body?.ok) {
          throw new Error(body?.error || `save responded ${res.status}`);
        }
      } catch (err) {
        // Keep the newest unsaved snapshot available for the visible Retry
        // action. If another tap arrived while this request was in flight, that
        // newer snapshot wins; otherwise retry exactly the failed snapshot.
        if (!queuedSaveRef.current) queuedSaveRef.current = snapshot;
        console.error('[laundry] save failed:', err);
        if (mountedRef.current) setSaveStatus('error');
        break;
      }
    }

    saveInFlightRef.current = false;
    if (mountedRef.current && !queuedSaveRef.current) setSaveStatus('idle');
  }, []);

  // Persist immediately (rather than after a timer) so a tap starts a durable
  // keepalive request before the worker can navigate away. Rapid taps are
  // coalesced by `drainCompletionSaves` without out-of-order server writes.
  const persistCompletion = useCallback((areas: Set<string>, loads: Set<string>) => {
    if (!pid || !laundryPersonId) return;
    queuedSaveRef.current = {
      pid,
      staffId: laundryPersonId,
      date: today,
      areas: Array.from(areas),
      loads: Array.from(loads),
    };
    void drainCompletionSaves();
  }, [pid, laundryPersonId, today, drainCompletionSaves]);

  useEffect(() => {
    // Re-seed completion on (re)mount or the midnight date roll, then poll the
    // task data every 60s (cost-hotpaths audit #2 — the bootstrap read is
    // heavy and not latency-sensitive).
    seededRef.current = false;
    void loadBootstrap();
    // Pause the poll while the tab/screen is hidden so a worker who leaves the
    // page open (iPad on a shelf between shifts) doesn't burn data/battery on a
    // screen they're not looking at. Mirrors the housekeeper poll's visibility
    // skip (src/lib/db/housekeeper-helpers.ts).
    const interval = setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      void loadBootstrap();
    }, 60_000);
    return () => clearInterval(interval);
  }, [loadBootstrap]);

  // Refresh immediately when the worker returns to the tab — the poll may have
  // skipped several cycles while hidden, so the visible data could be stale.
  // Separate effect + direct loadBootstrap() (never resets seededRef, so it
  // can't clobber in-progress checkmarks; loadBootstrap leaves the seeded sets
  // alone once seededRef.current is true).
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const onVisible = () => {
      if (document.visibilityState === 'visible') void loadBootstrap();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [loadBootstrap]);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  // Calculate today's date for area filtering
  const todayDate = new Date();

  // Filter public areas due today
  const areasDueToday = publicAreas.filter(area => isAreaDueToday(area, todayDate));

  // Count checkouts and stayovers from real PMS room data. We do NOT split
  // checkouts into one-bed / two-bed: the PMS feeds carry no per-room bed count,
  // so the old `Math.floor(checkouts * 0.3)` was a fabricated guess presented to
  // the worker as fact. Treat every checkout as one-bed — an honest floor from
  // real counts, never an invented multiplier. (Two-bed weighting would need a
  // real bed-count source before it could be shown as real.)
  const checkouts = rooms.filter(r => r.type === 'checkout').length;
  const twoBedCheckouts = 0;
  const oneBedCheckouts = checkouts;
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

  // Missing pid means the SMS link was mangled. Without this guard the
  // useEffects above return early, never set loading=false, and the spinner
  // runs forever. Render a concrete error so the worker can flag it.
  if (!pid || !laundryPersonId) {
    return (
      <div style={{ ...SCREEN_WRAP, gap: '12px', padding: '24px', textAlign: 'center' }}>
        <AlertTriangle size={32} color="var(--red, #EF4444)" />
        <p style={{ fontSize: '16px', fontWeight: 600, color: 'var(--text-primary)', margin: 0 }}>
          {t('cxIncompleteLink', lang)}
        </p>
        <p style={{ fontSize: '14px', color: 'var(--text-muted)', maxWidth: '320px', margin: 0 }}>
          {t('cxIncompleteLinkHelp', lang)}
        </p>
      </div>
    );
  }

  if (loading) {
    return (
      <div style={{ ...SCREEN_WRAP, gap: '12px' }}>
        <div style={{
          width: '32px', height: '32px', border: '4px solid var(--border)',
          borderTopColor: 'var(--navy)', borderRadius: '50%',
          animation: 'spin 0.8s linear infinite',
        }} />
        <p style={{ color: 'var(--text-muted)', fontSize: '14px', fontWeight: 500 }}>
          {t('lndLoadingTasks', lang)}
        </p>
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      </div>
    );
  }

  // Bootstrap failed (HTTP error / bad body / network). Show a real error +
  // retry instead of silently falling through to the "No tasks today" empty
  // state — a worker on a flaky shared phone must not mistake a load failure
  // for a genuinely empty day.
  if (error) {
    return (
      <div style={{ ...SCREEN_WRAP, gap: '14px', padding: '24px', textAlign: 'center' }}>
        <AlertTriangle size={32} color="var(--red, #EF4444)" />
        <p style={{ fontSize: '16px', fontWeight: 600, color: 'var(--text-primary)', margin: 0 }}>
          {t('somethingWentWrong', lang)}
        </p>
        <button
          onClick={() => { setError(false); setLoading(true); void loadBootstrap(); }}
          style={{
            marginTop: '4px', background: 'var(--navy)', color: 'white', border: 'none',
            borderRadius: '12px', fontWeight: 700, fontSize: '15px', padding: '12px 24px',
            cursor: 'pointer', WebkitTapHighlightColor: 'transparent', minHeight: '44px',
          }}
        >
          {t('tryAgain', lang)}
        </button>
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
              {`${t('cxHelloPrefix', lang)}, ${firstName}`}
            </h1>
            <p style={{ fontSize: '12px', opacity: 0.7, fontWeight: 500 }}>
              {format(new Date(), 'EEEE, MMMM d', { locale: lang === 'es' ? esLocale : undefined })}
            </p>
          </div>

          <LanguageSwitcher
            current={lang}
            onChange={async (next) => {
              setLang(next);
              if (laundryPersonId && pid) {
                // Service-role write — same reasoning as the housekeeper
                // page's switch from saveStaffLanguage to the *Public
                // variant. The browser-client write silently no-op'd
                // under RLS for unauthenticated laundry workers.
                try {
                  await saveStaffLanguagePublic(pid, laundryPersonId, next);
                } catch (err) {
                  console.error('[laundry] lang persist failed:', err);
                }
              }
            }}
          />
        </div>

        {/* Progress bar */}
        {totalTasks > 0 && (
          <div style={{ marginTop: '20px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px' }}>
              <span style={{ fontSize: '14px', fontWeight: 600 }}>
                {`${completedTasks} ${t('lndProgressOf', lang)} ${totalTasks} ${t('lndProgressDone', lang)}`}
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

        {/* feat/cua-partial-promotion — load counts below may be incomplete
            while the PMS feeds are learning; never let 0 read as "done". */}
        {pmsLearning && (
          <div
            role="status"
            style={{
              padding: '10px 14px',
              background: 'rgba(201, 150, 68, 0.12)',
              border: '1px solid rgba(201, 150, 68, 0.30)',
              color: '#8C6A33',
              borderRadius: 10,
              fontSize: 13,
              lineHeight: 1.45,
            }}
          >
            {t('lndSyncingBanner', lang)}
          </div>
        )}

        {saveStatus === 'saving' && (
          <div
            role="status"
            aria-live="polite"
            style={{
              minHeight: 44, padding: '10px 14px', display: 'flex', alignItems: 'center',
              background: 'rgba(255,255,255,0.82)', border: '1px solid var(--border)',
              color: 'var(--text-muted)', borderRadius: 10, fontSize: 13, fontWeight: 600,
            }}
          >
            {t('savingDots', lang)}
          </div>
        )}

        {saveStatus === 'error' && (
          <div
            role="alert"
            style={{
              padding: '12px 14px', display: 'flex', alignItems: 'center',
              justifyContent: 'space-between', gap: 12, background: 'rgba(239,68,68,0.08)',
              border: '1px solid rgba(239,68,68,0.28)', color: 'var(--red, #B42318)',
              borderRadius: 10, fontSize: 13, lineHeight: 1.4,
            }}
          >
            <span>{t('hkOfflineQueueFailed', lang)}</span>
            <button
              type="button"
              onClick={() => void drainCompletionSaves()}
              style={{
                minWidth: 88, minHeight: 44, padding: '0 14px', flexShrink: 0,
                borderRadius: 10, border: '1px solid currentColor', background: 'white',
                color: 'inherit', fontWeight: 700, cursor: 'pointer',
              }}
            >
              {t('tryAgain', lang)}
            </button>
          </div>
        )}

        {/* Review pass (Codex #7): while PMS feeds are learning, the load
            list may be missing entire categories — a celebratory "All
            done!" or "No tasks today" off that data is a confident wrong
            claim. The pill above stays; the celebration waits. */}
        {allDone && !pmsLearning ? (
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
              {`${t('cxGreatWorkToday', lang)}, ${firstName}! 🎉`}
            </p>
          </div>
        ) : totalTasks === 0 && pmsLearning ? (
          <div style={{
            textAlign: 'center', padding: '48px 24px', background: 'white',
            borderRadius: '20px', boxShadow: '0 2px 8px rgba(0,0,0,0.06)',
            color: 'var(--text-secondary)', fontSize: '15px', lineHeight: 1.5,
          }}>
            {t('lndLoadsAppearWhenSynced', lang)}
          </div>
        ) : totalTasks === 0 ? (
          <div style={{
            textAlign: 'center', padding: '64px 24px', background: 'white',
            borderRadius: '20px', boxShadow: '0 2px 8px rgba(0,0,0,0.06)',
          }}>
            <p style={{ fontSize: '16px', color: 'var(--text-muted)', lineHeight: 1.8 }}>
              {t('lndNoTasksToday', lang)}
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
                  {t('publicAreas', lang)}
                </h3>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                  {areasDueToday.map(area => (
                    <TaskCard
                      key={area.id}
                      title={area.name}
                      subtitle={<>{t('floor', lang)} {area.floor} • {area.minutesPerClean} min</>}
                      isCompleted={completedAreas.has(area.id)}
                      onToggle={() => {
                        const newSet = toggleInSet(completedAreas, area.id);
                        setCompletedAreas(newSet);
                        persistCompletion(newSet, completedLoads);
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
                  {t('lndLaundryLoadsHeading', lang)}
                </h3>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                  {loadCards.map(load => (
                    <TaskCard
                      key={load.id}
                      title={load.category}
                      subtitle={<>{load.loads} {t('lndLoadsUnit', lang)} • {load.minutes} min</>}
                      isCompleted={completedLoads.has(load.category)}
                      onToggle={() => {
                        const newSet = toggleInSet(completedLoads, load.category);
                        setCompletedLoads(newSet);
                        persistCompletion(completedAreas, newSet);
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
   TaskCard - one tappable checklist row (public area OR laundry load).
   The two used to be separate components with byte-identical markup differing
   only in title/subtitle text; merged so there is a single source of truth for
   the card's look and tap behavior. Callers pass the pre-composed subtitle so
   the rendered DOM is unchanged.
   ───────────────────────────────────────────────────────────────────────────── */
function TaskCard({
  title,
  subtitle,
  isCompleted,
  onToggle,
}: {
  title: React.ReactNode;
  subtitle: React.ReactNode;
  isCompleted: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={isCompleted}
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
            {title}
          </p>
          <p style={{
            fontSize: '13px', color: 'var(--text-muted)',
          }}>
            {subtitle}
          </p>
        </div>
      </div>
    </button>
  );
}
