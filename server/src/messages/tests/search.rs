use super::super::search::{SearchEngine, SearchQuery, d3r::D3rEngine, search};
use super::*;
use crate::test_support::TestPools;
use axum::Extension;

mod denials;
mod maintenance;
mod paging;

struct Fixture {
    pools: TestPools,
    app: Router,
    org: Uuid,
    author: Uuid,
    public: Uuid,
    token: String,
    seed_time: String,
}

impl Fixture {
    async fn new(pool: PgPool) -> Self {
        let pools = TestPools::new(pool).await;
        let org = organization(&pools.admin).await;
        let author = Uuid::new_v4();
        let token = member(&pools.admin, org, author).await;
        let public = Uuid::new_v4();
        channel(&pools.admin, org, public, author, false).await;
        let app = crate::app_with_search(
            AppState::with_test_pool(pools.app.clone()),
            SearchEngine::configured(Some("d3r")).unwrap(),
        );
        let seed_time = sqlx::query_scalar("SELECT now()::text")
            .fetch_one(&pools.admin)
            .await
            .unwrap();
        Self {
            pools,
            app,
            org,
            author,
            public,
            token,
            seed_time,
        }
    }

    async fn channel(&self, private: bool) -> Uuid {
        let id = Uuid::new_v4();
        channel(&self.pools.admin, self.org, id, self.author, private).await;
        id
    }

    async fn post(&self, channel: Uuid, text: &str) -> Value {
        sent(&self.app, &self.token, channel, input(Uuid::new_v4(), text)).await
    }
}

async fn get(
    app: &Router,
    org: Uuid,
    token: &str,
    q: Option<&str>,
    channel: Option<Uuid>,
    cursor: Option<&str>,
) -> Response {
    let mut uri = format!("/api/v1/orgs/{org}/search?");
    if let Some(q) = q {
        uri.push_str("q=");
        uri.extend(q.bytes().map(|byte| format!("%{byte:02X}")));
    }
    if let Some(channel) = channel {
        uri.push_str(&format!("&channel_id={channel}"));
    }
    if let Some(cursor) = cursor {
        uri.push_str(&format!("&cursor={cursor}"));
    }
    request(app, "GET", &uri, token, Value::Null).await
}

async fn page(
    f: &Fixture,
    token: &str,
    q: &str,
    channel: Option<Uuid>,
    cursor: Option<&str>,
) -> Value {
    let response = get(&f.app, f.org, token, Some(q), channel, cursor).await;
    assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
    let status = response.status();
    let value = body(response).await;
    assert_eq!(status, StatusCode::OK, "{value}");
    assert_eq!(value["range_days"], 180);
    value
}

async fn error(response: Response, status: StatusCode, code: &str) {
    assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
    assert_eq!(response.status(), status);
    assert_eq!(body(response).await, json!({"error":code}));
}

fn ids(page: &Value) -> Vec<Uuid> {
    page["hits"]
        .as_array()
        .unwrap()
        .iter()
        .map(|hit| {
            assert_eq!(hit["message"]["deleted"], false);
            id(&hit["message"])
        })
        .collect()
}

fn id(message: &Value) -> Uuid {
    serde_json::from_value(message["id"].clone()).unwrap()
}

async fn bulk(
    f: &Fixture,
    channel: Uuid,
    seqs: std::ops::RangeInclusive<i64>,
    text: &str,
    age: &str,
    deleted: bool,
) {
    crate::database::organization(&f.pools.app, f.org, async |tx: &mut sqlx::PgConnection| {
        let messages = sqlx::query_scalar(
            "INSERT INTO messages (organization_id, channel_id, sender, seq, id, client_message_id, body, created_at, deleted)
             SELECT $1, $2, $3, n, gen_random_uuid(), gen_random_uuid(), $6, $9::text::timestamptz - $7::text::interval, $8
             FROM generate_series($4::bigint,$5::bigint) n
             RETURNING id",
        )
        .bind(f.org)
        .bind(channel)
        .bind(f.author)
        .bind(seqs.start())
        .bind(seqs.end())
        .bind(text)
        .bind(age)
        .bind(deleted)
        .bind(&f.seed_time)
        .fetch_all(&mut *tx)
        .await?;
        D3rEngine::insert_terms(tx, f.org, &messages).await
    })
    .await
    .unwrap();
}

