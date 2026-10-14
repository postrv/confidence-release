# Confidence judge packet

Confidence turns parallel agent work into an explainable, reviewable and independently verifiable release decision. Start with the concrete wrong value after a successful write, then follow the repair that preserves useful caching and accessible status.

This packet was prepared on **12 October 2026**. It contains a working local reproduction, signed synthetic verifier example, an actual eight-minute narrated demonstration with measured delivery records, claim boundaries and a submission checklist. It is not a submission receipt or proof that judges can currently access the private repository. No production publication was repeated to prepare it.

## Start here

| Judge task | Artifact |
| --- | --- |
| Run the supported local journey | [Run instructions](RUN.md) and [fresh-checkout rehearsal](REHEARSAL.json) |
| Verify a portable receipt without an account | [Public example](examples/receipt.json), [selected public trust](examples/trust.json), [signed checkpoint](examples/checkpoint-attestation.json) |
| Understand the Cloudflare result | [Retained publication checkpoint](../PILOT_RELEASE_GATE_F508454.md) and [current release status](../RELEASE_STATUS.md) |
| Inspect the tools-enabled comparison | [Measured report](../../experiments/authoring-tools/LIVE_COMPARISON_2026-10-12.md) and [sanitized data](../../experiments/authoring-tools/live-comparison-2026-10-12.json) |
| Inspect automatic completion after the recovery fix | [Separate native confirmation](../TOOLS_RECOVERY_CONFIRMATION_2026-10-12.md), signed-check digest index (retained private reference; unavailable in this source distribution) and release association (retained private reference; unavailable in this source distribution) |
| Inspect the finished demonstration | [Video delivery record](DEMO_DELIVERY.md) and [measured capture ledger](completed-capture-ledger.json) |
| Use the improved narration | [Neural successor provenance](neural-narration-ledger.json); identical video stream and content, with separately checked new audio |
| Understand benchmarks, throughput and tool creators | [Benchmark guide](../BENCHMARKS.md), [throughput calculations](../THROUGHPUT.md), [evidence map](../EVIDENCE.md) and [team tools](../TEAM_TOOLS.md) |
| Prepare the final manual submission | [Eight-minute script](DEMO_SCRIPT.md), [original planned ledger](capture-ledger.json), [submission checklist](SUBMISSION_CHECKLIST.md) |
| Check what is and is not claimed | [Evidence and boundaries](CLAIMS.md) |

## Verify a public example

From a checkout containing this packet, build the native verifier and run:

```sh
cargo build --locked -p confidence-verifier --release
node scripts/judge-packet-verify.mjs
```

The helper checks each input's byte digest, verifies all six positive result facets, then changes a disposable signature and requires `BAD_SIGNATURE`. It never changes the retained example, calls a model, contacts Cloudflare or accepts a production trust key. The same helper passed with OS networking disabled. After its initial build, the native binary needs only the three JSON files; no account or service is required.

The example is an **unmodified export from a new local scripted rehearsal**, not a redacted production receipt. Its synthetic `local-tenant` scope and public keys are intentionally explicit. Selecting these keys verifies this example only; it does not establish the identity of the Cloudflare deployment. Private keys, sessions, full state and configuration are excluded. [Exact provenance and file digests](REHEARSAL.json)

## Source and license

The clean-checkout rehearsal used source commit `ec00334c1c2c8e2156ae0c11baf0bade3cebde1c`, tree `a57687d0bf7151c4e4db876f4eed1b777852681e`. It does not validate later working changes, a later deployment or the finished video. The final submitted source must receive its own exact revision and final checks; never invent the eventual commit in advance.

The finished video actually captured committed source `680a5ef373d1904d463b155d74a99190ec04ab8e`, tree `42cfb0ebbfd502558164b0fcf6521f7b8c670c06`. Its local source/assets matched before and after capture and rendering. Merged source `4fd4a6cd32f60b17d7b5d8d0f1995490a0f28d8b` has that same tree; a later documentation-only delivery revision is a separate identity. The original synthetic example keeps its `ec00334` provenance. The [delivery record](DEMO_DELIVERY.md) distinguishes actual local footage, historical native records and the selected example trust.

The original comparison remains unchanged, including its controller failure and longer enabled full workflow. The [fresh verified companion](../TOOLS_RECOVERY_CONFIRMATION_2026-10-12.md) completed coding-to-cleanup automatically: one call, nine independently verified checker signatures, observed cleanup and normal restoration. Its coding span was 110.339 seconds and coding-to-cleanup span 205.530 seconds, excluding deployment. No live stale rejection occurred; 33 deterministic tests cover fault recovery. This new result is not added to the original paired comparison or retrospectively attributed to video footage.

Original project source is [Apache-2.0](../../LICENSE), with [NOTICE](../../NOTICE). Retain both, `package-lock.json`, `Cargo.lock` and the repository's third-party notices in the source handoff. Dependencies keep their own licenses. This packet distributes source and JSON examples, not bundled `node_modules`, model weights or prebuilt third-party binaries. A binary distribution needs the corresponding third-party notices; this packet is not an exhaustive license-clearance opinion.

The preferred video is the neural-narration successor described in the [delivery record](DEMO_DELIVERY.md); original footage, original delivery metadata and dated evidence remain retained. Narration is a locally synthesized stock voice, not a live agent session or the entrant. No paid model calls or Cloudflare actions were made for the replacement.

The repository remains private at preparation time. A local clone demonstrates reproducibility on this machine, not external judge access. Source access, the entrant's complete viewing/upload check and manual submission remain separate checklist items. The [public-source handover](../PUBLIC_SUBMISSION_HANDOVER.md) defines the later reviewed export; archived private development/operator material is not automatically part of that public package.
