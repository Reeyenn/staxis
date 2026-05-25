/**
 * Behavior tests for the email renderer. Asserts:
 *   - Subject line matches the expected format for both daily + weekly
 *   - HTML body contains key metrics (so a future refactor that drops a
 *     section is caught)
 *   - Plain-text fallback contains the same metrics in readable form
 *   - Both English and Spanish render successfully
 *   - HTML escaping kicks in on property names that contain HTML
 *
 * No DB I/O — pure rendering tests.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { renderDailyReport, renderWeeklyReport } from '@/lib/reports/email-template';
import type { DailyReportPayload, WeeklyReportPayload } from '@/lib/reports/types';

function makeDaily(overrides: Partial<DailyReportPayload> = {}): DailyReportPayload {
  return {
    propertyId: 'p1',
    propertyName: overrides.propertyName ?? 'Beachfront Inn',
    reportDate: '2026-05-23',
    timezone: 'America/Chicago',
    operations: {
      roomsCleanedToday: 18, totalRoomsOnBoard: 22,
      roomsOOO: 1, roomsOOS: 0,
      occupancyPct: 75,
      avgMinutesPerDeparture: 32, avgMinutesPerStayover: 18, avgMinutesPerDeepClean: 95,
      roomsPerHousekeeper: 6,
    },
    quality: {
      inspectionsCompleted: 10, inspectionsPassed: 9,
      passRatePct: 90,
      reclearRequestedCount: 1, reclearRatePct: 10,
      topFailureReasons: [{ reason: 'Mirror smudges', count: 3 }, { reason: 'Towels low', count: 2 }],
    },
    labor: {
      totalHoursWorked: 24, totalOvertimeHours: 2,
      costPerOccupiedRoomCents: 1200, laborCostCents: 30_000,
      laborBudgetCents: 50_000,
      sickCalloutsToday: 1,
    },
    issues: {
      workOrdersCreatedToday: 3,
      urgentItemsStillPending: 1,
    },
    tomorrow: {
      arrivals: 12, departures: 10, projectedRoomsToClean: 14,
      recommendedHeadcount: 3, recommendedLaborCostCents: 24_000,
      roomsPendingOOO: 1, roomsPendingInspection: 0,
    },
    anomalies: [{ kind: 'callout_spike', message: 'Three sick callouts today' }],
    dashboardUrl: 'https://getstaxis.com/housekeeping',
    ...overrides,
  };
}

function makeWeekly(): WeeklyReportPayload {
  return {
    propertyId: 'p1',
    propertyName: 'Beachfront Inn',
    reportDate: '2026-05-24',           // Sunday
    weekStartDate: '2026-05-18',        // Monday
    timezone: 'America/Chicago',
    operations: {
      roomsCleanedToday: 120, totalRoomsOnBoard: 154,
      roomsOOO: 1, roomsOOS: 0,
      occupancyPct: 72,
      avgMinutesPerDeparture: 33, avgMinutesPerStayover: 19, avgMinutesPerDeepClean: 90,
      roomsPerHousekeeper: 5.5,
    },
    quality: {
      inspectionsCompleted: 70, inspectionsPassed: 64,
      passRatePct: 91.4,
      reclearRequestedCount: 6, reclearRatePct: 8.6,
      topFailureReasons: [{ reason: 'Mirror smudges', count: 12 }],
    },
    labor: {
      totalHoursWorked: 168, totalOvertimeHours: 8,
      costPerOccupiedRoomCents: 1450, laborCostCents: 174_000,
      laborBudgetCents: 50_000,
      sickCalloutsToday: 4,
    },
    issues: {
      workOrdersCreatedToday: 14,
      urgentItemsStillPending: 2,
    },
    nextWeek: {
      projectedArrivals: 80, projectedDepartures: 75,
      projectedRoomsToClean: 96,
      recommendedHeadcount: 3,
    },
    trends: [
      { metric: 'rooms_cleaned',              thisWeek: 120,     priorWeek: 112,    deltaPct: 7.1 },
      { metric: 'labor_cost_cents',           thisWeek: 174_000, priorWeek: 168_000, deltaPct: 3.6 },
      { metric: 'inspection_pass_rate_pct',   thisWeek: 91.4,    priorWeek: 88,     deltaPct: 3.9 },
      { metric: 'callouts',                   thisWeek: 4,       priorWeek: 2,      deltaPct: 100 },
    ],
    topPerformer: { staffId: 'maria', name: 'Maria', roomsCleaned: 32, avgMinutesPerRoom: 28, inspectionPassRatePct: 95 },
    improvementOpportunity: { staffId: 'rosa', name: 'Rosa', roomsCleaned: 20, avgMinutesPerRoom: 35, inspectionPassRatePct: 78 },
    insightText: 'Strong week overall — pass rate ticked up and rooms-per-housekeeper trended slightly higher than last week. Watch the sick callouts (doubled vs prior week) and the recurring mirror-smudge inspection issue.',
    anomalies: [],
    dashboardUrl: 'https://getstaxis.com/housekeeping',
  };
}

describe('renderDailyReport — English', () => {
  test('subject line uses property name + date long form', () => {
    const { subject } = renderDailyReport({ payload: makeDaily(), lang: 'en' });
    assert.match(subject, /Beachfront Inn/);
    assert.match(subject, /Daily Housekeeping/);
    // "Sat, May 23" or similar depending on locale's short weekday format.
    assert.match(subject, /May 23/);
  });

  test('html body contains the operational metrics', () => {
    const { html } = renderDailyReport({ payload: makeDaily(), lang: 'en' });
    assert.match(html, /18 \/ 22/);                     // rooms cleaned today
    assert.match(html, /75%/);                          // occupancy
    assert.match(html, /Mirror smudges \(3\)/);         // top failure reason
    assert.match(html, /Three sick callouts today/);    // anomaly message
    assert.match(html, /View full dashboard/);
  });

  test('plain-text fallback mirrors the html', () => {
    const { text } = renderDailyReport({ payload: makeDaily(), lang: 'en' });
    assert.match(text, /Beachfront Inn/);
    assert.match(text, /18 \/ 22/);
    assert.match(text, /Recommended headcount: 3/);
    assert.match(text, /https:\/\/getstaxis\.com\/housekeeping/);
  });
});

describe('renderDailyReport — Spanish', () => {
  test('subject line uses Spanish header', () => {
    const { subject } = renderDailyReport({ payload: makeDaily(), lang: 'es' });
    assert.match(subject, /Reporte diario/);
  });

  test('html body uses Spanish section names', () => {
    const { html } = renderDailyReport({ payload: makeDaily(), lang: 'es' });
    assert.match(html, /Operaciones/);
    assert.match(html, /Ocupación/);
    assert.match(html, /Calidad/);
    assert.match(html, /Mano de obra/);
  });
});

describe('renderDailyReport — HTML escaping', () => {
  test('escapes property names that contain HTML', () => {
    const payload = makeDaily({ propertyName: '<script>alert(1)</script>Inn' });
    const { html, subject } = renderDailyReport({ payload, lang: 'en' });
    // The escaped form appears; the raw <script> does NOT.
    assert.ok(html.includes('&lt;script&gt;'));
    assert.ok(!html.includes('<script>alert'));
    // Subject is not HTML-escaped (it's a plain header), but mustn't contain
    // CR/LF that the resend wrapper would reject.
    assert.ok(!/[\r\n]/.test(subject));
  });
});

describe('renderWeeklyReport', () => {
  test('renders the insight block at the top when present', () => {
    const { html } = renderWeeklyReport({ payload: makeWeekly(), lang: 'en' });
    assert.match(html, /Week at a glance/);
    assert.match(html, /Strong week overall/);
  });

  test('renders trend rows for each metric', () => {
    const { html } = renderWeeklyReport({ payload: makeWeekly(), lang: 'en' });
    assert.match(html, /Trends vs prior week/);
    assert.match(html, /\+7\.1%/);
    assert.match(html, /\+3\.6%/);
  });

  test('omits insight block when null', () => {
    const payload = makeWeekly();
    payload.insightText = null;
    const { html } = renderWeeklyReport({ payload, lang: 'en' });
    assert.ok(!html.includes('Week at a glance'));
  });

  test('renders top performer + improvement opportunity', () => {
    const { html } = renderWeeklyReport({ payload: makeWeekly(), lang: 'en' });
    assert.match(html, /Maria/);
    assert.match(html, /Rosa/);
  });

  test('Spanish weekly subject uses "Semana del"', () => {
    const { subject } = renderWeeklyReport({ payload: makeWeekly(), lang: 'es' });
    assert.match(subject, /Reporte semanal/);
    assert.match(subject, /Semana del/);
  });
});
