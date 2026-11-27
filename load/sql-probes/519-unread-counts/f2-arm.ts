import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export const f2Base = '6e2d1d4d2f6f0fba1d2cedf7e84f3fb68912fa33';
export const f2Migration = '202611271100_unread_counts_scope_total.sql';
export const topicPageMigration = '202611221101_topics_page.sql';
export const createCutover = '202611260620_create_from_messages.sql';
export const f2Send = 'send-f2.sql';
export const pref2Send = 'send-pref2.sql';

export const f2Order = [
  ['current', 'final', 'f2', 'pref2'],
  ['final', 'pref2', 'current', 'f2'],
  ['pref2', 'f2', 'final', 'current'],
  ['f2', 'current', 'pref2', 'final'],
] as const;
const smokeOrder = [['pref2', 'f2']] as const;
export const f2BlockOrder = (smoke: boolean) => smoke ? smokeOrder : f2Order;

export function f2Blocks(smoke: boolean) {
  return f2BlockOrder(smoke).flatMap((arms, i) => arms.map(arm => ({ pair: i + 1, arm })))
    .map((block, i) => ({ ...block, order: i + 1, db: `s${i + 1}_${block.arm}` }));
}

const fullCommit = /^[0-9a-f]{40}$/;
const migrations = 'server/migrations';
const f2Path = `${migrations}/${f2Migration}`;
const rustSend = ['log.rs', 'topics.rs', 'send/admitted.rs', 'mentions.rs'].map(name => `server/src/messages/${name}`);
const sha256 = (body: string | Buffer) => createHash('sha256').update(body).digest('hex');

export function validateF2(smoke: boolean, sendsOnly: boolean, attribution: boolean, stage: string | undefined, source: string | undefined) {
  if (!sendsOnly || attribution) throw new Error('--f2 requires --sends-only without --attribution');
  if (smoke && stage !== undefined) throw new Error('--smoke --f2 takes no --frequency-v3');
  if (!smoke && stage !== 'formal') throw new Error('--diagnostic --f2 requires Ubuntu --frequency-v3 formal');
  if ((!smoke || source !== undefined) && !fullCommit.test(source ?? '')) throw new Error('--f2-source must be a full commit SHA');
}

export function expectF2MigrationDiff(diff: string) {
  if (diff !== `A\t${f2Path}`) throw new Error(`unexpected F2 migration diff from ${f2Base}: ${diff || '(empty)'}`);
}

export function f2Sources(root: string, readGit: (...args: string[]) => string, smoke: boolean, pin: string | undefined) {
  const git = (...args: string[]) => readGit(...args).trim();
  const head = git('rev-parse', 'HEAD');
  const commit = pin ?? head;
  if (commit !== head) throw new Error('--f2-source must be the checked-out commit');
  if (git('merge-base', f2Base, commit) !== f2Base) throw new Error('F2 source must descend from its pinned base');
  expectF2MigrationDiff(git('diff', '--name-status', f2Base, commit, '--', migrations));
  const names = readdirSync(join(root, migrations)).filter(name => name.endsWith('.sql')).sort();
  const committed = git('ls-tree', '--name-only', commit + ':' + migrations).split('\n').filter(name => name.endsWith('.sql')).sort();
  const diff = git('diff', '--name-status', commit, '--', migrations);
  if (names.join('\n') !== committed.join('\n') || (diff !== '' && !(smoke && diff === `M\t${f2Path}`))) {
    throw new Error(`unexpected F2 migration diff in the checkout: ${diff || 'migration file inventory changed'}`);
  }
  if (!smoke && git('status', '--porcelain', '--untracked-files=all') !== '') throw new Error('--f2 diagnostic requires a clean checkout');
  // In smoke mode the author can exercise an uncommitted round. Record the exact bytes used.
  const migration = readFileSync(join(root, f2Path));
  return {
    commit, base: f2Base, migration,
    hashes: Object.fromEntries([f2Path, ...rustSend].map(path => [path, hashFile(join(root, path))])),
    baseHashes: Object.fromEntries(rustSend.map(path => [path, sha256(readGit('show', `${f2Base}:${path}`))])),
  };
}

export function f2SeedSql(smoke: boolean) {
  const seed = 'sql/seed.sql';
  return smoke ? 'sql/seed-f2-smoke.sql' : seed;
}

export const f2SmokeMessagesPerChannel = 300;

export function f2SmokeSeed(seed: string) {
  const full = 'generate_series(1,2000) s;';
  if (seed.split(full).length !== 2) throw new Error('F2 smoke seed no longer matches the formal seed');
  return seed.replace(full, `generate_series(1,${f2SmokeMessagesPerChannel}) s;`);
}

// #620 validates the original Create log by bijection before it removes it.
// The shared probe seed omits the redundant log, so reconstruct it on each clone that applies #620.
export const seedCreateLog = `INSERT INTO channel_log
  (organization_id, channel_id, event_seq, kind, message_id, sender, client_message_id)
  SELECT organization_id, channel_id, seq, 'create', id, sender, client_message_id FROM messages;`;

export const hashFile = (path: string) => sha256(readFileSync(path));
