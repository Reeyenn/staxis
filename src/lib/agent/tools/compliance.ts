// Engineering Compliance agent tools (feature #19).
//
// AI feature #2 — log_reading + log_pm_check work in BOTH text chat AND voice
// ("Hey Staxis, pool pH 7.4, chlorine 3, alkalinity 90"). AI feature #6 — an
// inspector-ready report tool. Plus a status query and one-line setup.
//
// All writes go through the same server logging path as the mobile/manager
// surfaces, so out-of-range auto-act (work order + SMS) fires here too.

import { supabaseAdmin } from '@/lib/supabase-admin';
import { registerTool, type ToolResult, type ToolContext } from '../tools';
import {
  findReadingTypeByName,
  findPmTaskByName,
  logReading,
  logPmCheck,
  getOverview,
  getReport,
  applySeeds,
} from '@/lib/compliance/store';
import { detectTemplate } from '@/lib/compliance/templates';
import { parseSetupFromText, buildSeedsFromSpec } from '@/lib/compliance/nlp';

function sourceFor(ctx: ToolContext): 'voice' | 'manual' {
  return ctx.surface === 'voice' ? 'voice' : 'manual';
}

// ─── log_reading ─────────────────────────────────────────────────────────────

registerTool<{ metric: string; value: number }>({
  name: 'log_reading',
  description:
    'Log an engineering compliance READING (pool chemistry, utility meter, boiler, walk-in fridge/freezer temperature, etc.). ' +
    'Use when the user states a measurement, e.g. "pool pH 7.4", "free chlorine 3 ppm", "electric meter 48210", "walk-in fridge 38". ' +
    'Call once PER metric — for "pool pH 7.4, chlorine 3, alkalinity 90" call three times. ' +
    'metric = the measured thing in plain words; value = the number only.',
  inputSchema: {
    type: 'object',
    properties: {
      metric: { type: 'string', description: 'The measured thing, e.g. "pH", "free chlorine", "alkalinity", "electric meter", "walk-in fridge".' },
      value: { type: 'number', description: 'The numeric value, units stripped (7.4, 3, 90).' },
    },
    required: ['metric', 'value'],
  },
  allowedRoles: ['admin', 'owner', 'general_manager', 'maintenance'],
  surfaces: ['chat', 'voice'],
  voiceModes: ['compliance'],
  mutates: true,
  handler: async ({ metric, value }, ctx): Promise<ToolResult> => {
    if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > 1e9) {
      return { ok: false, error: 'value must be a finite number within ±1e9.' };
    }
    const type = await findReadingTypeByName(ctx.propertyId, String(metric || ''));
    if (!type) {
      return { ok: false, error: `No compliance reading called "${metric}" is set up for this property. Ask the manager to add it on the Maintenance → Compliance tab, or run setup_compliance.` };
    }
    if (ctx.dryRun) {
      return { ok: true, data: { dryRun: true, reading: type.name, value } };
    }
    const result = await logReading({
      pid: ctx.propertyId,
      readingTypeId: type.id,
      value,
      source: sourceFor(ctx),
      staffId: ctx.staffId,
      staffName: ctx.user.displayName,
      idempotencyKey: ctx.voiceSessionId ? `agent:${ctx.voiceSessionId}:${type.id}:${value}` : null,
    });
    return {
      ok: true,
      data: {
        reading: type.name,
        value,
        unit: type.unit,
        outOfRange: result.outOfRange,
        workOrderCreated: !!result.workOrderId,
        message: result.outOfRange
          ? `Logged ${type.name} = ${value}${type.unit}. ⚠️ Out of safe range — a work order was created and maintenance was texted.`
          : `Logged ${type.name} = ${value}${type.unit}.`,
      },
    };
  },
});

// ─── log_pm_check ────────────────────────────────────────────────────────────

registerTool<{ equipment: string; status?: 'pass' | 'fail'; unitsChecked?: number }>({
  name: 'log_pm_check',
  description:
    'Record a preventive-maintenance / life-safety equipment CHECK-OFF for the current period (e.g. "fire extinguishers checked", "emergency lights all good", "AED inspected"). ' +
    'status defaults to "pass"; use "fail" when the user says something failed (that auto-creates a work order + texts maintenance).',
  inputSchema: {
    type: 'object',
    properties: {
      equipment: { type: 'string', description: 'The equipment group, e.g. "fire extinguishers", "emergency lighting", "AED", "exit signs".' },
      status: { type: 'string', enum: ['pass', 'fail'], description: 'pass (default) or fail.' },
      unitsChecked: { type: 'number', description: 'Optional count of units checked.' },
    },
    required: ['equipment'],
  },
  allowedRoles: ['admin', 'owner', 'general_manager', 'maintenance'],
  surfaces: ['chat', 'voice'],
  voiceModes: ['compliance'],
  mutates: true,
  handler: async ({ equipment, status, unitsChecked }, ctx): Promise<ToolResult> => {
    const task = await findPmTaskByName(ctx.propertyId, String(equipment || ''));
    if (!task) {
      return { ok: false, error: `No compliance check called "${equipment}" is set up for this property. Ask the manager to add it on the Maintenance → Compliance tab, or run setup_compliance.` };
    }
    const finalStatus: 'pass' | 'fail' = status === 'fail' ? 'fail' : 'pass';
    if (ctx.dryRun) {
      return { ok: true, data: { dryRun: true, equipment: task.name, status: finalStatus } };
    }
    const result = await logPmCheck({
      pid: ctx.propertyId,
      pmTaskId: task.id,
      status: finalStatus,
      unitsChecked: typeof unitsChecked === 'number' && Number.isFinite(unitsChecked) ? Math.max(0, Math.round(unitsChecked)) : null,
      staffId: ctx.staffId,
      staffName: ctx.user.displayName,
    });
    return {
      ok: true,
      data: {
        equipment: task.name,
        status: finalStatus,
        workOrderCreated: !!result.workOrderId,
        message: finalStatus === 'fail'
          ? `Recorded ${task.name} as FAILED for this period. ⚠️ A work order was created and maintenance was texted.`
          : `Recorded ${task.name} as checked (pass) for this period.`,
      },
    };
  },
});

