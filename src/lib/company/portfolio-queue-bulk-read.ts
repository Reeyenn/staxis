import 'server-only';

import { log } from '@/lib/log';
import { supabaseAdmin } from '@/lib/supabase-admin';
import {
  judgedPhrasingFromRows,
  rowToFinding,
  type JudgedPhrasing,
  type LatestRunFacts,
} from '@/lib/findings/store';
import {
  LIVE_ACTION_STATES,
  rowToAction,
} from '@/lib/findings/actions/store';
import type { FindingAction } from '@/lib/findings/actions/types';
import type { Finding } from '@/lib/findings/types';

const UUID_RX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RPC_PROPERTY_CHUNK = 60;
const MAX_PROPERTIES = 250;
const MAX_FINDINGS_PER_PROPERTY = 100;
const CLIMB_VISIBLE_STATUSES = ['open', 'updated', 'known_problem', 'muted'] as const;

type RawRow = Record<string, unknown>;

export interface PortfolioQueueReadModel {
  propertyIds: string[];
  findingsByPropertyId: Map<string, Finding[]>;
  phrasingByFindingId: Map<string, JudgedPhrasing>;
  latestRunByPropertyId: Map<string, LatestRunFacts>;
  actionByFindingId: Map<string, FindingAction>;
  unavailableFindingPropertyIds: string[];
  unavailableRunPropertyIds: string[];
}

interface PropertyRunFacts extends LatestRunFacts {
  propertyId: string;
}

function canonicalPropertyIds(propertyIds: readonly string[]): string[] {
  if (propertyIds.length > MAX_PROPERTIES
    || propertyIds.some((id) => !UUID_RX.test(id))
    || new Set(propertyIds).size !== propertyIds.length) {
    throw new Error('portfolio queue bulk read received an invalid property set');
  }
  return [...propertyIds];
}

function chunks<T>(values: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    out.push(values.slice(index, index + size));
  }
  return out;
}

function numberValue(value: unknown): number {
  const parsed = typeof value === 'string' ? Number(value) : value;
  return typeof parsed === 'number' && Number.isFinite(parsed) ? parsed : 0;
}

function rows(value: unknown, operation: string): RawRow[] {
  if (!Array.isArray(value)) throw new Error(`${operation} returned a malformed result`);
  return value.map((row) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      throw new Error(`${operation} returned a malformed row`);
    }
    return row as RawRow;
  });
}

async function readFindingChunk(propertyIds: string[]): Promise<{
  rows: RawRow[];
  findings: Finding[];
}> {
  const { data, error } = await supabaseAdmin.rpc('staxis_portfolio_queue_findings', {
    p_property_ids: propertyIds,
    p_statuses: [...CLIMB_VISIBLE_STATUSES],
    p_limit_per_property: MAX_FINDINGS_PER_PROPERTY,
  });
  if (error) throw new Error(error.message);
  const rawRows = rows(data, 'staxis_portfolio_queue_findings');
  const allowed = new Set(propertyIds);
  const counts = new Map<string, number>();
  const seenFindingIds = new Set<string>();
  const findings = rawRows.map((row) => {
    const propertyId = typeof row.property_id === 'string' ? row.property_id : null;
    const findingId = typeof row.id === 'string' ? row.id : null;
    if (!propertyId || !allowed.has(propertyId) || !findingId || seenFindingIds.has(findingId)) {
      throw new Error('portfolio findings crossed or duplicated the requested scope');
    }
    seenFindingIds.add(findingId);
    const count = (counts.get(propertyId) ?? 0) + 1;
    if (count > MAX_FINDINGS_PER_PROPERTY) {
      throw new Error('portfolio findings exceeded the per-property row contract');
    }
    counts.set(propertyId, count);
    const finding = rowToFinding(
      row as unknown as Parameters<typeof rowToFinding>[0],
    );
    if (finding.propertyId !== propertyId) {
      throw new Error('portfolio finding projection changed property identity');
    }
    return finding;
  });
  return { rows: rawRows, findings };
}

async function readRunChunk(propertyIds: string[]): Promise<PropertyRunFacts[]> {
  const { data, error } = await supabaseAdmin.rpc('staxis_portfolio_queue_latest_runs', {
    p_property_ids: propertyIds,
  });
  if (error) throw new Error(error.message);
  const allowed = new Set(propertyIds);
  const seen = new Set<string>();
  return rows(data, 'staxis_portfolio_queue_latest_runs').map((row) => {
    const propertyId = typeof row.property_id === 'string' ? row.property_id : null;
    const runAt = typeof row.run_at === 'string' ? row.run_at : null;
    if (!propertyId || !allowed.has(propertyId) || seen.has(propertyId) || !runAt) {
      throw new Error('portfolio runs crossed, duplicated, or malformed the requested scope');
    }
    seen.add(propertyId);
    return {
      propertyId,
      runAt,
      detectorsChecked: numberValue(row.detectors_checked),
      detectorsSkipped: numberValue(row.detectors_skipped),
      detectorsFailed: numberValue(row.detectors_failed),
    };
  });
}

