//! #306: per-(Organization, Member) send limit, through the send endpoint.
use super::*;
use crate::messages::limiter::BURST;
use std::time::Duration;

struct Limited {
    app: Router,
    state: AppState,
    organization: Uuid,
    member: Uuid,
    channel: Uuid,
    token: String,
}

async fn limited(pool: &PgPool) -> Limited {
    let organization = organization(pool).await;
    let member = Uuid::new_v4();
    let token = super::member(pool, organization, member).await;
    let channel = Uuid::new_v4();
    super::channel(pool, organization, channel, member, false).await;
    let state = AppState::for_test(pool.clone()).await;
    state.message_delivery.send_limiter.enforce();
    Limited {
        app: crate::app(state.clone()),
        state,
        organization,
        member,
        channel,
        token,
    }
}

impl Limited {
    fn advance(&self, by: Duration) {
        self.state.message_delivery.send_limiter.advance(by);
    }

    async fn exhaust(&self) {
        for _ in 0..BURST {
            sent(
                &self.app,
                &self.token,
                self.channel,
                input(Uuid::new_v4(), "fill"),
            )
            .await;
        }
    }

    async fn throttled(&self, token: &str, channel: Uuid, value: Value) {
        let response = send(&self.app, token, channel, value).await;
        assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS);
        assert_eq!(response.headers()[header::RETRY_AFTER], "1");
        assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
        assert_eq!(body(response).await["error"], "send_rate_limited");
    }

    async fn sequence(&self, pool: &PgPool) -> i64 {
        sqlx::query_scalar(
            "SELECT COALESCE(max(seq), 0) FROM messages WHERE organization_id = $1 AND channel_id = $2",
        )
        .bind(self.organization)
        .bind(self.channel)
        .fetch_one(pool)
        .await
        .unwrap()
    }
}

#[sqlx::test]
async fn one_member_is_throttled_while_another_sends_and_the_bucket_refills(pool: PgPool) {
    let l = limited(&pool).await;
    let other = Uuid::new_v4();
    let other_token = member(&pool, l.organization, other).await;
    l.exhaust().await;
    let admission = l.state.message_delivery.admission(&l.state.pool);
    let permits = admission.available_permits();
    let mut queue = l
        .state
        .message_delivery
        .queue(l.organization, (other, 0), 256);
    queue.subscribe(l.channel);
    let before = l.sequence(&pool).await;
    l.throttled(&l.token, l.channel, input(Uuid::new_v4(), "over"))
        .await;
    // A 429 takes no admission slot, sequence or event.
    assert_eq!(admission.available_permits(), permits);
    assert_eq!(admission.queued_sends(), 0);
    assert_eq!(l.sequence(&pool).await, before);
    l.state.message_delivery.flush().await;
    assert!(queue.events.try_recv().is_err());
    sent(
        &l.app,
        &other_token,
        l.channel,
        input(Uuid::new_v4(), "other"),
    )
    .await;
    l.advance(Duration::from_millis(999));
    l.throttled(&l.token, l.channel, input(Uuid::new_v4(), "early"))
        .await;
    l.advance(Duration::from_millis(1));
    sent(
        &l.app,
        &l.token,
        l.channel,
        input(Uuid::new_v4(), "refilled"),
    )
    .await;
    l.throttled(&l.token, l.channel, input(Uuid::new_v4(), "again"))
        .await;
}

#[sqlx::test]
async fn budgets_are_independent_per_organization(pool: PgPool) {
    let l = limited(&pool).await;
    // Same Member id in another Organization: a separate bucket.
    let organization = super::organization(&pool).await;
    let token = member(&pool, organization, l.member).await;
    let channel = Uuid::new_v4();
    super::channel(&pool, organization, channel, l.member, false).await;
    l.exhaust().await;
    sent(&l.app, &token, channel, input(Uuid::new_v4(), "elsewhere")).await;
}

