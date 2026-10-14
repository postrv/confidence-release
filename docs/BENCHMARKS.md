# Benchmarks: results, boundaries and reproduction

Confidence's strongest evidence is a connected, real Cloudflare journey from
parallel agent contributions through a freshness failure, goal-preserving repair,
exact human consent and independently verified publication. The performance
experiments answer narrower questions. Their honest result is promising coding
latency in one task, useful component optimizations, and an operational failure
that remained visible and was subsequently addressed.

[Evidence map](EVIDENCE.md) connects each result to retained data.
[Throughput calculations](THROUGHPUT.md) explains the units and denominators.

## Native coding: tools disabled versus both enabled

One designed JavaScript task combined a 60-second read cache, fresh reads after
acknowledged writes (including an older in-flight read), retained cache benefit
and accessible saved-value status. Only three granted files could change.
Both modes used the same base, nine protected checks, DeepSeek V4 Flash model,
one-vCPU/3-GiB resource shape and four-call maximum. The predeclared order was
disabled, then enabled; there was one episode per arm.

| Observation | Tools disabled | Narsil + Interlinked |
| --- | ---: | ---: |
| Coding dispatch through final ingestion | 258.371 s | 120.612 s |
| Admitted model calls | 2 | 1 |
| Protected checks | 9/9 authority-reported PASS | 9/9 authority-reported PASS after separate reconciliation |
| Complete recorded arm, including deployment and cleanup | 631.147 s | 1,106.485 s |
| Verified-response token-price estimate | US$0.018308216 | US$0.007055464 |
| Initial controller | Completed | INCOMPLETE: stale materialization revision |
| Final workspace cleanup | TOMBSTONED | TOMBSTONED after zero-model reconciliation |

The enabled coding span was 137.759 s shorter, a 53.32% reduction in this
single pair. The disabled model's first response reached its 8,192-token cap;
a bounded finishing call followed. It was not a failed-code repair round.
Narsil's 3,529-byte advisory was verified inside the actual first prompt.
Interlinked ran one source-coherent preview in 2.327 s (1.057 s CLI portion)
and reported no blocking findings; this run did not demonstrate defect repair.

The enabled full recorded arm was 475.338 s longer (75.31%), including an
operator pause and separate stale-revision reconciliation. Both numbers belong
in the result. Coding excludes deployment, protected evaluation, reconciliation
and cleanup; it includes runtime startup, tool/model handling and polling.
The full-arm interval includes its initial deployment, but excludes later normal
restoration and evidence collection. Neither candidate was published.

Changing both tools together does not identify either tool's individual effect.
Sequential order, response variation, caching and infrastructure warmth are
confounders. One designed task supplies no statistical or general coding claim.
[Original report](../experiments/authoring-tools/LIVE_COMPARISON_2026-10-12.md)
and [unchanged JSON](../experiments/authoring-tools/live-comparison-2026-10-12.json)

## Automatic completion after the recovery fix

A separately registered native both-tools episode used the same task/model/image
profile with a new controller and isolated project. It completed without manual
materialization, cleanup or replacement model runs:

| Boundary or observation | Result |
| --- | ---: |
| Coding dispatch through ingestion | 110.339 s |
| Coding dispatch through verified cleanup, deployment excluded | 205.530 s |
| Arm including its deployments, evaluation and cleanup | 495.837 s |
| Whole coordinator through normal restoration and final drain | 787.374 s |
| Model calls | 1 |
| Protected observations | 9/9 PASS; all nine checker signatures independently verified |
| Interlinked preview | 2.121 s outer / 1.156 s CLI, no blocking findings |
| Verified-response token-price estimate | US$0.006530920 |

Its four workflow commands each dispatched and acknowledged once: **no live stale
rejection occurred**. Thirty-three deterministic tests establish the bounded
replay/stale-rejection recovery paths separately. Deployment and ordinary operator
authentication are not claimed autonomous. This confirms clean automatic
coding-to-cleanup, not arbitrary fault recovery, general reliability or a second
matched comparison. [Verified companion](TOOLS_RECOVERY_CONFIRMATION_2026-10-12.md)

## Local component experiments

| Experiment | Cohort | Observation | What it establishes |
| --- | --- | --- | --- |
| Protected evaluator slots | Five alternating-order passing pairs plus two negative pairs; 14 plans / 112 jobs | Passing median 2,227.337 to 1,261.306 ms; 43.37% lower elapsed | Overlap improves this local fixed eight-job evaluation service time |
| Git source batching | One pair per 4/100/1,000 files, 1 KiB/file | At 1,000 files: 6,006 to 8 Git processes; 74,456.8 to 332.9 ms create+prepare | Same commit/bytes with far fewer local subprocesses; timing is one sample |
| Packed-Git Artifacts adapter | One offline sample per size, memfs and in-memory R2 | At 1,000 files: 445.4 to 172.5 ms; 5,030 to 3,020 local FS reads | Equal snapshots in the offline adapter; modeled per-file `readBlob` RPCs fall 1,000 to 0 |
| Authoring hydration | Five alternating pairs per size; mocked Files/R2 | At 1,000 files: 7,000 to 3,938 boundary calls; median 46.1 to 51.3 ms | Fewer mocked boundaries and stronger leaf checks, but 11.28% slower local median |
| TypeScript advisory preflight | Two counterbalanced repetitions of four modes; eight samples; fixed invalid proposal | All four Narsil-enabled samples returned verified excerpts; all four Interlinked-enabled samples found TS2322 | Context/preview integration works on those fixed bytes, with zero models |

