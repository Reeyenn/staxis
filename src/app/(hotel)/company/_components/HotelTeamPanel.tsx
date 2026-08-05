'use client';

// ═══════════════════════════════════════════════════════════════════════════
// My Hotel → People. ONE list of everyone who works at this hotel.
//
// Before 2026-07-27 the same humans were listed twice: Staff → Directory
// showed the `staff` table (employment), My Hotel → People showed `accounts`
// (logins) and then, underneath, the `staff` rows that had no login. Nothing on
// screen explained why a housekeeper appeared in two places, or why her manager
// appeared in one. This panel merges both tables into a single roster keyed by
// person — the way a hotel manager needs to see their people — so one human is
// one row.
//
// What each half still contributes:
//   • employment (`staff`) — department, SENIOR tag, and dimming when inactive.
//   • login (`accounts`)   — role, disabled state, the
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
import type { StaffDepartment, StaffMember } from '@/types';
import type { FirstPersonOnboardingSnapshot } from '@/lib/first-person-onboarding-state';

import type { AddStaffAttempt } from './AddStaffDialog';
import { restoreDialogFocus } from './dialog-focus';
import {
  buildHotelRoster,
  type RosterGroupKey,
  type RosterPerson,
} from './people-roster';
import {
  deriveHotelTeamSetupState,
  hotelTeamSetupDialogTitle,
  hotelTeamSetupLabel,
  type HotelTeamSetupMode,
} from './hotel-team-setup';
import {
  usePeopleController,
  type PeopleControllerState,
} from './usePeopleController';
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
  /** Read-only identity hint from an inactive link at this exact hotel. It
   * never grants or preserves account authority. */
  historicalStaffId: string | null;
  /** Server-computed eligibility for a new staff link at this hotel. */
  staffLinkAllowed: boolean;
  /** Authoritative account-access surface returned by /api/auth/team. Company
   * access can make an organization member visible here without creating the
   * hotel's direct first-person/setup account. */
  managementSurface: 'legacy_hotel' | 'company_access';
  /** Canonical direct-account standing for this exact selected hotel. This is
   * intentionally separate from managementSurface because normalized direct
   * accounts are projected as company_access. */
  directHotelAccount?: boolean | null;
  hotelLeadershipRole?: 'owner' | 'general_manager' | null;
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
  /** A page-owned heading ref that survives the keyed permission panel remount. */
  peopleHeadingRef?: React.RefObject<HTMLHeadingElement | null>;
  inviteDialogOpen: boolean;
  onInviteDialogOpenChange: (open: boolean) => void;
  /** The employment roster for this hotel, from PropertyContext. */
  staffProfiles?: StaffMember[];
  /** The roster subscription failed — say so instead of implying nobody works
   *  here. */
  rosterUnavailable?: boolean;
  /** The employment roster has finished loading (success or failure). */
  rosterSettled?: boolean;
  /** May this viewer add somebody to the schedule? */
  canAddStaff?: boolean;
  /** The page-owned People controller. Standalone panel consumers may omit it;
   * in that case the panel uses the same account projection hook without
   * opening a second staff subscription. */
  peopleController?: PeopleControllerState;
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