#[sqlx::test]
async fn committed_retry_with_an_exhausted_bucket_returns_the_canonical_message_uncharged(
    pool: PgPool,
) {
    let l = limited(&pool).await;
    let key = Uuid::new_v4();
    let canonical = sent(&l.app, &l.token, l.channel, input(key, "first")).await;
    for _ in 1..BURST {
        sent(&l.app, &l.token, l.channel, input(Uuid::new_v4(), "fill")).await;
    }
    let admission = l.state.message_delivery.admission(&l.state.pool);
    for _ in 0..3 {
        assert_eq!(
            sent(&l.app, &l.token, l.channel, input(key, "first")).await,
            canonical
        );
        assert_eq!(admission.queued_sends(), 0);
    }
    // Changed intent still conflicts, also with an exhausted bucket.
    assert_error(
        send(&l.app, &l.token, l.channel, input(key, "changed")).await,
        StatusCode::CONFLICT,
    )
    .await;
    l.advance(Duration::from_secs(1));
    sent(&l.app, &l.token, l.channel, input(Uuid::new_v4(), "one")).await;
    l.throttled(&l.token, l.channel, input(Uuid::new_v4(), "two"))
        .await;
}

#[sqlx::test]
async fn failed_retries_with_one_id_are_charged_and_then_throttled(pool: PgPool) {
    let l = limited(&pool).await;
    let key = Uuid::new_v4();
    let intent = json!({"client_message_id": key, "body": "reply", "reply_to": Uuid::new_v4()});
    // With tokens, a missing parent is 404 and the token is spent.
    for _ in 0..BURST {
        let response = send(&l.app, &l.token, l.channel, intent.clone()).await;
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        assert_eq!(body(response).await["error"], "reply_parent_not_found");
    }
    // With an empty bucket the limiter answers first.
    l.throttled(&l.token, l.channel, intent).await;
}

#[sqlx::test]
async fn concurrent_identical_requests_consume_one_token_and_share_one_message(pool: PgPool) {
    let l = limited(&pool).await;
    for _ in 1..BURST {
        sent(&l.app, &l.token, l.channel, input(Uuid::new_v4(), "fill")).await;
    }
    let key = Uuid::new_v4();
    let gate = commit::pause_commit(key);
    let first = {
        let (app, token, channel) = (l.app.clone(), l.token.clone(), l.channel);
        tokio::spawn(async move { send(&app, &token, channel, input(key, "once")).await })
    };
    gate.entered.acquire().await.unwrap().forget();
    // The duplicate waits for the in-flight leader without a token of its own.
    let second = {
        let (app, token, channel) = (l.app.clone(), l.token.clone(), l.channel);
        tokio::spawn(async move { send(&app, &token, channel, input(key, "once")).await })
    };
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(!second.is_finished());
    gate.release.add_permits(1);
    let (first, second) = (first.await.unwrap(), second.await.unwrap());
    assert_eq!(first.status(), StatusCode::CREATED);
    assert_eq!(second.status(), StatusCode::CREATED);
    assert_eq!(body(first).await, body(second).await);
    assert_eq!(l.sequence(&pool).await, i64::try_from(BURST).unwrap());
    l.throttled(&l.token, l.channel, input(Uuid::new_v4(), "over"))
        .await;
}

#[sqlx::test]
async fn waiters_settle_with_a_failed_leader_without_paying_or_taking_its_free_retry(pool: PgPool) {
    let l = limited(&pool).await;
    for _ in 2..BURST {
        sent(&l.app, &l.token, l.channel, input(Uuid::new_v4(), "fill")).await;
    }
    let key = Uuid::new_v4();
    let gate = commit::pause_commit(key);
    let pending = commit::ambiguous_commit(key);
    let leader = {
        let (app, token, channel) = (l.app.clone(), l.token.clone(), l.channel);
        tokio::spawn(async move { send(&app, &token, channel, input(key, "maybe")).await })
    };
    gate.entered.acquire().await.unwrap().forget();
    let waiter = {
        let (app, token, channel) = (l.app.clone(), l.token.clone(), l.channel);
        tokio::spawn(async move { send(&app, &token, channel, input(key, "maybe")).await })
    };
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(!waiter.is_finished());
    gate.release.add_permits(1);
    // Both settle with the leader's unknown outcome; the waiter neither pays nor executes.
    // Re-executing would block on the held row until the 8 s transaction timeout.
    let waiter = tokio::time::timeout(Duration::from_secs(3), waiter)
        .await
        .expect("waiter settles with the leader")
        .unwrap();
    for response in [leader.await.unwrap(), waiter] {
        assert_error(response, StatusCode::INTERNAL_SERVER_ERROR).await;
    }
    pending.await.unwrap().rollback().await.unwrap();
    // The client's own retry still gets the free retry; one token is left.
    assert_eq!(
        sent(&l.app, &l.token, l.channel, input(key, "maybe")).await["body"],
        "maybe"
    );
    sent(&l.app, &l.token, l.channel, input(Uuid::new_v4(), "last")).await;
    l.throttled(&l.token, l.channel, input(Uuid::new_v4(), "over"))
        .await;
}

