'use client';

import React from 'react';
import { createPortal } from 'react-dom';
import QRCode from 'qrcode';
import {
  AlertCircle,
  CalendarPlus,
  Check,
  CheckCircle2,
  Copy,
  ChevronRight,
  KeyRound,
  Link2,
  LogIn,
  Mail,
  QrCode,
  RefreshCw,
  ShieldCheck,
  Trash2,
  UserCheck,
  UserRoundCog,
  X,
} from 'lucide-react';

import type { AppUser } from '@/contexts/AuthContext';
import { fetchWithAuth } from '@/lib/api-fetch';
import { copyToClipboard } from '@/lib/copy-to-clipboard';
import { HAT_ROLE_LABELS, isHatRole } from '@/lib/company/roles';
import { ASSIGNABLE_ROLES, type AppRole, type AssignableRole } from '@/lib/roles';

import type {
  HotelInviteRosterProfile,
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
  role: string;
  expires_at: string;
  created_at?: string;
  organizationId: string | null;
  scope: 'hotel' | 'company' | 'property';
  propertyIds: string[];
  propertyNames: string[];
  canRevoke: boolean;
}

interface InvitePostData {
  inviteLink?: string;
  emailSent?: boolean;
  deliveryStatus?: 'sent' | 'link_only';
  accessGranted?: boolean;
  profileLinked?: boolean;
}

type InviteMode = 'shared' | 'email';
type OperationalInviteJob = 'housekeeping' | 'front_desk' | 'maintenance';

const OPERATIONAL_INVITE_JOBS = new Set<OperationalInviteJob>([
  'housekeeping',
  'front_desk',
  'maintenance',
]);

const NO_UNLINKED_ROSTER_PROFILES: readonly HotelInviteRosterProfile[] = [];

function operationalInviteJob(value: string): OperationalInviteJob | null {
  return OPERATIONAL_INVITE_JOBS.has(value as OperationalInviteJob)
    ? value as OperationalInviteJob
    : null;
}

/**
 * What the invite form may ask, projected from current server authority. An
 * independent hotel receives only roles its local manager may grant; a
 * management-company caller also receives the exact per-role hotel choices.
 */
interface InviteOptions {
  choosesHotels: boolean;
  organizationId: string | null;
  jobs: Array<{
    value: string;
    scope: 'company' | 'property';
    label: { en: string; es?: string };
    allowedPropertyIds: string[];
  }>;
  hotels: Array<{ id: string; name: string }>;
}

const NO_INVITE_OPTIONS: InviteOptions = {
  choosesHotels: false, organizationId: null, jobs: [], hotels: [],
};

function pendingInviteScopeLabel(invite: ManagerInvite, lang: HotelTeamLang): string {
  const role = isHatRole(invite.role)
    ? HAT_ROLE_LABELS[invite.role]['en']
    : invite.role;
  if (invite.scope === 'company') {
    return `${role} · ${'Whole company'}`;
  }
  const properties = invite.propertyNames.join(', ');
  return properties ? `${role} · ${properties}` : role;
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
  const labels: Record<string, string> = {
    admin: 'Staxis administrator',
    owner: 'Owner',
    general_manager: 'General Manager',
    front_desk: 'Front Desk',
    housekeeping: 'Housekeeping',
    maintenance: 'Maintenance',
    staff: 'Staff',
  };
  return labels[role] ?? role;
}

function departmentLabel(value: string, lang: HotelTeamLang): string {
  const labels: Record<string, string> = {
    front_desk: 'Front Desk',
    housekeeping: 'Housekeeping',
    maintenance: 'Maintenance',
    other: 'Other',
  };
  const label = labels[value];
  if (label) return label;
  return value.replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function formatDate(value: string, lang: HotelTeamLang): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(parsed);
}

function lastSignInLabel(known: boolean, value: string | null, lang: HotelTeamLang): string {
  if (!known) return 'Last sign-in unavailable';
  if (!value) return 'No sign-ins yet';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return 'Last sign-in unavailable';
  }
  const formatted = new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(parsed);
  return `Last signed in ${formatted}`;
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

