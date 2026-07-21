'use client';

import React from 'react';
import { createPortal } from 'react-dom';
import {
  AlertCircle,
  Clock3,
  KeyRound,
  Pencil,
  RefreshCw,
  ShieldCheck,
  Trash2,
  UserCheck,
  UserPlus,
  Users,
} from 'lucide-react';

import type { AppUser } from '@/contexts/AuthContext';
import { fetchWithAuth } from '@/lib/api-fetch';
import type { AppRole } from '@/lib/roles';
import type { StaffMember } from '@/types';

import styles from './HotelTeamPanel.module.css';

export type HotelTeamLang = 'en' | 'es';

export interface HotelTeamActionFlags {
  canEditProfile?: boolean;
  canChangeRole?: boolean;
  canResetPassword?: boolean;
  canRemove?: boolean;
  canRemoveHotelAccess?: boolean;
  reason?: string | null;
}

export interface HotelTeamMember {
  accountId: string;
  username: string;
  displayName: string;
  email: string;
  role: AppRole;
  propertyAccess: string[];
  staffId: string | null;
  createdAt?: string;
  isSelf?: boolean;
  isPlatformAdmin?: boolean;
  hotelAccessCount?: number | null;
  hasOtherHotelAccess?: boolean;
  globalImpact?: {
    displayNameAffectsAllHotels: boolean;
    roleAffectsAllHotels: boolean;
    passwordAffectsAllHotels: boolean;
    hotelAccessCount: number | null;
    hasOtherHotelAccess: boolean;
  };
  /** Newer API responses can override conservative client fallbacks. */
  actions?: HotelTeamActionFlags;
  canEditProfile?: boolean;
  canChangeRole?: boolean;
  canResetPassword?: boolean;
  canRemove?: boolean;
}

export interface HotelJoinRequest {
  id: string;
  name: string;
  phone: string | null;
  language: HotelTeamLang;
  department: string;
  created_at: string;
}

export type HotelTeamLinkageState =
  | { status: 'loading' }
  | { status: 'ready'; staffIds: string[] }
  | { status: 'error' }
  | { status: 'unavailable' };

export interface HotelTeamPanelProps {
  /** The exact hotel being managed. Never falls back to the app-wide hotel. */
  hotelId: string;
  hotelName: string;
  currentUser: AppUser;
  /** Useful for preview shells whose effective account differs from AppUser. */
  currentAccountId?: string;
  lang: HotelTeamLang;
  canManageTeam: boolean;
  readOnly?: boolean;
  adminPreview?: boolean;
  /** Unlocks only the separately authorized hotel-team routes while keeping
   * the admin preview DTO and company-access mutations read-only. */
  allowAdminActions?: boolean;
  staffProfiles?: StaffMember[];
  onChanged?: () => void | Promise<void>;
  /** Tri-state result prevents the parent from calling staff "unlinked" before this request succeeds. */
  onLinkageChange?: (state: HotelTeamLinkageState) => void;
}

interface Envelope<T> {
  ok?: boolean;
  data?: T;
  error?: unknown;
}

interface ResolvedActions {
  canEdit: boolean;
  canChangeRole: boolean;
  canResetPassword: boolean;
  canRemove: boolean;
  roleIsSharedAcrossHotels: boolean;
}

const LazyMemberDialog = React.lazy(async () => {
  const dialogs = await import('./HotelTeamDialogs');
  return { default: dialogs.HotelMemberDialog };
});

const LazyRemoveDialog = React.lazy(async () => {
  const dialogs = await import('./HotelTeamDialogs');
  return { default: dialogs.RemoveHotelAccessDialog };
});

const LazyInviteDialog = React.lazy(async () => {
  const dialogs = await import('./HotelTeamDialogs');
  return { default: dialogs.HotelInviteDialog };
});

const LazyDecisionDialog = React.lazy(async () => {
  const dialogs = await import('./HotelTeamDialogs');
  return { default: dialogs.JoinDecisionDialog };
});

