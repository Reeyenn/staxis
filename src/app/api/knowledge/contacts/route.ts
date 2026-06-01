/**
 * /api/knowledge/contacts — vendor / emergency / brand / local directory.
 *
 *   GET    ?pid=                                       → list (ALL STAFF)
 *   POST   { pid, name, company?, phone?, email?, notes?, category? }  → create (MANAGERS)
 *   PATCH  { pid, id, ...same fields }                 → edit   (MANAGERS)
 *   DELETE ?pid=&id=                                    → delete (MANAGERS)
 *
 * Auth: commsContext; writes require canManageTeam. Service-role via core.
 */
import type { NextRequest } from 'next/server';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { validateUuid, validateString, validateEnum, validatePhone, isValidEmail } from '@/lib/api-validate';
import { canManageTeam, type AppRole } from '@/lib/roles';
import { commsContext } from '@/lib/comms/route-helpers';
import { listContacts, createContact, updateContact, deleteContact, type ContactInput } from '@/lib/knowledge/core';
import { KNOWLEDGE_LIMITS, CONTACT_CATEGORIES } from '@/lib/knowledge/types';

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

  return { value: { name: nameV.value!, company: companyV.value!, phone, email, notes: notesV.value!, category } };
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
  if (!canManageTeam(ctx.role as AppRole)) {
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
  if (!canManageTeam(ctx.role as AppRole)) {
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
  if (!canManageTeam(ctx.role as AppRole)) {
    return err('Only managers can delete contacts', { requestId: ctx.requestId, status: 403, code: ApiErrorCode.Forbidden, headers: ctx.headers });
  }
  const idV = validateUuid(req.nextUrl.searchParams.get('id'), 'id');
  if (idV.error) return err(idV.error, { requestId: ctx.requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers: ctx.headers });

  const deleted = await deleteContact(ctx.pid, idV.value!);
  if (!deleted) return err('Not found', { requestId: ctx.requestId, status: 404, code: ApiErrorCode.NotFound, headers: ctx.headers });
  return ok({ id: idV.value }, { requestId: ctx.requestId, headers: ctx.headers });
}
