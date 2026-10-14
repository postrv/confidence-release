# Validation record

The main record below was executed locally on 5 October 2026 and retains its historical observations. It distinguishes executable local checks from live Cloudflare release evidence; later passes do not rewrite earlier failures. The source and npm/Cargo lockfiles are checked in. Generated checker manifests and runtime reports are retained locally under `demo-output/`; the commands below regenerate them. Use `git rev-parse HEAD` to identify the checked-out source revision. For the current pilot boundary, read the production plan (retained private reference; unavailable in this source distribution) and [live runbook](DEMO_RUNBOOK.md).

## 11 October protected merge and recovery boundary

PR #7 (retained private reference; unavailable in this source distribution) merged normally at
`cbf95f78ce0a1f3e56249db361e21ca929b34022` after all four protected checks in
run 38097132590 (retained private reference; unavailable in this source distribution)
passed. The separate post-merge run 38097957694 (retained private reference; unavailable in this source distribution)
is pending at this recorded checkpoint; the PR result does not substitute for it.
Main has the same tree as reviewed PR head `4c4dffd`.

The separately reviewed [local restoration tool](RESTORATION_RECONCILIATION.md)
passed all 200 combined infrastructure tests and infra typecheck on Node 22.20.0
Darwin arm64. Its rebase onto exact merged main preserved the tested tree. These
are finite synthetic checks, not operational evidence: no real restoration record
was finalized and no deployment fence was cleared. Access policy review remains
blocked by API credential scope and requires an authorized dashboard review or
policy export. Live collaboration deployment, migration and three-person Access
acceptance remain separate reviewed steps.

## 10 October release follow-up

The first protected collaboration PR run (retained private reference; unavailable in this source distribution)
at `d5e06b6` passed both production image checks and the source gate through the
authentication/projection suites, including the final preview cancellation
fixture on Linux. It then failed the collaboration JWT refresh fixture:
`SESSION_REVOKED` was returned where the fixture expected a fresh replacement
token. The test's single timer could wake before the next integer-second
boundary. Production correctly requires issuance strictly above that cutoff.
The source and aggregate checks remain failed; later source-job steps did not run.

The test-only correction rechecks wall-clock issuance within a monotonic deadline,
covers an early timer wake and stalled clock deterministically, and separately
confirms that a token exactly at the cutoff remains revoked. Production
authentication and its skew allowance are unchanged. A focused Node 22.20.0
rehearsal passes 163 collaboration cases / 11 groups and 108 migration cases /
14 groups. The same fixture then passed the full collaboration/migration command
on isolated Linux x64 with Node 24.21.0, fresh dependencies and networking disabled
after installation; its owned container was removed. The
source-associated fixture record (retained private reference; unavailable in this source distribution)
retains the exact inputs and reports. Protected CI on the corrected source remains required.

Fresh provider diagnostics also observed two valid response forms: a successful
custom-domain list with `errors: null`, and omitted compatibility flags for the
projector configured with none. The verifier now accepts only these empty forms;
nonempty/malformed errors, missing required flags and all existing exact-version
gates still reject. Ten focused verifier tests, all 85 infrastructure tests and
the infrastructure typecheck pass on Node 22.20.0. The corrected observer then
passed all 44 restored-pilot readback checks, including five stable active-version
checks, with 60 GETs and unchanged credential cache/journal/pointer. The
readback record (retained private reference; unavailable in this source distribution) binds that
observation to the restored `39c8c58` runtime, not a collaboration deployment.
It does not reconcile the original failed-deployment fence or prove Access policy,
database contents, physical termination or uploaded ordinary static-asset bytes.

The frozen `12adfdf` follow-up (retained private reference; unavailable in this source distribution)
retains both passes and the failed Linux aggregate. A fresh Node 24 / Rust 1.98
Linux checkout installed and audited successfully, rebuilt and typechecked, then
failed one of 235 TypeScript tests (229 passed, five optional skips). The failure
was the cancellation fixture's ten-second startup wait, before the intended
shutdown assertion (failure cleanup still ran);
later aggregate stages were not run. This is not a passing final-source gate.

A separate exact-source diagnostic reproduced the same failure under bounded
CPU pressure. The test-only correction gives cold Pi/preview startup 30 seconds,
requires three live process groups bound to RUNNING lifecycle records, rejects
terminal/stale state and retains bounded failure diagnostics. Production timers
and all cancellation/no-write assertions are unchanged. The readiness correction
passed the six-test Linux file, including a pressure run with 19.8-second startup
and 1.1-second cleanup. The subsequent distinct-PID-set strengthening has six
passing native Node 22.20 tests and a typecheck; the protected run above then
passed that final file on Linux before its later collaboration failure.
Its separate private uniqueness addendum preserves this source boundary.
The original failure and 30 diagnostic artifact hashes remain retained privately.

Both production image smokes passed on clean `12adfdf`: the runner's 24 declared
inputs, installed tools and two owned-response session phases; and all five
checker SDK compatibility checks. Owned containers/tags were removed and shared
images preserved. Exact Linux native/WASM artifacts also accepted all six facets
of the original private publication receipt and rejected the signature-tampered
fixture with `BAD_SIGNATURE` while networking was disabled. The source-gate FAIL
is explicit in this independent compatibility evidence.

