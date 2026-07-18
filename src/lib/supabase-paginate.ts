// Page through a PostgREST query that may exceed the server row cap.
//
// This project's PostgREST caps EVERY response at 1000 rows regardless of
// .limit() (verified empirically 2026-07-18: a limit=2000 request returned
// exactly 1000). Any query that can exceed that — count history, a month of
// delivery rows, reconciliation logs — must page with .range() or it will
// silently sum/list only the first 1000 rows.
//
// Client-agnostic: the caller supplies a page builder using whichever
// Supabase client (anon or admin) and filters it needs. The builder MUST
// apply a stable .order(...) — PostgREST ranges without an explicit order
// are not guaranteed stable across pages.

export const SUPABASE_PAGE_SIZE = 1000;

// Runaway backstop, far above any real per-property dataset today.
const DEFAULT_MAX_ROWS = 60_000;

export async function fetchAllRows<T>(
  makePage: (fromRow: number, toRow: number) => PromiseLike<{ data: T[] | null; error: unknown }>,
  opts: { maxRows?: number } = {},
): Promise<T[]> {
  const maxRows = opts.maxRows ?? DEFAULT_MAX_ROWS;
  const out: T[] = [];
  while (out.length < maxRows) {
    const from = out.length;
    const to = Math.min(from + SUPABASE_PAGE_SIZE, maxRows) - 1;
    const { data, error } = await makePage(from, to);
    if (error) throw error;
    const rows = data ?? [];
    out.push(...rows);
    // A short page means we've reached the end. (A page can come back short
    // of PAGE_SIZE either because the data ran out or because maxRows
    // truncated the request — both terminate.)
    if (rows.length < to - from + 1) break;
  }
  return out;
}
