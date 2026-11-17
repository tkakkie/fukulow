import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { createLog } from './channel-log.ts';

const root = import.meta.dirname;
// Direct Message inserts that never reach a replaying WebSocket client: SQL
// plan/engine probes; log-compare builds its own channel_log rows.
const noReplay = ['hot-plans/', 'unread-init/', 'search-engines/', 'log-compare/'];
const files = (dir: string): string[] => readdirSync(dir).flatMap(name => {
  const path = join(dir, name);
  if (name === 'node_modules') return [];
  return statSync(path).isDirectory() ? files(path) : [path];
});

test('every replayable fixture that inserts Messages directly appends their Create log', () => {
  const seeding = files(root).filter(path => /\.(ts|sql)$/.test(path) && !path.endsWith('.test.ts'))
    .map(path => relative(root, path)).filter(path => /INSERT INTO messages\s*\(/i.test(readFileSync(join(root, path), 'utf8')));
  const replayable = seeding.filter(path => !noReplay.some(prefix => path.startsWith(prefix)));
  assert.deepEqual(replayable.sort(), ['activity-seed.ts', 'dms-formal-seed.ts', 'dms-history.ts', 'dms-seed.ts']);
  for (const path of replayable) assert.match(readFileSync(join(root, path), 'utf8'), /createLog\(org, /, path);
});

test('createLog runs the shared scoped statement once per psql session', () => {
  const sql = createLog('00000000-0000-0000-0000-000000000001', ['00000000-0000-0000-0000-000000000002']);
  assert.match(sql, /^PREPARE fixture_create_log\(uuid,uuid\[\]\) AS -- /);
  assert.match(sql, /INSERT INTO channel_log [\s\S]*\nFROM messages m\nWHERE m\.organization_id = \$1 AND m\.channel_id = ANY\(\$2\)\n/);
  assert.match(sql, /\n {4}\);\nEXECUTE fixture_create_log\('00000000-0000-0000-0000-000000000001',ARRAY\['00000000-0000-0000-0000-000000000002'::uuid\]::uuid\[\]\);\nDEALLOCATE fixture_create_log;$/);
});
