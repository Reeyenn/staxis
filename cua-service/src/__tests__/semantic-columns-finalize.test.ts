/**
 * feature/cua-semantic-columns — authoring + adapter wiring (no browser).
 *
 *   1. finalizeRecoveredSuccess authors `parse.hint.columnsTiered` /
 *      `rowSelectorTiered` from the header row captured during the audit —
 *      ALONGSIDE (never instead of) the flat `columns`. No header / spanning
 *      header / blanked / non-positional columns get NO anchor (positional-only,
 *      byte-identical legacy shape).
 *   2. recipe-adapter forwards those anchors onto the runtime source — typed
 *      (source.columnsTiered / selectorsTiered) AND mirrored into source.extra
 *      (the only field the template-runner→FeedSpec bridge forwards), so the
 *      dom_table reader actually receives them. Legacy hints stay untiered.
 */

import './ws-polyfill.js';
import './_bootstrap-env.js';

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { finalizeRecoveredSuccess, type PageAudit } from '../mapper.js';
import { actionRecipeToTableTemplate } from '../recipe-adapter.js';
import type { CapturedTableHeaders } from '../extractors/dom-rows.js';
import type { ActionRecipe } from '../types.js';

const cleanHeaders = (): CapturedTableHeaders => ({
  cells: [
    { index: 1, text: 'room', raw: 'Room' },
    { index: 2, text: 'guest', raw: 'Guest' },
    { index: 3, text: 'status', raw: 'Status' },
  ],
  roleKind: 'cell',
  hasSpan: false,
  headerChildCount: 3,
  bodyChildCount: 3,
});

const auditWith = (over: Partial<PageAudit>): PageAudit => ({
  verified: true,
  pageUrl: 'https://pms.example/feed',
  probeRows: [],
  totalMatched: 0,
  outstanding: new Map(),
  problems: [],
  ...over,
});

const successWith = (columns: Record<string, string>) => ({
  ok: true as const,
  action: {
    steps: [],
    parse: { mode: 'table' as const, hint: { rowSelector: 'tbody tr', columns } },
  },
});

const tieredOf = (action: ActionRecipe) =>
  action.parse.mode === 'table' ? action.parse.hint.columnsTiered : undefined;
const rowTieredOf = (action: ActionRecipe) =>
  action.parse.mode === 'table' ? action.parse.hint.rowSelectorTiered : undefined;

describe('finalizeRecoveredSuccess — header anchor authoring', () => {
  test('authors columnsTiered (roleName+css) + rowSelectorTiered from captured headers', () => {
    const out = finalizeRecoveredSuccess({
      success: successWith({ room: 'td:nth-child(1)', guest: 'td:nth-child(2)', status: 'td:nth-child(3)' }),
      audit: auditWith({ headers: cleanHeaders() }),
    });
    const tiered = tieredOf(out.action);
    assert.ok(tiered);
    assert.deepEqual(tiered!.room, { roleName: { role: 'cell', name: 'Room' }, css: 'td:nth-child(1)' });
    assert.deepEqual(tiered!.guest, { roleName: { role: 'cell', name: 'Guest' }, css: 'td:nth-child(2)' });
    assert.deepEqual(tiered!.status, { roleName: { role: 'cell', name: 'Status' }, css: 'td:nth-child(3)' });
    assert.deepEqual(rowTieredOf(out.action), { css: 'tbody tr' });
    // Flat columns ALWAYS still present (back-compat).
    const cols = out.action.parse.mode === 'table' ? out.action.parse.hint.columns : {};
    assert.equal(cols.room, 'td:nth-child(1)');
  });

  test('NO headers captured → NO tiered shape (legacy/byte-identical)', () => {
    const out = finalizeRecoveredSuccess({
      success: successWith({ room: 'td:nth-child(1)' }),
      audit: auditWith({}), // headers undefined
    });
    assert.equal(tieredOf(out.action), undefined);
    assert.equal(rowTieredOf(out.action), undefined);
  });

  test('spanning header (gate fails) → NO tiered shape', () => {
    const out = finalizeRecoveredSuccess({
      success: successWith({ room: 'td:nth-child(1)' }),
      audit: auditWith({ headers: { ...cleanHeaders(), hasSpan: true } }),
    });
    assert.equal(tieredOf(out.action), undefined);
  });

  test('header/body cell-count mismatch (gate fails) → NO tiered shape', () => {
    const out = finalizeRecoveredSuccess({
      success: successWith({ room: 'td:nth-child(1)' }),
      audit: auditWith({ headers: { ...cleanHeaders(), bodyChildCount: 4 } }),
    });
    assert.equal(tieredOf(out.action), undefined);
  });

  test('blanked (dead) + non-positional columns get NO anchor; positional ones do', () => {
    const out = finalizeRecoveredSuccess({
      success: successWith({
        room: 'td:nth-child(1)',     // positional → anchored
        note: '.note-cell',          // non-positional → no anchor
        status: 'td:nth-child(3)',   // will be blanked as dead → no anchor
      }),
      audit: auditWith({ headers: cleanHeaders(), outstanding: new Map([['status', 'dead']]) }),
    });
    const tiered = tieredOf(out.action);
    assert.ok(tiered);
    assert.ok(tiered!.room, 'positional column anchored');
    assert.equal(tiered!.note, undefined, 'class selector → no anchor');
    assert.equal(tiered!.status, undefined, 'blanked dead column → no anchor');
  });
});

