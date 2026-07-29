-- 0392_management_company_patterns.sql
--
-- Immutable, reproducible evidence for management-company patterns.  The
-- existing company_findings table remains the mutable queue projection; every
-- number behind that projection is retained here at the run/candidate level.
--
-- Security invariants:
--   * organization_id is present on every row and every evidence FK carries it
--   * a property may participate only through the exact portfolio snapshot of
--     the run; live membership is never used to reinterpret historical runs
--   * all tables are service-role-only with explicit browser deny policies
--   * run evidence is insert-only, fenced, and sealed when its run terminates
--   * profile values are nullable overrides: this migration never invents a
--     currency, service level, market, operating model, or amenity
--   * every *_hash value is a bare lowercase 64-hex SHA-256 digest; callers
--     using a named/prefixed fingerprint representation must strip and validate
--     that prefix before persistence
--   * active projection is fail-closed; reserved projector bodies cannot run
--     until a separately reviewed per-organization cutover migration

-- ---------------------------------------------------------------------------
-- Versioned property comparison-profile overrides.
--
-- Effective resolution is deterministic: among rows whose effective_from is
-- at/before the requested instant and whose optional effective_to is after it,
-- choose the greatest (effective_from, profile_version).  This permits an
-- immutable later version to supersede an open-ended older version.
-- ---------------------------------------------------------------------------

-- @rls: service-role-only — versioned portfolio comparison configuration is never browser-readable.
create table if not exists public.management_pattern_property_profiles (
  id                       uuid primary key default gen_random_uuid(),
  -- Scalar snapshot identities deliberately have no live parent FK. Insert
  -- validation proves the relationship once; later hotel/org deletion must
  -- not rewrite or make historical evidence unreplayable.
  organization_id          uuid not null,
  property_id              uuid not null,
  property_relationship_id uuid not null,
  profile_version          integer not null check (profile_version >= 1),
  effective_from           timestamptz not null,
  effective_to             timestamptz,

  currency_code            text check (currency_code is null or currency_code ~ '^[A-Z]{3}$'),
  currency_minor_unit_exponent smallint check (
                               currency_minor_unit_exponent is null
                               or currency_minor_unit_exponent between 0 and 4
                             ),
  service_level            text check (service_level is null or char_length(btrim(service_level)) between 1 and 80),
  market_type              text check (market_type is null or char_length(btrim(market_type)) between 1 and 80),
  brand_class              text check (brand_class is null or char_length(btrim(brand_class)) between 1 and 80),
  location_type            text check (location_type is null or char_length(btrim(location_type)) between 1 and 80),
  operating_model          text check (operating_model is null or char_length(btrim(operating_model)) between 1 and 80),
  room_count               integer check (room_count is null or room_count > 0),
  timezone_name            text check (timezone_name is null or char_length(btrim(timezone_name)) between 1 and 120),
  business_date_cutoff_hour integer check (
                               business_date_cutoff_hour is null
                               or business_date_cutoff_hour between 0 and 23
                             ),
  amenity_tags             text[],
  comparison_attributes    jsonb not null default '{}'::jsonb
                             check (jsonb_typeof(comparison_attributes) = 'object'),

  source_kind              text not null check (source_kind in (
                             'organization_override', 'property_authoritative', 'verified_import'
                           )),
  source_reference         text check (source_reference is null or char_length(source_reference) between 1 and 500),
  change_reason            text not null check (char_length(btrim(change_reason)) between 1 and 500),
  -- Immutable attribution scalar. Insert validation proves the live account;
  -- no FK may later rewrite an append-only profile during account deletion.
  created_by_account_id    uuid,
  created_at               timestamptz not null default now(),

  constraint management_pattern_property_profiles_org_id_key
    unique (organization_id, id),
  constraint management_pattern_property_profiles_org_id_property_key
    unique (organization_id, id, property_id),
  constraint management_pattern_property_profiles_org_property_version_key
    unique (organization_id, property_id, profile_version),
  constraint management_pattern_property_profiles_window_check
    check (effective_to is null or effective_to > effective_from),
  constraint management_pattern_property_profiles_currency_pair_check
    check ((currency_code is null) = (currency_minor_unit_exponent is null)),
  constraint management_pattern_property_profiles_has_override_check
    check (
      currency_code is not null or service_level is not null or market_type is not null
      or brand_class is not null or location_type is not null or operating_model is not null
      or room_count is not null or timezone_name is not null
      or business_date_cutoff_hour is not null
      -- An explicit empty array is a verified "no amenities in this
      -- comparison dimension" override.  It must remain distinct from NULL,
      -- which means unknown/not overridden.
      or amenity_tags is not null
      or comparison_attributes <> '{}'::jsonb
    )
);

create index if not exists management_pattern_profiles_effective_idx
  on public.management_pattern_property_profiles
    (organization_id, property_id, effective_from desc, profile_version desc);
create index if not exists management_pattern_profiles_source_cutoff_idx
  on public.management_pattern_property_profiles
    (organization_id, property_id, created_at, effective_from desc, profile_version desc);
create index if not exists management_pattern_profiles_property_retention_idx
  on public.management_pattern_property_profiles (property_id, organization_id);
create index if not exists management_pattern_profiles_attributes_gin
  on public.management_pattern_property_profiles using gin (comparison_attributes);
create index if not exists management_pattern_profiles_amenities_gin
  on public.management_pattern_property_profiles using gin (amenity_tags);

-- ---------------------------------------------------------------------------
-- Durable, leased and fenced runs.
-- ---------------------------------------------------------------------------

-- @rls: service-role-only — run receipts contain cross-property evidence and cost metadata.
create table if not exists public.management_pattern_runs (
  id                              uuid primary key default gen_random_uuid(),
  organization_id                 uuid not null references public.organizations(id) on delete restrict,
  run_key                         text not null check (char_length(run_key) between 1 and 200),
  triggered_by                    text not null default 'scheduled'
                                    check (triggered_by in ('scheduled','manual','backfill','replay')),
  projection_mode                 text not null default 'shadow'
                                    check (projection_mode in ('shadow','active')),
  supersedes_run_id               uuid,

  engine_version                  text not null check (char_length(engine_version) between 1 and 120),
  evidence_schema_version         integer not null default 2 check (evidence_schema_version >= 1),
  cohort_policy_version           text not null check (char_length(cohort_policy_version) between 1 and 120),
  normalization_policy_version    text not null check (char_length(normalization_policy_version) between 1 and 120),
  dedupe_policy_version           text not null check (char_length(dedupe_policy_version) between 1 and 120),
  scope_policy_version            text not null check (char_length(scope_policy_version) between 1 and 120),
  model_versions                  jsonb not null default '{}'::jsonb
                                    check (jsonb_typeof(model_versions) = 'object'),
  model_call_budget               integer not null default 0 check (model_call_budget >= 0),
  token_budget                    bigint not null default 0 check (token_budget >= 0),
  cost_budget_microusd            bigint not null default 0 check (cost_budget_microusd >= 0),
  duration_budget_ms              integer not null default 120000 check (duration_budget_ms > 0),
  db_query_budget                 integer not null default 20 check (db_query_budget between 1 and 1000),

  input_hash                      text not null check (input_hash ~ '^[0-9a-f]{64}$'),
  input_manifest                  jsonb not null default '{}'::jsonb
                                    check (jsonb_typeof(input_manifest) = 'object'),
  portfolio_snapshot              jsonb not null
                                    check (jsonb_typeof(portfolio_snapshot) in ('array','object')),
  portfolio_snapshot_hash         text not null check (portfolio_snapshot_hash ~ '^[0-9a-f]{64}$'),
  evaluation_at                   timestamptz not null,
  source_as_of                    timestamptz not null,
  topology_as_of                  timestamptz not null,
  window_start                    timestamptz not null,
  window_end                      timestamptz not null,

  status                          text not null default 'running'
                                    check (status in ('claimed','running','succeeded','abstained','failed')),
  owner_token                     uuid not null,
  fencing_token                   bigint not null default 1 check (fencing_token >= 1),
  attempt_count                   integer not null default 1 check (attempt_count >= 1),
  lease_expires_at                timestamptz not null,
  heartbeat_at                    timestamptz not null default now(),
  started_at                      timestamptz not null default now(),
  completed_at                    timestamptz,

  property_count                  integer not null default 0 check (property_count >= 0),
  included_property_count         integer not null default 0 check (included_property_count >= 0),
  excluded_property_count         integer not null default 0 check (excluded_property_count >= 0),
  cohort_count                    integer not null default 0 check (cohort_count >= 0),
  cohort_member_count             integer not null default 0 check (cohort_member_count >= 0),
  observation_count               integer not null default 0 check (observation_count >= 0),
  source_fact_count               integer not null default 0 check (source_fact_count >= 0),
  observation_link_count          integer not null default 0 check (observation_link_count >= 0),
  check_count                     integer not null default 0 check (check_count >= 0),
  outcome_count                   integer not null default 0 check (outcome_count >= 0),
  candidate_count                 integer not null default 0 check (candidate_count >= 0),
  abstention_count                integer not null default 0 check (abstention_count >= 0),
  quality_failure_count           integer not null default 0 check (quality_failure_count >= 0),
  model_call_count                integer not null default 0 check (model_call_count >= 0),
  prompt_token_count              bigint not null default 0 check (prompt_token_count >= 0),
  completion_token_count          bigint not null default 0 check (completion_token_count >= 0),
  estimated_cost_microusd         bigint not null default 0 check (estimated_cost_microusd >= 0),
  db_query_count                  integer not null default 0 check (db_query_count >= 0),
  duration_ms                     integer check (duration_ms is null or duration_ms >= 0),
  quality_summary                 jsonb not null default '{}'::jsonb
                                    check (jsonb_typeof(quality_summary) = 'object'),
  performance_summary             jsonb not null default '{}'::jsonb
                                    check (jsonb_typeof(performance_summary) = 'object'),
  cost_summary                    jsonb not null default '{}'::jsonb
                                    check (jsonb_typeof(cost_summary) = 'object'),
  error_detail                    jsonb not null default '{}'::jsonb
                                    check (jsonb_typeof(error_detail) = 'object'),
  created_at                      timestamptz not null default now(),

  constraint management_pattern_runs_org_id_key unique (organization_id, id),
  constraint management_pattern_runs_org_run_key_key unique (organization_id, run_key),
  constraint management_pattern_runs_supersedes_fkey
    foreign key (organization_id, supersedes_run_id)
    references public.management_pattern_runs(organization_id, id)
    on delete no action deferrable initially deferred,
  constraint management_pattern_runs_window_check check (window_end > window_start),
  constraint management_pattern_runs_as_of_check check (
    topology_as_of <= source_as_of and source_as_of <= evaluation_at
  ),
  constraint management_pattern_runs_projection_authority_check check (
    projection_mode = 'shadow' or triggered_by in ('scheduled','manual')
  ),
  constraint management_pattern_runs_started_check check (heartbeat_at >= started_at),
  constraint management_pattern_runs_completion_check check (
    (status in ('claimed','running') and completed_at is null)
    or (status in ('succeeded','abstained','failed') and completed_at is not null and completed_at >= started_at)
  ),
  constraint management_pattern_runs_counts_check check (
    included_property_count + excluded_property_count <= property_count
  ),
  constraint management_pattern_runs_failed_detail_check check (
    status <> 'failed' or error_detail <> '{}'::jsonb
  ),
  constraint management_pattern_runs_model_receipt_check check (
    model_call_count = 0 or model_versions <> '{}'::jsonb
  ),
  constraint management_pattern_runs_budget_check check (
    status = 'failed'
    or (
      model_call_count <= model_call_budget
      and prompt_token_count + completion_token_count <= token_budget
      and estimated_cost_microusd <= cost_budget_microusd
      and db_query_count <= db_query_budget
      and (duration_ms is null or duration_ms <= duration_budget_ms)
    )
  )
);

create index if not exists management_pattern_runs_org_status_idx
  on public.management_pattern_runs (organization_id, status, evaluation_at desc);
create index if not exists management_pattern_runs_org_input_idx
  on public.management_pattern_runs (organization_id, input_hash, engine_version, evaluation_at desc);
create index if not exists management_pattern_runs_org_as_of_idx
  on public.management_pattern_runs
    (organization_id, topology_as_of desc, source_as_of desc, evaluation_at desc);
create index if not exists management_pattern_runs_lease_idx
  on public.management_pattern_runs (status, lease_expires_at)
  where status in ('claimed','running');
create index if not exists management_pattern_runs_snapshot_gin
  on public.management_pattern_runs using gin (portfolio_snapshot);
create index if not exists management_pattern_runs_quality_gin
  on public.management_pattern_runs using gin (quality_summary);

-- Persistent lock rows make absent-row claims and semantic-root projections
-- serializable without relying on process-local locks or hash collisions.
-- @rls: service-role-only — internal serialization state has no end-user API.
create table if not exists public.management_pattern_run_locks (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  run_key          text not null check (char_length(run_key) between 1 and 200),
  created_at       timestamptz not null default now(),
  primary key (organization_id, run_key)
);

-- ---------------------------------------------------------------------------
-- Exact relational portfolio snapshot.  There is deliberately no FK to the
-- live property row: deleting or moving a hotel must not rewrite old evidence.
-- ---------------------------------------------------------------------------

-- @rls: service-role-only — immutable cross-property membership snapshots are projected through scoped server routes.
create table if not exists public.management_pattern_run_properties (
  organization_id             uuid not null,
  run_id                       uuid not null,
  run_fencing_token            bigint not null check (run_fencing_token >= 1),
  property_id                  uuid not null,
  property_name                text not null check (char_length(btrim(property_name)) between 1 and 200),
  membership_relationship_id   uuid not null,
  membership_snapshot          jsonb not null check (jsonb_typeof(membership_snapshot) = 'object'),
  profile_id                   uuid,
  profile_snapshot             jsonb not null default '{}'::jsonb
                                 check (jsonb_typeof(profile_snapshot) = 'object'),
  timezone_name                text check (timezone_name is null or char_length(btrim(timezone_name)) between 1 and 120),
  business_date_cutoff_hour    integer check (
                                 business_date_cutoff_hour is null
                                 or business_date_cutoff_hour between 0 and 23
                               ),
  currency_code                text check (currency_code is null or currency_code ~ '^[A-Z]{3}$'),
  currency_minor_unit_exponent smallint check (
                                 currency_minor_unit_exponent is null
                                 or currency_minor_unit_exponent between 0 and 4
                               ),
  eligibility_status           text not null check (eligibility_status in ('included','excluded')),
  exclusion_codes              text[] not null default '{}'::text[],
  property_snapshot_hash       text not null check (property_snapshot_hash ~ '^[0-9a-f]{64}$'),
  created_at                   timestamptz not null default now(),

  primary key (organization_id, run_id, property_id),
  constraint management_pattern_run_properties_run_fkey
    foreign key (organization_id, run_id)
    references public.management_pattern_runs(organization_id, id) on delete cascade,
  constraint management_pattern_run_properties_exclusion_check check (
    (eligibility_status = 'included' and cardinality(exclusion_codes) = 0)
    or (eligibility_status = 'excluded' and cardinality(exclusion_codes) > 0)
  ),
  constraint management_pattern_run_properties_currency_pair_check check (
    (currency_code is null) = (currency_minor_unit_exponent is null)
  )
);

create index if not exists management_pattern_run_properties_status_idx
  on public.management_pattern_run_properties (organization_id, run_id, eligibility_status, property_id);
create index if not exists management_pattern_run_properties_property_idx
  on public.management_pattern_run_properties (organization_id, property_id, created_at desc);
create index if not exists management_pattern_run_properties_retention_idx
  on public.management_pattern_run_properties (property_id, organization_id, run_id);
create index if not exists management_pattern_run_properties_profile_gin
  on public.management_pattern_run_properties using gin (profile_snapshot);

-- ---------------------------------------------------------------------------
-- Immutable cohort snapshots and normalized membership/exclusion decisions.
-- ---------------------------------------------------------------------------

-- @rls: service-role-only — cohort definitions can reveal the portfolio and are server-projected only.
create table if not exists public.management_pattern_cohorts (
  id                       uuid primary key,
  organization_id          uuid not null,
  run_id                   uuid not null,
  run_fencing_token        bigint not null check (run_fencing_token >= 1),
  cohort_key               text not null check (char_length(cohort_key) between 1 and 160),
  definition_version       text not null check (char_length(definition_version) between 1 and 120),
  definition_hash          text not null check (definition_hash ~ '^[0-9a-f]{64}$'),
  target_property_id       uuid,
  status                   text not null check (status in ('ready','fallback','abstained')),
  fallback_level           integer not null default 0 check (fallback_level >= 0),
  minimum_member_count     integer not null check (minimum_member_count >= 2),
  eligible_member_count    integer not null default 0 check (eligible_member_count >= 0),
  included_member_count    integer not null default 0 check (included_member_count >= 0),
  excluded_member_count    integer not null default 0 check (excluded_member_count >= 0),
  dimension_keys           text[] not null default '{}'::text[],
  definition               jsonb not null check (jsonb_typeof(definition) = 'object'),
  quality                   jsonb not null default '{}'::jsonb check (jsonb_typeof(quality) = 'object'),
  abstention_reason         text check (abstention_reason is null or char_length(abstention_reason) between 1 and 500),
  created_at                timestamptz not null default now(),

  constraint management_pattern_cohorts_org_id_key unique (organization_id, id),
  constraint management_pattern_cohorts_org_id_run_key unique (organization_id, id, run_id),
  constraint management_pattern_cohorts_org_run_key_key unique (organization_id, run_id, cohort_key),
  constraint management_pattern_cohorts_run_fkey
    foreign key (organization_id, run_id)
    references public.management_pattern_runs(organization_id, id) on delete cascade,
  constraint management_pattern_cohorts_target_fkey
    foreign key (organization_id, run_id, target_property_id)
    references public.management_pattern_run_properties(organization_id, run_id, property_id) on delete cascade,
  constraint management_pattern_cohorts_counts_check check (
    included_member_count + excluded_member_count <= eligible_member_count
  ),
  constraint management_pattern_cohorts_viability_check check (
    (status in ('ready','fallback') and included_member_count >= minimum_member_count and abstention_reason is null)
    or (status = 'abstained' and abstention_reason is not null)
  )
);

create index if not exists management_pattern_cohorts_run_status_idx
  on public.management_pattern_cohorts (organization_id, run_id, status, cohort_key);
create index if not exists management_pattern_cohorts_definition_gin
  on public.management_pattern_cohorts using gin (definition);

-- @rls: service-role-only — cohort membership is cross-property evidence, never a direct browser table.
create table if not exists public.management_pattern_cohort_members (
  organization_id       uuid not null,
  run_id                 uuid not null,
  run_fencing_token      bigint not null check (run_fencing_token >= 1),
  cohort_id              uuid not null,
  property_id            uuid not null,
  profile_id             uuid,
  membership_status      text not null check (membership_status in ('included','excluded')),
  member_role            text not null check (member_role in ('target','comparator','member')),
  exclusion_codes        text[] not null default '{}'::text[],
  normalized_dimensions  jsonb not null default '{}'::jsonb
                           check (jsonb_typeof(normalized_dimensions) = 'object'),
  distance_score         numeric check (
                           distance_score is null
                           or (
                             distance_score not in (
                               'NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric
                             )
                             and distance_score >= 0
                           )
                         ),
  comparison_weight      numeric check (
                           comparison_weight is null
                           or (
                             comparison_weight not in (
                               'NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric
                             )
                             and comparison_weight > 0
                           )
                         ),
  decision_reason        text not null check (char_length(btrim(decision_reason)) between 1 and 500),
  created_at             timestamptz not null default now(),

  primary key (organization_id, cohort_id, property_id),
  constraint management_pattern_cohort_members_cohort_fkey
    foreign key (organization_id, cohort_id, run_id)
    references public.management_pattern_cohorts(organization_id, id, run_id) on delete cascade,
  constraint management_pattern_cohort_members_run_property_fkey
    foreign key (organization_id, run_id, property_id)
    references public.management_pattern_run_properties(organization_id, run_id, property_id) on delete cascade,
  constraint management_pattern_cohort_members_exclusion_check check (
    (membership_status = 'included' and cardinality(exclusion_codes) = 0)
    or (membership_status = 'excluded' and cardinality(exclusion_codes) > 0)
  ),
  constraint management_pattern_cohort_members_weight_check check (
    membership_status = 'included' or comparison_weight is null
  )
);

create index if not exists management_pattern_cohort_members_property_idx
  on public.management_pattern_cohort_members
    (organization_id, run_id, property_id, membership_status);
create index if not exists management_pattern_cohort_members_exclusions_gin
  on public.management_pattern_cohort_members using gin (exclusion_codes);
create index if not exists management_pattern_cohort_members_dimensions_gin
  on public.management_pattern_cohort_members using gin (normalized_dimensions);

-- ---------------------------------------------------------------------------
-- Immutable metric observations.  Raw values and normalized values coexist;
-- normalization is never allowed without its denominator and method.
-- ---------------------------------------------------------------------------

-- @rls: service-role-only — raw and normalized evidence is available only through scoped projections.
create table if not exists public.management_pattern_metric_observations (
  -- Supplied by the deterministic evaluator.  A generated identifier would
  -- make retry-conflict detection unable to prove that two receipts are the
  -- same observation.
  id                         uuid primary key,
  organization_id            uuid not null,
  run_id                     uuid not null,
  run_fencing_token          bigint not null check (run_fencing_token >= 1),
  property_id                uuid not null,
  cohort_id                  uuid,
  metric_key                 text not null check (char_length(metric_key) between 1 and 120),
  metric_version             text not null check (char_length(metric_version) between 1 and 120),

  -- NULL is a first-class proven-query result, not zero. It is allowed only
  -- on a non-usable receipt that explicitly records numerator_missing.
  raw_value                  numeric check (
                               raw_value is null
                               or raw_value not in (
                                 'NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric
                               )
                             ),
  raw_unit                   text not null check (char_length(btrim(raw_unit)) between 1 and 80),
  raw_currency_code          text check (raw_currency_code is null or raw_currency_code ~ '^[A-Z]{3}$'),
  raw_currency_minor_unit_exponent smallint check (
                                 raw_currency_minor_unit_exponent is null
                                 or raw_currency_minor_unit_exponent between 0 and 4
                               ),
  denominator_key            text check (denominator_key is null or char_length(denominator_key) between 1 and 120),
  -- Zero and NULL are evidence: they distinguish a proven zero denominator
  -- from a missing value.  They are never allowed to yield normalized output.
  denominator_value          numeric check (
                               denominator_value is null
                               or (
                                 denominator_value not in (
                                   'NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric
                                 )
                                 and denominator_value >= 0
                               )
                             ),
  denominator_unit           text check (denominator_unit is null or char_length(btrim(denominator_unit)) between 1 and 80),
  denominator_window_kind    text check (
                               denominator_window_kind is null
                               or denominator_window_kind in ('business_dates','instant_range')
                             ),
  denominator_window_start_local timestamp without time zone,
  denominator_window_end_local   timestamp without time zone,
  denominator_window_timezone    text check (
                                   denominator_window_timezone is null
                                   or char_length(btrim(denominator_window_timezone)) between 1 and 120
                                 ),
  denominator_business_date_cutoff_hour smallint check (
                                   denominator_business_date_cutoff_hour is null
                                   or denominator_business_date_cutoff_hour between 0 and 23
                                 ),
  denominator_window_start_utc   timestamptz,
  denominator_window_end_utc     timestamptz,
  denominator_as_of              timestamptz,
  denominator_completeness_ratio numeric check (
                                   denominator_completeness_ratio is null
                                   or (
                                     denominator_completeness_ratio not in (
                                       'NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric
                                     )
                                     and denominator_completeness_ratio between 0 and 1
                                   )
                                 ),
  denominator_freshness_age_seconds numeric check (
                                   denominator_freshness_age_seconds is null
                                   or (
                                     denominator_freshness_age_seconds not in (
                                       'NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric
                                     )
                                     and denominator_freshness_age_seconds
                                       between -3155760000 and 3155760000
                                   )
                                 ),
  denominator_source_query_id    text check (
                                   denominator_source_query_id is null
                                   or char_length(denominator_source_query_id) between 1 and 160
                                 ),
  denominator_source_query_version text check (
                                   denominator_source_query_version is null
                                   or char_length(denominator_source_query_version) between 1 and 120
                                 ),
  denominator_source_query       jsonb check (
                                   denominator_source_query is null
                                   or jsonb_typeof(denominator_source_query) = 'object'
                                 ),
  denominator_source_watermark   jsonb check (
                                   denominator_source_watermark is null
                                   or jsonb_typeof(denominator_source_watermark) = 'object'
                                 ),
  denominator_source_snapshot_hash text check (
                                   denominator_source_snapshot_hash is null
                                   or denominator_source_snapshot_hash ~ '^[0-9a-f]{64}$'
                                 ),
  normalized_value           numeric check (
                               normalized_value is null
                               or normalized_value not in (
                                 'NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric
                               )
                             ),
  normalized_unit            text check (normalized_unit is null or char_length(btrim(normalized_unit)) between 1 and 120),
  normalized_currency_code   text check (
                               normalized_currency_code is null
                               or normalized_currency_code ~ '^[A-Z]{3}$'
                             ),
  normalized_currency_minor_unit_exponent smallint check (
                               normalized_currency_minor_unit_exponent is null
                               or normalized_currency_minor_unit_exponent between 0 and 4
                             ),
  currency_conversion_rate  numeric check (
                               currency_conversion_rate is null
                               or (
                                 currency_conversion_rate not in (
                                   'NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric
                                 )
                                 and currency_conversion_rate > 0
                               )
                             ),
  currency_conversion_as_of timestamptz,
  currency_conversion_source_query_id text check (
                               currency_conversion_source_query_id is null
                               or char_length(currency_conversion_source_query_id) between 1 and 160
                             ),
  currency_conversion_source_query_version text check (
                               currency_conversion_source_query_version is null
                               or char_length(currency_conversion_source_query_version) between 1 and 120
                             ),
  currency_conversion_source_snapshot_hash text check (
                               currency_conversion_source_snapshot_hash is null
                               or currency_conversion_source_snapshot_hash ~ '^[0-9a-f]{64}$'
                             ),
  normalization_method       text check (normalization_method is null or char_length(normalization_method) between 1 and 120),
  normalization_policy_version text check (
                               normalization_policy_version is null
                               or char_length(normalization_policy_version) between 1 and 120
                             ),
  normalization_definition_hash text check (
                               normalization_definition_hash is null
                               or normalization_definition_hash ~ '^[0-9a-f]{64}$'
                             ),
  normalization_window_alignment text check (
                               normalization_window_alignment is null
                               or normalization_window_alignment in ('same_local_dates','same_utc_range')
                             ),

  window_kind                text not null check (window_kind in ('business_dates','instant_range')),
  window_start_local         timestamp without time zone not null,
  window_end_local           timestamp without time zone not null,
  window_timezone            text not null check (char_length(btrim(window_timezone)) between 1 and 120),
  business_date_cutoff_hour  smallint check (
                               business_date_cutoff_hour is null
                               or business_date_cutoff_hour between 0 and 23
                             ),
  window_start_utc           timestamptz not null,
  window_end_utc             timestamptz not null,
  as_of                      timestamptz not null,
  completeness_ratio         numeric not null check (
                               completeness_ratio not in (
                                 'NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric
                               )
                               and completeness_ratio between 0 and 1
                             ),
  -- Negative freshness is retained as an invalid future-timestamp receipt;
  -- silently clamping it would destroy the clock-skew evidence.
  freshness_age_seconds      numeric not null
                               check (
                                 freshness_age_seconds not in (
                                   'NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric
                                 )
                                 and freshness_age_seconds
                                   between -3155760000 and 3155760000
                               ),
  quality_status             text not null check (quality_status in (
                               'usable','partial','stale','incompatible','missing_denominator','invalid'
                             )),
  quality_reasons            text[] not null default '{}'::text[],

  source_query_id            text not null check (char_length(source_query_id) between 1 and 160),
  source_query_version       text not null check (char_length(source_query_version) between 1 and 120),
  source_query               jsonb not null check (jsonb_typeof(source_query) = 'object'),
  source_watermark           jsonb not null default '{}'::jsonb
                               check (jsonb_typeof(source_watermark) = 'object'),
  source_snapshot_hash       text not null check (source_snapshot_hash ~ '^[0-9a-f]{64}$'),
  metadata                   jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at                 timestamptz not null default now(),

  constraint management_pattern_observations_org_id_key unique (organization_id, id),
  constraint management_pattern_observations_org_id_run_key unique (organization_id, id, run_id),
  constraint management_pattern_observations_run_property_fkey
    foreign key (organization_id, run_id, property_id)
    references public.management_pattern_run_properties(organization_id, run_id, property_id) on delete cascade,
  constraint management_pattern_observations_cohort_fkey
    foreign key (organization_id, cohort_id, run_id)
    references public.management_pattern_cohorts(organization_id, id, run_id) on delete cascade,
  constraint management_pattern_observations_window_check check (
    window_end_local > window_start_local and window_end_utc > window_start_utc
  ),
  constraint management_pattern_observations_normalization_check check (
    (
      denominator_key is null and denominator_value is null and denominator_unit is null
      and denominator_window_kind is null
      and denominator_window_start_local is null and denominator_window_end_local is null
      and denominator_window_timezone is null
      and denominator_business_date_cutoff_hour is null
      and denominator_window_start_utc is null and denominator_window_end_utc is null
      and denominator_as_of is null and denominator_completeness_ratio is null
      and denominator_freshness_age_seconds is null
      and denominator_source_query_id is null and denominator_source_query_version is null
      and denominator_source_query is null and denominator_source_watermark is null
      and denominator_source_snapshot_hash is null
      and normalized_value is null and normalized_unit is null
      and normalized_currency_code is null
      and normalized_currency_minor_unit_exponent is null
      and normalization_method is null
      and normalization_policy_version is null
      and normalization_definition_hash is null
      and normalization_window_alignment is null
    )
    or (
      -- A complete denominator receipt is retained even when its value is
      -- NULL/zero or its quality gate fails.  Only the nested success branch
      -- may persist normalized values.
      denominator_key is not null and denominator_unit is not null
      and denominator_window_kind is not null
      and denominator_window_start_local is not null and denominator_window_end_local is not null
      and denominator_window_timezone is not null
      and denominator_window_start_utc is not null and denominator_window_end_utc is not null
      and denominator_as_of is not null and denominator_completeness_ratio is not null
      and denominator_freshness_age_seconds is not null
      and denominator_source_query_id is not null and denominator_source_query_version is not null
      and denominator_source_query is not null and denominator_source_watermark is not null
      and denominator_source_snapshot_hash is not null
      and normalization_policy_version is not null
      and normalization_definition_hash is not null
      and normalization_window_alignment is not null
      and (
        (
          normalized_value is null and normalized_unit is null
          and normalized_currency_code is null
          and normalized_currency_minor_unit_exponent is null
          and currency_conversion_rate is null
          and currency_conversion_as_of is null
          and currency_conversion_source_query_id is null
          and currency_conversion_source_query_version is null
          and currency_conversion_source_snapshot_hash is null
          and normalization_method is null
          and quality_status <> 'usable'
        )
        or (
          raw_value is not null
          and
          denominator_value > 0
          and denominator_completeness_ratio = 1
          and normalized_value is not null and normalized_unit is not null
          and normalization_method is not null
          and quality_status = 'usable'
        )
      )
    )
  ),
  constraint management_pattern_observations_denominator_window_check check (
    denominator_window_start_local is null
    or (
      denominator_window_end_local > denominator_window_start_local
      and denominator_window_end_utc > denominator_window_start_utc
      and (
        (denominator_window_kind = 'business_dates'
          and denominator_business_date_cutoff_hour is not null
          and denominator_window_start_local::time = make_time(
            denominator_business_date_cutoff_hour, 0, 0
          )
          and denominator_window_end_local::time = make_time(
            denominator_business_date_cutoff_hour, 0, 0
          ))
        or (denominator_window_kind = 'instant_range'
          and denominator_business_date_cutoff_hour is null
          and denominator_window_start_local::time = time '00:00:00'
          and denominator_window_end_local::time = time '00:00:00')
      )
    )
  ),
  constraint management_pattern_observations_window_kind_check check (
    (
      window_kind = 'business_dates'
      and business_date_cutoff_hour is not null
      and window_start_local::time = make_time(business_date_cutoff_hour, 0, 0)
      and window_end_local::time = make_time(business_date_cutoff_hour, 0, 0)
    )
    or (
      window_kind = 'instant_range'
      and business_date_cutoff_hour is null
      and window_start_local::time = time '00:00:00'
      and window_end_local::time = time '00:00:00'
    )
  ),
  constraint management_pattern_observations_usable_alignment_check check (
    normalized_value is null or quality_status <> 'usable'
    or (
      (
        normalization_window_alignment = 'same_local_dates'
        and denominator_window_start_local::date = window_start_local::date
        and denominator_window_end_local::date = window_end_local::date
        and denominator_window_timezone = window_timezone
      )
      or (
        normalization_window_alignment = 'same_utc_range'
        and denominator_window_start_utc = window_start_utc
        and denominator_window_end_utc = window_end_utc
      )
    )
  ),
  constraint management_pattern_observations_currency_pair_check check (
    (raw_currency_code is null) = (raw_currency_minor_unit_exponent is null)
  ),
  constraint management_pattern_observations_normalized_currency_check check (
    (normalized_currency_code is null) = (normalized_currency_minor_unit_exponent is null)
    and (
      (
        normalized_value is null
        and normalized_currency_code is null
        and normalized_currency_minor_unit_exponent is null
      )
      or (
        normalized_value is not null
        and (
          (
            raw_currency_code is null
            and raw_currency_minor_unit_exponent is null
            and normalized_currency_code is null
            and normalized_currency_minor_unit_exponent is null
          )
          or (
            raw_currency_code is not null
            and raw_currency_minor_unit_exponent is not null
            and normalized_currency_code is not null
            and normalized_currency_minor_unit_exponent is not null
          )
        )
      )
    )
  ),
  constraint management_pattern_observations_currency_conversion_check check (
    (
      currency_conversion_rate is null
      and currency_conversion_as_of is null
      and currency_conversion_source_query_id is null
      and currency_conversion_source_query_version is null
      and currency_conversion_source_snapshot_hash is null
      and (
        normalized_value is null
        or raw_currency_code is null
        or (
          normalized_currency_code = raw_currency_code
          and normalized_currency_minor_unit_exponent = raw_currency_minor_unit_exponent
        )
      )
    )
    or (
      normalized_value is not null
      and raw_currency_code is not null
      and normalized_currency_code is not null
      and (
        normalized_currency_code <> raw_currency_code
        or normalized_currency_minor_unit_exponent <> raw_currency_minor_unit_exponent
      )
      and currency_conversion_rate is not null
      and currency_conversion_as_of is not null
      and currency_conversion_as_of <= as_of
      and currency_conversion_source_query_id is not null
      and currency_conversion_source_query_version is not null
      and currency_conversion_source_snapshot_hash is not null
    )
  ),
  constraint management_pattern_observations_quality_reason_check check (
    (quality_status = 'usable' or cardinality(quality_reasons) > 0)
    and (
      (raw_value is not null and not ('numerator_missing' = any(quality_reasons)))
      or (
        raw_value is null
        and quality_status <> 'usable'
        and normalized_value is null
        and 'numerator_missing' = any(quality_reasons)
      )
    )
    and (
      freshness_age_seconds >= 0
      or (
        quality_status = 'invalid'
        and 'future_source_timestamp' = any(quality_reasons)
      )
    )
    and (
      denominator_freshness_age_seconds is null
      or denominator_freshness_age_seconds >= 0
      or (
        quality_status = 'invalid'
        and 'future_denominator_source_timestamp' = any(quality_reasons)
      )
    )
  ),
  constraint management_pattern_observations_identity_key unique (
    organization_id, run_id, property_id, metric_key,
    window_start_utc, window_end_utc, source_snapshot_hash
  )
);

