use super::*;
use crate::messages::receipts::{self, Kind, Operation, Outcome, Resolution};
use sha2::Digest;

/// Independent encoder for the original-send receipt, so the SQL encoding is
/// pinned by a second implementation.
fn send_digest(
    channel: Uuid,
    body: &str,
    topic_key: Option<&str>,
    reply_to: Option<Uuid>,
) -> Vec<u8> {
    let mut bytes = b"fukulow.send.v1".to_vec();
    bytes.extend(channel.as_bytes());
    match reply_to {
        None => bytes.push(0),
        Some(id) => {
            bytes.push(1);
            bytes.extend(id.as_bytes());
        }
    }
    match topic_key {
        None => bytes.push(0),
        Some(key) => {
            bytes.push(1);
            bytes.extend((key.len() as i32).to_be_bytes());
            bytes.extend(key.as_bytes());
        }
    }
    bytes.extend((body.len() as i32).to_be_bytes());
    bytes.extend(body.as_bytes());
    sha2::Sha256::digest(&bytes).to_vec()
}

async fn stored(pool: &PgPool, org: Uuid, id: Uuid) -> (i64, i64, Vec<u8>) {
    sqlx::query_as(
        "SELECT seq, version, send_digest FROM messages WHERE organization_id=$1 AND id=$2",
    )
    .bind(org)
    .bind(id)
    .fetch_one(pool)
    .await
    .unwrap()
}

fn id(value: &Value, field: &str) -> Uuid {
    value[field].as_str().unwrap().parse().unwrap()
}

#[fukulow_test::test]
async fn send_receipt_matches_original_intent_after_state_changes(pool: PgPool) {
    let (app, org, _, channel, token) = fixture(&pool).await;
    let key = Uuid::new_v4();
    let original = json!({"client_message_id":key,"body":"original","topic_name":"Plan"});
    let first = sent(&app, &token, channel, original.clone()).await;
    let message = id(&first, "id");
    let (seq, version, digest) = stored(&pool, org, message).await;
    assert_eq!((seq, version), (1, 1));
    assert_eq!(digest, send_digest(channel, "original", Some("plan"), None));
    let reply = sent(
        &app,
        &token,
        channel,
        json!({"client_message_id":Uuid::new_v4(),"body":"reply","reply_to":message}),
    )
    .await;
    assert_eq!(
        stored(&pool, org, id(&reply, "id")).await.2,
        send_digest(channel, "reply", None, Some(message))
    );

    // Stand-in for a later Edit and Move: current body, Topic and version change.
    let other = Uuid::new_v4();
    sqlx::query("INSERT INTO topics (organization_id, channel_id, id, name, first_seq, last_seq, message_count) VALUES ($1,$2,$3,'Other',1,1,1)")
        .bind(org).bind(channel).bind(other).execute(&pool).await.unwrap();
    sqlx::query("UPDATE messages SET body='edited', topic_id=$3, version=7 WHERE organization_id=$1 AND id=$2")
        .bind(org).bind(message).bind(other).execute(&pool).await.unwrap();
    assert_eq!(stored(&pool, org, message).await.2, digest);

    // The original intent, in any Topic-name case, answers with current state.
    for topic in ["Plan", "PLAN"] {
        let retry = sent(
            &app,
            &token,
            channel,
            json!({"client_message_id":key,"body":"original","topic_name":topic}),
        )
        .await;
        assert_eq!(retry["id"], first["id"]);
        assert_eq!(retry["created_seq"], 1);
        assert_eq!(retry["version"], 7);
        assert_eq!(retry["deleted"], false);
        assert!(retry.get("seq").is_none());
        assert_eq!(retry["body"], "edited");
    }
    // The current state is not the original intent.
    for changed in [
        json!({"client_message_id":key,"body":"edited","topic_name":"Other"}),
        json!({"client_message_id":key,"body":"edited","topic_name":"Plan"}),
        json!({"client_message_id":key,"body":"original","topic_name":"Other"}),
        json!({"client_message_id":key,"body":"original"}),
        json!({"client_message_id":key,"body":"original","reply_to":message}),
    ] {
        assert_error(
            send(&app, &token, channel, changed).await,
            StatusCode::CONFLICT,
        )
        .await;
    }
    let next: i64 = sqlx::query_scalar(
        "SELECT seq FROM channel_message_sequences WHERE organization_id=$1 AND channel_id=$2",
    )
    .bind(org)
    .bind(channel)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(next, 2, "retries and conflicts allocate nothing");
}

