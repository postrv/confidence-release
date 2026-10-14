// SPDX-License-Identifier: Apache-2.0
use base64::{Engine, engine::general_purpose::STANDARD};
use confidence_cli::{
    archive::RepositoryArchive,
    checks,
    repository::{self, git_oid},
};
use std::{fs, path::Path, process::Command};
use tempfile::TempDir;

fn git(path: &Path, args: &[&str]) -> String {
    let output = Command::new("git")
        .current_dir(path)
        .args(args)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_AUTHOR_NAME", "CLI test")
        .env("GIT_AUTHOR_EMAIL", "cli@example.invalid")
        .env("GIT_COMMITTER_NAME", "CLI test")
        .env("GIT_COMMITTER_EMAIL", "cli@example.invalid")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap().trim().into()
}
fn init() -> TempDir {
    let directory = tempfile::tempdir().unwrap();
    git(directory.path(), &["init", "-b", "main"]);
    directory
}
fn commit(path: &Path) {
    git(path, &["add", "."]);
    git(path, &["commit", "-m", "fixture"]);
}

#[test]
fn archive_preserves_exact_head_binary_executable_unicode_and_private_worktree_exclusions() {
    let directory = init();
    let path = directory.path();
    fs::write(path.join("data.bin"), [0, 255, 128, 10, 13]).unwrap();
    fs::write(path.join("hello world-λ.txt"), "committed\n").unwrap();
    fs::write(path.join("run.sh"), "#!/bin/sh\nexit 0\n").unwrap();
    fs::write(path.join(".gitignore"), "ignored.txt\n").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path.join("run.sh"), fs::Permissions::from_mode(0o755)).unwrap();
    }
    commit(path);
    let head = git(path, &["rev-parse", "HEAD"]);
    fs::write(path.join("hello world-λ.txt"), "never upload dirty text\n").unwrap();
    fs::write(path.join("untracked.txt"), "never upload untracked text\n").unwrap();
    fs::write(path.join("ignored.txt"), "never upload ignored text\n").unwrap();
    let snapshot = repository::snapshot(path).unwrap();
    assert_eq!(snapshot.head, head);
    assert_eq!(snapshot.worktree.changed_paths, 1);
    assert_eq!(snapshot.worktree.untracked_paths, 1);
    assert_eq!(snapshot.worktree.ignored_paths, 1);
    assert_eq!(snapshot.worktree.staged_paths, 0);
    assert_eq!(snapshot.entries.len(), 4);
    for object in snapshot.objects.values() {
        assert_eq!(object.oid, git_oid(&object.kind, &object.data));
    }
    let archive = RepositoryArchive::from_snapshot(&snapshot);
    for object in &archive.objects {
        let data = STANDARD.decode(&object.data_base64).unwrap();
        assert!(!String::from_utf8_lossy(&data).contains("never upload"));
    }
    let binary = snapshot
        .entries
        .iter()
        .find(|entry| entry.path == "data.bin")
        .unwrap();
    assert_eq!(snapshot.objects[&binary.oid].data, [0, 255, 128, 10, 13]);
    #[cfg(unix)]
    assert_eq!(
        snapshot
            .entries
            .iter()
            .find(|entry| entry.path == "run.sh")
            .unwrap()
            .mode,
        "100755"
    );
}

#[test]
#[cfg(unix)]
fn symlinks_gitlinks_and_lfs_are_preserved_without_following_or_fetching() {
    use std::os::unix::fs::symlink;
    let directory = init();
    let path = directory.path();
    fs::write(path.join("base"), "original").unwrap();
    commit(path);
    let first = git(path, &["rev-parse", "HEAD"]);
    symlink(
        "/definitely-not-read/external-secret",
        path.join("external-link"),
    )
    .unwrap();
    fs::write(
        path.join("large.asset"),
        format!(
            "version https://git-lfs.github.com/spec/v1\noid sha256:{}\nsize 100000000\n",
            "a".repeat(64)
        ),
    )
    .unwrap();
    git(path, &["add", "."]);
    git(
        path,
        &[
            "update-index",
            "--add",
            "--cacheinfo",
            &format!("160000,{first},submodule"),
        ],
    );
    git(path, &["commit", "-m", "links"]);
    let snapshot = repository::snapshot(path).unwrap();
    let link = snapshot
        .entries
        .iter()
        .find(|entry| entry.path == "external-link")
        .unwrap();
    assert_eq!(link.mode, "120000");
    assert_eq!(
        snapshot.objects[&link.oid].data,
        b"/definitely-not-read/external-secret"
    );
    let module = snapshot
        .entries
        .iter()
        .find(|entry| entry.path == "submodule")
        .unwrap();
    assert_eq!(module.mode, "160000");
    assert_eq!(module.oid, first);
    assert_eq!(module.bytes, None);
    assert!(!snapshot.objects.contains_key(&first));
    assert!(
        snapshot
            .warnings
            .iter()
            .any(|warning| warning.contains("LFS pointer"))
    );
    assert!(
        snapshot
            .warnings
            .iter()
            .any(|warning| warning.contains("Submodule"))
    );
}

