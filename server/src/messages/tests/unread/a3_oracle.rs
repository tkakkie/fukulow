use super::{
    measurement::PRE_A3,
    roles::{grant, revoke, role},
    *,
};
use crate::test_support::{Advisory, Blocked, Count, wait_blocked};
use sqlx::Row;
use std::time::Duration;

mod projection;
mod scope_totals;

const SEEDS: [u64; 3] = [0x0051_9519, 0xa3a3_a3a3, 0x0dd5_eed5];
const STEPS: usize = 160;

// Deterministic so a failing seed reproduces; no dependency for a test-only PRNG.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }

    fn below(&mut self, n: usize) -> usize {
        (self.next() % n as u64) as usize
    }
}

struct World {
    app: Router,
    reader: PgPool,
    org: Uuid,
    channels: [Uuid; 2],
    members: Vec<(Uuid, String)>,
}

const COLUMNS: [&str; 7] = [
    "as_of_seq",
    "read_seq",
    "main_unread_count",
    "unread_count",
    "main_mention_unread_count",
    "mention_unread_count",
    "missing_position",
];

impl World {
    async fn visible(&self, pool: &PgPool, member: Uuid, channel: Uuid) -> bool {
        sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM channel_read_positions p JOIN users u ON u.organization_id=p.organization_id \
             AND u.id=p.member_id AND u.deactivated_at IS NULL WHERE p.organization_id=$1 AND p.member_id=$2 AND p.channel_id=$3)",
        )
        .bind(self.org).bind(member).bind(channel).fetch_one(pool).await.unwrap()
    }

    async fn revision(&self, pool: &PgPool, member: Uuid) -> i64 {
        sqlx::query_scalar(
            "SELECT membership_revision FROM users WHERE organization_id=$1 AND id=$2",
        )
        .bind(self.org)
        .bind(member)
        .fetch_one(pool)
        .await
        .unwrap()
    }

    // Both arms read the same positions, as `fukulow_app` with RLS, in each plan mode.
    async fn assert_oracle(&self, pool: &PgPool, step: &str) {
        assert_check(pool, self.org, step).await;
        for (member, _) in &self.members {
            let revision = self.revision(pool, *member).await;
            for mode in ["force_custom_plan", "force_generic_plan"] {
                let before = counts(
                    &self.reader,
                    self.org,
                    *member,
                    revision,
                    &self.channels,
                    PRE_A3,
                    mode,
                )
                .await;
                let after = counts(
                    &self.reader,
                    self.org,
                    *member,
                    revision,
                    &self.channels,
                    crate::messages::unread::LIST_COUNTS_SQL,
                    mode,
                )
                .await;
                assert_eq!(before, after, "{step} {mode} member={member}");
            }
        }
    }
}

async fn assert_check(pool: &PgPool, org: Uuid, step: &str) {
    let check: Vec<(String, Uuid, Uuid, Uuid, i64, i64)> = sqlx::query_as(
        "SELECT kind,channel_id,scope_id,member_id,expected,actual FROM message_counts_check($1)",
    )
    .bind(org)
    .fetch_all(pool)
    .await
    .unwrap();
    assert!(check.is_empty(), "{step}: {check:?}");
}

