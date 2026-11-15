use super::*;
use sqlx::{PgPool, postgres::PgPoolOptions};

type AccessRow = (bool, Option<Uuid>, bool);

struct Fixture {
    organizations: Vec<Uuid>,
    members: Vec<Uuid>,
    channels: Vec<Uuid>,
    grants: HashMap<(Uuid, Uuid, Uuid), Uuid>,
}

impl Fixture {
    async fn new(pool: &PgPool, count: i32) -> Self {
        let organizations = vec![Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4()];
        let channels = vec![Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4()];
        let members: Vec<Uuid> = sqlx::query_scalar(
            "SELECT md5('354-member-' || g)::uuid FROM generate_series(0,$1-1) g",
        )
        .bind(count)
        .fetch_all(pool)
        .await
        .unwrap();
        for (index, organization) in organizations.iter().enumerate() {
            sqlx::query("INSERT INTO organizations (organization_id,name) VALUES ($1,'Fan-out')")
                .bind(organization)
                .execute(pool)
                .await
                .unwrap();
            sqlx::query(
                "WITH a AS (INSERT INTO accounts (id,email,password_hash)
                 SELECT gen_random_uuid(), $1::text || '-' || g || '@example.invalid','unused'
                 FROM generate_series(0,$2-1) g RETURNING id,email)
                 INSERT INTO users (organization_id,id,account_id,name,role)
                 SELECT $1,md5('354-member-' || g)::uuid,a.id,'Member',
                 CASE WHEN g=0 THEN 'owner' WHEN g%5=0 THEN 'guest' ELSE 'member' END
                 FROM generate_series(0,$2-1) g JOIN a ON a.email=$1::text || '-' || g || '@example.invalid'",
            ).bind(organization).bind(count).execute(pool).await.unwrap();
            for (channel, visibility) in channels[..2].iter().zip(["public", "private"]) {
                sqlx::query("INSERT INTO channels (organization_id,id,name,visibility) VALUES ($1,$2,$3,$3)")
                    .bind(organization).bind(channel).bind(visibility).execute(pool).await.unwrap();
            }
            sqlx::query("INSERT INTO channels (organization_id,id,kind,lower_member_id,higher_member_id) VALUES ($1,$2,'dm',LEAST($3::uuid,$4::uuid),GREATEST($3::uuid,$4::uuid))")
                .bind(organization).bind(channels[2]).bind(members[1]).bind(members[2])
                .execute(pool).await.unwrap();
            // Different private grants behind identical Member/Channel ids.
            for (channel, ids) in [
                (channels[0], &members[5..6]),
                (
                    channels[1],
                    &members[1..(count as usize).min(30 * (index + 1))],
                ),
                (channels[2], &members[1..3]),
            ] {
                sqlx::query("INSERT INTO channel_members (organization_id,channel_id,member_id) SELECT $1,$2,unnest($3::uuid[])")
                    .bind(organization).bind(channel).bind(ids).execute(pool).await.unwrap();
            }
        }
        let grants = sqlx::query_as::<_, (Uuid, Uuid, Uuid, Uuid)>(
            "SELECT organization_id,channel_id,member_id,grant_id FROM channel_members",
        )
        .fetch_all(pool)
        .await
        .unwrap()
        .into_iter()
        .map(|(org, channel, member, grant)| ((org, channel, member), grant))
        .collect();
        Self {
            organizations,
            members,
            channels,
            grants,
        }
    }

    fn entry(&self, tenant: usize, member: usize, revision: i64, channel: usize) -> Arc<Entry> {
        Arc::new(Entry {
            organization: self.organizations[tenant],
            member: (self.members[member], revision),
            channel: self.channels[channel],
            grant: Mutex::new(None),
            status: watch::channel(0).0,
        })
    }

    fn expected(&self, entry: &Entry) -> AccessRow {
        if entry.member.1 != 0 {
            return (false, None, false);
        }
        let index = self
            .members
            .iter()
            .position(|id| *id == entry.member.0)
            .unwrap();
        let public = entry.channel == self.channels[0] && (index == 0 || index % 5 != 0);
        let grant = self
            .grants
            .get(&(entry.organization, entry.channel, entry.member.0))
            .copied();
        (
            public || grant.is_some(),
            if public { None } else { grant },
            true,
        )
    }
}