function useDialogBehavior(
  onClose: () => void,
  busy: boolean,
  returnFocusRef?: React.RefObject<HTMLElement | null>,
) {
  const closeRef = React.useRef<HTMLButtonElement | null>(null);
  const dialogRef = React.useRef<HTMLDivElement | null>(null);
  const onCloseRef = React.useRef(onClose);
  const busyRef = React.useRef(busy);
  onCloseRef.current = onClose;
  busyRef.current = busy;

  React.useEffect(() => {
    const returnFocusElement = returnFocusRef?.current
      ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
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
  }, [returnFocusRef]);

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
  returnFocusRef,
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
  returnFocusRef?: React.RefObject<HTMLElement | null>;
  children: React.ReactNode;
}) {
  const { closeRef, dialogRef } = useDialogBehavior(onClose, busy, returnFocusRef);
  const titleId = React.useId();
  const descriptionId = React.useId();
  return createPortal(
    <div className={styles.dialogLayer}>
      <button
        type="button"
        className={styles.dialogScrim}
        aria-label={'Close dialog'}
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
            aria-label={'Close'}
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

function BusyLabel({ en }: { en: string }) {
  return <><span className={styles.buttonSpinner} aria-hidden="true" />{en}</>;
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

/**
 * One person, one panel.
 *
 * `employmentSlot` is how My Hotel → People shows a person's EMPLOYMENT record
 * (department, hours cap, pay, vacation, linked login) in the same panel as
 * their LOGIN. It renders above the account form as its own section with its
 * own save, because the two halves hit different systems with different
 * permissions — a manager may be allowed to change somebody's hours and not
 * their role — and one combined save could only ever report half a truth.
 *
 * Omit it and this dialog behaves exactly as it did before the Directory was
 * folded in: login fields only.
 */
export function HotelMemberDialog({
  hotelId,
  hotelName,
  member,
  currentUser,
  currentAccountId,
  lang,
  actions,
  employmentSlot,
  personName,
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
  /** The person's employment section, when they have an employment record or
   *  the viewer should be told why they do not. */
  employmentSlot?: React.ReactNode;
  /** Title override — the roster shows a person's employment name, which can
   *  differ from the login's display name. Keep the panel calling them what
   *  the list called them. */
  personName?: string;
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
      setLifecycleError("The login change couldn't be prepared securely. Reload and try again.");
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
            ? "Couldn't disable this login."
            : "Couldn't reactivate this login.",
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
      setLifecycleError("The login status couldn't be changed. Check your connection and try again.");
    } finally {
      lifecycleInFlightRef.current = false;
      setLifecycleSaving(false);
    }
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!dirty || formLocked) return;
    if (!trimmedName) {
      setError('Name is required.');
      return;
    }
    if (passwordChanged && password.length < 6) {
      setError('The new password must have at least 6 characters.');
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
          setError(responseError(profileBody, "Couldn't save the name or role."));
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
            setPartialSuccess('The name and role changes were saved.');
            try { await onChanged?.(); } catch (refreshError) {
              console.error('[HotelTeamPanel] partial member refresh failed', refreshError);
            }
          }
          setError(responseError(
            passwordBody,
            profileSaved
              ? 'The password was not changed. You can correct it and try again.'
              : "Couldn't change the password.",
          ));
          return;
        }
      }
      await onSaved();
    } catch (saveError) {
      console.error('[HotelTeamPanel] member save failed', saveError);
      if (profileSaved && passwordChanged) {
        setPartialSuccess('The name and role changes were saved.');
        try { await onChanged?.(); } catch (refreshError) {
          console.error('[HotelTeamPanel] partial member refresh failed', refreshError);
        }
        setError('The password was not changed because the connection failed. Try the password again.');
      } else {
        setError("Couldn't save. Check your connection and try again.");
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <DialogShell
      title={self
        ? 'Your account'
        : personName || member.displayName}
      eyebrow={employmentSlot
        ? 'Person'
        : 'Hotel account'}
      description={employmentSlot
        ? `Everything Staxis knows about this person at ${hotelName}. Account-wide changes are labeled below.`
        : `Manage this login for ${hotelName}. Account-wide changes are labeled below.`}
      lang={lang}
      icon={<UserRoundCog size={21} aria-hidden="true" />}
      onClose={requestDialogClose}
      busy={busy}
    >
      {employmentSlot}
      {employmentSlot ? (
        <div className={styles.panelDivider}>
          <span>{'Login'}</span>
          <h3>{'Staxis login and hotel access'}</h3>
        </div>
      ) : null}
      <form
        className={styles.dialogForm}
        onSubmit={submit}
        onFocusCapture={(event) => {
          if (!discardConfirming && !lifecycleIntent) discardReturnFocusRef.current = event.target as HTMLElement;
        }}
      >
        <label className={styles.field}>
          <span>{'Display name'}</span>
          <input
            type="text"
            value={displayName}
            onChange={(event) => { setDisplayName(event.target.value); setError(''); setPartialSuccess(''); }}
            autoComplete="name"
            disabled={!actions.canEdit || formLocked}
            maxLength={100}
          />
          {member.globalImpact?.displayNameAffectsAllHotels ? (
            <small className={styles.cautionText}>{'This display name appears at every hotel this person can access.'}</small>
          ) : null}
        </label>

        <div className={styles.field}>
          <span>{'Username'}</span>
          <div className={styles.readOnlyField}>@{member.username}</div>
          <small>{'Usernames cannot be changed here.'}</small>
        </div>

        <div className={styles.field}>
          <span>{'Email'}</span>
          <div className={styles.readOnlyField}>{member.email || 'Email unavailable'}</div>
        </div>

        <section className={styles.accountAccessCard} aria-labelledby={accountAccessHeadingId}>
          <div className={styles.accountAccessHeader}>
            <div>
              <span>{'Account access'}</span>
              <h3 id={accountAccessHeadingId}>
                {member.active
                  ? 'Login is active'
                  : 'Login is disabled'}
              </h3>
            </div>
            <span className={`${styles.accountStatusBadge}${member.active ? '' : ` ${styles.accountStatusDisabled}`}`}>
              {member.active
                ? 'Active'
                : 'Login disabled'}
            </span>
          </div>
          <p className={styles.accountAccessCopy}>
            {member.active
              ? 'This person can sign in at every hotel their account can access.'
              : 'Sign-in is blocked everywhere. Their account, hotel access, and records are still kept.'}
          </p>
          <span className={styles.accountAccessMeta}>
            {lastSignInLabel(member.lastSignInKnown, member.lastSignInAt, lang)}
          </span>
          {member.ownerProtected ? (
            <small className={styles.cautionText}>{'This login stays active while this person is an organization owner. Transfer ownership before changing login status.'}</small>
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
                  ? 'Disable login everywhere'
                  : 'Reactivate login'}
              </button>
              {dirty ? (
                <small id={lifecycleGuidanceId} className={styles.lifecycleGuidance}>
                  {'Save or cancel your unsaved changes before changing login access.'}
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
                  ? 'Status change pending'
                  : lifecycleIntent === 'deactivate'
                  ? 'Disable login everywhere?'
                  : 'Reactivate login everywhere?'}
              </h3>
              <p id={lifecycleDescriptionId}>
                {lifecyclePending
                  ? 'The final login state is not confirmed yet. This page is checking for a short time with the same request. You can close this dialog; the hotel row will stay pending. If verification pauses, reload later to check the final status.'
                  : lifecycleIntent === 'deactivate'
                  ? 'This blocks sign-in at every hotel. The account, hotel access, and records stay in place, and you can reactivate it later.'
                  : 'This restores sign-in at every hotel this account can access. Existing hotel access and records stay unchanged, and you can disable it again later.'}
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
                    ? 'Close while verifying'
                    : lifecycleIntent === 'deactivate'
                    ? 'Keep login active'
                    : 'Keep login disabled'}
                </button>
                {!lifecyclePending ? (
                  <button
                    type="button"
                    className={lifecycleIntent === 'deactivate' ? styles.dangerButton : styles.primaryButton}
                    onClick={() => void submitLifecycle()}
                    disabled={lifecycleSaving}
                  >
                    {lifecycleSaving
                      ? <BusyLabel en="Saving…" />
                      : lifecycleIntent === 'deactivate'
                        ? 'Disable everywhere'
                        : 'Reactivate everywhere'}
                  </button>
                ) : null}
              </div>
            </div>
          ) : null}
        </section>

        {actions.canChangeRole ? (
          <label className={styles.field}>
            <span>{'Hotel role'}</span>
            <select value={role} onChange={(event) => { setRole(event.target.value); setError(''); setPartialSuccess(''); }} disabled={formLocked}>
              {!assignableRoles.includes(member.role as AssignableRole) ? (
                <option value={member.role}>{roleLabel(member.role, lang)}</option>
              ) : null}
              {assignableRoles.map((option) => <option key={option} value={option}>{roleLabel(option, lang)}</option>)}
            </select>
            {actions.roleIsSharedAcrossHotels ? (
              <small className={styles.cautionText}>{`This is one account-wide role. Changing it affects all ${member.hotelAccessCount ?? 'of their'} hotels.`}</small>
            ) : null}
          </label>
        ) : (
          <div className={styles.field}>
            <span>{'Hotel role'}</span>
            <div className={styles.readOnlyField}>{roleLabel(member.role, lang)}</div>
            {member.ownerProtected ? (
              <small>{'Organization-owner access is protected. Manage ownership from organization access, not this hotel role menu.'}</small>
            ) : member.role === 'owner' ? (
              <small>{'Owner access is protected and cannot be changed in the ordinary role menu.'}</small>
            ) : !member.active ? (
              <small>{'Reactivate this login before changing its role.'}</small>
            ) : actions.roleIsSharedAcrossHotels ? (
              <small className={styles.cautionText}>{'This role is shared across multiple hotels, so it cannot be changed from one hotel.'}</small>
            ) : self ? (
              <small>{'You cannot change your own role here.'}</small>
            ) : null}
          </div>
        )}

        {actions.canResetPassword ? (
          <label className={styles.field}>
            <span>{'New password (optional)'}</span>
            <input
              type="password"
              value={password}
              onChange={(event) => { setPassword(event.target.value); setError(''); setPartialSuccess(''); }}
              autoComplete="new-password"
              placeholder={'At least 6 characters'}
              disabled={formLocked}
              minLength={6}
            />
            {member.propertyAccess.filter((id) => id !== '*').length > 1 ? (
              <small className={styles.cautionText}>{'A password change affects this person at every hotel they use.'}</small>
            ) : null}
          </label>
        ) : !self ? (
          <div className={styles.infoNotice}>
            <KeyRound size={17} aria-hidden="true" />
            <span>{'For security, this person resets their own password with “Forgot password” on the sign-in page.'}</span>
          </div>
        ) : null}

        {partialSuccess ? (
          <div className={styles.successNotice} role="status">
            <CheckCircle2 size={18} aria-hidden="true" />
            <div><strong>{'Profile saved'}</strong><span>{partialSuccess}</span></div>
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
              {'Discard unsaved changes?'}
            </h3>
            <p id={discardDescriptionId}>
              {'Your name, role, or password edits will be lost. The account has not been changed yet.'}
            </p>
            <div className={styles.lifecycleConfirmationActions}>
              <button type="button" className={styles.secondaryButton} onClick={cancelDiscardConfirmation}>
                {'Keep editing'}
              </button>
              <button type="button" className={styles.dangerButton} onClick={discardChanges}>
                {'Discard changes'}
              </button>
            </div>
          </div>
        ) : null}
        <div className={styles.dialogFooter}>
          <button type="button" className={styles.secondaryButton} onClick={requestDialogClose} disabled={formLocked}>
            {'Cancel'}
          </button>
          <button type="submit" className={styles.primaryButton} disabled={!dirty || formLocked}>
            {saving
              ? <BusyLabel en="Saving…" />
              : 'Save changes'}
          </button>
        </div>
      </form>
    </DialogShell>
  );
}

