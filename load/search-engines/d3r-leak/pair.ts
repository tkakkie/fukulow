import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { save } from '../bench.ts';
import { readFixture, rlsAssertions, seedArm } from './fixture.ts';
import { capturePlan, checkPage } from './page.ts';
import { clone, database } from './cluster.ts';
import { measureBlock, preBlockGuard } from './block.ts';
import type { Pair } from './arms.ts';
import { arms, queries, type Arm, type Design } from './design.ts';
import { flagged } from './judge.ts';
import { armStats, confidenceIntervals, ratios, type Block } from './samples.ts';
import { assertMatchingVData, assertVisibility, readTermFingerprint, readVisibility } from './visibility.ts';

const label = (status: string) => process.stdout.write(status + '\n');
type Path = {page: string; engine: string};
export type Stage = 'fixture' | 'rls' | 'pgbench' | 'sampleCount' | 'identity' | 'plan';
type Before = (stage: Stage) => void;
export type CheckHost = () => void;

export async function runPair(client: string, pair: Pair, blocks: Arm[], design: Design, seed: number, out: string,
  path: Path, onStage: Before, checkHost: CheckHost, runLabel: string | null) {
  const dbPrefix = 'leak_' + pair.id.toLowerCase().replaceAll(/[^a-z0-9]+/g, '_');
  const directory = join(out, dbPrefix);
  mkdirSync(directory);
  label(`${runLabel ? runLabel + ' ' : ''}${pair.id}`);
  const fixtures = [];
  const query = queries[pair.few.query];
  assert.equal(pair.many.query, pair.few.query);
  for (const arm of arms) {
    onStage('fixture');
    const name = `${dbPrefix}_${arm}`;
    const db = clone(client, name);
    const spec = pair[arm];
    const seedResult = await seedArm(db, path.engine, spec, design);
    onStage('rls');
    const rls = rlsAssertions(db.app);
    onStage('fixture');
    const counts = readFixture(db.owner, spec, design);
    assert.equal(seedResult.termRows, 5 * counts.messages);
    const page = checkPage(db.app, path.page, query);
    const fingerprints = pair.id === 'V' ?
      {messages: counts.wholeBodyFingerprint, terms: readTermFingerprint(db.owner)} : null;
    const fixture = {name, spec, seed: seedResult, rls, counts, page, ...(fingerprints && {fingerprints})};
    save(join(directory, `${arm}-fixture.json`), fixture);
    fixtures.push(fixture);
  }
  const [few, many] = fixtures;
  const byArm = {few, many};
  assert.equal(few.page.visiblePage, many.page.visiblePage, 'Visible pages differ');
  assert.equal(few.counts.fingerprint, many.counts.fingerprint, 'Fixture fingerprints differ');
  if (pair.id === 'S') {
    assert.equal(many.counts.otherOrgTermRows, 10 * few.counts.otherOrgTermRows);
  } else {
    assert.equal(few.seed.termRows, many.seed.termRows, 'Term-table row counts differ');
  }
  if (pair.id === 'A/A') assert.equal(few.counts.wholeBodyFingerprint, many.counts.wholeBodyFingerprint);
  const checkVVisibility = (phase: 'before' | 'after') => {
    onStage('fixture');
    const visibility = arms.map(arm => {
      const fixture = byArm[arm];
      const data = readVisibility(database(client, fixture.name).owner, fixture.spec);
      save(join(directory, `${arm}-visibility-${phase}.json`), data);
      return data;
    });
    assertVisibility(visibility[0], visibility[1], pair.few.slots);
  };
  if (pair.id === 'V') {
    assert.ok(few.fingerprints && many.fingerprints);
    assertMatchingVData(few.fingerprints, many.fingerprints);
    checkVVisibility('before');
  }
  const samples: Record<Arm, Block[]> = {few: [], many: []};
  for (const [index, arm] of blocks.entries()) {
    const {name} = byArm[arm];
    checkHost();
    onStage('identity');
    const db = database(client, name);
    assert.equal(db.owner('SHOW autovacuum;'), 'off');
    assert.equal(db.app(preBlockGuard), 't', 'Timeout guard failed before the block');
    onStage('pgbench');
    const dest = join(directory, `block-${String(index + 1).padStart(2, '0')}-${arm}`);
    const raw = await measureBlock(client, name, path.page, query, dest, design, seed);
    save(join(dest, 'samples.json'), {label: runLabel, number: index + 1, arm, raw});
    samples[arm].push(raw);
    checkHost();
  }
  if (pair.id === 'V') checkVVisibility('after');
  onStage('sampleCount');
  const expected = design.blocksPerArm * design.clients * design.measuredPerClient;
  const metrics = {few: armStats(samples.few), many: armStats(samples.many)};
  assert.equal(metrics.few.n, expected);
  assert.equal(metrics.many.n, expected);
  onStage('plan');
  const plans = fixtures.map(fixture => capturePlan(database(client, fixture.name).app, path.page, fixture.page.tx));
  for (const [index, arm] of arms.entries()) save(join(directory, `plan-${arm}.json`), plans[index]);
  const result = {id: pair.id, label: runLabel, few: {...metrics.few, ...plans[0]}, many: {...metrics.many, ...plans[1]},
    ratios: ratios(samples.few, samples.many), confidenceIntervals: confidenceIntervals(samples.few, samples.many)};
  const comparison = runLabel ? {} : {flagged: flagged(result.ratios.p50, result.ratios.p95),
    samePlan: result.few.shape === result.many.shape};
  save(join(directory, 'report.json'), {...result, ...comparison});
  return result;
}