#[fukulow_test::test]
async fn search_matches_unicode_and_literal_tokens_with_and_semantics(pool: PgPool) {
    let f = Fixture::new(pool).await;
    for (stored, matching, omitted) in [
        ("the ＡＢＣ app", "ABC", "abd"),
        ("the ｱﾌﾟﾘ", "アプリ", "あぷり"),
        ("Straße", "STRASSE", "strase"),
        ("ΣΊΣΥΦΟΣ", "σίσυφος", "σιςυφοσ"),
        ("RE\u{301}SUME\u{301}", "résumé", "resume"),
        ("CAFÉ", "cafe\u{301}", "cafe"),
        ("a\u{0345}\u{0300}b", "a\u{1f76}b", "ai\u{0300}b"),
        ("foo\u{200b}b\u{ad}ar\u{E0100}", "foobar", "foo barz"),
        ("abc%b", "abc%b", "abcxb"),
        ("def_y", "def_y", "defzy"),
        ("ghi\\z", "ghi\\z", "ghiz"),
    ] {
        let stored_message = f.post(f.public, stored).await;
        let omitted_message = f.post(f.public, omitted).await;
        let matched = page(&f, &f.token, matching, None, None).await;
        assert_eq!(ids(&matched), [id(&stored_message)]);
        assert_eq!(matched["hits"][0]["message"]["body"], stored);
        assert_eq!(
            ids(&page(&f, &f.token, omitted, None, None).await),
            [id(&omitted_message)]
        );
    }

    let and_scope = f.channel(false).await;
    let yes = id(&f.post(and_scope, "犬 travels to Kyoto").await);
    let no_dog = id(&f.post(and_scope, "travel to Kyoto").await);
    f.post(and_scope, "犬 goes to Osaka").await;
    assert_eq!(
        ids(&page(
            &f,
            &f.token,
            "Ｋｙｏｔｏ\u{3000}TRAVEL",
            Some(and_scope),
            None
        )
        .await),
        [no_dog, yes]
    );
    assert_eq!(
        ids(&page(
            &f,
            &f.token,
            "Kyoto\u{3000}  犬 travel",
            Some(and_scope),
            None
        )
        .await),
        [yes]
    );
}

#[fukulow_test::test]
async fn search_requires_a_two_scalar_token_and_limits_trimmed_raw_query_without_binding_null(
    pool: PgPool,
) {
    let f = Fixture::new(pool).await;
    for query in [
        None,
        Some(""),
        Some(" \t\u{85}\u{3000}"),
        Some("界"),
        Some("e\u{301}"),
        Some("a b 犬"),
        Some("\u{200b}\u{ad}"),
    ] {
        error(
            get(&f.app, f.org, &f.token, query, None, None).await,
            StatusCode::BAD_REQUEST,
            "search_query_too_short",
        )
        .await;
    }
    for query in ["界".repeat(257), "\u{200b}".repeat(257)] {
        error(
            get(&f.app, f.org, &f.token, Some(&query), None, None).await,
            StatusCode::BAD_REQUEST,
            "search_query_too_long",
        )
        .await;
    }
    error(
        get(&f.app, f.org, &f.token, Some("nul\0text"), None, None).await,
        StatusCode::BAD_REQUEST,
        "invalid input",
    )
    .await;
    let maximum = "界".repeat(256);
    let long = f.post(f.public, &maximum).await;
    assert_eq!(
        ids(&page(&f, &f.token, &maximum, None, None).await),
        [id(&long)]
    );
    assert_eq!(
        ids(&page(&f, &f.token, "界界", None, None).await),
        [id(&long)]
    );
    let expanding = f.post(f.public, &"ss".repeat(256)).await;
    assert_eq!(
        ids(&page(
            &f,
            &f.token,
            &format!(" \t{} \n", "ß".repeat(256)),
            None,
            None
        )
        .await),
        [id(&expanding)]
    );
    let folded_scope = f.channel(false).await;
    let folded = f.post(folded_scope, "ss").await;
    assert_eq!(
        ids(&page(&f, &f.token, "ß", Some(folded_scope), None).await),
        [id(&folded)]
    );
}

#[fukulow_test::test]
async fn search_disabled_by_default_returns_unavailable(pool: PgPool) {
    let f = Fixture::new(pool).await;
    let off = crate::app(AppState::with_test_pool(f.pools.app.clone()));
    let message = sent(
        &off,
        &f.token,
        f.public,
        input(Uuid::new_v4(), "searchable"),
    )
    .await;
    error(
        get(&off, f.org, &f.token, Some("searchable"), None, None).await,
        StatusCode::SERVICE_UNAVAILABLE,
        "search_unavailable",
    )
    .await;
    error(
        get(&f.app, f.org, "", Some("searchable"), None, None).await,
        StatusCode::UNAUTHORIZED,
        "invalid credentials",
    )
    .await;
    assert_eq!(
        ids(&page(&f, &f.token, "searchable", None, None).await),
        [id(&message)]
    );
}
