'use client';

export const dynamic = 'force-dynamic';

/**
 * /admin/ai-staff — the AI Staff roster. Reeyen only.
 *
 * WHAT THIS PAGE IS FOR
 * Staxis is one engine. This page is the org chart drawn over it: thirteen
 * named jobs, one of which exists. It answers three questions and nothing else —
 * who works here, what are they actually doing right now, and how do I stop one
 * of them.
 *
 * IT IS REACHED FROM MISSION CONTROL, and it is not a new tab in the site's
 * navigation. Mission Control is the glance ("is anything on fire"); this is the
 * page you open when the answer is "one of them is misbehaving".
 *
 * WHY IT IS A PAGE AND NOT A PANEL ON MISSION CONTROL
 * Thirteen cards with controls is not a glance. Mission Control already carries
 * three health lights, three roster columns and four decision queues; a
 * fourteenth block would bury the one control on it that stops something.
 *
 * ─── THE ONE RULE THIS PAGE OBEYS ────────────────────────────────────────────
 * NOTHING HERE STARTS ANYTHING. Every scheduled job in this product is off, and
 * this page does not schedule, wake, or enable a single one of them. The only
 * control it has is a kill override: default on, and turning it off actually
 * stops that employee's work at the point the work is generated. Switching one
 * back on clears the override — it does not turn the machine on. The master
 * switch stays where it is, with the founder.
 *
 * HONEST STATUSES ONLY. Four, and the page can back all four:
 *   Not hired yet                       — a name on a plan. No status, no
 *                                         controls, no numbers. Twelve of these.
 *   Ready — waiting for the master switch — built, switched on, and something it
 *                                         needs is not scheduled.
 *   Switched off by you                 — a row in the database says so, and when.
 *   On                                  — everything it needs is scheduled.
 * There is no "healthy", no "idle", and no green dot standing in for "we did
 * not check".
 *
 * BILINGUAL, on a page one person opens, because the house rule has no admin
 * exemption and because the roster's own copy has to exist in both languages
 * anyway — the Morning Briefer writes in both.
 *
 * Data: GET/POST /api/admin/mission/ai-staff (requireAdmin, service-role).
 * Server gate: src/app/admin/layout.tsx redirects non-admins before any HTML
 * ships; the client check below is defence in depth during the auth-load window.
 */

import React, { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { ChevronLeft, ShieldAlert } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useLang } from '@/contexts/LanguageContext';
import { fetchWithAuth } from '@/lib/api-fetch';
import { AppLayout } from '@/components/layout/AppLayout';
import { FONT_SERIF, FONT_MONO, Btn, Dot, Pill, type DotTone, type PillTone } from '@/app/admin/_components/studio/kit';
import { DarkScope, SurfaceShell, DarkCard, DarkSpinner, dimWhite } from '@/app/admin/_components/studio/surface-kit';
// This page renders OUTSIDE StudioShell, so it imports the studio stylesheet
// itself — otherwise `.admin-studio` resolves every var to nothing.
import '@/app/admin/_components/studio/studio.css';
import { EMPLOYEE_STATUS_LABEL, EMPLOYEE_STATUS_TONE } from '@/lib/ai/employee-registry';
import type { AiEmployeeStatus, Bilingual } from '@/lib/ai/employee-registry';
// The money line's shape comes from the module that computes it, so the card
// and the sum cannot drift apart. Type-only — nothing extra ships to the browser.
import { spendAttributionNote, type EmployeeSpend } from '@/lib/ai/employee-spend';

type Lang = 'en' | 'es';

// ─── Copy ───────────────────────────────────────────────────────────────────

