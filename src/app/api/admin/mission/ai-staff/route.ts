/**
 * /api/admin/mission/ai-staff — the founder's AI Staff roster.
 *
 * FOUNDER ONLY, like its neighbour /api/admin/mission/promotions and for the
 * same reason: `requireAdmin` (session + role='admin'), never
 * `requireAdminOrCron`. No cron drives this, and the shared CRON_SECRET has too
 * many holders for a surface that names which of Staxis's own employees is
 * switched off. A hotel must never learn this page exists.
 *
 *   GET  → { employees[], windowDays, spendSource, asOf }
 *   POST → { employeeId, switchedOff: boolean, note? } → { employee }
 *
 * THE POST CANNOT START ANYTHING. `switchedOff: false` clears an override; it
 * does not schedule a job, wake a worker, or change a default. Everything that
 * is off today is still off after every call this route can serve. The master
 * switch — the one that turns the machine on at launch — is vercel.json and the
 * schedule registry, and it is the founder's to flip by hand.
 *
 * STATUS IS DERIVED, NEVER STORED. `deriveEmployeeStatus` answers from three
 * facts: is it built, did the founder switch it off, and is everything it needs
 * actually scheduled. A stored status could go stale against any of them and
 * would then be a claim the page cannot back.
 *
 * ─── SPEND: WHICH LEDGER, AND WHY ONLY ONE ─────────────────────────────────
 *
 * TWO ledgers record the judge, the sweep and the brief. They are not
 * duplicates of each other, and only one of them is money:
 *
 *   agent_costs (0080, + `feature` since 0374)  — THE BOOKS. One row per
 *     provider call Staxis actually paid for, reconciled to real usage.
 *   findings_ai_spend (0361)                    — THE GATE. A per-hotel daily
 *     ceiling for background work. Its rows are worst-case HOLDS, taken before
 *     the call and released or reconciled after. 0361 says so in its own table
 *     comment: "This is the GATE; the books are still agent_costs."
 *
 * This route sums THE BOOKS and nothing else. Summing both would count all
 * three findings features twice — every one of them takes a hold AND writes a
 * real row. Summing the gate alone (what this route did before 0374, because
 * it was the only ledger with a feature column) both quoted hold-shaped money
 * and could only ever describe three features, so employee #2's card would
 * have been blank for a reason no reader could have guessed.
 *
 * FINALIZED ROWS ONLY, and swept rows excluded — the same two filters
 * /api/agent/metrics uses. A `reserved` row is a hold on a call still in
 * flight; a swept row is a hold the sweeper recovered from a crash. Neither is
 * money that was charged.
 *
 * FLEET-WIDE ON PURPOSE. There is no property filter: this is the founder's own
 * Anthropic bill for a named job across every hotel, which is the question the
 * page asks. No hotel can see another's spend here because no hotel can reach
 * this route at all — `requireAdmin` is the wall, and the integration suite
 * drives a real general-manager account at it to prove the refusal.
 *
 * NOTHING IS ESTIMATED. `agent_costs.feature` is NULL for every row written
 * before 0374 and is never backfilled, so the payload reports
 * `attributionStartedAt` — the moment the ledger began answering "what for".
 * A card showing a small number in the first weeks is then reading as "this is
 * what we have measured", not as "this was nearly free".
 *
 * Migration 0373 is applied by hand, so both verbs survive the switches table
 * being absent: GET reports every employee as on (which is what no switches
 * means), and POST answers with a plain sentence instead of a 500.
 */

import { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { requireAdmin } from '@/lib/admin-auth';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId } from '@/lib/log';
import { validateString } from '@/lib/api-validate';
import {
  AI_EMPLOYEES,
  bundleLabel,
  deriveEmployeeStatus,
  getAiEmployee,
  type AiEmployee,
  type AiEmployeeStatus,
  type Bilingual,
} from '@/lib/ai/employee-registry';
import {
  readEmployeeSwitchesFresh,
  scheduledCronNames,
  setEmployeeSwitch,
} from '@/lib/ai/employee-switches';
import {
  SPEND_WINDOW_DAYS,
  billedBundleKeys,
  employeeSpend,
  type EmployeeSpend,
} from '@/lib/ai/employee-spend';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 20;

