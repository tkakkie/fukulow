use super::replay_plans::{explain_replay, relation_nodes};
use super::*;
use crate::messages::log;

const TIP: i64 = 202;

struct Skewed {
    organization: Uuid,
    channel: Uuid,
    sender: Uuid,
    mentioned: Uuid,
    token: String,
}

// The page Organization has a small Channel beside a hot one. A second
// Organization reuses the same Channel, Message and Member ids at 200 times the
// volume, with three Mentions per Message instead of two. Both have thousands of
// Members who are never mentioned.
async fn skewed(pool: &PgPool) -> Skewed {
    let (organization, hot) = (
        super::organization(pool).await,
        super::organization(pool).await,
    );
    let (sender, mentioned, foreign) = (Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4());
    let token = member(pool, organization, sender).await;
    member(pool, organization, mentioned).await;
    for id in [sender, mentioned, foreign] {
        member(pool, hot, id).await;
    }
    // Members who are never mentioned, so the Member directory is not tiny.
    for (scope, count) in [(organization, 2_000), (hot, 5_000)] {
        sqlx::query(
            "WITH a AS (INSERT INTO accounts (id, email, password_hash) \
             SELECT id, id || '@example.com', 'unused' FROM (SELECT gen_random_uuid() AS id \
             FROM generate_series(1, $2::int)) g RETURNING id) \
             INSERT INTO users (organization_id, id, account_id, name, role) \
             SELECT $1, gen_random_uuid(), id, 'Bystander', 'member' FROM a",
        )
        .bind(scope)
        .bind(count)
        .execute(pool)
        .await
        .unwrap();
    }
    let (page, busy) = (Uuid::from_u128(515), Uuid::from_u128(516));
    for (scope, id, size) in [
        (organization, page, TIP),
        (organization, busy, 20_000),
        (hot, page, 40_000),
    ] {
        channel(pool, scope, id, sender, false).await;
        sqlx::query(
            "INSERT INTO messages (organization_id, channel_id, sender, id, seq, client_message_id, body) \
             SELECT $1, $2, $3, md5($2::uuid::text || ':' || n)::uuid, n, gen_random_uuid(), 'skew' \
             FROM generate_series(1, $4::bigint) n",
        )
        .bind(scope).bind(id).bind(sender).bind(size).execute(pool).await.unwrap();
        sqlx::query("INSERT INTO channel_message_sequences (organization_id,channel_id,seq) VALUES ($1,$2,$3)")
            .bind(scope).bind(id).bind(size).execute(pool).await.unwrap();
    }
    // Two Mentions per Message in the page Organization, three in the hot one.
    sqlx::query(
        "INSERT INTO message_mentions (organization_id, channel_id, message_id, member_id) \
         SELECT m.organization_id, m.channel_id, m.id, t.id FROM messages m \
         CROSS JOIN unnest($3::uuid[]) t(id) WHERE m.organization_id IN ($1, $2) \
         AND (m.organization_id = $2 OR t.id <> $3[3])",
    )
    .bind(organization)
    .bind(hot)
    .bind([sender, mentioned, foreign])
    .execute(pool)
    .await
    .unwrap();
    seed_channel_log(pool).await;
    sqlx::query("ANALYZE messages, channel_log, channels, users, message_mentions")
        .execute(pool)
        .await
        .unwrap();
    Skewed {
        organization,
        channel: page,
        sender,
        mentioned,
        token,
    }
}

// Emitted rows alone cannot show a wide read that a Filter narrows, so the
// Mention reads must be keyed on the page Message and remove nothing.
fn check_mention_keys(root: &Value, case: &str, positions: i64, failures: &mut Vec<String>) {
    let mut nodes = Vec::new();
    relation_nodes(root, "message_mentions", &mut nodes);
    if nodes.is_empty() {
        failures.push(format!("{case}: expected a message_mentions scan: {root}"));
    }
    for node in nodes {
        let kind = node["Node Type"].as_str().unwrap_or_default();
        let index = node["Index Cond"].as_str().unwrap_or_default();
        let removed = ["Rows Removed by Filter", "Rows Removed by Index Recheck"]
            .map(|key| node[key].as_f64().unwrap_or(0.0));
        let loops = node["Actual Loops"].as_f64().unwrap();
        let read = node["Actual Rows"].as_f64().unwrap() * loops;
        let checks = [
            (
                matches!(kind, "Index Scan" | "Index Only Scan"),
                format!("Mention read is a {kind}"),
            ),
            (
                index.contains("organization_id = ") && index.contains("message_id = "),
                format!("Mention Index Cond lacks the Organization and Message keys: {index}"),
            ),
            (
                removed == [0.0, 0.0],
                format!("Mention rows removed by Filter/Recheck: {removed:?}"),
            ),
            (
                read == 2.0 * positions as f64 && loops <= positions as f64,
                format!("Mention rows {read} in {loops} loops for {positions} positions"),
            ),
        ];
        failures.extend(
            checks
                .into_iter()
                .filter(|(passed, _)| !passed)
                .map(|(_, detail)| format!("{case}: {detail}")),
        );
    }
}

