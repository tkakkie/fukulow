use super::*;
use ring::{
    aead::{AES_256_GCM, Aad, LessSafeKey, NONCE_LEN, Nonce, UnboundKey},
    rand::{SecureRandom, SystemRandom},
};

#[derive(Serialize, Deserialize)]
pub(super) struct Position {
    pub created_at: String,
    pub id: Uuid,
}

pub(super) struct Scope(Vec<u8>);

impl Scope {
    pub fn new(organization: Uuid, member: Uuid, channel: Option<Uuid>, query: &str) -> Self {
        let mut scope = Vec::new();
        scope.extend_from_slice(organization.as_bytes());
        scope.extend_from_slice(member.as_bytes());
        scope.push(u8::from(channel.is_some()));
        if let Some(channel) = channel {
            scope.extend_from_slice(channel.as_bytes());
        }
        scope.extend_from_slice(query.as_bytes());
        Self(scope)
    }

    pub fn encode(&self, key: &LessSafeKey, position: &Position) -> Result<String, ApiError> {
        let mut nonce = [0; NONCE_LEN];
        SystemRandom::new()
            .fill(&mut nonce)
            .map_err(|_| internal_error())?;
        let mut bytes = serde_json::to_vec(position).map_err(|_| internal_error())?;
        key.seal_in_place_append_tag(
            Nonce::assume_unique_for_key(nonce),
            Aad::from(&self.0),
            &mut bytes,
        )
        .map_err(|_| internal_error())?;
        Ok(nonce
            .into_iter()
            .chain(bytes)
            .map(|byte| format!("{byte:02x}"))
            .collect())
    }

    pub fn decode(&self, key: &LessSafeKey, token: &str) -> Result<Position, ApiError> {
        if !(2 * (NONCE_LEN + AES_256_GCM.tag_len())..=512).contains(&token.len())
            || !token.len().is_multiple_of(2)
            || !token.bytes().all(|byte| byte.is_ascii_hexdigit())
        {
            return Err(invalid_cursor());
        }
        let mut bytes = (0..token.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&token[i..i + 2], 16).map_err(|_| invalid_cursor()))
            .collect::<Result<Vec<_>, _>>()?;
        let (nonce, bytes) = bytes.split_at_mut(NONCE_LEN);
        let plain = key
            .open_in_place(
                Nonce::try_assume_unique_for_key(nonce).map_err(|_| invalid_cursor())?,
                Aad::from(&self.0),
                bytes,
            )
            .map_err(|_| invalid_cursor())?;
        serde_json::from_slice(plain).map_err(|_| invalid_cursor())
    }
}

pub(super) fn new_key() -> Result<LessSafeKey, &'static str> {
    let mut bytes = [0; 32];
    let error = "Cannot initialize Search cursor key";
    SystemRandom::new().fill(&mut bytes).map_err(|_| error)?;
    UnboundKey::new(&AES_256_GCM, &bytes)
        .map(LessSafeKey::new)
        .map_err(|_| error)
}

fn invalid_cursor() -> ApiError {
    ApiError(StatusCode::BAD_REQUEST, "invalid_cursor", None)
}

fn internal_error() -> ApiError {
    ApiError(StatusCode::INTERNAL_SERVER_ERROR, "internal error", None)
}
