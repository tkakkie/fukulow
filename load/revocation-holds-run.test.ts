import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { STALL_DEFAULT } from './revocation-holds-plan.ts';
import { measure, SetupAbort } from './revocation-holds-run.ts';

test('a database startup error retains its original error type', async t => {
  const output = mkdtempSync(join(tmpdir(), 'revocation-prepare-'));
  const path = process.env.PATH;
  process.env.PATH = output; // Make the Docker executable unavailable without starting a container.
  t.after(() => {
    if (path === undefined) delete process.env.PATH;
    else process.env.PATH = path;
    rmSync(output, { force: true, recursive: true });
  });
  const ctx = { binary: join(output, 'server'), output, stall: STALL_DEFAULT, active: {}, interrupted: () => false };
  await assert.rejects(measure(ctx, { kind: 'fault', cell: 'H512', duration: 'short', repeat: 1 }), error => {
    assert.ok(!(error instanceof SetupAbort));
    assert.equal((error as NodeJS.ErrnoException).code, 'ENOENT');
    return true;
  });
});