create index if not exists management_pattern_observations_metric_idx
  on public.management_pattern_metric_observations
    (organization_id, run_id, metric_key, quality_status, property_id);
create index if not exists management_pattern_observations_property_idx
  on public.management_pattern_metric_observations
    (organization_id, property_id, metric_key, window_end_utc desc);
create index if not exists management_pattern_observations_source_idx
  on public.management_pattern_metric_observations
    (organization_id, source_query_id, source_snapshot_hash);
create index if not exists management_pattern_observations_denominator_source_idx
  on public.management_pattern_metric_observations
    (organization_id, denominator_source_query_id, denominator_source_snapshot_hash)
  where denominator_source_query_id is not null;
create index if not exists management_pattern_observations_query_gin
  on public.management_pattern_metric_observations using gin (source_query);
create index if not exists management_pattern_observations_denominator_query_gin
  on public.management_pattern_metric_observations using gin (denominator_source_query)
  where denominator_source_query is not null;
create index if not exists management_pattern_observations_metadata_gin
  on public.management_pattern_metric_observations using gin (metadata);
create index if not exists management_pattern_observations_quality_gin
  on public.management_pattern_metric_observations using gin (quality_reasons);

-- Exact bounded source rows behind each aggregate. Monthly supply closes and
-- daily rooms-sold denominators remain replayable after their operational
-- source tables change; the aggregate observation alone is not sufficient
-- provenance. fact_hash is computed by the database trigger from every scalar
-- field plus PostgreSQL's canonical jsonb text representation.
-- @rls: service-role-only — payloads contain hotel-level operating facts.
create table if not exists public.management_pattern_metric_source_facts (
  organization_id       uuid not null,
  run_id                 uuid not null,
  run_fencing_token      bigint not null check (run_fencing_token >= 1),
  observation_id         uuid not null,
  fact_role              text not null check (fact_role in ('numerator','denominator')),
  fact_kind              text not null check (fact_kind in ('supply_period','rooms_sold_day')),
  fact_key               text not null check (char_length(fact_key) between 1 and 200),
  source_query_id        text not null check (char_length(source_query_id) between 1 and 160),
  source_query_version   text not null check (char_length(source_query_version) between 1 and 120),
  source_recorded_at     timestamptz not null,
  included_in_aggregate boolean not null,
  numeric_value          numeric,
  fact_payload           jsonb not null check (
                           jsonb_typeof(fact_payload) = 'object'
                           and pg_column_size(fact_payload) <= 32768
                         ),
  fact_hash              text not null check (fact_hash ~ '^[0-9a-f]{64}$'),
  created_at             timestamptz not null default now(),

  primary key (organization_id, run_id, observation_id, fact_role, fact_key),
  constraint management_pattern_source_facts_observation_fkey
    foreign key (organization_id, observation_id, run_id)
    references public.management_pattern_metric_observations(organization_id, id, run_id)
    on delete cascade,
  constraint management_pattern_source_facts_role_kind_check check (
    (fact_role = 'numerator' and fact_kind = 'supply_period')
    or (fact_role = 'denominator' and fact_kind = 'rooms_sold_day')
  ),
  constraint management_pattern_source_facts_included_value_check check (
    not included_in_aggregate or numeric_value is not null
  ),
  constraint management_pattern_source_facts_safe_integer_check check (
    numeric_value is null
    or (
      numeric_value not in (
        'NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric
      )
      and numeric_value between 0 and 9007199254740991
      and numeric_value = trunc(numeric_value)
    )
  )
);

create index if not exists management_pattern_source_facts_observation_idx
  on public.management_pattern_metric_source_facts(
    organization_id, run_id, observation_id, fact_role, included_in_aggregate
  );
create index if not exists management_pattern_source_facts_source_idx
  on public.management_pattern_metric_source_facts(
    organization_id, source_query_id, source_query_version, source_recorded_at
  );

-- ---------------------------------------------------------------------------
-- Immutable deterministic check outcomes and their exact observation inputs.
-- ---------------------------------------------------------------------------

-- @rls: service-role-only — deterministic check receipts are internal evidence-plane rows.
create table if not exists public.management_pattern_check_outcomes (
  id                       uuid primary key,
  organization_id          uuid not null,
  run_id                   uuid not null,
  run_fencing_token        bigint not null check (run_fencing_token >= 1),
  outcome_key              text not null check (char_length(outcome_key) between 1 and 200),
  check_id                 text not null check (char_length(check_id) between 1 and 64),
  check_version            text not null check (char_length(check_version) between 1 and 120),
  semantic_family          text not null check (char_length(semantic_family) between 1 and 80),
  root_domain_key          text not null check (char_length(root_domain_key) between 1 and 160),
  target_property_id       uuid,
  cohort_id                uuid,
  result                   text not null check (result in ('normal','candidate','abstained','skipped','error')),
  quality_gate             text not null check (quality_gate in ('passed','failed','not_applicable')),
  deterministic            boolean not null default true check (deterministic),
  input_hash               text not null check (input_hash ~ '^[0-9a-f]{64}$'),
  outcome_hash             text not null check (outcome_hash ~ '^[0-9a-f]{64}$'),
  parameters               jsonb not null default '{}'::jsonb check (jsonb_typeof(parameters) = 'object'),
  evidence                 jsonb not null default '{}'::jsonb check (jsonb_typeof(evidence) = 'object'),
  reason_codes             text[] not null default '{}'::text[],
  candidate_count          integer not null default 0 check (candidate_count >= 0),
  rows_examined            integer not null default 0 check (rows_examined >= 0),
  duration_ms              integer not null default 0 check (duration_ms >= 0),
  created_at               timestamptz not null default now(),

  constraint management_pattern_outcomes_org_id_key unique (organization_id, id),
  constraint management_pattern_outcomes_org_id_run_key unique (organization_id, id, run_id),
  constraint management_pattern_outcomes_org_run_key_key unique (organization_id, run_id, outcome_key),
  constraint management_pattern_outcomes_run_fkey
    foreign key (organization_id, run_id)
    references public.management_pattern_runs(organization_id, id) on delete cascade,
  constraint management_pattern_outcomes_target_fkey
    foreign key (organization_id, run_id, target_property_id)
    references public.management_pattern_run_properties(organization_id, run_id, property_id) on delete cascade,
  constraint management_pattern_outcomes_cohort_fkey
    foreign key (organization_id, cohort_id, run_id)
    references public.management_pattern_cohorts(organization_id, id, run_id) on delete cascade,
  constraint management_pattern_outcomes_quality_check check (
    (result in ('normal','candidate') and quality_gate = 'passed')
    or result in ('abstained','skipped','error')
  ),
  constraint management_pattern_outcomes_candidate_count_check check (
    (result = 'candidate' and candidate_count > 0)
    or (result <> 'candidate' and candidate_count = 0)
  )
);

create index if not exists management_pattern_outcomes_check_idx
  on public.management_pattern_check_outcomes
    (organization_id, run_id, check_id, result, target_property_id);
create index if not exists management_pattern_outcomes_hash_idx
  on public.management_pattern_check_outcomes (organization_id, input_hash, check_version);
create index if not exists management_pattern_outcomes_parameters_gin
  on public.management_pattern_check_outcomes using gin (parameters);
create index if not exists management_pattern_outcomes_evidence_gin
  on public.management_pattern_check_outcomes using gin (evidence);

-- @rls: service-role-only — exact evidence lineage is internal and cross-property.
create table if not exists public.management_pattern_check_observations (
  organization_id       uuid not null,
  run_id                 uuid not null,
  run_fencing_token      bigint not null check (run_fencing_token >= 1),
  check_outcome_id       uuid not null,
  observation_id         uuid not null,
  usage_role             text not null check (usage_role in ('target','baseline','denominator','quality_gate')),
  created_at             timestamptz not null default now(),

  primary key (organization_id, check_outcome_id, observation_id, usage_role),
  constraint management_pattern_check_observations_outcome_fkey
    foreign key (organization_id, check_outcome_id, run_id)
    references public.management_pattern_check_outcomes(organization_id, id, run_id) on delete cascade,
  constraint management_pattern_check_observations_observation_fkey
    foreign key (organization_id, observation_id, run_id)
    references public.management_pattern_metric_observations(organization_id, id, run_id) on delete cascade
);

create index if not exists management_pattern_check_observations_observation_idx
  on public.management_pattern_check_observations
    (organization_id, observation_id, check_outcome_id);
create index if not exists management_pattern_check_observations_run_idx
  on public.management_pattern_check_observations
    (organization_id, run_id, check_outcome_id);

-- ---------------------------------------------------------------------------
-- Immutable deterministic candidates and exact local occurrences.
-- ---------------------------------------------------------------------------

-- @rls: service-role-only — candidate evidence is exposed only after tenant-scoped projection.
create table if not exists public.management_pattern_candidates (
  id                              uuid primary key,
  organization_id                 uuid not null,
  run_id                          uuid not null,
  run_fencing_token               bigint not null check (run_fencing_token >= 1),
  check_outcome_id                uuid not null,
  candidate_key                   text not null check (char_length(candidate_key) between 1 and 200),
  projection_dedupe_key           text not null check (char_length(projection_dedupe_key) between 1 and 200),
  semantic_family                 text not null check (char_length(semantic_family) between 1 and 80),
  root_key                        text not null check (char_length(root_key) between 1 and 160),
  classified_scope                text check (classified_scope in (
                                    'property_local','peer_cohort','group_region','company_wide'
                                  )),
  scope_evidence                  jsonb not null check (jsonb_typeof(scope_evidence) = 'object'),

  decision                        text not null check (decision in ('emit','suppress')),
  suppression_reasons             text[] not null default '{}'::text[],
  summary                         text not null check (char_length(summary) between 1 and 500),
  severity                        text not null check (severity in ('critical','attention','info')),
  disposition                     text not null check (disposition in ('propose','recommend','fyi','ask','drop')),
  receipt_query_id                text not null check (char_length(receipt_query_id) between 1 and 120),
  evidence                        jsonb not null check (jsonb_typeof(evidence) = 'object'),
  effective_at                    timestamptz not null,
  weakest_input_age_days          numeric check (
                                    weakest_input_age_days is null
                                    or (
                                      weakest_input_age_days not in (
                                        'NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric
                                      )
                                      and weakest_input_age_days >= 0
                                    )
                                  ),
  magnitude                       numeric not null check (
                                    magnitude not in (
                                      'NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric
                                    )
                                    and magnitude >= 0
                                  ),
  materiality_score               numeric not null check (
                                    materiality_score not in (
                                      'NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric
                                    )
                                    and materiality_score between 0 and 1
                                  ),
  confidence                      numeric not null check (
                                    confidence not in (
                                      'NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric
                                    )
                                    and confidence between 0 and 1
                                  ),
  confidence_kind                 text not null check (confidence_kind in (
                                    'threshold_progress_not_probability','deterministic_rule'
                                  )),

  price_low_cents                 integer,
  price_high_cents                integer,
  price_currency_code             text check (price_currency_code is null or price_currency_code ~ '^[A-Z]{3}$'),
  price_basis                     text check (price_basis is null or char_length(price_basis) between 1 and 300),
  escalation_factor               numeric,
  escalation_min_delta            numeric,

  routing_metadata                jsonb not null default '{}'::jsonb
                                    check (jsonb_typeof(routing_metadata) = 'object'),
  quality_metadata                jsonb not null default '{}'::jsonb
                                    check (jsonb_typeof(quality_metadata) = 'object'),
  candidate_hash                  text not null check (candidate_hash ~ '^[0-9a-f]{64}$'),
  candidate_schema_version        integer not null default 2 check (candidate_schema_version >= 1),
  created_at                      timestamptz not null default now(),

  constraint management_pattern_candidates_org_id_key unique (organization_id, id),
  constraint management_pattern_candidates_org_id_run_key unique (organization_id, id, run_id),
  constraint management_pattern_candidates_org_run_candidate_key
    unique (organization_id, run_id, candidate_key),
  constraint management_pattern_candidates_outcome_fkey
    foreign key (organization_id, check_outcome_id, run_id)
    references public.management_pattern_check_outcomes(organization_id, id, run_id) on delete cascade,
  constraint management_pattern_candidates_decision_reasons_check check (
    (decision = 'emit' and cardinality(suppression_reasons) = 0
      and classified_scope is not null)
    or (decision = 'suppress' and cardinality(suppression_reasons) > 0)
  ),
  constraint management_pattern_candidates_price_check check (
    (
      price_low_cents is null and price_high_cents is null
      and price_currency_code is null and price_basis is null
    )
    or (
      price_low_cents is not null and price_high_cents is not null
      and price_low_cents >= 0 and price_high_cents > price_low_cents
      and price_currency_code is not null and price_basis is not null
    )
  ),
  constraint management_pattern_candidates_escalation_check check (
    (escalation_factor is null and escalation_min_delta is null)
    or (
      escalation_factor is not null
      and escalation_min_delta is not null
      and
      escalation_factor not in (
        'NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric
      )
      and escalation_min_delta not in (
        'NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric
      )
      and escalation_factor > 1
      and escalation_min_delta > 0
    )
  )
);

create index if not exists management_pattern_candidates_run_idx
  on public.management_pattern_candidates
    (organization_id, run_id, decision, classified_scope, effective_at desc);
create index if not exists management_pattern_candidates_root_idx
  on public.management_pattern_candidates
    (organization_id, semantic_family, root_key, effective_at desc);
create index if not exists management_pattern_candidates_hash_idx
  on public.management_pattern_candidates (organization_id, candidate_hash);
create index if not exists management_pattern_candidates_evidence_gin
  on public.management_pattern_candidates using gin (evidence);
create index if not exists management_pattern_candidates_quality_gin
  on public.management_pattern_candidates using gin (quality_metadata);
create index if not exists management_pattern_candidates_routing_gin
  on public.management_pattern_candidates using gin (routing_metadata);

-- Consolidation is many-to-many: one final candidate can merge manifestations
-- emitted by several deterministic check outcomes, and one outcome can feed
-- several distinct consolidated roots.  The candidate.check_outcome_id column
-- remains the projector's primary detector/version source; this table is the
-- complete lineage.
-- @rls: service-role-only — cross-check consolidation lineage is internal evidence.
create table if not exists public.management_pattern_candidate_outcomes (
  organization_id          uuid not null,
  run_id                    uuid not null,
  run_fencing_token         bigint not null check (run_fencing_token >= 1),
  candidate_id              uuid not null,
  check_outcome_id          uuid not null,
  manifestation_key         text not null
                              check (char_length(manifestation_key) between 1 and 200),
  lineage_role              text not null check (lineage_role in ('primary','supporting')),
  manifestation_evidence   jsonb not null default '{}'::jsonb
                              check (jsonb_typeof(manifestation_evidence) = 'object'),
  created_at                timestamptz not null default now(),

  primary key (
    organization_id, candidate_id, check_outcome_id, manifestation_key
  ),
  constraint management_pattern_candidate_outcomes_candidate_fkey
    foreign key (organization_id, candidate_id, run_id)
    references public.management_pattern_candidates(organization_id, id, run_id)
    on delete cascade,
  constraint management_pattern_candidate_outcomes_outcome_fkey
    foreign key (organization_id, check_outcome_id, run_id)
    references public.management_pattern_check_outcomes(organization_id, id, run_id)
    on delete cascade
);

create unique index if not exists management_pattern_candidate_outcomes_primary_uq
  on public.management_pattern_candidate_outcomes(organization_id, candidate_id)
  where lineage_role = 'primary';
create index if not exists management_pattern_candidate_outcomes_outcome_idx
  on public.management_pattern_candidate_outcomes(
    organization_id, check_outcome_id, candidate_id
  );
create index if not exists management_pattern_candidate_outcomes_run_idx
  on public.management_pattern_candidate_outcomes(
    organization_id, run_id, candidate_id
  );
create index if not exists management_pattern_candidate_outcomes_evidence_gin
  on public.management_pattern_candidate_outcomes using gin (manifestation_evidence);

-- @rls: service-role-only — affected/comparator property lineage is an internal portfolio receipt.
create table if not exists public.management_pattern_candidate_properties (
  organization_id          uuid not null,
  run_id                    uuid not null,
  run_fencing_token         bigint not null check (run_fencing_token >= 1),
  candidate_id              uuid not null,
  property_id               uuid not null,
  occurrence_role           text not null check (occurrence_role in ('affected','comparator','excluded')),
  exclusion_codes           text[] not null default '{}'::text[],
  occurrence_evidence       jsonb not null default '{}'::jsonb
                              check (jsonb_typeof(occurrence_evidence) = 'object'),
  created_at                timestamptz not null default now(),

  primary key (organization_id, candidate_id, property_id),
  constraint management_pattern_candidate_properties_candidate_fkey
    foreign key (organization_id, candidate_id, run_id)
    references public.management_pattern_candidates(organization_id, id, run_id) on delete cascade,
  constraint management_pattern_candidate_properties_run_property_fkey
    foreign key (organization_id, run_id, property_id)
    references public.management_pattern_run_properties(organization_id, run_id, property_id) on delete cascade,
  constraint management_pattern_candidate_properties_role_check check (
    (occurrence_role = 'excluded' and cardinality(exclusion_codes) > 0)
    or (occurrence_role in ('affected','comparator') and cardinality(exclusion_codes) = 0)
  )
);

create index if not exists management_pattern_candidate_properties_property_idx
  on public.management_pattern_candidate_properties
    (organization_id, property_id, occurrence_role, candidate_id);
create index if not exists management_pattern_candidate_properties_run_idx
  on public.management_pattern_candidate_properties
    (organization_id, run_id, candidate_id, property_id);
create index if not exists management_pattern_candidate_properties_evidence_gin
  on public.management_pattern_candidate_properties using gin (occurrence_evidence);

-- A candidate/property row describes membership once, while a property can
-- contribute any number of distinct local manifestations.  Keeping those
-- instances in a separate append-only table avoids dropping all but one hotel
-- finding during portfolio deduplication.  local_instance_id is deterministic
-- and remains usable when the manifestation did not originate in the legacy
-- public.findings ledger.
-- @rls: service-role-only — local manifestations can expose hotel evidence.
create table if not exists public.management_pattern_candidate_local_instances (
  organization_id          uuid not null,
  run_id                    uuid not null,
  run_fencing_token         bigint not null check (run_fencing_token >= 1),
  candidate_id              uuid not null,
  property_id               uuid not null,
  local_instance_id         uuid not null,
  local_finding_id          uuid references public.findings(id) on delete no action,
  occurrence_at             timestamptz not null,
  local_finding_snapshot    jsonb not null default '{}'::jsonb
                              check (jsonb_typeof(local_finding_snapshot) = 'object'),
  occurrence_evidence       jsonb not null default '{}'::jsonb
                              check (jsonb_typeof(occurrence_evidence) = 'object'),
  created_at                timestamptz not null default now(),

  primary key (organization_id, candidate_id, property_id, local_instance_id),
  constraint management_pattern_local_instances_candidate_property_fkey
    foreign key (organization_id, candidate_id, property_id)
    references public.management_pattern_candidate_properties(
      organization_id, candidate_id, property_id
    ) on delete cascade,
  constraint management_pattern_local_instances_candidate_fkey
    foreign key (organization_id, candidate_id, run_id)
    references public.management_pattern_candidates(organization_id, id, run_id)
    on delete cascade
);

create unique index if not exists management_pattern_local_instances_finding_uq
  on public.management_pattern_candidate_local_instances(
    organization_id, candidate_id, property_id, local_finding_id
  ) where local_finding_id is not null;
create index if not exists management_pattern_local_instances_property_idx
  on public.management_pattern_candidate_local_instances(
    organization_id, property_id, occurrence_at desc, candidate_id
  );
create index if not exists management_pattern_local_instances_run_idx
  on public.management_pattern_candidate_local_instances(
    organization_id, run_id, candidate_id, property_id
  );
create index if not exists management_pattern_local_instances_evidence_gin
  on public.management_pattern_candidate_local_instances using gin (occurrence_evidence);

-- Exact per-run root universe. A run cannot claim success until every row has
-- one explicit present/absent/abstained reconciliation. This prevents a zero-
-- outcome or partially evaluated run from silently resolving old findings.
-- @rls: service-role-only — expected root manifests are internal evidence.
create table if not exists public.management_pattern_run_roots (
  organization_id          uuid not null,
  run_id                    uuid not null,
  run_fencing_token         bigint not null check (run_fencing_token >= 1),
  semantic_family          text not null check (char_length(semantic_family) between 1 and 80),
  root_key                 text not null check (char_length(root_key) between 1 and 160),
  root_domain_key          text not null check (char_length(root_domain_key) between 1 and 160),
  detector_ids             text[] not null check (cardinality(detector_ids) > 0),
  detector_versions        jsonb not null check (jsonb_typeof(detector_versions) = 'object'),
  expected_outcome_count   integer not null check (expected_outcome_count > 0),
  expected_outcome_keys    text[] not null check (cardinality(expected_outcome_keys) > 0),
  expected_outcome_set_hash text not null check (expected_outcome_set_hash ~ '^[0-9a-f]{64}$'),
  manifest_source          text not null check (
                             manifest_source = 'detector_plan'
                           ),
  definition_hash          text not null check (definition_hash ~ '^[0-9a-f]{64}$'),
  created_at               timestamptz not null default now(),

  primary key (organization_id, run_id, semantic_family, root_key),
  constraint management_pattern_run_roots_run_fkey
    foreign key (organization_id, run_id)
    references public.management_pattern_runs(organization_id, id) on delete cascade,
  constraint management_pattern_run_roots_domain_check check (
    root_key = root_domain_key or root_key like root_domain_key || ':%'
  ),
  constraint management_pattern_run_roots_expected_count_check check (
    expected_outcome_count = cardinality(expected_outcome_keys)
  )
);

create index if not exists management_pattern_run_roots_detector_idx
  on public.management_pattern_run_roots using gin(detector_ids);

-- Exactly one transactional derived-result batch per run. Its hash is the
-- retry CAS: an ambiguous network retry with identical canonical JSON is a
-- no-op; any changed payload is an input_conflict. Partial table writes cannot
-- survive because the receipt and all derived inserts share one transaction.
-- @rls: service-role-only — batch manifests summarize internal evidence rows.
create table if not exists public.management_pattern_result_batches (
  organization_id          uuid not null,
  run_id                    uuid not null,
  run_fencing_token         bigint not null check (run_fencing_token >= 1),
  batch_hash                text not null check (batch_hash ~ '^[0-9a-f]{64}$'),
  row_counts                jsonb not null check (jsonb_typeof(row_counts) = 'object'),
  created_at                timestamptz not null default now(),
  primary key (organization_id, run_id),
  constraint management_pattern_result_batches_run_fkey
    foreign key (organization_id, run_id)
    references public.management_pattern_runs(organization_id, id) on delete cascade
);

-- A successful normal result may resolve a previously projected root, while
-- abstention must never clear it.  Explicit per-root reconciliation rows make
-- that distinction durable and prevent "candidate absent from this run" from
-- being misread as proof of recovery.
-- @rls: service-role-only — reconciliation is part of the evidence plane.
create table if not exists public.management_pattern_reconciliations (
  id                       uuid primary key,
  organization_id          uuid not null,
  run_id                   uuid not null,
  run_fencing_token        bigint not null check (run_fencing_token >= 1),
  check_outcome_id         uuid not null,
  candidate_id             uuid,
  semantic_family          text not null
                             check (char_length(semantic_family) between 1 and 80),
  root_key                 text not null
                             check (char_length(root_key) between 1 and 160),
  root_domain_key          text not null
                             check (char_length(root_domain_key) between 1 and 160),
  detector_ids             text[] not null check (cardinality(detector_ids) > 0),
  detector_versions        jsonb not null check (jsonb_typeof(detector_versions) = 'object'),
  conclusion               text not null check (conclusion in ('present','absent','abstained')),
  effective_at             timestamptz not null,
  evidence                 jsonb not null default '{}'::jsonb
                             check (jsonb_typeof(evidence) = 'object'),
  reconciliation_hash      text not null check (reconciliation_hash ~ '^[0-9a-f]{64}$'),
  created_at               timestamptz not null default now(),

  constraint management_pattern_reconciliations_org_id_key
    unique (organization_id, id),
  constraint management_pattern_reconciliations_org_id_run_key
    unique (organization_id, id, run_id),
  constraint management_pattern_reconciliations_root_key
    unique (organization_id, run_id, semantic_family, root_key),
  constraint management_pattern_reconciliations_outcome_fkey
    foreign key (organization_id, check_outcome_id, run_id)
    references public.management_pattern_check_outcomes(organization_id, id, run_id)
    on delete cascade,
  constraint management_pattern_reconciliations_candidate_fkey
    foreign key (organization_id, candidate_id, run_id)
    references public.management_pattern_candidates(organization_id, id, run_id)
    on delete cascade,
  constraint management_pattern_reconciliations_manifest_fkey
    foreign key (
      organization_id, run_id, semantic_family, root_key
    ) references public.management_pattern_run_roots(
      organization_id, run_id, semantic_family, root_key
    ) on delete cascade,
  constraint management_pattern_reconciliations_candidate_check check (
    (conclusion = 'present' and candidate_id is not null)
    or (conclusion in ('absent','abstained') and candidate_id is null)
  )
);

create index if not exists management_pattern_reconciliations_projection_idx
  on public.management_pattern_reconciliations(
    organization_id, run_id, conclusion, semantic_family, root_key
  );

-- One root evaluation can be supported by many per-property check outcomes.
-- This M:N receipt is what makes a complete multi-property normal/abstained
-- decision reproducible without inventing an aggregate detector outcome.
-- @rls: service-role-only — root/outcome lineage is internal evidence.
create table if not exists public.management_pattern_reconciliation_outcomes (
  organization_id          uuid not null,
  run_id                    uuid not null,
  run_fencing_token         bigint not null check (run_fencing_token >= 1),
  reconciliation_id        uuid not null,
  check_outcome_id          uuid not null,
  lineage_role              text not null check (lineage_role in ('primary','supporting')),
  created_at                timestamptz not null default now(),

  primary key (organization_id, reconciliation_id, check_outcome_id),
  constraint management_pattern_reconciliation_outcomes_reconciliation_fkey
    foreign key (organization_id, reconciliation_id, run_id)
    references public.management_pattern_reconciliations(organization_id, id, run_id)
    on delete cascade,
  constraint management_pattern_reconciliation_outcomes_outcome_fkey
    foreign key (organization_id, check_outcome_id, run_id)
    references public.management_pattern_check_outcomes(organization_id, id, run_id)
    on delete cascade
);

create unique index if not exists management_pattern_reconciliation_outcomes_primary_uq
  on public.management_pattern_reconciliation_outcomes(
    organization_id, reconciliation_id
  ) where lineage_role = 'primary';
create index if not exists management_pattern_reconciliation_outcomes_outcome_idx
  on public.management_pattern_reconciliation_outcomes(
    organization_id, check_outcome_id, reconciliation_id
  );
create index if not exists management_pattern_reconciliation_outcomes_run_idx
  on public.management_pattern_reconciliation_outcomes(
    organization_id, run_id, reconciliation_id
  );

-- ---------------------------------------------------------------------------
-- Mutable company_findings projection metadata.  Nullable version fields are
-- intentional safe defaults for legacy 0367 rows; the projection RPC fills all
-- of them for management-pattern candidates.
-- ---------------------------------------------------------------------------

