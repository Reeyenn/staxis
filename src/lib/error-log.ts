/**
 * Best-effort writer for public.error_logs.
 *
 * Four API routes were hand-rolling the same try/catch around an
 * error_logs insert, with an empty `} catch {}` that silently swallowed
 * any failure of the secondary write (May 2026 audit, findings M2-M5).
 * Mirrors the audit.ts pattern: surface the failure with log.warn so a
 * Postgres outage doesn't disappear, but never throw — the caller has
 * already logged the primary error and is on its way to returning a 500.
 *
 * Use log.warn rather than log.error: the actionable signal is the
 * outer error that brought us here. This is the secondary "even the
 * fallback write failed" signal — louder than silence, quieter than a
 * page.
 */

import { supabaseAdmin } from '@/lib/supabase-admin';
import { log } from '@/lib/log';

export interface ErrorLogInput {
  source: string;
  message: string;
  stack?: string | null;
}

export async function writeErrorLog(entry: ErrorLogInput): Promise<void> {
  try {
    await supabaseAdmin.from('error_logs').insert({
      source: entry.source,
      message: entry.message,
      stack: entry.stack ?? null,
    });
  } catch (err) {
    log.warn('[error-log] write failed', { source: entry.source, err });
  }
}
