use super::*;
use crate::{
    auth::{
        SubscriptionRecheck, SubscriptionScope,
        activity::{ActivityChange, ActivityChanges, Capture, ChangeScope, ChannelChange},
    },
    channels::{
        AccessChanges,
        activity::{Activity, Notice, NoticeFrame, Registration, TestGate, pause_member},
        tests::extract_auth,
    },
    observability::RevocationMetric,
};
use futures_util::FutureExt;
use std::{future::Future, pin::Pin, sync::Arc};
use tokio::sync::Semaphore;

#[derive(Clone, Copy, Debug)]
enum Stage {
    Selection,
    Query,
    Authorized,
    Buffered,
    FirstHandoff,
}
const STAGES: [Stage; 5] = [
    Stage::Selection,
    Stage::Query,
    Stage::Authorized,
    Stage::Buffered,
    Stage::FirstHandoff,
];

#[derive(Clone, Copy, Debug)]
enum Later {
    OtherGrant,
    OtherManager,
    OtherMember,
    Regrant,
    Role,
    Deactivate,
}

struct Case {
    f: Fixture,
    target: Uuid,
    token: String,
    registration: Registration,
    revoked: Uuid,
    other: Uuid,
}
impl Case {
    async fn new(pool: &PgPool, whole_set: bool, later: Later) -> Self {
        let f = fixture(pool).await;
        owner(pool, &f).await;
        let (target, token) = member(pool, f.organization).await;
        let revoked = if whole_set {
            f.channel
        } else {
            let private = channel(pool, f.organization, f.member, true).await;
            grant(pool, &f, private, target).await;
            private
        };
        let other = channel(pool, f.organization, f.member, true).await;
        if matches!(later, Later::OtherManager) {
            grant(pool, &f, other, target).await;
        }
        let auth = extract_auth(f.state.clone(), &token).await;
        let registration = f
            .state
            .message_delivery
            .channel_access
            .activity
            .register(&auth);
        Self {
            f,
            target,
            token,
            registration,
            revoked,
            other,
        }
    }
    fn delivery(&self) -> &Activity {
        &self.f.state.message_delivery.channel_access.activity
    }
    fn revoked(&self) -> Notice {
        Notice::ChannelAccessRevoked {
            channel_id: self.revoked,
        }
    }
    fn pause_revocation(&self, phase: &'static str) -> Arc<TestGate> {
        pause_member(self.f.organization, self.revoked, phase, Some(self.target))
    }
    fn pause_role_publisher(&self) -> Arc<TestGate> {
        pause_member(
            self.f.organization,
            Uuid::nil(),
            "target_state",
            Some(self.target),
        )
    }
    async fn publish_channel_list(&self) {
        self.delivery()
            .publish(
                &self.f.state.pool,
                self.f.organization,
                Notice::ChannelListChanged,
                Some(self.target),
                None,
            )
            .await
            .unwrap();
    }
    async fn remove_grant(&self) {
        self.request(
            "DELETE",
            &format!("/api/v1/channels/{}/members/{}", self.revoked, self.target),
            Value::Null,
            StatusCode::NO_CONTENT,
        )
        .await;
    }
    async fn set_role(&self, role: &str) {
        self.request(
            "PATCH",
            &format!(
                "/api/v1/orgs/{}/members/{}/role",
                self.f.organization, self.target
            ),
            json!({"role":role}),
            StatusCode::OK,
        )
        .await;
    }
    async fn grant(&self, channel: Uuid) {
        self.request(
            "POST",
            &format!("/api/v1/channels/{channel}/members"),
            json!({"member_id":self.target}),
            StatusCode::NO_CONTENT,
        )
        .await;
    }
    async fn later(&self, pool: &PgPool, later: Later, whole_set: bool) {
        match later {
            Later::OtherGrant => self.grant(self.other).await,
            Later::OtherManager => {
                self.request(
                    "PATCH",
                    &format!("/api/v1/channels/{}/members/{}", self.other, self.target),
                    json!({"manager":true}),
                    StatusCode::NO_CONTENT,
                )
                .await
            }
            Later::OtherMember => {
                let (other, _) = member(pool, self.f.organization).await;
                self.request(
                    "POST",
                    &format!("/api/v1/channels/{}/members", self.revoked),
                    json!({"member_id":other}),
                    StatusCode::NO_CONTENT,
                )
                .await;
            }
            Later::Regrant => self.grant(self.revoked).await,
            Later::Role => {
                self.set_role(if whole_set { "member" } else { "guest" })
                    .await
            }
            Later::Deactivate => {
                self.request(
                    "POST",
                    &format!(
                        "/api/v1/orgs/{}/members/{}/deactivate",
                        self.f.organization, self.target
                    ),
                    Value::Null,
                    StatusCode::NO_CONTENT,
                )
                .await
            }
        }
    }
    async fn request(&self, method: &str, path: &str, body: Value, expected: StatusCode) {
        let response = request(&self.f.app, method, path, &self.f.token, body).await;
        assert_eq!(response.status(), expected, "{method} {path}");
    }
    fn next(&self) -> Option<NoticeFrame> {
        // With counted publishers drained, next is ready exactly while there is buffered work.
        self.registration.next().now_or_never().flatten()
    }
    fn take_revocation(&self) -> NoticeFrame {
        while let Some(frame) = self.next() {
            if frame.event == self.revoked() {
                return frame;
            }
        }
        panic!("expected a revocation ready for first handoff");
    }
    async fn received_revocations(&self, held: Option<NoticeFrame>) -> usize {
        let mut count = 0;
        let mut frame = held.or_else(|| self.next());
        while let Some(next) = frame {
            count += usize::from(
                next.handoff(&self.f.state.pool, |event| async { event })
                    .await
                    == Some(self.revoked()),
            );
            frame = self.next();
        }
        count
    }
}

