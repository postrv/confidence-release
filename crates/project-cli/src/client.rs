// SPDX-License-Identifier: Apache-2.0
use crate::{Result, canonical, journal::RequestRecord, process::captured};
use serde_json::Value;
use std::{
    io::Read,
    process::{Command, Stdio},
    time::Duration,
};
use url::Url;

pub fn target_origin(value: &str) -> Result<String> {
    target_origin_mode(value, false)
}
pub fn target_origin_mode(value: &str, local: bool) -> Result<String> {
    let url = Url::parse(value).map_err(|_| "Target must be an HTTPS application origin")?;
    let allowed = if local {
        url.scheme() == "http" && matches!(url.host_str(), Some("localhost" | "127.0.0.1"))
    } else {
        url.scheme() == "https" && url.host_str().is_some()
    };
    if !allowed
        || !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(if local { "--local requires an HTTP localhost or 127.0.0.1 origin without credentials, path, query or fragment" }
            else { "Use the exact HTTPS application origin, without credentials, path, query or fragment" }.into());
    }
    Ok(url.origin().ascii_serialization())
}
pub fn login(target: &str) -> Result<()> {
    let target = target_origin(target)?;
    // --quiet explicitly suppresses cloudflared's default JWT output. The
    // browser provider owns the interactive login and its own credential store.
    let status = Command::new("cloudflared")
        .args(["access", "login", "--quiet", &target])
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .status()
        .map_err(
            |_| "Install cloudflared, then run `confidence auth login --target HTTPS_ORIGIN`",
        )?;
    if !status.success() {
        return Err("Cloudflare Access login did not complete".into());
    }
    Ok(())
}
fn access_token(target: &str) -> Result<String> {
    let (success, bytes) = captured(Command::new("cloudflared").args(["access", "token", "--app", target]), Vec::new(), 16 * 1024, Duration::from_secs(30))
        .map_err(|_| "Cloudflare Access credential is unavailable. Install cloudflared and run `confidence auth login --target HTTPS_ORIGIN`.")?;
    if !success {
        return Err("Cloudflare Access login is required. Run `confidence auth login --target HTTPS_ORIGIN`.".into());
    }
    let token = String::from_utf8(bytes)
        .map_err(|_| "Invalid Access credential output")?
        .trim()
        .to_owned();
    if token.len() < 20
        || token.len() > 16 * 1024
        || token.split('.').count() != 3
        || !token
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"-_.".contains(&byte))
    {
        return Err("cloudflared returned an invalid application credential".into());
    }
    Ok(token)
}
pub struct Client {
    origin: String,
    token: Option<String>,
    local: bool,
    agent: ureq::Agent,
}
impl Client {
    pub fn connect(target: &str) -> Result<Self> {
        Self::connect_mode(target, false)
    }
    pub fn connect_mode(target: &str, local: bool) -> Result<Self> {
        let origin = target_origin_mode(target, local)?;
        let token = if local {
            None
        } else {
            Some(access_token(&origin)?)
        };
        Ok(Self::with_token(origin, token, local))
    }
    fn with_token(origin: String, token: Option<String>, local: bool) -> Self {
        Self {
            origin,
            token,
            local,
            agent: ureq::AgentBuilder::new()
                .https_only(!local)
                .redirects(0)
                .timeout_connect(Duration::from_secs(15))
                .timeout(Duration::from_secs(90))
                .build(),
        }
    }
    pub fn origin(&self) -> &str {
        &self.origin
    }
    pub fn local_development(&self) -> bool {
        self.local
    }
    fn authenticated(&self, request: ureq::Request) -> ureq::Request {
        if let Some(token) = &self.token {
            request.set("CF-Access-Token", token)
        } else {
            request.set("X-Confidence-Local-Client", "cli")
        }
    }
    pub fn get(&self, route: &str) -> Result<Value> {
        if !route.starts_with("/api/") || route.contains(['?', '#']) {
            return Err("Invalid application route".into());
        }
        let response = self
            .authenticated(self.agent.get(&format!("{}{route}", self.origin)))
            .set("Accept", "application/json")
            .call();
        let (status, value) = response_json(response)?;
        if status != 200 {
            return Err(format!(
                "Read failed (HTTP {status}): {}",
                error_code(&value)
            ));
        }
        Ok(value)
    }
    pub fn principal(&self) -> Result<String> {
        let session = self.get("/api/session")?;
        if session.get("credentialClass").and_then(Value::as_str) != Some("human") {
            return Err("A human Cloudflare Access session is required".into());
        }
        session
            .get("principalId")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty() && id.len() <= 1024)
            .map(str::to_owned)
            .ok_or("Application session identity missing".into())
    }
    pub fn send(&self, record: &RequestRecord) -> Result<(u16, Value)> {
        if record.target != self.origin
            || record.local_development != self.local
            || self.principal()? != record.principal_id
        {
            return Err(
                "Current target or identity differs from the saved request; no request was sent"
                    .into(),
            );
        }
        let mut request = self
            .authenticated(self.agent.post(&format!("{}{}", self.origin, record.route)))
            .set("Origin", &self.origin)
            .set("X-Platform-CSRF", "1")
            .set("Content-Type", "application/json")
            .set("Accept", "application/json")
            .set("Idempotency-Key", &record.command_id)
            .set("If-Platform-Principal", &record.principal_id);
        if let Some(revision) = &record.expected_revision {
            request = request.set("If-Platform-Revision", revision);
        }
        if let Some(incarnation) = &record.expected_incarnation {
            request = request.set("If-Platform-Incarnation", incarnation);
        }
        response_json(request.send_bytes(canonical(&record.body).as_bytes()))
    }
}
fn response_json(
    response: std::result::Result<ureq::Response, ureq::Error>,
) -> Result<(u16, Value)> {
    let response = match response {
        Ok(response) | Err(ureq::Error::Status(_, response)) => response,
        Err(_) => return Err("Transport failed; the server may have applied the request. Keep and resume its exact journal rather than creating a new operation.".into()),
    };
    let status = response.status();
    if (300..400).contains(&status) {
        return Err("Application redirected the request; no redirect was followed. Refresh Cloudflare Access login before resuming the same journal.".into());
    }
    if response
        .header("Content-Type")
        .and_then(|value| value.split(';').next())
        != Some("application/json")
    {
        return Err("Application did not return JSON. Authenticate to the exact target and resume the same journal.".into());
    }
    let mut bytes = Vec::new();
    response
        .into_reader()
        .take(8 * 1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "Response read failed; preserve the request journal")?;
    if bytes.len() > 8 * 1024 * 1024 {
        return Err("Application response exceeds 8 MiB; preserve the request journal".into());
    }
    Ok((
        status,
        serde_json::from_slice(&bytes)
            .map_err(|_| "Application returned malformed JSON; preserve the request journal")?,
    ))
}
pub fn error_code(value: &Value) -> &str {
    value
        .get("error")
        .and_then(Value::as_str)
        .or_else(|| value.get("code").and_then(Value::as_str))
        .or_else(|| {
            value
                .get("error")
                .and_then(|error| error.get("code"))
                .and_then(Value::as_str)
        })
        .filter(|value| {
            value.len() <= 128
                && value
                    .bytes()
                    .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_')
        })
        .unwrap_or("UNEXPECTED_RESPONSE")
}