function copy(lang: HotelTeamLang, en: string, es: string): string {
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

function roleLabel(role: AppRole, lang: HotelTeamLang): string {
  const labels: Record<AppRole, [string, string]> = {
    admin: ['Staxis administrator', 'Administrador de Staxis'],
    owner: ['Owner', 'Propietario'],
    general_manager: ['General Manager', 'Gerente general'],
    front_desk: ['Front Desk', 'Recepción'],
    housekeeping: ['Housekeeping', 'Limpieza'],
    maintenance: ['Maintenance', 'Mantenimiento'],
    staff: ['Staff', 'Personal'],
  };
  const pair = labels[role] ?? [role, role];
  return copy(lang, pair[0], pair[1]);
}

function departmentLabel(value: string, lang: HotelTeamLang): string {
  const labels: Record<string, [string, string]> = {
    front_desk: ['Front Desk', 'Recepción'],
    housekeeping: ['Housekeeping', 'Limpieza'],
    maintenance: ['Maintenance', 'Mantenimiento'],
    other: ['Other', 'Otro'],
  };
  const pair = labels[value];
  if (pair) return copy(lang, pair[0], pair[1]);
  return value.replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  return `${parts[0]?.[0] ?? ''}${parts.length > 1 ? parts.at(-1)?.[0] ?? '' : ''}`.toUpperCase();
}

function timeAgo(value: string, lang: HotelTeamLang): string {
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return copy(lang, 'Recently', 'Recientemente');
  const minutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60_000));
  if (minutes < 1) return copy(lang, 'Just now', 'Ahora mismo');
  if (minutes < 60) return copy(lang, `${minutes} min ago`, `Hace ${minutes} min`);
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return copy(lang, `${hours}h ago`, `Hace ${hours} h`);
  const days = Math.floor(hours / 24);
  return copy(lang, `${days}d ago`, `Hace ${days} d`);
}

function actionFlag(
  member: HotelTeamMember,
  actionKeys: Array<keyof HotelTeamActionFlags>,
  topLevel: 'canEditProfile' | 'canChangeRole' | 'canResetPassword' | 'canRemove',
  fallback: boolean,
): boolean {
  for (const key of actionKeys) {
    const value = member.actions?.[key];
    if (typeof value === 'boolean') return value;
  }
  const topLevelValue = member[topLevel];
  return typeof topLevelValue === 'boolean' ? topLevelValue : fallback;
}

function resolveActions(
  member: HotelTeamMember,
  currentUser: AppUser,
  currentAccountId: string,
  locked: boolean,
): ResolvedActions {
  const self = member.accountId === currentAccountId;
  const adminTarget = member.isPlatformAdmin === true || member.role === 'admin';
  const viewerIsAdmin = currentUser.role === 'admin';
  const viewerIsOwner = currentUser.role === 'owner';
  const viewerIsGm = currentUser.role === 'general_manager';
  const targetAboveGm = member.role === 'owner' || member.role === 'general_manager';
  const hierarchyAllows = viewerIsAdmin || viewerIsOwner || (viewerIsGm && !targetAboveGm);
  const hotelIds = member.propertyAccess.filter((id) => id !== '*');
  const roleIsSharedAcrossHotels = member.hasOtherHotelAccess ?? hotelIds.length > 1;
  const viewerHotels = new Set(currentUser.propertyAccess);
  const viewerControlsEveryHotel = viewerIsAdmin
    || viewerHotels.has('*')
    || hotelIds.every((id) => viewerHotels.has(id));

  // These floors are deliberately stricter than presentation flags. A stale
  // or over-permissive API flag must never expose admin, self-removal, or
  // cross-hotel credential actions.
  const editFloor = !locked && !adminTarget && (self || hierarchyAllows);
  const editFallback = editFloor;
  const canEdit = editFloor && actionFlag(member, ['canEditProfile'], 'canEditProfile', editFallback);
  const roleFloor = canEdit && !self;
  const canChangeRole = roleFloor
    && actionFlag(member, ['canChangeRole'], 'canChangeRole', roleFloor);
  const passwordFloor = canEdit && self;
  const canResetPassword = passwordFloor
    && actionFlag(member, ['canResetPassword'], 'canResetPassword', passwordFloor);
  const removeFloor = !locked && !self && !adminTarget && hierarchyAllows;
  const canRemove = removeFloor
    && actionFlag(member, ['canRemoveHotelAccess', 'canRemove'], 'canRemove', removeFloor);

  return { canEdit, canChangeRole, canResetPassword, canRemove, roleIsSharedAcrossHotels };
}

function DialogLoading({ lang }: { lang: HotelTeamLang }) {
  return createPortal(
    <div className={styles.dialogLoading} role="status">
      <span className={styles.spinner} aria-hidden="true" />
      {copy(lang, 'Opening…', 'Abriendo…')}
    </div>,
    document.body,
  );
}

