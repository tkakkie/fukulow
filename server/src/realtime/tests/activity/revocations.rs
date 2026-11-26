use super::*;
use crate::realtime::tests::isolated_test::run_isolated_test;
use crate::{
    auth::{
        SubscriptionScope,
        activity::ChangeScope,
        activity::hook_decorator::{
            ActivityHooks, BeforeRecheck, ChangeHooks, Decorator, RecheckHooks,
        },
    },
    channels::{
        activity::{Notice, pause_member},
        tests::extract_auth,
    },
};
use futures_util::FutureExt;
use std::sync::{Arc, Mutex};

mod admission;
mod case;
mod holds;
mod matrix;

use case::{Case, Later};

#[test]
fn send_measurement_records_delivered_revocation_only() {
    // The production subscriber is process-wide. Other connection tests reach the same
    // tracing callsites concurrently, so give this observation its own process.
    let result = run_isolated_test(&[
        "--ignored",
        "--exact",
        concat!(module_path!(), "::send_measurement_child")
            .split_once("::")
            .unwrap()
            .1,
    ]);
    let stdout = String::from_utf8_lossy(&result.stdout);
    assert!(
        result.status.success() && stdout.contains("1 passed"),
        "{stdout}{}",
        String::from_utf8_lossy(&result.stderr)
    );
}

#[fukulow_test::test]
#[ignore = "subprocess helper with a global measurement subscriber"]
async fn send_measurement_child(pool: PgPool) {
    let output = crate::observability::tests::Capture::default();
    tracing::subscriber::set_global_default(output.measurement_subscriber()).unwrap();
    let case = Case::new(&pool, false, Later::Regrant).await;
    let mut socket = connect(&case.f, &case.token).await;
    let sent = || {
        output
            .events()
            .into_iter()
            .filter(|event| event["fields"]["event"] == "channel_access_revoked_sent")
            .collect::<Vec<_>>()
    };

    let gate = case.pause_revocation("handoff");
    case.remove_grant().await;
    gate.entered().await;
    assert!(sent().is_empty());
    case.grant(case.revoked).await;
    gate.release();
    let revoked = json!({"type":"channel_access_revoked", "channel_id":case.revoked});
    assert!(!notices(&case.f, &mut socket).await.contains(&revoked));
    assert!(sent().is_empty());

    case.remove_grant().await;
    assert!(notices(&case.f, &mut socket).await.contains(&revoked));
    let recorded = sent();
    assert_eq!(recorded.len(), 1, "{}", output.text());
    assert_eq!(
        recorded[0]["target"],
        crate::observability::REVOCATION_MEASUREMENT_TARGET
    );
    let fields = &recorded[0]["fields"];
    assert_eq!(fields["channel_id"], case.revoked.to_string());
    assert_eq!(fields["after_hold"], false);
    let before = fields["before_ms"].as_f64().unwrap();
    let after = fields["after_ms"].as_f64().unwrap();
    assert!(0.0 <= before && before <= after);
}

enum MemberRecheck {
    Run,
    Hold(Arc<Gate>),
    Skip,
}
impl Case {
    fn hold_member_recheck(&self) -> Arc<Gate> {
        let gate = Arc::new(Gate::default());
        self.set_rechecks(MemberRecheck::Hold(gate.clone()), None);
        gate
    }

    fn set_rechecks(&self, member_recheck: MemberRecheck, skip_channel: Option<Uuid>) {
        let identity = (self.f.organization, self.target);
        self.f
            .state
            .session_changes
            .set_subscription_recheck(Arc::new(Decorator {
                inner: self.f.state.message_delivery.channel_access.clone(),
                hooks: RecheckHooks {
                    before_recheck: Some(Box::new(move |scope| match scope {
                        SubscriptionScope::Channel(org, channel)
                            if org == identity.0 && skip_channel == Some(channel) =>
                        {
                            BeforeRecheck::Skip
                        }
                        SubscriptionScope::Member(org, member) if (org, member) == identity => {
                            match &member_recheck {
                                MemberRecheck::Run => BeforeRecheck::Run,
                                MemberRecheck::Hold(gate) => {
                                    let gate = gate.clone();
                                    BeforeRecheck::Wait(Box::pin(async move { gate.pause().await }))
                                }
                                MemberRecheck::Skip => BeforeRecheck::Skip,
                            }
                        }
                        _ => BeforeRecheck::Run,
                    })),
                    ..RecheckHooks::default()
                },
            }));
    }
}