async fn single(pool: &PgPool, mode: &'static str) -> PgPool {
    PgPoolOptions::new()
        .max_connections(1)
        .idle_timeout(None)
        .max_lifetime(None)
        .after_connect(move |connection, _| {
            Box::pin(async move {
                sqlx::query(&format!("SET plan_cache_mode={mode}"))
                    .execute(connection)
                    .await
                    .map(|_| ())
            })
        })
        .connect_with(pool.connect_options().as_ref().clone())
        .await
        .unwrap()
}

#[fukulow_test::test]
async fn bounded_fanout_batches_preserve_tenants_order_duplicates_and_revisions(pool: PgPool) {
    let pools = crate::test_support::TestPools::new(pool).await;
    let fixture = Fixture::new(&pools.admin, 1002).await;
    for mode in ["force_custom_plan", "force_generic_plan"] {
        let app = single(&pools.app, mode).await;
        let pid = crate::database::tests::context::clean(&app).await;
        for count in [1, 1000, 1001] {
            let mut entries: Vec<_> = (0..count)
                .flat_map(|i| {
                    (0..3).rev().map({
                        let fixture = &fixture;
                        move |org| fixture.entry(org, i, i64::from(i % 7 == 0), i % 3)
                    })
                })
                .collect();
            // Non-adjacent duplicate rows must keep their own ordinal/revision.
            if count > 10 {
                entries[0] = fixture.entry(2, 1, 0, 1);
                entries[3] = fixture.entry(2, 1, 0, 1);
                entries[6] = fixture.entry(2, 1, 1, 1);
            }
            for reverse in [false, true] {
                if reverse {
                    entries.reverse();
                }
                let expected: Vec<_> = entries.iter().map(|e| fixture.expected(e)).collect();
                assert_eq!(
                    access_rows(&app, &entries).await.unwrap(),
                    expected,
                    "{mode}/{count}/{reverse}"
                );
            }
            assert_eq!(crate::database::tests::context::clean(&app).await, pid);
        }
        // member_access has no 1,000 split; test both sizes plus its measured 1,024.
        for count in [1000, 1001, 1024] {
            let mut candidates: Vec<_> = (0..count)
                .map(|i| (fixture.members[i % 1002], i64::from(i % 7 == 0)))
                .collect();
            for reverse in [false, true] {
                if reverse {
                    candidates.reverse();
                }
                for org in 0..3 {
                    for channel in 0..3 {
                        let mut expected: Vec<_> = candidates
                            .iter()
                            .filter(|(_, rev)| *rev == 0)
                            .map(|&(id, rev)| {
                                let index = fixture.members.iter().position(|m| *m == id).unwrap();
                                (
                                    id,
                                    rev,
                                    fixture.expected(&fixture.entry(org, index, rev, channel)).0,
                                )
                            })
                            .collect();
                        let mut actual = super::super::member_access(
                            &app,
                            fixture.organizations[org],
                            fixture.channels[channel],
                            &candidates,
                        )
                        .await
                        .unwrap();
                        expected.sort();
                        actual.sort();
                        assert_eq!(actual, expected, "{mode}/{count}/{reverse}/{org}/{channel}");
                    }
                }
            }
        }
        assert!(access_rows(&app, &[]).await.unwrap().is_empty());
        assert!(
            super::super::member_access(&app, fixture.organizations[0], fixture.channels[0], &[])
                .await
                .unwrap()
                .is_empty()
        );
        assert_eq!(crate::database::tests::context::clean(&app).await, pid);
        app.close().await;
    }
}

