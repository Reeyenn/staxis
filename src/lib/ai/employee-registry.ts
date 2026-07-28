// ═══════════════════════════════════════════════════════════════════════════
// THE AI STAFF — the roster of named jobs Staxis's one engine does.
//
// There is no second engine behind any of these names. An "AI employee" is a
// JOB TITLE over the machinery that already exists: a bundle of the features it
// uses, the checks it runs, the scheduled jobs it depends on, and the screens
// it writes to. Naming the bundle is what turns "the app has a findings layer
// and a wording pass" into "the Morning Briefer writes your morning summary" —
// which is the only version of that sentence a hotel owner can hire, judge, or
// switch off.
//
// WHY A REGISTRY AND NOT A PAGE FULL OF CARDS
// Same reason feature-registry.ts exists. The moment the roster lives in JSX,
// the page and the truth drift: an employee keeps claiming a feature that was
// renamed, a switch keeps pointing at a job that moved. Here the roster is data,
// one standing test walks every bundled key back to the registry that owns it,
// and a rename that would orphan an employee fails the build instead of quietly
// producing a card that lies.
//
// HIRED vs NOT HIRED
// Twelve of the thirteen are not built. They are on this roster anyway, marked
// `hired: false`, because the founder wants to see the org chart he is building
// toward. An unhired employee has NO status, NO spend, NO switch and NO bundle:
// it is a name and a job description, and the page must render it as obviously
// not-yet-real. There is no honest status to show for work nothing does.
//
// ADDING EMPLOYEE #2
// Flip `hired` to true and fill the bundle. Roughly twenty lines:
//
//   {
//     id: 'maintenance_planner',
//     name: { en: 'Maintenance Planner', es: 'Planificador de mantenimiento' },
//     job:  { en: '…one sentence…',      es: '…una frase…' },
//     hired: true,
//     bundle: {
//       features:  ['findings.judge'],
//       detectors: ['repeat_room_work_orders'],
//       crons:     ['run-findings'],
//       surfaces:  [{ en: 'The Staxis tab', es: 'La pestaña Staxis' }],
//     },
//   },
//
// Nothing else changes. The page, the status derivation, the switch, the spend
// roll-up and the integrity test all read from here.
//
// ORDER. The roster is listed in the order the founder decided to build them
// (project_ai_employees_roadmap, 2026-07-19), not alphabetically and not
// hired-first. The page sorts hired to the top for reading; the source order is
// the plan.
// ═══════════════════════════════════════════════════════════════════════════

import { AI_FEATURE_KEYS, type AiFeatureKey } from './types';
import { MORNING_BRIEFER_ID } from './employee-ids';

/** Every user-visible string on this page ships in both languages, including
 *  on a screen only one person opens. House rule, no exemption for admin. */
export interface Bilingual {
  en: string;
  es: string;
}

/** What a hired employee is made of. Every id here is checked against the
 *  registry that owns it — see `assertEmployeeBundleKeys` and the standing
 *  ai-employee-registry test. */
export interface AiEmployeeBundle {
  /** AI Control Center feature keys whose model calls this employee makes. */
  features: readonly AiFeatureKey[];
  /** Detector ids (src/lib/findings/detectors) this employee owns. Empty is a
   *  legitimate answer: the Morning Briefer summarises whatever the nightly
   *  check found, it does not own any check of its own, and claiming otherwise
   *  on a page about honesty would be the first lie on it. */
  detectors: readonly string[];
  /** Scheduled-job names (src/app/api/cron/<name>) this employee needs in order
   *  to have anything to do. Their absence from the schedule registry is what
   *  makes an employee "ready — waiting for the master switch" rather than on. */
  crons: readonly string[];
  /** Where its work appears, said the way a person would say it. */
  surfaces: readonly Bilingual[];
}

export interface AiEmployee {
  id: string;
  name: Bilingual;
  /** One sentence. What this person would do if they were a person. */
  job: Bilingual;
  /** false = on the roster, not built. No status, no controls, no numbers. */
  hired: boolean;
  /** Empty for everyone not hired — there is nothing to bundle yet. */
  bundle: AiEmployeeBundle;
}

const NO_BUNDLE: AiEmployeeBundle = { features: [], detectors: [], crons: [], surfaces: [] };

