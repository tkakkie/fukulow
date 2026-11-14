use super::super::authors::{AuthorLookupRequest, lookup_authors};
use super::*;
use std::{
    collections::HashMap,
    sync::{Arc, LazyLock, Mutex},
    time::Duration,
};
use tokio::sync::Semaphore;

struct Gate {
    entered: Semaphore,
    release: Semaphore,
}
static GATES: LazyLock<Mutex<HashMap<Uuid, Arc<Gate>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
pub(crate) async fn pause(organization: Uuid) {
    let gate = GATES.lock().unwrap().remove(&organization);
    if let Some(gate) = gate {
        gate.entered.add_permits(1);
        gate.release.acquire().await.unwrap().forget();
    }
}

async fn lookup(app: &Router, token: &str, ids: &[Uuid]) -> Value {
    let response = request(
        app,
        "POST",
        "/api/v1/message-authors",
        token,
        json!({"ids":ids}),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
    body(response).await
}

async fn grant(pool: &PgPool, org: Uuid, channel: Uuid, member: Uuid) {
    sqlx::query(
        "INSERT INTO channel_members (organization_id,channel_id,member_id,membership_revision) SELECT organization_id,$2,id,membership_revision FROM users WHERE organization_id=$1 AND id=$3",
    )
    .bind(org)
    .bind(channel)
    .bind(member)
    .execute(pool)
    .await
    .unwrap();
}
async fn revoke(pool: &PgPool, org: Uuid, channel: Uuid, member: Uuid) {
    sqlx::query(
        "DELETE FROM channel_members WHERE organization_id=$1 AND channel_id=$2 AND member_id=$3",
    )
    .bind(org)
    .bind(channel)
    .bind(member)
    .execute(pool)
    .await
    .unwrap();
}
async fn role(pool: &PgPool, org: Uuid, member: Uuid, role: &str) {
    sqlx::query("UPDATE users SET role=$3 WHERE organization_id=$1 AND id=$2")
        .bind(org)
        .bind(member)
        .bind(role)
        .execute(pool)
        .await
        .unwrap();
}
async fn deactivate(pool: &PgPool, org: Uuid, member: Uuid, reactivate: bool) {
    sqlx::query("UPDATE users SET deactivated_at=now() WHERE organization_id=$1 AND id=$2")
        .bind(org)
        .bind(member)
        .execute(pool)
        .await
        .unwrap();
    if reactivate {
        sqlx::query("UPDATE users SET deactivated_at=NULL WHERE organization_id=$1 AND id=$2")
            .bind(org)
            .bind(member)
            .execute(pool)
            .await
            .unwrap();
    }
}

#[sqlx::test]
async fn author_lookup_every_role_private_and_guest_public_denials_have_positive_controls(
    pool: PgPool,
) {
    let pools = crate::test_support::TestPools::new(pool).await;
    let (_, org, author, public, author_token) = fixture(&pools.admin).await;
    let private = Uuid::new_v4();
    channel(&pools.admin, org, private, author, true).await;
    let app = router(&pools.app).await;
    // Each author occurs only in its own Channel; another public Message must not authorize it.
    sent(
        &app,
        &author_token,
        private,
        input(Uuid::new_v4(), "private"),
    )
    .await;
    let public_author = Uuid::new_v4();
    let public_token = member(&pools.admin, org, public_author).await;
    sent(&app, &public_token, public, input(Uuid::new_v4(), "public")).await;
    for actor_role in ["owner", "admin", "member", "guest"] {
        let actor = Uuid::new_v4();
        let token = member(&pools.admin, org, actor).await;
        role(&pools.admin, org, actor, actor_role).await;
        assert_eq!(
            lookup(&app, &token, &[author]).await,
            json!({"identities":[]})
        );
        grant(&pools.admin, org, private, actor).await;
        assert_eq!(
            lookup(&app, &token, &[author]).await["identities"][0]["id"],
            author.to_string()
        );
        revoke(&pools.admin, org, private, actor).await;
        assert_eq!(
            lookup(&app, &token, &[author]).await,
            json!({"identities":[]})
        );
        if actor_role == "guest" {
            assert_eq!(
                lookup(&app, &token, &[public_author]).await,
                json!({"identities":[]})
            );
            grant(&pools.admin, org, public, actor).await;
            assert_eq!(
                lookup(&app, &token, &[public_author]).await["identities"][0]["id"],
                public_author.to_string()
            );
            revoke(&pools.admin, org, public, actor).await;
            assert_eq!(
                lookup(&app, &token, &[public_author]).await,
                json!({"identities":[]})
            );
        }
    }
    pools.app.close().await;
}

#[sqlx::test]
async fn author_lookup_scopes_authorship_retains_deactivated_and_departed_and_bounds_batches(
    pool: PgPool,
) {
    let pools = crate::test_support::TestPools::new(pool).await;
    let (_, org, author, channel_id, author_token) = fixture(&pools.admin).await;
    let caller = Uuid::new_v4();
    let token = member(&pools.admin, org, caller).await;
    let nonauthor = Uuid::new_v4();
    member(&pools.admin, org, nonauthor).await;
    let (_, _, foreign, foreign_channel, foreign_token) = fixture(&pools.admin).await;
    let app = router(&pools.app).await;
    sent(
        &app,
        &author_token,
        channel_id,
        input(Uuid::new_v4(), "history"),
    )
    .await;
    sent(
        &app,
        &foreign_token,
        foreign_channel,
        input(Uuid::new_v4(), "foreign"),
    )
    .await;
    let ids = [author, author, nonauthor, foreign, Uuid::new_v4()];
    assert_eq!(
        lookup(&app, &token, &ids).await,
        json!({"identities":[{"id":author,"name":"Member","deactivated":false}]})
    );
    assert_eq!(lookup(&app, &token, &[]).await, json!({"identities":[]}));
    assert_eq!(
        lookup(&app, &token, &[author; 100]).await["identities"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    let response = request(
        &app,
        "POST",
        "/api/v1/message-authors",
        &token,
        json!({"ids":vec![author;101]}),
    )
    .await;
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    assert_eq!(body(response).await, json!({"error":"invalid input"}));
    // The author leaves a private Channel that the caller still reads.
    grant(&pools.admin, org, channel_id, author).await;
    grant(&pools.admin, org, channel_id, caller).await;
    sqlx::query("UPDATE channels SET visibility='private' WHERE organization_id=$1 AND id=$2")
        .bind(org)
        .bind(channel_id)
        .execute(&pools.admin)
        .await
        .unwrap();
    revoke(&pools.admin, org, channel_id, author).await;
    assert_eq!(
        lookup(&app, &token, &[author]).await["identities"][0]["deactivated"],
        false
    );
    deactivate(&pools.admin, org, author, false).await;
    assert_eq!(
        lookup(&app, &token, &ids).await,
        json!({"identities":[{"id":author,"name":"Member","deactivated":true}]})
    );
    pools.app.close().await;
}

#[sqlx::test]
async fn author_lookup_rechecks_inactive_stale_callers_and_stale_grants_after_auth(pool: PgPool) {
    let pools = crate::test_support::TestPools::new(pool).await;
    for denial in [
        "inactive",
        "stale_caller",
        "stale_private",
        "stale_guest_public",
    ] {
        let (_, org, author, channel_id, author_token) = fixture(&pools.admin).await;
        let caller = Uuid::new_v4();
        let token = member(&pools.admin, org, caller).await;
        let app = router(&pools.app).await;
        sent(
            &app,
            &author_token,
            channel_id,
            input(Uuid::new_v4(), "visible"),
        )
        .await;
        if denial == "stale_private" {
            grant(&pools.admin, org, channel_id, author).await;
            sqlx::query(
                "UPDATE channels SET visibility='private' WHERE organization_id=$1 AND id=$2",
            )
            .bind(org)
            .bind(channel_id)
            .execute(&pools.admin)
            .await
            .unwrap();
        }
        if denial == "stale_guest_public" {
            role(&pools.admin, org, caller, "guest").await;
        }
        grant(&pools.admin, org, channel_id, caller).await;
        assert_eq!(
            lookup(&app, &token, &[author]).await["identities"][0]["id"],
            author.to_string()
        );
        let auth = membership::captured_auth(&pools.app, &token).await;
        deactivate(&pools.admin, org, caller, denial != "inactive").await;
        let response = lookup_authors(
            State(AppState::for_test(pools.app.clone()).await),
            auth,
            ApiJson(AuthorLookupRequest { ids: vec![author] }),
        )
        .await
        .unwrap_err()
        .into_response();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        assert_eq!(
            body(response).await,
            json!({"error":"organization_unavailable"})
        );
        if denial.starts_with("stale_") && denial != "stale_caller" {
            // A newly authenticated caller is active, but its retained grant has the old revision.
            assert_eq!(
                lookup(&app, &token, &[author]).await,
                json!({"identities":[]})
            );
            revoke(&pools.admin, org, channel_id, caller).await;
            grant(&pools.admin, org, channel_id, caller).await;
            assert_eq!(
                lookup(&app, &token, &[author]).await["identities"][0]["id"],
                author.to_string()
            );
        }
    }
    pools.app.close().await;
}

#[sqlx::test]
async fn author_lookup_authorization_and_identities_share_a_nonlocking_snapshot(pool: PgPool) {
    let pools = crate::test_support::TestPools::new(pool).await;
    let (_, org, author, channel_id, author_token) = fixture(&pools.admin).await;
    let caller = Uuid::new_v4();
    let token = member(&pools.admin, org, caller).await;
    grant(&pools.admin, org, channel_id, author).await;
    grant(&pools.admin, org, channel_id, caller).await;
    sqlx::query("UPDATE channels SET visibility='private' WHERE organization_id=$1 AND id=$2")
        .bind(org)
        .bind(channel_id)
        .execute(&pools.admin)
        .await
        .unwrap();
    let later_author = Uuid::new_v4();
    let later_token = member(&pools.admin, org, later_author).await;
    grant(&pools.admin, org, channel_id, later_author).await;
    let app = router(&pools.app).await;
    sent(
        &app,
        &author_token,
        channel_id,
        input(Uuid::new_v4(), "before snapshot"),
    )
    .await;
    let auth = membership::captured_auth(&pools.app, &token).await;
    let next_auth = membership::captured_auth(&pools.app, &token).await;
    let state = AppState::for_test(pools.app.clone()).await;
    let gate = Arc::new(Gate {
        entered: Semaphore::new(0),
        release: Semaphore::new(0),
    });
    GATES.lock().unwrap().insert(org, gate.clone());
    let lookup = lookup_authors(
        State(state.clone()),
        auth,
        ApiJson(AuthorLookupRequest {
            ids: vec![author, later_author],
        }),
    );
    tokio::pin!(lookup);
    tokio::select! {
        _ = &mut lookup => panic!("lookup did not pause"),
        permit = tokio::time::timeout(Duration::from_secs(5), gate.entered.acquire()) => permit.unwrap().unwrap().forget(),
    }
    // Neither authorization nor identity reads lock Member or grant rows.
    tokio::time::timeout(Duration::from_secs(5), async {
        revoke(&pools.admin, org, channel_id, caller).await;
        deactivate(&pools.admin, org, author, false).await;
        sent(
            &app,
            &later_token,
            channel_id,
            input(Uuid::new_v4(), "after snapshot"),
        )
        .await;
    })
    .await
    .unwrap();
    gate.release.add_permits(1);
    assert_eq!(
        body(lookup.await.unwrap()).await,
        json!({"identities":[{"id":author,"name":"Member","deactivated":false}]})
    );
    // Loss committed before the next snapshot denies even a previously captured Auth.
    let response = lookup_authors(
        State(state),
        next_auth,
        ApiJson(AuthorLookupRequest {
            ids: vec![author, later_author],
        }),
    )
    .await
    .unwrap();
    assert_eq!(body(response).await, json!({"identities":[]}));
    pools.app.close().await;
}
