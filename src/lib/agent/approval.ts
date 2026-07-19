// ─── AI-assistant approval flow: summaries and add-ons ─────────────────────
//
// SINGLE SOURCE OF TRUTH for the card COPY + deterministic add-ons a mutation
// tool needs that ISN'T its handler:
//
//   1. buildActionSummary(name, args, lang)  — the bilingual one-liner shown on
//      the card ("Send Maria Garcia this message: '…'").
//   2. ADDONS registry  — deterministic, non-model-driven extra actions a card
//      can offer (e.g. "also add this to Maria's to-do list").
//
// The approval TIER itself is NOT here — it lives on each tool's registry
// definition (`approval:` field in tools/*), the single source of truth read
// server-side via approvalTierFor() in tools.ts. This module only owns copy +
// add-ons so they can be reached from the route + tests WITHOUT importing every
// tool handler (which would pull supabaseAdmin, the Anthropic SDK, etc. into the
// test's module graph). The completeness test asserts "every mutates:true tool
// has a tier via the REGISTRY + a bespoke summary here" in one place.

import type { AppRole } from '@/lib/roles';

// Client-facing language for card copy. Matches the narrow `Language` type used
// across the manager UI (EN + ES); other housekeeper locales fall back to EN.
export type ApprovalLang = 'en' | 'es';

function pickLang(lang: string | undefined): ApprovalLang {
  return lang === 'es' ? 'es' : 'en';
}

// ─── Summary builders ────────────────────────────────────────────────────────
// A human-readable one-liner per tool, EN + ES, describing what approving the
// card will do. Kept deliberately short — it's the card's title. Falls back to
// a generic "Run <tool>" line for any tool without a bespoke builder so a new
// mutation tool never renders a blank card.

type ArgRecord = Record<string, unknown>;

function str(v: unknown): string {
  if (v === null || v === undefined) return '';
  return String(v).trim();
}

/** Quote + truncate a free-text field for inline display in a one-liner. */
function quoted(v: unknown, max = 120): string {
  const s = str(v);
  if (!s) return '';
  const clipped = s.length > max ? s.slice(0, max).trimEnd() + '…' : s;
  return `“${clipped}”`;
}

type SummaryBuilder = (args: ArgRecord, lang: ApprovalLang) => string;

