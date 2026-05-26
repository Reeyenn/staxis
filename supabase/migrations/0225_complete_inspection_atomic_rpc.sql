-- ═══════════════════════════════════════════════════════════════════════════
-- 0225 — complete_inspection_atomic RPC: transactional inspection finalize
--
-- Closes the last deferred Major from the inspections post-merge sweep:
-- finalizeInspection (TS, src/lib/inspections/correction-loop.ts) used to
-- do FOUR sequential supabaseAdmin calls — inspections UPDATE, rooms
-- UPDATE, cleaning_tasks UPDATE, parent inspections UPDATE — with no
-- transactional boundary between them. A network error or DB hiccup
-- after the first write left the inspection row marked pass/fail while
-- rooms.status and cleaning_tasks.status stayed stale.
--
-- The earlier C1 fix added log.error visibility on each individual
-- failure (so partial inconsistencies surface in Sentry instead of
-- being silent) but did NOT add atomicity. This migration adds the
-- atomic version: one plpgsql SECURITY DEFINER function, one implicit
-- transaction, all-or-nothing.
--
-- Signature:
--   complete_inspection_atomic(
--     p_inspection_id           uuid,
--     p_property_id             uuid,    -- guard
--     p_result                  text,    -- 'pass' | 'fail'
--     p_failed_items            jsonb,   -- array of {item_id, label, severity, photo_url, photo_path?, note}
--     p_passed_items            jsonb,   -- array of item_id strings
--     p_notes                   text,
--     p_escalated               boolean,
--     p_escalation_reason       text,
--     p_correction_notice_sent_at timestamptz,  -- null on pass
--     p_correction_note         text     -- pre-built room/cleaning_task note on fail; null on pass
--   )
--   returns inspections (the finalized row)
--
-- Behaviour:
--   - Locks the inspection row FOR UPDATE so two concurrent completes
--     serialize (rather than the second silently overwriting the first).
--   - Guards on property_id (cross-property protection from the earlier
--     post-merge sweep) and on result='in_progress' (double-complete
--     guard).
--   - Updates inspections row with the final state.
--   - On pass: rooms.status='inspected' + inspected_at=now (best-effort
--     scoped to the room owned by THIS property); cleaning_tasks.status
--     ='inspected_pass' (best-effort, scoped by property + id).
--   - On fail: rooms.status='dirty' + completed_at=null + issue_note=
--     correction_note; cleaning_tasks.status='correction_pending' +
--     priority='high' + notes=correction_note.
--   - Parent recheck_inspection_id is set if this was itself a recheck,
--     scoped to same property.
--   - Returns the finalized inspections row.
--
-- Errors:
--   E_NOT_FOUND               inspection_id doesn't exist or belongs to a different property
--   E_ALREADY_FINALIZED       result is not 'in_progress' at the time of the call
--   E_BAD_RESULT              p_result is not 'pass' or 'fail'
--   E_ROOM_PROPERTY_MISMATCH  v_row.room_id does not belong to p_property_id (rollback)
--   E_TASK_PROPERTY_MISMATCH  v_row.cleaning_task_id does not belong to p_property_id (rollback)
--
-- Security:
--   SECURITY DEFINER with `set search_path = public, pg_temp` (per the
--   audit-security-definer-search-path lint check). Granted to
--   service_role only — both /api/housekeeping/inspections/[id]/complete
--   and /api/housekeeper/inspections/[id]/complete are the only callers.
--   Browser/anon callers get nothing.
--
-- Manual prod apply per project_migration_application_manual.md.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function public.complete_inspection_atomic(
  p_inspection_id              uuid,
  p_property_id                uuid,
  p_result                     text,
  p_failed_items               jsonb,
  p_passed_items               jsonb,
  p_notes                      text,
  p_escalated                  boolean,
  p_escalation_reason          text,
  p_correction_notice_sent_at  timestamptz,
  p_correction_note            text
)
returns public.inspections
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row    public.inspections;
  v_count  integer;
