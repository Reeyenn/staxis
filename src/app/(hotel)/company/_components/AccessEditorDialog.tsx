'use client';

import React from 'react';
import {
  AlertTriangle,
  CalendarClock,
  Check,
  CheckCircle2,
  Hotel,
  KeyRound,
  Search,
  ShieldCheck,
  X,
} from 'lucide-react';

import { fetchWithAuth } from '@/lib/api-fetch';
import {
  type CompanyAccessEditOperation,
  type CompanyAccessEditPreview,
  type CompanyAccessEditScopeKind,
  type CompanyAccessEditorMembership,
  type CompanyAccessEditorOrganization,
} from '@/lib/company-access/access-editor';
import type { CompanyMembership } from '@/lib/company-access/dto';
import type { AccessProfile } from '@/lib/organization-access/domain';

import styles from '../CompanyAccess.module.css';

interface Envelope<T> {
  ok?: boolean;
  data?: T;
  error?: unknown;
}

function responseError(body: Envelope<unknown>, fallback: string): string {
  if (typeof body.error === 'string') return body.error;
  if (body.error && typeof body.error === 'object') {
    const record = body.error as Record<string, unknown>;
    if (typeof record.message === 'string') return record.message;
    if (typeof record.error === 'string') return record.error;
  }
  return fallback;
}

function profileLabel(profile: string, lang: string): string {
  const labels: Record<string, string> = {
    organization_owner: 'Organization Owner',
    organization_admin: 'Organization Administrator',
    portfolio_manager: 'Portfolio Manager',
    property_manager: 'Property Manager',
    department_lead: 'Department Lead',
    contributor: 'Contributor',
    viewer: 'Viewer',
    external_collaborator: 'External Collaborator',
    owner: 'Owner',
    regional_manager: 'Regional Manager',
    controller: 'Contributor',
    general_manager: 'Hotel Manager',
    front_desk: 'Viewer',
    housekeeping: 'Viewer',
    maintenance: 'Viewer',
  };
  return labels[profile] ?? 'Team member';
}

function initialScope(
  editor: CompanyAccessEditorMembership,
  organization: CompanyAccessEditorOrganization,
  profile: AccessProfile,
): {
  scopeKind: CompanyAccessEditScopeKind;
  portfolioId: string;
  propertyIds: string[];
} {
  const sameProfile = editor.currentGrants.filter((grant) => grant.accessProfile === profile);
  if (sameProfile.length === editor.currentGrants.length && sameProfile.length > 0) {
    if (sameProfile.every((grant) => grant.scopeType === 'property')) {
      return {
        scopeKind: 'selected_properties',
        portfolioId: '',
        propertyIds: sameProfile.flatMap((grant) => grant.propertyId ? [grant.propertyId] : []),
      };
    }
    if (sameProfile.length === 1 && sameProfile[0].scopeType === 'portfolio') {
      return {
        scopeKind: 'portfolio',
        portfolioId: sameProfile[0].portfolioId ?? '',
        propertyIds: [],
      };
    }
    if (sameProfile.length === 1 && sameProfile[0].scopeType === 'organization') {
      return { scopeKind: 'organization', portfolioId: '', propertyIds: [] };
    }
  }
  const policy = organization.profilePolicies.find((candidate) => candidate.accessProfile === profile);
  if (policy?.organizationScope) return { scopeKind: 'organization', portfolioId: '', propertyIds: [] };
  if (policy?.portfolioIds[0]) {
    return { scopeKind: 'portfolio', portfolioId: policy.portfolioIds[0], propertyIds: [] };
  }
  return {
    scopeKind: 'selected_properties',
    portfolioId: '',
    propertyIds: policy?.propertyIds[0] ? [policy.propertyIds[0]] : [],
  };
}

function useDialogBehavior(onClose: () => void, busy: boolean) {
  const dialogRef = React.useRef<HTMLDivElement | null>(null);
  const closeRef = React.useRef<HTMLButtonElement | null>(null);
  const onCloseRef = React.useRef(onClose);
  const busyRef = React.useRef(busy);
  onCloseRef.current = onClose;
  busyRef.current = busy;

  React.useEffect(() => {
    const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const priorOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        if (!busyRef.current) onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab' || !dialogRef.current) return;
      const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ));
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) {
        event.preventDefault();
        dialogRef.current.focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.body.style.overflow = priorOverflow;
      document.removeEventListener('keydown', onKeyDown);
      if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
    };
  }, []);

  return { dialogRef, closeRef };
}

