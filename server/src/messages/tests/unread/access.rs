use super::*;

// Compare the trigger-maintained rows with the production authorization query,
// rather than copying its visibility predicate into the test.
async fn assert_positions_match_visibility(pool: &PgPool) {
    let pairs: Vec<(Uuid, Uuid, i64, Uuid)> = sqlx::query_as(
        "SELECT u.organization_id,u.id,u.membership_revision,c.id FROM users u \
         JOIN channels c ON c.organization_id=u.organization_id",
    )
    .fetch_all(pool)
    .await
    .unwrap();
    for (org, member, revision, channel) in pairs {
        let visible = channels::is_visible(pool, org, (member, revision), channel)
            .await
            .unwrap()
            == Some(true);
        let positions: Vec<i64> = sqlx::query_scalar(
            "SELECT membership_revision FROM channel_read_positions WHERE organization_id=$1 AND member_id=$2 AND channel_id=$3",
        ).bind(org).bind(member).bind(channel).fetch_all(pool).await.unwrap();
        assert_eq!(
            positions,
            if visible { vec![revision] } else { vec![] },
            "org={org} member={member} channel={channel}"
        );
    }
}

#[sqlx::test]
async fn unread_positions_exist_exactly_for_visible_channels_across_access_transitions(
    pool: PgPool,
) {
    let (app, org, owner_id, public, owner) = fixture(&pool).await;
    assert_positions_match_visibility(&pool).await;
    let viewer_id = Uuid::new_v4();
    let viewer = member(&pool, org, viewer_id).await;
    assert_positions_match_visibility(&pool).await;
    let private = Uuid::new_v4();
    super::super::channel(&pool, org, private, owner_id, true).await;
    assert_positions_match_visibility(&pool).await;
    sqlx::query(
        "INSERT INTO channel_members (organization_id,channel_id,member_id) VALUES ($1,$2,$3)",
    )
    .bind(org)
    .bind(private)
    .bind(viewer_id)
    .execute(&pool)
    .await
    .unwrap();
    assert_positions_match_visibility(&pool).await;
    sqlx::query(
        "DELETE FROM channel_members WHERE organization_id=$1 AND channel_id=$2 AND member_id=$3",
    )
    .bind(org)
    .bind(private)
    .bind(viewer_id)
    .execute(&pool)
    .await
    .unwrap();
    assert_positions_match_visibility(&pool).await;
    // Redundant public grants and their revocation preserve continuous access.
    sqlx::query(
        "INSERT INTO channel_members (organization_id,channel_id,member_id) VALUES ($1,$2,$3)",
    )
    .bind(org)
    .bind(public)
    .bind(viewer_id)
    .execute(&pool)
    .await
    .unwrap();
    assert_positions_match_visibility(&pool).await;
    sqlx::query(
        "DELETE FROM channel_members WHERE organization_id=$1 AND channel_id=$2 AND member_id=$3",
    )
    .bind(org)
    .bind(public)
    .bind(viewer_id)
    .execute(&pool)
    .await
    .unwrap();
    assert_positions_match_visibility(&pool).await;
    sqlx::query("UPDATE channels SET visibility='private' WHERE organization_id=$1 AND id=$2")
        .bind(org)
        .bind(public)
        .execute(&pool)
        .await
        .unwrap();
    assert_positions_match_visibility(&pool).await;
    sqlx::query("UPDATE channels SET visibility='public' WHERE organization_id=$1 AND id=$2")
        .bind(org)
        .bind(public)
        .execute(&pool)
        .await
        .unwrap();
    assert_positions_match_visibility(&pool).await;
    // An old grant must stay denied after reactivation; a current-revision grant
    // inserted while inactive must become visible at the reactivation baseline.
    let stale_private = Uuid::new_v4();
    super::super::channel(&pool, org, stale_private, viewer_id, true).await;
    assert_positions_match_visibility(&pool).await;
    sqlx::query("UPDATE users SET deactivated_at=now() WHERE organization_id=$1 AND id=$2")
        .bind(org)
        .bind(viewer_id)
        .execute(&pool)
        .await
        .unwrap();
    assert_positions_match_visibility(&pool).await;
    sqlx::query(
        "INSERT INTO channel_members (organization_id,channel_id,member_id,membership_revision) \
        SELECT $1,$2,id,membership_revision FROM users WHERE organization_id=$1 AND id=$3",
    )
    .bind(org)
    .bind(private)
    .bind(viewer_id)
    .execute(&pool)
    .await
    .unwrap();
    assert_positions_match_visibility(&pool).await;
    let during_deactivation = Uuid::new_v4();
    super::super::channel(&pool, org, during_deactivation, owner_id, false).await;
    assert_positions_match_visibility(&pool).await;
    post(&app, &owner, private, Some("Before reactivation")).await;
    post(&app, &owner, private, None).await;
    post(&app, &owner, during_deactivation, None).await;
    sqlx::query("UPDATE users SET deactivated_at=NULL WHERE organization_id=$1 AND id=$2")
        .bind(org)
        .bind(viewer_id)
        .execute(&pool)
        .await
        .unwrap();
    assert_positions_match_visibility(&pool).await;
    let list = channels(&app, &viewer).await;
    let visible = list["channels"].as_array().unwrap();
    assert_eq!(visible.len(), 3);
    assert!(!visible.iter().any(|c| c["id"] == stale_private.to_string()));
    let c = visible
        .iter()
        .find(|c| c["id"] == private.to_string())
        .unwrap();
    assert_eq!(c["read_seq"], 2);
    assert_eq!(c["unread_count"], 0);
    let t = topics(&app, &viewer, private).await;
    assert_eq!(t["topics"][0]["read_seq"], 2);
    assert_eq!(t["topics"][0]["unread_count"], 0);
    assert_eq!(mark(&app, &viewer, private, None, 0).await["read_seq"], 2);
    post(&app, &owner, private, Some("Before reactivation")).await;
    let list = channels(&app, &viewer).await;
    let c = list["channels"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["id"] == private.to_string())
        .unwrap();
    assert_eq!(c["unread_count"], 1);
}

