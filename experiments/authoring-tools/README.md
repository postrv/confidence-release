# Bounded Authoring-Tool Benchmark

This benchmark uses the production-supported JavaScript HTTP workload. Its coding task combines caching, write/read freshness (including overlapping requests), and accessible server-rendered status. It is a small designed workload, not a general coding-quality benchmark. TypeScript authoring and protected evaluation remain unregistered; this harness does not bypass that restriction.

## Offline Rehearsal

Run with pinned local Narsil/Interlinked installations already present. No installer, cloud API, credential lookup or model provider is invoked:

```sh
node --import tsx experiments/authoring-tools/benchmark.ts --mock biome-covered /absolute/new/private/run-directory
node --import tsx experiments/authoring-tools/benchmark.ts --mock original-control /absolute/new/private/control-directory
```

Each offline dataset has four matched arms: neither, Narsil only, Interlinked feedback only, both. All arms receive identical frozen source, goal, three-path write grant and the same nine existing HTTP checks. Enabled Narsil arms explicitly use `always`; the original four-file source is never enlarged to conceal an automatic skip. The separately identified covered dataset reads immutable `fixtures/authoring-benchmark/biome.json` with one diagnostic rule. A known `debugger` proposal independently proves that rule runs. This narrow coverage does not establish exhaustive analyzer coverage.

The production `pi-child.mjs`, real Pi SDK, Narsil selector and Interlinked adapter execute. Only the exact prewritten owned proposals may execute in the local oracle. The first proposal deliberately contains `debugger`; feedback arms can correct it. This is transport/diagnostic rehearsal, not a fair model-quality test or evidence that Interlinked improves coding. Reports retain calls, diagnostics, complete/partial SDK sessions, tool observations, prompt/context bytes, all nine outcomes, elapsed time and termination. Missing coverage remains unmeasured. Local processes are not hostile-code containment; never substitute arbitrary provider output into this offline runner.

## Live Invocation

`LiveBenchmark` in `live.ts` is an operator library, not a second model broker or deployment tool. It uses only the existing authenticated application/authority routes, normal grants, production Pi runner and existing model broker. The operator supplies an authenticated `fetch` and a fresh deployment-readback function. Do not save authentication headers or credentials in the plan or journal.

Before creating the live run:

1. Obtain an explicit model-spend ceiling separately from CI authorization. Verify the provider pricing/capacity and existing account spending cap. Internal reservation units are not measured or billed dollars.
2. Enroll a private owned benchmark project with the exact selected fixture bytes, reviewed goal/policy, publication closed, and sufficient existing budget. The existing seed helper's closed `fixtureProfile: 'authoring-biome-v1'` selects these covered bytes; its default remains the original four-file source. Do not reset or mutate the pilot's published head to manufacture a baseline. The harness never enrolls, raises a budget, opens publication or alters Access/RBAC.
3. Pin a single runner image, evaluator image, checker, model route, source commit/manifest, goal/policy revisions and selected arm order before viewing outcomes. `arms` allows one to four distinct names from `neither`, `narsil-only`, `interlinked-only`, `both`. A both-only run measures that configuration, not a counterfactual advantage. Verify source contents from the enrolled manifest, not just filenames.
4. Supply the exact `LivePlan`, a new private output directory and explicit `APPROVED_REAL_MODEL_BENCHMARK` opt-in. `authorizationReference` records the operator's external approval reference; it is not cryptographic proof or an independent spend authorization.
5. Before each `runNextArm()`, drain existing authoring and apply the reviewed runner mode configuration. Current modes are deployment-wide, not model-controlled per-attempt settings. The readback callback must independently verify the exact live image/model/tool modes and return the retained readback digest. A supplied callback is a trust boundary, not self-authenticating evidence.

One arm creates a normal three-path `pi-json-proposal-v1` attempt including the existing `checkpoint-context` permission, starts it, waits for the latest generation-specific verified STOPPED observation, and separately waits for matching source ingestion. A COMPLETED runtime is not an ingested submission. It then materializes the submission with the full nine-check evaluation, requests archival cleanup and waits for TOMBSTONED. A failed runtime or explicit permanent ingestion rejection is retained; an ingestion timeout holds reconciliation without cleanup or a false NO_SUBMISSION result.

Each arm reserves exactly 300,000 or 400,000 internal units through `perArmReservationUnits`: at most three or four 100,000-unit model reservations, including corrections and continuation. The live deployment must still report `modelMaximumCallCost: '100000'`. The authority sums every call reservation maximum against the grant, including settled calls; settlement does not replenish this per-attempt call allowance. A three-call grant can deny the optional fourth continuation or correction; it does not promise task completion.

Register `authorizedModelSpendMicroUsd`, an independently reviewed `reviewedMaximumCallMicroUsd` and `pricingEvidenceDigest`. Add `priorModelSpendAllowanceMicroUsd` for calls already charged conservatively against the same authorization, including failed or uncertain calls. Omission means zero for a fresh authorization only. The prior allowance plus admitted calls times selected arms times the reviewed per-call upper bound must fit the cumulative user-approved ceiling. Registration retains the new-run and cumulative bounds separately; neither is a bill. The upper bound must cover the actual broker request-byte and output-token caps, provider pricing and reasoning behavior; model context-window metadata and internal units are not dollar enforcement. Actual provider usage/cost must be reconciled separately. Authoring, ingestion, evaluation and cleanup have separately registered finite deadlines, with an HTTP-request cap derived from their sum and selected arm count.

