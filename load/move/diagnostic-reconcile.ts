import { diagnosticScope, requiredReadPhases, sendTimingProblems, type Statement, type Window } from './diagnostic-evidence.ts';
import { diagnosticIntegrity, expectedDiagnosticLanes, laneScenarios, laneSeconds, usablePhase,
  type DiagnosticLane, type DiagnosticSelection, type DiagnosticSummary } from './diagnostic-integrity.ts';
import type { captureDiagnostic } from './diagnostic.ts';
import type { Plan, Step } from './plan.ts';

type Capture = Awaited<ReturnType<Awaited<ReturnType<typeof captureDiagnostic>>['finish']>>;
export type DiagnosticCheck = { metric: string; status: 'EVALUATED' | 'NOT EVALUATED'; reasons: string[] };
export const diagnosticLaneLabels = { send: diagnosticScope.sendLane, move: 'Move', topics: 'Topic list',
  channels: 'Channel list', reader: 'Second-Organization Channel list' } satisfies Record<DiagnosticLane, string>;

const movePhases = ['move_access_sql', 'move_chain_lookup', 'move_apply'];
const sendAdmission503s = ['channel_queue_full', 'global_queue_full', 'channel_admission_timeout',
  'global_admission_timeout', 'channel_admission_closed', 'global_admission_closed'];
function requiredPhases(lane: DiagnosticLane, selection: DiagnosticSelection) {
  if (lane === 'send') return ['before_admission', 'channel_admission_wait', 'admitted_work',
    ...(selection.sendBreakdown ? ['send_unattributed', 'send_topic_record'] : [])];
  if (lane === 'move') return movePhases;
  if (selection.readTimingSampleEvery === null) return [];
  if (lane === 'reader') return ['channel_list_total'];
  return requiredReadPhases[lane];
}

function requiredStatements(step: Step, selection: DiagnosticSelection) {
  return ['send_insert', 'channel_advisory_write',
    ...(step.arm === 'move' ? ['move_update', 'move_chain_lookup'] : []),
    ...(selection.readTimingSampleEvery !== null ? ['channel_list_visible', 'channel_list_counts'] : []),
    ...(selection.readTimingSampleEvery !== null && selection.readLanes !== 'channels'
      ? ['topic_page', 'dm_check', 'channel_advisory_read'] : [])];
}

export function statementProblems(groups: string[], statements: Statement[]) {
  return groups.filter(group => !statements.some(row => row.group === group && Number.isSafeInteger(row.calls) &&
    row.calls > 0 && Number.isFinite(row.execMs) && row.execMs >= 0));
}

function addStatuses(target: Record<string, number>, source: Record<string, number>) {
  for (const [status, n] of Object.entries(source)) target[status] = (target[status] ?? 0) + n;
}

const clockAllowanceMs = 100;
const inside = (at: number, window: Window) => Number.isFinite(at) &&
  at >= window.start - clockAllowanceMs && at <= window.end + clockAllowanceMs;

