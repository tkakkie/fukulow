use super::{Activity, Notice, Registration, Uuid};
use crate::test_support::{Gate, Gates};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};

type ActivityGateKey = (Uuid, Uuid, &'static str, Option<Uuid>);
static TEST_GATES: Gates<ActivityGateKey> = Gates::new();
pub(crate) fn pause(organization: Uuid, channel: Uuid, phase: &'static str) -> Arc<Gate> {
    pause_member(organization, channel, phase, None)
}
pub(crate) fn pause_member(
    organization: Uuid,
    channel: Uuid,
    phase: &'static str,
    member: Option<Uuid>,
) -> Arc<Gate> {
    TEST_GATES.register((organization, channel, phase, member))
}
pub(crate) async fn test_pause(
    organization: Uuid,
    channel: Uuid,
    phase: &'static str,
    member: Option<Uuid>,
) {
    // Independent socket gates must not replace each other at the same boundary.
    TEST_GATES
        .pause_with_fallback(
            (organization, channel, phase, member),
            (organization, channel, phase, None),
        )
        .await;
}

#[derive(Clone, Copy)]
pub(crate) enum TestFault {
    Database,
    Panic,
}
static TEST_FAULTS: std::sync::LazyLock<Mutex<HashMap<(Uuid, Uuid), TestFault>>> =
    std::sync::LazyLock::new(Mutex::default);
pub(crate) fn fail(organization: Uuid, channel: Uuid, fault: TestFault) {
    TEST_FAULTS
        .lock()
        .unwrap()
        .insert((organization, channel), fault);
}
pub(super) fn test_fault(organization: Uuid, channel: Uuid) -> Result<(), sqlx::Error> {
    let fault = TEST_FAULTS.lock().unwrap().remove(&(organization, channel));
    match fault {
        Some(TestFault::Database) => Err(sqlx::Error::PoolClosed),
        Some(TestFault::Panic) => panic!("injected notice publisher panic"),
        None => Ok(()),
    }
}

impl Activity {
    pub(crate) async fn drained(&self) {
        self.drained_except(0).await;
    }
    pub(crate) async fn drained_except(&self, active: u32) {
        let _permits = self
            .capacity
            .clone()
            .acquire_many_owned(40 - active)
            .await
            .unwrap();
    }

    pub(crate) async fn saturate(&self) -> tokio::sync::OwnedSemaphorePermit {
        self.capacity.clone().acquire_many_owned(40).await.unwrap()
    }
    // One abort handle per key: this aborts the most recent spawn for (organization, channel).
    pub(crate) fn cancel(&self, organization: Uuid, channel: Uuid) {
        self.tasks
            .lock()
            .unwrap()
            .remove(&(organization, channel))
            .unwrap()
            .abort();
    }
}

impl Registration {
    pub(crate) fn isolate_revocation_metrics(
        &self,
    ) -> Arc<crate::observability::RevocationMetrics> {
        self.entry.buffer.lock().unwrap().holds.isolate_metrics()
    }

    pub(crate) fn buffered(&self, notice: &Notice) -> bool {
        let b = self.entry.buffer.lock().unwrap();
        b.pending.iter().any(|pending| &pending.notice == notice)
    }

    pub(crate) fn revocation_tracking(&self) -> (usize, usize) {
        self.entry.buffer.lock().unwrap().revocations.counts()
    }
}
