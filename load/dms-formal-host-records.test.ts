import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmodSync, rmSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Command } from './dms-formal-exec.ts';
import { copyDockerVmLogs, dockerVmLogDirectory, firstTimestampMs, logShowTime, redactHostText, saveHostLog, startHostSampler } from './dms-formal-host-records.ts';

const secret = 'f'.repeat(64);
const redact = (text: string) => redactHostText(text, { secrets: [secret], home: '/Users/someone', user: 'someone', host: 'Someones-MacBook-Pro.local' });

test('host text redaction removes run secrets, credentials, tokens, the home path and the user name', () => {
  const raw = [
    `env DM_PASSWORD=${secret} ok`, 'postgres password: hunter2-long', 'Authorization: Bearer abc.def.ghi', 'token="x y z"',
    'path /Users/someone/Library/Containers/com.docker.docker/Data/log/vm/console.log', 'user someone logged', '/Users/other/x',
    'container 0123456789abcdef0123456789abcdef0123', 'blk_update_request: I/O error, dev vda, sector 123',
    'key ' + 'Ab1_'.repeat(12),
  ].join('\n');
  const out = redact(raw);
  for (const leak of [secret, 'hunter2', 'abc.def', 'x y z', 'someone', '/Users/other', '0123456789abcdef', 'Ab1_Ab1_']) assert.ok(!out.includes(leak), leak);
  assert.match(out, /~\/Library\/Containers\/com\.docker\.docker\/Data\/log\/vm\/console\.log/);
  assert.match(out, /blk_update_request: I\/O error, dev vda, sector 123/, 'kernel I/O evidence survives');
  assert.match(out, /\[user\] logged/);
});

test('host text redaction handles short secrets in underscored keys, headers, URIs, sockets and any letter case', () => {
  const cases: [string, string][] = [
    ['POSTGRES_PASSWORD=hunter2', 'hunter2'], ['DB_PASSWORD: my-pass', 'my-pass'], ['ACCESS_TOKEN=tok.123', 'tok.123'],
    ['AWS_SECRET_KEY=ab+cd/ef==', 'ab+cd/ef=='], ['{"api_key":"k1"}', 'k1'],
    ['Authorization: Basic dXNlcjpwYXNz', 'dXNlcjpwYXNz'], ['Cookie: a=1; session=secret123', 'session=secret123'],
    ['Set-Cookie: sid=s3; Path=/', 'sid=s3'], ['proxy=http://dev:shortpw@proxy.invalid:3128', 'shortpw'],
    ['postgres://fukulow:pw9@db/fukulow', 'pw9'], ['https://tok@host.invalid/x', 'tok@'],
    ['Cannot connect to the Docker daemon at unix:///Users/someone/.docker/run/docker.sock', 'someone'],
    ['dial unix /var/run/docker.sock: connect', 'docker.sock'],
    ['/USERS/SOMEONE/Library', 'SOMEONE'], ['/home/someone/x', 'someone'], ['user Someone logged', 'Someone'],
    ['host Someones-MacBook-Pro kernel', 'Someones'], ['someone_mbp', 'someone'],
  ];
  for (const [raw, leak] of cases) assert.ok(!redact(raw).includes(leak), `${raw} -> ${redact(raw)}`);
  assert.equal(redact('Cookie: a=1; session=secret123'), 'Cookie: [redacted]');
  assert.equal(redact('proxy=http://dev:shortpw@proxy.invalid'), 'proxy=http://[redacted]@proxy.invalid');
  assert.equal(redact('blk_update_request: I/O error, dev vda'), 'blk_update_request: I/O error, dev vda');
});

test('a quoted credential value is redacted to its unescaped closing quote, or to the end of the line', () => {
  // An escaped quote inside the value used to end the match early and leave the rest of the password.
  assert.equal(redact('{"password":"ab\\"cd-suffix","next":1}'), '{"password":[redacted],"next":1}');
  assert.equal(redact("{'db_password':'ab\\'cd-suffix'} tail"), "{'db_password':[redacted]} tail");
  assert.equal(redact('password="unterminated rest of line\nnext line'), 'password=[redacted]\nnext line');
  // A doubly escaped JSON value is redacted to the end of its line.
  const doubled = redact('{\\"db_password\\":\\"ab\\\\\\"cd-tail\\"}\nnext');
  assert.ok(!doubled.includes('cd-tail') && !doubled.includes('ab'), doubled);
  assert.match(doubled, /\nnext$/);
});

