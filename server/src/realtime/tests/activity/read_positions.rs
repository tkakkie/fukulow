use super::*;

#[fukulow_test::test]
async fn topic_mark_read_notifies_with_topic_id_and_channel_mark_read_with_null(pool: PgPool) {
    let f = fixture(&pool).await;
    let (_, sender) = member(&pool, f.organization).await;
    send(&f, &sender, f.channel, Uuid::new_v4(), "Unread").await;
    let response = request(&f.app, "POST", &format!("/api/v1/channels/{}/messages", f.channel), &sender,
        json!({"client_message_id":Uuid::new_v4(),"body":"Topic unread","topic_name":"Activity topic"})).await;
    assert_eq!(response.status(), StatusCode::CREATED);
    let message: Value =
        serde_json::from_slice(&to_bytes(response.into_body(), 32768).await.unwrap()).unwrap();
    let topic = message["topic_id"].as_str().unwrap();
    let second = session::another_session(&pool, f.organization, f.member).await;
    let mut same = connect(&f, &second).await;
    let mut other = connect(&f, &sender).await;
    let response = request(
        &f.app,
        "PUT",
        &format!("/api/v1/channels/{}/topics/{topic}/read", f.channel),
        &f.token,
        json!({"read_seq":2}),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        notices(&f, &mut same).await,
        vec![
            json!({"type":"read_position_changed","channel_id":f.channel,"topic_id":topic,"read_seq":2})
        ]
    );
    assert!(notices(&f, &mut other).await.is_empty());
    let response = request(
        &f.app,
        "PUT",
        &format!("/api/v1/channels/{}/read", f.channel),
        &f.token,
        json!({"read_seq":1}),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        notices(&f, &mut same).await,
        vec![
            json!({"type":"read_position_changed","channel_id":f.channel,"topic_id":null,"read_seq":1})
        ]
    );
    assert!(notices(&f, &mut other).await.is_empty());
    let response = request(
        &f.app,
        "PUT",
        &format!("/api/v1/channels/{}/read", f.channel),
        &f.token,
        json!({"read_seq":1}),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    assert!(notices(&f, &mut same).await.is_empty());
}

#[fukulow_test::test]
async fn mark_read_on_one_session_notifies_every_session_of_that_member_only(pool: PgPool) {
    let f = fixture(&pool).await;
    let (_, sender) = member(&pool, f.organization).await;
    send(&f, &sender, f.channel, Uuid::new_v4(), "Unread").await;
    let second = session::another_session(&pool, f.organization, f.member).await;
    let mut sockets = vec![
        connect(&f, &f.token).await,
        connect(&f, &f.token).await,
        connect(&f, &second).await,
    ];
    let mut denied = connect(&f, &sender).await;
    let response = request(
        &f.app,
        "PUT",
        &format!("/api/v1/channels/{}/read", f.channel),
        &f.token,
        json!({"read_seq":1}),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    for socket in &mut sockets {
        assert_eq!(
            notices(&f, socket).await,
            vec![
                json!({"type":"read_position_changed","channel_id":f.channel,"topic_id":null,"read_seq":1})
            ]
        );
    }
    assert!(notices(&f, &mut denied).await.is_empty());
}
