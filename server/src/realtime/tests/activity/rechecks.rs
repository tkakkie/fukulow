use super::*;
use crate::{
    auth::{
        activity::ChannelChange,
        hook_decorator::{ActivityHooks, BeforeRecheck, ChangeHooks, Decorator, RecheckHooks},
    },
    channels::activity::pause,
};
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};

fn order_permission_change(f: &Fixture, channel: Uuid, phase: &'static str) {
    let started = Arc::new(AtomicBool::new(false));
    let gate = pause(f.organization, channel, phase);
    let channel_started = started.clone();
    let commit_started = started.clone();
    f.state.session_changes.set_activity(Arc::new(Decorator {
        inner: f.state.message_delivery.channel_access.activity.clone(),
        hooks: ActivityHooks {
            before_channel: Some(Box::new(move |change| {
                assert!(matches!(change, ChannelChange::Members { .. }));
                channel_started.store(true, Ordering::SeqCst);
            })),
            after_capture: Some(Box::new(move |_| {
                let started = commit_started.clone();
                Some(ChangeHooks {
                    skip_retire: false,
                    commit: Box::new(move |change, pool| {
                        started.store(true, Ordering::SeqCst);
                        change.committed(pool);
                    }),
                })
            })),
        },
    }));
    let recheck_gate = gate.clone();
    f.state
        .session_changes
        .set_subscription_recheck(Arc::new(Decorator {
            inner: f.state.message_delivery.channel_access.clone(),
            hooks: RecheckHooks {
                before_recheck: Some(Box::new(move |_| {
                    // Force a publisher started before this recheck to expose its unproved
                    // query. A publisher started afterwards passes the already released gate.
                    if started.load(Ordering::SeqCst) {
                        let gate = recheck_gate.clone();
                        BeforeRecheck::Wait(Box::pin(async move { gate.entered().await }))
                    } else {
                        BeforeRecheck::Run
                    }
                })),
                after_recheck: Some(Box::new(move |result| {
                    assert!(result.is_ok(), "mutation recheck failed: {result:?}");
                    gate.release();
                })),
                ..RecheckHooks::default()
            },
        }));
}

