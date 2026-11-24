import type { Request, Traffic } from './c3-timing.ts';

export function parseTraffic(stdout: string, points: string): Traffic {
  const only = (prefix: string) => {
    const lines = stdout.split('\n').filter(line => line.startsWith(prefix));
    if (lines.length !== 1) throw new Error(`missing or duplicate k6 ${prefix.trim()} marker`);
    return lines[0].slice(prefix.length);
  };
  const requestPrefix = 'C3_REQUEST ';
  const requests = stdout.split('\n').filter(line => line.startsWith(requestPrefix))
    .map(line => JSON.parse(line.slice(requestPrefix.length)) as Request);
  const metrics = JSON.parse(only('C3_RESULT '));
  const dropped = metrics.dropped_iterations === undefined ? 0 : metrics.dropped_iterations?.values?.count;
  const attempts = metrics.send_status?.values?.count, errors = metrics.send_failures?.values?.count;
  const vus = points.trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
    .filter(row => row.type === 'Point' && row.metric === 'vus')
    .map(row => ({ wallMs: Date.parse(row.data?.time), value: row.data?.value }));
  return { scenario: Number(only('C3_START ')), requests, vus,
    load: { attempts, errors, accepted: attempts - errors, iterations: metrics.iterations?.values?.count, dropped } };
}

export const logSettings = ['log_connections=receipt,authorization', 'log_disconnections=on', 'log_timezone=UTC',
  'log_line_prefix=%m [%c] %u %d | ', 'log_autovacuum_min_duration=0'];

export function connectionEvidence(log: string, database: string, warm: number, first: number, drain: number) {
  const parsed = log.split('\n').flatMap(line => {
    const match = /^(\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d\.\d{3}) UTC \[([\da-f]+\.[\da-f]+)\] (\S*) (\S*) \| LOG:\s+(.*)$/.exec(line);
    if (!match) return [];
    const [, day, time, session, role, db, message] = match;
    return [{ wallMs: Date.parse(`${day}T${time}Z`), session, role, db, message, line }];
  });
  const markers = (stage: string) => parsed.filter(row => row.db === database && row.role === 'fukulow'
    && row.message === `C3_COVERAGE_${stage}`);
  const before = markers('BEGIN'), after = markers('END');
  if (before.length !== 1 || after.length !== 1 || !(before[0].wallMs <= warm && after[0].wallMs >= drain)) {
    throw new Error('connection log coverage markers missing or out of order');
  }
  const sessions = new Set(parsed.filter(row => row.db === database && row.role === 'fukulow_app').map(row => row.session));
  const connections = parsed.filter(row => sessions.has(row.session));
  const starts = connections.filter(row => row.message.startsWith('connection received:'));
  if (!sessions.size || [...sessions].some(session => starts.filter(row => row.session === session).length !== 1
    || !connections.some(row => row.session === session && row.message.startsWith('connection authorized:')
      && row.db === database && row.role === 'fukulow_app' && row.wallMs >= starts.find(start => start.session === session)!.wallMs))) {
    throw new Error('app connection start/authorization evidence missing or malformed');
  }
  return { lines: [...before, ...connections, ...after].map(row => row.line), starts,
    late: starts.filter(row => row.wallMs > first && row.wallMs <= drain),
    automaticMaintenance: parsed.filter(row => /automatic (?:vacuum|analyze|aggressive vacuum)/i.test(row.message)
      && row.wallMs >= before[0].wallMs && row.wallMs <= after[0].wallMs).map(row => row.line) };
}
