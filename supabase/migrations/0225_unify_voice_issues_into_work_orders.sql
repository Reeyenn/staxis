-- Migration 0225: unify staxis_voice_issues into pms_work_orders_v2
--
-- Closes the "two lists for the maintenance team" gap. Feature #11 (voice
-- issue reporting, migration 0218) wrote tickets into a separate
-- staxis_voice_issues table because the CUA reconciles pms_work_orders_v2
-- as a full snapshot of the PMS feed (cua-service generic-table-writer.ts
-- writeReconcile) — any row not in the next sync gets auto-resolved.
-- A Staxis-originated row therefore can't safely live in the canonical
-- table unless the reconciler knows to skip it.
--
-- This migration + the matching code change in generic-table-writer.ts
-- close that gap:
--
--   1. pms_work_orders_v2 grows a `source` column (default 'pms_sync').
--      The CUA reconciler now filters BOTH the SELECT and the UPDATE on
--      source = 'pms_sync', so any non-PMS row is invisible to the
--      auto-resolve pass.
--
--   2. Two new columns hold voice-specific data:
--        - voice_session_id        — fk to agent_voice_sessions, partial
--                                    unique index for per-session idempotency
--        - voice_metadata          — jsonb with action / item /
--                                    severity / language / transcription /
--                                    voice_clip_path. Forensic + admin UI.
--
--   3. Backfill: any existing staxis_voice_issues rows are copied into
--      pms_work_orders_v2 with source = 'housekeeper_voice' and a
--      deterministic pms_work_order_id = 'staxis-voice-' || id, then the
--      old table is dropped. ON CONFLICT (property_id, pms_work_order_id)
--      DO NOTHING makes the backfill idempotent (re-running this migration
--      doesn't duplicate rows).
--
-- After this lands the maintenance team reads a single table and the
-- /api/maintenance/voice-issues endpoint filters by source='housekeeper_voice'
-- to surface just the voice-originated tickets.

-- ── 1. Add the three new columns ───────────────────────────────────────
alter table public.pms_work_orders_v2
  add column if not exists source text not null default 'pms_sync'
    check (source in ('pms_sync', 'housekeeper_voice', 'manual')),
  add column if not exists voice_session_id uuid
    references public.agent_voice_sessions(id) on delete set null,
  add column if not exists voice_metadata jsonb;

comment on column public.pms_work_orders_v2.source is
  'Which subsystem created this row. ''pms_sync'' = CUA reconciliation from the PMS feed (default — pre-existing rows are stamped this on backfill). ''housekeeper_voice'' = createMaintenanceWorkOrder agent tool (feature #11). ''manual'' = future operator-created. CRITICAL: the CUA reconciler (generic-table-writer.ts writeReconcile) MUST filter on source = ''pms_sync'' for both the SELECT-disappeared and the UPDATE-to-resolved steps — otherwise Staxis-originated rows get auto-resolved 30s after creation.';

comment on column public.pms_work_orders_v2.voice_session_id is
  'For source=''housekeeper_voice'' rows: links back to the agent_voice_sessions row that produced this ticket. NULL for non-voice rows. The partial unique index below enforces one ticket per voice session, so retried createMaintenanceWorkOrder calls collapse onto the original.';

comment on column public.pms_work_orders_v2.voice_metadata is
  'For source=''housekeeper_voice'' rows: jsonb with action (REPAIR/REPLACE/CLEAN/INSPECT), item, location_detail, severity (MINOR/MAJOR/URGENT), note, original_language, original_transcription, voice_clip_path. Audit trail for the maintenance team.';

-- ── 2. Idempotency: one work-order per voice session ──────────────────
-- Partial unique index — only applies to voice-originated rows. The
-- canonical (property_id, pms_work_order_id) constraint still owns the
-- non-voice path. Codex 2026-05-25 (MAJOR fix) on feature #11 used the
-- same pattern in staxis_voice_issues; we carry it forward here so a
-- retried model call still returns the original ticket instead of
-- creating a duplicate.
create unique index if not exists pms_work_orders_v2_voice_session_unique
  on public.pms_work_orders_v2 (voice_session_id)
  where voice_session_id is not null;

-- ── 3. Backfill — copy staxis_voice_issues into pms_work_orders_v2 ────
-- Idempotent: ON CONFLICT (property_id, pms_work_order_id) DO NOTHING.
-- The deterministic pms_work_order_id = 'staxis-voice-' || id means a
-- re-run of this migration sees the same target rows and skips them.
--
-- Mapping decisions:
--   severity → priority:  MINOR→low, MAJOR→high, URGENT→urgent
--                         (MAJOR maps to high so broken in-room equipment
--                          hits the same critical-pending bucket the
--                          maintenance dashboard counts — see
--                          src/lib/reports/aggregate.ts critical filter)
--   status → status:      keeps open/in_progress, maps resolved→resolved,
--                         cancelled→closed (pms_work_orders_v2 status enum
--                         is 'open'|'in_progress'|'closed'|'deferred'|'resolved')
--   description:          composed from action + item + location + note so the
--                         maintenance team sees a readable summary on first row
--                         hit. The raw structured fields live in voice_metadata.
do $$
declare
  staxis_voice_issues_exists boolean;
begin
  select exists(
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'staxis_voice_issues'
  ) into staxis_voice_issues_exists;

  if staxis_voice_issues_exists then
    insert into public.pms_work_orders_v2 (
      property_id, pms_work_order_id, room_number, description,
      priority, status, reported_by, reported_at,
      voice_session_id, voice_metadata, source,
      created_at, updated_at
    )
    select
      svi.property_id,
      'staxis-voice-' || svi.id::text                                          as pms_work_order_id,
      svi.room_number,
      -- Description: "REPAIR sink (bathroom) — water leaking" style.
      coalesce(
        svi.action || ' ' || svi.item ||
          case when svi.location_detail is not null
               then ' (' || svi.location_detail || ')' else '' end ||
          case when svi.note is not null
               then ' — ' || svi.note else '' end,
        svi.item
      )                                                                        as description,
      case svi.severity
        when 'URGENT' then 'urgent'
        when 'MAJOR' then 'high'
        else 'low'
      end                                                                      as priority,
      case svi.status
        when 'open'        then 'open'
        when 'in_progress' then 'in_progress'
        when 'resolved'    then 'resolved'
        when 'cancelled'   then 'closed'
        else 'open'
      end                                                                      as status,
      coalesce(svi.assigned_to, 'Voice report (housekeeper)')                  as reported_by,
      svi.created_at                                                           as reported_at,
      svi.voice_session_id,
      jsonb_build_object(
        'action',                  svi.action,
        'item',                    svi.item,
        'location_detail',         svi.location_detail,
        'severity',                svi.severity,
        'note',                    svi.note,
        'original_language',       svi.original_language,
        'original_transcription',  svi.original_transcription,
        'voice_clip_path',         svi.voice_clip_path,
        'migrated_from',           'staxis_voice_issues',
        'migrated_from_id',        svi.id::text
      )                                                                        as voice_metadata,
      'housekeeper_voice'                                                      as source,
      svi.created_at,
      svi.updated_at
    from public.staxis_voice_issues svi
    on conflict (property_id, pms_work_order_id) do nothing;

    raise notice 'backfill: copied % staxis_voice_issues rows into pms_work_orders_v2',
      (select count(*) from public.staxis_voice_issues);
  else
    raise notice 'backfill: staxis_voice_issues does not exist (already dropped) — skipping';
  end if;
end $$;

-- ── 4. Drop the legacy table ──────────────────────────────────────────
-- Conditional drop so a re-run is idempotent.
drop table if exists public.staxis_voice_issues;

-- ── 5. Index for the maintenance-team read path ───────────────────────
-- Supports the new /api/maintenance/voice-issues filter: ''give me
-- recent voice-originated tickets for this property''. Without this the
-- query falls back to a sequential scan on the status index. The partial
-- WHERE keeps the index small — most rows are pms_sync.
create index if not exists pms_work_orders_v2_voice_recent_idx
  on public.pms_work_orders_v2 (property_id, status, created_at desc)
  where source = 'housekeeper_voice';

-- ── 6. Migration record ───────────────────────────────────────────────
insert into public.applied_migrations (version, description)
values (
  '0225',
  'unify-voice-issues: pms_work_orders_v2.source + voice_session_id + voice_metadata + backfill from staxis_voice_issues + drop legacy table. Feature #11 follow-up.'
)
on conflict (version) do nothing;

notify pgrst, 'reload schema';