// The production page plans generically (#515), and there every executed Member
// read is an index lookup bounded by the page's Mentions. The custom plan may
// read the whole Organization directory instead (recorded on PR #797).
fn check_identity_reads(root: &Value, case: &str, positions: i64, failures: &mut Vec<String>) {
    let mut nodes = Vec::new();
    relation_nodes(root, "users", &mut nodes);
    for node in nodes {
        let loops = node["Actual Loops"].as_f64().unwrap();
        let read = node["Actual Rows"].as_f64().unwrap() * loops;
        let kind = node["Node Type"].as_str().unwrap_or_default();
        let removed = node["Rows Removed by Filter"].as_f64().unwrap_or(0.0);
        if loops > 0.0
            && (!matches!(kind, "Index Scan" | "Index Only Scan")
                || removed > 0.0
                || read > 2.0 * positions as f64)
        {
            failures.push(format!(
                "{case}: Member read {kind} of {read} rows removing {removed}"
            ));
        }
    }
}

#[fukulow_test::test]
async fn page_mention_reads_are_key_bounded_under_skewed_organizations(pool: PgPool) {
    let s = skewed(&pool).await;
    let app = crate::test_app_pool(pool.clone()).await;
    let sql = crate::database::organization_statement_sql(&log::authorized_page_sql());
    // The REST page reads its 200-row limit plus one lookahead row.
    let limit = 201;
    let mut failures = Vec::new();
    for after in [2, 1, 0] {
        let positions = (TIP - after).min(limit);
        for mode in ["force_generic_plan", "force_custom_plan"] {
            let args = format!(
                "'{}','{}',0,'{}',{after},{TIP},{limit}",
                s.organization, s.sender, s.channel
            );
            let plan = explain_replay(&app, mode, &sql, &args).await;
            let case = format!("{} remaining {mode}", TIP - after);
            check_mention_keys(&plan[0]["Plan"], &case, positions, &mut failures);
            if mode == "force_generic_plan" {
                check_identity_reads(&plan[0]["Plan"], &case, positions, &mut failures);
            }
        }
    }
    app.close().await;
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[fukulow_test::test]
async fn rest_events_at_the_lookahead_boundary_keep_mentions_in_scope(pool: PgPool) {
    let s = skewed(&pool).await;
    let app = router(&pool).await;
    let mut expected = vec![s.sender, s.mentioned];
    expected.sort();
    // 200, 201 and 202 events remain after the cursor.
    for (after, more) in [(2, false), (1, true), (0, true)] {
        let path = format!(
            "/api/v1/channels/{}/events?after_seq={after}&limit=200",
            s.channel
        );
        let response = request(&app, "GET", &path, &s.token, Value::Null).await;
        assert_eq!(response.status(), StatusCode::OK, "{path}");
        let page = body(response).await;
        let events = page["events"].as_array().unwrap();
        assert_eq!(
            events
                .iter()
                .map(|e| e["seq"].as_i64().unwrap())
                .collect::<Vec<_>>(),
            (after + 1..=after + 200).collect::<Vec<_>>(),
            "{path}"
        );
        assert_eq!(page["has_more"], more, "{path}");
        for event in events {
            let mut ids = event["message"]["mentions"]
                .as_array()
                .unwrap()
                .iter()
                .map(|mention| mention["member_id"].as_str().unwrap().parse().unwrap())
                .collect::<Vec<Uuid>>();
            ids.sort();
            assert_eq!(ids, expected, "{path} seq {}", event["seq"]);
        }
    }
}
