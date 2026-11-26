use super::super::*;
use crate::channels::{
    activity::{Activity, Notice, NoticeFrame, Registration, pause_member},
    tests::extract_auth,
};
use futures_util::FutureExt;

#[derive(Clone, Copy, Debug)]
pub(super) enum Later {
    OtherGrant,
    OtherManager,
    OtherMember,
    Regrant,
    Role,
    Deactivate,
}

pub(super) struct Case {
    pub(super) f: Fixture,
    pub(super) target: Uuid,
    pub(super) token: String,
    pub(super) registration: Registration,
    pub(super) revoked: Uuid,
    pub(super) other: Uuid,
}
impl Case {
    pub(super) async fn new(pool: &PgPool, whole_set: bool, later: Later) -> Self {
        let f = fixture(pool).await;
        owner(pool, &f).await;
        let (target, token) = member(pool, f.organization).await;
        let revoked = if whole_set {
            f.channel
        } else {
            let private = channel(pool, f.organization, f.member, true).await;
            grant(pool, &f, private, target).await;
            private
        };
        let other = channel(pool, f.organization, f.member, true).await;
        if matches!(later, Later::OtherManager) {
            grant(pool, &f, other, target).await;
        }
        let auth = extract_auth(f.state.clone(), &token).await;
        let registration = f
            .state
            .message_delivery
            .channel_access
            .activity
            .register(&auth);
        Self {
            f,
            target,
            token,
            registration,
            revoked,
            other,
        }
    }
    pub(super) fn delivery(&self) -> &Activity {
        &self.f.state.message_delivery.channel_access.activity
    }
    pub(super) fn revoked(&self) -> Notice {
        Notice::ChannelAccessRevoked {
            channel_id: self.revoked,
        }
    }
    pub(super) fn pause_revocation(&self, phase: &'static str) -> Arc<Gate> {
        pause_member(self.f.organization, self.revoked, phase, Some(self.target))
    }
    pub(super) fn pause_role_publisher(&self) -> Arc<Gate> {
        pause_member(
            self.f.organization,
            Uuid::nil(),
            "target_state",
            Some(self.target),
        )
    }
    pub(super) async fn publish_channel_list(&self) {
        self.delivery()
            .publish(
                &self.f.state.pool,
                self.f.organization,
                Notice::ChannelListChanged,
                Some(self.target),
                None,
            )
            .await
            .unwrap();
    }
    pub(super) async fn remove_grant(&self) {
        self.request(
            "DELETE",
            &format!("/api/v1/channels/{}/members/{}", self.revoked, self.target),
            Value::Null,
            StatusCode::NO_CONTENT,
        )
        .await;
    }
    pub(super) async fn set_role(&self, role: &str) {
        self.request(
            "PATCH",
            &format!(
                "/api/v1/orgs/{}/members/{}/role",
                self.f.organization, self.target
            ),
            json!({"role":role}),
            StatusCode::OK,
        )
        .await;
    }
    pub(super) async fn grant(&self, channel: Uuid) {
        self.request(
            "POST",
            &format!("/api/v1/channels/{channel}/members"),
            json!({"member_id":self.target}),
            StatusCode::NO_CONTENT,
        )
        .await;
    }
    pub(super) async fn later(&self, pool: &PgPool, later: Later, whole_set: bool) {
        match later {
            Later::OtherGrant => self.grant(self.other).await,
            Later::OtherManager => {
                self.request(
                    "PATCH",
                    &format!("/api/v1/channels/{}/members/{}", self.other, self.target),
                    json!({"manager":true}),
                    StatusCode::NO_CONTENT,
                )
                .await
            }
            Later::OtherMember => {
                let (other, _) = member(pool, self.f.organization).await;
                self.request(
                    "POST",
                    &format!("/api/v1/channels/{}/members", self.revoked),
                    json!({"member_id":other}),
                    StatusCode::NO_CONTENT,
                )
                .await;
            }
            Later::Regrant => self.grant(self.revoked).await,
            Later::Role => {
                self.set_role(if whole_set { "member" } else { "guest" })
                    .await
            }
            Later::Deactivate => {
                self.request(
                    "POST",
                    &format!(
                        "/api/v1/orgs/{}/members/{}/deactivate",
                        self.f.organization, self.target
                    ),
                    Value::Null,
                    StatusCode::NO_CONTENT,
                )
                .await
            }
        }
    }
    pub(super) async fn request(
        &self,
        method: &str,
        path: &str,
        body: Value,
        expected: StatusCode,
    ) {
        let response = request(&self.f.app, method, path, &self.f.token, body).await;
        assert_eq!(response.status(), expected, "{method} {path}");
    }
    pub(super) fn next(&self) -> Option<NoticeFrame> {
        // With counted publishers drained, next is ready exactly while there is buffered work.
        self.registration.next().now_or_never().flatten()
    }
    pub(super) fn take_revocation(&self) -> NoticeFrame {
        while let Some(frame) = self.next() {
            if frame.event == self.revoked() {
                return frame;
            }
        }
        panic!("expected a revocation ready for first handoff");
    }
    pub(super) async fn received_revocations(&self, held: Option<NoticeFrame>) -> usize {
        let mut count = 0;
        let mut frame = held.or_else(|| self.next());
        while let Some(next) = frame {
            count += usize::from(
                next.handoff(&self.f.state.pool, |event| async { event })
                    .await
                    == Some(self.revoked()),
            );
            frame = self.next();
        }
        count
    }
}
