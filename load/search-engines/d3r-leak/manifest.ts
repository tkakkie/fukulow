import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { command } from '../bench.ts';
import { hash } from '../manifest.ts';
import { removedSettings } from '../d3r/manifest.ts';
import { productionPath, readSource, sources } from '../d3r/path.ts';
import { timeouts } from '../runtime.ts';
import { reviewedAssignments } from './arms.ts';
import { formal, rehearsal, smoke } from './design.ts';
import { bootstrap } from './samples.ts';

export const root = fileURLToPath(new URL('../../../', import.meta.url));
export const schemaCommit = '66e6e266477b1a860358b1d735ad271e7d4f6489';
export const manifestFile = 'load/search-engines/manifest-d3r-leak-v24.json';
const d3rManifest = 'load/search-engines/manifest-v18.json';
const harness = 'load/search-engines/d3r-leak';
const smokeCandidates = [32, 128, 512];
export const initialSeed = 689_202_610;

export const base = JSON.parse(readSource(d3rManifest)).frozen as {
  image: string; shmBytes: number; node: string; settings: Record<string, string>;
  migrations: string[]; sourceHashes: {path: string; sha256: string}[];
  timing: {startupAttempts: number; startupPollMs: number};
};

export const settings = {...base.settings, autovacuum: 'off'};
export const freeze = {formal, smoke, rehearsal, bootstrap, smokeCandidates, initialSeed};

export function snapshot(positiveK: number | null) {
  const inputs = [...base.sourceHashes.map(s => s.path), ...Object.values(sources),
    d3rManifest, 'load/search-engines/d3r/manifest.ts',
    'load/launcher/launcher.ts', 'load/launcher/host-busy.ts', 'load/harness-core/frequency-container-args.ts',
    'load/harness-core/frequency-layout.ts', 'load/harness-core/cpusets.ts',
    'load/sql-probes/519-unread-counts/frequency-containers.ts',
    'load/sql-probes/519-unread-counts/frequency-housekeeping.ts', 'load/revocation-holds-placement.ts',
    ...readdirSync(new URL('.', import.meta.url)).filter(file => file.endsWith('.ts') && !file.endsWith('.test.ts'))
      .map(file => `${harness}/${file}`),
  ];
  return {version: 24, schemaCommit, postgres: {image: base.image, settings, removedSettings}, freeze,
    reviewedAssignments, positiveK,
    migrations: base.migrations, node: base.node,
    sourceHashes: [...new Set(inputs)].sort().map(path => ({path, sha256: hash(readSource(path))}))};
}

export function git(...args: string[]) {
  return command('git', ['-C', root, ...args]);
}

export function verifyPinnedSchema() {
  assert.deepEqual(JSON.parse(readSource(d3rManifest)), JSON.parse(git('show', `${schemaCommit}:${d3rManifest}`)),
    'The parent d3r manifest differs from the pinned commit');
  const files = git('ls-tree', '-r', '--name-only', schemaCommit, 'server/migrations').split('\n').filter(file => file.endsWith('.sql'));
  assert.deepEqual(files, base.migrations, 'Pinned migration list differs from d3r v18');
  const expected = new Map(base.sourceHashes.map(file => [file.path, file.sha256]));
  const historicalSources: readonly string[] = [sources.auth, sources.context];
  for (const file of [...files, ...Object.values(sources).filter(file => !historicalSources.includes(file))]) {
    assert.equal(hash(readSource(file)), expected.get(file), `Pinned source hash mismatch: ${file}`);
  }
  // These checkout files are frozen by the leak manifest. Use Git blobs for the historical pins.
  for (const file of historicalSources) {
    const pinned = execFileSync('git', ['-C', root, 'cat-file', 'blob', `${schemaCommit}:${file}`],
      {encoding: 'utf8', timeout: timeouts.docker, killSignal: 'SIGKILL'});
    assert.equal(hash(pinned), expected.get(file), `Pinned source hash mismatch: ${file}`);
  }
  loadManifest();
  return productionPath();
}

export function loadManifest() {
  return verify(readSource(manifestFile));
}

export function verify(text: string) {
  const doc = JSON.parse(text) as {sha256: string; frozen: ReturnType<typeof snapshot>};
  assert.equal(doc.sha256, hash(JSON.stringify(doc.frozen)), 'Frozen leak manifest hash mismatch');
  assert.deepEqual(snapshot(doc.frozen.positiveK), doc.frozen, 'Frozen leak manifest contents differ from checkout');
  assert.equal(process.version, `v${doc.frozen.node}`, 'Use frozen Node version');
  return {...doc, fileHash: hash(text)};
}
