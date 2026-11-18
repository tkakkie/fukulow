use super::*;
use crate::{
    auth::{SubscriptionRecheck, SubscriptionScope},
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
            let later_gate = pause_member(
                case.f.organization,
                Uuid::nil(),
                "target_state",
                Some(case.target),
            );
            case.later(later, whole_set).await;
            wait(&later_gate).await;
            if let Some(gate) = &gate {
                gate.release.add_permits(1);
            }
            case.delivery().drained_except(1).await;
            let actual = case.received_revocations(held).await;
            later_gate.release.add_permits(1);
            case.delivery().drained().await;
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
