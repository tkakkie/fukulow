use super::*;
use crate::channels::{
    activity::{Activity, Notice, Registration},
    tests::{archive::patch, extract_auth},
};
use std::{sync::Arc, time::Duration};

pub(super) async fn set_archived(f: &Fixture, token: &str, channel: Uuid, archived: bool) {
    patch(
        &f.app,
        token,
        &format!("/api/v1/channels/{channel}"),
        json!({"archived": archived}),
    )
    .await;
}

fn capture_activity(f: &Fixture) -> Activity {
    let activity = Activity::default();
    f.state
        .session_changes
        .set_activity(Arc::new(activity.clone()));
    activity
}

async fn no_notice(activity: &Activity, registration: &Registration) {
    activity.drained().await;
    assert!(
        tokio::time::timeout(Duration::from_millis(20), registration.next())
            .await
            .is_err()
    );
}

pub(super) async fn placements(f: &Fixture) -> Vec<(Uuid, Option<Uuid>, i64)> {
    sqlx::query_as(
        "SELECT channel_id, section_id, position FROM member_section_placements
         WHERE organization_id=$1 AND member_id=$2 ORDER BY channel_id",
    )
    .bind(f.owner.org)
    .bind(f.owner.member)
    .fetch_all(&f.pools.admin)
    .await
    .unwrap()
}

#[fukulow_test::test]
async fn archive_hides_slots_until_restore_or_section_delete(pool: PgPool) {
    let f = Fixture::new(pool).await;
    let group = Uuid::new_v4();
    let section = section_path(group);
    f.create(group, "Saved").await;
    let first = f.channel("First", "public").await;
    let saved = f.channel("Saved", "public").await;
    let last = f.channel("Last", "public").await;
    for channel in [first, saved, last] {
        f.changed("PUT", &placement_path(channel), json!({"section_id":group}))
            .await;
    }
    let before = f.get(SECTIONS).await;
    let saved_section = f.get(&section).await;
    assert_eq!(
        saved_section["section"]["channel_ids"],
        json!([first, saved, last])
    );
    let stored = placements(&f).await;

    let activity = capture_activity(&f);
    let registration = activity.register(&extract_auth(f.state.clone(), &f.token).await);
    for archived in [true, false] {
        set_archived(&f, &f.token, saved, archived).await;
        activity.drained().await;
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(1), registration.next())
                .await
                .unwrap()
                .unwrap()
                .event,
            Notice::ChannelListChanged
        );
        no_notice(&activity, &registration).await;
        let mut layout = before.clone();
        let mut snapshot = saved_section.clone();
        if archived {
            layout["sections"][0]["channel_ids"] = json!([first, last]);
            snapshot["section"]["channel_ids"] = json!([first, last]);
        }
        assert_eq!(f.get(SECTIONS).await, layout);
        assert_eq!(f.get(&section).await, snapshot);
        assert_eq!(placements(&f).await, stored);
    }

    set_archived(&f, &f.token, saved, true).await;
    f.changed("DELETE", &section, Value::Null).await;
    assert!(placements(&f).await.is_empty());
    assert_eq!(
        f.get(SECTIONS).await,
        json!({"generation":"5","sections":[],"other_channel_ids":[first,last]})
    );
    set_archived(&f, &f.token, saved, false).await;
    assert_eq!(
        f.get(SECTIONS).await,
        json!({"generation":"5","sections":[],"other_channel_ids":[first,last,saved]})
    );
    assert_eq!(
        f.get(&placement_path(saved)).await,
        json!({"generation":"5","section_id":null})
    );
    assert!(placements(&f).await.is_empty());
}

#[fukulow_test::test]
async fn archived_placement_refusals_preserve_state_and_access_precedence(pool: PgPool) {
    let f = Fixture::new(pool).await;
    let group = Uuid::new_v4();
    f.create(group, "Destination").await;
    let active = f.channel("Active", "public").await;
    let public = f.channel("Archived public", "public").await;
    let private = f.channel("Archived private", "private").await;
    let outsider = member(&f.pools.admin, f.owner.org, Uuid::new_v4(), "owner").await;
    let foreign_org = organization(&f.pools.admin).await;
    let foreign_owner = member(&f.pools.admin, foreign_org, Uuid::new_v4(), "owner").await;
    let foreign = f.channel_as(&foreign_owner, "Foreign", "public").await;
    f.changed("PUT", &placement_path(public), json!({"section_id":group}))
        .await;
    for (token, channel) in [
        (&f.token, public),
        (&f.token, private),
        (&foreign_owner, foreign),
    ] {
        set_archived(&f, token, channel, true).await;
    }
    let activity = capture_activity(&f);
    let owner_registration = activity.register(&extract_auth(f.state.clone(), &f.token).await);
    let outsider_registration = activity.register(&extract_auth(f.state.clone(), &outsider).await);
    let layout = f.get(SECTIONS).await;
    let outsider_layout = access::layout_as(&f, &outsider).await;
    let stored = placements(&f).await;
    let missing = Uuid::new_v4();
    for (token, channel, status, error) in [
        (&f.token, public, StatusCode::CONFLICT, "channel_archived"),
        (
            &outsider,
            private,
            StatusCode::NOT_FOUND,
            "channel not found",
        ),
        (
            &f.token,
            foreign,
            StatusCode::NOT_FOUND,
            "channel not found",
        ),
    ] {
        for (method, input) in [
            ("GET", Value::Null),
            ("PUT", json!({"section_id":null})),
            ("PUT", json!({"section_id":missing})),
        ] {
            denied(
                access::as_member(&f, token, method, &placement_path(channel), input).await,
                status,
                error,
            )
            .await;
        }
    }
    assert_eq!(f.get(SECTIONS).await, layout);
    assert_eq!(access::layout_as(&f, &outsider).await, outsider_layout);
    assert_eq!(placements(&f).await, stored);
    for registration in [&owner_registration, &outsider_registration] {
        no_notice(&activity, registration).await;
    }

    let active = placement_path(active);
    assert_eq!(
        f.get(&active).await,
        json!({"generation":"2","section_id":null})
    );
    f.changed("PUT", &active, json!({"section_id":group})).await;
    assert_eq!(
        f.get(&active).await,
        json!({"generation":"3","section_id":group})
    );
}

