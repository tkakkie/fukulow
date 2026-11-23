use rand::{TryRng, rngs::SysRng};
use std::{
    fs::{self, OpenOptions, Permissions},
    io::{self, Write},
    os::unix::fs::{OpenOptionsExt, PermissionsExt},
};

const USAGE: &str = "Usage: fukulow-server init --version TAG@sha256:DIGEST [--domain HOST] [--proxy caddy|nginx|none]";
const VERSION_ERROR: &str = "Pass --version to the release's FUKULOW_VERSION (TAG@sha256: followed by 64 lowercase hex digits)";

pub(super) fn execute(args: &[String]) -> Result<(), &'static str> {
    let (pairs, remaining) = args.as_chunks::<2>();
    if !remaining.is_empty() {
        return Err(USAGE);
    }
    let (mut version, mut domain, mut proxy) = (None, None, None);
    for [flag, value] in pairs {
        let slot = match flag.as_str() {
            "--version" => &mut version,
            "--domain" => &mut domain,
            "--proxy" => &mut proxy,
            _ => return Err(USAGE),
        };
        if slot.replace(value.as_str()).is_some() {
            return Err(USAGE);
        }
    }
    let version = version
        .filter(|value| pinned_version(value))
        .ok_or(VERSION_ERROR)?;
    let domain = domain.unwrap_or("localhost");
    if !valid_domain(domain) {
        return Err("Pass --domain to a DNS hostname such as chat.example.com");
    }
    let proxy = proxy.unwrap_or("caddy");
    if !matches!(proxy, "caddy" | "nginx" | "none") {
        return Err("Pass --proxy to caddy, nginx or none");
    }

    let setup_token = random_hex()?;
    let owner_password = random_hex()?;
    let app_password = random_hex()?;
    if setup_token == owner_password
        || setup_token == app_password
        || owner_password == app_password
    {
        return Err("Random credentials matched; retry init");
    }
    let contents = format!(
        "FUKULOW_VERSION={version}\nCOMPOSE_PROFILES={proxy}\nFUKULOW_DOMAIN={domain}\n\
         FUKULOW_SETUP_TOKEN={setup_token}\nPOSTGRES_PASSWORD={owner_password}\nPOSTGRES_APP_PASSWORD={app_password}\n"
    );
    publish_env(contents.as_bytes())
}

fn pinned_version(version: &str) -> bool {
    let Some((tag, digest)) = version.split_once("@sha256:") else {
        return false;
    };
    let mut bytes = tag.bytes();
    tag.len() <= 128
        && bytes
            .next()
            .is_some_and(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
        && bytes.all(|byte| byte.is_ascii_alphanumeric() || b"_.-".contains(&byte))
        && digest.len() == 64
        && digest
            .bytes()
            .all(|byte| b"0123456789abcdef".contains(&byte))
}

fn valid_domain(domain: &str) -> bool {
    domain.len() <= 253
        && domain.split('.').all(|label| {
            let bytes = label.as_bytes();
            bytes.len() <= 63
                && bytes.first().is_some_and(u8::is_ascii_alphanumeric)
                && bytes.last().is_some_and(u8::is_ascii_alphanumeric)
                && bytes
                    .iter()
                    .all(|byte| byte.is_ascii_alphanumeric() || *byte == b'-')
        })
}

fn random_hex() -> Result<String, &'static str> {
    let mut bytes = [0; 32];
    SysRng
        .try_fill_bytes(&mut bytes)
        .map_err(|_| "Operating system randomness unavailable; retry init")?;
    let mut hex = String::with_capacity(64);
    let alphabet = b"0123456789abcdef";
    for byte in bytes {
        hex.push(char::from(alphabet[usize::from(byte >> 4)]));
        hex.push(char::from(alphabet[usize::from(byte & 0x0f)]));
    }
    Ok(hex)
}

fn publish_env(contents: &[u8]) -> Result<(), &'static str> {
    let temporary = format!(".env.init-{}", random_hex()?);
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&temporary)
        .map_err(|_| "Cannot stage .env; check that the current directory is writable")?;

    // Publish the complete file in one operation. A hard link never replaces a
    // destination, including a dangling symlink or a competing init's file.
    let result = file
        .set_permissions(Permissions::from_mode(0o600))
        .and_then(|()| file.write_all(contents))
        .and_then(|()| file.sync_all())
        .map_err(|_| "Cannot write .env; check file permissions and disk space")
        .and_then(|()| {
            fs::hard_link(&temporary, ".env").map_err(|error| {
                if error.kind() == io::ErrorKind::AlreadyExists {
                    ".env already exists; use it or run init in a different directory"
                } else {
                    "Cannot publish .env; check that the current directory supports hard links"
                }
            })
        });
    let _ = fs::remove_file(temporary);
    result
}
