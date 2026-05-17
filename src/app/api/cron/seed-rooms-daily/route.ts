/**
 * GET /api/cron/seed-rooms-daily
 *
 * Round 14 (2026-05-14) Layer 2. Before this cron existed, today's rooms
 * only got seeded when a staff member clicked "Load Rooms from CSV" on
 * the housekeeper tab. If nobody clicked (weekend, holiday, just busy)
 * the `rooms` table for today was empty — and the AI's "what's our
 * occupancy" answer became meaningless.
 *
 * This cron walks every property that has a room_inventory configured
 * (or any `properties` row with `total_rooms > 0`) and calls the shared
 * seedRoomsForDate helper. The helper phantom-seeds every inventory
 * room as vacant + clean when no CSV exists yet — so even on a scraper
 * outage, the Rooms tab + the AI always see a fully-populated grid.
 *
 * Cadence: hourly between 05:00 and 13:00 UTC (00:00 to 08:00 CDT) so
 * the morning seed happens before staff arrive, then once mid-day in
 * case the scraper recovered. See vercel.json. Most runs are a no-op
 * (today already seeded), which is the cheap intended behavior.
 *
 * Auth: CRON_SECRET bearer (writeCronHeartbeat to the registry).
 *
 * INV-23 doctrine: this cron is one of three layers (agent reads
 * inventory, cron heals partial seed, doctor alerts on drift) that
 * together guarantee the AI never reports a room total that
 * contradicts the property's actual size.
 */

import { NextRequest } from 'next/server';
import { requireCronSecret } from '@/lib/api-auth';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId, log } from '@/lib/log';
import { writeCronHeartbeat } from '@/lib/cron-heartbeat';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { seedRoomsForDate } from '@/lib/rooms/seed';
import {
  parseStringField,
  parseNumberField,
  parseArrayField,
} from '@/lib/db-mappers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

interface PropertyRow {
  id: string;
  timezone: string | null;
  room_inventory: string[] | null;
  total_rooms: number | null;
}

/** Validate that a Supabase row matches the SELECT we issued. Returns null
 *  on shape mismatch so the cron skips bad rows instead of silently seeding
 *  an undefined property_id. Audit finding H3 (2026-05-17). */
function parsePropertyRow(raw: unknown): PropertyRow | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const id = parseStringField(r.id);
  if (!id) return null;
  return {
    id,
    timezone: parseStringField(r.timezone) ?? null,
    room_inventory: Array.isArray(r.room_inventory)
      ? parseArrayField(r.room_inventory, parseStringField)
      : null,
    total_rooms: parseNumberField(r.total_rooms) ?? null,
  };
}

/** Compute the property's local YYYY-MM-DD for a given UTC instant.
 *
 *  Uses Intl with the property's IANA timezone string. Falls back to
 *  UTC when the timezone is missing or invalid (we don't want one bad
 *  property to break the whole cron). */
export function propertyLocalDate(now: Date, timezone: string | null): string {
  if (!timezone) return now.toISOString().slice(0, 10);
  try {
    // en-CA produces YYYY-MM-DD natively.
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    return fmt.format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

export async function GET(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const cronGate = requireCronSecret(req);
  if (cronGate) return cronGate;

  try {
    // Pull every property that has either an inventory OR a configured
    // total_rooms. Properties with neither are not seedable yet (they
    // haven't completed onboarding); skip them silently.
    const { data: properties, error: propsErr } = await supabaseAdmin
      .from('properties')
      .select('id, timezone, room_inventory, total_rooms');
    if (propsErr) throw propsErr;

    const now = new Date();
    const seedable: PropertyRow[] = [];
    for (const raw of properties ?? []) {
      const p = parsePropertyRow(raw);
      if (!p) continue;
      const hasInventory = Array.isArray(p.room_inventory) && p.room_inventory.length > 0;
      const hasTotal = typeof p.total_rooms === 'number' && p.total_rooms > 0;
      if (hasInventory || hasTotal) seedable.push(p);
    }

    const results: Array<{
      propertyId: string;
      date: string;
      created: number;
      updated: number;
      phantomCreated: number;
      inventoryLength: number;
      csvAvailable: boolean;
      error?: string;
    }> = [];

    for (const prop of seedable) {
      const localDate = propertyLocalDate(now, prop.timezone);
      try {
        const r = await seedRoomsForDate(prop.id, localDate);
        results.push({
          propertyId: prop.id,
          date: localDate,
          created: r.created,
          updated: r.updated,
          phantomCreated: r.phantomCreated,
          inventoryLength: r.inventoryLength,
          csvAvailable: r.csvAvailable,
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        log.warn('[seed-rooms-daily] property failed', {
          requestId,
          propertyId: prop.id,
          date: localDate,
          error: msg,
        });
        results.push({
          propertyId: prop.id,
          date: localDate,
          created: 0,
          updated: 0,
          phantomCreated: 0,
          inventoryLength: 0,
          csvAvailable: false,
          error: msg,
        });
      }
    }

    const totalSeeded = results.reduce((acc, r) => acc + r.created + r.updated, 0);
    const totalPhantom = results.reduce((acc, r) => acc + r.phantomCreated, 0);
    const failed = results.filter(r => r.error).length;

    await writeCronHeartbeat('seed-rooms-daily', {
      requestId,
      notes: {
        propertiesSeen: results.length,
        propertiesFailed: failed,
        totalSeeded,
        totalPhantom,
      },
    });

    return ok({
      propertiesSeen: results.length,
      propertiesFailed: failed,
      totalSeeded,
      totalPhantom,
      perProperty: results,
    }, { requestId });
  } catch (e) {
    return err(`seed-rooms-daily failed: ${e instanceof Error ? e.message : String(e)}`, {
      requestId, status: 500, code: ApiErrorCode.InternalError,
    });
  }
}