// One prepared execution, ordered by Channel; A3 rows must also report no drift.
async fn counts(
    reader: &PgPool,
    org: Uuid,
    member: Uuid,
    revision: i64,
    channels: &[Uuid],
    sql: &str,
    mode: &str,
) -> Vec<Vec<i64>> {
    let ids = channels
        .iter()
        .map(|c| format!("'{c}'"))
        .collect::<Vec<_>>()
        .join(",");
    let mut tx = reader.begin().await.unwrap();
    crate::database::set_organization(&mut tx, org)
        .await
        .unwrap();
    sqlx::query(&format!("SET LOCAL plan_cache_mode={mode}"))
        .execute(&mut *tx)
        .await
        .unwrap();
    sqlx::raw_sql(&format!(
        "PREPARE oracle519(uuid,uuid,bigint,uuid[]) AS {sql}"
    ))
    .execute(&mut *tx)
    .await
    .unwrap();
    let mut rows = sqlx::query(&format!(
        "EXECUTE oracle519('{org}','{member}',{revision},ARRAY[{ids}]::uuid[])"
    ))
    // The EXECUTE text is the same for both queries; a cached description would be stale.
    .persistent(false)
    .fetch_all(&mut *tx)
    .await
    .unwrap();
    // A prepared statement outlives the transaction on the pooled connection.
    sqlx::raw_sql("DEALLOCATE oracle519")
        .execute(&mut *tx)
        .await
        .unwrap();
    tx.rollback().await.unwrap();
    rows.sort_by_key(|row| row.get::<Uuid, _>("channel_id"));
    if sql == crate::messages::unread::LIST_COUNTS_SQL {
        assert!(
            rows.iter().all(|row| !row.get::<bool, _>("count_drift")),
            "drift"
        );
    }
    rows.iter()
        .map(|row| {
            COLUMNS
                .iter()
                .map(|c| match *c {
                    "missing_position" => i64::from(row.get::<bool, _>(*c)),
                    _ => row.get::<i64, _>(*c),
                })
                .collect()
        })
        .collect()
}

async fn assert_topic_summaries(pool: &PgPool, org: Uuid, channel: Uuid, context: &str) {
    let mismatches: Vec<Uuid> = sqlx::query_scalar(
        "SELECT t.id FROM topics t
         LEFT JOIN messages m ON m.organization_id=t.organization_id AND m.channel_id=t.channel_id
             AND m.topic_id=t.id AND NOT m.deleted
         WHERE t.organization_id=$1 AND t.channel_id=$2
         GROUP BY t.organization_id,t.id
         HAVING (t.message_count,t.first_seq,t.last_seq)
             IS DISTINCT FROM (count(m.id),min(m.seq),max(m.seq))",
    )
    .bind(org)
    .bind(channel)
    .fetch_all(pool)
    .await
    .unwrap();
    assert!(
        mismatches.is_empty(),
        "{context}: Topic summary drift in {mismatches:?}"
    );
}

/// Direct SQL mutations bypass the Topic summary writer and the mutation floor.
/// Repair both before comparing a projection at a reconstructible W.
async fn resync_topics(pool: &PgPool, org: Uuid, channel: Uuid) {
    sqlx::query("UPDATE topics t SET message_count=s.n, first_seq=s.first, last_seq=s.last \
        FROM (SELECT t2.id, count(m.id) AS n, min(m.seq) AS first, max(m.seq) AS last FROM topics t2 \
              LEFT JOIN messages m ON m.organization_id=t2.organization_id AND m.channel_id=t2.channel_id AND m.topic_id=t2.id AND NOT m.deleted \
              WHERE t2.organization_id=$1 AND t2.channel_id=$2 GROUP BY t2.id) s \
        WHERE t.organization_id=$1 AND t.channel_id=$2 AND t.id=s.id")
        .bind(org).bind(channel).execute(pool).await.unwrap();
    sqlx::query("UPDATE channel_message_sequences SET mutation_seq=seq WHERE organization_id=$1 AND channel_id=$2")
        .bind(org).bind(channel).execute(pool).await.unwrap();
}

