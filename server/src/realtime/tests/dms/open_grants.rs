use super::denials::{assert_no_publication, refuses};
use super::*;

#[fukulow_test::test]
async fn dm_open_and_grant_denials_preserve_snapshot_and_publish_nothing(pool: PgPool) {
    let f = fixture(&pool).await;
    let (peer, pt) = member(&pool, f.organization).await;
    sqlx::query("UPDATE users SET role='guest' WHERE organization_id=$1 AND id=$2")
        .bind(f.organization)
        .bind(peer)
        .execute(&pool)
        .await
        .unwrap();
    let c = open(&f, peer).await;
    let mut a = f.server.connect(&f.token).await;
    let mut b = f.server.connect(&pt).await;
    for socket in [&mut a, &mut b] {
        subscribe(socket, c, 0).await;
        ready(socket, c, 0).await;
    }
    for token in [&f.token, &pt] {
        let positive = send(&f, token, c, Uuid::new_v4(), "participant control").await;
        assert_eq!(event(&mut a).await["message"], positive);
        assert_eq!(event(&mut b).await["message"], positive);
    }
    for socket in [&mut a, &mut b] {
        activity::collect(&f.state.message_delivery.channel_access.activity, socket).await;
    }
    let foreign_org = organization(&pool).await;
    let (foreign, _) = member(&pool, foreign_org).await;
    let (inactive, _) = member(&pool, f.organization).await;
    let (owner, _) = member(&pool, f.organization).await;
    sqlx::query("UPDATE users SET role='owner' WHERE organization_id=$1 AND id=$2")
        .bind(f.organization)
        .bind(owner)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query(
        "UPDATE users SET deactivated_at=clock_timestamp() WHERE organization_id=$1 AND id=$2",
    )
    .bind(f.organization)
    .bind(inactive)
    .execute(&pool)
    .await
    .unwrap();
    let path = format!("/api/v1/orgs/{}/dms", f.organization);
    for (target, status, error) in [
        (f.member, StatusCode::BAD_REQUEST, "dm_self_not_allowed"),
        (foreign, StatusCode::NOT_FOUND, "member_not_found"),
        (inactive, StatusCode::NOT_FOUND, "member_not_found"),
        (Uuid::new_v4(), StatusCode::NOT_FOUND, "member_not_found"),
    ] {
        refuses(
            &pool,
            &f,
            &mut a,
            &f.token,
            ("POST", path.clone(), json!({"member_id":target})),
            (status, error),
        )
        .await;
        assert_no_publication(&f, &mut b).await;
    }
    for target in [f.member, peer, Uuid::new_v4()] {
        for renew in [false, true] {
            refuses(
                &pool,
                &f,
                &mut a,
                &pt,
                (
                    "POST",
                    path.clone(),
                    json!({"member_id":target,"renew":renew}),
                ),
                (StatusCode::FORBIDDEN, "forbidden"),
            )
            .await;
            assert_no_publication(&f, &mut b).await;
        }
    }
    for (actor, token, role) in [
        (f.member, &f.token, "owner"),
        (f.member, &f.token, "admin"),
        (f.member, &f.token, "member"),
        (peer, &pt, "guest"),
    ] {
        sqlx::query("UPDATE users SET role=$3 WHERE organization_id=$1 AND id=$2")
            .bind(f.organization)
            .bind(actor)
            .bind(role)
            .execute(&pool)
            .await
            .unwrap();
        for (method, suffix, input) in [
            ("GET", "members".to_string(), Value::Null),
            ("POST", "members".into(), json!({"member_id":inactive})),
            ("DELETE", format!("members/{}", f.member), Value::Null),
            ("DELETE", format!("members/{peer}"), Value::Null),
            ("DELETE", format!("members/{inactive}"), Value::Null),
            ("DELETE", format!("members/{}", Uuid::new_v4()), Value::Null),
            ("PATCH", format!("members/{peer}"), json!({"manager":false})),
            ("PATCH", format!("members/{peer}"), json!({"manager":true})),
        ] {
            refuses(
                &pool,
                &f,
                &mut a,
                token,
                (method, format!("/api/v1/channels/{c}/{suffix}"), input),
                (StatusCode::BAD_REQUEST, "dm_membership_fixed"),
            )
            .await;
            assert_no_publication(&f, &mut b).await;
        }
    }
    sqlx::query(
        "UPDATE users SET deactivated_at=clock_timestamp() WHERE organization_id=$1 AND id=$2",
    )
    .bind(f.organization)
    .bind(peer)
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query("UPDATE users SET deactivated_at=NULL WHERE organization_id=$1 AND id=$2")
        .bind(f.organization)
        .bind(peer)
        .execute(&pool)
        .await
        .unwrap();
    for (method, suffix, input) in [
        ("DELETE", format!("members/{peer}"), Value::Null),
        ("POST", "members".into(), json!({"member_id":peer})),
        ("PATCH", format!("members/{peer}"), json!({"manager":false})),
    ] {
        refuses(
            &pool,
            &f,
            &mut a,
            &f.token,
            (method, format!("/api/v1/channels/{c}/{suffix}"), input),
            (StatusCode::BAD_REQUEST, "dm_membership_fixed"),
        )
        .await;
    }
}
