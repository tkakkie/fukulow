use super::*;
use crate::channels::dms::tests::{concurrency::wait_lock, snapshot};

#[fukulow_test::test]
async fn dm_deactivation_first_blocks_both_sender_directions_and_denies_without_publication(
    pool: PgPool,
) {
    for reverse in [false, true] {
        let f = fixture(&pool).await;
        let (peer, pt) = member(&pool, f.organization).await;
        sqlx::query("UPDATE users SET role='guest' WHERE organization_id=$1 AND id=$2")
            .bind(f.organization)
            .bind(peer)
            .execute(&pool)
            .await
            .unwrap();
        let c = open(&f, peer).await;
        let (token, inactive) = if reverse {
            (&pt, f.member)
        } else {
            (&f.token, peer)
        };
        let history = send(&f, token, c, Uuid::new_v4(), "before deactivation").await;
        let mut active = f.server.connect(token).await;
        subscribe(&mut active, c, 0).await;
        assert_eq!(event(&mut active).await["message"], history);
        ready(&mut active, c, 1).await;
        activity::collect(
            &f.state.message_delivery.channel_access.activity,
            &mut active,
        )
        .await;

        // Mirror deactivate_transaction's Organization -> target Member order.
        // The UPDATE is deliberately uncommitted while send captures active authority.
        let mut deactivation = pool.begin().await.unwrap();
        sqlx::query(
            "SELECT organization_id FROM organizations WHERE organization_id=$1 FOR NO KEY UPDATE",
        )
        .bind(f.organization)
        .execute(&mut *deactivation)
        .await
        .unwrap();
        sqlx::query("SELECT name,role,membership_revision FROM users WHERE organization_id=$1 AND id=$2 AND deactivated_at IS NULL FOR NO KEY UPDATE")
            .bind(f.organization).bind(inactive).execute(&mut *deactivation).await.unwrap();
        sqlx::query("UPDATE users SET deactivated_at=clock_timestamp() WHERE organization_id=$1 AND id=$2 AND deactivated_at IS NULL")
            .bind(f.organization).bind(inactive).execute(&mut *deactivation).await.unwrap();
        let before = snapshot(&mut *deactivation).await;
        let sending = {
            let app = f.app.clone();
            let token = token.clone();
            tokio::spawn(async move {
                request(
                    &app,
                    "POST",
                    &format!("/api/v1/channels/{c}/messages"),
                    &token,
                    json!({"client_message_id":Uuid::new_v4(),"body":"must wait for deactivation"}),
                )
                .await
            })
        };
        wait_lock(&pool, "SELECT id,name,deactivated_at%ORDER BY id FOR SHARE").await;
        assert!(
            !sending.is_finished(),
            "send must wait for the peer Member lock"
        );
        deactivation.commit().await.unwrap();
        let denied = tokio::time::timeout(Duration::from_secs(5), sending)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(denied.status(), StatusCode::CONFLICT);
        assert_eq!(body(denied).await, json!({"error":"dm_peer_deactivated"}));
        assert_eq!(snapshot(&pool).await, before);
        denials::assert_no_publication(&f, &mut active).await;

        let r = request(
            &f.app,
            "GET",
            &format!("/api/v1/channels/{c}/messages"),
            token,
            Value::Null,
        )
        .await;
        assert_eq!(r.status(), StatusCode::OK);
        assert_eq!(body(r).await["messages"], json!([history.clone()]));
        let r = request(
            &f.app,
            "PUT",
            &format!("/api/v1/channels/{c}/read"),
            token,
            json!({"read_seq":1}),
        )
        .await;
        assert_eq!(r.status(), StatusCode::OK);
        resubscribe(&mut active, c, 0).await;
        assert_eq!(event(&mut active).await["message"], history);
        ready(&mut active, c, 1).await;
    }
}
