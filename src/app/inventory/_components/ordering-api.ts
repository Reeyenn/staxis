// Client helpers for the inventory Ordering API. Thin wrappers over
// fetchWithAuth that unwrap the standard { ok, data } envelope and throw on
// failure so callers can try/catch. Imports ONLY pure types from
// @/lib/ordering/types — never the server db/email libs (supabaseAdmin).

import { fetchWithAuth } from '@/lib/api-fetch';
import type {
  CartLineInput,
  CatalogItem,
  OrderingMode,
  PurchaseOrder,
  ReceiveLineInput,
  Vendor,
} from '@/lib/ordering/types';

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

export async function apiCreateOrders(
  pid: string,
  lines: CartLineInput[],
): Promise<{ orders: PurchaseOrder[]; mode: OrderingMode }> {
  return call('/api/inventory/orders/create', jsonInit({ pid, lines }));
}

export async function apiSendOrder(
  pid: string,
  orderId: string,
  toEmail: string | undefined,
  lang: string,
): Promise<{ order: PurchaseOrder; emailId: string }> {
  return call('/api/inventory/orders/send', jsonInit({ pid, orderId, toEmail, lang }));
}

export async function apiApproveOrder(
  pid: string,
  orderId: string,
): Promise<{ order: PurchaseOrder }> {
  return call('/api/inventory/orders/approve', jsonInit({ pid, orderId }));
}

export async function apiReceiveOrder(
  pid: string,
  orderId: string,
  lines: ReceiveLineInput[],
): Promise<{ order: PurchaseOrder; shortLines: { lineId: string; ordered: number; received: number }[] }> {
  return call('/api/inventory/orders/receive', jsonInit({ pid, orderId, lines }));
}

export async function apiListOrders(pid: string): Promise<PurchaseOrder[]> {
  const data = await call<{ orders: PurchaseOrder[] }>(
    `/api/inventory/orders/list?pid=${encodeURIComponent(pid)}`,
    { cache: 'no-store' },
  );
  return data.orders;
}

export async function apiGetMode(pid: string): Promise<OrderingMode> {
  const data = await call<{ mode: OrderingMode }>(
    `/api/inventory/ordering-mode?pid=${encodeURIComponent(pid)}`,
    { cache: 'no-store' },
  );
  return data.mode;
}

export async function apiSetMode(pid: string, mode: OrderingMode): Promise<void> {
  await call('/api/inventory/ordering-mode', jsonInit({ pid, mode }));
}

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

export async function apiListCatalog(pid: string): Promise<CatalogItem[]> {
  const data = await call<{ items: CatalogItem[] }>(
    `/api/inventory/catalog?pid=${encodeURIComponent(pid)}`,
    { cache: 'no-store' },
  );
  return data.items;
}

export async function apiImportCatalog(pid: string): Promise<{ imported: number; skipped: number }> {
  return call('/api/inventory/catalog/import', jsonInit({ pid }));
}
