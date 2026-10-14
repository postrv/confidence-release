# TypeScript seat-inventory workload profile

This is the first explicit TypeScript workload for a future equal-budget study. It is an executable **local experiment**, not a registered Cloudflare acceptance recipe or a Confidence publication claim. The existing live pilot still uses its four-file MJS contract.

## Work and useful goal

The six-file [baseline](../experiments/typescript-workload/fixture) exposes a typed asynchronous seat-inventory API. Its store has 12 seats, atomic reservations, request-key replay, and a revisioned availability snapshot. The API returns JSON and a server-rendered HTML status. The baseline is correct on reservations but does not cache unchanged reads or expose the status accessibly.

| Attempt | Assignment and grant | Expected useful contribution |
| --- | --- | --- |
| A | `cache.ts`: enable a bounded availability cache | Two unchanged reads use one backing-store read both before and after an acknowledged reservation. |
| B | `reservations.ts`: simplify write-side invalidation on the cache-disabled baseline | Preserve correct atomic reservation and idempotency behavior. |
| C | `presentation.ts`: add an accessible live status | The latest remaining-seat count is server rendered in a labelled live region. |
| Repair | `reservations.ts` from the exact failed combined source | Restore freshness while retaining A's cache benefit and C's accessible status. |

The intended interaction is observable: A and B can each preserve freshness on the common baseline, while their combination can return stale availability after an acknowledged reservation. This is a registered task design, not a prediction about what a real model will write. A model run may fail earlier, produce a different interaction, or find a different valid repair; retain those outcomes.

The useful goal requires all nine fixed checks to pass: typed availability API, unchanged-read benefit before a reservation, post-reservation freshness, unchanged-read benefit after that reservation, idempotent replay, conflicting-key rejection, bounded input and capacity, accessible latest status, and health. The checker uses an owned atomic store; it observes read/write counts independently of candidate counters. A successful compiler exit alone is insufficient. The checker reports every case plus source, compiler-package, Node executable and checker digests.

## Authoring and acceptance boundaries

The model's authoring contract would be the existing bounded Pi JSON replacement-file proposal, with complete files and the exact path grant above. Complete assigned files are supplied. Narsil may select extra source context from the six-file manifest. Interlinked may preview the complete `.ts` proposal before writes. Both remain advisory; unavailable analysis cannot become a clean result or skip acceptance.

The [local checker](../experiments/typescript-workload/check.ts) copies the six regular source files in the [versioned source profile](../packages/protocol/src/typescript-workload-profile.ts) into a disposable directory, generates a fixed strict NodeNext compiler configuration, runs a specific compiler executable, and then runs the [fixed behavioral harness](../experiments/typescript-workload/acceptance-child.mjs) in a separate child process. The exact path set, regular-file modes, per-file 1 MiB limit, aggregate 4 MiB limit, compiler output and runtime are bounded. `package.json` and `tsconfig.json` may be present for local authoring previews, but are ignored by acceptance and forbidden in the six-file source manifest. The report records the profile, manifest, compiler package, Node executable and checker digests, and explicitly marks itself ineligible for protected acceptance. A bounded static HTML parser checks a labelled status or polite live region under `<main>` with the latest visible count; it permits attribute reordering and equivalent static element names without executing page scripts. This is a finite semantic check, not a browser accessibility audit. The candidate cannot change the compiler configuration through this six-file input. The child shares the host OS identity with the experiment; **it is not hostile-code containment or production protected evidence**.

The MJS authority rejects TypeScript source after validating the exact Git
manifest but before persisting its blobs to R2 or enrolling the native project.
Additional guards reject TypeScript before model grants, plan creation and
protected execution; the evaluator also rejects it. These rejection guards are
included in the recorded deployed platform `680a5ef` / protected merge
`4fd4a6c`; this is source/deployment association, not a newly performed native
TypeScript rejection probe. Generic source imports use their separate
inspection-only profile and do not enroll execution. [Current release boundary](RELEASE_STATUS.md)

**TypeScript authoring and protected acceptance remain unregistered.** Enabling
this profile requires an explicit project-level versioned selection bound into
enrollment/policy and every evaluation input digest; a separate pinned evaluator
image with the exact compiler and standard libraries; immutable candidate
hydration; a protected nine-check harness and store isolated from candidate code;
signed evidence and a profile-aware review policy. The current evaluator's
**nine MJS jobs** and `/workspace/server.mjs` entrypoint cannot be reused as
TypeScript acceptance. The older eight-job MJS recipe remains historical, not
the current contract. Native containment and failure/recovery checks must pass
before a TypeScript project may publish.

