# Owned live Container conformance harness

This preparation is independent of Artifacts, model credentials and production Workers. It uses the installed Sandbox 1.0.0 `Files` helper with the native Durable Object Container API. It is an inert fixed workload, not the production authoring or evaluator image. Local tests and packaging never satisfy the live provider gate.

The default command returns `BLOCKED`, writes a sanitized report, and makes no authentication or remote API calls:

```sh
node --import tsx infra/live-container-check.ts
node --import tsx infra/live-container-check.ts --self-test --out infra/live-container/.runs/self-test.json
node node_modules/typescript/bin/tsc --noEmit -p infra/live-container/tsconfig.json
node node_modules/typescript/bin/tsc --noEmit -p infra/live-container/tsconfig.runner.json
node --import tsx infra/live-container-check.ts --package --out infra/live-container/.runs/package.json
node --import tsx infra/live-container-check.ts --prepare --out infra/live-container/.runs/prepared.json
```

An explicit read-only readiness check privately runs `wrangler whoami --json` against an existing selected OAuth account, reports the observed scopes, and only after the scope/account gate passes retrieves the credential in memory to GET the Container application-list envelope. It performs no remote mutation and cannot satisfy the provider gate:

```sh
node --import tsx infra/live-container-check.ts --check-account --account SELECTED_ACCOUNT_ID --out infra/live-container/.runs/account-readiness.json
```

`--package` performs Wrangler `deploy --dry-run`; it does not upload, start a Container, establish account capability, or establish that the Docker image built. The Dockerfile contains only a pinned Node base, the shim matching the locked Sandbox package, and four inert scripts. No project source, agent toolchain, provider secret, service credential or production binding enters the image.

## Explicit live run

Live execution requires an explicit `--run` and a fresh owned journal. Use an existing Wrangler OAuth login and an explicitly selected account with Workers and `containers:write` scopes. The script never performs an interactive login or grants a scope; ordinary same-scope OAuth renewal is allowed. Missing account, scope, login or dedicated admin token blocks mutation.

Set `CLOUDFLARE_ACCOUNT_ID` to the selected account. Generate a dedicated 256-bit hex token into `LIVE_CONTAINER_ADMIN_TOKEN` without printing it, and retain it privately until cleanup. This is a test-only Worker authentication credential and is never sent to the Container or fixture gateway. Pass the journal path returned by `--prepare`:

```sh
node --import tsx infra/live-container-check.ts --run --journal /absolute/path/to/owned/journal.json --out infra/live-container/.runs/live.json
```

The script verifies the login and selected account before privately obtaining an OAuth credential, checks that the fresh Worker and exact Container application names are absent, packages the concrete config, and journals deployment before dispatch. Subprocesses run asynchronously with bounded private stdout/stderr capture, sanitized failure classifications and process-group termination on timeout or output overflow. Wrangler receives the admin secret through an ephemeral mode-0600 secret file, removed in `finally`; tokens, raw CLI errors and personal account identity are never included in reports. A hard process crash can leave that ignored local secret file; remove it privately once the retained credential is safe.

The generated names contain 80 random bits derived from the UUID. No existing Worker is updated. One `lite` instance is admitted, with a 120-second persisted hard deadline and a 180-second image-entrypoint safety exit. The detached child has a 150-second exit bound. The auth gate precedes Durable Object lookup, accepts only native requests with the exact bearer token, provides no arbitrary command/body/target interface, and expires new work after ten minutes. The controller admits at most 64 test calls; the native client admits at most 40 calls. Stop remains available after auth expiry and request-budget exhaustion.

The child control request has a 25-second client read timeout to cover the fifteen-second parent request plus five-second post-exit observation and bounded overhead. It changes neither the native parent deadline nor the generation deadline, and an uncertain request is never repeated.

## Observation sequence

Before journaling or dispatching a start, poll deployment availability read-only with at most 20 probes and a 60-second API deadline. The authenticated route must return HTTP 200, the exact run identity, no generation and native Container absence; current Worker bindings and the exact fresh application must independently share the same namespace/class association. An unavailable route remains `READY_UNOBSERVED`, blocks start and provides no native conformance failure or pass. An unexpected prior generation fences the run immediately.

