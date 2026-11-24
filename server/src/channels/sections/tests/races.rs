use super::*;
use crate::test_support::{Blocked, Count, wait_blocked as wait_for_blocked};
use sqlx::{Postgres, Transaction};
use std::time::Duration;
use tokio::task::JoinHandle;

mod archive;
mod authority;
mod deletion;
mod ordering;

const LAYOUT_LOCK: &str = "INSERT INTO member_section_generations%ON CONFLICT%";
const ORG_SHARE: &str = "SELECT organization_id FROM organizations%FOR SHARE";
const ORG_EXCLUSIVE: &str = "SELECT organization_id FROM organizations%FOR NO KEY UPDATE";

async fn wait_blocked(f: &Fixture, query: &str) {
    wait_blocked_count(f, query, 1).await;
}

async fn wait_blocked_count(f: &Fixture, query: &str, minimum: i64) {
    wait_blocked_matching(f, query, minimum, None).await;
}

async fn wait_blocked_matching(f: &Fixture, query: &str, minimum: i64, blocker: Option<i32>) {
    wait_for_blocked(
        &f.pools.admin,
        match blocker {
            Some(pid) => Blocked::LockQueryBehind(query, pid),
            None => Blocked::LockQuery(query),
        },
        Count::AtLeast(minimum),
        Duration::from_secs(4),
    )
    .await;
}

async fn pause(f: &Fixture, event: &str, table: &str) -> Transaction<'static, Postgres> {
    let ddl = format!(
        "CREATE OR REPLACE FUNCTION test_hold_sections() RETURNS trigger LANGUAGE plpgsql AS
         'BEGIN PERFORM pg_advisory_xact_lock(204,2); RETURN NULL; END';
         CREATE TRIGGER test_hold_sections BEFORE {event} ON {table}
         FOR EACH STATEMENT EXECUTE FUNCTION test_hold_sections()",
    );
    sqlx::raw_sql(&ddl).execute(&f.pools.admin).await.unwrap();
    let mut blocker = f.pools.admin.begin().await.unwrap();
    sqlx::query("SELECT pg_advisory_xact_lock(204,2)")
        .execute(&mut *blocker)
        .await
        .unwrap();
    blocker
}

async fn unpause(f: &Fixture, table: &str) {
    sqlx::query(&format!("DROP TRIGGER test_hold_sections ON {table}"))
        .execute(&f.pools.admin)
        .await
        .unwrap();
}

fn spawn(
    f: &Fixture,
    method: &'static str,
    suffix: &str,
    token: &str,
    payload: Value,
) -> JoinHandle<Response> {
    let (app, uri, token) = (f.app.clone(), path(f.owner.org, suffix), token.to_owned());
    tokio::spawn(async move { send(&app, method, &uri, &token, payload).await })
}

async fn joined(task: JoinHandle<Response>) -> Response {
    tokio::time::timeout(Duration::from_secs(5), task)
        .await
        .unwrap()
        .unwrap()
}

#[fukulow_test::test]
async fn concurrent_creates_and_first_generation(pool: PgPool) {
    let f = Fixture::new(pool).await;
    let (id, other) = (Uuid::new_v4(), Uuid::new_v4());
    let table = "member_sections";
    let create_wait = "INSERT INTO member_sections (organization_id,member_id,id,name,position)%";
    let owner2 = Uuid::new_v4();
    let token2 = member(&f.pools.admin, f.owner.org, owner2, "member").await;
    for (second_id, token, second_status, generation) in [
        (id, f.token.as_str(), StatusCode::OK, "1"),
        (other, token2.as_str(), StatusCode::CREATED, "2"),
    ] {
        let blocker = pause(&f, "INSERT", table).await;
        let first = spawn(&f, "POST", SECTIONS, token, json!({"id":id,"name":"Same"}));
        wait_blocked(&f, create_wait).await;
        let second = spawn(
            &f,
            "POST",
            SECTIONS,
            token,
            json!({"id":second_id,"name":"Same"}),
        );
        wait_blocked(&f, LAYOUT_LOCK).await;
        blocker.commit().await.unwrap();
        assert_eq!(
            expected(joined(first).await, StatusCode::CREATED).await,
            json!({"id":id,"generation":"1"})
        );
        assert_eq!(
            expected(joined(second).await, second_status).await,
            json!({"id":second_id,"generation":generation})
        );
        let layout = expected(
            send(
                &f.app,
                "GET",
                &path(f.owner.org, SECTIONS),
                token,
                Value::Null,
            )
            .await,
            StatusCode::OK,
        )
        .await;
        assert_eq!(layout["generation"], generation);
        let wanted = if second_id == id {
            vec![id]
        } else {
            vec![id, other]
        };
        assert_eq!(
            layout["sections"]
                .as_array()
                .unwrap()
                .iter()
                .map(|section| section["id"].clone())
                .collect::<Vec<_>>(),
            json!(wanted).as_array().unwrap().clone()
        );
        unpause(&f, table).await;
    }
    f.distinct_positions().await;
}

#[fukulow_test::test]
async fn concurrent_creates_at_the_cap(pool: PgPool) {
    let f = Fixture::new(pool).await;
    let retired = Uuid::new_v4();
    f.create(retired, "Retired").await;
    f.changed("DELETE", &section_path(retired), Value::Null)
        .await;
    let mut order = Vec::new();
    for _ in 0..49 {
        let id = Uuid::new_v4();
        f.create(id, "Same").await;
        order.push(id);
    }
    let (id, excess) = (Uuid::new_v4(), Uuid::new_v4());
    let blocker = pause(&f, "INSERT", "member_sections").await;
    let winning = spawn(
        &f,
        "POST",
        SECTIONS,
        &f.token,
        json!({"id":id,"name":"Last"}),
    );
    wait_blocked(
        &f,
        "INSERT INTO member_sections (organization_id,member_id,id,name,position)%",
    )
    .await;
    let losing = spawn(
        &f,
        "POST",
        SECTIONS,
        &f.token,
        json!({"id":excess,"name":"One too many"}),
    );
    wait_blocked(&f, LAYOUT_LOCK).await;
    blocker.commit().await.unwrap();
    expected(joined(winning).await, StatusCode::CREATED).await;
    denied(joined(losing).await, StatusCode::CONFLICT, "section_limit").await;
    unpause(&f, "member_sections").await;
    let layout = f.get(SECTIONS).await;
    assert_eq!(layout["generation"], "52");
    assert_eq!(layout["sections"].as_array().unwrap().len(), 50);
    for (attempt, name, status, error) in [
        (id, "Different", StatusCode::CONFLICT, "section_id_conflict"),
        (retired, "Retired", StatusCode::CONFLICT, "section_deleted"),
        (
            excess,
            "One too many",
            StatusCode::CONFLICT,
            "section_limit",
        ),
    ] {
        denied(
            f.send("POST", SECTIONS, json!({"id":attempt,"name":name}))
                .await,
            status,
            error,
        )
        .await;
    }
    assert_eq!(
        expected(
            f.send("POST", SECTIONS, json!({"id":id,"name":"Last"}))
                .await,
            StatusCode::OK
        )
        .await,
        json!({"id":id,"generation":"52"})
    );
    assert_eq!(f.get(SECTIONS).await, layout);
    order.push(id);
    f.changed("PUT", SECTION_ORDER, json!({"section_ids":order}))
        .await;
    f.changed("DELETE", &section_path(id), Value::Null).await;
    f.create(excess, "One too many").await;
    assert_eq!(f.get(SECTIONS).await["generation"], "54");
}
