import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Writable } from 'node:stream';
import { execute, type Command, type Executor } from './dms-formal-exec.ts';
import { redactHostText } from './dms-formal-host-records.ts';
import { dbLogStreamLimits, dockerTimestampMs, startDbLogStream, startVmLogStream, vmLogStreamLimits } from './dms-formal-log-stream.ts';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const temporary = (prefix: string) => mkdtempSync(join(tmpdir(), prefix));
const started = '2026-11-23T02:33:40.000000000Z';
const pg = (iso: string, message: string, pid = 42) => `${iso} ${iso.slice(0, 10)} ${iso.slice(11, 23)} UTC [${pid}] LOG:  ${message}`;
const fast = { ...dbLogStreamLimits, markerWaitMs: 300, fastMarkerWaitMs: 100, capCheckMs: 10 };

// A stub docker: `docker logs --follow` writes `lines` to the follower's log, then delivers the end marker once the
// marker exec ran (unless `markerLost`), and runs until aborted (or exits at once with `exitEarly`).
function stubDocker({ lines, markerLost = false, exitEarly = false, startedAt = started, grow = 0 }:
  { lines: string[]; markerLost?: boolean; exitEarly?: boolean; startedAt?: string; grow?: number }) {
  const calls: string[] = [];
  let follower: Command | undefined;
  const exec: Executor = async command => {
    const text = command.args.join(' ');
    calls.push(text.includes('--follow') ? 'follow' : text.includes('RAISE LOG') ? 'marker' : command.args[0] === 'container' ? 'inspect' : text);
    if (text.includes('docker logs --follow')) {
      follower = command;
      writeFileSync(command.log!, lines.map(line => line + '\n').join(''));
      if (exitEarly) return { code: 1, stdout: '' };
      const filler = grow ? setInterval(() => appendFileSync(command.log!, 'x'.repeat(grow) + '\n'), 5) : undefined;
      await new Promise(resolve => command.signal!.addEventListener('abort', resolve, { once: true }));
      clearInterval(filler);
      return { code: 137, stdout: '' };
    }
    if (command.args[0] === 'container') return { code: 0, stdout: startedAt };
    if (text.includes('RAISE LOG')) {
      // PostgreSQL logs the marker and the statement that raised it.
      const marker = /fukulow-log-end-[0-9a-f]+/.exec(text)![0];
      if (!markerLost && follower) appendFileSync(follower.log!, [pg('2026-11-23T03:18:00.000000000Z', marker, 77), `2026-11-23T03:18:00.000000000Z 2026-11-23 03:18:00.000 UTC [77] STATEMENT:  DO $$BEGIN RAISE LOG '%', '${marker}'; END$$`].join('\n') + '\n');
      return { code: 0, stdout: '' };
    }
    return { code: 1, stdout: '' };
  };
  return { exec, calls };
}

const seedLines = [
  '2026-11-23T02:33:40.100000000Z The files belonging to this database system will be owned by user "postgres".',
  pg('2026-11-23T02:34:08.000000000Z', 'duration: 916.143 ms'),
  pg('2026-11-23T02:34:08.100000000Z', 'temporary file: path "base/pgsql_tmp/pgsql_tmp42.0", size 24576'),
  '2026-11-23T02:34:08.100000000Z 2026-11-23 02:34:08.100 UTC [42] STATEMENT:  INSERT INTO account_sessions VALUES (secret-token)',
  pg('2026-11-23T02:34:09.000000000Z', 'checkpoint starting: wal'),
];

test('Docker --timestamps prefixes parse to milliseconds; other text does not', () => {
  assert.equal(dockerTimestampMs('2026-11-23T02:36:00.243765718Z x'), Date.parse('2026-11-23T02:36:00.243Z'));
  assert.equal(dockerTimestampMs('2026-11-23T02:36:00Z x'), Date.parse('2026-11-23T02:36:00Z'));
  assert.equal(dockerTimestampMs('no timestamp'), null);
});

