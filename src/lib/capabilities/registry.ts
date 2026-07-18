// ═══════════════════════════════════════════════════════════════════════════
// Capability registry — the single source of truth for per-hotel access control.
//
// One CAPABILITY_KEY per gateable hotel feature/action. By DEFAULT every hotel
// role gets every hotel-facing capability at every hotel (ROLE_DEFAULTS below).
// An admin RESTRICTS a capability for a role at a specific hotel from the Access
// tab, which writes an `allowed = false` row into `capability_overrides`. The
// only permanent exceptions are admin-only capabilities (Staxis-internal): they
// stay `admin`-only and are NEVER grantable to a hotel role by any override.
//
// This file is isomorphic — imported by both the browser (useCan) and the
// server (canForProperty). Keep it free of `server-only` and of any I/O.
// ═══════════════════════════════════════════════════════════════════════════

import type { AppRole } from '@/lib/roles';

// ── Hotel roles (the Access-grid columns) ────────────────────────────────────
//
// The 5 hotel-facing roles an admin can restrict. `admin` is Staxis-internal and
// is never a column. `staff` is the legacy alias — the resolver treats it like
// any other hotel role for defaults (everyone-everything) but it is never shown
// as a column nor written as an override.
export const HOTEL_ROLES = [
  'owner',
  'general_manager',
  'front_desk',
  'housekeeping',
  'maintenance',
] as const;
export type HotelRole = (typeof HOTEL_ROLES)[number];

export function isHotelRole(s: unknown): s is HotelRole {
  return typeof s === 'string' && (HOTEL_ROLES as readonly string[]).includes(s);
}

// Roles that ROLE_DEFAULTS grants every non-admin-only capability to. Includes
// the legacy `staff` so a stray legacy account still gets the everyone-default.
const DEFAULT_GRANTED_ROLES: readonly AppRole[] = [...HOTEL_ROLES, 'admin', 'staff'];

// Manager tier. The default grant for sensitive capabilities (account/credential
// management AND money / pay / audit-history / PMS-settings — see
// MANAGER_FLOOR_CAPABILITIES) that must NEVER fall to line staff even under the
// everyone-everything default — otherwise a housekeeper could reset the owner's
// password, read the payroll, or open the books. (Security audit 2026-06-18,
// extended pre-onboarding 2026-06-26.)
const MANAGER_ROLES: readonly AppRole[] = ['owner', 'general_manager', 'admin'];

// ── Capability keys ──────────────────────────────────────────────────────────

export const CAPABILITY_KEYS = [
  // money
  'view_financials',
  'view_wages',
  // operations
  'manage_inventory_orders',
  'assign_work',
  'manage_equipment',
  // front desk
  'use_lost_and_found',
  'use_complaints',
  // comms & content
  'post_announcements',
  'manage_knowledge',
  // team & settings
  'manage_team',
  'manage_users',
  'manage_settings',
  'manage_notifications',
  'run_reports',
  'manage_checklists',
  'manage_shifts',
  'manage_clean_times',
  'view_activity_log',
  // admin-only (locked — never grantable to a hotel role)
  'access_admin',
  'manage_pms_coverage',
] as const;
export type CapabilityKey = (typeof CAPABILITY_KEYS)[number];

export function isCapabilityKey(s: unknown): s is CapabilityKey {
  return typeof s === 'string' && (CAPABILITY_KEYS as readonly string[]).includes(s);
}

// ── Grouping (Access-grid section headers, in display order) ──────────────────

export const CAPABILITY_GROUPS = [
  'money',
  'operations',
  'front_desk',
  'comms',
  'team_settings',
  'admin',
] as const;
export type CapabilityGroup = (typeof CAPABILITY_GROUPS)[number];

