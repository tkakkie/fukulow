use super::*;
use sqlx::postgres::PgPoolOptions;

#[fukulow_test::test]
async fn timeline_and_single_topic_never_cache_a_generic_plan(pool: PgPool) {
    let (app, _, _, channel, token) = fixture(&pool).await;
    let message = sent(&app, &token, channel, topic_input(Uuid::new_v4(), "Topic")).await;
    let restricted = crate::test_app_pool(pool).await;
    let single = PgPoolOptions::new()
        .max_connections(1)
        .connect_with(restricted.connect_options().as_ref().clone())
        .await
        .unwrap();
    let state = AppState::with_test_pool(single.clone());
    // Size watermark admission from the ordinary pool; all reads still use the
    // sole connection, including authorization, watermark and page snapshot.
    state.message_delivery.admission(&restricted);
    let app = crate::app(state);
    let pid: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
        .fetch_one(&single)
        .await
        .unwrap();
    let restricted_role: bool = sqlx::query_scalar(
        "SELECT NOT (rolsuper OR rolbypassrls) FROM pg_roles WHERE rolname=current_user",
    )
    .fetch_one(&single)
    .await
    .unwrap();
    assert!(restricted_role);
    for suffix in [
        "timeline".to_owned(),
        format!("topics/{}", message["topic_id"].as_str().unwrap()),
    ] {
        for _ in 0..12 {
            let page = get(&app, &token, channel, &suffix).await;
            assert_eq!(page["as_of_seq"], 1);
            let summary = if suffix == "timeline" {
                &page["items"][0]["topic"]
            } else {
                &page["topic"]
            };
            assert_eq!(summary["latest_message"], message);
        }
        let (same, cached): (i32, i64) = sqlx::query_as(
            "SELECT pg_backend_pid(), count(*) FROM pg_prepared_statements \
             WHERE statement LIKE $1",
        )
        .bind("%positions AS (%")
        .fetch_one(&single)
        .await
        .unwrap();
        assert_eq!(same, pid, "reads must reuse the inspected backend");
        assert_eq!(
            cached, 0,
            "{suffix}: projection must never retain a prepared plan"
        );
    }
    single.close().await;
    restricted.close().await;
}