const COPY = {
  eyebrow: { en: 'Mission Control', es: 'Centro de mando' },
  title: { en: 'AI Staff', es: 'Personal de IA' },
  subtitle: {
    en: 'Every job Staxis does, with a name on it. One of them exists; the rest are the plan.',
    es: 'Cada trabajo que hace Staxis, con un nombre. Uno existe; el resto es el plan.',
  },
  onlyYou: {
    en: 'Only you see this page. Hotels never do.',
    es: 'Solo tú ves esta página. Los hoteles nunca.',
  },
  masterNote: {
    en: 'Nothing on this page starts anything. The machine is still off; these switches only stop an employee once it is running.',
    es: 'Nada en esta página enciende nada. La máquina sigue apagada; estos interruptores solo detienen a un empleado cuando ya está funcionando.',
  },
  back: { en: 'Back to Mission Control', es: 'Volver al centro de mando' },
  working: { en: 'Working here', es: 'Trabajando aquí' },
  planned: { en: 'The plan', es: 'El plan' },
  plannedNote: {
    en: 'Not built. No status, no numbers — these do not exist yet.',
    es: 'Sin construir. Sin estado ni cifras: aún no existen.',
  },
  whatItRuns: { en: 'What it runs', es: 'Lo que ejecuta' },
  writesTo: { en: 'Where its work shows up', es: 'Dónde aparece su trabajo' },
  spend: { en: 'Model spend, last 30 days', es: 'Gasto de modelo, últimos 30 días' },
  spendUnknown: {
    en: 'No separate bill for this one yet — see the Money tab for the whole AI bill.',
    es: 'Todavía no hay factura aparte para este — mira la pestaña Money para la factura completa de IA.',
  },
  moneyTab: { en: 'Money tab', es: 'Pestaña Money' },
  switchOff: { en: 'Switch off', es: 'Apagar' },
  switchOn: { en: 'Switch back on', es: 'Volver a encender' },
  saving: { en: 'Saving…', es: 'Guardando…' },
  since: { en: 'off since', es: 'apagado desde' },
  notScheduled: { en: 'not scheduled yet', es: 'aún sin programar' },
  scheduled: { en: 'scheduled', es: 'programado' },
  loadProblem: {
    en: 'Could not reach the server. Try again.',
    es: 'No se pudo contactar el servidor. Inténtalo otra vez.',
  },
  switchesUnreadable: {
    en: 'The switches could not be read right now, so every employee below is shown as you last left it.',
    es: 'No se pudieron leer los interruptores ahora mismo, así que cada empleado se muestra como lo dejaste.',
  },
  // The ledger only learned to record WHICH JOB spent the money on the date
  // below, and nothing older will ever be attributed — a guess would be a made-
  // up number on the one page that promises not to have any. So a low figure in
  // the first weeks says why it is low, rather than reading as "nearly free".
  spendSinceOne: {
    en: 'Money was only split up by job from',
    es: 'El dinero solo se separa por trabajo desde el',
  },
  spendSinceTwo: {
    en: '— anything spent before that is on the whole AI bill, not on a card here.',
    es: '— lo gastado antes está en la factura de IA completa, no en una tarjeta de aquí.',
  },
  spendSinceNone: {
    en: 'No spend has been split up by job yet. The figures below start at zero and fill in as work runs.',
    es: 'Todavía no se ha separado ningún gasto por trabajo. Las cifras de abajo empiezan en cero y se llenan según se trabaje.',
  },
  confirmOff: {
    en: 'Switch off the Morning Briefer? No manager gets a morning brief until you switch it back on.',
    es: '¿Apagar el Informante de la mañana? Ningún gerente recibirá el resumen matutino hasta que lo vuelvas a encender.',
  },
  refresh: { en: 'Refresh', es: 'Actualizar' },
} as const;

/** Label and colour for a status, both from the registry so this page and
 *  Mission Control's roster cannot drift apart on what a status says or how it
 *  looks. */
function statusCopy(status: AiEmployeeStatus): { label: Bilingual; tone: DotTone } {
  return { label: EMPLOYEE_STATUS_LABEL[status], tone: EMPLOYEE_STATUS_TONE[status] };
}

function pillOf(tone: DotTone): PillTone {
  return tone === 'muted' ? 'neutral' : (tone as PillTone);
}

// ─── Shapes the endpoint returns ────────────────────────────────────────────

export interface RunLine {
  key: string;
  kind: 'feature' | 'detector' | 'cron';
  label: Bilingual;
  scheduled?: boolean;
}
export interface EmployeeView {
  id: string;
  name: Bilingual;
  job: Bilingual;
  hired: boolean;
  status: AiEmployeeStatus;
  switchedOff: boolean;
  switchedOffAt: string | null;
  note: string | null;
  runs: RunLine[];
  /** Already bilingual from the registry — nothing is translated at render. */
  surfaces: Bilingual[];
  spend: EmployeeSpend | null;
}
interface Payload {
  employees: EmployeeView[];
  switchesReadable: boolean;
  windowDays: number;
  /** When the ledger started recording which job spent what. Null = nothing
   *  attributed yet. Ignored entirely when `attributionReadable` is false — the
   *  page says nothing rather than implying a date it could not read. */
  attributedSince: string | null;
  attributionReadable: boolean;
  asOf: string;
}