#[sqlx::test]
async fn a_waiter_with_another_intent_executes_itself_and_pays_without_the_free_retry(
    pool: PgPool,
) {
    let l = limited(&pool).await;
    for _ in 2..BURST {
        sent(&l.app, &l.token, l.channel, input(Uuid::new_v4(), "fill")).await;
    }
    let key = Uuid::new_v4();
    let gate = commit::pause_commit(key);
    let pending = commit::ambiguous_commit(key);
    let leader = {
        let (app, token, channel) = (l.app.clone(), l.token.clone(), l.channel);
        tokio::spawn(async move { send(&app, &token, channel, input(key, "maybe")).await })
    };
    gate.entered.acquire().await.unwrap().forget();
    let other = {
        let (app, token, channel) = (l.app.clone(), l.token.clone(), l.channel);
        tokio::spawn(async move { send(&app, &token, channel, input(key, "other")).await })
    };
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(!other.is_finished());
    gate.release.add_permits(1);
    assert_error(leader.await.unwrap(), StatusCode::INTERNAL_SERVER_ERROR).await;
    pending.await.unwrap().rollback().await.unwrap();
    // The other intent does not inherit the leader's failure: it runs and pays.
    let other = tokio::time::timeout(Duration::from_secs(5), other)
        .await
        .expect("the other intent executes")
        .unwrap();
    assert_eq!(other.status(), StatusCode::CREATED);
    // The leader's retry finds "other" committed: 409 before any charge. The empty
    // bucket shows "other" paid instead of taking the leader's free retry.
    assert_error(
        send(&l.app, &l.token, l.channel, input(key, "maybe")).await,
        StatusCode::CONFLICT,
    )
    .await;
    l.throttled(&l.token, l.channel, input(Uuid::new_v4(), "over"))
        .await;
}

#[sqlx::test]
async fn unknown_commit_retry_is_free_and_a_confirmed_failure_retry_is_charged(pool: PgPool) {
    let l = limited(&pool).await;
    let key = Uuid::new_v4();
    let pending = commit::ambiguous_commit(key);
    assert_error(
        send(&l.app, &l.token, l.channel, input(key, "maybe")).await,
        StatusCode::INTERNAL_SERVER_ERROR,
    )
    .await;
    pending.await.unwrap().rollback().await.unwrap();
    for _ in 1..BURST {
        sent(&l.app, &l.token, l.channel, input(Uuid::new_v4(), "fill")).await;
    }
    // Within 120 s the retry is free even with an empty bucket.
    let message = sent(&l.app, &l.token, l.channel, input(key, "maybe")).await;
    assert_eq!(message["body"], "maybe");
    l.throttled(&l.token, l.channel, input(Uuid::new_v4(), "over"))
        .await;
    // After the marker expires the canonical lookup decides: committed, uncharged.
    l.advance(Duration::from_secs(121));
    l.exhaust().await;
    assert_eq!(
        sent(&l.app, &l.token, l.channel, input(key, "maybe")).await,
        message
    );
    // A definite failure (missing parent) clears the marker: its retry pays.
    l.advance(Duration::from_secs(1));
    let failing =
        json!({"client_message_id": Uuid::new_v4(), "body": "x", "reply_to": Uuid::new_v4()});
    assert_error(
        send(&l.app, &l.token, l.channel, failing.clone()).await,
        StatusCode::NOT_FOUND,
    )
    .await;
    l.throttled(&l.token, l.channel, failing).await;
}

