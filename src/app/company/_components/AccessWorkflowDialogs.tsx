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
  | { kind: 'cancel_invitation'; id: string; targetLabel: string; detailLabel: string }
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

function copy(lang: string, en: string, es: string): string {
  return lang === 'es' ? es : en;
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
  const labels: Record<string, [string, string]> = {
    organization_owner: ['Organization Owner', 'Propietario de la organización'],
    organization_admin: ['Organization Administrator', 'Administrador de la organización'],
    portfolio_manager: ['Portfolio Manager', 'Gerente de cartera'],
    property_manager: ['Property Manager', 'Gerente de hotel'],
    department_lead: ['Department Lead', 'Líder de departamento'],
    contributor: ['Contributor', 'Colaborador'],
    viewer: ['Viewer', 'Lector'],
    external_collaborator: ['External Collaborator', 'Colaborador externo'],
  };
  const pair = labels[profile] ?? [titleCaseAccessValue(profile), titleCaseAccessValue(profile)];
  return copy(lang, pair[0], pair[1]);
}

function useDialogBehavior(onClose: () => void, busy = false) {
  const closeRef = React.useRef<HTMLButtonElement | null>(null);
  const dialogRef = React.useRef<HTMLDivElement | null>(null);
  const busyRef = React.useRef(busy);
  busyRef.current = busy;

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
        if (!busyRef.current) onClose();
        return;
      }
      if (event.key !== 'Tab' || !dialogRef.current) return;
      const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
      ));
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
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
  }, [onClose]);

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
        aria-label={copy(lang, 'Close dialog', 'Cerrar diálogo')}
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
            aria-label={copy(lang, 'Close', 'Cerrar')}
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

