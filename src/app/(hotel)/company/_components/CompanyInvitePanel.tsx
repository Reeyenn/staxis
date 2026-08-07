'use client';

// Inviting somebody to the COMPANY, from the company view.
//
// This is a different question from inviting somebody to a hotel, and it used
// to have no working screen at all. The old "Invite company member" button was
// unreachable three times over: the dialog-open flag compared a null against an
// undefined, the only component hosting the invite dialogs was not mounted
// without a selected hotel, and the button's own guard required BOTH no active
// hotel and a capability that could only ever be true WITH one. Rather than
// untangle three guards that all had to be wrong together, this owns the
// company case end to end.
//
// It asks the three questions a company job actually has:
//   who        an email address
//   what job   Owner or Regional Manager
//   which      an explicit list of hotels, or every hotel the company will ever
//   hotels     operate. That second option is the whole point of the rescope: a
//              management company runs hotels for different ownership groups,
//              so an Owner of 3 of 20 must not see the other 17.

import React from 'react';
import { UserPlus } from 'lucide-react';

interface CompanyInviteJob {
  value: string;
  scope: 'company' | 'property';
  label: { en: string };
  allowedPropertyIds: string[];
}

interface CompanyInviteOptions {
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

const NO_OPTIONS: CompanyInviteOptions = { jobs: [], hotels: [], allowsAllIncludingFuture: false };

function describeReach(invite: PendingCompanyInvite): string {
  if (invite.coversAllIncludingFuture) return 'Every hotel, including ones added later';
  if (invite.propertyNames.length === 0) return 'No hotels';
  if (invite.propertyNames.length <= 2) return invite.propertyNames.join(' and ');
  return `${invite.propertyNames[0]} and ${invite.propertyNames.length - 1} more`;
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
  const [loadError, setLoadError] = React.useState('');
  const [open, setOpen] = React.useState(false);
  const [email, setEmail] = React.useState('');
  const [job, setJob] = React.useState('');
  const [allHotels, setAllHotels] = React.useState(true);
  const [hotelIds, setHotelIds] = React.useState<string[]>([]);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState('');
  const [sentTo, setSentTo] = React.useState('');

  const load = React.useCallback(async () => {
    try {
      const res = await fetch(
        `/api/auth/invites?organizationId=${encodeURIComponent(organizationId)}`,
        { cache: 'no-store' },
      );
      const body = await res.json() as {
        ok?: boolean;
        data?: { invites?: PendingCompanyInvite[]; options?: CompanyInviteOptions };
      };
      if (!res.ok || !body.ok || !body.data) {
        setLoadError('Company invitations are unavailable right now.');
        return;
      }
      setLoadError('');
      setOptions(body.data.options ?? NO_OPTIONS);
      setInvites(body.data.invites ?? []);
    } catch {
      setLoadError('Company invitations are unavailable right now.');
    }
  }, [organizationId]);

  React.useEffect(() => { void load(); }, [load]);

  const companyJobs = options.jobs.filter((entry) => entry.scope === 'company');
  const selectedJob = companyJobs.find((entry) => entry.value === job) ?? companyJobs[0] ?? null;
  const canOfferAll = options.allowsAllIncludingFuture === true;
  const coverageIsAll = canOfferAll && allHotels;
  const allowedHotels = options.hotels.filter(
    (hotel) => selectedJob?.allowedPropertyIds.includes(hotel.id),
  );

  if (companyJobs.length === 0) {
    // Nothing this person may hand out at company level. Show pending
    // invitations if they can see any, and no control they cannot use.
    if (invites.length === 0) return null;
  }

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError('');
    if (!selectedJob) { setError('Company roles are unavailable. Reload and try again.'); return; }
    if (!email.trim()) { setError('Enter an email address.'); return; }
    // `hotelId` is the authority anchor the server re-resolves the company
    // from. Any hotel this caller may hire into works; the company itself is
    // pinned by the resolved scope, not by this value.
    const anchor = allowedHotels[0]?.id ?? options.hotels[0]?.id;
    if (!anchor) { setError('Your hotel access changed. Reload and try again.'); return; }

    const chosen = hotelIds.filter(
      (id) => selectedJob.allowedPropertyIds.includes(id),
    );
    if (!coverageIsAll && chosen.length === 0) { setError('Choose at least one hotel.'); return; }

    setBusy(true);
    try {
      const res = await fetch('/api/auth/invites', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          hotelId: anchor,
          email: email.trim(),
          role: selectedJob.value,
          scope: 'company',
          // Omitting the list is what the server reads as "including hotels
          // added later", so only omit it when that was actually chosen.
          ...(coverageIsAll ? {} : { propertyIds: chosen }),
        }),
      });
      const body = await res.json() as { ok?: boolean; error?: string };
      if (!res.ok || !body.ok) {
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
    } catch {
      setError('Something went wrong. Try again.');
      setBusy(false);
    }
  };

  return (
    <section className={styles.sectionBlock}>
      <div className={styles.headingWithAction}>
        <h3>{'Company people'}</h3>
        {companyJobs.length > 0 ? (
          <button
            type="button"
            className={styles.primaryButton}
            onClick={() => { setOpen((current) => !current); setSentTo(''); setError(''); }}
          >
            <UserPlus size={16} aria-hidden="true" />
            {'Invite company person'}
          </button>
        ) : null}
      </div>

      {loadError ? <p style={{ fontSize: '13px', color: 'var(--text-muted)' }}>{loadError}</p> : null}
      {sentTo ? (
        <p style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>
          {`Invitation sent to ${sentTo}.`}
        </p>
      ) : null}

      {open && selectedJob ? (
        <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: '12px', marginTop: '12px' }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            <span style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-secondary)' }}>{'Email'}</span>
            <input
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              disabled={busy}
              style={{ height: '40px', borderRadius: '8px', border: '1px solid var(--border)', padding: '0 12px', background: 'var(--bg-card)', color: 'var(--text-primary)' }}
            />
          </label>

          <label style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            <span style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-secondary)' }}>{'What job'}</span>
            <select
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
              <label style={{ display: 'flex', gap: '8px', alignItems: 'center', fontSize: '14px' }}>
                <input
                  type="checkbox"
                  checked={allHotels}
                  onChange={(event) => setAllHotels(event.target.checked)}
                />
                {'All hotels, including ones added later'}
              </label>
            ) : null}
            {coverageIsAll ? null : allowedHotels.map((hotel) => (
              <label key={hotel.id} style={{ display: 'flex', gap: '8px', alignItems: 'center', fontSize: '14px' }}>
                <input
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

          {error ? <p style={{ fontSize: '13px', color: 'var(--red)' }}>{error}</p> : null}

          <button type="submit" className={styles.primaryButton} disabled={busy}>
            {busy ? 'Sending…' : 'Send invitation'}
          </button>
        </form>
      ) : null}

      {invites.length > 0 ? (
        <div style={{ marginTop: '16px' }}>
          <h4 style={{ fontSize: '13px', color: 'var(--text-secondary)', margin: '0 0 8px' }}>
            {'Pending company invitations'}
          </h4>
          <div className={styles.listCard} role="list">
            {invites.map((invite) => (
              <div key={invite.id} role="listitem" style={{ padding: '10px 0', display: 'flex', flexDirection: 'column', gap: '2px' }}>
                <span style={{ fontSize: '14px', color: 'var(--text-primary)' }}>{invite.email}</span>
                <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
                  {`${invite.role === 'owner' ? 'Owner' : 'Regional Manager'} · ${describeReach(invite)}${invite.isExpired ? ' · Expired' : ''}`}
                </span>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </section>
  );
}
