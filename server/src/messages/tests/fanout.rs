use super::*;

#[sqlx::test]
async fn shared_gap_pages_preserve_all_visibility_denials_and_deduplicate_late_publish(
    pool: PgPool,
) {
    for private in [false, true] {
        let (_, org, sender, channel_id, _) = fixture(&pool).await;
        let nonmember = Uuid::new_v4();
        let deactivated = Uuid::new_v4();
        let reactivated = Uuid::new_v4();
        for id in [nonmember, deactivated, reactivated] {
            member(&pool, org, id).await;
        }
        let other = organization(&pool).await;
        let foreign = Uuid::new_v4();
        member(&pool, other, foreign).await;
        member(&pool, other, sender).await;
        channel(&pool, other, channel_id, sender, true).await;
        if private {
            sqlx::query(
                "UPDATE channels SET visibility='private' WHERE organization_id=$1 AND id=$2",
            )
            .bind(org)
            .bind(channel_id)
            .execute(&pool)
            .await
            .unwrap();
            for id in [sender, deactivated, reactivated] {
                sqlx::query("INSERT INTO channel_members (organization_id,channel_id,member_id) VALUES ($1,$2,$3)")
                    .bind(org).bind(channel_id).bind(id).execute(&pool).await.unwrap();
            }
        }
        let delivery = Delivery::default();
        let mut queues = Vec::new();
        for (id, revision, allowed) in [
            (sender, 0, true),
            (nonmember, 0, !private),
            (deactivated, 0, false),
            (reactivated, 0, false),
            (reactivated, 1, !private),
            (foreign, 0, false),
        ] {
            let mut queue = delivery.queue(org, (id, revision), 256);
            queue.subscribe(channel_id);
            queues.push((queue, allowed));
        }
        let mut foreign_queue = delivery.queue(other, (sender, 0), 256);
        foreign_queue.subscribe(channel_id);
        sqlx::query(
            "UPDATE users SET deactivated_at=now() WHERE organization_id=$1 AND id=ANY($2)",
        )
        .bind(org)
        .bind(vec![deactivated, reactivated])
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query("UPDATE users SET deactivated_at=NULL WHERE organization_id=$1 AND id=$2")
            .bind(org)
            .bind(reactivated)
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO messages (organization_id,id,channel_id,seq,sender,client_message_id,body) SELECT $1,gen_random_uuid(),$2,n,$3,gen_random_uuid(),'committed prefix' FROM generate_series(1,121) n")
            .bind(org).bind(channel_id).bind(sender).execute(&pool).await.unwrap();
        let first = replay_page(&pool, org, channel_id, 0, 1)
            .await
            .unwrap()
            .remove(0);
        let last = replay_page(&pool, org, channel_id, 120, 121)
            .await
            .unwrap()
            .remove(0);
        // Arm the first notification before the later one, as serialized persistence does.
        let early = delivery.notification(org, channel_id, 1);
        delivery
            .notification(org, channel_id, 121)
            .spawn(pool.clone(), last);
        delivery.flush().await;
        let mut canonical = Vec::new();
        for (queue, allowed) in &mut queues {
            if *allowed {
                for seq in 1..=121 {
                    let message = queue.events.try_recv().unwrap();
                    assert_eq!(message.seq, seq);
                    assert_eq!(message.channel_id, channel_id);
                    if canonical.len() < 121 {
                        canonical.push(message);
                    } else {
                        assert!(std::sync::Arc::ptr_eq(
                            &message,
                            &canonical[(seq - 1) as usize]
                        ));
                    }
                }
            }
            assert!(queue.events.try_recv().is_err());
            assert!(!*queue.overflow.borrow());
            assert!(!queue.notification_failed.is_failed());
        }
        assert!(foreign_queue.events.try_recv().is_err());
        early.spawn(pool.clone(), first);
        delivery.flush().await;
        for (queue, _) in &mut queues {
            assert!(queue.events.try_recv().is_err());
        }
    }
}

#[sqlx::test]
async fn shared_gap_query_failure_latches_only_affected_channel_for_replay(pool: PgPool) {
    let (_, org, sender, channel, _) = fixture(&pool).await;
    let delivery = Delivery::default();
    let mut affected = delivery.queue(org, (sender, 0), 256);
    affected.subscribe(channel);
    let mut other_channel = delivery.queue(org, (sender, 0), 256);
    other_channel.subscribe(Uuid::new_v4());
    let mut other_org = delivery.queue(Uuid::new_v4(), (sender, 0), 256);
    other_org.subscribe(channel);
    sqlx::query("INSERT INTO messages (organization_id,id,channel_id,seq,sender,client_message_id,body) SELECT $1,gen_random_uuid(),$2,n,$3,gen_random_uuid(),'committed prefix' FROM generate_series(1,3) n")
        .bind(org).bind(channel).bind(sender).execute(&pool).await.unwrap();
    let last = replay_page(&pool, org, channel, 2, 3)
        .await
        .unwrap()
        .remove(0);
    let mut early = delivery.notification(org, channel, 1);
    early.complete();
    sqlx::query("ALTER TABLE messages RENAME TO unavailable_messages")
        .execute(&pool)
        .await
        .unwrap();
    delivery
        .notification(org, channel, 3)
        .spawn(pool.clone(), last);
    delivery.flush().await;
    assert!(affected.notification_failed.is_failed());
    assert!(!*affected.overflow.borrow());
    assert!(affected.events.try_recv().is_err());
    assert!(!other_channel.notification_failed.is_failed());
    assert!(!other_org.notification_failed.is_failed());
    sqlx::query("ALTER TABLE unavailable_messages RENAME TO messages")
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(
        replay_page(&pool, org, channel, 0, 3)
            .await
            .unwrap()
            .iter()
            .map(|message| message.seq)
            .collect::<Vec<_>>(),
        vec![1, 2, 3]
    );
}
