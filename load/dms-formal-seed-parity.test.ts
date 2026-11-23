// Formal seed parity with origin/main (#426): the non-diagnostic seed must send exactly the origin/main psql
// commands and SQL and take its clocks at the same points. The transcript records every docker call (program,
// arguments, options and SQL), every performance.now/Date.now read, every console line, the thrown error and the
// written files, in order. The digests were produced from the origin/main seed (522456e4); to compare against
// another reference directly, copy its dms-formal-seed.ts into load/ and set DM_SEED_PARITY_REFERENCE to that file.
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import crypto, { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test, type TestContext } from 'node:test';
import { seed } from './dms-formal-seed.ts';

type Mode = { name: string; env: Record<string, string>; failAt?: 'sql' | 'slow' };
const modes: Mode[] = [
  { name: 'main', env: { DM_FORMAL_SCENARIO: 'main', DM_FORMAL_SMOKE: '0', DM_FORMAL_SEED_ORGS: '3' } },
  { name: 'held200', env: { DM_FORMAL_SCENARIO: 'held200', DM_FORMAL_SMOKE: '0', DM_FORMAL_SEED_ORGS: '3' } },
  { name: 'smoke', env: { DM_FORMAL_SCENARIO: 'main', DM_FORMAL_SMOKE: '1', DM_FORMAL_SEED_ORGS: '' } },
  { name: 'pilot', env: { DM_FORMAL_SCENARIO: 'main', DM_FORMAL_SMOKE: '1', DM_FORMAL_SEED_ORGS: '10' } },
  { name: 'formal SQL failure', env: { DM_FORMAL_SCENARIO: 'main', DM_FORMAL_SMOKE: '0', DM_FORMAL_SEED_ORGS: '3' }, failAt: 'sql' },
  { name: 'formal stop rule', env: { DM_FORMAL_SCENARIO: 'main', DM_FORMAL_SMOKE: '0', DM_FORMAL_SEED_ORGS: '3' }, failAt: 'slow' },
];

const originDigests: Record<string, string> = {
  'main': 'd3e0ec81a659dda6e9ba9c3493bf979b412f51f1b6bd4372c74b651c9063964d',
  'held200': 'fe98a81f74b30160b684b0ed4707d543b762f265d5a3b9814c26e08c8727fdf0',
  'smoke': '041deacb49154bb0f7ec11d64d4a82e6075af5d0c362bd5918ba52534a0d71f5',
  'pilot': 'ec1d71edb1480087115b124eefe14eb4369274a3a8f84d446a44c92c3779cda9',
  'formal SQL failure': 'b9626a289b7680e3f61b35cd901874ac00582f57beb86b4456b58f7a9f246495',
  'formal stop rule': '58145d3bb9f275860bf73ab0c60cdce69e20cffb507999a4359437122090343b',
};

function transcript(t: TestContext, mode: Mode, run: () => void) {
  const output = mkdtempSync(join(tmpdir(), 'dm-seed-parity-'));
  t.after(() => rmSync(output, { recursive: true, force: true }));
  const env = { DM_FORMAL_SEED: '1', DM_FORMAL_OUT: output, DM_DB_CONTAINER: 'stub', ...mode.env };
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  const hash = createHash('sha256'), add = (line: string) => hash.update(line + '\n');
  let clock = 0, counter = 0, organization = -1, batch = 0;
  const mocks = [
    t.mock.method(performance, 'now', () => { add('performance.now'); return clock; }),
    t.mock.method(Date, 'now', () => { add('Date.now'); return 1760000000000 + clock; }),
    t.mock.method(console, 'log', (...args: unknown[]) => { add('console.log ' + JSON.stringify(args)); }),
    t.mock.method(crypto, 'randomBytes', (size: number) => Buffer.alloc(size, ++counter % 256)),
    t.mock.method(childProcess, 'execFileSync', (program: string, args: string[], options: { input: string }) => {
      const { input, ...rest } = options;
      add('exec ' + JSON.stringify([program, args, rest]) + ' ' + createHash('sha256').update(input).digest('hex'));
      if (input.startsWith('INSERT INTO organizations(')) { organization++; batch = 0; }
      if (input.startsWith('INSERT INTO messages(') && !input.includes("'seed'")) {
        const failing = organization === 1 && batch === 1;
        clock += batch === 0 ? 20_000 : failing && mode.failAt === 'slow' ? 6_001 : 2_000;
        batch++;
        if (failing && mode.failAt === 'sql') throw new Error('psql failed');
      } else clock += 1;
      return undefined;
    }),
  ];
  syncBuiltinESMExports();
  try {
    try { run(); add('returned'); } catch (error) { add('threw ' + (error instanceof Error ? error.message : String(error))); }
  } finally {
    for (const mock of mocks) mock.mock.restore();
    syncBuiltinESMExports();
    for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  for (const name of readdirSync(output).sort()) add('file ' + name + ' ' + createHash('sha256').update(readFileSync(join(output, name))).digest('hex'));
  return hash.digest('hex');
}

const reference = process.env.DM_SEED_PARITY_REFERENCE;
for (const mode of modes) test(`formal seed (${mode.name}) matches the origin/main command and clock transcript`, async t => {
  const current = transcript(t, mode, () => seed());
  if (reference) {
    const origin = (await import(pathToFileURL(resolve(reference)).href)) as { seed: () => void };
    const expected = transcript(t, mode, () => origin.seed());
    if (process.env.DM_SEED_PARITY_PRINT) console.error(`PARITY ${JSON.stringify(mode.name)}: '${expected}'`);
    assert.equal(current, expected);
  } else assert.equal(current, originDigests[mode.name]);
});

test('the diagnostic seed differs from the formal transcript, so the parity check can fail', t => {
  const mode = modes[0]!;
  assert.notEqual(transcript(t, mode, () => seed(true)), transcript(t, mode, () => seed()));
});
