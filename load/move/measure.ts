import { request, createMessage, head, moveChain, verifyMove, type Seeded } from './fixture.ts';
import { samples, type Outcome } from './metrics.ts';
import type { Measurement } from './judge.ts';
import type { Plan, Step } from './plan.ts';
import { sampler, sleep, snapshot, walWindow, type Stack } from '../slice5/stack.ts';
import { watchedRelationsSQL } from '../slice5/fixture.ts';

// startSampling marks the measurement boundary (#769): everything before it is setup.
async function nodeWindow<T>(stack: Stack, seeded: Seeded, p: Plan, startSampling: () => void, work: () => Promise<T>) {
  startSampling();
  const from = Date.now();
  const resources = sampler(stack, () => undefined, false);
  const reader = samples(), pending = new Set<Promise<void>>();
  const interval = 1000 / p.readerRate;
  let next = from, dropped = 0, readerTarget = 0;
  let timer: ReturnType<typeof setTimeout>;
  const tick = () => {
    const now = Date.now();
    // Preserve the absolute schedule when a DB check delays Node's event loop.
    const skipped = Math.max(0, Math.floor((now - next) / interval));
    dropped += skipped;
    readerTarget += skipped + 1;
    next += (skipped + 1) * interval;
    const { data } = seeded;
    const r = request(stack, `/api/v1/orgs/${data.otherOrganization}/channels`, data.reader, 200)
      .then(result => { reader.add(result); pending.delete(r); });
    pending.add(r);
    timer = setTimeout(tick, Math.max(0, next - Date.now()));
  };
  tick();
  try {
    const result = await work();
    // Short windows still capture at least one in-window resource sample.
    await sleep(Math.max(0, from + 1100 - Date.now()));
    const to = Date.now();
    clearTimeout(timer!);
    await Promise.all(pending);
    await resources.stop();
    const observed = resources.window(from, to);
    return { result, reader: reader.summarize(dropped), readerTarget, ...observed, samples: resources.samples };
  } finally {
    clearTimeout(timer!);
    await resources.stop();
    await Promise.all(pending);
  }
}

export async function latency(stack: Stack, seeded: Seeded, p: Plan, signal: AbortSignal, startSampling: () => void) {
  const { data } = seeded;
  const moves = samples();
  const verification: { operation: string; before: number; after: number; expectedVersion: number;
    ms: number; outcome: Outcome; ackMatches: boolean; committed: boolean }[] = [];
  const work = await nodeWindow(stack, seeded, p, startSampling, async () => {
    let position = head(stack, data), version = data.chain.version;
    let destination = 1;
    for (let i = 0; i < p.moves; i++) {
      signal.throwIfAborted();
      const topic = data.chain.topics[destination];
      const r = await moveChain(stack, data, version, topic);
      moves.add(r);
      const committed = verifyMove(stack, data, position, r.input.operation_id, topic);
      const after = head(stack, data);
      verification.push({ operation: r.input.operation_id, before: position, after, expectedVersion: version,
        ms: r.ms, outcome: r.outcome, ackMatches: r.valid, committed });
      if (r.valid && r.value) {
        version = r.value.chain_version;
        destination = 1 - destination;
      }
      position = after;
    }
    return verification.every(r => r.committed && r.ackMatches);
  });
  const measurement: Measurement = {
    lanes: { move: moves.summarize(), reader: work.reader },
    evidence: work.evidence, readerTarget: work.readerTarget, moveVerified: work.result,
  };
  return { measurement, verification, cpu: work.cpu, samples: work.samples };
}

function rowCounts(stack: Stack, seeded: Seeded) {
  const { organization, chain } = seeded.data;
  const tables = ['messages', 'topics', 'message_mentions', 'channel_log', 'operation_receipts'] as const;
  return JSON.parse(stack.sql(`SELECT json_build_object(${tables.map(table => `'${table}', (SELECT count(*) FROM ${table}
    WHERE organization_id = '${organization}' AND channel_id = '${chain.channel}')`).join(',')});`)) as Record<typeof tables[number], number>;
}

export async function storage(stack: Stack, seeded: Seeded, p: Plan, step: Step, signal: AbortSignal, startSampling: () => void) {
  const { data, tokens } = seeded, active = step.arm === 'move';
  const writes = samples();
  const watched: number[] = JSON.parse(stack.sql(watchedRelationsSQL));
  const initialRows = rowCounts(stack, seeded);
  const before = snapshot(stack, watched);
  const work = await nodeWindow(stack, seeded, p, startSampling, async () => {
    let version = data.chain.version;
    let verified = true;
    for (let i = 0; i < p.moves; i++) {
      signal.throwIfAborted();
      if (active) {
        const r = await moveChain(stack, data, version, data.chain.topics[(i + 1) % 2]);
        writes.add(r);
        verified &&= r.valid;
        if (r.valid && r.value) version = r.value.chain_version;
      } else {
        const r = await createMessage(stack, data, tokens[i % (tokens.length - 2)], data.mentionBody, 'source');
        writes.add(r);
      }
    }
    return { after: snapshot(stack, watched), verified };
  });
  const finalRows = rowCounts(stack, seeded);
  const delta = Object.fromEntries(Object.entries(initialRows).map(([table, count]) => [table, finalRows[table as keyof typeof finalRows] - count]));
  const wal = walWindow(stack, before, work.result.after);
  const lane = writes.summarize();
  const measurement: Measurement = {
    lanes: { [active ? 'move' : 'create']: lane, reader: work.reader },
    evidence: work.evidence, readerTarget: work.readerTarget,
    moveVerified: active ? work.result.verified && delta.channel_log === lane.accepted && delta.operation_receipts === lane.accepted : undefined,
    wal: { ...wal, messagesDelta: delta.messages },
  };
  return { measurement, cpu: work.cpu, samples: work.samples, before, after: work.result.after,
    rowDelta: delta, walBytesPerOperation: lane.accepted > 0 ? wal.lsnBytes / lane.accepted : null,
    walBytesPerMessage: lane.accepted > 0 ? wal.lsnBytes / (lane.accepted * (active ? step.size : 1)) : null };
}
