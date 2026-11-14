// Measurement-only source copy. Never changes production source or its image tag.
import { cpSync, mkdirSync, readFileSync, writeFileSync, readdirSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { outsideCheckout } from './dms-workload.ts';
const output = resolve(process.env.DM_INSTRUMENT_OUT || '');
if (!process.env.DM_INSTRUMENT_OUT || !outsideCheckout(output, resolve('.'))) throw new Error('DM_INSTRUMENT_OUT must be outside checkout');
mkdirSync(output, { recursive: true });
const source = `${output}/source`;
cpSync(resolve('.'), source, { recursive: true, filter: path => !path.split('/').some(part => ['.git','node_modules','target','dist'].includes(part)) });
// The matched baseline restores only the two production changes under test.
if (process.env.DM_INSTRUMENT_BASELINE === '1') {
  const baseline = process.env.DM_INSTRUMENT_BASELINE_REV || execFileSync('git', ['rev-parse','HEAD'], {encoding:'utf8'}).trim();
  if (!/^[0-9a-f]{40}$/.test(baseline)) throw new Error('DM_INSTRUMENT_BASELINE_REV must be an immutable full commit SHA');
  const path = 'server/src/channels/dms/discovery.rs';
  writeFileSync(`${source}/${path}`, execFileSync('git', ['show', `${baseline}:${path}`]));
  unlinkSync(`${source}/server/migrations/202611140389_member_directory_order.sql`);
}
const read = (path: string) => readFileSync(`${source}/server/src/${path}`, 'utf8');
const write = (path: string, text: string) => writeFileSync(`${source}/server/src/${path}`, text);
const methods = 'organization_read_only_detached|organization_read_only|organization_statement|organization|account_read_only|account|read_only';
// Label every shared-helper invocation by its caller, not its eventual SQL text.
function label(directory: string) {
  for (const file of readdirSync(`${source}/server/src/${directory}`, { withFileTypes: true })) {
    const path = directory + file.name;
    if (file.isDirectory()) { label(path+'/'); continue; }
    if (!path.endsWith('.rs') || path === 'database.rs' || path.startsWith('database/')) continue;
    write(path, read(path).replace(new RegExp(`(database::(?:${methods})\\()(?!\\))`, 'g'), (match, _prefix, at: number, text: string) => {
      const fn = [...text.slice(0, at).matchAll(/\bfn\s+(\w+)/g)].at(-1)?.[1] || 'unknown';
      return `${match}"${path}:${fn}", `;
    }));
  }
}
label('');
write('auth/members.rs', read('auth/members.rs').replace('    let rows = crate::database::organization_read_only(', '    static QUERY: std::sync::Once = std::sync::Once::new();\n    QUERY.call_once(|| eprintln!("event=measure_directory_sql sql={}", sql));\n    let rows = crate::database::organization_read_only('));
let db = read('database.rs'), context = read('database/context.rs');
for (const method of methods.split('|')) {
  const pattern = new RegExp(`(async fn ${method}(?:<[^]*?>)?\\(\\n)`);
  if (pattern.test(db)) db = db.replace(pattern, '$1    operation: &\'static str,\n');
  if (pattern.test(context)) context = context.replace(pattern, '$1    operation: &\'static str,\n');
}
db = db.replace('transaction(pool, true,', 'transaction(operation, pool, true,')
  .replace('async fn transaction<T, E>(\n', 'async fn transaction<T, E>(\n    operation: &\'static str,\n')
  .replace('    let mut guard = TransactionConnection {', '    MEASURE_OPERATION.scope(std::cell::Cell::new(operation), async move {\n    let mut guard = TransactionConnection {')
  .replace('    Ok(value)\n}', '    Ok(value)\n    }).await\n}')
  .replace('        connection: None,', '        measure: Some(Measure::new(operation, pool)),\n        connection: None,')
  .replace('    let connection = guard.connection.insert(pool.acquire().await?);', '    let acquired = pool.acquire().await?;\n    if let Some(measure) = guard.measure.as_mut() { measure.acquired(pool); }\n    let connection = guard.connection.insert(acquired);')
  .replace('struct TransactionConnection {', 'struct TransactionConnection {\n    measure: Option<Measure>,')
  .replace('impl Drop for TransactionConnection {\n    fn drop(&mut self) {', 'impl Drop for TransactionConnection {\n    fn drop(&mut self) {\n        if self.finished {\n            if let (Some(connection), Some(measure)) = (self.connection.take(), self.measure.take()) { measure_return(connection, measure); }\n            return;\n        }');
context = context.replaceAll('with_context(pool,', 'with_context(operation, pool,')
  .replace('async fn with_context<T, E>(\n', 'async fn with_context<T, E>(\n    operation: &\'static str,\n')
  .replace('    super::transaction(\n', '    super::transaction(\n        operation,\n')
  .replace('    let mut guard = super::TransactionConnection {\n        connection: Some(pool.acquire().await?),', '    let mut measure = super::Measure::new(operation, pool);\n    let connection = pool.acquire().await?;\n    measure.acquired(pool);\n    let mut guard = super::TransactionConnection {\n        measure: Some(measure),\n        connection: Some(connection),');
// Cover the separate send/watermark transaction owner as well as the helpers.
let commit = read('messages/commit.rs');
commit = commit.replace('    connection: Option<PoolConnection<Postgres>>,', '    measure: Option<crate::database::Measure>,\n    connection: Option<PoolConnection<Postgres>>,')
  .replace('        let mut tx = Self {\n            connection: Some(pool.acquire().await?),', '        let operation = if organization.is_some() { "send_transaction" } else { "watermark_transaction" };\n        let mut measure = crate::database::Measure::new(operation, pool);\n        let connection = pool.acquire().await?;\n        measure.acquired(pool);\n        let mut tx = Self {\n            measure: Some(measure),\n            connection: Some(connection),')
  .replaceAll('        drop(self.connection.take());', '        if let (Some(connection), Some(measure)) = (self.connection.take(), self.measure.take()) { crate::database::measure_return(connection, measure); }');
if ((commit.match(/crate::database::measure_return/g) || []).length !== 2) throw new Error('Send/watermark COMMIT and ROLLBACK return instrumentation must both match');
// HTTP in-flight includes auth/admission/pool waits but excludes established sockets.
let obs = read('observability.rs');
obs = obs.replace('    // Never reflect inbound', '    let _measure_http = crate::database::MeasureHttp::new();\n    // Never reflect inbound');
db += `
// External instrumentation only: atomic counters plus 1/128 lifetime samples.
use std::sync::atomic::{AtomicU64, Ordering::Relaxed};
tokio::task_local! { static MEASURE_OPERATION: std::cell::Cell<&'static str>; }
pub(crate) fn measure_class(operation: &'static str) { let _ = MEASURE_OPERATION.try_with(|v| v.set(operation)); }
static MEASURE_N: AtomicU64 = AtomicU64::new(0);
static MEASURE_WAITING: AtomicU64 = AtomicU64::new(0);
static MEASURE_HELD: AtomicU64 = AtomicU64::new(0);
static MEASURE_HTTP: AtomicU64 = AtomicU64::new(0);
pub(crate) struct MeasureHttp;
impl MeasureHttp { pub(crate) fn new() -> Self { MEASURE_HTTP.fetch_add(1, Relaxed); Self } }
impl Drop for MeasureHttp { fn drop(&mut self) { MEASURE_HTTP.fetch_sub(1, Relaxed); } }
pub(crate) struct Measure {
    operation: &'static str, start: std::time::Instant, acquired: Option<std::time::Instant>,
    returning: Option<std::time::Instant>, sample: bool, wait_us: u128, active: u32, waiting: u64, http: u64,
}
impl Measure {
    pub(crate) fn new(operation: &'static str, _pool: &PgPool) -> Self {
        let waiting = MEASURE_WAITING.fetch_add(1, Relaxed) + 1;
        Self { operation, start: std::time::Instant::now(), acquired: None,
            returning: None, sample: ${process.env.DM_INSTRUMENT_ALL === '1' ? 'true' : 'false'} || MEASURE_N.fetch_add(1, Relaxed) % 128 == 0 || operation.contains("reclamation"), wait_us: 0, active: 0,
            waiting, http: MEASURE_HTTP.load(Relaxed) }
    }
    pub(crate) fn acquired(&mut self, pool: &PgPool) {
        self.wait_us = self.start.elapsed().as_micros();
        self.acquired = Some(std::time::Instant::now());
        MEASURE_WAITING.fetch_sub(1, Relaxed); MEASURE_HELD.fetch_add(1, Relaxed);
        self.active = pool.size().saturating_sub(pool.num_idle() as u32);
    }
}
// Same asynchronous return/ping as PoolConnection::Drop, with the timer owned
// by that future until the slot has actually been returned. Failure/discard
// paths keep the existing close/detach behavior and end at owner disposal.
pub(crate) fn measure_return(mut connection: PoolConnection<Postgres>, mut measure: Measure) {
    measure.operation = MEASURE_OPERATION.try_with(|v| v.get()).unwrap_or(measure.operation);
    measure.returning = Some(std::time::Instant::now());
    let returned = connection.return_to_pool();
    tokio::spawn(async move { returned.await; drop(measure); });
}
impl Drop for Measure {
    fn drop(&mut self) {
        let held_us = if let Some(start) = self.acquired { MEASURE_HELD.fetch_sub(1, Relaxed); start.elapsed().as_micros() } else { MEASURE_WAITING.fetch_sub(1, Relaxed); 0 };
        if self.sample || self.acquired.is_none() {
            eprintln!("event=measure_hold op={} wait_us={} hold_us={} active={} waiting={} http={} acquired={} at_ms={} return_us={}", MEASURE_OPERATION.try_with(|v| v.get()).unwrap_or(self.operation),
                if self.acquired.is_some() { self.wait_us } else { self.start.elapsed().as_micros() }, held_us,
                self.active, self.waiting, self.http, self.acquired.is_some(),
                std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis()), self.returning.map_or(0, |t| t.elapsed().as_micros()));
        }
    }
}
`;
write('messages/dms.rs', read('messages/dms.rs')
  .replace('                let selected = dms::select(tx, &auth, None, Some(&[id])).await?;', '                crate::database::measure_class(if created { "dm_create" } else if notice.is_some() { "dm_renew_lapsed" } else if input.renew { "dm_renew_noop" } else { "dm_resolve" });\n                let selected = dms::select(tx, &auth, None, Some(&[id])).await?;')
  .replace('"messages/dms.rs:list",', 'if query.as_ref().is_ok_and(|q| q.0.iter().any(|(k,_)| k == "channel_id")) { "dm_refresh" } else { "dm_page" },'));
write('database.rs', db); write('database/context.rs', context); write('messages/commit.rs', commit); write('observability.rs', obs);
writeFileSync(`${output}/instrumentation.txt`, 'Every shared database/context helper and send/watermark owner labelled; atomic in-flight HTTP, acquisition and hold counters; 1/128 lifetime samples (DM_INSTRUMENT_ALL=1 selects all for isolated probes), every unacquired drop (cancellation/error). Successful hold ends after the ordinary asynchronous SQLx return/ping releases the slot (return_us separately). Includes non-SQL body work, awaits/locks. Error/discard paths end at owner disposal, so graceful error-close cleanup remains a lower bound. Readiness, bootstrap/sign-in raw pool.begin excluded. SQL time measured separately using pg_stat_statements, not subtracted per request. No production source edits.\n');
execFileSync('docker', ['build', '-t', process.env.DM_INSTRUMENT_IMAGE || 'fukulow-151m:instrumented', source], { stdio: 'inherit' });
