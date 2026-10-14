use super::*;
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Execution {
    generation: String,
    event_generation: String,
    lifecycle: String,
    outcome: String,
    admissions: String,
    event: String,
    verified: bool,
}
#[wasm_bindgen]
pub fn transition_execution(input: &str) -> String {
    let result = (|| -> Result<Value, String> {
        let i: Execution = parse(input)?;
        counter(&i.generation)?;
        counter(&i.event_generation)?;
        if i.generation != i.event_generation {
            return Err("EXECUTION_GENERATION_FENCED".into());
        }
        if !matches!(
            i.lifecycle.as_str(),
            "RESERVED"
                | "START_MAY_HAVE_DISPATCHED"
                | "RUNNING"
                | "UNKNOWN"
                | "STOP_REQUESTED"
                | "STOPPED"
        ) || !matches!(
            i.outcome.as_str(),
            "PENDING" | "COMPLETED" | "FAILED" | "CANCELLED" | "BUDGET_EXHAUSTED"
        ) || !matches!(i.admissions.as_str(), "OPEN" | "FENCED")
        {
            return Err("INVALID_EXECUTION_STATE".into());
        }
        let mut lifecycle = i.lifecycle.clone();
        let mut outcome = i.outcome.clone();
        let mut admissions = i.admissions.clone();
        let mut effects = Vec::new();
        match (i.lifecycle.as_str(), i.event.as_str()) {
            ("RESERVED", "DISPATCH_START") if i.admissions == "OPEN" => {
                lifecycle = "START_MAY_HAVE_DISPATCHED".into();
                effects.push("start-generation");
            }
            ("START_MAY_HAVE_DISPATCHED", "START_OBSERVED") if i.verified => {
                lifecycle = "RUNNING".into();
            }
            (
                "START_MAY_HAVE_DISPATCHED" | "RUNNING" | "STOP_REQUESTED" | "UNKNOWN",
                "RESPONSE_LOST",
            ) => {
                lifecycle = "UNKNOWN".into();
            }
            ("RUNNING" | "UNKNOWN", "COMPLETION_OBSERVED") if i.verified => {
                if i.outcome != "PENDING" && i.outcome != "COMPLETED" {
                    return Err("CONFLICTING_EXECUTION_OUTCOME".into());
                }
                outcome = "COMPLETED".into();
                admissions = "FENCED".into();
                lifecycle = "STOP_REQUESTED".into();
                effects.push("stop-whole-generation");
            }
            (
                "RESERVED" | "START_MAY_HAVE_DISPATCHED" | "RUNNING" | "UNKNOWN" | "STOP_REQUESTED",
                "CANCEL" | "DEADLINE" | "REVOKE",
            ) => {
                admissions = "FENCED".into();
                lifecycle = "STOP_REQUESTED".into();
                if outcome == "PENDING" {
                    outcome = if i.event == "DEADLINE" {
                        "BUDGET_EXHAUSTED"
                    } else {
                        "CANCELLED"
                    }
                    .into();
                }
                effects.push("stop-whole-generation");
            }
            ("STOP_REQUESTED" | "UNKNOWN", "STOP_CONFIRMED") if i.verified => {
                lifecycle = "STOPPED".into();
                admissions = "FENCED".into();
            }
            ("STOPPED", "STOP_CONFIRMED") if i.verified => {}
            _ => return Err("INVALID_EXECUTION_TRANSITION".into()),
        }
        Ok(
            json!({"accepted":true,"generation":i.generation,"lifecycle":lifecycle,"outcome":outcome,"admissions":admissions,"capacityHeld":lifecycle!="STOPPED","mayReplaceGeneration":lifecycle=="STOPPED","effects":effects}),
        )
    })();
    match result {
        Ok(v) => canonical(&v),
        Err(e) => canonical(&json!({"accepted":false,"reason":e})),
    }
}
