// ─── OpenAI client singleton ──────────────────────────────────────────────
//
// The agent layer uses Anthropic for chat (claude-sonnet-4-6 etc). The
// voice surface uses OpenAI for Whisper (STT) and TTS-1 (Nova voice) —
// both are cheaper than Anthropic equivalents and Whisper specifically
// handles accents + Spanish code-switching better than alternatives.
//
// Mirrors the lazy-getter pattern from src/lib/vision-extract.ts:
//   - Singleton per process (avoids reconstructing the HTTPS agent on
//     every request)
//   - Throws loudly if OPENAI_API_KEY is missing — Sentry catches and
//     the doctor route's REQUIRED_ENV_VARS check fails green
//   - 30s timeout aligns with Whisper's typical worst-case (long files
//     take a few seconds; we accept up to 30 before bailing)

import OpenAI from 'openai';

const REQUEST_TIMEOUT_MS = 30_000;

let _client: OpenAI | null = null;

export function getOpenAIClient(): OpenAI {
  if (_client) return _client;
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error(
      'OPENAI_API_KEY is not set. Required for Whisper transcription and TTS playback. ' +
      'Set it in .env.local or the deploy environment.',
    );
  }
  _client = new OpenAI({
    apiKey,
    timeout: REQUEST_TIMEOUT_MS,
  });
  return _client;
}

/**
 * Pricing constants for the audio APIs (Sept 2024 rates, in USD).
 * Update if OpenAI changes their published rates.
 */
export const OPENAI_AUDIO_PRICING = {
  whisperPerMinute: 0.006,        // $0.006 / minute of audio
  tts1PerThousandChars: 0.015,    // $0.015 / 1000 characters of input text
} as const;
