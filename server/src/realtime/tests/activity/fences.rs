use super::*;

#[fukulow_test::test]
async fn paused_query_then_observed_revoke_regrant_rejects_late_publication(pool: PgPool) {
    use crate::channels::activity::{Notice, pause, pause_member};

    for phase in ["snapshot", "query", "authorized", "handoff"] {
        let f = fixture(&pool).await;
        owner(&pool, &f).await;
        let (target, token) = member(&pool, f.organization).await;
        let (control, other) = member(&pool, f.organization).await;
        let private = channel(&pool, f.organization, f.member, true).await;
        grant(&pool, &f, private, target).await;
        grant(&pool, &f, private, control).await;
        let delivery = &f.state.message_delivery.channel_access.activity;
        post(&f, private).await;
        // Finish the automatic publication before registering sockets for the controlled replay below.
        delivery.drained().await;
        let denied_dequeue = (phase != "handoff")
            .then(|| pause_member(f.organization, Uuid::nil(), "dequeue", Some(target)));
        let allowed_dequeue = pause_member(f.organization, Uuid::nil(), "dequeue", Some(control));
        let mut denied = connect(&f, &token).await;
        let mut allowed = connect(&f, &other).await;
        for dequeue in denied_dequeue.iter().chain([&allowed_dequeue]) {
            // Hold dequeue before publication so transition notices and control activity stay buffered.
            dequeue.entered().await;
        }
        // Join these publishers separately: drained() can then finish the permission-change
        // tasks while the old publication stays paused outside the spawn capacity semaphore.
        let publish = |notice, target| {
            let publisher = delivery.clone();
            let pool = f.state.pool.clone();
            let organization = f.organization;
            tokio::spawn(async move {
                publisher
                    .publish(&pool, organization, notice, target, None)
                    .await
                    .unwrap();
            })
        };
        let old_activity = || Notice::ChannelActivity {
            channel_id: private,
            seq: 1,
        };
        let gate = pause_member(
            f.organization,
            private,
            phase,
            if phase == "handoff" {
                Some(target)
            } else {
                None
            },
        );
        let publication = publish(old_activity(), None);
        // The selected boundary has captured old work before either permission transition.
        gate.entered().await;
        // A concurrent member-list publisher must not let its unproved query
        // retire the control's independently authorized activity work.
        let unproved = if matches!(phase, "snapshot" | "authorized") {
            let unproved = pause(f.organization, private, "query");
            let publication = publish(
                Notice::ChannelMembersChanged {
                    channel_id: private,
                },
                None,
            );
            // The recheck must encounter this unproved query alongside the old activity work.
            unproved.entered().await;
            Some((unproved, publication))
        } else {
            None
        };
        if phase == "query" {
            // The recheck may fence an unproved query even with unchanged access. Establish
            // independent authorized control work and keep it buffered through both transitions.
            // Joining proves this control contribution is authorized and enqueued before the recheck.
            publish(old_activity(), Some(control)).await.unwrap();
        }
        let remove = request(
            &f.app,
            "DELETE",
            &format!("/api/v1/channels/{private}/members/{target}"),
            &f.token,
            Value::Null,
        )
        .await;
        assert_eq!(remove.status(), StatusCode::NO_CONTENT);
        // The old publishers are separately joined; this waits for all detached revoke notices.
        delivery.drained().await;
        let add = request(
            &f.app,
            "POST",
            &format!("/api/v1/channels/{private}/members"),
            &f.token,
            json!({"member_id":target}),
        )
        .await;
        assert_eq!(add.status(), StatusCode::NO_CONTENT);
        // Finish every fresh transition publisher before resuming or collecting old work.
        delivery.drained().await;
        if let Some((unproved, publication)) = unproved {
            unproved.release();
            // Joining proves the unrelated paused publisher has completed, not merely been released.
            tokio::time::timeout(Duration::from_secs(5), publication)
                .await
                .unwrap()
                .unwrap();
        }
        gate.release();
        // Joining completes enqueue; in handoff the released gate is ready before the collection Ping.
        tokio::time::timeout(Duration::from_secs(5), publication)
            .await
            .unwrap()
            .unwrap();
        if let Some(dequeue) = denied_dequeue {
            dequeue.release();
        }
        allowed_dequeue.release();
        let before = notices(&f, &mut denied).await;
        assert!(
            !before.iter().any(|notice| matches!(
                notice["type"].as_str(),
                Some("channel_activity" | "activity_reset" | "channel_access_revoked")
            )),
            "phase={phase}: {before:?}"
        );
        let control = notices(&f, &mut allowed).await;
        assert!(
            control.contains(&activity(private, 1)),
            "phase={phase}: {control:?}"
        );
        post(&f, private).await;
        assert_eq!(
            notices(&f, &mut denied).await,
            vec![activity(private, 2)],
            "phase={phase}: fresh target activity"
        );
        assert_eq!(
            notices(&f, &mut allowed).await,
            vec![activity(private, 2)],
            "phase={phase}: fresh control activity"
        );
    }
}

