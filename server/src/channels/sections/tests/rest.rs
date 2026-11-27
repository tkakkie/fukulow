use super::*;
use crate::channels::access::AccessStatus;
use sha2::{Digest, Sha256};

#[fukulow_test::test]
async fn layout_lifecycle(pool: PgPool) {
    let f = Fixture::new(pool).await;
    let (first, second) = (Uuid::new_v4(), Uuid::new_v4());
    let z = f.channel("Z", "public").await;
    let a = f.channel("a", "public").await;
    let accented = f.channel("Ä", "public").await;
    let lower = f.channel("ä", "public").await;
    assert_eq!(
        f.get(SECTIONS).await,
        json!({"generation":"0","sections":[],"other_channel_ids":[a,z,accented,lower]})
    );
    let no_op = f
        .send("PUT", &placement_path(z), json!({"section_id":null}))
        .await;
    expected(no_op, StatusCode::NO_CONTENT).await;
    assert_eq!(f.get(SECTIONS).await["generation"], "0");
    let generation_rows: i64 =
        sqlx::query_scalar("SELECT count(*) FROM member_section_generations")
            .fetch_one(&f.pools.admin)
            .await
            .unwrap();
    assert_eq!(generation_rows, 0);
    expected(
        f.send(
            "POST",
            &format!("/channels/{a}/members"),
            json!({"member_id": f.owner.member}),
        )
        .await,
        StatusCode::NO_CONTENT,
    )
    .await;
    expected(f.send("POST", &format!("/channels/{a}/messages"), json!({"client_message_id":Uuid::new_v4(),"body":"Preserve this Message","topic_name":"History"})).await, StatusCode::CREATED).await;
    let access = AccessChanges::default();
    f.state
        .session_changes
        .set_subscription_recheck(std::sync::Arc::new(access.clone()));
    let subscription = access
        .subscribe(
            &f.pools.app,
            f.owner.org,
            (f.owner.member, f.owner.revision),
            a,
        )
        .await
        .unwrap()
        .unwrap();
    let before = non_layout_state(&f).await;
    assert_eq!(
        f.create(first, "Same　name").await,
        json!({"id":first,"generation":"1"})
    );
    f.create(second, "Same　name").await;
    let first_path = section_path(first);
    f.changed("PATCH", &first_path, json!({"name":"Renamed"}))
        .await;
    f.changed("PATCH", &first_path, json!({"name":"Renamed"}))
        .await;
    let retry = f
        .send("POST", SECTIONS, json!({"id":first,"name":"Same　name"}))
        .await;
    assert_eq!(
        expected(retry, StatusCode::OK).await,
        json!({"id":first,"generation":"3"})
    );
    let renamed = f.get(SECTIONS).await;
    denied(
        f.send("POST", SECTIONS, json!({"id":first,"name":"Renamed"}))
            .await,
        StatusCode::CONFLICT,
        "section_id_conflict",
    )
    .await;
    assert_eq!(f.get(SECTIONS).await, renamed);

    f.changed("PUT", SECTION_ORDER, json!({"section_ids":[second, first]}))
        .await;
    f.changed("PUT", SECTION_ORDER, json!({"section_ids":[second, first]}))
        .await;
    for (channel, destination) in [
        (a, Some(first)),
        (z, Some(first)),
        (a, None),
        (a, None),
        (a, Some(first)),
    ] {
        f.changed(
            "PUT",
            &placement_path(channel),
            json!({"section_id":destination}),
        )
        .await;
        assert_eq!(
            f.get(&placement_path(channel)).await["section_id"],
            json!(destination)
        );
    }
    assert_eq!(
        f.get(&first_path).await,
        json!({"generation":"8","section":{"id":first,"name":"Renamed","channel_ids":[z,a]}})
    );
    f.changed("PUT", &placement_path(z), json!({"section_id":null}))
        .await;
    assert_eq!(
        f.get(SECTIONS).await["other_channel_ids"],
        json!([z, accented, lower])
    );
    f.changed("DELETE", &first_path, Value::Null).await;
    f.changed("DELETE", &first_path, Value::Null).await;
    let deleted = f.get(SECTIONS).await;
    assert_eq!(
        deleted,
        json!({"generation":"10","sections":[{"id":second,"name":"Same　name","channel_ids":[]}],"other_channel_ids":[z,a,accented,lower]})
    );
    denied(
        f.send("POST", SECTIONS, json!({"id":first,"name":"Same　name"}))
            .await,
        StatusCode::CONFLICT,
        "section_deleted",
    )
    .await;
    denied(
        f.send("GET", &first_path, Value::Null).await,
        StatusCode::NOT_FOUND,
        "section_not_found",
    )
    .await;
    assert_eq!(f.get(SECTIONS).await, deleted);
    assert_eq!(non_layout_state(&f).await, before);
    assert_eq!(subscription.status(), AccessStatus::Active);
}

