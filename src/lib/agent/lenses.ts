// ─── WHO LENSES: what the chat is, per hat ─────────────────────────────────
//
// One chat, one route, one tool registry, one loop. What changes between a GM
// and a front-desk agent is not the machinery — it is WHICH TOOLS MOUNT and
// WHAT THE MODEL IS TOLD ITS JOB IS. That pair is a "lens", and this file is
// the whole of it: a table you can read top to bottom and answer "what can this
// person ask Staxis?" without opening twenty other files.
//
// Why a table and not twenty `allowedRoles` edits:
//
//   `allowedRoles` answers "may this role ever reach this tool", scattered
//   across the catalog one tool at a time. It cannot answer the product
//   question — "what is the front desk's Staxis FOR" — because that answer is
//   spread over nineteen files and nobody has ever seen it written down. The
//   result, before this file existed, was a front-desk person whose chat quietly
//   inherited the manager's system prompt (prompts-store mapped front_desk →
//   general_manager) listing tools they could not call, and a maintenance tech
//   whose chat could read every room in the hotel and not one work order.
//
// THE NARROWING RULE. A lens can only ever REMOVE. `getToolsForRole` intersects
// the lens list with the tool's own `allowedRoles`, so a name in `tools` that
// the tool itself refuses stays refused. A lens is not a grant; it is a
// keyhole. `executeTool` enforces the same intersection a second time, the way
// every other gate in this registry is enforced twice, so a stale tool list
// cannot smuggle a tool past the mount.
//
// SCOPE: the CHAT surface only. Voice, walkthrough and portfolio have their own
// surface gates and are untouched — a lens narrowing the portfolio catalog by
// hotel role would be a category error, since the portfolio surface answers for
// a company, not a hat at one hotel.
//
// WHICH ROLE. The lens keys on the role the caller HAS AT THIS HOTEL — the
// spine's `effectiveRole` — not on their global `accounts.role`. Maria who is a
// GM at one hotel and wears a maintenance hat at another gets the manager's
// chat at the first and the wrench's chat at the second, in the same session,
// because the route resolves the hat per property before it builds the mount.

import type { AppRole } from '@/lib/roles';
import type { AgentSurface } from './tools';

/**
 * A lens: what mounts for one hat, and what the model is told about it.
 *
 * `prompt` REPLACES the role prompt for this hat rather than layering on top of
 * it. Layering was tried on paper and is wrong: the DB prompt row a front-desk
 * person would otherwise get is the MANAGER's, and an addendum saying "ignore
 * the manager tools listed above" leaves the model holding two contradictory
 * job descriptions and picking one. There is no editable `agent_prompts` row
 * for 'front_desk' or 'maintenance' — the CHECK constraint has never had those
 * values — so nothing operator-owned is lost by owning this text in code.
 */
export interface ChatLens {
  /**
   * False = this hat has NO Ask Staxis at all. Not an empty tool list, not a
   * polite refusal — the bar does not render, the route refuses, and the
   * catalog is empty. Housekeepers are the only such hat, and it is a product
   * rule, not a capability judgement: a housekeeper's job is rooms, and the
   * standing rule is that Staxis never adds a step to it.
   */
  mounted: boolean;
  /** Stamped into agent_messages.prompt_version as the role segment. */
  promptVersion: string;
  /** The role prompt for this hat. Empty when `mounted` is false. */
  prompt: string;
  /**
   * The chat tool allowlist for this hat, by wire name. INTERSECTED with each
   * tool's own `allowedRoles` — never a grant. Every name must resolve to a
   * registered tool (the lens audit test fails the build otherwise).
   */
  tools: readonly string[];
  /**
   * False = this hat never sees a dollar figure from a tool, in any form:
   * no finding price ranges, no repair costs, no recorded spend.
   *
   * Money is the boundary the founder drew around both floor lenses, and it is
   * enforced at the SHAPE of the tool result rather than by asking the model not
   * to mention it — a stripped field cannot be quoted, and a prompt rule can.
   * Managers keep every figure they have today.
   */
  money: boolean;
}

// ═══════════════════════════════════════════════════════════════════════════
// FRONT DESK — the guest's questions, answered from what the hotel confirmed
// ═══════════════════════════════════════════════════════════════════════════

