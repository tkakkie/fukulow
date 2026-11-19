use super::{member, organization};
use crate::{database, test_support::TestPools};
use sqlx::{
    Acquire, PgConnection, PgExecutor, PgPool, Postgres, Transaction, postgres::PgQueryResult,
};
use uuid::Uuid;

const INSERT_SECTION: &str =
    "INSERT INTO member_sections (organization_id, member_id, id, name, position)
     VALUES ($1, $2, $3, $4, 0)";
const INSERT_PLACEMENT: &str =
    "INSERT INTO member_section_placements (organization_id, member_id, channel_id, section_id, position)
     VALUES ($1, $2, $3, $4, 0)";
const INSERT_GENERATION: &str =
    "INSERT INTO member_section_generations (organization_id, member_id) VALUES ($1, $2)";
const INSERT_ID: &str =
    "INSERT INTO member_section_ids (organization_id, member_id, id) VALUES ($1, $2, $3)";

async fn channel(pool: &PgPool, org: Uuid) -> Uuid {
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO channels (organization_id, id, name, visibility) VALUES ($1, $2, $2::text, 'private')")
        .bind(org)
        .bind(id)
        .execute(pool)
        .await
        .unwrap();
    id
}

async fn section<'e>(
    executor: impl PgExecutor<'e>,
    org: Uuid,
    owner: Uuid,
    id: Uuid,
    name: &str,
) -> Result<PgQueryResult, sqlx::Error> {
    sqlx::query(INSERT_SECTION)
        .bind(org)
        .bind(owner)
        .bind(id)
        .bind(name)
        .execute(executor)
        .await
}

async fn placement<'e>(
    executor: impl PgExecutor<'e>,
    org: Uuid,
    owner: Uuid,
    channel: Uuid,
    section: Option<Uuid>,
) -> Result<PgQueryResult, sqlx::Error> {
    sqlx::query(INSERT_PLACEMENT)
        .bind(org)
        .bind(owner)
        .bind(channel)
        .bind(section)
        .execute(executor)
        .await
}

fn assert_sqlstate(error: sqlx::Error, expected: &str) {
    assert_eq!(
        error.as_database_error().unwrap().code().as_deref(),
        Some(expected),
        "{error}"
    );
}

// Begin through SQLx so it can track the savepoints used for expected failures.
async fn scoped_transaction(pool: &PgPool, org: Option<Uuid>) -> Transaction<'_, Postgres> {
    let mut tx = pool.begin().await.unwrap();
    if let Some(org) = org {
        database::set_organization(&mut tx, org).await.unwrap();
    }
    tx
}

#[fukulow_test::test]
async fn section_storage_rejects_cross_organization_references(pool: PgPool) {
    let (org, foreign_org) = (organization(&pool).await, organization(&pool).await);
    let (owner, foreign_owner) = (Uuid::new_v4(), Uuid::new_v4());
    member(&pool, org, owner, "member").await;
    member(&pool, foreign_org, owner, "member").await;
    member(&pool, foreign_org, foreign_owner, "member").await;
    let own_channel = channel(&pool, org).await;
    let foreign_channel = channel(&pool, foreign_org).await;
    let (own_section, foreign_section, reserved_id) =
        (Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4());

    for (row_org, row_owner) in [(org, owner), (foreign_org, foreign_owner)] {
        sqlx::query(INSERT_GENERATION)
            .bind(row_org)
            .bind(row_owner)
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query(INSERT_ID)
            .bind(row_org)
            .bind(row_owner)
            .bind(reserved_id)
            .execute(&pool)
            .await
            .unwrap();
    }
    section(&pool, foreign_org, owner, foreign_section, "Foreign")
        .await
        .unwrap();
    section(&pool, foreign_org, foreign_owner, own_section, "Foreign")
        .await
        .unwrap();
    section(&pool, org, owner, own_section, "Own")
        .await
        .unwrap();
    placement(
        &pool,
        foreign_org,
        owner,
        foreign_channel,
        Some(foreign_section),
    )
    .await
    .unwrap();

    for result in [
        section(&pool, org, foreign_owner, own_section, "Own").await,
        sqlx::query(INSERT_ID)
            .bind(org)
            .bind(foreign_owner)
            .bind(reserved_id)
            .execute(&pool)
            .await,
        sqlx::query(INSERT_GENERATION)
            .bind(org)
            .bind(foreign_owner)
            .execute(&pool)
            .await,
        placement(&pool, org, foreign_owner, own_channel, None).await,
        placement(&pool, org, owner, foreign_channel, None).await,
        placement(&pool, org, owner, own_channel, Some(foreign_section)).await,
    ] {
        assert_sqlstate(result.unwrap_err(), "23503");
    }
    placement(&pool, org, owner, own_channel, Some(own_section))
        .await
        .unwrap();
}

