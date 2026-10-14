# Weft integration verification — 14 October 2026

**Implemented and locally verified. Not deployed.** The full journey passed from
clean Confidence commit `26d3977454ef6d38123f99cdf620289e09d2f657`, against Weft
`b1c5521bf28a0144203c55b3f056885dce3535ff`. Later report/documentation commits do
not change those tested runtime inputs. The existing pilot was not updated.

The actual retained report (retained private reference; unavailable in this source distribution) records
`2026-10-14T15:33:39.189Z`, the clean source identity, complete measured observations,
compiled bundle hashes, public test trust, checkpoint and portable receipt.
Its file SHA-256 is
`5c50b787c803c412ca418b8c7ac19c4e65ffc8ce460bc8332cec71afa23c8e8a`.
The source closure digest is
`sha256:e6ed64ba6d60e195e9209cc5985b465a0562f86a9ae53772c9b183d58257d125`.

## Complete journey

| Observation | Actual result |
| --- | --- |
| Collaboration | Two independent deterministic tool processes used one daemon and physical Git worktree. |
| Propagation | The second replica reported revision 2 applied; its actual file bytes were checked. |
| Frozen selection | Revision `2`, root `16057805a588e310cf34d150839597580bad6062c4fdd236d20fac7581fc5f5a`. |
| Candidate | Existing source ingestion produced commit `927a62bfc684807abe69c6d42150c409682542e0`. |
| Frozen/live separation | Live work advanced to revision `3`; the selected candidate stayed unchanged. |
| Evaluation | Selected source: 9 PASS. Later unfinished source: 8 FAIL, 1 PASS. Fresh evaluation after policy change: 9 PASS. |
| Review | Failed candidate could not be reviewed; policy change invalidated the old review. Exact approval used a synthetic test human. |
| Publication | One logical publication and one actual local Git receive-pack, including repeated publication requests. |
| Verification | Both WASM and the separate native Rust verifier accepted the same portable receipt. |
| Local preservation | HEAD, index bytes, staged executable-mode change and unrelated dirty file all preserved. |

Receipt digest:
`sha256:0787997adc844f840526baa89830725a61afb9fff1e36de432b4eaa13c139533`.
The native verifier output (retained private reference; unavailable in this source distribution) records
all six verification facets true and no errors. Its selected trust is explicitly
synthetic; this is not a production identity assertion.

## Negative and recovery evidence

The production-path rehearsal rejected an unadmitted identity, wrong workspace,
wrong binding, browser-supplied submitting identity, insufficient role, and a
revoked participant. Missing, incomplete and tampered selected contents could not
admit a candidate. Duplicate identity returned the original outcome; conflicting
reuse was rejected. An intentionally lost response reconciled by the original
identity after authority restart. Transient backpressure retried without
rerunning tools. A persisted `FROZEN` transfer recovered after restart without
reacquiring source. Failed checks, changed policy and stale release base remained
fenced. Archiving preserved reads and denied new edits/submission. Weft's own
source/publication endpoints rejected even its owner credential in external mode.

The Access adapter uses real signed synthetic application JWTs without a
`principal_class` claim. The fixture explicitly simulates Access ingress header
forwarding; Confidence's unchanged production authenticator verifies the JWT.
The same token sent as a bare bearer credential was rejected. Six adapter tests
also cover exact origin/project confinement, conflicting credentials, redirects,
required Origin/CSRF, and preload configuration.

## Commands and regression results

The final standalone journey and nested suite used existing Node **22.22.0**,
384 MiB Node heaps and test concurrency 1. Rust used **1.98.0**, at most two build
jobs, the approved Cargo snapshot, and **wasm-pack 0.13.1**. Dependency manifests
and lockfiles remain identical to approved commit `0eb3abebdb488e31b9e1ed04d14dcaebae913c5d`.

