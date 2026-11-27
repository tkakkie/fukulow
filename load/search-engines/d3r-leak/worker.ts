import assert from 'node:assert/strict';
import { join } from 'node:path';
import { save, SqlStatementTimeoutError } from '../bench.ts';
import { readSource, sources } from '../d3r/path.ts';
import { formalPairs, judgedPairs, positiveControl } from './arms.ts';
import { migrate, placement, serverIdentity, start, type Names } from './cluster.ts';
import { schedule } from './design.ts';
import { PlanIdentityError } from './page.ts';
import { callerLock, checkIdle, hostPlacement } from './host.ts';
import { invalidChecks, type PairEvidence } from './judge.ts';
import { freeze, git, loadManifest, verifyPinnedSchema } from './manifest.ts';
import { rehearsalLabel, smokeLabel, type options } from './options.ts';
import { runPair, type Stage } from './pair.ts';
import { SampleCountError } from './samples.ts';

type Options = ReturnType<typeof options>;
type Check = typeof invalidChecks[number];
export type Evidence = {checks: Partial<Record<Check, boolean>>; pairs: PairEvidence[]; error?: string};
type Step = Stage | 'hostBusy' | 'idle';

function recordFailure(evidence: Evidence, step: Step, error: unknown) {
  if (error instanceof SqlStatementTimeoutError) evidence.checks.statementTimeout = false;
  else if (error instanceof SampleCountError) evidence.checks.sampleCount = false;
  else if (error instanceof PlanIdentityError) evidence.checks.identity = false;
  else if (step !== 'plan') evidence.checks[step] = false;
  evidence.error = String(error);
}

export async function worker(args: Options, resources: Names) {
  const mode = args.mode;
  const label = mode === 'smoke' ? smokeLabel : mode === 'rehearsal' ? rehearsalLabel : null;
  const reportPath = join(args.out, 'evidence.json');
  const evidence: Evidence = {checks: {}, pairs: []};
  let stage: Step = 'identity';
  try {
    const manifest = loadManifest();
    const path = verifyPinnedSchema();
    const design = freeze[mode];
    const pairs = mode === 'smoke' ? [...judgedPairs(design),
      ...args.ks.map(k => ({...positiveControl(k), id: `P-${k}`}))] :
      formalPairs(manifest.frozen.positiveK, manifest.frozen.reviewedAssignments);
    const seed = freeze.initialSeed;
    const plan = schedule(pairs.map(pair => pair.id), seed, design.blocksPerArm);
    const sourceIdentity = () => {
      const current = loadManifest();
      const checkout = git('status', '--porcelain');
      assert.ok(mode === 'smoke' || checkout === '', 'Formal checkout is dirty');
      return {schemaCommit: current.frozen.schemaCommit, commit: git('rev-parse', 'HEAD'), checkout,
        sourceHashes: current.frozen.sourceHashes, pagePathHashes: verifyPinnedSchema().hashes,
        manifestHash: current.sha256, manifestFileHash: current.fileHash, seed: current.frozen.freeze.initialSeed};
    };
    const initial = sourceIdentity();
    stage = 'hostBusy';
    const lock = mode === 'smoke' ? undefined : callerLock();
    stage = 'identity';
    const coordinator = lock ? hostPlacement() : null;
    const recheckHost = () => {
      if (!lock) return;
      stage = 'hostBusy';
      assert.deepEqual(callerLock(), lock);
      stage = 'idle';
      checkIdle([resources.server, resources.client], [process.ppid]);
    };
    recheckHost();
    stage = 'identity';
    const startup = await start(resources, lock?.session);
    save(join(args.out, 'identity.json'), {mode, label,
      ...initial, ...startup, coordinator, lock, node: process.version, design, plan, pairs,
      cacheCondition: 'fixture and RLS readbacks before block sampling; first transaction per client per block separate'});
    save(join(args.out, 'manifest.json'), manifest);
    stage = 'fixture';
    migrate(resources.client);
    for (const [index, pair] of pairs.entries()) {
      const result = await runPair(resources.client, pair, plan[index].blocks, design, seed, args.out,
        {page: path.page, engine: readSource(sources.engine)}, name => { stage = name; }, recheckHost, label);
      evidence.pairs.push(result);
      if (mode === 'smoke' && pair.id.startsWith('P-')) {
        console.log(`${smokeLabel} ${pair.id}: p50 ${result.ratios.p50.toFixed(3)}, p95 ${result.ratios.p95.toFixed(3)}`);
      }
    }
    recheckHost();
    stage = 'identity';
    assert.deepEqual(sourceIdentity(), initial, 'Run identity changed');
    assert.deepEqual(serverIdentity(resources), startup.server, 'Server identity changed');
    if (lock) assert.deepEqual(placement(resources, lock.session), startup.placement, 'CPU placement changed');
    if (mode === 'formal') {
      for (const check of invalidChecks) if (check !== 'cleanup') evidence.checks[check] = true;
      save(reportPath, evidence);
    } else if (mode === 'smoke') {
      const positiveControls = evidence.pairs.filter(pair => pair.id.startsWith('P-'))
        .map(pair => ({k: Number(pair.id.slice(2)), ratios: pair.ratios}));
      save(join(args.out, 'smoke.json'), {label: smokeLabel, positiveControls, completedPairs: pairs.map(pair => pair.id)});
    } else {
      save(join(args.out, 'rehearsal.json'), {label, pairs: evidence.pairs});
    }
  } catch (error) {
    recordFailure(evidence, stage, error);
    if (mode === 'formal') save(reportPath, evidence);
    else save(join(args.out, `${mode}-error.json`), {label, stage, error: evidence.error});
    throw error;
  }
}
