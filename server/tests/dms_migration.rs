#![cfg(test)]

use serde_json::Value;
use sqlx::{Executor, PgPool};
use uuid::Uuid;

async fn snapshot(pool: &PgPool) -> Value {
    sqlx::query_scalar("SELECT jsonb_build_array((SELECT jsonb_agg(to_jsonb(c) ORDER BY id) FROM channels c),(SELECT jsonb_agg(to_jsonb(g) ORDER BY channel_id,member_id) FROM channel_members g),(SELECT jsonb_agg(to_jsonb(p) ORDER BY channel_id,member_id) FROM channel_read_positions p),(SELECT jsonb_agg(to_jsonb(m) ORDER BY channel_id,seq) FROM messages m),(SELECT jsonb_agg(to_jsonb(s) ORDER BY channel_id) FROM channel_message_sequences s))").fetch_one(pool).await.unwrap()
}

#[sqlx::test(migrations = false)]
async fn existing_channels_grants_messages_and_unread_survive_dm_migration(pool: PgPool) {
    let migrator = sqlx::migrate::Migrator::new(std::path::Path::new(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/migrations"
    )))
    .await
    .unwrap();
    for migration in migrator.iter().filter(|m| m.version != 202611140370) {
        pool.execute(migration.sql.as_ref()).await.unwrap();
    }
    let org = Uuid::new_v4();
    let a = Uuid::new_v4();
    let b = Uuid::new_v4();
    let c = Uuid::new_v4();
    sqlx::query("INSERT INTO organizations(organization_id,name) VALUES($1,'Existing')")
        .bind(org)
        .execute(&pool)
        .await
        .unwrap();
    for (id, role) in [(a, "admin"), (b, "member")] {
        sqlx::query("INSERT INTO accounts(id,email,password_hash) VALUES($1,$2,'unused')")
            .bind(id)
            .bind(format!("{id}@example.com"))
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO users(organization_id,id,account_id,name,role) VALUES($1,$2,$2,'Kept',$3)",
        )
        .bind(org)
        .bind(id)
        .bind(role)
        .execute(&pool)
        .await
        .unwrap();
    }
    sqlx::query("INSERT INTO channels(organization_id,id,name,visibility) VALUES($1,$2,'Keep NAME','private')").bind(org).bind(c).execute(&pool).await.unwrap();
    for id in [a, b] {
        sqlx::query("INSERT INTO channel_members(organization_id,channel_id,member_id,manager) VALUES($1,$2,$3,$4)").bind(org).bind(c).bind(id).bind(id==a).execute(&pool).await.unwrap();
    }
    sqlx::query(
        "INSERT INTO channel_message_sequences(organization_id,channel_id,seq) VALUES($1,$2,3)",
    )
    .bind(org)
    .bind(c)
    .execute(&pool)
    .await
    .unwrap();
    for seq in 1..=3 {
        sqlx::query("INSERT INTO messages(organization_id,id,channel_id,seq,sender,client_message_id,body) VALUES($1,$2,$3,$4,$5,$6,'kept body')").bind(org).bind(Uuid::new_v4()).bind(c).bind(seq).bind(a).bind(Uuid::new_v4()).execute(&pool).await.unwrap();
    }
    sqlx::query(
        "UPDATE channel_read_positions SET read_seq=2 WHERE organization_id=$1 AND member_id=$2",
    )
    .bind(org)
    .bind(b)
    .execute(&pool)
    .await
    .unwrap();
    let before = snapshot(&pool).await;
    pool.execute(include_str!(
        "../migrations/202611140370_direct_messages.sql"
    ))
    .await
    .unwrap();
    let mut after = snapshot(&pool).await;
    for channel in after[0].as_array_mut().unwrap() {
        assert_eq!(channel["kind"], "channel");
        for key in ["kind", "lower_member_id", "higher_member_id", "created_at"] {
            channel.as_object_mut().unwrap().remove(key);
        }
    }
    for grant in after[1].as_array_mut().unwrap() {
        assert!(grant["dm_created_at"].is_null());
        grant.as_object_mut().unwrap().remove("dm_created_at");
    }
    assert_eq!(before, after);
    let duplicate=sqlx::query("INSERT INTO channels(organization_id,id,name,visibility) VALUES($1,$2,'keep name','public')").bind(org).bind(Uuid::new_v4()).execute(&pool).await.unwrap_err();
    assert!(duplicate.as_database_error().unwrap().is_unique_violation());
    let dm = Uuid::new_v4();
    let mut pair = [a, b];
    pair.sort();
    sqlx::query("INSERT INTO channels(organization_id,id,kind,lower_member_id,higher_member_id) VALUES($1,$2,'dm',$3,$4)").bind(org).bind(dm).bind(pair[0]).bind(pair[1]).execute(&pool).await.unwrap();
    for (name, visibility) in [(Some("Named"), None), (None, Some("private"))] {
        let r = sqlx::query(
            "UPDATE channels SET name=$3,visibility=$4 WHERE organization_id=$1 AND id=$2",
        )
        .bind(org)
        .bind(dm)
        .bind(name)
        .bind(visibility)
        .execute(&pool)
        .await;
        assert!(r.is_err());
    }
    assert!(sqlx::query("INSERT INTO channel_members(organization_id,channel_id,member_id,manager) VALUES($1,$2,$3,true)").bind(org).bind(dm).bind(a).execute(&pool).await.is_err());
    assert!(sqlx::query("UPDATE channels SET created_at=created_at+interval '1 second' WHERE organization_id=$1 AND id=$2").bind(org).bind(dm).execute(&pool).await.is_err());
}
