'use client';

import React, { useState, useEffect, useRef } from 'react';
import * as Sentry from '@sentry/nextjs';
import { useAuth } from '@/contexts/AuthContext';
import { useProperty } from '@/contexts/PropertyContext';
import { AppLayout } from '@/components/layout/AppLayout';
import { useLang } from '@/contexts/LanguageContext';
import { t } from '@/lib/translations';
import { fetchWithAuth } from '@/lib/api-fetch';
import { parsePmsJobStatusResponse, parsePmsOnboardResult } from '@/lib/api-validate';
import { PMS_DROPDOWN_OPTIONS } from '@/lib/pms';
import { Wifi, WifiOff, Shield, Zap, AlertCircle, CheckCircle, ChevronDown, Loader2 } from 'lucide-react';
import Link from 'next/link';

// PMS dropdown options come from the registry (src/lib/pms/registry.ts).
// Adding a new PMS is a one-line change there — keeps the dropdown,
// the type system, and the DB constraint in sync.
const PMS_SYSTEMS = PMS_DROPDOWN_OPTIONS.map((d) => ({
  value: d.id,
  label: `${d.label}${d.hint ? ` (${d.hint})` : ''}`,
  defaultLoginUrl: d.defaultLoginUrl,
}));

const SYNC_STATUS = {
  idle: null,
  testing: 'testing',
  success: 'success',
  error: 'error',
} as const;

