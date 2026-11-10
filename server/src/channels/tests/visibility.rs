use super::*;

#[sqlx::test]
async fn public_authorization_skips_membership_sql_but_checks_organization_and_channel(
    pool: PgPool,
) {
    let app = router(&pool);
    let org = organization(&pool).await;
    let creator = Uuid::new_v4();
    let token = member(&pool, org, creator, "member").await;
    let public = create(&app, &token, "Public", "public").await;
    let private = create(&app, &token, "Private", "private").await;
    let public = Uuid::parse_str(public["id"].as_str().unwrap()).unwrap();
    let private = Uuid::parse_str(private["id"].as_str().unwrap()).unwrap();
    let other = organization(&pool).await;
    member(&pool, other, creator, "member").await;
    let nonmember = Uuid::new_v4();
    member(&pool, org, nonmember, "member").await;
    // Public authorization must not execute private-grant checks, even in a combined query.
    sqlx::query("ALTER TABLE channel_members RENAME TO unavailable_channel_members")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::raw_sql("CREATE FUNCTION membership_query_forbidden() RETURNS boolean LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'private grant query executed'; END $$; CREATE VIEW channel_members AS SELECT * FROM unavailable_channel_members WHERE membership_query_forbidden()")
        .execute(&pool).await.unwrap();
    for reader in [creator, nonmember] {
        assert!(is_visible(&pool, org, (reader, 0), public).await.unwrap() == Some(true));
    }
    assert_eq!(
        visible_members(&pool, org, public, &[(creator, 0), (nonmember, 0)])
            .await
            .unwrap()
            .into_iter()
            .collect::<std::collections::BTreeSet<_>>(),
        [(creator, 0), (nonmember, 0)]
            .into_iter()
            .collect::<std::collections::BTreeSet<_>>()
    );
    for (scope, channel) in [(other, public), (org, Uuid::new_v4())] {
        assert!(
            is_visible(&pool, scope, (creator, 0), channel)
                .await
                .unwrap()
                != Some(true)
        );
        assert!(
            visible_members(&pool, scope, channel, &[(creator, 0)])
                .await
                .unwrap()
                .is_empty()
        );
    }
    // The private paths still require membership SQL, including for the creator.
    assert!(is_visible(&pool, org, (creator, 0), private).await.is_err());
    assert!(
        visible_members(&pool, org, private, &[(creator, 0)])
            .await
            .is_err()
    );
}

#[sqlx::test]
async fn authorization_reads_current_visibility_and_scopes_private_membership(pool: PgPool) {
    let app = router(&pool);
    let org = organization(&pool).await;
    let other = organization(&pool).await;
    let creator = Uuid::new_v4();
    let token = member(&pool, org, creator, "member").await;
    let reader = Uuid::new_v4();
    member(&pool, org, reader, "member").await;
    member(&pool, other, reader, "member").await;
    let channel = create(&app, &token, "Changing", "public").await;
    let channel = Uuid::parse_str(channel["id"].as_str().unwrap()).unwrap();
    // Same ids and a membership in the other Organization must never grant access here.
    sqlx::query("INSERT INTO channels (organization_id, id, name, visibility) VALUES ($1, $2, 'Other', 'private')")
        .bind(other).bind(channel).execute(&pool).await.unwrap();
    for (scope, id) in [(org, creator), (other, reader)] {
        sqlx::query("INSERT INTO channel_members (organization_id, channel_id, member_id) VALUES ($1, $2, $3)")
            .bind(scope).bind(channel).bind(id).execute(&pool).await.unwrap();
    }
    for visibility in ["public", "private", "public"] {
        sqlx::query("UPDATE channels SET visibility = $3 WHERE organization_id = $1 AND id = $2")
            .bind(org)
            .bind(channel)
            .bind(visibility)
            .execute(&pool)
            .await
            .unwrap();
        assert!(is_visible(&pool, org, (creator, 0), channel).await.unwrap() == Some(true));
        assert_eq!(
            is_visible(&pool, org, (reader, 0), channel).await.unwrap() == Some(true),
            visibility == "public"
        );
        let allowed = visible_members(&pool, org, channel, &[(creator, 0), (reader, 0)])
            .await
            .unwrap();
        assert!(allowed.contains(&(creator, 0)));
        assert_eq!(allowed.contains(&(reader, 0)), visibility == "public");
        assert!(
            is_visible(&pool, other, (creator, 0), channel)
                .await
                .unwrap()
                != Some(true)
        );
        assert!(
            is_visible(&pool, other, (reader, 0), channel)
                .await
                .unwrap()
                == Some(true)
        );
    }
}

