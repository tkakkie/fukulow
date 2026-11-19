import { randomUUID } from 'node:crypto';
import type { Message, MoveChainRequest, MoveChainResponse, SendMessageRequest } from '../../web/src/api-schema.d.ts';
import { createLog } from '../channel-log.ts';
import { autovacuumSQL, settleSQL } from '../slice5/fixture.ts';
import { seed, type Stack } from '../slice5/stack.ts';
import { tombstones, type Plan, type Step } from './plan.ts';
import type { Outcome } from './metrics.ts';
import { moveAcknowledged } from './wire.ts';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const checked = (id: string) => {
  if (!uuidPattern.test(id)) throw new Error('Unexpected fixture UUID');
  return id;
};
export const shortBody = 'Load test message';
export type Chain = { channel: string; root: string; topics: [string, string]; size: number; version: number };
export type Replay = { after: number; through: number; lastKind: 'move' | 'create' };
export type Fixture = {
  organization: string;
  otherOrganization: string;
  reader: string;
  owner: string;
  channels: string[];
  generation: string;
  chain: Chain;
  mentionBody: string;
  replay?: Replay;
};
export type Seeded = { data: Fixture; tokens: string[] };

export async function buildFixture(stack: Stack, p: Plan, step: Step): Promise<Seeded> {
  // The reader Account has a different Member identity in each Organization.
  const seeded = await seed(stack, { members: p.members - 2, channels: p.channels });
  const org = checked(seeded.organization), otherOrganization = checked(seeded.otherOrganization);
  const channels = seeded.channels.map(checked);
  const reader = checked(stack.sql(`INSERT INTO users (organization_id, id, account_id, name, role)
    SELECT '${org}', gen_random_uuid(), account_id, 'Reader', 'member' FROM users
    WHERE organization_id = '${otherOrganization}' AND name = 'Reader' RETURNING id;`).split('\n')[0]);
  const sender = checked(stack.sql(`SELECT id FROM users WHERE organization_id = '${org}' AND name = 'Load Owner'`));
  const generation = checked(stack.sql(`SELECT history_generation FROM organizations WHERE organization_id = '${org}'`));
  const mentionBody = `${shortBody} @{member:${reader}}`;
  const background = (size: number) => step.part === 'D' && step.size === size ? p.backgroundTopics : 0;
  const chains: Chain[] = p.sizes.map((size, index) => ({
    size, channel: channels[index], root: randomUUID(), topics: [randomUUID(), randomUUID()], version: background(size) + size + 2,
  }));

  stack.sql(autovacuumSQL);
  stack.sql(`BEGIN;
    ${chains.map(chain => seedChain(org, sender, reader, mentionBody, chain, background(chain.size))).join('\n')}
    ${createLog(org, chains.map(chain => chain.channel))}
    COMMIT;`);
  const chain = chains.find(c => c.size === step.size)!;
  const data: Fixture = { organization: org, otherOrganization, reader: seeded.reader, owner: seeded.owner,
    channels, chain, generation, mentionBody };
  const tokens = [...seeded.tokens, seeded.owner, seeded.reader];
  if (step.part === 'E') await buildReplay(stack, { data, tokens }, p.replayPage, step.arm === 'move');
  stack.sql(settleSQL);
  return { data, tokens };
}

function seedChain(org: string, sender: string, reader: string, body: string, c: Chain, background: number) {
  const [source, destination] = c.topics;
  // Older background Topics fill the page while both Move Topics stay visible.
  const sourceStart = background + 1, destinationStart = background + 2;
  const sourceLast = c.version - Number(c.size % 100 === 0);
  return `
    INSERT INTO topics (organization_id, channel_id, id, name, first_seq, last_seq, message_count) VALUES
      ('${org}', '${c.channel}', '${source}', 'source', ${sourceStart}, ${sourceLast}, ${1 + c.size - tombstones(c.size)}),
      ('${org}', '${c.channel}', '${destination}', 'destination', ${destinationStart}, ${destinationStart}, 1);
    INSERT INTO messages (organization_id, channel_id, id, sender, client_message_id, body, seq, topic_id)
    VALUES ('${org}', '${c.channel}', gen_random_uuid(), '${sender}', gen_random_uuid(), '${shortBody}', ${sourceStart}, '${source}'),
           ('${org}', '${c.channel}', gen_random_uuid(), '${sender}', gen_random_uuid(), '${shortBody}', ${destinationStart}, '${destination}');
    WITH chain AS (
      INSERT INTO messages (organization_id, channel_id, id, sender, client_message_id, body, seq, topic_id, reply_to_id, reply_root_id, deleted)
      SELECT '${org}', '${c.channel}', CASE WHEN n = 1 THEN '${c.root}'::uuid ELSE gen_random_uuid() END, '${sender}',
        gen_random_uuid(), '${body}', n + ${destinationStart}, '${source}', parent, parent, n % 100 = 0
      FROM generate_series(1, ${c.size}) n CROSS JOIN LATERAL (
        SELECT CASE WHEN n > 1 THEN '${c.root}'::uuid END AS parent
      ) p RETURNING id
    )
    INSERT INTO message_mentions (organization_id, channel_id, message_id, member_id)
    SELECT '${org}', '${c.channel}', id, '${reader}' FROM chain;
    WITH background AS (
      INSERT INTO topics (organization_id, channel_id, id, name, first_seq, last_seq, message_count)
      SELECT '${org}', '${c.channel}', gen_random_uuid(), 'background-' || n, n, n, 1
      FROM generate_series(1, ${background}) n RETURNING id, first_seq
    )
    INSERT INTO messages (organization_id, channel_id, id, sender, client_message_id, body, seq, topic_id)
    SELECT '${org}', '${c.channel}', gen_random_uuid(), '${sender}', gen_random_uuid(), '${shortBody}', first_seq, id FROM background;
    INSERT INTO channel_message_sequences (organization_id, channel_id, seq)
    VALUES ('${org}', '${c.channel}', ${c.version});`;
}

