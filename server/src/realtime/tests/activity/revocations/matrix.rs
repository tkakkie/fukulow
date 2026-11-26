use super::{Case, Later, PgPool, Uuid, pause_member};

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
                retirement.entered().await;
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
                gate.entered().await;
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
                manager.release();
                manager.entered().await;
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
                gate.entered().await;
                Some(gate)
            };
            if let Some(gate) = &gate {
                gate.release();
            }
            case.delivery()
                .drained_except(u32::from(later_gate.is_some()))
                .await;
            let actual = case.received_revocations(held).await;
            if let Some(later_gate) = &later_gate {
                later_gate.release();
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
