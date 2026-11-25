import { hash, randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { sameSessionIdentity, type SessionIdentity } from './revocation-holds-provenance.ts';

type HostSession = Pick<SessionIdentity, 'hostname' | 'session'>;
type Status = 'started' | 'failed' | 'passed';
type Entry = HostSession & { id: string; status: Status; at: string; artifactSha256?: string };
type Result = { passed: boolean; readback: number | null };

// One ledger per host, whatever --out each stage uses, so a later failed preflight is never missed.
export function preflightLedgerPath(hostname: string, configured?: string, env = process.env, home = homedir()) {
  const state = env.XDG_STATE_HOME && isAbsolute(env.XDG_STATE_HOME) ? env.XDG_STATE_HOME : join(home, '.local/state');
  return configured ?? join(state, 'fukulow', `revocation-holds-preflights.${encodeURIComponent(hostname)}.ndjson`);
}

// A later stage must read the ledger its preflight wrote to, or it could miss a newer failure.
export function requireRecordedLedger(preflightFile: string, ledger: string) {
  let recorded: unknown;
  try { recorded = (JSON.parse(readFileSync(preflightFile, 'utf8')) as { ledger?: unknown }).ledger; }
  catch (error) { throw new Error(`Cannot read the ledger recorded in ${preflightFile}: ${(error as Error).message}`); }
  if (recorded !== ledger) {
    throw new Error(`Preflight ledger ${ledger} differs from ${typeof recorded === 'string' ? recorded : 'none'} recorded in ${preflightFile}`);
  }
}

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
    const content = JSON.stringify({ ...result, id, ledger }, null, 2);
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
  if (latest.artifactSha256 !== hash('sha256', content)) return;
  const result = JSON.parse(content.toString('utf8'));
  if (result?.ledger === ledger) return result;
}
