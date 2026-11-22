import assert from 'node:assert/strict';
import { appSessionSettings, verifySession } from '../manifest.ts';
import { member, org } from '../seed.ts';

export const searchTables = ['messages', 'message_search_terms', 'users', 'channels', 'channel_members'] as const;
export const forceSearchRls = searchTables.map(table => `ALTER TABLE public.${table} FORCE ROW LEVEL SECURITY;`).join('\n');
const roleFacts = 'fukulow_app|f|f\n0\n0';

type RlsRecord = {session: ReturnType<typeof verifySession>; role: string; tables: Record<string, boolean[]>};

export function verifyRls(app: (sql: string) => string, settings: Record<string, string>): RlsRecord {
  const session = verifySession(app, 'app', settings);
  const role = app(`SELECT current_user, rolsuper, rolbypassrls FROM pg_roles WHERE rolname=current_user;
    SELECT count(*) FROM pg_auth_members WHERE member=current_user::regrole;
    SELECT count(*) FROM pg_proc WHERE oid IN ('public.fukulow_search_terms(text)'::regprocedure,
      'public.fukulow_search_normalize(text)'::regprocedure) AND prosecdef;`);
  const tables: RlsRecord['tables'] = JSON.parse(app(`SELECT json_object_agg(c.relname,
    json_build_array(c.relrowsecurity, c.relforcerowsecurity, row_security_active(c.oid)))
    FROM pg_class c WHERE c.oid IN (${searchTables.map(table => `'public.${table}'::regclass`).join(', ')});`));
  const record = {session, role, tables};
  assert.ok(validRls(record), 'd3r app role or RLS settings differ');
  return record;
}

export function validRls(record: Partial<RlsRecord> | undefined) {
  return record?.role === roleFacts && record.session?.plannerOverrides === 0 &&
    Object.entries(appSessionSettings).every(([key, value]) => record.session?.settings?.[key] === value) &&
    record.tables && Object.keys(record.tables).length === searchTables.length &&
    searchTables.every(table => JSON.stringify(record.tables?.[table]) === '[true,true,true]');
}

const present = (o?: number) => {
  const where = o === undefined ? '' : `WHERE organization_id = '${org(o)}'`;
  return `SELECT EXISTS (SELECT 1 FROM public.messages ${where}),
    EXISTS (SELECT 1 FROM public.message_search_terms ${where});`;
};
export const directRlsExpected = [org(1), 't|t', 'f|f', 'f|f', org(2), 't|t', 'f|f',
  member(1, 2), 'f|f', 'f|f'].join('\n');

export function directRlsRecorded(record: unknown): record is string {
  if (typeof record !== 'string') return false;
  const lines = record.split('\n');
  const expected = directRlsExpected.split('\n');
  return lines.length === expected.length && lines.every((line, i) =>
    expected[i].includes('|') ? /^[tf]\|[tf]$/.test(line) : line === expected[i]);
}

export function directRls(app: (sql: string) => string) {
  // One psql invocation keeps both controls, the cross-Organization reads and
  // the post-COMMIT checks on the same PostgreSQL backend.
  return app(`BEGIN;
    SELECT set_config('fukulow.organization_id', '${org(1)}', true);
    ${present(1)}
    ${present(2)}
    COMMIT;
    ${present()}
    BEGIN;
    SELECT set_config('fukulow.organization_id', '${org(2)}', true);
    ${present(2)}
    COMMIT;
    ${present()}
    BEGIN;
    SELECT set_config('fukulow.account_id', '${member(1, 2)}', true);
    ${present()}
    COMMIT;
    ${present()}`);
}
