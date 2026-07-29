'use client';


export const dynamic = 'force-dynamic';
import React, { useState, useCallback, useEffect, useRef } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { useProperty } from '@/contexts/PropertyContext';
import { AppLayout } from '@/components/layout/AppLayout';
import { useLang } from '@/contexts/LanguageContext';
import { useCan } from '@/lib/capabilities/useCan';
import { t } from '@/lib/translations';
import { fetchWithAuth, INTERACTIVE_ACTION_TIMEOUT_MS } from '@/lib/api-fetch';
import { parsePmsOnboardResult } from '@/lib/api-validate';
import { PMS_DROPDOWN_OPTIONS } from '@/lib/pms';
import { Wifi, WifiOff, Shield, Zap, AlertCircle, CheckCircle, Loader2 } from 'lucide-react';
import Link from 'next/link';
import { usePmsOnboardJob } from './use-pms-onboard-job';

// PMS dropdown options come from the registry (src/lib/pms/registry.ts).
// Adding a new PMS is a one-line change there — keeps the dropdown,
// the type system, and the DB constraint in sync.
const PMS_SYSTEMS = PMS_DROPDOWN_OPTIONS.map((d) => ({
  value: d.id,
  label: `${d.label}${d.hint ? ` (${d.hint})` : ''}`,
  defaultLoginUrl: d.defaultLoginUrl,
}));

export default function PMSPage() {
  const { user } = useAuth();
  const { activePropertyId } = useProperty();
  const scopeKey = `${user?.uid ?? 'signed-out'}:${activePropertyId ?? 'no-property'}`;

  return (
    <PMSPropertyEditor
      key={scopeKey}
      scopeKey={scopeKey}
      propertyId={activePropertyId ?? null}
    />
  );
}

