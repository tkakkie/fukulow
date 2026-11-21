import assert from 'node:assert/strict';
import { channel, literal, org } from '../../search-engines/seed.ts';
import { scaledBytes, summarize } from './evidence.ts';
import { context } from './model.ts';

type Sql = (text: string, role?: string) => string;

export function measureSize(sql: Sql, d3GroongaFiles: number) {
  const [count,termRows,messageTable,termTable,termMaintenance,termPGRelation,channelRecent] = sql(`
    SELECT (SELECT count(*) FROM public.messages),(SELECT count(*) FROM public.search_terms),
      pg_table_size('public.messages'),pg_table_size('public.search_terms'),
      pg_relation_size('public.search_terms_message'),pg_relation_size('public.search_terms_exact'),
      pg_relation_size('public.search_channel_recent');`).split('|').map(Number) as
      [number,number,number,number,number,number,number];
  const scale = (bytes: number) => scaledBytes(bytes,count);
  const [recentRows,recentTable,recentMaintenance,recentKey] = sql(`
    SELECT count(*), pg_table_size('public.search_terms_recent'),
      pg_relation_size('public.search_terms_recent_message'), pg_relation_size('public.search_terms_recent_key')
    FROM public.search_terms_recent;`).split('|').map(Number) as [number,number,number,number];
  assert.equal(count,24007);
  assert.equal(recentRows,termRows);
  return {messages:count,termRows,termsPerMessage:termRows/count,sharedMessagesTable:scale(messageTable),
    d3:{termTable:scale(termTable),maintenanceIndex:scale(termMaintenance),
      exactIndexRelation:scale(termPGRelation),groongaFileDeltaAtBuild:scale(d3GroongaFiles),
      totalAdded:scale(termTable+termMaintenance+termPGRelation+d3GroongaFiles)},
    d3r:{termRows:recentRows,termTable:scale(recentTable),maintenanceIndex:scale(recentMaintenance),
      recencyKeyIndex:scale(recentKey),totalAdded:scale(recentTable+recentMaintenance+recentKey)},
    d4:{recencyIndex:scale(channelRecent)}};
}

export function measureWrites(sql: Sql, writer: string, repetitions: number, variant: 'd3'|'d3r') {
  const table = variant === 'd3' ? 'search_terms' : 'search_terms_recent';
  const unused = variant === 'd3' ? 'search_terms_recent' : 'search_terms';
  sql(`DROP TRIGGER ${unused}_remove ON public.messages;
    DROP TRIGGER ${unused}_store ON public.messages;
    DROP TABLE public.${unused};`);
  // Each database keeps only the Message PK and the measured strategy's indexes.
  sql('DROP INDEX public.search_body, public.search_channel_recent; CHECKPOINT;');
  const id = 950001;
  const tenant = literal(org(1));
  const body = literal('開発の確認をお願いします。 note 42。');
  const newBody = literal('資料を更新したので午後に相談しましょう。 note 23。');
  const message = `organization_id=${tenant} AND id=${id}`;
  const operations = {
    send:`INSERT INTO public.messages VALUES
      (${tenant},${id},${literal(channel(1,1))},'2026-11-14',${body});`,
    edit:`UPDATE public.messages SET body=${newBody} WHERE ${message};`,
    delete:`DELETE FROM public.messages WHERE ${message};`,
  };
  const snapshot = `BEGIN READ ONLY;\n${context}
    SELECT (SELECT count(*) FROM public.messages WHERE ${message}),
      (SELECT coalesce(sum(pg_column_size(m)),0) FROM public.messages m WHERE ${message}),
      count(*),coalesce(sum(pg_column_size(t)),0) FROM public.${table} t
    WHERE organization_id=${tenant} AND message_id=${id};
    COMMIT;\n`;
  const write = (statement: string) => snapshot
    + `SELECT clock_timestamp() AS started, pg_current_wal_insert_lsn() AS wal_start \\gset
    BEGIN;\n${context}${statement}\nCOMMIT;
    SELECT extract(epoch FROM clock_timestamp()-:'started'::timestamptz)*1000,
      pg_wal_lsn_diff(pg_current_wal_insert_lsn(),:'wal_start'::pg_lsn);\n` + snapshot;
  const output = sql((Object.values(operations).map(write).join('\n')).repeat(repetitions),writer)
    .split('\n').map(line=>line.split('|').map(Number));
  assert.equal(output.length,repetitions*9);
  return Object.keys(operations).map((operation,i)=>{
    const values = Array.from({length:repetitions},(_,r)=>{
      const [before,timing,after] = output.slice(r*9+i*3,r*9+i*3+3);
      const expected = [[0,1],[1,1],[1,0]][i];
      assert.deepEqual([before![0],after![0]],expected);
      assert.equal(before![2]!>0,expected![0]===1);
      assert.equal(after![2]!>0,expected![1]===1);
      assert.ok(timing![1]!>0);
      return {elapsedMs:timing![0]!,walBytes:timing![1]!,
        rowsWritten:{messages:after![0],terms:after![2]},
        logicalTupleBytesWritten:{messages:after![1],terms:after![3]},
        previousRowsRetired:{messages:before![0],terms:before![2]},
        previousLogicalTupleBytesRetired:{messages:before![1],terms:before![3]}};
    });
    return {operation,latencyMs:summarize(values.map(v=>v.elapsedMs)),
      walBytes:summarize(values.map(v=>v.walBytes)),samples:values};
  });
}
