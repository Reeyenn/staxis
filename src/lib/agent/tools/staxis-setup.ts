// ─── Setting the hotel up by talking to it ───────────────────────────────────
//
// Three things a manager can now SAY instead of finding a screen for:
//
//   staxis_set_up_preventive_task   "water heaters every six months, last done
//                                    in March"     → a row on the upkeep list
//   staxis_set_up_equipment         "track our PTACs, rooms 201 to 240,
//                                    installed 2019" → rows on the register
//   staxis_write_company_rule       "orders over $500 need VP approval"
//                                                   → a line in the company book
//
// EVERY ONE OF THEM IS TWO CALLS, AND THE SECOND ONE NEEDS A HUMAN.
// The first call validates, normalises, writes NOTHING, and returns the
// structured reading — "Every 180 days, last done 15 March 2026, next due 11
// September 2026 — right?" The second writes, using the wording FROZEN by the
// first, and only once the route has recorded a message from the person after
// that read-back. The whole argument for why an argument the model sets could
// never be that confirmation is in src/lib/agent/chat-confirm.ts.
//
// WHY THE READ-BACK IS STRUCTURED RATHER THAN A PARAPHRASE
// This is the Knows screen's open box in a different room. A manager who says
// "every six months" and is told "got it" has no way to discover that Staxis
// heard six weeks; a manager who is told "every 180 days, next due 11 September"
// finds out in the same second. So every number the tool derived — the interval
// in days, the date it will count from, the date that falls due, how many units
// a room range comes to — is in the sentence, in both languages, built from the
// structured values rather than translated at render time.
//
// WHAT IS DELIBERATELY NOT HERE
// A tool for hotel facts. `remember` already stores them, already gates
// hotel-scope writes on manager tier, already redacts contact details, and
// already goes in front of a human — its approval card is drawn inside the
// conversation. Adding a second door to `agent_memory` would have given the
// hotel two ways to write the same row with two sets of rules to keep in step.
// Its confirmation is a tap rather than a sentence, and that difference is a
// product decision to revisit deliberately, not something to fork the storage
// path over.

import { registerTool, type ToolResult, type ToolHandlerContext } from '../tools';
import {
  proposeConfirmation,
  takeConfirmation,
  confirmedMarker,
  type ReadBack,
} from '../chat-confirm';
import { propertyLocalToday, addDaysInTz } from '@/lib/schedule/local-date';
import { EQUIPMENT_CATEGORIES, type EquipmentCategory } from '@/lib/equipment/types';
import { resolveCompanyForProperty } from '@/lib/company/access';
import { rulebookStandingFor, companyAccessSetting } from '@/lib/company/rulebook-access';
import { loadApproverDirectory, approversFrom } from '@/lib/company/signoff';
import {
  storeCompanyFact,
  structuredReadingFor,
  slugifyCompanyTopic,
  COMPANY_FACT_MAX_CONTENT,
} from '@/lib/company/rulebook';
import {
  COMPANY_CATEGORIES,
  coerceCompanyCategory,
  describeAuthorityRule,
  describeAmbiguousAuthority,
  type AuthorityApproverRole,
} from '@/lib/company/rulebook-policy';

const MANAGER_ROLES = ['admin', 'owner', 'general_manager'] as const;

// ─── Shared helpers ──────────────────────────────────────────────────────────

const DATE_RX = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_RX = /^\d{4}-\d{2}$/;
const YEAR_RX = /^\d{4}$/;

/** The hotel's own calendar day. A schedule set up at 8pm in Beaumont must not
 *  count from tomorrow because the server runs in UTC. */
async function hotelToday(ctx: ToolHandlerContext): Promise<string> {
  const { data } = await ctx.db.from('properties').select('timezone').maybeSingle();
  const tz = (data as { timezone?: string | null } | null)?.timezone ?? null;
  return propertyLocalToday(new Date(), tz);
}

/**
 * A date the person half-said, plus what we had to assume.
 *
 * "Last done in March" is a real thing a manager says and a real thing this
 * feature has to accept. It is NOT a reason to invent the 15th: the assumption
 * is made explicit, carried into the read-back sentence, and is therefore
 * something they can correct in the same breath.
 */
interface LooseDate {
  iso: string;
  assumed: { en: string; es: string } | null;
}

