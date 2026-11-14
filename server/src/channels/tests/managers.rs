use super::management::{grant, mutation, snapshot};
use super::role_changes::change;
use super::*;
use crate::test_support::TestPools;
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};

mod concurrency;
mod deactivation;
mod denials;
mod lifetime;

#[derive(Default)]
struct Observed {
    access: super::super::access::AccessChanges,
    calls: AtomicUsize,
}

impl auth::SubscriptionRecheck for Observed {
    fn check<'a>(
        &'a self,
        pool: &'a PgPool,
        scope: auth::SubscriptionScope,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), sqlx::Error>> + Send + 'a>>
    {
        self.calls.fetch_add(1, Ordering::SeqCst);
        Box::pin(async move { auth::SubscriptionRecheck::check(&self.access, pool, scope).await })
    }
    fn failed(&self, _: auth::SubscriptionScope) {
        panic!("unexpected subscription failure");
    }
}

struct Fixture {
    pools: TestPools,
    state: AppState,
    app: Router,
    observed: Arc<Observed>,
    org: Uuid,
    creator: Uuid,
    token: String,
    channel: Uuid,
}

impl Fixture {
    async fn new(pool: PgPool) -> Self {
        let pools = TestPools::new(pool).await;
        let org = organization(&pools.admin).await;
        let creator = Uuid::new_v4();
        let token = member(&pools.admin, org, creator, "member").await;
        let state = AppState::for_test(pools.app.clone()).await;
        let observed = Arc::new(Observed::default());
        state
            .session_changes
            .set_subscription_recheck(observed.clone());
        let app = crate::app(state.clone());
        let c = create(&app, &token, "Member's private Channel", "private").await;
        assert_eq!(c["capabilities"]["can_manage_managers"]["allowed"], true);
        let channel = Uuid::parse_str(c["id"].as_str().unwrap()).unwrap();
        Self {
            pools,
            state,
            app,
            observed,
            org,
            creator,
            token,
            channel,
        }
    }

    async fn user(&self, role: &str) -> (Uuid, String) {
        let id = Uuid::new_v4();
        (id, member(&self.pools.admin, self.org, id, role).await)
    }

    async fn add(&self, id: Uuid) {
        assert_eq!(
            mutation(&self.app, &self.token, self.channel, id, true)
                .await
                .status(),
            StatusCode::NO_CONTENT
        );
    }

    async fn right(&self, id: Uuid) -> (Uuid, bool) {
        sqlx::query_as("SELECT grant_id,manager FROM channel_members WHERE organization_id=$1 AND channel_id=$2 AND member_id=$3")
            .bind(self.org).bind(self.channel).bind(id).fetch_one(&self.pools.admin).await.unwrap()
    }

    async fn denied(
        &self,
        token: &str,
        channel: Uuid,
        target: Uuid,
        value: bool,
        status: StatusCode,
        error: &str,
    ) {
        let before = snapshot(&self.pools.admin).await;
        let calls = self.observed.calls.load(Ordering::SeqCst);
        let response = manager(&self.app, token, channel, target, value).await;
        assert_eq!(response.status(), status);
        assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
        assert_eq!(body(response).await, json!({"error":error}));
        assert_eq!(snapshot(&self.pools.admin).await, before);
        assert_eq!(self.observed.calls.load(Ordering::SeqCst), calls);
    }
}

async fn manager(app: &Router, token: &str, channel: Uuid, target: Uuid, value: bool) -> Response {
    request(
        app,
        "PATCH",
        &format!("/api/v1/channels/{channel}/members/{target}"),
        token,
        json!({"manager":value}),
    )
    .await
}

#[fukulow_test::test]
async fn channel_manager_creation_management_and_capabilities_match_authorize(pool: PgPool) {
    let f = Fixture::new(pool).await;
    assert!(f.right(f.creator).await.1);
    let (target, tt) = f.user("member").await;
    f.add(target).await;
    assert!(!f.right(target).await.1);
    let initial = snapshot(&f.pools.admin).await;
    let lifetime = f.right(f.creator).await.0;
    f.add(f.creator).await;
    assert_eq!(snapshot(&f.pools.admin).await, initial);
    assert_eq!(f.right(f.creator).await, (lifetime, true));
    let target_lifetime = f.right(target).await.0;
    for value in [true, true, false, false, true] {
        assert_eq!(
            manager(&f.app, &f.token, f.channel, target, value)
                .await
                .status(),
            StatusCode::NO_CONTENT
        );
        assert_eq!(f.right(target).await, (target_lifetime, value));
    }
    let listed = body(
        request(
            &f.app,
            "GET",
            &format!("/api/v1/channels/{}/members", f.channel),
            &f.token,
            Value::Null,
        )
        .await,
    )
    .await;
    assert!(
        listed["members"]
            .as_array()
            .unwrap()
            .iter()
            .all(|m| m["manager"] == true && m.get("email").is_none())
    );
    for (id, token, role, right) in [
        (f.creator, &f.token, Role::Member, true),
        (target, &tt, Role::Member, true),
    ] {
        let listed = list(&f.app, token).await;
        let c = &listed["channels"][0];
        for (name, action) in [
            ("can_add_members", Action::AddChannelMembers),
            ("can_remove_members", Action::RemoveChannelMembers),
            ("can_manage_managers", Action::ManageChannelManagers),
        ] {
            assert_eq!(
                c["capabilities"][name]["allowed"],
                authorize(
                    Actor::Member {
                        organization: f.org,
                        role,
                        channel_member: true,
                        channel_manager: right
                    },
                    action,
                    Resource::Channel {
                        organization: f.org,
                        public: false
                    }
                )
                .allowed,
                "{id}"
            );
        }
    }
    assert_eq!(
        mutation(&f.app, &f.token, f.channel, f.creator, false)
            .await
            .status(),
        StatusCode::NO_CONTENT
    );
    let (extra, _) = f.user("member").await;
    assert_eq!(
        mutation(&f.app, &tt, f.channel, extra, true).await.status(),
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        mutation(&f.app, &tt, f.channel, extra, false)
            .await
            .status(),
        StatusCode::NO_CONTENT
    );
    // Owner/Admin still manage using their grant, without needing the right.
    for role in ["owner", "admin"] {
        let (id, token) = f.user(role).await;
        grant(&f.pools.admin, f.org, f.channel, id).await;
        assert_eq!(
            manager(&f.app, &token, f.channel, extra, true)
                .await
                .status(),
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            mutation(&f.app, &token, f.channel, extra, true)
                .await
                .status(),
            StatusCode::NO_CONTENT
        );
        assert_eq!(
            manager(&f.app, &token, f.channel, extra, true)
                .await
                .status(),
            StatusCode::NO_CONTENT
        );
        assert_eq!(
            mutation(&f.app, &token, f.channel, extra, false)
                .await
                .status(),
            StatusCode::NO_CONTENT
        );
    }
    f.pools.app.close().await;
}
