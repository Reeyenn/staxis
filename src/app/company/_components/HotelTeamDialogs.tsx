'use client';

import React from 'react';
import { createPortal } from 'react-dom';
import QRCode from 'qrcode';
import {
  AlertCircle,
  Check,
  CheckCircle2,
  Copy,
  KeyRound,
  Link2,
  Mail,
  RefreshCw,
  ShieldCheck,
  Trash2,
  UserCheck,
  UserRoundCog,
  X,
} from 'lucide-react';

import type { AppUser } from '@/contexts/AuthContext';
import { fetchWithAuth } from '@/lib/api-fetch';
import { ASSIGNABLE_ROLES, type AppRole, type AssignableRole } from '@/lib/roles';

import type {
  HotelJoinRequest,
  HotelTeamLifecycleAction,
  HotelTeamLang,
  HotelTeamMember,
  HotelTeamPendingLifecycleOperation,
} from './HotelTeamPanel';
import styles from './HotelTeamPanel.module.css';

interface Envelope<T> {
  ok?: boolean;
  data?: T;
  error?: unknown;
  details?: unknown;
}

interface DialogActions {
  canEdit: boolean;
  canChangeRole: boolean;
  canResetPassword: boolean;
  canDeactivate: boolean;
  canReactivate: boolean;
  canRemove: boolean;
  roleIsSharedAcrossHotels: boolean;
}

type LifecycleAction = HotelTeamLifecycleAction;

interface LifecycleOperation {
  action: LifecycleAction;
  operationId: string;
  submitted: boolean;
}

interface JoinCode {
  id: string;
  code: string;
  role: AssignableRole | null;
  expires_at: string;
  max_uses: number;
  used_count: number;
  created_at?: string;
}

interface ManagerInvite {
  id: string;
  email: string;
  role: AssignableRole;
  expires_at: string;
  created_at?: string;
}

interface InvitePostData {
  inviteLink?: string;
  emailSent?: boolean;
  deliveryStatus?: 'sent' | 'link_only';
}

function copy(lang: HotelTeamLang, en: string, es: string): string {
  return lang === 'es' ? es : en;
}

function mutationSignal(): AbortSignal {
  return AbortSignal.timeout(15_000);
}

const LIFECYCLE_OPERATION_STORAGE_PREFIX = 'staxis:hotel-account-lifecycle:';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function lifecycleOperationStorageKey(accountId: string, action: LifecycleAction): string {
  return `${LIFECYCLE_OPERATION_STORAGE_PREFIX}${accountId}:${action}`;
}

function createLifecycleOperationId(): string {
  const cryptoApi = globalThis.crypto;
  if (typeof cryptoApi?.randomUUID === 'function') return cryptoApi.randomUUID();
  if (typeof cryptoApi?.getRandomValues !== 'function') {
    throw new Error('Secure UUID generation is unavailable');
  }
  const bytes = cryptoApi.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function readLifecycleOperation(accountId: string, action: LifecycleAction): Omit<LifecycleOperation, 'action'> | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(lifecycleOperationStorageKey(accountId, action));
    if (!raw) return null;
    // A plain UUID is treated as previously submitted for forward compatibility
    // with an earlier client format; retaining it is the safe retry behavior.
    if (UUID_PATTERN.test(raw)) return { operationId: raw, submitted: true };
    const parsed = JSON.parse(raw) as { operationId?: unknown; submitted?: unknown };
    if (typeof parsed.operationId !== 'string' || !UUID_PATTERN.test(parsed.operationId)) return null;
    return { operationId: parsed.operationId, submitted: parsed.submitted === true };
  } catch {
    return null;
  }
}

function persistLifecycleOperation(accountId: string, operation: LifecycleOperation): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(
      lifecycleOperationStorageKey(accountId, operation.action),
      JSON.stringify({ operationId: operation.operationId, submitted: operation.submitted }),
    );
  } catch {
    // The in-memory ref still prevents duplicate sends for this open dialog.
  }
}

function getOrCreateLifecycleOperation(accountId: string, action: LifecycleAction): LifecycleOperation {
  const stored = readLifecycleOperation(accountId, action);
  const operation: LifecycleOperation = stored
    ? { action, ...stored }
    : { action, operationId: createLifecycleOperationId(), submitted: false };
  persistLifecycleOperation(accountId, operation);
  return operation;
}

function clearLifecycleOperation(accountId: string, operation: LifecycleOperation): void {
  if (typeof window === 'undefined') return;
  try {
    const stored = readLifecycleOperation(accountId, operation.action);
    if (stored?.operationId === operation.operationId) {
      window.localStorage.removeItem(lifecycleOperationStorageKey(accountId, operation.action));
    }
  } catch {
    // A failed cleanup is safe: the server treats the operation UUID idempotently.
  }
}

function lifecycleResponseIsDefinitivelyAborted(response: Response): boolean {
  if (response.status < 400 || response.status >= 500) return false;
  return response.status !== 408 && response.status !== 425 && response.status !== 429;
}

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

function responseError(body: Envelope<unknown>, fallback: string): string {
  if (typeof body.error === 'string') return body.error;
  if (body.error && typeof body.error === 'object') {
    const record = body.error as Record<string, unknown>;
    if (typeof record.message === 'string') return record.message;
    if (typeof record.error === 'string') return record.error;
  }
  return fallback;
}

