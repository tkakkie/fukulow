use super::*;
use crate::channels::tests::{body, extract_auth, member, organization, request};
use crate::test_support::TestPools;
use axum::Router;
use serde_json::{Value, json};
use sqlx::PgPool;

mod concurrency;
mod integrity;
mod paging;

struct Fixture {
    pools: TestPools,
    state: AppState,
    app: Router,
    org: Uuid,
    a: Uuid,
    b: Uuid,
    at: String,
    bt: String,
}
impl Fixture {
    async fn new(pool: PgPool, role: &str) -> Self {
        let pools = TestPools::new(pool).await;
        let org = organization(&pools.admin).await;
        let a = Uuid::new_v4();
        let b = Uuid::new_v4();
        let at = member(&pools.admin, org, a, "member").await;
        let bt = member(&pools.admin, org, b, role).await;
        let state = AppState::for_test(pools.app.clone()).await;
        let app = crate::app(state.clone());
        Self {
            pools,
            state,
            app,
            org,
            a,
            b,
            at,
            bt,
        }
    }
    async fn open(&self, token: &str, peer: Uuid, renew: bool) -> Response {
        request(
            &self.app,
            "POST",
            "/api/v1/dms",
            token,
            json!({"member_id":peer,"renew":renew}),
        )
        .await
    }
    async fn dm(&self) -> Uuid {
        let r = self.open(&self.at, self.b, false).await;
        assert_eq!(r.status(), StatusCode::CREATED);
        Uuid::parse_str(body(r).await["id"].as_str().unwrap()).unwrap()
    }
    async fn get(&self, token: &str, suffix: &str) -> Value {
        let r = request(&self.app, "GET", suffix, token, Value::Null).await;
        assert_eq!(r.status(), StatusCode::OK);
        body(r).await
    }
    async fn send(&self, token: &str, c: Uuid, key: Uuid) -> Response {
        request(
            &self.app,
            "POST",
            &format!("/api/v1/channels/{c}/messages"),
            token,
            json!({"client_message_id":key,"body":"hello"}),
        )
        .await
    }
    async fn deactivate(&self, member: Uuid) {
        sqlx::query(
            "UPDATE users SET deactivated_at=clock_timestamp() WHERE organization_id=$1 AND id=$2",
        )
        .bind(self.org)
        .bind(member)
        .execute(&self.pools.admin)
        .await
        .unwrap();
    }
    async fn reactivate(&self, member: Uuid) {
        sqlx::query("UPDATE users SET deactivated_at=NULL WHERE organization_id=$1 AND id=$2")
            .bind(self.org)
            .bind(member)
            .execute(&self.pools.admin)
            .await
            .unwrap();
    }
    async fn snapshot(&self) -> Value {
        sqlx::query_scalar("SELECT jsonb_build_array((SELECT jsonb_agg(to_jsonb(c) ORDER BY id) FROM channels c),(SELECT jsonb_agg(to_jsonb(g) ORDER BY channel_id,member_id) FROM channel_members g),(SELECT jsonb_agg(to_jsonb(p) ORDER BY channel_id,member_id) FROM channel_read_positions p),(SELECT jsonb_agg(to_jsonb(m) ORDER BY channel_id,seq) FROM messages m),(SELECT jsonb_agg(to_jsonb(s) ORDER BY channel_id) FROM channel_message_sequences s),(SELECT jsonb_agg(to_jsonb(d) ORDER BY member_id,membership_revision,channel_id) FROM dm_discovery d),(SELECT jsonb_agg(to_jsonb(c) ORDER BY member_id,membership_revision) FROM dm_discovery_counters c))").fetch_one(&self.pools.admin).await.unwrap()
    }
}

