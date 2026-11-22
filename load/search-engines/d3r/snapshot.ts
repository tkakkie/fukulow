import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, createReadStream, lstatSync, openSync, readFileSync, realpathSync, unlinkSync } from 'node:fs';
import { copyFile } from 'node:fs/promises';
import { boundedCommand } from '../bench.ts';
import { hash } from '../manifest.ts';
import { timeouts } from '../runtime.ts';
import { verifiedBackfill, type BackfillRecord } from './backfill.ts';
import { validRls, type verifyRls } from './rls.ts';

export const snapshotFile = 'verified-cluster.tar';
export const receiptFile = 'preserved-backfill.json';

export type BackfillReceipt = {
  manifestHash: string;
  snapshot: {file: typeof snapshotFile; sha256: string; bytes: number; systemIdentifier: string};
  records: Record<'base' | 'small' | 'denial', BackfillRecord>;
  rls: ReturnType<typeof verifyRls>;
};

function snapshotSize(path: string) {
  const stats = lstatSync(path);
  assert.ok(stats.isFile() && stats.size > 0, 'Expected a regular backfill snapshot file');
  return stats.size;
}

export async function snapshotIdentity(path: string) {
  const bytes = snapshotSize(path);
  const h = createHash('sha256');
  for await (const chunk of createReadStream(path)) h.update(chunk);
  return {sha256: h.digest('hex'), bytes};
}

export async function preserveSnapshot(container: string, out: string, systemIdentifier: string) {
  const call = (...args: string[]) => boundedCommand('docker', args, timeouts.psql);
  call('exec', container, 'pg_basebackup', '-U', 'fukulow', '-D', '/tmp/backfill', '-X', 'stream');
  call('exec', container, 'pg_verifybackup', '/tmp/backfill');
  const path = `${out}/${snapshotFile}`;
  const fd = openSync(path, 'wx', 0o600);
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn('docker', ['exec', container, 'tar', '-C', '/tmp/backfill', '-cf', '-', '.'],
        {stdio: ['ignore', fd, 'inherit'], timeout: timeouts.psql, killSignal: 'SIGKILL'});
      child.on('error', reject);
      child.on('close', code => code === 0 ? resolve() : reject(new Error('Backfill snapshot archive failed')));
    });
  } finally {
    closeSync(fd);
  }
  return {file: snapshotFile, systemIdentifier, ...await snapshotIdentity(path)} as const;
}

export async function loadBackfill(dir: string, manifestHash: string, rows: number, restoreRows: number, restoreDirectory?: string) {
  const directory = realpathSync(dir);
  const read = (file: string) => JSON.parse(readFileSync(`${directory}/${file}`, 'utf8'));
  const receipt: BackfillReceipt = read(receiptFile);
  const finished = read('finished.json');
  const status = read('run-status.json');
  assert.ok(finished.backfillReceiptHash === hash(JSON.stringify(receipt)) && finished.runKind === 'backfill-only' && status.valid === true && status.cleanupVerified === true &&
    [receipt, finished, status].every(record => record.manifestHash === manifestHash),
  'Formal evaluation requires a completed, verified backfill from this manifest');
  assert.ok(verifiedBackfill(receipt.records?.base, rows) && verifiedBackfill(receipt.records?.small, restoreRows) &&
    verifiedBackfill(receipt.records?.denial, 20_011) && validRls(receipt.rls), 'Invalid backfill verification record');
  assert.ok(receipt.snapshot?.file === snapshotFile && /^\d+$/.test(receipt.snapshot.systemIdentifier),
    'Invalid backfill snapshot identity');
  const archive = `${directory}/${snapshotFile}`;
  assert.equal(snapshotSize(archive), receipt.snapshot.bytes, 'Backfill snapshot identity mismatch');
  const verifiedArchive = restoreDirectory ? `${restoreDirectory}/${snapshotFile}` : archive;
  if (restoreDirectory) await copyFile(archive, verifiedArchive);
  assert.deepEqual(await snapshotIdentity(verifiedArchive), {sha256: receipt.snapshot.sha256, bytes: receipt.snapshot.bytes},
    'Backfill snapshot identity mismatch');
  return {directory, snapshotDirectory: restoreDirectory ?? directory, receipt};
}

export function snapshotLaunch(directory: string) {
  const source = `"source=${directory.replaceAll('"', '""')}"`;
  return {
    options: ['--mount', `type=bind,${source},target=/backfill,readonly`, '--entrypoint', 'sh'],
    args: ['-ec', `if [ ! -e /tmp/backfill-extracted ]; then
      mkdir -p "$PGDATA"
      tar -xpf /backfill/${snapshotFile} -C "$PGDATA"
      touch /tmp/backfill-extracted
    fi
    exec docker-entrypoint.sh "$@"`, 'sh'],
  };
}

export function removeSnapshot(directory: string) {
  unlinkSync(`${directory}/${snapshotFile}`);
}