/** A roster entry that is on the plan but not built. Kept as a helper so the
 *  twelve read as what they are — a list of names — instead of twelve copies of
 *  an empty bundle. */
function planned(id: string, name: Bilingual, job: Bilingual): AiEmployee {
  return { id, name, job, hired: false, bundle: NO_BUNDLE };
}

export const AI_EMPLOYEES: readonly AiEmployee[] = [
  // ── HIRED 2026-07-28 ──────────────────────────────────────────────────────
  //
  // The bundle is EMPTY of features, and that is the honest entry rather than
  // an oversight. This employee's only model work is reading a manager's
  // sentence about their suppliers ("food from Sysco by email, linens from
  // Guest Supply's site") into a structured list — and that happens inside a
  // normal chat turn, through `staxis_set_up_vendors`, billed to the chat's
  // own feature where it actually occurs.
  //
  // Bundling a feature key here anyway would have been worse than saying
  // nothing: `employeeSpend` sums only the keys in the bundle, so a key that
  // never receives an `agent_costs` row renders a confident $0.00 next to an
  // employee whose thinking does cost money. An empty `features` list takes
  // the `billed.length === 0` branch instead and the card reads "no separate
  // bill", which is true — the spend is real and it is on the copilot's line.
  // When this employee grows a model call of its own, that is the moment to
  // add the key, not before.
  //
  // Everything else it does — deciding what is worth ordering, ranking by
  // dollar impact, grouping by supplier, pricing from receipts — is
  // arithmetic over the hotel's own rows. No model is involved and none is
  // needed, which is why there are no detectors and no crons either.
  {
    id: 'ordering_manager',
    name: { en: 'Ordering Manager', es: 'Encargado de pedidos' },
    job: {
      en: 'Watches what is running low, works out what is worth ordering, and preps each supplier\'s order for a manager to send.',
      es: 'Vigila lo que se está acabando, calcula qué vale la pena pedir y prepara el pedido de cada proveedor para que el gerente lo envíe.',
    },
    hired: true,
    bundle: {
      features: [],
      detectors: [],
      crons: [],
      surfaces: [
        {
          en: 'The Ordering screen on the inventory page — what is worth ordering, grouped by supplier',
          es: 'La pantalla Pedidos en la página de inventario: lo que vale la pena pedir, agrupado por proveedor',
        },
        {
          en: 'The purchase-order email Staxis sends to a supplier on the hotel\'s behalf',
          es: 'El correo de pedido que Staxis envía a un proveedor de parte del hotel',
        },
      ],
    },
  },

  // ── THE ONLY ONE THAT EXISTS ──────────────────────────────────────────────
  //
  // The bundle is deliberately small and deliberately honest:
  //
  //   features  — `findings.brief` is the wording pass, and the ONLY model call
  //               anywhere in this employee's work. The brief itself is
  //               assembled from stored numbers by code before that call is
  //               made, and the prose guard throws the rewrite away whole if a
  //               figure appears in it that the assembly did not put there.
  //   detectors — none. It writes about what the nightly check found; it does
  //               not do any checking.
  //   crons     — `run-findings` is the nightly check. The brief itself needs no
  //               schedule (it is built on the first load of the hotel's own
  //               day), but a brief about a hotel nobody checked overnight is a
  //               brief with nothing to say. That dependency is why this
  //               employee reads "waiting for the master switch" today and not
  //               "on": the honest answer is that it is ready and its input is
  //               not running.
  //   surfaces  — two, and they are genuinely two different readers: the
  //               manager's morning card at one hotel, and the company brief a
  //               VP reads across all of theirs.
  {
    id: MORNING_BRIEFER_ID,
    name: { en: 'Morning Briefer', es: 'Informante de la mañana' },
    job: {
      en: 'Writes each manager\'s morning brief — what happened overnight, in a few lines, before anyone asks.',
      es: 'Escribe el resumen de la mañana de cada gerente: lo que pasó durante la noche, en pocas líneas, antes de que alguien pregunte.',
    },
    hired: true,
    bundle: {
      features: ['findings.brief'],
      detectors: [],
      crons: ['run-findings'],
      surfaces: [
        { en: 'The morning card at the top of a manager\'s Staxis tab', es: 'La tarjeta de la mañana arriba en la pestaña Staxis del gerente' },
        { en: 'The company morning summary an owner or VP reads', es: 'El resumen matutino de la empresa que lee un dueño o un VP' },
      ],
    },
  },

  planned(
    'night_auditor',
    { en: 'Night Auditor', es: 'Auditor nocturno' },
    {
      en: 'Reconciles the overnight totals, flags what does not add up, and has the audit pack ready before the morning shift.',
      es: 'Cuadra los totales de la noche, marca lo que no cuadra y deja el paquete de auditoría listo antes del turno de la mañana.',
    },
  ),
  planned(
    'bookkeeper',
    { en: 'Bookkeeper', es: 'Contable' },
    {
      en: 'Reads every bill that comes in, sorts the spending, and catches double charges and prices that crept up.',
      es: 'Lee cada factura que llega, clasifica el gasto y detecta cobros duplicados y precios que subieron sin avisar.',
    },
  ),
  planned(
    'review_manager',
    { en: 'Review Manager', es: 'Encargado de reseñas' },
    {
      en: 'Reads the guest reviews, drafts a reply in the hotel\'s own voice, and names the complaint that keeps coming back.',
      es: 'Lee las reseñas de los huéspedes, redacta una respuesta con la voz del hotel y señala la queja que se repite.',
    },
  ),
  planned(
    'rate_watcher',
    { en: 'Rate Watcher', es: 'Vigilante de tarifas' },
    {
      en: 'Compares your rates with the hotels nearby each day and suggests a change in plain words, for a manager to approve.',
      es: 'Compara tus tarifas con las de los hoteles cercanos cada día y sugiere un cambio en palabras sencillas, para que lo apruebe un gerente.',
    },
  ),
  planned(
    'pms_clerk',
    { en: 'PMS Clerk', es: 'Auxiliar del sistema del hotel' },
    {
      en: 'Types into the hotel\'s own booking system what staff already told Staxis, so nobody enters the same thing twice.',
      es: 'Escribe en el sistema de reservas del hotel lo que el personal ya le dijo a Staxis, para que nadie escriba lo mismo dos veces.',
    },
  ),
  planned(
    'arrivals_checker',
    { en: 'Arrivals Checker', es: 'Revisor de llegadas' },
    {
      en: 'Goes through tomorrow\'s arrivals looking for missing cards, duplicate bookings and the notes about guests who matter.',
      es: 'Revisa las llegadas de mañana buscando tarjetas que faltan, reservas duplicadas y las notas sobre huéspedes importantes.',
    },
  ),
  planned(
    'scheduler',
    { en: 'Scheduler', es: 'Planificador de turnos' },
    {
      en: 'Turns next week\'s expected occupancy into a draft housekeeping schedule, with a warning where it would run into overtime.',
      es: 'Convierte la ocupación prevista de la próxima semana en un borrador del horario de limpieza, con aviso donde habría horas extra.',
    },
  ),
  planned(
    'trainer',
    { en: 'Trainer', es: 'Formador' },
    {
      en: 'Answers a new hire\'s questions in their own language, using this hotel\'s real answers rather than a generic manual.',
      es: 'Responde las preguntas de alguien nuevo en su propio idioma, con las respuestas reales de este hotel y no un manual genérico.',
    },
  ),
  planned(
    'maintenance_planner',
    { en: 'Maintenance Planner', es: 'Planificador de mantenimiento' },
    {
      en: 'Turns the repair history into a plan for what to service before it breaks, and names the room that keeps breaking.',
      es: 'Convierte el historial de reparaciones en un plan de qué revisar antes de que se rompa, y señala la habitación que se sigue rompiendo.',
    },
  ),
  planned(
    'guest_messenger',
    { en: 'Guest Messenger', es: 'Mensajero de huéspedes' },
    {
      en: 'Answers the messages guests send before and during their stay, and hands over to a person when it should.',
      es: 'Responde los mensajes que envían los huéspedes antes y durante su estancia, y pasa la conversación a una persona cuando toca.',
    },
  ),
  planned(
    'floor_interpreter',
    { en: 'Floor Interpreter', es: 'Intérprete de planta' },
    {
      en: 'Lets a housekeeper say a room is done out loud, in their own language, with their hands full — and the front desk sees it in English.',
      es: 'Deja que una camarera diga en voz alta que una habitación está lista, en su idioma y con las manos ocupadas, y la recepción lo ve en inglés.',
    },
  ),
] as const;

