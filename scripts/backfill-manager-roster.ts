/**
 * Put existing hotel managers on the staff lists they were never added to.
 *
 * From today, accepting a manager invitation joins that hotel's staff list on
 * the way in (src/lib/schedule/staff-identity.ts). Every manager who accepted
 * BEFORE that still has a login and no roster row, which is why the to-do Who
 * list cannot see them. This is the one-off repair for those people, plus the
 * duplicate cleanup for the rows Communications minted along the way.
 *
 * DRY RUN BY DEFAULT. Nothing is written until `--apply`. It is safe to run
 * twice: the underlying operation adopts an existing row rather than making a
 * second one, so a second run reports "adopted" everywhere and writes nothing
 * new.
 *
 *   # look, change nothing (start here)
 *   npx tsx --conditions=react-server scripts/backfill-manager-roster.ts
 *
 *   # one hotel only
 *   npx tsx --conditions=react-server scripts/backfill-manager-roster.ts --property=<uuid>
 *
 *   # actually write
 *   npx tsx --conditions=react-server scripts/backfill-manager-roster.ts --apply
 *
 *   # list same-name active roster rows a human should look at
 *   npx tsx --conditions=react-server scripts/backfill-manager-roster.ts --report-duplicates
 *
 * WHO IT TOUCHES. Only accounts that hold a hotel-scoped manager job at the
 * hotel: a property-scope general_manager hat covering it, or, at a hotel with
 * no management company, an owner/general_manager login whose canonical access
 * reaches it. Company-scope people (owner / VP / finance over a whole company)
 * are deliberately skipped: they oversee hotels, they do not work at them, and
 * My Hotel lists them in its own Company section. Housekeepers, front desk and
 * maintenance are never touched.
 *
 * WHAT IT DOES NOT DO. It never matches people by name. Two active roster rows
 * that merely share a spelling are not provably the same human, and this
 * codebase has refused name-based identity everywhere else for good reasons.
 * `--report-duplicates` prints those so a person can decide; nothing archives
 * them automatically.
 *
 * Exit codes: 0 nothing left to do / all requested work done, 1 at least one
 * hotel or person failed, 2 configuration or connection failure.
 */

import { loadEnv } from './load-env';

interface Args {
  apply: boolean;
  propertyId: string | null;
  reportDuplicates: boolean;
}

