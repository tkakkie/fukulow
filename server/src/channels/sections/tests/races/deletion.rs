use super::*;

const DELETE_SECTION: &str = "DELETE FROM member_sections%";
const MEMBER_SHARE: &str =
    "SELECT role FROM (SELECT id, membership_revision, role FROM users%FOR SHARE) u";

#[fukulow_test::test]
async fn missing_and_foreign_section_deletes_leave_other_writes_unblocked(pool: PgPool) {
    let f = Fixture::new(pool).await;
    let foreign = Uuid::new_v4();
    f.create(foreign, "Another Member's section").await;
    let admin_target = Uuid::new_v4();
    member(&f.pools.admin, f.owner.org, admin_target, "member").await;
    let role_path = format!("/members/{admin_target}/role");
    for role in ["guest", "member"] {
        let actor = Uuid::new_v4();
        let token = member(&f.pools.admin, f.owner.org, actor, role).await;
        for (id, next_role) in [(Uuid::new_v4(), "guest"), (foreign, "member")] {
            let mut blocker = f.pools.admin.begin().await.unwrap();
            auth::members::active_target(&mut blocker, f.owner.org, actor)
                .await
                .unwrap();
            let deleting = spawn(&f, "DELETE", &section_path(id), &token, Value::Null);
            wait_blocked(&f, MEMBER_SHARE).await;

            let independent = spawn(
                &f,
                "POST",
                SECTIONS,
                &f.token,
                json!({"id":Uuid::new_v4(),"name":"Independent section"}),
            );
            let created = expected(joined(independent).await, StatusCode::CREATED).await;
            let updated = expected(
                joined(spawn(
                    &f,
                    "PATCH",
                    &role_path,
                    &f.token,
                    json!({"role":next_role}),
                ))
                .await,
                StatusCode::OK,
            )
            .await;
            assert_eq!(updated["role"], next_role);
            blocker.commit().await.unwrap();
            expected(joined(deleting).await, StatusCode::NO_CONTENT).await;
            assert_eq!(
                f.get(&section_path(foreign)).await["section"]["id"],
                json!(foreign)
            );
            assert_eq!(f.get(SECTIONS).await["generation"], created["generation"]);
        }
        let layout = expected(
            joined(spawn(&f, "GET", SECTIONS, &token, Value::Null)).await,
            StatusCode::OK,
        )
        .await;
        assert_eq!(layout["generation"], "0");
        assert_eq!(layout["sections"], json!([]));

        expected(
            f.send("POST", &format!("/members/{actor}/deactivate"), Value::Null)
                .await,
            StatusCode::NO_CONTENT,
        )
        .await;
        for id in [Uuid::new_v4(), foreign] {
            denied(
                joined(spawn(&f, "DELETE", &section_path(id), &token, Value::Null)).await,
                StatusCode::NOT_FOUND,
                "organization_unavailable",
            )
            .await;
        }
    }
}

#[fukulow_test::test]
async fn owned_section_delete_and_deactivation_serialize_in_both_orders(pool: PgPool) {
    let f = Fixture::new(pool).await;
    for delete_first in [true, false] {
        let actor = Uuid::new_v4();
        let token = member(&f.pools.admin, f.owner.org, actor, "member").await;
        let id = Uuid::new_v4();
        expected(
            joined(spawn(
                &f,
                "POST",
                SECTIONS,
                &token,
                json!({"id":id,"name":"Owned"}),
            ))
            .await,
            StatusCode::CREATED,
        )
        .await;
        let section = section_path(id);
        let deactivation = format!("/members/{actor}/deactivate");
        let delete = || spawn(&f, "DELETE", &section, &token, Value::Null);
        let deactivate = || spawn(&f, "POST", &deactivation, &f.token, Value::Null);
        let (deleting, deactivating, table) = if delete_first {
            let blocker = pause(&f, "DELETE", "member_sections").await;
            let deleting = delete();
            wait_blocked(&f, DELETE_SECTION).await;
            let deactivating = deactivate();
            wait_blocked(&f, ORG_EXCLUSIVE).await;
            blocker.commit().await.unwrap();
            (deleting, deactivating, "member_sections")
        } else {
            let blocker = pause(&f, "UPDATE OF deactivated_at", "users").await;
            let deactivating = deactivate();
            wait_blocked(&f, "UPDATE users SET deactivated_at%").await;
            let deleting = delete();
            wait_blocked(&f, ORG_SHARE).await;
            blocker.commit().await.unwrap();
            (deleting, deactivating, "users")
        };
        expected(joined(deactivating).await, StatusCode::NO_CONTENT).await;
        let response = joined(deleting).await;
        if delete_first {
            expected(response, StatusCode::NO_CONTENT).await;
        } else {
            denied(response, StatusCode::NOT_FOUND, "organization_unavailable").await;
        }
        unpause(&f, table).await;

        auth::set_member_active_for_test(&f.pools.admin, f.owner.org, actor, true).await;
        let stale = Owner {
            member: actor,
            ..f.owner
        };
        for target in [id, Uuid::new_v4()] {
            let error = write::write(
                &f.state,
                activity::Activity::default(),
                stale,
                write::Mutation::Delete(target),
            )
            .await
            .unwrap_err();
            denied(
                error.into_response(),
                StatusCode::NOT_FOUND,
                "organization_unavailable",
            )
            .await;
        }
        let layout = expected(
            joined(spawn(&f, "GET", SECTIONS, &token, Value::Null)).await,
            StatusCode::OK,
        )
        .await;
        assert_eq!(layout["generation"], if delete_first { "2" } else { "1" });
        assert_eq!(
            layout["sections"],
            if delete_first {
                json!([])
            } else {
                json!([{"id":id,"name":"Owned","channel_ids":[]}])
            }
        );
    }
}