async fn assert_access(
    app: &PgPool,
    fixture: &Fixture,
    member: usize,
    revision: i64,
    channel: usize,
    expected: AccessRow,
) {
    let entry = fixture.entry(0, member, revision, channel);
    for count in [1, 1000, 1001] {
        assert_eq!(
            access_rows(app, &vec![entry.clone(); count]).await.unwrap(),
            vec![expected; count]
        );
        let candidates = vec![(fixture.members[member], revision); count];
        let actual = super::super::member_access(
            app,
            fixture.organizations[0],
            fixture.channels[channel],
            &candidates,
        )
        .await
        .unwrap();
        assert_eq!(
            actual,
            if expected.2 {
                vec![(entry.member.0, revision, expected.0); count]
            } else {
                vec![]
            }
        );
    }
}

#[fukulow_test::test]
async fn bounded_fanout_rechecks_channel_dm_guest_deactivation_and_grant_lifetimes(pool: PgPool) {
    let pools = crate::test_support::TestPools::new(pool).await;
    for mode in ["force_custom_plan", "force_generic_plan"] {
        let fixture = Fixture::new(&pools.admin, 6).await;
        let app = single(&pools.app, mode).await;
        let org = fixture.organizations[0];
        let private = fixture.channels[1];
        let member = fixture.members[1];
        let private_grant = fixture.grants[&(org, private, member)];
        let dm_grant = fixture.grants[&(org, fixture.channels[2], member)];
        assert_access(&app, &fixture, 1, 0, 1, (true, Some(private_grant), true)).await;
        assert_access(&app, &fixture, 1, 0, 2, (true, Some(dm_grant), true)).await;
        // Even Owner has no private grant or DM participation shortcut.
        assert_access(&app, &fixture, 0, 0, 0, (true, None, true)).await;
        assert_access(&app, &fixture, 0, 0, 1, (false, None, true)).await;
        assert_access(&app, &fixture, 0, 0, 2, (false, None, true)).await;
        sqlx::query("UPDATE channels SET visibility='private' WHERE organization_id=$1 AND id=$2")
            .bind(org)
            .bind(fixture.channels[0])
            .execute(&pools.admin)
            .await
            .unwrap();
        assert_access(&app, &fixture, 1, 0, 0, (false, None, true)).await;
        sqlx::query("UPDATE channels SET visibility='public' WHERE organization_id=$1 AND id=$2")
            .bind(org)
            .bind(fixture.channels[0])
            .execute(&pools.admin)
            .await
            .unwrap();
        assert_access(&app, &fixture, 1, 0, 0, (true, None, true)).await;
        let captured = fixture.entry(0, 1, 0, 1);
        *captured.grant.lock().unwrap() = Some(private_grant);
        sqlx::query("DELETE FROM channel_members WHERE organization_id=$1 AND channel_id=$2 AND member_id=$3")
            .bind(org).bind(private).bind(member).execute(&pools.admin).await.unwrap();
        assert_access(&app, &fixture, 1, 0, 1, (false, None, true)).await;
        let renewed: Uuid = sqlx::query_scalar("INSERT INTO channel_members (organization_id,channel_id,member_id) VALUES ($1,$2,$3) RETURNING grant_id")
            .bind(org).bind(private).bind(member).fetch_one(&pools.admin).await.unwrap();
        assert_ne!(renewed, private_grant);
        assert_access(&app, &fixture, 1, 0, 1, (true, Some(renewed), true)).await;
        check_entries(&app, std::slice::from_ref(&captured), &Default::default())
            .await
            .unwrap();
        assert_eq!(
            *captured.status.borrow(),
            1,
            "replacement grant cannot revive an old subscription"
        );
        // Guest public/private access depends on explicit grants; DM Guest
        // participation remains valid while third-party Guest access is denied.
        let guest = fixture.members[5];
        let public_grant = fixture.grants[&(org, fixture.channels[0], guest)];
        let guest_private_grant = fixture.grants[&(org, private, guest)];
        assert_access(
            &app,
            &fixture,
            5,
            0,
            1,
            (true, Some(guest_private_grant), true),
        )
        .await;
        assert_access(&app, &fixture, 5, 0, 0, (true, Some(public_grant), true)).await;
        assert_access(&app, &fixture, 5, 0, 2, (false, None, true)).await;
        sqlx::query("DELETE FROM channel_members WHERE organization_id=$1 AND member_id=$2")
            .bind(org)
            .bind(guest)
            .execute(&pools.admin)
            .await
            .unwrap();
        assert_access(&app, &fixture, 5, 0, 0, (false, None, true)).await;
        assert_access(&app, &fixture, 5, 0, 1, (false, None, true)).await;
        sqlx::query("UPDATE users SET role='guest' WHERE organization_id=$1 AND id=$2")
            .bind(org)
            .bind(member)
            .execute(&pools.admin)
            .await
            .unwrap();
        assert_access(&app, &fixture, 1, 0, 0, (false, None, true)).await;
        assert_access(&app, &fixture, 1, 0, 2, (true, Some(dm_grant), true)).await;
        sqlx::query("UPDATE users SET deactivated_at=now() WHERE organization_id=$1 AND id=$2")
            .bind(org)
            .bind(member)
            .execute(&pools.admin)
            .await
            .unwrap();
        assert_access(&app, &fixture, 1, 0, 1, (false, None, false)).await;
        assert_access(&app, &fixture, 1, 1, 2, (false, None, false)).await;
        let peer_grant = fixture.grants[&(org, fixture.channels[2], fixture.members[2])];
        assert_access(&app, &fixture, 2, 0, 2, (true, Some(peer_grant), true)).await;
        sqlx::query("UPDATE users SET deactivated_at=NULL WHERE organization_id=$1 AND id=$2")
            .bind(org)
            .bind(member)
            .execute(&pools.admin)
            .await
            .unwrap();
        assert_access(&app, &fixture, 1, 0, 1, (false, None, false)).await;
        assert_access(&app, &fixture, 1, 0, 2, (false, None, false)).await;
        assert_access(&app, &fixture, 1, 1, 1, (false, None, true)).await;
        assert_access(&app, &fixture, 1, 1, 2, (false, None, true)).await;
        // Current peer keeps history access after the other participant is deactivated.
        let peer_grant = fixture.grants[&(org, fixture.channels[2], fixture.members[2])];
        assert_access(&app, &fixture, 2, 0, 2, (true, Some(peer_grant), true)).await;
        for channel in [private, fixture.channels[2]] {
            sqlx::query("UPDATE channel_members SET membership_revision=1,grant_id=gen_random_uuid() WHERE organization_id=$1 AND channel_id=$2 AND member_id=$3")
                .bind(org).bind(channel).bind(member).execute(&pools.admin).await.unwrap();
        }
        let fresh_dm: Uuid = sqlx::query_scalar("SELECT grant_id FROM channel_members WHERE organization_id=$1 AND channel_id=$2 AND member_id=$3")
            .bind(org).bind(fixture.channels[2]).bind(member).fetch_one(&pools.admin).await.unwrap();
        assert_access(&app, &fixture, 1, 1, 2, (true, Some(fresh_dm), true)).await;
        assert_access(&app, &fixture, 1, 0, 2, (false, None, false)).await;
        crate::database::tests::context::clean(&app).await;
        app.close().await;
    }
}