async fn step(
    world: &World,
    pool: &PgPool,
    rng: &mut Rng,
    sent_keys: &mut Vec<(usize, Uuid, Uuid, Value)>,
) -> String {
    let org = world.org;
    let channel = world.channels[rng.below(2)];
    let actor = rng.below(world.members.len());
    let (actor_id, token) = &world.members[actor];
    match rng.below(14) {
        0..=4 => {
            if !world.visible(pool, *actor_id, channel).await {
                return "send skipped".into();
            }
            let topic = ["", "T1", "T2", "T3"][rng.below(4)];
            let target = world.members[rng.below(world.members.len())].0;
            let text = if rng.below(3) == 0 {
                format!("@{{member:{target}}} hi")
            } else {
                "hi".into()
            };
            let key = Uuid::new_v4();
            let value = json!({"client_message_id":key,"body":text,"topic_name":(!topic.is_empty()).then_some(topic)});
            let status = send(&world.app, token, channel, value.clone())
                .await
                .status();
            assert!(status.is_success(), "send {status}");
            sent_keys.push((actor, channel, key, value));
            assert_topic_summaries(pool, org, channel, "after send").await;
            format!("send {actor} {topic}")
        }
        5 => {
            // A duplicate retry is idempotent and must not count again.
            let Some((author, channel, _, value)) =
                sent_keys.get(rng.below(sent_keys.len().max(1))).cloned()
            else {
                return "retry skipped".into();
            };
            let status = send(&world.app, &world.members[author].1, channel, value)
                .await
                .status();
            format!("retry {status}")
        }
        6 | 7 => {
            if !world.visible(pool, *actor_id, channel).await {
                return "mark skipped".into();
            }
            let top: i64 = sqlx::query_scalar("SELECT COALESCE(max(seq),0) FROM channel_message_sequences WHERE organization_id=$1 AND channel_id=$2")
                .bind(org).bind(channel).fetch_one(pool).await.unwrap();
            let seq = rng.below(top as usize + 3) as i64;
            let topic: Option<Uuid> = if rng.below(2) == 0 {
                sqlx::query_scalar("SELECT id FROM topics WHERE organization_id=$1 AND channel_id=$2 ORDER BY name_key OFFSET $3 LIMIT 1")
                    .bind(org).bind(channel).bind(rng.below(4) as i64).fetch_optional(pool).await.unwrap()
            } else {
                None
            };
            mark(
                &world.app,
                token,
                channel,
                topic.map(|t| t.to_string()).as_deref(),
                seq,
            )
            .await;
            format!("mark {actor} {topic:?} {seq}")
        }
        8 => {
            // The pre-A3 writer form: the trigger computes the ordinals, not the writer.
            let topic: Option<Uuid> = sqlx::query_scalar("SELECT id FROM topics WHERE organization_id=$1 AND channel_id=$2 ORDER BY name_key LIMIT 1")
                .bind(org).bind(channel).fetch_optional(pool).await.unwrap();
            let Some(topic) = topic else {
                return "upsert skipped".into();
            };
            let seq = rng.below(60) as i64;
            sqlx::query("INSERT INTO topic_read_positions (organization_id,channel_id,member_id,topic_id,read_seq) \
                SELECT $1,$2,$3,$4,LEAST($5,(SELECT seq FROM channel_message_sequences WHERE organization_id=$1 AND channel_id=$2)) \
                WHERE EXISTS(SELECT 1 FROM channel_read_positions WHERE organization_id=$1 AND channel_id=$2 AND member_id=$3) \
                ON CONFLICT (organization_id,channel_id,member_id,topic_id) DO UPDATE SET read_seq=GREATEST(topic_read_positions.read_seq,EXCLUDED.read_seq)")
                .bind(org).bind(channel).bind(actor_id).bind(topic).bind(seq).execute(pool).await.unwrap();
            format!("upsert {actor} {seq}")
        }
        9 => {
            let root: Option<(Uuid, i64)> = sqlx::query_as("SELECT id,version FROM messages WHERE organization_id=$1 AND channel_id=$2 AND reply_to_id IS NULL ORDER BY seq OFFSET $3 LIMIT 1")
                .bind(org).bind(channel).bind(rng.below(8) as i64).fetch_optional(pool).await.unwrap();
            let Some((root, version)) = root else {
                return "move skipped".into();
            };
            // Move's Topic summary arithmetic counts every chain row; deleted rows only
            // exist here through direct SQL until #287 adds a Delete writer.
            let deleted: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM messages WHERE organization_id=$1 AND channel_id=$2 AND (id=$3 OR reply_root_id=$3) AND deleted)")
                .bind(org).bind(channel).bind(root).fetch_one(pool).await.unwrap();
            if deleted {
                return "move skipped: deleted chain".into();
            }
            let name = ["T1", "T2", "T3", "T4"][rng.below(4)];
            let response = request(
                &world.app,
                "POST",
                &format!("/api/v1/channels/{channel}/messages/{root}/move"),
                &world.members[0].1,
                json!({"operation_id":Uuid::new_v4(),"expected_version":version,"topic_name":name}),
            )
            .await;
            let status = response.status();
            assert!(!status.is_server_error(), "move {status}");
            if status.is_success() {
                if let Some(seq) = body(response).await["move_seq"].as_i64() {
                    let floor: i64 = sqlx::query_scalar(
                        "SELECT mutation_seq FROM channel_message_sequences WHERE organization_id=$1 AND channel_id=$2",
                    )
                    .bind(org).bind(channel).fetch_one(pool).await.unwrap();
                    assert_eq!(floor, seq, "Move must advance the floor");
                }
                assert_topic_summaries(pool, org, channel, "after Move").await;
            }
            format!("move {root} {name} {status}")
        }
        10 => {
            // Topic to main timeline is not an API operation; exercise the trigger directly.
            assert_topic_summaries(pool, org, channel, "before Topic to main").await;
            let n = sqlx::query("UPDATE messages SET topic_id=NULL WHERE organization_id=$1 AND channel_id=$2 AND id=(SELECT id FROM messages WHERE organization_id=$1 AND channel_id=$2 AND topic_id IS NOT NULL ORDER BY seq OFFSET $3 LIMIT 1)")
                .bind(org).bind(channel).bind(rng.below(5) as i64).execute(pool).await.unwrap().rows_affected();
            resync_topics(pool, org, channel).await;
            format!("to main {n}")
        }
        11 => {
            assert_topic_summaries(pool, org, channel, "before delete toggle").await;
            let n = sqlx::query("UPDATE messages SET deleted=NOT deleted WHERE organization_id=$1 AND channel_id=$2 AND id=(SELECT id FROM messages WHERE organization_id=$1 AND channel_id=$2 ORDER BY seq OFFSET $3 LIMIT 1)")
                .bind(org).bind(channel).bind(rng.below(10) as i64).execute(pool).await.unwrap().rows_affected();
            resync_topics(pool, org, channel).await;
            format!("delete toggle {n}")
        }
        12 => {
            let target = world.members[1 + rng.below(world.members.len() - 1)].0;
            match rng.below(5) {
                0 => grant(pool, org, world.channels[1], target).await,
                1 => revoke(pool, org, world.channels[1], target).await,
                2 => role(pool, org, target, ["member", "guest"][rng.below(2)]).await,
                3 => {
                    sqlx::query("UPDATE users SET deactivated_at=CASE WHEN deactivated_at IS NULL THEN now() END WHERE organization_id=$1 AND id=$2")
                        .bind(org).bind(target).execute(pool).await.unwrap();
                }
                _ => grant(pool, org, world.channels[0], target).await,
            }
            format!("access {target}")
        }
        _ => {
            let channel = world.channels[rng.below(2)];
            sqlx::query("UPDATE channels SET visibility=CASE visibility WHEN 'public' THEN 'private' ELSE 'public' END WHERE organization_id=$1 AND id=$2")
                .bind(org).bind(channel).execute(pool).await.unwrap();
            format!("visibility {channel}")
        }
    }
}

