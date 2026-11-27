import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { expectF2MigrationDiff, f2Base, f2Blocks, f2Migration, f2SmokeSeed, f2Sources, validateF2 } from './f2-arm.ts';
import { sendBlocks } from './probe.ts';

test('F2 smoke runs one F2 block and the formal plan preserves the comparison order', () => {
  assert.deepEqual(f2Blocks(true), [{ pair: 1, arm: 'f2', order: 1, db: 's1_f2' }]);
  const blocks = f2Blocks(false);
  assert.deepEqual(blocks.map(b => b.arm), ['current', 'final', 'f2', 'final', 'f2', 'current', 'f2', 'current', 'final']);
  assert.deepEqual(blocks.filter(b => b.arm !== 'f2').map(({ pair, arm }) => ({ pair, arm })),
    sendBlocks([['current', 'final'], ['final', 'current'], ['current', 'final']]).map(({ pair, arm }) => ({ pair, arm })));
  assert.equal(new Set(blocks.map(b => b.db)).size, 9);
});

test('F2 CLI rejects an unplaced or unpinned diagnostic before host setup', () => {
  const entry = fileURLToPath(new URL('final.ts', import.meta.url));
  const pin = 'a'.repeat(40);
  for (const [args, error] of [
    [['--smoke'], /requires --sends-only/],
    [['--smoke', '--sends-only', '--attribution'], /without --attribution/],
    [['--smoke', '--sends-only', '--frequency-v3', 'formal'], /takes no --frequency-v3/],
    [['--diagnostic', '--sends-only', '--f2-source', pin], /requires Ubuntu --frequency-v3 formal/],
    [['--diagnostic', '--sends-only', '--frequency-v3', 'formal', '--f2-source', 'HEAD'], /must be a full commit SHA/],
  ] as const) {
    const result = spawnSync(process.execPath, [entry, '--f2', ...args, '--out', '/unused'], { encoding: 'utf8', timeout: 10_000 });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, error);
  }
  assert.doesNotThrow(() => validateF2(false, true, false, 'formal', pin));
});

test('F2 allows only an added F2 migration from the frozen base', () => {
  const path = `server/migrations/${f2Migration}`;
  assert.doesNotThrow(() => expectF2MigrationDiff(`A\t${path}`));
  for (const diff of ['', `M\t${path}`, `A\t${path}\nA\tserver/migrations/extra.sql`, `A\t${path}\nD\tserver/migrations/old.sql`]) {
    assert.throws(() => expectF2MigrationDiff(diff), /unexpected F2 migration diff/);
  }
});

test('F2 pins the checkout, records content hashes and rejects live migration drift', t => {
  const root = mkdtempSync(join(tmpdir(), 'fk519f2-source-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = `server/migrations/${f2Migration}`;
  const commit = 'b'.repeat(40);
  for (const file of [path, 'server/src/messages/log.rs', 'server/src/messages/topics.rs',
    'server/src/messages/send/admitted.rs', 'server/src/messages/mentions.rs']) {
    mkdirSync(join(root, file, '..'), { recursive: true });
    writeFileSync(join(root, file), 'abc');
  }
  let worktreeDiff = '';
  let status = '';
  const git = (cmd: string, ...args: string[]) => {
    if (cmd === 'rev-parse') return commit;
    if (cmd === 'merge-base') return f2Base;
    if (cmd === 'ls-tree') return f2Migration;
    if (cmd === 'status') return status;
    assert.equal(cmd, 'diff');
    return args[1] === f2Base ? `A\t${path}` : worktreeDiff;
  };
  const source = f2Sources(root, git, false, commit);
  assert.equal(source.commit, commit);
  assert.equal(source.hashes[path], 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.throws(() => f2Sources(root, git, false, f2Base), /must be the checked-out commit/);
  status = '?? load/extra.sql';
  assert.throws(() => f2Sources(root, git, false, commit), /clean checkout/);
  worktreeDiff = `M\t${path}`;
  assert.throws(() => f2Sources(root, git, false, commit), /unexpected F2 migration diff in the checkout/);
  assert.equal(f2Sources(root, git, true, undefined).commit, commit);
  writeFileSync(join(root, 'server/migrations/extra.sql'), '');
  assert.throws(() => f2Sources(root, git, true, undefined), /unexpected F2 migration diff in the checkout/);
});

test('F2 smoke shrinks only Message volume on the shared seed', () => {
  const seed = readFileSync(new URL('./sql/seed.sql', import.meta.url), 'utf8');
  const smoke = f2SmokeSeed(seed);
  assert.notEqual(smoke, seed);
  assert.equal(smoke.replace('generate_series(1,300) s;', 'generate_series(1,2000) s;'), seed);
  assert.throws(() => f2SmokeSeed(smoke), /no longer matches the formal seed/);
});
