import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { T } from '../../app/inventory/_components/tokens';

function relativeLuminance(hex: string): number {
  assert.match(hex, /^#[0-9a-f]{6}$/i, `expected a six-digit hex color, received ${hex}`);

  const channels = [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255);
  const [red, green, blue] = channels.map((channel) =>
    channel <= 0.04045
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4,
  );

  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrastRatio(foreground: string, background: string): number {
  const foregroundLuminance = relativeLuminance(foreground);
  const backgroundLuminance = relativeLuminance(background);
  const lighter = Math.max(foregroundLuminance, backgroundLuminance);
  const darker = Math.min(foregroundLuminance, backgroundLuminance);
  return (lighter + 0.05) / (darker + 0.05);
}

const capsSource = readFileSync(
  fileURLToPath(new URL('../../app/inventory/_components/Caps.tsx', import.meta.url)),
  'utf8',
);

describe('desktop inventory contrast contract', () => {
  test('secondary text meets WCAG AA contrast on the inventory background', () => {
    const ratio = contrastRatio(T.ink2, T.bg);
    assert.ok(ratio >= 4.5, `T.ink2 contrast is ${ratio.toFixed(2)}:1; expected at least 4.5:1`);
  });

  test('control boundaries meet non-text contrast on the inventory background', () => {
    const ratio = contrastRatio(T.controlBorder, T.bg);
    assert.ok(ratio >= 3, `T.controlBorder contrast is ${ratio.toFixed(2)}:1; expected at least 3:1`);
  });

  test('Caps defaults to the accessible desktop label treatment', () => {
    assert.match(capsSource, /\bweight\s*=\s*600\b/);
    assert.match(capsSource, /color:\s*color\s*\?\?\s*T\.ink2\b/);
  });
});