impl World {
    // Member 0 is the owner; Channel 1 is private with Member 1 granted.
    async fn new(pool: &PgPool) -> Self {
        let org = organization(pool).await;
        let mut members = Vec::new();
        for _ in 0..4 {
            let id = Uuid::new_v4();
            members.push((id, member(pool, org, id).await));
        }
        role(pool, org, members[0].0, "owner").await;
        let channels = [Uuid::new_v4(), Uuid::new_v4()];
        channel(pool, org, channels[0], members[0].0, false).await;
        channel(pool, org, channels[1], members[0].0, true).await;
        grant(pool, org, channels[1], members[1].0).await;
        Self {
            app: router(pool).await,
            reader: crate::test_app_pool(pool.clone()).await,
            org,
            channels,
            members,
        }
    }

    async fn all_counts(&self, pool: &PgPool, sql: &str) -> Vec<Vec<Vec<i64>>> {
        let mut all = Vec::new();
        for (member, _) in &self.members {
            let revision = self.revision(pool, *member).await;
            all.push(
                counts(
                    &self.reader,
                    self.org,
                    *member,
                    revision,
                    &self.channels,
                    sql,
                    "auto",
                )
                .await,
            );
        }
        all
    }
}

// Every mutation path that can change a count, compared after each step against
// the exact pre-A3 query and the full-recount check. One test per seed so nextest
// can run the seeds in parallel and spread them across CI shards (#800). The
// unsuffixed test is seed 0, the name docs/invariants cites.
#[fukulow_test::test]
async fn a3_counts_equal_the_pre_a3_query_after_every_random_step(pool: PgPool) {
    assert_counts_seed(&pool, SEEDS[0]).await;
}