function parseLooseDate(raw: unknown): LooseDate | { error: string } {
  const value = String(raw ?? '').trim();
  if (!value) return { error: 'no date' };
  let iso: string;
  let assumed: LooseDate['assumed'] = null;
  if (DATE_RX.test(value)) {
    iso = value;
  } else if (MONTH_RX.test(value)) {
    iso = `${value}-01`;
    assumed = {
      en: 'they gave a month, so this is the 1st — say so and let them correct the day',
      es: 'dieron un mes, así que es el día 1 — dilo y deja que corrijan el día',
    };
  } else if (YEAR_RX.test(value)) {
    iso = `${value}-01-01`;
    assumed = {
      en: 'they gave a year, so this is 1 January — say so and let them correct it',
      es: 'dieron un año, así que es el 1 de enero — dilo y deja que lo corrijan',
    };
  } else {
    return { error: `I could not read "${value}" as a date. Ask them for it as a day, a month or a year — do not guess one.` };
  }
  const parsed = Date.parse(`${iso}T00:00:00Z`);
  if (!Number.isFinite(parsed)) return { error: `"${value}" is not a real date.` };
  if (iso < '2000-01-01') return { error: 'That date is too far in the past to be a maintenance record. Check it with them.' };
  return { iso, assumed };
}

/** "15 March 2026" / "15 de marzo de 2026". Formatted in UTC because the input
 *  is a calendar date, not a moment — formatting it in a timezone would move it
 *  a day for half the world. */
function longDate(iso: string, lang: 'en' | 'es'): string {
  try {
    return new Intl.DateTimeFormat(lang === 'es' ? 'es-US' : 'en-GB', {
      timeZone: 'UTC', day: 'numeric', month: 'long', year: 'numeric',
    }).format(new Date(`${iso}T00:00:00Z`));
  } catch {
    return iso;
  }
}

/** How a person would say an interval. The number of days is always shown too —
 *  this is the friendly half of "every 180 days (about every 6 months)", never
 *  a replacement for it. */
function cadencePhrase(days: number, lang: 'en' | 'es'): string | null {
  const table: Record<number, ReadBack> = {
    1: { en: 'daily', es: 'diario' },
    7: { en: 'weekly', es: 'cada semana' },
    14: { en: 'every two weeks', es: 'cada dos semanas' },
    30: { en: 'about monthly', es: 'más o menos cada mes' },
    31: { en: 'about monthly', es: 'más o menos cada mes' },
    60: { en: 'about every two months', es: 'más o menos cada dos meses' },
    90: { en: 'about quarterly', es: 'más o menos cada trimestre' },
    120: { en: 'about every four months', es: 'más o menos cada cuatro meses' },
    180: { en: 'about every six months', es: 'más o menos cada seis meses' },
    365: { en: 'about yearly', es: 'más o menos cada año' },
    730: { en: 'about every two years', es: 'más o menos cada dos años' },
  };
  const hit = table[days];
  return hit ? hit[lang] : null;
}