async fn closed_pool(pool: &PgPool) -> PgPool {
    let closed = sqlx::postgres::PgPoolOptions::new()
        .connect_lazy_with(pool.connect_options().as_ref().clone());
    closed.close().await;
    closed
}

#[fukulow_test::test]
async fn role_revocations_survive_a_later_grant_during_recheck(pool: PgPool) {
    let case = Case::new(&pool, true, Later::OtherGrant).await;
    let token = session::another_session(&pool, case.f.organization, case.target).await;
    let mut socket = connect(&case.f, &token).await;
    let gate = case.hold_member_recheck();
    let ((), ()) = tokio::join!(case.set_role("guest"), async {
        gate.entered().await;
        case.grant(case.other).await;
        case.delivery().drained().await;
        gate.release();
    });
    assert_eq!(
        notices(&case.f, &mut socket)
            .await
            .iter()
            .filter(|event| **event
                == json!({"type":"channel_access_revoked","channel_id":case.revoked}))
            .count(),
        1,
        "the Role change lost its revocation during its Member recheck"
    );
}

#[fukulow_test::test]
async fn first_handoff_rechecks_a_role_superseded_revocation(pool: PgPool) {
    let case = Case::new(&pool, false, Later::Role).await;
    case.remove_grant().await;
    case.delivery().drained().await;
    let frame = case.take_revocation();
    let gate = case.hold_member_recheck();
    let ((), received) = tokio::join!(case.set_role("guest"), async {
        gate.entered().await;
        let received = case.received_revocations(Some(frame)).await;
        gate.release();
        received
    });
    case.delivery().drained().await;
    assert_eq!(received, 1);
}

#[fukulow_test::test]
async fn role_recheck_rejects_a_racing_regrant(pool: PgPool) {
    for restored in [false, true] {
        let case = Case::new(&pool, false, Later::Regrant).await;
        case.remove_grant().await;
        case.delivery().drained().await;
        let frame = case.take_revocation();

        let role = case.hold_member_recheck();
        let publisher = case.pause_role_publisher();
        let ((), ()) = tokio::join!(case.set_role("guest"), async {
            role.entered().await;
            if restored {
                // Commit the grant without retirement, subscription recheck or publication.
                grant(&pool, &case.f, case.revoked, case.target).await;
            }
            role.release();
        });
        publisher.entered().await;
        let closed = closed_pool(&case.f.state.pool).await;
        // A handoff query would make this poll pending, even with a closed pool.
        case.pause_revocation("handoff_recheck");
        let sent = frame
            .handoff(&closed, |event| async { event })
            .now_or_never();
        publisher.release();
        case.delivery().drained().await;
        assert_eq!(
            sent,
            Some((!restored).then(|| case.revoked())),
            "the Role recheck alone must decide first handoff (restored={restored})"
        );
    }
}

