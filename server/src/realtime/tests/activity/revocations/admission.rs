use super::*;
use crate::channels::activity::{NoticeFrame, Registration};
use futures_util::future::join_all;
use sqlx::{Postgres, Transaction};

const FAULT_QUERY: Blocked<'static> = Blocked::Advisory(Advisory::Query(
    "%WITH ORDINALITY r(member_id,revision,hash,channel,n)%",
));

struct Target {
    member: Uuid,
    session: Vec<u8>,
    registration: Registration,
}

async fn fixture_with_held_revocations(
    pool: &PgPool,
    count: usize,
) -> (Fixture, Uuid, Vec<Target>) {
    let f = fixture_with_configured_pool(pool, "3").await;
    owner(pool, &f).await;
    let revoked = channel(pool, f.organization, f.member, true).await;
    let notice = Notice::ChannelAccessRevoked {
        channel_id: revoked,
    };
    let activity = &f.state.message_delivery.channel_access.activity;
    let mut targets = Vec::new();
    for _ in 0..count {
        let (member, token) = member(pool, f.organization).await;
        grant(pool, &f, revoked, member).await;
        let auth = extract_auth(f.state.clone(), &token).await;
        targets.push(Target {
            member,
            session: auth.session_hash(),
            registration: activity.register(&auth),
        });
    }
    for target in &targets {
        let response = request(
            &f.app,
            "DELETE",
            &format!("/api/v1/channels/{revoked}/members/{}", target.member),
            &f.token,
            Value::Null,
        )
        .await;
        assert_eq!(response.status(), StatusCode::NO_CONTENT);
    }
    activity.drained().await;
    let closed = closed_pool(&f.state.pool).await;
    activity
        .check(&closed, SubscriptionScope::Channel(f.organization, revoked))
        .await;
    for target in &targets {
        let frame = target
            .registration
            .next()
            .now_or_never()
            .flatten()
            .expect("the held revocation must be buffered");
        assert_eq!(frame.event, notice);
        assert_eq!(
            frame
                .handoff(&f.state.pool, |_| async {
                    panic!("an unproved revocation reached the write");
                })
                .await,
            None::<()>
        );
    }
    (f, revoked, targets)
}

async fn stall_notice_queries(pool: &PgPool) -> Transaction<'static, Postgres> {
    // Block the same statement as the rehearsal's PostgreSQL fault. An unrelated
    // send must be able to run all of its queries while this lock is still held.
    sqlx::raw_sql(
        "CREATE FUNCTION stall_notice_authorization() RETURNS boolean LANGUAGE plpgsql AS $$
         BEGIN
             IF strpos(current_query(), 'WITH ORDINALITY r(member_id,revision,hash,channel,n)') > 0 THEN
                 PERFORM pg_advisory_xact_lock_shared(1061::bigint);
             END IF;
             RETURN true;
         END $$;
         CREATE POLICY stall_notice_authorization ON users AS RESTRICTIVE FOR SELECT
             USING (stall_notice_authorization());
         ALTER TABLE users ENABLE ROW LEVEL SECURITY;",
    )
    .execute(pool)
    .await
    .unwrap();
    let mut fault = pool.begin().await.unwrap();
    sqlx::query("SELECT pg_advisory_xact_lock(1061::bigint)")
        .execute(&mut *fault)
        .await
        .unwrap();
    fault
}

async fn due_retries(targets: &[Target]) -> Vec<NoticeFrame> {
    let frames = tokio::time::timeout(
        Duration::from_secs(3),
        join_all(targets.iter().map(|target| target.registration.next())),
    )
    .await
    .expect("the held revocations must retry");
    frames
        .into_iter()
        .map(|frame| {
            let frame = frame.unwrap();
            assert!(frame.is_held_retry());
            frame
        })
        .collect()
}