// ─── Page ───────────────────────────────────────────────────────────────────

export default function AiStaffPage() {
  const { user, loading: authLoading } = useAuth();
  const { lang } = useLang();
  const l = (lang === 'es' ? 'es' : 'en') as Lang;

  const [payload, setPayload] = useState<Payload | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetchWithAuth('/api/admin/mission/ai-staff');
      const json = await res.json();
      if (json?.ok && json.data) {
        setPayload(json.data as Payload);
        setProblem(null);
      } else {
        setProblem(json?.error || COPY.loadProblem[l]);
      }
    } catch {
      setProblem(COPY.loadProblem[l]);
    } finally {
      setLoaded(true);
    }
  }, [l]);

  useEffect(() => { void load(); }, [load]);

  const flip = async (e: EmployeeView, next: boolean) => {
    if (busyId) return;
    if (next && typeof window !== 'undefined' && !window.confirm(COPY.confirmOff[l])) return;
    setBusyId(e.id);
    setProblem(null);
    try {
      const res = await fetchWithAuth('/api/admin/mission/ai-staff', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ employeeId: e.id, switchedOff: next }),
      });
      const json = await res.json();
      if (!json?.ok) setProblem(json?.error || COPY.loadProblem[l]);
      await load();
    } catch {
      setProblem(COPY.loadProblem[l]);
    } finally {
      setBusyId(null);
    }
  };

  if (authLoading || (user && user.role !== 'admin')) {
    return (
      <AppLayout>
        <div className="admin-studio">
          <div style={{ padding: '120px 24px', textAlign: 'center', fontFamily: FONT_SERIF, color: 'var(--ink)' }}>
            {authLoading
              ? <div className="spinner" style={{ width: 24, height: 24, margin: '0 auto' }} />
              : (
                <>
                  <ShieldAlert size={26} style={{ color: 'var(--terracotta)' }} />
                  <div style={{ marginTop: 10, fontSize: 16 }}>Admins only.</div>
                </>
              )}
          </div>
        </div>
      </AppLayout>
    );
  }

  const employees = payload?.employees ?? [];
  const hired = employees.filter((e) => e.hired);
  const notHired = employees.filter((e) => !e.hired);

  return (
    <AppLayout>
      <DarkScope>
        <SurfaceShell glow="forestTop">
          {/* Header */}
          <header style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap', marginBottom: 18 }}>
            <div style={{ minWidth: 0 }}>
              <Link
                href="/admin/properties#system"
                style={{ display: 'inline-flex', alignItems: 'center', gap: 5, color: dimWhite(.55), fontSize: 11.5, textDecoration: 'none', marginBottom: 8 }}
              >
                <ChevronLeft size={13} /> {COPY.back[l]}
              </Link>
              <div className="caps" style={{ color: dimWhite(.5) }}>{COPY.eyebrow[l]}</div>
              <h1 style={{ fontFamily: FONT_SERIF, fontSize: 32, fontWeight: 400, letterSpacing: '-0.02em', margin: '4px 0 0', color: '#fff' }}>
                {COPY.title[l]}
              </h1>
              <p style={{ fontSize: 13, color: dimWhite(.55), margin: '7px 0 0', maxWidth: 640, lineHeight: 1.5 }}>
                {COPY.subtitle[l]}
              </p>
            </div>
            <Btn size="sm" variant="ghost" onClick={() => { void load(); }} style={{ color: '#fff', borderColor: dimWhite(.25) }}>
              {COPY.refresh[l]}
            </Btn>
          </header>

          {/* The two standing notes: who sees this, and what it cannot do. */}
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 22 }}>
            <Note text={COPY.onlyYou[l]} />
            <Note text={COPY.masterNote[l]} tone="gold" />
          </div>

          {problem && (
            <div style={{ marginBottom: 16, padding: '11px 14px', background: 'var(--terracotta-dim)', border: '1px solid rgba(194,86,46,.4)', borderRadius: 12, color: 'var(--terracotta)', fontSize: 12.5 }}>
              {problem}
            </div>
          )}
          {payload && !payload.switchesReadable && (
            <div style={{ marginBottom: 16, padding: '11px 14px', background: 'rgba(201,154,46,.12)', border: '1px solid rgba(201,154,46,.35)', borderRadius: 12, color: 'var(--gold)', fontSize: 12.5 }}>
              {COPY.switchesUnreadable[l]}
            </div>
          )}
          {payload && (() => {
            const note = spendAttributionNote(payload);
            if (!note) return null;
            return (
              <div style={{ marginBottom: 16, padding: '11px 14px', background: dimWhite(.05), border: `1px solid ${dimWhite(.14)}`, borderRadius: 12, color: dimWhite(.72), fontSize: 12.5 }}>
                {note.kind === 'none' ? COPY.spendSinceNone[l] : (
                  <>
                    {COPY.spendSinceOne[l]}{' '}
                    <span className="mono">
                      {new Date(note.since).toLocaleDateString(l === 'es' ? 'es-ES' : 'en-US', {
                        year: 'numeric', month: 'short', day: 'numeric',
                      })}
                    </span>{' '}
                    {COPY.spendSinceTwo[l]}
                  </>
                )}
              </div>
            );
          })()}

          {!loaded ? (
            <div style={{ padding: '60px 0', textAlign: 'center' }}><DarkSpinner /></div>
          ) : (
            <AiStaffRoster
              hired={hired}
              notHired={notHired}
              l={l}
              busyId={busyId}
              onFlip={(e, next) => { void flip(e, next); }}
            />
          )}
        </SurfaceShell>
      </DarkScope>
    </AppLayout>
  );
}

