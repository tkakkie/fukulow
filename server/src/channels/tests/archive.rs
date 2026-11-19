use super::*;
use sqlx::Executor;

const EDITS: [fn() -> Value; 3] = [
    || json!({"name":"Renamed"}),
    || json!({"archived":true}),
    || json!({"archived":false}),
];

fn path(id: &Value) -> String {
    format!("/api/v1/channels/{}", id.as_str().unwrap())
}

async fn expect_error(response: Response, status: StatusCode, code: &str) {
    let actual = response.status();
    assert_eq!(
        (actual, body(response).await),
        (status, json!({"error":code}))
    );
}

async fn patch(app: &Router, token: &str, path: &str, input: Value) {
    let response = request(app, "PATCH", path, token, input).await;
    assert_eq!(response.status(), StatusCode::NO_CONTENT);
    assert!(to_bytes(response.into_body(), 1).await.unwrap().is_empty());
}

async fn read(app: &Router, token: &str, path: &str) -> Value {
    let response = request(app, "GET", path, token, Value::Null).await;
    assert_eq!(response.status(), StatusCode::OK);
    body(response).await
}

async fn deny_edits(app: &Router, token: &str, path: &str, status: StatusCode, code: &str) {
    for edit in EDITS {
        expect_error(
            request(app, "PATCH", path, token, edit()).await,
            status,
            code,
        )
        .await;
    }
}

async fn grant(pool: &PgPool, org: Uuid, channel: &Value, member: Uuid) {
    sqlx::query(
        "INSERT INTO channel_members (organization_id, channel_id, member_id) VALUES ($1,$2,$3)",
    )
    .bind(org)
    .bind(Uuid::parse_str(channel["id"].as_str().unwrap()).unwrap())
    .bind(member)
    .execute(pool)
    .await
    .unwrap();
}

#[fukulow_test::test]
async fn archive_permissions_and_capabilities(pool: PgPool) {
    let app = router(&pool).await;
    let org = organization(&pool).await;
    let owner = member(&pool, org, Uuid::new_v4(), "owner").await;
    let admin_id = Uuid::new_v4();
    let admin = member(&pool, org, admin_id, "admin").await;
    let member_id = Uuid::new_v4();
    let regular = member(&pool, org, member_id, "member").await;
    let guest_id = Uuid::new_v4();
    let guest = member(&pool, org, guest_id, "guest").await;
    let public = create(&app, &owner, "Public", "public").await;
    let private = create(&app, &owner, "Private", "private").await;
    let managed = create(&app, &regular, "Member-managed", "private").await;
    let public_path = path(&public["id"]);
    let private_path = path(&private["id"]);
    let managed_path = path(&managed["id"]);

    for (token, target) in [
        (&guest, &public_path),
        (&regular, &private_path),
        (&guest, &private_path),
        (&owner, &managed_path),
        (&admin, &private_path),
    ] {
        deny_edits(
            &app,
            token,
            target,
            StatusCode::NOT_FOUND,
            "channel not found",
        )
        .await;
        expect_error(
            request(&app, "GET", target, token, Value::Null).await,
            StatusCode::NOT_FOUND,
            "channel not found",
        )
        .await;
    }
    grant(&pool, org, &public, guest_id).await;
    grant(&pool, org, &private, member_id).await;
    grant(&pool, org, &private, guest_id).await;
    for (token, target) in [
        (&regular, &public_path),
        (&guest, &public_path),
        (&regular, &private_path),
        (&guest, &private_path),
    ] {
        deny_edits(&app, token, target, StatusCode::FORBIDDEN, "forbidden").await;
        let channel = read(&app, token, target).await;
        assert_eq!(channel["archived"], false);
        for capability in ["can_rename", "can_archive"] {
            assert_eq!(
                channel["capabilities"][capability],
                json!({"allowed":false,"reason":"forbidden"})
            );
        }
    }
    grant(&pool, org, &private, admin_id).await;
    for (index, (token, target)) in [
        (&owner, &public_path),
        (&admin, &public_path),
        (&owner, &private_path),
        (&admin, &private_path),
        (&regular, &managed_path),
    ]
    .into_iter()
    .enumerate()
    {
        let caps = read(&app, token, target).await["capabilities"].clone();
        assert_eq!(caps["can_rename"], json!({"allowed":true}));
        assert_eq!(caps["can_archive"], json!({"allowed":true}));
        patch(
            &app,
            token,
            target,
            json!({"name":format!("Authorized {index}")}),
        )
        .await;
        patch(&app, token, target, json!({"archived":true})).await;
        let caps = read(&app, token, target).await["capabilities"].clone();
        assert_eq!(
            caps["can_rename"],
            json!({"allowed":false,"reason":"channel_archived"})
        );
        assert_eq!(caps["can_archive"], json!({"allowed":true}));
        patch(&app, token, target, json!({"archived":false})).await;
    }
}