async function readActionChunk(
  propertyIds: string[],
  findings: readonly Finding[],
): Promise<FindingAction[]> {
  const findingIds = findings.map((finding) => finding.id);
  if (findingIds.length === 0) return [];
  const { data, error } = await supabaseAdmin.rpc('staxis_portfolio_queue_actions', {
    p_property_ids: propertyIds,
    p_finding_ids: findingIds,
    p_states: [...LIVE_ACTION_STATES],
  });
  if (error) throw new Error(error.message);
  const allowedProperties = new Set(propertyIds);
  const propertyByFinding = new Map(
    findings.map((finding) => [finding.id, finding.propertyId]),
  );
  const seen = new Set<string>();
  return rows(data, 'staxis_portfolio_queue_actions').map((row) => {
    const propertyId = typeof row.property_id === 'string' ? row.property_id : null;
    const findingId = typeof row.finding_id === 'string' ? row.finding_id : null;
    if (!propertyId
      || !allowedProperties.has(propertyId)
      || !findingId
      || propertyByFinding.get(findingId) !== propertyId
      || seen.has(findingId)) {
      throw new Error('portfolio actions crossed or duplicated the selected finding scope');
    }
    seen.add(findingId);
    const action = rowToAction(
      row as unknown as Parameters<typeof rowToAction>[0],
    );
    if (action.propertyId !== propertyId || action.findingId !== findingId) {
      throw new Error('portfolio action projection changed row identity');
    }
    return action;
  });
}

/**
 * Three bounded RPC families replace hotel-scaled ledger fan-out. A 61-hotel
 * portfolio uses two chunks; a 250-hotel window uses five. Failed chunks are
 * named as unavailable and never interpreted as empty.
 */
export async function loadPortfolioQueueReadModel(
  requestedPropertyIds: readonly string[],
): Promise<PortfolioQueueReadModel> {
  const propertyIds = canonicalPropertyIds(requestedPropertyIds);
  const propertyChunks = chunks(propertyIds, RPC_PROPERTY_CHUNK);
  const findingsByPropertyId = new Map<string, Finding[]>(
    propertyIds.map((propertyId) => [propertyId, []]),
  );
  const latestRunByPropertyId = new Map<string, LatestRunFacts>();
  const phrasingByFindingId = new Map<string, JudgedPhrasing>();
  const actionByFindingId = new Map<string, FindingAction>();
  const unavailableFindingPropertyIds = new Set<string>();
  const unavailableRunPropertyIds = new Set<string>();

  const [findingResults, runResults] = await Promise.all([
    Promise.all(propertyChunks.map(async (chunk) => {
      try {
        return { chunk, value: await readFindingChunk(chunk) };
      } catch (error) {
        log.warn('[vp-queue] a bounded findings chunk could not be read', {
          hotelCount: chunk.length,
          err: error instanceof Error ? error.message : String(error),
        });
        return { chunk, value: null };
      }
    })),
    Promise.all(propertyChunks.map(async (chunk) => {
      try {
        return { chunk, value: await readRunChunk(chunk) };
      } catch (error) {
        log.warn('[vp-queue] a bounded run chunk could not be read', {
          hotelCount: chunk.length,
          err: error instanceof Error ? error.message : String(error),
        });
        return { chunk, value: null };
      }
    })),
  ]);

  for (const result of findingResults) {
    if (!result.value) {
      result.chunk.forEach((propertyId) => unavailableFindingPropertyIds.add(propertyId));
      continue;
    }
    for (const finding of result.value.findings) {
      findingsByPropertyId.get(finding.propertyId)!.push(finding);
    }
    for (const [findingId, phrasing] of judgedPhrasingFromRows(result.value.rows)) {
      phrasingByFindingId.set(findingId, phrasing);
    }
  }

  for (const result of runResults) {
    if (!result.value) {
      result.chunk.forEach((propertyId) => unavailableRunPropertyIds.add(propertyId));
      continue;
    }
    for (const run of result.value) {
      latestRunByPropertyId.set(run.propertyId, run);
    }
  }

  // Actions are fail-soft presentation data. A failed chunk removes buttons,
  // never cards or coverage.
  await Promise.all(propertyChunks.map(async (chunk) => {
    const findings = chunk.flatMap(
      (propertyId) => findingsByPropertyId.get(propertyId) ?? [],
    );
    try {
      for (const action of await readActionChunk(chunk, findings)) {
        actionByFindingId.set(action.findingId, action);
      }
    } catch (error) {
      log.warn('[vp-queue] a bounded action chunk could not be read; buttons are withheld', {
        hotelCount: chunk.length,
        err: error instanceof Error ? error.message : String(error),
      });
    }
  }));

  return {
    propertyIds,
    findingsByPropertyId,
    phrasingByFindingId,
    latestRunByPropertyId,
    actionByFindingId,
    unavailableFindingPropertyIds: propertyIds.filter(
      (propertyId) => unavailableFindingPropertyIds.has(propertyId),
    ),
    unavailableRunPropertyIds: propertyIds.filter(
      (propertyId) => unavailableRunPropertyIds.has(propertyId),
    ),
  };
}
