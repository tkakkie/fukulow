// Continuous seed diagnostic log collection (#426, B7 pair 1). Both logs rotate during a full-size seed: the DB
// container log under the Docker `local` log driver (5 files of 20 MB), the Docker Desktop VM init.log at 1 MiB with
// 9 rotated files kept (about 36 minutes of a 45-minute seed). So they are collected while the seed runs, not copied
// once at the end, and each record says whether it is continuous from the run start to its stop.
import { randomBytes } from 'node:crypto';
import { closeSync, createReadStream, createWriteStream, mkdirSync, openSync, readdirSync, readSync, renameSync, rmSync, statSync, writeFileSync, appendFileSync } from 'node:fs';
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
export type DbLogStreamRecord = {
  status: 'complete' | 'partial' | 'failed'; failures: string[]; rawBytes: number; lines: number; keptLines: number;
  firstEntryMs: number | null; containerStartedMs: number | null; marker: 'seen' | 'not-seen' | 'skipped' | 'write-failed';
  follower: 'stopped' | 'exited-early' | 'cap-exceeded'; rawRemoved: boolean; dockerExecs: number;
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
// /proc/1/fd/2 from docker exec, also as the postgres user), and both lines that carry it are dropped. Head, tail, follower and cap are each checked; a failed check is a collection failure,
// and the output then stays at `destination.partial`. The raw stream is removed whatever happened. If the runner dies,
// the follower's process group ends with the container at cleanup (`docker logs --follow` exits when it is removed).
export function startDbLogStream(exec: Executor, container: string, destination: string, rawDirectory: string,
  { limits = dbLogStreamLimits, now = Date.now }: { limits?: typeof dbLogStreamLimits; now?: () => number } = {}) {
  mkdirSync(rawDirectory, { recursive: true, mode: 0o700 });
  const raw = join(rawDirectory, 'db-log-follow.raw'), marker = `fukulow-log-end-${randomBytes(12).toString('hex')}`;
  let dockerExecs = 2, exited = false, capExceeded = false;
  const abort = new AbortController();
  const started = exec({ program: 'docker', args: ['container', 'inspect', '--format', '{{.State.StartedAt}}', container], timeout: 10_000 })
    .then(result => result.code === 0 ? dockerTimestampMs(result.stdout.trim() + ' ') : null, () => null);
  const follower = exec({ program: 'sh', args: ['-c', 'exec docker logs --follow --timestamps "$1" 2>&1', 'db-log-follow', container],
    log: raw, timeout: 24 * 60 * 60 * 1000, signal: abort.signal }).then(() => undefined, () => undefined).finally(() => { exited = true; });
  const size = () => { try { return statSync(raw).size; } catch { return 0; } };
  const cap = setInterval(() => { if (size() > limits.rawCapBytes) { capExceeded = true; abort.abort(); } }, limits.capCheckMs);
  cap.unref();
  // Scans the raw stream forward from where the last scan ended (overlapping by the marker length).
  let scanned = 0;
  const hasMarker = () => {
    const end = size(), from = Math.max(0, scanned - marker.length);
    if (end <= from) return false;
    const buffer = Buffer.alloc(end - from), fd = openSync(raw, 'r');
    try { readSync(fd, buffer, 0, end - from, from); } finally { closeSync(fd); }
    scanned = end;
    return buffer.toString('utf8').includes(marker);
  };
  return async ({ hurry, untilMs }: LogStopOptions = {}): Promise<DbLogStreamRecord> => {
    clearInterval(cap);
    const left = () => (untilMs?.() ?? Infinity) - now();
    const record: DbLogStreamRecord = { status: 'failed', failures: [], rawBytes: 0, lines: 0, keptLines: 0, firstEntryMs: null, containerStartedMs: null,
      marker: 'skipped', follower: capExceeded ? 'cap-exceeded' : exited ? 'exited-early' : 'stopped', rawRemoved: false, dockerExecs };
    const partial = destination + '.partial';
    try {
      if (record.follower === 'stopped' && left() >= limits.minStepMs) {
        record.dockerExecs = ++dockerExecs;
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
      const out = createWriteStream(partial, { mode: 0o600 });
      const redact = dbLogLineRedactor();
      let cut = false;
      const lines = createInterface({ input: createReadStream(raw), crlfDelay: Infinity });
      try {
        for await (const line of lines) {
          if (!line) continue;
          record.lines++;
          record.firstEntryMs ??= dockerTimestampMs(line);
          if (line.includes(marker)) continue;
          const kept = redact(line);
          if (kept !== null) { record.keptLines++; if (!out.write(kept + '\n')) await new Promise(resolve => out.once('drain', resolve)); }
          if (record.lines % 5_000 === 0 && left() <= 0) { cut = true; break; }
        }
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      finally { lines.close(); await new Promise<void>((resolve, reject) => out.end((error?: Error | null) => error ? reject(error) : resolve())); }
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
      try { for (const file of [raw, raw + '-retention.json']) rmSync(file, { force: true }); record.rawRemoved = true; }
      catch { record.failures.push('db.log: raw stream not removed from the private scratch'); record.status = 'failed'; }
    }
    return record;
  };
}

export const vmLogStreamLimits = { intervalMs: 5_000, capBytesPerSet: 64 * 1024 * 1024, readBytesPerPoll: 8 * 1024 * 1024, lineLimit: 1024 * 1024 };
export type VmLogSetRecord = { status: 'complete' | 'partial' | 'failed' | 'missing'; files: string[]; bytes: number; firstEntryMs: number | null; gaps: string[] };
export type VmLogStreamRecord = { status: 'complete' | 'partial' | 'failed' | 'missing'; sets: Record<string, VmLogSetRecord>; polls: number; reason?: string };
type Tracked = { name: string; ino: number; offset: number; mtimeMs: number };
type SetState = { set: string; current: Tracked | null; seen: Set<number>; carry: string; record: VmLogSetRecord; out: string; full: boolean };

// Tails the Docker Desktop VM logs (console.log, init.log) during the seed. Each set's live file is followed by inode
// and offset; when it rotates (renamed to `<set>.log.<YYYYMMDD-HHMMSS.mmm>`, or a numbered suffix), the rest of the
// renamed file and any file rotated after it are read before the new live file, so every byte is read once, in order.
// Only complete lines are redacted and written (a line split by a read is held until its end), to
// `<destination>/<set>.log.partial`, renamed on a clean stop. A rotated file removed before it was read, a file that
// shrank, an over-long line, the storage cap or a read error is a gap: the set is partial (failed on a read error).
// A set without any file is missing, as in copyDockerVmLogs; the record is missing only when every set is.
export function startVmLogStream(source: string, destination: string, redact: (text: string) => string,
  { limits = vmLogStreamLimits, sets = ['console', 'init'] }: { limits?: typeof vmLogStreamLimits; sets?: string[] } = {}) {
  const states: SetState[] = sets.map(set => ({ set, current: null, seen: new Set(), carry: '', full: false, out: join(destination, `${set}.log.partial`),
    record: { status: 'complete', files: [], bytes: 0, firstEntryMs: null, gaps: [] } }));
  let polls = 0, failed: string | undefined, stopped = false;
  const write = (state: SetState, text: string) => {
    if (!text || state.full) return;
    const redacted = redact(text);
    if (state.record.bytes + redacted.length > limits.capBytesPerSet) { state.full = true; state.record.gaps.push(`storage cap of ${limits.capBytesPerSet} bytes reached`); return; }
    state.record.firstEntryMs ??= firstTimestampMs(redacted);
    appendFileSync(state.out, redacted);
    state.record.bytes += redacted.length;
  };
  const lines = (state: SetState, chunk: string, end: boolean) => {
    const text = state.carry + chunk, cut = end ? text.length : text.lastIndexOf('\n') + 1;
    write(state, text.slice(0, cut));
    state.carry = end ? '' : text.slice(cut);
    if (state.carry.length > limits.lineLimit) { state.record.gaps.push('line over the length limit dropped'); state.carry = ''; }
  };
  // Reads [offset, size) of one file, at most readBytesPerPoll per call; returns whether the file was read to its end.
  const read = (state: SetState, tracked: Tracked, path: string, final: boolean) => {
    const size = statSync(path).size;
    if (size < tracked.offset) { state.record.gaps.push(`${tracked.name} shrank`); tracked.offset = 0; }
    const bytes = Math.min(size - tracked.offset, limits.readBytesPerPoll);
    if (bytes > 0) {
      const buffer = Buffer.alloc(bytes), fd = openSync(path, 'r');
      try { readSync(fd, buffer, 0, bytes, tracked.offset); } finally { closeSync(fd); }
      tracked.offset += bytes;
      lines(state, buffer.toString('utf8'), false);
    }
    const done = tracked.offset >= size;
    if (done && final) lines(state, '', true);
    return done;
  };
  const poll = () => {
    polls++;
    const entries = readdirSync(source);
    for (const state of states) {
      const files = entries.flatMap(name => {
        if (name !== `${state.set}.log` && !name.startsWith(`${state.set}.log.`)) return [];
        try { const stat = statSync(join(source, name)); return stat.isFile() ? [{ name, ino: stat.ino, mtimeMs: stat.mtimeMs }] : []; } catch { return []; }
      });
      const live = files.find(file => file.name === `${state.set}.log`);
      if (!state.current) {
        if (!live) continue;
        state.current = { ...live, offset: 0 };
        state.seen.add(live.ino); state.record.files.push(live.name);
      }
      const current = state.current;
      if (live && live.ino === current.ino) { current.name = live.name; current.mtimeMs = live.mtimeMs; read(state, current, join(source, live.name), false); continue; }
      // The followed file was rotated: finish it under its new name, then every file rotated after it, oldest first.
      const renamed = files.find(file => file.ino === current.ino);
      if (renamed) {
        current.name = renamed.name; current.mtimeMs = renamed.mtimeMs;
        state.record.files[state.record.files.length - 1] = renamed.name;
        if (!read(state, current, join(source, renamed.name), true)) continue;
      } else state.record.gaps.push(`${current.name} was removed before it was read to its end`);
      const later = files.filter(file => file.name !== `${state.set}.log` && !state.seen.has(file.ino) && file.mtimeMs >= current.mtimeMs)
        .sort((a, b) => a.mtimeMs - b.mtimeMs);
      for (const file of later) {
        state.seen.add(file.ino); state.record.files.push(file.name);
        const tracked = { ...file, offset: 0 };
        while (!read(state, tracked, join(source, file.name), true)) { /* read the whole rotated file */ }
      }
      state.current = live ? { ...live, offset: 0 } : null;
      if (live) { state.seen.add(live.ino); state.record.files.push(live.name); read(state, state.current!, join(source, live.name), false); }
    }
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const tick = () => {
    try { poll(); } catch (error) { failed = (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'Docker VM log directory missing' : 'Docker VM log read failed'; return; }
    if (!stopped) { timer = setTimeout(tick, limits.intervalMs); timer.unref(); }
  };
  try { mkdirSync(destination, { recursive: true, mode: 0o700 }); for (const state of states) writeFileSync(state.out, '', { mode: 0o600 }); }
  catch { failed = 'Docker VM log destination not writable'; }
  if (!failed) tick();
  // A final poll reads what was written since the last tick; with no time left it is skipped and the files stay partial.
  return ({ untilMs }: LogStopOptions = {}): VmLogStreamRecord => {
    stopped = true;
    clearTimeout(timer);
    const result: VmLogStreamRecord = { status: 'complete', sets: {}, polls };
    if (!failed && (untilMs?.() ?? Infinity) - Date.now() >= 1_000) {
      try {
        poll();
        for (const state of states) {
          const current = state.current;
          if (current && statSync(join(source, current.name)).size > current.offset) state.record.gaps.push(`${current.name}: unread tail at the stop`);
          if (state.carry) lines(state, '', true);
        }
      } catch { failed = 'Docker VM log read failed'; }
    } else if (!failed) failed = 'Docker VM log stream stopped without a final read: no time left before cleanup';
    result.polls = polls;
    for (const state of states) {
      const record = state.record;
      if (!state.record.files.length) record.status = 'missing';
      else if (failed) record.status = 'failed';
      else if (record.gaps.length) record.status = 'partial';
      if (record.status === 'complete') try { renameSync(state.out, join(destination, `${state.set}.log`)); } catch { record.status = 'failed'; }
      if (record.status === 'missing') rmSync(state.out, { force: true });
      result.sets[state.set] = { ...record, gaps: [...record.gaps] };
    }
    const statuses = Object.values(result.sets).map(set => set.status);
    result.status = failed ? 'failed' : statuses.every(status => status === 'missing') ? 'missing' : statuses.includes('partial') ? 'partial' : 'complete';
    if (failed) result.reason = failed;
    else if (result.status !== 'complete') result.reason = Object.entries(result.sets).filter(([, set]) => set.status !== 'complete')
      .map(([name, set]) => `${name}: ${set.status === 'missing' ? 'no live file' : set.gaps.join('; ')}`).join('; ');
    return result;
  };
}