#[fukulow_test::test]
async fn fallback_fences_first_in_flight_notice_without_buffered_provenance(pool: PgPool) {
    use crate::auth::SubscriptionRecheck;
    for watched in [false, true] {
        for phase in ["query", "authorized"] {
            let f = fixture(&pool).await;
            let (target, token) = member(&pool, f.organization).await;
            let (control, other) = member(&pool, f.organization).await;
            let private = channel(&pool, f.organization, f.member, true).await;
            grant(&pool, &f, private, target).await;
            grant(&pool, &f, private, control).await;
            let mut denied = connect(&f, &token).await;
            let mut allowed = connect(&f, &other).await;
            if watched {
                subscribe(&mut denied, private, 0).await;
                assert_eq!(raw_event(&mut denied).await["type"], "subscribed");
            }
            let gate = crate::channels::activity::pause(f.organization, private, phase);
            post(&f, private).await;
            gate.entered().await;
            if watched {
                assert_eq!(raw_event(&mut denied).await["type"], "message");
            }
            // Bypass the mutation hook and fast signal, as when a loss signal is dropped.
            sqlx::query("DELETE FROM channel_members WHERE organization_id=$1 AND channel_id=$2 AND member_id=$3")
                .bind(f.organization).bind(private).bind(target).execute(&pool).await.unwrap();
            f.state
                .message_delivery
                .channel_access
                .check(&f.state.pool, crate::auth::SubscriptionScope::All)
                .await
                .unwrap();
            if watched {
                assert_eq!(raw_event(&mut denied).await["type"], "channel_access_lost");
            }
            // A new grant must not revive the paused first authorization.
            grant(&pool, &f, private, target).await;
            gate.release();
            assert!(
                notices(&f, &mut denied).await.is_empty(),
                "{phase}, watched={watched}"
            );
            // The All pass also fences an unproved control query, even with an unchanged grant.
            let expected = if phase == "query" {
                vec![]
            } else {
                vec![activity(private, 1)]
            };
            assert_eq!(notices(&f, &mut allowed).await, expected);
            post(&f, private).await;
            assert_eq!(notices(&f, &mut denied).await, vec![activity(private, 2)]);
            assert_eq!(notices(&f, &mut allowed).await, vec![activity(private, 2)]);
        }
    }
}

