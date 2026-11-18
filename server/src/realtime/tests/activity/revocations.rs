use super::*;
use crate::{
    auth::{
        SubscriptionRecheck, SubscriptionScope,
        activity::{ActivityChange, ActivityChanges, Capture, ChannelChange},
    },
    channels::{
        AccessChanges,
        activity::{Activity, Notice, NoticeFrame, Registration, TestGate, pause_member},
        tests::extract_auth,
    },
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
    Regrant,
    Role,
    Deactivate,
}

struct Case {
    f: Fixture,
    target: Uuid,
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
    async fn later(&self, later: Later, whole_set: bool) {
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
            count +=
                usize::from(next.handoff(|event| async { event }).await == Some(self.revoked()));
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
                case.later(later, false).await;
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
            } else {
                let gate = pause_member(
                    case.f.organization,
                    Uuid::nil(),
                    "target_state",
                    Some(case.target),
                );
                case.later(later, whole_set).await;
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
            let expected = usize::from(matches!(later, Later::OtherGrant | Later::OtherManager));
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
            Later::Regrant,
            Later::Role,
            Later::Deactivate,
        ],
    )
    .await;
}

struct HoldMemberRecheck {
    access: AccessChanges,
    member: (Uuid, Uuid),
    gate: Arc<TestGate>,
}
impl SubscriptionRecheck for HoldMemberRecheck {
    fn check<'a>(
        &'a self,
        pool: &'a PgPool,
        scope: SubscriptionScope,
    ) -> Pin<Box<dyn Future<Output = Result<(), sqlx::Error>> + Send + 'a>> {
        Box::pin(async move {
            if matches!(scope, SubscriptionScope::Member(org, member) if (org, member) == self.member)
            {
                self.gate.entered.add_permits(1);
                self.gate.release.acquire().await.unwrap().forget();
            }
            self.access.check(pool, scope).await
        })
    }
    fn failed(&self, scope: SubscriptionScope) {
        self.access.failed(scope);
    }
}

#[fukulow_test::test]
async fn role_revocations_survive_a_later_grant_during_recheck(pool: PgPool) {
    let case = Case::new(&pool, true, Later::OtherGrant).await;
    let token = session::another_session(&pool, case.f.organization, case.target).await;
    let mut socket = connect(&case.f, &token).await;
    let gate = Arc::new(TestGate {
        entered: Semaphore::new(0),
        release: Semaphore::new(0),
    });
    case.f
        .state
        .session_changes
        .set_subscription_recheck(Arc::new(HoldMemberRecheck {
            access: case.f.state.message_delivery.channel_access.clone(),
            member: (case.f.organization, case.target),
            gate: gate.clone(),
        }));
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
            role(&pool, &case.f, case.target, "guest").await;
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
    assert_eq!(received, [1, 0], "live identity then changed identity");
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
    let sent = frame.handoff(|_| async { polled = true }).await;
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
        channel: Option<Uuid>,
    ) -> Capture<'a> {
        Box::pin(async move {
            let change = self
                .activity
                .capture(tx, organization, target, channel)
                .await?;
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