Read-only migration review now includes a fresh verified owner session, unchanged
receipt and drained evaluator/outbox observations, plus version-specific active
authority module proof. The verifier is corrected to read bindings, runtime and
complete modules from the exact active UUID, including source-pinned
`_headers`/`_redirects` controls. Both initial and final continuation evidence must
retain those controls separately from runtime modules. The focused verifier and
continuation suites pass 55 tests, the full infrastructure suite passes 84 tests,
and infra typecheck passes. Full final-source protected CI and deployment recovery remain
required. No pilot permission, provider configuration, model budget or deployment
was changed. Details and remaining limits are in the
migration review (retained private reference; unavailable in this source distribution).

## Earlier 10 October integrated collaboration rehearsal

The collaboration branch integrates main `d25d2e0`, retaining the project
catalog/import/source browser, deployment recovery and current nine-job release
profile. `npm run test:local` passed on Node 22.20.0, including rebuilds,
typechecks, 20 Rust tests, 230 TypeScript tests (five optional skips), 153 Worker
tests, 105 web tests, infrastructure checks, local runtime suites and provider
harness self-tests. Following the final migration hardening, the affected
authority and catalog suites were rerun: **78** and **16** checks passed.

Retained integrated results are separate from earlier evidence:

- Authentication transport (retained private reference; unavailable in this source distribution): 274 cases / 18 groups, with owned JWKS and mocked authority transport.
- Production collaboration path (retained private reference; unavailable in this source distribution): 162 cases / 10 groups, actual app/authority, JWT verification, SQLite and R2.
- Legacy migration (retained private reference; unavailable in this source distribution): 108 cases / 14 groups, finalized and already-admitted history preserved; inactive/orphan legacy grants cannot revive on invitation acceptance.
- Authority regression (retained private reference; unavailable in this source distribution): 78 checks with a separately retained synthetic receipt/trust pair and successful offline verification.
- Project catalog (retained private reference; unavailable in this source distribution): 16 checks; this native report does not itself carry source hashes.
- Browser rehearsal (retained private reference; unavailable in this source distribution): 18 checks, four distinct synthetic identities, desktop/mobile geometry and visual inspection. All 61 recorded source/asset hashes match the rebuilt app.

The collaboration and migration reports each bind 19 current source inputs and
their generated runtime bundles; the authority report binds 21 current inputs.
The checks cover scoped private-project isolation, separate owner/reviewer powers,
last-owner concurrency, recipient consent, revoked-session rejection without
durable bookkeeping, grant revocation without resurrection and preserved receipts.
Migration queues stop intents; these local tests do not prove cancellation of a
remote container. Recent JWT issuance is not proof of provider reauthentication.

No live deployment, Access policy change, model execution, new budget or pilot
membership mutation was performed. Docker image checks, a new clean Linux/CI
gate and three real Access sign-ins remain outstanding. The read-only pilot
review still reports 41/44 checks and an unresolved deployment fence; follow the
existing-pilot migration review (retained private reference; unavailable in this source distribution), not these local
passes, to decide whether a rollout is permitted. SHA-256 remains unchanged.

## Earlier 10 October membership hardening and BLAKE3 investigation

The subsequent collaboration implementation retains separate first-stage local
evidence: authentication transport (retained private reference; unavailable in this source distribution)
passed 188 cases, full Application/authority collaboration (retained private reference; unavailable in this source distribution)
passed 140 cases in nine groups, and the authority regression suite (retained private reference; unavailable in this source distribution)
passed 64 groups. Actual workerd, jose verification, SQLite and R2 were used;
the issuer, repository effects and checker observations were owned synthetic
fixtures. The tests include recipient-bound preview/acceptance, last-owner CAS,
session cutoffs, grant revocation without resurrection, separate reviewer
approval, publication before/after revocation and independent receipt verification.
Typechecks, 85 Worker tests, seven Rust tests, 189 TypeScript tests (five optional
skips), and the then-current web suite passed. Browser rehearsal results remain
in `demo-output/collaboration/` until the final source-matched rerun.

Migration review discovered that this initial implementation branch predates
the deployed project-catalog/import work and current `main`. These reports are
historical implementation evidence, **not permission to deploy that older
baseline**. A fresh read-only check on 10 October still observed 41/44 pilot
checks, with authority modules/bindings and namespace separation unresolved.
Source integration, fresh validation and live readback reconciliation are required
before migrating the existing pilot. SHA-256 remains unchanged by user decision.

The local `codex/blake3-collaboration` branch includes the tracked competition-pilot changes through `40ca95c` and the earlier BLAKE3 notes. Focused authority changes add exact membership request validation, a transactional final-active-admin invariant, attributed before/after audit records and invalidation of unconsumed approvals when effective review authority changes or membership is revoked. Consumed approvals remain historical records, and reactivation does not restore revoked grants.

On Node 22.20.0, `npm run typecheck` passed all configured projects; `npm run test:workers` passed 77 tests; `npm test` passed seven Rust tests and 189 TypeScript tests with five optional integration skips. `npm run test:authority` passed 64 local workerd groups, including concurrent admin changes, approval invalidation, historical command replay, grant revocation and runtime restart. Its retained report (retained private reference; unavailable in this source distribution) binds tested source hashes and records a valid receipt across all verifier facets. `npm run test:auth` passed 12 groups / 127 cases with owned simulated JWKS and authority services. The initial new runtime assertions used HTTP 200 for successful authority API commands; they were corrected to the API's existing HTTP 202 contract before the passing run.

