use super::*;
use crate::messages::tests::authors::{grant, revoke};
use sqlx::PgConnection;

type Term = (String, Uuid, String, String);

async fn terms_in(
    tx: &mut PgConnection,
    org: Uuid,
    message: Uuid,
) -> Result<Vec<Term>, sqlx::Error> {
    sqlx::query_as(
        "SELECT term, channel_id, created_at::text, xmin::text FROM message_search_terms
         WHERE organization_id=$1 AND message_id=$2 ORDER BY term",
    )
    .bind(org)
    .bind(message)
    .fetch_all(tx)
    .await
}

async fn terms(f: &Fixture, message: Uuid) -> Vec<Term> {
    crate::database::organization_read_only(&f.pools.app, f.org, async |tx| {
        terms_in(tx, f.org, message).await
    })
    .await
    .unwrap()
}

fn grams(terms: &[Term]) -> Vec<&str> {
    terms.iter().map(|term| term.0.as_str()).collect()
}

#[fukulow_test::test]
async fn search_terms_follow_send_and_move_and_never_return_deleted_messages(pool: PgPool) {
    let f = Fixture::new(pool).await;
    let sent = f.post(f.public, "Ababa").await;
    let message = id(&sent);
    let initial = terms(&f, message).await;
    assert_eq!(grams(&initial), ["ab", "aba", "ba", "bab"]);
    let first = page(&f, &f.token, "aba", Some(f.public), None).await;
    assert_eq!(first["hits"][0]["message"], sent);

    let response = request(
        &f.app,
        "POST",
        &format!("/api/v1/channels/{}/messages/{message}/move", f.public),
        &f.token,
        json!({"operation_id":Uuid::new_v4(),"topic_name":"Planning","expected_version":1}),
    )
    .await;
    let status = response.status();
    let moved = body(response).await;
    assert_eq!(status, StatusCode::OK, "{moved}");
    let after_move = page(&f, &f.token, "aba", Some(f.public), None).await;
    assert!(after_move["hits"][0]["message"]["topic_id"].is_string());
    assert_eq!(after_move["hits"][0]["message"]["version"], 2);
    assert_eq!(terms(&f, message).await, initial);

    // Leave stale terms deliberately to exercise the query's deletion recheck.
    crate::database::organization(&f.pools.app, f.org, async |tx: &mut PgConnection| {
        sqlx::query("UPDATE messages SET deleted=true WHERE organization_id=$1 AND id=$2")
            .bind(f.org)
            .bind(message)
            .execute(tx)
            .await
    })
    .await
    .unwrap();
    assert_eq!(terms(&f, message).await, initial);
    assert!(ids(&page(&f, &f.token, "aba", None, None).await).is_empty());
}

#[fukulow_test::test]
async fn search_terms_reject_a_message_from_another_channel(pool: PgPool) {
    let f = Fixture::new(pool).await;
    let other = f.channel(false).await;
    let message = id(&f.post(f.public, "needle").await);
    let error = crate::database::organization(&f.pools.app, f.org, async |tx| {
        sqlx::query(
            "INSERT INTO message_search_terms (organization_id, channel_id, term, created_at, message_id)
             VALUES ($1, $2, 'nee', now(), $3)",
        )
        .bind(f.org)
        .bind(other)
        .bind(message)
        .execute(tx)
        .await
    })
    .await
    .unwrap_err();
    assert!(
        error
            .as_database_error()
            .unwrap()
            .is_foreign_key_violation()
    );
}

#[fukulow_test::test]
async fn search_terms_roll_back_with_send_before_commit(pool: PgPool) {
    let f = Fixture::new(pool).await;
    let client_id = Uuid::new_v4();
    let pending = crate::messages::commit::ambiguous_commit(client_id);
    let app = f.app.clone();
    let token = f.token.clone();
    let channel = f.public;
    let send = tokio::spawn(async move {
        request(
            &app,
            "POST",
            &format!("/api/v1/channels/{channel}/messages"),
            &token,
            input(client_id, "needle"),
        )
        .await
    });
    let mut tx = pending.await.unwrap();
    let message = sqlx::query_scalar(
        "SELECT id FROM messages WHERE organization_id=$1 AND client_message_id=$2",
    )
    .bind(f.org)
    .bind(client_id)
    .fetch_one(tx.connection().unwrap())
    .await
    .unwrap();
    assert!(
        !terms_in(tx.connection().unwrap(), f.org, message)
            .await
            .unwrap()
            .is_empty()
    );
    assert!(terms(&f, message).await.is_empty());
    tx.rollback().await.unwrap();
    assert_eq!(
        send.await.unwrap().status(),
        StatusCode::INTERNAL_SERVER_ERROR
    );
    assert!(terms(&f, message).await.is_empty());
    assert!(ids(&page(&f, &f.token, "needle", None, None).await).is_empty());

    let retried = sent(&f.app, &f.token, f.public, input(client_id, "needle")).await;
    assert_eq!(
        ids(&page(&f, &f.token, "needle", None, None).await),
        [id(&retried)]
    );
}