#[fukulow_test::test]
async fn archive_rechecks_role_grant_and_revision_after_auth(pool: PgPool) {
    use crate::channels::archive::{ChannelMetadataAuth, UpdateChannelRequest, update_channel};
    use axum::extract::Path;

    let state = AppState::for_test(pool.clone()).await;
    let app = crate::app(state.clone());
    let org = organization(&pool).await;
    let owner = member(&pool, org, Uuid::new_v4(), "owner").await;
    let admin_id = Uuid::new_v4();
    let admin = member(&pool, org, admin_id, "admin").await;
    let public = create(&app, &owner, "Public", "public").await;
    let private = create(&app, &owner, "Private", "private").await;
    grant(&pool, org, &private, admin_id).await;
    let public_id = Uuid::parse_str(public["id"].as_str().unwrap()).unwrap();
    let private_id = Uuid::parse_str(private["id"].as_str().unwrap()).unwrap();
    let old_auth = extract_auth(state.clone(), &admin).await;
    let archive_as_old_admin = async |channel| {
        update_channel(
            State(state.clone()),
            ChannelMetadataAuth(Some(old_auth.clone())),
            Ok(Path((org, channel))),
            ApiJson(UpdateChannelRequest::Archive { archived: true }),
        )
        .await
        .map_err(IntoResponse::into_response)
    };
    sqlx::query(
        "DELETE FROM channel_members WHERE organization_id=$1 AND channel_id=$2 AND member_id=$3",
    )
    .bind(org)
    .bind(private_id)
    .bind(admin_id)
    .execute(&pool)
    .await
    .unwrap();
    expect_error(
        archive_as_old_admin(private_id).await.unwrap_err(),
        StatusCode::NOT_FOUND,
        "channel not found",
    )
    .await;
    sqlx::query("UPDATE users SET role='member' WHERE organization_id=$1 AND id=$2")
        .bind(org)
        .bind(admin_id)
        .execute(&pool)
        .await
        .unwrap();
    expect_error(
        archive_as_old_admin(public_id).await.unwrap_err(),
        StatusCode::FORBIDDEN,
        "forbidden",
    )
    .await;
    for active in [false, true] {
        sqlx::query("UPDATE users SET deactivated_at=CASE WHEN $3 THEN NULL ELSE now() END, role='admin' WHERE organization_id=$1 AND id=$2")
            .bind(org).bind(admin_id).bind(active).execute(&pool).await.unwrap();
        expect_error(
            archive_as_old_admin(public_id).await.unwrap_err(),
            StatusCode::NOT_FOUND,
            "organization_unavailable",
        )
        .await;
    }
    patch(&app, &admin, &path(&public["id"]), json!({"archived":true})).await;
    patch(
        &app,
        &owner,
        &path(&private["id"]),
        json!({"archived":true}),
    )
    .await;
    assert_eq!(
        read(&app, &admin, &path(&public["id"])).await["archived"],
        true
    );
    assert_eq!(
        read(&app, &owner, &path(&private["id"])).await["archived"],
        true
    );
}