export default function PMSPage() {
  const { user } = useAuth();
  const { activePropertyId, activeProperty, refreshProperty } = useProperty();
  const { lang } = useLang();

  const [pmsType, setPmsType] = useState(activeProperty?.pmsType ?? '');
  const [pmsUrl, setPmsUrl] = useState(activeProperty?.pmsUrl ?? '');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [testStatus, setTestStatus] = useState<'idle' | 'testing' | 'success' | 'error'>('idle');
  const [testMessage, setTestMessage] = useState('');
  const [saving, setSaving] = useState(false);

  // Onboarding job state — populated when the user clicks "Save & Onboard"
  // and we kick off a CUA mapping/extraction job on the Fly.io worker.
  // The page polls /api/pms/job-status every 3s while a job is in flight
  // and renders a progress widget.
  const [jobId, setJobId] = useState<string | null>(null);
  const [jobStatus, setJobStatus] = useState<{
    status: 'queued' | 'running' | 'mapping' | 'extracting' | 'complete' | 'failed';
    step: string | null;
    progressPct: number;
    error: string | null;
    result: Record<string, unknown> | null;
  } | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Stalled-state tracking (audit Flow 2 #4 + #11). The pre-fix polling
  // loop had no concept of "we've been at the same progress for ages" —
  // a dead Fly worker meant the user stared at the spinner indefinitely
  // with no signal. We now track the last time progress changed; after
  // STALLED_WARN_MS render a banner; after STALLED_STOP_MS bail entirely
  // and log to Sentry. Network failures during polling are tracked
  // separately so we can surface an offline banner without conflating
  // it with "worker is down".
  const STALLED_WARN_MS = 5 * 60 * 1000;   // 5 min — banner
  const STALLED_STOP_MS = 15 * 60 * 1000;  // 15 min — stop + Sentry
  const lastProgressChangeRef = useRef<number>(0);
  const lastProgressPctRef = useRef<number>(-1);
  const [pollState, setPollState] = useState<'polling' | 'stalled-warn' | 'stopped-stalled' | 'stopped-offline'>('polling');
  const [pollNetworkFailures, setPollNetworkFailures] = useState(0);
  const [userStopped, setUserStopped] = useState(false);

  // When the user picks a PMS, prefill the login URL with the registry's
  // default — saves typing for the 95% case where they use the standard
  // login URL. They can still edit it after.
  const handlePmsTypeChange = (value: string) => {
    setPmsType(value);
    const def = PMS_SYSTEMS.find(p => p.value === value);
    if (def?.defaultLoginUrl && !pmsUrl) {
      setPmsUrl(def.defaultLoginUrl);
    }
  };

  // ─── Test Connection ──────────────────────────────────────────────────────
  // "Test" persists the credentials to scraper_credentials so the next click
  // of Save can use them, and confirms the URL is reachable. The actual login
  // attempt happens during the onboarding job (Fly worker, not Vercel).
  const handleTest = async () => {
    if (!pmsType || !pmsUrl || !username || !password) {
      setTestStatus('error');
      setTestMessage(lang === 'es'
        ? 'Por favor completa todos los campos antes de probar.'
        : 'Please fill in all fields before testing.');
      return;
    }
    if (!activePropertyId) {
      setTestStatus('error');
      setTestMessage(lang === 'es' ? 'Propiedad no seleccionada.' : 'No property selected.');
      return;
    }
    setTestStatus('testing');
    setTestMessage('');

    try {
      const res = await fetchWithAuth('/api/pms/save-credentials', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          propertyId: activePropertyId,
          pmsType,
          loginUrl: pmsUrl,
          username,
          password,
        }),
      });
      const json = await res.json();
      if (!res.ok || !json.ok) {
        setTestStatus('error');
        setTestMessage(json.error ?? (lang === 'es'
          ? 'No pudimos guardar tus credenciales.'
          : 'Could not save your credentials.'));
        return;
      }
      const label = PMS_SYSTEMS.find(p => p.value === pmsType)?.label ?? pmsType;
      setTestStatus('success');
      setTestMessage(lang === 'es'
        ? `Credenciales guardadas para ${label}. Haz clic en Guardar para iniciar la sincronización.`
        : `Credentials saved for ${label}. Click Save & Onboard to start the first sync.`);
    } catch (err) {
      setTestStatus('error');
      setTestMessage(lang === 'es'
        ? 'Problema de red. Revisa tu conexión y vuelve a intentar.'
        : 'Network problem. Check your connection and try again.');
    }
  };

  // ─── Save & Onboard ───────────────────────────────────────────────────────
  // Kicks off the full onboarding job (CUA mapping if needed + data
  // extraction) on the Fly worker, then polls /api/pms/job-status until
  // it reaches 'complete' or 'failed'.
  const handleSave = async () => {
    if (!user || !activePropertyId) return;
    if (testStatus !== 'success') {
      setTestStatus('error');
      setTestMessage(lang === 'es'
        ? 'Primero prueba la conexión para guardar tus credenciales.'
        : 'Please Save Credentials first so we can use them.');
      return;
    }
    setSaving(true);

    try {
      // pms_type + pms_url were already stamped atomically by the
      // staxis_upsert_scraper_credentials RPC when handleTest succeeded
      // (see migration 0140, src/app/api/pms/save-credentials/route.ts).
      // We used to call updateProperty() here too, which wrote the same
      // fields via the legacy Firestore-style db.ts path — two stores,
      // no transaction, drift possible if one write failed. Killed in
      // the audit-remaining-findings sweep; the Supabase write is the
      // single source of truth. Just refresh the local state so the
      // header card reflects the new connection.
      await refreshProperty();

      // Queue the onboarding job.
      const res = await fetchWithAuth('/api/pms/onboard', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ propertyId: activePropertyId }),
      });
      const json = await res.json();
      if (!res.ok || !json.ok) {
        setSaving(false);
        setTestStatus('error');
        setTestMessage(json.error ?? (lang === 'es'
          ? 'No pudimos iniciar la sincronización.'
          : 'Could not start the sync.'));
        return;
      }

      setJobId(json.data.jobId);
      setJobStatus({
        status: 'queued',
        step: lang === 'es' ? 'Esperando un trabajador…' : 'Waiting for a worker…',
        progressPct: 0,
        error: null,
        result: null,
      });
      // Polling kicks in via the useEffect below.
    } catch (err) {
      setSaving(false);
      setTestStatus('error');
      setTestMessage(lang === 'es'
        ? 'Error inesperado. Por favor intenta de nuevo.'
        : 'Unexpected error. Please try again.');
    }
  };

  // ─── Job polling ──────────────────────────────────────────────────────────
  useEffect(() => {
    if (!jobId) return;
    let cancelled = false;
    // Reset stalled-state tracking on a new job.
    lastProgressChangeRef.current = Date.now();
    lastProgressPctRef.current = -1;
    setPollState('polling');
    setPollNetworkFailures(0);
    setUserStopped(false);

    const poll = async () => {
      if (cancelled || userStopped) return;
      let madeNetworkProgress = false;
      try {
        const res = await fetchWithAuth(`/api/pms/job-status?id=${jobId}`);
        const raw = await res.json();
        madeNetworkProgress = true;
        if (cancelled) return;
        if (res.ok) {
          // Runtime parser (audit Flow 2 #5): previously this code used
          // `json.data.<field>` with no validation, so a server-side
          // rename (snake_case slip) would freeze the progress bar at 0
          // permanently. parsePmsJobStatusResponse returns a typed value
          // or an error; on parse failure we keep polling but log.
          const parsed = parsePmsJobStatusResponse(raw);
          if (parsed.value) {
            // Stalled-state tracking — when progressPct advances, reset
            // the clock; otherwise let it tick toward the warn / stop
            // thresholds.
            if (parsed.value.progressPct !== lastProgressPctRef.current) {
              lastProgressPctRef.current = parsed.value.progressPct;
              lastProgressChangeRef.current = Date.now();
              setPollState('polling');
            }
            setJobStatus(parsed.value);
            if (parsed.value.status === 'complete' || parsed.value.status === 'failed') {
              setSaving(false);
              await refreshProperty();
              return; // stop polling
            }
          } else {
            console.warn('pms job-status response shape unexpected:', parsed.error);
          }
        }
      } catch {
        // Transient error — keep polling, but track the failure count.
        if (!cancelled) {
          setPollNetworkFailures(n => n + 1);
        }
      }
      if (cancelled) return;

      // Reset failure counter on a successful network call.
      if (madeNetworkProgress) {
        setPollNetworkFailures(0);
      }

      // Stalled-state escalation. Only check while job is in flight (not
      // terminal). The thresholds are wall-clock since the last
      // progressPct change, not since the job started — a job that
      // legitimately progresses slowly (long extraction phase) won't
      // trip the warn as long as the percent ticks at least once every
      // 5 min.
      const stalledMs = Date.now() - lastProgressChangeRef.current;
      if (stalledMs > STALLED_STOP_MS) {
        // Stop polling and report. The job may still complete on the
        // server side — manual refresh recovers — but we won't keep
        // hammering the API forever.
        setPollState('stopped-stalled');
        Sentry.captureMessage('pms-onboard stalled — stopping client poll', {
          level: 'error',
          tags: { surface: 'settings/pms', reason: 'onboard-stalled' },
          extra: {
            jobId,
            propertyId: activePropertyId,
            lastProgressPct: lastProgressPctRef.current,
            stalledSec: Math.round(stalledMs / 1000),
          },
        });
        return;
      }
      if (stalledMs > STALLED_WARN_MS) {
        setPollState('stalled-warn');
      }
      pollTimerRef.current = setTimeout(poll, 3000);
    };

    void poll();
    return () => {
      cancelled = true;
      if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
    };
    // STALLED_WARN_MS / STALLED_STOP_MS are module-level constants.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId, refreshProperty, userStopped]);

  return (
    <AppLayout>
      <div style={{ padding: '16px', maxWidth: '600px', margin: '0 auto' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '24px' }}>
          <Link href="/settings" style={{ color: 'var(--text-muted)', textDecoration: 'none', fontSize: '14px' }}>← {t('settings', lang)}</Link>
          <span style={{ color: 'var(--text-muted)' }}>/</span>
          <h1 style={{ fontFamily: 'var(--font-sans)', fontWeight: 700, fontSize: '16px', letterSpacing: '-0.01em', display: 'flex', alignItems: 'center', gap: '6px' }}>
            <Wifi size={15} color="var(--amber)" /> {lang === 'es' ? 'Conexión PMS' : 'PMS Connection'}
          </h1>
        </div>

        {/* Hero description */}
        <div
          style={{
            padding: '20px',
            background: 'rgba(212,144,64,0.06)',
            border: '1px solid rgba(212,144,64,0.2)',
            borderRadius: '14px',
            marginBottom: '24px',
          }}
        >
          <div style={{ display: 'flex', gap: '12px', marginBottom: '12px' }}>
            <Zap size={20} color="var(--amber)" style={{ flexShrink: 0, marginTop: '2px' }} />
            <div>
              <p style={{ fontWeight: 700, fontSize: '15px', color: 'var(--text-primary)', marginBottom: '6px' }}>
                {lang === 'es' ? 'Extracción automática desde tu PMS' : 'Auto-pull data from your PMS'}
              </p>
              <p style={{ fontSize: '13px', color: 'var(--text-secondary)', lineHeight: 1.6 }}>
                {lang === 'es'
                  ? <>Un agente de IA inicia sesión en tu PMS exactamente como lo haría una persona — navega las pantallas, lee los datos de ocupación y salidas, y los envía directamente a Staxis. <strong style={{ color: 'var(--amber)' }}>Sin entrada manual.</strong></>
                  : <>A Computer Use Agent logs into your PMS exactly like a human would - navigating the screens, reading your occupancy and checkout data, and feeding it directly into Staxis. <strong style={{ color: 'var(--amber)' }}>Zero manual entry.</strong></>}
              </p>
            </div>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            {(lang === 'es' ? [
              'Sincroniza cada 15 minutos durante horas operativas (6 AM – 10 PM)',
              'Sincronización "Bloqueo de Mañana" a las 9 PM — te envía el horario recomendado de mañana',
              'Sincronización de confirmación matutina a las 5:30 AM para cambios nocturnos',
              'Notificación push cuando la ocupación cambia en 5+ habitaciones',
            ] : [
              'Syncs every 15 minutes during operating hours (6 AM – 10 PM)',
              '"Tomorrow Lock" sync at 9 PM - sends you tomorrow\'s recommended schedule',
              'Morning confirmation sync at 5:30 AM for any overnight changes',
              'Push notification when occupancy changes by 5+ rooms',
            ]).map(item => (
              <div key={item} style={{ display: 'flex', gap: '8px', alignItems: 'flex-start' }}>
                <div style={{ width: '5px', height: '5px', borderRadius: '50%', background: 'var(--amber)', marginTop: '6px', flexShrink: 0 }} />
                <p style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>{item}</p>
              </div>
            ))}
          </div>
        </div>

        {/* Connection status */}
        {activeProperty?.pmsConnected && (
          <div
            style={{
              padding: '14px 16px',
              background: 'var(--green-dim)',
              border: '1px solid var(--green-border, rgba(34,197,94,0.25))',
              borderRadius: '10px',
              marginBottom: '20px',
              display: 'flex',
              alignItems: 'center',
              gap: '10px',
            }}
          >
            <CheckCircle size={18} color="var(--green)" />
            <div>
              <p style={{ fontWeight: 600, fontSize: '14px', color: 'var(--green)' }}>{lang === 'es' ? 'Conectado' : 'Connected'}</p>
              <p style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
                {PMS_SYSTEMS.find(p => p.value === activeProperty.pmsType)?.label ?? activeProperty.pmsType}
                {activeProperty.lastSyncedAt && (() => {
                  const ts = activeProperty.lastSyncedAt as any;
                  const d = ts?.toDate ? ts.toDate() : new Date(ts);
                  return isNaN(d.getTime()) ? '' : ` · ${lang === 'es' ? 'Última sinc.' : 'Last synced'} ${d.toLocaleTimeString()}`;
                })()}
              </p>
            </div>
          </div>
        )}

        {/* Form */}
        <div className="card" style={{ padding: '20px', marginBottom: '16px' }}>
          <div style={{ marginBottom: '16px' }}>
            <label className="label">{lang === 'es' ? 'Sistema PMS' : 'PMS System'}</label>
            <select value={pmsType} onChange={e => handlePmsTypeChange(e.target.value)} className="input">
              <option value="">{lang === 'es' ? '- Selecciona tu PMS -' : '- Select your PMS -'}</option>
              {PMS_SYSTEMS.map(pms => (
                <option key={pms.value} value={pms.value}>{pms.label}</option>
              ))}
            </select>
          </div>

          <div style={{ marginBottom: '16px' }}>
            <label className="label">{lang === 'es' ? 'URL de Inicio de Sesión PMS' : 'PMS Login URL'}</label>
            <input
              type="url"
              value={pmsUrl}
              onChange={e => setPmsUrl(e.target.value)}
              className="input"
              placeholder="https://login.choiceadvantage.com"
            />
            <p style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '4px' }}>{lang === 'es' ? 'La URL que usa tu personal para iniciar sesión en el PMS' : 'The URL your staff uses to log in to the PMS'}</p>
          </div>

          <div style={{ marginBottom: '16px' }}>
            <label className="label">{lang === 'es' ? 'Usuario / Email' : 'Username / Email'}</label>
            <input
              type="text"
              value={username}
              onChange={e => setUsername(e.target.value)}
              className="input"
              placeholder={lang === 'es' ? 'tu login del PMS' : 'your PMS login'}
              autoComplete="off"
            />
          </div>

          <div style={{ marginBottom: '4px' }}>
            <label className="label">{lang === 'es' ? 'Contraseña' : 'Password'}</label>
            <input
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              className="input"
              placeholder="••••••••"
              autoComplete="new-password"
            />
          </div>

          {/* Security note */}
          <div style={{ display: 'flex', gap: '8px', padding: '10px 12px', background: 'rgba(0,0,0,0.03)', borderRadius: '8px', marginTop: '12px' }}>
            <Shield size={14} color="var(--text-muted)" style={{ flexShrink: 0, marginTop: '1px' }} />
            <p style={{ fontSize: '12px', color: 'var(--text-muted)', lineHeight: 1.5 }}>
              {lang === 'es'
                ? 'Tus credenciales se encriptan y almacenan de forma segura en Supabase. Solo las usa el agente de sincronización de Staxis para leer datos de ocupación — nunca se comparten ni se venden.'
                : 'Your credentials are encrypted and stored securely in Supabase. They are only used by the Staxis sync agent to read occupancy data - never shared or sold.'}
            </p>
          </div>
        </div>

        {/* Test result */}
        {testStatus !== 'idle' && testStatus !== 'testing' && (
          <div
            style={{
              padding: '14px 16px',
              background: testStatus === 'success' ? 'var(--green-dim)' : 'var(--red-dim)',
              border: `1px solid ${testStatus === 'success' ? 'var(--green-border, rgba(34,197,94,0.25))' : 'var(--red-border, rgba(239,68,68,0.25))'}`,
              borderRadius: '10px',
              marginBottom: '14px',
              display: 'flex',
              gap: '10px',
              alignItems: 'flex-start',
            }}
          >
            {testStatus === 'success' ? <CheckCircle size={16} color="var(--green)" style={{ flexShrink: 0, marginTop: '1px' }} /> : <AlertCircle size={16} color="var(--red)" style={{ flexShrink: 0, marginTop: '1px' }} />}
            <p style={{ fontSize: '13px', color: testStatus === 'success' ? 'var(--green)' : 'var(--red)', lineHeight: 1.5 }}>
              {testMessage}
            </p>
          </div>
        )}

        <div style={{ display: 'flex', gap: '10px' }}>
          <button
            onClick={handleTest}
            disabled={testStatus === 'testing' || saving}
            className="btn btn-secondary"
            style={{ flex: 1, justifyContent: 'center' }}
          >
            {testStatus === 'testing' ? (
              <>
                <div style={{ width: '16px', height: '16px', border: '2px solid rgba(255,255,255,0.2)', borderTopColor: 'white', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
                {lang === 'es' ? 'Guardando…' : 'Saving…'}
              </>
            ) : (
              <><Wifi size={16} /> {lang === 'es' ? 'Guardar Credenciales' : 'Save Credentials'}</>
            )}
          </button>
          <button
            onClick={handleSave}
            disabled={saving || !pmsType || testStatus !== 'success'}
            className="btn btn-primary"
            style={{ flex: 1, justifyContent: 'center' }}
          >
            {saving
              ? (lang === 'es' ? 'Sincronizando…' : 'Onboarding…')
              : (lang === 'es' ? 'Guardar y Sincronizar' : 'Save & Onboard')}
          </button>
        </div>

        {/* Onboarding job progress — shown only while a job is in flight or
            just completed. Polls /api/pms/job-status every 3s. */}
        {jobStatus && (
          <div
            style={{
              marginTop: '16px',
              padding: '16px',
              background: jobStatus.status === 'failed'
                ? 'var(--red-dim)'
                : jobStatus.status === 'complete'
                  ? 'var(--green-dim)'
                  : 'rgba(212,144,64,0.06)',
              border: `1px solid ${jobStatus.status === 'failed'
                ? 'var(--red-border, rgba(239,68,68,0.25))'
                : jobStatus.status === 'complete'
                  ? 'var(--green-border, rgba(34,197,94,0.25))'
                  : 'rgba(212,144,64,0.2)'}`,
              borderRadius: '12px',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '10px' }}>
              {jobStatus.status === 'complete' ? (
                <CheckCircle size={18} color="var(--green)" />
              ) : jobStatus.status === 'failed' ? (
                <AlertCircle size={18} color="var(--red)" />
              ) : (
                <Loader2 size={18} color="var(--amber)" style={{ animation: 'spin 1.2s linear infinite' }} />
              )}
              <p style={{
                fontWeight: 600,
                fontSize: '14px',
                color: jobStatus.status === 'failed' ? 'var(--red)'
                     : jobStatus.status === 'complete' ? 'var(--green)'
                     : 'var(--text-primary)',
              }}>
                {jobStatus.status === 'complete'
                  ? (lang === 'es' ? '¡Sincronización completa!' : 'Onboarding complete!')
                  : jobStatus.status === 'failed'
                    ? (lang === 'es' ? 'Sincronización falló' : 'Onboarding failed')
                    : (jobStatus.step ?? (lang === 'es' ? 'Trabajando…' : 'Working…'))}
              </p>
            </div>

            {/* Progress bar — hidden once complete or failed */}
            {jobStatus.status !== 'complete' && jobStatus.status !== 'failed' && (
              <div style={{
                width: '100%',
                height: '6px',
                background: 'rgba(0,0,0,0.08)',
                borderRadius: '3px',
                overflow: 'hidden',
                marginBottom: '8px',
              }}>
                <div style={{
                  width: `${Math.max(5, jobStatus.progressPct)}%`,
                  height: '100%',
                  background: 'var(--amber)',
                  transition: 'width 0.3s ease',
                }} />
              </div>
            )}

            {/* Stalled-state banner — appears when the sync worker hasn't
                advanced progress in 5 min. Distinct from "failed" because
                the job COULD still complete; we just don't have a recent
                signal. Audit Flow 2 #4. */}
            {pollState === 'stalled-warn' && jobStatus.status !== 'complete' && jobStatus.status !== 'failed' && (
              <p style={{
                fontSize: '13px',
                color: 'var(--amber)',
                lineHeight: 1.5,
                marginBottom: '8px',
              }}>
                {lang === 'es'
                  ? 'Esto está tardando más de lo normal. El trabajador puede estar ocupado — espera unos minutos o detén el sondeo para volver a intentarlo más tarde.'
                  : 'This is taking longer than expected. The sync worker may be busy — wait a few more minutes or stop polling and try again later.'}
                {' '}
                <button
                  type="button"
                  onClick={() => setUserStopped(true)}
                  style={{
                    background: 'none', border: 'none', padding: 0, marginLeft: '4px',
                    color: 'var(--amber)', textDecoration: 'underline', cursor: 'pointer',
                    fontSize: '13px',
                  }}
                >
                  {lang === 'es' ? 'Detener' : 'Stop'}
                </button>
              </p>
            )}

            {/* Hard stop after STALLED_STOP_MS — also fires when the user
                clicks Stop above. Polling has been halted; refresh to
                retry. Sentry already received the stalled event. */}
            {(pollState === 'stopped-stalled' || (userStopped && jobStatus.status !== 'complete' && jobStatus.status !== 'failed')) && (
              <p style={{
                fontSize: '13px',
                color: 'var(--red)',
                lineHeight: 1.5,
                marginBottom: '8px',
              }}>
                {lang === 'es'
                  ? 'Detuvimos el sondeo. Recarga la página para reintentar; la sincronización puede haber completado en segundo plano.'
                  : 'We stopped polling. Refresh the page to retry — the sync may have completed in the background.'}
              </p>
            )}

            {/* Network failure offline banner — surfaces 3+ consecutive
                poll failures. navigator.onLine isn't perfect but it
                catches the common case (wifi dropped). Audit Flow 2 #11. */}
            {pollNetworkFailures >= 3 && pollState !== 'stopped-stalled' && jobStatus.status !== 'complete' && jobStatus.status !== 'failed' && (
              <p style={{
                fontSize: '13px',
                color: 'var(--text-muted)',
                lineHeight: 1.5,
                marginBottom: '8px',
              }}>
                <WifiOff size={12} style={{ verticalAlign: 'middle', marginRight: '4px' }} />
                {lang === 'es'
                  ? `Sin conexión (${pollNetworkFailures} intentos fallidos). El sondeo continúa cuando vuelvas en línea.`
                  : `Offline (${pollNetworkFailures} failed polls). Polling will resume when you reconnect.`}
              </p>
            )}

            {jobStatus.status === 'failed' && jobStatus.error && (
              <p style={{ fontSize: '13px', color: 'var(--red)', lineHeight: 1.5 }}>
                {jobStatus.error}
              </p>
            )}

            {jobStatus.status === 'complete' && jobStatus.result && (
              <div style={{ fontSize: '13px', color: 'var(--text-secondary)', lineHeight: 1.6 }}>
                {(() => {
                  // Runtime parser (audit Flow 2 #10): previously
                  // `(r.rooms_count as number) ?? 0` silently displayed
                  // "0 rooms" if the field name changed or was absent.
                  // parsePmsOnboardResult separates "0 rooms found"
                  // (legitimate but rare) from "the server sent us
                  // something we don't recognise."
                  const parsed = parsePmsOnboardResult(jobStatus.result);
                  if (!parsed.value) {
                    return lang === 'es'
                      ? 'Conectamos correctamente, pero no pudimos leer el resumen final. Revisa tu panel.'
                      : 'We connected successfully, but couldn’t read the final summary. Check your dashboard.';
                  }
                  const { rooms_count: rooms, staff_count: staff } = parsed.value;
                  return lang === 'es'
                    ? `Encontramos ${rooms} habitaciones y ${staff} miembros del personal. Tu panel está listo.`
                    : `We found ${rooms} rooms and ${staff} staff members. Your dashboard is ready.`;
                })()}
              </div>
            )}
          </div>
        )}

        {/* CUA architecture note */}
        <div style={{ marginTop: '24px', padding: '16px', background: 'rgba(0,0,0,0.02)', border: '1px solid var(--border)', borderRadius: '12px' }}>
          <p style={{ fontSize: '12px', fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-muted)', marginBottom: '8px' }}>
            {lang === 'es' ? 'Cómo Funciona' : 'How It Works'}
          </p>
          {(lang === 'es' ? [
            { step: '1', text: 'Un navegador abre tu PMS en el horario de sincronización programado' },
            { step: '2', text: 'El agente inicia sesión con tus credenciales guardadas' },
            { step: '3', text: 'Navega a la pantalla de ocupación/reservaciones y lee los datos' },
            { step: '4', text: 'Los datos extraídos (habitaciones ocupadas, salidas, llegadas) se guardan en Staxis' },
            { step: '5', text: 'Si los números cambian significativamente, recibes una notificación push' },
          ] : [
            { step: '1', text: 'A headless browser opens your PMS at the scheduled sync time' },
            { step: '2', text: 'The agent logs in with your saved credentials' },
            { step: '3', text: 'It navigates to the occupancy/reservations screen and reads the data' },
            { step: '4', text: 'Extracted data (rooms occupied, checkouts, check-ins) is saved to Staxis' },
            { step: '5', text: 'If numbers changed significantly, you get a push notification' },
          ]).map(({ step, text }) => (
            <div key={step} style={{ display: 'flex', gap: '10px', marginBottom: '8px', alignItems: 'flex-start' }}>
              <div style={{ width: '20px', height: '20px', borderRadius: '50%', background: 'rgba(212,144,64,0.15)', color: 'var(--amber)', fontSize: '11px', fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                {step}
              </div>
              <p style={{ fontSize: '13px', color: 'var(--text-secondary)', lineHeight: 1.5 }}>{text}</p>
            </div>
          ))}
          <p style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '8px', borderTop: '1px solid var(--border)', paddingTop: '10px' }}>
            {lang === 'es'
              ? 'Actualmente soporta Choice Advantage con automatización completa. Otros sistemas usan captura de pantalla + OCR como respaldo.'
              : 'Currently supports Choice Advantage with full automation. Other systems use screenshot + OCR fallback.'}
          </p>
        </div>
        <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
      </div>
    </AppLayout>
  );
}
