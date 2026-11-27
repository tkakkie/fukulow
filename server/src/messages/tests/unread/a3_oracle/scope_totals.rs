use super::*;

type Append = (i64, Option<Uuid>, Uuid);

async fn assert_appends(world: &World, pool: &PgPool, appends: &[Append], step: &str) {
    world.assert_oracle(pool, step).await;
    let channel = world.channels[0];
    let scopes: Vec<Uuid> = sqlx::query_scalar(
        "SELECT id FROM topics WHERE organization_id=$1 AND channel_id=$2
         UNION ALL SELECT '00000000-0000-0000-0000-000000000000'",
    )
    .bind(world.org)
    .bind(channel)
    .fetch_all(pool)
    .await
    .unwrap();
    let top: i64 = sqlx::query_scalar(
        "SELECT seq FROM channel_message_sequences WHERE organization_id=$1 AND channel_id=$2",
    )
    .bind(world.org)
    .bind(channel)
    .fetch_one(pool)
    .await
    .unwrap();
    let prefixes = sqlx::query_as::<_, (Uuid, Uuid, i64, i64, i64, i64, i64)>(
        "SELECT scope, reader, seq, o.ordinal, o.own_ordinal, r.appended, r.own_appended
         FROM unnest($3::uuid[]) scope CROSS JOIN unnest($4::uuid[]) reader
         CROSS JOIN generate_series(0::bigint,$5) seq
         CROSS JOIN LATERAL message_count_ordinals($1,$2,scope,reader,seq) o
         CROSS JOIN LATERAL message_count_range($1,$2,scope,reader,GREATEST(0,seq-2),seq) r",
    )
    .bind(world.org)
    .bind(channel)
    .bind(scopes)
    .bind(world.members.iter().map(|(id, _)| *id).collect::<Vec<_>>())
    .bind(top)
    .fetch_all(pool)
    .await
    .unwrap();
    for (scope, reader, seq, ordinal, own, range, own_range) in prefixes {
        let mut expected = (0, 0, 0, 0);
        for &(created, topic, sender) in appends {
            if topic.unwrap_or_default() == scope && created <= seq {
                expected.0 += 1;
                expected.1 += i64::from(sender == reader);
                if created > seq - 2 {
                    expected.2 += 1;
                    expected.3 += i64::from(sender == reader);
                }
            }
        }
        assert_eq!(
            (ordinal, own, range, own_range),
            expected,
            "{step}: {scope}/{reader}/{seq}"
        );
    }
}

fn id(message: &Value, key: &str) -> Uuid {
    Uuid::parse_str(message[key].as_str().unwrap()).unwrap()
}

