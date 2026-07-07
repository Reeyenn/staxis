// Behavior tests for the section registry — the default-ON contract that gates
// every section across nav, page bodies, API routes, crons, and the agent.
//
// The load-bearing invariant: a hotel with NO stored value (every existing
// hotel, NULL column) must resolve to ALL 8 sections ON. A single inverted
// check here would strip every tab from every paying customer on deploy, so the
// resolver, the defensive parser, and the write validator are pinned down hard.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  APP_SECTIONS,
  isAppSection,
  isSectionEnabled,
  resolveSections,
  normalizeSectionFlags,
  sectionForPath,
  parseSectionFlags,
} from '@/lib/sections/registry';

describe('isSectionEnabled — default-ON contract', () => {
  test('null / undefined ⇒ ON (existing hotels with no stored map)', () => {
    assert.equal(isSectionEnabled(null, 'inventory'), true);
    assert.equal(isSectionEnabled(undefined, 'inventory'), true);
  });

  test('empty object ⇒ every section ON', () => {
    for (const s of APP_SECTIONS) assert.equal(isSectionEnabled({}, s), true);
  });

  test('missing key ⇒ ON (partial map only lists explicit choices)', () => {
    assert.equal(isSectionEnabled({ financials: false }, 'inventory'), true);
  });

  test('explicit false ⇒ OFF (the only thing that disables)', () => {
    assert.equal(isSectionEnabled({ financials: false }, 'financials'), false);
  });

  test('explicit true ⇒ ON', () => {
    assert.equal(isSectionEnabled({ financials: true }, 'financials'), true);
  });

  test('non-object / array ⇒ ON (never trust a malformed value into all-off)', () => {
    assert.equal(isSectionEnabled('nope' as unknown as null, 'staff'), true);
    assert.equal(isSectionEnabled([] as unknown as null, 'staff'), true);
    assert.equal(isSectionEnabled(42 as unknown as null, 'staff'), true);
  });

  test('a truthy-but-not-true value (e.g. 1) still counts as ON — only === false disables', () => {
    assert.equal(isSectionEnabled({ staff: 1 } as unknown as Record<string, boolean>, 'staff'), true);
  });
});

describe('resolveSections — full 8-key map', () => {
  test('null ⇒ all true', () => {
    const r = resolveSections(null);
    assert.deepEqual(Object.keys(r).sort(), [...APP_SECTIONS].sort());
    for (const s of APP_SECTIONS) assert.equal(r[s], true);
  });

  test('partial map fills missing keys with true, honors explicit false', () => {
    const r = resolveSections({ housekeeping: false });
    assert.equal(r.housekeeping, false);
    assert.equal(r.inventory, true);
    assert.equal(r.staxis, true);
  });
});

describe('normalizeSectionFlags — defensive parse (jsonb may arrive as object OR string)', () => {
  test('plain object passes through', () => {
    assert.deepEqual(normalizeSectionFlags({ inventory: false }), { inventory: false });
  });

  test('JSON-encoded string is parsed', () => {
    assert.deepEqual(normalizeSectionFlags('{"inventory":false}'), { inventory: false });
  });

  test('null / undefined ⇒ null (⇒ all ON downstream)', () => {
    assert.equal(normalizeSectionFlags(null), null);
    assert.equal(normalizeSectionFlags(undefined), null);
  });

  test('unparseable string ⇒ null, never throws', () => {
    assert.equal(normalizeSectionFlags('{bad json'), null);
  });

  test('array / number / string-primitive ⇒ null (not a section map)', () => {
    assert.equal(normalizeSectionFlags([]), null);
    assert.equal(normalizeSectionFlags(7), null);
    assert.equal(normalizeSectionFlags('"just a string"'), null);
  });

  test('round-trip: normalize(string) then isSectionEnabled resolves correctly', () => {
    const flags = normalizeSectionFlags('{"financials":false}');
    assert.equal(isSectionEnabled(flags, 'financials'), false);
    assert.equal(isSectionEnabled(flags, 'inventory'), true);
  });
});

describe('sectionForPath — reverse route lookup', () => {
  test('exact section route maps to its section', () => {
    assert.equal(sectionForPath('/feed'), 'staxis');
    assert.equal(sectionForPath('/dashboard'), 'dashboard');
    assert.equal(sectionForPath('/financials'), 'financials');
  });

  test('sub-paths map to the owning section', () => {
    assert.equal(sectionForPath('/inventory/ai'), 'inventory');
    assert.equal(sectionForPath('/housekeeping/rooms'), 'housekeeping');
  });

  test('non-section paths ⇒ null (never gated)', () => {
    assert.equal(sectionForPath('/settings'), null);
    assert.equal(sectionForPath('/admin/properties'), null);
    assert.equal(sectionForPath('/onboard'), null);
    assert.equal(sectionForPath('/demo/feed'), null); // login-free preview, not the real /feed
    assert.equal(sectionForPath('/'), null);
    assert.equal(sectionForPath(null), null);
    assert.equal(sectionForPath(undefined), null);
  });

  test('a path that merely starts with a section string but is a different route ⇒ null', () => {
    assert.equal(sectionForPath('/feedback'), null); // not /feed or /feed/*
  });
});

describe('parseSectionFlags — write-payload validation', () => {
  test('valid full map round-trips to a full 8-key map', () => {
    const res = parseSectionFlags({
      staxis: true, dashboard: true, housekeeping: true, communications: false,
      maintenance: true, inventory: true, staff: true, financials: false,
    });
    assert.equal(res.ok, true);
    if (res.ok) {
      assert.equal(res.value.communications, false);
      assert.equal(res.value.financials, false);
      assert.equal(res.value.inventory, true);
      assert.equal(Object.keys(res.value).length, APP_SECTIONS.length);
    }
  });

  test('partial map is accepted and missing keys default to true', () => {
    const res = parseSectionFlags({ inventory: false });
    assert.equal(res.ok, true);
    if (res.ok) {
      assert.equal(res.value.inventory, false);
      assert.equal(res.value.staff, true);
      assert.equal(Object.keys(res.value).length, APP_SECTIONS.length);
    }
  });

  test('unknown key is rejected', () => {
    const res = parseSectionFlags({ inventory: false, wombats: true });
    assert.equal(res.ok, false);
  });

  test('non-boolean value is rejected', () => {
    const res = parseSectionFlags({ inventory: 'off' });
    assert.equal(res.ok, false);
  });

  test('array / null / non-object is rejected', () => {
    assert.equal(parseSectionFlags([]).ok, false);
    assert.equal(parseSectionFlags(null).ok, false);
    assert.equal(parseSectionFlags('nope').ok, false);
  });
});

describe('isAppSection', () => {
  test('accepts the 8 canonical keys, rejects others', () => {
    for (const s of APP_SECTIONS) assert.equal(isAppSection(s), true);
    assert.equal(isAppSection('front_desk'), false);
    assert.equal(isAppSection('laundry'), false);
    assert.equal(isAppSection(''), false);
    assert.equal(isAppSection(null), false);
  });
});
