-- 0284_pms_tolerant_contextual_nullable.sql
-- feature/cua-tolerant-mapper — Part A3: relax the DB so derived/blank
-- CONTEXTUAL/demoted columns write instead of rejecting a whole row.
--
-- Root cause: on a Choice Advantage "View Arrivals" page the date columns are
-- PAGE CONTEXT (the page IS today's arrivals), so arrival_date/departure_date
-- come back blank per-row. The writer (generic-table-writer.validateRows) reads
-- `required`/`nullable` from the pms_table_schemas descriptor; with the dates
-- marked required:true,nullable:false every blank-date row was rejected and the
-- feed wrote 0 rows. The mapper now derives these from the run/view date
-- (template-runner.applyDerivedContextColumns) and tiers them as
-- contextual/optional (target-contract.ts), so the descriptor must agree: a
-- blank/derived date must be writable.
--
-- This mirrors the new ESSENTIALS contract:
--   pms_reservations  essentials = {pms_reservation_id, guest_name}
--   pms_work_orders_v2 essentials = {pms_work_order_id, description}
-- so descriptor.required == requiredLearnedFor() for both (gate ⇄ writer ⇄ DB
-- coherence — a gate-promoted feed can always write its essentials, and the DB
-- never rejects a row for a column the gate treats as derived/optional).
--
-- SURGICAL: we only flip `required`/`nullable` on the named columns via jsonb
-- `||` (key override), preserving every other key (allowed_values widened by
-- 0255/0258, range_*). Re-seeding the array would silently revert those.
--
-- Safe + additive: existing rows already satisfy the looser constraint; the
-- only table-level change is dropping NOT NULL on pms_work_orders_v2.status
-- (reservations dates + pms_work_orders_v2.out_of_order are already nullable in
-- the table — see 0202). oracle-verify keeps its STRICT api-upgrade proof
-- (target-contract CoreColumn.required is unchanged for these columns), so a
-- DOM→api upgrade must still corroborate them; only the tolerant DOM-feed
-- promotion + write path is relaxed.

begin;

-- ── Table: drop the only remaining NOT NULL among the demoted columns ──
-- pms_reservations.arrival_date / departure_date: already nullable (0202).
-- pms_work_orders_v2.out_of_order: already nullable, default false (0202).
-- pms_work_orders_v2.status: NOT NULL default 'open' (0202) → drop NOT NULL.
-- The CHECK (status in (...)) passes on NULL, so no constraint change needed.
alter table public.pms_work_orders_v2 alter column status drop not null;

-- ── Descriptor: pms_reservations — arrival_date + departure_date ──
update public.pms_table_schemas
set columns = (
  select jsonb_agg(
    case
      when elem->>'name' in ('arrival_date', 'departure_date')
        then elem || jsonb_build_object('required', false, 'nullable', true)
      else elem
    end
    order by ord
  )
  from jsonb_array_elements(columns) with ordinality as t(elem, ord)
)
where table_name = 'pms_reservations';

-- ── Descriptor: pms_work_orders_v2 — status + out_of_order ──
update public.pms_table_schemas
set columns = (
  select jsonb_agg(
    case
      when elem->>'name' in ('status', 'out_of_order')
        then elem || jsonb_build_object('required', false, 'nullable', true)
      else elem
    end
    order by ord
  )
  from jsonb_array_elements(columns) with ordinality as t(elem, ord)
)
where table_name = 'pms_work_orders_v2';

commit;

-- PostgREST caches the schema; reload so the relaxed descriptor + dropped
-- NOT NULL are visible immediately.
notify pgrst, 'reload schema';
