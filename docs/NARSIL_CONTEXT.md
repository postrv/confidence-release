# Narsil source context

**Narsil (`narsil-mcp`) was created by Laurence Avent
([postrv](https://github.com/postrv)).** It supplies code intelligence before a
proposal; Confidence's protected evaluator and release authority remain separate.
See [team tools and attribution](TEAM_TOOLS.md) for the staged roles and measured
results of both team tools.

Confidence can prepare bounded Narsil context before a Pi attempt. The controller supplies the complete immutable source manifest and its bytes. A host adapter verifies that inventory, creates a private snapshot, and invokes a fixed set of local stdio MCP queries. The model continues to return text-only JSON proposals; it cannot choose tools, repositories, executables or analyzer options.

The integration targets Narsil **1.7.2**, revision
[`cf8eac40ce736f3706450e4b256b56f6845af8e5`](https://github.com/postrv/narsil-mcp/tree/cf8eac40ce736f3706450e4b256b56f6845af8e5),
under **MIT OR Apache-2.0**. Upstream MIT copyright remains **2024 postrv**.
[`integrations/narsil.json`](../integrations/narsil.json) binds its published crate
archive, Cargo lockfile and source revision; the image installer verifies all
three before compiling and retains both licenses and dependency notices.
Distribution links are [GitHub](https://github.com/postrv/narsil-mcp/releases/tag/v1.7.2),
[npm](https://www.npmjs.com/package/narsil-mcp/v/1.7.2), and
[crates.io](https://crates.io/crates/narsil-mcp/1.7.2). Confidence builds the pinned
crate; it does not silently substitute an upstream release binary.

## Enable locally

With a verified installed binary:

```sh
CONFIDENCE_NARSIL_CONTEXT=auto \
CONFIDENCE_NARSIL_BINARY="$PWD/.local-tools/narsil/narsil-mcp" \
CONFIDENCE_NARSIL_VERSION=1.7.2 npm run dev
```

The local controller defaults to `auto`. `auto` skips projects with four or fewer
manifest files, retaining the existing direct source context. `always` also runs
on those small projects, as in the live experiment; `off` disables the adapter.
An unavailable binary produces explicit unavailable advice and preserves the
existing source fallback. A source build is available through
`node scripts/install-narsil.mjs`; it defaults to the ignored `.local-tools/narsil`
directory and refuses to overwrite an installation. The host must have Cargo and
a compatible native build toolchain. See [the image recipe](AUTHORING_TOOL_IMAGE.md)
for the pinned Bookworm build.

`CONFIDENCE_NARSIL_BINARY` must be absolute; its default is `.local-tools/narsil/narsil-mcp` resolved from the host project directory. `CONFIDENCE_NARSIL_BINARY_DIGEST` optionally enforces an exact `sha256:…` executable pin. The adapter hashes and copies the executable before executing those same bytes. It isolates HOME/config/cache directories and strips inherited analyzer/provider settings. It does not enable persistence, watch mode, Git integration, LSP, neural services or HTTP serving.

## Source and context correspondence

The fixed selector uses `get_index_status`, `find_symbols`, `get_dependencies`
and `get_callers`; it does not expose an open-ended MCP tool menu to the model.
Narsil supplies locations only. The adapter re-slices all excerpt text from the
original verified source map, merges overlapping ranges and excludes assigned
files from additional excerpts. Complete assigned files remain in the prompt.
Assignments that introduce any new path skip analysis with `NEW_ASSIGNED_PATH`,
preserving the original prompt and new-file capability without starting an
analyzer. The local platform narrows its formerly whole-repository source field
only when an advisory is `READY`; unavailable analysis preserves its original
source fallback.

Each advisory records the source commit/manifest, executable digest and version, configuration digest, selector version, queried paths, indexing coverage, excerpt file/content digests and inclusive line ranges. Limits are 4 MiB source, 2,048 files, 16 assigned paths, 12 default selection queries, 16 KiB excerpt text and 32 KiB total output. The default eight-second deadline includes startup, indexing and queries; process cleanup has a separate bounded observation period. Reaching a selection/output limit is explicit incomplete coverage. Dependency hints are advisory and are never used to skip protected checks.

Both the local controller and Cloudflare authority independently verify every excerpt against the retained manifest bytes. The runner retains the advisory as a content-addressed object, includes its exact bytes when the prompt budget permits, and pins its digest in the context capsule. Authority reconstruction must reproduce the same prompt. All advisories carry `acceptanceEligible: false` and `authorityEligible: false`; `READY` describes usable context, not accepted source.

Analyzer unavailability, malformed output and bounded failures remain explicit. Unconfirmed process termination stops that authoring generation. No analyzer text is promoted to host instructions. Failed Pi corrections retain separately classified partial sessions; they cannot be selected as resumable conversation.

Optional advice is omitted from the prompt if its complete rendered prompt, measured as a JSON-escaped UTF-8 string, exceeds 128 KiB. The original prompt is then preserved and the advisory artifact remains retained. This reserves space below the existing 192 KiB broker request ceiling for the SDK envelope and bounded exchanges; the broker still enforces its limit on every actual request. The local capsule records whether the advice was included. Cleanup archives verify the advisory and partial-session objects alongside their other referenced artifacts.

## Cloudflare configuration

The production runner image contains both pinned tools. New deployments pin
`NARSIL_CONTEXT_MODE` and `INTERLINKED_PREVIEW_MODE` explicitly in operator-owned
configuration. The current private deployment uses Narsil `always` and Interlinked
`feedback`. For legacy Worker bindings, omission means `off` for both; that is
different from the local controller's `auto` / `feedback` defaults. `shadow`
records Interlinked previews without correction, while `feedback` permits bounded
pre-write corrections. These flags do not come from source files or model output,
and changing them requires deployment of the matching image and Worker code.

The deployment renderer and authority must move together because the advisory is part of the retained prompt. No live deployment or provider benchmark is implied by local image validation.

## Live observations and limits

The [12 October live comparison](../experiments/authoring-tools/LIVE_COMPARISON_2026-10-12.md)
verified a 3,529-byte Narsil advisory in the actual 7,175-byte first prompt of the
enabled episode. Its 12 selection queries and four indexed code files had
explicit incomplete coverage. Both tools changed together; one episode per arm
does not establish Narsil's individual effect or higher useful-goal throughput.
The enabled coding phase was faster, but its complete workflow was longer after
a controller conflict and manual zero-model reconciliation. The
[separate automatic-completion confirmation](TOOLS_RECOVERY_CONFIRMATION_2026-10-12.md)
retains its own exact tool inputs and successful cleanup, not a replacement arm.

These live episodes use the `biome-covered` fixture: the original four MJS source
files plus an explicit `biome.json`. The historical `original-control` fixture
has no Biome configuration and remains a distinct dataset. Interlinked's
TypeScript overlay does not cover MJS files, and Confidence's current authoring
diagnostic accepts only MJS assignments. Standalone TypeScript overlay validation
does not establish end-to-end TypeScript authoring or acceptance. A larger
TypeScript comparison first needs those explicit profiles, then comparable prompt
bytes, model tokens, correction rounds, accepted outcomes, elapsed time and cost.

Immutable advisory reuse across matching manifests, analyzer/configuration identities, assigned paths and selector versions remains a follow-up. This implementation intentionally does not reuse Narsil's path-keyed mutable index. The five-pair evaluator throughput improvement in the research record (retained private reference; unavailable in this source distribution) remains a separate measured result.

## Integration validation and history

The published 1.7.2 source record (retained private reference; unavailable in this source distribution) verifies the actual crate archive, registry checksum, packaged lockfile, clean tagged revision and retained licenses. The 23 focused checks (retained private reference; unavailable in this source distribution) pass with the new version expectations, covering context verification, bounded failures, process cleanup, combined authoring and deployment-input binding.

Historical results are retained rather than promoted as current version evidence.
An earlier forced four-file macOS probe with 1.7.0 cost roughly 1-1.5 seconds
including executable copying, indexing, selection and cleanup; it does not price
or time the current live episode. The published 1.7.1 source record (retained private reference; unavailable in this source distribution)
verifies the actual crate archive, lockfile, clean tagged revision and licenses.
The earlier 1.7.1 macOS ARM64 smoke (retained private reference; unavailable in this source distribution)
uses the unmodified public release binary: two complete five-file advisories
matched exactly, their excerpts passed independent source verification, and a new
assigned path skipped before binary lookup. Both probes completed within the
default eight-second deadline. This validates the earlier 1.7.1 installation; it
is not a model or throughput comparison.

The initial integration validation record (retained private reference; unavailable in this source distribution) retains the earlier Narsil 1.7.0 aggregate checks, new-path tests, production-image Pi correction/continuation smoke, and declared limitations. It does not validate the subsequent 1.7.1 pin or Interlinked Biome patch.

```sh
node --import tsx --test tests/integration/narsil-context.test.ts \
  tests/conformance/source-advisory.test.ts tests/integration/narsil-platform.test.ts
npm run test:runner-image
```

The installed-binary smoke uses owned fixture source and synthetic commit identity; controller integration tests separately exercise actual Git work bases and retained capsules. Neither substitutes for a real-model comparison or live Cloudflare verification.
