// Settles system catalogs before a C3 window, so autovacuum triggered by CREATE DATABASE runs before, not during, it.
import { setTimeout as sleep } from 'node:timers/promises';
import { workersSQL, type Workers } from './c3-fixture.ts';

export const databasesSQL = `SELECT json_agg(datname ORDER BY datname) FROM pg_database WHERE datallowconn;`;
// One statement: VACUUM cannot run inside the transaction that psql opens for several statements.
export const catalogVacuumSQL = `SELECT 'VACUUM (ANALYZE) ' || string_agg(format('%I.%I', n.nspname, c.relname), ', ' ORDER BY n.nspname, c.relname)
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname IN ('pg_catalog', 'information_schema') AND c.relkind = 'r';`;
export const idleSamples = 3;

export type CatalogVacuum = { database: string; relations: number; startedAt: string; endedAt: string };
export type CatalogSettle = { stage: string; vacuums: CatalogVacuum[]; idle: Workers[] };

// Autovacuum counts as finished only after consecutive samples, 250 ms apart, show no worker and no vacuum.
export function idleConfirmed(samples: readonly Workers[], needed = idleSamples) {
  const tail = samples.slice(-needed);
  return tail.length === needed && tail.every(row => row.workers === 0 && row.vacuums === 0);
}

export async function settleCatalogs(stage: string, sql: (db: string, query: string, operation: string) => string,
  { capMs = 60000, intervalMs = 250, signal }: { capMs?: number; intervalMs?: number; signal?: AbortSignal } = {}): Promise<CatalogSettle> {
  const databases = JSON.parse(sql('postgres', databasesSQL, 'list connectable databases')) as string[];
  if (!Array.isArray(databases) || !databases.includes('postgres')) throw new Error('catalog settle: database list malformed');
  const vacuums: CatalogVacuum[] = [];
  for (const database of databases) {
    const statement = sql(database, catalogVacuumSQL, `list ${database} catalogs`);
    if (!statement.startsWith('VACUUM (ANALYZE) pg_catalog.')) throw new Error(`catalog settle: no catalogs listed in ${database}`);
    const startedAt = new Date().toISOString();
    sql(database, `${statement};`, `vacuum and analyze ${database} catalogs`);
    vacuums.push({ database, relations: statement.split(', ').length, startedAt, endedAt: new Date().toISOString() });
  }
  const idle: Workers[] = [];
  const end = performance.now() + capMs;
  while (!idleConfirmed(idle)) {
    if (performance.now() > end) throw new Error(`catalog settle: autovacuum still running after ${capMs / 1000} s (${stage})`);
    if (idle.length) await sleep(intervalMs, undefined, { signal });
    idle.push(JSON.parse(sql('postgres', workersSQL, 'confirm autovacuum finished')) as Workers);
  }
  return { stage, vacuums, idle };
}
