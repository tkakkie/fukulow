import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compareSeedArms } from './dms-formal-seed-effect.ts';
import { dbPostgresCommand, seedScriptArgs } from './dms-formal-host.ts';
import { postgresCommand } from './dms-formal-seed-diagnostic.ts';

const conditions = { sha: 'a'.repeat(40), machine: 'm1', load: '1/25', limits: { dbCpu: 2 }, scenario: 'main', mode: 'formal', postgres: 'postgres:18',
  shape: { organizations: 10, batchesPerOrganization: 200 }, imageDigest: 'sha256:1', harnessSha256: 'h1' };
const arm = (name: 'instrumented' | 'baseline', medianMs: number, seedSeconds: number, extra: object = {}) => ({ arm: name, infrastructureFailure: false,
  collectionFailures: [], conditions, overhead: { seedSeconds, batches: { medianMs, batches: 2000, medianBatches: 1990 } }, ...extra });

test('the instrumentation effect is the matched difference of the two arms, without any threshold', () => {
  assert.deepEqual(compareSeedArms(arm('instrumented', 900, 3000), arm('baseline', 880, 2950, { conditions: { ...conditions, imageDigest: 'sha256:2', harnessSha256: 'h2' } })), {
    status: 'compared', reasons: [],
    instrumented: { seedSeconds: 3000, medianBatchMs: 900, batches: 2000 }, baseline: { seedSeconds: 2950, medianBatchMs: 880, batches: 2000 },
    medianBatchDeltaMs: 20, medianBatchRatio: 1.0227, seedSecondsDelta: 50, seedSecondsRatio: 1.0169,
  });
});

test('the effect stays unevaluated unless both arms exist, completed and ran under the same conditions', () => {
  const ok = arm('instrumented', 900, 3000), base = arm('baseline', 880, 2950);
  const reasons = (a: object | undefined, b: object | undefined) => { const result = compareSeedArms(a as never, b as never); assert.equal(result.status, 'unevaluated'); return result.reasons; };
  assert.deepEqual(reasons(ok, undefined), ['baseline arm summary missing']);
  assert.deepEqual(reasons(undefined, base), ['instrumented arm summary missing']);
  assert.deepEqual(reasons(base, ok), ['instrumented summary is not the instrumented arm', 'baseline summary is not the baseline arm']);
  assert.deepEqual(reasons(ok, { ...base, infrastructureFailure: true }), ['baseline arm did not complete its seed and collection']);
  assert.deepEqual(reasons({ ...ok, seedStop: { rule: 'message-batch' } }, base), ['instrumented arm did not complete its seed and collection']);
  assert.deepEqual(reasons({ ...ok, collectionFailures: ['db.log'] }, base), ['instrumented arm did not complete its seed and collection']);
  assert.deepEqual(reasons(ok, { ...base, conditions: { ...conditions, limits: { dbCpu: 4 } } }), ['conditions differ: limits']);
  assert.deepEqual(reasons(ok, { ...base, conditions: undefined }), ['run conditions missing']);
  assert.deepEqual(reasons(ok, { ...base, overhead: { seedSeconds: 1, batches: null } }), ['baseline arm has no seed timing']);
});

test('the baseline arm runs the formal seed on the formal DB command; only the instrumented arm adds the diagnostic', () => {
  assert.deepEqual(dbPostgresCommand({ seedDiagnostic: true, seedBaseline: true }), postgresCommand(false));
  assert.deepEqual(dbPostgresCommand({ seedDiagnostic: true }), postgresCommand(true));
  assert.deepEqual(dbPostgresCommand({}), postgresCommand(false));
  assert.deepEqual(seedScriptArgs({ seedDiagnostic: true, seedBaseline: true }, 'dms-formal-seed'), []);
  assert.deepEqual(seedScriptArgs({ seedDiagnostic: true }, 'dms-formal-seed'), ['--seed-diagnostic']);
  assert.deepEqual(seedScriptArgs({ seedDiagnostic: true }, 'dms-seed'), []);
});