const SUMMARIES: Record<string, SummaryBuilder> = {
  mark_room_clean: (a, l) =>
    l === 'es' ? `Marcar la habitación ${str(a.roomNumber)} como limpia` : `Mark room ${str(a.roomNumber)} clean`,
  reset_room: (a, l) =>
    l === 'es' ? `Restablecer la habitación ${str(a.roomNumber)} a sucia` : `Reset room ${str(a.roomNumber)} to dirty`,
  toggle_dnd: (a, l) => {
    const on = a.on === true || str(a.on) === 'true';
    if (l === 'es') return on ? `Activar No Molestar en la habitación ${str(a.roomNumber)}` : `Quitar No Molestar de la habitación ${str(a.roomNumber)}`;
    return on ? `Turn on Do-Not-Disturb for room ${str(a.roomNumber)}` : `Clear Do-Not-Disturb on room ${str(a.roomNumber)}`;
  },
  flag_issue: (a, l) =>
    l === 'es'
      ? `Reportar un problema en la habitación ${str(a.roomNumber)}: ${quoted(a.note)}`
      : `Flag an issue in room ${str(a.roomNumber)}: ${quoted(a.note)}`,
  request_help: (a, l) => {
    const room = str(a.roomNumber);
    if (l === 'es') return room ? `Pedir ayuda al gerente para la habitación ${room}` : `Pedir ayuda al gerente`;
    return room ? `Ask the manager for help with room ${room}` : `Ask the manager for help`;
  },
  log_reading: (a, l) =>
    l === 'es' ? `Registrar lectura: ${str(a.metric)} = ${str(a.value)}` : `Log reading: ${str(a.metric)} = ${str(a.value)}`,
  log_pm_check: (a, l) => {
    const status = str(a.status) === 'fail' ? (l === 'es' ? 'FALLÓ' : 'FAIL') : (l === 'es' ? 'aprobado' : 'pass');
    return l === 'es'
      ? `Registrar revisión de ${str(a.equipment)} (${status})`
      : `Record ${str(a.equipment)} check (${status})`;
  },
  log_found_item: (a, l) => {
    const where = str(a.roomOrLocation);
    if (l === 'es') return `Registrar objeto encontrado: ${quoted(a.itemDescription)}${where ? ` en ${where}` : ''}`;
    return `Log found item: ${quoted(a.itemDescription)}${where ? ` in ${where}` : ''}`;
  },
  remember: (a, l) =>
    l === 'es' ? `Recordar esta nota: ${quoted(a.content)}` : `Remember this note: ${quoted(a.content)}`,
  forget: (a, l) =>
    l === 'es' ? `Olvidar la nota "${str(a.topic)}"` : `Forget the note "${str(a.topic)}"`,

  assign_room: (a, l) =>
    l === 'es'
      ? `Asignar la habitación ${str(a.roomNumber)} a ${str(a.staffName)}`
      : `Assign room ${str(a.roomNumber)} to ${str(a.staffName)}`,
  decide_time_off: (a, l) => {
    const approve = str(a.decision) === 'approve';
    if (l === 'es') return `${approve ? 'Aprobar' : 'Rechazar'} el tiempo libre de ${str(a.staffName)}${a.date ? ` (${str(a.date)})` : ''}`;
    return `${approve ? 'Approve' : 'Deny'} ${str(a.staffName)}'s time off${a.date ? ` (${str(a.date)})` : ''}`;
  },
  log_complaint: (a, l) => {
    const room = str(a.roomNumber);
    if (l === 'es') return `Registrar una queja${room ? ` de la habitación ${room}` : ''}: ${quoted(a.description)}`;
    return `Log a guest complaint${room ? ` for room ${room}` : ''}: ${quoted(a.description)}`;
  },
  send_message: (a, l) =>
    l === 'es'
      ? `Enviar a ${str(a.recipient)} este mensaje: ${quoted(a.message)}`
      : `Send ${str(a.recipient)} this message: ${quoted(a.message)}`,
  create_todo: (a, l) => {
    const who = str(a.assignee) || str(a.department);
    if (l === 'es') return `Agregar tarea: ${quoted(a.title)}${who ? ` (para ${who})` : ''}`;
    return `Add to-do: ${quoted(a.title)}${who ? ` (for ${who})` : ''}`;
  },
  add_logbook_entry: (a, l) =>
    l === 'es' ? `Agregar al libro de registro: ${quoted(a.title)}` : `Add a log book entry: ${quoted(a.title)}`,
  post_announcement: (a, l) =>
    l === 'es' ? `Publicar un aviso para todo el personal: ${quoted(a.message)}` : `Post an announcement to all staff: ${quoted(a.message)}`,

  remove_from_shift: (a, l) =>
    l === 'es'
      ? `Dar el día libre a ${str(a.staffName)} el ${str(a.date)} (quitar su turno)`
      : `Give ${str(a.staffName)} ${str(a.date)} off (remove their shift)`,
  assign_shift: (a, l) => {
    const start = str(a.startTime);
    const end = str(a.endTime);
    const hours = start && end ? ` (${start}–${end})` : '';
    return l === 'es'
      ? `Programar a ${str(a.staffName)} el ${str(a.date)}${hours}`
      : `Schedule ${str(a.staffName)} on ${str(a.date)}${hours}`;
  },

  adjust_stock: (a, l) => {
    const item = str(a.itemName);
    const hasCount = a.newCount !== undefined && a.newCount !== null && str(a.newCount) !== '';
    const ordered = a.markOrdered === true || str(a.markOrdered) === 'true';
    if (l === 'es') {
      const parts = [] as string[];
      if (hasCount) parts.push(`ajustar el conteo de ${item} a ${str(a.newCount)}`);
      if (ordered) parts.push(`marcar ${item} como pedido`);
      return parts.length ? parts.join(' y ') : `Actualizar el inventario de ${item}`;
    }
    const parts = [] as string[];
    if (hasCount) parts.push(`set ${item} count to ${str(a.newCount)}`);
    if (ordered) parts.push(`mark ${item} as ordered`);
    return parts.length ? parts.join(' and ') : `Update ${item} inventory`;
  },

  create_reminder: (a, l) => {
    const who = str(a.recipient) || str(a.department);
    const when = formatFireAt(a.fireAt, l);
    if (l === 'es') return `Programar un recordatorio${who ? ` para ${who}` : ''}${when ? ` el ${when}` : ''}: ${quoted(a.body)}`;
    return `Schedule a reminder${who ? ` for ${who}` : ''}${when ? ` at ${when}` : ''}: ${quoted(a.body)}`;
  },
  cancel_reminder: (_a, l) =>
    l === 'es' ? 'Cancelar este recordatorio' : 'Cancel this reminder',

  create_recurring_todo: (a, l) => {
    const who = str(a.assignee) || str(a.department);
    const cadence = formatCadence(a.cadence, a.weekday, l);
    if (l === 'es') return `Crear tarea recurrente (${cadence}): ${quoted(a.title)}${who ? ` — para ${who}` : ''}`;
    return `Create a recurring to-do (${cadence}): ${quoted(a.title)}${who ? ` — for ${who}` : ''}`;
  },
  stop_recurring_todo: (_a, l) =>
    l === 'es' ? 'Detener esta tarea recurrente' : 'Stop this recurring to-do',
};