The [BLAKE3 assessment](blake3-feasibility.md) includes a reproducible host microbenchmark and describes a versioned adoption path. Production hash implementations, signatures and stored commitments remain unchanged. The [permissions design](COLLABORATION_PERMISSIONS.md) distinguishes the implemented hardening from proposed ownership, invitations, teams and UI work.

These are local source checks, not a deployment or completed multi-user security review. No live model execution, publication, new Cloudflare resource, Docker check or full local aggregate was run for this iteration. Earlier live evidence still applies only to its recorded inputs.

## 8 October `10bde78` scoped-cap deployment checkpoint

The source-matched `10bde78` maintenance and active stages each acknowledged five Worker deployments and independently passed 44/44 module, binding, exposure and pinned-image readback. Its policy permits at most 400,000 additional internal admission units for the existing `competition-demo-r2` incarnation; the default cap for other projects remains 2,800,000. The active deployment kept publication **CLOSED**. Deployment did not amend the project's authority budget or issue an agent grant. A fresh protected revision-37 read after active deployment still showed maximum and settled budget both 2,800,000, reserved zero, maintenance off, gate CLOSED and no pending outbox. The owner workspace displayed the 3,200,000 scoped policy cap and the exact 400,000-unit amendment control. An audited human budget amendment and a fresh action-time grant confirmation remain necessary before another attempt. This readback proves deployed bytes and bindings within its stated limits; it does not establish a repaired source, provider billing, approval, publication or receipt. See the deployed release record (retained private reference; unavailable in this source distribution) for exact private stage evidence.

## Earlier 8 October `e3c7108` deployment and closed-pilot checkpoint

The fourth owner-approved, ten-minute, `mutation.mjs`-only GLM-5.3 repair started against the failed three-way candidate and stopped without accepted source, successor evaluation or receipt. Its first provider response was retained and digest verified; Pi's corrective turn was denied by the then-deployed broker before another provider call because assistant history contained `reasoning_content`. The bounded normalization fix was committed at `15774db` and included in source-matched `e3c7108` maintenance and active deployments. Both stages acknowledged all five Workers and independently passed 44/44 module, binding, exposure and pinned-image readback. Focused local checks covered 85 Worker tests, eight runner runtime checks, 27 web tests, Worker and web typechecks and both five-Worker packaging dry runs. No GitHub CI was run for this release; the fix has no new live model outcome. The deployed release record (retained private reference; unavailable in this source distribution) retains exact private deployment/readback identities and limits.

Protected post-deployment `/operations` at authority revision 37 showed maintenance off, publication gate **CLOSED**, maximum and settled internal budgets both 2,800,000 micro-units, zero reserved and no active or queued evaluator work, pending outbox, cleanup hold, unresolved publication or receipt. A separate read-only D1 comparison found the project event stream contiguous through sequence 52/52 with no inbox gap at that observation; point-in-time Queue metrics showed zero event and dead-letter backlog. A fresh protected model-call roster and read-only R2 inventory matched all seven reservations to digest-verified responses and inspected all 176 listed objects with no skipped or reported issue. The fourth repair's one response reported 2,272 input and 765 output tokens, giving a dated token-rate estimate of US$0.006546800; the seven-call project estimate is US$0.085602040. Neither is account billing or an invoice. The project has no internal headroom for another grant. Current-source Artifacts publication gates, accepted repair, eight protected release jobs, exact human approval, publication and independent receipt verification remain open.

## Earlier 8 October `18cb719` deployment checkpoint

The owner-only pilot's maintenance and active `18cb719` stages each acknowledged five Worker deployments and the D1 migration, then passed independent 44/44 module, binding, exposure and pinned-image readback. The private reports and exact release digests are listed in the deployed release record (retained private reference; unavailable in this source distribution). At the first authenticated post-active inspection, the app showed active mode while the existing authority Durable Object's `/operations` response still reported `maintenance:true`. A later protected read at 09:49:51 UTC showed maintenance off, gate CLOSED, revision 34 and no active work. After an owner-approved one-time 400,000-unit budget increase, a 09:51:49 UTC read showed revision 35, maximum 2,800,000, settled 2,400,000, reserved 0 and no active work; the workspace showed 400,000 available. The provider readbacks do not inspect uploaded static-asset bytes or secret values, and these runtime reads do not establish a bound GLM response, accepted repair, review, publication or receipt. The older observations below retain their own execution times and source identities.

## Earlier 8 October closed pilot continuation

The owner-only release at clean source `887662e` passed the five-Worker remote module, binding, exposure and pinned-image readback (44/44). A fresh selected-account REST/Git preflight from the same clean source passed 22/22 checks, including absence of both disposable repositories. A separate deployed Worker using the unchanged production Artifacts adapter and actual Artifacts/R2 bindings passed 14/14 checks after owned repository cleanup: exact source and mode ingestion, materialization, conditional publication, duplicate/racing updates, a fixed-base loser retry, current-head fork, unpublished work-ref transfer, token revocation and owned repository absence. Its exact R2 bytes were archived, then the temporary Worker, run fence and bucket were retired with native absence observed. The private full provider, binding and native operator reports have SHA-256 digests `588e075c65967d39e60c87485d237218b17f72811853a23fe51fa00e53b6f2f0`, `e1d8815705692e833f8e1ac120113088ed2192f6683cd454cd3bd8ccc036821b` and `2354e53fbe4b8fd914359d32eb9a2a2121101c22adedcc0df213bc58eca174bc`. The binding source-set digest was `sha256:d9279a32828f53755063f33dbb3bdb26abefca803157c76dc3411fd348658419`.

