process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://placeholder.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'placeholder-service-role-key-min-20-chars';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'placeholder-anon-key-min-20-chars';

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  buildInventoryMonthlyAccountingView,
  inventoryShelfEvidence,
  resolveInventoryAccountingMonth,
} from '@/lib/agent/tools/inventory-monthly-accounting';
import {
  executeTool,
  getTool,
  type ToolContext,
} from '@/lib/agent/tools';
import '@/lib/agent/tools/index';
import { INVENTORY_ACCOUNTING_ROUTING_PROMPT } from '@/lib/agent/prompts';
import { EVAL_CASES } from '@/lib/agent/evals/test-bank';

const PID = 'property-inventory-accounting';

function toolContext(role: ToolContext['user']['role'], propertyAccess: string[]): ToolContext {
  return {
    user: {
      uid: 'user-1',
      accountId: 'account-1',
      username: 'manager',
      displayName: 'Manager',
      role,
      propertyAccess,
    },
    propertyId: PID,
    staffId: null,
    requestId: 'request-1',
    surface: 'chat',
  };
}

const categoryRows = [
  {
    category: 'housekeeping' as const,
    receiptsValue: 140,
    actualUsageValue: 180,
    budgetCents: 16_000,
    remainingCents: -2_000,
  },
  {
    category: 'maintenance' as const,
    receiptsValue: 60,
    actualUsageValue: 70,
    budgetCents: 8_000,
    remainingCents: 1_000,
  },
  {
    category: 'breakfast' as const,
    receiptsValue: 40,
    actualUsageValue: 50,
    budgetCents: 3_500,
    remainingCents: -1_500,
  },
];

describe('get_inventory_monthly_accounting registration and routing', () => {
  test('is read-only, Inventory-scoped, and finance-capability gated', () => {
    const tool = getTool('get_inventory_monthly_accounting');
    assert.ok(tool);
    assert.equal(tool.section, 'inventory');
    assert.equal(tool.requiresCapability, 'view_financials');
    assert.deepEqual(tool.allowedRoles, ['admin', 'owner', 'general_manager']);
    assert.notEqual(tool.mutates, true);
    assert.equal(tool.approval, undefined);
    assert.match(tool.description, /housekeeping inventory budget/i);
    assert.match(tool.description, /immutable closed-month evidence/i);
  });

  test('central role and property gates refuse access before any accounting read', async () => {
    const lineStaff = await executeTool(
      'get_inventory_monthly_accounting',
      {},
      toolContext('housekeeping', [PID]),
    );
    assert.equal(lineStaff.ok, false);
    assert.match(lineStaff.error ?? '', /role|allowed/i);

    const wrongProperty = await executeTool(
      'get_inventory_monthly_accounting',
      {},
      toolContext('owner', []),
    );
    assert.equal(wrongProperty.ok, false);
    assert.match(wrongProperty.error ?? '', /property access/i);
  });

  test('prompt and eval bank route inventory budgets away from checkbook budgets', () => {
    assert.match(INVENTORY_ACCOUNTING_ROUTING_PROMPT, /get_inventory_monthly_accounting/);
    assert.match(INVENTORY_ACCOUNTING_ROUTING_PROMPT, /Never answer an inventory money question with/);

    const inventoryEval = EVAL_CASES.find((entry) => entry.name === 'manager_housekeeping_inventory_budget');
    const shelfEval = EVAL_CASES.find((entry) => entry.name === 'owner_shelf_value_vs_inventory_budget');
    const checkbookEval = EVAL_CASES.find((entry) => entry.name === 'manager_checkbook_housekeeping_budget');
    assert.equal(inventoryEval?.expectedTool, 'get_inventory_monthly_accounting');
    assert.equal(shelfEval?.expectedTool, 'get_inventory_monthly_accounting');
    assert.equal(checkbookEval?.expectedTool, 'check_budget_status');

    assert.match(getTool('check_budget_status')?.description ?? '', /CHECKBOOK EXPENSE/i);
    assert.match(getTool('check_budget_status')?.description ?? '', /get_inventory_monthly_accounting/);
  });
});

describe('inventory accounting month and shelf evidence', () => {
  test('uses the hotel calendar rather than the server/browser month', () => {
    const instant = new Date('2026-08-01T02:00:00.000Z'); // still July in Chicago
    assert.equal(
      resolveInventoryAccountingMonth({ period: 'this_month' }, 'America/Chicago', instant),
      '2026-07',
    );
    assert.equal(
      resolveInventoryAccountingMonth({ period: 'last_month' }, 'America/Chicago', instant),
      '2026-06',
    );
    assert.equal(
      resolveInventoryAccountingMonth({ month: '2025-12' }, 'America/Chicago', instant),
      '2025-12',
    );
    assert.equal(
      resolveInventoryAccountingMonth({ month: 'December 2025' }, 'America/Chicago', instant),
      null,
    );
  });

  test('reports shelf value as a known minimum when stocked items lack cost', () => {
    const shelf = inventoryShelfEvidence([
      { category: 'housekeeping', current_stock: 10, unit_cost: 5 },
      { category: 'housekeeping', current_stock: 3, unit_cost: null },
      { category: 'maintenance', current_stock: 20, unit_cost: 2 },
      { category: 'housekeeping', current_stock: 0, unit_cost: null },
    ], 'housekeeping');
    assert.deepEqual(shelf, {
      knownValueDollars: 50,
      complete: false,
      missingCostItemCount: 1,
    });
  });
});

