use super::*;

const INSERT_PLACEMENTS: &str = "INSERT INTO member_section_placements%";

#[fukulow_test::test]
async fn concurrent_moves_and_section_delete(pool: PgPool) {
    let f = Fixture::new(pool).await;
    let channel = f.channel("Movable", "public").await;
    let channel_path = placement_path(channel);
    let (a, b) = (Uuid::new_v4(), Uuid::new_v4());
    f.create(a, "A").await;
    f.create(b, "B").await;
    for (first, second) in [(a, b), (b, a)] {
        f.changed("PUT", &channel_path, json!({"section_id":null}))
            .await;
        let blocker = pause(&f, "INSERT", "member_section_placements").await;
        let moving = spawn(
            &f,
            "PUT",
            &channel_path,
            &f.token,
            json!({"section_id":first}),
        );
        wait_blocked(&f, INSERT_PLACEMENTS).await;
        let following = spawn(
            &f,
            "PUT",
            &channel_path,
            &f.token,
            json!({"section_id":second}),
        );
        wait_blocked(&f, LAYOUT_LOCK).await;
        blocker.commit().await.unwrap();
        for task in [moving, following] {
            expected(joined(task).await, StatusCode::NO_CONTENT).await;
            f.distinct_positions().await;
        }
        assert_eq!(f.get(&channel_path).await["section_id"], json!(second));
        unpause(&f, "member_section_placements").await;
    }

    for moving_in in [true, false] {
        for delete_first in [true, false] {
            let section = Uuid::new_v4();
            f.create(section, "Delete").await;
            let starting = if moving_in { None } else { Some(section) };
            let destination = if moving_in { Some(section) } else { Some(b) };
            f.changed("PUT", &channel_path, json!({"section_id":starting}))
                .await;
            let baseline: i64 = f.get(SECTIONS).await["generation"]
                .as_str()
                .unwrap()
                .parse()
                .unwrap();
            let section_path = section_path(section);
            let move_input = json!({"section_id":destination});
            let table = if delete_first {
                "member_sections"
            } else {
                "member_section_placements"
            };
            let event = if delete_first { "DELETE" } else { "INSERT" };
            let blocker = pause(&f, event, table).await;
            let (moving, deleting) = if delete_first {
                let deleting = spawn(&f, "DELETE", &section_path, &f.token, Value::Null);
                wait_blocked(&f, "DELETE FROM member_sections%").await;
                let moving = spawn(&f, "PUT", &channel_path, &f.token, move_input);
                wait_blocked(&f, LAYOUT_LOCK).await;
                (moving, deleting)
            } else {
                let moving = spawn(&f, "PUT", &channel_path, &f.token, move_input);
                wait_blocked(&f, INSERT_PLACEMENTS).await;
                let deleting = spawn(&f, "DELETE", &section_path, &f.token, Value::Null);
                wait_blocked(&f, LAYOUT_LOCK).await;
                (moving, deleting)
            };
            blocker.commit().await.unwrap();
            expected(joined(deleting).await, StatusCode::NO_CONTENT).await;
            let denied_move = moving_in && delete_first;
            if denied_move {
                denied(
                    joined(moving).await,
                    StatusCode::NOT_FOUND,
                    "section_not_found",
                )
                .await;
            } else {
                expected(joined(moving).await, StatusCode::NO_CONTENT).await;
            }
            let expected_group = if moving_in { None } else { Some(b) };
            let expected_generation = (baseline + if denied_move { 1 } else { 2 }).to_string();
            assert_eq!(
                f.get(&channel_path).await,
                json!({"section_id":expected_group,"generation":expected_generation})
            );
            f.distinct_positions().await;
            unpause(&f, table).await;
        }
    }
}

