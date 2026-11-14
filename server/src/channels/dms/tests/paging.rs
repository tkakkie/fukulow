use super::*;
use std::collections::HashSet;

async fn changes(f: &Fixture, token: &str, lane: &str, cursor: Option<&str>) -> Value {
    let suffix = format!(
        "/api/v1/dms/changes?lane={lane}{}",
        cursor.map(|c| format!("&cursor={c}")).unwrap_or_default()
    );
    f.get(token, &suffix).await
}

#[fukulow_test::test]
async fn creation_order_pages_and_id_refresh_authorize_before_cursor_validation(pool: PgPool) {
    let f = Fixture::new(pool, "guest").await;
    // Seed equal immutable timestamps at creation to exercise the UUID tie-breaker.
    let expected = large_fixture(&f, 51)
        .await
        .into_iter()
        .map(|id| id.to_string())
        .collect::<HashSet<_>>();
    let first = f.get(&f.at, "/api/v1/dms").await;
    assert_eq!(first["dms"].as_array().unwrap().len(), 50);
    let cursor = first["next_cursor"].as_str().unwrap();
    let second = f.get(&f.at, &format!("/api/v1/dms?cursor={cursor}")).await;
    assert_eq!(second["dms"].as_array().unwrap().len(), 1);
    assert!(second["next_cursor"].is_null());
    let found = first["dms"]
        .as_array()
        .unwrap()
        .iter()
        .chain(second["dms"].as_array().unwrap())
        .map(|v| v["id"].as_str().unwrap().to_owned())
        .collect::<HashSet<_>>();
    assert_eq!(found, expected);
    let id = first["dms"][0]["id"].as_str().unwrap();
    let batch = f
        .get(
            &f.at,
            &format!("/api/v1/dms?channel_id={id}&channel_id={}", Uuid::new_v4()),
        )
        .await;
    assert_eq!(batch["dms"].as_array().unwrap().len(), 1);
    assert!(batch["next_cursor"].is_null());
    for query in [
        "limit=1".to_string(),
        "channel_id=".into(),
        format!("channel_id={id}&channel_id={id}"),
        format!("cursor={cursor}&channel_id={id}"),
        "cursor=tampered".into(),
    ] {
        let r = request(
            &f.app,
            "GET",
            &format!("/api/v1/dms?{query}"),
            &f.at,
            Value::Null,
        )
        .await;
        assert_eq!(r.status(), StatusCode::BAD_REQUEST, "{query}");
        assert_eq!(body(r).await, json!({"error":"invalid input"}));
    }
    let r = request(
        &f.app,
        "GET",
        &format!("/api/v1/dms?cursor={cursor}"),
        &f.bt,
        Value::Null,
    )
    .await;
    assert_eq!(r.status(), StatusCode::BAD_REQUEST);
    f.deactivate(f.a).await;
    let r = request(
        &f.app,
        "GET",
        "/api/v1/dms?cursor=tampered",
        &f.at,
        Value::Null,
    )
    .await;
    assert_eq!(r.status(), StatusCode::NOT_FOUND);
    assert_eq!(body(r).await, json!({"error":"organization_unavailable"}));
    f.pools.app.close().await;
}