#[fukulow_test::test]
async fn section_placement_rejects_another_owners_section(pool: PgPool) {
    let org = organization(&pool).await;
    let (owner, other) = (Uuid::new_v4(), Uuid::new_v4());
    member(&pool, org, owner, "owner").await;
    member(&pool, org, other, "member").await;
    let channel = channel(&pool, org).await;
    let id = Uuid::new_v4();
    section(&pool, org, other, id, "Other").await.unwrap();
    assert_sqlstate(
        placement(&pool, org, owner, channel, Some(id))
            .await
            .unwrap_err(),
        "23503",
    );
    placement(&pool, org, other, channel, Some(id))
        .await
        .unwrap();
    section(&pool, org, owner, id, "Own").await.unwrap();
    placement(&pool, org, owner, channel, Some(id))
        .await
        .unwrap();
}

#[fukulow_test::test]
async fn section_placement_allows_only_one_group_per_channel(pool: PgPool) {
    let org = organization(&pool).await;
    let owner = Uuid::new_v4();
    member(&pool, org, owner, "member").await;
    let id = Uuid::new_v4();
    section(&pool, org, owner, id, "Own").await.unwrap();
    for (first, second) in [(None, Some(id)), (Some(id), None)] {
        let channel = channel(&pool, org).await;
        placement(&pool, org, owner, channel, first).await.unwrap();
        assert_sqlstate(
            placement(&pool, org, owner, channel, second)
                .await
                .unwrap_err(),
            "23505",
        );
        let stored: Option<Uuid> = sqlx::query_scalar(
            "SELECT section_id FROM member_section_placements
             WHERE organization_id = $1 AND member_id = $2 AND channel_id = $3",
        )
        .bind(org)
        .bind(owner)
        .bind(channel)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(stored, first);
    }
}

#[fukulow_test::test]
async fn section_delete_removes_only_its_placements(pool: PgPool) {
    let pools = TestPools::new(pool).await;
    let org = organization(&pools.admin).await;
    let owner = Uuid::new_v4();
    member(&pools.admin, org, owner, "member").await;
    let (removed, kept) = (Uuid::new_v4(), Uuid::new_v4());
    let (first, second, custom, default) = (
        channel(&pools.admin, org).await,
        channel(&pools.admin, org).await,
        channel(&pools.admin, org).await,
        channel(&pools.admin, org).await,
    );
    database::organization(&pools.app, org, async |tx: &mut PgConnection| {
        for id in [removed, kept] {
            section(&mut *tx, org, owner, id, "Same name").await?;
        }
        for (channel, group) in [
            (first, Some(removed)),
            (second, Some(removed)),
            (custom, Some(kept)),
            (default, None),
        ] {
            placement(&mut *tx, org, owner, channel, group).await?;
        }
        let deleted = sqlx::query(
            "DELETE FROM member_sections WHERE organization_id = $1 AND member_id = $2 AND id = $3",
        )
        .bind(org)
        .bind(owner)
        .bind(removed)
        .execute(&mut *tx)
        .await?;
        assert_eq!(deleted.rows_affected(), 1);
        Ok::<_, sqlx::Error>(())
    })
    .await
    .unwrap();

    let mut rows: Vec<(Uuid, Option<Uuid>)> = sqlx::query_as(
        "SELECT channel_id, section_id FROM member_section_placements
         WHERE organization_id = $1 AND member_id = $2",
    )
    .bind(org)
    .bind(owner)
    .fetch_all(&pools.admin)
    .await
    .unwrap();
    rows.sort_unstable();
    let mut expected = [(custom, Some(kept)), (default, None)];
    expected.sort_unstable();
    assert_eq!(rows, expected);
    assert_sqlstate(
        placement(&pools.admin, org, owner, first, Some(removed))
            .await
            .unwrap_err(),
        "23503",
    );
    placement(&pools.admin, org, owner, first, None)
        .await
        .unwrap();
}

