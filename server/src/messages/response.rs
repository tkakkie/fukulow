use axum::{
    Json,
    http::header,
    response::{IntoResponse, Response},
};

pub(super) fn no_store_json<T: serde::Serialize>(body: T) -> Response {
    ([(header::CACHE_CONTROL, "no-store")], Json(body)).into_response()
}
