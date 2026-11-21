use super::*;
use sqlx::PgConnection;

#[fukulow_test::test]
async fn search_pages_match_brute_force_at_cross_channel_ties_and_skip_false_candidates(
    pool: PgPool,
) {
    let f = Fixture::new(pool).await;
    let private = f.channel(true).await;
    let archived = f.channel(false).await;
    sqlx::query("UPDATE channels SET archived_at=now() WHERE organization_id=$1 AND id=$2")
        .bind(f.org)
        .bind(archived)
        .execute(&f.pools.admin)
        .await
        .unwrap();
    for channel in [f.public, private, archived] {
        bulk(&f, channel, 1..=32, "the NEEDLE trip", "10 minutes", false).await;
        bulk(
            &f,
            channel,
            33..=35,
            "the needle trip",
            "179 days 23 hours",
            false,
        )
        .await;
        bulk(
            &f,
            channel,
            36..=50,
            "the needle trip",
            "180 days 1 hour",
            false,
        )
        .await;
        bulk(&f, channel, 51..=52, "the needle trip", "2 minutes", true).await;
    }
    bulk(&f, private, 53..=82, "needle checking", "1 minute", false).await;

    let mut current = page(&f, &f.token, "needle trip", None, None).await;
    let range_start = current["range_start"].as_str().unwrap().to_owned();
    let expected = crate::database::organization_read_only(
        &f.pools.app,
        f.org,
        async |tx: &mut PgConnection| {
            sqlx::query_scalar::<_, Uuid>(
                "SELECT id FROM messages WHERE organization_id=$1 AND NOT deleted
                 AND created_at >= $2::text::timestamptz AND strpos(lower(body), 'needle') > 0 AND strpos(lower(body), 'trip') > 0
                 ORDER BY created_at DESC, id DESC",
            )
            .bind(f.org)
            .bind(&range_start)
            .fetch_all(tx)
            .await
        },
    )
    .await
    .unwrap();
    assert_eq!(expected.len(), 105);

    let mut actual = Vec::new();
    for page_number in 0..6 {
        assert_eq!(current["range_start"], range_start);
        let page_ids = ids(&current);
        assert_eq!(page_ids.len(), if page_number < 5 { 20 } else { 5 });
        actual.extend(page_ids);
        if page_number < 5 {
            current = page(
                &f,
                &f.token,
                "needle trip",
                None,
                current["next_cursor"].as_str(),
            )
            .await;
        } else {
            assert_eq!(current["next_cursor"], Value::Null);
        }
    }
    assert_eq!(actual, expected);

    bulk(&f, f.public, 100..=119, "exact page", "1 minute", false).await;
    let exactly_twenty = page(&f, &f.token, "exact page", Some(f.public), None).await;
    assert_eq!(ids(&exactly_twenty).len(), 20);
    assert_eq!(exactly_twenty["hits"][0]["channel_kind"], "channel");
    assert_eq!(exactly_twenty["next_cursor"], Value::Null);
    let empty = page(&f, &f.token, "omitted", None, None).await;
    assert!(ids(&empty).is_empty());
    assert_eq!(empty["next_cursor"], Value::Null);
}

#[fukulow_test::test]
async fn search_statement_timeout_returns_retryable_error_and_recovers(pool: PgPool) {
    let f = Fixture::new(pool).await;
    let id = id(&f.post(f.public, "needle").await);
    let mut blocker = f.pools.admin.begin().await.unwrap();
    sqlx::query("LOCK TABLE message_search_terms IN ACCESS EXCLUSIVE MODE")
        .execute(&mut *blocker)
        .await
        .unwrap();
    error(
        get(&f.app, f.org, &f.token, Some("needle"), None, None).await,
        StatusCode::SERVICE_UNAVAILABLE,
        "search_timeout",
    )
    .await;
    blocker.rollback().await.unwrap();
    assert_eq!(ids(&page(&f, &f.token, "needle", None, None).await), [id]);
}

fn plan_nodes(node: &Value) -> Vec<&Value> {
    let mut nodes = vec![node];
    if let Some(children) = node["Plans"].as_array() {
        nodes.extend(children.iter().flat_map(plan_nodes));
    }
    nodes
}

#[fukulow_test::test]
async fn search_plan_limits_each_scope_and_uses_term_and_message_indexes(pool: PgPool) {
    let f = Fixture::new(pool).await;
    let second = f.channel(false).await;
    for channel in [f.public, second] {
        bulk(&f, channel, 1..=80, "needle matching", "10 minutes", false).await;
        bulk(&f, channel, 81..=105, "needle checking", "1 minute", false).await;
        bulk(
            &f,
            channel,
            106..=500,
            "irrelevant body",
            "0 minutes",
            false,
        )
        .await;
    }
    sqlx::raw_sql("ANALYZE messages; ANALYZE message_search_terms")
        .execute(&f.pools.admin)
        .await
        .unwrap();

    let plan: Value = crate::database::organization_read_only(
        &f.pools.app,
        f.org,
        async |tx: &mut PgConnection| {
            sqlx::raw_sql(concat!(
                "SET LOCAL plan_cache_mode = force_generic_plan; PREPARE search_explain AS ",
                include_str!("../../search/page.sql")
            ))
            .execute(&mut *tx)
            .await?;
            let sql = format!(
                "EXPLAIN (ANALYZE, FORMAT JSON) EXECUTE search_explain(
                    '{}', '{{{},{second}}}', 'nee', '{{needle,matching}}', '-infinity', 'infinity', '{}', 20)",
                f.org, f.public, Uuid::max(),
            );
            let plan = sqlx::query_scalar(&sql).persistent(false).fetch_one(&mut *tx).await?;
            sqlx::query("DEALLOCATE search_explain").execute(tx).await?;
            Ok::<_, sqlx::Error>(plan)
        },
    )
    .await
    .unwrap();
    let nodes = plan_nodes(&plan[0]["Plan"]);
    assert!(
        nodes.iter().any(|node| node["Node Type"] == "Limit"
            && node["Actual Rows"].as_f64() == Some(21.0)
            && node["Actual Loops"] == 2),
        "{plan}"
    );
    assert!(
        !nodes.iter().any(|node| node["Node Type"] == "Seq Scan"
            && matches!(
                node["Relation Name"].as_str(),
                Some("messages" | "message_search_terms")
            )),
        "{plan}"
    );
    assert!(
        nodes
            .iter()
            .any(|node| node["Relation Name"] == "messages" && node["Node Type"] == "Index Scan"),
        "{plan}"
    );
    let term_scan = nodes
        .iter()
        .find(|node| node["Index Name"] == "message_search_terms_lookup")
        .unwrap();
    assert_eq!(term_scan["Actual Rows"].as_f64(), Some(46.0), "{plan}");
    assert!(
        term_scan["Index Cond"].as_str().unwrap().contains("$3"),
        "{plan}"
    );
}
