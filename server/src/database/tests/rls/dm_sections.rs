//! Paired restricted-role write cases for the six discovery/section tables.
use super::{TABLES, Tenant, sqlstate};
use crate::{database, test_support::TestPools};
use sqlx::{PgConnection, PgPool, postgres::PgQueryResult};
use uuid::Uuid;

pub(super) struct Case {
    insert: &'static str,
    set: &'static str,
    constant_set: &'static str,
    move_error: &'static str,
}

pub(super) fn case(table: &str) -> Option<Case> {
    let (insert, set, constant_set, move_error) = match table {
        "dm_discovery_counters" => (
            "INSERT INTO dm_discovery_counters (organization_id, member_id, membership_revision, position) VALUES ($1, $2, 0, 3)",
            "position = position + 1",
            "position = 5",
            "42501",
        ),
        "dm_discovery" => (
            "INSERT INTO dm_discovery (organization_id, member_id, membership_revision, channel_id, grant_id, birth_position, latest_position) VALUES ($1, $2, 0, $4, $5, 1, 1)",
            "latest_position = latest_position + 1",
            "latest_position = 5",
            "23514",
        ),
        "member_sections" => (
            // Foreign INSERT gets 42501 from the nested member_section_ids reservation insert. schema.rs checks WITH CHECK.
            "INSERT INTO member_sections (organization_id, member_id, id, name, position) VALUES ($1, $2, $3, 'Section', 0)",
            "position = position + 1",
            "position = 5",
            "23514",
        ),
        "member_section_ids" => (
            // A standalone reservation, distinct from the one created for the Section.
            "INSERT INTO member_section_ids (organization_id, member_id, id) VALUES ($1, $2, $2)",
            "id = id",
            "id = '00000000-0000-0000-0000-000000000000'",
            "23514",
        ),
        "member_section_placements" => (
            "INSERT INTO member_section_placements (organization_id, member_id, channel_id, section_id, position) VALUES ($1, $2, $3, $3, 0)",
            "position = position + 1",
            "position = 5",
            "42501",
        ),
        "member_section_generations" => (
            "INSERT INTO member_section_generations (organization_id, member_id) VALUES ($1, $2)",
            "generation = generation + 1",
            "generation = 5",
            "42501",
        ),
        _ => return None,
    };
    Some(Case {
        insert,
        set,
        constant_set,
        move_error,
    })
}

struct Fixture<'a> {
    tenant: &'a Tenant,
    dm: Uuid,
    grant: Uuid,
}

impl<'a> Fixture<'a> {
    async fn new(admin: &PgPool, tenant: &'a Tenant) -> Self {
        let (peer, dm) = (Uuid::new_v4(), Uuid::new_v4());
        sqlx::query(
            "WITH a AS (INSERT INTO accounts (id, email, password_hash)
                        VALUES ($2, $2::text || '@example.com', 'unused'))
             INSERT INTO users (organization_id, id, account_id, name, role)
             VALUES ($1, $2, $2, 'Peer', 'member')",
        )
        .bind(tenant.organization)
        .bind(peer)
        .execute(admin)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO channels (organization_id, id, kind, lower_member_id, higher_member_id)
             VALUES ($1, $2, 'dm', LEAST($3, $4), GREATEST($3, $4))",
        )
        .bind(tenant.organization)
        .bind(dm)
        .bind(tenant.member)
        .bind(peer)
        .execute(admin)
        .await
        .unwrap();
        let grant = sqlx::query_scalar(
            "INSERT INTO channel_members (organization_id, channel_id, member_id)
             VALUES ($1, $2, $3) RETURNING grant_id",
        )
        .bind(tenant.organization)
        .bind(dm)
        .bind(tenant.member)
        .fetch_one(admin)
        .await
        .unwrap();
        Self { tenant, dm, grant }
    }

    async fn insert(
        &self,
        connection: &mut PgConnection,
        sql: &str,
    ) -> Result<PgQueryResult, sqlx::Error> {
        sqlx::query(sql)
            .bind(self.tenant.organization)
            .bind(self.tenant.member)
            .bind(self.tenant.channel)
            .bind(self.dm)
            .bind(self.grant)
            .execute(connection)
            .await
    }
}