#[fukulow_test::test]
async fn role_recheck_keeps_the_original_channel_sequence(pool: PgPool) {
    let mut writes = Vec::new();
    for retire_before_handoff in [false, true] {
        let case = Case::new(&pool, false, Later::Role).await;
        case.remove_grant().await;
        case.delivery().drained().await;
        let old = case.take_revocation();

        case.set_rechecks(MemberRecheck::Run, Some(case.revoked));
        let regrant = case.hold_retirement(Some(case.revoked));
        case.grant(case.revoked).await;
        regrant.entered().await;
        let removal = case.hold_retirement(Some(case.revoked));
        case.remove_grant().await;
        removal.entered().await;
        case.set_role("guest").await;
        case.delivery().drained().await;

        // The grant's sequence is after the first removal and before both the
        // second removal and the Role that just verified the original frame.
        if retire_before_handoff {
            regrant.release();
            regrant.entered().await;
        }
        if old
            .handoff(&case.f.state.pool, |event| async { event })
            .await
            == Some(case.revoked())
        {
            writes.push(retire_before_handoff);
        }
        if !retire_before_handoff {
            regrant.release();
            regrant.entered().await;
        }
        removal.release();
        removal.entered().await;
        case.delivery().drained().await;
        assert_eq!(
            case.received_revocations(None).await,
            1,
            "the second removal"
        );
    }
    assert_eq!(
        writes,
        [false],
        "the delayed grant must fence only the first removal"
    );
}

#[fukulow_test::test]
async fn older_role_snapshot_fences_observed_regrant_before_handoff(pool: PgPool) {
    let mut writes = Vec::new();
    for restored in [false, true] {
        let case = Case::new(&pool, false, Later::Role).await;
        case.remove_grant().await;
        case.delivery().drained().await;
        let frame = case.take_revocation();

        let gate = case.pause_revocation("fallback_snapshot");
        let ((), ()) = tokio::join!(
            case.delivery().check(
                &case.f.state.pool,
                SubscriptionScope::Channel(case.f.organization, case.revoked)
            ),
            async {
                gate.entered().await;
                case.set_role("guest").await;
                case.delivery().drained().await;
                // The Role recheck verified absence. Only the older fallback
                // observes the grant before handoff.
                if restored {
                    grant(&pool, &case.f, case.revoked, case.target).await;
                }
                gate.release();
            }
        );
        if let Some(event) = frame
            .handoff(&case.f.state.pool, |event| async { event })
            .await
        {
            assert_eq!(event, case.revoked());
            writes.push(restored);
        }
    }
    assert_eq!(
        writes,
        [false],
        "the older query observed the grant before handoff"
    );
}

#[fukulow_test::test]
async fn older_role_snapshot_fences_observed_membership_loss_before_handoff(pool: PgPool) {
    for inactive in [false, true] {
        let case = Case::new(&pool, false, Later::Role).await;
        case.remove_grant().await;
        case.delivery().drained().await;
        let frame = case.take_revocation();

        let gate = case.pause_revocation("fallback_snapshot");
        let ((), ()) = tokio::join!(
            case.delivery().check(
                &case.f.state.pool,
                SubscriptionScope::Channel(case.f.organization, case.revoked)
            ),
            async {
                gate.entered().await;
                case.set_role("admin").await;
                case.delivery().drained().await;
                if inactive {
                    // Only the older fallback observes the loss before handoff.
                    sqlx::query("UPDATE users SET deactivated_at=clock_timestamp() WHERE organization_id=$1 AND id=$2")
                        .bind(case.f.organization).bind(case.target).execute(&pool).await.unwrap();
                }
                gate.release();
            }
        );
        let sent = frame
            .handoff(&case.f.state.pool, |event| async { event })
            .await;
        assert_eq!(
            sent,
            (!inactive).then(|| case.revoked()),
            "inactive={inactive}"
        );
    }
}

#[fukulow_test::test]
async fn revocation_query_does_not_buffer_after_session_loss_across_roles(pool: PgPool) {
    for ended in [false, true] {
        let case = Case::new(&pool, false, Later::Role).await;
        let query = case.pause_revocation("revoked");
        case.remove_grant().await;
        query.entered().await;

        case.set_rechecks(MemberRecheck::Skip, None);
        let publisher = case.pause_role_publisher();
        case.set_role("admin").await;
        publisher.entered().await;
        if ended {
            // End the Session in SQL so the revocation query alone observes it.
            sqlx::query("DELETE FROM account_sessions WHERE token_hash=$1")
                .bind(Sha256::digest(case.token.as_bytes()).to_vec())
                .execute(&pool)
                .await
                .unwrap();
        }
        query.release();
        case.delivery().drained_except(1).await;
        let buffered = case.registration.buffered(&case.revoked());
        publisher.release();
        case.delivery().drained().await;
        assert_eq!(buffered, !ended, "ended={ended}");
    }
}

