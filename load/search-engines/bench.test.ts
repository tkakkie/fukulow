import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { appSessionArguments, benchmark, sql, SqlStatementTimeoutError } from './bench.ts';

for (const client of ['psql','pgbench']) {
  test(`${client}: app timeout is set and SQL cancellation invalidates rather than sampling`,async t=>{
    const dir = mkdtempSync(join(tmpdir(),'search-sql-timeout-'));
    const before = process.env.PATH;
    t.after(()=>{process.env.PATH=before;rmSync(dir,{recursive:true,force:true});});
    const calls = join(dir,'calls');
    writeFileSync(join(dir,'docker'),`#!${process.execPath}
import {appendFileSync} from 'node:fs';
const args=process.argv.slice(2);
appendFileSync(${JSON.stringify(calls)},JSON.stringify(args)+'\\n');
if (args.includes('psql') || args.includes('pgbench')) {
 console.error('ERROR: 57014: canceling statement due to statement timeout');
 process.exit(1);
}
`,{mode:0o755});
    process.env.PATH=dir+':'+before;
    if (client==='psql') assert.throws(()=>sql('test','test','SELECT pg_sleep(1);','fukulow_app'),SqlStatementTimeoutError);
    else await assert.rejects(()=>benchmark('test','test','SELECT pg_sleep(1);',join(dir,'slow'),1,1),SqlStatementTimeoutError);
    const args: string[][] = readFileSync(calls,'utf8').trim().split('\n').map(line=>JSON.parse(line));
    const measured = args.find(args=>args.includes(client));
    assert.ok(measured);
    assert.equal(measured.includes(appSessionArguments[1]!),true);
    assert.equal(appSessionArguments[1],'PGOPTIONS=-c statement_timeout=10000');
    if (client==='psql') assert.ok(measured.includes('ON_ERROR_STOP=1'));
  });
}

test('pgbench reported failures invalidate even a zero exit before parsing latency logs',async t=>{
  const dir = mkdtempSync(join(tmpdir(),'search-failed-sample-'));
  const before = process.env.PATH;
  t.after(()=>{process.env.PATH=before;rmSync(dir,{recursive:true,force:true});});
  writeFileSync(join(dir,'docker'),`#!${process.execPath}
if (process.argv.includes('pgbench')) console.log('number of failed transactions: 1 (100%)');
`,{mode:0o755});
  process.env.PATH=dir+':'+before;
  await assert.rejects(()=>benchmark('test','test','SELECT 1;',join(dir,'failed'),1,1),/pgbench failed; entire run invalid/);
  assert.match(readFileSync(join(dir,'failed.sql'),'utf8'),/current_setting\('statement_timeout'\)/);
});

test('a throughput number containing 57014 is not SQLSTATE error syntax',async t=>{
  const dir = mkdtempSync(join(tmpdir(),'search-throughput-'));
  const before = process.env.PATH;
  t.after(()=>{process.env.PATH=before;rmSync(dir,{recursive:true,force:true});});
  writeFileSync(join(dir,'docker'),`#!${process.execPath}
import {mkdirSync,writeFileSync} from 'node:fs';
const args=process.argv.slice(2);
if (args.includes('pgbench')) console.log('number of failed transactions: 0 (0%)\\ntps = 57014.123');
if (args[0]==='cp' && args[1].includes(':/tmp/')) {
 mkdirSync(args[2]);writeFileSync(args[2]+'/log','0 0 1000 0 0 0\\n');
}
`,{mode:0o755});
  process.env.PATH=dir+':'+before;
  const result = await benchmark('test','test','SELECT 1;',join(dir,'success'),1,1);
  assert.equal(result.tps,57014.123);
  assert.equal(result.n,1);
});