#[fukulow_test::test]
async fn bounded_fanout_requires_dm_participation_even_with_current_grants(pool: PgPool) {
    let pools = crate::test_support::TestPools::new(pool).await;
    let fixture = Fixture::new(&pools.admin, 6).await;
    let org = fixture.organizations[0];
    let dm = fixture.channels[2];
    let participant_grant = fixture.grants[&(org, dm, fixture.members[1])];
    // Inject a third-party current grant so participation is the only denied
    // condition. Restore the storage guard before exercising either read path.
    let mut tx = pools.admin.begin().await.unwrap();
    sqlx::query("ALTER TABLE channel_members DISABLE TRIGGER channel_members_dm")
        .execute(&mut *tx)
        .await
        .unwrap();
    let outsider_grant: Uuid = sqlx::query_scalar(
        "INSERT INTO channel_members (organization_id,channel_id,member_id) VALUES ($1,$2,$3) RETURNING grant_id",
    )
    .bind(org)
    .bind(dm)
    .bind(fixture.members[3])
    .fetch_one(&mut *tx)
    .await
    .unwrap();
    sqlx::query("ALTER TABLE channel_members ENABLE TRIGGER channel_members_dm")
        .execute(&mut *tx)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    for mode in ["force_custom_plan", "force_generic_plan"] {
        let app = single(&pools.app, mode).await;
        assert_access(
            &app,
            &fixture,
            1,
            0,
            2,
            (true, Some(participant_grant), true),
        )
        .await;
        assert_access(&app, &fixture, 3, 0, 2, (false, Some(outsider_grant), true)).await;
        crate::database::tests::context::clean(&app).await;
        app.close().await;
    }
}

