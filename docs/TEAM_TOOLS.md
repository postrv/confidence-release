# Team tools and attribution

Confidence combines two tools created by the competition team with its own
permission, evaluation and release authority. **Narsil was created by Laurence
Avent ([postrv](https://github.com/postrv)); Interlinked CLI was created by teammate
Quentin Cody ([QuentinCody](https://github.com/QuentinCody)).** Their complementary
roles are visible in retained tool inputs, not inferred from configuration flags.

## How the stages fit

| Stage | Component and creator | Integrated contribution | Trust boundary |
| --- | --- | --- | --- |
| Understand relevant source before proposing | [Narsil / `narsil-mcp`](https://github.com/postrv/narsil-mcp), Laurence Avent | Fixed local MCP queries identify symbols, dependencies and callers in an immutable source snapshot. Confidence reconstructs every excerpt from the verified original bytes. | Advisory context only; never grants permission, skips a protected check or accepts source. |
| Check a complete proposal before writing | [Interlinked CLI / `interlinked-cli`](https://github.com/QuentinCody/interlinked-cli), Quentin Cody | Native `verify-changeset --stdin --json` previews all proposed files. Blocking findings can request a bounded correction under the same path grant and proposal budget. | Authoring diagnostic only; a clean preview is not protected acceptance or complete checker coverage. |
| Evaluate and authorize release | Confidence authority and protected evaluator | Bind permissions, goal, source, checker and runtime; run the external check plan; require exact approval for publication and retain independently verifiable evidence. | Tool advice cannot substitute for protected checks, human approval or the release authority. |

The integration deliberately uses a narrow subset of each upstream project.
Narsil's broader security, neural, LSP, Git and visualization capabilities are not
used by this integration. Interlinked's hook installation, guard daemon, reservations and
authenticated sync are not installed or invoked. Confidence owns proposal
application, attempt lifecycle, permissions and final evaluation.

## Exact builds and licenses

| Component | Submission integration pin | License and retained provenance |
| --- | --- | --- |
| Narsil | **1.7.2**, revision [`cf8eac40ce736f3706450e4b256b56f6845af8e5`](https://github.com/postrv/narsil-mcp/tree/cf8eac40ce736f3706450e4b256b56f6845af8e5); checksum-verified published crate, locked source build on Bookworm | **MIT OR Apache-2.0**. Upstream MIT copyright remains **2024 postrv**. The image retains both license texts, dependency notices, package/lockfile metadata and the actual build/executable manifest. [Exact pin](../integrations/narsil.json) |
| Interlinked CLI | Package **0.1.0**, revision [`31b5259f29ee823ac23f8d7571b818bf5f609c71`](https://github.com/QuentinCody/interlinked-cli/tree/31b5259f29ee823ac23f8d7571b818bf5f609c71); locked TypeScript **5.9.3** and Biome **2.4.13** | **MIT**, copyright **2026 Quentin Cody**. The installation retains the license, runtime dependencies, package/lockfile metadata and hashed runtime inventory. [Exact pin](../integrations/interlinked.json) |

Confidence's Interlinked build includes one digest-verified local patch: resolve
Biome from the retained CLI package instead of npm's authoring-workspace lookup.
Checker arguments, working directory, timeout, parsing and cleanup remain
unchanged. Original and modified source, the patch and modification notice are
retained in the image. This is a **Confidence local build modification, not an
upstream release**. [Patch record](../integrations/interlinked-biome.patch.json)

The repository's original source remains Apache-2.0. Upstream copyrights and
license conditions are not replaced by team credit. [Project NOTICE](../NOTICE)
and [image provenance](AUTHORING_TOOL_IMAGE.md) explain the distribution boundary.
This source handoff does not bundle third-party binaries or model weights.

## What was observed

The [12 October matched comparison](../experiments/authoring-tools/LIVE_COMPARISON_2026-10-12.md)
used one designed JavaScript task and one live episode per configuration. Both
tools changed together, so it cannot attribute an effect to either tool alone.
Both resulting candidates passed all nine protected checks. Enabled coding and
ingestion took **120.612 seconds and one model call**, versus **258.371 seconds
and two calls** disabled. The enabled full workflow was longer because its
controller required separate zero-model reconciliation; that failure remains in
the report.

| Actual tool observation | Original matched enabled episode | Separate automatic-completion confirmation |
| --- | --- | --- |
| Narsil | 3,529 advisory bytes in the actual 7,175-byte first prompt; exact prompt inclusion verified; indexing/selection coverage incomplete | Same measured advisory/prompt sizes and exact inclusion verified; incomplete coverage remains explicit |
| Interlinked CLI | One source-coherent preview, **2.327 s** outer / **1.057 s** CLI; no blocking findings; process termination observed | One source-coherent preview, **2.121 s** outer / **1.156 s** CLI; no blocking findings; process termination observed |
| Protected acceptance | 9/9 after the original controller conflict and separate evaluation reconciliation | 9/9 with independently verified checker signatures; automatic coding-to-cleanup completion |

The [separate confirmation](TOOLS_RECOVERY_CONFIRMATION_2026-10-12.md) completed
without manual materialization or cleanup: **110.339 seconds** coding/ingestion,
**205.530 seconds** coding through cleanup, excluding deployment, and one model
call. It is not a replacement arm or a new matched comparison. No stale rejection
occurred; deterministic tests, rather than this clean run, exercise fault recovery.

Neither live episode demonstrates Interlinked repairing a defect. Its configured
MJS Biome rule was exercised by a separate owned known-finding fixture; TypeScript
overlay validation is also separate and does not establish end-to-end TypeScript
authoring support. A clean preview cannot establish exhaustive rule coverage.
General coding quality, large-repository performance, sustained throughput and
individual-tool causal gains remain unmeasured.

## Configuration and detailed references

The local controller defaults to Narsil `auto` and Interlinked `feedback`;
unavailable tools remain explicit and existing authoring checks still run.
Legacy Workers with omitted tool bindings default to `off`. New deployments pin
their modes explicitly; the current private deployment uses Narsil `always` and
Interlinked `feedback`. Tool installation alone does not activate a Worker mode.

- [Narsil adapter, bounds and source correspondence](NARSIL_CONTEXT.md)
- [Interlinked preview, lifecycle and checker limitations](INTERLINKED_PREVIEW.md)
- [Pinned production image and offline fixtures](AUTHORING_TOOL_IMAGE.md)
- [Live comparison, exact controls and qualified estimates](../experiments/authoring-tools/LIVE_COMPARISON_2026-10-12.md)
- [Separate native completion and signed-check evidence](TOOLS_RECOVERY_CONFIRMATION_2026-10-12.md)
