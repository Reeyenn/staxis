/**
 * /api/knowledge/contacts — vendor / emergency / brand / local directory.
 *
 *   GET    ?pid=                                       → list (ALL STAFF)
 *   POST   { pid, name, company?, phone?, email?, notes?, category?,
 *           address?, cityStateZip?, hours?, localCategory? }  → create (MANAGERS)
 *   PATCH  { pid, id, ...same fields }                 → edit   (MANAGERS)
 *   DELETE ?pid=&id=                                    → delete (MANAGERS)
 *
 * `category` is validated against CONTACT_CATEGORIES here (the DB check was
 * dropped in 0284 so new buckets need no migration). The local-only fields
 * (address / city_state_zip / hours / local_category) are optional; local_category
 * is validated against LOCAL_CATEGORIES and only kept when category === 'local'.
 *
 * Auth: commsContext; writes require the manage_knowledge capability
 * (default: every role; restricted per hotel from the Access tab). Service-role via core.
 */
import type { NextRequest } from 'next/server';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { validateUuid, validateString, validateEnum, validatePhone, isValidEmail } from '@/lib/api-validate';
import { capabilityDecisionForUserId } from '@/lib/capabilities/server';
import { capabilityUnavailableResponse } from '@/lib/capabilities/api-gate';
import { commsContext } from '@/lib/comms/route-helpers';
import { listContacts, createContact, updateContact, deleteContact, type ContactInput } from '@/lib/knowledge/core';
import { KNOWLEDGE_LIMITS, CONTACT_CATEGORIES, LOCAL_CATEGORIES } from '@/lib/knowledge/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function optionalString(v: unknown, max: number, label: string): { error?: string; value?: string | null } {
  if (v === undefined || v === null || v === '') return { value: null };
  const r = validateString(v, { max, label });
  if (r.error) return { error: r.error };
  return { value: r.value! };
}

function validateContactFields(raw: Record<string, unknown>): { error?: string; value?: ContactInput } {
  const nameV = validateString(raw.name, { max: KNOWLEDGE_LIMITS.CONTACT_NAME_MAX, label: 'name' });
  if (nameV.error) return { error: nameV.error };

  const companyV = optionalString(raw.company, KNOWLEDGE_LIMITS.COMPANY_MAX, 'company');
  if (companyV.error) return { error: companyV.error };
  const notesV = optionalString(raw.notes, KNOWLEDGE_LIMITS.NOTES_MAX, 'notes');
  if (notesV.error) return { error: notesV.error };

  const addressV = optionalString(raw.address, KNOWLEDGE_LIMITS.ADDRESS_MAX, 'address');
  if (addressV.error) return { error: addressV.error };
  const cityStateZipV = optionalString(raw.cityStateZip, KNOWLEDGE_LIMITS.ADDRESS_MAX, 'cityStateZip');
  if (cityStateZipV.error) return { error: cityStateZipV.error };
  const hoursV = optionalString(raw.hours, KNOWLEDGE_LIMITS.HOURS_MAX, 'hours');
  if (hoursV.error) return { error: hoursV.error };

  let phone: string | null = null;
  if (raw.phone !== undefined && raw.phone !== null && raw.phone !== '') {
    const phoneV = validatePhone(raw.phone, 'phone');
    if (phoneV.error) return { error: phoneV.error };
    phone = phoneV.value || null;
  }

  let email: string | null = null;
  if (raw.email !== undefined && raw.email !== null && raw.email !== '') {
    if (typeof raw.email !== 'string' || raw.email.length > KNOWLEDGE_LIMITS.EMAIL_MAX || !isValidEmail(raw.email)) {
      return { error: 'email is not a valid address' };
    }
    email = raw.email;
  }

  let category: ContactInput['category'] = null;
  if (raw.category !== undefined && raw.category !== null && raw.category !== '') {
    const catV = validateEnum(raw.category, CONTACT_CATEGORIES, 'category');
    if (catV.error) return { error: catV.error };
    category = catV.value!;
  }

  // local_category is a sub-type of the 'local' bucket only. Validate it against
  // LOCAL_CATEGORIES when present, and drop it entirely unless category==='local'
  // so a contact that's re-categorised away from Local can't keep a stale sub-type.
  let localCategory: string | null = null;
  if (category === 'local' && raw.localCategory !== undefined && raw.localCategory !== null && raw.localCategory !== '') {
    const lcV = validateEnum(raw.localCategory, LOCAL_CATEGORIES, 'localCategory');
    if (lcV.error) return { error: lcV.error };
    localCategory = lcV.value!;
  }

  return {
    value: {
      name: nameV.value!, company: companyV.value!, phone, email, notes: notesV.value!, category,
      address: addressV.value!, cityStateZip: cityStateZipV.value!, hours: hoursV.value!, localCategory,
    },
  };
}

