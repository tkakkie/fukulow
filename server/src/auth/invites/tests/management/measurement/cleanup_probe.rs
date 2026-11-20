use super::*;
use crate::auth::invites::cleanup::{BATCH_SIZE, BATCH_SQL, batch, delete_batch, lock_batch};
use sqlx::{PgConnection, PgPool};
use tokio::{sync::oneshot, task::JoinHandle};

const CLEANUP_INDEXES: [&str; 3] = [
    "invites_cleanup_accepted",
    "invites_cleanup_expired",
    "invites_cleanup_revoked",
];

async fn seed_eligible(pool: &PgPool, org: Uuid, issuer: Uuid, count: i64) {
    sqlx::query(
        "INSERT INTO invites (organization_id,id,created_by,email,role,token_hash,created_at,expires_at,accepted_at,revoked_at) \
         SELECT $1,gen_random_uuid(),$2,'cleanup@perf.invalid','member', \
         sha256(convert_to(gen_random_uuid()::text,'UTF8')), now()-interval '38 days', \
         now()-CASE WHEN n%3=0 THEN interval '31 days' ELSE interval '1 day' END, \
         CASE WHEN n%3=1 THEN now()-interval '31 days' END, \
         CASE WHEN n%3=2 THEN now()-interval '31 days' END \
         FROM generate_series(1,$3) n",
    )
    .bind(org)
    .bind(issuer)
    .bind(count)
    .execute(pool)
    .await
    .unwrap();
}

async fn explain_batch(app: &PgPool, org: Uuid, generic: bool) -> Value {
    let mut tx = app.begin().await.unwrap();
    crate::database::set_organization(&mut tx, org)
        .await
        .unwrap();
    sqlx::query("SELECT set_config('plan_cache_mode',$1,true)")
        .bind(if generic {
            "force_generic_plan"
        } else {
            "force_custom_plan"
        })
        .execute(&mut *tx)
        .await
        .unwrap();
    lock_batch(&mut tx, org).await.unwrap();
    let plan = sqlx::query_scalar(&format!(
        "EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) {BATCH_SQL}"
    ))
    .bind(org)
    .bind(BATCH_SIZE)
    .fetch_one(&mut *tx)
    .await
    .unwrap();
    tx.rollback().await.unwrap();
    plan
}

pub(super) async fn plans_and_batch_samples(
    admin: &PgPool,
    app: &PgPool,
    org: Uuid,
    issuer: Uuid,
    count: i32,
    samples: usize,
) {
    seed_eligible(admin, org, issuer, BATCH_SIZE).await;
    sqlx::query("VACUUM ANALYZE invites")
        .execute(admin)
        .await
        .unwrap();
    let mut indexes = Vec::<String>::new();
    for name in CLEANUP_INDEXES {
        let index = sqlx::query_scalar("SELECT pg_get_indexdef($1::text::regclass)")
            .bind(name)
            .fetch_one(admin)
            .await
            .unwrap();
        indexes.push(index);
        sqlx::query(&format!("DROP INDEX {name}"))
            .execute(admin)
            .await
            .unwrap();
    }
    for variant in ["before", "after"] {
        if variant == "after" {
            for index in &indexes {
                sqlx::raw_sql(index).execute(admin).await.unwrap();
            }
            sqlx::query("ANALYZE invites").execute(admin).await.unwrap();
        }
        for generic in [false, true] {
            let plan = explain_batch(app, org, generic).await;
            println!(
                "INVITE_CLEANUP_PLAN {}",
                json!({"count":count,"variant":variant,"generic":generic,"plan":plan})
            );
        }
    }

    let (id, owner_cursor, admin_cursor): (Uuid, Uuid, Uuid) = sqlx::query_as(
        "SELECT id,owner_cursor,admin_cursor FROM invites WHERE organization_id=$1 AND email='cleanup@perf.invalid' LIMIT 1",
    ).bind(org).fetch_one(admin).await.unwrap();
    let mut times = Vec::with_capacity(samples);
    for sample in 0..samples {
        if sample > 0 {
            seed_eligible(admin, org, issuer, BATCH_SIZE).await;
        }
        let start = Instant::now();
        assert_eq!(batch(app, org).await.unwrap(), BATCH_SIZE as u64);
        times.push(start.elapsed().as_secs_f64() * 1000.0);
    }
    println!(
        "INVITE_CLEANUP_BATCH {}",
        json!({"count":count,"batch_size":BATCH_SIZE,"ms":distribution(times)})
    );
    sqlx::query("ANALYZE invite_tombstones")
        .execute(admin)
        .await
        .unwrap();
    for (owner, cursor) in [(true, owner_cursor), (false, admin_cursor)] {
        let (opaque, boundary): (Value, Value) =
            crate::database::organization(app, org, async |tx: &mut PgConnection| {
                let opaque = sqlx::query_scalar(&format!(
                    "EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) {}",
                    anchor_sql(owner)
                ))
                .bind(org)
                .bind(cursor)
                .bind(owner)
                .fetch_one(&mut *tx)
                .await?;
                let boundary = sqlx::query_scalar(&format!(
                    "EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) {LIST_SQL}"
                ))
                .bind(org)
                .bind(owner)
                .bind(id)
                .fetch_one(&mut *tx)
                .await?;
                Ok::<_, sqlx::Error>((opaque, boundary))
            })
            .await
            .unwrap();
        println!(
            "INVITE_TOMBSTONE_PLAN {}",
            json!({"count":count,"owner":owner,"opaque":opaque,"list_with_boundary":boundary})
        );
    }
}

pub(super) async fn start_burst(
    admin: &PgPool,
    app: &PgPool,
    org: Uuid,
    issuer: Uuid,
) -> JoinHandle<()> {
    const BATCHES: i64 = 4;
    seed_eligible(admin, org, issuer, BATCHES * BATCH_SIZE).await;
    let (started, ready) = oneshot::channel();
    let app = app.clone();
    let task = tokio::spawn(async move {
        crate::database::organization(&app, org, async |tx: &mut PgConnection| {
            lock_batch(tx, org).await?;
            started.send(()).unwrap();
            assert_eq!(delete_batch(tx, org).await?, BATCH_SIZE as u64);
            Ok::<_, ApiError>(())
        })
        .await
        .unwrap();
        for _ in 1..BATCHES {
            assert_eq!(batch(&app, org).await.unwrap(), BATCH_SIZE as u64);
        }
    });
    ready.await.unwrap();
    task
}
