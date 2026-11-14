// Measurement-only source copy. Never changes production source or its image tag.
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { outsideCheckout } from './dms-workload.ts';
const output = resolve(process.env.DM_INSTRUMENT_OUT || '');
if (!process.env.DM_INSTRUMENT_OUT || !outsideCheckout(output, resolve('.'))) throw new Error('DM_INSTRUMENT_OUT must be outside checkout');
mkdirSync(output, { recursive: true });
const source = `${output}/source`;
cpSync(resolve('.'), source, { recursive: true, filter: path => !path.split('/').some(part => ['.git','node_modules','target','dist'].includes(part)) });
for (const path of ['server/src/database.rs', 'server/src/database/context.rs']) {
  let text = readFileSync(`${source}/${path}`, 'utf8');
  text = text.replaceAll('pool.acquire().await?', 'crate::database::measure_acquire(pool).await?');
  if (path.endsWith('database.rs')) text += `
// External measurement-only instrumentation: sample 1/128 acquisitions and every error.
pub(crate) async fn measure_acquire(pool: &PgPool) -> Result<PoolConnection<Postgres>, sqlx::Error> {
    static N: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let start = std::time::Instant::now();
    let result = pool.acquire().await;
    if N.fetch_add(1, std::sync::atomic::Ordering::Relaxed) % 128 == 0 || result.is_err() {
        eprintln!("event=measure_pool us={} active={} size={} error={}", start.elapsed().as_micros(), pool.size().saturating_sub(pool.num_idle() as u32), pool.size(), result.is_err());
    }
    result
}
`;
  writeFileSync(`${source}/${path}`, text);
}
writeFileSync(`${output}/instrumentation.txt`, 'Sample 1/128 successful explicit database/context acquisitions; every acquisition error. Readiness and sign-in/bootstrap pool.begin are excluded. No production source edits.\n');
execFileSync('docker', ['build', '-t', process.env.DM_INSTRUMENT_IMAGE || 'fukulow-151m:instrumented', source], { stdio: 'inherit' });
