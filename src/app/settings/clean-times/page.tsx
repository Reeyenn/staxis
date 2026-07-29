'use client';


export const dynamic = 'force-dynamic';
// Settings → Clean Times. Manager edits the standard minutes for each
// cleaning type, plus how long one housekeeping shift is. These drive the
// housekeeping workload estimates on the Auto-Assign Board / Timeline (via
// the rules-engine base + the assignment fallback), and the shift length is
// what turns a pile of minutes into a crew size (capacity bars, Over-cap /
// Near-full pills, "Recommended N HK", the timeline window, the forecast).
// Backed by /api/settings/clean-times (GET/PUT, service-role).
//
// The shift length landed here on 2026-07-24. Its previous and only editor
// was a gear icon on the Housekeeping board that wrote `properties` from the
// browser — an admin-only write, so a general manager saw "Settings saved"
// and saved nothing. This page's PUT goes through the service role.
//
// Note the two different gates: the per-clean minutes follow the per-hotel
// `manage_clean_times` capability (every role by default), while the shift
// length is owner/GM-only — it was behind admin-only RLS before it moved
// here, and it is the number every capacity bar and headcount recommendation
// divides by. The API reports that as `canEditShift`.
//
// Bilingual via useLang() inline ternaries — matches the sibling settings
// pages (e.g. settings/shifts) rather than the giant translations.ts map.

import React, { useEffect, useRef, useState } from 'react';
import { useScope } from '@/lib/hooks/use-scope';
import { useLang } from '@/contexts/LanguageContext';
import { useProperty } from '@/contexts/PropertyContext';
import { AppLayout } from '@/components/layout/AppLayout';
import { useCan } from '@/lib/capabilities/useCan';
import { fetchWithAuth } from '@/lib/api-fetch';
import { localizeKnownMessage, type LocalizedMessagePair } from '@/lib/localized-ui-message';
import {
  EDITABLE_CLEANING_TYPES,
  CLEAN_TIME_DEFAULT_MINUTES,
  MIN_CLEAN_MINUTES,
  MAX_CLEAN_MINUTES,
  MIN_SHIFT_MINUTES,
  MAX_SHIFT_MINUTES,
  DEFAULT_SHIFT_MINUTES,
  type EditableCleaningType,
} from '@/lib/clean-time-standards';
import { T, fonts, Btn, Caps } from '@/app/staff/_components/_tokens';
import { ChevronLeft, RotateCcw } from 'lucide-react';
import Link from 'next/link';

// Friendly bilingual labels + one-line "what it is" for each editable
// cleaning type. The keys are the real cleaning_type values from the
// cleaning_tasks CHECK constraint (migration 0210).
const TYPE_META: Record<EditableCleaningType, { en: string; es: string; enHint: string; esHint: string }> = {
  departure:       { en: 'Checkout clean',        es: 'Limpieza de salida',           enHint: 'Guest checked out. Full turnover for the next arrival', esHint: 'El huésped salió. Preparación completa para el siguiente' },
  departure_deep:  { en: 'Checkout deep clean',   es: 'Limpieza profunda de salida',  enHint: 'Departure turnover plus a deep clean',                  esHint: 'Salida más limpieza profunda' },
  stayover:        { en: 'Stayover clean',        es: 'Limpieza de estancia',         enHint: 'Guest still staying: tidy, fresh towels, trash',        esHint: 'Huésped aún hospedado: orden, toallas, basura' },
  refresh:         { en: 'Refresh / touch-up',    es: 'Retoque',                      enHint: 'Light touch-up between or during stays',                 esHint: 'Retoque ligero entre o durante estancias' },
  deep:            { en: 'Deep clean',            es: 'Limpieza profunda',            enHint: 'Periodic full deep clean',                               esHint: 'Limpieza profunda periódica' },
  room_check:      { en: 'Room check',            es: 'Revisión de habitación',       enHint: 'Quick verify the room is ready',                         esHint: 'Verificación rápida de que la habitación está lista' },
  inspection_only: { en: 'Inspection only',       es: 'Solo inspección',              enHint: 'Senior inspection, no cleaning',                         esHint: 'Inspección por personal sénior, sin limpieza' },
};

