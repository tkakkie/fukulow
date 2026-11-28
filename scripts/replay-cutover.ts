import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { setTimeout } from 'node:timers/promises';
import { createLog } from '../load/channel-log.ts';
import { prefillSQL, settleSQL } from '../load/slice5/fixture.ts';
import { psql, run } from './compose-harness.ts';
import { postgresImageFromCompose } from './restore-drill.ts';

const directory = new URL('../server/migrations/', import.meta.url);
const cutover = '202611260620_create_from_messages.sql';
const sql = readFileSync(new URL(cutover, directory), 'utf8');
const phases = [...sql.matchAll(/^-- phase: ([a-z_]+)\n([\s\S]*?)(?=^-- phase: |(?![\s\S]))/gm)];
const validation = phases.find(match => match[1] === 'validate')?.[2];
if (!validation || phases.map(match => match[1]).join() !== 'lock,validate,copy,index_and_constraints,swap_and_protect') {
  throw new Error('Unexpected #620 cutover phases');
}

const preflight = `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL row_security = off;
SET LOCAL statement_timeout = 0;
SET LOCAL transaction_timeout = 0;
SET LOCAL lock_timeout = '5s';
${validation}
COMMIT;`;

const verify = `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL row_security = off;
SET LOCAL statement_timeout = 0;
SET LOCAL transaction_timeout = 0;
SET LOCAL lock_timeout = '5s';
DO $$
BEGIN
    IF EXISTS (
        SELECT FROM (
            SELECT organization_id, channel_id, count(*) AS positions,
                count(DISTINCT position) AS distinct_positions, max(position) AS tail
            FROM (
                SELECT organization_id, channel_id, seq AS position FROM public.messages
                UNION ALL
                SELECT organization_id, channel_id, event_seq FROM public.channel_log
            ) events GROUP BY organization_id, channel_id
        ) e FULL JOIN public.channel_message_sequences s USING (organization_id, channel_id)
        WHERE e.positions IS DISTINCT FROM s.seq OR e.distinct_positions IS DISTINCT FROM s.seq
            OR e.tail IS DISTINCT FROM s.seq
    ) THEN
        RAISE EXCEPTION 'Replay positions do not cover the committed watermark';
    END IF;
    IF to_regprocedure('public.fukulow_message_creation_fixed()') IS NULL
        OR to_regclass('public.channel_log_pkey') IS NULL
        OR to_regprocedure('public.message_counts_deleted()') IS NOT NULL
        OR EXISTS (SELECT FROM public.channel_log WHERE kind <> 'move')
        OR EXISTS (SELECT FROM unnest(ARRAY['public.messages', 'public.channel_log']) t
            WHERE NOT has_table_privilege('fukulow_app', t, 'SELECT')
               OR NOT has_table_privilege('fukulow_app', t, 'INSERT'))
        OR has_table_privilege('fukulow_app', 'public.messages', 'DELETE,TRUNCATE')
        OR has_table_privilege('fukulow_app', 'public.channel_log', 'UPDATE,DELETE,TRUNCATE')
        OR EXISTS (SELECT FROM unnest(ARRAY['organization_id','channel_id','seq','id','sender','client_message_id','send_digest']) c
            WHERE has_column_privilege('fukulow_app', 'public.messages', c, 'UPDATE'))
    THEN
        RAISE EXCEPTION 'Replay cutover schema or grants are incomplete';
    END IF;
END $$;
COMMIT;`;

function timedStatements(name: string, statements: string) {
  return `SELECT clock_timestamp() AS phase_start \\gset
${statements}
SELECT '${name}', round(extract(epoch FROM clock_timestamp()-:'phase_start'::timestamptz)*1000, 3);`;
}

function scale(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error('Expected a positive integer');
  return Number(value);
}

