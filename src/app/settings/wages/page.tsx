'use client';

export const dynamic = 'force-dynamic';

// Settings → Wages. Managers set the hourly wages that cost the published
// schedule into the Dashboard's Labor Cost % tile:
//   • Section 1 — a default hourly wage per role (the 4 schedule departments).
//   • Section 2 — optional per-person overrides (blank = use the role default).
//
// Sensitive pay data → labor_wage_settings is service-role-only (migration
// 0245). This page reads/writes ONLY through /api/settings/wages (db helpers),
// never the browser supabase client. Manager-gated (admin/owner/GM).

import React, { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { ChevronLeft } from 'lucide-react';
import { useScope } from '@/lib/hooks/use-scope';
import { useLang } from '@/contexts/LanguageContext';
import { AppLayout } from '@/components/layout/AppLayout';
import { LABOR_ROLE_DEPARTMENTS, MAX_HOURLY_WAGE_CENTS, type LaborRole } from '@/lib/labor-cost';
import { useCan } from '@/lib/capabilities/useCan';
import { parseDollarsToCents, formatCents } from '@/lib/financials/shared';
import {
  fetchWageSettings, saveWageSettings,
  type WageSettingsData, type WageStaffRow,
} from '@/lib/db';
import { T, fonts, deptMeta, asDeptKey, Caps, Btn, Card } from '@/app/staff/_components/_tokens';

export default function WagesSettingsPage() {
  const { uid, pid } = useScope();
  const { lang } = useLang();
  const can = useCan();

  // Sensitive pay data — gated by view_wages (default: every role; an admin can
  // switch a role OFF per hotel from the Access tab).
  if (!uid || !can('view_wages')) {
    return (
      <AppLayout>
        <div style={{ padding: 24, fontFamily: fonts.sans, color: T.ink2 }}>
          {lang === 'es' ? 'Acceso solo para gerentes.' : 'Manager access only.'}
        </div>
      </AppLayout>
    );
  }

  return <AppLayout><WagesBody pid={pid ?? ''} lang={lang} /></AppLayout>;
}

/** cents → an editable dollar string ('' when unset). */
function centsToInput(cents: number | null | undefined): string {
  if (cents == null || !Number.isFinite(cents) || cents <= 0) return '';
  return String(cents / 100);
}

function WagesBody({ pid, lang }: { pid: string; lang: 'en' | 'es' }) {
  const es = lang === 'es';
  const [data, setData] = useState<WageSettingsData | null>(null);
  const [roleInputs, setRoleInputs] = useState<Record<LaborRole, string>>(
    () => Object.fromEntries(LABOR_ROLE_DEPARTMENTS.map((d) => [d, ''])) as Record<LaborRole, string>,
  );
  const [overrideInputs, setOverrideInputs] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  useEffect(() => {
    if (!pid) return;
    let active = true;
    setLoading(true);
    void fetchWageSettings(pid).then((d) => {
      if (!active) return;
      if (!d) { setError(es ? 'No se pudieron cargar los salarios' : 'Failed to load wages'); setLoading(false); return; }
      setData(d);
      setRoleInputs(
        Object.fromEntries(
          LABOR_ROLE_DEPARTMENTS.map((dept) => [dept, centsToInput(d.roleDefaults[dept])]),
        ) as Record<LaborRole, string>,
      );
      const ovr: Record<string, string> = {};
      for (const o of d.overrides) ovr[o.staffId] = centsToInput(o.hourlyWageCents);
      setOverrideInputs(ovr);
      setLoading(false);
    }).catch((err) => {
      // A network throw used to skip setLoading(false) entirely, leaving the
      // page stuck on "LOADING…" forever.
      console.error('[wages:settings] load failed', err);
      if (!active) return;
      setError(es ? 'No se pudieron cargar los salarios' : 'Failed to load wages');
      setLoading(false);
    });
    return () => { active = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pid]);

  // Active staff grouped by department (overrides only make sense for people
  // who can be scheduled).
  const grouped = useMemo(() => {
    const map: Record<LaborRole, WageStaffRow[]> = {
      housekeeping: [], front_desk: [], maintenance: [], other: [],
    };
    for (const s of data?.staff ?? []) {
      if (!s.isActive) continue;
      map[asDeptKey(s.department) as LaborRole].push(s);
    }
    return map;
  }, [data]);

  const benchmarkLabel = formatCents(data?.defaultWageCents ?? null);

  const save = async () => {
    if (!pid) return;
    // If the load never succeeded, the inputs are all blank — saving would
    // clear every role default and per-person override. Block it.
    if (!data) {
      setError(es ? 'No se pudieron cargar los salarios — recarga la página antes de guardar.' : 'Wages didn’t load — refresh the page before saving.');
      return;
    }
    setError(null);

    // Role defaults: blank → null (clear); non-blank must parse to (0, $2000].
    const roleDefaults: Partial<Record<LaborRole, number | null>> = {};
    for (const dept of LABOR_ROLE_DEPARTMENTS) {
      const raw = roleInputs[dept]?.trim() ?? '';
      if (raw === '') { roleDefaults[dept] = null; continue; }
      const cents = parseDollarsToCents(raw);
      if (cents == null || cents <= 0 || cents > MAX_HOURLY_WAGE_CENTS) {
        setError(es
          ? `Salario inválido para ${deptMeta[dept].label} (usa un número entre $0 y $2,000)`
          : `Invalid wage for ${deptMeta[dept].label} (use a number between $0 and $2,000)`);
        return;
      }
      roleDefaults[dept] = cents;
    }

    // Per-person overrides: send the full roster (blank → null = clear).
    const overrides: Array<{ staffId: string; hourlyWageCents: number | null }> = [];
    for (const s of data?.staff ?? []) {
      const raw = overrideInputs[s.id]?.trim() ?? '';
      if (raw === '') { overrides.push({ staffId: s.id, hourlyWageCents: null }); continue; }
      const cents = parseDollarsToCents(raw);
      if (cents == null || cents <= 0 || cents > MAX_HOURLY_WAGE_CENTS) {
        setError(es
          ? `Salario inválido para ${s.name || 'empleado'} (usa un número entre $0 y $2,000)`
          : `Invalid wage for ${s.name || 'staff member'} (use a number between $0 and $2,000)`);
        return;
      }
      overrides.push({ staffId: s.id, hourlyWageCents: cents });
    }

    setSaving(true);
    try {
      const res = await saveWageSettings(pid, { roleDefaults, overrides });
      if (!res.ok || !res.data) {
        setError(res.error || (es ? 'No se pudo guardar' : 'Save failed'));
        return;
      }
      // Re-seed from the server's fresh state.
      setData(res.data);
      setRoleInputs(
        Object.fromEntries(
          LABOR_ROLE_DEPARTMENTS.map((dept) => [dept, centsToInput(res.data!.roleDefaults[dept])]),
        ) as Record<LaborRole, string>,
      );
      const ovr: Record<string, string> = {};
      for (const o of res.data.overrides) ovr[o.staffId] = centsToInput(o.hourlyWageCents);
      setOverrideInputs(ovr);
      setSavedAt(Date.now());
    } catch (err) {
      // A network throw used to skip setSaving(false), freezing the button on
      // "Saving…" with no error and no way to retry.
      console.error('[wages:settings] save failed', err);
      setError(es ? 'No se pudo guardar — revisa tu conexión e intenta de nuevo' : 'Couldn’t save — check your connection and try again');
    } finally {
      setSaving(false);
    }
  };

  const orderedDepts = LABOR_ROLE_DEPARTMENTS.filter((d) => grouped[d].length > 0);

  return (
    <div style={{ background: T.bg, color: T.ink, fontFamily: fonts.sans, minHeight: '100%', padding: '24px 48px 48px' }}>
      <div style={{ maxWidth: 760, margin: '0 auto' }}>
        <Link href="/settings" style={{
          display: 'inline-flex', alignItems: 'center', gap: 4,
          fontFamily: fonts.sans, fontSize: 12, color: T.ink2, textDecoration: 'none', marginBottom: 14,
        }}>
          <ChevronLeft size={14} /> {es ? 'Configuración' : 'Settings'}
        </Link>

        <div style={{ marginBottom: 22 }}>
          <Caps>{es ? 'Configuración · Salarios' : 'Settings · Wages'}</Caps>
          <h1 style={{
            fontFamily: fonts.serif, fontSize: 36, color: T.ink, margin: '4px 0 0',
            letterSpacing: '-0.03em', lineHeight: 1.1, fontWeight: 400,
          }}>
            <span style={{ fontStyle: 'italic' }}>{es ? 'Salarios por hora' : 'Hourly wages'}</span>
          </h1>
          <p style={{ fontFamily: fonts.sans, fontSize: 13, color: T.ink2, marginTop: 6, maxWidth: 600, lineHeight: 1.5 }}>
            {es
              ? 'Se usan para calcular el costo laboral de hoy como % de los ingresos en el panel. No registran tiempo nuevo: solo cuestan el horario publicado.'
              : "Used to cost today's published schedule into the Labor Cost % tile on the dashboard. No new time tracking — these just price the schedule you already publish."}
          </p>
        </div>

        {loading ? (
          <Caps>{es ? 'CARGANDO…' : 'LOADING…'}</Caps>
        ) : (
          <>
            {/* ── Section 1 — role defaults ─────────────────────────── */}
            <Card style={{ marginBottom: 16, padding: 0, overflow: 'hidden' }}>
              <div style={{ padding: '16px 20px 10px', borderBottom: `1px solid ${T.rule}` }}>
                <div style={{ fontWeight: 600, fontSize: 15, color: T.ink }}>
                  {es ? 'Salario por defecto por rol' : 'Default wage per role'}
                </div>
                <div style={{ fontSize: 12.5, color: T.ink2, marginTop: 3 }}>
                  {es
                    ? `Se aplica a cualquier persona de ese rol sin salario propio. En blanco usa el valor de referencia (${benchmarkLabel}/h).`
                    : `Applies to anyone in that role without their own wage. Blank uses the benchmark (${benchmarkLabel}/hr).`}
                </div>
              </div>
              {LABOR_ROLE_DEPARTMENTS.map((dept, i) => (
                <div key={dept} style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  padding: '12px 20px', borderTop: i === 0 ? 'none' : `1px solid ${T.ruleSoft}`,
                }}>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 9, fontSize: 14, color: T.ink }}>
                    <span style={{ width: 9, height: 9, borderRadius: '50%', background: deptMeta[dept].tone }} />
                    {deptLabel(dept, es)}
                  </span>
                  <MoneyInput
                    value={roleInputs[dept]}
                    onChange={(v) => setRoleInputs((p) => ({ ...p, [dept]: v }))}
                    placeholder={es ? 'referencia' : 'benchmark'}
                  />
                </div>
              ))}
            </Card>

            {/* ── Section 2 — per-person overrides ──────────────────── */}
            <Card style={{ padding: 0, overflow: 'hidden' }}>
              <div style={{ padding: '16px 20px 10px', borderBottom: `1px solid ${T.rule}` }}>
                <div style={{ fontWeight: 600, fontSize: 15, color: T.ink }}>
                  {es ? 'Salarios por persona (opcional)' : 'Per-person wages (optional)'}
                </div>
                <div style={{ fontSize: 12.5, color: T.ink2, marginTop: 3 }}>
                  {es ? 'En blanco usa el salario del rol.' : 'Blank uses the role default above.'}
                </div>
              </div>

              {orderedDepts.length === 0 ? (
                <div style={{ padding: '20px', textAlign: 'center', color: T.ink3, fontSize: 13 }}>
                  {es ? 'No hay personal activo todavía.' : 'No active staff yet.'}
                </div>
              ) : (
                orderedDepts.map((dept) => (
                  <section key={dept}>
                    <div style={{
                      display: 'flex', alignItems: 'center', gap: 8,
                      padding: '10px 20px', background: T.ruleSoft,
                    }}>
                      <span style={{ width: 8, height: 8, borderRadius: '50%', background: deptMeta[dept].tone }} />
                      <Caps size={10} c={T.ink2}>{deptLabel(dept, es)}</Caps>
                    </div>
                    {grouped[dept].map((s) => (
                      <div key={s.id} style={{
                        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                        gap: 12, padding: '11px 20px', borderTop: `1px solid ${T.ruleSoft}`,
                      }}>
                        <div style={{ minWidth: 0 }}>
                          <div style={{ fontSize: 14, color: T.ink, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                            {s.name || (es ? '(sin nombre)' : '(no name)')}
                          </div>
                          {s.hourlyWageCents != null && (
                            <div style={{ fontSize: 11.5, color: T.ink3, marginTop: 1 }}>
                              {es ? `base ${formatCents(s.hourlyWageCents)}/h` : `base ${formatCents(s.hourlyWageCents)}/hr`}
                            </div>
                          )}
                        </div>
                        <MoneyInput
                          value={overrideInputs[s.id] ?? ''}
                          onChange={(v) => setOverrideInputs((p) => ({ ...p, [s.id]: v }))}
                          placeholder={es ? 'rol' : 'role default'}
                        />
                      </div>
                    ))}
                  </section>
                ))
              )}
            </Card>

            {error && (
              <div role="alert" style={{
                padding: '10px 14px', background: T.redDim, border: `1px solid ${T.red}40`,
                borderRadius: 12, color: T.red, fontSize: 13, marginTop: 14,
              }}>{error}</div>
            )}

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 12, marginTop: 16, alignItems: 'center' }}>
              {savedAt && (
                <span style={{ fontFamily: fonts.mono, fontSize: 11, color: T.ink3, letterSpacing: '0.06em' }}>
                  {es ? 'GUARDADO' : 'SAVED'} · {new Date(savedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </span>
              )}
              <Btn variant="primary" size="md" onClick={save} disabled={saving}>
                {saving ? (es ? 'Guardando…' : 'Saving…') : (es ? 'Guardar' : 'Save')}
              </Btn>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function deptLabel(dept: LaborRole, es: boolean): string {
  if (!es) return deptMeta[dept].label;
  return { housekeeping: 'Limpieza', front_desk: 'Recepción', maintenance: 'Mantenimiento', other: 'Otro' }[dept];
}

function MoneyInput({
  value, onChange, placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <div style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      border: `1px solid ${T.rule}`, borderRadius: 10, padding: '0 10px',
      background: T.paper, height: 36, width: 130, flexShrink: 0,
    }}>
      <span style={{ color: T.ink3, fontSize: 13, fontFamily: fonts.mono }}>$</span>
      <input
        value={value}
        inputMode="decimal"
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label="hourly wage"
        style={{
          width: '100%', border: 'none', outline: 'none', background: 'transparent',
          fontFamily: fonts.mono, fontSize: 13, color: T.ink, textAlign: 'right',
        }}
      />
      <span style={{ color: T.ink3, fontSize: 11, fontFamily: fonts.mono }}>/hr</span>
    </div>
  );
}