describe('recipe-adapter — tiered forwarding onto the runtime source', () => {
  const withTiered: ActionRecipe = {
    steps: [{ kind: 'goto', url: 'https://pms.example/arrivals' }],
    parse: {
      mode: 'table',
      hint: {
        rowSelector: 'tbody tr',
        columns: { pms_reservation_id: 'td:nth-child(1)', guest_name: 'td:nth-child(2)' },
        columnsTiered: {
          pms_reservation_id: { roleName: { role: 'cell', name: 'Conf #' }, css: 'td:nth-child(1)' },
          guest_name: { roleName: { role: 'cell', name: 'Guest' }, css: 'td:nth-child(2)' },
        },
        rowSelectorTiered: { css: 'tbody tr' },
      },
    },
  };

  test('typed source.columnsTiered/selectorsTiered AND extra mirror are populated', () => {
    const t = actionRecipeToTableTemplate('getArrivals', withTiered);
    assert.ok(t);
    const src = t!.sources[0]!;
    // Typed (contract / future consumers).
    assert.equal(src.columnsTiered?.pms_reservation_id?.roleName?.name, 'Conf #');
    assert.equal(src.selectorsTiered?.rowSelector?.css, 'tbody tr');
    // extra mirror (what the dom_table reader actually reads through the bridge).
    const extraTiered = src.extra?.columnsTiered as Record<string, unknown> | undefined;
    assert.ok(extraTiered);
    assert.ok(extraTiered!.guest_name);
    assert.deepEqual(src.extra?.rowSelectorTiered, { css: 'tbody tr' });
    // Flat columns untouched.
    assert.equal(src.columns?.pms_reservation_id, 'td:nth-child(1)');
  });

  test('legacy hint (no columnsTiered) → source stays fully untiered (back-compat)', () => {
    const legacy: ActionRecipe = {
      steps: [{ kind: 'goto', url: 'https://pms.example/arrivals' }],
      parse: { mode: 'table', hint: { rowSelector: 'tbody tr', columns: { guest_name: 'td:nth-child(2)' } } },
    };
    const t = actionRecipeToTableTemplate('getArrivals', legacy);
    assert.ok(t);
    const src = t!.sources[0]!;
    assert.equal(src.columnsTiered, undefined);
    assert.equal(src.selectorsTiered, undefined);
    assert.equal(src.extra?.columnsTiered, undefined);
    assert.equal(src.extra?.rowSelectorTiered, undefined);
  });
});

describe('finalizeRecoveredSuccess — visual-state founder-review routing', () => {
  // A visual-state-recovered enum column is authored in `columns` (the css@attr
  // selector) + `enumMappings`, and flagged via audit.uncertain (NOT outstanding).
  // finalize must KEEP the selector AND mark it unprovenRequiredColumns so the
  // promotion gate parks the feed for one founder glance (Repaired auto, pending).
  test('auto-learned column keeps its @attr selector AND is flagged for founder review', () => {
    const success = {
      ok: true as const,
      action: {
        steps: [],
        parse: {
          mode: 'table' as const,
          hint: {
            rowSelector: 'tbody tr',
            columns: { room_number: 'td:nth-child(1)', status: 'td:nth-child(6)@tablesort_sortvalue' },
          },
        },
      },
      enumMappings: { status: { C: 'clean', D: 'dirty' } },
    };
    const audit = auditWith({ uncertain: new Set(['status']) });
    const out = finalizeRecoveredSuccess({ success, audit });
    assert.equal(out.action.parse.mode, 'table');
    if (out.action.parse.mode !== 'table') return;
    // selector kept, not blanked
    assert.equal(out.action.parse.hint.columns.status, 'td:nth-child(6)@tablesort_sortvalue');
    // value map carried into the recipe
    assert.deepEqual(out.enumMappings?.status, { C: 'clean', D: 'dirty' });
    // flagged for founder review (the promotion gate parks on this)
    assert.deepEqual(
      (out.action as ActionRecipe & { unprovenRequiredColumns?: string[] }).unprovenRequiredColumns,
      ['status'],
    );
  });
});