#[fukulow_test::test]
async fn discovery_coalesces_and_coverage_cannot_skip_hot_rows_or_acknowledge_delta(pool: PgPool) {
    let f = Fixture::new(pool, "guest").await;
    let mut channels = Vec::new();
    for _ in 0..51 {
        let peer = Uuid::new_v4();
        member(&f.pools.admin, f.org, peer, "guest").await;
        let r = f.open(&f.at, peer, false).await;
        assert_eq!(r.status(), StatusCode::CREATED);
        channels.push(Uuid::parse_str(body(r).await["id"].as_str().unwrap()).unwrap());
    }
    let first = changes(&f, &f.at, "coverage", None).await;
    assert_eq!(first["dms"].as_array().unwrap().len(), 50);
    assert_eq!(first["caught_up"], false);
    for _ in 0..5 {
        assert_eq!(
            f.send(&f.at, channels[50], Uuid::new_v4()).await.status(),
            StatusCode::CREATED
        );
    }
    let second = changes(&f, &f.at, "coverage", first["next_cursor"].as_str()).await;
    assert_eq!(second["dms"].as_array().unwrap().len(), 1);
    assert_eq!(second["dms"][0]["id"], channels[50].to_string());
    assert_eq!(second["caught_up"], true);
    let d1 = changes(&f, &f.at, "delta", None).await;
    assert_eq!(d1["dms"].as_array().unwrap().len(), 50);
    assert_eq!(d1["caught_up"], false);
    let d2 = changes(&f, &f.at, "delta", d1["next_cursor"].as_str()).await;
    assert_eq!(d2["dms"][0]["id"], channels[50].to_string());
    assert_eq!(d2["caught_up"], true);
    assert!(d2["dms"][0].get("unread_count").is_none());
    assert!(d2["dms"][0].get("as_of_seq").is_none());
    let n: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM dm_discovery WHERE organization_id=$1 AND member_id=$2",
    )
    .bind(f.org)
    .bind(f.a)
    .fetch_one(&f.pools.admin)
    .await
    .unwrap();
    assert_eq!(n, 51);
    for query in ["lane=no", "lane=delta&limit=1", "lane=delta&lane=delta", ""] {
        let r = request(
            &f.app,
            "GET",
            &format!("/api/v1/dms/changes?{query}"),
            &f.at,
            Value::Null,
        )
        .await;
        assert_eq!(r.status(), StatusCode::BAD_REQUEST);
    }
    // Tokens are authenticated, encrypted and bound to lane and Account Session.
    for (token, lane, cursor) in [
        (&f.at, "delta", first["next_cursor"].as_str().unwrap()),
        (&f.bt, "coverage", first["next_cursor"].as_str().unwrap()),
    ] {
        let r = request(
            &f.app,
            "GET",
            &format!("/api/v1/dms/changes?lane={lane}&cursor={cursor}"),
            token,
            Value::Null,
        )
        .await;
        assert_eq!(r.status(), StatusCode::BAD_REQUEST);
    }
    f.pools.app.close().await;
}

#[fukulow_test::test]
async fn delayed_renewal_behind_both_cursors_remains_pending_and_rollback_is_atomic(pool: PgPool) {
    let f = Fixture::new(pool, "member").await;
    let c = f.dm().await;
    let delta = changes(&f, &f.at, "delta", None).await;
    let coverage = changes(&f, &f.at, "coverage", None).await;
    f.deactivate(f.b).await;
    f.reactivate(f.b).await;
    let actor = extract_auth(f.state.clone(), &f.at).await;
    let mut pending = f.pools.admin.begin().await.unwrap();
    let (id, new, _notice) = open(
        &mut pending,
        &actor,
        &OpenDmRequest {
            member_id: f.b,
            renew: true,
        },
        &activity::Activity::default(),
    )
    .await
    .unwrap();
    assert_eq!(id, c);
    assert!(!new);
    let early_delta = changes(&f, &f.at, "delta", delta["next_cursor"].as_str()).await;
    assert_eq!(early_delta["dms"], json!([]));
    let early_coverage = changes(&f, &f.at, "coverage", coverage["next_cursor"].as_str()).await;
    assert_eq!(early_coverage["dms"].as_array().unwrap().len(), 1);
    // An old birth can be behind coverage; the independent delta must retain debt.
    pending.commit().await.unwrap();
    let late = changes(&f, &f.at, "delta", early_delta["next_cursor"].as_str()).await;
    assert_eq!(late["dms"][0]["id"], c.to_string());
    assert_eq!(late["caught_up"], true);
    let before = f.snapshot().await;
    let grants:Vec<(Uuid,i64,Uuid)>=sqlx::query_as("SELECT member_id,membership_revision,grant_id FROM channel_members WHERE organization_id=$1 AND channel_id=$2 ORDER BY member_id").bind(f.org).bind(c).fetch_all(&f.pools.admin).await.unwrap();
    let mut aborted = f.pools.admin.begin().await.unwrap();
    discovery::bump(&mut aborted, f.org, c, &grants)
        .await
        .unwrap();
    aborted.rollback().await.unwrap();
    assert_eq!(f.snapshot().await, before);
    let quiet = changes(&f, &f.at, "delta", late["next_cursor"].as_str()).await;
    assert_eq!(quiet["dms"], json!([]));
    f.pools.app.close().await;
}

