import { preflightPlan, preflightResult } from './revocation-holds-preflight.ts';
import type { SessionIdentity } from './revocation-holds-provenance.ts';

export const preflightIdentity: SessionIdentity = {
  hostname: 'measurement-host', platform: 'linux', arch: 'x64', cpus: 16, memoryBytes: 32 * 1024 ** 3,
  release: 'test-kernel', node: 'v26.13.1', commit: 'test-commit', session: 'test-session',
  gitClean: true, bootId: 'e1721ea0-2bb7-4be8-92bf-3dbfdbfd042b',
  serverSha256: 'a'.repeat(64), stallHelperSha256: 'b'.repeat(64),
};

export const preflightReadbackValue = 32_768;
export const acceptedPreflight = (identity: SessionIdentity) => preflightResult(identity, preflightPlan().map(trial => ({
  id: trial.id, volume: trial.volume, repeat: trial.run.repeat, passed: true, readback: preflightReadbackValue, snapshotRecords: 96,
})));