// ─── get_compliance_status ───────────────────────────────────────────────────

registerTool<Record<string, never>>({
  name: 'get_compliance_status',
  description:
    'Get the property\'s engineering-compliance status right now: percent of readings logged today and how many life-safety checks are overdue.',
  inputSchema: { type: 'object', properties: {} },
  allowedRoles: ['admin', 'owner', 'general_manager', 'front_desk', 'maintenance'],
  surfaces: ['chat', 'voice'],
  voiceModes: ['compliance'],
  handler: async (_args, ctx): Promise<ToolResult> => {
    const o = await getOverview(ctx.propertyId);
    return {
      ok: true,
      data: {
        readingsCompletePct: o.readingsCompletePct,
        readingsDone: o.readingsDone,
        readingsTotal: o.readingsTotal,
        pmOverdueCount: o.pmOverdueCount,
        pmTotal: o.pmTotal,
        overdueChecks: o.pmTasks.filter((p) => p.overdue).map((p) => p.task.name),
      },
    };
  },
});

// ─── generate_compliance_report (AI feature #6) ──────────────────────────────

registerTool<{ fromDate?: string; toDate?: string }>({
  name: 'generate_compliance_report',
  description:
    'Generate an inspector-ready compliance report (proof of readings + life-safety checks) for a date range. ' +
    'Use for "show me proof we did pool chemistry in May". Dates are YYYY-MM-DD; defaults to the last 31 days.',
  inputSchema: {
    type: 'object',
    properties: {
      fromDate: { type: 'string', description: 'Start date YYYY-MM-DD (optional).' },
      toDate: { type: 'string', description: 'End date YYYY-MM-DD (optional).' },
    },
  },
  allowedRoles: ['admin', 'owner', 'general_manager'],
  surfaces: ['chat'],
  handler: async ({ fromDate, toDate }, ctx): Promise<ToolResult> => {
    const dateRx = /^\d{4}-\d{2}-\d{2}$/;
    const to = typeof toDate === 'string' && dateRx.test(toDate) ? toDate : new Date().toISOString().slice(0, 10);
    const from = typeof fromDate === 'string' && dateRx.test(fromDate)
      ? fromDate
      : new Date(Date.now() - 31 * 24 * 3600 * 1000).toISOString().slice(0, 10);
    if (from > to) return { ok: false, error: 'fromDate must be on or before toDate.' };
    const report = await getReport(ctx.propertyId, from, to);
    return {
      ok: true,
      data: {
        range: `${from} to ${to}`,
        totals: report.totals,
        readings: report.readings.map((r) => ({ name: r.name, entries: r.entries.length, outOfRange: r.entries.filter((e) => e.status === 'OUT OF RANGE').length })),
        pmChecks: report.pmChecks.map((r) => ({ name: r.name, entries: r.entries.length, fails: r.entries.filter((e) => e.status === 'fail').length })),
        note: 'Full printable audit pack is available on the Maintenance → Compliance tab → Export.',
      },
    };
  },
});

// ─── setup_compliance (AI feature #5) ────────────────────────────────────────

registerTool<{ text?: string }>({
  name: 'setup_compliance',
  description:
    'One-line setup of the property\'s compliance schedule. Auto-detects the brand and pre-loads the required readings + life-safety logs. ' +
    'Pass the manager\'s description to tune counts, e.g. "we have 15 extinguishers, 18 emergency lights, a pool, and 3 walk-in fridges".',
  inputSchema: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'Free-text description of the property\'s equipment (optional).' },
    },
  },
  allowedRoles: ['admin', 'owner', 'general_manager'],
  surfaces: ['chat'],
  mutates: true,
  handler: async ({ text }, ctx): Promise<ToolResult> => {
    const { data: prop } = await supabaseAdmin.from('properties').select('name, pms_type').eq('id', ctx.propertyId).maybeSingle();
    const template = detectTemplate(prop?.name as string | null, prop?.pms_type as string | null);
    let readingSeeds = template.readingTypes;
    let pmSeeds = template.pmTasks;
    if (typeof text === 'string' && text.trim()) {
      const spec = await parseSetupFromText(text);
      const built = buildSeedsFromSpec(template, spec);
      readingSeeds = built.readingSeeds;
      pmSeeds = built.pmSeeds;
    }
    if (ctx.dryRun) {
      return { ok: true, data: { dryRun: true, brand: template.label, readings: readingSeeds.length, pmTasks: pmSeeds.length } };
    }
    const { readingsCreated, pmCreated } = await applySeeds(ctx.propertyId, readingSeeds, pmSeeds, template.key);
    return {
      ok: true,
      data: {
        brand: template.label,
        readingsCreated,
        pmCreated,
        message: `Set up ${readingsCreated} readings and ${pmCreated} life-safety checks using the ${template.label} template.`,
      },
    };
  },
});
