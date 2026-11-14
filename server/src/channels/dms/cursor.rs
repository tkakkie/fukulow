use super::*;
use ring::{
    aead,
    rand::{SecureRandom, SystemRandom},
};
use sha2::{Digest, Sha256};

#[derive(Serialize, Deserialize, Default)]
pub(crate) struct Cursor {
    pub at: i64,
    pub ceiling: Option<i64>,
    pub exhausted: bool,
    pub created_at: Option<String>,
    pub id: Option<Uuid>,
}
impl Cursor {
    fn key(secret: &str) -> Result<aead::LessSafeKey, ApiError> {
        let key =
            Sha256::digest([b"fukulow-dm-cursor-v1\0".as_slice(), secret.as_bytes()].concat());
        aead::UnboundKey::new(&aead::AES_256_GCM, &key)
            .map(aead::LessSafeKey::new)
            .map_err(|_| ApiError(StatusCode::INTERNAL_SERVER_ERROR, "internal error", None))
    }
    fn scope(auth: &Auth, lane: &str) -> Vec<u8> {
        [
            auth.identity
                .organization
                .organization_id
                .as_bytes()
                .as_slice(),
            auth.identity.member.id.as_bytes(),
            &auth.membership_revision.to_be_bytes(),
            auth.session_scope(),
            lane.as_bytes(),
            b"v1",
        ]
        .concat()
    }
    pub fn encode(&self, secret: &str, auth: &Auth, lane: &str) -> Result<String, ApiError> {
        let mut nonce = [0; 12];
        SystemRandom::new()
            .fill(&mut nonce)
            .map_err(|_| ApiError(StatusCode::INTERNAL_SERVER_ERROR, "internal error", None))?;
        let mut data = serde_json::to_vec(self).map_err(|_| ApiError::bad_request())?;
        Self::key(secret)?
            .seal_in_place_append_tag(
                aead::Nonce::assume_unique_for_key(nonce),
                aead::Aad::from(Self::scope(auth, lane)),
                &mut data,
            )
            .map_err(|_| ApiError::bad_request())?;
        Ok(nonce
            .into_iter()
            .chain(data)
            .map(|b| format!("{b:02x}"))
            .collect())
    }
    pub fn decode(token: &str, secret: &str, auth: &Auth, lane: &str) -> Result<Self, ApiError> {
        if token.len() > 2048
            || token.len() < 56
            || !token.len().is_multiple_of(2)
            || !token.is_ascii()
        {
            return Err(ApiError::bad_request());
        }
        let bytes = (0..token.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&token[i..i + 2], 16).map_err(|_| ApiError::bad_request()))
            .collect::<Result<Vec<_>, _>>()?;
        let (nonce, data) = bytes.split_at(12);
        let mut data = data.to_vec();
        let nonce = nonce.try_into().map_err(|_| ApiError::bad_request())?;
        let plain = Self::key(secret)?
            .open_in_place(
                aead::Nonce::assume_unique_for_key(nonce),
                aead::Aad::from(Self::scope(auth, lane)),
                &mut data,
            )
            .map_err(|_| ApiError::bad_request())?;
        serde_json::from_slice(plain).map_err(|_| ApiError::bad_request())
    }
}
