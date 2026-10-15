# Closed pilot operating profile

This profile applies to the private Cloudflare MJS pilot. It is an operator stop
policy for finite work, not the competition submission checklist. Health's
`readiness: UNVERIFIED` does not become verified because HTTP 200 proves liveness.
The [9 October checkpoint](PILOT_RELEASE_GATE_F508454.md) records the verified
repair-to-review-to-publication-to-receipt journey. The later
project-import acceptance (retained private reference; unavailable in this source distribution) retains
platform `39c8c58` and its **then-observed revision 109**, not the latest authority
state. The owner observed maintenance off, CLOSED admission, one receipt, no held
evaluation capacity and no pending publication/cleanup work. Maximum and settled
internal units were 3,600,000, held and available zero; new agent work was blocked
at the policy cap. These original observations remain dated. Recheck state before
admission; read [release status](RELEASE_STATUS.md) for subsequent changes and
[current handover](TEAM_HANDOFF.md) for submission preparation.

Initial publication acceptance was revision 97. Legacy teammate membership
received HTTP 202 and one retained event at revision 98; the user then confirmed
the workspace opens after refresh. That historical access observation is not
continued verified membership. Owner migration on 11 October advanced the
original pilot **109 to 110**, with one active verified human owner and the legacy
member suspended, while preserving published source, budget and receipt.
Continued teammate access needs a recipient-bound invitation and authenticated
acceptance. Distinct-human role actions/export remain unobserved; the owner
waived that rehearsal, so it is not an outstanding submission prerequisite.
Native pilot membership does not share owner-created imported projects. Import
retains immutable source and check configuration, not generic execution or
publication.

The later tools-enabled confirmation used its own isolated project and bounded
grant. It completed automatically through verified cleanup and restored normal
GLM-5.3 / Narsil `always` / Interlinked `feedback` by **18:12:32 UTC on 12 October**,
with publication disabled and the original pilot head/receipt unchanged. Its
9/9 independently verified checker signatures and clean lifecycle are finite
evidence, not the sustained operational soak below. [Separate confirmation](TOOLS_RECOVERY_CONFIRMATION_2026-10-12.md)

## Inspection and retained evidence

An enrolled human admin may read `GET /v1/projects/<project-id>/operations` through the Access-protected application. `?jobKey=<64 lowercase hex>` selects one registered evaluator job, including a completed one. The authority checks admin membership and human credential class, then returns its revision, gate, maintenance mode, pending outbox counts by kind, cleanup phases, unresolved publications, history row counts, SQLite bytes and internal budget counters. It asks the evaluator through a private service binding for queue counts, occupied job identities and read-only generation status. The authority and evaluator observations are explicitly timestamped as non-atomic across services. A failed evaluator inspection is `UNKNOWN`; it never releases an occupied slot. Generation status includes the durable callback freeze time and delivery flag. Prior deployed jobs may have a frozen callback without a recorded freeze time; report that age as unknown. The historical `2893f5c` release record (retained private reference; unavailable in this source distribution) retains both rollout mismatches and later agreeing runtime observations. In its second maintenance stage, the first observed true authority flag lagged deployment acknowledgement by about 8 minutes 40 seconds. Static module/binding readback did not establish the running Durable Object's flag. Fresh revision-59 state and operations showed maintenance off after the following rollout, zero active work, maximum and settled budget 3,200,000 and held zero. Review preparation then advanced authority to revision 60, with gate CLOSED, one unapproved review and zero publications. The later revision-97 publication and active-runtime result is recorded above; this older sequence is retained to show the maintenance-observation gap. Earlier contiguous D1/Queue observations are dated snapshots, not sustained delivery proof. Recheck protected `/state` and `/operations` for the same incarnation and current revision before granting an agent.

