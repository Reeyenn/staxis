import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { localizeKnownMessage } from '@/lib/localized-ui-message';

const messages = [
  ['Could not load settings', 'No se pudo cargar la configuración'],
] as const;

describe('localizeKnownMessage', () => {
  test('re-localizes either known variant without triggering new work', () => {
    assert.equal(
      localizeKnownMessage('Could not load settings', 'es', messages),
      'No se pudo cargar la configuración',
    );
    assert.equal(
      localizeKnownMessage('No se pudo cargar la configuración', 'en', messages),
      'Could not load settings',
    );
  });

  test('preserves opaque server messages and null state', () => {
    assert.equal(localizeKnownMessage('Request abc failed', 'es', messages), 'Request abc failed');
    assert.equal(localizeKnownMessage(null, 'es', messages), null);
  });
});
