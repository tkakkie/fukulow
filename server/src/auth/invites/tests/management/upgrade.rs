use super::*;

#[fukulow_test::test(migrations = false)]
async fn invite_revocation_upgrade_backfills_existing_rows_and_pages_tied_expiries(
    pool: sqlx::PgPool,
) {
    let mut initial = sqlx::migrate!();
    initial
        .migrations
        .to_mut()
        .retain(|migration| migration.version < 202611140303);
    initial.run(&pool).await.unwrap();
    let org = org(&pool).await;
    let (_, issuer, _, owner) = account(&pool, org, Role::Owner).await;
    let (_, _, _, admin) = account(&pool, org, Role::Admin).await;
    // Accepted and outstanding rows share expiry; expired rows must be backfilled too.
    let mut rows: Vec<(Uuid, String)> = sqlx::query_as(
        "INSERT INTO invites (organization_id,id,created_by,email,role,token_hash,expires_at,accepted_at) \
         SELECT $1,gen_random_uuid(),$2,'old-'||n||'@example.invalid', \
         CASE WHEN n%2=0 THEN 'owner' ELSE 'member' END, \
         sha256(convert_to(gen_random_uuid()::text,'UTF8')), \
         CASE WHEN n=252 THEN now()-interval '1 day' ELSE now()+interval '7 days' END, \
         CASE WHEN n=251 THEN now() ELSE NULL END \
         FROM generate_series(1,252) n RETURNING id,role",
    )
    .bind(org)
    .bind(issuer)
    .fetch_all(&pool)
    .await
    .unwrap();
    let before: Value = sqlx::query_scalar(
        "SELECT jsonb_agg(to_jsonb(i) ORDER BY id) FROM invites i WHERE organization_id=$1",
    )
    .bind(org)
    .fetch_one(&pool)
    .await
    .unwrap();
    sqlx::migrate!().run(&pool).await.unwrap();
    let after: Value = sqlx::query_scalar(
        "SELECT jsonb_agg(to_jsonb(i)-'created_at'-'revoked_at'-'owner_cursor'-'admin_cursor' ORDER BY id) \
         FROM invites i WHERE organization_id=$1",
    )
    .bind(org)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(after, before);
    let backfilled: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM invites WHERE organization_id=$1 \
         AND created_at=expires_at-interval '7 days' AND revoked_at IS NULL \
         AND owner_cursor IS NOT NULL AND admin_cursor IS NOT NULL",
    )
    .bind(org)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(backfilled, 252);
    let anchors: i64 = sqlx::query_scalar(
        "SELECT count(DISTINCT anchor) FROM invites, \
         LATERAL unnest(ARRAY[owner_cursor,admin_cursor]) anchor WHERE organization_id=$1",
    )
    .bind(org)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(anchors, 504);
    let excluded: Vec<Uuid> = sqlx::query_scalar(
        "SELECT id FROM invites WHERE organization_id=$1 \
         AND (accepted_at IS NOT NULL OR expires_at<=clock_timestamp())",
    )
    .bind(org)
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(excluded.len(), 2);
    rows.retain(|(id, _)| !excluded.contains(id));
    rows.sort();
    let app = crate::app(AppState::for_test(pool.clone()).await);
    for (token, owner_role, sizes) in [
        (&owner, true, vec![100, 100, 50]),
        (&admin, false, vec![100, 25]),
    ] {
        let expected: Vec<_> = rows
            .iter()
            .filter(|(_, role)| owner_role || role != "owner")
            .map(|(id, _)| *id)
            .collect();
        let mut seen = vec![];
        let mut cursor = None;
        for (index, size) in sizes.iter().enumerate() {
            let p = page(&app, org, token, cursor.as_deref()).await;
            let invites = p["invites"].as_array().unwrap();
            assert_eq!(invites.len(), *size);
            seen.extend(invites.iter().map(id));
            cursor = p.get("next_cursor").map(|c| c.as_str().unwrap().to_owned());
            assert_eq!(cursor.is_some(), index + 1 < sizes.len());
        }
        assert_eq!(seen, expected);
    }
}