export const GROUP_LABELS: Record<CapabilityGroup, { en: string; es: string }> = {
  money: { en: 'Money', es: 'Dinero' },
  operations: { en: 'Operations', es: 'Operaciones' },
  front_desk: { en: 'Front desk', es: 'Recepción' },
  comms: { en: 'Communication & content', es: 'Comunicación y contenido' },
  team_settings: { en: 'Team & settings', es: 'Equipo y configuración' },
  admin: { en: 'Staxis admin (always you)', es: 'Administración Staxis (siempre tú)' },
};

// ── Per-capability metadata ──────────────────────────────────────────────────

export interface CapabilityMeta {
  key: CapabilityKey;
  /** Staxis-internal. Defaults to admin only and is never grantable to a hotel role. */
  adminOnly: boolean;
  /** Roles granted this capability BY DEFAULT (no override). Omit → everyone-default
   *  (all hotel roles + admin). Set to the manager tier for dangerous account /
   *  credential-management capabilities so the everyone-everything default never
   *  hands them to line staff. */
  defaultRoles?: readonly AppRole[];
  /** Honours dept-scope (managers reach all, staff reach own dept). Reserved for
   *  per-department content gating (e.g. Documents) — not used by the binary gates yet. */
  deptScoped: boolean;
  group: CapabilityGroup;
  label_en: string;
  label_es: string;
  /** One-line "what this controls", shown under the row label in the grid. */
  desc_en: string;
  desc_es: string;
}

