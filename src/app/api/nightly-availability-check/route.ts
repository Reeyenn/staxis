/**
 * Retired endpoint. The nightly "blast everyone" availability check was
 * replaced by the Housekeeping → Schedule "Send Confirmations" button, which
 * only texts the chosen crew (see /api/send-shift-confirmations).
 * Safe to delete this file entirely.
 */
import { NextResponse } from 'next/server';

export async function POST() {
  return NextResponse.json({ error: 'gone' }, { status: 410 });
}