#[fukulow_test::test]
async fn send_receipt_is_immutable_and_versions_never_decrease_for_runtime_role(pool: PgPool) {
    let (app, org, _, channel, token) = fixture(&pool).await;
    let message = id(
        &sent(&app, &token, channel, input(Uuid::new_v4(), "fixed")).await,
        "id",
    );
    let app_pool = crate::test_app_pool(pool.clone()).await;
    for sql in [
        "UPDATE messages SET send_digest = sha256('forged'::bytea) WHERE organization_id=$1 AND id=$2",
        "UPDATE messages SET version = 0 WHERE organization_id=$1 AND id=$2",
    ] {
        let error =
            crate::database::organization(&app_pool, org, async |tx: &mut sqlx::PgConnection| {
                sqlx::query(sql).bind(org).bind(message).execute(tx).await
            })
            .await
            .unwrap_err();
        let code = error.as_database_error().unwrap().code();
        assert!(
            matches!(code.as_deref(), Some("P0001" | "23514")),
            "{sql}: {error}"
        );
    }
    // Control: a higher version and a body change are allowed; the receipt stays.
    crate::database::organization(&app_pool, org, async |tx: &mut sqlx::PgConnection| {
        sqlx::query(
            "UPDATE messages SET version = 5, body = 'changed' WHERE organization_id=$1 AND id=$2",
        )
        .bind(org)
        .bind(message)
        .execute(tx)
        .await
    })
    .await
    .unwrap();
    assert_eq!(
        stored(&pool, org, message).await,
        (1, 5, send_digest(channel, "fixed", None, None))
    );
    // Callers cannot supply either column on insert.
    let direct = Uuid::new_v4();
    sqlx::query("INSERT INTO messages (organization_id, id, channel_id, seq, sender, client_message_id, body, version, send_digest) \
                 SELECT organization_id, $2, channel_id, 9, sender, gen_random_uuid(), 'direct', 99, sha256('forged'::bytea) FROM messages WHERE organization_id=$1 AND id=$3")
        .bind(org).bind(direct).bind(message).execute(&pool).await.unwrap();
    assert_eq!(
        stored(&pool, org, direct).await,
        (9, 9, send_digest(channel, "direct", None, None))
    );
}

