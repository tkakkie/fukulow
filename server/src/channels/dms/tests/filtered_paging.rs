use super::*;

#[fukulow_test::test]
async fn filtered_discovery_pages_advance_selected_boundaries_until_exhausted(pool: PgPool) {
    let f = Fixture::new(pool, "member").await;
    let mut channels = super::paging::large_fixture(&f, 103).await;
    channels.sort();
    let authorized = channels[50];
    // Keep the candidates and positions, but invalidate every other grant lifetime.
    let filtered = sqlx::query("UPDATE channel_members SET grant_id=gen_random_uuid() WHERE organization_id=$1 AND member_id=$2 AND channel_id<>$3")
        .bind(f.org).bind(f.a).bind(authorized)
        .execute(&f.pools.admin).await.unwrap();
    assert_eq!(filtered.rows_affected(), 102);
    let actor = extract_auth(f.state.clone(), &f.at).await;
    let mut tx = f.pools.app.begin().await.unwrap();
    crate::database::set_organization(&mut tx, f.org)
        .await
        .unwrap();
    for mode in ["force_custom_plan", "force_generic_plan"] {
        sqlx::query(&format!("SET LOCAL plan_cache_mode={mode}"))
            .execute(&mut *tx)
            .await
            .unwrap();
        for lane in ["delta", "coverage"] {
            let mut cursor = Cursor::default();
            for (at, caught_up) in [(50, false), (100, false), (103, true)] {
                let page = discovery::page(&mut tx, &actor, &f.state.setup_token, lane, cursor)
                    .await
                    .unwrap();
                let ids = page.dms.iter().map(|d| d.id).collect::<Vec<_>>();
                assert_eq!(
                    ids,
                    if at == 100 { vec![authorized] } else { vec![] },
                    "{mode} {lane} at={at}"
                );
                assert_eq!(page.caught_up, caught_up, "{mode} {lane} at={at}");
                cursor =
                    Cursor::decode(&page.next_cursor, &f.state.setup_token, &actor, lane).unwrap();
                assert_eq!(cursor.at, at, "{mode} {lane}");
                assert_eq!(cursor.exhausted, caught_up, "{mode} {lane} at={at}");
                assert_eq!(cursor.ceiling, (lane == "coverage").then_some(103));
            }
        }
    }
    tx.rollback().await.unwrap();
    f.pools.app.close().await;
}
