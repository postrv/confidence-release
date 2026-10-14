// SPDX-License-Identifier: Apache-2.0
use crate::repository::Snapshot;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectCheck {
    pub id: String,
    pub name: String,
    pub argv: Vec<String>,
    pub cwd: String,
    pub timeout_seconds: u32,
    pub required: bool,
    pub enabled: bool,
    pub source: String,
    pub evidence_class: String,
}
fn check(id: &str, name: &str, argv: &[&str], cwd: &str) -> ProjectCheck {
    ProjectCheck {
        id: id.into(),
        name: name.into(),
        argv: argv.iter().map(|arg| (*arg).into()).collect(),
        cwd: cwd.into(),
        timeout_seconds: 300,
        required: true,
        enabled: true,
        source: "detected".into(),
        evidence_class: "repository-check".into(),
    }
}
fn file<'a>(snapshot: &'a Snapshot, path: &str) -> Option<&'a [u8]> {
    let entry = snapshot
        .entries
        .iter()
        .find(|entry| entry.path == path && matches!(entry.mode.as_str(), "100644" | "100755"))?;
    Some(snapshot.objects.get(&entry.oid)?.data.as_slice())
}

/// Derive executable argv without running a package manager or trusting any
/// repository command as protected behavioural evidence. The target controls execution.
pub fn discover(snapshot: &Snapshot) -> Vec<ProjectCheck> {
    let mut checks = Vec::new();
    if let Some(bytes) = file(snapshot, "package.json")
        && let Ok(package) = serde_json::from_slice::<serde_json::Value>(bytes)
    {
        let manager = package
            .get("packageManager")
            .and_then(|value| value.as_str())
            .and_then(|value| value.split_once('@').map(|pair| pair.0))
            .filter(|manager| matches!(*manager, "npm" | "pnpm" | "yarn" | "bun"))
            .unwrap_or_else(|| {
                if file(snapshot, "pnpm-lock.yaml").is_some() {
                    "pnpm"
                } else if file(snapshot, "yarn.lock").is_some() {
                    "yarn"
                } else if file(snapshot, "bun.lock").is_some()
                    || file(snapshot, "bun.lockb").is_some()
                {
                    "bun"
                } else {
                    "npm"
                }
            });
        if let Some(scripts) = package
            .get("scripts")
            .and_then(|scripts| scripts.as_object())
        {
            for (script, name) in [
                ("test", "Tests"),
                ("test:unit", "Unit tests"),
                ("lint", "Lint"),
                ("typecheck", "Type checking"),
                ("check", "Checks"),
                ("build", "Build"),
            ] {
                if scripts.get(script).is_some_and(|value| {
                    value.as_str().is_some_and(|value| !value.trim().is_empty())
                }) {
                    checks.push(check(
                        &format!("node-{}", script.replace(':', "-")),
                        name,
                        &[manager, "run", script],
                        ".",
                    ));
                }
            }
        }
    }
    if file(snapshot, "Cargo.toml").is_some() {
        let locked = file(snapshot, "Cargo.lock").is_some();
        let mut test = vec!["cargo", "test", "--workspace"];
        let mut build = vec!["cargo", "check", "--workspace"];
        if locked {
            test.push("--locked");
            build.push("--locked");
        }
        checks.push(check("rust-test", "Rust tests", &test, "."));
        checks.push(check("rust-check", "Rust compilation", &build, "."));
    }
    if file(snapshot, "go.mod").is_some() {
        checks.push(check("go-test", "Go tests", &["go", "test", "./..."], "."));
    }
    let python_tests = snapshot.entries.iter().any(|entry| {
        entry.path.ends_with(".py")
            && (entry.path.starts_with("tests/")
                || entry.path.starts_with("test_")
                || entry.path.ends_with("_test.py"))
    });
    if python_tests
        && [
            "pyproject.toml",
            "pytest.ini",
            "setup.cfg",
            "requirements.txt",
        ]
        .iter()
        .any(|path| file(snapshot, path).is_some())
    {
        checks.push(check(
            "python-test",
            "Python tests",
            &["python", "-m", "pytest"],
            ".",
        ));
    }
    checks
}