// ─── What it runs, said in words ────────────────────────────────────────────
//
// The bundle names ids because ids are checkable. A person reading the page
// needs a sentence. This is the one map between them, and the roster-shape
// check below refuses a bundled id with no line here — so the card can never
// print `findings.brief` at the founder, and an employee can never quietly
// bundle something nobody wrote a sentence for.
//
// Deliberately NOT sourced from AI_FEATURE_REGISTRY's `label`/`description`.
// Those are written for the AI Control Center, where the reader is choosing a
// model and wants to know what a feature is. Here the reader is looking at a
// member of staff and wants to know what they do. Same key, different question,
// and they are English-only besides.

export const BUNDLE_LABELS: Readonly<Record<string, Bilingual>> = {
  // Features
  // The brief itself is English-only (founder ruling — src/lib/findings/brief.ts).
  // This LINE is still bilingual, like every other string on the AI Staff page:
  // the page is chrome and the house rule applies to it. What changed is what the
  // line claims, because it used to promise a Spanish brief that no longer exists.
  'findings.brief': {
    en: 'Rewrites the morning summary so it reads like a person wrote it — in English',
    es: 'Reescribe el resumen de la mañana para que suene a persona — en inglés',
  },
  // Scheduled jobs
  'run-findings': {
    en: 'The overnight check that gives the brief something to report',
    es: 'La revisión nocturna que le da al resumen algo que contar',
  },
};

