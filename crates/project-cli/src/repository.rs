// SPDX-License-Identifier: Apache-2.0
use crate::{
    MAX_BLOB_BYTES, MAX_DEPTH, MAX_FILES, MAX_OBJECT_BYTES, MAX_OBJECTS, Result, process::captured,
};
use serde::Serialize;
use sha1::{Digest, Sha1};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    io::Read,
    path::{Path, PathBuf},
    process::Command,
    time::Duration,
};

#[derive(Clone, Debug)]
pub struct Object {
    pub oid: String,
    pub kind: String,
    pub data: Vec<u8>,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub path: String,
    pub mode: String,
    pub oid: String,
    pub bytes: Option<usize>,
}
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeState {
    pub bare: bool,
    pub staged_paths: usize,
    pub changed_paths: usize,
    pub untracked_paths: usize,
    pub ignored_paths: usize,
    pub uninspected_paths: usize,
    pub comparison: &'static str,
}
#[derive(Clone, Debug)]
pub struct Snapshot {
    pub head: String,
    pub branch: Option<String>,
    pub parents: Vec<String>,
    pub objects: BTreeMap<String, Object>,
    pub entries: Vec<Entry>,
    pub worktree: WorktreeState,
    pub warnings: Vec<String>,
}

pub fn git_oid(kind: &str, data: &[u8]) -> String {
    let mut hash = Sha1::new();
    hash.update(format!("{kind} {}\0", data.len()).as_bytes());
    hash.update(data);
    hex::encode(hash.finalize())
}
fn oid(value: &str) -> bool {
    value.len() == 40
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

struct Git {
    path: PathBuf,
}
impl Git {
    fn call(&self, args: &[&str], input: Vec<u8>, cap: usize) -> Result<(bool, Vec<u8>)> {
        let mut command = Command::new("git");
        command
            .current_dir(&self.path)
            .env_clear()
            .env("PATH", std::env::var_os("PATH").unwrap_or_default())
            .env("HOME", "/nonexistent")
            .env("LC_ALL", "C")
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("GIT_OPTIONAL_LOCKS", "0")
            .env("GIT_NO_LAZY_FETCH", "1")
            .env("GIT_NO_REPLACE_OBJECTS", "1")
            .args([
                "--no-replace-objects",
                "-c",
                "core.hooksPath=/dev/null",
                "-c",
                "core.fsmonitor=false",
                "-c",
                "core.untrackedCache=false",
                "-c",
                "core.preloadIndex=false",
                "-c",
                "core.autocrlf=false",
                "-c",
                "protocol.allow=never",
                "-c",
                "credential.helper=",
                "-c",
                "diff.external=",
            ])
            .args(args);
        captured(&mut command, input, cap, Duration::from_secs(30))
    }
    fn read(&self, args: &[&str], cap: usize) -> Result<Vec<u8>> {
        let (success, output) = self.call(args, Vec::new(), cap)?;
        if !success {
            return Err(format!(
                "Git {} failed; use an accessible, fully local repository with a committed HEAD",
                args[0]
            ));
        }
        Ok(output)
    }
    fn text(&self, args: &[&str], cap: usize) -> Result<String> {
        String::from_utf8(self.read(args, cap)?)
            .map(|text| text.trim_end_matches('\n').to_owned())
            .map_err(|_| "Git output is not UTF-8".into())
    }
    fn objects(&self, requests: &BTreeMap<String, String>) -> Result<BTreeMap<String, Object>> {
        let input = requests
            .keys()
            .map(|id| format!("{id}\n"))
            .collect::<String>()
            .into_bytes();
        let (success, output) = self.call(
            &["cat-file", "--batch"],
            input,
            MAX_OBJECT_BYTES + requests.len() * 80,
        )?;
        if !success {
            return Err("Could not read the complete local Git object closure; fetch missing objects yourself before importing".into());
        }
        let mut cursor = 0;
        let mut total = 0usize;
        let mut objects = BTreeMap::new();
        for (id, expected_kind) in requests {
            let end = output[cursor..]
                .iter()
                .position(|byte| *byte == b'\n')
                .map(|offset| cursor + offset)
                .ok_or("Truncated Git object header")?;
            let header = std::str::from_utf8(&output[cursor..end])
                .map_err(|_| "Invalid Git object header")?;
            let parts: Vec<_> = header.split(' ').collect();
            if parts.len() != 3 || parts[0] != id || parts[1] != expected_kind {
                return Err("Missing or mismatched Git object; partial clones must be hydrated before import".into());
            }
            let size = parts[2]
                .parse::<usize>()
                .map_err(|_| "Invalid Git object size")?;
            total = total.checked_add(size).ok_or("Git object size overflow")?;
            if total > MAX_OBJECT_BYTES || size > MAX_BLOB_BYTES {
                return Err(
                    "Repository exceeds the 8 MiB object / 4 MiB blob import limits".into(),
                );
            }
            let start = end + 1;
            let after = start.checked_add(size).ok_or("Invalid Git object size")?;
            if after >= output.len() || output[after] != b'\n' {
                return Err("Truncated Git object".into());
            }
            let data = output[start..after].to_vec();
            if git_oid(expected_kind, &data) != *id {
                return Err("Git object hash verification failed".into());
            }
            objects.insert(
                id.clone(),
                Object {
                    oid: id.clone(),
                    kind: expected_kind.clone(),
                    data,
                },
            );
            cursor = after + 1;
        }
        if cursor != output.len() {
            return Err("Unexpected trailing Git object output".into());
        }
        Ok(objects)
    }
}

/// Read only immutable, pinned Git objects. No checkout, status, filter, hook,
/// package manager, remote, submodule traversal or repository script is run.
pub fn snapshot(path: &Path) -> Result<Snapshot> {
    let path =
        fs::canonicalize(path).map_err(|error| format!("Cannot open repository: {error}"))?;
    let mut git = Git { path };
    if git.text(&["rev-parse", "--is-bare-repository"], 8)? != "true" {
        git.path = PathBuf::from(git.text(&["rev-parse", "--show-toplevel"], 16 * 1024)?);
    }
    if git.text(&["rev-parse", "--show-object-format"], 32)? != "sha1" {
        return Err("This import format supports SHA-1 Git repositories; SHA-256 repositories are not converted".into());
    }
    let head = git.text(&["rev-parse", "--verify", "HEAD^{commit}"], 64)?;
    if !oid(&head) {
        return Err("A committed Git HEAD is required".into());
    }
    let (symbolic, branch_bytes) = git.call(
        &["symbolic-ref", "--quiet", "--short", "HEAD"],
        Vec::new(),
        1024,
    )?;
    let branch = if symbolic {
        Some(
            String::from_utf8(branch_bytes)
                .map_err(|_| "Branch name is not UTF-8")?
                .trim_end_matches('\n')
                .to_owned(),
        )
    } else {
        None
    };
    let mut requests = BTreeMap::from([(head.clone(), "commit".into())]);
    let commit = git.objects(&requests)?.remove(&head).unwrap();
    let header_end = commit
        .data
        .windows(2)
        .position(|bytes| bytes == b"\n\n")
        .ok_or("Malformed HEAD commit")?;
    let headers = commit.data[..header_end]
        .split(|byte| *byte == b'\n')
        .collect::<Vec<_>>();
    let parse_id = |bytes: &[u8]| {
        std::str::from_utf8(bytes)
            .ok()
            .filter(|id| oid(id))
            .map(str::to_owned)
            .ok_or("Malformed commit object reference".to_owned())
    };
    let roots = headers
        .iter()
        .filter_map(|line| line.strip_prefix(b"tree "))
        .map(parse_id)
        .collect::<Result<Vec<_>>>()?;
    let parents = headers
        .iter()
        .filter_map(|line| line.strip_prefix(b"parent "))
        .map(parse_id)
        .collect::<Result<Vec<_>>>()?;
    if roots.len() != 1 || !headers[0].starts_with(b"tree ") {
        return Err("Malformed HEAD tree reference".into());
    }
    requests.insert(roots[0].clone(), "tree".into());
    let listing = git.read(
        &["ls-tree", "--full-tree", "-r", "-t", "-z", &head],
        2 * 1024 * 1024,
    )?;
    let mut entries = Vec::new();
    let mut paths = BTreeSet::new();
    for row in listing
        .split(|byte| *byte == 0)
        .filter(|row| !row.is_empty())
    {
        let tab = row
            .iter()
            .position(|byte| *byte == b'\t')
            .ok_or("Malformed Git tree listing")?;
        let meta = std::str::from_utf8(&row[..tab]).map_err(|_| "Invalid Git tree metadata")?;
        let parts = meta.split(' ').collect::<Vec<_>>();
        if parts.len() != 3 || !oid(parts[2]) {
            return Err("Invalid Git tree identity".into());
        }
        let path = std::str::from_utf8(&row[tab + 1..])
            .map_err(|_| "Import paths must be UTF-8; no filenames were converted or skipped")?
            .to_owned();
        if path.split('/').count() > MAX_DEPTH + usize::from(parts[0] != "040000")
            || path.len() > 4096
        {
            return Err("Repository path exceeds import depth or byte limits".into());
        }
        if !paths.insert(path.clone()) {
            return Err("Duplicate Git tree path".into());
        }
        match (parts[0], parts[1]) {
            ("040000", "tree") => {}
            ("100644" | "100755" | "120000", "blob") | ("160000", "commit") => {
                if entries.len() >= MAX_FILES {
                    return Err("Repository exceeds the 4,096-file import limit".into());
                }
                entries.push(Entry {
                    path,
                    mode: parts[0].into(),
                    oid: parts[2].into(),
                    bytes: None,
                });
            }
            _ => return Err("Unsupported Git tree mode; no entries were omitted".into()),
        }
        if parts[0] != "160000"
            && let Some(prior) = requests.insert(parts[2].into(), parts[1].into())
            && prior != parts[1]
        {
            return Err("Git object has conflicting types".into());
        }
        if requests.len() > MAX_OBJECTS {
            return Err("Repository exceeds the 8,192-object import limit".into());
        }
    }
    let objects = git.objects(&requests)?;
    let mut warnings = vec!["Only the committed HEAD and its tree/blob closure are included; parent history is not transferred.".into()];
    let mut submodules = 0;
    let mut links = 0;
    let mut lfs = 0;
    let mut expanded_bytes = 0;
    for entry in &mut entries {
        if entry.mode == "160000" {
            submodules += 1;
        } else {
            let object = objects.get(&entry.oid).ok_or("Missing source blob")?;
            entry.bytes = Some(object.data.len());
            expanded_bytes += object.data.len();
            if expanded_bytes > MAX_OBJECT_BYTES {
                return Err("Repository expanded source exceeds the 8 MiB import limit".into());
            }
            if entry.mode == "120000" {
                links += 1;
            } else if object
                .data
                .starts_with(b"version https://git-lfs.github.com/spec/v1\n")
            {
                lfs += 1;
            }
        }
    }
    if submodules > 0 {
        warnings.push(format!("Submodule commit references: {submodules}; repository contents are not included or fetched."));
    }
    if links > 0 {
        warnings.push(format!(
            "Symbolic links: {links}; raw link text is preserved and never followed during import."
        ));
    }
    if lfs > 0 {
        warnings.push(format!(
            "Git LFS pointers: {lfs}; external contents are not uploaded or fetched."
        ));
    }
    if parents.len() > 1 {
        warnings.push("The original merge commit and all parent references are preserved; parent history is not embedded.".into());
    }
    let worktree = inspect_worktree(&git, &entries)?;
    if worktree.staged_paths
        + worktree.changed_paths
        + worktree.untracked_paths
        + worktree.ignored_paths
        + worktree.uninspected_paths
        > 0
    {
        warnings.push(format!("Excluded local state: {} staged, {} changed, {} untracked, {} ignored and {} uninspected paths. Import always uses committed HEAD.",
            worktree.staged_paths, worktree.changed_paths, worktree.untracked_paths, worktree.ignored_paths, worktree.uninspected_paths));
    }
    if git.text(&["rev-parse", "--verify", "HEAD^{commit}"], 64)? != head {
        return Err(
            "HEAD moved during inspection; run the command again to select a stable commit".into(),
        );
    }
    // Inventory repeats parent paths and JSON-escapes control characters.
    // Bound its serialized size independently of the unique Git object bytes.
    let inventory = serde_json::to_vec(&serde_json::json!({"head":head,"entries":entries}))
        .map_err(|error| error.to_string())?;
    if inventory.len() > crate::MAX_INVENTORY_BYTES {
        return Err("Source inventory exceeds the 16 MiB limit; no paths were omitted".into());
    }
    entries.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(Snapshot {
        head,
        branch,
        parents,
        objects,
        entries,
        worktree,
        warnings,
    })
}

fn count_rows(bytes: &[u8]) -> usize {
    bytes
        .split(|byte| *byte == 0)
        .filter(|row| !row.is_empty())
        .count()
}
fn inspect_worktree(git: &Git, entries: &[Entry]) -> Result<WorktreeState> {
    let bare = git.text(&["rev-parse", "--is-bare-repository"], 8)? == "true";
    let mut state = WorktreeState {
        bare,
        comparison: "raw bytes and executable modes; Git filters are not executed",
        ..WorktreeState::default()
    };
    if bare {
        return Ok(state);
    }
    let root = PathBuf::from(git.text(&["rev-parse", "--show-toplevel"], 16 * 1024)?);
    let listing = git.read(
        &["ls-files", "--full-name", "--stage", "-z"],
        2 * 1024 * 1024,
    )?;
    let mut index = BTreeMap::new();
    for row in listing
        .split(|byte| *byte == 0)
        .filter(|row| !row.is_empty())
    {
        let Some(tab) = row.iter().position(|byte| *byte == b'\t') else {
            return Err("Malformed Git index listing".into());
        };
        let fields = std::str::from_utf8(&row[..tab])
            .map_err(|_| "Invalid Git index metadata")?
            .split(' ')
            .collect::<Vec<_>>();
        let path = std::str::from_utf8(&row[tab + 1..])
            .map_err(|_| "Worktree index paths must be UTF-8")?
            .to_owned();
        if fields.len() != 3 {
            return Err("Malformed Git index metadata".into());
        }
        if fields[2] != "0" {
            state.uninspected_paths += 1;
        }
        index.insert(path, (fields[0].to_owned(), fields[1].to_owned()));
    }
    let heads = entries
        .iter()
        .map(|entry| (entry.path.clone(), (entry.mode.clone(), entry.oid.clone())))
        .collect::<BTreeMap<_, _>>();
    let all = heads.keys().chain(index.keys()).collect::<BTreeSet<_>>();
    state.staged_paths = all
        .iter()
        .filter(|path| heads.get(**path) != index.get(**path))
        .count();
    let mut inspected_bytes = 0;
    for (path, (mode, expected)) in &index {
        if mode == "160000" {
            state.uninspected_paths += 1;
            continue;
        }
        let components = Path::new(path).components().collect::<Vec<_>>();
        let mut current = root.clone();
        let mut inaccessible = false;
        for part in components.iter().take(components.len().saturating_sub(1)) {
            if !matches!(part, std::path::Component::Normal(_)) {
                inaccessible = true;
                break;
            }
            current.push(part);
            match fs::symlink_metadata(&current) {
                Ok(metadata) if metadata.file_type().is_dir() => {}
                _ => {
                    inaccessible = true;
                    break;
                }
            }
        }
        if inaccessible
            || components
                .last()
                .is_none_or(|part| !matches!(part, std::path::Component::Normal(_)))
        {
            state.uninspected_paths += 1;
            continue;
        }
        current.push(components.last().unwrap());
        let metadata = match fs::symlink_metadata(&current) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                state.changed_paths += 1;
                continue;
            }
            Err(_) => {
                state.uninspected_paths += 1;
                continue;
            }
        };
        let content = if mode == "120000" && metadata.file_type().is_symlink() {
            match fs::read_link(&current) {
                Ok(target) => {
                    #[cfg(unix)]
                    {
                        use std::os::unix::ffi::OsStrExt;
                        target.as_os_str().as_bytes().to_vec()
                    }
                    #[cfg(not(unix))]
                    {
                        target.to_string_lossy().as_bytes().to_vec()
                    }
                }
                Err(_) => {
                    state.uninspected_paths += 1;
                    continue;
                }
            }
        } else if metadata.file_type().is_file() && mode != "120000" {
            if metadata.len() > MAX_BLOB_BYTES as u64 {
                state.changed_paths += 1;
                continue;
            }
            inspected_bytes += metadata.len();
            if inspected_bytes > 32 * 1024 * 1024 {
                state.uninspected_paths += 1;
                continue;
            }
            // Recheck the opened handle's type; path traversal above excludes directory symlinks.
            let file = match fs::File::open(&current) {
                Ok(file) => file,
                Err(_) => {
                    state.uninspected_paths += 1;
                    continue;
                }
            };
            let mut bytes = Vec::new();
            if file
                .take(MAX_BLOB_BYTES as u64 + 1)
                .read_to_end(&mut bytes)
                .is_err()
            {
                state.uninspected_paths += 1;
                continue;
            }
            if bytes.len() > MAX_BLOB_BYTES {
                state.changed_paths += 1;
                continue;
            }
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                if (metadata.permissions().mode() & 0o111 != 0) != (mode == "100755") {
                    state.changed_paths += 1;
                    continue;
                }
            }
            bytes
        } else {
            state.changed_paths += 1;
            continue;
        };
        if git_oid("blob", &content) != *expected {
            state.changed_paths += 1;
        }
    }
    state.untracked_paths = count_rows(&git.read(
        &[
            "ls-files",
            "--full-name",
            "--others",
            "--directory",
            "--no-empty-directory",
            "--exclude-standard",
            "-z",
        ],
        2 * 1024 * 1024,
    )?);
    state.ignored_paths = count_rows(&git.read(
        &[
            "ls-files",
            "--full-name",
            "--others",
            "--ignored",
            "--directory",
            "--no-empty-directory",
            "--exclude-standard",
            "-z",
        ],
        2 * 1024 * 1024,
    )?);
    Ok(state)
}
