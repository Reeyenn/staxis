/** Regression guards for the Admin Studio Hotels directory contract. */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const shellSource = readFileSync(
  join(process.cwd(), 'src', 'app', 'admin', '_components', 'studio', 'StudioShell.tsx'),
  'utf8',
);
const surfaceSource = readFileSync(
  join(process.cwd(), 'src', 'app', 'admin', '_components', 'studio', 'surfaces', 'LiveSurface.tsx'),
  'utf8',
);
const routeSource = readFileSync(
  join(process.cwd(), 'src', 'app', 'api', 'admin', 'organizations', 'route.ts'),
  'utf8',
);
const assignRouteSource = readFileSync(
  join(process.cwd(), 'src', 'app', 'api', 'admin', 'organizations', 'assign', 'route.ts'),
  'utf8',
);
const bootstrapInviteRouteSource = readFileSync(
  join(process.cwd(), 'src', 'app', 'api', 'admin', 'organizations', 'invitations', 'route.ts'),
  'utf8',
);
const bootstrapInviteModalSource = readFileSync(
  join(process.cwd(), 'src', 'app', 'admin', '_components', 'studio', 'OrganizationLeaderInviteModal.tsx'),
  'utf8',
);
const surfaceKitSource = readFileSync(
  join(process.cwd(), 'src', 'app', 'admin', '_components', 'studio', 'surface-kit.tsx'),
  'utf8',
);