async fn wait(gate: &TestGate) {
    tokio::time::timeout(Duration::from_secs(5), gate.entered.acquire())
        .await
        .expect("the requested boundary was not reached")
        .unwrap()
        .forget();
}

async fn transition_matrix(pool: &PgPool, whole_set: bool, changes: &[Later]) {
    let mut failures = Vec::new();
    for stage in STAGES {
        for &later in changes {
            let case = Case::new(pool, whole_set, later).await;
            let phase = match stage {
                Stage::Selection => Some("revocation"),
                Stage::Query => Some("revoked"),
                Stage::Authorized => Some("revocation_authorized"),
                Stage::Buffered | Stage::FirstHandoff => None,
            };
            let gate = phase.map(|phase| {
                pause_member(case.f.organization, case.revoked, phase, Some(case.target))
            });
            // A Guest cannot receive a manager right. Commit B's real manager
            // change while the target is still a Member, then delay its retirement
            // until the Role revocation reaches the selected stage.
            let old_manager = if whole_set && matches!(later, Later::OtherManager) {
                let retirement = case.hold_retirement(Some(case.other));
                case.later(pool, later, false).await;
                wait(&retirement).await;
                Some(retirement)
            } else {
                None
            };
            if whole_set {
                case.set_role("guest").await;
            } else {
                case.remove_grant().await;
            }
            let mut held = None;
            if let Some(gate) = &gate {
                wait(gate).await;
            } else {
                case.delivery().drained().await;
                assert!(
                    case.registration.buffered(&case.revoked()),
                    "{stage:?}: revocation was never buffered"
                );
                if matches!(stage, Stage::FirstHandoff) {
                    held = Some(case.take_revocation());
                }
            }
            // Hold the later publisher so an access gain cannot replace a stale revocation.
            let later_gate = if let Some(manager) = old_manager {
                manager.release.add_permits(1);
                wait(&manager).await;
                None
            } else if matches!(later, Later::OtherMember) {
                case.later(pool, later, whole_set).await;
                None
            } else {
                let gate = pause_member(
                    case.f.organization,
                    Uuid::nil(),
                    "target_state",
                    Some(case.target),
                );
                case.later(pool, later, whole_set).await;
                wait(&gate).await;
                Some(gate)
            };
            if let Some(gate) = &gate {
                gate.release.add_permits(1);
            }
            case.delivery()
                .drained_except(u32::from(later_gate.is_some()))
                .await;
            let actual = case.received_revocations(held).await;
            if let Some(later_gate) = &later_gate {
                later_gate.release.add_permits(1);
                case.delivery().drained().await;
            }
            let expected = usize::from(
                matches!(
                    later,
                    Later::OtherGrant | Later::OtherManager | Later::OtherMember
                ) || (!whole_set && matches!(later, Later::Role)),
            );
            if actual != expected {
                failures.push((stage, later, actual, expected));
            }
        }
    }
    assert!(
        failures.is_empty(),
        "revocations (stage, later transition, actual, expected): {failures:?}"
    );
}