The original three model-driven submissions remain accepted but their combined candidate fails freshness: after saving 7,976, the next page shows 4,768. Three bounded GLM-5.3 repairs stopped without accepted source. The newly deployed DeepSeek V4 Flash route has not produced a bound response. The project has no remaining internal reservation capacity; no further grant, review approval, publication or receipt is claimed. The Artifacts checks establish their finite adapter/provider behavior, not the missing end-to-end release gates. No GitHub CI or model call was used for the fresh Artifacts observations.

## 7 October pilot continuation

The private five-Worker deployment passed a 44/44 remote readback of uploaded modules, bindings, exposure and pinned images for its recorded release. The owner-only Access pilot accepted three real Workers AI submissions and observed a stale-read failure in their combination. At this 7 October checkpoint, two repair attempts had stopped without source; the eight-job candidate remained failed and publication was closed. This was not a receipt or completed release. The read-only usage reconciliation scanned all 160 listed R2 objects and verified five start/response pairs; its response-only rate estimate is not total project cost.

The source-batching benchmark retained at source-batching-benchmark-2026-10-07.json (retained private reference; unavailable in this source distribution) observed 6,006 to 8 Git processes and 74,456.8 to 332.9 milliseconds for create-plus-prepare at 1,000 files, with exact source and checks preserved. The branch's aggregate `npm test` rerun passed 160 tests with five intentional skips after one load-sensitive deadline fixture failed on the first aggregate run; its focused file passed 6/6. The draft PR's source and image CI both passed on `007c6c6`. The six-file TypeScript profile passed its six focused local tests with pinned tools. Its new advisory ablation recorded 8/8 local arm samples with no model dispatch, and the experiment guard tests passed 7/7. The TypeScript profile still has no production release path.

Host: macOS arm64, Node 23.10.0, Rust 1.98.0, wasm-pack 0.13.1. Pinned dependencies include Wrangler 4.147.0, Miniflare 5.20261001.0-alpha, workerd 1.20261001.1, Sandbox 1.0.0 and Pi 1.0.2. Workers use compatibility date 2026-10-01. The Docker checker uses pinned Node 24 and Sandbox shim image digests.