export const channelPath = (data: Fixture) => `/api/v1/orgs/${data.organization}/channels/${data.chain.channel}`;

export async function request<T>(stack: Stack, path: string, token: string, status: number, body?: unknown) {
  const start = performance.now();
  try {
    const response = await fetch(stack.base + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'manual',
      signal: AbortSignal.timeout(10_000),
    });
    const bytes = await response.text();
    const ms = performance.now() - start;
    const outcome: Outcome = response.status === status ? 'accepted' : response.status === 429 ? 'rejected429'
      : response.status === 503 ? 'rejected503' : 'otherErrors';
    return { outcome, ms, value: outcome === 'accepted' ? JSON.parse(bytes) as T : undefined };
  } catch (error) {
    const outcome: Outcome = error instanceof Error && error.name === 'TimeoutError' ? 'clientTimeouts'
      : error instanceof SyntaxError ? 'otherErrors' : 'transportErrors';
    return { outcome, ms: performance.now() - start, value: undefined };
  }
}

export function createMessage(stack: Stack, data: Fixture, token: string, body = shortBody, topicName?: string) {
  const input: SendMessageRequest = { client_message_id: randomUUID(), body, topic_name: topicName };
  return request<Message>(stack, channelPath(data) + '/messages', token, 201, input);
}

export async function moveChain(stack: Stack, data: Fixture, version: number, topic: string) {
  const input: MoveChainRequest = { operation_id: randomUUID(), expected_version: version,
    history_generation: data.generation, topic_id: topic };
  const r = await request<MoveChainResponse>(stack, channelPath(data) + `/messages/${data.chain.root}/move`, data.owner, 200, input);
  return { ...r, input, valid: moveAcknowledged(r.value, input.operation_id, data.chain.root, topic, version, data.generation) };
}

export function head(stack: Stack, data: Fixture) {
  return Number(stack.sql(`SELECT seq FROM channel_message_sequences
    WHERE organization_id = '${data.organization}' AND channel_id = '${data.chain.channel}';`));
}

export function verifyMove(stack: Stack, data: Fixture, before: number, event: string, destination: string) {
  const { chain: c, organization: org } = data;
  return stack.sql(`SELECT (
    (SELECT seq FROM channel_message_sequences WHERE organization_id = '${org}' AND channel_id = '${c.channel}') = ${before + 1}
    AND (SELECT count(*) = 1 AND bool_and(event_seq = ${before + 1} AND kind = 'move' AND operation_id = '${event}'
      AND message_id = '${c.root}' AND destination_topic_id = '${destination}')
      FROM channel_log WHERE organization_id = '${org}' AND channel_id = '${c.channel}' AND event_seq > ${before})
    AND (SELECT count(*) = ${c.size} AND bool_and(version = ${before + 1} AND topic_id = '${destination}'
      AND seq BETWEEN ${c.version - c.size + 1} AND ${c.version})
      AND count(*) FILTER (WHERE deleted) = ${tombstones(c.size)}
      FROM messages WHERE organization_id = '${org}' AND channel_id = '${c.channel}'
      AND (id = '${c.root}' OR reply_root_id = '${c.root}'))
  )::int;`) === '1';
}

export function committedMoves(stack: Stack, data: Fixture, after: number) {
  return Number(stack.sql(`SELECT count(*) FROM channel_log WHERE organization_id = '${data.organization}'
    AND channel_id = '${data.chain.channel}' AND event_seq > ${after} AND kind = 'move' AND message_id = '${data.chain.root}';`));
}

async function buildReplay(stack: Stack, seeded: Seeded, count: number, move: boolean) {
  const { data, tokens } = seeded;
  const after = head(stack, data);
  const creates = count - Number(move);
  for (let n = 0; n < creates; n++) {
    const r = await createMessage(stack, data, tokens[n % tokens.length]);
    if (r.value?.created_seq !== after + n + 1) throw new Error('Replay fixture Create failed');
  }
  if (move) {
    const r = await moveChain(stack, data, data.chain.version, data.chain.topics[1]);
    if (!r.valid || r.value?.move_seq !== after + count) throw new Error('Replay fixture Move failed');
  }
  const through = head(stack, data);
  if (through !== after + count || committedMoves(stack, data, after) !== Number(move))
    throw new Error('Replay fixture log density differs');
  data.replay = { after, through, lastKind: move ? 'move' : 'create' };
}