#[sqlx::test]
async fn unread_missing_position_suppresses_only_affected_channel_at_committed_baseline(
    pool: PgPool,
) {
    let (app, org, owner_id, channel, owner) = fixture(&pool).await;
    let viewer_id = Uuid::new_v4();
    let viewer = member(&pool, org, viewer_id).await;
    let unaffected = Uuid::new_v4();
    super::super::channel(&pool, org, unaffected, owner_id, false).await;
    post(&app, &owner, channel, Some("History")).await;
    post(&app, &owner, channel, None).await;
    post(&app, &owner, channel, Some("History")).await;
    post(&app, &owner, unaffected, None).await;
    sqlx::query("DELETE FROM channel_read_positions WHERE organization_id=$1 AND channel_id=$2 AND member_id=$3")
        .bind(org).bind(channel).bind(viewer_id).execute(&pool).await.unwrap();
    let list = channels(&app, &viewer).await;
    let cs = list["channels"].as_array().unwrap();
    assert_eq!(cs.len(), 2);
    let c = cs.iter().find(|c| c["id"] == channel.to_string()).unwrap();
    assert_eq!(c["read_seq"], 3);
    assert_eq!(c["as_of_seq"], 3);
    assert_eq!(c["main_unread_count"], 0);
    assert_eq!(c["unread_count"], 0);
    let other = cs
        .iter()
        .find(|c| c["id"] == unaffected.to_string())
        .unwrap();
    assert_eq!(other["read_seq"], 0);
    assert_eq!(other["unread_count"], 1);
    for suffix in ["topics", "topics?as_of_seq=1", "timeline"] {
        let p = get_projection(&app, &viewer, channel, suffix).await;
        let t = if suffix == "timeline" {
            &p["items"][1]["topic"]
        } else {
            &p["topics"][0]
        };
        assert_eq!(t["read_seq"], p["as_of_seq"]);
        assert_eq!(t["unread_count"], 0);
    }
    // The fallback is read-only: mark-read cannot invent a lost access epoch.
    assert_eq!(
        request(
            &app,
            "PUT",
            &format!("/api/v1/channels/{channel}/read"),
            &viewer,
            json!({"read_seq":3})
        )
        .await
        .status(),
        StatusCode::NOT_FOUND
    );
}
