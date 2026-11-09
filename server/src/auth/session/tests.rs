use super::*;
use tokio::sync::Semaphore;

#[derive(Clone, Copy, PartialEq)]
pub(super) enum Phase {
    Registered,
    Checked,
}
pub(super) struct Gate {
    phase: Phase,
    entered: Semaphore,
    release: Semaphore,
}
impl SessionChanges {
    fn pause(&self, phase: Phase) -> Arc<Gate> {
        let gate = Arc::new(Gate {
            phase,
            entered: Semaphore::new(0),
            release: Semaphore::new(0),
        });
        *self.gate.lock().unwrap() = Some(gate.clone());
        gate
    }
    pub(super) async fn pause_check(&self, phase: Phase) {
        let gate = {
            let mut gate = self.gate.lock().unwrap();
            if gate.as_ref().is_some_and(|gate| gate.phase == phase) {
                gate.take()
            } else {
                None
            }
        };
        if let Some(gate) = gate {
            gate.entered.add_permits(1);
            gate.release.acquire().await.unwrap().forget();
        }
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
        first.changed.wait_for(|revoked| *revoked),
    )
    .await
    .unwrap()
    .unwrap();
    tokio::time::timeout(
        Duration::from_secs(1),
        second.changed.wait_for(|revoked| *revoked),
    )
    .await
    .unwrap()
    .unwrap();
    assert!(!other_session.changed.has_changed().unwrap());
    assert!(!other_organization.changed.has_changed().unwrap());
    drop(first);
    assert!(changes.sessions.lock().unwrap().contains_key(&key));
    let third = changes.register(key.clone());
    assert!(*third.changed.borrow());
    drop(second);
    drop(third);
    assert!(!changes.sessions.lock().unwrap().contains_key(&key));
    drop(other_session);
    drop(other_organization);
    assert!(changes.sessions.lock().unwrap().is_empty());
}

async fn fixture(pool: &PgPool) -> (AppState, Auth) {
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
        match watch.await.unwrap() {
            None => assert!(phase == Phase::Registered),
            Some(mut watch) => {
                assert!(phase == Phase::Checked);
                tokio::time::timeout(Duration::from_secs(1), watch.ended())
                    .await
                    .unwrap()
                    .unwrap();
            }
        }
        assert!(state.session_changes.sessions.lock().unwrap().is_empty());
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
    let mut watch = auth.watch_session(&state).await.unwrap().unwrap();
    let _held = exhausted.acquire().await.unwrap();
    let started = Instant::now();
    let error = tokio::time::timeout(
        RECHECK_INTERVAL + CHECK_TIMEOUT + Duration::from_secs(1),
        watch.ended(),
    )
    .await
    .unwrap()
    .unwrap_err();
    assert!(matches!(error, sqlx::Error::PoolTimedOut));
    assert!(started.elapsed() >= RECHECK_INTERVAL);
}
