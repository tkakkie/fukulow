use super::*;
use sqlx::{PgConnection, QueryBuilder};
use std::time::Duration;

async fn insert_messages(
    conn: &mut PgConnection,
    org: Uuid,
    channel: Uuid,
    rows: &[(i64, Uuid, Option<Uuid>)],
) {
    let mut query = QueryBuilder::new(
        "INSERT INTO messages (organization_id, channel_id, seq, sender, topic_id, id, client_message_id, body) ",
    );
    query.push_values(rows, |mut row, &(seq, sender, topic)| {
        row.push_bind(org)
            .push_bind(channel)
            .push_bind(seq)
            .push_bind(sender)
            .push_bind(topic)
            .push("gen_random_uuid()")
            .push("gen_random_uuid()")
            .push("'Append count fixture'");
    });
    query.build().execute(conn).await.unwrap();
}

async fn assert_counts(
    conn: &mut PgConnection,
    org: Uuid,
    channel: Uuid,
    expected: &[(Uuid, Uuid, i64)],
) {
    let actual: Vec<(Uuid, Uuid, i64)> = sqlx::query_as(
        "SELECT scope_id, member_id, appended FROM message_append_counts
         WHERE organization_id=$1 AND channel_id=$2 ORDER BY scope_id, member_id",
    )
    .bind(org)
    .bind(channel)
    .fetch_all(conn)
    .await
    .unwrap();
    let mut expected = expected.to_vec();
    expected.sort_unstable();
    assert_eq!(actual, expected);
}

async fn empty_topic(pool: &PgPool, org: Uuid, channel: Uuid) -> Uuid {
    let topic = Uuid::new_v4();
    sqlx::query("INSERT INTO topics (organization_id, channel_id, id, name, message_count) VALUES ($1,$2,$3,'Topic',0)")
        .bind(org).bind(channel).bind(topic).execute(pool).await.unwrap();
    topic
}

#[fukulow_test::test]
async fn append_counts_update_existing_keys_without_inserting(pool: PgPool) {
    let (_, org, sender, channel, _) = fixture(&pool).await;
    let mut conn = pool.acquire().await.unwrap();
    let nil = Uuid::nil();
    insert_messages(&mut conn, org, channel, &[(1, sender, None)]).await;
    assert_counts(&mut conn, org, channel, &[(nil, nil, 1), (nil, sender, 1)]).await;

    // An upsert can produce the right totals while still taking the INSERT path.
    sqlx::raw_sql(
        "CREATE FUNCTION reject_append_count_insert() RETURNS trigger LANGUAGE plpgsql AS $$
         BEGIN RAISE EXCEPTION 'INSERT attempted for an existing append count'; END $$;
         CREATE TRIGGER reject_append_count_insert BEFORE INSERT ON message_append_counts
         FOR EACH ROW EXECUTE FUNCTION reject_append_count_insert();",
    )
    .execute(&mut *conn)
    .await
    .unwrap();
    insert_messages(&mut conn, org, channel, &[(2, sender, None)]).await;
    assert_counts(&mut conn, org, channel, &[(nil, nil, 2), (nil, sender, 2)]).await;
}

#[fukulow_test::test]
async fn append_counts_insert_new_keys(pool: PgPool) {
    let (_, org, sender, channel, _) = fixture(&pool).await;
    let mut conn = pool.acquire().await.unwrap();
    let nil = Uuid::nil();
    assert_counts(&mut conn, org, channel, &[]).await;
    insert_messages(&mut conn, org, channel, &[(1, sender, None)]).await;
    assert_counts(&mut conn, org, channel, &[(nil, nil, 1), (nil, sender, 1)]).await;
}

#[fukulow_test::test]
async fn append_counts_concurrent_first_inserts_accumulate(pool: PgPool) {
    let (_, org, sender, channel, _) = fixture(&pool).await;
    let topic = empty_topic(&pool, org, channel).await;
    let mut conn = pool.acquire().await.unwrap();
    insert_messages(&mut conn, org, channel, &[(1, sender, Some(topic))]).await;
    let mut first = pool.begin().await.unwrap();
    let mut second = pool.begin().await.unwrap();
    let pid: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
        .fetch_one(&mut *second)
        .await
        .unwrap();
    let nil = Uuid::nil();
    assert_counts(
        &mut first,
        org,
        channel,
        &[(topic, nil, 1), (topic, sender, 1)],
    )
    .await;
    insert_messages(&mut first, org, channel, &[(2, sender, None)]).await;
    // Distinct Message keys force contention on the new main-timeline counters.
    let pending = tokio::spawn(async move {
        insert_messages(
            &mut second,
            org,
            channel,
            &[(4, sender, Some(topic)), (3, sender, None)],
        )
        .await;
        second.commit().await.unwrap();
    });
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let blocked: bool = sqlx::query_scalar("SELECT cardinality(pg_blocking_pids($1)) > 0")
                .bind(pid)
                .fetch_one(&pool)
                .await
                .unwrap();
            if blocked {
                break;
            }
            assert!(!pending.is_finished(), "the second INSERT did not wait");
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("the second INSERT did not wait on the first transaction");
    // The second INSERT must wait on the lower, missing key before taking any
    // Topic locks. Updating the existing keys first would deadlock here.
    insert_messages(&mut first, org, channel, &[(5, sender, Some(topic))]).await;
    first.commit().await.unwrap();
    pending.await.unwrap();
    assert_counts(
        &mut conn,
        org,
        channel,
        &[
            (nil, nil, 2),
            (nil, sender, 2),
            (topic, nil, 3),
            (topic, sender, 3),
        ],
    )
    .await;
}

