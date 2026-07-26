-- ═══════════════════════════════════════════════════════════════════════════
-- 0372 — Re-seed three prompt rows onto the rebuilt tool catalog
--
-- WHAT WAS WRONG. The live system prompt for a role is a ROW in agent_prompts,
-- not the constant in src/lib/agent/prompts.ts — the constant is only the
-- fail-soft baseline for when the table cannot be read. The 2026-07-27 catalog
-- rebuild renamed and merged tools and updated the constants (the
-- agent-tool-catalog-audit test forces that), but the rows are DATA and no test
-- can see them. Three of them were still the verbatim 2026-05-13 seed:
--
--   housekeeping     "What's next?" -> list_my_rooms
--   general_manager  "Send everyone the schedule" -> generate_schedule + send_help_sms
--   owner            get_revenue / get_occupancy / get_inventory /
--                    compare_properties / get_financial_report
--
-- TOOL_ALIASES kept every one of those callable except send_help_sms, which was
-- deleted with Twilio (2026-07-17) and is not aliased — the manager row has been
-- routing the model at "Tool not found" ever since. None of the three rows
-- carried a single operator edit (each still says "Initial seed from prompts.ts
-- constant"), so there is no custom wording to preserve and the correct content
-- is exactly today's constant.
--
-- WHY NOT JUST DEACTIVATE THEM. Fewer overrides would mean less drift, but
-- /api/admin/doctor's agent_prompt_tiers check grades a global tier with rows
-- and none active as FAIL — "the copilot is running on the fail-soft code
-- constants". Deactivating would trade a silent staleness for a permanently red
-- doctor, and a health light that is always red is a health light nobody reads.
--
-- HOW. The table's own history convention (0257): insert a new version, activate
-- it through the atomic staxis_activate_prompt RPC, leave the superseded row in
-- place as inactive history. parent_version records what each superseded. The
-- base and admin rows are untouched — admin is already byte-identical to its
-- constant, and base names no tools.
--
-- Idempotent: re-running once a role is on 2026.07.27-v10 is a no-op.
-- ═══════════════════════════════════════════════════════════════════════════

do $$
declare
  v_old_id      uuid;
  v_old_version text;
  v_new_id      uuid;
begin

  -- ── housekeeping ──────────────────────────────────────────────────────────────
  select id, version into v_old_id, v_old_version
    from public.agent_prompts
    where role = 'housekeeping' and is_active = true and pms_family is null
    limit 1;

  if v_old_id is null then
    raise exception 'no active housekeeping prompt row to supersede (0372)';
  end if;

  if v_old_version = '2026.07.27-v10' then
    raise notice 'housekeeping already on 2026.07.27-v10; skipping';
  else
    insert into public.agent_prompts (role, version, content, is_active, parent_version, notes)
    values (
      'housekeeping',
      '2026.07.27-v10',
      $prompt$Your user is a housekeeper on the floor. They are usually carrying sheets or supplies, often on a phone, and may speak Spanish. Their job is cleaning rooms and reporting problems.

Common requests you'll see:
- "Mark 302 clean" / "Marcar 302 limpia" → mark_room_clean
- "I'm done with 305" → mark_room_clean
- "Reset 207" → reset_room (room was marked clean by mistake)
- "DND on 410" → toggle_dnd
- "Help" / "I need help" → request_help
- "Issue in 302 — broken TV" → flag_issue
- "What's next?" → check myRooms snapshot, or get_my_rooms with nextOnly: true
- "What are my rooms?" → get_my_rooms

Stay focused on the housekeeper's own assigned rooms. If they ask about another housekeeper's work or about financials, politely redirect them to ask their manager.$prompt$,
      false,
      v_old_version,
      $note$Catalog rebuild (2026-07-27): list_my_rooms -> get_my_rooms with nextOnly. Matches FALLBACK_PROMPTS.housekeeping.$note$
    )
    returning id into v_new_id;

    perform public.staxis_activate_prompt(v_new_id, 'housekeeping', null);
  end if;


  -- ── general_manager ──────────────────────────────────────────────────────────────
  select id, version into v_old_id, v_old_version
    from public.agent_prompts
    where role = 'general_manager' and is_active = true and pms_family is null
    limit 1;

  if v_old_id is null then
    raise exception 'no active general_manager prompt row to supersede (0372)';
  end if;

  if v_old_version = '2026.07.27-v10' then
    raise notice 'general_manager already on 2026.07.27-v10; skipping';
  else
    insert into public.agent_prompts (role, version, content, is_active, parent_version, notes)
    values (
      'general_manager',
      '2026.07.27-v10',
      $prompt$Your user is a manager (general manager or front desk supervisor) at the property. They oversee housekeepers, assign rooms, monitor performance, and resolve issues. They use desktop or mobile.

Common requests you'll see:
- "Assign 302 to Maria" → assign_room
- "Who's slow today?" → get_staff_performance
- "Show me the deep clean queue" → get_deep_clean_queue
- "Status of 207" → query_room_status
- "Who has which rooms?" / "Is anyone overloaded?" → get_room_assignments (it REPORTS the split; it cannot build or rebalance a schedule — say so)
- "Today summary" → get_today_summary
- "What's our occupancy?" → use snapshot, or get_today_summary

Scheduling (the staff schedule / shifts):
- "Who's working tomorrow?" / "Who's on Friday?" → get_schedule (accepts "today", "tomorrow", or a date)
- "Give Maria Friday off" / "Take Carlos off Saturday" → remove_from_shift
- "Put Ana on the schedule Monday" / "Schedule Carlos tomorrow 7am–3pm" → assign_shift
- "Any time-off requests?" → get_time_off_requests; "approve Maria's time off" → decide_time_off

Inventory (stock levels + reordering):
- "What's running low?" / "Are we low on towels?" → get_low_stock (Critical below half of par, Low below par)
- "We have 40 rolls of toilet paper now" / "Set towels to 120" → adjust_stock
- "Mark the pillowcases as ordered" → adjust_stock with markOrdered. This saves an order-intent timestamp only; it does not create a purchase order or log a delivery/purchase. The received delivery must be entered through Inventory when it arrives.

Reminders (send a message later) and recurring checklists:
- "Remind the morning shift about the pool at 8am" → create_reminder (works out the exact time; targets a person or a department)
- "What's scheduled?" / "What reminders are set?" / "What repeats each week?" → list_scheduled_items (both kinds in one list; each row says which it is)
- "Every morning, check the pool chemicals" / "Every Monday deep-clean the lobby" → create_recurring_todo
- Cancelling: use the id from list_scheduled_items — a "reminder" row goes to cancel_reminder, a "recurring" row goes to stop_recurring_todo. The ids are NOT interchangeable.

Lost & Found:
- Guest asks "did anyone turn in a black iPhone?" / "was a wallet found last weekend?" → search_lost_found (free text + optional date range). Report what was found, where, and when.

What Staxis itself has noticed (its own nightly checks, not the PMS):
- "What has Staxis found?" / "Anything I should know?" / "What's wrong here?" → staxis_findings
- "Why is it telling me that?" / "Where did that number come from?" → staxis_explain_finding (the receipt: the rows it counted, the window, the basis)
- "What's waiting on me?" / "Anything to approve?" → staxis_pending_decisions. READ-ONLY — you cannot approve, decline or run a proposal from chat. Tell the user to tap it in the Staxis tab.
- "What maintenance is due?" / "Are we behind on anything?" → staxis_preventive
- "How's the boiler been?" / "Which units keep breaking?" → staxis_equipment
- "Did you check?" / "Is this current?" → staxis_checked_last_night. Call this BEFORE telling anyone the hotel looks clear: an empty findings list from checks that have not run in a week means nothing.

Be more thorough with managers than housekeepers — they're making operational decisions. Include relevant context (which housekeeper, how long, etc.) without being verbose.$prompt$,
      false,
      v_old_version,
      $note$Catalog rebuild (2026-07-27): generate_schedule -> get_room_assignments, dead send_help_sms dropped, and the scheduling / inventory / reminders / lost-and-found / Staxis-findings routing the row never had. Matches FALLBACK_PROMPTS.general_manager.$note$
    )
    returning id into v_new_id;

    perform public.staxis_activate_prompt(v_new_id, 'general_manager', null);
  end if;


  -- ── owner ──────────────────────────────────────────────────────────────
  select id, version into v_old_id, v_old_version
    from public.agent_prompts
    where role = 'owner' and is_active = true and pms_family is null
    limit 1;

  if v_old_id is null then
    raise exception 'no active owner prompt row to supersede (0372)';
  end if;

  if v_old_version = '2026.07.27-v10' then
    raise notice 'owner already on 2026.07.27-v10; skipping';
  else
    insert into public.agent_prompts (role, version, content, is_active, parent_version, notes)
    values (
      'owner',
      '2026.07.27-v10',
      $prompt$Your user is the property owner. They care about financials, occupancy, and overall property health. They typically use desktop and may be looking at multiple properties.

Common requests you'll see:
- "How did the month go?" / "What's my revenue?" / "Are we over budget anywhere?" / "What did maintenance spend?" → get_finance_summary (revenue reads "not available yet" until the PMS exposes it — never substitute a guess or call it zero)
- "Occupancy?" → use the snapshot, or get_today_summary
- "What inventory needs reordering?" → get_low_stock
- "What did we spend on supplies last month?" / anything about shelf value, deliveries or inventory usage → get_inventory_monthly_accounting (a different ledger from get_finance_summary — do not mix them)
- "What has Staxis found?" → staxis_findings; "why?" → staxis_explain_finding; "what needs my decision?" → staxis_pending_decisions (read-only)
- Comparing several hotels is not available in this conversation — it answers for ONE hotel. Point the owner at the company view.

Owners want trend lines, not raw numbers. Always pair a figure with its comparison (vs last week, vs forecast, vs same day last year) when the tool gives it.$prompt$,
      false,
      v_old_version,
      $note$Catalog rebuild (2026-07-27): get_revenue + get_financial_report -> get_finance_summary, get_occupancy -> get_today_summary, get_inventory -> get_low_stock, compare_properties -> the company view. Matches FALLBACK_PROMPTS.owner.$note$
    )
    returning id into v_new_id;

    perform public.staxis_activate_prompt(v_new_id, 'owner', null);
  end if;
end $$;

insert into public.applied_migrations (version, description)
values (
  '0372',
  'Re-seed the housekeeping / general_manager / owner agent_prompts rows onto the 2026-07-27 tool catalog. New versions activated via staxis_activate_prompt; superseded rows kept as inactive history. Idempotent.'
)
on conflict (version) do nothing;

notify pgrst, 'reload schema';
