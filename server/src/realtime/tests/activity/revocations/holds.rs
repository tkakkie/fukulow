use super::{
    Case, Duration, Later, MemberRecheck, Notice, PgPool, SubscriptionScope, closed_pool, grant,
};
use crate::observability::RevocationMetric;

#[fukulow_test::test]
async fn fallback_failure_holds_revocations(pool: PgPool) {
    let case = Case::new(&pool, false, Later::Role).await;
    let metrics = case.registration.isolate_revocation_metrics();
    case.remove_grant().await;
    case.delivery().drained().await;
    let private = case.take_revocation();
    case.set_role("guest").await;
    case.delivery().drained().await;
    let public = Notice::ChannelAccessRevoked {
        channel_id: case.f.channel,
    };
    assert!(case.registration.buffered(&public));
    case.delivery().retire(case.f.organization, case.target);

    let closed = closed_pool(&case.f.state.pool).await;
    let gate = case.pause_revocation("fallback_snapshot");
    let ((), ()) = tokio::join!(
        case.delivery().check(
            &closed,
            SubscriptionScope::Channel(case.f.organization, case.revoked)
        ),
        async {
            gate.entered().await;
            // The fallback captured only revocation checks. It must also
            // retire ordinary notices buffered after that snapshot.
            case.publish_channel_list().await;
            assert!(case.registration.buffered(&Notice::ChannelListChanged));
            tokio::time::pause();
            gate.release();
        }
    );
    assert_eq!(
        private
            .handoff(&case.f.state.pool, |_| async {
                panic!("fallback error polled the dequeued private write")
            })
            .await,
        None::<()>
    );
    assert!(!case.registration.buffered(&Notice::ChannelListChanged));
    let queued = case
        .next()
        .expect("fallback discarded the buffered public revocation");
    assert_eq!(queued.event, public);
    assert_eq!(
        queued
            .handoff(&case.f.state.pool, |_| async {
                panic!("fallback error polled the buffered public write")
            })
            .await,
        None::<()>
    );
    assert!(case.next().is_none());
    assert_eq!(metrics.load(RevocationMetric::Held), 2);
    assert_eq!(metrics.load(RevocationMetric::RecheckError), 1);
    tokio::time::advance(Duration::from_millis(250)).await;
    tokio::time::resume();

    let retry = case
        .next()
        .expect("fallback discarded the dequeued private revocation");
    assert_eq!(retry.event, case.revoked());
    let query = case.pause_revocation("handoff_recheck");
    let (sent, ()) = tokio::join!(
        retry.handoff(&case.f.state.pool, |event| async { event }),
        async {
            query.entered().await;
            query.release();
        }
    );
    assert_eq!(sent, Some(case.revoked()));
    let retry = case.next().expect("public revocation was not retried");
    assert_eq!(
        retry
            .handoff(&case.f.state.pool, |event| async { event })
            .await,
        Some(public)
    );
    assert!(case.next().is_none());
    assert_eq!(metrics.load(RevocationMetric::Delivered), 2);
}

#[fukulow_test::test]
async fn handoff_failure_holds_only_its_frame(pool: PgPool) {
    for verify_public_first in [false, true] {
        let case = Case::new(&pool, false, Later::Role).await;
        let metrics = case.registration.isolate_revocation_metrics();
        case.remove_grant().await;
        case.delivery().drained().await;
        let frame = case.take_revocation();
        let public = Notice::ChannelAccessRevoked {
            channel_id: case.f.channel,
        };
        if verify_public_first {
            case.set_rechecks(MemberRecheck::Skip, None);
            case.set_role("guest").await;
            case.delivery().drained().await;
            assert!(case.registration.buffered(&public));
        }

        let gate = case.hold_member_recheck();
        let ((), ()) = tokio::join!(case.set_role("guest"), async {
            gate.entered().await;
            case.publish_channel_list().await;
            assert!(case.registration.buffered(&Notice::ChannelListChanged));
            let closed = closed_pool(&case.f.state.pool).await;
            let query = case.pause_revocation("handoff_recheck");
            let mut handoff = std::pin::pin!(frame.handoff(&closed, |_| async {
                panic!("a failed handoff recheck polled the private revocation write")
            }));
            tokio::select! {
                biased;
                sent = &mut handoff => panic!("completed before querying the closed pool: {sent:?}"),
                () = query.entered() => {}
            }
            query.release();
            assert_eq!(handoff.await, None::<()>);
            assert!(
                case.registration.buffered(&Notice::ChannelListChanged),
                "handoff failure discarded an independent ordinary notice"
            );
            if verify_public_first {
                assert!(
                    case.registration.buffered(&public),
                    "handoff failure fenced a verified public revocation"
                );
            }
            assert_eq!(metrics.load(RevocationMetric::Held), 1);
            tokio::time::pause();
            tokio::time::advance(Duration::from_millis(250)).await;
            tokio::time::resume();
            let retry = case.next().expect("handoff error discarded its frame");
            assert_eq!(retry.event, case.revoked());
            let query = case.pause_revocation("handoff_recheck");
            let (sent, ()) = tokio::join!(
                retry.handoff(&case.f.state.pool, |event| async { event }),
                async {
                    query.entered().await;
                    query.release();
                }
            );
            assert_eq!(sent, Some(case.revoked()));
            assert_eq!(metrics.load(RevocationMetric::Delivered), 1);
            gate.release();
        });
        case.delivery().drained().await;
        let mut received = Vec::new();
        while let Some(frame) = case.next() {
            let sent = frame
                .handoff(&case.f.state.pool, |event| async { event })
                .await;
            assert_ne!(sent, Some(Notice::ActivityReset));
            received.extend(sent);
        }
        assert_eq!(
            received.iter().filter(|notice| **notice == public).count(),
            1
        );
        assert!(!received.contains(&case.revoked()));
        assert!(case.next().is_none());
    }
}

