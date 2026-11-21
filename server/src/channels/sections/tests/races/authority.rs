use super::*;

#[fukulow_test::test]
async fn writes_serialize_with_revocation_demotion_and_deactivation(pool: PgPool) {
    let f = Fixture::new(pool).await;
    let private = f.channel("Private", "private").await;
    let public = f.channel("Public", "public").await;
    for action in ["revoke", "demote", "deactivate"] {
        for access_first in [true, false] {
            let target = Uuid::new_v4();
            let token = member(&f.pools.admin, f.owner.org, target, "member").await;
            let section = Uuid::new_v4();
            expected(
                send(
                    &f.app,
                    "POST",
                    &path(f.owner.org, SECTIONS),
                    &token,
                    json!({"id":section,"name":"Owned"}),
                )
                .await,
                StatusCode::CREATED,
            )
            .await;
            if action != "demote" {
                expected(
                    f.send(
                        "POST",
                        &format!("/channels/{private}/members"),
                        json!({"member_id":target}),
                    )
                    .await,
                    StatusCode::NO_CONTENT,
                )
                .await;
            }
            let channel = if action == "demote" { public } else { private };
            let channel_path = placement_path(channel);
            let move_input = json!({"section_id":section});
            let (method, suffix, input, event, table, query) = match action {
                "revoke" => (
                    "DELETE",
                    format!("/channels/{private}/members/{target}"),
                    Value::Null,
                    "DELETE",
                    "channel_members",
                    "DELETE FROM channel_members%",
                ),
                "demote" => (
                    "PATCH",
                    format!("/members/{target}/role"),
                    json!({"role":"guest"}),
                    "UPDATE",
                    "users",
                    "UPDATE users SET role%",
                ),
                _ => (
                    "POST",
                    format!("/members/{target}/deactivate"),
                    Value::Null,
                    "UPDATE",
                    "users",
                    "UPDATE users SET deactivated_at%",
                ),
            };
            let (loser, access, layout, table) = if access_first {
                let blocker = pause(&f, event, table).await;
                let access = spawn(&f, method, &suffix, &f.token, input);
                wait_blocked(&f, query).await;
                let layout = spawn(&f, "PUT", &channel_path, &token, move_input);
                wait_blocked(&f, ORG_SHARE).await;
                let loser = spawn(
                    &f,
                    "PUT",
                    CHANNEL_ORDER,
                    &token,
                    channel_order(None, &[channel]),
                );
                wait_blocked_count(&f, ORG_SHARE, 2).await;
                blocker.commit().await.unwrap();
                (Some(loser), access, layout, table)
            } else {
                let table = "member_section_placements";
                let blocker = pause(&f, "INSERT", table).await;
                let layout = spawn(&f, "PUT", &channel_path, &token, move_input);
                wait_blocked(&f, "INSERT INTO member_section_placements%").await;
                let access = spawn(&f, method, &suffix, &f.token, input);
                wait_blocked(&f, ORG_EXCLUSIVE).await;
                blocker.commit().await.unwrap();
                (None, access, layout, table)
            };
            let success = if action == "demote" {
                StatusCode::OK
            } else {
                StatusCode::NO_CONTENT
            };
            expected(joined(access).await, success).await;
            let layout = joined(layout).await;
            let unavailable = if action == "deactivate" {
                "organization_unavailable"
            } else {
                "channel not found"
            };
            if access_first {
                denied(layout, StatusCode::NOT_FOUND, unavailable).await;
            } else {
                expected(layout, StatusCode::NO_CONTENT).await;
            }
            if let Some(loser) = loser {
                denied(joined(loser).await, StatusCode::NOT_FOUND, unavailable).await;
            }
            let generation: i64 = sqlx::query_scalar("SELECT generation FROM member_section_generations WHERE organization_id=$1 AND member_id=$2")
                .bind(f.owner.org).bind(target).fetch_one(&f.pools.admin).await.unwrap();
            assert_eq!(generation, if access_first { 1 } else { 2 });
            let stored: Option<Uuid> = sqlx::query_scalar("SELECT channel_id FROM member_section_placements WHERE organization_id=$1 AND member_id=$2")
                .bind(f.owner.org).bind(target).fetch_optional(&f.pools.admin).await.unwrap();
            assert_eq!(stored, (!access_first).then_some(channel));
            if action == "deactivate" {
                auth::set_member_active_for_test(&f.pools.admin, f.owner.org, target, true).await;
            }
            let current = expected(
                send(
                    &f.app,
                    "GET",
                    &path(f.owner.org, SECTIONS),
                    &token,
                    Value::Null,
                )
                .await,
                StatusCode::OK,
            )
            .await;
            assert_eq!(
                current["sections"],
                json!([{"id":section,"name":"Owned","channel_ids":[]}])
            );
            assert_eq!(current["generation"], generation.to_string());
            f.distinct_positions().await;
            unpause(&f, table).await;
        }
    }
}

