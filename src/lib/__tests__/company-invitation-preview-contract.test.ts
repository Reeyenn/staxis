import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

const source = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');
const previewRoute = source('src/app/api/company-access/invitations/preview/route.ts');
const invitationPage = source('src/app/company-invite/[token]/page.tsx');

describe('company invitation preview', () => {
  test('keeps the raw capability in a rate-limited request body and returns only review terms', () => {
    assert.match(previewRoute, /checkAndIncrementRateLimit\(['"]company-invitation-preview['"]/);
    assert.match(previewRoute, /await req\.json\(\)/);
    assert.match(previewRoute, /createHash\(['"]sha256['"]\)\.update\(token\)/);
    assert.doesNotMatch(previewRoute, /searchParams|get\(['"]token['"]\)/);
    assert.match(previewRoute, /organizationName:/);
    assert.match(previewRoute, /invitedEmail:/);
    assert.match(previewRoute, /accessProfile:/);
    assert.match(previewRoute, /scopeLabel,/);
    assert.match(previewRoute, /invitationExpiresAt:/);
    assert.doesNotMatch(previewRoute, /tokenHash:|organizationId:/);
  });

  test('fails closed for expired, inactive, or stale invitation scopes', () => {
    assert.match(previewRoute, /invitation\.status !== ['"]pending['"]/);
    assert.match(previewRoute, /invitation\.expires_at/);
    assert.match(previewRoute, /organization\.status !== ['"]active['"]/);
    assert.match(previewRoute, /portfolio\.status !== ['"]active['"]/);
    assert.match(previewRoute, /relationshipEndsAt !== null && relationshipEndsAt <= now/);
    assert.match(previewRoute, /Cache-Control['"]?: ['"]no-store/);
  });

  test('requires the preview before accepting and renders every review term', () => {
    assert.match(invitationPage, /fetch\(['"]\/api\/company-access\/invitations\/preview['"]/);
    assert.match(invitationPage, /if \(submitting \|\| !preview \|\| !token\) return/);
    assert.match(invitationPage, /<InvitationReviewCard preview=\{preview\}/);
    assert.match(invitationPage, /COMPANY_INVITATION_SIGN_IN_HREF/);
    assert.match(invitationPage, /window\.history\.replaceState\([\s\S]*COMPANY_INVITATION_RESUME_PATH/);
    assert.doesNotMatch(invitationPage, /`\/signin\?redirect=\$\{encodeURIComponent\(invitationPath\)\}`/);
    assert.match(invitationPage, /clearCompanyInvitationHandoff\(\)[\s\S]*router\.replace\(['"]\/company['"]\)/);
  });
});
