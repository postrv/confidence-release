# Confidence

Confidence connects parallel agent work to an exact, reviewable release decision: immutable contributions, behavioral interaction evidence, repair that preserves useful goals, human review of frozen source, conditional Git publication, and a portable signed receipt.

This is the reviewed source distribution for [postrv/confidence-release](https://github.com/postrv/confidence-release). Its [source manifest](PUBLIC_SOURCE_MANIFEST.json) records the original source commit/tree, every distributed file, deliberate documentation transformations and exclusions. The clean public Git history differs from the original private development history. Export preparation alone does not establish publication, external access or a submitted competition entry.

## Run locally

Use macOS or Linux, Git, Node 24 (minimum 22.19), Rust 1.98.0 and wasm-pack 0.13.1:

```sh
git clone https://github.com/postrv/confidence-release.git
cd confidence-release
rustup show
cargo install wasm-pack --version 0.13.1 --locked
npm ci
npm run build
npm run demo
npm run verify -- demo-output/receipt.json demo-output/trust.json demo-output/checkpoint-attestation.json
```

The scripted journey uses concurrent local subprocesses with predetermined edits, real local Git and HTTP checks, synthetic approval and explicitly selected local trust. It needs no Cloudflare account, private Weft checkout, model credential or paid call. Installation may need network access. Local execution shares your host identity: run only the trusted bundled fixture.

For the browser, run `npm run dev` and open the printed loopback URL. The [complete run instructions](docs/judge-packet/RUN.md) include a fresh data directory and offline positive/tamper-negative verification. Keep generated state, keys and sessions private. The [judge packet](docs/judge-packet/README.md) distinguishes this local reproduction from historical native Cloudflare observations and the recorded eight-minute demonstration.

## Supported product and boundaries

The native workflow has a deliberately bounded JavaScript cache workload and protected behavioral checks. Project management, committed Git import, source inspection, discussion and scoped collaboration are separate capabilities; importing a repository or storing check definitions does not enable arbitrary execution or publication. Optional capabilities are gated by the deployment configuration. Public signup and hostile multi-tenant readiness are not established.

**Weft is an optional private dependency and is unavailable in this source distribution.** Confidence's adapters, protocol consumers, guarded test lanes and synthetic fixtures are included. No Weft implementation, confidential source bundle, private checkout or credential is included. The ordinary local demo does not require Weft. A real-Weft qualification lane requires a separately authorized pinned source checkout; an absent checkout must remain unavailable, rather than being represented as a successful real integration. Full-repository protected execution remains unregistered. See the [public integration boundary](docs/WEFT_INTEGRATION.md) and [repository milestone](docs/CONFIDENCE_DOGFOOD.md).

## Architecture and evidence

Cloudflare Workers route verified requests, Durable Objects coordinate scoped decisions and recovery, Artifacts holds Git, R2 retains source/evidence, separate Sandboxes author and evaluate, and Queues/D1 provide the rebuildable view. The Rust kernel is shared with browser/WASM and native verification. [Architecture](docs/ARCHITECTURE_TOUR.md)

The retained native pilot demonstrated parallel real-model contributions, a behavioral failure, goal-preserving repair, nine protected cases, exact human review, Artifacts publication and independent receipt verification. Its original identities remain historical. The packet's downloadable signed example is a different, explicitly synthetic enrollment. Private raw operator reports are excluded; any reference to an unavailable original is labelled. Public summaries are not substituted signed originals. [Evidence map](docs/EVIDENCE.md), [claim boundaries](docs/judge-packet/CLAIMS.md)

The recorded paired coding experiment is one task and one episode per mode. Its faster tools-enabled coding interval does not establish a general speedup; its longer full workflow and recovery pause remain part of the result. [Benchmark definitions](docs/BENCHMARKS.md)

## Team tools and license

Narsil (`narsil-mcp`) was created by Laurence Avent. Interlinked CLI was created by Quentin Cody. Their source context and proposal previews are advisory; they cannot grant acceptance or publication authority. The source pins, upstream licenses and documented Interlinked modification are retained in [NOTICE](NOTICE), [team-tool credits](docs/TEAM_TOOLS.md) and `integrations/`.

Original Confidence source is [Apache-2.0](LICENSE). Third-party packages retain their licenses and notices. This source-only distribution does not bundle installed dependencies, tool binaries, model weights, private operator state or private Git history. A distribution of those artifacts needs its own applicable license review.