#[sqlx::test]
#[ignore = "manual release visibility latency and candidate query plan"]
async fn measure_visibility_reads_and_candidate_plan(pool: PgPool) {
    let org = organization(&pool).await;
    let id = Uuid::new_v4();
    let token = member(&pool, org, id, "member").await;
    let public = create(&router(&pool), &token, "Public", "public").await;
    let channel = Uuid::parse_str(public["id"].as_str().unwrap()).unwrap();
    sqlx::query("WITH added AS (INSERT INTO accounts (id,email,password_hash) SELECT gen_random_uuid(),gen_random_uuid()::text || '@measure.invalid','unused' FROM generate_series(1,9999) RETURNING id) INSERT INTO users (organization_id,id,account_id,name,role) SELECT $1,gen_random_uuid(),id,'Member','member' FROM added")
        .bind(org).execute(&pool).await.unwrap();
    sqlx::raw_sql("ANALYZE users; ANALYZE channels; ANALYZE channel_members")
        .execute(&pool)
        .await
        .unwrap();
    let start = std::time::Instant::now();
    for _ in 0..1000 {
        assert_eq!(
            is_visible(&pool, org, (id, 0), channel).await.unwrap(),
            Some(true)
        );
    }
    eprintln!(
        "VISIBILITY single_reads=1000 elapsed_ms={:.3}",
        start.elapsed().as_secs_f64() * 1000.0
    );
    let sql = format!(
        "SELECT u.id, u.membership_revision FROM UNNEST($3::uuid[], $4::bigint[]) candidate(id, revision) JOIN ({}) u ON u.id = candidate.id AND u.membership_revision = candidate.revision JOIN channels c ON c.organization_id = $1 AND c.id = $2 WHERE c.visibility = 'public' OR EXISTS (SELECT 1 FROM channel_members cm WHERE cm.organization_id = c.organization_id AND cm.channel_id = c.id AND cm.member_id = u.id AND cm.membership_revision = u.membership_revision)",
        auth::ACTIVE_MEMBERS_SQL
    );
    for count in [1_i64, 128, 1024] {
        let ids: Vec<Uuid> = sqlx::query_scalar(
            "SELECT id FROM users WHERE organization_id=$1 ORDER BY id LIMIT $2",
        )
        .bind(org)
        .bind(count)
        .fetch_all(&pool)
        .await
        .unwrap();
        for shape in ["old", "bounded", "production"] {
            let sql = match shape {
                "old" => sql.clone(),
                "bounded" => sql.replace(
                    auth::ACTIVE_MEMBERS_SQL,
                    &format!("{} AND id=ANY($3)", auth::ACTIVE_MEMBERS_SQL),
                ),
                _ => visible_members_sql(),
            };
            let plan: Vec<(String,)> = sqlx::query_as(&format!("EXPLAIN (ANALYZE, BUFFERS) {sql}"))
                .bind(org)
                .bind(channel)
                .bind(&ids)
                .bind(vec![0_i64; ids.len()])
                .fetch_all(&pool)
                .await
                .unwrap();
            eprintln!(
                "PLAN shape={shape} candidates={count}\n{}",
                plan.into_iter()
                    .map(|row| row.0)
                    .collect::<Vec<_>>()
                    .join("\n")
            );
        }
    }
    let start = std::time::Instant::now();
    for _ in 0..1000 {
        assert_eq!(
            visible_members(&pool, org, channel, &[(id, 0)])
                .await
                .unwrap(),
            vec![(id, 0)]
        );
    }
    eprintln!(
        "VISIBILITY batches=1000 candidates=1 members=10000 elapsed_ms={:.3}",
        start.elapsed().as_secs_f64() * 1000.0
    );
}

#[sqlx::test]
async fn visibility_reads_never_lock_members_and_writes_retain_the_lock(pool: PgPool) {
    let org = organization(&pool).await;
    let id = Uuid::new_v4();
    let token = member(&pool, org, id, "member").await;
    let public = create(&router(&pool), &token, "Public", "public").await;
    let channel = Uuid::parse_str(public["id"].as_str().unwrap()).unwrap();
    let mut updating = pool.begin().await.unwrap();
    sqlx::query("UPDATE users SET name=name WHERE organization_id=$1 AND id=$2")
        .bind(org)
        .bind(id)
        .execute(&mut *updating)
        .await
        .unwrap();
    // A row lock held by another transaction cannot delay ordinary authorization.
    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        let mut read = pool.begin_with("BEGIN READ ONLY").await.unwrap();
        assert_eq!(
            is_visible(&mut *read, org, (id, 0), channel).await.unwrap(),
            Some(true)
        );
        read.commit().await.unwrap();
        assert_eq!(
            visible_members(&pool, org, channel, &[(id, 0)])
                .await
                .unwrap(),
            vec![(id, 0)]
        );
    })
    .await
    .unwrap();
    updating.rollback().await.unwrap();

    let mut write = pool.begin().await.unwrap();
    assert_eq!(
        is_visible_for_write(&mut write, org, (id, 0), channel)
            .await
            .unwrap(),
        Some(true)
    );
    // This models deactivation racing persistence/channel creation after authorization.
    let mut deactivation = pool.begin().await.unwrap();
    sqlx::query("SET LOCAL lock_timeout='50ms'")
        .execute(&mut *deactivation)
        .await
        .unwrap();
    let error =
        sqlx::query("UPDATE users SET deactivated_at=now() WHERE organization_id=$1 AND id=$2")
            .bind(org)
            .bind(id)
            .execute(&mut *deactivation)
            .await
            .unwrap_err();
    assert_eq!(
        error.as_database_error().unwrap().code().as_deref(),
        Some("55P03")
    );
    deactivation.rollback().await.unwrap();
    write.commit().await.unwrap();
    sqlx::query("UPDATE users SET deactivated_at=now() WHERE organization_id=$1 AND id=$2")
        .bind(org)
        .bind(id)
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(
        is_visible(&pool, org, (id, 0), channel).await.unwrap(),
        None
    );
}

