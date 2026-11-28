import type { DiskRow } from './diskstats.ts';
import type { clientLatencies } from './pgbench-logs.ts';
import type { walIoDelta } from './wal-io.ts';

export type DiagnosticBlock = {
  label: string; disk: DiskRow[]; wal?: ReturnType<typeof walIoDelta>; clients: ReturnType<typeof clientLatencies>; errors: string[];
};
const cell = (value: string | number | null | undefined) =>
  value == null ? '—' : String(value).replaceAll('|', '\\|').replace(/\r?\n/g, ' ');
const row = (...values: Parameters<typeof cell>[0][]) => `| ${values.map(cell).join(' | ')} |`;

export function diskWaitMarkdown(blocks: DiagnosticBlock[], options: { smoke: boolean; setup?: string; serverLogError?: string }) {
  const lines = [
    '## Disk-wait diagnostics', '',
    options.smoke ? 'TRIAL / NOT EVIDENCE. Report only.' : 'Report only.', '',
    options.setup ? `Diskstats setup: ${options.setup}` : 'Device resolution and sampler placement are in disk-wait/setup.json.',
    options.serverLogError ? `PostgreSQL log: ${options.serverLogError}` : 'PostgreSQL log: [postgres.log](postgres.log).',
    '', 'Disk counters cover the whole device. Stacked devices are shown separately. Flush counters are unavailable on older kernels and are only tracked on whole devices.',
    'PostgreSQL counts are cluster-wide and can lag. Detailed snapshots, disk samples and compressed pgbench thread logs are under disk-wait/.', '',
    '| Block | Device | Reads | Writes | Sectors written | Writing ms | Flushes | Flushing ms | io_ticks ms | Weighted queue ms |',
    '|---|---|---:|---:|---:|---:|---:|---:|---:|---:|',
  ];
  for (const block of blocks) {
    if (!block.disk.length) lines.push(row(block.label, '—', null, null, null, null, null, null, null, null));
    for (const d of block.disk) lines.push(row(block.label, `${d.name} (${d.id})`, d.readsCompleted, d.writesCompleted, d.sectorsWritten,
      d.msWriting, d.flushesCompleted, d.msFlushing, d.ioTicks, d.weightedMsInQueue));
  }
  lines.push('', '| Block | WAL records | Full-page images | WAL bytes | WAL buffers full |',
    '|---|---:|---:|---:|---:|');
  for (const { label, wal } of blocks) lines.push(row(label, wal?.wal.wal_records, wal?.wal.wal_fpi, wal?.wal.wal_bytes, wal?.wal.wal_buffers_full));
  lines.push('', '| Block | WAL I/O backend type | Reads | Writes | Bytes written | Fsyncs |', '|---|---|---:|---:|---:|---:|');
  for (const { label, wal } of blocks) {
    for (const [backend, counts] of Object.entries(wal?.backend ?? {})) {
      lines.push(row(label, backend, counts.reads, counts.writes, counts.write_bytes, counts.fsyncs));
    }
  }
  lines.push('', '| Block | pgbench client ID | Count | Mean ms | p50 ms | p99 ms |', '|---|---:|---:|---:|---:|---:|');
  for (const { label, clients } of blocks) {
    for (const c of clients) lines.push(row(label, c.clientId, c.count, c.meanMs.toFixed(3), c.p50Ms.toFixed(3), c.p99Ms.toFixed(3)));
  }
  const errors = blocks.flatMap(block => block.errors.map(error => row(block.label, error)));
  if (errors.length) lines.push('', '| Block | Collection error |', '|---|---|', ...errors);
  return lines.join('\n') + '\n';
}
