import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const RAW_SQL = readFileSync(
  join(process.cwd(), 'supabase', 'migrations', '0325_organization_access_foundation.sql'),
  'utf8',
);
const SQL = RAW_SQL
  .replace(/--[^\n]*/g, '')
  .replace(/\/\*[\s\S]*?\*\//g, '');

describe('migration 0325 — organization access foundation', () => {
  test('creates every normalized access table and the effective projection', () => {
    const tables = [
      'organizations',
      'organization_property_relationships',
      'portfolios',
      'portfolio_properties',
      'organization_memberships',
      'account_property_staff_links',
      'organization_access_grants',
      'organization_invitations',
      'organization_access_requests',
      'staxis_support_sessions',
      'organization_access_events',
    ];
    for (const table of tables) {
      assert.match(SQL, new RegExp(`create table if not exists public\\.${table}\\b`, 'i'));
    }
    assert.match(SQL, /create or replace view public\.organization_effective_property_access/i);
  });

  test('enforces one open primary organization per hotel and same-organization composite FKs', () => {
    assert.match(SQL, /organization_property_one_open_primary_idx[\s\S]*where is_primary_grouping and ends_at is null/i);
    assert.match(SQL, /foreign key \(portfolio_id, organization_id\)[\s\S]*references public\.portfolios\(id, organization_id\)/i);
    assert.match(SQL, /foreign key \(property_relationship_id, organization_id, property_id\)[\s\S]*references public\.organization_property_relationships\(id, organization_id, property_id\)/i);
  });

  test('keeps Staxis admins out of continuous, idempotent legacy reconciliation', () => {
    assert.match(SQL, /create or replace function public\._staxis_reconcile_legacy_organization_access/i);
    assert.match(SQL, /v_anchor\.property_id = any\(coalesce\(a\.property_access, '\{\}'::uuid\[\]\)\)/i);
    assert.match(SQL, /where a\.role <> 'admin'/i);
    assert.match(SQL, /'legacy_backfill'/i);
    assert.match(SQL, /trg_properties_reconcile_legacy_organization_access[\s\S]*after insert on public\.properties/i);
    assert.match(SQL, /trg_accounts_reconcile_legacy_organization_access[\s\S]*after insert or update of property_access, staff_id, role, active on public\.accounts/i);
    assert.match(SQL, /stale_grant\.source = 'legacy_backfill'/i);
    assert.match(SQL, /revocation_reason = 'Legacy hotel access or role changed'/i);
    assert.match(SQL, /organization\.legacy_property_id = any\([\s\S]*new\.property_access/i);
    assert.match(SQL, /stale_membership\.ended_at is null[\s\S]*surviving_grant\.status = 'active'/i);
    assert.match(SQL, /account_property_staff_links[\s\S]*is_active = false[\s\S]*deactivated_at = v_now/i);
    assert.match(SQL, /select public\._staxis_reconcile_legacy_organization_access\(null, null\)/i);
  });

  test('backfills singular staff identity without dropping accounts.staff_id', () => {
    assert.match(SQL, /join public\.staff s on s\.id = a\.staff_id/i);
    assert.match(SQL, /row_number\(\) over \(partition by s\.id/i);
    assert.match(SQL, /account_property_staff_links\.backfill_conflict/i);
    assert.doesNotMatch(SQL, /drop column\s+(if exists\s+)?staff_id/i);
  });

  test('browser roles are denied and service_role writes only through RPCs', () => {
    assert.match(RAW_SQL, /@rls:\s*service-role-only/i);
    const tables = [
      'organizations',
      'organization_property_relationships',
      'portfolios',
      'portfolio_properties',
      'organization_memberships',
      'account_property_staff_links',
      'organization_access_grants',
      'organization_invitations',
      'organization_access_requests',
      'staxis_support_sessions',
      'organization_access_events',
      'organization_access_epochs',
    ];
    for (const table of tables) {
      assert.match(SQL, new RegExp(`alter table public\\.${table} enable row level security`, 'i'));
      assert.match(SQL, new RegExp(`revoke all on public\\.${table} from public, anon, authenticated`, 'i'));
      assert.match(SQL, new RegExp(`revoke all on public\\.${table} from service_role`, 'i'));
      assert.match(SQL, new RegExp(`grant select on public\\.${table} to service_role`, 'i'));
      assert.doesNotMatch(
        SQL,
        new RegExp(`grant[^;]*(?:insert|update|delete)[^;]*on public\\.${table} to service_role`, 'i'),
      );
    }
    assert.match(SQL, /grant select on public\.organization_access_events to service_role/i);
    assert.doesNotMatch(SQL, /grant[^;]*insert[^;]*on public\.organization_access_events to service_role/i);
  });

  test('audits every access mutation in-transaction and makes events immutable', () => {
    const auditedTables = [
      'organizations',
      'organization_property_relationships',
      'portfolios',
      'portfolio_properties',
      'organization_memberships',
      'account_property_staff_links',
      'organization_access_grants',
      'organization_invitations',
      'organization_access_requests',
      'staxis_support_sessions',
    ];
    for (const table of auditedTables) {
      assert.match(
        SQL,
        new RegExp(`create trigger trg_${table}_access_audit[\\s\\S]*after insert or update or delete on public\\.${table}`, 'i'),
      );
    }
    assert.match(SQL, /trg_organization_access_events_immutable[\s\S]*before update or delete/i);
    assert.match(SQL, /organization_access_events is append-only/i);
    assert.match(SQL, /v_new - 'token_hash'/i);
  });

  test('pins search_path on every SECURITY DEFINER helper', () => {
    const matches = [...SQL.matchAll(/security\s+definer/gi)];
    assert.ok(matches.length >= 4);
    for (const match of matches) {
      assert.match(
        SQL.slice(match.index, (match.index ?? 0) + 180),
        /set\s+search_path\s*=\s*public,\s*pg_temp/i,
      );
    }
  });

  test('guards last-owner timing while keeping support sessions reserved', () => {
    assert.match(SQL, /cannot remove the final active organization owner/i);
    assert.match(SQL, /cannot suspend or remove the final active organization owner/i);
    assert.match(SQL, /old\.starts_at <= now\(\) and new\.starts_at > now\(\)/i);
    assert.match(SQL, /where o\.id = old\.organization_id and o\.status = 'active'/i);
    assert.match(SQL, /expires_at <= starts_at \+ interval '8 hours'/i);
    assert.match(SQL, /support session operator must be a Staxis administrator/i);
    assert.match(SQL, /approved_by_account_id <> operator_account_id/i);
    assert.match(RAW_SQL, /Reserved for a later break-glass workflow/i);
    const effectiveView = SQL.slice(
      SQL.search(/create or replace view public\.organization_effective_property_access/i),
      SQL.search(/alter table public\.organizations enable row level security/i),
    );
    assert.doesNotMatch(effectiveView, /staxis_support_sessions/i);
  });

  test('exposes only atomic service-role RPCs and revalidates invitations at acceptance', () => {
    const rpcs = [
      'staxis_reconcile_legacy_organization_access',
      'staxis_create_organization',
      'staxis_set_primary_property_organization',
      'staxis_grant_organization_access',
      'staxis_revoke_organization_access',
      'staxis_create_organization_invitation',
      'staxis_bootstrap_organization_leader_invitation',
      'staxis_accept_organization_invitation',
      'staxis_create_organization_access_request',
      'staxis_review_organization_access_request',
      'staxis_cancel_organization_invitation',
      'staxis_change_organization_membership_status',
    ];
    for (const rpc of rpcs) {
      assert.match(SQL, new RegExp(`create or replace function public\\.${rpc}`, 'i'));
      assert.match(SQL, new RegExp(`grant execute on function public\\.${rpc}[\\s\\S]*to service_role`, 'i'));
    }
    assert.match(SQL, /inviter no longer has authority for this profile or scope/i);
    assert.match(SQL, /v_invitation\.invited_by_account_id[\s\S]*v_invitation\.access_profile/i);
    assert.match(SQL, /organization_type <> 'single_hotel'/i);
    assert.match(SQL, /bootstrap profile must be organization_owner or organization_admin/i);
    assert.match(SQL, /decision must be approved or denied/i);
    assert.match(SQL, /v_grant_id := public\.staxis_grant_organization_access/i);
  });

  test('serializes authority checks and fails stale scopes closed', () => {
    assert.match(SQL, /create or replace function public\._staxis_lock_organization/i);
    assert.match(SQL, /pg_advisory_xact_lock/i);
    const serializedFunctions = [
      '_staxis_reconcile_legacy_organization_access',
      'staxis_set_primary_property_organization',
      'staxis_grant_organization_access',
      'staxis_revoke_organization_access',
      'staxis_create_organization_invitation',
      'staxis_bootstrap_organization_leader_invitation',
      'staxis_accept_organization_invitation',
      'staxis_create_organization_access_request',
      'staxis_review_organization_access_request',
      'staxis_cancel_organization_invitation',
      'staxis_change_organization_membership_status',
    ];
    for (const functionName of serializedFunctions) {
      const start = SQL.search(new RegExp(`create or replace function public\\.${functionName}\\b`, 'i'));
      assert.notEqual(start, -1, `${functionName} must exist`);
      const end = SQL.indexOf('$$;', start);
      assert.match(SQL.slice(start, end), /_staxis_lock_organization/i, `${functionName} must lock its organization`);
    }
    assert.match(SQL, /property_relationship_id is not distinct from v_invitation\.property_relationship_id/i);
    assert.match(SQL, /invited property relationship is no longer active/i);
    assert.match(SQL, /requested hotel relationship is no longer active/i);
    assert.match(SQL, /review_note = 'Hotel relationship ended before review'/i);
    assert.match(SQL, /locked_account\.id in \(p_account_id, v_invitation\.invited_by_account_id\)[\s\S]*for share/i);
  });

  test('makes invitation and membership lifecycle changes authoritative, auditable, and retry-safe', () => {
    const cancelStart = SQL.search(/create or replace function public\.staxis_cancel_organization_invitation\b/i);
    const cancelEnd = SQL.indexOf('$$;', cancelStart);
    const cancel = SQL.slice(cancelStart, cancelEnd);
    assert.match(cancel, /_staxis_lock_organization/i);
    assert.match(cancel, /_staxis_can_delegate_organization_access/i);
    assert.match(cancel, /status = 'revoked'[\s\S]*return false/i);
    assert.match(cancel, /organization_invitation\.cancelled[\s\S]*jsonb_build_object\('reason'/i);

    const membershipStart = SQL.search(/create or replace function public\.staxis_change_organization_membership_status\b/i);
    const membershipEnd = SQL.indexOf('$$;', membershipStart);
    const membership = SQL.slice(membershipStart, membershipEnd);
    assert.match(membership, /_staxis_lock_organization/i);
    assert.match(membership, /members cannot change their own membership status/i);
    assert.match(membership, /organization administrators cannot manage owners or peer administrators/i);
    assert.match(membership, /status = 'suspended'[\s\S]*return false/i);
    assert.match(membership, /p_action = 'resume'[\s\S]*status = 'active'[\s\S]*return false/i);
    assert.match(membership, /status = 'revoked'[\s\S]*return false/i);
    assert.match(membership, /inactive customer account cannot be resumed/i);
    assert.match(membership, /update public\.organization_access_grants[\s\S]*Membership removed:/i);
    assert.match(membership, /update public\.organization_access_requests[\s\S]*status = 'cancelled'/i);
    assert.match(membership, /organization_membership\.[\s\S]*jsonb_build_object\('reason'/i);
    assert.match(membership, /when p_action = 'resume' then 'resumed'/i);
    assert.doesNotMatch(membership, /accounts[\s\S]*property_access\s*=/i);
  });

  test('honors portfolio lifecycle and complete assignment windows', () => {
    assert.match(SQL, /holder_portfolio\.status = 'active'/i);
    assert.match(SQL, /pp\.assigned_at <= now\(\)[\s\S]*pp\.removed_at is null or pp\.removed_at > now\(\)/i);
    assert.match(SQL, /join public\.portfolios p[\s\S]*p\.status = 'active'[\s\S]*pp\.assigned_at <= now\(\)/i);
  });

  test('retires expired scopes, enforces realm separation, and is rerunnable', () => {
    assert.match(SQL, /Expired grant closed before renewal/i);
    assert.match(SQL, /expires_at <= now\(\)[\s\S]*insert into public\.organization_invitations/i);
    assert.match(SQL, /Staxis administrators cannot accept customer organization invitations/i);
    assert.match(SQL, /actor_account\.role <> 'admin'/i);
    assert.match(SQL, /bootstrap target must be an active customer organization/i);
    assert.match(SQL, /revocation reason is required/i);
    assert.match(SQL, /drop policy if exists organizations_deny_browser/i);
    assert.match(SQL, /where not exists \([\s\S]*account_property_staff_links\.backfill_conflict/i);
  });

  test('bounds scoped activity expansion to organizations without full activity scope', () => {
    const feedStart = SQL.search(/create or replace function public\.staxis_company_access_feed\b/i);
    const feedEnd = SQL.indexOf('$$;', feedStart);
    const feed = SQL.slice(feedStart, feedEnd);
    const activityStart = feed.search(/activity_properties as materialized/i);
    const activityEnd = feed.search(/scoped_relationship_target_properties as materialized/i);
    const activityExpansion = feed.slice(activityStart, activityEnd);
    const fullScopeExclusions = activityExpansion.match(
      /not exists\s*\(\s*select 1\s*from full_activity_organizations full_scope\s*where full_scope\.organization_id = grant_row\.organization_id\s*\)/gi,
    ) ?? [];

    assert.notEqual(activityStart, -1);
    assert.notEqual(activityEnd, -1);
    assert.equal(fullScopeExclusions.length, 3, 'organization, portfolio, and property arms must all skip full-scope organizations');
  });
});
