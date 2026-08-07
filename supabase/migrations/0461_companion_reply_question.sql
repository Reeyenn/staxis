-- ═══════════════════════════════════════════════════════════════════════════
-- Staxis / HotelOps AI — the question under a card (Migration 0461)
--
-- TWO NULLABLE COLUMNS ON `findings`. That is the whole migration.
--
-- ─── WHY THEY EXIST ────────────────────────────────────────────────────────
--
-- Every card the companion shows now carries its own replies, built by the code
-- that built the sentence (src/lib/companion/replies.ts). The QUESTION over
-- those replies is a per-kind template: a preventive card asks "Has this been
-- done?", a recommendation asks "Is this handled?". Correct, and identical at
-- every hotel forever.
--
-- A template cannot know that this particular water heater is three weeks past
-- its date and that somebody was already called about it in June. A model that
-- has the finding's own evidence in front of it can, and asking one better
-- question is the one part of this surface a model can genuinely improve.
--
-- So: the nightly judge pass writes a question here, and the browser prefers it
-- over the template exactly the way `cardPhrasing` already prefers
-- `judged_summary_en` over `summary`.
--
-- ─── WHAT THE MODEL IS AND IS NOT ALLOWED TO PUT HERE ──────────────────────
--
-- `judged_question` is ONE SENTENCE and nothing else. It is not a label, not a
-- destination, not a verdict and not an action. The buttons under it are built
-- by code from a closed intent registry and are not stored here at all, because
-- a model that could write a button label could write a button that lies about
-- what it does.
--
-- `judged_reply_order` is the one structural thing the model may influence, and
-- it is the weakest possible one: a PERMUTATION of reply ids the code already
-- chose. It cannot add an id, cannot remove one the code marked required, and
-- an order naming anything unknown is discarded whole. Reordering three honest
-- answers cannot produce a dishonest card.
--
-- NUMBERS: never written as digits. The question is authored in slot form
-- ("{days_overdue} days"), the slots are bound from the finding's own evidence
-- by the same prose guard the judge's phrasing goes through, and a question
-- containing a numeral the finding does not hold is refused before it is
-- stored. See src/lib/companion/reply-question.ts.
--
-- ─── WHY NULLABLE, AND WHY NO BACKFILL ─────────────────────────────────────
--
-- Null is the ordinary state and means "use the template", which is a complete,
-- correct card. Every hotel is in that state today and stays in it until a
-- nightly pass has run. There is nothing to backfill: there is no deterministic
-- way to compute what the model would have said, and writing a copy of the
-- template into the column would make "did a model write this" unanswerable.
--
-- ─── WHY NO INDEX ──────────────────────────────────────────────────────────
--
-- Nothing ever filters or sorts on either column. They are read back on rows
-- already selected by (property_id, status), which findings_property_status_idx
-- already covers, and written by id.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ─── The question ───────────────────────────────────────────────────────────
alter table public.findings
  add column if not exists judged_question text;

comment on column public.findings.judged_question is
  'One question, written by the companion.reply_question pass with this '
  'finding''s own evidence in front of it, or null. Null means the per-kind '
  'template question stands, which is a complete card. Never a label, never a '
  'destination, never a verdict: the replies under it are built by code from a '
  'closed intent registry. Numerals are bound from the finding''s evidence '
  'through the prose slot guard before this is written, so a question here '
  'cannot claim a number the finding does not hold. Added 0461.';

-- ─── The order the replies are shown in ─────────────────────────────────────
--
-- A permutation of ids the CODE chose, never a list of new ones. Stored as
-- text[] rather than jsonb because it is a flat list of short opaque strings
-- with no shape of its own, and text[] is the type that says so.
alter table public.findings
  add column if not exists judged_reply_order text[];

comment on column public.findings.judged_reply_order is
  'The order to show this card''s replies in, as reply ids, or null for the '
  'code''s own order. A permutation of a subset of the ids the code built; any '
  'entry naming an unknown id discards the whole list rather than part of it. '
  'The model may reorder honest answers and may do nothing else to them: it '
  'cannot add a reply, cannot remove one, and cannot write a label. Added 0461.';

-- ─── The bound, enforced ────────────────────────────────────────────────────
--
-- The application refuses a question over 120 characters before it ever gets
-- here (see reply-question.ts), and this is the second, independent refusal.
-- Two gates that agree rather than one relying on the other: the column is
-- reachable by anything holding the service role, and a paragraph rendered as a
-- question would break the card layout at every hotel that got one.
--
-- 200 and not 120, deliberately. A constraint that sits exactly on the
-- application's limit turns a one-character drift into a failed nightly write
-- for a whole hotel; this is a ceiling on the damage, not a duplicate of the
-- rule.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'findings_judged_question_bounded'
  ) then
    alter table public.findings
      add constraint findings_judged_question_bounded
      check (judged_question is null or char_length(judged_question) <= 200);
  end if;
end $$;

-- Same shape for the order: three replies is the construction cap, and a list
-- longer than that is a list that did not come from the reply builders.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'findings_judged_reply_order_bounded'
  ) then
    alter table public.findings
      add constraint findings_judged_reply_order_bounded
      check (
        judged_reply_order is null
        or (array_length(judged_reply_order, 1) between 1 and 3
            and array_length(judged_reply_order, 1) is not null)
      );
  end if;
end $$;

-- ─── No new grants ──────────────────────────────────────────────────────────
--
-- `findings` is deny-all to anon and authenticated (0360) and every read goes
-- through the service role behind an /api route. Two columns on that table
-- inherit exactly that, and this migration deliberately grants nothing: a
-- question the browser could read directly would be a question that bypassed
-- the property scope the routes apply.

-- ─── applied_migrations bookkeeping ─────────────────────────────────────────
INSERT INTO public.applied_migrations (version, description)
VALUES (
  '0461',
  'the question under a companion card: two nullable columns on findings holding one model-written question and an optional reordering of the code-built replies. Null on both means the per-kind template stands, which is a complete card. No index, no backfill, no new grants.'
)
ON CONFLICT (version) DO NOTHING;

COMMIT;

NOTIFY pgrst, 'reload schema';