function delegationSelectionAllowed(
  data: CompanyAccessData,
  organizationId: string,
  profile: string,
  scope: ScopeSelection,
): boolean {
  const policy = data.permissions.delegationPolicies
    .find((candidate) => candidate.organizationId === organizationId)
    ?.profiles.find((candidate) => candidate.accessProfile === profile);
  if (!policy) return false;
  if (scope.type === 'organization') return policy.organizationScope && scope.targetId === organizationId;
  if (scope.type === 'portfolio') return policy.portfolioIds.includes(scope.targetId);
  return policy.propertyIds.includes(scope.targetId);
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
        <span>{copy(lang, 'Access scope', 'Alcance de acceso')}</span>
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
              ? copy(lang, 'Entire organization', 'Toda la organización')
              : type === 'portfolio'
                ? copy(lang, 'Portfolio or region', 'Cartera o región')
                : copy(lang, 'One hotel', 'Un hotel')}</option>
          ))}
        </select>
      </label>
      {scope.type !== 'organization' ? (
        <label className={styles.formField}>
          <span>{scope.type === 'portfolio' ? copy(lang, 'Portfolio / region', 'Cartera / región') : copy(lang, 'Hotel', 'Hotel')}</span>
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
    <section className={styles.mutationPreview} aria-label={copy(lang, 'Access preview', 'Vista previa de acceso')}>
      <div className={styles.previewHeading}>
        <ShieldCheck size={17} aria-hidden="true" />
        <div>
          <strong>{copy(lang, 'Exact access preview', 'Vista previa exacta del acceso')}</strong>
          <span>{copy(lang, 'Review before you send', 'Revisa antes de enviar')}</span>
        </div>
      </div>
      <dl>
        <div><dt>{copy(lang, 'Profile', 'Perfil')}</dt><dd>{profileLabel(profile, lang)}</dd></div>
        <div><dt>{copy(lang, 'Scope', 'Alcance')}</dt><dd>{scopeLabel || copy(lang, 'Select a scope', 'Selecciona un alcance')}</dd></div>
        <div><dt>{copy(lang, 'Hotels affected', 'Hoteles afectados')}</dt><dd>{hotels.length}</dd></div>
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

export function InvitePersonDialog({ data, lang, onClose, onCompleted }: {
  data: CompanyAccessData;
  lang: string;
  onClose: () => void;
  onCompleted: () => void;
}) {
  const delegatableOrganizationIds = new Set(data.permissions.delegationPolicies
    .filter((policy) => policy.profiles.length > 0)
    .map((policy) => policy.organizationId));
  const organizations = data.organizations.filter((organization) => delegatableOrganizationIds.has(organization.id));
  const [organizationId, setOrganizationId] = React.useState(organizations[0]?.id ?? '');
  const profiles = (data.permissions.delegationPolicies
    .find((policy) => policy.organizationId === organizationId)?.profiles ?? [])
    .map((policy) => policy.accessProfile)
    .filter((candidate) => PROFILE_OPTIONS.includes(candidate as typeof PROFILE_OPTIONS[number]));
  const [email, setEmail] = React.useState('');
  const [jobCategory, setJobCategory] = React.useState('operations');
  const [jobTitle, setJobTitle] = React.useState('');
  const [profile, setProfile] = React.useState(profiles[0] ?? '');
  const [scope, setScope] = React.useState<ScopeSelection>({ type: 'property', targetId: '' });
  const [expiresAt, setExpiresAt] = React.useState('');
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState('');
  const [success, setSuccess] = React.useState<{
    link: string | null;
    emailSent: boolean;
    emailError: string | null;
  } | null>(null);
  const [copied, setCopied] = React.useState(false);

  const emailValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
  const expiryAfterInvitationWindow = Boolean(expiresAt)
    && new Date(`${expiresAt}T23:59:59`).getTime() > Date.now() + 7 * 86_400_000;
  const expiryValid = profile === 'organization_owner'
    ? !expiresAt
    : profile === 'external_collaborator'
      ? expiryAfterInvitationWindow
      : !expiresAt || expiryAfterInvitationWindow;
  const formValid = Boolean(
    organizationId
    && emailValid
    && profile
    && delegationSelectionAllowed(data, organizationId, profile, scope)
    && expiryValid
  );

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!formValid || submitting) return;
    setSubmitting(true);
    setError('');
    try {
      const response = await fetchWithAuth('/api/company-access/invitations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          organizationId,
          email: email.trim().toLowerCase(),
          jobCategory: jobCategory || undefined,
          jobTitle: jobTitle.trim() || undefined,
          accessProfile: profile,
          scopeType: scope.type,
          portfolioId: scope.type === 'portfolio' ? scope.targetId : undefined,
          propertyId: scope.type === 'property' ? scope.targetId : undefined,
          expiresAt: expiresAt || undefined,
        }),
      });
      const body = await response.json().catch(() => ({})) as Envelope<InviteResponse>;
      if (!response.ok || !body.ok) {
        throw new Error(responseError(body, copy(lang, 'Invitation could not be created.', 'No se pudo crear la invitación.')));
      }
      setSuccess({
        link: body.data?.inviteLink ?? null,
        emailSent: body.data?.emailSent === true,
        emailError: body.data?.emailError ?? null,
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : copy(lang, 'Invitation could not be sent.', 'No se pudo enviar la invitación.'));
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
        title={success.emailSent ? copy(lang, 'Invitation sent', 'Invitación enviada') : copy(lang, 'Invitation ready', 'Invitación lista')}
        eyebrow={copy(lang, 'Success', 'Éxito')}
        description={copy(lang, 'The invitation is email-specific, single-use, and expires automatically.', 'La invitación es específica para el correo, de un solo uso y vence automáticamente.')}
        lang={lang}
        onClose={finish}
      >
        <div className={styles.successState} role="status">
          <span><CheckCircle2 size={30} aria-hidden="true" /></span>
          <h3>{success.emailSent ? copy(lang, 'Invitation sent', 'Invitación enviada') : copy(lang, 'Copy and share the secure link', 'Copia y comparte el enlace seguro')}</h3>
          <p>{email.trim().toLowerCase()}</p>
          {!success.emailSent ? <p>{success.emailError ?? copy(lang, 'Email delivery was unavailable. The invitation is still valid.', 'El envío de correo no estuvo disponible. La invitación sigue siendo válida.')}</p> : null}
          {success.link ? (
            <button
              type="button"
              className={styles.secondaryButton}
              onClick={async () => {
                await navigator.clipboard.writeText(success.link ?? '');
                setCopied(true);
              }}
            >
              <Copy size={15} aria-hidden="true" />
              {copied ? copy(lang, 'Link copied', 'Enlace copiado') : copy(lang, 'Copy invite link', 'Copiar enlace de invitación')}
            </button>
          ) : null}
        </div>
        <div className={styles.dialogFooter}>
          <span><ShieldCheck size={14} aria-hidden="true" />{copy(lang, 'Access stays pending until accepted', 'El acceso permanece pendiente hasta ser aceptado')}</span>
          <button type="button" className={styles.primaryButton} onClick={finish}>{copy(lang, 'Done', 'Listo')}</button>
        </div>
      </WorkflowDialog>
    );
  }

  return (
    <WorkflowDialog
      title={copy(lang, 'Invite a person', 'Invitar a una persona')}
      eyebrow={copy(lang, 'New company access', 'Nuevo acceso de empresa')}
      description={copy(lang, 'A job title never grants access. Choose the profile and exact scope separately.', 'Un cargo nunca concede acceso. Elige el perfil y el alcance exacto por separado.')}
      lang={lang}
      onClose={onClose}
      busy={submitting}
    >
      <form className={styles.workflowForm} onSubmit={submit}>
        <div className={styles.formGrid}>
          <label className={styles.formField}>
            <span>{copy(lang, 'Email address', 'Correo electrónico')}</span>
            <input
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="name@company.com"
              autoComplete="email"
              required
              aria-invalid={email.length > 0 && !emailValid}
            />
            {email.length > 0 && !emailValid ? <small>{copy(lang, 'Enter a valid email.', 'Ingresa un correo válido.')}</small> : null}
          </label>
          <label className={styles.formField}>
            <span>{copy(lang, 'Organization', 'Organización')}</span>
            <select value={organizationId} onChange={(event) => {
              const nextOrganizationId = event.target.value;
              const nextProfile = data.permissions.delegationPolicies
                .find((policy) => policy.organizationId === nextOrganizationId)?.profiles[0]?.accessProfile ?? '';
              setOrganizationId(nextOrganizationId);
              setProfile(nextProfile);
              if (nextProfile === 'organization_owner') setExpiresAt('');
              setScope({ type: 'property', targetId: '' });
            }}>
              {organizations.map((organization) => <option key={organization.id} value={organization.id}>{organization.name}</option>)}
            </select>
          </label>
        </div>

        <div className={styles.formGrid}>
          <label className={styles.formField}>
            <span>{copy(lang, 'Job category', 'Categoría de trabajo')}</span>
            <select value={jobCategory} onChange={(event) => setJobCategory(event.target.value)}>
              {JOB_CATEGORIES.map((category) => <option key={category} value={category}>{titleCaseAccessValue(category)}</option>)}
            </select>
          </label>
          <label className={styles.formField}>
            <span>{copy(lang, 'Exact job title', 'Cargo exacto')}</span>
            <input type="text" value={jobTitle} onChange={(event) => setJobTitle(event.target.value)} placeholder={copy(lang, 'e.g. Regional Manager', 'p. ej., Gerente regional')} />
          </label>
        </div>

        <label className={styles.formField}>
          <span>{copy(lang, 'Access profile', 'Perfil de acceso')}</span>
          <select
            value={profile}
            onChange={(event) => {
              const nextProfile = event.target.value;
              setProfile(nextProfile);
              if (nextProfile === 'organization_owner') setExpiresAt('');
            }}
          >
            {profiles.map((option) => <option key={option} value={option}>{profileLabel(option, lang)}</option>)}
          </select>
          <em>{copy(lang, 'Only profiles you are allowed to grant are listed.', 'Solo se muestran los perfiles que puedes conceder.')}</em>
        </label>

        <ScopeFields data={data} organizationId={organizationId} profile={profile} scope={scope} onScopeChange={setScope} lang={lang} mode="grant" />

        <label className={styles.formField}>
            <span>{profile === 'external_collaborator'
              ? copy(lang, 'Expiration (required)', 'Vencimiento (obligatorio)')
              : profile === 'organization_owner'
                ? copy(lang, 'Expiration', 'Vencimiento')
                : copy(lang, 'Expiration (optional)', 'Vencimiento (opcional)')}</span>
            <div className={styles.inputWithIcon}>
              <CalendarClock size={16} aria-hidden="true" />
              <input
                type="date"
                value={expiresAt}
                onChange={(event) => setExpiresAt(event.target.value)}
                min={new Date(Date.now() + 8 * 86_400_000).toISOString().slice(0, 10)}
                required={profile === 'external_collaborator'}
                disabled={profile === 'organization_owner'}
              />
            </div>
            {profile === 'organization_owner' ? <em>{copy(lang, 'Owner access cannot expire.', 'El acceso del propietario no puede vencer.')}</em> : null}
            {!expiryValid ? <small>{profile === 'external_collaborator' && !expiresAt
              ? copy(lang, 'External access requires an expiration date.', 'El acceso externo requiere una fecha de vencimiento.')
              : copy(lang, 'Choose a date after the seven-day invitation window.', 'Elige una fecha posterior al período de invitación de siete días.')}</small> : null}
        </label>

        <ScopePreview data={data} organizationId={organizationId} profile={profile} scope={scope} lang={lang} />
        {error ? <div className={styles.formError} role="alert">{error}</div> : null}
        <div className={styles.dialogFooter}>
          <span><ShieldCheck size={14} aria-hidden="true" />{copy(lang, 'The server re-checks your authority', 'El servidor vuelve a verificar tu autoridad')}</span>
          <div className={styles.dialogActions}>
            <button type="button" className={styles.secondaryButton} onClick={onClose} disabled={submitting}>{copy(lang, 'Cancel', 'Cancelar')}</button>
            <button type="submit" className={styles.primaryButton} disabled={!formValid || submitting}>
              {submitting ? <span className={styles.buttonSpinner} aria-hidden="true" /> : <Send size={15} aria-hidden="true" />}
              {submitting ? copy(lang, 'Sending…', 'Enviando…') : copy(lang, 'Send invitation', 'Enviar invitación')}
            </button>
          </div>
        </div>
      </form>
    </WorkflowDialog>
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
        throw new Error(responseError(body, copy(lang, 'Request could not be submitted.', 'No se pudo enviar la solicitud.')));
      }
      setSuccess(true);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : copy(lang, 'Request could not be submitted.', 'No se pudo enviar la solicitud.'));
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
        title={copy(lang, 'Request submitted', 'Solicitud enviada')}
        eyebrow={copy(lang, 'Pending review', 'Pendiente de revisión')}
        description={copy(lang, 'The requested access is not active until an authorized manager approves it.', 'El acceso solicitado no está activo hasta que un gerente autorizado lo apruebe.')}
        lang={lang}
        onClose={finish}
      >
        <div className={styles.successState} role="status">
          <span><CheckCircle2 size={30} aria-hidden="true" /></span>
          <h3>{copy(lang, 'Your request is in review', 'Tu solicitud está en revisión')}</h3>
          <p>{profileLabel(profile, lang)}</p>
        </div>
        <div className={styles.dialogFooter}>
          <span><KeyRound size={14} aria-hidden="true" />{copy(lang, 'No access has been granted yet', 'Aún no se ha concedido acceso')}</span>
          <button type="button" className={styles.primaryButton} onClick={finish}>{copy(lang, 'Done', 'Listo')}</button>
        </div>
      </WorkflowDialog>
    );
  }

  return (
    <WorkflowDialog
      title={copy(lang, 'Request access', 'Solicitar acceso')}
      eyebrow={copy(lang, 'Approval required', 'Se requiere aprobación')}
      description={copy(lang, 'Choose the exact profile and scope you need. Your request does not grant access by itself.', 'Elige el perfil y el alcance exactos que necesitas. Tu solicitud no concede acceso por sí sola.')}
      lang={lang}
      onClose={onClose}
      busy={submitting}
    >
      <form className={styles.workflowForm} onSubmit={submit}>
        <div className={styles.formGrid}>
          <label className={styles.formField}>
            <span>{copy(lang, 'Organization', 'Organización')}</span>
            <select value={organizationId} onChange={(event) => { setOrganizationId(event.target.value); setScope({ type: 'property', targetId: '' }); }}>
              {organizations.map((organization) => <option key={organization.id} value={organization.id}>{organization.name}</option>)}
            </select>
          </label>
          <label className={styles.formField}>
            <span>{copy(lang, 'Requested profile', 'Perfil solicitado')}</span>
            <select value={profile} onChange={(event) => setProfile(event.target.value)}>
              {PROFILE_OPTIONS.map((option) => <option key={option} value={option}>{profileLabel(option, lang)}</option>)}
            </select>
          </label>
        </div>
        <ScopeFields data={data} organizationId={organizationId} profile={profile} scope={scope} onScopeChange={setScope} lang={lang} mode="request" />
        <label className={styles.formField}>
          <span>{copy(lang, 'Why do you need this access?', '¿Por qué necesitas este acceso?')}</span>
          <textarea value={reason} onChange={(event) => setReason(event.target.value)} rows={3} maxLength={500} placeholder={copy(lang, 'Explain the work you need to complete…', 'Explica el trabajo que necesitas completar…')} required />
          <em>{reason.trim().length < 8 ? copy(lang, 'Use at least 8 characters.', 'Usa al menos 8 caracteres.') : `${reason.length} / 500`}</em>
        </label>
        <ScopePreview data={data} organizationId={organizationId} profile={profile} scope={scope} lang={lang} />
        {error ? <div className={styles.formError} role="alert">{error}</div> : null}
        <div className={styles.dialogFooter}>
          <span><KeyRound size={14} aria-hidden="true" />{copy(lang, 'Pending until approved', 'Pendiente hasta su aprobación')}</span>
          <div className={styles.dialogActions}>
            <button type="button" className={styles.secondaryButton} onClick={onClose} disabled={submitting}>{copy(lang, 'Cancel', 'Cancelar')}</button>
            <button type="submit" className={styles.primaryButton} disabled={!formValid || submitting}>
              {submitting ? <span className={styles.buttonSpinner} aria-hidden="true" /> : <Send size={15} aria-hidden="true" />}
              {submitting ? copy(lang, 'Submitting…', 'Enviando…') : copy(lang, 'Submit request', 'Enviar solicitud')}
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
        throw new Error(responseError(body, copy(lang, 'Request could not be reviewed.', 'No se pudo revisar la solicitud.')));
      }
      onCompleted();
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : copy(lang, 'Request could not be reviewed.', 'No se pudo revisar la solicitud.'));
      setSubmitting(false);
    }
  };

  return (
    <WorkflowDialog
      title={copy(lang, 'Review access request', 'Revisar solicitud de acceso')}
      eyebrow={copy(lang, 'Approval decision', 'Decisión de aprobación')}
      description={copy(lang, 'The server will re-check your authority over this exact profile and scope.', 'El servidor volverá a verificar tu autoridad sobre este perfil y alcance exactos.')}
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
            <div><dt>{copy(lang, 'Profile', 'Perfil')}</dt><dd>{profileLabel(request.requestedProfile, lang)}</dd></div>
            <div><dt>{copy(lang, 'Hotels affected', 'Hoteles afectados')}</dt><dd>{request.propertyIds.length}</dd></div>
          </dl>
        </section>
        <label className={styles.formField}>
          <span>{copy(lang, 'Decision', 'Decisión')}</span>
          <select value={decision} onChange={(event) => setDecision(event.target.value as 'approved' | 'denied')}>
            <option value="approved">{copy(lang, 'Approve', 'Aprobar')}</option>
            <option value="denied">{copy(lang, 'Deny', 'Rechazar')}</option>
          </select>
        </label>
        {decision === 'approved' && !owner ? (
          <label className={styles.formField}>
            <span>{external ? copy(lang, 'Access expiration (required)', 'Vencimiento del acceso (obligatorio)') : copy(lang, 'Access expiration (optional)', 'Vencimiento del acceso (opcional)')}</span>
            <div className={styles.inputWithIcon}>
              <CalendarClock size={16} aria-hidden="true" />
              <input type="date" value={expiresAt} onChange={(event) => setExpiresAt(event.target.value)} min={new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)} required={external} />
            </div>
            {!expiryValid ? <small>{copy(lang, 'Choose a future date.', 'Elige una fecha futura.')}</small> : null}
          </label>
        ) : null}
        <label className={styles.formField}>
          <span>{decision === 'denied' ? copy(lang, 'Denial reason (required)', 'Motivo del rechazo (obligatorio)') : copy(lang, 'Review note (optional)', 'Nota de revisión (opcional)')}</span>
          <textarea value={reviewNote} onChange={(event) => setReviewNote(event.target.value)} rows={3} maxLength={1000} required={decision === 'denied'} />
        </label>
        {error ? <div className={styles.formError} role="alert">{error}</div> : null}
        <div className={styles.dialogFooter}>
          <span><KeyRound size={14} aria-hidden="true" />{decision === 'approved' ? copy(lang, 'Approval grants access immediately', 'La aprobación concede acceso inmediatamente') : copy(lang, 'Denial grants no access', 'El rechazo no concede acceso')}</span>
          <div className={styles.dialogActions}>
            <button type="button" className={styles.secondaryButton} onClick={onClose} disabled={submitting}>{copy(lang, 'Cancel', 'Cancelar')}</button>
            <button type="submit" className={styles.primaryButton} disabled={!formValid || submitting}>
              {submitting ? <span className={styles.buttonSpinner} aria-hidden="true" /> : decision === 'approved' ? <CheckCircle2 size={15} aria-hidden="true" /> : <X size={15} aria-hidden="true" />}
              {submitting ? copy(lang, 'Saving…', 'Guardando…') : decision === 'approved' ? copy(lang, 'Approve access', 'Aprobar acceso') : copy(lang, 'Deny request', 'Rechazar solicitud')}
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
      title: copy(lang, 'Revoke access grant', 'Revocar concesión de acceso'),
      eyebrow: copy(lang, 'Access change', 'Cambio de acceso'),
      description: copy(lang, 'This removes only the selected Company Hub grant. Other grants and hotel-operation roles stay unchanged.', 'Esto elimina solo la concesión seleccionada del Centro de empresa. Las demás concesiones y funciones operativas del hotel no cambian.'),
      confirm: copy(lang, 'Revoke grant', 'Revocar concesión'),
      endpoint: '/api/company-access/grants/revoke',
      body: { grantId: action.id },
    },
    cancel_invitation: {
      title: copy(lang, 'Cancel invitation', 'Cancelar invitación'),
      eyebrow: copy(lang, 'Pending invitation', 'Invitación pendiente'),
      description: copy(lang, 'The invitation link will stop working and no access will be granted.', 'El enlace de invitación dejará de funcionar y no se concederá acceso.'),
      confirm: copy(lang, 'Cancel invitation', 'Cancelar invitación'),
      endpoint: '/api/company-access/invitations/cancel',
      body: { invitationId: action.id },
    },
    suspend_membership: {
      title: copy(lang, 'Suspend company member', 'Suspender miembro de la empresa'),
      eyebrow: copy(lang, 'Temporary access hold', 'Suspensión temporal de acceso'),
      description: copy(lang, 'Company Hub access stops immediately. The membership and its grants remain on record for a future reactivation workflow.', 'El acceso al Centro de empresa se detiene de inmediato. La membresía y sus concesiones permanecen registradas para una futura reactivación.'),
      confirm: copy(lang, 'Suspend member', 'Suspender miembro'),
      endpoint: '/api/company-access/memberships/status',
      body: { membershipId: action.id, action: 'suspend' },
    },
    resume_membership: {
      title: copy(lang, 'Resume company member', 'Reactivar miembro de la empresa'),
      eyebrow: copy(lang, 'Restore Company Hub access', 'Restaurar acceso al Centro de empresa'),
      description: copy(lang, 'Any still-valid Company Hub grants become effective again. Cancelled requests stay cancelled, and hotel-operation roles remain unchanged.', 'Las concesiones del Centro de empresa que aún sean válidas vuelven a ser efectivas. Las solicitudes canceladas siguen canceladas y las funciones operativas del hotel no cambian.'),
      confirm: copy(lang, 'Resume member', 'Reactivar miembro'),
      endpoint: '/api/company-access/memberships/status',
      body: { membershipId: action.id, action: 'resume' },
    },
    remove_membership: {
      title: copy(lang, 'Remove company member', 'Eliminar miembro de la empresa'),
      eyebrow: copy(lang, 'Permanent removal', 'Eliminación permanente'),
      description: copy(lang, 'The membership is closed, all of its Company Hub grants are revoked, and pending access requests are cancelled.', 'La membresía se cierra, se revocan todas sus concesiones del Centro de empresa y se cancelan las solicitudes pendientes.'),
      confirm: copy(lang, 'Remove member', 'Eliminar miembro'),
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
        throw new Error(responseError(body, copy(lang, 'The change could not be completed.', 'No se pudo completar el cambio.')));
      }
      onCompleted();
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : copy(lang, 'The change could not be completed.', 'No se pudo completar el cambio.'));
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
          <span>{copy(lang, 'Reason (required)', 'Motivo (obligatorio)')}</span>
          <textarea
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            rows={3}
            minLength={8}
            maxLength={500}
            placeholder={copy(lang, 'Explain why this change is needed…', 'Explica por qué se necesita este cambio…')}
            required
          />
          <em>{reason.trim().length < 8
            ? copy(lang, 'Use at least 8 characters.', 'Usa al menos 8 caracteres.')
            : `${reason.trim().length} / 500`}</em>
        </label>
        {error ? <div className={styles.formError} role="alert">{error}</div> : null}
        <div className={styles.dialogFooter}>
          <span><ShieldCheck size={14} aria-hidden="true" />{copy(lang, 'Authority is checked again before saving', 'La autoridad se verifica de nuevo antes de guardar')}</span>
          <div className={styles.dialogActions}>
            <button type="button" className={styles.secondaryButton} onClick={onClose} disabled={submitting}>{copy(lang, 'Keep unchanged', 'Mantener sin cambios')}</button>
            <button type="submit" className={destructive ? styles.dangerButton : styles.primaryButton} disabled={!reasonValid || submitting}>
              {submitting
                ? <span className={styles.buttonSpinner} aria-hidden="true" />
                : action.kind === 'resume_membership'
                  ? <UserCheck size={15} aria-hidden="true" />
                  : <UserMinus size={15} aria-hidden="true" />}
              {submitting ? copy(lang, 'Saving…', 'Guardando…') : copyByKind.confirm}
            </button>
          </div>
        </div>
      </form>
    </WorkflowDialog>
  );
}
