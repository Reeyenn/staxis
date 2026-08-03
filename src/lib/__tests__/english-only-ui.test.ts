import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

const root = process.cwd();
const source = (path: string) => readFileSync(resolve(root, path), 'utf8');

describe('English-only application UI', () => {
  test('the application locale is fixed to English and ignores saved locale state', () => {
    const context = source('src/contexts/LanguageContext.tsx');
    assert.match(context, /lang:\s*'en'/);
    assert.match(context, /locale:\s*'en'/);
    assert.doesNotMatch(context, /localStorage|staxis-locale|hotelops-lang|preferred_language/);
    assert.doesNotMatch(context, /setLang|setLocale|fetch\(/);
    assert.match(source('src/app/layout.tsx'), /<html[\s\S]{0,80}?lang="en"/);
  });

  test('language selector and automatic UI translator are absent', () => {
    assert.equal(existsSync(resolve(root, 'src/components/i18n/LanguageSwitcher.tsx')), false);
    assert.equal(existsSync(resolve(root, 'src/components/i18n/GlobalAutoTranslate.tsx')), false);
    assert.equal(existsSync(resolve(root, 'src/app/api/comms/translate/route.ts')), false);

    for (const path of [
      'src/components/concourse/ConcourseBar.tsx',
      'src/components/concourse/MobileConcourseNav.tsx',
      'src/components/layout/AppLayout.tsx',
      'src/app/(staff-link)/housekeeper/page.tsx',
      'src/app/(staff-link)/housekeeper/[id]/page.tsx',
      'src/app/(staff-link)/laundry/page.tsx',
      'src/app/(staff-link)/laundry/[id]/page.tsx',
    ]) {
      assert.doesNotMatch(source(path), /LanguageSwitcher|GlobalAutoTranslate|Change language/);
    }
  });

  test('English section labels and routes remain registered', () => {
    const registry = source('src/lib/sections/registry.ts');
    for (const [label, href] of [
      ['Dashboard', '/dashboard'],
      ['Housekeeping', '/housekeeping'],
      // Renamed 2026-07-30: To-do, Calendar and the Log book moved to the
      // Staxis list, so the tab holds messaging and says so. The section KEY is
      // still 'communications' (stored enabled_sections maps are keyed by it).
      ['Messages', '/communications'],
      ['Maintenance', '/maintenance'],
      ['Inventory', '/inventory'],
      ['Staff', '/staff'],
      ['Financials', '/financials'],
    ]) {
      assert.match(registry, new RegExp(`label_en: '${label}'`));
      assert.match(registry, new RegExp(`navHref: '${href}'`));
    }
    assert.doesNotMatch(registry, /label_es|desc_es/);
  });
});
