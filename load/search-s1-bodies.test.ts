import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sha256 } from './search-m1-bodies.ts';
import { bodyCount, bodyPool, bodyScalars, bodySeed, poolJson, poolSha256, termsPerBody } from './search-s1-bodies.ts';

test('S1 pool is deterministic and its serialized SHA-256 is frozen', () => {
  const pool = bodyPool();
  assert.equal(pool.length, bodyCount);
  assert.equal(new Set(pool).size, bodyCount);
  assert.deepEqual(bodyPool(bodySeed), pool);
  assert.notDeepEqual(bodyPool(bodySeed + 1), pool);
  assert.equal(sha256(poolJson(pool)), poolSha256);
});

test('every body has 4000 Japanese scalars and exactly 7997 distinct terms', () => {
  for (const body of bodyPool()) {
    const scalars = [...body];
    assert.equal(scalars.length, bodyScalars);
    assert.match(body, /^[\u3041-\u3096\u30a1-\u30fa\u4e00-\u9fff]+$/u);
    for (const script of [/\p{Script=Hiragana}/u, /\p{Script=Katakana}/u, /\p{Script=Han}/u]) assert.match(body, script);
    assert.doesNotMatch(body, /\p{Default_Ignorable_Code_Point}|[\uff65-\uff9f]/u);
    const terms = new Set<string>();
    for (const width of [2, 3]) {
      for (let i = 0; i <= scalars.length - width; i++) terms.add(scalars.slice(i, i + width).join(''));
    }
    assert.equal(terms.size, termsPerBody);
    const request = JSON.stringify({ body, client_message_id: '11111111-1111-4111-8111-111111111111' });
    assert.ok(Buffer.byteLength(request) < 32 * 1024, 'exceeds the Message POST route body limit');
  }
});
