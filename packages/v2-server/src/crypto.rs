use aes_gcm::aead::{Aead, KeyInit, OsRng};
use aes_gcm::{Aes256Gcm, Key, Nonce};

use crate::types::AppError;

/// AES-256-GCM encryption result
pub struct EncryptResult {
    /// Encrypted data (nonce prepended: 12 bytes nonce + ciphertext)
    pub ciphertext: Vec<u8>,
    /// The 32-byte encryption key (must be stored securely by TEE)
    pub key: Vec<u8>,
}

/// Encrypt plaintext using AES-256-GCM with a randomly generated key.
///
/// Returns the encrypted data (nonce || ciphertext) and the key.
/// The nonce is prepended to the ciphertext for easy storage.
pub fn encrypt(plaintext: &[u8]) -> Result<EncryptResult, AppError> {
    // Generate random 256-bit key
    let key = Aes256Gcm::generate_key(OsRng);
    let cipher = Aes256Gcm::new(&key);

    // Generate random 96-bit nonce
    let nonce_bytes: [u8; 12] = rand::random();
    let nonce = Nonce::from_slice(&nonce_bytes);

    // Encrypt
    let ciphertext = cipher
        .encrypt(nonce, plaintext)
        .map_err(|e| AppError::Internal(format!("Encryption failed: {}", e)))?;

    // Prepend nonce to ciphertext for storage
    let mut result = Vec::with_capacity(12 + ciphertext.len());
    result.extend_from_slice(&nonce_bytes);
    result.extend_from_slice(&ciphertext);

    Ok(EncryptResult {
        ciphertext: result,
        key: key.to_vec(),
    })
}

/// Decrypt data that was encrypted with `encrypt()`.
///
/// `data` must be in format: 12 bytes nonce || ciphertext
/// `key` must be the 32-byte key from the original encryption.
pub fn decrypt(data: &[u8], key: &[u8]) -> Result<Vec<u8>, AppError> {
    if data.len() < 12 {
        return Err(AppError::BadRequest("Ciphertext too short".into()));
    }
    if key.len() != 32 {
        return Err(AppError::BadRequest("Key must be 32 bytes".into()));
    }

    let key = Key::<Aes256Gcm>::from_slice(key);
    let cipher = Aes256Gcm::new(key);

    let nonce = Nonce::from_slice(&data[..12]);
    let ciphertext = &data[12..];

    cipher
        .decrypt(nonce, ciphertext)
        .map_err(|e| AppError::Internal(format!("Decryption failed: {}", e)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_encrypt_decrypt_roundtrip() {
        let plaintext = b"Hello, MemWal TEE!";
        let result = encrypt(plaintext).unwrap();
        let decrypted = decrypt(&result.ciphertext, &result.key).unwrap();
        assert_eq!(plaintext.to_vec(), decrypted);
    }

    #[test]
    fn test_different_keys_produce_different_ciphertext() {
        let plaintext = b"Same plaintext";
        let r1 = encrypt(plaintext).unwrap();
        let r2 = encrypt(plaintext).unwrap();
        assert_ne!(r1.ciphertext, r2.ciphertext);
        assert_ne!(r1.key, r2.key);
    }
}
