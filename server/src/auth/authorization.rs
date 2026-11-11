use super::{ApiError, Auth, Role};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;
use uuid::Uuid;

#[derive(Clone, Copy)]
pub enum Actor {
    Anonymous,
    Account,
    Member {
        organization: Uuid,
        role: Role,
        channel_member: bool,
    },
}

#[derive(Clone, Copy)]
pub enum Action {
    Public,
    Account,
    ReadOrganization,
    CreateChannel,
    Invite(Role),
    ChangeRole,
    ReadChannel,
    AddChannelMembers,
}

#[derive(Clone, Copy)]
pub enum Resource {
    Global,
    Organization(Uuid),
    Channel { organization: Uuid, public: bool },
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct Capability {
    pub allowed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

/// The complete policy. Unlisted actor/action/resource combinations are denied.
pub fn authorize(actor: Actor, action: Action, resource: Resource) -> Capability {
    let allowed = match (actor, action, resource) {
        (_, Action::Public, Resource::Global) => true,
        (Actor::Account, Action::Account, Resource::Global) => true,
        (
            Actor::Member {
                organization, role, ..
            },
            action,
            Resource::Organization(target),
        ) if organization == target => match action {
            Action::ReadOrganization => true,
            Action::CreateChannel => matches!(role, Role::Owner | Role::Admin | Role::Member),
            Action::Invite(target_role) => {
                matches!(role, Role::Owner)
                    || (matches!(role, Role::Admin) && !matches!(target_role, Role::Owner))
            }
            Action::ChangeRole => matches!(role, Role::Owner),
            _ => false,
        },
        (
            Actor::Member {
                organization,
                role,
                channel_member,
            },
            action,
            Resource::Channel {
                organization: target,
                public,
            },
        ) if organization == target => {
            let visible = channel_member || (public && !matches!(role, Role::Guest));
            match action {
                Action::ReadChannel => visible,
                Action::AddChannelMembers => visible && matches!(role, Role::Owner | Role::Admin),
                _ => false,
            }
        }
        _ => false,
    };
    Capability {
        allowed,
        reason: (!allowed).then(|| "forbidden".into()),
    }
}

pub(crate) fn require(actor: Actor, action: Action, resource: Resource) -> Result<(), ApiError> {
    if authorize(actor, action, resource).allowed {
        Ok(())
    } else {
        Err(ApiError::forbidden())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct OrganizationCapabilities {
    pub can_invite: Capability,
    pub can_manage_roles: Capability,
    pub can_create_channels: Capability,
}

impl OrganizationCapabilities {
    pub(crate) fn for_member(organization: Uuid, role: Role) -> Self {
        let actor = Actor::Member {
            organization,
            role,
            channel_member: false,
        };
        let resource = Resource::Organization(organization);
        Self {
            can_invite: authorize(actor, Action::Invite(Role::Member), resource),
            can_manage_roles: authorize(actor, Action::ChangeRole, resource),
            can_create_channels: authorize(actor, Action::CreateChannel, resource),
        }
    }
}

impl Auth {
    pub(crate) fn actor(&self) -> Actor {
        Actor::Member {
            organization: self.identity.organization.organization_id,
            role: self.identity.member.role,
            channel_member: false,
        }
    }
    pub(crate) fn require(&self, action: Action) -> Result<(), ApiError> {
        require(
            self.actor(),
            action,
            Resource::Organization(self.identity.organization.organization_id),
        )
    }
}

// Channels composes this policy projection with its owned SQL in the same snapshot.
// Deriving both sets from authorize keeps SQL and resource Capabilities in agreement.
pub(crate) fn channel_roles_sql(explicit: bool) -> String {
    let organization = Uuid::nil();
    [Role::Owner, Role::Admin, Role::Member, Role::Guest]
        .into_iter()
        .filter(|role| {
            authorize(
                Actor::Member {
                    organization,
                    role: *role,
                    channel_member: explicit,
                },
                Action::ReadChannel,
                Resource::Channel {
                    organization,
                    public: !explicit,
                },
            )
            .allowed
        })
        .map(|role| match role {
            Role::Owner => "'owner'",
            Role::Admin => "'admin'",
            Role::Member => "'member'",
            Role::Guest => "'guest'",
        })
        .collect::<Vec<_>>()
        .join(",")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn authorization_denies_unlisted_combinations_and_covers_every_role() {
        let org = Uuid::new_v4();
        for role in [Role::Owner, Role::Admin, Role::Member, Role::Guest] {
            let actor = Actor::Member {
                organization: org,
                role,
                channel_member: false,
            };
            assert!(
                authorize(actor, Action::ReadOrganization, Resource::Organization(org)).allowed
            );
            assert!(
                !authorize(
                    actor,
                    Action::ReadOrganization,
                    Resource::Organization(Uuid::new_v4())
                )
                .allowed
            );
            assert!(!authorize(actor, Action::Account, Resource::Global).allowed);
            for target in [Role::Owner, Role::Admin, Role::Member, Role::Guest] {
                assert_eq!(
                    authorize(actor, Action::Invite(target), Resource::Organization(org)).allowed,
                    role == Role::Owner || (role == Role::Admin && target != Role::Owner)
                );
            }
            for public in [false, true] {
                for explicit in [false, true] {
                    let actor = Actor::Member {
                        organization: org,
                        role,
                        channel_member: explicit,
                    };
                    let resource = Resource::Channel {
                        organization: org,
                        public,
                    };
                    assert_eq!(
                        authorize(actor, Action::ReadChannel, resource).allowed,
                        explicit || (public && role != Role::Guest)
                    );
                    assert_eq!(
                        authorize(actor, Action::AddChannelMembers, resource).allowed,
                        (explicit || (public && role != Role::Guest))
                            && matches!(role, Role::Owner | Role::Admin)
                    );
                }
            }
        }
        assert!(
            !authorize(
                Actor::Anonymous,
                Action::ReadOrganization,
                Resource::Organization(org)
            )
            .allowed
        );
        assert!(
            !authorize(
                Actor::Account,
                Action::ReadChannel,
                Resource::Channel {
                    organization: org,
                    public: true
                }
            )
            .allowed
        );
    }
}
