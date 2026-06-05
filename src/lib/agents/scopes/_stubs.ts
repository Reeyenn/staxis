// ─── Declared-but-stubbed scopes ────────────────────────────────────────────
// Full registry entries NOW (so the wizard can offer them) with a service-role
// read that returns a placeholder. Chat 3 fills in the real reads for the
// templates that need them.

import { registerScope } from './registry';
import type { ScopeKey } from '@/lib/agents/types';

const STUBS: Array<{ key: ScopeKey; en: string; es: string }> = [
  { key: 'work_orders', en: 'Maintenance work orders', es: 'Órdenes de mantenimiento' },
  { key: 'inventory', en: 'Inventory levels', es: 'Niveles de inventario' },
  { key: 'complaints', en: 'Guest complaints', es: 'Quejas de huéspedes' },
];

for (const s of STUBS) {
  registerScope({
    key: s.key,
    label: { en: s.en, es: s.es },
    async read() {
      // TODO(Chat 3): implement a service-role read for this scope.
      return { unimplemented: true };
    },
  });
}