function parseArgs(argv: readonly string[]): Args {
  const args: Args = { apply: false, propertyId: null, reportDuplicates: false };
  for (const raw of argv) {
    if (raw === '--apply') args.apply = true;
    else if (raw === '--report-duplicates') args.reportDuplicates = true;
    else if (raw.startsWith('--property=')) args.propertyId = raw.slice('--property='.length).trim();
  }
  return args;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface PlannedPerson {
  accountId: string;
  displayName: string;
  authUserId: string;
  reason: 'property_manager_hat' | 'independent_hotel_manager';
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  loadEnv();

  if (args.propertyId && !UUID.test(args.propertyId)) {
    console.error('✗ --property must be a hotel id (uuid).');
    process.exit(2);
  }

  // Imported lazily: these modules validate env at load time, so the loader
  // above has to have run first.
  const { supabaseAdmin } = await import('../src/lib/supabase-admin');
  const { loadAuthoritativeHotelRoster } = await import('../src/lib/authorization/hotel-account-roster');
  const { loadHatsForAccounts } = await import('../src/lib/company/access');
  const { ensureManagerStaffIdentity, isHotelScopedManagerGrant } = await import(
    '../src/lib/schedule/staff-identity'
  );

  const propertyQuery = supabaseAdmin.from('properties').select('id, name').order('name');
  const { data: propertyRows, error: propertyError } = args.propertyId
    ? await propertyQuery.eq('id', args.propertyId)
    : await propertyQuery;
  if (propertyError || !Array.isArray(propertyRows)) {
    console.error(`✗ Could not list hotels: ${propertyError?.message ?? 'no rows'}`);
    process.exit(2);
  }
  if (propertyRows.length === 0) {
    console.error('✗ No hotel matched.');
    process.exit(2);
  }

  console.log(
    args.apply
      ? `APPLYING to ${propertyRows.length} hotel(s). Writes are real.`
      : `DRY RUN over ${propertyRows.length} hotel(s). Nothing will be written. Add --apply to commit.`,
  );

  let failures = 0;
  let created = 0;
  let adopted = 0;
  let deduped = 0;

  for (const property of propertyRows as Array<{ id: string; name: string }>) {
    const hotelId = String(property.id);
    const hotelName = String(property.name ?? hotelId);

    let roster;
    try {
      roster = await loadAuthoritativeHotelRoster(hotelId, false);
    } catch (error) {
      failures += 1;
      console.error(`  ! ${hotelName}: roster unavailable (${(error as Error).message})`);
      continue;
    }

    const activeAccounts = roster.accounts.filter(
      (account) => account.active && account.role !== 'admin',
    );
    if (activeAccounts.length === 0) continue;

    let hats: Awaited<ReturnType<typeof loadHatsForAccounts>>;
    try {
      hats = await loadHatsForAccounts(activeAccounts.map((account) => account.accountId));
    } catch (error) {
      failures += 1;
      console.error(`  ! ${hotelName}: company jobs unavailable (${(error as Error).message})`);
      continue;
    }

    const planned: PlannedPerson[] = [];
    for (const account of activeAccounts) {
      const accountHats = hats.get(account.accountId) ?? [];
      const managerHat = accountHats.some((hat) => (
        isHotelScopedManagerGrant({
          role: hat.role,
          membershipScope: hat.scope,
          organizationId: hat.organizationId,
        })
        && hat.coveredPropertyIds.includes(hotelId)
      ));
      // A hotel with no management company has no hats at all. There the login
      // word IS the job, and canonical access already proves the hotel.
      const independentManager = accountHats.length === 0
        && isHotelScopedManagerGrant({
          role: account.role,
          membershipScope: null,
          organizationId: null,
        })
        && account.propertyIds.includes(hotelId);
      if (!managerHat && !independentManager) continue;
      planned.push({
        accountId: account.accountId,
        displayName: account.displayName,
        authUserId: account.dataUserId,
        reason: managerHat ? 'property_manager_hat' : 'independent_hotel_manager',
      });
    }

    if (args.reportDuplicates) {
      const { data: staffRows, error: staffError } = await supabaseAdmin
        .from('staff')
        .select('id, name, department, created_at')
        .eq('property_id', hotelId)
        .eq('is_active', true);
      if (staffError) {
        failures += 1;
        console.error(`  ! ${hotelName}: staff list unavailable (${staffError.message})`);
      } else {
        const byName = new Map<string, string[]>();
        for (const row of (staffRows ?? []) as Array<{ id: string; name: string }>) {
          const key = String(row.name ?? '').trim().toLocaleLowerCase();
          if (!key) continue;
          byName.set(key, [...(byName.get(key) ?? []), String(row.id)]);
        }
        for (const [name, ids] of byName) {
          if (ids.length > 1) {
            console.log(`  ? ${hotelName}: ${ids.length} active rows named "${name}" -> ${ids.join(', ')}`);
          }
        }
      }
    }

    if (planned.length === 0) continue;
    console.log(`  ${hotelName} (${hotelId}): ${planned.length} manager(s)`);

    for (const person of planned) {
      if (!args.apply) {
        console.log(`    - ${person.displayName} [${person.reason}] would be ensured`);
        continue;
      }
      try {
        const result = await ensureManagerStaffIdentity({
          accountId: person.accountId,
          propertyId: hotelId,
          authUserId: person.authUserId,
          displayName: person.displayName,
          actorAccountId: null,
          source: 'system',
        });
        if (result.outcome === 'created') created += 1;
        if (result.outcome === 'adopted') adopted += 1;
        if (result.outcome === 'deduped') deduped += 1;
        console.log(
          `    - ${person.displayName}: ${result.outcome} -> ${result.staffId}`
          + (result.archivedStaffIds.length > 0
            ? ` (archived ${result.archivedStaffIds.join(', ')})`
            : ''),
        );
      } catch (error) {
        failures += 1;
        console.error(`    ! ${person.displayName}: ${(error as Error).message}`);
      }
    }
  }

  if (args.apply) {
    console.log(`\nDone. created=${created} adopted=${adopted} deduped=${deduped} failed=${failures}`);
  } else {
    console.log('\nDry run complete. Re-run with --apply to write.');
  }
  process.exit(failures > 0 ? 1 : 0);
}

main().catch((error: unknown) => {
  console.error(`✗ ${(error as Error).message}`);
  process.exit(2);
});
