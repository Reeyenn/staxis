import 'server-only';

import Anthropic from '@anthropic-ai/sdk';
import { env } from '@/lib/env';
import type { AiCapability, AiModelSelection } from './types';

const PROBE_TIMEOUT_MS = 12_000;
const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

export interface AiModelProbeResult {
  ok: boolean;
  provider: AiModelSelection['provider'];
  modelId: string;
  kind: 'anthropic_message' | 'openai_embedding' | 'openai_transcription';
  latencyMs: number;
  error?: string;
}

function tinyPdfBase64(): string {
  const objects = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 10 10] /Contents 4 0 R >>\nendobj\n',
    '4 0 obj\n<< /Length 0 >>\nstream\n\nendstream\nendobj\n',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (const object of objects) {
    offsets.push(Buffer.byteLength(pdf, 'ascii'));
    pdf += object;
  }
  const xref = Buffer.byteLength(pdf, 'ascii');
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += '0000000000 65535 f \n';
  for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'ascii').toString('base64');
}

function tinySilentWav(): Buffer {
  const sampleRate = 16_000;
  const seconds = 1;
  const dataBytes = sampleRate * seconds * 2;
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(dataBytes, 40);
  return buffer;
}

async function probeAnthropic(
  selection: AiModelSelection,
  required: AiCapability[],
): Promise<AiModelProbeResult> {
  const started = Date.now();
  const apiKey = env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return {
      ok: false, provider: selection.provider, modelId: selection.modelId,
      kind: 'anthropic_message', latencyMs: 0, error: 'Anthropic is not configured.',
    };
  }
  try {
    const client = new Anthropic({ apiKey, timeout: PROBE_TIMEOUT_MS, maxRetries: 0 });
    const content: Anthropic.ContentBlockParam[] = [];
    if (required.includes('image_input')) {
      content.push({
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: TINY_PNG_BASE64 },
      });
    }
    if (required.includes('pdf_input')) {
      content.push({
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data: tinyPdfBase64() },
      });
    }
    content.push({
      type: 'text',
      text: required.includes('tool_use')
        ? 'Use the health_check tool exactly once.'
        : 'This is a synthetic model-access health check. Reply with OK only.',
    });
    const needsTool = required.includes('tool_use');
    const response = await client.messages.create({
      model: selection.modelId,
      max_tokens: 32,
      messages: [{ role: 'user', content }],
      ...(needsTool ? {
        tools: [{
          name: 'health_check',
          description: 'Synthetic no-data health check.',
          input_schema: { type: 'object' as const, properties: {}, required: [] },
        }],
        tool_choice: { type: 'tool' as const, name: 'health_check' },
      } : {}),
    }, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    const valid = needsTool
      ? response.content.some((block) => block.type === 'tool_use' && block.name === 'health_check')
      : response.content.some((block) => block.type === 'text' && block.text.trim().length > 0);
    return {
      ok: valid,
      provider: selection.provider,
      modelId: selection.modelId,
      kind: 'anthropic_message',
      latencyMs: Date.now() - started,
      ...(valid ? {} : { error: 'Anthropic returned an unexpected probe response.' }),
    };
  } catch {
    return {
      ok: false,
      provider: selection.provider,
      modelId: selection.modelId,
      kind: 'anthropic_message',
      latencyMs: Date.now() - started,
      error: 'Anthropic could not run the synthetic probe.',
    };
  }
}

async function probeOpenAiEmbedding(selection: AiModelSelection): Promise<AiModelProbeResult> {
  const started = Date.now();
  try {
    const response = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: selection.modelId,
        input: 'synthetic staxis model health check',
        encoding_format: 'float',
      }),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      cache: 'no-store',
    });
    if (!response.ok) throw new Error('upstream');
    const payload = await response.json() as {
      data?: Array<{ embedding?: unknown }>;
    };
    const vector = payload.data?.[0]?.embedding;
    const valid = Array.isArray(vector)
      && vector.length === 1536
      && vector.every((value) => typeof value === 'number' && Number.isFinite(value));
    return {
      ok: valid,
      provider: selection.provider,
      modelId: selection.modelId,
      kind: 'openai_embedding',
      latencyMs: Date.now() - started,
      ...(valid ? {} : { error: 'OpenAI did not return the required 1536-dimensional embedding.' }),
    };
  } catch {
    return {
      ok: false,
      provider: selection.provider,
      modelId: selection.modelId,
      kind: 'openai_embedding',
      latencyMs: Date.now() - started,
      error: 'OpenAI could not run the synthetic embedding probe.',
    };
  }
}

async function probeOpenAiTranscription(selection: AiModelSelection): Promise<AiModelProbeResult> {
  const started = Date.now();
  try {
    const form = new FormData();
    const audio = tinySilentWav();
    form.append('file', new Blob([new Uint8Array(audio)], { type: 'audio/wav' }), 'health-check.wav');
    form.append('model', selection.modelId);
    const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}` },
      body: form,
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      cache: 'no-store',
    });
    if (!response.ok) throw new Error('upstream');
    const payload = await response.json() as { text?: unknown };
    const valid = typeof payload.text === 'string';
    return {
      ok: valid,
      provider: selection.provider,
      modelId: selection.modelId,
      kind: 'openai_transcription',
      latencyMs: Date.now() - started,
      ...(valid ? {} : { error: 'OpenAI returned an invalid transcription probe response.' }),
    };
  } catch {
    return {
      ok: false,
      provider: selection.provider,
      modelId: selection.modelId,
      kind: 'openai_transcription',
      latencyMs: Date.now() - started,
      error: 'OpenAI could not run the synthetic transcription probe.',
    };
  }
}

export async function probeAiModel(
  selection: AiModelSelection,
  requiredCapabilities: AiCapability[],
): Promise<AiModelProbeResult> {
  if (selection.provider === 'anthropic') {
    return probeAnthropic(selection, requiredCapabilities);
  }
  if (selection.provider === 'openai' && requiredCapabilities.includes('embeddings')) {
    return probeOpenAiEmbedding(selection);
  }
  if (selection.provider === 'openai' && requiredCapabilities.includes('audio_transcription')) {
    return probeOpenAiTranscription(selection);
  }
  return {
    ok: false,
    provider: selection.provider,
    modelId: selection.modelId,
    kind: 'openai_embedding',
    latencyMs: 0,
    error: 'No safe synthetic probe exists for this provider/capability combination.',
  };
}