export function bundleLabel(key: string): Bilingual | null {
  return BUNDLE_LABELS[key] ?? null;
}

// ─── Lookups ────────────────────────────────────────────────────────────────

const BY_ID = new Map(AI_EMPLOYEES.map((e) => [e.id, e]));

export function getAiEmployee(id: string): AiEmployee | null {
  return BY_ID.get(id) ?? null;
}

/** The ones that actually exist. Everything with a status, a switch or a number
 *  attached to it comes from here. */
export function hiredAiEmployees(): AiEmployee[] {
  return AI_EMPLOYEES.filter((e) => e.hired);
}

// ─── Status ─────────────────────────────────────────────────────────────────

/**
 * The four things an employee can honestly be.
 *
 * There is no 'idle', no 'healthy', no 'unknown'. Each of these is a claim the
 * page can back:
 *
 *   not_hired            — this is a name on a plan. Nothing runs.
 *   switched_off         — you turned it off. A row says so, and when.
 *   waiting_for_master   — it is built and switched on, and something it needs
 *                          is not scheduled. It will start when the master
 *                          switch goes on, and not before.
 *   on                   — everything it needs is scheduled and it is not
 *                          switched off.
 */
export type AiEmployeeStatus = 'not_hired' | 'switched_off' | 'waiting_for_master' | 'on';

export interface EmployeeStatusInput {
  employee: AiEmployee;
  /** True when a row in ai_employee_switches says the founder stopped it. */
  switchedOff: boolean;
  /** Scheduled-job names that currently have a schedule. Anything the employee
   *  needs that is not in here is what "waiting for the master switch" means. */
  scheduledCrons: ReadonlySet<string>;
}

export function deriveEmployeeStatus(input: EmployeeStatusInput): AiEmployeeStatus {
  const { employee, switchedOff, scheduledCrons } = input;
  if (!employee.hired) return 'not_hired';
  // The founder's own decision outranks everything else on the page. An
  // employee he switched off reads "switched off by you" whether or not its
  // machine happens to be running — the alternative would let a scheduling
  // detail overwrite the one status he set himself.
  if (switchedOff) return 'switched_off';
  const waiting = employee.bundle.crons.some((c) => !scheduledCrons.has(c));
  return waiting ? 'waiting_for_master' : 'on';
}

/** The status, said out loud, in both languages. Kept next to the derivation so
 *  a new status cannot ship without its sentence. */
export const EMPLOYEE_STATUS_LABEL: Readonly<Record<AiEmployeeStatus, Bilingual>> = {
  not_hired: { en: 'Not hired yet', es: 'Aún no contratado' },
  switched_off: { en: 'Switched off by you', es: 'Apagado por ti' },
  waiting_for_master: { en: 'Ready — waiting for the master switch', es: 'Listo — esperando el interruptor principal' },
  on: { en: 'On', es: 'Encendido' },
};

