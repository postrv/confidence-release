// SPDX-License-Identifier: Apache-2.0
use crate::{MAX_ARCHIVE_BYTES, Result, canonical, random_id};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    fs::{self, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RequestRecord {
    pub schema_version: u8,
    pub target: String,
    pub principal_id: String,
    pub local_development: bool,
    pub command_id: String,
    pub route: String,
    pub expected_revision: Option<String>,
    pub expected_incarnation: Option<String>,
    pub body: Value,
}
pub fn default_path(command_id: &str) -> Result<PathBuf> {
    let home = std::env::var_os("HOME").ok_or("HOME is unset; provide --journal PATH")?;
    Ok(PathBuf::from(home)
        .join(".confidence")
        .join("operations")
        .join(format!("{command_id}.json")))
}
fn ensure_parent(path: &Path) -> Result<()> {
    if let Some(parent) = path.parent().filter(|path| !path.as_os_str().is_empty())
        && !parent.exists()
    {
        let mut builder = fs::DirBuilder::new();
        builder.recursive(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        builder
            .create(parent)
            .map_err(|error| format!("Cannot create journal directory: {error}"))?;
    }
    Ok(())
}
/// Exclusive creation and fsync happen before any request can be sent. A journal
/// is immutable; resuming always replays its exact principal, command and body.
pub fn create(path: &Path, record: &RequestRecord) -> Result<()> {
    ensure_parent(path)?;
    write_new(
        path,
        canonical(&serde_json::to_value(record).map_err(|error| error.to_string())?).as_bytes(),
    )
}
pub fn write_new(path: &Path, bytes: &[u8]) -> Result<()> {
    let mut options = OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(path)
        .map_err(|error| format!("Cannot exclusively create {}: {error}", path.display()))?;
    file.write_all(bytes)
        .and_then(|_| file.sync_all())
        .map_err(|error| format!("Cannot retain durable file: {error}"))?;
    if let Some(parent) = path.parent().filter(|path| !path.as_os_str().is_empty()) {
        fs::File::open(parent)
            .and_then(|directory| directory.sync_all())
            .map_err(|error| format!("Cannot sync containing directory: {error}"))?;
    }
    Ok(())
}
pub fn read(path: &Path) -> Result<RequestRecord> {
    let file =
        fs::File::open(path).map_err(|error| format!("Cannot read request journal: {error}"))?;
    let mut bytes = Vec::new();
    file.take((MAX_ARCHIVE_BYTES + 64 * 1024 + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    if bytes.len() > MAX_ARCHIVE_BYTES + 64 * 1024 {
        return Err("Request journal exceeds byte limit".into());
    }
    let record: RequestRecord =
        serde_json::from_slice(&bytes).map_err(|_| "Invalid request journal")?;
    if record.schema_version != 1
        || record.command_id.len() != 32
        || !record.command_id.bytes().all(|b| b.is_ascii_hexdigit())
    {
        return Err("Unsupported request journal identity".into());
    }
    let valid_project = |value: &str| {
        !value.is_empty()
            && value.len() <= 128
            && value
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
    };
    let import = record
        .route
        .strip_prefix("/api/projects/")
        .and_then(|route| route.strip_suffix("/import"))
        .is_some_and(valid_project);
    if record.route != "/api/projects" && !import
        || import != record.expected_revision.is_some()
        || import != record.expected_incarnation.is_some()
    {
        return Err("Journal does not describe a supported create or import request".into());
    }
    Ok(record)
}
pub fn record_response(path: &Path, status: u16, value: &Value) -> Result<PathBuf> {
    let response_path = PathBuf::from(format!("{}.response-{}.json", path.display(), random_id()?));
    write_new(
        &response_path,
        canonical(&serde_json::json!({"status":status,"response":value})).as_bytes(),
    )?;
    Ok(response_path)
}
