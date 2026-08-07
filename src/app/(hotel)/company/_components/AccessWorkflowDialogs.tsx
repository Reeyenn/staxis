'use client';

import React from 'react';
import {
  AlertTriangle,
  CalendarClock,
  CheckCircle2,
  Copy,
  Hotel,
  KeyRound,
  Send,
  ShieldCheck,
  UserCheck,
  UserMinus,
  X,
} from 'lucide-react';

import { fetchWithAuth } from '@/lib/api-fetch';
import {
  titleCaseAccessValue,
  type AccessScopeType,
  type CompanyAccessData,
  type CompanyAccessRequest,
} from '@/lib/company-access/dto';
import { ACCESS_PROFILES, JOB_CATEGORIES } from '@/lib/organization-access/domain';

import styles from '../CompanyAccess.module.css';

interface Envelope<T> {
  ok?: boolean;
  data?: T;
  error?: unknown;
}

interface InviteResponse {
  invitation?: { id: string };
  inviteLink?: string;
  emailSent?: boolean;
  emailError?: string | null;
}

interface RequestResponse {
  request?: { id: string };
}

export type CompanyLifecycleAction =
  | { kind: 'revoke_grant'; id: string; targetLabel: string; detailLabel: string }
  | { kind: 'suspend_membership'; id: string; targetLabel: string; detailLabel: string }
  | { kind: 'resume_membership'; id: string; targetLabel: string; detailLabel: string }
  | { kind: 'remove_membership'; id: string; targetLabel: string; detailLabel: string };

interface ScopeSelection {
  type: AccessScopeType;
  targetId: string;
}

const PROFILE_OPTIONS = ACCESS_PROFILES;

function scopeTypesForProfile(profile: string): readonly AccessScopeType[] {
  if (profile === 'organization_owner' || profile === 'organization_admin') return ['organization'];
  if (profile === 'portfolio_manager') return ['portfolio'];
  if (profile === 'property_manager') return ['property'];
  return ['organization', 'portfolio', 'property'];
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

function useDialogBehavior(onClose: () => void, busy = false) {
  const closeRef = React.useRef<HTMLButtonElement | null>(null);
  const dialogRef = React.useRef<HTMLDivElement | null>(null);
  const busyRef = React.useRef(busy);
  busyRef.current = busy;
  // Hold onClose in a ref so the focus-trap effect below can depend on [] and
  // run exactly once per real open. Call sites pass a fresh inline arrow for
  // onClose on every parent render; if the effect depended on [onClose] it
  // would tear down + re-run on any unrelated re-render (a live roster update,
  // token refresh, etc.) while the dialog is open — stealing focus back onto
  // the close (X) button mid-typing, so the user's next Space/Enter silently
  // closes the dialog and discards what they typed.
  const onCloseRef = React.useRef(onClose);
  onCloseRef.current = onClose;

  React.useEffect(() => {
    const returnFocusElement = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const previousOverflow = document.body.style.overflow;
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
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
      ));
      if (focusable.length === 0) {
        event.preventDefault();
        dialogRef.current.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!dialogRef.current.contains(document.activeElement)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
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
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', onKeyDown);
      if (returnFocusElement?.isConnected) {
        returnFocusElement.focus({ preventScroll: true });
      }
    };
    // Deps intentionally empty: onClose is read via onCloseRef, so this effect
    // runs once per real open — not on every parent re-render (which would steal
    // focus back onto the close button mid-typing). No reactive prop/state is
    // read directly here, so exhaustive-deps is already satisfied.
  }, []);

  return { closeRef, dialogRef };
}

function WorkflowDialog({ title, eyebrow, description, lang, onClose, children, busy = false }: {
  title: string;
  eyebrow: string;
  description: string;
  lang: string;
  onClose: () => void;
  children: React.ReactNode;
  busy?: boolean;
}) {
  const { closeRef, dialogRef } = useDialogBehavior(onClose, busy);
  const titleId = React.useId();
  const descriptionId = React.useId();

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
            <span>{eyebrow}</span>
            <h2 id={titleId}>{title}</h2>
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
        <p id={descriptionId} className={styles.dialogIntro}>{description}</p>
        {children}
      </div>
    </div>
  );
}