begin
  -- Validate p_result up front.
  if p_result not in ('pass','fail') then
    raise exception 'E_BAD_RESULT: p_result must be pass or fail, got %', p_result
      using errcode = 'check_violation';
  end if;

  -- Lock the inspection row for the duration of this txn. The combined
  -- guard (id + property_id + result='in_progress') prevents:
  --   1. Touching another property's inspection by id-guessing.
  --   2. Completing a row that's already been finalized (race between
  --      two inspectors / a double-tap on the UI).
  select * into v_row
    from public.inspections
    where id = p_inspection_id
    for update;

  if not found then
    raise exception 'E_NOT_FOUND: inspection % not found', p_inspection_id
      using errcode = 'no_data_found';
  end if;

  if v_row.property_id is distinct from p_property_id then
    raise exception 'E_NOT_FOUND: inspection % does not belong to property %', p_inspection_id, p_property_id
      using errcode = 'no_data_found';
  end if;

  if v_row.result <> 'in_progress' then
    raise exception 'E_ALREADY_FINALIZED: inspection % already %', p_inspection_id, v_row.result
      using errcode = 'invalid_parameter_value';
  end if;

  -- 1) Update the inspections row.
  update public.inspections
     set result                    = p_result,
         failed_items              = coalesce(p_failed_items, '[]'::jsonb),
         passed_items              = coalesce(p_passed_items, '[]'::jsonb),
         notes                     = p_notes,
         escalated                 = coalesce(p_escalated, false),
         escalation_reason         = p_escalation_reason,
         correction_notice_sent_at = p_correction_notice_sent_at,
         completed_at              = now()
   where id = p_inspection_id
   returning * into v_row;

  -- 2) Side effects scoped to this property. After each UPDATE we
  --    check the affected row count and ROLLBACK if a non-null FK
  --    actually pointed at a row in another property — silently
  --    no-op'ing the side-effect and still committing the inspection
  --    would leave rooms/cleaning_tasks state desynced from the
  --    inspection's recorded outcome (Codex M5 follow-up).
  if v_row.room_id is not null then
    if p_result = 'pass' then
      update public.rooms
         set status        = 'inspected',
             inspected_at  = now()
       where id          = v_row.room_id
         and property_id = p_property_id;
    else  -- fail
      update public.rooms
         set status       = 'dirty',
             completed_at = null,
             issue_note   = p_correction_note
       where id          = v_row.room_id
         and property_id = p_property_id;
    end if;
    get diagnostics v_count = row_count;
    if v_count <> 1 then
      raise exception 'E_ROOM_PROPERTY_MISMATCH: room % does not belong to property % (rows affected: %)',
        v_row.room_id, p_property_id, v_count
        using errcode = 'no_data_found';
    end if;
  end if;

  if v_row.cleaning_task_id is not null then
    if p_result = 'pass' then
      update public.cleaning_tasks
         set status        = 'inspected_pass',
             inspected_at  = now()
       where id          = v_row.cleaning_task_id
         and property_id = p_property_id;
    else  -- fail
      update public.cleaning_tasks
         set status   = 'correction_pending',
             priority = 'high',
             notes    = p_correction_note
       where id          = v_row.cleaning_task_id
         and property_id = p_property_id;
    end if;
    get diagnostics v_count = row_count;
    if v_count <> 1 then
      raise exception 'E_TASK_PROPERTY_MISMATCH: cleaning_task % does not belong to property % (rows affected: %)',
        v_row.cleaning_task_id, p_property_id, v_count
        using errcode = 'no_data_found';
    end if;
  end if;

  -- 3) If this was a re-check, link the parent. Scoped to property so a
  --    malformed parent link (which the start route already blocks) can't
  --    be papered over here either.
  if v_row.parent_inspection_id is not null then
    update public.inspections
       set recheck_inspection_id = v_row.id
     where id          = v_row.parent_inspection_id
       and property_id = p_property_id;
  end if;

  return v_row;
end;
$$;

comment on function public.complete_inspection_atomic(uuid, uuid, text, jsonb, jsonb, text, boolean, text, timestamptz, text) is
  'Atomic transactional finalize for an inspection. Locks the inspections row, validates property + in_progress, then updates inspections + rooms + cleaning_tasks + parent in a single txn. SECURITY DEFINER, service_role only. Added 0225 (deferred-majors sweep).';

revoke all on function public.complete_inspection_atomic(uuid, uuid, text, jsonb, jsonb, text, boolean, text, timestamptz, text) from public, anon, authenticated;
grant execute on function public.complete_inspection_atomic(uuid, uuid, text, jsonb, jsonb, text, boolean, text, timestamptz, text) to service_role;

-- ── Migration record ───────────────────────────────────────────────────────
insert into public.applied_migrations (version, description)
values (
  '0225',
  'complete_inspection_atomic RPC: transactional finalize for inspections — locks the row + does inspections/rooms/cleaning_tasks/parent updates in one txn. Service-role only.'
)
on conflict (version) do nothing;

notify pgrst, 'reload schema';
