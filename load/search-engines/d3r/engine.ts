import assert from 'node:assert/strict';
import { literal, org } from '../seed.ts';
import {
  begin, firstPosition, genericPlan, normalization, pageSize, scopeContext, scopeSql,
  searchTimeout, shortError, term, tokens, type Actor, type Context, type Position, type Row,
} from './path.ts';

export type Sql = (text: string) => Promise<string>;
const preparedName = 'd3r_page';
export const prepare = (page: string) =>
  `PREPARE ${preparedName}(uuid, uuid[], text, text[], text, uuid, bigint) AS ${page};`;
const explainPrefix = 'EXPLAIN (ANALYZE, BUFFERS, SETTINGS, VERBOSE, FORMAT JSON)';

export async function transaction(sql: Sql, actor: Actor, raw: string,
  {context = actor[0], forced = false}: {context?: Context; forced?: boolean} = {}) {
  const result = await sql(`${begin}
${scopeContext(context)}
${searchTimeout}
${forced ? 'SET LOCAL enable_seqscan = off;' : ''}
SELECT json_build_array(scopes, current_member) FROM (${scopeSql(actor)}) scope;
${genericPlan}
SELECT to_json(normalized) FROM (${normalization(raw)}) q;`);
  const [scope, query] = result.split('\n').slice(-2);
  const [scopes, current]: [string[], boolean] = JSON.parse(scope);
  const words = tokens(JSON.parse(query));
  const probe = term(words);
  return {scopes, words, probe, organization: org(actor[0]), rejection: !current
    ? 'organization_unavailable' : probe === null ? shortError : null};
}

type Transaction = Awaited<ReturnType<typeof transaction>>;
export function execute(tx: Transaction, [at, id]: Position, explain = false) {
  assert.ok(!tx.rejection && tx.probe !== null && tx.scopes.length);
  const params = [literal(tx.organization), literal(`{${tx.scopes.join(',')}}`), literal(tx.probe),
    `ARRAY[${tx.words.map(literal).join(',')}]::text[]`, literal(at), literal(id), pageSize];
  return `${explain ? explainPrefix + ' ' : ''}EXECUTE ${preparedName}(${params.join(', ')});`;
}

async function finishPage(sql: Sql, tx: Transaction, position: Position) {
  const page = !tx.rejection && tx.scopes.length ? await sql(execute(tx, position)) : '';
  await sql('COMMIT;');
  const rows = page ? page.split('\n').map(line => line.split('|') as Row) : [];
  return {rows, rejection: tx.rejection};
}

export async function allPages(sql: Sql, actor: Actor, raw: string,
  options: {context?: Context; forced?: boolean} = {}, firstPageOnly = false) {
  let position: Position = firstPosition;
  const ids: string[] = [];
  const seen = new Set<string>();
  for (;;) {
    const tx = await transaction(sql, actor, raw, options);
    const {rows, rejection} = await finishPage(sql, tx, position);
    if (rejection) {
      return {ids, rejection, paginationError: ids.length ? 'Search rejected a continuation' : undefined};
    }
    if (rows.length > pageSize + 1) return {ids, rejection, paginationError: 'Search exceeded its page limit'};
    for (const [id, at] of rows.slice(0, pageSize)) {
      if (seen.has(id) || !(at < position[0] || (at === position[0] && id < position[1]))) {
        return {ids, rejection, paginationError: 'Search repeated a Message or moved its cursor backwards'};
      }
      seen.add(id);
      ids.push(id);
      position = [at, id];
    }
    if (rows.length <= pageSize || firstPageOnly) return {ids, rejection: null, paginationError: undefined};
  }
}

type Plan = {
  'Node Type': string;
  'Relation Name'?: string;
  'Index Name'?: string;
  'Actual Loops': number;
  Plans?: Plan[];
};

export function planFacts(explain: [{Plan: Plan; 'Execution Time': number}]) {
  const flatten = (node: Plan): Plan[] => [node, ...(node.Plans ?? []).flatMap(flatten)];
  const nodes = flatten(explain[0].Plan);
  assert.ok(Number.isFinite(explain[0]['Execution Time']));
  return {
    executionMs: explain[0]['Execution Time'],
    searchIndex: nodes.some(node => node['Index Name'] === 'message_search_terms_lookup' && node['Actual Loops'] > 0),
    seqScanMessages: nodes.some(node => node['Node Type'] === 'Seq Scan' && node['Relation Name'] === 'messages'),
  };
}

export async function explainPage(sql: Sql, raw: string, actor: Actor = [1, 2], forced = false) {
  const tx = await transaction(sql, actor, raw, {forced});
  const explain = JSON.parse(await sql(execute(tx, firstPosition, true)));
  await sql('COMMIT;');
  return {explain, ...planFacts(explain)};
}
