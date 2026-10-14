# Cloudflare pilot operations

For the separate, optional Weft development integration, use the
[integration setup and reproduction guide](../docs/WEFT_INTEGRATION.md).
Its `infra/test-weft` components are local test fixtures and must not be deployed.

The checked-in Worker configurations package locally and start closed. They do not contain deployment credentials or an enabled model. `configure-pilot.ts` produces account-specific configurations from a non-secret input and separate private key files. It performs no remote calls. The authority, runner and evaluator are private Workers; the application is the only HTTP entry point. The application has only `AUTHORITY` and static assets, with no Artifacts, R2 or signing binding.

Control request, callback and retained-observation reads are bounded to 1 MiB. Source bytes are bounded to 4 MiB and individual files to 1 MiB; portable JSON exports are bounded to 8 MiB. These are configured pilot ceilings, not a claim that every ceiling has been exercised against the live provider.

Version-one publication supports at most 128 predecessor receipts (publication 129 maximum). Before approval consumption, the authority checks exact source/observation/history bytes and reserves 128 KiB for future primary envelopes plus 1 MiB for additive endorsements. Retained additive endorsements are capped at 128 and 1 MiB per project. These are enforced pilot admission limits; segmented histories require a future verifier profile.

The evaluator migrates the old KV job map atomically into indexed SQL and retains that map as an inert backup. Completed identities remain available for deduplication; the 256-job ceiling applies to pending work, with two active slots. Its internal run response acknowledges durable registration rather than execution completion. Deployment is a forward migration: an older binary would read stale KV, so do not downgrade against migrated state without an explicit maintenance/reconciliation procedure outside the database.

The selected Wrangler OAuth login authorizes Artifacts after the user-approved permission refresh. Retained REST/Git and deployed binding gates cover their recorded inputs; changes to those inputs need fresh matching evidence before publication can be enabled. The private pilot completed concurrent real-model contributions, repair, all nine protected checks, exact review, one canonical Artifacts publication and independent receipt verification. The historical accepted platform baseline is `39c8c58`; its revision-109 observation had CLOSED admission, maintenance off, drained work and zero available authoring units. Teammate workspace access was observed before the later verified-owner migration suspended legacy membership; generic imported-project membership and execution remain separate. [Current release status](../docs/RELEASE_STATUS.md) and [operations](../docs/PILOT_OPERATIONS.md) distinguish subsequent migration and recovery confirmations from that checkpoint. Historical release acceptance (retained private reference; unavailable in this source distribution) preserves earlier gates. Failed repairs and expired review remain in the historical revision-60 checkpoint (retained private reference; unavailable in this source distribution); the [publication checkpoint](../docs/PILOT_RELEASE_GATE_F508454.md) records their eventual successor.

## Prepare an account-specific configuration

Copy `pilot.example.json` outside the repository. Replace its account ID, resource names, D1 UUID, HTTPS application origin, issuer/audience/JWKS, exact verified human subjects and project ID. For the selected free pilot hostname, set `app.origin` to `[private deployment URL omitted]` and `app.workersDevSubdomain` to `laurence-avent`. The generator requires the origin to match the generated app Worker name and this subdomain exactly; it enables `workers.dev` only for the app and keeps the authority, runner, evaluator and projector private. For a custom domain, omit `workersDevSubdomain`; the generator instead sets an exact custom-domain route. `bootstrapSubjects` are `${issuer}#${verifiedJWTSub}`, not email addresses. The issuer must issue a signed `principal_class` of human/agent/service; Cloudflare Access human assertions may instead establish human class through their signed email claim. Access service tokens do not acquire human approval rights. Configure the Access application or OIDC client on the chosen application origin before opening the pilot.

