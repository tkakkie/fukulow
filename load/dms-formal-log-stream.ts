// Continuous seed diagnostic log collection (#426, B7 pair 1). Both logs rotate during a full-size seed: the DB
// container log under the Docker `local` log driver (5 files of 20 MB), the Docker Desktop VM init.log at 1 MiB with
// 9 rotated files kept (about 36 minutes of a 45-minute seed). So they are collected while the seed runs, not copied
// once at the end, and each record says whether it is continuous from the run start to its stop.
import { randomBytes } from 'node:crypto';
import { closeSync, createReadStream, createWriteStream, existsSync, fstatSync, mkdirSync, openSync, readdirSync, readSync, renameSync, rmSync, statSync, writeFileSync, appendFileSync, type Stats } from 'node:fs';
import { Readable, type Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { type Executor } from './dms-formal-exec.ts';
import { dbLogLineRedactor } from './dms-formal-seed-diagnostic.ts';
import { firstTimestampMs } from './dms-formal-host-records.ts';

export type LogStopOptions = { hurry?: AbortSignal; untilMs?: () => number };
export const dbLogStreamLimits = {
  // The raw stream stays in the private run scratch until stop() redacts it; past this size the follower is stopped.
  rawCapBytes: 2 * 1024 * 1024 * 1024, capCheckMs: 5_000,
  // PostgreSQL's entrypoint prints its first line as the container starts; a later first entry means a lost head.
  headSlackMs: 30_000,
  markerWaitMs: 5_000, fastMarkerWaitMs: 2_000, markerCommandMs: 5_000, minStepMs: 500,
};
// The DB log output: bytesWritten counts what the file system accepted, as fs.WriteStream does.
export type Output = Writable & { readonly bytesWritten: number };
export type DbLogStreamRecord = {
  status: 'complete' | 'partial' | 'failed'; failures: string[]; rawBytes: number; lines: number; keptLines: number;
  firstEntryMs: number | null; containerStartedMs: number | null; marker: 'seen' | 'not-seen' | 'skipped' | 'write-failed';
  follower: 'stopped' | 'exited-early' | 'cap-exceeded'; rawRemoved: boolean; dockerExecs: number;
  // Observed host I/O of the collection: the follower's raw writes are rawBytes; these are the runner's own.
  bytesRead: number; bytesWritten: number;
};

// Docker's --timestamps prefix (RFC 3339 with nanoseconds), as epoch milliseconds.
export function dockerTimestampMs(line: string) {
  const match = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d+))?(Z|[+-]\d\d:\d\d)\s/.exec(line);
  if (!match) return null;
  const ms = Date.parse(`${match[1]}.${(match[2] ?? '').padEnd(3, '0').slice(0, 3)}${match[3]}`);
  return Number.isFinite(ms) ? ms : null;
}