async fn non_layout_state(f: &Fixture) -> Vec<Value> {
    let mut state = Vec::new();
    for table in [
        "organizations",
        "users",
        "channels",
        "channel_members",
        "messages",
        "channel_read_positions",
        "topic_read_positions",
    ] {
        let query = format!(
            "SELECT to_jsonb(t) FROM {table} t WHERE organization_id=$1 ORDER BY to_jsonb(t)"
        );
        state.push(Value::Array(
            sqlx::query_scalar(&query)
                .bind(f.owner.org)
                .fetch_all(&f.pools.admin)
                .await
                .unwrap(),
        ));
    }
    state
}

#[fukulow_test::test]
async fn rest_precedence_and_refusals(pool: PgPool) {
    let f = Fixture::new(pool).await;
    let before = f.get(SECTIONS).await;
    let bad_org = "/api/v1/orgs/invalid/me/sections";
    let bad_delete = "/api/v1/orgs/invalid/me/sections/%FF";
    let other_org = organization(&f.pools.admin).await;
    let (expired, revoked) = (
        member(&f.pools.admin, f.owner.org, Uuid::new_v4(), "member").await,
        member(&f.pools.admin, f.owner.org, Uuid::new_v4(), "member").await,
    );
    sqlx::query(
        "UPDATE account_sessions SET expires_at=now()-interval '1 day' WHERE token_hash=$1",
    )
    .bind(Sha256::digest(expired.as_bytes()).to_vec())
    .execute(&f.pools.admin)
    .await
    .unwrap();
    sqlx::query("DELETE FROM account_sessions WHERE token_hash=$1")
        .bind(Sha256::digest(revoked.as_bytes()).to_vec())
        .execute(&f.pools.admin)
        .await
        .unwrap();
    let invalid = "a".repeat(64);
    for token in ["", &invalid, &expired, &revoked] {
        for (method, uri) in [("POST", bad_org), ("DELETE", bad_delete)] {
            denied(
                raw(&f.app, method, uri, token, None, "invalid".into()).await,
                StatusCode::UNAUTHORIZED,
                "invalid credentials",
            )
            .await;
        }
    }
    denied(
        raw(&f.app, "POST", bad_org, &f.token, None, "invalid".into()).await,
        StatusCode::BAD_REQUEST,
        "invalid input",
    )
    .await;
    for org in [other_org, Uuid::new_v4()] {
        let uri = path(org, "/me/sections/%FF");
        for method in ["PATCH", "DELETE"] {
            denied(
                raw(&f.app, method, &uri, &f.token, None, "invalid".into()).await,
                StatusCode::NOT_FOUND,
                "organization_unavailable",
            )
            .await;
        }
    }
    for uri in [
        path(f.owner.org, "/me/sections/%FF"),
        path(f.owner.org, "/me/sections?unknown=1"),
        path(f.owner.org, SECTION_ORDER),
    ] {
        denied(
            send(&f.app, "GET", &uri, &f.token, Value::Null).await,
            StatusCode::BAD_REQUEST,
            "invalid input",
        )
        .await;
    }
    let cookie = f
        .app
        .clone()
        .oneshot(
            Request::builder()
                .uri(path(f.owner.org, SECTIONS))
                .header(
                    header::COOKIE,
                    format!("__Host-fukulow_session={}", f.token),
                )
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(expected(cookie, StatusCode::OK).await, before);

    let id = Uuid::new_v4();
    let create = path(f.owner.org, SECTIONS);
    for payload in [
        "{".to_owned(),
        json!({"id":"bad","name":"Valid"}).to_string(),
        json!({"id":id}).to_string(),
        json!({"id":id,"name":null}).to_string(),
        json!({"id":id,"name":"Valid","owner":id}).to_string(),
    ] {
        denied(
            raw(
                &f.app,
                "POST",
                &create,
                &f.token,
                Some("application/json"),
                payload,
            )
            .await,
            StatusCode::BAD_REQUEST,
            "invalid input",
        )
        .await;
    }
    denied(
        raw(
            &f.app,
            "POST",
            &create,
            &f.token,
            Some("text/plain"),
            json!({"id":id,"name":"Valid"}).to_string(),
        )
        .await,
        StatusCode::UNSUPPORTED_MEDIA_TYPE,
        "expected application/json",
    )
    .await;
    for invalid in [
        String::new(),
        "🙂".repeat(61),
        "a\0b".into(),
        " a".into(),
        "a　".into(),
        " \n　".into(),
    ] {
        denied(
            f.send("POST", SECTIONS, json!({"id":id,"name":invalid}))
                .await,
            StatusCode::BAD_REQUEST,
            "invalid_section_name",
        )
        .await;
    }
    for (suffix, input) in [
        (SECTION_ORDER.to_owned(), json!({"section_ids":[id,id]})),
        (CHANNEL_ORDER.to_owned(), channel_order(None, &[id, id])),
    ] {
        denied(
            f.send("PUT", &suffix, input).await,
            StatusCode::BAD_REQUEST,
            "invalid_section_order",
        )
        .await;
    }
    for (suffix, input) in [
        (placement_path(id), json!({})),
        (CHANNEL_ORDER.to_owned(), json!({"channel_ids":[]})),
        (
            CHANNEL_ORDER.to_owned(),
            json!({"channel_ids":[],"section_id":null,"member_id":id}),
        ),
        (
            CHANNEL_ORDER.to_owned(),
            json!({"channel_ids":null,"section_id":null}),
        ),
    ] {
        denied(
            f.send("PUT", &suffix, input).await,
            StatusCode::BAD_REQUEST,
            "invalid input",
        )
        .await;
    }
    assert_eq!(f.get(SECTIONS).await, before);
    f.changed("PUT", SECTION_ORDER, json!({"section_ids":[]}))
        .await;
    f.changed("PUT", CHANNEL_ORDER, channel_order(None, &[]))
        .await;

    let long_name = "🙂".repeat(60);
    f.create(id, &long_name).await;
    let created = f.get(SECTIONS).await;
    denied(
        f.send("PUT", SECTION_ORDER, json!({"section_ids":[]}))
            .await,
        StatusCode::CONFLICT,
        "section_layout_changed",
    )
    .await;
    denied(
        f.send(
            "PUT",
            SECTION_ORDER,
            json!({"section_ids":[Uuid::new_v4()]}),
        )
        .await,
        StatusCode::NOT_FOUND,
        "section_not_found",
    )
    .await;
    assert_eq!(f.get(SECTIONS).await, created);
    f.changed("PUT", SECTION_ORDER, json!({"section_ids":[id]}))
        .await;
    f.changed("PATCH", &section_path(id), json!({"name":long_name}))
        .await;
}

#[fukulow_test::test]
async fn byte_and_id_boundaries(pool: PgPool) {
    let f = Fixture::new(pool).await;
    let id = Uuid::new_v4();
    for (method, suffix, input, limit) in [
        ("POST", SECTIONS, json!({"id":id,"name":"Limit"}), 16 * 1024),
        ("PUT", CHANNEL_ORDER, channel_order(None, &[]), 1024 * 1024),
    ] {
        let payload = input.to_string();
        let exact = format!("{payload}{}", " ".repeat(limit - payload.len()));
        let uri = path(f.owner.org, suffix);
        let before = f.get(SECTIONS).await;
        denied(
            raw(
                &f.app,
                method,
                &uri,
                &f.token,
                Some("application/json"),
                format!("{exact} "),
            )
            .await,
            StatusCode::PAYLOAD_TOO_LARGE,
            "request body too large",
        )
        .await;
        assert_eq!(f.get(SECTIONS).await, before);
        let status = if method == "POST" {
            StatusCode::CREATED
        } else {
            StatusCode::NO_CONTENT
        };
        expected(
            raw(
                &f.app,
                method,
                &uri,
                &f.token,
                Some("application/json"),
                exact,
            )
            .await,
            status,
        )
        .await;
    }
    let before = f.get(SECTIONS).await;
    for (limit, suffix, key, exact_error) in [
        (50, SECTION_ORDER, "section_ids", "section_not_found"),
        (20_000, CHANNEL_ORDER, "channel_ids", "channel not found"),
    ] {
        let ids: Vec<_> = (0..=limit).map(|_| Uuid::new_v4()).collect();
        for (n, status, error) in [
            (limit, StatusCode::NOT_FOUND, exact_error),
            (limit + 1, StatusCode::BAD_REQUEST, "invalid_section_order"),
        ] {
            let mut input = json!({key:&ids[..n]});
            if suffix == CHANNEL_ORDER {
                input["section_id"] = Value::Null;
            }
            denied(f.send("PUT", suffix, input).await, status, error).await;
        }
    }
    assert_eq!(f.get(SECTIONS).await, before);
    f.changed("PUT", SECTION_ORDER, json!({"section_ids":[id]}))
        .await;
    f.changed("PUT", CHANNEL_ORDER, channel_order(None, &[]))
        .await;
}

#[fukulow_test::test]
async fn generation_exhaustion_rolls_back(pool: PgPool) {
    let f = Fixture::new(pool).await;
    let (id, extra) = (Uuid::new_v4(), Uuid::new_v4());
    f.create(id, "Original").await;
    sqlx::query("UPDATE member_section_generations SET generation=$1")
        .bind(i64::MAX)
        .execute(&f.pools.admin)
        .await
        .unwrap();
    let before = f.get(SECTIONS).await;
    assert_eq!(before["generation"], i64::MAX.to_string());
    for (method, suffix, input) in [
        (
            "POST",
            SECTIONS.to_string(),
            json!({"id":extra,"name":"Roll back reservation"}),
        ),
        (
            "PATCH",
            section_path(id),
            json!({"name":"Roll back rename"}),
        ),
    ] {
        denied(
            f.send(method, &suffix, input).await,
            StatusCode::INTERNAL_SERVER_ERROR,
            "internal error",
        )
        .await;
        assert_eq!(f.get(SECTIONS).await, before);
    }
    f.changed("PATCH", &section_path(id), json!({"name":"Original"}))
        .await;
    sqlx::query("UPDATE member_section_generations SET generation=1")
        .execute(&f.pools.admin)
        .await
        .unwrap();
    assert_eq!(
        f.create(extra, "Roll back reservation").await["generation"],
        "2"
    );
}

#[fukulow_test::test]
async fn full_channel_order_accepts_twenty_thousand_ids(pool: PgPool) {
    let f = Fixture::new(pool).await;
    // Channel initialization takes transaction-scoped locks per Channel.
    for end in (500..=20_000).step_by(500) {
        sqlx::query(
            "INSERT INTO channels (organization_id,id,name,visibility)
             SELECT $1,gen_random_uuid(),'Channel '||lpad(n::text,5,'0'),'public'
             FROM generate_series($2::integer,$3::integer) n",
        )
        .bind(f.owner.org)
        .bind(end - 499)
        .bind(end)
        .execute(&f.pools.admin)
        .await
        .unwrap();
    }
    let original = f.get(SECTIONS).await;
    let mut ids: Vec<Uuid> = serde_json::from_value(original["other_channel_ids"].clone()).unwrap();
    assert_eq!(ids.len(), 20_000);
    ids.reverse();
    f.changed("PUT", CHANNEL_ORDER, channel_order(None, &ids))
        .await;
    assert_eq!(
        f.get(SECTIONS).await,
        json!({"generation":"1","sections":[],"other_channel_ids":ids})
    );

    let late = f.channel("Aardvark", "public").await;
    let before = f.get(SECTIONS).await;
    denied(
        f.send("PUT", CHANNEL_ORDER, channel_order(None, &ids))
            .await,
        StatusCode::CONFLICT,
        "section_layout_changed",
    )
    .await;
    ids.push(late);
    denied(
        f.send("PUT", CHANNEL_ORDER, channel_order(None, &ids))
            .await,
        StatusCode::BAD_REQUEST,
        "invalid_section_order",
    )
    .await;
    assert_eq!(f.get(SECTIONS).await, before);
    assert_eq!(
        before,
        json!({"generation":"1","sections":[],"other_channel_ids":ids})
    );
}
