use super::*;
use crate::channels::{
    activity::{Notice, Registration, TestFault, fail, pause_member},
    tests::{body, extract_auth},
};
use sqlx::postgres::{PgPoolOptions, PgSslMode};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const SECTIONS: &str = "/me/sections";

async fn section_request(
    f: &Fixture,
    method: &str,
    suffix: &str,
    token: &str,
    input: Value,
) -> Response {
    request(
        &f.app,
        method,
        &format!("/api/v1/orgs/{}{suffix}", f.organization),
        token,
        input,
    )
    .await
}

async fn layout(f: &Fixture) -> Value {
    let response = section_request(f, "GET", SECTIONS, &f.token, Value::Null).await;
    assert_eq!(response.status(), StatusCode::OK);
    body(response).await
}

async fn create(f: &Fixture, id: Uuid, name: &str) -> Response {
    section_request(f, "POST", SECTIONS, &f.token, json!({"id":id,"name":name})).await
}

async fn expect_once(f: &Fixture, socket: &mut Client, generation: i64) {
    assert_eq!(
        raw_event(socket).await,
        json!({"type":"sections_changed","generation":generation.to_string()})
    );
    assert!(notices(f, socket).await.is_empty());
}

async fn next(registration: &Registration) -> crate::channels::activity::NoticeFrame {
    tokio::time::timeout(Duration::from_secs(5), registration.next())
        .await
        .unwrap()
        .unwrap()
}

async fn quiet(registration: &Registration) {
    assert!(
        tokio::time::timeout(Duration::from_millis(30), registration.next())
            .await
            .is_err()
    );
}

fn gate(f: &Fixture, phase: &'static str, member: Option<Uuid>) -> Arc<Gate> {
    pause_member(f.organization, Uuid::nil(), phase, member)
}

#[fukulow_test::test]
async fn section_notices_report_each_committed_mutation_and_skip_noops_and_refusals(pool: PgPool) {
    let f = fixture(&pool).await;
    let other_channel = channel(&pool, f.organization, f.member, false).await;
    let second = session::another_session(&pool, f.organization, f.member).await;
    let mut caller = connect(&f, &f.token).await;
    let mut idle = connect(&f, &second).await;
    subscribe(&mut caller, f.channel, 0).await;
    assert_eq!(raw_event(&mut caller).await["type"], "subscribed");
    let a = Uuid::new_v4();
    let b = Uuid::new_v4();
    let section = format!("{SECTIONS}/{a}");
    let move_one = format!("/me/channel-sections/{}", f.channel);
    let move_two = format!("/me/channel-sections/{other_channel}");
    for (index, (method, path, input, changed, repeated)) in [
        (
            "POST",
            SECTIONS,
            json!({"id":a,"name":"A"}),
            StatusCode::CREATED,
            StatusCode::OK,
        ),
        (
            "POST",
            SECTIONS,
            json!({"id":b,"name":"B"}),
            StatusCode::CREATED,
            StatusCode::OK,
        ),
        (
            "PATCH",
            &section,
            json!({"name":"Renamed"}),
            StatusCode::NO_CONTENT,
            StatusCode::NO_CONTENT,
        ),
        (
            "PUT",
            "/me/sections/order",
            json!({"section_ids":[b,a]}),
            StatusCode::NO_CONTENT,
            StatusCode::NO_CONTENT,
        ),
        (
            "PUT",
            &move_one,
            json!({"section_id":a}),
            StatusCode::NO_CONTENT,
            StatusCode::NO_CONTENT,
        ),
        (
            "PUT",
            &move_two,
            json!({"section_id":a}),
            StatusCode::NO_CONTENT,
            StatusCode::NO_CONTENT,
        ),
        (
            "PUT",
            "/me/section-channel-order",
            json!({"section_id":a,"channel_ids":[other_channel,f.channel]}),
            StatusCode::NO_CONTENT,
            StatusCode::NO_CONTENT,
        ),
        (
            "DELETE",
            &section,
            Value::Null,
            StatusCode::NO_CONTENT,
            StatusCode::NO_CONTENT,
        ),
    ]
    .into_iter()
    .enumerate()
    {
        let generation = index as i64 + 1;
        let response = section_request(&f, method, path, &f.token, input.clone()).await;
        assert_eq!(response.status(), changed);
        if changed == StatusCode::CREATED {
            assert_eq!(body(response).await["generation"], generation.to_string());
        }
        let committed = layout(&f).await;
        assert_eq!(committed["generation"], generation.to_string());
        expect_once(&f, &mut caller, generation).await;
        expect_once(&f, &mut idle, generation).await;

        assert_eq!(
            section_request(&f, method, path, &f.token, input)
                .await
                .status(),
            repeated
        );
        assert_eq!(layout(&f).await, committed);
        assert!(notices(&f, &mut caller).await.is_empty());
        assert!(notices(&f, &mut idle).await.is_empty());
    }
    let committed = layout(&f).await;
    let refusal = section_request(&f, "PATCH", &section, &f.token, json!({"name":"Missing"})).await;
    assert_eq!(refusal.status(), StatusCode::NOT_FOUND);
    assert_eq!(body(refusal).await, json!({"error":"section_not_found"}));
    assert_eq!(layout(&f).await, committed);
    assert!(notices(&f, &mut caller).await.is_empty());
    assert!(notices(&f, &mut idle).await.is_empty());
}

