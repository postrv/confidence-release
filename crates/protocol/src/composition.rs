use super::*;
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Submission {
    id: String,
    manifest: Manifest,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ComposeInput {
    base: Manifest,
    submissions: Vec<Submission>,
}
fn entries(m: &Manifest) -> BTreeMap<String, ManifestEntry> {
    m.entries
        .iter()
        .map(|e| (e.path.clone(), e.clone()))
        .collect()
}
#[wasm_bindgen]
pub fn compose_manifests(input: &str) -> String {
    let r = (|| -> Result<Value, String> {
        let i: ComposeInput = parse(input)?;
        check_manifest(&i.base)?;
        if i.submissions.is_empty() || i.submissions.len() > 4 {
            return Err("COMPOSITION_LIMIT".into());
        }
        let base = entries(&i.base);
        let mut deltas = BTreeMap::<String, (Option<ManifestEntry>, Vec<String>)>::new();
        let mut conflicts = Vec::new();
        let mut ids = BTreeSet::new();
        for s in &i.submissions {
            if !bounded_id(&s.id) || !ids.insert(&s.id) {
                return Err("INVALID_SUBMISSION_ID".into());
            }
            check_manifest(&s.manifest)?;
            let next = entries(&s.manifest);
            let paths: BTreeSet<_> = base.keys().chain(next.keys()).collect();
            for path in paths {
                let old = base.get(path);
                let new = next.get(path);
                if old == new {
                    continue;
                }
                if let Some((prior, owners)) = deltas.get_mut(path) {
                    if prior.as_ref() != new {
                        conflicts.push(json!({"path":path,"submissions":owners.iter().cloned().chain(std::iter::once(s.id.clone())).collect::<Vec<_>>(),"category":"mechanical-overlap"}));
                    } else {
                        owners.push(s.id.clone());
                    }
                } else {
                    deltas.insert(path.clone(), (new.cloned(), vec![s.id.clone()]));
                }
            }
        }
        if !conflicts.is_empty() {
            return Ok(
                json!({"accepted":false,"reason":"MECHANICAL_CONFLICT","conflicts":conflicts}),
            );
        }
        let mut result = base;
        for (path, (entry, _)) in deltas {
            if let Some(e) = entry {
                result.insert(path, e);
            } else {
                result.remove(&path);
            }
        }
        let m = Manifest {
            schema_version: 1,
            path_profile: "portable-ascii-v1".into(),
            entries: result.into_values().collect(),
        };
        check_manifest(&m)?;
        Ok(json!({"accepted":true,"manifest":m}))
    })();
    match r {
        Ok(v) => canonical(&v),
        Err(e) => canonical(&json!({"accepted":false,"reason":e})),
    }
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Transplant {
    original_base: Manifest,
    desired: Manifest,
    current_base: Manifest,
}
#[wasm_bindgen]
pub fn transplant_manifest(input: &str) -> String {
    let r = (|| -> Result<Value, String> {
        let i: Transplant = parse(input)?;
        check_manifest(&i.original_base)?;
        check_manifest(&i.desired)?;
        check_manifest(&i.current_base)?;
        let original = entries(&i.original_base);
        let desired = entries(&i.desired);
        let mut current = entries(&i.current_base);
        let mut conflicts = Vec::new();
        let paths: BTreeSet<_> = original.keys().chain(desired.keys()).collect();
        for path in paths {
            let p = original.get(path);
            let t = desired.get(path);
            if p == t {
                continue;
            }
            let b = current.get(path);
            if b == t {
                continue;
            }
            if b != p {
                conflicts.push(path.clone());
                continue;
            }
            if let Some(e) = t {
                current.insert(path.clone(), e.clone());
            } else {
                current.remove(path);
            }
        }
        if !conflicts.is_empty() {
            return Ok(
                json!({"accepted":false,"reason":"TRANSPLANT_CONFLICT","conflicts":conflicts}),
            );
        }
        let result = Manifest {
            schema_version: 1,
            path_profile: "portable-ascii-v1".into(),
            entries: current.into_values().collect(),
        };
        check_manifest(&result)?;
        Ok(json!({"accepted":true,"manifest":result}))
    })();
    match r {
        Ok(v) => canonical(&v),
        Err(e) => canonical(&json!({"accepted":false,"reason":e})),
    }
}
