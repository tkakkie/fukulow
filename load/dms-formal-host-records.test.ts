import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Command } from './dms-formal-exec.ts';
import { copyDockerVmLogs, dockerVmLogDirectory, logShowTime, redactHostText, saveHostLog, startHostSampler } from './dms-formal-host-records.ts';

const secret = 'f'.repeat(64);
const redact = (text: string) => redactHostText(text, { secrets: [secret], home: '/Users/someone', user: 'someone' });

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

test('host sampler records cumulative iostat and vm_stat each tick and marks a failed command as missing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'host-sampler-'));
  const programs: string[] = [];
  let ticks = 0;
  const exec = async (command: Command) => {
    programs.push(command.program + ' ' + command.args.join(' '));
    if (command.program === 'vm_stat') ticks++;
    if (command.program === 'iostat' && ticks === 0) return { code: 1, stdout: '' };
    return { code: 0, stdout: command.program === 'iostat' ? '  KB/t  xfrs   MB\n 20.00  100  2.00' : 'Pages free: 10.' };
  };
  const stop = startHostSampler(exec, join(dir, 'host.jsonl'), 5);
  while (ticks < 3) await new Promise(resolve => setTimeout(resolve, 2));
  const coverage = await stop();
  const rows = readFileSync(join(dir, 'host.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(new Set(programs), new Set(['iostat -I', 'vm_stat ']));
  assert.equal(rows.length, coverage.attempted);
  assert.equal(rows[0].iostat, null, 'missing, not skipped');
  assert.equal(rows[1].vmStat, 'Pages free: 10.');
  assert.deepEqual([coverage.iostatMissing, coverage.vmStatMissing, coverage.complete, coverage.commands], [1, 0, false, coverage.attempted * 2]);
  for (let i = 1; i < rows.length; i++) assert.ok(rows[i].atMs >= rows[i - 1].atMs);
});

test('Docker VM log copy keeps only console and init logs changed during the run, redacted', () => {
  const root = mkdtempSync(join(tmpdir(), 'vm-logs-')), source = join(root, 'vm'), destination = join(root, 'out');
  mkdirSync(source);
  writeFileSync(join(source, 'console.log'), 'kernel: hung_task ' + secret);
  writeFileSync(join(source, 'console.log.0'), 'old');
  writeFileSync(join(source, 'init.log'), 'init /Users/someone/x');
  writeFileSync(join(source, 'other.log'), 'ignored');
  utimesSync(join(source, 'console.log.0'), 1, 1);
  const record = copyDockerVmLogs(source, destination, 10_000, redact);
  assert.deepEqual(record, { status: 'complete', files: ['console.log', 'init.log'], skippedOlder: 1, truncated: [] });
  assert.deepEqual(readdirSync(destination).sort(), ['console.log', 'init.log']);
  assert.equal(readFileSync(join(destination, 'console.log'), 'utf8'), 'kernel: hung_task [redacted]');
  assert.equal(readFileSync(join(destination, 'init.log'), 'utf8'), 'init ~/x');
  assert.equal(copyDockerVmLogs(join(root, 'absent'), destination, 0, redact).status, 'missing');
  assert.equal(copyDockerVmLogs(source, destination, Date.now() + 60_000, redact).status, 'missing');
  assert.equal(dockerVmLogDirectory('/Users/x'), '/Users/x/Library/Containers/com.docker.docker/Data/log/vm');
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
});
