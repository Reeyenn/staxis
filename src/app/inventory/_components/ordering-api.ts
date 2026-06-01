// Client helpers for the inventory Ordering API. Thin wrappers over
// fetchWithAuth that unwrap the standard { ok, data } envelope and throw on
// failure so callers can try/catch. Imports ONLY pure types from
// @/lib/ordering/types — never the server db/email libs (supabaseAdmin).

import { fetchWithAuth } from '@/lib/api-fetch';
import type {
  CartLineInput,
  OrderingMode,
  PurchaseOrder,
  ReceiveLineInput,
} from '@/lib/ordering/types';

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
