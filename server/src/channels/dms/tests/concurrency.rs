use super::*;
use std::time::Duration;

pub(super) async fn wait_lock(pool: &PgPool, pattern: &str) {
    tokio::time::timeout(Duration::from_secs(5),async {
        loop {
            let count:i64=sqlx::query_scalar("SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE $1")
                .bind(pattern).fetch_one(pool).await.unwrap();
            if count>0 {break}tokio::task::yield_now().await;
        }
    }).await.unwrap_or_else(|_|panic!("no matching lock waiter: {pattern}"));
}

#[fukulow_test::test]
async fn reciprocal_open_and_renewal_are_unique_and_noops_preserve_unread(pool: PgPool) {
    let f = Fixture::new(pool, "member").await;
    let (a, b) = tokio::join!(f.open(&f.at, f.b, false), f.open(&f.bt, f.a, false));
    let mut statuses = [a.status(), b.status()];
    statuses.sort();
    assert_eq!(statuses, [StatusCode::OK, StatusCode::CREATED]);
    let a = body(a).await;
    let b = body(b).await;
    assert_eq!(a["id"], b["id"]);
    let c = Uuid::parse_str(a["id"].as_str().unwrap()).unwrap();
    assert_eq!(
        f.send(&f.at, c, Uuid::new_v4()).await.status(),
        StatusCode::CREATED
    );
    f.deactivate(f.a).await;
    f.reactivate(f.a).await;
    f.deactivate(f.b).await;
    f.reactivate(f.b).await;
    let (a, b) = tokio::join!(f.open(&f.at, f.b, true), f.open(&f.bt, f.a, true));
    assert_eq!(a.status(), StatusCode::OK);
    assert_eq!(b.status(), StatusCode::OK);
    assert_eq!(body(a).await["id"], c.to_string());
    assert_eq!(body(b).await["id"], c.to_string());
    let counters:Vec<i64>=sqlx::query_scalar("SELECT position FROM dm_discovery_counters WHERE organization_id=$1 AND membership_revision=1 ORDER BY member_id").bind(f.org).fetch_all(&f.pools.admin).await.unwrap();
    assert_eq!(counters, vec![1, 1]);
    for t in [&f.at, &f.bt] {
        let list = f.get(t, "/api/v1/dms").await;
        assert_eq!(list["dms"][0]["read_seq"], 1);
        assert_eq!(list["dms"][0]["unread_count"], 0);
    }
    let before = f.snapshot().await;
    let (a, b) = tokio::join!(f.open(&f.at, f.b, true), f.open(&f.bt, f.a, true));
    assert_eq!(a.status(), StatusCode::OK);
    assert_eq!(b.status(), StatusCode::OK);
    assert_eq!(f.snapshot().await, before);
    f.pools.app.close().await;
}