/** Best-effort short local time for a reminder's fireAt (drops to '' if we can't
 *  parse it, so the summary stays clean). Uses the app timezone for display. */
function formatFireAt(v: unknown, l: ApprovalLang): string {
  const s = str(v);
  if (!s) return '';
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return '';
  try {
    return new Intl.DateTimeFormat(l === 'es' ? 'es-US' : 'en-US', {
      timeZone: 'America/Chicago',
      month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
    }).format(d);
  } catch {
    return '';
  }
}

/** Human cadence label for a recurring to-do summary. */
function formatCadence(cadence: unknown, weekday: unknown, l: ApprovalLang): string {
  const c = str(cadence).toLowerCase();
  const days = l === 'es'
    ? ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado']
    : ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const wd = Number(weekday);
  if (c === 'weekly') {
    const label = Number.isInteger(wd) && wd >= 0 && wd <= 6 ? days[wd] : '';
    if (l === 'es') return label ? `cada ${label}` : 'semanal';
    return label ? `every ${label}` : 'weekly';
  }
  if (c === 'weekdays') return l === 'es' ? 'días laborables' : 'weekdays';
  return l === 'es' ? 'diario' : 'daily';
}

/**
 * Build the card's one-liner for a proposed action. Bilingual; falls back to a
 * generic line so a brand-new mutation tool never renders an empty card.
 */
export function buildActionSummary(
  toolName: string,
  args: unknown,
  lang: string | undefined,
): string {
  const l = pickLang(lang);
  const a = (args && typeof args === 'object' ? args : {}) as ArgRecord;
  const builder = SUMMARIES[toolName];
  if (builder) return builder(a, l);
  return l === 'es' ? `Ejecutar ${toolName}` : `Run ${toolName}`;
}

// ─── Add-ons ─────────────────────────────────────────────────────────────────
// Deterministic extra actions a card can offer via a checkbox. These are NOT
// model-driven: the model proposes the primary tool; the human opts into an
// add-on; the resolve route runs it AFTER the primary action succeeds, using the
// primary result + args (never new free-text from the model).
//
// Keyed by tool name so more can be added later without touching the route. Each
// entry declares the checkbox label (EN + ES) and a run() that receives the
// context the route can safely provide.

export interface AddonRunContext {
  propertyId: string;
  /** The caller's staff id (task creator). May be null for staffless admins. */
  callerStaffId: string | null;
  /** The validated args that were executed for the primary action. */
  args: Record<string, unknown>;
  /** The primary tool's ok payload (e.g. { messageId, ... }). */
  primaryResult: unknown;
  /** The caller's role — for any add-on that wants to gate itself. */
  role: AppRole;
}

export interface AddonDefinition {
  /** Stable id sent from the client when the checkbox is ticked. */
  id: string;
  /** Bilingual checkbox label. `ctx`-free — computed from args at card-build. */
  label: (args: Record<string, unknown>, lang: ApprovalLang) => { en: string; es: string };
  /**
   * Run the add-on. Returns a short human-readable note on success, or throws
   * on failure (the route swallows + reports add-on failures separately so a
   * failed add-on never rolls back the primary action).
   */
  run: (ctx: AddonRunContext) => Promise<{ note: string }>;
}

// The registry is populated lazily from comms-actions.ts (which owns createTask)
// to avoid a circular import (approval.ts is imported by the tool registry). We
// expose register/get here and let the tool module wire in its concrete runs.
const ADDONS: Record<string, AddonDefinition[]> = {};

export function registerAddon(toolName: string, addon: AddonDefinition): void {
  const list = ADDONS[toolName] ?? (ADDONS[toolName] = []);
  // Idempotent: HMR / double-import must not duplicate.
  if (!list.some((a) => a.id === addon.id)) list.push(addon);
}

/** All add-ons available for a tool (may be empty). */
export function addonsForTool(toolName: string): AddonDefinition[] {
  return ADDONS[toolName] ?? [];
}

/** Look up a single add-on by tool + id (used by the resolve route). */
export function findAddon(toolName: string, addonId: string): AddonDefinition | null {
  return (ADDONS[toolName] ?? []).find((a) => a.id === addonId) ?? null;
}

/**
 * The card metadata the client renders for a tool: its add-on ids + labels for
 * the current language. Shape is intentionally flat + serializable so it can
 * ride along in the `tool_call_pending_approval` SSE event.
 */
export function addonDescriptorsForCard(
  toolName: string,
  args: Record<string, unknown>,
  lang: string | undefined,
): Array<{ id: string; label: string }> {
  const l = pickLang(lang);
  return addonsForTool(toolName).map((a) => {
    const label = a.label(args, l);
    return { id: a.id, label: l === 'es' ? label.es : label.en };
  });
}
