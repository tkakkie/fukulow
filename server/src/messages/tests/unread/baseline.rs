use super::*;
use std::{
    collections::HashMap,
    sync::{Arc, LazyLock, Mutex},
    time::Duration,
};
use tokio::sync::Semaphore;

struct ListGate {
    entered: Semaphore,
    release: Semaphore,
}

static LIST_GATES: LazyLock<Mutex<HashMap<Uuid, Arc<ListGate>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

pub(crate) async fn pause_list(member: Uuid) {
    let gate = LIST_GATES.lock().unwrap().remove(&member);
    if let Some(gate) = gate {
        gate.entered.add_permits(1);
        gate.release.acquire().await.unwrap().forget();
    }
}

#[fukulow_test::test]
async fn unread_list_baseline_and_counts_share_snapshot_across_message_commit(pool: PgPool) {
    let (_, org, _, channel, owner) = fixture(&pool).await;
    let viewer_id = Uuid::new_v4();
    let viewer = member(&pool, org, viewer_id).await;
    let state = AppState::for_test(pool.clone()).await;
    let delivery = state.message_delivery.clone();
    let mut queue = delivery.queue(org, (viewer_id, 0), 256);
    queue.subscribe(channel);
    let app = crate::app(state);
    let before_main = post(&app, &owner, channel, None).await;
    let before_topic = post(&app, &owner, channel, Some("Hidden")).await;
    let gate = Arc::new(ListGate {
        entered: Semaphore::new(0),
        release: Semaphore::new(0),
    });
    LIST_GATES.lock().unwrap().insert(viewer_id, gate.clone());
    let response = channels(&app, &viewer);
    tokio::pin!(response);
    tokio::select! {
        _ = &mut response => panic!("list did not pause after its snapshot started"),
        permit = tokio::time::timeout(Duration::from_secs(5), gate.entered.acquire()) => permit.unwrap().unwrap().forget(),
    }
    // These commits complete while the actual REST handler is paused between
    // visibility and counts. Neither counts nor positions may see them.
    let (after_main, after_topic) = tokio::time::timeout(Duration::from_secs(5), async {
        let main = post(&app, &owner, channel, None).await;
        let topic = post(&app, &owner, channel, Some("Hidden")).await;
        mark(&app, &viewer, channel, None, 4).await;
        (main, topic)
    })
    .await
    .unwrap();
    // Live delivery can precede the REST response on either side of its
    // baseline. The client fixture must merge exactly this overlap in #143.
    delivery.flush().await;
    let events = (0..4)
        .map(|_| queue.events.try_recv().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(
        events.iter().map(|m| m.seq).collect::<Vec<_>>(),
        [1, 2, 3, 4]
    );
    assert!(queue.events.try_recv().is_err());
    gate.release.add_permits(1);
    let list = response.await;
    let c = &list["channels"][0];
    assert_eq!(c["as_of_seq"], 2);
    assert_eq!(c["read_seq"], 0);
    assert_eq!(c["main_unread_count"], 1);
    assert_eq!(c["unread_count"], 2);
    let baseline = c["as_of_seq"].as_i64().unwrap();
    for message in [before_main, before_topic] {
        assert!(message["seq"].as_i64().unwrap() <= baseline);
    }
    for message in [after_main, after_topic] {
        assert!(message["seq"].as_i64().unwrap() > baseline);
    }
    assert_eq!(events.iter().filter(|m| m.seq <= baseline).count(), 2);
    assert_eq!(events.iter().filter(|m| m.seq > baseline).count(), 2);
    let fresh = channels(&app, &viewer).await;
    let c = &fresh["channels"][0];
    assert_eq!(c["as_of_seq"], 4);
    assert_eq!(c["read_seq"], 4);
    assert_eq!(c["main_unread_count"], 0);
    assert_eq!(c["unread_count"], 2);
}

#[fukulow_test::test]
async fn unread_list_baseline_is_max_seq_for_empty_own_and_read_messages(pool: PgPool) {
    let (app, org, _, channel, owner) = fixture(&pool).await;
    let viewer = member(&pool, org, Uuid::new_v4()).await;
    let empty = channels(&app, &viewer).await;
    assert_eq!(empty["channels"][0]["as_of_seq"], 0);
    assert_eq!(empty["channels"][0]["unread_count"], 0);
    post(&app, &viewer, channel, None).await;
    post(&app, &viewer, channel, Some("Own")).await;
    let own = channels(&app, &viewer).await;
    assert_eq!(own["channels"][0]["as_of_seq"], 2);
    assert_eq!(own["channels"][0]["read_seq"], 0);
    assert_eq!(own["channels"][0]["main_unread_count"], 0);
    assert_eq!(own["channels"][0]["unread_count"], 0);
    post(&app, &owner, channel, None).await;
    mark(&app, &viewer, channel, None, 3).await;
    let last = post(&app, &viewer, channel, Some("Own")).await;
    let read = channels(&app, &viewer).await;
    let c = &read["channels"][0];
    assert_eq!(c["as_of_seq"], last["seq"]);
    assert_eq!(c["as_of_seq"], 4);
    assert_eq!(c["read_seq"], 3);
    assert_eq!(c["unread_count"], 0);
    // A second Channel has an independent baseline, not a list-wide maximum.
    sqlx::query(
        "INSERT INTO channels (organization_id,id,name,visibility) VALUES ($1,$2,'Empty','public')",
    )
    .bind(org)
    .bind(Uuid::new_v4())
    .execute(&pool)
    .await
    .unwrap();
    let list = channels(&app, &viewer).await;
    assert_eq!(list["channels"].as_array().unwrap().len(), 2);
    let other = list["channels"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["id"] != json!(channel))
        .unwrap();
    assert_eq!(other["as_of_seq"], 0);
}

#[fukulow_test::test]
async fn unread_reconnect_baselines_distinguish_new_messages_from_new_positions(pool: PgPool) {
    let (app, org, _, channel, owner) = fixture(&pool).await;
    let viewer_id = Uuid::new_v4();
    let viewer = member(&pool, org, viewer_id).await;
    post(&app, &owner, channel, None).await;
    let gate = Arc::new(ListGate {
        entered: Semaphore::new(0),
        release: Semaphore::new(0),
    });
    LIST_GATES.lock().unwrap().insert(viewer_id, gate.clone());
    let old = channels(&app, &viewer);
    tokio::pin!(old);
    tokio::select! {
        _ = &mut old => panic!("old list did not pause after its snapshot started"),
        permit = tokio::time::timeout(Duration::from_secs(5), gate.entered.acquire()) => permit.unwrap().unwrap().forget(),
    }
    let message = post(&app, &owner, channel, None).await;
    let fresh_app = router(&pool).await;
    let newer = channels(&fresh_app, &viewer).await;
    mark(&app, &viewer, channel, None, 2).await;
    let read = channels(&fresh_app, &viewer).await;
    // Reconnect refetches have completed before the older request returns.
    gate.release.add_permits(1);
    let old = old.await;
    let old = &old["channels"][0];
    let newer = &newer["channels"][0];
    let read = &read["channels"][0];
    assert_eq!(
        (old["as_of_seq"].as_i64(), old["read_seq"].as_i64()),
        (Some(1), Some(0))
    );
    assert_eq!(newer["as_of_seq"], message["seq"]);
    assert_eq!(newer["as_of_seq"], 2);
    assert_eq!(newer["unread_count"], 2);
    assert_eq!(read["as_of_seq"], newer["as_of_seq"]);
    assert_eq!(read["read_seq"], 2);
    assert_eq!(read["unread_count"], 0);
    // These real responses supply the two ordering keys for #143's proposed
    // client fixture: larger as_of_seq, then larger read_seq for equal baselines.
}