#[fukulow_test::test(migrations = false)]
async fn send_receipt_migration_backfills_version_and_digest(pool: PgPool) {
    let boundary = "202611180515_message_receipts.sql";
    let mut paths =
        std::fs::read_dir(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("migrations"))
            .unwrap()
            .map(|p| p.unwrap().path())
            .filter(|p| p.file_name().unwrap().to_str().unwrap() < boundary)
            .collect::<Vec<_>>();
    paths.sort();
    for path in paths {
        sqlx::raw_sql(&std::fs::read_to_string(path).unwrap())
            .execute(&pool)
            .await
            .unwrap();
    }
    let (_, org, sender, channel, _) = fixture(&pool).await;
    let (topic, root, reply, main, main_reply) = (
        Uuid::new_v4(),
        Uuid::new_v4(),
        Uuid::new_v4(),
        Uuid::new_v4(),
        Uuid::new_v4(),
    );
    sqlx::query("INSERT INTO topics (organization_id, channel_id, id, name, first_seq, last_seq, message_count) VALUES ($1,$2,$3,'Mixed Case',1,2,2)")
        .bind(org).bind(channel).bind(topic).execute(&pool).await.unwrap();
    sqlx::query(
        "INSERT INTO messages (organization_id, id, channel_id, seq, sender, client_message_id, body, topic_id, reply_to_id, reply_root_id) VALUES \
         ($1,$4,$2,1,$3,gen_random_uuid(),'root',$7,NULL,NULL), \
         ($1,$5,$2,2,$3,gen_random_uuid(),'reply',$7,$4,$4), \
         ($1,$6,$2,3,$3,gen_random_uuid(),'main',NULL,NULL,NULL), \
         ($1,$8,$2,4,$3,gen_random_uuid(),'main reply',NULL,$6,$6)",
    )
    .bind(org).bind(channel).bind(sender).bind(root).bind(reply).bind(main).bind(topic)
    .bind(main_reply)
    .execute(&pool).await.unwrap();
    // Sends commit the counter with the Message; #519's backfill check requires it.
    sqlx::query(
        "INSERT INTO channel_message_sequences (organization_id, channel_id, seq) VALUES ($1,$2,4) \
        ON CONFLICT (organization_id, channel_id) DO UPDATE SET seq = 4",
    )
    .bind(org)
    .bind(channel)
    .execute(&pool)
    .await
    .unwrap();
    sqlx::raw_sql(
        &std::fs::read_to_string(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("migrations")
                .join(boundary),
        )
        .unwrap(),
    )
    .execute(&pool)
    .await
    .unwrap();
    let expected = [
        (
            root,
            1,
            send_digest(channel, "root", Some("mixed case"), None),
        ),
        (reply, 2, send_digest(channel, "reply", None, Some(root))),
        (main, 3, send_digest(channel, "main", None, None)),
        (
            main_reply,
            4,
            send_digest(channel, "main reply", None, Some(main)),
        ),
    ];
    let trigger_properties = async || -> Value {
        sqlx::query_scalar(
            "SELECT to_jsonb(p) - 'prosrc' FROM pg_proc p
             WHERE p.oid='public.fukulow_message_created()'::regprocedure",
        )
        .fetch_one(&pool)
        .await
        .unwrap()
    };
    let original_properties = trigger_properties().await;
    for upgraded in [false, true] {
        if upgraded {
            apply_migrations_after(&pool, boundary).await;
            assert_eq!(trigger_properties().await, original_properties);
        }
        for (message, seq, digest) in &expected {
            assert_eq!(
                stored(&pool, org, *message).await,
                (*seq, *seq, digest.clone())
            );
        }
        // Evaluate both trigger versions against identical intents, including
        // the same parent ids for both Replies. Keep the backfilled rows for upgrade.
        let mut tx = pool.begin().await.unwrap();
        let inserted: Vec<(i64, i64, Vec<u8>)> = sqlx::query_as(
            "WITH copies AS (
                INSERT INTO messages (organization_id, id, channel_id, seq, sender, client_message_id, body, topic_id, reply_to_id, reply_root_id)
                SELECT organization_id, gen_random_uuid(), channel_id, seq+4, sender, gen_random_uuid(), body, topic_id, reply_to_id, reply_root_id
                FROM messages WHERE organization_id=$1 AND channel_id=$2
                RETURNING seq, version, send_digest
             ) SELECT seq, version, send_digest FROM copies ORDER BY seq",
        )
        .bind(org)
        .bind(channel)
        .fetch_all(&mut *tx)
        .await
        .unwrap();
        assert_eq!(
            inserted,
            expected
                .each_ref()
                .map(|(_, seq, digest)| (seq + 4, seq + 4, digest.clone()))
        );
        tx.rollback().await.unwrap();
    }
}

#[fukulow_test::test]
async fn send_receipt_for_null_topic_does_not_read_topics(pool: PgPool) {
    let (_, org, sender, channel, _) = fixture(&pool).await;
    let app_pool = crate::test_app_pool(pool.clone()).await;
    // Removing SELECT makes even an empty Topic lookup fail under the invoker.
    sqlx::query("REVOKE SELECT ON public.topics FROM fukulow_sqlx_test_app")
        .execute(&pool)
        .await
        .unwrap();
    let (version, digest): (i64, Vec<u8>) =
        crate::database::organization(&app_pool, org, async |tx: &mut sqlx::PgConnection| {
            sqlx::query_as(
                "INSERT INTO messages (organization_id, id, channel_id, seq, sender, client_message_id, body)
                 VALUES ($1,gen_random_uuid(),$2,1,$3,gen_random_uuid(),'main')
                 RETURNING version, send_digest",
            )
            .bind(org)
            .bind(channel)
            .bind(sender)
            .fetch_one(tx)
            .await
        })
        .await
        .unwrap();
    assert_eq!(
        (version, digest),
        (1, send_digest(channel, "main", None, None))
    );
}

