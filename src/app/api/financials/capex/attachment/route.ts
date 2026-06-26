/**
 * /api/financials/capex/attachment — upload / view a project's quote or photo
 * (the CapEx binder). Owner/GM/admin only; service-role storage, never anon.
 *
 *   POST { pid, projectId, imageBase64, mediaType }  → store + set attachment_path
 *   GET  ?pid=&projectId=                            → short-lived signed URL
 *
 * The project is re-verified to belong to pid before any write/read, so a forged
 * projectId from another hotel can't attach to or read another property's binder.
 */

import type { NextRequest } from 'next/server';
import { requireFinanceAccess } from '@/lib/financials/api-gate';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { ok, err } from '@/lib/api-response';
import { validateUuid } from '@/lib/api-validate';
import { declaredMimeMatchesBytes } from '@/lib/inspections';
import { getCapexProject, setCapexAttachment } from '@/lib/financials/db';
import { log } from '@/lib/log';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const BUCKET = 'capex-attachments';
const MIME_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'image/heif': 'heif',
  'application/pdf': 'pdf',
};
const MAX_BYTES = 10 * 1024 * 1024;

export async function POST(req: NextRequest): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const gate = await requireFinanceAccess(req, body.pid as string | undefined);
  if (!gate.ok) return gate.response;

  // projectId is a UUID column — validate it strictly so it can never carry
  // path separators / '..' into the storage object key below. (Security audit
  // 2026-06-26.)
  const projCheck = validateUuid(body.projectId, 'projectId');
  if (projCheck.error || !projCheck.value) return err('projectId must be a valid UUID', { requestId: gate.requestId, status: 400, code: 'invalid_project' });

  const mediaType = typeof body.mediaType === 'string' ? body.mediaType : '';
  const ext = MIME_EXT[mediaType];
  if (!ext) return err('unsupported attachment type', { requestId: gate.requestId, status: 400, code: 'unsupported_media_type' });

  const imageBase64 = body.imageBase64;
  if (typeof imageBase64 !== 'string' || imageBase64.length < 100) {
    return err('invalid attachment', { requestId: gate.requestId, status: 400, code: 'invalid_attachment' });
  }
  let buffer: Buffer;
  try {
    buffer = Buffer.from(imageBase64, 'base64');
  } catch {
    return err('invalid attachment', { requestId: gate.requestId, status: 400, code: 'invalid_attachment' });
  }
  if (buffer.length === 0 || buffer.length > MAX_BYTES) {
    return err('attachment too large', { requestId: gate.requestId, status: 400, code: 'too_large' });
  }

  // Don't trust the client-declared mediaType: confirm the bytes match.
  // Images get a magic-byte sniff; PDFs must start with the %PDF- header.
  // (heic/heif have no cheap header sniff and the uploader is already a
  // gated manager, so they're accepted as declared.) (Security audit 2026-06-26.)
  if (mediaType === 'application/pdf') {
    if (buffer.subarray(0, 5).toString('latin1') !== '%PDF-') {
      return err('attachment bytes do not match declared type', { requestId: gate.requestId, status: 400, code: 'content_mismatch' });
    }
  } else if (mediaType === 'image/jpeg' || mediaType === 'image/png' || mediaType === 'image/webp') {
    if (!declaredMimeMatchesBytes(mediaType, new Uint8Array(buffer))) {
      return err('attachment bytes do not match declared type', { requestId: gate.requestId, status: 400, code: 'content_mismatch' });
    }
  }

  // Project must belong to this property.
  const project = await getCapexProject(gate.pid, projCheck.value);
  if (!project) return err('project not found', { requestId: gate.requestId, status: 404, code: 'not_found' });

  const path = `${gate.pid}/${projCheck.value}.${ext}`;
  const { error: upErr } = await supabaseAdmin.storage.from(BUCKET).upload(path, buffer, {
    contentType: mediaType,
    upsert: true,
  });
  if (upErr) {
    log.error('[financials/capex/attachment] upload failed', { pid: gate.pid, err: new Error(upErr.message) });
    return err('upload failed', { requestId: gate.requestId, status: 500, code: 'upload_failed' });
  }
  await setCapexAttachment(gate.pid, projCheck.value, path);
  return ok({ attachmentPath: path }, { requestId: gate.requestId });
}

export async function GET(req: NextRequest): Promise<Response> {
  const pid = req.nextUrl.searchParams.get('pid');
  const gate = await requireFinanceAccess(req, pid);
  if (!gate.ok) return gate.response;

  const projCheck = validateUuid(req.nextUrl.searchParams.get('projectId'), 'projectId');
  if (projCheck.error || !projCheck.value) return err('projectId must be a valid UUID', { requestId: gate.requestId, status: 400, code: 'invalid_project' });
  const projectId = projCheck.value;

  const project = await getCapexProject(gate.pid, projectId);
  if (!project) return err('project not found', { requestId: gate.requestId, status: 404, code: 'not_found' });
  if (!project.attachmentPath) return ok({ url: null }, { requestId: gate.requestId });

  // Defense in depth: the stored path is always prefixed with this property id,
  // so a tampered row can't point at another hotel's object.
  if (!project.attachmentPath.startsWith(`${gate.pid}/`)) {
    return ok({ url: null }, { requestId: gate.requestId });
  }

  const { data, error } = await supabaseAdmin.storage.from(BUCKET).createSignedUrl(project.attachmentPath, 300);
  if (error) return ok({ url: null }, { requestId: gate.requestId });
  return ok({ url: data?.signedUrl ?? null }, { requestId: gate.requestId });
}