#[test]
fn merge_commit_identity_and_parents_survive_without_history_rewrite() {
    let directory = init();
    let path = directory.path();
    fs::write(path.join("base"), "base").unwrap();
    commit(path);
    let base = git(path, &["rev-parse", "HEAD"]);
    git(path, &["checkout", "-b", "side"]);
    fs::write(path.join("side"), "side").unwrap();
    commit(path);
    let side = git(path, &["rev-parse", "HEAD"]);
    git(path, &["checkout", "main"]);
    fs::write(path.join("main"), "main").unwrap();
    commit(path);
    let main = git(path, &["rev-parse", "HEAD"]);
    git(path, &["merge", "--no-ff", "side", "-m", "merge"]);
    let head = git(path, &["rev-parse", "HEAD"]);
    let snapshot = repository::snapshot(path).unwrap();
    assert_eq!(snapshot.head, head);
    assert_eq!(snapshot.parents, [main.clone(), side.clone()]);
    assert!(!snapshot.objects.contains_key(&base));
    assert!(!snapshot.objects.contains_key(&main));
    assert!(!snapshot.objects.contains_key(&side));
    assert_eq!(
        snapshot
            .objects
            .values()
            .filter(|object| object.kind == "commit")
            .count(),
        1
    );
}

#[test]
#[cfg(unix)]
fn inspection_does_not_run_clean_filters_fsmonitor_hooks_or_package_scripts() {
    use std::os::unix::fs::PermissionsExt;
    let directory = init();
    let path = directory.path();
    fs::write(path.join("file"), "base").unwrap();
    fs::write(path.join(".gitattributes"), "file filter=tripwire\n").unwrap();
    fs::write(
        path.join("package.json"),
        r#"{"scripts":{"test":"touch EXECUTED"}}"#,
    )
    .unwrap();
    commit(path);
    let script = path.join("tripwire.sh");
    fs::write(&script, "#!/bin/sh\ntouch EXECUTED\ncat\n").unwrap();
    fs::set_permissions(&script, fs::Permissions::from_mode(0o755)).unwrap();
    git(
        path,
        &["config", "filter.tripwire.clean", script.to_str().unwrap()],
    );
    git(path, &["config", "filter.tripwire.required", "true"]);
    git(
        path,
        &["config", "core.fsmonitor", script.to_str().unwrap()],
    );
    fs::copy(&script, path.join(".git/hooks/post-checkout")).unwrap();
    fs::write(path.join("file"), "modified to force any status refresh").unwrap();
    let snapshot = repository::snapshot(path).unwrap();
    assert_eq!(snapshot.worktree.changed_paths, 1);
    assert!(!path.join("EXECUTED").exists());
    assert_eq!(checks::discover(&snapshot)[0].argv, ["npm", "run", "test"]);
}

#[test]
fn check_discovery_reads_committed_manifests_and_never_uses_dirty_replacements() {
    let directory = init();
    let path = directory.path();
    fs::write(
        path.join("package.json"),
        r#"{"packageManager":"pnpm@10.1.0","scripts":{"test":"anything","typecheck":"anything"}}"#,
    )
    .unwrap();
    fs::write(path.join("Cargo.toml"), "[workspace]\nmembers=[]\n").unwrap();
    fs::write(path.join("Cargo.lock"), "version=4\n").unwrap();
    fs::write(path.join("go.mod"), "module example.invalid/app\n").unwrap();
    fs::write(path.join("pytest.ini"), "[pytest]\n").unwrap();
    fs::write(path.join("test_app.py"), "assert True\n").unwrap();
    commit(path);
    fs::write(path.join("package.json"), r#"{"scripts":{"build":"evil"}}"#).unwrap();
    let discovered = checks::discover(&repository::snapshot(path).unwrap());
    assert_eq!(discovered.len(), 6);
    assert_eq!(discovered[0].argv, ["pnpm", "run", "test"]);
    assert!(
        discovered
            .iter()
            .any(|check| check.argv == ["cargo", "test", "--workspace", "--locked"])
    );
    assert!(
        discovered
            .iter()
            .all(|check| check.evidence_class == "repository-check")
    );
    assert!(
        discovered
            .iter()
            .all(|check| check.argv.last().unwrap() != "build")
    );
}

#[test]
fn too_large_blob_is_rejected_without_partial_archive() {
    let directory = init();
    let path = directory.path();
    fs::write(
        path.join("oversized"),
        vec![0u8; confidence_cli::MAX_BLOB_BYTES + 1],
    )
    .unwrap();
    commit(path);
    assert!(
        repository::snapshot(path)
            .unwrap_err()
            .contains("4 MiB blob")
    );
}

#[test]
fn bare_repository_and_detached_head_are_supported() {
    let directory = init();
    let path = directory.path();
    fs::write(path.join("file"), "source").unwrap();
    commit(path);
    git(path, &["checkout", "--detach"]);
    assert_eq!(repository::snapshot(path).unwrap().branch, None);
    let bare = tempfile::tempdir().unwrap();
    git(
        path,
        &[
            "clone",
            "--bare",
            path.to_str().unwrap(),
            bare.path().join("repo.git").to_str().unwrap(),
        ],
    );
    let snapshot = repository::snapshot(&bare.path().join("repo.git")).unwrap();
    assert!(snapshot.worktree.bare);
}