#[fukulow_test::test]
async fn channel_revocation_survives_only_unrelated_transitions(pool: PgPool) {
    transition_matrix(
        &pool,
        false,
        &[
            Later::OtherGrant,
            Later::OtherManager,
            Later::OtherMember,
            Later::Regrant,
            Later::Role,
            Later::Deactivate,
        ],
    )
    .await;
}

enum MemberRecheck {
    Run,
    Hold(Arc<TestGate>),
    Skip,
}
struct TestRechecks {
    access: AccessChanges,
    member: (Uuid, Uuid),
    member_recheck: MemberRecheck,
    skip_channel: Option<Uuid>,
}
impl SubscriptionRecheck for TestRechecks {
    fn check<'a>(
        &'a self,
        pool: &'a PgPool,
        scope: SubscriptionScope,
    ) -> Pin<Box<dyn Future<Output = Result<(), sqlx::Error>> + Send + 'a>> {
        Box::pin(async move {
            if matches!(scope, SubscriptionScope::Channel(org, channel)
                if org == self.member.0 && self.skip_channel == Some(channel))
            {
                return Ok(());
            }
            if matches!(scope, SubscriptionScope::Member(org, member) if (org, member) == self.member)
            {
                match &self.member_recheck {
                    MemberRecheck::Run => {}
                    MemberRecheck::Hold(gate) => {
                        gate.entered.add_permits(1);
                        gate.release.acquire().await.unwrap().forget();
                    }
                    MemberRecheck::Skip => return Ok(()),
                }
            }
            self.access.check(pool, scope).await
        })
    }
    fn failed(&self, scope: SubscriptionScope) {
        self.access.failed(scope);
    }
}
impl Case {
    fn hold_member_recheck(&self) -> Arc<TestGate> {
        let gate = Arc::new(TestGate {
            entered: Semaphore::new(0),
            release: Semaphore::new(0),
        });
        self.set_rechecks(MemberRecheck::Hold(gate.clone()), None);
        gate
    }