| Check | Result and observed scope |
| --- | --- |
| `npm run build` / `npm run build:web` | Rust-to-WASM and production React assets build. Final verifier byte identity is retained in the packaging/runtime reports. |
| `npm run typecheck` | Node, Workers, browser and infrastructure TypeScript configurations pass. |
| `cargo fmt --check`; `cargo clippy --workspace --all-targets -- -D warnings` | Pass. |
| `npm test` | Seven Rust tests and 50 TypeScript conformance/integration tests pass with no skips. Admission, grants, budgets, composition, rooted key lifecycle and compromise rehabilitation, additive issuance bounds, signed genesis checkpoints, strictly paired current/historical attestation namespaces, SDK capture/continuation, protected audit disclosure, source identity, native conditional Git updates, restart, uncertainty, runtime presentation and local API boundaries are exercised. |
| `npm run test:workers` | Eighteen tests pass: three Artifacts/materializer, eight cleanup, five diagnostic and two model-policy checks. Exact fixed-head packets, bounded archival/deletion reconciliation, source-coherent public feedback and text-only model transport are checked. |
| `npm run test:authority` | Forty actual local workerd Durable Object SQLite/R2 groups pass. Persistence, grants, explicit fresh evaluation, withheld audits, scoped proposals/cancellation, bounded cleanup, separated signers, historical endorsements, large SDK capture and original-base continuation are exercised. Retained report: `demo-output/authority-runtime.json`. Repository effects and checker inputs in this harness are explicitly synthetic. |
| `npm run test:runner` | Seven actual local workerd production-runner groups pass: terminal/unknown startup denial, generation-scoped credential interception, persisted stop fencing/retry, trusted ingestion after observed stop, and three start-continuation races across deadline/alarm/inactivity awaits. Native Container effects are explicitly simulated. Report: `demo-output/runner-runtime.json`. |
| `npm run test:evaluator` | Eight actual local workerd scheduler groups pass. Five immutable jobs reach DONE; failed initial registration, restart, held UNKNOWN capacity, stop/callback release, release-plan priority, pool progress and current v2 evidence are observed. Evaluation execution is a fake DO; production Sandbox registration and live execution remain separate gates. Report: `demo-output/evaluator-runtime.json`. |
| `npm run test:evaluator-stop` | Sixteen actual local workerd groups pass, with four start races, five lifecycle/acknowledgment/freeze cases, nine source-hydration cases and three fixture-fencing groups. A held PUT cannot reopen a closed fixture; concurrent GET accounting and close-before-initialize fencing persist across restart. Delayed start, callback and R2 continuations cannot replace STOPPED or its frozen callback. Whole-container and Files effects are explicitly owned doubles; production methods and actual SQLite/R2 run unchanged. Report: `demo-output/evaluator-stop-runtime.json`. |
| `npm run test:auth` | Twelve actual local workerd authentication groups and 127 cases pass against owned ES256/RS256/JWKS fixtures, including duplicate JSON/segment bounds, claim classes, CSRF/origin checks, session expiry despite a cached key, signed-subject change during a frozen action, and complete application request tracing. Live identity setup is separate. Report: `demo-output/auth-runtime.json`. |
| `npm run test:projection` | Fifteen actual local workerd/D1 checks pass against production projection history, human-admin replay, outbox dispatch and the projector. Matching/conflicting duplicates, rollback, independent streams, restart, strict page validation, late-response fencing, recovery beyond 256 retained events and an empty-view rebuild are observed. Pages honor 32-event, 128 KiB aggregate and 64 KiB event bounds. Owned seeding and Queue delivery/ack/retry callbacks are simulated. Report: `demo-output/projection-runtime.json`. |
| `npm run test:projection-bridge` | A separate local workerd proof joins the production authority replay outbox to a Miniflare Queue broker, the unchanged projector and actual local D1. It checks an out-of-order gap against retained authority history, exact prefix rebuilding after an owned view erase, a duplicated original after a lost send response, and a denied non-human replay. It does not establish native Cloudflare delivery, dead-letter routing or a live pilot replay. Report: `demo-output/projection-queue-bridge.json`. |
| `node --import tsx --test infra/projection-configuration.test.ts` | One actual CLI subprocess group passes: five private service/signing files validate; missing, aliased or mismatched projector credentials block deployment before packaging or remote stages. |
| `npm run test:references` | All three original bounded Python reference experiments reproduce their checked-in reports. |
| `npm run test:pi` | Pinned Pi SDK completes bounded proposal/correction in the same real SDK session through an owned inert HTTP endpoint. Failure and diagnostic bounds are checked separately in the integration suite. No real provider/model-quality claim. |
| `npm run test:runner-image` | The renamed production authoring Dockerfile runs its copied Pi child and diagnostic under Node 24.21.0 and production-only dependencies. One SDK session corrects syntax FAIL → PASS; a fresh session consumes selected retained context, passes the public probe and preserves all four source digests/modes. Both SDK captures validate. Runtime networking is disabled; the mock endpoint runs inside the container. Exact owned container/tag/image absence is confirmed. The Confidence derived observation (retained private reference; unavailable in this source distribution) retains the thirteen current input hashes and local/mock limits; the earlier record (retained private reference; unavailable in this source distribution) remains unchanged. |
| `npm run test:container` | Actual Sandbox Files SDK and pinned helper write/read binary source, inspect metadata, enumerate and clean an owned Docker container. No live Cloudflare lifecycle/egress claim. |
| `npm run test:provider` | Nine owned object/packet/parser/authentication and lost-create-response self-tests pass, explicitly `SELF_TEST_PASS`. No remote resource created. |
| `npm run test:provision` | Eight owned HTTP provisioning test groups pass, including no-network default, account checks, streamed bounds, lost acknowledgment/restart and credential redaction. No live provisioning. |
| `npm run test:seed` | Three owned HTTP/native Git bootstrap groups pass: exact four-file/six-object fixture, immutable conditional initial push and raw closure readback; uncertain create/push is retained across restart and never blindly repeated. No live Artifacts seed. |
| `npm run test:signing` | Two groups pass, covering all physical signer-alias pairs, malformed secret inputs, checker correspondence, actual configuration generation with successor signer IDs, and migration identity drift blocking deployment before any package or remote stage. Private material stays in memory or removed private temporary files. |
| `npm run test:live-container` | 43 local harness self-tests pass, including parent-only completion, pending-I/O deadlines, actual Node parent termination with a blocked FIFO read, bounded result/heartbeat reads, abort disarming while durable progress retention yields, and first-start continuation that rejects uncertain effects. A fourth deployed inert run (retained private reference; unavailable in this source distribution) passes all six native checks, including child heartbeat after parent exit and automatic deadline destruction. Exact named-resource cleanup is confirmed. The two earlier runs (retained private reference; unavailable in this source distribution) and third run (retained private reference; unavailable in this source distribution) remain failed historical observations. |
| [Owned evaluator harness](../infra/live-evaluator/README.md) | 22 local self-tests, both TypeScript projects and both Wrangler packages pass. A native evaluator observation (retained private reference; unavailable in this source distribution) runs 18 jobs from clean commit `f4a85bc`: eight good PASS, eight bad jobs with seven FAIL and one cache-benefit PASS, callback-fault PASS and reconstruction-fault INCONCLUSIVE. Independent retained-byte verification passes the observed subset; the contemporaneous rejected-callback/undelivered/ACTIVE-slot sample is UNOBSERVED and the frozen full verifier retains that failure. The restart request remains UNKNOWN despite independently verified distinct reconstruction and signed continuation loss. All 18 generations are STOPPED/native-null, fixtures closed, callbacks delivered and scheduler slots DONE. Forty-two committed inputs and two exact generated outputs are verified at execution; the independent verifier did not perform a clean rebuild. Cleanup archived 66 objects/241,501 bytes before exact named-resource deletion. |
| [Owned Queue/D1 harness](../infra/live-projection/README.md) | Six local harness tests, both TypeScript projects and the Wrangler package pass. A native observation (retained private reference; unavailable in this source distribution) from clean commit `8be37ce` passes six configuration and four finite native checks; all 20 execution input hashes match that commit. Eight native delivery records include one unchanged message identity at retry attempts 1 → 2. The unchanged production projector catches up from five synthetic retained originals, converges duplicate deliveries, erases its owned view under a closed admission gate with zero active invocations/backlog, and rebuilds five exact rows with watermark 5. All six controls dispatch once. The exact D1 database, events Queue, dead-letter Queue and Worker were subsequently confirmed absent. The three earlier failed/uncertain runs remain unchanged; the second retains its unacknowledged `MAY_HAVE_DISPATCHED` create history. |
| Staged five-Worker packaging | Authority, runner, evaluator, projector and app package successfully with actual Wrangler and Docker builds. `demo-output/confidence-cloudflare-packaging.json` records current local packaging under synthetic non-secret account/OIDC inputs. |
| `npm run demo` plus native receipt verification | Three real overlapping author processes; baseline/A/B/A+B freshness witness PASS/PASS/PASS/FAIL; value-preserving repair passes eight required jobs; UNKNOWN → FINALIZED on one fixed publication; all offline verification facets pass. |
| `npm run compare:workflows` | 96 fresh paired protected HTTP jobs match across six identical frozen sources. Both ordinary branches/CI and Confidence detect the integration failure and accept the same repair. This measures neither workflow speed nor model quality. |
| Clean source archive rehearsal | Commit `6f01827` builds from the public archive's normalized bytes/modes in an owned Linux arm64 container: fresh npm install, Rust/WASM/web/native builds, concurrent scripted demo, repair, UNKNOWN → FINALIZED and all native verification facets pass. Runtime has no external network or host private mounts. This is an isolated environment on the same Docker host; later fixes have separate tests. The derived record (retained private reference; unavailable in this source distribution) binds archive, toolchain, image, commands and cleanup. |
| Browser walkthrough | Launch, selection persistence, composition, repair, exact review/approval, lost response, reconciliation, receipt loading, separately selected trust/checkpoint and all five verifier facets observed. Updated UI exposes repair diagnostics and uses observed execution labels. With every project API request returning an owned 503, uploaded receipt/trust/signed checkpoint still verify all five facets; a tampered copy fails. The pre-rename v2 example proof is retained; duplicate JSON and narrow mobile layout were checked separately. Final fixture proof: `demo-output/screenshots/final-v2-verification.png`. |
| `npm audit --audit-level=low` | Zero known reported vulnerabilities in the locked npm dependency set at validation time. |