The private pilot will use the existing Cloudflare Access team. Create a separate HTTP application for the chosen hostname and an explicit policy allowing the pilot operators through the existing identity provider. Retain the application audience and verify the team URL before generating configuration. Map those observed values as follows, following [Cloudflare's JWT validation guidance](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/):

| Configuration | Required observed value |
| --- | --- |
| `app.origin` | Selected pilot HTTPS origin |
| `app.issuer` | Exact team URL, `https://<team>.cloudflareaccess.com` |
| `app.audience` | New pilot application's audience tag |
| `app.jwksUrl` | Team URL followed by `/cdn-cgi/access/certs` |
| `app.bootstrapSubjects` | Exact issuer plus `#` plus the signature-verified human assertion's `sub` |

Do not copy another application's audience or infer `sub` from an email address. The live Access ingress must supply `Cf-Access-Jwt-Assertion`; the application does not parse the Access cookie directly. Observe login, denial, session expiry/revocation and project membership through the actual pilot before enabling authoring or publication. Keep the assertion and session credentials outside repository evidence. Regenerate configuration and affected native evidence after a checker source/input-list change; the checker identity covers the complete evaluator runtime graph, and the release manifest also pins both checker scripts.

### Discover the first signed Access subject while closed

Cloudflare [supports Access on an exact `workers.dev` hostname](https://developers.cloudflare.com/workers/configuration/cloudflare-access/). Create the separate Access application and a narrow Allow policy for the pilot humans **before** deploying the app Worker. Its audience must match `app.audience`; keep `preview_urls=false`. For the first closed deployment, set `app.bootstrapSubjects` to `[]`, `maintenance=true`, `enablePi=false`, and `enablePublication=false`. Configuration then exposes only `GET /api/bootstrap-identity` for subject discovery. Authority enrollment and commands remain fenced. The endpoint accepts a verified `Cf-Access-Jwt-Assertion` from a human at the exact configured app origin; it rejects bearer credentials and returns only `{ "bootstrapSubject": "<issuer>#<signed sub>" }` with `Cache-Control: no-store`. It never returns the assertion or contacts the authority.

After the initial closed deployment, sign in through Access in a browser and open `[private deployment URL omitted]/api/bootstrap-identity`. The endpoint requires the signed Access application token's `type=app`, human email, exact issuer and audience, and valid signature and lifetime. Copy the returned subject into the private input's `app.bootstrapSubjects` array. Repeat for each intended bootstrap operator, then regenerate the release with the **same** signing keys and service tokens and deploy the update without `--initial`. The generated app disables this endpoint as soon as the array is nonempty. Before opening maintenance, verify that logged-out and disallowed identities cannot reach it and that each allowed human sees only their own signed subject. Do not store a JWT, Access cookie, or screenshot containing them in the repository. A release with `maintenance=false` and an empty bootstrap array is rejected.

Create the named resources on the intended account using the installed Wrangler. These commands mutate that account and should use its configured credentials. Resource commands may report an existing name; verify the account and association instead of blindly replacing it.

```sh
npx wrangler r2 bucket create confidence-objects
npx wrangler queues create confidence-pilot-events
npx wrangler queues create confidence-events-dead-letter
npx wrangler d1 create confidence-projection
```

Retain the D1 UUID printed by the final command in `projectionDatabase.id`. Create the Artifacts namespace using `POST /accounts/<ACCOUNT_ID>/artifacts/namespaces` with `{ "namespace": "confidence" }` through the authenticated [Artifacts REST API](https://developers.cloudflare.com/artifacts/api/rest-api/), using an Artifacts-capable API token or the explicitly selected existing Wrangler login with `artifacts:write`. Namespace creation is not the conditional-publication gate. A canonical repository containing the tracked collaboration fixture must exist in this namespace before enrollment. Its main head must be an exact supported commit; arbitrary public Git imports are outside this closed pilot's deployment setup.

Alternatively, the provisioner checks the selected account and looks up each exact resource before creating an empty resource. It accepts the D1 UUID placeholder and emits the actual UUID for the operator to put into the input. It requires account-read and the selected Artifacts/R2/Queues/D1 permissions. Its default mode is a local plan with no network request, even when credentials exist. The explicit live command mutates only those empty named resources:

```sh
node --import tsx infra/provision-pilot.ts /private/pilot.json /private/provision-report.json
node --import tsx infra/provision-pilot.ts /private/pilot.json /private/provision-report.json --run
node --import tsx infra/provision-pilot.ts --self-test
```

The live command requires private `CLOUDFLARE_API_TOKEN` and matching `CLOUDFLARE_ACCOUNT_ID`. It retains each intended name durably before a create request, and an unacknowledged create remains UNKNOWN. Repeating the invocation reads the same report and reconciles by name; it never repeats that uncertain create merely because the name is still absent. It does not create repositories, upload source/data, install secrets or deploy Workers. A crash can leave its exclusive `.lock` file; inspect the retained report and resource state before an operator removes that local lock. Keep the report for retries, rather than replacing it with a fresh journal. `--self-test` exercises these rules through an owned local HTTP service and makes no Cloudflare mutation.

```sh
npm run build
node --import tsx infra/configure-pilot.ts configure /private/pilot.json /private/confidence-config
node --import tsx infra/configure-pilot.ts keys /private/confidence-secrets
npx tsc --noEmit -p infra/tsconfig.json
npx wrangler deploy --dry-run --config /private/confidence-config/authority.json
npx wrangler deploy --dry-run --config /private/confidence-config/runner.json
npx wrangler deploy --dry-run --config /private/confidence-config/evaluator.json
npx wrangler deploy --dry-run --config /private/confidence-config/projector.json
npx wrangler deploy --dry-run --config /private/confidence-config/app.json
```

The configuration report hashes the actual Worker source, locked Pi adapter, built WASM and built browser assets. `deploy-pilot.ts` verifies those hashes and all configuration files before packaging; source or asset changes require regeneration. Its default mode packages all five Workers locally and writes a report without mutation:

```sh
node --import tsx infra/deploy-pilot.ts /private/confidence-config /private/confidence-secrets --dry-run
```

The example's placeholder values deliberately fail configuration validation. Private key files are written with mode 0600 and exclusive creation; the command will not replace an enrolled keyset. `keys` is for initial bootstrap, with distinct physical root, authority and checker keys. Store and back them up through your private secret manager. `public-keys.json` is a public-key record, not a scope-specific trust configuration: after enrollment, independently retain the authority's complete protected trust export and checkpoint. Add a model credential to `runner.secrets.json` only for the external provider route. The Workers AI binding route requires no model API key. The application secret file contains only its narrow application-to-authority token.

The projector has its own `projector.secrets.json`, containing only `PROJECTOR_SERVICE_TOKEN`. The authority holds the matching token for its narrow retained-projection history endpoint. This fourth service token must differ from the application, runner and evaluator tokens. For an existing enrollment, preserve all signing keys, genesis and existing service credentials; add one new private random token of at least 32 characters to the authority and projector secret files. Regenerate configurations and deploy both affected Workers. Do not rerun initial key generation to perform this update.

The optional non-secret `signerKeyIds` object selects `{ "root", "authority", "checker" }` IDs when regenerating configuration after an authorized rotation. Omission preserves the initial v1 IDs. All three IDs must be distinct bounded identifiers. A rotation changes only the intended private signer and its configured ID; preserve the existing service tokens, unaffected signing keys and enrollment genesis. The deploy wrapper verifies checker private/public correspondence and distinct physical keys before remote mutation. It rejects an alias even when its textual IDs differ.

The compatibility date is 2026-10-01, which the installed local workerd runtime accepts. The named Container policy is the current `durable_object` policy; the runtime chooses instance `lite`, while durable admission enforces finite capacity. Its [image configuration](https://developers.cloudflare.com/containers/configuration/scheduling-policy/) requires managed registry references of the form `registry.cloudflare.com/<ACCOUNT_ID>/<IMAGE>@sha256:<DIGEST>` when using an existing image.

## Initial closed deployment

Choose a fresh deployment prefix and verify that these Worker names have not been used. For this initial deployment only, establish the three circular service target names with the generated deny Workers. On updates, deploy the real implementations directly.

```sh
npx wrangler deploy --config /private/confidence-config/authority-bootstrap.json
npx wrangler deploy --config /private/confidence-config/runner-bootstrap.json
npx wrangler deploy --config /private/confidence-config/evaluator-bootstrap.json
npx wrangler d1 migrations apply DB --remote --config /private/confidence-config/projector.json
npx wrangler deploy --config /private/confidence-config/authority.json --secrets-file /private/confidence-secrets/authority.secrets.json
npx wrangler deploy --config /private/confidence-config/runner.json --secrets-file /private/confidence-secrets/runner.secrets.json
npx wrangler deploy --config /private/confidence-config/evaluator.json --secrets-file /private/confidence-secrets/evaluator.secrets.json
npx wrangler deploy --config /private/confidence-config/projector.json --secrets-file /private/confidence-secrets/projector.secrets.json
npx wrangler deploy --config /private/confidence-config/app.json --secrets-file /private/confidence-secrets/app.secrets.json
```

The staged wrapper runs the same sequence after completing all five dry-run packages. For a fresh initial deployment, `--initial` verifies that the three private service Worker names return HTTP 404 before deploying their deny targets. This check requires `CLOUDFLARE_ACCOUNT_ID` matching the input and an appropriate private `CLOUDFLARE_API_TOKEN`. An existing name or ambiguous account response blocks initial deployment. These commands perform remote mutations:

```sh
node --import tsx infra/deploy-pilot.ts /private/confidence-config /private/confidence-secrets --deploy --initial
node --import tsx infra/deploy-pilot.ts /private/confidence-config /private/confidence-secrets --deploy --initial --use-wrangler
node --import tsx infra/deploy-pilot.ts /private/confidence-config /private/confidence-secrets --deploy
```

Use either initial command only for fresh names and the update command for subsequent updates. `--use-wrangler` privately reuses the selected existing OAuth login for the initial name checks and every Wrangler stage, ignores alternate token environment variables and disables interactive login and disk logs. Its Artifacts scope/account gate must pass; it does not request broader consent. Without that flag, the initial name check uses the explicit account token described above. The wrapper verifies secret file permissions, exact per-Worker key lists, matching service-token associations, distinct service tokens and checker signing/public-key correspondence before any deployment. It records stage acknowledgments and output digests without printing or retaining secret values. A failed or timed-out remote stage remains UNKNOWN; the wrapper stops and does not automatically repeat it. The operator must inspect the actual resources and deployment versions before retrying.

### Interrupted update fence

Use the **same private secret directory** for every release of these five Worker names. Before the first remote stage, the wrapper atomically syncs its report and a `.deployment-state.json` pointer in that directory; an exclusive `.deployment.lock` prevents overlapping invocations. Each `STARTED` stage is synced before Wrangler runs. A later invocation, even from a different generated config directory, refuses an incomplete remote stage with `PRIOR_DEPLOYMENT_UNRESOLVED` and records the blocking report and stage. A claimed overall success without the exact acknowledged stage sequence also remains blocked.

On the **first** use of the pointer, a live invocation refuses `DEPLOYMENT_HISTORY_INVENTORY_REQUIRED` until an operator supplies a reviewed inventory. Keep the secret directory and every generated release directory as immediate children of one private root, such as `.pilot/secrets` and `.pilot/config` or `.pilot/config-<release>`. Generate the inventory locally, without a provider call or secret-file read:

```sh
node --import tsx infra/inspect-deployment-history.ts .pilot/config-next .pilot/secrets .pilot/history-inventory.json
```

The inventory lists each `deployment-<digits>.json` report in that root and its immediate release directories with a digest, status and blocker. The scan is limited to 1,024 root entries, 128 release directories, 1,024 entries per directory, 256 journals and 1 MiB per journal; an exceeded limit, symlinked root entry, invalid journal or a different directory layout fails closed. The command creates the inventory with mode 0600 and refuses to replace one already there. Review it alongside the retained reports, Worker versions and data obligations. Do not edit or remove a historical journal.

A historical UNKNOWN remains blocked even when a later deployment is fully acknowledged. To record an operator's separate reconciliation, add exactly one entry to `reconciliations` for that UNKNOWN with `unknownReport`, `unknownDigest`, `supersedingReport`, `supersedingDigest`, `readbackReport`, `readbackDigest`, `reviewedBy`, `reviewedAt`, `effectReview: "RECONCILED"`, `dataObligations: "REVIEWED"` and `evidenceDigest` of the retained operator review. Paths are relative to the private root. The superseding report must have the exact fully acknowledged stage sequence and a later start and completion time. The named readback must be `READBACK_PASS` for its exact release digest, account and five Worker names, with the verifier's full required check set passing and completion before the operator review. The wrapper checks these fields and file digests; the operator remains responsible for the original uncertain effect, D1/data obligations, secret associations, uploaded assets and in-flight work. A later ACK or readback alone never clears UNKNOWN.

The earliest initial-runner UNKNOWN journal predates `targetWorkerNames`. Its legacy reconciliation is accepted only when the three provider-observed bootstrap names match the current target's authority, runner and evaluator names and the remote stages are exactly the acknowledged bootstrap/migration/authority prefix followed by runner UNKNOWN or STARTED. A later legacy ACK without `targetWorkerNames` is bound to all five current names by a passing readback of its exact release digest. Other legacy shapes stay blocked for separate review; no missing target field is treated as a wildcard.

Pass that reviewed file on the first live invocation with `--history-inventory=.pilot/history-inventory.json`. The wrapper rescans before secret validation, packaging or provider calls, rejects a stale inventory, and retains its digest and reconciled report names in the new deployment journal. Once the pointer exists, the pointer and current-directory journal checks apply on later invocations. Keep the reviewed inventory with the release evidence; do not recreate it to bypass an unresolved history.

For an update, first close admission and publication in the deployed authority, verify that active grants/jobs are stopped or durably held, retain the before versions, and check that any D1 migration is compatible with the still-running code. Generate a maintenance-closed release (`maintenance=true`, `enablePi=false`, `enablePublication=false`) and keep that gate closed through a partial update. The current wrapper does not itself perform this closure or attest that work is drained. In particular, an existing Pi-open package must not be treated as a safe direct update solely because its five local packages pass.

On a timeout, signal loss, crash, or failed remote stage, stop. Read the named `deployment-*.json` report and `.deployment-state.json`; keep the exact original source/config bundle, secret directory and Worker names. Do not run another deployment or repeat the uncertain stage. Query active Worker versions and use the [read-only provider verifier](verify-deployed-pilot.md) against the original release for module, binding, exposure and image identity. A matching Worker readback can establish that Worker’s observed current bytes; it cannot by itself prove a D1 migration outcome, uploaded static-asset bytes, secret values, connected data restoration, or absence of in-flight work. If the exact stage effect cannot be reconciled, leave maintenance and admission closed and retain the journal. This wrapper intentionally provides **no automatic UNKNOWN override or stage retry**.

After an operator has separately reconciled the exact uncertain stage and recorded the before/after versions and data obligations, preserve the original report and pointer as evidence. For the supported noninitial shape, the [bounded continuation command](../docs/DEPLOYMENT_CONTINUATION.md) can reconcile the separately observed effect and dispatch only the never-dispatched suffix, once. It preserves the original UNKNOWN report and pointer, and stays fenced until a fresh full readback finalizes a separate reconciliation record. Other shapes and an uncertain continuation remain blocked for separate review. Do not edit, delete or replace the pointer to force a retry. A stale `.deployment.lock` may be removed only after confirming its recorded PID is no longer running; removing the lock never clears `.deployment-state.json` or an unresolved remote stage. The owned local drill in `infra/deployment-recovery.test.ts` kills a process after a synced `deploy-authority: STARTED` and proves that the next release directory is fenced even after the stale lock is removed. It does not exercise a Cloudflare rollback or prove pending publication, job identity, trust, or resource-data preservation; those R16 acceptance observations still require a separate owned live drill.

Keep `maintenance=true`, `enablePi=false` and `enablePublication=false` during this setup. Wrangler builds and uploads the locked authoring/evaluator images when their image fields are `UNCONFIGURED`; the runtime refuses their execution until the observed managed image digest and checker source digest are configured. Retain the actual upload output, managed image references and deployment versions. Resolve the pushed image digest from the registry-qualified `RepoDigests` in `docker image inspect`; `wrangler containers images list --json` currently lists tags without digests. Record the observed `registry.cloudflare.com/<account>/<image>@sha256:...` reference in `images.authoring` or `images.evaluator`. Rebuilding a Dockerfile and guessing its registry digest is insufficient.

## Enroll and open the configured pilot

Run `npm run checker:digest` and put its `implementationDigest` in the input. Configuration generation verifies that digest against the present checker source and lockfile bytes. The deployed private pilot uses the [Workers AI binding](https://developers.cloudflare.com/workers-ai/configuration/bindings/) with [GLM-5.3](https://developers.cloudflare.com/workers-ai/models/glm-5.3/), as recorded in the revision-60 checkpoint:

```json
"model": { "kind": "workers-ai", "name": "@cf/zai-org/glm-5.3", "reasoningEffort": "low", "maximumCallCost": "100000" }
```

The GLM-5.3 route is explicitly allowed only with `"reasoningEffort": "low"`; Cloudflare says its reasoning cannot be disabled, and `none` maps to `max`. The separately allowed [DeepSeek V4 Flash](https://developers.cloudflare.com/workers-ai/models/deepseek-v4-flash-0731/) route requires `"reasoningEffort": "none"`. Both routes allow at most 8,192 completion tokens so a complete replacement-file JSON response can fit; the Pi adapter still parses and validates the proposal locally. `maximumCallCost` is an integer micro-unit reservation ceiling, at most `100000`, separate from measured provider billing. The runner requires the exact model/effort pair and its `AI` binding. Its private secret file must contain only `RUNNER_SERVICE_TOKEN`; a leftover `MODEL_API_KEY` fails closed. The broker caps requests and responses, records the requested provider and model, and retains the returned response identity and token usage when supplied. A local test or a REST probe does not establish the deployed binding's behavior; retain an actual bound model run before opening Pi.

When converting an **existing** runner from an external provider to Workers AI, first close admission and Pi. Wrangler preserves secrets omitted from a later `--secrets-file` deployment, so remove the old `MODEL_API_KEY` explicitly with `wrangler secret delete MODEL_API_KEY --config <generated-runner-config>`, then read back the deployed secret names before reopening. Keep the runner fenced if deletion or readback is uncertain. A fresh initial runner has no legacy model secret.

The existing external provider route remains available with `kind: "openai-compatible"`, `name`, an HTTPS `baseUrl` ending in `/v1`, `maximumCallCost`, and `outputTokenField` (`max_tokens` or `max_completion_tokens`). It requires `MODEL_API_KEY` privately in the runner's secret file when Pi is enabled. Both routes broker text-only chat completions without agent-discovered extensions or provider tools.

After reviewing the live container lifecycle/egress and identity checks, set `maintenance=false` in the non-secret input. When the model route, authoring image and any required external credential are ready, also set `enablePi=true`, regenerate and redeploy the authority, runner and application. The application derives `PI_ENABLED` from that flag; redeploying only the runner would leave `/api/demo` fenced. The runner stays fenced while `enablePi=false`, including requests made through the generic command API. Keep publication disabled while running evaluations. Enroll through the authenticated application with a JSON request to `/v1/projects/<PROJECT_ID>/enroll`:

```json
{ "canonicalRepo": "owned-collaboration-demo", "canonicalRef": "refs/heads/main", "expectedHead": "EXACT_40_HEX_COMMIT", "maximumBudget": "2000000" }
```

Human mutations require `Origin` equal to the configured application origin, `X-Platform-CSRF: 1` and `Content-Type: application/json`. Commands additionally require a fresh `Idempotency-Key` and the exact `If-Platform-Revision` from `/api/state`. After enrollment, the deployed browser freezes each resolved operation, body, key, revision, verified principal and incarnation, then sends the exact `/v1/projects/<PROJECT_ID>/<OPERATION>` command with `If-Platform-Principal` and `If-Platform-Incarnation`. An uncertain result retains that same request across reload and retry; it blocks a new intent until recovery. High-level `/api` mutation routes remain compatibility adapters. `/api/trust-config`, `/api/checkpoint` and `/api/receipts/<PUBLICATION_ID>/export` are protected portable exports.

Run the separate owned-repository provider preflight and deployed Artifacts binding check. To enable publication, point `publicationEvidence` and `artifactsBindingEvidence` to their actual matching live PASS JSON reports and set `enablePublication=true`. The generator checks the account, namespace, all required observations, current source digests and native binding/module proof. It refuses a local self-test, blocked report, changed source or another account's observation. These finite Artifacts observations do not certify the complete application, production process termination or OIDC. Review [current release boundaries](../docs/RELEASE_STATUS.md) and the retained historical production conditions (retained private reference; unavailable in this source distribution) before enabling the lane. Regenerate and redeploy the authority/application, then issue `set-admission-gate` with `{ "gate": "OPEN" }` through the scoped command API and its exact revision. This records the durable gate change; changing an environment variable does not silently reopen an already enrolled project.

Publication persists preparation before remote dispatch. After any ambiguous response, use `/api/reconcile`; an observed old head remains unresolved and keeps the publication slot. An unexpected head or strong-content mismatch enters recovery hold. Do not reset SQLite, replace the keyset or force a competing ref update to clear that uncertainty. Maintenance mode is an external fence for deliberate restore. Authority restore/re-enrollment requires the design's manual provenance and unresolved-operation reconciliation; automated historical database recovery is not implemented.

## Projection catch-up and rebuild

The projector repairs a missing prefix by requesting retained originals through its dedicated authority binding. Each delivery can apply at most 32 predecessor events within a 128 KiB history page. It validates the entire page's scope, identities, digests and order before writing to D1. Longer gaps or unavailable history remain retry/dead-letter work.

A human project administrator can queue a complete frozen prefix with `POST /v1/projects/<PROJECT_ID>/replay-projection`. Use the human command headers described above and the exact enrolled scope:

```json
{
  "scope": { "schemaVersion": 1, "tenantId": "pilot", "projectId": "owned-project", "projectIncarnation": "ENROLLED_INCARNATION" },
  "afterSequence": 0,
  "throughSequence": null,
  "replayId": null
}
```

The first result freezes `throughSequence`. Continue with fresh command IDs and current revisions, using that result's exact `replayId`, `throughSequence` and `nextSequence` as `afterSequence`. After a lost response, retry the original command ID and unchanged body/revision. Pages use separate durable replay tasks and preserve each original event ID and digest. They do not reset original delivery records or change canonical history. `complete` means the frozen prefix has been queued; verify D1's contiguous rows, inbox and watermark separately before declaring the rebuild applied.

For a replacement projection, preserve the old database, apply the existing migration to a fresh empty D1 database, and update the projector's binding through the configured deployment process before replaying the frozen prefix. A projection rebuild never restores or replaces authority SQLite, trust or publication state. Projection payloads over 64 KiB carry an explicit digest reference to the complete retained authority event.

This bounded projection profile applies to newly produced events. A pre-profile retained outbox event over 64 KiB fails explicitly; this update does not silently replace its original ID or digest. No live enrolled stream exists in the retained deployment evidence, and historical oversized-stream migration has not been demonstrated.

## Local evidence

```sh
node --import tsx --test workers/authority/artifacts.test.ts workers/runner/model-policy.test.ts
node --import tsx infra/authority-runtime-check.ts
```

The first command tests the raw Git/materializer adapter and model request policy. The second runs actual local workerd SQLite and R2 with a deliberately fake repository transport and synthetic signed checker observations; it restarts the runtime and independently verifies its portable export. Its report explicitly states those limits. Neither command exercises Cloudflare Artifacts CAS or live model/container containment. The test-only Worker in `infra/test-authority` exposes trusted-state seeding and is excluded from all generated pilot configurations.

The [canonical fixture bootstrap](seed-pilot.md) provides the separate explicit
`infra/seed-pilot.ts` command for creating the fresh owned collaboration repository
before enrollment. It defaults to a local plan, reuses the privately selected
Wrangler OAuth gate when requested, and retains uncertain create/push dispatches
for observation. Its owned HTTP/native Git tests are
`node --import tsx --test infra/seed-pilot.test.ts`; those tests perform no
Cloudflare mutations.

The [authority key and context operations](authority-operations.md) document
root-authorized rotation/revocation, additive historical endorsements, exact
retained-context continuation inputs and grant-scoped agent proposals. Preserve
enrolled genesis and unaffected service credentials during a signer rollover.