1. Persist the generation identity, capacity reservation, hard deadline and single start dispatch before calling `container.start({enableInternet:false})`.
2. Deliberately call `ctx.abort` after start to lose the control response. This is fault injection, not a provider reliability claim. A later read-only inspection must retain the same generation and one dispatch and observe a reconstructed controller. The client never repeats start.
3. A fixed local HTTP readiness probe must succeed independently of `start()` returning. Native inspection must carry the expected generation label and digest-pinned image.
4. Hydrate 4 KiB of all byte values through `Files`, read the bytes back, compare SHA-256, and inspect regular/executable modes `644`/`755`.
5. Execute HTTP from the Container through the private inert fixture intercept. An allowed route returns the controller-supplied generation despite forged request headers. An unknown destination and a redirect to it return denial. An unintercepted port must fail. The gateway never forwards any request outside the Worker; these observations cover the declared paths, not arbitrary network protocols.
6. Spawn a detached child with the parent exec's stdout/stderr ignored, await only the parent's `exitCode`, then read a fixed bounded result file and observe a changing filesystem heartbeat. The script has one ten-second total budget, beneath the fifteen-second native parent request limit. Reads, polling and the exclusive result write use the first 9.5 seconds; the final 500 ms is reserved for a bounded closed diagnostic on failure. Each awaited operation races its remaining budget and successful result writes are checked afterward. An independent ten-second safety timer and failed-probe completion send SIGKILL only to the exact script parent PID, after its bounded diagnostic opportunity; graceful Node teardown can wait for blocked filesystem work. Successful probes use normal exit only after their operations complete. This leaves the detached child for its separate bound or whole-generation stop, and makes no claim about the native API's signal-to-exit-code convention. After an observed nonzero parent exit, the host reads that fixed diagnostic file once, validates its closed fields and codes, and records `VALID`, `INVALID` or `UNOBSERVED`. After parent exit, all host file reads, streamed bodies, polling and successful progress retention share one five-second observation deadline. Changed-heartbeat reads use one fixed path, at most 64 bytes, and 100 ms polls. The parent abort timer stays disarmed. Failure retention has at most 500 ms of explicit best-effort overhead and cannot acknowledge the child; pending I/O is not claimed cancelled. A transactional failure latch preserves failure and current stop state against late progress writes. The script and host never repeat the spawn. Native `output()` waits for descendants and is deliberately excluded from this step. Persisted `childProgress` records the last observed stage, parent PID/exit code when known, and closed failure classification; it never asserts that a timeout stopped the child. Arm a five-second generation deadline only after successful child observation. Only successful whole-generation destruction followed by native `inspect() === null` releases the capacity reservation. No post-destruction per-process enumeration is claimed.

`PROVIDER_PASS` is available only after every actual deployed check completes. `SELF_TEST_PASS` is always labeled `owned-local-test`; `PACKAGE_PASS` is always `local-package`; both retain `providerGatePassed:false`.

## Reconciliation and cleanup

The journal records `NOT_DISPATCHED`, `MAY_HAVE_DISPATCHED`, `ACKNOWLEDGED` and `UNKNOWN` separately for deployment, start, stop and Worker deletion. File contents are flushed with `fsync`, atomically renamed, and the containing directory is flushed before dispatch; newly created directory links and the exclusive lock receive the same durability treatment. A flush failure prevents dispatch. It retains the exact account, Worker/application names, native Container snapshots and unresolved-resource names. Generation state is separately persisted in the controller. Neither a missing response nor an empty local CLI result establishes remote absence.

An exclusive local journal lock prevents two clients from repeating a dispatch concurrently. A hard crash leaves its `.lock` file; do not automatically expire or remove it. First establish that the recorded PID is no longer running and reconcile the journal's remote resource names read-only. Root can then remove that specific stale lock to permit the explicit inspection/stop paths. A removed lock never resets any persisted dispatch phase.

After uncertain deploy/start, do not rerun `--run` and do not create replacement resources. Inspect the recorded name on the selected account through Wrangler/dashboard read-only views. If the owned Worker is confirmed, retain its exact workers.dev endpoint in the journal, then use:

```sh
node --import tsx infra/live-container-check.ts --reconcile --journal /absolute/path/to/owned/journal.json
node --import tsx infra/live-container-check.ts --stop --journal /absolute/path/to/owned/journal.json
```

