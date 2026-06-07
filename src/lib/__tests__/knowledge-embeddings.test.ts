// Embeddings seam — pure math + OpenAIEmbedder batching/ordering (mocked fetch,
// never the network) + the injected-fake pattern the rest of the pipeline uses.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cosineSimilarity, toVectorLiteral, estimateEmbeddingCostUsd,
  OpenAIEmbedder, EMBEDDING_DIMS, type Embedder,
} from '@/lib/knowledge/embeddings';

test('cosineSimilarity: identical = 1, orthogonal = 0, opposite = -1', () => {
  assert.equal(cosineSimilarity([1, 0, 0], [1, 0, 0]), 1);
  assert.equal(cosineSimilarity([1, 0], [0, 1]), 0);
  assert.equal(cosineSimilarity([1, 0], [-1, 0]), -1);
  assert.equal(cosineSimilarity([0, 0], [1, 1]), 0); // zero-magnitude guard
  assert.equal(cosineSimilarity([1, 2, 3], [1, 2]), 0); // length mismatch guard
});

test('toVectorLiteral: pgvector text literal', () => {
  assert.equal(toVectorLiteral([0.1, 0.2, -0.3]), '[0.1,0.2,-0.3]');
});

test('estimateEmbeddingCostUsd: $0.02 / 1M tokens', () => {
  assert.equal(estimateEmbeddingCostUsd(1_000_000), 0.02);
  assert.equal(estimateEmbeddingCostUsd(0), 0);
});

test('OpenAIEmbedder batches > 96 inputs into multiple requests, keeps order + sums tokens', async () => {
  const origFetch = globalThis.fetch;
  let requests = 0;
  // Provider returns vectors where the first component encodes the input string's
  // numeric suffix, and DELIBERATELY shuffles `index` so we test the sort.
  globalThis.fetch = (async (_url: string, init: { body: string }) => {
    requests++;
    const body = JSON.parse(init.body) as { input: string[] };
    const data = body.input.map((s, i) => ({
      index: i,
      embedding: [Number(s.replace('item-', '')), 0, 0],
    }));
    // shuffle the response order
    data.reverse();
    return {
      ok: true,
      status: 200,
      json: async () => ({ data, usage: { total_tokens: body.input.length }, model: 'text-embedding-3-small' }),
      text: async () => '',
    };
  }) as unknown as typeof fetch;

  try {
    const embedder = new OpenAIEmbedder('sk-test-key');
    const inputs = Array.from({ length: 200 }, (_, i) => `item-${i}`);
    const res = await embedder.embed(inputs);
    assert.equal(res.vectors.length, 200, 'one vector per input');
    assert.equal(requests, 3, '200 inputs / 96 per request = 3 requests');
    assert.equal(res.totalTokens, 200, 'tokens summed across batches');
    // Order preserved despite shuffled provider index: vectors[i][0] === i.
    for (let i = 0; i < 200; i++) assert.equal(res.vectors[i][0], i, `vector ${i} aligned to input ${i}`);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('OpenAIEmbedder surfaces a clean error on non-200', async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async () => ({ ok: false, status: 429, json: async () => ({}), text: async () => 'rate limited' })) as unknown as typeof fetch;
  try {
    const embedder = new OpenAIEmbedder('sk-test-key');
    await assert.rejects(() => embedder.embed(['hello']), /429/);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('a fake Embedder satisfies the interface (the test-injection pattern)', async () => {
  const fake: Embedder = {
    model: 'fake', dims: EMBEDDING_DIMS,
    embed: async (texts) => ({ vectors: texts.map(() => [1, 0, 0]), totalTokens: 0, model: 'fake' }),
  };
  const res = await fake.embed(['a', 'b']);
  assert.equal(res.vectors.length, 2);
});