test('DB log stream: normal collection keeps the whole log from the container start, redacted, without the marker', async () => {
  const dir = temporary('db-stream-'), { exec, calls } = stubDocker({ lines: seedLines });
  const stop = startDbLogStream(exec, 'db-1', join(dir, 'db.log'), join(dir, 'raw'), { limits: fast });
  await sleep(20);
  const record = await stop();
  assert.deepEqual([record.status, record.failures, record.marker, record.follower, record.rawRemoved], ['complete', [], 'seen', 'stopped', true]);
  assert.deepEqual(calls, ['inspect', 'follow', 'marker'], 'one inspect, one long-lived follower and one marker exec');
  assert.equal(record.dockerExecs, 3);
  assert.equal(record.firstEntryMs, Date.parse('2026-11-23T02:33:40.100Z'));
  assert.equal(record.lines, seedLines.length + 2);
  const saved = readFileSync(join(dir, 'db.log'), 'utf8');
  assert.deepEqual(saved.trim().split('\n'), [seedLines[1], seedLines[2], seedLines[4]]);
  assert.ok(!saved.includes('secret-token') && !saved.includes('fukulow-log-end'));
  assert.ok(!existsSync(join(dir, 'db.log.partial')));
  assert.deepEqual(readdirSync(join(dir, 'raw')), [], 'the raw stream and its retention record are removed');
});

test('DB log stream: a head lost to rotation before the follower started is detected (B7 pair 1)', async () => {
  // As in B7 pair 1: the retained log starts minutes after the container start.
  const dir = temporary('db-stream-head-'), { exec } = stubDocker({ lines: seedLines.slice(1).map(line => line.replaceAll('02:34:0', '02:36:0')) });
  const stop = startDbLogStream(exec, 'db-1', join(dir, 'db.log'), join(dir, 'raw'), { limits: fast });
  await sleep(20);
  const record = await stop();
  assert.equal(record.status, 'partial');
  assert.deepEqual(record.failures, ['db.log: head of the log missing (first entry not at the container start)']);
  assert.ok(!existsSync(join(dir, 'db.log')), 'an incomplete log is never saved under the complete name');
  assert.match(readFileSync(join(dir, 'db.log.partial'), 'utf8'), /duration: 916\.143 ms/);
});

test('DB log stream: a missing tail (marker not delivered) and a follower that exits early are gaps', async () => {
  const dir = temporary('db-stream-tail-');
  const lost = await (async () => { const stop = startDbLogStream(stubDocker({ lines: seedLines, markerLost: true }).exec, 'db-1', join(dir, 'a.log'), join(dir, 'raw-a'), { limits: fast }); await sleep(20); return stop(); })();
  assert.deepEqual([lost.status, lost.marker, lost.failures], ['partial', 'not-seen', ['db.log: end marker not-seen; the tail of the log may be missing']]);
  const { exec, calls } = stubDocker({ lines: seedLines, exitEarly: true });
  const stop = startDbLogStream(exec, 'db-1', join(dir, 'b.log'), join(dir, 'raw-b'), { limits: fast });
  await sleep(20);
  const early = await stop();
  assert.deepEqual([early.status, early.follower, early.marker], ['partial', 'exited-early', 'skipped']);
  assert.ok(early.failures.includes('db.log: log follower exited before the stop'));
  assert.ok(!calls.includes('marker'), 'no marker is written without a follower to receive it');
  assert.deepEqual([...readdirSync(join(dir, 'raw-a')), ...readdirSync(join(dir, 'raw-b'))], []);
});