// Follows the DB container log from its first entry (`docker logs --follow` replays the retained log, then streams;
// started at the seed start, before the first rotation). stop() logs a unique end marker in PostgreSQL,
// waits until the stream has delivered it (the tail is complete), stops the follower, and redacts the raw stream line
// by line into `destination`. The marker is a RAISE LOG from a psql session (Docker Desktop refuses writes to
// /proc/1/fd/2 from docker exec, also as the postgres user), and both lines that carry it are dropped. Head, tail,
// follower and cap are each checked; a failed check is a collection failure, and the output then stays at
// `destination.partial`. The raw stream is removed whatever happened, after the follower has settled. If the runner
// dies, the follower's process group ends with the container at cleanup (`docker logs --follow` exits when it is removed).
export function startDbLogStream(exec: Executor, container: string, destination: string, rawDirectory: string,
  { limits = dbLogStreamLimits, now = Date.now, openOutput = (path: string): Output => createWriteStream(path, { mode: 0o600 }) }:
  { limits?: typeof dbLogStreamLimits; now?: () => number; openOutput?: (path: string) => Output } = {}) {
  mkdirSync(rawDirectory, { recursive: true, mode: 0o700 });
  const raw = join(rawDirectory, 'db-log-follow.raw'), marker = `fukulow-log-end-${randomBytes(12).toString('hex')}`;
  let dockerExecs = 2, exited = false, capExceeded = false, bytesRead = 0;
  const abort = new AbortController();
  const started = exec({ program: 'docker', args: ['container', 'inspect', '--format', '{{.State.StartedAt}}', container], timeout: 10_000 })
    .then(result => result.code === 0 ? dockerTimestampMs(result.stdout.trim() + ' ') : null, () => null);
  const follower = exec({ program: 'sh', args: ['-c', 'exec docker logs --follow --timestamps "$1" 2>&1', 'db-log-follow', container],
    log: raw, timeout: 24 * 60 * 60 * 1000, signal: abort.signal }).then(() => undefined, () => undefined).finally(() => { exited = true; });
  const size = () => { try { return statSync(raw).size; } catch { return 0; } };
  const cap = setInterval(() => { if (size() > limits.rawCapBytes) { capExceeded = true; abort.abort(); } }, limits.capCheckMs);
  cap.unref();
  // Scans the raw stream forward from `scanned` in bounded chunks (each overlapping the last by the marker length).
  const needle = Buffer.from(marker), chunk = Buffer.allocUnsafe(64 * 1024 + needle.length);
  let scanned = 0;
  const hasMarker = () => {
    let fd: number;
    try { fd = openSync(raw, 'r'); } catch { return false; }
    try {
      const end = fstatSync(fd).size;
      for (let position = Math.max(0, scanned - needle.length + 1); position < end;) {
        const read = readSync(fd, chunk, 0, Math.min(chunk.length, end - position), position);
        if (read === 0) break;
        bytesRead += read;
        if (chunk.subarray(0, read).indexOf(needle) >= 0) return true;
        scanned = position + read;
        position = Math.max(position + 1, scanned - needle.length + 1);
        if (scanned >= end) break;
      }
      return false;
    } finally { closeSync(fd); }
  };
  return async ({ hurry, untilMs }: LogStopOptions = {}): Promise<DbLogStreamRecord> => {
    clearInterval(cap);
    const left = () => (untilMs?.() ?? Infinity) - now();
    const record: DbLogStreamRecord = { status: 'failed', failures: [], rawBytes: 0, lines: 0, keptLines: 0, firstEntryMs: null, containerStartedMs: null,
      marker: 'skipped', follower: capExceeded ? 'cap-exceeded' : exited ? 'exited-early' : 'stopped', rawRemoved: false, dockerExecs, bytesRead: 0, bytesWritten: 0 };
    const partial = destination + '.partial';
    try {
      if (record.follower === 'stopped' && left() >= limits.minStepMs) {
        record.dockerExecs = ++dockerExecs;
        // The marker is logged after this point, so only what arrives from here on is scanned.
        scanned = size();
        const wrote = await exec({ program: 'docker', args: ['exec', container, 'psql', '-X', '-U', 'fukulow', '-d', 'fukulow', '-At', '-v', 'ON_ERROR_STOP=1',
          '-c', `DO $$BEGIN RAISE LOG '%', '${marker}'; END$$`],
          timeout: Math.min(limits.markerCommandMs, left()) }).then(result => result.code === 0, () => false);
        record.marker = wrote ? 'not-seen' : 'write-failed';
        const until = now() + Math.min(hurry?.aborted ? limits.fastMarkerWaitMs : limits.markerWaitMs, left());
        while (wrote && now() < until && !exited) {
          if (hasMarker()) { record.marker = 'seen'; break; }
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        if (wrote && record.marker !== 'seen' && hasMarker()) record.marker = 'seen';
      }
      abort.abort();
      await follower;
      record.containerStartedMs = await started;
      record.rawBytes = size();
      if (record.rawBytes > limits.rawCapBytes) record.follower = 'cap-exceeded';
      let cut = false;
      const input = existsSync(raw) ? createReadStream(raw) : undefined;
      const redact = dbLogLineRedactor();
      async function* redacted() {
        if (!input) return;
        const lines = createInterface({ input, crlfDelay: Infinity });
        try {
          for await (const line of lines) {
            // Counted per line here: a 'data' listener attached before readline would start the stream early.
            record.bytesRead += Buffer.byteLength(line) + 1;
            // At least the first line is kept, so the head check still has an entry to check.
            if (record.lines > 0 && left() <= 0) { cut = true; break; }
            if (!line) continue;
            record.lines++;
            record.firstEntryMs ??= dockerTimestampMs(line);
            if (line.includes(marker)) continue;
            const kept = redact(line);
            if (kept !== null) { record.keptLines++; yield kept + '\n'; }
          }
        } finally { lines.close(); input.destroy(); }
      }
      // pipeline() carries backpressure and any write error (ENOSPC) into this try, so the finally below still runs. The
      // deadline is checked per line and, for a write that does not return, by a timer that aborts the pipeline.
      const output = openOutput(partial), cutter = new AbortController();
      const watch = setInterval(() => { if (left() <= 0) { cut = true; cutter.abort(); } }, 100);
      try { await pipeline(Readable.from(redacted()), output, { signal: cutter.signal }); }
      catch (error) { if (!cut) throw error; output.destroy(); }
      finally { clearInterval(watch); record.bytesWritten = output.bytesWritten; }
      if (left() <= 0) cut = true;
      const failures = record.failures;
      if (record.follower === 'exited-early') failures.push('db.log: log follower exited before the stop');
      if (record.follower === 'cap-exceeded') failures.push(`db.log: raw stream exceeded ${limits.rawCapBytes} bytes; follower stopped`);
      if (record.marker !== 'seen') failures.push(`db.log: end marker ${record.marker}; the tail of the log may be missing`);
      if (record.containerStartedMs === null) failures.push('db.log: container start time unavailable; the head cannot be checked');
      else if (record.firstEntryMs === null || record.firstEntryMs - record.containerStartedMs > limits.headSlackMs)
        failures.push('db.log: head of the log missing (first entry not at the container start)');
      if (cut) failures.push('db.log: redaction cut short: no time left before cleanup');
      if (!failures.length) renameSync(partial, destination);
      record.status = failures.length ? 'partial' : 'complete';
    } catch {
      record.failures.push('db.log: stream collection failed');
      record.status = 'failed';
    } finally {
      abort.abort();
      await follower;
      record.bytesRead += bytesRead;
      try { for (const file of [raw, raw + '-retention.json']) rmSync(file, { force: true }); record.rawRemoved = true; }
      catch { record.failures.push('db.log: raw stream not removed from the private scratch'); record.status = 'failed'; }
    }
    return record;
  };
}

export const vmLogStreamLimits = { intervalMs: 5_000, capBytesPerSet: 64 * 1024 * 1024, readBytesPerPoll: 8 * 1024 * 1024, lineLimit: 1024 * 1024 };
// Observed host I/O per set: every byte read (the first poll's read of the live file and the rotation catch-up
// included) and every byte written.
export type VmLogSetRecord = { status: 'complete' | 'partial' | 'failed' | 'missing'; files: string[]; firstEntryMs: number | null; gaps: string[];
  bytesRead: number; firstPollBytesRead: number; rotatedBytesRead: number; bytesWritten: number };
export type VmLogStreamRecord = { status: 'complete' | 'partial' | 'failed' | 'missing'; sets: Record<string, VmLogSetRecord>; polls: number;
  bytesRead: number; bytesWritten: number; reason?: string };
type Tracked = { name: string; id: string; offset: number };
type Listed = { name: string; id: string; mtimeMs: number };
// Rotation order: Docker Desktop names a rotated file by its rotation time (`init.log.20261123-114710.876`), which
// sorts as text; a numbered suffix counts up with age; anything else falls back to mtime.
const rotationOrder = (live: string) => (a: Listed, b: Listed) => {
  const suffix = (file: Listed) => file.name.slice(live.length + 1), stamp = /^\d{8}-\d{6}\.\d{3}$/, number = /^\d+$/;
  const [x, y] = [suffix(a), suffix(b)];
  if (stamp.test(x) && stamp.test(y)) return x < y ? -1 : x > y ? 1 : 0;
  if (number.test(x) && number.test(y)) return Number(y) - Number(x);
  return a.mtimeMs - b.mtimeMs || a.name.localeCompare(b.name);
};
type SetState = { set: string; current: Tracked | null; seen: Set<string>; carry: Buffer; skip: boolean; record: VmLogSetRecord; out: string; full: boolean };
class NoTimeLeft extends Error {}
// A file is the same file only if its device, inode and birth time all match: an inode freed by a removal can be reused.
const identity = (stat: Stats) => `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';

// Tails the Docker Desktop VM logs (console.log, init.log) during the seed. Each set's live file is followed by
// identity and offset, and every read goes through a descriptor whose identity was checked after it was opened. When
// the live file rotates (renamed to `<set>.log.<YYYYMMDD-HHMMSS.mmm>`, or a numbered suffix), the rest of the renamed
// file and every file rotated after it are read before the new live file, so every byte is read once, in order.
// Rotated files present before the run are skipped, and so is the live file's first partial line when one exists. Bytes are cut into lines only at newlines, across reads and
// rotations alike, and only whole lines are redacted and written, to `<destination>/<set>.log.partial`, renamed on a
// clean stop. A rotated file removed before it was read, a file that shrank, an over-long line, an unfinished last
// line, the storage cap or a read error is a gap: the set is partial (failed on a read error). After a gap the bytes
// up to the next newline are dropped, so a fragment is never written as a line. A set without any file is missing, as
// in the former copyDockerVmLogs; the record is missing only when every set is, and failed when any set failed.
export function startVmLogStream(source: string, destination: string, redact: (text: string) => string,
  { limits = vmLogStreamLimits, sets = ['console', 'init'] }: { limits?: typeof vmLogStreamLimits; sets?: string[] } = {}) {
  const states: SetState[] = sets.map(set => ({ set, current: null, seen: new Set(), carry: Buffer.alloc(0), skip: false, full: false,
    out: join(destination, `${set}.log.partial`),
    record: { status: 'complete', files: [], firstEntryMs: null, gaps: [], bytesRead: 0, firstPollBytesRead: 0, rotatedBytesRead: 0, bytesWritten: 0 } }));
  let polls = 0, failed: string | undefined, stopped = false;
  const gap = (state: SetState, reason: string) => { state.record.gaps.push(reason); state.carry = Buffer.alloc(0); state.skip = true; };
  const write = (state: SetState, text: string) => {
    if (!text || state.full) return;
    const redacted = redact(text), bytes = Buffer.byteLength(redacted);
    if (state.record.bytesWritten + bytes > limits.capBytesPerSet) { state.full = true; state.record.gaps.push(`storage cap of ${limits.capBytesPerSet} bytes reached`); return; }
    state.record.firstEntryMs ??= firstTimestampMs(redacted);
    appendFileSync(state.out, redacted);
    state.record.bytesWritten += bytes;
  };
  const feed = (state: SetState, chunk: Buffer) => {
    const data = state.carry.length ? Buffer.concat([state.carry, chunk]) : chunk, kept: Buffer[] = [];
    let start = 0;
    for (let newline = data.indexOf(10); newline >= 0; newline = data.indexOf(10, start)) {
      const line = data.subarray(start, newline + 1);
      start = newline + 1;
      if (state.skip) state.skip = false;
      else if (line.length > limits.lineLimit) state.record.gaps.push('line over the length limit dropped');
      else kept.push(line);
    }
    state.carry = state.skip ? Buffer.alloc(0) : Buffer.from(data.subarray(start));
    if (state.carry.length > limits.lineLimit) { state.record.gaps.push('line over the length limit dropped'); state.carry = Buffer.alloc(0); state.skip = true; }
    // Whole lines only, so a multibyte character is never cut.
    if (kept.length) write(state, Buffer.concat(kept).toString('utf8'));
  };
  // Reads from tracked.offset through a checked descriptor: one chunk, or to the end of the file with `toEnd`.
  const read = (state: SetState, tracked: Tracked, fd: number, { toEnd, deadline, rotated }: { toEnd: boolean; deadline: number; rotated: boolean }) => {
    const size = fstatSync(fd).size;
    if (size < tracked.offset) { gap(state, `${tracked.name} shrank`); tracked.offset = 0; }
    const buffer = Buffer.allocUnsafe(Math.max(1, Math.min(limits.readBytesPerPoll, toEnd ? limits.readBytesPerPoll : size - tracked.offset)));
    for (;;) {
      const read = readSync(fd, buffer, 0, buffer.length, tracked.offset);
      if (read === 0) { if (fstatSync(fd).size < tracked.offset) { gap(state, `${tracked.name} shrank`); tracked.offset = 0; } return; }
      state.record.bytesRead += read;
      if (polls === 1) state.record.firstPollBytesRead += read;
      if (rotated) state.record.rotatedBytesRead += read;
      tracked.offset += read;
      feed(state, buffer.subarray(0, read));
      if (!toEnd) return;
      if (Date.now() >= deadline) throw new NoTimeLeft();
    }
  };
  // Opens a file and returns its descriptor only if it is still the file that was listed (or followed).
  const open = (path: string, id?: string) => {
    let fd: number;
    try { fd = openSync(path, 'r'); } catch (error) { if (missing(error)) return null; throw error; }
    const opened = identity(fstatSync(fd));
    if (id !== undefined && opened !== id) { closeSync(fd); return null; }
    return { fd, id: opened };
  };
  const withFile = (path: string, id: string | undefined, use: (fd: number, id: string) => void) => {
    const file = open(path, id);
    if (!file) return false;
    try { use(file.fd, file.id); } finally { closeSync(file.fd); }
    return true;
  };
  const poll = (final: boolean, deadline: number) => {
    polls++;
    const entries = readdirSync(source);
    for (const state of states) {
      const liveName = `${state.set}.log`;
      const rotated: Listed[] = entries.filter(name => name.startsWith(`${liveName}.`)).flatMap(name => {
        try { const stat = statSync(join(source, name)); return stat.isFile() ? [{ name, id: identity(stat), mtimeMs: stat.mtimeMs }] : []; }
        catch (error) { if (missing(error)) return []; throw error; }
      }).sort(rotationOrder(liveName));
      if (polls === 1) for (const file of rotated) state.seen.add(file.id);
      const live = open(join(source, liveName));
      try {
        const current = state.current;
        if (current && live?.id === current.id) { read(state, current, live.fd, { toEnd: final, deadline, rotated: false }); continue; }
        if (current) {
          // The followed file was rotated: finish it under its new name, then every file rotated after it, oldest first.
          const renamed = rotated.find(file => file.id === current.id);
          if (renamed && withFile(join(source, renamed.name), current.id, fd => {
            current.name = renamed.name;
            state.record.files[state.record.files.length - 1] = renamed.name;
            read(state, current, fd, { toEnd: true, deadline, rotated: true });
          })) { /* read to its end */ } else gap(state, `${current.name} was removed before it was read to its end`);
        }
        for (const file of rotated.filter(file => !state.seen.has(file.id) && file.id !== current?.id)) {
          state.seen.add(file.id);
          if (!withFile(join(source, file.name), file.id, fd => {
            state.record.files.push(file.name);
            read(state, { name: file.name, id: file.id, offset: 0 }, fd, { toEnd: true, deadline, rotated: true });
          })) gap(state, `${file.name} was removed before it was read`);
        }
        // A rotated file from before the run means the live file may start mid-line: its bytes up to the first newline
        // belong to a line whose start is not collected, so they are dropped, never written as a line.
        if (!current && polls === 1 && rotated.length) state.skip = true;
        state.current = live ? { name: liveName, id: live.id, offset: 0 } : null;
        if (live) { state.seen.add(live.id); state.record.files.push(liveName); read(state, state.current!, live.fd, { toEnd: final, deadline, rotated: false }); }
      } finally { if (live) closeSync(live.fd); }
    }
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const tick = () => {
    try { poll(false, Infinity); } catch (error) { failed = missing(error) ? 'Docker VM log directory missing' : 'Docker VM log read failed'; return; }
    if (!stopped) { timer = setTimeout(tick, limits.intervalMs); timer.unref(); }
  };
  try { mkdirSync(destination, { recursive: true, mode: 0o700 }); for (const state of states) writeFileSync(state.out, '', { mode: 0o600 }); }
  catch { failed = 'Docker VM log destination not writable'; }
  if (!failed) tick();
  // A final poll reads every file to its end before the live deadline; with less than a second left it is skipped, and
  // a deadline reached during it fails the record. Either way the files stay partial.
  return ({ untilMs }: LogStopOptions = {}): VmLogStreamRecord => {
    stopped = true;
    clearTimeout(timer);
    const deadline = untilMs?.() ?? Infinity;
    if (!failed && deadline - Date.now() >= 1_000) {
      try {
        poll(true, deadline);
        for (const state of states) {
          if (state.carry.length) gap(state, `${state.current?.name ?? state.set}: unfinished last line at the stop`);
          // The live file must still be the one drained: a rotation during the final read leaves unread entries.
          const live = open(join(source, `${state.set}.log`));
          if (live) closeSync(live.fd);
          if (live?.id !== state.current?.id) gap(state, `${state.set}.log rotated during the final read`);
        }
      } catch (error) { failed = error instanceof NoTimeLeft ? 'Docker VM log final read cut short: no time left before cleanup' : 'Docker VM log read failed'; }
    } else if (!failed) failed = 'Docker VM log stream stopped without a final read: no time left before cleanup';
    const result: VmLogStreamRecord = { status: 'complete', sets: {}, polls, bytesRead: 0, bytesWritten: 0 };
    for (const state of states) {
      const record = state.record;
      if (!record.files.length) record.status = 'missing';
      else if (failed) record.status = 'failed';
      else if (record.gaps.length) record.status = 'partial';
      if (record.status === 'complete') try { renameSync(state.out, join(destination, `${state.set}.log`)); }
      catch { record.status = 'failed'; record.gaps.push(`${state.set}.log.partial could not be renamed`); }
      if (record.status === 'missing') rmSync(state.out, { force: true });
      result.sets[state.set] = { ...record, files: [...record.files], gaps: [...record.gaps] };
      result.bytesRead += record.bytesRead; result.bytesWritten += record.bytesWritten;
    }
    const statuses = Object.values(result.sets).map(set => set.status);
    result.status = failed || statuses.includes('failed') ? 'failed' : statuses.every(status => status === 'missing') ? 'missing'
      : statuses.includes('partial') ? 'partial' : 'complete';
    if (failed) result.reason = failed;
    else if (result.status !== 'complete') result.reason = Object.entries(result.sets).filter(([, set]) => set.status !== 'complete')
      .map(([name, set]) => `${name}: ${set.status === 'missing' ? 'no live file' : set.gaps.join('; ')}`).join('; ');
    return result;
  };
}
