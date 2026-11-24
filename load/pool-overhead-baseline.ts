// Exact reviewed instrumentation hunks. Pool configuration and all callers are excluded.
export const baselinePaths = ['server/src/database/stats.rs','server/src/database.rs','server/src/main.rs'] as const;
export function baselineSource(path:string, source:string):string {
  const replace=(before:string,after:string)=>{
    if(source.split(before).length!==2)throw new Error('Baseline hunk no longer matches: '+path);
    source=source.replace(before,after);
  };
  if(path===baselinePaths[0]) {
    replace('use std::{','#[cfg(test)]\nuse std::{');
    for(const item of ['const INTERVAL:', 'const WAIT_US:', 'const ACTIVE:', 'static STATS:', 'struct Histogram(', 'impl Histogram {', 'struct Stats {', 'impl Stats {', "struct Wait<'a> {", "impl Drop for Wait<'_> {", 'async fn report(', 'fn wait_us(']) {
      const start=source.indexOf(item);if(start<0)throw new Error('Missing instrumentation item');
      source=source.slice(0,start)+'#[cfg(test)]\n'+source.slice(start);
    }
    replace('pub async fn report_pool_periodically(pool: PgPool) {\n    #[cfg(test)]\n    if let Ok(stats) = TEST_STATS.try_with(std::sync::Arc::clone) {\n        return report(&stats, &pool).await;\n    }\n    report(&STATS, &pool).await;\n}\n\n','');
    replace('    STATS.acquire(pool).await','    #[cfg(test)]\n    return STATS.acquire(pool).await;\n    #[cfg(not(test))]\n    pool.acquire().await');
  } else if(path===baselinePaths[1]) replace('pub use stats::report_pool_periodically;\n','');
  else if(path===baselinePaths[2]) {
    replace('    let pool_metrics = tokio::spawn(fukulow_server::database::report_pool_periodically(\n        pool.clone(),\n    ));\n','');
    replace('    pool_metrics.abort();\n','');
  } else throw new Error('Path outside instrumentation allowlist');
  return source;
}
