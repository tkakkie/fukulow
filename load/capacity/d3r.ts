// #788 point 3: disk capacity preflight for the d3r backfill-only and formal runs (#689). It only reads
// the frozen d3r path, so it lives outside load/search-engines/, whose files both search manifests hash.
// Every path is mapped to the physical store it consumes, and each byte is counted once per store.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { lstatSync, readdirSync, readFileSync, statfsSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { dfBytes, dockerDiskArgs, type DiskSample } from '../search-engines/d3r/headroom.ts';

export const GiB = 1024 ** 3;
// Fixed before any formal run (#788): per store, 20% of its need and never less than 20 GiB.
export const margin = (need: number) => Math.max(Math.ceil(need * 0.2), 20 * GiB);

export type Stage = 'backfill-only' | 'formal';
export type Store = {id: string; kind: 'host' | 'docker-vm'; paths: string[]; free: number; mount?: string};
export type Need = {store: string; bytes: number; what: string};
export type Figures = {archiveBytes: number; vmRoundPeak: number; vmRoundGrowth: number; roundOutputBytes: number;
  formalRounds: number};

const bytes = (n: unknown, what: string) => {
  assert.ok(typeof n === 'number' && Number.isSafeInteger(n) && n >= 0, `${what}: not a byte count`);
  return n;
};

// Measured figures from one valid rehearsal: archive size, the Docker VM peak and growth in its round,
// and its whole output directory as the per-round output (the archives are already deleted there).
export function rehearsalFigures(handoff: {snapshot?: {bytes?: number}},
  headroom: {ok?: boolean; problems?: string[]; rehearsalRounds?: number; formalRounds?: number; samples?: DiskSample[];
    projection?: {docker?: {roundGrowth?: number}}}, roundOutputBytes: number): Figures {
  assert.ok(headroom.ok === true && headroom.problems?.length === 0 && headroom.rehearsalRounds === 1,
    'The rehearsal headroom record is not a valid one-round record');
  const docker = (headroom.samples ?? []).map(s => s.docker);
  assert.ok(docker.length >= 2 && docker.every(d => d !== undefined), 'The rehearsal headroom record lacks Docker samples');
  const start = docker[0]!;
  const minFree = Math.min(...docker.map(d => d!.free));
  return {archiveBytes: bytes(handoff.snapshot?.bytes, 'archive'), vmRoundPeak: Math.max(0, start.free - minFree),
    vmRoundGrowth: bytes(headroom.projection?.docker?.roundGrowth, 'round growth'), roundOutputBytes: bytes(roundOutputBytes, 'output'),
    formalRounds: bytes(headroom.formalRounds, 'formal rounds')};
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

// Host store of a path: its device. Paths on one device share one free value and one sum of needs.
export function hostStore(paths: string[], device = (p: string) => String(statSync(p).dev),
  free = (p: string) => { const s = statfsSync(p, {bigint: true}); return Number(s.bavail * s.bsize); }) {
  const stores = new Map<string, Store>();
  const ids = paths.map(path => {
    const id = `host:${device(path)}`;
    const store = stores.get(id) ?? {id, kind: 'host' as const, paths: [], free: free(path)};
    store.paths.push(path);
    stores.set(id, store);
    return id;
  });
  return {ids, stores: [...stores.values()]};
}

function dirBytes(dir: string): number {
  return readdirSync(dir).reduce((sum, name) => {
    const stats = lstatSync(join(dir, name));
    return sum + (stats.isDirectory() ? dirBytes(join(dir, name)) : stats.size);
  }, 0);
}

const readJson = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
const mountOf = (path: string) => execFileSync('df', ['-P', path], {encoding: 'utf8'}).trim().split('\n').at(-1)?.split(/\s+/).at(-1);

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
  const manifest = readJson(new URL('../search-engines/manifest-v16.json', import.meta.url).pathname);
  const status = readJson(join(rehearsal, 'run-status.json'));
  assert.ok(status.valid === true && status.cleanupVerified === true && status.manifestHash === manifest.sha256,
    'The rehearsal is not a valid, cleaned-up run of the current manifest');
  const figures = rehearsalFigures(readJson(join(rehearsal, 'rehearsal-handoff.json')),
    readJson(join(rehearsal, 'rehearsal-headroom.json')), dirBytes(rehearsal));
  const backfill = values['from-backfill'] ? resolve(values['from-backfill']) : undefined;
  if (backfill) {
    const receipt = readJson(join(backfill, 'preserved-backfill.json'));
    const archive = lstatSync(join(backfill, 'verified-cluster.tar'));
    assert.ok(archive.isFile() && archive.size === receipt.snapshot?.bytes, 'The backfill archive does not match its receipt');
    figures.archiveBytes = archive.size;
  }
  const info = JSON.parse(execFileSync('docker', ['info', '--format', '{"os":{{json .OperatingSystem}},"root":{{json .DockerRootDir}}}'],
    {encoding: 'utf8'}));
  const desktop = /Docker Desktop/.test(info.os);
  const dockerDisk = values['docker-disk'] ?? (desktop ? join(homedir(), 'Library/Containers/com.docker.docker/Data/vms/0/data/Docker.raw') : info.root);
  assert.ok(lstatSync(dockerDisk, {throwIfNoEntry: false}), `Docker storage not found at ${dockerDisk}; pass --docker-disk=PATH`);
  const host = hostStore([dirname(out), dockerDisk, ...(backfill ? [backfill] : [])]);
  const stores: Store[] = host.stores.map(s => ({...s, mount: mountOf(s.paths[0])}));
  let vm: string | undefined;
  if (desktop) {
    const image = readJson(join(rehearsal, 'image.json')).id;
    const disk = dfBytes(execFileSync('docker', dockerDiskArgs(image, 'fukulow.d3r-capacity=1'), {encoding: 'utf8'}));
    vm = 'docker-vm';
    stores.push({id: vm, kind: 'docker-vm', paths: ['/ in a throwaway container (Docker Desktop VM disk)'], free: disk.free});
  }
  const maxWalBytes = Number(manifest.frozen.settings.max_wal_size) * 1024 ** 2;
  const list = needs(stage, figures, {output: host.ids[0], dockerHost: host.ids[1], vm}, maxWalBytes);
  const verdict = judge(stores, list);
  const report = {stage, at: new Date().toISOString(), out, backfill, rehearsal, dockerStorage: dockerDisk, dockerDesktop: desktop,
    figures, marginRule: '20% of each store need, at least 20 GiB', ...verdict, result: verdict.ok ? 'CAPACITY OK' : 'STOP'};
  if (values.report) writeFileSync(values.report, JSON.stringify(report, null, 2) + '\n', {flag: 'wx'});
  const gib = (n: number) => (n / GiB).toFixed(1);
  for (const s of verdict.stores) {
    console.log(`${s.id} (${s.paths.join(', ')}${s.mount ? `; mount ${s.mount}` : ''}): free ${gib(s.free)} GiB, need ${gib(s.need)} + margin ${
      gib(s.margin)} GiB -> ${s.ok ? 'ok' : 'SHORT'}`);
    for (const item of s.items) console.log(`  ${gib(item.bytes)} GiB  ${item.what}`);
  }
  console.log(report.result);
  if (!verdict.ok) process.exitCode = 1;
}

if (import.meta.main) main();
