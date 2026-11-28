use super::*;
use crate::{
    channels::tests::{member, organization},
    test_support::TestPools,
};
use axum::{
    body::{Body, to_bytes},
    extract::Request,
};
use serde_json::{Value, json};
use sqlx::PgPool;
use tower::ServiceExt;

mod access;
mod archive;
mod races;
mod rest;

const SECTIONS: &str = "/me/sections";
const SECTION_ORDER: &str = "/me/sections/order";
const CHANNEL_ORDER: &str = "/me/section-channel-order";

struct Fixture {
    pools: TestPools,
    state: AppState,
    app: Router,
    owner: Owner,
    token: String,
}

impl Fixture {
    async fn new(pool: PgPool) -> Self {
        let pools = TestPools::new(pool).await;
        let org = organization(&pools.admin).await;
        let id = Uuid::new_v4();
        let token = member(&pools.admin, org, id, "owner").await;
        let state = AppState::for_test(pools.app.clone()).await;
        let app = crate::app(state.clone(), Default::default());
        Self {
            pools,
            state,
            app,
            owner: Owner {
                org,
                member: id,
                revision: 0,
            },
            token,
        }
    }

    async fn send(&self, method: &str, suffix: &str, input: Value) -> Response {
        send(
            &self.app,
            method,
            &path(self.owner.org, suffix),
            &self.token,
            input,
        )
        .await
    }

    async fn get(&self, suffix: &str) -> Value {
        expected(self.send("GET", suffix, Value::Null).await, StatusCode::OK).await
    }

    async fn create(&self, id: Uuid, name: &str) -> Value {
        expected(
            self.send("POST", SECTIONS, json!({"id": id, "name": name}))
                .await,
            StatusCode::CREATED,
        )
        .await
    }

    async fn channel(&self, name: &str, visibility: &str) -> Uuid {
        self.channel_as(&self.token, name, visibility).await
    }

    async fn channel_as(&self, token: &str, name: &str, visibility: &str) -> Uuid {
        let response = crate::channels::tests::request(
            &self.app,
            "POST",
            "/api/v1/channels",
            token,
            json!({"name": name, "visibility": visibility}),
        )
        .await;
        let channel = expected(response, StatusCode::CREATED).await;
        serde_json::from_value(channel["id"].clone()).unwrap()
    }

    async fn changed(&self, method: &str, suffix: &str, input: Value) {
        expected(
            self.send(method, suffix, input).await,
            StatusCode::NO_CONTENT,
        )
        .await;
        self.distinct_positions().await;
    }

    async fn distinct_positions(&self) {
        for sql in [
            "SELECT EXISTS (SELECT 1 FROM member_sections WHERE organization_id=$1 GROUP BY member_id, position HAVING count(*)>1)",
            "SELECT EXISTS (SELECT 1 FROM member_section_placements WHERE organization_id=$1 GROUP BY member_id, section_id, position HAVING count(*)>1)",
        ] {
            let duplicate: bool = sqlx::query_scalar(sql)
                .bind(self.owner.org)
                .fetch_one(&self.pools.admin)
                .await
                .unwrap();
            assert!(!duplicate);
        }
    }
}

fn path(org: Uuid, suffix: &str) -> String {
    format!("/api/v1/orgs/{org}{suffix}")
}

fn section_path(id: Uuid) -> String {
    format!("{SECTIONS}/{id}")
}

fn placement_path(id: Uuid) -> String {
    format!("/me/channel-sections/{id}")
}

fn channel_order(section_id: Option<Uuid>, ids: &[Uuid]) -> Value {
    json!({"section_id": section_id, "channel_ids": ids})
}

async fn send(app: &Router, method: &str, uri: &str, token: &str, input: Value) -> Response {
    raw(
        app,
        method,
        uri,
        token,
        Some("application/json"),
        input.to_string(),
    )
    .await
}

async fn raw(
    app: &Router,
    method: &str,
    uri: &str,
    token: &str,
    content_type: Option<&str>,
    body: String,
) -> Response {
    let mut builder = Request::builder().method(method).uri(uri);
    if !token.is_empty() {
        builder = builder.header(header::AUTHORIZATION, format!("Bearer {token}"));
    }
    if let Some(content_type) = content_type {
        builder = builder.header(header::CONTENT_TYPE, content_type);
    }
    app.clone()
        .oneshot(builder.body(Body::from(body)).unwrap())
        .await
        .unwrap()
}

async fn expected(response: Response, status: StatusCode) -> Value {
    assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
    let actual = response.status();
    let bytes = to_bytes(response.into_body(), 2 * 1024 * 1024)
        .await
        .unwrap();
    assert_eq!(actual, status, "{}", String::from_utf8_lossy(&bytes));
    if status == StatusCode::NO_CONTENT {
        assert!(bytes.is_empty());
        Value::Null
    } else {
        serde_json::from_slice(&bytes).unwrap()
    }
}

async fn denied(response: Response, status: StatusCode, error: &str) {
    assert_eq!(expected(response, status).await, json!({"error": error}));
}

#[fukulow_test::test]
async fn section_placement_indexes(pool: PgPool) {
    let f = Fixture::new(pool).await;
    let group = Uuid::new_v4();
    f.create(group, "Ordered").await;
    let channel = f.channel("Placed", "public").await;
    f.changed("PUT", &placement_path(channel), json!({"section_id":group}))
        .await;
    crate::database::organization_read_only(&f.pools.app, f.owner.org, async |tx: &mut PgConnection| {
        // Small fixtures favor a sequential scan; verify the index paths exist.
        sqlx::query("SET LOCAL enable_seqscan=off").execute(&mut *tx).await?;
        let cleanup: Vec<String> = sqlx::query_scalar(
            "EXPLAIN (COSTS OFF) SELECT member_id FROM member_section_placements WHERE organization_id=$1 AND channel_id=$2",
        ).bind(f.owner.org).bind(channel).fetch_all(&mut *tx).await?;
        let group_plan: Vec<String> = sqlx::query_scalar(&format!("EXPLAIN (COSTS OFF) {}", channels::group_slots_sql(true)))
            .bind(f.owner.org).bind(f.owner.member).bind(f.owner.revision).bind(group)
            .fetch_all(&mut *tx).await?;
        assert!(cleanup.iter().any(|row| row.contains("member_section_placements_by_channel")), "{cleanup:?}");
        assert!(group_plan.iter().any(|row| row.contains("member_section_placements_by_group")), "{group_plan:?}");
        Ok::<_, sqlx::Error>(())
    }).await.unwrap();
}
