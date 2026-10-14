# Isolated Weft / Confidence rehearsal

This directory is **test-only**. Never deploy its Worker, synthetic issuer, signing
keys, repository capability adapter, or deterministic trial fixture. The ordinary
Confidence application and authority implementations are imported unchanged.

The rehearsal uses the committed Weft revision
`b1c5521bf28a0144203c55b3f056885dce3535ff`. It obtains that revision with `git archive`
from an explicitly configured `WEFT_SOURCE` and reads that checkout's
installed dependencies through a symlink in the temporary archive. It never loads
uncommitted source, changes the shared Weft checkout, contacts its deployment,
restarts its daemons, or moves its Git refs.

Prerequisites are Confidence's pinned dependencies and generated protocol WASM
(`npm ci`, then the repository's `npm run build:kernel`), plus an authorized Weft
checkout containing the pin and its pinned installed dependencies. The optional
`WEFT_TEST_REVISION` override is for reviewing a coordinated future interface
change; the resulting report records the exact override. It must not point at an
uncommitted working tree.

From the Confidence checkout:

```sh
export WEFT_SOURCE=/absolute/path/to/authorized-weft
node node_modules/typescript/bin/tsc --noEmit -p infra/test-weft/tsconfig.json
node node_modules/typescript/bin/tsc --noEmit -p infra/test-weft/tsconfig.runner.json
node --max-old-space-size=384 --import tsx --test --test-concurrency=1 infra/test-weft/*.test.ts
node --max-old-space-size=384 --import tsx infra/weft-runtime-check.ts
```

This is a separate **required Weft integration qualification lane**. The generic
`npm run test:infra` and `npm run test:local` checks do not provision the authorized
Weft source and do not run the nested tests in this directory. Their success does
not qualify this integration. Run the commands above with the pinned Weft source
available before claiming the collaboration journey works. Both the nested test
suite and standalone rehearsal fail if that source or its dependencies are
unavailable; neither silently skips the journey.

The final command writes `demo-output/weft-runtime.json`, or the path selected by
`WEFT_RUNTIME_REPORT`, only after every assertion completes. No model calls,
external project writes, container builds, deployments, or remote Git operations
are part of this rehearsal. All Git refs and worktrees belong to temporary local
repositories. Shutdown removes those fixtures.

The separate repository source-capacity probe requires local Git history containing
Confidence commit `5892c0a76d0baf422133981fa1cb66d6ebfb9852` and the generated
protocol WASM with the 16 MiB validation capacity. It does not require Weft:

```sh
node node_modules/typescript/bin/tsc --noEmit -p infra/test-weft/tsconfig.repository-profile.json
node --max-old-space-size=384 --import tsx infra/test-weft/repository-profile-check.ts
WEFT_SOURCE=/absolute/path/to/authorized-weft node --max-old-space-size=384 --import tsx \
  --test --test-concurrency=1 infra/test-weft/repository-preflight.test.ts \
  infra/test-weft/repository-acquisition-v2.test.ts
```

It fails if the exact commit is unavailable, and writes
`demo-output/confidence-repository-source.json` only after checking every retained
blob, Git closure, executable mode, binary contents, default-profile rejection,
real local Git ingestion, materialized additions/deletions, and preservation of
HEAD, staging, dirty work, and the canonical ref. The report records implementation
and WASM fingerprints. Its R2 and Artifacts capabilities are explicit local test
bindings. This qualifies the internal `confidence-repository-v1` source consumer
capacity only; it does not enroll a project or qualify protected execution,
human approval, publication, or the live Weft capture path.

The v2 acquisition test uses the full pinned Confidence Git tree with a synthetic
wire peer and contract pin. It checks every raw byte/mode against production Git
materialization and kernel validation. The independent Weft golden vector is
synthetic too; neither test grants actual fixture-policy exceptions or qualifies
a new Weft deployment. The preflight qualification fails when the authorized Weft
source is absent; generic CI does not silently substitute a different scanner.

The complete script exercises a fresh authenticated enrollment; two independent
deterministic Node sessions through one Weft daemon and physical worktree; exact
retained source selection; a second replica's reported applied revision and its
actual disk bytes; live edits after selection; actual source generation and
validation; lost-response reconciliation across an authority restart; tampered,
incomplete and missing contents; transient backpressure; durable frozen-transfer
recovery without a second acquisition; role restrictions and revocation; review
staleness; conditional Git publication; and the existing portable verifier.
The worktree starts with a real staged mode change and an unrelated ignored dirty
file, and their bytes/identities must survive the entire journey.
The final archive check uses the production metadata API: reads remain available,
new live edits are rejected, and release submission is disabled. Direct Weft source
and publication routes must reject calls even using the test service credential.

The report contains the baseline Git commit, whether the Confidence checkout was
dirty, a sorted source-file digest inventory, compiled JS/WASM digests, and the
portable receipt with its test trust configuration and checkpoint. The source
inventory must be unchanged between the beginning and end of the rehearsal.
Pause concurrent integration edits for this final run; a changed closure requires
a rerun, even if the behavioral assertions passed.

The source ingestion, materialization, approval rules, publication state machine,
Git receive-pack, signatures and receipt verification execute real code. The
Artifacts capability-discovery/token methods use an owned fixture, and its fixed
HTTPS Artifacts host maps to a bounded local `git http-backend`. This tests actual
Git objects and conditional ref updates without claiming an Artifacts deployment.

The nine behavioral observations come from Confidence's real external HTTP probe
harness against fresh local candidate subprocesses. Each is matched to the
registered probe by identity, seed, actions, assertion and values. Their observed
outcomes are retained, including actual failing outcomes. A synthetic checker key
signs the local observations to exercise authority protocol and review behavior.
This is a **protocol rehearsal with measured local probes**, not qualification of
the production evaluator's declared fresh-container and isolated-network
environment. The synthetic human approval is a test and authorizes no real
protected release. The Weft trial fixture establishes coordinator/session/replica
plumbing, not native Codex/Claude/Pi or Cloudflare Container qualification.

The test Weft Worker runs in external release-authority mode without a `SOURCES`
binding. Confidence validates that mode and the retained source provenance before
accepting a selection. Replica requests use the pinned Weft Client's endpoint
prefix and `applicationOrigin` support to pass through Confidence's authenticated
project boundary. Human test tokens replace the bootstrap service credential in
replica configuration; Weft participant credentials stay inside the authority.
Replica tokens use signed synthetic Access application claims (`type: app` and
`email`, without `principal_class`). The real Confidence Access adapter replaces
the pinned Client's bearer header with `CF-Access-Token`. The fixture explicitly
simulates Access ingress forwarding it as `CF-Access-Jwt-Assertion`; production
authentication then verifies the signature, issuer, audience and claims. A bare
bearer Access token must be rejected. This proves the local adapter/authentication
contract, not a deployed Cloudflare Access policy or interactive login.
