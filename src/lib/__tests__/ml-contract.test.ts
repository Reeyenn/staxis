/**
 * Cross-service contract test — Phase E2E (2026-05-22).
 *
 * Loads the committed snapshot at ml-service/openapi.json and asserts the
 * response schemas for the endpoints the web app calls contain the fields
 * the TypeScript wrappers actually read.
 *
 * Audit principle "only enforce what the caller reads": the test asserts
 * REQUIRED fields the web app inspects, NOT every Pydantic field. New
 * fields on the ML service are allowed without triggering this test.
 *
 * On mismatch the test prints the regeneration command so the next
 * engineer doesn't have to guess.
 *
 * NOTE: the snapshot is regenerated manually (not CI):
 *   cd ml-service && .venv/bin/python scripts/dump_openapi.py --pretty > openapi.json
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const OPENAPI_PATH = join(process.cwd(), 'ml-service', 'openapi.json');

interface OpenAPIRef { $ref?: string }
interface OpenAPISchema {
  type?: string;
  properties?: Record<string, OpenAPISchema | OpenAPIRef>;
  required?: string[];
  anyOf?: Array<OpenAPISchema | OpenAPIRef>;
  $ref?: string;
}
interface OpenAPISnapshot {
  components: { schemas: Record<string, OpenAPISchema> };
  paths: Record<string, {
    post?: { responses: Record<string, { content?: { 'application/json'?: { schema: OpenAPISchema | OpenAPIRef } } }> };
    get?:  { responses: Record<string, { content?: { 'application/json'?: { schema: OpenAPISchema | OpenAPIRef } } }> };
  }>;
}

let snapshot: OpenAPISnapshot | null = null;
const snapshotReason =
  existsSync(OPENAPI_PATH)
    ? null
    : `ml-service/openapi.json is missing. Regenerate with:\n` +
      `    cd ml-service && .venv/bin/python scripts/dump_openapi.py --pretty > openapi.json\n` +
      `(install deps first if needed: python3.11 -m venv .venv && .venv/bin/pip install -r requirements.txt)`;

if (snapshotReason === null) {
  try {
    snapshot = JSON.parse(readFileSync(OPENAPI_PATH, 'utf8')) as OpenAPISnapshot;
  } catch (e) {
    throw new Error(`Failed to parse ${OPENAPI_PATH}: ${(e as Error).message}`);
  }
}

function resolveSchema(schemaOrRef: OpenAPISchema | OpenAPIRef): OpenAPISchema {
  if (!snapshot) throw new Error('snapshot not loaded');
  if ('$ref' in schemaOrRef && schemaOrRef.$ref) {
    // refs look like #/components/schemas/PredictDemandResponse
    const name = schemaOrRef.$ref.replace('#/components/schemas/', '');
    const target = snapshot.components.schemas[name];
    if (!target) throw new Error(`Schema ref not found: ${schemaOrRef.$ref}`);
    return target;
  }
  return schemaOrRef as OpenAPISchema;
}

function responseSchema(path: string, method: 'post' | 'get' = 'post'): OpenAPISchema {
  if (!snapshot) throw new Error('snapshot not loaded');
  const op = snapshot.paths[path]?.[method];
  if (!op) throw new Error(`No ${method.toUpperCase()} ${path} in snapshot`);
  const json200 = op.responses['200']?.content?.['application/json']?.schema;
  if (!json200) throw new Error(`No JSON 200 response for ${method.toUpperCase()} ${path}`);
  return resolveSchema(json200);
}

function fieldNames(schema: OpenAPISchema): string[] {
  return schema.properties ? Object.keys(schema.properties) : [];
}

function fieldType(schema: OpenAPISchema, name: string): string {
  const prop = schema.properties?.[name];
  if (!prop) return 'missing';
  const resolved = resolveSchema(prop);
  if (resolved.type) return resolved.type;
  if (resolved.anyOf) {
    // Pydantic's Optional[T] renders as anyOf [T, null] — flatten for assertion.
    const types = resolved.anyOf.map((s) => {
      const r = resolveSchema(s);
      return r.type ?? 'unknown';
    });
    return types.join('|');
  }
  return 'unknown';
}

describe('ml-service OpenAPI contract', () => {
  it('snapshot file is present', () => {
    if (snapshotReason) {
      throw new Error(snapshotReason);
    }
    assert.ok(snapshot, 'snapshot loaded');
  });

  it('/predict/demand exposes the fields the cron route reads', () => {
    if (!snapshot) return;
    const schema = responseSchema('/predict/demand');
    const fields = fieldNames(schema);
    // Audit Q2: web app reads `status?` and `error?` off the response and
    // (for inventory) `predicted?`. Demand+supply don't carry status/predicted
    // — the cron route's wrapper synthesizes `status: 'ok'` from `res.ok` when
    // status is absent. We assert the OPTIONAL `error` slot and the data fields
    // the ML service writes (so the wrapper validators don't accidentally
    // start asserting fields the schema no longer has).
    for (const expected of ['error', 'predicted_minutes_p50', 'predicted_headcount_p50']) {
      assert.ok(
        fields.includes(expected),
        `expected '${expected}' on /predict/demand schema; got: ${fields.join(', ')}\n` +
        `Regenerate snapshot if ml-service has changed: cd ml-service && python scripts/dump_openapi.py --pretty > openapi.json`,
      );
    }
  });

  it('/predict/supply exposes predicted_rooms', () => {
    if (!snapshot) return;
    const schema = responseSchema('/predict/supply');
    const fields = fieldNames(schema);
    for (const expected of ['error', 'predicted_rooms']) {
      assert.ok(
        fields.includes(expected),
        `expected '${expected}' on /predict/supply schema; got: ${fields.join(', ')}`,
      );
    }
  });

  it('/predict/inventory-rate exposes `predicted` as an integer + `errors`', () => {
    if (!snapshot) return;
    const schema = responseSchema('/predict/inventory-rate');
    const fields = fieldNames(schema);
    for (const expected of ['predicted', 'errors', 'error']) {
      assert.ok(
        fields.includes(expected),
        `expected '${expected}' on /predict/inventory-rate; got: ${fields.join(', ')}`,
      );
    }
    // The validator asserts `predicted` is a number when present.
    assert.ok(
      fieldType(schema, 'predicted').includes('integer'),
      `expected /predict/inventory-rate.predicted to be integer; got ${fieldType(schema, 'predicted')}`,
    );
  });

  it('/train/demand exposes is_active (NOT status — train responses have no status field)', () => {
    if (!snapshot) return;
    const schema = responseSchema('/train/demand');
    const fields = fieldNames(schema);
    // Audit Q1 + Codex review: train responses don't carry a `status`
    // field. Our parseTrainResponse validator tolerates missing status
    // and synthesizes 'ok' from res.ok. This test pins the schema so
    // someone doesn't unwittingly start asserting status === 'string'.
    assert.ok(
      fields.includes('is_active'),
      `expected 'is_active' on /train/demand schema; got: ${fields.join(', ')}`,
    );
    assert.ok(
      !fields.includes('status'),
      `/train/demand should NOT have a 'status' field — wrapper tolerates its absence. If FastAPI adds one, update ml-invoke.ts and remove this anti-assertion.`,
    );
  });

  it('/health is registered as a JSON GET (liveness probe the System Status panel hits)', () => {
    if (!snapshot) return;
    // ml-service/src/health.py returns `dict[str, str]` (no Pydantic
    // model) so OpenAPI lists `additionalProperties: string` rather than
    // a concrete `status` field. Assert structural presence — the system-
    // status panel just needs the endpoint to return 200 with a JSON
    // object; the wrapper doesn't read into it.
    const schema = responseSchema('/health', 'get');
    assert.equal(schema.type, 'object', '/health 200 schema must be an object');
  });
});
