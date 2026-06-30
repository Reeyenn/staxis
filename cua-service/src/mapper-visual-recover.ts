/**
 * mapper-visual-recover — the mapper-side glue for visual-state auto-learn.
 *
 * Runs at map time, AFTER the column audit, for any DEAD contract-ENUM column
 * (one whose textContent is constant/blank so the normal reader can't fill it).
 * It builds a real Claude vision labeler over the live screenshot and hands it to
 * learnVisualStateColumn, which finds + certifies a readable signal (an attribute)
 * that encodes the value. On success it returns the authorable `css@attr` selector
 * + raw→canonical value map for the caller to write into the recipe; on any doubt
 * it returns nothing (the column stays parked for founder review). PMS-agnostic.
 *
 * Cost: TWO small vision calls (learn + independent certify) per dead enum column,
 * once at learn time — logged against the job so the cost cap accounts for it. The
 * runtime then reads the learned attribute for free on every poll.
 */
import type { Page } from 'playwright';
import { anthropic, getModeConfig, type MapperModelId } from './anthropic-client.js';
import { learnVisualStateColumn, type VisionLabeler } from './visual-state-learn.js';
import { contractEnumValues, type ActionKey } from './column-recovery.js';
import { parseColumnSelector } from './extractors/dom-rows.js';
import { DISCOVERY_KEY_COLUMNS } from './oracle-verify.js';
import { logClaudeUsage } from './usage-log.js';
import { log } from './log.js';

export interface VisualRecovery {
  col: string;
  /** Authorable `css@attr` selector to write into the recipe column map. */
  selector: string;
  /** raw signal value → canonical enum token, to merge into enumMappings. */
  valueMap: Record<string, string>;
  /** Which signal was learned (telemetry / founder display). */
  via: string;
  /** Human-readable outcome line. */
  reason: string;
}

/** A single map-time Claude vision call: read the screenshot, return
 *  {keyColumn value -> canonical value} for the visible rows. Forces a tool so the
 *  output is a typed list constrained to the canonical vocabulary. */
function buildVisionLabeler(o: {
  page: Page;
  keyColName: string;
  enumValues: string[];
  model?: MapperModelId;
  propertyId?: string;
  jobId?: string | null;
  actionKey: ActionKey;
  col: string;
}): VisionLabeler {
  return async (pass) => {
    // fullPage so vision sees EVERY row the DOM gatherer reads (not just the ~13 in
    // the viewport): a viewport sample misses off-screen enum codes (→ runtime
    // stamps those rooms 'unknown') and can be single-class on grouped/sorted grids
    // (→ spurious park). (Adversarial review HIGH.)
    const b64 = (await o.page.screenshot({ type: 'png', fullPage: true })).toString('base64');
    const tool = {
      name: 'report_rows',
      description: `Report each visible data row's ${o.keyColName} and its value.`,
      input_schema: {
        type: 'object',
        properties: {
          rows: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                key: { type: 'string', description: `the ${o.keyColName} text exactly as shown` },
                value: { type: 'string', enum: o.enumValues },
              },
              required: ['key', 'value'],
            },
          },
        },
        required: ['rows'],
      },
    };
    const model = getModeConfig(o.model).model;
    // The 'certify' pass is the anti-inversion check — frame it as an INDEPENDENT
    // fresh re-read (different wording, value list order reversed) so a systematic
    // misread is less likely to repeat the learn pass's exact error. (Codex HIGH.)
    const system =
      pass === 'certify'
        ? `Independently and from scratch, read this ONE screenshot of a hotel PMS table. ` +
          `Do not assume any prior reading. For EACH visible data row, determine its ` +
          `${o.keyColName} and which allowed value it actually shows — the value may be a ` +
          `colored badge, highlighted button, checkbox, dropdown selection, or icon, not plain ` +
          `text. Judge each row on its own. Report ONLY rows you can clearly see; never guess.`
        : `You are reading ONE screenshot of a hotel PMS table. For EACH visible data row, ` +
          `report its ${o.keyColName} and the single best-matching value from the allowed list. ` +
          `The value may be shown as a COLORED BADGE, a highlighted/selected button, a checkbox, ` +
          `a dropdown selection, or an icon — not necessarily plain text. Read each row carefully ` +
          `and independently. Report ONLY rows you can clearly see; never invent a row or a value.`;
    const resp = await anthropic.messages.create({
      model,
      max_tokens: 4000,
      // NB: NO `temperature` — it's deprecated on Opus 4.8 (the default mapper
      // model) and returns 400 (caught live by the CA robot run). Certify-pass
      // independence comes from the reworded prompt below + the founder-review
      // backstop, not from a temperature delta.
      system,
      tools: [tool as never],
      tool_choice: { type: 'tool', name: 'report_rows' },
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: b64 } },
            {
              type: 'text',
              text:
                pass === 'certify'
                  ? `Independently report each visible row's ${o.keyColName} and the value it shows.`
                  : `Report each row's ${o.keyColName} and value.`,
            },
          ],
        },
      ],
    });
    void logClaudeUsage(resp.usage ?? {}, {
      workload: 'cua_mapping_colrecovery', // visual-state IS a column-recovery path
      model,
      ...(o.propertyId ? { propertyId: o.propertyId } : {}),
      ...(o.jobId ? { jobId: o.jobId } : {}),
      metadata: { actionName: o.actionKey, col: o.col, pass, kind: 'visual_state' },
    });
    const out = new Map<string, string>();
    for (const block of resp.content) {
      if (block.type === 'tool_use' && block.name === 'report_rows') {
        const rows = (block.input as { rows?: Array<{ key?: unknown; value?: unknown }> })?.rows;
        if (Array.isArray(rows)) {
          for (const r of rows) {
            if (r && typeof r.key === 'string' && typeof r.value === 'string') {
              // MUST match visual-state-dom.ts key normalization or the join shrinks.
              const k = r.key.replace(/\s+/g, ' ').trim();
              if (k) out.set(k, r.value);
            }
          }
        }
      }
    }
    return out;
  };
}