test('DB log stream: the raw storage cap stops the follower and is a collection failure', async () => {
  const dir = temporary('db-stream-cap-'), { exec } = stubDocker({ lines: seedLines, grow: 4096 });
  const stop = startDbLogStream(exec, 'db-1', join(dir, 'db.log'), join(dir, 'raw'), { limits: { ...fast, rawCapBytes: 64 * 1024 } });
  await sleep(300);
  const record = await stop();
  assert.equal(record.follower, 'cap-exceeded');
  assert.equal(record.status, 'partial');
  assert.match(record.failures[0]!, /raw stream exceeded 65536 bytes/);
  assert.deepEqual(readdirSync(join(dir, 'raw')), []);
});

test('DB log stream: abnormal exit with no time left stops the follower, skips the marker and removes the raw stream', async () => {
  const dir = temporary('db-stream-late-'), { exec, calls } = stubDocker({ lines: Array.from({ length: 12_000 }, (_, i) => pg(`2026-11-23T02:33:4${i % 10}.000000000Z`, 'duration: 1.000 ms')) });
  const stop = startDbLogStream(exec, 'db-1', join(dir, 'db.log'), join(dir, 'raw'), { limits: fast });
  await sleep(20);
  const record = await stop({ hurry: AbortSignal.abort(), untilMs: () => Date.now() - 1 });
  assert.deepEqual([record.marker, record.status, record.rawRemoved], ['skipped', 'partial', true]);
  assert.ok(!calls.includes('marker'));
  assert.ok(record.failures.includes('db.log: redaction cut short: no time left before cleanup'));
  assert.ok(record.keptLines < 12_000);
  assert.ok(existsSync(join(dir, 'db.log.partial')) && !existsSync(join(dir, 'db.log')));
});

