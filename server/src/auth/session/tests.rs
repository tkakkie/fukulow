use super::*;
use tokio::sync::Semaphore;

#[derive(Clone, Copy, PartialEq)]
pub(super) enum Phase {
    Registered,
    Checked,
    Worker,
    Started,
    Snapshot,
    Queried,
}
pub(crate) struct Gate {
    phase: Phase,
    entered: Semaphore,
    release: Semaphore,
}
impl Gate {
    pub(crate) async fn entered(&self) {
        tokio::time::timeout(Duration::from_secs(5), self.entered.acquire())
            .await
            .unwrap()
            .unwrap()
            .forget();
    }
    pub(crate) fn release(&self) {
        self.release.add_permits(1);
    }
}
impl SessionChanges {
    pub(crate) fn pause_fallback(&self) -> Arc<Gate> {
        self.pause(Phase::Started)
    }

    pub(super) fn pause(&self, phase: Phase) -> Arc<Gate> {
        let gate = Arc::new(Gate {
            phase,
            entered: Semaphore::new(0),
            release: Semaphore::new(0),
        });
        *self.gate.lock().unwrap() = Some(gate.clone());
        gate
    }
    pub(super) async fn pause_check(&self, phase: Phase) {
        pause_gate(&self.gate, phase).await;
    }

    pub(crate) async fn panic_worker(&self) {
        let mut registration = self.register((Uuid::new_v4(), vec![]));
        let gate = self.pause(Phase::Worker);
        gate.entered.acquire().await.unwrap().forget();
        gate.release.add_permits(1);
        registration
            .changed
            .wait_for(|status| status.failed)
            .await
            .unwrap();
        assert!(self.sessions.lock().unwrap().unavailable);
    }
}

pub(super) async fn pause_gate(gates: &Mutex<Option<Arc<Gate>>>, phase: Phase) {
    let gate = {
        let mut gate = gates.lock().unwrap();
        if gate.as_ref().is_some_and(|gate| gate.phase == phase) {
            gate.take()
        } else {
            None
        }
    };
    if let Some(gate) = gate {
        gate.entered.add_permits(1);
        gate.release.acquire().await.unwrap().forget();
        assert!(phase != Phase::Worker, "injected fallback worker panic");
    }
}

#[tokio::test]
async fn session_signals_are_scoped_latched_and_released_with_last_socket() {
    let changes = SessionChanges::default();
    let organization = Uuid::new_v4();
    let key = (organization, vec![1]);
    let mut first = changes.register(key.clone());
    let mut second = changes.register(key.clone());
    let other_session = changes.register((organization, vec![2]));
    let other_organization = changes.register((Uuid::new_v4(), vec![1]));
    // Exceed the old broadcast capacity before either affected receiver polls.
    changes.revoked(organization, vec![1]);
    for i in 0..2048_u32 {
        changes.revoked(organization, i.to_be_bytes().to_vec());
    }
    tokio::time::timeout(
        Duration::from_secs(1),
        first.changed.wait_for(|status| status.revoked),
    )
    .await
    .unwrap()
    .unwrap();
    tokio::time::timeout(
        Duration::from_secs(1),
        second.changed.wait_for(|status| status.revoked),
    )
    .await
    .unwrap()
    .unwrap();
    assert!(!other_session.changed.has_changed().unwrap());
    assert!(!other_organization.changed.has_changed().unwrap());
    drop(first);
    assert!(changes.sessions.lock().unwrap().entries.contains_key(&key));
    let third = changes.register(key.clone());
    assert!(third.changed.borrow().revoked);
    drop(second);
    drop(third);
    assert!(!changes.sessions.lock().unwrap().entries.contains_key(&key));
    drop(other_session);
    drop(other_organization);
    assert!(changes.sessions.lock().unwrap().entries.is_empty());
}

