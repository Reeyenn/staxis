'use client';

// ─── useConversationalSession — ElevenLabs Conversational AI client hook ───
//
// Wraps `@elevenlabs/client`'s Conversation SDK. Opens a WebSocket to
// ElevenLabs using a signed URL we mint server-side (so the browser never
// sees our workspace API key), streams mic input → ElevenLabs ASR →
// custom-LLM webhook (our /api/agent/voice-brain) → TTS → audio out.
//
// Why a single-shot signedUrl flow:
//   - The browser cannot hold an ElevenLabs API key. Sessions are bound
//     to a 5-min signed URL minted by /api/agent/voice-session.
//   - The mint endpoint also creates a fresh `agent_conversations` row
//     and bundles {accountId, propertyId, role, staffId, conversationId}
//     into ElevenLabs dynamic_variables so the brain webhook can rebuild
//     ToolContext without trusting anything the browser sends.
//
// Hot-path responsibilities the SDK handles for us (and we do NOT
// reinvent):
//   - getUserMedia + AudioContext lifecycle
//   - PCM streaming → ElevenLabs Scribe ASR
//   - VAD + turn detection + barge-in
//   - TTS audio playback (eleven_flash_v2)
//
// Our responsibilities:
//   - Mint the session.
//   - Map SDK events → a tiny status state machine the overlay renders.
//   - Surface transcript text for the bottom-bar.
//   - Stop cleanly on unmount or X click (release mic + abort fetches).

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Conversation, Mode, Status } from '@elevenlabs/client';
import { fetchWithAuth, SessionEndedError } from '@/lib/api-fetch';

export type ConversationStatus =
  | 'idle'
  | 'connecting'
  | 'listening'
  | 'thinking'
  | 'speaking'
  | 'denied'
  | 'capped'
  | 'error';

/** Operating mode for the voice session — forwarded to /api/agent/voice-session
 *  which persists it on the agent_voice_sessions row. The webhook reads it from
 *  the DB (not from dynamic_variables) and uses it to pick which subset of the
 *  tool catalog to expose. Feature #11. */
export type VoiceSessionMode = 'general' | 'housekeeper_issue';

interface UseConversationalSessionOpts {
  propertyId: string | null;
  /** Auto-start the session as soon as `propertyId` becomes non-null and
   *  the consumer flips `active` to true. The overlay uses this so the
   *  WebSocket opens in the same gesture frame that mounted the overlay. */
  active: boolean;
  /** Optional voice mode. Defaults to 'general' on the server. The
   *  housekeeper voice-issue mic passes 'housekeeper_issue'. */
  mode?: VoiceSessionMode;
  /** Optional room hint forwarded into the agent context (e.g. the room
   *  card the mic was tapped from). The agent defaults a room argument to
   *  this value when the user doesn't restate the room. */
  currentRoomNumber?: string | null;
}

interface SessionMintResponse {
  ok: boolean;
  data?: {
    signedUrl: string;
    agentId: string;
    conversationId: string;
    dynamicVariables: Record<string, string | number | boolean>;
  };
  error?: string;
}

export interface UseConversationalSessionReturn {
  status: ConversationStatus;
  /** The most recent finalized assistant utterance, rendered under the
   *  status line in the overlay. Updates whenever ElevenLabs emits a
   *  full agent response (not per-token streaming). */
  lastAssistant: string;
  /** The most recent finalized user transcript. Surfaced so the overlay
   *  could optionally echo what was heard (not currently shown — kept
   *  for future UX iteration). */
  lastUser: string;
  /** Plain-language error message when status === 'error'. */
  error: string | null;
  /** End the session and release the mic. Safe to call multiple times. */
  stop: () => void;
  /** The server-minted voice-session id (a UUID). Surfaced here so the
   *  housekeeper voice-issue UI can poll /api/agent/voice-issue/status to
   *  see whether the agent actually fired the tool — replacing the brittle
   *  "count assistant messages" heuristic. Null until the mint round-trip
   *  finishes. Feature #11 / Codex 2026-05-25 MAJOR fix. */
  voiceSessionId: string | null;
}