#[fukulow_test::test]
async fn section_notices_are_private_even_for_guest_with_no_channels(pool: PgPool) {
    let f = fixture(&pool).await;
    role(&pool, &f, f.member, "guest").await;
    assert_eq!(
        layout(&f).await,
        json!({"generation":"0","sections":[],"other_channel_ids":[]})
    );
    let mut denied = Vec::new();
    for other_role in ["member", "owner", "admin"] {
        let (id, token) = member(&pool, f.organization).await;
        role(&pool, &f, id, other_role).await;
        denied.push(connect(&f, &token).await);
    }
    let foreign = organization(&pool).await;
    // Reuse both Account and Member id so only the Organization can distinguish these sockets.
    sqlx::query("INSERT INTO users (organization_id,id,account_id,name,role) SELECT $1,id,account_id,'Other','member' FROM users WHERE organization_id=$2 AND id=$3")
        .bind(foreign).bind(f.organization).bind(f.member).execute(&pool).await.unwrap();
    let mut foreign_request = format!("ws://{}/api/v1/orgs/{foreign}/ws", f.server.address)
        .into_client_request()
        .unwrap();
    foreign_request.headers_mut().insert(
        header::AUTHORIZATION,
        format!("Bearer {}", f.token).parse().unwrap(),
    );
    let mut foreign_socket = tokio_tungstenite::connect_async(foreign_request)
        .await
        .unwrap()
        .0;
    assert_eq!(
        raw_event(&mut foreign_socket).await,
        json!({"type":"activity_ready"})
    );
    denied.push(foreign_socket);

    // Queue the notice while the socket is registered but has yet to write Ready.
    let delivery = &f.state.message_delivery.channel_access.activity;
    let ready = gate(&f, "ready", Some(f.member));
    let mut guest = f.server.connect(&f.token).await;
    ready.entered().await;
    assert_eq!(
        create(&f, Uuid::new_v4(), "Guest section").await.status(),
        StatusCode::CREATED
    );
    delivery.drained().await;
    ready.release.add_permits(1);
    assert_eq!(
        raw_event(&mut guest).await,
        json!({"type":"activity_ready"})
    );
    expect_once(&f, &mut guest, 1).await;
    for socket in &mut denied {
        assert!(notices(&f, socket).await.is_empty());
    }
}

#[fukulow_test::test]
async fn section_notices_deny_stale_revisions_and_ended_sessions(pool: PgPool) {
    let f = fixture(&pool).await;
    let delivery = &f.state.message_delivery.channel_access.activity;
    let auth = extract_auth(f.state.clone(), &f.token).await;
    let mut old = auth.clone();
    old.membership_revision -= 1;
    let allowed = delivery.register(&auth);
    let stale = delivery.register(&old);
    let ended_token = session::another_session(&pool, f.organization, f.member).await;
    let ended_auth = extract_auth(f.state.clone(), &ended_token).await;
    let ended = delivery.register(&ended_auth);
    sqlx::query("DELETE FROM account_sessions WHERE token_hash=$1")
        .bind(ended_auth.session_hash())
        .execute(&pool)
        .await
        .unwrap();

    assert_eq!(
        create(&f, Uuid::new_v4(), "Own section").await.status(),
        StatusCode::CREATED
    );
    assert_eq!(
        next(&allowed).await.event,
        Notice::SectionsChanged { generation: 1 }
    );
    delivery.drained().await;
    tokio::join!(quiet(&stale), quiet(&ended));
}

