import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { hash } from '../manifest.ts';
import { literal, member, org, trimQuery } from '../seed.ts';

export const sources = {
  engine: 'server/src/messages/search/d3r.rs',
  page: 'server/src/messages/search/page.sql',
  search: 'server/src/messages/search.rs',
  channels: 'server/src/channels.rs',
  auth: 'server/src/auth.rs',
  authorization: 'server/src/auth/authorization.rs',
  context: 'server/src/database/context.rs',
} as const;
const root = new URL('../../../', import.meta.url);
export const readSource = (path: string) => readFileSync(new URL(path, root), 'utf8');
function required(pattern: RegExp, text: string) {
  const value = text.match(pattern)?.[1];
  assert.ok(value, `Production source no longer matches ${pattern.source}`);
  return value;
}
const engineSource = readSource(sources.engine);
const searchSource = readSource(sources.search);
const channelsSource = readSource(sources.channels);
const authSource = readSource(sources.auth);
export const pageSize = Number(required(/const PAGE_SIZE: usize = (\d+);/, searchSource));
export const shortError = 'search_query_too_short';
export const actors = [1, 2, 3, 4, 5, 6] as const;
export const firstPosition = ['infinity', 'ffffffff-ffff-ffff-ffff-ffffffffffff'] as const;
export type Position = readonly [at: string, id: string];
export type Row = [id: string, at: string];
export type Actor = readonly [organization: number, member: number];
export type Context = number | null | '';

export function productionPath() {
  const hashes = Object.fromEntries(Object.values(sources).map(path => [path, hash(readSource(path))]));
  const page = readSource(sources.page).trim().replace(/;$/, '');
  return { hashes, page };
}

export function tokens(normalized: string) {
  return normalized.split(/\p{White_Space}+/u).filter(Boolean);
}

export function term(words: string[]) {
  let longest: string[] = [];
  for (const word of words) {
    const scalars = [...word];
    // Rust Iterator::max_by_key takes the last tied maximum.
    if (scalars.length >= longest.length) longest = scalars;
  }
  return longest.length < 2 ? null : longest.slice(0, 3).join('');
}

const whitespaces = Array.from({length: 0x3001}, (_, i) => String.fromCodePoint(i))
  .filter(char => /\p{White_Space}/u.test(char));
const whitespacePattern = `('[' || ${whitespaces.map(char => `chr(${char.codePointAt(0)})`).join(' || ')} || ']+')`;
export const begin = "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;";
export const genericPlan = required(/sqlx::query\("(SET LOCAL plan_cache_mode = [^"]+)"\)/, engineSource) + ';';
export const searchTimeout = required(/sqlx::query\("(SET LOCAL statement_timeout = [^"]+)"\)/, searchSource) + ';';
const normalizeSql = required(/sqlx::query_scalar\("(SELECT public\.fukulow_search_normalize\(\$1\))"\)/, engineSource);
const activeMembers = required(/const ACTIVE_MEMBERS_SQL: &str = "([^"]+)"/, authSource);
const memberSql = required(/format!\("(\{ACTIVE_MEMBERS_SQL\} AND id = .*?)\{locking\}"\)/, authSource)
  .replace('{ACTIVE_MEMBERS_SQL}', activeMembers);
const visibleSql = required(/fn visible_channel_sql\(\)[\s\S]*?format!\(\s*"([^"]+)"/, channelsSource)
  .replace(/\\\n\s*/g, ' ')
  .replace('{public_roles}', "'owner','admin','member'")
  .replace('{explicit_roles}', "'owner','admin','member','guest'");
const unfilteredScopeSql = required(/fn search_scopes\([\s\S]*?format!\(\s*"([^"]+)"/, channelsSource)
  .replace(/\\\n\s*/g, ' ').replace('{filter_sql}', '').replace('{}', memberSql).replace('{}', visibleSql);

export const scopeContext = (context: Context) => context === null ? ''
  : `SELECT set_config('fukulow.organization_id', ${literal(context === '' ? '' : org(context))}, true);`;

// Same active Membership and shared Channel/DM grant predicate as search_scopes.
// The revision is captured by authentication in production. Fixture Members 5
// and 6 have revision 1 after deactivation; all other fixture Members have 0.
export function scopeSql([o, actor]: Actor, revision = actor === 5 || actor === 6 ? 1 : 0) {
  const scope = unfilteredScopeSql
    .replaceAll('$1', literal(org(o))).replace('$2', literal(member(o, actor))).replace('$3', String(revision));
  return `SELECT COALESCE(array_agg(c.id) FILTER (WHERE c.id IS NOT NULL), '{}') AS scopes,
    count(*) > 0 AS current_member FROM (${scope}) c`;
}

export function normalization(raw: string) {
  return normalizeSql.replace('$1', literal(trimQuery(raw))) + ' AS normalized';
}

// pgbench uses bound psql variables in prepared mode. Its tokenization uses
// the same scalar whitespace set and last-longest tie break as the Rust path.
export function benchmarkScript(page: string, raw: string, expectedAcceptance: boolean) {
  const boundPage = page.replace(/\$([1-7])\b/g, (_, n: string) =>
    [':organization', ':scopes', ':term', ':tokens', ':before_at', ':before_id', ':size::bigint'][Number(n) - 1]);
  return `${begin}
${scopeContext(1)}
${searchTimeout}
SELECT scopes, current_member::int AS current_member, ${literal(trimQuery(raw))} AS raw_query
  FROM (${scopeSql([1, 2])}) scope \\gset
${genericPlan}
WITH normalized AS MATERIALIZED (
  ${normalizeSql.replace('$1', ':raw_query')} AS query
), words AS (
  SELECT token, position
  FROM normalized CROSS JOIN LATERAL regexp_split_to_table(query COLLATE pg_catalog."C", ${whitespacePattern})
    WITH ORDINALITY AS words(token, position)
  WHERE token <> ''
), longest AS (
  SELECT token FROM words ORDER BY char_length(token) DESC, position DESC LIMIT 1
)
SELECT coalesce((SELECT char_length(token) >= 2 FROM longest), false)::int AS accepted,
  1 / (:current_member::int * (coalesce((SELECT char_length(token) >= 2 FROM longest), false) = ${expectedAcceptance})::int) AS guard,
  coalesce((SELECT left(token, 3) FROM longest), '') AS term,
  ARRAY(SELECT token FROM words ORDER BY position) AS tokens,
  '${org(1)}' AS organization, '${firstPosition[0]}' AS before_at,
  '${firstPosition[1]}' AS before_id, ${pageSize} AS size \\gset
\\if :accepted
${boundPage};
\\endif
COMMIT;`;
}