alter table public.company_findings
  add column if not exists latest_pattern_run_id uuid,
  add column if not exists latest_pattern_candidate_id uuid,
  add column if not exists latest_pattern_effective_at timestamptz,
  add column if not exists latest_pattern_order_key text,
  add column if not exists semantic_family text,
  add column if not exists root_key text,
  add column if not exists classified_scope text,
  add column if not exists affected_property_ids uuid[] not null default '{}'::uuid[],
  add column if not exists routing_metadata jsonb not null default '{}'::jsonb,
  add column if not exists quality_metadata jsonb not null default '{}'::jsonb,
  add column if not exists pattern_schema_version integer,
  add column if not exists pattern_engine_version text,
  add column if not exists pattern_check_version text,
  add column if not exists pattern_cohort_policy_version text,
  add column if not exists pattern_normalization_policy_version text,
  add column if not exists pattern_dedupe_policy_version text,
  add column if not exists pattern_scope_policy_version text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.company_findings'::regclass
      and conname = 'company_findings_pattern_metadata_check'
  ) then
    alter table public.company_findings
      add constraint company_findings_pattern_metadata_check check (
        (latest_pattern_run_id is null and latest_pattern_candidate_id is null
          and latest_pattern_effective_at is null and latest_pattern_order_key is null)
        or (latest_pattern_run_id is not null and latest_pattern_candidate_id is not null
          and latest_pattern_effective_at is not null and latest_pattern_order_key is not null)
      );
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.company_findings'::regclass
      and conname = 'company_findings_pattern_scope_check'
  ) then
    alter table public.company_findings
      add constraint company_findings_pattern_scope_check check (
        classified_scope is null or classified_scope in (
          'property_local','peer_cohort','group_region','company_wide'
        )
      );
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.company_findings'::regclass
      and conname = 'company_findings_pattern_shape_check'
  ) then
    alter table public.company_findings
      add constraint company_findings_pattern_shape_check check (
        jsonb_typeof(routing_metadata) = 'object'
        and jsonb_typeof(quality_metadata) = 'object'
        and array_position(affected_property_ids, null) is null
        and (semantic_family is null or char_length(semantic_family) between 1 and 80)
        and (root_key is null or char_length(root_key) between 1 and 160)
        and (pattern_schema_version is null or pattern_schema_version >= 1)
        and (latest_pattern_order_key is null or latest_pattern_order_key ~ '^[0-9a-f]{64}$')
      );
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.company_findings'::regclass
      and conname = 'company_findings_latest_pattern_run_fkey'
  ) then
    alter table public.company_findings
      add constraint company_findings_latest_pattern_run_fkey
      foreign key (organization_id, latest_pattern_run_id)
      references public.management_pattern_runs(organization_id, id)
      on delete no action deferrable initially deferred;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.company_findings'::regclass
      and conname = 'company_findings_latest_pattern_candidate_fkey'
  ) then
    alter table public.company_findings
      add constraint company_findings_latest_pattern_candidate_fkey
      foreign key (organization_id, latest_pattern_candidate_id, latest_pattern_run_id)
      references public.management_pattern_candidates(organization_id, id, run_id)
      on delete no action deferrable initially deferred;
  end if;
end
$$;

create unique index if not exists company_findings_one_active_per_pattern_root_uq
  on public.company_findings (organization_id, semantic_family, root_key)
  where semantic_family is not null and root_key is not null
    and status in ('open','updated','known_problem','muted');
create index if not exists company_findings_pattern_run_idx
  on public.company_findings (organization_id, latest_pattern_run_id, latest_pattern_effective_at desc);
create index if not exists company_findings_affected_properties_gin
  on public.company_findings using gin (affected_property_ids);
create index if not exists company_findings_routing_metadata_gin
  on public.company_findings using gin (routing_metadata);
create index if not exists company_findings_quality_metadata_gin
  on public.company_findings using gin (quality_metadata);

-- @rls: service-role-only — internal projection serialization state has no browser surface.
create table if not exists public.management_pattern_projection_locks (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  semantic_family text not null check (char_length(semantic_family) between 1 and 80),
  root_key        text not null check (char_length(root_key) between 1 and 160),
  created_at      timestamptz not null default now(),
  primary key (organization_id, semantic_family, root_key)
);

-- ---------------------------------------------------------------------------
-- Append-only and fencing guards.
-- ---------------------------------------------------------------------------

create or replace function public.staxis_reject_management_pattern_evidence_update()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  raise exception '% is append-only; insert a new version/run row instead', tg_table_name
    using errcode = '55000';
end
$$;

create or replace function public.staxis_validate_management_pattern_profile_insert()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  v_expected_profile_version integer;
  v_latest_profile_created_at timestamptz;
  v_relationship_state jsonb;
  v_relationship_proof_at timestamptz;
  v_relationship_proof_kind text;
  v_relationship_proof_count integer;
  v_relationship_starts_at timestamptz;
  v_relationship_ends_at timestamptz;
  v_relationship_created_at timestamptz;
  v_relationship_updated_at timestamptz;
  v_membership_loss_at timestamptz;
  v_membership_loss_proof_count integer;
  v_live_membership_covers_revision boolean := false;
begin
  -- The database, not a privileged importer, owns the source-knowledge
  -- timestamp. Effective_from may be historical; created_at must truthfully
  -- record when this immutable revision first became available. The final
  -- stamp is assigned after property serialization so same-statement
  -- corrections remain strictly ordered and independently queryable.
  if new.created_by_account_id is not null and not exists (
    select 1 from public.accounts account_row
    where account_row.id = new.created_by_account_id
  ) then
    raise exception 'management pattern profile actor is outside the live account ledger'
      using errcode = '23514';
  end if;
  if not exists (
    select 1 from public.organizations organization_row
    where organization_row.id = new.organization_id
  ) then
    raise exception 'management pattern profile organization is outside the live tenant ledger'
      using errcode = '23514';
  end if;

  -- Property-row serialization makes max(version)+1 race-free even when a
  -- correction reuses the original historical effective_from. The property
  -- remains the stable serialization key after its governing relationship has
  -- ended or moved to another company.
  perform 1
  from public.properties property_row
  where property_row.id = new.property_id
  for update;
  if not found then
    raise exception 'management pattern profile property is outside the live property ledger'
      using errcode = '23514';
  end if;

  -- A late correction may legitimately arrive after the original governing
  -- relationship was ended, moved, or deleted. Resolve exactly one canonical
  -- state at effective_from: an unchanged current row, otherwise the unique
  -- latest event at/before that instant, otherwise the unique earliest event
  -- after it and that event's before-state. Never choose an arbitrary stale
  -- audit image or break causal ties by UUID order.
  select to_jsonb(relationship), relationship.updated_at,
         'unchanged_current_row'::text
  into v_relationship_state, v_relationship_proof_at, v_relationship_proof_kind
  from public.organization_property_relationships relationship
  where relationship.id = new.property_relationship_id
    and relationship.organization_id = new.organization_id
    and relationship.property_id = new.property_id
    and relationship.created_at <= new.effective_from
    and relationship.updated_at <= new.effective_from;

  if not found then
    select max(event_row.occurred_at)
    into v_relationship_proof_at
    from public.organization_access_events event_row
    where event_row.target_type = 'organization_property_relationships'
      and event_row.target_id = new.property_relationship_id::text
      and event_row.occurred_at <= new.effective_from;
    if v_relationship_proof_at is not null then
      v_relationship_proof_kind := 'event_at_or_before';
    else
      select min(event_row.occurred_at)
      into v_relationship_proof_at
      from public.organization_access_events event_row
      where event_row.target_type = 'organization_property_relationships'
        and event_row.target_id = new.property_relationship_id::text
        and event_row.occurred_at > new.effective_from;
      v_relationship_proof_kind := 'event_after_before_state';
    end if;
    if v_relationship_proof_at is not null then
      select count(*)::integer
      into v_relationship_proof_count
      from public.organization_access_events event_row
      where event_row.target_type = 'organization_property_relationships'
        and event_row.target_id = new.property_relationship_id::text
        and event_row.occurred_at = v_relationship_proof_at;
      if v_relationship_proof_count <> 1 then
        raise exception 'management pattern profile relationship history is causally ambiguous'
          using errcode = '23514';
      end if;
      select case when v_relationship_proof_kind = 'event_at_or_before'
        then event_row.after_state else event_row.before_state end
      into v_relationship_state
      from public.organization_access_events event_row
      where event_row.target_type = 'organization_property_relationships'
        and event_row.target_id = new.property_relationship_id::text
        and event_row.occurred_at = v_relationship_proof_at;
    end if;
  end if;

  begin
    v_relationship_starts_at := nullif(v_relationship_state->>'starts_at', '')::timestamptz;
    v_relationship_ends_at := nullif(v_relationship_state->>'ends_at', '')::timestamptz;
    v_relationship_created_at := nullif(v_relationship_state->>'created_at', '')::timestamptz;
    v_relationship_updated_at := nullif(v_relationship_state->>'updated_at', '')::timestamptz;
  exception when invalid_text_representation or datetime_field_overflow then
    raise exception 'management pattern profile relationship history is invalid'
      using errcode = '23514';
  end;
  if jsonb_typeof(v_relationship_state) is distinct from 'object'
    or v_relationship_state->>'id' is distinct from new.property_relationship_id::text
    or v_relationship_state->>'organization_id' is distinct from new.organization_id::text
    or v_relationship_state->>'property_id' is distinct from new.property_id::text
    or coalesce(v_relationship_state->>'relationship_type', '') not in ('operator','owner')
    or coalesce((v_relationship_state->>'is_primary_grouping')::boolean, false) is not true
    or v_relationship_starts_at is null
    or v_relationship_created_at is null
    or v_relationship_updated_at is null
    or v_relationship_starts_at > new.effective_from
    or v_relationship_created_at > new.effective_from
    or v_relationship_updated_at > new.effective_from
  then
    raise exception 'management pattern profile must reference an exact audited governing tenant/property relationship covering its effective window'
      using errcode = '23514';
  end if;

  -- Derive the first event that proves this exact relationship stops governing
  -- the tenant/property. A future ends_at introduced by an audit event is the
  -- authority boundary; identity/tenant/primary changes take effect at the
  -- event itself.
  select min(case
    when event_row.after_state is null
      or event_row.after_state->>'id' is distinct from new.property_relationship_id::text
      or event_row.after_state->>'organization_id' is distinct from new.organization_id::text
      or event_row.after_state->>'property_id' is distinct from new.property_id::text
      or coalesce(event_row.after_state->>'relationship_type', '') not in ('operator','owner')
      or coalesce((event_row.after_state->>'is_primary_grouping')::boolean, false) is not true
      then event_row.occurred_at
    when nullif(event_row.after_state->>'ends_at', '') is not null
      then (event_row.after_state->>'ends_at')::timestamptz
    else null::timestamptz
  end)
  into v_membership_loss_at
  from public.organization_access_events event_row
  where event_row.target_type = 'organization_property_relationships'
    and event_row.target_id = new.property_relationship_id::text
    and event_row.occurred_at > new.effective_from
    and event_row.before_state->>'id' = new.property_relationship_id::text
    and event_row.before_state->>'organization_id' = new.organization_id::text
    and event_row.before_state->>'property_id' = new.property_id::text
    and event_row.before_state->>'relationship_type' in ('operator','owner')
    and coalesce((event_row.before_state->>'is_primary_grouping')::boolean, false);

  if v_membership_loss_at is not null then
    select count(*)::integer into v_membership_loss_proof_count
    from public.organization_access_events event_row
    where event_row.target_type = 'organization_property_relationships'
      and event_row.target_id = new.property_relationship_id::text
      and event_row.occurred_at > new.effective_from
      and (
        event_row.occurred_at = v_membership_loss_at
        or nullif(event_row.after_state->>'ends_at', '')::timestamptz
          = v_membership_loss_at
      );
    if v_membership_loss_proof_count <> 1 then
      raise exception 'management pattern profile membership-loss history is causally ambiguous'
        using errcode = '23514';
    end if;
  end if;

  if v_relationship_ends_at is not null and (
    new.effective_to is null or new.effective_to > v_relationship_ends_at
  ) then
    raise exception 'management pattern profile revision exceeds its relationship interval'
      using errcode = '23514';
  end if;
  if v_membership_loss_at is not null and (
    new.effective_to is null or new.effective_to > v_membership_loss_at
  ) then
    raise exception 'management pattern profile revision exceeds proven membership loss'
      using errcode = '23514';
  end if;
  if v_relationship_ends_at is null and v_membership_loss_at is null then
    select exists (
      select 1 from public.organization_property_relationships relationship
      where relationship.id = new.property_relationship_id
        and relationship.organization_id = new.organization_id
        and relationship.property_id = new.property_id
        and relationship.relationship_type in ('operator','owner')
        and relationship.is_primary_grouping
        and relationship.starts_at <= new.effective_from
        and (
          relationship.ends_at is null
          or (new.effective_to is not null and new.effective_to <= relationship.ends_at)
        )
    ) into v_live_membership_covers_revision;
    if not v_live_membership_covers_revision then
      raise exception 'management pattern profile relationship history lacks a bounded membership proof'
        using errcode = '23514';
    end if;
  end if;

  select coalesce(max(profile.profile_version), 0) + 1,
         max(profile.created_at)
  into v_expected_profile_version, v_latest_profile_created_at
  from public.management_pattern_property_profiles profile
  where profile.organization_id = new.organization_id
    and profile.property_id = new.property_id;
  if new.profile_version is distinct from v_expected_profile_version then
    raise exception 'management pattern profile version must be the next immutable property revision (expected %, received %)',
      v_expected_profile_version, new.profile_version using errcode = '23514';
  end if;
  new.created_at := greatest(
    clock_timestamp(),
    coalesce(
      v_latest_profile_created_at + interval '1 microsecond',
      clock_timestamp()
    )
  );
  return new;
end
$$;

create or replace function public.staxis_validate_management_pattern_run_property_snapshot()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  v_run public.management_pattern_runs%rowtype;
  v_manifest_property jsonb;
  v_relationship jsonb;
  v_starts_at timestamptz;
  v_ends_at timestamptz;
  v_history_proof_at timestamptz;
  v_history_proof_kind text;
  v_canonical_history_proof_at timestamptz;
  v_current_row_authoritative boolean := false;
  v_authoritative_membership boolean := false;
begin
  select run.* into v_run
  from public.management_pattern_runs run
  where run.organization_id = new.organization_id and run.id = new.run_id;
  if not found then
    raise exception 'run property snapshot is outside its organization/run'
      using errcode = '23514';
  end if;
  if (v_run.portfolio_snapshot->>'source_budget_exceeded')::boolean then
    raise exception 'source-budget-exceeded portfolio manifest cannot accept property rows'
      using errcode = '23514';
  end if;
  select property into v_manifest_property
  from jsonb_array_elements(v_run.portfolio_snapshot->'properties') property
  where property->>'property_id' = new.property_id::text;
  if not found
    or v_manifest_property->>'relationship_id'
      is distinct from new.membership_relationship_id::text
    or v_manifest_property->>'property_snapshot_hash'
      is distinct from new.property_snapshot_hash
    or v_manifest_property->>'eligibility_status'
      is distinct from new.eligibility_status
    or v_manifest_property->'exclusion_codes'
      is distinct from to_jsonb(new.exclusion_codes)
  then
    raise exception 'run property row differs from its claimed portfolio manifest'
      using errcode = '23514';
  end if;

  v_relationship := new.membership_snapshot->'relationship';
  begin
    v_starts_at := nullif(v_relationship->>'starts_at', '')::timestamptz;
    v_ends_at := nullif(v_relationship->>'ends_at', '')::timestamptz;
    v_history_proof_at := nullif(v_relationship->>'history_proof_at', '')::timestamptz;
    v_history_proof_kind := v_relationship->>'history_proof_kind';
  exception when invalid_text_representation or datetime_field_overflow then
    raise exception 'run property relationship snapshot has invalid temporal proof'
      using errcode = '23514';
  end;
  if jsonb_typeof(v_relationship) is distinct from 'object'
    or v_relationship->>'id' is distinct from new.membership_relationship_id::text
    or coalesce(v_relationship->>'relationship_type', '') not in ('operator','owner')
    or coalesce(v_history_proof_kind, '') not in (
      'event_at_or_before','event_after_before_state','unchanged_current_row'
    )
    or v_history_proof_at is null
    or v_starts_at is null
    or v_starts_at > v_run.topology_as_of
    or (v_ends_at is not null and v_ends_at <= v_run.topology_as_of) then
    raise exception 'run property relationship snapshot does not prove topology membership'
      using errcode = '23514';
  end if;

  select exists (
    select 1
    from public.organization_property_relationships current_row
    where current_row.id = new.membership_relationship_id
      and current_row.created_at <= v_run.topology_as_of
      and current_row.updated_at <= v_run.topology_as_of
  ) into v_current_row_authoritative;

  if v_history_proof_kind = 'unchanged_current_row' then
    select exists (
      select 1
      from public.organization_property_relationships authoritative
      where authoritative.id = new.membership_relationship_id
        and authoritative.organization_id = new.organization_id
        and authoritative.property_id = new.property_id
        and authoritative.is_primary_grouping
        and authoritative.relationship_type = v_relationship->>'relationship_type'
        and authoritative.starts_at = v_starts_at
        and authoritative.ends_at is not distinct from v_ends_at
        and authoritative.created_at <= v_run.topology_as_of
        and authoritative.updated_at <= v_run.topology_as_of
        and authoritative.updated_at = v_history_proof_at
    ) into v_authoritative_membership;
  elsif v_history_proof_kind in ('event_at_or_before','event_after_before_state') then
    -- Match the source reconstruction's deterministic priority exactly.  A
    -- caller may not choose an older-but-matching audit event after a later
    -- event moved the relationship, nor bypass an authoritative unchanged
    -- current row with an audit receipt.
    if v_current_row_authoritative then
      raise exception 'run property relationship audit proof is superseded by its authoritative current row'
        using errcode = '23514';
    end if;
    if v_history_proof_kind = 'event_at_or_before' then
      select max(event_row.occurred_at) into v_canonical_history_proof_at
      from public.organization_access_events event_row
      where event_row.target_type = 'organization_property_relationships'
        and event_row.target_id = new.membership_relationship_id::text
        and event_row.occurred_at <= v_run.topology_as_of;
    else
      if exists (
        select 1
        from public.organization_access_events event_row
        where event_row.target_type = 'organization_property_relationships'
          and event_row.target_id = new.membership_relationship_id::text
          and event_row.occurred_at <= v_run.topology_as_of
      ) then
        raise exception 'run property relationship audit proof kind is not the canonical nearest receipt'
          using errcode = '23514';
      end if;
      select min(event_row.occurred_at) into v_canonical_history_proof_at
      from public.organization_access_events event_row
      where event_row.target_type = 'organization_property_relationships'
        and event_row.target_id = new.membership_relationship_id::text
        and event_row.occurred_at > v_run.topology_as_of;
    end if;
    if v_canonical_history_proof_at is distinct from v_history_proof_at then
      raise exception 'run property relationship audit proof is not the canonical nearest receipt'
        using errcode = '23514';
    end if;
    if (
      select count(*) <> 1
      from public.organization_access_events event_row
      where event_row.target_type = 'organization_property_relationships'
        and event_row.target_id = new.membership_relationship_id::text
        and event_row.occurred_at = v_history_proof_at
    ) then
      raise exception 'run property relationship audit proof is causally ambiguous'
        using errcode = '23514';
    end if;
    select exists (
      select 1
      from public.organization_access_events event_row
      cross join lateral (values (
        case when v_history_proof_kind = 'event_at_or_before'
          then event_row.after_state else event_row.before_state end
      )) historical(state)
      where event_row.target_type = 'organization_property_relationships'
        and event_row.target_id = new.membership_relationship_id::text
        and event_row.occurred_at = v_history_proof_at
        and (
          (v_history_proof_kind = 'event_at_or_before'
            and event_row.occurred_at <= v_run.topology_as_of)
          or (v_history_proof_kind = 'event_after_before_state'
            and event_row.occurred_at > v_run.topology_as_of)
        )
        and historical.state->>'id' = new.membership_relationship_id::text
        and historical.state->>'organization_id' = new.organization_id::text
        and historical.state->>'property_id' = new.property_id::text
        and (historical.state->>'is_primary_grouping')::boolean
        and historical.state->>'relationship_type'
          = v_relationship->>'relationship_type'
        and (historical.state->>'starts_at')::timestamptz = v_starts_at
        and nullif(historical.state->>'ends_at', '')::timestamptz
          is not distinct from v_ends_at
    ) into v_authoritative_membership;
  end if;
  if not v_authoritative_membership then
    raise exception 'run property relationship snapshot has no authoritative historical tenant proof'
      using errcode = '23514';
  end if;
  return new;
end
$$;

create or replace function public.staxis_guard_management_pattern_parent_delete()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if tg_table_name = 'organizations' and (
    exists (select 1 from public.management_pattern_runs run where run.organization_id = old.id)
    or exists (
      select 1 from public.management_pattern_property_profiles profile
      where profile.organization_id = old.id
    )
  ) then
    raise exception 'organization has retained management pattern evidence; governed retention is required'
      using errcode = '55000';
  elsif tg_table_name = 'properties' and (
    exists (
      select 1 from public.management_pattern_property_profiles profile
      where profile.property_id = old.id
    )
    or exists (
      select 1 from public.management_pattern_run_properties run_property
      where run_property.property_id = old.id
    )
  ) then
    raise exception 'property has retained management pattern evidence; governed retention is required'
      using errcode = '55000';
  end if;
  return old;
end
$$;

create or replace function public.staxis_require_management_pattern_run_fence()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  v_status text;
  v_fencing_token bigint;
  v_lease_expires_at timestamptz;
begin
  select r.status, r.fencing_token, r.lease_expires_at
    into v_status, v_fencing_token, v_lease_expires_at
  from public.management_pattern_runs r
  where r.organization_id = new.organization_id and r.id = new.run_id;

  if not found then
    raise exception 'management pattern run is outside organization scope or absent'
      using errcode = '23503';
  end if;
  if v_status not in ('claimed','running') then
    raise exception 'management pattern run % is sealed with status %', new.run_id, v_status
      using errcode = '55000';
  end if;
  if v_fencing_token is distinct from new.run_fencing_token then
    raise exception 'stale management pattern fencing token: expected %, received %',
      v_fencing_token, new.run_fencing_token using errcode = '40001';
  end if;
  if v_lease_expires_at <= clock_timestamp() then
    raise exception 'management pattern run lease expired' using errcode = '40001';
  end if;
  return new;
end
$$;

create or replace function public.staxis_guard_management_pattern_run_update()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if old.status in ('succeeded','abstained','failed') then
    raise exception 'terminal management pattern runs are immutable' using errcode = '55000';
  end if;

  if row(
    new.id, new.organization_id, new.run_key, new.triggered_by, new.projection_mode,
    new.supersedes_run_id,
    new.engine_version, new.evidence_schema_version, new.cohort_policy_version,
    new.normalization_policy_version, new.dedupe_policy_version, new.scope_policy_version,
    new.model_versions, new.model_call_budget, new.token_budget,
    new.cost_budget_microusd, new.duration_budget_ms, new.db_query_budget,
    new.input_hash, new.input_manifest, new.portfolio_snapshot, new.portfolio_snapshot_hash,
    new.evaluation_at, new.source_as_of, new.topology_as_of,
    new.window_start, new.window_end, new.started_at, new.created_at
  ) is distinct from row(
    old.id, old.organization_id, old.run_key, old.triggered_by, old.projection_mode,
    old.supersedes_run_id,
    old.engine_version, old.evidence_schema_version, old.cohort_policy_version,
    old.normalization_policy_version, old.dedupe_policy_version, old.scope_policy_version,
    old.model_versions, old.model_call_budget, old.token_budget,
    old.cost_budget_microusd, old.duration_budget_ms, old.db_query_budget,
    old.input_hash, old.input_manifest, old.portfolio_snapshot, old.portfolio_snapshot_hash,
    old.evaluation_at, old.source_as_of, old.topology_as_of,
    old.window_start, old.window_end, old.started_at, old.created_at
  ) then
    raise exception 'management pattern run identity/input snapshot is immutable'
      using errcode = '55000';
  end if;

  if new.fencing_token < old.fencing_token or new.fencing_token > old.fencing_token + 1 then
    raise exception 'management pattern fencing token must be monotonic by one'
      using errcode = '40001';
  end if;
  if new.fencing_token = old.fencing_token then
    if new.owner_token is distinct from old.owner_token or new.attempt_count <> old.attempt_count then
      raise exception 'owner/attempt may change only with a new fencing token'
        using errcode = '40001';
    end if;
  else
    if new.attempt_count <> old.attempt_count + 1 then
      raise exception 'a new fencing token requires exactly one new attempt'
        using errcode = '40001';
    end if;
  end if;

  if new.heartbeat_at < old.heartbeat_at or new.lease_expires_at < old.lease_expires_at then
    raise exception 'management pattern heartbeat/lease cannot move backward'
      using errcode = '40001';
  end if;
  if old.status = 'claimed' and new.status not in ('claimed','running','succeeded','abstained','failed') then
    raise exception 'invalid claimed run transition' using errcode = '23514';
  end if;
  if old.status = 'running' and new.status not in ('running','succeeded','abstained','failed') then
    raise exception 'invalid running run transition' using errcode = '23514';
  end if;

  if new.property_count < old.property_count
    or new.included_property_count < old.included_property_count
    or new.excluded_property_count < old.excluded_property_count
    or new.cohort_count < old.cohort_count
    or new.cohort_member_count < old.cohort_member_count
    or new.observation_count < old.observation_count
    or new.source_fact_count < old.source_fact_count
    or new.observation_link_count < old.observation_link_count
    or new.check_count < old.check_count
    or new.outcome_count < old.outcome_count
    or new.candidate_count < old.candidate_count
    or new.abstention_count < old.abstention_count
    or new.quality_failure_count < old.quality_failure_count
    or new.model_call_count < old.model_call_count
    or new.prompt_token_count < old.prompt_token_count
    or new.completion_token_count < old.completion_token_count
    or new.estimated_cost_microusd < old.estimated_cost_microusd
    or new.db_query_count < old.db_query_count then
    raise exception 'management pattern counters cannot decrease' using errcode = '23514';
  end if;
  return new;
end
$$;

create or replace function public.staxis_validate_management_pattern_candidate()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  v_result text;
  v_semantic_family text;
  v_root_domain_key text;
begin
  select o.result, o.semantic_family, o.root_domain_key
    into v_result, v_semantic_family, v_root_domain_key
  from public.management_pattern_check_outcomes o
  where o.organization_id = new.organization_id
    and o.id = new.check_outcome_id
    and o.run_id = new.run_id;
  if not found or v_result <> 'candidate' then
    raise exception 'candidate must reference a candidate check outcome in the same organization/run'
      using errcode = '23514';
  end if;
  if new.semantic_family <> v_semantic_family
    or not (
      new.root_key = v_root_domain_key
      or new.root_key like v_root_domain_key || ':%'
    ) then
    raise exception 'candidate semantic root is outside its primary outcome domain'
      using errcode = '23514';
  end if;
  return new;
end
$$;

create or replace function public.staxis_validate_management_pattern_local_finding()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  v_finding_as_of timestamptz;
begin
  if not exists (
    select 1
    from public.management_pattern_candidate_properties cp
    join public.management_pattern_run_properties rp
      on rp.organization_id = cp.organization_id
     and rp.run_id = cp.run_id
     and rp.property_id = cp.property_id
    join public.management_pattern_runs run
      on run.organization_id = cp.organization_id and run.id = cp.run_id
    where cp.organization_id = new.organization_id
      and cp.candidate_id = new.candidate_id
      and cp.property_id = new.property_id
      and cp.run_id = new.run_id
      and cp.occurrence_role = 'affected'
      and new.occurrence_at >= run.window_start
      and new.occurrence_at < run.window_end
      and new.occurrence_at >=
        (rp.membership_snapshot->'relationship'->>'starts_at')::timestamptz
      and (
        nullif(rp.membership_snapshot->'relationship'->>'ends_at', '') is null
        or new.occurrence_at <
          (rp.membership_snapshot->'relationship'->>'ends_at')::timestamptz
      )
  ) then
    raise exception 'local instance is outside the candidate property, run window, or organization relationship'
      using errcode = '23514';
  end if;

  if new.local_finding_id is not null then
    select coalesce(f.as_of, f.last_seen_at)
      into v_finding_as_of
    from public.findings f
    where f.id = new.local_finding_id and f.property_id = new.property_id;
    if not found then
      raise exception 'local finding does not belong to the linked property'
        using errcode = '23514';
    end if;
    if v_finding_as_of is distinct from new.occurrence_at then
      raise exception 'local finding occurrence_at must equal its reproducible as_of/last_seen instant'
        using errcode = '23514';
    end if;
  end if;
  return new;
end
$$;

create or replace function public.staxis_validate_management_pattern_candidate_outcome()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if not exists (
    select 1
    from public.management_pattern_check_outcomes o
    join public.management_pattern_candidates c
      on c.organization_id = o.organization_id
     and c.run_id = o.run_id
     and c.id = new.candidate_id
    where o.organization_id = new.organization_id
      and o.run_id = new.run_id
      and o.id = new.check_outcome_id
      and o.result = 'candidate'
      and c.semantic_family = o.semantic_family
      and (c.root_key = o.root_domain_key or c.root_key like o.root_domain_key || ':%')
  ) then
    raise exception 'candidate lineage may reference only a candidate outcome in the same organization/run'
      using errcode = '23514';
  end if;
  if new.lineage_role = 'primary' and not exists (
    select 1
    from public.management_pattern_candidates c
    where c.organization_id = new.organization_id
      and c.run_id = new.run_id
      and c.id = new.candidate_id
      and c.check_outcome_id = new.check_outcome_id
  ) then
    raise exception 'primary candidate lineage must match candidate.check_outcome_id'
      using errcode = '23514';
  end if;
  return new;
end
$$;

create or replace function public.staxis_validate_management_pattern_reconciliation()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  v_result text;
  v_quality_gate text;
  v_check_id text;
  v_check_version text;
  v_semantic_family text;
  v_root_domain_key text;
  v_root public.management_pattern_run_roots%rowtype;
begin
  select o.result, o.quality_gate, o.check_id, o.check_version,
         o.semantic_family, o.root_domain_key
    into v_result, v_quality_gate, v_check_id, v_check_version,
         v_semantic_family, v_root_domain_key
  from public.management_pattern_check_outcomes o
  where o.organization_id = new.organization_id
    and o.run_id = new.run_id
    and o.id = new.check_outcome_id;
  if not found then
    raise exception 'reconciliation outcome is outside organization/run scope'
      using errcode = '23514';
  end if;
  select root.* into v_root
  from public.management_pattern_run_roots root
  where root.organization_id = new.organization_id
    and root.run_id = new.run_id
    and root.semantic_family = new.semantic_family
    and root.root_key = new.root_key;
  if not found
    or new.detector_ids is distinct from v_root.detector_ids
    or new.detector_versions is distinct from v_root.detector_versions
    or not (v_check_id = any(new.detector_ids))
    or not coalesce(
      new.detector_versions->v_check_id @> jsonb_build_array(v_check_version), false
    )
    or new.semantic_family <> v_semantic_family
    or new.root_domain_key <> v_root_domain_key
    or new.root_domain_key <> v_root.root_domain_key then
    raise exception 'reconciliation detector set/version, semantic family, or root domain is outside its run manifest and primary outcome'
      using errcode = '23514';
  end if;

  if new.conclusion = 'present' then
    if v_result <> 'candidate' or v_quality_gate <> 'passed' or not exists (
      select 1 from public.management_pattern_candidates c
      where c.organization_id = new.organization_id
        and c.run_id = new.run_id
        and c.id = new.candidate_id
        and c.semantic_family = new.semantic_family
        and c.root_key = new.root_key
    ) then
      raise exception 'present reconciliation must pair a matching candidate outcome/root'
        using errcode = '23514';
    end if;
  elsif new.conclusion = 'absent' then
    if v_result <> 'normal' or v_quality_gate <> 'passed' then
      raise exception 'only a successful normal check may prove a root absent'
        using errcode = '23514';
    end if;
  elsif v_result not in ('abstained','skipped','error') then
    raise exception 'abstained reconciliation requires an abstained/skipped/error outcome'
      using errcode = '23514';
  end if;
  return new;
