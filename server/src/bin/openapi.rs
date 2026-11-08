use utoipa::OpenApi;

fn main() {
    println!(
        "{}",
        fukulow_server::openapi::ApiDoc::openapi()
            .to_pretty_json()
            .unwrap()
    );
}