function PMSPropertyEditor({
  scopeKey,
  propertyId,
}: {
  scopeKey: string;
  propertyId: string | null;
}) {
  const { user } = useAuth();
  const { activeProperty, refreshProperty } = useProperty();
  const { lang } = useLang();
  const can = useCan();

  const scopedProperty = activeProperty?.id === propertyId ? activeProperty : null;
  const [pmsType, setPmsType] = useState(scopedProperty?.pmsType ?? '');
  const [pmsUrl, setPmsUrl] = useState(scopedProperty?.pmsUrl ?? '');

  // On a hard page load (refresh/bookmark) the property context resolves
  // AFTER first mount, so the useState initializers above ran with
  // activeProperty === null and the form rendered blank under a green
  // "Connected" banner. Re-seed once per property when it resolves — but
  // never clobber text the user has already typed.
  const seededPropertyRef = useRef<string | null>(scopedProperty?.id ?? null);
  useEffect(() => {
    if (!propertyId || activeProperty?.id !== propertyId || seededPropertyRef.current === propertyId) return;
    seededPropertyRef.current = propertyId;
    setPmsType(activeProperty.pmsType ?? '');
    setPmsUrl(activeProperty.pmsUrl ?? '');
  }, [activeProperty, propertyId]);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [testStatus, setTestStatus] = useState<'idle' | 'testing' | 'success' | 'error'>('idle');
  const [testMessage, setTestMessage] = useState('');
  const [saving, setSaving] = useState(false);
  const activeScopeRef = useRef<string | null>(scopeKey);
  const testAttemptRef = useRef(0);
  const saveAttemptRef = useRef(0);
  useEffect(() => {
    activeScopeRef.current = scopeKey;
    return () => {
      activeScopeRef.current = null;
      testAttemptRef.current += 1;
      saveAttemptRef.current += 1;
    };
  }, [scopeKey]);
  const ownsScope = useCallback(
    () => activeScopeRef.current === scopeKey,
    [scopeKey],
  );

  // Onboarding job state machine — populated when the user clicks
  // "Save & Onboard" and we kick off a CUA mapping/extraction job on the
  // Fly.io worker. The hook polls /api/pms/job-status every 3s while a job
  // is in flight (stalled-state tracking + offline counter + Sentry report
  // — see use-pms-onboard-job.ts); this page renders the progress widget.
  const { jobStatus, pollState, pollNetworkFailures, userStopped, start: startOnboardJob, stop: stopOnboardPolling } = usePmsOnboardJob({
    propertyId,
    onFinished: useCallback(async () => {
      if (!ownsScope()) return;
      setSaving(false);
      await refreshProperty();
    }, [ownsScope, refreshProperty]),
  });

  const invalidateTest = useCallback(() => {
    testAttemptRef.current += 1;
    setTestStatus('idle');
    setTestMessage('');
  }, []);

  // When the user picks a PMS, prefill the login URL with the registry's
  // default — saves typing for the 95% case where they use the standard
  // login URL. They can still edit it after.
  const handlePmsTypeChange = (value: string) => {
    invalidateTest();
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
      setTestMessage('Please fill in all fields before testing.');
      return;
    }
    if (!propertyId) {
      setTestStatus('error');
      setTestMessage('No property selected.');
      return;
    }
    const requestedPropertyId = propertyId;
    const requestedCredentials = {
      pmsType,
      loginUrl: pmsUrl,
      username,
      password,
    };
    const attempt = ++testAttemptRef.current;
    const ownsAttempt = () => ownsScope() && testAttemptRef.current === attempt;
    setTestStatus('testing');
    setTestMessage('');

    try {
      const res = await fetchWithAuth('/api/pms/save-credentials', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          propertyId: requestedPropertyId,
          ...requestedCredentials,
        }),
        timeoutMs: INTERACTIVE_ACTION_TIMEOUT_MS,
      });
      const json = await res.json();
      if (!ownsAttempt()) return;
      if (!res.ok || !json.ok) {
        setTestStatus('error');
        setTestMessage(json.error ?? ('Could not save your credentials.'));
        return;
      }
      const label = PMS_SYSTEMS.find(p => p.value === requestedCredentials.pmsType)?.label ?? requestedCredentials.pmsType;
      setTestStatus('success');
      setTestMessage(`Credentials saved for ${label}. Click Save & Onboard to start the first sync.`);
    } catch {
      if (!ownsAttempt()) return;
      setTestStatus('error');
      setTestMessage('Network problem. Check your connection and try again.');
    }
  };

  // ─── Save & Onboard ───────────────────────────────────────────────────────
  // Kicks off the full onboarding job (CUA mapping if needed + data
  // extraction) on the Fly worker, then polls /api/pms/job-status until
  // it reaches 'complete' or 'failed'.
  const handleSave = async () => {
    if (!user || !propertyId) return;
    if (testStatus !== 'success') {
      setTestStatus('error');
      setTestMessage('Please Save Credentials first so we can use them.');
      return;
    }
    const requestedPropertyId = propertyId;
    const attempt = ++saveAttemptRef.current;
    const ownsAttempt = () => ownsScope() && saveAttemptRef.current === attempt;
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
      if (!ownsAttempt()) return;

      // Queue the onboarding job.
      const res = await fetchWithAuth('/api/pms/onboard', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ propertyId: requestedPropertyId }),
        timeoutMs: INTERACTIVE_ACTION_TIMEOUT_MS,
      });
      const json = await res.json();
      if (!ownsAttempt()) return;
      if (!res.ok || !json.ok) {
        setSaving(false);
        setTestStatus('error');
        setTestMessage(json.error ?? ('Could not start the sync.'));
        return;
      }

      startOnboardJob(json.data.jobId, {
        status: 'queued',
        step: 'Waiting for a worker…',
        progressPct: 0,
        error: null,
        result: null,
      });
    } catch {
      if (!ownsAttempt()) return;
      setSaving(false);
      setTestStatus('error');
      setTestMessage('Unexpected error. Please try again.');
    }
  };

  // ─── Access gate ──────────────────────────────────────────────────────────
  // The PMS connection holds the hotel's PMS login credentials and drives the
  // CUA sync — manager-tier only (manage_settings is a MANAGER_FLOOR capability:
  // owner / GM / admin). Line staff who deep-link here see a clean "manager
  // access only" notice instead of the credentials form. The underlying write
  // routes (save-credentials / onboard / job-status) are additionally
  // owner-locked server-side, so this gate is the UI half of that lock.
  if (!user || !can('manage_settings')) {
    return (
      <AppLayout>
        <div style={{ padding: 24, maxWidth: 520, margin: '40px auto', textAlign: 'center' }}>
          <Wifi size={28} color="var(--text-muted)" style={{ marginBottom: 12 }} />
          <h1 style={{ fontFamily: 'var(--font-sans)', fontWeight: 700, fontSize: 20, marginBottom: 12 }}>
            {'You don’t have access'}
          </h1>
          <p style={{ fontSize: 14, color: 'var(--text-secondary)', lineHeight: 1.6, marginBottom: 20 }}>
            {'The PMS connection is restricted to managers, owners, and admins.'}
          </p>
          <Link href="/settings" style={{ color: 'var(--amber)', textDecoration: 'none', fontSize: 14, fontWeight: 600 }}>
            ← {t('settings', lang)}
          </Link>
        </div>
      </AppLayout>
    );
  }

  return (
    <AppLayout>
      <div style={{ padding: '16px', maxWidth: '600px', margin: '0 auto' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '24px' }}>
          <Link href="/settings" style={{ color: 'var(--text-muted)', textDecoration: 'none', fontSize: '14px' }}>← {t('settings', lang)}</Link>
          <span style={{ color: 'var(--text-muted)' }}>/</span>
          <h1 style={{ fontFamily: 'var(--font-sans)', fontWeight: 700, fontSize: '16px', letterSpacing: '-0.01em', display: 'flex', alignItems: 'center', gap: '6px' }}>
            <Wifi size={15} color="var(--amber)" /> {'PMS Connection'}
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
                {'Auto-pull data from your PMS'}
              </p>
              <p style={{ fontSize: '13px', color: 'var(--text-secondary)', lineHeight: 1.6 }}>
                {<>A Computer Use Agent logs into your PMS exactly like a human would - navigating the screens, reading your occupancy and checkout data, and feeding it directly into Staxis. <strong style={{ color: 'var(--amber)' }}>Zero manual entry.</strong></>}
              </p>
            </div>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            {([
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
        {scopedProperty?.pmsConnected && (
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
              <p style={{ fontWeight: 600, fontSize: '14px', color: 'var(--green)' }}>{'Connected'}</p>
              <p style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
                {PMS_SYSTEMS.find(p => p.value === scopedProperty.pmsType)?.label ?? scopedProperty.pmsType}
                {scopedProperty.lastSyncedAt && (() => {
                  const ts = scopedProperty.lastSyncedAt as any;
                  const d = ts?.toDate ? ts.toDate() : new Date(ts);
                  return isNaN(d.getTime()) ? '' : ` · ${'Last synced'} ${d.toLocaleTimeString()}`;
                })()}
              </p>
            </div>
          </div>
        )}

        {/* Form */}
        <div className="card" style={{ padding: '20px', marginBottom: '16px' }}>
          <div style={{ marginBottom: '16px' }}>
            <label className="label">{'PMS System'}</label>
            <select value={pmsType} onChange={e => handlePmsTypeChange(e.target.value)} className="input">
              <option value="">{'- Select your PMS -'}</option>
              {PMS_SYSTEMS.map(pms => (
                <option key={pms.value} value={pms.value}>{pms.label}</option>
              ))}
            </select>
          </div>

          <div style={{ marginBottom: '16px' }}>
            <label className="label">{'PMS Login URL'}</label>
            <input
              type="url"
              value={pmsUrl}
              onChange={e => {
                invalidateTest();
                setPmsUrl(e.target.value);
              }}
              className="input"
              placeholder="https://login.choiceadvantage.com"
            />
            <p style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '4px' }}>{'The URL your staff uses to log in to the PMS'}</p>
          </div>

          <div style={{ marginBottom: '16px' }}>
            <label className="label">{'Username / Email'}</label>
            <input
              type="text"
              value={username}
              onChange={e => {
                invalidateTest();
                setUsername(e.target.value);
              }}
              className="input"
              placeholder={'your PMS login'}
              autoComplete="off"
            />
          </div>

          <div style={{ marginBottom: '4px' }}>
            <label className="label">{'Password'}</label>
            <input
              type="password"
              value={password}
              onChange={e => {
                invalidateTest();
                setPassword(e.target.value);
              }}
              className="input"
              placeholder="••••••••"
              autoComplete="new-password"
            />
          </div>

          {/* Security note */}
          <div style={{ display: 'flex', gap: '8px', padding: '10px 12px', background: 'rgba(0,0,0,0.03)', borderRadius: '8px', marginTop: '12px' }}>
            <Shield size={14} color="var(--text-muted)" style={{ flexShrink: 0, marginTop: '1px' }} />
            <p style={{ fontSize: '12px', color: 'var(--text-muted)', lineHeight: 1.5 }}>
              {'Your credentials are encrypted and stored securely in Supabase. They are only used by the Staxis sync agent to read occupancy data - never shared or sold.'}
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
                {'Saving…'}
              </>
            ) : (
              <><Wifi size={16} /> {'Save Credentials'}</>
            )}
          </button>
          <button
            onClick={handleSave}
            disabled={saving || !pmsType || testStatus !== 'success'}
            className="btn btn-primary"
            style={{ flex: 1, justifyContent: 'center' }}
          >
            {saving
              ? ('Onboarding…')
              : ('Save & Onboard')}
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
                  ? ('Onboarding complete!')
                  : jobStatus.status === 'failed'
                    ? ('Onboarding failed')
                    : (jobStatus.step ?? ('Working…'))}
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
            {pollState === 'stalled-warn' && !userStopped && jobStatus.status !== 'complete' && jobStatus.status !== 'failed' && (
              <p style={{
                fontSize: '13px',
                color: 'var(--amber)',
                lineHeight: 1.5,
                marginBottom: '8px',
              }}>
                {'This is taking longer than expected. The sync worker may be busy. Wait a few more minutes or stop polling and try again later.'}
                {' '}
                <button
                  type="button"
                  onClick={stopOnboardPolling}
                  style={{
                    background: 'none', border: 'none', padding: 0, marginLeft: '4px',
                    color: 'var(--amber)', textDecoration: 'underline', cursor: 'pointer',
                    fontSize: '13px',
                  }}
                >
                  {'Stop'}
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
                {'We stopped polling. Refresh the page to retry; the sync may have completed in the background.'}
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
                {`Offline (${pollNetworkFailures} failed polls). Polling will resume when you reconnect.`}
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
                    return 'We connected successfully, but couldn’t read the final summary. Check your dashboard.';
                  }
                  const { rooms_count: rooms, staff_count: staff } = parsed.value;
                  return `We found ${rooms} rooms and ${staff} staff members. Your dashboard is ready.`;
                })()}
              </div>
            )}
          </div>
        )}

        {/* CUA architecture note */}
        <div style={{ marginTop: '24px', padding: '16px', background: 'rgba(0,0,0,0.02)', border: '1px solid var(--border)', borderRadius: '12px' }}>
          <p style={{ fontSize: '12px', fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-muted)', marginBottom: '8px' }}>
            {'How It Works'}
          </p>
          {([
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
            {'Currently supports Choice Advantage with full automation. Other systems use screenshot + OCR fallback.'}
          </p>
        </div>
        <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
      </div>
    </AppLayout>
  );
}
