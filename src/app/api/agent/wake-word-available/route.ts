// ─── GET /api/agent/wake-word-available ──────────────────────────────────
// Returns { available: boolean } based on whether the wake-word feature is
// fully wired up on this deploy:
//
//   1. PICOVOICE_ACCESS_KEY env var is set
//   2. public/wake-words/hey-staxis.ppn exists
//   3. public/wake-words/oye-staxis.ppn exists
//
// All three must be true. If any are false, the Settings toggle hides
// itself and the <WakeWord /> component refuses to initialize. This is
// the "feature gated behind asset presence" pattern from the master prompt.
//
// Auth: requireSession (so unauthenticated callers can't probe).

import type { NextRequest } from 'next/server';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { requireSession } from '@/lib/api-auth';
import { getOrMintRequestId } from '@/lib/log';
import { ok } from '@/lib/api-response';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 5;

const REQUIRED_KEYWORD_FILES = ['hey-staxis.ppn', 'oye-staxis.ppn'] as const;

function wakeWordReady(): boolean {
  if (!process.env.PICOVOICE_ACCESS_KEY) return false;
  // Vercel builds bundle public/ at the workspace root. Resolve relative to
  // the process cwd, which is the project root in both dev and production.
  const wakeWordDir = resolve(process.cwd(), 'public', 'wake-words');
  return REQUIRED_KEYWORD_FILES.every(name => existsSync(resolve(wakeWordDir, name)));
}

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = getOrMintRequestId(req);
  const auth = await requireSession(req);
  if (!auth.ok) return auth.response;

  return ok({ available: wakeWordReady() }, { requestId });
}