    fn set_rechecks(&self, member_recheck: MemberRecheck, skip_channel: Option<Uuid>) {
        self.f
            .state
            .session_changes
            .set_subscription_recheck(Arc::new(TestRechecks {
                access: self.f.state.message_delivery.channel_access.clone(),
                member: (self.f.organization, self.target),
                member_recheck,
                skip_channel,
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
        wait(&gate).await;
        case.grant(case.other).await;
        case.delivery().drained().await;
        gate.release.add_permits(1);
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
        wait(&gate).await;
        let received = case.received_revocations(Some(frame)).await;
        gate.release.add_permits(1);
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
            wait(&role).await;
            if restored {
                // Commit the grant without retirement, subscription recheck or publication.
                grant(&pool, &case.f, case.revoked, case.target).await;
            }
            role.release.add_permits(1);
        });
        wait(&publisher).await;
        let closed = closed_pool(&case.f.state.pool).await;
        // A handoff query would make this poll pending, even with a closed pool.
        case.pause_revocation("handoff_recheck");
        let sent = frame
            .handoff(&closed, |event| async { event })
            .now_or_never();
        publisher.release.add_permits(1);
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
        wait(&regrant).await;
        let removal = case.hold_retirement(Some(case.revoked));
        case.remove_grant().await;
        wait(&removal).await;
        case.set_role("guest").await;
        case.delivery().drained().await;

        // The grant's sequence is after the first removal and before both the
        // second removal and the Role that just verified the original frame.
        if retire_before_handoff {
            regrant.release.add_permits(1);
            wait(&regrant).await;
        }
        if old
            .handoff(&case.f.state.pool, |event| async { event })
            .await
            == Some(case.revoked())
        {
            writes.push(retire_before_handoff);
        }
        if !retire_before_handoff {
            regrant.release.add_permits(1);
            wait(&regrant).await;
        }
        removal.release.add_permits(1);
        wait(&removal).await;
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
                wait(&gate).await;
                case.set_role("guest").await;
                case.delivery().drained().await;
                // The Role recheck verified absence. Only the older fallback
                // observes the grant before handoff.
                if restored {
                    grant(&pool, &case.f, case.revoked, case.target).await;
                }
                gate.release.add_permits(1);
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
                wait(&gate).await;
                case.set_role("admin").await;
                case.delivery().drained().await;
                if inactive {
                    // Only the older fallback observes the loss before handoff.
                    sqlx::query("UPDATE users SET deactivated_at=clock_timestamp() WHERE organization_id=$1 AND id=$2")
                        .bind(case.f.organization).bind(case.target).execute(&pool).await.unwrap();
                }
                gate.release.add_permits(1);
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
        wait(&query).await;

        case.set_rechecks(MemberRecheck::Skip, None);
        let publisher = case.pause_role_publisher();
        case.set_role("admin").await;
        wait(&publisher).await;
        if ended {
            // End the Session in SQL so the revocation query alone observes it.
            sqlx::query("DELETE FROM account_sessions WHERE token_hash=$1")
                .bind(Sha256::digest(case.token.as_bytes()).to_vec())
                .execute(&pool)
                .await
                .unwrap();
        }
        query.release.add_permits(1);
        case.delivery().drained_except(1).await;
        let buffered = case.registration.buffered(&case.revoked());
        publisher.release.add_permits(1);
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
        wait(gate).await;
    } else {
        case.delivery().drained().await;
    }

    case.set_rechecks(MemberRecheck::Skip, None);
    let retirement = case.hold_retirement(None);
    case.set_role("guest").await;
    wait(&retirement).await;
    match observer {
        RoleObserver::Publish => case.publish_channel_list().await,
        RoleObserver::Fallback => {
            case.delivery()
                .check(&case.f.state.pool, SubscriptionScope::All)
                .await;
        }
        RoleObserver::RemovalQuery => removal_query.unwrap().release.add_permits(1),
    }
    case.delivery().drained().await;
    let frame = case.take_revocation();
    let query = case.pause_revocation("handoff_recheck");
    let mut handoff = std::pin::pin!(frame.handoff(&case.f.state.pool, |event| async { event }));
    tokio::select! {
        biased;
        sent = &mut handoff => panic!("completed before fresh proof: {sent:?}"),
        () = wait(&query) => {}
    }
    query.release.add_permits(1);
    assert_eq!(handoff.await, Some(case.revoked()));

    retirement.release.add_permits(1);
    wait(&retirement).await;
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
        wait(&member).await;
        let mut handoff =
            std::pin::pin!(frame.handoff(&case.f.state.pool, |event| async { event }));
        tokio::select! {
            biased;
            sent = &mut handoff => panic!("completed before the first proof: {sent:?}"),
            () = wait(&first) => {}
        }
        let ((), ()) = tokio::join!(case.set_role("member"), async {
            wait(&member).await;
            let latest = case.pause_revocation("handoff_recheck");
            first.release.add_permits(1);
            tokio::select! {
                biased;
                sent = &mut handoff => panic!("completed before the latest proof: {sent:?}"),
                () = wait(&latest) => {}
            }
            latest.release.add_permits(1);
            assert_eq!(handoff.as_mut().await, Some(case.revoked()));
            member.release.add_permits(2);
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
    wait(&retirement).await;
    case.publish_channel_list().await;

    let before_retirement = case.pause_revocation("handoff_recheck");
    let mut handoff = std::pin::pin!(frame.handoff(&case.f.state.pool, |event| async { event }));
    tokio::select! {
        biased;
        sent = &mut handoff => panic!("completed before checking the observed Role: {sent:?}"),
        () = wait(&before_retirement) => {}
    }

    retirement.release.add_permits(1);
    wait(&retirement).await;
    case.delivery().drained().await;
    let after_retirement = case.pause_revocation("handoff_recheck");
    before_retirement.release.add_permits(1);
    tokio::select! {
        biased;
        sent = &mut handoff => panic!("completed before checking the retired Role: {sent:?}"),
        () = wait(&after_retirement) => {}
    }

    let member = case.hold_member_recheck();
    let ((), ()) = tokio::join!(case.set_role("member"), async {
        wait(&member).await;
        let latest = case.pause_revocation("handoff_recheck");
        after_retirement.release.add_permits(1);
        tokio::select! {
            biased;
            sent = &mut handoff => panic!("completed before checking the second Role: {sent:?}"),
            () = wait(&latest) => {}
        }
        latest.release.add_permits(1);
        assert_eq!(handoff.as_mut().await, Some(case.revoked()));
        member.release.add_permits(1);
    });
    case.delivery().drained().await;
    assert_eq!(
        case.received_revocations(None).await,
        0,
        "exactly one private revocation"
    );
}

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
            wait(&gate).await;
            // The fallback captured only revocation checks. It must also
            // retire ordinary notices buffered after that snapshot.
            case.publish_channel_list().await;
            assert!(case.registration.buffered(&Notice::ChannelListChanged));
            tokio::time::pause();
            gate.release.add_permits(1);
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
            wait(&query).await;
            query.release.add_permits(1);
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
            wait(&gate).await;
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
                () = wait(&query) => {}
            }
            query.release.add_permits(1);
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
                    wait(&query).await;
                    query.release.add_permits(1);
                }
            );
            assert_eq!(sent, Some(case.revoked()));
            assert_eq!(metrics.load(RevocationMetric::Delivered), 1);
            gate.release.add_permits(1);
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
        wait(&member).await;
        let query = case.pause_revocation("handoff_recheck");
        tokio::time::pause();
        let frame = case.take_revocation();
        {
            let mut handoff =
                std::pin::pin!(frame.handoff(&case.f.state.pool, |event| async { event }));
            tokio::select! {
                biased;
                sent = &mut handoff => panic!("initial handoff completed before the query: {sent:?}"),
                () = wait(&query) => {}
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
        member.release.add_permits(1);
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
        wait(&fallback).await;
        fallback.release.add_permits(1);
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
        () = wait(&query) => {}
    }
    query.release.add_permits(1);
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
            wait(&query).await;
            // Restore access without the normal retirement and publication hooks.
            grant(&pool, &case.f, case.revoked, case.target).await;
            query.release.add_permits(1);
        }
    );
    assert_eq!(sent, None::<()>);
    assert!(case.next().is_none());
    assert_eq!(metrics.load(RevocationMetric::Fenced), 1);
    assert_eq!(metrics.load(RevocationMetric::Delivered), 0);
}

