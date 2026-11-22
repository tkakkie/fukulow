import { existsSync, readFileSync } from 'node:fs';
import { benchmark } from '../bench.ts';
import type { Sample } from './acceptance.ts';
import { benchmarkScript } from './path.ts';

export function timedOutcomes(output: string) {
  return [...output.matchAll(/^d3r-outcome (\S+)\r?$/gm)].map(match => match[1]);
}

function queryError(output: string) {
  // A pgbench SQL error is a query outcome. Connection/setup failures and
  // failures of the shared timeout guard have no search outcome to report.
  return output.match(/^.*\baborted in command ([2-9]|[1-9]\d+)\b.*\b(ERROR: .+)$/m)?.[2];
}

export async function timeQuery(container: string, db: string, page: string, query: string, raw: string,
  recordOutcome: boolean, dest: string, transactions: number, clients: number,
  measure = benchmark): Promise<Sample> {
  const script = benchmarkScript(page, raw, recordOutcome);
  let metrics;
  try {
    metrics = await measure(container, db, script, dest, transactions, clients);
  } catch (error) {
    if (recordOutcome && existsSync(dest + '.txt')) {
      const output = readFileSync(dest + '.txt', 'utf8');
      const sqlError = queryError(output);
      if (sqlError) return {query, outcomes: timedOutcomes(output), sqlError};
    }
    throw error;
  }
  return {query, ...metrics, ...(recordOutcome ? {outcomes: timedOutcomes(readFileSync(dest + '.txt', 'utf8'))} : {})};
}
