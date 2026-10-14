# Authoring tools in the Bookworm runner image

The runner keeps its existing digest-pinned Node 24 Bookworm runtime. Its optional analysis tools are built in separate stages and copied into `/opt/narsil` and `/opt/interlinked`. Installing a tool in the image does not enable its use; host configuration controls authoring integration.

The integrated tools are **Narsil, created by Laurence Avent (`postrv`)**, and
**Interlinked CLI, created by teammate Quentin Cody**. [Team tools and attribution](TEAM_TOOLS.md)
separates their exact authoring roles, licenses and measured observations from
Confidence's protected evaluator and release authority. Both are retained as
source-pinned builds with their own installation manifests; repository Apache-2.0
licensing does not replace their upstream licenses.

The Narsil **1.7.2** image recipe checks the published crate against its archive SHA-256, Cargo lockfile SHA-256 and VCS revision in `integrations/narsil.json`. It compiles that source with the pinned Rust 1.98.0 Bookworm builder and selected native features. This produces a new executable with its own recorded digest. The earlier 1.7.0 Linux release binary could not load on Bookworm; that historical finding motivated this source-build recipe and does not describe 1.7.1's release binaries.

The build uses locked dependencies and default `native` features, which include the ordinary call graph needed by the source selector. Optional RDF `graph`, neural, ONNX and frontend features are not enabled. Two build jobs, disabled LTO, 16 codegen units and no debug information bound first-build resource use. The final runtime executes `narsil-mcp --version`, so a successful builder alone cannot conceal a missing runtime library.

Interlinked CLI package **0.1.0** is built from public revision
`31b5259f29ee823ac23f8d7571b818bf5f609c71`, retaining TypeScript **5.9.3** and Biome
**2.4.13**, using the source-pinned installer described in [Interlinked preview](INTERLINKED_PREVIEW.md).
Its npm lifecycle scripts stay disabled; only the explicit pinned build script
runs. One digest-verified local patch resolves Biome from the retained CLI package
instead of npm's workspace lookup; checker arguments, cwd, timeout, parsing and
cleanup are unchanged. The final image retains the original and modified source,
patch, modification notice, compiler/checker dependencies, MIT license with
copyright **2026 Quentin Cody**, and complete runtime inventory manifest. The
preview adapter forces any npm subprocess offline. No Interlinked hooks, daemon,
login or sync are installed or invoked.

Narsil retains both upstream license texts (`MIT OR Apache-2.0`), including the
unchanged MIT copyright **2024 postrv**, notices from the fetched dependency
sources, package and lockfile metadata, and `confidence-installation.json` with
the source identity, actual compiler versions, selected profile and executable
digest. Its optional standalone `scripts/install-narsil.mjs` uses the caller's
Cargo installation and configuration. That manifest's `rustBuilderImage` names
the image recipe pin; it does not claim that a standalone host invocation used
that image. Use the Docker recipe when matching the Bookworm build environment
matters.

```sh
docker build --platform linux/amd64 -f workers/runner/Dockerfile \
  -t confidence-owned-authoring-tools:smoke .
docker run --rm --platform linux/amd64 --network none --read-only \
  --memory 512m --cpus 2 --pids-limit 128 \
  --tmpfs /tmp:rw,exec,nosuid,nodev,size=384m \
  -e HOME=/tmp/confidence-home -i confidence-owned-authoring-tools:smoke \
  node --input-type=module < scripts/authoring-tools-image-fixture.mjs
```

The fixture checks both versions, retained licenses and Interlinked patch provenance. It rejects an actual TypeScript type error and an MJS `debugger` statement under an explicit owned Biome configuration, then checks corrected proposals without changing source or leaving overlay files. It also verifies repeatable Narsil caller/dependency excerpts against exact source bytes and checks that a new assigned path produces a bounded skipped advisory before binary lookup. It uses no provider, external server or network. Its 30-second analyzer deadline allows emulated amd64 execution; this is integration validation, not a throughput claim or a change to the production selector's default deadline. The runner image smoke executes this fixture in its offline production container before the Pi phases.

The source selector copies the hashed Narsil executable into its isolated temporary directory before execution. Its temporary filesystem must permit execution and have enough capacity for that copy and source snapshot. Image smoke runs provide an explicit bounded tmpfs for this purpose.

Production-image verification for the 1.7.2 pin is part of the required [`validate` workflow](../.github/workflows/validate.yml). Its `npm run test:runner-image` step builds the published source and runs both analyzer fixtures plus the actual SDK correction and fresh-context continuation phases. The check run retains `runner-image-smoke.json`, which binds all 23 image and fixture inputs and records runtime confinement and owned-resource cleanup. Review the matching PR check and artifact for the committed source identity.

The earlier 1.7.1 production-image run (retained private reference; unavailable in this source distribution) passed on Node 24.21.0, Linux amd64, Bookworm, with a read-only root, no network or host mounts, one CPU and 768 MiB memory. It verified both analyzers, retained licenses and patch provenance, then completed the actual SDK correction and fresh-context continuation phases. Container and image cleanup were confirmed. The TS and MJS fixtures use sibling workspaces so their configurations cannot leak into one another. Combined validation and source identities (retained private reference; unavailable in this source distribution)

The initial pre-patch offline fixture passed on Node **v24.21.0**, Linux amd64, Bookworm: rebuilt Narsil **1.7.0** returned the same complete five-file advisory twice with exact caller excerpts, and the real Interlinked CLI found TS2322 without applying the invalid proposal. The first native build took **17 minutes 27 seconds**; subsequent final-layer builds reused it. That image was **793,263,199 bytes**. These historical build and image costs do not validate the subsequent MJS patch or establish a runtime throughput improvement. Machine-readable evidence (retained private reference; unavailable in this source distribution)
