import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

const RAW = readFileSync(
  join(process.cwd(), 'supabase', 'migrations', '0376_authoritative_company_access.sql'),
  'utf8',
);
const SQL = RAW.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
const TRANSFER_GUARD_SQL = readFileSync(
  join(process.cwd(), 'supabase', 'migrations', '0386_active_primary_relationship_transfer_guard.sql'),
  'utf8',
).replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
const TOPOLOGY_SQL = readFileSync(
  join(process.cwd(), 'supabase', 'migrations', '0401_recursive_portfolio_access_scope.sql'),
  'utf8',
).replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');

describe('migration 0376 — authoritative company access shape', () => {
  test('stores one durable authority mode and explicit one-way legacy bridges', () => {
    assert.match(SQL, /create table if not exists public\.account_authorization_state/i);
    assert.match(SQL, /authority_mode in \('legacy', 'shadow', 'normalized'\)/i);
    assert.match(SQL, /normalized authorization cannot be downgraded/i);
    assert.match(SQL, /create table if not exists public\.account_property_authorization_bridges/i);
    assert.match(SQL, /Superseded by normalized entitlement/i);
    assert.match(SQL, /create or replace function public\.staxis_promote_shadow_authorization/i);
    assert.match(SQL, /trg_organization_memberships_00_authorization_refresh/i);
    assert.match(SQL, /trg_organization_access_grants_00_authorization_refresh/i);
  });

  test('uses only current primary owner/operator relationships and recursive descendants', () => {
    assert.match(SQL, /create or replace function public\._staxis_current_primary_property_relationships/i);
    assert.match(SQL, /count\(\*\) over \(partition by relationship\.property_id\)/i);
    assert.match(SQL, /active_primary_count = 1/i);
    assert.match(SQL, /is_primary_grouping is true[\s\S]*relationship_type in \('operator', 'owner'\)/i);
    assert.match(SQL, /with recursive[\s\S]*portfolio_grant_tree/i);
    assert.match(SQL, /join public\.portfolios child[\s\S]*child\.parent_id = tree\.portfolio_id/i);
    assert.match(SQL, /create or replace function public\._staxis_authorized_portfolio_catalog/i);
    assert.match(SQL, /create or replace function public\._staxis_account_authorized_portfolio_catalog/i);
  });

  test('stores exact full and selected sets plus two separately defined hashes', () => {
    assert.match(SQL, /authorized_property_ids\s+uuid\[\] not null/i);
    assert.match(SQL, /selected_property_ids\s+uuid\[\] not null/i);
    assert.match(SQL, /authorization_hash\s+text not null/i);
    assert.match(SQL, /scope_hash\s+text not null/i);
    const authorizationHash = SQL.slice(
      SQL.indexOf('v_authorization_hash := encode'),
      SQL.indexOf('v_scope_hash := encode'),
    );
    assert.match(authorizationHash, /authorizedPropertyIds/i);
    assert.doesNotMatch(authorizationHash, /selectorType|requestedPropertyIds|propertyIds', to_jsonb\(v_selected/i);
    assert.match(SQL, /selectionWasTruncated', false/i);
  });

  test('makes receipts immutable, browser-denied and service-RPC asserted', () => {
    assert.match(SQL, /create or replace function public\.staxis_resolve_authorization_scope/i);
    assert.match(SQL, /create or replace function public\.staxis_assert_authorization_scope_receipt/i);
    assert.match(SQL, /authorization scope receipts are immutable/i);
    assert.match(SQL, /authorization_scope_receipts_deny_browser/i);
    assert.match(SQL, /revoke all on public\.authorization_scope_receipts from public, anon, authenticated/i);
    assert.match(SQL, /revoke all on public\.authorization_scope_receipts from service_role/i);
    assert.doesNotMatch(SQL, /grant select on public\.authorization_scope_receipts to service_role/i);
    assert.doesNotMatch(SQL, /grant execute on function public\._staxis_authorization_scope_receipt_json/i);
    assert.match(SQL, /grant execute on function public\.staxis_assert_authorization_scope_receipt\(uuid, uuid\)[\s\S]*to service_role/i);
  });

  test('RLS has a mode switch rather than a legacy/normalized union', () => {
    const reach = SQL.slice(
      SQL.indexOf('create or replace function public.staxis_account_reaches_property'),
      SQL.indexOf('comment on function public.staxis_account_reaches_property'),
    );
    assert.match(reach, /state\.authority_mode in \('legacy', 'shadow'\)/i);
    assert.match(reach, /state\.authority_mode = 'normalized'/i);
    assert.match(reach, /account\.active is true/i);
    assert.match(reach, /_staxis_account_property_authorizations/i);
    assert.match(reach, /active_primary_count = 1/i);
  });

  test('serializes direct primary-window writes without rewriting existing overlap', () => {
    assert.match(
      TRANSFER_GUARD_SQL,
      /create or replace function public\._staxis_guard_primary_relationship_window_overlap/i,
    );
    assert.match(TRANSFER_GUARD_SQL, /for update/i);
    assert.match(TRANSFER_GUARD_SQL, /pg_advisory_xact_lock/i);
    assert.match(
      TRANSFER_GUARD_SQL,
      /greatest\(existing\.starts_at, new\.starts_at, v_now\)[\s\S]*least\(/i,
    );
    assert.match(
      TRANSFER_GUARD_SQL,
      /before insert or update of property_id, relationship_type,[\s\S]*is_primary_grouping, starts_at, ends_at/i,
    );
    assert.doesNotMatch(TRANSFER_GUARD_SQL, /delete from public\.organization_property_relationships/i);
  });

  test('projects service topology atomically and rejects a dual-current hotel for either company', () => {
    assert.match(
      TOPOLOGY_SQL,
      /create or replace function public\.staxis_resolve_organization_property_topology/i,
    );
    assert.match(
      TOPOLOGY_SQL,
      /count\(\*\) over \(partition by relationship\.property_id\)/i,
    );
    assert.match(TOPOLOGY_SQL, /ambiguous_row_count > 0/i);
    assert.match(TOPOLOGY_SQL, /'schemaVersion', 'organization-property-topology-v1'/i);
    assert.match(
      TOPOLOGY_SQL,
      /revoke all on function public\.staxis_resolve_organization_property_topology\([\s\S]*authenticated, service_role/i,
    );
    assert.match(
      TOPOLOGY_SQL,
      /grant execute on function public\.staxis_resolve_organization_property_topology\([\s\S]*to service_role/i,
    );
  });
});