#[fukulow_test::test]
async fn section_notices_deny_inactive_members_even_with_matching_revision(pool: PgPool) {
    let f = fixture(&pool).await;
    let delivery = &f.state.message_delivery.channel_access.activity;
    let mut auth = extract_auth(f.state.clone(), &f.token).await;
    auth.membership_revision += 1;
    let inactive = delivery.register(&auth);
    let snapshot = gate(&f, "snapshot", Some(f.member));
    let id = Uuid::new_v4();
    let write = create(&f, id, "Before deactivation");
    let transition = async {
        snapshot.entered().await;
        let revision: i64 = sqlx::query_scalar("UPDATE users SET deactivated_at=clock_timestamp() WHERE organization_id=$1 AND id=$2 RETURNING membership_revision")
            .bind(f.organization).bind(f.member).fetch_one(&pool).await.unwrap();
        assert_eq!(auth.membership_revision, revision);
        snapshot.release.add_permits(1);
    };
    let (response, ()) = tokio::join!(write, transition);
    assert_eq!(response.status(), StatusCode::CREATED);
    delivery.drained().await;
    quiet(&inactive).await;
    drop(inactive);

    crate::auth::set_member_active_for_test(&pool, f.organization, f.member, true).await;
    let mut current = connect(&f, &f.token).await;
    assert_eq!(layout(&f).await["generation"], "1");
    assert_eq!(
        create(&f, Uuid::new_v4(), "After reactivation")
            .await
            .status(),
        StatusCode::CREATED
    );
    expect_once(&f, &mut current, 2).await;
}

#[fukulow_test::test]
async fn section_notices_fence_observed_loss_at_enqueue_and_first_handoff(pool: PgPool) {
    for phase in ["snapshot", "authorized", "handoff"] {
        let f = fixture(&pool).await;
        let delivery = &f.state.message_delivery.channel_access.activity;
        let old = delivery.register(&extract_auth(f.state.clone(), &f.token).await);
        let assert_loss = async {
            crate::auth::set_member_active_for_test(&pool, f.organization, f.member, false).await;
            delivery
                .check(
                    &f.state.pool,
                    crate::auth::SubscriptionScope::Member(f.organization, f.member),
                )
                .await;
            crate::auth::set_member_active_for_test(&pool, f.organization, f.member, true).await;
        };
        let id = Uuid::new_v4();
        let mut fresh = if phase == "handoff" {
            assert_eq!(
                create(&f, id, "Before loss").await.status(),
                StatusCode::CREATED
            );
            let frame = next(&old).await;
            assert_loss.await;
            let fresh = connect(&f, &f.token).await;
            assert_eq!(
                frame
                    .handoff(&f.state.pool, |notice| async { notice })
                    .await,
                None
            );
            fresh
        } else {
            let paused = gate(&f, phase, None);
            let transition = async {
                paused.entered().await;
                assert_loss.await;
                let fresh = connect(&f, &f.token).await;
                paused.release.add_permits(1);
                fresh
            };
            let (response, fresh) = tokio::join!(create(&f, id, "Before loss"), transition);
            assert_eq!(response.status(), StatusCode::CREATED);
            fresh
        };
        delivery.drained().await;
        quiet(&old).await;
        assert!(notices(&f, &mut fresh).await.is_empty());
        assert_eq!(
            create(&f, Uuid::new_v4(), "After loss").await.status(),
            StatusCode::CREATED
        );
        expect_once(&f, &mut fresh, 2).await;
        quiet(&old).await;
    }
}

#[fukulow_test::test]
async fn section_generation_and_notice_stay_unchanged_on_channel_access_gain(pool: PgPool) {
    let f = fixture(&pool).await;
    role(&pool, &f, f.member, "guest").await;
    let (admin, admin_token) = member(&pool, f.organization).await;
    role(&pool, &f, admin, "admin").await;
    let mut guest = connect(&f, &f.token).await;
    assert_eq!(
        create(&f, Uuid::new_v4(), "Personal").await.status(),
        StatusCode::CREATED
    );
    expect_once(&f, &mut guest, 1).await;
    assert_eq!(layout(&f).await["other_channel_ids"], json!([]));

    let granted = request(
        &f.app,
        "POST",
        &format!(
            "/api/v1/orgs/{}/channels/{}/members",
            f.organization, f.channel
        ),
        &admin_token,
        json!({"member_id":f.member}),
    )
    .await;
    assert_eq!(granted.status(), StatusCode::NO_CONTENT);
    assert!(
        notices(&f, &mut guest)
            .await
            .contains(&json!({"type":"channel_access_gained","channel_id":f.channel}))
    );
    let fresh = layout(&f).await;
    assert_eq!(fresh["generation"], "1");
    assert_eq!(fresh["other_channel_ids"], json!([f.channel]));
}

