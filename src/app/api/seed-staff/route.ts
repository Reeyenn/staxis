import { NextResponse } from 'next/server';

// Seed endpoint — disabled after initial use
export async function POST() {
  return NextResponse.json({ error: 'Seed endpoint disabled' }, { status: 410 });
}
