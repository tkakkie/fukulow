import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { parseQueue } from '../../launcher/queue.ts';
import { parseSamples } from '../../harness-core/thermal.ts';
import { judge, type RunInput } from './stability-judge.ts';

// Judges the second #796 stability check from the launcher queue it ran (see stability-judge.ts).
const usage = 'node load/sql-probes/519-unread-counts/stability.ts --queue QUEUE_FILE --out NEW_JUDGEMENT_FILE';
const { values } = parseArgs({ options: { queue: { type: 'string' }, out: { type: 'string' }, help: { type: 'boolean' } } });
if (values.help) { console.log(usage); process.exit(0); }
if (!values.queue || !values.out) throw new Error(usage);
if (existsSync(values.out)) throw new Error(`refusing to overwrite ${values.out}`);
const q = parseQueue(readFileSync(values.queue, 'utf8'));
const text = (path: string) => (existsSync(path) ? readFileSync(path, 'utf8') : null);
const json = (path: string) => { const t = text(path); return t === null ? null : JSON.parse(t); };

const runs: RunInput[] = q.jobs.map(job => ({
  name: job.name,
  out: job.out,
  complete: json(join(job.out, 'status.json'))?.complete === true,
  statusSession: json(join(job.out, 'status.json'))?.launchSession,
  sends: json(join(job.out, 'sends.json'))?.sends ?? [],
  metadata: json(join(job.out, 'metadata.json')) ?? { cpuSets: null, sends: { measuredSeconds: NaN } },
  hostBefore: json(join(q.chainDir, `${job.name}-host-before.json`)),
  cooldown: json(join(q.chainDir, `${job.name}-cooldown.json`)),
  launchCheck: json(join(q.chainDir, `${job.name}-launch-check.json`)),
  samples: parseSamples(text(join(q.chainDir, `${job.name}-thermal.jsonl`)) ?? ''),
}));
const verdict = judge(runs, json(join(q.chainDir, 'session.json')), q.name);
writeFileSync(values.out, JSON.stringify(verdict, null, 2) + '\n', { flag: 'wx' });
console.log(`${verdict.result}${verdict.reasons.length ? ': ' + verdict.reasons.join('; ') : ''}`);