/** Loose name equality for the "you already have one of these" check. */
function normalizeName(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

// ═══════════════════════════════════════════════════════════════════════════
// staxis_set_up_preventive_task
// ═══════════════════════════════════════════════════════════════════════════

interface PreventiveParams {
  name: string;
  everyDays: number;
  area: string | null;
  lastDone: string | null;
  nextDue: string | null;
}

registerTool<{
  name?: string;
  everyDays?: number;
  area?: string;
  lastDone?: string;
  confirmToken?: string;
}>({
  name: 'staxis_set_up_preventive_task',
  section: 'maintenance',
  allowedRoles: MANAGER_ROLES,
  mutates: true,
  confirmInChat: true,
  description:
    'Put a piece of RECURRING upkeep on the hotel\'s schedule from what the manager just said, so Staxis counts the days forward and says when it is due. ' +
    'Use when: someone describes routine work that repeats — "we flush the water heaters every six months, last done in March", "the elevator gets serviced quarterly", "hay que revisar la caldera cada tres meses". Not for something broken right now (that is log_complaint or a work order), and not for a one-off task (create_todo). To see what already exists first, use staxis_preventive. ' +
    'Args: name — what the job is called, in their words ("Water heater flush"). everyDays — how often, IN DAYS, converted by you: weekly 7, monthly 30, quarterly 90, twice a year 180, yearly 365. area — where it happens, optional. lastDone — when it was last done, as YYYY-MM-DD, or YYYY-MM if they only gave a month, or YYYY if only a year; leave it out when they do not know. confirmToken — ONLY on the second call, after they have agreed. ' +
    'Returns: on the first call { awaitingConfirmation, readBack, confirm } — nothing is saved yet; read the readBack sentence out in their language and wait. On the second call, the schedule that was created and when it is next due. ' +
    'Refuses: an interval that is not between 1 and 3650 days, a last-done date in the future, and a name this hotel already has a schedule under — say what the existing one is instead of making a second. It also refuses to save on the first call, and refuses a confirmToken when the person has not answered you since the read-back: your own agreement is not theirs. If you assumed a day or a month because they gave only a month or a year, SAY SO in the read-back rather than letting the assumption pass.',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'What the recurring job is called, in the manager\'s own words (e.g. "Water heater flush").' },
      everyDays: { type: 'number', description: 'How often it should happen, in days (weekly 7, quarterly 90, twice a year 180, yearly 365).' },
      area: { type: 'string', description: 'Where the work happens — "boiler room", "roof", "pool". Optional.' },
      lastDone: { type: 'string', description: 'When it was last done: YYYY-MM-DD, or YYYY-MM / YYYY if they were vaguer. Omit when unknown.' },
      confirmToken: { type: 'string', description: 'The token from your earlier proposal. Send ONLY after the person has said yes in a new message.' },
    },
  },
  handler: async (args, ctx): Promise<ToolResult> => {
    // ── the confirm half ──
    if (args.confirmToken) {
      const taken = await takeConfirmation<PreventiveParams>(ctx, 'preventive_task', args.confirmToken);
      if (!taken.ok) return { ok: false, error: taken.error };
      const p = taken.params;
      if (!p || typeof p.name !== 'string' || !Number.isFinite(p.everyDays)) {
        return { ok: false, error: 'What you agreed to did not survive intact, so I have not saved it. Propose it again.' };
      }
      if (ctx.dryRun) {
        return { ok: true, data: { ...confirmedMarker(args.confirmToken), created: { name: p.name }, dryRun: true } };
      }

      const { data, error } = await ctx.db
        .from('preventive_tasks')
        .insert({
          name: p.name,
          area: p.area,
          frequency_days: p.everyDays,
          last_completed_at: p.lastDone ? `${p.lastDone}T12:00:00.000Z` : null,
          // NOT last_completed_by. The manager told us WHEN it was last done,
          // not that they were the one who did it, and writing their name into
          // the hotel's maintenance record on that basis would be a small,
          // permanent lie. Who set the schedule up goes in the notes.
          notes: `Set up by ${ctx.user.displayName || 'a manager'} in the Staxis chat.`,
        })
        .select('id, name');
      if (error) {
        return { ok: false, error: 'I could not save that schedule just now — tell them it is NOT saved and try again in a moment.' };
      }
      const row = (data ?? [])[0] as { id?: string; name?: string } | undefined;
      return {
        ok: true,
        data: {
          ...confirmedMarker(args.confirmToken),
          created: {
            id: row?.id ?? null,
            name: p.name,
            everyDays: p.everyDays,
            area: p.area,
            lastDone: p.lastDone,
            nextDue: p.nextDue,
          },
          note: 'Saved. It now shows up under maintenance and Staxis will raise it when it comes due.',
        },
      };
    }

    // ── the propose half — writes nothing ──
    const name = String(args.name ?? '').trim();
    if (name.length < 2 || name.length > 120) {
      return { ok: false, error: 'What should this job be called? Ask them, in their words — do not name it yourself.' };
    }
    const everyDays = Number(args.everyDays);
    if (!Number.isInteger(everyDays) || everyDays < 1 || everyDays > 3650) {
      return { ok: false, error: 'How often should it happen? I need a whole number of days between 1 and 3650 — convert what they said ("every six months" is 180).' };
    }
    const area = args.area ? String(args.area).trim().slice(0, 120) || null : null;

    const today = await hotelToday(ctx);

    let lastDone: string | null = null;
    let assumed: LooseDate['assumed'] = null;
    if (args.lastDone !== undefined && args.lastDone !== null && String(args.lastDone).trim() !== '') {
      const parsed = parseLooseDate(args.lastDone);
      if ('error' in parsed) return { ok: false, error: parsed.error };
      if (parsed.iso > today) {
        return { ok: false, error: 'That last-done date is in the future. Check the date with them rather than recording it.' };
      }
      lastDone = parsed.iso;
      assumed = parsed.assumed;
    }

    // Already on the list? Two schedules for the same job is how a hotel ends
    // up with two different "last done" dates for one boiler.
    const { data: existing, error: readErr } = await ctx.db
      .from('preventive_tasks')
      .select('id, name, frequency_days, last_completed_at')
      .limit(200);
    if (readErr) {
      return { ok: false, error: 'I could not read this hotel\'s upkeep list, so I cannot tell whether this is already on it. Try again in a moment.' };
    }
    const clash = (existing ?? []).find(
      (row) => normalizeName(String(row.name ?? '')) === normalizeName(name),
    );
    if (clash) {
      const days = Number(clash.frequency_days ?? 0);
      const last = clash.last_completed_at ? String(clash.last_completed_at).slice(0, 10) : null;
      return {
        ok: false,
        error: `This hotel already has "${clash.name}" on the upkeep list — every ${days} days, ` +
          `${last ? `last done ${last}` : 'never recorded as done'}. Tell them that rather than adding a second one; ` +
          'changing an existing schedule is done on the maintenance screen.',
      };
    }

    const nextDue = lastDone ? addDaysInTz(lastDone, everyDays) : null;
    const params: PreventiveParams = { name, everyDays, area, lastDone, nextDue };

    const build = (lang: 'en' | 'es'): string => {
      const cadence = cadencePhrase(everyDays, lang);
      const parts: string[] = [];
      if (lang === 'es') {
        parts.push(`${name} — cada ${everyDays} días${cadence ? ` (${cadence})` : ''}`);
        if (area) parts.push(`en ${area}`);
        parts.push(lastDone ? `última vez el ${longDate(lastDone, 'es')}` : 'sin registro de la última vez');
        if (nextDue) parts.push(`próxima el ${longDate(nextDue, 'es')}`);
        return `${parts.join(', ')}. ¿Correcto?`;
      }
      parts.push(`${name} — every ${everyDays} days${cadence ? ` (${cadence})` : ''}`);
      if (area) parts.push(`in ${area}`);
      parts.push(lastDone ? `last done ${longDate(lastDone, 'en')}` : 'no record of when it was last done');
      if (nextDue) parts.push(`next due ${longDate(nextDue, 'en')}`);
      return `${parts.join(', ')}. Right?`;
    };

    return {
      ok: true,
      data: {
        ...await proposeConfirmation(ctx, 'preventive_task', params, { en: build('en'), es: build('es') }),
        assumption: assumed,
      },
    };
  },
});

