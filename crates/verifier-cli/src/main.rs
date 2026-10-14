use std::{env, fs, process};
fn main() {
    let args: Vec<_> = env::args().skip(1).collect();
    if !(2..=3).contains(&args.len()) {
        eprintln!(
            "Usage: confidence-verifier BUNDLE.json INDEPENDENT-TRUST.json [PINNED-CHECKPOINT.json]"
        );
        process::exit(2);
    }
    let load = |path: &str| {
        let metadata = fs::metadata(path).unwrap_or_else(|e| {
            eprintln!("{path}: {e}");
            process::exit(2)
        });
        if metadata.len() > confidence_protocol::MAX_JSON_BYTES as u64 {
            eprintln!("Input exceeds 8 MiB");
            process::exit(2);
        }
        fs::read_to_string(path).unwrap_or_else(|e| {
            eprintln!("{path}: {e}");
            process::exit(2)
        })
    };
    let result = confidence_protocol::verify(
        &load(&args[0]),
        &load(&args[1]),
        &args.get(2).map(|p| load(p)).unwrap_or("null".into()),
    );
    println!("{}", serde_json::to_string_pretty(&result).unwrap());
    if result["valid"] != true {
        process::exit(1);
    }
}
