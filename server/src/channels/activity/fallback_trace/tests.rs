use super::super::{Activity, Notice, Registration, enqueue, pause_member, tests::entry};
use super::*;
use crate::{
    auth::{SubscriptionScope, activity::ChangeScope},
    channels::Role,
    observability::{RevocationMetric, revocation_trace::test_worker, tests::Capture},
};
use serde_json::Value;
use sqlx::{PgPool, postgres::PgPoolOptions};

async fn closed_pool() -> PgPool {
    let pool = PgPoolOptions::new()
        .connect_lazy("postgres://unused:unused@127.0.0.1/unused")
        .unwrap();
    pool.close().await;
    pool
}

fn registrations(activity: &Activity, count: usize) -> Vec<Registration> {
    let organization = Uuid::new_v4();
    (0..count)
        .map(|_| {
            let mut entry = entry();
            Arc::get_mut(&mut entry).unwrap().organization = organization;
            activity
                .entries
                .lock()
                .unwrap()
                .insert(entry.id, entry.clone());
            Registration {
                id: entry.id,
                entry,
                registry: Arc::downgrade(&activity.entries),
            }
        })
        .collect()
}

fn queue(entry: &Arc<Entry>, count: usize) -> Vec<Uuid> {
    (0..count)
        .map(|_| {
            let channel = Uuid::new_v4();
            let capture = {
                let mut b = entry.buffer.lock().unwrap();
                let mutation = b.revocations.capture(ChangeScope::Channel(channel));
                let capture = mutation.notice(channel, false, Role::Member).unwrap();
                b.revocations
                    .apply(capture.check().unwrap(), Some(Role::Member), Some(false));
                capture
            };
            let mut pending = super::super::tests::pending(channel, None);
            pending.notice = Notice::ChannelAccessRevoked {
                channel_id: channel,
            };
            pending.channel = None;
            pending.epoch = Epoch::Revocation(capture);
            pending.proof = None;
            enqueue(entry, pending);
            channel
        })
        .collect()
}

async fn measure(future: impl Future<Output = ()>, events: bool) -> Capture {
    let output = Capture::default();
    let (mut worker, drain) = test_worker(output.clone(), events);
    let mut tick = worker.tick();
    tick.sessions_checked();
    tick.check(future).await;
    tick.subscription_checked(|| "ok");
    tick.finish();
    drop(worker);
    drain().unwrap();
    output
}

fn fields(events: &[Value], name: &str) -> Value {
    events
        .iter()
        .find(|e| e["fields"]["event"] == name)
        .unwrap()["fields"]
        .clone()
}

fn records(fields: &Value) -> Vec<Vec<&str>> {
    fields["records"]
        .as_str()
        .unwrap()
        .split(',')
        .map(|record| record.split(':').collect())
        .collect()
}

#[tokio::test]
async fn first_admission_is_frozen_for_a_registration_straddling_failed_chunks() {
    for checks in [64, 65] {
        let activity = Activity::default();
        let registrations = registrations(&activity, 8);
        let straddler = activity
            .entries
            .lock()
            .unwrap()
            .values()
            .last()
            .unwrap()
            .clone();
        let metrics = straddler.buffer.lock().unwrap().holds.isolate_metrics();
        for reg in &registrations {
            queue(&reg.entry, checks);
        }

        let pool = closed_pool().await;
        let output = measure(activity.check(&pool, SubscriptionScope::All), true).await;
        let events = output.events();
        let summary = fields(&events, "revocation_fallback_check");
        assert_eq!(summary["chunks"], 2);
        assert_eq!(summary["failed_chunks"], 2);
        assert_eq!(summary["rows"], 16 * checks);
        let snapshot = fields(&events, "revocation_fallback_snapshot");
        let outcome = fields(&events, "revocation_fallback_outcome");
        let snapshots = records(&snapshot);
        let outcomes = records(&outcome);
        assert_eq!(snapshots.len(), 8);
        assert_eq!(outcomes.len(), 8);
        assert_eq!(snapshots.last().unwrap()[0], straddler.member.0.to_string());
        for (snapshot, outcome) in snapshots.into_iter().zip(outcomes) {
            assert_eq!(snapshot[0], outcome[0]);
            assert_eq!(snapshot[1..4], [checks.to_string().as_str(); 3]);
            assert_eq!(
                outcome[1..7],
                [
                    "64",
                    if checks == 64 { "0" } else { "1" },
                    "0",
                    "0",
                    "0",
                    "0"
                ]
            );
            assert_eq!(snapshot[5], outcome[7]);
        }
        assert_eq!(metrics.load(RevocationMetric::Held), 64);
        assert_eq!(
            metrics.load(RevocationMetric::RegistrationCap),
            (checks - 64) as u64
        );
        // A second failed chunk still calls Holds::start, invalidating the held proof again.
        let live = straddler.buffer.lock().unwrap().revocations.checks();
        assert_eq!(live.len(), 64);
        assert!(live.iter().all(|check| check.revision == 2));
    }
}