#[fukulow_test::test]
async fn complete_orders_follow_last_committer(pool: PgPool) {
    let f = Fixture::new(pool).await;
    let section_ids = [Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4()];
    for id in section_ids {
        f.create(id, "Same").await;
    }
    let channel_ids = [
        f.channel("a", "public").await,
        f.channel("b", "public").await,
        f.channel("c", "public").await,
    ];
    for (ids, suffix, table, event, query) in [
        (
            section_ids,
            SECTION_ORDER,
            "member_sections",
            "UPDATE",
            "UPDATE member_sections s SET position%",
        ),
        (
            channel_ids,
            CHANNEL_ORDER,
            "member_section_placements",
            "INSERT",
            INSERT_PLACEMENTS,
        ),
    ] {
        let payload = |ids: &[Uuid]| {
            if suffix == SECTION_ORDER {
                json!({"section_ids":ids})
            } else {
                channel_order(None, ids)
            }
        };
        let [a, b, c] = ids;
        for (first, second) in [([b, a, c], [c, a, b]), ([c, a, b], [b, a, c])] {
            f.changed("PUT", suffix, payload(&ids)).await;
            let baseline: i64 = f.get(SECTIONS).await["generation"]
                .as_str()
                .unwrap()
                .parse()
                .unwrap();
            let blocker = pause(&f, event, table).await;
            let writing = spawn(&f, "PUT", suffix, &f.token, payload(&first));
            wait_blocked(&f, query).await;
            let following = spawn(&f, "PUT", suffix, &f.token, payload(&second));
            wait_blocked(&f, LAYOUT_LOCK).await;
            blocker.commit().await.unwrap();
            expected(joined(writing).await, StatusCode::NO_CONTENT).await;
            expected(joined(following).await, StatusCode::NO_CONTENT).await;
            let layout = f.get(SECTIONS).await;
            let actual = if suffix == SECTION_ORDER {
                Value::Array(
                    layout["sections"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .map(|section| section["id"].clone())
                        .collect(),
                )
            } else {
                layout["other_channel_ids"].clone()
            };
            assert_eq!(actual, json!(second));
            assert_eq!(layout["generation"], (baseline + 2).to_string());
            f.distinct_positions().await;
            unpause(&f, table).await;
        }
    }
}

#[fukulow_test::test]
async fn channel_reorder_lock_timeout_releases_organization(pool: PgPool) {
    let f = Fixture::new(pool).await;
    let a = f.channel("A", "public").await;
    let b = f.channel("B", "public").await;
    let order = channel_order(None, &[b, a]);
    let group = Uuid::new_v4();
    f.create(group, "Ensure layout row").await;
    let admin_target = Uuid::new_v4();
    member(&f.pools.admin, f.owner.org, admin_target, "member").await;
    let before = f.get(SECTIONS).await;

    let mut blocker = f.pools.admin.begin().await.unwrap();
    sqlx::query("SELECT generation FROM member_section_generations WHERE organization_id=$1 AND member_id=$2 FOR UPDATE")
        .bind(f.owner.org).bind(f.owner.member).fetch_one(&mut *blocker).await.unwrap();
    let reordering = spawn(&f, "PUT", CHANNEL_ORDER, &f.token, order.clone());
    wait_blocked(&f, LAYOUT_LOCK).await;
    let admin = spawn(
        &f,
        "PATCH",
        &format!("/members/{admin_target}/role"),
        &f.token,
        json!({"role":"guest"}),
    );
    // Observe the blocked admin before the reorder's 5 s lock_timeout fires.
    // The test has no way to inject a shorter timeout.
    wait_blocked(&f, ORG_EXCLUSIVE).await;
    let response = tokio::time::timeout(Duration::from_secs(10), reordering)
        .await
        .unwrap()
        .unwrap();
    denied(response, StatusCode::SERVICE_UNAVAILABLE, "lock_contention").await;
    let updated = expected(joined(admin).await, StatusCode::OK).await;
    assert_eq!(updated["role"], "guest");
    blocker.commit().await.unwrap();
    assert_eq!(f.get(SECTIONS).await, before);
    f.changed("PUT", CHANNEL_ORDER, order).await;
    let after = f.get(SECTIONS).await;
    assert_eq!(after["generation"], "2");
    assert_eq!(after["other_channel_ids"], json!([b, a]));
}

#[fukulow_test::test]
async fn section_write_lock_contention_rolls_back_without_notice(pool: PgPool) {
    let f = Fixture::new(pool).await;
    let activity = activity::Activity::default();
    let app = router(activity.clone()).with_state(f.state.clone());
    let auth = crate::channels::tests::extract_auth(f.state.clone(), &f.token).await;
    let registration = activity.register(&auth);
    let id = Uuid::new_v4();
    let uri = path(f.owner.org, SECTIONS);
    let create = || send(&app, "POST", &uri, &f.token, json!({"id":id,"name":"New"}));

    // Fail the generation update after the new section has been inserted.
    sqlx::raw_sql(
        "CREATE FUNCTION test_generation_timeout() RETURNS trigger LANGUAGE plpgsql AS $$
         BEGIN RAISE SQLSTATE '55P03'; END $$;
         CREATE TRIGGER test_generation_timeout BEFORE UPDATE ON member_section_generations
         FOR EACH ROW EXECUTE FUNCTION test_generation_timeout()",
    )
    .execute(&f.pools.admin)
    .await
    .unwrap();
    let before = f.get(SECTIONS).await;
    let response = create().await;
    assert!(!response.headers().contains_key(header::RETRY_AFTER));
    denied(response, StatusCode::SERVICE_UNAVAILABLE, "lock_contention").await;
    assert_eq!(f.get(SECTIONS).await, before);
    let generation_exists: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM member_section_generations
         WHERE organization_id=$1 AND member_id=$2)",
    )
    .bind(f.owner.org)
    .bind(f.owner.member)
    .fetch_one(&f.pools.admin)
    .await
    .unwrap();
    assert!(!generation_exists);
    activity.drained().await;
    assert!(
        tokio::time::timeout(Duration::from_millis(20), registration.next())
            .await
            .is_err()
    );

    sqlx::query("DROP TRIGGER test_generation_timeout ON member_section_generations")
        .execute(&f.pools.admin)
        .await
        .unwrap();
    assert_eq!(create().await.status(), StatusCode::CREATED);
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(1), registration.next())
            .await
            .unwrap()
            .unwrap()
            .event,
        activity::Notice::SectionsChanged { generation: 1 }
    );
}

