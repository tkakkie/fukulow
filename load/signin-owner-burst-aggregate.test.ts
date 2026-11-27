import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PLANS } from './signin-owner-burst-config.ts';
import { aggregate, judgeBurst, type BurstRun } from './signin-owner-burst-judgment.ts';
import { readRuns } from './signin-owner-burst-aggregate.ts';
import { SHA, OFFSET, run, writeRun, threeRuns } from './signin-owner-burst-fixture.ts';

test('aggregate reader: only three distinct, self-consistent, completed recorded runs count', () => {
  const base = mkdtempSync(join(tmpdir(), 'burst-aggregate-'));
  const write = (name: string, o: { status?: object; results?: object | null; meta?: object } = {}) => {
    const dir = join(base, name), r = run(), judgment = judgeBurst(r);
    mkdirSync(dir);
    writeFileSync(join(dir, 'status.json'), JSON.stringify({ runId: name, mode: 'recorded', evidence: true, outcome: 'success', ...o.status }));
    if (o.results !== null) writeFileSync(join(dir, 'results.json'), JSON.stringify({ runId: name, mode: 'recorded', evidence: true, complete: true,
      stoppedEarly: null, harnessCommit: SHA, serverCommit: SHA, ...r, judgment, ...o.results }));
    writeFileSync(join(dir, 'metadata.json'), JSON.stringify({ project: name, mode: 'recorded', evidenceEligible: true, plan: PLANS.recorded, harnessCommit: SHA, serverCommit: SHA, ...o.meta }));
    return dir;
  };
  const [a, b, c] = ['a', 'b', 'c'].map(n => write(n));
  const outcome = (dirs: string[]) => aggregate(readRuns(dirs)).outcome;
  assert.equal(outcome([a, b, c]), 'PASS');
  assert.equal(outcome([a, a, a]), 'INCONCLUSIVE');
  assert.equal(outcome([a, b, join(base, 'b', '.')]), 'INCONCLUSIVE');
  const problems: [string, Parameters<typeof write>[1]][] = [
    ['verdict only', { results: { judgment: { verdict: 'holds' }, owner: undefined, samples: undefined } }],
    ['forged verdict', { results: { judgment: { verdict: 'holds' }, skipped: { reads: 3 } } }],
    ['other run results', { results: { runId: 'zzz' } }],
    ['other run metadata', { meta: { project: 'zzz' } }],
    ['rehearsal', { status: { mode: 'rehearsal' } }],
    ['not evidence', { status: { evidence: false } }],
    ['result failure', { status: { outcome: 'result-failure' } }],
    ['stopped early', { results: { stoppedEarly: 'inconclusive: B0' } }],
    ['results evidence false', { results: { evidence: false } }],
    ['missing results', { results: null }],
    ['no server commit', { meta: { serverCommit: null } }],
  ];
  for (const [name, o] of problems) {
    const dir = write(name.replace(/ /g, '-'), o);
    const runs = readRuns([a, b, dir]);
    assert.equal(runs[2].evidence, false, name);
    assert.equal(aggregate(runs).outcome, 'INCONCLUSIVE', name);
  }
  // A failing third run is FAIL only when all three are valid.
  const failing = write('failing', { results: { judgment: { verdict: 'fails' } } });
  assert.equal(readRuns([a, b, failing])[2].evidence, false, 'a stored verdict the samples do not reproduce');
  const other = write('other-harness', { meta: { harnessCommit: 'd'.repeat(40) }, results: { harnessCommit: 'd'.repeat(40) } });
  assert.equal(outcome([a, b, other]), 'INCONCLUSIVE');
});

test('condition b: the 3 runs must share the server commit as well as the harness commit', () => {
  const base = mkdtempSync(join(tmpdir(), 'burst-commits-'));
  const write = (name: string, serverCommit: string) => {
    const dir = join(base, name), r = run();
    mkdirSync(dir);
    writeFileSync(join(dir, 'status.json'), JSON.stringify({ runId: name, mode: 'recorded', evidence: true, outcome: 'success' }));
    writeFileSync(join(dir, 'results.json'), JSON.stringify({ runId: name, mode: 'recorded', evidence: true, complete: true, stoppedEarly: null,
      harnessCommit: SHA, serverCommit, ...r, judgment: judgeBurst(r) }));
    writeFileSync(join(dir, 'metadata.json'), JSON.stringify({ project: name, mode: 'recorded', evidenceEligible: true, plan: PLANS.recorded, harnessCommit: SHA, serverCommit }));
    return dir;
  };
  const same = ['a', 'b', 'c'].map(n => write(n, SHA));
  assert.equal(aggregate(readRuns(same)).outcome, 'PASS');
  const mixed = readRuns([same[0], same[1], write('d', 'e'.repeat(40))]);
  assert.equal(aggregate(mixed).outcome, 'INCONCLUSIVE');
  assert.ok(mixed.every(r => r.problem === 'runs tested different server commits'));
});

test('round 3: completeness covers all of B2; a truncated recovery or another plan never passes', () => {
  assert.equal(aggregate(readRuns(['a', 'b', 'c'].map(n => writeRun(n, run())))).outcome, 'PASS');
  // The sol case: the run stops 8.3 s into B2, with everything after that dropped.
  const cut = 241_700 + 8_300, truncated = run();
  truncated.owner = truncated.owner.filter(o => o.sentMs < cut); truncated.reads = truncated.reads.filter(x => x.dueMs < cut);
  truncated.samples = truncated.samples.filter(x => x.dbMs + OFFSET < cut);
  // scheduleEndMs as the 6dd20b70 runner recorded it: the last scheduler tick before the stop.
  truncated.scheduleEndMs = cut - 1; truncated.endMs = cut;
  const result = judgeBurst(truncated);
  assert.deepEqual([result.verdict, result.evidence.checks.workloadComplete.pass], ['inconclusive', false]);
  assert.equal(aggregate(readRuns(['a', 'b', 'c'].map(n => writeRun(n, truncated)))).outcome, 'INCONCLUSIVE');
  // B2 started early, or a short plan recorded as if it were the recorded one.
  const early = run(); early.phaseStartMs.B2 = 200_000; early.scheduleEndMs = 270_000;
  assert.equal(judgeBurst(early).evidence.checks.workloadComplete.pass, false);
  const rehearsalPlan = run(); rehearsalPlan.plan = { ...rehearsalPlan.plan, b2Ms: 5_000 };
  assert.equal(readRuns([writeRun('a', run()), writeRun('b', run()), writeRun('p', rehearsalPlan)])[2].evidence, false);
  const noPlan = run(); delete (noPlan as Partial<BurstRun>).plan;
  assert.equal(judgeBurst(noPlan).verdict, 'inconclusive');
});

test('round 4 B5: status, results and metadata must agree on mode, evidence eligibility and plan', () => {
  assert.equal(threeRuns(run), 'PASS');
  // sol: metadata of a rehearsal next to valid recorded status and results.
  assert.equal(threeRuns(run, { mode: 'rehearsal', evidenceEligible: false, plan: PLANS.rehearsal }), 'INCONCLUSIVE');
  for (const meta of [{ mode: 'rehearsal' }, { evidenceEligible: false }, { plan: PLANS.rehearsal }, { plan: { ...PLANS.recorded, failFast: false } },
    { mode: undefined }, { plan: undefined }]) assert.equal(threeRuns(run, meta), 'INCONCLUSIVE', JSON.stringify(meta));
});