#[fukulow_test::test]
async fn archive_input_scope_and_dm_denials(pool: PgPool) {
    let app = router(&pool).await;
    let org = organization(&pool).await;
    let owner = member(&pool, org, Uuid::new_v4(), "owner").await;
    let peer_id = Uuid::new_v4();
    let peer = member(&pool, org, peer_id, "member").await;
    let outsider = member(&pool, org, Uuid::new_v4(), "admin").await;
    let foreign_org = organization(&pool).await;
    let foreign = member(&pool, foreign_org, Uuid::new_v4(), "owner").await;
    let foreign_channel = create(&app, &foreign, "Foreign", "public").await;
    let ordinary = create(&app, &owner, "Ordinary", "public").await;
    let ordinary_path = path(&ordinary["id"]);
    let dm = request(
        &app,
        "POST",
        &format!("/api/v1/orgs/{org}/dms"),
        &owner,
        json!({"member_id":peer_id}),
    )
    .await;
    assert!(dm.status().is_success());
    let payload = body(dm).await;
    let dm_path = path(&payload["id"]);
    for (token, target, status, code) in [
        (
            &owner,
            &dm_path,
            StatusCode::BAD_REQUEST,
            "dm_channel_fixed",
        ),
        (&peer, &dm_path, StatusCode::BAD_REQUEST, "dm_channel_fixed"),
        (
            &outsider,
            &dm_path,
            StatusCode::NOT_FOUND,
            "channel not found",
        ),
        (
            &owner,
            &path(&foreign_channel["id"]),
            StatusCode::NOT_FOUND,
            "channel not found",
        ),
        (
            &owner,
            &format!("/api/v1/channels/{}", Uuid::new_v4()),
            StatusCode::NOT_FOUND,
            "channel not found",
        ),
        (
            &owner,
            &format!(
                "/api/v1/orgs/{foreign_org}/channels/{}",
                foreign_channel["id"].as_str().unwrap()
            ),
            StatusCode::NOT_FOUND,
            "organization_unavailable",
        ),
    ] {
        deny_edits(&app, token, target, status, code).await;
        expect_error(
            request(&app, "GET", target, token, Value::Null).await,
            status,
            code,
        )
        .await;
    }
    for capability in ["can_rename", "can_archive"] {
        assert_eq!(
            payload["capabilities"][capability],
            json!({"allowed":false,"reason":"dm_channel_fixed"})
        );
    }

    let foreign_path = format!("/api/v1/orgs/{foreign_org}/channels/{}", Uuid::new_v4());
    for input in [
        json!({}),
        json!(["Name"]),
        Value::Null,
        json!({"name":null}),
        json!({"archived":null}),
        json!({"archived":"true"}),
        json!({"name":"Name","archived":false}),
        json!({"archived":true,"extra":1}),
        json!({"name":"","extra":1}),
        json!({"name":" Name"}),
        json!({"name":"\u{0}"}),
        json!({"name":"日".repeat(129)}),
    ] {
        expect_error(
            request(&app, "PATCH", &foreign_path, &owner, input).await,
            StatusCode::BAD_REQUEST,
            "invalid input",
        )
        .await;
    }
    let unknown = "a".repeat(64);
    for (token, target, content_type, data, status, code) in [
        (
            unknown.as_str(),
            "/api/v1/orgs/invalid/channels/invalid",
            "text/plain",
            "x".into(),
            StatusCode::UNAUTHORIZED,
            "invalid credentials",
        ),
        (
            unknown.as_str(),
            "/api/v1/orgs/invalid/channels/%FF",
            "application/json",
            "{}".into(),
            StatusCode::UNAUTHORIZED,
            "invalid credentials",
        ),
        (
            owner.as_str(),
            foreign_path.as_str(),
            "text/plain",
            "{}".into(),
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "expected application/json",
        ),
        (
            owner.as_str(),
            foreign_path.as_str(),
            "application/json",
            "x".repeat(16 * 1024 + 1),
            StatusCode::PAYLOAD_TOO_LARGE,
            "request body too large",
        ),
        (
            owner.as_str(),
            foreign_path.as_str(),
            "application/json",
            r#"{"archived":true,"archived":false}"#.into(),
            StatusCode::BAD_REQUEST,
            "invalid input",
        ),
    ] {
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("PATCH")
                    .uri(target)
                    .header(header::AUTHORIZATION, format!("Bearer {token}"))
                    .header(header::CONTENT_TYPE, content_type)
                    .body(Body::from(data))
                    .unwrap(),
            )
            .await
            .unwrap();
        expect_error(response, status, code).await;
    }
    for method in ["GET", "PATCH"] {
        expect_error(
            request(
                &app,
                method,
                &format!("/api/v1/orgs/{foreign_org}/channels/invalid"),
                &owner,
                json!({"archived":true}),
            )
            .await,
            StatusCode::BAD_REQUEST,
            "invalid input",
        )
        .await;
    }
    patch(
        &app,
        &owner,
        &ordinary_path,
        json!({"name":"日".repeat(128)}),
    )
    .await;
    patch(&app, &owner, &ordinary_path, json!({"archived":true})).await;
    assert_eq!(read(&app, &owner, &ordinary_path).await["archived"], true);
    patch(&app, &owner, &ordinary_path, json!({"archived":false})).await;
    assert_eq!(
        read(&app, &foreign, &path(&foreign_channel["id"])).await,
        foreign_channel
    );
}