#[tokio::test]
async fn first_admission_freezes_even_when_every_straddling_check_is_gone() {
    let activity = Activity::default();
    let registrations = registrations(&activity, 8);
    let id = *activity.entries.lock().unwrap().keys().last().unwrap();
    let straddler = registrations.iter().find(|reg| reg.id == id).unwrap();
    for reg in registrations.iter().filter(|reg| reg.id != id) {
        queue(&reg.entry, 64);
    }
    let channels = queue(&straddler.entry, 64);
    let entry = &straddler.entry;
    let first = pause_member(
        entry.organization,
        Uuid::nil(),
        "fallback_snapshot",
        Some(entry.member.0),
    );
    let second = pause_member(
        entry.organization,
        channels[52],
        "fallback_snapshot",
        Some(entry.member.0),
    );
    let pool = closed_pool().await;
    let (output, between_chunks) = tokio::join!(
        measure(activity.check(&pool, SubscriptionScope::All), true),
        async {
            first.entered().await;
            for _ in 0..64 {
                let frame = straddler.next().await.unwrap();
                assert!(frame.poll_handoff(None, async |_| {}).await.is_some());
            }
            first.release();
            second.entered().await;
            let between_chunks = measurement_ms();
            second.release();
            between_chunks
        }
    );
    let events = output.events();
    let snapshot = fields(&events, "revocation_fallback_snapshot");
    let outcome = fields(&events, "revocation_fallback_outcome");
    assert_eq!(records(&snapshot).last().unwrap()[1..4], ["64", "64", "64"]);
    let outcomes = records(&outcome);
    let gone = outcomes.last().unwrap();
    assert_eq!(gone[1..8], ["0", "0", "0", "0", "0", "64", "0"]);
    assert!(gone[8].parse::<f64>().unwrap() <= between_chunks);
}

#[tokio::test]
async fn timing_reaches_last_chunk_admission_and_worker_completion_in_both_modes() {
    use std::cell::Cell;
    for events_on in [false, true] {
        let activity = Activity::default();
        let registrations = registrations(&activity, 8);
        let last = *activity.entries.lock().unwrap().keys().last().unwrap();
        for reg in &registrations {
            queue(&reg.entry, 64);
        }
        let reg = registrations.iter().find(|reg| reg.id == last).unwrap();
        let channel = reg.entry.buffer.lock().unwrap().revocations.checks()[52].channel;
        let gate = pause_member(
            reg.entry.organization,
            channel,
            "fallback_snapshot",
            Some(reg.entry.member.0),
        );
        let pool = closed_pool().await;
        let check_returned_ms = Cell::new(0.0);
        let (output, final_chunk_released_ms) = tokio::join!(
            measure(
                async {
                    activity.check(&pool, SubscriptionScope::All).await;
                    check_returned_ms.set(measurement_ms());
                },
                events_on
            ),
            async {
                gate.entered().await;
                let released = measurement_ms();
                gate.release();
                released
            }
        );
        let events = output.events();
        let timing = fields(&events, "subscription_fallback_timing");
        let admitted = timing["final_admission_ms"].as_f64().unwrap();
        assert_eq!(timing["tick"], 1);
        assert!(admitted >= final_chunk_released_ms);
        assert!(admitted <= check_returned_ms.get());
        assert!(timing["completed_ms"].as_f64().unwrap() >= check_returned_ms.get());
        if events_on {
            let pass = fields(&events, "subscription_fallback_pass");
            assert_eq!(pass["tick"], timing["tick"]);
            assert_eq!(pass["started_ms"], timing["started_ms"]);
            assert!(
                pass["completed_ms"].as_f64().unwrap() <= timing["completed_ms"].as_f64().unwrap()
            );
        } else {
            assert_eq!(events.len(), 2, "only timing and watermark");
        }
    }
}

#[tokio::test]
async fn popped_frame_is_live_but_unqueued_and_closed_holds_are_not_admitted() {
    let activity = Activity::default();
    let reg = registrations(&activity, 1).pop().unwrap();
    let channels = queue(&reg.entry, 2);
    let frame = reg.next().await.unwrap();
    {
        let mut b = reg.entry.buffer.lock().unwrap();
        let Buffer {
            holds, revocations, ..
        } = &mut *b;
        holds.close(revocations);
    }
    let pool = closed_pool().await;
    let output = measure(activity.check(&pool, SubscriptionScope::All), true).await;
    let events = output.events();
    let snapshot = fields(&events, "revocation_fallback_snapshot");
    let s2 = &records(&snapshot)[0];
    assert_eq!(s2[1..4], ["2", "1", "2"]);
    assert_eq!(
        s2[4],
        format!("{:032x}", channels[0].as_u128() ^ channels[1].as_u128())
    );
    let outcome = fields(&events, "revocation_fallback_outcome");
    let s3 = &records(&outcome)[0];
    assert_eq!(s3[1..7], ["0", "0", "2", "0", "0", "0"]);
    assert_eq!(s3[7], s2[5]);
    drop(frame);
}

