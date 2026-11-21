use super::*;

const PAGE_SQL: &str = include_str!("page.sql");

#[derive(Clone, Copy)]
pub struct D3rEngine;

impl D3rEngine {
    pub(super) async fn search(
        self,
        tx: &mut PgConnection,
        scopes: &[Uuid],
        request: EngineQuery<'_>,
    ) -> Result<CandidatePage, SearchError> {
        // Generic plans do not see the probe value when choosing the plan.
        sqlx::query("SET LOCAL plan_cache_mode = force_generic_plan")
            .execute(&mut *tx)
            .await?;
        let normalized: String = sqlx::query_scalar("SELECT public.fukulow_search_normalize($1)")
            .bind(request.raw)
            .fetch_one(&mut *tx)
            .await?;
        let tokens: Vec<_> = normalized.split_whitespace().collect();
        let longest = tokens
            .iter()
            .copied()
            .max_by_key(|token| token.chars().count())
            .filter(|token| token.chars().count() >= 2)
            .ok_or_else(query_too_short)?;
        let term: String = longest.chars().take(3).collect();

        let scope = cursor::Scope::new(
            request.organization,
            request.member,
            request.filter,
            &normalized,
        );
        let position = request
            .cursor
            .map(|token| scope.decode(request.secret, token))
            .transpose()?;
        let (range_start, before_at, before_id) = match position.as_ref() {
            Some(position) => (
                position.range_start.as_str(),
                position.created_at.as_str(),
                position.id,
            ),
            None => (request.range_start, "infinity", Uuid::max()),
        };

        let mut candidates: Vec<(Uuid, String)> = if scopes.is_empty() {
            Vec::new()
        } else {
            sqlx::query_as(PAGE_SQL)
                .bind(request.organization)
                .bind(scopes)
                .bind(term)
                .bind(tokens)
                .bind(range_start)
                .bind(before_at)
                .bind(before_id)
                .bind(request.page_size as i64)
                .fetch_all(tx)
                .await?
        };
        let next_cursor = if candidates.len() > request.page_size {
            candidates.pop();
            candidates
                .last()
                .map(|(id, created_at)| {
                    scope.encode(
                        request.secret,
                        &cursor::Position {
                            range_start: range_start.to_owned(),
                            created_at: created_at.clone(),
                            id: *id,
                        },
                    )
                })
                .transpose()?
        } else {
            None
        };
        Ok(CandidatePage {
            candidates,
            next_cursor,
            range_start: range_start.to_owned(),
        })
    }

    pub(super) async fn index_send(
        tx: &mut commit::Transaction,
        organization: Uuid,
        message: Uuid,
    ) -> Result<(), sqlx::Error> {
        Self::insert_terms(tx.connection()?, organization, &[message]).await
    }

    pub(super) fn index_move(_tx: &mut commit::Transaction, _event: &MessageMoveEvent) {
        // Move changes Topic and version in the same Channel. Neither is indexed.
    }

    pub(in crate::messages) async fn insert_terms(
        tx: &mut PgConnection,
        organization: Uuid,
        messages: &[Uuid],
    ) -> Result<(), sqlx::Error> {
        sqlx::query(
            "INSERT INTO message_search_terms (organization_id, channel_id, term, created_at, message_id)
             SELECT m.organization_id, m.channel_id, term, m.created_at, m.id
             FROM messages m CROSS JOIN LATERAL public.fukulow_search_terms(m.body) AS terms(term)
             WHERE m.organization_id=$1 AND m.id=ANY($2) AND NOT m.deleted",
        )
        .bind(organization)
        .bind(messages)
        .execute(tx)
        .await?;
        Ok(())
    }
}
