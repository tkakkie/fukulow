#[cfg(test)]
use super::test_hooks::test_pause;
use super::{
    Activity, Entry,
    buffer::{InFlight, Proof, QueryToken},
    notice_budget::{NoticePermit, notice_query_slot},
};
use crate::{
    auth::{self, Role},
    lock_ignoring_poison,
    observability::notice_permits::NoticeCaller,
};
use std::{collections::HashSet, sync::Arc};
use uuid::Uuid;

pub(super) struct Authorization {
    entry: Arc<Entry>,
    epoch: u64,
    directory_epoch: Option<u64>,
    id: Uuid,
    valid: Arc<QueryToken>,
}
impl Authorization {
    pub(super) fn directory_epoch(&self) -> Option<u64> {
        self.directory_epoch
    }
    pub(super) fn valid(&self) -> &Arc<QueryToken> {
        &self.valid
    }
    pub(super) fn new(
        entry: Arc<Entry>,
        epoch: u64,
        channel: Option<Uuid>,
        directory: bool,
        expected_directory_epoch: Option<u64>,
    ) -> Self {
        let id = Uuid::new_v4();
        let valid = Arc::new(QueryToken::new());
        let directory_epoch = {
            let mut b = lock_ignoring_poison(&entry.buffer);
            let directory_epoch =
                directory.then_some(expected_directory_epoch.unwrap_or(b.directory_epoch));
            if epoch == b.epoch {
                b.in_flight.insert(
                    id,
                    InFlight {
                        channel,
                        proof: None,
                        valid: valid.clone(),
                    },
                );
            }
            directory_epoch
        };
        Self {
            entry,
            epoch,
            directory_epoch,
            id,
            valid,
        }
    }
    pub(super) fn proved(&self, proof: &Option<Proof>) {
        let mut b = lock_ignoring_poison(&self.entry.buffer);
        if self.epoch == b.epoch
            && (proof.as_ref().is_none_or(|proof| proof.role != Role::Guest)
                || self
                    .directory_epoch
                    .is_none_or(|epoch| b.directory_epoch == epoch))
            && let Some(captured) = b.in_flight.get_mut(&self.id)
        {
            captured.proof = proof.clone();
        }
    }
}
impl Drop for Authorization {
    fn drop(&mut self) {
        lock_ignoring_poison(&self.entry.buffer)
            .in_flight
            .remove(&self.id);
    }
}

pub(super) async fn directory_guests(
    pool: &sqlx::PgPool,
    organization: Uuid,
    entries: &[Arc<Entry>],
    channels: &[Uuid],
) -> Result<HashSet<Uuid>, sqlx::Error> {
    let guests: Vec<_> = entries.iter().map(|entry| entry.member.0).collect();
    let sql = format!(
        "SELECT DISTINCT cm.member_id FROM channel_members cm \
         JOIN ({}) u ON u.organization_id=cm.organization_id AND u.id=cm.member_id \
         AND u.membership_revision=cm.membership_revision \
         JOIN channels c ON c.organization_id=cm.organization_id AND c.id=cm.channel_id \
         WHERE cm.organization_id=$1 AND cm.channel_id=ANY($2) AND cm.member_id=ANY($3) \
         AND u.role=$4",
        auth::members::ACTIVE_SCOPED_MEMBERS_SQL
    );
    let rows: Vec<Uuid> = crate::database::organization_statement(
        pool,
        &sql,
        async |tx: &mut sqlx::PgConnection, sql: &str| {
            sqlx::query_scalar(sql)
                .bind(organization)
                .bind(channels)
                .bind(guests)
                .bind(Role::Guest)
                .fetch_all(tx)
                .await
        },
    )
    .await?;
    Ok(rows.into_iter().collect())
}
pub(super) async fn authorize_batch(
    pool: &sqlx::PgPool,
    selected: &[(Arc<Entry>, Option<Uuid>)],
    permit: Option<&NoticePermit<'_>>,
) -> Result<Vec<Option<Proof>>, sqlx::Error> {
    let entries: Vec<_> = selected.iter().map(|(entry, _)| entry.clone()).collect();
    let Some(first) = entries.first() else {
        return Ok(Vec::new());
    };
    let public_roles = auth::authorization::channel_roles_sql(false);
    let explicit_roles = auth::authorization::channel_roles_sql(true);
    // Keep generic plans correlated to supplied Session keys rather than
    // materializing unrelated Sessions before matching the notice recipients.
    let sql = format!("SELECT u.role, CASE WHEN c.visibility='public' AND u.role IN ({public_roles}) THEN NULL ELSE cm.grant_id END AS grant_id, r.n
        FROM unnest($2::uuid[], $3::bigint[], $4::bytea[], $5::uuid[]) WITH ORDINALITY r(member_id,revision,hash,channel,n)
        LEFT JOIN LATERAL (SELECT * FROM ({}) candidate WHERE candidate.organization_id=$1 AND candidate.id=r.member_id AND candidate.membership_revision=r.revision AND candidate.token_hash=r.hash OFFSET 0) u ON true
        LEFT JOIN channels c ON c.organization_id=$1 AND c.id=r.channel
        LEFT JOIN channel_members cm ON cm.organization_id=$1 AND cm.channel_id=c.id AND cm.member_id=u.id AND cm.membership_revision=u.membership_revision
        WHERE r.channel IS NULL OR ((c.kind='channel' AND c.visibility='public' AND u.role IN ({public_roles})) OR (u.role IN ({explicit_roles}) AND cm.grant_id IS NOT NULL AND (c.kind='channel' OR u.id IN(c.lower_member_id,c.higher_member_id)))) ORDER BY r.n", auth::notice_members_sql());
    let rows: Vec<(Option<Role>, Option<Uuid>, i64)> = crate::database::organization_statement(
        pool,
        &sql,
        async |tx: &mut sqlx::PgConnection, sql: &str| {
            let _checkout = permit.and_then(NoticePermit::checkout);
            #[cfg(test)]
            test_pause(
                first.organization,
                selected[0]
                    .1
                    .or_else(|| selected.get(1).and_then(|row| row.1))
                    .unwrap_or(Uuid::nil()),
                "notice_statement",
                Some(first.member.0),
            )
            .await;
            sqlx::query_as(sql)
                .bind(first.organization)
                .bind(entries.iter().map(|e| e.member.0).collect::<Vec<_>>())
                .bind(entries.iter().map(|e| e.member.1).collect::<Vec<_>>())
                .bind(entries.iter().map(|e| e.hash.clone()).collect::<Vec<_>>())
                .bind(
                    selected
                        .iter()
                        .map(|(_, channel)| *channel)
                        .collect::<Vec<_>>(),
                )
                .fetch_all(tx)
                .await
        },
    )
    .await?;
    let mut result = vec![None; entries.len()];
    for (role, grant, index) in rows {
        if let Some(role) = role {
            result[(index - 1) as usize] = Some(Proof { role, grant });
        }
    }
    Ok(result)
}

impl Activity {
    pub(super) async fn authorize(
        &self,
        pool: &sqlx::PgPool,
        selected: &[(Arc<Entry>, Option<Uuid>)],
        caller: NoticeCaller,
    ) -> Result<Vec<Option<Proof>>, sqlx::Error> {
        if selected.is_empty() {
            return Ok(Vec::new());
        }
        let slot = notice_query_slot(&self.notice_queries, pool, caller).await?;
        authorize_batch(pool, selected, Some(&slot)).await
    }
}