#[fukulow_test::test]
async fn section_storage_requires_organization_context(pool: PgPool) {
    const TABLES: [&str; 4] = [
        "member_sections",
        "member_section_placements",
        "member_section_generations",
        "member_section_ids",
    ];
    let pools = TestPools::new(pool).await;
    let (org, foreign_org) = (
        organization(&pools.admin).await,
        organization(&pools.admin).await,
    );
    let owner = Uuid::new_v4();
    let other = Uuid::new_v4();
    for id in [owner, other] {
        member(&pools.admin, org, id, "member").await;
    }
    let id = Uuid::new_v4();
    let channel = channel(&pools.admin, org).await;
    database::organization(&pools.app, org, async |tx: &mut PgConnection| {
        section(&mut *tx, org, owner, id, "Own").await?;
        placement(&mut *tx, org, owner, channel, Some(id)).await?;
        sqlx::query(INSERT_GENERATION)
            .bind(org)
            .bind(owner)
            .execute(&mut *tx)
            .await?;
        for table in TABLES {
            let count: i64 = sqlx::query_scalar(&format!("SELECT count(*) FROM {table}"))
                .fetch_one(&mut *tx)
                .await?;
            assert_eq!(count, 1, "{table}: own row visible");
        }
        Ok::<_, sqlx::Error>(())
    })
    .await
    .unwrap();

    for scope in [None, Some(foreign_org)] {
        let mut tx = scoped_transaction(&pools.app, scope).await;
        for table in TABLES {
            let count: i64 = sqlx::query_scalar(&format!("SELECT count(*) FROM {table}"))
                .fetch_one(&mut *tx)
                .await
                .unwrap();
            assert_eq!(count, 0, "{table}, {scope:?}");
            for sql in [
                format!("UPDATE {table} SET member_id = $1"),
                format!("DELETE FROM {table} WHERE organization_id = $1"),
            ] {
                let affected = sqlx::query(&sql).bind(org).execute(&mut *tx).await.unwrap();
                assert_eq!(affected.rows_affected(), 0, "{sql}, {scope:?}");
            }
        }
        for table in TABLES {
            let mut attempt = tx.begin().await.unwrap();
            let result = match table {
                "member_sections" => section(&mut *attempt, org, other, id, "Other").await,
                "member_section_placements" => {
                    placement(&mut *attempt, org, other, channel, None).await
                }
                "member_section_generations" => {
                    sqlx::query(INSERT_GENERATION)
                        .bind(org)
                        .bind(other)
                        .execute(&mut *attempt)
                        .await
                }
                _ => {
                    sqlx::query(INSERT_ID)
                        .bind(org)
                        .bind(other)
                        .bind(id)
                        .execute(&mut *attempt)
                        .await
                }
            };
            assert_sqlstate(result.unwrap_err(), "42501");
            attempt.rollback().await.unwrap();
        }
        tx.commit().await.unwrap();
    }
}

