'use client';

// Company-level invitations are deliberately kept separate from the selected
// hotel's roster dialog. A company invite answers three questions: who is
// invited, what company job they get, and which hotels that job reaches.

import React from 'react';
import { UserPlus } from 'lucide-react';

import { fetchWithAuth } from '@/lib/api-fetch';

interface CompanyInviteJob {
  value: string;
  scope: 'company' | 'property';
  label: { en: string };
  allowedPropertyIds: string[];
}

interface CompanyInviteOptions {
  organizationId?: string | null;
  jobs: CompanyInviteJob[];
  hotels: Array<{ id: string; name: string }>;
  allowsAllIncludingFuture?: boolean;
}

interface PendingCompanyInvite {
  id: string;
  email: string;
  role: string;
  status: string;
  isExpired: boolean;
  propertyNames: string[];
  coversAllIncludingFuture?: boolean;
  canRevoke: boolean;
}

interface InviteListing {
  invites?: PendingCompanyInvite[];
  options?: CompanyInviteOptions;
}

const NO_OPTIONS: CompanyInviteOptions = {
  organizationId: null,
  jobs: [],
  hotels: [],
  allowsAllIncludingFuture: false,
};

function describeReach(invite: PendingCompanyInvite): string {
  if (invite.coversAllIncludingFuture) return 'Every hotel, including ones added later';
  if (invite.propertyNames.length === 0) return 'No hotels';
  if (invite.propertyNames.length <= 2) return invite.propertyNames.join(' and ');
  return `${invite.propertyNames[0]} and ${invite.propertyNames.length - 1} more`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isCompanyInviteOptions(value: unknown): value is CompanyInviteOptions {
  if (!isRecord(value) || !Array.isArray(value.jobs) || !Array.isArray(value.hotels)) return false;
  if (typeof value.organizationId !== 'string') return false;
  const jobsValid = value.jobs.every((job) => {
    if (!isRecord(job) || typeof job.value !== 'string') return false;
    if (job.scope !== 'company' && job.scope !== 'property') return false;
    if (!isRecord(job.label) || typeof job.label.en !== 'string') return false;
    return Array.isArray(job.allowedPropertyIds)
      && job.allowedPropertyIds.every((id) => typeof id === 'string');
  });
  const hotelsValid = value.hotels.every((hotel) => (
    isRecord(hotel)
    && typeof hotel.id === 'string'
    && typeof hotel.name === 'string'
  ));
  return jobsValid && hotelsValid;
}

function isPendingCompanyInvite(value: unknown): value is PendingCompanyInvite {
  return isRecord(value)
    && typeof value.id === 'string'
    && typeof value.email === 'string'
    && typeof value.role === 'string'
    && typeof value.status === 'string'
    && typeof value.isExpired === 'boolean'
    && Array.isArray(value.propertyNames)
    && value.propertyNames.every((name) => typeof name === 'string')
    && typeof value.canRevoke === 'boolean'
    && (value.coversAllIncludingFuture === undefined
      || typeof value.coversAllIncludingFuture === 'boolean');
}

function mutationSignal(): AbortSignal {
  return AbortSignal.timeout(15_000);
}

export default function CompanyInvitePanel({
  organizationId,
  styles,
}: {
  organizationId: string;
  styles: Record<string, string>;
}) {
  const [options, setOptions] = React.useState<CompanyInviteOptions>(NO_OPTIONS);
  const [invites, setInvites] = React.useState<PendingCompanyInvite[]>([]);
  const [loadState, setLoadState] = React.useState<'loading' | 'ready' | 'error'>('loading');
  const [loadedOrganizationId, setLoadedOrganizationId] = React.useState<string | null>(null);
  const [loadError, setLoadError] = React.useState('');
  const [open, setOpen] = React.useState(false);
  const [email, setEmail] = React.useState('');
  const [job, setJob] = React.useState('');
  const [allHotels, setAllHotels] = React.useState(true);
  const [hotelIds, setHotelIds] = React.useState<string[]>([]);
  const [busy, setBusy] = React.useState(false);
  const [revokingInviteId, setRevokingInviteId] = React.useState<string | null>(null);
  const [confirmingInviteId, setConfirmingInviteId] = React.useState<string | null>(null);
  const [error, setError] = React.useState('');
  const [revokeError, setRevokeError] = React.useState('');
  const [sentTo, setSentTo] = React.useState('');

  const loadAbortRef = React.useRef<AbortController | null>(null);
  const loadSequenceRef = React.useRef(0);
  const organizationGenerationRef = React.useRef(0);
  const activeOrganizationRef = React.useRef(organizationId);
  const confirmButtonRef = React.useRef<HTMLButtonElement | null>(null);

  const clearOrganizationState = React.useCallback(() => {
    loadAbortRef.current?.abort();
    loadAbortRef.current = null;
    loadSequenceRef.current += 1;
    setOptions(NO_OPTIONS);
    setInvites([]);
    setLoadedOrganizationId(null);
    setLoadState('loading');
    setLoadError('');
    setOpen(false);
    setEmail('');
    setJob('');
    setAllHotels(true);
    setHotelIds([]);
    setBusy(false);
    setRevokingInviteId(null);
    setConfirmingInviteId(null);
    setError('');
    setRevokeError('');
    setSentTo('');
  }, []);

  const load = React.useCallback(async () => {
    const expectedOrganizationId = organizationId;
    const expectedGeneration = organizationGenerationRef.current;
    const sequence = ++loadSequenceRef.current;
    loadAbortRef.current?.abort();
    const controller = new AbortController();
    loadAbortRef.current = controller;
    setLoadState('loading');
    setLoadedOrganizationId(null);
    setOptions(NO_OPTIONS);
    setInvites([]);
    setOpen(false);
    setConfirmingInviteId(null);
    setLoadError('');
    setError('');
    setRevokeError('');

    const isCurrent = () => (
      !controller.signal.aborted
      && sequence === loadSequenceRef.current
      && expectedGeneration === organizationGenerationRef.current
      && activeOrganizationRef.current === expectedOrganizationId
    );

    try {
      const response = await fetchWithAuth(
        `/api/auth/invites?organizationId=${encodeURIComponent(expectedOrganizationId)}`,
        { cache: 'no-store', signal: controller.signal, timeoutMs: 10_000 },
      );
      const body = await response.json().catch(() => ({})) as {
        ok?: boolean;
        data?: InviteListing;
        error?: string;
      };
      if (!isCurrent()) return;
      if (
        !response.ok
        || body.ok !== true
        || !isRecord(body.data)
        || !isCompanyInviteOptions(body.data.options)
        || body.data.options.organizationId !== expectedOrganizationId
        || !Array.isArray(body.data.invites)
        || !body.data.invites.every(isPendingCompanyInvite)
      ) {
        throw new Error(body.error || 'Company invitations are unavailable right now.');
      }
      setOptions(body.data.options);
      setInvites(body.data.invites);
      setLoadedOrganizationId(expectedOrganizationId);
      setLoadState('ready');
    } catch (caught) {
      if (!isCurrent()) return;
      setOptions(NO_OPTIONS);
      setInvites([]);
      setLoadedOrganizationId(null);
      setOpen(false);
      setConfirmingInviteId(null);
      if (controller.signal.aborted) return;
      setLoadState('error');
      setLoadError(caught instanceof Error && caught.message
        ? caught.message
        : 'Company invitations are unavailable right now.');
    } finally {
      if (loadAbortRef.current === controller) loadAbortRef.current = null;
    }
  }, [organizationId]);

  React.useEffect(() => {
    activeOrganizationRef.current = organizationId;
    organizationGenerationRef.current += 1;
    clearOrganizationState();
    void load();
    return () => {
      loadAbortRef.current?.abort();
      loadAbortRef.current = null;
      loadSequenceRef.current += 1;
    };
  }, [clearOrganizationState, load, organizationId]);

  React.useEffect(() => {
    if (!confirmingInviteId) return;
    confirmButtonRef.current?.focus();
  }, [confirmingInviteId]);

  const loadedForCurrentOrganization = (
    loadState === 'ready' && loadedOrganizationId === organizationId
  );
  const companyJobs = loadedForCurrentOrganization
    ? options.jobs.filter((entry) => entry.scope === 'company')
    : [];
  const selectedJob = companyJobs.find((entry) => entry.value === job) ?? companyJobs[0] ?? null;
  const canOfferAll = loadedForCurrentOrganization && options.allowsAllIncludingFuture === true;
  const coverageIsAll = canOfferAll && allHotels;
  const allowedHotels = selectedJob
    ? options.hotels.filter((hotel) => selectedJob.allowedPropertyIds.includes(hotel.id))
    : [];
  const visibleInvites = loadedForCurrentOrganization ? invites : [];

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError('');
    if (!loadedForCurrentOrganization || !selectedJob) {
      setError('Company roles are still loading. Reload and try again.');
      return;
    }
    if (!email.trim()) {
      setError('Enter an email address.');
      return;
    }

    // Explicit coverage must anchor the invitation inside the exact subset
    // the caller chose. Using the first offered hotel here can silently turn a
    // subset invitation into a different hotel-scoped authority.
    const chosen = hotelIds.filter((id) => (
      selectedJob.allowedPropertyIds.includes(id)
      && allowedHotels.some((hotel) => hotel.id === id)
    ));
    if (!coverageIsAll && chosen.length === 0) {
      setError('Choose at least one hotel.');
      return;
    }
    const anchor = coverageIsAll ? allowedHotels[0]?.id : chosen[0];
    if (!anchor) {
      setError('Your hotel access changed. Reload and try again.');
      return;
    }

    const expectedOrganizationId = organizationId;
    const expectedGeneration = organizationGenerationRef.current;
    setBusy(true);
    try {
      const response = await fetchWithAuth('/api/auth/invites', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: mutationSignal(),
        body: JSON.stringify({
          hotelId: anchor,
          email: email.trim(),
          role: selectedJob.value,
          scope: 'company',
          // Omitting the list means “including hotels added later”. Only omit
          // it when the caller explicitly chose that coverage.
          ...(coverageIsAll ? {} : { propertyIds: chosen }),
        }),
      });
      const body = await response.json().catch(() => ({})) as { ok?: boolean; error?: string };
      const stillCurrent = (
        expectedOrganizationId === activeOrganizationRef.current
        && expectedGeneration === organizationGenerationRef.current
      );
      if (!stillCurrent) return;
      if (!response.ok || body.ok !== true) {
        setError(body.error ?? 'Could not send that invitation.');
        setBusy(false);
        return;
      }
      setSentTo(email.trim());
      setEmail('');
      setHotelIds([]);
      setOpen(false);
      setBusy(false);
      await load();
    } catch (caught) {
      const stillCurrent = (
        expectedOrganizationId === activeOrganizationRef.current
        && expectedGeneration === organizationGenerationRef.current
      );
      if (!stillCurrent) return;
      setError(caught instanceof Error && caught.name === 'AbortError'
        ? 'The invitation request was cancelled. Try again.'
        : 'Something went wrong. Try again.');
      setBusy(false);
    }
  };

  const revokeInvite = async (invite: PendingCompanyInvite) => {
    if (!invite.canRevoke || revokingInviteId) return;
    const expectedOrganizationId = organizationId;
    const expectedGeneration = organizationGenerationRef.current;
    setRevokingInviteId(invite.id);
    setError('');
    setRevokeError('');
    try {
      const response = await fetchWithAuth(
        `/api/auth/invites?id=${encodeURIComponent(invite.id)}`,
        { method: 'DELETE', signal: mutationSignal() },
      );
      const body = await response.json().catch(() => ({})) as { ok?: boolean; error?: string };
      const stillCurrent = (
        expectedOrganizationId === activeOrganizationRef.current
        && expectedGeneration === organizationGenerationRef.current
      );
      if (!stillCurrent) return;
      if (!response.ok || body.ok !== true) {
        setRevokeError(body.error ?? 'The invitation is still active because it could not be revoked.');
        setRevokingInviteId(null);
        return;
      }
      setInvites((current) => current.filter((item) => item.id !== invite.id));
      setConfirmingInviteId(null);
      setRevokeError('');
      setRevokingInviteId(null);
      await load();
    } catch (caught) {
      const stillCurrent = (
        expectedOrganizationId === activeOrganizationRef.current
        && expectedGeneration === organizationGenerationRef.current
      );
      if (!stillCurrent) return;
      setRevokeError(caught instanceof Error && caught.name === 'AbortError'
        ? 'The invitation is still active. Try again.'
        : 'The invitation is still active. Check your connection and try again.');
      setRevokingInviteId(null);
    }
  };

  if (loadedForCurrentOrganization && companyJobs.length === 0 && visibleInvites.length === 0) {
    return null;
  }

  return (
    <section className={styles.sectionBlock} aria-busy={loadState === 'loading'}>
      <div className={styles.headingWithAction}>
        <h3>{'Company people'}</h3>
        {loadedForCurrentOrganization && companyJobs.length > 0 ? (
          <button
            type="button"
            className={styles.primaryButton}
            onClick={() => {
              setOpen((current) => !current);
              setSentTo('');
              setError('');
              setRevokeError('');
              setConfirmingInviteId(null);
            }}
            disabled={busy || Boolean(revokingInviteId)}
          >
            <UserPlus size={16} aria-hidden="true" />
            {'Invite company person'}
          </button>
        ) : null}
      </div>

      {loadState === 'loading' ? (
        <p role="status" aria-live="polite" aria-busy="true" style={{ fontSize: '13px', color: 'var(--text-muted)' }}>
          {'Loading company invitations…'}
        </p>
      ) : null}
      {loadState === 'error' ? (
        <div role="alert" aria-live="assertive" style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <p style={{ fontSize: '13px', color: 'var(--red)', margin: 0 }}>
            {loadError || 'Company invitations are unavailable right now.'}
          </p>
          <button className={styles.secondaryButton} type="button" onClick={() => void load()}>
            {'Retry'}
          </button>
        </div>
      ) : null}
      {sentTo && loadedForCurrentOrganization ? (
        <p role="status" aria-live="polite" style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>
          {`Invitation sent to ${sentTo}.`}
        </p>
      ) : null}

      {open && loadedForCurrentOrganization && selectedJob ? (
        <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: '12px', marginTop: '12px' }}>
          <label htmlFor="company-invite-email" style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            <span style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-secondary)' }}>{'Email'}</span>
            <input
              id="company-invite-email"
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              disabled={busy}
              style={{ height: '40px', borderRadius: '8px', border: '1px solid var(--border)', padding: '0 12px', background: 'var(--bg-card)', color: 'var(--text-primary)' }}
            />
          </label>

          <label htmlFor="company-invite-job" style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            <span style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-secondary)' }}>{'What job'}</span>
            <select
              id="company-invite-job"
              value={selectedJob.value}
              onChange={(event) => { setJob(event.target.value); setHotelIds([]); setAllHotels(true); }}
              disabled={busy}
              style={{ height: '40px', borderRadius: '8px', border: '1px solid var(--border)', padding: '0 8px', background: 'var(--bg-card)', color: 'var(--text-primary)' }}
            >
              {companyJobs.map((entry) => (
                <option key={entry.value} value={entry.value}>{entry.label.en}</option>
              ))}
            </select>
          </label>

          <fieldset disabled={busy} style={{ border: '1px solid var(--border)', borderRadius: '8px', padding: '12px' }}>
            <legend style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-secondary)', padding: '0 6px' }}>
              {'Which hotels'}
            </legend>
            {canOfferAll ? (
              <label htmlFor="company-invite-all-hotels" style={{ display: 'flex', gap: '8px', alignItems: 'center', fontSize: '14px' }}>
                <input
                  id="company-invite-all-hotels"
                  type="checkbox"
                  checked={allHotels}
                  onChange={(event) => setAllHotels(event.target.checked)}
                />
                {'All hotels, including ones added later'}
              </label>
            ) : null}
            {coverageIsAll ? null : allowedHotels.map((hotel) => (
              <label key={hotel.id} htmlFor={`company-invite-hotel-${hotel.id}`} style={{ display: 'flex', gap: '8px', alignItems: 'center', fontSize: '14px' }}>
                <input
                  id={`company-invite-hotel-${hotel.id}`}
                  type="checkbox"
                  checked={hotelIds.includes(hotel.id)}
                  onChange={(event) => setHotelIds((current) => (
                    event.target.checked
                      ? [...new Set([...current, hotel.id])]
                      : current.filter((id) => id !== hotel.id)
                  ))}
                />
                {hotel.name}
              </label>
            ))}
          </fieldset>

          {error ? <p role="alert" aria-live="assertive" style={{ fontSize: '13px', color: 'var(--red)', margin: 0 }}>{error}</p> : null}

          <button type="submit" className={styles.primaryButton} disabled={busy || !loadedForCurrentOrganization}>
            {busy ? 'Sending…' : 'Send invitation'}
          </button>
        </form>
      ) : null}

      {visibleInvites.length > 0 ? (
        <div style={{ marginTop: '16px' }}>
          <h4 style={{ fontSize: '13px', color: 'var(--text-secondary)', margin: '0 0 8px' }}>
            {'Pending company invitations'}
          </h4>
          <div className={styles.listCard} role="list">
            {visibleInvites.map((invite) => {
              const confirming = confirmingInviteId === invite.id && invite.canRevoke;
              return (
                <div key={invite.id} role="listitem" style={{ padding: '10px 0', display: 'flex', flexDirection: 'column', gap: '4px' }}>
                  <span style={{ fontSize: '14px', color: 'var(--text-primary)' }}>{invite.email}</span>
                  <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
                    {`${invite.role === 'owner' ? 'Owner' : 'Regional Manager'} · ${describeReach(invite)}${invite.isExpired ? ' · Expired' : ''}`}
                  </span>
                  {confirming ? (
                    <div role="group" aria-label={`Confirm revoking invitation for ${invite.email}`} style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <span>{'Revoke this invitation?'}</span>
                      <button
                        className={styles.secondaryButton}
                        type="button"
                        onClick={() => {
                          setConfirmingInviteId(null);
                          setRevokeError('');
                        }}
                        disabled={Boolean(revokingInviteId)}
                      >
                        {'No'}
                      </button>
                      <button
                        className={styles.dangerButton}
                        ref={confirmButtonRef}
                        type="button"
                        onClick={() => void revokeInvite(invite)}
                        disabled={Boolean(revokingInviteId)}
                      >
                        {revokingInviteId === invite.id ? 'Revoking…' : 'Yes, revoke'}
                      </button>
                    </div>
                  ) : invite.canRevoke ? (
                    <button
                      className={styles.reviewButton}
                      type="button"
                      onClick={() => {
                        setConfirmingInviteId(invite.id);
                        setRevokeError('');
                      }}
                      disabled={Boolean(revokingInviteId)}
                      aria-label={`Revoke invitation for ${invite.email}`}
                    >
                      {'Revoke'}
                    </button>
                  ) : null}
                </div>
              );
            })}
          </div>
          {revokeError ? (
            <p role="alert" aria-live="assertive" style={{ fontSize: '13px', color: 'var(--red)', margin: '8px 0 0' }}>
              {revokeError}
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
