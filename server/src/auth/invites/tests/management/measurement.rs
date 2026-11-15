use super::super::super::management::{LIST_SQL, OutstandingInvite};
use super::*;
use std::time::Instant;

// Exact list statement before the expiry-range fix, including the anchor subquery.
const BEFORE: &str = "SELECT id,email,role,created_by,to_char(expires_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS expires_at FROM invites \
             WHERE organization_id=$1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at>clock_timestamp() \
             AND ($2 OR role<>'owner') AND ($3::uuid IS NULL OR (created_at,id) > \
             (SELECT created_at,id FROM invites WHERE organization_id=$1 AND id=$3)) ORDER BY created_at,id LIMIT 101";
fn distribution(mut values: Vec<f64>) -> Value {
    values.sort_by(f64::total_cmp);
    let at = |p: f64| values[(values.len() as f64 * p).ceil() as usize - 1];
    json!({"n":values.len(),"p50":at(0.50),"p95":at(0.95),"p99":at(0.99)})
}

async fn dataset(pool: &sqlx::PgPool, org: Uuid, issuer: Uuid, count: i32) {
    sqlx::query("DELETE FROM invites WHERE organization_id=$1")
        .bind(org)
        .execute(pool)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO invites (organization_id,id,created_by,email,role,token_hash,created_at,expires_at,accepted_at,revoked_at) \
         SELECT $1,gen_random_uuid(),$2,'perf-'||n||'@example.invalid', \
         CASE WHEN n%20=0 THEN 'owner' ELSE 'member' END, \
         sha256(convert_to(gen_random_uuid()::text,'UTF8')), \
         now()-interval '30 days'+n*interval '1 microsecond', \
         CASE WHEN n<=$3 THEN now()-interval '1 day' ELSE now()+interval '7 days' END, \
         CASE WHEN n>$3+260 AND n<=$3+265 THEN now() END, \
         CASE WHEN n>$3+265 THEN now() END FROM generate_series(1,$3+270) n",
    ).bind(org).bind(issuer).bind(count).execute(pool).await.unwrap();
    sqlx::query("VACUUM ANALYZE invites")
        .execute(pool)
        .await
        .unwrap();
}

// Mirrors the endpoint transaction, sharing its exact statement, authorization,
// context, locks and anchor lookups; excludes HTTP/extractor/JSON serialization.
async fn scan(
    pool: &sqlx::PgPool,
    auth: Auth,
    owner: bool,
    cursor: Option<Uuid>,
    sql: &str,
    started: Option<tokio::sync::oneshot::Sender<()>>,
) {
    let org = auth.identity.organization.organization_id;
    crate::database::organization(pool, org, async |tx: &mut sqlx::PgConnection| {
        members::lock_organization(tx, org).await?;
        members::current_actor(tx, &auth, Action::Invite(Role::Member)).await?;
        if let Some(started) = started { let _ = started.send(()); }
        let column = if owner { "owner_cursor" } else { "admin_cursor" };
        let anchor = if let Some(cursor) = cursor {
            Some(sqlx::query_scalar::<_,Uuid>(&format!("SELECT id FROM invites WHERE organization_id=$1 AND {column}=$2 AND ($3 OR role<>'owner')"))
                .bind(org).bind(cursor).bind(owner).fetch_one(&mut *tx).await?)
        } else { None };
        let rows: Vec<OutstandingInvite> = sqlx::query_as(sql).bind(org).bind(owner).bind(anchor).fetch_all(&mut *tx).await?;
        if rows.len()>100 {
            let _: Uuid = sqlx::query_scalar(&format!("SELECT {column} FROM invites WHERE organization_id=$1 AND id=$2"))
                .bind(org).bind(rows[99].id).fetch_one(&mut *tx).await?;
        }
        Ok::<_,ApiError>(())
    }).await.unwrap();
}

