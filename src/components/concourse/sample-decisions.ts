// Seed content for the Staxis approval queue — the three demo decisions from
// the Concourse handoff. Same footing as the current /feed sample cards:
// realistic Phase-1 content; wiring to the live agent_nudges queue is Phase 2.
//
// The pill-bar badge and the queue page share this count. The queue broadcasts
// count changes over a window event so the badge tracks approvals live without
// a store (both surfaces reset with the sample data on navigation, matching
// how the existing feed sample behaves).

export type DecisionDept = 'housekeeping' | 'inventory' | 'maintenance';

export interface SampleDecision {
  id: string;
  dept: DecisionDept;
  chip: 'sage' | 'rust' | 'caramel';
  dept_en: string; dept_es: string;
  title_en: string; title_es: string;
  sub_en: string; sub_es: string;
  no_en: string; no_es: string;
}

export const SAMPLE_DECISIONS: readonly SampleDecision[] = [
  {
    id: 'd1', dept: 'housekeeping', chip: 'sage',
    dept_en: 'Housekeeping', dept_es: 'Limpieza',
    title_en: 'Reassign 4 checkouts from Maria to Josefina',
    title_es: 'Reasignar 4 salidas de Maria a Josefina',
    sub_en: 'Maria called out sick at 6:42a. Josefina finishes her block by 12:30 and has capacity.',
    sub_es: 'Maria avisó que está enferma a las 6:42a. Josefina termina su bloque a las 12:30 y tiene capacidad.',
    no_en: 'Adjust', no_es: 'Ajustar',
  },
  {
    id: 'd2', dept: 'inventory', chip: 'rust',
    dept_en: 'Inventory', dept_es: 'Inventario',
    title_en: 'Order 3 cases of bath towels from HD Supply',
    title_es: 'Pedir 3 cajas de toallas de baño a HD Supply',
    sub_en: 'Projected to run out Friday. Vendor cutoff is 3:00p today — $118.40 total.',
    sub_es: 'Se agotarán el viernes. El límite del proveedor es hoy a las 3:00p — $118.40 en total.',
    no_en: 'Deny', no_es: 'Denegar',
  },
  {
    id: 'd3', dept: 'maintenance', chip: 'caramel',
    dept_en: 'Maintenance', dept_es: 'Mantenimiento',
    title_en: 'Schedule preventive maintenance — AC, Room 214',
    title_es: 'Programar mantenimiento preventivo — AC, habitación 214',
    sub_en: 'Compressor cycling 2.1× normal for 3 days. Suggested slot: Thu 10:00a, room vacant.',
    sub_es: 'El compresor cicla 2.1× lo normal desde hace 3 días. Horario sugerido: jueves 10:00a, habitación libre.',
    no_en: 'Snooze', no_es: 'Posponer',
  },
];

/** Window event the queue fires when a decision is approved/dismissed. */
export const QUEUE_COUNT_EVENT = 'staxis:queue-count';

export function broadcastQueueCount(pending: number) {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(QUEUE_COUNT_EVENT, { detail: { pending } }));
}