#[fukulow_test::test]
async fn a3_counts_equal_the_pre_a3_query_after_every_random_step_seed_1(pool: PgPool) {
    assert_counts_seed(&pool, SEEDS[1]).await;
}

#[fukulow_test::test]
async fn a3_counts_equal_the_pre_a3_query_after_every_random_step_seed_2(pool: PgPool) {
    assert_counts_seed(&pool, SEEDS[2]).await;
}

async fn assert_counts_seed(pool: &PgPool, seed: u64) {
    let world = World::new(pool).await;
    let mut rng = Rng(seed);
    let mut keys = Vec::new();
    world.assert_oracle(pool, "start").await;
    for n in 0..STEPS {
        let what = step(&world, pool, &mut rng, &mut keys).await;
        world
            .assert_oracle(pool, &format!("seed {seed:x} step {n}: {what}"))
            .await;
    }
    let counted: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM message_count_corrections WHERE organization_id=$1",
    )
    .bind(world.org)
    .fetch_one(pool)
    .await
    .unwrap();
    // The run must reach the correction path, not only appends.
    assert!(
        counted > 0 && keys.len() > 20,
        "seed {seed:x}: {counted} {}",
        keys.len()
    );
    world.reader.close().await;
}

// Concurrent sends, marks and Moves serialize on the Channel counter and lock 135;
// a send whose transaction rolls back leaves no count, one that commits counts once.
#[fukulow_test::test]
async fn a3_counts_stay_exact_under_concurrent_sends_marks_moves_and_ambiguous_commits(
    pool: PgPool,
) {
    let world = std::sync::Arc::new(World::new(&pool).await);
    let channel = world.channels[0];
    for (n, topic) in [None, Some("C1"), Some("C2")].into_iter().enumerate() {
        sent(
            &world.app,
            &world.members[n].1,
            channel,
            json!({"client_message_id":Uuid::new_v4(),"body":"seed","topic_name":topic}),
        )
        .await;
    }
    for commit in [false, true] {
        let key = Uuid::new_v4();
        let pending = crate::messages::commit::ambiguous_commit(key);
        let target = world.members[2].0;
        let status = send(&world.app, &world.members[1].1, channel, json!({"client_message_id":key,"body":format!("@{{member:{target}}}"),"topic_name":"C1"})).await.status();
        assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
        let mut tx = pending.await.unwrap();
        let blocker: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
            .fetch_one(tx.connection().unwrap())
            .await
            .unwrap();
        let mut tasks = Vec::new();
        for task in 0..12usize {
            let world = world.clone();
            tasks.push(tokio::spawn(async move {
                let (_, token) = &world.members[task % 4];
                match task % 4 {
                    0 | 1 => {
                        let target = world.members[(task + 1) % 4].0;
                        let topic = [None, Some("C1"), Some("C2")][task % 3];
                        let status = send(&world.app, token, channel, json!({"client_message_id":Uuid::new_v4(),"body":format!("@{{member:{target}}}"),"topic_name":topic})).await.status();
                        assert!(status.is_success(), "{status}");
                    }
                    2 => {
                        mark(&world.app, token, channel, None, i64::MAX).await;
                    }
                    _ => {
                        let root: Option<(Uuid, i64)> = sqlx::query_as("SELECT id,version FROM messages WHERE organization_id=$1 AND channel_id=$2 AND reply_to_id IS NULL ORDER BY seq LIMIT 1")
                            .bind(world.org).bind(channel).fetch_optional(&world.reader).await.unwrap();
                        if let Some((root, version)) = root {
                            let response = request(&world.app, "POST", &format!("/api/v1/channels/{channel}/messages/{root}/move"), &world.members[0].1,
                                json!({"operation_id":Uuid::new_v4(),"expected_version":version,"topic_name":format!("C{}", task % 3)})).await;
                            assert!(!response.status().is_server_error(), "{}", response.status());
                        }
                    }
                }
            }));
        }
        // The pending send holds the Channel's writer permit, and the test pool
        // lets two read marks reach the shared advisory lock at once.
        wait_blocked(
            &pool,
            Blocked::Advisory(Advisory::SharedBehind(blocker)),
            Count::Exactly(2),
            Duration::from_secs(5),
        )
        .await;
        if commit {
            tx.commit().await.unwrap();
        } else {
            tx.rollback().await.unwrap();
        }
        for task in tasks {
            task.await.unwrap();
        }
        world
            .assert_oracle(&pool, &format!("commit={commit}"))
            .await;
        let pending: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM messages WHERE organization_id=$1 AND client_message_id=$2",
        )
        .bind(world.org)
        .bind(key)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(pending, i64::from(commit));
    }
}

