import { hash, randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { sameSessionIdentity, type SessionIdentity } from './revocation-holds-provenance.ts';

type HostSession = Pick<SessionIdentity, 'hostname' | 'session'>;
type Status = 'started' | 'failed' | 'passed';
type Entry = HostSession & { id: string; status: Status; at: string; artifactSha256?: string };
type Result = { passed: boolean; readback: number | null };

export const preflightLedgerPath = (output: string, hostname: string, configured?: string) =>
  configured ?? join(dirname(output), `revocation-holds-preflights.${encodeURIComponent(hostname)}.ndjson`);

export async function recordPreflight<T extends Result>(
  ledger: string, output: string, key: HostSession, readIdentity: () => Promise<SessionIdentity>,
  run: (identity: SessionIdentity, saveProgress: (result: T) => void) => Promise<T>,
) {
  const id = randomUUID();
  const artifact = join(output, 'preflight.json');
  const append = (status: Status, artifactSha256?: string) => {
    const entry: Entry = { ...key, id, status, at: new Date().toISOString(), artifactSha256 };
    appendFileSync(ledger, `${JSON.stringify(entry)}\n`, { flush: true });
  };
  const save = (result: T) => {
    const content = JSON.stringify({ ...result, id }, null, 2);
    writeFileSync(artifact, content, { flush: true });
    return hash('sha256', content);
  };
  mkdirSync(dirname(ledger), { recursive: true });
  // A crash or interruption must supersede a previous pass before any provisioning starts.
  append('started');
  let result: T;
  let sha256: string;
  try {
    const identity = await readIdentity();
    result = await run(identity, progress => save({ ...progress, passed: false, readback: null }));
    if (result.passed && !sameSessionIdentity(identity, await readIdentity())) {
      throw new Error('SA2: measurement provenance changed during preflight');
    }
    sha256 = save(result);
  } catch (error) {
    append('failed');
    throw error;
  }
  append(result.passed ? 'passed' : 'failed', sha256);
  return result;
}

export function loadLedgerPreflight(ledger: string, artifact: string, key: HostSession): unknown {
  const entries: Entry[] = readFileSync(ledger, 'utf8').trimEnd().split('\n').map(line => {
    const entry: Entry = JSON.parse(line);
    if (typeof entry?.hostname !== 'string' || typeof entry.session !== 'string' ||
      !['started', 'failed', 'passed'].includes(entry.status)) throw new Error('Invalid preflight ledger entry');
    return entry;
  });
  const latest = entries.findLast(entry => entry.hostname === key.hostname && entry.session === key.session);
  if (latest?.status !== 'passed') return;
  const content = readFileSync(artifact);
  if (latest.artifactSha256 === hash('sha256', content)) return JSON.parse(content.toString('utf8'));
}