test('DB log stream: with the real executor the follower process group is gone after stop (no orphaned follower)', async t => {
  const dir = temporary('db-stream-real-'), bin = join(dir, 'bin'), feed = join(dir, 'feed'), token = `fake-follower-${process.pid}-${Date.now()}`;
  mkdirSync(bin);
  writeFileSync(feed, seedLines.map(line => line + '\n').join(''));
  // `logs` replays the feed and follows it; `exec` appends the marker to the feed, as PostgreSQL's stderr would.
  writeFileSync(join(bin, 'docker'), `#!/bin/sh
case "$1" in
  logs) exec tail -n +1 -f "${feed}" ${token};;
  container) echo ${started};;
  exec) for arg; do last=$arg; done; printf '%s LOG:  %s\\n' 2026-11-23T03:18:00.000000000Z "$(printf '%s' "$last" | grep -o 'fukulow-log-end-[0-9a-f]*')" >> "${feed}";;
esac
`);
  chmodSync(join(bin, 'docker'), 0o755);
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path}`;
  t.after(() => { process.env.PATH = path; });
  const stop = startDbLogStream(execute, 'db-1', join(dir, 'db.log'), join(dir, 'raw'), { limits: { ...fast, markerWaitMs: 3_000 } });
  await sleep(300);
  assert.equal(spawnSync('pgrep', ['-f', token]).status, 0, 'the follower runs during the seed');
  const record = await stop();
  assert.deepEqual([record.status, record.marker, record.failures], ['complete', 'seen', []]);
  assert.notEqual(spawnSync('pgrep', ['-f', token]).status, 0, 'no follower survives the stop');
  assert.deepEqual(readFileSync(join(dir, 'db.log'), 'utf8').trim().split('\n'), [seedLines[1], seedLines[2], seedLines[4]]);
});

test('DB log stream: an output write error (ENOSPC) fails the record without crashing, after the follower settled, and removes the raw stream', async () => {
  const dir = temporary('db-stream-enospc-'), { exec } = stubDocker({ lines: seedLines });
  let writes = 0;
  const openOutput = () => new Writable({ highWaterMark: 1, write(_chunk, _encoding, done) {
    writes++;
    done(writes > 1 ? Object.assign(new Error('no space left on device'), { code: 'ENOSPC' }) : null);
  } });
  const stop = startDbLogStream(exec, 'db-1', join(dir, 'db.log'), join(dir, 'raw'), { limits: fast, openOutput });
  await sleep(20);
  const record = await stop();
  assert.deepEqual([record.status, record.failures, record.rawRemoved], ['failed', ['db.log: stream collection failed'], true]);
  assert.ok(writes >= 2, 'the error came from a write after the first');
  assert.deepEqual(readdirSync(join(dir, 'raw')), [], 'no unredacted output stays in the scratch');
  assert.ok(!existsSync(join(dir, 'db.log')));
});

test('DB log stream: the marker scan starts at the marker command, reads in bounded chunks and finds a marker across a chunk edge', async () => {
  // About 1 MiB of log before the stop: none of it is scanned for the marker.
  const before = Array.from({ length: 4_000 }, (_, i) => pg('2026-11-23T02:34:08.000000000Z', `duration: ${i}.000 ms ${'y'.repeat(200)}`));
  const dir = temporary('db-stream-scan-');
  const { exec } = stubDocker({ lines: [...seedLines, ...before] });
  // The filler puts the marker across the first 64 KiB chunk boundary of what arrives after the scan start.
  const wrapped: Executor = async command => {
    if (command.args.join(' ').includes('RAISE LOG')) appendFileSync(join(dir, 'raw', 'db-log-follow.raw'), 'z'.repeat(64 * 1024 - 60) + '\n');
    return exec(command);
  };
  const stop = startDbLogStream(wrapped, 'db-1', join(dir, 'db.log'), join(dir, 'raw'), { limits: fast });
  await sleep(20);
  const record = await stop();
  assert.deepEqual([record.status, record.marker], ['complete', 'seen'], JSON.stringify(record.failures));
  const raw = record.rawBytes;
  // Observed I/O: the redaction reads the raw stream once; the marker scan read only what followed the marker command.
  assert.ok(record.bytesRead >= raw && record.bytesRead < raw + 128 * 1024, `${record.bytesRead} read for ${raw} raw bytes`);
  assert.equal(record.bytesWritten, readFileSync(join(dir, 'db.log')).length);
});

const secret = 'f'.repeat(64);
const redact = (text: string) => redactHostText(text, { secrets: [secret], home: '/Users/someone', user: 'someone', host: 'Someones-MacBook-Pro.local' });
const vmLimits = { ...vmLogStreamLimits, intervalMs: 5 };
const entry = (n: number) => `2026-11-23T02:${String(30 + Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}.000Z [api] GET /v1.56/exec/${n}\n`;
// Docker Desktop rotates init.log by renaming it with the rotation time, then starts a new init.log.
const rotate = (dir: string, set: string, stamp: string) => { renameSync(join(dir, `${set}.log`), join(dir, `${set}.log.${stamp}`)); writeFileSync(join(dir, `${set}.log`), ''); };

test('VM log stream: normal collection follows every rotation with Docker Desktop names, in order, redacted', async () => {
  const dir = temporary('vm-stream-'), source = join(dir, 'vm'), out = join(dir, 'out');
  mkdirSync(source);
  writeFileSync(join(source, 'init.log'), entry(0) + entry(1));
  writeFileSync(join(source, 'console.log'), '2026-11-23T02:00:00.000Z kernel: ok ' + secret + '\n');
  const stop = startVmLogStream(source, out, redact, { limits: vmLimits });
  let n = 2;
  for (const stamp of ['20261123-114400.830', '20261123-114710.876', '20261123-115115.305']) {
    appendFileSync(join(source, 'init.log'), entry(n++) + entry(n++));
    await sleep(20);
    rotate(source, 'init', stamp);
    appendFileSync(join(source, 'init.log'), entry(n++));
    await sleep(20);
  }
  // Two rotations between polls: the file rotated in between is read whole, after the rest of the followed one.
  appendFileSync(join(source, 'init.log'), entry(n++));
  rotate(source, 'init', '20261123-115521.948');
  appendFileSync(join(source, 'init.log'), entry(n++));
  rotate(source, 'init', '20261123-115930.461');
  appendFileSync(join(source, 'init.log'), entry(n++));
  const record = stop();
  assert.equal(record.status, 'complete', JSON.stringify(record));
  assert.equal(readFileSync(join(out, 'init.log'), 'utf8'), Array.from({ length: n }, (_, i) => entry(i)).join(''), 'every entry once, in order');
  assert.deepEqual(record.sets.init!.files, ['init.log.20261123-114400.830', 'init.log.20261123-114710.876', 'init.log.20261123-115115.305',
    'init.log.20261123-115521.948', 'init.log.20261123-115930.461', 'init.log']);
  assert.equal(record.sets.init!.firstEntryMs, Date.parse('2026-11-23T02:30:00.000Z'));
  assert.equal(readFileSync(join(out, 'console.log'), 'utf8'), '2026-11-23T02:00:00.000Z kernel: ok [redacted]\n');
  assert.deepEqual(readdirSync(out).sort(), ['console.log', 'init.log'], 'no partial file after a clean stop');
});

test('VM log stream: a rotated file removed before it was read is a gap (retention shorter than the seed)', async () => {
  const dir = temporary('vm-stream-gap-'), source = join(dir, 'vm'), out = join(dir, 'out');
  mkdirSync(source);
  writeFileSync(join(source, 'init.log'), entry(0));
  const stop = startVmLogStream(source, out, redact, { limits: { ...vmLimits, intervalMs: 60_000 } });
  appendFileSync(join(source, 'init.log'), entry(1));
  rotate(source, 'init', '20261123-114400.830');
  rmSync(join(source, 'init.log.20261123-114400.830'));
  appendFileSync(join(source, 'init.log'), entry(2));
  const record = stop();
  assert.equal(record.status, 'partial');
  assert.match(record.reason!, /init: init\.log was removed before it was read to its end/);
  assert.ok(existsSync(join(out, 'init.log.partial')) && !existsSync(join(out, 'init.log')), 'the incomplete set stays marked partial');
});

test('VM log stream: a line split across reads of one file is written once, whole; a shrunk file and the cap are gaps', async () => {
  const dir = temporary('vm-stream-split-'), source = join(dir, 'vm'), out = join(dir, 'out');
  mkdirSync(source);
  writeFileSync(join(source, 'init.log'), entry(0) + '2026-11-23T02:30:01.000Z password=hun');
  const seen: string[] = [];
  const stop = startVmLogStream(source, out, text => { seen.push(text); return redact(text); }, { limits: { ...vmLimits, readBytesPerPoll: 7 } });
  await sleep(100);
  appendFileSync(join(source, 'init.log'), 'ter2 end\n');
  await sleep(100);
  const record = stop();
  assert.equal(record.status, 'complete');
  assert.equal(readFileSync(join(out, 'init.log'), 'utf8'), entry(0) + '2026-11-23T02:30:01.000Z password=[redacted] end\n');
  assert.ok(seen.every(text => text.endsWith('\n')), 'only whole lines reach the redaction, so a split credential is still redacted');
  const shrink = temporary('vm-stream-shrink-');
  mkdirSync(join(shrink, 'vm'));
  writeFileSync(join(shrink, 'vm', 'init.log'), entry(0) + entry(1));
  const stopShrink = startVmLogStream(join(shrink, 'vm'), join(shrink, 'out'), redact, { limits: { ...vmLimits, intervalMs: 60_000 } });
  writeFileSync(join(shrink, 'vm', 'init.log'), entry(2));
  assert.match(stopShrink().reason!, /init\.log shrank/);
  const capped = temporary('vm-stream-cap-');
  mkdirSync(join(capped, 'vm'));
  writeFileSync(join(capped, 'vm', 'init.log'), entry(0).repeat(100));
  const cap = startVmLogStream(join(capped, 'vm'), join(capped, 'out'), redact, { limits: { ...vmLimits, capBytesPerSet: 1_000 } })();
  assert.deepEqual([cap.status, /storage cap/.test(cap.reason!)], ['partial', true]);
});

test('VM log stream: a stop with no time left skips the final read and keeps the files marked partial', () => {
  const dir = temporary('vm-stream-late-'), source = join(dir, 'vm'), out = join(dir, 'out');
  mkdirSync(source);
  writeFileSync(join(source, 'init.log'), entry(0));
  const record = startVmLogStream(source, out, redact, { limits: { ...vmLimits, intervalMs: 60_000 } })({ untilMs: () => Date.now() });
  assert.equal(record.status, 'failed');
  assert.match(record.reason!, /no time left/);
  assert.deepEqual(readdirSync(out), ['init.log.partial'], 'a set without files leaves nothing; the read set stays partial');
  assert.equal(startVmLogStream(join(dir, 'absent'), join(dir, 'out2'), redact, { limits: vmLimits })().status, 'failed');
});

test('VM log stream: a line split by a rotation is joined across the two files and redacted once, whole', async () => {
  const dir = temporary('vm-stream-rotate-split-'), source = join(dir, 'vm'), out = join(dir, 'out');
  mkdirSync(source);
  writeFileSync(join(source, 'init.log'), entry(0));
  const seen: string[] = [];
  const stop = startVmLogStream(source, out, text => { seen.push(text); return redact(text); }, { limits: { ...vmLimits, intervalMs: 60_000 } });
  // Docker Desktop rotates in the middle of a line: the old file ends with its first half, the new one starts with the rest.
  appendFileSync(join(source, 'init.log'), '2026-11-23T02:30:01.000Z password=hun');
  rotate(source, 'init', '20261123-114400.830');
  appendFileSync(join(source, 'init.log'), 'ter2 end\n' + entry(2));
  const record = stop();
  assert.equal(record.status, 'complete', JSON.stringify(record));
  assert.equal(readFileSync(join(out, 'init.log'), 'utf8'), entry(0) + '2026-11-23T02:30:01.000Z password=[redacted] end\n' + entry(2));
  assert.ok(seen.every(text => text.endsWith('\n')) && !seen.some(text => /password=hun(?!ter2)|^ter2/m.test(text)), 'the two pieces are never redacted apart');
});

test('VM log stream: after a gap at a rotation the fragment up to the next newline is dropped, never written as a line', () => {
  const dir = temporary('vm-stream-gap-split-'), source = join(dir, 'vm'), out = join(dir, 'out');
  mkdirSync(source);
  writeFileSync(join(source, 'init.log'), entry(0) + '2026-11-23T02:30:01.000Z password=hun');
  const stop = startVmLogStream(source, out, redact, { limits: { ...vmLimits, intervalMs: 60_000 } });
  // The followed file ends mid-line, rotates and is removed before the collector reads it again.
  appendFileSync(join(source, 'init.log'), 'te');
  rotate(source, 'init', '20261123-114400.830');
  rmSync(join(source, 'init.log.20261123-114400.830'));
  appendFileSync(join(source, 'init.log'), 'r2 end\n' + entry(2));
  const record = stop();
  assert.equal(record.status, 'partial');
  const saved = readFileSync(join(out, 'init.log.partial'), 'utf8');
  assert.equal(saved, entry(0) + entry(2));
  assert.ok(!saved.includes('r2 end') && !saved.includes('hun'));
});

test('VM log stream: a replaced file with a reused name is read from its own start, not at the old offset', () => {
  const dir = temporary('vm-stream-replaced-'), source = join(dir, 'vm'), out = join(dir, 'out');
  mkdirSync(source);
  writeFileSync(join(source, 'init.log'), entry(0) + entry(1));
  const stop = startVmLogStream(source, out, redact, { limits: { ...vmLimits, intervalMs: 60_000 } });
  // The followed file is removed and a new init.log written (which may reuse the freed inode on Linux).
  rmSync(join(source, 'init.log'));
  writeFileSync(join(source, 'init.log'), entry(2) + entry(3) + entry(4));
  const record = stop();
  assert.equal(record.status, 'partial');
  assert.match(record.reason!, /init\.log was removed before it was read to its end/);
  assert.equal(readFileSync(join(out, 'init.log.partial'), 'utf8'), entry(0) + entry(1) + entry(3) + entry(4),
    'the new file is read from its start (its first line dropped after the gap), never from the old offset');
});

test('VM log stream: a read cut short by a truncation writes no zero-filled bytes and is a gap', () => {
  const dir = temporary('vm-stream-short-'), source = join(dir, 'vm'), out = join(dir, 'out');
  mkdirSync(source);
  writeFileSync(join(source, 'init.log'), entry(0));
  let truncated = false;
  const stop = startVmLogStream(source, out, text => {
    // The writer truncates the file between two reads of the final drain.
    if (!truncated && text.includes('exec/1')) { truncated = true; writeFileSync(join(source, 'init.log'), entry(9)); }
    return redact(text);
  }, { limits: { ...vmLimits, intervalMs: 60_000, readBytesPerPoll: entry(0).length } });
  appendFileSync(join(source, 'init.log'), entry(1) + entry(2) + entry(3));
  const record = stop();
  const saved = readFileSync(join(out, 'init.log.partial'), 'utf8');
  assert.ok(!saved.includes('\0'), 'no zero fill');
  assert.equal(record.status, 'partial');
  assert.match(record.reason!, /init\.log shrank/);
});

test('VM log stream: a set whose final rename fails makes the whole record failed', () => {
  const dir = temporary('vm-stream-rename-'), source = join(dir, 'vm'), out = join(dir, 'out');
  mkdirSync(source);
  writeFileSync(join(source, 'init.log'), entry(0));
  writeFileSync(join(source, 'console.log'), entry(1));
  const stop = startVmLogStream(source, out, redact, { limits: { ...vmLimits, intervalMs: 60_000 } });
  // A directory in the way of the complete name makes the rename fail.
  mkdirSync(join(out, 'init.log'));
  writeFileSync(join(out, 'init.log', 'x'), '');
  const record = stop();
  assert.deepEqual([record.status, record.sets.init!.status, record.sets.console!.status], ['failed', 'failed', 'complete']);
  assert.match(record.reason!, /init: .*init\.log\.partial could not be renamed/);
  assert.ok(existsSync(join(out, 'init.log.partial')));
});

test('VM log stream: observed I/O counts the first read, the rotation catch-up and the writes', async () => {
  const dir = temporary('vm-stream-io-'), source = join(dir, 'vm'), out = join(dir, 'out');
  mkdirSync(source);
  writeFileSync(join(source, 'init.log.20261123-110000.000'), entry(99));
  writeFileSync(join(source, 'init.log'), entry(0));
  const stop = startVmLogStream(source, out, redact, { limits: { ...vmLimits, intervalMs: 60_000 } });
  appendFileSync(join(source, 'init.log'), entry(1));
  rotate(source, 'init', '20261123-114400.830');
  appendFileSync(join(source, 'init.log'), entry(2));
  const record = stop(), init = record.sets.init!;
  assert.equal(record.status, 'complete');
  assert.deepEqual([init.firstPollBytesRead, init.rotatedBytesRead, init.bytesRead], [entry(0).length, entry(1).length, entry(0).length * 3],
    'the rotated file present before the run is not read');
  assert.equal(init.bytesWritten, readFileSync(join(out, 'init.log')).length);
  assert.deepEqual([record.bytesRead, record.bytesWritten], [init.bytesRead, init.bytesWritten]);
});
