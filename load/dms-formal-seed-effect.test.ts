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

test('a rehearsal arm is never pair evidence, and a rehearsal arm and a full-size arm are never compared', () => {
  const small = { ...conditions, shape: { organizations: 1, batchesPerOrganization: 5 } };
  const rehearsalArm = (name: 'instrumented' | 'baseline', medianMs: number) => arm(name, medianMs, 60, { rehearsal: true, conditions: small });
  const reasons = (a: object, b: object, rehearsal?: boolean) => {
    const result = compareSeedArms(a as never, b as never, rehearsal === undefined ? undefined : { rehearsal });
    assert.equal(result.status, 'unevaluated');
    assert.equal('medianBatchDeltaMs' in result, false);
    return result.reasons;
  };
  // Pair evidence (the default): rehearsal arms are refused, even when both are rehearsals.
  assert.deepEqual(reasons(rehearsalArm('instrumented', 900), rehearsalArm('baseline', 880)),
    ['instrumented arm is a rehearsal, never pair evidence', 'baseline arm is a rehearsal, never pair evidence']);
  assert.deepEqual(reasons(rehearsalArm('instrumented', 900), rehearsalArm('baseline', 880), false),
    ['instrumented arm is a rehearsal, never pair evidence', 'baseline arm is a rehearsal, never pair evidence']);
  // Any rehearsal marker on an arm refuses it as pair evidence.
  assert.deepEqual(reasons(arm('instrumented', 900, 3000, { rehearsal: false }), arm('baseline', 880, 2950)), ['instrumented arm is a rehearsal, never pair evidence']);
  const mixed = 'a rehearsal arm and a full-size arm are never compared';
  assert.deepEqual(reasons(arm('instrumented', 900, 3000), rehearsalArm('baseline', 880)), ['baseline arm is a rehearsal, never pair evidence', 'conditions differ: shape', mixed]);
  assert.deepEqual(reasons(rehearsalArm('instrumented', 900), arm('baseline', 880, 2950), true), ['baseline arm is not a rehearsal', 'conditions differ: shape', mixed]);
  // Mixed even if the shapes were made to match: the marker alone refuses it.
  assert.deepEqual(reasons(arm('instrumented', 900, 3000), { ...arm('baseline', 880, 2950), rehearsal: true }, true), ['instrumented arm is not a rehearsal', mixed]);
  // Two full-size arms in rehearsal mode are refused too: the rehearsal mode never yields `compared`.
  assert.deepEqual(reasons(arm('instrumented', 900, 3000), arm('baseline', 880, 2950), true), ['instrumented arm is not a rehearsal', 'baseline arm is not a rehearsal']);
});

test('two rehearsal arms are compared as a rehearsal, marked as never pair evidence', () => {
  const small = { ...conditions, shape: { organizations: 1, batchesPerOrganization: 5 } };
  const result = compareSeedArms(arm('instrumented', 900, 60, { rehearsal: true, conditions: small }), arm('baseline', 880, 50, { rehearsal: true, conditions: small }), { rehearsal: true });
  assert.deepEqual(result, {
    status: 'rehearsal-compared', rehearsal: true, evidence: 'Rehearsal of the run path only; never pair evidence.', reasons: [],
    instrumented: { seedSeconds: 60, medianBatchMs: 900, batches: 2000 }, baseline: { seedSeconds: 50, medianBatchMs: 880, batches: 2000 },
    medianBatchDeltaMs: 20, medianBatchRatio: 1.0227, seedSecondsDelta: 10, seedSecondsRatio: 1.2,
  });
});

test('the rehearsal arms use the same DB command and seed script arguments as the full-size arms', () => {
  assert.deepEqual(dbPostgresCommand({ seedDiagnostic: true, seedRehearsal: true } as never), postgresCommand(true));
  assert.deepEqual(dbPostgresCommand({ seedDiagnostic: true, seedBaseline: true, seedRehearsal: true } as never), postgresCommand(false));
  assert.deepEqual(seedScriptArgs({ seedDiagnostic: true, seedRehearsal: true } as never, 'dms-formal-seed'), ['--seed-diagnostic']);
  assert.deepEqual(seedScriptArgs({ seedDiagnostic: true, seedBaseline: true, seedRehearsal: true } as never, 'dms-formal-seed'), []);
});
