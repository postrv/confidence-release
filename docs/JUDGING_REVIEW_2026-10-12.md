# Confidence: competition judging review

Review date: 12 October 2026. This is an internal assessment of the implemented prototype and retained evidence, not a prediction of judges' scores. The matched live coding episodes, protected evaluation and cleanup are complete. Verified-response cost estimates are available; usage-inventory coverage is incomplete and account billing remains unknown.

## Release close-out

The later recovery/onboarding release addresses the original review's immediate
completion and presentation gaps. A fresh tools-enabled coding workflow completed
through `TOMBSTONED` cleanup with one model call and no manual materialization,
cleanup or model retries; nine checker signatures and actual tool inputs were
independently verified. All four rollout readbacks passed 44/44, and normal
configuration restoration completed by 18:12:32 UTC. No stale fault happened in
that fresh run; 33 deterministic tests cover bounded recovery and fail-closed
invariants separately. The original matched comparison is unchanged.

Onboarding now includes verified self-identity sharing, usable project entry and
import commands, and guarded member controls, backed by 114 web tests, 17 ordinary
onboarding browser checks and 19 synthetic collaboration browser checks. The
eight-minute video is rendered, decoded and played in a browser, with measured
audio/frame/privacy checks; it labels actual local automation and retained native
evidence explicitly. See the [completed judge packet](judge-packet/README.md) and
[current deployed source/status](RELEASE_STATUS.md).

The comparison and its earlier baseline remain preserved below. The rubric and
submission priorities distinguish closed gaps from unperformed acceptance; the
original product-gap wording and original priorities remain explicitly dated.
The remaining largest product gaps are supported-workload generality, measured
scale and independent human acceptance. External source/link access and the
entrant's manual submission remain separate from local package completion.
The [separate native confirmation](TOOLS_RECOVERY_CONFIRMATION_2026-10-12.md)
records 110.339 seconds coding and 205.530 seconds through cleanup, excluding
deployment, and an estimated US$0.006530920 for its one verified response. This is a bounded
workflow-completion demonstration, not an added control arm or general advantage.

## Recommendation

Position Confidence as **agent collaboration that produces an explainable, independently verifiable release decision**. The memorable demonstration is a behavior failure after a clean source composition, followed by repair that preserves the useful work and a human decision bound to exact source and evidence.

The largest remaining opportunity is presentation and reproducibility. The prototype has a distinctive working core, but a judge should be able to understand its value, inspect the evidence and run the supported experience without reconstructing several days of release history.

Suggested one-sentence introduction:

> Confidence helps teams turn parallel agent work into a release they can explain, review and verify independently.

## Official criteria and submission

