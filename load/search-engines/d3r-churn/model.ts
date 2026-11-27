import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import type { Sql } from '../d3r/engine.ts';
import { withSession } from '../d3r/session.ts';
import { literal } from '../seed.ts';
import { db, full, modelLabel } from './design.ts';

type Target = {kind: 'Edit' | 'Delete'; organization: string; message: string};
const id = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;

export async function planModel(sql: Sql) {
  await sql('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;');
  const population = Number(await sql('SELECT count(*) FROM public.messages WHERE NOT deleted;'));
  assert.ok(Number.isSafeInteger(population) && population > 0, 'Invalid MODEL population');
  const edit = Math.floor(population * full.editPercent / 100);
  const remove = Math.floor(population * full.deletePercent / 100);
  // Select unique rows from one stable ordering. Shuffle the interleaving with a different salt.
  const raw = await sql(`WITH picked AS MATERIALIZED (
    SELECT organization_id, id, md5(concat_ws('/', ${full.seed}, 'target', organization_id, id)) COLLATE "C" AS draw
    FROM public.messages WHERE NOT deleted
    ORDER BY draw, organization_id, id LIMIT ${edit + remove}
  ), assigned AS (
    SELECT organization_id, id, CASE WHEN row_number() OVER (ORDER BY draw, organization_id, id) <= ${edit}
      THEN 'Edit' ELSE 'Delete' END AS kind
    FROM picked
  )
  SELECT kind, organization_id, id FROM assigned
  ORDER BY md5(concat_ws('/', ${full.seed}, 'interleave', organization_id, id)) COLLATE "C", organization_id, id;`);
  await sql('COMMIT;');
  const targets: Target[] = raw.split('\n').map(line => {
    const [kind, organization, message] = line.split('|');
    assert.ok((kind === 'Edit' || kind === 'Delete') && id.test(organization) && id.test(message), 'Invalid MODEL target');
    return {kind, organization, message};
  });
  assert.equal(targets.filter(row => row.kind === 'Edit').length, edit, 'Missing Edit MODEL targets');
  assert.equal(targets.filter(row => row.kind === 'Delete').length, remove, 'Missing Delete MODEL targets');
  assert.equal(new Set(targets.map(t => `${t.organization}/${t.message}`)).size, targets.length, 'Repeated MODEL target');
  assert.ok(targets.length <= full.rate * full.modelSeconds, 'MODEL exceeds its rate cap');
  return {label: modelLabel, seed: full.seed, population, planned: {edit, delete: remove, total: edit + remove}, targets};
}
export type ModelPlan = Omit<Awaited<ReturnType<typeof planModel>>, 'targets'>;

function modelSql(target: Target, body: string) {
  const edit = target.kind === 'Edit';
  const value = literal(body);
  const org = literal(target.organization);
  const key = `organization_id = ${org} AND id = ${literal(target.message)}`;
  return `BEGIN;
SELECT set_config('fukulow.organization_id', ${org}, true);
UPDATE public.messages SET ${edit
    ? `body = CASE WHEN body = ${value} THEN ${value} || ' [edit model]' ELSE ${value} END`
    : "body = '', deleted = true"} WHERE ${key} AND NOT deleted RETURNING id;
DELETE FROM public.message_search_terms WHERE organization_id = ${org} AND message_id = ${literal(target.message)};
${edit ? `INSERT INTO public.message_search_terms (organization_id, channel_id, term, created_at, message_id)
SELECT m.organization_id, m.channel_id, t.term, m.created_at, m.id
FROM public.messages m CROSS JOIN LATERAL public.fukulow_search_terms(m.body) AS t(term)
WHERE ${key} AND NOT m.deleted;` : ''}
COMMIT;`;
}

export function plannedSlot(index: number, operations: number) {
  return Math.floor(index * (full.rate * full.modelSeconds) / operations);
}

async function sessions<T>(container: string, count: number, work: (sql: Sql[]) => Promise<T>,
  open: Sql[] = []): Promise<T> {
  if (open.length === count) return work(open);
  return withSession(container, db, true, async sql => {
    assert.equal(await sql('SELECT 1;'), '1');
    return sessions(container, count, work, [...open, sql]);
  });
}

export async function runModel(container: string, targets: Target[], bodies: string[], smoke: boolean,
  runWindow: (work: (start: number, signal: AbortSignal) => Promise<void>) => Promise<void>) {
  const achieved = {edit: 0, delete: 0, total: 0};
  await sessions(container, smoke ? 1 : full.modelSessions, async connections => {
    await runWindow(async (start, signal) => {
      const available = [...connections];
      const active = new Set<Promise<void>>();
      const errors: unknown[] = [];
      let previousSlot = -1;
      const slotMs = 1000 / full.rate;
      try {
        for (const [index, target] of targets.entries()) {
          signal.throwIfAborted();
          if (errors.length) throw errors[0];
          if (!available.length) await Promise.race(active);
          if (errors.length) throw errors[0];
          if (!smoke) {
            const slot = Math.max(previousSlot + 1, plannedSlot(index, targets.length));
            const wait = start + slot * slotMs - performance.now();
            if (wait > 0) await delay(Math.ceil(wait), undefined, {signal});
            previousSlot = Math.max(slot, Math.floor((performance.now() - start) / slotMs));
            if (previousSlot >= full.modelSeconds * full.rate) break;
          }
          const sql = available.pop()!;
          const task = (async () => {
            const result = await sql(modelSql(target, bodies[index % bodies.length]));
            assert.equal(result, `${target.organization}\n${target.message}`, 'MODEL did not update its selected Message');
            achieved[target.kind === 'Edit' ? 'edit' : 'delete']++;
            achieved.total++;
          })().catch(error => { errors.push(error); }).finally(() => {
            active.delete(task);
            available.push(sql);
          });
          active.add(task);
        }
      } finally {
        await Promise.all(active);
      }
      if (errors.length) throw errors[0];
      if (!smoke) await delay(Math.max(1, start + full.modelSeconds * 1000 - performance.now()), undefined, {signal});
    });
  });
  return {label: modelLabel, achieved, achievedPerSecond: smoke ? null : achieved.total / full.modelSeconds};
}
