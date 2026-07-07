// ═══════════════════════════════════════════════════════════════════════════
// Section registry — the single source of truth for the 8 per-hotel app
// sections and the default-ON resolver that gates them everywhere.
//
// One AppSection per top-nav tab. By DEFAULT every section is ON at every hotel;
// an admin (Live Hotels card) or the onboarding wizard turns a section OFF for a
// hotel by writing `false` into properties.enabled_sections. The whole safety
// mechanism is isSectionEnabled(): anything that is NOT an explicit `false`
// resolves to ON, so a hotel with NO stored value (every existing hotel) shows
// all 8 sections.
//
// This file is ISOMORPHIC — imported by the browser (Header, hooks), the server
// (API gates, crons, agent), and the row mapper. Keep it free of `server-only`
// and of any I/O.
// ═══════════════════════════════════════════════════════════════════════════

export const APP_SECTIONS = [
  'staxis',
  'dashboard',
  'housekeeping',
  'communications',
  'maintenance',
  'inventory',
  'staff',
  'financials',
] as const;
export type AppSection = (typeof APP_SECTIONS)[number];

/** Stored per-hotel map. Missing key / null / non-object all mean ALL ON. */
export type EnabledSections = Partial<Record<AppSection, boolean>> | null;

export function isAppSection(x: unknown): x is AppSection {
  return typeof x === 'string' && (APP_SECTIONS as readonly string[]).includes(x);
}

export interface SectionMeta {
  key: AppSection;
  /** The nav destination this section owns. */
  navHref: string;
  /** Path prefixes that belong to this section (drives sectionForPath). */
  routePrefixes: readonly string[];
  label_en: string;
  label_es: string;
  desc_en: string;
  desc_es: string;
}

// Ordered — drives the top nav, the admin Sections modal, and the onboarding
// picker so all three always show the same 8 in the same order.
export const SECTION_LIST: readonly SectionMeta[] = [
  { key: 'staxis',         navHref: '/feed',           routePrefixes: ['/feed'],           label_en: 'Staxis',         label_es: 'Staxis',        desc_en: 'The decision feed and AI copilot home',           desc_es: 'El panel de decisiones y el copiloto de IA' },
  { key: 'dashboard',      navHref: '/dashboard',      routePrefixes: ['/dashboard'],      label_en: 'Dashboard',      label_es: 'Panel',         desc_en: 'Live occupancy, KPIs, and what needs attention',  desc_es: 'Ocupación en vivo, KPIs y lo que requiere atención' },
  { key: 'housekeeping',   navHref: '/housekeeping',   routePrefixes: ['/housekeeping'],   label_en: 'Housekeeping',   label_es: 'Limpieza',      desc_en: 'Room board, assignments, schedule, and quality',  desc_es: 'Tablero de habitaciones, asignaciones, horario y calidad' },
  { key: 'communications', navHref: '/communications', routePrefixes: ['/communications'], label_en: 'Communications', label_es: 'Comunicación',  desc_en: 'Messages, log book, calendar, and announcements', desc_es: 'Mensajes, bitácora, calendario y anuncios' },
  { key: 'maintenance',    navHref: '/maintenance',    routePrefixes: ['/maintenance'],    label_en: 'Maintenance',    label_es: 'Mantenimiento', desc_en: 'Work orders and preventive maintenance',          desc_es: 'Órdenes de trabajo y mantenimiento preventivo' },
  { key: 'inventory',      navHref: '/inventory',      routePrefixes: ['/inventory'],      label_en: 'Inventory',      label_es: 'Inventario',    desc_en: 'Supplies, counts, reorders, and vendors',         desc_es: 'Suministros, conteos, pedidos y proveedores' },
  { key: 'staff',          navHref: '/staff',          routePrefixes: ['/staff'],          label_en: 'Staff',          label_es: 'Personal',      desc_en: 'Team, scheduling, and performance',               desc_es: 'Equipo, horarios y desempeño' },
  { key: 'financials',     navHref: '/financials',     routePrefixes: ['/financials'],     label_en: 'Financials',     label_es: 'Finanzas',      desc_en: 'Checkbook, budget, revenue, and profit',          desc_es: 'Chequera, presupuesto, ingresos y ganancias' },
];

/** O(1) lookup by key. */
export const SECTION_META: Record<AppSection, SectionMeta> = Object.fromEntries(
  SECTION_LIST.map((m) => [m.key, m]),
) as Record<AppSection, SectionMeta>;

// ── THE CONTRACT ─────────────────────────────────────────────────────────────
// The entire default-ON safety mechanism lives here. null / undefined /
// non-object / missing key / any non-false value ⇒ ENABLED. ONLY an explicit
// boolean `false` disables a section. NEVER write `flags[x] === true` anywhere —
// that would render every section OFF for the many hotels with no stored map.
export function isSectionEnabled(flags: EnabledSections | undefined, section: AppSection): boolean {
  if (flags == null || typeof flags !== 'object' || Array.isArray(flags)) return true;
  return (flags as Record<string, unknown>)[section] !== false;
}

/** Full resolved 8-key map (every missing key coerced to its default-ON value).
 *  Used to hydrate the admin/onboarding toggle grids and as the canonical write
 *  shape so a stored map is always complete. */
export function resolveSections(flags: EnabledSections | undefined): Record<AppSection, boolean> {
  const out = {} as Record<AppSection, boolean>;
  for (const s of APP_SECTIONS) out[s] = isSectionEnabled(flags, s);
  return out;
}

/** Defensive normalizer for a value read from jsonb: accepts an object, a
 *  JSON-encoded string, or null. Anything unparseable ⇒ null (⇒ all ON). Shared
 *  by the row mapper (client) and the server reader so both fail-soft identically. */
export function normalizeSectionFlags(raw: unknown): EnabledSections {
  if (raw == null) return null;
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as EnabledSections)
        : null;
    } catch {
      return null;
    }
  }
  return typeof raw === 'object' && !Array.isArray(raw) ? (raw as EnabledSections) : null;
}

/** Reverse route → section. startsWith prefix match so /inventory/ai still maps
 *  to inventory. Non-section paths (/settings, /admin, /onboard, /demo/*, …)
 *  return null and are NEVER gated. */
export function sectionForPath(pathname: string | null | undefined): AppSection | null {
  if (!pathname) return null;
  for (const meta of SECTION_LIST) {
    for (const prefix of meta.routePrefixes) {
      if (pathname === prefix || pathname.startsWith(prefix + '/')) return meta.key;
    }
  }
  return null;
}

/** Validate + normalize an incoming write payload into a full 8-key boolean map
 *  (the canonical stored shape). Rejects unknown keys and non-boolean values so
 *  neither write surface (admin POST / onboarding PATCH) can persist garbage.
 *  Missing keys default to ON (true). */
export function parseSectionFlags(
  input: unknown,
): { ok: true; value: Record<AppSection, boolean> } | { ok: false; error: string } {
  if (input == null || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, error: 'sections must be an object' };
  }
  const obj = input as Record<string, unknown>;
  for (const [k, v] of Object.entries(obj)) {
    if (!isAppSection(k)) return { ok: false, error: `unknown section: ${k}` };
    if (typeof v !== 'boolean') return { ok: false, error: `section ${k} must be true or false` };
  }
  const value = {} as Record<AppSection, boolean>;
  for (const s of APP_SECTIONS) value[s] = obj[s] !== false;
  return { ok: true, value };
}