/**
 * The same panel for somebody who has NO Staxis login — a housekeeper on the
 * schedule who has never signed in. Same shell, same close behavior; the body
 * is just their employment section, and there is deliberately no login half to
 * show because there is no login.
 */
export function StaffPersonDialog({
  hotelName,
  personName,
  lang,
  onClose,
  children,
}: {
  hotelName: string;
  personName: string;
  lang: HotelTeamLang;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <DialogShell
      title={personName}
      eyebrow={'Person'}
      description={`On the schedule at ${hotelName}. This person has no Staxis login.`}
      lang={lang}
      icon={<UserRoundCog size={21} aria-hidden="true" />}
      onClose={onClose}
    >
      {children}
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
        setError(responseError(body, "Couldn't remove hotel access."));
        return;
      }
      await onRemoved();
    } catch (removeError) {
      console.error('[HotelTeamPanel] remove access failed', removeError);
      setError("Couldn't remove access. Check your connection and try again.");
    } finally {
      setRemoving(false);
    }
  };

  return (
    <DialogShell
      title={'Remove hotel access?'}
      eyebrow={'Access change'}
      description={`${member.displayName} will no longer be able to open ${hotelName}.`}
      lang={lang}
      icon={<Trash2 size={21} aria-hidden="true" />}
      onClose={onClose}
      busy={removing}
    >
      <div className={styles.confirmBody}>
        <div className={styles.mutationPreview}>
          <div><span>{'Person'}</span><strong>{member.displayName}</strong></div>
          <div><span>{'Removed from'}</span><strong>{hotelName}</strong></div>
        </div>
        <div className={styles.infoNotice}>
          <ShieldCheck size={17} aria-hidden="true" />
          <span>{'Their account is not deleted. Access to other hotels stays unchanged.'}</span>
        </div>
        {error ? <ErrorBanner message={error} /> : null}
      </div>
      <div className={styles.dialogFooter}>
        <button type="button" className={styles.secondaryButton} onClick={onClose} disabled={removing}>
          {'Keep access'}
        </button>
        <button type="button" className={styles.dangerButton} onClick={() => void remove()} disabled={removing}>
          {removing
            ? <BusyLabel en="Removing…" />
            : 'Remove from this hotel'}
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
        setError(responseError(body, "Couldn't process this request."));
        return;
      }
      await onCompleted();
    } catch (submitError) {
      console.error('[HotelTeamPanel] join decision failed', submitError);
      setError("Couldn't process this request. Check your connection and try again.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <DialogShell
      title={approving
        ? `Approve ${request.name}?`
        : `Deny ${request.name}?`}
      eyebrow={'Staff signup'}
      description={approving
        ? `This creates their staff profile and hotel login for ${hotelName}.`
        : `This declines their request to join ${hotelName}.`}
      lang={lang}
      icon={approving ? <UserCheck size={21} aria-hidden="true" /> : <X size={21} aria-hidden="true" />}
      onClose={onClose}
      busy={submitting}
    >
      <div className={styles.confirmBody}>
        <div className={styles.mutationPreview}>
          <div><span>{'Person'}</span><strong>{request.name}</strong></div>
          <div><span>{'Department'}</span><strong>{departmentLabel(request.department, lang)}</strong></div>
          <div><span>{'Language'}</span><strong>{'English'}</strong></div>
          <div><span>{'Phone'}</span><strong>{request.phone || 'Not provided'}</strong></div>
        </div>
        {!approving ? (
          <div className={styles.warningNotice}>
            <AlertCircle size={17} aria-hidden="true" />
            <span>{'They will not receive hotel access. Their signup account remains on file.'}</span>
          </div>
        ) : null}
        {error ? <ErrorBanner message={error} /> : null}
      </div>
      <div className={styles.dialogFooter}>
        <button type="button" className={styles.secondaryButton} onClick={onClose} disabled={submitting}>
          {'Cancel'}
        </button>
        <button
          type="button"
          className={approving ? styles.primaryButton : styles.dangerButton}
          onClick={() => void submit()}
          disabled={submitting}
        >
          {submitting
            ? <BusyLabel en="Working…" />
            : approving ? 'Approve and add' : 'Deny request'}
        </button>
      </div>
    </DialogShell>
  );
}

type FirstPersonRole = 'owner' | 'general_manager';

export interface FirstPersonInviteData {
  hotelId: string;
  invitedEmail: string;
  assignedRole: FirstPersonRole;
  signupUrl: string;
  expiresAt: string;
  emailSent: boolean;
  emailError: string | null;
}

/**
 * Platform-admin-only first account invitation. This deliberately does not
 * reuse the ordinary manager-invite form: the first person owns the remaining
 * hotel setup, while every later person follows the normal account invite and
 * acceptance flow rendered by HotelInviteDialog below.
 */