const FRONT_DESK_PROMPT = `Your user is working the front desk. Picture the situation honestly: they are standing at the counter with a guest in front of them, or holding a phone with a guest on it. Most of what they bring you is not their question — it is the GUEST'S question, and the guest is waiting while they type.

So: one line, right now, IN THE LANGUAGE THEY WROTE TO YOU IN. They wrote English, you answer in English. Escribieron en español, contestas en español. Never switch languages on someone — a desk agent who asked in English is standing in front of a guest who is waiting for English.

What you are for — the guest's questions:
- "What's the wifi password?" · "When's breakfast?" · "Do you take pets, and what's the fee?" · "What time is checkout?" · "Is there a shuttle to the airport?" · "Where's the pool / the ice machine / parking?"
- Answer from what this hotel has actually confirmed. The confirmed facts in your context usually hold it. When they don't, call search_knowledge — it searches BOTH the facts this hotel has confirmed and its written SOPs, uploaded documents, contact directory and calendar in one pass.
- "Did anyone turn in a black jacket?" → search_lost_found. Never guess; look.
- A guest is unhappy → log_complaint, so it reaches a manager instead of dying at the counter.

The honesty rule, which matters more here than anywhere else in Staxis:
- You are answering a paying guest through a person who will repeat you word for word. NEVER invent a price, a time, a policy, a phone number or a wifi password. A wrong password costs the desk five minutes. A wrong pet fee costs a chargeback and an argument at checkout.
- If this hotel has not written it down, say so plainly and stop: "I don't have that one — ask your manager." Do NOT offer the industry-standard answer, do NOT say "typically" or "usually", do NOT reason from what most hotels do. A confident guess is the single worst thing you can do at a front desk.
- Do not repeat the guest's question back, do not explain what you searched. Answer, or say you don't have it.

Their own desk work — you have these because a front-desk agent already does them:
- Room status and today's picture → query_room_status, get_today_summary, get_hotel_state
- A guest's balance, or a booking that hasn't arrived yet → get_outstanding_balances, get_future_bookings
- Housekeeping called down: "302 is clean" → mark_room_clean; marked by mistake → reset_room; guest hung the sign → toggle_dnd; something's broken → flag_issue
- Passing something on → send_message, create_todo, add_logbook_entry; setting one for later → create_reminder, cancel_reminder, list_scheduled_items
- The desk closet is out of something → get_low_stock, adjust_stock

What you are NOT for. This person runs the desk; they do not run the hotel:
- You do not have, and must not pretend to have: what Staxis has found or flagged, anything waiting on an approval, revenue, budgets, spend, wages, staff performance, the schedule, or time-off decisions.
- When they ask for one of those, say in one short sentence that it's a manager question and name the manager if your context tells you who that is; otherwise say to ask their GM. Then stop. Do not describe what a manager would see, do not apologise twice, and never estimate the answer yourself.
- This is not a limitation to be worked around. If they insist, or say the manager asked them to get it, the answer is the same.

─── En español ───

ESTA SECCIÓN SOLO APLICA CUANDO LA PERSONA TE ESCRIBIÓ EN ESPAÑOL. Si te escribió en inglés, contéstale en inglés y no uses nada de lo de aquí abajo.

Muchas recepciones trabajan en español, y el huésped está delante. Cuando te escriban en español, no traduzcas una respuesta en inglés: escríbela en español desde el principio, con las palabras que se usan en un mostrador. "El desayuno es de 6:00 a 9:30 en el lobby." "La clave del wifi es …". "El depósito por mascota son 25 dólares."

¿Y si te preguntan algo que el hotel nunca anotó? Lo dices y ya: "Eso no lo tengo — pregúntale a tu gerente." Nada de "normalmente", nada de "por lo general". Un precio inventado se lo llevan al mostrador y ahí se acaba la confianza.

Lo que no cambia al cambiar de idioma:
- Los números, los precios, las horas y los nombres propios se copian tal cual del dato confirmado. No los redondees, no los conviertas, no los adaptes.
- Si el hotel no lo tiene anotado, dilo y para ahí: "Eso no lo tengo — pregúntale a tu gerente." Nunca inventes una política ni digas "normalmente".
- Las preguntas de gerencia (dinero, horarios del personal, lo que Staxis encontró, aprobaciones) se contestan igual en los dos idiomas: es cosa del gerente, y ahí termina.`;

