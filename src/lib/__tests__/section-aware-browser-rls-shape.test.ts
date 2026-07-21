import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

const SQL = readFileSync(
  join(process.cwd(), 'supabase/migrations/0334_section_aware_browser_rls.sql'),
  'utf8',
);

describe('section-aware browser RLS migration shape', () => {
  test('uses hardened, explicitly granted SECURITY DEFINER predicates', () => {
    for (const signature of [
      'staxis_property_section_enabled',
      'staxis_user_can_manage_equipment',
      'staxis_user_can_manage_staff',
      'staxis_user_can_manage_inventory_operations',
      'staxis_user_can_view_inventory_financials',
      'staxis_require_inventory_section',
      'staxis_save_inventory_count',
      'staxis_receive_inventory_delivery',
      'staxis_record_inventory_loss',
      'staxis_list_inventory_delivery_corrections',
      'staxis_correct_inventory_delivery',
    ]) {
      assert.match(
        SQL,
        new RegExp(
          `create or replace function public\\.${signature}[\\s\\S]*?security definer[\\s\\S]*?set search_path = public, pg_temp`,
          'i',
        ),
      );
    }
    assert.match(SQL, /revoke all on function public\.staxis_property_section_enabled\(uuid, text\)[\s\S]*from public, anon/i);
    assert.match(SQL, /grant execute on function public\.staxis_property_section_enabled\(uuid, text\)[\s\S]*to authenticated, service_role/i);
  });

  test('defaults on only for SQL-null maps or missing known keys', () => {
    assert.match(SQL, /p\.enabled_sections is null/i);
    assert.match(SQL, /jsonb_typeof\(p\.enabled_sections\) = 'object'/i);
    assert.match(SQL, /not \(p\.enabled_sections \? p_section\)/i);
    assert.match(SQL, /p\.enabled_sections -> p_section = 'true'::jsonb/i);
    assert.match(SQL, /p_section = any\(array\[[\s\S]*'maintenance'[\s\S]*'staff'[\s\S]*\]::text\[\]\)/i);
    assert.doesNotMatch(SQL, /coalesce\(p\.enabled_sections\s*->/i);
  });

  test('gates all work-order browser verbs on access, MFA, and Maintenance', () => {
    assert.match(SQL, /alter table public\.work_orders enable row level security/i);
    assert.match(
      SQL,
      /create policy work_orders_property_maintenance_rw[\s\S]*for all[\s\S]*to authenticated[\s\S]*user_owns_property\(property_id\)[\s\S]*mfa_verified_or_grace\(\)[\s\S]*staxis_property_section_enabled\(property_id, 'maintenance'\)/i,
    );
    assert.doesNotMatch(
      SQL.match(/create policy work_orders_property_maintenance_rw[\s\S]*?;/i)?.[0] ?? '',
      /a\.role|general_manager|owner|manage_equipment/i,
    );
    assert.match(SQL, /revoke all privileges on public\.work_orders from public, anon/i);
  });

  test('splits preventive reads from capability-gated mutations', () => {
    assert.match(SQL, /create policy preventive_tasks_property_maintenance_select[\s\S]*for select[\s\S]*user_owns_property\(property_id\)[\s\S]*staxis_property_section_enabled\(property_id, 'maintenance'\)/i);
    for (const verb of ['insert', 'update', 'delete']) {
      assert.match(
        SQL,
        new RegExp(`create policy preventive_tasks_manage_${verb}[\\s\\S]*staxis_user_can_manage_equipment\\(property_id\\)`, 'i'),
      );
    }
    assert.match(SQL, /o\.capability = 'manage_equipment'[\s\S]*o\.allowed = false/i);
    assert.match(SQL, /a\.role = 'staff'[\s\S]*or not exists/i);
  });

  test('adds Staff section enforcement only to roster mutations and records 0334', () => {
    assert.match(
      SQL,
      /create or replace function public\.staxis_user_can_manage_staff[\s\S]*staxis_property_section_enabled\(p_property_id, 'staff'\)[\s\S]*capability = 'manage_team'/i,
    );
    assert.doesNotMatch(SQL, /drop policy if exists staff_property_roster_select/i);
    assert.doesNotMatch(SQL, /create policy staff_property_roster_select/i);
    assert.match(SQL, /revoke insert, update, delete on public\.staff from public, anon/i);
    assert.match(SQL, /values \([\s\S]*'0334'/i);
    assert.match(SQL, /on conflict \(version\) do nothing/i);
  });

  test('gates all direct Staff scheduling reads while preserving service writes', () => {
    for (const policy of [
      'property_shift_presets_select',
      'scheduled_shifts_select',
      'time_off_requests_select',
      'week_publications_select',
    ]) {
      assert.match(
        SQL,
        new RegExp(
          `alter policy ${policy}[\\s\\S]*user_owns_property\\(property_id\\)[\\s\\S]*mfa_verified_or_grace\\(\\)[\\s\\S]*staxis_property_section_enabled\\(property_id, 'staff'\\)`,
          'i',
        ),
      );
    }
    for (const table of [
      'property_shift_presets',
      'scheduled_shifts',
      'time_off_requests',
      'week_publications',
    ]) {
      assert.match(
        SQL,
        new RegExp(`grant select, insert, update, delete on public\\.${table} to service_role`, 'i'),
      );
    }
  });

  test('uses strict Inventory state in operational and financial capability predicates', () => {
    const operations = SQL.match(
      /create or replace function public\.staxis_user_can_manage_inventory_operations[\s\S]*?\$\$;/i,
    )?.[0] ?? '';
    assert.match(operations, /staxis_property_section_enabled\(p_property_id, 'inventory'\)/i);
    assert.match(operations, /capability = 'manage_inventory_orders'[\s\S]*allowed = false/i);
    assert.match(operations, /a\.role = 'staff'[\s\S]*or not exists/i);
    assert.doesNotMatch(operations, /coalesce\(p\.enabled_sections/i);

    const financials = SQL.match(
      /create or replace function public\.staxis_user_can_view_inventory_financials[\s\S]*?\$\$;/i,
    )?.[0] ?? '';
    assert.match(financials, /staxis_property_section_enabled\(p_property_id, 'inventory'\)/i);
    assert.match(financials, /staxis_property_section_enabled\(p_property_id, 'financials'\)/i);
    assert.match(financials, /a\.role in \('owner', 'general_manager'\)/i);
    assert.match(financials, /capability = 'view_financials'[\s\S]*allowed = false/i);
    assert.doesNotMatch(financials, /coalesce\(p\.enabled_sections/i);
  });

  test('adds strict Inventory state to every active direct browser policy', () => {
    for (const policy of [
      '"owner read inventory"',
      '"owner insert inventory"',
      '"owner update inventory"',
      '"owner read inventory_counts"',
      '"owner read inventory_orders"',
      '"owner read inventory_discards"',
      '"owner read inventory_reconciliations"',
      'inventory_custom_categories_property_select',
      '"owner read inventory_rate_predictions"',
    ]) {
      assert.match(
        SQL,
        new RegExp(
          `alter policy ${policy.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*staxis_property_section_enabled\\(property_id, 'inventory'\\)`,
          'i',
        ),
      );
    }
  });

  test('wraps every authenticated atomic Inventory RPC before replay or mutation', () => {
    const rpcs = [
      'staxis_save_inventory_count',
      'staxis_receive_inventory_delivery',
      'staxis_record_inventory_loss',
      'staxis_list_inventory_delivery_corrections',
      'staxis_correct_inventory_delivery',
    ];
    assert.match(
      SQL,
      /create or replace function public\.staxis_require_inventory_section[\s\S]*staxis_property_section_enabled\(p_property_id, 'inventory'\)[\s\S]*errcode = '42501'/i,
    );
    for (const rpc of rpcs) {
      assert.match(SQL, new RegExp(`rename to ${rpc}_0334_impl`, 'i'));
      assert.match(
        SQL,
        new RegExp(
          `revoke all on function public\\.${rpc}_0334_impl[\\s\\S]*from public, anon, authenticated, service_role`,
          'i',
        ),
      );
      const wrapper = SQL.match(
        new RegExp(`create or replace function public\\.${rpc}[\\s\\S]*?\\$\\$;`, 'i'),
      )?.[0] ?? '';
      assert.match(wrapper, /perform public\.staxis_require_inventory_section\(p_property_id\)/i);
      assert.match(wrapper, new RegExp(`return public\\.${rpc}_0334_impl`, 'i'));
    }
  });
});
