use super::*;
use crate::channels::dms::tests::snapshot;

pub(super) async fn assert_no_publication(f: &Fixture, socket: &mut Client) {
    f.state.message_delivery.flush().await;
    assert_eq!(
        activity::collect(&f.state.message_delivery.channel_access.activity, socket).await,
        Vec::<Value>::new(),
        "a denied DM mutation must publish no activity notice"
    );
    silent(socket).await;
}

pub(super) async fn refuses(
    pool: &PgPool,
    f: &Fixture,
    socket: &mut Client,
    token: &str,
    request: (&str, String, Value),
    expected: (StatusCode, &str),
) {
    let before = snapshot(pool).await;
    let (method, path, input) = request;
    let r = super::request(&f.app, method, &path, token, input).await;
    assert_eq!(r.status(), expected.0, "{method} {path}");
    assert_eq!(
        body(r).await,
        json!({"error":expected.1}),
        "{method} {path}"
    );
    assert_eq!(snapshot(pool).await, before, "{method} {path}");
    assert_no_publication(f, socket).await;
}

#[fukulow_test::test]
async fn dm_denied_mark_read_and_lost_caller_retries_publish_nothing_with_active_controls(
    pool: PgPool,
) {
    for active_role in ["member", "guest"] {
        let f = fixture(&pool).await;
        let (peer, pt) = member(&pool, f.organization).await;
        let c = open(&f, peer).await;
        sqlx::query("UPDATE users SET role=$3 WHERE organization_id=$1 AND id=$2")
            .bind(f.organization)
            .bind(f.member)
            .bind(active_role)
            .execute(&pool)
            .await
            .unwrap();
        let active_key = Uuid::new_v4();
        let active_message = send(&f, &f.token, c, active_key, "active control").await;
        let key = Uuid::new_v4();
        let canonical = send(&f, &pt, c, key, "canonical").await;
        let captured = crate::channels::tests::extract_auth(f.state.clone(), &pt).await;
        let mut active = f.server.connect(&f.token).await;
        subscribe(&mut active, c, 0).await;
        assert_eq!(event(&mut active).await["message"], active_message);
        assert_eq!(event(&mut active).await["message"], canonical);
        ready(&mut active, c, 2).await;
        activity::collect(
            &f.state.message_delivery.channel_access.activity,
            &mut active,
        )
        .await;
        let path = format!("/api/v1/orgs/{}/channels/{c}/read", f.organization);
        for role in ["owner", "admin", "member", "guest", "foreign"] {
            let org = if role == "foreign" {
                organization(&pool).await
            } else {
                f.organization
            };
            let (id, token) = member(&pool, org).await;
            if role != "foreign" {
                sqlx::query("UPDATE users SET role=$3 WHERE organization_id=$1 AND id=$2")
                    .bind(org)
                    .bind(id)
                    .bind(role)
                    .execute(&pool)
                    .await
                    .unwrap();
            }
            refuses(
                &pool,
                &f,
                &mut active,
                &token,
                ("PUT", path.clone(), json!({"read_seq":999})),
                (
                    StatusCode::NOT_FOUND,
                    if role == "foreign" {
                        "organization_unavailable"
                    } else {
                        "channel not found"
                    },
                ),
            )
            .await;
            if role == "foreign" {
                refuses(
                    &pool,
                    &f,
                    &mut active,
                    &token,
                    (
                        "PUT",
                        format!("/api/v1/orgs/{org}/channels/{c}/read"),
                        json!({"read_seq":999}),
                    ),
                    (StatusCode::NOT_FOUND, "channel not found"),
                )
                .await;
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
        for reactivated in [false, true] {
            if reactivated {
                sqlx::query(
                    "UPDATE users SET deactivated_at=NULL WHERE organization_id=$1 AND id=$2",
                )
                .bind(f.organization)
                .bind(peer)
                .execute(&pool)
                .await
                .unwrap();
            }
            let error = if reactivated {
                "channel not found"
            } else {
                "organization_unavailable"
            };
            let before = snapshot(&pool).await;
            let stale = messages::mark_channel_read(
                axum::extract::State(f.state.clone()),
                captured.clone(),
                Ok(axum::extract::Path((f.organization, c))),
                crate::auth::ApiJson(messages::MarkReadRequest { read_seq: 999 }),
            )
            .await
            .unwrap_err()
            .into_response();
            assert_eq!(stale.status(), StatusCode::NOT_FOUND);
            assert_eq!(
                body(stale).await,
                json!({"error":"organization_unavailable"})
            );
            let stale = messages::send_message(
                axum::extract::State(f.state.clone()),
                crate::auth::DeferredOrganizationAuth(Some(captured.clone())),
                Ok(axum::extract::Path((f.organization, c))),
                crate::auth::ApiJson(
                    serde_json::from_value(json!({"client_message_id":key,"body":"canonical"}))
                        .unwrap(),
                ),
            )
            .await
            .unwrap_err()
            .into_response();
            assert_eq!(stale.status(), StatusCode::NOT_FOUND);
            assert_eq!(
                body(stale).await,
                json!({"error":"organization_unavailable"})
            );
            assert_eq!(snapshot(&pool).await, before);
            assert_no_publication(&f, &mut active).await;
            let before = snapshot(&pool).await;
            let stale_open = messages::dms::open(
                axum::extract::State(f.state.clone()),
                captured.clone(),
                crate::auth::ApiJson(crate::channels::dms::OpenDmRequest {
                    member_id: f.member,
                    renew: true,
                }),
            )
            .await
            .unwrap_err()
            .into_response();
            assert_eq!(stale_open.status(), StatusCode::NOT_FOUND);
            assert_eq!(
                body(stale_open).await,
                json!({"error":"organization_unavailable"})
            );
            assert_eq!(snapshot(&pool).await, before);
            assert_no_publication(&f, &mut active).await;
            refuses(
                &pool,
                &f,
                &mut active,
                &pt,
                ("PUT", path.clone(), json!({"read_seq":999})),
                (StatusCode::NOT_FOUND, error),
            )
            .await;
            if active_role == "member" && !reactivated {
                refuses(
                    &pool,
                    &f,
                    &mut active,
                    &f.token,
                    (
                        "POST",
                        format!("/api/v1/orgs/{}/dms", f.organization),
                        json!({"member_id":peer,"renew":true}),
                    ),
                    (StatusCode::NOT_FOUND, "member_not_found"),
                )
                .await;
            }
            refuses(
                &pool,
                &f,
                &mut active,
                &pt,
                (
                    "POST",
                    format!("/api/v1/channels/{c}/messages"),
                    json!({"client_message_id":key,"body":"canonical"}),
                ),
                (StatusCode::NOT_FOUND, error),
            )
            .await;
            refuses(
                &pool,
                &f,
                &mut active,
                &f.token,
                (
                    "POST",
                    format!("/api/v1/channels/{c}/messages"),
                    json!({"client_message_id":Uuid::new_v4(),"body":"new send"}),
                ),
                (
                    StatusCode::CONFLICT,
                    if reactivated {
                        "dm_peer_access_lapsed"
                    } else {
                        "dm_peer_deactivated"
                    },
                ),
            )
            .await;
            let before = snapshot(&pool).await;
            assert_eq!(
                send(&f, &f.token, c, active_key, "active control").await,
                active_message
            );
            assert_eq!(snapshot(&pool).await, before);
            assert_no_publication(&f, &mut active).await;
            let history = request(
                &f.app,
                "GET",
                &format!("/api/v1/channels/{c}/messages"),
                &f.token,
                Value::Null,
            )
            .await;
            assert_eq!(history.status(), StatusCode::OK);
            assert_eq!(
                body(history).await["messages"],
                json!([active_message.clone(), canonical.clone()])
            );
            resubscribe(&mut active, c, 0).await;
            assert_eq!(event(&mut active).await["message"], active_message);
            assert_eq!(event(&mut active).await["message"], canonical);
            ready(&mut active, c, 2).await;
        }
    }
}
