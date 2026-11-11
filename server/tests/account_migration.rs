#![cfg(test)]

use axum::{
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use fukulow_server::{AppState, app};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::PgPool;
use tower::ServiceExt;
use uuid::Uuid;

const MIGRATION: &str = include_str!("../migrations/202611100146_account_members.sql");
const PASSWORD_HASH: &str = "$argon2id$v=19$m=19456,t=2,p=1$MDEyMzQ1Njc4OWFiY2RlZg$gy5SuVm5Z7Vw7keB9se9p87QGcomaseB/S2U1OhTsM0";

async fn old_schema(pool: &PgPool) {
    let directory = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("migrations");
    let mut paths: Vec<_> = std::fs::read_dir(directory)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| {
            path.file_name().unwrap().to_str().unwrap() < "202611100146_account_members.sql"
        })
        .collect();
    paths.sort();
    for path in paths {
        sqlx::raw_sql(&std::fs::read_to_string(path).unwrap())
            .execute(pool)
            .await
            .unwrap();
    }
}

async fn old_member(pool: &PgPool, email: &str) -> (Uuid, Uuid, String) {
    let organization = Uuid::new_v4();
    let member = Uuid::new_v4();
    sqlx::query("INSERT INTO organizations (organization_id,name) VALUES ($1,'Before migration')")
        .bind(organization)
        .execute(pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO users (organization_id,id,email,name,password_hash,role) VALUES ($1,$2,$3,'Historical name',$4,'owner')").bind(organization).bind(member).bind(email).bind(PASSWORD_HASH).execute(pool).await.unwrap();
    let token = format!(
        "{organization}.{}{}",
        Uuid::new_v4().simple(),
        Uuid::new_v4().simple()
    );
    sqlx::query("INSERT INTO sessions (organization_id,user_id,token_hash) VALUES ($1,$2,$3)")
        .bind(organization)
        .bind(member)
        .bind(Sha256::digest(token.as_bytes()).to_vec())
        .execute(pool)
        .await
        .unwrap();
    (organization, member, token)
}

async fn schema_snapshot(pool: &PgPool) -> Vec<(String, String, String, String)> {
    sqlx::query_as("SELECT table_name::text,column_name::text,data_type::text,is_nullable::text FROM information_schema.columns WHERE table_schema='public' ORDER BY table_name,ordinal_position").fetch_all(pool).await.unwrap()
}

#[sqlx::test(migrations = false)]
async fn account_migration_preserves_single_organization_and_requires_new_sign_in(pool: PgPool) {
    old_schema(&pool).await;
    let (organization, member, old_token) = old_member(&pool, "owner@example.com").await;
    let channel = Uuid::new_v4();
    let message = Uuid::new_v4();
    sqlx::query("INSERT INTO channels (organization_id,id,name,visibility) VALUES ($1,$2,'History','private')").bind(organization).bind(channel).execute(&pool).await.unwrap();
    sqlx::query(
        "INSERT INTO channel_members (organization_id,channel_id,member_id) VALUES ($1,$2,$3)",
    )
    .bind(organization)
    .bind(channel)
    .bind(member)
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO messages (organization_id,id,channel_id,seq,sender,client_message_id,body) VALUES ($1,$2,$3,1,$4,$5,'Historical message')").bind(organization).bind(message).bind(channel).bind(member).bind(Uuid::new_v4()).execute(&pool).await.unwrap();
    let mut transaction = pool.begin().await.unwrap();
    sqlx::raw_sql(MIGRATION)
        .execute(&mut *transaction)
        .await
        .unwrap();
    transaction.commit().await.unwrap();
    let row:(Uuid,Uuid,String,String,String)=sqlx::query_as("SELECT u.id,u.account_id,u.name,u.role,a.email FROM users u JOIN accounts a ON a.id=u.account_id WHERE u.organization_id=$1").bind(organization).fetch_one(&pool).await.unwrap();
    assert_eq!(row.0, member);
    assert_eq!(
        (row.2, row.3, row.4),
        (
            "Historical name".into(),
            "owner".into(),
            "owner@example.com".into()
        )
    );
    let preserved:(Uuid,Uuid)=sqlx::query_as("SELECT m.sender,cm.member_id FROM messages m JOIN channel_members cm USING (organization_id,channel_id) WHERE m.id=$1").bind(message).fetch_one(&pool).await.unwrap();
    assert_eq!(preserved, (member, member));
    let app = app(AppState {
        pool: pool.clone(),
        cookie_secure: false,
        setup_token: "setup-token-test-only".into(),
        sign_in_throttle: Default::default(),
        message_delivery: Default::default(),
        session_changes: Default::default(),
        session_cleanup: Default::default(),
        shutdown: Default::default(),
        ws_allowed_origins: Default::default(),
    });
    let response = app
        .clone()
        .oneshot(
            Request::get("/api/v1/me")
                .header("authorization", format!("Bearer {old_token}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    let response = app
        .clone()
        .oneshot(
            Request::post("/api/v1/native/session")
                .extension(axum::extract::ConnectInfo(
                    "192.0.2.1:1234".parse::<std::net::SocketAddr>().unwrap(),
                ))
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({"email":"owner@example.com","password":"correct horse battery staple"})
                        .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let session: Value =
        serde_json::from_slice(&to_bytes(response.into_body(), 32768).await.unwrap()).unwrap();
    let response = app
        .oneshot(
            Request::get(format!("/api/v1/orgs/{organization}/me"))
                .header(
                    "authorization",
                    format!("Bearer {}", session["token"].as_str().unwrap()),
                )
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
}

#[sqlx::test(migrations = false)]
async fn account_migration_rejects_duplicate_email_and_leaves_schema_unchanged(pool: PgPool) {
    old_schema(&pool).await;
    old_member(&pool, "duplicate@example.com").await;
    old_member(&pool, "duplicate@example.com").await;
    old_member(&pool, "another@example.com").await;
    old_member(&pool, "another@example.com").await;
    let before = schema_snapshot(&pool).await;
    let mut transaction = pool.begin().await.unwrap();
    let error = sqlx::raw_sql(MIGRATION)
        .execute(&mut *transaction)
        .await
        .unwrap_err();
    transaction.rollback().await.unwrap();
    let message = error.as_database_error().unwrap().message();
    assert!(message.contains("duplicate@example.com"));
    assert!(message.contains("another@example.com"));
    assert_eq!(schema_snapshot(&pool).await, before);
    let counts: (i64, i64) =
        sqlx::query_as("SELECT (SELECT count(*) FROM users),(SELECT count(*) FROM sessions)")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(counts, (4, 4));
    assert!(
        sqlx::query_scalar::<_, String>("SELECT password_hash FROM users")
            .fetch_all(&pool)
            .await
            .unwrap()
            .iter()
            .all(|hash| hash == PASSWORD_HASH)
    );
}
