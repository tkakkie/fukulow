use super::*;

// Armed inside the mutation transaction, consumed only after confirmed COMMIT.
// Dropping uncertain/failed work leaves recovery to the shared O5 schedule.
pub(crate) struct DmPublication {
    activity: Activity,
    organization: Uuid,
    changes: Vec<(Uuid, Uuid, bool)>,
}
impl DmPublication {
    pub(crate) fn committed(self, pool: sqlx::PgPool) {
        let Ok(slot) = self.activity.capacity.clone().try_acquire_owned() else {
            return;
        };
        tokio::spawn(async move {
            let _slot = slot;
            let _ = tokio::time::timeout(
                Duration::from_secs(10),
                self.activity
                    .publish_dm(&pool, self.organization, &self.changes),
            )
            .await;
        });
    }
}
impl Activity {
    pub(crate) fn arm_dm(
        &self,
        organization: Uuid,
        changes: Vec<(Uuid, Uuid, bool)>,
    ) -> DmPublication {
        DmPublication {
            activity: self.clone(),
            organization,
            changes,
        }
    }

    pub(super) async fn publish_dm(
        &self,
        pool: &sqlx::PgPool,
        organization: Uuid,
        changes: &[(Uuid, Uuid, bool)],
    ) -> Result<(), sqlx::Error> {
        let mut by_member = HashMap::<Uuid, Vec<(Uuid, bool)>>::new();
        for &(channel, member, gained) in changes {
            by_member.entry(member).or_default().push((channel, gained));
        }
        let selected: Vec<_> = self
            .snapshot(organization)
            .into_iter()
            .flat_map(|(entry, epoch)| {
                by_member
                    .get(&entry.member.0)
                    .into_iter()
                    .flatten()
                    .map(move |&(channel, gained)| (entry.clone(), epoch, channel, gained))
            })
            .collect();
        let authorizations: Vec<_> = selected
            .iter()
            .map(|(entry, epoch, channel, _)| {
                Authorization::new(entry.clone(), *epoch, Some(*channel), false, None)
            })
            .collect();
        #[cfg(test)]
        for &(channel, _, _) in changes {
            test_pause(organization, channel, "dm_snapshot", None).await;
        }
        let batch = selected
            .iter()
            .map(|(entry, _, channel, _)| (entry.clone(), Some(*channel)))
            .collect::<Vec<_>>();
        #[cfg(test)]
        if let Some(&(channel, _, _)) = changes.first() {
            test_fault(organization, channel)?;
        }
        let proofs = authorize_batch(pool, &batch).await?;
        for (authorization, proof) in authorizations.iter().zip(&proofs) {
            authorization.proved(proof);
        }
        #[cfg(test)]
        for &(channel, _, _) in changes {
            test_pause(organization, channel, "dm_authorized", None).await;
        }
        for ((entry, epoch, channel, gained), proof) in selected.into_iter().zip(proofs) {
            let Some(proof) = proof else {
                continue;
            };
            for notice in std::iter::once(Notice::DmListChanged)
                .chain(gained.then_some(Notice::ChannelAccessGained {
                    channel_id: channel,
                }))
                .chain(
                    (proof.role == Role::Guest && changes.iter().any(|c| c.2))
                        .then_some(Notice::MembersChanged),
                )
            {
                enqueue(
                    &entry,
                    Pending {
                        notice,
                        channel: Some(channel),
                        epoch,
                        directory_epoch: None,
                        proof: Some(proof.clone()),
                    },
                );
            }
        }
        Ok(())
    }
}

pub(super) async fn peer_changes(
    tx: &mut sqlx::PgConnection,
    organization: Uuid,
    target: Uuid,
) -> Result<Vec<(Uuid, Uuid, bool)>, sqlx::Error> {
    sqlx::query_as("SELECT id, CASE WHEN lower_member_id=$2 THEN higher_member_id ELSE lower_member_id END, false FROM channels WHERE organization_id=$1 AND kind='dm' AND $2 IN(lower_member_id,higher_member_id)")
        .bind(organization).bind(target).fetch_all(tx).await
}

#[cfg(test)]
mod tests {
    use super::super::tests::{entry, pending};
    use super::*;

    #[test]
    fn dm_invalidations_coalesce_one_key_and_retain_every_contributing_grant() {
        let entry = entry();
        for channel in [Uuid::new_v4(), Uuid::new_v4()] {
            for _ in 0..5 {
                let mut p = pending(channel, None);
                p.notice = Notice::DmListChanged;
                enqueue(&entry, p);
            }
        }
        let b = entry.buffer.lock().unwrap();
        assert_eq!(b.pending.len(), 1);
        assert_eq!(b.proofs.len(), 2);
        assert_eq!(b.pending[0].notice.key(), (8, None, None));
    }
    #[test]
    fn dm_unbounded_provenance_retires_the_epoch_without_an_unproven_reset() {
        let entry = entry();
        for _ in 0..257 {
            let mut p = pending(Uuid::new_v4(), None);
            p.notice = Notice::DmListChanged;
            enqueue(&entry, p);
        }
        let b = entry.buffer.lock().unwrap();
        assert_eq!(b.epoch, 1);
        assert!(b.proofs.is_empty());
        assert!(b.pending.is_empty());
        assert!(!b.reset);
    }
}
