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
 * SPEND IS REAL OR ABSENT. The only ledger with a per-feature column is
 * `findings_ai_spend` (0361), and only its `finalized` rows are reconciled to
 * what a provider actually charged — `reserved` rows are worst-case holds. So
 * this sums finalized rows for the bundled features that ledger tracks, and
 * says plainly which ones it does not. There is no estimate anywhere in here:
 * an employee whose features are untracked reports `usd: null` and the page
 * sends the reader to the Money tab rather than printing a number nothing backs.
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
import { FEATURE_CAP_SHARE } from '@/lib/findings/judge-budget';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 20;

const NO_STORE = { 'Cache-Control': 'no-store' } as const;

/** How far back the spend figure looks. Matches the AI recommendations screen's
 *  window so two admin surfaces quoting "recent AI spend" mean the same thing. */
const SPEND_WINDOW_DAYS = 30;

/** Row ceiling on the spend read — the same bound the model-spend roll-up uses.
 *  A cap that is hit is reported as such rather than quietly under-counting. */
const SPEND_ROW_CAP = 20_000;

/** The feature keys `findings_ai_spend` actually carries a row for. Derived
 *  from the cap-share table rather than typed out again: a feature that gets a
 *  share of the findings cap is exactly a feature that books to that ledger. */
const SPEND_TRACKED_FEATURES: ReadonlySet<string> = new Set(Object.keys(FEATURE_CAP_SHARE));

interface RunLine {
  /** Kept for the integrity test and for debugging; the UI renders `label`. */
  key: string;
  kind: 'feature' | 'detector' | 'cron';
  label: Bilingual;
  /** Only meaningful for kind='cron': is this job actually scheduled today. */
  scheduled?: boolean;
}

interface EmployeeSpend {
  /** false when nothing in this employee's bundle books to a per-feature
   *  ledger. The page shows the feature list and a link, not a number. */
  known: boolean;
  usd: number | null;
  windowDays: number;
  /** Bundled features whose spend no ledger separates out. Named so the reader
   *  knows the number is partial rather than wrong. */
  untracked: string[];
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
 * Real dollars per feature key, last `SPEND_WINDOW_DAYS`.
 *
 * `finalized` only. A `reserved` row is a hold priced at the worst case the
 * caller could have cost, sitting there until the call comes back — including
 * it would report money that was never spent, on the one screen whose figures
 * are supposed to be checkable.
 *
 * Returns null when the read failed, which the caller renders as "we could not
 * work it out" rather than as zero. Zero is a claim.
 */
async function spendByFeature(): Promise<Map<string, number> | null> {
  const since = new Date(Date.now() - SPEND_WINDOW_DAYS * 86_400_000).toISOString();
  const { data, error } = await supabaseAdmin
    .from('findings_ai_spend')
    .select('feature, cost_usd')
    .in('feature', [...SPEND_TRACKED_FEATURES])
    .eq('state', 'finalized')
    .gte('created_at', since)
    .limit(SPEND_ROW_CAP);
  if (error) return null;

  const totals = new Map<string, number>();
  for (const row of (data ?? []) as Array<{ feature: string; cost_usd: number | string }>) {
    const usd = typeof row.cost_usd === 'number' ? row.cost_usd : Number(row.cost_usd);
    if (!Number.isFinite(usd)) continue;
    totals.set(row.feature, (totals.get(row.feature) ?? 0) + usd);
  }
  return totals;
}

function employeeSpend(e: AiEmployee, totals: Map<string, number> | null): EmployeeSpend | null {
  if (!e.hired) return null;
  const untracked = e.bundle.features.filter((k) => !SPEND_TRACKED_FEATURES.has(k));
  const tracked = e.bundle.features.filter((k) => SPEND_TRACKED_FEATURES.has(k));
  if (totals === null || tracked.length === 0) {
    return { known: false, usd: null, windowDays: SPEND_WINDOW_DAYS, untracked: [...untracked] };
  }
  // Rounded to the cent it is quoted in. The ledger stores six decimal places
  // because a single Haiku call costs a fraction of one.
  const sum = tracked.reduce((acc, k) => acc + (totals.get(k) ?? 0), 0);
  return {
    known: true,
    usd: Math.round(sum * 100) / 100,
    windowDays: SPEND_WINDOW_DAYS,
    untracked: [...untracked],
  };
}

export async function GET(req: NextRequest) {
  const requestId = getOrMintRequestId(req);

  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;

  const [switches, totals] = await Promise.all([
    readEmployeeSwitchesFresh(),
    spendByFeature(),
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
      spendSource: 'Finalised model spend booked by the findings layer',
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
