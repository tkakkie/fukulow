import { literal } from '../seed.ts';
import { pattern, visibility } from '../queries.ts';

export type Mode = { id: string; engine: string; ddl: string; settings: string; ranked: boolean;
  predicate: (raw: string, normalized: string)=>string; score: (normalized: string)=>string };
const n = 'm.normalized_body';
const literalMode = (engine: string, ddl: string): Mode => ({id:`${engine}-literal`,engine,ddl,settings:'',ranked:false,
  predicate:(_,q)=>`${n} LIKE ${literal(pattern(q))} ESCAPE E'\\\\'`,score:()=> '0::float8'});
const trgmDdl = 'CREATE INDEX search_body ON messages USING gin (normalized_body gin_trgm_ops);';
const bigmDdl = 'CREATE INDEX search_body ON messages USING gin (normalized_body gin_bigm_ops);';
export const modes: Mode[] = [
  literalMode('trgm',trgmDdl), literalMode('bigm',bigmDdl),
  literalMode('pgroonga',`CREATE INDEX search_body ON messages USING pgroonga (normalized_body)
    WITH (normalizers='', tokenizer='TokenNgram("unify_alphabet", false, "unify_symbol", false, "unify_digit", false)');`),
  ...[.1,.3].map(t=>({id:`trgm-sim-${t}`,engine:'trgm',ddl:trgmDdl,
    settings:`SET LOCAL pg_trgm.similarity_threshold=${t};`,ranked:true,
    predicate:(_: string,q: string)=>`${n} % ${literal(q)}`,
    score:(q: string)=>`similarity(${n},${literal(q)})`})),
  ...[.3,.6].map(t=>({id:`trgm-word-${t}`,engine:'trgm',ddl:trgmDdl,
    settings:`SET LOCAL pg_trgm.word_similarity_threshold=${t};`,ranked:true,
    predicate:(_: string,q: string)=>`${literal(q)} <% ${n}`,
    score:(q: string)=>`word_similarity(${literal(q)},${n})`})),
  {id:'bigm-likequery',engine:'bigm',ddl:bigmDdl,settings:'',ranked:false,
    predicate:(_,q)=>`${n} LIKE likequery(${literal(q)}) ESCAPE E'\\\\'`,score:()=> '0::float8'},
  ...[.1,.3].map(t=>({id:`bigm-sim-${t}`,engine:'bigm',ddl:bigmDdl,
    settings:`SET LOCAL pg_bigm.similarity_limit=${t};`,ranked:true,
    predicate:(_: string,q: string)=>`${n} =% ${literal(q)}`,
    score:(q: string)=>`bigm_similarity(${n},${literal(q)})`})),
];
for (const [name,normalizer,tokenizer] of [
  ['auto','NormalizerAuto','TokenBigram'],
  ['kana','NormalizerNFKC150("unify_kana", true, "unify_kana_case", true)','TokenBigram'],
  ['split','NormalizerNFKC150("unify_kana", true, "unify_kana_case", true)',
    'TokenNgram("unify_alphabet", false, "unify_symbol", false, "unify_digit", false)'],
]) for (const op of ['&@','&@~']) {
  modes.push({id:`pgroonga-${name}-${op==='&@' ? 'term' : 'query'}`,engine:'pgroonga',ranked:true,settings:'',
    ddl:`CREATE INDEX search_body ON messages USING pgroonga (body) WITH (normalizers=${literal(normalizer)}, tokenizer=${literal(tokenizer)});`,
    // Name the index so fallback scans under RLS use this mode's normalizer.
    predicate:(raw)=>`m.body ${op} (${literal(raw)},NULL,'search_body')::pgroonga_full_text_search_condition`,
    score:()=> 'pgroonga_score(m.tableoid,m.ctid)'});
}
export function querySql(mode: Mode, raw: string, normalized: string, actor = 2) {
  return `${visibility(actor)} SELECT m.id,${mode.score(normalized)} AS score FROM messages m
    JOIN visible v ON m.organization_id=v.organization_id AND m.channel_id=v.id
    WHERE m.created_at >= TIMESTAMPTZ '2026-11-15 00:00:00+00' - INTERVAL '180 days'
      AND m.created_at <= TIMESTAMPTZ '2026-11-15 00:00:00+00'
      AND ${mode.predicate(raw,normalized)}
    ORDER BY ${mode.ranked ? 'score DESC,' : ''}m.id;`;
}
