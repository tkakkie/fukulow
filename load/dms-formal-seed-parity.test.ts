// #426 formal seed parity: the pre-#620 transcript must match except for the removed channel_log Create statements.
// Restore those statements only when hashing the SQL, then check against the original digests from 522456e4.
// The transcript covers Docker program, arguments, options and SQL, clock reads, console lines, errors and files.
// For an additional direct comparison, point DM_SEED_PARITY_REFERENCE at the old seed with its original imports.
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

// The exact block emitted by channel-log.ts and channel-log.sql at 522456e4.
const legacyCreate = (organization: string, channels: string) => `
PREPARE fixture_create_log(uuid,uuid[]) AS -- Load fixtures that insert Messages directly must also append their Create
-- log (#515), or replay from after_seq 0 closes with 1011. Same shape as the
-- channel_log migration backfill, scoped to $1 Organization and $2 Channels,
-- and idempotent. The realtime replay smoke test runs this exact file.
INSERT INTO channel_log (organization_id, channel_id, event_seq, kind, message_id, sender, client_message_id)
SELECT m.organization_id, m.channel_id, m.seq, 'create', m.id, m.sender, m.client_message_id
FROM messages m
WHERE m.organization_id = $1 AND m.channel_id = ANY($2)
    AND NOT EXISTS (
        SELECT 1 FROM channel_log l
        WHERE l.organization_id = m.organization_id AND l.channel_id = m.channel_id AND l.event_seq = m.seq
    );
EXECUTE fixture_create_log(${organization},ARRAY[${channels}]::uuid[]);
DEALLOCATE fixture_create_log;`;

function restoreLegacyCreates(sql: string): string {
  return sql
    .replace(/^INSERT INTO messages\(.* c\.organization_id=('[0-9a-f-]{36}') AND c\.id=ANY\(ARRAY\[(.+)\]\);$/m,
      (statement, organization, channels) => statement + legacyCreate(organization, channels))
    .replace(/^INSERT INTO channel_message_sequences VALUES\(('[0-9a-f-]{36}'),('[0-9a-f-]{36}'),1\); .*INSERT INTO messages\(.*;$/m,
      (statement, organization, channel) => statement + legacyCreate(organization, `${channel}::uuid`));
}

function transcript(t: TestContext, mode: Mode, run: () => void, transcriptSql = restoreLegacyCreates) {
  const output = mkdtempSync(join(tmpdir(), 'dm-seed-parity-'));
  t.after(() => rmSync(output, { recursive: true, force: true }));
  // DM_FORMAL_SEED_BATCHES is cleared as the full-size worker does, so an exported shell value cannot shorten the transcript.
  const env = { DM_FORMAL_SEED: '1', DM_FORMAL_OUT: output, DM_DB_CONTAINER: 'stub', DM_FORMAL_SEED_BATCHES: '', ...mode.env };
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
      add('exec ' + JSON.stringify([program, args, rest]) + ' ' + createHash('sha256').update(transcriptSql(input)).digest('hex'));
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
for (const mode of modes) test(`formal seed (${mode.name}) matches the pre-#620 transcript after removing Create log statements`, async t => {
  const current = transcript(t, mode, () => seed());
  assert.equal(current, originDigests[mode.name]);
  if (reference) {
    const origin = (await import(pathToFileURL(resolve(reference)).href)) as { seed: () => void };
    const expected = transcript(t, mode, () => origin.seed(), sql => sql);
    if (process.env.DM_SEED_PARITY_PRINT) console.error(`PARITY ${JSON.stringify(mode.name)}: '${expected}'`);
    assert.equal(current, expected);
  }
});

// The full-size diagnostic seed (#920) matches its digest from a17fc978 with the same #620 allowance.
test('the full-size diagnostic seed keeps its pinned command and clock transcript', t => {
  assert.equal(transcript(t, modes[0]!, () => seed(true)), '8d06a65f8b9e47011829f872f9136ea443b29d8ce0e2529567c360ff7f6e3ef3');
});

test('the diagnostic seed differs from the formal transcript, so the parity check can fail', t => {
  const mode = modes[0]!;
  assert.notEqual(transcript(t, mode, () => seed(true)), transcript(t, mode, () => seed()));
});
