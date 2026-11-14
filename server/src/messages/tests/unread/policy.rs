use super::{roles::*, *};
use crate::auth::{ALL_ROLES, Action, Actor, Resource, Role, authorize};

#[derive(Debug)]
struct AccessCase {
    organization: Uuid,
    member: Uuid,
    channel: Uuid,
    role: Role,
    public: bool,
    granted: bool,
    active: bool,
}

impl AccessCase {
    fn allowed(&self) -> bool {
        // Inactive Membership cannot construct an authorized Member actor.
        let actor = if self.active {
            Actor::Member {
                organization: self.organization,
                role: self.role,
                channel_member: self.granted,
                channel_manager: false,
            }
        } else {
            Actor::Anonymous
        };
        authorize(
            actor,
            Action::ReadChannel,
            Resource::Channel {
                organization: self.organization,
                public: self.public,
            },
        )
        .allowed
    }

    async fn assert_positions(&self, pool: &PgPool) {
        let position = position(pool, self.organization, self.channel, self.member).await;
        assert_eq!(
            position.is_some(),
            self.allowed(),
            "Channel trigger: {self:?}"
        );
        let topics = topic_positions(pool, self.organization, self.channel, self.member).await;
        assert_eq!(
            !topics.is_empty(),
            self.allowed(),
            "Topic trigger: {self:?}"
        );
    }

    async fn assert_queries(&self, app: &Router, token: &str, topic: &str) {
        let response = request(app, "GET", "/api/v1/channels", token, Value::Null).await;
        if self.active {
            assert_eq!(response.status(), StatusCode::OK);
            let list = body(response).await;
            let listed = list["channels"]
                .as_array()
                .unwrap()
                .iter()
                .any(|entry| entry["id"] == self.channel.to_string());
            assert_eq!(listed, self.allowed(), "Unread list: {self:?}");
        } else {
            assert_eq!(
                response.status(),
                StatusCode::NOT_FOUND,
                "Inactive list: {self:?}"
            );
        }
        let expected = if self.allowed() {
            StatusCode::OK
        } else {
            StatusCode::NOT_FOUND
        };
        for (method, suffix) in [
            ("PUT", "read".to_owned()),
            ("PUT", format!("topics/{topic}/read")),
            ("GET", "topics".to_owned()),
        ] {
            let response = request(
                app,
                method,
                &format!("/api/v1/channels/{}/{suffix}", self.channel),
                token,
                json!({"read_seq":1}),
            )
            .await;
            assert_eq!(response.status(), expected, "{method} {suffix}: {self:?}");
        }
    }
}

#[fukulow_test::test]
async fn unread_triggers_and_queries_match_authorize_for_every_role(pool: PgPool) {
    let (app, org, owner_id, _, owner) = fixture(&pool).await;
    role(&pool, org, owner_id, "owner").await;
    for current_role in ALL_ROLES {
        for public in [false, true] {
            let channel = Uuid::new_v4();
            super::super::channel(&pool, org, channel, owner_id, !public).await;
            let topic = post(&app, &owner, channel, Some("Policy")).await;
            let topic_id = topic["topic_id"].as_str().unwrap();
            let viewer = Uuid::new_v4();
            let token = member(&pool, org, viewer).await;
            let role_name = serde_json::to_value(current_role).unwrap();
            role(&pool, org, viewer, role_name.as_str().unwrap()).await;
            let mut case = AccessCase {
                organization: org,
                member: viewer,
                channel,
                role: current_role,
                public,
                granted: false,
                active: true,
            };
            case.assert_positions(&pool).await;
            case.assert_queries(&app, &token, topic_id).await;
            for granted in [true, false] {
                case.granted = granted;
                if granted {
                    grant(&pool, org, channel, viewer).await;
                } else {
                    revoke(&pool, org, channel, viewer).await;
                }
                case.assert_positions(&pool).await;
                case.assert_queries(&app, &token, topic_id).await;
                for active in [false, true] {
                    case.active = active;
                    crate::auth::set_member_active_for_test(&pool, org, viewer, active).await;
                    // Deactivation makes the old grant stale; refresh it only after
                    // checking the Member trigger, including while still inactive.
                    if !active {
                        case.granted = false;
                    }
                    case.assert_positions(&pool).await;
                    case.assert_queries(&app, &token, topic_id).await;
                    if granted {
                        grant(&pool, org, channel, viewer).await;
                        case.granted = true;
                        case.assert_positions(&pool).await;
                        case.assert_queries(&app, &token, topic_id).await;
                    }
                }
            }
        }
    }
}
