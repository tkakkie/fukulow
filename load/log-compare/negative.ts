import assert from 'node:assert/strict';
import { Database } from './database.ts';
import { setup, correctness, replayFixture } from './measure.ts';
import { org, record } from './sql.ts';

// Run in the smoke's owned disposable DB, before measured arms reset it.
export async function databaseNegatives(db:Database) {
  await replayFixture(db,'events-snapshot',10000,'creation');
  assert.deepEqual(await correctness(db,'events-snapshot'),{missing:0,resurrected:0,retryPositions:0});
  db.sql('DELETE FROM creation_snapshots WHERE position=500');
  assert.ok((await correctness(db,'events-snapshot')).missing>0,'missing unsampled snapshot must fail');
  for(const arm of ['baseline','events-ids','events-snapshot','log-ids','log-snapshot'] as const) {
    await setup(db,arm,1,1000);
    db.sql("BEGIN; SELECT apply_op(1,42,3,'',false,false); COMMIT;");
    assert.deepEqual(await correctness(db,arm),{missing:0,resurrected:0,retryPositions:0});
    db.sql(`DO $$ DECLARE ch uuid:=fixture_id(1,0); r messages%ROWTYPE; p bigint; BEGIN
      ${arm==='baseline'? 'p:=1001;' : `UPDATE channel_message_sequences SET seq=seq+1 WHERE organization_id=${org} AND channel_id=ch RETURNING seq INTO p;`}
      UPDATE messages SET deleted=false,body='revived',version=version+1
        WHERE organization_id=${org} AND id=fixture_id(1,100+((42%1000000)*16+42/1000000)%900) RETURNING * INTO r;
      ${record(arm,"'Edit'",'r','p')}
    END $$;`);
    assert.ok((await correctness(db,arm)).resurrected>0,`${arm}: historical Delete must reject final/later revival`);
  }
  return ['missing_creation_snapshot_position_500','historical_delete_then_revive_all_five_arms'];
}
