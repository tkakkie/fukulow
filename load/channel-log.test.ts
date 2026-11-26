import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { createLog } from './channel-log.ts';

const root = import.meta.dirname;
// Direct Message inserts that never reach a replaying WebSocket client: SQL
// plan/engine probes (including the 519 counts probe); reply-counts-seed.sql is an HTTP-only static read probe;
// log-compare builds its own channel_log rows.
const noReplay = ['hot-plans/', 'unread-init/', 'sql-probes/519-unread-counts/', 'search-engines/', 'log-compare/', 'reply-counts-seed.sql'];
const files = (dir: string): string[] => readdirSync(dir).flatMap(name => {
  const path = join(dir, name);
  if (name === 'node_modules') return [];
  return statSync(path).isDirectory() ? files(path) : [path];
});

test('every replayable fixture that inserts Messages directly appends their Create log', () => {
  const seeding = files(root).filter(path => /\.(ts|sql)$/.test(path) && !path.endsWith('.test.ts'))
    .map(path => relative(root, path)).filter(path => /INSERT INTO messages\s*\(/i.test(readFileSync(join(root, path), 'utf8')));
  const replayable = seeding.filter(path => !noReplay.some(prefix => path.startsWith(prefix)));
  assert.deepEqual(replayable.sort(), ['dms-formal-seed.ts', 'dms-history.ts', 'dms-seed.ts',
    'move/fixture.ts', 'slice5/fixture.ts']);
  for (const path of replayable) assert.match(readFileSync(join(root, path), 'utf8'), /createLog\(org, /, path);
});

test('createLog appends scoped positions only for the legacy log schema', () => {
  const sql = createLog('00000000-0000-0000-0000-000000000001', ['00000000-0000-0000-0000-000000000002']);
  assert.match(sql, /attname = 'client_message_id' AND NOT attisdropped\) THEN/);
  assert.match(sql, /EXECUTE \$legacy_create\$[\s\S]*INSERT INTO channel_log [\s\S]*\nFROM messages m\nWHERE m\.organization_id = \$1 AND m\.channel_id = ANY\(\$2\)\n/);
  assert.match(sql, /USING '00000000-0000-0000-0000-000000000001'::uuid, ARRAY\['00000000-0000-0000-0000-000000000002'::uuid\]::uuid\[\];/);
  assert.throws(() => createLog('bad', []), /not a UUID/);
});
