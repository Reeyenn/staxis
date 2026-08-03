// ═══════════════════════════════════════════════════════════════════════════
// One call for both halves of "read this file".
//
// A spreadsheet arrives as text and a photo arrives as pixels, and the model
// call is genuinely different for each: text goes as a message, pixels go
// through the vision helper's image/document block. What must NOT differ is
// everything around the call — which model the admin chose, the daily money
// cap, the cost row, the schema refusal. So both paths land here, and the
// route sees one function with one failure vocabulary.
//
// The vision path reuses src/lib/vision-extract.ts wholesale. The text path is
// the four-line provider call the other text features already make, with the
// two hardening rules this codebase applies to every one of them: forward the
// runtime's abort signal, and refuse a truncated generation rather than
// parsing half a list.
// ═══════════════════════════════════════════════════════════════════════════

import 'server-only';
import type Anthropic from '@anthropic-ai/sdk';
import { executeAiFeature } from '@/lib/ai/runtime';
import { getMessagesClientIfConfigured, MESSAGES_RUNTIME_PROVIDERS } from '@/lib/ai/messages-client';
import { captureTokenUsage } from '@/lib/ai/usage';
import type { AiLedgerContext } from '@/lib/ai/usage';
import type { AiModelRef } from '@/lib/ai/types';
import {
  visionExtractJSON,
  VisionSchemaError,
  VisionTruncatedError,
  type VisionUsageReport,
} from '@/lib/vision-extract';
import type { ImportSource } from './source-text';

const IMPORT_TIMEOUT_MS = 50_000;
const IMPORT_MAX_RETRIES = 1;
/** Big enough for a few hundred item rows; a bigger file must be split, and
 *  a truncated response throws rather than importing the first half of a
 *  shelf. */
const IMPORT_MAX_TOKENS = 8_192;

export const IMPORT_AI_FEATURE = 'inventory.sheet_import' as const;

function clientFor(model: AiModelRef) {
  const client = getMessagesClientIfConfigured(model.provider, {
    timeoutMs: IMPORT_TIMEOUT_MS,
    maxRetries: IMPORT_MAX_RETRIES,
  });
  if (!client) throw new Error(`${model.provider} is not configured for inventory sheet import`);
  return client;
}

function textOf(res: Anthropic.Message): string {
  return res.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();
}

/** Bare JSON, then a fenced block, then the first balanced object in prose.
 *  Same tolerance ladder the vision helper uses, for the same reason: models
 *  wrap JSON in politeness more often than they malform it. */
function parseJsonObject(raw: string): unknown {
  if (!raw) throw new VisionSchemaError('sheet reader returned empty output');
  try {
    return JSON.parse(raw);
  } catch { /* keep going */ }
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
  if (fenced) {
    try {
      return JSON.parse(fenced[1].trim());
    } catch { /* keep going */ }
  }
  const start = raw.indexOf('{');
  if (start >= 0) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < raw.length; i++) {
      const ch = raw[i];
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          try {
            return JSON.parse(raw.slice(start, i + 1));
          } catch {
            break;
          }
        }
      }
    }
  }
  throw new VisionSchemaError('sheet reader returned malformed JSON');
}

export interface ReadWithModelArgs<T> {
  source: ImportSource;
  prompt: string;
  validate: (raw: unknown) => T;
  ledger: AiLedgerContext;
  abortSignal?: AbortSignal;
  deadlineAt?: number;
  /** Vision only: the route books its own cost row from this. */
  onVisionUsage?: (usage: VisionUsageReport) => void;
}

/**
 * Read a source into the shape `validate` insists on.
 *
 * Throws the vision helper's error vocabulary in BOTH paths on purpose, so the
 * route has one set of catch clauses: VisionSchemaError for "that was not the
 * shape we asked for" and VisionTruncatedError for "that file is too big to
 * read in one pass".
 */
export async function readImportWithModel<T>(args: ReadWithModelArgs<T>): Promise<T> {
  const { source, prompt, validate } = args;

  if (source.readAs === 'vision') {
    return visionExtractJSON<T>(
      { data: source.base64, mediaType: source.mediaType },
      prompt,
      validate,
      args.onVisionUsage,
      IMPORT_AI_FEATURE,
      { abortSignal: args.abortSignal, deadlineAt: args.deadlineAt },
    );
  }

  const userMessage = `${prompt}\n\n─── THE DOCUMENT ───\n${source.text}`;
  const configured = await executeAiFeature(
    IMPORT_AI_FEATURE,
    MESSAGES_RUNTIME_PROVIDERS,
    async (model, context) => {
      const res = await clientFor(model).messages.create({
        model: model.modelId,
        max_tokens: IMPORT_MAX_TOKENS,
        messages: [{ role: 'user', content: userMessage }],
      }, { signal: context.signal });
      captureTokenUsage(context.attempts, model, res.model, res.usage);
      if (res.stop_reason === 'max_tokens') {
        throw new VisionTruncatedError(0, IMPORT_MAX_TOKENS);
      }
      return validate(parseJsonObject(textOf(res)));
    },
    {
      requirePricing: true,
      deadlineAt: args.deadlineAt,
      abortSignal: args.abortSignal,
      fallbackReserveMs: 0,
      // The runtime writes agent_costs itself, so this call site cannot forget
      // to meter and cannot double-count against the vision branch.
      ledger: { ...args.ledger, kind: 'background' },
    },
  );
  return configured.value;
}