#[fukulow_test::test]
async fn section_id_reservation_survives_rename_and_delete(pool: PgPool) {
    let pools = TestPools::new(pool).await;
    let org = organization(&pools.admin).await;
    let owner = Uuid::new_v4();
    member(&pools.admin, org, owner, "member").await;
    let id = Uuid::new_v4();
    {
        let mut tx = scoped_transaction(&pools.app, Some(org)).await;
        section(&mut *tx, org, owner, id, "Original　Name")
            .await
            .unwrap();
        let names: (String, String) = sqlx::query_as(
            "UPDATE member_sections SET name = 'Renamed'
             WHERE organization_id = $1 AND member_id = $2 AND id = $3
             RETURNING name, original_name",
        )
        .bind(org)
        .bind(owner)
        .bind(id)
        .fetch_one(&mut *tx)
        .await
        .unwrap();
        assert_eq!(names, ("Renamed".into(), "Original　Name".into()));
        let mut attempt = tx.begin().await.unwrap();
        let error = sqlx::query(
            "UPDATE member_sections SET original_name = name
             WHERE organization_id = $1 AND member_id = $2 AND id = $3",
        )
        .bind(org)
        .bind(owner)
        .bind(id)
        .execute(&mut *attempt)
        .await
        .unwrap_err();
        assert_sqlstate(error, "23514");
        attempt.rollback().await.unwrap();
        let deleted = sqlx::query(
            "DELETE FROM member_sections WHERE organization_id = $1 AND member_id = $2 AND id = $3",
        )
        .bind(org)
        .bind(owner)
        .bind(id)
        .execute(&mut *tx)
        .await
        .unwrap();
        assert_eq!(deleted.rows_affected(), 1);
        tx.commit().await.unwrap();
    }

    for sql in [
        "UPDATE member_section_ids SET id = gen_random_uuid() WHERE organization_id = $1 AND member_id = $2 AND id = $3",
        "DELETE FROM member_section_ids WHERE organization_id = $1 AND member_id = $2 AND id = $3",
    ] {
        let error = database::organization(&pools.app, org, async |tx: &mut PgConnection| {
            sqlx::query(sql)
                .bind(org)
                .bind(owner)
                .bind(id)
                .execute(tx)
                .await
        })
        .await
        .unwrap_err();
        assert_sqlstate(error, "23514");
    }
    let other = Uuid::new_v4();
    member(&pools.admin, org, other, "member").await;
    let mut tx = scoped_transaction(&pools.app, Some(org)).await;
    let mut attempt = tx.begin().await.unwrap();
    let error = section(&mut *attempt, org, owner, id, "Original　Name")
        .await
        .unwrap_err();
    assert_sqlstate(error, "23505");
    attempt.rollback().await.unwrap();
    let fresh_id = Uuid::new_v4();
    section(&mut *tx, org, owner, fresh_id, "Original　Name")
        .await
        .unwrap();
    let mut attempt = tx.begin().await.unwrap();
    let error = sqlx::query(
        "UPDATE member_sections SET id = $4
             WHERE organization_id = $1 AND member_id = $2 AND id = $3",
    )
    .bind(org)
    .bind(owner)
    .bind(fresh_id)
    .bind(id)
    .execute(&mut *attempt)
    .await
    .unwrap_err();
    assert_sqlstate(error, "23514");
    attempt.rollback().await.unwrap();
    section(&mut *tx, org, other, id, "Original　Name")
        .await
        .unwrap();
    tx.commit().await.unwrap();
}

#[fukulow_test::test]
async fn section_storage_checks_name_length_and_generation(pool: PgPool) {
    let org = organization(&pool).await;
    let owner = Uuid::new_v4();
    member(&pool, org, owner, "member").await;
    let id = Uuid::new_v4();
    for (name, code) in [
        (String::new(), "23514"),
        ("😀".repeat(61), "23514"),
        ("a\0b".into(), "22021"),
    ] {
        assert_sqlstate(
            section(&pool, org, owner, id, &name).await.unwrap_err(),
            code,
        );
    }
    let valid = "😀".repeat(60);
    section(&pool, org, owner, id, &valid).await.unwrap();
    let update = "UPDATE member_sections SET name = $4
                  WHERE organization_id = $1 AND member_id = $2 AND id = $3 RETURNING name";
    assert_sqlstate(
        sqlx::query(update)
            .bind(org)
            .bind(owner)
            .bind(id)
            .bind("")
            .execute(&pool)
            .await
            .unwrap_err(),
        "23514",
    );
    let renamed: String = sqlx::query_scalar(update)
        .bind(org)
        .bind(owner)
        .bind(id)
        .bind("界")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(renamed, "界");

    let generation: i64 = sqlx::query_scalar(&format!("{INSERT_GENERATION} RETURNING generation"))
        .bind(org)
        .bind(owner)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(generation, 0);
    let update = "UPDATE member_section_generations SET generation = $3
                  WHERE organization_id = $1 AND member_id = $2 RETURNING generation";
    assert_sqlstate(
        sqlx::query(update)
            .bind(org)
            .bind(owner)
            .bind(-1_i64)
            .execute(&pool)
            .await
            .unwrap_err(),
        "23514",
    );
    let generation: i64 = sqlx::query_scalar(update)
        .bind(org)
        .bind(owner)
        .bind(i64::MAX)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(generation, i64::MAX);
}

