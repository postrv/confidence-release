# Welcome to Confidence

Confidence helps concurrent agents contribute to one release while keeping proposed work, passing checks, human approval and observed publication distinct. Start with a local walkthrough; it needs no Cloudflare account or model credential.

This is a reviewed clean public source distribution, with a separate Git history from the private development repository. The [source manifest](../PUBLIC_SOURCE_MANIFEST.json) records original commit `4fc8bfcb24415412d854962713b2ecc3f3bbeeef`, tree `9f678889b0d3654bd624c32ba3bbca13ca644e16`, selected summaries and excluded private evidence. Historical reports retain their original dates and source identities. They do not establish fresh qualification of this export.

## The first 15 minutes

Follow [the local run instructions](judge-packet/RUN.md), then read the [architecture tour](ARCHITECTURE_TOUR.md), [evidence guide](EVIDENCE.md) and [release status](RELEASE_STATUS.md). The [documentation guide](README.md) links the detailed references.

Three agents can each improve a small service while their combined changes break it: one caches reads, another removes cache invalidation, and another improves the interface. A clean Git merge can still return stale data after an acknowledged write. Confidence retains immutable source and named results, evaluates the combination, records a counterexample and bounds a repair to the failed source. A reviewer inspects the exact proposal before approval and publication.

Here, publication advances the project's canonical Git ref. GitHub repository publication and deployment are separate operator actions.

## Know which runtime you are using

The default walkthrough runs predetermined edits in concurrent local child processes with real Git and HTTP observations. It executes trusted fixture code under your host OS identity. It makes no model call and provides no Cloudflare isolation.

Configured Pi execution, retained native observations, local workerd tests and optional private-source Weft qualification each have different evidence boundaries. Consult the dated reports rather than treating a local check as a deployment gate. General full-repository execution remains unregistered. The optional Weft implementation and confidential bundles are not distributed; the ordinary local journey and synthetic contract tests work without them. See [the integration boundary](WEFT_INTEGRATION.md).

## Get a local walkthrough running

Use macOS or Linux, Git, Node 24 (minimum 22.19), Rust through rustup and wasm-pack 0.13.1. [rust-toolchain.toml](../rust-toolchain.toml) pins Rust 1.98.0 and the WASM target. Python 3 supports broader checks; Docker supports the separate container checks.

```sh
git clone https://github.com/postrv/confidence-release.git
cd confidence-release
git rev-parse HEAD HEAD^{tree}
rustup show
cargo install wasm-pack --version 0.13.1 --locked
npm ci
npm run build
npm run demo
npm run verify -- demo-output/receipt.json demo-output/trust.json demo-output/checkpoint-attestation.json
```

Initial installation can use the network. Keep generated state, keys, sessions and operator configuration private. The [run instructions](judge-packet/RUN.md) include the browser journey and offline native verifier, including a tamper rejection. Their retained rehearsal is dated evidence; a fresh export needs a separately observed reproduction.

## Find your way around the code

| Area | Start here |
| --- | --- |
| Browser and exact request identity | [App](../apps/web/src/App.tsx), [Workspace](../apps/web/src/Workspace.tsx), [Review](../apps/web/src/Review.tsx), [commands](../apps/web/src/commands.ts) |
| Local runtime | [Server](../services/server.ts), [platform](../services/platform.ts), [integration checks](../tests/integration/local-system.test.ts) |
| Protocol and portable verification | [Rust kernel](../crates/protocol/src/lib.rs), [wire types](../packages/protocol/src/types.ts), [native verifier](../crates/verifier-cli) |
| Cloudflare boundaries | [Architecture tour](ARCHITECTURE_TOUR.md), [operations](../infra/README.md), [Artifacts integration](ARTIFACTS_INTEGRATION.md) |

## Make a first contribution

Agree file ownership before parallel edits, branch from the intended public baseline and retain exact request identities when results are uncertain. Run nearby checks while editing and `npm run test:local` for the aggregate local gate. See [CI](../.github/workflows/validate.yml) for the additional checks and container prerequisites. No local check authorizes a deployment, paid model invocation or publication.

Keep private state, credentials, personal correspondence and operator journals out of commits. Preserve signed example bytes; summaries and redacted records must never be presented as original signed evidence.