function roleLabel(role: AppRole | string, lang: HotelTeamLang): string {
  const labels: Record<string, [string, string]> = {
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

function formatDate(value: string, lang: HotelTeamLang): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat(lang === 'es' ? 'es-US' : 'en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(parsed);
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

function isUsable(code: JoinCode): boolean {
  return new Date(code.expires_at).getTime() > Date.now() && code.used_count < code.max_uses;
}

function signupLinkFor(code: string): string {
  if (typeof window === 'undefined') return `/signup?code=${encodeURIComponent(code)}`;
  const { hostname, origin } = window.location;
  if (hostname === 'localhost' || hostname === '127.0.0.1') {
    return `${origin}/signup?code=${encodeURIComponent(code)}`;
  }
  return `https://getstaxis.com/signup?code=${encodeURIComponent(code)}`;
}

async function copyToClipboard(value: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    // Continue to the selection fallback below.
  }
  try {
    const textarea = document.createElement('textarea');
    textarea.value = value;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    const copied = document.execCommand('copy');
    textarea.remove();
    return copied;
  } catch {
    return false;
  }
}

function useDialogBehavior(onClose: () => void, busy: boolean) {
  const closeRef = React.useRef<HTMLButtonElement | null>(null);
  const dialogRef = React.useRef<HTMLDivElement | null>(null);
  const onCloseRef = React.useRef(onClose);
  const busyRef = React.useRef(busy);
  onCloseRef.current = onClose;
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
        if (!busyRef.current) onCloseRef.current();
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

  return { closeRef, dialogRef };
}

function DialogShell({
  title,
  eyebrow,
  description,
  lang,
  icon,
  onClose,
  busy = false,
  wide = false,
  children,
}: {
  title: string;
  eyebrow: string;
  description: string;
  lang: HotelTeamLang;
  icon: React.ReactNode;
  onClose: () => void;
  busy?: boolean;
  wide?: boolean;
  children: React.ReactNode;
}) {
  const { closeRef, dialogRef } = useDialogBehavior(onClose, busy);
  const titleId = React.useId();
  const descriptionId = React.useId();
  return createPortal(
    <div className={styles.dialogLayer}>
      <button
        type="button"
        className={styles.dialogScrim}
        aria-label={copy(lang, 'Close dialog', 'Cerrar diálogo')}
        onClick={() => { if (!busy) onClose(); }}
      />
      <div
        ref={dialogRef}
        className={`${styles.dialog}${wide ? ` ${styles.dialogWide}` : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        aria-busy={busy}
      >
        <div className={styles.dialogHeader}>
          <span className={styles.dialogIcon}>{icon}</span>
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
            <X size={18} aria-hidden="true" />
          </button>
        </div>
        <p id={descriptionId} className={styles.dialogIntro}>{description}</p>
        {children}
      </div>
    </div>,
    document.body,
  );
}

function ErrorBanner({ message }: { message: string }) {
  return (
    <div className={styles.dialogError} role="alert">
      <AlertCircle size={17} aria-hidden="true" />
      <span>{message}</span>
    </div>
  );
}

function BusyLabel({ lang, en, es }: { lang: HotelTeamLang; en: string; es: string }) {
  return <><span className={styles.buttonSpinner} aria-hidden="true" />{copy(lang, en, es)}</>;
}

function InviteSectionSkeleton({ label, rows = 3 }: { label: string; rows?: number }) {
  return (
    <div className={styles.inviteSkeleton} role="status" aria-live="polite">
      <span className={styles.visuallyHidden}>{label}</span>
      <div className={styles.inviteSkeletonVisual} aria-hidden="true">
        {Array.from({ length: rows }, (_, index) => (
          <span key={index} className={styles.inviteSkeletonRow}>
            <span className={styles.inviteSkeletonCopy}>
              <span className={styles.inviteSkeletonLine} />
              <span className={`${styles.inviteSkeletonLine} ${styles.inviteSkeletonLineShort}`} />
            </span>
            <span className={styles.inviteSkeletonAction} />
          </span>
        ))}
      </div>
    </div>
  );
}

export function HotelMemberDialog({
  hotelId,
  hotelName,
  member,
  currentUser,
  currentAccountId,
  lang,
  actions,
  onClose,
  onChanged,
  onLifecyclePending,
  onSaved,
}: {
  hotelId: string;
  hotelName: string;
  member: HotelTeamMember;
  currentUser: AppUser;
  currentAccountId: string;
  lang: HotelTeamLang;
  actions: DialogActions;
  onClose: () => void;
  onChanged?: () => void | Promise<void>;
  onLifecyclePending: (operation: HotelTeamPendingLifecycleOperation) => void;
  onSaved: () => void | Promise<void>;
}) {
  const self = member.accountId === currentAccountId;
  const [displayName, setDisplayName] = React.useState(member.displayName);
  const [role, setRole] = React.useState<string>(member.role);
  const [savedDisplayName, setSavedDisplayName] = React.useState(member.displayName);
  const [savedRole, setSavedRole] = React.useState<string>(member.role);
  const [password, setPassword] = React.useState('');
  const [error, setError] = React.useState('');
  const [partialSuccess, setPartialSuccess] = React.useState('');
  const [saving, setSaving] = React.useState(false);
  const [lifecycleIntent, setLifecycleIntent] = React.useState<LifecycleAction | null>(null);
  const [lifecycleSaving, setLifecycleSaving] = React.useState(false);
  const [lifecycleError, setLifecycleError] = React.useState('');
  const [lifecyclePending, setLifecyclePending] = React.useState(false);
  const [discardConfirming, setDiscardConfirming] = React.useState(false);
  const lifecycleConfirmationRef = React.useRef<HTMLDivElement | null>(null);
  const lifecycleTriggerRef = React.useRef<HTMLButtonElement | null>(null);
  const lifecycleOperationRef = React.useRef<LifecycleOperation | null>(null);
  const lifecycleInFlightRef = React.useRef(false);
  const discardConfirmationRef = React.useRef<HTMLDivElement | null>(null);
  const discardReturnFocusRef = React.useRef<HTMLElement | null>(null);
  const accountAccessHeadingId = React.useId();
  const lifecycleHeadingId = React.useId();
  const lifecycleDescriptionId = React.useId();
  const lifecycleGuidanceId = React.useId();
  const discardHeadingId = React.useId();
  const discardDescriptionId = React.useId();
  const busy = saving || lifecycleSaving;
  const lifecycleConfirming = lifecycleIntent !== null;
  const formLocked = busy || lifecycleConfirming || discardConfirming || lifecyclePending;
  const canChangeLifecycle = member.active ? actions.canDeactivate : actions.canReactivate;

  const assignableRoles = React.useMemo(() => {
    const ordinaryRoles = ASSIGNABLE_ROLES.filter((value) => value !== 'owner');
    const allowed = currentUser.role === 'general_manager'
      ? ordinaryRoles.filter((value) => value !== 'general_manager')
      : ordinaryRoles;
    return allowed as readonly AssignableRole[];
  }, [currentUser.role]);

  const trimmedName = displayName.trim();
  const nameChanged = displayName !== savedDisplayName;
  const roleChanged = actions.canChangeRole && member.active && role !== savedRole;
  const passwordChanged = actions.canResetPassword && password.length > 0;
  const dirty = nameChanged || roleChanged || passwordChanged;

  React.useEffect(() => {
    if (!lifecycleIntent) return;
    lifecycleConfirmationRef.current?.focus({ preventScroll: true });
  }, [lifecycleIntent]);

  React.useEffect(() => {
    if (!discardConfirming) return;
    discardConfirmationRef.current?.focus();
  }, [discardConfirming]);

  const openLifecycleConfirmation = (intent: LifecycleAction) => {
    const allowed = intent === 'deactivate'
      ? member.active && actions.canDeactivate
      : !member.active && actions.canReactivate;
    if (!allowed || busy || dirty || lifecyclePending) return;
    try {
      lifecycleOperationRef.current = getOrCreateLifecycleOperation(member.accountId, intent);
      setLifecycleError('');
    } catch (operationError) {
      console.error('[HotelTeamPanel] lifecycle operation UUID failed', operationError);
      setLifecycleError(copy(
        lang,
        "The login change couldn't be prepared securely. Reload and try again.",
        'No se pudo preparar el cambio de acceso de forma segura. Recarga e intenta de nuevo.',
      ));
      return;
    }
    setLifecycleIntent(intent);
  };

  const cancelLifecycleConfirmation = () => {
    if (lifecycleSaving || lifecycleInFlightRef.current) return;
    if (lifecyclePending) {
      onClose();
      return;
    }
    const operation = lifecycleOperationRef.current;
    if (operation && !operation.submitted) clearLifecycleOperation(member.accountId, operation);
    lifecycleOperationRef.current = null;
    setLifecycleIntent(null);
    setLifecycleError('');
    window.requestAnimationFrame(() => lifecycleTriggerRef.current?.focus({ preventScroll: true }));
  };

  const cancelDiscardConfirmation = () => {
    setDiscardConfirming(false);
    window.requestAnimationFrame(() => {
      const returnTarget = discardReturnFocusRef.current;
      if (returnTarget?.isConnected && !returnTarget.hasAttribute('disabled')) {
        returnTarget.focus();
      }
    });
  };

  const discardChanges = () => {
    if (busy) return;
    onClose();
  };

  const requestDialogClose = () => {
    if (busy || lifecycleInFlightRef.current) return;
    if (lifecyclePending) {
      onClose();
      return;
    }
    if (lifecycleIntent) {
      cancelLifecycleConfirmation();
      return;
    }
    if (discardConfirming) {
      cancelDiscardConfirmation();
      return;
    }
    if (dirty) {
      setDiscardConfirming(true);
      return;
    }
    onClose();
  };

  const markLifecyclePending = (operation: LifecycleOperation) => {
    setLifecyclePending(true);
    onLifecyclePending({
      accountId: member.accountId,
      action: operation.action,
      operationId: operation.operationId,
      clearStoredOperation: () => clearLifecycleOperation(member.accountId, operation),
    });
  };

  const submitLifecycle = async () => {
    if (!lifecycleIntent || busy || lifecyclePending || lifecycleInFlightRef.current) return;
    const actionStillAllowed = lifecycleIntent === 'deactivate'
      ? member.active && actions.canDeactivate
      : !member.active && actions.canReactivate;
    if (!actionStillAllowed) return;

    lifecycleInFlightRef.current = true;
    setLifecycleSaving(true);
    setLifecyclePending(false);
    setLifecycleError('');
    let submittedOperation: LifecycleOperation | null = null;
    try {
      let operation = lifecycleOperationRef.current;
      if (!operation || operation.action !== lifecycleIntent) {
        operation = getOrCreateLifecycleOperation(member.accountId, lifecycleIntent);
      }
      operation = { ...operation, submitted: true };
      lifecycleOperationRef.current = operation;
      persistLifecycleOperation(member.accountId, operation);
      submittedOperation = operation;

      const response = await fetchWithAuth('/api/auth/team/status', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          hotelId,
          accountId: member.accountId,
          action: lifecycleIntent,
          operationId: operation.operationId,
        }),
        signal: mutationSignal(),
      });
      const body = await response.json().catch(() => ({})) as Envelope<{ success?: boolean }>;
      if (!response.ok || !body.ok) {
        if (lifecycleResponseNeedsReconciliation(response, body, operation.operationId)) {
          markLifecyclePending(operation);
          return;
        }
        if (lifecycleResponseIsDefinitivelyAborted(response)) {
          clearLifecycleOperation(member.accountId, operation);
          lifecycleOperationRef.current = null;
        }
        setLifecycleError(responseError(
          body,
          lifecycleIntent === 'deactivate'
            ? copy(lang, "Couldn't disable this login.", 'No se pudo desactivar este acceso.')
            : copy(lang, "Couldn't reactivate this login.", 'No se pudo reactivar este acceso.'),
        ));
        return;
      }
      clearLifecycleOperation(member.accountId, operation);
      lifecycleOperationRef.current = null;
      await onSaved();
    } catch (lifecycleFailure) {
      console.error('[HotelTeamPanel] account lifecycle change failed', lifecycleFailure);
      if (submittedOperation) {
        // A lost response is ambiguous: the server may have durably registered
        // or committed this exact UUID. Keep it and let the panel reconcile.
        markLifecyclePending(submittedOperation);
        return;
      }
      setLifecycleError(copy(
        lang,
        "The login status couldn't be changed. Check your connection and try again.",
        'No se pudo cambiar el estado del acceso. Revisa tu conexión e intenta de nuevo.',
      ));
    } finally {
      lifecycleInFlightRef.current = false;
      setLifecycleSaving(false);
    }
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!dirty || formLocked) return;
    if (!trimmedName) {
      setError(copy(lang, 'Name is required.', 'El nombre es obligatorio.'));
      return;
    }
    if (passwordChanged && password.length < 6) {
      setError(copy(lang, 'The new password must have at least 6 characters.', 'La nueva contraseña debe tener al menos 6 caracteres.'));
      return;
    }

    setSaving(true);
    setError('');
    setPartialSuccess('');
    let profileSaved = false;
    try {
      // Profile data and passwords live in different stores and cannot be one
      // atomic mutation. Save the profile first, then the password, so each
      // response is truthful and a second-step failure can be explained.
      if (nameChanged || roleChanged) {
        const profilePayload: Record<string, unknown> = { hotelId, accountId: member.accountId };
        if (nameChanged) profilePayload.displayName = trimmedName;
        if (roleChanged) {
          profilePayload.role = role;
          // The guarded role RPC must compare the row the person actually
          // opened, not a fresh server read that could hide a concurrent edit.
          profilePayload.expectedRole = member.role;
          profilePayload.expectedDisplayName = member.displayName;
          profilePayload.expectedUpdatedAt = member.updatedAt;
        }
        const profileResponse = await fetchWithAuth('/api/auth/team', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(profilePayload),
          signal: mutationSignal(),
        });
        const profileBody = await profileResponse.json().catch(() => ({})) as Envelope<{ success?: boolean }>;
        if (!profileResponse.ok || !profileBody.ok) {
          setError(responseError(profileBody, copy(lang, "Couldn't save the name or role.", 'No se pudo guardar el nombre o el rol.')));
          return;
        }
        setSavedDisplayName(trimmedName);
        setSavedRole(role);
        profileSaved = true;
      }

      if (passwordChanged) {
        const passwordResponse = await fetchWithAuth('/api/auth/team', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ hotelId, accountId: member.accountId, password }),
          signal: mutationSignal(),
        });
        const passwordBody = await passwordResponse.json().catch(() => ({})) as Envelope<{ success?: boolean }>;
        if (!passwordResponse.ok || !passwordBody.ok) {
          if (profileSaved) {
            setPartialSuccess(copy(
              lang,
              'The name and role changes were saved.',
              'Los cambios de nombre y rol se guardaron.',
            ));
            try { await onChanged?.(); } catch (refreshError) {
              console.error('[HotelTeamPanel] partial member refresh failed', refreshError);
            }
          }
          setError(responseError(
            passwordBody,
            profileSaved
              ? copy(lang, 'The password was not changed. You can correct it and try again.', 'La contraseña no se cambió. Puedes corregirla e intentarlo de nuevo.')
              : copy(lang, "Couldn't change the password.", 'No se pudo cambiar la contraseña.'),
          ));
          return;
        }
      }
      await onSaved();
    } catch (saveError) {
      console.error('[HotelTeamPanel] member save failed', saveError);
      if (profileSaved && passwordChanged) {
        setPartialSuccess(copy(
          lang,
          'The name and role changes were saved.',
          'Los cambios de nombre y rol se guardaron.',
        ));
        try { await onChanged?.(); } catch (refreshError) {
          console.error('[HotelTeamPanel] partial member refresh failed', refreshError);
        }
        setError(copy(
          lang,
          'The password was not changed because the connection failed. Try the password again.',
          'La contraseña no se cambió porque falló la conexión. Intenta cambiarla de nuevo.',
        ));
      } else {
        setError(copy(lang, "Couldn't save. Check your connection and try again.", 'No se pudo guardar. Revisa tu conexión e intenta de nuevo.'));
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <DialogShell
      title={self ? copy(lang, 'Your account', 'Tu cuenta') : member.displayName}
      eyebrow={copy(lang, 'Hotel account', 'Cuenta del hotel')}
      description={copy(lang, `Manage this login for ${hotelName}. Account-wide changes are labeled below.`, `Administra este acceso para ${hotelName}. Los cambios para toda la cuenta se indican abajo.`)}
      lang={lang}
      icon={<UserRoundCog size={21} aria-hidden="true" />}
      onClose={requestDialogClose}
      busy={busy}
    >
      <form
        className={styles.dialogForm}
        onSubmit={submit}
        onFocusCapture={(event) => {
          if (!discardConfirming && !lifecycleIntent) discardReturnFocusRef.current = event.target as HTMLElement;
        }}
      >
        <label className={styles.field}>
          <span>{copy(lang, 'Display name', 'Nombre visible')}</span>
          <input
            type="text"
            value={displayName}
            onChange={(event) => { setDisplayName(event.target.value); setError(''); setPartialSuccess(''); }}
            autoComplete="name"
            disabled={!actions.canEdit || formLocked}
            maxLength={100}
          />
          {member.globalImpact?.displayNameAffectsAllHotels ? (
            <small className={styles.cautionText}>{copy(
              lang,
              'This display name appears at every hotel this person can access.',
              'Este nombre visible aparece en todos los hoteles a los que esta persona tiene acceso.',
            )}</small>
          ) : null}
        </label>

        <div className={styles.field}>
          <span>{copy(lang, 'Username', 'Usuario')}</span>
          <div className={styles.readOnlyField}>@{member.username}</div>
          <small>{copy(lang, 'Usernames cannot be changed here.', 'Los nombres de usuario no se pueden cambiar aquí.')}</small>
        </div>

        <div className={styles.field}>
          <span>{copy(lang, 'Email', 'Correo electrónico')}</span>
          <div className={styles.readOnlyField}>{member.email || copy(lang, 'Email unavailable', 'Correo no disponible')}</div>
        </div>

        <section className={styles.accountAccessCard} aria-labelledby={accountAccessHeadingId}>
          <div className={styles.accountAccessHeader}>
            <div>
              <span>{copy(lang, 'Account access', 'Acceso de la cuenta')}</span>
              <h3 id={accountAccessHeadingId}>
                {member.active
                  ? copy(lang, 'Login is active', 'El acceso está activo')
                  : copy(lang, 'Login is disabled', 'El acceso está desactivado')}
              </h3>
            </div>
            <span className={`${styles.accountStatusBadge}${member.active ? '' : ` ${styles.accountStatusDisabled}`}`}>
              {member.active
                ? copy(lang, 'Active', 'Activa')
                : copy(lang, 'Login disabled', 'Acceso desactivado')}
            </span>
          </div>
          <p className={styles.accountAccessCopy}>
            {member.active
              ? copy(
                  lang,
                  'This person can sign in at every hotel their account can access.',
                  'Esta persona puede iniciar sesión en todos los hoteles a los que su cuenta tiene acceso.',
                )
              : copy(
                  lang,
                  'Sign-in is blocked everywhere. Their account, hotel access, and records are still kept.',
                  'El inicio de sesión está bloqueado en todas partes. Su cuenta, acceso a hoteles y registros se conservan.',
                )}
          </p>
          <span className={styles.accountAccessMeta}>
            {lastSignInLabel(member.lastSignInKnown, member.lastSignInAt, lang)}
          </span>
          {member.ownerProtected ? (
            <small className={styles.cautionText}>{copy(
              lang,
              'This login stays active while this person is an organization owner. Transfer ownership before changing login status.',
              'Este acceso permanece activo mientras esta persona sea propietaria de la organización. Transfiere la propiedad antes de cambiar el estado del acceso.',
            )}</small>
          ) : null}

          {!lifecycleIntent && canChangeLifecycle ? (
            <div className={styles.lifecycleActions}>
              <button
                ref={lifecycleTriggerRef}
                type="button"
                className={member.active ? styles.dangerButton : styles.primaryButton}
                onClick={() => openLifecycleConfirmation(member.active ? 'deactivate' : 'reactivate')}
                disabled={busy || dirty}
                aria-describedby={dirty ? lifecycleGuidanceId : undefined}
              >
                {member.active
                  ? copy(lang, 'Disable login everywhere', 'Desactivar acceso en todas partes')
                  : copy(lang, 'Reactivate login', 'Reactivar acceso')}
              </button>
              {dirty ? (
                <small id={lifecycleGuidanceId} className={styles.lifecycleGuidance}>
                  {copy(
                    lang,
                    'Save or cancel your unsaved changes before changing login access.',
                    'Guarda o cancela los cambios pendientes antes de cambiar el acceso.',
                  )}
                </small>
              ) : null}
            </div>
          ) : null}
          {!lifecycleIntent && lifecycleError ? <ErrorBanner message={lifecycleError} /> : null}

          {lifecycleIntent ? (
            <div
              className={styles.lifecycleConfirmation}
              ref={lifecycleConfirmationRef}
              role={lifecyclePending ? 'status' : lifecycleIntent === 'deactivate' ? 'alert' : 'status'}
              tabIndex={-1}
              aria-labelledby={lifecycleHeadingId}
              aria-describedby={lifecycleDescriptionId}
            >
              <h3 id={lifecycleHeadingId}>
                {lifecyclePending
                  ? copy(lang, 'Status change pending', 'Cambio de estado pendiente')
                  : lifecycleIntent === 'deactivate'
                  ? copy(lang, 'Disable login everywhere?', '¿Desactivar el acceso en todas partes?')
                  : copy(lang, 'Reactivate login everywhere?', '¿Reactivar el acceso en todas partes?')}
              </h3>
              <p id={lifecycleDescriptionId}>
                {lifecyclePending
                  ? copy(
                      lang,
                      'The final login state is not confirmed yet. This page is checking for a short time with the same request. You can close this dialog; the hotel row will stay pending. If verification pauses, reload later to check the final status.',
                      'El estado final del acceso aún no está confirmado. Esta página lo comprobará durante un breve periodo con la misma solicitud. Puedes cerrar este diálogo; la fila del hotel seguirá pendiente. Si la verificación se pausa, recarga más tarde para comprobar el estado final.',
                    )
                  : lifecycleIntent === 'deactivate'
                  ? copy(
                      lang,
                      'This blocks sign-in at every hotel. The account, hotel access, and records stay in place, and you can reactivate it later.',
                      'Esto bloquea el inicio de sesión en todos los hoteles. La cuenta, el acceso a hoteles y los registros permanecen, y puedes reactivarla después.',
                    )
                  : copy(
                      lang,
                      'This restores sign-in at every hotel this account can access. Existing hotel access and records stay unchanged, and you can disable it again later.',
                      'Esto restaura el inicio de sesión en todos los hoteles a los que esta cuenta tiene acceso. El acceso y los registros existentes no cambian, y puedes volver a desactivarlo después.',
                    )}
              </p>
              {lifecycleError ? <ErrorBanner message={lifecycleError} /> : null}
              <div className={styles.lifecycleConfirmationActions}>
                <button
                  type="button"
                  className={styles.secondaryButton}
                  onClick={lifecyclePending ? onClose : cancelLifecycleConfirmation}
                  disabled={lifecycleSaving}
                >
                  {lifecyclePending
                    ? copy(lang, 'Close while verifying', 'Cerrar durante la verificación')
                    : lifecycleIntent === 'deactivate'
                    ? copy(lang, 'Keep login active', 'Mantener acceso activo')
                    : copy(lang, 'Keep login disabled', 'Mantener acceso desactivado')}
                </button>
                {!lifecyclePending ? (
                  <button
                    type="button"
                    className={lifecycleIntent === 'deactivate' ? styles.dangerButton : styles.primaryButton}
                    onClick={() => void submitLifecycle()}
                    disabled={lifecycleSaving}
                  >
                    {lifecycleSaving
                      ? <BusyLabel lang={lang} en="Saving…" es="Guardando…" />
                      : lifecycleIntent === 'deactivate'
                        ? copy(lang, 'Disable everywhere', 'Desactivar en todas partes')
                        : copy(lang, 'Reactivate everywhere', 'Reactivar en todas partes')}
                  </button>
                ) : null}
              </div>
            </div>
          ) : null}
        </section>

        {actions.canChangeRole ? (
          <label className={styles.field}>
            <span>{copy(lang, 'Hotel role', 'Rol del hotel')}</span>
            <select value={role} onChange={(event) => { setRole(event.target.value); setError(''); setPartialSuccess(''); }} disabled={formLocked}>
              {!assignableRoles.includes(member.role as AssignableRole) ? (
                <option value={member.role}>{roleLabel(member.role, lang)}</option>
              ) : null}
              {assignableRoles.map((option) => <option key={option} value={option}>{roleLabel(option, lang)}</option>)}
            </select>
            {actions.roleIsSharedAcrossHotels ? (
              <small className={styles.cautionText}>{copy(
                lang,
                `This is one account-wide role. Changing it affects all ${member.hotelAccessCount ?? 'of their'} hotels.`,
                `Este es un rol para toda la cuenta. Cambiarlo afecta a los ${member.hotelAccessCount ?? 'demás'} hoteles.`,
              )}</small>
            ) : null}
          </label>
        ) : (
          <div className={styles.field}>
            <span>{copy(lang, 'Hotel role', 'Rol del hotel')}</span>
            <div className={styles.readOnlyField}>{roleLabel(member.role, lang)}</div>
            {member.ownerProtected ? (
              <small>{copy(
                lang,
                'Organization-owner access is protected. Manage ownership from organization access, not this hotel role menu.',
                'El acceso de propietario de la organización está protegido. Administra la propiedad desde el acceso de la organización, no desde este menú de roles del hotel.',
              )}</small>
            ) : member.role === 'owner' ? (
              <small>{copy(
                lang,
                'Owner access is protected and cannot be changed in the ordinary role menu.',
                'El acceso de propietario está protegido y no se puede cambiar en el menú de roles normal.',
              )}</small>
            ) : !member.active ? (
              <small>{copy(
                lang,
                'Reactivate this login before changing its role.',
                'Reactiva este acceso antes de cambiar su rol.',
              )}</small>
            ) : actions.roleIsSharedAcrossHotels ? (
              <small className={styles.cautionText}>{copy(
                lang,
                'This role is shared across multiple hotels, so it cannot be changed from one hotel.',
                'Este rol se comparte entre varios hoteles, por lo que no se puede cambiar desde un solo hotel.',
              )}</small>
            ) : self ? (
              <small>{copy(lang, 'You cannot change your own role here.', 'No puedes cambiar tu propio rol aquí.')}</small>
            ) : null}
          </div>
        )}

        {actions.canResetPassword ? (
          <label className={styles.field}>
            <span>{copy(lang, 'New password (optional)', 'Nueva contraseña (opcional)')}</span>
            <input
              type="password"
              value={password}
              onChange={(event) => { setPassword(event.target.value); setError(''); setPartialSuccess(''); }}
              autoComplete="new-password"
              placeholder={copy(lang, 'At least 6 characters', 'Al menos 6 caracteres')}
              disabled={formLocked}
              minLength={6}
            />
            {member.propertyAccess.filter((id) => id !== '*').length > 1 ? (
              <small className={styles.cautionText}>{copy(
                lang,
                'A password change affects this person at every hotel they use.',
                'Un cambio de contraseña afecta a esta persona en todos los hoteles que utiliza.',
              )}</small>
            ) : null}
          </label>
        ) : !self ? (
          <div className={styles.infoNotice}>
            <KeyRound size={17} aria-hidden="true" />
            <span>{copy(
              lang,
              'For security, this person resets their own password with “Forgot password” on the sign-in page.',
              'Por seguridad, esta persona restablece su propia contraseña con “Olvidé mi contraseña” en la página de inicio de sesión.',
            )}</span>
          </div>
        ) : null}

        {partialSuccess ? (
          <div className={styles.successNotice} role="status">
            <CheckCircle2 size={18} aria-hidden="true" />
            <div><strong>{copy(lang, 'Profile saved', 'Perfil guardado')}</strong><span>{partialSuccess}</span></div>
          </div>
        ) : null}
        {error ? <ErrorBanner message={error} /> : null}
        {discardConfirming ? (
          <div
            ref={discardConfirmationRef}
            className={styles.lifecycleConfirmation}
            role="alert"
            tabIndex={-1}
            aria-labelledby={discardHeadingId}
            aria-describedby={discardDescriptionId}
          >
            <h3 id={discardHeadingId}>
              {copy(lang, 'Discard unsaved changes?', '¿Descartar los cambios pendientes?')}
            </h3>
            <p id={discardDescriptionId}>
              {copy(
                lang,
                'Your name, role, or password edits will be lost. The account has not been changed yet.',
                'Se perderán tus cambios de nombre, rol o contraseña. La cuenta aún no se ha modificado.',
              )}
            </p>
            <div className={styles.lifecycleConfirmationActions}>
              <button type="button" className={styles.secondaryButton} onClick={cancelDiscardConfirmation}>
                {copy(lang, 'Keep editing', 'Seguir editando')}
              </button>
              <button type="button" className={styles.dangerButton} onClick={discardChanges}>
                {copy(lang, 'Discard changes', 'Descartar cambios')}
              </button>
            </div>
          </div>
        ) : null}
        <div className={styles.dialogFooter}>
          <button type="button" className={styles.secondaryButton} onClick={requestDialogClose} disabled={formLocked}>
            {copy(lang, 'Cancel', 'Cancelar')}
          </button>
          <button type="submit" className={styles.primaryButton} disabled={!dirty || formLocked}>
            {saving
              ? <BusyLabel lang={lang} en="Saving…" es="Guardando…" />
              : copy(lang, 'Save changes', 'Guardar cambios')}
          </button>
        </div>
      </form>
    </DialogShell>
  );
}

export function RemoveHotelAccessDialog({
  hotelId,
  hotelName,
  member,
  lang,
  onClose,
  onRemoved,
}: {
  hotelId: string;
  hotelName: string;
  member: HotelTeamMember;
  lang: HotelTeamLang;
  onClose: () => void;
  onRemoved: () => void | Promise<void>;
}) {
  const [removing, setRemoving] = React.useState(false);
  const [error, setError] = React.useState('');

  const remove = async () => {
    if (removing) return;
    setRemoving(true);
    setError('');
    try {
      const query = new URLSearchParams({ hotelId, accountId: member.accountId });
      const response = await fetchWithAuth(`/api/auth/team?${query.toString()}`, {
        method: 'DELETE',
        signal: mutationSignal(),
      });
      const body = await response.json().catch(() => ({})) as Envelope<{ success?: boolean }>;
      if (!response.ok || !body.ok) {
        setError(responseError(body, copy(lang, "Couldn't remove hotel access.", 'No se pudo quitar el acceso al hotel.')));
        return;
      }
      await onRemoved();
    } catch (removeError) {
      console.error('[HotelTeamPanel] remove access failed', removeError);
      setError(copy(lang, "Couldn't remove access. Check your connection and try again.", 'No se pudo quitar el acceso. Revisa tu conexión e intenta de nuevo.'));
    } finally {
      setRemoving(false);
    }
  };

  return (
    <DialogShell
      title={copy(lang, 'Remove hotel access?', '¿Quitar acceso al hotel?')}
      eyebrow={copy(lang, 'Access change', 'Cambio de acceso')}
      description={copy(
        lang,
        `${member.displayName} will no longer be able to open ${hotelName}.`,
        `${member.displayName} ya no podrá abrir ${hotelName}.`,
      )}
      lang={lang}
      icon={<Trash2 size={21} aria-hidden="true" />}
      onClose={onClose}
      busy={removing}
    >
      <div className={styles.confirmBody}>
        <div className={styles.mutationPreview}>
          <div><span>{copy(lang, 'Person', 'Persona')}</span><strong>{member.displayName}</strong></div>
          <div><span>{copy(lang, 'Removed from', 'Se quita de')}</span><strong>{hotelName}</strong></div>
        </div>
        <div className={styles.infoNotice}>
          <ShieldCheck size={17} aria-hidden="true" />
          <span>{copy(
            lang,
            'Their account is not deleted. Access to other hotels stays unchanged.',
            'Su cuenta no se elimina. El acceso a otros hoteles no cambia.',
          )}</span>
        </div>
        {error ? <ErrorBanner message={error} /> : null}
      </div>
      <div className={styles.dialogFooter}>
        <button type="button" className={styles.secondaryButton} onClick={onClose} disabled={removing}>
          {copy(lang, 'Keep access', 'Mantener acceso')}
        </button>
        <button type="button" className={styles.dangerButton} onClick={() => void remove()} disabled={removing}>
          {removing
            ? <BusyLabel lang={lang} en="Removing…" es="Quitando…" />
            : copy(lang, 'Remove from this hotel', 'Quitar de este hotel')}
        </button>
      </div>
    </DialogShell>
  );
}

export function JoinDecisionDialog({
  hotelId,
  hotelName,
  request,
  decision,
  lang,
  onClose,
  onCompleted,
}: {
  hotelId: string;
  hotelName: string;
  request: HotelJoinRequest;
  decision: 'approve' | 'deny';
  lang: HotelTeamLang;
  onClose: () => void;
  onCompleted: () => void | Promise<void>;
}) {
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState('');
  const approving = decision === 'approve';

  const submit = async () => {
    if (submitting) return;
    setSubmitting(true);
    setError('');
    try {
      const response = await fetchWithAuth('/api/staff/join-requests', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hotelId, requestId: request.id, decision }),
        signal: mutationSignal(),
      });
      const body = await response.json().catch(() => ({})) as Envelope<{ decided?: string; staffId?: string }>;
      if (response.status === 409) {
        // Another manager already handled it. Closing and refreshing is the
        // truthful outcome; retrying the stale action would never work.
        await onCompleted();
        return;
      }
      if (!response.ok || !body.ok) {
        setError(responseError(body, copy(lang, "Couldn't process this request.", 'No se pudo procesar esta solicitud.')));
        return;
      }
      await onCompleted();
    } catch (submitError) {
      console.error('[HotelTeamPanel] join decision failed', submitError);
      setError(copy(lang, "Couldn't process this request. Check your connection and try again.", 'No se pudo procesar esta solicitud. Revisa tu conexión e intenta de nuevo.'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <DialogShell
      title={approving
        ? copy(lang, `Approve ${request.name}?`, `¿Aprobar a ${request.name}?`)
        : copy(lang, `Deny ${request.name}?`, `¿Rechazar a ${request.name}?`)}
      eyebrow={copy(lang, 'Staff signup', 'Registro de personal')}
      description={approving
        ? copy(lang, `This creates their staff profile and hotel login for ${hotelName}.`, `Esto crea su perfil de personal y acceso al hotel ${hotelName}.`)
        : copy(lang, `This declines their request to join ${hotelName}.`, `Esto rechaza su solicitud para unirse a ${hotelName}.`)}
      lang={lang}
      icon={approving ? <UserCheck size={21} aria-hidden="true" /> : <X size={21} aria-hidden="true" />}
      onClose={onClose}
      busy={submitting}
    >
      <div className={styles.confirmBody}>
        <div className={styles.mutationPreview}>
          <div><span>{copy(lang, 'Person', 'Persona')}</span><strong>{request.name}</strong></div>
          <div><span>{copy(lang, 'Department', 'Departamento')}</span><strong>{departmentLabel(request.department, lang)}</strong></div>
          <div><span>{copy(lang, 'Language', 'Idioma')}</span><strong>{request.language === 'es' ? 'Español' : 'English'}</strong></div>
          <div><span>{copy(lang, 'Phone', 'Teléfono')}</span><strong>{request.phone || copy(lang, 'Not provided', 'No indicado')}</strong></div>
        </div>
        {!approving ? (
          <div className={styles.warningNotice}>
            <AlertCircle size={17} aria-hidden="true" />
            <span>{copy(lang, 'They will not receive hotel access. Their signup account remains on file.', 'No recibirán acceso al hotel. Su cuenta de registro permanece registrada.')}</span>
          </div>
        ) : null}
        {error ? <ErrorBanner message={error} /> : null}
      </div>
      <div className={styles.dialogFooter}>
        <button type="button" className={styles.secondaryButton} onClick={onClose} disabled={submitting}>
          {copy(lang, 'Cancel', 'Cancelar')}
        </button>
        <button
          type="button"
          className={approving ? styles.primaryButton : styles.dangerButton}
          onClick={() => void submit()}
          disabled={submitting}
        >
          {submitting
            ? <BusyLabel lang={lang} en="Working…" es="Procesando…" />
            : approving ? copy(lang, 'Approve and add', 'Aprobar y agregar') : copy(lang, 'Deny request', 'Rechazar solicitud')}
        </button>
      </div>
    </DialogShell>
  );
}

export function HotelInviteDialog({
  hotelId,
  hotelName,
  lang,
  canInviteManager,
  onClose,
  onChanged,
}: {
  hotelId: string;
  hotelName: string;
  lang: HotelTeamLang;
  canInviteManager: boolean;
  onClose: () => void;
  onChanged?: () => void | Promise<void>;
}) {
  const [code, setCode] = React.useState<JoinCode | null>(null);
  const [codeLoading, setCodeLoading] = React.useState(true);
  const [codeError, setCodeError] = React.useState('');
  const [codeBusy, setCodeBusy] = React.useState(false);
  const [confirmReplace, setConfirmReplace] = React.useState(false);
  const [qrDataUrl, setQrDataUrl] = React.useState('');
  const [copied, setCopied] = React.useState<'link' | 'code' | 'manager-link' | null>(null);
  const [copyError, setCopyError] = React.useState('');

  const [invites, setInvites] = React.useState<ManagerInvite[]>([]);
  const [invitesLoading, setInvitesLoading] = React.useState(canInviteManager);
  const [invitesError, setInvitesError] = React.useState('');
  const [inviteEmail, setInviteEmail] = React.useState('');
  const [inviteBusy, setInviteBusy] = React.useState(false);
  const [inviteError, setInviteError] = React.useState('');
  const [lastInvite, setLastInvite] = React.useState<{
    email: string;
    link: string | null;
    emailSent: boolean;
  } | null>(null);
  const [revokeInviteId, setRevokeInviteId] = React.useState<string | null>(null);
  const [revokingInviteId, setRevokingInviteId] = React.useState<string | null>(null);

  const codeAbortRef = React.useRef<AbortController | null>(null);
  const invitesAbortRef = React.useRef<AbortController | null>(null);
  const codeSequenceRef = React.useRef(0);
  const invitesSequenceRef = React.useRef(0);

  const loadCode = React.useCallback(async () => {
    codeAbortRef.current?.abort();
    const controller = new AbortController();
    codeAbortRef.current = controller;
    const sequence = ++codeSequenceRef.current;
    setCodeLoading(true);
    setCodeError('');
    try {
      const response = await fetchWithAuth(`/api/auth/join-codes?hotelId=${encodeURIComponent(hotelId)}`, {
        signal: controller.signal,
      });
      const body = await response.json().catch(() => ({})) as Envelope<{ codes?: JoinCode[] }>;
      if (!response.ok || !body.ok) {
        throw new Error(responseError(body, copy(lang, "Couldn't load the staff invite link.", 'No se pudo cargar el enlace de invitación.')));
      }
      if (controller.signal.aborted || sequence !== codeSequenceRef.current) return;
      setCode((body.data?.codes ?? []).find(isUsable) ?? null);
    } catch (loadError) {
      if (controller.signal.aborted || sequence !== codeSequenceRef.current) return;
      console.error('[HotelInviteDialog] join-code load failed', loadError);
      setCode(null);
      setCodeError(loadError instanceof Error && loadError.message
        ? loadError.message
        : copy(lang, "Couldn't load the staff invite link.", 'No se pudo cargar el enlace de invitación.'));
    } finally {
      if (!controller.signal.aborted && sequence === codeSequenceRef.current) setCodeLoading(false);
    }
  }, [hotelId, lang]);

  const loadInvites = React.useCallback(async () => {
    if (!canInviteManager) {
      invitesAbortRef.current?.abort();
      setInvites([]);
      setInvitesLoading(false);
      setInvitesError('');
      return;
    }
    invitesAbortRef.current?.abort();
    const controller = new AbortController();
    invitesAbortRef.current = controller;
    const sequence = ++invitesSequenceRef.current;
    setInvitesLoading(true);
    setInvitesError('');
    try {
      const response = await fetchWithAuth(`/api/auth/invites?hotelId=${encodeURIComponent(hotelId)}`, {
        signal: controller.signal,
      });
      const body = await response.json().catch(() => ({})) as Envelope<{ invites?: ManagerInvite[] }>;
      if (!response.ok || !body.ok) {
        throw new Error(responseError(body, copy(lang, "Couldn't load manager invitations.", 'No se pudieron cargar las invitaciones de gerentes.')));
      }
      if (controller.signal.aborted || sequence !== invitesSequenceRef.current) return;
      setInvites(body.data?.invites ?? []);
    } catch (loadError) {
      if (controller.signal.aborted || sequence !== invitesSequenceRef.current) return;
      console.error('[HotelInviteDialog] invite load failed', loadError);
      setInvites([]);
      setInvitesError(loadError instanceof Error && loadError.message
        ? loadError.message
        : copy(lang, "Couldn't load manager invitations.", 'No se pudieron cargar las invitaciones de gerentes.'));
    } finally {
      if (!controller.signal.aborted && sequence === invitesSequenceRef.current) setInvitesLoading(false);
    }
  }, [canInviteManager, hotelId, lang]);

  React.useEffect(() => {
    void loadCode();
    void loadInvites();
    return () => {
      codeAbortRef.current?.abort();
      invitesAbortRef.current?.abort();
    };
  }, [loadCode, loadInvites]);

  React.useEffect(() => {
    if (!code) {
      setQrDataUrl('');
      return;
    }
    let active = true;
    void QRCode.toDataURL(signupLinkFor(code.code), {
      width: 320,
      margin: 1,
      errorCorrectionLevel: 'M',
      color: { dark: '#1f231c', light: '#ffffff' },
    }).then((url) => {
      if (active) setQrDataUrl(url);
    }).catch((qrError) => {
      console.error('[HotelInviteDialog] QR render failed', qrError);
      if (active) setQrDataUrl('');
    });
    return () => { active = false; };
  }, [code]);

  const announceCopy = async (value: string, target: 'link' | 'code' | 'manager-link') => {
    setCopyError('');
    const success = await copyToClipboard(value);
    if (!success) {
      setCopyError(copy(lang, 'Copy failed. Select the text and copy it manually.', 'No se pudo copiar. Selecciona el texto y cópialo manualmente.'));
      return;
    }
    setCopied(target);
    window.setTimeout(() => setCopied((current) => current === target ? null : current), 1_800);
  };

  const createCode = async (replaceCurrent: boolean) => {
    if (codeBusy) return;
    setCodeBusy(true);
    setCodeError('');
    setConfirmReplace(false);
    try {
      if (replaceCurrent && code) {
        const revokeResponse = await fetchWithAuth(`/api/auth/join-codes?id=${encodeURIComponent(code.id)}`, {
          method: 'DELETE',
          signal: mutationSignal(),
        });
        const revokeBody = await revokeResponse.json().catch(() => ({})) as Envelope<{ success?: boolean }>;
        if (!revokeResponse.ok || !revokeBody.ok) {
          setCodeError(responseError(revokeBody, copy(lang, "The current link is still active because it couldn't be replaced.", 'El enlace actual sigue activo porque no se pudo reemplazar.')));
          return;
        }
        setCode(null);
      }

      const response = await fetchWithAuth('/api/auth/join-codes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hotelId }),
        signal: mutationSignal(),
      });
      const body = await response.json().catch(() => ({})) as Envelope<{ joinCode?: JoinCode }>;
      if (!response.ok || !body.ok || !body.data?.joinCode) {
        setCodeError(responseError(
          body,
          replaceCurrent
            ? copy(lang, "The old link was disabled, but a new one couldn't be created. Try again.", 'El enlace anterior se desactivó, pero no se pudo crear uno nuevo. Intenta de nuevo.')
            : copy(lang, "Couldn't create the staff invite link.", 'No se pudo crear el enlace de invitación.'),
        ));
        return;
      }
      setCode(body.data.joinCode);
      await onChanged?.();
    } catch (createError) {
      console.error('[HotelInviteDialog] join-code mutation failed', createError);
      setCodeError(copy(lang, "Couldn't update the invite link. Check your connection and try again.", 'No se pudo actualizar el enlace. Revisa tu conexión e intenta de nuevo.'));
    } finally {
      setCodeBusy(false);
    }
  };

  const sendManagerInvite = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!canInviteManager) return;
    const email = inviteEmail.trim().toLowerCase();
    if (!email || inviteBusy) return;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setInviteError(copy(lang, 'Enter a valid email address.', 'Ingresa un correo electrónico válido.'));
      return;
    }
    setInviteBusy(true);
    setInviteError('');
    setLastInvite(null);
    try {
      const response = await fetchWithAuth('/api/auth/invites', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hotelId, email, role: 'general_manager' }),
        signal: mutationSignal(),
      });
      const body = await response.json().catch(() => ({})) as Envelope<InvitePostData>;
      if (!response.ok || !body.ok) {
        setInviteError(responseError(body, copy(lang, "Couldn't create the manager invitation.", 'No se pudo crear la invitación del gerente.')));
        return;
      }
      const data = body.data ?? {};
      const emailSent = data.emailSent === true || data.deliveryStatus === 'sent';
      setLastInvite({ email, link: data.inviteLink ?? null, emailSent });
      setInviteEmail('');
      await loadInvites();
      await onChanged?.();
    } catch (sendError) {
      console.error('[HotelInviteDialog] manager invite failed', sendError);
      setInviteError(copy(lang, "Couldn't create the invitation. Check your connection and try again.", 'No se pudo crear la invitación. Revisa tu conexión e intenta de nuevo.'));
    } finally {
      setInviteBusy(false);
    }
  };

  const revokeInvite = async (invite: ManagerInvite) => {
    if (!canInviteManager) return;
    if (revokingInviteId) return;
    setRevokingInviteId(invite.id);
    setInvitesError('');
    try {
      const response = await fetchWithAuth(`/api/auth/invites?id=${encodeURIComponent(invite.id)}`, {
        method: 'DELETE',
        signal: mutationSignal(),
      });
      const body = await response.json().catch(() => ({})) as Envelope<{ success?: boolean }>;
      if (!response.ok || !body.ok) {
        setInvitesError(responseError(body, copy(lang, 'The invitation is still active because it could not be revoked.', 'La invitación sigue activa porque no se pudo revocar.')));
        return;
      }
      setInvites((current) => current.filter((item) => item.id !== invite.id));
      setRevokeInviteId(null);
      await onChanged?.();
    } catch (revokeError) {
      console.error('[HotelInviteDialog] invite revoke failed', revokeError);
      setInvitesError(copy(lang, 'The invitation is still active. Check your connection and try again.', 'La invitación sigue activa. Revisa tu conexión e intenta de nuevo.'));
    } finally {
      setRevokingInviteId(null);
    }
  };

  const activeLink = code ? signupLinkFor(code.code) : '';
  const busy = codeBusy || inviteBusy || Boolean(revokingInviteId);

  return (
    <DialogShell
      title={copy(lang, 'Invite hotel staff', 'Invitar personal del hotel')}
      eyebrow={hotelName}
      description={copy(
        lang,
        canInviteManager
          ? 'Staff use the shared link or QR code. General Managers receive an email-specific invitation.'
          : 'Staff use the shared link, signup code, or QR code.',
        canInviteManager
          ? 'El personal usa el enlace compartido o el código QR. Los gerentes generales reciben una invitación específica por correo.'
          : 'El personal usa el enlace compartido, el código de registro o el código QR.',
      )}
      lang={lang}
      icon={<UserCheck size={21} aria-hidden="true" />}
      onClose={onClose}
      busy={busy}
      wide
    >
      <div className={styles.inviteBody} aria-busy={codeLoading || invitesLoading}>
        <section className={styles.inviteSection} aria-labelledby="staff-invite-heading">
          <div className={styles.inviteSectionHeading}>
            <span className={styles.sectionIcon}><Link2 size={18} aria-hidden="true" /></span>
            <div>
              <h3 id="staff-invite-heading">{copy(lang, 'Staff signup link', 'Enlace de registro del personal')}</h3>
              <p>{copy(lang, 'Staff choose their department, then wait for your approval.', 'El personal elige su departamento y luego espera tu aprobación.')}</p>
            </div>
          </div>

          {codeLoading ? (
            <InviteSectionSkeleton label={copy(lang, 'Loading invite link…', 'Cargando enlace…')} rows={3} />
          ) : codeError && !code ? (
            <div className={styles.sectionError} role="alert">
              <AlertCircle size={17} aria-hidden="true" /><span>{codeError}</span>
              <button type="button" onClick={() => void loadCode()}>{copy(lang, 'Retry', 'Reintentar')}</button>
            </div>
          ) : code ? (
            <div className={styles.codeLayout}>
              <div className={styles.codeDetails}>
                <label className={styles.copyField}>
                  <span>{copy(lang, 'Invite link', 'Enlace de invitación')}</span>
                  <div>
                    <input value={activeLink} readOnly aria-label={copy(lang, 'Staff invite link', 'Enlace de invitación del personal')} />
                    <button type="button" onClick={() => void announceCopy(activeLink, 'link')}>
                      {copied === 'link' ? <Check size={16} aria-hidden="true" /> : <Copy size={16} aria-hidden="true" />}
                      {copied === 'link' ? copy(lang, 'Copied', 'Copiado') : copy(lang, 'Copy', 'Copiar')}
                    </button>
                  </div>
                </label>

                <div className={styles.codeBlock}>
                  <span>{copy(lang, 'Signup code', 'Código de registro')}</span>
                  <div>
                    <strong>{code.code}</strong>
                    <button type="button" onClick={() => void announceCopy(code.code, 'code')} aria-label={copy(lang, 'Copy signup code', 'Copiar código de registro')}>
                      {copied === 'code' ? <Check size={17} aria-hidden="true" /> : <Copy size={17} aria-hidden="true" />}
                    </button>
                  </div>
                  <small>{copy(
                    lang,
                    `Expires ${formatDate(code.expires_at, lang)} · ${Math.max(0, code.max_uses - code.used_count)} signups remaining`,
                    `Vence el ${formatDate(code.expires_at, lang)} · quedan ${Math.max(0, code.max_uses - code.used_count)} registros`,
                  )}</small>
                </div>

                {confirmReplace ? (
                  <div className={styles.inlineConfirm} role="alert">
                    <strong>{copy(lang, 'Replace this link?', '¿Reemplazar este enlace?')}</strong>
                    <span>{copy(lang, 'The current link and QR code will stop working immediately.', 'El enlace y código QR actuales dejarán de funcionar de inmediato.')}</span>
                    <div>
                      <button type="button" className={styles.secondaryButton} onClick={() => setConfirmReplace(false)} disabled={codeBusy}>{copy(lang, 'Cancel', 'Cancelar')}</button>
                      <button type="button" className={styles.dangerButton} onClick={() => void createCode(true)} disabled={codeBusy}>
                        {codeBusy ? <BusyLabel lang={lang} en="Replacing…" es="Reemplazando…" /> : copy(lang, 'Replace link', 'Reemplazar enlace')}
                      </button>
                    </div>
                  </div>
                ) : (
                  <button type="button" className={styles.secondaryButton} onClick={() => setConfirmReplace(true)} disabled={codeBusy}>
                    <RefreshCw size={15} aria-hidden="true" />{copy(lang, 'Create a new link', 'Crear un enlace nuevo')}
                  </button>
                )}
              </div>
              <div className={styles.qrCard}>
                {qrDataUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={qrDataUrl} width={168} height={168} alt={copy(lang, `QR code to join ${hotelName}`, `Código QR para unirse a ${hotelName}`)} />
                ) : <span className={styles.qrPlaceholder}>{copy(lang, 'QR unavailable', 'QR no disponible')}</span>}
                <span>{copy(lang, 'Scan to sign up', 'Escanear para registrarse')}</span>
              </div>
            </div>
          ) : (
            <div className={styles.noCodeState}>
              <Link2 size={22} aria-hidden="true" />
              <div><strong>{copy(lang, 'No active staff link', 'No hay un enlace activo')}</strong><span>{copy(lang, 'Create one when you are ready to invite staff.', 'Crea uno cuando estés listo para invitar al personal.')}</span></div>
              <button type="button" className={styles.primaryButton} onClick={() => void createCode(false)} disabled={codeBusy}>
                {codeBusy ? <BusyLabel lang={lang} en="Creating…" es="Creando…" /> : copy(lang, 'Create invite link', 'Crear enlace')}
              </button>
            </div>
          )}
          {codeError && code ? <ErrorBanner message={codeError} /> : null}
          {copyError ? <p className={styles.copyError} role="alert">{copyError}</p> : null}
        </section>

        {canInviteManager ? (
        <section className={styles.inviteSection} aria-labelledby="manager-invite-heading">
          <div className={styles.inviteSectionHeading}>
            <span className={styles.sectionIcon}><Mail size={18} aria-hidden="true" /></span>
            <div>
              <h3 id="manager-invite-heading">{copy(lang, 'Invite a General Manager', 'Invitar a un gerente general')}</h3>
              <p>{copy(lang, 'Use this only for a manager. Operational staff use the shared link above.', 'Usa esto solo para un gerente. El personal operativo usa el enlace compartido de arriba.')}</p>
            </div>
          </div>

          <form className={styles.managerInviteForm} onSubmit={sendManagerInvite}>
            <label className={styles.field}>
              <span>{copy(lang, 'Manager email', 'Correo del gerente')}</span>
              <input
                type="email"
                value={inviteEmail}
                onChange={(event) => { setInviteEmail(event.target.value); setInviteError(''); setLastInvite(null); }}
                autoComplete="email"
                placeholder="name@example.com"
                disabled={inviteBusy}
              />
            </label>
            <button type="submit" className={styles.primaryButton} disabled={!inviteEmail.trim() || inviteBusy}>
              {inviteBusy
                ? <BusyLabel lang={lang} en="Creating…" es="Creando…" />
                : <><Mail size={15} aria-hidden="true" />{copy(lang, 'Create invitation', 'Crear invitación')}</>}
            </button>
          </form>
          {inviteError ? <ErrorBanner message={inviteError} /> : null}

          {lastInvite ? (
            <div className={lastInvite.emailSent ? styles.successNotice : styles.deliveryNotice} role="status">
              {lastInvite.emailSent ? <CheckCircle2 size={18} aria-hidden="true" /> : <AlertCircle size={18} aria-hidden="true" />}
              <div>
                <strong>{lastInvite.emailSent
                  ? copy(lang, 'Invitation email sent', 'Correo de invitación enviado')
                  : copy(lang, 'Invitation created—delivery not confirmed', 'Invitación creada—entrega no confirmada')}</strong>
                <span>{lastInvite.emailSent
                  ? copy(lang, `An invitation was sent to ${lastInvite.email}.`, `Se envió una invitación a ${lastInvite.email}.`)
                  : copy(lang, `Staxis cannot confirm an email reached ${lastInvite.email}. Copy and send the link directly.`, `Staxis no puede confirmar que el correo llegó a ${lastInvite.email}. Copia y envía el enlace directamente.`)}</span>
              </div>
              {lastInvite.link ? (
                <button type="button" onClick={() => void announceCopy(lastInvite.link!, 'manager-link')}>
                  {copied === 'manager-link' ? <Check size={15} aria-hidden="true" /> : <Copy size={15} aria-hidden="true" />}
                  {copied === 'manager-link' ? copy(lang, 'Copied', 'Copiado') : copy(lang, 'Copy link', 'Copiar enlace')}
                </button>
              ) : null}
            </div>
          ) : null}

          <div className={styles.inviteListHeading}>
            <h4>{copy(lang, 'Manager invitations', 'Invitaciones de gerentes')}</h4>
            {!invitesLoading && !invitesError ? <span>{invites.length}</span> : null}
          </div>
          {invitesLoading ? (
            <InviteSectionSkeleton label={copy(lang, 'Loading invitations…', 'Cargando invitaciones…')} rows={3} />
          ) : invitesError ? (
            <div className={styles.sectionError} role="alert">
              <AlertCircle size={17} aria-hidden="true" /><span>{invitesError}</span>
              <button type="button" onClick={() => void loadInvites()}>{copy(lang, 'Retry', 'Reintentar')}</button>
            </div>
          ) : invites.length > 0 ? (
            <div className={styles.inviteList} role="list">
              {invites.map((invite) => {
                const expired = new Date(invite.expires_at).getTime() <= Date.now();
                const confirming = revokeInviteId === invite.id;
                return (
                  <div key={invite.id} className={styles.inviteRow} role="listitem">
                    <span className={expired ? styles.expiredInviteIcon : styles.pendingInviteIcon}><Mail size={15} aria-hidden="true" /></span>
                    <div>
                      <strong>{invite.email}</strong>
                      <span>{expired
                        ? copy(lang, `Expired ${formatDate(invite.expires_at, lang)}`, `Venció el ${formatDate(invite.expires_at, lang)}`)
                        : copy(lang, `Pending · expires ${formatDate(invite.expires_at, lang)}`, `Pendiente · vence el ${formatDate(invite.expires_at, lang)}`)}</span>
                    </div>
                    {confirming ? (
                      <div className={styles.revokeConfirm}>
                        <span>{copy(lang, 'Revoke?', '¿Revocar?')}</span>
                        <button type="button" onClick={() => setRevokeInviteId(null)} disabled={Boolean(revokingInviteId)}>{copy(lang, 'No', 'No')}</button>
                        <button type="button" onClick={() => void revokeInvite(invite)} disabled={Boolean(revokingInviteId)}>
                          {revokingInviteId === invite.id ? <span className={styles.buttonSpinner} aria-hidden="true" /> : copy(lang, 'Yes', 'Sí')}
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        className={styles.revokeButton}
                        onClick={() => setRevokeInviteId(invite.id)}
                        disabled={Boolean(revokingInviteId)}
                        aria-label={copy(lang, `Revoke invitation for ${invite.email}`, `Revocar invitación para ${invite.email}`)}
                      >
                        <Trash2 size={15} aria-hidden="true" />
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          ) : (
            <div className={styles.allCaughtUp}><CheckCircle2 size={18} aria-hidden="true" /><span>{copy(lang, 'No pending or expired manager invitations.', 'No hay invitaciones de gerentes pendientes o vencidas.')}</span></div>
          )}
        </section>
        ) : null}
      </div>

      <div className={styles.dialogFooter}>
        <button type="button" className={styles.primaryButton} onClick={onClose} disabled={busy}>
          {copy(lang, 'Done', 'Listo')}
        </button>
      </div>
    </DialogShell>
  );
}
