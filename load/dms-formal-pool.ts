// #426 PLACEHOLDER: implement parsing plus interval aggregation/coverage in
// productionPoolEvidence once the structured production log schema is merged.
// Never accept measure_hold/pool instrumentation. Validate timestamp, units, interval coverage and reset-aware
// counters/histogram deltas before returning complete evidence.
export type PoolSample = { at:number; acquisitionMs:number[]; active:number; timeouts:number };
export function parseProductionPoolLine(_line:string):PoolSample|undefined { return undefined; }
export function productionPoolEvidence(lines:string[],from:number,to:number):Record<string,number> {
  const samples=lines.map(parseProductionPoolLine).filter((s):s is PoolSample=>!!s && s.at>=from && s.at<to);
  // Follow-up must define the #426 periodic coverage rule; incomplete parser
  // deliberately cannot produce any passing pool judgment row.
  void samples;
  return {};
}
