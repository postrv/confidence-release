# Interlinked CLI proposal preview

**Interlinked CLI (`interlinked-cli`) was created by teammate Quentin Cody
([QuentinCody](https://github.com/QuentinCody)).** It previews proposed content
before writes; Confidence owns application, permissions and protected acceptance.
See [team tools and attribution](TEAM_TOOLS.md) for its complementary role with
Laurence Avent's Narsil.

Confidence can invoke Interlinked's native `verify-changeset --stdin --json` command after validating a model's complete file proposal and before applying it. This is authoring advice; it never supplies protected acceptance evidence. The normal public authoring diagnostic and protected evaluator remain responsible for their existing checks.

The source is pinned to [`31b5259f29ee823ac23f8d7571b818bf5f609c71`](https://github.com/QuentinCody/interlinked-cli/tree/31b5259f29ee823ac23f8d7571b818bf5f609c71),
package version **0.1.0**, with TypeScript **5.9.3** and Biome **2.4.13**.
[`integrations/interlinked.json`](../integrations/interlinked.json) records the
exact archive and lockfile digests. `interlinked-cli` had no public npm package
when inspected on 2026-10-06; this integration builds the pinned public source.
Its [MIT license](https://github.com/QuentinCody/interlinked-cli/blob/31b5259f29ee823ac23f8d7571b818bf5f609c71/LICENSE)
retains copyright **2026 Quentin Cody**. The installer retains that license,
runtime dependency licenses, package metadata, lockfile and a hashed runtime
inventory in the installation directory.

## Install and enable

Use the project's Node 24 container runtime for reproducible container builds, or a supported Node version on macOS/Linux for local development. The upstream package declares Node >=22. The source install downloads the exact archive in `integrations/interlinked.json`, checks its SHA-256 and lockfile SHA-256, runs `npm ci --ignore-scripts`, invokes only the pinned atomic build script, and prunes build dependencies while retaining the pinned TypeScript and Biome runtimes. It installs no agent hooks or daemon, and performs no login or sync.

The build applies one local modification recorded in [`integrations/interlinked-biome.patch.json`](../integrations/interlinked-biome.patch.json). The upstream overlay invokes `npx --no-install biome` from the authoring workspace, where npm cannot resolve the CLI installation's retained Biome package. Confidence instead runs Node with `createRequire(import.meta.url).resolve('@biomejs/biome/bin/biome')`. The `check --max-diagnostics=none` arguments, project working directory, timeout, output parser and temporary-file cleanup stay unchanged. No project dependency or hook is injected. The installer verifies the patch digest, exact upstream source digest, unique replacement matches and modified source digest before building; any mismatch stops installation. It retains the original and modified source, patch and modification notice under `confidence-patches/`, covered by the installation's runtime inventory. This is a documented local build modification, not an upstream release.

```sh
node scripts/install-interlinked.mjs
CONFIDENCE_INTERLINKED_PREVIEW=shadow npm run dev
```

The local installation defaults to the ignored `.local-tools/interlinked` directory. The installer refuses to overwrite an existing installation. An explicit alternative destination is available for container builds:

```sh
node scripts/install-interlinked.mjs --destination /opt/interlinked
```

`CONFIDENCE_INTERLINKED_PREVIEW` accepts `off`, `shadow`, or `feedback`. The local
controller defaults to `feedback`; select `shadow` explicitly to record previews
without changing the correction loop, or `off` to disable them. `feedback` can
request a correction for a blocking finding before applying any file from that
proposal, within the same three-proposal budget used by public authoring feedback.
Repeated identical feedback stops that attempt rather than asking indefinitely.
Missing CLI or unavailable analysis remains explicit and falls back to existing
authoring checks. Uncertain process termination or changed source stops the
attempt; it is not treated as a clean fallback.

`CONFIDENCE_INTERLINKED_CLI` may select an absolute CLI entry path. Its default is `.local-tools/interlinked/dist/index.js` resolved from the host project directory. Container configuration must select `/opt/interlinked/dist/index.js`. The model and repository content cannot select this executable or enable the integration.

Workers use the distinct `INTERLINKED_PREVIEW_MODE` binding. Legacy Workers with
that binding omitted default to `off`; new deployment configurations pin their
modes explicitly. The current private deployment uses `feedback`, with Narsil
`always`. Installing the CLI in an image does not by itself activate a mode.

## Retained result and limits

The host sends one version-1 changeset containing every proposed path and its complete contents. The adapter enforces the existing path grant, checks source coherence before and after execution, validates the JSON response and exit-code agreement, and retains bounded output plus source and CLI-entry digests. It rejects symlink targets. It does not apply files. Diagnostic text returned to Pi is bounded to 4 KiB and excludes raw output, elapsed times and digests so duplicate feedback is deterministic.

The default preview deadline is 15 seconds, with process-group termination and at most two further seconds for cleanup. Limits are 16 paths, 1 MiB per proposed file, 4 MiB total serialized input, 128 KiB stdout and 16 KiB stderr. The installation manifest binds the runtime file inventory; a preview's entry digest alone does not attest the full dependency closure.

For local authoring, Pi sends the bounded proposal over its controller-owned IPC channel. The controller supplies the executable, path grant and private per-attempt HOME and temporary directory outside the source tree. It owns the preview process independently of Pi, records preparation before dispatch, and drains the preview group when Pi exits or an attempt is stopped. Cancellation fences further preview requests and proposal application. Capacity is released only after Pi termination and settled preview cleanup; an incomplete or invalid required journal remains `INFRASTRUCTURE_UNKNOWN`. Restart reconciliation can observe a known group's absence, but never signals a persisted PID that another process may have reused. The Cloudflare path runs its preview within the authoring container and retains container destruction as its outer lifecycle boundary.

The adapter forces npm subprocesses offline and disables lifecycle scripts. The patched Biome overlay resolves its retained package directly and does not invoke npm. Missing or unusable checkers remain unavailable; preview never downloads a replacement.

Every result has `acceptanceEligible: false`. Status is `FINDINGS`,
`NO_BLOCKING_FINDINGS`, `UNAVAILABLE`, or `ERROR`; there is no Interlinked `PASS`
status. Coverage is explicitly `NOT_REPORTED` because the upstream CLI does not
emit a complete checker execution manifest. TypeScript overlay applies to
TS/TSX/MTS/CTS, excluding the live fixture's MJS files. Biome requires project
configuration. A clean MJS preview does not establish compiler coverage,
exhaustive rule coverage or a throughput improvement.

For MJS projects with a supported explicit `biome.json`, the pinned Biome checker
can report newly introduced lint findings before writes. The `biome-covered`
live benchmark adds that configuration to the original four source files. The
historical `original-control` fixture has no such configuration and is a distinct
dataset. Confidence's public authoring diagnostic currently accepts only MJS
assignments, so standalone TypeScript fixtures do not establish a TypeScript
authoring or protected acceptance profile. The integration uses only the native
changeset preview, not the upstream hook, guard-daemon, reservation or sync stack.

## Live observations

The [12 October matched comparison](../experiments/authoring-tools/LIVE_COMPARISON_2026-10-12.md)
retains one actual Interlinked invocation in the enabled episode: **2.327 seconds**
outer / **1.057 seconds** CLI, coherent source, exit 0, observed termination and
`NO_BLOCKING_FINDINGS`. The [separate automatic-completion confirmation](TOOLS_RECOVERY_CONFIRMATION_2026-10-12.md)
retains one invocation: **2.121 seconds** outer / **1.156 seconds** CLI, also
coherent, terminated and clean. Both use the Biome-configured JavaScript fixture.

Neither live episode shows Interlinked repairing a defect. A separate owned
known-finding fixture demonstrates its configured MJS `noDebugger` diagnostic
and pre-write correction with synthetic model output; that is integration
validation, not a real-model quality result. Both tools changed together in the
matched live experiment, so their individual effects cannot be attributed.

## Integration validation and history

On 2026-10-06, the source installer completed locally on macOS arm64 with Node **v23.10.0**. This was a successful local build with dependency engine warnings, not a Node 24 container validation. Its manifest records that exact environment. A configured TypeScript fixture exercised the installed pinned upstream CLI: a proposed `number = "incorrect"` returned TS2322; a valid proposed replacement returned no blocking findings; the original on-disk source remained unchanged. The adapter and Pi tests use owned subprocesses/mock inference to check bounds, cleanup, malformed responses, whole-proposal input, feedback before writes, shadow call counts, unavailable fallback and retained source checkpoints. These tests are contract validation, not a model-quality or throughput benchmark.

The initial image validation also passed on **Node v24.21.0, Linux amd64, Bookworm**, with networking disabled and a read-only root filesystem. That pre-patch image check covered TS2322 and a valid TypeScript proposal, retaining the original source. See [image build and offline checks](AUTHORING_TOOL_IMAGE.md) and machine-readable image evidence (retained private reference; unavailable in this source distribution). The current image fixture additionally requires a real configured MJS `lint/suspicious/noDebugger` finding, its corrected proposal, unchanged source and removal of temporary overlay files.

On 2026-10-07, a fresh locally patched installation on macOS arm64 / Node **v23.10.0** passed 17 focused adapter, patch-integrity and Pi tests, including the real CLI's TypeScript and configured MJS cases. The real Biome MJS finding reached Pi's synthetic model before either proposed file changed; a second, corrected proposal completed. The isolated MJS preview retained original source bytes and the complete directory inventory after both checks. This establishes the configured MJS integration with that installation, not a model-quality or throughput improvement.

The subsequent controller-ownership fix passed 26 focused tests with the real CLI enabled (retained private reference; unavailable in this source distribution), including six lifecycle regressions. They cover shutdown and abrupt Pi termination, descendant absence, unchanged source, private environment, deadline fencing, persistence failure and conservative restart reconciliation. The retained reproduction demonstrates the earlier orphaned preview and confirms cleanup of its owned processes. The full local validation (retained private reference; unavailable in this source distribution) also passed: seven Rust tests and 218 Node tests, with zero skips, plus all declared runtime checks and self-tests. Its source identities, installed CLI provenance and retained log are recorded before the final published Narsil pin; production-image evidence covers that pin separately.

Those six lifecycle regressions also passed on the existing Node 24.19.0 runtime (retained private reference; unavailable in this source distribution) on macOS arm64, without installing another runtime.

```sh
node --import tsx --test tests/integration/interlinked-preview.test.ts tests/integration/pi-preview.test.ts
CONFIDENCE_INTERLINKED_TEST_CLI="$PWD/.local-tools/interlinked/dist/index.js" \
  node --import tsx --test --test-name-pattern='real pinned' tests/integration/interlinked-preview.test.ts
```
