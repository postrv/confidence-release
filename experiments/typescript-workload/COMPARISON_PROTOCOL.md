# TypeScript seat-inventory comparison protocol

**Status: protocol and local accounting tool, 7 October 2026. No TypeScript product comparison has run.** The six-file fixture and nine-check local oracle demonstrate a designed interaction. They cannot authorize a Confidence release: production cohort assignments, Pi feedback, protected evaluator recipe and image still select the MJS profile. See product readiness (retained private reference; unavailable in this source distribution) and the [workload profile](../../docs/TYPESCRIPT_WORKLOAD_PROFILE.md). A green local fixture, a structurally valid study packet, or a receipt-shaped JSON field is not a measured real-model advantage.

## Run gate

Do not start a model study until the same deployed release proves all of these with authoritative records:

1. An enrolled, versioned TypeScript workload selects exactly `cache.ts`, `reservations.ts`, and `presentation.ts` for A, B, and C; a repair gets `reservations.ts` from the exact failed combined source. The model cannot change the profile, paths, checker, or task contract.
2. Pi accepts bounded complete `.ts` replacement proposals and returns coherent TypeScript authoring diagnostics. Narsil and Interlinked are per-attempt recorded options. Preview uses the same pinned compiler as acceptance; advisory failures remain visible and never pass acceptance.
3. The protected evaluator compiles the six verified files in a disposable candidate container and runs all nine checks. The inventory store, assertions, counters, inputs and verdict live outside the candidate. The evaluator image, compiler, checker, fixture and source are fingerprinted and covered by the deployed binding gate. The local `acceptance-child.mjs` is useful development evidence only.
4. A release policy can require these signed TypeScript results. A human can inspect exact source and full failed/passing evidence, approve one passing proposal, publish to live Artifacts with a fixed-head condition, and independently verify the receipt and remote canonical bytes.
5. A deployed, non-model gate test shows an incomplete baseline, individually scoped contributions, the intended A+B stale-read witness when those exact controlled edits are used, a failed combination ineligible for release, and a repaired candidate passing all nine checks. This proves the product path; it does **not** predict what a real model will write.

Keep the current four-file MJS pilot separate. Its publication or receipt does not satisfy this TypeScript gate.

## Freeze before the first provider call

Run `node experiments/typescript-workload/comparison-study.mjs fingerprint` to get the exact six-file manifest, the two-file authoring-configuration digest (`package.json` and `tsconfig.json`), and the **local** oracle-source digest. Copy [the plan template](comparison-plan.template.json) to a private study directory and replace every `REPLACE_ME` and zero budget. `register` rejects placeholders, a source, authoring configuration or local-oracle mismatch against the chosen Git commit, changed path grants, and unsafe budget values. Put no credentials in the plan.

```sh
node experiments/typescript-workload/comparison-study.mjs fingerprint
node experiments/typescript-workload/comparison-study.mjs register /private/study/plan.json > /private/study/registration.json
node experiments/typescript-workload/comparison-study.mjs validate /private/study/registration.json /private/study/episodes.json
node --test experiments/typescript-workload/comparison-study.test.mjs
```

The registration freezes: baseline commit, six source bytes, `tsconfig.json` and fixture `package.json`; exact A/B/C/repair goal text and path grants; one credential-free HTTPS provider endpoint, model name, immutable revision and generation-settings digest (temperature, top-p, seed and route settings); SHA-256 digests of the public prompt, platform/system policy and four assignment packets retained in the operator's study package; one compiler package digest and version; the protected evaluator image and checker digests; Narsil and Interlinked binary and invocation-configuration digests, including the compiler package Interlinked actually resolves; provider price source and observation time; reviewer identity and answer rubric; the shared ceilings; and a seeded arm order. Do not change any of these after seeing outcomes. If a provider cannot pin a model revision or return trustworthy token usage, mark the study inconclusive for equal-model/equal-token claims.

The registered arm order contains five complete episodes for each repetition:

| Arm | Workflow | Optional authoring advice |
| --- | --- | --- |
| `ordinary-branches-ci` | Three isolated model-authored Git branches, integrated CI, repair branch, human review, fixed-head Git publication and independent verification | None |
| `confidence-core` | Three isolated Confidence attempts, composition, protected checks, repair, human review, Artifacts publication and receipt verification | None |
| `confidence-narsil` | Same Confidence path | Narsil context only |
| `confidence-interlinked` | Same Confidence path | Interlinked preview only |
| `confidence-both` | Same Confidence path | Both |

Use the ordinary and core arms for the primary workflow comparison. Compare each integration arm with core separately. Shuffle arm order by the frozen seed for every repetition; never run only the promising arms. Repeating this one workload measures behavior on this workload, not a general speedup. Reviewer learning, lane visibility and model drift remain possible confounders; retain run order and prior exposure, report them, and avoid a causal claim if they dominate. A one-repetition competition demonstration is descriptive.

## Identical work and budget

