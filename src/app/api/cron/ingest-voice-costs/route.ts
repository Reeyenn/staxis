/**
 * GET /api/cron/ingest-voice-costs
 *
 * 2026-06-26 pre-onboarding audit fix. The voice assistant's ElevenLabs
 * Conversational AI minutes were billed OFF-ledger: /api/agent/voice-brain
 * books only the Claude brain tokens for each turn, and /api/agent/speak
 * books TTS character cost — but the per-minute ElevenLabs *platform* charge
 * for the realtime conversation socket (minted by /api/agent/voice-session)
 * was recorded NOWHERE, so it never counted toward the daily $ cap.
 *
 * This cron closes that gap with a periodic pull (no ElevenLabs dashboard
 * webhook/secret to configure — self-contained, uses the API key we already
 * have): for each ended voice session that hasn't been billed yet, fetch the
 * conversation's call duration from ElevenLabs and book duration × a per-
 * minute USD rate into the agent_costs ledger as kind='audio'. assertAudioBudget
 * sums ALL kinds, so the daily user/property/global caps now include voice.
 *
 * Idempotency: agent_voice_sessions.elevenlabs_cost_ingested_at is the claim
 * marker. We claim a row with a conditional UPDATE (`... where ... is null
 * returning id`) BEFORE recording the cost, so two overlapping cron ticks can
 * never double-bill. The duration + computed cost are written onto the row in
 * the same UPDATE, so the value is preserved for reconciliation even if the
 * subsequent agent_costs insert fails (rare — deleted account/property FK).
 *
 * Auth: CRON_SECRET bearer (same as every other cron). Scheduled in
 * vercel.json every 15 min; registered in EXPECTED_CRONS + SCHEDULE_REGISTRY.
 */

import { NextRequest } from 'next/server';
import { requireCronSecret } from '@/lib/api-auth';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { recordNonRequestCost } from '@/lib/agent/cost-controls';
import { elevenLabsFetch, ELEVENLABS_SHORT_TIMEOUT_MS } from '@/lib/elevenlabs-client';
import { getOrMintRequestId, log } from '@/lib/log';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { writeCronHeartbeat } from '@/lib/cron-heartbeat';
import { captureException } from '@/lib/sentry';
import { env } from '@/lib/env';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// Fallback per-minute USD for ElevenLabs Conversational AI platform time.
// A deterministic guardrail figure (the cap only needs a defensible per-minute
// rate, not a to-the-penny invoice match) — overridable via env without a
// code change. Reconcile against a real ElevenLabs invoice if it drifts.
// TODO(audit-2026-06-26): confirm against the active ElevenLabs plan's ConvAI
// per-minute rate; custom-LLM path excludes their LLM but the platform/STT/TTS
// per-minute charge still applies.
const DEFAULT_VOICE_USD_PER_MINUTE = 0.10;

// How many sessions to settle per tick. Each does one ElevenLabs GET; 50 fits
// comfortably inside the 60s function cap when ElevenLabs is healthy.
const BATCH = 50;

// Wall-time budget for the sequential GET loop. If ElevenLabs is degraded
// (slow-but-not-erroring, ~10s/GET), 50 GETs would blow past maxDuration=60 and
// Vercel would kill the function mid-batch. Break cleanly before that so we
// return a summary; unsettled rows are claimed idempotently next tick.
const MAX_LOOP_MS = 45_000;

// A session whose last webhook turn was older than this is treated as ended
// (the idle-expiry on voice sessions is 5 min). Pre-filter so we don't hammer
// the ElevenLabs API for still-active calls; the conversation status is the
// authoritative end signal below.
const ENDED_GRACE_MS = 3 * 60_000;

// Don't chase sessions older than this — a permanently-unbillable row (deleted
// account, ElevenLabs 404 forever) ages out instead of being retried every tick.
const MAX_AGE_MS = 3 * 24 * 60 * 60_000;

interface VoiceSessionRow {
  id: string;
  account_id: string;
  property_id: string;
  conversation_id: string | null;
  elevenlabs_conversation_id: string;
  last_turn_at: string | null;
}

interface ElevenLabsConversation {
  status?: string;
  metadata?: { call_duration_secs?: number } | null;
}

// ElevenLabs conversation statuses that are NOT terminal — the call is still
// live, so skip and retry next tick. Anything else (done / processing / failed
// / unknown) means the call ended and the reported duration is final.
const STILL_ACTIVE_STATUSES = new Set(['initiated', 'in-progress', 'in_progress']);

