/**
 * Retired endpoint. Toll-free verification (+18555141450) was confirmed on 2026-04-16.
 * This route is intentionally neutered. Safe to delete the file entirely.
 */
import { NextRequest } from 'next/server';
import { err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId } from '@/lib/log';

export async function POST(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  return err('gone', { requestId, status: 410, code: ApiErrorCode.Forbidden });
}

export async function GET(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  return err('gone', { requestId, status: 410, code: ApiErrorCode.Forbidden });
}
