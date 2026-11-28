use super::*;

#[fukulow_test::test]
async fn dm_send_locks_preserve_nonparticipant_and_stale_grant_error_bodies(pool: PgPool) {
    let f = Fixture::new(pool, "member").await;
    let channel = f.dm().await;
    let outsider = Uuid::new_v4();
    let token = member(&f.pools.admin, f.org, outsider, "member").await;
    let outsider_auth = extract_auth(f.state.clone(), &token).await;
    let sender_auth = extract_auth(f.state.clone(), &f.bt).await;
    let lock = |sender| {
        crate::database::organization(&f.pools.app, f.org, async move |tx: &mut PgConnection| {
            send_locks(tx, f.org, sender, channel, &[]).await
        })
    };
    assert!(
        lock((f.b, sender_auth.membership_revision))
            .await
            .unwrap()
            .is_some()
    );

    f.deactivate(f.b).await;
    f.reactivate(f.b).await;
    let refreshed = extract_auth(f.state.clone(), &f.bt).await;
    for (sender, expected_error) in [
        (
            (outsider, outsider_auth.membership_revision),
            "channel not found",
        ),
        (
            (f.b, sender_auth.membership_revision),
            "organization_unavailable",
        ),
        ((f.b, refreshed.membership_revision), "channel not found"),
    ] {
        let SendError::Denied(error) = lock(sender).await.unwrap_err() else {
            panic!("expected a DM send denial");
        };
        let response = error.into_response();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        assert_eq!(body(response).await, json!({"error": expected_error}));
    }
    f.pools.app.close().await;
}

#[fukulow_test::test]
async fn open_denials_reveal_no_pair_or_positions_and_sql_rejects_foreign_third_or_mutated_pairs(
    pool: PgPool,
) {
    let f = Fixture::new(pool, "guest").await;
    let c = f.dm().await;
    let other_org = organization(&f.pools.admin).await;
    let foreign = Uuid::new_v4();
    member(&f.pools.admin, other_org, foreign, "member").await;
    let inactive = Uuid::new_v4();
    member(&f.pools.admin, f.org, inactive, "member").await;
    f.deactivate(inactive).await;
    let before = f.snapshot().await;
    for (peer, error, status) in [
        (f.a, "dm_self_not_allowed", StatusCode::BAD_REQUEST),
        (foreign, "member_not_found", StatusCode::NOT_FOUND),
        (inactive, "member_not_found", StatusCode::NOT_FOUND),
        (Uuid::new_v4(), "member_not_found", StatusCode::NOT_FOUND),
    ] {
        let r = f.open(&f.at, peer, false).await;
        assert_eq!(r.status(), status);
        assert_eq!(body(r).await, json!({"error":error}));
        assert_eq!(f.snapshot().await, before);
    }
    let third = Uuid::new_v4();
    member(&f.pools.admin, f.org, third, "owner").await;
    for target in [third, foreign] {
        assert!(
            sqlx::query(
                "INSERT INTO channel_members(organization_id,channel_id,member_id) VALUES($1,$2,$3)"
            )
            .bind(f.org)
            .bind(c)
            .bind(target)
            .execute(&f.pools.admin)
            .await
            .is_err()
        );
    }
    let mut pair = [f.a, f.b];
    pair.sort();
    for (a, b) in [(pair[1], pair[0]), (pair[0], pair[0]), (pair[0], foreign)] {
        assert!(sqlx::query("INSERT INTO channels(organization_id,id,kind,lower_member_id,higher_member_id) VALUES($1,$2,'dm',$3,$4)").bind(f.org).bind(Uuid::new_v4()).bind(a).bind(b).execute(&f.pools.admin).await.is_err());
    }
    assert!(sqlx::query("INSERT INTO channels(organization_id,id,kind,lower_member_id,higher_member_id) VALUES($1,$2,'dm',$3,$4)").bind(f.org).bind(Uuid::new_v4()).bind(pair[0]).bind(pair[1]).execute(&f.pools.admin).await.is_err());
    assert!(
        sqlx::query("UPDATE channels SET higher_member_id=$3 WHERE organization_id=$1 AND id=$2")
            .bind(f.org)
            .bind(c)
            .bind(third)
            .execute(&f.pools.admin)
            .await
            .is_err()
    );
    assert!(sqlx::query("INSERT INTO topics(organization_id,id,channel_id,name,first_seq,last_seq,message_count) VALUES($1,$2,$3,'No',1,1,1)").bind(f.org).bind(Uuid::new_v4()).bind(c).execute(&f.pools.admin).await.is_err());
    f.pools.app.close().await;
}

