// Client-side data helpers for the Equipment (asset) registry — 0249.
//
// Thin fetch wrappers around /api/maintenance/equipment/* (NEVER the browser
// supabase client — the equipment table is service-role-only, RLS bug class).
// Mirrors src/lib/db/compliance.ts. Re-exported via src/lib/db.ts so the
// registry UI imports from '@/lib/db'.

import { fetchWithAuth } from '@/lib/api-fetch';
import type { Equipment, EquipmentDetail, EquipmentInput } from '@/lib/equipment/types';

interface Envelope<T> { ok?: boolean; data?: T; error?: string }

async function parse<T>(res: Response): Promise<{ ok: boolean; data?: T; error?: string }> {
  const json = (await res.json().catch(() => null)) as Envelope<T> | null;
  if (!res.ok || !json?.ok) return { ok: false, error: json?.error || `http ${res.status}` };
  return { ok: true, data: json.data };
}

/** All assets for a property (manager + staff can read). */
export async function fetchEquipmentList(pid: string): Promise<Equipment[]> {
  const res = await fetchWithAuth(`/api/maintenance/equipment?pid=${encodeURIComponent(pid)}`);
  const { ok, data } = await parse<{ equipment: Equipment[] }>(res);
  return ok && data ? data.equipment : [];
}

/** One asset + its derived repair/PM history. */
export async function fetchEquipmentDetail(pid: string, id: string): Promise<EquipmentDetail | null> {
  const res = await fetchWithAuth(
    `/api/maintenance/equipment/${encodeURIComponent(id)}?pid=${encodeURIComponent(pid)}`,
  );
  const { ok, data } = await parse<EquipmentDetail>(res);
  return ok && data ? data : null;
}

/** Create an asset (manager-gated server-side). */
export async function createEquipmentAsset(
  pid: string, input: EquipmentInput,
): Promise<{ ok: boolean; data?: { id: string }; error?: string }> {
  const res = await fetchWithAuth(`/api/maintenance/equipment`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pid, ...input }),
  });
  return parse<{ id: string }>(res);
}

/** Edit an asset (manager-gated). Full-replace — send every field. */
export async function updateEquipmentAsset(
  pid: string, id: string, input: EquipmentInput,
): Promise<{ ok: boolean; data?: { id: string }; error?: string }> {
  const res = await fetchWithAuth(`/api/maintenance/equipment/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pid, ...input }),
  });
  return parse<{ id: string }>(res);
}

/** Delete an asset (manager-gated). Linked work orders / PM tasks are unlinked,
 *  not deleted (FK ON DELETE SET NULL). */
export async function deleteEquipmentAsset(
  pid: string, id: string,
): Promise<{ ok: boolean; data?: { id: string }; error?: string }> {
  const res = await fetchWithAuth(
    `/api/maintenance/equipment/${encodeURIComponent(id)}?pid=${encodeURIComponent(pid)}`,
    { method: 'DELETE' },
  );
  return parse<{ id: string }>(res);
}