function hotelsForSelection(data: CompanyAccessData, organizationId: string, scope: ScopeSelection) {
  if (scope.type === 'organization') {
    return data.properties.filter((property) => property.organizationId === organizationId);
  }
  if (scope.type === 'portfolio') {
    const portfolio = data.portfolios.find((item) => item.id === scope.targetId);
    return data.properties.filter((property) => (
      property.organizationId === organizationId
      && portfolio?.propertyIds.includes(property.id)
    ));
  }
  return data.properties.filter((property) => (
    property.organizationId === organizationId && property.id === scope.targetId
  ));
}

function selectionExists(data: CompanyAccessData, organizationId: string, scope: ScopeSelection): boolean {
  if (!data.organizations.some((organization) => organization.id === organizationId)) return false;
  if (scope.type === 'organization') return scope.targetId === organizationId;
  if (scope.type === 'portfolio') {
    return data.portfolios.some((portfolio) => portfolio.id === scope.targetId && portfolio.organizationId === organizationId);
  }
  return data.properties.some((property) => property.id === scope.targetId && property.organizationId === organizationId);
}

function ScopeFields({ data, organizationId, profile, scope, onScopeChange, lang, mode }: {
  data: CompanyAccessData;
  organizationId: string;
  profile: string;
  scope: ScopeSelection;
  onScopeChange: (scope: ScopeSelection) => void;
  lang: string;
  mode: 'grant' | 'request';
}) {
  const grantPolicy = data.permissions.delegationPolicies
    .find((policy) => policy.organizationId === organizationId)
    ?.profiles.find((candidate) => candidate.accessProfile === profile);
  const organizationPortfolios = data.portfolios.filter((portfolio) => (
    portfolio.organizationId === organizationId
    && (mode === 'request' || Boolean(grantPolicy?.portfolioIds.includes(portfolio.id)))
  ));
  const organizationProperties = data.properties.filter((property) => (
    property.organizationId === organizationId
    && (mode === 'request' || Boolean(grantPolicy?.propertyIds.includes(property.id)))
  ));
  const availableTypes: AccessScopeType[] = [
    ...(mode === 'request' || grantPolicy?.organizationScope ? ['organization' as const] : []),
    ...(organizationPortfolios.length > 0 ? ['portfolio' as const] : []),
    ...(organizationProperties.length > 0 ? ['property' as const] : []),
  ];
  const allowedTypes = scopeTypesForProfile(profile);
  const types = availableTypes.filter((type) => allowedTypes.includes(type));

  React.useEffect(() => {
    if (types.length === 0) {
      if (scope.type !== 'property' || scope.targetId !== '') onScopeChange({ type: 'property', targetId: '' });
      return;
    }
    const targetIsValid = scope.type === 'organization'
      ? scope.targetId === organizationId
      : scope.type === 'portfolio'
        ? organizationPortfolios.some((portfolio) => portfolio.id === scope.targetId)
        : organizationProperties.some((property) => property.id === scope.targetId);
    if (types.includes(scope.type) && targetIsValid) return;
    const nextType = types.includes(scope.type) ? scope.type : (types[0] ?? 'property');
    const targetId = nextType === 'portfolio'
      ? organizationPortfolios[0]?.id ?? ''
      : nextType === 'property'
        ? organizationProperties[0]?.id ?? ''
        : organizationId;
    onScopeChange({ type: nextType, targetId });
  }, [organizationId, onScopeChange, organizationPortfolios, organizationProperties, scope.targetId, scope.type, types]);

  const targetRows = scope.type === 'portfolio' ? organizationPortfolios : organizationProperties;

  return (
    <div className={styles.formGrid}>
      <label className={styles.formField}>
        <span>{'Access scope'}</span>
        <select
          value={scope.type}
          onChange={(event) => {
            const type = event.target.value as AccessScopeType;
            const targetId = type === 'organization'
              ? organizationId
              : type === 'portfolio'
                ? organizationPortfolios[0]?.id ?? ''
                : organizationProperties[0]?.id ?? '';
            onScopeChange({ type, targetId });
          }}
        >
          {types.map((type) => (
            <option key={type} value={type}>{type === 'organization'
              ? 'Entire organization'
              : type === 'portfolio'
                ? 'Portfolio or region'
                : 'One hotel'}</option>
          ))}
        </select>
      </label>
      {scope.type !== 'organization' ? (
        <label className={styles.formField}>
          <span>{scope.type === 'portfolio' ? 'Portfolio / region' : 'Hotel'}</span>
          <select value={scope.targetId} onChange={(event) => onScopeChange({ ...scope, targetId: event.target.value })}>
            {targetRows.map((row) => <option key={row.id} value={row.id}>{row.name}</option>)}
          </select>
        </label>
      ) : null}
    </div>
  );
}