const LazyPeopleInviteChooserDialog = React.lazy(async () => {
  const dialogs = await import('./HotelTeamDialogs');
  return { default: dialogs.PeopleInviteChooserDialog };
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
export interface CompanyJobLine {
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

function personJobLabel(
  person: RosterPerson<HotelTeamMember, StaffMember>,
  lang: HotelTeamLang,
): string {
  if (person.staff) return departmentLabel(person.staff.department ?? 'housekeeping', lang);
  if (person.account) return roleLabel(person.account.role, lang);
  return groupLabel(person.group, lang);
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  return `${parts[0]?.[0] ?? ''}${parts.length > 1 ? parts.at(-1)?.[0] ?? '' : ''}`.toUpperCase();
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
  // Cross-hotel authority is projected by GET /api/auth/team. Do not infer it
  // from the legacy account.propertyAccess arrays: those fields are display
  // data and may be stale or incomplete for company-scope access.
  const roleIsSharedAcrossHotels = Boolean(member.hasOtherHotelAccess);

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
    && hierarchyAllows;
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

function floorOffRosterActions(
  actions: ResolvedActions,
  offRoster: boolean,
): ResolvedActions {
  if (!offRoster) return actions;
  return {
    ...actions,
    canEdit: false,
    canChangeRole: false,
    canResetPassword: false,
    canDeactivate: false,
    canReactivate: false,
    canRemove: false,
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

type DialogLoadingVariant = 'invite' | 'first-person-invite' | 'invite-choice' | 'add-staff' | 'member' | 'remove' | 'decision';
type InviteLoadingSection = 'hotel' | 'email';
// Loading must fail closed when a caller has not projected its exact sections.
const DEFAULT_INVITE_LOADING_SECTIONS: readonly InviteLoadingSection[] = ['email'];

function DialogLoading({
  lang,
  hotelName,
  variant,
  onClose,
  returnFocusRef,
  fallbackFocusRef,
  choiceCount = 2,
  inviteSections = DEFAULT_INVITE_LOADING_SECTIONS,
  setupMode = 'first-person',
}: {
  lang: HotelTeamLang;
  hotelName: string;
  variant: DialogLoadingVariant;
  onClose: () => void;
  returnFocusRef?: React.RefObject<HTMLElement | null>;
  fallbackFocusRef?: React.RefObject<HTMLElement | null>;
  choiceCount?: number;
  inviteSections?: readonly InviteLoadingSection[];
  setupMode?: HotelTeamSetupMode;
}) {
  const closeRef = React.useRef<HTMLButtonElement | null>(null);
  const dialogRef = React.useRef<HTMLDivElement | null>(null);
  const onCloseRef = React.useRef(onClose);
  onCloseRef.current = onClose;
  const titleId = React.useId();
  const title = variant === 'invite' || variant === 'invite-choice'
    ? 'Invite people'
    : variant === 'first-person-invite'
      ? hotelTeamSetupDialogTitle(setupMode)
      : variant === 'add-staff'
        ? 'Add staff member'
        : variant === 'member'
          ? 'Person details'
          : variant === 'remove'
            ? 'Remove hotel access'
            : 'Review join request';
  const loadingLabel = `Opening ${title} dialog…`;
  const shellClass = variant === 'invite'
    ? `${styles.dialogWide} ${styles.dialogLoadingInvite}`
    : variant === 'first-person-invite'
      ? styles.dialogLoadingAddStaff
    : variant === 'invite-choice'
      ? styles.dialogLoadingInviteChoice
    : variant === 'add-staff'
      ? styles.dialogLoadingAddStaff
    : variant === 'member'
      ? styles.dialogLoadingMember
      : styles.dialogLoadingConfirmation;
  const visibleInviteSections = inviteSections.length > 0 ? inviteSections : ['email' as const];

  React.useEffect(() => {
    const previousFocusElement = document.activeElement instanceof HTMLElement
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
      restoreDialogFocus(returnFocusRef, fallbackFocusRef, previousFocusElement);
    };
  }, [fallbackFocusRef, returnFocusRef]);

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

        {variant === 'invite' ? null : (
          <div className={styles.dialogLoadingIntro} aria-hidden="true">
            <span />
          </div>
        )}

        <div className={styles.dialogLoadingBody} role="status" aria-live="polite">
          <span className={styles.visuallyHidden}>{loadingLabel}</span>
          {variant === 'invite' ? (
            visibleInviteSections.map((section, index) => section === 'hotel' ? (
              <DialogLoadingSection key={`${section}-${index}`} rows={4} tall />
            ) : (
              <DialogLoadingFields key={`${section}-${index}`} rows={4} />
            ))
          ) : variant === 'invite-choice' ? (
            <DialogLoadingChoices count={choiceCount} />
          ) : variant === 'first-person-invite' || variant === 'add-staff' ? (
            <DialogLoadingFields rows={4} />
          ) : variant === 'member' ? (
            <DialogLoadingFields rows={5} />
          ) : (
            <DialogLoadingFields rows={2} compact />
          )}
        </div>

        {variant === 'invite' ? null : (
          <div className={styles.dialogFooter} aria-hidden="true">
            <span className={styles.dialogLoadingButton} />
          </div>
        )}
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

function DialogLoadingChoices({ count }: { count: number }) {
  return (
    <div className={styles.dialogLoadingChoices} aria-hidden="true">
      {Array.from({ length: Math.max(1, count) }, (_, index) => (
        <span key={index} className={styles.dialogLoadingChoice}>
          <span className={styles.dialogLoadingChoiceIcon} />
          <span className={styles.dialogLoadingChoiceCopy}>
            <span className={styles.dialogLoadingChoiceBadge} />
            <span className={styles.dialogLoadingChoiceTitle} />
            <span className={styles.dialogLoadingChoiceDescription} />
          </span>
          <span className={styles.dialogLoadingChoiceChevron} />
        </span>
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
  canInviteAccounts = false,
  canViewWages = false,
  readOnly = false,
  adminPreview = false,
  peopleHeadingRef: providedPeopleHeadingRef,
  inviteDialogOpen,
  onInviteDialogOpenChange,
  staffProfiles = [],
  rosterUnavailable = false,
  rosterSettled = true,
  canAddStaff = false,
  peopleController,
  onChanged,
}: HotelTeamPanelProps) {
  // Which setup dialog the manager opened. Local UI state — the controller owns
  // the fetched onboarding status, this only remembers the opened mode so the
  // result dialog survives the refresh that follows a successful invite.
  const [firstPersonInviteSnapshot, setFirstPersonInviteSnapshot] = React.useState<{
    hotelId: string;
    mode: HotelTeamSetupMode;
  } | null>(null);
  const [requests, setRequests] = React.useState<HotelJoinRequest[]>([]);
  const [requestsLoading, setRequestsLoading] = React.useState(false);
  const [requestsError, setRequestsError] = React.useState('');
  const [editKey, setEditKey] = React.useState<string | null>(null);
  const [removeMember, setRemoveMember] = React.useState<HotelTeamMember | null>(null);
  const [addDepartment, setAddDepartment] = React.useState<StaffDepartment | null>(null);
  const [inviteChoiceOpen, setInviteChoiceOpen] = React.useState(false);
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
  const requestAbortRef = React.useRef<AbortController | null>(null);
  const requestSequenceRef = React.useRef(0);
  const inviteEntryRef = React.useRef<HTMLButtonElement | null>(null);
  const inviteEntryReturnFocusRef = React.useRef<HTMLElement | null>(null);
  const addStaffReturnFocusRef = React.useRef<HTMLElement | null>(null);
  const localPeopleHeadingRef = React.useRef<HTMLHeadingElement | null>(null);
  const peopleHeadingRef = providedPeopleHeadingRef ?? localPeopleHeadingRef;
  const changedRef = React.useRef(onChanged);
  changedRef.current = onChanged;

  // The page passes the controller that joins the canonical account
  // projection with PropertyContext's viewer-stamped staff snapshot. The
  // fallback exists for direct/standalone panel consumers and still owns only
  // the account request — never a second staff subscription.
  const fallbackPeopleViewerKey = `${currentUser.uid}:${currentAccountId}:${hotelId}:standalone`;
  const fallbackPeopleController = usePeopleController({
    hotelId,
    viewerKey: fallbackPeopleViewerKey,
    enabled: !peopleController && canManageTeam,
    adminPreview,
    readOnly,
    staff: staffProfiles,
    staffViewerKey: fallbackPeopleViewerKey,
    staffExpectedViewerKey: fallbackPeopleViewerKey,
    staffLoaded: !rosterUnavailable,
    staffLoadFailed: rosterUnavailable,
    refreshStaff: async () => {},
  });
  const peopleState = peopleController ?? fallbackPeopleController;
  const {
    team,
    jobsByAccountId,
    teamLoading,
    teamError,
    teamSnapshotCurrent,
    firstPersonOnboarding,
    staff: controllerStaff,
    rosterUnavailable: controllerRosterUnavailable,
    refreshTeam,
  } = peopleState;
  const rosterUnavailableForPeople = peopleController
    ? controllerRosterUnavailable
    : rosterUnavailable || controllerRosterUnavailable;
  const rosterStaffProfiles = peopleController ? controllerStaff : staffProfiles;
  // The controller keys its snapshot by hotel + viewer, so `team` and
  // `jobsByAccountId` are already exact for this hotel. These aliases keep the
  // hotel-setup gating below reading the same way it did when the panel owned
  // the fetch itself.
  const teamForHotel = team;
  const jobsForHotel = jobsByAccountId;
  const removeMemberForHotel = teamSnapshotCurrent ? removeMember : null;
  const decisionForHotel = teamSnapshotCurrent ? decision : null;
  const teamLoadingForHotel = Boolean(hotelId) && (!teamSnapshotCurrent || teamLoading);
  const teamErrorForHotel = teamSnapshotCurrent ? teamError : '';

  const locked = readOnly;
  const inviteActionDisabled = locked
    || (canManageTeam && !teamSnapshotCurrent)
    || (adminPreview && (teamLoadingForHotel || Boolean(teamErrorForHotel)));
  // A hotel manager can use the shared link, QR, and code invite even when the
  // account-invite capability is not granted. Keep this derived from the same
  // guarded surfaces as the existing Invite dialog instead of widening access.
  const canInviteToStaxis = canManageTeam || canInviteAccounts;
  const inviteEntryAvailable = canAddStaff || canInviteToStaxis;
  const inviteCapabilityKey = [
    canAddStaff ? 'schedule' : 'no-schedule',
    canManageTeam ? 'hotel-manager' : 'invite-only',
    canInviteAccounts ? 'account-invite' : 'no-account-invite',
    locked ? 'read-only' : 'interactive',
    adminPreview ? 'admin-preview' : 'customer',
  ].join(':');
  const inviteCapabilityRef = React.useRef(inviteCapabilityKey);
  const [, setInviteCapabilityRevision] = React.useState(0);
  const inviteCapabilitiesStable = inviteCapabilityRef.current === inviteCapabilityKey;
  const inviteDialogVisible = inviteDialogOpen && inviteCapabilitiesStable && !inviteActionDisabled;
  const firstPersonDialogModeSnapshot = firstPersonInviteSnapshot?.hotelId === hotelId
    ? firstPersonInviteSnapshot.mode
    : null;
  const inviteChoiceVisible = inviteChoiceOpen && inviteCapabilitiesStable && !inviteActionDisabled;
  const addDepartmentVisible = inviteCapabilitiesStable && !inviteActionDisabled
    ? addDepartment
    : null;

  const openPeopleInviteChooser = React.useCallback(() => {
    if (inviteActionDisabled || !inviteCapabilitiesStable || !inviteEntryAvailable) return;
    inviteEntryReturnFocusRef.current = inviteEntryRef.current;
    setInviteChoiceOpen(true);
  }, [inviteActionDisabled, inviteCapabilitiesStable, inviteEntryAvailable]);

  const chooseAddStaff = React.useCallback(() => {
    if (!canAddStaff || locked || inviteActionDisabled || !inviteCapabilitiesStable) return;
    addStaffReturnFocusRef.current = inviteEntryReturnFocusRef.current;
    setInviteChoiceOpen(false);
    setAddDepartment('housekeeping');
  }, [canAddStaff, inviteActionDisabled, inviteCapabilitiesStable, locked]);

  const chooseInviteToStaxis = React.useCallback(() => {
    if (!canInviteToStaxis || inviteActionDisabled || !inviteCapabilitiesStable) return;
    setInviteChoiceOpen(false);
    onInviteDialogOpenChange(true);
  }, [canInviteToStaxis, inviteActionDisabled, inviteCapabilitiesStable, onInviteDialogOpenChange]);

  React.useEffect(() => {
    if (inviteCapabilityRef.current === inviteCapabilityKey) return;
    inviteCapabilityRef.current = inviteCapabilityKey;
    setInviteCapabilityRevision((current) => current + 1);
    setInviteChoiceOpen(false);
    setAddDepartment(null);
    setPendingAddAttempt(null);
    if (inviteDialogOpen) {
      setFirstPersonInviteSnapshot(null);
      onInviteDialogOpenChange(false);
    }
  }, [inviteCapabilityKey, inviteDialogOpen, onInviteDialogOpenChange]);

  // A definitive fresh authorization refresh can revoke hotel-operational
  // standing while this tab is open. Drop every private roster projection as
  // soon as that happens. The parent also changes this component's key across
  // the hotel-authorized/invite-only boundary, so a later re-grant cannot paint
  // an old team's data for even one render while the fresh fetch is pending.
  React.useEffect(() => {
    if (canManageTeam) return;
    requestAbortRef.current?.abort();
    setFirstPersonInviteSnapshot(null);
    setRequests([]);
    setContactSnapshot(null);
    setWageSnapshot(null);
    setOptimisticStaff([]);
    setPendingLifecycleByAccount({});
    setEditKey(null);
    setRemoveMember(null);
    setAddDepartment(null);
    setInviteChoiceOpen(false);
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
    const loadedIds = new Set(rosterStaffProfiles.map((member) => member.id));
    setOptimisticStaff((current) => {
      const pending = current.filter((member) => !loadedIds.has(member.id));
      return pending.length === current.length ? current : pending;
    });
  }, [rosterStaffProfiles]);

  const hasServerLifecyclePending = teamForHotel.some((member) => member.lifecyclePending === true);

  React.useEffect(() => {
    setServerLifecyclePollingPaused(false);
    if (!hasServerLifecyclePending) return;
    const controller = new AbortController();

    void (async () => {
      for (const delayMs of LIFECYCLE_SERVER_REFRESH_DELAYS_MS) {
        const shouldContinue = await waitForLifecycleReconciliation(delayMs, controller.signal);
        if (!shouldContinue) return;
        await refreshTeam();
        if (controller.signal.aborted) return;
      }
      setServerLifecyclePollingPaused(true);
    })();

    return () => controller.abort();
  }, [hasServerLifecyclePending, hotelId, refreshTeam]);

  const refreshAfterChange = React.useCallback(async () => {
    await Promise.all([refreshTeam(), loadRequests(), loadContacts(), loadWages()]);
    await changedRef.current?.();
  }, [loadContacts, loadRequests, loadWages, refreshTeam]);

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
    const loadedIds = new Set(rosterStaffProfiles.map((member) => member.id));
    return [
      ...rosterStaffProfiles,
      ...optimisticStaff.filter((member) => !loadedIds.has(member.id)),
    ];
  }, [optimisticStaff, rosterStaffProfiles]);

  const unlinkedRosterProfiles = React.useMemo<HotelInviteRosterProfile[]>(() => {
    // Do not offer a possibly stale profile while either half of the merged
    // roster is unavailable. The POST rechecks the chosen id server-side too.
    if (teamLoadingForHotel || teamErrorForHotel || rosterUnavailableForPeople || !rosterSettled) return [];
    const linkedStaffIds = new Set(
      teamForHotel.flatMap((member) => member.staffId ? [member.staffId] : []),
    );
    return rosterStaff
      .filter((member) => member.isActive !== false && !linkedStaffIds.has(member.id))
      .map((member) => ({
        id: member.id,
        name: member.name,
        department: member.department ?? 'housekeeping',
      }))
      .sort((left, right) => left.name.localeCompare(right.name));
  }, [rosterSettled, rosterStaff, rosterUnavailableForPeople, teamErrorForHotel, teamForHotel, teamLoadingForHotel]);

  const groups = React.useMemo(
    () => buildHotelRoster(teamForHotel, rosterStaff),
    [rosterStaff, teamForHotel],
  );
  const people = React.useMemo(
    () => groups.flatMap((group) => group.people),
    [groups],
  );
  const peopleCount = people.length;
  const setupState = deriveHotelTeamSetupState({
    adminPreview,
    teamLoading: teamLoadingForHotel,
    teamError: Boolean(teamErrorForHotel),
    peopleCount,
    team: teamForHotel,
    rosterUnavailable: !rosterSettled || rosterUnavailableForPeople || firstPersonOnboarding === null,
    approvalSettled: !requestsLoading && !requestsError && requests.length === 0,
    onboardingStatus: firstPersonOnboarding?.status,
  });
  const { needsHotelOwnerOrGm } = setupState;
  const setupMode = setupState.setupMode;
  const firstPersonPending = firstPersonOnboarding?.status === 'pending';
  const pendingSetupMode: HotelTeamSetupMode = peopleCount > 0
    ? 'hotel-owner-or-gm'
    : 'first-person';
  // Keep the successful first-person result mounted while the refreshed team
  // snapshot moves setupMode to null/pending. Otherwise React would replace
  // the result dialog with the ordinary Invite dialog before the user can
  // copy the active signup link or close it.
  const firstPersonDialogMode = setupMode ?? firstPersonDialogModeSnapshot;
  const firstPersonDialogVisible = inviteDialogOpen
    && inviteCapabilitiesStable
    && !locked
    && firstPersonDialogMode !== null;
  const rosterIndeterminate = !rosterSettled || rosterUnavailableForPeople;
  const approvalIndeterminate = requestsLoading || Boolean(requestsError) || requests.length > 0;
  const linkAccounts = React.useMemo(
    () => teamForHotel.map((member) => ({
      accountId: member.accountId,
      displayName: member.displayName,
      username: member.username,
      role: member.role,
      staffId: member.staffId,
      historicalStaffId: member.historicalStaffId,
      propertyAccess: member.propertyAccess,
      managementSurface: member.managementSurface,
      staffLinkAllowed: member.staffLinkAllowed,
      lifecyclePending: member.lifecyclePending === true,
    })),
    [teamForHotel],
  );
  const editPerson = React.useMemo(
    () => people.find((person) => person.key === editKey) ?? null,
    [editKey, people],
  );

  const loadingDialogVariant: DialogLoadingVariant = editPerson
    ? 'member'
    : removeMemberForHotel
      ? 'remove'
      : firstPersonDialogVisible
        ? 'first-person-invite'
        : inviteDialogVisible
          ? 'invite'
        : inviteChoiceVisible
          ? 'invite-choice'
          : addDepartmentVisible
            ? 'add-staff'
          : 'decision';
  const closeLoadingDialog = React.useCallback(() => {
    if (editKey) {
      setEditKey(null);
      return;
    }
    if (removeMemberForHotel) {
      setRemoveMember(null);
      return;
    }
    if (inviteDialogOpen) {
      setFirstPersonInviteSnapshot(null);
      onInviteDialogOpenChange(false);
      return;
    }
    if (inviteChoiceOpen) {
      setInviteChoiceOpen(false);
      return;
    }
    if (addDepartment) {
      setAddDepartment(null);
      return;
    }
    setDecision(null);
  }, [addDepartment, editKey, inviteChoiceOpen, inviteDialogOpen, onInviteDialogOpenChange, removeMemberForHotel]);

  const loadingReturnFocusRef = loadingDialogVariant === 'invite-choice'
    ? inviteEntryReturnFocusRef
    : loadingDialogVariant === 'invite'
      ? inviteEntryReturnFocusRef
      : loadingDialogVariant === 'first-person-invite'
        ? undefined
      : loadingDialogVariant === 'add-staff'
        ? addStaffReturnFocusRef
        : undefined;
  const normalLoadingReturnFocusRef = firstPersonDialogVisible && loadingDialogVariant === 'first-person-invite'
    ? undefined
    : loadingReturnFocusRef;

  const handleFirstPersonInvited = React.useCallback(() => {
    if (!firstPersonDialogMode) return;
    setFirstPersonInviteSnapshot({ hotelId, mode: firstPersonDialogMode });
  }, [firstPersonDialogMode, hotelId]);

  const openFirstPersonDialog = React.useCallback(() => {
    if (!setupMode || inviteActionDisabled || locked) return;
    setFirstPersonInviteSnapshot({ hotelId, mode: setupMode });
    onInviteDialogOpenChange(true);
  }, [hotelId, inviteActionDisabled, locked, onInviteDialogOpenChange, setupMode]);

  const closeFirstPersonDialog = React.useCallback(() => {
    setFirstPersonInviteSnapshot(null);
    onInviteDialogOpenChange(false);
  }, [onInviteDialogOpenChange]);

  React.useEffect(() => {
    if (!firstPersonInviteSnapshot || firstPersonInviteSnapshot.hotelId !== hotelId) return;
    const onboarding = firstPersonOnboarding;
    if (onboarding?.status !== 'created'
      && !(onboarding?.status === 'none' && onboarding.invitedEmail)) return;
    setFirstPersonInviteSnapshot(null);
    if (inviteDialogOpen) onInviteDialogOpenChange(false);
  }, [firstPersonInviteSnapshot, firstPersonOnboarding, hotelId, inviteDialogOpen, onInviteDialogOpenChange]);

  React.useEffect(() => {
    if (!inviteActionDisabled) return;
    const keepFirstPersonDialog = inviteDialogOpen && firstPersonDialogMode !== null;
    if (keepFirstPersonDialog) return;
    setInviteChoiceOpen(false);
    setAddDepartment(null);
    if (inviteDialogOpen) onInviteDialogOpenChange(false);
  }, [firstPersonDialogMode, inviteActionDisabled, inviteDialogOpen, onInviteDialogOpenChange]);

  React.useEffect(() => {
    if (!firstPersonPending || !canManageTeam || !teamSnapshotCurrent) return;
    const interval = window.setInterval(() => {
      void refreshTeam();
    }, 5_000);
    return () => window.clearInterval(interval);
  }, [canManageTeam, firstPersonPending, refreshTeam, teamSnapshotCurrent]);

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
              <h3 ref={peopleHeadingRef} id="hotel-team-title" tabIndex={-1}>{'Hotel account settings are private'}</h3>
              <p>{'Only an explicitly authorized hotel manager can view or change this private roster.'}</p>
            </div>
          </div>
          {canInviteAccounts && !locked ? (
            <div className={styles.peopleActions} aria-label="Ways to add people">
              <button
                ref={inviteEntryRef}
                type="button"
                className={`${styles.peopleAction} ${styles.peopleActionPrimary}`}
                onClick={openPeopleInviteChooser}
                disabled={inviteActionDisabled || !inviteCapabilitiesStable}
                aria-haspopup="dialog"
              >
                <span className={styles.peopleActionIcon} aria-hidden="true">
                  <UserPlus size={19} />
                </span>
                <span className={styles.peopleActionCopy}>
                  <strong>{'Invite people'}</strong>
                  <small>{'Send an email invite so they can create a Staxis account.'}</small>
                </span>
              </button>
            </div>
          ) : null}
        </section>
        <React.Suspense fallback={(
          <DialogLoading
            lang={lang}
            hotelName={hotelName}
            variant={loadingDialogVariant}
            choiceCount={1}
            inviteSections={['email']}
            returnFocusRef={loadingReturnFocusRef}
            fallbackFocusRef={peopleHeadingRef}
            setupMode={setupMode ?? 'first-person'}
            onClose={closeLoadingDialog}
          />
        )}>
          {inviteChoiceVisible && canInviteAccounts && !locked ? (
            <LazyPeopleInviteChooserDialog
              canAddStaff={false}
              canInviteToStaxis={inviteCapabilitiesStable}
              canSendEmailInvite={canInviteAccounts && inviteCapabilitiesStable}
              canShareHotelInvite={false}
              returnFocusRef={inviteEntryReturnFocusRef}
              fallbackFocusRef={peopleHeadingRef}
              onAddStaff={chooseAddStaff}
              onInviteToStaxis={chooseInviteToStaxis}
              onClose={() => setInviteChoiceOpen(false)}
            />
          ) : null}
          {inviteDialogVisible && canInviteAccounts && !locked ? (
            <LazyInviteDialog
              hotelId={hotelId}
              hotelName={hotelName}
              lang={lang}
              canInviteManager
              canManageHotelRoster={false}
              returnFocusRef={inviteEntryReturnFocusRef}
              fallbackFocusRef={peopleHeadingRef}
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
    ? floorOffRosterActions(
        resolveActions(
          editAccount,
          currentUser,
          currentAccountId,
          locked
            || Boolean(pendingLifecycleByAccount[editAccount.accountId])
            || editAccount.lifecyclePending === true,
        ),
        editPerson?.staff?.isActive === false,
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
      canEdit={editPerson.staff?.isActive !== false
        && canEditEmployment(editPerson.account, currentUser, currentAccountId, locked)}
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
              <h2 ref={peopleHeadingRef} id="team-members-title" tabIndex={-1}>{'Everyone at this hotel'}</h2>
              {!teamLoadingForHotel && !teamErrorForHotel ? (
                <strong aria-label={`${peopleCount} people at this hotel`}>
                  {peopleCount}
                </strong>
              ) : null}
            </div>
          </div>
          {setupMode ? (
            <button
              type="button"
              className={`${styles.primaryButton} ${styles.headingInviteButton}`}
              onClick={openFirstPersonDialog}
              disabled={inviteActionDisabled}
              aria-haspopup="dialog"
            >
              <UserPlus size={16} aria-hidden="true" />
              {hotelTeamSetupLabel(setupMode)}
            </button>
          ) : null}
        </div>

        {needsHotelOwnerOrGm ? (
          <div className={styles.infoNotice} role="status">
            <ShieldCheck size={17} aria-hidden="true" />
            <span>{'People are already listed at this hotel. Add a hotel Owner or General Manager to complete hotel setup.'}</span>
          </div>
        ) : null}

        {firstPersonPending ? (
          <div className={styles.warningNotice} role="status">
            <Clock3 size={17} aria-hidden="true" />
            <span>
              {pendingSetupMode === 'hotel-owner-or-gm'
                ? 'Hotel Owner or GM invitation pending'
                : 'First-person invitation pending'}
              {firstPersonOnboarding?.invitedEmail ? ` for ${firstPersonOnboarding.invitedEmail}.` : '.'}
              {' Wait for signup before sending another invitation.'}
            </span>
          </div>
        ) : null}

        {!setupMode && !locked && inviteCapabilitiesStable && inviteEntryAvailable ? (
          <div className={styles.peopleActions} aria-label="Ways to add people">
            <button
              ref={inviteEntryRef}
              type="button"
              className={`${styles.peopleAction} ${styles.peopleActionPrimary}`}
              onClick={openPeopleInviteChooser}
              disabled={inviteActionDisabled || !inviteCapabilitiesStable}
              aria-haspopup="dialog"
            >
              <span className={styles.peopleActionIcon} aria-hidden="true">
                <UserPlus size={19} />
              </span>
              <span className={styles.peopleActionCopy}>
                <strong>{'Invite people'}</strong>
                <small>{'Add someone to the schedule, or invite them to create a Staxis account.'}</small>
              </span>
            </button>
          </div>
        ) : null}

        {rosterUnavailableForPeople ? (
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

        {teamLoadingForHotel ? (
          <div className={styles.skeletonList} role="status" aria-label={'Loading the hotel roster'}>
            {[0, 1, 2].map((item) => <span key={item} />)}
          </div>
        ) : teamErrorForHotel ? (
          <div className={styles.errorState} role="alert">
            <AlertCircle size={18} aria-hidden="true" />
            <div><strong>{'The hotel roster did not load'}</strong><span>{teamErrorForHotel}</span></div>
            <button type="button" onClick={() => void refreshTeam()}>
              <RefreshCw size={15} aria-hidden="true" />{'Retry'}
            </button>
          </div>
        ) : rosterIndeterminate && peopleCount === 0 ? (
          rosterUnavailable ? (
            <div className={styles.errorState} role="status">
              <AlertTriangle size={18} aria-hidden="true" />
              <div>
                <strong>{'People state unavailable'}</strong>
                <span>{'The schedule roster is unavailable, so this hotel may have people who are not shown. Retry before using an empty-state action.'}</span>
              </div>
              <button type="button" onClick={() => void changedRef.current?.()}>
                <RefreshCw size={15} aria-hidden="true" />{'Retry'}
              </button>
            </div>
          ) : (
            <div className={styles.emptyState} role="status">
              <span><RefreshCw size={22} aria-hidden="true" /></span>
              <h3>{'Checking the hotel roster'}</h3>
              <p>{'People state will appear after the schedule roster finishes loading.'}</p>
            </div>
          )
        ) : !rosterIndeterminate && peopleCount === 0 && requestsLoading ? (
          <div className={styles.emptyState} role="status">
            <span><RefreshCw size={22} aria-hidden="true" /></span>
            <h3>{'Checking pending approvals'}</h3>
            <p>{'The hotel empty state will appear after pending approvals finish loading.'}</p>
          </div>
        ) : !rosterIndeterminate && peopleCount === 0 && requestsError ? (
          <div className={styles.errorState} role="status">
            <AlertCircle size={18} aria-hidden="true" />
            <div>
              <strong>{'People state unavailable'}</strong>
              <span>{'Pending approvals could not be checked, so the hotel cannot be confirmed empty.'}</span>
            </div>
            <button type="button" onClick={() => void loadRequests()}>
              <RefreshCw size={15} aria-hidden="true" />{'Retry'}
            </button>
          </div>
        ) : !rosterIndeterminate && peopleCount === 0 && requests.length > 0 ? (
          <div className={styles.emptyState}>
            <span><Users size={22} aria-hidden="true" /></span>
            <h3>{'No approved people yet'}</h3>
            <p>{'Pending join requests are waiting for approval. Review them above before adding anyone else.'}</p>
          </div>
        ) : !rosterIndeterminate && peopleCount === 0 && firstPersonPending ? (
          <div className={styles.emptyState}>
            <span><Clock3 size={22} aria-hidden="true" /></span>
            <h3>{pendingSetupMode === 'hotel-owner-or-gm'
              ? 'Hotel Owner or GM invitation pending'
              : 'First-person invitation pending'}</h3>
            <p>{firstPersonOnboarding?.invitedEmail
              ? (pendingSetupMode === 'hotel-owner-or-gm'
                ? 'The hotel Owner or GM invitation sent to ' + firstPersonOnboarding.invitedEmail + ' is waiting for signup.'
                : 'The invitation sent to ' + firstPersonOnboarding.invitedEmail + ' is waiting for signup.')
              : pendingSetupMode === 'hotel-owner-or-gm'
                ? 'The hotel Owner or GM invitation is waiting for signup.'
                : 'The invitation is waiting for signup.'}</p>
          </div>
        ) : peopleCount === 0 ? (
          <div className={styles.emptyState}>
            <span><Users size={22} aria-hidden="true" /></span>
            <h3>{hotelTeamSetupLabel(setupMode) ?? 'Nobody here yet'}</h3>
            <p>{setupMode === 'first-person'
              ? 'Invite this hotel’s first Owner or General Manager. Their assigned role is locked into signup.'
              : setupMode === 'hotel-owner-or-gm'
                ? 'Add a hotel Owner or General Manager to complete hotel setup.'
                : 'Use Add staff member for someone who only needs the roster and schedule. Use Invite people when they need Staxis login access.'}</p>
            {!locked && setupMode ? (
              <div className={styles.emptyStateActions}>
                <button
                  type="button"
                  className={styles.primaryButton}
                  onClick={openFirstPersonDialog}
                >
                  <UserPlus size={16} aria-hidden="true" />
                  {hotelTeamSetupLabel(setupMode)}
                </button>
              </div>
            ) : null}
          </div>
        ) : (
          <div className={styles.rosterList} role="list" aria-label={'People at this hotel'}>
            {people.map((person) => (
              <PersonRow
                key={person.key}
                person={person}
                lang={lang}
                currentUser={currentUser}
                currentAccountId={currentAccountId}
                locked={locked}
                jobsByAccountId={jobsByAccountId}
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
      </section>

      <React.Suspense fallback={(
        <DialogLoading
          lang={lang}
          hotelName={hotelName}
          variant={loadingDialogVariant}
          choiceCount={Number(canAddStaff && !locked) + Number(canInviteToStaxis)}
          inviteSections={canInviteAccounts ? ['hotel', 'email'] : ['hotel']}
          returnFocusRef={normalLoadingReturnFocusRef}
          fallbackFocusRef={peopleHeadingRef}
          setupMode={firstPersonDialogMode ?? 'first-person'}
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
            readOnly={editPerson.staff?.isActive === false}
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
        {removeMemberForHotel ? (
          <LazyRemoveDialog
            hotelId={hotelId}
            hotelName={hotelName}
            member={removeMemberForHotel}
            lang={lang}
            onClose={() => setRemoveMember(null)}
            onRemoved={async () => {
              setRemoveMember(null);
              await refreshAfterChange();
            }}
          />
        ) : null}
        {inviteChoiceVisible ? (
          <LazyPeopleInviteChooserDialog
            canAddStaff={canAddStaff && !locked && inviteCapabilitiesStable}
            canInviteToStaxis={canInviteToStaxis && inviteCapabilitiesStable}
            canSendEmailInvite={canInviteAccounts && inviteCapabilitiesStable}
            canShareHotelInvite={canManageTeam && inviteCapabilitiesStable}
            returnFocusRef={inviteEntryReturnFocusRef}
            fallbackFocusRef={peopleHeadingRef}
            onAddStaff={chooseAddStaff}
            onInviteToStaxis={chooseInviteToStaxis}
            onClose={() => setInviteChoiceOpen(false)}
          />
        ) : null}
        {firstPersonDialogVisible ? (
          <LazyFirstPersonInviteDialog
            hotelId={hotelId}
            hotelName={hotelName}
            setupMode={firstPersonDialogMode}
            fallbackFocusRef={peopleHeadingRef}
            onClose={closeFirstPersonDialog}
            onInvited={handleFirstPersonInvited}
            onChanged={refreshAfterChange}
          />
        ) : inviteDialogVisible ? (
          <LazyInviteDialog
            hotelId={hotelId}
            hotelName={hotelName}
            lang={lang}
            canInviteManager={canInviteAccounts}
            canManageHotelRoster
            unlinkedRosterProfiles={unlinkedRosterProfiles}
            returnFocusRef={inviteEntryReturnFocusRef}
            fallbackFocusRef={peopleHeadingRef}
            onClose={() => onInviteDialogOpenChange(false)}
            onChanged={refreshAfterChange}
          />
        ) : null}
        {decisionForHotel ? (
          <LazyDecisionDialog
            hotelId={hotelId}
            hotelName={hotelName}
            request={decisionForHotel.request}
            decision={decisionForHotel.decision}
            lang={lang}
            onClose={() => setDecision(null)}
            onCompleted={async () => {
              setDecision(null);
              await refreshAfterChange();
            }}
          />
        ) : null}
        {addDepartmentVisible ? (
          <LazyAddStaffDialog
            hotelId={hotelId}
            hotelName={hotelName}
            lang={lang}
            initialDepartment={addDepartmentVisible}
            returnFocusRef={addStaffReturnFocusRef}
            fallbackFocusRef={peopleHeadingRef}
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

export interface PersonRowProps {
  person: RosterPerson<HotelTeamMember, StaffMember>;
  lang: HotelTeamLang;
  currentUser: AppUser;
  currentAccountId: string;
  locked: boolean;
  jobsByAccountId: Record<string, CompanyJobLine[]>;
  pendingLifecycle: PendingLifecycleReconciliation | undefined;
  serverLifecyclePollingPaused: boolean;
  onOpen: () => void;
  onRemoveAccess: (member: HotelTeamMember) => void;
}

export function PersonRow({
  person,
  lang,
  currentUser,
  currentAccountId,
  locked,
  jobsByAccountId,
  pendingLifecycle,
  serverLifecyclePollingPaused,
  onOpen,
  onRemoveAccess,
}: PersonRowProps) {
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
  const offRoster = staff?.isActive === false;
  const employmentEditable = !offRoster
    && canEditEmployment(account, currentUser, currentAccountId, locked);
  // Somebody with a login you may not touch and no schedule profile has nothing
  // behind the button — don't offer one.
  const canOpen = canOpenAccountEditor || Boolean(staff);
  const editable = !offRoster
    && (canOpenAccountEditor || (Boolean(staff) && employmentEditable));
  const dimmed = staff?.isActive === false || (account ? !account.active : false);
  const jobLines = account ? jobsByAccountId[account.accountId] ?? [] : [];
  const jobLabel = personJobLabel(person, lang);

  return (
    <div
      className={`${styles.teamRow}${self ? ` ${styles.selfRow}` : ''}${dimmed ? ` ${styles.dimmedRow}` : ''}`}
      role="listitem"
    >
      <span className={styles.avatar} aria-hidden="true">
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
        <span className={styles.personJob}>{jobLabel}</span>
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

      <div className={styles.rowBadges}>
        {account ? (
          <span className={styles.accountStatusBadge}>{'STAXIS LOGIN'}</span>
        ) : (
          <span className={styles.linkedBadge}>{'NO LOGIN'}</span>
        )}
        {lifecycleIsPending ? (
          <span className={`${styles.accountStatusBadge} ${styles.accountStatusPending}`} role="status">
            {'Status change pending'}
          </span>
        ) : null}
        {account && !account.active ? (
          <span className={`${styles.accountStatusBadge} ${styles.accountStatusDisabled}`}>
            {'Inactive'}
          </span>
        ) : null}
        {staff?.isActive === false ? (
          <span className={`${styles.accountStatusBadge} ${styles.accountStatusDisabled}`}>
            {'Off roster'}
          </span>
        ) : null}
      </div>

      {canOpen || (!offRoster && availableActions?.canRemove) ? (
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
          {account && !offRoster && availableActions?.canRemove ? (
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