export async function GET(req: NextRequest): Promise<Response> {
  const ctx = await commsContext(req, req.nextUrl.searchParams.get('pid'));
  if (!ctx.ok) return ctx.response;
  const contacts = await listContacts(ctx.pid);
  return ok({ contacts }, { requestId: ctx.requestId, headers: ctx.headers });
}

export async function POST(req: NextRequest): Promise<Response> {
  let raw: Record<string, unknown> & { pid?: string };
  try { raw = await req.json(); } catch { raw = {}; }

  const ctx = await commsContext(req, raw.pid ?? null);
  if (!ctx.ok) return ctx.response;
  const capabilityDecision = await capabilityDecisionForUserId(ctx.userId, 'manage_knowledge', ctx.pid);
  if (capabilityDecision === 'unavailable') return capabilityUnavailableResponse(ctx.requestId);
  if (capabilityDecision === 'denied') {
    return err('Only managers can add contacts', { requestId: ctx.requestId, status: 403, code: ApiErrorCode.Forbidden, headers: ctx.headers });
  }
  const v = validateContactFields(raw);
  if (v.error) return err(v.error, { requestId: ctx.requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers: ctx.headers });

  const { id } = await createContact(ctx.pid, v.value!, { accountId: ctx.accountId, name: ctx.displayName });
  return ok({ id }, { requestId: ctx.requestId, status: 201, headers: ctx.headers });
}

export async function PATCH(req: NextRequest): Promise<Response> {
  let raw: Record<string, unknown> & { pid?: string };
  try { raw = await req.json(); } catch { raw = {}; }

  const ctx = await commsContext(req, raw.pid ?? null);
  if (!ctx.ok) return ctx.response;
  const capabilityDecision = await capabilityDecisionForUserId(ctx.userId, 'manage_knowledge', ctx.pid);
  if (capabilityDecision === 'unavailable') return capabilityUnavailableResponse(ctx.requestId);
  if (capabilityDecision === 'denied') {
    return err('Only managers can edit contacts', { requestId: ctx.requestId, status: 403, code: ApiErrorCode.Forbidden, headers: ctx.headers });
  }
  const idV = validateUuid(raw.id, 'id');
  if (idV.error) return err(idV.error, { requestId: ctx.requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers: ctx.headers });
  const v = validateContactFields(raw);
  if (v.error) return err(v.error, { requestId: ctx.requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers: ctx.headers });

  const updated = await updateContact(ctx.pid, idV.value!, v.value!);
  if (!updated) return err('Not found', { requestId: ctx.requestId, status: 404, code: ApiErrorCode.NotFound, headers: ctx.headers });
  return ok({ id: idV.value }, { requestId: ctx.requestId, headers: ctx.headers });
}

export async function DELETE(req: NextRequest): Promise<Response> {
  const ctx = await commsContext(req, req.nextUrl.searchParams.get('pid'));
  if (!ctx.ok) return ctx.response;
  const capabilityDecision = await capabilityDecisionForUserId(ctx.userId, 'manage_knowledge', ctx.pid);
  if (capabilityDecision === 'unavailable') return capabilityUnavailableResponse(ctx.requestId);
  if (capabilityDecision === 'denied') {
    return err('Only managers can delete contacts', { requestId: ctx.requestId, status: 403, code: ApiErrorCode.Forbidden, headers: ctx.headers });
  }
  const idV = validateUuid(req.nextUrl.searchParams.get('id'), 'id');
  if (idV.error) return err(idV.error, { requestId: ctx.requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers: ctx.headers });

  const deleted = await deleteContact(ctx.pid, idV.value!);
  if (!deleted) return err('Not found', { requestId: ctx.requestId, status: 404, code: ApiErrorCode.NotFound, headers: ctx.headers });
  return ok({ id: idV.value }, { requestId: ctx.requestId, headers: ctx.headers });
}