`--reconcile` performs inspection only and remains `RECONCILIATION_REQUIRED`; it does not silently resume a partially executed experiment. `--stop` journals before dispatch and independently inspects absence afterward. Stop uncertainty remains fenced. A destroyed generation does **not** establish full resource cleanup.

The separate explicit `--continue-before-start` mode applies only to an acknowledged deployment whose original and current journals both retain `start:NOT_DISPATCHED`, with no uncertain deploy/stop/delete. It requires the original immutable deployment report and a distinct output path:

```sh
node --import tsx infra/live-container-check.ts --continue-before-start --journal /absolute/path/to/owned/journal.json --deployment-report /absolute/path/to/original-deployment.json --out /absolute/path/to/new-continuation.json --account SELECTED_ACCOUNT_ID
```

This mode checks unchanged deployed runtime source hashes, exact original concrete config and unexpired ten-minute run identity, the same authenticated account, exact deployed Worker bytes, live variables/compatibility settings, namespace/application association, and authenticated native absence before journaling one start. It neither deploys nor updates a resource, and rejects any `UNKNOWN` or `MAY_HAVE_DISPATCHED` journal phase. The original deployment report remains unchanged. `--reconcile` remains read-only.

After retaining the evidence, root must inspect the exact owned Container application ID and namespace association, stop/confirm the generation, delete that specific application, retire its namespace with the exact modern `exports` tombstone if necessary, delete the recorded Worker, and separately inspect its exact image in the managed registry. A deletion tombstone is `exports:{LiveContainerHarness:{type:'durable-object',state:'deleted'}}`, with the class removed from code and no binding, container or `migrations` entry. The installed Wrangler image-delete command also invokes account-wide layer garbage collection; this harness uses no such command. An operator may journal one exact owned registry-tag deletion and independently observe absence of both that tag and its captured immutable manifest. Do not use broad account cleanup or delete any referenced/shared image. Journal each deletion before dispatch, reconcile uncertain outcomes read-only, and remove a name from `unresolvedResources` only after authoritative absence is observed. The harness deliberately leaves infrastructure deletion to that reviewed reconciliation step.

## Report schema and boundaries

`types.ts` defines the machine-readable report, journal, generation, probe and native snapshot schema. Reports retain source/package/lockfile digests, the current Git revision and dirty flag when available, actual installed dependency versions, Node version and compatibility date. They separate local/configuration checks from `deployed-native-container` checks. A provider pass is a narrow observation of this inert image on one selected account; the production runner/evaluator, authenticated application, Artifacts CAS and model end-to-end gates remain independent.

Primary API references, retrieved against the installed packages on 2026-10-05:

- [Native Durable Object Container API](https://developers.cloudflare.com/containers/api/durable-object-container/): asynchronous start, generation labels, exec, inspect, destroy and outbound intercepts.
- [Sandbox Files API](https://developers.cloudflare.com/sandbox/reference/files/): binary write/read and Linux mode metadata.
- [Container Wrangler configuration](https://developers.cloudflare.com/containers/configuration/wrangler/): `durable_object` scheduling and named images; the installed Wrangler schema is also checked.
- [Durable Object abort semantics](https://developers.cloudflare.com/changelog/post/2026-08-25-durable-object-alarm-abort-no-retry/): default alarm retries survive controller abort. This harness keeps retries enabled for its persisted deadline.
- [Container application list REST API](https://developers.cloudflare.com/api/resources/containers/subresources/applications/methods/list/): `success`, `errors`, `result` and optional `result_info.next_page_token` envelope; an incomplete page never establishes name absence.
- [Wrangler general commands](https://developers.cloudflare.com/workers/wrangler/commands/general/): `whoami --json`; the account/scope shape is additionally checked against the installed Wrangler source.

## Observed runs on 5 October 2026

Two fresh owned runs used the selected existing Wrangler OAuth account. Their
private operator journals and sanitized observations remain in the ignored
`.runs/` directory. The first run did not establish an available control route
and supplies no native lifecycle pass. The second run observed readiness and the
expected image/generation, retained a single start dispatch across an injected
controller abort, roundtripped binary bytes and regular/executable modes, and
passed the declared intercept identity and egress-denial probes.

The second detached-child probe returned an unclassified Worker HTTP 503. Its
changing heartbeat and deadline destruction were **unobserved**. The original
`.runs/live-second.json` therefore remains `FAIL` with
`providerGatePassed:false`. An additive `evidence-note.json` binds that original
report's digest and corrects its predeclared heartbeat detail to unobserved; it
does not rewrite the historical result or infer why the request failed. A later
explicit stop observed native absence and released the test reservation. A local
Docker reproduction of the child script passed, which does not explain or
replace the deployed observation.

A subsequent source review found a concrete descendant-wait flaw: the historical
probe called native `process.output()` after starting a 150-second child, while
the generation's deadline was 120 seconds. The native API documents that buffered
output waits for descendants; its signal reaches only the parent. That flaw is
corrected locally by awaiting parent exit with ignored output and reading an
exclusive bounded result file. Parent exit immediately disarms its abort timer,
even while durable progress retention yields. The client retains failed-stage
inspection without repeating the spawn. This is a strong failure hypothesis, not
a retrospective classification of the old HTTP 503. The retained manual stop at
02:42:56 preceded that generation's 02:44:32 hard deadline, so a deadline-triggered
destruction is not established as the old failure's cause. Historical reports and
the additive correction remain unchanged.

Both exact applications, Workers and Durable Object namespaces were subsequently
confirmed absent. Each exact image tag was deleted once, then both its tag and
immutable manifest returned HTTP 404. The retained cleanup reports mark named
resource cleanup established with no unresolved names, while keeping physical
storage reclamation unclaimed. No uncertain start/deployment was replayed, and no
account-wide registry garbage collection was used for those two resources.

A third fresh owned deployment initially had an unavailable control route before
any start dispatch. A later explicitly authorized `--continue-before-start`
verified the unchanged original deployment, namespace association and native
absence, then dispatched one start. Readiness, image/generation identity,
hydration/modes and the declared intercept probes passed. Its child request
returned HTTP 503 after an observed parent exit code 1 (`PARENT_NONZERO`), with no
heartbeat acknowledgment. No stderr or child diagnostic was retained by that
historical image, so the live cause remains unclassified. An explicit manual stop
subsequently observed `STOPPED`, native `inspect:null` and released capacity; a
deadline-triggered stop was not established. Historical reports remain unchanged
and `providerGatePassed:false`.

The third exact application, namespace and Worker were subsequently confirmed
absent. One exact image-tag deletion returned HTTP 204; later tag GET and
startup-manifest HEAD returned HTTP 404. Its cleanup retains no unresolved names
and makes no physical-storage reclamation claim. No account-wide garbage
collection was requested. The third sanitized derived record (retained private reference; unavailable in this source distribution)
binds the unchanged deployment, execution, manual-stop and cleanup reports.

An owned local test of the exact third image at the documented `lite` budget
(1/16 vCPU, 256 MiB) reproduced `ENOENT` at its first heartbeat read after the
fixed 350 ms delay. This confirms that assumption can fail, but the amd64 image
ran under aarch64 Docker emulation and does not establish the deployed failure's
cause. The current local correction polls under one shared ten-second total budget
(9.5 seconds for operations and a final 500 ms diagnostic reserve), retains
bounded closed diagnostics, and forcibly terminates only its own parent on
failure or safety expiry.

A fourth fresh owned run executed from clean commit `dd89588`. All sixteen input
hashes matched that commit and its retained source archive. Four configuration
checks and all six deployed native checks passed: single start across the injected
controller abort, readiness, binary/mode hydration, the declared intercept paths,
changed child heartbeat after parent exit code 0, and automatic deadline destruction.
The controller retained `STOPPED`, native `inspect:null` and released capacity.
No manual stop was needed. This passes the declared inert-image gate on one
account; production images, protected fixture separation, Artifacts publication,
identity and real models remain separate gates.

The fourth exact application, namespace and Worker were confirmed absent. One
owned image-tag deletion returned HTTP 204. The first absence request did not
complete; read-only reconciliation later observed HTTP 404 for both that retained
tag and the startup manifest. No delete was repeated and no account-wide garbage
collection was requested. The fourth sanitized derived record (retained private reference; unavailable in this source distribution)
binds the preserved successful execution and final cleanup reports. The earlier
failed records remain unchanged, and their causes are not retrospectively inferred.

A sanitized derived record (retained private reference; unavailable in this source distribution)
retains execution source hashes, the failed gate, additive correction digests and
named cleanup observations without operator credentials or the raw private journal.