| Check | Result |
| --- | --- |
| `npm run build:kernel`, `npm run build:web` | PASS; generated real protocol WASM and browser assets |
| `npm run typecheck` | PASS |
| Both `infra/test-weft` typechecks; development-config typecheck | PASS |
| `cargo test --locked --workspace` | 20 passed |
| Worker test files, sequential | 195 passed; includes 44 acquisition/bridge/repository tests |
| Web test files, sequential | 127 passed |
| `infra/test-weft/*.test.ts`, sequential | 6 passed, 0 skipped; includes another complete journey |
| `scripts/weft-access.test.mjs` | 6 passed |
| `infra/weft-development/configure.test.ts` | 3 passed |
| Conformance/integration/script/server test files | 266 passed after correcting toolchain invocation; 5 existing optional native-tool tests skipped |
| Top-level infrastructure test files | 229 passed after using the supported Node runtime for crash recovery |
| TypeScript study tests; bounded reference models | 7 tests and all 3 references passed |
| Provider/provisioning self-tests; Artifacts harness tests | PASS; 16 Artifacts tests, no live provider qualification |
| Authority/project/runner/evaluator/auth/projection runtime checks | PASS using their declared local fixtures |
| Rust CLI local-server checks | 6 passed; no provider or GitHub calls |
| Collaboration runtime and migration checks | 163 and 108 cases passed; both fixture typechecks passed |

The broader source-gate components were run sequentially rather than launching
parallel heavyweight builds. Initial environment failures were retained and
resolved: two native-verifier tests could not find the isolated Cargo executable;
all 13 key-lifecycle tests passed through `rustup run 1.98.0`. A pre-existing
deployment crash test failed under system Node 25's FileHandle GC behavior;
all 8 deployment-recovery tests passed under Node 22.22. No assertion or production
code was weakened to resolve either failure. Provider harness self-tests do not
establish their live provider gates.

## Reproduce

From a separate Confidence checkout at the tested commit, with the documented
toolchain and authorized Weft source containing the exact pin:

```sh
npm ci
npm run build
export WEFT_SOURCE=/absolute/path/to/authorized-weft-checkout
node --max-old-space-size=384 --import tsx infra/weft-runtime-check.ts
node --max-old-space-size=384 --import tsx --test --test-concurrency=1 infra/test-weft/*.test.ts
node --test --test-concurrency=1 scripts/weft-access.test.mjs
node --import tsx --test --test-concurrency=1 infra/weft-development/configure.test.ts
```

The harness archives the pin and reads its installed dependencies; it never
changes that checkout or its daemons. The separate Weft qualification lane
hard-fails when its source/dependencies are missing. Generic CI does not provision
that private source and cannot substitute for this retained qualification.

To replay the retained synthetic receipt using the native verifier:

```sh
mkdir -p demo-output/weft-verify
node --input-type=module <<'JS'
import { readFileSync, writeFileSync } from 'node:fs';
const report = JSON.parse(readFileSync('docs/evidence/weft-runtime-2026-10-14.json', 'utf8'));
for (const [name, value] of Object.entries(report.portableReceipt)) {
  writeFileSync(`demo-output/weft-verify/${name}.json`, JSON.stringify(value));
}
JS
cargo run --locked -p confidence-verifier -- demo-output/weft-verify/bundle.json demo-output/weft-verify/trustConfig.json demo-output/weft-verify/checkpoint.json
```

## Remaining deployment boundary

The rehearsal uses synthetic human/checker trust, measured local subprocesses,
an owned Artifacts capability adapter over real local Git, a deterministic Weft
trial, and simulated Access ingress. It establishes neither production Container
isolation, native-agent qualification, live Access revocation, nor real human
approval. Docker image checks and live provider evidence remain separate gates.

The next step is the [isolated development deployment](WEFT_DEPLOYMENT.md), then
actual identity verification, recipient-bound invitation and reviewer onboarding.
That guide contains the scoped replica commands and every required account,
resource, image, secret, source-binding and publication-evidence input. No
development URL or invitation has been created. The pinned CLI's saved JWT has
no qualified renewal command; preserve its operation journals on expiry.

## Independent Confidence review and repairs

The later integration review did not have access to the private pinned Weft
source. It verified the accessible Confidence implementation and audited the
retained report above; it does not replace that report with a fresh Weft run.

Two frontend defects were reproduced and repaired. A frozen Weft candidate with
no agent attempts now reaches the release story, without invented three-agent
launch placeholders. A current maintenance or sponsor-revocation observation
disables submission immediately, even if an earlier independent Weft poll still
reported permission. Exact-command regressions retain the original body, key
and headers through a lost response, access denial and changed live base.