export function FirstPersonInviteDialog({
  hotelId,
  hotelName,
  onClose,
  onChanged,
  onInvited,
}: {
  hotelId: string;
  hotelName: string;
  onClose: () => void;
  onChanged?: () => void | Promise<void>;
  /**
   * Fired once with the server's receipt when an invitation actually exists.
   * Additive: the People panel ignores it and keeps using onChanged to refetch.
   * The admin Add-hotel confirmation uses it to report the outcome behind the
   * dialog, so it never has to guess whether the invitation went out.
   */
  onInvited?: (result: FirstPersonInviteData) => void;
}) {
  const [email, setEmail] = React.useState('');
  const [role, setRole] = React.useState<FirstPersonRole | ''>('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState('');
  const [result, setResult] = React.useState<FirstPersonInviteData | null>(null);
  const [copied, setCopied] = React.useState(false);
  const [copyError, setCopyError] = React.useState('');

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    const normalizedEmail = email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
      setError('Enter a valid email address.');
      return;
    }
    if (role !== 'owner' && role !== 'general_manager') {
      setError('Choose the role this person will receive.');
      return;
    }

    setBusy(true);
    setError('');
    setResult(null);
    try {
      const response = await fetchWithAuth('/api/admin/properties/invite-first-person', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hotelId, email: normalizedEmail, role }),
        signal: mutationSignal(),
      });
      const body = await response.json().catch(() => ({})) as Envelope<FirstPersonInviteData>;
      if (!response.ok || !body.ok || !body.data) {
        setError(responseError(body, "Couldn't create the first-person invitation."));
        return;
      }
      setResult(body.data);
      onInvited?.(body.data);
      await onChanged?.();
    } catch (sendError) {
      console.error('[FirstPersonInviteDialog] invitation failed', sendError);
      setError("Couldn't create the invitation. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  };

  const copyLink = async () => {
    if (!result) return;
    setCopyError('');
    if (!await copyToClipboard(result.signupUrl)) {
      setCopyError('Copy failed. Select the link and copy it manually.');
      return;
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1_800);
  };

  return (
    <DialogShell
      title="Add first person"
      eyebrow={hotelName}
      description="Assign the role before sending the invitation. The invitee cannot change it during signup."
      lang="en"
      icon={<UserCheck size={21} aria-hidden="true" />}
      onClose={onClose}
      busy={busy}
    >
      {result ? (
        <div className={styles.dialogForm}>
          <div className={styles.successNotice} role="status">
            <CheckCircle2 size={18} aria-hidden="true" />
            <div>
              <strong>{result.emailSent ? 'Invitation sent' : 'Invitation created'}</strong>
              <span>
                {result.invitedEmail} is assigned as {roleLabel(result.assignedRole, 'en')}.
                {result.emailSent ? ' They can use the emailed link to begin.' : ' Copy the link below and send it directly.'}
              </span>
            </div>
          </div>
          <label className={styles.copyField}>
            <span>{'First-person onboarding link'}</span>
            <div>
              <input value={result.signupUrl} readOnly aria-label="First-person onboarding link" />
              <button type="button" onClick={() => void copyLink()}>
                {copied ? <Check size={15} aria-hidden="true" /> : <Copy size={15} aria-hidden="true" />}
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
            {copyError ? <small className={styles.copyError}>{copyError}</small> : null}
            {!result.emailSent && result.emailError ? (
              <small className={styles.cautionText}>{'Email delivery was unavailable, but this link is active.'}</small>
            ) : null}
          </label>
          <div className={styles.dialogFooter}>
            <button type="button" className={styles.primaryButton} onClick={onClose}>{'Done'}</button>
          </div>
        </div>
      ) : (
        <form className={styles.dialogForm} onSubmit={(event) => void submit(event)}>
          <label className={styles.field}>
            <span>{'Email address'}</span>
            <input
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="person@example.com"
              autoComplete="email"
              required
              disabled={busy}
            />
            <small>{'This address is locked into the invitation and signup account.'}</small>
          </label>
          <label className={styles.field}>
            <span>{'Assigned role'}</span>
            <select
              value={role}
              onChange={(event) => setRole(event.target.value as FirstPersonRole | '')}
              required
              disabled={busy}
            >
              <option value="">{'Choose a role'}</option>
              <option value="owner">{'Owner'}</option>
              <option value="general_manager">{'General Manager'}</option>
            </select>
            <small>{'The invitee sees this role during signup but cannot edit it.'}</small>
          </label>
          <div className={styles.mutationPreview} aria-label="Invitation scope">
            <div><span>{'Hotel'}</span><strong>{hotelName}</strong></div>
            <div><span>{'Setup'}</span><strong>{'First person'}</strong></div>
          </div>
          {error ? <ErrorBanner message={error} /> : null}
          <div className={styles.dialogFooter}>
            <button type="button" className={styles.secondaryButton} onClick={onClose} disabled={busy}>
              {'Cancel'}
            </button>
            <button type="submit" className={styles.primaryButton} disabled={busy || !email.trim() || !role}>
              {busy ? <BusyLabel en="Sending…" /> : <><Mail size={16} aria-hidden="true" />{'Send invitation'}</>}
            </button>
          </div>
        </form>
      )}
    </DialogShell>
  );
}

export function PeopleInviteChooserDialog({
  canAddStaff,
  canInviteToStaxis,
  canSendEmailInvite,
  canShareHotelInvite,
  onAddStaff,
  onInviteToStaxis,
  onClose,
  returnFocusRef,
}: {
  canAddStaff: boolean;
  canInviteToStaxis: boolean;
  canSendEmailInvite: boolean;
  canShareHotelInvite: boolean;
  onAddStaff: () => void;
  onInviteToStaxis: () => void;
  onClose: () => void;
  returnFocusRef?: React.RefObject<HTMLElement | null>;
}) {
  const addStaffDescriptionId = React.useId();
  const inviteDescriptionId = React.useId();
  const inviteDescription = canShareHotelInvite
    ? canSendEmailInvite
      ? 'Send an email invite or share a link, QR code, or invite code.'
      : 'Share a link, QR code, or invite code.'
    : 'Send an email invite.';

  if (!canAddStaff && !canInviteToStaxis) return null;

  return (
    <DialogShell
      title={'Invite people'}
      eyebrow={'People'}
      description={'Does this person need a Staxis login?'}
      lang={'en'}
      icon={<UserRoundCog size={21} aria-hidden="true" />}
      onClose={onClose}
      returnFocusRef={returnFocusRef}
    >
      <div className={styles.peopleInviteChoices} role="group" aria-label="Choose whether this person needs a Staxis login">
        {canAddStaff ? (
          <button
            type="button"
            className={styles.peopleInviteChoice}
            onClick={onAddStaff}
            aria-describedby={addStaffDescriptionId}
          >
            <span className={styles.peopleInviteChoiceIcon} aria-hidden="true">
              <CalendarPlus size={19} />
            </span>
            <span className={styles.peopleInviteChoiceCopy}>
              <strong>{'Add staff member'}</strong>
              <small id={addStaffDescriptionId}>{"Add them to this hotel's roster and schedule. No Staxis account."}</small>
            </span>
            <ChevronRight size={18} aria-hidden="true" />
          </button>
        ) : null}
        {canInviteToStaxis ? (
          <button
            type="button"
            className={styles.peopleInviteChoice}
            onClick={onInviteToStaxis}
            aria-describedby={inviteDescriptionId}
          >
            <span className={styles.peopleInviteChoiceIcon} aria-hidden="true">
              <LogIn size={19} />
            </span>
            <span className={styles.peopleInviteChoiceCopy}>
              <strong>{'Invite to Staxis'}</strong>
              <small id={inviteDescriptionId}>{inviteDescription}</small>
            </span>
            <ChevronRight size={18} aria-hidden="true" />
          </button>
        ) : null}
      </div>
      <div className={styles.dialogFooter}>
        <button type="button" className={styles.secondaryButton} onClick={onClose}>
          {'Cancel'}
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
  canManageHotelRoster = true,
  unlinkedRosterProfiles = NO_UNLINKED_ROSTER_PROFILES,
  onClose,
  onChanged,
  returnFocusRef,
}: {
  hotelId: string;
  hotelName: string;
  lang: HotelTeamLang;
  canInviteManager: boolean;
  canManageHotelRoster?: boolean;
  unlinkedRosterProfiles?: readonly HotelInviteRosterProfile[];
  onClose: () => void;
  onChanged?: () => void | Promise<void>;
  returnFocusRef?: React.RefObject<HTMLElement | null>;
}) {
  const [inviteMode, setInviteMode] = React.useState<InviteMode>(
    canManageHotelRoster ? 'shared' : 'email',
  );
  const [code, setCode] = React.useState<JoinCode | null>(null);
  const [codeLoading, setCodeLoading] = React.useState(canManageHotelRoster);
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
  const [inviteOptions, setInviteOptions] = React.useState<InviteOptions>(NO_INVITE_OPTIONS);
  const [inviteJob, setInviteJob] = React.useState('');
  const [inviteHotelIds, setInviteHotelIds] = React.useState<string[]>([]);
  const [inviteAllHotels, setInviteAllHotels] = React.useState(true);
  const [inviteStaffId, setInviteStaffId] = React.useState('');
  const [inviteBusy, setInviteBusy] = React.useState(false);
  const [inviteError, setInviteError] = React.useState('');
  const [lastInvite, setLastInvite] = React.useState<
    | {
        kind: 'invitation';
        email: string;
        link: string | null;
        emailSent: boolean;
        profileName: string | null;
      }
    | {
        kind: 'access';
        email: string;
        profileName: string | null;
      }
    | null
  >(null);
  const [revokeInviteId, setRevokeInviteId] = React.useState<string | null>(null);
  const [revokingInviteId, setRevokingInviteId] = React.useState<string | null>(null);

  const sharedTabRef = React.useRef<HTMLButtonElement | null>(null);
  const emailTabRef = React.useRef<HTMLButtonElement | null>(null);
  const sharedTabId = React.useId();
  const emailTabId = React.useId();
  const sharedPanelId = React.useId();
  const emailPanelId = React.useId();
  const rosterProfileHelpId = React.useId();

  const codeAbortRef = React.useRef<AbortController | null>(null);
  const invitesAbortRef = React.useRef<AbortController | null>(null);
  const codeSequenceRef = React.useRef(0);
  const invitesSequenceRef = React.useRef(0);
  const selectedInviteJob = inviteOptions.jobs.find((job) => job.value === inviteJob) ?? null;
  const allowedInviteHotelIds = new Set(selectedInviteJob?.allowedPropertyIds ?? []);
  const allowedInviteHotels = inviteOptions.hotels.filter(
    (hotel) => allowedInviteHotelIds.has(hotel.id),
  );
  const selectedOperationalJob = operationalInviteJob(inviteJob);
  const currentHotelCoveredByInvite = Boolean(
    selectedInviteJob?.scope === 'property'
      && allowedInviteHotelIds.has(hotelId)
      && (!inviteOptions.choosesHotels
        || inviteAllHotels
        || inviteHotelIds.includes(hotelId)),
  );
  const linkableRosterProfiles = React.useMemo(() => (
    selectedOperationalJob && currentHotelCoveredByInvite
      ? unlinkedRosterProfiles.filter(
          (profile) => profile.department === selectedOperationalJob,
        )
      : []
  ), [currentHotelCoveredByInvite, selectedOperationalJob, unlinkedRosterProfiles]);
  const hasInviteModeChoice = canManageHotelRoster && canInviteManager;

  React.useEffect(() => {
    // Roster refreshes and concurrent links can invalidate a still-open form.
    // Never retain an id that is no longer one of the visible exact matches.
    setInviteStaffId((current) => (
      current && !linkableRosterProfiles.some((profile) => profile.id === current)
        ? ''
        : current
    ));
  }, [linkableRosterProfiles]);

  const chooseInviteMode = (nextMode: InviteMode, focusTab = false) => {
    setInviteMode(nextMode);
    if (focusTab) {
      (nextMode === 'shared' ? sharedTabRef.current : emailTabRef.current)?.focus();
    }
  };

  const onInviteModeKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    let nextMode: InviteMode | null = null;
    if (event.key === 'ArrowLeft' || event.key === 'Home') nextMode = 'shared';
    if (event.key === 'ArrowRight' || event.key === 'End') nextMode = 'email';
    if (!nextMode) return;
    event.preventDefault();
    chooseInviteMode(nextMode, true);
  };

  const loadCode = React.useCallback(async () => {
    if (!canManageHotelRoster) {
      codeAbortRef.current?.abort();
      setCode(null);
      setCodeLoading(false);
      setCodeError('');
      return;
    }
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
        throw new Error(responseError(body, "Couldn't load the staff invite link."));
      }
      if (controller.signal.aborted || sequence !== codeSequenceRef.current) return;
      setCode((body.data?.codes ?? []).find(isUsable) ?? null);
    } catch (loadError) {
      if (controller.signal.aborted || sequence !== codeSequenceRef.current) return;
      console.error('[HotelInviteDialog] join-code load failed', loadError);
      setCode(null);
      setCodeError(loadError instanceof Error && loadError.message
        ? loadError.message
        : "Couldn't load the staff invite link.");
    } finally {
      if (!controller.signal.aborted && sequence === codeSequenceRef.current) setCodeLoading(false);
    }
  }, [canManageHotelRoster, hotelId]);

  const loadInvites = React.useCallback(async () => {
    if (!canInviteManager) {
      invitesAbortRef.current?.abort();
      setInvites([]);
      setInviteOptions(NO_INVITE_OPTIONS);
      setInviteJob('');
      setInviteHotelIds([]);
      setInviteStaffId('');
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
      const body = await response.json().catch(() => ({})) as Envelope<{
        invites?: ManagerInvite[]; options?: InviteOptions;
      }>;
      if (!response.ok || !body.ok) {
        throw new Error(responseError(body, "Couldn't load manager invitations."));
      }
      if (controller.signal.aborted || sequence !== invitesSequenceRef.current) return;
      setInvites(body.data?.invites ?? []);
      const nextOptions = body.data?.options ?? NO_INVITE_OPTIONS;
      setInviteOptions(nextOptions);
      setInviteJob((current) => (
        nextOptions.jobs.some((job) => job.value === current)
          ? current
          : nextOptions.jobs[0]?.value ?? ''
      ));
      setInviteHotelIds([]);
      setInviteAllHotels(true);
      setInviteStaffId('');
      setRevokeInviteId(null);
    } catch (loadError) {
      if (controller.signal.aborted || sequence !== invitesSequenceRef.current) return;
      console.error('[HotelInviteDialog] invite load failed', loadError);
      setInvites([]);
      setInviteOptions(NO_INVITE_OPTIONS);
      setInviteJob('');
      setInviteHotelIds([]);
      setInviteStaffId('');
      setInvitesError(loadError instanceof Error && loadError.message
        ? loadError.message
        : "Couldn't load manager invitations.");
    } finally {
      if (!controller.signal.aborted && sequence === invitesSequenceRef.current) setInvitesLoading(false);
    }
  }, [canInviteManager, hotelId]);

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
      setCopyError('Copy failed. Select the text and copy it manually.');
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
          setCodeError(responseError(revokeBody, "The current link is still active because it couldn't be replaced."));
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
            ? "The old link was disabled, but a new one couldn't be created. Try again."
            : "Couldn't create the staff invite link.",
        ));
        return;
      }
      setCode(body.data.joinCode);
      await onChanged?.();
    } catch (createError) {
      console.error('[HotelInviteDialog] join-code mutation failed', createError);
      setCodeError("Couldn't update the invite link. Check your connection and try again.");
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
      setInviteError('Enter a valid email address.');
      return;
    }
    // Role and scope come exclusively from the latest server-derived options.
    // This prevents a hard-coded default (or stale browser state) from asking
    // for a role the current caller cannot delegate.
    const selectedJob = inviteOptions.jobs.find((job) => job.value === inviteJob) ?? null;
    if (!selectedJob) {
      setInviteError('Invitation roles are unavailable. Reload and try again.');
      return;
    }
    let scoped: { role: string; scope?: string; propertyIds?: string[] };
    if (selectedJob.scope === 'company') {
      scoped = { role: selectedJob.value, scope: 'company' };
    } else if (inviteOptions.organizationId === null) {
      if (!selectedJob.allowedPropertyIds.includes(hotelId)) {
        setInviteError('Your hotel access changed. Reload and try again.');
        return;
      }
      scoped = { role: selectedJob.value };
    } else {
      const allowed = new Set(selectedJob.allowedPropertyIds);
      const chosen = inviteOptions.choosesHotels
        ? inviteAllHotels
          ? selectedJob.allowedPropertyIds
          : inviteHotelIds.filter((propertyId) => allowed.has(propertyId))
        : allowed.has(hotelId) ? [hotelId] : [];
      if (chosen.length === 0) {
        setInviteError('Choose at least one hotel.');
        return;
      }
      scoped = { role: selectedJob.value, scope: 'property', propertyIds: chosen };
    }

    const selectedRosterProfile = inviteStaffId
      ? linkableRosterProfiles.find((profile) => profile.id === inviteStaffId) ?? null
      : null;
    if (inviteStaffId && !selectedRosterProfile) {
      setInviteError('That roster profile is no longer available. Choose another profile or continue without one.');
      setInviteStaffId('');
      return;
    }

    setInviteBusy(true);
    setInviteError('');
    setLastInvite(null);
    try {
      const response = await fetchWithAuth('/api/auth/invites', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          hotelId,
          email,
          ...scoped,
          ...(selectedRosterProfile ? { staffId: selectedRosterProfile.id } : {}),
        }),
        signal: mutationSignal(),
      });
      const body = await response.json().catch(() => ({})) as Envelope<InvitePostData>;
      if (!response.ok || !body.ok) {
        setInviteError(responseError(body, "Couldn't create the manager invitation."));
        return;
      }
      const data = body.data ?? {};
      if (data.accessGranted === true) {
        setLastInvite({
          kind: 'access',
          email,
          profileName: data.profileLinked === true ? selectedRosterProfile?.name ?? null : null,
        });
      } else {
        const emailSent = data.emailSent === true || data.deliveryStatus === 'sent';
        setLastInvite({
          kind: 'invitation',
          email,
          link: data.inviteLink ?? null,
          emailSent,
          profileName: selectedRosterProfile?.name ?? null,
        });
      }
      setInviteEmail('');
      setInviteHotelIds([]);
      setInviteStaffId('');
      await loadInvites();
      await onChanged?.();
    } catch (sendError) {
      console.error('[HotelInviteDialog] manager invite failed', sendError);
      setInviteError("Couldn't create the invitation. Check your connection and try again.");
    } finally {
      setInviteBusy(false);
    }
  };

  const revokeInvite = async (invite: ManagerInvite) => {
    if (!canInviteManager || !invite.canRevoke) return;
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
        setInvitesError(responseError(body, 'The invitation is still active because it could not be revoked.'));
        return;
      }
      setInvites((current) => current.filter((item) => item.id !== invite.id));
      setRevokeInviteId(null);
      await onChanged?.();
    } catch (revokeError) {
      console.error('[HotelInviteDialog] invite revoke failed', revokeError);
      setInvitesError('The invitation is still active. Check your connection and try again.');
    } finally {
      setRevokingInviteId(null);
    }
  };

  const activeLink = code ? signupLinkFor(code.code) : '';
  const busy = codeBusy || inviteBusy || Boolean(revokingInviteId);

  return (
    <DialogShell
      title={'Invite people to Staxis'}
      eyebrow={hotelName}
      description={!canManageHotelRoster
          ? 'Email one person who needs to log in, then choose their job and exact company or hotel access.'
          : canInviteManager
          ? 'Invite someone who needs to log in. Choose a shared hotel invitation or email one person.'
          : 'Share one hotel invitation as a link, QR code, or signup code.'}
      lang={lang}
      icon={<UserCheck size={21} aria-hidden="true" />}
      onClose={onClose}
      busy={busy}
      wide
      returnFocusRef={returnFocusRef}
    >
      <div className={styles.inviteBody} aria-busy={(canManageHotelRoster && codeLoading) || invitesLoading}>
        {hasInviteModeChoice ? (
          <div className={styles.inviteModePicker} role="tablist" aria-label="Invitation method">
            <button
              ref={sharedTabRef}
              id={sharedTabId}
              type="button"
              role="tab"
              aria-selected={inviteMode === 'shared'}
              aria-controls={sharedPanelId}
              tabIndex={inviteMode === 'shared' ? 0 : -1}
              className={styles.inviteModeButton}
              onClick={() => chooseInviteMode('shared')}
              onKeyDown={onInviteModeKeyDown}
            >
              <span aria-hidden="true"><Link2 size={18} /></span>
              <span><strong>{'Shared hotel invite'}</strong><small>{'Link, QR, or code · staff request approval'}</small></span>
            </button>
            <button
              ref={emailTabRef}
              id={emailTabId}
              type="button"
              role="tab"
              aria-selected={inviteMode === 'email'}
              aria-controls={emailPanelId}
              tabIndex={inviteMode === 'email' ? 0 : -1}
              className={styles.inviteModeButton}
              onClick={() => chooseInviteMode('email')}
              onKeyDown={onInviteModeKeyDown}
            >
              <span aria-hidden="true"><Mail size={18} /></span>
              <span><strong>{'Email one person'}</strong><small>{'Assign their job and company or hotel access'}</small></span>
            </button>
          </div>
        ) : null}

        {canManageHotelRoster && inviteMode === 'shared' ? (
        <section
          id={sharedPanelId}
          className={styles.inviteSection}
          role={hasInviteModeChoice ? 'tabpanel' : undefined}
          aria-labelledby={hasInviteModeChoice ? sharedTabId : 'staff-invite-heading'}
          tabIndex={hasInviteModeChoice ? 0 : undefined}
        >
          <div className={styles.inviteSectionHeading}>
            <span className={styles.sectionIcon}><Link2 size={18} aria-hidden="true" /></span>
            <div>
              <h3 id="staff-invite-heading">{'Shared hotel invite'}</h3>
              <p>{'Staff create their own account, choose their department, then wait for your approval.'}</p>
            </div>
          </div>

          <div className={styles.sharedInviteExplanation}>
            <div>
              <strong>{'One invitation, three ways to share it'}</strong>
              <span>{`Every option opens the same Staxis signup for ${hotelName}.`}</span>
              <span>{'When you approve someone, Staxis reuses one clear matching roster profile or creates a new one.'}</span>
            </div>
            <div className={styles.sharedInviteMethods} aria-label="Ways to share this invitation">
              <span><Link2 size={15} aria-hidden="true" />{'Link'}</span>
              <span><QrCode size={15} aria-hidden="true" />{'QR code'}</span>
              <span><KeyRound size={15} aria-hidden="true" />{'Signup code'}</span>
            </div>
          </div>

          {codeLoading ? (
            <InviteSectionSkeleton label={'Loading invite link…'} rows={3} />
          ) : codeError && !code ? (
            <div className={styles.sectionError} role="alert">
              <AlertCircle size={17} aria-hidden="true" /><span>{codeError}</span>
              <button type="button" onClick={() => void loadCode()}>{'Retry'}</button>
            </div>
          ) : code ? (
            <div className={styles.codeLayout}>
              <div className={styles.codeDetails}>
                <label className={styles.copyField}>
                  <span>{'Shareable link'}</span>
                  <div>
                    <input value={activeLink} readOnly aria-label={'Staff invite link'} />
                    <button type="button" onClick={() => void announceCopy(activeLink, 'link')}>
                      {copied === 'link' ? <Check size={16} aria-hidden="true" /> : <Copy size={16} aria-hidden="true" />}
                      {copied === 'link' ? 'Copied' : 'Copy'}
                    </button>
                  </div>
                </label>

                <div className={styles.codeBlock}>
                  <span>{'Shareable signup code'}</span>
                  <div>
                    <strong>{code.code}</strong>
                    <button type="button" onClick={() => void announceCopy(code.code, 'code')} aria-label={'Copy signup code'}>
                      {copied === 'code' ? <Check size={17} aria-hidden="true" /> : <Copy size={17} aria-hidden="true" />}
                    </button>
                  </div>
                  <small>{`Expires ${formatDate(code.expires_at, lang)} · ${Math.max(0, code.max_uses - code.used_count)} signups remaining`}</small>
                </div>

                {confirmReplace ? (
                  <div className={styles.inlineConfirm} role="alert">
                    <strong>{'Replace this link?'}</strong>
                    <span>{'The current link and QR code will stop working immediately.'}</span>
                    <div>
                      <button type="button" className={styles.secondaryButton} onClick={() => setConfirmReplace(false)} disabled={codeBusy}>{'Cancel'}</button>
                      <button type="button" className={styles.dangerButton} onClick={() => void createCode(true)} disabled={codeBusy}>
                        {codeBusy ? <BusyLabel en="Replacing…" /> : 'Replace link'}
                      </button>
                    </div>
                  </div>
                ) : (
                  <button type="button" className={styles.secondaryButton} onClick={() => setConfirmReplace(true)} disabled={codeBusy}>
                    <RefreshCw size={15} aria-hidden="true" />{'Create a new link'}
                  </button>
                )}
              </div>
              <div className={styles.qrCard}>
                {qrDataUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={qrDataUrl} width={168} height={168} alt={`QR code to join ${hotelName}`} />
                ) : <span className={styles.qrPlaceholder}>{'QR unavailable'}</span>}
                <span>{'Scan to sign up'}</span>
              </div>
            </div>
          ) : (
            <div className={styles.noCodeState}>
              <Link2 size={22} aria-hidden="true" />
              <div><strong>{'No active shared invitation'}</strong><span>{'Create one to get its link, QR code, and signup code.'}</span></div>
              <button type="button" className={styles.primaryButton} onClick={() => void createCode(false)} disabled={codeBusy}>
                {codeBusy ? <BusyLabel en="Creating…" /> : 'Create shared invite'}
              </button>
            </div>
          )}
          {codeError && code ? <ErrorBanner message={codeError} /> : null}
        </section>
        ) : null}

        {canInviteManager && inviteMode === 'email' ? (
        <section
          id={emailPanelId}
          className={styles.inviteSection}
          role={hasInviteModeChoice ? 'tabpanel' : undefined}
          aria-labelledby={hasInviteModeChoice ? emailTabId : 'manager-invite-heading'}
          tabIndex={hasInviteModeChoice ? 0 : undefined}
        >
          <div className={styles.inviteSectionHeading}>
            <span className={styles.sectionIcon}><Mail size={18} aria-hidden="true" /></span>
            <div>
              <h3 id="manager-invite-heading">{'Email one person'}</h3>
              <p>{canManageHotelRoster
                  ? 'Send a private invitation, then choose the job and exact company or hotel access.'
                  : 'Choose the job and exact company or hotel access shown below.'}</p>
            </div>
          </div>

          <div className={styles.emailInviteExplanation}>
            <Mail size={17} aria-hidden="true" />
            <div>
              <strong>{'For one person who needs login access'}</strong>
              <span>{'If they already use Staxis, access is added now. Otherwise, Staxis emails an invitation.'}</span>
            </div>
          </div>

          <form className={styles.managerInviteForm} onSubmit={sendManagerInvite}>
            <label className={styles.field}>
              <span>{'Email'}</span>
              <input
                type="email"
                value={inviteEmail}
                onChange={(event) => { setInviteEmail(event.target.value); setInviteError(''); setLastInvite(null); }}
                autoComplete="email"
                placeholder="name@example.com"
                disabled={inviteBusy}
              />
            </label>

            {/* Question two: what job. The first current server-authorized job
                is selected after every options refresh; there is no privileged
                client-side fallback. */}
            {inviteOptions.jobs.length > 0 ? (
              <label className={styles.field}>
                <span>{'What job'}</span>
                <select
                  value={inviteJob}
                  onChange={(event) => {
                    setInviteJob(event.target.value);
                    setInviteHotelIds([]);
                    setInviteAllHotels(true);
                    setInviteStaffId('');
                    setInviteError('');
                    setLastInvite(null);
                  }}
                  disabled={inviteBusy}
                >
                  {inviteOptions.jobs.map((job) => (
                    <option key={job.value} value={job.value}>
                      {job.label.en}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}

            {/* Question three: which hotels. Only somebody who runs a company is
                ever asked — a General Manager's hotel is implied. */}
            {inviteOptions.choosesHotels
              && allowedInviteHotels.length > 0
              && selectedInviteJob?.scope === 'property'
              ? (
                <fieldset className={styles.hotelChoices} disabled={inviteBusy}>
                  <legend>{'Which hotels'}</legend>
                  <label>
                    <input
                      type="checkbox"
                      checked={inviteAllHotels}
                      onChange={(event) => {
                        setInviteAllHotels(event.target.checked);
                        setInviteStaffId('');
                        setInviteError('');
                        setLastInvite(null);
                      }}
                    />
                    {'All allowed hotels'}
                  </label>
                  {inviteAllHotels ? null : allowedInviteHotels.map((hotel) => (
                    <label key={hotel.id}>
                      <input
                        type="checkbox"
                        checked={inviteHotelIds.includes(hotel.id)}
                        onChange={(event) => {
                          setInviteStaffId('');
                          setInviteError('');
                          setLastInvite(null);
                          setInviteHotelIds((current) => (
                            event.target.checked
                              ? [...new Set([...current, hotel.id])]
                              : current.filter((id) => id !== hotel.id)
                          ));
                        }}
                      />
                      {hotel.name}
                    </label>
                  ))}
                </fieldset>
              ) : null}

            {linkableRosterProfiles.length > 0 ? (
              <label className={`${styles.field} ${styles.rosterLinkField}`}>
                <span className={styles.fieldLabelWithMeta}>
                  {'Link to roster profile'}
                  <em>{'Optional'}</em>
                </span>
                <select
                  value={inviteStaffId}
                  onChange={(event) => {
                    setInviteStaffId(event.target.value);
                    setInviteError('');
                    setLastInvite(null);
                  }}
                  aria-describedby={rosterProfileHelpId}
                  disabled={inviteBusy}
                >
                  <option value="">{'Do not link a roster profile'}</option>
                  {linkableRosterProfiles.map((profile) => (
                    <option key={profile.id} value={profile.id}>{profile.name}</option>
                  ))}
                </select>
                <small id={rosterProfileHelpId}>
                  {'Choose this when the person already appears on this hotel’s schedule. Their login and roster details will stay together.'}
                </small>
              </label>
            ) : null}

            <button
              type="submit"
              className={styles.primaryButton}
              disabled={!inviteEmail.trim() || inviteBusy || !selectedInviteJob}
            >
              {inviteBusy
                ? <BusyLabel en="Creating…" />
                : <><Mail size={15} aria-hidden="true" />{'Send email invitation'}</>}
            </button>
          </form>
          {!invitesLoading && inviteOptions.jobs.length === 0 && !invitesError ? (
            <ErrorBanner message={'Invitation roles are unavailable. Reload this list before inviting someone.'} />
          ) : null}
          {inviteError ? <ErrorBanner message={inviteError} /> : null}

          {lastInvite ? (
            <div
              className={lastInvite.kind === 'access' || lastInvite.emailSent
                ? styles.successNotice
                : styles.deliveryNotice}
              role="status"
            >
              {lastInvite.kind === 'access' || lastInvite.emailSent
                ? <CheckCircle2 size={18} aria-hidden="true" />
                : <AlertCircle size={18} aria-hidden="true" />}
              <div>
                <strong>{lastInvite.kind === 'access'
                  ? 'Access granted — no email sent'
                  : lastInvite.emailSent
                    ? 'Invitation email sent'
                    : 'Invitation created, delivery not confirmed'}</strong>
                <span>{lastInvite.kind === 'access'
                  ? `${lastInvite.email} already has a Staxis account. Their access is ready now.`
                  : lastInvite.emailSent
                    ? `An invitation was sent to ${lastInvite.email}.`
                    : `Staxis cannot confirm an email reached ${lastInvite.email}. Copy and send the link directly.`}</span>
                {lastInvite.profileName ? (
                  <span>{lastInvite.kind === 'access'
                    ? `Their login is now linked to ${lastInvite.profileName}’s roster profile.`
                    : `When they accept, Staxis will link their login to ${lastInvite.profileName}’s roster profile.`}</span>
                ) : null}
              </div>
              {lastInvite.kind === 'invitation' && lastInvite.link ? (
                <button type="button" onClick={() => void announceCopy(lastInvite.link!, 'manager-link')}>
                  {copied === 'manager-link' ? <Check size={15} aria-hidden="true" /> : <Copy size={15} aria-hidden="true" />}
                  {copied === 'manager-link' ? 'Copied' : 'Copy link'}
                </button>
              ) : null}
            </div>
          ) : null}

          <div className={styles.inviteListHeading}>
            <h4>{'Pending email invitations'}</h4>
            {!invitesLoading && !invitesError ? <span>{invites.length}</span> : null}
          </div>
          {invitesLoading ? (
            <InviteSectionSkeleton label={'Loading invitations…'} rows={3} />
          ) : invitesError ? (
            <div className={styles.sectionError} role="alert">
              <AlertCircle size={17} aria-hidden="true" /><span>{invitesError}</span>
              <button type="button" onClick={() => void loadInvites()}>{'Retry'}</button>
            </div>
          ) : invites.length > 0 ? (
            <div className={styles.inviteList} role="list">
              {invites.map((invite) => {
                const expired = new Date(invite.expires_at).getTime() <= Date.now();
                const confirming = invite.canRevoke && revokeInviteId === invite.id;
                return (
                  <div key={invite.id} className={styles.inviteRow} role="listitem">
                    <span className={expired ? styles.expiredInviteIcon : styles.pendingInviteIcon}><Mail size={15} aria-hidden="true" /></span>
                    <div>
                      <strong>{invite.email}</strong>
                      <span>{pendingInviteScopeLabel(invite, lang)}</span>
                      <span>{expired
                        ? `Expired ${formatDate(invite.expires_at, lang)}`
                        : `Pending · expires ${formatDate(invite.expires_at, lang)}`}</span>
                    </div>
                    {confirming ? (
                      <div className={styles.revokeConfirm}>
                        <span>{'Revoke?'}</span>
                        <button type="button" onClick={() => setRevokeInviteId(null)} disabled={Boolean(revokingInviteId)}>{'No'}</button>
                        <button type="button" onClick={() => void revokeInvite(invite)} disabled={Boolean(revokingInviteId)}>
                          {revokingInviteId === invite.id ? <span className={styles.buttonSpinner} aria-hidden="true" /> : 'Yes'}
                        </button>
                      </div>
                    ) : invite.canRevoke ? (
                      <button
                        type="button"
                        className={styles.revokeButton}
                        onClick={() => setRevokeInviteId(invite.id)}
                        disabled={Boolean(revokingInviteId)}
                        aria-label={`Revoke ${pendingInviteScopeLabel(invite, lang)} invitation for ${invite.email}`}
                      >
                        <Trash2 size={15} aria-hidden="true" />
                      </button>
                    ) : null}
                  </div>
                );
              })}
            </div>
          ) : (
            <div className={styles.allCaughtUp}><CheckCircle2 size={18} aria-hidden="true" /><span>{'No pending or expired email invitations.'}</span></div>
          )}
        </section>
        ) : null}
        {copyError ? <p className={styles.copyError} role="alert">{copyError}</p> : null}
      </div>

      <div className={styles.dialogFooter}>
        <button type="button" className={styles.primaryButton} onClick={onClose} disabled={busy}>
          {'Done'}
        </button>
      </div>
    </DialogShell>
  );
}