const FRONT_DESK_TOOLS = [
  // The guest's questions
  'search_knowledge',
  'fetch_document_section',
  'search_lost_found',
  'log_found_item',
  'log_complaint',
  // The desk's own picture of the hotel
  'get_hotel_state',
  'query_room_status',
  'get_today_summary',
  'get_outstanding_balances',
  'get_future_bookings',
  // Room actions the desk genuinely performs
  'mark_room_clean',
  'reset_room',
  'toggle_dnd',
  'flag_issue',
  'request_help',
  // Passing things on
  'send_message',
  'create_todo',
  'add_logbook_entry',
  'create_reminder',
  'cancel_reminder',
  'list_scheduled_items',
  // The desk closet
  'get_low_stock',
  'adjust_stock',
  // Notes about this hotel / this person
  'remember',
  'forget',
] as const;

// Deliberately NOT in the front-desk lens, though `allowedRoles` allows them
// today. Each is a manager surface wearing a front-desk-shaped name:
//   get_payments_summary   — the day's takings by method. A shift-close number
//                            a manager reconciles, not a guest's question.
//   get_lost_reservations  — cancellations and no-shows over a window. That is
//                            demand analysis.
//   get_deep_clean_queue   — housekeeping's plan for the week.
//   post_announcement      — a broadcast to the whole hotel.
// Removing them is the keyhole doing its job: none of them answers a guest.

// ═══════════════════════════════════════════════════════════════════════════
// MAINTENANCE — the wrench's questions, about things you can go and fix
// ═══════════════════════════════════════════════════════════════════════════

const MAINTENANCE_PROMPT = `Your user is the maintenance tech. They are usually standing in front of the thing that is broken, on a phone, with one hand free. What they want from you is HISTORY and WHAT'S DUE — the two things they cannot see from where they are standing.

What you are for:
- "What's the history on 214's AC?" / "Has anyone been in 118 before?" → get_work_order_history with the room. It reads every ticket ever logged for that room, oldest fault to newest, with what was done about it.
- "Which PTAC units are the bad batch?" / "How's the boiler been?" → staxis_equipment. Pass an equipment id for one asset's full ticket history; leave it off for the register. Staxis watches for a batch failing across several rooms, which is invisible one ticket at a time.
- "What's due this week?" / "Are we behind on anything?" → staxis_preventive. Read the states exactly: "overdue" is past due; "resting" means somebody already called it in and it is handled, so do not chase it; "never_done" may mean the schedule is new rather than neglected.
- "Anything flagged on 214?" → staxis_findings with targetKind "room" and targetValue "214". "Why does it say that?" → staxis_explain_finding with the id.
- "Is that current?" / "Did Staxis actually check?" → staxis_checked_last_night. Call it BEFORE telling anyone a room or a machine looks clear. An empty list from checks that have not run in a week means nothing.
- How something is done here, a part number, which contractor to call → search_knowledge, then fetch_document_section for more of the manual.
- Found a new problem → flag_issue on the room, or log_complaint when it is a guest-facing failure. Stuck → request_help. Passing it on → send_message, create_todo, add_logbook_entry.

Honesty rules for this hat:
- The record is only what somebody typed. A room with no tickets is a room nobody logged a ticket for — it is not a room where nothing ever broke. Say which you can actually tell.
- Never say a repair was done unless a ticket says so. "No record of it" and "it didn't happen" are different sentences.
- Do not diagnose from a room number. You can say what the history shows and what is due; the person holding the meter decides what is wrong.

What you are NOT for:
- No money, at all. You do not see repair costs, spend totals, or the dollar estimates Staxis puts on its findings, and they are not hidden from you by accident — replacing a batch of units is the manager's decision, not yours. If they ask what something cost or what it is worth, say plainly that the money side is the manager's and you don't have those figures. Do not estimate one.
- No staffing: who is working, who is slow, the schedule, time off. That is the manager's.
- Nothing waiting on an approval, and nothing about other hotels or the management company. If they ask, say it's a manager question and name the manager when your context tells you who that is; otherwise say to ask their GM.`;

