// #788 point 3: disk capacity preflight for the d3r backfill-only and formal runs (#689). It only reads
// the frozen d3r path, so it lives outside load/search-engines/, whose files both search manifests hash.
// Every path is mapped to the physical allocation pool it consumes, and each byte is counted once per pool.
// A fresh CAPACITY OK report is a required pre-run step (load/harness-core/README.md, "Before the run").
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { lstatSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { dfBytes, dockerDiskArgs, type DiskSample } from '../search-engines/d3r/headroom.ts';
import { verifiedBackfill } from '../search-engines/d3r/backfill.ts';
import { manifestFile } from '../search-engines/d3r/manifest.ts';
import { validRls } from '../search-engines/d3r/rls.ts';
import { receiptFile, snapshotFile } from '../search-engines/d3r/snapshot.ts';
import { hash } from '../search-engines/manifest.ts';
import { desktopDiskLocation, dfTotal, hostStore, imageMatchesVm, localDocker, probePool, readDesktopSettings, realpath, type Store } from './stores.ts';

export const GiB = 1024 ** 3;
// Fixed before any formal run (#788): per store, 20% of its need and never less than 20 GiB.
export const margin = (need: number) => Math.max(Math.ceil(need * 0.2), 20 * GiB);

export type Stage = 'backfill-only' | 'formal';
export type Need = {store: string; bytes: number; what: string};
export type Figures = {archiveBytes: number; vmRoundPeak: number; vmRoundGrowth: number; roundOutputBytes: number;
  formalRounds: number};
type Frozen = {rounds: number; querySet: readonly (readonly [string, string])[]};

const bytes = (n: unknown, what: string, min = 0) => {
  assert.ok(typeof n === 'number' && Number.isSafeInteger(n) && n >= min, `${what}: not a byte count`);
  return n;
};
// A real Docker sample always has some space in use (the restored cluster at least), so used must be above 0.
const validDisk = (d: {free?: unknown; used?: unknown} | undefined) => d !== undefined &&
  typeof d.free === 'number' && Number.isSafeInteger(d.free) && d.free >= 0 &&
  typeof d.used === 'number' && Number.isSafeInteger(d.used) && d.used > 0;

// The labels run.ts samples in a one-round rehearsal, in order (load/search-engines/d3r/run.ts, the round loop).
export const expectedSamples = (querySet: Frozen['querySet']) => ['round 1 start', 'round 1 after warm-up',
  ...querySet.map(([query]) => `round 1 after ${query}`), 'round 1 before dropping measured', 'round 1 end'];

// Measured figures from one valid rehearsal: archive size, the Docker VM peak and growth in its round,
// and its whole output directory as the per-round output (the archives are already deleted there).
// The formal round count comes from the frozen manifest, and the record must hold every sample run.ts takes.
export function rehearsalFigures(handoff: {snapshot?: {bytes?: number}},
  headroom: {ok?: boolean; problems?: string[]; rehearsalRounds?: number; formalRounds?: number; samples?: DiskSample[];
    projection?: {docker?: {roundGrowth?: number}}}, roundOutputBytes: number, frozen: Frozen): Figures {
  assert.ok(headroom.ok === true && headroom.problems?.length === 0 && headroom.rehearsalRounds === 1,
    'The rehearsal headroom record is not a valid one-round record');
  assert.ok(Number.isSafeInteger(frozen.rounds) && frozen.rounds >= 1 && headroom.formalRounds === frozen.rounds,
    'The rehearsal headroom record does not use the frozen formal round count');
  const samples = headroom.samples ?? [];
  assert.deepEqual(samples.map(s => s.at), expectedSamples(frozen.querySet), 'The rehearsal headroom record lacks samples run.ts takes');
  assert.ok(samples.every(s => s.error === undefined && validDisk(s.docker)), 'The rehearsal headroom record lacks valid Docker samples');
  const docker = samples.map(s => s.docker!);
  const start = docker[0], end = docker[docker.length - 1];
  const minFree = Math.min(...docker.map(d => d.free));
  const vmRoundGrowth = bytes(headroom.projection?.docker?.roundGrowth, 'round growth');
  assert.equal(vmRoundGrowth, Math.max(0, end.used - start.used), 'The rehearsal round growth does not match its samples');
  // The measured clone always takes space, so a round without a peak is not a real record.
  const vmRoundPeak = start.free - minFree;
  assert.ok(vmRoundPeak > 0, 'The rehearsal round has no Docker peak (the measured clone is missing)');
  return {archiveBytes: bytes(handoff.snapshot?.bytes, 'archive', 1), vmRoundPeak,
    vmRoundGrowth, roundOutputBytes: bytes(roundOutputBytes, 'output'), formalRounds: frozen.rounds};
}

type BackfillRecords = {receipt: any; finished: any; status: any; archive: {isFile: boolean; size: number}};
// The same record checks as loadBackfill (load/search-engines/d3r/snapshot.ts), short of hashing the archive,
// which the formal run does itself. Returns the archive size the formal stages will copy and extract.
export function backfillArchiveBytes({receipt, finished, status, archive}: BackfillRecords, manifestHash: string,
  rows: number, restoreRows: number) {
  assert.ok(finished.backfillReceiptHash === hash(JSON.stringify(receipt)) && finished.runKind === 'backfill-only' &&
    status.valid === true && status.cleanupVerified === true &&
    [receipt, finished, status].every(record => record.manifestHash === manifestHash),
  'The backfill is not a completed, verified backfill-only run of this manifest');
  assert.ok(verifiedBackfill(receipt.records?.base, rows) && verifiedBackfill(receipt.records?.small, restoreRows) &&
    verifiedBackfill(receipt.records?.denial, 20_011) && validRls(receipt.rls), 'Invalid backfill verification record');
  assert.ok(receipt.snapshot?.file === snapshotFile && /^\d+$/.test(receipt.snapshot.systemIdentifier ?? ''),
    'Invalid backfill snapshot identity');
  const size = bytes(receipt.snapshot.bytes, 'backfill archive', 1);
  assert.ok(archive.isFile && archive.size === size, 'The backfill archive does not match its receipt');
  return size;
}

// What each stage writes, by store. `vm` is the Docker Desktop VM disk; without one (native Docker)
// the cluster lands on the host store of the Docker root directory and is counted there once.
export function needs(stage: Stage, f: Figures, at: {output: string; dockerHost: string; vm?: string}, maxWalBytes: number): Need[] {
  const cluster = at.vm ?? at.dockerHost;
  const list: Need[] = [];
  let clusterBytes: number;
  let imageBytes: number;
  if (stage === 'formal') {
    clusterBytes = f.archiveBytes + f.vmRoundPeak + f.vmRoundGrowth * f.formalRounds;
    // The VM reuses the dropped clone's space, but the host image may not: in the 1M rehearsal the host
    // kept about 50 GiB after the round while the VM kept about 1 GiB. So the host pays the peak every round.
    imageBytes = f.archiveBytes + (f.vmRoundPeak + f.vmRoundGrowth) * f.formalRounds;
    list.push({store: at.output, bytes: f.archiveBytes, what: 'staged copy of the archive (restore-snapshot/)'},
      {store: at.output, bytes: f.roundOutputBytes * f.formalRounds, what: 'round artifacts'},
      {store: cluster, bytes: clusterBytes, what: 'restored cluster, round peak (measured clone) and growth per round'});
  } else {
    clusterBytes = 2 * f.archiveBytes + maxWalBytes;
    imageBytes = clusterBytes;
    list.push({store: at.output, bytes: f.archiveBytes, what: 'archive written to the backfill directory'},
      {store: cluster, bytes: clusterBytes, what: 'seeded cluster, its pg_basebackup copy and max_wal_size'});
  }
  // Docker Desktop's sparse disk image grows on the host as the VM writes new blocks (worst case: all of them).
  if (at.vm) list.push({store: at.dockerHost, bytes: imageBytes, what: 'Docker disk image growth on the host'});
  return list;
}

export function judge(stores: Store[], list: Need[]) {
  const rows = stores.map(store => {
    const items = list.filter(n => n.store === store.id);
    const need = items.reduce((sum, n) => sum + n.bytes, 0);
    const safety = items.length ? margin(need) : 0;
    return {...store, items, need, margin: safety, spare: store.free - need - safety, ok: store.free >= need + safety};
  });
  assert.ok(list.every(n => stores.some(s => s.id === n.store)), 'A need has no measured store');
  return {stores: rows, ok: rows.every(r => r.ok)};
}

function dirBytes(dir: string): number {
  return readdirSync(dir).reduce((sum, name) => {
    const stats = lstatSync(join(dir, name));
    return sum + (stats.isDirectory() ? dirBytes(join(dir, name)) : stats.size);
  }, 0);
}

const readJson = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
const run = (cmd: string, args: string[]) => execFileSync(cmd, args, {encoding: 'utf8'});

// The active Docker endpoint and the daemon behind it; localDocker refuses anything but the local default daemon.
function dockerSide() {
  const info = JSON.parse(run('docker', ['info', '--format',
    '{"os":{{json .OperatingSystem}},"root":{{json .DockerRootDir}},"id":{{json .ID}},"name":{{json .Name}}}']));
  return {context: run('docker', ['context', 'show']).trim(), endpoint: run('docker', ['context', 'inspect', '--format',
    '{{.Endpoints.docker.Host}}']).trim(), envHost: process.env.DOCKER_HOST, os: String(info.os), root: String(info.root),
  daemonId: String(info.id), daemonName: String(info.name)};
}

function main() {
  const usage = 'node load/capacity/d3r.ts --stage=backfill-only|formal --out=PLANNED_OUTPUT --rehearsal=DIR ' +
    '[--from-backfill=DIR] [--docker-disk=PATH] [--report=FILE]';
  const {values} = parseArgs({options: {stage: {type: 'string'}, out: {type: 'string'}, rehearsal: {type: 'string'},
    'from-backfill': {type: 'string'}, 'docker-disk': {type: 'string'}, report: {type: 'string'}}});
  const stage = values.stage as Stage;
  assert.ok((stage === 'backfill-only' || stage === 'formal') && values.out && values.rehearsal, usage);
  assert.ok(Boolean(values['from-backfill']) === (stage === 'formal'), 'A formal preflight needs --from-backfill=DIR, and only it');
  const out = resolve(values.out);
  assert.ok(!lstatSync(out, {throwIfNoEntry: false}), 'The planned output must not exist yet');
  const rehearsal = resolve(values.rehearsal);
  const manifest = readJson(fileURLToPath(new URL('../../' + manifestFile, import.meta.url)));
  const {performance} = manifest.frozen;
  const status = readJson(join(rehearsal, 'run-status.json'));
  const finished = readJson(join(rehearsal, 'finished.json'));
  assert.ok(status.valid === true && status.cleanupVerified === true && finished.runKind === 'rehearsal' &&
    [status, finished].every(record => record.manifestHash === manifest.sha256),
  'The rehearsal is not a valid, cleaned-up rehearsal of the current manifest');
  const figures = rehearsalFigures(readJson(join(rehearsal, 'rehearsal-handoff.json')),
    readJson(join(rehearsal, 'rehearsal-headroom.json')), dirBytes(rehearsal), performance);
  const backfill = values['from-backfill'] ? realpath(values['from-backfill']) : undefined;
  if (backfill) {
    const archive = lstatSync(join(backfill, snapshotFile));
    figures.archiveBytes = backfillArchiveBytes({receipt: readJson(join(backfill, receiptFile)), finished: readJson(join(backfill, 'finished.json')),
      status: readJson(join(backfill, 'run-status.json')), archive: {isFile: archive.isFile(), size: archive.size}},
    manifest.sha256, performance.rows, performance.restoreRows);
  }
  const docker = dockerSide();
  const local = localDocker(process.platform, homedir(), docker, realpath,
    process.platform === 'darwin' ? desktopDiskLocation(readDesktopSettings(homedir())) : undefined, values['docker-disk']);
  const dockerDisk = local.disk;
  const diskStats = lstatSync(dockerDisk);
  assert.ok(local.desktop ? diskStats.isFile() : diskStats.isDirectory(), `Docker storage at ${dockerDisk} is not the expected kind`);
  const host = hostStore([dirname(out), dockerDisk, ...(backfill ? [backfill] : [])], probePool);
  const stores: Store[] = host.stores;
  let vm: string | undefined;
  if (local.desktop) {
    const image = readJson(join(rehearsal, 'image.json')).id;
    const df = run('docker', dockerDiskArgs(image, 'fukulow.d3r-capacity=1'));
    imageMatchesVm(diskStats.size, dfTotal(df));
    vm = 'docker-vm';
    stores.push({id: vm, kind: 'docker-vm', paths: ['/ in a throwaway container (Docker Desktop VM disk)'], free: dfBytes(df).free, mounts: []});
  }
  const maxWalBytes = Number(manifest.frozen.settings.max_wal_size) * 1024 ** 2;
  const list = needs(stage, figures, {output: host.ids[0], dockerHost: host.ids[1], vm}, maxWalBytes);
  const verdict = judge(stores, list);
  const report = {stage, at: new Date().toISOString(), manifestHash: manifest.sha256, out, backfill, rehearsal,
    docker: {...docker, storage: dockerDisk, desktop: local.desktop}, figures,
    marginRule: '20% of each store need, at least 20 GiB', ...verdict, result: verdict.ok ? 'CAPACITY OK' : 'STOP'};
  if (values.report) writeFileSync(values.report, JSON.stringify(report, null, 2) + '\n', {flag: 'wx'});
  const gib = (n: number) => (n / GiB).toFixed(1);
  console.log(`docker: context ${docker.context} (${docker.endpoint}), ${docker.os}, storage ${dockerDisk}`);
  for (const s of verdict.stores) {
    console.log(`${s.id} (${s.paths.join(', ')}${s.mounts.length ? `; mount ${s.mounts.join(', ')}` : ''}): free ${gib(s.free)} GiB, need ${
      gib(s.need)} + margin ${gib(s.margin)} GiB -> ${s.ok ? 'ok' : 'SHORT'}`);
    for (const item of s.items) console.log(`  ${gib(item.bytes)} GiB  ${item.what}`);
  }
  console.log(report.result);
  if (!verdict.ok) process.exitCode = 1;
}

if (import.meta.main) main();