test('host sampler records cumulative iostat and vm_stat each tick and marks a failed or empty command as failed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'host-sampler-'));
  const programs: string[] = [];
  let ticks = 0;
  const exec = async (command: Command) => {
    programs.push(command.program + ' ' + command.args.join(' '));
    if (command.program === 'vm_stat') ticks++;
    if (command.program === 'iostat' && ticks === 0) return { code: 1, stdout: '' };
    if (command.program === 'vm_stat' && ticks === 2) return { code: 0, stdout: '  \n' };
    return { code: 0, stdout: command.program === 'iostat' ? '  KB/t  xfrs   MB\n 20.00  100  2.00' : 'Pages free: 10.' };
  };
  const stop = startHostSampler(exec, join(dir, 'host.jsonl'), 5);
  while (ticks < 3) await new Promise(resolve => setTimeout(resolve, 2));
  const coverage = await stop();
  const rows = readFileSync(join(dir, 'host.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(new Set(programs), new Set(['iostat -I', 'vm_stat ']));
  assert.equal(rows.length, coverage.attempted);
  assert.equal(rows[0].iostat, null, 'failed, not skipped');
  assert.equal(rows[0].vmStat, 'Pages free: 10.');
  assert.equal(rows[1].vmStat, null, 'exit 0 with empty output is a failed sample');
  assert.deepEqual([coverage.iostatFailed, coverage.vmStatFailed, coverage.complete, coverage.commands], [1, 1, false, coverage.attempted * 2]);
  for (let i = 1; i < rows.length; i++) assert.ok(rows[i].atMs >= rows[i - 1].atMs);
});

test('a host sample row that cannot be written is a write failure, so the coverage is not complete', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'host-sampler-gone-'));
  let ticks = 0;
  const stop = startHostSampler(async command => { if (command.program === 'vm_stat') ticks++; return { code: 0, stdout: 'x' }; }, join(dir, 'host.jsonl'), 5);
  rmSync(dir, { recursive: true, force: true });
  while (ticks < 2) await new Promise(resolve => setTimeout(resolve, 2));
  const coverage = await stop();
  assert.ok(coverage.writeFailures >= 1);
  assert.equal(coverage.complete, false);
});

test('Docker VM log copy keeps only console and init logs changed during the run, redacted', () => {
  const root = mkdtempSync(join(tmpdir(), 'vm-logs-')), source = join(root, 'vm'), destination = join(root, 'out');
  mkdirSync(source);
  writeFileSync(join(source, 'console.log'), 'kernel: hung_task ' + secret);
  writeFileSync(join(source, 'console.log.0'), 'old');
  writeFileSync(join(source, 'init.log'), '1970-01-01T00:00:05Z init /Users/someone/x');
  writeFileSync(join(source, 'other.log'), 'ignored');
  utimesSync(join(source, 'console.log.0'), 1, 1);
  const record = copyDockerVmLogs(source, destination, 10_000, redact);
  assert.deepEqual(record, { status: 'complete', files: ['console.log', 'init.log'], skippedOlder: 1, truncated: [] });
  assert.deepEqual(readdirSync(destination).sort(), ['console.log', 'init.log']);
  assert.equal(readFileSync(join(destination, 'console.log'), 'utf8'), 'kernel: hung_task [redacted]');
  assert.equal(readFileSync(join(destination, 'init.log'), 'utf8'), '1970-01-01T00:00:05Z init ~/x');
  assert.equal(copyDockerVmLogs(join(root, 'absent'), destination, 0, redact).status, 'missing');
  const locked = join(root, 'locked');
  mkdirSync(locked);
  chmodSync(locked, 0);
  try { assert.equal(copyDockerVmLogs(locked, destination, 0, redact).status, process.getuid?.() === 0 ? 'missing' : 'failed', 'EACCES is failed, not missing'); }
  finally { chmodSync(locked, 0o700); }
  assert.equal(copyDockerVmLogs(source, destination, Date.now() + 60_000, redact).status, 'missing');
  assert.equal(dockerVmLogDirectory('/Users/x'), '/Users/x/Library/Containers/com.docker.docker/Data/log/vm');
});

