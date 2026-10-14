// SPDX-License-Identifier: Apache-2.0
use confidence_cli::{
    client::{error_code, target_origin, target_origin_mode},
    journal::{self, RequestRecord},
};
use serde_json::json;
use std::fs;

fn record() -> RequestRecord {
    RequestRecord {
        schema_version: 1,
        target: "https://pilot.example.invalid".into(),
        principal_id: "issuer#human".into(),
        local_development: false,
        command_id: "a".repeat(32),
        route: "/api/projects/project-1/import".into(),
        expected_revision: Some("7".into()),
        expected_incarnation: Some("incarnation-1".into()),
        body: json!({"archive":{"head":"exact","privateSource":"retained for identical replay"}}),
    }
}
#[test]
fn request_journal_is_exclusive_private_and_preserves_exact_replay_intent() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("request.json");
    let request = record();
    journal::create(&path, &request).unwrap();
    assert!(journal::create(&path, &request).is_err());
    let retained = journal::read(&path).unwrap();
    assert_eq!(
        serde_json::to_value(retained).unwrap(),
        serde_json::to_value(request).unwrap()
    );
    let original = fs::read(&path).unwrap();
    journal::record_response(&path, 200, &json!({"revision":"8"})).unwrap();
    assert_eq!(fs::read(&path).unwrap(), original);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
}
#[test]
fn resume_rejects_route_substitution_duplicate_fields_and_incomplete_scope() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("request.json");
    let mut request = record();
    request.route = "/api/publish".into();
    fs::write(&path, serde_json::to_vec(&request).unwrap()).unwrap();
    assert!(journal::read(&path).is_err());
    request = record();
    request.expected_revision = None;
    fs::write(&path, serde_json::to_vec(&request).unwrap()).unwrap();
    assert!(journal::read(&path).is_err());
    let json = serde_json::to_string(&record())
        .unwrap()
        .replacen("{", "{\"schemaVersion\":1,", 1);
    fs::write(&path, json).unwrap();
    assert!(journal::read(&path).is_err());
}
#[test]
fn remote_targets_are_https_exact_origins_and_local_mode_is_loopback_only() {
    assert_eq!(
        target_origin("https://pilot.example.invalid/").unwrap(),
        "https://pilot.example.invalid"
    );
    for target in [
        "http://pilot.example.invalid",
        "https://user:password@pilot.example.invalid",
        "https://pilot.example.invalid/path",
        "https://pilot.example.invalid?token=private",
        "https://pilot.example.invalid/#/projects",
    ] {
        assert!(target_origin(target).is_err(), "{target}");
    }
    for target in [
        "http://example.invalid:8787",
        "http://127.0.0.1.example.invalid:8787",
        "https://127.0.0.1:8787",
    ] {
        assert!(target_origin_mode(target, true).is_err(), "{target}");
    }
    assert_eq!(
        target_origin_mode("http://127.0.0.1:8787", true).unwrap(),
        "http://127.0.0.1:8787"
    );
}
#[test]
fn remote_and_local_error_codes_are_reported_without_provider_message_leakage() {
    assert_eq!(
        error_code(
            &json!({"error":{"code":"PROJECT_REVISION_CHANGED","message":"private detail"}})
        ),
        "PROJECT_REVISION_CHANGED"
    );
    assert_eq!(
        error_code(&json!({"error":"PROJECT_ARCHIVED"})),
        "PROJECT_ARCHIVED"
    );
    assert_eq!(
        error_code(&json!({"error":"private token: abc"})),
        "UNEXPECTED_RESPONSE"
    );
}