#[fukulow_test::test]
async fn search_permission_only_changes_preserve_terms_and_change_visibility(pool: PgPool) {
    let f = Fixture::new(pool).await;
    let private = f.channel(true).await;
    let message = id(&f.post(private, "needle").await);
    let caller = Uuid::new_v4();
    let token = member(&f.pools.admin, f.org, caller).await;
    let before = terms(&f, message).await;
    assert!(!before.is_empty());
    assert!(ids(&page(&f, &token, "needle", None, None).await).is_empty());
    grant(&f.pools.admin, f.org, private, caller).await;
    assert_eq!(
        ids(&page(&f, &token, "needle", None, None).await),
        [message]
    );
    revoke(&f.pools.admin, f.org, private, caller).await;
    assert!(ids(&page(&f, &token, "needle", None, None).await).is_empty());
    assert_eq!(terms(&f, message).await, before);
}

#[fukulow_test::test(migrations = false)]
async fn search_migration_backfills_live_messages_in_each_organization_and_forces_rls(
    pool: PgPool,
) {
    let mut previous = sqlx::migrate!();
    previous
        .migrations
        .to_mut()
        .retain(|migration| migration.version < 202611210725);
    previous.run(&pool).await.unwrap();
    let mut orgs = Vec::new();
    for text in ["Straße", "ＦＵＫＵ"] {
        let org = organization(&pool).await;
        let author = Uuid::new_v4();
        let token = member(&pool, org, author).await;
        let public = Uuid::new_v4();
        channel(&pool, org, public, author, false).await;
        let live: Uuid = sqlx::query_scalar(
            "INSERT INTO messages (organization_id, id, channel_id, sender, client_message_id, body, seq, deleted)
             VALUES ($1, gen_random_uuid(), $2, $3, gen_random_uuid(), $4, 1, false),
                    ($1, gen_random_uuid(), $2, $3, gen_random_uuid(), 'removed', 2, true)
             RETURNING id",
        ).bind(org).bind(public).bind(author).bind(text).fetch_one(&pool).await.unwrap();
        seed_legacy_creates(&pool, org, &[public]).await;
        // Sends commit the counter with the Message; #519's backfill check requires it.
        sqlx::query("INSERT INTO channel_message_sequences (organization_id, channel_id, seq) VALUES ($1,$2,2) \
            ON CONFLICT (organization_id, channel_id) DO UPDATE SET seq = 2")
            .bind(org).bind(public).execute(&pool).await.unwrap();
        orgs.push((org, token, text, live));
    }
    sqlx::migrate!().run(&pool).await.unwrap();
    let rls: (bool, bool) = sqlx::query_as(
        "SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid='message_search_terms'::regclass",
    ).fetch_one(&pool).await.unwrap();
    assert_eq!(rls, (true, true));
    let pools = TestPools::new(pool).await;
    let app = crate::app(
        AppState::with_test_pool(pools.app.clone()),
        crate::ServeOptions {
            search_engine: SearchEngine::configured(Some("d3r")).unwrap(),
            ..Default::default()
        },
    );
    for (org, token, text, live) in orgs {
        let response = get(&app, org, &token, Some(text), None, None).await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(ids(&body(response).await), [live]);
        let indexed: Vec<Uuid> = crate::database::organization_read_only(
            &pools.app,
            org,
            async |tx: &mut PgConnection| {
                sqlx::query_scalar("SELECT DISTINCT message_id FROM message_search_terms")
                    .fetch_all(tx)
                    .await
            },
        )
        .await
        .unwrap();
        assert_eq!(indexed, [live]);
    }
}