pub(super) async fn fixture(pool: &PgPool) -> (AppState, Auth) {
    let organization = Uuid::new_v4();
    let member = Uuid::new_v4();
    let hash = vec![1; 32];
    sqlx::query("INSERT INTO organizations (organization_id, name) VALUES ($1, 'Organization')")
        .bind(organization)
        .execute(pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO users (organization_id, id, email, name, password_hash, role) VALUES ($1, $2, 'member@example.com', 'Member', 'unused', 'member')")
        .bind(organization).bind(member).execute(pool).await.unwrap();
    sqlx::query("INSERT INTO sessions (organization_id, token_hash, user_id) VALUES ($1, $2, $3)")
        .bind(organization)
        .bind(&hash)
        .bind(member)
        .execute(pool)
        .await
        .unwrap();
    let state = AppState::for_test(pool.clone());
    let identity = super::super::identity(&state, organization, &hash)
        .await
        .unwrap();
    (
        state,
        Auth {
            identity,
            token_hash: hash,
        },
    )
}

#[sqlx::test]
async fn register_then_check_has_no_revocation_gap(pool: PgPool) {
    let (state, auth) = fixture(&pool).await;
    // A valid session with the same hash in another Organization cannot mask revocation.
    let (_, foreign_auth) = fixture(&pool).await;
    assert_eq!(auth.token_hash, foreign_auth.token_hash);
    for phase in [Phase::Registered, Phase::Checked] {
        let gate = state.session_changes.pause(phase);
        let watch = auth.watch_session(&state);
        tokio::pin!(watch);
        tokio::select! {
            _ = &mut watch => panic!("session check did not pause"),
            permit = gate.entered.acquire() => permit.unwrap().forget(),
        }
        assert!(
            state
                .session_changes
                .sessions
                .lock()
                .unwrap()
                .entries
                .contains_key(&(
                    auth.identity.organization.organization_id,
                    auth.token_hash.clone()
                ))
        );
        // Commit sign-out while paused, then publish its signal before the watcher resumes.
        sqlx::query("DELETE FROM sessions WHERE organization_id = $1 AND token_hash = $2")
            .bind(auth.identity.organization.organization_id)
            .bind(&auth.token_hash)
            .execute(&pool)
            .await
            .unwrap();
        state.session_changes.revoked(
            auth.identity.organization.organization_id,
            auth.token_hash.clone(),
        );
        gate.release.add_permits(1);
        assert!(watch.await.unwrap().is_none());
        assert!(
            state
                .session_changes
                .sessions
                .lock()
                .unwrap()
                .entries
                .is_empty()
        );
        sqlx::query(
            "INSERT INTO sessions (organization_id, token_hash, user_id) VALUES ($1, $2, $3)",
        )
        .bind(auth.identity.organization.organization_id)
        .bind(&auth.token_hash)
        .bind(auth.identity.member.id)
        .execute(&pool)
        .await
        .unwrap();
    }
}

#[sqlx::test]
async fn fallback_database_timeout_is_bounded_and_does_not_claim_session_ended(pool: PgPool) {
    let (mut state, auth) = fixture(&pool).await;
    let exhausted = sqlx::postgres::PgPoolOptions::new()
        .max_connections(1)
        .acquire_timeout(Duration::from_secs(60))
        .connect_with(pool.connect_options().as_ref().clone())
        .await
        .unwrap();
    state.pool = exhausted.clone();
    state.session_changes =
        SessionChanges::with_recheck_timing(Duration::from_millis(200), Duration::from_millis(100));
    let mut watch = auth.watch_session(&state).await.unwrap().unwrap();
    let _held = exhausted.acquire().await.unwrap();
    let error = tokio::time::timeout(Duration::from_secs(2), watch.ended())
        .await
        .unwrap()
        .unwrap_err();
    assert!(matches!(error, sqlx::Error::PoolTimedOut));
}

#[tokio::test]
async fn old_registration_drop_cannot_remove_new_epoch_and_revoked_is_irreversible() {
    let changes = SessionChanges::default();
    let key = (Uuid::new_v4(), vec![1]);
    let old = changes.register(key.clone());
    old.guard.epoch.send_modify(|status| status.failed = true);
    let Registration { changed, guard } = changes.register(key.clone());
    assert!(!changed.borrow().failed);
    assert!(old.changed.borrow().failed);
    assert!(!old.guard.epoch.same_channel(&guard.epoch));
    // Exercise the zero-receiver window before the new guard's own Drop.
    drop(changed);
    drop(old);
    assert!(changes.sessions.lock().unwrap().entries[&key].same_channel(&guard.epoch));
    let current = changes.register(key.clone());
    changes.revoked(key.0, key.1.clone());
    current
        .guard
        .epoch
        .send_modify(|status| status.failed = true);
    let later = changes.register(key);
    assert!(later.changed.borrow().revoked);
    assert!(later.changed.borrow().failed);
    assert!(current.guard.epoch.same_channel(&later.guard.epoch));
    drop(guard);
    drop(current);
    drop(later);
    assert!(changes.sessions.lock().unwrap().entries.is_empty());
}

#[sqlx::test]
async fn failed_epoch_closes_but_new_epoch_checks_current_database(pool: PgPool) {
    let (mut state, auth) = fixture(&pool).await;
    state.session_changes =
        SessionChanges::with_recheck_timing(Duration::from_millis(50), Duration::from_millis(200));
    let mut old = auth.watch_session(&state).await.unwrap().unwrap();
    let mut held = pool.begin().await.unwrap();
    sqlx::query("LOCK TABLE sessions IN ACCESS EXCLUSIVE MODE")
        .execute(&mut *held)
        .await
        .unwrap();
    assert!(
        tokio::time::timeout(Duration::from_secs(3), old.ended())
            .await
            .unwrap()
            .is_err()
    );
    held.rollback().await.unwrap();
    let mut new = auth.watch_session(&state).await.unwrap().unwrap();
    assert!(old.registration.changed.borrow().failed);
    assert!(!new.registration.changed.borrow().failed);
    assert!(
        !old.registration
            .guard
            .epoch
            .same_channel(&new.registration.guard.epoch)
    );
    drop(old);
    // Positive control: sign-out still reaches the new epoch, with session-end semantics.
    state
        .session_changes
        .revoked(auth.identity.organization.organization_id, auth.token_hash);
    new.ended().await.unwrap();
}

#[sqlx::test]
async fn worker_failure_during_initial_check_is_not_admitted(pool: PgPool) {
    let (mut state, auth) = fixture(&pool).await;
    state.session_changes =
        SessionChanges::with_recheck_timing(Duration::from_millis(50), CHECK_TIMEOUT);
    let checked = state.session_changes.pause(Phase::Checked);
    let watch = auth.watch_session(&state);
    tokio::pin!(watch);
    tokio::select! {
        _ = &mut watch => panic!("initial check did not pause"),
        _ = checked.entered() => {},
    }
    state.session_changes.panic_worker().await;
    checked.release();
    assert!(matches!(watch.await, Err(sqlx::Error::PoolClosed)));
}
