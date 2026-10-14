// SPDX-License-Identifier: Apache-2.0
use crate::{
    MAX_ARCHIVE_BYTES, Result, canonical,
    checks::{self, ProjectCheck},
    digest,
    repository::{Snapshot, WorktreeState},
};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize};
use std::{fs, io::Read, path::Path};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitArchiveObject {
    pub oid: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub data_base64: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RepositoryArchive {
    pub schema_version: u8,
    pub format: String,
    pub head: String,
    pub branch: Option<String>,
    pub objects: Vec<GitArchiveObject>,
    pub checks: Vec<ProjectCheck>,
    pub warnings: Vec<String>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Inspection {
    pub head: String,
    pub branch: Option<String>,
    pub parents: Vec<String>,
    pub history: &'static str,
    pub file_count: usize,
    pub object_count: usize,
    pub object_bytes: usize,
    pub archive_bytes: usize,
    pub archive_digest: String,
    pub executable_files: usize,
    pub symlinks: usize,
    pub submodules: usize,
    pub worktree: WorktreeState,
    pub checks: Vec<ProjectCheck>,
    pub warnings: Vec<String>,
    pub limits: serde_json::Value,
}
impl RepositoryArchive {
    pub fn read(path: &Path) -> Result<Self> {
        let file = fs::File::open(path).map_err(|error| format!("Cannot read archive: {error}"))?;
        let mut bytes = Vec::new();
        file.take(MAX_ARCHIVE_BYTES as u64 + 1)
            .read_to_end(&mut bytes)
            .map_err(|error| error.to_string())?;
        if bytes.len() > MAX_ARCHIVE_BYTES {
            return Err("Archive exceeds the 16 MiB import limit".into());
        }
        let archive: Self = serde_json::from_slice(&bytes)
            .map_err(|_| "Archive schema is invalid; use confidence repo pack")?;
        let valid_id = |id: &str| {
            id.len() == 40
                && id
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        };
        if archive.schema_version != 1
            || archive.format != "confidence-git-archive-v1"
            || !valid_id(&archive.head)
            || archive.objects.is_empty()
            || archive.objects.len() > crate::MAX_OBJECTS
            || archive.checks.len() > 32
        {
            return Err("Unsupported archive format or resource limit".into());
        }
        if archive.warnings.len() > 64
            || archive
                .warnings
                .iter()
                .any(|warning| warning.len() > 512 || warning.chars().any(char::is_control))
        {
            return Err("Archive warnings exceed limits or contain control characters".into());
        }
        let mut ids = std::collections::BTreeSet::new();
        let mut total = 0;
        for object in &archive.objects {
            if !valid_id(&object.oid)
                || !ids.insert(&object.oid)
                || !matches!(object.kind.as_str(), "commit" | "tree" | "blob")
            {
                return Err("Archive has an invalid or duplicate object identity".into());
            }
            let data = STANDARD
                .decode(&object.data_base64)
                .map_err(|_| "Invalid archive object encoding")?;
            total += data.len();
            if total > crate::MAX_OBJECT_BYTES || data.len() > crate::MAX_BLOB_BYTES {
                return Err("Archive exceeds object byte limits".into());
            }
            if crate::repository::git_oid(&object.kind, &data) != object.oid {
                return Err("Archive object hash mismatch".into());
            }
        }
        if !archive
            .objects
            .iter()
            .any(|object| object.oid == archive.head && object.kind == "commit")
        {
            return Err("Archive HEAD object missing".into());
        }
        archive.bytes()?;
        Ok(archive)
    }
    pub fn from_snapshot(snapshot: &Snapshot) -> Self {
        Self {
            schema_version: 1,
            format: "confidence-git-archive-v1".into(),
            head: snapshot.head.clone(),
            branch: snapshot.branch.clone(),
            objects: snapshot
                .objects
                .values()
                .map(|object| GitArchiveObject {
                    oid: object.oid.clone(),
                    kind: object.kind.clone(),
                    data_base64: STANDARD.encode(&object.data),
                })
                .collect(),
            checks: checks::discover(snapshot),
            warnings: snapshot.warnings.clone(),
        }
    }
    pub fn bytes(&self) -> Result<Vec<u8>> {
        let bytes =
            canonical(&serde_json::to_value(self).map_err(|error| error.to_string())?).into_bytes();
        if bytes.len() > MAX_ARCHIVE_BYTES {
            return Err("Archive exceeds the 16 MiB import limit; no files were omitted".into());
        }
        Ok(bytes)
    }
    pub fn inspect(&self, snapshot: &Snapshot) -> Result<Inspection> {
        let bytes = self.bytes()?;
        Ok(Inspection {
            head: self.head.clone(),
            branch: self.branch.clone(),
            parents: snapshot.parents.clone(),
            history: "head-tree-only",
            file_count: snapshot.entries.len(),
            object_count: snapshot.objects.len(),
            object_bytes: snapshot
                .objects
                .values()
                .map(|object| object.data.len())
                .sum(),
            archive_bytes: bytes.len(),
            archive_digest: digest(&bytes),
            executable_files: snapshot
                .entries
                .iter()
                .filter(|entry| entry.mode == "100755")
                .count(),
            symlinks: snapshot
                .entries
                .iter()
                .filter(|entry| entry.mode == "120000")
                .count(),
            submodules: snapshot
                .entries
                .iter()
                .filter(|entry| entry.mode == "160000")
                .count(),
            worktree: snapshot.worktree.clone(),
            checks: self.checks.clone(),
            warnings: self.warnings.clone(),
            limits: serde_json::json!({"archiveBytes":crate::MAX_ARCHIVE_BYTES,"objectBytes":crate::MAX_OBJECT_BYTES,"blobBytes":crate::MAX_BLOB_BYTES,
                "objects":crate::MAX_OBJECTS,"files":crate::MAX_FILES,"depth":crate::MAX_DEPTH,"checks":32,"inventoryBytes":crate::MAX_INVENTORY_BYTES}),
        })
    }
}
