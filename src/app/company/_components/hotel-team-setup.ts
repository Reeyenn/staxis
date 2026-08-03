export type HotelTeamSetupMode = 'first-person' | 'hotel-owner-or-gm';
export type HotelTeamOnboardingStatus = 'none' | 'pending' | 'created';

export type HotelTeamLeadershipRole = 'owner' | 'general_manager';

export interface HotelTeamSetupMember {
  accountId: string;
  active: boolean;
  lifecyclePending?: boolean;
  /** Canonical first-person contract for this selected hotel. */
  directHotelAccount?: boolean | null;
  /** Canonical active Owner/GM standing for this selected hotel. */
  hotelLeadershipRole?: HotelTeamLeadershipRole | null;
}

export interface HotelTeamSetupStateInput {
  adminPreview: boolean;
  teamLoading: boolean;
  teamError: boolean;
  peopleCount: number;
  team: readonly HotelTeamSetupMember[];
  rosterUnavailable?: boolean;
  approvalSettled?: boolean;
  onboardingStatus?: HotelTeamOnboardingStatus;
}

export interface HotelTeamSetupState {
  hasDirectHotelAccount: boolean;
  hasActiveQualifiedHotelLeader: boolean;
  directnessKnown: boolean;
  needsFirstPerson: boolean;
  needsHotelOwnerOrGm: boolean;
  setupMode: HotelTeamSetupMode | null;
}

/**
 * Derive the admin-preview setup action from the selected hotel's current
 * roster, onboarding marker, and canonical direct-account projection.
 */
export function deriveHotelTeamSetupState({
  adminPreview,
  teamLoading,
  teamError,
  peopleCount,
  team,
  rosterUnavailable = false,
  approvalSettled = true,
  onboardingStatus,
}: HotelTeamSetupStateInput): HotelTeamSetupState {
  // `null` and an omitted field mean the server could not establish the
  // active-account contract for this row. Fail closed instead of turning an
  // indeterminate roster into an onboarding claim.
  const directnessKnown = team.every((member) => typeof member.directHotelAccount === 'boolean');
  const hasDirectHotelAccount = team.some((member) => member.directHotelAccount === true);
  const hasActiveQualifiedHotelLeader = team.some((member) => {
    if (!member.active || member.lifecyclePending) return false;
    return member.hotelLeadershipRole === 'owner'
      || member.hotelLeadershipRole === 'general_manager';
  });
  const previewReady = adminPreview
    && !teamLoading
    && !teamError
    && !rosterUnavailable
    && approvalSettled
    && directnessKnown
    && onboardingStatus !== undefined
    && onboardingStatus !== 'pending'
    && onboardingStatus !== 'created';
  const needsFirstPerson = previewReady
    && peopleCount === 0
    && !hasDirectHotelAccount;
  const needsHotelOwnerOrGm = previewReady
    && peopleCount > 0
    && !hasActiveQualifiedHotelLeader
    && !hasDirectHotelAccount;

  return {
    hasDirectHotelAccount,
    hasActiveQualifiedHotelLeader,
    directnessKnown,
    needsFirstPerson,
    needsHotelOwnerOrGm,
    setupMode: needsFirstPerson
      ? 'first-person'
      : needsHotelOwnerOrGm
        ? 'hotel-owner-or-gm'
        : null,
  };
}

export function hotelTeamSetupLabel(mode: HotelTeamSetupMode | null): string | null {
  if (mode === 'first-person') return 'Add first person';
  if (mode === 'hotel-owner-or-gm') return 'Add hotel owner or GM';
  return null;
}

export function hotelTeamSetupDialogTitle(mode: HotelTeamSetupMode): string {
  return hotelTeamSetupLabel(mode) ?? 'Add first person';
}

export function hotelTeamSetupDescription(mode: HotelTeamSetupMode): string {
  return mode === 'hotel-owner-or-gm'
    ? 'Add a hotel Owner or General Manager while keeping the existing People roster unchanged. The assigned role is locked into signup.'
    : 'Assign the role before sending the invitation. The invitee cannot change it during signup.';
}

export function hotelTeamSetupInvitationError(mode: HotelTeamSetupMode): string {
  return mode === 'hotel-owner-or-gm'
    ? "Couldn't create the hotel Owner or General Manager invitation."
    : "Couldn't create the first-person invitation.";
}

export function hotelTeamSetupScopeLabel(mode: HotelTeamSetupMode): string {
  return mode === 'hotel-owner-or-gm' ? 'Hotel owner or GM' : 'First person';
}

export function hotelTeamSetupLinkLabel(mode: HotelTeamSetupMode): string {
  return mode === 'hotel-owner-or-gm'
    ? 'Hotel setup link'
    : 'First-person onboarding link';
}
