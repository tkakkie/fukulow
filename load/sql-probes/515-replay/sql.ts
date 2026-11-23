import type { Arm } from '../../slice5/config.ts';

type Parameter = 'organization' | 'organizationText' | 'token' | 'member' | 'revision' | 'channel' | 'after' | 'through' | 'limit';
const pgType: Record<Parameter, string> = {
  organization: 'uuid', organizationText: 'text', token: 'bytea', member: 'uuid', revision: 'bigint',
  channel: 'uuid', after: 'bigint', through: 'bigint', limit: 'bigint',
};
export type Bindings = Record<Parameter, string | number>;
export type Statement = { name: string; sql: string; refs: string; parameters?: Parameter[]; rows?: number; autocommit?: boolean };
type Source = (path: string, first: number, last?: number) => string;

// The inputs are fixed Rust string literals at the pinned revisions. Reject a
// moved range or an unexpanded format argument instead of probing different SQL.
export function literal(source: string): string {
  const raw = /r#"([\s\S]*?)"#/.exec(source);
  const cooked = /"((?:[^"\\]|\\[\s\S])*)"/.exec(source);
  if (raw) return raw[1];
  if (!cooked) throw new Error('Missing Rust SQL literal');
  return JSON.parse('"' + cooked[1].replace(/\\\n\s*/g, '') + '"') as string;
}

export function expand(template: string, replacements: Record<string, string | number>): string {
  let next = 0;
  return template.replace(/\{(\w*)\}/g, (_, name: string) => {
    const value = replacements[name || String(next++)];
    if (value === undefined) throw new Error(`Missing SQL template argument ${name}`);
    return String(value);
  });
}

