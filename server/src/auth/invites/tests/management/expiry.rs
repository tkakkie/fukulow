use super::super::super::management::LIST_SQL;
use super::*;

fn check_range(plan: &Value) {
    if let Some(nodes) = plan.get("Plans").and_then(Value::as_array) {
        for node in nodes {
            check_range(node);
        }
    }
    assert!(
        plan["Actual Rows"].as_f64().unwrap_or(0.0) <= 300.0,
        "{plan}"
    );
    assert!(
        plan["Rows Removed by Filter"].as_f64().unwrap_or(0.0) <= 300.0,
        "{plan}"
    );
}

fn removed_rows(plan: &Value) -> f64 {
    plan["Rows Removed by Filter"].as_f64().unwrap_or(0.0).max(
        plan.get("Plans")
            .and_then(Value::as_array)
            .map(|nodes| nodes.iter().map(removed_rows).fold(0.0, f64::max))
            .unwrap_or(0.0),
    )
}

#[fukulow_test::test]
async fn invite_expiry_range_skips_history_with_custom_and_generic_plans(pool: sqlx::PgPool) {
    let org = org(&pool).await;
    let (_, issuer, _, owner) = account(&pool, org, Role::Owner).await;
    let (_, _, _, admin) = account(&pool, org, Role::Admin).await;
    sqlx::query(
        "INSERT INTO invites (organization_id,id,created_by,email,role,token_hash,created_at,expires_at) \
         SELECT $1,gen_random_uuid(),$2,'expired-'||n||'@example.invalid','member', \
         sha256(convert_to(gen_random_uuid()::text,'UTF8')),'2025-01-01',now()-interval '1 day' \
         FROM generate_series(1,10000) n",
    ).bind(org).bind(issuer).execute(&pool).await.unwrap();
    seed(&pool, org, issuer, 250, true).await;
    sqlx::query("ANALYZE invites").execute(&pool).await.unwrap();
    let anchor: (Uuid,Uuid,Uuid) = sqlx::query_as("SELECT id,owner_cursor,admin_cursor FROM invites WHERE organization_id=$1 AND expires_at<now() LIMIT 1")
        .bind(org).fetch_one(&pool).await.unwrap();
    let state = AppState::for_test(pool.clone()).await;
    let app = crate::app(state.clone());
    for (token, owner_role, cursor) in [(&owner, true, anchor.1), (&admin, false, anchor.2)] {
        assert_eq!(
            page(&app, org, token, None).await,
            page(&app, org, token, Some(&cursor.to_string())).await
        );
        for mode in ["force_custom_plan", "force_generic_plan"] {
            crate::database::organization(&state.pool, org, async |tx: &mut sqlx::PgConnection| {
                sqlx::query(&format!("SET LOCAL plan_cache_mode={mode}"))
                    .execute(&mut *tx)
                    .await?;
                for boundary in [None, Some(anchor.0)] {
                    let plan: Value = sqlx::query_scalar(&format!(
                        "EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) {LIST_SQL}"
                    ))
                    .bind(org)
                    .bind(owner_role)
                    .bind(boundary)
                    .fetch_one(&mut *tx)
                    .await?;
                    assert!(
                        plan.to_string().contains("invites_outstanding_expiry"),
                        "{mode}: {plan}"
                    );
                    assert!(
                        plan.to_string()
                            .contains("expires_at > statement_timestamp()"),
                        "{plan}"
                    );
                    check_range(&plan[0]["Plan"]);
                }
                // Negative control: without the stable range the clock-only
                // predicate must inspect expired history, even with this index.
                let before = LIST_SQL.replace("expires_at>statement_timestamp() AND ", "");
                assert_ne!(before, LIST_SQL);
                let plan: Value =
                    sqlx::query_scalar(&format!("EXPLAIN (ANALYZE,FORMAT JSON) {before}"))
                        .bind(org)
                        .bind(owner_role)
                        .bind(None::<Uuid>)
                        .fetch_one(&mut *tx)
                        .await?;
                assert!(removed_rows(&plan[0]["Plan"]) >= 10000.0, "{mode}: {plan}");
                Ok::<_, sqlx::Error>(())
            })
            .await
            .unwrap();
        }
    }
}