All arms start from the same commit and six-file manifest. The model receives the same public goals, complete assigned files, source access, model/provider revision, maximum three concurrent authors, and the same fixed nine-check acceptance semantics. A and B must be assessed alone before the combined source; a real model might not create the designed conflict. Give the conventional agents the same bounded opportunity to inspect integrated CI logs and repair the combined branch. Neither workflow receives another arm's model output or a prewritten repair. The reviewer sees the exact candidate, logs, and evidence in each lane under the same time ceiling.

The suggested shared ceilings are **per complete cohort plus at most one repair**, including retries and advisory feedback: 24 provider calls; 120,000 input tokens; 48,000 output tokens; **8,192 output tokens per call** for GLM-5.3. The first live repair used its 4,096-token limit on reasoning without returning source, so repeating that cap would bias this study toward a known failure mode. These are preregistration choices, not measurements. The per-call cap is configurable up to 32,768 in the tool; choose a provider-supported value before registration and then use the same registered value in every arm. The plan also fixes one maximum estimated model cost in micro-USD, episode wall time, reviewer active time and protected evaluator concurrency. Choose these before the first run and use the same values in every arm. Count selected Narsil text, Interlinked feedback, failed calls, retries and repair prompts in the provider totals. Reserve capacity before each call using the possible output and known prompt, stop when another call could exceed a ceiling, and reconcile with actual provider usage. Never interpret a model budget reservation as billed spend. A provider response with missing/unverifiable usage is recorded as `MISSING`, with null token/cost fields and an `INCONCLUSIVE` outcome; an over-budget episode remains in the data as a protocol violation.

The price snapshot is an estimate from observed input, cached input and output tokens, rounded up for each call. Preserve provider usage objects, billing exports where available, infrastructure spend and price provenance separately. Actual billed cost is unmeasured without those records. Advisory indexing/preview time, context/diagnostic bytes, CPU and memory (when available) belong in the episode; include their time in end-to-end wall time. Both lanes get the same protected evaluator service limits, fixtures, seeds and all nine checks. Compiler or checker drift invalidates a matched pair.

Start the episode clock when A/B/C tasks become runnable. End it only after independently verified canonical publication or a terminal failure/timeout. Include queueing, model work, source preparation, compilation, evaluations, repair, human review, publication and verification. Record a terminal `FAILED`, `CENSORED` or `INCONCLUSIVE` episode even if no candidate passed. Never drop it from the denominator or its costs. A successful compiler exit or nine green checks without approval, publication and independent verification is an incomplete goal.

## Evidence packet and human effort

The input to `validate` is a JSON array with one packet per registered repetition and arm. The exported `validateEpisode` implementation defines the required fields. Each packet binds the same registration, source commit/manifest, authoring configuration, prompt-set digest, model/settings, compiler and evaluator; records A/B/C and optional repair grants, exact work bases and submissions, every provider call, per-attempt advisory configuration/status/overhead, timestamped complete nine-check vectors, review intervals and decisions, and the terminal outcome. A repair must start after a failed combined evaluation and name its exact source digest as its work base. A reported release needs a passing combined or repaired source, then approval, publication and verification in order. The validator rechecks source/configuration/oracle bytes in the pinned Git commit and compares recorded episode timestamps with the preregistered arm order. It cannot authenticate when the operator first issued the registration or which prompt was actually sent. `validate` prints every slot, missing slots, totals and budget violations. Exit 2 means episodes are missing; exit 0 only means the record set is structurally complete. Both outputs explicitly set `claimEligible: false` and `protocolCompliant: null` pending independent evidence.

Capture human effort with start/end times for each active review or coordination interval; exclude unattended waiting. Record the reviewer decision bound to a candidate digest, number of decisions, requests to repeat work, and comprehension errors. Before showing either workflow, freeze the same four reviewer prompts and answer key:

1. Which source contribution belongs to A, B and C?
2. What exact input/output trace shows the combined failure, or what earlier failure prevented it?
3. Which cache, reservation and accessible-status obligations does the proposed repair retain?
4. What evidence is still missing before approving publication?

Ask them in both lanes and retain answer sheets privately with timestamps and digests. Freeze the questionnaire and answer-key digest in the registration. Count each incorrect or unanswered item as a comprehension error under the frozen key. Include that time and any repeated reviewer work in active effort. A model-produced summary can help, but must not supply the answer key. A scripted or assumed approval is not human effort.

For each candidate evaluation, retain the protected signed job result and exact source manifest, not merely a checked `PASS` flag. For a reported release, retain the approval record, publication ID, fixed-head transition, portable receipt, verifier output, canonical Artifacts ref and independently read source bytes. For ordinary branches, retain branch commits, CI logs, approval on the exact commit, fixed-head push and independent remote readback. The structural validator deliberately cannot authenticate these external records; an operator must verify them against the authority, CI, provider, Git/Artifacts and independent receipt verifier before calculating a real comparison.

The useful outcome is **one** independently verified release that passes all nine checks and retains the original cache, reservation and accessible-status obligations. Report completion count, all terminal outcomes, elapsed time, provider calls/tokens, estimated and billed cost when available, protected evaluator demand, repair rounds, reviewer active time and comprehension errors by arm. Show individual episodes and uncertainty. Do not replace an incomplete release with a checker pass, or attribute a core workflow advantage to Narsil or Interlinked without the separate ablations.
