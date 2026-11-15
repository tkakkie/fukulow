// This is a recorded procedure, not synthetic overhead evidence. The pre-#427
// main image lacks DMs, so it cannot execute an identical mixed DM workload.
export const poolOverheadDesign={
  scenario:'pool-overhead',status:'NOT EVALUATED',acceptance:false,
  requestedBaseline:'1aed680^',candidate:'DM_FORMAL_SHA',limitPercent:10,
  reason:'The pre-#427 main tree has no DM implementation; comparing it with the DM branch would confound instrumentation overhead with the DM implementation.',
  alternative:'Build two release images from the same formal DM SHA: production instrumentation, and a reviewed baseline patch reverting only #427 acquisition counters/histograms/reporter while preserving every checkout, deadline, pool limit and DM path. Retain source SHA, exact patch, toolchains and image digests. No production instrumentation switch is added.',
  procedure:'On the same dedicated formal Linux app/DB/generator hosts and fixed resource limits, restore identical snapshots before each arm. Use main fixture and identical shortened full mixed load (10,000 connections, 2,000 sends/s, opens, O5 and concurrent browsing): 5 min ramp, 5 min warm, 5 min judged core. Alternate baseline/candidate order for three pairs. Retain generator outcomes, raw request samples and one-second app CPU/server-only RSS with >=99% coverage. Reject any errors, dropped arrivals, missing full-load coverage or differing conditions.',
  comparison:'For each pair report baseline, candidate and 100*(candidate/baseline-1) for app mean CPU, each request class p95/p99 and peak RSS. Positive finite baselines and complete matching class populations are required. Each delta must be <=10%; any miss FAILs, missing evidence is NOT EVALUATED. This shortened check cannot replace the three full formal attempts.',
};
