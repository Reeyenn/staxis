import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

function source(...parts: string[]): string {
  return readFileSync(join(process.cwd(), ...parts), 'utf8');
}

const panel = source('src', 'app', 'company', '_components', 'HotelTeamPanel.tsx');
const dialogs = source('src', 'app', 'company', '_components', 'HotelTeamDialogs.tsx');
const css = source('src', 'app', 'company', '_components', 'HotelTeamPanel.module.css');

describe('My Hotel account status UI', () => {
  test('renders server-projected account state and sign-in history on each account row', () => {
    assert.match(panel, /active: boolean;/);
    assert.match(panel, /lastSignInKnown: boolean;/);
    assert.match(panel, /lastSignInAt: string \| null;/);
    assert.match(panel, /updatedAt: string;/);
    assert.match(panel, /ownerProtected: boolean;/);
    assert.match(panel, /Login disabled/);
    assert.match(panel, /No sign-ins yet/);
    assert.match(panel, /if \(!known\) return copy\(lang, 'Last sign-in unavailable'/);
    assert.match(panel, /lastSignInLabel\(member\.lastSignInKnown, member\.lastSignInAt, lang\)/);
  });

  test('sends the exact dialog-open snapshot with ordinary role changes', () => {
    assert.match(dialogs, /if \(roleChanged\) \{[\s\S]*profilePayload\.role = role/);
    assert.match(dialogs, /profilePayload\.expectedRole = member\.role/);
    assert.match(dialogs, /profilePayload\.expectedDisplayName = member\.displayName/);
    assert.match(dialogs, /profilePayload\.expectedUpdatedAt = member\.updatedAt/);
  });

  test('keeps normalized organization-owner role and login controls protected', () => {
    assert.match(panel, /!member\.ownerProtected[\s\S]*actionFlag\(member, \['canChangeRole'\]/);
    assert.match(panel, /const lifecycleFloor =[\s\S]*!member\.ownerProtected/);
    assert.match(panel, /const removeFloor =[\s\S]*!member\.ownerProtected/);
    assert.match(panel, /Organization owner access is protected/);
    assert.match(dialogs, /This login stays active while this person is an organization owner/);
    assert.match(dialogs, /Organization-owner access is protected\. Manage ownership from organization access/);
  });

  test('uses only canonical lifecycle flags and matches them to the current account state', () => {
    assert.match(panel, /canDeactivate\?: boolean;/);
    assert.match(panel, /canReactivate\?: boolean;/);
    assert.match(panel, /member\.active[\s\S]*actionFlag\(member, \['canDeactivate'\], 'canDeactivate', false\)/);
    assert.match(panel, /!member\.active[\s\S]*actionFlag\(member, \['canReactivate'\], 'canReactivate', false\)/);
    const roleFloor = panel.slice(panel.indexOf('const roleFloor ='), panel.indexOf('const passwordFloor ='));
    assert.doesNotMatch(roleFloor, /canEdit\b/);
    assert.match(roleFloor, /actionFlag\(member, \['canChangeRole'\], 'canChangeRole', false\)/);
    const editorGate = panel.slice(panel.indexOf('const canOpenEditor ='), panel.indexOf('const staffProfile ='));
    assert.match(editorGate, /availableActions\.canEdit\s*\|\| availableActions\.canChangeRole/);
    assert.match(dialogs, /const canChangeLifecycle = member\.active \? actions\.canDeactivate : actions\.canReactivate/);
    assert.match(panel, /!targetHasAllHotels && hotelIds\.length > 0 && hotelIds\.every\(\(id\) => viewerHotels\.has\(id\)\)/);
  });
});

describe('My Hotel account lifecycle dialog', () => {
  test('keeps the global, reversible confirmation inside the accessible account dialog', () => {
    assert.match(dialogs, /role=\{lifecyclePending \? 'status' : lifecycleIntent === 'deactivate' \? 'alert' : 'status'\}/);
    assert.match(dialogs, /ref=\{lifecycleConfirmationRef\}/);
    assert.match(dialogs, /tabIndex=\{-1\}/);
    assert.match(dialogs, /aria-labelledby=\{lifecycleHeadingId\}/);
    assert.match(dialogs, /aria-describedby=\{lifecycleDescriptionId\}/);
    assert.match(dialogs, /lifecycleConfirmationRef\.current\?\.focus/);
    assert.match(dialogs, /Disable login everywhere/);
    assert.match(dialogs, /account, hotel access, and records stay in place/);
    assert.match(dialogs, /you can reactivate it later/);
    assert.doesNotMatch(dialogs, /window\.confirm\s*\(/);
  });

  test('sends the exact hotel, account, action, and durable operation UUID to the dedicated endpoint', () => {
    assert.match(dialogs, /fetchWithAuth\('\/api\/auth\/team\/status'/);
    assert.match(dialogs, /method: 'PUT'/);
    assert.match(dialogs, /accountId: member\.accountId,[\s\S]*action: lifecycleIntent,[\s\S]*operationId: operation\.operationId/);
  });

  test('reuses idempotency UUIDs safely across retries and browser restarts', () => {
    assert.match(dialogs, /type LifecycleAction = HotelTeamLifecycleAction/);
    assert.match(dialogs, /lifecycleOperationStorageKey\(accountId, action\)/);
    assert.match(dialogs, /window\.localStorage\.getItem/);
    assert.match(dialogs, /window\.localStorage\.setItem/);
    assert.match(dialogs, /cryptoApi\?\.randomUUID/);
    assert.match(dialogs, /getRandomValues\(new Uint8Array\(16\)\)/);
    assert.match(dialogs, /operation && !operation\.submitted/);
    assert.match(dialogs, /lifecycleResponseIsDefinitivelyAborted\(response\)/);
    assert.match(dialogs, /response\.status < 400 \|\| response\.status >= 500/);
    assert.match(dialogs, /clearLifecycleOperation\(member\.accountId, operation\)[\s\S]*await onSaved\(\)/);
  });

  test('uses a synchronous in-flight latch before sending lifecycle requests', () => {
    assert.match(dialogs, /const lifecycleInFlightRef = React\.useRef\(false\)/);
    assert.match(dialogs, /if \(!lifecycleIntent \|\| busy \|\| lifecyclePending \|\| lifecycleInFlightRef\.current\) return/);
    assert.match(dialogs, /lifecycleInFlightRef\.current = true;[\s\S]*fetchWithAuth\('\/api\/auth\/team\/status'/);
    assert.match(dialogs, /finally \{[\s\S]*lifecycleInFlightRef\.current = false/);
  });

  test('protects unsaved edits and treats Escape or scrim as inline confirmation cancellation', () => {
    assert.match(dialogs, /const nameChanged = displayName !== savedDisplayName/);
    assert.match(dialogs, /if \(!allowed \|\| busy \|\| dirty \|\| lifecyclePending\) return/);
    assert.match(dialogs, /disabled=\{busy \|\| dirty\}/);
    assert.match(dialogs, /Save or cancel your unsaved changes before changing login access/);
    assert.match(dialogs, /if \(lifecycleIntent\) \{[\s\S]*cancelLifecycleConfirmation\(\)/);
    assert.match(dialogs, /onClose=\{requestDialogClose\}/);
    assert.match(dialogs, /lifecycleTriggerRef\.current\?\.focus/);
    assert.match(dialogs, /disabled=\{!actions\.canEdit \|\| formLocked\}/);
    assert.match(dialogs, /disabled=\{!dirty \|\| formLocked\}/);
  });

  test('guards every dirty close path with one inline discard confirmation', () => {
    assert.match(dialogs, /const \[discardConfirming, setDiscardConfirming\] = React\.useState\(false\)/);
    assert.match(dialogs, /const formLocked = busy \|\| lifecycleConfirming \|\| discardConfirming \|\| lifecyclePending/);
    assert.match(dialogs, /if \(discardConfirming\) \{[\s\S]*cancelDiscardConfirmation\(\)/);
    assert.match(dialogs, /if \(dirty\) \{[\s\S]*setDiscardConfirming\(true\)/);
    assert.match(dialogs, /className=\{styles\.dialogScrim\}[\s\S]*onClose\(\)/);
    assert.match(dialogs, /if \(event\.key === 'Escape'\)[\s\S]*onCloseRef\.current\(\)/);
    assert.match(dialogs, /ref=\{discardConfirmationRef\}[\s\S]*role="alert"[\s\S]*aria-labelledby=\{discardHeadingId\}/);
    assert.match(dialogs, /discardConfirmationRef\.current\?\.focus/);
    assert.match(dialogs, /discardReturnFocusRef\.current[\s\S]*returnTarget\.focus/);
    assert.match(dialogs, /Keep editing/);
    assert.match(dialogs, /Discard changes/);
    assert.match(dialogs, /Seguir editando/);
    assert.match(dialogs, /Descartar cambios/);
  });

  test('does not offer owner in ordinary role selection and leaves existing owners readable', () => {
    assert.match(dialogs, /ASSIGNABLE_ROLES\.filter\(\(value\) => value !== 'owner'\)/);
    assert.match(dialogs, /member\.role === 'owner'[\s\S]*Owner access is protected/);
    assert.match(dialogs, /!member\.active[\s\S]*Reactivate this login before changing its role/);
  });

  test('reconciles one retained operation outside the dialog and keeps pending rows truthful', () => {
    assert.match(dialogs, /lifecycleResponseNeedsReconciliation\(response, body, operation\.operationId\)/);
    assert.match(dialogs, /const markLifecyclePending = \(operation: LifecycleOperation\)[\s\S]*onLifecyclePending\(\{[\s\S]*operationId: operation\.operationId/);
    assert.match(dialogs, /let submittedOperation: LifecycleOperation \| null = null/);
    assert.match(dialogs, /catch \(lifecycleFailure\)[\s\S]*if \(submittedOperation\)[\s\S]*markLifecyclePending\(submittedOperation\)/);
    assert.match(dialogs, /Status change pending/);
    assert.match(dialogs, /Close while verifying/);
    assert.match(panel, /LIFECYCLE_RECONCILIATION_DELAYS_MS/);
    assert.match(panel, /action: operation\.action,[\s\S]*operationId: operation\.operationId/);
    assert.match(panel, /pendingLifecycleByAccount\[member\.accountId\]/);
    assert.match(panel, /member\.lifecyclePending === true/);
    assert.match(panel, /Status change pending/);
    assert.match(panel, /disabled=\{lifecycleIsPending\}/);
    assert.match(panel, /Verification paused\. Reload to check the final status\./);
    assert.match(panel, /LIFECYCLE_SERVER_REFRESH_DELAYS_MS/);
    assert.match(panel, /await loadTeam\(\)/);
  });

  test('the lazy dialog fallback traps focus and restores its trigger', () => {
    const loadingDialog = panel.slice(panel.indexOf('function DialogLoading('), panel.indexOf('function DialogLoadingSection'));
    assert.match(loadingDialog, /const dialogRef = React\.useRef/);
    assert.match(loadingDialog, /event\.key !== 'Tab'/);
    assert.match(loadingDialog, /document\.activeElement === first/);
    assert.match(loadingDialog, /document\.activeElement === last/);
    assert.match(loadingDialog, /returnFocusElement\?\.isConnected/);
    assert.match(loadingDialog, /ref=\{dialogRef\}/);
  });

  test('keeps lifecycle targets touch-sized, mobile-safe, and reduced-motion-safe', () => {
    assert.match(css, /\.primaryButton,[\s\S]*min-height: 44px;/);
    const mobile = css.slice(css.indexOf('@media (max-width: 560px)'));
    assert.match(mobile, /\.lifecycleConfirmationActions > button[\s\S]*width: 100%/);
    const reducedMotion = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
    assert.match(reducedMotion, /\.dangerButton[\s\S]*transition: none/);
  });
});