#[fukulow_test::test]
async fn cursors_bind_to_the_issuing_account_session_for_the_same_member_revision(pool: PgPool) {
    use sha2::{Digest, Sha256};

    let f = Fixture::new(pool, "guest").await;
    large_fixture(&f, 51).await;
    let other = format!(
        "{}.{}{}",
        f.org,
        Uuid::new_v4().simple(),
        Uuid::new_v4().simple()
    );
    sqlx::query("INSERT INTO account_sessions(token_hash,account_id) SELECT $1,account_id FROM users WHERE organization_id=$2 AND id=$3")
        .bind(Sha256::digest(other.as_bytes()).to_vec()).bind(f.org).bind(f.a)
        .execute(&f.pools.admin).await.unwrap();
    let issuing = extract_auth(f.state.clone(), &f.at).await;
    let receiving = extract_auth(f.state.clone(), &other).await;
    assert_eq!(issuing.identity.member.id, receiving.identity.member.id);
    assert_eq!(issuing.membership_revision, receiving.membership_revision);
    assert_ne!(issuing.session_scope(), receiving.session_scope());
    // Both live Sessions have identical authority before a cursor is supplied.
    for token in [&f.at, &other] {
        assert_eq!(
            f.get(token, "/api/v1/dms").await["dms"]
                .as_array()
                .unwrap()
                .len(),
            50
        );
    }
    let list = f.get(&f.at, "/api/v1/dms").await;
    let delta = changes(&f, &f.at, "delta", None).await;
    let coverage = changes(&f, &f.at, "coverage", None).await;
    let mut rejections = Vec::new();
    for (prefix, page) in [
        ("/api/v1/dms?", list),
        ("/api/v1/dms/changes?lane=delta&", delta),
        ("/api/v1/dms/changes?lane=coverage&", coverage),
    ] {
        let path = format!("{prefix}cursor={}", page["next_cursor"].as_str().unwrap());
        // Positive control: the issuing Session can still consume its continuation.
        let accepted = f.get(&f.at, &path).await;
        assert_eq!(accepted["dms"].as_array().unwrap().len(), 1);
        let refused = request(&f.app, "GET", &path, &other, Value::Null).await;
        let status = refused.status();
        let error = body(refused).await;
        rejections.push((prefix, status, error));
    }
    // Assert every lane after exercising them all, including under the negative mutation.
    for (lane, status, error) in rejections {
        assert_eq!(status, StatusCode::BAD_REQUEST, "{lane}");
        assert_eq!(error, json!({"error":"invalid input"}), "{lane}");
    }
    f.pools.app.close().await;
}

// Bulk fixtures isolate traversal work from HTTP setup and historical events.
async fn large_fixture(f: &Fixture, n: usize) -> Vec<Uuid> {
    let peers = (0..n).map(|_| Uuid::new_v4()).collect::<Vec<_>>();
    let channels = (0..n).map(|_| Uuid::new_v4()).collect::<Vec<_>>();
    sqlx::query("INSERT INTO accounts(id,email,password_hash) SELECT id,id::text||'@example.com','unused' FROM unnest($1::uuid[]) p(id)").bind(&peers).execute(&f.pools.admin).await.unwrap();
    sqlx::query("INSERT INTO users(organization_id,id,account_id,name,role) SELECT $1,id,id,'Peer','guest' FROM unnest($2::uuid[]) p(id)").bind(f.org).bind(&peers).execute(&f.pools.admin).await.unwrap();
    let mut tx = f.pools.admin.begin().await.unwrap();
    sqlx::query("INSERT INTO channels(organization_id,id,kind,lower_member_id,higher_member_id,created_at) SELECT $1,c,'dm',least($2,p),greatest($2,p),'2026-01-01'::timestamptz FROM unnest($3::uuid[],$4::uuid[]) r(c,p)").bind(f.org).bind(f.a).bind(&channels).bind(&peers).execute(&mut *tx).await.unwrap();
    sqlx::query("INSERT INTO channel_members(organization_id,channel_id,member_id,membership_revision) SELECT $1,c,id,0 FROM unnest($2::uuid[],$3::uuid[]) r(c,p) CROSS JOIN LATERAL unnest(ARRAY[$4,p]) m(id) ORDER BY id,c").bind(f.org).bind(&channels).bind(&peers).bind(f.a).execute(&mut *tx).await.unwrap();
    sqlx::query("INSERT INTO dm_discovery_counters(organization_id,member_id,membership_revision,position) SELECT $1,id,0,CASE WHEN id=$2 THEN $4 ELSE 1 END FROM unnest($3::uuid[] || ARRAY[$2]) m(id)").bind(f.org).bind(f.a).bind(&peers).bind(n as i64).execute(&mut *tx).await.unwrap();
    sqlx::query("INSERT INTO dm_discovery(organization_id,member_id,membership_revision,channel_id,grant_id,birth_position,latest_position) SELECT organization_id,member_id,membership_revision,channel_id,grant_id,row_number() OVER(PARTITION BY member_id ORDER BY channel_id),row_number() OVER(PARTITION BY member_id ORDER BY channel_id) FROM channel_members WHERE organization_id=$1").bind(f.org).execute(&mut *tx).await.unwrap();
    tx.commit().await.unwrap();
    channels
}