#[fukulow_test::test]
async fn role_visibility_gain_retires_an_older_revocation_through_later_loss(pool: PgPool) {
    let case = Case::new(&pool, true, Later::Role).await;
    case.set_role("guest").await;
    case.delivery().drained().await;
    let old = case.take_revocation();

    let gate = case.hold_member_recheck();
    let ((), ()) = tokio::join!(case.set_role("member"), async {
        wait(&gate).await;
        let ((), ()) = tokio::join!(case.set_role("guest"), async {
            wait(&gate).await;
            gate.release.add_permits(2);
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
async fn role_revocation_survives_only_unrelated_transitions(pool: PgPool) {
    transition_matrix(
        &pool,
        true,
        &[
            Later::OtherGrant,
            Later::OtherManager,
            Later::Regrant,
            Later::Role,
            Later::Deactivate,
        ],
    )
    .await;
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
        wait(&gate).await;
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
        gate.release.add_permits(1);
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
        wait(&gate).await;
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
        gate.release.add_permits(1);
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
    wait(&gate).await;
    let during: Vec<_> = registrations
        .iter()
        .map(|reg| reg.revocation_tracking())
        .collect();
    gate.release.add_permits(1);
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

struct HoldRetirement {
    activity: Activity,
    scope: Option<Uuid>,
    gate: std::sync::Mutex<Option<Arc<TestGate>>>,
}
struct HeldRetirement {
    change: Box<dyn ActivityChange>,
    gate: Arc<TestGate>,
}
impl ActivityChanges for HoldRetirement {
    fn capture<'a>(
        &'a self,
        tx: &'a mut sqlx::PgConnection,
        organization: Uuid,
        target: Uuid,
        scope: ChangeScope,
    ) -> Capture<'a> {
        Box::pin(async move {
            let change = self
                .activity
                .capture(tx, organization, target, scope)
                .await?;
            let channel = match scope {
                ChangeScope::Channel(channel) => Some(channel),
                _ => None,
            };
            if channel == self.scope
                && let Some(gate) = self.gate.lock().unwrap().take()
            {
                return Ok(Box::new(HeldRetirement { change, gate }) as Box<dyn ActivityChange>);
            }
            Ok(change)
        })
    }
    fn channel(&self, pool: PgPool, organization: Uuid, change: ChannelChange) {
        self.activity.channel(pool, organization, change);
    }
    fn directory(&self, pool: PgPool, organization: Uuid, target: Uuid) {
        self.activity.directory(pool, organization, target);
    }
}
impl ActivityChange for HeldRetirement {
    fn retire(&mut self) {}

    fn committed(self: Box<Self>, pool: PgPool) {
        tokio::spawn(async move {
            self.gate.entered.add_permits(1);
            self.gate.release.acquire().await.unwrap().forget();
            self.change.committed(pool);
            self.gate.entered.add_permits(1);
        });
    }
}
impl Case {
    fn hold_retirement(&self, channel: Option<Uuid>) -> Arc<TestGate> {
        let gate = Arc::new(TestGate {
            entered: Semaphore::new(0),
            release: Semaphore::new(0),
        });
        self.f
            .state
            .session_changes
            .set_activity(Arc::new(HoldRetirement {
                activity: self.delivery().clone(),
                scope: channel,
                gate: std::sync::Mutex::new(Some(gate.clone())),
            }));
        gate
    }

    async fn finish_late_retirement(&self, gate: Arc<TestGate>) -> usize {
        self.delivery().drained().await;
        let frame = self.take_revocation();
        gate.release.add_permits(1);
        wait(&gate).await;
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
    wait(&old_channel).await;
    role_loss.set_role("guest").await;
    let role_revocation = role_loss.finish_late_retirement(old_channel).await;

    let channel_loss = Case::new(&pool, false, Later::OtherGrant).await;
    let old_role = channel_loss.hold_retirement(None);
    channel_loss.set_role("admin").await;
    wait(&old_role).await;
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
    wait(&regrant).await;
    case.remove_grant().await;
    assert_eq!(
        case.finish_late_retirement(regrant).await,
        1,
        "late re-grant retirement dropped the later removal's revocation"
    );
}