export function useConversationalSession(opts: UseConversationalSessionOpts): UseConversationalSessionReturn {
  const { propertyId, active, mode, currentRoomNumber } = opts;

  const [status, setStatus] = useState<ConversationStatus>('idle');
  const [lastAssistant, setLastAssistant] = useState('');
  const [lastUser, setLastUser] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [voiceSessionId, setVoiceSessionId] = useState<string | null>(null);

  const conversationRef = useRef<Conversation | null>(null);
  // Ratcheted by the start effect — only the first invocation in this
  // render-frame actually opens a session, even if React StrictMode
  // double-invokes the effect during dev.
  const startedRef = useRef(false);

  const stop = useCallback(() => {
    const conv = conversationRef.current;
    conversationRef.current = null;
    startedRef.current = false;
    if (conv) {
      // endSession resolves once the SDK has released the mic + closed
      // the WS. We don't await — by the time React unmounts the overlay,
      // the cleanup is fire-and-forget.
      conv.endSession().catch(() => { /* already ended */ });
    }
    setStatus('idle');
    // Don't clear voiceSessionId here — the VoiceIssueButton needs it AFTER
    // the session ends to poll the status endpoint and confirm the ticket
    // landed. Cleared at the next mint instead.
  }, []);

  useEffect(() => {
    if (!active || !propertyId) return;
    if (startedRef.current) return;
    startedRef.current = true;

    let cancelled = false;
    setStatus('connecting');
    setError(null);
    // Clear the previous session's id BEFORE the new mint round-trip so
    // a consumer can't get confused into polling for a ticket against
    // last session's id. Set again once the new mint succeeds.
    setVoiceSessionId(null);

    // Codex 2026-05-25 (MAJOR fix): under React StrictMode the effect
    // runs twice in dev — setup, cleanup, setup again. The first setup
    // fires the mint POST; cleanup sets `cancelled=true` but the in-flight
    // fetch keeps going server-side and writes a row into
    // agent_voice_sessions. Without an AbortController the orphan row
    // exists forever; with one, the network request is cancelled the
    // moment cleanup runs and the row is never created.
    const mintAbort = new AbortController();

    void (async () => {
      // 1. Mint a signed URL.
      let mintData: SessionMintResponse['data'] | null = null;
      try {
        const res = await fetchWithAuth('/api/agent/voice-session', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            propertyId,
            // Feature #11: forward voice mode + room hint to the mint
            // endpoint so the housekeeper-issue path lands on a session
            // pre-scoped to the createMaintenanceWorkOrder tool.
            mode: mode ?? 'general',
            currentRoomNumber: currentRoomNumber ?? null,
          }),
          signal: mintAbort.signal,
        });
        if (res.status === 429) {
          if (!cancelled) { setStatus('capped'); setError("You've hit today's voice limit."); }
          return;
        }
        if (!res.ok) {
          const body = await res.json().catch(() => null);
          // fetchWithAuth handles recoverable 401s (refresh+retry or hard
          // signout); the only 401 that reaches here is `auth_unavailable`.
          // Surface a friendlier message instead of "invalid session token".
          const friendly = body?.code === 'auth_unavailable'
            ? 'Sign-in service is temporarily unavailable. Try again in a moment.'
            : ((body?.error as string) ?? 'Failed to start voice session.');
          if (!cancelled) {
            setStatus('error');
            setError(friendly);
          }
          return;
        }
        const body: SessionMintResponse = await res.json();
        mintData = body.data ?? null;
      } catch (e) {
        if (e instanceof SessionEndedError) return;  // redirect in progress; let it happen
        // AbortError from the mintAbort controller is expected during
        // StrictMode cleanup — treat it as a silent cancellation, not a
        // user-facing error.
        if (e instanceof DOMException && e.name === 'AbortError') return;
        if (!cancelled) {
          setStatus('error');
          setError('Network error starting voice session.');
        }
        return;
      }
      if (cancelled || !mintData) return;

      // Surface the server-minted voice session id so consumers (e.g. the
      // VoiceIssueButton polling for ticket status) can hit the status
      // endpoint with a UUID they didn't have to guess. The id rides in
      // the dynamic_variables payload under the well-known key — same
      // value the webhook re-resolves on every turn.
      const mintedVoiceSessionId = mintData.dynamicVariables?.['staxis_voice_session_id'];
      if (typeof mintedVoiceSessionId === 'string') {
        setVoiceSessionId(mintedVoiceSessionId);
      }

      // 2. Open the conversation with the SDK.
      try {
        // Imported lazily so the SDK + its audio worklets aren't pulled
        // into the bundle on pages that never open voice mode.
        const mod = await import('@elevenlabs/client');
        if (cancelled) return;
        // The variables our brain webhook needs to reconstruct ToolContext
        // (account, property, role, staff, conversation IDs) MUST go on the
        // ElevenLabs `customLlmExtraBody` field — that's the one the gateway
        // forwards verbatim as `extra_body` in the OpenAI chat-completions
        // POST to /api/agent/voice-brain. `dynamicVariables` is a SEPARATE
        // field that ElevenLabs only uses for its OWN prompt-template
        // substitution ({{var}} placeholders in the agent's first_message
        // / system prompt) — never forwarded to a custom LLM. Both fields
        // are still set so a future template-substitution feature works
        // without another deploy. The "custom_llm_error: Failed to
        // generate response from custom LLM" 2026-05-14 was traced to this
        // exact mix-up: variables were forwarded to template substitution
        // (a no-op for us — empty first_message) and not to the webhook.
        // Verified against SDK lib.iife.js lines 471-472.
        if (!mintData.dynamicVariables || Object.keys(mintData.dynamicVariables).length === 0) {
          if (!cancelled) {
            setStatus('error');
            setError('Voice session minted without context — please reload.');
          }
          return;
        }
        const conversation = await mod.Conversation.startSession({
          signedUrl: mintData.signedUrl,
          connectionType: 'websocket',
          customLlmExtraBody: { dynamic_variables: mintData.dynamicVariables },
          dynamicVariables: mintData.dynamicVariables,
          // Self-host the AudioWorklet processors. The SDK normally
          // inlines their source code, base64s it into a data: URI, and
          // calls addModule(). Strict CSPs (ours included) refuse that
          // path, and the SDK throws "Failed to load the audioConcat
          // Processor worklet module". Pointing workletPaths at static
          // files under public/elevenlabs/ makes addModule() load them
          // as plain same-origin scripts — covered by `script-src 'self'`
          // and `worker-src 'self'` without any CSP relaxation.
          //
          // These files are generated by `scripts/extract-elevenlabs-
          // worklets.mjs` from the SDK bundle and committed under
          // public/elevenlabs/. Re-run that script whenever the SDK is
          // upgraded so the extracted source stays in sync.
          workletPaths: {
            rawAudioProcessor: '/elevenlabs/rawAudioProcessor.js',
            audioConcatProcessor: '/elevenlabs/audioConcatProcessor.js',
          },
          onConnect: () => {
            if (cancelled) return;
            setStatus('listening');
          },
          onDisconnect: (details) => {
            if (cancelled) return;
            // 'user' = we called endSession; not an error. Anything else
            // is a network/server hangup and we surface it.
            if (details.reason !== 'user') {
              const msg = details.reason === 'error'
                ? (details.message ?? 'Connection error.')
                : 'Voice session ended.';
              setError(msg);
              setStatus('error');
            } else {
              setStatus('idle');
            }
            conversationRef.current = null;
          },
          onError: (message) => {
            if (cancelled) return;
            // The SDK's onError fires for mic permission failures + WS
            // errors. The message text differentiates them; we coarse-
            // grain to one of our status enums.
            const lower = message.toLowerCase();
            if (lower.includes('mic') || lower.includes('media') || lower.includes('permission')) {
              setStatus('denied');
              setError('Mic blocked. Enable microphone access in browser settings.');
            } else {
              setStatus('error');
              setError(message);
            }
          },
          onModeChange: ({ mode }: { mode: Mode }) => {
            if (cancelled) return;
            // ElevenLabs' two-state lifecycle. We map to our richer enum:
            // 'speaking' (agent talking) → 'speaking'
            // 'listening' (mic open) → 'listening'
            // Note: during the brief moment between user-done-talking and
            // agent-starts-talking the SDK leaves mode as 'listening' —
            // there's no explicit 'thinking' event. We could detect via
            // onMessage but the overlay reads 'listening' as "you can
            // speak" which is misleading. Best compromise: leave it.
            setStatus(mode === 'speaking' ? 'speaking' : 'listening');
          },
          onStatusChange: ({ status: s }: { status: Status }) => {
            if (cancelled) return;
            if (s === 'connecting') setStatus('connecting');
            else if (s === 'disconnected') setStatus('idle');
            // 'connected' is handled by onConnect (sets 'listening').
          },
          onMessage: ({ role, message }) => {
            if (cancelled) return;
            // Finalized utterance. Role 'agent' = assistant text;
            // role 'user' = transcribed mic input. We update the bar's
            // displayed text on each finalization.
            if (role === 'agent') setLastAssistant(message);
            else if (role === 'user') setLastUser(message);
          },
        });
        if (cancelled) {
          conversation.endSession().catch(() => {});
          return;
        }
        conversationRef.current = conversation;
      } catch (e) {
        if (cancelled) return;
        const msg = e instanceof Error ? e.message : String(e);
        const lower = msg.toLowerCase();
        if (lower.includes('mic') || lower.includes('media') || lower.includes('permission') || lower.includes('notallowed')) {
          setStatus('denied');
          setError('Mic blocked. Enable microphone access in browser settings.');
        } else {
          setStatus('error');
          setError(msg);
        }
      }
    })();

    return () => {
      cancelled = true;
      // Cancel any in-flight mint POST so StrictMode's setup/cleanup/setup
      // double-fire doesn't write two agent_voice_sessions rows.
      mintAbort.abort();
      const conv = conversationRef.current;
      conversationRef.current = null;
      startedRef.current = false;
      if (conv) conv.endSession().catch(() => {});
    };
  }, [active, propertyId, mode, currentRoomNumber]);

  return { status, lastAssistant, lastUser, error, stop, voiceSessionId };
}
