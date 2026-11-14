use super::*;

const PASSWORD: &str = "invite recovery test password";

async fn cookie_request(
    app: &Router,
    method: &str,
    path: &str,
    cookie: Option<&str>,
    input: Value,
) -> Response {
    let mut request = Request::builder()
        .method(method)
        .uri(path)
        .header(header::CONTENT_TYPE, "application/json")
        .extension(axum::extract::ConnectInfo(
            "192.0.2.30:1234".parse::<std::net::SocketAddr>().unwrap(),
        ));
    if let Some(cookie) = cookie {
        request = request.header(header::COOKIE, cookie);
    }
    app.clone()
        .oneshot(request.body(Body::from(input.to_string())).unwrap())
        .await
        .unwrap()
}

async fn counts(pool: &sqlx::PgPool) -> (i64, i64, i64, i64) {
    sqlx::query_as(
        "SELECT (SELECT count(*) FROM accounts), (SELECT count(*) FROM users), \
         (SELECT count(*) FROM invites WHERE accepted_at IS NOT NULL), \
         (SELECT count(*) FROM account_sessions)",
    )
    .fetch_one(pool)
    .await
    .unwrap()
}

async fn stale_cookie_recovery(pool: sqlx::PgPool, existing: bool) {
    let org = org(&pool).await;
    let other = org_fn(&pool).await;
    let (_, _, _, owner) = account(&pool, org, Role::Owner).await;
    for secure in [true, false] {
        let app = crate::app(AppState {
            cookie_secure: secure,
            ..AppState::for_test(pool.clone()).await
        });
        for stale in ["revoked", "expired", "unknown"] {
            let (id, _, account_email, token) = account(&pool, other, Role::Member).await;
            let hash = Sha256::digest(token.as_bytes()).to_vec();
            if stale == "expired" {
                sqlx::query("UPDATE account_sessions SET expires_at=now()-interval '1 second' WHERE token_hash=$1")
                    .bind(&hash).execute(&pool).await.unwrap();
            } else {
                if stale == "revoked" {
                    let response =
                        req(&app, "DELETE", "/api/v1/session", Some(&token), Value::Null).await;
                    assert_eq!(response.status(), StatusCode::NO_CONTENT);
                } else {
                    sqlx::query("DELETE FROM account_sessions WHERE token_hash=$1")
                        .bind(&hash)
                        .execute(&pool)
                        .await
                        .unwrap();
                }
            }
            let token = if stale == "unknown" {
                "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
            } else {
                &token
            };
            let cookie = format!("{}={token}", cookie_name(secure));
            let email = if existing {
                account_email
            } else {
                format!("{}@unused.invalid", Uuid::new_v4())
            };
            let invitation = invite(&app, org, &owner, &email, Role::Member).await;
            let path = format!("/api/v1/orgs/{org}/invites/accept");
            let mut input = accept_input(&invitation, &email);
            input["password"] = json!(PASSWORD);
            let before = counts(&pool).await;
            let response = cookie_request(&app, "POST", &path, Some(&cookie), input.clone()).await;
            assert_eq!(
                response.status(),
                StatusCode::UNAUTHORIZED,
                "{stale}, secure={secure}"
            );
            assert_eq!(body(response).await, json!({"error":"invalid credentials"}));
            assert_eq!(counts(&pool).await, before);

            let response = cookie_request(
                &app,
                "DELETE",
                "/api/v1/session",
                Some(&cookie),
                Value::Null,
            )
            .await;
            assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
            let cookies: Vec<_> = response
                .headers()
                .get_all(header::SET_COOKIE)
                .iter()
                .map(|value| value.to_str().unwrap())
                .collect();
            let current = format!(
                "{}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0{}",
                cookie_name(secure),
                if secure { "; Secure" } else { "" }
            );
            assert_eq!(cookies[0], current);
            if secure {
                assert_eq!(cookies.len(), 2);
                assert_eq!(
                    cookies[1],
                    "fukulow_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0; Secure"
                );
            } else {
                assert_eq!(cookies.len(), 1);
            }
            assert_eq!(body(response).await, json!({"error":"invalid credentials"}));
            assert_eq!(counts(&pool).await, before);
            assert_eq!(
                req(&app, "GET", "/api/v1/me", Some(&owner), Value::Null)
                    .await
                    .status(),
                StatusCode::OK
            );

            // Apply the expired cookie by omitting it; only an explicit later submit accepts.
            let response = cookie_request(&app, "POST", &path, None, input.clone()).await;
            if existing {
                assert_eq!(response.status(), StatusCode::CONFLICT);
                assert_eq!(
                    body(response).await,
                    json!({"error":"invite_sign_in_required"})
                );
                assert_eq!(counts(&pool).await, before);
                let password_hash = hash_password(PASSWORD.into(), &PASSWORD_WORKERS)
                    .await
                    .unwrap();
                sqlx::query("UPDATE accounts SET password_hash=$1 WHERE id=$2")
                    .bind(password_hash)
                    .bind(id)
                    .execute(&pool)
                    .await
                    .unwrap();
                let response = cookie_request(
                    &app,
                    "POST",
                    "/api/v1/session",
                    None,
                    json!({"email":email,"password":PASSWORD}),
                )
                .await;
                assert_eq!(response.status(), StatusCode::OK);
                let fresh_cookie = response.headers()[header::SET_COOKIE]
                    .to_str()
                    .unwrap()
                    .split(';')
                    .next()
                    .unwrap()
                    .to_owned();
                input.as_object_mut().unwrap().remove("password");
                let response =
                    cookie_request(&app, "POST", &path, Some(&fresh_cookie), input).await;
                assert_eq!(response.status(), StatusCode::OK);
                assert_eq!(
                    body(response).await["organization"]["organization_id"],
                    org.to_string()
                );
                let after = counts(&pool).await;
                assert_eq!(
                    (after.0, after.1, after.2),
                    (before.0, before.1 + 1, before.2 + 1)
                );
            } else {
                assert_eq!(response.status(), StatusCode::OK);
                assert_eq!(body(response).await["member"]["name"], "Accepted");
                let after = counts(&pool).await;
                assert_eq!(after, (before.0 + 1, before.1 + 1, before.2 + 1, before.3));
            }
        }
    }
}

#[sqlx::test]
async fn stale_cookie_sign_out_expires_configured_and_legacy_cookies_before_anonymous_acceptance(
    pool: sqlx::PgPool,
) {
    stale_cookie_recovery(pool, false).await;
}

#[sqlx::test]
async fn stale_cookie_recovery_keeps_existing_account_sign_in_required_until_matching_sign_in(
    pool: sqlx::PgPool,
) {
    stale_cookie_recovery(pool, true).await;
}
