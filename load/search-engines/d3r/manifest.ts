import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { hash, postgresArguments, smokeLabel, snapshot as v13 } from '../manifest.ts';
import { criteria } from '../summarize.ts';
import { pageSize, readSource, sources } from './path.ts';
import { shortIds } from './acceptance.ts';
import { rehearsalLabel } from './labels.ts';
import { forceSearchRls } from './rls.ts';

const directory = 'load/search-engines/d3r';
const root = new URL('../../../', import.meta.url);
const prefix = 'server/migrations';
export const manifestFile = 'load/search-engines/manifest-v16.json';
export const removedSettings = {
  shared_preload_libraries: 'The v13 value preloads the PGroonga WAL and crash-safety libraries, which are absent in plain PostgreSQL.',
  'pgroonga.enable_wal_resource_manager': 'The PGroonga WAL resource manager is absent.',
  'pgroonga.enable_crash_safe': 'The PGroonga crash-safety module is absent.',
};
export const argumentsForPostgres = ['postgres', ...postgresArguments.filter((_, index) => index >= 2 && index % 2 === 0)
  .filter(arg => !(arg.split('=')[0] in removedSettings)).flatMap(arg => ['-c', arg])];

export function snapshot() {
  const base = v13();
  const migrations = readdirSync(new URL(prefix, root)).filter(name => name.endsWith('.sql'))
    .sort().map(name => prefix + '/' + name);
  const files = [...base.sourceHashes.map(source => source.path), ...migrations, ...Object.values(sources),
    'load/search-engines/manifest-v13.json', 'load/d3r-semantics.ts',
    ...readdirSync(new URL(directory, root)).filter(name => name.endsWith('.ts')).map(name => directory + '/' + name)];
  const {order, writeWarmTransactions, writeTransactions, ...performance} = base.performance;
  const {rangeDays, ...timing} = base.timing;
  const {b1Settings, ...sessionPolicy} = base.sessionPolicy;
  return {
    version: 16, date: '2026-11-23', engine: 'd3r', generator: base.generator, node: base.node,
    image: base.image.base, shmBytes: base.shmBytes,
    settings: Object.fromEntries(Object.entries(base.settings).filter(([name]) => !(name in removedSettings))),
    removedSettings, sessionPolicy,
    sourceHashes: [...new Set(files)].sort().map(path => ({path, sha256: hash(readSource(path))})), migrations,
    setup: {forceSearchRls, backfill: 'Verified physical PostgreSQL snapshot of the base, restore and denial fixtures',
      round: 'Create measured from the restored base template, restart PostgreSQL, then warm each query in a fresh psql session'},
    queryPath: {sources, role: 'fukulow_app', pageSize, history: 'full',
      context: 'REPEATABLE READ READ ONLY with transaction-local Organization context',
      plan: 'force_generic_plan on the production d3r page statement', statementTimeout: '2s',
      rls: 'forced and active on all five search tables'},
    performance, smoke: {label: smokeLabel, performance: {rows: 1000, clients: 1, transactions: 1, rounds: 1}},
    rehearsal: {label: rehearsalLabel, performance: {rounds: 1}, evidence: 'never; only completeness against the formal checks is recorded'}, timing,
    criteria: {p95LimitMs: criteria.p95LimitMs, samplesPerQueryRound: criteria.samplesPerQueryRound, shortIds,
      shortRejection: 'search_query_too_short', index: 'All accepted first-round plans execute the term lookup index and have no Messages Seq Scan.',
      completeness: 'All pages in order, for six Members, against the independent full-history token-containment scan.',
      denials: 'All #153 cases with positive controls, both unforced and forced, adapted to full history and d3r rejections.',
      restore: 'Custom dump, clean database restore, grants, checksums, RLS, term verification and six-Member completeness.',
      backfill: 'Every seeded Message has independently verified terms. A mismatch invalidates the run.'},
  };
}

export function loadManifest() {
  const doc: {sha256: string; frozen: ReturnType<typeof snapshot>} = JSON.parse(readSource(manifestFile));
  assert.equal(doc.sha256, hash(JSON.stringify(doc.frozen)), 'Frozen d3r manifest content hash mismatch');
  assert.deepEqual(snapshot(), doc.frozen, 'Frozen d3r manifest mismatch');
  assert.equal(process.version, `v${doc.frozen.node}`, 'Use frozen Node version');
  return doc;
}