Run the executable checks:

```sh
node --import tsx --test tests/integration/typescript-workload.test.ts
node --import tsx experiments/typescript-workload/check.ts
```

The first command verifies baseline, A, B, C, A+B+C, retained-value repair, post-write cache retention, equivalent live-region markup and a compiler rejection using controlled local edits. The second prints the baseline's expected incomplete useful-goal result; exit status 1 means its acceptance checks failed as designed.

For a matched Interlinked experiment, put the fixture in an isolated attempt directory outside this repository and use one pinned TypeScript compiler in **both** preview and acceptance. The current checkout has TypeScript 7.0.2, whereas the installed Interlinked runtime contains TypeScript 5.9.3. Interlinked's sidecar reports `ts.findConfigFile is not a function` when it resolves the checkout's TypeScript 7; that is `UNAVAILABLE`, never a clean preview. The focused test copies the fixture to a temporary directory and verifies a real TS2322 finding with the pinned CLI without changing source:

```sh
CONFIDENCE_INTERLINKED_TEST_CLI="$PWD/.local-tools/interlinked/dist/index.js" \
CONFIDENCE_TS_PROFILE_COMPILER="$PWD/.local-tools/interlinked/node_modules/typescript/bin/tsc" \
node --import tsx --test tests/integration/typescript-workload.test.ts
```

The compiler override is optional for the local fixture test, but mandatory for a comparison that attributes effects to Interlinked rather than compiler-version drift. The checker records a content digest of the complete TypeScript package and, for native TypeScript 7, its platform package including the compiler executable and standard libraries. It also records the Node version, platform, architecture and executable digest. Bind the Interlinked CLI package and its resolved compiler separately; matching the acceptance compiler's digest does not by itself prove the preview used it. The fixture's `tsconfig.json` exists for authoring previews; acceptance generates its own fixed configuration.

The corresponding Narsil smoke uses the installed 1.7.2 binary and independently verifies every selected excerpt against the six immutable source files:

```sh
CONFIDENCE_NARSIL_TEST_BINARY="$PWD/.local-tools/narsil/narsil-mcp" \
node --import tsx --test tests/integration/typescript-workload.test.ts
```

## Equal-budget study registration

Freeze the baseline commit, source manifest, six-file grants, goal wording, public prompt, model/provider revision, authoring time, evaluation jobs, accepted compiler, Narsil/Interlinked versions and options before any live run. The proposed ceiling **per complete cohort plus one repair**, identical in every lane and arm, is 24 provider calls, 120,000 input tokens and 48,000 output tokens. Register the per-call output ceiling for the chosen model before running any arm; **8,192** is the current GLM-5.3 pilot route because the observed 4,096-token repair exhausted its reasoning allocation before producing source. These are preregistration ceilings, not observed usage; revise them only before the first model run, then keep the registered values fixed. Stop an arm when any ceiling is reached. Count Narsil-selected context, Interlinked diagnostics and all repair prompts against the same provider-token and call ceilings. If the provider does not return trustworthy usage needed to enforce a token ceiling, report that ceiling as unenforced and do not claim an equal-token comparison. Use the same three assignments and repair budget for ordinary branches plus CI and for Confidence. Give each lane the same complete acceptance checks, fixture resets, source access and concurrent capacity. Randomize lane and integration-arm order across repetitions; never select only successful runs. A human reviewer should see the exact failing source and logs in both lanes, and make the publication decision under the same time limit.

Run four Confidence arms: neither optional integration, Narsil context only, Interlinked preview only, and both. Compare ordinary branches plus CI as a separate workflow lane. Record all attempts, provider token usage and configured prices, elapsed wall time, prompt bytes, compiler/preview time, evaluations, repair rounds, reviewer active time, comprehension errors, retained useful goals, and final verified release status. Report advisory overhead separately: Narsil indexing/query time and source-context bytes; Interlinked preview time and diagnostic bytes; analyzer CPU/RAM where available. Include that overhead in end-to-end elapsed time, and include advisory text sent to the model in provider input tokens. Provider maximum-cost reservations are not actual spend. Report missing price or usage as unmeasured, and retain failures, timeouts and inconclusive runs.

The existing [fixed-source comparison](COMPARISON.md) is a checker-equivalence result on the MJS fixture. This TypeScript profile supplies a second workload and an executable local oracle; a real-model, human-review, live-Artifacts comparison remains to be performed before claiming a throughput or effort advantage.
