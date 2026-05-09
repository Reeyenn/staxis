-- 0052_user_feedback.sql
-- In-app feedback inbox. GMs (or other staff) can send "this is broken" or
-- "I want X" from inside the app. Reeyen sees all submissions in admin.
--
-- Writes happen via POST /api/feedback (server-side, auth-validated).
-- Admin reads via GET /api/admin/feedback. Status is updated as Reeyen
-- triages.

create table if not exists public.user_feedback (
  id uuid primary key default gen_random_uuid(),
  property_id uuid references public.properties(id) on delete set null,
  user_id uuid references auth.users(id) on delete set null,
  -- Denormalized so feedback is readable even after the user/property is
  -- deleted (don't lose context for old reports).
  user_email text,
  user_display_name text,
  message text not null,
  category text not null default 'general'
    check (category in ('bug','feature_request','general','complaint','love')),
  status text not null default 'new'
    check (status in ('new','in_progress','resolved','wontfix')),
  admin_note text,
  resolved_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists user_feedback_status_idx on public.user_feedback (status, created_at desc);
create index if not exists user_feedback_property_idx on public.user_feedback (property_id, created_at desc);

alter table public.user_feedback enable row level security;
-- No public policies: routes use the service role.