#[fukulow_test::test]
async fn send_first_holds_peer_through_commit_and_deactivation_first_denies_both_directions(
    pool: PgPool,
) {
    for reverse in [false, true] {
        let f = Fixture::new(pool.clone(), "guest").await;
        let c = f.dm().await;
        let owner = Uuid::new_v4();
        let owner_token = member(&f.pools.admin, f.org, owner, "owner").await;
        let (token, peer) = if reverse { (&f.bt, f.a) } else { (&f.at, f.b) };
        let mut barrier = f.pools.admin.begin().await.unwrap();
        sqlx::query(
            "SELECT pg_advisory_xact_lock(hashtextextended($1::uuid::text || '/' || $2::uuid::text,135))",
        )
        .bind(f.org)
        .bind(c)
        .execute(&mut *barrier)
        .await
        .unwrap();
        let send = {
            let app = f.app.clone();
            let token = token.clone();
            tokio::spawn(async move {
                request(
                    &app,
                    "POST",
                    &format!("/api/v1/channels/{c}/messages"),
                    &token,
                    json!({"client_message_id":Uuid::new_v4(),"body":"racing"}),
                )
                .await
            })
        };
        wait_lock(&f.pools.admin, "WITH timeout%135%").await;
        let deactivate = {
            let app = f.app.clone();
            let owner_token = owner_token.clone();
            tokio::spawn(async move {
                request(
                    &app,
                    "POST",
                    &format!(
                        "/api/v1/orgs/{}/members/{peer}/deactivate",
                        owner_token.split_once('.').unwrap().0
                    ),
                    &owner_token,
                    Value::Null,
                )
                .await
            })
        };
        wait_lock(
            &f.pools.admin,
            "SELECT name,role,membership_revision%FOR NO KEY UPDATE",
        )
        .await;
        assert!(!send.is_finished());
        assert!(!deactivate.is_finished());
        barrier.commit().await.unwrap();
        let sent = tokio::time::timeout(Duration::from_secs(5), send)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(sent.status(), StatusCode::CREATED);
        let deactivated = tokio::time::timeout(Duration::from_secs(5), deactivate)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(deactivated.status(), StatusCode::NO_CONTENT);
        let before = f.snapshot().await;
        let denied = f.send(token, c, Uuid::new_v4()).await;
        assert_eq!(denied.status(), StatusCode::CONFLICT);
        assert_eq!(body(denied).await, json!({"error":"dm_peer_deactivated"}));
        assert_eq!(f.snapshot().await, before);
        let r = request(
            &f.app,
            "PUT",
            &format!("/api/v1/channels/{c}/read"),
            token,
            json!({"read_seq":999}),
        )
        .await;
        assert_eq!(r.status(), StatusCode::OK);
        f.pools.app.close().await;
    }
}

#[fukulow_test::test]
async fn admin_demotion_ignores_dms_but_private_last_manager_still_denies(pool: PgPool) {
    let f = Fixture::new(pool, "admin").await;
    let c = f.dm().await;
    let owner = member(&f.pools.admin, f.org, Uuid::new_v4(), "owner").await;
    let r = request(
        &f.app,
        "PATCH",
        &format!("/api/v1/orgs/{}/members/{}/role", f.org, f.b),
        &owner,
        json!({"role":"member"}),
    )
    .await;
    assert_eq!(r.status(), StatusCode::OK);
    assert_eq!(
        f.get(&f.bt, "/api/v1/dms").await["dms"][0]["id"],
        c.to_string()
    );
    let r = request(
        &f.app,
        "PATCH",
        &format!("/api/v1/orgs/{}/members/{}/role", f.org, f.b),
        &owner,
        json!({"role":"guest"}),
    )
    .await;
    assert_eq!(r.status(), StatusCode::OK);
    assert_eq!(
        f.send(&f.bt, c, Uuid::new_v4()).await.status(),
        StatusCode::CREATED
    );
    let private = Uuid::new_v4();
    sqlx::query("INSERT INTO channels(organization_id,id,name,visibility) VALUES($1,$2,'Protected','private')").bind(f.org).bind(private).execute(&f.pools.admin).await.unwrap();
    sqlx::query("UPDATE users SET role='admin' WHERE organization_id=$1 AND id=$2")
        .bind(f.org)
        .bind(f.b)
        .execute(&f.pools.admin)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO channel_members(organization_id,channel_id,member_id) VALUES($1,$2,$3)",
    )
    .bind(f.org)
    .bind(private)
    .bind(f.b)
    .execute(&f.pools.admin)
    .await
    .unwrap();
    let before = f.snapshot().await;
    let r = request(
        &f.app,
        "PATCH",
        &format!("/api/v1/orgs/{}/members/{}/role", f.org, f.b),
        &owner,
        json!({"role":"member"}),
    )
    .await;
    assert_eq!(r.status(), StatusCode::CONFLICT);
    assert_eq!(body(r).await, json!({"error":"last_channel_manager"}));
    assert_eq!(f.snapshot().await, before);
    f.pools.app.close().await;
}
