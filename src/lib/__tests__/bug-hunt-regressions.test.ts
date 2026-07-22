import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { validatePropertyUpdateField } from '@/lib/onboarding/property-update-validation';

const source = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');

describe('bug-hunt regression contracts', () => {
  test('onboarding accepts nullable optional text without weakening required fields', () => {
    for (const field of ['brand', 'region', 'climate_zone', 'size_tier']) {
      assert.deepEqual(validatePropertyUpdateField(field, null), { ok: true, value: null });
      assert.deepEqual(validatePropertyUpdateField(field, '   '), { ok: true, value: null });
    }
    assert.equal(validatePropertyUpdateField('name', null).ok, false);
    assert.equal(validatePropertyUpdateField('property_kind', '').ok, false);
    assert.deepEqual(validatePropertyUpdateField('timezone', ' America/Chicago '), {
      ok: true,
      value: 'America/Chicago',
    });
  });

  test('financial forecast derives its default month from the property-local date', () => {
    const route = source('src/app/api/financials/forecast/route.ts');
    const today = route.indexOf('const todayISO = todayInTz(timezone)');
    const month = route.indexOf("todayISO.slice(0, 7)");
    assert.ok(today >= 0 && month > today);
    assert.doesNotMatch(route, /monthKey\(new Date\(\)\)/);
    assert.match(route, /propertyTimezoneOrUTC\(propRow\?\.timezone\)/);
  });

  test('reset preserves the exact cleaning-event completion anchor', () => {
    const reset = source('src/app/api/housekeeper/reset-clean/route.ts');
    assert.match(reset, /const completedAt = roomR\.room\.completed_at/);
    assert.match(reset, /\.eq\('completed_at', completedAt\)/);
    assert.doesNotMatch(reset, /order\('completed_at'/);
  });

  test('realtime and offline drains retain changes arriving during in-flight work', () => {
    const realtime = source('src/lib/db/_common.ts');
    assert.match(realtime, /let observedChangeSeq = 0/);
    assert.match(realtime, /const changeSeqAtStart = observedChangeSeq/);
    assert.match(realtime, /observedChangeSeq === changeSeqAtStart/);
    assert.match(realtime, /observedChangeSeq \+= 1/);

    const offline = source('src/lib/offline-sync/use-offline-sync.ts');
    assert.match(offline, /const drainRequestSeqRef = useRef\(0\)/);
    assert.match(offline, /drainRequestSeqRef\.current \+= 1/);
    assert.match(offline, /requestSeqAtStart !== drainRequestSeqRef\.current\) continue/);
  });

  test('assistant fallbacks and bulk coverage failures are visible in the requested language/UI', () => {
    const assistant = source('src/lib/comms/assistant.ts');
    for (const lang of ['en', 'es', 'ht', 'tl', 'vi']) {
      assert.match(assistant, new RegExp(`\\n  ${lang}: \\{`));
    }
    assert.match(assistant, /assistantFallback\(args\.lang, 'unavailable'\)/);
    assert.match(assistant, /assistantFallback\(args\.lang, 'exhausted'\)/);
    assert.match(assistant, /assistantFallback\(args\.lang, 'error'\)/);

    const onboarding = source('src/app/admin/_components/studio/surfaces/OnboardingSurface.tsx');
    assert.match(onboarding, /const failed = json\.data\?\.failedCount \?\? 0/);
    assert.match(onboarding, /failed to start\. Retry or check Live Hotels/);
  });
});
