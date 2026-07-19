import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  chunkCompanyProjectionIds,
  IncompleteCompanyProjectionError,
  readCompleteCompanyIdChunks,
  readCompleteCompanyPages,
} from '@/lib/company-access/projection-query';

describe('complete Company Hub projection queries', () => {
  test('advances by rows returned when PostgREST clamps each page', async () => {
    const source = ['a', 'b', 'c', 'd', 'e'];
    const starts: number[] = [];
    const result = await readCompleteCompanyPages<string>((from) => {
      starts.push(from);
      return Promise.resolve({
        data: source.slice(from, from + 2),
        error: null,
        count: source.length,
      });
    });

    assert.deepEqual(result, source);
    assert.deepEqual(starts, [0, 2, 4]);
  });

  test('deduplicates and bounds every id filter', async () => {
    const ids = Array.from({ length: 123 }, (_, index) => `id-${index}`);
    const observedChunkSizes: number[] = [];
    const result = await readCompleteCompanyIdChunks(
      [...ids, ids[0], ''],
      (chunk, from) => {
        if (from === 0) observedChunkSizes.push(chunk.length);
        return Promise.resolve({
          data: chunk.slice(from, from + 17),
          error: null,
          count: chunk.length,
        });
      },
    );

    assert.equal(result.length, ids.length);
    assert.deepEqual(observedChunkSizes, [50, 50, 23]);
    assert.deepEqual(chunkCompanyProjectionIds(['a', 'a', '', 'b']), [['a', 'b']]);
  });

  test('fails closed without an exact count', async () => {
    await assert.rejects(
      readCompleteCompanyPages(() => Promise.resolve({ data: ['partial'], error: null, count: null })),
      IncompleteCompanyProjectionError,
    );
  });

  test('fails closed when rows change or a page stops early', async () => {
    let call = 0;
    await assert.rejects(
      readCompleteCompanyPages(() => {
        call += 1;
        return Promise.resolve(call === 1
          ? { data: ['a'], error: null, count: 2 }
          : { data: ['b'], error: null, count: 3 });
      }),
      /changed while a paged query was loading/,
    );

    await assert.rejects(
      readCompleteCompanyPages(() => Promise.resolve({ data: [], error: null, count: 1 })),
      /stopped after 0 of 1 rows/,
    );
  });
});
