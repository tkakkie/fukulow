import { existsSync, realpathSync, statSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { scaledLoad, localLimits, type LocalLimits } from './dms-formal-local.ts';
import { outsideCheckout } from './dms-workload.ts';
import { requiredScenarios, deferredNames, type Scenario } from './dms-formal-scenarios.ts';

export type Config = { app: string; db: string; generator: string; sha: string; output: string; scenario: Scenario; attempts: number; mode: 'formal' | 'smoke'; deadline?: number; reviewedPatchSha256?:string; downloadRaw?: boolean; target?: 'ssh'|'local'; loadScale?:string; limits?:LocalLimits; pilot?:boolean; seedDiagnostic?:boolean; seedBaseline?:boolean; pilotSeconds?:number;pilotImage?:string };
export const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
export function external(path: string, checkout: string): string {
  if (!isAbsolute(path)) throw new Error('Paths must be absolute');
  const canonical = existsSync(path) ? realpathSync(path) : resolve(realpathSync(dirname(path)), path.split('/').at(-1)!);
  if (!outsideCheckout(canonical, realpathSync(checkout))) throw new Error('Path must be outside checkout');
  return canonical;
}
export function readRunConfig(args: string[], checkout: string): Config {
  const [path = '', option] = args;
  if (args.length > 2 || (option !== undefined && option !== '--pilot' && option !== '--seed-diagnostic' && option !== '--seed-diagnostic-baseline')) {
    throw new Error('Expected <config> [--pilot | --seed-diagnostic | --seed-diagnostic-baseline]');
  }
  // The baseline arm is the seed diagnostic run with every instrumentation off: the formal seed, the formal DB command,
  // no samplers. It gives the matched seed time the instrumented arm is compared with (dms-formal-seed-effect.ts).
  const config = readConfig(path, checkout, option === '--pilot', option === '--seed-diagnostic' || option === '--seed-diagnostic-baseline');
  return option === '--seed-diagnostic-baseline' ? { ...config, seedBaseline: true } : config;
}

export function requireSeedDiagnostic(config: Pick<Config, 'target'|'scenario'|'mode'|'pilot'>, scale: string) {
  if (config.target !== 'local' || config.scenario !== 'pool-overhead' || config.mode !== 'formal' || config.pilot || scale !== '1/25') {
    throw new Error('Seed diagnostic requires local pool-overhead, a formal fixture and load scale 1/25');
  }
}

export function readConfig(path: string, checkout: string, pilot=false, seedDiagnostic=false): Config {
  path = external(path, checkout);
  const stat = statSync(path);
  if (!stat.isFile() || (stat.mode & 0o177) !== 0 || stat.uid !== process.getuid?.()) throw new Error('Private env must be an owned regular file, mode 0600 or narrower');
  const entries: Record<string, string> = {};
  const allowed = ['DM_FORMAL_TARGET','DM_FORMAL_LOAD_SCALE','DM_FORMAL_APP_CPU','DM_FORMAL_APP_MEMORY','DM_FORMAL_DB_CPU','DM_FORMAL_DB_MEMORY','DM_FORMAL_GENERATOR_CPU','DM_FORMAL_GENERATOR_MEMORY','DM_FORMAL_PILOT_IMAGE','DM_FORMAL_PILOT_SECONDS','DM_FORMAL_APP','DM_FORMAL_DB','DM_FORMAL_GENERATOR','DM_FORMAL_SHA','DM_FORMAL_OUTPUT','DM_FORMAL_SCENARIO','DM_FORMAL_ATTEMPTS','DM_FORMAL_MODE','DM_FORMAL_DEADLINE','DM_FORMAL_DOWNLOAD_RAW','DM_FORMAL_REVIEWED_PATCH_SHA256'];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const match = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line);
    if (!match || !allowed.includes(match[1]) || Object.hasOwn(entries, match[1])) throw new Error('Unknown, duplicate or malformed env entry');
    entries[match[1]] = match[2];
  }
  const alias = (key: string) => { const value = entries[key]; if (!value || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(value)) throw new Error('SSH config aliases required'); return value; };
  const target=entries.DM_FORMAL_TARGET || 'ssh';
  if(target!=='ssh' && target!=='local')throw new Error('TARGET must be ssh or local');
  const app = target==='local'?'app':alias('DM_FORMAL_APP'), db = target==='local'?'db':alias('DM_FORMAL_DB'), generator = target==='local'?'generator':alias('DM_FORMAL_GENERATOR');
  if (new Set([app, db, generator]).size !== 3) throw new Error('Three separate SSH targets required');
  const sha = entries.DM_FORMAL_SHA || '';
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error('Full source SHA required');
  const output = external(entries.DM_FORMAL_OUTPUT || '', checkout);
  if (existsSync(output)) throw new Error('Output directory must be new');
  const mode = entries.DM_FORMAL_MODE || 'formal', scenario = entries.DM_FORMAL_SCENARIO || 'main';
  const attempts = Number(entries.DM_FORMAL_ATTEMPTS || 3);
  if (mode !== 'smoke' && mode !== 'formal') throw new Error('Mode must be formal or smoke');
  if (!['smoke',...requiredScenarios,...deferredNames].includes(scenario as Scenario)) throw new Error('Unknown formal scenario');
  if(scenario==='smoke' && mode!=='smoke')throw new Error('Smoke scenario requires smoke mode');
  if (!Number.isSafeInteger(attempts) || attempts < (mode === 'formal' ? 3 : 1) || attempts > 10) throw new Error('Formal mode requires at least three consecutive attempts (maximum ten)');
  const deadline = entries.DM_FORMAL_DEADLINE ? Date.parse(entries.DM_FORMAL_DEADLINE) : undefined;
  if (deadline !== undefined && (!/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(entries.DM_FORMAL_DEADLINE) || !Number.isFinite(deadline) || deadline<=Date.now())) throw new Error('Deadline must be a future ISO time with timezone');
  if(entries.DM_FORMAL_DOWNLOAD_RAW && !['0','1'].includes(entries.DM_FORMAL_DOWNLOAD_RAW))throw new Error('DOWNLOAD_RAW must be 0 or 1');
  if(scenario==='pool-overhead' && (mode!=='formal' || attempts!==3 || !/^[a-f0-9]{64}$/.test(entries.DM_FORMAL_REVIEWED_PATCH_SHA256 || '')))throw new Error('Pool overhead requires formal mode, exactly three pairs and reviewed patch SHA256');
  const load=scaledLoad(entries.DM_FORMAL_LOAD_SCALE ?? (seedDiagnostic ? '1/25' : undefined));
  if(seedDiagnostic)requireSeedDiagnostic({target,scenario:scenario as Scenario,mode,pilot},load.factor);
  if(target==='local' && (scenario==='main'||scenario==='held200'||(scenario!=='pool-overhead' && mode!=='smoke')))throw new Error('Local target is only allowed for pool-overhead or non-acceptance smoke; main/held200 are refused');
  if(load.factor!=='1/1' && scenario!=='pool-overhead')throw new Error('Load scale is only allowed for pool-overhead');
  if(pilot && (target!=='local' || scenario!=='pool-overhead'))throw new Error('Pilot requires local pool-overhead');
  const limits={...localLimits};
  for(const key of Object.keys(limits) as (keyof LocalLimits)[]) {
    const env='DM_FORMAL_'+key.replace(/([A-Z])/g,'_$1').toUpperCase(), value=entries[env];
    if(value!==undefined) {
      if(target!=='local')throw new Error('Custom limits require local target');
      if(key.endsWith('Cpu')) {if(!/^\d+(?:\.\d+)?$/.test(value)||Number(value)<=0||Number(value)>64)throw new Error('Invalid CPU limit');Object.assign(limits,{[key]:Number(value)});}
      else {if(!/^[1-9]\d*[mg]$/.test(value))throw new Error('Memory limits use positive integer m/g');Object.assign(limits,{[key]:value});}
    }
  }
  const pilotSeconds=Number(entries.DM_FORMAL_PILOT_SECONDS || 60);
  if(!Number.isSafeInteger(pilotSeconds)||pilotSeconds<10||pilotSeconds>120)throw new Error('Pilot core must be 10–120 seconds');
  if(entries.DM_FORMAL_PILOT_SECONDS && !pilot)throw new Error('Short timing is pilot-only');
  const pilotImage=entries.DM_FORMAL_PILOT_IMAGE;
  if(pilotImage && (!pilot || !/^sha256:[a-f0-9]{64}$/.test(pilotImage)))throw new Error('PILOT_IMAGE requires pilot and an immutable local image digest');
  return { ...(seedDiagnostic ? {seedDiagnostic} : {}), pilotImage,target,loadScale:load.factor,limits,pilot,pilotSeconds, reviewedPatchSha256:entries.DM_FORMAL_REVIEWED_PATCH_SHA256, app, db, generator, sha, output, mode, scenario:scenario as Scenario, attempts, deadline, downloadRaw:entries.DM_FORMAL_DOWNLOAD_RAW==='1' };
}