For an explicitly authorized, separately identified retry after one uncertain call charged at a reviewed 1,505,000 microUSD upper bound, these fields admit three new calls under a cumulative US$7 ceiling:

```json
{
  "arms": ["both"],
  "modelMaximumCallCost": "100000",
  "perArmReservationUnits": "300000",
  "authorizedModelSpendMicroUsd": 7000000,
  "reviewedMaximumCallMicroUsd": 1505000,
  "priorModelSpendAllowanceMicroUsd": 1505000
}
```

These are fields within the complete pinned `LivePlan`, not a standalone plan or fresh pricing evidence. They permit at most 4,515,000 microUSD of new exposure and 6,020,000 cumulatively. Changing only the grant to 400,000 would imply 7,525,000 cumulatively and is rejected. Retain the original failed run and its evidence unchanged, pin the retry's authorization/pricing references, and account for any additional prior calls before admission. This narrower retry is not an equal-budget comparative episode.

The one-arm CLI accepts a normal Access application JWT on stdin only, with an explicit destination origin and no browser-cookie extraction or automatic login:

```sh
cloudflared access token --app https://approved-app | node --import tsx experiments/authoring-tools/live-cli.ts --approved-real-model --plan /private/plan.json --out /new/private/run --readback /private/fresh-readback.json --origin https://approved-app
```

Use the already authorized app origin, not the literal example. The fresh readback JSON contains `{schemaVersion:1, origin, arm, completedAt, deployment}`. `deployment` contains the independently observed image/checker/model/call-cost pins, `narsil`, `interlinked` and `readbackDigest`. It expires after 15 minutes. The CLI verifies the human session principal against registration before dispatch. Keep tokens and private artifacts out of shared transcripts; the CLI never logs or saves its token. Multi-arm runs require the operator library so each deployment-wide mode change is drained and independently read back.

Every command is durably journaled before dispatch with its exact revision, incarnation, principal and idempotency key. Authoring admission and execution remain one-shot: an uncertain create/start response or deadline fences subsequent arms rather than starting another paid attempt.

After a verified completed runtime and accepted source, the controller can recover **materialization and archival cleanup only**. It checks the unchanged scope, source, goal, policy, CLOSED publication gate, stopped generation, accepted submission/manifest, sponsor permission, model-call identities and budget before dispatch. An uncertain response permits one exact replay of the same frozen command. Only a durable `STALE_STATE` rejection matching that command's digest permits a fresh command identity at a newer revision, with at most two such replacements for the unchanged semantic operation. Original commands, rejection proof and recovery observations remain in the journal. Evaluation and cleanup each share their original phase deadline with recovery; the request cap includes twelve finite recovery requests per arm. No recovery step starts authoring, adds a model call, increases a grant, approves or publishes source.

Other definitive rejections, missing rejection proof, changed inputs/permissions, repeated uncertainty or exhausted bounds still hold for operator reconciliation. A timed-out observer does not prove execution stopped. Keep the unresolved attempt ID and complete termination/cleanup reconciliation before changing tool modes. This scoped controller fix does not rewrite the original comparison's failure. The [separate 12 October native confirmation](../../docs/TOOLS_RECOVERY_CONFIRMATION_2026-10-12.md) completed one both-tools coding-to-cleanup episode without manual materialization or cleanup, with one model call and nine independently verified checker signatures. No live stale rejection occurred in that episode; the 33 focused deterministic tests exercise the bounded recovery paths. This confirmation is not a second matched comparison or a general reliability claim.

## Interpretation

Live reports say `AUTHORITY_REPORTED_PASS`, not independently verified protected acceptance. Independently verify the signed evaluator records, complete nine-job plan/checker/image bindings, source and grant attribution, retained session/tool observations, model-call roster, actual provider usage and cleanup. An absent session, missing usage, Narsil skip, unsupported preview or missing checker identity makes the respective comparison inconclusive. Never turn a null usage/cost into zero, an internal reservation into billed spend, or a clean preview into a correctness result.

The live harness retains references and authoritative snapshots; it leaves provider tokens/cost null and tool quality advantage null until separate reconciliation is complete. Use `scripts/reconcile-model-usage.ts` with its existing verification procedure for cost evidence. Export each session, rendered context and source-advisory artifact through the existing scoped context API or approved artifact reconciliation, preserving its original bytes in a private directory named `<sha256 hex>.json`. Then run the offline collector:

```sh
node --import tsx experiments/authoring-tools/collect.ts /private/plan.json /private/run/both-report.json /private/exported-artifacts /private/new-tool-metrics.json
```

This collector makes no network calls, checks every artifact digest, reuses session and source-advisory validators, and binds rendered source/task bytes to registration. It distinguishes actual Narsil context inclusion and observed Interlinked preview invocation from unavailable evidence or exhaustive checker coverage. Session usage remains explicitly agent-reported, not billing evidence. Original exports and run reports are not modified. A complete/partial failure remains in the denominator and in total cost. Do not silently retry a failed arm, drop negative episodes or compare the original-control dataset against the Biome variant as though their inputs matched. An explicitly authorized retry requires separate registration with cumulative prior spend and is not a replacement for the original outcome; changed budgets cannot support an equal-budget comparison.

These runs stop at coding/check results and archival cleanup. They do not approve or publish model changes, test independent human collaboration, prove full Cloudflare physical-resource reclamation, or establish an end-to-end release advantage.
