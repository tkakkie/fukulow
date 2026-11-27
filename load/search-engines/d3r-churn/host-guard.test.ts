import assert from 'node:assert/strict';
import { test } from 'node:test';
import { guardIdle, ownedPids, topPids } from './host-guard.ts';

test('docker top host PIDs of owned containers are parsed strictly', () => {
  assert.deepEqual(topPids('PID\n4242\n4250\n'), [4242, 4250]);
  assert.deepEqual(topPids('PID\n'), []);
  assert.throws(() => topPids('UID PID\nroot 1\n'), /docker top output/);
  assert.throws(() => topPids('PID\nk6\n'), /docker top PID/);
});

test('the idle guard excludes the owned k6 process but not other workers', () => {
  const ps = 'run-k6\nrun-server\n';
  const run = (...args: string[]) => args[0] === 'ps' ? ps
    : args[1] === 'run-k6' ? 'PID\n4242\n' : 'PID\n77\n';
  assert.deepEqual(ownedPids(['run-k6', 'run-server', 'run-app'], run), [4242, 77]);
  // Host ps shows the owned k6 (4242) and the worker child (10); an unrelated `codex exec` is 900.
  const idle = (busy: number[]) => (_: string[], excluded: number[]) => {
    assert.equal(busy.filter(pid => !excluded.includes(pid)).length, 0, 'Other workers are running');
  };
  const pids = (owned: string[]) => ownedPids(owned, run);
  assert.doesNotThrow(() => guardIdle(['run-k6', 'run-server'], [10], idle([10, 4242]), pids));
  assert.throws(() => guardIdle(['run-k6', 'run-server'], [10], idle([10, 4242, 900]), pids), /Other workers/);
});

test('a container that stops during the listing has no PIDs; a live one that fails docker top is an error', () => {
  let listings = 0;
  const stopping = (...args: string[]) => {
    if (args[0] === 'ps') return listings++ ? '' : 'run-k6\n';
    throw new Error('No such container');
  };
  assert.deepEqual(ownedPids(['run-k6'], stopping), []);
  const broken = (...args: string[]) => {
    if (args[0] === 'ps') return 'run-k6\n';
    throw new Error('docker top failed');
  };
  assert.throws(() => ownedPids(['run-k6'], broken), /docker top failed/);
});

test('one fresh listing covers a container that starts between the two listings', () => {
  let call = 0;
  const pids = () => call++ ? [4242] : [];
  const idle = (_: string[], excluded: number[]) => {
    assert.ok(excluded.includes(4242), 'Other workers are running');
  };
  assert.doesNotThrow(() => guardIdle(['run-k6'], [10], idle, pids));
});
