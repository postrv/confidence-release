// SPDX-License-Identifier: Apache-2.0
pub mod archive;
pub mod checks;
pub mod client;
pub mod journal;
pub mod process;
pub mod repository;

pub type Result<T> = std::result::Result<T, String>;

pub const MAX_ARCHIVE_BYTES: usize = 16 * 1024 * 1024;
pub const MAX_INVENTORY_BYTES: usize = 16 * 1024 * 1024;
pub const MAX_OBJECT_BYTES: usize = 8 * 1024 * 1024;
pub const MAX_BLOB_BYTES: usize = 4 * 1024 * 1024;
pub const MAX_OBJECTS: usize = 8192;
pub const MAX_FILES: usize = 4096;
pub const MAX_DEPTH: usize = 32;

pub fn canonical(value: &serde_json::Value) -> String {
    match value {
        serde_json::Value::Object(map) => {
            let mut keys: Vec<_> = map.keys().collect();
            keys.sort_by_key(|s| s.encode_utf16().collect::<Vec<_>>());
            format!(
                "{{{}}}",
                keys.iter()
                    .map(|key| format!(
                        "{}:{}",
                        serde_json::to_string(key).unwrap(),
                        canonical(&map[*key])
                    ))
                    .collect::<Vec<_>>()
                    .join(",")
            )
        }
        serde_json::Value::Array(items) => format!(
            "[{}]",
            items.iter().map(canonical).collect::<Vec<_>>().join(",")
        ),
        _ => serde_json::to_string(value).unwrap(),
    }
}

pub fn digest(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    format!("sha256:{}", hex::encode(Sha256::digest(bytes)))
}

pub fn random_id() -> Result<String> {
    let mut bytes = [0u8; 16];
    getrandom::getrandom(&mut bytes).map_err(|_| "System random source unavailable".to_owned())?;
    Ok(hex::encode(bytes))
}