Cloudflare weights originality and prototype quality at **50%**, multi-agent concurrency, coordination, context preservation, review and conflict handling at **25%**, and ease of use/product experience at **25%**. Each category is scored 1-5; originality breaks ties. The deadline is **14 October 2026 at 23:59 PDT**, or **15 October at 07:59 BST**. Entries require Workers and Artifacts, a 5-10 minute demonstration, source repository, run instructions and an accepted open-source license. Entry is manual; finalists present in San Francisco on October 21. [Official rules, sections 2, 4, 6 and 7](https://www.cloudflare.com/documents/build-next-gen-git-platform-competition-terms.pdf)

The submission form requests team/contact/attendee details, project vision, Cloudflare usage and an open-source repository URL. Its video upload accepts MP4, WebM or MOV, up to 2 GiB. [Official submission form](https://www.cloudflare.com/git-competition/submit/)

The owner reported an organizer-approved location exception on 5 October, recorded in the existing release plan (retained private reference; unavailable in this source distribution). Supporting correspondence remains private. This review carries that context forward; it does not reopen eligibility or change the general rules.

## Original review evidence baseline

| Item | Status for this review | What it establishes |
| --- | --- | --- |
| Merged platform source | `0c26ad01c5c188ba4bc601628e147f7e4de30625` | Current main includes the stream, CPU resource and benchmark reconciliation changes. |
| Reviewed CPU release | Commit `53e3b27`; tree `af67b130e886250860e8cbab6da7dde0d085e26c` | The reviewed implementation uses one vCPU, 3,072 MiB memory and 2,000 MB disk for authoring. The merged source preserves that reviewed tree. |
| Private live configuration | Verified ownership/RBAC deployed; normal GLM-5.3 configuration restored with Narsil `always`, Interlinked `feedback` and maintenance off | Restoration was acknowledged with 44/44 independent readback by 14:23 UTC on 12 October. Publication remains disabled; current deployment evidence is separate from the older publication journey. |
| CPU fix validation | Both retained proposals completed Interlinked preview in the separate Cloudflare replay, approximately 1.81 s and 1.24 s | Native validation of those previews on the resource fix, using the existing proposals and zero additional model calls. It is not a new coding comparison. |
| Earlier real coding retry | Nine protected cases passed; two new model responses retained | A successful tools-enabled coding episode. The original run's Interlinked timeouts and asynchronous materialization observer failure remain in its evidence. |
| Earlier publication journey | Real cohort, behavioral failure, repair, exact review, one Artifacts publication and independent receipt verification retained | The complete finite workflow exists. Its stage-specific platform versions remain those recorded in the [publication checkpoint](PILOT_RELEASE_GATE_F508454.md). |
| Current paired comparison | DeepSeek coding with both tools enabled versus neither, four-call cap per arm; three calls actually admitted; cumulative conservative ceiling US$5.934 within US$10 | Enabled: one call and 120.612 s coding span. Disabled: two calls and 258.371 s. Both candidates passed all nine protected checks. The enabled controller's original `STALE_STATE` failure remains retained beside separate zero-model evaluation/cleanup reconciliation. See the [live comparison report](../experiments/authoring-tools/LIVE_COMPARISON_2026-10-12.md). |
| Independent human collaboration | Newly deployed controls tested through production code paths; separate live-person rehearsal waived by the user | Do not present synthetic personas or owner-operated email aliases as independent human acceptance. |

The exact deployment/readback, usage and replay records are retained in private operator evidence. Prepare sanitized summaries for judges. A documentation update must not relabel older evidence as if current Workers produced every earlier stage.

The paired coding spans exclude deployment, protected evaluation, reconciliation and cleanup; they include runtime startup, model work, local diagnostics and polling. The full observed workflow took **631.147 seconds disabled** and **1,106.485 seconds enabled**, from each controller's start through its final cleanup report, including deployment and the enabled arm's operator pause/reconciliation. The shorter enabled coding phase did not produce a shorter complete observed workflow. Verified-response token-price estimates are **US$0.018308216 disabled** and **US$0.007055464 enabled**, or **US$0.025363680 combined**. All three registered responses were verified, but the broader usage inventory remains incomplete and these are not attributed account charges. The registered eight-call maximum was US$8.299 including the full prior-call allowance; the three admitted calls reduce that conservative ceiling to US$5.934. One designed task and one sequential episode per arm support the observed result, not a general speed, quality or cost advantage.

## Assessment against the rubric

| Area | Strongest implemented evidence | Main weakness | Best way to improve the judges' view |
| --- | --- | --- | --- |
| Originality and prototype quality | Behavior-aware composition, goal-preserving repair, immutable source/evidence identities, one-use approval and portable verification form one coherent workflow. | The successful example is a small designed workload; independent judge comprehension and broader workload generality remain unestablished. | Lead with the wrong value after the acknowledged write, then show the preserved cache benefit, repair and verifiable decision. |
| Multi-agent collaboration | Isolated attempts, controlled interaction witness, failed-source repair base, selected counterexample, attributed intent and retained contribution lineage. | The live workload and assignment recipes are narrow; large-scale behavior and independent multi-human acceptance remain unmeasured. | Show actual overlap timestamps, the exact context handed to repair, and source-versus-intent-versus-observation as distinct facts. |
| Product experience | Release-at-a-glance view, concrete mismatch display, complete source inspection before approval, invitation/member controls, polished onboarding and separate automatic-completion confirmation. | The original failure remains retained. The tested controller and completed recording close those narrow preparation gaps; external judge access, final uploaded-copy playback, reviewer comprehension/effort and broader recovery reliability remain unmeasured or unconfirmed. | Lead one supported run path and the current evidence index; finalize presentation/source access without claiming all usability or reliability gates are closed. |

<details>
<summary>Original product-experience assessment, before the 12 October close-out</summary>

The original originality/presentation weakness was: "The distinctive result is
buried in release mechanics. The successful example is a small designed workload."
The current reading path promotes the result; generality and independent
comprehension are still unestablished.

The original product-experience weakness was: "The benchmark's stale-revision materialization failure
needed operator reconciliation. Onboarding, the finished video and measured
reviewer effort remain gaps." Its proposed action was to rehearse recovery,
provide one current run path/evidence index and clarify the eight-minute story.
The close-out above records what was subsequently completed; reviewer effort and
the broader claims remain unmeasured. The original benchmark outcome is unchanged.

</details>

### Where Confidence is strongest

**Repair preserves useful work.** A fix must satisfy freshness, useful caching and accessible saved status together. Disabling the cache can remove the visible stale-value symptom while discarding an original goal. The observed published repair preserved the useful behavior and passed all nine protected cases. [Retained live result](PILOT_RELEASE_GATE_F508454.md#exact-publication-and-independent-verification), [repair assignment implementation](../workers/authority/index.ts)

**The platform explains a particular interaction.** Baseline, individual contributions and their combination are checked under the same named freshness contract. The interface shows the wrong value, trace and bounded witness instead of treating file separation as behavioral independence. [Workspace implementation](../apps/web/src/Workspace.tsx), [comparison method](COMPARISON.md)

**Review and publication have an inspectable identity.** Approval binds exact candidate/base source, plan, evidence, policy and expected head. Publication uses the recorded old/new heads; an uncertain effect retains its operation identity. [Review implementation](../apps/web/src/Review.tsx), [Artifacts publication contract](ARTIFACTS_INTEGRATION.md#source-and-publication-contract)

**The decision travels outside the service.** Browser/WASM and native Rust verification check source and retained authorization/publication evidence under independently selected trust. The verifier exposes separate integrity, authorization, publication observation, continuity and source results. [Rust verifier](../crates/protocol/src/lib.rs), [native CLI](../crates/verifier-cli/src/main.rs)

**Human permissions complement agent capabilities.** Verified identities, explicit roles, bounded attempt grants, session revocation and a transactional last-human-owner invariant support project collaboration. Use this as concrete product evidence, with the limits documented in [collaboration permissions](COLLABORATION_PERMISSIONS.md), rather than an absolute security guarantee.

### Where Confidence is weakest

**Generality.** The native cohort/repair workflow names the MJS fixture and fixed grants. Generic imported repositories can be retained and inspected, but import does not establish supported authoring, evaluation or publication. TypeScript protected execution remains unregistered. This is the largest product-capability gap, but closing it before the deadline would require authority, runner, evaluator, image and release changes together. TypeScript integration gaps (retained private reference; unavailable in this source distribution), import readiness (retained private reference; unavailable in this source distribution)

**Measured scale.** The evaluator currently has two active slots and a bounded queue. Actual concurrent attempts are useful evidence; they do not establish hundreds or thousands of working agents, sustained throughput or fair multi-project operation. [Scheduler implementation](../workers/evaluator/index.ts)

**Original operational completion friction, now addressed narrowly.** The matched enabled benchmark accepted generated source, then materialization hit a stale authority revision and required separately reviewed zero-model recovery. Its full interval remains 1,106.485 seconds enabled versus 631.147 seconds disabled, including deployment and the operator pause. The later bounded controller and separate native confirmation close that demonstrated completion gap without weakening revision checks or changing these measurements. Recovery faults are tested, not claimed to have occurred in the clean confirmation; broader sustained recovery reliability remains unmeasured. [Original workflow and recovery](../experiments/authoring-tools/LIVE_COMPARISON_2026-10-12.md), [current release](RELEASE_STATUS.md)

**Comparative benefit.** The fixed-source conventional comparison detects the same bug with equally effective CI. Confidence adds connected context, provenance and decision verification, but that study does not measure faster authoring or better human decisions. The new tools-enabled episode completed coding in one call and 120.612 seconds, compared with two calls and 258.371 seconds when disabled; both candidates passed the same nine protected cases. This is useful measured evidence for the selected task. Sequential order, provider variation, response caching and warm infrastructure remain confounders, and changing both tools together cannot identify their individual effects. The retained controller failure also prevents presenting this as a frictionless end-to-end release comparison. [Live coding comparison](../experiments/authoring-tools/LIVE_COMPARISON_2026-10-12.md), [conventional comparison limits](COMPARISON.md#records-compared)

**Submission clarity.** The initial review found README describing both tools as
off by default and release/runbook pages carrying earlier identities and pending
gates. Current entry points now lead the complete native story, creator credit,
scoped benchmark calculations and preserved evidence; development history is
archived with byte identities. An eight-minute recording exists. The remaining
work is final presentation/source association, reviewed public export, external
judge access, uploaded-copy checks and manual submission. The original recording
and any voiceover successor retain separate delivery records; neither is new
runtime evidence. [README](../README.md), [evidence guide](EVIDENCE.md),
[current handoff](TEAM_HANDOFF.md), [video delivery](judge-packet/DEMO_DELIVERY.md)

## Five highest-impact priorities before the deadline

1. **Lead the connected release story.** Show the concrete wrong value after an acknowledged write, goal-preserving repair, exact review and independent verification. Keep actual local automation, retained native observations and synthetic example trust visibly distinct.
2. **Finalize the presentation artifact.** Associate the observed voiceover successor with the preserved original footage and its actual digest/duration/audio/playback checks. The entrant must still watch the final file and validate the uploaded copy; automated checks are not that acceptance.
3. **Freeze and reproduce the chosen source.** Select the actual submission revision/export, review privacy/licenses/tool credits, run the supported fresh-checkout journey and preserve exact results. Existing runtime and example evidence keep their own source identities.
4. **Verify judge access and intelligibility.** Check source/report/video links from the intended external context and confirm the explanation makes failure, preserved goals, repair base and approved source understandable. Reviewer comprehension/time remains unmeasured unless actually recorded; this does not reopen the waived distinct-human rehearsal.
5. **Submit with accurate boundaries.** Keep the original matched failure and separate confirmation distinct, and token estimates separate from billing. The entrant reviews team/form details, terms and final files, submits manually and retains the real confirmation. [Current handoff](TEAM_HANDOFF.md), [submission checklist](judge-packet/SUBMISSION_CHECKLIST.md)

<details>
<summary>Original pre-close-out priorities, preserved from the 12 October review</summary>

These priorities described the earlier preparation state. They are retained to
show the original deltas, not to assert the completed recording or onboarding is
still missing. The original instruction to provide a "sanitized receipt" is
fulfilled instead by the explicitly synthetic, unmodified signed public example;
redacting signed production bytes would not preserve their verification identity.

1. **Present the completed comparison honestly.** The [live comparison report](../experiments/authoring-tools/LIVE_COMPARISON_2026-10-12.md) and [sanitized evidence JSON](../experiments/authoring-tools/live-comparison-2026-10-12.json) now retain matched inputs, outcomes, calls, verified-response estimates, coding/workflow timing, tool observations and cleanup. Keep the faster enabled coding phase beside its longer full observed workflow and original controller failure. Remaining deliverable: verify report access and use that balanced table in the judge recording, without a general speed or quality claim.
2. **Use the refreshed release and evidence entry points.** README, RELEASE_STATUS and the recording runbook now separate the published collaboration journey, the connection/CPU fixes, the new comparison and normal configuration restoration. Remaining deliverable: verify the final links and tested source revision, then guide judges through one reliable entry point rather than historical operator records. The original failed observations remain retained.
3. **Record the qualifying demonstration.** Complete a 5-10 minute video using the actual retained live journey and current UI. Show the counterexample early, skip waiting with labelled time cuts, verify final duration and playback, and preserve the uncut recording. Deliverable: the final video and a capture ledger with stage-specific identities.
4. **Make the tested source reproducible and accessible.** Rehearse a fresh checkout of the final submitted revision, verify run instructions and Apache-2.0/third-party notices, review source/history/public example artifacts for private material, and verify the intended judge-access path. Provide a sanitized receipt with separately selectable public trust/checkpoint. Deliverable: a source URL, exact tested revision and working local verification command.
5. **Rehearse the judge's decision and recovery path.** Time one walkthrough from goal to interaction, repair, source review and independent verification, including the existing procedure for an unresolved or stale command. Check whether the reviewer can name the failure, preserved value, repair base, approved source and current recovery state without an operator explanation of internal mechanisms. Resolve the observed navigation/copy issues and verify the presentation at the recording viewport. Deliverable: a short comprehension/time record and a smooth final walkthrough using existing features. This does not reopen the waived independent live-person rehearsal.

</details>

Complete packaging and recording on 12-13 October, then use 14 October for link, playback, fresh-checkout and manual submission checks with a buffer before 07:59 BST on 15 October. This is an execution priority, not a reason to add a new platform feature during the final freeze.

## Eight-minute judge narrative

| Time | Show | Say or demonstrate |
| --- | --- | --- |
| 0:00-0:30 | Goal and actual stale read | Parallel changes must preserve fresh writes, useful caching and accessible status together. Point to the concrete wrong value. |
| 0:30-1:30 | Three attempts and observed overlap | Each has an isolated workspace, source base, assignment and bounded grant. Distinguish assigned work, agent intent and observed output. |
| 1:30-2:30 | Individual freshness passes and combined failure | The source combines cleanly; the controlled behavioral witness identifies this interaction. These are named probe results. |
| 2:30-4:00 | Failed-source repair context, retained lineage and nine checks | Repair receives the actual failed source and counterexample. Show that cache benefit and accessible status survive alongside freshness. |
| 4:00-5:15 | Complete source and exact human decision | Review the changed files and named evidence. Explain what the one-use proposal binds and show the recorded publication operation. |
| 5:15-6:15 | Canonical source observation and portable verification | Verify the matching receipt under separately selected trust, then reject a disposable tampered copy. |
| 6:15-7:15 | Paired coding comparison | Show the actual completed report: outcomes, time, calls, usage-based cost and tool observations. State the limited sample size. |
| 7:15-8:00 | Current product and supported boundary | Briefly show project/member management and the Cloudflare runtime. Name the narrow supported workload and the next generalization step. |

Use retained publication evidence for the already completed journey. A new screen recording must not imply it is redispatching that publication or that all stages came from the current Worker version. Keep credentials and private session material outside the capture.

## Claim boundaries and differentiation

- A clean merge and individual freshness passes do not establish the complete useful goal. Show the named integrated checks.
- Protected observations cover finite declared traces. They do not establish general correctness, exhaustive analysis or an absolute security property.
- The original interaction is a designed demonstration with real model execution and observed behavior; it is not an independently sampled natural conflict population.
- Ordinary CI with the same effective checks finds the same failure. Confidence's demonstrated addition is the connected explanation, controlled repair context and verifiable release decision.
- Narsil context and Interlinked preview are advisory. Their presence, successful execution or clean result does not grant review/publication authority or prove better coding.
- The new paired study measures tools-enabled versus tools-disabled coding on its pinned task and model. It is not a Confidence-versus-GitHub study or proof of a general model-quality advantage.
- Usage-based token prices are estimates, not attributed account invoices. Unknown usage remains unknown; internal reservation units are not dollars.
- Synthetic identities and owner-operated test addresses do not establish distinct independent participants. The user waived the separate live-person rehearsal.
- Offline verification checks retained observations under selected trust. It does not certify that the remote head is still current or that the operator's trust assumptions are universally valid.

The differentiating story should stay coherent: **parallel work, a visible behavioral interaction, repair preserving the useful goals, exact human consent, and a decision that can be verified independently**. Narsil/Interlinked measurements strengthen that story when the result supports them. BLAKE3 migration, classifier experiments, a new CI abstraction or wider language support would consume the remaining release window without improving the clarity of this demonstrated core.
