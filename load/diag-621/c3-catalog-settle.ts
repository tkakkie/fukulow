// Settles system catalogs before a C3 window, so autovacuum triggered by CREATE DATABASE runs before, not during, it.
import { setTimeout as sleep } from 'node:timers/promises';
import { workersSQL, type Workers } from './c3-fixture.ts';

export const databasesSQL = `SELECT json_agg(datname ORDER BY datname) FROM pg_database WHERE datallowconn;`;
export const catalogRelationsSQL = `SELECT json_agg(format('%I.%I', n.nspname, c.relname) ORDER BY n.nspname, c.relname)
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname IN ('pg_catalog', 'information_schema') AND c.relkind = 'r';`;
// ANALYZE of later catalogs writes pg_statistic row versions after pg_statistic itself was vacuumed, enough to trigger
// its autovacuum later. A plain VACUUM, which writes no statistics, removes them.
export const statisticVacuumSQL = 'VACUUM pg_catalog.pg_statistic;';
export const idleSamples = 3;

export type CatalogStep = { command: string; startedAt: string; endedAt?: string; error?: string };
export type CatalogTarget = { database: string; relations: string[]; steps: CatalogStep[] };
export type CatalogSettle = { stage: string; status: 'running' | 'settled' | 'failed'; databases: string[];
  targets: CatalogTarget[]; idle: Workers[]; error?: string };
type Sql = (db: string, query: string, operation: string) => string;

// Autovacuum counts as finished only after consecutive samples, 250 ms apart, show no worker and no vacuum.
export function idleConfirmed(samples: readonly Workers[], needed = idleSamples) {
  const tail = samples.slice(-needed);
  return tail.length === needed && tail.every(row => row.workers === 0 && row.vacuums === 0);
}

// The scope is checked per relation, so the order PostgreSQL returns them in does not matter.
export function catalogRelations(database: string, listed: unknown) {
  if (!Array.isArray(listed) || !listed.length || listed.some(name => typeof name !== 'string'
    || !/^(?:pg_catalog|information_schema)\.[a-z_0-9]+$/.test(name))) {
    throw new Error(`catalog settle: catalog list of ${database} malformed`);
  }
  for (const required of ['pg_catalog.pg_class', 'pg_catalog.pg_statistic']) {
    if (!listed.includes(required)) throw new Error(`catalog settle: ${required} missing from ${database}`);
  }
  return listed as string[];
}

function step(target: CatalogTarget, command: string, run: () => void, changed: () => void) {
  const row: CatalogStep = { command, startedAt: new Date().toISOString() };
  target.steps.push(row);
  try { run(); } catch (error) { row.error = (error as Error).message; throw error; }
  finally { row.endedAt = new Date().toISOString(); changed(); }
}

// Every change is reported, so a failed settle keeps what it vacuumed and sampled before it failed.
export async function settleCatalogs(stage: string, sql: Sql, { capMs = 60000, intervalMs = 250, signal, report = () => {} }:
  { capMs?: number; intervalMs?: number; signal?: AbortSignal; report?: (evidence: CatalogSettle) => void } = {}) {
  const evidence: CatalogSettle = { stage, status: 'running', databases: [], targets: [], idle: [] };
  const changed = () => report(evidence);
  try {
    const databases: unknown = JSON.parse(sql('postgres', databasesSQL, 'list connectable databases'));
    if (!Array.isArray(databases) || !databases.includes('postgres')) throw new Error('catalog settle: database list malformed');
    evidence.databases = databases;
    changed();
    for (const database of databases as string[]) {
      const relations = catalogRelations(database, JSON.parse(sql(database, catalogRelationsSQL, `list ${database} catalogs`)));
      const target: CatalogTarget = { database, relations, steps: [] };
      evidence.targets.push(target);
      step(target, 'VACUUM (ANALYZE) of the listed relations',
        () => sql(database, `VACUUM (ANALYZE) ${relations.join(', ')};`, `vacuum and analyze ${database} catalogs`), changed);
      step(target, statisticVacuumSQL, () => sql(database, statisticVacuumSQL, `vacuum ${database} pg_statistic`), changed);
    }
    const end = performance.now() + capMs;
    while (!idleConfirmed(evidence.idle)) {
      if (performance.now() > end) throw new Error(`catalog settle: autovacuum still running after ${capMs / 1000} s (${stage})`);
      if (evidence.idle.length) await sleep(intervalMs, undefined, { signal });
      evidence.idle.push(JSON.parse(sql('postgres', workersSQL, 'confirm autovacuum finished')) as Workers);
      changed();
    }
    evidence.status = 'settled';
    changed();
    return evidence;
  } catch (error) {
    evidence.status = 'failed';
    evidence.error = error instanceof SyntaxError ? 'malformed catalog settle evidence' : (error as Error).message;
    changed();
    throw error;
  }
}

// Keeps every attempt in the run's list and hands it to the artifact writer on each report.
export function settleRecorder(settles: CatalogSettle[], write: (settles: CatalogSettle[], latest: CatalogSettle) => void) {
  return (evidence: CatalogSettle) => {
    if (!settles.includes(evidence)) settles.push(evidence);
    write(settles, evidence);
  };
}
