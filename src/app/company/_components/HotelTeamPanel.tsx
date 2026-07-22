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
  X,
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
  canDeactivate?: boolean;
  canReactivate?: boolean;
  canRemove?: boolean;
  canRemoveHotelAccess?: boolean;
  reason?: string | null;
}

export type HotelTeamLifecycleAction = 'deactivate' | 'reactivate';

export interface HotelTeamPendingLifecycleOperation {
  accountId: string;
  action: HotelTeamLifecycleAction;
  operationId: string;
  clearStoredOperation: () => void;
}

export interface HotelTeamMember {
  accountId: string;
  username: string;
  displayName: string;
  email: string;
  role: AppRole;
  active: boolean;
  /** Exact account-row version observed when this member was loaded. */
  updatedAt: string;
  /** Effective normalized organization owners use the ownership workflow. */
  ownerProtected: boolean;
  lastSignInKnown: boolean;
  lastSignInAt: string | null;
  lifecyclePending?: boolean;
  lifecycleDesiredActive?: boolean | null;
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
  canDeactivate?: boolean;
  canReactivate?: boolean;
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
  inviteDialogOpen: boolean;
  onInviteDialogOpenChange: (open: boolean) => void;
  staffProfiles?: StaffMember[];
  onChanged?: () => void | Promise<void>;
  /** Tri-state result prevents the parent from calling staff "unlinked" before this request succeeds. */
  onLinkageChange?: (state: HotelTeamLinkageState) => void;
}

interface Envelope<T> {
  ok?: boolean;
  data?: T;
  error?: unknown;
  details?: unknown;
}

interface PendingLifecycleReconciliation extends HotelTeamPendingLifecycleOperation {
  phase: 'polling' | 'paused';
}

interface ResolvedActions {
  canEdit: boolean;
  canChangeRole: boolean;
  canResetPassword: boolean;
  canDeactivate: boolean;
  canReactivate: boolean;
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

const LIFECYCLE_RECONCILIATION_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 16_000] as const;
const LIFECYCLE_SERVER_REFRESH_DELAYS_MS = [2_000, 4_000, 8_000, 16_000] as const;

function lifecycleResponseNeedsReconciliation(
  response: Response,
  body: Envelope<unknown>,
  operationId: string,
): boolean {
  if (response.status === 408 || response.status === 425 || response.status === 429) return true;
  if (response.status !== 503) return false;
  if (!body.details || typeof body.details !== 'object') return true;
  const details = body.details as Record<string, unknown>;
  return details.operationId === undefined || details.operationId === operationId;
}

