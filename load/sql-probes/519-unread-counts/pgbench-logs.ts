import { gzipSync } from 'node:zlib';

// Keep shell glob order for the legacy latency file. NUL framing preserves file names and bytes.
export const readThreadLogs = `
for f in "$1".*; do
  printf '%s\\0' "${'$'}{f##*/}"
  cat "$f" || exit
  printf '\\0'
done
rm -f "$1".*
`;

export function threadLogs(stream: string, prefix: string) {
  const parts = stream.split('\0');
  if (parts.pop() !== '' || !parts.length || parts.length % 2 !== 0) throw new Error('incomplete pgbench thread log stream');
  const threads = new Map<string, string>();
  for (let i = 0; i < parts.length; i += 2) {
    const [name, raw] = parts.slice(i, i + 2);
    if (!name.startsWith(prefix + '.') || !/^\d+(?:\.\d+)?$/.test(name.slice(prefix.length + 1)) || threads.has(name)) {
      throw new Error(`unexpected pgbench thread log name ${name}`);
    }
    threads.set(name, raw);
  }
  return threads;
}

export function parsePgbenchLine(line: string) {
  const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)(?:\s|$)/.exec(line);
  if (!match) throw new Error(`bad pgbench log line: ${line.slice(0, 200)}`);
  const [clientId, transactionNo, latencyUs, , epochSeconds, epochMicros] = match.slice(1).map(Number);
  if (![clientId, transactionNo, latencyUs, epochSeconds, epochMicros].every(Number.isSafeInteger) || epochMicros >= 1_000_000) {
    throw new Error(`bad pgbench log line: ${line.slice(0, 200)}`);
  }
  return { clientId, transactionNo, latencyUs, epochSeconds, epochMicros };
}

export function clientLatencies(threads: Map<string, string>) {
  const clients = new Map<number, number[]>();
  for (const raw of threads.values()) {
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      const { clientId, latencyUs } = parsePgbenchLine(line);
      const samples = clients.get(clientId) ?? [];
      samples.push(latencyUs);
      clients.set(clientId, samples);
    }
  }
  if (clients.size === 0) throw new Error('empty pgbench thread logs');
  return [...clients].sort(([a], [b]) => a - b).map(([clientId, samples]) => {
    samples.sort((a, b) => a - b);
    const count = samples.length;
    return { clientId, count, meanMs: samples.reduce((sum, us) => sum + us, 0) / count / 1000,
      p50Ms: samples[Math.ceil(count * 0.5) - 1] / 1000, p99Ms: samples[Math.ceil(count * 0.99) - 1] / 1000 };
  });
}

export function writeThreadLogs(threads: Map<string, string>, write: (name: string, content: Buffer) => void) {
  for (const [name, raw] of threads) write(`${name}.gz`, gzipSync(raw));
}
