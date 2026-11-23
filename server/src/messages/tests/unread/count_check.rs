use super::*;
use sqlx::PgConnection;
use std::collections::BTreeSet;

type Discrepancy = (String, Uuid, Uuid, Uuid, Option<i64>, Option<i64>);

async fn compare_checks(conn: &mut PgConnection, org: Uuid) -> Vec<Discrepancy> {
    let old: Vec<Discrepancy> = sqlx::query_as(
        "SELECT * FROM message_counts_check_before_update_first($1) ORDER BY 1,2,3,4,5,6",
    )
    .bind(org)
    .fetch_all(&mut *conn)
    .await
    .unwrap();
    let new: Vec<Discrepancy> =
        sqlx::query_as("SELECT * FROM message_counts_check($1) ORDER BY 1,2,3,4,5,6")
            .bind(org)
            .fetch_all(conn)
            .await
            .unwrap();
    assert_eq!(new, old);
    new
}

#[fukulow_test::test(migrations = false)]
async fn message_counts_check_matches_its_previous_definition(pool: PgPool) {
    let mut previous = sqlx::migrate!();
    previous
        .migrations
        .to_mut()
        .retain(|migration| migration.version < 202611231100);
    previous.run(&pool).await.unwrap();
    let definition: String = sqlx::query_scalar(
        "SELECT pg_get_functiondef('public.message_counts_check(uuid)'::regprocedure)",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    sqlx::raw_sql(&definition.replacen(
        "FUNCTION public.message_counts_check(",
        "FUNCTION public.message_counts_check_before_update_first(",
        1,
    ))
    .execute(&pool)
    .await
    .unwrap();
    sqlx::migrate!().run(&pool).await.unwrap();

    let (app, org, sender, channel, owner) = fixture(&pool).await;
    let other = Uuid::new_v4();
    let other_token = member(&pool, org, other).await;
    let mentioned = post(&app, &owner, channel, None).await;
    let topic = post(&app, &other_token, channel, Some("Topic")).await;
    let moved = post(&app, &owner, channel, None).await;
    post(&app, &owner, channel, Some("Topic")).await;
    let topic = topic["topic_id"].as_str().unwrap();
    let topic_id = Uuid::parse_str(topic).unwrap();
    mark(&app, &owner, channel, None, 3).await;
    mark(&app, &owner, channel, Some(topic), 4).await;
    mark(&app, &other_token, channel, Some(topic), 3).await;
    let newcomer = Uuid::new_v4();
    member(&pool, org, newcomer).await;

    let mut tx = pool.begin().await.unwrap();
    sqlx::query("INSERT INTO message_mentions (organization_id,channel_id,message_id,member_id) VALUES ($1,$2,$3,$4)")
        .bind(org).bind(channel).bind(Uuid::parse_str(mentioned["id"].as_str().unwrap()).unwrap()).bind(other)
        .execute(&mut *tx).await.unwrap();
    // Both signs of correction at a read position, plus a later Message in the same Topic.
    sqlx::query("UPDATE messages SET topic_id=$3 WHERE organization_id=$1 AND id=$2")
        .bind(org)
        .bind(Uuid::parse_str(moved["id"].as_str().unwrap()).unwrap())
        .bind(topic_id)
        .execute(&mut *tx)
        .await
        .unwrap();
    assert!(compare_checks(&mut tx, org).await.is_empty());

    let nil = Uuid::nil();
    sqlx::query("DELETE FROM message_append_counts WHERE organization_id=$1 AND channel_id=$2 AND scope_id=$3 AND member_id=$4")
        .bind(org).bind(channel).bind(nil).bind(sender).execute(&mut *tx).await.unwrap();
    sqlx::query("INSERT INTO message_append_counts VALUES ($1,$2,$3,$4,7),($1,$2,$3,$5,0)")
        .bind(org)
        .bind(channel)
        .bind(nil)
        .bind(other)
        .bind(newcomer)
        .execute(&mut *tx)
        .await
        .unwrap();
    sqlx::query("UPDATE message_mentions SET counted=NOT counted WHERE organization_id=$1")
        .bind(org)
        .execute(&mut *tx)
        .await
        .unwrap();
    sqlx::raw_sql(
        "ALTER TABLE channel_read_positions DISABLE TRIGGER channel_read_positions_ordinals",
    )
    .execute(&mut *tx)
    .await
    .unwrap();
    sqlx::query("UPDATE channel_read_positions SET read_ordinal=read_ordinal+2, read_own_ordinal=read_own_ordinal+1 WHERE organization_id=$1 AND channel_id=$2 AND member_id=$3")
        .bind(org).bind(channel).bind(sender).execute(&mut *tx).await.unwrap();
    sqlx::query("DELETE FROM topic_read_positions WHERE organization_id=$1 AND channel_id=$2 AND topic_id=$3 AND member_id=$4")
        .bind(org).bind(channel).bind(topic_id).bind(newcomer).execute(&mut *tx).await.unwrap();
    sqlx::query(
        "UPDATE channel_message_sequences SET seq=3 WHERE organization_id=$1 AND channel_id=$2",
    )
    .bind(org)
    .bind(channel)
    .execute(&mut *tx)
    .await
    .unwrap();

    let differences = compare_checks(&mut tx, org).await;
    let kinds: BTreeSet<_> = differences.iter().map(|row| row.0.as_str()).collect();
    assert_eq!(
        kinds,
        BTreeSet::from([
            "above_counter",
            "appended",
            "mention",
            "ordinal",
            "own_ordinal",
            "position_above_counter",
        ])
    );
    assert!(differences.contains(&(
        "ordinal".into(),
        channel,
        topic_id,
        newcomer,
        Some(2),
        Some(0)
    )));
    assert!(differences.contains(&("appended".into(), channel, nil, sender, Some(2), Some(0))));
    assert!(differences.contains(&("appended".into(), channel, nil, other, Some(0), Some(7))));
    assert!(
        !differences
            .iter()
            .any(|row| row.0 == "appended" && row.3 == newcomer)
    );
    tx.rollback().await.unwrap();
}
