import assert from 'node:assert/strict';
import { sha256 } from './search-m1-bodies.ts';

export const bodySeed = 689202611;
export const bodyCount = 64;
export const bodyScalars = 4000;
export const termsPerBody = 7997;
const alphabet = Array.from({ length: 128 }, (_, i) =>
  String.fromCodePoint(i < 16 ? 0x3041 + i : i < 32 ? 0x30a1 + i - 16 : 0x4e00 + i - 32));

export function bodyPool(seed = bodySeed) {
  let state = seed;
  const randomIndex = (limit: number) => {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0;
    return Math.floor(state / 0x100000000 * limit);
  };
  return Array.from({ length: bodyCount }, () => {
    // Traverse a shuffled directed graph with one edge per ordered pair.
    // A prefix of the resulting Euler circuit cannot repeat a bigram or trigram.
    const edges = alphabet.map(() => {
      const neighbors = alphabet.map((_, i) => i);
      for (let i = neighbors.length - 1; i > 0; i--) {
        const j = randomIndex(i + 1);
        [neighbors[i], neighbors[j]] = [neighbors[j], neighbors[i]];
      }
      return neighbors;
    });
    const trail = [randomIndex(alphabet.length)];
    const circuit: number[] = [];
    while (trail.length) {
      const next = edges[trail.at(-1)!].pop();
      if (next === undefined) circuit.push(trail.pop()!);
      else trail.push(next);
    }
    return circuit.reverse().slice(0, bodyScalars).map(i => alphabet[i]).join('');
  });
}

export const poolJson = (pool: string[]) => JSON.stringify(pool) + '\n';
export const poolSha256 = '2367b1cef1955726f206f1ca90a8465272e4e3acd32a45637aff39831cf26189';

export function frozenPool() {
  const pool = bodyPool();
  const json = poolJson(pool);
  assert.equal(sha256(json), poolSha256, 'S1 body pool changed');
  return { pool, json, seed: bodySeed, count: bodyCount, sha256: poolSha256 };
}
