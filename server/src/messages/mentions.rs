use super::*;
use std::collections::BTreeSet;

#[derive(Clone, Debug, Serialize, Deserialize, ToSchema, PartialEq, Eq)]
pub struct Mention {
    pub member_id: Uuid,
    /// Current retained Member name in this authorized Message snapshot.
    pub name: String,
}

pub(super) fn extract(body: &str) -> Vec<Uuid> {
    let mut ids = BTreeSet::new();
    let bytes = body.as_bytes();
    for (start, _) in body.match_indices("@{member:") {
        let start = start + 9;
        let Some(token) = bytes.get(start..start + 37) else {
            continue;
        };
        if token[36] != b'}'
            || !token[..36].iter().enumerate().all(|(i, byte)| {
                if [8, 13, 18, 23].contains(&i) {
                    *byte == b'-'
                } else {
                    byte.is_ascii_digit() || (b'a'..=b'f').contains(byte)
                }
            })
        {
            continue;
        }
        if let Ok(id) = Uuid::try_parse_ascii(&token[..36]) {
            ids.insert(id);
        }
    }
    ids.into_iter().collect()
}

// Resolve only persisted ids, in one set-based query over the bounded page.
// Keeping this inside the page statement also protects single-statement replay
// and its authorization snapshot. The caller supplies the final page ordering.
pub(super) fn page_sql(page: &str, order: &str) -> String {
    format!(
        "WITH mention_page AS MATERIALIZED ({page}), mention_sets AS (\
         SELECT mm.message_id, jsonb_agg(jsonb_build_object('member_id',mm.member_id,'name',u.name) ORDER BY mm.member_id) AS mentions \
         FROM mention_page p JOIN message_mentions mm ON mm.organization_id=$1 AND mm.channel_id=p.channel_id AND mm.message_id=p.id \
         JOIN ({}) u ON u.organization_id=mm.organization_id AND u.id=mm.member_id \
         GROUP BY mm.message_id) \
         SELECT p.*, COALESCE(ms.mentions,'[]'::jsonb)::text AS mentions \
         FROM mention_page p LEFT JOIN mention_sets ms ON ms.message_id=p.id ORDER BY {order}",
        crate::auth::members::RETAINED_IDENTITIES_SQL
    )
}

pub(super) async fn store(
    tx: &mut sqlx::PgConnection,
    organization: Uuid,
    message: &mut Message,
    targets: &[Uuid],
) -> Result<(), sqlx::Error> {
    sqlx::query("INSERT INTO message_mentions (organization_id,channel_id,message_id,member_id) SELECT $1,$2,$3,unnest($4::uuid[])")
        .bind(organization).bind(message.channel_id).bind(message.id).bind(targets)
        .execute(&mut *tx).await?;
    let identities = crate::auth::members::display_identities(tx, organization, targets).await?;
    message.mentions = identities
        .into_iter()
        .map(|identity| Mention {
            member_id: identity.id,
            name: identity.name,
        })
        .collect();
    Ok(())
}

pub(super) async fn delivery_snapshot(
    pool: &sqlx::PgPool,
    organization: Uuid,
    members: &[(Uuid, i64)],
    messages: &[Message],
) -> Result<(Vec<(Uuid, i64, bool)>, Vec<Message>), sqlx::Error> {
    let mut messages = messages.to_vec();
    let channel = messages.first().ok_or(sqlx::Error::RowNotFound)?.channel_id;
    if messages.iter().all(|m| m.mentions.is_empty()) {
        return Ok((
            channels::member_access(pool, organization, channel, members).await?,
            messages,
        ));
    }
    crate::database::organization_read_only(
        pool,
        organization,
        async |tx: &mut sqlx::PgConnection| {
            let allowed = channels::member_access_in(tx, organization, channel, members).await?;
            let ids: Vec<_> = messages
                .iter()
                .flat_map(|m| m.mentions.iter().map(|m| m.member_id))
                .collect::<BTreeSet<_>>()
                .into_iter()
                .collect();
            let identities =
                crate::auth::members::display_identities(tx, organization, &ids).await?;
            let names: std::collections::HashMap<_, _> =
                identities.into_iter().map(|i| (i.id, i.name)).collect();
            for message in &mut messages {
                for mention in &mut message.mentions {
                    mention.name = names
                        .get(&mention.member_id)
                        .ok_or(sqlx::Error::RowNotFound)?
                        .clone();
                }
            }
            Ok((allowed, messages))
        },
    )
    .await
}
