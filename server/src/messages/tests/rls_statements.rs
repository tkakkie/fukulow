//! #314 step 4 condition 3: every one-statement context path reads only the
//! context Organization under production RLS, with custom and generic plans,
//! alternating Organizations on one reused connection.
use super::*;
use crate::{channels, messages};
use sqlx::postgres::PgPoolOptions;

#[sqlx::test]
async fn one_statement_paths_read_only_the_context_organization_under_rls(pool: PgPool) {
    // Identical Member/Channel ids in both Organizations: only the
    // Organization (predicate plus RLS context) tells their rows apart.
    let (member_id, channel_id) = (Uuid::new_v4(), Uuid::new_v4());
    let mut tenants = Vec::new();
    for _ in 0..2 {
        let organization_id = organization(&pool).await;
        let token = member(&pool, organization_id, member_id).await;
        channel(&pool, organization_id, channel_id, member_id, false).await;
        let revision: i64 = sqlx::query_scalar(
            "SELECT membership_revision FROM users WHERE organization_id = $1 AND id = $2",
        )
        .bind(organization_id)
        .bind(member_id)
        .fetch_one(&pool)
        .await
        .unwrap();
        tenants.push((organization_id, token, revision));
    }
    let app_pool = crate::test_app_pool(pool.clone()).await;
    for mode in ["force_custom_plan", "force_generic_plan"] {
        let single = PgPoolOptions::new()
            .max_connections(1)
            .after_connect(move |connection, _| {
                Box::pin(async move {
                    sqlx::Executor::execute(
                        connection,
                        format!("SET plan_cache_mode = {mode}").as_str(),
                    )
                    .await
                    .map(|_| ())
                })
            })
            .connect_with(app_pool.connect_options().as_ref().clone())
            .await
            .unwrap();
        let pid: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
            .fetch_one(&single)
            .await
            .unwrap();
        let app = crate::app(AppState::for_test(single.clone()).await);
        // Sends use the shared COMMIT-barrier statement.
        for round in 0..3 {
            for (index, (_, token, _)) in tenants.iter().enumerate() {
                sent(
                    &app,
                    token,
                    channel_id,
                    input(Uuid::new_v4(), &format!("{index}/{round}")),
                )
                .await;
            }
        }
        for _ in 0..4 {
            for (index, (organization_id, _, revision)) in tenants.iter().enumerate() {
                let (organization_id, member) = (*organization_id, (member_id, *revision));
                let expected: Vec<String> =
                    (0..3).map(|round| format!("{index}/{round}")).collect();
                assert_eq!(
                    channels::is_visible_scoped(&single, organization_id, member, channel_id)
                        .await
                        .unwrap(),
                    Some(true),
                    "{mode}: visibility"
                );
                assert_eq!(
                    channels::member_access(&single, organization_id, channel_id, &[member])
                        .await
                        .unwrap(),
                    vec![(member.0, member.1, true)],
                    "{mode}: member_access"
                );
                assert_eq!(
                    channels::access_row_for_test(&single, organization_id, member, channel_id)
                        .await
                        .unwrap(),
                    (true, None, true),
                    "{mode}: access_rows"
                );
                let bodies =
                    |page: Vec<Message>| page.into_iter().map(|m| m.body).collect::<Vec<_>>();
                assert_eq!(
                    bodies(
                        messages::replay_page(&single, organization_id, channel_id, 0, 10)
                            .await
                            .unwrap()
                    ),
                    expected,
                    "{mode}: replay_page"
                );
                assert_eq!(
                    bodies(
                        messages::authorized_replay_page(
                            &single,
                            organization_id,
                            member,
                            channel_id,
                            0,
                            10
                        )
                        .await
                        .unwrap_or_else(|_| panic!("{mode}: authorized_replay_page"))
                    ),
                    expected,
                    "{mode}: authorized_replay_page"
                );
                // No context outlives a statement on the reused connection.
                let (same, context): (i32, Option<String>) = sqlx::query_as(
                    "SELECT pg_backend_pid(), NULLIF(current_setting('fukulow.organization_id', true), '')",
                )
                .fetch_one(&single)
                .await
                .unwrap();
                assert_eq!((same, context), (pid, None), "{mode}: reused, clean");
            }
        }
        single.close().await;
    }
    app_pool.close().await;
}