pub(super) async fn seed(admin: &PgPool, tenant: &Tenant) {
    let fixture = Fixture::new(admin, tenant).await;
    let mut connection = admin.acquire().await.unwrap();
    for (table, case) in cases() {
        assert_affected(fixture.insert(&mut connection, case.insert).await, 1, table);
    }
}

pub(super) async fn check_inserts(pools: &TestPools, foreign: Uuid, tenant: &Tenant) {
    let fixture = Fixture::new(&pools.admin, tenant).await;
    for (table, case) in cases() {
        // Identical fresh payloads with existing parents. VALUES does not depend on
        // whether the caller can see a source row.
        let denied = database::organization(&pools.app, foreign, async |tx: &mut PgConnection| {
            fixture.insert(tx, case.insert).await
        })
        .await;
        assert_rejected(denied, "42501", &format!("{table}: foreign INSERT"));
        let own = database::organization(
            &pools.app,
            tenant.organization,
            async |tx: &mut PgConnection| fixture.insert(tx, case.insert).await,
        )
        .await;
        assert_affected(own, 1, &format!("{table}: own INSERT"));
    }
}

pub(super) async fn check_blind_updates_and_deletes(app: &PgPool, foreign: Uuid) {
    // Column reads would add the SELECT policy and could hide a weaker write policy.
    for (table, case) in cases().rev() {
        for sql in [
            format!("UPDATE {table} SET {}", case.constant_set),
            format!("DELETE FROM {table}"),
        ] {
            let result = database::organization(app, foreign, async |tx: &mut PgConnection| {
                sqlx::query(&sql).execute(tx).await
            })
            .await;
            assert_affected(result, 0, &format!("foreign: {sql}"));
        }
    }
}

pub(super) async fn check_updates_and_deletes(app: &PgPool, foreign: Uuid, own: Uuid) {
    for (table, case) in cases().rev() {
        let moved = format!(
            "UPDATE {table} SET {}, organization_id = $2 WHERE organization_id = $1",
            case.set
        );
        let move_row = async |context, destination| {
            database::organization(app, context, async |tx: &mut PgConnection| {
                sqlx::query(&moved)
                    .bind(own)
                    .bind(destination)
                    .execute(tx)
                    .await
            })
            .await
        };
        assert_affected(
            move_row(foreign, foreign).await,
            0,
            &format!("{table}: move foreign row"),
        );
        assert_rejected(
            move_row(own, foreign).await,
            case.move_error,
            &format!("{table}: move own row"),
        );
        assert_own_write(
            table,
            move_row(own, own).await,
            &format!("{table}: keep own Organization"),
        );

        for sql in [
            format!("UPDATE {table} SET {} WHERE organization_id = $1", case.set),
            format!("DELETE FROM {table} WHERE organization_id = $1"),
        ] {
            let attempt = async |context| {
                database::organization(app, context, async |tx: &mut PgConnection| {
                    sqlx::query(&sql).bind(own).execute(tx).await
                })
                .await
            };
            assert_affected(attempt(foreign).await, 0, &format!("foreign: {sql}"));
            assert_own_write(table, attempt(own).await, &format!("own: {sql}"));
        }
    }
}

fn cases() -> impl DoubleEndedIterator<Item = (&'static str, Case)> {
    TABLES
        .iter()
        .filter_map(|&table| Some((table, case(table)?)))
}

fn assert_own_write(table: &str, result: Result<PgQueryResult, sqlx::Error>, label: &str) {
    if table == "member_section_ids" {
        // The unconditional reservation trigger proves own rows were reached.
        assert_rejected(result, "23514", label);
    } else {
        assert_affected(result, 1, label);
    }
}

fn assert_affected(result: Result<PgQueryResult, sqlx::Error>, count: u64, label: &str) {
    let result = result.unwrap_or_else(|error| panic!("{label}: {error}"));
    assert_eq!(result.rows_affected(), count, "{label}");
}

fn assert_rejected(result: Result<PgQueryResult, sqlx::Error>, expected: &str, label: &str) {
    let error = result.expect_err(label);
    assert_eq!(
        sqlstate(&error).as_deref(),
        Some(expected),
        "{label}: {error}"
    );
}