test('a VM log cut to its last 32 MiB is complete only if the kept part reaches back to the run start', () => {
  const root = mkdtempSync(join(tmpdir(), 'vm-logs-big-')), source = join(root, 'vm');
  mkdirSync(source);
  const runStart = Date.parse('2026-11-22T03:00:00Z');
  const line = (iso: string) => `${iso} kernel: ok ${'x'.repeat(200)}\n`;
  const filler = (iso: string, bytes: number) => line(iso).repeat(Math.ceil(bytes / line(iso).length));
  writeFileSync(join(source, 'console.log'), filler('2026-11-22T02:00:00.000Z', 33 * 1024 * 1024) + line('2026-11-22T03:30:00.000Z'));
  const covered = copyDockerVmLogs(source, join(root, 'a'), runStart, redact);
  assert.deepEqual([covered.status, covered.truncated], ['complete', ['console.log']]);
  writeFileSync(join(source, 'console.log'), filler('2026-11-22T01:00:00.000Z', 2 * 1024 * 1024) + filler('2026-11-22T03:10:00.000Z', 33 * 1024 * 1024));
  const lost = copyDockerVmLogs(source, join(root, 'b'), runStart, redact);
  assert.deepEqual([lost.status, lost.truncated], ['partial', ['console.log']], 'the seed start was cut off');
  assert.ok(readFileSync(join(root, 'b', 'console.log')).length <= 32 * 1024 * 1024);
  assert.equal(firstTimestampMs('no timestamps here'), null);
});

test('every copied VM log set must reach back to the run start, not only cut files', () => {
  const root = mkdtempSync(join(tmpdir(), 'vm-logs-rotated-')), source = join(root, 'vm');
  mkdirSync(source);
  const runStart = Date.parse('2026-11-22T03:00:00Z');
  // Rotation removed the earlier files: the only console log is small and starts 15 minutes into the seed.
  writeFileSync(join(source, 'console.log'), '2026-11-22T03:15:00.000Z kernel: ok\n2026-11-22T03:20:00.000Z kernel: ok\n');
  const lost = copyDockerVmLogs(source, join(root, 'a'), runStart, redact);
  assert.deepEqual([lost.status, lost.truncated, lost.files], ['partial', [], ['console.log']]);
  assert.match(lost.reason!, /console/);
  // An entry at or before the start covers the set, in any of its copied files.
  writeFileSync(join(source, 'console.log.0'), '2026-11-22T02:59:00.000Z kernel: earlier\n');
  assert.equal(copyDockerVmLogs(source, join(root, 'b'), runStart, redact).status, 'complete');
  rmSync(join(source, 'console.log.0'));
  // A set file last written before the start (skipped) shows the copied ones continue it.
  writeFileSync(join(source, 'console.log.1'), '2026-11-22T02:00:00.000Z kernel: old\n');
  utimesSync(join(source, 'console.log.1'), new Date(runStart - 60_000), new Date(runStart - 60_000));
  assert.equal(copyDockerVmLogs(source, join(root, 'c'), runStart, redact).status, 'complete');
  // Each set is checked on its own: an init log without any entry at the start is partial, too.
  writeFileSync(join(source, 'init.log'), 'no timestamp');
  const init = copyDockerVmLogs(source, join(root, 'd'), runStart, redact);
  assert.deepEqual([init.status, /init/.test(init.reason!), /console/.test(init.reason!)], ['partial', true, false]);
});

test('host log covers the run window with a minute of margin and records a failure', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'host-log-'));
  const start = new Date(2026, 10, 22, 3, 42, 33).getTime(), end = new Date(2026, 10, 22, 4, 30, 5).getTime();
  assert.equal(logShowTime(start), '2026-11-22 03:42:33');
  let seen: string[] = [];
  const record = await saveHostLog(async command => { seen = command.args; return { code: 0, stdout: 'powerd: sleep ' + secret }; },
    join(dir, 'host.log'), start, end, redact);
  assert.equal(record.status, 'complete');
  assert.deepEqual(seen.slice(0, 7), ['show', '--style', 'syslog', '--start', '2026-11-22 03:41:33', '--end', '2026-11-22 04:31:05']);
  assert.equal(readFileSync(join(dir, 'host.log'), 'utf8'), 'powerd: sleep [redacted]\n');
  const failed = await saveHostLog(async () => ({ code: 1, stdout: '' }), join(dir, 'failed.log'), start, end, redact);
  assert.equal(failed.status, 'failed');
  let called = false;
  const skipped = await saveHostLog(async () => { called = true; return { code: 0, stdout: '' }; }, join(dir, 'skipped.log'), start, end, redact, { skip: true });
  assert.deepEqual([skipped.status, called], ['failed', false], 'after an interrupt the log is skipped and recorded, never collected');
  let timeout = 0;
  await saveHostLog(async command => { timeout = command.timeout!; return { code: 0, stdout: 'x' }; }, join(dir, 'bounded.log'), start, end, redact, { timeoutMs: 5_000 });
  assert.equal(timeout, 5_000, 'the runner bounds it by the deadline budget');
});