// ─── Pieces ─────────────────────────────────────────────────────────────────

/** The two lists — the people who work here, and the plan. Exported (and free
 *  of any fetching) so the roster can be rendered from a fixture during visual
 *  review without an admin session standing in the way. */
function AiStaffRoster({ hired, notHired, l, busyId, onFlip }: {
  hired: EmployeeView[];
  notHired: EmployeeView[];
  l: Lang;
  busyId: string | null;
  onFlip: (e: EmployeeView, next: boolean) => void;
}) {
  return (
    <>
      <section style={{ marginBottom: 34 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 9 }}>
          <span className="caps" style={{ color: dimWhite(.62) }}>{COPY.working[l]}</span>
          <span className="mono" style={{ fontSize: 13, color: '#fff' }}>{hired.length}</span>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(420px, 1fr))', gap: 16, marginTop: 13, alignItems: 'start' }}>
          {hired.map((e) => (
            <HiredCard key={e.id} e={e} l={l} busy={busyId === e.id} onFlip={(next) => onFlip(e, next)} />
          ))}
        </div>
      </section>

      <section style={{ paddingBottom: 60 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 9 }}>
          <span className="caps" style={{ color: dimWhite(.4) }}>{COPY.planned[l]}</span>
          <span className="mono" style={{ fontSize: 13, color: dimWhite(.6) }}>{notHired.length}</span>
        </div>
        <div style={{ fontSize: 12, color: dimWhite(.38), marginTop: 4 }}>{COPY.plannedNote[l]}</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 12, marginTop: 13, alignItems: 'start' }}>
          {notHired.map((e) => <PlannedCard key={e.id} e={e} l={l} />)}
        </div>
      </section>
    </>
  );
}

function Note({ text, tone }: { text: string; tone?: 'gold' }) {
  return (
    <div style={{
      fontSize: 11.5,
      color: tone === 'gold' ? 'var(--gold)' : dimWhite(.5),
      background: tone === 'gold' ? 'rgba(201,154,46,.09)' : dimWhite(.04),
      border: `1px solid ${tone === 'gold' ? 'rgba(201,154,46,.28)' : dimWhite(.1)}`,
      borderRadius: 999,
      padding: '5px 13px',
      lineHeight: 1.4,
    }}>
      {text}
    </div>
  );
}

