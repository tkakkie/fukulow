import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { smoke } from './design.ts';
import { freeze } from './manifest.ts';

export const smokeLabel = 'SMOKE / NOT EVIDENCE';

export function options(args: string[]) {
  const mode = args[0];
  assert.ok(mode === '--smoke' || mode === '--formal', 'Use --smoke or --formal');
  const out = args.find(arg => arg.startsWith('--out='))?.slice(6);
  const candidates = args.find(arg => arg.startsWith('--k='))?.slice(4).split(',').map(Number);
  assert.ok(out && args.length === (candidates ? 3 : 2) &&
    args.slice(1).every(arg => /^--(?:out|k)=.+$/.test(arg)), 'Use --out=<new-directory> [--k=<smoke-candidates>]');
  assert.ok(mode === '--smoke' || !candidates, 'Formal K comes from the frozen manifest');
  const ks = candidates ?? freeze.smokeCandidates;
  assert.ok(new Set(ks).size === ks.length && ks.every(k => Number.isSafeInteger(k) && k > 0 && k < smoke.messages),
    'Smoke K must be a unique positive integer smaller than the smoke fixture');
  return {mode: mode === '--smoke' ? 'smoke' : 'formal', out: resolve(out), ks} as const;
}