export function extract(arm: Arm, source: Source, pageRows: number) {
  const a = arm === 'A';
  const l = (path: string, first: number, last?: number) => {
    try { return literal(source(path, first, last)); }
    catch (error) { throw new Error(`server/src/${path}:${first}: ${(error as Error).message}`); }
  };
  const wrap = (sql: string) => expand(l('database/context.rs', 39, 42), { sql });
  const channelPolicy = expand(l('channels.rs', a ? 311 : 264, a ? 313 : 266), {
    public_roles: "'owner','admin','member'", explicit_roles: "'owner','admin','member','guest'",
  });
  const currentMember = expand(l('auth.rs', a ? 764 : 738), {
    ACTIVE_MEMBERS_SQL: l('auth.rs', a ? 760 : 734), locking: '',
  });
  const visible = expand(l('channels.rs', a ? 617 : 459), {
    0: expand(l('channels.rs', a ? 320 : 273, a ? 322 : 275), {
      member_sql: currentMember, channel_parameter: '$4', visible: channelPolicy,
    }),
  });
  const mentionPage = (page: string, order: string) => expand(l('messages/mentions.rs', 35, 41), {
    page, order, 0: l('auth/members.rs', a ? 27 : 24),
    ...(a && { 1: l('auth/history.rs', 5) }),
  });

  const visibilityParams: Parameter[] = ['organization', 'member', 'revision', 'channel'];
  const begin = l('database.rs', a ? 100 : 99);
  const rollback = l('database.rs', a ? 111 : 110);
  const context = l('database/context.rs', a ? 160 : 140);
  const snapshot = (prefix: string, body: Statement[]): Statement[] => [
    { name: prefix + '_begin', sql: begin, refs: `database.rs:${a ? 97 : 96}` },
    { name: prefix + '_context', sql: context, parameters: ['organizationText'], rows: 1, refs: `database/context.rs:${a ? 160 : 140}` },
    ...body,
    { name: prefix + '_rollback', sql: rollback, refs: `database.rs:${a ? 107 : 106}` },
  ];
  const auth = snapshot('auth', [{
    name: 'session', sql: l('auth.rs', a ? 690 : 664, a ? 694 : 668),
    parameters: ['token', 'organization'], rows: 1, refs: `auth.rs:${a ? 659 : 633}, auth.rs:${a ? 690 : 664}`,
  }]);
  const visibility: Statement = {
    name: 'visibility', sql: a ? wrap(visible) : visible, parameters: visibilityParams, rows: 1, autocommit: a,
    refs: a ? 'messages.rs:568, channels.rs:574, channels.rs:615, auth.rs:760, database/context.rs:37'
      : 'messages.rs:98, channels.rs:280, channels.rs:457, auth.rs:734',
  };
  if (!a) {
    const page: Statement = {
      name: 'page', sql: mentionPage(l('messages.rs', 114, 117), 'p.seq ASC'),
      parameters: ['organization', 'channel', 'after', 'limit'], rows: pageRows,
      refs: 'messages.rs:114, messages.rs:130, messages/mentions.rs:33, auth/members.rs:23',
    };
    return { sequence: [...auth, ...snapshot('history', [visibility, page])], page, controls: [] };
  }

  const logTemplate = l('messages/log.rs', 155, 169);
  const logPage = (channel: number, access: string) =>
    expand(logTemplate, { channel, after: channel + 1, through: channel + 2, limit: channel + 3, access });
  const authorized = (sql: string) => mentionPage(expand(l('messages/log.rs', 216, 217), { 0: visible, 1: sql }), 'p.event_seq');
  const lateral = logPage(4, 'AND access.visible');
  const join = /LEFT JOIN LATERAL \(\s*SELECT \* FROM messages\s*WHERE (.*?)\s*OFFSET 0\s*\) m ON true/s;
  if (!join.test(lateral)) throw new Error('Missing pinned hydration join');
  const plain = lateral.replace(join, (_, predicate: string) =>
    'LEFT JOIN messages m ON ' + predicate.replace(/(^| AND )(organization_id|channel_id|id)=/g, '$1m.$2='));
  const page: Statement = {
    name: 'page', sql: expand(l('messages/log.rs', 288), { sql: wrap(authorized(lateral)) }),
    parameters: [...visibilityParams, 'after', 'through', 'limit'], rows: pageRows, autocommit: true,
    refs: 'messages/log.rs:273, messages/log.rs:151, messages/log.rs:214, messages/mentions.rs:33, auth/history.rs:4, auth/members.rs:26, database/context.rs:37',
  };
  const logOnly = /^(WITH log_page AS MATERIALIZED \([\s\S]*?\n\s*\))\s+SELECT l\.event_seq/.exec(logPage(2, ''));
  if (!logOnly) throw new Error('Missing pinned Channel log CTE');
  const controls: Statement[] = [
    { ...page, name: 'log_only', sql: wrap(logOnly[1] + ' SELECT * FROM log_page') + ' ORDER BY event_seq',
      parameters: ['organization', 'channel', 'after', 'through', 'limit'] },
    { ...page, name: 'lateral_precontext', sql: page.sql },
    { ...page, name: 'plain_precontext', sql: expand(l('messages/log.rs', 288), { sql: wrap(authorized(plain)) }) },
  ];
  return {
    page, controls,
    sequence: [...auth, visibility,
      { name: 'watermark_begin', sql: l('messages.rs', 851), refs: 'messages/topics.rs:265, messages/delivery.rs:464, messages.rs:842, messages/commit.rs:20' },
      { name: 'barrier', sql: wrap(l('messages/commit.rs', 69, 72)), parameters: ['organization', 'channel'], rows: 1, refs: 'messages.rs:853, messages/commit.rs:59, database/context.rs:37' },
      { name: 'watermark', sql: l('messages.rs', 854, 855), parameters: ['organization', 'channel'], rows: 1, refs: 'messages.rs:854' },
      { name: 'watermark_commit', sql: l('messages/commit.rs', 38), refs: 'messages.rs:862, messages/commit.rs:37' },
      page,
    ] satisfies Statement[],
  };
}

export function quote(value: string | number): string {
  return typeof value === 'number' ? String(value) : "'" + value.replaceAll("'", "''") + "'";
}

export function prepare(stmt: Statement): string {
  if (!stmt.parameters) return '';
  return `PREPARE ${stmt.name}(${stmt.parameters.map(p => pgType[p]).join(',')}) AS ${stmt.sql};`;
}

export function execute(stmt: Statement, bindings: Bindings): string {
  if (!stmt.parameters) return stmt.sql;
  return `EXECUTE ${stmt.name}(${stmt.parameters.map(p => quote(bindings[p])).join(',')})`;
}

export function pgbenchExecute(stmt: Statement): string {
  return stmt.parameters
    ? `EXECUTE ${stmt.name}(${stmt.parameters.map(p => ':' + p).join(',')});`
    : stmt.sql + ';';
}