#[fukulow_test::test]
async fn public_creation_before_and_after_validation(pool: PgPool) {
    let f = Fixture::new(pool).await;
    let a = f.channel("Alpha", "public").await;
    let z = f.channel("Zulu", "public").await;
    f.create(Uuid::new_v4(), "Ensure layout row").await;
    let mut blocker = f.pools.admin.begin().await.unwrap();
    sqlx::query("SELECT generation FROM member_section_generations FOR UPDATE")
        .fetch_one(&mut *blocker)
        .await
        .unwrap();
    let reorder = spawn(
        &f,
        "PUT",
        CHANNEL_ORDER,
        &f.token,
        channel_order(None, &[z, a]),
    );
    wait_blocked(&f, LAYOUT_LOCK).await;
    let middle = f.channel("Middle", "public").await;
    blocker.commit().await.unwrap();
    denied(
        joined(reorder).await,
        StatusCode::CONFLICT,
        "section_layout_changed",
    )
    .await;
    let before = f.get(SECTIONS).await;
    assert_eq!(before["generation"], "1");
    assert_eq!(before["other_channel_ids"], json!([a, middle, z]));

    let blocker = pause(&f, "INSERT", "member_section_placements").await;
    let reorder = spawn(
        &f,
        "PUT",
        CHANNEL_ORDER,
        &f.token,
        channel_order(None, &[z, middle, a]),
    );
    wait_blocked(&f, INSERT_PLACEMENTS).await;
    let late = f.channel("Aardvark", "public").await;
    let in_flight = f.get(SECTIONS).await;
    assert_eq!(in_flight["generation"], "1");
    assert_eq!(in_flight["other_channel_ids"], json!([late, a, middle, z]));
    blocker.commit().await.unwrap();
    expected(joined(reorder).await, StatusCode::NO_CONTENT).await;
    let after = f.get(SECTIONS).await;
    assert_eq!(after["generation"], "2");
    assert_eq!(after["other_channel_ids"], json!([z, middle, a, late]));
    let placed: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT FROM member_section_placements WHERE channel_id=$1)",
    )
    .bind(late)
    .fetch_one(&f.pools.admin)
    .await
    .unwrap();
    assert!(!placed);
    f.distinct_positions().await;
}