export function reconcileDiagnostic(p: Plan, step: Step, selection: DiagnosticSelection, summary?: DiagnosticSummary, capture?: Capture, generatorProblem?: string) {
  const checks: DiagnosticCheck[] = [];
  const windows: Record<string, { offered: Window; drained: Window }> = {};
  const laneWindows: Partial<Record<DiagnosticLane, Window>> = {};
  const check = (metric: string, reasons: string[]) => {
    checks.push({ metric, status: reasons.length ? 'NOT EVALUATED' : 'EVALUATED', reasons });
  };
  const lanes = expectedDiagnosticLanes(step, selection.readLanes);
  const explainedRead503: Partial<Record<DiagnosticLane, number>> = {};
  const { app, k6, window, clock, postgres, containers } = capture ?? {};
  const clockProblems = !window || !clock || !Number.isFinite(clock.driftMs) || clock.wallMs <= 0 ||
    Math.abs(clock.driftMs) > clockAllowanceMs ? ['wall-clock vs monotonic elapsed drift or missing clock record'] : [];
  for (const boundary of ['start', 'end'] as const) {
    const reading = clock?.[boundary];
    if (!reading || !Number.isFinite(reading.offsetMs)) clockProblems.push(`missing host vs Docker VM clock reading at arm ${boundary}`);
    else if (Math.abs(reading.offsetMs) > clockAllowanceMs)
      clockProblems.push(`host vs Docker VM clock offset at arm ${boundary} exceeds ${clockAllowanceMs} ms`);
  }
  const streamProblems = [
    ...(generatorProblem ? [generatorProblem] : []),
    ...(!k6 ? ['missing k6 stream'] : k6.stream.invalidPoints ? ['invalid k6 stream points'] : []),
  ];
  const appProblems = !app ? ['missing Docker app logs'] : [
    ...(!app.anchorRetained ? ['pre-window Docker log anchor missing (possible rotation)'] : []),
    ...(app.truncationSigns || app.invalidLines ? ['truncated, malformed or unreadable Docker log records'] : []),
    ...(app.outsideWindow ? ['app events outside the arm window'] : []),
  ];
  const requests: Partial<Record<DiagnosticLane, Record<string, number>>> = {};
  const failures: Partial<Record<DiagnosticLane, string[]>> = {};
  const legacyReads = selection.readTimingSampleEvery === null;
  for (const lane of lanes) {
    const problems: string[] = [];
    const statuses: Record<string, number> = {};
    let first = Infinity, last = -Infinity;
    for (const name of laneScenarios(lane, p)) {
      const series = k6?.stream.series[name] ?? {};
      const start = series.move_scenario_start_ms;
      if (start?.count !== 1 || !window || !inside(start.sum, window)) {
        problems.push(`${name}: missing or invalid scenario start`);
        continue;
      }
      if (name === 'reader' && start.sum !== summary?.started) problems.push('summary and stream arm starts disagree');
      const offered = { start: start.sum, end: start.sum + laneSeconds(p, lane) * 1000 };
      const drained = { ...offered, end: offered.end + p.drain * 1000 };
      windows[name] = { offered, drained };
      first = Math.min(first, drained.start);
      last = Math.max(last, drained.end);
      const http: Record<string, number> = {};
      for (const [metric, points] of Object.entries(series)) {
        if (metric.startsWith('http_')) http[metric.slice(5)] = points.sum;
        const scoped = metric === 'dropped_iterations' ? offered : drained;
        if (!inside(points.first, scoped) || !inside(points.last, scoped) ||
            !inside(points.first, window) || !inside(points.last, window))
          problems.push(`${name}: ${metric} outside its window`);
      }
      if (Object.values(http).reduce((sum, n) => sum + n, 0) !== series.iterations?.sum ||
          series.iteration_duration?.count !== series.iterations?.sum ||
          (lane === 'topics' && series.move_topic_reads?.sum !== series.iterations?.sum))
        problems.push(`${name}: HTTP requests, completed iterations, durations or Topic reads disagree`);
      addStatuses(statuses, http);
    }
    const scenarioWindow = { start: first, end: last };
    laneWindows[lane] = scenarioWindow;
    if (lane === 'topics') for (const [metric, points] of Object.entries(k6?.stream.series.topics ?? {})) {
      if (!window || !inside(points.first, scenarioWindow) || !inside(points.last, scenarioWindow) ||
          !inside(points.first, window) || !inside(points.last, window))
        problems.push(`Topic list: ${metric} outside its window`);
    }
    const row = summary?.lanes?.[lane];
    if (!row || (statuses[503] ?? 0) !== row.rejected503) problems.push('summary and stream HTTP 503 counts disagree');
    if (row && lane !== 'send' && lane !== 'move' && (statuses[200] ?? 0) !== row.accepted)
      problems.push('summary and stream successful read counts disagree');
    const clientLatency = k6?.stream.latencies[lane];
    // One ulp-scale allowance covers Go's and JavaScript's floating-point interpolation.
    if (!row || !clientLatency || (['p95', 'p99'] as const).some(rank =>
      row[rank] === null || Math.abs(row[rank] - clientLatency[rank]) > 4 * Number.EPSILON * Math.max(1, clientLatency[rank])))
      problems.push('summary and stream latency percentiles disagree');
    const server = app?.unavailable.filter(event => event.lane === lane) ?? [];
    const seen503 = statuses[503] ?? 0;
    const appCoversLane = !(legacyReads && lane !== 'send' && lane !== 'move');
    if (app && appCoversLane && (server.length !== seen503 || server.some(event => !inside(event.at, scenarioWindow))))
      problems.push(`app HTTP 503 count or window disagrees (app ${server.length}, k6 ${seen503})`);
    if (app && appCoversLane && server.length === seen503 && server.every(event =>
      event.reason === 'channel_queue_full' && inside(event.at, scenarioWindow))) explainedRead503[lane] = seen503;
    if (app?.timing.some(point => point.lane === lane && !inside(point.at, scenarioWindow))) problems.push('app timings outside the lane window');
    requests[lane] = statuses;
    failures[lane] = problems;
  }

  const unexpectedScenarios = Object.keys(k6?.stream.series ?? {}).filter(name => !Object.hasOwn(windows, name) &&
    !(name === 'topics' && lanes.includes('topics')));
  if (unexpectedScenarios.length) streamProblems.push(`unexpected or unbounded k6 scenarios (${unexpectedScenarios.join(', ')})`);
  for (const lane of ['send', 'move', 'topics', 'channelLists'] as const) {
    const group = lane === 'channelLists' ? lanes.filter(name => name === 'channels' || name === 'reader') : lanes.filter(name => name === lane);
    const combined: Record<string, number> = {};
    for (const name of group) addStatuses(combined, requests[name] ?? {});
    const completed = app?.completed[lane] ?? {};
    const statuses = new Set([...Object.keys(combined), ...Object.keys(completed)]);
    const span = app?.completionWindows[lane];
    const traceWindow = { start: Math.min(...group.map(name => laneWindows[name]!.start)),
      end: Math.max(...group.map(name => laneWindows[name]!.end)) };
    if ([...statuses].some(status => (combined[status] ?? 0) !== (completed[status] ?? 0)) ||
        (span && (!inside(span.start, traceWindow) || !inside(span.end, traceWindow)))) {
      const problem = `app completion trace disagrees with k6 for ${lane === 'channelLists' ? 'the shared Channel-list route' : diagnosticLaneLabels[lane]}`;
      if (group.length) for (const name of group) failures[name]?.push(problem);
      else appProblems.push(problem);
    }
  }

  if (app && summary?.lanes) {
    const checkSampleCoverage = (group: DiagnosticLane[], phase: string, every: number, failuresAfterHook = 0) => {
      const observed = group.reduce((sum, lane) => sum + (app.byLane[lane].phasesUs[phase]?.count ?? 0), 0);
      const offers = group.reduce((sum, lane) => sum + (summary.lanes[lane]?.attempted ?? 0), 0);
      const accepted = group.reduce((sum, lane) => sum + (summary.lanes[lane]?.accepted ?? 0), 0);
      const possiblyMissed = offers - accepted - failuresAfterHook;
      const minimum = Math.max(0, Math.floor(offers / every) - possiblyMissed);
      if (observed < minimum || observed > Math.ceil(offers / every))
        for (const lane of group) failures[lane]?.push(`incomplete or excess ${phase} sample coverage`);
    };
    // Both patches advance the send counter in the request wrapper. Queue refusals
    // and wait failures follow before_admission; shutdown and limiter refusals precede it.
    const sendAdmissionFailures = app.unavailable.filter(event =>
      event.lane === 'send' && sendAdmission503s.includes(event.reason)).length;
    checkSampleCoverage(['send'], 'before_admission', 32, sendAdmissionFailures);
    if (step.arm === 'move') checkSampleCoverage(['move'], 'move_apply', 1);
    if (selection.readTimingSampleEvery !== null) {
      checkSampleCoverage(lanes.filter(lane => lane === 'channels' || lane === 'reader'), 'channel_list_total', selection.readTimingSampleEvery);
      if (lanes.includes('topics')) checkSampleCoverage(['topics'], 'topic_page_sql', selection.readTimingSampleEvery);
    }
  }

  const integrity = diagnosticIntegrity(p, step, selection.readLanes, summary, k6?.stream,
    movePhases.every(phase => usablePhase(app?.byLane.move.phasesUs[phase])) &&
      (app?.byLane.move.phasesUs.move_apply?.count ?? 0) >= (summary?.committedMoves ?? Infinity), explainedRead503);
  check('Workload integrity', integrity);
  check('Collector integrity', [...clockProblems, ...streamProblems, ...appProblems, ...(capture?.failures ?? [])]);
  for (const lane of lanes) {
    const label = diagnosticLaneLabels[lane];
    const laneProblems = [...clockProblems, ...streamProblems, ...appProblems, ...(failures[lane] ?? []),
      ...integrity.filter(problem => problem.startsWith(`${lane}:`) || !problem.includes(':'))];
    check(`${label} client latency, outcomes, offers and drops`, laneProblems);
    const phases = app?.byLane[lane].phasesUs ?? {};
    const required = requiredPhases(lane, selection);
    for (const phase of new Set([...required, ...Object.keys(phases)])) {
      const missing = !usablePhase(phases[phase]) ||
        (phase === 'send_unattributed' && sendTimingProblems(app).length > 0);
      const metric = phase === 'send_topic_record' ? 'send_topic_record no-op hook on the main timeline' : phase;
      const reasons = [...laneProblems, ...(missing ? ['missing usable timing samples'] : [])];
      check(`${label} ${metric}`, reasons);
    }
  }
  const statementMissing = statementProblems(requiredStatements(step, selection), postgres?.statements ?? []);
  check('PostgreSQL statements', [...clockProblems, ...(!postgres?.statementsAvailable ? ['empty or missing statement result'] : []),
    ...statementMissing.map(group => `missing non-empty ${group} statement rows`), ...integrity, ...streamProblems]);
  check('PostgreSQL waits and execution excluding lock waits', [...clockProblems,
    ...(!postgres || postgres.failures ? ['PostgreSQL activity collector failure'] : []),
    ...(!postgres || postgres.steadyCoverageMs < 500 * p.seconds ? ['PostgreSQL wait sample coverage'] : []),
    ...checks.find(row => row.metric === 'PostgreSQL statements')!.reasons]);
  check('k6 VU gauges and in-flight drop reconstruction', [...clockProblems, ...streamProblems, ...integrity, ...lanes.flatMap(lane => failures[lane] ?? []),
    ...(!k6?.vus.some(point => point.active !== undefined && point.allocated !== undefined) ? ['missing paired k6 VU gauges'] : [])]);
  const minimumCgroupSamples = p.smoke ? 1 : 2;
  check('Container CPU and memory', [...clockProblems, ...(!containers ? ['missing cgroup samples'] :
    Object.entries(containers.summary).filter(([, sample]) => sample.samples < minimumCgroupSamples)
      .map(([name, sample]) => `insufficient ${name} cgroup samples (${sample.samples} of ${minimumCgroupSamples} required)`))]);
  return { windows, clock, checks, problems: [...new Set(checks.flatMap(row => row.reasons))] };
}

export function diagnosticRunComplete(finished: boolean, expectedArms: number, arms: { problem?: string; checks: DiagnosticCheck[] }[]) {
  return finished && arms.length === expectedArms &&
    arms.every(arm => !arm.problem && arm.checks.length > 0 && arm.checks.every(check => check.status === 'EVALUATED'));
}
