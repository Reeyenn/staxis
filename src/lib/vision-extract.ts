// ═══════════════════════════════════════════════════════════════════════════
// Vision extraction shim — Anthropic Claude Vision wrapper.
//
// One place where ANTHROPIC_API_KEY lives, one place where the model name is
// pinned, one place where we sanity-check the JSON shape. Both the invoice
// OCR route and the photo-count route import this so future model bumps or
// prompt tweaks happen in a single file.
//
// Returns parsed JSON or throws a structured error the API route can format
// for the client. Never logs the image content.
// ═══════════════════════════════════════════════════════════════════════════

import Anthropic from '@anthropic-ai/sdk';

// Pin the model — the prompts in this file are calibrated for Sonnet 4-class
// vision quality. Bumping the version requires a re-test of both prompts.
const MODEL = 'claude-sonnet-4-6';

/** Throws if ANTHROPIC_API_KEY is missing — caller catches and 500s the route. */
function getClient(): Anthropic {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    throw new Error(
      'ANTHROPIC_API_KEY is not set. Vision features (invoice OCR, photo count) require it. ' +
      'Set in Vercel → Project Settings → Environment Variables and redeploy.',
    );
  }
  return new Anthropic({ apiKey: key });
}

export interface VisionImage {
  /** Base64-encoded image data (no data: prefix). */
  data: string;
  /** MIME type, e.g. 'image/jpeg'. */
  mediaType: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif';
}

/**
 * Send an image + a text prompt to Claude. Returns the model's text response.
 * The prompt should instruct the model to return JSON; the caller is
 * responsible for parsing.
 */
export async function visionExtractText(
  image: VisionImage,
  prompt: string,
): Promise<string> {
  const client = getClient();
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 4096,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: image.mediaType,
              data: image.data,
            },
          },
          { type: 'text', text: prompt },
        ],
      },
    ],
  });

  // Concatenate any text blocks in the response (usually one).
  const text = response.content
    .filter(block => block.type === 'text')
    .map(block => (block as { type: 'text'; text: string }).text)
    .join('\n')
    .trim();

  if (!text) {
    throw new Error('Vision API returned no text. Try a clearer photo.');
  }
  return text;
}

/**
 * Same as above but pulls a JSON object out of the response. Tolerates
 * common Claude output patterns:
 *   - bare JSON
 *   - JSON wrapped in ```json ... ``` fences
 *   - JSON inside any other prose (extracts first balanced { ... } block)
 */
export async function visionExtractJSON<T>(
  image: VisionImage,
  prompt: string,
): Promise<T> {
  const text = await visionExtractText(image, prompt);

  // Try direct parse first — fastest path when the model behaves.
  try {
    return JSON.parse(text) as T;
  } catch {
    /* fall through */
  }

  // Strip ```json ... ``` fences.
  const fence = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fence) {
    try {
      return JSON.parse(fence[1]) as T;
    } catch {
      /* fall through */
    }
  }

  // Extract first balanced { ... } block.
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start !== -1 && end !== -1 && end > start) {
    try {
      return JSON.parse(text.slice(start, end + 1)) as T;
    } catch {
      /* fall through */
    }
  }

  throw new Error(`Vision API returned non-JSON output. First 200 chars: ${text.slice(0, 200)}`);
}
