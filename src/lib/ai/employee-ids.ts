// The employee ids that CODE refers to by name.
//
// Separate from employee-registry.ts on purpose. The registry is the roster —
// thirteen names, their job descriptions, their bundles — and a generation path
// deep in the findings layer has no business importing all of that to ask one
// question. This file is the shared vocabulary between the two: the registry
// declares an employee with this id, the generation paths ask about this id,
// and the roster-integrity test asserts they are the same string.
//
// Renaming one of these is a database migration, not an edit: the id is the
// primary key of `ai_employee_switches` (0373), so a rename orphans whatever
// the founder switched off. The test will say so.

/** Writes each manager's morning brief. The first AI employee. */
export const MORNING_BRIEFER_ID = 'morning_briefer';

/** Every id code refers to by name. The integrity test walks this list and
 *  fails if the registry has stopped declaring one of them. */
export const NAMED_EMPLOYEE_IDS: readonly string[] = [MORNING_BRIEFER_ID];
