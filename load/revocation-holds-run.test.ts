import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { STALL_DEFAULT } from './revocation-holds-plan.ts';
import { checkPlacement } from './revocation-holds-placement.ts';
import { preflightIdentity } from './revocation-holds-preflight-fixture.ts';
import { cleanup, measure, type Active } from './revocation-holds-run.ts';
import { SetupAbort } from './revocation-holds-setup.ts';

const slot = { kind: 'fault', cell: 'H512', duration: 'short', repeat: 1 } as const;
const context = (output: string) => ({
  binary: join(output, 'server'), helperBinary: process.execPath, output, stall: STALL_DEFAULT,
  active: {}, interrupted: () => false, setup: { kind: 'preflight', sendBuffer: preflightIdentity.sendBuffer } as const, linuxPlacement: false,
});

function withoutDocker(t: { after: (fn: () => void) => void }) {
  const output = mkdtempSync(join(tmpdir(), 'revocation-prepare-'));
  const path = process.env.PATH;
  process.env.PATH = output; // Make the Docker executable unavailable without starting a container.
  t.after(() => {
    if (path === undefined) delete process.env.PATH;
    else process.env.PATH = path;
    rmSync(output, { force: true, recursive: true });
  });
  return output;
}

test('a database startup error retains its original error type', async t => {
  const output = withoutDocker(t);
  await assert.rejects(measure(context(output), slot), error => {
    assert.ok(!(error instanceof SetupAbort));
    assert.equal((error as NodeJS.ErrnoException).code, 'ENOENT');
    return true;
  });
});

test('measure aborts on missing SA2 before provisioning or producing a run', async t => {
  const output = withoutDocker(t);
  await assert.rejects(measure({
    ...context(output), setup: { kind: 'measured', identity: preflightIdentity, ledger: join(output, 'missing.ndjson') },
  }, slot), { name: 'Error', message: /^SA2:/ });
  assert.equal(existsSync(join(output, 'H512-short-r1', 'run.json')), false);
});

test('measure rejects a misplaced Linux client at setup before provisioning', async t => {
  const output = withoutDocker(t);
  try {
    checkPlacement('client', process.pid);
    t.skip('test process already has the required Linux placement');
    return;
  } catch { /* The harness check must reject this process. */ }
  await assert.rejects(measure({ ...context(output), linuxPlacement: true }, slot),
    error => error instanceof SetupAbort && error.message.startsWith('CPU placement:'));
  assert.equal(existsSync(join(output, 'H512-short-r1', 'run.json')), false);
});


test('the persistence snapshot hook sees the stopped server before database teardown', async () => {
  const events = new EventEmitter();
  const server = Object.assign(events, {
    pid: 123, exitCode: null as number | null, signalCode: null,
    kill() {
      queueMicrotask(() => {
        this.exitCode = 0;
        events.emit('exit', 0, null);
      });
      return true;
    },
  });
  const db = { name: 'unit-test-no-container', port: 1, ownerPassword: '', appPassword: '' };
  const active: Active = { server: server as unknown as ChildProcess, db };
  let snapshots = 0;
  active.beforeRemoveDatabase = snapshotDb => {
    assert.equal(server.exitCode, 0);
    assert.equal(snapshotDb, db);
    assert.equal(active.db, db);
    snapshots++;
  };
  assert.equal(await cleanup(active), true);
  assert.equal(snapshots, 1);
  assert.equal(active.db, undefined);
});
