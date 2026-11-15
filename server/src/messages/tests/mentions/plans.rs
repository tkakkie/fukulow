use super::*;

#[fukulow_test::test]
#[ignore = "manual restricted-role EXPLAIN of Mention count ranges"]
async fn mention_count_query_plans(pool: PgPool) {
    let (_, org, sender, first, _) = fixture(&pool).await;
    let reader = Uuid::new_v4();
    member(&pool, org, reader).await;
    let mut channels = vec![first];
    for _ in 1..10 {
        let c = Uuid::new_v4();
        super::super::channel(&pool, org, c, sender, false).await;
        channels.push(c);
    }
    sqlx::query("INSERT INTO topics (organization_id,channel_id,id,name,first_seq,last_seq,message_count) SELECT $1,c,gen_random_uuid(),'Topic '||n,2*n-1,10000-20+2*n-1,500 FROM unnest($2::uuid[]) c CROSS JOIN generate_series(1,10) n")
        .bind(org).bind(&channels).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO messages (organization_id,channel_id,id,seq,sender,client_message_id,body) SELECT $1,c,gen_random_uuid(),2*n,$3,gen_random_uuid(),'plan' FROM unnest($2::uuid[]) c CROSS JOIN generate_series(1,5000) n")
        .bind(org).bind(&channels).bind(sender).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO messages (organization_id,channel_id,id,seq,sender,client_message_id,body,topic_id) SELECT $1,t.channel_id,gen_random_uuid(),t.first_seq+20*n,$2,gen_random_uuid(),'plan',t.id FROM topics t CROSS JOIN generate_series(0,499) n WHERE t.organization_id=$1")
        .bind(org).bind(sender).execute(&pool).await.unwrap();
    sqlx::query(
        "INSERT INTO channel_message_sequences SELECT $1,c,10000 FROM unnest($2::uuid[]) c",
    )
    .bind(org)
    .bind(&channels)
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO message_mentions SELECT organization_id,channel_id,id,$2 FROM messages WHERE organization_id=$1 AND seq%5=0").bind(org).bind(reader).execute(&pool).await.unwrap();
    for table in [
        "messages",
        "message_mentions",
        "topics",
        "channel_read_positions",
        "topic_read_positions",
        "channel_message_sequences",
        "users",
    ] {
        sqlx::query(&format!("ANALYZE {table}"))
            .execute(&pool)
            .await
            .unwrap();
    }
    let app_pool = crate::test_app_pool(pool.clone()).await;
    for read in [9900, 10000] {
        sqlx::query("UPDATE channel_read_positions SET read_seq=$3 WHERE organization_id=$1 AND member_id=$2").bind(org).bind(reader).bind(read).execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO topic_read_positions SELECT organization_id,channel_id,$2,id,$3 FROM topics WHERE organization_id=$1 ON CONFLICT (organization_id,channel_id,member_id,topic_id) DO UPDATE SET read_seq=EXCLUDED.read_seq").bind(org).bind(reader).bind(read).execute(&pool).await.unwrap();
        crate::database::organization_read_only(&app_pool,org,async |tx:&mut sqlx::PgConnection| {
            let query=format!("EXPLAIN (ANALYZE,BUFFERS) {}",crate::messages::unread::LIST_COUNTS_SQL);
            let plan:Vec<String>=sqlx::query_scalar(&query).bind(org).bind(reader).bind(0_i64).bind(&channels).fetch_all(&mut *tx).await?;
            eprintln!("MENTION_PLAN channel_list read={read}\n{}",plan.join("\n"));
            for (label,topic,w) in [("timeline",None,10000_i64),("topics",None,9950),("single_topic",Some(sqlx::query_scalar::<_,Uuid>("SELECT id FROM topics WHERE organization_id=$1 AND channel_id=$2 LIMIT 1").bind(org).bind(first).fetch_one(&mut *tx).await?),10000)] {
                let query=format!("EXPLAIN (ANALYZE,BUFFERS) {}",crate::messages::topics::projection::page_sql());
                let plan:Vec<String>=sqlx::query_scalar(&query).persistent(false).bind(org).bind(reader).bind(0_i64).bind(first).bind(w).bind(None::<i64>).bind(51_i64).bind(label!="timeline").bind(topic).fetch_all(&mut *tx).await?;
                eprintln!("MENTION_PLAN {label} read={read} W={w}\n{}",plan.join("\n"));
            }
            Ok::<_,sqlx::Error>(())
        }).await.unwrap();
    }
}
