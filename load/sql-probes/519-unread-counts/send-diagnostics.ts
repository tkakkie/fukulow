import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { clientLatencies, threadLogs, writeThreadLogs } from './pgbench-logs.ts';
import { parseWalIo, walIoDelta, type WalIoSnapshot } from './wal-io.ts';
import type { DiagnosticBlock } from './disk-wait-summary.ts';
import type { startDiskSampler } from './disk-sampling.ts';

type Sampling = Awaited<ReturnType<typeof startDiskSampler>>;
type Window = { startMs: number; endMs: number; monoMs: number };
const reason = (error: unknown) => error instanceof Error ? error.message : String(error);

export function sendDiagnostics(out: string, label: string, sampler: Sampling | undefined, report: DiagnosticBlock[]) {
  const disk = sampler?.block(label);
  const row: DiagnosticBlock = { label, disk: [], clients: [], errors: [] };
  const snapshots: Partial<Record<'before' | 'after', WalIoSnapshot>> = {};
  let threads: Map<string, string> | undefined;
  let windows: { measuredWindow: Window; pgbenchWindow: Omit<Window, 'monoMs'> | null } | undefined;
  let started = false;
  let attemptedLogs = false;

  const recordError = (what: string, error: unknown) => row.errors.push(`${what}: ${reason(error)}`);
  return {
    wal(phase: 'before' | 'after', read: () => string) {
      try { snapshots[phase] = parseWalIo(read()); }
      catch (error) { recordError(`WAL I/O ${phase}`, error); }
    },
    error: recordError,
    start() {
      started = true;
      disk?.start();
    },
    stop: () => disk?.stop(),
    windows: (measuredWindow: Window, pgbenchWindow: Omit<Window, 'monoMs'> | null) => { windows = { measuredWindow, pgbenchWindow }; },
    log(prefix: string, read: () => string) {
      attemptedLogs = true;
      try {
        threads = threadLogs(read(), prefix);
        return [...threads.values()].join('');
      } catch (error) {
        recordError('pgbench thread logs', error);
        throw error;
      }
    },
    async save(readLogs: () => string) {
      if (!started) return;
      disk?.stop();
      report.push(row);
      if (!attemptedLogs) {
        try { readLogs(); } catch { /* log() records the error */ }
      }
      const directory = join(out, 'disk-wait', label);
      const attempt = (what: string, action: () => void) => {
        try { action(); } catch (error) { recordError(what, error); }
      };
      attempt('diagnostic directory', () => mkdirSync(directory, { recursive: true }));
      const write = (name: string, contents: unknown) => writeFileSync(join(directory, name), JSON.stringify(contents, null, 2) + '\n');
      const series = await disk?.result();
      if (series) {
        row.disk = series.deltas;
        row.errors.push(...series.errors);
        const pgbench = windows?.pgbenchWindow;
        const first = series.samples[0], last = series.samples.at(-1);
        if (pgbench && first?.phase === 'start' && last?.phase === 'end' &&
            (first.atMs > pgbench.startMs || last.atMs < Math.floor(pgbench.endMs))) {
          const error = 'diskstats samples did not bracket pgbench transactions';
          series.errors.push(error);
          row.errors.push(error);
        }
        attempt('diskstats.json', () => write('diskstats.json', { ...windows, ...series }));
      }
      const { before, after } = snapshots;
      if (before && after) attempt('WAL I/O delta', () => { row.wal = walIoDelta(before, after); });
      else row.errors.push('missing a WAL I/O boundary snapshot');
      attempt('wal-io.json', () => write('wal-io.json', { ...snapshots, delta: row.wal }));
      if (threads) {
        const raw = threads;
        const logs = join(directory, 'pgbench');
        attempt('pgbench log directory', () => mkdirSync(logs));
        attempt('pgbench compression', () =>
          writeThreadLogs(raw, (name, content) => attempt(name, () => writeFileSync(join(logs, name), content))));
        attempt('per-client pgbench summary', () => {
          row.clients = clientLatencies(raw);
          write('clients.json', row.clients);
        });
      }
      attempt('diagnostic errors.json', () => write('errors.json', row.errors));
    },
  };
}