end
$$;

create or replace function public.staxis_validate_management_pattern_run_root()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  v_canonical text[];
  v_detector_keys text[];
  v_detector text;
  v_versions text[];
  v_canonical_versions text[];
  v_hash text;
begin
  select array_agg(distinct detector order by detector) into v_canonical
  from unnest(new.detector_ids) detector;
  if v_canonical is distinct from new.detector_ids
    or exists (
      select 1 from unnest(new.detector_ids) detector
      where char_length(detector) not between 1 and 64
    ) then
    raise exception 'detector_ids must be non-empty, unique, lexically sorted valid IDs'
      using errcode = '23514';
  end if;
  select array_agg(key order by key) into v_detector_keys
  from jsonb_object_keys(new.detector_versions) key;
  if v_detector_keys is distinct from new.detector_ids then
    raise exception 'detector_versions keys must exactly match detector_ids'
      using errcode = '23514';
  end if;
  foreach v_detector in array new.detector_ids loop
    if jsonb_typeof(new.detector_versions->v_detector) <> 'array'
      or jsonb_array_length(new.detector_versions->v_detector) = 0
      or exists (
        select 1 from jsonb_array_elements(new.detector_versions->v_detector) version
        where jsonb_typeof(version) <> 'string'
      ) then
      raise exception 'each detector_versions value must be a non-empty string array'
        using errcode = '23514';
    end if;
    select array_agg(version order by ordinal),
           array_agg(distinct version order by version)
      into v_versions, v_canonical_versions
    from jsonb_array_elements_text(new.detector_versions->v_detector)
      with ordinality values_with_order(version, ordinal);
    if v_versions is distinct from v_canonical_versions
      or exists (
        select 1 from unnest(v_versions) version
        where char_length(version) not between 1 and 120
      ) then
      raise exception 'detector version arrays must be unique, lexically sorted valid versions'
        using errcode = '23514';
    end if;
  end loop;

  select array_agg(distinct key order by key) into v_canonical
  from unnest(new.expected_outcome_keys) key;
  if v_canonical is distinct from new.expected_outcome_keys then
    raise exception 'expected_outcome_keys must be unique and lexically sorted'
      using errcode = '23514';
  end if;
  v_hash := encode(
    pg_catalog.sha256(convert_to(array_to_json(v_canonical)::text, 'UTF8')), 'hex'
  );
  if new.expected_outcome_set_hash <> v_hash then
    raise exception 'expected_outcome_set_hash does not match canonical keys'
      using errcode = '23514';
  end if;
  return new;
end
$$;

create or replace function public.staxis_validate_management_pattern_reconciliation_outcome()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  v_reconciliation public.management_pattern_reconciliations%rowtype;
  v_outcome public.management_pattern_check_outcomes%rowtype;
begin
  select rec.* into v_reconciliation
  from public.management_pattern_reconciliations rec
  where rec.organization_id = new.organization_id
    and rec.run_id = new.run_id
    and rec.id = new.reconciliation_id;
  select o.* into v_outcome
  from public.management_pattern_check_outcomes o
  where o.organization_id = new.organization_id
    and o.run_id = new.run_id
    and o.id = new.check_outcome_id;
  if v_reconciliation.id is null or v_outcome.id is null then
    raise exception 'root/outcome lineage is outside organization/run scope'
      using errcode = '23514';
  end if;
  if not (v_outcome.check_id = any(v_reconciliation.detector_ids))
    or not coalesce(
      v_reconciliation.detector_versions->v_outcome.check_id
        @> jsonb_build_array(v_outcome.check_version), false
    )
    or v_outcome.semantic_family <> v_reconciliation.semantic_family
    or v_outcome.root_domain_key <> v_reconciliation.root_domain_key then
    raise exception 'root/outcome lineage crosses declared detector/version, semantic family, or root domain'
      using errcode = '23514';
  end if;
  if new.lineage_role = 'primary'
    and new.check_outcome_id <> v_reconciliation.check_outcome_id then
    raise exception 'primary root/outcome lineage must match reconciliation.check_outcome_id'
      using errcode = '23514';
  end if;
  if (
    v_reconciliation.conclusion = 'present'
    and (v_outcome.result not in ('normal','candidate') or v_outcome.quality_gate <> 'passed')
  ) or (
    v_reconciliation.conclusion = 'absent'
    and (v_outcome.result <> 'normal' or v_outcome.quality_gate <> 'passed')
  ) or (
    v_reconciliation.conclusion = 'abstained'
    and v_outcome.result not in ('normal','candidate','abstained','skipped','error')
  ) then
    raise exception 'root/outcome lineage result contradicts reconciliation conclusion'
      using errcode = '23514';
  end if;
  return new;
end
$$;

create or replace function public.staxis_validate_management_pattern_source_fact()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  v_observation public.management_pattern_metric_observations%rowtype;
  v_fact_date date;
  v_watermark_receipt jsonb;
  v_query_extracted_at timestamptz;
  v_requested_source_as_of timestamptz;
  v_source_cutoff timestamptz;
  v_effective_source_cutoff timestamptz;
  v_source_cutoff_is_exclusive boolean;
  v_source_cutoff_reason text;
  v_source_cutoff_proof_kind text;
  v_source_cutoff_proof_at timestamptz;
  v_payload_recorded_at timestamptz;
  v_payload_created_at timestamptz;
  v_payload_updated_at timestamptz;
  v_payload_terminal_at timestamptz;
  v_payload_window_start timestamptz;
  v_payload_window_end timestamptz;
  v_payload_coverage_through timestamptz;
  v_expected_coverage_through timestamptz;
  v_payload_numeric numeric;
  v_payload_source_numeric numeric;
  v_payload_included boolean;
  v_payload_expected_included boolean;
  v_payload_declared_source_window_compatible boolean;
  v_payload_derived_source_window_compatible boolean;
  v_payload_declared_denominator_complete boolean;
  v_payload_derived_denominator_complete boolean;
  v_hash_receipt jsonb;