#[fukulow_test::test]
async fn section_write_survives_request_cancellation_and_rollback_is_silent(pool: PgPool) {
    let f = Arc::new(fixture(&pool).await);
    let second = session::another_session(&pool, f.organization, f.member).await;
    let mut caller = connect(&f, &f.token).await;
    let mut idle = connect(&f, &second).await;
    let mut blocker = pool.begin().await.unwrap();
    crate::auth::members::lock_organization(&mut blocker, f.organization)
        .await
        .unwrap();
    let blocker_pid: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
        .fetch_one(&mut *blocker)
        .await
        .unwrap();
    let id = Uuid::new_v4();
    let request = tokio::spawn({
        let f = f.clone();
        async move { create(&f, id, "Survives cancellation").await }
    });
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let waiting: bool = sqlx::query_scalar(
                "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname=current_database()
                 AND wait_event_type='Lock' AND $1 = ANY(pg_blocking_pids(pid)))",
            )
            .bind(blocker_pid)
            .fetch_one(&pool)
            .await
            .unwrap();
            if waiting {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("section write must wait for the Organization lock");
    assert_eq!(layout(&f).await["generation"], "0");
    request.abort();
    assert!(request.await.unwrap_err().is_cancelled());
    blocker.commit().await.unwrap();
    expect_once(&f, &mut caller, 1).await;
    expect_once(&f, &mut idle, 1).await;
    let committed = layout(&f).await;
    assert_eq!(committed["generation"], "1");
    assert_eq!(committed["sections"][0]["id"], id.to_string());

    sqlx::raw_sql(
        "CREATE FUNCTION reject_section_commit() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'injected rollback' USING ERRCODE='23514'; END $$;
        CREATE CONSTRAINT TRIGGER reject_section_commit AFTER INSERT ON member_sections
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION reject_section_commit();",
    )
    .execute(&pool)
    .await
    .unwrap();
    assert_eq!(
        create(&f, Uuid::new_v4(), "Rolled back").await.status(),
        StatusCode::INTERNAL_SERVER_ERROR
    );
    assert_eq!(layout(&f).await, committed);
    assert!(notices(&f, &mut caller).await.is_empty());
    assert!(notices(&f, &mut idle).await.is_empty());
}

#[fukulow_test::test]
async fn section_publication_failures_never_reset_unproven_recipients(pool: PgPool) {
    for failure in [
        PublicationFailure::Capacity,
        PublicationFailure::Database,
        PublicationFailure::Timeout,
    ] {
        assert_failed_section_publication(&pool, failure).await;
    }
}

#[fukulow_test::test]
async fn section_publication_panic_keeps_committed_success(pool: PgPool) {
    assert_failed_section_publication(&pool, PublicationFailure::Panic).await;
}

#[fukulow_test::test]
async fn section_publication_cancellation_keeps_committed_success(pool: PgPool) {
    assert_failed_section_publication(&pool, PublicationFailure::Cancellation).await;
}

#[derive(Debug)]
enum PublicationFailure {
    Capacity,
    Database,
    Timeout,
    Panic,
    Cancellation,
}