#[fukulow_test::test]
async fn archived_list_and_name_uniqueness(pool: PgPool) {
    let app = router(&pool).await;
    let org = organization(&pool).await;
    let owner = member(&pool, org, Uuid::new_v4(), "owner").await;
    let regular = member(&pool, org, Uuid::new_v4(), "member").await;
    let public = create(&app, &owner, "z Archive", "public").await;
    let private = create(&app, &owner, "A Archive", "private").await;
    let active = create(&app, &owner, "Active", "public").await;
    let public_path = path(&public["id"]);
    let private_path = path(&private["id"]);
    let active_path = path(&active["id"]);
    patch(&app, &owner, &public_path, json!({"name":"Z archive"})).await;
    assert_eq!(read(&app, &owner, &public_path).await["name"], "Z archive");
    for target in [&public_path, &private_path] {
        patch(&app, &owner, target, json!({"archived":true})).await;
    }
    for name in ["Z archive", "z ARCHIVE", "Active", "Free"] {
        expect_error(
            request(&app, "PATCH", &public_path, &owner, json!({"name":name})).await,
            StatusCode::CONFLICT,
            "channel_archived",
        )
        .await;
    }
    expect_error(
        request(
            &app,
            "PATCH",
            &active_path,
            &owner,
            json!({"name":"Z ARCHIVE"}),
        )
        .await,
        StatusCode::CONFLICT,
        "channel name already exists",
    )
    .await;
    expect_error(
        request(
            &app,
            "POST",
            "/api/v1/channels",
            &owner,
            json!({"name":"a ARCHIVE","visibility":"public"}),
        )
        .await,
        StatusCode::CONFLICT,
        "channel name already exists",
    )
    .await;
    let open = read(&app, &owner, "/api/v1/channels").await;
    assert_eq!(
        open,
        read(&app, &owner, "/api/v1/channels?archived=false").await
    );
    assert_eq!(open["channels"].as_array().unwrap().len(), 1);
    assert_eq!(open["channels"][0]["id"], active["id"]);
    let archived = read(&app, &owner, "/api/v1/channels?archived=true").await;
    assert_eq!(archived["history_generation"], open["history_generation"]);
    assert_eq!(archived["channels"].as_array().unwrap().len(), 2);
    assert_eq!(archived["channels"][0]["id"], private["id"]);
    assert_eq!(archived["channels"][1]["id"], public["id"]);
    let visible = read(&app, &regular, "/api/v1/channels?archived=true").await;
    assert_eq!(visible["channels"].as_array().unwrap().len(), 1);
    assert_eq!(visible["channels"][0]["id"], public["id"]);
    assert_eq!(
        visible["channels"][0]["capabilities"]["can_rename"]["reason"],
        "forbidden"
    );
    expect_error(
        request(
            &app,
            "PATCH",
            &public_path,
            &regular,
            json!({"name":"Active"}),
        )
        .await,
        StatusCode::FORBIDDEN,
        "forbidden",
    )
    .await;
    expect_error(
        request(
            &app,
            "GET",
            "/api/v1/channels?archived=1",
            &owner,
            Value::Null,
        )
        .await,
        StatusCode::BAD_REQUEST,
        "invalid input",
    )
    .await;
    expect_error(
        request(
            &app,
            "GET",
            &format!("/api/v1/orgs/{}/channels?archived=1", Uuid::new_v4()),
            &owner,
            Value::Null,
        )
        .await,
        StatusCode::NOT_FOUND,
        "organization_unavailable",
    )
    .await;
    expect_error(
        request(
            &app,
            "GET",
            &format!(
                "/api/v1/channels?archived=true&history_generation={}",
                Uuid::new_v4()
            ),
            &owner,
            Value::Null,
        )
        .await,
        StatusCode::CONFLICT,
        "history_generation_changed",
    )
    .await;
    patch(&app, &owner, &public_path, json!({"archived":false})).await;
    assert_eq!(read(&app, &owner, &public_path).await["name"], "Z archive");
}