#[sqlx::test]
async fn exhausted_bucket_keeps_denials_as_denials(pool: PgPool) {
    let l = limited(&pool).await;
    let key = Uuid::new_v4();
    sent(&l.app, &l.token, l.channel, input(key, "mine")).await;
    let foreign = super::organization(&pool).await;
    let foreign_channel = Uuid::new_v4();
    super::channel(&pool, foreign, foreign_channel, Uuid::new_v4(), false).await;
    let guest = Uuid::new_v4();
    let guest_token = member(&pool, l.organization, guest).await;
    sqlx::query("UPDATE users SET role = 'guest' WHERE organization_id = $1 AND id = $2")
        .bind(l.organization)
        .bind(guest)
        .execute(&pool)
        .await
        .unwrap();
    // The Guest's grant: the private Channel's only member.
    let private = Uuid::new_v4();
    super::channel(&pool, l.organization, private, guest, true).await;
    let guest_key = Uuid::new_v4();
    sent(&l.app, &guest_token, private, input(guest_key, "granted")).await;
    for _ in 1..BURST {
        sent(&l.app, &guest_token, private, input(Uuid::new_v4(), "fill")).await;
    }
    for _ in 1..BURST {
        sent(&l.app, &l.token, l.channel, input(Uuid::new_v4(), "fill")).await;
    }
    let denied = async |token: &str, channel: Uuid, value: Value, error: &str| {
        let response = send(&l.app, token, channel, value).await;
        assert_eq!(response.status(), StatusCode::NOT_FOUND, "{error}");
        assert_eq!(body(response).await["error"], error);
    };
    // Positive controls: both buckets are empty where access holds.
    l.throttled(&l.token, l.channel, input(Uuid::new_v4(), "x"))
        .await;
    l.throttled(&guest_token, private, input(Uuid::new_v4(), "x"))
        .await;
    // Private non-member, foreign Organization's Channel, Guest without a grant.
    denied(
        &l.token,
        private,
        input(Uuid::new_v4(), "x"),
        "channel not found",
    )
    .await;
    denied(
        &l.token,
        foreign_channel,
        input(Uuid::new_v4(), "x"),
        "channel not found",
    )
    .await;
    denied(
        &guest_token,
        l.channel,
        input(Uuid::new_v4(), "x"),
        "channel not found",
    )
    .await;
    // A revoked grant denies the canonical retry too.
    sqlx::query("DELETE FROM channel_members WHERE organization_id = $1 AND channel_id = $2 AND member_id = $3")
        .bind(l.organization)
        .bind(private)
        .bind(guest)
        .execute(&pool)
        .await
        .unwrap();
    denied(
        &guest_token,
        private,
        input(guest_key, "granted"),
        "channel not found",
    )
    .await;
    // A deactivated Member's canonical retry and new send are unavailable.
    sqlx::query("UPDATE users SET deactivated_at = now() WHERE organization_id = $1 AND id = $2")
        .bind(l.organization)
        .bind(l.member)
        .execute(&pool)
        .await
        .unwrap();
    denied(
        &l.token,
        l.channel,
        input(key, "mine"),
        "organization_unavailable",
    )
    .await;
    denied(
        &l.token,
        l.channel,
        input(Uuid::new_v4(), "x"),
        "organization_unavailable",
    )
    .await;
}

#[test]
fn limiter_refusals_map_to_429_and_503_with_retry_after() {
    for (error, status, retry) in [
        (
            MessageError::Throttled(3),
            StatusCode::TOO_MANY_REQUESTS,
            "3",
        ),
        (
            MessageError::LimiterSaturated,
            StatusCode::SERVICE_UNAVAILABLE,
            "1",
        ),
    ] {
        let response = error.into_response();
        assert_eq!(response.status(), status);
        assert_eq!(response.headers()[header::RETRY_AFTER], retry);
    }
}
