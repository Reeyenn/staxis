-- ═══════════════════════════════════════════════════════════════════════════
-- 0203 — Seed the Choice Advantage knowledge file (version 1, active).
--
-- Why this exists:
--   The session-driver in cua-service refuses to start a hotel without an
--   active pms_knowledge_files row for its pms_family. Without this seed,
--   Comfort Suites would boot but sit idle forever. We seed v1 here using
--   the verified selectors from scraper/scraper.js (login),
--   hk-center-pull.js (HK Center table), dashboard-pull.js (Room Count
--   labels), ooo-pull.js (WorkOrders.jx fetch), and csv-scraper.js
--   (Housekeeping Check-off List).
--
--   When Claude vision is invoked later to repair / extend the knowledge
--   file (Phase 2), it will saveDraft + promoteToActive replacing this
--   seed. The seed exists so Phase 1 doesn't need any AI runtime to start
--   producing data.
--
-- Idempotent: insert ... on conflict (pms_family, version) do nothing. If
-- the row already exists (re-running the migration), it's left untouched.
--
-- Manual prod apply: per project_migration_application_manual.md.
-- ═══════════════════════════════════════════════════════════════════════════

insert into public.pms_knowledge_files (
  pms_family, version, status, knowledge, created_by, notes
) values (
  'choice_advantage',
  1,
  'active',
  jsonb_build_object(
    'schema', 1,
    'description', 'Choice Advantage (franchise PMS for Comfort/Quality/Sleep Inn). Selectors ported from scraper/ on 2026-05-23 — verified stable as of that date.',
    'login', jsonb_build_object(
      'startUrl', 'https://www.choiceadvantage.com/choicehotels/Welcome.init',
      'steps', jsonb_build_array(
        jsonb_build_object('kind', 'fill', 'selector', 'input[name="j_username"]', 'value', '$username'),
        jsonb_build_object('kind', 'fill', 'selector', 'input[name="j_password"]', 'value', '$password'),
        jsonb_build_object('kind', 'click', 'selector', 'a#greenButton, a.greenButton, #greenButton, input[type="submit"]'),
        jsonb_build_object('kind', 'wait_ms', 'ms', 3000)
      ),
      'successSelectors', jsonb_build_array(
        'a[href*="LogUserOff"]',
        'a[href*="ViewInHouseList"]',
        'a[href*="HousekeepingCenter"]'
      ),
      'timeoutMs', 30000,
      -- Choice Advantage has no MFA in our deployment (franchise login
      -- uses username/password only). trustDeviceSelectors empty — the
      -- mfa-handler defaults still try the common patterns but find none.
      'trustDeviceSelectors', jsonb_build_array()
    ),
    'feeds', jsonb_build_object(
      -- ────────────────────────────────────────────────────────────────
      'dashboard_counts', jsonb_build_object(
        'description', 'Live counts: in-house / arrivals remaining / departures remaining. Three pages, one count each.',
        'mode', 'dom_inline',
        'columns', jsonb_build_object(
          -- Selector reads the .CHI_Data sibling of any element following
          -- the "Room Count:" label. Matches dashboard-pull.js:99-118.
          'roomCount', 'li:has(label:has-text("Room Count:")) ~ li .CHI_Data'
        ),
        'extra', jsonb_build_object(
          'pages', jsonb_build_object(
            'inHouse',    'https://www.choiceadvantage.com/choicehotels/ViewInHouseList.init',
            'arrivals',   'https://www.choiceadvantage.com/choicehotels/ViewArrivalsList.init',
            'departures', 'https://www.choiceadvantage.com/choicehotels/ViewDeparturesList.init'
          )
        )
      ),
      -- ────────────────────────────────────────────────────────────────
      'room_status', jsonb_build_object(
        'description', 'HK Center room table: current Status + Condition per room. Cell index mapping per hk-center-pull.js:44-79.',
        'mode', 'dom_table',
        'url', 'https://www.choiceadvantage.com/choicehotels/HousekeepingCenter_start.init',
        'selectors', jsonb_build_object(
          'rowSelector', '#updateRoomConditionHeaderTable tr:has(td)'
        ),
        'columns', jsonb_build_object(
          'number',      'td:nth-child(1)',
          'type',        'td:nth-child(3)',
          'roomStatus',  'td:nth-child(4)',
          -- Condition: <select> dropdown with selected option text, post-Apr-2026 CA format.
          'condition',   'td:nth-child(6) select option[selected]',
          'service',     'td:nth-child(7)',
          'assignedTo',  'td:nth-child(8)'
        )
      ),
      -- ────────────────────────────────────────────────────────────────
      'housekeeping', jsonb_build_object(
        'description', 'Same HK Center page as room_status — we get assignments + DnD from the same scrape.',
        'mode', 'dom_table',
        'url', 'https://www.choiceadvantage.com/choicehotels/HousekeepingCenter_start.init',
        'selectors', jsonb_build_object(
          'rowSelector', '#updateRoomConditionHeaderTable tr:has(td)'
        ),
        'columns', jsonb_build_object(
          'number',      'td:nth-child(1)',
          'assignedTo',  'td:nth-child(8)',
          'isDnd',       'td:nth-child(9) input[type="checkbox"]'
        )
      ),
      -- ────────────────────────────────────────────────────────────────
      'work_orders', jsonb_build_object(
        'description', 'Work orders fetched as JSON from CA''s authenticated endpoint. Filtered to roomOutOfOrder=true in the normalizer.',
        'mode', 'fetch_api',
        'url', 'https://www.choiceadvantage.com/choicehotels/WorkOrders.jx',
        'extra', jsonb_build_object(
          'method', 'POST',
          'body', 'workOrderType=ROOM',
          'expectJson', true
        )
      ),
      -- ────────────────────────────────────────────────────────────────
      'arrivals_departures', jsonb_build_object(
        'description', 'Housekeeping Check-off List CSV. Has arrivals/departures + per-room cleaning context.',
        'mode', 'csv_download',
        'url', 'https://www.choiceadvantage.com/choicehotels/ReportViewStart.init',
        'selectors', jsonb_build_object(
          'csvCheckbox', '#CSVcheckbox',
          'downloadButton', 'input[type="submit"][value*="Submit"], button:has-text("Submit"), a:has-text("Submit")'
        ),
        'extra', jsonb_build_object(
          'preStepClick', jsonb_build_array(
            'a:has-text("Housekeeping Check-off List")'
          ),
          'csvDelimiter', 'comma',
          'expectedHeaderColumns', jsonb_build_array(
            'Room', 'Type', 'Status', 'Condition', 'Arrival', 'Departure'
          )
        )
      )
    ),
    'hints', jsonb_build_object(
      -- Choice Advantage page loads run ~60-90s for the slowest reports;
      -- size single-flight cadence against this p95.
      'pollingP95Ms', 90000,
      'maxRequestsPerMinute', 30,
      'dismissDialogs', jsonb_build_array(
        'button:has-text("Close")',
        'button:has-text("Dismiss")',
        '[aria-label="Close"]'
      )
    )
  ),
  'manual-seed:v4-rebuild-2026-05-23',
  'Seed from Plan v4 rebuild (2026-05-23). Selectors verified from scraper/ code at commit at time of seed. To repair when CA UI changes, run Claude vision mapper to produce a new draft + promote.'
)
on conflict (pms_family, version) do nothing;

-- Track the migration.
insert into public.applied_migrations (version, description)
values ('0203', 'Seed Choice Advantage knowledge file v1 (active) from verified scraper/ selectors.')
on conflict (version) do nothing;

notify pgrst, 'reload schema';