#[fukulow_test::test]
async fn channel_reorder_preserves_archived_slots_and_filters_tail(pool: PgPool) {
    let f = Fixture::new(pool).await;
    let a = f.channel("A", "public").await;
    let b = f.channel("B", "public").await;
    let c = f.channel("C", "public").await;
    f.changed("PUT", CHANNEL_ORDER, channel_order(None, &[c, b, a]))
        .await;
    let tail = f.channel("Tail", "public").await;
    for channel in [b, tail] {
        set_archived(&f, &f.token, channel, true).await;
    }
    assert_eq!(f.get(SECTIONS).await["other_channel_ids"], json!([c, a]));
    f.changed("PUT", CHANNEL_ORDER, channel_order(None, &[a, c]))
        .await;
    let stored = placements(&f).await;
    assert!(stored.contains(&(b, None, 1)));
    assert_eq!(stored.len(), 3);
    let layout = f.get(SECTIONS).await;
    assert_eq!(
        layout,
        json!({"generation":"2","sections":[],"other_channel_ids":[a,c]})
    );

    let private_owner = member(&f.pools.admin, f.owner.org, Uuid::new_v4(), "owner").await;
    let private = f.channel_as(&private_owner, "Private", "private").await;
    set_archived(&f, &private_owner, private, true).await;
    let activity = capture_activity(&f);
    let registration = activity.register(&extract_auth(f.state.clone(), &f.token).await);
    for (group, ids, status, error) in [
        (None, vec![b], StatusCode::CONFLICT, "channel_archived"),
        (None, vec![tail], StatusCode::CONFLICT, "channel_archived"),
        (
            None,
            vec![b, private],
            StatusCode::NOT_FOUND,
            "channel not found",
        ),
        (
            Some(Uuid::new_v4()),
            vec![b],
            StatusCode::NOT_FOUND,
            "section_not_found",
        ),
    ] {
        denied(
            f.send("PUT", CHANNEL_ORDER, channel_order(group, &ids))
                .await,
            status,
            error,
        )
        .await;
    }
    assert_eq!(f.get(SECTIONS).await, layout);
    assert_eq!(placements(&f).await, stored);
    no_notice(&activity, &registration).await;
    for channel in [b, tail] {
        set_archived(&f, &f.token, channel, false).await;
    }
    assert_eq!(
        f.get(SECTIONS).await,
        json!({"generation":"2","sections":[],"other_channel_ids":[a,b,c,tail]})
    );
    assert_eq!(placements(&f).await, stored);
}

#[fukulow_test::test]
async fn section_restore_keeps_unread_baseline(pool: PgPool) {
    let f = Fixture::new(pool).await;
    let group = Uuid::new_v4();
    f.create(group, "Unread").await;
    let channel = f.channel("Unread", "public").await;
    f.changed("PUT", &placement_path(channel), json!({"section_id":group}))
        .await;
    let sender = member(&f.pools.admin, f.owner.org, Uuid::new_v4(), "member").await;
    let channel_path = format!("/channels/{channel}");
    let messages = format!("{channel_path}/messages");
    let mention = format!("@{{member:{}}}", f.owner.member);
    for _ in 0..2 {
        expected(
            access::as_member(
                &f,
                &sender,
                "POST",
                &messages,
                json!({"client_message_id":Uuid::new_v4(),"body":mention}),
            )
            .await,
            StatusCode::CREATED,
        )
        .await;
    }
    assert_eq!(
        expected(
            f.send(
                "PUT",
                &format!("{channel_path}/read"),
                json!({"read_seq":1})
            )
            .await,
            StatusCode::OK,
        )
        .await["read_seq"],
        1
    );
    let baseline = f.get("/channels").await["channels"][0].clone();
    assert_eq!(baseline["id"], json!(channel));
    assert_eq!(baseline["read_seq"], 1);
    assert_eq!(baseline["unread_count"], 1);
    assert_eq!(baseline["mention_unread_count"], 1);
    let layout = f.get(SECTIONS).await;
    set_archived(&f, &f.token, channel, true).await;
    assert_eq!(
        f.get(SECTIONS).await["sections"][0]["channel_ids"],
        json!([])
    );
    let read_archived = f.get("/channels?archived=true").await["channels"][0].clone();
    assert_eq!(read_archived["archived"], true);
    for field in ["id", "read_seq", "unread_count", "mention_unread_count"] {
        assert_eq!(read_archived[field], baseline[field], "{field}");
    }
    set_archived(&f, &f.token, channel, false).await;
    assert_eq!(f.get("/channels").await["channels"][0], baseline);
    assert_eq!(f.get(SECTIONS).await, layout);
}
