use super::*;
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Grant {
    scope: Scope,
    id: String,
    subject_id: String,
    attempt_id: String,
    generation: String,
    authority_generation: String,
    operations: Vec<String>,
    resources: Vec<String>,
    path_prefixes: Vec<String>,
    destinations: Vec<String>,
    starts_at: u64,
    expires_at: u64,
    budget_micro_units: String,
    revoked: bool,
}
const OPS: &[&str] = &[
    "read-source",
    "write-attempt",
    "start-execution",
    "checkpoint-context",
    "model-inference",
    "submit-output",
    "propose-selection",
    "request-evaluation",
    "request-repair",
    "read-evidence",
];
fn ordered(xs: &[String]) -> bool {
    xs.len() <= 128 && xs.windows(2).all(|p| p[0] < p[1])
}
fn path_contains(prefix: &str, path: &str) -> bool {
    prefix.is_empty()
        || prefix == path
        || path
            .strip_prefix(prefix)
            .is_some_and(|tail| tail.starts_with('/'))
}
fn grant_valid(g: &Grant) -> Result<(), String> {
    if !g.scope.valid()
        || [&g.id, &g.subject_id, &g.attempt_id]
            .iter()
            .any(|s| !bounded_id(s))
        || g.starts_at >= g.expires_at
        || g.expires_at > 253402300799
    {
        return Err("INVALID_GRANT".into());
    }
    for n in [
        &g.generation,
        &g.authority_generation,
        &g.budget_micro_units,
    ] {
        counter(n)?;
    }
    if !ordered(&g.operations)
        || !ordered(&g.resources)
        || !ordered(&g.path_prefixes)
        || !ordered(&g.destinations)
        || g.operations.is_empty()
        || g.resources.is_empty()
    {
        return Err("INVALID_SCOPE_SET".into());
    }
    if g.operations.iter().any(|o| !OPS.contains(&o.as_str()))
        || g.resources.iter().any(|s| !bounded_id(s))
    {
        return Err("UNSUPPORTED_OPERATION_OR_RESOURCE".into());
    }
    for p in &g.path_prefixes {
        if !p.is_empty() {
            valid_path(p)?;
        }
    }
    for d in &g.destinations {
        if d.is_empty()
            || d.len() > 253
            || !d
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'.' || b == b'-')
            || d.starts_with('.')
            || d.ends_with('.')
        {
            return Err("INVALID_DESTINATION".into());
        }
    }
    Ok(())
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct GrantInput {
    grant: Grant,
    current_scope: Scope,
    subject_id: String,
    attempt_id: String,
    current_generation: String,
    current_authority_generation: String,
    operation: String,
    resource: String,
    path: Option<String>,
    destination: Option<String>,
    now: u64,
    maximum_cost: String,
    available_budget: String,
}
fn check(i: &GrantInput) -> Result<(), String> {
    let g = &i.grant;
    grant_valid(g)?;
    if g.scope != i.current_scope || g.subject_id != i.subject_id || g.attempt_id != i.attempt_id {
        return Err("GRANT_SUBJECT_MISMATCH".into());
    }
    if g.generation != i.current_generation
        || g.authority_generation != i.current_authority_generation
    {
        return Err("GRANT_GENERATION_FENCED".into());
    }
    if g.revoked {
        return Err("GRANT_REVOKED".into());
    }
    if i.now < g.starts_at || i.now >= g.expires_at {
        return Err("GRANT_EXPIRED_OR_NOT_STARTED".into());
    }
    if !g.operations.contains(&i.operation) || !g.resources.contains(&i.resource) {
        return Err("GRANT_OPERATION_DENIED".into());
    }
    if let Some(p) = &i.path {
        valid_path(p)?;
        if !g
            .path_prefixes
            .iter()
            .any(|prefix| path_contains(prefix, p))
        {
            return Err("GRANT_PATH_DENIED".into());
        }
    }
    if let Some(d) = &i.destination
        && !g.destinations.contains(d)
    {
        return Err("GRANT_DESTINATION_DENIED".into());
    }
    if counter(&i.maximum_cost)? > counter(&i.available_budget)?
        || counter(&i.maximum_cost)? > counter(&g.budget_micro_units)?
    {
        return Err("BUDGET_EXHAUSTED".into());
    }
    Ok(())
}
#[wasm_bindgen]
pub fn validate_grant(input: &str) -> String {
    match parse::<GrantInput>(input).and_then(|i| check(&i)) {
        Ok(()) => canonical(&json!({"accepted":true,"reason":"GRANTED"})),
        Err(e) => canonical(&json!({"accepted":false,"reason":e})),
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Inclusion {
    parent: Grant,
    child: Grant,
}
#[wasm_bindgen]
pub fn grant_inclusion(input: &str) -> String {
    let r = (|| -> Result<(), String> {
        let i: Inclusion = parse(input)?;
        grant_valid(&i.parent)?;
        grant_valid(&i.child)?;
        let p = &i.parent;
        let c = &i.child;
        if p.scope != c.scope
            || c.starts_at < p.starts_at
            || c.expires_at > p.expires_at
            || counter(&c.budget_micro_units)? > counter(&p.budget_micro_units)?
            || c.operations.iter().any(|x| !p.operations.contains(x))
            || c.resources.iter().any(|x| !p.resources.contains(x))
            || c.destinations.iter().any(|x| !p.destinations.contains(x))
            || c.path_prefixes.iter().any(|x| {
                !p.path_prefixes
                    .iter()
                    .any(|prefix| path_contains(prefix, x))
            })
        {
            return Err("DELEGATION_EXPANDS_SCOPE".into());
        }
        Ok(())
    })();
    match r {
        Ok(()) => canonical(&json!({"accepted":true,"reason":"CONTAINED"})),
        Err(e) => canonical(&json!({"accepted":false,"reason":e})),
    }
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BudgetInput {
    limit: String,
    held: String,
    settled: String,
    reservation: String,
    phase: String,
    event: String,
    observed_cost: Option<String>,
}
#[wasm_bindgen]
pub fn budget_transition(input: &str) -> String {
    let r = (|| -> Result<Value, String> {
        let i: BudgetInput = parse(input)?;
        let limit = counter(&i.limit)?;
        let mut held = counter(&i.held)?;
        let mut settled = counter(&i.settled)?;
        let maximum = counter(&i.reservation)?;
        if held.checked_add(settled).ok_or("BUDGET_OVERFLOW")? > limit {
            return Err("INVALID_BUDGET_STATE".into());
        }
        let phase = match (i.phase.as_str(), i.event.as_str()) {
            ("NONE", "RESERVE") => {
                held = held.checked_add(maximum).ok_or("BUDGET_OVERFLOW")?;
                if held.checked_add(settled).ok_or("BUDGET_OVERFLOW")? > limit {
                    return Err("BUDGET_EXHAUSTED".into());
                }
                "RESERVED"
            }
            ("RESERVED", "DISPATCH") if held >= maximum => "DISPATCHED",
            ("DISPATCHED" | "UNKNOWN", "UNKNOWN") if held >= maximum => "UNKNOWN",
            ("RESERVED", "RELEASE") if held >= maximum => {
                held -= maximum;
                "RELEASED"
            }
            ("DISPATCHED" | "UNKNOWN", "SETTLE") if held >= maximum => {
                let actual = i
                    .observed_cost
                    .as_ref()
                    .map(|v| counter(v))
                    .transpose()?
                    .unwrap_or(maximum);
                if actual > maximum {
                    return Err("COST_EXCEEDS_RESERVATION".into());
                }
                held -= maximum;
                settled = settled.checked_add(actual).ok_or("BUDGET_OVERFLOW")?;
                "SETTLED"
            }
            _ => return Err("INVALID_BUDGET_TRANSITION".into()),
        };
        Ok(
            json!({"accepted":true,"phase":phase,"held":held.to_string(),"settled":settled.to_string()}),
        )
    })();
    match r {
        Ok(v) => canonical(&v),
        Err(e) => canonical(&json!({"accepted":false,"reason":e})),
    }
}
