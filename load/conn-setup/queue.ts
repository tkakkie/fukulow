import { execFileSync } from 'node:child_process';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { parseArgs } from 'node:util';
import { outsideCheckout } from '../harness-core/checkout.ts';
import { parseQueue, type Queue } from '../launcher/queue.ts';
import { postgresImage, postgresLogLabel, workloadLabel } from './stack.ts';

const { values } = parseArgs({ options: {
  runs: { type: 'string' }, stage: { type: 'string' }, commit: { type: 'string' },
  'go-quote': { type: 'string' }, 'go-date': { type: 'string' },
} });
const { runs, stage, commit, 'go-quote': quote, 'go-date': date } = values;
const worktree = process.cwd();
if (!runs || !isAbsolute(runs) || !outsideCheckout(runs, worktree) || !commit ||
    (stage !== 'rehearsal' && stage !== 'recorded') || !quote?.trim() || !date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
  throw new Error('Usage: node load/conn-setup/queue.ts --runs ABSOLUTE_RUNS_DIR --stage rehearsal|recorded --commit FULL_SHA --go-date YYYY-MM-DD --go-quote QUOTE');
}
const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
if (head !== commit) throw new Error('Queue commit must match the full worktree HEAD SHA');

const root = realpathSync(runs);
const name = `1066-${stage}`;
const chainDir = join(root, name);
const out = join(chainDir, 'result');
const queue: Queue = {
  name, chainDir, hostBusy: join(root, 'HOST-BUSY'),
  jobs: [{
    name, issue: 1066, go: { quote, date }, worktree, commit, out,
    command: ['node', 'load/conn-setup/run.ts', `--${stage}`, '--out', out],
    image: postgresImage(), minFreeGiB: 20, workloadLabel, postgresLogLabel,
    requireHost: { boost: '1', policyBoost: '1', platformProfile: 'performance' },
  }],
};
const json = JSON.stringify(queue, null, 2) + '\n';
parseQueue(json);
mkdirSync(chainDir, { mode: 0o700 });
const file = join(chainDir, 'queue.json');
writeFileSync(file, json, { flag: 'wx', mode: 0o600 });
console.log(file);