function ScopePreview({ data, organizationId, profile, scope, lang }: {
  data: CompanyAccessData;
  organizationId: string;
  profile: string;
  scope: ScopeSelection;
  lang: string;
}) {
  const organization = data.organizations.find((item) => item.id === organizationId);
  const portfolio = scope.type === 'portfolio' ? data.portfolios.find((item) => item.id === scope.targetId) : null;
  const hotel = scope.type === 'property' ? data.properties.find((item) => item.id === scope.targetId) : null;
  const hotels = hotelsForSelection(data, organizationId, scope);
  const scopeLabel = scope.type === 'organization'
    ? organization?.name
    : scope.type === 'portfolio'
      ? portfolio?.name
      : hotel?.name;

  return (
    <section className={styles.mutationPreview} aria-label={'Access preview'}>
      <div className={styles.previewHeading}>
        <ShieldCheck size={17} aria-hidden="true" />
        <div>
          <strong>{'Exact access preview'}</strong>
          <span>{'Review before you send'}</span>
        </div>
      </div>
      <dl>
        <div><dt>{'Profile'}</dt><dd>{profileLabel(profile, lang)}</dd></div>
        <div><dt>{'Scope'}</dt><dd>{scopeLabel || 'Select a scope'}</dd></div>
        <div><dt>{'Hotels affected'}</dt><dd>{hotels.length}</dd></div>
      </dl>
      {hotels.length > 0 ? (
        <div className={styles.previewHotels}>
          {hotels.slice(0, 4).map((property) => <span key={property.nodeId}><Hotel size={13} aria-hidden="true" />{property.name}</span>)}
          {hotels.length > 4 ? <span>+{hotels.length - 4}</span> : null}
        </div>
      ) : null}
    </section>
  );
}