#[fukulow_test::test]
async fn message_commits_while_revocation_retries_saturate_their_pool_share(pool: PgPool) {
    let (f, revoked, targets) = fixture_with_held_revocations(&pool, 3).await;
    let fault = stall_notice_queries(&pool).await;
    let frames = due_retries(&targets).await;
    let key = Uuid::new_v4();
    let activity = &f.state.message_delivery.channel_access.activity;
    let (written, (), ()) = tokio::join!(
        join_all(
            frames
                .iter()
                .map(|frame| { frame.handoff(&f.state.pool, |notice| async { notice }) })
        ),
        activity.check(&f.state.pool, SubscriptionScope::All),
        async {
            wait_blocked(
                &pool,
                FAULT_QUERY,
                Count::AtLeast(2),
                Duration::from_secs(2),
            )
            .await;
            // All three retries were polled before posting. Keep the fault in
            // place and require progress before the retries' five-second deadline.
            let message = tokio::time::timeout(
                Duration::from_secs(2),
                send(&f, &f.token, f.channel, key, "send during revocation fault"),
            )
            .await
            .expect("Message send stalled behind revocation rechecks");
            let committed: Uuid = sqlx::query_scalar(
                "SELECT id FROM messages WHERE organization_id=$1 AND channel_id=$2 AND client_message_id=$3",
            )
            .bind(f.organization)
            .bind(f.channel)
            .bind(key)
            .fetch_one(&pool)
            .await
            .unwrap();
            assert_eq!(message["id"], committed.to_string());
            assert_eq!(FAULT_QUERY.count(&pool).await, 2);
            fault.rollback().await.unwrap();
        },
    );
    assert_eq!(
        written,
        vec![
            Some(Notice::ChannelAccessRevoked {
                channel_id: revoked
            });
            3
        ]
    );
}

#[fukulow_test::test]
async fn queued_activity_publication_denies_lost_private_access(pool: PgPool) {
    let (f, revoked, targets) = fixture_with_held_revocations(&pool, 1).await;
    let private = channel(&pool, f.organization, f.member, true).await;
    let (reader, token) = member(&pool, f.organization).await;
    let (control, control_token) = member(&pool, f.organization).await;
    grant(&pool, &f, private, reader).await;
    grant(&pool, &f, private, control).await;
    let activity = &f.state.message_delivery.channel_access.activity;
    let reader_registration = activity.register(&extract_auth(f.state.clone(), &token).await);
    let control_registration =
        activity.register(&extract_auth(f.state.clone(), &control_token).await);
    let notice = Notice::ChannelMembersChanged {
        channel_id: private,
    };
    let fault = stall_notice_queries(&pool).await;
    let frames = due_retries(&targets).await;
    let (written, ()) = tokio::join!(
        frames[0].handoff(&f.state.pool, |notice| async { notice }),
        async {
            wait_blocked(
                &pool,
                FAULT_QUERY,
                Count::Exactly(1),
                Duration::from_secs(2),
            )
            .await;
            let mut publish = std::pin::pin!(activity.publish(
                &f.state.pool,
                f.organization,
                notice.clone(),
                None,
                None,
                PublicationFence::default(),
            ));
            assert!(publish.as_mut().now_or_never().is_none());
            sqlx::query("DELETE FROM channel_members WHERE organization_id=$1 AND channel_id=$2 AND member_id=$3")
                .bind(f.organization)
                .bind(private)
                .bind(reader)
                .execute(&pool)
                .await
                .unwrap();
            fault.rollback().await.unwrap();
            publish.await.unwrap();
        },
    );
    assert_eq!(
        written,
        Some(Notice::ChannelAccessRevoked {
            channel_id: revoked
        })
    );
    assert!(!reader_registration.buffered(&notice));
    assert!(control_registration.buffered(&notice));
}

#[fukulow_test::test]
async fn queued_revocation_retries_deny_restored_access_inactive_members_and_ended_sessions(
    pool: PgPool,
) {
    let (f, revoked, targets) = fixture_with_held_revocations(&pool, 4).await;
    let fault = stall_notice_queries(&pool).await;
    let frames = due_retries(&targets).await;
    let (written, ()) = tokio::join!(
        join_all(
            frames
                .iter()
                .map(|frame| { frame.handoff(&f.state.pool, |notice| async { notice }) })
        ),
        async {
            wait_blocked(
                &pool,
                FAULT_QUERY,
                Count::AtLeast(1),
                Duration::from_secs(2),
            )
            .await;
            assert_eq!(FAULT_QUERY.count(&pool).await, 1);
            // Make the changes without hooks while the later retries wait for a
            // query slot. They must use database proof from after these changes.
            grant(&pool, &f, revoked, targets[1].member).await;
            sqlx::query("UPDATE users SET deactivated_at=now() WHERE organization_id=$1 AND id=$2")
                .bind(f.organization)
                .bind(targets[2].member)
                .execute(&pool)
                .await
                .unwrap();
            sqlx::query("DELETE FROM account_sessions WHERE token_hash=$1")
                .bind(&targets[3].session)
                .execute(&pool)
                .await
                .unwrap();
            fault.rollback().await.unwrap();
        },
    );
    assert_eq!(
        written,
        [
            Some(Notice::ChannelAccessRevoked {
                channel_id: revoked
            }),
            None,
            None,
            None
        ]
    );
}