const NO_STORE = { 'Cache-Control': 'no-store' } as const;

/** Row ceiling on the spend read — the same bound the model-spend roll-up uses.
 *  A cap that is hit is reported as such rather than quietly under-counting. */
const SPEND_ROW_CAP = 20_000;

interface RunLine {
  /** Kept for the integrity test and for debugging; the UI renders `label`. */
  key: string;
  kind: 'feature' | 'detector' | 'cron';
  label: Bilingual;
  /** Only meaningful for kind='cron': is this job actually scheduled today. */
  scheduled?: boolean;
}

interface EmployeeView {
  id: string;
  name: Bilingual;
  job: Bilingual;
  hired: boolean;
  status: AiEmployeeStatus;
  switchedOff: boolean;
  switchedOffAt: string | null;
  note: string | null;
  runs: RunLine[];
  /** Where the work shows up, already in both languages — the registry writes
   *  these as sentences, so nothing has to be translated at render time. */
  surfaces: Bilingual[];
  spend: EmployeeSpend | null;
}

function runLines(e: AiEmployee, scheduled: ReadonlySet<string>): RunLine[] {
  if (!e.hired) return [];
  const lines: RunLine[] = [];
  for (const key of e.bundle.features) {
    const label = bundleLabel(key);
    if (label) lines.push({ key, kind: 'feature', label });
  }
  for (const key of e.bundle.detectors) {
    const label = bundleLabel(key);
    if (label) lines.push({ key, kind: 'detector', label });
  }
  for (const key of e.bundle.crons) {
    const label = bundleLabel(key);
    if (label) lines.push({ key, kind: 'cron', label, scheduled: scheduled.has(key) });
  }
  return lines;
}

/**
 * Real dollars per feature key, last `SPEND_WINDOW_DAYS`, from THE BOOKS.
 *
 * `finalized` and unswept only — see the header. A `reserved` row is a hold
 * priced at the worst case the caller could have cost, sitting there until the
 * call comes back; a swept row is such a hold after the sweeper gave up on it.
 * Including either would report money that was never spent, on the one screen
 * whose figures are supposed to be checkable.
 *
 * Returns null when the read failed, which the caller renders as "we could not
 * work it out" rather than as zero. Zero is a claim.
 */
async function spendByFeature(keys: string[]): Promise<Map<string, number> | null> {
  if (keys.length === 0) return new Map();
  const since = new Date(Date.now() - SPEND_WINDOW_DAYS * 86_400_000).toISOString();
  const { data, error } = await supabaseAdmin
    .from('agent_costs')
    .select('feature, cost_usd')
    .in('feature', keys)
    .eq('state', 'finalized')
    .is('swept_at', null)
    .gte('created_at', since)
    .limit(SPEND_ROW_CAP);
  if (error) return null;

  const totals = new Map<string, number>();
  for (const row of (data ?? []) as Array<{ feature: string | null; cost_usd: number | string }>) {
    if (!row.feature) continue;
    const usd = typeof row.cost_usd === 'number' ? row.cost_usd : Number(row.cost_usd);
    if (!Number.isFinite(usd)) continue;
    totals.set(row.feature, (totals.get(row.feature) ?? 0) + usd);
  }
  return totals;
}

/**
 * When the ledger started answering "what for" — the oldest row that carries a
 * feature at all.
 *
 * One row, off the partial index 0374 creates, and it is what keeps the figures
 * honest through the changeover. Everything spent before that migration is
 * NULL and stays NULL (guessing which job a historical row was for would put
 * invented money on this page permanently), so without this date a card in the
 * first weeks would quote a fortnight of measurement as though it were a
 * month's bill.
 *
 * `null` means nothing is attributed yet. `undefined` means the read failed and
 * the page should say nothing rather than imply a date it does not have.
 */
async function attributionStartedAt(): Promise<string | null | undefined> {
  const { data, error } = await supabaseAdmin
    .from('agent_costs')
    .select('created_at')
    .not('feature', 'is', null)
    .order('created_at', { ascending: true })
    .limit(1);
  if (error) return undefined;
  const row = (data ?? [])[0] as { created_at?: string } | undefined;
  return row?.created_at ?? null;
}

