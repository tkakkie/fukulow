import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { SqlStatementTimeoutError } from '../bench.ts';
import { productionPath } from '../d3r/path.ts';
import { directRlsExpected, searchTables } from '../d3r/rls.ts';
import { timeQuery } from '../d3r/timing.ts';
import { names } from './cluster.ts';
import { db } from './design.ts';
import { recordFixtureRls } from './fixture.ts';

type Call = {args: string[]; sql: string};
type Response = string | {error: string};

function stubDocker(t: TestContext, responses: Response[]) {
  const dir = mkdtempSync(join(tmpdir(), 'churn-fixture-test-'));
  const path = process.env.PATH;
  t.after(() => {
    process.env.PATH = path;
    rmSync(dir, {recursive: true, force: true});
  });
  const log = join(dir, 'calls');
  writeFileSync(log, '');
  writeFileSync(join(dir, 'docker'), `#!${process.execPath}
import { appendFileSync, readFileSync } from 'node:fs';
const log = ${JSON.stringify(log)};
const responses = ${JSON.stringify(responses)};
const args = process.argv.slice(2);
const sql = args.includes('psql') ? readFileSync(0, 'utf8') : '';
const i = readFileSync(log, 'utf8').split('\\n').length - 1;
appendFileSync(log, JSON.stringify({args, sql}) + '\\n');
const response = responses[i];
if (typeof response === 'string') console.log(response);
else if (response) {
  console.error(response.error);
  process.exitCode = 1;
}
`, {mode: 0o755});
  process.env.PATH = dir + delimiter + path;
  return {dir, calls: (): Call[] => readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line))};
}

const measuredSettings = {
  row_security: 'on', default_transaction_read_only: 'off', default_transaction_isolation: 'read committed',
  client_encoding: 'UTF8', standard_conforming_strings: 'on', statement_timeout: '10000', jit: 'off',
};
const tables = Object.fromEntries(searchTables.map(table => [table, [true, true, true]]));
const fixtureReplies = ['100', '0', '0', JSON.stringify(measuredSettings), '0', 'fukulow_app|f|f\n0\n0',
  JSON.stringify(tables), 't'];
const timeout = {error: 'ERROR:  57014: canceling statement due to statement timeout\nDETAIL: private diagnostic'};

test('fixture RLS probes use the setup timeout on one app connection', t => {
  const {dir, calls} = stubDocker(t, [...fixtureReplies, directRlsExpected]);
  recordFixtureRls(names(), 100, dir);
  const all = calls();
  const app = all.filter(({args}) => args[args.indexOf('-U') + 1] === 'fukulow_app');
  assert.equal(app.length, 5);
  assert.equal(all.at(-1), app.at(-1));
  assert.match(app.at(-1)!.sql, /^SET statement_timeout = 0;\s*BEGIN;/);
  assert.equal(app.filter(({sql}) => sql.includes('message_search_terms') && sql.includes('SELECT EXISTS')).length, 1);
  assert.ok(app.slice(0, -1).every(({sql}) => !sql.includes('SET statement_timeout')));
  const receipt = JSON.parse(readFileSync(join(dir, 'rls.json'), 'utf8'));
  assert.deepEqual(receipt.tables, tables);
  assert.deepEqual(receipt.session.settings, measuredSettings);
});

test('fixture RLS verification reports a fixed step label without raw diagnostics', t => {
  const {dir} = stubDocker(t, [...fixtureReplies, timeout]);
  assert.throws(() => recordFixtureRls(names(), 100, dir),
    {message: 'fixture RLS verification failed (SQLSTATE 57014)'});
  assert.equal(existsSync(join(dir, 'rls.json')), false);
});

test('fixture RLS verification omits unexpected query output on mismatch', t => {
  const {dir} = stubDocker(t, [...fixtureReplies, 'private result']);
  assert.throws(() => recordFixtureRls(names(), 100, dir), {message: 'fixture RLS verification failed'});
});

test('measured Search uses a 10 s app session and a 2 s generic-plan transaction', async t => {
  const {dir, calls} = stubDocker(t, ['', '', timeout]);
  const dest = join(dir, 'measured');
  await assert.rejects(timeQuery('client', db, productionPath().page, 'Q1', 'message', false, dest, 1, 1),
    SqlStatementTimeoutError);
  const pgbench = calls().find(({args}) => args.includes('pgbench'));
  assert.ok(pgbench);
  assert.equal(pgbench.args[pgbench.args.indexOf('-U') + 1], 'fukulow_app');
  assert.deepEqual(pgbench.args.filter(arg => arg.startsWith('PGOPTIONS=')), ['PGOPTIONS=-c statement_timeout=10000']);
  const script = readFileSync(`${dest}.sql`, 'utf8');
  assert.match(script, /current_setting\('statement_timeout'\)::interval = interval '10 seconds'/);
  assert.deepEqual(script.match(/^SET LOCAL statement_timeout = .*;$/gm), ["SET LOCAL statement_timeout = '2s';"]);
  assert.match(script, /^SET LOCAL plan_cache_mode = force_generic_plan;$/m);
});