#[fukulow_test::test]
#[ignore = "manual release Invite scan/lock measurement; disposable DB, no parallel builds"]
async fn measure_invite_expiry_scan(pool: sqlx::PgPool) {
    let org = org(&pool).await;
    let (owner_account, issuer, owner_email, owner_token) = account(&pool, org, Role::Owner).await;
    let (admin_account, admin_member, _, admin_token) = account(&pool, org, Role::Admin).await;
    let (_, target, _, _) = account(&pool, org, Role::Member).await;
    let other = org_fn(&pool).await;
    let (_, other_issuer, _, other_token) = account(&pool, other, Role::Owner).await;
    dataset(&pool, other, other_issuer, 10000).await;
    let state = AppState::for_test(pool.clone()).await;
    let app = crate::app(state.clone()).layer(axum::Extension(axum::extract::ConnectInfo(
        "127.0.0.1:3030".parse::<std::net::SocketAddr>().unwrap(),
    )));
    let password = "measurement password long enough";
    let hash = password::hash_password(password.into(), &PASSWORD_WORKERS)
        .await
        .unwrap();
    sqlx::query("UPDATE accounts SET password_hash=$1 WHERE id=$2")
        .bind(hash)
        .bind(owner_account)
        .execute(&pool)
        .await
        .unwrap();
    let channel = body(
        req(
            &app,
            "POST",
            &format!("/api/v1/orgs/{org}/channels"),
            Some(&owner_token),
            json!({"name":"measurement","visibility":"public"}),
        )
        .await,
    )
    .await;
    let channel = channel["id"].as_str().unwrap();
    let settings: Value = sqlx::query_scalar("SELECT jsonb_object_agg(n,current_setting(n)) FROM unnest(ARRAY['server_version','shared_buffers','work_mem','max_connections','effective_cache_size','random_page_cost','plan_cache_mode','jit','fsync','synchronous_commit']) n").fetch_one(&pool).await.unwrap();
    println!("INVITE_META {settings}");
    let samples: usize = std::env::var("INVITE_SAMPLES")
        .unwrap_or("100".into())
        .parse()
        .unwrap();
    let counts = std::env::var("INVITE_COUNTS").unwrap_or("10000,100000,1000000".into());
    for count in counts.split(',').map(|n| n.parse::<i32>().unwrap()) {
        dataset(&pool, org, issuer, count).await;
        for (variant, sql) in [("before", BEFORE), ("after", LIST_SQL)] {
            if variant == "before" {
                sqlx::raw_sql("DROP INDEX invites_outstanding_expiry; CREATE INDEX invites_outstanding_order ON invites (organization_id,created_at,id) WHERE accepted_at IS NULL AND revoked_at IS NULL").execute(&pool).await.unwrap();
            } else {
                sqlx::raw_sql(include_str!(
                    "../../../../../migrations/202611140388_invite_expiry_scan.sql"
                ))
                .execute(&pool)
                .await
                .unwrap();
            }
            // A fresh connection cache for each schema, naturally reaching generic plans.
            let measured = sqlx::postgres::PgPoolOptions::new()
                .max_connections(8)
                .connect_with(state.pool.connect_options().as_ref().clone())
                .await
                .unwrap();
            for owner in [true, false] {
                let column = if owner {
                    "owner_cursor"
                } else {
                    "admin_cursor"
                };
                let actor = || {
                    if owner {
                        captured_auth(org, issuer, owner_account, &owner_token, Role::Owner)
                    } else {
                        captured_auth(org, admin_member, admin_account, &admin_token, Role::Admin)
                    }
                };
                let anchors: Vec<(Uuid,Uuid)> = sqlx::query_as(&format!("SELECT id,{column} FROM invites WHERE organization_id=$1 AND ($2 OR role<>'owner') ORDER BY created_at,id OFFSET $3 LIMIT 1"))
                    .bind(org).bind(owner).bind(count/2).fetch_all(&pool).await.unwrap();
                let expired = anchors[0];
                let normal: (Uuid,Uuid)=sqlx::query_as(&format!("SELECT id,{column} FROM invites WHERE organization_id=$1 AND expires_at>now() AND ($2 OR role<>'owner') ORDER BY created_at,id OFFSET 99 LIMIT 1"))
                    .bind(org).bind(owner).fetch_one(&pool).await.unwrap();
                for (page, anchor) in [
                    ("first", None),
                    ("cursor", Some(normal)),
                    ("expired", Some(expired)),
                ] {
                    for _ in 0..10 {
                        scan(&measured, actor(), owner, anchor.map(|a| a.1), sql, None).await;
                    }
                    let mut times = vec![];
                    for _ in 0..samples {
                        let start = Instant::now();
                        scan(&measured, actor(), owner, anchor.map(|a| a.1), sql, None).await;
                        times.push(start.elapsed().as_secs_f64() * 1000.0);
                    }
                    println!(
                        "INVITE_LIST {}",
                        json!({"count":count,"variant":variant,"owner":owner,"page":page,"ms":distribution(times)})
                    );
                    let plan: Value = crate::database::organization(
                        &measured,
                        org,
                        async |tx: &mut sqlx::PgConnection| {
                            sqlx::query_scalar(&format!(
                                "EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) {sql}"
                            ))
                            .bind(org)
                            .bind(owner)
                            .bind(anchor.map(|a| a.0))
                            .fetch_one(tx)
                            .await
                        },
                    )
                    .await
                    .unwrap();
                    println!(
                        "INVITE_PLAN {}",
                        json!({"count":count,"variant":variant,"owner":owner,"page":page,"plan":plan})
                    );
                    let generic: Value = crate::database::organization(
                        &measured,
                        org,
                        async |tx: &mut sqlx::PgConnection| {
                            sqlx::query("SET LOCAL plan_cache_mode=force_generic_plan")
                                .execute(&mut *tx)
                                .await?;
                            sqlx::query_scalar(&format!(
                                "EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) {sql}"
                            ))
                            .bind(org)
                            .bind(owner)
                            .bind(anchor.map(|a| a.0))
                            .fetch_one(tx)
                            .await
                        },
                    )
                    .await
                    .unwrap();
                    println!(
                        "INVITE_GENERIC {}",
                        json!({"count":count,"variant":variant,"owner":owner,"page":page,"plan":generic})
                    );
                }
                for (name, query, key) in [
                    (
                        "opaque",
                        format!(
                            "SELECT id FROM invites WHERE organization_id=$1 AND {column}=$2 AND ($3 OR role<>'owner')"
                        ),
                        expired.1,
                    ),
                    (
                        "boundary",
                        "SELECT created_at,id FROM invites WHERE organization_id=$1 AND id=$2"
                            .into(),
                        expired.0,
                    ),
                    (
                        "next",
                        format!("SELECT {column} FROM invites WHERE organization_id=$1 AND id=$2"),
                        normal.0,
                    ),
                ] {
                    let plan: Value = crate::database::organization(
                        &measured,
                        org,
                        async |tx: &mut sqlx::PgConnection| {
                            let explained =
                                format!("EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) {query}");
                            let query = sqlx::query_scalar(&explained).bind(org).bind(key);
                            let query = if name == "opaque" {
                                query.bind(owner)
                            } else {
                                query
                            };
                            query.fetch_one(tx).await
                        },
                    )
                    .await
                    .unwrap();
                    println!(
                        "INVITE_ANCHOR {}",
                        json!({"count":count,"variant":variant,"owner":owner,"name":name,"plan":plan})
                    );
                }
            }
            // Full in-process HTTP requests against a burst of four lists. Timing
            // starts once the first has acquired Organization/actor locks.
            for op in [
                "create",
                "accept",
                "revoke",
                "role",
                "signin",
                "send",
                "other-create",
                "list",
            ] {
                for concurrent in [false, true] {
                    let mut times = vec![];
                    for sample in 0..samples {
                        // One successful send per fresh Member keeps production
                        // send limits intact; fixture creation is outside timing.
                        let sender = if op == "send" {
                            Some(account(&pool, org, Role::Member).await.3)
                        } else {
                            None
                        };
                        let mut token = Some(owner_token.as_str());
                        let (method, url, input, status) = match op {
                            "create" => (
                                "POST",
                                path(org),
                                json!({"email":"new@perf.invalid","role":"member"}),
                                StatusCode::CREATED,
                            ),
                            "other-create" => {
                                token = Some(&other_token);
                                (
                                    "POST",
                                    path(other),
                                    json!({"email":"new@perf.invalid","role":"member"}),
                                    StatusCode::CREATED,
                                )
                            }
                            "revoke" => {
                                let i = invite(
                                    &app,
                                    org,
                                    &owner_token,
                                    "revoke@perf.invalid",
                                    Role::Member,
                                )
                                .await;
                                (
                                    "DELETE",
                                    format!("{}/{}", path(org), id(&i)),
                                    Value::Null,
                                    StatusCode::NO_CONTENT,
                                )
                            }
                            "accept" => {
                                let (_, _, email, t) = account(&pool, other, Role::Member).await;
                                let i = invite(&app, org, &owner_token, &email, Role::Member).await;
                                // Keep the owned token alive for the request below.
                                token = None;
                                (
                                    "POST",
                                    format!("{}/accept", path(org)),
                                    json!({"token":i["token"],"email":email,"name":"Accepted","auth_token":t}),
                                    StatusCode::OK,
                                )
                            }
                            "role" => (
                                "PATCH",
                                format!("/api/v1/orgs/{org}/members/{target}/role"),
                                json!({"role":if sample%2==0 {"admin"} else {"member"}}),
                                StatusCode::OK,
                            ),
                            "signin" => {
                                token = None;
                                (
                                    "POST",
                                    "/api/v1/session".into(),
                                    json!({"email":owner_email,"password":password}),
                                    StatusCode::OK,
                                )
                            }
                            "send" => {
                                token = sender.as_deref();
                                (
                                    "POST",
                                    format!("/api/v1/orgs/{org}/channels/{channel}/messages"),
                                    json!({"client_message_id":Uuid::new_v4(),"body":"measurement"}),
                                    StatusCode::CREATED,
                                )
                            }
                            _ => ("GET", path(org), Value::Null, StatusCode::OK),
                        };
                        let mut input = input;
                        let accept_token = input
                            .get("auth_token")
                            .and_then(Value::as_str)
                            .map(str::to_owned);
                        if let Some(t) = accept_token.as_deref() {
                            token = Some(t);
                            input.as_object_mut().unwrap().remove("auth_token");
                        }
                        let mut pending = vec![];
                        if concurrent {
                            let (started, ready) = tokio::sync::oneshot::channel();
                            let mut started = Some(started);
                            for _ in 0..4 {
                                let p = measured.clone();
                                let auth = captured_auth(
                                    org,
                                    issuer,
                                    owner_account,
                                    &owner_token,
                                    Role::Owner,
                                );
                                let signal = started.take();
                                pending.push(tokio::spawn(async move {
                                    scan(&p, auth, true, None, sql, signal).await;
                                }));
                            }
                            ready.await.unwrap();
                        }
                        let start = Instant::now();
                        let response = req(&app, method, &url, token, input).await;
                        let elapsed = start.elapsed().as_secs_f64() * 1000.0;
                        assert_eq!(response.status(), status, "{op}: {}", body(response).await);
                        times.push(elapsed);
                        for pending in pending {
                            pending.await.unwrap();
                        }
                    }
                    println!(
                        "INVITE_OP {}",
                        json!({"count":count,"variant":variant,"op":op,"concurrent":concurrent,"ms":distribution(times)})
                    );
                }
                sqlx::query("DELETE FROM invites WHERE organization_id=$1 AND created_at>now()-interval '29 days'").bind(org).execute(&pool).await.unwrap();
            }
            measured.close().await;
        }
    }
}