export function RequestAccessDialog({ data, lang, onClose, onCompleted }: {
  data: CompanyAccessData;
  lang: string;
  onClose: () => void;
  onCompleted: () => void;
}) {
  const organizations = data.organizations;
  const [organizationId, setOrganizationId] = React.useState(organizations[0]?.id ?? '');
  const [profile, setProfile] = React.useState('viewer');
  const [scope, setScope] = React.useState<ScopeSelection>({ type: 'property', targetId: '' });
  const [reason, setReason] = React.useState('');
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState('');
  const [success, setSuccess] = React.useState(false);

  const formValid = Boolean(organizationId && profile && selectionExists(data, organizationId, scope) && reason.trim().length >= 8);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!formValid || submitting) return;
    setSubmitting(true);
    setError('');
    try {
      const response = await fetchWithAuth('/api/company-access/requests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          organizationId,
          requestedProfile: profile,
          scopeType: scope.type,
          portfolioId: scope.type === 'portfolio' ? scope.targetId : undefined,
          propertyId: scope.type === 'property' ? scope.targetId : undefined,
          reason: reason.trim(),
        }),
      });
      const body = await response.json().catch(() => ({})) as Envelope<RequestResponse>;
      if (!response.ok || !body.ok) {
        throw new Error(responseError(body, 'Request could not be submitted.'));
      }
      setSuccess(true);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Request could not be submitted.');
    } finally {
      setSubmitting(false);
    }
  };

  const finish = () => {
    onCompleted();
    onClose();
  };

  if (success) {
    return (
      <WorkflowDialog
        title={'Request submitted'}
        eyebrow={'Pending review'}
        description={'The requested access is not active until an authorized manager approves it.'}
        lang={lang}
        onClose={finish}
      >
        <div className={styles.successState} role="status">
          <span><CheckCircle2 size={30} aria-hidden="true" /></span>
          <h3>{'Your request is in review'}</h3>
          <p>{profileLabel(profile, lang)}</p>
        </div>
        <div className={styles.dialogFooter}>
          <span><KeyRound size={14} aria-hidden="true" />{'Access is not active yet'}</span>
          <button type="button" className={styles.primaryButton} onClick={finish}>{'Done'}</button>
        </div>
      </WorkflowDialog>
    );
  }

  return (
    <WorkflowDialog
      title={'Request access'}
      eyebrow={'Approval required'}
      description={'Choose the exact profile and scope you need. Your request does not grant access by itself.'}
      lang={lang}
      onClose={onClose}
      busy={submitting}
    >
      <form className={styles.workflowForm} onSubmit={submit}>
        <div className={styles.formGrid}>
          <label className={styles.formField}>
            <span>{'Organization'}</span>
            <select value={organizationId} onChange={(event) => { setOrganizationId(event.target.value); setScope({ type: 'property', targetId: '' }); }}>
              {organizations.map((organization) => <option key={organization.id} value={organization.id}>{organization.name}</option>)}
            </select>
          </label>
          <label className={styles.formField}>
            <span>{'Requested profile'}</span>
            <select value={profile} onChange={(event) => setProfile(event.target.value)}>
              {PROFILE_OPTIONS.map((option) => <option key={option} value={option}>{profileLabel(option, lang)}</option>)}
            </select>
          </label>
        </div>
        <ScopeFields data={data} organizationId={organizationId} profile={profile} scope={scope} onScopeChange={setScope} lang={lang} mode="request" />
        <label className={styles.formField}>
          <span>{'Why do you need this access?'}</span>
          <textarea value={reason} onChange={(event) => setReason(event.target.value)} rows={3} maxLength={500} placeholder={'Explain the work you need to complete…'} required />
          <em>{reason.trim().length < 8 ? 'Use at least 8 characters.' : `${reason.length} / 500`}</em>
        </label>
        <ScopePreview data={data} organizationId={organizationId} profile={profile} scope={scope} lang={lang} />
        {error ? <div className={styles.formError} role="alert">{error}</div> : null}
        <div className={styles.dialogFooter}>
          <span><KeyRound size={14} aria-hidden="true" />{'Pending until approved'}</span>
          <div className={styles.dialogActions}>
            <button type="button" className={styles.secondaryButton} onClick={onClose} disabled={submitting}>{'Cancel'}</button>
            <button type="submit" className={styles.primaryButton} disabled={!formValid || submitting}>
              {submitting ? <span className={styles.buttonSpinner} aria-hidden="true" /> : <Send size={15} aria-hidden="true" />}
              {submitting ? 'Submitting…' : 'Submit request'}
            </button>
          </div>
        </div>
      </form>
    </WorkflowDialog>
  );
}