#[sqlx::test(migrations = false)]
async fn archive_migration_preserves_existing_channels_and_rejects_dms(pool: PgPool) {
    let migrator = sqlx::migrate::Migrator::new(std::path::Path::new(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/migrations"
    )))
    .await
    .unwrap();
    let archive_version = 202611200410;
    for migration in migrator.iter().filter(|m| m.version < archive_version) {
        pool.execute(migration.sql.as_ref()).await.unwrap();
    }
    let org = organization(&pool).await;
    let ordinary = Uuid::new_v4();
    sqlx::query("INSERT INTO channels (organization_id,id,name,visibility) VALUES ($1,$2,'Existing','public')")
        .bind(org).bind(ordinary).execute(&pool).await.unwrap();
    let dm = Uuid::new_v4();
    let mut pair = [Uuid::new_v4(), Uuid::new_v4()];
    pair.sort();
    for id in pair {
        member(&pool, org, id, "member").await;
    }
    sqlx::query("INSERT INTO channels (organization_id,id,kind,lower_member_id,higher_member_id) VALUES ($1,$2,'dm',$3,$4)")
        .bind(org).bind(dm).bind(pair[0]).bind(pair[1]).execute(&pool).await.unwrap();
    let snapshot = "SELECT jsonb_agg(to_jsonb(c) - 'archived_at' ORDER BY c.id) FROM channels c WHERE organization_id=$1";
    let before: Value = sqlx::query_scalar(snapshot)
        .bind(org)
        .fetch_one(&pool)
        .await
        .unwrap();
    pool.execute(
        migrator
            .iter()
            .find(|m| m.version == archive_version)
            .unwrap()
            .sql
            .as_ref(),
    )
    .await
    .unwrap();
    let after: Value = sqlx::query_scalar(snapshot)
        .bind(org)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(after, before);
    let archived: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM channels WHERE organization_id=$1 AND archived_at IS NOT NULL",
    )
    .bind(org)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(archived, 0);
    let update = "UPDATE channels SET archived_at=now() WHERE organization_id=$1 AND id=$2";
    let error = sqlx::query(update)
        .bind(org)
        .bind(dm)
        .execute(&pool)
        .await
        .unwrap_err();
    assert_eq!(
        error.as_database_error().unwrap().constraint(),
        Some("channels_dm_never_archived")
    );
    assert_eq!(
        sqlx::query(update)
            .bind(org)
            .bind(ordinary)
            .execute(&pool)
            .await
            .unwrap()
            .rows_affected(),
        1
    );
}
