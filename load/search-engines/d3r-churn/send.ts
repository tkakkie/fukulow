import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createWriteStream, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { finished } from 'node:stream/promises';
import { collect, type Boundary } from '../../search-m1-results.ts';
import { classify, sustained, workload } from '../../search-m1-report.ts';
import { acceptedMessages } from '../../search-s1-evidence.ts';
import { docker } from '../bench.ts';
import { org } from '../seed.ts';
import { isolatedArgs, verifyImage, type Images, type Names } from './cluster.ts';
import { full } from './design.ts';
import { loadEmail, loadPassword } from './fixture.ts';
import type { Options } from './options.ts';

export function sendConfig(smoke: boolean) {
  return {...workload(smoke ? 'hot' : 'many', true), rates: [full.rate], seconds: full.sendSeconds};
}

export async function send(resources: Names, images: Images, args: Options,
  onBoundary: (mark: 'prepared' | 'started' | 'ended') => void, signal: AbortSignal) {
  const smoke = args.mode === 'smoke';
  const expected = sendConfig(smoke);
  const env = {
    BASE_URL: 'http://app:8080', LOAD_EMAIL: loadEmail, LOAD_PASSWORD: loadPassword, LOAD_ORGANIZATION_ID: org(1),
    CHANNELS: String(expected.channels), THROUGHPUT_MEMBERS: String(expected.members),
    THROUGHPUT_SCENARIO: expected.mode, THROUGHPUT_RATES: expected.rates.join(','),
    THROUGHPUT_STEP_SECONDS: String(expected.seconds),
    THROUGHPUT_VUS: String(expected.preAllocatedVUs), THROUGHPUT_MAX_VUS: String(expected.maxVUs),
    REQUEST_TIMEOUT_SECONDS: String(expected.requestTimeoutSeconds),
    THROUGHPUT_BODIES: '/send-bodies.json', THROUGHPUT_RECORD_ACCEPTED_IDS: '1',
  };
  docker('create', ...isolatedArgs(resources.k6, 'client', !smoke), '--network', resources.network,
    '--ulimit', 'nofile=65536:65536', '-v', `${process.cwd()}:/work:ro`, '-w', '/work',
    '-v', `${args.out}/send-bodies.json:/send-bodies.json:ro`,
    ...Object.entries(env).flatMap(([key, value]) => ['-e', `${key}=${value}`]),
    images.k6, 'run', '--quiet', '--log-format', 'raw', smoke
      ? 'load/search-engines/d3r-churn/smoke-send.ts' : 'load/throughput.ts');
  verifyImage(resources.k6, images.k6);
  const err = createWriteStream(`${args.out}/w1-k6.log`);
  const out = createWriteStream(`${args.out}/w1-k6-summary.log`);
  const child = spawn('docker', ['start', '-a', resources.k6], {signal, stdio: ['ignore', 'pipe', 'pipe'],
    timeout: (expected.seconds + expected.channels * 5 + expected.members * 25 + 120) * 1000});
  child.stderr.pipe(err);
  child.stdout.pipe(out);
  const logs = Promise.all([finished(out), finished(err)]);
  void logs.catch(() => child.kill('SIGTERM'));
  const statuses = new Map([['LOAD_MEASUREMENT_START', 'prepared'], ['LOAD_THROUGHPUT_START', 'started'],
    ['LOAD_MEASUREMENT_END', 'ended']] as const);
  const seen = new Set<string>();
  createInterface({input: child.stderr}).on('line', line => {
    const status = statuses.get(line as Parameters<typeof statuses.get>[0]);
    if (!status || seen.has(status)) return;
    seen.add(status);
    onBoundary(status);
  });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once('error', error => reject((error as NodeJS.ErrnoException).code === 'ABORT_ERR' ? signal.reason : error));
    child.once('close', resolve);
  });
  await logs;
  assert.ok(code === 0 || (!smoke && code === 99), `W1 k6 exited ${code}`);
  assert.equal(seen.size, statuses.size, 'W1 stage markers are incomplete');
  return smoke ? undefined : readFileSync(`${args.out}/w1-k6-summary.log`, 'utf8');
}

export function sendEvidence(out: string, log: string | undefined, bodyHash: string, startMs: number | undefined,
  boundaries: Boundary[]) {
  const step = log === undefined ? undefined : collect(log, sendConfig(false), startMs, boundaries, [], true);
  if (step) assert.equal(step.bodySha256, bodyHash, 'W1 k6 body hash does not match the generator');
  const accepted = step?.totals.accepted ?? 1;
  const messages = acceptedMessages(readFileSync(`${out}/w1-k6.log`, 'utf8'), accepted);
  assert.equal(messages.organizationId, org(1), 'W1 used a different Organization than the search queries');
  return {accepted, sustained: step ? (
    step.steps.length === 1 && classify(step.steps[0], true) === sustained
  ) : null, step};
}
export type SendEvidence = ReturnType<typeof sendEvidence>;
