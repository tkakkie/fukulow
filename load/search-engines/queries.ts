import { literal, org, member, trimQuery } from './seed.ts';

export const queries = [
  ['ja1-frequent','開'], ['ja1-rare','麒'], ['ja2-frequent','開発'], ['ja2-rare','麒麟'],
  ['ja3-frequent','確認し'], ['ja3-rare','特殊照合'], ['ascii1','a'], ['ascii2','ph'],
  ['ascii3','pha'], ['ascii1-rare','ø'], ['ascii2-rare','zx'], ['ascii-rare','QZX'], ['nfc','がぎ'], ['nfd','か\u3099き\u3099'],
  ['accent','CAFÉ'], ['casefold','STRASSE'], ['greek','ΣΊΣΥΦΟΣ'], ['mixed','照合z9'],
  ['space1','開発 API'], ['space2','開発  API'], ['literal-percent','x%y'],
  ['literal-underscore','a_b'], ['literal-backslash','c\\d'], ['trim','\u0085\u3000開発\u00a0'],
  ['bom','\ufeff開発\ufeff'], ['width','ｶﾀｶﾅ'], ['fullwidth','ＡＢＣ'], ['scalar','🦉'],
] as const;

export const context = (o = 1) => `SELECT set_config('fukulow.organization_id', '${org(o)}', true);`;
export const begin = (o = 1) => `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;\n${context(o)}\n`;
export const normalizedQuery = (q: string) => `search_normalize(${literal(trimQuery(q))})`;
export const pattern = (normalized: string) => `%${normalized.replaceAll('\\','\\\\').replaceAll('%','\\%').replaceAll('_','\\_')}%`;

export function visibility(actor = 2, o = 1): string {
  return `WITH visible AS MATERIALIZED (
    SELECT c.organization_id,c.id FROM channels c
    JOIN users u ON u.organization_id=c.organization_id AND u.id='${member(o,actor)}'
    LEFT JOIN channel_members cm ON cm.organization_id=c.organization_id AND cm.channel_id=c.id
      AND cm.member_id=u.id AND cm.membership_revision=u.membership_revision
    WHERE c.organization_id='${org(o)}' AND u.deactivated_at IS NULL
      AND ((c.visibility='public' AND u.role IN ('owner','admin','member'))
        OR (u.role IN ('owner','admin','member','guest') AND cm.grant_id IS NOT NULL))
  )`;
}

export function search(normalized: string, actor = 2, page = true, reference = false, o = 1): string {
  const predicate = reference ? `strpos(m.normalized_body,${literal(normalized)})>0`
    : `m.normalized_body LIKE ${literal(pattern(normalized))} ESCAPE E'\\\\'`;
  const range = `m.organization_id='${org(o)}' AND m.channel_id=v.id
      AND m.created_at >= TIMESTAMPTZ '2026-11-15 00:00:00+00' - INTERVAL '180 days'
      AND m.created_at <= TIMESTAMPTZ '2026-11-15 00:00:00+00' AND ${predicate}`;
  if (reference) return `${visibility(actor,o)} SELECT m.id${page ? ',m.created_at,m.body' : ''}
    FROM messages m JOIN visible v ON m.channel_id=v.id AND m.organization_id=v.organization_id
    WHERE ${range} ${page ? 'ORDER BY m.created_at DESC,m.id DESC LIMIT 20' : 'ORDER BY m.id'}`;
  return `${visibility(actor,o)} SELECT m.id${page ? ',m.created_at,m.body' : ''} FROM visible v
    CROSS JOIN LATERAL (SELECT m.id,m.created_at,m.body FROM messages m WHERE ${range}
      ${page ? 'ORDER BY m.created_at DESC,m.id DESC LIMIT 20' : ''} OFFSET 0) m
    ${page ? 'ORDER BY m.created_at DESC,m.id DESC LIMIT 20' : 'ORDER BY m.id'}`;
}

export const writeSql = `BEGIN;
${context()}
WITH s AS (UPDATE channel_message_sequences SET seq=seq+1 WHERE organization_id='${org(1)}'
  AND channel_id='00000000-0000-4000-8000-000000002774' RETURNING seq)
INSERT INTO messages (organization_id,id,channel_id,seq,sender,client_message_id,body,created_at)
SELECT '${org(1)}',gen_random_uuid(),'00000000-0000-4000-8000-000000002774',seq,'${member(1,1)}',gen_random_uuid(),
  repeat('検索の負荷を確認します。ProjectAlpha42 API build READY。',5)||seq,'2026-11-15T00:00:00Z' FROM s;
COMMIT;`;