The self-contained [example receipt](../fixtures/demo/README.md) is retained for independent replay. The [comparison method](COMPARISON.md) defines the equal-source/equal-checker bounds. Runtime reports record actual tested input hashes and versions; source/config/asset drift prevents staged deployment.

The earlier Confidence Rust verifier WASM was 753,970 bytes, SHA-256 `513a244a19fae805c5b9a39c18c9e3626aa53dcd6c4f13cdbeb8d77e294aaf82`; that generated browser asset contained those exact bytes. The retained browser and native CLI walkthrough observed verification of logical example receipt `sha256:c2f5efbf01ebd72d8393bde487f122150f0b7b8ec783afe0f2120b0bab4b4a8d` with its separately selected root-signed checkpoint. Generated WASM and browser assets are intentionally rebuilt from the checked-in source rather than committed as binaries.

## Follow-up review validation on 5 October

The follow-up review began from clean `3add166`. Its source changes passed the complete new `npm run test:local` aggregate, with exit status 0. This rebuilds WASM and web assets before running all TypeScript projects, seven Rust tests, 61 TypeScript conformance/integration tests, 18 Worker tests and eight infrastructure tests. No tests in those suites were skipped.

The same aggregate passed 42 authority, seven runner, eight evaluator scheduler, sixteen evaluator-stop, six authentication and fifteen projection runtime groups. It also passed the provider and provisioning self-tests, the three reference-model reproductions, and the Container, evaluator and Queue/D1 harnesses in explicit local self-test mode. Separately, `cargo fmt --check`, `cargo clippy --workspace --all-targets -- -D warnings` and `git diff --check` passed.

The new regressions cover outbox progress during evaluator failure, restart and bounded runtime-history ordering; overlapping UI snapshots and verifier inputs/results; concurrent repair admission; publication revision chronology, null-checkpoint native/WASM parity and sparse-array rejection; complete built-asset identity; and bootstrap validation before dispatch. ADVERSARIAL_REVIEW.md (retained private reference; unavailable in this source distribution) records the findings and finite scopes.

The aggregate log is retained locally at `demo-output/adversarial-review-local-2026-10-05.log`. Its companion JSON records the baseline revision, changed source hashes, generated runtime input hashes and log digest. The rebuilt verifier is 754,035 bytes, SHA-256 `7d38d07b30552eca19f079b06531ec1e21c8e0a800061833b43904254b55d904`; the newly built browser WASM asset matches those bytes.