#[fukulow_test::test]
async fn initial_handoff_deadline_parks_a_concurrent_fallback_hold(pool: PgPool) {
    let case = Case::new(&pool, false, Later::Role).await;
    let metrics = case.registration.isolate_revocation_metrics();
    case.remove_grant().await;
    case.delivery().drained().await;
    let closed = closed_pool(&case.f.state.pool).await;
    let member = case.hold_member_recheck();
    let ((), ()) = tokio::join!(case.set_role("guest"), async {
        member.entered().await;
        let query = case.pause_revocation("handoff_recheck");
        tokio::time::pause();
        let frame = case.take_revocation();
        {
            let mut handoff =
                std::pin::pin!(frame.handoff(&case.f.state.pool, |event| async { event }));
            tokio::select! {
                biased;
                sent = &mut handoff => panic!("initial handoff completed before the query: {sent:?}"),
                () = query.entered() => {}
            }
            tokio::time::advance(Duration::from_secs(4)).await;
            case.delivery()
                .check(
                    &closed,
                    SubscriptionScope::Channel(case.f.organization, case.revoked),
                )
                .await;
            assert_eq!(metrics.load(RevocationMetric::Held), 1);
            tokio::time::advance(Duration::from_secs(1)).await;
            assert_eq!(handoff.await, None);
        }
        drop(frame);
        let retry = case
            .next()
            .expect("initial handoff deadline lost the fallback hold's frame");
        assert_eq!(retry.event, case.revoked());
        assert_eq!(metrics.load(RevocationMetric::RecheckError), 1);
        tokio::time::resume();
        assert_eq!(
            retry
                .handoff(&case.f.state.pool, |event| async { event })
                .await,
            Some(case.revoked())
        );
        assert_eq!(metrics.load(RevocationMetric::Delivered), 1);
        member.release();
    });
    case.delivery().drained().await;
}

#[fukulow_test::test]
async fn successful_fallback_leaves_held_revocation_unverified(pool: PgPool) {
    let case = Case::new(&pool, false, Later::Regrant).await;
    let metrics = case.registration.isolate_revocation_metrics();
    case.remove_grant().await;
    case.delivery().drained().await;
    let frame = case.take_revocation();
    let closed = closed_pool(&case.f.state.pool).await;
    let scope = SubscriptionScope::Channel(case.f.organization, case.revoked);

    tokio::time::pause();
    case.delivery().check(&closed, scope).await;
    assert_eq!(
        frame
            .handoff(&case.f.state.pool, |event| async { event })
            .await,
        None
    );
    assert_eq!(metrics.load(RevocationMetric::Held), 1);
    assert_eq!(metrics.load(RevocationMetric::RecheckError), 1);
    tokio::time::advance(Duration::from_millis(250)).await;
    tokio::time::resume();
    drop(frame);

    let fallback = case.pause_revocation("fallback_snapshot");
    let ((), ()) = tokio::join!(case.delivery().check(&case.f.state.pool, scope), async {
        fallback.entered().await;
        fallback.release();
    });
    assert_eq!(metrics.load(RevocationMetric::RecheckError), 1);
    // Restore access without the mutation hook, after fallback observed absence.
    grant(&pool, &case.f, case.revoked, case.target).await;

    let retry = case.next().expect("fallback discarded the held revocation");
    assert_eq!(retry.event, case.revoked());
    let query = case.pause_revocation("handoff_recheck");
    let mut handoff = std::pin::pin!(retry.handoff(&case.f.state.pool, |event| async { event }));
    tokio::select! {
        biased;
        sent = &mut handoff => panic!("scheduled retry skipped its authorization query: {sent:?}"),
        () = query.entered() => {}
    }
    query.release();
    assert_eq!(handoff.await, None, "restored access polled the held write");
    assert!(case.next().is_none());
    assert_eq!(metrics.load(RevocationMetric::Fenced), 1);
    assert_eq!(metrics.load(RevocationMetric::Delivered), 0);
}

#[fukulow_test::test]
async fn restored_access_fences_held_revocation(pool: PgPool) {
    let case = Case::new(&pool, false, Later::Regrant).await;
    let metrics = case.registration.isolate_revocation_metrics();
    case.remove_grant().await;
    case.delivery().drained().await;
    let frame = case.take_revocation();
    case.set_rechecks(MemberRecheck::Skip, None);
    case.set_role("guest").await;
    case.delivery().drained().await;
    let closed = closed_pool(&case.f.state.pool).await;
    tokio::time::pause();
    assert_eq!(
        frame
            .handoff(&closed, |_| async {
                panic!("a failed recheck polled the write")
            })
            .await,
        None::<()>
    );
    // Drain the independent Role notices before advancing to the retry.
    while let Some(frame) = case.next() {
        assert_ne!(frame.event, case.revoked());
    }
    tokio::time::advance(Duration::from_millis(250)).await;
    tokio::time::resume();
    let retry = case.next().expect("the hold did not reach its retry");
    let query = case.pause_revocation("handoff_recheck");
    let (sent, ()) = tokio::join!(
        retry.handoff(&case.f.state.pool, |_| async {
            panic!("a retry with restored access polled the write")
        }),
        async {
            query.entered().await;
            // Restore access without the normal retirement and publication hooks.
            grant(&pool, &case.f, case.revoked, case.target).await;
            query.release();
        }
    );
    assert_eq!(sent, None::<()>);
    assert!(case.next().is_none());
    assert_eq!(metrics.load(RevocationMetric::Fenced), 1);
    assert_eq!(metrics.load(RevocationMetric::Delivered), 0);
}