describe('Admin Studio Hotels information architecture', () => {
  test('renames the top-level surface and keeps the approved subview order', () => {
    assert.match(shellSource, /id: ['"]live['"], label: ['"]Hotels['"]/);
    const approvedSubviewOrder = /id: ['"]organizations['"], label: ['"]Organizations['"][\s\S]*id: ['"]independent['"], label: ['"]Independent Hotels['"][\s\S]*id: ['"]feedback['"], label: ['"]Feedback Inbox['"]/;
    assert.match(surfaceSource, approvedSubviewOrder);
  });

  test('uses keyboard-accessible tabs and expandable organization rows', () => {
    assert.match(surfaceSource, /role="tablist"/);
    assert.match(surfaceSource, /aria-selected=\{selected\}/);
    assert.match(surfaceSource, /aria-expanded=\{expanded\}/);
    assert.match(surfaceSource, /\['ArrowLeft', 'ArrowRight', 'Home', 'End'\]/);
  });

  test('keeps every modal reachable and restores focus to its opener', () => {
    assert.match(surfaceKitSource, /maxHeight: ['"]calc\(100dvh - 48px\)['"]/);
    assert.match(surfaceKitSource, /overflowY: ['"]auto['"]/);
    assert.match(surfaceKitSource, /data-studio-modal-backdrop/);
    assert.match(surfaceSource, /const returnFocusRef = useRef<HTMLElement \| null>/);
    assert.match(surfaceSource, /returnFocusElement\.focus\(\{ preventScroll: true \}\)/);
    assert.match(surfaceSource, /openBackdrops\[openBackdrops\.length - 1\] !== ownBackdrop/);
    assert.match(surfaceSource, /aria-labelledby="hotel-detail-title"/);
    assert.match(surfaceSource, /aria-labelledby="delete-hotel-title"/);
  });

  test('does not offer a hotel assignment when the independent list is empty or the organization is inactive', () => {
    assert.match(surfaceSource, /hasIndependentHotels=\{independentHotels\.length > 0\}/);
    assert.match(surfaceSource, /canAssign=\{schemaReady && organization\.status === ['"]active['"] && hasIndependentHotels\}/);
    assert.match(surfaceSource, /assignableOrganizations = useMemo[\s\S]*organization\.status === ['"]active['"]/);
    assert.match(surfaceSource, /No independent hotels are available to assign/);
  });

  test('refreshes only feedback after an inbox mutation', () => {
    assert.match(surfaceSource, /const refreshFeedback = useCallback/);
    assert.match(surfaceSource, /onChanged=\{refreshFeedback\}/);
    assert.doesNotMatch(surfaceSource, /onChanged=\{load\}/);
  });

  test('previews create and primary assignment impacts before mutating', () => {
    assert.match(surfaceSource, /Review before creating/);
    assert.match(surfaceSource, /Impact preview/);
    assert.match(surfaceSource, /fetchWithAuth\(['"]\/api\/admin\/organizations['"], \{[\s\S]*method: ['"]POST['"]/);
    assert.match(surfaceSource, /fetchWithAuth\(['"]\/api\/admin\/organizations\/assign['"], \{[\s\S]*isPrimary: true/);
    assert.match(surfaceSource, /organizationId: null,[\s\S]*Make independent/);
  });

  test('lets Staxis bootstrap a first customer leader without joining the company', () => {
    assert.match(surfaceSource, /Invite company lead/);
    assert.match(bootstrapInviteModalSource, /organization_owner/);
    assert.match(bootstrapInviteModalSource, /organization_admin/);
    assert.match(bootstrapInviteModalSource, /Staxis remains separate and never becomes a company member/);
    assert.match(bootstrapInviteModalSource, /emailSent \? 'Invitation sent' : 'Invitation ready'/);
  });
});

describe('Admin organization directory read boundary', () => {
  test('requires a Staxis admin and reads only currently active primary grouping relationships', () => {
    assert.match(routeSource, /requireAdmin\(req\)/);
    assert.match(routeSource, /\.eq\(['"]is_primary_grouping['"], true\)/);
    assert.ok(routeSource.includes('ends_at.is.null,ends_at.gt.${nowIso}'));
    assert.ok(routeSource.includes('ended_at.is.null,ended_at.gt.${nowIso}'));
    assert.match(routeSource, /activeWindowAt\(relationship\.starts_at, relationship\.ends_at, nowMs\)/);
    assert.match(routeSource, /activeWindowAt\(membership\.starts_at, membership\.ended_at, nowMs\)/);
    assert.match(routeSource, /\.from\(['"]accounts['"]\)[\s\S]*\.eq\(['"]active['"], true\)/);
    assert.match(routeSource, /!activeAccountIds\.has\(membership\.account_id\)/);
  });

  test('classifies legacy single-hotel anchors as independent', () => {
    assert.match(routeSource, /organization\.organization_type !== ['"]single_hotel['"]/);
    assert.match(routeSource, /!groupedManagementPropertyIds\.has\(property\.id\)/);
  });

  test('keeps every hotel visible while the additive schema is unavailable', () => {
    assert.match(routeSource, /isMissingOrganizationSchema/);
    assert.match(routeSource, /organizations: \[\],[\s\S]*independentHotels: properties\.map\(hotelDto\),[\s\S]*schemaReady: false/);
  });

  test('serializes primary moves and allows an explicit return to independent', () => {
    assert.match(assignRouteSource, /requireAdmin\(req\)/);
    assert.match(assignRouteSource, /body\.organizationId === null/);
    assert.match(assignRouteSource, /relationshipType !== ['"]operator['"] && relationshipType !== ['"]owner['"]/);
    assert.match(assignRouteSource, /staxis_set_primary_property_organization/);
  });

  test('bootstraps leaders through the narrow admin-only RPC with real email fallback', () => {
    assert.match(bootstrapInviteRouteSource, /requireAdmin\(req\)/);
    assert.match(bootstrapInviteRouteSource, /BOOTSTRAP_PROFILES/);
    assert.match(bootstrapInviteRouteSource, /staxis_bootstrap_organization_leader_invitation/);
    assert.match(bootstrapInviteRouteSource, /sendOrganizationAccessInvite/);
    assert.match(bootstrapInviteRouteSource, /randomBytes\(32\)\.toString\(['"]hex['"]\)/);
    assert.match(bootstrapInviteRouteSource, /company-invite\/\$\{encodeURIComponent\(rawToken\)\}/);
  });
});