#[fukulow_test::test]
async fn bounded_candidates_keep_organization_scope_with_account_read_policy(pool: PgPool) {
    let pools = crate::test_support::TestPools::new(pool).await;
    let fixture = Fixture::new(&pools.admin, 6).await;
    let account: Uuid =
        sqlx::query_scalar("SELECT account_id FROM users WHERE organization_id=$1 AND id=$2")
            .bind(fixture.organizations[1])
            .bind(fixture.members[1])
            .fetch_one(&pools.admin)
            .await
            .unwrap();
    for mode in ["force_custom_plan", "force_generic_plan"] {
        let app = single(&pools.app, mode).await;
        let entry = fixture.entry(0, 1, 0, 1);
        // Without either context the raw reads must deny even valid candidates.
        let mut connection = app.acquire().await.unwrap();
        assert_eq!(
            access_rows_in(
                &mut connection,
                std::slice::from_ref(&entry),
                &access_rows_sql()
            )
            .await
            .unwrap(),
            [(false, None, false)]
        );
        assert!(
            super::super::member_access_in(
                &mut connection,
                entry.organization,
                entry.channel,
                &[entry.member]
            )
            .await
            .unwrap()
            .is_empty()
        );
        drop(connection);
        crate::database::account(&app, account, async |tx: &mut sqlx::PgConnection| {
            let own: Vec<Uuid> =
                sqlx::query_scalar("SELECT organization_id FROM users WHERE id=$1")
                    .bind(entry.member.0)
                    .fetch_all(&mut *tx)
                    .await?;
            assert_eq!(
                own,
                [fixture.organizations[1]],
                "positive Account-read control"
            );
            crate::database::set_organization(tx, entry.organization).await?;
            let visible: i64 = sqlx::query_scalar("SELECT count(*) FROM users WHERE id=$1")
                .bind(entry.member.0)
                .fetch_one(&mut *tx)
                .await?;
            assert_eq!(
                visible, 2,
                "both policies are active; query scope must still bound Organization"
            );
            assert_eq!(
                access_rows_in(tx, std::slice::from_ref(&entry), &access_rows_sql()).await?,
                [fixture.expected(&entry)]
            );
            assert_eq!(
                super::super::member_access_in(
                    tx,
                    entry.organization,
                    entry.channel,
                    &[entry.member]
                )
                .await?,
                [(entry.member.0, 0, true)]
            );
            Ok::<_, sqlx::Error>(())
        })
        .await
        .unwrap();
        // Session Account context lets the pool-based one-statement path run
        // with both permissive policies, rather than only testing member_access_in.
        sqlx::query("SELECT set_config('fukulow.account_id', $1, false)")
            .bind(account.to_string())
            .execute(&app)
            .await
            .unwrap();
        crate::database::organization_read_only(
            &app,
            entry.organization,
            async |tx: &mut sqlx::PgConnection| {
                let visible: i64 = sqlx::query_scalar("SELECT count(*) FROM users WHERE id=$1")
                    .bind(entry.member.0)
                    .fetch_one(tx)
                    .await?;
                assert_eq!(visible, 2, "{mode}: overlapping-policy positive control");
                Ok::<_, sqlx::Error>(())
            },
        )
        .await
        .unwrap();
        assert_eq!(
            super::super::member_access(&app, entry.organization, entry.channel, &[entry.member])
                .await
                .unwrap(),
            [(entry.member.0, 0, true)],
            "{mode}: one-statement candidates must stay Organization-bound"
        );
        let own: Vec<Uuid> = sqlx::query_scalar("SELECT organization_id FROM users WHERE id=$1")
            .bind(entry.member.0)
            .fetch_all(&app)
            .await
            .unwrap();
        assert_eq!(
            own,
            [fixture.organizations[1]],
            "{mode}: Account-read control"
        );
        sqlx::query("RESET fukulow.account_id")
            .execute(&app)
            .await
            .unwrap();
        crate::database::tests::context::clean(&app).await;
        app.close().await;
    }
}

