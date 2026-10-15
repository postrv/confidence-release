# Run and verify Confidence

No Cloudflare account, model credential, private Weft source or paid authoring is required for this local path. It executes the trusted bundled fixture under your host OS identity.

## Tested source

The [public source manifest](../../PUBLIC_SOURCE_MANIFEST.json) binds this distribution to original source commit `9a067a0491dc9ec56ec34fe66d647729c0ccdbac`, tree `0739636db2c10b7060159a1affdcea5354e17fa6`. The public export has a separate Git identity; do not try to check out a private-history commit from the clean repository.

The retained [12 October rehearsal](REHEARSAL.json) is dated evidence for its own source and signed example. It is not a fresh test of this later export. Final export reproduction and external judge access require separately retained observations.

## Prerequisites and install

Use macOS or Linux, Git, Node 24 (minimum 22.19), Rust via rustup and wasm-pack 0.13.1. `rust-toolchain.toml` pins Rust 1.98.0 and the WASM target. Python 3 is required for the broader reference checks; Docker is needed for separate image checks.

```sh
git clone https://github.com/postrv/confidence-release.git
cd confidence-release
git rev-parse HEAD HEAD^{tree}
rustup show
cargo install wasm-pack --version 0.13.1 --locked
npm ci
npm run build
```

Initial tool and dependency installation may use the network. Do not copy private `.pilot`, local state, credentials or installed dependencies into a clean rehearsal.

## CLI journey

```sh
npm run demo
npm run verify -- demo-output/receipt.json demo-output/trust.json demo-output/checkpoint-attestation.json
```

The demo uses concurrent child processes with predetermined edits, real local Git and HTTP observations, scripted approval, a local ref update and reconciliation of the same simulated lost-response publication. It is not real model authoring or Cloudflare isolation. A new run generates new identities and signatures, so compare named behavior and verifier results rather than byte equality to the retained example. Keep generated state, keys and sessions private.

## Browser journey

```sh
rehearsal_data="$(mktemp -d "${TMPDIR:-/tmp}/confidence-rehearsal.XXXXXX")"
npm run dev -- --data-dir "$rehearsal_data"
```

Open the printed loopback URL. Launch scripted attempts, inspect their assignments, compose, inspect the counterexample, repair, review the exact source, approve, publish locally and verify. Restart with the same directory to resume; do not erase uncertain state. The server serves built assets, so rebuild after source edits. Browser sessions on the same hostname can interfere across rehearsals.

## Offline verifier only

```sh
cargo build --locked -p confidence-verifier --release
node scripts/judge-packet-verify.mjs
```

After compilation, the direct verifier needs only the three selected public files and can run offline:

```sh
./target/release/confidence-verifier \
  docs/judge-packet/examples/receipt.json \
  docs/judge-packet/examples/trust.json \
  docs/judge-packet/examples/checkpoint-attestation.json
```

Expected: `valid`, `integrity`, `authorization`, `publicationObservation`, `continuity` and `sourceVerified` are true. The retained logical receipt digest is `sha256:c8354d78d883728c4a1a5d33dbe568ce2cc014296cc1b2ea7ab24df94f4df4f9`. The helper changes a disposable signature and requires rejection with `BAD_SIGNATURE`; it never modifies the retained example. Trust is explicitly synthetic and separately selected. Verification does not prove the current remote ref or general program correctness.

## Optional private Weft lane

The normal local workflow and public example work without Weft. Its optional real-source lane requires a separately authorized pinned private checkout and dependency closure. This distribution includes no Weft implementation or confidential bundle. Keep absent/private-source qualification distinct from the included synthetic contract tests. [Integration boundary](../WEFT_INTEGRATION.md)