const CLEAN_TIMES_ERROR_MESSAGES = [
  [
    'Couldn’t load your clean times. Refresh the page to try again.',
    'No se pudieron cargar los tiempos de limpieza. Recarga la página para intentar de nuevo.',
  ],
  ...EDITABLE_CLEANING_TYPES.map((type) => [
    `"${TYPE_META[type].en}" must be a whole number between ${MIN_CLEAN_MINUTES} and ${MAX_CLEAN_MINUTES}.`,
    `"${TYPE_META[type].es}" debe ser un número entero entre ${MIN_CLEAN_MINUTES} y ${MAX_CLEAN_MINUTES}.`,
  ] as const),
] as const satisfies readonly LocalizedMessagePair[];

// Shift length is stored in minutes but a manager thinks in hours, so the
// field is hours. Quarter-hours round-trip exactly (0.25h = 15min).
function minutesToHoursInput(mins: number): string {
  const hours = mins / 60;
  return Number.isInteger(hours) ? String(hours) : String(Number(hours.toFixed(2)));
}

export default function CleanTimesPage() {
  const { uid, pid } = useScope();
  const { lang } = useLang();
  const can = useCan();

  // Gated by per-hotel manage_clean_times (default: every role; admin can
  // switch a role OFF per hotel from the Access tab).
  if (!uid || !can('manage_clean_times')) {
    return (
      <AppLayout>
        <div style={{ padding: 24, fontFamily: fonts.sans, color: T.ink2 }}>
          {lang === 'es' ? 'Solo para gerentes.' : 'Manager access only.'}
        </div>
      </AppLayout>
    );
  }

  return <AppLayout><CleanTimesBody pid={pid ?? ''} lang={lang} /></AppLayout>;
}

