/** Ensure a structured API error cannot leave the Live admin surface spinning. */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = readFileSync(
  join(
    process.cwd(),
    'src', 'app', 'admin', '_components', 'studio', 'surfaces', 'LiveSurface.tsx',
  ),
  'utf8',
);

describe('Live admin loading failures', () => {
  test('checks both HTTP status and the standard response envelope', () => {
    assert.match(source, /!response\.ok \|\| payload\?\.ok !== true/);
  });

  test('turns a failed hotel or organization dataset into a visible error and exits the load', () => {
    assert.match(source, /const failed = loads\.find/);
    assert.match(source, /setError\(`Could not load \$\{failed\.label\}: \$\{apiMessage\}`\);\s*return;/);
  });

  test('keeps feedback loading and errors independent from the hotel directory', () => {
    assert.match(source, /void loadFeedback\(\)/);
    assert.match(source, /setFeedbackError\(feedbackLoadError instanceof Error/);
    assert.match(source, /view === ['"]feedback['"] && feedbackError/);
    assert.match(source, /if \(!props \|\| !directory\)/);
    assert.doesNotMatch(source, /if \(!props \|\| !feedback \|\| !directory\)/);
  });
});

describe('Hotels admin directory filters', () => {
  test('loads the full fleet before mutually exclusive organization grouping', () => {
    assert.match(source, /pageSize: String\(API_PAGE_SIZE\)/);
    assert.match(source, /status: ['"]all['"]/);
    assert.match(source, /independentPropertyIds[\s\S]*!groupedPropertyIds\.has\(hotel\.id\)/);
  });

  test('applies every independent-hotel health filter to the complete local fleet', () => {
    assert.match(source, /function matchesHotelStatus/);
    assert.match(source, /status === ['"]no_pms['"][\s\S]*hotel\.pmsType === null/);
    assert.match(source, /status === ['"]pms_disconnected['"][\s\S]*!hotel\.pmsConnected/);
  });

  test('shares the API staleness threshold', () => {
    assert.match(source, /syncFreshnessMin > FLEET_STALE_SYNC_MINUTES/);
  });
});