#[fukulow_test::test]
async fn access_gain_invalidates_an_earlier_order(pool: PgPool) {
    let f = Fixture::new(pool).await;
    let target = Uuid::new_v4();
    let token = member(&f.pools.admin, f.owner.org, target, "guest").await;
    let (a, b) = (
        f.channel("a", "public").await,
        f.channel("b", "public").await,
    );
    let uri = path(f.owner.org, CHANNEL_ORDER);
    expected(
        send(&f.app, "PUT", &uri, &token, channel_order(None, &[])).await,
        StatusCode::NO_CONTENT,
    )
    .await;
    let blocker = pause(&f, "INSERT", "channel_members").await;
    let grant = spawn(
        &f,
        "POST",
        &format!("/channels/{a}/members"),
        &f.token,
        json!({"member_id":target}),
    );
    wait_blocked(&f, "INSERT INTO channel_members%").await;
    let reorder = spawn(&f, "PUT", CHANNEL_ORDER, &token, channel_order(None, &[]));
    wait_blocked(&f, ORG_SHARE).await;
    blocker.commit().await.unwrap();
    expected(joined(grant).await, StatusCode::NO_CONTENT).await;
    denied(
        joined(reorder).await,
        StatusCode::CONFLICT,
        "section_layout_changed",
    )
    .await;
    unpause(&f, "channel_members").await;
    let get = async || {
        expected(
            send(
                &f.app,
                "GET",
                &path(f.owner.org, SECTIONS),
                &token,
                Value::Null,
            )
            .await,
            StatusCode::OK,
        )
        .await
    };
    assert_eq!(
        get().await,
        json!({"generation":"0","sections":[],"other_channel_ids":[a]})
    );
    expected(
        send(&f.app, "PUT", &uri, &token, channel_order(None, &[a])).await,
        StatusCode::NO_CONTENT,
    )
    .await;
    expected(
        f.send(
            "POST",
            &format!("/channels/{b}/members"),
            json!({"member_id":target}),
        )
        .await,
        StatusCode::NO_CONTENT,
    )
    .await;
    assert_eq!(get().await["other_channel_ids"], json!([a, b]));
    f.distinct_positions().await;
}

#[fukulow_test::test]
async fn private_placement_waits_on_its_grant_lock(pool: PgPool) {
    let f = Fixture::new(pool).await;
    let channel = f.channel("Private", "private").await;
    let group = Uuid::new_v4();
    f.create(group, "Destination").await;
    let placement = placement_path(channel);
    let input = json!({"section_id":group});

    // A grant mutation through the API would wait on the Organization row
    // first. Isolate the grant row lock to exercise the second check.
    let mut blocker = f.pools.admin.begin().await.unwrap();
    sqlx::query(
        "SELECT channel_id FROM channel_members
         WHERE organization_id=$1 AND channel_id=$2 AND member_id=$3 FOR NO KEY UPDATE",
    )
    .bind(f.owner.org)
    .bind(channel)
    .bind(f.owner.member)
    .fetch_one(&mut *blocker)
    .await
    .unwrap();
    let moving = spawn(&f, "PUT", &placement, &f.token, input);
    wait_blocked(&f, "SELECT channel_id FROM channel_members%FOR SHARE").await;
    assert_eq!(f.get(SECTIONS).await["generation"], "1");
    blocker.commit().await.unwrap();
    expected(joined(moving).await, StatusCode::NO_CONTENT).await;
    assert_eq!(
        f.get(&placement).await,
        json!({"section_id":group,"generation":"2"})
    );
}

#[fukulow_test::test]
async fn reads_keep_one_snapshot_without_member_locks(pool: PgPool) {
    let f = Fixture::new(pool).await;
    let private = f.channel("Private", "private").await;
    let target = Uuid::new_v4();
    let token = member(&f.pools.admin, f.owner.org, target, "member").await;
    expected(
        f.send(
            "POST",
            &format!("/channels/{private}/members"),
            json!({"member_id":target}),
        )
        .await,
        StatusCode::NO_CONTENT,
    )
    .await;
    let section = Uuid::new_v4();
    expected(
        send(
            &f.app,
            "POST",
            &path(f.owner.org, SECTIONS),
            &token,
            json!({"id":section,"name":"Before"}),
        )
        .await,
        StatusCode::CREATED,
    )
    .await;
    expected(
        send(
            &f.app,
            "PUT",
            &path(f.owner.org, &placement_path(private)),
            &token,
            json!({"section_id":section}),
        )
        .await,
        StatusCode::NO_CONTENT,
    )
    .await;

    let mut blocker = f.pools.admin.begin().await.unwrap();
    sqlx::query("LOCK TABLE member_sections IN ACCESS EXCLUSIVE MODE")
        .execute(&mut *blocker)
        .await
        .unwrap();
    let read = spawn(&f, "GET", SECTIONS, &token, Value::Null);
    wait_blocked(&f, "SELECT id, name FROM member_sections%").await;
    // A real revoke can finish while this earlier GET is paused, then the
    // section and generation changes commit before the GET reads its rows.
    expected(
        tokio::time::timeout(
            Duration::from_secs(2),
            f.send(
                "DELETE",
                &format!("/channels/{private}/members/{target}"),
                Value::Null,
            ),
        )
        .await
        .unwrap(),
        StatusCode::NO_CONTENT,
    )
    .await;
    sqlx::query("UPDATE member_sections SET name='After' WHERE id=$1")
        .bind(section)
        .execute(&mut *blocker)
        .await
        .unwrap();
    sqlx::query("UPDATE member_section_generations SET generation=generation+1 WHERE organization_id=$1 AND member_id=$2")
        .bind(f.owner.org).bind(target).execute(&mut *blocker).await.unwrap();
    blocker.commit().await.unwrap();
    assert_eq!(
        expected(joined(read).await, StatusCode::OK).await,
        json!({"generation":"2","sections":[{"id":section,"name":"Before","channel_ids":[private]}],"other_channel_ids":[]})
    );
    assert_eq!(
        expected(
            send(
                &f.app,
                "GET",
                &path(f.owner.org, SECTIONS),
                &token,
                Value::Null
            )
            .await,
            StatusCode::OK
        )
        .await,
        json!({"generation":"3","sections":[{"id":section,"name":"After","channel_ids":[]}],"other_channel_ids":[]})
    );
    f.distinct_positions().await;
}