This follow-up did not rerun the browser walkthrough, Docker smoke checks, standalone Pi smoke check or live-provider gates. UI ordering is covered by the actual session/state helpers used by React and production compilation. Local workerd bindings and the harnesses' declared owned doubles retain the limitations in their reports. Earlier deployed evidence remains bound to its original revisions and is not reclassified by these source changes.

## Pending live release evidence

The earlier Artifacts authentication code 10000 is retained as a historical observation. After the user-approved OAuth permission refresh on 5 October, selected-account scope and namespace reads pass. The first native REST/Git observation (retained private reference; unavailable in this source distribution) passes all 22 finite checks and independently observes both owned repositories absent. It freezes its actual dirty source hashes; matching current-source provider/binding evidence and configured identity/runtime gates remain necessary before application publication is enabled.

The second deployed inert Container run observed hydration/modes, the declared egress intercepts, controller reconstruction without a repeated start and explicit whole-generation stop. Its detached-child probe returned an unclassified HTTP 503: the child heartbeat and deadline termination were unobserved, so the provider gate remains FAIL. Both exact applications, Workers, namespaces, image tags and immutable image manifests were confirmed absent; no broad registry cleanup or physical-storage reclamation claim follows.

The third inert run (retained private reference; unavailable in this source distribution) initially acknowledged deployment while its URL was unavailable, with no start dispatched. An explicit continuation later rechecked the unchanged uploaded Worker bytes, original expiry, binding association and native absence before its first start. Readiness, binary/mode and intercept observations passed; the detached-child parent exited with code 1. Its cause, heartbeat and deadline termination remain unobserved, so the gate remains FAIL. Manual whole-generation stop and exact application, namespace, Worker, image tag and immutable-manifest absence were confirmed. The original deployment and execution reports remain unchanged.

The fourth inert run (retained private reference; unavailable in this source distribution) executed from clean commit `dd89588`, with all sixteen source hashes matching the committed source and its exported archive. All four configuration and six native checks passed. The parent exited with code 0, a changed child heartbeat was observed afterward, and the automatic deadline stop retained `STOPPED`, native `inspect:null` and released capacity. This establishes the declared inert-image gate on one account. Its exact application, namespace, Worker, image tag and immutable manifest were subsequently confirmed absent. No manual stop or account-wide registry garbage collection was used. Later documentation changes preserve the execution and cleanup reports by digest and do not change that execution's runtime source.

The native Queue/D1 observation (retained private reference; unavailable in this source distribution) passes the declared five-original synthetic-history gate with the unchanged production projector on actual Cloudflare Queue delivery and D1. It retains eight delivery records, including retry attempts 1 → 2 for the same native message and event digest, six single-dispatch controls, a closed/zero-active/zero-backlog empty-view boundary, and restoration of the five original rows/digests with watermark 5. Execution used clean commit `8be37ce` and twenty verified committed input hashes. The exact D1 database, events Queue, dead-letter Queue and Worker were subsequently confirmed absent. The three earlier failed/uncertain runs and their cleanup reports remain immutable; repeated exact-name absence after the second run does not erase its unacknowledged `MAY_HAVE_DISPATCHED` Queue-create history. No possible create was blindly repeated.

## Artifacts integration on 5 October

The completed native Artifacts observation (retained private reference; unavailable in this source distribution) passes all 22 REST/Git checks and all 14 deployed binding checks. The latter uses the production ArtifactsRepository, Rust/WASM kernel and ObjectStore through actual Artifacts/R2 bindings. Exact source ingestion, raw binary Blob/modes, materialization, fixed-old/new publication, duplicate observation, one competing-update winner, unchanged loser replay, current-head fork, unpublished work-ref transfer, unchanged canonical history and complete token revocation pass. Both disposable repositories are observed absent before the binding gate passes. At that observation, the actual configuration admission functions accepted both matching-source reports; no application publication flag or deployment was changed. Later changes to their declared source inputs require fresh native observations before publication can be enabled.

The 8 October staged batching check (retained private reference; unavailable in this source distribution) used a clean `d0e1902` checkout and a disposable Worker with actual Artifacts/R2 bindings. All 14 binding checks passed, then the Worker and bucket were observed absent after retirement. It validates the changed source-preparation adapter against live bindings. The 4/100/1,000-file numbers (retained private reference; unavailable in this source distribution) remain a single offline benchmark; no live throughput improvement or full application release is claimed.

Native authenticated APIs compare every uploaded JavaScript/WASM byte and all configured bindings, variables, secret types and runtime compatibility settings to the owned package. The binding source set is `sha256:65de0bdfe356ed6d3148c266bd98b744c667f4fc32885344b4ef0f3e1c5e1d56`. Nineteen exact source files are archived locally beside run `83ef657f-11d9-448f-a79f-84d7834686cf`; public evidence retains their digests and archive identity. The uploaded verifier is still 754,035 bytes with SHA-256 `7d38d07b30552eca19f079b06531ec1e21c8e0a800061833b43904254b55d904`. These runs explicitly used dirty sources; they are not clean-commit build attestations or portable publication receipts.

