# Owned production evaluator conformance

This separate, finite gate uses the unchanged production evaluator Dockerfile,
EvaluationSandbox execution/hydration/stop, EvaluationScheduler, FixtureStore and
FixtureEgress. Thin subclasses add retained/native read-only inspection and one
explicit controller abort; no native method, execution, recipe or stop is
overridden. The controller/callback receiver is an owned observer, not
ProjectAuthority, application OIDC or a release authorization.

No Artifacts repository, model credential or application origin is needed. An
existing selected Wrangler OAuth account must support Workers, Containers and a
fresh owned R2 bucket. An authenticated exact-name R2 absence read does not prove
bucket creation or binding writes. An unavailable/denied create remains blocked
or uncertain, and never becomes a provider pass.

Local commands make no account calls:

```sh
node --import tsx infra/live-evaluator-check.ts
node --import tsx infra/live-evaluator-check.ts --self-test --out infra/live-evaluator/.runs/self-test.json
node node_modules/typescript/bin/tsc --noEmit -p infra/live-evaluator/tsconfig.json
node node_modules/typescript/bin/tsc --noEmit -p infra/live-evaluator/tsconfig.runner.json
node --import tsx infra/live-evaluator-check.ts --prepare --out infra/live-evaluator/.runs/owned-preparation
node --import tsx infra/live-evaluator-check.ts --package --journal infra/live-evaluator/.runs/owned-preparation/journal.json --out infra/live-evaluator/.runs/package.json
```

The default writes BLOCKED with no credential retrieval or account call.
SELF_TEST_PASS and PACKAGE_PASS retain providerGatePassed:false. Packaging
checks two Worker bundles; it does not prove the Docker image was built, deployed
or started. The actual Node HTTP test runs public known-good/bad programs on
owned loopback servers, and is labelled local rather than Container evidence.

Preparation exclusively creates an ignored mode 0700 directory and mode 0600
random per-Worker secrets. The OAuth credential is retrieved only in memory
during explicit live operation; raw CLI/API diagnostics and personal identity are
omitted. Checker/root public keys are independent; the root private key is not
deployed. Signing credentials and admin/service tokens never enter the image or
candidate process environment. Preparation made while the tree is dirty is
useful locally but cannot run live: after review/commit, prepare a fresh directory
against that clean revision.

Only the root operator runs the remote mode:

```sh
node --import tsx infra/live-evaluator-check.ts --run --journal /absolute/path/to/fresh/journal.json --account SELECTED_ACCOUNT_ID --out /absolute/path/to/fresh/live-report.json
```

The driver checks the exact account, source revision and all input hashes, names
and private secret associations. It observes exact fresh Worker/application/R2
name absence, packages before dispatch, then journals one bucket create and each
deployment before calling the provider. A deny Worker establishes the controller
service target. Initial evaluator/controller deployments cannot admit execution:
their image is unconfigured and admission expiry is zero. The authenticated
native getter observes the actual managed image while its inspection-only DO has
no registered job and no container. Two separately journaled updates pin that
same immutable managed image and a 20-minute admission expiry. The driver compares
every uploaded JS/WASM module against its retained local package. Both Workers'
exact compatibility settings, plain vars, complete binding sets, R2 bucket,
service targets and local/cross-Worker namespace/class identities are checked
before seeding or dispatch. The native application must bind that evaluation
namespace, and the managed image must use exactly the selected account's fresh
`<evaluator-name>-conformanceevaluation-base` repository.

The exact four tracked collaboration files produce a raw Git closure and strong
source manifest. The good transformation enables the cache and accessible status
while preserving invalidation and fencing cache fills by their captured generation.
The bad transformation removes invalidation and
prints a forged PASS claim to candidate stdout. Production ignores that stdout;
the external HTTP oracle must still observe at least one behavioural FAIL. Both
closures are checked by the shared Rust kernel before R2 writes. The controller
only accepts those two source package digests pinned in its configuration.