#[fukulow_test::test]
async fn quiet_500_501_and_9999_pending_dms_drain_in_q_pages_with_independent_coverage(
    pool: PgPool,
) {
    for n in [500, 501, 9999] {
        let f = Fixture::new(pool.clone(), "guest").await;
        large_fixture(&f, n).await;
        let coverage = changes(&f, &f.at, "coverage", None).await;
        assert_eq!(coverage["dms"].as_array().unwrap().len(), 50);
        let mut cursor = None;
        let mut found = HashSet::new();
        let mut pages = 0;
        loop {
            let p = changes(&f, &f.at, "delta", cursor.as_deref()).await;
            pages += 1;
            for d in p["dms"].as_array().unwrap() {
                assert!(found.insert(d["id"].as_str().unwrap().to_owned()));
            }
            if p["caught_up"] == true {
                break;
            }
            cursor = Some(p["next_cursor"].as_str().unwrap().to_owned());
        }
        assert_eq!(found.len(), n);
        assert_eq!(pages, n.div_ceil(50));
        if n == 500 {
            assert_eq!(pages, 10)
        }
        // Neither delta nor a first-page refresh changes the saved birth boundary.
        let c2 = changes(&f, &f.at, "coverage", coverage["next_cursor"].as_str()).await;
        assert_eq!(c2["dms"].as_array().unwrap().len(), 50);
        assert!(
            c2["dms"]
                .as_array()
                .unwrap()
                .iter()
                .all(|d| !coverage["dms"].as_array().unwrap().contains(d))
        );
        // Same creation timestamps must traverse exactly once by UUID value.
        let first = f.get(&f.at, "/api/v1/dms").await;
        let ids = first["dms"]
            .as_array()
            .unwrap()
            .iter()
            .map(|d| d["id"].as_str().unwrap())
            .collect::<Vec<_>>();
        assert!(ids.windows(2).all(|w| w[0] > w[1]));
        f.pools.app.close().await;
    }
}

#[fukulow_test::test]
async fn delayed_empty_creation_is_above_early_counter_and_later_allocation_waits_for_commit(
    pool: PgPool,
) {
    let f = Fixture::new(pool, "guest").await;
    let actor = extract_auth(f.state.clone(), &f.at).await;
    let initial = changes(&f, &f.at, "delta", None).await;
    assert_eq!(initial["dms"], json!([]));
    let mut creation = f.pools.admin.begin().await.unwrap();
    let (c, created, _notice) = open(
        &mut creation,
        &actor,
        &OpenDmRequest {
            member_id: f.b,
            renew: false,
        },
        &activity::Activity::default(),
    )
    .await
    .unwrap();
    assert!(created);
    let early = changes(&f, &f.at, "delta", initial["next_cursor"].as_str()).await;
    assert_eq!(early["dms"], json!([]));
    let before_coverage = changes(&f, &f.at, "coverage", None).await;
    assert_eq!(before_coverage["dms"], json!([]));
    creation.commit().await.unwrap();
    let late = changes(&f, &f.at, "delta", early["next_cursor"].as_str()).await;
    assert_eq!(late["dms"][0]["id"], c.to_string());
    let after_coverage = changes(
        &f,
        &f.at,
        "coverage",
        before_coverage["next_cursor"].as_str(),
    )
    .await;
    assert_eq!(after_coverage["dms"][0]["id"], c.to_string());
    let grants:Vec<(Uuid,i64,Uuid)>=sqlx::query_as("SELECT member_id,membership_revision,grant_id FROM channel_members WHERE organization_id=$1 AND channel_id=$2 ORDER BY member_id").bind(f.org).bind(c).fetch_all(&f.pools.admin).await.unwrap();
    let mut first = f.pools.admin.begin().await.unwrap();
    discovery::bump(&mut first, f.org, c, &grants)
        .await
        .unwrap();
    let second = {
        let pool = f.pools.admin.clone();
        let org = f.org;
        tokio::spawn(async move {
            let mut tx = pool.begin().await.unwrap();
            discovery::bump(&mut tx, org, c, &grants).await.unwrap();
            tx.commit().await.unwrap();
        })
    };
    super::concurrency::wait_lock(
        &f.pools.admin,
        "INSERT INTO dm_discovery_counters%RETURNING position",
    )
    .await;
    assert!(!second.is_finished());
    let invisible = changes(&f, &f.at, "delta", late["next_cursor"].as_str()).await;
    assert_eq!(invisible["dms"], json!([]));
    first.commit().await.unwrap();
    second.await.unwrap();
    let visible = changes(&f, &f.at, "delta", invisible["next_cursor"].as_str()).await;
    assert_eq!(visible["dms"].as_array().unwrap().len(), 1);
    assert_eq!(visible["dms"][0]["id"], c.to_string());
    f.pools.app.close().await;
}
