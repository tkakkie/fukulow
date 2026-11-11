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
    pub(crate) fn assert_no_default_fatal(&self) {
        if let Some(calls) = &self.default_fatal_calls {
            assert_eq!(
                calls.load(std::sync::atomic::Ordering::SeqCst),
                0,
                "default fatal hook called; use with_on_fatal"
            );
        }
    }

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
        self.assert_no_default_fatal();
        assert!(
            self.default_fatal_calls.is_none(),
            "worker panic tests must call with_on_fatal"
        );
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
    changes.revoked(vec![1]);
    for i in 0..2048_u32 {
        changes.revoked(i.to_be_bytes().to_vec());
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
    assert!(other_organization.changed.borrow().revoked);
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
    let account = Uuid::new_v4();
    let hash = uuid::Uuid::new_v4().as_bytes().repeat(2);
    sqlx::query("INSERT INTO organizations (organization_id, name) VALUES ($1, 'Organization')")
        .bind(organization)
        .execute(pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO accounts (id, email, password_hash) VALUES ($1, $2, 'unused')")
        .bind(account)
        .bind(format!("{account}@example.com"))
        .execute(pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO users (organization_id, id, account_id, name, role) VALUES ($1, $2, $3, 'Member', 'member')")
        .bind(organization).bind(member).bind(account).execute(pool).await.unwrap();
    sqlx::query("INSERT INTO account_sessions (token_hash, account_id) VALUES ($1, $2)")
        .bind(&hash)
        .bind(account)
        .execute(pool)
        .await
        .unwrap();
    let state = AppState::for_test(pool.clone());
    let identity = super::super::Identity {
        organization: super::super::Organization {
            organization_id: organization,
            name: "Organization".into(),
            capabilities: super::super::OrganizationCapabilities::for_member(
                organization,
                super::super::Role::Member,
            ),
        },
        member: super::super::Member {
            id: member,
            name: "Member".into(),
            role: super::super::Role::Member,
        },
    };
    (
        state,
        Auth {
            identity,
            account_id: account,
            membership_revision: 0,
            token_hash: hash,
        },
    )
}

#[sqlx::test]
async fn register_then_check_has_no_revocation_gap(pool: PgPool) {
    let (state, auth) = fixture(&pool).await;

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
        sqlx::query("DELETE FROM account_sessions WHERE token_hash = $1")
            .bind(&auth.token_hash)
            .execute(&pool)
            .await
            .unwrap();
        state.session_changes.revoked(auth.token_hash.clone());
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
        sqlx::query("INSERT INTO account_sessions (token_hash, account_id) VALUES ($1, $2)")
            .bind(&auth.token_hash)
            .bind(auth.account_id)
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
    changes.revoked(key.1.clone());
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
    sqlx::query("LOCK TABLE account_sessions IN ACCESS EXCLUSIVE MODE")
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
    state.session_changes.revoked(auth.token_hash);
    new.ended().await.unwrap();
}

#[sqlx::test]
async fn worker_failure_during_initial_check_is_not_admitted(pool: PgPool) {
    let (mut state, auth) = fixture(&pool).await;
    state.session_changes =
        SessionChanges::with_recheck_timing(Duration::from_millis(50), CHECK_TIMEOUT)
            .with_on_fatal(Arc::new(|| {}));
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

#[tokio::test]
async fn membership_signals_scope_all_account_sessions_and_preserve_new_revision() {
    let changes = SessionChanges::default();
    let organization = Uuid::new_v4();
    let account = Uuid::new_v4();
    let first_key = (organization, vec![1]);
    let first = changes.register_member(first_key.clone(), account, 0);
    let second = changes.register_member((organization, vec![2]), account, 0);
    let other_organization = changes.register_member((Uuid::new_v4(), vec![1]), account, 0);
    let other_account = changes.register_member((organization, vec![3]), Uuid::new_v4(), 0);
    changes.membership_revoked(organization, account, 1);
    assert!(first.changed.borrow().membership_revoked);
    assert!(second.changed.borrow().membership_revoked);
    assert!(!first.changed.borrow().revoked);
    assert!(!other_organization.changed.has_changed().unwrap());
    assert!(!other_account.changed.has_changed().unwrap());
    let reactivated = changes.register_member(first_key, account, 1);
    // A delayed old signal cannot kill a connection authorized after reactivation.
    changes.membership_revoked(organization, account, 1);
    assert!(!reactivated.changed.borrow().membership_revoked);
    assert!(first.changed.borrow().membership_revoked);
    changes.revoked(vec![1]);
    assert!(reactivated.changed.borrow().revoked);
    assert!(other_organization.changed.borrow().revoked);
    assert!(!second.changed.borrow().revoked);
}

#[sqlx::test]
async fn latched_membership_at_connect_yields_4003_and_session_end_wins(pool: PgPool) {
    for (session_ended, failed) in [(false, false), (false, true), (true, false), (true, true)] {
        let (state, auth) = fixture(&pool).await;
        let fallback = state.session_changes.pause_fallback();
        let registration = state.session_changes.register_member(
            (
                auth.identity.organization.organization_id,
                auth.token_hash.clone(),
            ),
            auth.account_id,
            auth.membership_revision,
        );
        state.session_changes.membership_revoked(
            auth.identity.organization.organization_id,
            auth.account_id,
            1,
        );
        // Even a missing SQL deadline must not relabel a latched Membership loss.
        sqlx::query("DELETE FROM account_sessions WHERE token_hash = $1")
            .bind(&auth.token_hash)
            .execute(&pool)
            .await
            .unwrap();
        if failed {
            registration
                .guard
                .epoch
                .send_modify(|status| status.failed = true);
        }
        if session_ended {
            state.session_changes.revoked(auth.token_hash.clone());
        }
        let code = match auth.watch_session(&state).await.unwrap() {
            Some(mut watch) => watch.ended().await.unwrap(),
            None => 4001,
        };
        assert_eq!(code, if session_ended { 4001 } else { 4003 });
        fallback.entered().await;
        fallback.release();
    }
}

#[sqlx::test]
async fn membership_connect_race_is_classified_independently_from_session_end(pool: PgPool) {
    let (state, auth) = fixture(&pool).await;
    let checked = state.session_changes.pause(Phase::Checked);
    let watch = auth.watch_session(&state);
    tokio::pin!(watch);
    tokio::select! {
        _ = &mut watch => panic!("initial check did not pause"),
        _ = checked.entered() => {},
    }
    sqlx::query("UPDATE users SET deactivated_at = clock_timestamp() WHERE organization_id = $1 AND account_id = $2")
        .bind(auth.identity.organization.organization_id).bind(auth.account_id).execute(&pool).await.unwrap();
    state.session_changes.membership_revoked(
        auth.identity.organization.organization_id,
        auth.account_id,
        1,
    );
    checked.release();
    let mut socket = watch.await.unwrap().unwrap();
    assert_eq!(socket.ended().await.unwrap(), 4003);
}

#[tokio::test]
async fn revoked_session_cannot_be_restored_by_a_new_membership_revision() {
    let changes = SessionChanges::default();
    let key = (Uuid::new_v4(), vec![1]);
    let account = Uuid::new_v4();
    let old = changes.register_member(key.clone(), account, 0);
    changes.revoked(key.1.clone());
    let new = changes.register_member(key, account, 1);
    assert!(new.changed.borrow().revoked);
    assert!(old.guard.epoch.same_channel(&new.guard.epoch));
    assert_eq!(changes.sessions.lock().unwrap().by_token.len(), 1);
    assert_eq!(changes.sessions.lock().unwrap().by_member.len(), 1);
    drop(old);
    drop(new);
    let sessions = changes.sessions.lock().unwrap();
    assert!(sessions.entries.is_empty());
    assert!(sessions.by_token.is_empty());
    assert!(sessions.by_member.is_empty());
}

#[tokio::test]
async fn stale_membership_registration_cannot_revoke_or_replace_a_newer_epoch() {
    let changes = SessionChanges::default();
    let key = (Uuid::new_v4(), vec![1]);
    let account = Uuid::new_v4();
    let old = changes.register_member(key.clone(), account, 0);
    let current = changes.register_member(key.clone(), account, 1);
    assert!(old.changed.borrow().membership_revoked);
    assert!(!current.changed.borrow().membership_revoked);
    let mut stale = SessionWatch {
        registration: changes.register_member(key.clone(), account, 0),
        deadline: Some(Instant::now() + Duration::from_secs(60)),
    };
    assert_eq!(stale.ended().await.unwrap(), 4003);
    assert!(!current.changed.has_changed().unwrap());
    assert!(changes.sessions.lock().unwrap().entries[&key].same_channel(&current.guard.epoch));
    assert!(changes.sessions.lock().unwrap().by_token[&key.1].contains(&key));
    assert!(changes.sessions.lock().unwrap().by_member[&(key.0, account)].contains(&key));
    drop(stale);
    drop(old);
    assert!(changes.sessions.lock().unwrap().entries[&key].same_channel(&current.guard.epoch));
    // Revocation remains latched even for a later stale registration.
    changes.revoked(key.1.clone());
    let revoked_stale = changes.register_member(key, account, 0);
    assert!(revoked_stale.changed.borrow().revoked);
    assert!(revoked_stale.guard.epoch.same_channel(&current.guard.epoch));
    drop(revoked_stale);
    drop(current);
    let sessions = changes.sessions.lock().unwrap();
    assert!(sessions.entries.is_empty());
    assert!(sessions.by_token.is_empty());
    assert!(sessions.by_member.is_empty());
}
