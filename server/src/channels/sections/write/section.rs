use super::*;

pub(super) async fn create(
    tx: &mut PgConnection,
    owner: Owner,
    input: CreateSection,
) -> Result<Change, ApiError> {
    let original: Option<String> = sqlx::query_scalar(
        "SELECT original_name FROM member_sections WHERE organization_id=$1 AND member_id=$2 AND id=$3",
    )
    .bind(owner.org).bind(owner.member).bind(input.id).fetch_optional(&mut *tx).await?;
    if let Some(original) = original {
        if original != input.name {
            return Err(ApiError(StatusCode::CONFLICT, "section_id_conflict", None));
        }
        let generation = owner.generation(tx).await?;
        return Ok(Change::Unchanged(created_section(
            StatusCode::OK,
            input.id,
            generation,
        )));
    }
    let reserved: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM member_section_ids WHERE organization_id=$1 AND member_id=$2 AND id=$3)",
    )
    .bind(owner.org).bind(owner.member).bind(input.id).fetch_one(&mut *tx).await?;
    if reserved {
        return Err(ApiError(StatusCode::CONFLICT, "section_deleted", None));
    }

    let inserted = sqlx::query(
        "INSERT INTO member_sections (organization_id,member_id,id,name,position)
         SELECT $1,$2,$3,$4,COALESCE(max(position)+1,0) FROM member_sections
         WHERE organization_id=$1 AND member_id=$2 HAVING count(*) < $5",
    )
    .bind(owner.org)
    .bind(owner.member)
    .bind(input.id)
    .bind(input.name)
    .bind(MAX_SECTIONS as i64)
    .execute(tx)
    .await?;
    if inserted.rows_affected() == 0 {
        return Err(ApiError(StatusCode::CONFLICT, "section_limit", None));
    }
    Ok(Change::Created(input.id))
}

pub(super) async fn rename(
    tx: &mut PgConnection,
    owner: Owner,
    id: Uuid,
    input: RenameSection,
) -> Result<Change, ApiError> {
    if read::section_name(tx, owner, id).await? == input.name {
        return Ok(unchanged());
    }
    sqlx::query(
        "UPDATE member_sections SET name=$4 WHERE organization_id=$1 AND member_id=$2 AND id=$3",
    )
    .bind(owner.org)
    .bind(owner.member)
    .bind(id)
    .bind(input.name)
    .execute(tx)
    .await?;
    Ok(Change::Layout)
}

pub(super) async fn delete(
    tx: &mut PgConnection,
    owner: Owner,
    id: Uuid,
) -> Result<Change, ApiError> {
    let deleted = sqlx::query(
        "DELETE FROM member_sections WHERE organization_id=$1 AND member_id=$2 AND id=$3",
    )
    .bind(owner.org)
    .bind(owner.member)
    .bind(id)
    .execute(tx)
    .await?;
    Ok(if deleted.rows_affected() == 0 {
        unchanged()
    } else {
        Change::Layout
    })
}