#[fukulow_test::test]
async fn role_commit_seen_before_retirement_requires_fresh_private_proof(pool: PgPool) {
    role_commit_requires_fresh_private_proof(&pool, RoleObserver::Publish).await;
}

#[fukulow_test::test]
async fn role_commit_seen_by_fallback_requires_fresh_private_proof(pool: PgPool) {
    role_commit_requires_fresh_private_proof(&pool, RoleObserver::Fallback).await;
}

#[fukulow_test::test]
async fn role_commit_seen_by_removal_query_requires_fresh_private_proof(pool: PgPool) {
    role_commit_requires_fresh_private_proof(&pool, RoleObserver::RemovalQuery).await;
}

enum RoleObserver {
    Publish,
    Fallback,
    RemovalQuery,
}
async fn role_commit_requires_fresh_private_proof(pool: &PgPool, observer: RoleObserver) {
    let case = Case::new(pool, false, Later::Role).await;
    let removal_query =
        matches!(observer, RoleObserver::RemovalQuery).then(|| case.pause_revocation("revoked"));
    case.remove_grant().await;
    if let Some(gate) = &removal_query {
        gate.entered().await;
    } else {
        case.delivery().drained().await;
    }

    case.set_rechecks(MemberRecheck::Skip, None);
    let retirement = case.hold_retirement(None);
    case.set_role("guest").await;
    retirement.entered().await;
    match observer {
        RoleObserver::Publish => case.publish_channel_list().await,
        RoleObserver::Fallback => {
            case.delivery()
                .check(&case.f.state.pool, SubscriptionScope::All)
                .await;
        }
        RoleObserver::RemovalQuery => removal_query.unwrap().release(),
    }
    case.delivery().drained().await;
    let frame = case.take_revocation();
    let query = case.pause_revocation("handoff_recheck");
    let mut handoff = std::pin::pin!(frame.handoff(&case.f.state.pool, |event| async { event }));
    tokio::select! {
        biased;
        sent = &mut handoff => panic!("completed before fresh proof: {sent:?}"),
        () = query.entered() => {}
    }
    query.release();
    assert_eq!(handoff.await, Some(case.revoked()));

    retirement.release();
    retirement.entered().await;
    case.delivery().drained().await;
    assert_eq!(case.received_revocations(None).await, 0);
}

#[fukulow_test::test]
async fn handoff_rechecks_again_when_a_second_role_change_overtakes_it(pool: PgPool) {
    let case = Case::new(&pool, false, Later::Role).await;
    case.remove_grant().await;
    case.delivery().drained().await;
    let frame = case.take_revocation();

    let member = case.hold_member_recheck();
    let first = case.pause_revocation("handoff_recheck");
    let ((), ()) = tokio::join!(case.set_role("guest"), async {
        member.entered().await;
        let mut handoff =
            std::pin::pin!(frame.handoff(&case.f.state.pool, |event| async { event }));
        tokio::select! {
            biased;
            sent = &mut handoff => panic!("completed before the first proof: {sent:?}"),
            () = first.entered() => {}
        }
        let ((), ()) = tokio::join!(case.set_role("member"), async {
            member.entered().await;
            let latest = case.pause_revocation("handoff_recheck");
            first.release();
            tokio::select! {
                biased;
                sent = &mut handoff => panic!("completed before the latest proof: {sent:?}"),
                () = latest.entered() => {}
            }
            latest.release();
            assert_eq!(handoff.as_mut().await, Some(case.revoked()));
            member.release();
            member.release();
        });
    });
    case.delivery().drained().await;
    assert_eq!(
        case.received_revocations(None).await,
        0,
        "exactly one private revocation"
    );
}

