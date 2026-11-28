import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { command } from '../bench.ts';
import { manifestFile as baseManifest } from '../d3r/manifest.ts';
import { readSource } from '../d3r/path.ts';
import { hash } from '../manifest.ts';
import { appSettings, base, full, k6Reference, queries, sampleSeconds, sessionOverrides, sourceCommit } from './design.ts';

export const manifestFile = 'load/search-engines/manifest-d3r-churn-v21.json';
const directory = 'load/search-engines/d3r-churn';
const buildInputs = ['Dockerfile', '.dockerignore', 'Cargo.toml', 'Cargo.lock', 'rust-toolchain.toml',
  'about.toml', 'deny.toml', 'LICENSE-MIT', 'LICENSE-APACHE', 'scripts/third-party-notices.ts',
  'deploy/init-db-roles.sh', 'deploy/db-roles.sql', 'deploy/db-role-settings.sql', 'deploy/db-grants.sql'];
// Resolve the checkout from this file so `npm --prefix load test` and the repository root agree.
const checkout = fileURLToPath(new URL('../../../', import.meta.url));
export const git = (...args: string[]) => command('git', ['-C', checkout, ...args]);

function sourceFiles() {
  const files = new Set([...buildInputs, baseManifest, ...base.sourceHashes.map(source => source.path),
    'server/tests/auth.rs', 'server/src/main.rs', 'server/src/database.rs', 'Makefile',
    'load/search-m1.ts', 'load/dms-storage.ts', 'load/throughput.ts',
    ...readdirSync(resolve(checkout, directory)).filter(file => file.endsWith('.ts') && !file.endsWith('.test.ts')).map(file => `${directory}/${file}`)]);
  // Include the direct and transitive local imports of the reused helpers and k6 script.
  for (const file of files) {
    if (!file.startsWith('load/') || !file.endsWith('.ts')) continue;
    for (const [, path] of readSource(file).matchAll(/^\s*(?:import|export)\b[\s\S]*?\bfrom ['"](\.[^'"]+\.ts)['"]/gm)) {
      files.add(relative(checkout, resolve(checkout, dirname(file), path)));
    }
  }
  return [...files].sort();
}

export function snapshot() {
  return {version: 21, experiment: '#689 item 4c Phase A', sourceCommit, node: base.node,
    postgres: {image: base.image, serverVersion: '180006', settings: {}, required: {
      autovacuum: 'on', fsync: 'on', synchronous_commit: 'on', wal_level: 'replica', shared_preload_libraries: '',
    }}, sessionOverrides, appSettings, k6: k6Reference,
    generator: base.generator, phases: full, sampleSeconds, queries,
    migrations: base.migrations, sourceHashes: sourceFiles().map(path => ({path, sha256: hash(readSource(path))}))};
}

export function loadManifest(text = readSource(manifestFile)) {
  const doc = JSON.parse(text) as {sha256: string; frozen: ReturnType<typeof snapshot>};
  assert.equal(doc.sha256, hash(JSON.stringify(doc.frozen)), 'Phase A manifest content hash mismatch');
  assert.deepEqual(doc.frozen, snapshot(), 'Phase A manifest or source hashes differ from checkout');
  assert.equal(process.version, `v${doc.frozen.node}`, 'Use frozen Node version');
  assert.equal(queries.length, 23, 'Accepted 1M query set changed');
  const generator = 'load/search-engines/seed.ts';
  assert.equal(hash(readSource(generator)), base.sourceHashes.find(source => source.path === generator)?.sha256,
    'Phase A must use the exact d3r v18 generator');
  return {...doc, fileHash: hash(text)};
}

export function verifyProduct() {
  const paths = [...buildInputs, 'server', 'web', 'client-core', 'api-types', 'contract/reactions/emoji.json'];
  assert.equal(git('diff', '--name-only', sourceCommit, '--', ...paths), '', 'Production build inputs differ from the pinned commit');
  assert.equal(git('ls-files', '--others', '--exclude-standard', '--', ...paths), '', 'Untracked production build inputs');
  assert.ok(readSource('Makefile').includes(`K6_IMAGE := ${k6Reference}\n`), 'W1 k6 image pin differs from M1/S1');
}
