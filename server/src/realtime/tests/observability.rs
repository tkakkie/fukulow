use super::*;
use tracing::instrument::WithSubscriber;

#[fukulow_test::test]
async fn connection_database_failures_emit_once_with_fixed_operation_and_no_details(pool: PgPool) {
    for (phase, operation) in [
        ("authorize", "websocket_authorize"),
        ("access_subscribe", "websocket_subscribe"),
        ("registered", "websocket_latest_seq"),
        ("refresh", "websocket_refresh"),
        ("snapshot", "websocket_replay"),
        ("subscribed_seq", "websocket_subscribed_seq"),
    ] {
        let f = fixture(&pool).await;
        if phase == "snapshot" {
            post(&f, f.channel).await;
        }
        let output = crate::observability::tests::Capture::default();
        let capture = output.clone();
        let (finished, mut completion) = tokio::sync::mpsc::channel(1);
        // Authenticate with the real pool, then exercise the production connection
        // loop without a Session worker racing this deliberately closed pool.
        let router = Router::new()
            .route(
                "/api/v1/orgs/{org}/ws",
                axum::routing::get(
                    move |State(state): State<AppState>, auth: Auth, ws: WebSocketUpgrade| {
                        let capture = capture.clone();
                        let finished = finished.clone();
                        async move {
                            ws.on_upgrade(move |mut socket| {
                                async move {
                                    let permit = state.socket_gate.admit(auth.account_id).unwrap();
                                    let queue = state.message_delivery.queue(
                                        auth.identity.organization.organization_id,
                                        (auth.identity.member.id, auth.membership_revision),
                                        LIVE_QUEUE_CAPACITY,
                                    );
                                    let mut connection = connection::Connection {
                                        state: &state,
                                        auth: &auth,
                                        queue,
                                        cursors: HashMap::new(),
                                        access: HashMap::new(),
                                        permit,
                                    };
                                    let code = connection
                                        .run(&mut socket, connection::Lifecycle::default())
                                        .await
                                        .unwrap_err();
                                    close(&mut socket, code).await;
                                    finished.send(code).await.unwrap();
                                }
                                .with_subscriber(capture.subscriber())
                            })
                        }
                    },
                ),
            )
            .with_state(f.state.clone());
        let server = Server::start(router).await;
        let gate = access_loss::gate(f.channel, phase, 0);
        let mut socket = server.connect(&f.token).await;
        subscribe(&mut socket, f.channel, 0).await;
        entered(&gate).await;
        f.state.pool.close().await;
        gate.release.add_permits(1);
        closed(&mut socket, 1011).await;
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(5), completion.recv())
                .await
                .unwrap(),
            Some(1011)
        );
        let failures: Vec<_> = output
            .events()
            .into_iter()
            .filter(|event| event["fields"]["event"] == "database_failure")
            .collect();
        assert_eq!(failures.len(), 1, "{phase}: {}", output.text());
        assert_eq!(
            failures[0]["fields"],
            json!({"event":"database_failure", "kind":"pool_closed"}),
            "{phase}"
        );
        assert_eq!(
            failures[0]["span"],
            json!({"name":"database", "operation":operation}),
            "{phase}"
        );
        for forbidden in [
            "pool closed",
            "SELECT",
            "postgres://",
            f.token.as_str(),
            &f.organization.to_string(),
            &f.channel.to_string(),
        ] {
            assert!(
                !output.text().contains(forbidden),
                "{phase}: {}",
                output.text()
            );
        }
    }
}