export function ReviewAccessRequestDialog({ request, lang, onClose, onCompleted }: {
  request: CompanyAccessRequest;
  lang: string;
  onClose: () => void;
  onCompleted: () => void;
}) {
  const [decision, setDecision] = React.useState<'approved' | 'denied'>('approved');
  const [reviewNote, setReviewNote] = React.useState('');
  const [expiresAt, setExpiresAt] = React.useState('');
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState('');
  const external = request.requestedProfile === 'external_collaborator';
  const owner = request.requestedProfile === 'organization_owner';
  const expiryValid = !expiresAt || new Date(`${expiresAt}T23:59:59`).getTime() > Date.now();
  const formValid = decision === 'denied'
    ? reviewNote.trim().length > 0
    : expiryValid && (!external || Boolean(expiresAt)) && (!owner || !expiresAt);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!formValid || submitting) return;
    setSubmitting(true);
    setError('');
    try {
      const response = await fetchWithAuth('/api/company-access/requests/review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          requestId: request.id,
          decision,
          reviewNote: reviewNote.trim() || undefined,
          expiresAt: decision === 'approved' && expiresAt ? expiresAt : undefined,
        }),
      });
      const body = await response.json().catch(() => ({})) as Envelope<{ request?: { id: string; status: string } }>;
      if (!response.ok || !body.ok) {
        throw new Error(responseError(body, 'Request could not be reviewed.'));
      }
      onCompleted();
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Request could not be reviewed.');
      setSubmitting(false);
    }
  };

  return (
    <WorkflowDialog
      title={'Review access request'}
      eyebrow={'Approval decision'}
      description={'The server will re-check your authority over this exact profile and scope.'}
      lang={lang}
      onClose={onClose}
      busy={submitting}
    >
      <form className={styles.workflowForm} onSubmit={submit}>
        <section className={styles.mutationPreview}>
          <div className={styles.previewHeading}>
            <ShieldCheck size={17} aria-hidden="true" />
            <div><strong>{request.requesterName}</strong><span>{request.scopeLabel}</span></div>
          </div>
          <dl>
            <div><dt>{'Profile'}</dt><dd>{profileLabel(request.requestedProfile, lang)}</dd></div>
            <div><dt>{'Hotels affected'}</dt><dd>{request.propertyIds.length}</dd></div>
          </dl>
        </section>
        <label className={styles.formField}>
          <span>{'Decision'}</span>
          <select value={decision} onChange={(event) => setDecision(event.target.value as 'approved' | 'denied')}>
            <option value="approved">{'Approve'}</option>
            <option value="denied">{'Deny'}</option>
          </select>
        </label>
        {decision === 'approved' && !owner ? (
          <label className={styles.formField}>
            <span>{external ? 'Access expiration (required)' : 'Access expiration (optional)'}</span>
            <div className={styles.inputWithIcon}>
              <CalendarClock size={16} aria-hidden="true" />
              <input type="date" value={expiresAt} onChange={(event) => setExpiresAt(event.target.value)} min={new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)} required={external} />
            </div>
            {!expiryValid ? <small>{'Choose a future date.'}</small> : null}
          </label>
        ) : null}
        <label className={styles.formField}>
          <span>{decision === 'denied' ? 'Denial reason (required)' : 'Review note (optional)'}</span>
          <textarea value={reviewNote} onChange={(event) => setReviewNote(event.target.value)} rows={3} maxLength={1000} required={decision === 'denied'} />
        </label>
        {error ? <div className={styles.formError} role="alert">{error}</div> : null}
        <div className={styles.dialogFooter}>
          <span><KeyRound size={14} aria-hidden="true" />{decision === 'approved' ? 'Approval makes access active immediately' : 'A denial does not add access'}</span>
          <div className={styles.dialogActions}>
            <button type="button" className={styles.secondaryButton} onClick={onClose} disabled={submitting}>{'Cancel'}</button>
            <button type="submit" className={styles.primaryButton} disabled={!formValid || submitting}>
              {submitting ? <span className={styles.buttonSpinner} aria-hidden="true" /> : decision === 'approved' ? <CheckCircle2 size={15} aria-hidden="true" /> : <X size={15} aria-hidden="true" />}
              {submitting ? 'Saving…' : decision === 'approved' ? 'Approve access' : 'Deny request'}
            </button>
          </div>
        </div>
      </form>
    </WorkflowDialog>
  );
}

