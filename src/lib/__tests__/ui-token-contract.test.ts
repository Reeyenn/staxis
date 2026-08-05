import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CONCOURSE_COLORS,
  CONCOURSE_FONTS,
  UI_FOCUS,
  UI_RADII,
  UI_SHADOWS,
} from '@/app/_components/ui/tokens';

describe('shared light-surface token contract', () => {
  test('keeps the existing Concourse palette and type stacks', () => {
    assert.equal(CONCOURSE_COLORS.paper, '#FFFFFF');
    assert.equal(CONCOURSE_COLORS.ink, '#1F231C');
    assert.equal(CONCOURSE_COLORS.ink2, '#5C625C');
    assert.equal(CONCOURSE_COLORS.sageDeep, '#5C7A60');
    assert.equal(CONCOURSE_COLORS.warm, '#B85C3D');
    assert.equal(CONCOURSE_FONTS.sans, 'var(--font-geist), -apple-system, BlinkMacSystemFont, sans-serif');
    assert.equal(CONCOURSE_FONTS.mono, 'var(--font-geist-mono), ui-monospace, monospace');
  });

  test('pins shared geometry, shadow, and keyboard-focus treatment', () => {
    assert.equal(UI_RADII.card, 18);
    assert.equal(UI_RADII.pill, 999);
    assert.equal(UI_SHADOWS.card, '0 6px 16px -14px rgba(31,42,32,0.35)');
    assert.equal(UI_FOCUS.ring, '#5C7A60');
  });
});