function CleanTimesBody({ pid, lang }: { pid: string; lang: 'en' | 'es' }) {
  // The Housekeeping board's capacity bars and "Recommended N HK" read the
  // shift length out of PropertyContext, which is loaded once per session by a
  // provider that sits above the router — so navigating back to the board
  // would show the OLD number until a hard reload. Re-read the property after
  // a save so the board is right the moment the manager walks over to it.
  const { refreshProperty } = useProperty();

  // Per-type input values held as strings so the field can be edited freely;
  // parsed + validated on save.
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [defaults, setDefaults] = useState<Record<string, number>>({ ...CLEAN_TIME_DEFAULT_MINUTES });
  // Per-housekeeper shift length, held in HOURS as a string for the same
  // free-editing reason as the minute fields above.
  const [shiftHours, setShiftHours] = useState<string>(minutesToHoursInput(DEFAULT_SHIFT_MINUTES));
  // The shift length is owner/GM-only (it sets the whole hotel's labor math —
  // see the route header). Everyone else sees the number but can't change it,
  // which is friendlier than letting them type and then 403ing the save.
  const [canEditShift, setCanEditShift] = useState(false);
  const [loading, setLoading] = useState(true);
  // A failed load must NOT silently fill the form with industry defaults —
  // Save PUTs the full standards array, so saving from that state would
  // overwrite every customized time. Block the form until a load succeeds.
  const [loadFailed, setLoadFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  // Read the current language inside the load effect via a ref so it is NOT
  // an effect dependency — otherwise toggling EN/ES would re-run the fetch and
  // clobber unsaved draft edits (and flash the LOADING state). Clean times are
  // plain numbers, so nothing about a language change needs a refetch. Mirrors
  // the sibling settings/shifts page.
  const langRef = useRef(lang);
  langRef.current = lang;

  useEffect(() => {
    if (!pid) { setLoading(false); return; }
    let active = true;
    setLoading(true);
    setError(null);
    setLoadFailed(false);
    fetchWithAuth(`/api/settings/clean-times?propertyId=${pid}`)
      .then(r => {
        // A non-OK response must NOT fall through to the defaults-filled
        // form — Save would then replace the hotel's tuned times wholesale.
        if (!r.ok) throw new Error(`clean-times load failed (${r.status})`);
        return r.json();
      })
      .then((body: {
        data?: {
          standards?: Array<{ cleaningType: string; baseMinutes: number }>;
          defaults?: Record<string, number>;
          shiftMinutes?: number;
          canEditShift?: boolean;
        };
      } | null) => {
        if (!active) return;
        const list = body?.data?.standards ?? [];
        const next: Record<string, string> = {};
        for (const s of list) next[s.cleaningType] = String(s.baseMinutes);
        // Make sure every editable type has a field even if the API somehow
        // omitted one.
        for (const t of EDITABLE_CLEANING_TYPES) {
          if (next[t] === undefined) next[t] = String(CLEAN_TIME_DEFAULT_MINUTES[t]);
        }
        setDrafts(next);
        if (body?.data?.defaults) setDefaults(body.data.defaults);
        if (typeof body?.data?.shiftMinutes === 'number') {
          setShiftHours(minutesToHoursInput(body.data.shiftMinutes));
        }
        setCanEditShift(body?.data?.canEditShift === true);
        setLoading(false);
      })
      .catch(err => {
        console.error('[clean-times:settings] load failed', err);
        if (active) {
          setLoadFailed(true);
          setError(langRef.current === 'es'
            ? 'No se pudieron cargar los tiempos de limpieza. Recarga la página para intentar de nuevo.'
            : 'Couldn’t load your clean times. Refresh the page to try again.');
          setLoading(false);
        }
      });
    return () => { active = false; };
  }, [pid]);

  const setVal = (type: string, v: string) => {
    // Keep only digits; cap length so the field stays sane.
    const cleaned = v.replace(/[^0-9]/g, '').slice(0, 3);
    setDrafts(prev => ({ ...prev, [type]: cleaned }));
  };

  const visibleError = localizeKnownMessage(error, lang, CLEAN_TIMES_ERROR_MESSAGES);

  // Digits plus at most one decimal point — 7.5 hours has to be typeable.
  const setShiftVal = (v: string) => {
    const cleaned = v.replace(/[^0-9.]/g, '');
    const [whole, ...rest] = cleaned.split('.');
    const joined = rest.length > 0 ? `${whole}.${rest.join('')}` : whole;
    setShiftHours(joined.slice(0, 5));
  };

  const resetToDefaults = () => {
    const next: Record<string, string> = {};
    for (const t of EDITABLE_CLEANING_TYPES) {
      next[t] = String(defaults[t] ?? CLEAN_TIME_DEFAULT_MINUTES[t]);
    }
    setDrafts(next);
    // Don't move a number this user can't save — it would show one shift
    // length on screen and keep another in the database.
    if (canEditShift) setShiftHours(minutesToHoursInput(DEFAULT_SHIFT_MINUTES));
    setSavedAt(null);
    setError(null);
  };

  const save = async () => {
    if (!pid) return;
    // Never save on top of a failed load — the drafts would just be the
    // industry defaults, overwriting the hotel's customized times.
    if (loadFailed) return;
    const standards: Array<{ cleaningType: string; baseMinutes: number }> = [];
    for (const t of EDITABLE_CLEANING_TYPES) {
      const n = Number(drafts[t]);
      if (!Number.isInteger(n) || n < MIN_CLEAN_MINUTES || n > MAX_CLEAN_MINUTES) {
        const label = lang === 'es' ? TYPE_META[t].es : TYPE_META[t].en;
        setError(
          lang === 'es'
            ? `"${label}" debe ser un número entero entre ${MIN_CLEAN_MINUTES} y ${MAX_CLEAN_MINUTES}.`
            : `"${label}" must be a whole number between ${MIN_CLEAN_MINUTES} and ${MAX_CLEAN_MINUTES}.`,
        );
        return;
      }
      standards.push({ cleaningType: t, baseMinutes: n });
    }
    // Shift length: typed in hours, sent in whole minutes. Omitted entirely
    // for anyone who can't edit it — the route reads "no shiftMinutes" as
    // "leave it alone", so their save still writes the cleaning times.
    let shiftMinutes: number | undefined;
    if (canEditShift) {
      const hours = Number(shiftHours);
      const mins = Math.round(hours * 60);
      if (
        shiftHours.trim() === '' || !Number.isFinite(hours) ||
        mins < MIN_SHIFT_MINUTES || mins > MAX_SHIFT_MINUTES
      ) {
        setError(
          lang === 'es'
            ? `La duración del turno debe estar entre ${MIN_SHIFT_MINUTES / 60} y ${MAX_SHIFT_MINUTES / 60} horas.`
            : `Shift length must be between ${MIN_SHIFT_MINUTES / 60} and ${MAX_SHIFT_MINUTES / 60} hours.`,
        );
        return;
      }
      shiftMinutes = mins;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await fetchWithAuth('/api/settings/clean-times', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          shiftMinutes === undefined
            ? { propertyId: pid, standards }
            : { propertyId: pid, standards, shiftMinutes },
        ),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error || 'Save failed');
      }
      const body = await res.json().catch(() => null) as {
        data?: {
          standards?: Array<{ cleaningType: string; baseMinutes: number }>;
          shiftMinutes?: number;
        };
      } | null;
      const list = body?.data?.standards ?? standards;
      const next: Record<string, string> = {};
      for (const s of list) next[s.cleaningType] = String(s.baseMinutes);
      setDrafts(next);
      const echoedShift = body?.data?.shiftMinutes ?? shiftMinutes;
      if (typeof echoedShift === 'number') setShiftHours(minutesToHoursInput(echoedShift));
      setSavedAt(Date.now());
      // Best-effort: the save already succeeded, so a failed re-read must not
      // turn a green "Saved" into a red error. Worst case the board shows the
      // old shift length until the next reload.
      try { await refreshProperty(); } catch { /* stale context, not a save failure */ }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ background: T.bg, color: T.ink, fontFamily: fonts.sans, minHeight: '100%', padding: '24px 48px 48px' }}>
      <div style={{ maxWidth: 760, margin: '0 auto' }}>
        <Link href="/settings" style={{
          display: 'inline-flex', alignItems: 'center', gap: 4,
          fontFamily: fonts.sans, fontSize: 12, color: T.ink2,
          textDecoration: 'none', marginBottom: 14,
        }}>
          <ChevronLeft size={14} /> {lang === 'es' ? 'Configuración' : 'Settings'}
        </Link>

        <div style={{ marginBottom: 22 }}>
          <Caps>{lang === 'es' ? 'Configuración · Tiempos de limpieza' : 'Settings · Clean Times'}</Caps>
          <h1 style={{
            fontFamily: fonts.serif, fontSize: 36, color: T.ink,
            margin: '4px 0 0', letterSpacing: '-0.03em', lineHeight: 1.1, fontWeight: 400,
          }}>
            <span style={{ fontStyle: 'italic' }}>
              {lang === 'es' ? 'Tiempos de limpieza' : 'Clean times'}
            </span>
          </h1>
          <p style={{ fontFamily: fonts.sans, fontSize: 13, color: T.ink2, marginTop: 6, maxWidth: 600, lineHeight: 1.5 }}>
            {lang === 'es'
              ? 'Minutos estándar por tipo de limpieza, y cuánto dura un turno. Estos tiempos impulsan el balanceo de carga en el Tablero de Asignación Automática.'
              : 'Standard minutes per cleaning type, and how long one shift is. These times drive the workload balancing on the Auto-Assign Board.'}
          </p>
        </div>

        {loading ? (
          <Caps>{lang === 'es' ? 'CARGANDO…' : 'LOADING…'}</Caps>
        ) : loadFailed ? (
          // Load-error state — deliberately hides the form so Save can't
          // overwrite the hotel's tuned times with the industry defaults.
          <div role="alert" style={{
            padding: '14px 16px', background: 'rgba(160,74,44,0.08)',
            border: '1px solid rgba(160,74,44,0.25)', borderRadius: 12,
            color: '#A04A2C', fontSize: 13, lineHeight: 1.5,
          }}>{visibleError}</div>
        ) : (
          <>
            <section style={{
              background: T.paper, border: `1px solid ${T.rule}`, borderRadius: 16, overflow: 'hidden',
            }}>
              {EDITABLE_CLEANING_TYPES.map((t, i) => {
                const meta = TYPE_META[t];
                return (
                  <div key={t} style={{
                    display: 'grid', gridTemplateColumns: '1fr 132px',
                    gap: 12, alignItems: 'center',
                    padding: '14px 18px',
                    borderBottom: i === EDITABLE_CLEANING_TYPES.length - 1 ? 'none' : `1px solid ${T.ruleSoft}`,
                  }}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontWeight: 600, fontSize: 14.5, color: T.ink }}>
                        {lang === 'es' ? meta.es : meta.en}
                      </div>
                      <div style={{ fontSize: 12.5, color: T.ink3, marginTop: 2, lineHeight: 1.4 }}>
                        {lang === 'es' ? meta.esHint : meta.enHint}
                      </div>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'flex-end' }}>
                      <input
                        inputMode="numeric"
                        value={drafts[t] ?? ''}
                        onChange={e => setVal(t, e.target.value)}
                        aria-label={`${lang === 'es' ? meta.es : meta.en}, ${lang === 'es' ? 'minutos' : 'minutes'}`}
                        style={{
                          width: 72, boxSizing: 'border-box',
                          padding: '8px 10px', borderRadius: 10, border: `1px solid ${T.rule}`,
                          background: T.paper, fontFamily: fonts.mono, fontSize: 14, color: T.ink,
                          textAlign: 'center', outline: 'none',
                        }}
                      />
                      <span style={{ fontSize: 12.5, color: T.ink3, width: 40 }}>
                        {lang === 'es' ? 'min' : 'min'}
                      </span>
                    </div>
                  </div>
                );
              })}
            </section>

            {/* Shift length — one field, its own card so it reads as a
                different kind of number than the per-clean minutes above. */}
            <section style={{
              background: T.paper, border: `1px solid ${T.rule}`, borderRadius: 16,
              overflow: 'hidden', marginTop: 16,
            }}>
              <div style={{
                display: 'grid', gridTemplateColumns: '1fr 132px',
                gap: 12, alignItems: 'center', padding: '14px 18px',
              }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 600, fontSize: 14.5, color: T.ink }}>
                    {lang === 'es' ? '¿Cuánto dura un turno de limpieza?' : 'How long is a housekeeping shift?'}
                  </div>
                  <div style={{ fontSize: 12.5, color: T.ink3, marginTop: 2, lineHeight: 1.4 }}>
                    {lang === 'es'
                      ? 'Cuánta limpieza cabe en el día de una persona. Define las barras de carga del tablero y cuántas personas recomendamos.'
                      : 'How much cleaning fits in one person’s day. Sets the workload bars on the board and how many housekeepers we recommend.'}
                    {!canEditShift && (
                      <>
                        {' '}
                        <span style={{ color: T.ink2 }}>
                          {lang === 'es'
                            ? 'Solo el propietario o el gerente general puede cambiarlo.'
                            : 'Only the owner or general manager can change this.'}
                        </span>
                      </>
                    )}
                  </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'flex-end' }}>
                  <input
                    inputMode="decimal"
                    value={shiftHours}
                    onChange={e => setShiftVal(e.target.value)}
                    readOnly={!canEditShift}
                    disabled={!canEditShift}
                    aria-label={lang === 'es' ? 'Duración del turno, horas' : 'Shift length, hours'}
                    style={{
                      width: 72, boxSizing: 'border-box',
                      padding: '8px 10px', borderRadius: 10, border: `1px solid ${T.rule}`,
                      background: canEditShift ? T.paper : T.ruleSoft,
                      fontFamily: fonts.mono, fontSize: 14,
                      color: canEditShift ? T.ink : T.ink3,
                      textAlign: 'center', outline: 'none',
                    }}
                  />
                  {/* 'h' is the hour symbol in both EN and ES. */}
                  <span style={{ fontSize: 12.5, color: T.ink3, width: 40 }}>h</span>
                </div>
              </div>
            </section>

            {visibleError && (
              <div role="alert" style={{
                padding: '10px 14px', background: 'rgba(160,74,44,0.08)',
                border: '1px solid rgba(160,74,44,0.25)', borderRadius: 12,
                color: '#A04A2C', fontSize: 13, marginTop: 12,
              }}>{visibleError}</div>
            )}

            <div style={{
              display: 'flex', justifyContent: 'space-between', gap: 10, marginTop: 16,
              alignItems: 'center', flexWrap: 'wrap',
            }}>
              <Btn variant="ghost" size="md" onClick={resetToDefaults} disabled={saving}>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  <RotateCcw size={14} />
                  {lang === 'es' ? 'Restablecer predeterminados' : 'Reset to industry defaults'}
                </span>
              </Btn>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                {savedAt && (
                  <span style={{ fontFamily: fonts.mono, fontSize: 11, color: T.ink3, letterSpacing: '0.06em' }}>
                    {lang === 'es' ? 'GUARDADO' : 'SAVED'} · {new Date(savedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </span>
                )}
                <Btn variant="primary" size="md" onClick={save} disabled={saving}>
                  {saving
                    ? (lang === 'es' ? 'Guardando…' : 'Saving…')
                    : (lang === 'es' ? 'Guardar' : 'Save')}
                </Btn>
              </div>
            </div>

            <p style={{ fontFamily: fonts.sans, fontSize: 12, color: T.ink3, marginTop: 14, lineHeight: 1.5 }}>
              {lang === 'es'
                ? 'Los tiempos de limpieza se aplican a las tareas creadas después de guardar. La duración del turno se aplica de inmediato.'
                : 'Clean times apply to cleaning tasks created after you save. The shift length takes effect right away.'}
            </p>
          </>
        )}
      </div>
    </div>
  );
}