export function HotelTeamPanel({
  hotelId,
  hotelName,
  currentUser,
  currentAccountId = currentUser.accountId,
  lang,
  canManageTeam,
  readOnly = false,
  adminPreview = false,
  allowAdminActions = false,
  staffProfiles = [],
  onChanged,
  onLinkageChange,
}: HotelTeamPanelProps) {
  const [team, setTeam] = React.useState<HotelTeamMember[]>([]);
  const [teamLoading, setTeamLoading] = React.useState(false);
  const [teamError, setTeamError] = React.useState('');
  const [requests, setRequests] = React.useState<HotelJoinRequest[]>([]);
  const [requestsLoading, setRequestsLoading] = React.useState(false);
  const [requestsError, setRequestsError] = React.useState('');
  const [editMember, setEditMember] = React.useState<HotelTeamMember | null>(null);
  const [removeMember, setRemoveMember] = React.useState<HotelTeamMember | null>(null);
  const [decision, setDecision] = React.useState<{
    request: HotelJoinRequest;
    decision: 'approve' | 'deny';
  } | null>(null);
  const [inviteOpen, setInviteOpen] = React.useState(false);

  const teamAbortRef = React.useRef<AbortController | null>(null);
  const requestAbortRef = React.useRef<AbortController | null>(null);
  const teamSequenceRef = React.useRef(0);
  const requestSequenceRef = React.useRef(0);
  const changedRef = React.useRef(onChanged);
  const linkageRef = React.useRef(onLinkageChange);
  changedRef.current = onChanged;
  linkageRef.current = onLinkageChange;

  const staffById = React.useMemo(
    () => new Map(staffProfiles.map((member) => [member.id, member])),
    [staffProfiles],
  );

  const locked = readOnly || (adminPreview && !allowAdminActions);

  const loadTeam = React.useCallback(async (clearFirst = false) => {
    teamAbortRef.current?.abort();
    const controller = new AbortController();
    teamAbortRef.current = controller;
    const sequence = ++teamSequenceRef.current;

    if (!hotelId || !canManageTeam) {
      setTeam([]);
      setTeamLoading(false);
      setTeamError('');
      linkageRef.current?.({ status: 'unavailable' });
      return;
    }

    linkageRef.current?.({ status: 'loading' });
    if (clearFirst) {
      setTeam([]);
    }
    setTeamLoading(true);
    setTeamError('');
    try {
      const response = await fetchWithAuth(`/api/auth/team?hotelId=${encodeURIComponent(hotelId)}`, {
        signal: controller.signal,
      });
      const body = await response.json().catch(() => ({})) as Envelope<{ team?: HotelTeamMember[] }>;
      if (!response.ok || !body.ok) {
        throw new Error(responseError(
          body,
          copy(lang, "Couldn't load hotel accounts.", 'No se pudieron cargar las cuentas del hotel.'),
        ));
      }
      if (controller.signal.aborted || sequence !== teamSequenceRef.current) return;
      const responseTeam = body.data?.team ?? [];
      const nextTeam = (adminPreview || readOnly)
        ? responseTeam.filter((member) => !member.isPlatformAdmin && member.role !== 'admin')
        : responseTeam;
      setTeam(nextTeam);
      linkageRef.current?.({
        status: 'ready',
        staffIds: nextTeam.flatMap((member) => member.staffId ? [member.staffId] : []),
      });
    } catch (error) {
      if (controller.signal.aborted || sequence !== teamSequenceRef.current) return;
      console.error('[HotelTeamPanel] team load failed', error);
      setTeam([]);
      linkageRef.current?.({ status: 'error' });
      setTeamError(error instanceof Error && error.message
        ? error.message
        : copy(lang, "Couldn't load hotel accounts. Check your connection and try again.", 'No se pudieron cargar las cuentas. Revisa tu conexión e intenta de nuevo.'));
    } finally {
      if (!controller.signal.aborted && sequence === teamSequenceRef.current) setTeamLoading(false);
    }
  }, [adminPreview, canManageTeam, hotelId, lang, readOnly]);

  const loadRequests = React.useCallback(async (clearFirst = false) => {
    requestAbortRef.current?.abort();
    const controller = new AbortController();
    requestAbortRef.current = controller;
    const sequence = ++requestSequenceRef.current;

    if (!hotelId || !canManageTeam) {
      setRequests([]);
      setRequestsLoading(false);
      setRequestsError('');
      return;
    }

    if (clearFirst) setRequests([]);
    setRequestsLoading(true);
    setRequestsError('');
    try {
      const response = await fetchWithAuth(`/api/staff/join-requests?hotelId=${encodeURIComponent(hotelId)}`, {
        signal: controller.signal,
      });
      const body = await response.json().catch(() => ({})) as Envelope<{ requests?: HotelJoinRequest[] }>;
      if (!response.ok || !body.ok) {
        throw new Error(responseError(
          body,
          copy(lang, "Couldn't load pending approvals.", 'No se pudieron cargar las aprobaciones pendientes.'),
        ));
      }
      if (controller.signal.aborted || sequence !== requestSequenceRef.current) return;
      setRequests(body.data?.requests ?? []);
    } catch (error) {
      if (controller.signal.aborted || sequence !== requestSequenceRef.current) return;
      console.error('[HotelTeamPanel] join-request load failed', error);
      setRequests([]);
      setRequestsError(error instanceof Error && error.message
        ? error.message
        : copy(lang, "Couldn't load pending approvals. Check your connection and try again.", 'No se pudieron cargar las aprobaciones. Revisa tu conexión e intenta de nuevo.'));
    } finally {
      if (!controller.signal.aborted && sequence === requestSequenceRef.current) setRequestsLoading(false);
    }
  }, [canManageTeam, hotelId, lang]);

  React.useEffect(() => {
    void loadTeam(true);
    return () => teamAbortRef.current?.abort();
  }, [loadTeam]);

  React.useEffect(() => {
    void loadRequests(true);
    return () => requestAbortRef.current?.abort();
  }, [loadRequests]);

  React.useEffect(() => () => linkageRef.current?.({ status: 'unavailable' }), []);

  const refreshAfterChange = React.useCallback(async () => {
    await Promise.all([loadTeam(), loadRequests()]);
    await changedRef.current?.();
  }, [loadRequests, loadTeam]);

  if (!hotelId) {
    return (
      <section className={styles.root} aria-labelledby="hotel-team-title">
        <div className={styles.emptyState}>
          <span><ShieldCheck size={22} aria-hidden="true" /></span>
          <h3 id="hotel-team-title">{copy(lang, 'Choose one hotel', 'Elige un hotel')}</h3>
          <p>{copy(lang, 'Select the exact hotel before viewing or changing its accounts.', 'Selecciona el hotel exacto antes de ver o cambiar sus cuentas.')}</p>
        </div>
      </section>
    );
  }

  if (!canManageTeam) {
    return (
      <section className={styles.root} aria-labelledby="hotel-team-title">
        <div className={styles.permissionState}>
          <span><KeyRound size={20} aria-hidden="true" /></span>
          <div>
            <h3 id="hotel-team-title">{copy(lang, 'Hotel account settings are private', 'La configuración de cuentas del hotel es privada')}</h3>
            <p>{copy(lang, 'An owner or general manager can manage team logins and invitations.', 'Un propietario o gerente general puede administrar los accesos y las invitaciones del equipo.')}</p>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className={styles.root} aria-labelledby="hotel-team-title">
      <div className={styles.headingRow}>
        <div className={styles.headingCopy}>
          <span>{copy(lang, 'Hotel accounts', 'Cuentas del hotel')}</span>
          <h2 id="hotel-team-title">{copy(lang, 'Team logins and invitations', 'Accesos e invitaciones del equipo')}</h2>
          <p>{copy(
            lang,
            `Manage only the accounts connected to ${hotelName}. Company access stays separate.`,
            `Administra solo las cuentas conectadas a ${hotelName}. El acceso de la empresa permanece separado.`,
          )}</p>
        </div>
        <button
          type="button"
          className={styles.primaryButton}
          onClick={() => setInviteOpen(true)}
          disabled={locked}
          title={locked ? copy(lang, 'Unavailable in read-only preview', 'No disponible en la vista de solo lectura') : undefined}
        >
          <UserPlus size={16} aria-hidden="true" />
          {copy(lang, 'Invite staff', 'Invitar personal')}
        </button>
      </div>

      <section className={styles.subsection} aria-labelledby="team-members-title">
        <div className={styles.subheading}>
          <div>
            <span>{copy(lang, 'Access roster', 'Registro de acceso')}</span>
            <h3 id="team-members-title">{copy(lang, 'Hotel team accounts', 'Cuentas del equipo del hotel')}</h3>
          </div>
          {!teamLoading && !teamError ? <strong>{team.length}</strong> : null}
        </div>

        {teamLoading ? (
          <div className={styles.skeletonList} role="status" aria-label={copy(lang, 'Loading hotel accounts', 'Cargando cuentas del hotel')}>
            {[0, 1, 2].map((item) => <span key={item} />)}
          </div>
        ) : teamError ? (
          <div className={styles.errorState} role="alert">
            <AlertCircle size={18} aria-hidden="true" />
            <div><strong>{copy(lang, 'Hotel accounts did not load', 'Las cuentas del hotel no se cargaron')}</strong><span>{teamError}</span></div>
            <button type="button" onClick={() => void loadTeam()}>
              <RefreshCw size={15} aria-hidden="true" />{copy(lang, 'Retry', 'Reintentar')}
            </button>
          </div>
        ) : team.length > 0 || requests.length > 0 || requestsLoading || Boolean(requestsError) ? (
          <div className={styles.teamList} role="list">
            {team.map((member) => {
              const self = member.accountId === currentAccountId;
              const actions = resolveActions(member, currentUser, currentAccountId, locked);
              const canOpenEditor = actions.canEdit && (actions.canChangeRole || actions.canResetPassword || self || member.role !== 'admin');
              const staffProfile = member.staffId ? staffById.get(member.staffId) : undefined;
              const memberDetails = [
                `@${member.username}`,
                roleLabel(member.role, lang),
                staffProfile ? departmentLabel(staffProfile.department ?? 'other', lang) : null,
              ].filter(Boolean).join(' · ');
              return (
                <div key={member.accountId} className={`${styles.teamRow}${self ? ` ${styles.selfRow}` : ''}`} role="listitem">
                  <span className={styles.avatar} aria-hidden="true">{initials(member.displayName)}</span>
                  <div className={styles.rowBody}>
                    <strong>
                      {member.displayName}
                      {self ? <small>{copy(lang, 'You', 'Tú')}</small> : null}
                    </strong>
                    <span>{memberDetails}</span>
                    <span>{member.email || copy(lang, 'Email unavailable', 'Correo no disponible')}</span>
                    {actions.roleIsSharedAcrossHotels ? (
                      <em>{copy(lang, 'Role shared across multiple hotels', 'Rol compartido entre varios hoteles')}</em>
                    ) : null}
                  </div>
                  {member.staffId ? (
                    <span className={styles.linkedBadge}>
                      {staffProfile?.isActive === false
                        ? copy(lang, 'Linked · inactive', 'Vinculada · inactiva')
                        : copy(lang, 'Linked staff', 'Personal vinculado')}
                    </span>
                  ) : null}
                  {(canOpenEditor || actions.canRemove) ? (
                    <div className={styles.rowActions}>
                      {canOpenEditor ? (
                        <button
                          type="button"
                          className={styles.editButton}
                          onClick={() => setEditMember(member)}
                          aria-label={copy(lang, `Edit ${member.displayName}`, `Editar a ${member.displayName}`)}
                        >
                          <Pencil size={15} aria-hidden="true" />
                          <span>{copy(lang, 'Edit', 'Editar')}</span>
                        </button>
                      ) : null}
                      {actions.canRemove ? (
                        <button
                          type="button"
                          className={styles.removeButton}
                          onClick={() => setRemoveMember(member)}
                          aria-label={copy(lang, `Remove ${member.displayName} from this hotel`, `Quitar a ${member.displayName} de este hotel`)}
                        >
                          <Trash2 size={15} aria-hidden="true" />
                          <span className={styles.visuallyHidden}>{copy(lang, 'Remove', 'Quitar')}</span>
                        </button>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              );
            })}

            {requestsLoading && team.length === 0 ? (
              <div className={`${styles.approvalRow} ${styles.approvalLoadingRow}`} role="listitem">
                <span className={styles.spinner} aria-hidden="true" />
                <span role="status">{copy(lang, 'Checking pending approvals…', 'Buscando aprobaciones pendientes…')}</span>
              </div>
            ) : null}

            {!requestsLoading && requestsError ? (
              <div className={`${styles.approvalRow} ${styles.approvalErrorRow}`} role="listitem">
                <AlertCircle size={18} aria-hidden="true" />
                <div className={styles.approvalErrorCopy} role="alert">
                  <strong>{copy(lang, 'Pending approvals did not load', 'Las aprobaciones pendientes no se cargaron')}</strong>
                  <span>{requestsError}</span>
                </div>
                <button type="button" onClick={() => void loadRequests()}>
                  <RefreshCw size={15} aria-hidden="true" />{copy(lang, 'Retry', 'Reintentar')}
                </button>
              </div>
            ) : null}

            {!requestsLoading && !requestsError ? requests.map((request) => (
              <div key={request.id} className={styles.approvalRow} role="listitem">
                <span className={styles.waitingIcon}><Clock3 size={16} aria-hidden="true" /></span>
                <div className={styles.rowBody}>
                  <strong>{request.name}</strong>
                  <span>
                    {departmentLabel(request.department, lang)} · {request.language === 'es' ? 'Español' : 'English'} · {timeAgo(request.created_at, lang)}
                  </span>
                </div>
                <span className={styles.pendingBadge}>{copy(lang, 'Pending approval', 'Aprobación pendiente')}</span>
                <div className={styles.approvalActions}>
                  <button
                    type="button"
                    className={styles.approveButton}
                    onClick={() => setDecision({ request, decision: 'approve' })}
                    disabled={locked}
                    aria-label={copy(lang, `Approve ${request.name}`, `Aprobar a ${request.name}`)}
                  >
                    <UserCheck size={15} aria-hidden="true" />{copy(lang, 'Approve', 'Aprobar')}
                  </button>
                  <button
                    type="button"
                    className={styles.denyButton}
                    onClick={() => setDecision({ request, decision: 'deny' })}
                    disabled={locked}
                    aria-label={copy(lang, `Deny ${request.name}`, `Rechazar a ${request.name}`)}
                  >
                    {copy(lang, 'Deny', 'Rechazar')}
                  </button>
                </div>
              </div>
            )) : null}
          </div>
        ) : (
          <div className={styles.emptyState}>
            <span><Users size={22} aria-hidden="true" /></span>
            <h3>{copy(lang, 'No hotel accounts yet', 'Aún no hay cuentas del hotel')}</h3>
            <p>{copy(lang, 'Invite staff to create the first login for this hotel.', 'Invita al personal para crear el primer acceso de este hotel.')}</p>
            {!locked ? (
              <button type="button" className={styles.secondaryButton} onClick={() => setInviteOpen(true)}>
                <UserPlus size={16} aria-hidden="true" />{copy(lang, 'Invite staff', 'Invitar personal')}
              </button>
            ) : null}
          </div>
        )}
      </section>

      <React.Suspense fallback={<DialogLoading lang={lang} />}>
        {editMember ? (
          <LazyMemberDialog
            hotelId={hotelId}
            hotelName={hotelName}
            member={editMember}
            currentUser={currentUser}
            currentAccountId={currentAccountId}
            lang={lang}
            actions={resolveActions(editMember, currentUser, currentAccountId, locked)}
            onClose={() => setEditMember(null)}
            onChanged={refreshAfterChange}
            onSaved={async () => {
              setEditMember(null);
              await refreshAfterChange();
            }}
          />
        ) : null}
        {removeMember ? (
          <LazyRemoveDialog
            hotelId={hotelId}
            hotelName={hotelName}
            member={removeMember}
            lang={lang}
            onClose={() => setRemoveMember(null)}
            onRemoved={async () => {
              setRemoveMember(null);
              await refreshAfterChange();
            }}
          />
        ) : null}
        {inviteOpen ? (
          <LazyInviteDialog
            hotelId={hotelId}
            hotelName={hotelName}
            lang={lang}
            canInviteManager={currentUser.role === 'admin' || currentUser.role === 'owner'}
            onClose={() => setInviteOpen(false)}
            onChanged={() => changedRef.current?.()}
          />
        ) : null}
        {decision ? (
          <LazyDecisionDialog
            hotelId={hotelId}
            hotelName={hotelName}
            request={decision.request}
            decision={decision.decision}
            lang={lang}
            onClose={() => setDecision(null)}
            onCompleted={async () => {
              setDecision(null);
              await refreshAfterChange();
            }}
          />
        ) : null}
      </React.Suspense>
    </section>
  );
}
