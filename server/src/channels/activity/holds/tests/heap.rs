use super::*;
use sqlx::{
    PgPool,
    postgres::{PgConnectOptions, PgPoolOptions},
};

#[global_allocator]
static ALLOCATOR: dhat::Alloc = dhat::Alloc;

const REGISTRATIONS: usize = 64;
const CHANNELS: usize = 64;
const HOLD_COUNT: usize = REGISTRATIONS * CHANNELS;
const BOUND_BYTES: usize = HOLD_COUNT * 2048;

// cargo test -p fukulow-server --lib --features hold-heap-measure measure_revocation_hold_heap -- --ignored --nocapture --test-threads=1
#[test]
#[ignore = "manual measurement with a process-global allocator"]
fn measure_revocation_hold_heap() {
    let _profiler = dhat::Profiler::builder().testing().build();
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .start_paused(true)
        .build()
        .unwrap();
    let (control_bytes, loaded_bytes) = runtime.block_on(async {
        let pool = PgPoolOptions::new()
            .idle_timeout(None)
            .max_lifetime(None)
            .connect_lazy_with(PgConnectOptions::new());
        pool.close().await;

        // Exercise both paths once to initialize process-wide state before sampling.
        retained_bytes(&pool, 0).await;
        retained_bytes(&pool, GLOBAL_CAP).await;
        let baseline = dhat::HeapStats::get().curr_bytes;

        let mut samples = [(0, 0); 3];
        for sample in &mut samples {
            let control = retained_bytes(&pool, 0).await;
            assert_eq!(dhat::HeapStats::get().curr_bytes, baseline);
            let loaded = retained_bytes(&pool, GLOBAL_CAP).await;
            assert_eq!(dhat::HeapStats::get().curr_bytes, baseline);
            *sample = (control - baseline, loaded - baseline);
        }
        assert_eq!(samples, [samples[0]; 3]);
        samples[0]
    });

    let bytes = loaded_bytes.checked_sub(control_bytes).unwrap();
    let per_hold = bytes as f64 / HOLD_COUNT as f64;
    let verdict = if bytes <= BOUND_BYTES {
        "within"
    } else {
        "exceeds"
    };
    println!(
        "HOLD_HEAP holds={HOLD_COUNT} bytes={bytes} per_hold={per_hold:.2} control_bytes={control_bytes} bound_bytes={BOUND_BYTES} verdict={verdict}"
    );
    assert!(bytes <= BOUND_BYTES, "{bytes} bytes exceeds {BOUND_BYTES}");
}

async fn retained_bytes(pool: &PgPool, limit: usize) -> usize {
    let activity = Activity::default();
    let capacity = Arc::new(Capacity::new(limit));
    let metrics = Arc::<RevocationMetrics>::default();
    let organization = Uuid::from_u128(1);
    let mut registrations = Vec::with_capacity(REGISTRATIONS);
    let mut frames = Vec::with_capacity(HOLD_COUNT);
    for socket in 1..=REGISTRATIONS {
        let id = Uuid::from_u128(socket as u128);
        let entry = Arc::new(Entry {
            id,
            organization,
            member: (id, 0),
            hash: vec![0; 32],
            buffer: Mutex::default(),
            wake: Notify::new(),
        });
        activity.entries.lock().unwrap().insert(id, entry.clone());
        {
            let mut b = entry.buffer.lock().unwrap();
            b.holds.capacity = capacity.clone();
            b.holds.metrics = metrics.clone();
            for channel in 1..=CHANNELS {
                let channel = Uuid::from_u128(channel as u128);
                let capture = b
                    .revocations
                    .capture(ChangeScope::Channel(channel))
                    .notice(channel, false, Role::Member)
                    .unwrap();
                frames.push(NoticeFrame::new(&entry, revocation(capture), false));
            }
        }
        registrations.push(Registration {
            id,
            entry,
            registry: Arc::downgrade(&activity.entries),
        });
    }

    // Process Members in a fixed order so insertion into the deadline index
    // is independent of registry hash iteration. Only the admission limit differs.
    for registration in &registrations {
        activity
            .check(
                pool,
                auth::SubscriptionScope::Member(organization, registration.entry.member.0),
            )
            .await;
    }
    // Complete the in-flight initial handoffs. Fallback has invalidated their
    // proof, so held frames park without any registration polling next().
    for frame in frames {
        assert_eq!(
            frame
                .handoff(pool, |_| async { panic!("failed recheck polled a write") })
                .await,
            None::<()>
        );
    }
    activity.drained().await;

    let expected = if limit == 0 { 0 } else { HOLD_COUNT };
    assert_eq!(metrics.load(RevocationMetric::Held), expected as u64);
    assert_eq!(
        metrics.load(RevocationMetric::GlobalCap),
        (HOLD_COUNT - expected) as u64
    );
    assert_eq!(metrics.load(RevocationMetric::RegistrationCap), 0);
    assert_eq!(capacity.sample().active_holds, expected);
    for registration in &registrations {
        let b = registration.entry.buffer.lock().unwrap();
        assert_eq!(b.holds.entries.len(), expected / REGISTRATIONS);
        assert_eq!(b.revocations.counts(), (expected / REGISTRATIONS, 0));
        assert!(b.holds.entries.values().all(|hold| hold.parked.is_some()));
    }

    // Both samples include the registry, registrations and empty Tracking
    // shells. The delta includes the retained frames, captures and index nodes.
    dhat::HeapStats::get().curr_bytes
}
