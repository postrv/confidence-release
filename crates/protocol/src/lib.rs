//! Bounded, side-effect-free interpretation shared by Worker, browser and CLI.
use base64::{Engine as _, engine::general_purpose::STANDARD as B64};
use ed25519_dalek::{Signature, VerifyingKey};
use serde::{
    Deserialize, Serialize,
    de::{self, MapAccess, SeqAccess, Visitor},
};
use serde_json::{Value, json};
use sha2::{Digest as _, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fmt,
};
use wasm_bindgen::prelude::*;
mod capability;
pub use capability::{budget_transition, grant_inclusion, validate_grant};
mod composition;
pub use composition::{compose_manifests, transplant_manifest};
mod execution;
pub use execution::transition_execution;

pub const MAX_JSON_BYTES: usize = 32 * 1024 * 1024;
const MAX_FILES: usize = 2048;
const MAX_SOURCE_BYTES: usize = 16 * 1024 * 1024;
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Debug)]
struct Strict(Value);
impl<'de> Deserialize<'de> for Strict {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct V;
        impl<'de> Visitor<'de> for V {
            type Value = Strict;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("bounded JSON without duplicate members or floats")
            }
            fn visit_bool<E: de::Error>(self, v: bool) -> Result<Strict, E> {
                Ok(Strict(Value::Bool(v)))
            }
            fn visit_unit<E: de::Error>(self) -> Result<Strict, E> {
                Ok(Strict(Value::Null))
            }
            fn visit_i64<E: de::Error>(self, v: i64) -> Result<Strict, E> {
                if v.unsigned_abs() > MAX_SAFE_INTEGER {
                    return Err(E::custom("NONCANONICAL_NUMBER"));
                }
                Ok(Strict(json!(v)))
            }
            fn visit_u64<E: de::Error>(self, v: u64) -> Result<Strict, E> {
                if v > MAX_SAFE_INTEGER {
                    return Err(E::custom("NONCANONICAL_NUMBER"));
                }
                Ok(Strict(json!(v)))
            }
            fn visit_f64<E: de::Error>(self, _: f64) -> Result<Strict, E> {
                Err(E::custom("NONCANONICAL_NUMBER"))
            }
            fn visit_str<E: de::Error>(self, v: &str) -> Result<Strict, E> {
                Ok(Strict(json!(v)))
            }
            fn visit_string<E: de::Error>(self, v: String) -> Result<Strict, E> {
                Ok(Strict(json!(v)))
            }
            fn visit_seq<A: SeqAccess<'de>>(self, mut a: A) -> Result<Strict, A::Error> {
                let mut out = Vec::new();
                while let Some(Strict(v)) = a.next_element()? {
                    if out.len() >= 16384 {
                        return Err(de::Error::custom("ARRAY_LIMIT"));
                    }
                    out.push(v);
                }
                Ok(Strict(Value::Array(out)))
            }
            fn visit_map<A: MapAccess<'de>>(self, mut a: A) -> Result<Strict, A::Error> {
                let mut out = serde_json::Map::new();
                while let Some(k) = a.next_key::<String>()? {
                    if out.contains_key(&k) {
                        return Err(de::Error::custom("DUPLICATE_MEMBER"));
                    }
                    let Strict(v) = a.next_value()?;
                    out.insert(k, v);
                    if out.len() > 256 {
                        return Err(de::Error::custom("OBJECT_LIMIT"));
                    }
                }
                Ok(Strict(Value::Object(out)))
            }
        }
        d.deserialize_any(V)
    }
}
pub fn decode(input: &str) -> Result<Value, String> {
    if input.len() > MAX_JSON_BYTES {
        return Err("JSON_SIZE_LIMIT".into());
    }
    serde_json::from_str::<Strict>(input)
        .map(|x| x.0)
        .map_err(|e| e.to_string())
}
pub fn canonical(value: &Value) -> String {
    match value {
        Value::Array(a) => format!(
            "[{}]",
            a.iter().map(canonical).collect::<Vec<_>>().join(",")
        ),
        Value::Object(o) => {
            let mut keys: Vec<_> = o.keys().collect();
            keys.sort_by_key(|x| x.encode_utf16().collect::<Vec<_>>());
            format!(
                "{{{}}}",
                keys.iter()
                    .map(|k| format!(
                        "{}:{}",
                        serde_json::to_string(k).unwrap(),
                        canonical(&o[*k])
                    ))
                    .collect::<Vec<_>>()
                    .join(",")
            )
        }
        _ => serde_json::to_string(value).unwrap(),
    }
}
pub fn hash(bytes: &[u8]) -> String {
    format!("sha256:{}", hex::encode(Sha256::digest(bytes)))
}
pub fn value_digest(v: &Value) -> String {
    hash(canonical(v).as_bytes())
}
fn digest_without<T: Serialize>(v: &T, field: &str) -> String {
    let mut value = serde_json::to_value(v).unwrap();
    value.as_object_mut().unwrap().remove(field);
    value_digest(&value)
}
fn digest_ok(s: &str) -> bool {
    s.len() == 71
        && s.starts_with("sha256:")
        && s[7..]
            .bytes()
            .all(|x| x.is_ascii_digit() || (b'a'..=b'f').contains(&x))
}
fn oid_ok(s: &str) -> bool {
    s.len() == 40
        && s.bytes()
            .all(|x| x.is_ascii_digit() || (b'a'..=b'f').contains(&x))
}
fn counter(s: &str) -> Result<u64, String> {
    if s.is_empty()
        || s.len() > 20
        || (s.len() > 1 && s.starts_with('0'))
        || !s.bytes().all(|b| b.is_ascii_digit())
    {
        return Err("INVALID_COUNTER".into());
    }
    s.parse().map_err(|_| "COUNTER_OVERFLOW".into())
}
fn increment(s: &str) -> Result<String, String> {
    counter(s)?
        .checked_add(1)
        .map(|x| x.to_string())
        .ok_or("COUNTER_OVERFLOW".into())
}
fn bounded_id(s: &str) -> bool {
    !s.is_empty() && s.len() <= 160 && s.bytes().all(|b| b.is_ascii_graphic())
}
fn parse<T: for<'a> Deserialize<'a>>(s: &str) -> Result<T, String> {
    serde_json::from_value(decode(s)?).map_err(|e| e.to_string())
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Scope {
    pub schema_version: u8,
    pub tenant_id: String,
    pub project_id: String,
    pub project_incarnation: String,
}
impl Scope {
    fn valid(&self) -> bool {
        self.schema_version == 1
            && [&self.tenant_id, &self.project_id, &self.project_incarnation]
                .iter()
                .all(|x| bounded_id(x))
    }
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ManifestEntry {
    pub path: String,
    pub mode: String,
    pub bytes: String,
    pub digest: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Manifest {
    pub schema_version: u8,
    pub path_profile: String,
    pub entries: Vec<ManifestEntry>,
}

pub fn valid_path(path: &str) -> Result<(), String> {
    if path.is_empty() || path.len() > 240 || !path.bytes().all(|b| (32..127).contains(&b)) {
        return Err("UNSUPPORTED_PATH".into());
    }
    for component in path.split('/') {
        if component.is_empty()
            || component.len() > 80
            || matches!(component, "." | "..")
            || component.ends_with([' ', '.'])
            || component.eq_ignore_ascii_case(".git")
            || component.bytes().any(|b| b"\\<>:\"|?*".contains(&b))
        {
            return Err("UNSUPPORTED_PATH".into());
        }
        let base = component.split('.').next().unwrap().to_ascii_uppercase();
        if matches!(base.as_str(), "CON" | "PRN" | "AUX" | "NUL")
            || (base.len() == 4
                && (base.starts_with("COM") || base.starts_with("LPT"))
                && matches!(base.as_bytes()[3], b'1'..=b'9'))
        {
            return Err("DEVICE_PATH".into());
        }
    }
    Ok(())
}
pub fn check_manifest(m: &Manifest) -> Result<(), String> {
    if m.schema_version != 1 || m.path_profile != "portable-ascii-v1" {
        return Err("UNSUPPORTED_MANIFEST".into());
    }
    if m.entries.len() > MAX_FILES {
        return Err("FILE_COUNT_LIMIT".into());
    }
    let mut previous: Option<&str> = None;
    let mut prefixes = BTreeMap::<String, String>::new();
    let mut paths = BTreeSet::new();
    let mut total = 0u64;
    let mut path_bytes = 0;
    for e in &m.entries {
        valid_path(&e.path)?;
        if previous.is_some_and(|p| p >= e.path.as_str()) {
            return Err("MANIFEST_ORDER_OR_DUPLICATE".into());
        }
        previous = Some(&e.path);
        if !matches!(e.mode.as_str(), "100644" | "100755") {
            return Err("UNSUPPORTED_MODE".into());
        }
        if !digest_ok(&e.digest) {
            return Err("INVALID_DIGEST".into());
        }
        let bytes = counter(&e.bytes)?;
        if bytes > 1024 * 1024 {
            return Err("FILE_SIZE_LIMIT".into());
        }
        total = total.checked_add(bytes).ok_or("SOURCE_SIZE_LIMIT")?;
        path_bytes += e.path.len();
        if total > MAX_SOURCE_BYTES as u64 || path_bytes > 65536 {
            return Err("SOURCE_SIZE_LIMIT".into());
        }
        let mut p = String::new();
        let comps: Vec<_> = e.path.split('/').collect();
        for (i, c) in comps.iter().enumerate() {
            if i > 0 {
                p.push('/');
            }
            p.push_str(c);
            let folded = p.to_ascii_lowercase();
            if prefixes.get(&folded).is_some_and(|old| old != &p) {
                return Err("CASE_PREFIX_COLLISION".into());
            }
            prefixes.insert(folded, p.clone());
            if i + 1 < comps.len() && paths.contains(&p) {
                return Err("FILE_DIRECTORY_COLLISION".into());
            }
        }
        paths.insert(e.path.clone());
    }
    Ok(())
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Role {
    pub id: String,
    pub can_publish: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Reviewer {
    pub id: String,
    pub can_approve: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Approval {
    pub proposal_digest: String,
    pub reviewer_id: String,
    pub expires_at: u64,
    pub consumed_by: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct State {
    pub scope: Scope,
    pub revision: String,
    pub head: String,
    pub gate: String,
    pub policy_revision: String,
    pub goal_revision: String,
    pub observation_revision: String,
    pub publication_sequence: String,
    pub unresolved_publication_id: Option<String>,
    pub sponsor: Role,
    pub reviewer: Reviewer,
    pub approval: Approval,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Proposal {
    pub schema_version: u8,
    pub scope: Scope,
    pub candidate_id: String,
    pub candidate_digest: String,
    pub expected_head: String,
    pub new_head: String,
    pub manifest_digest: String,
    pub goal_revision: String,
    pub policy_revision: String,
    pub observation_revision: String,
    pub plan_digest: String,
    pub evidence_digests: Vec<String>,
    pub required_evidence_class: String,
    pub expires_at: u64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Candidate {
    pub id: String,
    pub digest: String,
    pub commit: String,
    pub commit_bytes_digest: String,
    pub parent: String,
    pub manifest_digest: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Job {
    pub id: String,
    pub input_digest: String,
    pub required: bool,
    pub evidence_class: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Plan {
    pub digest: String,
    pub candidate_id: String,
    pub candidate_digest: String,
    pub jobs: Vec<Job>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Evidence {
    pub id: String,
    pub digest: String,
    pub job_id: String,
    pub input_digest: String,
    pub observation_digest: String,
    pub candidate_id: String,
    pub candidate_digest: String,
    pub outcome: String,
    pub evidence_class: String,
    pub authorized: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Command {
    pub id: String,
    pub caller_id: String,
    pub proposal_digest: String,
    pub expected_revision: String,
    pub operation_id: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AdmissionInput {
    pub state: State,
    pub proposal: Proposal,
    pub candidate: Candidate,
    pub plan: Plan,
    pub evidence: Vec<Evidence>,
    pub command: Command,
    pub now: u64,
}

pub fn admit(i: &AdmissionInput) -> Result<Value, String> {
    let s = &i.state;
    let p = &i.proposal;
    let c = &i.candidate;
    let cmd = &i.command;
    if !s.scope.valid() || p.schema_version != 1 || s.scope != p.scope {
        return Err("SCOPE_MISMATCH".into());
    }
    if i.now > 253402300799 || p.expires_at > 253402300799 || s.approval.expires_at > 253402300799 {
        return Err("INVALID_TIME".into());
    }
    for n in [
        &s.revision,
        &s.policy_revision,
        &s.goal_revision,
        &s.observation_revision,
        &s.publication_sequence,
        &cmd.expected_revision,
    ] {
        counter(n)?;
    }
    if [
        &c.id,
        &cmd.id,
        &cmd.operation_id,
        &cmd.caller_id,
        &s.sponsor.id,
        &s.reviewer.id,
    ]
    .iter()
    .any(|x| !bounded_id(x))
    {
        return Err("INVALID_ID".into());
    }
    if [&s.head, &p.expected_head, &p.new_head, &c.commit, &c.parent]
        .iter()
        .any(|x| !oid_ok(x))
    {
        return Err("INVALID_GIT_ID".into());
    }
    if [
        &p.candidate_digest,
        &p.manifest_digest,
        &p.plan_digest,
        &cmd.proposal_digest,
        &c.digest,
        &c.manifest_digest,
        &c.commit_bytes_digest,
    ]
    .iter()
    .any(|x| !digest_ok(x))
    {
        return Err("INVALID_DIGEST".into());
    }
    if s.gate != "OPEN" {
        return Err("ADMISSIONS_CLOSED".into());
    }
    if s.unresolved_publication_id.is_some() {
        return Err("PUBLICATION_UNRESOLVED".into());
    }
    if !s.sponsor.can_publish || cmd.caller_id != s.sponsor.id {
        return Err("SPONSOR_UNAUTHORIZED".into());
    }
    if !s.reviewer.can_approve || s.approval.reviewer_id != s.reviewer.id {
        return Err("REVIEWER_UNAUTHORIZED".into());
    }
    if cmd.expected_revision != s.revision {
        return Err("STALE_REVISION".into());
    }
    if p.expected_head != s.head
        || c.parent != s.head
        || p.new_head != c.commit
        || c.commit == s.head
    {
        return Err("STALE_OR_INVALID_HEAD".into());
    }
    if p.policy_revision != s.policy_revision || p.goal_revision != s.goal_revision {
        return Err("STALE_POLICY_OR_GOAL".into());
    }
    if p.observation_revision != s.observation_revision {
        return Err("STALE_OBSERVATION".into());
    }
    if s.approval.consumed_by.is_some() {
        return Err("APPROVAL_CONSUMED".into());
    }
    if i.now >= p.expires_at || i.now >= s.approval.expires_at {
        return Err("APPROVAL_EXPIRED".into());
    }
    let proposal_digest = value_digest(&serde_json::to_value(p).unwrap());
    if cmd.proposal_digest != proposal_digest || s.approval.proposal_digest != proposal_digest {
        return Err("APPROVAL_MISMATCH".into());
    }
    if p.candidate_id != c.id
        || p.candidate_digest != c.digest
        || p.manifest_digest != c.manifest_digest
    {
        return Err("CANDIDATE_MISMATCH".into());
    }
    let plan = &i.plan;
    if p.plan_digest != plan.digest
        || plan.candidate_id != c.id
        || plan.candidate_digest != c.digest
        || plan.digest != digest_without(plan, "digest")
    {
        return Err("PLAN_MISMATCH".into());
    }
    if plan.jobs.is_empty()
        || plan.jobs.len() > 32
        || i.evidence.len() > 128
        || p.evidence_digests.len() > 128
    {
        return Err("PLAN_LIMIT".into());
    }
    if p.evidence_digests.windows(2).any(|x| x[0] >= x[1]) {
        return Err("EVIDENCE_SET_ORDER".into());
    }
    if !matches!(
        p.required_evidence_class.as_str(),
        "protected-behavioural" | "repository-check"
    ) {
        return Err("REQUIRED_CLASS_INVALID".into());
    }
    let mut jobs = BTreeSet::new();
    let mut required_class_present = false;
    for j in &plan.jobs {
        if !bounded_id(&j.id)
            || !digest_ok(&j.input_digest)
            || !matches!(
                j.evidence_class.as_str(),
                "protected-behavioural" | "repository-check"
            )
            || !jobs.insert(&j.id)
        {
            return Err("INVALID_JOB".into());
        }
        if j.required && j.evidence_class == p.required_evidence_class {
            required_class_present = true;
        }
    }
    if !required_class_present {
        return Err("PROTECTED_EVIDENCE_REQUIRED".into());
    }
    let mut seen = BTreeMap::new();
    let mut selected = BTreeSet::new();
    for e in &i.evidence {
        if !bounded_id(&e.id)
            || !digest_ok(&e.digest)
            || !digest_ok(&e.input_digest)
            || !digest_ok(&e.observation_digest)
            || e.digest != digest_without(e, "digest")
        {
            return Err("EVIDENCE_IDENTITY_INVALID".into());
        }
        if e.candidate_id != c.id || e.candidate_digest != c.digest {
            return Err("EVIDENCE_SUBJECT_MISMATCH".into());
        }
        if !e.authorized {
            return Err("EVIDENCE_PRODUCER_UNAUTHORIZED".into());
        }
        if !matches!(
            e.outcome.as_str(),
            "PASS" | "FAIL" | "ERROR" | "TIMEOUT" | "CANCELLED" | "INCONCLUSIVE"
        ) {
            return Err("INVALID_OUTCOME".into());
        }
        if let Some(previous) = seen.insert(&e.job_id, &e.digest) {
            if previous != &e.digest {
                return Err("CONFLICTING_JOB_EVIDENCE".into());
            }
            return Err("DUPLICATE_JOB_EVIDENCE".into());
        }
        if e.outcome == "FAIL" {
            return Err("CONTRADICTORY_FAILURE".into());
        }
        if !selected.insert(&e.digest) {
            return Err("DUPLICATE_EVIDENCE".into());
        }
    }
    if selected.iter().map(|x| (*x).clone()).collect::<Vec<_>>() != p.evidence_digests {
        return Err("EVIDENCE_SET_MISMATCH".into());
    }
    for j in plan.jobs.iter().filter(|j| j.required) {
        let e = i
            .evidence
            .iter()
            .find(|e| e.job_id == j.id)
            .ok_or("MISSING_REQUIRED_EVIDENCE")?;
        if e.outcome != "PASS"
            || e.input_digest != j.input_digest
            || e.evidence_class != j.evidence_class
        {
            return Err("REQUIRED_EVIDENCE_NOT_PASS".into());
        }
    }
    Ok(
        json!({"accepted":true,"reason":"ADMITTED","delta":{"revision":increment(&s.revision)?,"sequence":increment(&s.publication_sequence)?,"head":s.head,"approvalConsumedBy":cmd.operation_id,"unresolvedPublicationId":cmd.operation_id},"effects":[{"kind":"prepare-publication","operationId":cmd.operation_id,"oldHead":s.head,"newHead":c.commit}]}),
    )
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PublicationTransition {
    phase: String,
    gate: String,
    event: String,
    verified: bool,
}
fn publication_transition(i: &PublicationTransition) -> Result<Value, String> {
    if !matches!(i.gate.as_str(), "OPEN" | "CLOSED" | "RECOVERY") {
        return Err("INVALID_GATE".into());
    }
    let mut gate = i.gate.clone();
    let next = match (i.phase.as_str(), i.event.as_str()) {
        ("ADMITTED", "PREPARED") if i.verified => "READY",
        ("READY", "DISPATCH") => "MAY_HAVE_DISPATCHED",
        ("MAY_HAVE_DISPATCHED" | "UNKNOWN", "AMBIGUOUS" | "OBSERVE_OLD") => "UNKNOWN",
        ("MAY_HAVE_DISPATCHED" | "UNKNOWN" | "RECOVERY_HOLD", "OBSERVE_NEW") if i.verified => {
            "OBSERVED"
        }
        ("READY" | "MAY_HAVE_DISPATCHED" | "UNKNOWN" | "RECOVERY_HOLD", "DIVERGENCE") => {
            gate = "RECOVERY".into();
            "RECOVERY_HOLD"
        }
        ("OBSERVED", "RECEIPT_SAVED") if i.verified => "RECEIPT_DURABLE",
        ("RECEIPT_DURABLE", "FINALIZE") if i.verified => "FINALIZED",
        ("FINALIZED", "FINALIZE") if i.verified => "FINALIZED",
        _ => return Err("INVALID_PUBLICATION_TRANSITION".into()),
    };
    Ok(json!({"accepted":true,"phase":next,"gate":gate,"unresolved":next!="FINALIZED"}))
}

#[wasm_bindgen]
pub fn canonical_json(input: &str) -> Result<String, JsValue> {
    decode(input)
        .map(|v| canonical(&v))
        .map_err(|e| JsValue::from_str(&e))
}
#[wasm_bindgen]
pub fn validate_manifest(input: &str) -> String {
    match parse::<Manifest>(input).and_then(|m| check_manifest(&m)) {
        Ok(()) => canonical(&json!({"valid":true})),
        Err(e) => canonical(&json!({"valid":false,"reason":e})),
    }
}
#[wasm_bindgen]
pub fn evaluate_admission(input: &str) -> String {
    match parse::<AdmissionInput>(input).and_then(|i| admit(&i)) {
        Ok(v) => canonical(&v),
        Err(e) => canonical(&json!({"accepted":false,"reason":e})),
    }
}
#[wasm_bindgen]
pub fn transition_publication(input: &str) -> String {
    match parse::<PublicationTransition>(input).and_then(|i| publication_transition(&i)) {
        Ok(v) => canonical(&v),
        Err(e) => canonical(&json!({"accepted":false,"reason":e})),
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Envelope {
    payload_type: String,
    payload: String,
    signatures: Vec<Endorsement>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Endorsement {
    keyid: String,
    sig: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TrustKey {
    id: String,
    public_key_base64: String,
    roles: Vec<String>,
}
#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Trust {
    schema_version: u8,
    scope: Scope,
    keyset_revision: String,
    keys: Vec<TrustKey>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct VersionedTrust {
    schema_version: u8,
    scope: Scope,
    keyset_revision: String,
    keys: Vec<TrustKey>,
    genesis: Trust,
    lifecycle: Vec<Envelope>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(untagged)]
enum TrustDocument {
    Legacy(Trust),
    Versioned(VersionedTrust),
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Issuance {
    schema_version: u8,
    scope: Scope,
    signer_keyset_revision: String,
    authority_revision: String,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct IssuedRecord {
    schema_version: u8,
    record: Value,
    issuance: Issuance,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct KeyLifecycle {
    schema_version: u8,
    scope: Scope,
    previous_revision: String,
    revision: String,
    predecessor_transition_digest: Option<String>,
    effective_sequence: String,
    authority_revision: String,
    operation: String,
    role: String,
    old_key_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    new_key: Option<TrustKey>,
    reason: String,
}
#[derive(Clone)]
struct Epoch {
    trust: Trust,
    effective_sequence: u64,
    authority_revision: u64,
}
struct ResolvedTrust {
    genesis: Trust,
    epochs: Vec<Epoch>,
    revoked: BTreeSet<String>,
    transition_digest: Option<String>,
}
struct VerifiedRecord {
    record: Value,
    issuance: Option<Issuance>,
    legacy: bool,
}
fn unbase64(s: &str) -> Result<Vec<u8>, String> {
    B64.decode(s).map_err(|_| "INVALID_BASE64".into())
}
fn pae(typ: &str, bytes: &[u8]) -> Vec<u8> {
    let mut out = format!("DSSEv1 {} {} {} ", typ.len(), typ, bytes.len()).into_bytes();
    out.extend(bytes);
    out
}
fn role_ok(role: &str) -> bool {
    matches!(role, "root" | "authority" | "checker")
}
fn validate_attested_record(record: &Value, kind: &str, legacy: bool) -> Result<(), String> {
    let valid = match kind {
        "enrollment" => {
            let r: Enrollment =
                serde_json::from_value(record.clone()).map_err(|_| "INVALID_ENROLLMENT")?;
            r.schema_version == 1
                && r.scope.valid()
                && r.sequence == "0"
                && r.imported_history
                && oid_ok(&r.head)
                && digest_ok(&r.manifest_digest)
                && digest_ok(&r.trust_digest)
        }
        "admission" => {
            let r: Admission =
                serde_json::from_value(record.clone()).map_err(|_| "INVALID_ADMISSION")?;
            r.schema_version == 1
                && r.scope.valid()
                && bounded_id(&r.operation_id)
                && counter(&r.sequence)? > 0
                && oid_ok(&r.old_head)
                && oid_ok(&r.new_head)
                && [&r.witness_digest, &r.proposal_digest, &r.candidate_digest]
                    .iter()
                    .all(|d| digest_ok(d))
        }
        "publication" => {
            let r: Receipt =
                serde_json::from_value(record.clone()).map_err(|_| "INVALID_RECEIPT")?;
            r.schema_version == 1
                && r.scope.valid()
                && bounded_id(&r.operation_id)
                && record.get("predecessorReceiptDigest").is_some()
                && counter(&r.sequence)? > 0
                && r.outcome == "PUBLISHED"
                && oid_ok(&r.old_head)
                && oid_ok(&r.new_head)
                && [
                    &r.enrollment_digest,
                    &r.candidate_digest,
                    &r.manifest_digest,
                    &r.proposal_digest,
                    &r.witness_digest,
                ]
                .iter()
                .all(|d| digest_ok(d))
                && r.predecessor_receipt_digest
                    .as_ref()
                    .is_none_or(|d| digest_ok(d))
                && r.authority_revision
                    .as_ref()
                    .is_none_or(|r| counter(r).is_ok_and(|n| n > 0))
                && r.evidence_digests.len() <= 128
                && r.evidence_digests.iter().all(|d| digest_ok(d))
                && r.limitations.len() <= 32
                && r.limitations.iter().all(|s| s.len() <= 2048)
        }
        "evidence" => {
            let r: Evidence =
                serde_json::from_value(record.clone()).map_err(|_| "INVALID_EVIDENCE")?;
            bounded_id(&r.id)
                && bounded_id(&r.job_id)
                && bounded_id(&r.candidate_id)
                && [
                    &r.digest,
                    &r.input_digest,
                    &r.observation_digest,
                    &r.candidate_digest,
                ]
                .iter()
                .all(|d| digest_ok(d))
                && matches!(
                    r.outcome.as_str(),
                    "PASS" | "FAIL" | "ERROR" | "TIMEOUT" | "CANCELLED" | "INCONCLUSIVE"
                )
                && matches!(
                    r.evidence_class.as_str(),
                    "protected-behavioural" | "repository-check"
                )
        }
        "checkpoint" => {
            let cp = if legacy {
                let r: CheckpointAttestation = serde_json::from_value(record.clone())
                    .map_err(|_| "INVALID_CHECKPOINT_ATTESTATION")?;
                if r.schema_version != 1
                    || r.issuance.schema_version != 1
                    || !r.issuance.scope.valid()
                    || counter(&r.issuance.authority_revision)? == 0
                    || counter(&r.issuance.signer_keyset_revision)? == 0
                {
                    return Err("CHECKPOINT_ISSUANCE_MISMATCH".into());
                }
                r.checkpoint
            } else {
                serde_json::from_value::<Checkpoint>(record.clone())
                    .map_err(|_| "INVALID_CHECKPOINT_ATTESTATION")?
            };
            cp.schema_version == 1
                && cp.scope.valid()
                && (counter(&cp.sequence)? > 0 || cp.receipt_digest == cp.enrollment_digest)
                && digest_ok(&cp.enrollment_digest)
                && digest_ok(&cp.receipt_digest)
        }
        "key-lifecycle" => {
            let r: KeyLifecycle =
                serde_json::from_value(record.clone()).map_err(|_| "INVALID_KEY_LIFECYCLE")?;
            r.schema_version == 1
                && record.get("predecessorTransitionDigest").is_some()
                && match r.operation.as_str() {
                    "rotate" => record.get("newKey").is_some_and(Value::is_object),
                    "revoke" => record.get("newKey").is_none(),
                    _ => false,
                }
        }
        _ => false,
    };
    if !valid {
        return Err("INVALID_ATTESTED_RECORD".into());
    }
    Ok(())
}
fn kind_ok(kind: &str) -> bool {
    matches!(
        kind,
        "enrollment" | "admission" | "publication" | "evidence" | "checkpoint" | "key-lifecycle"
    )
}
fn validate_trust(t: &Trust) -> Result<(), String> {
    if t.schema_version != 1
        || !t.scope.valid()
        || counter(&t.keyset_revision)? == 0
        || t.keys.is_empty()
        || t.keys.len() > 16
    {
        return Err("INVALID_TRUST_KEYSET".into());
    }
    let mut ids = BTreeSet::new();
    for key in &t.keys {
        if !bounded_id(&key.id)
            || !ids.insert(&key.id)
            || key.roles.is_empty()
            || key.roles.len() > 3
            || key.roles.iter().any(|r| !role_ok(r))
            || key.roles.iter().collect::<BTreeSet<_>>().len() != key.roles.len()
            || unbase64(&key.public_key_base64)?.len() != 32
            || B64.encode(unbase64(&key.public_key_base64)?) != key.public_key_base64
        {
            return Err("INVALID_TRUST_KEYSET".into());
        }
        let public: [u8; 32] = unbase64(&key.public_key_base64)?
            .try_into()
            .map_err(|_| "INVALID_PUBLIC_KEY")?;
        VerifyingKey::from_bytes(&public).map_err(|_| "INVALID_PUBLIC_KEY")?;
    }
    if !t.keys.iter().any(|k| k.roles.iter().any(|r| r == "root")) {
        return Err("ROOT_ROLE_REQUIRED".into());
    }
    Ok(())
}
// New statements use Confidence. The two exact historical Confluence schemas
// remain verifiable without rewriting their signed payloads or logical records.
fn statement_namespace(predicate_type: &Value, kind: &str) -> Option<(&'static str, u8)> {
    for namespace in ["confidence", "confluence"] {
        for version in [1, 2] {
            if predicate_type == &format!("https://{namespace}.dev/attestation/{kind}/v{version}") {
                return Some((namespace, version));
            }
        }
    }
    None
}
fn envelope_record(e: &Envelope, kind: &str) -> Result<(VerifiedRecord, Vec<u8>), String> {
    if e.payload_type != "application/vnd.in-toto+json"
        || e.signatures.is_empty()
        || e.signatures.len() > 8
    {
        return Err("INVALID_ENVELOPE".into());
    }
    let bytes = unbase64(&e.payload)?;
    let text = std::str::from_utf8(&bytes).map_err(|_| "INVALID_UTF8")?;
    let s = decode(text)?;
    if canonical(&s) != text {
        return Err("NONCANONICAL_PAYLOAD".into());
    }
    let fields = s.as_object().ok_or("INVALID_STATEMENT")?;
    if fields.len() != 4 || s["_type"] != "https://in-toto.io/Statement/v1" || !kind_ok(kind) {
        return Err("UNSUPPORTED_STATEMENT".into());
    }
    let (namespace, version) =
        statement_namespace(&s["predicateType"], kind).ok_or("UNSUPPORTED_STATEMENT")?;
    let parsed = if version == 2 {
        let issued: IssuedRecord =
            serde_json::from_value(s["predicate"].clone()).map_err(|_| "INVALID_ISSUANCE")?;
        if issued.schema_version != 2
            || issued.issuance.schema_version != 1
            || !issued.issuance.scope.valid()
            || counter(&issued.issuance.signer_keyset_revision)? == 0
            || counter(&issued.issuance.authority_revision)? == 0
        {
            return Err("INVALID_ISSUANCE".into());
        }
        VerifiedRecord {
            record: issued.record,
            issuance: Some(issued.issuance),
            legacy: false,
        }
    } else if version == 1 && kind != "key-lifecycle" {
        VerifiedRecord {
            record: s["predicate"].clone(),
            issuance: None,
            legacy: true,
        }
    } else {
        return Err("UNSUPPORTED_STATEMENT".into());
    };
    let digest = value_digest(&parsed.record);
    validate_attested_record(&parsed.record, kind, parsed.legacy)?;
    let expected = json!([{"name":format!("{namespace}/{kind}"),"digest":{"sha256":&digest[7..]}}]);
    if s["subject"] != expected {
        return Err("SUBJECT_DIGEST_MISMATCH".into());
    }
    Ok((parsed, pae(&e.payload_type, &bytes)))
}
fn verify_signatures(
    e: &Envelope,
    keys: &[TrustKey],
    revoked: &BTreeSet<String>,
    role: &str,
    signed: &[u8],
) -> Result<(), String> {
    if !role_ok(role) {
        return Err("SIGNER_ROLE_MISMATCH".into());
    }
    let mut ids = BTreeSet::new();
    let mut authorized = false;
    for sig in &e.signatures {
        if !ids.insert(&sig.keyid) {
            return Err("DUPLICATE_SIGNATURE".into());
        }
        if revoked.contains(&sig.keyid) {
            return Err("SIGNER_REVOKED".into());
        }
        let key = keys
            .iter()
            .find(|k| k.id == sig.keyid)
            .ok_or("UNTRUSTED_KEY")?;
        if !key.roles.iter().any(|r| r == role) {
            return Err("SIGNER_ROLE_MISMATCH".into());
        }
        let public: [u8; 32] = unbase64(&key.public_key_base64)?
            .try_into()
            .map_err(|_| "INVALID_PUBLIC_KEY")?;
        let signature =
            Signature::from_slice(&unbase64(&sig.sig)?).map_err(|_| "INVALID_SIGNATURE")?;
        VerifyingKey::from_bytes(&public)
            .map_err(|_| "INVALID_PUBLIC_KEY")?
            .verify_strict(signed, &signature)
            .map_err(|_| "BAD_SIGNATURE")?;
        authorized = true;
    }
    if !authorized {
        return Err("UNAUTHORIZED_SIGNATURE".into());
    }
    Ok(())
}
fn resolve_document(document: &TrustDocument) -> Result<ResolvedTrust, String> {
    let (genesis, lifecycle) = match document {
        TrustDocument::Legacy(t) => (t, &[][..]),
        TrustDocument::Versioned(t) => {
            if t.schema_version != 2 || t.scope != t.genesis.scope || t.lifecycle.len() > 8 {
                return Err("INVALID_TRUST_LIFECYCLE".into());
            }
            (&t.genesis, t.lifecycle.as_slice())
        }
    };
    validate_trust(genesis)?;
    let mut resolved = ResolvedTrust {
        genesis: genesis.clone(),
        epochs: vec![Epoch {
            trust: genesis.clone(),
            effective_sequence: 0,
            authority_revision: 0,
        }],
        revoked: BTreeSet::new(),
        transition_digest: None,
    };
    let mut all_keys: BTreeMap<String, TrustKey> = genesis
        .keys
        .iter()
        .cloned()
        .map(|k| (k.id.clone(), k))
        .collect();
    let mut previous_authority_revision = 0;
    let mut revoked_public_keys = BTreeSet::new();
    for envelope in lifecycle {
        let current = resolved.epochs.last().unwrap();
        let (signed_record, signed) = envelope_record(envelope, "key-lifecycle")?;
        let issued = signed_record
            .issuance
            .as_ref()
            .ok_or("LIFECYCLE_ISSUANCE_REQUIRED")?;
        let record: KeyLifecycle = serde_json::from_value(signed_record.record.clone())
            .map_err(|_| "INVALID_KEY_LIFECYCLE")?;
        // Lifecycle provenance is checked at its authorized predecessor epoch.
        // Later compromise revocation cannot invalidate this authorization chain.
        verify_signatures(
            envelope,
            &current.trust.keys,
            &BTreeSet::new(),
            "root",
            &signed,
        )?;
        let effective = counter(&record.effective_sequence)?;
        let authority_revision = counter(&record.authority_revision)?;
        if record.schema_version != 1
            || record.scope != genesis.scope
            || issued.scope != genesis.scope
            || record.previous_revision != current.trust.keyset_revision
            || record.revision != increment(&record.previous_revision)?
            || issued.signer_keyset_revision != record.previous_revision
            || issued.authority_revision != record.authority_revision
            || record.predecessor_transition_digest != resolved.transition_digest
            || effective == 0
            || effective < current.effective_sequence
            || authority_revision == 0
            || authority_revision < previous_authority_revision
            || !role_ok(&record.role)
            || !bounded_id(&record.old_key_id)
            || record.reason.trim().is_empty()
            || record.reason.len() > 512
            || record.reason.chars().any(char::is_control)
        {
            return Err("KEY_LIFECYCLE_CONTEXT_MISMATCH".into());
        }
        let mut next = current.trust.clone();
        next.keyset_revision = record.revision.clone();
        match record.operation.as_str() {
            "rotate" => {
                let old = next
                    .keys
                    .iter_mut()
                    .find(|k| k.id == record.old_key_id && k.roles.contains(&record.role))
                    .ok_or("ROTATION_OLD_ROLE_MISMATCH")?;
                let key = record.new_key.as_ref().ok_or("ROTATION_NEW_KEY_REQUIRED")?;
                if key.id == record.old_key_id
                    || key.roles != vec![record.role.clone()]
                    || resolved.revoked.contains(&key.id)
                    || revoked_public_keys.contains(&key.public_key_base64)
                {
                    return Err("INVALID_ROTATION_NEW_KEY".into());
                }
                if let Some(prior) = all_keys.get(&key.id)
                    && prior.public_key_base64 != key.public_key_base64
                {
                    return Err("KEY_ID_REBOUND".into());
                }
                old.roles.retain(|r| r != &record.role);
                next.keys.retain(|k| !k.roles.is_empty());
                if let Some(existing) = next.keys.iter_mut().find(|k| k.id == key.id) {
                    if existing.roles.contains(&record.role) {
                        return Err("ROTATION_NEW_ROLE_ALREADY_PRESENT".into());
                    }
                    existing.roles.push(record.role.clone());
                } else {
                    next.keys.push(key.clone());
                }
                all_keys
                    .entry(key.id.clone())
                    .and_modify(|k| {
                        if !k.roles.contains(&record.role) {
                            k.roles.push(record.role.clone());
                        }
                    })
                    .or_insert_with(|| key.clone());
            }
            "revoke" => {
                if record.new_key.is_some()
                    || resolved.revoked.contains(&record.old_key_id)
                    || !all_keys
                        .get(&record.old_key_id)
                        .is_some_and(|k| k.roles.contains(&record.role))
                {
                    return Err("INVALID_REVOCATION".into());
                }
                // A compromised physical key is denied for every role and epoch.
                let compromised_public = all_keys
                    .get(&record.old_key_id)
                    .unwrap()
                    .public_key_base64
                    .clone();
                revoked_public_keys.insert(compromised_public.clone());
                for key in all_keys
                    .values()
                    .filter(|key| key.public_key_base64 == compromised_public)
                {
                    resolved.revoked.insert(key.id.clone());
                }
                next.keys
                    .retain(|k| k.public_key_base64 != compromised_public);
            }
            _ => return Err("UNSUPPORTED_KEY_OPERATION".into()),
        }
        if all_keys.len() > 16 {
            return Err("KEY_HISTORY_LIMIT".into());
        }
        validate_trust(&next)?;
        resolved.transition_digest = Some(value_digest(&signed_record.record));
        resolved.epochs.push(Epoch {
            trust: next,
            effective_sequence: effective,
            authority_revision,
        });
        previous_authority_revision = authority_revision;
    }
    if let TrustDocument::Versioned(t) = document {
        let current = &resolved.epochs.last().unwrap().trust;
        if t.keyset_revision != current.keyset_revision || t.keys != current.keys {
            return Err("UNROOTED_CURRENT_KEYSET".into());
        }
    }
    Ok(resolved)
}
fn record_sequence(record: &Value) -> Option<&str> {
    record.get("sequence").and_then(Value::as_str).or_else(|| {
        record
            .get("checkpoint")
            .and_then(|cp| cp.get("sequence"))
            .and_then(Value::as_str)
    })
}
fn verify_resolved(
    e: &Envelope,
    t: &ResolvedTrust,
    role: &str,
    kind: &str,
    sequence: Option<&str>,
    authority_revision: Option<&str>,
    allow_legacy: bool,
) -> Result<VerifiedRecord, String> {
    verify_resolved_policy(
        e,
        t,
        role,
        kind,
        sequence,
        authority_revision,
        allow_legacy,
        false,
    )
}
#[allow(clippy::too_many_arguments)]
fn verify_resolved_policy(
    e: &Envelope,
    t: &ResolvedTrust,
    role: &str,
    kind: &str,
    sequence: Option<&str>,
    authority_revision: Option<&str>,
    allow_legacy: bool,
    historical_only: bool,
) -> Result<VerifiedRecord, String> {
    let expected_role = match kind {
        "enrollment" | "checkpoint" | "key-lifecycle" => "root",
        "admission" | "publication" => "authority",
        "evidence" => "checker",
        _ => return Err("UNSUPPORTED_STATEMENT".into()),
    };
    if role != expected_role {
        return Err("SIGNER_ROLE_MISMATCH".into());
    }
    let (parsed, signed) = envelope_record(e, kind)?;
    if parsed.legacy && !allow_legacy {
        return Err("ISSUANCE_REQUIRED".into());
    }
    let revision = parsed
        .issuance
        .as_ref()
        .map(|i| i.signer_keyset_revision.as_str())
        .unwrap_or(&t.genesis.keyset_revision);
    let index = t
        .epochs
        .iter()
        .position(|ep| ep.trust.keyset_revision == revision)
        .ok_or("UNKNOWN_SIGNER_EPOCH")?;
    if let Some(issuance) = &parsed.issuance {
        if issuance.scope != t.genesis.scope
            || authority_revision.is_some_and(|r| r != issuance.authority_revision)
        {
            return Err("ISSUANCE_CONTEXT_MISMATCH".into());
        }
        if kind == "publication"
            && parsed
                .record
                .get("authorityRevision")
                .is_some_and(|revision| {
                    revision.as_str() != Some(issuance.authority_revision.as_str())
                })
        {
            return Err("RECEIPT_ISSUANCE_REVISION_MISMATCH".into());
        }
        if t.epochs.get(index + 1).is_some_and(|next| {
            counter(&issuance.authority_revision)
                .is_ok_and(|revision| revision >= next.authority_revision)
        }) {
            return Err("SIGNER_HISTORICAL_EPOCH_MISMATCH".into());
        }
    }
    if let Some(scope) = parsed.record.get("scope")
        && scope != &serde_json::to_value(&t.genesis.scope).unwrap()
    {
        return Err("ATTESTATION_SCOPE_MISMATCH".into());
    }
    if kind == "checkpoint" && parsed.legacy {
        let checkpoint: CheckpointAttestation = serde_json::from_value(parsed.record.clone())
            .map_err(|_| "INVALID_CHECKPOINT_ATTESTATION")?;
        if checkpoint.issuance.scope != t.genesis.scope
            || checkpoint.issuance.signer_keyset_revision != t.genesis.keyset_revision
        {
            return Err("CHECKPOINT_ISSUANCE_MISMATCH".into());
        }
        if checkpoint.checkpoint.scope != t.genesis.scope {
            return Err("ATTESTATION_SCOPE_MISMATCH".into());
        }
        if t.epochs.get(1).is_some_and(|next| {
            counter(&checkpoint.issuance.authority_revision)
                .is_ok_and(|revision| revision >= next.authority_revision)
        }) {
            return Err("SIGNER_HISTORICAL_EPOCH_MISMATCH".into());
        }
    }
    let actual_sequence = record_sequence(&parsed.record);
    if parsed.legacy && kind == "evidence" && t.epochs.len() > 1 && sequence.is_none() {
        return Err("LEGACY_SEQUENCE_REQUIRED".into());
    }
    if sequence.is_some() && actual_sequence.is_some() && sequence != actual_sequence {
        return Err("ATTESTATION_SEQUENCE_MISMATCH".into());
    }
    if let Some(seq) = sequence.or(actual_sequence) {
        let seq = counter(seq)?;
        // Later epochs may endorse old records. Earlier epochs cannot authorize
        // records effective in a newer epoch, even with an old format envelope.
        if (parsed.legacy || kind != "evidence")
            && t.epochs
                .get(index + 1)
                .is_some_and(|next| seq >= next.effective_sequence)
        {
            return Err("SIGNER_EPOCH_EXPIRED".into());
        }
    }
    let no_revocations = BTreeSet::new();
    verify_signatures(
        e,
        &t.epochs[index].trust.keys,
        if historical_only {
            &no_revocations
        } else {
            &t.revoked
        },
        role,
        &signed,
    )?;
    Ok(parsed)
}
struct BundleVerifier<'a> {
    trust: &'a ResolvedTrust,
    endorsements: Vec<(String, &'a Envelope, Value, Issuance)>,
    used: BTreeSet<usize>,
    rehabilitated: bool,
}
impl<'a> BundleVerifier<'a> {
    fn new(trust: &'a ResolvedTrust, endorsements: &'a [Envelope]) -> Result<Self, String> {
        if endorsements.len() > 128 {
            return Err("ATTESTATION_LIMIT".into());
        }
        let mut parsed = Vec::new();
        for envelope in endorsements {
            let payload = decode(
                std::str::from_utf8(&unbase64(&envelope.payload)?).map_err(|_| "INVALID_UTF8")?,
            )?;
            let kind = payload["predicateType"]
                .as_str()
                .and_then(|p| {
                    p.strip_prefix("https://confidence.dev/attestation/")
                        .or_else(|| p.strip_prefix("https://confluence.dev/attestation/"))
                })
                .and_then(|p| p.strip_suffix("/v2"))
                .ok_or("ENDORSEMENT_ISSUANCE_REQUIRED")?;
            if !matches!(
                kind,
                "enrollment" | "admission" | "evidence" | "publication"
            ) {
                return Err("UNSUPPORTED_ENDORSEMENT".into());
            }
            let (record, _) = envelope_record(envelope, kind)?;
            let issuance = record.issuance.ok_or("ENDORSEMENT_ISSUANCE_REQUIRED")?;
            parsed.push((kind.to_string(), envelope, record.record, issuance));
        }
        Ok(Self {
            trust,
            endorsements: parsed,
            used: BTreeSet::new(),
            rehabilitated: false,
        })
    }
    fn record(
        &mut self,
        envelope: &Envelope,
        role: &str,
        kind: &str,
        sequence: Option<&str>,
        authority_revision: Option<&str>,
    ) -> Result<VerifiedRecord, String> {
        let (primary, _) = envelope_record(envelope, kind)?;
        let mut authorized = match verify_resolved(
            envelope,
            self.trust,
            role,
            kind,
            sequence,
            authority_revision,
            true,
        ) {
            Ok(_) => true,
            Err(error) if error == "SIGNER_REVOKED" => {
                verify_resolved_policy(
                    envelope,
                    self.trust,
                    role,
                    kind,
                    sequence,
                    authority_revision,
                    true,
                    true,
                )?;
                false
            }
            Err(error) => return Err(error),
        };
        let primary_authorized = authorized;
        let mut count = 1;
        for (index, (extra_kind, extra, record, _)) in self.endorsements.iter().enumerate() {
            if extra_kind != kind || record != &primary.record {
                continue;
            }
            count += 1;
            if count > 8 {
                return Err("ATTESTATION_LIMIT".into());
            }
            // A frozen logical receipt's historical revision remains unchanged
            // across issuance epochs. Legacy records retain their limitation.
            let historical_revision = authority_revision
                .or_else(|| {
                    primary
                        .issuance
                        .as_ref()
                        .map(|issuance| issuance.authority_revision.as_str())
                })
                .or_else(|| {
                    primary
                        .record
                        .get("authorityRevision")
                        .and_then(Value::as_str)
                });
            match verify_resolved(
                extra,
                self.trust,
                role,
                kind,
                sequence,
                historical_revision,
                false,
            ) {
                Ok(_) => authorized = true,
                Err(error) if error == "SIGNER_REVOKED" => {
                    verify_resolved_policy(
                        extra,
                        self.trust,
                        role,
                        kind,
                        sequence,
                        historical_revision,
                        false,
                        true,
                    )?;
                    self.rehabilitated = true;
                }
                Err(error) => return Err(error),
            }
            self.used.insert(index);
        }
        if !authorized {
            return Err("SIGNER_REVOKED".into());
        }
        if !primary_authorized {
            self.rehabilitated = true;
        }
        Ok(primary)
    }
    fn revision_bounds(
        &self,
        primary: &VerifiedRecord,
        kind: &str,
        minimum: Option<u64>,
        maximum: Option<u64>,
        error: &str,
    ) -> Result<Option<u64>, String> {
        // Retained state supplies causal bounds even when a legacy primary
        // lacks an exact historical revision. Every matched v2 endorsement
        // makes its own signed claim and must satisfy those same bounds.
        let mut known = None;
        let mut check = |revision: &str| -> Result<(), String> {
            let revision = counter(revision)?;
            if minimum.is_some_and(|minimum| revision < minimum)
                || maximum.is_some_and(|maximum| revision > maximum)
            {
                return Err(error.into());
            }
            known = Some(known.map_or(revision, |previous: u64| previous.max(revision)));
            Ok(())
        };
        if let Some(revision) = primary
            .record
            .get("authorityRevision")
            .and_then(Value::as_str)
        {
            check(revision)?;
        }
        if let Some(issuance) = &primary.issuance {
            check(&issuance.authority_revision)?;
        }
        for (extra_kind, _, record, issuance) in &self.endorsements {
            if extra_kind == kind && record == &primary.record {
                check(&issuance.authority_revision)?;
            }
        }
        Ok(known)
    }
    fn finish(&self) -> Result<(), String> {
        if self.used.len() != self.endorsements.len() {
            return Err("ENDORSEMENT_SUBJECT_MISMATCH".into());
        }
        Ok(())
    }
}
fn resolved_value(t: &ResolvedTrust) -> Value {
    let current = &t.epochs.last().unwrap().trust;
    json!({"valid":true,"genesisDigest":value_digest(&serde_json::to_value(&t.genesis).unwrap()),"keysetRevision":current.keyset_revision,"keys":current.keys,"revokedKeyIds":t.revoked,"transitionDigest":t.transition_digest,"epochs":t.epochs.iter().map(|e| json!({"keysetRevision":e.trust.keyset_revision,"effectiveSequence":e.effective_sequence.to_string(),"keys":e.trust.keys})).collect::<Vec<_>>()})
}
#[wasm_bindgen]
pub fn resolve_trust(input: &str) -> String {
    canonical(
        &match parse::<TrustDocument>(input).and_then(|t| resolve_document(&t)) {
            Ok(t) => resolved_value(&t),
            Err(e) => json!({"valid":false,"reason":e}),
        },
    )
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AdvanceKeyset {
    trust: TrustDocument,
    transition: Envelope,
}
#[wasm_bindgen]
pub fn advance_keyset(input: &str) -> String {
    let result = (|| -> Result<Value, String> {
        let i: AdvanceKeyset = parse(input)?;
        let before = resolve_document(&i.trust)?;
        let (record, _) = envelope_record(&i.transition, "key-lifecycle")?;
        let proposed: KeyLifecycle =
            serde_json::from_value(record.record).map_err(|_| "INVALID_KEY_LIFECYCLE")?;
        let mut next = match i.trust {
            TrustDocument::Legacy(genesis) => VersionedTrust {
                schema_version: 2,
                scope: genesis.scope.clone(),
                keyset_revision: genesis.keyset_revision.clone(),
                keys: genesis.keys.clone(),
                genesis,
                lifecycle: vec![],
            },
            TrustDocument::Versioned(t) => t,
        };
        if next.lifecycle.len() >= 8 {
            return Err("LIFECYCLE_LIMIT".into());
        }
        // Derive visible current keys from the same interpreter, never a caller
        // supplied shortcut. The provisional projection is checked below.
        next.lifecycle.push(i.transition);
        let mut provisional = next.clone();
        provisional.keyset_revision = proposed.revision.clone();
        let mut keys = before.epochs.last().unwrap().trust.keys.clone();
        if proposed.operation == "rotate" {
            if let Some(old) = keys.iter_mut().find(|k| k.id == proposed.old_key_id) {
                old.roles.retain(|r| r != &proposed.role);
            }
            keys.retain(|k| !k.roles.is_empty());
            if let Some(new_key) = &proposed.new_key {
                if let Some(existing) = keys.iter_mut().find(|k| k.id == new_key.id) {
                    existing.roles.push(proposed.role.clone());
                } else {
                    keys.push(new_key.clone());
                }
            }
        } else if proposed.operation == "revoke" {
            let compromised_public = before
                .epochs
                .iter()
                .flat_map(|epoch| &epoch.trust.keys)
                .find(|key| key.id == proposed.old_key_id)
                .map(|key| key.public_key_base64.clone());
            keys.retain(|k| Some(&k.public_key_base64) != compromised_public.as_ref());
        }
        provisional.keys = keys;
        let after = resolve_document(&TrustDocument::Versioned(provisional.clone()))?;
        Ok(json!({"valid":true,"trust":provisional,"resolved":resolved_value(&after)}))
    })();
    canonical(&match result {
        Ok(v) => v,
        Err(e) => json!({"valid":false,"reason":e}),
    })
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct VerifyAttestation {
    trust: TrustDocument,
    envelope: Envelope,
    role: String,
    kind: String,
    #[serde(default)]
    sequence: Option<String>,
    #[serde(default)]
    authority_revision: Option<String>,
    #[serde(default = "legacy_allowed")]
    allow_legacy: bool,
}
fn legacy_allowed() -> bool {
    true
}
#[wasm_bindgen]
pub fn verify_attestation(input: &str) -> String {
    let result = (|| -> Result<Value, String> {
        let i: VerifyAttestation = parse(input)?;
        let t = resolve_document(&i.trust)?;
        let verified = verify_resolved(
            &i.envelope,
            &t,
            &i.role,
            &i.kind,
            i.sequence.as_deref(),
            i.authority_revision.as_deref(),
            i.allow_legacy,
        )?;
        let limitations = if verified.legacy {
            vec![
                "Legacy v1 envelope lacks a signed issuance epoch and historical authority revision.",
            ]
        } else if i.kind == "publication" && verified.record.get("authorityRevision").is_none() {
            vec![
                "Legacy logical publication record does not freeze historical authority revision; the issuance revision is an issuer claim.",
            ]
        } else {
            vec![]
        };
        Ok(
            json!({"valid":true,"recordDigest":value_digest(&verified.record),"record":verified.record,"issuance":verified.issuance,"legacy":verified.legacy,"limitations":limitations}),
        )
    })();
    canonical(&match result {
        Ok(v) => v,
        Err(e) => json!({"valid":false,"reason":e}),
    })
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct GitObject {
    oid: String,
    r#type: String,
    data_base64: String,
}
fn git_oid(typ: &str, bytes: &[u8]) -> String {
    use sha1::Sha1;
    let mut h = Sha1::new();
    h.update(format!("{typ} {}\0", bytes.len()));
    h.update(bytes);
    hex::encode(h.finalize())
}
fn source_check(
    objects: &[GitObject],
    candidate: &Candidate,
    manifest: &Manifest,
) -> Result<(), String> {
    check_manifest(manifest)?;
    if value_digest(&serde_json::to_value(manifest).unwrap()) != candidate.manifest_digest {
        return Err("MANIFEST_DIGEST_MISMATCH".into());
    }
    if objects.len() > 8192 {
        return Err("GIT_OBJECT_LIMIT".into());
    }
    let mut map = BTreeMap::new();
    let mut total = 0;
    for o in objects {
        if !oid_ok(&o.oid) || !matches!(o.r#type.as_str(), "commit" | "tree" | "blob") {
            return Err("INVALID_GIT_OBJECT".into());
        }
        let data = unbase64(&o.data_base64)?;
        total += data.len();
        if total > MAX_JSON_BYTES {
            return Err("GIT_BYTES_LIMIT".into());
        }
        if git_oid(&o.r#type, &data) != o.oid
            || map
                .insert(o.oid.clone(), (o.r#type.clone(), data))
                .is_some()
        {
            return Err("GIT_OBJECT_IDENTITY".into());
        }
    }
    let (typ, raw) = map.get(&candidate.commit).ok_or("MISSING_COMMIT")?;
    if typ != "commit" {
        return Err("COMMIT_TYPE_MISMATCH".into());
    }
    if !digest_ok(&candidate.commit_bytes_digest) || hash(raw) != candidate.commit_bytes_digest {
        return Err("COMMIT_BYTES_DIGEST_MISMATCH".into());
    }
    let commit = std::str::from_utf8(raw).map_err(|_| "UNSUPPORTED_COMMIT_ENCODING")?;
    let headers = commit.split_once("\n\n").ok_or("INVALID_COMMIT")?.0;
    let trees: Vec<_> = headers
        .lines()
        .filter_map(|l| l.strip_prefix("tree "))
        .collect();
    let parents: Vec<_> = headers
        .lines()
        .filter_map(|l| l.strip_prefix("parent "))
        .collect();
    let expected_parents = if candidate.parent.is_empty() {
        Vec::new()
    } else {
        vec![candidate.parent.as_str()]
    };
    if trees.len() != 1 || parents != expected_parents {
        return Err("COMMIT_PARENT_MISMATCH".into());
    }
    let mut leaves = BTreeMap::new();
    fn walk(
        oid: &str,
        prefix: &str,
        map: &BTreeMap<String, (String, Vec<u8>)>,
        leaves: &mut BTreeMap<String, (String, Vec<u8>)>,
        depth: usize,
    ) -> Result<(), String> {
        if depth > 24 {
            return Err("TREE_DEPTH_LIMIT".into());
        }
        let (typ, data) = map.get(oid).ok_or("MISSING_TREE")?;
        if typ != "tree" {
            return Err("TREE_TYPE_MISMATCH".into());
        }
        let mut pos = 0;
        let mut names = BTreeSet::new();
        let mut prev_sort = String::new();
        while pos < data.len() {
            let space = data[pos..]
                .iter()
                .position(|x| *x == b' ')
                .ok_or("INVALID_TREE")?
                + pos;
            let nul = data[space + 1..]
                .iter()
                .position(|x| *x == 0)
                .ok_or("INVALID_TREE")?
                + space
                + 1;
            if nul + 21 > data.len() {
                return Err("INVALID_TREE".into());
            }
            let mode = std::str::from_utf8(&data[pos..space]).map_err(|_| "INVALID_TREE")?;
            let name =
                std::str::from_utf8(&data[space + 1..nul]).map_err(|_| "UNSUPPORTED_PATH")?;
            if name.contains('/') || !names.insert(name) {
                return Err("TREE_PATH_COLLISION".into());
            }
            let path = format!("{prefix}{name}");
            valid_path(&path)?;
            let is_tree = mode == "40000";
            let sort = format!("{name}{}", if is_tree { "/" } else { "" });
            if !prev_sort.is_empty() && prev_sort >= sort {
                return Err("TREE_ORDER_INVALID".into());
            }
            prev_sort = sort;
            let oid = hex::encode(&data[nul + 1..nul + 21]);
            pos = nul + 21;
            if is_tree {
                let before = leaves.len();
                walk(&oid, &format!("{path}/"), map, leaves, depth + 1)?;
                if leaves.len() == before {
                    return Err("EMPTY_DIRECTORY_UNSUPPORTED".into());
                }
            } else {
                if !matches!(mode, "100644" | "100755") {
                    return Err("UNSUPPORTED_MODE".into());
                }
                let (typ, data) = map.get(&oid).ok_or("MISSING_BLOB")?;
                if typ != "blob" {
                    return Err("BLOB_TYPE_MISMATCH".into());
                }
                if leaves
                    .insert(path, (mode.to_owned(), data.clone()))
                    .is_some()
                    || leaves.len() > MAX_FILES
                {
                    return Err("TREE_PATH_COLLISION".into());
                }
            }
        }
        Ok(())
    }
    walk(trees[0], "", &map, &mut leaves, 0)?;
    if leaves.len() != manifest.entries.len() {
        return Err("MANIFEST_TREE_CARDINALITY".into());
    }
    for e in &manifest.entries {
        let (mode, bytes) = leaves.get(&e.path).ok_or("MANIFEST_TREE_PATH_MISMATCH")?;
        if mode != &e.mode || bytes.len() as u64 != counter(&e.bytes)? || hash(bytes) != e.digest {
            return Err("MANIFEST_TREE_CONTENT_MISMATCH".into());
        }
    }
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SourceCheckInput {
    candidate: Candidate,
    manifest: Manifest,
    git_objects: Vec<GitObject>,
}
#[wasm_bindgen]
pub fn validate_git_source(input: &str) -> String {
    let checked = parse::<SourceCheckInput>(input)
        .and_then(|i| source_check(&i.git_objects, &i.candidate, &i.manifest));
    match checked {
        Ok(()) => canonical(&json!({"valid": true})),
        Err(reason) => canonical(&json!({"valid": false, "reason": reason})),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Observation {
    digest: String,
    data_base64: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Inputs {
    witness: AdmissionInput,
    manifest: Manifest,
    git_objects: Vec<GitObject>,
    observations: Vec<Observation>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Bundle {
    schema_version: u8,
    enrollment: Envelope,
    admission: Envelope,
    publication: Envelope,
    evidence: Vec<Envelope>,
    history: Vec<Envelope>,
    #[serde(default)]
    endorsements: Vec<Envelope>,
    inputs: Inputs,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Enrollment {
    schema_version: u8,
    scope: Scope,
    head: String,
    manifest_digest: String,
    trust_digest: String,
    sequence: String,
    imported_history: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Receipt {
    schema_version: u8,
    scope: Scope,
    operation_id: String,
    sequence: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    authority_revision: Option<String>,
    enrollment_digest: String,
    predecessor_receipt_digest: Option<String>,
    old_head: String,
    new_head: String,
    candidate_digest: String,
    manifest_digest: String,
    proposal_digest: String,
    witness_digest: String,
    evidence_digests: Vec<String>,
    outcome: String,
    limitations: Vec<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Admission {
    schema_version: u8,
    scope: Scope,
    operation_id: String,
    witness_digest: String,
    proposal_digest: String,
    candidate_digest: String,
    old_head: String,
    new_head: String,
    sequence: String,
    delta: Value,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Checkpoint {
    schema_version: u8,
    scope: Scope,
    enrollment_digest: String,
    sequence: String,
    receipt_digest: String,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CheckpointIssuance {
    schema_version: u8,
    scope: Scope,
    authority_revision: String,
    signer_keyset_revision: String,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CheckpointAttestation {
    schema_version: u8,
    checkpoint: Checkpoint,
    issuance: CheckpointIssuance,
}
pub fn verify(bundle: &str, trust: &str, checkpoint: &str) -> Value {
    let mut result = json!({"valid":false,"integrity":false,"authorization":false,"publicationObservation":false,"continuity":false,"sourceVerified":false,"errors":[],"limitations":["Offline replay uses authority-attested recorded state; it cannot establish that state was latest or complete.","Attested publication is an observation, not a check of the current remote head or general program correctness.","Trust configuration must be selected independently; operator control remains a trust assumption."]});
    let checked = (|| -> Result<(), String> {
        let b: Bundle = parse(bundle)?;
        let t = resolve_document(&parse::<TrustDocument>(trust)?)?;
        let mut verifier = BundleVerifier::new(&t, &b.endorsements)?;
        if b.schema_version != 1 {
            return Err("UNSUPPORTED_BUNDLE_OR_TRUST".into());
        }
        let scope = &t.genesis.scope;
        let enrollment_attestation =
            verifier.record(&b.enrollment, "root", "enrollment", Some("0"), Some("1"))?;
        let mut legacy = enrollment_attestation.legacy;
        let enrollment_value = enrollment_attestation.record;
        let en: Enrollment =
            serde_json::from_value(enrollment_value.clone()).map_err(|_| "INVALID_ENROLLMENT")?;
        let enrollment_digest = value_digest(&enrollment_value);
        if en.schema_version != 1
            || &en.scope != scope
            || en.sequence != "0"
            || !en.imported_history
            || !oid_ok(&en.head)
            || !digest_ok(&en.manifest_digest)
            || en.trust_digest != value_digest(&serde_json::to_value(&t.genesis).unwrap())
        {
            return Err("ENROLLMENT_TRUST_MISMATCH".into());
        }
        let expected_sequence = increment(&b.inputs.witness.state.publication_sequence)?;
        let witness_revision = counter(&b.inputs.witness.state.revision)?;
        let admitted_revision = counter(&increment(&b.inputs.witness.state.revision)?)?;
        let admission_attestation = verifier.record(
            &b.admission,
            "authority",
            "admission",
            Some(&expected_sequence),
            Some(&b.inputs.witness.state.revision),
        )?;
        legacy |= admission_attestation.legacy;
        let admission_value = admission_attestation.record;
        let a: Admission =
            serde_json::from_value(admission_value).map_err(|_| "INVALID_ADMISSION")?;
        let publication_attestation = verifier.record(
            &b.publication,
            "authority",
            "publication",
            Some(&expected_sequence),
            None,
        )?;
        legacy |= publication_attestation.legacy;
        let publication_revision = verifier.revision_bounds(
            &publication_attestation,
            "publication",
            Some(admitted_revision),
            None,
            "RECEIPT_AUTHORITY_REVISION_INVALID",
        )?;
        let receipt_value = publication_attestation.record;
        let receipt: Receipt =
            serde_json::from_value(receipt_value.clone()).map_err(|_| "INVALID_RECEIPT")?;
        if a.schema_version != 1
            || receipt.schema_version != 1
            || &a.scope != scope
            || &receipt.scope != scope
            || receipt.outcome != "PUBLISHED"
            || receipt.enrollment_digest != enrollment_digest
        {
            return Err("RECEIPT_SCOPE_OR_ENROLLMENT_MISMATCH".into());
        }
        if !publication_attestation.legacy
            && (receipt.authority_revision.is_none()
                || receipt.authority_revision.as_ref()
                    != publication_attestation
                        .issuance
                        .as_ref()
                        .map(|i| &i.authority_revision))
        {
            return Err("RECEIPT_ISSUANCE_REVISION_MISMATCH".into());
        }
        if b.evidence.len() > 128 || b.history.len() > 128 {
            return Err("ATTESTATION_LIMIT".into());
        }
        let mut evidence = Vec::new();
        for e in &b.evidence {
            let verified =
                verifier.record(e, "checker", "evidence", Some(&expected_sequence), None)?;
            legacy |= verified.legacy;
            verifier.revision_bounds(
                &verified,
                "evidence",
                None,
                Some(witness_revision),
                "EVIDENCE_ISSUANCE_REVISION_INVALID",
            )?;
            let p = verified.record;
            let parsed: Evidence = serde_json::from_value(p).map_err(|_| "INVALID_EVIDENCE")?;
            evidence.push(parsed);
        }
        let mut observations = BTreeSet::new();
        if b.inputs.observations.len() > 128 {
            return Err("OBSERVATION_LIMIT".into());
        }
        for o in &b.inputs.observations {
            if !digest_ok(&o.digest)
                || hash(&unbase64(&o.data_base64)?) != o.digest
                || !observations.insert(&o.digest)
            {
                return Err("OBSERVATION_IDENTITY_INVALID".into());
            }
        }
        if evidence
            .iter()
            .any(|e| !observations.contains(&e.observation_digest))
        {
            return Err("MISSING_OBSERVATION_ARTIFACT".into());
        }
        if canonical(&serde_json::to_value(&evidence).unwrap())
            != canonical(&serde_json::to_value(&b.inputs.witness.evidence).unwrap())
        {
            return Err("EVIDENCE_WITNESS_MISMATCH".into());
        }
        result["integrity"] = json!(true);
        let w = &b.inputs.witness;
        let w_digest = value_digest(&serde_json::to_value(w).unwrap());
        let proposal_digest = value_digest(&serde_json::to_value(&w.proposal).unwrap());
        let replay = admit(w)?;
        if &w.state.scope != scope
            || a.witness_digest != w_digest
            || receipt.witness_digest != w_digest
            || a.delta != replay["delta"]
            || a.operation_id != w.command.operation_id
            || receipt.operation_id != a.operation_id
            || a.proposal_digest != proposal_digest
            || receipt.proposal_digest != proposal_digest
            || a.sequence != replay["delta"]["sequence"]
            || receipt.sequence != a.sequence
            || a.candidate_digest != w.candidate.digest
            || receipt.candidate_digest != w.candidate.digest
            || a.old_head != w.state.head
            || receipt.old_head != a.old_head
            || a.new_head != w.candidate.commit
            || receipt.new_head != a.new_head
            || receipt.manifest_digest != w.candidate.manifest_digest
            || receipt.evidence_digests != w.proposal.evidence_digests
        {
            return Err("ADMISSION_REPLAY_MISMATCH".into());
        }
        result["authorization"] = json!(true);
        source_check(&b.inputs.git_objects, &w.candidate, &b.inputs.manifest)?;
        result["sourceVerified"] = json!(true);
        result["publicationObservation"] = json!(true);
        let mut prior_head = en.head.clone();
        let mut prior_digest = None;
        let mut sequence = 0u64;
        let mut prior_publication_revision = 1u64;
        let mut roots = BTreeMap::new();
        roots.insert(0, (enrollment_digest.clone(), Some(1)));
        for envelope in &b.history {
            let verified = verifier.record(envelope, "authority", "publication", None, None)?;
            legacy |= verified.legacy;
            let publication_revision = verifier.revision_bounds(
                &verified,
                "publication",
                Some(
                    prior_publication_revision
                        .checked_add(1)
                        .ok_or("HISTORY_AUTHORITY_REVISION_INVALID")?,
                ),
                Some(witness_revision),
                "HISTORY_AUTHORITY_REVISION_INVALID",
            )?;
            // Successive publications require a new admission mutation. Legacy
            // receipts without a revision do not erase the last known bound.
            if let Some(revision) = publication_revision {
                prior_publication_revision = revision;
            }
            let pv = verified.record;
            let p: Receipt = serde_json::from_value(pv.clone()).map_err(|_| "INVALID_HISTORY")?;
            if !verified.legacy
                && (p.authority_revision.is_none()
                    || p.authority_revision.as_ref()
                        != verified.issuance.as_ref().map(|i| &i.authority_revision))
            {
                return Err("HISTORY_ISSUANCE_REVISION_MISMATCH".into());
            }
            if &p.scope != scope
                || p.schema_version != 1
                || p.enrollment_digest != enrollment_digest
                || p.outcome != "PUBLISHED"
                || counter(&p.sequence)? != sequence + 1
                || p.predecessor_receipt_digest != prior_digest
                || p.old_head != prior_head
                || !oid_ok(&p.new_head)
            {
                return Err("HISTORY_CONTINUITY_MISMATCH".into());
            }
            sequence += 1;
            prior_head = p.new_head;
            prior_digest = Some(value_digest(&pv));
            roots.insert(
                sequence,
                (prior_digest.clone().unwrap(), publication_revision),
            );
        }
        if counter(&receipt.sequence)? != sequence + 1
            || receipt.predecessor_receipt_digest != prior_digest
            || receipt.old_head != prior_head
        {
            return Err("ENROLLMENT_OR_CHAIN_CONTINUITY_MISMATCH".into());
        }
        let root = value_digest(&receipt_value);
        roots.insert(sequence + 1, (root.clone(), publication_revision));
        let checkpoint_value = decode(checkpoint)?;
        if !checkpoint_value.is_null() {
            let (cp, checkpoint_revision): (Checkpoint, Option<u64>) =
                if checkpoint_value.get("payloadType").is_some() {
                    let envelope: Envelope = parse(checkpoint)?;
                    let verified =
                        verify_resolved(&envelope, &t, "root", "checkpoint", None, None, true)?;
                    legacy |= verified.legacy;
                    if verified.legacy {
                        let attestation: CheckpointAttestation =
                            serde_json::from_value(verified.record)
                                .map_err(|_| "INVALID_CHECKPOINT_ATTESTATION")?;
                        if attestation.schema_version != 1
                            || attestation.issuance.schema_version != 1
                            || &attestation.issuance.scope != scope
                            || attestation.issuance.signer_keyset_revision
                                != t.genesis.keyset_revision
                            || counter(&attestation.issuance.authority_revision)? == 0
                        {
                            return Err("CHECKPOINT_ISSUANCE_MISMATCH".into());
                        }
                        (
                            attestation.checkpoint,
                            Some(counter(&attestation.issuance.authority_revision)?),
                        )
                    } else {
                        let revision = counter(
                            &verified
                                .issuance
                                .ok_or("CHECKPOINT_ISSUANCE_MISMATCH")?
                                .authority_revision,
                        )?;
                        (
                            serde_json::from_value(verified.record)
                                .map_err(|_| "INVALID_CHECKPOINT_ATTESTATION")?,
                            Some(revision),
                        )
                    }
                } else {
                    // A raw checkpoint is an independently retained local pin. A
                    // server attestation additionally proves the issuing role.
                    (parse(checkpoint)?, None)
                };
            let seq = counter(&cp.sequence)?;
            if cp.schema_version != 1
                || &cp.scope != scope
                || cp.enrollment_digest != enrollment_digest
                || roots.get(&seq).map(|(digest, _)| digest) != Some(&cp.receipt_digest)
            {
                return Err("PINNED_CHECKPOINT_MISMATCH".into());
            }
            if let (Some(checkpoint_revision), Some((_, Some(receipt_revision)))) =
                (checkpoint_revision, roots.get(&seq))
                && checkpoint_revision < *receipt_revision
            {
                return Err("CHECKPOINT_AUTHORITY_REVISION_INVALID".into());
            }
        }
        result["continuity"] = json!(true);
        verifier.finish()?;
        result["valid"] = json!(true);
        result["receiptDigest"] = json!(root);
        result["sequence"] = json!(receipt.sequence);
        if legacy {
            result["limitations"].as_array_mut().unwrap().push(json!("Legacy v1 attestations lack a signed issuance epoch and historical authority revision; they are restricted to the independently pinned genesis keyset and remain subject to explicit compromise revocation."));
        }
        if verifier.rehabilitated {
            result["limitations"].as_array_mut().unwrap().push(json!("A retained historical envelope is revoked under the selected compromise policy; a currently authorized endorsement establishes the same immutable logical record. Revoked signatures alone provide no present authorization."));
        }
        Ok(())
    })();
    if let Err(e) = checked {
        result["errors"] = json!([e]);
    }
    result
}
#[wasm_bindgen]
pub fn verify_bundle(bundle: &str, trust: &str, checkpoint: &str) -> String {
    canonical(&verify(bundle, trust, checkpoint))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn duplicate_and_float_rejected() {
        assert!(decode(r#"{"a":1,"a":2}"#).is_err());
        assert!(decode("1.0").is_err());
        assert!(decode(r#""\ud800""#).is_err());
    }
    #[test]
    fn utf16_key_sort() {
        assert_eq!(
            canonical(&json!({"\u{e000}":1,"\u{10000}":2})),
            "{\"𐀀\":2,\"\":1}"
        );
    }
    #[test]
    fn paths_closed() {
        for p in [
            "../x",
            ".GiT/config",
            "a/CON.txt",
            "a/",
            "/a",
            "a\\b",
            "a/../x",
            "a/foo.",
        ] {
            assert!(valid_path(p).is_err(), "{p}");
        }
        assert!(valid_path("src/cache-config.ts").is_ok());
    }
    #[test]
    fn repository_json_limit_is_bounded_in_bytes() {
        assert_eq!(MAX_JSON_BYTES, 32 * 1024 * 1024);
        let boundary = format!("\"{}\"", "a".repeat(MAX_JSON_BYTES - 2));
        assert!(decode(&boundary).is_ok());
        assert_eq!(decode(&(boundary + " ")).unwrap_err(), "JSON_SIZE_LIMIT");
    }
    #[test]
    fn repository_source_capacity_keeps_file_and_path_limits() {
        let entry = |index: usize, bytes: usize| ManifestEntry {
            path: format!("file-{index:04}"),
            mode: "100644".into(),
            bytes: bytes.to_string(),
            digest: hash(b"manifest metadata"),
        };
        let mut manifest = Manifest {
            schema_version: 1,
            path_profile: "portable-ascii-v1".into(),
            entries: (0..16).map(|index| entry(index, 1024 * 1024)).collect(),
        };
        assert!(check_manifest(&manifest).is_ok());
        manifest.entries.push(entry(16, 1));
        assert_eq!(check_manifest(&manifest).unwrap_err(), "SOURCE_SIZE_LIMIT");
        manifest.entries = vec![entry(0, 1024 * 1024 + 1)];
        assert_eq!(check_manifest(&manifest).unwrap_err(), "FILE_SIZE_LIMIT");
        manifest.entries = (0..2048).map(|index| entry(index, 0)).collect();
        assert!(check_manifest(&manifest).is_ok());
        manifest.entries.push(entry(2048, 0));
        assert_eq!(check_manifest(&manifest).unwrap_err(), "FILE_COUNT_LIMIT");
        manifest.entries = (0..1024).map(|index| entry(index, 0)).collect();
        for entry in &mut manifest.entries {
            entry.path = format!("{}/{}", "p".repeat(64), entry.path);
        }
        assert_eq!(check_manifest(&manifest).unwrap_err(), "SOURCE_SIZE_LIMIT");
        manifest.entries = vec![entry(0, 0)];
        manifest.entries[0].mode = "120000".into();
        assert_eq!(check_manifest(&manifest).unwrap_err(), "UNSUPPORTED_MODE");
        assert!(valid_path(&"x".repeat(81)).is_err());
        assert!(
            valid_path(&format!(
                "{}/{}/{}",
                "a".repeat(80),
                "b".repeat(80),
                "c".repeat(80)
            ))
            .is_err()
        );
    }
    #[test]
    fn prefix_collision() {
        let m = Manifest {
            schema_version: 1,
            path_profile: "portable-ascii-v1".into(),
            entries: vec![
                ManifestEntry {
                    path: "A/x".into(),
                    mode: "100644".into(),
                    bytes: "0".into(),
                    digest: hash(b""),
                },
                ManifestEntry {
                    path: "a/y".into(),
                    mode: "100644".into(),
                    bytes: "0".into(),
                    digest: hash(b""),
                },
            ],
        };
        assert_eq!(check_manifest(&m).unwrap_err(), "CASE_PREFIX_COLLISION");
    }
    #[test]
    fn old_observation_remains_unknown() {
        let t = PublicationTransition {
            phase: "UNKNOWN".into(),
            gate: "CLOSED".into(),
            event: "OBSERVE_OLD".into(),
            verified: true,
        };
        let r = publication_transition(&t).unwrap();
        assert_eq!(r["phase"], "UNKNOWN");
        assert_eq!(r["gate"], "CLOSED");
        assert_eq!(r["unresolved"], true);
    }
    #[test]
    fn gate_closure_does_not_stop_reconciliation() {
        let t = PublicationTransition {
            phase: "UNKNOWN".into(),
            gate: "CLOSED".into(),
            event: "OBSERVE_NEW".into(),
            verified: true,
        };
        assert_eq!(publication_transition(&t).unwrap()["phase"], "OBSERVED");
    }
    #[test]
    fn incomplete_receipt_is_rejected() {
        assert_eq!(verify("{}", "{}", "null")["valid"], false);
    }
}
