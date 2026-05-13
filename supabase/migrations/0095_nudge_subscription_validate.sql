-- Migration 0092: validate properties.nudge_subscription.recipient_account_ids
--
-- Codex post-merge review (2026-05-13) finding N3: the nudge_subscription
-- column added in migration 0088 lets a property's owner write an
-- arbitrary recipient_account_ids array. getNudgeRecipients passes that
-- array verbatim into agent_nudges.user_id, and the agent_nudges_select_own
-- RLS lets those recipients read the rows. Cross-property nudge
-- exfiltration is open by default: property A's owner sets
-- recipient_account_ids = ['<B owner UUID>'], and every help_request
-- + every cron-generated nudge from property A lands in B's inbox with
-- staff names, room numbers, issue notes, and trimmed message text.
--
-- Today there's no admin UI to write nudge_subscription, so exposure is
-- theoretical — but the column landed without a guard. This trigger
-- refuses any update where recipient_account_ids contains an account that
-- does NOT have a legitimate path to this property.
--
-- Legitimate paths (matches userHasPropertyAccess in src/lib/api-auth.ts):
--   1. accounts.role = 'admin' (admins access every property)
--   2. accounts.property_access (uuid[]) contains this property's id
-- Property_access column is uuid[] (per migration 0001), NOT jsonb. The
-- '*' wildcard is a client-side convenience; the DB stores real UUIDs
-- or empty arrays for admins.

create or replace function public.staxis_validate_nudge_recipients()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_recipients jsonb;
  v_recipient_uuid uuid;
  v_bad_recipients text[] := array[]::text[];
begin
  -- Only validate when nudge_subscription.recipient_account_ids is a
  -- non-empty array. Null / missing / enabled=false / empty array →
  -- "use the default fallback" → no validation needed.
  v_recipients := NEW.nudge_subscription -> 'recipient_account_ids';
  if v_recipients is null
     or jsonb_typeof(v_recipients) <> 'array'
     or jsonb_array_length(v_recipients) = 0 then
    return NEW;
  end if;

  -- Each recipient must be an account with either role='admin' OR with
  -- property_access uuid[] containing NEW.id.
  for v_recipient_uuid in
    select (jsonb_array_elements_text(v_recipients))::uuid
  loop
    if not exists (
      select 1 from public.accounts a
        where a.id = v_recipient_uuid
          and (
            a.role = 'admin'
            or NEW.id = any(a.property_access)
          )
    ) then
      v_bad_recipients := array_append(v_bad_recipients, v_recipient_uuid::text);
    end if;
  end loop;

  if array_length(v_bad_recipients, 1) > 0 then
    raise exception
      'nudge_subscription.recipient_account_ids contains UUIDs that lack property_access for property %: %',
      NEW.id, v_bad_recipients
      using errcode = '23514';
  end if;

  return NEW;
end;
$$;

drop trigger if exists staxis_validate_nudge_recipients on public.properties;
create trigger staxis_validate_nudge_recipients
  before insert or update of nudge_subscription on public.properties
  for each row execute function public.staxis_validate_nudge_recipients();

comment on function public.staxis_validate_nudge_recipients is
  'Trigger guard: any value written to properties.nudge_subscription.recipient_account_ids must contain only account UUIDs whose property_access includes this property (or role=admin). Prevents cross-property nudge exfiltration. Codex post-merge review 2026-05-13 (N3).';

insert into public.applied_migrations (version, description)
values ('0095', 'Codex post-merge review: nudge_subscription recipient validation trigger (N3)')
on conflict (version) do nothing;