// Ordered list — drives the grid. CAPABILITY_META (below) is the O(1) lookup.
export const CAPABILITY_LIST: readonly CapabilityMeta[] = [
  {
    key: 'view_financials', adminOnly: false, deptScoped: false, group: 'money',
    defaultRoles: MANAGER_ROLES,
    label_en: 'Financials', label_es: 'Finanzas',
    desc_en: 'Checkbook, budget, CapEx, revenue & profit', desc_es: 'Chequera, presupuesto, CapEx, ingresos y ganancias',
  },
  {
    key: 'view_wages', adminOnly: false, deptScoped: false, group: 'money',
    defaultRoles: MANAGER_ROLES,
    label_en: 'Wages & labor cost', label_es: 'Salarios y costo laboral',
    desc_en: 'Hourly pay, wage settings, labor-cost % tile', desc_es: 'Pago por hora, salarios, % de costo laboral',
  },
  {
    // 2026-07-18: the purchase-order flow was removed; this capability now
    // gates deliveries (typed-in + invoice scan), vendors, and the inventory
    // tab/budget config. Key kept for stored overrides; labels updated to
    // match what it actually unlocks.
    key: 'manage_inventory_orders', adminOnly: false, deptScoped: false, group: 'operations',
    label_en: 'Inventory deliveries & vendors', label_es: 'Entregas y proveedores',
    desc_en: 'Add deliveries, scan invoices, manage vendors', desc_es: 'Agregar entregas, escanear facturas, gestionar proveedores',
  },
  {
    key: 'assign_work', adminOnly: false, deptScoped: false, group: 'operations',
    label_en: 'Assign housekeeping work', label_es: 'Asignar trabajo de limpieza',
    desc_en: 'Assign, reassign & auto-balance rooms to crew', desc_es: 'Asignar, reasignar y balancear habitaciones',
  },
  {
    key: 'manage_equipment', adminOnly: false, deptScoped: false, group: 'operations',
    label_en: 'Equipment & PM schedules', label_es: 'Equipos y mantenimiento preventivo',
    desc_en: 'Create / edit equipment & preventive-maintenance tasks', desc_es: 'Crear / editar equipos y tareas preventivas',
  },
  {
    key: 'use_lost_and_found', adminOnly: false, deptScoped: false, group: 'front_desk',
    label_en: 'Lost & Found', label_es: 'Objetos perdidos',
    desc_en: 'Log and track found items', desc_es: 'Registrar y rastrear objetos perdidos',
  },
  {
    key: 'use_complaints', adminOnly: false, deptScoped: false, group: 'front_desk',
    label_en: 'Complaints', label_es: 'Quejas',
    desc_en: 'Log guest complaints and service recovery', desc_es: 'Registrar quejas y recuperación de servicio',
  },
  {
    key: 'post_announcements', adminOnly: false, deptScoped: false, group: 'comms',
    label_en: 'Post announcements', label_es: 'Publicar anuncios',
    desc_en: 'Send hotel-wide announcements & notices', desc_es: 'Enviar anuncios y avisos para todo el hotel',
  },
  {
    key: 'manage_knowledge', adminOnly: false, deptScoped: false, group: 'comms',
    label_en: 'Knowledge base', label_es: 'Base de conocimiento',
    desc_en: 'Create / edit SOPs, documents, contacts', desc_es: 'Crear / editar SOPs, documentos, contactos',
  },
  {
    key: 'manage_team', adminOnly: false, deptScoped: false, group: 'team_settings',
    defaultRoles: MANAGER_ROLES,
    label_en: 'Team & accounts', label_es: 'Equipo y cuentas',
    desc_en: 'Invite staff, join codes, account list', desc_es: 'Invitar personal, códigos de acceso, cuentas',
  },
  {
    key: 'manage_users', adminOnly: false, deptScoped: false, group: 'team_settings',
    defaultRoles: MANAGER_ROLES,
    label_en: 'Users & roles', label_es: 'Usuarios y roles',
    desc_en: 'Change who has access and their role', desc_es: 'Cambiar quién tiene acceso y su rol',
  },
  {
    key: 'manage_settings', adminOnly: false, deptScoped: false, group: 'team_settings',
    defaultRoles: MANAGER_ROLES,
    label_en: 'Hotel & PMS settings', label_es: 'Configuración del hotel y PMS',
    desc_en: "Edit the hotel's PMS connection settings", desc_es: 'Editar la conexión PMS del hotel',
  },
  {
    key: 'manage_notifications', adminOnly: false, deptScoped: false, group: 'team_settings',
    label_en: 'Notifications', label_es: 'Notificaciones',
    desc_en: 'Report delivery & notification preferences', desc_es: 'Entrega de informes y preferencias de notificación',
  },
  {
    key: 'run_reports', adminOnly: false, deptScoped: false, group: 'team_settings',
    defaultRoles: MANAGER_ROLES,
    label_en: 'Reports', label_es: 'Informes',
    desc_en: 'Run, export & schedule reports', desc_es: 'Ejecutar, exportar y programar informes',
  },
  {
    key: 'manage_checklists', adminOnly: false, deptScoped: false, group: 'team_settings',
    label_en: 'Checklists', label_es: 'Listas de verificación',
    desc_en: 'Create / edit cleaning & inspection checklists', desc_es: 'Crear / editar listas de limpieza e inspección',
  },
  {
    key: 'manage_shifts', adminOnly: false, deptScoped: false, group: 'team_settings',
    label_en: 'Shifts', label_es: 'Turnos',
    desc_en: 'Shift templates & presets', desc_es: 'Plantillas y ajustes de turnos',
  },
  {
    key: 'manage_clean_times', adminOnly: false, deptScoped: false, group: 'team_settings',
    label_en: 'Clean-time standards', label_es: 'Estándares de tiempo de limpieza',
    desc_en: 'Standard cleaning minutes per room type', desc_es: 'Minutos estándar de limpieza por tipo',
  },
  {
    key: 'view_activity_log', adminOnly: false, deptScoped: false, group: 'team_settings',
    defaultRoles: MANAGER_ROLES,
    label_en: 'Activity log', label_es: 'Registro de actividad',
    desc_en: 'Searchable audit timeline of changes', desc_es: 'Línea de tiempo de auditoría de cambios',
  },
  {
    key: 'access_admin', adminOnly: true, deptScoped: false, group: 'admin',
    label_en: 'Staxis admin console', label_es: 'Consola de administración Staxis',
    desc_en: 'The /admin operations surface (this tab included)', desc_es: 'La consola /admin (incluida esta pestaña)',
  },
  {
    key: 'manage_pms_coverage', adminOnly: true, deptScoped: false, group: 'admin',
    label_en: 'PMS coverage mapping', label_es: 'Mapeo de cobertura PMS',
    desc_en: 'PMS recipe & feed configuration', desc_es: 'Configuración de recetas y feeds PMS',
  },
];

