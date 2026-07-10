'use client';


export const dynamic = 'force-dynamic';
// Settings → Clean Times. Manager edits the standard minutes for each
// cleaning type. These drive the housekeeping workload estimates on the
// Auto-Assign Board / Timeline (via the rules-engine base + the assignment
// fallback). Backed by /api/settings/clean-times (GET/PUT, service-role).
//
// Bilingual via useLang() inline ternaries — matches the sibling settings
// pages (e.g. settings/shifts) rather than the giant translations.ts map.

import React, { useEffect, useState } from 'react';
import { useScope } from '@/lib/hooks/use-scope';
import { useLang } from '@/contexts/LanguageContext';
import { AppLayout } from '@/components/layout/AppLayout';
import { useCan } from '@/lib/capabilities/useCan';
import { fetchWithAuth } from '@/lib/api-fetch';
import {
  EDITABLE_CLEANING_TYPES,
  CLEAN_TIME_DEFAULT_MINUTES,
  MIN_CLEAN_MINUTES,
  MAX_CLEAN_MINUTES,
  type EditableCleaningType,
} from '@/lib/clean-time-standards';
import { T, fonts, Btn, Caps } from '@/app/staff/_components/_tokens';
import { ChevronLeft, RotateCcw } from 'lucide-react';
import Link from 'next/link';

// Friendly bilingual labels + one-line "what it is" for each editable
// cleaning type. The keys are the real cleaning_type values from the
// cleaning_tasks CHECK constraint (migration 0210).
const TYPE_META: Record<EditableCleaningType, { en: string; es: string; enHint: string; esHint: string }> = {
  departure:       { en: 'Checkout clean',        es: 'Limpieza de salida',           enHint: 'Guest checked out — full turnover for the next arrival', esHint: 'El huésped salió — preparación completa para el siguiente' },
  departure_deep:  { en: 'Checkout deep clean',   es: 'Limpieza profunda de salida',  enHint: 'Departure turnover plus a deep clean',                  esHint: 'Salida más limpieza profunda' },
  stayover:        { en: 'Stayover clean',        es: 'Limpieza de estancia',         enHint: 'Guest still staying — tidy, fresh towels, trash',        esHint: 'Huésped aún hospedado — orden, toallas, basura' },
  refresh:         { en: 'Refresh / touch-up',    es: 'Retoque',                      enHint: 'Light touch-up between or during stays',                 esHint: 'Retoque ligero entre o durante estancias' },
  deep:            { en: 'Deep clean',            es: 'Limpieza profunda',            enHint: 'Periodic full deep clean',                               esHint: 'Limpieza profunda periódica' },
  room_check:      { en: 'Room check',            es: 'Revisión de habitación',       enHint: 'Quick verify the room is ready',                         esHint: 'Verificación rápida de que la habitación está lista' },
  inspection_only: { en: 'Inspection only',       es: 'Solo inspección',              enHint: 'Senior inspection, no cleaning',                         esHint: 'Inspección por personal sénior, sin limpieza' },
};

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
  // Per-type input values held as strings so the field can be edited freely;
  // parsed + validated on save.
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [defaults, setDefaults] = useState<Record<string, number>>({ ...CLEAN_TIME_DEFAULT_MINUTES });
  const [loading, setLoading] = useState(true);
  // A failed load must NOT silently fill the form with industry defaults —
  // Save PUTs the full standards array, so saving from that state would
  // overwrite every customized time. Block the form until a load succeeds.
  const [loadFailed, setLoadFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

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
        setLoading(false);
      })
      .catch(err => {
        console.error('[clean-times:settings] load failed', err);
        if (active) {
          setLoadFailed(true);
          setError(lang === 'es'
            ? 'No se pudieron cargar los tiempos de limpieza. Recarga la página para intentar de nuevo.'
            : 'Couldn’t load your clean times. Refresh the page to try again.');
          setLoading(false);
        }
      });
    return () => { active = false; };
  }, [pid, lang]);

  const setVal = (type: string, v: string) => {
    // Keep only digits; cap length so the field stays sane.
    const cleaned = v.replace(/[^0-9]/g, '').slice(0, 3);
    setDrafts(prev => ({ ...prev, [type]: cleaned }));
  };

  const resetToDefaults = () => {
    const next: Record<string, string> = {};
    for (const t of EDITABLE_CLEANING_TYPES) {
      next[t] = String(defaults[t] ?? CLEAN_TIME_DEFAULT_MINUTES[t]);
    }
    setDrafts(next);
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
    setSaving(true);
    setError(null);
    try {
      const res = await fetchWithAuth('/api/settings/clean-times', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ propertyId: pid, standards }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error || 'Save failed');
      }
      const body = await res.json().catch(() => null) as {
        data?: { standards?: Array<{ cleaningType: string; baseMinutes: number }> };
      } | null;
      const list = body?.data?.standards ?? standards;
      const next: Record<string, string> = {};
      for (const s of list) next[s.cleaningType] = String(s.baseMinutes);
      setDrafts(next);
      setSavedAt(Date.now());
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
              ? 'Minutos estándar por tipo de limpieza. Estos tiempos impulsan el balanceo de carga en el Tablero de Asignación Automática.'
              : 'Standard minutes per cleaning type. These times drive the workload balancing on the Auto-Assign Board.'}
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
          }}>{error}</div>
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
                        aria-label={`${lang === 'es' ? meta.es : meta.en} — ${lang === 'es' ? 'minutos' : 'minutes'}`}
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

            {error && (
              <div role="alert" style={{
                padding: '10px 14px', background: 'rgba(160,74,44,0.08)',
                border: '1px solid rgba(160,74,44,0.25)', borderRadius: 12,
                color: '#A04A2C', fontSize: 13, marginTop: 12,
              }}>{error}</div>
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
                ? 'Los cambios se aplican a las tareas de limpieza creadas después de guardar.'
                : 'Changes apply to cleaning tasks created after you save.'}
            </p>
          </>
        )}
      </div>
    </div>
  );
}
