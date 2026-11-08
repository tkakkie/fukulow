use utoipa::OpenApi;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    println!(
        "{}",
        fukulow_server::openapi::ApiDoc::openapi().to_pretty_json()?
    );
    Ok(())
}