#[fukulow_test::test]
async fn handoff_rechecks_through_role_observation_and_two_retirements(pool: PgPool) {
    let case = Case::new(&pool, false, Later::Role).await;
    case.remove_grant().await;
    case.delivery().drained().await;
    let frame = case.take_revocation();

    case.set_rechecks(MemberRecheck::Skip, None);
    let retirement = case.hold_retirement(None);
    case.set_role("guest").await;
    retirement.entered().await;
    case.publish_channel_list().await;

    let before_retirement = case.pause_revocation("handoff_recheck");
    let mut handoff = std::pin::pin!(frame.handoff(&case.f.state.pool, |event| async { event }));
    tokio::select! {
        biased;
        sent = &mut handoff => panic!("completed before checking the observed Role: {sent:?}"),
        () = before_retirement.entered() => {}
    }

    retirement.release();
    retirement.entered().await;
    case.delivery().drained().await;
    let after_retirement = case.pause_revocation("handoff_recheck");
    before_retirement.release();
    tokio::select! {
        biased;
        sent = &mut handoff => panic!("completed before checking the retired Role: {sent:?}"),
        () = after_retirement.entered() => {}
    }

    let member = case.hold_member_recheck();
    let ((), ()) = tokio::join!(case.set_role("member"), async {
        member.entered().await;
        let latest = case.pause_revocation("handoff_recheck");
        after_retirement.release();
        tokio::select! {
            biased;
            sent = &mut handoff => panic!("completed before checking the second Role: {sent:?}"),
            () = latest.entered() => {}
        }
        latest.release();
        assert_eq!(handoff.as_mut().await, Some(case.revoked()));
        member.release();
    });
    case.delivery().drained().await;
    assert_eq!(
        case.received_revocations(None).await,
        0,
        "exactly one private revocation"
    );
}

#[fukulow_test::test]
async fn role_visibility_gain_retires_an_older_revocation_through_later_loss(pool: PgPool) {
    let case = Case::new(&pool, true, Later::Role).await;
    case.set_role("guest").await;
    case.delivery().drained().await;
    let old = case.take_revocation();

    let gate = case.hold_member_recheck();
    let ((), ()) = tokio::join!(case.set_role("member"), async {
        gate.entered().await;
        let ((), ()) = tokio::join!(case.set_role("guest"), async {
            gate.entered().await;
            gate.release();
            gate.release();
        });
    });
    case.delivery().drained().await;
    let sent = old
        .handoff(&case.f.state.pool, |event| async { event })
        .await;
    assert_eq!(sent, None, "the intervening Role made the Channel visible");
    assert_eq!(
        case.received_revocations(None).await,
        1,
        "the new Role loss"
    );
}

#[fukulow_test::test]
async fn unrelated_channel_retirement_keeps_revocation_identity_proof(pool: PgPool) {
    let mut received = Vec::new();
    for lose_identity_proof in [false, true] {
        let case = Case::new(&pool, false, Later::OtherGrant).await;
        case.remove_grant().await;
        case.delivery().drained().await;
        let frame = case.take_revocation();
        let gate = pause_member(
            case.f.organization,
            Uuid::nil(),
            "target_state",
            Some(case.target),
        );
        case.grant(case.other).await;
        gate.entered().await;
        case.delivery().drained_except(1).await;
        if lose_identity_proof {
            // Bypass the mutation hook so only the recheck can fence this frame.
            sqlx::query("UPDATE users SET deactivated_at=clock_timestamp() WHERE organization_id=$1 AND id=$2")
                .bind(case.f.organization).bind(case.target).execute(&pool).await.unwrap();
            case.delivery()
                .check(
                    &case.f.state.pool,
                    SubscriptionScope::Channel(case.f.organization, case.other),
                )
                .await;
        }
        received.push(case.received_revocations(Some(frame)).await);
        gate.release();
        case.delivery().drained().await;
    }
    assert_eq!(received, [1, 0], "live identity then lost Membership");
}

