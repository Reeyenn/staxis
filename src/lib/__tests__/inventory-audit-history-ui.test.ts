import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import {
  INVENTORY_AUDIT_ACTIONS,
  type InventoryAuditAction,
  type InventoryAuditEvent,
} from '@/lib/inventory-audit-history';
import type { EffectiveInventoryDelivery, InventoryOrder } from '@/types';
import {
  canCorrectEffectiveInventoryDelivery,
  inventoryAuditDeliveryRootOrderId,
  inventoryAuditMoneyFacts,
} from '@/app/inventory/_components/overlays/inventory-audit-presentation';
import {
  inventoryAuditDeliveryForActiveProperty,
  inventoryAuditMatchesProperty,
} from '@/app/inventory/_components/inventory-audit-state';

function source(...parts: string[]): string {
  return readFileSync(join(process.cwd(), 'src', ...parts), 'utf8');
}

function section(contents: string, start: string, end: string): string {
  const startIndex = contents.indexOf(start);
  const endIndex = contents.indexOf(end, startIndex + start.length);
  assert.ok(startIndex >= 0, `missing section start: ${start}`);
  assert.ok(endIndex > startIndex, `missing section end: ${end}`);
  return contents.slice(startIndex, endIndex);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const shell = source('app', 'inventory', '_components', 'InventoryShell.tsx');
const panel = source('app', 'inventory', '_components', 'overlays', 'HistoryPanel.tsx');
const panelCss = source('app', 'inventory', '_components', 'overlays', 'HistoryPanel.module.css');
const route = source('app', 'api', 'inventory', 'history', 'route.ts');
const orderDb = source('lib', 'db', 'inventory-orders.ts');
const auditPresentation = source('app', 'inventory', '_components', 'overlays', 'inventory-audit-presentation.ts');
const auditLoader = section(shell, 'const loadAuditHistory = useCallback', '// ── Honour ?action=');
const auditRequestLoader = auditLoader.slice(0, auditLoader.indexOf('  useEffect(() => {'));
const auditFirstPageSetup = section(
  auditRequestLoader,
  'const revalidatingCurrentProperty',
  '    try {',
);
const boardLoader = section(shell, 'const fetchBoardData = useCallback', 'const applyBoardData = useCallback');
const auditFeed = section(panel, 'function AuditHistoryFeed(', 'function MonthCloseDetail(');
const auditFinancials = section(
  auditPresentation,
  'export function inventoryAuditMoneyFacts(',
  '/** Audit correction events use their own immutable event id',
);
const exactDeliveryLoader = orderDb.slice(orderDb.indexOf('export async function getEffectiveInventoryDelivery('));

function auditEvent(
  action: InventoryAuditAction,
  details: Record<string, unknown> = {},
  entityId: string | null = 'delivery-root',
): InventoryAuditEvent {
  return {
    id: `event-${action}`,
    action,
    entityType: action === 'delivery.received' ? 'delivery' : 'delivery_correction',
    entityId,
    occurredAt: '2026-07-20T12:00:00.000Z',
    actorName: 'Manager',
    requestId: 'request-1',
    summary: {
      label: 'Towels', secondaryLabel: null, quantity: 5, unit: 'each',
      itemCount: 1, changedFields: [],
    },
    details,
  };
}

function effectiveDelivery(
  status: EffectiveInventoryDelivery['status'],
  propertyId = 'hotel-a',
  rootOrderId = 'delivery-root',
): EffectiveInventoryDelivery {
  const original: InventoryOrder = {
    id: rootOrderId,
    propertyId,
    itemId: 'item-a',
    itemName: 'Towels',
    quantity: 5,
    receivedAt: new Date('2026-07-20T12:00:00.000Z'),
  };
  return {
    rootOrderId,
    original,
    status,
    effectiveItemId: status === 'voided' ? null : original.itemId,
    effectiveItemName: status === 'voided' ? null : original.itemName,
    effectiveQuantity: status === 'voided' ? 0 : original.quantity,
    effectiveUnitCost: null,
    effectiveTotalCost: null,
    correctionCount: status === 'active' ? 0 : 1,
    lastCorrection: null,
  };
}

describe('inventory audit-history route wiring', () => {
  test('loads the authenticated no-store route only when History opens', () => {
    assert.match(
      auditLoader,
      /useEffect\(\(\) => \{\s*if \(overlay !== 'history' \|\| !activePropertyId\) return;\s*void loadAuditHistory\(null, false\);/,
    );
    assert.match(auditLoader, /new URLSearchParams\(\{ propertyId, limit: '50' \}\)/);
    assert.match(auditLoader, /fetchWithAuth\(`\/api\/inventory\/history\?\$\{params\.toString\(\)\}`/);
    assert.match(auditLoader, /cache: 'no-store'/);
    assert.doesNotMatch(auditLoader, /\bfetch\(/);
    assert.doesNotMatch(boardLoader, /\/api\/inventory\/history/);
    assert.match(auditLoader, /activePropertyIdRef\.current !== propertyId/);
    assert.match(auditLoader, /sequence !== auditLoadSequence\.current/);
  });

  test('appends cursor pages without overlap and exposes a busy Load older control', () => {
    assert.match(auditLoader, /if \(cursor\) params\.set\('cursor', cursor\)/);
    assert.match(
      auditLoader,
      /append\s*\? \[\.\.\.current, \.\.\.page\.events\.filter\(\(event\) => !current\.some\(\(row\) => row\.id === event\.id\)\)\]\s*: page\.events/,
    );
    assert.match(auditLoader, /setAuditNextCursor\(page\.nextCursor\)/);
    assert.match(
      shell,
      /onLoadOlder=\{\(\) => \{\s*if \(auditMatchesActiveProperty && auditNextCursor && !auditLoadingMore && !auditRefreshing\) \{\s*void loadAuditHistory\(auditNextCursor, true\);/,
    );
    assert.match(auditFeed, /\{hasMore && onLoadOlder && \(/);
    assert.match(auditFeed, /onClick=\{onLoadOlder\}/);
    assert.match(auditFeed, /disabled=\{loadingMore\}/);
    assert.match(auditFeed, /aria-busy=\{loadingMore\}/);
    assert.match(auditFeed, /loadingMore \? hp\.loadingHistory : hp\.loadOlder/);
  });

  test('falls back only without a cached page, preserves prior pages, and retries from the first page', () => {
    assert.match(auditLoader, /if \(!response\.ok\) throw new Error/);
    assert.match(auditLoader, /if \(!page\) throw new Error\('inventory history response was invalid'\)/);
    assert.match(
      auditLoader,
      /setAuditStatus\(append \|\| revalidatingCurrentProperty \? 'ready' : 'error'\)/,
    );
    assert.doesNotMatch(
      section(auditLoader, '} catch (error) {', '} finally {'),
      /setAuditEvents\(\[\]\)|setAuditNextCursor\(null\)/,
    );
    assert.match(
      shell,
      /auditEvents=\{!auditMatchesActiveProperty \? \[\] : auditStatus === 'error' \? null : auditEvents\}/,
    );
    assert.match(shell, /onRetryAudit=\{\(\) => \{ void loadAuditHistory\(null, false\); \}\}/);
    assert.match(panel, /auditEvents === null && \(/);
    assert.match(panel, /role="alert"/);
    assert.match(panel, /onClick=\{onRetryAudit\}/);
    assert.match(panel, /\{hp\.completeHistoryUnavailable\}/);
    assert.match(panel, /\{hp\.retryHistory\}/);
    assert.match(auditFeed, /role="status" aria-live="polite"/);
    // The fallback remains the pre-existing, capability-filtered recent feed.
    assert.match(panel, /historyEventsForViewer\(events, canViewFinancials\)/);
    assert.match(panel, /visibleEvents\.length === 0/);
  });

  test('rejects unknown, malformed, or partial events before they reach the feed', () => {
    const eventGuard = section(shell, 'function isInventoryAuditEvent(', 'function inventoryAuditPageFromPayload(');
    const pageGuard = section(shell, 'function inventoryAuditPageFromPayload(', 'export function InventoryShell()');
    const actionSet = section(shell, 'const INVENTORY_AUDIT_ACTION_SET', 'const INVENTORY_AUDIT_ENTITY_SET');

    for (const action of INVENTORY_AUDIT_ACTIONS) {
      assert.match(actionSet, new RegExp(`['"]${escapeRegExp(action)}['"]`));
    }
    assert.match(eventGuard, /!isRecord\(value\) \|\| !isRecord\(value\.summary\) \|\| !isRecord\(value\.details\)/);
    assert.match(eventGuard, /INVENTORY_AUDIT_ACTION_SET\.has\(value\.action/);
    assert.match(eventGuard, /INVENTORY_AUDIT_ENTITY_SET\.has\(value\.entityType/);
    assert.match(eventGuard, /isNullableString\(value\.entityId\)/);
    assert.match(eventGuard, /isNullableString\(value\.actorName\)/);
    assert.match(eventGuard, /isNullableString\(value\.requestId\)/);
    assert.match(eventGuard, /isNullableString\(summary\.label\)/);
    assert.match(eventGuard, /isNullableNumber\(summary\.quantity\)/);
    assert.match(eventGuard, /isNullableNumber\(summary\.itemCount\)/);
    assert.match(eventGuard, /summary\.changedFields\.every\(\(field\) => typeof field === 'string'\)/);
    assert.match(pageGuard, /!candidate\.events\.every\(isInventoryAuditEvent\)/);
    assert.match(pageGuard, /candidate\.nextCursor !== null[\s\S]*?typeof candidate\.nextCursor !== 'string'/);
    assert.match(auditLoader, /const page = inventoryAuditPageFromPayload\(await response\.json\(\)\)/);
    assert.match(auditLoader, /if \(!page\) throw new Error\('inventory history response was invalid'\)/);
  });

  test('treats idle as loading so the first History paint cannot show an empty result', () => {
    assert.match(
      shell,
      /auditLoading=\{!auditMatchesActiveProperty \|\| auditStatus === 'idle' \|\| auditStatus === 'loading'\}/,
    );
    assert.match(auditFeed, /if \(loading && events\.length === 0\)/);
    assert.match(auditFeed, /role="status" aria-live="polite"/);
    assert.match(auditFeed, /\{hp\.loadingHistory\}/);
  });

  test('revalidates a successful same-property page without clearing visible rows', () => {
    assert.match(
      auditFirstPageSetup,
      /auditSnapshotPropertyIdRef\.current === propertyId/,
    );
    assert.doesNotMatch(auditFirstPageSetup, /setAuditEvents\(\[\]\)/);
    assert.match(
      auditFirstPageSetup,
      /if \(!revalidatingCurrentProperty\) setAuditStatus\('loading'\)/,
    );
    assert.match(auditRequestLoader, /auditSnapshotPropertyIdRef\.current = propertyId/);
    assert.match(auditRequestLoader, /setAuditRefreshing\(revalidatingCurrentProperty\)/);
    assert.match(auditRequestLoader, /if \(!append\) setAuditRefreshing\(false\)/);
    assert.match(shell, /auditRefreshing=\{auditMatchesActiveProperty && auditRefreshing\}/);
  });
});

describe('inventory audit-history presentation contract', () => {
  test('shows the year in both the legacy fallback and complete audit feed', () => {
    assert.match(
      panel,
      /new Intl\.DateTimeFormat\(locale, \{ month: 'short', day: 'numeric', year: 'numeric', timeZone: safeTimezone \}\)/,
    );
    assert.match(
      auditFeed,
      /month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: timezone/,
    );
    assert.match(panel, /const locale = lang === 'es' \? 'es-ES' : 'en-US'/);
  });

  test('keeps every audit action labeled in both English and Spanish', () => {
    const actionTitleBlocks = [...panel.matchAll(
      /actionTitles:\s*\{([\s\S]*?)\}\s*satisfies Record<InventoryAuditAction, string>/g,
    )].map((match) => match[1]);
    assert.equal(actionTitleBlocks.length, 2);

    for (const action of INVENTORY_AUDIT_ACTIONS) {
      const label = new RegExp(`['"]${escapeRegExp(action)}['"]\\s*:`);
      assert.match(actionTitleBlocks[0], label, `missing English label for ${action}`);
      assert.match(actionTitleBlocks[1], label, `missing Spanish label for ${action}`);
    }

    assert.match(actionTitleBlocks[0], /'count\.saved': 'Saved inventory count'/);
    assert.match(actionTitleBlocks[1], /'count\.saved': 'Conteo de inventario guardado'/);
    assert.match(actionTitleBlocks[0], /'delivery\.received': 'Received delivery'/);
    assert.match(actionTitleBlocks[1], /'delivery\.received': 'Entrega recibida'/);
    assert.match(actionTitleBlocks[0], /'month\.closed': 'Closed inventory month'/);
    assert.match(actionTitleBlocks[1], /'month\.closed': 'Mes de inventario cerrado'/);
    assert.match(panel, /existingItemBaseline: 'Existing inventory item'/);
    assert.match(panel, /existingItemBaseline: 'Artículo de inventario existente'/);
    assert.match(
      panel,
      /event\.action === 'item\.created' && event\.details\.baseline === true[\s\S]*?return hp\.existingItemBaseline/,
    );
    assert.match(auditFeed, /auditEventTitle\(event, hp\)/);
    assert.match(panel, /loadOlder: 'Load older history'/);
    assert.match(panel, /loadOlder: 'Cargar historial anterior'/);
  });

  test('keeps keyboard, touch, mobile, and reduced-motion affordances', () => {
    assert.match(panelCss, /\.auditEventButton:focus-visible\s*\{[\s\S]*?outline: 2px solid #3e5c48/);
    assert.match(panelCss, /\.auditTools\s*\{\s*grid-template-columns: 1fr !important;/);
    assert.match(panelCss, /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.auditArrow\s*\{\s*transition: none !important;/);
    assert.match(auditFeed, /type="search"[\s\S]*?height: 44/);
    assert.match(auditFeed, /onClick=\{onLoadOlder\}[\s\S]*?minHeight: 44/);
  });

  test('opens with stable full-size loading geometry and a shape-matched skeleton', () => {
    assert.match(
      panel,
      /className=\{styles\.historyContent\}[\s\S]*?aria-busy=\{auditLoading \|\| auditRefreshing \|\| auditLoadingMore\}/,
    );
    assert.match(auditFeed, /return <HistoryLoadingState hp=\{hp\} \/>/);
    assert.match(auditFeed, /className=\{styles\.loadingState\} role="status" aria-live="polite"/);
    assert.match(auditFeed, /className=\{styles\.loadingVisual\} aria-hidden="true"/);
    assert.match(auditFeed, /styles\.loadingTools/);
    assert.match(auditFeed, /styles\.loadingList/);
    assert.match(auditFeed, /Array\.from\(\{ length: 7 \}/);
    assert.match(
      panelCss,
      /\.historyContent\s*\{[\s\S]*?min-height:\s*min\(700px, calc\(90vh - 120px\)\)/,
    );
    assert.match(
      panelCss,
      /@media \(max-width: 760px\)[\s\S]*?\.historyContent\s*\{[\s\S]*?min-height:\s*0/,
    );
    assert.match(
      panelCss,
      /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.skeleton::after\s*\{[\s\S]*?animation:\s*none/,
    );
  });
});

describe('inventory audit-history financial access boundary', () => {
  test('leaves financial authorization on the server and preserves existing UI gates', () => {
    assert.doesNotMatch(auditRequestLoader, /includeFinancials|view_financials|canViewFinancials/);
    assert.match(route, /const capabilityDecision = canViewFinancials\(role\)/);
    assert.match(route, /capabilityDecisionForProperty\(\{ role \}, 'view_financials', propertyId\)/);
    assert.match(route, /capabilityDecision === 'unavailable'[\s\S]*capabilityUnavailableResponse/);
    assert.match(route, /isSectionEnabled\(sectionGate\.enabledSections, 'financials'\)/);
    assert.match(route, /includeFinancials,/);
    assert.match(panel, /historyEventsForViewer\(events, canViewFinancials\)/);
    assert.match(shell, /canCorrectDeliveries=\{canManage && canViewFinancials\}/);
    assert.match(shell, /open=\{overlay === 'delivery-correction' && canManage && canViewFinancials\}/);
    // Authorized managers keep useful financial history, but the UI reads only
    // a fixed allowlist from the server-sanitized details object.
    assert.match(panel, /canViewFinancials=\{canViewFinancials\}/);
    assert.match(auditFinancials, /if \(!canViewFinancials\) return \[\]/);
    assert.match(auditFinancials, /fact\('totalCost', 'totalCost'\)/);
    assert.match(auditFinancials, /fact\('actualUsageCents', 'actualUsedValue', true\)/);
    assert.doesNotMatch(auditFinancials, /Object\.entries|JSON\.stringify/);
    assert.doesNotMatch(auditFeed, /event\.details/);
  });
});

describe('inventory audit-history property lifecycle', () => {
  test('never accepts audit rows or lookup results from a previous property', () => {
    assert.equal(inventoryAuditMatchesProperty('hotel-a', 'hotel-a'), true);
    assert.equal(inventoryAuditMatchesProperty('hotel-b', 'hotel-a'), false);
    assert.equal(inventoryAuditMatchesProperty(null, 'hotel-a'), false);

    const delivery = effectiveDelivery('active');
    assert.equal(
      inventoryAuditDeliveryForActiveProperty('hotel-a', 'hotel-a', 'delivery-root', delivery),
      delivery,
    );
    assert.equal(
      inventoryAuditDeliveryForActiveProperty('hotel-a', 'hotel-b', 'delivery-root', delivery),
      null,
    );
    assert.equal(
      inventoryAuditDeliveryForActiveProperty('hotel-a', null, 'delivery-root', delivery),
      null,
    );
    assert.equal(
      inventoryAuditDeliveryForActiveProperty('hotel-a', 'hotel-a', 'different-root', delivery),
      null,
    );
    assert.equal(
      inventoryAuditDeliveryForActiveProperty(
        'hotel-a', 'hotel-a', 'delivery-root', effectiveDelivery('active', 'hotel-b'),
      ),
      null,
    );
  });

  test('tags, invalidates, and synchronously masks audit state on property changes', () => {
    assert.match(shell, /const \[auditPropertyId, setAuditPropertyId\] = useState<string \| null>\(null\)/);
    assert.match(shell, /auditLoadSequence\.current \+= 1/);
    assert.match(shell, /auditSnapshotPropertyIdRef\.current = null/);
    assert.match(shell, /setAuditPropertyId\(uid \? activePropertyId : null\)/);
    assert.match(shell, /setAuditEvents\(\[\]\)/);
    assert.match(shell, /setAuditRefreshing\(false\)/);
    assert.match(shell, /inventoryAuditMatchesProperty\(activePropertyId, auditPropertyId\)/);
    assert.match(shell, /auditPropertyId=\{auditMatchesActiveProperty \? auditPropertyId : null\}/);
    assert.match(shell, /auditEvents=\{!auditMatchesActiveProperty \? \[\]/);
    assert.match(shell, /auditNextCursor=\{auditMatchesActiveProperty \? auditNextCursor : null\}/);
    assert.match(panel, /key=\{auditPropertyId \?\? 'no-property'\}/);
  });
});

describe('inventory audit-history delivery correction behavior', () => {
  test('allows active and already-corrected deliveries, but never a voided delivery', () => {
    assert.equal(canCorrectEffectiveInventoryDelivery(effectiveDelivery('active')), true);
    assert.equal(canCorrectEffectiveInventoryDelivery(effectiveDelivery('corrected')), true);
    assert.equal(canCorrectEffectiveInventoryDelivery(effectiveDelivery('voided')), false);
    assert.equal(canCorrectEffectiveInventoryDelivery(null), false);
  });

  test('resolves the stable root id for receipt and immutable correction events', () => {
    assert.equal(
      inventoryAuditDeliveryRootOrderId(auditEvent('delivery.received', {}, 'receipt-root')),
      'receipt-root',
    );
    assert.equal(
      inventoryAuditDeliveryRootOrderId(auditEvent(
        'delivery.corrected', { originalOrderId: 'receipt-root' }, 'correction-event-id',
      )),
      'receipt-root',
    );
    assert.equal(
      inventoryAuditDeliveryRootOrderId(auditEvent(
        'delivery.voided', { originalOrderId: 'receipt-root' }, 'void-event-id',
      )),
      'receipt-root',
    );
    assert.equal(inventoryAuditDeliveryRootOrderId(auditEvent('item.updated')), null);
  });

  test('uses an exact tenant-scoped root lookup for deliveries older than the recent list', () => {
    assert.ok(exactDeliveryLoader.startsWith('export async function getEffectiveInventoryDelivery('));
    assert.ok(
      exactDeliveryLoader.indexOf('listInventoryDeliveryCorrections(')
        < exactDeliveryLoader.indexOf(".from('inventory_orders')"),
      'financial/property correction authorization must run before the receipt lookup',
    );
    assert.match(exactDeliveryLoader, /\.eq\('property_id', pid\)/);
    assert.match(exactDeliveryLoader, /\.eq\('id', rootOrderId\)/);
    assert.match(exactDeliveryLoader, /\.eq\('entry_kind', 'receipt'\)/);
    assert.match(exactDeliveryLoader, /\.maybeSingle\(\)/);
    assert.match(auditLoader, /const requestedPropertyId = activePropertyId/);
    assert.match(auditLoader, /getEffectiveInventoryDelivery\(/);
    assert.match(auditLoader, /activePropertyIdRef\.current/);
    assert.match(auditLoader, /inventoryAuditDeliveryForActiveProperty\(/);
    assert.match(auditFeed, /inventoryAuditDeliveryRootOrderId\(event\)/);
    assert.match(auditFeed, /void resolveDelivery\(rootOrderId\)/);
    assert.match(auditFeed, /canCorrectEffectiveInventoryDelivery\(delivery\)/);
    assert.match(auditFeed, /event\.action === 'delivery\.voided' \|\| delivery\?\.status === 'voided'/);
  });

  test('discards cached exact-delivery snapshots after a successful correction or void', () => {
    assert.match(
      shell,
      /const \[auditDeliveryLookupRevision, setAuditDeliveryLookupRevision\] = useState\(0\)/,
    );
    assert.match(
      shell,
      /<HistoryPanel\s+key=\{`\$\{activePropertyId \?\? 'no-property'\}:\$\{auditDeliveryLookupRevision\}`\}/,
    );
    assert.match(
      shell,
      /<DeliveryCorrectionSheet[\s\S]*?onSaved=\{\(\) => \{\s*setAuditDeliveryLookupRevision\(\(current\) => current \+ 1\);\s*setOverlay\('history'\);\s*void refreshData\(\);\s*\}\}/,
    );
    assert.match(auditFeed, /const \[resolvedDeliveries, setResolvedDeliveries\] = useState/);
  });
});

describe('inventory audit-history corrected cost truth', () => {
  test('labels old and effective corrected totals separately without inventing unknown money', () => {
    assert.deepEqual(
      inventoryAuditMoneyFacts(auditEvent('delivery.corrected', {
        previousTotalCost: 50,
        correctedTotalCost: 35,
      }), true),
      [
        { kind: 'previousTotalCost', value: 50 },
        { kind: 'currentTotalCost', value: 35 },
      ],
    );
    assert.deepEqual(
      inventoryAuditMoneyFacts(auditEvent('delivery.corrected', {
        previousTotalCost: 50,
        correctedTotalCost: null,
      }), true),
      [{ kind: 'previousTotalCost', value: 50 }],
    );
    assert.deepEqual(
      inventoryAuditMoneyFacts(auditEvent('delivery.corrected', {}), true),
      [],
    );
  });

  test('shows a void as previous total plus a truthful zero current total', () => {
    assert.deepEqual(
      inventoryAuditMoneyFacts(auditEvent('delivery.voided', {
        previousTotalCost: 50,
        correctedTotalCost: null,
      }), true),
      [
        { kind: 'previousTotalCost', value: 50 },
        { kind: 'currentTotalCost', value: 0 },
      ],
    );
    assert.deepEqual(
      inventoryAuditMoneyFacts(auditEvent('delivery.voided', { previousTotalCost: 50 }), false),
      [],
    );
    assert.match(panel, /previousTotalCost: 'Previous total'/);
    assert.match(panel, /currentTotalCost: 'Current total'/);
    assert.match(panel, /previousTotalCost: 'Total anterior'/);
    assert.match(panel, /currentTotalCost: 'Total actual'/);
  });
});