// ═══════════════════════════════════════════════════════════════════════════
// staxis_set_up_equipment
// ═══════════════════════════════════════════════════════════════════════════

/** One asset per room in a range is the normal shape of this request, and the
 *  cap is what stops "all our rooms" turning into a four-hundred-row write on a
 *  sentence. Above it the tool asks rather than guesses. */
const MAX_UNITS_PER_SETUP = 60;

interface EquipmentParams {
  name: string;
  category: EquipmentCategory;
  location: string | null;
  manufacturer: string | null;
  installDate: string | null;
  rooms: string[];
}

/** "201-240", "201, 205, 210", "201-205, 301". Numeric ranges only — a range
 *  between two room numbers that are not numbers has no meaning. */
function parseRooms(raw: string): { rooms: string[] } | { error: string } {
  const out: string[] = [];
  for (const chunk of raw.split(/[,;]+/)) {
    const part = chunk.trim();
    if (!part) continue;
    const range = /^(\d{1,5})\s*(?:-|–|—|to|a)\s*(\d{1,5})$/i.exec(part);
    if (range) {
      const from = Number(range[1]);
      const to = Number(range[2]);
      if (to < from) return { error: `"${part}" runs backwards. Ask them which rooms they mean.` };
      if (to - from + 1 > MAX_UNITS_PER_SETUP) {
        return { error: `That range is ${to - from + 1} rooms, and I will not add more than ${MAX_UNITS_PER_SETUP} pieces of equipment from one sentence. Ask them to do it in smaller batches.` };
      }
      for (let n = from; n <= to; n += 1) out.push(String(n));
      continue;
    }
    if (!/^[\w-]{1,12}$/.test(part)) {
      return { error: `I could not read "${part}" as a room. Ask them for the rooms as numbers or a range like 201-240.` };
    }
    out.push(part);
  }
  const unique = [...new Set(out)];
  if (unique.length === 0) return { error: 'Which rooms? Ask them, or leave the rooms out for a single piece of equipment.' };
  if (unique.length > MAX_UNITS_PER_SETUP) {
    return { error: `That is ${unique.length} rooms, and I will not add more than ${MAX_UNITS_PER_SETUP} pieces of equipment from one sentence. Ask them to do it in smaller batches.` };
  }
  return { rooms: unique };
}