async fn assert_failed_section_publication(pool: &PgPool, failure: PublicationFailure) {
    let f = fixture(pool).await;
    let delivery = &f.state.message_delivery.channel_access.activity;
    let (_, outsider) = member(pool, f.organization).await;
    let mut caller = connect(&f, &f.token).await;
    let mut other = connect(&f, &outsider).await;

    let (permits, query) = match failure {
        PublicationFailure::Capacity => (Some(delivery.saturate().await), None),
        PublicationFailure::Database => {
            fail(f.organization, Uuid::nil(), TestFault::Database);
            (None, None)
        }
        PublicationFailure::Panic => {
            fail(f.organization, Uuid::nil(), TestFault::Panic);
            (None, None)
        }
        PublicationFailure::Timeout | PublicationFailure::Cancellation => {
            (None, Some(gate(&f, "query", None)))
        }
    };
    let id = Uuid::new_v4();
    let name = "Committed section";
    let start = tokio::time::Instant::now();
    let prompt = start + Duration::from_secs(5);
    let response = tokio::time::timeout_at(prompt, async {
        let query_paused = async {
            if let Some(query) = &query {
                query.entered().await;
            }
        };
        tokio::join!(create(&f, id, name), query_paused).0
    })
    .await
    .unwrap_or_else(|_| panic!("HTTP write did not return promptly: {failure:?}"));
    assert_eq!(response.status(), StatusCode::CREATED, "{failure:?}");
    assert_eq!(body(response).await, json!({"id":id,"generation":"1"}));
    if matches!(failure, PublicationFailure::Cancellation) {
        delivery.cancel(f.organization, Uuid::nil());
    }
    drop(permits);

    // Leave the query gate closed so only timeout or cancellation can release its slot.
    let drain_deadline = if matches!(failure, PublicationFailure::Timeout) {
        start + Duration::from_secs(15)
    } else {
        prompt
    };
    tokio::time::timeout_at(drain_deadline, delivery.drained())
        .await
        .unwrap_or_else(|_| panic!("publication capacity did not drain: {failure:?}"));
    let committed = layout(&f).await;
    assert_eq!(committed["generation"], "1", "{failure:?}");
    assert_eq!(
        committed["sections"],
        json!([{"id":id,"name":name,"channel_ids":[]}])
    );
    assert!(notices(&f, &mut caller).await.is_empty(), "{failure:?}");
    assert!(notices(&f, &mut other).await.is_empty(), "{failure:?}");

    assert_eq!(
        create(&f, Uuid::new_v4(), "Query recovered").await.status(),
        StatusCode::CREATED
    );
    expect_once(&f, &mut caller, 2).await;
    assert!(notices(&f, &mut other).await.is_empty(), "{failure:?}");
}

#[fukulow_test::test]
async fn lost_section_commit_reply_leaves_recovery_to_an_authorized_read(pool: PgPool) {
    let f = fixture(&pool).await;
    let mut caller = connect(&f, &f.token).await;
    let (_, outsider) = member(&pool, f.organization).await;
    let mut other = connect(&f, &outsider).await;
    let options = f.state.pool.connect_options();
    let upstream = (options.get_host().to_owned(), options.get_port());
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let relay = tokio::spawn(async move {
        let (mut client, _) = listener.accept().await.unwrap();
        let mut server = TcpStream::connect((upstream.0.as_str(), upstream.1))
            .await
            .unwrap();
        let (mut client_read, mut client_write) = client.split();
        let (mut server_read, mut server_write) = server.split();
        let requests = tokio::io::copy(&mut client_read, &mut server_write);
        let responses = async {
            loop {
                let tag = server_read.read_u8().await.unwrap();
                let size = server_read.read_u32().await.unwrap();
                let mut body = vec![0; (size - 4) as usize];
                server_read.read_exact(&mut body).await.unwrap();
                // The database committed. Drop the reply before the writer can confirm it.
                if tag == b'C' && body == b"COMMIT\0" {
                    return;
                }
                client_write.write_u8(tag).await.unwrap();
                client_write.write_u32(size).await.unwrap();
                client_write.write_all(&body).await.unwrap();
            }
        };
        tokio::select! {
            _ = requests => panic!("connection closed before COMMIT"),
            () = responses => {},
        }
    });
    let proxy_pool = PgPoolOptions::new()
        .max_connections(1)
        .acquire_timeout(Duration::from_secs(5))
        .connect_with(
            options
                .as_ref()
                .clone()
                .host("127.0.0.1")
                .port(port)
                .ssl_mode(PgSslMode::Disable),
        )
        .await
        .unwrap();
    let mut state = f.state.clone();
    state.pool = proxy_pool.clone();
    let app = crate::app(state);
    let id = Uuid::new_v4();
    let response = request(
        &app,
        "POST",
        &format!("/api/v1/orgs/{}{SECTIONS}", f.organization),
        &f.token,
        json!({"id":id,"name":"Committed"}),
    )
    .await;
    assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
    relay.await.unwrap();
    proxy_pool.close().await;
    assert!(notices(&f, &mut caller).await.is_empty());
    assert!(notices(&f, &mut other).await.is_empty());
    let committed = layout(&f).await;
    assert_eq!(committed["generation"], "1");
    assert_eq!(committed["sections"][0]["id"], id.to_string());
    assert_eq!(create(&f, id, "Committed").await.status(), StatusCode::OK);
    assert!(notices(&f, &mut caller).await.is_empty());
    assert!(notices(&f, &mut other).await.is_empty());
}