#[tokio::test]
async fn member_scope_produces_no_activity_trace() {
    let activity = Activity::default();
    let reg = registrations(&activity, 1).pop().unwrap();
    queue(&reg.entry, 1);
    let scope = SubscriptionScope::Member(reg.entry.organization, reg.entry.member.0);
    let pool = closed_pool().await;
    let output = measure(activity.check(&pool, scope), true).await;
    let events = output.events();
    assert_eq!(events.len(), 3, "only worker pass, timing and watermark");
    assert!(fields(&events, "subscription_fallback_timing")["final_admission_ms"].is_null());
}

#[tokio::test]
async fn global_cap_matches_trace_and_96_registration_lines_fit() {
    const CHILD: &str = "FUKULOW_TEST_TRACE_GLOBAL_CAP";
    if std::env::var_os(CHILD).is_none() {
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .arg("--exact")
            .arg(
                module_path!()
                    .strip_prefix("fukulow_server::")
                    .unwrap()
                    .to_owned()
                    + "::global_cap_matches_trace_and_96_registration_lines_fit",
            )
            .env(CHILD, "1")
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stdout)
        );
        assert!(String::from_utf8_lossy(&output.stdout).contains("1 passed"));
        return;
    }

    let activity = Activity::default();
    let registrations = registrations(&activity, 96);
    let metrics: Vec<_> = registrations
        .iter()
        .map(|reg| {
            queue(&reg.entry, 64);
            reg.entry.buffer.lock().unwrap().holds.isolate_metrics()
        })
        .collect();
    let pool = closed_pool().await;
    let output = measure(activity.check(&pool, SubscriptionScope::All), true).await;
    let events = output.events();
    let snapshot = fields(&events, "revocation_fallback_snapshot");
    let outcome = fields(&events, "revocation_fallback_outcome");
    assert_eq!(snapshot["registrations"], 96);
    let snapshots = records(&snapshot);
    let outcomes = records(&outcome);
    assert_eq!(outcomes.len(), 96);
    for (s2, s3) in snapshots.into_iter().zip(&outcomes) {
        assert_eq!(s2[0], s3[0]);
        assert_eq!(s2[1..4], ["64", "64", "64"]);
        assert_eq!(s2[5], s3[7]);
        assert_eq!(s3[3..7], ["0", "0", "0", "0"]);
    }
    let refused = outcomes
        .iter()
        .map(|record| record[2].parse::<u64>().unwrap())
        .sum::<u64>();
    assert_eq!(refused, 96 * 64 - 4096);
    assert_eq!(
        refused,
        metrics
            .iter()
            .map(|metrics| metrics.load(RevocationMetric::GlobalCap))
            .sum::<u64>()
    );
    let trace = output.text();
    for name in [
        "revocation_fallback_snapshot",
        "revocation_fallback_outcome",
    ] {
        let line = trace.lines().find(|line| line.contains(name)).unwrap();
        assert!(line.len() < 16 * 1024);
    }
}

#[fukulow_test::test]
async fn healthy_pass_reverifies_the_snapshotted_checks(pool: PgPool) {
    use crate::channels::tests::{extract_auth, member, organization};
    let org = organization(&pool).await;
    let token = member(&pool, org, Uuid::new_v4(), "member").await;
    let state = crate::AppState::for_test(pool.clone()).await;
    let auth = extract_auth(state.clone(), &token).await;
    let activity = Activity::default();
    let reg = activity.register(&auth);
    queue(&reg.entry, 2);
    {
        let b = reg.entry.buffer.lock().unwrap();
        for check in b.revocations.checks() {
            b.revocations.invalidate(check.id);
        }
    }
    let output = measure(activity.check(&state.pool, SubscriptionScope::All), true).await;
    let events = output.events();
    let snapshot = fields(&events, "revocation_fallback_snapshot");
    let outcome = fields(&events, "revocation_fallback_outcome");
    assert_eq!(records(&snapshot)[0][1..4], ["2", "2", "0"]);
    assert_eq!(records(&outcome)[0][1..7], ["0", "0", "0", "2", "0", "0"]);
    assert_eq!(records(&outcome)[0][7], records(&snapshot)[0][5]);
    assert_eq!(records(&outcome)[0][8], "-");
    assert_eq!(
        fields(&events, "revocation_fallback_check")["failed_chunks"],
        0
    );
}
