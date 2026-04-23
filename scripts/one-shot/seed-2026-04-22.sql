-- ═══════════════════════════════════════════════════════════════════════════
-- Staxis seed — direct-to-SQL equivalent of scripts/seed-supabase.js
-- Sandbox cannot reach Supabase.co from Node; this runs via SQL editor.
-- Idempotent: safe to re-run.
-- ═══════════════════════════════════════════════════════════════════════════

do $seed$
declare
  v_user_id     uuid;
  v_property_id uuid;
  v_account_id  uuid;
begin

  -- ── Step 1: auth.users + auth.identities ────────────────────────────────
  select id into v_user_id from auth.users where email = 'reeyen@staxis.local';

  if v_user_id is null then
    v_user_id := gen_random_uuid();
    insert into auth.users (
      instance_id, id, aud, role, email,
      encrypted_password, email_confirmed_at,
      raw_app_meta_data, raw_user_meta_data,
      created_at, updated_at
    ) values (
      '00000000-0000-0000-0000-000000000000',
      v_user_id,
      'authenticated',
      'authenticated',
      'reeyen@staxis.local',
      crypt('__ADMIN_PASSWORD_PLACEHOLDER__', gen_salt('bf')),
      now(),
      '{"provider":"email","providers":["email"]}'::jsonb,
      '{"username":"reeyen","displayName":"Reeyen Patel"}'::jsonb,
      now(), now()
    );

    insert into auth.identities (
      id, user_id, identity_data, provider, provider_id,
      last_sign_in_at, created_at, updated_at
    ) values (
      gen_random_uuid(),
      v_user_id,
      jsonb_build_object('sub', v_user_id::text, 'email', 'reeyen@staxis.local'),
      'email',
      v_user_id::text,
      now(), now(), now()
    );
    raise notice 'created auth user % and identity', v_user_id;
  else
    raise notice 'auth user already exists: %', v_user_id;
  end if;

  -- ── Step 2: property ────────────────────────────────────────────────────
  select id into v_property_id
    from properties
   where owner_id = v_user_id
     and name = 'Comfort Suites Beaumont';

  if v_property_id is null then
    v_property_id := gen_random_uuid();
    insert into properties (
      id, owner_id, name, total_rooms, avg_occupancy, hourly_wage,
      checkout_minutes, stayover_minutes, stayover_day1_minutes,
      stayover_day2_minutes, prep_minutes_per_activity,
      shift_minutes, total_staff_on_roster, weekly_budget,
      morning_briefing_time, evening_forecast_time,
      pms_type, pms_url, pms_connected
    ) values (
      v_property_id, v_user_id, 'Comfort Suites Beaumont', 74, 0.7362, 10.50,
      30, 20, 15, 20, 5,
      480, 17, 4200,
      '07:30', '16:00',
      'choiceADVANTAGE',
      'https://www.choiceadvantage.com/choicehotels/HousekeepingCenter_start.init#',
      true
    );
    raise notice 'created property %', v_property_id;
  else
    update properties set
      total_rooms = 74,
      avg_occupancy = 0.7362,
      hourly_wage = 10.50,
      checkout_minutes = 30,
      stayover_minutes = 20,
      stayover_day1_minutes = 15,
      stayover_day2_minutes = 20,
      prep_minutes_per_activity = 5,
      shift_minutes = 480,
      total_staff_on_roster = 17,
      weekly_budget = 4200,
      morning_briefing_time = '07:30',
      evening_forecast_time = '16:00',
      pms_type = 'choiceADVANTAGE',
      pms_url = 'https://www.choiceadvantage.com/choicehotels/HousekeepingCenter_start.init#',
      pms_connected = true,
      updated_at = now()
    where id = v_property_id;
    raise notice 'property already exists — config refreshed: %', v_property_id;
  end if;

  -- ── Step 3: accounts (admin with property_access) ───────────────────────
  select id into v_account_id from accounts where username = 'reeyen';

  if v_account_id is null then
    v_account_id := gen_random_uuid();
    insert into accounts (id, username, display_name, role, data_user_id, property_access)
    values (v_account_id, 'reeyen', 'Reeyen Patel', 'admin', v_user_id, array[v_property_id]);
    raise notice 'created account %', v_account_id;
  else
    update accounts set
      display_name = 'Reeyen Patel',
      role = 'admin',
      data_user_id = v_user_id,
      property_access = array[v_property_id],
      updated_at = now()
    where id = v_account_id;
    raise notice 'account already exists — refreshed: %', v_account_id;
  end if;

  -- ── Step 4: staff roster (17 rows, variable HKs + fixed) ────────────────
  insert into staff (property_id, name, is_senior, department, hourly_wage, is_active, schedule_priority, max_days_per_week, max_weekly_hours, language)
  select v_property_id, v.name, v.is_senior, v.department, v.hourly_wage, true, v.schedule_priority, 5, 40, v.language
  from (values
    ('ASTRI RAVANALES',  false, 'housekeeping', 10.50::numeric, 'normal',  'es'),
    ('BRENDA SANDOVAL',  false, 'housekeeping', 10.50::numeric, 'normal',  'es'),
    ('ERIKA RIVERA',     false, 'housekeeping', 10.50::numeric, 'normal',  'es'),
    ('JULIA JACINTO',    false, 'housekeeping', 10.50::numeric, 'normal',  'es'),
    ('LUCIA FLORES',     false, 'housekeeping', 10.50::numeric, 'normal',  'es'),
    ('MAITE BULUX',      false, 'housekeeping', 10.50::numeric, 'normal',  'es'),
    ('MARISOL PEREZ',    false, 'housekeeping', 10.50::numeric, 'normal',  'es'),
    ('MATA HERIBERTO',   false, 'housekeeping', 10.50::numeric, 'normal',  'es'),
    ('YOSELEIN BULUX',   false, 'housekeeping', 10.50::numeric, 'normal',  'es'),
    ('MARIA POSAS',      false, 'housekeeping', 10.50::numeric, 'normal',  'es'),
    ('BRITTNEY COBBS',   true,  'front_desk',   12.00::numeric, 'excluded','en'),
    ('MARIA CASTRO',     true,  'housekeeping', 12.00::numeric, 'excluded','en'),
    ('KATHERINE WHITE',  false, 'front_desk',   12.00::numeric, 'excluded','en'),
    ('MARY MARTINEZ',    false, 'front_desk',   12.00::numeric, 'excluded','en'),
    ('MICHELLE HUMPHREY',false, 'front_desk',   12.00::numeric, 'excluded','en'),
    ('SHANEQUA HAMILTON',false, 'front_desk',   12.00::numeric, 'excluded','en'),
    ('SYLVIA MATA',      false, 'maintenance',  12.00::numeric, 'excluded','en')
  ) as v(name, is_senior, department, hourly_wage, schedule_priority, language)
  where not exists (
    select 1 from staff s
    where s.property_id = v_property_id and s.name = v.name
  );

  -- ── Step 5: laundry_config (4 categories) ───────────────────────────────
  insert into laundry_config (property_id, name, units_per_checkout, two_bed_multiplier, stayover_factor, room_equivs_per_load, minutes_per_load)
  select v_property_id, v.name, v.units_per_checkout, v.two_bed_multiplier, v.stayover_factor, v.room_equivs_per_load, v.minutes_per_load
  from (values
    ('Towels',      3, 2, 0.5::numeric,  12, 50),
    ('Sheets',      1, 2, 0.0::numeric,  10, 60),
    ('Pillowcases', 2, 2, 0.0::numeric,  40, 50),
    ('Comforters',  1, 2, 0.0::numeric,   4, 90)
  ) as v(name, units_per_checkout, two_bed_multiplier, stayover_factor, room_equivs_per_load, minutes_per_load)
  where not exists (
    select 1 from laundry_config lc
    where lc.property_id = v_property_id and lc.name = v.name
  );

  -- ── Step 6: public_areas (10 areas) ─────────────────────────────────────
  insert into public_areas (property_id, name, floor, locations, frequency_days, minutes_per_clean, start_date)
  select v_property_id, v.name, v.floor, v.locations, v.frequency_days, v.minutes_per_clean, current_date
  from (values
    ('Lobby',           '1',   1, 1, 20),
    ('Breakfast Area',  '1',   1, 1, 30),
    ('Floor 1 Hallway', '1',   1, 2, 15),
    ('Floor 2 Hallway', '2',   1, 2, 15),
    ('Floor 3 Hallway', '3',   1, 2, 15),
    ('Floor 4 Hallway', '4',   1, 2, 15),
    ('Stairwells',      'all', 2, 3, 25),
    ('Elevators',       'all', 1, 1, 10),
    ('Fitness Room',    '1',   1, 1, 15),
    ('Pool Area',       '1',   1, 1, 20)
  ) as v(name, floor, locations, frequency_days, minutes_per_clean)
  where not exists (
    select 1 from public_areas pa
    where pa.property_id = v_property_id and pa.name = v.name
  );

  raise notice '═══ seed complete ═══';
  raise notice 'admin auth user id: %', v_user_id;
  raise notice 'account id:         %', v_account_id;
  raise notice 'property id:        %', v_property_id;

end $seed$;

-- ── Summary ──────────────────────────────────────────────────────────────
select
  (select count(*) from auth.users      where email = 'reeyen@staxis.local') as auth_users,
  (select count(*) from auth.identities i join auth.users u on i.user_id=u.id where u.email='reeyen@staxis.local') as identities,
  (select count(*) from accounts        where username = 'reeyen')           as accounts,
  (select count(*) from properties      where name = 'Comfort Suites Beaumont') as properties,
  (select count(*) from staff s join properties p on s.property_id=p.id where p.name='Comfort Suites Beaumont') as staff,
  (select count(*) from laundry_config lc join properties p on lc.property_id=p.id where p.name='Comfort Suites Beaumont') as laundry,
  (select count(*) from public_areas pa join properties p on pa.property_id=p.id where p.name='Comfort Suites Beaumont') as public_areas;
