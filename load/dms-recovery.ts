// All notices lost: no socket receives the fixture changes. Real HTTP and the
// production pure list protocol share five attempts, independent discovery lanes.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dmListState, stepDmList } from '../web/src/dm-list.ts';
import type { DmChanges, DmList } from '../web/src/api-schema.d.ts';
const seed = JSON.parse(readFileSync(process.env.DM_SEED_OUT!, 'utf8'));
const org: string = seed.organization, member = seed.members[9999];
const sql = (query: string) => execFileSync('docker', ['exec', '-i', process.env.DM_DB_CONTAINER!, 'psql', '-X', '-U', 'fukulow', '-d', 'fukulow', '-v', 'ON_ERROR_STOP=1', '-Atq'], { input: query, encoding: 'utf8' }).trim();
async function get(path: string) {
  const response = await fetch(`${process.env.BASE_URL}/api/v1/orgs/${org}${path}`, { headers: { Authorization: `Bearer ${member.token}` } });
  if (response.status !== 200) throw new Error(`Recovery response ${response.status}`);
  return await response.json() as DmChanges;
}
// Save delta at a quiet high-water and unrelated, partially traversed coverage.
let delta = await get('/dms/changes?lane=delta');
while (!delta.caught_up) delta = await get('/dms/changes?lane=delta&cursor='+encodeURIComponent(delta.next_cursor));
const coverage = await get('/dms/changes?lane=coverage');
const changed = JSON.parse(sql(`WITH selected AS(SELECT channel_id FROM dm_discovery WHERE organization_id='${org}' AND member_id='${member.id}' AND membership_revision=0 ORDER BY birth_position LIMIT 500), numbered AS(SELECT channel_id,row_number() OVER(ORDER BY channel_id) AS n FROM selected), high AS(UPDATE dm_discovery_counters SET position=position+500 WHERE organization_id='${org}' AND member_id='${member.id}' AND membership_revision=0 RETURNING position), updated AS(UPDATE dm_discovery d SET latest_position=high.position-500+n.n FROM numbered n,high WHERE d.organization_id='${org}' AND d.member_id='${member.id}' AND d.membership_revision=0 AND d.channel_id=n.channel_id RETURNING d.channel_id) SELECT json_agg(channel_id) FROM updated;`)) as string[];
const committed = Date.now(), interval = Number(process.env.DM_RECOVERY_INTERVAL_MS || 30000);
let state = dmListState();
state.lanes.delta.cursor = delta.next_cursor; state.lanes.coverage.cursor = coverage.next_cursor;
const seen = new Set<string>(), runs: unknown[] = [];
for (let i = 0; i < 10; i++) {
  const due = committed+i*interval;
  if (due > Date.now()) await new Promise<void>(resolve => setTimeout(resolve, due-Date.now()));
  state = stepDmList(state, { type: 'demand', boundary: true, periodic: true, replace: [] }).state;
  let attempts = 0;
  const start = Date.now();
  for (;;) {
    state = stepDmList(state, { type: 'wake', now: Date.now() }).state;
    const request = state.request;
    if (!request) break;
    attempts++;
    const discovery = request.lane === 'delta' || request.lane === 'coverage';
    const path = discovery ? `/dms/changes?lane=${request.lane}${request.cursor ? '&cursor='+encodeURIComponent(request.cursor) : ''}` : '/dms?'+request.ids!.map(id => 'channel_id='+id).join('&');
    const data = await get(path) as DmChanges | DmList;
    if (request.lane === 'delta') for (const dm of data.dms) if (changed.includes(dm.id)) seen.add(dm.id);
    state = stepDmList(state, { type: 'result', request, data }).state;
  }
  runs.push({ run: i+1, attempts, startMs: start-committed, responseMs: Date.now()-start, processed: seen.size, retained: state.rows.length, pending: changed.length-seen.size });
  writeFileSync(`${process.env.DM_OUTPUT}/recovery.json`, JSON.stringify({ interval, changes: changed.length, elapsedMs: Date.now()-committed, runs }, null, 2));
  if (attempts > 5 || state.rows.length > 200) throw new Error('Recovery exceeded client bounds');
}
if (seen.size !== 500) throw new Error(`Recovery left ${500-seen.size} pending DMs`);
console.log(`Lost-notice recovery: 500 pending drained in 10 O5 runs / ${Date.now()-committed} ms`);