registerTool<{
  name?: string;
  category?: string;
  rooms?: string;
  location?: string;
  manufacturer?: string;
  installDate?: string;
  confirmToken?: string;
}>({
  name: 'staxis_set_up_equipment',
  section: 'maintenance',
  allowedRoles: MANAGER_ROLES,
  mutates: true,
  confirmInChat: true,
  description:
    'Put physical assets on the hotel\'s equipment register from what the manager just said — one machine, or one per room across a range. ' +
    'Use when: someone says what they own and want tracked — "start tracking our PTAC units, rooms 201 to 240, installed 2019", "add the boiler in the basement", "queremos llevar registro de los aires acondicionados". This is what makes repairs add up per machine afterwards. To read the register or one asset\'s history, use staxis_equipment instead. ' +
    'Args: name — what they call this kind of machine ("PTAC", "Boiler"). category — one of hvac, plumbing, electrical, appliance, structural, elevator, pool, laundry, kitchen, other. rooms — a range or list ("201-240", "201, 305"), which creates ONE asset per room named "<name> <room>"; leave it out for a single machine. location — where it is, for a single machine. manufacturer and installDate (YYYY-MM-DD, or YYYY if that is all they said) are optional. confirmToken — ONLY on the second call, after they have agreed. ' +
    'Returns: on the first call { awaitingConfirmation, readBack, confirm } with the exact COUNT and the names that will be created — nothing is saved yet. On the second call, how many were created and any that were already on the register. ' +
    `Refuses: more than ${MAX_UNITS_PER_SETUP} assets from one sentence, a room range that runs backwards, and a category outside the list. It refuses to save on the first call, and refuses a confirmToken when the person has not answered you since the read-back. Assets already on the register under the same name are skipped rather than duplicated — report that honestly. Staxis knows nothing about these machines beyond what was just said, so do not fill in a make, a cost or a service interval nobody gave you.`,
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'What this kind of machine is called ("PTAC", "Boiler", "Ice machine").' },
      category: { type: 'string', enum: [...EQUIPMENT_CATEGORIES], description: 'Which kind of asset it is — hvac, plumbing, electrical, appliance, structural, elevator, pool, laundry, kitchen or other.' },
      rooms: { type: 'string', description: 'Rooms to create one asset each for — a range like "201-240" or a list like "201, 305". Omit for a single machine.' },
      location: { type: 'string', description: 'Where the machine is, for a single machine ("basement", "roof"). Ignored when rooms are given.' },
      manufacturer: { type: 'string', description: 'Who made it, if they said. Never guess a brand.' },
      installDate: { type: 'string', description: 'When it was installed: YYYY-MM-DD, or YYYY if that is all they gave.' },
      confirmToken: { type: 'string', description: 'The token from your earlier proposal. Send ONLY after the person has said yes in a new message.' },
    },
  },
  handler: async (args, ctx): Promise<ToolResult> => {
    // ── the confirm half ──
    if (args.confirmToken) {
      const taken = await takeConfirmation<EquipmentParams>(ctx, 'equipment', args.confirmToken);
      if (!taken.ok) return { ok: false, error: taken.error };
      const p = taken.params;
      if (!p || typeof p.name !== 'string') {
        return { ok: false, error: 'What you agreed to did not survive intact, so I have not saved it. Propose it again.' };
      }
      // Name and place are paired here, once, so a filtered batch cannot end up
      // writing one asset's room onto another's row.
      const units = p.rooms.length > 0
        ? p.rooms.map((room) => ({ name: `${p.name} ${room}`, location: `Room ${room}` }))
        : [{ name: p.name, location: p.location }];

      if (ctx.dryRun) {
        return { ok: true, data: { ...confirmedMarker(args.confirmToken), created: units.length, dryRun: true } };
      }

      // Re-read rather than trusting the check the proposal did: minutes have
      // passed, and somebody may have added the same asset from the registry
      // screen in between. Skipping a duplicate is the honest outcome — a
      // second "PTAC 214" would split one machine's repair history in two.
      const { data: already, error: readErr } = await ctx.db
        .from('equipment')
        .select('name')
        .limit(500);
      if (readErr) {
        return { ok: false, error: 'I could not read the equipment register, so I have saved nothing. Try again in a moment.' };
      }
      const onRegister = new Set((already ?? []).map((row) => normalizeName(String(row.name ?? ''))));
      const fresh = units.filter((u) => !onRegister.has(normalizeName(u.name)));
      const skipped = units.filter((u) => onRegister.has(normalizeName(u.name))).map((u) => u.name);

      if (fresh.length === 0) {
        return {
          ok: true,
          data: {
            ...confirmedMarker(args.confirmToken),
            created: 0,
            alreadyOnTheRegister: skipped,
            note: 'Every one of those was already on the register, so nothing was added. Say exactly that.',
          },
        };
      }

      // ONE insert for the whole batch, through the hotel-scoped accessor which
      // stamps property_id on every row. The registry screen's own door
      // (createEquipment) writes one row per call; forty round trips inside a
      // single chat turn would be the slowest thing this app does. The column
      // set below mirrors it exactly, including `created_from: 'manual'` — a
      // human said this out loud, which is as manual as it gets.
      const { data: inserted, error } = await ctx.db
        .from('equipment')
        .insert(fresh.map((unit) => ({
          name: unit.name,
          category: p.category,
          location: unit.location,
          manufacturer: p.manufacturer,
          install_date: p.installDate,
          created_by_account_id: ctx.user.accountId,
          created_by_name: ctx.user.displayName || null,
          created_from: 'manual',
        })))
        .select('id');
      if (error) {
        return { ok: false, error: 'I could not add those to the register just now — tell them nothing was saved and try again in a moment.' };
      }

      return {
        ok: true,
        data: {
          ...confirmedMarker(args.confirmToken),
          created: (inserted ?? []).length,
          names: fresh.map((u) => u.name),
          alreadyOnTheRegister: skipped,
          note: 'On the register now. Repairs logged against these will add up per machine from here on.',
        },
      };
    }

    // ── the propose half — writes nothing ──
    const name = String(args.name ?? '').trim();
    if (name.length < 2 || name.length > 60) {
      return { ok: false, error: 'What is this equipment called? Ask them for the name they use — do not invent one.' };
    }
    const category = String(args.category ?? '').trim() as EquipmentCategory;
    if (!(EQUIPMENT_CATEGORIES as readonly string[]).includes(category)) {
      return { ok: false, error: `Which kind of equipment is it? Pick one of: ${EQUIPMENT_CATEGORIES.join(', ')}.` };
    }

    let rooms: string[] = [];
    if (args.rooms !== undefined && args.rooms !== null && String(args.rooms).trim() !== '') {
      const parsed = parseRooms(String(args.rooms));
      if ('error' in parsed) return { ok: false, error: parsed.error };
      rooms = parsed.rooms;
    }

    let installDate: string | null = null;
    let assumed: LooseDate['assumed'] = null;
    if (args.installDate !== undefined && args.installDate !== null && String(args.installDate).trim() !== '') {
      const parsed = parseLooseDate(args.installDate);
      if ('error' in parsed) return { ok: false, error: parsed.error };
      installDate = parsed.iso;
      assumed = parsed.assumed;
    }

    const params: EquipmentParams = {
      name,
      category,
      location: rooms.length === 0 && args.location ? String(args.location).trim().slice(0, 160) : null,
      manufacturer: args.manufacturer ? String(args.manufacturer).trim().slice(0, 120) : null,
      installDate,
      rooms,
    };
    const count = rooms.length > 0 ? rooms.length : 1;

    const build = (lang: 'en' | 'es'): string => {
      const where = rooms.length > 0
        ? (lang === 'es'
            ? `una por habitación, de la ${rooms[0]} a la ${rooms[rooms.length - 1]}`
            : `one for each room from ${rooms[0]} to ${rooms[rooms.length - 1]}`)
        : (params.location
            ? (lang === 'es' ? `en ${params.location}` : `in ${params.location}`)
            : null);
      const bits: string[] = [];
      if (lang === 'es') {
        bits.push(`${count} ${count === 1 ? 'equipo' : 'equipos'} "${name}" (${category})`);
        if (where) bits.push(where);
        if (params.manufacturer) bits.push(`marca ${params.manufacturer}`);
        if (installDate) bits.push(`instalado el ${longDate(installDate, 'es')}`);
        return `${bits.join(', ')}. ¿Correcto?`;
      }
      bits.push(`${count} "${name}" ${count === 1 ? 'unit' : 'units'} (${category})`);
      if (where) bits.push(where);
      if (params.manufacturer) bits.push(`made by ${params.manufacturer}`);
      if (installDate) bits.push(`installed ${longDate(installDate, 'en')}`);
      return `${bits.join(', ')}. Right?`;
    };

    return {
      ok: true,
      data: {
        ...await proposeConfirmation(ctx, 'equipment', params, { en: build('en'), es: build('es') }),
        willCreate: count,
        exampleNames: rooms.length > 0 ? [`${name} ${rooms[0]}`, `${name} ${rooms[rooms.length - 1]}`] : [name],
        assumption: assumed,
      },
    };
  },
});