function waitForLifecycleReconciliation(delayMs: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const timeout = window.setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve(true);
    }, delayMs);
    const onAbort = () => {
      window.clearTimeout(timeout);
      resolve(false);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
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

function lastSignInLabel(known: boolean, value: string | null, lang: HotelTeamLang): string {
  if (!known) return copy(lang, 'Last sign-in unavailable', 'Último acceso no disponible');
  if (!value) return copy(lang, 'No sign-ins yet', 'Aún no ha iniciado sesión');
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return copy(lang, 'Last sign-in unavailable', 'Último acceso no disponible');
  }
  const formatted = new Intl.DateTimeFormat(lang === 'es' ? 'es-US' : 'en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(parsed);
  return copy(lang, `Last signed in ${formatted}`, `Último acceso: ${formatted}`);
}

function actionFlag(
  member: HotelTeamMember,
  actionKeys: Array<keyof HotelTeamActionFlags>,
  topLevel: 'canEditProfile' | 'canChangeRole' | 'canResetPassword' | 'canDeactivate' | 'canReactivate' | 'canRemove',
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
  const targetHasAllHotels = member.propertyAccess.includes('*');
  const roleIsSharedAcrossHotels = member.hasOtherHotelAccess ?? hotelIds.length > 1;
  const viewerHotels = new Set(currentUser.propertyAccess);
  const viewerControlsEveryHotel = viewerIsAdmin
    || viewerHotels.has('*')
    || (!targetHasAllHotels && hotelIds.length > 0 && hotelIds.every((id) => viewerHotels.has(id)));

  // These floors are deliberately stricter than presentation flags. A stale
  // or over-permissive API flag must never expose admin, self-removal, or
  // cross-hotel credential actions.
  const editFloor = !locked && !adminTarget && (self || hierarchyAllows);
  const editFallback = editFloor;
  const canEdit = editFloor && actionFlag(member, ['canEditProfile'], 'canEditProfile', editFallback);
  // Role authority is projected independently from profile-edit authority.
  // Keep only local hierarchy/state safety floors here; the canonical
  // canChangeRole flag represents manage_users across every target hotel.
  const roleFloor = !locked
    && !self
    && !adminTarget
    && !member.ownerProtected
    && hierarchyAllows
    && member.active
    && member.role !== 'owner';
  const canChangeRole = roleFloor
    && actionFlag(member, ['canChangeRole'], 'canChangeRole', false);
  const passwordFloor = canEdit && self;
  const canResetPassword = passwordFloor
    && actionFlag(member, ['canResetPassword'], 'canResetPassword', passwordFloor);
  const lifecycleFloor = !locked
    && !self
    && !adminTarget
    && !member.ownerProtected
    && hierarchyAllows
    && viewerControlsEveryHotel;
  const canDeactivate = lifecycleFloor
    && member.active
    && actionFlag(member, ['canDeactivate'], 'canDeactivate', false);
  const canReactivate = lifecycleFloor
    && !member.active
    && actionFlag(member, ['canReactivate'], 'canReactivate', false);
  const removeFloor = !locked && !self && !adminTarget
    && !member.ownerProtected && hierarchyAllows;
  const canRemove = removeFloor
    && actionFlag(member, ['canRemoveHotelAccess', 'canRemove'], 'canRemove', removeFloor);

  return {
    canEdit,
    canChangeRole,
    canResetPassword,
    canDeactivate,
    canReactivate,
    canRemove,
    roleIsSharedAcrossHotels,
  };
}

type DialogLoadingVariant = 'invite' | 'member' | 'remove' | 'decision';

function DialogLoading({
  lang,
  hotelName,
  variant,
  onClose,
}: {
  lang: HotelTeamLang;
  hotelName: string;
  variant: DialogLoadingVariant;
  onClose: () => void;
}) {
  const closeRef = React.useRef<HTMLButtonElement | null>(null);
  const dialogRef = React.useRef<HTMLDivElement | null>(null);
  const onCloseRef = React.useRef(onClose);
  onCloseRef.current = onClose;
  const titleId = React.useId();
  const loadingLabel = copy(lang, 'Opening dialog…', 'Abriendo diálogo…');
  const title = variant === 'invite'
    ? copy(lang, 'Invite hotel staff', 'Invitar personal del hotel')
    : variant === 'member'
      ? copy(lang, 'Hotel account details', 'Detalles de la cuenta del hotel')
      : variant === 'remove'
        ? copy(lang, 'Remove hotel access', 'Quitar acceso al hotel')
        : copy(lang, 'Review join request', 'Revisar solicitud de acceso');
  const shellClass = variant === 'invite'
    ? `${styles.dialogWide} ${styles.dialogLoadingInvite}`
    : variant === 'member'
      ? styles.dialogLoadingMember
      : styles.dialogLoadingConfirmation;

  React.useEffect(() => {
    const returnFocusElement = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    closeRef.current?.focus({ preventScroll: true });
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab' || !dialogRef.current) return;
      const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
      )).filter((element) => element.getAttribute('aria-hidden') !== 'true');
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
      if (returnFocusElement?.isConnected) returnFocusElement.focus({ preventScroll: true });
    };
  }, []);

  return createPortal(
    <div className={styles.dialogLayer}>
      <button
        type="button"
        className={styles.dialogScrim}
        onClick={onClose}
        aria-label={copy(lang, 'Close dialog', 'Cerrar diálogo')}
      />
      <div
        ref={dialogRef}
        className={`${styles.dialog} ${styles.dialogLoadingShell} ${shellClass}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-busy="true"
      >
        <div className={styles.dialogHeader}>
          <span className={`${styles.dialogIcon} ${styles.dialogLoadingIcon}`} aria-hidden="true" />
          <div>
            <span>{hotelName}</span>
            <h2 id={titleId}>{title}</h2>
          </div>
          <button
            ref={closeRef}
            type="button"
            className={styles.iconButton}
            onClick={onClose}
            aria-label={copy(lang, 'Close', 'Cerrar')}
          >
            <X size={18} aria-hidden="true" />
          </button>
        </div>

        <div className={styles.dialogLoadingIntro} aria-hidden="true">
          <span />
        </div>

        <div className={styles.dialogLoadingBody} role="status" aria-live="polite">
          <span className={styles.visuallyHidden}>{loadingLabel}</span>
          {variant === 'invite' ? (
            <>
              <DialogLoadingSection rows={4} tall />
              <DialogLoadingSection rows={3} />
            </>
          ) : variant === 'member' ? (
            <DialogLoadingFields rows={5} />
          ) : (
            <DialogLoadingFields rows={2} compact />
          )}
        </div>

        <div className={styles.dialogFooter} aria-hidden="true">
          <span className={styles.dialogLoadingButton} />
        </div>
      </div>
    </div>,
    document.body,
  );
}

function DialogLoadingSection({ rows, tall = false }: { rows: number; tall?: boolean }) {
  return (
    <div className={`${styles.dialogLoadingSection}${tall ? ` ${styles.dialogLoadingSectionTall}` : ''}`} aria-hidden="true">
      <span className={styles.dialogLoadingHeading} />
      {Array.from({ length: rows }, (_, index) => (
        <span key={index} className={styles.dialogLoadingRow} />
      ))}
    </div>
  );
}

function DialogLoadingFields({ rows, compact = false }: { rows: number; compact?: boolean }) {
  return (
    <div className={`${styles.dialogLoadingFields}${compact ? ` ${styles.dialogLoadingFieldsCompact}` : ''}`} aria-hidden="true">
      {Array.from({ length: rows }, (_, index) => (
        <span key={index} className={styles.dialogLoadingField} />
      ))}
    </div>
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
  inviteDialogOpen,
  onInviteDialogOpenChange,
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
  const [pendingLifecycleByAccount, setPendingLifecycleByAccount] = React.useState<
    Record<string, PendingLifecycleReconciliation>
  >({});
  const [serverLifecyclePollingPaused, setServerLifecyclePollingPaused] = React.useState(false);
  const [decision, setDecision] = React.useState<{
    request: HotelJoinRequest;
    decision: 'approve' | 'deny';
  } | null>(null);
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

  const hasServerLifecyclePending = team.some((member) => member.lifecyclePending === true);

  React.useEffect(() => {
    setServerLifecyclePollingPaused(false);
    if (!hasServerLifecyclePending) return;
    const controller = new AbortController();

    void (async () => {
      for (const delayMs of LIFECYCLE_SERVER_REFRESH_DELAYS_MS) {
        const shouldContinue = await waitForLifecycleReconciliation(delayMs, controller.signal);
        if (!shouldContinue) return;
        await loadTeam();
        if (controller.signal.aborted) return;
      }
      setServerLifecyclePollingPaused(true);
    })();

    return () => controller.abort();
  }, [hasServerLifecyclePending, hotelId, loadTeam]);

  React.useEffect(() => () => linkageRef.current?.({ status: 'unavailable' }), []);

  const refreshAfterChange = React.useCallback(async () => {
    await Promise.all([loadTeam(), loadRequests()]);
    await changedRef.current?.();
  }, [loadRequests, loadTeam]);

  const reconcilePendingLifecycle = React.useCallback((operation: HotelTeamPendingLifecycleOperation) => {
    setPendingLifecycleByAccount((current) => {
      const existing = current[operation.accountId];
      if (existing?.operationId === operation.operationId && existing.phase === 'polling') return current;
      return {
        ...current,
        [operation.accountId]: { ...operation, phase: 'polling' },
      };
    });
  }, []);

  React.useEffect(() => {
    const operations = Object.values(pendingLifecycleByAccount)
      .filter((operation) => operation.phase === 'polling');
    if (operations.length === 0) return;

    const controller = new AbortController();
    const settle = async (
      operation: PendingLifecycleReconciliation,
      clearStoredOperation: boolean,
    ) => {
      if (clearStoredOperation) operation.clearStoredOperation();
      setPendingLifecycleByAccount((current) => {
        if (current[operation.accountId]?.operationId !== operation.operationId) return current;
        const next = { ...current };
        delete next[operation.accountId];
        return next;
      });
      setEditMember((current) => current?.accountId === operation.accountId ? null : current);
      await refreshAfterChange();
    };

    for (const operation of operations) {
      void (async () => {
        for (const delayMs of LIFECYCLE_RECONCILIATION_DELAYS_MS) {
          const shouldContinue = await waitForLifecycleReconciliation(delayMs, controller.signal);
          if (!shouldContinue) return;

          const requestController = new AbortController();
          const abortRequest = () => requestController.abort();
          controller.signal.addEventListener('abort', abortRequest, { once: true });
          const requestTimeout = window.setTimeout(abortRequest, 15_000);
          try {
            const response = await fetchWithAuth('/api/auth/team/status', {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                hotelId,
                accountId: operation.accountId,
                action: operation.action,
                operationId: operation.operationId,
              }),
              signal: requestController.signal,
            });
            const body = await response.json().catch(() => ({})) as Envelope<{
              operationId?: string;
              active?: boolean;
            }>;
            if (response.ok && body.ok) {
              await settle(operation, true);
              return;
            }
            if (!lifecycleResponseNeedsReconciliation(response, body, operation.operationId)) {
              await settle(operation, true);
              return;
            }
          } catch (error) {
            if (controller.signal.aborted) return;
            console.error('[HotelTeamPanel] lifecycle reconciliation attempt failed', error);
          } finally {
            window.clearTimeout(requestTimeout);
            controller.signal.removeEventListener('abort', abortRequest);
          }
        }

        setPendingLifecycleByAccount((current) => {
          const existing = current[operation.accountId];
          if (existing?.operationId !== operation.operationId) return current;
          return {
            ...current,
            [operation.accountId]: { ...existing, phase: 'paused' },
          };
        });
      })();
    }

    return () => controller.abort();
  }, [hotelId, pendingLifecycleByAccount, refreshAfterChange]);

  const loadingDialogVariant: DialogLoadingVariant = editMember
    ? 'member'
    : removeMember
      ? 'remove'
      : inviteDialogOpen
        ? 'invite'
        : 'decision';
  const closeLoadingDialog = React.useCallback(() => {
    if (editMember) {
      setEditMember(null);
      return;
    }
    if (removeMember) {
      setRemoveMember(null);
      return;
    }
    if (inviteDialogOpen) {
      onInviteDialogOpenChange(false);
      return;
    }
    setDecision(null);
  }, [editMember, inviteDialogOpen, onInviteDialogOpenChange, removeMember]);

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
    <div className={styles.root}>
      <section className={styles.subsection} aria-labelledby="team-members-title">
        <div className={styles.subheading}>
          <div>
            <span>{copy(lang, 'Access roster', 'Registro de acceso')}</span>
            <h2 id="team-members-title">{copy(lang, 'Hotel team accounts', 'Cuentas del equipo del hotel')}</h2>
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
              const pendingLifecycle = pendingLifecycleByAccount[member.accountId];
              const lifecycleIsPending = Boolean(pendingLifecycle) || member.lifecyclePending === true;
              const lifecyclePollingPaused = pendingLifecycle?.phase === 'paused'
                || (!pendingLifecycle && member.lifecyclePending === true && serverLifecyclePollingPaused);
              const availableActions = resolveActions(member, currentUser, currentAccountId, locked);
              const actions = lifecycleIsPending
                ? resolveActions(member, currentUser, currentAccountId, true)
                : availableActions;
              const canOpenEditor = availableActions.canEdit
                || availableActions.canChangeRole
                || availableActions.canResetPassword
                || availableActions.canDeactivate
                || availableActions.canReactivate;
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
                    <span className={styles.signInMetadata}>{lastSignInLabel(member.lastSignInKnown, member.lastSignInAt, lang)}</span>
                    {lifecycleIsPending ? (
                      <em className={styles.pendingLifecycleMeta}>
                        {lifecyclePollingPaused
                          ? copy(
                              lang,
                              'Verification paused. Reload to check the final status.',
                              'La verificación está en pausa. Recarga para comprobar el estado final.',
                            )
                          : copy(lang, 'Verifying the account status…', 'Verificando el estado de la cuenta…')}
                      </em>
                    ) : null}
                    {member.ownerProtected ? (
                      <em>{copy(
                        lang,
                        'Organization owner access is protected',
                        'El acceso de propietario de la organización está protegido',
                      )}</em>
                    ) : null}
                    {actions.roleIsSharedAcrossHotels ? (
                      <em>{copy(lang, 'Role shared across multiple hotels', 'Rol compartido entre varios hoteles')}</em>
                    ) : null}
                  </div>
                  <div className={styles.rowBadges}>
                    <span
                      className={`${styles.accountStatusBadge}${
                        lifecycleIsPending
                          ? ` ${styles.accountStatusPending}`
                          : member.active ? '' : ` ${styles.accountStatusDisabled}`
                      }`}
                      role={lifecycleIsPending ? 'status' : undefined}
                    >
                      {lifecycleIsPending
                        ? copy(lang, 'Status change pending', 'Cambio de estado pendiente')
                        : member.active
                          ? copy(lang, 'Active', 'Activa')
                          : copy(lang, 'Login disabled', 'Acceso desactivado')}
                    </span>
                    {member.staffId ? (
                      <span className={styles.linkedBadge}>
                        {staffProfile?.isActive === false
                          ? copy(lang, 'Linked · inactive', 'Vinculada · inactiva')
                          : copy(lang, 'Linked staff', 'Personal vinculado')}
                      </span>
                    ) : null}
                  </div>
                  {(canOpenEditor || availableActions.canRemove) ? (
                    <div className={styles.rowActions}>
                      {canOpenEditor ? (
                        <button
                          type="button"
                          className={styles.editButton}
                          onClick={() => setEditMember(member)}
                          disabled={lifecycleIsPending}
                          aria-label={copy(lang, `Edit ${member.displayName}`, `Editar a ${member.displayName}`)}
                        >
                          <Pencil size={15} aria-hidden="true" />
                          <span>{copy(lang, 'Edit', 'Editar')}</span>
                        </button>
                      ) : null}
                      {availableActions.canRemove ? (
                        <button
                          type="button"
                          className={styles.removeButton}
                          onClick={() => setRemoveMember(member)}
                          disabled={lifecycleIsPending}
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
              <button type="button" className={styles.secondaryButton} onClick={() => onInviteDialogOpenChange(true)}>
                <UserPlus size={16} aria-hidden="true" />{copy(lang, 'Invite staff', 'Invitar personal')}
              </button>
            ) : null}
          </div>
        )}
      </section>

      <React.Suspense fallback={(
        <DialogLoading
          lang={lang}
          hotelName={hotelName}
          variant={loadingDialogVariant}
          onClose={closeLoadingDialog}
        />
      )}>
        {editMember ? (
          <LazyMemberDialog
            hotelId={hotelId}
            hotelName={hotelName}
            member={editMember}
            currentUser={currentUser}
            currentAccountId={currentAccountId}
            lang={lang}
            actions={resolveActions(
              editMember,
              currentUser,
              currentAccountId,
              locked
                || Boolean(pendingLifecycleByAccount[editMember.accountId])
                || editMember.lifecyclePending === true,
            )}
            onLifecyclePending={reconcilePendingLifecycle}
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
        {inviteDialogOpen ? (
          <LazyInviteDialog
            hotelId={hotelId}
            hotelName={hotelName}
            lang={lang}
            canInviteManager={currentUser.role === 'admin' || currentUser.role === 'owner'}
            onClose={() => onInviteDialogOpenChange(false)}
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
    </div>
  );
}
