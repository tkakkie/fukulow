import { readFileSync } from 'node:fs';
import { b1Query } from '../../search-engines/b1.ts';
import { pattern } from '../../search-engines/queries.ts';
import { channel, literal, member, org, trimQuery } from '../../search-engines/seed.ts';

export const read = (name: string) => readFileSync(new URL(name, import.meta.url), 'utf8');
const shape = b1Query().match(/^(WITH visible AS MATERIALIZED \([\s\S]+?\n\))\nSELECT [\s\S]+?(  AND m\.created_at[\s\S]+?)\nORDER BY /);
if (!shape) throw new Error('B1 visibility or date window changed');
const [, visibility, dateWindow] = shape;
const templates = {d3: read('d3-query.sql'), d3r: read('d3r-query.sql'), d4: read('d4-query.sql')};
export const variants = ['d3', 'd3r', 'd4'] as const;
export type Variant = typeof variants[number];
export type Arm = 'few' | 'many';
export const seedGram = (normalized: string) => [...normalized].slice(0, 3).join('');
export const visible = (actor: number) => visibility.replace(literal(member(1, 2)), literal(member(1, actor)));
const orderBy = (alias: string, page: boolean) => page
  ? `ORDER BY ${alias}.created_at DESC, ${alias}.id DESC LIMIT 20`
  : `ORDER BY ${alias}.id`;
const range = dateWindow.trim();
export const context = `SET LOCAL fukulow.organization_id = ${literal(org(1))};\n`;
export const transaction = () =>
  `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;\nSELECT set_config('fukulow.organization_id',${literal(org(1))},true);\n`;

export function query(variant: Variant, normalized: string, actor = 2, page = true,
  {parameterized = false, scope}: {parameterized?: boolean; scope?: string} = {}) {
  if (!normalized) throw new Error('Expected a nonempty normalized query');
  // The empty concatenation keeps B1's text index out of the LIKE recheck.
  const scopeOrder = variant === 'd3r' ? 'ORDER BY t.created_at DESC, t.message_id DESC LIMIT 20'
    : orderBy('m', true);
  return templates[variant].replace('{{visibility}}', () => visible(actor))
    .replace('{{columns}}', () => page ? 'hit.id, hit.created_at, hit.body' : 'hit.id')
    .replace('{{gram}}', () => parameterized ? '$2' : literal(seedGram(normalized)))
    .replace('{{matches}}', () => `(m.normalized_body || '') COLLATE "C" LIKE ${parameterized ? '$1' : literal(pattern(normalized))}
      ESCAPE chr(92) ${range}`)
    .replace('{{scopeLimit}}', () => page ? scopeOrder : '')
    .replace('{{scopeFilter}}', () => scope ? `WHERE v.id = ${literal(scope)}::uuid` : '')
    .replace('{{order}}', () => orderBy('hit', page)).trim();
}

// Independent visibility shape and literal substring check for the owner oracle.
export function reference(normalized: string, actor: number, page: boolean) {
  return `SELECT m.id${page ? ',m.created_at,m.body' : ''}
    FROM public.messages m
    JOIN public.channels c ON c.organization_id=m.organization_id AND c.id=m.channel_id
    JOIN public.users u ON u.organization_id=m.organization_id AND u.id=${literal(member(1, actor))}
    WHERE m.organization_id=${literal(org(1))} AND u.deactivated_at IS NULL
      AND ((u.role='member' AND c.visibility='public') OR EXISTS (
        SELECT FROM public.channel_members cm WHERE cm.organization_id=u.organization_id
          AND cm.member_id=u.id AND cm.membership_revision=u.membership_revision AND cm.channel_id=c.id
      ))
      AND strpos(m.normalized_body,${literal(normalized)})>0 ${range}
    ${orderBy('m',page)}`;
}

export const normalizeSql = (raw: string) => `SELECT public.search_normalize(${literal(trimQuery(raw))});`;
export const latencyClasses = [
  ['frequent', '確認を'], ['rare', '特殊照合'], ['one-char', '開'], ['two-char', '麒麟'],
  ['two-char-frequent', '開発'], ['nfc', 'がぎ'], ['nfd', 'か\u3099き\u3099'],
  ['percent', 'x%y'], ['underscore', 'a_b'], ['backslash', 'c\\d'],
  ['percent-only', '%'], ['underscore-only', '_'], ['backslash-only', '\\'],
  ['astral', '🦉'], ['miss', '不存在'], ['time-window', '境界'],
] as const;
export const edgeCases = [['ties','tiemark'], ['recheck-heavy','rqzneedle']] as const;

export const foreignClasses = [
  {name: 'other-organization', key:'zetaorgtoken', org: 2, channel: 1},
  {name: 'private-non-member', key:'omegaprivatetoken', org: 1, channel: 5},
  {name: 'dm-non-participant', key:'thetadmtoken', org: 1, channel: 7},
] as const;
export type ForeignClass = typeof foreignClasses[number];
export const foreignRows = 1000;
export const foreignStart = (c: ForeignClass) => 810000 + foreignClasses.indexOf(c) * 2000;
export const foreignRange = (c: ForeignClass) => `id BETWEEN ${foreignStart(c) + 1} AND ${foreignStart(c) + foreignRows}`;
export function foreignSeed(c: ForeignClass, arm: Arm) {
  const start = foreignStart(c);
  return `INSERT INTO public.messages VALUES
    (${literal(org(1))}, ${start}, ${literal(channel(1, 1))}, '2026-11-14', ${literal(c.key)});
    INSERT INTO public.messages
    SELECT ${literal(org(c.org))}, ${start}+n, ${literal(channel(c.org, c.channel))},
      '2026-11-14 12:00:00+00'::timestamptz - n * interval '1 second',
      CASE WHEN n<=${arm === 'many' ? foreignRows : 1} THEN ${literal(c.key)} ELSE ${literal(decoy(c.key))} END
    FROM generate_series(1,${foreignRows}) n;`;
}

// ROT13 keeps length, bytes and distinct-gram count, so both arms' term tables match in size.
export const decoy = (key: string) => key.replace(/[a-z]/g, ch =>
  String.fromCharCode((ch.charCodeAt(0) - 97 + 13) % 26 + 97));

// Oracle counts derived from seed.sql for actor 2's five visible scopes.
export const expectedFull: Readonly<Record<string, number>> = {
  rare: 5, 'two-char': 5, nfc: 10, nfd: 10, astral: 15, miss: 0,
  percent: 5, underscore: 5, backslash: 5, 'percent-only': 5, 'underscore-only': 5, 'backslash-only': 5,
};

export function pairedArms(repetition: number, offset: number): readonly [Arm, Arm] {
  return (repetition + offset) % 2 === 0 ? ['few', 'many'] : ['many', 'few'];
}