export function AccessEditorDialog({
  membership,
  editorMembership,
  organization,
  lang,
  onClose,
  onCompleted,
}: {
  membership: CompanyMembership;
  editorMembership: CompanyAccessEditorMembership;
  organization: CompanyAccessEditorOrganization;
  lang: string;
  onClose: () => void;
  onCompleted: () => void;
}) {
  const initialProfile = (
    editorMembership.currentGrants.length > 0
    && editorMembership.currentGrants.every((grant) => (
      grant.accessProfile === editorMembership.currentGrants[0].accessProfile
    ))
    && organization.profilePolicies.some((policy) => (
      policy.accessProfile === editorMembership.currentGrants[0].accessProfile
    ))
  )
    ? editorMembership.currentGrants[0].accessProfile
    : organization.profilePolicies[0]?.accessProfile ?? 'viewer';
  const firstScope = initialScope(editorMembership, organization, initialProfile);
  const [operation, setOperation] = React.useState<CompanyAccessEditOperation>(
    editorMembership.canReplace ? 'replace' : 'add',
  );
  const [profile, setProfile] = React.useState<AccessProfile>(initialProfile);
  const [scopeKind, setScopeKind] = React.useState<CompanyAccessEditScopeKind>(firstScope.scopeKind);
  const [portfolioId, setPortfolioId] = React.useState(firstScope.portfolioId);
  const [propertyIds, setPropertyIds] = React.useState(firstScope.propertyIds);
  const [expiresAt, setExpiresAt] = React.useState(() => {
    const expirations = [...new Set(editorMembership.currentGrants.map((grant) => grant.expiresAt))];
    return expirations.length === 1 && expirations[0] ? expirations[0].slice(0, 10) : '';
  });
  const [hotelQuery, setHotelQuery] = React.useState('');
  const [preview, setPreview] = React.useState<CompanyAccessEditPreview | null>(null);
  const [idempotencyKey, setIdempotencyKey] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState('');
  const [success, setSuccess] = React.useState(false);
  const { dialogRef, closeRef } = useDialogBehavior(onClose, busy);
  const titleId = React.useId();
  const descriptionId = React.useId();

  const policy = organization.profilePolicies.find((candidate) => candidate.accessProfile === profile)
    ?? organization.profilePolicies[0];
  const scopeOptions = React.useMemo<CompanyAccessEditScopeKind[]>(() => [
    ...(policy?.organizationScope ? ['organization' as const] : []),
    ...(policy?.portfolioIds.length ? ['portfolio' as const] : []),
    ...(policy?.propertyIds.length ? ['selected_properties' as const] : []),
  ], [policy]);
  const availablePortfolios = organization.portfolios.filter((candidate) => (
    policy?.portfolioIds.includes(candidate.id)
  ));
  const availableProperties = organization.properties.filter((candidate) => (
    policy?.propertyIds.includes(candidate.id)
  ));
  const filteredProperties = availableProperties.filter((property) => (
    !hotelQuery.trim() || property.name.toLowerCase().includes(hotelQuery.trim().toLowerCase())
  ));

  const invalidatePreview = React.useCallback(() => {
    setPreview(null);
    setIdempotencyKey(null);
    setError('');
  }, []);

  React.useEffect(() => {
    if (!policy) return;
    if (!scopeOptions.includes(scopeKind)) {
      const next = scopeOptions[0] ?? 'selected_properties';
      setScopeKind(next);
      setPortfolioId(next === 'portfolio' ? policy.portfolioIds[0] ?? '' : '');
      setPropertyIds(next === 'selected_properties' && policy.propertyIds[0]
        ? [policy.propertyIds[0]]
        : []);
      invalidatePreview();
      return;
    }
    if (scopeKind === 'portfolio' && !policy.portfolioIds.includes(portfolioId)) {
      setPortfolioId(policy.portfolioIds[0] ?? '');
      invalidatePreview();
    }
    if (scopeKind === 'selected_properties') {
      const nextPropertyIds = propertyIds.filter((id) => policy.propertyIds.includes(id));
      if (nextPropertyIds.length !== propertyIds.length) {
        setPropertyIds(nextPropertyIds);
        invalidatePreview();
      }
    }
  }, [invalidatePreview, policy, portfolioId, propertyIds, scopeKind, scopeOptions]);

  const expiresAtIso = expiresAt ? `${expiresAt}T23:59:59.999Z` : null;
  const expirationValid = profile === 'organization_owner'
    ? !expiresAt
    : profile === 'external_collaborator'
      ? Boolean(expiresAt && new Date(expiresAtIso ?? '').getTime() > Date.now())
      : !expiresAt || new Date(expiresAtIso ?? '').getTime() > Date.now();
  const scopeValid = scopeKind === 'organization'
    ? Boolean(policy?.organizationScope)
    : scopeKind === 'portfolio'
      ? Boolean(portfolioId && policy?.portfolioIds.includes(portfolioId))
      : propertyIds.length > 0
        && propertyIds.length <= 500
        && propertyIds.every((id) => policy?.propertyIds.includes(id));
  const formValid = Boolean(policy && scopeValid && expirationValid
    && (operation === 'add' ? editorMembership.canAdd : editorMembership.canReplace));

  const requestBody = () => ({
    organizationId: organization.id,
    membershipId: membership.id,
    operation,
    accessProfile: profile,
    scopeKind,
    portfolioId: scopeKind === 'portfolio' ? portfolioId : null,
    propertyIds: scopeKind === 'selected_properties' ? [...propertyIds].sort() : [],
    expiresAt: expiresAtIso,
    expectedAccessEpoch: organization.accessEpoch,
    expectedAccessRevision: editorMembership.accessRevision,
  });

  const loadPreview = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!formValid || busy) return;
    setBusy(true);
    setError('');
    try {
      const response = await fetchWithAuth('/api/company-access/access-editor/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody()),
      });
      const body = await response.json().catch(() => ({})) as Envelope<CompanyAccessEditPreview>;
      if (!response.ok || !body.ok || !body.data) {
        throw new Error(responseError(body, 'Access impact could not be previewed.'));
      }
      setPreview(body.data);
      setIdempotencyKey(crypto.randomUUID());
    } catch (caught) {
      setPreview(null);
      setIdempotencyKey(null);
      setError(caught instanceof Error ? caught.message : 'Access impact could not be previewed.');
    } finally {
      setBusy(false);
    }
  };

  const commit = async () => {
    if (!preview || !idempotencyKey || busy) return;
    setBusy(true);
    setError('');
    try {
      const response = await fetchWithAuth('/api/company-access/access-editor/commit', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': idempotencyKey,
        },
        body: JSON.stringify({
          ...requestBody(),
          previewFingerprint: preview.previewFingerprint,
          confirmed: true,
        }),
      });
      const body = await response.json().catch(() => ({})) as Envelope<unknown>;
      if (!response.ok || !body.ok) {
        throw new Error(responseError(body, 'Access could not be saved.'));
      }
      setSuccess(true);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Access could not be saved.');
    } finally {
      setBusy(false);
    }
  };

  const finish = () => {
    onCompleted();
    onClose();
  };
  const propertiesById = new Map(organization.properties.map((property) => [property.id, property]));
  const afterProperties = preview?.afterPropertyIds.flatMap((id) => {
    const property = propertiesById.get(id);
    return property ? [property] : [];
  }) ?? [];

  return (
    <div className={styles.dialogLayer}>
      <button
        type="button"
        className={styles.dialogScrim}
        aria-label={'Close dialog'}
        onClick={() => { if (!busy) onClose(); }}
      />
      <div
        ref={dialogRef}
        className={`${styles.dialog} ${styles.workflowDialog}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        aria-busy={busy}
        tabIndex={-1}
      >
        <div className={styles.dialogHeader}>
          <span className={styles.dialogIcon}><KeyRound size={21} aria-hidden="true" /></span>
          <div>
            <span>{'Role and scope'}</span>
            <h2 id={titleId}>{'Edit access for'} {membership.displayName}</h2>
          </div>
          <button
            ref={closeRef}
            type="button"
            className={styles.iconButton}
            onClick={onClose}
            disabled={busy}
            aria-label={'Close'}
          >
            <X size={17} aria-hidden="true" />
          </button>
        </div>
        <p id={descriptionId} className={styles.dialogIntro}>
          {'Choose one profile and an exact all-company-hotels, portfolio, or selected-hotels scope. Nothing changes until you preview and confirm.'}
        </p>

        {editorMembership.sourceKind === 'membership_hat' ? (
          <div className={styles.formNotice} role="note">
            <AlertTriangle size={16} aria-hidden="true" />
            <span>{`This replaces the current ${profileLabel(editorMembership.sourceRole ?? 'company role', lang)} ${editorMembership.sourceScope === 'company' ? 'company-wide' : 'hotel-scoped'} role with one role and exact scope. Other roles this person holds are unchanged.`}</span>
          </div>
        ) : null}

        {success ? (
          <>
            <div className={styles.successState} role="status">
              <span><CheckCircle2 size={30} aria-hidden="true" /></span>
              <h3>{'Access updated'}</h3>
              <p>{'The new authority is active now and the audit trail records the exact change.'}</p>
            </div>
            <div className={styles.dialogFooter}>
              <span><ShieldCheck size={14} aria-hidden="true" />{'Authorization was rechecked at commit'}</span>
              <button type="button" className={styles.primaryButton} onClick={finish}>{'Done'}</button>
            </div>
          </>
        ) : (
          <form className={styles.workflowForm} onSubmit={loadPreview}>
            <fieldset className={styles.accessOperationGroup}>
              <legend>{'Change mode'}</legend>
              {editorMembership.canReplace ? (
                <label>
                  <input
                    type="radio"
                    name="access-operation"
                    value="replace"
                    checked={operation === 'replace'}
                    onChange={() => { setOperation('replace'); invalidatePreview(); }}
                  />
                  <span>
                    <strong>{'Replace current access'}</strong>
                    <small>{'Remove access outside the new exact scope.'}</small>
                  </span>
                </label>
              ) : null}
              {editorMembership.canAdd ? (
                <label>
                  <input
                    type="radio"
                    name="access-operation"
                    value="add"
                    checked={operation === 'add'}
                    onChange={() => { setOperation('add'); invalidatePreview(); }}
                  />
                  <span>
                    <strong>{'Add another scope'}</strong>
                    <small>{'Keep current access and add this exact scope.'}</small>
                  </span>
                </label>
              ) : null}
            </fieldset>

            <div className={styles.formGrid}>
              <label className={styles.formField}>
                <span>{'Access profile'}</span>
                <select
                  value={profile}
                  onChange={(event) => {
                    const next = event.target.value as AccessProfile;
                    const nextScope = initialScope(editorMembership, organization, next);
                    setProfile(next);
                    setScopeKind(nextScope.scopeKind);
                    setPortfolioId(nextScope.portfolioId);
                    setPropertyIds(nextScope.propertyIds);
                    if (next === 'organization_owner') setExpiresAt('');
                    invalidatePreview();
                  }}
                >
                  {organization.profilePolicies.map((candidate) => (
                    <option key={candidate.accessProfile} value={candidate.accessProfile}>
                      {profileLabel(candidate.accessProfile, lang)}
                    </option>
                  ))}
                </select>
                <em>{'Only profiles you may delegate are shown.'}</em>
              </label>
              <label className={styles.formField}>
                <span>{'Exact scope'}</span>
                <select
                  value={scopeKind}
                  onChange={(event) => {
                    const next = event.target.value as CompanyAccessEditScopeKind;
                    setScopeKind(next);
                    setPortfolioId(next === 'portfolio' ? policy?.portfolioIds[0] ?? '' : '');
                    setPropertyIds(next === 'selected_properties' && policy?.propertyIds[0]
                      ? [policy.propertyIds[0]]
                      : []);
                    invalidatePreview();
                  }}
                >
                  {scopeOptions.map((scope) => (
                    <option key={scope} value={scope}>{scope === 'organization'
                      ? 'Whole company'
                      : scope === 'portfolio'
                        ? 'One portfolio / region'
                        : 'Selected hotels'}</option>
                  ))}
                </select>
              </label>
            </div>

            {scopeKind === 'portfolio' ? (
              <label className={styles.formField}>
                <span>{'Portfolio / region'}</span>
                <select
                  value={portfolioId}
                  onChange={(event) => { setPortfolioId(event.target.value); invalidatePreview(); }}
                >
                  {availablePortfolios.map((portfolio) => (
                    <option key={portfolio.id} value={portfolio.id}>{portfolio.name}</option>
                  ))}
                </select>
              </label>
            ) : null}

            {scopeKind === 'selected_properties' ? (
              <fieldset className={styles.hotelScopePicker}>
                <legend>{'Selected hotels'}</legend>
                <div className={styles.hotelScopeToolbar}>
                  <label>
                    <Search size={15} aria-hidden="true" />
                    <span className={styles.srOnly}>{'Search hotels'}</span>
                    <input
                      type="search"
                      value={hotelQuery}
                      onChange={(event) => setHotelQuery(event.target.value)}
                      placeholder={'Search hotels'}
                    />
                  </label>
                  <span>{propertyIds.length} / 500 {'selected'}</span>
                </div>
                <div className={styles.hotelScopeList}>
                  {filteredProperties.map((property) => {
                    const checked = propertyIds.includes(property.id);
                    return (
                      <label key={property.id}>
                        <input
                          type="checkbox"
                          checked={checked}
                          disabled={!checked && propertyIds.length >= 500}
                          onChange={() => {
                            setPropertyIds((current) => checked
                              ? current.filter((id) => id !== property.id)
                              : [...current, property.id].sort());
                            invalidatePreview();
                          }}
                        />
                        <span className={styles.hotelScopeCheck} aria-hidden="true"><Check size={13} /></span>
                        <Hotel size={15} aria-hidden="true" />
                        <strong>{property.name}</strong>
                      </label>
                    );
                  })}
                  {filteredProperties.length === 0 ? (
                    <p>{'No authorized hotels match this search.'}</p>
                  ) : null}
                </div>
                {propertyIds.length === 0 ? <small>{'Select at least one hotel.'}</small> : null}
              </fieldset>
            ) : null}

            <label className={styles.formField}>
              <span>{profile === 'external_collaborator'
                ? 'Expiration (required)'
                : profile === 'organization_owner'
                  ? 'Expiration'
                  : 'Expiration (optional)'}</span>
              <div className={styles.inputWithIcon}>
                <CalendarClock size={16} aria-hidden="true" />
                <input
                  type="date"
                  value={expiresAt}
                  min={new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)}
                  disabled={profile === 'organization_owner'}
                  required={profile === 'external_collaborator'}
                  onChange={(event) => { setExpiresAt(event.target.value); invalidatePreview(); }}
                />
              </div>
              {!expirationValid ? <small>{'Choose a future expiration date.'}</small> : null}
            </label>

            {preview ? (
              <section className={`${styles.mutationPreview} ${operation === 'replace' && preview.revokedGrantCount > 0 ? styles.lifecyclePreview : ''}`} aria-label={'Confirmed access impact'}>
                <div className={styles.previewHeading}>
                  {operation === 'replace' && preview.revokedGrantCount > 0
                    ? <AlertTriangle size={17} aria-hidden="true" />
                    : <ShieldCheck size={17} aria-hidden="true" />}
                  <div>
                    <strong>{'Server-verified impact'}</strong>
                    <span>{'Authority will be checked again at confirmation.'}</span>
                  </div>
                </div>
                <dl>
                  <div><dt>{'Current access entries'}</dt><dd>{preview.currentGrantCount}</dd></div>
                  <div><dt>{'Access removed'}</dt><dd>{preview.revokedGrantCount}</dd></div>
                  <div><dt>{'Ensured'}</dt><dd>{preview.upsertedGrantCount}</dd></div>
                  <div><dt>{'Hotels before'}</dt><dd>{preview.beforePropertyIds.length}</dd></div>
                  <div><dt>{'Hotels after'}</dt><dd>{preview.afterPropertyIds.length}</dd></div>
                  <div><dt>{'Immediate'}</dt><dd>{'Yes'}</dd></div>
                </dl>
                {afterProperties.length > 0 ? (
                  <div className={styles.previewHotels}>
                    {afterProperties.slice(0, 6).map((property) => (
                      <span key={property.id}><Hotel size={13} aria-hidden="true" />{property.name}</span>
                    ))}
                    {afterProperties.length > 6 ? <span>+{afterProperties.length - 6}</span> : null}
                  </div>
                ) : null}
              </section>
            ) : null}

            {error ? <div className={styles.formError} role="alert">{error}</div> : null}
            <div className={styles.dialogFooter}>
              <span><ShieldCheck size={14} aria-hidden="true" />{'Exact scope · audited · immediate'}</span>
              <div className={styles.dialogActions}>
                <button type="button" className={styles.secondaryButton} onClick={onClose} disabled={busy}>
                  {'Cancel'}
                </button>
                {preview ? (
                  <button type="button" className={styles.primaryButton} onClick={commit} disabled={busy}>
                    {busy ? <span className={styles.buttonSpinner} aria-hidden="true" /> : <ShieldCheck size={15} aria-hidden="true" />}
                    {busy
                      ? 'Saving…'
                      : operation === 'replace'
                        ? 'Confirm replacement'
                        : 'Confirm addition'}
                  </button>
                ) : (
                  <button type="submit" className={styles.primaryButton} disabled={!formValid || busy}>
                    {busy ? <span className={styles.buttonSpinner} aria-hidden="true" /> : <ShieldCheck size={15} aria-hidden="true" />}
                    {busy
                      ? 'Checking…'
                      : 'Preview access impact'}
                  </button>
                )}
              </div>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
