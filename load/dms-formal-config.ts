import { existsSync, realpathSync, statSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { outsideCheckout } from './dms-workload.ts';
import { requiredScenarios, deferredNames, type Scenario } from './dms-formal-scenarios.ts';

export type Config = { app: string; db: string; generator: string; sha: string; output: string; scenario: Scenario; attempts: number; mode: 'formal' | 'smoke'; deadline?: number; downloadRaw?: boolean };
export const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
export function external(path: string, checkout: string): string {
  if (!isAbsolute(path)) throw new Error('Paths must be absolute');
  const canonical = existsSync(path) ? realpathSync(path) : resolve(realpathSync(dirname(path)), path.split('/').at(-1)!);
  if (!outsideCheckout(canonical, realpathSync(checkout))) throw new Error('Path must be outside checkout');
  return canonical;
}
export function readConfig(path: string, checkout: string): Config {
  path = external(path, checkout);
  const stat = statSync(path);
  if (!stat.isFile() || (stat.mode & 0o177) !== 0 || stat.uid !== process.getuid?.()) throw new Error('Private env must be an owned regular file, mode 0600 or narrower');
  const entries: Record<string, string> = {};
  const allowed = ['DM_FORMAL_APP','DM_FORMAL_DB','DM_FORMAL_GENERATOR','DM_FORMAL_SHA','DM_FORMAL_OUTPUT','DM_FORMAL_SCENARIO','DM_FORMAL_ATTEMPTS','DM_FORMAL_MODE','DM_FORMAL_DEADLINE','DM_FORMAL_DOWNLOAD_RAW'];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const match = /^([A-Z_]+)=(.*)$/.exec(line);
    if (!match || !allowed.includes(match[1]) || Object.hasOwn(entries, match[1])) throw new Error('Unknown, duplicate or malformed env entry');
    entries[match[1]] = match[2];
  }
  const alias = (key: string) => { const value = entries[key]; if (!value || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(value)) throw new Error('SSH config aliases required'); return value; };
  const app = alias('DM_FORMAL_APP'), db = alias('DM_FORMAL_DB'), generator = alias('DM_FORMAL_GENERATOR');
  if (new Set([app, db, generator]).size !== 3) throw new Error('Three separate SSH targets required');
  const sha = entries.DM_FORMAL_SHA || '';
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error('Full source SHA required');
  const output = external(entries.DM_FORMAL_OUTPUT || '', checkout);
  if (existsSync(output)) throw new Error('Output directory must be new');
  const mode = entries.DM_FORMAL_MODE || 'formal', scenario = entries.DM_FORMAL_SCENARIO || 'main';
  const attempts = Number(entries.DM_FORMAL_ATTEMPTS || 3);
  if (mode !== 'smoke' && mode !== 'formal') throw new Error('Mode must be formal or smoke');
  if (![...requiredScenarios,...deferredNames].includes(scenario as Scenario)) throw new Error('Unknown formal scenario');
  if (!Number.isSafeInteger(attempts) || attempts < (mode === 'formal' ? 3 : 1) || attempts > 10) throw new Error('Formal mode requires at least three consecutive attempts (maximum ten)');
  const deadline = entries.DM_FORMAL_DEADLINE ? Date.parse(entries.DM_FORMAL_DEADLINE) : undefined;
  if (deadline !== undefined && (!/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(entries.DM_FORMAL_DEADLINE) || !Number.isFinite(deadline) || deadline<=Date.now())) throw new Error('Deadline must be a future ISO time with timezone');
  if(entries.DM_FORMAL_DOWNLOAD_RAW && !['0','1'].includes(entries.DM_FORMAL_DOWNLOAD_RAW))throw new Error('DOWNLOAD_RAW must be 0 or 1');
  return { app, db, generator, sha, output, mode, scenario:scenario as Scenario, attempts, deadline, downloadRaw:entries.DM_FORMAL_DOWNLOAD_RAW==='1' };
}
