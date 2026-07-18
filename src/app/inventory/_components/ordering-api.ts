// Client helpers for the inventory vendors API. Thin wrappers over
// fetchWithAuth that unwrap the standard { ok, data } envelope and throw on
// failure so callers can try/catch. Imports ONLY pure types from
// @/lib/ordering/types — never the server db lib (supabaseAdmin).
//
// 2026-07-18: the purchase-order flow (create/send/receive orders, catalog,
// spend rollup) was removed — every hotel orders differently and the flow is
// being redesigned as a per-hotel workflow. Vendors survive because inventory
// items link to a vendor record (AddItemSheet).

import { fetchWithAuth } from '@/lib/api-fetch';
import type { Vendor } from '@/lib/ordering/types';

export interface VendorFields {
  name?: string;
  email?: string | null;
  phone?: string | null;
  accountNumber?: string | null;
  notes?: string | null;
  isActive?: boolean;
}

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetchWithAuth(url, init);
  let json: { ok?: boolean; data?: T; error?: string } = {};
  try {
    json = await res.json();
  } catch {
    /* fall through to status check */
  }
  if (!res.ok || !json.ok) {
    throw new Error(json.error || `request failed (${res.status})`);
  }
  return json.data as T;
}

const jsonInit = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

export async function apiListVendors(pid: string, includeInactive = false): Promise<Vendor[]> {
  const qs = `pid=${encodeURIComponent(pid)}${includeInactive ? '&includeInactive=1' : ''}`;
  const data = await call<{ vendors: Vendor[] }>(`/api/inventory/vendors?${qs}`, { cache: 'no-store' });
  return data.vendors;
}

export async function apiCreateVendor(pid: string, fields: VendorFields): Promise<Vendor> {
  const data = await call<{ vendor: Vendor }>('/api/inventory/vendors', jsonInit({ pid, ...fields }));
  return data.vendor;
}

export async function apiUpdateVendor(pid: string, vendorId: string, fields: VendorFields): Promise<Vendor> {
  const data = await call<{ vendor: Vendor }>('/api/inventory/vendors', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pid, vendorId, ...fields }),
  });
  return data.vendor;
}