begin
  select observation.* into v_observation
  from public.management_pattern_metric_observations observation
  where observation.organization_id = new.organization_id
    and observation.run_id = new.run_id
    and observation.id = new.observation_id;
  if not found then
    raise exception 'metric source fact is outside its organization/run observation'
      using errcode = '23514';
  end if;
  if v_observation.metric_key <> 'inventory_purchase_spend' then
    raise exception 'metric source facts v1 are restricted to inventory purchase spend'
      using errcode = '23514';
  end if;
  if (
    new.fact_role = 'numerator'
    and row(new.source_query_id, new.source_query_version)
      is distinct from row(v_observation.source_query_id, v_observation.source_query_version)
  ) or (
    new.fact_role = 'denominator'
    and row(new.source_query_id, new.source_query_version)
      is distinct from row(
        v_observation.denominator_source_query_id,
        v_observation.denominator_source_query_version
      )
  ) then
    raise exception 'metric source fact query/version differs from its aggregate observation'
      using errcode = '23514';
  end if;
  if new.fact_role = 'numerator' then
    if not (new.fact_payload ?& array[
      'id','month_start','timezone','status','month_start_at','end_at',
      'is_partial','purchase_source','allocation_mode',
      'confirmed_purchase_storage_cents','logged_purchase_storage_cents',
      'manual_purchase_storage_cents','logged_delivery_count',
      'uncosted_delivery_count','quality_flags','quality_flags_oversize',
      'source_window_compatible','closed_at','created_at','updated_at',
      'source_query_id','source_query_version','source_recorded_at',
      'included_in_aggregate','numeric_value'
    ]) or new.fact_payload - array[
      'id','month_start','timezone','status','month_start_at','end_at',
      'is_partial','purchase_source','allocation_mode',
      'confirmed_purchase_storage_cents','logged_purchase_storage_cents',
      'manual_purchase_storage_cents','logged_delivery_count',
      'uncosted_delivery_count','quality_flags','quality_flags_oversize',
      'source_window_compatible','closed_at','created_at','updated_at',
      'source_query_id','source_query_version','source_recorded_at',
      'included_in_aggregate','numeric_value'
    ] <> '{}'::jsonb then
      raise exception 'numerator metric source fact payload has a non-canonical key set'
        using errcode = '23514';
    end if;
    if jsonb_typeof(new.fact_payload->'is_partial') <> 'boolean'
      or jsonb_typeof(new.fact_payload->'quality_flags_oversize') <> 'boolean'
      or jsonb_typeof(new.fact_payload->'source_window_compatible') <> 'boolean'
      or jsonb_typeof(new.fact_payload->'included_in_aggregate') <> 'boolean'
      or jsonb_typeof(new.fact_payload->'confirmed_purchase_storage_cents')
        not in ('number','null')
      or jsonb_typeof(new.fact_payload->'numeric_value') not in ('number','null')
    then
      raise exception 'numerator metric source fact payload has non-canonical value types'
        using errcode = '23514';
    end if;
    if coalesce(new.fact_payload->>'status', '') not in ('open','closed')
      or (
        new.fact_payload->>'purchase_source' is not null
        and new.fact_payload->>'purchase_source'
          not in ('logged_deliveries','manual_total','zero')
      )
      or (
        new.fact_payload->>'allocation_mode' is not null
        and new.fact_payload->>'allocation_mode' not in ('itemized','total_only')
      )
      or jsonb_typeof(new.fact_payload->'quality_flags') not in ('array','null')
      or exists (
        select 1
        from jsonb_array_elements(jsonb_build_array(
          new.fact_payload->'confirmed_purchase_storage_cents',
          new.fact_payload->'logged_purchase_storage_cents',
          new.fact_payload->'manual_purchase_storage_cents'
        )) source_number(value)
        where jsonb_typeof(source_number.value) not in ('number','null')
          or (
            jsonb_typeof(source_number.value) = 'number'
            and (
              (source_number.value#>>'{}')::numeric < 0
              or (source_number.value#>>'{}')::numeric > 9007199254740991
              or (source_number.value#>>'{}')::numeric
                <> trunc((source_number.value#>>'{}')::numeric)
            )
          )
      )
      or exists (
        select 1
        from jsonb_array_elements(jsonb_build_array(
          new.fact_payload->'logged_delivery_count',
          new.fact_payload->'uncosted_delivery_count'
        )) source_count(value)
        where jsonb_typeof(source_count.value) <> 'number'
          or (source_count.value#>>'{}')::numeric < 0
          or (source_count.value#>>'{}')::numeric > 9007199254740991
          or (source_count.value#>>'{}')::numeric
            <> trunc((source_count.value#>>'{}')::numeric)
      )
    then
      raise exception 'numerator metric source fact payload violates the safe-integer source contract'
        using errcode = '23514';
    end if;
  else
    if not (new.fact_payload ?& array[
      'date','coverage_through','rooms_sold','occupancy_source','sealed_at','seal_version',
      'source_completeness_receipt','source_completeness_oversize',
      'denominator_complete','created_at','updated_at','source_query_id',
      'source_query_version','source_recorded_at','included_in_aggregate',
      'numeric_value'
    ]) or new.fact_payload - array[
      'date','coverage_through','rooms_sold','occupancy_source','sealed_at','seal_version',
      'source_completeness_receipt','source_completeness_oversize',
      'denominator_complete','created_at','updated_at','source_query_id',
      'source_query_version','source_recorded_at','included_in_aggregate',
      'numeric_value'
    ] <> '{}'::jsonb
      or jsonb_typeof(new.fact_payload->'source_completeness_receipt') <> 'object'
      or not ((new.fact_payload->'source_completeness_receipt') ?& array[
        'occupancy_complete','occupancy_bucket','source_completeness_fingerprint'
      ])
      or (new.fact_payload->'source_completeness_receipt') - array[
        'occupancy_complete','occupancy_bucket','source_completeness_fingerprint'
      ] <> '{}'::jsonb then
      raise exception 'denominator metric source fact payload has a non-canonical key set'
        using errcode = '23514';
    end if;
    if jsonb_typeof(new.fact_payload->'source_completeness_oversize') <> 'boolean'
      or jsonb_typeof(new.fact_payload->'denominator_complete') <> 'boolean'
      or jsonb_typeof(new.fact_payload->'included_in_aggregate') <> 'boolean'
      or jsonb_typeof(new.fact_payload->'coverage_through') <> 'string'
      or jsonb_typeof(new.fact_payload->'rooms_sold') not in ('number','null')
      or jsonb_typeof(new.fact_payload->'numeric_value') not in ('number','null')
      or jsonb_typeof(
        new.fact_payload->'source_completeness_receipt'->'occupancy_complete'
      ) not in ('boolean','null')
    then
      raise exception 'denominator metric source fact payload has non-canonical value types'
        using errcode = '23514';
    end if;
    if (
      new.fact_payload->>'occupancy_source' is not null
      and new.fact_payload->>'occupancy_source'
        not in ('pms_report','operator','derived')
    )
      or jsonb_typeof(new.fact_payload->'seal_version') <> 'number'
      or (new.fact_payload->>'seal_version')::numeric <= 0
      or (new.fact_payload->>'seal_version')::numeric > 9007199254740991
      or (new.fact_payload->>'seal_version')::numeric
        <> trunc((new.fact_payload->>'seal_version')::numeric)
    then
      raise exception 'denominator metric source fact payload violates the safe-integer source contract'
        using errcode = '23514';
    end if;
  end if;
  begin
    v_watermark_receipt := case when new.fact_role = 'numerator'
      then v_observation.source_watermark->'receipt'
      else v_observation.denominator_source_watermark->'receipt'
    end;
    v_query_extracted_at := case when new.fact_role = 'numerator'
      then nullif(v_observation.source_query->>'extracted_at', '')::timestamptz
      else nullif(v_observation.denominator_source_query->>'extracted_at', '')::timestamptz
    end;
    v_requested_source_as_of := nullif(
      v_watermark_receipt->>'requested_source_as_of', ''
    )::timestamptz;
    v_source_cutoff := nullif(
      v_watermark_receipt->>'source_as_of', ''
    )::timestamptz;
    v_effective_source_cutoff := nullif(
      v_watermark_receipt->>'effective_source_cutoff', ''
    )::timestamptz;
    v_source_cutoff_is_exclusive :=
      (v_watermark_receipt->>'effective_source_cutoff_is_exclusive')::boolean;
    v_source_cutoff_reason :=
      v_watermark_receipt->>'effective_source_cutoff_reason';
    v_source_cutoff_proof_kind :=
      v_watermark_receipt->>'effective_source_cutoff_proof_kind';
    v_source_cutoff_proof_at := nullif(
      v_watermark_receipt->>'effective_source_cutoff_proof_at', ''
    )::timestamptz;
    v_fact_date := case when new.fact_kind = 'supply_period'
      then (new.fact_payload->>'month_start')::date
      else (new.fact_payload->>'date')::date end;
    v_payload_recorded_at := (new.fact_payload->>'source_recorded_at')::timestamptz;
    v_payload_created_at := (new.fact_payload->>'created_at')::timestamptz;
    v_payload_updated_at := (new.fact_payload->>'updated_at')::timestamptz;
    v_payload_terminal_at := case when new.fact_role = 'numerator'
      then nullif(new.fact_payload->>'closed_at', '')::timestamptz
      else nullif(new.fact_payload->>'sealed_at', '')::timestamptz
    end;
    v_payload_window_start := case when new.fact_role = 'numerator'
      then nullif(new.fact_payload->>'month_start_at', '')::timestamptz
      else null::timestamptz
    end;
    v_payload_window_end := case when new.fact_role = 'numerator'
      then nullif(new.fact_payload->>'end_at', '')::timestamptz
      else null::timestamptz
    end;
    v_payload_coverage_through := case when new.fact_role = 'denominator'
      then nullif(new.fact_payload->>'coverage_through', '')::timestamptz
      else null::timestamptz
    end;
    v_expected_coverage_through := case when new.fact_role = 'denominator'
      then (
        ((v_fact_date + 1)::timestamp
          + v_observation.denominator_business_date_cutoff_hour * interval '1 hour')
          at time zone v_observation.denominator_window_timezone
      ) - interval '1 millisecond'
      else null::timestamptz
    end;
    if new.fact_role = 'numerator' then
      perform (new.fact_payload->>'id')::uuid;
    end if;
    v_payload_included := (new.fact_payload->>'included_in_aggregate')::boolean;
    v_payload_numeric := nullif(new.fact_payload->>'numeric_value', '')::numeric;
    v_payload_source_numeric := case when new.fact_role = 'numerator'
      then nullif(
        new.fact_payload->>'confirmed_purchase_storage_cents', ''
      )::numeric
      else nullif(new.fact_payload->>'rooms_sold', '')::numeric
    end;
    if new.fact_role = 'numerator' then
      v_payload_declared_source_window_compatible :=
        (new.fact_payload->>'source_window_compatible')::boolean;
      v_payload_derived_source_window_compatible := coalesce(
        new.fact_payload->>'timezone' = v_observation.window_timezone
        and v_payload_window_start =
          v_fact_date::timestamp at time zone v_observation.window_timezone
        and v_payload_window_end =
          (v_fact_date + interval '1 month')::timestamp
            at time zone v_observation.window_timezone,
        false
      );
      v_payload_expected_included := coalesce(
        new.fact_payload->>'status' = 'closed'
        and not (new.fact_payload->>'is_partial')::boolean
        and v_payload_declared_source_window_compatible
        and not (new.fact_payload->>'quality_flags_oversize')::boolean
        and v_payload_source_numeric is not null
        and v_payload_terminal_at is not null,
        false
      );
    else
      v_payload_declared_denominator_complete :=
        (new.fact_payload->>'denominator_complete')::boolean;
      v_payload_derived_denominator_complete := coalesce(
        v_payload_source_numeric is not null
        and v_payload_source_numeric >= 0
        and new.fact_payload->>'occupancy_source' in ('pms_report','operator')
        and not (new.fact_payload->>'source_completeness_oversize')::boolean
        and (
          coalesce((new.fact_payload->'source_completeness_receipt'
            ->>'occupancy_complete')::boolean, false)
          or new.fact_payload->'source_completeness_receipt'->>'occupancy_bucket'
            in ('pms_report','operator','complete')
        ),
        false
      );
      v_payload_expected_included := v_payload_derived_denominator_complete;
    end if;
  exception when invalid_text_representation or datetime_field_overflow
    or numeric_value_out_of_range then
    raise exception 'metric source fact has an invalid typed payload receipt'
      using errcode = '23514';
  end;
  if v_fact_date is null
    or (new.fact_kind = 'supply_period'
      and v_fact_date <> date_trunc('month', v_fact_date)::date)
    or new.fact_key <> v_fact_date::text
    or new.fact_payload->>'source_query_id' is distinct from new.source_query_id
    or new.fact_payload->>'source_query_version' is distinct from new.source_query_version
    or v_payload_recorded_at is distinct from new.source_recorded_at
    or v_payload_included is distinct from new.included_in_aggregate
    or v_payload_numeric is distinct from new.numeric_value
    or v_payload_source_numeric is distinct from new.numeric_value
    or v_payload_expected_included is distinct from new.included_in_aggregate
    or (
      new.fact_role = 'numerator'
      and v_payload_declared_source_window_compatible
        is distinct from v_payload_derived_source_window_compatible
    )
    or v_payload_recorded_at is distinct from v_payload_updated_at
    or (
      new.fact_role = 'denominator'
      and v_payload_declared_denominator_complete
        is distinct from v_payload_derived_denominator_complete
    )
    or v_query_extracted_at is null
    or v_requested_source_as_of is null
    or v_source_cutoff is null
    or v_effective_source_cutoff is distinct from v_source_cutoff
    or v_source_cutoff is distinct from v_query_extracted_at
    or v_source_cutoff > v_requested_source_as_of
    or v_source_cutoff_is_exclusive is null
    or coalesce(v_source_cutoff_reason, '') not in (
      'requested_source_as_of','relationship_interval_end','audited_membership_loss'
    )
    or coalesce(v_source_cutoff_proof_kind, '') not in (
      'request','relationship_state','organization_access_event'
    )
    or v_source_cutoff_proof_at is null
    or (
      v_source_cutoff_reason = 'requested_source_as_of'
      and (
        v_source_cutoff_is_exclusive
        or v_source_cutoff_proof_kind <> 'request'
        or v_source_cutoff <> v_requested_source_as_of
        or v_source_cutoff_proof_at <> v_source_cutoff
      )
    )
    or (
      v_source_cutoff_reason <> 'requested_source_as_of'
      and not v_source_cutoff_is_exclusive
    )
    or (
      v_source_cutoff_reason = 'relationship_interval_end'
      and v_source_cutoff_proof_kind <> 'relationship_state'
    )
    or (
      v_source_cutoff_reason = 'audited_membership_loss'
      and v_source_cutoff_proof_kind not in (
        'organization_access_event','relationship_state'
      )
    )
    or (
      new.fact_role = 'numerator'
      and (
        v_fact_date < v_observation.window_start_local::date
        or v_fact_date >= v_observation.window_end_local::date
      )
    )
    or (
      new.fact_role = 'denominator'
      and (
        v_observation.denominator_window_start_local is null
        or v_observation.denominator_window_end_local is null
        or v_fact_date < v_observation.denominator_window_start_local::date
        or v_fact_date >= v_observation.denominator_window_end_local::date
        or v_payload_coverage_through is distinct from v_expected_coverage_through
      )
    )
  then
    raise exception 'metric source fact payload does not exactly mirror its canonical scalar receipt'
      using errcode = '23514';
  end if;
  if v_payload_created_at is null
    or v_payload_updated_at is null
    or v_payload_created_at > v_payload_updated_at
    or (new.fact_role = 'denominator' and v_payload_terminal_at is null)
    or (new.fact_role = 'denominator' and v_payload_coverage_through is null)
    or (
      new.fact_role = 'numerator'
      and (
        v_payload_window_start is null
        or v_payload_window_end is null
        or v_payload_window_end <= v_payload_window_start
        or (v_payload_terminal_at is not null
          and v_payload_terminal_at > v_payload_updated_at)
      )
    )
    or (
      new.fact_role = 'denominator'
      and v_payload_terminal_at > v_payload_updated_at
    )
    or v_payload_created_at > v_source_cutoff
    or v_payload_updated_at > v_source_cutoff
    or (v_payload_terminal_at is not null and v_payload_terminal_at > v_source_cutoff)
    or (v_payload_coverage_through is not null
      and v_payload_coverage_through > v_source_cutoff)
    or (
      v_source_cutoff_is_exclusive
      and (
        v_payload_created_at >= v_source_cutoff
        or v_payload_updated_at >= v_source_cutoff
        or (v_payload_terminal_at is not null
          and v_payload_terminal_at >= v_source_cutoff)
      )
    )
  then
    raise exception 'metric source fact was recorded after its source extraction cutoff'
      using errcode = '23514';
  end if;

  v_hash_receipt := jsonb_build_object(
    'observation_id', new.observation_id,
    'fact_role', new.fact_role,
    'fact_kind', new.fact_kind,
    'fact_key', new.fact_key,
    'source_query_id', new.source_query_id,
    'source_query_version', new.source_query_version,
    'source_recorded_at', new.source_recorded_at,
    'included_in_aggregate', new.included_in_aggregate,
    'numeric_value', new.numeric_value,
    'fact_payload', new.fact_payload
  );
  new.fact_hash := encode(pg_catalog.sha256(
    convert_to(v_hash_receipt::text, 'UTF8')
  ), 'hex');
  return new;
end
$$;

drop trigger if exists management_pattern_profiles_append_only on public.management_pattern_property_profiles;
create trigger management_pattern_profiles_append_only
  before update or delete on public.management_pattern_property_profiles
  for each row execute function public.staxis_reject_management_pattern_evidence_update();

drop trigger if exists management_pattern_profiles_validate_insert
  on public.management_pattern_property_profiles;
create trigger management_pattern_profiles_validate_insert
  before insert on public.management_pattern_property_profiles
  for each row execute function public.staxis_validate_management_pattern_profile_insert();

drop trigger if exists management_pattern_runs_update_guard on public.management_pattern_runs;
create trigger management_pattern_runs_update_guard
  before update on public.management_pattern_runs
  for each row execute function public.staxis_guard_management_pattern_run_update();

drop trigger if exists management_pattern_runs_reject_delete on public.management_pattern_runs;
create trigger management_pattern_runs_reject_delete
  before delete on public.management_pattern_runs
  for each row execute function public.staxis_reject_management_pattern_evidence_update();

drop trigger if exists management_pattern_parent_delete_guard on public.organizations;
create trigger management_pattern_parent_delete_guard
  before delete on public.organizations
  for each row execute function public.staxis_guard_management_pattern_parent_delete();
drop trigger if exists management_pattern_parent_delete_guard on public.properties;
create trigger management_pattern_parent_delete_guard
  before delete on public.properties
  for each row execute function public.staxis_guard_management_pattern_parent_delete();

-- All run-scoped evidence tables are both fenced on INSERT and immutable on
-- UPDATE/DELETE. A future retention workflow must be a separately governed
-- API; raw service-role deletion is deliberately not a retention mechanism.
do $$
declare
  v_table text;
begin
  foreach v_table in array array[
    'management_pattern_run_properties',
    'management_pattern_cohorts',
    'management_pattern_cohort_members',
    'management_pattern_metric_observations',
    'management_pattern_metric_source_facts',
    'management_pattern_check_outcomes',
    'management_pattern_check_observations',
    'management_pattern_candidates',
    'management_pattern_candidate_outcomes',
    'management_pattern_candidate_properties',
    'management_pattern_candidate_local_instances',
    'management_pattern_run_roots',
    'management_pattern_reconciliations',
    'management_pattern_reconciliation_outcomes',
    'management_pattern_result_batches'
  ] loop
    execute format('drop trigger if exists management_pattern_fence_insert on public.%I', v_table);
    execute format(
      'create trigger management_pattern_fence_insert before insert on public.%I '
      'for each row execute function public.staxis_require_management_pattern_run_fence()',
      v_table
    );
    execute format('drop trigger if exists management_pattern_append_only on public.%I', v_table);
    execute format(
      'create trigger management_pattern_append_only before update or delete on public.%I '
      'for each row execute function public.staxis_reject_management_pattern_evidence_update()',
      v_table
    );
  end loop;
end
$$;

drop trigger if exists management_pattern_candidate_validate on public.management_pattern_candidates;
create trigger management_pattern_candidate_validate
  before insert on public.management_pattern_candidates
  for each row execute function public.staxis_validate_management_pattern_candidate();

drop trigger if exists management_pattern_run_property_snapshot_validate
  on public.management_pattern_run_properties;
create trigger management_pattern_run_property_snapshot_validate
  before insert on public.management_pattern_run_properties
  for each row execute function public.staxis_validate_management_pattern_run_property_snapshot();

drop trigger if exists management_pattern_candidate_outcome_validate
  on public.management_pattern_candidate_outcomes;
create trigger management_pattern_candidate_outcome_validate
  before insert on public.management_pattern_candidate_outcomes
  for each row execute function public.staxis_validate_management_pattern_candidate_outcome();

drop trigger if exists management_pattern_reconciliation_validate
  on public.management_pattern_reconciliations;
create trigger management_pattern_reconciliation_validate
  before insert on public.management_pattern_reconciliations
  for each row execute function public.staxis_validate_management_pattern_reconciliation();

drop trigger if exists management_pattern_run_root_validate
  on public.management_pattern_run_roots;
create trigger management_pattern_run_root_validate
  before insert on public.management_pattern_run_roots
  for each row execute function public.staxis_validate_management_pattern_run_root();

drop trigger if exists management_pattern_reconciliation_outcome_validate
  on public.management_pattern_reconciliation_outcomes;
create trigger management_pattern_reconciliation_outcome_validate
  before insert on public.management_pattern_reconciliation_outcomes
  for each row execute function public.staxis_validate_management_pattern_reconciliation_outcome();

drop trigger if exists management_pattern_source_fact_validate
  on public.management_pattern_metric_source_facts;
create trigger management_pattern_source_fact_validate
  before insert on public.management_pattern_metric_source_facts
  for each row execute function public.staxis_validate_management_pattern_source_fact();

drop trigger if exists management_pattern_local_finding_validate on public.management_pattern_candidate_local_instances;
create trigger management_pattern_local_finding_validate
  before insert on public.management_pattern_candidate_local_instances
  for each row execute function public.staxis_validate_management_pattern_local_finding();

-- ---------------------------------------------------------------------------
-- Leased/fenced run state machine.
-- ---------------------------------------------------------------------------

create or replace function public.claim_management_pattern_run(
  p_organization_id uuid,
  p_run_key text,
  p_owner_token uuid,
  p_engine_version text,
  p_evidence_schema_version integer,
  p_cohort_policy_version text,
  p_normalization_policy_version text,
  p_dedupe_policy_version text,
  p_scope_policy_version text,
  p_input_hash text,
  p_portfolio_snapshot jsonb,
  p_portfolio_snapshot_hash text,
  p_evaluation_at timestamptz,
  p_source_as_of timestamptz,
  p_topology_as_of timestamptz,
  p_window_start timestamptz,
  p_window_end timestamptz,
  p_projection_mode text default 'shadow',
  p_triggered_by text default 'scheduled',
  p_input_manifest jsonb default '{}'::jsonb,
  p_lease_seconds integer default 300,
  p_supersedes_run_id uuid default null,
  p_model_versions jsonb default '{}'::jsonb,
  p_model_call_budget integer default 0,
  p_token_budget bigint default 0,
  p_cost_budget_microusd bigint default 0,
  p_duration_budget_ms integer default 120000,
  p_db_query_budget integer default 20
)
returns table (
  outcome text,
  run_id uuid,
  fencing_token bigint,
  lease_expires_at timestamptz
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_run public.management_pattern_runs%rowtype;
  v_snapshot_property_count integer;
  v_source_budget_exceeded boolean;
  v_snapshot_properties jsonb;
  v_organization_type text;
  v_parent_run public.management_pattern_runs%rowtype;
begin
  if p_organization_id is null or p_owner_token is null then
    raise exception 'organization and owner token are required' using errcode = '22023';
  end if;
  if p_engine_version is null
    or p_evidence_schema_version is null
    or p_cohort_policy_version is null
    or p_normalization_policy_version is null
    or p_dedupe_policy_version is null
    or p_scope_policy_version is null
    or p_input_hash is null
    or p_portfolio_snapshot is null
    or p_portfolio_snapshot_hash is null
    or p_window_start is null
    or p_window_end is null
    or p_triggered_by is null
    or p_input_manifest is null
    or p_model_versions is null
    or p_model_call_budget is null
    or p_token_budget is null
    or p_cost_budget_microusd is null
    or p_duration_budget_ms is null
    or p_db_query_budget is null then
    raise exception 'management pattern claim immutable inputs are required'
      using errcode = '22023';
  end if;
  if p_projection_mode is distinct from 'shadow' then
    raise exception 'active management-pattern projection is disabled until an explicit organization cutover policy exists'
      using errcode = '0A000';
  end if;
  if p_evaluation_at is null or p_source_as_of is null or p_topology_as_of is null
    or p_topology_as_of > p_source_as_of or p_source_as_of > p_evaluation_at then
    raise exception 'require topology_as_of <= source_as_of <= evaluation_at'
      using errcode = '22023';
  end if;
  if p_evaluation_at > v_now + interval '5 minutes' then
    raise exception 'management pattern evaluation_at is in the future'
      using errcode = '22023';
  end if;
  if p_run_key is null or char_length(p_run_key) not between 1 and 200 then
    raise exception 'invalid management pattern run key' using errcode = '22023';
  end if;
  if p_lease_seconds is null or p_lease_seconds not between 30 and 3600 then
    raise exception 'lease seconds must be between 30 and 3600' using errcode = '22023';
  end if;

  if jsonb_typeof(p_portfolio_snapshot) is distinct from 'object'
    or p_portfolio_snapshot->>'schema_version' is distinct from '2'
    or p_portfolio_snapshot->>'organization_id' is distinct from p_organization_id::text
    or jsonb_typeof(p_portfolio_snapshot->'properties') is distinct from 'array'
    or jsonb_typeof(p_portfolio_snapshot->'source_budget_exceeded') is distinct from 'boolean'
    or coalesce(p_portfolio_snapshot->>'property_count', '') !~ '^(0|[1-9][0-9]*)$'
  then
    raise exception 'portfolio snapshot is not the strict management-pattern v2 manifest'
      using errcode = '22023';
  end if;
  begin
    v_snapshot_property_count := (p_portfolio_snapshot->>'property_count')::integer;
    v_source_budget_exceeded := (p_portfolio_snapshot->>'source_budget_exceeded')::boolean;
    v_snapshot_properties := p_portfolio_snapshot->'properties';
    if (p_portfolio_snapshot->>'evaluation_at')::timestamptz is distinct from p_evaluation_at
      or (p_portfolio_snapshot->>'source_as_of')::timestamptz is distinct from p_source_as_of
      or (p_portfolio_snapshot->>'topology_as_of')::timestamptz is distinct from p_topology_as_of
      or (p_portfolio_snapshot->>'analysis_window_anchor')::timestamptz
        is distinct from p_topology_as_of
      or (p_input_manifest->>'analysis_window_anchor')::timestamptz
        is distinct from p_topology_as_of then
      raise exception 'portfolio snapshot as-of receipt differs from claim arguments'
        using errcode = '22023';
    end if;
  exception when invalid_text_representation or datetime_field_overflow
      or numeric_value_out_of_range then
    raise exception 'portfolio snapshot contains an invalid typed receipt'
      using errcode = '22023';
  end;
  if v_source_budget_exceeded is distinct from (v_snapshot_property_count > 50)
    or (
      not v_source_budget_exceeded
      and jsonb_array_length(v_snapshot_properties) <> v_snapshot_property_count
    )
    or (v_source_budget_exceeded and jsonb_array_length(v_snapshot_properties) <> 0)
    or exists (
      select 1
      from jsonb_array_elements(v_snapshot_properties) property
      where jsonb_typeof(property) is distinct from 'object'
        or coalesce(property->>'property_id', '')
          !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        or coalesce(property->>'relationship_id', '')
          !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        or coalesce(property->>'property_snapshot_hash', '') !~ '^[0-9a-f]{64}$'
        or coalesce(property->>'eligibility_status', '') not in ('included','excluded')
        or jsonb_typeof(property->'exclusion_codes') is distinct from 'array'
        or exists (
          select 1 from jsonb_array_elements(property->'exclusion_codes') reason
          where jsonb_typeof(reason) is distinct from 'string'
        )
        or (
          property->>'eligibility_status' = 'included'
          and jsonb_array_length(property->'exclusion_codes') <> 0
        )
        or (
          property->>'eligibility_status' = 'excluded'
          and jsonb_array_length(property->'exclusion_codes') = 0
        )
    )
    or (
      select count(*) <> count(distinct property->>'property_id')
      from jsonb_array_elements(v_snapshot_properties) property
    )
  then
    raise exception 'portfolio snapshot property manifest is inconsistent or non-canonical'
      using errcode = '23514';
  end if;

  -- Confirms tenancy before creating a lock row and gives an absent organization
  -- the same result as an out-of-scope one.
  select o.organization_type into v_organization_type
  from public.organizations o where o.id = p_organization_id;
  if not found then
    raise exception 'organization is outside scope or absent' using errcode = '42501';
  end if;
  if p_portfolio_snapshot->>'organization_type' is distinct from v_organization_type then
    raise exception 'portfolio snapshot organization type differs from claimed tenant'
      using errcode = '23514';
  end if;

  if p_triggered_by = 'backfill' then
    if p_supersedes_run_id is null
      or p_run_key not like 'backfill:%'
      or p_evaluation_at - p_topology_as_of > interval '366 days' then
      raise exception 'backfill requires one bounded historical parent receipt'
        using errcode = '22023';
    end if;
    select parent.* into v_parent_run
    from public.management_pattern_runs parent
    where parent.organization_id = p_organization_id
      and parent.id = p_supersedes_run_id;
    if not found
      or v_parent_run.status not in ('succeeded','abstained','failed')
      or v_parent_run.topology_as_of is distinct from p_topology_as_of
      or v_parent_run.window_start is distinct from p_window_start
      or v_parent_run.window_end is distinct from p_window_end
      or v_parent_run.evaluation_at > p_evaluation_at
      or v_parent_run.source_as_of > p_source_as_of
      or (
        v_parent_run.status in ('succeeded','abstained')
        and not exists (
          select 1 from public.management_pattern_result_batches parent_batch
          where parent_batch.organization_id = v_parent_run.organization_id
            and parent_batch.run_id = v_parent_run.id
            and parent_batch.run_fencing_token = v_parent_run.fencing_token
        )
      ) then
      raise exception 'backfill parent is outside the exact historical run lineage'
        using errcode = '22023';
    end if;
  end if;

  insert into public.management_pattern_run_locks (organization_id, run_key)
  values (p_organization_id, p_run_key)
  on conflict (organization_id, run_key) do nothing;
  perform 1
  from public.management_pattern_run_locks l
  where l.organization_id = p_organization_id and l.run_key = p_run_key
  for update;

  select r.* into v_run
  from public.management_pattern_runs r
  where r.organization_id = p_organization_id and r.run_key = p_run_key
  for update;

  if not found then
    insert into public.management_pattern_runs (
      organization_id, run_key, triggered_by, projection_mode,
      supersedes_run_id, engine_version,
      evidence_schema_version, cohort_policy_version, normalization_policy_version,
      dedupe_policy_version, scope_policy_version, input_hash, input_manifest,
      model_versions, model_call_budget, token_budget, cost_budget_microusd,
      duration_budget_ms, db_query_budget,
      portfolio_snapshot, portfolio_snapshot_hash, evaluation_at,
      source_as_of, topology_as_of, window_start, window_end,
      status, owner_token, fencing_token, attempt_count,
      lease_expires_at, heartbeat_at, started_at
    ) values (
      p_organization_id, p_run_key, p_triggered_by, p_projection_mode,
      p_supersedes_run_id, p_engine_version,
      p_evidence_schema_version, p_cohort_policy_version, p_normalization_policy_version,
      p_dedupe_policy_version, p_scope_policy_version, p_input_hash, p_input_manifest,
      p_model_versions, p_model_call_budget, p_token_budget, p_cost_budget_microusd,
      p_duration_budget_ms, p_db_query_budget,
      p_portfolio_snapshot, p_portfolio_snapshot_hash, p_evaluation_at,
      p_source_as_of, p_topology_as_of, p_window_start, p_window_end,
      'running', p_owner_token, 1, 1,
      v_now + p_lease_seconds * interval '1 second', v_now, v_now
    )
    returning * into v_run;
    return query select 'claimed'::text, v_run.id, v_run.fencing_token, v_run.lease_expires_at;
    return;
  end if;

  if v_run.input_hash is distinct from p_input_hash
    or v_run.triggered_by is distinct from p_triggered_by
    or v_run.projection_mode is distinct from p_projection_mode
    or v_run.engine_version is distinct from p_engine_version
    or v_run.evidence_schema_version is distinct from p_evidence_schema_version
    or v_run.cohort_policy_version is distinct from p_cohort_policy_version
    or v_run.normalization_policy_version is distinct from p_normalization_policy_version
    or v_run.dedupe_policy_version is distinct from p_dedupe_policy_version
    or v_run.scope_policy_version is distinct from p_scope_policy_version
    or v_run.model_versions is distinct from p_model_versions
    or v_run.model_call_budget is distinct from p_model_call_budget
    or v_run.token_budget is distinct from p_token_budget
    or v_run.cost_budget_microusd is distinct from p_cost_budget_microusd
    or v_run.duration_budget_ms is distinct from p_duration_budget_ms
    or v_run.db_query_budget is distinct from p_db_query_budget
    or v_run.portfolio_snapshot_hash is distinct from p_portfolio_snapshot_hash
    or v_run.portfolio_snapshot is distinct from p_portfolio_snapshot
    or v_run.input_manifest is distinct from p_input_manifest
    or v_run.evaluation_at is distinct from p_evaluation_at
    or v_run.source_as_of is distinct from p_source_as_of
    or v_run.topology_as_of is distinct from p_topology_as_of
    or v_run.window_start is distinct from p_window_start
    or v_run.window_end is distinct from p_window_end
    or v_run.supersedes_run_id is distinct from p_supersedes_run_id then
    return query select 'input_conflict'::text, v_run.id, v_run.fencing_token, v_run.lease_expires_at;
    return;
  end if;

  if v_run.status in ('succeeded','abstained','failed') then
    return query select
      case when v_run.status in ('succeeded','abstained') then 'already_complete' else 'terminal_failed' end,
      v_run.id, v_run.fencing_token, v_run.lease_expires_at;
    return;
  end if;

  if v_run.lease_expires_at > v_now then
    if v_run.owner_token is distinct from p_owner_token then
      return query select 'busy'::text, v_run.id, v_run.fencing_token, v_run.lease_expires_at;
      return;
    end if;
    update public.management_pattern_runs r
    set status = 'running', heartbeat_at = v_now,
        lease_expires_at = v_now + p_lease_seconds * interval '1 second'
    where r.organization_id = p_organization_id and r.id = v_run.id
    returning * into v_run;
    return query select 'resumed'::text, v_run.id, v_run.fencing_token, v_run.lease_expires_at;
    return;
  end if;

  -- Never mix immutable partial evidence from an expired generation with a new
  -- writer.  Seal that attempt as failed; the caller must claim a new run_key
  -- with p_supersedes_run_id pointing here.  An empty expired shell can be
  -- reclaimed safely because it has no output to contaminate.
  if exists (
    select 1 from public.management_pattern_run_properties p
      where p.organization_id = p_organization_id and p.run_id = v_run.id
    union all
    select 1 from public.management_pattern_cohorts c
      where c.organization_id = p_organization_id and c.run_id = v_run.id
    union all
    select 1 from public.management_pattern_metric_observations o
      where o.organization_id = p_organization_id and o.run_id = v_run.id
    union all
    select 1 from public.management_pattern_metric_source_facts f
      where f.organization_id = p_organization_id and f.run_id = v_run.id
    union all
    select 1 from public.management_pattern_check_outcomes o
      where o.organization_id = p_organization_id and o.run_id = v_run.id
    union all
    select 1 from public.management_pattern_candidates c
      where c.organization_id = p_organization_id and c.run_id = v_run.id
    union all
    select 1 from public.management_pattern_run_roots root
      where root.organization_id = p_organization_id and root.run_id = v_run.id
    union all
    select 1 from public.management_pattern_result_batches batch
      where batch.organization_id = p_organization_id and batch.run_id = v_run.id
  ) then
    update public.management_pattern_runs r
    set status = 'failed', owner_token = p_owner_token,
        fencing_token = r.fencing_token + 1,
        attempt_count = r.attempt_count + 1,
        heartbeat_at = v_now,
        lease_expires_at = v_now + p_lease_seconds * interval '1 second',
        completed_at = v_now,
        property_count = (
          select count(*)::integer from public.management_pattern_run_properties p
          where p.organization_id = p_organization_id and p.run_id = r.id
        ),
        included_property_count = (
          select count(*)::integer from public.management_pattern_run_properties p
          where p.organization_id = p_organization_id and p.run_id = r.id
            and p.eligibility_status = 'included'
        ),
        excluded_property_count = (
          select count(*)::integer from public.management_pattern_run_properties p
          where p.organization_id = p_organization_id and p.run_id = r.id
            and p.eligibility_status = 'excluded'
        ),
        cohort_count = (
          select count(*)::integer from public.management_pattern_cohorts c
          where c.organization_id = p_organization_id and c.run_id = r.id
        ),
        cohort_member_count = (
          select count(*)::integer from public.management_pattern_cohort_members m
          where m.organization_id = p_organization_id and m.run_id = r.id
        ),
        observation_count = (
          select count(*)::integer from public.management_pattern_metric_observations o
          where o.organization_id = p_organization_id and o.run_id = r.id
        ),
        source_fact_count = (
          select count(*)::integer from public.management_pattern_metric_source_facts f
          where f.organization_id = p_organization_id and f.run_id = r.id
        ),
        observation_link_count = (
          select count(*)::integer from public.management_pattern_check_observations l
          where l.organization_id = p_organization_id and l.run_id = r.id
        ),
        check_count = (
          select count(distinct o.check_id)::integer
          from public.management_pattern_check_outcomes o
          where o.organization_id = p_organization_id and o.run_id = r.id
        ),
        outcome_count = (
          select count(*)::integer from public.management_pattern_check_outcomes o
          where o.organization_id = p_organization_id and o.run_id = r.id
        ),
        candidate_count = (
          select count(*)::integer from public.management_pattern_candidates c
          where c.organization_id = p_organization_id and c.run_id = r.id
        ),
        abstention_count = (
          select count(*)::integer from public.management_pattern_check_outcomes o
          where o.organization_id = p_organization_id and o.run_id = r.id
            and o.result = 'abstained'
        ),
        quality_failure_count = r.quality_failure_count + 1,
        error_detail = jsonb_build_object(
          'code', 'expired_generation_with_partial_evidence',
          'required_action', 'claim_new_run_key_with_supersedes_run_id',
          'sealed_fencing_token', r.fencing_token
        )
    where r.organization_id = p_organization_id and r.id = v_run.id
    returning * into v_run;
    return query select 'partial_evidence_sealed'::text,
      v_run.id, v_run.fencing_token, v_run.lease_expires_at;
    return;
  end if;

  -- The prior lease is dead.  Even reusing the same owner token creates a new
  -- generation so writes from the prior attempt are fenced out.
  update public.management_pattern_runs r
  set status = 'running', owner_token = p_owner_token,
      fencing_token = r.fencing_token + 1,
      attempt_count = r.attempt_count + 1,
      heartbeat_at = v_now,
      lease_expires_at = v_now + p_lease_seconds * interval '1 second'
  where r.organization_id = p_organization_id and r.id = v_run.id
  returning * into v_run;
  return query select 'reclaimed'::text, v_run.id, v_run.fencing_token, v_run.lease_expires_at;
end
$$;

create or replace function public.heartbeat_management_pattern_run(
  p_organization_id uuid,
  p_run_id uuid,
  p_owner_token uuid,
  p_fencing_token bigint,
  p_lease_seconds integer default 300
)
returns table (outcome text, lease_expires_at timestamptz)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_run public.management_pattern_runs%rowtype;
begin
  if p_organization_id is null or p_run_id is null
    or p_owner_token is null or p_fencing_token is null then
    raise exception 'organization, run, owner token, and fencing token are required'
      using errcode = '22023';
  end if;
  if p_lease_seconds is null or p_lease_seconds not between 30 and 3600 then
    raise exception 'lease seconds must be between 30 and 3600' using errcode = '22023';
  end if;
  select r.* into v_run
  from public.management_pattern_runs r
  where r.organization_id = p_organization_id and r.id = p_run_id
  for update;
  if not found then
    return query select 'not_found'::text, null::timestamptz;
    return;
  end if;
  if v_run.status in ('succeeded','abstained','failed') then
    return query select 'terminal'::text, v_run.lease_expires_at;
    return;
  end if;
  if v_run.owner_token is distinct from p_owner_token
    or v_run.fencing_token is distinct from p_fencing_token then
    return query select 'stale_fence'::text, v_run.lease_expires_at;
    return;
  end if;
  if v_run.lease_expires_at <= v_now then
    return query select 'lease_expired'::text, v_run.lease_expires_at;
    return;
  end if;
  update public.management_pattern_runs r
  set status = 'running', heartbeat_at = v_now,
      lease_expires_at = v_now + p_lease_seconds * interval '1 second'
  where r.organization_id = p_organization_id and r.id = p_run_id
  returning r.lease_expires_at into v_run.lease_expires_at;
  return query select 'heartbeated'::text, v_run.lease_expires_at;
end
$$;

create or replace function public.finalize_management_pattern_run(
  p_organization_id uuid,
  p_run_id uuid,
  p_owner_token uuid,
  p_fencing_token bigint,
  p_terminal_status text,
  p_property_count integer default 0,
  p_included_property_count integer default 0,
  p_excluded_property_count integer default 0,
  p_cohort_count integer default 0,
  p_cohort_member_count integer default 0,
  p_observation_count integer default 0,
  p_source_fact_count integer default 0,
  p_observation_link_count integer default 0,
  p_check_count integer default 0,
  p_outcome_count integer default 0,
  p_candidate_count integer default 0,
  p_abstention_count integer default 0,
  p_quality_failure_count integer default 0,
  p_model_call_count integer default 0,
  p_prompt_token_count bigint default 0,
  p_completion_token_count bigint default 0,
  p_estimated_cost_microusd bigint default 0,
  p_db_query_count integer default 0,
  p_duration_ms integer default 0,
  p_quality_summary jsonb default '{}'::jsonb,
  p_performance_summary jsonb default '{}'::jsonb,
  p_cost_summary jsonb default '{}'::jsonb,
  p_error_detail jsonb default '{}'::jsonb
)
returns table (outcome text, run_id uuid)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_run public.management_pattern_runs%rowtype;
  v_actual_property_count integer;
  v_actual_included_count integer;
  v_actual_excluded_count integer;
  v_actual_cohort_count integer;
  v_actual_cohort_member_count integer;
  v_actual_observation_count integer;
  v_actual_source_fact_count integer;
  v_actual_observation_link_count integer;
  v_actual_check_count integer;
  v_actual_outcome_count integer;
  v_actual_candidate_count integer;
  v_actual_abstention_count integer;
  v_actual_root_count integer;
  v_actual_reconciliation_count integer;
  v_result_batch public.management_pattern_result_batches%rowtype;
begin
  if p_organization_id is null or p_run_id is null
    or p_owner_token is null or p_fencing_token is null then
    raise exception 'organization, run, owner token, and fencing token are required'
      using errcode = '22023';
  end if;
  if p_terminal_status is null
    or p_terminal_status not in ('succeeded','abstained','failed') then
    raise exception 'invalid terminal management pattern status' using errcode = '22023';
  end if;
  select r.* into v_run
  from public.management_pattern_runs r
  where r.organization_id = p_organization_id and r.id = p_run_id
  for update;
  if not found then
    return query select 'not_found'::text, null::uuid;
    return;
  end if;
  if v_run.status in ('succeeded','abstained','failed') then
    if v_run.owner_token is distinct from p_owner_token
      or v_run.fencing_token is distinct from p_fencing_token then
      return query select 'stale_fence'::text, v_run.id;
      return;
    end if;
    if row(
      v_run.status,
      v_run.property_count, v_run.included_property_count, v_run.excluded_property_count,
      v_run.cohort_count, v_run.cohort_member_count, v_run.observation_count,
      v_run.source_fact_count, v_run.observation_link_count,
      v_run.check_count, v_run.outcome_count, v_run.candidate_count,
      v_run.abstention_count, v_run.quality_failure_count,
      v_run.model_call_count, v_run.prompt_token_count, v_run.completion_token_count,
      v_run.estimated_cost_microusd, v_run.db_query_count, v_run.duration_ms,
      v_run.quality_summary, v_run.performance_summary, v_run.cost_summary,
      v_run.error_detail
    ) is distinct from row(
      p_terminal_status,
      p_property_count, p_included_property_count, p_excluded_property_count,
      p_cohort_count, p_cohort_member_count, p_observation_count,
      p_source_fact_count, p_observation_link_count,
      p_check_count, p_outcome_count, p_candidate_count,
      p_abstention_count, p_quality_failure_count,
      p_model_call_count, p_prompt_token_count, p_completion_token_count,
      p_estimated_cost_microusd, p_db_query_count, p_duration_ms,
      p_quality_summary, p_performance_summary, p_cost_summary,
      p_error_detail
    ) then
      raise exception 'input_conflict: finalize retry differs from the sealed run receipt'
        using errcode = '22000';
    end if;
    return query select 'already_finalized'::text, v_run.id;
    return;
  end if;
  if v_run.owner_token is distinct from p_owner_token
    or v_run.fencing_token is distinct from p_fencing_token then
    return query select 'stale_fence'::text, v_run.id;
    return;
  end if;
  if v_run.lease_expires_at <= v_now then
    return query select 'lease_expired'::text, v_run.id;
    return;
  end if;

  select count(*)::integer,
         count(*) filter (where eligibility_status = 'included')::integer,
         count(*) filter (where eligibility_status = 'excluded')::integer
    into v_actual_property_count, v_actual_included_count, v_actual_excluded_count
  from public.management_pattern_run_properties p
  where p.organization_id = p_organization_id and p.run_id = p_run_id;

  if p_terminal_status in ('succeeded','abstained') and (
    (
      (v_run.portfolio_snapshot->>'source_budget_exceeded')::boolean
      and v_actual_property_count <> 0
    )
    or (
      not (v_run.portfolio_snapshot->>'source_budget_exceeded')::boolean
      and (
        v_actual_property_count
          <> (v_run.portfolio_snapshot->>'property_count')::integer
        or v_actual_property_count
          <> jsonb_array_length(v_run.portfolio_snapshot->'properties')
        or exists (
          select 1
          from jsonb_array_elements(v_run.portfolio_snapshot->'properties') manifest_property
          where not exists (
            select 1
            from public.management_pattern_run_properties run_property
            where run_property.organization_id = p_organization_id
              and run_property.run_id = p_run_id
              and run_property.property_id
                = (manifest_property->>'property_id')::uuid
              and run_property.membership_relationship_id
                = (manifest_property->>'relationship_id')::uuid
              and run_property.property_snapshot_hash
                = manifest_property->>'property_snapshot_hash'
              and run_property.eligibility_status
                = manifest_property->>'eligibility_status'
              and to_jsonb(run_property.exclusion_codes)
                = manifest_property->'exclusion_codes'
          )
        )
      )
    )
  ) then
    raise exception 'run property evidence does not exactly cover its claimed portfolio manifest'
      using errcode = '23514';
  end if;

  select count(distinct o.check_id)::integer,
         count(*)::integer,
         count(*) filter (where o.result = 'abstained')::integer
    into v_actual_check_count, v_actual_outcome_count, v_actual_abstention_count
  from public.management_pattern_check_outcomes o
  where o.organization_id = p_organization_id and o.run_id = p_run_id;

  select count(*)::integer into v_actual_candidate_count
  from public.management_pattern_candidates c
  where c.organization_id = p_organization_id and c.run_id = p_run_id;

  select count(*)::integer into v_actual_cohort_count
  from public.management_pattern_cohorts c
  where c.organization_id = p_organization_id and c.run_id = p_run_id;

  select count(*)::integer into v_actual_cohort_member_count
  from public.management_pattern_cohort_members m
  where m.organization_id = p_organization_id and m.run_id = p_run_id;

  select count(*)::integer into v_actual_observation_count
  from public.management_pattern_metric_observations o
  where o.organization_id = p_organization_id and o.run_id = p_run_id;

  select count(*)::integer into v_actual_source_fact_count
  from public.management_pattern_metric_source_facts fact
  where fact.organization_id = p_organization_id and fact.run_id = p_run_id;

  -- Every inventory-purchase observation, including partial/invalid evidence,
  -- must retain exactly the rows counted by each sealed source query and the
  -- exact subset used in its aggregate.  A zero-row query therefore requires
  -- zero facts and preserves NULL (not zero) aggregate semantics.  Usable
  -- observations additionally require complete, contiguous calendar windows.
  if p_terminal_status in ('succeeded','abstained') and exists (
    select 1
    from public.management_pattern_metric_observations observation
    left join lateral (
      select
        count(*)::integer as total_count,
        count(*) filter (where fact.included_in_aggregate)::integer as included_count,
        count(distinct (fact.fact_payload->>'month_start')::date)::integer
          as distinct_date_count,
        min((fact.fact_payload->>'month_start')::date) as minimum_date,
        max((fact.fact_payload->>'month_start')::date) as maximum_date,
        sum(fact.numeric_value) filter (where fact.included_in_aggregate) as aggregate_sum,
        max(
          (fact.fact_payload->>'end_at')::timestamptz - interval '1 millisecond'
        ) filter (where fact.included_in_aggregate) as domain_fresh_through,
        max(nullif(fact.fact_payload->>'closed_at', '')::timestamptz)
          as max_closed_at
      from public.management_pattern_metric_source_facts fact
      where fact.organization_id = observation.organization_id
        and fact.run_id = observation.run_id
        and fact.observation_id = observation.id
        and fact.fact_role = 'numerator'
        and fact.fact_kind = 'supply_period'
    ) numerator on true
    left join lateral (
      select
        count(*)::integer as total_count,
        count(*) filter (where fact.included_in_aggregate)::integer as included_count,
        count(distinct (fact.fact_payload->>'date')::date)::integer
          as distinct_date_count,
        min((fact.fact_payload->>'date')::date) as minimum_date,
        max((fact.fact_payload->>'date')::date) as maximum_date,
        sum(fact.numeric_value) filter (where fact.included_in_aggregate) as aggregate_sum,
        max((fact.fact_payload->>'coverage_through')::timestamptz)
          filter (where fact.included_in_aggregate) as domain_fresh_through,
        max(nullif(fact.fact_payload->>'sealed_at', '')::timestamptz)
          as max_sealed_at,
        max((fact.fact_payload->>'updated_at')::timestamptz) as max_updated_at
      from public.management_pattern_metric_source_facts fact
      where fact.organization_id = observation.organization_id
        and fact.run_id = observation.run_id
        and fact.observation_id = observation.id
        and fact.fact_role = 'denominator'
        and fact.fact_kind = 'rooms_sold_day'
    ) denominator on true
    where observation.organization_id = p_organization_id
      and observation.run_id = p_run_id
      and observation.metric_key = 'inventory_purchase_spend'
      and (
        numerator.total_count is distinct from
          nullif(observation.source_query->>'record_count', '')::integer
        or numerator.included_count is distinct from
          nullif(
            observation.metadata#>>'{source_coverage_receipt,usable_periods}', ''
          )::integer
        or numerator.distinct_date_count is distinct from numerator.total_count
        or numerator.aggregate_sum is distinct from observation.raw_value
        or denominator.total_count is distinct from
          nullif(observation.denominator_source_query->>'record_count', '')::integer
        or denominator.included_count is distinct from
          nullif(
            observation.metadata#>>'{source_coverage_receipt,denominator_observed_days}', ''
          )::integer
        or denominator.distinct_date_count is distinct from denominator.total_count
        or denominator.aggregate_sum is distinct from observation.denominator_value
        -- Freshness is a coverage-domain boundary, while the lifecycle maxima
        -- prove when those exact facts were closed/sealed and last updated.
        -- Bind both independently so a caller cannot make old coverage appear
        -- current by copying a recent lifecycle timestamp into fresh_through.
        or (
          numerator.included_count > 0
          and nullif(observation.source_watermark->>'fresh_through', '')::timestamptz
            is distinct from numerator.domain_fresh_through
        )
        or (
          numerator.included_count = 0
          and (
            observation.quality_status = 'usable'
            or numerator.domain_fresh_through is not null
            or nullif(
              observation.source_watermark->>'fresh_through', ''
            )::timestamptz is distinct from nullif(
              observation.source_watermark#>>'{receipt,effective_source_cutoff}', ''
            )::timestamptz
          )
        )
        or nullif(
          observation.source_watermark#>>'{receipt,max_closed_at}', ''
        )::timestamptz is distinct from numerator.max_closed_at
        or observation.freshness_age_seconds is distinct from extract(
          epoch from (
            observation.as_of
              - nullif(
                observation.source_watermark->>'fresh_through', ''
              )::timestamptz
          )
        )
        or (
          denominator.included_count > 0
          and nullif(
            observation.denominator_source_watermark->>'fresh_through', ''
          )::timestamptz is distinct from denominator.domain_fresh_through
        )
        or (
          denominator.included_count = 0
          and (
            observation.quality_status = 'usable'
            or denominator.domain_fresh_through is not null
            or nullif(
              observation.denominator_source_watermark->>'fresh_through', ''
            )::timestamptz is distinct from nullif(
              observation.denominator_source_watermark
                #>>'{receipt,effective_source_cutoff}', ''
            )::timestamptz
          )
        )
        or nullif(
          observation.denominator_source_watermark#>>'{receipt,max_sealed_at}', ''
        )::timestamptz is distinct from denominator.max_sealed_at
        or nullif(
          observation.denominator_source_watermark#>>'{receipt,max_updated_at}', ''
        )::timestamptz is distinct from denominator.max_updated_at
        or observation.denominator_freshness_age_seconds is distinct from extract(
          epoch from (
            observation.as_of
              - nullif(
                observation.denominator_source_watermark->>'fresh_through', ''
              )::timestamptz
          )
        )
        or (
          observation.quality_status = 'usable'
          and (
            observation.window_start_local::date
              <> date_trunc('month', observation.window_start_local)::date
            or observation.window_end_local::date
              <> date_trunc('month', observation.window_end_local)::date
            or numerator.total_count is distinct from (
              extract(year from observation.window_end_local)::integer * 12
              + extract(month from observation.window_end_local)::integer
              - extract(year from observation.window_start_local)::integer * 12
              - extract(month from observation.window_start_local)::integer
            )
            or numerator.included_count is distinct from numerator.total_count
            or numerator.minimum_date
              is distinct from observation.window_start_local::date
            or numerator.maximum_date is distinct from
              (observation.window_end_local::date - interval '1 month')::date
            or denominator.total_count is distinct from
              observation.denominator_window_end_local::date
                - observation.denominator_window_start_local::date
            or denominator.included_count is distinct from denominator.total_count
            or denominator.minimum_date is distinct from
              observation.denominator_window_start_local::date
            or denominator.maximum_date is distinct from
              observation.denominator_window_end_local::date - 1
          )
        )
      )
  ) then
    raise exception 'supply observation lacks an exact replayable source-fact set'
      using errcode = '23514';
  end if;

  select count(*)::integer into v_actual_observation_link_count
  from public.management_pattern_check_observations l
  where l.organization_id = p_organization_id and l.run_id = p_run_id;

  select count(*)::integer into v_actual_root_count
  from public.management_pattern_run_roots root
  where root.organization_id = p_organization_id and root.run_id = p_run_id;

  select count(*)::integer into v_actual_reconciliation_count
  from public.management_pattern_reconciliations rec
  where rec.organization_id = p_organization_id and rec.run_id = p_run_id;

  if p_terminal_status in ('succeeded','abstained') then
    select batch.* into v_result_batch
    from public.management_pattern_result_batches batch
    where batch.organization_id = p_organization_id and batch.run_id = p_run_id;
    if not found
      or v_result_batch.run_fencing_token is distinct from p_fencing_token then
      raise exception 'succeeded/abstained run requires its atomic derived-result batch receipt'
        using errcode = '23514';
    end if;
    if coalesce((v_result_batch.row_counts->>'cohorts')::integer, -1) <> v_actual_cohort_count
      or coalesce((v_result_batch.row_counts->>'cohort_members')::integer, -1)
        <> v_actual_cohort_member_count
      or coalesce((v_result_batch.row_counts->>'check_outcomes')::integer, -1)
        <> v_actual_outcome_count
      or coalesce((v_result_batch.row_counts->>'check_observations')::integer, -1)
        <> v_actual_observation_link_count
      or coalesce((v_result_batch.row_counts->>'candidates')::integer, -1)
        <> v_actual_candidate_count
      or coalesce((v_result_batch.row_counts->>'run_roots')::integer, -1)
        <> v_actual_root_count
      or coalesce((v_result_batch.row_counts->>'reconciliations')::integer, -1)
        <> v_actual_reconciliation_count
      or coalesce((v_result_batch.row_counts->>'candidate_outcomes')::integer, -1)
        <> (select count(*) from public.management_pattern_candidate_outcomes row_count
            where row_count.organization_id = p_organization_id and row_count.run_id = p_run_id)
      or coalesce((v_result_batch.row_counts->>'candidate_properties')::integer, -1)
        <> (select count(*) from public.management_pattern_candidate_properties row_count
            where row_count.organization_id = p_organization_id and row_count.run_id = p_run_id)
      or coalesce((v_result_batch.row_counts->>'candidate_local_instances')::integer, -1)
        <> (select count(*) from public.management_pattern_candidate_local_instances row_count
            where row_count.organization_id = p_organization_id and row_count.run_id = p_run_id)
      or coalesce((v_result_batch.row_counts->>'reconciliation_outcomes')::integer, -1)
        <> (select count(*) from public.management_pattern_reconciliation_outcomes row_count
            where row_count.organization_id = p_organization_id and row_count.run_id = p_run_id)
    then
      raise exception 'derived-result batch row counts do not match immutable run evidence'
        using errcode = '23514';
    end if;
  end if;

  if p_terminal_status in ('succeeded','abstained') and (
    v_actual_outcome_count = 0
    or v_actual_root_count = 0
    or v_actual_reconciliation_count <> v_actual_root_count
  ) then
    raise exception 'a succeeded/abstained run requires non-empty outcomes and a complete root reconciliation manifest'
      using errcode = '23514';
  end if;

  if p_terminal_status in ('succeeded','abstained') and exists (
    select 1
    from public.management_pattern_run_roots root
    where root.organization_id = p_organization_id and root.run_id = p_run_id
      and not exists (
        select 1 from public.management_pattern_reconciliations rec
        where rec.organization_id = root.organization_id
          and rec.run_id = root.run_id
          and rec.semantic_family = root.semantic_family
          and rec.root_key = root.root_key
      )
  ) then
    raise exception 'every expected run root requires one reconciliation receipt'
      using errcode = '23514';
  end if;

  if p_terminal_status in ('succeeded','abstained') and exists (
    select 1
    from public.management_pattern_reconciliations rec
    where rec.organization_id = p_organization_id and rec.run_id = p_run_id
      and not exists (
        select 1 from public.management_pattern_reconciliation_outcomes l
        where l.organization_id = rec.organization_id
          and l.run_id = rec.run_id
          and l.reconciliation_id = rec.id
          and l.lineage_role = 'primary'
      )
  ) then
    raise exception 'every reconciliation requires a primary check-outcome lineage row'
      using errcode = '23514';
  end if;

  if p_terminal_status in ('succeeded','abstained') and exists (
    select 1
    from public.management_pattern_run_roots root
    join public.management_pattern_reconciliations rec
      on rec.organization_id = root.organization_id
     and rec.run_id = root.run_id
     and rec.semantic_family = root.semantic_family
     and rec.root_key = root.root_key
    left join lateral (
      select
        count(*)::integer as outcome_count,
        array_agg(o.outcome_key order by o.outcome_key) as outcome_keys,
        bool_or(o.result = 'candidate') as has_candidate,
        bool_or(o.result in ('abstained','skipped','error')) as has_abstention
      from public.management_pattern_reconciliation_outcomes l
      join public.management_pattern_check_outcomes o
        on o.organization_id = l.organization_id
       and o.run_id = l.run_id
       and o.id = l.check_outcome_id
      where l.organization_id = rec.organization_id
        and l.run_id = rec.run_id
        and l.reconciliation_id = rec.id
    ) actual on true
    left join lateral (
      select
        array_agg(detector.check_id order by detector.check_id) as detector_ids,
        jsonb_object_agg(
          detector.check_id, to_jsonb(detector.check_versions)
          order by detector.check_id
        ) as detector_versions
      from (
        select o.check_id,
               array_agg(distinct o.check_version order by o.check_version)
                 as check_versions
        from public.management_pattern_reconciliation_outcomes detector_link
        join public.management_pattern_check_outcomes o
          on o.organization_id = detector_link.organization_id
         and o.run_id = detector_link.run_id
         and o.id = detector_link.check_outcome_id
        where detector_link.organization_id = rec.organization_id
          and detector_link.run_id = rec.run_id
          and detector_link.reconciliation_id = rec.id
        group by o.check_id
      ) detector
    ) actual_detectors on true
    where root.organization_id = p_organization_id and root.run_id = p_run_id
      and (
        coalesce(actual.outcome_count, 0) <> root.expected_outcome_count
        or actual.outcome_keys is distinct from root.expected_outcome_keys
        or actual_detectors.detector_ids is distinct from root.detector_ids
        or actual_detectors.detector_versions is distinct from root.detector_versions
        or encode(
          pg_catalog.sha256(convert_to(array_to_json(actual.outcome_keys)::text, 'UTF8')), 'hex'
        ) <> root.expected_outcome_set_hash
        or (rec.conclusion = 'present' and not coalesce(actual.has_candidate, false))
        or (rec.conclusion = 'absent' and (
          coalesce(actual.has_candidate, false) or coalesce(actual.has_abstention, false)
        ))
        or (rec.conclusion = 'abstained' and not coalesce(actual.has_abstention, false))
      )
  ) then
    raise exception 'root reconciliation outcome/detector set is incomplete or contradicts its conclusion'
      using errcode = '23514';
  end if;

  if p_terminal_status in ('succeeded','abstained') and exists (
    select 1
    from public.management_pattern_check_outcomes o
    where o.organization_id = p_organization_id and o.run_id = p_run_id
      and not exists (
        select 1 from public.management_pattern_candidate_outcomes l
        where l.organization_id = o.organization_id and l.check_outcome_id = o.id
      )
      and not exists (
        select 1 from public.management_pattern_reconciliation_outcomes l
        where l.organization_id = o.organization_id and l.check_outcome_id = o.id
      )
  ) then
    raise exception 'every check outcome requires candidate or root-reconciliation lineage'
      using errcode = '23514';
  end if;

  if p_terminal_status = 'abstained' and exists (
    select 1
    from public.management_pattern_candidates c
    where c.organization_id = p_organization_id and c.run_id = p_run_id
      and c.decision = 'emit'
  ) then
    raise exception 'an abstained run cannot contain an emitted present candidate'
      using errcode = '23514';
  end if;

  if p_terminal_status in ('succeeded','abstained') and exists (
    select 1
    from public.management_pattern_candidates candidate
    left join public.management_pattern_reconciliations reconciliation
      on reconciliation.organization_id = candidate.organization_id
     and reconciliation.run_id = candidate.run_id
     and reconciliation.candidate_id = candidate.id
     and reconciliation.semantic_family = candidate.semantic_family
     and reconciliation.root_key = candidate.root_key
     and reconciliation.conclusion = 'present'
    where candidate.organization_id = p_organization_id
      and candidate.run_id = p_run_id
      and (
        (candidate.decision = 'emit' and reconciliation.id is null)
        or (
          candidate.decision <> 'emit'
          and reconciliation.id is not null
          and not (
            candidate.decision = 'suppress'
            and cardinality(candidate.suppression_reasons) = 1
            and candidate.suppression_reasons[1] = 'candidate_budget_exceeded'
          )
        )
      )
  ) then
    raise exception 'emitted or budget-only suppressed candidates and present root reconciliations must match exactly'
      using errcode = '23514';
  end if;

  if exists (
    select 1
    from public.management_pattern_cohorts c
    left join lateral (
      select count(*)::integer as total,
             count(*) filter (where m.membership_status = 'included')::integer as included,
             count(*) filter (where m.membership_status = 'excluded')::integer as excluded
      from public.management_pattern_cohort_members m
      where m.organization_id = c.organization_id and m.cohort_id = c.id
    ) actual on true
    where c.organization_id = p_organization_id and c.run_id = p_run_id
      and (
        c.eligible_member_count <> actual.total
        or c.included_member_count <> actual.included
        or c.excluded_member_count <> actual.excluded
      )
  ) then
    raise exception 'cohort declared counts do not match immutable membership rows'
      using errcode = '23514';
  end if;

  if exists (
    select 1
    from public.management_pattern_check_outcomes o
    left join lateral (
      select count(distinct l.candidate_id)::integer as total
      from public.management_pattern_candidate_outcomes l
      where l.organization_id = o.organization_id and l.check_outcome_id = o.id
    ) actual on true
    where o.organization_id = p_organization_id and o.run_id = p_run_id
      and o.candidate_count <> actual.total
  ) then
    raise exception 'check outcome candidate_count does not match immutable candidate lineage'
      using errcode = '23514';
  end if;

  if exists (
    select 1
    from public.management_pattern_candidates c
    where c.organization_id = p_organization_id and c.run_id = p_run_id
      and not exists (
        select 1
        from public.management_pattern_candidate_outcomes l
        where l.organization_id = c.organization_id
          and l.candidate_id = c.id
          and l.check_outcome_id = c.check_outcome_id
          and l.lineage_role = 'primary'
      )
  ) then
    raise exception 'every candidate requires one primary check-outcome lineage row'
      using errcode = '23514';
  end if;

  if exists (
    select 1 from public.management_pattern_check_outcomes o
    where o.organization_id = p_organization_id and o.run_id = p_run_id
      and o.result in ('normal','candidate')
      and not exists (
        select 1 from public.management_pattern_check_observations l
        where l.organization_id = o.organization_id and l.check_outcome_id = o.id
      )
  ) then
    raise exception 'normal/candidate check outcomes require observation lineage'
      using errcode = '23514';
  end if;

  if exists (
    select 1 from public.management_pattern_candidates c
    where c.organization_id = p_organization_id and c.run_id = p_run_id
      and not exists (
        select 1 from public.management_pattern_candidate_properties p
        where p.organization_id = c.organization_id and p.candidate_id = c.id
          and p.occurrence_role = 'affected'
      )
  ) then
    raise exception 'every candidate requires at least one affected-property occurrence'
      using errcode = '23514';
  end if;

  if row(
    p_property_count, p_included_property_count, p_excluded_property_count,
    p_cohort_count, p_cohort_member_count, p_observation_count,
    p_source_fact_count, p_observation_link_count,
    p_check_count, p_outcome_count, p_candidate_count, p_abstention_count
  ) is distinct from row(
    v_actual_property_count, v_actual_included_count, v_actual_excluded_count,
    v_actual_cohort_count, v_actual_cohort_member_count,
    v_actual_observation_count, v_actual_source_fact_count,
    v_actual_observation_link_count,
    v_actual_check_count, v_actual_outcome_count, v_actual_candidate_count, v_actual_abstention_count
  ) then
    raise exception 'finalize counters do not match immutable run evidence'
      using errcode = '23514';
  end if;

  update public.management_pattern_runs r
  set status = p_terminal_status,
      completed_at = v_now,
      heartbeat_at = v_now,
      property_count = p_property_count,
      included_property_count = p_included_property_count,
      excluded_property_count = p_excluded_property_count,
      cohort_count = p_cohort_count,
      cohort_member_count = p_cohort_member_count,
      observation_count = p_observation_count,
      source_fact_count = p_source_fact_count,
      observation_link_count = p_observation_link_count,
      check_count = p_check_count,
      outcome_count = p_outcome_count,
      candidate_count = p_candidate_count,
      abstention_count = p_abstention_count,
      quality_failure_count = p_quality_failure_count,
      model_call_count = p_model_call_count,
      prompt_token_count = p_prompt_token_count,
      completion_token_count = p_completion_token_count,
      estimated_cost_microusd = p_estimated_cost_microusd,
      db_query_count = p_db_query_count,
      duration_ms = p_duration_ms,
      quality_summary = p_quality_summary,
      performance_summary = p_performance_summary,
      cost_summary = p_cost_summary,
      error_detail = p_error_detail
  where r.organization_id = p_organization_id and r.id = p_run_id;
  return query select 'finalized'::text, p_run_id;
end
$$;

-- One bounded input-write boundary for the already-aggregated hotel facts.
-- It does not query raw portfolio data and therefore cannot silently broaden a
-- caller's scope.  JSON shapes:
--
-- run_properties[]:
--   property_id, property_name, membership_relationship_id,
--   membership_snapshot, profile_id?, profile_snapshot?, timezone_name?,
--   business_date_cutoff_hour?, currency_code+currency_minor_unit_exponent?,
--   eligibility_status, exclusion_codes?,
--   property_snapshot_hash
--
-- metric_observations[]:
--   id?, property_id, cohort_id?, metric_key, metric_version, raw_value,
--   raw_unit, raw_currency_code+raw_currency_minor_unit_exponent?, denominator_key/value/unit?,
--   denominator_window_start/end_local+UTC/timezone+business_date_cutoff_hour?,
--   denominator_as_of/completeness/freshness and denominator source query,
--   version, watermark, snapshot hash?,
--   normalized_value/unit/currency+minor-unit-exponent?, normalization_method?, window_start_local,
--   window_end_local, window_timezone, business_date_cutoff_hour,
--   window_start_utc, window_end_utc,
--   as_of, completeness_ratio, freshness_age_seconds, quality_status,
--   quality_reasons?, source_query_id, source_query_version, source_query,
--   source_watermark?, source_snapshot_hash, metadata?
--
-- metric_source_facts[]:
--   observation_id, fact_role, fact_kind, fact_key, source_query_id,
--   source_query_version, source_recorded_at, included_in_aggregate,
--   numeric_value, fact_payload. fact_hash is computed by the database.
create or replace function public.append_management_pattern_input_batch(
  p_organization_id uuid,
  p_run_id uuid,
  p_owner_token uuid,
  p_fencing_token bigint,
  p_run_properties jsonb default '[]'::jsonb,
  p_metric_observations jsonb default '[]'::jsonb,
  p_metric_source_facts jsonb default '[]'::jsonb
)
returns table (
  run_properties_inserted integer,
  metric_observations_inserted integer,
  metric_source_facts_inserted integer
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_run public.management_pattern_runs%rowtype;
  v_properties_inserted integer := 0;
  v_observations_inserted integer := 0;
  v_source_facts_inserted integer := 0;
begin
  if p_organization_id is null or p_run_id is null
    or p_owner_token is null or p_fencing_token is null then
    raise exception 'organization, run, owner token, and fencing token are required'
      using errcode = '22023';
  end if;
  if jsonb_typeof(p_run_properties) is distinct from 'array'
    or jsonb_typeof(p_metric_observations) is distinct from 'array'
    or jsonb_typeof(p_metric_source_facts) is distinct from 'array' then
    raise exception 'management pattern input batches must be JSON arrays'
      using errcode = '22023';
  end if;
  if jsonb_array_length(p_run_properties) > 5000
    or jsonb_array_length(p_metric_observations) > 20000
    or jsonb_array_length(p_metric_source_facts) > 5000
    or octet_length(convert_to(jsonb_build_object(
      'runProperties', p_run_properties,
      'metricObservations', p_metric_observations,
      'metricSourceFacts', p_metric_source_facts
    )::text, 'UTF8')) > 16777216 then
    raise exception 'management pattern input batch exceeds bounded row limit'
      using errcode = '54000';
  end if;
  if exists (
    select 1
    from jsonb_to_recordset(p_metric_observations) as required_id(id uuid)
    where required_id.id is null
  ) then
    raise exception 'every metric observation requires a deterministic id'
      using errcode = '22023';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(p_metric_source_facts) fact(value)
    where jsonb_typeof(fact.value) <> 'object'
      or not (fact.value ?& array[
        'observation_id','fact_role','fact_kind','fact_key','source_query_id',
        'source_query_version','source_recorded_at','included_in_aggregate',
        'numeric_value','fact_payload'
      ])
      or fact.value - array[
        'observation_id','fact_role','fact_kind','fact_key','source_query_id',
        'source_query_version','source_recorded_at','included_in_aggregate',
        'numeric_value','fact_payload'
      ] <> '{}'::jsonb
  ) then
    raise exception 'every metric source fact requires the exact canonical input shape'
      using errcode = '22023';
  end if;
  if exists (
    select 1
    from jsonb_to_recordset(p_metric_source_facts) as fact(
      observation_id uuid, fact_role text, fact_key text
    )
    group by fact.observation_id, fact.fact_role, fact.fact_key
    having count(*) > 1
  ) then
    raise exception 'metric source fact batch contains a duplicate immutable identity'
      using errcode = '22023';
  end if;

  select r.* into v_run
  from public.management_pattern_runs r
  where r.organization_id = p_organization_id and r.id = p_run_id
  for update;
  if not found then
    raise exception 'management pattern run is outside organization scope or absent'
      using errcode = '42501';
  end if;
  if v_run.status not in ('claimed','running')
    or v_run.owner_token is distinct from p_owner_token
    or v_run.fencing_token is distinct from p_fencing_token
    or v_run.lease_expires_at <= clock_timestamp() then
    raise exception 'management pattern batch rejected by run lease/fence CAS'
      using errcode = '40001';
  end if;

  insert into public.management_pattern_run_properties (
    organization_id, run_id, run_fencing_token, property_id, property_name,
    membership_relationship_id, membership_snapshot, profile_id, profile_snapshot,
    timezone_name, business_date_cutoff_hour, currency_code,
    currency_minor_unit_exponent,
    eligibility_status, exclusion_codes,
    property_snapshot_hash
  )
  select
    p_organization_id, p_run_id, p_fencing_token, x.property_id, x.property_name,
    x.membership_relationship_id, coalesce(x.membership_snapshot, '{}'::jsonb),
    x.profile_id, coalesce(x.profile_snapshot, '{}'::jsonb),
    x.timezone_name, x.business_date_cutoff_hour, x.currency_code,
    x.currency_minor_unit_exponent, x.eligibility_status,
    coalesce(x.exclusion_codes, '{}'::text[]), x.property_snapshot_hash
  from jsonb_to_recordset(p_run_properties) as x(
    property_id uuid,
    property_name text,
    membership_relationship_id uuid,
    membership_snapshot jsonb,
    profile_id uuid,
    profile_snapshot jsonb,
    timezone_name text,
    business_date_cutoff_hour integer,
    currency_code text,
    currency_minor_unit_exponent smallint,
    eligibility_status text,
    exclusion_codes text[],
    property_snapshot_hash text
  )
  on conflict (organization_id, run_id, property_id) do nothing;
  get diagnostics v_properties_inserted = row_count;

  if exists (
    select 1
    from jsonb_to_recordset(p_run_properties) as x(
      property_id uuid,
      property_name text,
      membership_relationship_id uuid,
      membership_snapshot jsonb,
      profile_id uuid,
      profile_snapshot jsonb,
      timezone_name text,
      business_date_cutoff_hour integer,
      currency_code text,
      currency_minor_unit_exponent smallint,
      eligibility_status text,
      exclusion_codes text[],
      property_snapshot_hash text
    )
    join public.management_pattern_run_properties p
      on p.organization_id = p_organization_id
      and p.run_id = p_run_id
      and p.property_id = x.property_id
    where row(
      p.run_fencing_token, p.property_name, p.membership_relationship_id,
      p.membership_snapshot, p.profile_id, p.profile_snapshot, p.timezone_name,
      p.business_date_cutoff_hour, p.currency_code, p.currency_minor_unit_exponent,
      p.eligibility_status, p.exclusion_codes, p.property_snapshot_hash
    ) is distinct from row(
      p_fencing_token, x.property_name, x.membership_relationship_id,
      coalesce(x.membership_snapshot, '{}'::jsonb), x.profile_id,
      coalesce(x.profile_snapshot, '{}'::jsonb), x.timezone_name,
      x.business_date_cutoff_hour, x.currency_code, x.currency_minor_unit_exponent,
      x.eligibility_status, coalesce(x.exclusion_codes, '{}'::text[]),
      x.property_snapshot_hash
    )
  ) then
    raise exception 'input_conflict: immutable run-property payload differs for an existing identity'
      using errcode = '22000';
  end if;

  insert into public.management_pattern_metric_observations (
    id, organization_id, run_id, run_fencing_token, property_id, cohort_id,
    metric_key, metric_version, raw_value, raw_unit, raw_currency_code,
    raw_currency_minor_unit_exponent,
    denominator_key, denominator_value, denominator_unit, denominator_window_kind,
    denominator_window_start_local, denominator_window_end_local,
    denominator_window_timezone, denominator_business_date_cutoff_hour,
    denominator_window_start_utc, denominator_window_end_utc,
    denominator_as_of, denominator_completeness_ratio,
    denominator_freshness_age_seconds, denominator_source_query_id,
    denominator_source_query_version, denominator_source_query,
    denominator_source_watermark, denominator_source_snapshot_hash,
    normalized_value, normalized_unit, normalized_currency_code,
    normalized_currency_minor_unit_exponent,
    currency_conversion_rate, currency_conversion_as_of,
    currency_conversion_source_query_id, currency_conversion_source_query_version,
    currency_conversion_source_snapshot_hash, normalization_method,
    normalization_policy_version, normalization_definition_hash,
    normalization_window_alignment,
    window_kind, window_start_local, window_end_local, window_timezone, business_date_cutoff_hour,
    window_start_utc, window_end_utc, as_of,
    completeness_ratio, freshness_age_seconds, quality_status, quality_reasons,
    source_query_id, source_query_version, source_query, source_watermark,
    source_snapshot_hash, metadata
  )
  select
    x.id, p_organization_id, p_run_id, p_fencing_token,
    x.property_id, x.cohort_id, x.metric_key, x.metric_version,
    x.raw_value, x.raw_unit, x.raw_currency_code, x.raw_currency_minor_unit_exponent,
    x.denominator_key, x.denominator_value, x.denominator_unit, x.denominator_window_kind,
    x.denominator_window_start_local, x.denominator_window_end_local,
    x.denominator_window_timezone, x.denominator_business_date_cutoff_hour,
    x.denominator_window_start_utc, x.denominator_window_end_utc,
    x.denominator_as_of, x.denominator_completeness_ratio,
    x.denominator_freshness_age_seconds, x.denominator_source_query_id,
    x.denominator_source_query_version, x.denominator_source_query,
    x.denominator_source_watermark, x.denominator_source_snapshot_hash,
    x.normalized_value, x.normalized_unit, x.normalized_currency_code,
    x.normalized_currency_minor_unit_exponent,
    x.currency_conversion_rate, x.currency_conversion_as_of,
    x.currency_conversion_source_query_id, x.currency_conversion_source_query_version,
    x.currency_conversion_source_snapshot_hash, x.normalization_method,
    x.normalization_policy_version, x.normalization_definition_hash,
    x.normalization_window_alignment,
    x.window_kind, x.window_start_local, x.window_end_local, x.window_timezone,
    x.business_date_cutoff_hour,
    x.window_start_utc, x.window_end_utc, x.as_of,
    x.completeness_ratio, x.freshness_age_seconds, x.quality_status,
    coalesce(x.quality_reasons, '{}'::text[]),
    x.source_query_id, x.source_query_version, x.source_query,
    coalesce(x.source_watermark, '{}'::jsonb), x.source_snapshot_hash,
    coalesce(x.metadata, '{}'::jsonb)
  from jsonb_to_recordset(p_metric_observations) as x(
    id uuid,
    property_id uuid,
    cohort_id uuid,
    metric_key text,
    metric_version text,
    raw_value numeric,
    raw_unit text,
    raw_currency_code text,
    raw_currency_minor_unit_exponent smallint,
    denominator_key text,
    denominator_value numeric,
    denominator_unit text,
    denominator_window_kind text,
    denominator_window_start_local timestamp without time zone,
    denominator_window_end_local timestamp without time zone,
    denominator_window_timezone text,
    denominator_business_date_cutoff_hour smallint,
    denominator_window_start_utc timestamptz,
    denominator_window_end_utc timestamptz,
    denominator_as_of timestamptz,
    denominator_completeness_ratio numeric,
    denominator_freshness_age_seconds numeric,
    denominator_source_query_id text,
    denominator_source_query_version text,
    denominator_source_query jsonb,
    denominator_source_watermark jsonb,
    denominator_source_snapshot_hash text,
    normalized_value numeric,
    normalized_unit text,
    normalized_currency_code text,
    normalized_currency_minor_unit_exponent smallint,
    currency_conversion_rate numeric,
    currency_conversion_as_of timestamptz,
    currency_conversion_source_query_id text,
    currency_conversion_source_query_version text,
    currency_conversion_source_snapshot_hash text,
    normalization_method text,
    normalization_policy_version text,
    normalization_definition_hash text,
    normalization_window_alignment text,
    window_kind text,
    window_start_local timestamp without time zone,
    window_end_local timestamp without time zone,
    window_timezone text,
    business_date_cutoff_hour smallint,
    window_start_utc timestamptz,
    window_end_utc timestamptz,
    as_of timestamptz,
    completeness_ratio numeric,
    freshness_age_seconds numeric,
    quality_status text,
    quality_reasons text[],
    source_query_id text,
    source_query_version text,
    source_query jsonb,
    source_watermark jsonb,
    source_snapshot_hash text,
    metadata jsonb
  )
  on conflict (
    organization_id, run_id, property_id, metric_key,
    window_start_utc, window_end_utc, source_snapshot_hash
  ) do nothing;
  get diagnostics v_observations_inserted = row_count;

  if exists (
    select 1
    from jsonb_to_recordset(p_metric_observations) as x(
      id uuid,
      property_id uuid,
      cohort_id uuid,
      metric_key text,
      metric_version text,
      raw_value numeric,
      raw_unit text,
      raw_currency_code text,
      raw_currency_minor_unit_exponent smallint,
      denominator_key text,
      denominator_value numeric,
      denominator_unit text,
      denominator_window_kind text,
      denominator_window_start_local timestamp without time zone,
      denominator_window_end_local timestamp without time zone,
      denominator_window_timezone text,
      denominator_business_date_cutoff_hour smallint,
      denominator_window_start_utc timestamptz,
      denominator_window_end_utc timestamptz,
      denominator_as_of timestamptz,
      denominator_completeness_ratio numeric,
      denominator_freshness_age_seconds numeric,
      denominator_source_query_id text,
      denominator_source_query_version text,
      denominator_source_query jsonb,
      denominator_source_watermark jsonb,
      denominator_source_snapshot_hash text,
      normalized_value numeric,
      normalized_unit text,
      normalized_currency_code text,
      normalized_currency_minor_unit_exponent smallint,
      currency_conversion_rate numeric,
      currency_conversion_as_of timestamptz,
      currency_conversion_source_query_id text,
      currency_conversion_source_query_version text,
      currency_conversion_source_snapshot_hash text,
      normalization_method text,
      normalization_policy_version text,
      normalization_definition_hash text,
      normalization_window_alignment text,
      window_kind text,
      window_start_local timestamp without time zone,
      window_end_local timestamp without time zone,
      window_timezone text,
      business_date_cutoff_hour smallint,
      window_start_utc timestamptz,
      window_end_utc timestamptz,
      as_of timestamptz,
      completeness_ratio numeric,
      freshness_age_seconds numeric,
      quality_status text,
      quality_reasons text[],
      source_query_id text,
      source_query_version text,
      source_query jsonb,
      source_watermark jsonb,
      source_snapshot_hash text,
      metadata jsonb
    )
    join public.management_pattern_metric_observations o
      on o.organization_id = p_organization_id
      and o.run_id = p_run_id
      and o.property_id = x.property_id
      and o.metric_key = x.metric_key
      and o.window_start_utc = x.window_start_utc
      and o.window_end_utc = x.window_end_utc
      and o.source_snapshot_hash = x.source_snapshot_hash
    where row(
      o.id, o.run_fencing_token, o.cohort_id, o.metric_version, o.raw_value,
      o.raw_unit, o.raw_currency_code, o.raw_currency_minor_unit_exponent,
      o.denominator_key, o.denominator_value, o.denominator_unit,
      o.denominator_window_kind,
      o.denominator_window_start_local, o.denominator_window_end_local,
      o.denominator_window_timezone, o.denominator_business_date_cutoff_hour,
      o.denominator_window_start_utc, o.denominator_window_end_utc,
      o.denominator_as_of, o.denominator_completeness_ratio,
      o.denominator_freshness_age_seconds, o.denominator_source_query_id,
      o.denominator_source_query_version, o.denominator_source_query,
      o.denominator_source_watermark, o.denominator_source_snapshot_hash,
      o.normalized_value, o.normalized_unit, o.normalized_currency_code,
      o.normalized_currency_minor_unit_exponent,
      o.currency_conversion_rate, o.currency_conversion_as_of,
      o.currency_conversion_source_query_id, o.currency_conversion_source_query_version,
      o.currency_conversion_source_snapshot_hash, o.normalization_method,
      o.normalization_policy_version, o.normalization_definition_hash,
      o.normalization_window_alignment,
      o.window_kind, o.window_start_local, o.window_end_local, o.window_timezone,
      o.business_date_cutoff_hour, o.as_of, o.completeness_ratio,
      o.freshness_age_seconds, o.quality_status, o.quality_reasons,
      o.source_query_id, o.source_query_version, o.source_query,
      o.source_watermark, o.metadata
    ) is distinct from row(
      x.id, p_fencing_token, x.cohort_id, x.metric_version, x.raw_value,
      x.raw_unit, x.raw_currency_code, x.raw_currency_minor_unit_exponent,
      x.denominator_key, x.denominator_value, x.denominator_unit,
      x.denominator_window_kind,
      x.denominator_window_start_local, x.denominator_window_end_local,
      x.denominator_window_timezone, x.denominator_business_date_cutoff_hour,
      x.denominator_window_start_utc, x.denominator_window_end_utc,
      x.denominator_as_of, x.denominator_completeness_ratio,
      x.denominator_freshness_age_seconds, x.denominator_source_query_id,
      x.denominator_source_query_version, x.denominator_source_query,
      x.denominator_source_watermark, x.denominator_source_snapshot_hash,
      x.normalized_value, x.normalized_unit, x.normalized_currency_code,
      x.normalized_currency_minor_unit_exponent,
      x.currency_conversion_rate, x.currency_conversion_as_of,
      x.currency_conversion_source_query_id, x.currency_conversion_source_query_version,
      x.currency_conversion_source_snapshot_hash, x.normalization_method,
      x.normalization_policy_version, x.normalization_definition_hash,
      x.normalization_window_alignment,
      x.window_kind, x.window_start_local, x.window_end_local, x.window_timezone,
      x.business_date_cutoff_hour, x.as_of, x.completeness_ratio,
      x.freshness_age_seconds, x.quality_status,
      coalesce(x.quality_reasons, '{}'::text[]),
      x.source_query_id, x.source_query_version, x.source_query,
      coalesce(x.source_watermark, '{}'::jsonb), coalesce(x.metadata, '{}'::jsonb)
    )
  ) then
    raise exception 'input_conflict: immutable metric-observation payload differs for an existing identity'
      using errcode = '22000';
  end if;

  insert into public.management_pattern_metric_source_facts (
    organization_id, run_id, run_fencing_token, observation_id,
    fact_role, fact_kind, fact_key, source_query_id, source_query_version,
    source_recorded_at, included_in_aggregate, numeric_value, fact_payload
  )
  select
    p_organization_id, p_run_id, p_fencing_token, fact.observation_id,
    fact.fact_role, fact.fact_kind, fact.fact_key, fact.source_query_id,
    fact.source_query_version, fact.source_recorded_at,
    fact.included_in_aggregate, fact.numeric_value, fact.fact_payload
  from jsonb_to_recordset(p_metric_source_facts) as fact(
    observation_id uuid,
    fact_role text,
    fact_kind text,
    fact_key text,
    source_query_id text,
    source_query_version text,
    source_recorded_at timestamptz,
    included_in_aggregate boolean,
    numeric_value numeric,
    fact_payload jsonb
  )
  on conflict (organization_id, run_id, observation_id, fact_role, fact_key)
    do nothing;
  get diagnostics v_source_facts_inserted = row_count;

  if exists (
    select 1
    from jsonb_to_recordset(p_metric_source_facts) as fact(
      observation_id uuid,
      fact_role text,
      fact_kind text,
      fact_key text,
      source_query_id text,
      source_query_version text,
      source_recorded_at timestamptz,
      included_in_aggregate boolean,
      numeric_value numeric,
      fact_payload jsonb
    )
    join public.management_pattern_metric_source_facts stored
      on stored.organization_id = p_organization_id
      and stored.run_id = p_run_id
      and stored.observation_id = fact.observation_id
      and stored.fact_role = fact.fact_role
      and stored.fact_key = fact.fact_key
    where row(
      stored.run_fencing_token, stored.fact_kind, stored.source_query_id,
      stored.source_query_version, stored.source_recorded_at,
      stored.included_in_aggregate, stored.numeric_value, stored.fact_payload
    ) is distinct from row(
      p_fencing_token, fact.fact_kind, fact.source_query_id,
      fact.source_query_version, fact.source_recorded_at,
      fact.included_in_aggregate, fact.numeric_value, fact.fact_payload
    )
  ) then
    raise exception 'input_conflict: immutable metric-source-fact payload differs for an existing identity'
      using errcode = '22000';
  end if;

  return query select
    v_properties_inserted, v_observations_inserted, v_source_facts_inserted;
end
$$;

-- ---------------------------------------------------------------------------
-- One atomic, bounded derived-result write boundary.
--
-- p_results is a strict object whose optional array keys are:
--   cohorts, cohort_members, check_outcomes, check_observations, candidates,
--   candidate_outcomes, candidate_properties, candidate_local_instances,
--   run_roots, reconciliations, reconciliation_outcomes.
-- Organization/run/fencing fields are ignored from JSON and supplied by the
-- CAS arguments. All UUID identities in entity arrays are caller-deterministic.
-- ---------------------------------------------------------------------------

create or replace function public.append_management_pattern_result_batch(
  p_organization_id uuid,
  p_run_id uuid,
  p_owner_token uuid,
  p_fencing_token bigint,
  p_results jsonb
)
returns table (outcome text, batch_hash text, row_counts jsonb)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_run public.management_pattern_runs%rowtype;
  v_existing public.management_pattern_result_batches%rowtype;
  v_hash text;
  v_counts jsonb;
  v_key text;
  v_allowed_keys constant text[] := array[
    'cohorts','cohort_members','check_outcomes','check_observations',
    'candidates','candidate_outcomes','candidate_properties',
    'candidate_local_instances','run_roots','reconciliations',
    'reconciliation_outcomes'
  ];
begin
  if p_organization_id is null or p_run_id is null
    or p_owner_token is null or p_fencing_token is null then
    raise exception 'organization, run, owner token, and fencing token are required'
      using errcode = '22023';
  end if;
  if jsonb_typeof(p_results) is distinct from 'object' then
    raise exception 'management pattern result batch must be a JSON object'
      using errcode = '22023';
  end if;
  if p_results - v_allowed_keys <> '{}'::jsonb then
    raise exception 'management pattern result batch contains unknown keys'
      using errcode = '22023';
  end if;
  if pg_column_size(p_results) > 16777216 then
    raise exception 'management pattern result batch exceeds fixed 16 MiB limit'
      using errcode = '54000';
  end if;
  foreach v_key in array v_allowed_keys loop
    if p_results ? v_key and jsonb_typeof(p_results -> v_key) <> 'array' then
      raise exception 'management pattern result batch key % must be an array', v_key
        using errcode = '22023';
    end if;
  end loop;
  if jsonb_array_length(coalesce(p_results->'cohorts','[]'::jsonb)) > 500
    or jsonb_array_length(coalesce(p_results->'cohort_members','[]'::jsonb)) > 5000
    or jsonb_array_length(coalesce(p_results->'check_outcomes','[]'::jsonb)) > 5000
    or jsonb_array_length(coalesce(p_results->'check_observations','[]'::jsonb)) > 20000
    or jsonb_array_length(coalesce(p_results->'candidates','[]'::jsonb)) > 500
    or jsonb_array_length(coalesce(p_results->'candidate_outcomes','[]'::jsonb)) > 5000
    or jsonb_array_length(coalesce(p_results->'candidate_properties','[]'::jsonb)) > 10000
    or jsonb_array_length(coalesce(p_results->'candidate_local_instances','[]'::jsonb)) > 20000
    or jsonb_array_length(coalesce(p_results->'run_roots','[]'::jsonb)) > 5000
    or jsonb_array_length(coalesce(p_results->'reconciliations','[]'::jsonb)) > 5000
    or jsonb_array_length(coalesce(p_results->'reconciliation_outcomes','[]'::jsonb)) > 20000 then
    raise exception 'management pattern result batch exceeds a fixed row limit'
      using errcode = '54000';
  end if;

  v_hash := encode(pg_catalog.sha256(convert_to(p_results::text, 'UTF8')), 'hex');
  v_counts := jsonb_build_object(
    'cohorts', jsonb_array_length(coalesce(p_results->'cohorts','[]'::jsonb)),
    'cohort_members', jsonb_array_length(coalesce(p_results->'cohort_members','[]'::jsonb)),
    'check_outcomes', jsonb_array_length(coalesce(p_results->'check_outcomes','[]'::jsonb)),
    'check_observations', jsonb_array_length(coalesce(p_results->'check_observations','[]'::jsonb)),
    'candidates', jsonb_array_length(coalesce(p_results->'candidates','[]'::jsonb)),
    'candidate_outcomes', jsonb_array_length(coalesce(p_results->'candidate_outcomes','[]'::jsonb)),
    'candidate_properties', jsonb_array_length(coalesce(p_results->'candidate_properties','[]'::jsonb)),
    'candidate_local_instances', jsonb_array_length(coalesce(p_results->'candidate_local_instances','[]'::jsonb)),
    'run_roots', jsonb_array_length(coalesce(p_results->'run_roots','[]'::jsonb)),
    'reconciliations', jsonb_array_length(coalesce(p_results->'reconciliations','[]'::jsonb)),
    'reconciliation_outcomes', jsonb_array_length(coalesce(p_results->'reconciliation_outcomes','[]'::jsonb))
  );

  select r.* into v_run
  from public.management_pattern_runs r
  where r.organization_id = p_organization_id and r.id = p_run_id
  for update;
  if not found then
    raise exception 'management pattern run is outside organization scope or absent'
      using errcode = '42501';
  end if;

  select b.* into v_existing
  from public.management_pattern_result_batches b
  where b.organization_id = p_organization_id and b.run_id = p_run_id;
  if found then
    if v_existing.run_fencing_token is distinct from p_fencing_token
      or v_run.fencing_token is distinct from p_fencing_token
      or v_run.owner_token is distinct from p_owner_token then
      raise exception 'result batch retry rejected by run owner/fence CAS'
        using errcode = '40001';
    end if;
    if v_existing.batch_hash <> v_hash or v_existing.row_counts <> v_counts then
      raise exception 'input_conflict: derived result batch differs from committed run batch'
        using errcode = '22000';
    end if;
    return query select 'already_applied'::text, v_hash, v_counts;
    return;
  end if;

  if v_run.status not in ('claimed','running')
    or v_run.owner_token is distinct from p_owner_token
    or v_run.fencing_token is distinct from p_fencing_token
    or v_run.lease_expires_at <= clock_timestamp() then
    raise exception 'management pattern result batch rejected by run lease/fence CAS'
      using errcode = '40001';
  end if;

  if exists (
    select 1 from jsonb_array_elements(coalesce(p_results->'cohorts','[]'::jsonb)) e
    where nullif(e->>'id','') is null
    union all
    select 1 from jsonb_array_elements(coalesce(p_results->'check_outcomes','[]'::jsonb)) e
    where nullif(e->>'id','') is null
    union all
    select 1 from jsonb_array_elements(coalesce(p_results->'candidates','[]'::jsonb)) e
    where nullif(e->>'id','') is null
    union all
    select 1 from jsonb_array_elements(coalesce(p_results->'candidate_local_instances','[]'::jsonb)) e
    where nullif(e->>'local_instance_id','') is null
    union all
    select 1 from jsonb_array_elements(coalesce(p_results->'reconciliations','[]'::jsonb)) e
    where nullif(e->>'id','') is null
  ) then
    raise exception 'derived entity rows require deterministic UUID identities'
      using errcode = '22023';
  end if;

  insert into public.management_pattern_cohorts(
    id, organization_id, run_id, run_fencing_token, cohort_key,
    definition_version, definition_hash, target_property_id, status,
    fallback_level, minimum_member_count, eligible_member_count,
    included_member_count, excluded_member_count, dimension_keys,
    definition, quality, abstention_reason
  )
  select x.id, p_organization_id, p_run_id, p_fencing_token, x.cohort_key,
    x.definition_version, x.definition_hash, x.target_property_id, x.status,
    coalesce(x.fallback_level, 0), x.minimum_member_count,
    coalesce(x.eligible_member_count, 0), coalesce(x.included_member_count, 0),
    coalesce(x.excluded_member_count, 0), coalesce(x.dimension_keys, '{}'::text[]),
    x.definition, coalesce(x.quality, '{}'::jsonb), x.abstention_reason
  from jsonb_populate_recordset(
    null::public.management_pattern_cohorts,
    coalesce(p_results->'cohorts','[]'::jsonb)
  ) x;

  insert into public.management_pattern_cohort_members(
    organization_id, run_id, run_fencing_token, cohort_id, property_id,
    profile_id, membership_status, member_role, exclusion_codes,
    normalized_dimensions, distance_score, comparison_weight, decision_reason
  )
  select p_organization_id, p_run_id, p_fencing_token, x.cohort_id, x.property_id,
    x.profile_id, x.membership_status, x.member_role,
    coalesce(x.exclusion_codes, '{}'::text[]),
    coalesce(x.normalized_dimensions, '{}'::jsonb), x.distance_score,
    x.comparison_weight, x.decision_reason
  from jsonb_populate_recordset(
    null::public.management_pattern_cohort_members,
    coalesce(p_results->'cohort_members','[]'::jsonb)
  ) x;

  insert into public.management_pattern_check_outcomes(
    id, organization_id, run_id, run_fencing_token, outcome_key, check_id,
    check_version, semantic_family, root_domain_key, target_property_id,
    cohort_id, result, quality_gate, deterministic, input_hash, outcome_hash,
    parameters, evidence, reason_codes, candidate_count, rows_examined, duration_ms
  )
  select x.id, p_organization_id, p_run_id, p_fencing_token, x.outcome_key,
    x.check_id, x.check_version, x.semantic_family, x.root_domain_key,
    x.target_property_id, x.cohort_id, x.result, x.quality_gate,
    coalesce(x.deterministic, true), x.input_hash, x.outcome_hash,
    coalesce(x.parameters, '{}'::jsonb), coalesce(x.evidence, '{}'::jsonb),
    coalesce(x.reason_codes, '{}'::text[]), coalesce(x.candidate_count, 0),
    coalesce(x.rows_examined, 0), coalesce(x.duration_ms, 0)
  from jsonb_populate_recordset(
    null::public.management_pattern_check_outcomes,
    coalesce(p_results->'check_outcomes','[]'::jsonb)
  ) x;

  insert into public.management_pattern_check_observations(
    organization_id, run_id, run_fencing_token, check_outcome_id,
    observation_id, usage_role
  )
  select p_organization_id, p_run_id, p_fencing_token, x.check_outcome_id,
    x.observation_id, x.usage_role
  from jsonb_populate_recordset(
    null::public.management_pattern_check_observations,
    coalesce(p_results->'check_observations','[]'::jsonb)
  ) x;

  insert into public.management_pattern_candidates(
    id, organization_id, run_id, run_fencing_token, check_outcome_id,
    candidate_key, projection_dedupe_key, semantic_family, root_key,
    classified_scope, scope_evidence, decision, suppression_reasons, summary,
    severity, disposition, receipt_query_id, evidence, effective_at,
    weakest_input_age_days, magnitude, materiality_score, confidence,
    confidence_kind, price_low_cents, price_high_cents, price_currency_code,
    price_basis, escalation_factor, escalation_min_delta, routing_metadata,
    quality_metadata, candidate_hash, candidate_schema_version
  )
  select x.id, p_organization_id, p_run_id, p_fencing_token, x.check_outcome_id,
    x.candidate_key, x.projection_dedupe_key, x.semantic_family, x.root_key,
    x.classified_scope, x.scope_evidence, x.decision,
    coalesce(x.suppression_reasons, '{}'::text[]), x.summary, x.severity,
    x.disposition, x.receipt_query_id, x.evidence, x.effective_at,
    x.weakest_input_age_days, x.magnitude, x.materiality_score, x.confidence,
    x.confidence_kind, x.price_low_cents, x.price_high_cents,
    x.price_currency_code, x.price_basis, x.escalation_factor,
    x.escalation_min_delta, coalesce(x.routing_metadata, '{}'::jsonb),
    coalesce(x.quality_metadata, '{}'::jsonb), x.candidate_hash,
    coalesce(x.candidate_schema_version, 2)
  from jsonb_populate_recordset(
    null::public.management_pattern_candidates,
    coalesce(p_results->'candidates','[]'::jsonb)
  ) x;

  insert into public.management_pattern_candidate_outcomes(
    organization_id, run_id, run_fencing_token, candidate_id, check_outcome_id,
    manifestation_key, lineage_role, manifestation_evidence
  )
  select p_organization_id, p_run_id, p_fencing_token, x.candidate_id,
    x.check_outcome_id, x.manifestation_key, x.lineage_role,
    coalesce(x.manifestation_evidence, '{}'::jsonb)
  from jsonb_populate_recordset(
    null::public.management_pattern_candidate_outcomes,
    coalesce(p_results->'candidate_outcomes','[]'::jsonb)
  ) x;

  insert into public.management_pattern_candidate_properties(
    organization_id, run_id, run_fencing_token, candidate_id, property_id,
    occurrence_role, exclusion_codes, occurrence_evidence
  )
  select p_organization_id, p_run_id, p_fencing_token, x.candidate_id,
    x.property_id, x.occurrence_role, coalesce(x.exclusion_codes, '{}'::text[]),
    coalesce(x.occurrence_evidence, '{}'::jsonb)
  from jsonb_populate_recordset(
    null::public.management_pattern_candidate_properties,
    coalesce(p_results->'candidate_properties','[]'::jsonb)
  ) x;

  insert into public.management_pattern_candidate_local_instances(
    organization_id, run_id, run_fencing_token, candidate_id, property_id,
    local_instance_id, local_finding_id, occurrence_at,
    local_finding_snapshot, occurrence_evidence
  )
  select p_organization_id, p_run_id, p_fencing_token, x.candidate_id,
    x.property_id, x.local_instance_id, x.local_finding_id, x.occurrence_at,
    coalesce(x.local_finding_snapshot, '{}'::jsonb),
    coalesce(x.occurrence_evidence, '{}'::jsonb)
  from jsonb_populate_recordset(
    null::public.management_pattern_candidate_local_instances,
    coalesce(p_results->'candidate_local_instances','[]'::jsonb)
  ) x;

  insert into public.management_pattern_run_roots(
    organization_id, run_id, run_fencing_token, semantic_family, root_key,
    root_domain_key, detector_ids, detector_versions, expected_outcome_count,
    expected_outcome_keys, expected_outcome_set_hash,
    manifest_source, definition_hash
  )
  select p_organization_id, p_run_id, p_fencing_token, x.semantic_family,
    x.root_key, x.root_domain_key, x.detector_ids, x.detector_versions,
    x.expected_outcome_count,
    x.expected_outcome_keys, x.expected_outcome_set_hash,
    x.manifest_source, x.definition_hash
  from jsonb_populate_recordset(
    null::public.management_pattern_run_roots,
    coalesce(p_results->'run_roots','[]'::jsonb)
  ) x;

  insert into public.management_pattern_reconciliations(
    id, organization_id, run_id, run_fencing_token, check_outcome_id,
    candidate_id, semantic_family, root_key, root_domain_key,
    detector_ids, detector_versions,
    conclusion, effective_at, evidence, reconciliation_hash
  )
  select x.id, p_organization_id, p_run_id, p_fencing_token,
    x.check_outcome_id, x.candidate_id, x.semantic_family, x.root_key,
    x.root_domain_key, x.detector_ids, x.detector_versions,
    x.conclusion, x.effective_at,
    coalesce(x.evidence, '{}'::jsonb), x.reconciliation_hash
  from jsonb_populate_recordset(
    null::public.management_pattern_reconciliations,
    coalesce(p_results->'reconciliations','[]'::jsonb)
  ) x;

  insert into public.management_pattern_reconciliation_outcomes(
    organization_id, run_id, run_fencing_token, reconciliation_id,
    check_outcome_id, lineage_role
  )
  select p_organization_id, p_run_id, p_fencing_token, x.reconciliation_id,
    x.check_outcome_id, x.lineage_role
  from jsonb_populate_recordset(
    null::public.management_pattern_reconciliation_outcomes,
    coalesce(p_results->'reconciliation_outcomes','[]'::jsonb)
  ) x;

  insert into public.management_pattern_result_batches(
    organization_id, run_id, run_fencing_token, batch_hash, row_counts
  ) values (p_organization_id, p_run_id, p_fencing_token, v_hash, v_counts);

  return query select 'applied'::text, v_hash, v_counts;
end
$$;

-- ---------------------------------------------------------------------------
-- Atomic candidate -> company_findings projection.
-- ---------------------------------------------------------------------------

create or replace function public.project_management_pattern_candidate(
  p_organization_id uuid,
  p_candidate_id uuid
)
returns table (outcome text, finding_id uuid)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_candidate public.management_pattern_candidates%rowtype;
  v_finding public.company_findings%rowtype;
  v_check_id text;
  v_check_version text;
  v_run_status text;
  v_projection_mode text;
  v_triggered_by text;
  v_engine_version text;
  v_evidence_schema_version integer;
  v_cohort_policy_version text;
  v_normalization_policy_version text;
  v_dedupe_policy_version text;
  v_scope_policy_version text;
  v_affected_property_ids uuid[];
  v_affected_count integer;
  v_comparator_count integer;
  v_has_finding boolean;
  v_new_status text;
  v_new_disposition text;
  v_projection_outcome text;
  v_escalated boolean := false;
  v_occurrence_increment integer := 1;
begin
  if p_organization_id is null or p_candidate_id is null then
    raise exception 'organization and candidate are required' using errcode = '22023';
  end if;
  raise exception 'active management-pattern projection is disabled for this shadow schema'
    using errcode = '0A000';

  select c.* into v_candidate
  from public.management_pattern_candidates c
  where c.organization_id = p_organization_id and c.id = p_candidate_id;
  if not found then
    raise exception 'candidate is outside organization scope or absent' using errcode = '42501';
  end if;

  select o.check_id, o.check_version, r.status, r.projection_mode, r.triggered_by,
         r.engine_version,
         r.evidence_schema_version, r.cohort_policy_version,
         r.normalization_policy_version, r.dedupe_policy_version,
         r.scope_policy_version
    into v_check_id, v_check_version, v_run_status, v_projection_mode, v_triggered_by,
         v_engine_version,
         v_evidence_schema_version, v_cohort_policy_version,
         v_normalization_policy_version, v_dedupe_policy_version,
         v_scope_policy_version
  from public.management_pattern_check_outcomes o
  join public.management_pattern_runs r
    on r.organization_id = o.organization_id and r.id = o.run_id
  where o.organization_id = p_organization_id
    and o.id = v_candidate.check_outcome_id
    and o.run_id = v_candidate.run_id;

  if v_run_status <> 'succeeded' then
    raise exception 'only a candidate from a succeeded sealed run may be projected'
      using errcode = '55000';
  end if;
  if v_projection_mode <> 'active' or v_triggered_by not in ('scheduled','manual') then
    raise exception 'run is evidence-only and not authorized for active projection'
      using errcode = '42501';
  end if;
  if v_candidate.decision <> 'emit' then
    return query select 'not_projectable'::text, null::uuid;
    return;
  end if;
  if not exists (
    select 1
    from public.management_pattern_reconciliations reconciliation
    where reconciliation.organization_id = p_organization_id
      and reconciliation.run_id = v_candidate.run_id
      and reconciliation.semantic_family = v_candidate.semantic_family
      and reconciliation.root_key = v_candidate.root_key
      and reconciliation.conclusion = 'present'
      and reconciliation.candidate_id = v_candidate.id
  ) then
    raise exception 'candidate is not the sealed present reconciliation for its root'
      using errcode = '55000';
  end if;

  select coalesce(array_agg(p.property_id order by p.property_id), '{}'::uuid[]),
         count(*)::integer
    into v_affected_property_ids, v_affected_count
  from public.management_pattern_candidate_properties p
  where p.organization_id = p_organization_id
    and p.candidate_id = p_candidate_id
    and p.occurrence_role = 'affected';

  select count(*)::integer into v_comparator_count
  from public.management_pattern_candidate_properties p
  where p.organization_id = p_organization_id
    and p.candidate_id = p_candidate_id
    and p.occurrence_role = 'comparator';

  if v_affected_count = 0 then
    raise exception 'a projectable candidate needs at least one affected property'
      using errcode = '23514';
  end if;
  if v_candidate.classified_scope = 'property_local'
    and (v_affected_count <> 1 or v_comparator_count <> 0) then
    raise exception 'property_local scope requires one affected property and no comparator'
      using errcode = '23514';
  end if;
  if v_candidate.classified_scope = 'peer_cohort' and v_comparator_count = 0 then
    raise exception 'peer_cohort scope requires at least one comparator property'
      using errcode = '23514';
  end if;
  if v_candidate.classified_scope in ('group_region','company_wide')
    and v_affected_count < 2 then
    raise exception '% scope requires at least two affected properties', v_candidate.classified_scope
      using errcode = '23514';
  end if;

  insert into public.management_pattern_projection_locks (
    organization_id, semantic_family, root_key
  ) values (
    p_organization_id, v_candidate.semantic_family, v_candidate.root_key
  ) on conflict (organization_id, semantic_family, root_key) do nothing;
  perform 1
  from public.management_pattern_projection_locks l
  where l.organization_id = p_organization_id
    and l.semantic_family = v_candidate.semantic_family
    and l.root_key = v_candidate.root_key
  for update;

  select f.* into v_finding
  from public.company_findings f
  where f.organization_id = p_organization_id
    and f.status in ('open','updated','known_problem','muted')
    and (
      (f.semantic_family = v_candidate.semantic_family and f.root_key = v_candidate.root_key)
      or (
        f.semantic_family is null and f.root_key is null
        and f.dedupe_key = v_candidate.projection_dedupe_key
      )
    )
  order by
    case when f.semantic_family = v_candidate.semantic_family
      and f.root_key = v_candidate.root_key then 1 else 0 end desc,
    f.last_seen_at desc
  limit 1
  for update;
  v_has_finding := found;

  if not v_has_finding then
    insert into public.company_findings (
      organization_id, detector_id, dedupe_key, summary, severity, disposition,
      status, receipt_query_id, evidence, as_of, weakest_input_age_days,
      magnitude, price_low_cents, price_high_cents, price_currency, price_basis,
      first_seen_at, last_seen_at, occurrence_count, status_changed_at,
      latest_pattern_run_id, latest_pattern_candidate_id,
      latest_pattern_effective_at, latest_pattern_order_key,
      semantic_family, root_key, classified_scope,
      affected_property_ids, routing_metadata, quality_metadata,
      pattern_schema_version, pattern_engine_version, pattern_check_version,
      pattern_cohort_policy_version, pattern_normalization_policy_version,
      pattern_dedupe_policy_version, pattern_scope_policy_version
    ) values (
      p_organization_id, v_check_id, v_candidate.projection_dedupe_key,
      v_candidate.summary, v_candidate.severity, v_candidate.disposition,
      'open', v_candidate.receipt_query_id, v_candidate.evidence,
      v_candidate.effective_at, v_candidate.weakest_input_age_days,
      v_candidate.magnitude, v_candidate.price_low_cents, v_candidate.price_high_cents,
      coalesce(v_candidate.price_currency_code, 'USD'), v_candidate.price_basis,
      v_candidate.effective_at, v_candidate.effective_at, 1, v_now,
      v_candidate.run_id, v_candidate.id, v_candidate.effective_at,
      v_candidate.candidate_hash,
      v_candidate.semantic_family, v_candidate.root_key, v_candidate.classified_scope,
      v_affected_property_ids, v_candidate.routing_metadata, v_candidate.quality_metadata,
      v_candidate.candidate_schema_version, v_engine_version, v_check_version,
      v_cohort_policy_version, v_normalization_policy_version,
      v_dedupe_policy_version, v_scope_policy_version
    )
    returning id into finding_id;
    outcome := 'opened';
    return next;
    return;
  end if;

  if v_finding.latest_pattern_candidate_id = v_candidate.id then
    return query select 'already_projected'::text, v_finding.id;
    return;
  end if;
  if v_candidate.effective_at < coalesce(
    v_finding.latest_pattern_effective_at, v_finding.last_seen_at
  ) then
    return query select 'stale_backfill'::text, v_finding.id;
    return;
  end if;
  if v_candidate.effective_at = coalesce(
    v_finding.latest_pattern_effective_at, v_finding.last_seen_at
  ) then
    if v_finding.latest_pattern_order_key = v_candidate.candidate_hash then
      return query select 'equivalent_projection'::text, v_finding.id;
      return;
    end if;
    if v_finding.latest_pattern_order_key is not null
      and v_candidate.candidate_hash < v_finding.latest_pattern_order_key then
      return query select 'stale_tie_break'::text, v_finding.id;
      return;
    end if;
    -- Replacing a same-instant lower ordering key changes the deterministic
    -- winner but is not another temporal occurrence.
    v_occurrence_increment := 0;
  end if;

  if v_finding.status = 'muted' then
    v_new_status := 'muted';
    v_new_disposition := v_finding.disposition;
    v_projection_outcome := 'suppressed_muted';
  elsif v_finding.status = 'known_problem' then
    v_escalated :=
      v_candidate.escalation_factor is not null
      and v_finding.silenced_at_magnitude is not null
      and v_candidate.magnitude >= v_finding.silenced_at_magnitude * v_candidate.escalation_factor
      and v_candidate.magnitude - v_finding.silenced_at_magnitude >= v_candidate.escalation_min_delta;
    if v_escalated then
      v_new_status := 'updated';
      v_new_disposition := v_candidate.disposition;
      v_projection_outcome := 'escalated';
    else
      v_new_status := 'known_problem';
      v_new_disposition := v_finding.disposition;
      v_projection_outcome := 'suppressed_known_problem';
    end if;
  else
    v_new_status := case
      when v_finding.status = 'updated'
        or v_finding.summary is distinct from v_candidate.summary
        or v_finding.magnitude is distinct from v_candidate.magnitude
      then 'updated'
      else 'open'
    end;
    v_new_disposition := v_candidate.disposition;
    v_projection_outcome := case when v_new_status = 'updated' then 'updated' else 'refreshed' end;
  end if;

  update public.company_findings f
  set detector_id = v_check_id,
      dedupe_key = v_candidate.projection_dedupe_key,
      summary = v_candidate.summary,
      severity = v_candidate.severity,
      disposition = v_new_disposition,
      status = v_new_status,
      receipt_query_id = v_candidate.receipt_query_id,
      evidence = v_candidate.evidence,
      as_of = v_candidate.effective_at,
      weakest_input_age_days = v_candidate.weakest_input_age_days,
      magnitude = v_candidate.magnitude,
      price_low_cents = v_candidate.price_low_cents,
      price_high_cents = v_candidate.price_high_cents,
      price_currency = coalesce(v_candidate.price_currency_code, f.price_currency),
      price_basis = v_candidate.price_basis,
      last_seen_at = greatest(f.last_seen_at, v_candidate.effective_at),
      occurrence_count = f.occurrence_count + v_occurrence_increment,
      status_changed_at = case
        when f.status is distinct from v_new_status then v_now else f.status_changed_at end,
      escalated_at = case when v_escalated then v_now else f.escalated_at end,
      latest_pattern_run_id = v_candidate.run_id,
      latest_pattern_candidate_id = v_candidate.id,
      latest_pattern_effective_at = v_candidate.effective_at,
      latest_pattern_order_key = v_candidate.candidate_hash,
      semantic_family = v_candidate.semantic_family,
      root_key = v_candidate.root_key,
      classified_scope = v_candidate.classified_scope,
      affected_property_ids = v_affected_property_ids,
      routing_metadata = v_candidate.routing_metadata,
      quality_metadata = v_candidate.quality_metadata,
      pattern_schema_version = v_candidate.candidate_schema_version,
      pattern_engine_version = v_engine_version,
      pattern_check_version = v_check_version,
      pattern_cohort_policy_version = v_cohort_policy_version,
      pattern_normalization_policy_version = v_normalization_policy_version,
      pattern_dedupe_policy_version = v_dedupe_policy_version,
      pattern_scope_policy_version = v_scope_policy_version
  where f.organization_id = p_organization_id and f.id = v_finding.id
  returning f.id into finding_id;

  outcome := v_projection_outcome;
  return next;
end
$$;

-- One bounded projection boundary for an entire sealed run. Present/emit
-- candidates are projected in deterministic root order. Only explicit
-- successful-normal `absent` reconciliation rows resolve an active pattern;
-- suppressed-present and abstained rows deliberately leave it untouched.
create or replace function public.project_management_pattern_run(
  p_organization_id uuid,
  p_run_id uuid
)
returns table (
  outcome text,
  candidate_projection_count integer,
  resolved_count integer,
  details jsonb
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_run public.management_pattern_runs%rowtype;
  v_candidate record;
  v_projection record;
  v_reconciliation public.management_pattern_reconciliations%rowtype;
  v_finding public.company_findings%rowtype;
  v_details jsonb := '[]'::jsonb;
  v_projected integer := 0;
  v_resolved integer := 0;
  v_candidate_total integer;
begin
  raise exception 'active management-pattern projection is disabled for this shadow schema'
    using errcode = '0A000';

  select r.* into v_run
  from public.management_pattern_runs r
  where r.organization_id = p_organization_id and r.id = p_run_id;
  if not found then
    raise exception 'run is outside organization scope or absent' using errcode = '42501';
  end if;
  if v_run.status <> 'succeeded' then
    raise exception 'only a succeeded sealed run may be batch-projected' using errcode = '55000';
  end if;
  if v_run.projection_mode <> 'active'
    or v_run.triggered_by not in ('scheduled','manual') then
    raise exception 'run is evidence-only and not authorized for active projection'
      using errcode = '42501';
  end if;

  select count(*)::integer into v_candidate_total
  from public.management_pattern_candidates c
  where c.organization_id = p_organization_id and c.run_id = p_run_id;
  if v_candidate_total > 500 then
    raise exception 'run candidate projection exceeds fixed 500-row budget'
      using errcode = '54000';
  end if;
  if exists (
    select 1
    from public.management_pattern_candidates c
    where c.organization_id = p_organization_id
      and c.run_id = p_run_id and c.decision = 'emit'
    group by c.semantic_family, c.root_key
    having count(*) > 1
  ) then
    raise exception 'sealed run contains more than one emitted candidate for a semantic root'
      using errcode = '23514';
  end if;

  for v_candidate in
    select c.id, c.semantic_family, c.root_key
    from public.management_pattern_reconciliations reconciliation
    join public.management_pattern_candidates c
      on c.organization_id = reconciliation.organization_id
     and c.run_id = reconciliation.run_id
     and c.id = reconciliation.candidate_id
    where reconciliation.organization_id = p_organization_id
      and reconciliation.run_id = p_run_id
      and reconciliation.conclusion = 'present'
      and c.decision = 'emit'
    order by c.semantic_family, c.root_key, c.candidate_hash, c.id
  loop
    select p.outcome, p.finding_id into v_projection
    from public.project_management_pattern_candidate(
      p_organization_id, v_candidate.id
    ) p;
    v_projected := v_projected + 1;
    v_details := v_details || jsonb_build_array(jsonb_build_object(
      'kind', 'candidate',
      'candidate_id', v_candidate.id,
      'semantic_family', v_candidate.semantic_family,
      'root_key', v_candidate.root_key,
      'outcome', v_projection.outcome,
      'finding_id', v_projection.finding_id
    ));
  end loop;

  for v_reconciliation in
    select rec.*
    from public.management_pattern_reconciliations rec
    where rec.organization_id = p_organization_id
      and rec.run_id = p_run_id
      and rec.conclusion = 'absent'
    order by rec.semantic_family, rec.root_key, rec.reconciliation_hash, rec.id
  loop
    insert into public.management_pattern_projection_locks(
      organization_id, semantic_family, root_key
    ) values (
      p_organization_id, v_reconciliation.semantic_family, v_reconciliation.root_key
    ) on conflict (organization_id, semantic_family, root_key) do nothing;

    perform 1
    from public.management_pattern_projection_locks l
    where l.organization_id = p_organization_id
      and l.semantic_family = v_reconciliation.semantic_family
      and l.root_key = v_reconciliation.root_key
    for update;

    select f.* into v_finding
    from public.company_findings f
    where f.organization_id = p_organization_id
      and f.semantic_family = v_reconciliation.semantic_family
      and f.root_key = v_reconciliation.root_key
      and f.status in ('open','updated','known_problem','muted')
    limit 1
    for update;

    if not found then
      v_details := v_details || jsonb_build_array(jsonb_build_object(
        'kind', 'reconciliation',
        'reconciliation_id', v_reconciliation.id,
        'outcome', 'no_active_finding'
      ));
      continue;
    end if;

    -- Equality is conservative: a present receipt at the same effective
    -- instant wins over absence rather than allowing arrival order to clear it.
    if v_reconciliation.effective_at <= coalesce(
      v_finding.latest_pattern_effective_at, v_finding.last_seen_at
    ) then
      v_details := v_details || jsonb_build_array(jsonb_build_object(
        'kind', 'reconciliation',
        'reconciliation_id', v_reconciliation.id,
        'outcome', 'stale_or_equal_absence',
        'finding_id', v_finding.id
      ));
      continue;
    end if;

    update public.company_findings f
    set status = 'resolved',
        resolved_at = v_reconciliation.effective_at,
        status_changed_at = clock_timestamp(),
        quality_metadata = f.quality_metadata || jsonb_build_object(
          'latest_reconciliation', jsonb_build_object(
            'id', v_reconciliation.id,
            'run_id', v_reconciliation.run_id,
            'effective_at', v_reconciliation.effective_at,
            'hash', v_reconciliation.reconciliation_hash,
            'evidence', v_reconciliation.evidence
          )
        )
    where f.organization_id = p_organization_id and f.id = v_finding.id;
    v_resolved := v_resolved + 1;
    v_details := v_details || jsonb_build_array(jsonb_build_object(
      'kind', 'reconciliation',
      'reconciliation_id', v_reconciliation.id,
      'outcome', 'resolved',
      'finding_id', v_finding.id
    ));
  end loop;

  return query select 'projected'::text, v_projected, v_resolved, v_details;
end
$$;

-- ---------------------------------------------------------------------------
-- Bounded, read-only portfolio finding producer.
-- ---------------------------------------------------------------------------

-- This is deliberately an evidence-plane read, not a projection read.  It
-- chooses one immutable finalized epoch and returns only the graph necessary
-- for the application mapper to build the versioned portfolio-finding DTO.
-- It never calls either projection RPC and cannot activate company_findings.
create or replace function public.load_management_pattern_portfolio_findings_source(
  p_scope_receipt_id uuid,
  p_account_id uuid,
  p_as_of timestamptz,
  p_max_findings integer default 40
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_run public.management_pattern_runs%rowtype;
  v_assertion jsonb;
  v_receipt jsonb;
  v_organization_id uuid;
  v_authorized uuid[];
  v_selected uuid[];
  v_authorized_property_count integer;
  v_selected_property_count integer;
  v_authorization_hash text;
  v_scope_hash text;
  v_receipt_expires_at timestamptz;
  v_valid_through timestamptz;
  v_status text;
  v_run_receipt jsonb;
  v_run_coverage jsonb;
  v_candidates jsonb := '[]'::jsonb;
  v_available integer := 0;
begin
  if p_scope_receipt_id is null or p_account_id is null or p_as_of is null then
    raise exception 'scope receipt, account, and as_of are required' using errcode = '22023';
  end if;
  if p_as_of > statement_timestamp() + interval '5 minutes' then
    raise exception 'portfolio finding as_of is in the future' using errcode = '22023';
  end if;
  if p_max_findings is null or p_max_findings < 1 or p_max_findings > 40 then
    raise exception 'max findings must be between 1 and 40' using errcode = '22023';
  end if;
  -- The nested assertion re-derives the complete selector result while holding
  -- its account/organization authorization rows FOR SHARE through this outer
  -- statement. No caller-supplied organization or property array exists at
  -- this SECURITY DEFINER boundary.
  v_assertion := public.staxis_assert_authorization_scope_receipt(
    p_scope_receipt_id,
    p_account_id
  );
  if coalesce((v_assertion->>'ok')::boolean, false) is not true then
    return jsonb_build_object(
      'schema_version', 1,
      'scope_receipt_id', p_scope_receipt_id,
      'account_id', p_account_id,
      'organization_id', null,
      'selected_property_ids', '[]'::jsonb,
      'authorized_property_count', null,
      'authorization_hash', null,
      'scope_hash', null,
      'scope_receipt_expires_at', null,
      'selection_was_truncated', false,
      'as_of', p_as_of,
      'max_findings', p_max_findings,
      'status', 'authorization_refused',
      'authorization_reason', coalesce(v_assertion->>'reason', 'store_unavailable'),
      'projection_mode', null,
      'run', null,
      'available_candidate_count', 0,
      'candidates', '[]'::jsonb
    );
  end if;
  v_receipt := v_assertion->'receipt';
  begin
    v_organization_id := (v_receipt->>'organizationId')::uuid;
    v_authorized_property_count := (v_receipt->>'authorizedPropertyCount')::integer;
    v_selected_property_count := (v_receipt->>'selectedPropertyCount')::integer;
    v_authorization_hash := v_receipt->>'authorizationHash';
    v_scope_hash := v_receipt->>'scopeHash';
    v_receipt_expires_at := (v_receipt->>'expiresAt')::timestamptz;
    select array_agg(property_id::uuid order by property_id::uuid)
      into v_selected
    from jsonb_array_elements_text(v_receipt->'propertyIds') property_id;
    select array_agg(property_id::uuid order by property_id::uuid)
      into v_authorized
    from jsonb_array_elements_text(v_receipt->'authorizedPropertyIds') property_id;
  exception when others then
    raise exception 'authorization scope assertion returned a malformed receipt'
      using errcode = '23514';
  end;
  if (v_receipt->>'id') is distinct from p_scope_receipt_id::text
    or (v_receipt->>'accountId') is distinct from p_account_id::text
    or v_organization_id is null
    or v_authorized is null
    or v_authorized_property_count is distinct from cardinality(v_authorized)
    or v_selected_property_count is distinct from cardinality(v_selected)
    or (v_selected <@ v_authorized) is not true
    or to_jsonb(v_selected) is distinct from v_receipt->'propertyIds'
    or to_jsonb(v_authorized) is distinct from v_receipt->'authorizedPropertyIds'
    or (v_authorization_hash ~ '^[0-9a-f]{64}$') is not true
    or (v_scope_hash ~ '^[0-9a-f]{64}$') is not true
    or (v_receipt_expires_at > statement_timestamp()) is not true
    or v_selected is null
    or cardinality(v_selected) < 1
    or cardinality(v_selected) is distinct from (
      select count(distinct selected_id)::integer from unnest(v_selected) selected_id
    )
    or cardinality(v_authorized) is distinct from (
      select count(distinct authorized_id)::integer from unnest(v_authorized) authorized_id
    ) then
    raise exception 'authorization scope assertion returned an inconsistent receipt'
      using errcode = '23514';
  end if;
  if cardinality(v_selected) > 250 then
    return jsonb_build_object(
      'schema_version', 1,
      'scope_receipt_id', p_scope_receipt_id,
      'account_id', p_account_id,
      'organization_id', v_organization_id,
      'selected_property_ids', '[]'::jsonb,
      'authorized_property_count', v_authorized_property_count,
      'authorization_hash', v_authorization_hash,
      'scope_hash', v_scope_hash,
      'scope_receipt_expires_at', v_receipt_expires_at,
      'selection_was_truncated', false,
      'as_of', p_as_of,
      'max_findings', p_max_findings,
      'status', 'scope_too_large',
      'authorization_reason', null,
      'projection_mode', null,
      'run', null,
      'available_candidate_count', 0,
      'candidates', '[]'::jsonb
    );
  end if;

  -- A failed or in-flight newer attempt is not evidence of resolution.  The
  -- newest finalized nonfailed epoch remains usable only through the explicit
  -- weekly validity horizon.  A newer all-abstained epoch blocks older claims.
  select run.*
    into v_run
  from public.management_pattern_runs run
  join public.management_pattern_result_batches batch
    on batch.organization_id = run.organization_id
   and batch.run_id = run.id
   and batch.run_fencing_token = run.fencing_token
  where run.organization_id = v_organization_id
    and run.status in ('succeeded', 'abstained')
    and run.evaluation_at <= p_as_of
    and run.completed_at <= p_as_of
  order by (run.projection_mode = 'active') desc,
           run.evaluation_at desc, run.completed_at desc, run.id desc
  limit 1;

  if not found then
    return jsonb_build_object(
      'schema_version', 1,
      'scope_receipt_id', p_scope_receipt_id,
      'account_id', p_account_id,
      'organization_id', v_organization_id,
      'selected_property_ids', to_jsonb(v_selected),
      'authorized_property_count', v_authorized_property_count,
      'authorization_hash', v_authorization_hash,
      'scope_hash', v_scope_hash,
      'scope_receipt_expires_at', v_receipt_expires_at,
      'selection_was_truncated', false,
      'as_of', p_as_of,
      'max_findings', p_max_findings,
      'status', 'no_finalized_run',
      'authorization_reason', null,
      'projection_mode', null,
      'run', null,
      'available_candidate_count', 0,
      'candidates', '[]'::jsonb
    );
  end if;

  -- Fixed elapsed horizon: PostgreSQL day intervals follow session-local DST
  -- for timestamptz, while the application contract is exactly 192 hours.
  v_valid_through := v_run.evaluation_at + interval '192 hours';
  with selected_rows as (
    select property.eligibility_status, property.exclusion_codes
    from public.management_pattern_run_properties property
    where property.organization_id = v_organization_id
      and property.run_id = v_run.id
      and property.property_id = any(v_selected)
  ), exclusion_counts as (
    select exclusion_code, count(*)::integer as occurrence_count
    from selected_rows selected
    cross join lateral unnest(selected.exclusion_codes) exclusion_code
    group by exclusion_code
  ), ranked_exclusions as (
    select exclusion.*,
           row_number() over (
             order by exclusion.occurrence_count desc, exclusion.exclusion_code
           ) as rank,
           count(*) over ()::integer as total_count
    from exclusion_counts exclusion
  )
  select jsonb_build_object(
    'selected_property_count', cardinality(v_selected),
    'snapshot_property_count', (select count(*)::integer from selected_rows),
    'included_property_count', (
      select count(*)::integer from selected_rows where eligibility_status = 'included'
    ),
    'excluded_property_count', (
      select count(*)::integer from selected_rows where eligibility_status = 'excluded'
    ),
    'missing_from_run_count', cardinality(v_selected) - (select count(*)::integer from selected_rows),
    'exclusion_reasons', coalesce((
      select jsonb_agg(
        jsonb_build_object('code', exclusion_code, 'count', occurrence_count)
        order by rank
      ) filter (where rank <= 50)
      from ranked_exclusions
    ), '[]'::jsonb),
    'exclusion_reason_code_count', coalesce((select max(total_count) from ranked_exclusions), 0),
    'exclusion_reasons_truncated', coalesce((
      select max(total_count) > 50 from ranked_exclusions
    ), false)
  ) into v_run_coverage;
  v_run_receipt := jsonb_build_object(
    'id', v_run.id,
    'projection_mode', v_run.projection_mode,
    'engine_version', v_run.engine_version,
    'evidence_schema_version', v_run.evidence_schema_version,
    'cohort_policy_version', v_run.cohort_policy_version,
    'normalization_policy_version', v_run.normalization_policy_version,
    'dedupe_policy_version', v_run.dedupe_policy_version,
    'scope_policy_version', v_run.scope_policy_version,
    'input_hash', v_run.input_hash,
    'portfolio_snapshot_hash', v_run.portfolio_snapshot_hash,
    'evaluation_at', v_run.evaluation_at,
    'source_as_of', v_run.source_as_of,
    'window_start', v_run.window_start,
    'window_end', v_run.window_end,
    'completed_at', v_run.completed_at,
    'terminal_status', v_run.status,
    'source_query_id', v_run.input_manifest->>'source_query_id',
    'source_query_version', v_run.input_manifest->>'source_query_version',
    'valid_through', v_valid_through,
    'coverage', v_run_coverage
  );

  if v_run.projection_mode = 'shadow' then
    v_status := 'shadow_only';
  elsif v_valid_through <= p_as_of then
    v_status := 'stale';
  elsif v_run.status = 'abstained' then
    v_status := 'abstained';
  elsif (v_run_coverage->>'missing_from_run_count')::integer > 0 then
    -- The current selector contains a hotel that was not in this immutable
    -- run. Never reinterpret an old scope/company-wide claim against a larger
    -- post-transfer portfolio.
    v_status := 'incomplete_scope';
  else
    v_status := 'loaded';
  end if;

  if v_status = 'loaded' then
    with eligible_candidates as (
      select
        candidate.id,
        candidate.candidate_hash,
        candidate.root_key,
        candidate.semantic_family,
        candidate.classified_scope,
        candidate.scope_evidence,
        candidate.summary,
        candidate.decision,
        candidate.receipt_query_id,
        candidate.effective_at,
        candidate.materiality_score,
        candidate.quality_metadata->'portfolio_claim_receipt' as claim_receipt,
        reconciliation.reconciliation_hash,
        reconciliation.conclusion as reconciliation_conclusion,
        properties.eligible_property_ids,
        properties.evaluated_property_ids,
        properties.affected_property_ids,
        detectors.detector_receipts,
        metrics.metric_receipts,
        source_queries.source_query_receipts
      from public.management_pattern_candidates candidate
      join public.management_pattern_reconciliations reconciliation
        on reconciliation.organization_id = candidate.organization_id
       and reconciliation.run_id = candidate.run_id
       and reconciliation.candidate_id = candidate.id
       and reconciliation.semantic_family = candidate.semantic_family
       and reconciliation.root_key = candidate.root_key
       and reconciliation.conclusion = 'present'
      join lateral (
        select
          array_agg(property.property_id order by property.property_id)
              as eligible_property_ids,
          array_agg(property.property_id order by property.property_id)
            filter (where property.occurrence_role in ('affected', 'comparator'))
              as evaluated_property_ids,
          array_agg(property.property_id order by property.property_id)
            filter (where property.occurrence_role = 'affected')
              as affected_property_ids,
          bool_and(
            property.occurrence_role = 'excluded'
            or property.property_id = any(v_selected)
          ) as selected_scope_contains_evidence
        from public.management_pattern_candidate_properties property
        where property.organization_id = candidate.organization_id
          and property.run_id = candidate.run_id
          and property.candidate_id = candidate.id
      ) properties on properties.evaluated_property_ids is not null
        and properties.affected_property_ids is not null
        and properties.selected_scope_contains_evidence
      join lateral (
        select jsonb_agg(
          jsonb_build_object('id', version_set.check_id, 'versions', to_jsonb(version_set.versions))
          order by version_set.check_id
        ) as detector_receipts
        from (
          select outcome.check_id,
                 array_agg(distinct outcome.check_version order by outcome.check_version) as versions
          from public.management_pattern_candidate_outcomes candidate_outcome
          join public.management_pattern_check_outcomes outcome
            on outcome.organization_id = candidate_outcome.organization_id
           and outcome.run_id = candidate_outcome.run_id
           and outcome.id = candidate_outcome.check_outcome_id
          where candidate_outcome.organization_id = candidate.organization_id
            and candidate_outcome.run_id = candidate.run_id
            and candidate_outcome.candidate_id = candidate.id
          group by outcome.check_id
        ) version_set
      ) detectors on detectors.detector_receipts is not null
      join lateral (
        select jsonb_agg(
          jsonb_build_object('id', version_set.metric_key, 'versions', to_jsonb(version_set.versions))
          order by version_set.metric_key
        ) as metric_receipts
        from (
          select observation.metric_key,
                 array_agg(distinct observation.metric_version order by observation.metric_version) as versions
          from public.management_pattern_candidate_outcomes candidate_outcome
          join public.management_pattern_check_observations observation_link
            on observation_link.organization_id = candidate_outcome.organization_id
           and observation_link.run_id = candidate_outcome.run_id
           and observation_link.check_outcome_id = candidate_outcome.check_outcome_id
          join public.management_pattern_metric_observations observation
            on observation.organization_id = observation_link.organization_id
           and observation.run_id = observation_link.run_id
           and observation.id = observation_link.observation_id
          where candidate_outcome.organization_id = candidate.organization_id
            and candidate_outcome.run_id = candidate.run_id
            and candidate_outcome.candidate_id = candidate.id
          group by observation.metric_key
        ) version_set
      ) metrics on metrics.metric_receipts is not null
      join lateral (
        select jsonb_agg(
          jsonb_build_object('id', version_set.query_id, 'versions', to_jsonb(version_set.versions))
          order by version_set.query_id
        ) as source_query_receipts
        from (
          select query_version.query_id,
                 array_agg(distinct query_version.query_version order by query_version.query_version) as versions
          from public.management_pattern_candidate_outcomes candidate_outcome
          join public.management_pattern_check_observations observation_link
            on observation_link.organization_id = candidate_outcome.organization_id
           and observation_link.run_id = candidate_outcome.run_id
           and observation_link.check_outcome_id = candidate_outcome.check_outcome_id
          join public.management_pattern_metric_observations observation
            on observation.organization_id = observation_link.organization_id
           and observation.run_id = observation_link.run_id
           and observation.id = observation_link.observation_id
          cross join lateral (
            select observation.source_query_id as query_id,
                   observation.source_query_version as query_version
            union
            select observation.denominator_source_query_id,
                   observation.denominator_source_query_version
            where observation.denominator_source_query_id is not null
              and observation.denominator_source_query_version is not null
            union
            select observation.currency_conversion_source_query_id,
                   observation.currency_conversion_source_query_version
            where observation.currency_conversion_source_query_id is not null
              and observation.currency_conversion_source_query_version is not null
          ) query_version
          where candidate_outcome.organization_id = candidate.organization_id
            and candidate_outcome.run_id = candidate.run_id
            and candidate_outcome.candidate_id = candidate.id
          group by query_version.query_id
        ) version_set
      ) source_queries on source_queries.source_query_receipts is not null
      where candidate.organization_id = v_organization_id
        and candidate.run_id = v_run.id
        and candidate.decision = 'emit'
        and candidate.classified_scope is not null
        and jsonb_typeof(candidate.scope_evidence->'eligiblePropertyIds') = 'array'
        and jsonb_array_length(candidate.scope_evidence->'eligiblePropertyIds') > 0
        and not exists (
          select 1
          from jsonb_array_elements_text(
            candidate.scope_evidence->'eligiblePropertyIds'
          ) eligible_property(property_id)
          where not exists (
            select 1
            from unnest(v_selected) selected_property(property_id)
            where selected_property.property_id::text = eligible_property.property_id
          )
        )
    ), ranked_candidates as (
      select eligible.*,
             row_number() over (
               order by eligible.materiality_score desc,
                        cardinality(eligible.affected_property_ids) desc,
                        eligible.candidate_hash,
                        eligible.id
             ) as rank,
             count(*) over ()::integer as total_count
      from eligible_candidates eligible
    )
    select
      coalesce(max(ranked.total_count), 0)::integer,
      coalesce(
        jsonb_agg(
          jsonb_build_object(
            'candidate_id', ranked.id,
            'candidate_hash', ranked.candidate_hash,
            'root_key', ranked.root_key,
            'semantic_family', ranked.semantic_family,
            'classified_scope', ranked.classified_scope,
            'scope_evidence', ranked.scope_evidence,
            'summary', ranked.summary,
            'decision', ranked.decision,
            'receipt_query_id', ranked.receipt_query_id,
            'effective_at', ranked.effective_at,
            'materiality_score', ranked.materiality_score::double precision,
            'claim_receipt', ranked.claim_receipt,
            'reconciliation_hash', ranked.reconciliation_hash,
            'reconciliation_conclusion', ranked.reconciliation_conclusion,
            'detector_receipts', ranked.detector_receipts,
            'eligible_property_ids', to_jsonb(ranked.eligible_property_ids),
            'evaluated_property_ids', to_jsonb(ranked.evaluated_property_ids),
            'affected_property_ids', to_jsonb(ranked.affected_property_ids),
            'metric_receipts', ranked.metric_receipts,
            'source_query_receipts', ranked.source_query_receipts
          ) order by ranked.rank
        ) filter (where ranked.rank <= p_max_findings),
        '[]'::jsonb
      )
      into v_available, v_candidates
    from ranked_candidates ranked;

    if v_available = 0 then
      v_status := 'no_applicable_findings';
    end if;
  end if;

  if v_status <> 'loaded' then
    -- Preserve versions, validity and selected-scope coverage for observability
    -- without exposing organization-wide run identity or evidence hashes.
    v_run_receipt := v_run_receipt || jsonb_build_object(
      'id', null,
      'input_hash', null,
      'portfolio_snapshot_hash', null
    );
  end if;

  return jsonb_build_object(
    'schema_version', 1,
    'scope_receipt_id', p_scope_receipt_id,
    'account_id', p_account_id,
    'organization_id', v_organization_id,
    'selected_property_ids', to_jsonb(v_selected),
    'authorized_property_count', v_authorized_property_count,
    'authorization_hash', v_authorization_hash,
    'scope_hash', v_scope_hash,
    'scope_receipt_expires_at', v_receipt_expires_at,
    'selection_was_truncated', false,
    'as_of', p_as_of,
    'max_findings', p_max_findings,
    'status', v_status,
    'authorization_reason', null,
    'projection_mode', v_run.projection_mode,
    'run', v_run_receipt,
    'available_candidate_count', v_available,
    'candidates', v_candidates
  );
end
$$;

-- ---------------------------------------------------------------------------
-- Service-role-only access and explicit browser denial.
-- ---------------------------------------------------------------------------

do $$
declare
  v_table text;
  v_policy text;
begin
  foreach v_table in array array[
    'management_pattern_property_profiles',
    'management_pattern_runs',
    'management_pattern_run_locks',
    'management_pattern_run_properties',
    'management_pattern_cohorts',
    'management_pattern_cohort_members',
    'management_pattern_metric_observations',
    'management_pattern_metric_source_facts',
    'management_pattern_check_outcomes',
    'management_pattern_check_observations',
    'management_pattern_candidates',
    'management_pattern_candidate_outcomes',
    'management_pattern_candidate_properties',
    'management_pattern_candidate_local_instances',
    'management_pattern_run_roots',
    'management_pattern_reconciliations',
    'management_pattern_reconciliation_outcomes',
    'management_pattern_result_batches',
    'management_pattern_projection_locks'
  ] loop
    v_policy := left(v_table, 49) || '_deny_browser';
    execute format('alter table public.%I enable row level security', v_table);
    execute format('revoke all on table public.%I from public, anon, authenticated', v_table);
    execute format('revoke all on table public.%I from service_role', v_table);
    execute format('grant select on table public.%I to service_role', v_table);
    execute format('drop policy if exists %I on public.%I', v_policy, v_table);
    execute format(
      'create policy %I on public.%I for all to anon, authenticated using (false) with check (false)',
      v_policy, v_table
    );
  end loop;
end
$$;

-- Profiles are the only direct-write configuration table in this plane. Runs,
-- inputs, derived evidence, reconciliations, and projection locks are writable
-- only through their owner/fence-CAS SECURITY DEFINER functions.
grant insert on table public.management_pattern_property_profiles to service_role;

revoke all on function public.claim_management_pattern_run(
  uuid,text,uuid,text,integer,text,text,text,text,text,jsonb,text,
  timestamptz,timestamptz,timestamptz,timestamptz,timestamptz,
  text,text,jsonb,integer,uuid,jsonb,
  integer,bigint,bigint,integer,integer
) from public, anon, authenticated;
grant execute on function public.claim_management_pattern_run(
  uuid,text,uuid,text,integer,text,text,text,text,text,jsonb,text,
  timestamptz,timestamptz,timestamptz,timestamptz,timestamptz,
  text,text,jsonb,integer,uuid,jsonb,
  integer,bigint,bigint,integer,integer
) to service_role;

revoke all on function public.heartbeat_management_pattern_run(
  uuid,uuid,uuid,bigint,integer
) from public, anon, authenticated;
grant execute on function public.heartbeat_management_pattern_run(
  uuid,uuid,uuid,bigint,integer
) to service_role;

revoke all on function public.finalize_management_pattern_run(
  uuid,uuid,uuid,bigint,text,
  integer,integer,integer,integer,integer,integer,integer,
  integer,integer,integer,integer,integer,integer,integer,
  bigint,bigint,bigint,integer,integer,jsonb,jsonb,jsonb,jsonb
) from public, anon, authenticated;
grant execute on function public.finalize_management_pattern_run(
  uuid,uuid,uuid,bigint,text,
  integer,integer,integer,integer,integer,integer,integer,
  integer,integer,integer,integer,integer,integer,integer,
  bigint,bigint,bigint,integer,integer,jsonb,jsonb,jsonb,jsonb
) to service_role;

revoke all on function public.append_management_pattern_input_batch(
  uuid,uuid,uuid,bigint,jsonb,jsonb,jsonb
) from public, anon, authenticated;
grant execute on function public.append_management_pattern_input_batch(
  uuid,uuid,uuid,bigint,jsonb,jsonb,jsonb
) to service_role;

revoke all on function public.append_management_pattern_result_batch(
  uuid,uuid,uuid,bigint,jsonb
) from public, anon, authenticated;
grant execute on function public.append_management_pattern_result_batch(
  uuid,uuid,uuid,bigint,jsonb
) to service_role;

revoke all on function public.load_management_pattern_portfolio_findings_source(
  uuid,uuid,timestamptz,integer
) from public, anon, authenticated;
grant execute on function public.load_management_pattern_portfolio_findings_source(
  uuid,uuid,timestamptz,integer
) to service_role;

revoke all on function public.project_management_pattern_candidate(uuid,uuid)
  from public, anon, authenticated, service_role;

revoke all on function public.project_management_pattern_run(uuid,uuid)
  from public, anon, authenticated, service_role;

-- Trigger helpers are not an API surface.
revoke all on function public.staxis_reject_management_pattern_evidence_update()
  from public, anon, authenticated;
revoke all on function public.staxis_validate_management_pattern_profile_insert()
  from public, anon, authenticated;
revoke all on function public.staxis_validate_management_pattern_run_property_snapshot()
  from public, anon, authenticated;
revoke all on function public.staxis_guard_management_pattern_parent_delete()
  from public, anon, authenticated;
revoke all on function public.staxis_require_management_pattern_run_fence()
  from public, anon, authenticated;
revoke all on function public.staxis_guard_management_pattern_run_update()
  from public, anon, authenticated;
revoke all on function public.staxis_validate_management_pattern_candidate()
  from public, anon, authenticated;
revoke all on function public.staxis_validate_management_pattern_candidate_outcome()
  from public, anon, authenticated;
revoke all on function public.staxis_validate_management_pattern_reconciliation()
  from public, anon, authenticated;
revoke all on function public.staxis_validate_management_pattern_run_root()
  from public, anon, authenticated;
revoke all on function public.staxis_validate_management_pattern_reconciliation_outcome()
  from public, anon, authenticated;
revoke all on function public.staxis_validate_management_pattern_source_fact()
  from public, anon, authenticated;
revoke all on function public.staxis_validate_management_pattern_local_finding()
  from public, anon, authenticated;

comment on table public.management_pattern_runs is
  'Durable management-company pattern run receipt: exact versioned inputs and portfolio snapshot, leased/fenced execution ownership, quality/cost/performance counters, and terminal status. Terminal rows are immutable. Added 0392.';
comment on column public.management_pattern_runs.input_hash is
  'Bare lowercase 64-hex SHA-256 digest. Callers using a prefixed fingerprint representation must strip/validate the prefix before persistence.';
comment on table public.management_pattern_run_properties is
  'Exact organization/property topology and profile snapshot used by one run. A trigger proves tenant pairing from the authoritative current row or canonical nearest audit receipt at topology_as_of; rows are fenced and append-only. Added 0392.';
comment on table public.management_pattern_cohorts is
  'Immutable cohort definition/version/hash and explicit viability, fallback, or abstention decision for one run. Added 0392.';
comment on table public.management_pattern_metric_observations is
  'Immutable raw and normalized management-pattern metric receipt, including units/currency, denominator, aligned local/UTC windows, completeness/freshness, and reproducible source query/watermark/hash. Added 0392.';
comment on table public.management_pattern_metric_source_facts is
  'Append-only, run-fenced, service-readable exact source rows behind inventory-purchase aggregate observations. Canonical payloads and database-computed SHA-256 receipts make aggregate inputs replayable without consulting mutable operational tables. Added 0392.';
comment on table public.management_pattern_candidates is
  'Immutable deterministic candidate. semantic_family + root_key is portfolio issue identity; classified_scope is evidence scope, not query scope or authorization. confidence_kind prevents a threshold score from masquerading as probability. Added 0392.';
comment on column public.management_pattern_candidates.confidence is
  'Bounded evidence/threshold score whose semantics are mandatory in confidence_kind; never implicitly a probability.';
comment on table public.management_pattern_candidate_local_instances is
  'Many local manifestations may contribute to one consolidated candidate/property. Each deterministic instance is tenant/run/property paired; optional public.findings links are trigger-validated at their exact occurrence instant.';
comment on function public.append_management_pattern_result_batch(uuid,uuid,uuid,bigint,jsonb) is
  'One transactional derived-result batch per run. Canonical JSON hash provides exact retry idempotency; a changed retry conflicts and no partial derived rows survive.';
comment on function public.load_management_pattern_portfolio_findings_source(uuid,uuid,timestamptz,integer) is
  'Service-role-only, bounded read of one active finalized management-pattern evidence epoch. Organization and exact selected-property scope are derived atomically from an account-bound authorization receipt; shadow evidence returns no claims and the function never activates the mutable finding projection.';
comment on function public.project_management_pattern_candidate(uuid,uuid) is
  'Reserved single-candidate projector. This shadow migration raises feature-not-supported before any read or write; active projection requires a separate reviewed cutover migration.';
comment on function public.project_management_pattern_run(uuid,uuid) is
  'Reserved run projector. This shadow migration raises feature-not-supported before any read or write; it cannot activate, clear, or mutate company_findings.';

insert into public.applied_migrations (version, description)
values (
  '0392',
  'Management-company Finding Patterns shadow v2 evidence plane: database-timestamped append-only comparison profiles; bounded scheduled/backfill lineage; leased/fenced durable runs with exact version-2 portfolio snapshots and quality/cost/performance receipts; immutable target/rung cohort coverage, raw+normalized metric, deterministic check/candidate, and candidate-property occurrence evidence. Active projection is database-disabled. Service-role-only with explicit browser deny policies.'
)
on conflict (version) do nothing;

notify pgrst, 'reload schema';