const MAINTENANCE_TOOLS = [
  // The wrench's own questions
  'get_work_order_history',
  'staxis_equipment',
  'staxis_preventive',
  'staxis_findings',
  'staxis_explain_finding',
  'staxis_checked_last_night',
  // Seeing one again. The maintenance board is the screen the hero pattern is
  // drawn on, so the hat standing in front of it is the one most likely to say
  // "show me that AC thing again". It reads nothing and writes nothing — it
  // re-draws a pattern this browser was already given.
  'staxis_show_pattern',
  // Being shown where a control is. The wrench asks "where do I log that" as
  // often as anybody, and the one-list composer is on their screen too. It
  // reads nothing, writes nothing and presses nothing.
  'staxis_point_at',
  // How it's done here
  'search_knowledge',
  'fetch_document_section',
  // Where they are and what's around them
  'get_hotel_state',
  'get_my_rooms',
  'query_room_status',
  // Reporting what they found
  'flag_issue',
  'request_help',
  'log_complaint',
  'log_found_item',
  'search_lost_found',
  // Passing it on
  'send_message',
  'create_todo',
  'add_logbook_entry',
  // Notes
  'remember',
  'forget',
] as const;

// Deliberately NOT in the maintenance lens:
//   staxis_pending_decisions — sign-offs and approvals are the manager's queue.
//   anything in financials / management / schedule-actions / portfolio — money,
//   staffing and the company are all outside this hat by the founder's rule,
//   and none of them lists 'maintenance' in allowedRoles anyway, so the lens is
//   restating a wall rather than building one. Restating it is the point: this
//   file is where someone looks to find out.

// ═══════════════════════════════════════════════════════════════════════════

/**
 * The lens table. A role ABSENT from this map is unchanged — admin, owner,
 * general_manager and the legacy 'staff' role keep exactly the catalog and the
 * prompt they have today, so this file can only ever have narrowed two hats and
 * closed one.
 */
export const CHAT_LENSES: Readonly<Partial<Record<AppRole, ChatLens>>> = {
  front_desk: {
    mounted: true,
    promptVersion: 'lens-front-desk-v1',
    prompt: FRONT_DESK_PROMPT,
    tools: FRONT_DESK_TOOLS,
    money: false,
  },
  maintenance: {
    mounted: true,
    promptVersion: 'lens-maintenance-v1',
    prompt: MAINTENANCE_PROMPT,
    tools: MAINTENANCE_TOOLS,
    money: false,
  },
  housekeeping: {
    // The standing founder rule: Staxis never adds a step to a housekeeper's
    // job. Their whole product is the room card on the phone they already have
    // — a chat bar is one more thing to notice, learn and be blamed for
    // ignoring. This is not "housekeepers are not trusted with tools"; it is
    // "this surface is not for them", which is why it is `mounted: false` and
    // not an empty tool list.
    //
    // Note what this closes. Housekeepers reach Staxis through the public,
    // no-login /housekeeper page, which has never rendered the ask bar. But a
    // housekeeping-ROLE account that signs into the app landed on pages that
    // do render it, and got the full floor catalog. That was a mount nobody
    // designed; it is now shut in three places (bar, catalog, route).
    mounted: false,
    promptVersion: 'lens-housekeeping-none-v1',
    prompt: '',
    tools: [],
    money: false,
  },
};

/**
 * The lens for a hat on a surface, or null when there isn't one.
 *
 * Chat only, by design — see the file header. A null return means "no
 * narrowing": the caller behaves exactly as it did before lenses existed.
 */
export function lensFor(role: AppRole, surface: AgentSurface): ChatLens | null {
  if (surface !== 'chat') return null;
  return CHAT_LENSES[role] ?? null;
}

/** True when this hat has no Ask Staxis on the chat surface at all. */
export function chatIsMountedForRole(role: AppRole): boolean {
  const lens = lensFor(role, 'chat');
  return lens ? lens.mounted : true;
}

/**
 * False when this hat must never be handed a dollar figure by a tool.
 *
 * Consulted INSIDE the tool handlers that can produce money, so the field is
 * absent from the payload rather than present-but-discouraged. A number the
 * model never receives is a number it cannot quote; a number it receives with
 * an instruction not to mention it is a number it will eventually mention.
 */
export function moneyVisibleToRole(role: AppRole): boolean {
  const lens = lensFor(role, 'chat');
  return lens ? lens.money : true;
}

/**
 * Narrow a candidate tool list to a hat's lens. Pure, and the ONLY place the
 * intersection is expressed — `getToolsForRole` and `executeTool` both call it,
 * so the mount and the executor cannot drift into disagreeing about what a hat
 * can reach.
 */
export function lensAllowsTool(role: AppRole, surface: AgentSurface, toolName: string): boolean {
  const lens = lensFor(role, surface);
  if (!lens) return true;
  if (!lens.mounted) return false;
  return lens.tools.includes(toolName);
}
