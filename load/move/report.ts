import { judge, type Result } from './judge.ts';
import { moveLimits, stepId, thresholds, type Plan } from './plan.ts';

export function render(p: Plan, results: Result[], complete: boolean) {
  const verdict = judge(p, results, complete);
  const rows = verdict.rows.map(row => `| ${row.part} | ${row.size} | ${row.rounds.map(r => r.status).join(' / ')} | ${row.status} |`);
  const reasons = verdict.rows.flatMap(row => row.rounds.flatMap(round => round.reasons.map(reason =>
    `- ${row.part}, ${row.size} Messages, round ${round.round} – ${reason}`)));
  const wal = results.filter(r => r.part === 'F').flatMap(row => {
    const m = row.attempts.at(-1)?.measurement;
    const lane = row.arm === 'move' ? m?.lanes.move : m?.lanes.create;
    if (!m?.wal || !lane || lane.accepted <= 0) return [];
    const perOperation = m.wal.lsnBytes / lane.accepted;
    return [`- ${stepId(row)} · ${perOperation.toFixed(2)} WAL bytes per operation · ${(perOperation / (row.arm === 'move' ? row.size : 1)).toFixed(2)} per Message · relation bytes delta ${m.wal.relationBytesDelta} · Message row delta ${m.wal.messagesDelta}`];
  });
  return {
    verdict,
    markdown: [
      '# Move to topic measurement', '',
      p.smoke ? 'Smoke is a functional check. Every performance result is NOT EVALUATED.' : 'Mac-relative measurement using one release image across both arms.',
      '', `Overall **${verdict.overall}**. Functional checks **${verdict.functional}**.`,
      '', `1,000-Message limit · **${verdict.limit.status}**${verdict.limit.size ? ` (${verdict.limit.size} Messages)` : ''}.`,
      '', '| Part | Chain size | Rounds | Result |', '| --- | ---: | --- | --- |', ...rows, '',
      ...(!p.smoke ? [
        `- Part B requires ≥${thresholds.accepted * 100}% send acceptance in the Move arm each round. For 100 Messages, send p95 must be ≤${thresholds.latencyPercent}% of the no-Move p95. For 1,000 Messages, send p99 must be ≤ no-Move p99 + min(same-round Part A 1,000-Message Move p95, ${moveLimits[1000]} ms).`,
        `- Part C requires ≥${thresholds.accepted * 100}% send acceptance in each arm in every round. Move-arm send p95 and p99 must each be ≤${thresholds.latencyPercent}% of the corresponding no-Move latency.`,
        '',
      ] : []),
      ...(reasons.length ? ['## Round details', '', ...reasons, ''] : []),
      ...(wal.length ? ['## WAL and storage', '', ...wal, ''] : []),
      'See [run identity](metadata.json) and [round measurements](results.json).',
      '',
      'DM acceptance (including the ≤10% non-DM regression limit), #515 acceptance and the #137 timeline budget remain independently binding. Absolute production-like budgets follow #431.',
    ].join('\n') + '\n',
  };
}