#[fukulow_test::test]
async fn append_counts_aggregate_a_multi_row_insert_across_scopes(pool: PgPool) {
    let (_, org, sender, channel, _) = fixture(&pool).await;
    let other = Uuid::new_v4();
    member(&pool, org, other).await;
    let topic = empty_topic(&pool, org, channel).await;
    let mut conn = pool.acquire().await.unwrap();
    insert_messages(&mut conn, org, channel, &[(1, sender, None)]).await;
    insert_messages(
        &mut conn,
        org,
        channel,
        &[
            (2, sender, Some(topic)),
            (3, other, None),
            (4, sender, None),
            (5, sender, Some(topic)),
            (6, other, Some(topic)),
        ],
    )
    .await;
    let nil = Uuid::nil();
    assert_counts(
        &mut conn,
        org,
        channel,
        &[
            (nil, nil, 3),
            (nil, sender, 2),
            (nil, other, 1),
            (topic, nil, 3),
            (topic, sender, 2),
            (topic, other, 1),
        ],
    )
    .await;
}

#[fukulow_test::test]
async fn append_counts_rollback_reverts_updates_and_new_keys(pool: PgPool) {
    let (_, org, sender, channel, _) = fixture(&pool).await;
    let other = Uuid::new_v4();
    member(&pool, org, other).await;
    let mut conn = pool.acquire().await.unwrap();
    let nil = Uuid::nil();
    insert_messages(&mut conn, org, channel, &[(1, sender, None)]).await;

    let mut tx = pool.begin().await.unwrap();
    insert_messages(&mut tx, org, channel, &[(2, other, None)]).await;
    assert_counts(
        &mut tx,
        org,
        channel,
        &[(nil, nil, 2), (nil, sender, 1), (nil, other, 1)],
    )
    .await;
    tx.rollback().await.unwrap();
    assert_counts(&mut conn, org, channel, &[(nil, nil, 1), (nil, sender, 1)]).await;
}

#[fukulow_test::test]
async fn append_counts_preserve_matching_keys_in_another_organization(pool: PgPool) {
    let org = organization(&pool).await;
    let other_org = organization(&pool).await;
    let sender = Uuid::new_v4();
    let channel = Uuid::new_v4();
    member(&pool, org, sender).await;
    member(&pool, other_org, sender).await;
    super::channel(&pool, org, channel, sender, false).await;
    super::channel(&pool, other_org, channel, sender, false).await;
    let mut admin = pool.acquire().await.unwrap();
    insert_messages(&mut admin, other_org, channel, &[(1, sender, None)]).await;
    let security_invoker: bool = sqlx::query_scalar(
        "SELECT NOT prosecdef FROM pg_proc WHERE oid = 'public.message_counts_inserted()'::regprocedure",
    )
    .fetch_one(&mut *admin)
    .await
    .unwrap();
    assert!(
        security_invoker,
        "the trigger must run as the inserting role"
    );

    // Reuse the deployment role if the cluster-wide role test has created it.
    // Roll back any role creation and the grants for this database.
    let mut tx = pool.begin().await.unwrap();
    sqlx::raw_sql(
        "DO $$ BEGIN
             IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'fukulow_app') THEN
                 CREATE ROLE fukulow_app NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT;
             END IF;
         EXCEPTION WHEN duplicate_object OR unique_violation THEN NULL;
         END $$;",
    )
    .execute(&mut *tx)
    .await
    .unwrap();
    sqlx::raw_sql(include_str!("../../../../../deploy/db-grants.sql"))
        .execute(&mut *tx)
        .await
        .unwrap();
    sqlx::raw_sql("SET LOCAL ROLE fukulow_app")
        .execute(&mut *tx)
        .await
        .unwrap();
    crate::database::set_organization(&mut tx, org)
        .await
        .unwrap();
    let rls_active: bool =
        sqlx::query_scalar("SELECT row_security_active('message_append_counts')")
            .fetch_one(&mut *tx)
            .await
            .unwrap();
    assert!(rls_active);
    insert_messages(&mut tx, org, channel, &[(1, sender, None)]).await;
    insert_messages(&mut tx, org, channel, &[(2, sender, None)]).await;
    let nil = Uuid::nil();
    assert_counts(&mut tx, org, channel, &[(nil, nil, 2), (nil, sender, 2)]).await;
    assert_counts(&mut tx, other_org, channel, &[]).await;
    sqlx::raw_sql("RESET ROLE").execute(&mut *tx).await.unwrap();
    let other_counts = [(nil, nil, 1), (nil, sender, 1)];
    assert_counts(&mut tx, other_org, channel, &other_counts).await;

    // With RLS bypassed, only the UPDATE's Organization predicate protects the matching keys.
    let rls_active: bool =
        sqlx::query_scalar("SELECT row_security_active('message_append_counts')")
            .fetch_one(&mut *tx)
            .await
            .unwrap();
    assert!(!rls_active);
    insert_messages(&mut tx, org, channel, &[(3, sender, None)]).await;
    assert_counts(&mut tx, other_org, channel, &other_counts).await;
    assert_counts(&mut tx, org, channel, &[(nil, nil, 3), (nil, sender, 3)]).await;
    tx.rollback().await.unwrap();
}
