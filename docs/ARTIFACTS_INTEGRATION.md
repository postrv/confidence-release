# Cloudflare Artifacts integration

Confidence uses Artifacts for canonical Git history and isolated attempt repositories. ProjectAuthority owns the namespace binding, authorization, source validation, and publication. The public application calls ProjectAuthority through its service binding. Authoring generations reach only their assigned repository through the authenticated Git broker. The evaluator consumes immutable, verified source objects from R2.

The integration follows the current [Workers binding](https://developers.cloudflare.com/artifacts/api/workers-binding/), [REST API](https://developers.cloudflare.com/artifacts/api/rest-api/), [Git protocol](https://developers.cloudflare.com/artifacts/api/git-protocol/), [authentication](https://developers.cloudflare.com/artifacts/guides/authentication/) and [best practices](https://developers.cloudflare.com/artifacts/concepts/best-practices/) documentation. The installed Wrangler 4.147.0 configuration schema and generated types define the build contract. Dashboard access, API authorization, provider conformance, and application release admission are separately observed facts.

## Source and publication contract

Each attempt has an isolated repository with an exact retained association to its canonical repository. A provider fork copies current history; it has no parameter selecting the admitted historical commit. Confidence installs an immutable `confidence-work` ref from retained, verified Git objects to preserve that admitted base, including an unpublished repair base. A ref already containing another commit causes an association conflict.

Ingestion compares the fetched tip to the admitted commit, preserves raw commit/tree/blob bytes and regular/executable modes, and validates their complete correspondence through the Rust kernel. A moved ref cannot change the source being evaluated. Materialization composes verified leaves and writes a deterministic commit whose parent is the original publication base. Content-addressed R2 objects are read back and verified after writes.

Head observations use bounded Git discovery and match the complete branch ref exactly. Native testing showed that the binding history API returned an empty list for `refs/heads/main` while `main` resolved the expected commit. Using Git refs also avoids confusing a same-named branch and tag. A read of the current head never changes a frozen publication base.

Canonical publication sends the admitted old commit and exact new commit in one Git v1 receive-pack request. A competing advance cannot silently rebase that request. The authority persists the publication intent before dispatch, retains an uncertain outcome, and reconciles using the same publication identity and immutable source. Reading a newer head never authorizes a different push. A receive-pack acknowledgment, current-ref observation, and verified source readback are separate facts.

The closed pilot enforces its own smaller source profile: 4 MiB total source, 1 MiB per file, 2,048 manifest entries, supported regular/executable modes, bounded tree depth and object count, and bounded Git request/response and memory allocation. The provider's [platform limits](https://developers.cloudflare.com/artifacts/platform/limits/) do not raise these application bounds. Complete eager verification suits this profile; the [ArtifactFS](https://developers.cloudflare.com/artifacts/guides/artifact-fs/) lazy-hydration workflow would require a separate source-admission design.

The source-preparation update reuses the already fetched, fixed-head Git pack for blob bytes. It validates the complete closure, manifest, modes and limits before any R2 write, then stores each distinct blob digest once. The single-sample offline benchmark (retained private reference; unavailable in this source distribution) compared packed 4/100/1,000-file fixtures with identical snapshots. Code-path accounting models 4/100/1,000 Artifacts `readBlob` calls in the old loop and zero in the new path; local filesystem reads fell from 50/530/5,030 to 32/320/3,020. At 1,000 files, local preparation time changed from 445.4 to 172.5 ms. The benchmark excludes Git clone transfer and real provider latency. A fresh disposable live binding run (retained private reference; unavailable in this source distribution) at clean source revision `d0e1902` passed all 14 production-adapter checks and verified native Worker/bucket retirement. The owner-only application's later `18cb719` package (retained private reference; unavailable in this source distribution) includes this adapter and passed five-Worker provider readback. Neither observation establishes the 1,000-file live throughput gain or full pilot publication.

## Credentials and cleanup

Operator REST requests use the selected account's API token or the explicitly selected existing Wrangler OAuth login. Deployed code uses the configured Artifacts binding. Git requests use repo-scoped tokens; an account credential is never forwarded to Git or an authoring generation. Credentials remain outside source, command arguments, retained public reports, and authenticated remotes.

The broker strips caller credential headers, accepts only the exact assigned Git routes and destination, bounds uploads before minting credentials, and mints read scope for read operations even when the caller also has write rights. Transfer tokens use the documented minimum 60-second lifetime. Publication prepares archived objects and its pack before minting the write token, then revokes it after the transfer. Redirects are refused. A 20-second deadline covers request dispatch and response-body consumption, preserves caller cancellation, and reaches credential revocation after a stalled transfer.

Initial fork credentials are revoked before attempt provisioning completes. Lost-response recovery validates the repository association, requires a complete bounded token inventory, revokes a bounded batch, and reads the inventory again. Incomplete inventory, remaining active credentials, or a missing revocation acknowledgment keeps provisioning pending. Attempt cleanup archives and verifies retained source/evidence before journaled deletion; an acknowledgment alone does not establish repository absence.

## Deployment and evidence

Use a consistent account and namespace across operator inputs, the generated authority binding, and returned Git remotes. Namespace jurisdiction is immutable: choose a separate namespace with an explicit `eu` or `us` jurisdiction when residency is required. The default `confidence` namespace is unrestricted. Review [data localization](https://developers.cloudflare.com/artifacts/guides/data-localization/) before creating a namespace with a residency requirement.

Run the expanded finite REST/Git gate against fresh owned resources:

```sh
CLOUDFLARE_ACCOUNT_ID=<selected-account-id> node --import tsx scripts/provider-preflight.ts --run --use-wrangler --out preflight-output/artifacts-provider.json
```

The report freezes account, resource associations, runtime source hashes, exact Git dispatch intents, acknowledgments, ref observations, raw source round trips, pinned historical/unpublished work-base transfer, competing fixed-base updates, and credential revocation. The release configuration requires every named provider check and unchanged source inputs. Local self-tests never satisfy this gate. Retain failed and uncertain reports; do not overwrite them to force a retry. Fresh preflight namespaces remain because the documented REST API provides no namespace-delete route.

The separate owned Worker harness exercises the production adapter, Rust/WASM kernel and ObjectStore through actual Artifacts and R2 bindings. Prepare and package locally, then deploy using the returned absolute journal path:

```sh
npm run cf:artifacts-check -- --prepare --account <selected-account-id> --namespace confidence --out preflight-output/artifacts-prepared.json
npm run cf:artifacts-check -- --package --journal <journal-path> --out preflight-output/artifacts-package.json
npm run cf:artifacts-operator -- --deploy --journal <journal-path>
```

The operator verifies the exact owned account, fresh Worker/bucket names, namespace, closed configuration, every uploaded JS/WASM module and native binding metadata. It records private credential-free identity evidence in the journal directory. Confirm the returned endpoint is ready with an authenticated read-only control request before dispatching the single run. The pre-run result is `PRE_RUN_READY` with `providerGatePassed:false`; it does not claim the 14 binding checks. Controls expire 20 minutes after preparation. Use distinct output paths to preserve each observation:

```sh
npm run cf:artifacts-check -- --reconcile --journal <journal-path> --out preflight-output/artifacts-readiness.json
npm run cf:artifacts-check -- --run --journal <journal-path> --out preflight-output/artifacts-run.json
npm run cf:artifacts-check -- --cleanup --journal <journal-path> --out preflight-output/artifacts-cleanup.json
# If deletion absence is pending, observe it without redispatching deletion:
npm run cf:artifacts-check -- --reconcile --journal <journal-path> --out preflight-output/artifacts-reconciled.json
npm run cf:artifacts-operator -- --retire --journal <journal-path>
```

The binding gate requires 14 distinct passing checks, native deployment identity and both owned repositories observed absent. The release configuration requires both `publicationEvidence` and `artifactsBindingEvidence` with matching current source hashes, account and configured namespace. The native operator durably archives and verifies all owned R2 bytes, removes objects except the atomic run fence, observes Worker absence, removes that exact fence, then removes the empty bucket and observes bucket absence. An uncertain dispatch is never sent again automatically. `--reconcile` on the operator only observes native state; `--retire` can continue cleanup after absence is observed, retaining the original uncertainty record. A crash lock requires inspection before removal.

The [validation record](VALIDATION.md) links retained evidence and its declared scope. Full application release also requires configured human identity, protected evaluation and authoring lifecycle evidence, application destination, and any enabled model lane.

On 5 October the completed observation (retained private reference; unavailable in this source distribution) passed all 22 REST/Git and 14 binding checks. Execution inputs and the complete uploaded JS/WASM package are retained by digest; the nineteen actual binding source files are archived locally. These were explicit dirty-source executions, not clean-commit build attestations. The first two failed binding runs retain their original results and verified cleanup. `confidence/owned-confidence-collaboration` remains at baseline `8038967b1c954937af0a2a54d850eb7346627b26`, ready for authenticated enrollment. No authority enrollment or complete application deployment was dispatched.

Initialize the canonical four-file collaboration fixture using the [seed workflow](../infra/seed-pilot.md). The seed freezes its target and exact zero-to-baseline push, verifies raw source through native Git, revokes bootstrap credentials, and retains the canonical repository for authenticated project enrollment. Enrollment and opening admission are separate authority operations.

## Operations

Workers Logs and Traces are enabled in the production configurations. Record safe error codes, operation identities and source digests; keep bearer values and arbitrary provider diagnostics out of logs. Keep uncertain publication and credential-revocation backlog visible to the operator. Investigate an association conflict before changing a repository, ref, journal, or credential.

Use [Artifacts metrics](https://developers.cloudflare.com/artifacts/observability/metrics/) in the GraphQL Analytics API to inspect operation counts, error categories and latency by the exact namespace/repository. Watch rate limiting, storage-limit errors, long-running provisioning and cleanup, and unreconciled publication intents. Account-wide events are an additional observability source; they cannot replace authoritative source checks or publication admission. Partition future environments or workloads into separate namespaces as described in the best-practices guide.

Artifacts [pricing](https://developers.cloudflare.com/artifacts/platform/pricing/) currently requires Workers Paid and starts operation/storage billing on 14 October 2026. Its published included quantities and prices should be rechecked before increasing retained repositories or traffic. Delete only owned disposable attempt/probe resources after verified archival; retain canonical history and unresolved-publication pins.
