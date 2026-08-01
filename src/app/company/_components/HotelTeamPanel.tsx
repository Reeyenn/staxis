'use client';

// ═══════════════════════════════════════════════════════════════════════════
// My Hotel → People. ONE list of everyone who works at this hotel.
//
// Before 2026-07-27 the same humans were listed twice: Staff → Directory
// showed the `staff` table (employment), My Hotel → People showed `accounts`
// (logins) and then, underneath, the `staff` rows that had no login. Nothing on
// screen explained why a housekeeper appeared in two places, or why her manager
// appeared in one. This panel merges both tables into a single roster keyed by
// person and grouped by department — the way a hotel manager actually thinks
// about their people — so one human is one card.
//
// What each half still contributes:
//   • employment (`staff`) — department, on-shift ring, hours-vs-cap bar,
//     SENIOR tag, dimming when inactive, and the Roster / On shift / Near OT
//     counts.
//   • login (`accounts`)   — role, email, last sign-in, disabled state, the
//     owner-protected and shared-across-hotels notices, and the linked marker.
//
// The join is `account_property_staff_links`, surfaced as `staffId` on each row
// of GET /api/auth/team. The merge itself lives in ./people-roster.ts.
// ═══════════════════════════════════════════════════════════════════════════

import React from 'react';
import { createPortal } from 'react-dom';
import {
  AlertCircle,
  AlertTriangle,
  CalendarPlus,
  Clock3,
  KeyRound,
  LogIn,
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
import type { StaffDepartment, StaffMember } from '@/types';

import type { AddStaffAttempt } from './AddStaffDialog';
import {
  ALWAYS_VISIBLE_GROUPS,
  buildHotelRoster,
  rosterCounts,
  type RosterGroupKey,
  type RosterPerson,
} from './people-roster';
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
  /** Authoritative account-access surface returned by /api/auth/team. Company
   * access can make an organization member visible here without creating the
   * hotel's direct first-person/setup account. */
  managementSurface: 'legacy_hotel' | 'company_access';
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

/** A current-hotel schedule profile that does not already own a login link. */
export interface HotelInviteRosterProfile {
  id: string;
  name: string;
  department: StaffDepartment;
}

export interface HotelTeamPanelProps {
  /** The exact hotel being managed. Never falls back to the app-wide hotel. */
  hotelId: string;
  hotelName: string;
  currentUser: AppUser;
  /** Useful for preview shells whose effective account differs from AppUser. */
  currentAccountId?: string;
  lang: HotelTeamLang;
  canManageTeam: boolean;
  /** Exact receipt-derived permission to use the guarded account invitation
   * workflow at this hotel. It never grants private roster access. */
  canInviteAccounts?: boolean;
  /** `view_wages` at this exact hotel. A MANAGER_FLOOR capability: it can never
   *  fall to line staff, no matter what an admin grants. False hides the pay
   *  field, skips the wage fetch, and suppresses the wage write — and
   *  /api/staff/wages checks it again on its own. */
  canViewWages?: boolean;
  readOnly?: boolean;
  adminPreview?: boolean;
  inviteDialogOpen: boolean;
  onInviteDialogOpenChange: (open: boolean) => void;
  /** The employment roster for this hotel, from PropertyContext. */
  staffProfiles?: StaffMember[];
  /** The roster subscription failed — say so instead of implying nobody works
   *  here. */
  rosterUnavailable?: boolean;
  /** May this viewer add somebody to the schedule? */
  canAddStaff?: boolean;
  onChanged?: () => void | Promise<void>;
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

const LazyStaffPersonDialog = React.lazy(async () => {
  const dialogs = await import('./HotelTeamDialogs');
  return { default: dialogs.StaffPersonDialog };
});

const LazyRemoveDialog = React.lazy(async () => {
  const dialogs = await import('./HotelTeamDialogs');
  return { default: dialogs.RemoveHotelAccessDialog };
});

const LazyInviteDialog = React.lazy(async () => {
  const dialogs = await import('./HotelTeamDialogs');
  return { default: dialogs.HotelInviteDialog };
});

const LazyFirstPersonInviteDialog = React.lazy(async () => {
  const dialogs = await import('./HotelTeamDialogs');
  return { default: dialogs.FirstPersonInviteDialog };
});

const LazyDecisionDialog = React.lazy(async () => {
  const dialogs = await import('./HotelTeamDialogs');
  return { default: dialogs.JoinDecisionDialog };
});

const LazyEmploymentForm = React.lazy(async () => {
  const form = await import('./PersonEmploymentForm');
  return { default: form.PersonEmploymentForm };
});

const LazyAddStaffDialog = React.lazy(async () => {
  const dialog = await import('./AddStaffDialog');
  return { default: dialog.AddStaffDialog };
});

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

/**
 * One line on a person's card. A management company means the same person can
 * hold several — "GM — Beaumont" and "Oversees — Lufkin, Tyler" — and each one
 * is a separate row in the database, editable and removable on its own.
 */
interface CompanyJobLine {
  membershipId: string;
  scope: 'company' | 'property';
  role: string;
  label: { en: string; es?: string };
  propertyIds: string[];
  propertyNames: string[];
  /** Additional hotels the API deliberately disclosed but did not name. */
  otherHotelCount?: number;
}

/** "Beaumont, Lufkin", "Beaumont and 2 other hotels", "3 other hotels". */
function jobHotelsLabel(job: CompanyJobLine, lang: HotelTeamLang): string {
  const hidden = job.otherHotelCount ?? 0;
  const named = job.propertyNames.join(', ');
  if (hidden === 0) return named;
  const others = hidden === 1
    ? '1 other hotel'
    : `${hidden} other hotels`;
  return named ? `${named} ${'and'} ${others}` : others;
}

function roleLabel(role: AppRole, lang: HotelTeamLang): string {
  const labels: Record<AppRole, string> = {
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

const GROUP_LABELS: Record<RosterGroupKey, string> = {
  management: 'Management & office',
  housekeeping: 'Housekeeping',
  front_desk: 'Front Desk',
  maintenance: 'Maintenance',
  other: 'Other',
};

function groupLabel(group: RosterGroupKey, lang: HotelTeamLang): string {
  return GROUP_LABELS[group];
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  return `${parts[0]?.[0] ?? ''}${parts.length > 1 ? parts.at(-1)?.[0] ?? '' : ''}`.toUpperCase();
}

function formatPhone(value: string): string {
  const digits = value.replace(/\D/g, '');
  if (digits.length === 10) return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  if (digits.length === 11 && digits.startsWith('1')) {
    return `(${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
  }
  return value;
}

function timeAgo(value: string, lang: HotelTeamLang): string {
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return 'Recently';
  const minutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60_000));
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
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

/**
 * Who may change a person's EMPLOYMENT record (hours, pay, department, active
 * flag, auto-assign rank, linked login).
 *
 * The old Directory had NO hierarchy at all — any manager could edit anybody's
 * staff row, including the owner's. Merging the two surfaces would otherwise
 * turn the employment half into a way around the account half's rules, so it
 * gets the same hierarchy floor: a General Manager may not act on an owner or
 * on another General Manager, nobody may act on a Staxis admin, and a read-only
 * admin preview may not act at all. Anyone with no login (a housekeeper on the
 * schedule) is editable by any manager, exactly as before.
 *
 * This is deliberately its OWN rule and not `resolveActions().canEdit`: that
 * flag also requires authority at every hotel the person's ACCOUNT reaches,
 * which is the right test for an account-wide display-name change and the wrong
 * one for this hotel's own hours and schedule.
 */
function canEditEmployment(
  account: HotelTeamMember | null,
  currentUser: AppUser,
  currentAccountId: string,
  locked: boolean,
): boolean {
  if (locked) return false;
  if (!account) return true;
  if (account.isPlatformAdmin === true || account.role === 'admin') return false;
  if (account.accountId === currentAccountId) return true;
  if (currentUser.role === 'admin' || currentUser.role === 'owner') return true;
  if (currentUser.role === 'general_manager') {
    return account.role !== 'owner' && account.role !== 'general_manager';
  }
  return false;
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
  const loadingLabel = 'Opening dialog…';
  const title = variant === 'invite'
    ? 'Invite hotel staff'
    : variant === 'member'
      ? 'Person details'
      : variant === 'remove'
        ? 'Remove hotel access'
        : 'Review join request';
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
        aria-label={'Close dialog'}
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
            aria-label={'Close'}
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

/** Hours worked against this person's weekly cap. Turns rust within 4 hours of
 *  the cap — the same threshold the Near OT count uses. */
function HoursMeter({ hours, max, lang }: { hours: number; max: number; lang: HotelTeamLang }) {
  const safeMax = max > 0 ? max : 40;
  const ratio = Math.min(1, hours / safeMax);
  const near = hours >= safeMax - 4;
  return (
    <span
      className={`${styles.hoursMeter}${near ? ` ${styles.hoursMeterNear}` : ''}`}
      title={`${hours} of ${safeMax} hours this week`}
    >
      <span className={styles.hoursTrack} aria-hidden="true">
        <span className={styles.hoursFill} style={{ width: `${ratio * 100}%` }} />
      </span>
      <span className={styles.hoursText}>
        {hours}
        <small>/{safeMax}h</small>
      </span>
    </span>
  );
}

export function HotelTeamPanel({
  hotelId,
  hotelName,
  currentUser,
  currentAccountId = currentUser.accountId,
  lang,
  canManageTeam,
  canInviteAccounts = false,
  canViewWages = false,
  readOnly = false,
  adminPreview = false,
  inviteDialogOpen,
  onInviteDialogOpenChange,
  staffProfiles = [],
  rosterUnavailable = false,
  canAddStaff = false,
  onChanged,
}: HotelTeamPanelProps) {
  const [team, setTeam] = React.useState<HotelTeamMember[]>([]);
  const [jobsByAccountId, setJobsByAccountId] = React.useState<Record<string, CompanyJobLine[]>>({});
  const [teamLoading, setTeamLoading] = React.useState(false);
  const [teamError, setTeamError] = React.useState('');
  const [requests, setRequests] = React.useState<HotelJoinRequest[]>([]);
  const [requestsLoading, setRequestsLoading] = React.useState(false);
  const [requestsError, setRequestsError] = React.useState('');
  const [editKey, setEditKey] = React.useState<string | null>(null);
  const [removeMember, setRemoveMember] = React.useState<HotelTeamMember | null>(null);
  const [addDepartment, setAddDepartment] = React.useState<StaffDepartment | null>(null);
  const [pendingAddAttempt, setPendingAddAttempt] = React.useState<AddStaffAttempt | null>(null);
  const [optimisticStaff, setOptimisticStaff] = React.useState<StaffMember[]>([]);
  // Phone numbers and wages never travel over the browser roster projection —
  // `staff` RLS cannot restrict a column. Both are hydrated here from their
  // management-gated service-role routes, tagged with the hotel they belong to
  // so a hotel switch can never render the previous hotel's numbers.
  const [contactSnapshot, setContactSnapshot] = React.useState<{
    hotelId: string; contacts: Record<string, string | null>;
  } | null>(null);
  const [contactsError, setContactsError] = React.useState(false);
  const [wageSnapshot, setWageSnapshot] = React.useState<{
    hotelId: string; wages: Record<string, number | null>;
  } | null>(null);
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
  changedRef.current = onChanged;

  const locked = readOnly;
  const inviteActionDisabled = locked
    || (adminPreview && (teamLoading || Boolean(teamError)));

  // A definitive fresh authorization refresh can revoke hotel-operational
  // standing while this tab is open. Drop every private roster projection as
  // soon as that happens. The parent also changes this component's key across
  // the hotel-authorized/invite-only boundary, so a later re-grant cannot paint
  // an old team's data for even one render while the fresh fetch is pending.
  React.useEffect(() => {
    if (canManageTeam) return;
    teamAbortRef.current?.abort();
    requestAbortRef.current?.abort();
    setTeam([]);
    setJobsByAccountId({});
    setRequests([]);
    setContactSnapshot(null);
    setWageSnapshot(null);
    setOptimisticStaff([]);
    setPendingLifecycleByAccount({});
    setEditKey(null);
    setRemoveMember(null);
    setAddDepartment(null);
    setDecision(null);
  }, [canManageTeam]);

  const contacts = React.useMemo(
    () => (contactSnapshot?.hotelId === hotelId ? contactSnapshot.contacts : {}),
    [contactSnapshot, hotelId],
  );
  const contactsReady = contactSnapshot?.hotelId === hotelId;
  const wages = React.useMemo(
    () => (wageSnapshot?.hotelId === hotelId ? wageSnapshot.wages : {}),
    [wageSnapshot, hotelId],
  );

  const loadTeam = React.useCallback(async (clearFirst = false) => {
    teamAbortRef.current?.abort();
    const controller = new AbortController();
    teamAbortRef.current = controller;
    const sequence = ++teamSequenceRef.current;

    if (!hotelId || !canManageTeam) {
      setTeam([]);
      setTeamLoading(false);
      setTeamError('');
      return;
    }

    if (clearFirst) {
      setTeam([]);
    }
    setTeamLoading(true);
    setTeamError('');
    try {
      const response = await fetchWithAuth(`/api/auth/team?hotelId=${encodeURIComponent(hotelId)}`, {
        signal: controller.signal,
      });
      const body = await response.json().catch(() => ({})) as Envelope<{
        team?: HotelTeamMember[];
        hatsByAccountId?: Record<string, CompanyJobLine[]>;
      }>;
      if (!response.ok || !body.ok) {
        throw new Error(responseError(
          body,
          "Couldn't load the people at this hotel.",
        ));
      }
      if (controller.signal.aborted || sequence !== teamSequenceRef.current) return;
      const responseTeam = body.data?.team ?? [];
      const nextTeam = (adminPreview || readOnly)
        ? responseTeam.filter((member) => !member.isPlatformAdmin && member.role !== 'admin')
        : responseTeam;
      setTeam(nextTeam);
      setJobsByAccountId(body.data?.hatsByAccountId ?? {});
    } catch (error) {
      if (controller.signal.aborted || sequence !== teamSequenceRef.current) return;
      console.error('[HotelTeamPanel] team load failed', error);
      setTeam([]);
      setTeamError(error instanceof Error && error.message
        ? error.message
        : "Couldn't load the people at this hotel. Check your connection and try again.");
    } finally {
      if (!controller.signal.aborted && sequence === teamSequenceRef.current) setTeamLoading(false);
    }
  }, [adminPreview, canManageTeam, hotelId, readOnly]);

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
          "Couldn't load pending approvals.",
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
        : "Couldn't load pending approvals. Check your connection and try again.");
    } finally {
      if (!controller.signal.aborted && sequence === requestSequenceRef.current) setRequestsLoading(false);
    }
  }, [canManageTeam, hotelId]);

  const loadContacts = React.useCallback(async (signal?: AbortSignal) => {
    if (!hotelId || !canManageTeam) return;
    try {
      const response = await fetchWithAuth(
        `/api/staff/contacts?propertyId=${encodeURIComponent(hotelId)}`,
        signal ? { signal } : undefined,
      );
      if (!response.ok) throw new Error(`contacts_failed_${response.status}`);
      const body = await response.json().catch(() => ({})) as Envelope<{
        contacts?: Record<string, string | null>;
      }>;
      if (signal?.aborted) return;
      setContactSnapshot({ hotelId, contacts: body.data?.contacts ?? {} });
      setContactsError(false);
    } catch (error) {
      if (signal?.aborted) return;
      console.error('[HotelTeamPanel] contacts load failed', error);
      setContactsError(true);
    }
  }, [canManageTeam, hotelId]);

  const loadWages = React.useCallback(async (signal?: AbortSignal) => {
    // Pay is fetched ONLY when this viewer holds view_wages at this hotel. The
    // route re-checks it; this just avoids asking for data we may not show.
    if (!hotelId || !canManageTeam || !canViewWages) return;
    try {
      const response = await fetchWithAuth(
        `/api/staff/wages?propertyId=${encodeURIComponent(hotelId)}`,
        signal ? { signal } : undefined,
      );
      if (!response.ok) return;
      const body = await response.json().catch(() => ({})) as Envelope<{
        wages?: Record<string, number | null>;
      }>;
      if (signal?.aborted) return;
      setWageSnapshot({ hotelId, wages: body.data?.wages ?? {} });
    } catch (error) {
      if (signal?.aborted) return;
      console.error('[HotelTeamPanel] wages load failed', error);
    }
  }, [canManageTeam, canViewWages, hotelId]);

  React.useEffect(() => {
    void loadTeam(true);
    return () => teamAbortRef.current?.abort();
  }, [loadTeam]);

  React.useEffect(() => {
    void loadRequests(true);
    return () => requestAbortRef.current?.abort();
  }, [loadRequests]);

  React.useEffect(() => {
    const controller = new AbortController();
    setContactsError(false);
    void loadContacts(controller.signal);
    return () => controller.abort();
  }, [loadContacts]);

  React.useEffect(() => {
    const controller = new AbortController();
    void loadWages(controller.signal);
    return () => controller.abort();
  }, [loadWages]);

  // Drop an optimistic add as soon as the real roster carries it.
  React.useEffect(() => {
    const loadedIds = new Set(staffProfiles.map((member) => member.id));
    setOptimisticStaff((current) => {
      const pending = current.filter((member) => !loadedIds.has(member.id));
      return pending.length === current.length ? current : pending;
    });
  }, [staffProfiles]);

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

  const refreshAfterChange = React.useCallback(async () => {
    await Promise.all([loadTeam(), loadRequests(), loadContacts(), loadWages()]);
    await changedRef.current?.();
  }, [loadContacts, loadRequests, loadTeam, loadWages]);

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
      setEditKey((current) => (current === operation.accountId ? null : current));
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

  // ── The merged roster ────────────────────────────────────────────────────
  const rosterStaff = React.useMemo(() => {
    const loadedIds = new Set(staffProfiles.map((member) => member.id));
    return [
      ...staffProfiles,
      ...optimisticStaff.filter((member) => !loadedIds.has(member.id)),
    ];
  }, [optimisticStaff, staffProfiles]);

  const unlinkedRosterProfiles = React.useMemo<HotelInviteRosterProfile[]>(() => {
    // Do not offer a possibly stale profile while either half of the merged
    // roster is unavailable. The POST rechecks the chosen id server-side too.
    if (teamLoading || teamError || rosterUnavailable) return [];
    const linkedStaffIds = new Set(
      team.flatMap((member) => member.staffId ? [member.staffId] : []),
    );
    return rosterStaff
      .filter((member) => member.isActive !== false && !linkedStaffIds.has(member.id))
      .map((member) => ({
        id: member.id,
        name: member.name,
        department: member.department ?? 'housekeeping',
      }))
      .sort((left, right) => left.name.localeCompare(right.name));
  }, [rosterStaff, rosterUnavailable, team, teamError, teamLoading]);

  const groups = React.useMemo(
    () => buildHotelRoster(team, rosterStaff),
    [rosterStaff, team],
  );
  const visibleGroups = React.useMemo(
    () => groups.filter((group) => group.people.length > 0 || ALWAYS_VISIBLE_GROUPS.has(group.key)),
    [groups],
  );
  const peopleCount = React.useMemo(
    () => groups.reduce((total, group) => total + group.people.length, 0),
    [groups],
  );
  // The first-person lifecycle is about a direct hotel account, not every
  // account that can reach the hotel. Organization-scope company access makes
  // inherited members appear in this authoritative roster, but those members
  // do not replace the hotel's first Owner/GM setup account.
  const hasDirectHotelAccount = team.some(
    (member) => member.managementSurface === 'legacy_hotel',
  );
  const needsFirstPerson = adminPreview
    && !teamLoading
    && !teamError
    && !hasDirectHotelAccount;
  const counts = React.useMemo(() => rosterCounts(rosterStaff), [rosterStaff]);
  const linkAccounts = React.useMemo(
    () => team.map((member) => ({
      accountId: member.accountId,
      displayName: member.displayName,
      username: member.username,
      role: member.role,
      staffId: member.staffId,
    })),
    [team],
  );
  const editPerson = React.useMemo(
    () => groups.flatMap((group) => group.people).find((person) => person.key === editKey) ?? null,
    [editKey, groups],
  );

  const loadingDialogVariant: DialogLoadingVariant = editPerson
    ? 'member'
    : removeMember
      ? 'remove'
      : inviteDialogOpen
        ? 'invite'
        : 'decision';
  const closeLoadingDialog = React.useCallback(() => {
    if (editKey) {
      setEditKey(null);
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
  }, [editKey, inviteDialogOpen, onInviteDialogOpenChange, removeMember]);

  if (!hotelId) {
    return (
      <section className={styles.root} aria-labelledby="hotel-team-title">
        <div className={styles.emptyState}>
          <span><ShieldCheck size={22} aria-hidden="true" /></span>
          <h3 id="hotel-team-title">{'Choose one hotel'}</h3>
          <p>{'Select the exact hotel before viewing or changing its accounts.'}</p>
        </div>
      </section>
    );
  }

  if (!canManageTeam) {
    return (
      <>
        <section className={styles.root} aria-labelledby="hotel-team-title">
          <div className={styles.permissionState}>
            <span><KeyRound size={20} aria-hidden="true" /></span>
            <div>
              <h3 id="hotel-team-title">{'Hotel account settings are private'}</h3>
              <p>{'Only an explicitly authorized hotel manager can view or change this private roster.'}</p>
            </div>
          </div>
        </section>
        <React.Suspense fallback={(
          <DialogLoading lang={lang} hotelName={hotelName} variant="invite" onClose={() => onInviteDialogOpenChange(false)} />
        )}>
          {inviteDialogOpen && canInviteAccounts ? (
            <LazyInviteDialog
              hotelId={hotelId}
              hotelName={hotelName}
              lang={lang}
              canInviteManager
              canManageHotelRoster={false}
              onClose={() => onInviteDialogOpenChange(false)}
              onChanged={() => changedRef.current?.()}
            />
          ) : null}
        </React.Suspense>
      </>
    );
  }

  const editAccount = editPerson?.account ?? null;
  const editActions = editAccount
    ? resolveActions(
        editAccount,
        currentUser,
        currentAccountId,
        locked
          || Boolean(pendingLifecycleByAccount[editAccount.accountId])
          || editAccount.lifecyclePending === true,
      )
    : null;

  const employmentSlot = editPerson ? (
    <LazyEmploymentForm
      // Never let one person's unsaved draft survive into another's panel.
      key={editPerson.key}
      hotelId={hotelId}
      uid={currentUser.uid}
      lang={lang}
      staff={editPerson.staff}
      accounts={linkAccounts}
      canEdit={canEditEmployment(editPerson.account, currentUser, currentAccountId, locked)}
      canViewWages={canViewWages}
      wages={wages}
      contacts={contacts}
      contactsReady={contactsReady}
      contactsUnavailable={contactsError}
      onWageSaved={(staffId, wage) => setWageSnapshot((current) => ({
        hotelId,
        wages: { ...(current?.hotelId === hotelId ? current.wages : {}), [staffId]: wage },
      }))}
      onContactSaved={(staffId, phone) => setContactSnapshot((current) => ({
        hotelId,
        contacts: { ...(current?.hotelId === hotelId ? current.contacts : {}), [staffId]: phone },
      }))}
      onChanged={refreshAfterChange}
      onClosePanel={() => setEditKey(null)}
    />
  ) : null;

  return (
    <div className={styles.root}>
      <section className={styles.subsection} aria-labelledby="team-members-title">
        <div className={styles.subheading}>
          <div className={styles.subheadingCopy}>
            <div className={styles.subheadingTitleRow}>
              <h2 id="team-members-title">{'Everyone at this hotel'}</h2>
              {!teamLoading && !teamError ? (
                <strong aria-label={`${peopleCount} people at this hotel`}>
                  {peopleCount}
                </strong>
              ) : null}
            </div>
          </div>
          {needsFirstPerson ? (
            <button
              type="button"
              className={`${styles.primaryButton} ${styles.headingInviteButton}`}
              onClick={() => onInviteDialogOpenChange(true)}
              disabled={inviteActionDisabled}
              aria-haspopup="dialog"
            >
              <UserPlus size={16} aria-hidden="true" />
              {'Add first person'}
            </button>
          ) : null}
        </div>

        {!needsFirstPerson ? (
          <div className={styles.peopleActions} aria-label="Ways to add people">
            {canAddStaff ? (
              <button
                type="button"
                className={styles.peopleAction}
                onClick={() => setAddDepartment('housekeeping')}
                disabled={locked}
                aria-haspopup="dialog"
              >
                <span className={styles.peopleActionIcon} aria-hidden="true">
                  <CalendarPlus size={19} />
                </span>
                <span className={styles.peopleActionCopy}>
                  <strong>{'Add staff member'}</strong>
                  <small>{'Roster and schedule only · no Staxis login'}</small>
                </span>
              </button>
            ) : null}
            <button
              type="button"
              className={`${styles.peopleAction} ${styles.peopleActionPrimary}`}
              onClick={() => onInviteDialogOpenChange(true)}
              disabled={inviteActionDisabled}
              aria-haspopup="dialog"
            >
              <span className={styles.peopleActionIcon} aria-hidden="true">
                <LogIn size={19} />
              </span>
              <span className={styles.peopleActionCopy}>
                <strong>{'Invite people'}</strong>
                <small>{'Creates login access · share an invite or send email'}</small>
              </span>
            </button>
          </div>
        ) : null}

        <div className={styles.kpiStrip}>
          <div className={styles.kpiCard}>
            <span className={styles.kpiLabel}>{'Roster'}</span>
            <strong>{counts.roster}</strong>
            <small>{'people on the books'}</small>
          </div>
          <div className={styles.kpiCard}>
            <span className={styles.kpiLabel}>{'On shift'}</span>
            <strong>{counts.onShift}</strong>
            <small>{'working right now'}</small>
          </div>
          <div className={`${styles.kpiCard}${counts.nearOvertime > 0 ? ` ${styles.kpiCardAlert}` : ''}`}>
            <span className={styles.kpiLabel}>{'Near overtime'}</span>
            <strong>{counts.nearOvertime}</strong>
            <small>{'within 4h of their weekly cap'}</small>
          </div>
        </div>

        {rosterUnavailable ? (
          <div className={styles.warningNotice} role="alert">
            <AlertTriangle size={17} aria-hidden="true" />
            <span>{'The schedule roster is temporarily unavailable, so some people may be missing. It will reconnect automatically.'}</span>
          </div>
        ) : null}

        {requestsLoading || requestsError || requests.length > 0 ? (
          <div className={styles.teamList} role="list" aria-label={'Waiting to approve'}>
            {requestsLoading ? (
              <div className={`${styles.approvalRow} ${styles.approvalLoadingRow}`} role="listitem">
                <span className={styles.spinner} aria-hidden="true" />
                <span role="status">{'Checking pending approvals…'}</span>
              </div>
            ) : requestsError ? (
              <div className={`${styles.approvalRow} ${styles.approvalErrorRow}`} role="listitem">
                <AlertCircle size={18} aria-hidden="true" />
                <div className={styles.approvalErrorCopy} role="alert">
                  <strong>{'Pending approvals did not load'}</strong>
                  <span>{requestsError}</span>
                </div>
                <button type="button" onClick={() => void loadRequests()}>
                  <RefreshCw size={15} aria-hidden="true" />{'Retry'}
                </button>
              </div>
            ) : requests.map((request) => (
              <div key={request.id} className={styles.approvalRow} role="listitem">
                <span className={styles.waitingIcon}><Clock3 size={16} aria-hidden="true" /></span>
                <div className={styles.rowBody}>
                  <strong>{request.name}</strong>
                  <span>
                    {departmentLabel(request.department, lang)} · {'English'} · {timeAgo(request.created_at, lang)}
                  </span>
                </div>
                <span className={styles.pendingBadge}>{'Pending approval'}</span>
                <div className={styles.approvalActions}>
                  <button
                    type="button"
                    className={styles.approveButton}
                    onClick={() => setDecision({ request, decision: 'approve' })}
                    disabled={locked}
                    aria-label={`Approve ${request.name}`}
                  >
                    <UserCheck size={15} aria-hidden="true" />{'Approve'}
                  </button>
                  <button
                    type="button"
                    className={styles.denyButton}
                    onClick={() => setDecision({ request, decision: 'deny' })}
                    disabled={locked}
                    aria-label={`Deny ${request.name}`}
                  >
                    {'Deny'}
                  </button>
                </div>
              </div>
            ))}
          </div>
        ) : null}

        {teamLoading ? (
          <div className={styles.skeletonList} role="status" aria-label={'Loading the hotel roster'}>
            {[0, 1, 2].map((item) => <span key={item} />)}
          </div>
        ) : teamError ? (
          <div className={styles.errorState} role="alert">
            <AlertCircle size={18} aria-hidden="true" />
            <div><strong>{'The hotel roster did not load'}</strong><span>{teamError}</span></div>
            <button type="button" onClick={() => void loadTeam()}>
              <RefreshCw size={15} aria-hidden="true" />{'Retry'}
            </button>
          </div>
        ) : peopleCount === 0 ? (
          <div className={styles.emptyState}>
            <span><Users size={22} aria-hidden="true" /></span>
            <h3>{needsFirstPerson ? 'Add first person' : 'Nobody here yet'}</h3>
            <p>{needsFirstPerson
              ? 'Invite this hotel’s first Owner or General Manager. Their assigned role is locked into signup.'
              : 'Use Add staff member for someone who only needs the roster and schedule. Use Invite people when they need Staxis login access.'}</p>
            {!locked && needsFirstPerson ? (
              <div className={styles.emptyStateActions}>
                <button
                  type="button"
                  className={styles.primaryButton}
                  onClick={() => onInviteDialogOpenChange(true)}
                >
                  <UserPlus size={16} aria-hidden="true" />
                  {'Add first person'}
                </button>
              </div>
            ) : null}
          </div>
        ) : (
          <div className={styles.departmentGrid}>
            {visibleGroups.map((group) => (
              <section key={group.key} className={styles.departmentCard} aria-label={groupLabel(group.key, lang)}>
                <div className={styles.departmentHeader}>
                  <span className={`${styles.departmentDot} ${styles[`dept_${group.key}`] ?? ''}`} aria-hidden="true" />
                  <h3>{groupLabel(group.key, lang)}</h3>
                  <span className={styles.departmentCount}>{group.people.length}</span>
                </div>
                {group.people.length === 0 ? (
                  <p className={styles.departmentEmpty}>
                    {'Nobody in this department yet.'}
                  </p>
                ) : (
                <div className={styles.personList} role="list">
                  {group.people.map((person) => (
                    <PersonRow
                      key={person.key}
                      person={person}
                      lang={lang}
                      currentUser={currentUser}
                      currentAccountId={currentAccountId}
                      locked={locked}
                      jobsByAccountId={jobsByAccountId}
                      phone={person.staff ? contacts[person.staff.id] ?? null : null}
                      contactsReady={contactsReady}
                      contactsUnavailable={contactsError}
                      pendingLifecycle={person.account
                        ? pendingLifecycleByAccount[person.account.accountId]
                        : undefined}
                      serverLifecyclePollingPaused={serverLifecyclePollingPaused}
                      onOpen={() => setEditKey(person.key)}
                      onRemoveAccess={(member) => setRemoveMember(member)}
                    />
                  ))}
                </div>
                )}
                {canAddStaff && !locked && group.key !== 'management' ? (
                  <button
                    type="button"
                    className={styles.departmentAdd}
                    onClick={() => setAddDepartment(group.key as StaffDepartment)}
                    aria-haspopup="dialog"
                  >
                    <UserPlus size={15} aria-hidden="true" />
                    {`Add to ${groupLabel(group.key, 'en')}`}
                  </button>
                ) : null}
              </section>
            ))}
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
        {editPerson && editAccount && editActions ? (
          <LazyMemberDialog
            hotelId={hotelId}
            hotelName={hotelName}
            member={editAccount}
            personName={editPerson.name}
            currentUser={currentUser}
            currentAccountId={currentAccountId}
            lang={lang}
            actions={editActions}
            employmentSlot={employmentSlot}
            onLifecyclePending={reconcilePendingLifecycle}
            onClose={() => setEditKey(null)}
            onChanged={refreshAfterChange}
            onSaved={async () => {
              setEditKey(null);
              await refreshAfterChange();
            }}
          />
        ) : null}
        {editPerson && !editAccount ? (
          <LazyStaffPersonDialog
            hotelName={hotelName}
            personName={editPerson.name}
            lang={lang}
            onClose={() => setEditKey(null)}
          >
            {employmentSlot}
          </LazyStaffPersonDialog>
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
        {inviteDialogOpen && needsFirstPerson ? (
          <LazyFirstPersonInviteDialog
            hotelId={hotelId}
            hotelName={hotelName}
            onClose={() => onInviteDialogOpenChange(false)}
            onChanged={() => changedRef.current?.()}
          />
        ) : inviteDialogOpen ? (
          <LazyInviteDialog
            hotelId={hotelId}
            hotelName={hotelName}
            lang={lang}
            canInviteManager={canInviteAccounts}
            canManageHotelRoster
            unlinkedRosterProfiles={unlinkedRosterProfiles}
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
        {addDepartment ? (
          <LazyAddStaffDialog
            hotelId={hotelId}
            hotelName={hotelName}
            lang={lang}
            initialDepartment={addDepartment}
            onClose={() => setAddDepartment(null)}
            onAdded={(member) => setOptimisticStaff((current) => (
              current.some((item) => item.id === member.id) ? current : [...current, member]
            ))}
            onChanged={refreshAfterChange}
            pendingAttempt={pendingAddAttempt}
            onPendingAttemptChange={setPendingAddAttempt}
          />
        ) : null}
      </React.Suspense>
    </div>
  );
}

function PersonRow({
  person,
  lang,
  currentUser,
  currentAccountId,
  locked,
  jobsByAccountId,
  phone,
  contactsReady,
  contactsUnavailable,
  pendingLifecycle,
  serverLifecyclePollingPaused,
  onOpen,
  onRemoveAccess,
}: {
  person: RosterPerson<HotelTeamMember, StaffMember>;
  lang: HotelTeamLang;
  currentUser: AppUser;
  currentAccountId: string;
  locked: boolean;
  jobsByAccountId: Record<string, CompanyJobLine[]>;
  phone: string | null;
  contactsReady: boolean;
  contactsUnavailable: boolean;
  pendingLifecycle: PendingLifecycleReconciliation | undefined;
  serverLifecyclePollingPaused: boolean;
  onOpen: () => void;
  onRemoveAccess: (member: HotelTeamMember) => void;
}) {
  const account = person.account;
  const staff = person.staff;
  const self = account?.accountId === currentAccountId;
  const lifecycleIsPending = Boolean(pendingLifecycle) || account?.lifecyclePending === true;
  const lifecyclePollingPaused = pendingLifecycle?.phase === 'paused'
    || (!pendingLifecycle && account?.lifecyclePending === true && serverLifecyclePollingPaused);
  const availableActions = account
    ? resolveActions(account, currentUser, currentAccountId, locked)
    : null;
  const canOpenAccountEditor = Boolean(availableActions && (
    availableActions.canEdit
    || availableActions.canChangeRole
    || availableActions.canResetPassword
    || availableActions.canDeactivate
    || availableActions.canReactivate
  ));
  const employmentEditable = canEditEmployment(account, currentUser, currentAccountId, locked);
  // Somebody with a login you may not touch and no schedule profile has nothing
  // behind the button — don't offer one.
  const canOpen = canOpenAccountEditor || Boolean(staff);
  const editable = canOpenAccountEditor || (Boolean(staff) && employmentEditable);
  const onShift = staff?.scheduledToday === true;
  const dimmed = staff?.isActive === false || (account ? !account.active : false);
  const jobLines = account ? jobsByAccountId[account.accountId] ?? [] : [];

  const identityLine = [
    account ? `@${account.username}` : null,
    account ? roleLabel(account.role, lang) : 'Schedule only, no login',
  ].filter(Boolean).join(' · ');

  const contactLine = staff
    ? (contactsUnavailable
        ? 'Phone unavailable'
        : !contactsReady
          ? 'Loading…'
          : phone
            ? formatPhone(phone)
            : 'No phone')
    : null;
  const emailLine = account
    ? account.email || 'Email unavailable'
    : null;

  return (
    <div
      className={`${styles.teamRow}${self ? ` ${styles.selfRow}` : ''}${dimmed ? ` ${styles.dimmedRow}` : ''}`}
      role="listitem"
    >
      <span
        className={`${styles.avatar}${onShift ? ` ${styles.avatarOnShift}` : ''}`}
        aria-hidden="true"
      >
        {initials(person.name)}
      </span>
      <div className={styles.rowBody}>
        <strong>
          {person.name}
          {self ? <small>{'You'}</small> : null}
          {staff?.isSenior ? (
            <small className={styles.seniorTag} title={'Senior'}>
              {'SENIOR'}
            </small>
          ) : null}
        </strong>
        <span>{identityLine}</span>
        {jobLines.length > 0 ? (
          <span className={styles.companyJobLines}>
            {jobLines.map((job) => (
              <em key={job.membershipId}>
                {`${job.label.en}, ${
                  job.scope === 'company'
                    ? 'every hotel'
                    : jobHotelsLabel(job, lang)
                }`}
              </em>
            ))}
          </span>
        ) : null}
        {contactLine ? <span>{contactLine}</span> : null}
        {emailLine ? <span>{emailLine}</span> : null}
        {account ? (
          <span className={styles.signInMetadata}>
            {lastSignInLabel(account.lastSignInKnown, account.lastSignInAt, lang)}
          </span>
        ) : null}
        {lifecycleIsPending ? (
          <em className={styles.pendingLifecycleMeta}>
            {lifecyclePollingPaused
              ? 'Verification paused. Reload to check the final status.'
              : 'Verifying the account status…'}
          </em>
        ) : null}
        {account?.ownerProtected ? (
          <em>{'Organization owner access is protected'}</em>
        ) : null}
        {availableActions?.roleIsSharedAcrossHotels ? (
          <em>{'Role shared across multiple hotels'}</em>
        ) : null}
      </div>

      {staff ? (
        <HoursMeter
          hours={staff.weeklyHours ?? 0}
          max={staff.maxWeeklyHours ?? 40}
          lang={lang}
        />
      ) : null}

      <div className={styles.rowBadges}>
        {account ? (
          <span
            className={`${styles.accountStatusBadge}${
              lifecycleIsPending
                ? ` ${styles.accountStatusPending}`
                : account.active ? '' : ` ${styles.accountStatusDisabled}`
            }`}
            role={lifecycleIsPending ? 'status' : undefined}
          >
            {lifecycleIsPending
              ? 'Status change pending'
              : account.active
                ? 'Login active'
                : 'Login disabled'}
          </span>
        ) : (
          <span className={styles.linkedBadge}>{'No login'}</span>
        )}
        {staff?.isActive === false ? (
          <span className={`${styles.accountStatusBadge} ${styles.accountStatusDisabled}`}>
            {'Off the roster'}
          </span>
        ) : null}
      </div>

      {canOpen || availableActions?.canRemove ? (
        <div className={styles.rowActions}>
          {canOpen ? (
            <button
              type="button"
              className={styles.editButton}
              onClick={onOpen}
              disabled={lifecycleIsPending}
              aria-label={editable
                ? `Edit ${person.name}`
                : `View ${person.name}`}
            >
              <Pencil size={15} aria-hidden="true" />
              <span>{editable ? 'Edit' : 'View'}</span>
            </button>
          ) : null}
          {account && availableActions?.canRemove ? (
            <button
              type="button"
              className={styles.removeButton}
              onClick={() => onRemoveAccess(account)}
              disabled={lifecycleIsPending}
              aria-label={`Remove ${person.name} from this hotel`}
            >
              <Trash2 size={15} aria-hidden="true" />
              <span className={styles.visuallyHidden}>{'Remove'}</span>
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