async function rehearse(channelCount: number, perChannel: number, members: number) {
  if (channelCount * perChannel >= 2 ** 31 || members > 2 ** 31 - 1) throw new Error('Fixture exceeds the SQL integer range');
  const name = `fukulow-620-rehearsal-${randomUUID()}`;
  const exec = ['exec', '-i', name];
  // Successful commands keep forwarding psql and Docker notices to stderr.
  const forwardSuccessfulStderr = ({ stdout, stderr }: ReturnType<typeof run>) => {
    if (stderr) process.stderr.write(stderr);
    return stdout;
  };
  const query = (input: string) => forwardSuccessfulStderr(psql(exec, ['-qAt', '-U', 'postgres'], { input })).trim();
  const timed = (stage: string, action: () => unknown) => {
    const start = performance.now();
    const result = action();
    console.log(`${stage}|${(performance.now() - start).toFixed(3)}`);
    return result;
  };

  forwardSuccessfulStderr(run('docker', ['run', '-d', '--name', name, '--network', 'none',
    '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', postgresImageFromCompose()]));
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        run('docker', [...exec, 'pg_isready', '-q', '-h', '127.0.0.1', '-U', 'postgres'], { captureOutput: false });
        break;
      } catch {
        if (attempt === 119) throw new Error('Disposable PostgreSQL did not become ready');
      }
      await setTimeout(250);
    }

    const initial = readdirSync(directory).filter(file => file.endsWith('.sql') && file < cutover).sort()
      .map(file => `BEGIN;\n${readFileSync(new URL(file, directory), 'utf8')}\nCOMMIT;`).join('\n');
    timed('old_schema', () => query(`${initial}\nCREATE ROLE fukulow_app NOLOGIN;`));

    const org = randomUUID();
    const channels = Array.from({ length: channelCount }, () => randomUUID());
    timed('fixture', () => query(fixtureSQL(org, channels, perChannel, members)));
    timed('backup', () => forwardSuccessfulStderr(run('docker', [...exec, 'pg_dump', '-U', 'postgres',
      '-Fc', '-f', '/tmp/pre-upgrade.dump', 'postgres'])));
    timed('standalone_validation', () => query(preflight));

    const statements = phases.map(([, phase, statement]) => timedStatements(phase, statement));
    // Rehearsal stdout includes the successful psql phase timings for operators.
    console.log(query(`BEGIN;\nSET LOCAL lock_timeout = '5s';\n${statements.join('\n')}\n${timedStatements('commit', 'COMMIT;')}`));
    timed('postcutover_validation', () => query(verify));
    const counts = query('SELECT (SELECT count(*) FROM messages), (SELECT count(*) FROM channel_log);');
    if (counts !== `${channelCount * perChannel}|${channelCount}`) throw new Error('Unexpected postcutover counts');
    console.log(`PASS |${channelCount} Channels|${members} Members|${counts} (Messages|mutations). Timings in ms.`);
  } finally {
    forwardSuccessfulStderr(run('docker', ['rm', '-fv', name]));
  }
}

function fixtureSQL(org: string, channels: string[], perChannel: number, members: number) {
  return `
INSERT INTO organizations (organization_id, name) VALUES ('${org}', 'Rehearsal');
INSERT INTO accounts (id, email, password_hash)
SELECT md5('rehearsal/account/' || n)::uuid, 'member-' || n || '@rehearsal.invalid', 'unused'
FROM generate_series(0,${members - 1}) n;
INSERT INTO users (organization_id, id, account_id, name, role)
SELECT '${org}', md5('rehearsal/member/' || n)::uuid, md5('rehearsal/account/' || n)::uuid, 'Member ' || n,
    CASE WHEN n=0 THEN 'owner' ELSE 'member' END FROM generate_series(0,${members - 1}) n;
INSERT INTO channels (organization_id, id, name, visibility)
SELECT '${org}', id, 'Channel ' || n, 'public'
FROM unnest(ARRAY[${channels.map(channel => `'${channel}'::uuid`).join(',')}]) WITH ORDINALITY AS t(id,n);
${prefillSQL(org, channels, channels.map(() => perChannel), { members, perChannel })}
${createLog(org, channels)}
BEGIN;
INSERT INTO topics (organization_id, channel_id, id, name, first_seq, last_seq, message_count)
SELECT organization_id, channel_id, gen_random_uuid(), 'Moved', 1, 1, 1
FROM messages WHERE organization_id='${org}' AND seq=1;
UPDATE messages m SET version=${perChannel + 1}, topic_id=t.id FROM topics t
WHERE m.organization_id='${org}' AND t.organization_id=m.organization_id AND t.channel_id=m.channel_id AND m.seq=1;
INSERT INTO channel_log (organization_id, channel_id, event_seq, kind, message_id, sender, operation_id, destination_topic_id)
SELECT organization_id, channel_id, version, 'move', id, sender, gen_random_uuid(), topic_id
FROM messages WHERE organization_id='${org}' AND seq=1;
UPDATE channel_message_sequences SET seq=seq+1, mutation_seq=seq+1 WHERE organization_id='${org}';
COMMIT;
${settleSQL}`;
}

const [, , command, channels, messages, members, ...extra] = process.argv;
if (command === 'validate-sql' && channels === undefined) console.log(preflight);
else if (command === 'verify-sql' && channels === undefined) console.log(verify);
else if (command === 'rehearse' && extra.length === 0) await rehearse(scale(channels, 4), scale(messages, 250), scale(members, 24));
else throw new Error('Usage: node scripts/replay-cutover.ts validate-sql | verify-sql | rehearse [channels [messages-per-channel [members]]]');