#[fukulow_test::test]
async fn bounded_fanout_cancellation_discards_context_in_both_plan_modes(pool: PgPool) {
    let pools = crate::test_support::TestPools::new(pool).await;
    let fixture = Fixture::new(&pools.admin, 6).await;
    sqlx::raw_sql(
        "ALTER TABLE channel_members RENAME TO unpaused_channel_members;
         CREATE FUNCTION pause_access_read() RETURNS boolean LANGUAGE plpgsql AS $$ BEGIN
           IF NULLIF(current_setting('fukulow.organization_id',true),'') IS NULL THEN
             RAISE EXCEPTION 'read ran before Organization context';
           END IF;
           PERFORM pg_advisory_xact_lock(354,1);
           RETURN true;
         END $$;
         CREATE VIEW channel_members WITH (security_invoker=true) AS
           SELECT * FROM unpaused_channel_members WHERE pause_access_read();
         GRANT SELECT ON channel_members TO fukulow_sqlx_test_app;",
    )
    .execute(&pools.admin)
    .await
    .unwrap();
    for mode in ["force_custom_plan", "force_generic_plan"] {
        let app = single(&pools.app, mode).await;
        let entry = fixture.entry(0, 1, 0, 1);
        // Pause a grant read after verifying context has run. Drop its future
        // mid-statement, then verify a clean replacement and successful reads.
        for read in 0..3 {
            let pid = crate::database::tests::context::clean(&app).await;
            let mut lock = pools.admin.begin().await.unwrap();
            sqlx::query("SELECT pg_advisory_xact_lock(354,1)")
                .execute(&mut *lock)
                .await
                .unwrap();
            let future = async {
                if read == 2 {
                    super::super::member_access(
                        &app,
                        entry.organization,
                        entry.channel,
                        &[entry.member],
                    )
                    .await
                    .map(|_| ())
                } else {
                    access_rows(&app, &vec![entry.clone(); if read == 0 { 1 } else { 1001 }])
                        .await
                        .map(|_| ())
                }
            };
            let mut pending = Box::pin(future);
            let blocked = async {
                loop {
                    let waiting: bool = sqlx::query_scalar("SELECT EXISTS (SELECT FROM pg_stat_activity WHERE pid=$1 AND wait_event='advisory')")
                        .bind(pid).fetch_one(&pools.admin).await.unwrap();
                    if waiting {
                        break;
                    }
                    tokio::task::yield_now().await;
                }
            };
            tokio::time::timeout(std::time::Duration::from_secs(10), async {
                tokio::select! {
                    result = &mut pending => panic!("query escaped locked grant: {result:?}"),
                    () = blocked => {}
                }
            })
            .await
            .unwrap();
            drop(pending);
            lock.rollback().await.unwrap();
            let next = tokio::time::timeout(
                std::time::Duration::from_secs(3),
                crate::database::tests::context::clean(&app),
            )
            .await
            .unwrap();
            assert_ne!(next, pid, "{mode}: cancelled backend must be discarded");
            assert_access(&app, &fixture, 1, 0, 1, fixture.expected(&entry)).await;
        }
        app.close().await;
    }
}