fn operation(actor: Uuid, channel: Uuid, target: Uuid) -> Operation {
    Operation {
        actor,
        operation_id: Uuid::new_v4(),
        kind: Kind::Edit,
        channel,
        target,
        intent: [7; 32].into(),
    }
}

async fn resolve(pool: &PgPool, org: Uuid, op: Operation) -> Resolution {
    crate::database::organization(pool, org, async |tx: &mut sqlx::PgConnection| {
        receipts::resolve(tx, org, &op).await
    })
    .await
    .unwrap()
}

async fn record(pool: &PgPool, org: Uuid, op: Operation, outcome: Outcome) -> bool {
    crate::database::organization(pool, org, async |tx: &mut sqlx::PgConnection| {
        receipts::record(tx, org, &op, outcome).await
    })
    .await
    .unwrap()
}

#[fukulow_test::test]
async fn operation_receipts_answer_same_intent_conflict_otherwise_and_expire_after_seven_days(
    pool: PgPool,
) {
    let (app, org, actor, channel, token) = fixture(&pool).await;
    let target = id(
        &sent(&app, &token, channel, input(Uuid::new_v4(), "target")).await,
        "id",
    );
    let app_pool = crate::test_app_pool(pool.clone()).await;
    let op = operation(actor, channel, target);
    let outcome = Outcome {
        version: 4,
        deleted: false,
        event_seq: None,
    };
    assert_eq!(resolve(&app_pool, org, op).await, Resolution::New);
    assert!(record(&app_pool, org, op, outcome).await);
    assert_eq!(
        resolve(&app_pool, org, op).await,
        Resolution::Committed(outcome)
    );
    // A fresh receipt is never replaced, even by the same operation.
    assert!(
        !record(
            &app_pool,
            org,
            op,
            Outcome {
                version: 9,
                deleted: true,
                event_seq: None,
            }
        )
        .await
    );
    assert_eq!(
        resolve(&app_pool, org, op).await,
        Resolution::Committed(outcome)
    );
    for changed in [
        Operation {
            kind: Kind::Delete,
            ..op
        },
        Operation {
            kind: Kind::Move,
            ..op
        },
        Operation {
            channel: Uuid::new_v4(),
            ..op
        },
        Operation {
            target: Uuid::new_v4(),
            ..op
        },
        Operation {
            intent: [8; 32].into(),
            ..op
        },
    ] {
        assert_eq!(resolve(&app_pool, org, changed).await, Resolution::Conflict);
    }
    // Keys are per actor: another Member's identical operation id is new.
    let other = Uuid::new_v4();
    member(&pool, org, other).await;
    assert_eq!(
        resolve(&app_pool, org, Operation { actor: other, ..op }).await,
        Resolution::New
    );

    // Just inside the lifetime it still answers; past it, it is a new request
    // and recording replaces it.
    for (age, expected) in [
        ("6 days 23 hours", Resolution::Committed(outcome)),
        ("7 days 1 second", Resolution::New),
    ] {
        sqlx::query(&format!("UPDATE operation_receipts SET created_at = now() - interval '{age}' WHERE organization_id=$1"))
            .bind(org).execute(&pool).await.unwrap();
        assert_eq!(resolve(&app_pool, org, op).await, expected, "{age}");
    }
    let replaced = Outcome {
        version: 11,
        deleted: true,
        event_seq: None,
    };
    assert!(
        record(
            &app_pool,
            org,
            Operation {
                kind: Kind::Delete,
                ..op
            },
            replaced
        )
        .await
    );
    assert_eq!(
        resolve(
            &app_pool,
            org,
            Operation {
                kind: Kind::Delete,
                ..op
            }
        )
        .await,
        Resolution::Committed(replaced)
    );
    assert_eq!(resolve(&app_pool, org, op).await, Resolution::Conflict);
}

