//! Random secrets (API keys, OAuth codes and tokens) and the hashes they're stored and looked up by.
//!
//! Secrets are 256 random bits, so a fast hash (SHA-256) is enough, and unlike a salted one it lets a
//! secret be found by its hash. The secret itself is only ever shown to whoever it's issued to.

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use sha2::{Digest, Sha256};

/// A new secret: `prefix` followed by 32 random bytes, base64url-encoded.
pub fn generate(prefix: &str) -> anyhow::Result<String> {
    let mut random = [0u8; 32];
    getrandom::fill(&mut random)?;
    Ok(format!("{prefix}{}", URL_SAFE_NO_PAD.encode(random)))
}

/// The hex SHA-256 of a secret, as stored.
pub fn hash(secret: &str) -> String {
    hex::encode(Sha256::digest(secret))
}