/**
 * For each dead column that is a contract ENUM, attempt visual-state learning.
 * Returns the recovered columns (selector + value map). `tried` is mutated to
 * record every attempted column so re-ask cycles don't re-pay for a parked one.
 */
export async function recoverDeadEnumColumnsViaVisualState(opts: {
  page: Page;
  actionKey: ActionKey;
  rowSelector: string;
  columns: Record<string, string>;
  deadCols: string[];
  tried: Set<string>;
  /** Returns true when the job is over its cost cap — checked before each column
   *  so a multi-column feed can't keep spending vision past the cap. */
  isOverBudget?: () => Promise<boolean>;
  model?: MapperModelId;
  propertyId?: string;
  jobId?: string | null;
}): Promise<VisualRecovery[]> {
  const keyCol = DISCOVERY_KEY_COLUMNS[opts.actionKey];
  if (!keyCol) return [];
  const keySel = parseColumnSelector(opts.columns[keyCol] ?? '').css;
  if (!keySel || keySel === '.') return []; // need a stable per-row key cell

  const recovered: VisualRecovery[] = [];
  for (const col of opts.deadCols) {
    if (opts.tried.has(col)) continue;
    if (opts.isOverBudget && (await opts.isOverBudget())) {
      log.info('visual-state: stopping — job over cost cap', {
        jobId: opts.jobId ?? undefined,
        actionName: opts.actionKey,
      });
      break;
    }
    const enumValues = contractEnumValues(opts.actionKey, col);
    if (!enumValues || enumValues.length === 0) continue; // visual-state only for enum columns
    const targetSel = parseColumnSelector(opts.columns[col] ?? '').css;
    if (!targetSel || targetSel === '.') continue;
    opts.tried.add(col); // mark attempted up-front (cost is about to be spent)

    try {
      const outcome = await learnVisualStateColumn({
        page: opts.page,
        rowSelector: opts.rowSelector,
        keyCellCss: keySel,
        targetCellCss: targetSel,
        label: buildVisionLabeler({
          page: opts.page,
          keyColName: keyCol,
          enumValues,
          model: opts.model,
          propertyId: opts.propertyId,
          jobId: opts.jobId,
          actionKey: opts.actionKey,
          col,
        }),
      });
      if (outcome.ok && outcome.selector && outcome.valueMap) {
        log.info('visual-state: learned a hidden signal for a dead enum column', {
          jobId: opts.jobId ?? undefined,
          actionName: opts.actionKey,
          col,
          via: outcome.via,
        });
        recovered.push({
          col,
          selector: outcome.selector,
          valueMap: outcome.valueMap,
          via: outcome.via ?? '',
          reason: outcome.reason,
        });
      } else {
        log.info('visual-state: parked (no certified signal)', {
          jobId: opts.jobId ?? undefined,
          actionName: opts.actionKey,
          col,
          reason: outcome.reason,
        });
      }
    } catch (err) {
      log.warn('visual-state: learn threw — leaving column dead', {
        jobId: opts.jobId ?? undefined,
        actionName: opts.actionKey,
        col,
        err: (err as Error).message.slice(0, 160),
      });
    }
  }
  return recovered;
}
