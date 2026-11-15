export type Verdict = 'PASS' | 'FAIL' | 'NOT EVALUATED';
export type Evidence = Record<string, number | undefined | null>;
// Values are the adopted spec/dms.md budgets; absent evidence can never pass.
export const budgets: Record<string, number> = {
  'open.p95':150, 'open.p99':300, 'page.p95':100, 'page.p99':250, 'ack.p95':100, 'ack.p99':250,
  'peer.p95':200, 'peer.p99':500, 'fiveAttemptRound.p95':1000, 'fiveAttemptRound.p99':2000,
  'quiet500.runs':10, 'quiet500.seconds':332, 'sql.open':16, 'sql.list':8, 'sql.send':16,
  'plan.candidates':51, 'plan.currentRows':50, 'plan.grantLookups':100, 'plan.unreadRange':500000,
  'plan.offset':0, 'plan.wholeListSort':0, 'plan.perRowOrSocketSql':0, 'plan.aggregationBeforeLimit':0, 'plan.missingScopedRangeIndex':0,
  'plan.fullyReadMessageRanges':0, 'plan.deltaMessageRows':0, 'plan.forbiddenScans':0,
  'pool.connectionsPerOperation':1, 'pool.retainedPerSocket':0, 'pool.retainedBetweenPages':0,
  'pool.p95':10, 'pool.p99':50, 'pool.activeP95':24, 'pool.peak':32, 'pool.timeouts':0,
  'app.cpuMean':6, 'app.cpuP99':8, 'db.cpuMean':6, 'db.cpuP99':8,
  'app.rssKiB':2097152, 'app.idleKiBPerConnection':128, 'app.idleCpu':1, 'app.rssGrowthPercent':5,
  'client.rows':200, 'client.inFlight':1, 'client.queued':1, 'client.attempts':5, 'client.unboundedCursors':0,
  'send.uncommittedPercent':1, 'send.undrained':0, 'ledger.missing':0, 'ledger.duplicates':0, 'ledger.unexpected':0,
  'errors':0, 'dropped':0, 'generatorFailures':0, 'peer.missing':0, 'duplicates':0,
  'send.bodyByteFailures':0, 'sampleDeficit':0, 'fixtureMismatches':0, 'mix.missing':0, 'connections.deficit':0, 'offered.deficit':0,
  'preDm.p95RegressionPercent':10, 'preDm.p99RegressionPercent':10, 'preDm.cpuRegressionPercent':10,
  'exactCounts.failures':0, 'discovery.failures':0, 'storage.failures':0, 'restore.failures':0,
};
export function judge(evidence: Evidence, mode: 'formal' | 'smoke') {
  const rows = Object.entries(budgets).map(([budget, limit]) => {
    const value = evidence[budget];
    const status: Verdict = value == null || !Number.isFinite(value) ? 'NOT EVALUATED' : value <= limit ? 'PASS' : 'FAIL';
    return { budget, limit, value: value ?? null, status };
  });
  return { label: mode === 'smoke' ? 'NON-ACCEPTANCE' : 'FORMAL (partial scenario coverage)', acceptance: mode === 'formal' && rows.every(row => row.status === 'PASS'), rows };
}
export function commonWindow(starts: number[], mode: 'formal' | 'smoke') {
  if (starts.length !== 11 || starts.some(start => !Number.isFinite(start))) throw new Error('All eleven generator start timestamps required');
  const from = Math.max(...starts) + (mode === 'formal' ? 600_000 : 60_000);
  const to = Math.min(...starts) + (mode === 'formal' ? 2_400_000 : 120_000);
  // A shared absolute start is required; shrinking windows hides offered work.
  if (to-from !== (mode === 'formal' ? 1_800_000 : 60_000)) throw new Error('Generators did not share the exact scheduled epoch');
  return { from, to };
}
export type LedgerRow = { organization: string; member: string; channel: string; client_message_id: string; id?: string; seq?: number };
const key = (r: LedgerRow) => [r.organization,r.member,r.channel,r.client_message_id].join('/');
export function reconcile(issued: LedgerRow[], durable: LedgerRow[]) {
  const expected = new Map(issued.map(row => [key(row),row]));
  const seen = new Set<string>(), ids = new Set<string>(), seqs = new Set<string>(); let duplicates = issued.length-expected.size, missing = 0, unexpected = 0;
  for (const row of durable) { const k = key(row), sent = expected.get(k); const repeated=seen.has(k); if (repeated) duplicates++; seen.add(k);
    const id=`${row.organization}/${row.id}`, seq=`${row.organization}/${row.channel}/${row.seq}`;
    if(!repeated && ((row.id && ids.has(id)) || (row.seq!=null && seqs.has(seq))))duplicates++;if(row.id)ids.add(id);if(row.seq!=null)seqs.add(seq); if (!sent) unexpected++; else if ((sent.id && sent.id !== row.id) || (sent.seq != null && sent.seq !== row.seq)) missing++; }
  for (const k of expected.keys()) if (!seen.has(k)) missing++;
  return { missing, duplicates, unexpected };
}
export const deferredScenarios = ['ten-sockets-per-Member','single-Organization-10000','scale-and-cold-cache','history-and-Mention-shapes','hot-DM','fault-and-backlog-recovery','storage-1M-10M','backup-restore','pre-DM-regression'].map(scenario => ({ scenario, status: 'not run' }));