#[fukulow_test::test]
async fn subscription_refresh_membership_loss_fences_a_dequeued_revocation(pool: PgPool) {
    let mut received = Vec::new();
    for inactive in [false, true] {
        let case = Case::new(&pool, false, Later::OtherGrant).await;
        let access = &case.f.state.message_delivery.channel_access;
        let watch = access
            .subscribe(
                &case.f.state.pool,
                case.f.organization,
                (case.target, 0),
                case.f.channel,
            )
            .await
            .unwrap()
            .unwrap();
        case.remove_grant().await;
        case.delivery().drained().await;
        let frame = case.take_revocation();
        case.grant(case.other).await;
        case.delivery().drained().await;
        case.delivery()
            .check(&case.f.state.pool, SubscriptionScope::All)
            .await;
        if inactive {
            // Membership loss happens after the Activity check but before the subscription read.
            sqlx::query("UPDATE users SET deactivated_at=clock_timestamp() WHERE organization_id=$1 AND id=$2")
                .bind(case.f.organization).bind(case.target).execute(&pool).await.unwrap();
        }
        watch.refresh(&case.f.state.pool).await.unwrap();
        assert_eq!(watch.status(), if inactive { 3 } else { 0 });
        received.push(case.received_revocations(Some(frame)).await);
    }
    assert_eq!(received, [1, 0], "current Membership then observed loss");
}

#[fukulow_test::test]
async fn fallback_regrant_fences_a_dequeued_revocation_before_first_poll(pool: PgPool) {
    let case = Case::new(&pool, false, Later::Regrant).await;
    case.remove_grant().await;
    case.delivery().drained().await;
    let frame = case.take_revocation();

    // Re-grant in PostgreSQL with no mutation hook or subscription recheck.
    grant(&pool, &case.f, case.revoked, case.target).await;
    case.delivery()
        .check(&case.f.state.pool, SubscriptionScope::All)
        .await;

    let mut polled = false;
    let sent = frame
        .handoff(&case.f.state.pool, |_| async { polled = true })
        .await;
    assert!(
        !polled,
        "fallback allowed the old revocation's first write poll"
    );
    assert_eq!(sent, None);
}

#[fukulow_test::test]
async fn rechecks_preserve_an_unproved_current_revocation(pool: PgPool) {
    let mut received = Vec::new();
    for periodic in [false, true] {
        let case = Case::new(&pool, false, Later::OtherGrant).await;
        let gate = pause_member(
            case.f.organization,
            case.revoked,
            "revoked",
            Some(case.target),
        );
        case.remove_grant().await;
        gate.entered().await;
        if periodic {
            case.delivery()
                .check(&case.f.state.pool, SubscriptionScope::All)
                .await;
        } else {
            let (other, _) = member(&pool, case.f.organization).await;
            case.request(
                "POST",
                &format!("/api/v1/channels/{}/members", case.revoked),
                json!({"member_id":other}),
                StatusCode::NO_CONTENT,
            )
            .await;
        }
        gate.release();
        case.delivery().drained().await;
        received.push(case.received_revocations(None).await);
    }
    assert_eq!(
        received,
        [1, 1],
        "another Member's grant, then periodic recheck"
    );
}