/**
 * The colour each status is drawn in. Values are the studio kit's DotTone
 * names, spelled out here rather than imported so this module stays free of
 * any component tree.
 *
 * It lives beside the sentence because two screens now show these statuses —
 * Mission Control's glance and the AI Staff page — and a status that is amber
 * on one and red on the other is a status nobody trusts. The AI Staff page
 * used to keep its own copy of both maps; that copy was one careless edit away
 * from the two screens disagreeing about whether an employee was off.
 */
export const EMPLOYEE_STATUS_TONE: Readonly<
  Record<AiEmployeeStatus, 'muted' | 'terracotta' | 'gold' | 'forest'>
> = {
  not_hired: 'muted',
  switched_off: 'terracotta',
  waiting_for_master: 'gold',
  on: 'forest',
};

// ─── Integrity ──────────────────────────────────────────────────────────────

export class AiEmployeeRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AiEmployeeRegistryError';
  }
}

const EMPLOYEE_ID_RE = /^[a-z][a-z0-9_]{2,63}$/;

/**
 * Everything about a roster entry that can be checked WITHOUT importing the
 * findings layer or touching the filesystem — so it runs at module load, in
 * the browser bundle, on every render of the page.
 *
 * Detector ids and scheduled-job names are checked by the standing test
 * instead: the detector registry pulls in every detector module (server code),
 * and a job name is a directory on disk. Both are real checks; neither belongs
 * in a bundle the browser downloads.
 */
export function assertEmployeeRosterShape(roster: readonly AiEmployee[]): void {
  const seen = new Set<string>();
  const featureKeys: ReadonlySet<string> = new Set<string>(AI_FEATURE_KEYS);

  for (const e of roster) {
    if (!EMPLOYEE_ID_RE.test(e.id)) {
      throw new AiEmployeeRegistryError(
        `AI employee id "${e.id}" must be lower_snake_case, 3-64 chars. It is the primary key of ` +
        'ai_employee_switches (0373), so a switch survives only as long as the id does.',
      );
    }
    if (seen.has(e.id)) {
      throw new AiEmployeeRegistryError(
        `AI employee "${e.id}" is listed twice. Two entries sharing an id would share one kill ` +
        'switch, so switching one off would silently switch off the other.',
      );
    }
    seen.add(e.id);

    for (const lang of ['en', 'es'] as const) {
      if (!e.name[lang]?.trim()) {
        throw new AiEmployeeRegistryError(`AI employee "${e.id}" has no ${lang} name.`);
      }
      if (!e.job[lang]?.trim()) {
        throw new AiEmployeeRegistryError(`AI employee "${e.id}" has no ${lang} job description.`);
      }
    }

    if (!e.hired) {
      // An unhired employee with a bundle would grow a status, a spend figure
      // and a switch on a page that promises it does not exist yet.
      const { features, detectors, crons, surfaces } = e.bundle;
      if (features.length || detectors.length || crons.length || surfaces.length) {
        throw new AiEmployeeRegistryError(
          `AI employee "${e.id}" is not hired but declares a bundle. An unhired employee must ` +
          'have nothing to show — the page renders it as a plan, not as work being done.',
        );
      }
      continue;
    }

    if (e.bundle.surfaces.length === 0) {
      throw new AiEmployeeRegistryError(
        `AI employee "${e.id}" is hired but names no surface. "What it writes" is the whole ` +
        'answer to what an employee does; an employee that writes nowhere is not one.',
      );
    }
    for (const key of e.bundle.features) {
      if (!featureKeys.has(key)) {
        throw new AiEmployeeRegistryError(
          `AI employee "${e.id}" bundles AI feature "${key}", which is not in the AI feature ` +
          'registry. Renaming a feature key without updating the employee that claims it would ' +
          'leave a card describing work nothing does.',
        );
      }
    }

    for (const key of [...e.bundle.features, ...e.bundle.detectors, ...e.bundle.crons]) {
      const label = BUNDLE_LABELS[key];
      if (!label?.en?.trim() || !label?.es?.trim()) {
        throw new AiEmployeeRegistryError(
          `AI employee "${e.id}" bundles "${key}" with no readable line in BUNDLE_LABELS ` +
          '(both languages). The card would have to print the internal id at the reader.',
        );
      }
    }
  }
}

assertEmployeeRosterShape(AI_EMPLOYEES);