describe('inventory monthly accounting response semantics', () => {
  test('keeps shelf, purchases, immutable usage, and usage budget separate', () => {
    const view = buildInventoryMonthlyAccountingView('2026-06', 'all', {
      totals: {
        openingValue: 500,
        loggedPurchasesValue: 240,
        knownLoggedPurchasesValue: 240,
        purchasesValue: 250,
        closingValue: 450,
        actualUsageValue: 300,
        actualStatus: 'complete',
        allocation: 'itemized',
        isPartial: false,
        budgetComparisonAvailable: true,
        budgetCents: 27_500,
        remainingCents: -2_500,
        hasCustomBudgetAllocation: false,
      },
      byCategory: categoryRows,
    }, {
      knownValueDollars: 850,
      complete: true,
      missingCostItemCount: 0,
    });

    assert.equal(view.shelfValueNow.knownValue.cents, 85_000);
    assert.equal(view.shelfValueNow.budgetTreatment, 'does_not_count');
    assert.equal(view.receivedPurchases.knownValue.cents, 24_000);
    assert.equal(view.receivedPurchases.confirmedForClose?.cents, 25_000);
    assert.equal(view.receivedPurchases.budgetTreatment, 'formula_input_not_actual_usage');
    assert.equal(view.actualUsage.value?.cents, 30_000);
    assert.deepEqual(view.actualUsage.equation, {
      beginningInventory: { cents: 50_000, display: '$500.00' },
      confirmedPurchases: { cents: 25_000, display: '$250.00' },
      endingInventory: { cents: 45_000, display: '$450.00' },
    });
    assert.equal(view.actualUsage.evidence, 'immutable_month_close');
    assert.equal(view.usageBudget.value?.cents, 27_500);
    assert.equal(view.usageBudget.status, 'over');
    assert.equal(view.usageBudget.overBy?.cents, 2_500);
    assert.equal(view.usageBudget.evidence, 'immutable_close_snapshot');
  });

  test('never calls an open month over budget or substitutes purchases for usage', () => {
    const view = buildInventoryMonthlyAccountingView('2026-07', 'all', {
      totals: {
        openingValue: 500,
        loggedPurchasesValue: null,
        knownLoggedPurchasesValue: 900,
        purchasesValue: null,
        closingValue: null,
        actualUsageValue: null,
        actualStatus: 'pending',
        allocation: 'pending',
        isPartial: false,
        budgetComparisonAvailable: false,
        budgetCents: 50_000,
        remainingCents: null,
        hasCustomBudgetAllocation: false,
      },
      byCategory: categoryRows.map((row) => ({
        ...row,
        actualUsageValue: null,
        remainingCents: null,
      })),
    }, {
      knownValueDollars: 850,
      complete: false,
      missingCostItemCount: 2,
    });

    assert.equal(view.receivedPurchases.knownValue.cents, 90_000);
    assert.equal(view.receivedPurchases.complete, false);
    assert.equal(view.actualUsage.value, null);
    assert.equal(view.actualUsage.status, 'pending');
    assert.equal(view.usageBudget.comparisonAvailable, false);
    assert.equal(view.usageBudget.status, 'pending');
    assert.equal(view.usageBudget.overBy, null);
    assert.match(view.notes.join(' '), /Do not use purchases or shelf value as the actual/i);
  });

  test('does not invent a housekeeping actual from a total-only close', () => {
    const view = buildInventoryMonthlyAccountingView('2026-06', 'housekeeping', {
      totals: {
        openingValue: 500,
        loggedPurchasesValue: 240,
        knownLoggedPurchasesValue: 240,
        purchasesValue: 250,
        closingValue: 450,
        actualUsageValue: 300,
        actualStatus: 'unallocated',
        allocation: 'total_only',
        isPartial: false,
        budgetComparisonAvailable: true,
        budgetCents: 27_500,
        remainingCents: -2_500,
        hasCustomBudgetAllocation: false,
      },
      byCategory: categoryRows.map((row) => ({
        ...row,
        actualUsageValue: null,
        remainingCents: null,
      })),
    }, {
      knownValueDollars: 500,
      complete: true,
      missingCostItemCount: 0,
    });

    assert.equal(view.actualUsage.status, 'unallocated');
    assert.equal(view.actualUsage.value, null);
    assert.equal(view.usageBudget.comparisonAvailable, false);
    assert.equal(view.usageBudget.status, 'pending');
    assert.match(view.notes.join(' '), /category usage is unavailable/i);
  });

  test('still compares a total-only close at whole-inventory level', () => {
    const view = buildInventoryMonthlyAccountingView('2026-06', 'all', {
      totals: {
        openingValue: 500,
        loggedPurchasesValue: 240,
        knownLoggedPurchasesValue: 240,
        purchasesValue: 250,
        closingValue: 450,
        actualUsageValue: 300,
        actualStatus: 'unallocated',
        allocation: 'total_only',
        isPartial: false,
        budgetComparisonAvailable: true,
        budgetCents: 27_500,
        remainingCents: -2_500,
        hasCustomBudgetAllocation: false,
      },
      byCategory: categoryRows.map((row) => ({
        ...row,
        actualUsageValue: null,
        remainingCents: null,
      })),
    }, {
      knownValueDollars: 850,
      complete: true,
      missingCostItemCount: 0,
    });

    assert.equal(view.actualUsage.value?.cents, 30_000);
    assert.equal(view.actualUsage.status, 'unallocated');
    assert.equal(view.usageBudget.comparisonAvailable, true);
    assert.equal(view.usageBudget.status, 'over');
    assert.equal(view.usageBudget.overBy?.cents, 2_500);
  });
});
