// The formal path (#515 slice 5, which F1 would rerun) must not pick up the diagnostic order or checkpoint.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { dbSettings, rounds, thresholds, validity } from '../slice5/config.ts';

const dir = (name: string) => new URL(`../${name}/`, import.meta.url);
const sources = (name: string) => readdirSync(dir(name)).filter(f => f.endsWith('.ts')).map(f => [f, readFileSync(new URL(f, dir(name)), 'utf8')] as const);

test('formal rounds, thresholds, validity rules and DB settings are unchanged', () => {
  assert.deepEqual(rounds, [['B', 'A'], ['A', 'B'], ['B', 'A']]);
  assert.deepEqual(thresholds, { sendP95Ratio: 1.10, acceptedRatio: 0.90, walPerOpRatio: 1.15, storagePerMessageRatio: 1.25,
    maxAcceptedRatio: 0.90, replayP95Ratio: 1.10, replayP95LimitMs: 100, timelineP95LimitMs: 100, spread: 0.10, vacuumDecisionRatio: 1.25 });
  assert.deepEqual(validity, { minimumOfferedFraction: 0.95, maxSampleGapMs: 2500 });
  assert.deepEqual(dbSettings, { max_wal_size: '8GB', checkpoint_timeout: '30min' });
});

test('no formal source imports the diagnostic, and the diagnostic only reads slice 5 fixture and seed helpers', () => {
  for (const [file, text] of sources('slice5')) assert.doesNotMatch(text, /diag-621/, file);
  const imports = sources('diag-621').flatMap(([, text]) => [...text.matchAll(/from '(\.\.\/[^']+)'/g)].map(m => m[1]));
  assert.deepEqual([...new Set(imports)].sort(), ['../slice5/config.ts', '../slice5/fixture.ts', '../slice5/stack.ts']);
});