#[fukulow_test::test]
async fn lost_caller_revision_never_borrows_reactivated_authority_or_canonical_body(pool: PgPool) {
    let f = Fixture::new(pool, "guest").await;
    let c = f.dm().await;
    let key = Uuid::new_v4();
    let active_key = Uuid::new_v4();
    let active_sent = body(f.send(&f.at, c, active_key).await).await;
    let sent = body(f.send(&f.bt, c, key).await).await;
    let captured = extract_auth(f.state.clone(), &f.bt).await;
    f.deactivate(f.b).await;
    for active in [false, true] {
        if active {
            f.reactivate(f.b).await;
        }
        let before = f.snapshot().await;
        for (method, suffix, input) in [
            ("GET", "messages".to_string(), Value::Null),
            (
                "GET",
                format!("messages/{}/chain", sent["id"].as_str().unwrap()),
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
                json!({"client_message_id":Uuid::new_v4(),"body":"new"}),
            ),
            ("PUT", "read".into(), json!({"read_seq":999})),
        ] {
            let r = request(
                &f.app,
                method,
                &format!("/api/v1/channels/{c}/{suffix}"),
                &f.bt,
                input,
            )
            .await;
            assert_eq!(r.status(), StatusCode::NOT_FOUND);
            assert_eq!(
                body(r).await,
                json!({"error":if active {"channel not found"} else {"organization_unavailable"}})
            );
        }
        for lane in ["delta", "coverage"] {
            let r = crate::database::organization_read_only(
                &f.pools.app,
                f.org,
                async |tx: &mut PgConnection| {
                    auth::members::require_current(tx, &captured).await?;
                    discovery::page(tx, &captured, &f.state.setup_token, lane, Cursor::default())
                        .await
                },
            )
            .await;
            assert_eq!(r.err().unwrap().1, "organization_unavailable");
        }
        assert_eq!(f.snapshot().await, before);
        assert_eq!(
            f.get(&f.at, "/api/v1/dms").await["dms"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        assert!(
            f.get(&f.at, &format!("/api/v1/channels/{c}/messages"))
                .await["messages"]
                .as_array()
                .unwrap()
                .contains(&sent)
        );
        let retry = f.send(&f.at, c, active_key).await;
        assert_eq!(retry.status(), StatusCode::CREATED);
        assert_eq!(body(retry).await, active_sent);
        let retry_key = Uuid::new_v4();
        let denied = f.send(&f.at, c, retry_key).await;
        assert_eq!(denied.status(), StatusCode::CONFLICT);
        assert_eq!(
            body(denied).await,
            json!({"error": if active {
                "dm_peer_access_lapsed"
            } else {
                "dm_peer_deactivated"
            }})
        );
        assert_eq!(f.snapshot().await, before);
    }
    f.pools.app.close().await;
}

#[fukulow_test::test]
async fn discovery_tables_require_organization_context_and_reject_cross_organization_writes(
    pool: PgPool,
) {
    let f = Fixture::new(pool, "guest").await;
    f.dm().await;
    for table in ["dm_discovery_counters", "dm_discovery"] {
        let count: i64 = sqlx::query_scalar(&format!("SELECT count(*) FROM {table}"))
            .fetch_one(&f.pools.app)
            .await
            .unwrap();
        assert_eq!(count, 0);
        let foreign = Uuid::new_v4();
        let sql = format!("SELECT count(*) FROM {table} WHERE organization_id=$1");
        let n = crate::database::organization_read_only(
            &f.pools.app,
            foreign,
            async |tx: &mut PgConnection| {
                sqlx::query_scalar::<_, i64>(&sql)
                    .bind(f.org)
                    .fetch_one(tx)
                    .await
            },
        )
        .await
        .unwrap();
        assert_eq!(n, 0);
        let row: Value = sqlx::query_scalar(&format!("SELECT to_jsonb(t) FROM {table} t LIMIT 1"))
            .fetch_one(&f.pools.admin)
            .await
            .unwrap();
        let insert =
            format!("INSERT INTO {table} SELECT * FROM jsonb_populate_record(NULL::{table},$1)");
        let error =
            crate::database::organization(&f.pools.app, foreign, async |tx: &mut PgConnection| {
                sqlx::query(&insert).bind(row).execute(tx).await
            })
            .await
            .unwrap_err();
        assert_eq!(
            error.as_database_error().unwrap().code().as_deref(),
            Some("42501")
        );
    }
    f.pools.app.close().await;
}