async fn assert_visibility_modes(
    pool: &PgPool,
    org: Uuid,
    member: (Uuid, i64),
    channel: Uuid,
    expected: Option<bool>,
) {
    assert_eq!(
        is_visible(pool, org, member, channel).await.unwrap(),
        expected
    );
    let mut tx = pool
        .begin_with("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY")
        .await
        .unwrap();
    assert_eq!(
        is_visible(&mut *tx, org, member, channel).await.unwrap(),
        expected
    );
    tx.commit().await.unwrap();
    let mut tx = pool.begin().await.unwrap();
    assert_eq!(
        is_visible_for_write(&mut tx, org, member, channel)
            .await
            .unwrap(),
        expected
    );
    tx.commit().await.unwrap();
    assert_eq!(
        visible_members(pool, org, channel, &[member])
            .await
            .unwrap(),
        if expected == Some(true) {
            vec![member]
        } else {
            vec![]
        }
    );
}

#[sqlx::test]
async fn visibility_modes_preserve_membership_revision_and_private_grant_denials(pool: PgPool) {
    let org = organization(&pool).await;
    let other = organization(&pool).await;
    let id = Uuid::new_v4();
    let token = member(&pool, org, id, "member").await;
    let foreign = Uuid::new_v4();
    member(&pool, other, foreign, "member").await;
    let nonmember = Uuid::new_v4();
    member(&pool, org, nonmember, "member").await;
    let app = router(&pool);
    let public = Uuid::parse_str(
        create(&app, &token, "Public", "public").await["id"]
            .as_str()
            .unwrap(),
    )
    .unwrap();
    let private = Uuid::parse_str(
        create(&app, &token, "Private", "private").await["id"]
            .as_str()
            .unwrap(),
    )
    .unwrap();
    for channel in [public, private] {
        assert_visibility_modes(&pool, org, (id, 0), channel, Some(true)).await;
        assert_visibility_modes(&pool, org, (foreign, 0), channel, None).await;
        assert_visibility_modes(&pool, other, (foreign, 0), channel, Some(false)).await;
        assert_visibility_modes(&pool, org, (id, 1), channel, None).await;
    }
    assert_visibility_modes(&pool, org, (nonmember, 0), public, Some(true)).await;
    assert_visibility_modes(&pool, org, (nonmember, 0), private, Some(false)).await;
    assert_visibility_modes(&pool, org, (id, 0), Uuid::new_v4(), Some(false)).await;
    sqlx::query("UPDATE users SET deactivated_at=now() WHERE organization_id=$1 AND id=$2")
        .bind(org)
        .bind(id)
        .execute(&pool)
        .await
        .unwrap();
    for channel in [public, private] {
        assert_visibility_modes(&pool, org, (id, 0), channel, None).await;
    }
    sqlx::query("UPDATE users SET deactivated_at=NULL WHERE organization_id=$1 AND id=$2")
        .bind(org)
        .bind(id)
        .execute(&pool)
        .await
        .unwrap();
    for channel in [public, private] {
        assert_visibility_modes(&pool, org, (id, 0), channel, None).await;
    }
    assert_visibility_modes(&pool, org, (id, 1), public, Some(true)).await;
    assert_visibility_modes(&pool, org, (id, 1), private, Some(false)).await;
    sqlx::query("UPDATE channel_members SET membership_revision=1 WHERE organization_id=$1 AND channel_id=$2 AND member_id=$3").bind(org).bind(private).bind(id).execute(&pool).await.unwrap();
    assert_visibility_modes(&pool, org, (id, 1), private, Some(true)).await;
    // Mixed revisions are matched as pairs, never as independent id/revision sets.
    assert_eq!(
        visible_members(
            &pool,
            org,
            private,
            &[(id, 0), (id, 1), (nonmember, 1), (foreign, 1)]
        )
        .await
        .unwrap(),
        vec![(id, 1)]
    );
}
