import assert from 'node:assert/strict';
import test from 'node:test';
import { f2ReferenceMarkdown, f2ReferenceReport } from './f2-report.ts';
import { stopRule } from './probe.ts';

const blocks = (wal: number[], tps: number[]) => wal.map((walBytesPerSend, i) => ({ pair: i + 1, walBytesPerSend, tps: tps[i] }));
const current = blocks([2000, 2000, 2000, 2000], [100, 100, 100, 100]);
const pref2 = blocks([1000, 1000, 1000, 1000], [200, 200, 200, 200]);

test('the report flags an F2-only regression even when F2 vs current is no stop', () => {
  for (const f2 of [
    blocks([1210, 1210, 1210, 1210], [200, 200, 200, 200]),
    blocks([1000, 1000, 1000, 1000], [179, 179, 179, 179]),
  ]) {
    const verdict = stopRule(current, f2);
    const reference = f2ReferenceReport(current, pref2, f2);
    assert.equal(verdict.stop, false);
    assert.equal(reference.f2OnlyFlag, 'F2-ONLY REGRESSION');
    const markdown = f2ReferenceMarkdown(reference).join('\n');
    assert.match(markdown, /### F2 vs pre-F2[\s\S]*\*\*F2-ONLY REGRESSION\*\*/);
    assert.match(markdown, /### pre-F2 vs current[\s\S]*Median WAL\/send ratio 0.500, median tps ratio 2.000/);
  }
});

test('all four pairs worsening on either metric flags F2-only worsening below limits', () => {
  const wal = f2ReferenceReport(current, pref2, blocks([1200, 1300, 1190, 1200], [200, 200, 200, 200]));
  assert.equal(wal.f2VsPref2.medianWalPerSend, 1.2);
  assert.equal(wal.f2OnlyFlag, 'F2-only worsening below limits');
  assert.deepEqual(wal.f2VsPref2.ratios, [
    { pair: 1, walPerSend: 1.2, tps: 1 },
    { pair: 2, walPerSend: 1.3, tps: 1 },
    { pair: 3, walPerSend: 1.19, tps: 1 },
    { pair: 4, walPerSend: 1.2, tps: 1 },
  ]);
  const tps = f2ReferenceReport(current, pref2, blocks([1000, 1000, 1000, 1000], [180, 180, 185, 199]));
  assert.equal(tps.f2VsPref2.medianTps, 0.9);
  assert.equal(tps.f2OnlyFlag, 'F2-only worsening below limits');
});

test('mixed or equal pairs below the limits yield no F2-only regression observed', () => {
  const f2 = blocks([1100, 1100, 1100, 1000], [200, 190, 190, 190]);
  const report = f2ReferenceReport(current, pref2, f2);
  assert.equal(report.f2OnlyFlag, 'no F2-only regression observed');
  assert.match(f2ReferenceMarkdown(report).join('\n'), /\*\*no F2-only regression observed\*\*/);
  assert.throws(() => f2ReferenceReport(current.slice(1), pref2.slice(1), f2.slice(1)), /incomplete pre-F2 reference pairs/);
});
