export type Counts = { tp: number; fp: number; fn: number };
export function rates({tp,fp,fn}: Counts) {
  // Empty/empty is perfect; otherwise undefined precision or recall is zero.
  const precision = tp+fp ? tp/(tp+fp) : fn ? 0 : 1;
  const recall = tp+fn ? tp/(tp+fn) : fp ? 0 : 1;
  return {precision,recall,f1:precision+recall ? 2*precision*recall/(precision+recall) : 0};
}
export function score(gold: string[], results: string[], ranked = false) {
  const g = new Set(gold), r = new Set(results);
  if (r.size !== results.length) throw new Error('Duplicate result id');
  const missed = [...g].filter(id=>!r.has(id));
  const falsePositives = results.filter(id=>!g.has(id));
  const counts = {tp:g.size-missed.length,fp:falsePositives.length,fn:missed.length};
  const dcg = results.slice(0,20).reduce((n,id,i)=>n+(g.has(id) ? 1/Math.log2(i+2) : 0),0);
  const ideal = Array.from({length:Math.min(20,g.size)},(_,i)=>1/Math.log2(i+2)).reduce((a,b)=>a+b,0);
  return {...counts,...rates(counts),missed,falsePositives,
    ...(ranked ? {ndcg20:ideal ? dcg/ideal : results.length ? 0 : 1} : {})};
}
export function aggregate(rows: ReturnType<typeof score>[]) {
  if (!rows.length) throw new Error('Empty aggregation');
  const counts = rows.reduce((a,b)=>({tp:a.tp+b.tp,fp:a.fp+b.fp,fn:a.fn+b.fn}),{tp:0,fp:0,fn:0});
  const mean = (key: 'precision'|'recall'|'f1') => rows.reduce((n,r)=>n+r[key],0)/rows.length;
  return {queries:rows.length,micro:{...counts,...rates(counts)},
    macro:{precision:mean('precision'),recall:mean('recall'),f1:mean('f1')},
    ...(rows.every(r=>r.ndcg20!==undefined) ? {macroNdcg20:rows.reduce((n,r)=>n+(r.ndcg20 ?? 0),0)/rows.length} : {})};
}
