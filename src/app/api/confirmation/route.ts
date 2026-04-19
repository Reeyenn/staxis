/**
 * Retired endpoint. Replaced by the text-reply flow — see /api/sms-reply.
 * Kept as a 410 stub so any stale link silently 410s instead of 404ing.
 * Safe to delete this file entirely once no old links are floating around.
 */
import { NextResponse } from 'next/server';

export async function GET() {
  return NextResponse.json({ error: 'gone' }, { status: 410 });
}
export async function POST() {
  return NextResponse.json({ error: 'gone' }, { status: 410 });
}
