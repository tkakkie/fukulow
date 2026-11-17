use super::*;
use crate::messages::replies::counts::COUNTS_SQL;

#[fukulow_test::test]
#[ignore = "manual #409 RLS EXPLAIN; not a load measurement or p95 gate"]
async fn reply_count_query_plans(pool: PgPool) {
    let (_, org, sender, channel, _) = fixture(&pool).await;
    let roots = (0..100).map(|_| Uuid::new_v4()).collect::<Vec<_>>();
    sqlx::query("INSERT INTO topics (organization_id,channel_id,id,name,first_seq,last_seq,message_count) SELECT $1,$2,gen_random_uuid(),'Topic '||n,11101+n,99101+n,44 FROM generate_series(1,2000) n")
        .bind(org).bind(channel).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO messages (organization_id,channel_id,id,seq,sender,client_message_id,body) SELECT $1,$2,id,n,$3,gen_random_uuid(),'Root' FROM unnest($4::uuid[]) WITH ORDINALITY r(id,n)")
        .bind(org).bind(channel).bind(sender).bind(&roots).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO messages (organization_id,channel_id,id,seq,sender,client_message_id,body,reply_to_id,reply_root_id) SELECT $1,$2,gen_random_uuid(),100+(n-1)*10+k,$3,gen_random_uuid(),'Reply',id,id FROM unnest($4::uuid[]) WITH ORDINALITY r(id,n) CROSS JOIN generate_series(1,10) k")
        .bind(org).bind(channel).bind(sender).bind(&roots).execute(&pool).await.unwrap();
    let long = Uuid::new_v4();
    sqlx::query("INSERT INTO messages (organization_id,channel_id,id,seq,sender,client_message_id,body) VALUES ($1,$2,$3,1101,$4,gen_random_uuid(),'Long root')")
        .bind(org).bind(channel).bind(long).bind(sender).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO messages (organization_id,channel_id,id,seq,sender,client_message_id,body,reply_to_id,reply_root_id) SELECT $1,$2,gen_random_uuid(),n,$3,gen_random_uuid(),'Long Reply',$4,$4 FROM generate_series(1102,11101) n")
        .bind(org).bind(channel).bind(sender).bind(long).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO messages (organization_id,channel_id,id,seq,sender,client_message_id,body,topic_id) SELECT $1,$2,gen_random_uuid(),11101+n+2000*k,$3,gen_random_uuid(),'Unrelated Topic',id FROM (SELECT id,row_number() OVER (ORDER BY id) n FROM topics WHERE organization_id=$1 AND channel_id=$2) t CROSS JOIN generate_series(0,44) k WHERE 11101+n+2000*k<=100000")
        .bind(org).bind(channel).bind(sender).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO channel_message_sequences VALUES ($1,$2,100000)")
        .bind(org)
        .bind(channel)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("VACUUM (ANALYZE) messages")
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM messages WHERE organization_id=$1")
            .bind(org)
            .fetch_one(&pool)
            .await
            .unwrap(),
        100000
    );
    let app = crate::test_app_pool(pool.clone()).await;
    let flags: (bool, bool) =
        sqlx::query_as("SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user")
            .fetch_one(&app)
            .await
            .unwrap();
    assert_eq!(flags, (false, false));
    for mode in ["force_custom_plan", "force_generic_plan"] {
        crate::database::organization_read_only(&app,org,async |tx:&mut sqlx::PgConnection| {
            assert!(sqlx::query_scalar::<_,bool>("SELECT row_security_active('messages')").fetch_one(&mut *tx).await?);
            sqlx::query("SET LOCAL jit=off").execute(&mut *tx).await?;
            sqlx::query("SELECT set_config('plan_cache_mode',$1,true)").bind(mode).execute(&mut *tx).await?;
            sqlx::raw_sql(&format!("PREPARE reply_counts409(uuid,uuid,uuid[],bigint) AS {COUNTS_SQL}")).execute(&mut *tx).await?;
            for (label,ids,count) in [("batch100",roots.clone(),10_i64),("long10000",vec![long],10000)] {
                let rows=sqlx::query(COUNTS_SQL).bind(org).bind(channel).bind(&ids).bind(100000_i64).fetch_all(&mut *tx).await?;
                assert_eq!(rows.len(),ids.len());
                for row in rows { assert_eq!(sqlx::Row::get::<i64,_>(&row,"reply_count"),count); }
                // UUID formatting is restricted to typed fixture ids, never request text.
                let literals=ids.iter().map(|id| format!("'{id}'::uuid")).collect::<Vec<_>>().join(",");
                let explain=format!("EXPLAIN (ANALYZE,BUFFERS) EXECUTE reply_counts409('{org}','{channel}',ARRAY[{literals}],100000)");
                let plan:Vec<String>=sqlx::query_scalar(&explain).persistent(false).fetch_all(&mut *tx).await?;
                eprintln!("REPLY_COUNTS_PLAN mode={mode} case={label} messages=100000 topics=2000 role=restricted NOBYPASSRLS\n{}",plan.join("\n"));
                assert!(plan.join("\n").contains("messages_reply_chain_seq"));
            }
            sqlx::query("DEALLOCATE reply_counts409").execute(&mut *tx).await?;
            Ok::<_,sqlx::Error>(())
        }).await.unwrap();
    }
}
