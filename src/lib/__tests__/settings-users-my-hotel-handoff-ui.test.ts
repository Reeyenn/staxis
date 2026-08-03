import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

function source(...parts: string[]): string {
  return readFileSync(join(process.cwd(), ...parts), 'utf8');
}

const settings = source('src', 'app', '(hotel)', 'settings', 'page.tsx');
const compatibilityPage = source('src', 'app', '(hotel)', 'settings', 'users', 'page.tsx');
const company = source('src', 'app', '(hotel)', 'company', 'page.tsx');
const transferPanel = source(
  'src', 'app', '(hotel)', 'company', '_components', 'LegacyOwnershipTransferPanel.tsx',
);
const companyCss = source('src', 'app', '(hotel)', 'company', 'CompanyAccess.module.css');

describe('single customer people/access surface', () => {
  test('removes Settings Users navigation and server-redirects old bookmarks to Access', () => {
    assert.doesNotMatch(settings, /href:\s*['"]\/settings\/users['"]/);
    assert.doesNotMatch(settings, /Users & Roles|Usuarios y roles/);
    assert.match(compatibilityPage, /import \{ redirect \} from ['"]next\/navigation['"]/);
    assert.match(compatibilityPage, /redirect\(['"]\/company\?tab=access['"]\)/);
    assert.doesNotMatch(compatibilityPage, /['"]use client['"]|AppLayout|fetchWithAuth/);
  });

  test('keeps the legacy-only ownership handoff inside the existing Access tab', () => {
    assert.match(company, /type TabId = ['"]hotels['"] \| ['"]people['"] \| ['"]access['"]/);
    assert.doesNotMatch(company, /type TabId = [^\n]*['"]overview['"]/);
    assert.match(company, /<LegacyOwnershipTransferPanel/);
    assert.match(company, /enabled=\{!adminPreview && data\.legacyFallback && canManageUsers/);
    assert.match(company, /propertyId=\{activeProperty\?\.id \?\? null\}/);
    assert.match(company, /currentAccountId=\{currentAccountId\}/);
    assert.doesNotMatch(company, /['"]\/settings\/users['"]/);
  });

  test('renders the transfer control only for the fresh legacy owner roster row', () => {
    assert.match(transferPanel, /activeViewerRef\.current = enabled && propertyId[\s\S]*?`\$\{currentAccountId\}:\$\{propertyId\}`/);
    assert.match(transferPanel, /activeViewerRef\.current !== requestedViewer/);
    assert.match(transferPanel, /const isCurrentLegacyOwner = currentRole === ['"]owner['"]/);
    assert.match(transferPanel, /caller\?\.active === true/);
    assert.match(transferPanel, /caller\.role === ['"]owner['"]/);
    assert.match(transferPanel, /caller\.managementSurface === ['"]legacy_hotel['"]/);
    assert.match(transferPanel, /if \(!loading && !isCurrentLegacyOwner/);
    assert.match(transferPanel, /user\.managementSurface === ['"]legacy_hotel['"]/);
    assert.match(transferPanel, /sameHotelSet\(user\.propertyAccess, caller\.propertyAccess\)/);
    assert.doesNotMatch(transferPanel, /user\.role === ['"]admin['"] \|\|/);
  });

  test('preserves one operation UUID across ambiguous outcomes and response-loss reloads', () => {
    assert.match(transferPanel, /getOrCreateOwnershipTransferAttempt/);
    assert.match(transferPanel, /findOwnershipTransferAttempt/);
    assert.match(transferPanel, /window\.localStorage/);
    assert.match(transferPanel, /operationId,/);
    assert.match(transferPanel, /const definitive = \(response\.ok && body\.ok === true\)/);
    assert.match(transferPanel, /clearOwnershipTransferAttempt\(storage, requestedPropertyId, accountId, operationId\)/);
    assert.match(transferPanel, /former owner signed in as GM/);
    assert.doesNotMatch(transferPanel, /finally[\s\S]{0,180}clearOwnershipTransferAttempt/);
  });

  test('uses the company endpoint, confirmation dialog, focus trap, and mobile-safe targets', () => {
    assert.match(transferPanel, /\/api\/company-access\/legacy-ownership-transfer/);
    assert.doesNotMatch(transferPanel, /\/api\/settings\/users/);
    assert.match(transferPanel, /role="dialog"/);
    assert.match(transferPanel, /aria-modal="true"/);
    assert.match(transferPanel, /event\.key === ['"]Escape['"]/);
    assert.match(transferPanel, /event\.key !== ['"]Tab['"]/);
    assert.match(companyCss, /\.legacyOwnershipControls[\s\S]*?\.dangerButton/);
    const mobile = companyCss.slice(companyCss.indexOf('@media (max-width: 600px)'));
    assert.match(mobile, /\.legacyOwnershipControls[\s\S]*?flex-direction: column/);
    assert.match(mobile, /\.primaryButton,[\s\S]*?\.dangerButton,[\s\S]*?min-height: 44px/);
  });
});