#[fukulow_test::test]
async fn role_change_keeps_target_gain_after_its_own_recheck(pool: PgPool) {
    let f = fixture(&pool).await;
    owner(&pool, &f).await;
    let (target, token) = member(&pool, f.organization).await;
    role(&pool, &f, target, "guest").await;
    let (guest, guest_token) = member(&pool, f.organization).await;
    role(&pool, &f, guest, "guest").await;
    let private = channel(&pool, f.organization, f.member, true).await;
    let mut own = connect(&f, &token).await;
    let mut denied = connect(&f, &guest_token).await;
    let mut control = connect(&f, &f.token).await;
    order_permission_change(&f, f.channel, "query");
    let response = request(
        &f.app,
        "PATCH",
        &format!("/api/v1/orgs/{}/members/{target}/role", f.organization),
        &f.token,
        json!({"role":"member"}),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let own = notices(&f, &mut own).await;
    let control = notices(&f, &mut control).await;
    let denied = notices(&f, &mut denied).await;
    assert!(
        own.contains(&json!({"type":"channel_access_gained","channel_id":f.channel})),
        "target={own:?}, control={control:?}, ungranted Guest={denied:?}"
    );
    assert!(control.contains(&json!({"type":"members_changed"})));
    assert!(denied.is_empty(), "ungranted Guest={denied:?}");
    assert!(
        !own.iter()
            .any(|notice| notice["channel_id"] == json!(private)),
        "private non-member={own:?}"
    );
}

#[fukulow_test::test]
async fn role_change_keeps_member_notice_after_its_own_recheck(pool: PgPool) {
    let f = fixture(&pool).await;
    owner(&pool, &f).await;
    let (target, token) = member(&pool, f.organization).await;
    let private = channel(&pool, f.organization, f.member, true).await;
    grant(&pool, &f, private, target).await;
    let (_, outside_token) = member(&pool, f.organization).await;
    let (guest, guest_token) = member(&pool, f.organization).await;
    role(&pool, &f, guest, "guest").await;
    let mut own = connect(&f, &token).await;
    let mut control = connect(&f, &f.token).await;
    let mut outside = connect(&f, &outside_token).await;
    let mut denied = connect(&f, &guest_token).await;
    order_permission_change(&f, private, "members_query");
    let response = request(
        &f.app,
        "PATCH",
        &format!("/api/v1/orgs/{}/members/{target}/role", f.organization),
        &f.token,
        json!({"role":"admin"}),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let own = notices(&f, &mut own).await;
    let control = notices(&f, &mut control).await;
    let outside = notices(&f, &mut outside).await;
    let denied = notices(&f, &mut denied).await;
    let changed = json!({"type":"channel_members_changed","channel_id":private});
    assert!(
        own.contains(&changed),
        "target={own:?}, control={control:?}, private non-member={outside:?}"
    );
    assert!(control.contains(&changed), "control={control:?}");
    assert_eq!(outside, vec![json!({"type":"members_changed"})]);
    assert!(denied.is_empty(), "ungranted Guest={denied:?}");
}

#[fukulow_test::test]
async fn permission_change_keeps_member_notice_after_its_own_recheck(pool: PgPool) {
    let f = fixture(&pool).await;
    owner(&pool, &f).await;
    let (target, _) = member(&pool, f.organization).await;
    let private = channel(&pool, f.organization, f.member, true).await;
    grant(&pool, &f, private, target).await;
    let delivery = &f.state.message_delivery.channel_access.activity;
    delivery.drained().await;
    let mut control = connect(&f, &f.token).await;
    let (_, outside_token) = member(&pool, f.organization).await;
    let mut denied = connect(&f, &outside_token).await;
    let mut transitions = Vec::new();
    for remove in [true, false] {
        order_permission_change(&f, private, "members_query");
        let (method, path, body) = if remove {
            (
                "DELETE",
                format!("/api/v1/channels/{private}/members/{target}"),
                Value::Null,
            )
        } else {
            (
                "POST",
                format!("/api/v1/channels/{private}/members"),
                json!({"member_id":target}),
            )
        };
        let response = request(&f.app, method, &path, &f.token, body).await;
        assert_eq!(response.status(), StatusCode::NO_CONTENT);
        transitions.push((
            method,
            notices(&f, &mut control).await,
            notices(&f, &mut denied).await,
        ));
    }
    // Finish both transitions even in the negative check, proving that both legitimate
    // invalidations can be lost without saturation, coalescing or an unfinished publisher.
    for (method, received, denied) in &transitions {
        assert!(
            received.contains(&json!({"type":"channel_members_changed","channel_id":private})),
            "method={method}: transitions={transitions:?}"
        );
        assert!(
            !denied.contains(&json!({"type":"channel_members_changed","channel_id":private})),
            "method={method}: private non-member notices={denied:?}"
        );
    }
}

#[fukulow_test::test]
async fn permission_change_keeps_target_gain_after_its_own_recheck(pool: PgPool) {
    let f = fixture(&pool).await;
    owner(&pool, &f).await;
    let (target, token) = member(&pool, f.organization).await;
    let private = channel(&pool, f.organization, f.member, true).await;
    let mut own = connect(&f, &token).await;
    let mut control = connect(&f, &f.token).await;
    let (_, outside_token) = member(&pool, f.organization).await;
    let mut denied = connect(&f, &outside_token).await;
    order_permission_change(&f, private, "query");
    let response = request(
        &f.app,
        "POST",
        &format!("/api/v1/channels/{private}/members"),
        &f.token,
        json!({"member_id":target}),
    )
    .await;
    assert_eq!(response.status(), StatusCode::NO_CONTENT);
    let own = notices(&f, &mut own).await;
    let control = notices(&f, &mut control).await;
    let denied = notices(&f, &mut denied).await;
    assert!(
        own.contains(&json!({"type":"channel_access_gained","channel_id":private})),
        "target={own:?}, control={control:?}, private non-member={denied:?}"
    );
    assert!(control.contains(&json!({"type":"channel_members_changed","channel_id":private})));
    assert_eq!(denied, vec![json!({"type":"members_changed"})]);
}
