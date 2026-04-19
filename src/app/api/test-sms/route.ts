/**
 * Retired endpoint. Toll-free verification (+18555141450) was confirmed on 2026-04-16.
 * This route is intentionally neutered. Safe to delete the file entirely.
 */
import { NextResponse } from 'next/server';

export async function POST() {
  return NextResponse.json({ error: 'gone' }, { status: 410 });
}

export async function GET() {
  return NextResponse.json({ error: 'gone' }, { status: 410 });
}