// ═══════════════════════════════════════════════════════════════════════════
// staxis_write_company_rule
// ═══════════════════════════════════════════════════════════════════════════

interface CompanyRuleParams {
  organizationId: string;
  topic: string;
  content: string;
  category: string;
  /** The proposal is an insert-only promise; an intervening line conflicts. */
  expectedRevision: 0;
}

/** Who, by name, may write this company's book. Used only to make a refusal
 *  useful — "that goes to Jay" beats "you are not allowed". */
async function editorNames(organizationId: string): Promise<string[]> {
  const choice = await companyAccessSetting(organizationId, 'rulebook_editors');
  // `company_scope` and `owner_and_vp` name the same two people now that
  // `finance` is retired. Both are still accepted stored values.
  const roles: AuthorityApproverRole[] = choice === 'owner_only'
    ? ['owner']
    : ['owner', 'regional_manager'];
  try {
    const directory = await loadApproverDirectory(organizationId);
    const names = new Set<string>();
    for (const role of roles) {
      for (const person of approversFrom(directory, organizationId, null, role)) {
        if (person.name && person.name.trim()) names.add(person.name.trim());
      }
    }
    return [...names];
  } catch {
    return [];
  }
}

registerTool<{
  rule?: string;
  topic?: string;
  category?: string;
  confirmToken?: string;
}>({
  name: 'staxis_write_company_rule',
  allowedRoles: MANAGER_ROLES,
  mutates: true,
  confirmInChat: true,
  description:
    'Add a standing policy to the MANAGEMENT COMPANY\'s rulebook — the book that reaches every hotel the company runs, and the one place a spending-approval threshold becomes something Staxis enforces. ' +
    'Use when: someone states a company-wide rule — "orders over $500 need VP approval", "all our hotels use Ecolab", "todas nuestras propiedades usan el mismo proveedor". NOT for something true of this hotel only ("the third-floor ice machine keeps failing") — that is a hotel fact, and remember stores it. ' +
    'Args: rule — the policy in one sentence, keeping their exact numbers and the role they named ("orders over $500 need VP approval", never "large orders need approval"). topic — a short lower_snake_case slug naming the SUBJECT, which is how restating the same policy later updates the same line ("purchase_approval_threshold"). category — one of standards, money, vendors, people, guests. confirmToken — ONLY on the second call, after they have agreed. ' +
    'Returns: on the first call { awaitingConfirmation, readBack, confirm } plus, when the sentence sets an approval threshold, the exact rule Staxis will enforce in words — read that out too, because it is the part that changes who can spend. On the second call, the line that was written. ' +
    'Refuses: anyone whose company job does not let them write the book — a GM is told who can, by name, and MUST NOT be helped to route around it. It refuses at a hotel with no management company, and at a hotel two companies both claim. It refuses when the sentence names two possible approvers and does not choose: nothing is stored at all, and you ask which one they mean — a half-read money rule is worse than none. It also refuses to save on the first call, and refuses a confirmToken when the person has not answered you since the read-back.',
  inputSchema: {
    type: 'object',
    properties: {
      rule: { type: 'string', description: 'The policy in one sentence, with their exact figures and the role they named.' },
      topic: { type: 'string', description: 'Short lower_snake_case slug for the subject — the dedupe key ("purchase_approval_threshold").' },
      category: { type: 'string', enum: [...COMPANY_CATEGORIES], description: 'Which shelf of the book: standards, money, vendors, people or guests.' },
      confirmToken: { type: 'string', description: 'The token from your earlier proposal. Send ONLY after the person has said yes in a new message.' },
    },
  },
  handler: async (args, ctx): Promise<ToolResult> => {
    // ── the confirm half ──
    if (args.confirmToken) {
      const taken = await takeConfirmation<CompanyRuleParams>(ctx, 'company_rule', args.confirmToken);
      if (!taken.ok) return { ok: false, error: taken.error };
      const p = taken.params;
      if (!p || typeof p.content !== 'string' || typeof p.organizationId !== 'string'
        || p.expectedRevision !== 0) {
        return { ok: false, error: 'What you agreed to did not survive intact, so I have not written it. Propose it again.' };
      }

      // Standing is re-checked at the write, never read off the proposal. A
      // company can change who may edit its book between the read-back and the
      // yes, and the answer that governs the write is the one that is true now.
      const standing = await rulebookStandingFor(ctx.user.accountId, p.organizationId);
      if (!standing.canEdit) {
        const names = await editorNames(p.organizationId);
        return {
          ok: false,
          error: names.length > 0
            ? `You cannot write this company's rulebook — that is ${names.join(', ')}. Tell them who to ask; do not write it anywhere else instead.`
            : 'You cannot write this company\'s rulebook. Tell them to ask whoever maintains it; do not write it anywhere else instead.',
        };
      }

      if (ctx.dryRun) {
        return { ok: true, data: { ...confirmedMarker(args.confirmToken), written: p.topic, dryRun: true } };
      }

      const stored = await storeCompanyFact({
        organizationId: p.organizationId,
        topic: p.topic,
        content: p.content,
        category: coerceCompanyCategory(p.category),
        source: 'explicit_user',
        createdByAccountId: ctx.user.accountId,
        createdByName: ctx.user.displayName || null,
        createdByRole: ctx.user.role,
        requestId: ctx.requestId,
      });
      if (!stored.ok) {
        if (stored.reason === 'conflict') {
          return {
            ok: false,
            error: 'That rulebook topic changed after the read-back, so I did not overwrite it. Read the current line and propose the change again.',
          };
        }
        return { ok: false, error: 'I could not write that into the company book — tell them it is NOT saved and try again in a moment.' };
      }
      if (stored.action === 'company_full') {
        return { ok: false, error: 'This company\'s rulebook is full. An owner has to remove a line before another can be added.' };
      }
      if (!stored.factId) {
        return { ok: false, error: 'I could not verify the saved rulebook line, so do NOT say it was written. Try again in a moment.' };
      }

      return {
        ok: true,
        data: {
          ...confirmedMarker(args.confirmToken),
          written: { topic: p.topic, rule: p.content, category: p.category },
          enforced: true,
          revision: stored.currentRevision,
          note: 'Written and confirmed atomically. It now reaches every hotel this company runs, and any approval threshold in it is live.',
        },
      };
    }

    // ── the propose half — writes nothing ──
    const content = String(args.rule ?? '').trim();
    if (content.length < 8 || content.length > COMPANY_FACT_MAX_CONTENT) {
      return { ok: false, error: `What is the rule? One sentence, in their words, between 8 and ${COMPANY_FACT_MAX_CONTENT} characters.` };
    }
    const topic = slugifyCompanyTopic(String(args.topic ?? ''));
    if (!topic) {
      return { ok: false, error: 'Give this rule a short lower_snake_case topic naming its subject — it is how restating the same policy later updates the same line.' };
    }
    const category = coerceCompanyCategory(args.category);

    const company = await resolveCompanyForProperty(ctx.propertyId);
    if (company.status === 'independent') {
      return {
        ok: false,
        error: 'This hotel is not run by a management company, so there is no company rulebook to write in. If it is a fact about THIS hotel, save it as one instead.',
      };
    }
    if (company.status === 'ambiguous') {
      return {
        ok: false,
        error: 'Two companies both claim this hotel, so I cannot tell whose rulebook this would go in. Say that, and that somebody has to sort it out before company rules can be written here.',
      };
    }
    if (company.status !== 'company') {
      return {
        ok: false,
        error: 'I could not read which company runs this hotel, so I have not written anything. Try again in a moment.',
      };
    }
    const organizationId = company.organizationId;

    const standing = await rulebookStandingFor(ctx.user.accountId, organizationId);
    if (!standing.canEdit) {
      const names = await editorNames(organizationId);
      return {
        ok: false,
        error: names.length > 0
          ? `Writing the company rulebook is not yours to do — that is ${names.join(', ')}. Tell them politely who to ask, and do NOT save it somewhere else as a substitute.`
          : 'Writing the company rulebook is not yours to do, and nobody at this company currently holds that job. Say exactly that.',
      };
    }

    // The structured reading, in front of the person, before anything is
    // stored — the same shape the rulebook screen's Confirm panel shows.
    const reading = structuredReadingFor(content);
    if (reading.ambiguousAuthority) {
      return {
        ok: false,
        error: describeAmbiguousAuthority(reading.ambiguousAuthority, 'en') +
          ' NOTHING has been stored. Ask them which one it is and offer to write it again with that single name.',
      };
    }

    const params: CompanyRuleParams = {
      organizationId, topic, content, category, expectedRevision: 0,
    };
    const authorityEn = reading.authority ? describeAuthorityRule(reading.authority, 'en') : null;
    const authorityEs = reading.authority ? describeAuthorityRule(reading.authority, 'es') : null;

    return {
      ok: true,
      data: {
        ...await proposeConfirmation(ctx, 'company_rule', params, {
          en: `Into the company book, under "${topic}" (${category}): “${content}”.` +
            (authorityEn ? ` Staxis will enforce it as: ${authorityEn}` : '') +
            ' Right?',
          es: `Al libro de la empresa, bajo "${topic}" (${category}): “${content}”.` +
            (authorityEs ? ` Staxis lo aplicará así: ${authorityEs}` : '') +
            ' ¿Correcto?',
        }),
        willEnforce: authorityEn
          ? { en: authorityEn, es: authorityEs, note: 'This is the part that changes who may spend. Read it out.' }
          : null,
      },
    };
  },
});
