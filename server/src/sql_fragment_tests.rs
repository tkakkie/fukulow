use crate::{auth, channels, database};

#[test]
fn active_members_sql_is_pinned() {
    assert_eq!(
        auth::ACTIVE_MEMBERS_SQL,
        "SELECT id, membership_revision, role FROM users WHERE organization_id = $1 AND deactivated_at IS NULL"
    );
}

#[test]
fn current_member_sql_is_pinned() {
    let read = "SELECT id, membership_revision, role FROM users WHERE organization_id = $1 AND deactivated_at IS NULL AND id = $2 AND membership_revision = $3";
    assert_eq!(auth::current_member_sql(false), read);
    assert_eq!(auth::current_member_sql(true), format!("{read} FOR SHARE"));
}

#[test]
fn candidate_members_sql_is_pinned() {
    assert_eq!(
        auth::candidate_members_sql(),
        "SELECT id, membership_revision, role FROM users WHERE organization_id = $1 AND deactivated_at IS NULL AND id = ANY($3)"
    );
}

#[test]
fn candidate_member_sql_is_pinned() {
    assert_eq!(
        auth::candidate_member_sql("candidate.id", "candidate.revision"),
        "SELECT id, membership_revision, role FROM users WHERE organization_id = $1 AND deactivated_at IS NULL AND id = candidate.id AND membership_revision = candidate.revision"
    );
    assert_eq!(
        auth::candidate_member_sql("r.member_id", "r.revision"),
        "SELECT id, membership_revision, role FROM users WHERE organization_id = $1 AND deactivated_at IS NULL AND id = r.member_id AND membership_revision = r.revision"
    );
}

#[test]
fn notice_members_sql_is_pinned() {
    assert_eq!(
        auth::notice_members_sql(),
        "SELECT u.organization_id,u.id,u.role,u.membership_revision,s.token_hash FROM users u JOIN account_sessions s ON s.account_id=u.account_id WHERE u.deactivated_at IS NULL AND s.expires_at>clock_timestamp()"
    );
}

#[test]
fn channel_roles_sql_is_pinned() {
    assert_eq!(
        auth::authorization::channel_roles_sql(false),
        "'owner','admin','member'"
    );
    assert_eq!(
        auth::authorization::channel_roles_sql(true),
        "'owner','admin','member','guest'"
    );
}

#[test]
fn channel_manager_roles_sql_is_pinned() {
    assert_eq!(
        auth::authorization::channel_manager_roles_sql(false),
        "'owner','admin'"
    );
    assert_eq!(
        auth::authorization::channel_manager_roles_sql(true),
        "'owner','admin','member'"
    );
}

#[test]
fn active_scoped_members_sql_is_pinned() {
    assert_eq!(
        auth::members::ACTIVE_SCOPED_MEMBERS_SQL,
        "SELECT organization_id,id,name,role,membership_revision FROM users WHERE deactivated_at IS NULL"
    );
}

#[test]
fn retained_identities_sql_is_pinned() {
    assert_eq!(
        auth::members::RETAINED_IDENTITIES_SQL,
        "SELECT organization_id,id,name FROM users WHERE organization_id=$1"
    );
}

#[test]
fn member_revisions_sql_is_pinned() {
    assert_eq!(
        auth::members::MEMBER_REVISIONS_SQL,
        "SELECT organization_id,id,membership_revision FROM users"
    );
}

#[test]
fn generation_sql_is_pinned() {
    assert_eq!(
        auth::history::GENERATION_SQL,
        "SELECT history_generation FROM organizations WHERE organization_id=$1"
    );
}

#[test]
fn member_visibility_sql_is_pinned() {
    let prefix = "SELECT visible FROM (SELECT u.id, u.membership_revision, EXISTS (SELECT 1 FROM channels c \
         WHERE c.organization_id = $1 AND c.id = $4 \
         AND ((c.kind='channel' AND c.visibility = 'public' AND u.role IN ('owner','admin','member')) OR (u.role IN ('owner','admin','member','guest') AND EXISTS (SELECT 1 FROM channel_members cm \
    WHERE cm.organization_id = c.organization_id AND cm.channel_id = c.id \
    AND cm.member_id = u.id AND cm.membership_revision = u.membership_revision AND (c.kind='channel' OR u.id IN(c.lower_member_id,c.higher_member_id)))))) AS visible FROM (SELECT id, membership_revision, role FROM users WHERE organization_id = $1 AND deactivated_at IS NULL AND id = $2 AND membership_revision = $3";
    assert_eq!(
        channels::member_visibility_sql(false),
        format!("{prefix}) u) visibility")
    );
    assert_eq!(
        channels::member_visibility_sql(true),
        format!("{prefix} FOR SHARE) u) visibility")
    );
}

#[test]
fn organization_statement_sql_is_pinned() {
    assert_eq!(
        database::organization_statement_sql("SELECT $2::bigint"),
        "WITH fukulow_context AS MATERIALIZED (SELECT set_config('fukulow.organization_id', $1::uuid::text, true) AS id) \
         SELECT data.* FROM fukulow_context CROSS JOIN LATERAL (SELECT * FROM (SELECT $2::bigint) scoped WHERE fukulow_context.id IS NOT NULL OFFSET 0) data"
    );
}
