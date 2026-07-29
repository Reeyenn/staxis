-- 0384_portfolio_receipt_provenance.sql
-- Exact prompt/model/reference provenance for reproducible Portfolio
-- Intelligence answer receipts. No raw question or answer text is stored.

begin;

alter table public.portfolio_query_receipts
  add column if not exists prompt_hash text,
  add column if not exists knowledge_versions jsonb not null default '{}'::jsonb,
  add column if not exists finding_versions jsonb not null default '{}'::jsonb;

alter table public.portfolio_query_receipts
  drop constraint if exists portfolio_query_receipts_provenance_check;
alter table public.portfolio_query_receipts
  add constraint portfolio_query_receipts_provenance_check check (
    (prompt_hash is null or prompt_hash ~ '^[0-9a-f]{64}$')
    and jsonb_typeof(knowledge_versions) = 'object'
    and jsonb_typeof(finding_versions) = 'object'
    and octet_length(knowledge_versions::text) <= 262144
    and octet_length(finding_versions::text) <= 262144
  );

comment on column public.portfolio_query_receipts.prompt_hash is
  'SHA-256 of the exact composed system-prompt block object sent for synthesis; raw prompt text is not retained. Added 0384.';
comment on column public.portfolio_query_receipts.knowledge_versions is
  'Bounded IDs, revisions and overlay versions for company/property knowledge included in the prompt; never raw content. Added 0384.';
comment on column public.portfolio_query_receipts.finding_versions is
  'Finding contract/producer/run provenance included in the prompt, or an explicit not-mounted marker. Added 0384.';

insert into public.applied_migrations(version, description)
values (
  '0384',
  'Exact prompt hash, actual model metadata, and bounded knowledge/finding provenance for immutable portfolio answer receipts.'
)
on conflict (version) do nothing;

commit;
