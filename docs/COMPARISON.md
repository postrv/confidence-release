# Fixed-source conventional workflow comparison

Run `node --import tsx scripts/compare-workflows.ts` from the repository root.
It writes a bounded `demo-output/comparison.json`, a native Git source bundle,
a portable Confidence receipt, and a separately selected trust file. Set
`CONFIDENCE_COMPARISON_OUTPUT` to choose another report directory.

This local comparison uses a deterministic scripted cohort and one designed
fixture. Real child processes author A, B, C and a repair. Their exact frozen
Git commit objects are used in both lanes. No model call occurs, approval is
performed by the comparison script, and human attention is not measured.

The conventional lane stores those sources in ordinary isolated Git branches,
runs complete protected CI, retains the failed and repaired job logs, approves
the exact passing source, and publishes with native Git's fixed-head lease.
The Confidence lane runs the same protected checks while retaining attributed
attempts, immutable composition, an interaction witness, repair context,
an exact review proposal, consumed approval, and a signed portable receipt.

Both lanes receive the same frozen integration and repair source. The ordinary
driver is not asked to rediscover a repair already known to the Confidence
fixture. This controls source and checker differences but does not measure an
independent end-to-end authoring or repair advantage.

## Equal checks and useful-goal criteria

The current command runs nine protected HTTP jobs on each of six frozen sources:
baseline, A, B, C, A+B+C integration, and retained-value repair. That is 54
jobs per lane and 108 fresh paired jobs. The driver alternates the first lane
for successive sources. Every job has a new candidate process and an external
backing store. All nine jobs run; evidence reuse and fail-fast are disabled.

The nine checks cover warm read/write/read, repeated reads, successive
writes, cold then warm writes, retained cache benefit, accessible saved status,
two audit traces withheld from repair context, and overlapping read/write
freshness. Both lanes use the exact
same checker implementation, runtime binary, fixtures, seeds, inputs and
15-second job ceiling. The report records those identities and verifies exact
raw commit bytes and source manifests in the conventional repository.

The retained 6 October report (retained private reference; unavailable in this source distribution)
used the earlier eight-job recipe: 48 jobs per lane and 96 paired jobs. Its
original outcome and bytes remain unchanged. Running the current nine-job
command records a new cohort; it does not retrospectively re-run that historical
comparison or add an overlap observation to it.

The comparison requires equality of complete observed job vectors: outcome,
response digests, expected and returned values, HTTP statuses, store-read
counts and confirmed process termination. Fresh-run IDs, ports, process IDs,
timestamps and observation hashes may differ. These runtime details are not
used as measures of workflow quality.

| Frozen source | Full useful-goal result in both lanes | Interpretation |
| --- | --- | --- |
| Baseline | FAIL | Baseline lacks enabled cache benefit and C's accessible status. |
| A | FAIL | Freshness alone passes, but C's required status is absent. |
| B | FAIL | The disabled-cache baseline still behaves freshly, but the useful goal is incomplete. |
| C | FAIL | Accessible status works; enabled cache benefit is absent. |
| A+B+C | FAIL | Warm cached reads expose the old value after an acknowledged write. |
| Retained-value repair | PASS | Write invalidation restores freshness while enabled caching and C's status pass. |

The baseline/A/B/A+B diagnostic witness uses the common freshness trace,
where its recorded outcomes are PASS/PASS/PASS/FAIL. Those diagnostic passes
are not full useful-goal acceptance. Ordinary CI with the same effective warm
cache checks also detects the integration failure.

The repair restores invalidation. A's cache and C's accessible status are
retained in source and behavior. B remains attributed in contribution lineage,
although the repair reverses B's net source edit to satisfy the complete goal.

## Records compared

The conventional report preserves branch refs, exact commits, every protected
CI job observation, failed and repaired log handoff, a scripted approval tied
to the passing source, and confirmed native Git publication. It can reproduce
the same stale read and verify the same repaired useful behavior.

Confidence additionally connects the assigned and declared intent to observed
submissions, contributors to composition, failed source to repair work base,
selected counterexample to a bounded repair capsule, and passing evidence to
an exact approved proposal. The publication records consume that approval
once and bind the old head, new head, admission witness and receipt identity.
The exported receipt is replayed by the shared Rust verifier against the
separately selected trust configuration.

These are capabilities of the implemented Confidence records and the plain
branch/CI driver chosen here. Conventional CI and code-review systems can also
add provenance, signatures, review bindings and repair context. This comparison
does not establish that these capabilities are unique, improve human decisions,
or make Confidence faster or cheaper.

## Limits and next release gate

The report contains one designed case, fixed authoring recipes, synthetic
approval, local sibling processes, and a local Git remote. Protected means the
HTTP checker and its signing authority run outside the candidate process;
shared OS identity and unrestricted host network remain local limitations.
The audit traces are designed cases, not held-out research samples. The results
establish their observed requirements, rather than general correctness.

The source-preparation cohort also performs its normal freshness diagnostics,
integration checking, reduction and repair checking. Those jobs are recorded
separately from the current paired 54-job budget in each lane. They must not be counted
as evidence of a latency or cost win.

A fair live study must give ordinary branches and Confidence the same real
model, exact assignments, useful-goal obligations, authoring and evaluation
budgets, and effective external checks. It must measure sponsor attention,
comprehension errors, repeated work, total cost and useful release completion,
and retain negative or inconclusive outcomes. Component ablations are needed
before attributing an improvement to witnesses, capsules or other records.
The retained [native publication journey](PILOT_RELEASE_GATE_F508454.md) and
Cloudflare containment observations are separate evidence; this local comparison
does not establish them. The fair real-model/conventional-workflow study above
remains unperformed. [Current evidence boundaries](EVIDENCE.md)