#[fukulow_test::test]
async fn coalesced_query_fence_preserves_independent_activity_and_read_positions(pool: PgPool) {
    use crate::channels::activity::{Notice, pause, pause_member};

    for read_position in [false, true] {
        for (first, second, fence_first) in [(1, 2, false), (2, 1, true), (2, 2, true)] {
            for fence in [false, true] {
                let mut f = fixture(&pool).await;
                f.channel = channel(&pool, f.organization, f.member, true).await;
                let delivery = &f.state.message_delivery.channel_access.activity;
                // Keep both publications buffered, as when another socket write is busy.
                let dequeue = pause_member(f.organization, Uuid::nil(), "dequeue", Some(f.member));
                let mut socket = connect(&f, &f.token).await;
                dequeue.entered().await;
                let notice = |value| {
                    if read_position {
                        Notice::ReadPositionChanged {
                            channel_id: f.channel,
                            topic_id: None,
                            read_seq: value,
                        }
                    } else {
                        Notice::ChannelActivity {
                            channel_id: f.channel,
                            seq: value,
                        }
                    }
                };
                if !fence_first {
                    delivery
                        .publish(
                            &f.state.pool,
                            f.organization,
                            notice(first),
                            Some(f.member),
                            None,
                        )
                        .await
                        .unwrap();
                }
                let query = pause(f.organization, f.channel, "query");
                let publisher = delivery.clone();
                let publish_pool = f.state.pool.clone();
                let organization = f.organization;
                let target = f.member;
                let winner = notice(if fence_first { first } else { second });
                let publication = tokio::spawn(async move {
                    publisher
                        .publish(&publish_pool, organization, winner, Some(target), None)
                        .await
                        .unwrap();
                });
                query.entered().await;
                let check = if fence {
                    let fallback = pause_member(
                        f.organization,
                        f.channel,
                        "fallback_snapshot",
                        Some(f.member),
                    );
                    let checker = delivery.clone();
                    let check_pool = f.state.pool.clone();
                    let check = tokio::spawn(async move {
                        checker
                            .check(
                                &check_pool,
                                crate::auth::SubscriptionScope::Member(organization, target),
                            )
                            .await;
                    });
                    fallback.entered().await;
                    Some((fallback, check))
                } else {
                    None
                };
                query.release();
                publication.await.unwrap();
                if fence_first {
                    delivery
                        .publish(
                            &f.state.pool,
                            f.organization,
                            notice(second),
                            Some(f.member),
                            None,
                        )
                        .await
                        .unwrap();
                }
                // Both authorization queries have completed and their guards have
                // dropped before the old unproved snapshot fences the winning token.
                // Access, grant and registration have remained unchanged throughout.
                if let Some((fallback, check)) = check {
                    fallback.release();
                    check.await.unwrap();
                }
                dequeue.release();
                let expected = if fence {
                    json!({"type":"activity_reset"})
                } else {
                    serde_json::to_value(notice(2)).unwrap()
                };
                assert_eq!(
                    notices(&f, &mut socket).await,
                    vec![expected],
                    "read_position={read_position}, first={first}, second={second}, fence={fence}"
                );
                // New work still delivers normally in the same socket epoch.
                delivery
                    .publish(
                        &f.state.pool,
                        f.organization,
                        notice(3),
                        Some(f.member),
                        None,
                    )
                    .await
                    .unwrap();
                assert_eq!(
                    notices(&f, &mut socket).await,
                    vec![serde_json::to_value(notice(3)).unwrap()]
                );
            }
        }
    }
}

#[fukulow_test::test]
async fn fallback_unproved_snapshot_rejects_authorization_completed_before_regrant(pool: PgPool) {
    for phase in ["authorized", "handoff"] {
        let f = fixture(&pool).await;
        let (target, token) = member(&pool, f.organization).await;
        let (control, other) = member(&pool, f.organization).await;
        let private = channel(&pool, f.organization, f.member, true).await;
        grant(&pool, &f, private, target).await;
        grant(&pool, &f, private, control).await;
        let mut denied = connect(&f, &token).await;
        let mut allowed = connect(&f, &other).await;
        let query = crate::channels::activity::pause(f.organization, private, "query");
        let authorized = crate::channels::activity::pause_member(
            f.organization,
            private,
            phase,
            (phase == "handoff").then_some(target),
        );
        let fallback = crate::channels::activity::pause_member(
            f.organization,
            private,
            "fallback_snapshot",
            Some(target),
        );
        post(&f, private).await;
        query.entered().await;
        let checker = f.state.message_delivery.channel_access.activity.clone();
        let check_pool = f.state.pool.clone();
        let organization = f.organization;
        let check = tokio::spawn(async move {
            checker
                .check(
                    &check_pool,
                    crate::auth::SubscriptionScope::Member(organization, target),
                )
                .await;
        });
        fallback.entered().await;
        // Fallback copied None; publication establishes G1, possibly enqueueing it
        // and dropping its query guard before fallback observes G2.
        query.release();
        authorized.entered().await;
        // Replace G1 with G2 without mutation hooks or fast signals, before fallback SQL.
        sqlx::query(
        "DELETE FROM channel_members WHERE organization_id=$1 AND channel_id=$2 AND member_id=$3",
    )
    .bind(f.organization)
    .bind(private)
    .bind(target)
    .execute(&pool)
    .await
    .unwrap();
        grant(&pool, &f, private, target).await;
        fallback.release();
        check.await.unwrap();
        authorized.release();
        assert!(notices(&f, &mut denied).await.is_empty());
        assert_eq!(notices(&f, &mut allowed).await, vec![activity(private, 1)]);
        post(&f, private).await;
        assert_eq!(notices(&f, &mut denied).await, vec![activity(private, 2)]);
        assert_eq!(notices(&f, &mut allowed).await, vec![activity(private, 2)]);
    }
}