#[fukulow_test::test]
async fn visibility_preserving_role_change_uses_one_capture_per_registration(pool: PgPool) {
    let case = Case::new(&pool, true, Later::OtherGrant).await;
    sqlx::query("INSERT INTO channels(organization_id,id,name,visibility) SELECT $1,gen_random_uuid(),'Channel '||n,'public' FROM generate_series(1,1024) n")
        .bind(case.f.organization).execute(&pool).await.unwrap();
    let token = session::another_session(&pool, case.f.organization, case.target).await;
    let auth = extract_auth(case.f.state.clone(), &token).await;
    let more: Vec<_> = (0..3).map(|_| case.delivery().register(&auth)).collect();
    let registrations: Vec<_> = std::iter::once(&case.registration).chain(&more).collect();
    let gate = pause_member(
        case.f.organization,
        Uuid::nil(),
        "target_state",
        Some(case.target),
    );
    case.set_role("admin").await;
    gate.entered().await;
    let during: Vec<_> = registrations
        .iter()
        .map(|reg| reg.revocation_tracking())
        .collect();
    gate.release();
    case.delivery().drained().await;
    let idle: Vec<_> = registrations
        .iter()
        .map(|reg| reg.revocation_tracking())
        .collect();
    assert_eq!(
        during,
        [(1, 0); 4],
        "whole-set captures and Channel change entries during publication"
    );
    assert_eq!(
        idle,
        [(0, 0); 4],
        "idle registrations kept revocation tracking"
    );
}

impl Case {
    fn hold_retirement(&self, channel: Option<Uuid>) -> Arc<Gate> {
        let gate = Arc::new(Gate::default());
        let hold = Mutex::new(Some(gate.clone()));
        self.f
            .state
            .session_changes
            .set_activity(Arc::new(Decorator {
                inner: self.delivery().clone(),
                hooks: ActivityHooks {
                    after_capture: Some(Box::new(move |scope| {
                        let captured_channel = match scope {
                            ChangeScope::Channel(channel) => Some(channel),
                            _ => None,
                        };
                        if captured_channel != channel {
                            return None;
                        }
                        let gate = hold.lock().unwrap().take()?;
                        Some(ChangeHooks {
                            skip_retire: true,
                            commit: Box::new(move |change, pool| {
                                tokio::spawn(async move {
                                    gate.pause().await;
                                    change.committed(pool);
                                    gate.signal_entered();
                                });
                            }),
                        })
                    })),
                    ..ActivityHooks::default()
                },
            }));
        gate
    }

    async fn finish_late_retirement(&self, gate: Arc<Gate>) -> usize {
        self.delivery().drained().await;
        let frame = self.take_revocation();
        gate.release();
        gate.entered().await;
        self.delivery().drained().await;
        self.received_revocations(Some(frame)).await
    }
}

#[fukulow_test::test]
async fn role_and_channel_revocations_survive_older_retirements(pool: PgPool) {
    let role_loss = Case::new(&pool, true, Later::OtherGrant).await;
    // The old Channel removal leaves public access intact. The later Role
    // change sees that public access and becomes the transition that removes it.
    grant(&pool, &role_loss.f, role_loss.revoked, role_loss.target).await;
    let old_channel = role_loss.hold_retirement(Some(role_loss.revoked));
    role_loss.remove_grant().await;
    old_channel.entered().await;
    role_loss.set_role("guest").await;
    let role_revocation = role_loss.finish_late_retirement(old_channel).await;

    let channel_loss = Case::new(&pool, false, Later::OtherGrant).await;
    let old_role = channel_loss.hold_retirement(None);
    channel_loss.set_role("admin").await;
    old_role.entered().await;
    channel_loss.remove_grant().await;
    let channel_revocation = channel_loss.finish_late_retirement(old_role).await;
    assert_eq!(
        [role_revocation, channel_revocation],
        [1, 1],
        "old Channel retirement, then old Role retirement"
    );
}

#[fukulow_test::test]
async fn late_regrant_retirement_preserves_a_newer_revocation(pool: PgPool) {
    let case = Case::new(&pool, false, Later::Regrant).await;
    case.remove_grant().await;
    case.delivery().drained().await;
    assert_eq!(case.received_revocations(None).await, 1);
    let regrant = case.hold_retirement(Some(case.revoked));
    case.grant(case.revoked).await;
    regrant.entered().await;
    case.remove_grant().await;
    assert_eq!(
        case.finish_late_retirement(regrant).await,
        1,
        "late re-grant retirement dropped the later removal's revocation"
    );
}