function HiredCard({ e, l, busy, onFlip }: {
  e: EmployeeView; l: Lang; busy: boolean; onFlip: (next: boolean) => void;
}) {
  const s = statusCopy(e.status);
  const crons = e.runs.filter((r) => r.kind === 'cron');
  const rest = e.runs.filter((r) => r.kind !== 'cron');

  return (
    <DarkCard style={{ padding: '17px 18px' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 11, flexWrap: 'wrap' }}>
        <Dot tone={s.tone} size={9} style={{ marginTop: 6 }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontFamily: FONT_SERIF, fontSize: 20, color: '#fff', lineHeight: 1.2 }}>{e.name[l]}</div>
          <div style={{ fontSize: 12.5, color: dimWhite(.62), marginTop: 5, lineHeight: 1.5 }}>{e.job[l]}</div>
        </div>
        <Pill tone={pillOf(s.tone)} style={{ fontSize: 9, padding: '3px 9px', flexShrink: 0 }}>{s.label[l]}</Pill>
      </div>

      {e.switchedOff && e.switchedOffAt && (
        <div className="mono" style={{ fontSize: 10, color: 'var(--terracotta)', marginTop: 9 }}>
          {COPY.since[l]} {new Date(e.switchedOffAt).toLocaleString()}
        </div>
      )}

      {/* What it runs — sentences, never internal ids. */}
      <div style={{ marginTop: 15 }}>
        <span className="caps" style={{ color: dimWhite(.4), fontSize: 9 }}>{COPY.whatItRuns[l]}</span>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 7, marginTop: 8 }}>
          {rest.map((r) => (
            <div key={r.key} style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
              <Dot tone="teal" size={5} style={{ marginTop: 6 }} />
              <span style={{ fontSize: 12, color: dimWhite(.78), lineHeight: 1.45 }}>{r.label[l]}</span>
            </div>
          ))}
          {crons.map((r) => (
            <div key={r.key} style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
              <Dot tone={r.scheduled ? 'forest' : 'gold'} size={5} style={{ marginTop: 6 }} />
              <span style={{ fontSize: 12, color: dimWhite(.78), lineHeight: 1.45 }}>
                {r.label[l]}
                <span className="mono" style={{ fontSize: 9.5, color: r.scheduled ? 'var(--forest)' : 'var(--gold)', marginLeft: 7 }}>
                  {r.scheduled ? COPY.scheduled[l] : COPY.notScheduled[l]}
                </span>
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* Where its work shows up. */}
      {e.surfaces.length > 0 && (
        <div style={{ marginTop: 15 }}>
          <span className="caps" style={{ color: dimWhite(.4), fontSize: 9 }}>{COPY.writesTo[l]}</span>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8 }}>
            {e.surfaces.map((sf, i) => (
              <div key={i} style={{ fontSize: 12, color: dimWhite(.7), lineHeight: 1.45 }}>· {sf[l]}</div>
            ))}
          </div>
        </div>
      )}

      {/* Spend — a real number or an honest absence, never an estimate. */}
      <div style={{ marginTop: 15, paddingTop: 13, borderTop: `1px solid ${dimWhite(.1)}`, display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
        <span className="caps" style={{ color: dimWhite(.4), fontSize: 9 }}>{COPY.spend[l]}</span>
        {e.spend?.known && e.spend.usd !== null ? (
          <span className="mono" style={{ fontSize: 15, fontWeight: 700, color: '#fff' }}>${e.spend.usd.toFixed(2)}</span>
        ) : (
          <span style={{ fontSize: 11.5, color: dimWhite(.5) }}>
            {COPY.spendUnknown[l]}{' '}
            <Link href="/admin/properties#money" style={{ color: 'var(--gold)' }}>{COPY.moneyTab[l]}</Link>
          </span>
        )}
      </div>

      {/* The kill switch. */}
      <div style={{ marginTop: 14 }}>
        <Btn
          size="sm"
          variant={e.switchedOff ? 'forest' : 'ghost'}
          disabled={busy}
          onClick={() => onFlip(!e.switchedOff)}
          style={e.switchedOff ? undefined : { color: 'var(--terracotta)', borderColor: 'rgba(194,86,46,.45)' }}
        >
          {busy ? COPY.saving[l] : (e.switchedOff ? COPY.switchOn[l] : COPY.switchOff[l])}
        </Btn>
      </div>
    </DarkCard>
  );
}

/** A name on a plan. Dimmed, no dot, no pill, no controls, no numbers — the
 *  card is deliberately unable to say anything about how it is doing, because
 *  there is nothing doing. */
function PlannedCard({ e, l }: { e: EmployeeView; l: Lang }) {
  return (
    <div style={{
      background: dimWhite(.025),
      border: `1px dashed ${dimWhite(.13)}`,
      borderRadius: 14,
      padding: '14px 16px',
      opacity: .72,
    }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 9, flexWrap: 'wrap' }}>
        <span style={{ fontFamily: FONT_SERIF, fontSize: 16, color: dimWhite(.82) }}>{e.name[l]}</span>
        <span className="mono" style={{ fontFamily: FONT_MONO, fontSize: 9, color: dimWhite(.38), letterSpacing: '.08em', textTransform: 'uppercase' }}>
          {EMPLOYEE_STATUS_LABEL.not_hired[l]}
        </span>
      </div>
      <div style={{ fontSize: 12, color: dimWhite(.45), marginTop: 6, lineHeight: 1.5 }}>{e.job[l]}</div>
    </div>
  );
}