#[fukulow_test::test]
#[ignore = "manual live-heavy tradeoff control for the expiry-range index"]
async fn measure_invite_live_sort(pool: sqlx::PgPool) {
    let org = org(&pool).await;
    let (account_id, issuer, _, token) = account(&pool, org, Role::Owner).await;
    for _ in 0..2 {
        let other = org_fn(&pool).await;
        let (_, member, _, _) = account(&pool, other, Role::Owner).await;
        dataset(&pool, other, member, 1000).await;
    }
    let state = AppState::for_test(pool.clone()).await;
    for live in [10000, 100000] {
        sqlx::query("DELETE FROM invites WHERE organization_id=$1")
            .bind(org)
            .execute(&pool)
            .await
            .unwrap();
        seed(&pool, org, issuer, live, false).await;
        sqlx::query("VACUUM ANALYZE invites")
            .execute(&pool)
            .await
            .unwrap();
        for (variant, sql) in [("before", BEFORE), ("after", LIST_SQL)] {
            if variant == "before" {
                sqlx::raw_sql("DROP INDEX invites_outstanding_expiry; CREATE INDEX invites_outstanding_order ON invites (organization_id,created_at,id) WHERE accepted_at IS NULL AND revoked_at IS NULL").execute(&pool).await.unwrap();
            } else {
                sqlx::raw_sql(include_str!(
                    "../../../../../migrations/202611140388_invite_expiry_scan.sql"
                ))
                .execute(&pool)
                .await
                .unwrap();
            }
            let mut times = vec![];
            for n in 0..110 {
                let start = Instant::now();
                scan(
                    &state.pool,
                    captured_auth(org, issuer, account_id, &token, Role::Owner),
                    true,
                    None,
                    sql,
                    None,
                )
                .await;
                if n >= 10 {
                    times.push(start.elapsed().as_secs_f64() * 1000.0);
                }
            }
            println!(
                "INVITE_LIVE {}",
                json!({"live":live,"variant":variant,"ms":distribution(times)})
            );
        }
    }
}
