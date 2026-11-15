use super::*;
use crate::channels::tests::{extract_auth, member, organization};
use crate::test_support::TestPools;
use axum::extract::Query;

#[fukulow_test::test]
async fn dm_open_list_and_discovery_use_one_measured_checkout_each(pool: PgPool) {
    let pools = TestPools::new(pool).await;
    let org = organization(&pools.admin).await;
    let a = Uuid::new_v4();
    let b = Uuid::new_v4();
    let token = member(&pools.admin, org, a, "member").await;
    member(&pools.admin, org, b, "member").await;
    let state = AppState::for_test(pools.app.clone()).await;
    for (renew, expected) in [
        (false, StatusCode::CREATED),
        (false, StatusCode::OK),
        (true, StatusCode::OK),
    ] {
        let auth = extract_auth(state.clone(), &token).await;
        let (response, count) = crate::database::test_acquisitions(dms::open(
            State(state.clone()),
            auth,
            ApiJson(channels::dms::OpenDmRequest {
                member_id: b,
                renew,
            }),
        ))
        .await;
        assert_eq!(response.unwrap().status(), expected);
        assert_eq!(count, 1, "detached create/resolve/renew transaction");
    }
    let auth = extract_auth(state.clone(), &token).await;
    let (response, count) = crate::database::test_acquisitions(dms::list(
        State(state.clone()),
        auth,
        Ok(Query(vec![])),
    ))
    .await;
    assert_eq!(response.unwrap().status(), StatusCode::OK);
    assert_eq!(count, 1, "identity and baselines share one snapshot");
    for lane in ["delta", "coverage"] {
        let auth = extract_auth(state.clone(), &token).await;
        let (response, count) =
            crate::database::test_acquisitions(channels::dms::discovery::changes(
                State(state.clone()),
                auth,
                Ok(Query(vec![("lane".into(), lane.into())])),
            ))
            .await;
        assert_eq!(response.unwrap().status(), StatusCode::OK);
        assert_eq!(count, 1);
    }
}