#[fukulow_test::test]
async fn set_changes_refuse_stale_reorders(pool: PgPool) {
    let f = Fixture::new(pool).await;
    let (a, b) = (Uuid::new_v4(), Uuid::new_v4());
    let channel = f.channel("Placed", "public").await;
    let other = f.channel("Other", "public").await;
    f.create(a, "A").await;
    f.create(b, "B").await;
    let before = f.get(SECTIONS).await;
    denied(
        f.send("PUT", SECTION_ORDER, json!({"section_ids":[a]}))
            .await,
        StatusCode::CONFLICT,
        "section_layout_changed",
    )
    .await;
    assert_eq!(f.get(SECTIONS).await, before);
    f.changed("PUT", SECTION_ORDER, json!({"section_ids":[b,a]}))
        .await;
    f.changed("PUT", &placement_path(channel), json!({"section_id":a}))
        .await;
    let moved = f.get(SECTIONS).await;
    denied(
        f.send("PUT", CHANNEL_ORDER, channel_order(None, &[other, channel]))
            .await,
        StatusCode::CONFLICT,
        "section_layout_changed",
    )
    .await;
    assert_eq!(f.get(SECTIONS).await, moved);
    f.changed("PUT", CHANNEL_ORDER, channel_order(None, &[other]))
        .await;
    f.changed("DELETE", &section_path(a), Value::Null).await;
    let deleted = f.get(SECTIONS).await;
    denied(
        f.send("PUT", CHANNEL_ORDER, channel_order(None, &[other]))
            .await,
        StatusCode::CONFLICT,
        "section_layout_changed",
    )
    .await;
    denied(
        f.send("PUT", SECTION_ORDER, json!({"section_ids":[b,a]}))
            .await,
        StatusCode::NOT_FOUND,
        "section_not_found",
    )
    .await;
    assert_eq!(f.get(SECTIONS).await, deleted);
    f.changed("PUT", SECTION_ORDER, json!({"section_ids":[b]}))
        .await;
    f.changed("PUT", CHANNEL_ORDER, channel_order(None, &[other, channel]))
        .await;
}

#[fukulow_test::test]
async fn waiting_reorders_see_committed_set_changes(pool: PgPool) {
    let f = Fixture::new(pool).await;
    let (a, b) = (Uuid::new_v4(), Uuid::new_v4());
    f.create(a, "A").await;
    let channel = f.channel("Movable", "public").await;

    for (method, suffix, mutation, event, table, query, reorder, submitted, waiting) in [
        (
            "POST",
            SECTIONS.to_owned(),
            json!({"id":b,"name":"B"}),
            "INSERT",
            "member_sections",
            "INSERT INTO member_sections%",
            SECTION_ORDER,
            json!({"section_ids":[a]}),
            LAYOUT_LOCK,
        ),
        (
            "PUT",
            placement_path(channel),
            json!({"section_id":a}),
            "INSERT",
            "member_section_placements",
            INSERT_PLACEMENTS,
            CHANNEL_ORDER,
            channel_order(None, &[channel]),
            LAYOUT_LOCK,
        ),
        (
            "DELETE",
            section_path(a),
            Value::Null,
            "DELETE",
            "member_sections",
            "DELETE FROM member_sections%",
            CHANNEL_ORDER,
            channel_order(None, &[]),
            LAYOUT_LOCK,
        ),
    ] {
        let generation = f.get(SECTIONS).await["generation"]
            .as_str()
            .unwrap()
            .parse::<i64>()
            .unwrap();
        let blocker = pause(&f, event, table).await;
        let changing = spawn(&f, method, &suffix, &f.token, mutation);
        wait_blocked(&f, query).await;
        let ordering = spawn(&f, "PUT", reorder, &f.token, submitted);
        wait_blocked(&f, waiting).await;
        blocker.commit().await.unwrap();
        let success = if method == "POST" {
            StatusCode::CREATED
        } else {
            StatusCode::NO_CONTENT
        };
        expected(joined(changing).await, success).await;
        denied(
            joined(ordering).await,
            StatusCode::CONFLICT,
            "section_layout_changed",
        )
        .await;
        unpause(&f, table).await;
        assert_eq!(
            f.get(SECTIONS).await["generation"],
            (generation + 1).to_string()
        );
        f.distinct_positions().await;
    }
    assert_eq!(
        f.get(SECTIONS).await,
        json!({"generation":"4","sections":[{"id":b,"name":"B","channel_ids":[]}],"other_channel_ids":[channel]})
    );
    f.changed("PUT", CHANNEL_ORDER, channel_order(None, &[channel]))
        .await;
}