#[fukulow_test::test]
async fn section_storage_rejects_dm_placements(pool: PgPool) {
    let pools = TestPools::new(pool).await;
    let org = organization(&pools.admin).await;
    let mut pair = [Uuid::new_v4(), Uuid::new_v4()];
    pair.sort_unstable();
    let [owner, other] = pair;
    for id in pair {
        member(&pools.admin, org, id, "member").await;
    }
    let dm = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO channels (organization_id, id, kind, lower_member_id, higher_member_id)
         VALUES ($1, $2, 'dm', $3, $4)",
    )
    .bind(org)
    .bind(dm)
    .bind(owner)
    .bind(other)
    .execute(&pools.admin)
    .await
    .unwrap();
    let channel = channel(&pools.admin, org).await;
    let id = Uuid::new_v4();
    let mut tx = scoped_transaction(&pools.app, Some(org)).await;
    section(&mut *tx, org, owner, id, "Own").await.unwrap();
    for group in [None, Some(id)] {
        let mut attempt = tx.begin().await.unwrap();
        assert_sqlstate(
            placement(&mut *attempt, org, owner, dm, group)
                .await
                .unwrap_err(),
            "23514",
        );
        attempt.rollback().await.unwrap();
    }
    placement(&mut *tx, org, owner, channel, Some(id))
        .await
        .unwrap();
    let mut attempt = tx.begin().await.unwrap();
    let error = sqlx::query(
        "UPDATE member_section_placements SET channel_id = $4
             WHERE organization_id = $1 AND member_id = $2 AND channel_id = $3",
    )
    .bind(org)
    .bind(owner)
    .bind(channel)
    .bind(dm)
    .execute(&mut *attempt)
    .await
    .unwrap_err();
    assert_sqlstate(error, "23514");
    attempt.rollback().await.unwrap();
    tx.commit().await.unwrap();
}

#[fukulow_test::test]
async fn channel_delete_requires_explicit_section_placement_cleanup(pool: PgPool) {
    let org = organization(&pool).await;
    let owner = Uuid::new_v4();
    member(&pool, org, owner, "member").await;
    let channel = channel(&pool, org).await;
    placement(&pool, org, owner, channel, None).await.unwrap();
    let delete = "DELETE FROM channels WHERE organization_id = $1 AND id = $2";
    assert_sqlstate(
        sqlx::query(delete)
            .bind(org)
            .bind(channel)
            .execute(&pool)
            .await
            .unwrap_err(),
        "23503",
    );

    let mut tx = pool.begin().await.unwrap();
    let deleted = sqlx::query(
        "DELETE FROM member_section_placements WHERE organization_id = $1 AND channel_id = $2",
    )
    .bind(org)
    .bind(channel)
    .execute(&mut *tx)
    .await
    .unwrap();
    assert_eq!(deleted.rows_affected(), 1);
    let deleted = sqlx::query(delete)
        .bind(org)
        .bind(channel)
        .execute(&mut *tx)
        .await
        .unwrap();
    assert_eq!(deleted.rows_affected(), 1);
    tx.commit().await.unwrap();
}
