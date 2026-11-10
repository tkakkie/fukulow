use super::*;
use std::time::Duration;

#[sqlx::test]
async fn unread_grant_excludes_uncommitted_send_and_mark_waits_for_commit_barrier(pool: PgPool) {
    let (app, org, _, channel, owner) = fixture(&pool).await;
    post(&app, &owner, channel, None).await;
    let key = Uuid::new_v4();
    let pending = ambiguous_commit(key);
    let response = send(&app, &owner, channel, input(key, "Pending commit")).await;
    assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
    let tx = pending.await.unwrap();
    // The counter already allocated 2, but only 1 is committed at this grant.
    let viewer = member(&pool, org, Uuid::new_v4()).await;
    assert_eq!(channels(&app, &viewer).await["channels"][0]["read_seq"], 1);
    let work_app = app.clone();
    let work_viewer = viewer.clone();
    let task =
        tokio::spawn(async move { mark(&work_app, &work_viewer, channel, None, i64::MAX).await });
    // A SQL lock wait, rather than elapsed time, proves this request reached
    // the barrier while the COMMIT outcome was unresolved.
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            let waiting: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event='advisory' AND query LIKE '%135%')").fetch_one(&pool).await.unwrap();
            if waiting { break; }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    }).await.unwrap();
    assert!(!task.is_finished());
    tx.commit().await.unwrap();
    assert_eq!(task.await.unwrap()["read_seq"], 2);
    assert_eq!(
        channels(&app, &viewer).await["channels"][0]["unread_count"],
        0
    );
}

#[sqlx::test]
async fn unread_mark_rechecks_revoked_access_after_barrier_wait(pool: PgPool) {
    for deactivate in [false, true] {
        let (app, org, owner_id, channel, owner) = fixture(&pool).await;
        let viewer_id = Uuid::new_v4();
        let viewer = member(&pool, org, viewer_id).await;
        sqlx::query("INSERT INTO channel_members (organization_id,channel_id,member_id) VALUES ($1,$2,$3),($1,$2,$4)").bind(org).bind(channel).bind(owner_id).bind(viewer_id).execute(&pool).await.unwrap();
        sqlx::query("UPDATE channels SET visibility='private' WHERE organization_id=$1 AND id=$2")
            .bind(org)
            .bind(channel)
            .execute(&pool)
            .await
            .unwrap();
        let key = Uuid::new_v4();
        let pending = ambiguous_commit(key);
        send(&app, &owner, channel, input(key, "Pending")).await;
        let tx = pending.await.unwrap();
        let work_app = app.clone();
        let work_viewer = viewer.clone();
        let task = tokio::spawn(async move {
            request(
                &work_app,
                "PUT",
                &format!("/api/v1/channels/{channel}/read"),
                &work_viewer,
                json!({"read_seq":100}),
            )
            .await
        });
        tokio::time::timeout(Duration::from_secs(3),async {
            loop {
                let waiting:bool=sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event='advisory' AND query LIKE '%135%')").fetch_one(&pool).await.unwrap();
                if waiting {break;}
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        }).await.unwrap();
        if deactivate {
            sqlx::query("UPDATE users SET deactivated_at=now() WHERE organization_id=$1 AND id=$2")
                .bind(org)
                .bind(viewer_id)
                .execute(&pool)
                .await
                .unwrap();
        } else {
            sqlx::query("DELETE FROM channel_members WHERE organization_id=$1 AND channel_id=$2 AND member_id=$3").bind(org).bind(channel).bind(viewer_id).execute(&pool).await.unwrap();
        }
        tx.commit().await.unwrap();
        let response = task.await.unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        assert_eq!(
            body(response).await,
            json!({"error":if deactivate {"organization_unavailable"} else {"channel not found"}})
        );
        assert_eq!(mark(&app, &owner, channel, None, 100).await["read_seq"], 1);
    }
}

#[sqlx::test]
async fn unread_concurrent_member_and_channel_creation_initialize_access_once(pool: PgPool) {
    let (_, org, owner, _, _) = fixture(&pool).await;
    let new_channel = Uuid::new_v4();
    let mut tx = pool.begin().await.unwrap();
    sqlx::query("INSERT INTO channels (organization_id,id,name,visibility) VALUES ($1,$2,'Concurrent','public')").bind(org).bind(new_channel).execute(&mut *tx).await.unwrap();
    let task_pool = pool.clone();
    let viewer_id = Uuid::new_v4();
    let task = tokio::spawn(async move { member(&task_pool, org, viewer_id).await });
    tokio::time::timeout(Duration::from_secs(3),async {
        loop {
            let waiting:bool=sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event='advisory' AND query LIKE 'INSERT INTO users%')").fetch_one(&pool).await.unwrap();
            if waiting {break;}
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    }).await.unwrap();
    tx.commit().await.unwrap();
    let viewer = task.await.unwrap();
    let c = channels(&router(&pool), &viewer).await;
    assert_eq!(c["channels"].as_array().unwrap().len(), 2);
    let count:i64=sqlx::query_scalar("SELECT count(*) FROM channel_read_positions WHERE organization_id=$1 AND channel_id=$2 AND member_id=ANY($3)").bind(org).bind(new_channel).bind(vec![owner,viewer_id]).fetch_one(&pool).await.unwrap();
    assert_eq!(count, 2);
}