#[fukulow_test::test]
async fn scope_totals_preserve_a3_appends_across_every_write_path(pool: PgPool) {
    let world = World::new(&pool).await;
    let org = world.org;
    let channel = world.channels[0];
    let (sender, token) = &world.members[0];
    let (viewer, viewer_token) = &world.members[1];
    let input =
        json!({"client_message_id":Uuid::new_v4(),"body":format!("@{{member:{viewer}}} main")});
    let main = sent(&world.app, token, channel, input.clone()).await;
    let mut appends = vec![(1, None, *sender)];
    assert_appends(&world, &pool, &appends, "main send with Mention").await;
    let retry = sent(&world.app, token, channel, input).await;
    assert_eq!(retry["id"], main["id"]);
    assert_appends(&world, &pool, &appends, "retry").await;

    let a = post(&world.app, token, channel, Some("A")).await;
    let a_id = id(&a, "topic_id");
    appends.push((2, Some(a_id), *sender));
    assert_appends(&world, &pool, &appends, "first Message creates Topic A").await;
    let b = post(&world.app, viewer_token, channel, Some("B")).await;
    let b_id = id(&b, "topic_id");
    appends.push((3, Some(b_id), *viewer));
    post(&world.app, token, channel, Some("A")).await;
    appends.push((4, Some(a_id), *sender));
    mark(
        &world.app,
        viewer_token,
        channel,
        Some(a["topic_id"].as_str().unwrap()),
        2,
    )
    .await;
    assert_appends(
        &world,
        &pool,
        &appends,
        "second Message in A and a persisted position",
    )
    .await;

    // The older image's INSERT omits the marker. Its separate sequence/Topic
    // writes do not increment either F2 column.
    historical_post(&pool, org, *viewer, channel, None).await;
    historical_post(&pool, org, *viewer, channel, Some("B")).await;
    appends.extend([(5, None, *viewer), (6, Some(b_id), *viewer)]);
    assert_appends(&world, &pool, &appends, "older-image main and Topic sends").await;

    let deleted = Uuid::new_v4();
    let mut tx = pool.begin().await.unwrap();
    sqlx::query("INSERT INTO messages (organization_id,id,channel_id,seq,sender,client_message_id,body,topic_id,deleted)
        VALUES ($1,$5,$2,7,$3,gen_random_uuid(),'already deleted',$4,true),
               ($1,gen_random_uuid(),$2,8,$3,gen_random_uuid(),'fixture',NULL,false)")
        .bind(org).bind(channel).bind(sender).bind(a_id).bind(deleted).execute(&mut *tx).await.unwrap();
    sqlx::query(
        "UPDATE channel_message_sequences SET seq=8 WHERE organization_id=$1 AND channel_id=$2",
    )
    .bind(org)
    .bind(channel)
    .execute(&mut *tx)
    .await
    .unwrap();
    tx.commit().await.unwrap();
    appends.extend([(7, Some(a_id), *sender), (8, None, *sender)]);
    assert_appends(
        &world,
        &pool,
        &appends,
        "direct multi-row INSERT including send-as-deleted",
    )
    .await;
    // Give the legacy Message Mentions before changing which Messages count.
    sqlx::query("INSERT INTO message_mentions (organization_id,channel_id,message_id,member_id) VALUES ($1,$2,$3,$4)")
        .bind(org).bind(channel).bind(deleted).bind(viewer).execute(&pool).await.unwrap();

    for (step, seq, topic, deleted) in [
        ("undelete", 7, Some(a_id), false),
        ("Delete of a mentioned Message", 1, None, true),
        ("undelete of a mentioned Message", 1, None, false),
        ("main to Topic", 1, Some(b_id), false),
        ("partial Topic to Topic", 2, Some(b_id), false),
        (
            "Topic to main, leaving A with other Messages",
            4,
            None,
            false,
        ),
        ("last live Message leaves A", 7, Some(b_id), false),
    ] {
        sqlx::query("UPDATE messages SET topic_id=$4,deleted=$5 WHERE organization_id=$1 AND channel_id=$2 AND seq=$3")
            .bind(org).bind(channel).bind(seq).bind(topic).bind(deleted).execute(&pool).await.unwrap();
        resync_topics(&pool, org, channel).await;
        assert_appends(&world, &pool, &appends, step).await;
    }
    assert!(
        sqlx::query_scalar::<_, bool>("SELECT last_seq IS NULL AND message_count=0 AND scope_appended=2
                                      FROM topics WHERE organization_id=$1 AND channel_id=$2 AND id=$3")
            .bind(org).bind(channel).bind(a_id).fetch_one(&pool).await.unwrap()
    );
    // Owner-only hard delete of a moved and mentioned Message must preserve its
    // original main append while cancelling the live correction in B.
    sqlx::query("DELETE FROM messages WHERE organization_id=$1 AND channel_id=$2 AND seq=1")
        .bind(org)
        .bind(channel)
        .execute(&pool)
        .await
        .unwrap();
    resync_topics(&pool, org, channel).await;
    assert_appends(&world, &pool, &appends, "hard delete after Move").await;
    world.reader.close().await;
}

#[fukulow_test::test]
async fn scope_totals_concurrent_first_sends_create_one_topic(pool: PgPool) {
    let world = World::new(&pool).await;
    let channel = world.channels[0];
    let (sender, token) = &world.members[0];
    let key = Uuid::new_v4();
    let commit = crate::messages::commit::ambiguous_commit(key);
    let first = json!({"client_message_id":key,"body":"first","topic_name":"First"});
    let response = send(&world.app, token, channel, first.clone()).await;
    assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
    let held = commit.await.unwrap();

    // A second instance has independent admission and reaches the database barrier.
    let app = router(&pool).await;
    let (other, other_token) = world.members[1].clone();
    let pending =
        tokio::spawn(async move { post(&app, &other_token, channel, Some("First")).await });
    wait_blocked(
        &pool,
        Blocked::Advisory(Advisory::Query("%pg_advisory_xact_lock(hashtextextended%")),
        Count::Exactly(1),
        Duration::from_secs(5),
    )
    .await;
    held.commit().await.unwrap();
    let second = pending.await.unwrap();
    let retry = sent(&world.app, token, channel, first).await;
    let topic = id(&second, "topic_id");
    assert_eq!(id(&retry, "topic_id"), topic);
    assert_appends(
        &world,
        &pool,
        &[(1, Some(topic), *sender), (2, Some(topic), other)],
        "concurrent first sends and retry",
    )
    .await;
    world.reader.close().await;
}

#[fukulow_test::test]
async fn scope_totals_send_and_delete_commit_in_either_order(pool: PgPool) {
    let world = World::new(&pool).await;
    let channel = world.channels[0];
    let (sender, token) = &world.members[0];
    let (other, other_token) = &world.members[1];
    let mut appends = Vec::new();

    for delete_first in [false, true] {
        let old = post(&world.app, token, channel, Some("Race")).await;
        let topic = id(&old, "topic_id");
        let seq = old["created_seq"].as_i64().unwrap();
        appends.push((seq, Some(topic), *sender));

        let mut deleting = pool.begin().await.unwrap();
        sqlx::query("UPDATE messages SET deleted=true WHERE organization_id=$1 AND channel_id=$2 AND seq=$3")
            .bind(world.org).bind(channel).bind(seq).execute(&mut *deleting).await.unwrap();

        let key = Uuid::new_v4();
        let commit = crate::messages::commit::ambiguous_commit(key);
        let response = send(
            &world.app,
            other_token,
            channel,
            json!({"client_message_id":key,"body":"overlapping send","topic_name":"Race"}),
        )
        .await;
        assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
        let sending = commit.await.unwrap();
        if delete_first {
            deleting.commit().await.unwrap();
            sending.commit().await.unwrap();
        } else {
            sending.commit().await.unwrap();
            deleting.commit().await.unwrap();
        }
        appends.push((seq + 1, Some(topic), *other));
        resync_topics(&pool, world.org, channel).await;
        assert_appends(
            &world,
            &pool,
            &appends,
            &format!("Delete commits first={delete_first}"),
        )
        .await;
    }
    world.reader.close().await;
}