All 20 immutable requests are persisted before enqueue: 9 normal good, 9 normal
bad and 2 separately attributed single-probe fault jobs. The unchanged scheduler
owns two real lite slots. Every job has a fresh fixture DO and Container identity;
one job never supplies replication under another ID. Fault jobs are admitted
first: one callback returns503 once after signed-byte/R2 retention, and one
controller is aborted once after RUNNING is actually observed and rechecked
against the current job/deadline immediately before abort. Its durable intent
retains the pre-abort construction UUID; subsequent inspection must observe a
different construction UUID and the signed production continuation-loss marker.
An intent alone cannot prove reconstruction. The same callback
must be retried, and the restarted execution must become truthful INCONCLUSIVE,
stop its native generation and release its slot through ordinary production
reconciliation. A missed RUNNING boundary fails that fault check, rather than
repeating the abort or inventing an observation. The production 30-second job
deadline is unchanged; this gate makes no artificially forced deadline claim.

For the first callback rejection, the owned receiver samples the evaluator's
retained callback with `callbackDelivered=false` and the exact production
scheduler row with `status=ACTIVE` while the producer awaits that response. It
binds both samples to the registered job/request, source package, signed evidence
and immutable callback digest in a durable witness before returning 503. The
capture must finish within 1.5 seconds of callback arrival, leaving room for
durable commit under the production two-second dependency timeout. The full
verifier requires this bounded first-delivery witness as well as the later
same-digest retry and final DONE slot. A later poll or a delivery count cannot
reconstruct the rejected-callback boundary. If this witness is missing, slow or
contradictory, that fault gate fails closed.

The receiver authenticates the producer, matches the registered scope/job/input/
candidate/issuance, verifies the actual checker signature and reads actual
observation bytes back from R2. The native client independently verifies every
retained callback against its separately selected public trust. Complete success
requires all 9 good PASS, completed 9 bad jobs including overlap FAIL, both fault
observations, 20 STOPPED/native-null generations, 20 exact durable fixture fences
and 20 DONE scheduler entries. Normal jobs require retained inactive fixture
contents. The early restart fault may have no initialized fixture contents only
when its durable closed marker is retained alongside STOPPED/native-null and
INCONCLUSIVE. An absent snapshot alone never proves the fixture is fenced.
Raw observations, envelopes, source packages, deployed module
hashes and native snapshots remain available for independent review. Finite
success does not certify arbitrary-program correctness, general egress denial,
performance, application identity, authoring/Git/model execution or publication.

The ninth `overlapping-read-write` recipe appends to the unchanged eight existing
recipes. A private FixtureStore RPC arms one GET capture. The candidate's first
GET snapshots the old value and commits its read accounting before waiting
outside any storage transaction. Only after that capture is observed does the
controller issue candidate PUT; only after its acknowledgment does it release
the old GET. After that request completes, a fresh candidate GET must return the
acknowledged value. The overlapping request may return either its captured old
value or the replacement after a generation-aware retry; returning the new value
is not a failure. External accesses must begin with the captured GET and one PUT,
then contain only replacement-valued GETs within the existing 128-access bound,
with matching read accounting. The candidate still has only GET/PUT `/store/value` data
access; it cannot arm, inspect or release this barrier. Close, a ten-second
barrier deadline and reconstruction permanently fence held reads. The signed
observation retains stage order, response digests and external fixture state;
the live verifier independently requires this order and exact final fence.

Local loopback HTTP tests additionally pin every file and the manifest of the
reviewed sequentially repaired pilot source `c0a908e...b3b50`. It fails the exact
new protected overlap sequence. The generation-fenced owned good source and a
separate local retrying positive implementation both pass,
while retaining read/read cache benefit and failed-write behavior. These local
observations are separate from a future 20-job live campaign. Historical records
below describe their original eight-probe profiles and are not upgraded by this change.

Every possible create/deploy/seed/enqueue effect is fenced by a fsynced journal
and exclusive lock. MAY_HAVE_DISPATCHED or UNKNOWN is never automatically repeated.
The controller separately commits its per-job enqueue intent before RPC; it also
refuses a second dispatch while an enqueue is unresolved. A hard client crash
leaves a lock: inspect its PID and retained state before manual removal; it is not
automatically expired. The `remoteCalls`/`remoteMutations` fields count direct
driver HTTP methods, not hidden Wrangler requests or all native executions.

Reconciliation observes state only; closing admissions is a separate journaled
operation, permitted after expiry. Neither performs replacement execution:

```sh
node --import tsx infra/live-evaluator-check.ts --reconcile --journal /absolute/path/to/journal.json --account SELECTED_ACCOUNT_ID --out /absolute/path/to/new/reconcile-report.json
node --import tsx infra/live-evaluator-check.ts --close --journal /absolute/path/to/journal.json --account SELECTED_ACCOUNT_ID --out /absolute/path/to/new/close-report.json
```

After retaining/independently checking the evidence, the root operator prepares a
run-specific cleanup intent. Confirm every generation's native absence and all
scheduler slots released before any infrastructure deletion. Bind the exact
application ID, all four namespaces, Worker names and captured image digest to
the retained original report/current binding association; do not copy previous
run identities. Journal each possible deletion before dispatch, then observe
authoritative absence. An uncertain delete is reconciled read-only.

Delete the exact application, then retire ConformanceControl first to remove its
external evaluator/scheduler/fixture references. After exact controller deny-version
readback and CONTROL namespace absence, retire ConformanceEvaluation,
ConformanceScheduler and FixtureStore. Use modern `exports` state:"deleted" with
no container or legacy migrations and no ordinary DO, R2, service or plain-text
bindings. Wrangler deploy retains secret bindings with `keepSecrets:true`: permit
only the exact pinned original secret_text name/type set (two names per Worker),
never secret values or added names. Read back each exact deny module/version and
settings before deletion; observe all four namespaces absent before deleting the
two Workers. An uncertain earlier retirement remains UNKNOWN. Dependency-changing
recovery needs a separately journaled operation bound to the original uncertain
intent and the new, freshly verified controller-detachment preconditions; it must
not reset or replay the old operation. For the managed registry, inspect the exact owned repository, exclude
digest aliases when selecting its one owned Wrangler tag, HEAD-match its captured
startup manifest, issue at most one exact tag DELETE and independently observe
tagGET404 plus manifestHEAD404. Never use Wrangler image delete or account-wide
garbage collection. Independently archive the retained source/observation bytes
before removing only this bucket's objects and then this bucket. Keep all named
resources in unresolvedResources until their specific absence checks pass;
generation stop is not infrastructure cleanup or physical reclamation.

## Retained finite native observations

The early prestart record (retained private reference; unavailable in this source distribution)
retains BLOCKED before any seed or execution, a module-name alias mismatch with
identical deployed bytes, and an original evaluator-retirement UNKNOWN. Separate
controller detachment and evaluator retirement established exact named cleanup
without acknowledging or replaying that uncertain operation.

The native evaluator record (retained private reference; unavailable in this source distribution)
retains clean execution commit `f4a85bc`, 42 verified committed inputs and two exact
generated JS/WASM outputs. The independent verifier did not perform a clean
rebuild. The original driver
claims PROVIDER_PASS; the separate independent verifier reports
READ_ONLY_OBSERVED_SUBSET_PASS. The full frozen verifier remains failed for the
missing contemporaneous rejected-callback/undelivered/ACTIVE-slot sample, which
is explicitly UNOBSERVED. Injected 503 and two same-digest deliveries were observed
separately. The controller restart request remains UNKNOWN; distinct construction
and a signed production continuation-loss INCONCLUSIVE were independently checked.
Eight good jobs PASS; eight bad jobs complete with seven FAIL and one cache-benefit
PASS; callback-fault PASS and reconstruction-fault INCONCLUSIVE are separate. All
18 generations are STOPPED/native-null, callbacks delivered, fixtures closed and
scheduler slots DONE. Nine native image samples and maximum sampled ACTIVE slots
two are finite observations, not continuous capacity or performance proof.

Fresh closed-admission/native-absence/slot-release readback preceded cleanup. The
66-object, 241,501-byte archive was independently reconstructed and hash-verified
before individual deletion. All exact named infrastructure was confirmed absent
under the reviewed helper; per-object404 bodies were not retained. Its 459 direct
HTTP calls/72 direct mutations are retained counters, distinct from two native
retire deployments and two dry runs. One registry credential was issued with a
requested five-minute expiration; revocation and expiration were not observed.
Exact local tag cleanup retained the shared image and other tags. No account-wide
garbage collection, purge or physical storage reclamation is claimed.
