// ═══════════════════════════════════════════════════════════════════════════
// Deep Cleaning — config (frequency, target per week) + per-room records
// (last deep clean date, who cleaned it). Drives the "deep clean queue"
// UI that surfaces overdue rooms.
// ═══════════════════════════════════════════════════════════════════════════

import type { DeepCleanConfig, DeepCleanRecord } from '@/types';
import { supabase, logErr } from './_common';
import { dropUndefined, fromDeepCleanRecordRow } from '../db-mappers';

const DEFAULT_DEEP_CLEAN_CONFIG: DeepCleanConfig = {
  frequencyDays: 90,
  minutesPerRoom: 60,
  targetPerWeek: 5,
};

export async function getDeepCleanConfig(_uid: string, pid: string): Promise<DeepCleanConfig> {
  const { data, error } = await supabase
    .from('deep_clean_config').select('*').eq('property_id', pid).maybeSingle();
  if (error) { logErr('getDeepCleanConfig', error); throw error; }
  if (!data) return { ...DEFAULT_DEEP_CLEAN_CONFIG };
  return {
    frequencyDays: Number(data.frequency_days ?? 90),
    minutesPerRoom: Number(data.minutes_per_room ?? 60),
    targetPerWeek: Number(data.target_per_week ?? 5),
  };
}

export async function setDeepCleanConfig(_uid: string, pid: string, config: DeepCleanConfig): Promise<void> {
  const row = {
    property_id: pid,
    frequency_days: config.frequencyDays,
    minutes_per_room: config.minutesPerRoom,
    target_per_week: config.targetPerWeek,
  };
  const { error } = await supabase.from('deep_clean_config').upsert(row);
  if (error) { logErr('setDeepCleanConfig', error); throw error; }
}

export async function getDeepCleanRecords(_uid: string, pid: string): Promise<DeepCleanRecord[]> {
  const { data, error } = await supabase
    .from('deep_clean_records').select('*').eq('property_id', pid);
  if (error) { logErr('getDeepCleanRecords', error); throw error; }
  return (data ?? []).map(fromDeepCleanRecordRow);
}

export async function setDeepCleanRecord(_uid: string, pid: string, record: DeepCleanRecord): Promise<void> {
  const row = dropUndefined({
    property_id: pid,
    room_number: record.roomNumber,
    last_deep_clean: record.lastDeepClean,
    cleaned_by: record.cleanedBy,
    cleaned_by_team: record.cleanedByTeam,
    notes: record.notes,
    status: record.status,
    assigned_at: record.assignedAt,
    completed_at: record.completedAt,
  });
  const { error } = await supabase
    .from('deep_clean_records').upsert(row, { onConflict: 'property_id,room_number' });
  if (error) { logErr('setDeepCleanRecord', error); throw error; }
}

export async function markRoomDeepCleaned(
  _uid: string, pid: string, roomNumber: string, cleanedBy?: string, notes?: string,
): Promise<void> {
  const today = new Date().toLocaleDateString('en-CA');
  const row = dropUndefined({
    property_id: pid,
    room_number: roomNumber,
    last_deep_clean: today,
    status: 'completed',
    completed_at: today,
    cleaned_by: cleanedBy,
    notes,
  });
  const { error } = await supabase
    .from('deep_clean_records').upsert(row, { onConflict: 'property_id,room_number' });
  if (error) { logErr('markRoomDeepCleaned', error); throw error; }
}

export async function assignRoomDeepClean(
  _uid: string, pid: string, roomNumber: string, team: string[],
): Promise<void> {
  const today = new Date().toLocaleDateString('en-CA');
  // Preserve prior lastDeepClean if the row already exists.
  //
  // 2026-05-12 (Codex audit): previously we ignored the read error.
  // On a transient/RLS read failure `existing` came back null and the
  // upsert wrote `last_deep_clean: ''`, silently wiping any prior
  // history. Treat read failure as fatal (caller decides retry); only
  // overwrite when we successfully observed "no prior row".
  const { data: existing, error: readErr } = await supabase
    .from('deep_clean_records').select('last_deep_clean')
    .eq('property_id', pid).eq('room_number', roomNumber).maybeSingle();
  if (readErr) {
    logErr('assignRoomDeepClean: read existing failed', readErr);
    throw readErr;
  }
  const row: Record<string, unknown> = {
    property_id: pid,
    room_number: roomNumber,
    cleaned_by_team: team,
    status: 'in_progress',
    assigned_at: today,
  };
  // Only include last_deep_clean if we actually have one — never blank
  // out the column from this code path. If the row doesn't exist yet,
  // the upsert leaves last_deep_clean to its column default.
  if (existing?.last_deep_clean) {
    row.last_deep_clean = existing.last_deep_clean as string;
  }
  const { error } = await supabase
    .from('deep_clean_records').upsert(row, { onConflict: 'property_id,room_number' });
  if (error) { logErr('assignRoomDeepClean', error); throw error; }
}

export async function completeRoomDeepClean(
  _uid: string, pid: string, roomNumber: string, team: string[],
): Promise<void> {
  const today = new Date().toLocaleDateString('en-CA');
  const row = {
    property_id: pid,
    room_number: roomNumber,
    last_deep_clean: today,
    cleaned_by_team: team,
    cleaned_by: team.join(', '),
    status: 'completed',
    completed_at: today,
  };
  const { error } = await supabase
    .from('deep_clean_records').upsert(row, { onConflict: 'property_id,room_number' });
  if (error) { logErr('completeRoomDeepClean', error); throw error; }
}