#[fukulow_test::test]
async fn section_delete_restarts_with_new_channel_locks_and_bounds_attempts(pool: PgPool) {
    let f = Fixture::new(pool).await;
    let channels = [
        f.channel("A", "public").await,
        f.channel("B", "public").await,
        f.channel("C", "public").await,
    ];
    for growths in [1, 3] {
        let group = Uuid::new_v4();
        let created = f.create(group, "Growing group").await;
        let generation: i64 = created["generation"].as_str().unwrap().parse().unwrap();
        let mut layout = f.pools.admin.begin().await.unwrap();
        sqlx::query("SELECT generation FROM member_section_generations WHERE organization_id=$1 AND member_id=$2 FOR UPDATE")
            .bind(f.owner.org).bind(f.owner.member).fetch_one(&mut *layout).await.unwrap();
        let deleting = spawn(&f, "DELETE", &section_path(group), &f.token, Value::Null);
        wait_blocked(&f, LAYOUT_LOCK).await;
        let mut prior_blocker: Option<Transaction<'_, Postgres>> = None;
        for (position, channel) in channels[..growths].iter().enumerate() {
            // Model a placement committed after discovery. NO KEY UPDATE is
            // compatible with the placement FK check and conflicts with Channel SHARE.
            let mut blocker = f.pools.admin.begin().await.unwrap();
            let pid: i32 = sqlx::query_scalar(
                "SELECT pg_backend_pid() FROM channels WHERE organization_id=$1 AND id=$2 FOR NO KEY UPDATE",
            )
            .bind(f.owner.org).bind(channel).fetch_one(&mut *blocker).await.unwrap();
            sqlx::query(
                "INSERT INTO member_section_placements (organization_id,member_id,channel_id,section_id,position)
                 VALUES ($1,$2,$3,$4,$5)",
            )
            .bind(f.owner.org).bind(f.owner.member).bind(channel).bind(group)
            .bind(position as i64).execute(&mut *layout).await.unwrap();
            sqlx::query("UPDATE member_section_generations SET generation=generation+1 WHERE organization_id=$1 AND member_id=$2")
                .bind(f.owner.org).bind(f.owner.member).execute(&mut *layout).await.unwrap();
            layout.commit().await.unwrap();
            if let Some(prior) = prior_blocker.take() {
                prior.commit().await.unwrap();
            }
            if position < 2 {
                wait_blocked_matching(
                    &f,
                    "SELECT id, visibility='public' AS public%FOR SHARE",
                    1,
                    Some(pid),
                )
                .await;
            }
            prior_blocker = Some(blocker);
            layout = f.pools.admin.begin().await.unwrap();
        }
        let response = if growths == 1 {
            prior_blocker.take().unwrap().commit().await.unwrap();
            joined(deleting).await
        } else {
            // The final new Channel stays locked while the conflict is returned.
            joined(deleting).await
        };
        if growths == 1 {
            expected(response, StatusCode::NO_CONTENT).await;
            assert_eq!(
                f.get(SECTIONS).await,
                json!({
                    "generation":(generation + 2).to_string(),"sections":[],"other_channel_ids":channels,
                })
            );
        } else {
            denied(
                response,
                StatusCode::INTERNAL_SERVER_ERROR,
                "internal error",
            )
            .await;
            assert_eq!(
                f.get(SECTIONS).await,
                json!({
                    "generation":(generation + 3).to_string(),"sections":[{"id":group,"name":"Growing group","channel_ids":channels}],
                    "other_channel_ids":[],
                })
            );
        }
    }
}
