use super::*;

#[fukulow_test::test]
async fn shared_gap_pages_preserve_all_visibility_denials_and_deduplicate_late_publish(
    pool: PgPool,
) {
    for topic_messages in [false, true] {
        for private in [false, true] {
            let (_, org, sender, channel_id, _) = fixture(&pool).await;
            let nonmember = Uuid::new_v4();
            let deactivated = Uuid::new_v4();
            let reactivated = Uuid::new_v4();
            let revoked_between_pages = Uuid::new_v4();
            for id in [nonmember, deactivated, reactivated, revoked_between_pages] {
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
                for id in [sender, deactivated, reactivated, revoked_between_pages] {
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
            let mut revoked_queue = delivery.queue(org, (revoked_between_pages, 0), 256);
            revoked_queue.subscribe(channel_id);
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
            let topic = if topic_messages {
                let id = Uuid::new_v4();
                sqlx::query("INSERT INTO topics (organization_id,channel_id,id,name,first_seq,last_seq,message_count) VALUES ($1,$2,$3,'Shared prefix',1,121,121)").bind(org).bind(channel_id).bind(id).execute(&pool).await.unwrap();
                Some(id)
            } else {
                None
            };
            sqlx::query("INSERT INTO messages (organization_id,id,channel_id,seq,sender,client_message_id,body,topic_id) SELECT $1,gen_random_uuid(),$2,n,$3,gen_random_uuid(),'committed prefix',$4 FROM generate_series(1,121) n")
            .bind(org).bind(channel_id).bind(sender).bind(topic).execute(&pool).await.unwrap();
            let first = replay_page(&pool, org, channel_id, 0, 1)
                .await
                .unwrap()
                .remove(0);
            let page_one_target = replay_page(&pool, org, channel_id, 50, 51)
                .await
                .unwrap()
                .remove(0);
            // Arm the first notification before the later one, as serialized persistence does.
            let early = delivery.notification(org, channel_id, 1);
            delivery
                .notification(org, channel_id, 51)
                .spawn(pool.clone(), page_one_target);
            delivery.flush().await;
            for seq in 1..=51 {
                assert_eq!(revoked_queue.events.try_recv().unwrap().seq, seq);
            }
            // Each shared recovery is now at most one page. Gate the next recovery
            // between page 1 (1..50) and page 2 (52..101), then change live visibility.
            let page_two_target = replay_page(&pool, org, channel_id, 101, 102)
                .await
                .unwrap()
                .remove(0);
            let gate = delivery::pause_publication(page_two_target.client_message_id);
            delivery
                .notification(org, channel_id, 102)
                .spawn(pool.clone(), page_two_target);
            tokio::time::timeout(std::time::Duration::from_secs(5), gate.entered.acquire())
                .await
                .unwrap()
                .unwrap()
                .forget();
            if private {
                sqlx::query("DELETE FROM channel_members WHERE organization_id=$1 AND channel_id=$2 AND member_id=$3")
                .bind(org).bind(channel_id).bind(revoked_between_pages).execute(&pool).await.unwrap();
            } else {
                sqlx::query(
                    "UPDATE users SET deactivated_at=now() WHERE organization_id=$1 AND id=$2",
                )
                .bind(org)
                .bind(revoked_between_pages)
                .execute(&pool)
                .await
                .unwrap();
            }
            gate.release.add_permits(1);
            delivery.flush().await;
            let last = replay_page(&pool, org, channel_id, 120, 121)
                .await
                .unwrap()
                .remove(0);
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
                        assert_eq!(message.topic_id, topic);
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
            assert!(revoked_queue.events.try_recv().is_err());
            assert!(!*revoked_queue.overflow.borrow());
            assert!(!revoked_queue.notification_failed.is_failed());
            early.spawn(pool.clone(), first);
            delivery.flush().await;
            for (queue, _) in &mut queues {
                assert!(queue.events.try_recv().is_err());
            }
        }
    }
}

#[fukulow_test::test]
async fn shared_gap_recovery_accepts_one_page_and_latches_above_the_bound(pool: PgPool) {
    for gap in [
        REPLAY_PAGE_SIZE,
        REPLAY_PAGE_SIZE + 1,
        LIVE_QUEUE_CAPACITY as i64 + 1,
    ] {
        let (_, org, sender, channel, _) = fixture(&pool).await;
        let delivery = Delivery::default();
        let mut before = delivery.queue(org, (sender, 0), LIVE_QUEUE_CAPACITY);
        before.subscribe(channel);
        drop(delivery.notification(org, channel, 1));
        assert!(before.notification_failed.is_failed());
        let mut queue = delivery.queue(org, (sender, 0), LIVE_QUEUE_CAPACITY);
        queue.subscribe(channel);
        assert!(!queue.notification_failed.is_failed());
        sqlx::query("INSERT INTO messages (organization_id,id,channel_id,seq,sender,client_message_id,body) SELECT $1,gen_random_uuid(),$2,n,$3,gen_random_uuid(),'committed prefix' FROM generate_series(1,$4::bigint) n")
            .bind(org).bind(channel).bind(sender).bind(gap + 2).execute(&pool).await.unwrap();
        let last = replay_page(&pool, org, channel, gap, gap + 1)
            .await
            .unwrap()
            .remove(0);
        delivery
            .notification(org, channel, gap + 1)
            .spawn(pool.clone(), last);
        delivery.flush().await;
        if gap == REPLAY_PAGE_SIZE {
            for seq in 1..=gap + 1 {
                assert_eq!(queue.events.try_recv().unwrap().seq, seq);
            }
            assert!(!queue.notification_failed.is_failed());
        } else {
            assert!(queue.notification_failed.is_failed());
        }
        assert!(queue.events.try_recv().is_err());
        assert!(!*queue.overflow.borrow());
        let mut after = delivery.queue(org, (sender, 0), LIVE_QUEUE_CAPACITY);
        after.subscribe(channel);
        let next = replay_page(&pool, org, channel, gap + 1, gap + 2)
            .await
            .unwrap()
            .remove(0);
        delivery
            .notification(org, channel, gap + 2)
            .spawn(pool.clone(), next);
        delivery.flush().await;
        assert_eq!(after.events.try_recv().unwrap().seq, gap + 2);
        assert!(after.events.try_recv().is_err());
        assert!(!after.notification_failed.is_failed());
        assert!(!*after.overflow.borrow());
    }
}

#[fukulow_test::test]
async fn shared_gap_authorization_failure_sets_overflow_and_advances_cursor(pool: PgPool) {
    let (_, org, sender, channel, _) = fixture(&pool).await;
    let delivery = Delivery::default();
    let mut queue = delivery.queue(org, (sender, 0), LIVE_QUEUE_CAPACITY);
    queue.subscribe(channel);
    let mut early = delivery.notification(org, channel, 1);
    early.complete();
    sqlx::query("INSERT INTO messages (organization_id,id,channel_id,seq,sender,client_message_id,body) SELECT $1,gen_random_uuid(),$2,n,$3,gen_random_uuid(),'committed prefix' FROM generate_series(1,4) n")
        .bind(org).bind(channel).bind(sender).execute(&pool).await.unwrap();
    let target = replay_page(&pool, org, channel, 2, 3)
        .await
        .unwrap()
        .remove(0);
    sqlx::query("ALTER TABLE users RENAME COLUMN role TO unavailable_role")
        .execute(&pool)
        .await
        .unwrap();
    delivery
        .notification(org, channel, 3)
        .spawn(pool.clone(), target);
    delivery.flush().await;
    assert!(*queue.overflow.borrow());
    assert!(!queue.notification_failed.is_failed());
    assert!(queue.events.try_recv().is_err());
    sqlx::query("ALTER TABLE users RENAME COLUMN unavailable_role TO role")
        .execute(&pool)
        .await
        .unwrap();
    let mut recovered = delivery.queue(org, (sender, 0), LIVE_QUEUE_CAPACITY);
    recovered.subscribe(channel);
    let next = replay_page(&pool, org, channel, 3, 4)
        .await
        .unwrap()
        .remove(0);
    delivery
        .notification(org, channel, 4)
        .spawn(pool.clone(), next);
    delivery.flush().await;
    // A retained lagging cursor would enqueue the missing prefix again here.
    assert_eq!(recovered.events.try_recv().unwrap().seq, 4);
    assert!(recovered.events.try_recv().is_err());
    assert!(!*recovered.overflow.borrow());
    assert!(!recovered.notification_failed.is_failed());
}

#[fukulow_test::test]
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
