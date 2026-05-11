/**
 * Tests for setPropertyContextOnScope in src/lib/sentry.ts — the helper
 * that lifts property identifiers from a free-form extras bag onto a
 * Sentry scope as TAGS (filterable) instead of leaving them buried in
 * extras (unfilterable).
 *
 * We don't import @sentry/nextjs here; we hand the helper a fake scope
 * that records the calls. Keeps the test pure-logic, no Sentry init
 * needed, and side-steps the Next-specific module loader.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { setPropertyContextOnScope } from '../sentry';

type Scope = Parameters<typeof setPropertyContextOnScope>[0];

interface ScopeCalls {
  tags: Record<string, unknown>;
  contexts: Record<string, unknown>;
  extras: Record<string, unknown>;
}

function makeFakeScope(): { scope: Scope; calls: ScopeCalls } {
  const calls: ScopeCalls = { tags: {}, contexts: {}, extras: {} };
  // Build a structural-typed stub. Cast through unknown to dodge Sentry's
  // fluent-API return-this typing; the helper only uses setTag/setContext
  // and never reads the return value.
  const scope = {
    setTag(key: string, value: unknown) { calls.tags[key] = value; return scope; },
    setContext(key: string, value: unknown) { calls.contexts[key] = value; return scope; },
    setExtras(values: Record<string, unknown>) { Object.assign(calls.extras, values); return scope; },
  } as unknown as Scope;
  return { scope, calls };
}

describe('setPropertyContextOnScope', () => {
  it('lifts pid (short alias) onto property.id tag', () => {
    const { scope, calls } = makeFakeScope();
    const pid = setPropertyContextOnScope(scope, { pid: 'abc-123' });
    assert.equal(pid, 'abc-123');
    assert.equal(calls.tags['property.id'], 'abc-123');
  });

  it('lifts property_id (snake_case) onto property.id tag', () => {
    const { scope, calls } = makeFakeScope();
    setPropertyContextOnScope(scope, { property_id: 'snake-pid' });
    assert.equal(calls.tags['property.id'], 'snake-pid');
  });

  it('lifts propertyId (camelCase) onto property.id tag', () => {
    const { scope, calls } = makeFakeScope();
    setPropertyContextOnScope(scope, { propertyId: 'camel-pid' });
    assert.equal(calls.tags['property.id'], 'camel-pid');
  });

  it('lifts both property_name and propertyName onto property.name tag', () => {
    const a = makeFakeScope();
    setPropertyContextOnScope(a.scope, { property_name: 'Comfort Suites' });
    assert.equal(a.calls.tags['property.name'], 'Comfort Suites');

    const b = makeFakeScope();
    setPropertyContextOnScope(b.scope, { propertyName: 'Hampton Inn' });
    assert.equal(b.calls.tags['property.name'], 'Hampton Inn');
  });

  it('lifts route onto a route tag', () => {
    const { scope, calls } = makeFakeScope();
    setPropertyContextOnScope(scope, { route: '/api/sms-reply' });
    assert.equal(calls.tags['route'], '/api/sms-reply');
  });

  it('sets a structured property context when id or name is present', () => {
    const { scope, calls } = makeFakeScope();
    setPropertyContextOnScope(scope, { pid: 'p1', property_name: 'Beaumont' });
    assert.deepEqual(calls.contexts['property'], { id: 'p1', name: 'Beaumont' });
  });

  it('ignores non-string values', () => {
    const { scope, calls } = makeFakeScope();
    setPropertyContextOnScope(scope, { pid: 12345, route: null });
    assert.equal(calls.tags['property.id'], undefined);
    assert.equal(calls.tags['route'], undefined);
  });

  it('ignores empty strings', () => {
    const { scope, calls } = makeFakeScope();
    setPropertyContextOnScope(scope, { pid: '', property_name: '' });
    assert.equal(calls.tags['property.id'], undefined);
    assert.equal(calls.tags['property.name'], undefined);
    // No id and no name → no structured context either.
    assert.equal(calls.contexts['property'], undefined);
  });

  it('returns null when no pid present', () => {
    const { scope } = makeFakeScope();
    const pid = setPropertyContextOnScope(scope, { route: '/foo' });
    assert.equal(pid, null);
  });
});