#[fukulow_test::test]
async fn operation_receipts_are_invisible_and_unwritable_across_organizations(pool: PgPool) {
    let (app, org, actor, channel, token) = fixture(&pool).await;
    let target = id(
        &sent(&app, &token, channel, input(Uuid::new_v4(), "target")).await,
        "id",
    );
    let (_, foreign, foreign_actor, foreign_channel, _) = fixture(&pool).await;
    let app_pool = crate::test_app_pool(pool.clone()).await;
    let op = operation(actor, channel, target);
    let outcome = Outcome {
        version: 2,
        deleted: false,
        event_seq: None,
    };
    assert!(record(&app_pool, org, op, outcome).await);
    // Another Organization's context sees nothing under the same key.
    assert_eq!(resolve(&app_pool, foreign, op).await, Resolution::New);
    // Writing A's key from B's context is rejected by the scoped keys and RLS.
    let error =
        crate::database::organization(&app_pool, foreign, async |tx: &mut sqlx::PgConnection| {
            receipts::record(tx, org, &op, outcome).await
        })
        .await
        .unwrap_err();
    assert_eq!(
        error.as_database_error().unwrap().code().as_deref(),
        Some("42501")
    );
    // Control: B records its own operation with the same operation id.
    let own = Operation {
        actor: foreign_actor,
        channel: foreign_channel,
        ..op
    };
    assert!(record(&app_pool, foreign, own, outcome).await);
    assert_eq!(
        resolve(&app_pool, org, op).await,
        Resolution::Committed(outcome)
    );
    // Scoped foreign keys reject a foreign actor or Channel even for the owner.
    for (actor, channel) in [(foreign_actor, channel), (actor, foreign_channel)] {
        let error = sqlx::query("INSERT INTO operation_receipts (organization_id, actor, operation_id, kind, channel_id, target_id, intent_digest, outcome_version, outcome_deleted) VALUES ($1,$2,gen_random_uuid(),'edit',$3,gen_random_uuid(),sha256('x'::bytea),1,false)")
            .bind(org).bind(actor).bind(channel).execute(&pool).await.unwrap_err();
        assert_eq!(
            error.as_database_error().unwrap().code().as_deref(),
            Some("23503")
        );
    }
}

#[fukulow_test::test]
async fn send_receipt_normalizes_only_ascii_topic_case_like_topics(pool: PgPool) {
    let (app, org, _, channel, token) = fixture(&pool).await;
    let key = Uuid::new_v4();
    let first = sent(
        &app,
        &token,
        channel,
        json!({"client_message_id":key,"body":"b","topic_name":"Äb"}),
    )
    .await;
    assert_eq!(
        stored(&pool, org, id(&first, "id")).await.2,
        send_digest(channel, "b", Some("Äb"), None)
    );
    let same = sent(
        &app,
        &token,
        channel,
        json!({"client_message_id":key,"body":"b","topic_name":"ÄB"}),
    )
    .await;
    assert_eq!(same["id"], first["id"]);
    // Topics keep non-ASCII case distinct, so the receipt does too.
    assert_error(
        send(
            &app,
            &token,
            channel,
            json!({"client_message_id":key,"body":"b","topic_name":"äb"}),
        )
        .await,
        StatusCode::CONFLICT,
    )
    .await;
}

#[fukulow_test::test]
async fn operation_receipt_purge_is_scoped_and_retains_unexpired_outcomes(pool: PgPool) {
    let (_, org, actor, channel, _) = fixture(&pool).await;
    let (_, other, peer, other_channel, _) = fixture(&pool).await;
    let app_pool = crate::test_app_pool(pool.clone()).await;
    let outcome = Outcome {
        version: 1,
        deleted: false,
        event_seq: Some(1),
    };
    let expired = operation(actor, channel, Uuid::new_v4());
    let current = operation(actor, channel, Uuid::new_v4());
    let foreign = operation(peer, other_channel, Uuid::new_v4());
    for (scope, op) in [(org, expired), (org, current), (other, foreign)] {
        assert!(record(&app_pool, scope, op, outcome).await);
    }
    sqlx::query("UPDATE operation_receipts SET created_at=now()-interval '8 days'
                 WHERE (organization_id=$1 AND operation_id=$2) OR (organization_id=$3 AND operation_id=$4)")
        .bind(org).bind(expired.operation_id).bind(other).bind(foreign.operation_id)
        .execute(&pool).await.unwrap();
    assert_eq!(receipts::purge(&app_pool, org).await.unwrap(), 1);
    assert_eq!(receipts::purge(&app_pool, org).await.unwrap(), 0);
    assert_eq!(
        resolve(&app_pool, org, current).await,
        Resolution::Committed(outcome)
    );
    assert_eq!(receipts::purge(&app_pool, other).await.unwrap(), 1);
}
