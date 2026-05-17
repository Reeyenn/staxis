-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 0137: staxis_set_staff_language — atomic language mirror
--
-- DB-access audit finding P0.3 (2026-05-17):
--   /api/sms-reply's mirrorLang helper does two UPDATEs in parallel — one
--   to staff.language, one to shift_confirmations.language — and only
--   console.errors any failure. Outcome: one row updates, the other
--   doesn't, and tomorrow's outgoing SMS picks the stale language from
--   whichever side won the race.
--
-- This RPC updates both inside one transaction. The caller no longer
-- has to coordinate; either both writes land or neither does.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function public.staxis_set_staff_language(
  p_staff       uuid,
  p_conf_token  text,
  p_lang        text         -- 'en' | 'es' (validated by the CHECK on both tables)
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if p_lang not in ('en','es') then
    raise exception 'staxis_set_staff_language: lang must be en or es (got %)', p_lang;
  end if;

  update public.staff
  set language = p_lang
  where id = p_staff;

  update public.shift_confirmations
  set language = p_lang
  where token = p_conf_token;
end;
$$;

comment on function public.staxis_set_staff_language is
  'Atomically mirrors a language preference onto staff.language and shift_confirmations.language. Replaces the parallel Promise.all writes at /api/sms-reply mirrorLang (audit P0.3, 2026-05-17).';

-- ─── Lock down — service_role only ──────────────────────────────────────
revoke execute on function public.staxis_set_staff_language(uuid, text, text) from public;
revoke execute on function public.staxis_set_staff_language(uuid, text, text) from anon, authenticated;
grant  execute on function public.staxis_set_staff_language(uuid, text, text) to   service_role;

insert into public.applied_migrations (version, description)
values ('0137', 'staxis_set_staff_language RPC — atomic language mirror (audit P0.3)')
on conflict (version) do nothing;