Local evaluation includes planning, hydration, execution, signing, serialized
state writes and cleanup. It excludes authoring, review, publication and cloud
execution. Every paired checker input and complete observed result matched;
fresh identities and signatures naturally differ. Temporary raw execution
bundles were removed after durable-recording checks; the retained report is a
digest-bearing summary, not a portable bundle.

Source batching preserves identical commit IDs. Its totals are independently
rounded to 0.1 ms, so displayed phase sums can differ by 0.1 ms. The very large
single-sample ratio is not a stable performance distribution or product speedup.
The Artifacts adapter's RPC counts are code-path models, not provider telemetry.
A separate small disposable live binding validation passed exact source/mode,
conditional-publication and retirement checks; it did not measure large-repository
native latency.

Hydration's optimized path additionally checks leaf type/size/mode. Its five
`p95Ms` values are nearest-rank maxima, not robust tail estimates. TypeScript
preflight registers proposed future call/token ceilings but observes zero model
calls: it is not an equal-token coding comparison or a production TypeScript
execution profile.

Original data:
Evaluation (retained private reference; unavailable in this source distribution),
source batching (retained private reference; unavailable in this source distribution),
Artifacts adapter (retained private reference; unavailable in this source distribution),
hydration (retained private reference; unavailable in this source distribution),
TypeScript preflight (retained private reference; unavailable in this source distribution).

## Cost calculation, not an invoice

At the retained 12 October rates, ordinary input, cached input and output are
US$0.44, US$0.014 and US$1.32 per million tokens. Input totals already include
the cached subset:

```text
estimate_usd =
  ((input_tokens - cached_input_tokens) * 0.44
   + cached_input_tokens * 0.014
   + output_tokens * 1.32) / 1,000,000

disabled = ((2338 - 1024)*0.44 + 1024*0.014 + 13421*1.32)/1e6
         = 0.018308216
enabled  = ((2255 - 256)*0.44 + 256*0.014 + 4676*1.32)/1e6
         = 0.007055464
fresh_confirmation = (2255*0.44 + 4196*1.32)/1e6
                   = 0.006530920
```

The original pair's three verified responses total US$0.025363680. Its exact
known-call roster is reconciled, but three large global inventory objects were
not inspected; full-project/account usage and billing remain unknown. The new
confirmation also reconciles its exact one-call roster, not that global inventory.
Do not interpret `callCoverage: INCOMPLETE` as a missing known new response,
or an exact-call estimate as an exhaustive account bill.

The cumulative conservative registered-call ceiling after confirmation is
**US$6.407 within the authorized US$10**. It includes earlier uncertain/historical
allowances; it is not the US$0.031894600 sum of these four priced responses and
is not actual billed spend. CI has its own authorization and accounting.
[Dated pricing retained in original report](../experiments/authoring-tools/LIVE_COMPARISON_2026-10-12.md#spend-and-limits)

## Reproduce only the intended local scope

These commands make no model calls or Cloudflare API calls. The benchmark
scripts require the normal built project/tool dependencies. Results describe
the newly run environment; never overwrite or relabel the dated evidence.
The current evaluator recipe has nine jobs, whereas the 6 October local
measurement used eight. Running today's script records today's plan; it does
not reconstruct that historical eight-job cohort or validate its timings.

```sh
node --import tsx scripts/benchmark-evaluation.ts
node --import tsx scripts/benchmark-source.ts --compare
node --import tsx scripts/benchmark-authoring-hydration.ts
```

The tool transport rehearsal and fixed-proposal TypeScript preflight have
separate installation/input requirements:
[Authoring benchmark instructions](../experiments/authoring-tools/README.md)
and archived TypeScript preflight (retained private reference; unavailable in this source distribution).
They are not offline substitutes for a real coding-performance comparison.

No new benchmark run, cloud action or paid call was performed to prepare this
handover summary. The dated reports retain their original source/tool/runtime
identities; current source does not retrospectively validate them.

The [BLAKE3 feasibility study](blake3-feasibility.md) is separate deferred
research. Its local hash microbenchmarks are not measurements of this product's
coding or release throughput. Git and the signed protocol retain their specified
SHA identities; no hash migration is implied by the submission evidence.