export async function GET(req: NextRequest) {
  const requestId = getOrMintRequestId(req);

  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;

  const [switches, totals, attributedSince] = await Promise.all([
    readEmployeeSwitchesFresh(),
    spendByFeature(billedBundleKeys()),
    attributionStartedAt(),
  ]);
  const scheduled = scheduledCronNames();

  const employees: EmployeeView[] = AI_EMPLOYEES.map((e) => {
    const row = switches?.get(e.id) ?? null;
    const switchedOff = row?.switchedOff === true;
    return {
      id: e.id,
      name: e.name,
      job: e.job,
      hired: e.hired,
      status: deriveEmployeeStatus({ employee: e, switchedOff, scheduledCrons: scheduled }),
      switchedOff,
      switchedOffAt: row?.switchedOffAt ?? null,
      note: row?.note ?? null,
      runs: runLines(e, scheduled),
      surfaces: e.hired ? [...e.bundle.surfaces] : [],
      spend: employeeSpend(e, totals),
    };
  });

  return ok(
    {
      employees,
      windowDays: SPEND_WINDOW_DAYS,
      // The page says where the money figure came from, in its own words, so
      // nobody has to trust an unattributed number.
      spendSource: 'Finalised model spend, booked to the AI ledger by job',
      // When the ledger began recording which job spent what. Null = nothing is
      // attributed yet; undefined (omitted) = the read failed and the page must
      // not imply a date. Everything older than this is real money the ledger
      // cannot say the job for, and never will be — so a figure that looks low
      // this month has a stated reason instead of an unstated one.
      attributedSince: attributedSince ?? null,
      attributionReadable: attributedSince !== undefined,
      // null means the switch table could not be read. The page says so rather
      // than drawing thirteen confident green dots.
      switchesReadable: switches !== null,
      asOf: new Date().toISOString(),
    },
    { requestId, headers: NO_STORE },
  );
}

export async function POST(req: NextRequest) {
  const requestId = getOrMintRequestId(req);

  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return err('Send a JSON body.', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }
  const raw = (body ?? {}) as Record<string, unknown>;

  const idV = validateString(raw.employeeId, { max: 64, label: 'employeeId' });
  if (idV.error) {
    return err(idV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }
  // Strictly a boolean. A truthy string would let "false" switch an employee
  // OFF, which is the one direction that must never happen by accident.
  if (typeof raw.switchedOff !== 'boolean') {
    return err('switchedOff must be true or false', {
      requestId, status: 400, code: ApiErrorCode.ValidationFailed,
    });
  }
  const switchedOffWanted: boolean = raw.switchedOff;

  let note: string | null = null;
  if (raw.note !== undefined && raw.note !== null) {
    const noteV = validateString(raw.note, { max: 500, label: 'note', allowEmpty: true });
    if (noteV.error) {
      return err(noteV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
    }
    note = noteV.value!.trim() || null;
  }

  const employee = getAiEmployee(idV.value!);
  if (!employee) {
    return err('No such AI employee.', { requestId, status: 404, code: ApiErrorCode.NotFound });
  }
  // A switch on an employee that does not exist would be a control over
  // nothing, and a row in the table nothing ever reads.
  if (!employee.hired) {
    return err('That one is not hired yet — there is nothing to switch off.', {
      requestId,
      status: 409,
      code: ApiErrorCode.ValidationFailed,
    });
  }

  const result = await setEmployeeSwitch({
    employeeId: employee.id,
    switchedOff: switchedOffWanted,
    byAccountId: auth.accountId,
    note,
  });
  if (!result.ok) {
    return err(result.reason, { requestId, status: 500, code: ApiErrorCode.InternalError });
  }

  const switches = await readEmployeeSwitchesFresh();
  const row = switches?.get(employee.id) ?? null;
  const switchedOff = row?.switchedOff === true;
  const scheduled = scheduledCronNames();

  return ok(
    {
      employee: {
        id: employee.id,
        switchedOff,
        switchedOffAt: row?.switchedOffAt ?? null,
        note: row?.note ?? null,
        status: deriveEmployeeStatus({ employee, switchedOff, scheduledCrons: scheduled }),
      },
    },
    { requestId, headers: NO_STORE },
  );
}