// The backfill reproduces the pre-A3 counts of a populated database, and statements
// written before the migration (old image) keep the identity afterwards.
#[fukulow_test::test(migrations = false)]
async fn a3_migration_backfill_keeps_counts_of_a_populated_database(pool: PgPool) {
    let mut previous = sqlx::migrate!();
    previous
        .migrations
        .to_mut()
        .retain(|migration| migration.version < 202611221100);
    previous.run(&pool).await.unwrap();
    let world = World::new(&pool).await;
    // Use historical send SQL before F2's columns exist.
    let (sender, _) = world.members[0];
    let (viewer, _) = world.members[1];
    let channel = world.channels[0];
    historical_post(&pool, world.org, sender, channel, None).await;
    historical_post(&pool, world.org, sender, channel, Some("Before A3")).await;
    for n in 2..60 {
        let source = world.channels[n % 2];
        let author = world.members[n % world.members.len()].0;
        let topic = [None, Some("Before A3"), Some("Other")][n % 3];
        historical_post(&pool, world.org, author, source, topic).await;
    }
    sqlx::query(
        "UPDATE messages SET deleted=true WHERE organization_id=$1 AND channel_id=$2 AND seq=4",
    )
    .bind(world.org)
    .bind(channel)
    .execute(&pool)
    .await
    .unwrap();
    resync_topics(&pool, world.org, channel).await;
    sqlx::query("INSERT INTO message_mentions (organization_id,channel_id,message_id,member_id)
        SELECT organization_id,channel_id,id,$3 FROM messages WHERE organization_id=$1 AND channel_id=$2 AND seq=2")
        .bind(world.org).bind(channel).bind(viewer).execute(&pool).await.unwrap();
    sqlx::query("UPDATE channel_read_positions SET read_seq=1 WHERE organization_id=$1 AND channel_id=$2 AND member_id=$3")
        .bind(world.org).bind(channel).bind(viewer).execute(&pool).await.unwrap();
    let before = world.all_counts(&pool, PRE_A3).await;
    assert!(
        before
            .iter()
            .flatten()
            .any(|row| row[3] > row[2] && row[5] > 0),
        "fixture needs Topic Unread and Mentions: {before:?}"
    );
    seed_legacy_creates(&pool, world.org, &world.channels).await;
    sqlx::migrate!().run(&pool).await.unwrap();
    assert_check(&pool, world.org, "after backfill").await;
    assert_eq!(
        world
            .all_counts(&pool, crate::messages::unread::LIST_COUNTS_SQL)
            .await,
        before
    );
    world.assert_oracle(&pool, "after backfill").await;
    let mut rng = Rng(0xb4c7_f111);
    let mut keys = Vec::new();
    for n in 0..30 {
        let what = step(&world, &pool, &mut rng, &mut keys).await;
        world
            .assert_oracle(&pool, &format!("after migration step {n}: {what}"))
            .await;
    }
    world.reader.close().await;
}
