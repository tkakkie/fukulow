import assert from 'node:assert/strict';
import { execute, prepare } from '../d3r/engine.ts';
import { begin, firstPosition, genericPlan, normalization, scopeContext, scopeSql, searchTimeout } from '../d3r/path.ts';
import { org } from '../seed.ts';
import { hit, visible } from './arms.ts';
import type { SyncSql } from './fixture.ts';
import { planFacts } from './plan.ts';

export function checkPage(app: SyncSql, page: string, raw: string) {
  const result = app(`${begin}
${scopeContext(1)}
${searchTimeout}
${genericPlan}
SELECT json_build_array(scopes, current_member, to_json(normalized))
FROM (${scopeSql([1, 2])}) s CROSS JOIN (${normalization(raw)}) q;
COMMIT;`);
  const [scopes, active, normalized]: [string[], boolean, string] = JSON.parse(result.split('\n').at(-1)!);
  assert.equal(active, true);
  assert.equal(normalized, raw);
  assert.deepEqual([...scopes].sort(), visible);
  const tx = {scopes, words: [raw], probe: raw.slice(0, 3), organization: org(1), rejection: null};
  const visiblePage = app(`${begin}
${scopeContext(1)}
${searchTimeout}
${genericPlan}
${prepare(page)}
${execute(tx, firstPosition)}
COMMIT;`).split('\n').slice(1);
  assert.equal(visiblePage.length, 1, 'Production page must return exactly one row');
  assert.equal(visiblePage[0].split('|')[0], hit, 'Production page must return exactly the fixture hit');
  return {tx, visiblePage: visiblePage[0]};
}

export class PlanIdentityError extends Error {}

export function capturePlan(app: SyncSql, page: string, tx: ReturnType<typeof checkPage>['tx']) {
  const result = app(`${begin}
${scopeContext(1)}
${searchTimeout}
${genericPlan}
${prepare(page)}
${execute(tx, firstPosition, true)}
SELECT json_build_array(generic_plans, custom_plans, current_setting('transaction_isolation'),
  current_setting('transaction_read_only'), current_setting('statement_timeout'), current_setting('plan_cache_mode'))
FROM pg_prepared_statements WHERE name = 'd3r_page';
COMMIT;`);
  const lines = result.split('\n');
  const state = JSON.parse(lines.pop()!);
  if (JSON.stringify(state) !== JSON.stringify([1, 0, 'repeatable read', 'on', '2s', 'force_generic_plan'])) {
    throw new PlanIdentityError('Unexpected EXPLAIN session settings');
  }
  const explain = JSON.parse(lines.slice(1).join('\n'));
  return {explain, state, ...planFacts(explain)};
}