#[fukulow_test::test]
async fn subscription_refresh_loss_retires_a_first_notice_after_activity_check_succeeded(
    pool: PgPool,
) {
    let f = fixture(&pool).await;
    let (target, token) = member(&pool, f.organization).await;
    let (control, other) = member(&pool, f.organization).await;
    let private = channel(&pool, f.organization, f.member, true).await;
    grant(&pool, &f, private, target).await;
    grant(&pool, &f, private, control).await;
    let access = &f.state.message_delivery.channel_access;
    let watch = access
        .subscribe(&f.state.pool, f.organization, (target, 0), private)
        .await
        .unwrap()
        .unwrap();
    let mut denied = connect(&f, &token).await;
    let mut allowed = connect(&f, &other).await;
    let gate = crate::channels::activity::pause(f.organization, private, "authorized");
    post(&f, private).await;
    gate.entered().await;
    // The Activity part of fallback can precede the loss; the subsequent subscription read must fence it too.
    access
        .activity
        .check(&f.state.pool, crate::auth::SubscriptionScope::All)
        .await;
    sqlx::query(
        "DELETE FROM channel_members WHERE organization_id=$1 AND channel_id=$2 AND member_id=$3",
    )
    .bind(f.organization)
    .bind(private)
    .bind(target)
    .execute(&pool)
    .await
    .unwrap();
    watch.refresh(&f.state.pool).await.unwrap();
    assert_eq!(watch.status(), 1);
    grant(&pool, &f, private, target).await;
    gate.release();
    assert!(notices(&f, &mut denied).await.is_empty());
    assert_eq!(notices(&f, &mut allowed).await, vec![activity(private, 1)]);
}

#[fukulow_test::test]
async fn durable_grant_comparison_retires_buffered_activity_after_lost_fast_signals(pool: PgPool) {
    let f = fixture(&pool).await;
    let (target, token) = member(&pool, f.organization).await;
    let (control, control_token) = member(&pool, f.organization).await;
    let private = channel(&pool, f.organization, f.member, true).await;
    grant(&pool, &f, private, target).await;
    grant(&pool, &f, private, control).await;
    let mut own = connect(&f, &token).await;
    let mut allowed = connect(&f, &control_token).await;
    post(&f, private).await;
    assert_eq!(notices(&f, &mut own).await, vec![activity(private, 1)]);
    notices(&f, &mut allowed).await;
    let gate =
        crate::channels::activity::pause_member(f.organization, private, "handoff", Some(target));
    post(&f, private).await;
    gate.entered().await;
    sqlx::query(
        "DELETE FROM channel_members WHERE organization_id=$1 AND channel_id=$2 AND member_id=$3",
    )
    .bind(f.organization)
    .bind(private)
    .bind(target)
    .execute(&pool)
    .await
    .unwrap();
    grant(&pool, &f, private, target).await;
    f.state
        .message_delivery
        .channel_access
        .activity
        .check(
            &f.state.pool,
            crate::auth::SubscriptionScope::Member(f.organization, target),
        )
        .await;
    gate.release();
    assert!(notices(&f, &mut own).await.is_empty());
    assert_eq!(notices(&f, &mut allowed).await, vec![activity(private, 2)]);
    post(&f, private).await;
    assert_eq!(notices(&f, &mut own).await, vec![activity(private, 3)]);
    assert_eq!(notices(&f, &mut allowed).await, vec![activity(private, 3)]);
}