The source gate exposed a pre-existing 20 ms journal-test scheduling race under
parallel load. Its mocked clock now advances only after conditional dispatch,
preserving the same deadline, exact bytes, single assignment and verified retry
readback. Production object-store behavior was not changed. The normal concurrent
Worker suite passed all 195 tests after this repair.

Fresh builds, configured typechecks, Rust tests, reference models and the remaining
aggregate local-gate components passed. The nine credential-free Access-adapter
and isolated-generator checks now run explicitly in CI, alongside the three
Weft fixture/generator typechecks. Real pinned-Weft qualification remains a
separate lane that requires the authorized source and dependencies.

Narsil 1.7.2 indexed fresh tracked working-source snapshots after the repairs:
361 source files and 3,489 symbols. A persisted worktree reindex stalled; the
review used fresh nonpersistent indexes rather than treating stale results as
current. Analyzer navigation and call edges were checked against source.

## Coordinated successor work

The 14 October coordination request (retained private reference; unavailable in this source distribution)
sets real Confidence-repository dogfooding as the next milestone. PR #18 remains
the bounded JavaScript foundation. After it merges, the planned
`codex/weft-dogfood` branch will start from the exact merged `main` SHA. The
teammate-owned successor repository profile, actual repository checks and explicit
combined author/reviewer permissions are future work, not capabilities delivered
by this integration.

The first successor Confidence issue is bounded advisory overlap reporting:
distinguish declared edit scope from observed changed paths, and attach the exact
project/workspace identity, base SHA and selected head revision/content root,
evidence, freshness and completeness to every result. File, byte, query and
deadline budgets must be explicit, as must missing, unavailable or truncated
analysis; empty advice must never imply compatibility. Advice cannot authorize
writes, replace required checks or approve publication. The existing frozen-source
and access protections described above remain the acceptance boundaries.

This direction draws conceptual inspiration from Kvarm's public
[intent and forecast design](https://github.com/kvarm-git/kvarm/blob/2b908f5dcda50635b8f5b680adf1fe0072a735b1/docs/architecture.md#112-intent-and-forecast-service),
reviewed at `2b908f5dcda50635b8f5b680adf1fe0072a735b1` under its
[MIT license](https://github.com/kvarm-git/kvarm/blob/2b908f5dcda50635b8f5b680adf1fe0072a735b1/LICENSE).
Nonexclusive declarations, revision-bound observed evidence and explicit
incompleteness are design references. No Kvarm code was copied; no overlap or
semantic-compatibility feature is claimed as implemented here.

The planned delivery contract has one authoritative, receipt-bound GitHub
promoter for `codex/weft-dogfood`. It must verify the exact approved source
and receipt, use the expected old GitHub SHA for a conditional update, retain its
operation identity before dispatch, and reconcile an uncertain response against
that same old/new pair. Artifacts may serve as a mirror; an Artifacts update alone
is not evidence of GitHub delivery. This promoter is not implemented or qualified
by the local publication rehearsal.

The private pinned Weft source and dependency closure remain unavailable for this
review. Fresh real-Weft qualification, two-machine peer-disk convergence and
next-base continuity therefore remain unperformed. The current UI protections and
local test results above do not establish those future live acceptance cases.


## Isolated deployment review

The repaired runtime at `f3c14bfed8c475ad5efc01e037aa5f340f9bb660` was
packaged and deployed to the separate `confidence-weft-dev-20261014` namespace.
All five Worker deployments were acknowledged; independent provider readback
passed all 44 checks of active versions, module bytes, bindings, private service
exposure, release flags and immutable image pins. The separate Access application
allows only the owner's existing identity. Five logged-out requests, including
identity and Weft routes, redirected to Access. A fresh owner session at this
application audience returned a verified human identity and the narrow bootstrap
subject; the initial directory reported maintenance and disabled creation.

The four-file owned collaboration repository seed passed native Git readback at
`e7784b575869f707fdb9b9d2b315a0baaacab7d7`. Its bootstrap repository credentials
were revoked. No Weft service was deployed or bound, no model calls were made,
and this evidence does not qualify private Weft or live Container execution.
Private deployment journals and identity observations are retained outside tracked
source; no credential or token is included here.

The native verifier also accepted the retained judge packet and rejected its
signature-tampered variant. Additional CI source steps passed locally: the owned
Pi smoke, all 108 paired workflow observations and both native demo checkpoint
verification variants. These scripted local results are separate from the live
provider readback above.