export function CompanyLifecycleDialog({ action, lang, onClose, onCompleted }: {
  action: CompanyLifecycleAction;
  lang: string;
  onClose: () => void;
  onCompleted: () => void;
}) {
  const [reason, setReason] = React.useState('');
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState('');
  const reasonValid = reason.trim().length >= 8 && reason.trim().length <= 500;
  const copyByKind = {
    revoke_grant: {
      title: 'Remove hotel access',
      eyebrow: 'Access change',
      description: 'This removes access for the selected hotel only. Other hotel access and hotel-operation roles stay unchanged.',
      confirm: 'Remove hotel access',
      endpoint: '/api/company-access/grants/revoke',
      body: { grantId: action.id },
    },
    suspend_membership: {
      title: 'Suspend company member',
      eyebrow: 'Temporary access hold',
      description: 'Company access stops immediately. The person and their current settings remain available for reactivation later.',
      confirm: 'Suspend access',
      endpoint: '/api/company-access/memberships/status',
      body: { membershipId: action.id, action: 'suspend' },
    },
    resume_membership: {
      title: 'Resume company member',
      eyebrow: 'Restore company access',
      description: 'Any still-valid company access becomes active again. Cancelled requests stay cancelled, and hotel-operation roles remain unchanged.',
      confirm: 'Reactivate access',
      endpoint: '/api/company-access/memberships/status',
      body: { membershipId: action.id, action: 'resume' },
    },
    remove_membership: {
      title: 'Remove company access',
      eyebrow: 'Permanent removal',
      description: 'The company access is closed, current access is removed, and pending access requests are cancelled. This does not delete the person from People.',
      confirm: 'Remove company access',
      endpoint: '/api/company-access/memberships/status',
      body: { membershipId: action.id, action: 'remove' },
    },
  }[action.kind];

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!reasonValid || submitting) return;
    setSubmitting(true);
    setError('');
    try {
      const response = await fetchWithAuth(copyByKind.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...copyByKind.body, reason: reason.trim() }),
      });
      const body = await response.json().catch(() => ({})) as Envelope<{ changed?: boolean }>;
      if (!response.ok || !body.ok) {
        throw new Error(responseError(body, 'The change could not be completed.'));
      }
      onCompleted();
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The change could not be completed.');
      setSubmitting(false);
    }
  };

  const destructive = action.kind !== 'suspend_membership' && action.kind !== 'resume_membership';
  return (
    <WorkflowDialog
      title={copyByKind.title}
      eyebrow={copyByKind.eyebrow}
      description={copyByKind.description}
      lang={lang}
      onClose={onClose}
      busy={submitting}
    >
      <form className={styles.workflowForm} onSubmit={submit}>
        <section className={`${styles.mutationPreview} ${styles.lifecyclePreview}`}>
          <div className={styles.previewHeading}>
            <AlertTriangle size={17} aria-hidden="true" />
            <div><strong>{action.targetLabel}</strong><span>{action.detailLabel}</span></div>
          </div>
        </section>
        <label className={styles.formField}>
          <span>{'Reason (required)'}</span>
          <textarea
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            rows={3}
            minLength={8}
            maxLength={500}
            placeholder={'Explain why this change is needed…'}
            required
          />
          <em>{reason.trim().length < 8
            ? 'Use at least 8 characters.'
            : `${reason.trim().length} / 500`}</em>
        </label>
        {error ? <div className={styles.formError} role="alert">{error}</div> : null}
        <div className={styles.dialogFooter}>
          <span><ShieldCheck size={14} aria-hidden="true" />{'Authority is checked again before saving'}</span>
          <div className={styles.dialogActions}>
            <button type="button" className={styles.secondaryButton} onClick={onClose} disabled={submitting}>{'Keep unchanged'}</button>
            <button type="submit" className={destructive ? styles.dangerButton : styles.primaryButton} disabled={!reasonValid || submitting}>
              {submitting
                ? <span className={styles.buttonSpinner} aria-hidden="true" />
                : action.kind === 'resume_membership'
                  ? <UserCheck size={15} aria-hidden="true" />
                  : <UserMinus size={15} aria-hidden="true" />}
              {submitting ? 'Saving…' : copyByKind.confirm}
            </button>
          </div>
        </div>
      </form>
    </WorkflowDialog>
  );
}