#[fukulow_test::test]
async fn guests_cannot_open_but_participate_and_every_management_and_topic_route_denies(
    pool: PgPool,
) {
    let f = Fixture::new(pool, "guest").await;
    let c = f.dm().await;
    for token in [&f.at, &f.bt] {
        let list = f.get(token, "/api/v1/dms").await;
        assert_eq!(list["dms"][0]["id"], c.to_string());
        assert_eq!(list["dms"][0]["kind"], "dm");
        assert!(list["dms"][0].get("name").is_none());
        assert!(list["dms"][0].get("visibility").is_none());
        for cap in [
            "can_add_members",
            "can_remove_members",
            "can_manage_managers",
            "can_leave",
        ] {
            assert_eq!(
                list["dms"][0]["capabilities"][cap],
                json!({"allowed":false,"reason":"dm_membership_fixed"})
            );
        }
        assert_eq!(
            f.get(token, "/api/v1/channels").await["channels"],
            json!([])
        );
        let m = f.send(token, c, Uuid::new_v4()).await;
        assert_eq!(m.status(), StatusCode::CREATED);
        let m = body(m).await;
        assert!(m["topic_id"].is_null());
        let r = request(
            &f.app,
            "POST",
            &format!("/api/v1/channels/{c}/messages"),
            token,
            json!({"client_message_id":Uuid::new_v4(),"body":"reply","reply_to":m["id"]}),
        )
        .await;
        assert_eq!(r.status(), StatusCode::CREATED);
        assert_eq!(body(r).await["reply_root_id"], m["id"]);
        assert_eq!(
            f.get(
                token,
                &format!(
                    "/api/v1/channels/{c}/messages/{}/chain",
                    m["id"].as_str().unwrap()
                )
            )
            .await["messages"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
        let before = f.snapshot().await;
        for (method, suffix, input) in [
            ("GET", "members".to_string(), Value::Null),
            (
                "POST",
                "members".into(),
                json!({"member_id":Uuid::new_v4()}),
            ),
            ("DELETE", format!("members/{}", f.b), Value::Null),
            (
                "PATCH",
                format!("members/{}", f.b),
                json!({"manager":false}),
            ),
            ("GET", "topics".into(), Value::Null),
            ("GET", format!("topics/{}", Uuid::new_v4()), Value::Null),
            (
                "GET",
                format!("topics/{}/messages", Uuid::new_v4()),
                Value::Null,
            ),
            (
                "PUT",
                format!("topics/{}/read", Uuid::new_v4()),
                json!({"read_seq":999}),
            ),
            (
                "POST",
                "messages".into(),
                json!({"client_message_id":Uuid::new_v4(),"body":"topic","topic_name":"No"}),
            ),
        ] {
            let r = request(
                &f.app,
                method,
                &format!("/api/v1/channels/{c}/{suffix}"),
                token,
                input,
            )
            .await;
            assert_eq!(r.status(), StatusCode::BAD_REQUEST, "{method} {suffix}");
            assert_eq!(
                body(r).await,
                json!({"error":if suffix.starts_with("members") {"dm_membership_fixed"} else {"dm_topics_not_allowed"}})
            );
            assert_eq!(f.snapshot().await, before);
        }
    }
    let before = f.snapshot().await;
    for peer in [f.a, f.b, Uuid::new_v4()] {
        let r = f.open(&f.bt, peer, false).await;
        assert_eq!(r.status(), StatusCode::FORBIDDEN);
        assert_eq!(body(r).await, json!({"error":"forbidden"}));
    }
    assert_eq!(f.snapshot().await, before);
    f.pools.app.close().await;
}

#[fukulow_test::test]
async fn default_open_resolves_before_peer_eligibility_and_renewal_preserves_current_lifetime(
    pool: PgPool,
) {
    let f = Fixture::new(pool, "guest").await;
    let c = f.dm().await;
    let key = Uuid::new_v4();
    let canonical = body(f.send(&f.at, c, key).await).await;
    f.deactivate(f.b).await;
    let before = f.snapshot().await;
    let resolved = f.open(&f.at, f.b, false).await;
    assert_eq!(resolved.status(), StatusCode::OK);
    assert_eq!(body(resolved).await["peer"]["active"], false);
    let renewed = f.open(&f.at, f.b, true).await;
    assert_eq!(renewed.status(), StatusCode::NOT_FOUND);
    assert_eq!(body(renewed).await, json!({"error":"member_not_found"}));
    assert_eq!(body(f.send(&f.at, c, key).await).await, canonical);
    let r = f.send(&f.at, c, Uuid::new_v4()).await;
    assert_eq!(r.status(), StatusCode::CONFLICT);
    assert_eq!(body(r).await, json!({"error":"dm_peer_deactivated"}));
    assert_eq!(
        f.get(&f.at, &format!("/api/v1/channels/{c}/messages"))
            .await["messages"][0],
        canonical
    );
    assert_eq!(f.snapshot().await, before);
    let mark = request(
        &f.app,
        "PUT",
        &format!("/api/v1/channels/{c}/read"),
        &f.at,
        json!({"read_seq":999}),
    )
    .await;
    assert_eq!(mark.status(), StatusCode::OK);
    f.reactivate(f.b).await;
    assert_eq!(f.get(&f.bt, "/api/v1/dms").await["dms"], json!([]));
    let r = f.send(&f.at, c, Uuid::new_v4()).await;
    assert_eq!(r.status(), StatusCode::CONFLICT);
    assert_eq!(body(r).await, json!({"error":"dm_peer_access_lapsed"}));
    let before = f.snapshot().await;
    let r = f.open(&f.at, f.b, false).await;
    assert_eq!(r.status(), StatusCode::OK);
    assert_eq!(f.snapshot().await, before);
    let old:Uuid=sqlx::query_scalar("SELECT grant_id FROM channel_members WHERE organization_id=$1 AND channel_id=$2 AND member_id=$3").bind(f.org).bind(c).bind(f.a).fetch_one(&f.pools.admin).await.unwrap();
    let renewed = f.open(&f.at, f.b, true).await;
    assert_eq!(renewed.status(), StatusCode::OK);
    assert_eq!(body(renewed).await["id"], c.to_string());
    let new:Uuid=sqlx::query_scalar("SELECT grant_id FROM channel_members WHERE organization_id=$1 AND channel_id=$2 AND member_id=$3").bind(f.org).bind(c).bind(f.a).fetch_one(&f.pools.admin).await.unwrap();
    assert_eq!(old, new);
    let b = f.get(&f.bt, "/api/v1/dms").await;
    assert_eq!(b["dms"][0]["read_seq"], 1);
    assert_eq!(b["dms"][0]["unread_count"], 0);
    assert_eq!(b["dms"][0]["mention_unread_count"], 0);
    assert_eq!(
        f.send(&f.bt, c, Uuid::new_v4()).await.status(),
        StatusCode::CREATED
    );
    let before = f.snapshot().await;
    assert_eq!(f.open(&f.at, f.b, true).await.status(), StatusCode::OK);
    assert_eq!(f.snapshot().await, before);
    f.pools.app.close().await;
}

#[fukulow_test::test]
async fn only_current_pair_participants_read_write_retry_and_discover(pool: PgPool) {
    for peer_role in ["member", "guest"] {
        let f = Fixture::new(pool.clone(), peer_role).await;
        let c = f.dm().await;
        let key = Uuid::new_v4();
        let canonical = body(f.send(&f.at, c, key).await).await;
        let mut denied = Vec::new();
        for role in ["owner", "admin", "member", "guest"] {
            denied.push(member(&f.pools.admin, f.org, Uuid::new_v4(), role).await);
        }
        let foreign = organization(&f.pools.admin).await;
        denied.push(member(&f.pools.admin, foreign, Uuid::new_v4(), "owner").await);
        for token in &denied {
            let before = f.snapshot().await;
            let orgerr = token.starts_with(&foreign.to_string());
            let error = if orgerr {
                "organization_unavailable"
            } else {
                "channel not found"
            };
            for (method, suffix, input) in [
                ("GET", "messages".to_string(), Value::Null),
                (
                    "GET",
                    format!("messages/{}/chain", canonical["id"].as_str().unwrap()),
                    Value::Null,
                ),
                (
                    "POST",
                    "messages".into(),
                    json!({"client_message_id":key,"body":"hello"}),
                ),
                (
                    "POST",
                    "messages".into(),
                    json!({"client_message_id":Uuid::new_v4(),"body":"hello"}),
                ),
                ("PUT", "read".into(), json!({"read_seq":999})),
            ] {
                let r = request(
                    &f.app,
                    method,
                    &format!("/api/v1/orgs/{}/channels/{c}/{suffix}", f.org),
                    token,
                    input,
                )
                .await;
                assert_eq!(r.status(), StatusCode::NOT_FOUND);
                assert_eq!(body(r).await, json!({"error":error}));
            }
            for suffix in ["dms", "dms/changes?lane=delta", "dms/changes?lane=coverage"] {
                let r = request(
                    &f.app,
                    "GET",
                    &format!("/api/v1/orgs/{}/{suffix}", f.org),
                    token,
                    Value::Null,
                )
                .await;
                if orgerr {
                    assert_eq!(r.status(), StatusCode::NOT_FOUND);
                } else {
                    assert_eq!(r.status(), StatusCode::OK);
                    assert_eq!(body(r).await["dms"], json!([]));
                }
            }
            assert_eq!(f.snapshot().await, before);
            for positive in [&f.at, &f.bt] {
                assert_eq!(
                    f.get(positive, "/api/v1/dms").await["dms"]
                        .as_array()
                        .unwrap()
                        .len(),
                    1
                );
                assert!(
                    !f.get(positive, &format!("/api/v1/channels/{c}/messages"))
                        .await["messages"]
                        .as_array()
                        .unwrap()
                        .is_empty()
                );
                assert_eq!(
                    f.send(positive, c, Uuid::new_v4()).await.status(),
                    StatusCode::CREATED
                );
            }
        }
        let captured = extract_auth(f.state.clone(), &f.bt).await;
        for reactivated in [false, true] {
            f.deactivate(f.b).await;
            if reactivated {
                f.reactivate(f.b).await;
            }
            let before = f.snapshot().await;
            let r = crate::database::organization_read_only(
                &f.pools.app,
                f.org,
                async |tx: &mut PgConnection| select(tx, &captured, None, None).await,
            )
            .await;
            assert_eq!(r.err().unwrap().1, "organization_unavailable");
            assert_eq!(f.snapshot().await, before);
        }
        f.pools.app.close().await;
    }
}