The first failed binding run (retained private reference; unavailable in this source distribution) retains its original uncertain seed result. An actual local workerd reproduction identified an unsupported `redirect:error` harness option; the corrected seed uses `manual` with explicit redirect rejection and a Worker-runtime regression. No native error type or aborted dispatch is inferred retrospectively. The second failed run (retained private reference; unavailable in this source distribution) passed source ingestion/materialization/publication but exposed a production head lookup defect: native history `main` returned the expected commit while `refs/heads/main` returned an empty list. Head lookup now matches exact full refs through bounded Git discovery, with short read tokens and cleanup on failure or stalled bodies. All earlier reports remain unchanged.

Each binding run verifies and durably retains all owned R2 bytes before retirement. The atomic run fence remains until native Worker absence is observed; its exact bytes are then removed before empty-bucket deletion. The completed evidence includes fourteen additional independent resource-specific absence reads across all three binding runs and the final REST/Git probe. No physical storage reclamation is claimed. Fresh empty preflight namespaces remain because no namespace-delete API is documented. The retained `confidence/owned-confidence-collaboration` fixture remains at `8038967b1c954937af0a2a54d850eb7346627b26`, with a complete token inventory and zero active tokens. Authority enrollment was not dispatched.

The final `npm run test:local` aggregate exits 0: seven Rust, 61 conformance/integration, 31 Worker, fourteen infrastructure and fifteen Artifacts harness tests pass without skips, alongside all TypeScript projects, the reference models and the declared local workerd/runtime groups. The full log and current input map are retained locally; the local validation record (retained private reference; unavailable in this source distribution) preserves counts and SHA-256 `5c04e492a907a4c5d8d789965a8c4e3b466bc1b668a9e2ccbb795df0ab40a33c` for that log. The release regression confirms that changing an evidence harness source after configuration blocks deployment before packaging. `git diff --check` passes. OIDC/destination configuration, production runner/evaluator image evidence and the deferred model remain separate application release conditions.

The early evaluator run (retained private reference; unavailable in this source distribution) stopped before seeding or dispatch: its module-name comparison rejected a leading `./` WASM alias although retained bytes matched. Its BLOCKED status and original evaluator-retirement UNKNOWN remain immutable. A separately journaled controller detachment and evaluator retirement established named cleanup; subsequent absence did not acknowledge the original uncertain operation.

The native evaluator record (retained private reference; unavailable in this source distribution) separates the original driver PROVIDER_PASS claim from READ_ONLY_OBSERVED_SUBSET_PASS. Unchanged production evaluator execution, hydration, recipes, fixture routes and stop methods ran through thin inspection subclasses on two real scheduler slots. Independent verification checks all 18 checker signatures and retained actual observation bytes, eight good PASS, seven bad FAIL plus one cache-benefit PASS, callback PASS and reconstruction INCONCLUSIVE. Actual injected 503 and two same-digest deliveries are established separately; the contemporaneous rejected-callback/undelivered/ACTIVE-slot observation is UNOBSERVED. The frozen full verifier remains failed for that missing sample. The controller restart request stays UNKNOWN; a distinct construction identity and signed continuation-loss marker establish reconstruction without acknowledging that request. Nine native image samples and maximum sampled ACTIVE occupancy two do not establish continuous occupancy or performance.

The evaluator execution provenance is clean `f4a85bc`, with 42 committed inputs and two exact generated JS/WASM outputs; this verifier did not perform a clean rebuild. New documentation does not rewrite that execution source. Before deletion, fresh inspection observed closed admissions, 18 native generations absent and 18 slots released. An independent local audit reconstructed the 66-object, 241,501-byte R2 archive and signatures. Controller-first retirement removed cross-Worker references before evaluator retirement. All four namespaces, two Workers, application, exact image tag/manifest, individual known objects and the empty-only bucket were confirmed absent by the reviewed helper. Its 459 direct HTTP calls/72 direct mutations are retained counters; two native deployments and two dry-run captures are separate. Individual object-absence response bodies were not retained. One registry credential was issued with a requested five-minute expiration; revocation and expiration were not observed. Exact local tag cleanup retained the shared image and other tags, without force, prune or physical reclamation.

At the 5 October checkpoint, live production authoring lifecycle/source transport and full continuation, general protected binding/egress isolation, and configured Access/OIDC identity and revocation still required evidence. Artifacts raw-source/CAS and binding observations passed for their recorded inputs; complete ProjectAuthority/application integration remained outstanding. The owned evaluator controller was not ProjectAuthority or application identity. The finite Queue/D1 pass used a synthetic history receiver and did not establish live ProjectAuthority outbox/history integration, native dead-letter delivery, arbitrary-backlog recovery or full deployment readiness. The finite evaluator observations supplied no forced-deadline, arbitrary-program or performance guarantee. The hostname was still pending at this checkpoint. Later dated sections above describe the owner-only pilot; `postrv/confidence` remains the private source destination and its public release is deferred.

At that checkpoint the user had deferred model setup. Later, an owner-only Pi cohort produced three accepted submissions and an interaction failure, while repair and publication remained incomplete as recorded above. A qualifying live recording, source access for submission and manual competition entry remain release work. On 5 October the user reported an organizer-approved location exception for this entry, permitting submission and prize eligibility; supporting correspondence remains private and outside the repository. An equal-budget real-model comparison is needed before claiming a model or performance advantage. No win, measured advantage, general correctness or hostile multi-tenant readiness is claimed. The productionisation plan (retained private reference; unavailable in this source distribution) prioritizes the outstanding implementation and release work.
