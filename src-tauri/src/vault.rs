use argon2::{Algorithm, Argon2, Params, Version};
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use bip39::{Language, Mnemonic};
use chacha20poly1305::{
    aead::{Aead, KeyInit},
    ChaCha20Poly1305, Nonce,
};
use ed25519_dalek::SigningKey;
use rand::{rngs::OsRng, RngCore};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Mutex;
use zeroize::Zeroize;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AccountProfile {
    pub username: String,
    pub public_key: String,
    pub account_tag: String,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreatedAccountResult {
    pub profile: AccountProfile,
    pub recovery_phrase: String,
    pub recovery_kit_uri: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct EncryptedRecoveryKit {
    version: u8,
    username: String,
    salt: String,
    nonce: String,
    ciphertext: String,
}

pub struct VaultState {
    pub db_path: PathBuf,
    pub unlocked_seed: Mutex<Option<[u8; 32]>>,
    pub active_profile: Mutex<Option<AccountProfile>>,
}

impl VaultState {
    pub fn new(db_path: PathBuf) -> Result<Self, String> {
        if let Some(parent) = db_path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("Failed to create vault dir: {e}"))?;
        }
        let conn = Connection::open(&db_path).map_err(|e| format!("SQLite open error: {e}"))?;
        conn.execute_batch(
            "
            PRAGMA journal_mode = WAL;
            PRAGMA foreign_keys = ON;

            CREATE TABLE IF NOT EXISTS account (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                username TEXT NOT NULL,
                public_key TEXT NOT NULL,
                account_tag TEXT NOT NULL,
                salt TEXT NOT NULL,
                nonce TEXT NOT NULL,
                encrypted_seed BLOB NOT NULL,
                created_at INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS contacts (
                public_key TEXT PRIMARY KEY,
                username TEXT NOT NULL,
                onion_addr TEXT,
                iroh_node_id TEXT,
                added_at INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS messages (
                id TEXT PRIMARY KEY,
                channel_id TEXT NOT NULL,
                sender_pubkey TEXT NOT NULL,
                sender_name TEXT NOT NULL,
                content TEXT NOT NULL,
                timestamp INTEGER NOT NULL,
                delivered INTEGER NOT NULL DEFAULT 1
            );
            ",
        )
        .map_err(|e| format!("Schema init error: {e}"))?;

        Ok(Self {
            db_path,
            unlocked_seed: Mutex::new(None),
            active_profile: Mutex::new(None),
        })
    }

    fn derive_key(password: &str, salt_b64: &str) -> Result<[u8; 32], String> {
        let salt_bytes = B64.decode(salt_b64).map_err(|e| format!("Invalid salt: {e}"))?;
        // 64 MiB memory cost, 3 iterations, 1 lane — strong offline brute-force resistance
        let params = Params::new(65536, 3, 1, Some(32)).map_err(|e| format!("Argon2 params error: {e}"))?;
        let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
        let mut key = [0u8; 32];
        argon2
            .hash_password_into(password.as_bytes(), &salt_bytes, &mut key)
            .map_err(|e| format!("Key derivation failed: {e}"))?;
        Ok(key)
    }

    fn encrypt_seed(seed: &[u8; 32], key: &[u8; 32]) -> Result<(String, Vec<u8>), String> {
        let cipher = ChaCha20Poly1305::new_from_slice(key).map_err(|e| format!("Cipher init: {e}"))?;
        let mut nonce_bytes = [0u8; 12];
        OsRng.fill_bytes(&mut nonce_bytes);
        let nonce = Nonce::try_from(nonce_bytes.as_slice()).map_err(|_| "Nonce error".to_string())?;
        let ciphertext = cipher
            .encrypt(&nonce, seed.as_ref())
            .map_err(|_| "Encryption failed".to_string())?;
        Ok((B64.encode(nonce_bytes), ciphertext))
    }

    fn decrypt_seed(ciphertext: &[u8], nonce_b64: &str, key: &[u8; 32]) -> Result<[u8; 32], String> {
        let cipher = ChaCha20Poly1305::new_from_slice(key).map_err(|e| format!("Cipher init: {e}"))?;
        let nonce_bytes = B64.decode(nonce_b64).map_err(|_| "Corrupt nonce".to_string())?;
        let nonce = Nonce::try_from(nonce_bytes.as_slice()).map_err(|_| "Invalid nonce length".to_string())?;
        let plaintext = cipher
            .decrypt(&nonce, ciphertext)
            .map_err(|_| "Invalid password or corrupted vault".to_string())?;
        if plaintext.len() != 32 {
            return Err("Invalid seed length".to_string());
        }
        let mut seed = [0u8; 32];
        seed.copy_from_slice(&plaintext);
        Ok(seed)
    }

    pub fn has_account(&self) -> Result<Option<AccountProfile>, String> {
        let conn = Connection::open(&self.db_path).map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare("SELECT username, public_key, account_tag, created_at FROM account WHERE id = 1")
            .map_err(|e| e.to_string())?;
        let mut rows = stmt.query([]).map_err(|e| e.to_string())?;
        if let Some(row) = rows.next().map_err(|e| e.to_string())? {
            Ok(Some(AccountProfile {
                username: row.get(0).map_err(|e| e.to_string())?,
                public_key: row.get(1).map_err(|e| e.to_string())?,
                account_tag: row.get(2).map_err(|e| e.to_string())?,
                created_at: row.get(3).map_err(|e| e.to_string())?,
            }))
        } else {
            Ok(None)
        }
    }

    pub fn create_account(&self, username: String, password: String) -> Result<CreatedAccountResult, String> {
        let clean_user = username.trim().to_string();
        if clean_user.len() < 2 || clean_user.len() > 32 {
            return Err("Username must be between 2 and 32 characters.".to_string());
        }
        if password.len() < 10 {
            return Err("Master password must be at least 10 characters.".to_string());
        }

        // 1. Generate 16 bytes of entropy -> 12-word BIP39 mnemonic, and expand to 32-byte Ed25519 seed
        let mut entropy = [0u8; 16];
        OsRng.fill_bytes(&mut entropy);
        let mnemonic = Mnemonic::from_entropy_in(Language::English, &entropy)
            .map_err(|e| format!("Mnemonic error: {e}"))?;
        let recovery_phrase = mnemonic.to_string();
        let bip39_seed = mnemonic.to_seed("");
        let mut ed_seed = [0u8; 32];
        ed_seed.copy_from_slice(&bip39_seed[..32]);

        let signing_key = SigningKey::from_bytes(&ed_seed);
        let pubkey_b64 = B64.encode(signing_key.verifying_key().to_bytes());
        let short_fp: String = pubkey_b64.chars().filter(|c| c.is_alphanumeric()).take(4).collect();
        let account_tag = format!("@{}#{}", clean_user, short_fp.to_lowercase());

        // 2. Generate 16-byte random salt, derive Argon2id encryption key & encrypt Ed25519 seed
        let mut salt_bytes = [0u8; 16];
        OsRng.fill_bytes(&mut salt_bytes);
        let salt_str = B64.encode(salt_bytes);
        let mut derived_key = Self::derive_key(&password, &salt_str)?;
        let (nonce_b64, encrypted_seed) = Self::encrypt_seed(&ed_seed, &derived_key)?;
        derived_key.zeroize();

        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs() as i64;

        let conn = Connection::open(&self.db_path).map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT OR REPLACE INTO account (id, username, public_key, account_tag, salt, nonce, encrypted_seed, created_at)
             VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![clean_user, pubkey_b64, account_tag, salt_str, nonce_b64, encrypted_seed, now],
        )
        .map_err(|e| format!("Failed to save account: {e}"))?;

        let kit = EncryptedRecoveryKit {
            version: 1,
            username: clean_user.clone(),
            salt: salt_str,
            nonce: nonce_b64,
            ciphertext: B64.encode(&encrypted_seed),
        };
        let kit_json = serde_json::to_string(&kit).map_err(|e| e.to_string())?;
        let recovery_kit_uri = format!("nullpoint-recovery://{}", B64.encode(kit_json.as_bytes()));

        let profile = AccountProfile {
            username: clean_user,
            public_key: pubkey_b64,
            account_tag,
            created_at: now,
        };

        *self.unlocked_seed.lock().unwrap() = Some(ed_seed);
        *self.active_profile.lock().unwrap() = Some(profile.clone());

        Ok(CreatedAccountResult {
            profile,
            recovery_phrase,
            recovery_kit_uri,
        })
    }

    pub fn unlock_account(&self, password: String) -> Result<AccountProfile, String> {
        let conn = Connection::open(&self.db_path).map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare("SELECT username, public_key, account_tag, salt, nonce, encrypted_seed, created_at FROM account WHERE id = 1")
            .map_err(|e| e.to_string())?;
        let row = stmt
            .query_row([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, String>(4)?,
                    r.get::<_, Vec<u8>>(5)?,
                    r.get::<_, i64>(6)?,
                ))
            })
            .map_err(|_| "No local account found.".to_string())?;

        let mut derived_key = Self::derive_key(&password, &row.3)?;
        let ed_seed = Self::decrypt_seed(&row.5, &row.4, &derived_key)?;
        derived_key.zeroize();

        let profile = AccountProfile {
            username: row.0,
            public_key: row.1,
            account_tag: row.2,
            created_at: row.6,
        };

        *self.unlocked_seed.lock().unwrap() = Some(ed_seed);
        *self.active_profile.lock().unwrap() = Some(profile.clone());
        Ok(profile)
    }

    pub fn recover_account(
        &self,
        recovery_input: String,
        recovery_password: String,
        new_local_password: String,
        override_username: Option<String>,
    ) -> Result<AccountProfile, String> {
        if new_local_password.len() < 10 {
            return Err("New local master password must be at least 10 characters.".to_string());
        }
        let trimmed = recovery_input.trim();
        let (ed_seed, recovered_username) = if let Some(b64_part) = trimmed.strip_prefix("nullpoint-recovery://") {
            let raw_json = B64.decode(b64_part).map_err(|_| "Invalid recovery kit format".to_string())?;
            let kit: EncryptedRecoveryKit =
                serde_json::from_slice(&raw_json).map_err(|_| "Corrupted recovery kit JSON".to_string())?;
            let cipher_bytes = B64.decode(&kit.ciphertext).map_err(|_| "Corrupted ciphertext".to_string())?;
            let mut old_key = Self::derive_key(&recovery_password, &kit.salt)?;
            let seed = Self::decrypt_seed(&cipher_bytes, &kit.nonce, &old_key)?;
            old_key.zeroize();
            (seed, override_username.unwrap_or(kit.username))
        } else {
            let mnemonic = Mnemonic::parse_in(Language::English, trimmed)
                .map_err(|_| "Invalid 12-word recovery phrase or recovery URI.".to_string())?;
            let bip39_seed = mnemonic.to_seed("");
            let mut seed = [0u8; 32];
            seed.copy_from_slice(&bip39_seed[..32]);
            let uname = override_username.unwrap_or_else(|| "operator".to_string());
            (seed, uname)
        };

        let signing_key = SigningKey::from_bytes(&ed_seed);
        let pubkey_b64 = B64.encode(signing_key.verifying_key().to_bytes());
        let short_fp: String = pubkey_b64.chars().filter(|c| c.is_alphanumeric()).take(4).collect();
        let account_tag = format!("@{}#{}", recovered_username, short_fp.to_lowercase());

        let mut salt_bytes = [0u8; 16];
        OsRng.fill_bytes(&mut salt_bytes);
        let salt_str = B64.encode(salt_bytes);
        let mut new_key = Self::derive_key(&new_local_password, &salt_str)?;
        let (nonce_b64, encrypted_seed) = Self::encrypt_seed(&ed_seed, &new_key)?;
        new_key.zeroize();

        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs() as i64;

        let conn = Connection::open(&self.db_path).map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT OR REPLACE INTO account (id, username, public_key, account_tag, salt, nonce, encrypted_seed, created_at)
             VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![recovered_username, pubkey_b64, account_tag, salt_str, nonce_b64, encrypted_seed, now],
        )
        .map_err(|e| e.to_string())?;

        let profile = AccountProfile {
            username: recovered_username,
            public_key: pubkey_b64,
            account_tag,
            created_at: now,
        };

        *self.unlocked_seed.lock().unwrap() = Some(ed_seed);
        *self.active_profile.lock().unwrap() = Some(profile.clone());
        Ok(profile)
    }
}