Evaluator traces are enabled at a 10% head sample in `workers/evaluator/wrangler.jsonc`. [Cloudflare documents seven-day trace retention](https://developers.cloudflare.com/workers/observability/traces/). Recovery faults are also coalesced into each scheduler or generation Durable Object, at most 32 recent distinct events per object. Each event records a stable event ID, fixed job key (or `null` for a scheduler-wide pump fault), operation, safe code, first/last time and occurrence count; it stores no prompt, source, credential or callback bytes. Structured logs announce the first and exponentially spaced recurrences. The durable journal survives object restart, but it is a bounded recent diagnostic, not a complete audit history. Export the relevant owner inspection and independent release evidence to private durable storage before older entries can be evicted. An absent event is not evidence of no fault.

`oldestPendingOutboxAgeSeconds` and `oldestQueuedAgeSeconds` come from durable creation timestamps for new rows. An older row without a recorded timestamp sorts first and makes the oldest age `null` with `LEGACY_UNKNOWN`; an empty queue is `EMPTY`. Neither a duplicate effect nor a schema migration refreshes an old timestamp. Projection lag, dead-letter backlog, provider spend and container resource return are still unobserved in this endpoint. Do not infer them from a clean snapshot or a `ready` flag. Inspect the original outbox identity, the D1 contiguous watermark, the named dead-letter Queue, provider AI billing and container inventory separately. Retain UTC observation time, project incarnation, authority revision, deployed source digest, inspected job key and the independent provider or D1 response; never retain Access credentials or raw model content in a public report.

## Bounded operations monitor and local alert spool

`node scripts/monitor-pilot.mjs` is an operator-invoked, finite monitor for the existing
native projects explicitly listed in a private configuration. It makes one Access-protected `GET /api/session`, then one `GET /v1/projects/<id>/operations` per project
per sample. It performs no admission change, model call, resource creation, credential
minting or external notification. Run its injected local fault suite with `node --test
scripts/monitor-pilot.test.mjs` using Node 22.20. The monitor is an additional
operations tool; it does not alter the frozen competition release evidence or qualify a
later source/video revision.

An operator must first verify the exact application origin, existing Access application
audience, existing project incarnations, current minimum authority revisions and
declared release digest against independent retained deployment and protected readback
evidence. The monitor does not discover resources. The release digest is an operator-declared association, not a provider module or running Durable Object source
verification. Use an existing private Access cache file whose basename is `<application-hostname>-<exact-Access-audience>-token`; log in or renew a session separately when needed.
The owned configuration and explicit execution flag are operator consent to send that
existing token only to the exact selected HTTPS origin. The hostname-and-audience-bound cache name
and expected issuer/audience prefilter prevent common scope mistakes; they are not
cryptographic proof that an arbitrary origin is owned. Review the origin independently
before execution. The monitor never runs `cloudflared`, Wrangler authentication or an
interactive challenge.

Create an owned `0600` JSON configuration with exactly this shape, replacing all example
values with the independently verified existing scope. Paths must be absolute and
canonical (including any `/private` prefix on macOS temporary paths); symlinked
cache/config paths are refused. No configuration or cache is copied into the report.

```json
{
  "schemaVersion": 1,
  "origin": "https://application.example.invalid",
  "releaseDigest": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "access": {
    "tokenFile": "/absolute/private/application.example.invalid-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb-token",
    "issuer": "https://team.cloudflareaccess.com",
    "audience": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    "principalId": "https://team.cloudflareaccess.com#verified-human-subject",
    "tenantId": "verified-tenant"
  },
  "expectedMaintenance": false,
  "expectedGate": "CLOSED",
  "requireDrained": true,
  "samples": 1,
  "intervalMs": 5000,
  "projects": [
    {
      "scope": {
        "schemaVersion": 1,
        "tenantId": "verified-tenant",
        "projectId": "existing-project",
        "projectIncarnation": "verified-incarnation"
      },
      "minimumRevision": "1"
    }
  ]
}
```

```sh
node scripts/monitor-pilot.mjs --execute-read-only \
  --config /absolute/private/monitor-config.json \
  --spool /absolute/private/new-monitor-spool
```

The spool's parent must already exist; a new spool is created `0700`. An existing spool
must be owned, private and canonical. Choose a new spool after changing configuration;
an existing configuration digest mismatch is refused before any network read. At most
four exact project IDs, six samples, 26 requests, 20 seconds per complete response, 128
KiB per response and 180 seconds of network sampling are allowed. Samples are spaced
5–30 seconds apart. Reads are serial, redirects are refused and there are no automatic
retries. Once a target yields UNKNOWN, its remaining declared samples are skipped and
its earlier result remains UNKNOWN. Config bytes are limited to 16 KiB, each retained
report to 128 KiB, alert state to 256 KiB and the spool to 128 runs/256 correlations.
Export reviewed evidence and deliberately provision a new spool before these local
limits; the tool never rotates or deletes it.

Unsigned cached-token claims are only a destination/expiry prefilter. The application
verifies the Access credential and returns the exact human identity before any project
read. The monitor checks the signed issuance/authentication timestamp shape and requires
the server-verified session to be unexpired before each operations request. The authority
also applies each project's current authorization policy. Collaboration-migrated native
projects require the current human owner and a recent session even for admin operations
GETs: issuance within 900 seconds, plus authentication time within 900 seconds when
present. A legacy project may accept an older unexpired human admin session. A successful
session GET does not prove project operations access. An exact bounded HTTP 403
`error.code: RECENT_SESSION_REQUIRED` becomes an actionable `UNKNOWN`, skips that
target's remaining samples and recommends ordinary owner-session refresh outside this
CLI. Arbitrary error messages are never retained. Refresh is not proof of strict
provider reauthentication. The authority rechecks membership on each operations read.
Principal and incarnation headers bind the configured scope. This does not establish
provider step-up or immediate provider-session revocation, which remain separate
qualification gaps.

The report uses `PASS_SCOPED`, `ALERT`, `STOP` or `UNKNOWN`, with exit statuses 0, 1, 2
and 3 respectively. `UNKNOWN` takes precedence when a stop condition and missing
evidence coexist. A `PASS_SCOPED` result means only that these fresh operations
observations met the configured expectations and the named local thresholds. Readiness
remains `UNVERIFIED`. A response older than 30 seconds, future/invalid timestamp,
revision regression, changed scope, missing current capacity contract, denied access,
scope-change conflict, evaluator uncertainty, stream bound or deadline becomes
`UNKNOWN`. A flag mismatch, unresolved publication, cleanup recovery hold, required
drain failure or inclusive stop threshold recommends stopping new work. The monitor
never closes admission on an operator's behalf; use the separately authorized safety
flow and retain the original command/job/publication identities for reconciliation.

Capacity, queue, outbox and callback thresholds use the table below. Generation
registration time is not directly exposed: the reported occupied age explicitly uses the
current runtime's fixed 30-second execution deadline minus 30 seconds. Reassess that
association when runtime semantics change. A young running job with no frozen callback
is legitimate; an undelivered stopped/stopping job with no freeze timestamp has unknown
callback age. Frozen or delivered callbacks do not establish termination and fixture
closure. The scheduler's ordinary operations view lists only currently occupied
generations; it is not a completed job inventory. Recent recovery journals are bounded
diagnostics, not an absence of past faults. The monitor does not establish runner
dispatch/model outcome reconciliation from outbox counts.

Each report records hashed target/correlation identities, safe fixed finding codes,
remediation, bounded numeric counters, response sizes and finite request latency p50/p95
with sample count, separately for all authorized reads and operations-only reads. Failed
reads remain in the respective latency samples; they are not queue-admission, workload
completion or receipt latency measurements. Access tokens, raw response/error bodies,
origins, principal/project IDs, source, prompts and model output are never retained.
Reports and alert state remain private operational evidence.

The `alerts.json` spool correlates repeated conditions, records escalation and marks a
condition cleared only after all requested samples for that exact scope are fresh and
fully interpretable. Partial or unknown observations do not clear older alerts. Original
per-run reports remain retained even after a later clear. Local writes use exclusive
private files, file sync, atomic replacement and parent-directory sync. A
`.monitor.lock` is never automatically removed after an interruption or retention
failure. Preserve the `STARTED_UNKNOWN` run, reconcile whether any read completed,
inspect local filesystem health, and have the operator review the lock before moving it
aside. A retention failure is not an acknowledged successful monitoring run. The spool
is a local operator inbox; external delivery, an accountable on-call destination and a
tested response workflow are not configured by this command.

Projection/D1 lag, dead-letter Queue backlog, provider invoice attribution, physical
container resource return, runner/model outcome reconciliation, R2 request/byte volume
and external notification delivery remain explicitly unobserved. Inspect those through
separately bounded, authenticated provider or original-evidence tools. A clean
operations sample cannot close those gates or establish sustained production acceptance.
The report also explicitly leaves `deployedReleaseIdentity`,
`strictProviderReauthentication` and `providerSessionRevocation` unobserved.
Native workload timing/fault and recovery drills below still require their own retained
evidence.

## Named pilot limits and stop actions

These are **operator thresholds** unless the enforcement column says otherwise. Close admission before investigating a stop condition. Preserve the exact pending command, job and publication identities; do not reissue a new intent after a timeout.

| Resource | Enforced boundary | Pilot alert and stop condition |
| --- | --- | --- |
| Evaluator containers | Two scheduler slots; 256 queued or active jobs maximum; 30-second execution deadline, with stop and callback recovery continuing afterward. | Alert when any generation remains occupied more than 60 seconds after registration; stop new admissions at 120 seconds or on an `UNKNOWN` inspection. Do not equate a frozen callback with stopped container and fixture. |
| Queued evaluation work | Scheduler rejects at 256 pending. | Alert at eight queued jobs or an oldest wait of 60 seconds; stop at 16 queued jobs or 120 seconds. `LEGACY_UNKNOWN` or `INVALID_TIMESTAMP` while queued is also a stop. |
| Authority outbox | Durable fixed identities and retry alarm; no age cap is enforced. | Alert if oldest pending age reaches 60 seconds; stop at 120 seconds, any unknown dispatch, or `LEGACY_UNKNOWN`/`INVALID_TIMESTAMP` while pending. Count alone is insufficient. |
| Callback and cleanup | Callback bytes freeze before retry; cleanup retains a recovery hold. | Alert if a frozen callback is unacknowledged for 60 seconds; stop at 120 seconds, unknown freeze time, or any cleanup `RECOVERY_HOLD`. Preserve its slot until all three termination, fixture-close and callback facts are observed. |
| Publication | One unresolved publication per canonical ref. | Any unresolved publication stops new admission and publication until exact-head reconciliation; never treat the old ref as cancellation proof. |
| Projection and dead letter | Queue retries and the named dead-letter Queue; D1 is derived. | Alert if contiguous D1 watermark trails authority by 10 events or one minute. Stop at 100 events, five minutes, any dead-letter item, or missing readback. Retain and replay only the original authenticated event identity. |
| Authority history and storage | Each ProjectAuthority stops new discretionary work at 20,000 `records` rows or 100 MiB SQLite, whichever is reached first. Authenticated admin operations reports `capacity` status and both dimensions. | Alert at 10,000 rows or 50 MiB. At STOP, preserve pending identities and drain existing work; investigate retention before admitting more. Recovery writes may exceed the threshold. This does not cap total storage, other tables, R2 or the account, and does not prevent a different project from being created. |
| Model work and spend | The historical cache-only repair accepted source using one GLM call and passed all nine protected cases. The retained original-pilot observation has maximum/settled 3,600,000 internal units and zero held/available at its cap. Separate benchmark projects use their own reviewed grants; new agent work still needs explicit headroom. | Reconcile retained provider responses before further grants; label the separate account billing gap. Stop if incremental token-rate estimated spend reaches US$1 for a repair, usage identity differs, or a dispatched call cannot be reconciled. The internal reservation is not a provider billing cap. |

The per-project history gate checks current `records` count and SQLite database bytes before new command preparation and again inside the authoritative transaction. The inclusive stop thresholds fence new cohorts, attempts and continuations, execution starts, repair/selection proposals and their acceptance, Weft handoffs, materialization, evaluation, review/approval/publication admission, goals, policy changes, budget increases and reopening the admission gate. Exact committed command retries return their retained result after current authorization; a capacity refusal is transient `503 AUTHORITY_CAPACITY_STOP` and creates no rejection tombstone, event or outbox row.

Reads, revocation, gate closure, cancellation, cleanup, signing recovery, original-publication reconciliation, projection replay, already-authorized bounded model calls, existing attempt output/context retention and trusted callbacks/settlement remain available. Already-admitted effects can finish and retain evidence past either threshold. No immutable history or replay protection is deleted. These are per-project new-work admission thresholds, separate from the tenant directory's managed-project count limit; they are not a hard storage ceiling or a substitute for verified compaction and authority recovery.

The last observed normal route was `@cf/zai-org/glm-5.3` with low reasoning;
the separate DeepSeek experiments do not change the historical GLM accounting.
Cloudflare's [GLM-5.3 model page](https://developers.cloudflare.com/workers-ai/models/glm-5.3/)
listed **US$1.40 per million input tokens, US$0.26 per million cached input tokens
and US$4.40 per million output tokens** when checked on 8 October 2026. The
original nine-call reconciliation verified 307 retained objects and matched every
admitted reservation to its response. The cache repair reported 1,962 input and
275 output tokens, estimated at **US$0.003956800**; that nine-call project estimate
is **US$0.093264640**. These are dated token-rate estimates, not an invoice or the
later experiments' total. [Current benchmark accounting](BENCHMARKS.md#cost-calculation-not-an-invoice)
keeps response estimates, cumulative admission ceilings and uninspected global
usage distinct. Recheck rates before another grant and retain attribution gaps.

The earlier signed-in Cloudflare billing view showed US$1.39 aggregate account usage for its observed cycle, with no attributable Workers AI line. It did not establish zero model cost or reconcile these project calls to an invoice. Provider response identities and token quantities are verified separately from billed charges.

## Finite soak before opening

The completed finite journey is not the measured soak below. On the exact final release bytes, use only the declared bounded workload: one three-agent cohort, one repair at a time, all nine independent protected jobs in the current profile and one human review. Record p50/p95 and sample count for application reads, queue admission-to-start, evaluation completion and receipt readback. Count requests, full-state reads, R2 reads/bytes, Queue deliveries/retries, D1 lag, model provider usage and container generations. Inject one lost response and one failed callback while preserving identities; observe durable progress and return to zero occupied generations, unresolved callbacks, cleanup holds, pending outbox items and dead letters. A local or synthetic workerd run does not satisfy this Cloudflare soak. Keep the release gate CLOSED if any required measurement is absent.


## Next operational acceptance record

Use the current [operator deployment instructions](../infra/README.md) and
[release status](RELEASE_STATUS.md) for source/configuration association. The
old private release acceptance contract (retained private reference; unavailable in this source distribution)
is preserved rationale, not the current submission checklist. The broader
operational observations below have distinct proof sources; a clean `/operations`
response cannot close all of them.

| Observation | Collect and retain | Stop or remaining condition |
| --- | --- | --- |
| Runtime identity/drain | Timestamped native `/state` and `/operations`, directory response, project incarnation/revision, release digest, gate/maintenance flags and evaluator queue/occupied identities. | UNKNOWN or disagreement with intended maintenance remains a stop. Observe propagation before proceeding. |
| Projection continuity | Independent D1 contiguous watermark beside authority revision; named dead-letter Queue inventory and provider timestamp. | Missing reads or dead-letter items remain a stop. Preserve original event identities through recovery. |
| Container return | Independent container application/generation inventory and exact job callback, termination and fixture-close records. | Frozen callback or zero scheduler count alone does not prove provider resource return. |
| Model accounting | Existing nine-call retained-response reconciliation and separately attributed provider usage/billing. | Zero available internal units prevent new grants. Token estimates are not billed charges; avoid repeating unchanged model evidence. |
| Teammate acceptance | If a future multi-person trial is undertaken, retain second-user scope, source/candidate reads, permitted actions, receipt export/offline verification and unavailable admin controls. | Currently unclaimed; the owner waived this rehearsal for submission. Owner observations cannot stand in for another person's actions. Imported sharing requires its own implementation and acceptance. |
| Recovery | Exact-source upgrade/restore and key-management drills with original identities, observable cleanup and retained failures. | Existing evaluator fault evidence covers its declared cases; it cannot establish unperformed production drills. |
| Soak/alerts | Sample count, latency distributions, request/R2/Queue/container/usage counters and tested notification destination with accountable operator. | Finite publication is accepted separately. Missing measurements keep the broader operational gate open. |

Before an update, export native state/operations and the original receipt to private evidence. After activation, compare publication head, signed records, receipt bytes, membership and budget with that snapshot. Preserve failed/UNKNOWN deployment journals alongside reconciliation sidecars. Reuse provider/image/fault evidence only when its complete declared inputs still match; regenerate release configuration after changed inputs.