export const CAPABILITY_META: Record<CapabilityKey, CapabilityMeta> = Object.fromEntries(
  CAPABILITY_LIST.map((m) => [m.key, m]),
) as Record<CapabilityKey, CapabilityMeta>;

/** Capabilities that are Staxis-internal and never grantable to a hotel role. */
export const ADMIN_ONLY_CAPABILITIES: ReadonlySet<CapabilityKey> = new Set(
  CAPABILITY_LIST.filter((m) => m.adminOnly).map((m) => m.key),
);

export function isAdminOnlyCapability(cap: CapabilityKey): boolean {
  return ADMIN_ONLY_CAPABILITIES.has(cap);
}

// ── Manager-floor capabilities ───────────────────────────────────────────────
//
// Sensitive hotel-facing capabilities that are MANAGER-TIER ONLY (owner / GM /
// admin) and OVERRIDE-PROOF: a per-hotel `allowed:true` override can never grant
// them to line staff (front_desk / housekeeping / maintenance / legacy staff).
// This is the HARD floor — the resolver (can() step b.5) enforces it BEFORE the
// override check, so it cannot be lifted by any toggle. It pairs with each cap's
// `defaultRoles: MANAGER_ROLES` (the soft default floor) for defense in depth.
//
//   - manage_team / manage_users — account & credential management (a housekeeper
//     resetting the owner's password is catastrophic). (Security audit 2026-06-18.)
//   - view_wages / view_financials — payroll, revenue, budgets, CapEx.
//   - view_activity_log — the full searchable/exportable audit history.
//   - manage_settings — the hotel's PMS connection / credentials surface.
//     (Pre-onboarding lockdown 2026-06-26.)
//   - run_reports — the self-serve report hub embeds money (inventory spend,
//     budgets) and the activity-log audit timeline, so it's manager-only too.
//     (Pre-onboarding access cleanup 2026-06-26.)
//
// Derived from each meta's `defaultRoles === MANAGER_ROLES` so it can never drift
// from the registry (manage_* and the sensitive view caps all carry that floor).
export const MANAGER_FLOOR_CAPABILITIES: ReadonlySet<CapabilityKey> = new Set(
  CAPABILITY_LIST.filter((m) => !m.adminOnly && m.defaultRoles === MANAGER_ROLES).map((m) => m.key),
);

export function isManagerFloorCapability(cap: CapabilityKey): boolean {
  return MANAGER_FLOOR_CAPABILITIES.has(cap);
}

// Every hotel-facing capability is live — its gates consult the resolver, so an
// Access-tab toggle takes effect immediately (default: every role gets it; an
// admin switches a role OFF per hotel). Only the admin-only Staxis-internal caps
// are never toggleable (they render as a locked row).
export function isLiveCapability(cap: CapabilityKey): boolean {
  return !isAdminOnlyCapability(cap);
}

// ── ROLE_DEFAULTS ────────────────────────────────────────────────────────────
//
// Every non-admin-only capability → all hotel roles + admin (+ legacy staff).
// Admin-only caps → admin only. Computed from the metadata so it can never drift
// from the adminOnly flags above.
export const ROLE_DEFAULTS: Record<CapabilityKey, readonly AppRole[]> = Object.fromEntries(
  CAPABILITY_LIST.map((m) => [m.key, m.adminOnly ? (['admin'] as const) : (m.defaultRoles ?? DEFAULT_GRANTED_ROLES)]),
) as Record<CapabilityKey, readonly AppRole[]>;
