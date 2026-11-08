use utoipa::{
    Modify, OpenApi,
    openapi::security::{ApiKey, ApiKeyValue, Http, HttpAuthScheme, SecurityScheme},
};

#[derive(OpenApi)]
#[openapi(
    paths(crate::health, crate::auth::setup_status, crate::auth::setup, crate::auth::sign_in, crate::auth::sign_out, crate::auth::me),
    components(schemas(crate::auth::SetupStatus, crate::auth::SetupRequest, crate::auth::SignInRequest, crate::auth::Identity, crate::auth::Organization, crate::auth::Member, crate::auth::Role, crate::auth::SessionResponse, crate::auth::ErrorBody)),
    modifiers(&Security)
)]
pub struct ApiDoc;

struct Security;
impl Modify for Security {
    fn modify(&self, openapi: &mut utoipa::openapi::OpenApi) {
        let components = openapi.components.get_or_insert_with(Default::default);
        components.add_security_scheme(
            "bearer",
            SecurityScheme::Http(Http::new(HttpAuthScheme::Bearer)),
        );
        components.add_security_scheme(
            "cookie",
            SecurityScheme::ApiKey(ApiKey::Cookie(ApiKeyValue::new("fukulow_session"))),
        );
    }
}