export async function GET(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const startedAt = Date.now();

  const unauth = requireCronSecret(req);
  if (unauth) return unauth;

  const apiKey = env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    // Voice not configured for this deployment — nothing to ingest. Heartbeat
    // so the doctor sees the cron is alive; this is not an error.
    log.info('[cron/ingest-voice-costs] ELEVENLABS_API_KEY unset — skipping', { requestId });
    await writeCronHeartbeat('ingest-voice-costs', { requestId, notes: { skipped: 'no_api_key' } });
    return ok({ skipped: 'no_api_key', scanned: 0, billed: 0, pending: 0, totalUsd: 0 }, { requestId });
  }

  const usdPerMinute = env.STAXIS_VOICE_USD_PER_MINUTE ?? DEFAULT_VOICE_USD_PER_MINUTE;
  const agentId = env.ELEVENLABS_AGENT_ID ?? null;

  const now = Date.now();
  const { data, error } = await supabaseAdmin
    .from('agent_voice_sessions')
    .select('id, account_id, property_id, conversation_id, elevenlabs_conversation_id, last_turn_at')
    .not('elevenlabs_conversation_id', 'is', null)
    .is('elevenlabs_cost_ingested_at', null)
    .gt('created_at', new Date(now - MAX_AGE_MS).toISOString())
    .lt('last_turn_at', new Date(now - ENDED_GRACE_MS).toISOString())
    .order('last_turn_at', { ascending: true })
    .limit(BATCH);

  if (error) {
    log.error('[cron/ingest-voice-costs] session query failed', { requestId, msg: error.message });
    return err('voice-cost session query failed', {
      requestId, status: 500, code: ApiErrorCode.InternalError, details: { detail: error.message },
    });
  }

  const sessions = (data ?? []) as VoiceSessionRow[];
  let scanned = 0;
  let billed = 0;
  let pending = 0; // still-active or transient-fetch-failure → retry next tick
  let deferred = 0; // not reached this tick (wall-time budget) → next tick
  let totalUsd = 0;

  for (const s of sessions) {
    if (Date.now() - startedAt > MAX_LOOP_MS) {
      deferred = sessions.length - scanned;
      log.warn('[cron/ingest-voice-costs] wall-time budget hit — deferring rest', { requestId, deferred });
      break;
    }
    scanned++;
    try {
      // 1. Fetch the conversation to get the authoritative duration + status.
      const r = await elevenLabsFetch(
        `/v1/convai/conversations/${encodeURIComponent(s.elevenlabs_conversation_id)}`,
        { timeoutMs: ELEVENLABS_SHORT_TIMEOUT_MS, diagnosticLabel: 'ingest-voice-costs.conversation' },
      );
      if (!r.ok) {
        // Transient (5xx/429) or not-yet-indexed (404) — leave un-ingested and
        // retry next tick. The MAX_AGE_MS window ages out permanent failures.
        pending++;
        continue;
      }
      const payload = (await r.json()) as ElevenLabsConversation;
      const status = (payload.status ?? '').toLowerCase();
      if (STILL_ACTIVE_STATUSES.has(status)) {
        pending++;
        continue;
      }

      const durationSecs = Math.max(0, Math.round(payload.metadata?.call_duration_secs ?? 0));
      const costUsd = Math.round((durationSecs / 60) * usdPerMinute * 1_000_000) / 1_000_000;

      // 2. Atomic claim: mark ingested (with duration + cost) ONLY if not
      //    already claimed. Wins the race against a concurrent tick. Writing the
      //    cost here preserves it for reconciliation even if the ledger insert
      //    below throws.
      const { data: claimed, error: claimErr } = await supabaseAdmin
        .from('agent_voice_sessions')
        .update({
          elevenlabs_cost_ingested_at: new Date().toISOString(),
          elevenlabs_call_duration_secs: durationSecs,
          elevenlabs_cost_usd: costUsd,
        })
        .eq('id', s.id)
        .is('elevenlabs_cost_ingested_at', null)
        .select('id')
        .maybeSingle();
      if (claimErr) {
        log.warn('[cron/ingest-voice-costs] claim update failed', { requestId, sessionId: s.id, msg: claimErr.message });
        pending++;
        continue;
      }
      if (!claimed) {
        // Another tick claimed it first — don't double-bill.
        continue;
      }

      // 3. Book the cost into the ledger (kind='audio' → counts toward the
      //    daily caps via assertAudioBudget). recordNonRequestCost early-returns
      //    on costUsd<=0, so a 0-duration session is marked ingested but books
      //    nothing.
      if (costUsd > 0) {
        try {
          await recordNonRequestCost({
            userId: s.account_id,
            propertyId: s.property_id,
            conversationId: s.conversation_id,
            model: 'elevenlabs-convai',
            modelId: agentId,
            tokensIn: 0,
            tokensOut: 0,
            costUsd,
            kind: 'audio',
          });
        } catch (recErr) {
          // Row is already marked ingested (cost stored on it for reconciliation);
          // surface so the lost ledger row is visible. Don't abort the batch.
          const e = recErr instanceof Error ? recErr : new Error(String(recErr));
          log.error('[cron/ingest-voice-costs] recordNonRequestCost failed (cost stored on session row)', {
            requestId, sessionId: s.id, propertyId: s.property_id, costUsd, msg: e.message,
          });
          captureException(e, { subsystem: 'cost-ledger', route: 'ingest-voice-costs', severity: 'high', propertyId: s.property_id, cost_usd: costUsd });
        }
      }
      billed++;
      totalUsd += costUsd;
    } catch (loopErr) {
      // Per-row safety net (e.g. ElevenLabs fetch threw) — leave for retry.
      log.warn('[cron/ingest-voice-costs] session settle threw', { requestId, sessionId: s.id, msg: loopErr instanceof Error ? loopErr.message : String(loopErr) });
      pending++;
    }
  }

  const durationMs = Date.now() - startedAt;
  totalUsd = Math.round(totalUsd * 1_000_000) / 1_000_000;
  log.info('[cron/ingest-voice-costs] tick', { requestId, scanned, billed, pending, deferred, totalUsd, durationMs });
  await writeCronHeartbeat('ingest-voice-costs', { requestId, notes: { scanned, billed, pending, deferred, totalUsd } });
  return ok({ scanned, billed, pending, deferred, totalUsd, durationMs }, { requestId });
}
